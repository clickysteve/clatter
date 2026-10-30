/**
 * SAMPLE FACTORY: the session behind the FACTORY tab. Generates collections of LXR percussion
 * sounds, renders every one through the real engine, checks and measures it, and lets the player
 * audition, sort, favourite, select, send to the kit, save and export the best as a sample pack.
 *
 * Non-destructive: nothing in here writes to the project. Sounds live in this session; each is
 * rendered offline on a stage project of its own (`stageProject`), so the live kit, the tracks and
 * the sequencer are never touched. Only SEND TO KIT changes the project, as one undo step.
 *
 * Bounded: a batch renders a few sounds at a time (`concurrency`), hands the browser a turn
 * between every step, and keeps only what was measured (a few hundred numbers), never the audio. A
 * sound that is auditioned keeps its audio in a small cache that is emptied by CLEAR. Rendering
 * runs on the page, in slices of 10-100 ms, like the DRUM HITS and the kit export; the real-time
 * audio thread (the AudioWorklet) is not involved.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import { CHARACTERS, clampWildness, WILDNESS_DEFAULT, type Candidate } from '../sound/discover';
import { retarget } from './discover';
import type { KitHit } from '../audio/render';
import { exportable, type Exportable, PACK_DEFAULTS, PackCancelled, type PackOptions, type PackProgress, type PackResult, readPack, validateOptions } from '../export/packExport';
import type { Project } from '../model/types';
import { type SeedValue } from '../rhythm/seed';
import type { KitFlavour } from '../rhythm/styles';
import { INSTRUMENT_SPECS, analyseRender, clampCount, clampPct, designSound, FACTORY_DEFAULTS, planBatch, RENDER_MAX_SECONDS, stageProject, statusOf, type FactoryInstrument, type FactorySound, type MadeWith, type PlanSlot } from '../sound/factory';
import { DUPLICATE_DISTANCE, featureDistance, findDuplicates, nearest, wantedDistance } from '../sound/sampleQc';
import { SoundLibrary } from '../sound/soundLibrary';
import { INSTRUMENTS, type Instrument } from '../sound/voiceScore';

/** The most sounds a session holds; more would be more than the screen can show. */
export const COLLECTION_MAX = 512;
/** How many times a sound that is too close to its neighbours is drawn again (DIVERSITY). */
export const MAX_ATTEMPTS = 3;
/** Rendered audio kept for auditions: the last few, and no more than this many samples in all. */
const AUDIO_KEEP = 6;
const AUDIO_SAMPLES_MAX = 6 * 44100 * 2 * 4;

export type SortKey = 'order' | 'pitch' | 'duration' | 'brightness' | 'loudness' | 'tonality' | 'similarity';
export const SORTS: { id: SortKey; label: string }[] = [
  { id: 'order', label: 'GENERATION ORDER' },
  { id: 'pitch', label: 'PITCH' },
  { id: 'duration', label: 'DURATION' },
  { id: 'brightness', label: 'BRIGHTNESS' },
  { id: 'loudness', label: 'LOUDNESS' },
  { id: 'tonality', label: 'TONALITY' },
  { id: 'similarity', label: 'SIMILARITY' },
];

export interface FactoryView {
  sort: SortKey;
  desc: boolean;
  instrument: Instrument | 'all';
  qc: 'all' | 'passing' | 'flagged';
  favourites: boolean;
  selectedOnly: boolean;
  /** SIMILARITY sorts by closeness to this sound (null: the first favourite or selected one) */
  reference: string | null;
}

export interface FactoryJob {
  kind: 'generate' | 'retry' | 'regenerate' | 'import';
  total: number;
  done: number;
  failed: number;
  cancelling: boolean;
}

export interface PackState {
  running: boolean;
  cancelling: boolean;
  progress: PackProgress | null;
  last: { ok: boolean; text: string; warnings: string[] } | null;
}

