/**
 * The application: the project and every action on it, wired to the sound engine (live
 * worklet), the transport, MIDI, history, persistence and export. Views call actions and
 * subscribe to topics; nothing else changes the project.
 *
 *   RHYTHM       generatePattern, variation, mutate, regenerate, reset, editing, patterns, chain
 *   SOUND        track sources, synthesis parameters, kits (generate, mutate, evolve), samples
 *   DESTRUCTION  chop, rolls, destroy, wildcard (live layers over the pattern)
 *   PERFORM      quantised versions of the above, fills, mutes, snapshots
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import { encodeWav16, createZip, fileName, slug } from '@slopfactory/core/export';
import { IndexedDbSampleStore, readBundle, writeBundle } from '@slopfactory/core/storage';
import { AudioHost, lxrWasm } from '../audio/host';
import { SampleLibrary } from '../audio/library';
import { renderHit, renderProject } from '../audio/render';
import type { MetersMessage, TimedHit } from '../audio/protocol';
import { ENGINE_RATE } from '../audio/engine';
import { defaultProject, defaultSound } from '../model/defaults';
import { kitOf, readKitFile, writeKitFile, KIT_EXT } from '../model/kitFile';
import { BUNDLE_EXT, parseProject, projectSamples, PROJECT_EXT, serialize } from '../model/project';
import { buildPreset, PRESETS, resolveBundled } from '../model/presets';
import { describeStepSound, isEmptyStepSound, lockableParam, repairVariation, resolveStepSound, soundSampleIds } from '../sound/stepSound';
import { addEvolution, clearEvolution, distributeSounds, generateVariations, handMade, mutateSounds, slotWritable } from '../sound/soundgen';
import { voiceKeys } from '../sound/kitgen';
import { clamp, clone, MAX_PATTERNS, VARIATION_SLOTS, MAX_STEPS, stepTicks, type StepSound, type Variation, type DestructionSettings, type GenSettings, type Hit, type Pattern, type Project, type Quantize, type Resolution, type SynthKit, type Track, type TrackMix, type TrackPlay, type TrackSound } from '../model/types';
import { MidiController } from '../midi/controller';
import { generate, stepsPerBar } from '../rhythm/generate';
import { mutate, summariseOps } from '../rhythm/mutate';
import { clearTrack, commitEdits, copyRegion, editCount, newPattern, pasteRegion, setHit, setLength, setResolution, setSounds, setStepSound, shiftTrack, soundCount, sourceGrid, stepSoundAt, type Clip } from '../rhythm/pattern';
import { hash32, randomSeed, Rng } from '../rhythm/rng';
import { styleById } from '../rhythm/styles';
import type { Realization } from '../rhythm/realize';
import { wildcard } from '../destruction/wildcard';
import { describeChop } from '../destruction/chop';
import { describeRolls } from '../destruction/rolls';
import { describeDestroy } from '../destruction/destroy';
import { evolveKit, generateKit, mutateKit, voiceRolesOf } from '../sound/kitgen';
import { KitService } from '../sound/kitService';
import { exportMidi } from '../export/midiFile';
import { Sequence } from './sequence';
import { anySolo, configureEngine, engineTrackOf, hitOf, kitDiff, masterChain, sendKit, trackIndex, type EngineTarget } from './soundConfig';
import { History } from './history';
import { loadPrefs, savePrefs, type Prefs, type SoundTab, type Workspace } from './prefs';
import { setScale } from '../ui/scale';
import { Scheduler, startTicker } from '../transport/scheduler';
import { PAR } from '../sound/lxrParamIds';

export type Topic = 'project' | 'pattern' | 'tracks' | 'kit' | 'mix' | 'transport' | 'destruction' | 'gen' | 'library' | 'midi' | 'status' | 'snapshots' | 'view' | 'workspace' | 'selection' | 'history' | 'master';

export interface Selection {
  /** track indices (inclusive) */
  t0: number;
  t1: number;
  /** steps (inclusive) */
  s0: number;
  s1: number;
}

export interface UiState {
  view: Prefs['view'];
  /** the tab open under the pattern grid */
  workspace: Workspace;
  editMode: Prefs['editMode'];
  /** the selected track id */
  track: string;
  sel: Selection | null;
  /** a pattern switch waiting for the end of the cycle */
  queued: string | null;
  playing: boolean;
  status: string;
  /** momentary fills */
  fills: Set<string>;
  /** play only the written pattern */
  sourceOnly: boolean;
  /** record incoming notes into the pattern */
  record: boolean;
  /** a kit operation is running */
  busy: boolean;
  /** the velocity new hits get */
  paintVel: number;
  /** the step being looked at or edited (a click, a right-click or the arrow keys on the grid) */
  cursor: { track: string; step: number } | null;
  /** the grid also shows what the pattern was before hand edits (deleted generated hits, edit marks) */
  showOriginal: boolean;
  /** the tab open in the SOUND view */
  soundTab: SoundTab;
  /** the sound the SYNTH editor edits: null = the base sound, 0-3 = variation A-D of the selected track */
  slot: number | null;
  /** the pass of the pattern the step-sound preview plays (1 = the first) */
  previewPass: number;
}

type DocState = Omit<Project, 'snapshots'>;

const AUTOSAVE_KEY = 'clatter.project';

export class App {
  project: Project;
  ui: UiState;
  prefs: Prefs;
  readonly host: AudioHost;
  readonly library: SampleLibrary;
  readonly midi: MidiController;
  readonly history: History<DocState>;
  readonly sequence: Sequence;
  readonly scheduler: Scheduler;
  kits: KitService | null = null;
  module: WebAssembly.Module | null = null;
  initKit: SynthKit | null = null;
  meters: MetersMessage | null = null;
  clip: Clip | null = null;
  /** the step sound COPY took */
  soundClip: StepSound | null = null;
  private fns = new Map<Topic, Set<() => void>>();
  private stopTicker: (() => void) | null = null;
  private sentSamples = new Set<string>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private evolveHome: SynthKit | null = null;
  private evolveStep = 0;
  private bundledIds = new Map<string, string>();
  readonly live: EngineTarget;

  constructor(opts: { trackCount?: number } = {}) {
    this.prefs = loadPrefs();
    this.project = defaultProject();
    this.ui = {
      view: this.prefs.view,
      workspace: this.prefs.workspace,
      editMode: this.prefs.editMode,
      track: this.project.tracks[0]!.id,
      sel: null,
      queued: null,
      playing: false,
      status: 'READY',
      fills: new Set(),
      sourceOnly: false,
      record: false,
      busy: false,
      paintVel: 100,
      cursor: null,
      showOriginal: false,
      soundTab: this.prefs.soundTab,
      slot: null,
      previewPass: 1,
    };
    this.host = new AudioHost(opts.trackCount ?? 12, 1);
    let store: IndexedDbSampleStore | null = null;
    try {
      store = typeof indexedDB === 'undefined' ? null : new IndexedDbSampleStore('clatter-samples');
    } catch {
      store = null;
    }
    this.library = new SampleLibrary(store);
    this.library.onChange(() => this.emit(['library']));
    this.history = new History<DocState>(
      () => {
        const { snapshots: _s, ...rest } = this.project;
        void _s;
        return clone(rest);
      },
      (s) => {
        this.project = { ...clone(s), snapshots: this.project.snapshots };
        this.afterLoad(false);
      },
    );
    this.sequence = new Sequence({
      project: () => this.project,
      takeQueued: () => {
        const q = this.ui.queued;
        this.ui.queued = null;
        return q;
      },
      fills: () => this.ui.fills,
      sourceOnly: () => this.ui.sourceOnly,
      onPattern: (id) => {
        if (this.project.current !== id) {
          this.project.current = id;
          this.emit(['pattern', 'transport']);
        }
      },
    });
    this.scheduler = new Scheduler(this.sequence, {
      now: () => this.host.now,
      emit: (evs) => this.emitHits(evs),
      clock: (times) => this.midi.clock(times.map((t) => this.host.perfTimeOf(t))),
      onBar: (bar, time) => this.onBar(bar, time),
      onCycle: () => this.emit(['transport']),
      startDelay: 0.08,
    });
    this.midi = new MidiController(
      {
        note: (ch, note, vel) => this.midiNote(ch, note, vel),
        tempo: (bpm) => this.setTempo(bpm, false),
        transport: (m) => (m === 'stop' ? this.stop() : void this.play()),
        changed: () => {
          this.prefs.midi = { ...this.midi.prefs };
          savePrefs(this.prefs);
          this.emit(['midi']);
        },
        message: (t) => this.say(t),
      },
      this.prefs.midi,
    );
    const host = this.host;
    this.live = {
      setTrack: (i, t) => host.send({ type: 'track', index: i, track: t }),
      setParams: (values, time) => host.send({ type: 'params', values, time }),
      setModTarget: (kind, voice, param) => host.send({ type: 'modTarget', kind, voice, param }),
      setBpm: (bpm) => host.send({ type: 'bpm', bpm }),
      setMaster: (volume, clip, chain) => host.send({ type: 'master', volume, clip, chain }),
      setSample: (id, s) => {
        if (this.sentSamples.has(id)) return;
        this.sentSamples.add(id);
        host.send({ type: 'sample', id, rate: s.rate, channels: s.channels.map((c) => c.slice()) });
      },
    };
    host.onMeters((m) => {
      this.meters = m;
    });
    host.onState(() => this.emit(['transport', 'status']));
  }

  // ------------------------------------------------------------------ events
  on(topic: Topic, fn: () => void): () => void {
    let s = this.fns.get(topic);
    if (!s) this.fns.set(topic, (s = new Set()));
    s.add(fn);
    return () => s!.delete(fn);
  }

  emit(topics: Topic[]): void {
    const done = new Set<() => void>();
    for (const t of topics)
      for (const f of this.fns.get(t) ?? []) {
        if (done.has(f)) continue;
        done.add(f);
        f();
      }
  }

  say(status: string): void {
    this.ui.status = status;
    this.emit(['status']);
  }

