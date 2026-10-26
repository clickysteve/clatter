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
import { readBundle, writeBundle, type SampleStore } from '@slopfactory/core/storage';
import { AudioHost, lxrWasm } from '../audio/host';
import { SampleLibrary } from '../audio/library';
import { renderHit, renderProject } from '../audio/render';
import type { MetersMessage, TimedHit } from '../audio/protocol';
import { ENGINE_RATE } from '../audio/engine';
import { defaultProject } from '../model/defaults';
import { BUNDLE_EXT, parseProject, projectSamples, PROJECT_EXT, serialize } from '../model/project';
import { buildPreset, PRESETS, resolveBundled } from '../model/presets';
import { describeStepSound, isEmptyStepSound, lockableParam, resolveStepSound, soundSampleIds } from '../sound/stepSound';
import { addEvolution, clearEvolution, distributeSounds, generateVariations, handMade, mutateSounds, slotWritable } from '../sound/soundgen';
import { voiceKeys } from '../sound/kitgen';
import { clamp, clone, PPQ, MAX_PATTERNS, VARIATION_SLOTS, MAX_STEPS, stepTicks, type StepSound, type Variation, type DestructionSettings, type GenSettings, type Hit, type Pattern, type Project, type Quantize, type Resolution, type SynthKit, type Track, type TrackMix, type TrackPlay, type TrackSound } from '../model/types';
import { MidiController } from '../midi/controller';
import { PhaseLock } from '../midi/clock';
import { noteLength } from '../midi/router';
import { defaultCcSlots, type ClockMode } from '../midi/settings';
import type { LearnTarget } from '../midi/input';
import { generate, stepsPerBar } from '../rhythm/generate';
import { mutate, summariseOps } from '../rhythm/mutate';
import { clearTrack, commitEdits, copyRegion, editCount, newPattern, pasteRegion, setHit, setLength, setResolution, setSounds, setStepSound, setStepTrig, setTrigs, trigAt, shiftTrack, soundCount, sourceGrid, stepSoundAt, type Clip } from '../rhythm/pattern';
import { hash32, randomSeed, Rng } from '../rhythm/rng';
import { styleById } from '../rhythm/styles';
import type { Realization } from '../rhythm/realize';
import { applyWildcard, repairWild, SCOPE_LABEL, type WildSettings } from '../destruction/wildcardProject';
import type { TrigCond } from '../model/types';
import { bpmAt, tempoActive, type TempoAuto } from '../transport/tempo';
import { ExportRunner, type ExportFile, type ExportKind } from './exportJob';
import { describeChop } from '../destruction/chop';
import { describeRolls } from '../destruction/rolls';
import { describeDestroy } from '../destruction/destroy';
import { evolveKit, generateKit, mutateKit, resolveProfiles, voiceRolesOf } from '../sound/kitgen';
import { CHARACTER_DEFS, defaultKitGen, PROFILE_LABEL, type Profile } from '../sound/profiles';
import type { Character, KitGenSettings } from '../model/types';
import { KitService } from '../sound/kitService';
import { KitManager } from './kitManager';
import { exportMidi } from '../export/midiFile';
import { Sequence } from './sequence';
import { anySolo, configureEngine, engineTrackOf, hitOf, kitDiff, masterChain, outputOf, sendKit, trackIndex, type EngineTarget } from './soundConfig';
import { defaultRoute, defaultSource, diffMod, isSource, newRouteId, resolveMod } from '../mod/config';
import { destApplies, destsFor } from '../mod/registry';
import { buildRecipe, fitMod, generateMod, mutateMod, randomiseSource, type ModTarget } from '../mod/presets';
import { ModLibrary } from '../mod/library';
import { typeOfSource, type ModRoute, type SourceDef, type SourceId, type TrackMod } from '../mod/types';
import { defaultChannelFx, defaultOutputFx, type ChannelFx, type OutputFx } from '../audio/mixfx';
import { History } from './history';
import { loadPrefs, savePrefs, type Prefs, type SoundTab, type Workspace } from './prefs';
import { setScale } from '../ui/scale';
import { Scheduler, startTicker } from '../transport/scheduler';
import { PAR } from '../sound/lxrParamIds';