/** What the session needs from the application; the tests supply their own. */
export interface FactoryDeps {
  project(): Project;
  flavour(): KitFlavour;
  drawSeed(): SeedValue;
  /** one hit of the stage project's track, rendered by the real engine */
  render(p: Project, o: { wet: boolean; tail: 'auto' | number; maxSeconds: number }): Promise<KitHit>;
  runPack(project: Project, sounds: FactorySound[], options: PackOptions, onProgress: (p: PackProgress) => void, signal: AbortSignal): Promise<PackResult>;
  deliver(file: PackResult['file']): void;
  play(audio: Float32Array[]): void | Promise<void>;
  stop(): void;
  /** write a candidate into a kit voice as one undo step */
  apply(c: Candidate): { locked: number };
  changed(): void;
  say(text: string): void;
  notify(text: string, level: 'info' | 'error'): void;
  yieldToUi?(): Promise<void>;
  /** sounds rendered at the same time (default 2) */
  concurrency?: number;
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

export class FactorySession {
  instrument: FactoryInstrument = FACTORY_DEFAULTS.instrument;
  count: number = FACTORY_DEFAULTS.count;
  character: KitFlavour | 'style' = 'style';
  /** 0-1, as the other WILDNESS controls */
  wildness = WILDNESS_DEFAULT;
  variation: number = FACTORY_DEFAULTS.variation;
  diversity: number = FACTORY_DEFAULTS.diversity;
  /** quality filter: sounds that fail a quality check cannot be selected in bulk or exported until accepted (KEEP) */
  qcStrict = true;
  view: FactoryView = { sort: 'order', desc: false, instrument: 'all', qc: 'all', favourites: false, selectedOnly: false, reference: null };
  pack: PackOptions = { ...PACK_DEFAULTS, tail: { ...PACK_DEFAULTS.tail } };
  readonly library: SoundLibrary;
  sounds: FactorySound[] = [];
  job: FactoryJob | null = null;
  packState: PackState = { running: false, cancelling: false, progress: null, last: null };
  /** the sound being heard */
  playing: string | null = null;
  /** renders started (for the tests and the screen) */
  renders = 0;

  private ctl: AbortController | null = null;
  private packCtl: AbortController | null = null;
  private nextOrder = 1;
  private serials: Partial<Record<Instrument, number>> = {};
  private audio = new Map<string, Float32Array[]>();
  private playSeq = 0;
  private pendingChange = false;

  constructor(private readonly d: FactoryDeps, library?: SoundLibrary) {
    this.library = library ?? new SoundLibrary();
  }

  // ---------------------------------------------------------------- reading
  get busy(): boolean {
    return !!this.job;
  }

  get effectiveCharacter(): KitFlavour {
    return this.character === 'style' ? this.d.flavour() : this.character;
  }

  byId(id: string): FactorySound | undefined {
    return this.sounds.find((s) => s.id === id);
  }

  get selected(): FactorySound[] {
    return this.sounds.filter((s) => s.selected);
  }

  get ready(): FactorySound[] {
    return this.sounds.filter((s) => s.status === 'ready');
  }

  counts(): { total: number; ready: number; failed: number; queued: number; selected: number; favourites: number; flagged: number } {
    const c = { total: this.sounds.length, ready: 0, failed: 0, queued: 0, selected: 0, favourites: 0, flagged: 0 };
    for (const s of this.sounds) {
      if (s.status === 'ready') c.ready++;
      else if (s.status === 'failed') c.failed++;
      else c.queued++;
      if (s.selected) c.selected++;
      if (s.favourite) c.favourites++;
      if (s.status === 'ready' && statusOf(s) !== 'ok') c.flagged++;
    }
    return c;
  }

  private touch(s: FactorySound): void {
    s.rev++;
  }

  /** Tell the screen. While a batch runs the notifications are spaced out: the list redraws only what moved. */
  private changed(now = false): void {
    if (now || !this.job) {
      this.pendingChange = false;
      this.d.changed();
      return;
    }
    if (this.pendingChange) return;
    this.pendingChange = true;
    setTimeout(() => {
      if (!this.pendingChange) return;
      this.pendingChange = false;
      this.d.changed();
    }, 90);
  }