  // ------------------------------------------------------------------ start-up
  /** Load the engine, the bundled samples and the last session. */
  async boot(base = './'): Promise<void> {
    const wasm = await lxrWasm();
    this.module = await WebAssembly.compile(wasm.slice(0));
    this.kits = new KitService(wasm);
    this.initKit = await this.kits.ready;
    const bundled = await this.library.loadBundled(base);
    for (const s of bundled) this.bundledIds.set(s.name.toLowerCase(), s.id);
    await this.library.restore();
    let restored = false;
    try {
      const raw = localStorage.getItem(AUTOSAVE_KEY);
      if (raw) {
        this.project = parseProject(raw, this.initKit);
        restored = true;
      }
    } catch {
      restored = false;
    }
    if (!restored) await this.loadPreset(PRESETS[0]!.id, false);
    else this.afterLoad(true);
    this.say(restored ? 'SESSION RESTORED' : 'READY: PRESS PLAY (SPACE)');
  }

  private bundledId = (file: string): string | undefined => this.bundledIds.get(file.replace(/\.wav$/i, '').toLowerCase());

  /** After the project object was replaced (load, undo, preset): resync everything. */
  private afterLoad(resetHistory: boolean): void {
    resolveBundled(this.project, this.bundledId);
    if (!this.project.tracks.some((t) => t.id === this.ui.track)) this.ui.track = this.project.tracks[0]!.id;
    if (resetHistory) this.history.clear();
    this.ui.sel = null;
    this.ui.queued = null;
    this.evolveHome = null;
    configureEngine(this.live, this.project, this.library);
    this.scheduler.setTempo(this.project.tempo);
    this.touch(['project', 'pattern', 'tracks', 'kit', 'mix', 'gen', 'destruction', 'transport', 'snapshots', 'master', 'history']);
  }

  /** State changed: replan, autosave, redraw. */
  private touch(topics: Topic[]): void {
    this.sequence.bump();
    this.scheduler.invalidate();
    this.autosave();
    this.emit([...topics, 'history']);
  }