export type Topic = 'project' | 'pattern' | 'tracks' | 'kit' | 'mix' | 'transport' | 'destruction' | 'gen' | 'library' | 'kits' | 'midi' | 'status' | 'snapshots' | 'view' | 'workspace' | 'selection' | 'history' | 'master' | 'mod' | 'notice';

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
  /** the latest message the user must see (export finished or failed) */
  notice: { id: number; text: string; level: 'info' | 'error' } | null;
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
  /** the modulation source the MODULATION editor shows */
  modSel: SourceId;
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
  /** background export (one at a time) */
  readonly exporter: ExportRunner;
  /** hands a finished export to the user (the browser download; set by the page) */
  deliver: (file: ExportFile) => void = () => undefined;
  kits: KitService | null = null;
  /** the synth kit, sample set and full kit libraries (after boot) */
  kitm: KitManager | null = null;
  private audioStore: SampleStore | null = null;
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
  /** the user's modulation presets */
  readonly modLibrary: ModLibrary;
  /** the seed of the next generated modulation (each press differs, a press is reproducible from its seed) */
  modSeed = 1;
  /** EXTERNAL clock: the tempo CLATTER runs at (measured, phase-corrected); null when not following */
  extBpm: number | null = null;
  private phase = new PhaseLock();
  /** EXTERNAL clock: Start/Continue received, playback begins on the next pulse (tick of that pulse) */
  private extArm: number | null = null;
  /** where Continue resumes (ticks; 0 = the top) */
  resumeTick = 0;

  constructor(opts: { trackCount?: number } = {}) {
    this.prefs = loadPrefs();
    this.modLibrary = new ModLibrary(typeof localStorage !== 'undefined' ? localStorage : null);
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
      notice: null,
      paintVel: 100,
      cursor: null,
      showOriginal: false,
      soundTab: this.prefs.soundTab,
      slot: null,
      previewPass: 1,
      modSel: 'lfo1',
    };
    this.host = new AudioHost(opts.trackCount ?? 12, 1);
    this.audioStore = KitManager.audioStore();
    this.library = new SampleLibrary(this.audioStore);
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
      clock: (times) => this.midi.clockOut(times.map((t) => this.host.perfTimeOf(t))),
      onBar: (bar, time) => this.onBar(bar, time),
      onCycle: () => this.emit(['transport']),
      // an external clock takes precedence: the tempo curve is suspended while CLATTER follows it
      tempo: (tick) => (!this.externalTempo && tempoActive(this.project.tempoAuto) ? bpmAt(this.project.tempo, this.project.tempoAuto, tick) : null),
      onTempo: (bpm) => {
        this.live.setBpm(bpm);
        this.midi.cc.setBpm(bpm);
      },
      startDelay: 0.08,
    });
    this.midi = new MidiController(
      {
        trigger: (track, vel) => this.midiNote(track, vel),
        macro: (i, v) => this.setMacro(i, v),
        trackCount: () => this.project.tracks.length,
        extStart: (pulse) => this.extStart(pulse),
        extStop: () => this.stop(true),
        extPulse: (n, ms) => this.extPulse(n, ms),
        extTempo: (bpm) => this.extTempo(bpm),
        extLost: () => this.emit(['transport', 'midi']),
        changed: () => {
          this.prefs.midi = this.midi.prefs;
          savePrefs(this.prefs);
          this.emit(['midi']);
        },
        message: (t) => this.say(t),
      },
      this.prefs.midi,
    );
    this.prefs.midi = this.midi.prefs;
    // the clock follower notices a master that went away, also while stopped
    if (typeof window !== 'undefined') setInterval(() => this.midi.clock.watch(), 200);
    this.exporter = new ExportRunner({
      render: (kind, bars, tail, onProgress) => (kind === 'master' ? this.exportMaster(bars, tail, onProgress) : kind === 'stems' ? this.exportStems(bars, tail, onProgress) : this.exportMidiFile(bars)),
      deliver: (f) => this.deliver(f),
      notify: (text, level) => this.notify(text, level),
      status: (t) => this.say(t),
    });
    this.exporter.onChange = () => this.emit(['transport']);
    const host = this.host;
    this.live = {
      setTrack: (i, t) => host.send({ type: 'track', index: i, track: t }),
      setParams: (values, time) => host.send({ type: 'params', values, time }),
      setModTarget: (kind, voice, param) => host.send({ type: 'modTarget', kind, voice, param }),
      setBpm: (bpm) => host.send({ type: 'bpm', bpm }),
      setMaster: (volume, clip, chain) => host.send({ type: 'master', volume, clip, chain }),
      setMacros: (values) => host.send({ type: 'macros', values }),
      setOutput: (out) => host.send({ type: 'output', out }),
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

  /** A message the user must see: the status line, and a notice the page shows until it is dismissed. */
  notify(text: string, level: 'info' | 'error' = 'info'): void {
    this.ui.notice = { id: (this.ui.notice?.id ?? 0) + 1, text, level };
    this.ui.status = text;
    this.emit(['status', 'notice']);
  }

  /** EXPORT: validate, start, and return at once; the render continues in the background. */
  startExport(kind: ExportKind, bars: unknown, tail: unknown): ReturnType<ExportRunner['start']> {
    return this.exporter.start(kind, bars, tail);
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
    this.kitm = await KitManager.create(this, this.audioStore!);
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
    else {
      this.afterLoad(true);
      this.kitm.projectReplaced();
    }
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
    this.scheduler.setTempo(this.baseTempo());
    this.scheduler.retempo();
    this.live.setBpm(this.effectiveBpm());
    this.touch(['project', 'pattern', 'tracks', 'kit', 'mix', 'gen', 'destruction', 'transport', 'snapshots', 'master', 'history']);
  }

  /** State changed: replan, autosave, redraw. */
  private touch(topics: Topic[]): void {
    this.configureCc();
    this.sequence.bump();
    this.scheduler.invalidate();
    this.autosave();
    this.emit([...topics, 'history']);
  }

  private autosave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), 800);
  }

  /** On closing the page: write a change that is still waiting for its autosave. */
  flushSave(): void {
    if (this.saveTimer) this.saveNow();
  }

  /** Write the autosave now. */
  saveNow(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    try {
      localStorage.setItem(AUTOSAVE_KEY, serialize(this.project));
    } catch {
      /* storage full or blocked */
    }
  }

  /** An undoable change made by the kit libraries (a load is one undo step). */
  edit(label: string, fn: () => void, topics: Topic[]): void {
    this.change(label, fn, topics);
  }

  /** The project names the sample set it uses (shown on the SAMPLE tab; not an undo step). */
  setSampleSetName(name: string): void {
    if (name) this.project.sampleSet = name;
    else delete this.project.sampleSet;
    this.autosave();
    this.emit(['kits', 'project']);
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
    // stopped: the pass chosen on the TRIGGER tab (1 = the first), as if the pattern had just been repeated that often
    return this.sequence.realization(Math.max(0, this.ui.previewPass - 1), this.pattern.id, true);
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
  /**
   * Play from the top, or from `fromTick` (Continue, or joining an external clock), with the
   * first tick at `at` (AudioContext time; default a moment from now).
   */
  async play(fromTick = 0, at?: number): Promise<void> {
    if (this.ui.playing) return;
    try {
      await this.host.start();
    } catch {
      this.say(`AUDIO FAILED: ${this.host.error}`);
      return;
    }
    if (this.ui.playing) return;
    configureEngine(this.live, this.project, this.library);
    this.sequence.reset();
    this.sequence.bump();
    this.scheduler.setTempo(this.baseTempo());
    const t0 = Math.max(at ?? 0, this.host.now + 0.05);
    this.scheduler.start(t0, fromTick);
    this.live.setBpm(this.scheduler.currentBpm);
    this.configureCc();
    this.midi.cc.reset(t0);
    this.midi.start(this.host.perfTimeOf(t0), Math.round(fromTick / (PPQ / 24)));
    this.ui.playing = true;
    this.resumeTick = 0;
    this.evolveStep = 0;
    this.evolveHome = clone(this.project.kit.synth);
    this.stopTicker = startTicker(() => {
      this.scheduler.pump();
      this.runCc();
    });
    this.say(fromTick > 0 ? 'CONTINUE' : 'PLAYING');
    this.emit(['transport']);
  }

  /** Stop. With `pause` the position is kept for CONTINUE (and the MIDI Song Position says where). */
  stop(pause = false): void {
    this.extArm = null;
    if (!this.ui.playing) return;
    const pos = Math.max(0, this.scheduler.tickAt(this.host.now - this.host.latency));
    this.stopTicker?.();
    this.stopTicker = null;
    this.scheduler.stop();
    this.host.send({ type: 'cancel', time: this.host.now });
    this.midi.stop(pause);
    this.ui.playing = false;
    // resume on a sixteenth (what a Song Position Pointer can say)
    this.resumeTick = pause ? Math.floor(pos / (PPQ / 4)) * (PPQ / 4) : 0;
    this.live.setBpm(this.effectiveBpm());
    this.ui.queued = null;
    this.say(pause ? 'PAUSED: CONTINUE PLAYS ON FROM HERE' : 'STOPPED');
    this.emit(['transport']);
  }

  togglePlay(): void {
    if (this.ui.playing) this.stop();
    else void this.play();
  }

  /** PAUSE / CONTINUE (MIDI Stop, then Song Position and Continue). */
  togglePause(): void {
    if (this.ui.playing) this.stop(true);
    else void this.play(this.resumeTick);
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
    const solo = anySolo(p);
    const stepMs = this.scheduler.spt * (PPQ / 4) * 1000;
    for (const se of evs) {
      const h = hitOf(se, p, idx, this.scheduler.spt, this.ui.fills);
      if (!h) continue;
      const t = p.tracks[h.track]!;
      const route = t.midi.out ?? 'both';
      // INTERNAL and BOTH play the engine (its SYNTH, SAMPLE or HYBRID source); MIDI and BOTH send the note
      if (route !== 'midi') hits.push(h);
      this.midi.cc.hit(h.track, se.time, h.vel, h.tb, h.tp);
      const audible = !t.mix.mute && (!solo || t.mix.solo);
      if (audible && route !== 'internal') this.midi.note(h.track, t.midi.channel, t.midi.note, h.vel, this.host.perfTimeOf(se.time), noteLength(t.midi.len, h.gate ? (h.gate / ENGINE_RATE) * 1000 : undefined, stepMs));
    }
    if (hits.length) this.host.send({ type: 'hits', hits });
  }

  /** MIDI CC out: which tracks drive a CC destination (call when modulation or tracks change). */
  private configureCc(): void {
    this.midi.cc.configure(this.project.tracks.map((t) => t.sound.mod), this.effectiveBpm());
  }

  /** The CC destinations, up to the scheduler's lookahead (from the ticker, never the audio thread). */
  private runCc(): void {
    if (!this.midi.cc.active) return;
    const slots = this.project.midiCc ?? defaultCcSlots();
    const macros = Float32Array.from(this.project.macros ?? [0, 0, 0, 0]);
    this.midi.cc.run(this.host.now + this.scheduler.lookahead, slots, macros, (slot, cfg, v, t) => this.midi.sendCc(slot, cfg, v, this.host.perfTimeOf(t)));
  }

  // ------------------------------------------------------------------ MIDI clock
  /** CLATTER follows an external clock's tempo now (the internal tempo and its curve are suspended). */
  get externalTempo(): boolean {
    return this.midi.prefs.clock === 'external' && this.extBpm !== null;
  }

  /** EXTERNAL clock: the last phase error of the lock, in ticks (display) */
  get phaseError(): number {
    return this.phase.error;
  }

  /** The tempo the scheduler runs at before any curve: the external one while following, else the project's. */
  private baseTempo(): number {
    return this.externalTempo ? this.extBpm! : this.project.tempo;
  }

  setClockMode(mode: ClockMode): void {
    this.midi.setClockMode(mode);
    if (mode !== 'external') this.leaveExternal();
    this.emit(['transport', 'midi']);
  }

  /** Back to the internal tempo state: the project's tempo and its curve, from the horizon on. */
  private leaveExternal(): void {
    this.extBpm = null;
    this.extArm = null;
    this.scheduler.setTempo(this.project.tempo);
    this.scheduler.retempo();
    this.live.setBpm(this.effectiveBpm());
  }

  private applyExtTempo(bpm: number): void {
    const b = clamp(bpm, 20, 400);
    if (this.extBpm !== null && Math.abs(b - this.extBpm) < 0.005) return;
    this.extBpm = b;
    this.scheduler.setTempo(b);
    this.live.setBpm(b);
    this.midi.cc.setBpm(b);
  }

  /** The master's tempo estimate changed. */
  private extTempo(bpm: number): void {
    const wasFollowing = this.externalTempo;
    // while running with a phase lock the pulses drive the tempo; otherwise the estimate does
    if (!this.ui.playing || !this.midi.clock.running || !wasFollowing) this.applyExtTempo(bpm);
    if (!wasFollowing) this.scheduler.retempo();
    this.emit(['transport']);
  }

  /** Start (pulse 0) or Continue (pulse n): playback begins on the next pulse. */
  private extStart(pulse: number): void {
    if (this.ui.playing) this.stop();
    this.extArm = pulse * (PPQ / 24);
    this.say(pulse ? 'EXTERNAL CONTINUE' : 'EXTERNAL START');
  }

  private extPulse(n: number, ms: number): void {
    const tpp = PPQ / 24;
    if (this.extArm !== null) {
      // join the master: the pulse at `ms` is tick n × 4; CLATTER starts a moment later at the matching tick
      const arm = this.extArm;
      this.extArm = null;
      const bpm = this.extBpm ?? this.midi.clock.bpm ?? this.project.tempo;
      if (this.extBpm === null) this.applyExtTempo(bpm || this.project.tempo);
      const pulseAt = this.host.audioTimeOf(ms);
      const t0 = this.host.now + 0.05;
      const spt = 60 / ((this.extBpm ?? bpm) * PPQ);
      const from = arm + Math.max(0, (t0 - pulseAt) / spt);
      this.phase.reset(arm - n * tpp);
      void this.play(from, t0);
      return;
    }
    if (!this.ui.playing || !this.scheduler.running || this.midi.prefs.clock !== 'external') return;
    const tick = this.scheduler.tickAt(this.host.audioTimeOf(ms));
    const cmd = this.phase.correct(this.midi.clock.bpm || this.extBpm || this.project.tempo, n, tick, PPQ);
    // the command changes at most every sixteenth (6 pulses): the error is measured on every pulse
    if (n % 6 === 0 || this.extBpm === null) this.applyExtTempo(cmd);
  }

  setTempo(bpm: number, undoable = true): void {
    const b = Math.round(clamp(bpm, 30, 300) * 10) / 10;
    if (b === this.project.tempo) return;
    const apply = () => {
      this.project.tempo = b;
      // following an external clock, the new tempo is kept for when CLATTER runs on its own again
      this.scheduler.setTempo(this.baseTempo());
      this.live.setBpm(this.effectiveBpm());
    };
    if (undoable) this.change('TEMPO', apply, ['transport']);
    else {
      apply();
      this.emit(['transport']);
    }
  }

  /** The tempo in force now: the BPM, times the tempo curve while it plays (or the external clock's). */
  effectiveBpm(): number {
    if (this.ui.playing && this.scheduler.running) return this.scheduler.currentBpm;
    return this.externalTempo ? this.extBpm! : bpmAt(this.project.tempo, this.project.tempoAuto, 0);
  }

  /** Replace the tempo curve (undefined removes it). One undo step. */
  setTempoAuto(auto: TempoAuto | undefined, label = 'TEMPO CURVE'): void {
    this.change(
      label,
      () => {
        if (auto) this.project.tempoAuto = auto;
        else delete this.project.tempoAuto;
        this.scheduler.retempo();
        this.live.setBpm(this.effectiveBpm());
      },
      ['transport'],
    );
  }

  toggleTempoAuto(): void {
    const a = this.project.tempoAuto;
    if (a) this.setTempoAuto({ ...a, on: !a.on }, a.on ? 'TEMPO CURVE OFF' : 'TEMPO CURVE ON');
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

  /**
   * WILDCARD: one seeded re-imagining of the instrument within the chosen scope and intensity
   * (src/destruction/wildcardProject.ts). One undo step: the history takes the whole project
   * first, tempo included. Without FIXED SEED each press draws a new seed; the seed used is
   * kept in the settings (and recorded in the project) so the result can be made again.
   */
  wildcard(quantise = false): void {
    const w = this.prefs.wildcard;
    const settings: WildSettings = { seed: w.fixed ? w.seed : randomSeed(), intensity: w.intensity, scope: w.scope, cats: [...w.cats] };
    if (!w.fixed) {
      w.seed = settings.seed;
      savePrefs(this.prefs);
    }
    const fn = () => {
      const r = applyWildcard(this.project, settings, { track: this.ui.track, pool: this.library.list().map((x) => ({ id: x.id, role: x.role })) });
      this.project.wildcard = { ...settings, cats: [...settings.cats] };
      this.evolveHome = null;
      // the engine follows: kit, strips, tempo and the output chain
      configureEngine(this.live, this.project, this.library);
      this.scheduler.setTempo(this.baseTempo());
      this.scheduler.retempo();
      this.live.setBpm(this.effectiveBpm());
      this.say(`WILDCARD ${settings.intensity}% ${SCOPE_LABEL[settings.scope]} · SEED ${settings.seed} · ${r.report.join(' · ')}`);
    };
    const topics: Topic[] = ['pattern', 'gen', 'destruction', 'kit', 'transport', 'tracks', 'mix', 'master', 'mod'];
    if (quantise) this.quantised('WILDCARD', fn, topics);
    else this.change('WILDCARD', fn, topics);
    this.emit(['project']);
  }

  /** Undo the last WILDCARD (if it is the last thing done) and try another seed. */
  wildcardAgain(): void {
    if (this.history.undoLabel === 'WILDCARD') this.history.undo();
    this.wildcard();
  }

  /** Change the WILDCARD settings (not part of the project's undo history). */
  setWildcard(patch: Partial<Prefs['wildcard']>): void {
    const w = this.prefs.wildcard;
    Object.assign(w, patch);
    Object.assign(w, { ...repairWild(w), fixed: w.fixed });
    savePrefs(this.prefs);
    this.emit(['transport']);
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
        this.scheduler.setTempo(this.baseTempo());
        this.live.setBpm(this.effectiveBpm());
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
    this.live.setOutput(outputOf(this.project));  this.configureCc();
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
    // MIDI notes of a track that is no longer heard end now
    if (transient) {
      const solo = anySolo(this.project);
      this.project.tracks.forEach((x, i) => {
        if (x.mix.mute || (solo && !x.mix.solo)) this.midi.releaseTrack(i);
      });
    }
    this.syncTracks();
    this.autosave();
    this.emit(['mix', 'tracks', 'history']);
  }

  setTrackName(id: string, name: string): void {
    const t = this.project.tracks.find((x) => x.id === id);
    if (t) this.change('RENAME TRACK', () => (t.name = name.toUpperCase().slice(0, 10) || t.name), ['tracks']);
  }

  /** A track's MIDI routing, channel, note or length. Its sounding MIDI notes end first. */
  setTrackMidi(id: string, midi: Partial<Track['midi']>): void {
    const i = this.trackIndexOf(id);
    const t = this.project.tracks[i];
    if (!t) return;
    this.midi.releaseTrack(i);
    this.change('TRACK MIDI', () => Object.assign(t.midi, midi), ['tracks', 'midi']);
  }

  /** The same MIDI settings for every track (TRACK ROUTING: ALL). */
  setAllTracksMidi(midi: Partial<Track['midi']>): void {
    this.project.tracks.forEach((_, i) => this.midi.releaseTrack(i));
    this.change('TRACK MIDI', () => this.project.tracks.forEach((t) => Object.assign(t.midi, midi)), ['tracks', 'midi']);
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
    this.live.setOutput(outputOf(this.project));
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

  /** The kit generation settings: character, wildness, profile overrides, seed hold. */
  get kitGen(): KitGenSettings {
    return this.project.kitGen ?? defaultKitGen();
  }

  /** Change the generation settings (part of the project; not an undo step, as a knob position). */
  setKitGen(g: Partial<KitGenSettings>): void {
    const cur = (this.project.kitGen ??= defaultKitGen());
    Object.assign(cur, g);
    if (g.wildness !== undefined) cur.wildness = clamp(g.wildness, 0, 1);
    this.autosave();
    this.emit(['kit']);
  }

  /** The profile each voice is designed as (an override, or from its tracks). */
  voiceProfiles(): Profile[] {
    return resolveProfiles({ voiceRoles: voiceRolesOf(this.project.tracks), profiles: this.kitGen.profiles });
  }

  /** Profile-designer options for a press: character, wildness, profiles. */
  private profileOpts(seed: number, voices?: number[]) {
    const g = this.kitGen;
    return { ...this.kitOpts(seed), character: g.character, wildness: g.wildness, profiles: g.profiles, voices };
  }

  /** The seed of a press: the held one, or a new one (remembered so the press can be made again). */
  private pressSeed(): number {
    const g = (this.project.kitGen ??= defaultKitGen());
    if (!g.hold) g.seed = randomSeed();
    return g.seed;
  }

  /** A kit through the engine check (levels, audibility; with `gen`, recognition of each profile). */
  private async checkedKit(kit: SynthKit, seed: number, voices?: number[], gen = false): Promise<SynthKit> {
    if (!this.kits) return kit;
    this.ui.busy = true;
    this.emit(['status']);
    try {
      const g = this.kitGen;
      return await this.kits.check(kit, {
        flavour: styleById(this.project.gen.style).kitFlavour,
        voiceRoles: voiceRolesOf(this.project.tracks),
        seed,
        voices,
        locked: this.project.soundLocks.voices,
        lockedParams: this.project.soundLocks.params,
        ...(gen ? { gen: { character: g.character, wildness: g.wildness, profiles: this.voiceProfiles() } } : {}),
      });
    } finally {
      this.ui.busy = false;
      this.emit(['status']);
    }
  }

  /** Send only what changed. */
  applyKitChange(next: SynthKit, time?: number): void {
    const before = this.project.kit.synth;
    this.project.kit.synth = next;
    const d = kitDiff(before, next);
    if (d.length) this.live.setParams(d, time);
    for (let v = 0; v < 6; v++) {
      if (before.lfoTarget[v] !== next.lfoTarget[v]) this.live.setModTarget(0, v, next.lfoTarget[v] ?? 0);
      if (before.velTarget[v] !== next.velTarget[v]) this.live.setModTarget(1, v, next.velTarget[v] ?? 0);
    }
  }

  private genLabel(): string {
    const g = this.kitGen;
    return `${CHARACTER_DEFS[g.character].label} · WILDNESS ${Math.round(g.wildness * 100)}%`;
  }

  /**
   * GENERATE KIT: a new set of synthesised drums, each voice designed from its instrument profile
   * with the CHARACTER and WILDNESS of the KITS workspace, and checked in the engine. Only the kit:
   * never the patterns, the tempo or the samples (that is WILDCARD).
   */
  async generateKit(quantise = false): Promise<void> {
    const seed = this.pressSeed();
    const g = { ...this.kitGen };
    const profiles = this.voiceProfiles();
    const kit = await this.checkedKit(generateKit(this.project.kit.synth, this.profileOpts(seed)), seed, undefined, true);
    const fn = () => {
      this.applyKitChange(kit);
      this.project.kit.seed = seed;
      this.project.kit.name = `KIT ${seed.toString(36).toUpperCase().slice(0, 5)}`;
      this.project.kit.gen = { v: 2, op: 'generate', seed, character: g.character, wildness: g.wildness, profiles };
      this.evolveHome = clone(kit);
      this.say(`NEW KIT · ${this.genLabel()} · SEED ${seed}`);
    };
    if (quantise) this.quantised('GENERATE KIT', fn, ['kit']);
    else this.change('GENERATE KIT', fn, ['kit']);
  }

  /**
   * MUTATE KIT / MUTATE VOICE: changes relative to the current kit, as far as the WILDNESS allows
   * (low: restrained, the drums keep their identity; high: they may leave their roles), leaning
   * towards the CHARACTER. `amount` (0-1) overrides how much moves (default: from the wildness).
   * Locked voices and parameters, samples and source modes are never touched. One undo step.
   */
  async mutateKit(amount?: number, voices?: number[], quantise = false): Promise<void> {
    const seed = randomSeed();
    const g = { ...this.kitGen };
    const a = amount ?? 0.12 + 0.75 * g.wildness;
    const kit = await this.checkedKit(mutateKit(this.project.kit.synth, { ...this.profileOpts(seed, voices), amount: a }), seed, voices, g.wildness < 0.35);
    const label = voices && voices.length === 1 ? 'MUTATE VOICE' : 'MUTATE KIT';
    const fn = () => {
      this.applyKitChange(kit);
      this.project.kit.gen = { v: 2, op: 'mutate', seed, character: g.character, wildness: g.wildness, profiles: this.voiceProfiles() };
      this.say(`${label} · ${this.genLabel()}`);
    };
    if (quantise) this.quantised(label, fn, ['kit']);
    else this.change(label, fn, ['kit']);
  }

  /**
   * NEW VOICE: design one voice afresh, as its profile (or `profile`, to make, say, a cymbal on a
   * kick track: the override is remembered for that voice until set back to AUTO).
   */
  async generateVoice(v: number, profile?: Profile | null): Promise<void> {
    if (v < 0 || v > 5) return;
    if (profile !== undefined) {
      const ps = [...this.kitGen.profiles];
      ps[v] = profile;
      this.setKitGen({ profiles: ps });
    }
    if (this.project.soundLocks.voices[v]) return this.say('THE VOICE IS LOCKED');
    const seed = this.pressSeed();
    const prof = this.voiceProfiles()[v]!;
    const kit = await this.checkedKit(generateKit(this.project.kit.synth, this.profileOpts(seed, [v])), seed, [v], true);
    this.change('NEW VOICE', () => {
      this.applyKitChange(kit);
      const g = this.kitGen;
      this.project.kit.gen = { v: 2, op: 'voice', seed, character: g.character, wildness: g.wildness, profiles: this.voiceProfiles() };
      this.say(`NEW ${PROFILE_LABEL[prof]} ON VOICE ${v + 1} · ${this.genLabel()} · SEED ${seed}`);
    }, ['kit']);
  }

  setCharacter(c: Character): void {
    this.setKitGen({ character: c });
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

  // ------------------------------------------------------------------ SOUND: modulation
  /** What modulation targets on a track: its source mode and LXR voice. */
  modTarget(t: Track = this.track): ModTarget {
    return { mode: t.sound.mode, voice: Math.max(0, this.voiceOf(t)) };
  }

  /** The modulation of the sound being edited: the base's, or the base with the open variation's patch applied. */
  editedMod(t: Track = this.track): TrackMod {
    const slot = this.ui.slot;
    return resolveMod(t.sound.mod, slot === null ? undefined : t.sound.variations?.[slot]?.mod);
  }

  /** The modulation a variation plays (null: the base's). */
  modOfSlot(t: Track, slot: number | null): TrackMod {
    return resolveMod(t.sound.mod, slot === null ? undefined : t.sound.variations?.[slot]?.mod);
  }

  /** Change the modulation of the sound being edited. On a variation only the differences from the base are stored. */
  setEditedMod(fn: (m: TrackMod) => void, label = 'MODULATION'): void {
    const t = this.track;
    const slot = this.ui.slot;
    const cur = this.editedMod(t);
    const next = JSON.parse(JSON.stringify(cur)) as TrackMod;
    fn(next);
    if (JSON.stringify(next) === JSON.stringify(cur)) return;
    this.history.begin(label);
    if (slot === null) {
      if (!next.routes.length && !Object.keys(next.sources).length) delete t.sound.mod;
      else t.sound.mod = next;
    } else {
      const list = this.ensureVariations(t);
      const v = (list[slot] ??= { name: '', params: {} });
      const patch = diffMod(t.sound.mod, next);
      if (patch) v.mod = patch;
      else delete v.mod;
      delete v.gen;
    }
    this.history.commit();
    this.syncTracks();
    this.autosave();
    this.sequence.bump();
    this.scheduler.invalidate();
    this.emit(['mod', 'tracks', 'history', 'pattern']);
  }

  selectModSource(id: SourceId): void {
    this.ui.modSel = id;
    this.emit(['mod']);
  }

  /** Make a source active with its defaults (an LFO, an envelope, a step sequencer...). */
  activateSource(id: SourceId): void {
    if (typeOfSource(id) === 'macro' || id === 'vel') return this.selectModSource(id);
    this.setEditedMod((m) => {
      if (!m.sources[id]) (m.sources as Record<string, SourceDef>)[id] = defaultSource(id);
    }, 'ADD SOURCE');
    this.selectModSource(id);
  }

  /** Remove a source and every route that uses it. */
  removeSource(id: SourceId): void {
    this.setEditedMod((m) => {
      delete m.sources[id];
      m.routes = m.routes.filter((r) => r.src !== id);
    }, 'REMOVE SOURCE');
  }

  setSource(id: SourceId, patch: Record<string, unknown>, label = 'SOURCE'): void {
    this.setEditedMod((m) => {
      const cur = m.sources[id] ?? defaultSource(id);
      (m.sources as Record<string, unknown>)[id] = { ...cur, ...patch };
    }, label);
  }

  /** Add a route from a source to a destination (the source is activated if it needs a definition). */
  addRoute(src: SourceId, dst: string, amt = 0.3): void {
    const t = this.track;
    const { mode, voice } = this.modTarget(t);
    if (!destApplies(dst, mode, voice)) return this.say('THAT DESTINATION DOES NOT EXIST ON THIS TRACK');
    this.setEditedMod((m) => {
      if (!m.sources[src] && typeOfSource(src) !== 'macro' && src !== 'vel' && src !== 'trig') (m.sources as Record<string, SourceDef>)[src] = defaultSource(src);
      m.routes.push(defaultRoute(newRouteId(m), src, dst, amt));
    }, 'ADD ROUTE');
  }

  setRoute(id: string, patch: Partial<ModRoute>, label = 'ROUTE'): void {
    this.setEditedMod((m) => {
      const r = m.routes.find((x) => x.id === id);
      if (r) Object.assign(r, patch);
    }, label);
  }

  removeRoute(id: string): void {
    this.setEditedMod((m) => {
      m.routes = m.routes.filter((r) => r.id !== id);
    }, 'REMOVE ROUTE');
  }

  /** Replace the edited sound's modulation with a factory or user preset (routes the track cannot use are dropped). */
  loadModPreset(id: string): void {
    const t = this.track;
    const target = this.modTarget(t);
    const user = this.modLibrary.get(id);
    const next = user?.mod ? fitMod(user.mod, target) : buildRecipe(id, target);
    this.setEditedMod((m) => {
      m.sources = next.sources;
      m.routes = next.routes;
    }, 'MODULATION PRESET');
    const first = Object.keys(next.sources)[0] as SourceId | undefined;
    if (first) this.ui.modSel = first;
    this.say(`MODULATION: ${user?.name ?? id.replace(/^f:/, '').toUpperCase()}`);
  }

  saveModPreset(name: string): void {
    const p = this.modLibrary.save(name, this.editedMod());
    this.say(`MODULATION PRESET ${p.name} SAVED`);
    this.emit(['mod']);
  }

  renameModPreset(id: string, name: string): void {
    this.modLibrary.rename(id, name);
    this.emit(['mod']);
  }

  duplicateModPreset(id: string): void {
    const p = this.modLibrary.duplicate(id);
    if (p) this.say(`MODULATION PRESET ${p.name} CREATED`);
    this.emit(['mod']);
  }

  deleteModPreset(id: string): void {
    this.modLibrary.remove(id);
    this.emit(['mod']);
  }

  /** Import a portable `clatter-mod` file into the preset library (nothing changes on any track). */
  importModPreset(text: string): string | null {
    try {
      const p = this.modLibrary.import(text);
      this.say(`MODULATION PRESET ${p.name} IMPORTED`);
      this.emit(['mod']);
      return p.id;
    } catch (e) {
      this.say(e instanceof Error ? e.message : String(e));
      return null;
    }
  }

  clearModulation(): void {
    this.setEditedMod((m) => {
      m.sources = {};
      m.routes = [];
    }, 'CLEAR MODULATION');
  }

  /** Reproducible random modulation for the edited sound. */
  generateModulation(intensity = 0.5): void {
    const seed = this.modSeed++;
    const next = generateMod(seed * 7919 + this.project.seed, this.modTarget(), intensity);
    this.setEditedMod((m) => {
      m.sources = next.sources;
      m.routes = next.routes;
    }, 'GENERATE MODULATION');
    const first = Object.keys(next.sources)[0] as SourceId | undefined;
    if (first) this.ui.modSel = first;
  }

  mutateModulation(intensity = 0.4): void {
    const seed = this.modSeed++;
    const next = mutateMod(this.editedMod(), seed * 104729 + this.project.seed, this.modTarget(), intensity);
    this.setEditedMod((m) => {
      m.sources = next.sources;
      m.routes = next.routes;
    }, 'MUTATE MODULATION');
  }

  randomiseModSource(id: SourceId): void {
    if (!isSource(id)) return;
    const next = randomiseSource(this.editedMod(), id, this.modSeed++ * 31 + this.project.seed);
    this.setEditedMod((m) => {
      m.sources = next.sources;
    }, 'RANDOMISE SOURCE');
  }

  /** Remove a variation's modulation overrides (it plays the base's again). */
  clearVariationMod(trackId: string, slot: number): void {
    const v = this.project.tracks.find((x) => x.id === trackId)?.sound.variations?.[slot];
    if (!v?.mod) return;
    this.change('CLEAR MODULATION OVERRIDES', () => delete v.mod, ['mod', 'tracks']);
    this.syncTracks();
  }

  /** Give a variation a related modulation: the base's, mutated, stored as a sparse patch. */
  mutateVariationMod(trackId: string, slot: number, amount = 0.5): void {
    const t = this.project.tracks.find((x) => x.id === trackId);
    if (!t) return;
    const base = resolveMod(t.sound.mod, undefined);
    const next = mutateMod(base.routes.length ? base : generateMod(this.modSeed++ + this.project.seed, this.modTarget(t), 0.5), this.modSeed++ * 17 + this.project.seed, this.modTarget(t), amount);
    this.change('VARIATION MODULATION', () => {
      const list = this.ensureVariations(t);
      const v = (list[slot] ??= { name: '', params: {} });
      const patch = diffMod(t.sound.mod, next);
      if (patch) v.mod = patch;
      else delete v.mod;
      delete v.gen;
    }, ['mod', 'tracks', 'pattern']);
    this.syncTracks();
  }

  /** Destinations the selected track can use right now. */
  modDestinations() {
    const { mode, voice } = this.modTarget();
    return destsFor(mode, voice);
  }

  macros(): number[] {
    return this.project.macros ?? [0, 0, 0, 0];
  }

  /** Move a performance macro (live; saved with the project, not an undo step). */
  setMacro(i: number, v: number): void {
    const m = (this.project.macros ??= [0, 0, 0, 0]);
    m[i] = Math.max(0, Math.min(1, v));
    this.live.setMacros(m.slice());
    this.autosave();
    this.emit(['mod']);
  }

  /** Ask the engine for the live state of one track's modulation (the editor shows it); -1 stops. */
  private watched = -2;
  watchMod(on: boolean): void {
    const idx = on ? this.trackIndexOf(this.track.id) : -1;
    if (idx === this.watched) return;
    this.watched = idx;
    this.host.send({ type: 'modWatch', track: idx });
  }

  // ------------------------------------------------------------------ SOUND: output stage
  setChannelFx(trackId: string, fx: ChannelFx | undefined, label = 'CHANNEL PROCESSING'): void {
    const t = this.project.tracks.find((x) => x.id === trackId);
    if (!t) return;
    this.history.begin(label);
    if (fx) t.mix.fx = fx;
    else delete t.mix.fx;
    this.history.commit();
    this.syncTracks();
    this.autosave();
    this.emit(['mix', 'history']);
  }

  /** Change one channel-processing stage, e.g. ('sat', { on: true, drive: 0.5 }). */
  patchChannelFx<K extends keyof ChannelFx>(trackId: string, stage: K, patch: Partial<ChannelFx[K]>, label = 'CHANNEL PROCESSING'): void {
    const t = this.project.tracks.find((x) => x.id === trackId);
    if (!t) return;
    const fx: ChannelFx = JSON.parse(JSON.stringify(t.mix.fx ?? defaultChannelFx()));
    Object.assign(fx[stage], patch);
    this.setChannelFx(trackId, fx, label);
  }

  outputFx(): OutputFx {
    return this.project.master.out ?? { ...defaultOutputFx(), limiter: { ...defaultOutputFx().limiter, on: false } };
  }

  /** Change bus processing, width or the limiter. */
  patchOutput(fn: (o: OutputFx) => void, label = 'OUTPUT'): void {
    const o: OutputFx = JSON.parse(JSON.stringify(this.outputFx()));
    fn(o);
    this.setMaster({ out: o }, label);
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

  // ------------------------------------------------------------------ TRIGGER CONDITIONS
  stepTrig(trackId: string, step: number): TrigCond | undefined {
    return trigAt(this.pattern, trackId, step);
  }

  /** The steps the TRIGGER editor acts on: the selected region's hits, or the cursor step. */
  trigTargets(): { track: string; step: number }[] {
    return this.soundTargets();
  }

  /** Set (undefined or ALWAYS: clear) the condition of the target steps. One undo step. */
  setStepTrigger(c: TrigCond | undefined, label = 'TRIGGER CONDITION', targets = this.trigTargets()): void {
    if (!targets.length) return;
    this.change(
      label,
      () => {
        for (const x of targets) setStepTrig(this.pattern, x.track, x.step, c ? { ...c } : undefined);
      },
      ['pattern'],
    );
  }

  /** Clear every condition of the track (or of the whole pattern). */
  clearTriggers(allTracks = false): void {
    const ids = allTracks ? this.project.tracks.map((t) => t.id) : [this.ui.track];
    this.change('CLEAR CONDITIONS', () => ids.forEach((id) => setTrigs(this.pattern, id, {})), ['pattern']);
  }

  /** The pass of the pattern the grid shows while stopped (1 = the first). */
  setPreviewPass(n: number): void {
    this.ui.previewPass = Math.max(1, Math.min(64, Math.round(n)));
    this.emit(['pattern', 'selection']);
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

  /** Preview a library sample on its own (Slop Factory Core's auditioner: one at a time, on the engine's own context). */
  async previewSample(id: string): Promise<void> {
    const s = this.library.get(id);
    if (!s || !this.kitm) return;
    await this.kitm.audition.play({ sampleRate: s.rate, channels: s.channels }, { key: id });
  }

  // ------------------------------------------------------------------ MIDI input
  /** An incoming note plays a track now (velocity already scaled by the input sensitivity, applied once). */
  private midiNote(i: number, vel: number): void {
    const p = this.project;
    const t = p.tracks[i];
    if (!t) return;
    if (this.host.state !== 'running') void this.host.start().then(() => configureEngine(this.live, this.project, this.library)).catch(() => undefined);
    const route = t.midi.out ?? 'both';
    if (route !== 'midi') this.host.send({ type: 'hits', hits: [{ time: this.host.now, track: i, vel, pitch: 0 }] });
    if (this.ui.record && this.ui.playing) {
      const pos = this.playhead();
      if (pos && pos.pattern === this.pattern.id) {
        const step = Math.round(pos.step) % this.pattern.steps;
        setHit(this.pattern, t.id, step, { vel });
        this.touch(['pattern']);
      }
    }
  }

  /** MIDI Learn: the next incoming note plays this track (or the next CC moves this macro); null cancels. */
  armLearn(t: LearnTarget | null): void {
    this.midi.armLearn(t);
  }

  /** Set the note an input position plays (NO_NOTE = none). Per browser, not part of the project. */
  setInputNote(track: number, note: number): void {
    const m = this.midi.prefs.inMap;
    if (track < 0 || track >= m.length) return;
    m[track] = clamp(Math.round(note), -1, 127);
    this.midi.update({});
  }

  /** The MIDI CC destinations (portable: part of the project). */
  setCcSlot(i: number, c: Partial<import('../model/types').CcSlot>): void {
    this.change(
      'MIDI CC',
      () => {
        const list = (this.project.midiCc ??= defaultCcSlots());
        Object.assign(list[i]!, c);
      },
      ['midi'],
    );
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
    this.kitm?.projectReplaced();
    if (wasPlaying) this.scheduler.setTempo(this.baseTempo());
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
    this.kitm?.projectReplaced();
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
    this.kitm?.projectReplaced();
    this.say(`OPENED ${p.name}`);
  }

  // ------------------------------------------------------------------ kits
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