  // ---------------------------------------------------------------- the visible list
  /** The sounds the browser shows: filtered, then sorted. */
  visible(): FactorySound[] {
    const v = this.view;
    let list = this.sounds.filter((s) => {
      if (v.instrument !== 'all' && s.instrument !== v.instrument) return false;
      if (v.favourites && !s.favourite) return false;
      if (v.selectedOnly && !s.selected) return false;
      if (v.qc !== 'all') {
        if (s.status !== 'ready') return false;
        const ok = statusOf(s) === 'ok' || s.keep;
        if (v.qc === 'passing' ? !ok : ok) return false;
      }
      return true;
    });
    const ref = this.referenceSound();
    const key = (s: FactorySound): number => {
      const i = s.info;
      switch (v.sort) {
        case 'order':
          return s.order;
        case 'pitch':
          // sounds without a trustworthy pitch go last, whichever way it is sorted
          return i?.pitch.reliable && i.pitch.hz !== null ? i.pitch.hz : Number.NaN;
        case 'duration':
          return i ? i.seconds : Number.NaN;
        case 'brightness':
          return i && i.centroid > 0 ? i.centroid : Number.NaN;
        case 'loudness':
          return i && i.rms > 0 ? 20 * Math.log10(i.rms) : Number.NaN;
        case 'tonality':
          return i ? i.tonality : Number.NaN;
        case 'similarity':
          return i && ref?.info ? featureDistance(i.features, ref.info.features) : Number.NaN;
      }
    };
    const sign = v.desc ? -1 : 1;
    list = list
      .map((s) => ({ s, k: key(s) }))
      .sort((a, b) => {
        const an = Number.isNaN(a.k);
        const bn = Number.isNaN(b.k);
        if (an || bn) return an === bn ? a.s.order - b.s.order : an ? 1 : -1;
        return sign * (a.k - b.k) || a.s.order - b.s.order;
      })
      .map((x) => x.s);
    return list;
  }

  /** The sound SIMILARITY measures against: the one chosen, else the first favourite, else the first selected, else the first ready sound. */
  referenceSound(): FactorySound | undefined {
    const r = this.view.reference ? this.byId(this.view.reference) : undefined;
    if (r?.info) return r;
    return this.sounds.find((s) => s.favourite && s.info) ?? this.sounds.find((s) => s.selected && s.info) ?? this.sounds.find((s) => s.info);
  }

  setView(v: Partial<FactoryView>): void {
    Object.assign(this.view, v);
    this.changed(true);
  }

  // ---------------------------------------------------------------- generating
  private madeWith(seed: SeedValue): MadeWith {
    return { character: this.effectiveCharacter, wildness: Math.round(clampWildness(this.wildness) * 100), variation: clampPct(this.variation, FACTORY_DEFAULTS.variation), diversity: clampPct(this.diversity, FACTORY_DEFAULTS.diversity), seed };
  }

  private design(instrument: Instrument, serial: number, draw: number, attempt: number, made: MadeWith): Candidate {
    return designSound({ base: this.d.project().kit.synth, seed: made.seed, instrument, serial, draw, attempt, character: made.character, wildness: made.wildness, variation: made.variation });
  }

  private makeSound(slot: PlanSlot, made: MadeWith): FactorySound {
    this.serials[slot.instrument] = Math.max(this.serials[slot.instrument] ?? 0, slot.serial);
    return { id: `${slot.instrument}-${slot.serial}`, instrument: slot.instrument, serial: slot.serial, order: slot.order, status: 'queued', draw: 0, attempt: 0, candidate: this.design(slot.instrument, slot.serial, 0, 0, made), made, selected: false, favourite: false, keep: false, rev: 0 };
  }

  /** GENERATE: a new batch of COUNT sounds, added to the collection. Returns when the batch is done, cancelled or failed. */
  async generate(): Promise<void> {
    if (this.job) return;
    const count = clampCount(this.count);
    if (this.sounds.length + count > COLLECTION_MAX) {
      this.d.say(`THE COLLECTION HOLDS ${COLLECTION_MAX} SOUNDS: CLEAR SOME OR GENERATE FEWER`);
      return;
    }
    const seed = this.d.drawSeed();
    const made = this.madeWith(seed);
    const first: Partial<Record<Instrument, number>> = {};
    for (const i of INSTRUMENTS) first[i] = (this.serials[i] ?? 0) + 1;
    const plan = planBatch({ instrument: this.instrument, count, seed }, first);
    const fresh = plan.map((p) => this.makeSound({ ...p, order: this.nextOrder++ }, made));
    this.sounds.push(...fresh);
    await this.run('generate', fresh);
    const c = this.counts();
    this.d.say(`GENERATED ${fresh.filter((s) => s.status === 'ready').length} OF ${count} · ${c.flagged} FLAGGED · SEED ${(seed.text ?? String(seed.seed)).toUpperCase()}`);
  }