  private autosave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(AUTOSAVE_KEY, serialize(this.project));
      } catch {
        /* storage full or blocked */
      }
    }, 800);
  }

  /** An undoable change. */
  private change(label: string, fn: () => void, topics: Topic[]): void {
    this.history.push(label);
    fn();
    this.touch(topics);
  }

  /** A change quantised to the next boundary while playing (PERFORM). */
  private quantised(label: string, fn: () => void, topics: Topic[], q: Quantize = this.project.quantize): void {
    if (!this.ui.playing) {
      this.change(label, fn, topics);
      return;
    }
    this.say(`${label} · NEXT ${q.toUpperCase()}`);
    this.scheduler.at(q, () => {
      this.change(label, fn, topics);
      this.say(label);
    });
  }

  /** Run a change at the next quantise boundary while playing (it makes its own undo step). */
  private atBoundary(label: string, fn: () => void, q: Quantize = this.project.quantize): void {
    this.say(`${label} · NEXT ${q.toUpperCase()}`);
    this.scheduler.at(q, () => {
      fn();
      this.say(label);
    });
  }

  // ------------------------------------------------------------------ accessors
  get pattern(): Pattern {
    return this.project.patterns.find((p) => p.id === this.project.current) ?? this.project.patterns[0]!;
  }

  get track(): Track {
    return this.project.tracks.find((t) => t.id === this.ui.track) ?? this.project.tracks[0]!;
  }

  trackIndexOf(id: string): number {
    return this.project.tracks.findIndex((t) => t.id === id);
  }

  /** The realisation playing now (or of cycle 0 when stopped) for the grid overlay. */
  displayRealization(): Realization {
    if (this.ui.playing) {
      const pos = this.playhead();
      if (pos) return this.sequence.realization(pos.cycle, pos.pattern);
    }
    return this.sequence.realization(0, this.pattern.id);
  }

  /** Where the music is now (what is heard): pattern, cycle and fractional step. */
  playhead(): { pattern: string; cycle: number; step: number; tick: number } | null {
    if (!this.ui.playing || !this.scheduler.running) return null;
    const tick = this.scheduler.tickAt(this.host.now - this.host.latency);
    if (tick < 0) return null;
    const c = this.scheduler.cycleAt(tick);
    if (!c) return null;
    const p = this.project.patterns.find((x) => x.id === c.plan.pattern) ?? this.pattern;
    return { pattern: c.plan.pattern, cycle: c.k, step: (tick - c.start) / stepTicks(p.res), tick };
  }

  // ------------------------------------------------------------------ transport
  async play(): Promise<void> {
    if (this.ui.playing) return;
    try {
      await this.host.start();
    } catch {
      this.say(`AUDIO FAILED: ${this.host.error}`);
      return;
    }
    configureEngine(this.live, this.project, this.library);
    this.sequence.reset();
    this.sequence.bump();
    this.scheduler.setTempo(this.project.tempo);
    const t0 = this.host.now + 0.1;
    this.scheduler.start(t0);
    this.midi.start(this.host.perfTimeOf(t0));
    this.ui.playing = true;
    this.evolveStep = 0;
    this.evolveHome = clone(this.project.kit.synth);
    this.stopTicker = startTicker(() => {
      this.scheduler.pump();
      this.midi.follower.check(performance.now());
    });
    this.say('PLAYING');
    this.emit(['transport']);
  }

  stop(): void {
    if (!this.ui.playing) return;
    this.stopTicker?.();
    this.stopTicker = null;
    this.scheduler.stop();
    this.host.send({ type: 'cancel', time: this.host.now });
    this.midi.stop();
    this.ui.playing = false;
    this.ui.queued = null;
    this.say('STOPPED');
    this.emit(['transport']);
  }

  togglePlay(): void {
    if (this.ui.playing) this.stop();
    else void this.play();
  }

  /** Everything off now: queued hits, sounding samples, synth layers and MIDI notes. */
  panic(): void {
    this.host.send({ type: 'panic' });
    this.midi.panic();
    this.say('PANIC: ALL SOUND OFF');
  }

  private emitHits(evs: import('../transport/scheduler').ScheduledEvent[]): void {
    const p = this.project;
    const idx = trackIndex(p);
    const hits: TimedHit[] = [];
    for (const se of evs) {
      const h = hitOf(se, p, idx, this.scheduler.spt, this.ui.fills);
      if (!h) continue;
      hits.push(h);
      const t = p.tracks[h.track]!;
      const audible = !t.mix.mute && (!anySolo(p) || t.mix.solo);
      if (audible) this.midi.note(t.midi.channel, t.midi.note, h.vel, this.host.perfTimeOf(se.time), Math.max(20, (h.gate ?? 2646) / 44.1));
    }
    if (hits.length) this.host.send({ type: 'hits', hits });
  }

  setTempo(bpm: number, undoable = true): void {
    const b = Math.round(clamp(bpm, 30, 300) * 10) / 10;
    if (b === this.project.tempo) return;
    const apply = () => {
      this.project.tempo = b;
      this.scheduler.setTempo(b);
      this.live.setBpm(b);
    };
    if (undoable) this.change('TEMPO', apply, ['transport']);
    else {
      apply();
      this.emit(['transport']);
    }
  }

  setSwing(swing: number): void {
    this.change('SWING', () => (this.project.swing = Math.round(clamp(swing, 50, 75))), ['transport', 'pattern']);
  }

  setQuantize(q: Quantize): void {
    this.project.quantize = q;
    this.autosave();
    this.emit(['transport']);
  }

  // ------------------------------------------------------------------ patterns
  selectPattern(id: string): void {
    if (!this.project.patterns.some((p) => p.id === id)) return;
    if (this.ui.playing) {
      this.ui.queued = id;
      this.say(`PATTERN ${this.project.patterns.find((p) => p.id === id)!.name} · NEXT CYCLE`);
      this.emit(['transport']);
      return;
    }
    this.project.current = id;
    this.ui.sel = null;
    this.touch(['pattern', 'transport']);
  }

  /** A new pattern (empty, or a copy of the current one). */
  addPattern(copy: boolean): void {
    if (this.project.patterns.length >= MAX_PATTERNS) return this.say('16 PATTERNS AT MOST');
    this.change(
      copy ? 'DUPLICATE PATTERN' : 'NEW PATTERN',
      () => {
        const used = new Set(this.project.patterns.map((p) => p.id));
        let n = 1;
        while (used.has(`p${n}`)) n++;
        const names = new Set(this.project.patterns.map((p) => p.name));
        let name = 'A';
        for (let i = 0; i < 26; i++) {
          name = String.fromCharCode(65 + i);
          if (!names.has(name)) break;
        }
        const p: Pattern = copy ? { ...clone(this.pattern), id: `p${n}`, name } : newPattern(`p${n}`, name, this.project.gen, this.pattern.res);
        if (!copy) {
          p.seed = randomSeed();
          p.gen = generate(this.project.tracks, this.project.gen, p.seed, { steps: p.steps, res: p.res });
        }
        this.project.patterns.push(p);
        if (!this.ui.playing) this.project.current = p.id;
        else this.ui.queued = p.id;
      },
      ['pattern', 'transport'],
    );
  }

  deletePattern(id: string): void {
    if (this.project.patterns.length <= 1) return;
    this.change(
      'DELETE PATTERN',
      () => {
        this.project.patterns = this.project.patterns.filter((p) => p.id !== id);
        this.project.chain.entries = this.project.chain.entries.filter((e) => e.pattern !== id);
        if (this.project.current === id) this.project.current = this.project.patterns[0]!.id;
      },
      ['pattern', 'transport'],
    );
  }

  setChain(on: boolean): void {
    this.change(
      on ? 'CHAIN ON' : 'CHAIN OFF',
      () => {
        this.project.chain.on = on;
        if (on && !this.project.chain.entries.length) this.project.chain.entries = this.project.patterns.map((p) => ({ pattern: p.id, repeats: 2 }));
      },
      ['transport'],
    );
  }

  setChainEntries(entries: { pattern: string; repeats: number }[]): void {
    this.change('CHAIN', () => (this.project.chain.entries = entries.slice(0, 64)), ['transport']);
  }

  setLength(steps: number): void {
    this.change('LENGTH', () => setLength(this.pattern, clamp(Math.round(steps), 1, MAX_STEPS)), ['pattern']);
  }

  setResolution(res: Resolution): void {
    this.change('RESOLUTION', () => setResolution(this.pattern, res, this.project.tracks.map((t) => t.id)), ['pattern']);
  }

  // ------------------------------------------------------------------ RHYTHM: generation
  setGen(g: Partial<GenSettings>, label = 'GENERATOR'): void {
    this.history.begin(label);
    Object.assign(this.project.gen, g);
    this.history.commit();
    this.autosave();
    this.emit(['gen', 'history']);
  }

  private genGeometry(): { steps: number; res: Resolution } {
    const res = this.pattern.res;
    return { steps: Math.min(MAX_STEPS, stepsPerBar(res) * this.project.gen.bars), res };
  }

  /** GENERATE: a new arrangement from the generator settings (locked tracks and hand edits kept). */
  generatePattern(quantise = false): void {
    const seed = randomSeed();
    const fn = () => {
      const p = this.pattern;
      const geo = this.genGeometry();
      if (p.steps !== geo.steps) setLength(p, geo.steps);
      p.seed = seed;
      p.settings = { ...this.project.gen };
      p.gen = generate(this.project.tracks, this.project.gen, seed, geo, p.gen);
      p.generation = 0;
      this.say(`GENERATED ${styleById(this.project.gen.style).label} · SEED ${seed}`);
    };
    if (quantise) this.quantised('GENERATE', fn, ['pattern']);
    else this.change('GENERATE', fn, ['pattern']);
  }

  private unlocked(): string[] {
    return this.project.tracks.filter((t) => !t.lock).map((t) => t.id);
  }

  private mutatePattern(label: string, strength: number, quantise: boolean): void {
    const seed = randomSeed();
    const fn = () => {
      const p = this.pattern;
      const lengths = Object.fromEntries(this.project.tracks.filter((t) => t.play.length > 0).map((t) => [t.id, t.play.length]));
      const r = mutate(p.gen, this.unlocked(), p.res, new Rng(seed), strength, lengths);
      p.gen = r.grids;
      p.generation++;
      this.say(`${label}: ${summariseOps(r.ops)}`);
    };
    if (quantise) this.quantised(label, fn, ['pattern']);
    else this.change(label, fn, ['pattern']);
  }

  /** VARIATION: a related pattern. */
  variation(quantise = false): void {
    this.mutatePattern('VARIATION', 0.4, quantise);
  }

  /** MUTATE: small controlled changes. */
  mutate(quantise = false): void {
    this.mutatePattern('MUTATE', 0.15, quantise);
  }

  /** REGENERATE: new material after the first bar (locks respected). */
  regenerate(quantise = false): void {
    const seed = randomSeed();
    const fn = () => {
      const p = this.pattern;
      p.gen = generate(this.project.tracks, p.settings, seed, { steps: p.steps, res: p.res }, p.gen, 1);
      this.say('REGENERATED AFTER BAR 1');
    };
    if (quantise) this.quantised('REGENERATE', fn, ['pattern']);
    else this.change('REGENERATE', fn, ['pattern']);
  }

  /** RESET: back to the generated baseline: hand edits cleared, transformations off. */
  reset(): void {
    this.change(
      'RESET',
      () => {
        this.pattern.edits = {};
        const d = this.project.destruction;
        d.chop.on = false;
        d.rolls.on = false;
        d.destroy.on = false;
        this.say('RESET TO THE GENERATED PATTERN');
      },
      ['pattern', 'destruction'],
    );
  }

  /** KEEP: what is written (baseline + edits) becomes the baseline. */
  keepEdits(): void {
    this.change('KEEP EDITS', () => commitEdits(this.pattern, this.project.tracks.map((t) => t.id)), ['pattern']);
  }

  lockTrack(id: string): void {
    const t = this.project.tracks.find((x) => x.id === id);
    if (!t) return;
    this.change(t.lock ? 'UNLOCK TRACK' : 'LOCK TRACK', () => (t.lock = !t.lock), ['tracks', 'pattern']);
  }

  // ------------------------------------------------------------------ RHYTHM: editing
  hitAt(trackId: string, step: number): Hit | null {
    return sourceGrid(this.pattern, trackId)[step] ?? null;
  }

  /** Click on a cell: add (at the paint velocity) or remove. */
  toggleCell(trackId: string, step: number): void {
    const h = this.hitAt(trackId, step);
    this.change(h ? 'DELETE HIT' : 'ADD HIT', () => setHit(this.pattern, trackId, step, h ? null : { vel: this.ui.paintVel }), ['pattern']);
  }

  /** A paint gesture over several cells is one undo step. */
  beginPaint(): void {
    this.history.begin('PAINT');
  }

  paintCell(trackId: string, step: number, on: boolean): void {
    const h = this.hitAt(trackId, step);
    if (!!h === on) return;
    setHit(this.pattern, trackId, step, on ? { vel: this.ui.paintVel } : null);
    this.touch(['pattern']);
  }

  endPaint(): void {
    this.history.commit();
    this.emit(['history']);
  }

  setHitProps(trackId: string, step: number, props: Partial<Hit>, label = 'EDIT HIT'): void {
    const h = this.hitAt(trackId, step);
    if (!h) return;
    this.change(label, () => setHit(this.pattern, trackId, step, cleanHit({ ...h, ...props })), ['pattern']);
  }

  /** Apply to every hit in the selection (or the selected track's hits). */
  editSelection(fn: (h: Hit) => Hit, label: string): void {
    const sel = this.ui.sel;
    const ids = this.project.tracks.map((t) => t.id);
    this.change(
      label,
      () => {
        const p = this.pattern;
        const rows = sel ? ids.slice(Math.min(sel.t0, sel.t1), Math.max(sel.t0, sel.t1) + 1) : [this.ui.track];
        const a = sel ? Math.min(sel.s0, sel.s1) : 0;
        const b = sel ? Math.max(sel.s0, sel.s1) : p.steps - 1;
        for (const id of rows) {
          const g = sourceGrid(p, id);
          for (let s = a; s <= b; s++) {
            const h = g[s];
            if (h) setHit(p, id, s, cleanHit(fn({ ...h })));
          }
        }
      },
      ['pattern'],
    );
  }

  select(sel: Selection | null): void {
    this.ui.sel = sel;
    this.emit(['selection']);
  }

  selectTrack(id: string): void {
    this.ui.track = id;
    if (this.ui.cursor) this.ui.cursor = { ...this.ui.cursor, track: id };
    this.emit(['selection', 'tracks']);
  }

  /** Look at (and edit) one step of one track. */
  setCursor(c: { track: string; step: number } | null): void {
    this.ui.cursor = c;
    this.emit(['selection']);
  }

  /** The step the editors work on: a single selected cell, else the cursor (if it is still on the pattern). */
  cursorCell(): { track: string; step: number } | null {
    const s = this.ui.sel;
    if (s && s.t0 === s.t1 && s.s0 === s.s1) {
      const t = this.project.tracks[s.t0];
      if (t && s.s0 < this.pattern.steps) return { track: t.id, step: s.s0 };
    }
    const c = this.ui.cursor;
    if (c && c.step < this.pattern.steps && this.project.tracks.some((t) => t.id === c.track)) return c;
    return null;
  }

  setShowOriginal(on: boolean): void {
    this.ui.showOriginal = on;
    this.emit(['pattern']);
  }

  copy(): void {
    const sel = this.ui.sel;
    const ids = this.project.tracks.map((t) => t.id);
    if (sel) this.clip = copyRegion(this.pattern, ids.slice(Math.min(sel.t0, sel.t1), Math.max(sel.t0, sel.t1) + 1), sel.s0, sel.s1);
    else this.clip = copyRegion(this.pattern, ids, 0, this.pattern.steps - 1);
    this.say(`COPIED ${this.clip.rows.length} × ${this.clip.steps}`);
  }

  paste(): void {
    const c = this.clip;
    if (!c) return;
    const sel = this.ui.sel;
    const ids = this.project.tracks.map((t) => t.id);
    const t0 = sel ? Math.min(sel.t0, sel.t1) : c.rows.length === ids.length ? 0 : this.trackIndexOf(this.ui.track);
    const s0 = sel ? Math.min(sel.s0, sel.s1) : 0;
    this.change('PASTE', () => pasteRegion(this.pattern, ids.slice(t0), s0, c), ['pattern']);
  }

  clearSelection(): void {
    this.editSelection(() => null as unknown as Hit, 'CLEAR');
  }

  clearTrack(id: string): void {
    this.change('CLEAR TRACK', () => clearTrack(this.pattern, id), ['pattern']);
  }

  shiftTrack(id: string, n: number): void {
    this.change('SHIFT', () => shiftTrack(this.pattern, id, n), ['pattern']);
  }

  editCount(): number {
    return editCount(this.pattern);
  }

  undo(): void {
    const l = this.history.undo();
    this.say(l ? `UNDO ${l}` : 'NOTHING TO UNDO');
  }

  redo(): void {
    const l = this.history.redo();
    this.say(l ? `REDO ${l}` : 'NOTHING TO REDO');
  }

  setTrackPlay(id: string, play: Partial<TrackPlay>, label = 'PLAY CONTROL'): void {
    const t = this.project.tracks.find((x) => x.id === id);
    if (!t) return;
    this.history.begin(label);
    Object.assign(t.play, play);
    this.history.commit();
    this.touch(['tracks', 'pattern']);
  }

  // ------------------------------------------------------------------ DESTRUCTION
  setDestruction(f: (d: DestructionSettings) => void, label: string, quantise = false): void {
    if (quantise) return this.quantised(label, () => f(this.project.destruction), ['destruction', 'pattern']);
    this.history.begin(label);
    f(this.project.destruction);
    this.history.commit();
    this.touch(['destruction', 'pattern']);
  }

  toggleChop(quantise = false): void {
    this.setDestruction((d) => (d.chop.on = !d.chop.on), 'CHOP', quantise);
  }

  toggleRolls(quantise = false): void {
    this.setDestruction((d) => (d.rolls.on = !d.rolls.on), 'ROLLS', quantise);
  }

  toggleDestroy(quantise = false): void {
    this.setDestruction((d) => (d.destroy.on = !d.destroy.on), 'DESTROY', quantise);
  }

  rechop(quantise = false): void {
    this.setDestruction((d) => ((d.chop.on = true), d.chop.take++), 'RE-CHOP', quantise);
  }

  reroll(quantise = false): void {
    this.setDestruction((d) => ((d.rolls.on = true), d.rolls.take++), 'RE-ROLL', quantise);
  }

  redestroy(quantise = false): void {
    this.setDestruction((d) => ((d.destroy.on = true), d.destroy.take++), 'RE-DESTROY', quantise);
  }

  /** WILDCARD: one bounded, seeded re-imagining (one undo step). */
  async wildcard(quantise = false): Promise<void> {
    const seed = randomSeed();
    const w = wildcard(this.project.gen, this.project.destruction, this.project.swing, seed);
    let kit: SynthKit | null = null;
    if (w.kitMutation > 0) kit = await this.checkedKit(mutateKit(this.project.kit.synth, { ...this.kitOpts(seed), amount: w.kitMutation }), seed);
    const fn = () => {
      this.project.gen = w.gen;
      this.project.destruction = w.destruction;
      this.project.swing = w.swing;
      if (w.regenerate) {
        const p = this.pattern;
        p.seed = seed;
        p.settings = { ...w.gen };
        p.gen = generate(this.project.tracks, w.gen, seed, { steps: p.steps, res: p.res }, p.gen);
      }
      if (kit) this.applyKitChange(kit);
      this.say(`WILDCARD: ${w.report.join(' · ')}`);
    };
    if (quantise) this.quantised('WILDCARD', fn, ['pattern', 'gen', 'destruction', 'kit', 'transport']);
    else this.change('WILDCARD', fn, ['pattern', 'gen', 'destruction', 'kit', 'transport']);
  }

  /** What the transformation layers did in the cycle shown. */
  destructionReport(): { chop: string; rolls: string; destroy: string } {
    const r = this.displayRealization().reports;
    return { chop: describeChop(r.chop), rolls: describeRolls(r.rolls), destroy: describeDestroy(r.destroy) };
  }

  // ------------------------------------------------------------------ PERFORM
  fill(on: boolean, trackIds?: string[]): void {
    const ids = trackIds ?? this.project.tracks.filter((t) => ['snare', 'clap', 'ltom', 'htom', 'perc', 'chat'].includes(t.role)).map((t) => t.id);
    for (const id of ids) on ? this.ui.fills.add(id) : this.ui.fills.delete(id);
    this.sequence.bump();
    this.scheduler.invalidate();
    this.emit(['transport', 'pattern']);
  }

  setSourceOnly(on: boolean): void {
    this.ui.sourceOnly = on;
    this.sequence.bump();
    this.scheduler.invalidate();
    this.emit(['transport', 'pattern']);
  }

  storeSnapshot(i: number): void {
    const p = this.project;
    p.snapshots[i] = {
      name: `SNAP ${i + 1}`,
      pattern: clone(this.pattern),
      synth: clone(p.kit.synth),
      sounds: Object.fromEntries(p.tracks.map((t) => [t.id, clone(t.sound)])),
      mix: Object.fromEntries(p.tracks.map((t) => [t.id, clone(t.mix)])),
      play: Object.fromEntries(p.tracks.map((t) => [t.id, clone(t.play)])),
      destruction: clone(p.destruction),
      tempo: p.tempo,
      swing: p.swing,
    };
    this.autosave();
    this.say(`SNAPSHOT ${i + 1} STORED`);
    this.emit(['snapshots']);
  }

  recallSnapshot(i: number): void {
    const s = this.project.snapshots[i];
    if (!s) return this.say(`SNAPSHOT ${i + 1} IS EMPTY`);
    this.quantised(
      `SNAPSHOT ${i + 1}`,
      () => {
        const p = this.project;
        const pat = clone(s.pattern);
        pat.id = this.pattern.id;
        p.patterns = p.patterns.map((x) => (x.id === pat.id ? pat : x));
        const before = p.kit.synth;
        p.kit.synth = clone(s.synth);
        for (const t of p.tracks) {
          if (s.sounds[t.id]) t.sound = clone(s.sounds[t.id]!);
          if (s.mix[t.id]) t.mix = clone(s.mix[t.id]!);
          if (s.play[t.id]) t.play = clone(s.play[t.id]!);
        }
        p.destruction = clone(s.destruction);
        p.tempo = s.tempo;
        p.swing = s.swing;
        this.scheduler.setTempo(p.tempo);
        this.live.setBpm(p.tempo);
        this.live.setParams(kitDiff(before, p.kit.synth));
        for (let v = 0; v < 6; v++) {
          this.live.setModTarget(0, v, p.kit.synth.lfoTarget[v] ?? 0);
          this.live.setModTarget(1, v, p.kit.synth.velTarget[v] ?? 0);
        }
        this.syncTracks();
      },
      ['pattern', 'kit', 'tracks', 'mix', 'destruction', 'transport'],
    );
  }

  // ------------------------------------------------------------------ SOUND: tracks
  syncTracks(): void {
    const solo = anySolo(this.project);
    this.project.tracks.forEach((t, i) => {
      for (const id of soundSampleIds(t.sound)) {
        const s = this.library.get(id);
        if (s) this.live.setSample(id, { rate: s.rate, channels: s.channels });
      }
      this.live.setTrack(i, engineTrackOf(t, solo));
    });
  }

  setTrackSound(id: string, sound: Partial<TrackSound>, label = 'SOUND'): void {
    const t = this.project.tracks.find((x) => x.id === id);
    if (!t) return;
    this.history.begin(label);
    Object.assign(t.sound, sound);
    this.history.commit();
    this.syncTracks();
    this.touch(['tracks']);
  }

  /** Begin/end a drag on any control (one undo step). */
  beginDrag(label: string): void {
    this.history.begin(label);
  }

  endDrag(): void {
    this.history.commit();
    this.emit(['history']);
  }

  setTrackMix(id: string, mix: Partial<TrackMix>, label = 'MIXER'): void {
    const t = this.project.tracks.find((x) => x.id === id);
    if (!t) return;
    const transient = 'mute' in mix || 'solo' in mix;
    if (!transient) this.history.begin(label);
    Object.assign(t.mix, mix);
    if (!transient) this.history.commit();
    this.syncTracks();
    this.autosave();
    this.emit(['mix', 'tracks', 'history']);
  }

  setTrackName(id: string, name: string): void {
    const t = this.project.tracks.find((x) => x.id === id);
    if (t) this.change('RENAME TRACK', () => (t.name = name.toUpperCase().slice(0, 10) || t.name), ['tracks']);
  }

  setTrackMidi(id: string, midi: Partial<Track['midi']>): void {
    const t = this.project.tracks.find((x) => x.id === id);
    if (t) this.change('TRACK MIDI', () => Object.assign(t.midi, midi), ['tracks', 'midi']);
  }

  /** Play a track's sound now (audition). */
  async audition(id: string, vel = 110): Promise<void> {
    if (this.host.state !== 'running') {
      try {
        await this.host.start();
        configureEngine(this.live, this.project, this.library);
      } catch {
        return;
      }
    }
    const i = this.trackIndexOf(id);
    if (i < 0) return;
    this.host.send({ type: 'hits', hits: [{ time: this.host.now + 0.01, track: i, vel, pitch: 0 }] });
  }

  setMaster(m: Partial<Project['master']>, label = 'MASTER'): void {
    this.history.begin(label);
    Object.assign(this.project.master, m);
    this.history.commit();
    this.live.setMaster(this.project.master.volume, this.project.master.clip, masterChain(this.project));
    this.autosave();
    this.emit(['master', 'history']);
  }

  // ------------------------------------------------------------------ SOUND: synthesis
  setParam(p: number, v: number, label = 'SYNTH'): void {
    const val = clamp(Math.round(v), 0, 127);
    if (this.project.kit.synth.params[p] === val) return;
    this.history.begin(label);
    this.project.kit.synth.params[p] = val;
    this.history.commit();
    this.live.setParams([[p, val]]);
    this.autosave();
    this.emit(['kit', 'history']);
  }

  setModTarget(kind: 0 | 1, voice: number, param: number): void {
    this.change(
      kind ? 'VELOCITY TARGET' : 'LFO TARGET',
      () => {
        (kind ? this.project.kit.synth.velTarget : this.project.kit.synth.lfoTarget)[voice] = param;
        this.live.setModTarget(kind, voice, param);
      },
      ['kit'],
    );
  }

  lockVoice(v: number): void {
    this.change('LOCK VOICE', () => (this.project.soundLocks.voices[v] = !this.project.soundLocks.voices[v]), ['kit']);
  }

  lockParam(p: number): void {
    this.change(
      'LOCK PARAMETER',
      () => {
        const l = this.project.soundLocks.params;
        const i = l.indexOf(p);
        if (i >= 0) l.splice(i, 1);
        else l.push(p);
      },
      ['kit'],
    );
  }

  private kitOpts(seed: number) {
    return { seed, flavour: styleById(this.project.gen.style).kitFlavour, voiceRoles: voiceRolesOf(this.project.tracks), locks: this.project.soundLocks };
  }

  /** A kit through the engine check (levels, audibility). */
  private async checkedKit(kit: SynthKit, seed: number, voices?: number[]): Promise<SynthKit> {
    if (!this.kits) return kit;
    this.ui.busy = true;
    this.emit(['status']);
    try {
      return await this.kits.check(kit, { flavour: styleById(this.project.gen.style).kitFlavour, voiceRoles: voiceRolesOf(this.project.tracks), seed, voices, locked: this.project.soundLocks.voices });
    } finally {
      this.ui.busy = false;
      this.emit(['status']);
    }
  }

  /** Send only what changed. */
  private applyKitChange(next: SynthKit, time?: number): void {
    const before = this.project.kit.synth;
    this.project.kit.synth = next;
    const d = kitDiff(before, next);
    if (d.length) this.live.setParams(d, time);
    for (let v = 0; v < 6; v++) {
      if (before.lfoTarget[v] !== next.lfoTarget[v]) this.live.setModTarget(0, v, next.lfoTarget[v] ?? 0);
      if (before.velTarget[v] !== next.velTarget[v]) this.live.setModTarget(1, v, next.velTarget[v] ?? 0);
    }
  }

  /** GENERATE KIT: a new set of synthesised drums designed for the style. */
  async generateKit(quantise = false): Promise<void> {
    const seed = randomSeed();
    const kit = await this.checkedKit(generateKit(this.project.kit.synth, this.kitOpts(seed)), seed);
    const fn = () => {
      this.applyKitChange(kit);
      this.project.kit.seed = seed;
      this.project.kit.name = `KIT ${seed.toString(36).toUpperCase().slice(0, 5)}`;
      this.evolveHome = clone(kit);
      this.say(`NEW ${styleById(this.project.gen.style).kitFlavour.toUpperCase()} KIT · SEED ${seed}`);
    };
    if (quantise) this.quantised('GENERATE KIT', fn, ['kit']);
    else this.change('GENERATE KIT', fn, ['kit']);
  }

  /** MUTATE KIT / MUTATE VOICE: controlled changes (amount 0-1). */
  async mutateKit(amount = 0.3, voices?: number[], quantise = false): Promise<void> {
    const seed = randomSeed();
    const kit = await this.checkedKit(mutateKit(this.project.kit.synth, { ...this.kitOpts(seed), amount, voices }), seed, voices);
    const label = voices && voices.length === 1 ? 'MUTATE VOICE' : 'MUTATE KIT';
    const fn = () => {
      this.applyKitChange(kit);
      this.say(`${label} ${Math.round(amount * 100)}%`);
    };
    if (quantise) this.quantised(label, fn, ['kit']);
    else this.change(label, fn, ['kit']);
  }

  /** The LXR voice a track plays (or -1 for a sample track). */
  voiceOf(t: Track): number {
    if (t.sound.mode === 'sample') return -1;
    return t.sound.trigger >= 5 ? 5 : t.sound.trigger;
  }

  setEvolve(e: Partial<Project['evolve']>): void {
    this.change(
      'EVOLVE',
      () => {
        Object.assign(this.project.evolve, e);
        this.evolveHome = clone(this.project.kit.synth);
        this.evolveStep = 0;
      },
      ['transport', 'kit', 'pattern'],
    );
  }

  /** Back to the kit the sound evolution started from. */
  evolveReturn(): void {
    if (!this.evolveHome) return;
    const home = this.evolveHome;
    this.change('EVOLVE RETURN', () => this.applyKitChange(clone(home)), ['kit']);
  }

  private onBar(bar: number, time: number): void {
    const ev = this.project.evolve;
    if ((ev.target === 'sound' || ev.target === 'both') && bar > 0 && bar % ev.every === 0) {
      this.evolveHome ??= clone(this.project.kit.synth);
      this.evolveStep++;
      const next = evolveKit(this.project.kit.synth, this.evolveHome, { ...this.kitOpts(hash32(this.project.kit.seed, this.evolveStep)), amount: ev.amount });
      this.applyKitChange(next, time);
      this.autosave();
      this.emit(['kit']);
    }
  }


  // ------------------------------------------------------------------ SOUND: variations
  /** Which sound the SYNTH editor shows: the base sound, or variation A-D of the selected track. */
  setSlot(slot: number | null): void {
    this.ui.slot = slot;
    this.emit(['kit', 'selection']);
  }

  /** Show or hide the sound lane under the pattern grid. */
  setSoundLane(on: boolean): void {
    this.prefs.soundLane = on;
    savePrefs(this.prefs);
    this.emit(['tracks']);
  }

  setSoundTab(tab: SoundTab): void {
    this.ui.soundTab = tab;
    this.prefs.soundTab = tab;
    savePrefs(this.prefs);
    this.emit(['view']);
  }

  /** The value a parameter has in the sound being edited: the variation's own, else the kit's. */
  paramValue(p: number): number {
    const v = this.ui.slot !== null ? this.track.sound.variations?.[this.ui.slot] : null;
    return v?.params[p] ?? this.project.kit.synth.params[p] ?? 0;
  }

  /** Does the sound being edited override this parameter? */
  paramOverridden(p: number): boolean {
    return this.ui.slot !== null && this.track.sound.variations?.[this.ui.slot]?.params[p] !== undefined;
  }

  private ensureVariations(t: Track): (Variation | null)[] {
    const sound = t.sound;
    const list = (sound.variations ??= []);
    while (list.length < VARIATION_SLOTS) list.push(null);
    return list;
  }

  private tidyVariations(t: Track): void {
    if (t.sound.variations && t.sound.variations.every((v) => !v)) delete t.sound.variations;
  }

  /**
   * Set a parameter of the sound being edited. On the base sound this is the kit; on a variation
   * it is that variation's own value (equal to the kit's: the override is dropped and the
   * parameter follows the kit again). Editing by hand clears the variation's `gen` mark.
   */
  setEditedParam(p: number, v: number, label = 'SYNTH'): void {
    const slot = this.ui.slot;
    if (slot === null) return this.setParam(p, v, label);
    const t = this.track;
    const def = lockableParam(t.sound.trigger, p);
    if (!def) return this.setParam(p, v, label);
    const val = clamp(Math.round(v), 0, def.max);
    if (this.paramValue(p) === val) return;
    this.history.begin(label);
    const list = this.ensureVariations(t);
    const cur = (list[slot] ??= { name: '', params: {} });
    if (val === (this.project.kit.synth.params[p] ?? 0)) delete cur.params[p];
    else cur.params[p] = val;
    delete cur.gen;
    this.history.commit();
    this.autosave();
    this.sequence.bump();
    this.scheduler.invalidate();
    this.emit(['kit', 'history', 'pattern']);
  }

  /** A sample-layer setting of the sound being edited: the variation's own, else the track's. */
  sampleValue<K extends 'tune' | 'fine' | 'gain' | 'pan' | 'reverse'>(k: K): TrackSound[K] {
    const v = this.ui.slot !== null ? this.track.sound.variations?.[this.ui.slot] : null;
    return (v?.sample?.[k] ?? this.track.sound[k]) as TrackSound[K];
  }

  sampleOverridden(k: 'tune' | 'fine' | 'gain' | 'pan' | 'reverse'): boolean {
    return this.ui.slot !== null && this.track.sound.variations?.[this.ui.slot]?.sample?.[k] !== undefined;
  }

  /** Set tune, fine, gain, pan or reverse on the base sound, or as an override of the edited variation. */
  setEditedSample(patch: Pick<Partial<TrackSound>, 'tune' | 'fine' | 'gain' | 'pan' | 'reverse'>, label: string): void {
    const slot = this.ui.slot;
    const t = this.track;
    if (slot === null) return this.setTrackSound(t.id, patch, label);
    this.history.begin(label);
    const list = this.ensureVariations(t);
    const cur = (list[slot] ??= { name: '', params: {} });
    const smp = (cur.sample ??= {});
    for (const [k, val] of Object.entries(patch)) {
      const key = k as 'tune' | 'fine' | 'gain' | 'pan' | 'reverse';
      if (val === t.sound[key]) delete smp[key];
      else (smp as Record<string, unknown>)[key] = val;
    }
    if (!Object.keys(smp).length) delete cur.sample;
    delete cur.gen;
    this.history.commit();
    this.syncTracks();
    this.autosave();
    this.sequence.bump();
    this.scheduler.invalidate();
    this.emit(['tracks', 'history', 'pattern']);
  }

  /** Make a parameter of the edited variation follow the kit again. */
  inheritParam(p: number): void {
    const slot = this.ui.slot;
    const v = slot === null ? null : this.track.sound.variations?.[slot];
    if (!v || v.params[p] === undefined) return;
    this.change('INHERIT PARAMETER', () => delete v.params[p], ['kit']);
  }

  /** Create variation `slot` of a track from its base sound (an empty one that inherits everything). */
  createVariation(trackId: string, slot: number, name = ''): void {
    const t = this.project.tracks.find((x) => x.id === trackId);
    if (!t) return;
    this.change('NEW VARIATION', () => (this.ensureVariations(t)[slot] = { name: name.toUpperCase().slice(0, 10), params: {} }), ['tracks', 'kit']);
    this.setSlot(slot);
  }

  /** Copy a variation (or, with from = null, the base sound's sample settings) to another slot. */
  duplicateVariation(trackId: string, from: number, to: number): void {
    const t = this.project.tracks.find((x) => x.id === trackId);
    const src = t?.sound.variations?.[from];
    if (!t || !src) return;
    this.change('DUPLICATE VARIATION', () => (this.ensureVariations(t)[to] = { ...clone(src), name: src.name, gen: undefined, lock: undefined }), ['tracks', 'kit']);
    this.setSlot(to);
  }

  renameVariation(trackId: string, slot: number, name: string): void {
    const v = this.project.tracks.find((x) => x.id === trackId)?.sound.variations?.[slot];
    if (v) this.change('RENAME VARIATION', () => (v.name = name.toUpperCase().slice(0, 10)), ['tracks']);
  }

  clearVariation(trackId: string, slot: number): void {
    const t = this.project.tracks.find((x) => x.id === trackId);
    if (!t?.sound.variations?.[slot]) return;
    this.change('CLEAR VARIATION', () => {
      this.ensureVariations(t)[slot] = null;
      this.tidyVariations(t);
    }, ['tracks', 'kit']);
  }

  lockVariation(trackId: string, slot: number): void {
    const v = this.project.tracks.find((x) => x.id === trackId)?.sound.variations?.[slot];
    if (v) this.change(v.lock ? 'UNLOCK VARIATION' : 'LOCK VARIATION', () => (v.lock = v.lock ? undefined : true), ['tracks']);
  }

  /** Protect (or release) a track's variations and step sounds from the sound generators. */
  lockTrackSound(trackId: string): void {
    const t = this.project.tracks.find((x) => x.id === trackId);
    if (t) this.change(t.sound.soundLock ? 'UNLOCK TRACK SOUND' : 'LOCK TRACK SOUND', () => (t.sound.soundLock = t.sound.soundLock ? undefined : true), ['tracks']);
  }

  /** The same LXR parameter on another voice (drum voices share a layout; others map by name). */
  private translateParams(params: Record<number, number>, fromTrig: number, toTrig: number): Record<number, number> | null {
    const a = voiceKeys(fromTrig >= 5 ? 5 : fromTrig);
    const b = voiceKeys(toTrig >= 5 ? 5 : toTrig);
    const out: Record<number, number> = {};
    for (const [k, val] of Object.entries(params)) {
      const key = (Object.keys(a) as (keyof typeof a)[]).find((x) => a[x] === Number(k));
      const to = key ? b[key] : undefined;
      if (to !== undefined && lockableParam(toTrig, to)) out[to] = val;
    }
    return Object.keys(out).length || !Object.keys(params).length ? out : null;
  }

  /** Copy a variation to a compatible track (same kind of voice, or both sample tracks). */
  copyVariationTo(trackId: string, slot: number, toTrackId: string, toSlot = slot): boolean {
    const t = this.project.tracks.find((x) => x.id === trackId);
    const d = this.project.tracks.find((x) => x.id === toTrackId);
    const src = t?.sound.variations?.[slot];
    if (!t || !d || !src) return false;
    const params = this.translateParams(src.params, t.sound.trigger, d.sound.trigger);
    if (!params) {
      this.say(`${d.name} CANNOT TAKE THAT VARIATION`);
      return false;
    }
    this.change('COPY VARIATION', () => (this.ensureVariations(d)[toSlot] = { name: src.name, params, ...(src.sample ? { sample: clone(src.sample) } : {}) }), ['tracks', 'kit']);
    this.say(`VARIATION ${String.fromCharCode(65 + slot)} COPIED TO ${d.name}`);
    return true;
  }

  // ------------------------------------------------------------------ STEP SOUND
  stepSound(trackId: string, step: number): StepSound | undefined {
    return stepSoundAt(this.pattern, trackId, step);
  }

  /** The steps the Step Sound editor acts on: the selected region's hits, or the cursor step. */
  soundTargets(): { track: string; step: number }[] {
    const s = this.ui.sel;
    if (s && !(s.t0 === s.t1 && s.s0 === s.s1)) {
      const out: { track: string; step: number }[] = [];
      for (let ti = Math.min(s.t0, s.t1); ti <= Math.max(s.t0, s.t1); ti++) {
        const t = this.project.tracks[ti];
        if (!t) continue;
        for (let st = Math.min(s.s0, s.s1); st <= Math.max(s.s0, s.s1) && st < this.pattern.steps; st++) if (this.hitAt(t.id, st)) out.push({ track: t.id, step: st });
      }
      return out;
    }
    const c = this.cursorCell();
    return c ? [c] : [];
  }

  /** Change the sound of the target steps. `fn` gets a copy of each step's sound ({} when none). */
  editStepSound(fn: (cur: StepSound, track: Track) => StepSound | undefined, label: string, targets = this.soundTargets()): void {
    if (!targets.length) return;
    this.change(
      label,
      () => {
        for (const x of targets) {
          const t = this.project.tracks.find((y) => y.id === x.track);
          if (!t) continue;
          const next = fn(clone(stepSoundAt(this.pattern, x.track, x.step) ?? {}), t);
          if (next) delete next.gen; // changed by hand: the generators leave it alone
          setStepSound(this.pattern, x.track, x.step, next && !isEmptyStepSound(next) ? next : undefined);
        }
      },
      ['pattern'],
    );
  }

  /** Keep only what the voice a step plays has (after a voice switch). */
  private fitToVoice(ss: StepSound, track: Track): StepSound {
    const trig = ss.voice ?? track.sound.trigger;
    if (ss.locks) {
      for (const k of Object.keys(ss.locks)) if (!lockableParam(trig, Number(k))) delete ss.locks[Number(k)];
      if (!Object.keys(ss.locks).length) delete ss.locks;
    }
    if (ss.rules) {
      ss.rules = ss.rules.filter((r) => lockableParam(trig, r.p));
      if (!ss.rules.length) delete ss.rules;
    }
    return ss;
  }

  setStepVariation(v: number | undefined, label = 'STEP VARIATION'): void {
    this.editStepSound((s) => {
      if (v === undefined) delete s.v;
      else s.v = v;
      return s;
    }, label);
  }

  setStepVoice(trig: number | undefined): void {
    this.editStepSound((s, t) => {
      if (trig === undefined || trig === t.sound.trigger) delete s.voice;
      else s.voice = trig;
      return this.fitToVoice(s, t);
    }, 'STEP VOICE');
  }

  /** Lock a parameter on the target steps (null: back to the track's value). */
  setStepLock(p: number, v: number | null): void {
    this.editStepSound((s, t) => {
      const def = lockableParam(s.voice ?? t.sound.trigger, p);
      if (!def) return s;
      if (v === null) {
        if (s.locks) delete s.locks[p];
        if (s.locks && !Object.keys(s.locks).length) delete s.locks;
      } else (s.locks ??= {})[p] = clamp(Math.round(v), 0, def.max);
      return s;
    }, 'STEP LOCK');
  }

  setStepAlt(alt: StepSound['alt'] | null): void {
    this.editStepSound((s) => {
      if (alt) s.alt = clone(alt);
      else delete s.alt;
      return s;
    }, 'STEP CONDITION');
  }

  addStepRule(rule: import('../model/types').ParamRule): void {
    this.editStepSound((s, t) => {
      if (lockableParam(s.voice ?? t.sound.trigger, rule.p)) s.rules = [...(s.rules ?? []), clone(rule)].slice(0, 8);
      return s;
    }, 'STEP RULE');
  }

  setStepRule(i: number, rule: import('../model/types').ParamRule | null): void {
    this.editStepSound((s) => {
      const rules = [...(s.rules ?? [])];
      if (rule) rules[i] = clone(rule);
      else rules.splice(i, 1);
      if (rules.length) s.rules = rules;
      else delete s.rules;
      return s;
    }, 'STEP RULE');
  }

  /** CLEAR LOCKS: the locks and rules go; the variation, condition and voice stay. */
  clearStepLocks(): void {
    this.editStepSound((s) => {
      delete s.locks;
      delete s.rules;
      return s;
    }, 'CLEAR STEP LOCKS');
  }

  clearStepSounds(targets = this.soundTargets()): void {
    this.editStepSound(() => undefined, 'CLEAR STEP SOUND', targets);
  }

  copyStepSound(): void {
    const c = this.soundTargets()[0];
    if (!c) return;
    const s = this.stepSound(c.track, c.step);
    this.soundClip = s ? clone(s) : null;
    this.say(s ? 'STEP SOUND COPIED' : 'THAT STEP HAS NO SOUND CHANGES: PASTE WILL CLEAR');
  }

  pasteStepSound(): void {
    const clip = this.soundClip;
    this.editStepSound((_, t) => (clip ? this.fitToVoice(clone(clip), t) : undefined), 'PASTE STEP SOUND');
  }

  /** Describe a step's sound for tooltips and the grid key. */
  describeStepSound(trackId: string, step: number): string {
    const s = this.stepSound(trackId, step);
    const t = this.project.tracks.find((x) => x.id === trackId);
    return s && t ? describeStepSound(t.sound, s) : '';
  }

  soundCount(): number {
    return soundCount(this.pattern);
  }

  /**
   * Hear a step with its resolved sound (the pass chosen in the editor), or with the track's
   * base sound for comparison. Goes through the same resolver the sequencer uses.
   */
  async auditionStep(trackId: string, step: number, base = false): Promise<void> {
    if (this.host.state !== 'running') {
      try {
        await this.host.start();
        configureEngine(this.live, this.project, this.library);
      } catch {
        return;
      }
    }
    const i = this.trackIndexOf(trackId);
    const t = this.project.tracks[i];
    if (!t) return;
    const hit = this.hitAt(trackId, step);
    const ss = base ? undefined : this.stepSound(trackId, step);
    const rs = ss ? resolveStepSound(t.sound, ss, (par) => this.project.kit.synth.params[par] ?? 0, { seed: this.project.seed, cycle: Math.max(0, this.ui.previewPass - 1), fill: this.ui.fills.has(trackId), track: trackId, step }) : null;
    this.host.send({
      type: 'hits',
      hits: [{ time: this.host.now + 0.01, track: i, vel: hit?.vel ?? 110, pitch: hit?.note ?? 0, ...(rs?.switched ? { trig: rs.trig } : {}), ...(rs?.params.length ? { sp: rs.params } : {}), ...(rs?.sample ? { smp: rs.sample } : {}) }],
    });
  }

  // ------------------------------------------------------------------ GENERATIVE SOUND
  /** The tracks (and steps) the sound generators work on: the selection, else every track. */
  soundScope(): { tracks: Track[]; region?: [number, number] } {
    const s = this.ui.sel;
    if (!s) return { tracks: this.project.tracks };
    const a = Math.min(s.t0, s.t1);
    const b = Math.max(s.t0, s.t1);
    return { tracks: this.project.tracks.slice(a, b + 1), region: [Math.min(s.s0, s.s1), Math.max(s.s0, s.s1)] };
  }

  setTimbre(amount: number): void {
    this.history.begin('TIMBRE');
    this.project.timbre.amount = clamp(amount, 0, 1);
    this.history.commit();
    this.autosave();
    this.emit(['gen', 'history']);
  }

  private geometry() {
    const p = this.pattern;
    return { steps: p.steps, perBeat: p.res, perBar: p.res * 4 };
  }

  private newSoundSeed(): number {
    const seed = randomSeed();
    this.project.timbre.seed = seed;
    return seed;
  }

  /** GENERATE VARIATIONS: fill the free slots A-D of the tracks in scope with related timbres. */
  generateVariationsFor(tracks = this.soundScope().tracks, force = false): void {
    const seed = randomSeed();
    this.change(
      'GENERATE VARIATIONS',
      () => {
        let n = 0;
        for (const t of tracks) {
          const next = generateVariations(t.sound, t.role, this.project.kit.synth.params, { seed, amount: this.project.timbre.amount, locks: this.project.soundLocks, force });
          const before = JSON.stringify(t.sound.variations ?? null);
          t.sound.variations = next;
          this.tidyVariations(t);
          if (JSON.stringify(t.sound.variations ?? null) !== before) n++;
        }
        this.syncTracks();
        this.say(n ? `VARIATIONS FOR ${n} TRACK${n > 1 ? 'S' : ''} · TIMBRE ${Math.round(this.project.timbre.amount * 100)}%` : 'NO FREE SLOTS (LOCKED OR HAND-MADE)');
      },
      ['tracks', 'kit'],
    );
  }

  /** DISTRIBUTE: assign the variations to the steps of the tracks in scope, by role. */
  distributeVariations(): void {
    const { tracks, region } = this.soundScope();
    this.change('DISTRIBUTE VARIATIONS', () => this.writeSounds('DISTRIBUTE', tracks, region, (t, grid, cur, o) => distributeSounds(t.sound, t.role, grid, cur, this.project.kit.synth.params, o)), ['pattern']);
  }

  /** MUTATE SOUND: redraw a share of the generated step sounds; hand-made ones and the rhythm stay. */
  mutateSound(amount = 0.3, quantise = false): void {
    if (quantise && this.ui.playing) return this.atBoundary('MUTATE SOUND', () => this.mutateSound(amount));
    const { tracks, region } = this.soundScope();
    this.change('MUTATE SOUND', () => this.writeSounds('MUTATE SOUND', tracks, region, (t, grid, cur, o) => mutateSounds(t.sound, t.role, grid, cur, this.project.kit.synth.params, { ...o, amount })), ['pattern']);
  }

  /** GENERATE SOUND: variations for the free slots, then their distribution (one undo step). */
  generateSound(quantise = false): void {
    if (quantise && this.ui.playing) return this.atBoundary('GENERATE SOUND', () => this.generateSound());
    this.history.begin('GENERATE SOUND');
    this.generateVariationsFor(undefined, false);
    this.distributeVariations();
    this.history.commit();
    this.emit(['history']);
  }

  /** MUTATE BOTH: the rhythm and the sound in one undo step. */
  mutateBoth(): void {
    this.history.begin('MUTATE BOTH');
    this.mutate();
    this.mutateSound(0.3);
    this.history.commit();
    this.emit(['history']);
  }

  private writeSounds(label: string, tracks: Track[], region: [number, number] | undefined, fn: (t: Track, grid: import('../model/types').Grid, cur: Record<number, StepSound> | undefined, o: import('../sound/soundgen').DistributeOptions) => Record<number, StepSound>): void {
    const seed = this.newSoundSeed();
    const p = this.pattern;
    let steps = 0;
    for (const t of tracks) {
      const next = fn(t, sourceGrid(p, t.id), p.sounds?.[t.id], { seed, take: 0, amount: this.project.timbre.amount, locks: this.project.soundLocks, region, ...this.geometry() });
      setSounds(p, t.id, next);
      steps += Object.keys(next).length;
    }
    this.say(`${label} · TIMBRE ${Math.round(this.project.timbre.amount * 100)}% · ${steps} STEP SOUNDS`);
  }

  /** EVOLVE SOUND: bounded glides on a few parameters of the tracks in scope. */
  addSoundEvolution(passes = 8): void {
    const { tracks } = this.soundScope();
    this.change(
      'EVOLVE SOUND',
      () => {
        for (const t of tracks) setSounds(this.pattern, t.id, addEvolution(t.sound, t.role, sourceGrid(this.pattern, t.id), this.pattern.sounds?.[t.id], { amount: Math.max(0.1, this.project.timbre.amount), passes, locks: this.project.soundLocks }));
        this.say(`SOUND EVOLUTION OVER ${passes} PASSES · IT RETURNS TO THE BASE SOUND`);
      },
      ['pattern'],
    );
  }

  clearSoundEvolution(): void {
    const { tracks } = this.soundScope();
    this.change('CLEAR EVOLUTION', () => tracks.forEach((t) => setSounds(this.pattern, t.id, clearEvolution(this.pattern.sounds?.[t.id]))), ['pattern']);
  }

  /** RESET SOUND: remove the generated step sounds (and, with all, the hand-made ones) in scope. */
  clearSoundsInScope(all = false): void {
    const { tracks, region } = this.soundScope();
    this.change(
      all ? 'CLEAR ALL STEP SOUNDS' : 'RESET GENERATED SOUNDS',
      () => {
        for (const t of tracks) {
          const cur = this.pattern.sounds?.[t.id] ?? {};
          const keep: Record<number, StepSound> = {};
          for (const [k, ss] of Object.entries(cur)) {
            const inside = !region || (Number(k) >= region[0] && Number(k) <= region[1]);
            if (!inside || (!all && handMade(ss))) keep[Number(k)] = ss;
          }
          setSounds(this.pattern, t.id, keep);
        }
      },
      ['pattern'],
    );
  }

  /** RESET VARIATIONS: remove the generated variations of the tracks in scope (hand-made and locked stay). */
  resetGeneratedVariations(): void {
    const { tracks } = this.soundScope();
    this.change('RESET VARIATIONS', () => {
      for (const t of tracks) {
        if (t.sound.soundLock || !t.sound.variations) continue;
        t.sound.variations = t.sound.variations.map((v, i) => (v && slotWritable(t.sound, i) && v.gen ? null : v));
        this.tidyVariations(t);
      }
      this.syncTracks();
    }, ['tracks', 'kit', 'pattern']);
  }

  /** Randomise or mutate the variation being edited (a new take of its recipe, or a nudge of its values). */
  randomizeVariation(trackId: string, slot: number, amount: number): void {
    const t = this.project.tracks.find((x) => x.id === trackId);
    if (!t) return;
    const seed = randomSeed();
    this.change(
      'RANDOMISE VARIATION',
      () => {
        const only: (Variation | null)[] = generateVariations({ ...t.sound, variations: undefined }, t.role, this.project.kit.synth.params, { seed, amount, locks: this.project.soundLocks, force: true });
        const fresh = only[slot];
        if (fresh) this.ensureVariations(t)[slot] = { ...fresh, lock: t.sound.variations?.[slot]?.lock };
        this.syncTracks();
      },
      ['tracks', 'kit'],
    );
  }

  mutateVariation(trackId: string, slot: number, amount: number): void {
    const t = this.project.tracks.find((x) => x.id === trackId);
    const v = t?.sound.variations?.[slot];
    if (!t || !v) return;
    const rng = new Rng(randomSeed());
    this.change(
      'MUTATE VARIATION',
      () => {
        for (const [k, val] of Object.entries(v.params)) {
          const def = lockableParam(t.sound.trigger, Number(k));
          if (!def || this.project.soundLocks.params.includes(Number(k))) continue;
          v.params[Number(k)] = clamp(Math.round(val + rng.bell() * 40 * amount * (def.kind === 'menu' ? 0 : 1)), 0, def.max);
        }
        delete v.gen;
      },
      ['kit'],
    );
  }

  // ------------------------------------------------------------------ samples
  async importSamples(files: File[], assignTo?: string): Promise<void> {
    let last: string | null = null;
    let failed = 0;
    for (const f of files) {
      try {
        const s = await this.library.importFile(f);
        last = s.id;
      } catch {
        failed++;
      }
    }
    if (last && assignTo) this.assignSample(assignTo, last, false);
    this.say(failed ? `${failed} FILE(S) COULD NOT BE READ` : `${files.length} SAMPLE(S) IMPORTED`);
  }

  /** Put a sample on a track (replace, or add for per-hit selection). A track becomes SAMPLE or HYBRID. */
  assignSample(trackId: string, sampleId: string, add: boolean): void {
    const t = this.project.tracks.find((x) => x.id === trackId);
    const s = this.library.get(sampleId);
    if (!t || !s) return;
    this.change(
      'ASSIGN SAMPLE',
      () => {
        t.sound.samples = add ? [...new Set([...t.sound.samples, sampleId])] : [sampleId];
        if (t.sound.mode === 'synth') t.sound.mode = 'sample';
      },
      ['tracks'],
    );
    this.syncTracks();
  }

  removeSample(trackId: string, sampleId: string): void {
    const t = this.project.tracks.find((x) => x.id === trackId);
    if (!t) return;
    this.change('REMOVE SAMPLE', () => (t.sound.samples = t.sound.samples.filter((x) => x !== sampleId)), ['tracks']);
    this.syncTracks();
  }

  /** Preview a library sample on its own. */
  async previewSample(id: string): Promise<void> {
    const s = this.library.get(id);
    if (!s) return;
    try {
      await this.host.start();
    } catch {
      return;
    }
    const ctx = this.host.ctx!;
    const buf = ctx.createBuffer(s.channels.length, s.channels[0]!.length, s.rate);
    s.channels.forEach((c, i) => buf.copyToChannel(c as Float32Array<ArrayBuffer>, i));
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = 0.7;
    src.connect(g).connect(ctx.destination);
    src.start();
  }

  // ------------------------------------------------------------------ MIDI input
  private midiNote(_ch: number, note: number, vel: number): void {
    const p = this.project;
    let i = p.tracks.findIndex((t) => t.midi.note === note);
    if (i < 0) i = (note - 36 + 120) % p.tracks.length;
    const t = p.tracks[i]!;
    this.host.send({ type: 'hits', hits: [{ time: this.host.now, track: i, vel, pitch: 0 }] });
    if (this.ui.record && this.ui.playing) {
      const pos = this.playhead();
      if (pos && pos.pattern === this.pattern.id) {
        const step = Math.round(pos.step) % this.pattern.steps;
        setHit(this.pattern, t.id, step, { vel });
        this.touch(['pattern']);
      }
    }
  }

  // ------------------------------------------------------------------ projects
  async loadPreset(id: string, undoable = true): Promise<void> {
    const spec = PRESETS.find((p) => p.id === id);
    if (!spec || !this.initKit) return;
    const proj = buildPreset(spec, this.initKit);
    resolveBundled(proj, this.bundledId);
    if (this.kits) {
      proj.kit.synth = await this.kits.check(proj.kit.synth, { flavour: spec.flavour, voiceRoles: voiceRolesOf(proj.tracks), seed: spec.kitSeed, locked: proj.soundLocks.voices });
    }
    if (undoable) this.history.push(`PRESET ${spec.name}`);
    const wasPlaying = this.ui.playing;
    const snaps = this.project.snapshots;
    this.project = proj;
    if (!undoable) this.project.snapshots = snaps.map(() => null);
    this.afterLoad(!undoable);
    if (wasPlaying) this.scheduler.setTempo(proj.tempo);
    this.say(`PRESET ${spec.name}: ${spec.description}`);
  }

  newProject(): void {
    if (!this.initKit) return;
    this.history.push('NEW PROJECT');
    const p = defaultProject();
    p.kit = { name: 'INIT', seed: 0, synth: clone(this.initKit) };
    p.patterns[0]!.seed = randomSeed();
    p.patterns[0]!.gen = generate(p.tracks, p.gen, p.patterns[0]!.seed, { steps: p.patterns[0]!.steps, res: 4 });
    this.project = p;
    this.afterLoad(false);
    this.say('NEW PROJECT WITH THE LXR INIT KIT');
  }

  setProjectName(name: string): void {
    this.change('RENAME PROJECT', () => (this.project.name = name.toUpperCase().slice(0, 40) || 'UNTITLED'), ['project']);
  }

  projectFile(): { name: string; data: Uint8Array; type: string } {
    return { name: fileName([this.project.name], PROJECT_EXT.slice(1)), data: new TextEncoder().encode(serialize(this.project)), type: 'application/json' };
  }

  bundleFile(): { name: string; data: Uint8Array; type: string } {
    const text = serialize(this.project);
    const data = writeBundle('clatter', { name: 'project' + PROJECT_EXT, text }, this.library.stored(projectSamples(this.project)));
    return { name: fileName([this.project.name], BUNDLE_EXT.slice(1)), data, type: 'application/zip' };
  }

  async openFile(file: File): Promise<void> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let text: string;
    if (/\.zip$/i.test(file.name)) {
      if (/clatterkit/i.test(file.name)) return this.importKit(bytes);
      const b = await readBundle(bytes, 'clatter');
      for (const s of b.samples) await this.library.add(s.bytes, s.name, { type: s.type });
      text = b.projectText;
      if (b.problems.length) this.say(`${b.problems.length} SAMPLE(S) MISSING`);
    } else text = new TextDecoder().decode(bytes);
    const p = parseProject(text, this.initKit ?? undefined);
    await this.library.restore(projectSamples(p));
    this.history.push('OPEN PROJECT');
    this.project = p;
    this.afterLoad(false);
    this.say(`OPENED ${p.name}`);
  }

  // ------------------------------------------------------------------ kits
  kitFile(): { name: string; data: Uint8Array; type: string } {
    const kit = kitOf(this.project);
    const ids = Object.values(kit.sounds).flatMap((s) => soundSampleIds(s));
    return { name: fileName([kit.name], KIT_EXT.slice(1)), data: writeKitFile(kit, this.library.stored(ids)), type: 'application/zip' };
  }

  async importKit(bytes: Uint8Array): Promise<void> {
    const r = await readKitFile(bytes);
    for (const s of r.samples) await this.library.add(s.bytes, s.name);
    this.change(
      'LOAD KIT',
      () => {
        this.applyKitChange(r.kit.synth);
        this.project.kit.name = r.kit.name;
        this.project.kit.seed = r.kit.seed;
        for (const t of this.project.tracks) {
          const s = r.kit.sounds[t.role];
          if (s) {
            const vars = (Array.isArray(s.variations) ? s.variations : []).slice(0, VARIATION_SLOTS).map((v) => repairVariation(v));
            const keep = (ids?: string[]) => (ids ?? []).filter((id) => this.library.get(id));
            for (const v of vars) if (v?.sample?.samples) v.sample.samples = keep(v.sample.samples);
            t.sound = { ...defaultSound(), ...s, samples: keep(s.samples), variations: vars.some(Boolean) ? vars : undefined };
            if (!t.sound.variations) delete t.sound.variations;
          }
        }
      },
      ['kit', 'tracks'],
    );
    this.syncTracks();
    this.say(`KIT ${r.kit.name} LOADED`);
  }

  setKitName(name: string): void {
    this.change('RENAME KIT', () => (this.project.kit.name = name.toUpperCase().slice(0, 24) || 'KIT'), ['kit']);
  }

  // ------------------------------------------------------------------ export
  private async render(stems: boolean, bars: number, tail: number, onProgress?: (f: number) => void) {
    if (!this.module) throw new Error('engine not loaded');
    const p = this.project;
    // sound evolution in the export: the same deterministic steps as playback
    const ev = p.evolve;
    let kit = clone(p.kit.synth);
    const home = clone(p.kit.synth);
    let step = 0;
    const kitAtBar = ev.target === 'sound' || ev.target === 'both' ? (bar: number) => (bar > 0 && bar % ev.every === 0 ? (kit = evolveKit(kit, home, { ...this.kitOpts(hash32(p.kit.seed, ++step)), amount: ev.amount })) : null) : undefined;
    return renderProject(this.module, p, this.library, { bars, tail, stems, kitAtBar, onProgress, yieldEvery: 64 });
  }

  async exportMaster(bars: number, tail: number, onProgress?: (f: number) => void): Promise<{ name: string; data: Uint8Array; type: string }> {
    const r = await this.render(false, bars, tail, onProgress);
    return { name: fileName([this.project.name, `${this.project.tempo}bpm`], 'wav'), data: await encodeWav16(r.master, r.rate), type: 'audio/wav' };
  }

  async exportStems(bars: number, tail: number, onProgress?: (f: number) => void): Promise<{ name: string; data: Uint8Array; type: string }> {
    const r = await this.render(true, bars, tail, onProgress);
    const entries = [{ name: `00-master.wav`, data: await encodeWav16(r.master, r.rate) }];
    let i = 1;
    for (const t of this.project.tracks) {
      const s = r.stems[t.id];
      if (!s) continue;
      entries.push({ name: `${String(i++).padStart(2, '0')}-${slug(t.name)}.wav`, data: await encodeWav16(s, r.rate) });
    }
    if (r.fx) entries.push({ name: `${String(i).padStart(2, '0')}-fx-bus.wav`, data: await encodeWav16(r.fx, r.rate) });
    return { name: fileName([this.project.name, 'stems'], 'zip'), data: createZip(entries), type: 'application/zip' };
  }

  exportMidiFile(bars: number): { name: string; data: Uint8Array; type: string } {
    return { name: fileName([this.project.name], 'mid'), data: exportMidi(this.project, { bars }), type: 'audio/midi' };
  }

  /** DRUM HITS: every track's sound rendered as a one-shot WAV. */
  async exportHits(): Promise<{ name: string; data: Uint8Array; type: string }> {
    if (!this.module) throw new Error('engine not loaded');
    const entries: { name: string; data: Uint8Array }[] = [];
    let i = 1;
    for (const t of this.project.tracks) {
      const audio = await renderHit(this.module, this.project, this.library, t.id);
      entries.push({ name: `${String(i++).padStart(2, '0')}-${slug(t.name)}-${t.sound.mode}.wav`, data: await encodeWav16(audio, ENGINE_RATE) });
    }
    return { name: fileName([this.project.kit.name, 'hits'], 'zip'), data: createZip(entries), type: 'application/zip' };
  }

  async exportHit(trackId: string): Promise<{ name: string; data: Uint8Array; type: string }> {
    if (!this.module) throw new Error('engine not loaded');
    const t = this.project.tracks.find((x) => x.id === trackId)!;
    const audio = await renderHit(this.module, this.project, this.library, trackId);
    return { name: fileName([this.project.kit.name, t.name], 'wav'), data: await encodeWav16(audio, ENGINE_RATE), type: 'audio/wav' };
  }

  // ------------------------------------------------------------------ view
  setView(v: Prefs['view']): void {
    this.ui.view = v;
    this.prefs.view = v;
    savePrefs(this.prefs);
    this.emit(['view']);
  }

  /** Open a tab of the workspace under the pattern grid. */
  setWorkspace(w: Workspace): void {
    this.ui.workspace = w;
    this.prefs.workspace = w;
    savePrefs(this.prefs);
    this.emit(['workspace']);
  }

  /** The interface scale (VIEW menu): applied at once and kept in the preferences. */
  setUiScale(v: number): void {
    this.prefs.uiScale = setScale(v);
    savePrefs(this.prefs);
  }

  setEditMode(m: Prefs['editMode']): void {
    this.ui.editMode = m;
    this.prefs.editMode = m;
    savePrefs(this.prefs);
    this.emit(['kit', 'view']);
  }

  /** The first PAR of the FX bus routing: the firmware's PAR numbers used by views. */
  static readonly PAR = PAR;
}

/** Drop default fields from a hit. */
function cleanHit(h: Hit | null): Hit | null {
  if (!h) return null;
  const o: Hit = { vel: clamp(Math.round(h.vel), 1, 127) };
  if (h.prob !== undefined && h.prob < 100) o.prob = clamp(Math.round(h.prob), 0, 100);
  if (h.note) o.note = clamp(Math.round(h.note), -24, 24);
  if (h.flam) o.flam = true;
  if (h.ratchet && h.ratchet > 1) o.ratchet = clamp(Math.round(h.ratchet), 2, 4);
  if (h.sample) o.sample = h.sample;
  return o;
}

export { cleanHit, sendKit };
