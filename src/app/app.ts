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
import { AuditionPlayer } from '../audio/auditionPlayer';
import { DiscoverSession } from './discover';
import { applyToKit, clampWildness, soundWithExtras, type Candidate } from '../sound/discover';
import { analyseTarget, normalizeTarget, PitchCache, targetKey, type PitchRecord, type PitchTarget } from '../analysis/trackPitch';
import type { MetersMessage, TimedHit } from '../audio/protocol';
import { ENGINE_RATE } from '../audio/engine';
import { defaultProject } from '../model/defaults';
import { BUNDLE_EXT, parseProject, projectSamples, PROJECT_EXT, serialize } from '../model/project';
import { buildPreset, PRESETS, resolveBundled } from '../model/presets';
import { describeStepSound, isEmptyStepSound, lockableParam, resolveStepSound, soundSampleIds } from '../sound/stepSound';
import { addEvolution, clearEvolution, distributeSounds, generateVariations, mutateSounds, slotWritable } from '../sound/soundgen';
import { voiceKeys } from '../sound/kitgen';
import { clamp, clone, MAX_PATTERNS, VARIATION_SLOTS, MAX_STEPS, stepTicks, type StepSound, type Variation, type DestructionSettings, type GenSettings, type Hit, type Pattern, type Project, type Quantize, type Resolution, type SynthKit, type Track, type TrackMix, type TrackPlay, type TrackSound } from '../model/types';
import { MidiController } from '../midi/controller';
import { generate, stepsPerBar } from '../rhythm/generate';
import { mutate, summariseOps } from '../rhythm/mutate';
import { clearTrack, copyRegion, newPattern, pasteRegion, removeNote, setHit, setLength, setResolution, setSounds, setStepSound, setStepTrig, setTrigs, trigAt, shiftTrack, soundCount, trackGrid, stepSoundAt, type Clip } from '../rhythm/pattern';
import { hash32, randomSeed, Rng } from '../rhythm/rng';
import { assignSeed, parseSeedInput, randomSeedValue, seedLabel, type SeedValue } from '../rhythm/seed';
import { applyVelOp, clampVel, VEL_LABEL, type VelOp } from '../rhythm/velocity';
import type { GestureHost } from '../ui/stepGesture';
import { styleById, type KitFlavour } from '../rhythm/styles';
import type { Realization } from '../rhythm/realize';
import { applyWildcard, defaultWild, repairWild, SCOPE_LABEL, type WildSettings } from '../destruction/wildcardProject';
import type { TrigCond } from '../model/types';
import { bpmAt, tempoActive, type TempoAuto } from '../transport/tempo';
import { ExportRunner, type ExportFile, type ExportKind } from './exportJob';
import { KitExportJob } from './kitExportJob';
import { exportKit, type KitExportOptions } from '../export/kitExport';
import { describeChop } from '../destruction/chop';
import { describeRolls } from '../destruction/rolls';
import { describeDestroy } from '../destruction/destroy';
import { kitPitchPlans, needsMeasure, pitchPlanList, pitchPlanOf, type TuneEnv } from '../music/tuning';
import { measureAndTune, type TrackResult } from '../music/measure';
import { defaultGlobalScale, defaultModeFor, defaultTrackScale, normaliseScale, trackScaleSpec, type GlobalScale, type ScaleSpec, type TrackScale } from '../music/scale';
import { evolveKit, generateKit, KIT_GENERATOR, mutateKit, voiceRolesOf } from '../sound/kitgen';
import { KitService } from '../sound/kitService';
import { DEFAULT_CANDIDATES, type SelectOptions } from '../sound/kitcheck';
import { KitManager } from './kitManager';
import { exportMidi } from '../export/midiFile';
import { Sequence } from './sequence';
import { anySolo, configureEngine, engineTrackIn, hitOf, kitDiff, masterChain, outputOf, sendKit, trackIndex, tuneEnvOf, type EngineTarget } from './soundConfig';
import { defaultRoute, defaultSource, diffMod, isSource, newRouteId, resolveMod } from '../mod/config';
import { destApplies, destsFor } from '../mod/registry';
import { buildRecipe, fitMod, generateMod, mutateMod, randomiseSource, type ModTarget } from '../mod/presets';
import { ModLibrary } from '../mod/library';
import { typeOfSource, type ModRoute, type SourceDef, type SourceId, type TrackMod } from '../mod/types';
import { defaultChannelFx, defaultOutputFx, type ChannelFx, type OutputFx } from '../audio/mixfx';
import { History } from './history';
import { loadPrefs, savePrefs, type Prefs, type SeedSlot, type SoundTab, type Workspace } from './prefs';
import { setScale } from '../ui/scale';
import { Scheduler, startTicker } from '../transport/scheduler';
import { PAR } from '../sound/lxrParamIds';