  /** RETRY: render again every sound that failed or was cancelled. */
  async retry(): Promise<void> {
    if (this.job) return;
    const todo = this.sounds.filter((s) => s.status === 'failed' || s.status === 'cancelled');
    if (!todo.length) return;
    for (const s of todo) {
      s.status = 'queued';
      delete s.error;
      this.touch(s);
    }
    await this.run('retry', todo);
  }

  /** REGENERATE SELECTED: the next draw of each selected sound (the same slot and seed; a new design). Favourites and selection stay, accepted-anyway does not. */
  async regenerateSelected(): Promise<void> {
    if (this.job) return;
    const todo = this.sounds.filter((s) => s.selected && s.status !== 'queued' && s.status !== 'rendering');
    if (!todo.length) return;
    for (const s of todo) {
      s.draw++;
      s.attempt = 0;
      s.candidate = this.design(s.instrument, s.serial, s.draw, 0, s.made);
      s.status = 'queued';
      s.keep = false;
      delete s.info;
      delete s.dupOf;
      delete s.error;
      this.audio.delete(s.id);
      this.touch(s);
    }
    await this.run('regenerate', todo);
    this.d.say(`REGENERATED ${todo.length} SOUND${todo.length === 1 ? '' : 'S'}`);
  }

  /** CANCEL: stop the batch after the sounds being rendered now; what is done stays, the rest can be retried. */
  cancel(): void {
    if (!this.job || this.job.cancelling) return;
    this.job.cancelling = true;
    this.ctl?.abort();
    this.d.say('CANCELLING…');
    this.changed(true);
  }

  /** CLEAR: remove every sound except the favourites (all: those too). Stops what is playing; frees the cached audio. */
  clear(all = false): void {
    if (this.job) return;
    this.sounds = all ? [] : this.sounds.filter((s) => s.favourite);
    this.audio.clear();
    if (all) {
      this.nextOrder = 1;
      this.serials = {};
    }
    this.stop();
    this.view.reference = this.view.reference && this.byId(this.view.reference) ? this.view.reference : null;
    this.changed(true);
  }

  private yieldUi(): Promise<void> {
    return (this.d.yieldToUi ?? tick)();
  }

  /** Render, measure and settle a list of sounds, a few at a time. */
  private async run(kind: FactoryJob['kind'], list: FactorySound[]): Promise<void> {
    this.ctl = new AbortController();
    const signal = this.ctl.signal;
    this.job = { kind, total: list.length, done: 0, failed: 0, cancelling: false };
    this.changed(true);
    try {
      const queue = list.slice();
      const worker = async () => {
        for (;;) {
          if (signal.aborted) return;
          const s = queue.shift();
          if (!s) return;
          await this.process(s, signal);
          this.job!.done++;
          this.changed();
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, Math.min(4, this.d.concurrency ?? 2)) }, worker));
      // sounds the batch never reached
      for (const s of list) if (s.status === 'queued') (s.status = 'cancelled'), this.touch(s);
      if (!signal.aborted) await this.settle(list, signal);
      this.markDuplicates();
    } finally {
      this.job = null;
      this.ctl = null;
      this.changed(true);
    }
  }

  /** The first design of a sound: render it, measure it, keep the numbers. */
  private async process(s: FactorySound, signal: AbortSignal): Promise<void> {
    s.status = 'rendering';
    this.touch(s);
    try {
      s.info = await this.measureCandidate(s.instrument, s.candidate);
      s.status = 'ready';
    } catch (e) {
      s.status = 'failed';
      s.error = e instanceof Error ? e.message : String(e);
      if (this.job) this.job.failed++;
    }
    this.touch(s);
    if (!signal.aborted) await this.yieldUi();
  }

  private async measureCandidate(instrument: Instrument, c: Candidate) {
    this.renders++;
    const hit = await this.d.render(stageProject(this.d.project(), instrument, c), { wet: false, tail: 'auto', maxSeconds: RENDER_MAX_SECONDS });
    await this.yieldUi();
    return analyseRender(hit.audio, hit.rate, instrument, hit.truncated);
  }

  /**
   * DIVERSITY: in generation order, a sound whose audio is closer to an earlier sound of its
   * instrument than the diversity asks for is drawn again (up to MAX_ATTEMPTS more times) and the
   * most distinct attempt is kept. At diversity 0 nothing is redrawn. Decisions depend only on the
   * sounds before it, so the result does not depend on how many render at once.
   */
  private async settle(list: FactorySound[], signal: AbortSignal): Promise<void> {
    const mine = new Set(list.map((s) => s.id));
    for (const s of list.slice().sort((a, b) => a.order - b.order)) {
      if (s.status !== 'ready' || !s.info) continue;
      const want = wantedDistance(s.made.diversity / 100);
      if (s.made.diversity <= 0) continue;
      const others = () => this.sounds.filter((o) => o !== s && o.instrument === s.instrument && o.status === 'ready' && o.info && (o.order < s.order || !mine.has(o.id))).map((o) => o.info!.features);
      let best = { dist: nearest(s.info.features, others()), c: s.candidate, info: s.info, attempt: s.attempt };
      for (let a = s.attempt + 1; best.dist < want && a <= MAX_ATTEMPTS && !signal.aborted; a++) {
        const c = this.design(s.instrument, s.serial, s.draw, a, s.made);
        try {
          const info = await this.measureCandidate(s.instrument, c);
          if (info.flags.some((f) => f.severity === 'fail')) continue;
          const dist = nearest(info.features, others());
          if (dist > best.dist) best = { dist, c, info, attempt: a };
        } catch {
          /* keep what there is */
        }
      }
      if (best.c !== s.candidate) {
        s.candidate = best.c;
        s.info = best.info;
        s.attempt = best.attempt;
        this.audio.delete(s.id);
        this.touch(s);
      }
    }
  }

  /** Near-duplicates across the collection: the later of two sounds closer than DUPLICATE_DISTANCE is flagged. */
  markDuplicates(): void {
    const items = this.sounds.filter((s) => s.status === 'ready' && s.info).map((s) => ({ id: s.id, group: s.instrument, order: s.order, features: s.info!.features }));
    const dups = findDuplicates(items, DUPLICATE_DISTANCE);
    for (const s of this.sounds) {
      const d = dups.get(s.id);
      if (d !== s.dupOf) {
        if (d) s.dupOf = d;
        else delete s.dupOf;
        this.touch(s);
      }
    }
  }

  // ---------------------------------------------------------------- selecting
  select(id: string, on?: boolean): void {
    const s = this.byId(id);
    if (!s) return;
    s.selected = on ?? !s.selected;
    this.touch(s);
    this.changed(true);
  }

  /** Select (or deselect) a list of sounds; with the quality filter on, sounds that fail a check are left out unless accepted. */
  selectMany(list: FactorySound[], on = true): number {
    let n = 0;
    for (const s of list) {
      if (s.status !== 'ready') continue;
      if (on && this.qcStrict && !s.keep && s.info?.flags.some((f) => f.severity === 'fail')) continue;
      if (s.selected !== on) {
        s.selected = on;
        this.touch(s);
        n++;
      }
    }
    this.changed(true);
    return n;
  }

  /** The sounds in view: select all, none. */
  selectVisible(on = true): number {
    return this.selectMany(this.visible(), on);
  }

  invertVisible(): void {
    for (const s of this.visible()) {
      if (s.status !== 'ready') continue;
      if (!s.selected && this.qcStrict && !s.keep && s.info?.flags.some((f) => f.severity === 'fail')) continue;
      s.selected = !s.selected;
      this.touch(s);
    }
    this.changed(true);
  }

  favourite(id: string, on?: boolean): void {
    const s = this.byId(id);
    if (!s) return;
    s.favourite = on ?? !s.favourite;
    this.touch(s);
    this.changed(true);
  }

  /** Accept a flagged sound: it may be exported whatever the quality checks say. */
  keep(id: string, on?: boolean): void {
    const s = this.byId(id);
    if (!s) return;
    s.keep = on ?? !s.keep;
    this.touch(s);
    this.changed(true);
  }

  setQcStrict(on: boolean): void {
    this.qcStrict = on;
    this.changed(true);
  }

  // ---------------------------------------------------------------- hearing
  private async audible(s: FactorySound): Promise<Float32Array[]> {
    const hit = this.audio.get(s.id);
    if (hit) return hit;
    this.renders++;
    const r = await this.d.render(stageProject(this.d.project(), s.instrument, s.candidate), { wet: false, tail: 'auto', maxSeconds: RENDER_MAX_SECONDS });
    this.audio.set(s.id, r.audio);
    // a few sounds only, and never a long list of long ones
    let samples = 0;
    for (const a of this.audio.values()) samples += (a[0]?.length ?? 0) * a.length;
    while (this.audio.size > AUDIO_KEEP || (samples > AUDIO_SAMPLES_MAX && this.audio.size > 1)) {
      const k = this.audio.keys().next().value!;
      const a = this.audio.get(k)!;
      samples -= (a[0]?.length ?? 0) * a.length;
      this.audio.delete(k);
    }
    return r.audio;
  }

  /** Play one sound: rendered by the engine and played on its own. A newer audition replaces an older one. */
  async audition(id: string): Promise<void> {
    const s = this.byId(id);
    if (!s || s.status !== 'ready') return;
    const seq = ++this.playSeq;
    this.playing = id;
    this.changed(true);
    try {
      const audio = await this.audible(s);
      if (seq !== this.playSeq) return;
      await this.d.play(audio);
    } catch (e) {
      if (seq === this.playSeq) this.d.say('AUDITION FAILED: ' + (e instanceof Error ? e.message : String(e)).toUpperCase());
    }
  }

  stop(): void {
    this.playSeq++;
    this.d.stop();
    this.playing = null;
    this.changed(true);
  }

  // ---------------------------------------------------------------- using the sounds
  /** SEND TO KIT: the sound becomes the voice of a kit slot (0-5) as one undo step. The kit is untouched until this is pressed. */
  sendToKit(id: string, voice?: number): { locked: number } | null {
    const s = this.byId(id);
    if (!s || s.status !== 'ready') return null;
    const target = voice ?? s.candidate.voice;
    let c = s.candidate;
    if (c.voice !== target) c = retarget(c, target);
    const r = this.d.apply(c);
    this.d.say(`SENT ${s.candidate.name} TO KIT SLOT ${target + 1}${r.locked ? ` · ${r.locked} LOCKED PARAMETERS KEPT` : ''} · UNDO RESTORES THE KIT`);
    return r;
  }

  /** SAVE: the sounds to the sound library (the same file format as SOUND > DISCOVER; its pitch goes with it when reliable). */
  saveToLibrary(list: FactorySound[]): number {
    let n = 0;
    for (const s of list) {
      if (s.status !== 'ready' || !s.info) continue;
      const p = s.info.pitch;
      const pitch = p.reliable && p.note && p.hz !== null ? { note: p.note, hz: Math.round(p.hz * 100) / 100 } : p.kind === 'skipped' ? undefined : { kind: p.kind as 'stable' };
      this.library.add(s.candidate, `${INSTRUMENT_SPECS[s.instrument].short} ${String(s.serial).padStart(3, '0')}`, pitch as never);
      n++;
    }
    this.d.say(`SAVED ${n} SOUND${n === 1 ? '' : 'S'} TO THE LIBRARY`);
    this.changed(true);
    return n;
  }

  // ---------------------------------------------------------------- the pack
  exportable(): Exportable {
    return exportable(this.selected, this.qcStrict);
  }

  /** EXPORT PACK: the selected sounds as a ZIP. Returns when the file has been handed over, or the export was cancelled or failed. */
  async exportPack(): Promise<void> {
    if (this.packState.running) return;
    const bad = validateOptions(this.pack);
    if (bad) {
      this.d.notify(bad, 'error');
      return;
    }
    const { ok, blocked } = this.exportable();
    if (!ok.length) {
      this.d.notify(blocked.length ? `${blocked.length} SELECTED SOUND${blocked.length === 1 ? '' : 'S'} FAIL THE QUALITY CHECKS: ACCEPT THEM (KEEP) OR TURN THE QUALITY FILTER OFF` : 'SELECT SOME SOUNDS FIRST', 'error');
      return;
    }
    this.packCtl = new AbortController();
    this.packState = { running: true, cancelling: false, progress: null, last: null };
    this.d.changed();
    try {
      const res = await this.d.runPack(this.d.project(), ok, this.pack, (p) => {
        this.packState = { ...this.packState, progress: p };
        this.changed(true);
      }, this.packCtl.signal);
      this.d.deliver(res.file);
      const w = res.warnings.length;
      const text = `EXPORTED ${res.file.name}: ${res.files} FILES${blocked.length ? `, ${blocked.length} HELD BACK BY THE QUALITY FILTER` : ''}${w ? `, ${w} WARNING${w === 1 ? '' : 'S'} (SEE pack.json)` : ''}`;
      this.packState = { ...this.packState, last: { ok: true, text, warnings: res.warnings } };
      this.d.notify(text, w || blocked.length ? 'error' : 'info');
    } catch (e) {
      if (e instanceof PackCancelled || this.packCtl.signal.aborted) {
        this.packState = { ...this.packState, last: { ok: false, text: 'PACK EXPORT CANCELLED: NOTHING WAS SAVED', warnings: [] } };
        this.d.notify('PACK EXPORT CANCELLED: NOTHING WAS SAVED', 'info');
      } else {
        const text = `PACK EXPORT FAILED: ${e instanceof Error ? e.message : String(e)}`;
        this.packState = { ...this.packState, last: { ok: false, text, warnings: [] } };
        this.d.notify(text, 'error');
      }
    } finally {
      this.packState = { ...this.packState, running: false, cancelling: false };
      this.packCtl = null;
      this.d.changed();
    }
  }

  cancelPack(): void {
    if (!this.packState.running || this.packState.cancelling) return;
    this.packState = { ...this.packState, cancelling: true };
    this.packCtl?.abort();
    this.d.changed();
  }

  /** IMPORT: sounds from a pack (its ZIP or its pack.json) are added to the collection and rendered again, so what you hear is what the pack was made from. */
  async importPack(bytes: Uint8Array): Promise<number> {
    if (this.job) return 0;
    const { sounds, skipped } = await readPack(bytes);
    if (!sounds.length) throw new Error('THE PACK HOLDS NO SOUNDS CLATTER CAN MAKE AGAIN');
    if (this.sounds.length + sounds.length > COLLECTION_MAX) throw new Error(`THE COLLECTION HOLDS ${COLLECTION_MAX} SOUNDS: CLEAR SOME FIRST`);
    const fresh: FactorySound[] = sounds.map((im) => {
      // a number is never used twice for an instrument: a sound that arrives with a taken one gets the next
      const taken = this.sounds.some((s) => s.instrument === im.instrument && s.serial === im.serial);
      const serial = taken ? (this.serials[im.instrument] ?? 0) + 1 : im.serial;
      const made: MadeWith = { character: (CHARACTERS.find((c) => c.id === im.made.character)?.id ?? 'machine'), wildness: im.made.wildness, variation: im.made.variation, diversity: im.made.diversity, seed: { seed: im.made.seed, ...(im.made.seedText ? { text: im.made.seedText } : {}) } };
      const c = this.d.project();
      const base = designSound({ base: c.kit.synth, seed: made.seed, instrument: im.instrument, serial, draw: im.made.draw, attempt: im.made.attempt, character: made.character, wildness: made.wildness, variation: made.variation });
      const candidate: Candidate = { ...base, voice: im.candidate.voice, values: im.candidate.values, lfo: im.candidate.lfo, vel: im.candidate.vel, name: `${INSTRUMENT_SPECS[im.instrument].short} ${String(serial).padStart(3, '0')}`, origin: { ...base.origin, voice: im.candidate.voice } };
      this.serials[im.instrument] = Math.max(this.serials[im.instrument] ?? 0, serial);
      return { id: `${im.instrument}-${serial}`, instrument: im.instrument, serial, order: this.nextOrder++, status: 'queued', draw: im.made.draw, attempt: im.made.attempt, candidate, made, selected: true, favourite: im.favourite, keep: false, imported: true, rev: 0 };
    });
    this.sounds.push(...fresh);
    await this.run('import', fresh);
    this.d.say(`IMPORTED ${fresh.filter((s) => s.status === 'ready').length} SOUNDS${skipped ? `, ${skipped} SKIPPED` : ''}`);
    return fresh.length;
  }

  /** A new project: nothing carries over. */
  reset(): void {
    this.ctl?.abort();
    this.sounds = [];
    this.audio.clear();
    this.nextOrder = 1;
    this.serials = {};
    this.view.reference = null;
    this.stop();
  }
}