export type Topic = 'project' | 'pattern' | 'tracks' | 'kit' | 'mix' | 'transport' | 'destruction' | 'gen' | 'library' | 'kits' | 'midi' | 'status' | 'snapshots' | 'view' | 'workspace' | 'selection' | 'history' | 'master' | 'mod' | 'notice' | 'kitexport' | 'discover' | 'scale';

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
  /** steps added to the selection one by one (Shift-click); the region `sel` and these together are the selection */
  picks: { track: string; step: number }[];
  /** a pattern switch waiting for the end of the cycle */
  queued: string | null;
  playing: boolean;
  status: string;
  /** momentary fills */
  fills: Set<string>;
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
  /** background kit export: every instrument as WAV files in a ZIP (one at a time; see src/export/kitExport.ts) */
  readonly kitExport: KitExportJob;
  /** hands a finished export to the user (the browser download; set by the page) */
  deliver: (file: ExportFile) => void = () => undefined;
  /** pitch analyses of rendered sounds, beside the project (never saved in it; see src/analysis) */
  readonly pitch = new PitchCache();
  /** SOUND DISCOVERY: candidate sounds for the selected instrument, auditioned offline, applied only when asked (src/app/discover.ts) */
  readonly discover: DiscoverSession;
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
      picks: [],
      queued: null,
      playing: false,
      status: 'READY',
      fills: new Set(),
      record: false,
      busy: false,
      notice: null,
      paintVel: 100,
      cursor: null,
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
      tempo: (tick) => (tempoActive(this.project.tempoAuto) ? bpmAt(this.project.tempo, this.project.tempoAuto, tick) : null),
      onTempo: (bpm) => this.live.setBpm(bpm),
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
    this.exporter = new ExportRunner({
      render: (kind, bars, tail, onProgress) => (kind === 'master' ? this.exportMaster(bars, tail, onProgress) : kind === 'stems' ? this.exportStems(bars, tail, onProgress) : this.exportMidiFile(bars)),
      deliver: (f) => this.deliver(f),
      notify: (text, level) => this.notify(text, level),
      status: (t) => this.say(t),
    });
    this.exporter.onChange = () => this.emit(['transport']);
    this.kitExport = new KitExportJob({
      project: () => this.project,
      run: (project, options, onProgress, signal) => {
        if (!this.module) throw new Error('engine not loaded');
        const module = this.module;
        return exportKit(project, options, {
          module,
          library: this.library,
          analyse: async (p, target) => {
            const fresh = this.pitch.fresh(p, target);
            if (fresh) return fresh;
            const rec = await analyseTarget(module, p, this.library, target);
            this.pitch.set(rec);
            return rec;
          },
          onProgress,
          signal,
          generator: 'CLATTER',
        });
      },
      deliver: (f) => this.deliver(f),
      notify: (text, level) => this.notify(text, level),
      status: (t) => this.say(t),
    });
    this.kitExport.onChange = () => this.emit(['transport', 'kitexport']);
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
    const player = new AuditionPlayer(async () => {
      if (host.state !== 'running') await host.start();
      return host.ctx;
    });
    this.discover = new DiscoverSession({
      project: () => this.project,
      track: () => this.track,
      flavour: () => styleById(this.project.gen.style).kitFlavour,
      drawSeed: () => this.drawSeed('discover'),
      render: async (p, trackId) => {
        if (!this.module) throw new Error('the engine is not loaded yet');
        return renderHit(this.module, p, this.library, trackId, 110, 3);
      },
      play: (audio) => player.play(audio),
      stop: () => player.stop(host.ctx ?? undefined),
      analyse: async (p, target) => {
        if (!this.module) throw new Error('the engine is not loaded yet');
        const rec = await analyseTarget(this.module, p, this.library, target);
        // the live sound's result is the TUNER's too
        if (p === this.project) this.pitch.set(rec);
        return rec;
      },
      check: async (kit, voice, seed) => (this.kits ? this.kits.check(kit, { flavour: this.kitFlavour(), wildness: this.discover.wildness, voiceRoles: voiceRolesOf(this.project.tracks), seed, voices: [voice], locked: [false, false, false, false, false, false], lockedParams: this.project.soundLocks.params, pitch: this.pitchPlans() }) : kit),
      apply: (c, withExtras) => this.applyDiscovered(c, withExtras),
      changed: () => this.emit(['discover']),
      say: (t) => this.say(t),
    });
    this.discover.character = this.prefs.discover.character;
    this.discover.wildness = this.prefs.discover.wildness;
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

  /** EXPORT KIT: validate, start, and return at once; the render continues in the background. */
  startKitExport(options: KitExportOptions): ReturnType<KitExportJob['start']> {
    return this.kitExport.start(options);
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
    if (resetHistory) {
      this.history.clear();
      this.discover.reset();
      this.tuneReport.clear();
    }
    this.ui.sel = null;
    this.ui.queued = null;
    this.evolveHome = null;
    configureEngine(this.live, this.project, this.library);
    this.scheduler.setTempo(this.project.tempo);
    this.scheduler.retempo();
    this.live.setBpm(this.effectiveBpm());
    this.touch(['project', 'pattern', 'tracks', 'kit', 'mix', 'gen', 'destruction', 'transport', 'snapshots', 'master', 'history']);
  }

  /** State changed: replan, autosave, redraw. */
  private touch(topics: Topic[]): void {
    this.autoTuneSoon();
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
    this.live.setBpm(bpmAt(this.project.tempo, this.project.tempoAuto, 0));
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
    this.live.setBpm(this.effectiveBpm());
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
      this.live.setBpm(this.effectiveBpm());
    };
    if (undoable) this.change('TEMPO', apply, ['transport']);
    else {
      apply();
      this.emit(['transport']);
    }
  }

  /** The tempo in force now: the BPM, times the tempo curve while it plays. */
  effectiveBpm(): number {
    return this.ui.playing && this.scheduler.running ? this.scheduler.currentBpm : bpmAt(this.project.tempo, this.project.tempoAuto, 0);
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
          assignSeed(p, randomSeedValue());
          p.grids = generate(this.project.tracks, this.project.gen, p.seed, { steps: p.steps, res: p.res });
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

  // ---------------------------------------------------------------- seeds (src/rhythm/seed.ts, docs/SEEDS.md)

  /** The seed field of a generator: its seed, and whether every press uses it (FIXED) or draws a new one. */
  seedSlot(slot: SeedSlot): { value: SeedValue | null; fixed: boolean } {
    if (slot === 'wildcard') {
      const w = this.prefs.wildcard;
      // a wildcard that has never been pressed shows an empty field
      const blank = !w.fixed && !w.seedText && w.seed === defaultWild().seed;
      return { value: blank ? null : { seed: w.seed, ...(w.seedText ? { text: w.seedText } : {}) }, fixed: w.fixed };
    }
    return this.prefs.seeds[slot];
  }

  private writeSlot(slot: SeedSlot, value: SeedValue | null, fixed: boolean): void {
    if (slot === 'wildcard') {
      const w = this.prefs.wildcard;
      w.fixed = fixed;
      if (value) assignSeed(w, value);
      else if (!fixed) {
        w.seed = defaultWild().seed;
        delete w.seedText;
      }
    } else this.prefs.seeds[slot] = { value, fixed };
    savePrefs(this.prefs);
    this.emit(['transport', 'gen']);
  }

  /** The seed for a generator's next press: the fixed one, or a new memorable phrase (shown in the field afterwards). */
  drawSeed(slot: SeedSlot): SeedValue {
    const cur = this.seedSlot(slot);
    if (cur.fixed && cur.value) return cur.value;
    const v = randomSeedValue();
    this.writeSlot(slot, v, false);
    return v;
  }

  /** A phrase or number typed or pasted into a seed field: the next press (and every one after) uses it. Empty: free again. */
  setSeedInput(slot: SeedSlot, input: string): boolean {
    const v = parseSeedInput(input);
    if (!v) {
      this.clearSeed(slot);
      return false;
    }
    this.writeSlot(slot, v, true);
    return true;
  }

  /** The dice: a new memorable phrase, held for the next press. */
  rollSeed(slot: SeedSlot): void {
    this.writeSlot(slot, randomSeedValue(), true);
  }

  /** Back to a new phrase on every press. */
  clearSeed(slot: SeedSlot): void {
    this.writeSlot(slot, null, false);
  }

  setSeedFixed(slot: SeedSlot, fixed: boolean): void {
    const cur = this.seedSlot(slot);
    this.writeSlot(slot, cur.value, fixed && !!cur.value);
  }

  /** The performance seed of the project (conditional triggers, step-sound probabilities, FILL, export). One undo step. */
  setProjectSeed(input: string): boolean {
    const v = parseSeedInput(input);
    if (!v) return false;
    this.change('SEED', () => assignSeed(this.project, v), ['project']);
    this.say(`PERFORMANCE SEED ${seedLabel(v)}`);
    return true;
  }

  /** Back to the seed a new project has. */
  resetProjectSeed(): void {
    this.change('SEED', () => assignSeed(this.project, { seed: defaultProject().seed }), ['project']);
  }

  /** GENERATE: a new pattern from the generator settings, written straight into the current pattern (locked tracks stay). */
  generatePattern(quantise = false): void {
    const sv = this.drawSeed('pattern');
    const seed = sv.seed;
    const fn = () => {
      const p = this.pattern;
      const geo = this.genGeometry();
      if (p.steps !== geo.steps) setLength(p, geo.steps);
      assignSeed(p, sv);
      p.settings = { ...this.project.gen };
      p.grids = generate(this.project.tracks, this.project.gen, seed, geo, p.grids);
      p.generation = 0;
      this.say(`GENERATED ${styleById(this.project.gen.style).label} · SEED ${seedLabel(sv)}`);
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
      const r = mutate(p.grids, this.unlocked(), p.res, new Rng(seed), strength, lengths);
      p.grids = r.grids;
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
      p.grids = generate(this.project.tracks, p.settings, seed, { steps: p.steps, res: p.res }, p.grids, 1);
      this.say('REGENERATED AFTER BAR 1');
    };
    if (quantise) this.quantised('REGENERATE', fn, ['pattern']);
    else this.change('REGENERATE', fn, ['pattern']);
  }

  /** How many notes the current pattern holds. */
  noteCount(): number {
    return Object.values(this.pattern.grids).reduce((n, g) => n + g.filter(Boolean).length, 0);
  }

  /** CLEAR PATTERN: every note, step sound and trigger condition of the current pattern goes. One undo brings them back. */
  clearPattern(): void {
    this.change(
      'CLEAR PATTERN',
      () => {
        const p = this.pattern;
        p.grids = {};
        delete p.sounds;
        delete p.trig;
        this.ui.sel = null;
        this.say('PATTERN CLEARED');
      },
      ['pattern', 'selection'],
    );
  }

  lockTrack(id: string): void {
    const t = this.project.tracks.find((x) => x.id === id);
    if (!t) return;
    this.change(t.lock ? 'UNLOCK TRACK' : 'LOCK TRACK', () => (t.lock = !t.lock), ['tracks', 'pattern']);
  }

  // ------------------------------------------------------------------ RHYTHM: editing
  hitAt(trackId: string, step: number): Hit | null {
    return trackGrid(this.pattern, trackId)[step] ?? null;
  }

  /** Click on a cell: add (at the paint velocity) or remove. */
  toggleCell(trackId: string, step: number): void {
    const h = this.hitAt(trackId, step);
    this.change(h ? 'DELETE HIT' : 'ADD HIT', () => (h ? removeNote(this.pattern, trackId, step) : setHit(this.pattern, trackId, step, { vel: this.ui.paintVel })), ['pattern']);
  }

  /** A paint gesture over several cells is one undo step. */
  beginPaint(): void {
    this.history.begin('PAINT');
  }

  paintCell(trackId: string, step: number, on: boolean): void {
    const h = this.hitAt(trackId, step);
    if (!!h === on) return;
    if (on) setHit(this.pattern, trackId, step, { vel: this.ui.paintVel });
    else removeNote(this.pattern, trackId, step);
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
  editSelection(fn: (h: Hit) => Hit | null, label: string): void {
    this.change(
      label,
      () => {
        const p = this.pattern;
        for (const row of this.selectedHits()) {
          for (const { step, hit } of row.hits) {
            const out = fn({ ...hit });
            if (out) setHit(p, row.track, step, cleanHit(out));
            else removeNote(p, row.track, step);
          }
        }
      },
      ['pattern'],
    );
  }

  /**
   * The hits the editing tools act on, track by track, each track's in step order: the selected
   * region, else the whole selected track.
   */
  selectedHits(): { track: string; hits: { step: number; hit: Hit }[] }[] {
    if (this.ui.picks.length) {
      const by = new Map<string, { step: number; hit: Hit }[]>();
      for (const c of this.selectedCells()) {
        const hit = this.hitAt(c.track, c.step);
        if (hit) by.set(c.track, [...(by.get(c.track) ?? []), { step: c.step, hit }]);
      }
      return this.project.tracks.filter((t) => by.has(t.id)).map((t) => ({ track: t.id, hits: by.get(t.id)!.sort((a, b) => a.step - b.step) }));
    }
    const sel = this.ui.sel;
    const ids = this.project.tracks.map((t) => t.id);
    const rows = sel ? ids.slice(Math.min(sel.t0, sel.t1), Math.max(sel.t0, sel.t1) + 1) : [this.ui.track];
    const a = sel ? Math.min(sel.s0, sel.s1) : 0;
    const b = sel ? Math.max(sel.s0, sel.s1) : this.pattern.steps - 1;
    return rows.map((track) => {
      const g = trackGrid(this.pattern, track);
      const hits: { step: number; hit: Hit }[] = [];
      for (let s = a; s <= Math.min(b, this.pattern.steps - 1); s++) if (g[s]) hits.push({ step: s, hit: g[s]! });
      return { track, hits };
    });
  }

  /** How many hits the selection holds. */
  selectedHitCount(): number {
    return this.selectedHits().reduce((n, r) => n + r.hits.length, 0);
  }

  /**
   * A velocity tool on the selected hits (SET, NUDGE, RAMP, RANDOM): one undo step. Everything else
   * about a hit (chance, pitch, ratchet, flam, its step sound and trigger) is left as it is.
   * Each track's hits are ramped or randomised on their own.
   */
  editVelocity(op: VelOp): number {
    const rows = this.selectedHits().filter((r) => r.hits.length);
    const n = rows.reduce((a, r) => a + r.hits.length, 0);
    if (!n) {
      this.say('NO HITS TO CHANGE');
      return 0;
    }
    this.change(
      VEL_LABEL[op.k],
      () => {
        rows.forEach((r, i) => {
          // the same seed on every track would make identical rows: derive one per track
          const o: VelOp = op.k === 'random' ? { ...op, seed: hash32(op.seed, i) } : op;
          const out = applyVelOp(r.hits.map((x) => x.hit.vel), o);
          r.hits.forEach((x, k) => setHit(this.pattern, r.track, x.step, cleanHit({ ...x.hit, vel: out[k]! })));
        });
      },
      ['pattern'],
    );
    this.say(`${VEL_LABEL[op.k]} · ${n} HIT${n === 1 ? '' : 'S'}`);
    return n;
  }

  /**
   * The variation (0-3) of a step's sound that sounds on a given cycle, decided by the same
   * function and the same musical clock the engine uses for the hit; null when the step plays the base sound.
   */
  playingVariation(trackId: string, step: number, cycle: number): number | null {
    const t = this.project.tracks.find((x) => x.id === trackId);
    const ss = this.stepSound(trackId, step);
    if (!t || !ss) return null;
    const rs = resolveStepSound(t.sound, ss, (par) => this.project.kit.synth.params[par] ?? 0, { seed: this.project.seed, cycle, fill: this.ui.fills.has(trackId), track: trackId, step });
    return rs.variation;
  }

  /** Select every step of every track. */
  selectAll(): void {
    this.select({ t0: 0, t1: this.project.tracks.length - 1, s0: 0, s1: this.pattern.steps - 1 });
  }

  /** The grid's pointer gestures edit through this (see src/ui/stepGesture.ts). */
  gestureHost(): GestureHost {
    return {
      steps: () => this.pattern.steps,
      hitAt: (t, s) => this.hitAt(t, s),
      newVelocity: () => this.ui.paintVel,
      begin: (label) => this.history.begin(label),
      relabel: (label) => this.history.relabel(label),
      end: () => this.endDrag(),
      paint: (t, s, on) => {
        this.paintCell(t, s, on);
      },
      setVelocity: (t, s, v) => this.setHitProps(t, s, { vel: clampVel(v) }, 'VELOCITY'),
      cursor: () => {
        const c = this.ui.cursor;
        const i = c ? this.trackIndexOf(c.track) : -1;
        return c && i >= 0 && c.step < this.pattern.steps ? { trackIndex: i, step: c.step } : null;
      },
      setCursor: (ti, step) => {
        const t = this.project.tracks[ti];
        if (!t) return;
        this.ui.cursor = { track: t.id, step };
        this.selectTrack(t.id);
        if (this.ui.sel || this.ui.picks.length) {
          this.ui.picks = [];
          this.select(null);
        }
      },
      select: (r) => this.select(r),
      pick: (t, st) => this.togglePick(t, st),
      created: (t, s) => void this.audition(t, this.hitAt(t, s)?.vel ?? this.ui.paintVel),
    };
  }

  select(sel: Selection | null): void {
    this.ui.sel = sel;
    if (sel) this.ui.picks = [];
    this.emit(['selection']);
  }

  /** Shift-click: add the step to the selection, or take it out again. The step clicked becomes the one the editors show. */
  togglePick(trackId: string, step: number): void {
    if (step < 0 || step >= this.pattern.steps) return;
    // the first Shift-click starts from what is selected: the region, else the step being edited
    if (!this.ui.picks.length) {
      const start = this.ui.sel ? this.selectedCells() : this.cursorCell() ? [this.cursorCell()!] : [];
      this.ui.picks = start.map((c) => ({ ...c }));
      this.ui.sel = null;
    }
    const i = this.ui.picks.findIndex((x) => x.track === trackId && x.step === step);
    if (i >= 0) this.ui.picks.splice(i, 1);
    else this.ui.picks.push({ track: trackId, step });
    this.ui.cursor = { track: trackId, step };
    this.ui.track = trackId;
    this.emit(['selection', 'tracks']);
  }

  /** Every selected step: the picked ones, else the cells of the region. */
  selectedCells(): { track: string; step: number }[] {
    if (this.ui.picks.length) return this.ui.picks.filter((x) => x.step < this.pattern.steps && this.project.tracks.some((t) => t.id === x.track));
    const s = this.ui.sel;
    if (!s) return [];
    const out: { track: string; step: number }[] = [];
    for (let ti = Math.min(s.t0, s.t1); ti <= Math.max(s.t0, s.t1); ti++) {
      const t = this.project.tracks[ti];
      if (!t) continue;
      for (let st = Math.min(s.s0, s.s1); st <= Math.max(s.s0, s.s1) && st < this.pattern.steps; st++) out.push({ track: t.id, step: st });
    }
    return out;
  }

  /** Delete / Backspace: the notes of the selection (else the step being edited). One undo step. */
  deleteSelected(): void {
    const cells = this.ui.picks.length || this.ui.sel ? this.selectedCells() : this.cursorCell() ? [this.cursorCell()!] : [];
    const notes = cells.filter((c) => this.hitAt(c.track, c.step));
    if (!notes.length) {
      this.say('NO NOTES SELECTED');
      return;
    }
    this.change('DELETE NOTES', () => notes.forEach((c) => removeNote(this.pattern, c.track, c.step)), ['pattern']);
    this.say(`DELETED ${notes.length} NOTE${notes.length === 1 ? '' : 'S'}`);
  }

  /** Double-click: delete the note on a step. */
  deleteNote(trackId: string, step: number): void {
    if (!this.hitAt(trackId, step)) return;
    this.change('DELETE HIT', () => removeNote(this.pattern, trackId, step), ['pattern']);
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
    // at the selection, else at the step being edited (a whole-pattern clip goes back to the start)
    const cur = this.cursorCell();
    const s0 = sel ? Math.min(sel.s0, sel.s1) : cur && c.steps < this.pattern.steps ? cur.step : 0;
    this.change('PASTE', () => pasteRegion(this.pattern, ids.slice(t0), s0, c), ['pattern']);
    // the pasted steps are the selection now, so the next edit (a velocity tool, DELETE) acts on them
    const last = Math.min(this.pattern.steps - 1, s0 + c.steps - 1);
    this.select({ t0, t1: Math.min(ids.length - 1, t0 + c.rows.length - 1), s0: Math.min(s0, last), s1: last });
  }

  clearSelection(): void {
    this.editSelection(() => null, 'CLEAR');
  }

  clearTrack(id: string): void {
    this.change('CLEAR TRACK', () => clearTrack(this.pattern, id), ['pattern']);
  }

  shiftTrack(id: string, n: number): void {
    this.change('SHIFT', () => shiftTrack(this.pattern, id, n), ['pattern']);
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
    const sv = this.drawSeed('wildcard');
    const settings: WildSettings = { seed: sv.seed, ...(sv.text ? { seedText: sv.text } : {}), intensity: w.intensity, scope: w.scope, cats: [...w.cats] };
    const fn = () => {
      const r = applyWildcard(this.project, settings, { track: this.ui.track, pool: this.library.list().map((x) => ({ id: x.id, role: x.role })) });
      this.project.wildcard = { ...settings, cats: [...settings.cats] };
      this.evolveHome = null;
      // the engine follows: kit, strips, tempo and the output chain
      configureEngine(this.live, this.project, this.library);
      this.scheduler.setTempo(this.project.tempo);
      this.scheduler.retempo();
      this.live.setBpm(this.effectiveBpm());
      this.say(`WILDCARD ${settings.intensity}% ${SCOPE_LABEL[settings.scope]} · SEED ${seedLabel(sv)} · ${r.report.join(' · ')}`);
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
      this.live.setTrack(i, engineTrackIn(this.project, t, solo, this.library));
    });
    this.live.setOutput(outputOf(this.project));
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

  /** The CHARACTER kits are made in: the player's choice, or the flavour of the rhythm style (STYLE). */
  kitFlavour(): KitFlavour {
    const c = this.prefs.discover.character;
    return c === 'style' ? styleById(this.project.gen.style).kitFlavour : c;
  }

  /** The WILDNESS kits are made with (0-1): shared by GENERATE KIT, MUTATE and SOUND > DISCOVER. */
  kitWildness(): number {
    return clampWildness(this.prefs.discover.wildness);
  }

  private kitOpts(seed: number) {
    return { seed, flavour: this.kitFlavour(), wildness: this.kitWildness(), voiceRoles: voiceRolesOf(this.project.tracks), locks: this.project.soundLocks, pitch: kitPitchPlans(this.project) };
  }

  /** A kit through the engine check (levels, audibility, and the choice among candidates when `select` is given). */
  private async checkedKit(kit: SynthKit, seed: number, voices?: number[], select?: SelectOptions): Promise<SynthKit> {
    if (!this.kits) return kit;
    this.ui.busy = true;
    this.emit(['status']);
    try {
      return await this.kits.check(kit, { flavour: this.kitFlavour(), wildness: this.kitWildness(), voiceRoles: voiceRolesOf(this.project.tracks), seed, voices, locked: this.project.soundLocks.voices, lockedParams: this.project.soundLocks.params, pitch: this.pitchPlans(), select });
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

  /** GENERATE KIT: a new set of synthesised drums designed for the style. */
  async generateKit(quantise = false): Promise<void> {
    const sv = this.drawSeed('kit');
    const seed = sv.seed;
    const flavour = this.kitFlavour();
    const wildness = this.kitWildness();
    const kit = await this.checkedKit(generateKit(this.project.kit.synth, this.kitOpts(seed)), seed, undefined, { mode: 'design', candidates: DEFAULT_CANDIDATES });
    const fn = () => {
      this.applyKitChange(kit);
      assignSeed(this.project.kit, sv);
      this.project.kit.made = { generator: KIT_GENERATOR, character: flavour, wildness };
      this.project.kit.name = `KIT ${sv.text ?? seed.toString(36)}`.toUpperCase().slice(0, 24);
      this.evolveHome = clone(kit);
      this.say(`NEW ${flavour.toUpperCase()} KIT · WILD ${Math.round(wildness * 100)}% · SEED ${seedLabel(sv)}`);
    };
    if (quantise) this.quantised('GENERATE KIT', fn, ['kit']);
    else this.change('GENERATE KIT', fn, ['kit']);
  }

  /** MUTATE KIT / MUTATE VOICE: controlled changes (amount 0-1). */
  async mutateKit(amount = 0.3, voices?: number[], quantise = false): Promise<void> {
    const seed = randomSeed();
    const base = this.project.kit.synth;
    const kit = await this.checkedKit(mutateKit(base, { ...this.kitOpts(seed), amount, voices }), seed, voices, { mode: 'mutate', candidates: DEFAULT_CANDIDATES, base, amount });
    const label = voices && voices.length === 1 ? 'MUTATE VOICE' : 'MUTATE KIT';
    const fn = () => {
      this.applyKitChange(kit);
      this.say(`${label} ${Math.round(amount * 100)}%`);
    };
    if (quantise) this.quantised(label, fn, ['kit']);
    else this.change(label, fn, ['kit']);
  }

  /**
   * SOUND DISCOVERY: APPLY. The candidate becomes the voice of the selected instrument, and (when it
   * carries them and the player chose to) the track's modulation and variations. One undo step;
   * locked parameters keep their values. The record of where it came from goes in the project.
   */
  private applyDiscovered(c: Candidate, withExtras: boolean): { locked: number } {
    let locked = 0;
    const topics: Topic[] = withExtras && c.extras ? ['kit', 'tracks', 'mod'] : ['kit'];
    this.change('APPLY CANDIDATE', () => {
      const r = applyToKit(this.project.kit.synth, c.voice, c, this.project.soundLocks);
      locked = r.locked;
      this.applyKitChange(r.kit);
      if (withExtras && c.extras) {
        const t = this.track;
        t.sound = soundWithExtras(t, c.voice, c.extras);
        this.syncTracks();
      }
      (this.project.discovered ??= {})[c.voice] = { name: c.name, origin: clone(c.origin) };
      this.evolveHome = null;
    }, topics);
    return { locked };
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


  /**
   * The audible pitch of a track's sound (the base, or variation A-D; for HYBRID a layer). The sound
   * is rendered alone and offline in a private engine and analysed; nothing the player hears or the
   * project holds changes. A stored result is reused while the sound is unchanged unless `force`.
   */
  async analysePitch(target: PitchTarget, force = false): Promise<PitchRecord> {
    if (!this.module) throw new Error('engine not loaded');
    if (!force) {
      const fresh = this.pitch.fresh(this.project, target);
      if (fresh) return fresh;
    }
    // results can finish out of order while a control is being dragged: a slower, older render must not replace a newer one
    const key = targetKey(normalizeTarget(this.project, target));
    const mine = (this.pitchStarted.get(key) ?? 0) + 1;
    this.pitchStarted.set(key, mine);
    const rec = await analyseTarget(this.module, this.project, this.library, target);
    if (mine >= (this.pitchApplied.get(key) ?? 0)) {
      this.pitchApplied.set(key, mine);
      this.pitch.set(rec);
    }
    return rec;
  }
  private pitchStarted = new Map<string, number>();
  private pitchApplied = new Map<string, number>();

  // ------------------------------------------------------------------ SCALE
  /** Per voice, where a scale-locked voice's pitch must land when the generators write it (plain data). */
  pitchPlans() {
    return pitchPlanList(this.project);
  }

  /** What the tuning may know about samples (the pitch their names claim). */
  get tuneEnv(): TuneEnv {
    return tuneEnvOf(this.library);
  }

  /** The global scale (off, C natural minor, until set). */
  get scale(): GlobalScale {
    return this.project.scale ?? defaultGlobalScale();
  }

  /** The scale a track plays in now (null: none) and where it comes from. */
  scaleOf(t: Track): ScaleSpec | null {
    return trackScaleSpec(this.project, t);
  }

  /** SCALE: switch the global scale on or off, change its root, type or user notes. One undo step. */
  setGlobalScale(patch: Partial<GlobalScale>, label = 'SCALE'): void {
    this.change(
      label,
      () => {
        const cur = this.scale;
        const next = { ...cur, ...patch };
        this.project.scale = { on: next.on, ...normaliseScale(next) };
        this.syncTracks();
      },
      ['tracks', 'scale'],
    );
    this.autoTune();
  }

  /** A track's own scale setting: OFF, GLOBAL or CUSTOM with its root, type and user notes. One undo step. */
  setTrackScale(id: string, patch: Partial<TrackScale>, label = 'TRACK SCALE'): void {
    const t = this.project.tracks.find((x) => x.id === id);
    if (!t) return;
    this.change(
      label,
      () => {
        const cur: TrackScale = t.scale ?? defaultTrackScale(defaultModeFor(t.role));
        // a track that becomes CUSTOM starts from the scale it was following
        const seed = patch.mode === 'custom' && cur.mode !== 'custom' && !('root' in patch) && !('type' in patch) ? { ...this.scale } : {};
        const { on: _on, ...rest } = seed as Partial<GlobalScale>;
        void _on;
        const next = { ...cur, ...rest, ...patch };
        t.scale = { mode: next.mode, ...normaliseScale(next) };
        this.syncTracks();
      },
      ['tracks', 'scale'],
    );
    this.autoTune([id]);
  }

  /** What the last TUNE TO SCALE found, by track (display only). */
  readonly tuneReport = new Map<string, TrackResult>();
  tuning = false;
  private tuneQueue = new Set<string>();

  private tuneTimer: ReturnType<typeof setTimeout> | null = null;

  /** After an edit: a moment later, measure what the edit made new (never while the player is still dragging a control). */
  private autoTuneSoon(): void {
    if (!this.module || (!this.project.scale?.on && !this.project.tracks.some((t) => t.scale?.mode === 'custom'))) return;
    if (this.tuneTimer) clearTimeout(this.tuneTimer);
    this.tuneTimer = setTimeout(() => {
      this.tuneTimer = null;
      this.autoTune();
    }, 700);
  }

  /** Measure the sounds of tracks that have a scale in force but no measurement of some sound, and tune them. In the background. */
  autoTune(ids?: string[]): void {
    if (!this.module) return;
    for (const t of this.project.tracks) if ((!ids || ids.includes(t.id)) && trackScaleSpec(this.project, t) && needsMeasure(this.project, t)) this.tuneQueue.add(t.id);
    if (this.tuneQueue.size && !this.tuning) void this.runTune();
  }

  private async runTune(): Promise<void> {
    this.tuning = true;
    this.emit(['scale']);
    try {
      while (this.tuneQueue.size) {
        const ids = [...this.tuneQueue];
        this.tuneQueue.clear();
        await this.tuneToScale(ids, false);
      }
    } catch (e) {
      this.say(`TUNING FAILED: ${e instanceof Error ? e.message.toUpperCase() : String(e)}`);
    } finally {
      this.tuning = false;
      this.emit(['scale']);
    }
  }

  /**
   * TUNE TO SCALE: render each sound of the tracks alone, find its audible fundamental, store the
   * measurement and move the sound onto its scale. The tuned sound is measured again and corrected.
   * Sounds with no reliable pitch are left as they are. One undo step (the automatic run that follows
   * an edit is not a step of its own: it only brings the measurements up to date).
   */
  async tuneToScale(ids: string[] = this.project.tracks.filter((t) => trackScaleSpec(this.project, t)).map((t) => t.id), undoable = true): Promise<TrackResult[]> {
    const module = this.module;
    if (!module) throw new Error('engine not loaded');
    if (!ids.length) {
      this.say('NO TRACK HAS A SCALE IN FORCE');
      return [];
    }
    const work = clone(this.project);
    this.say('TUNING…');
    const results = await measureAndTune(work, ids, {
      env: this.tuneEnv,
      analyse: async (p, target) => {
        const fresh = this.pitch.fresh(p, target);
        if (fresh) return fresh;
        const rec = await analyseTarget(module, p, this.library, target);
        this.pitch.set(rec);
        return rec;
      },
    });
    const write = () => {
        for (const r of results) {
          const live = this.project.tracks.find((x) => x.id === r.trackId);
          const wt = work.tracks.find((x) => x.id === r.trackId);
          if (!live || !wt) continue;
          if (wt.pitch) live.pitch = clone(wt.pitch);
          else delete live.pitch;
          this.tuneReport.set(r.trackId, r);
        }
        this.syncTracks();
    };
    if (undoable) this.change('TUNE TO SCALE', write, ['tracks', 'scale']);
    else {
      write();
      this.touch(['tracks', 'scale']);
    }
    const tuned = results.flatMap((r) => r.layers.filter((l) => l.state === 'tuned'));
    const left = results.flatMap((r) => r.layers.filter((l) => l.state === 'left'));
    this.say(`TUNED ${tuned.length} SOUND${tuned.length === 1 ? '' : 'S'} TO THEIR SCALES${left.length ? ` · ${left.length} LEFT AS THEY ARE (NO RELIABLE PITCH)` : ''}`);
    return results;
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
    this.change('DUPLICATE VARIATION', () => (this.ensureVariations(t)[to] = { ...clone(src), name: src.name, lock: undefined }), ['tracks', 'kit']);
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
    if (this.ui.picks.length > 1) return this.selectedCells();
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

  /** Play a track's base sound or one of its variations now, exactly as a step using it would play (the TUNER's HEAR). */
  async auditionSlot(trackId: string, slot: number | null, vel = 110): Promise<void> {
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
    const v = slot !== null && t.sound.variations?.[slot] ? slot : null;
    const rs = v === null ? null : resolveStepSound(t.sound, { v }, (par) => this.project.kit.synth.params[par] ?? 0, { seed: this.project.seed, cycle: 0, fill: false, track: trackId, step: 0 });
    this.host.send({
      type: 'hits',
      hits: [{ time: this.host.now + 0.01, track: i, vel, pitch: 0, ...(rs?.params.length ? { sp: rs.params } : {}), ...(rs?.sample ? { smp: rs.sample } : {}) }],
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

  /** The seed of a run of the sound generators (the SOUND seed field), recorded in the project's TIMBRE. */
  private newSoundSeed(): number {
    const sv = this.drawSeed('sound');
    assignSeed(this.project.timbre, sv);
    return sv.seed;
  }

  /** GENERATE VARIATIONS: fill the slots A-D (not locked) of the tracks in scope with related timbres. */
  generateVariationsFor(tracks = this.soundScope().tracks): void {
    const sv = this.drawSeed('sound');
    const seed = sv.seed;
    this.change(
      'GENERATE VARIATIONS',
      () => {
        assignSeed(this.project.timbre, sv);
        let n = 0;
        for (const t of tracks) {
          const next = generateVariations(t.sound, t.role, this.project.kit.synth.params, { seed, amount: this.project.timbre.amount, locks: this.project.soundLocks, pitch: pitchPlanOf(this.project, t) });
          const before = JSON.stringify(t.sound.variations ?? null);
          t.sound.variations = next;
          this.tidyVariations(t);
          if (JSON.stringify(t.sound.variations ?? null) !== before) n++;
        }
        this.syncTracks();
        this.say(n ? `VARIATIONS FOR ${n} TRACK${n > 1 ? 'S' : ''} · TIMBRE ${Math.round(this.project.timbre.amount * 100)}%` : 'NO FREE SLOTS (LOCKED)');
      },
      ['tracks', 'kit'],
    );
  }

  /** DISTRIBUTE: assign the variations to the steps of the tracks in scope, by role. */
  distributeVariations(): void {
    const { tracks, region } = this.soundScope();
    this.change('DISTRIBUTE VARIATIONS', () => this.writeSounds('DISTRIBUTE', tracks, region, (t, grid, cur, o) => distributeSounds(t.sound, t.role, grid, cur, this.project.kit.synth.params, o)), ['pattern']);
  }

  /** MUTATE SOUND: redraw a share of the step sounds; the rhythm stays. */
  mutateSound(amount = 0.3, quantise = false): void {
    if (quantise && this.ui.playing) return this.atBoundary('MUTATE SOUND', () => this.mutateSound(amount));
    const { tracks, region } = this.soundScope();
    this.change('MUTATE SOUND', () => this.writeSounds('MUTATE SOUND', tracks, region, (t, grid, cur, o) => mutateSounds(t.sound, t.role, grid, cur, this.project.kit.synth.params, { ...o, amount })), ['pattern']);
  }

  /** GENERATE SOUND: variations for the free slots, then their distribution (one undo step). */
  generateSound(quantise = false): void {
    if (quantise && this.ui.playing) return this.atBoundary('GENERATE SOUND', () => this.generateSound());
    this.history.begin('GENERATE SOUND');
    this.generateVariationsFor();
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
      const next = fn(t, trackGrid(p, t.id), p.sounds?.[t.id], { seed, take: 0, amount: this.project.timbre.amount, locks: this.project.soundLocks, region, ...this.geometry(), pitch: pitchPlanOf(this.project, t) });
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
        for (const t of tracks) setSounds(this.pattern, t.id, addEvolution(t.sound, t.role, trackGrid(this.pattern, t.id), this.pattern.sounds?.[t.id], { amount: Math.max(0.1, this.project.timbre.amount), passes, locks: this.project.soundLocks }));
        this.say(`SOUND EVOLUTION OVER ${passes} PASSES · IT RETURNS TO THE BASE SOUND`);
      },
      ['pattern'],
    );
  }

  clearSoundEvolution(): void {
    const { tracks } = this.soundScope();
    this.change('CLEAR EVOLUTION', () => tracks.forEach((t) => setSounds(this.pattern, t.id, clearEvolution(this.pattern.sounds?.[t.id]))), ['pattern']);
  }

  /** CLEAR STEP SOUNDS: remove every step sound of the tracks (and steps) in scope. */
  clearSoundsInScope(): void {
    const { tracks, region } = this.soundScope();
    this.change(
      'CLEAR STEP SOUNDS',
      () => {
        for (const t of tracks) {
          const cur = this.pattern.sounds?.[t.id] ?? {};
          const keep: Record<number, StepSound> = {};
          for (const [k, ss] of Object.entries(cur)) {
            const inside = !region || (Number(k) >= region[0] && Number(k) <= region[1]);
            if (!inside) keep[Number(k)] = ss;
          }
          setSounds(this.pattern, t.id, keep);
        }
      },
      ['pattern'],
    );
  }

  /** CLEAR VARIATIONS: empty the variation slots of the tracks in scope (locked slots stay). */
  clearVariations(): void {
    const { tracks } = this.soundScope();
    this.change('CLEAR VARIATIONS', () => {
      for (const t of tracks) {
        if (t.sound.soundLock || !t.sound.variations) continue;
        t.sound.variations = t.sound.variations.map((v, i) => (v && slotWritable(t.sound, i) ? null : v));
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
        const only: (Variation | null)[] = generateVariations({ ...t.sound, variations: undefined }, t.role, this.project.kit.synth.params, { seed, amount, locks: this.project.soundLocks, pitch: pitchPlanOf(this.project, t) });
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
    this.kitm?.projectReplaced();
    if (wasPlaying) this.scheduler.setTempo(proj.tempo);
    this.say(`PRESET ${spec.name}: ${spec.description}`);
  }

  newProject(): void {
    if (!this.initKit) return;
    this.history.push('NEW PROJECT');
    const p = defaultProject();
    p.kit = { name: 'INIT', seed: 0, synth: clone(this.initKit) };
    assignSeed(p.patterns[0]!, randomSeedValue());
    p.patterns[0]!.grids = generate(p.tracks, p.gen, p.patterns[0]!.seed, { steps: p.patterns[0]!.steps, res: 4 });
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
