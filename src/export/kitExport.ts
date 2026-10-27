/**
 * The kit exporter: every instrument of the current kit rendered as individual WAV files, in a
 * ZIP with a kit.json that says exactly what each file is.
 *
 * Each file is a fresh single-hit render of one track alone in a private engine (the same
 * synthesis and sample/hybrid code as playback, see renderKitHit): nothing is recorded from the
 * running instrument, nothing leaks between instruments, and the same project gives the same
 * files. The project being exported is only ever cloned.
 *
 * Pitched sounds are retuned in the engine: the target note is reached by moving the hit's note
 * (the LXR voice's note input, whole semitones), the oscillator FINE parameter (the cents the
 * note cannot reach) and, for the sample layer, its playback rate. The starting point is the
 * pitch the TUNER measured on the rendered audio (src/analysis), so FM, the pitch envelope and
 * filters are accounted for as they sound; every file is then measured again and the tuning
 * corrected until it is within tolerance. A sound that has no single reliable pitch (noise,
 * cymbals, bells) is exported at its original pitch only, without a note name, and says why.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import { createZip, fileName } from '@slopfactory/core/export';
import { analysePitch, hzToMidiFloat, midiToHz, noteName, type PitchAnalysis } from '../analysis/pitch';
import { analyseTarget, type PitchRecord, type PitchTarget } from '../analysis/trackPitch';
import type { SampleLibrary } from '../audio/library';
import { renderKitHit } from '../audio/render';
import { clone, type Project, type Track, type Variation } from '../model/types';
import { describeScale, notesInRange, rootName, scaleSteps, trackScaleState, type ScaleSpec } from '../music/scale';
import { untuned } from '../music/tuning';
import { chromaticRange, fileNote, MIDI_MAX, MIDI_MIN, parseNote, parseNoteList, scaleNotes, SCALES } from './notes';
import { encodeWav, WAV_FORMATS, type WavFormat } from './wavFile';

export const KIT_EXPORT_VERSION = 1;
export const KIT_EXPORT_FORMAT = 'clatter-kit-export';

/**
 * What pitch the files are rendered at:
 *   original   the sound as it is before any scale tuning, at the pitch it has (no note is forced)
 *   project    each instrument as the project plays it: scale-tuned where it is scale-locked, named by what was measured
 *   global     the project's global scale, every note of it in the range
 *   track      each instrument's own scale (its GLOBAL or CUSTOM setting), every note of it in the range
 *   scale      a scale chosen here (root and type), every note of it in the range
 *   chromatic  every semitone in the range
 *   custom     a list of notes
 */
export type PitchMode = 'original' | 'project' | 'global' | 'track' | 'chromatic' | 'scale' | 'custom';
export type Processing = 'dry' | 'wet' | 'both';
export type VariationMode = 'base' | 'all' | 'selected';
export const LAYER_CHOICES = [1, 4, 8, 16] as const;
export type LayerCount = (typeof LAYER_CHOICES)[number];

export interface KitExportOptions {
  instruments: 'all' | 'selected';
  /** track ids (used when `instruments` is "selected") */
  trackIds: string[];
  variations: VariationMode;
  /** used when `variations` is "selected": null = the base sound, 0-3 = variation A-D */
  slots: (number | null)[];
  layers: LayerCount;
  pitch: {
    mode: PitchMode;
    /** chromatic range and the range a scale is taken over: MIDI notes, or names ("G1") */
    lo: string;
    hi: string;
    root: string;
    scale: string;
    /** the custom list: notes and ranges ("C2-C3, F#3, 60") */
    list: string;
  };
  format: WavFormat;
  processing: Processing;
  tail: { mode: 'auto' | 'custom'; seconds: number };
  normalise: boolean;
}

export const KIT_EXPORT_DEFAULTS: KitExportOptions = {
  instruments: 'all',
  trackIds: [],
  variations: 'base',
  slots: [null],
  layers: 1,
  pitch: { mode: 'original', lo: 'C2', hi: 'C3', root: 'C', scale: 'minor', list: 'C2, E2, G2' },
  format: 'pcm24',
  processing: 'dry',
  tail: { mode: 'auto', seconds: 2 },
  normalise: true,
};

export const LIMITS = {
  maxFiles: 4096,
  minTail: 0.05,
  maxTail: 30,
  /** the longest automatic tail followed (DRY, WET) */
  autoMaxDry: 10,
  autoMaxWet: 15,
  /** normalised peak: -1 dBFS */
  peakTarget: 0.8912509,
  /** verification: within this many cents the note is confirmed, within `approx` it is kept with a warning, beyond it the file is not written */
  confirmCents: 15,
  approxCents: 40,
  /** lowest pitch the analysis can confirm */
  minVerifiableHz: 32,
  /** below this analysis confidence the sound is not retuned */
  minConfidence: 0.5,
  /** one instrument's audio kept in memory while normalising (bytes, estimated) */
  maxGroupBytes: 640 * 1024 * 1024,
} as const;

export type KitExportStage = 'analysing' | 'rendering' | 'packing' | 'done';

export interface KitProgress {
  stage: KitExportStage;
  /** the instrument being worked on */
  instrument: string;
  /** the file being rendered (rendering stage) */
  file?: string;
  done: number;
  total: number;
  warnings: number;
}

export class KitExportCancelled extends Error {
  constructor() {
    super('EXPORT CANCELLED');
    this.name = 'KitExportCancelled';
  }
}

export interface KitExportDeps {
  module: WebAssembly.Module;
  library: SampleLibrary | null;
  /** the pitch analysis of a sound (the app passes one that uses and fills its cache) */
  analyse?: (project: Project, target: PitchTarget) => Promise<PitchRecord>;
  onProgress?: (p: KitProgress) => void;
  signal?: AbortSignal;
  /** give the browser a turn between files (default: a macrotask) */
  yieldToUi?: () => Promise<void>;
  now?: () => Date;
  /** shown in kit.json */
  generator?: string;
}

export interface KitExportResult {
  file: { name: string; data: Uint8Array; type: string };
  files: number;
  warnings: string[];
  skipped: { file: string; reason: string }[];
  manifest: KitManifest;
}

// ---------------------------------------------------------------------------- options

export interface ResolvedOptions {
  tracks: Track[];
  slots: (number | null)[];
  /** MIDI notes to render, or null for the original pitch */
  notes: number[] | null;
  scaleInfo: { root: number; rootName: string; scale: string; label: string; steps: number[]; notes: number[] } | null;
  /** TRACK mode: the notes of each instrument's own scale (an instrument without one is absent and exports at its original pitch) */
  perTrack?: Map<string, { spec: ScaleSpec; notes: number[] }>;
  /** the sounds are rendered as the project plays them (scale tuning included) */
  tuned: boolean;
  processing: ('dry' | 'wet')[];
}

export const slotLabel = (slot: number | null): string => (slot === null ? 'BASE' : 'ABCD'[slot]!);

/** Check the options against the project; the first problem is the error, in the voice of the rest of the app. */
export function resolveOptions(p: Project, o: KitExportOptions): ResolvedOptions | { error: string } {
  const tracks = o.instruments === 'all' ? p.tracks.slice() : p.tracks.filter((t) => o.trackIds.includes(t.id));
  if (!tracks.length) return { error: o.instruments === 'all' ? 'THIS KIT HAS NO TRACKS' : 'SELECT AT LEAST ONE INSTRUMENT' };
  if (!(LAYER_CHOICES as readonly number[]).includes(o.layers)) return { error: 'VELOCITY LAYERS MUST BE 1, 4, 8 OR 16' };
  if (!(o.format in WAV_FORMATS)) return { error: 'UNKNOWN AUDIO FORMAT' };
  if (o.tail.mode === 'custom' && !(o.tail.seconds >= LIMITS.minTail && o.tail.seconds <= LIMITS.maxTail)) return { error: `TAIL MUST BE FROM ${LIMITS.minTail} TO ${LIMITS.maxTail} SECONDS` };
  let slots: (number | null)[];
  if (o.variations === 'base') slots = [null];
  else if (o.variations === 'all') slots = [null, 0, 1, 2, 3];
  else slots = [...new Set(o.slots)].sort((a, b) => (a ?? -1) - (b ?? -1));
  if (!slots.length) return { error: 'SELECT AT LEAST ONE VARIATION' };
  if (slots.some((s) => s !== null && !(Number.isInteger(s) && s >= 0 && s <= 3))) return { error: 'VARIATIONS ARE BASE AND A-D' };
  const processing: ('dry' | 'wet')[] = o.processing === 'both' ? ['dry', 'wet'] : [o.processing];

  let notes: number[] | null = null;
  let scaleInfo: ResolvedOptions['scaleInfo'] = null;
  let perTrack: ResolvedOptions['perTrack'];
  const pm = o.pitch;
  if (pm.mode === 'global' || pm.mode === 'track') {
    const lo = parseNote(pm.lo);
    const hi = parseNote(pm.hi);
    if (lo === null) return { error: `NOT A NOTE: "${pm.lo}" (USE C2 OR A NUMBER 0-127)` };
    if (hi === null) return { error: `NOT A NOTE: "${pm.hi}" (USE C3 OR A NUMBER 0-127)` };
    if (pm.mode === 'global') {
      const g = p.scale;
      if (!g) return { error: 'THE PROJECT HAS NO GLOBAL SCALE: SET ONE IN SOUND > SCALE' };
      notes = notesInRange(g, lo, hi);
      scaleInfo = { root: g.root, rootName: rootName(g.root), scale: g.type, label: describeScale(g).replace(/^\S+ /, ''), steps: scaleSteps(g).slice(), notes };
    } else {
      perTrack = new Map();
      for (const t of tracks) {
        const st = trackScaleState(p, t);
        if (st.spec) perTrack.set(t.id, { spec: st.spec, notes: notesInRange(st.spec, lo, hi) });
      }
      if (!perTrack.size) return { error: 'NO SELECTED INSTRUMENT HAS A SCALE IN FORCE' };
    }
  } else if (pm.mode === 'chromatic' || pm.mode === 'scale') {
    const lo = parseNote(pm.lo);
    const hi = parseNote(pm.hi);
    if (lo === null) return { error: `NOT A NOTE: "${pm.lo}" (USE C2 OR A NUMBER 0-127)` };
    if (hi === null) return { error: `NOT A NOTE: "${pm.hi}" (USE C3 OR A NUMBER 0-127)` };
    if (pm.mode === 'chromatic') notes = chromaticRange(lo, hi);
    else {
      const root = parseNote(/\d/.test(pm.root) ? pm.root : pm.root + '4');
      if (root === null) return { error: `NOT A NOTE: "${pm.root}" (USE A ROOT LIKE C OR F#)` };
      if (!SCALES[pm.scale]) return { error: 'UNKNOWN SCALE' };
      notes = scaleNotes(root, pm.scale, lo, hi);
      scaleInfo = { root: root % 12, rootName: noteName(root).replace(/-?\d+$/, ''), scale: pm.scale, label: SCALES[pm.scale]!.label, steps: SCALES[pm.scale]!.steps.slice(), notes };
    }
  } else if (pm.mode === 'custom') {
    const r = parseNoteList(pm.list);
    if ('error' in r) return r;
    notes = r.notes;
  }
  if (notes && !notes.length) return { error: 'NO NOTES IN THAT RANGE' };
  if (perTrack && [...perTrack.values()].some((x) => !x.notes.length)) return { error: 'AN INSTRUMENT\'S SCALE HAS NO NOTES IN THAT RANGE' };
  return { tracks, slots, notes, scaleInfo, ...(perTrack ? { perTrack } : {}), tuned: pm.mode === 'project', processing };
}

/** Velocity layers: N layers split 1-127 evenly; each is rendered at the top of its range (the last at 127). */
export function velocityLayers(n: number): { index: number; vel: number; lo: number; hi: number }[] {
  const out: { index: number; vel: number; lo: number; hi: number }[] = [];
  let prev = 0;
  for (let k = 1; k <= n; k++) {
    const hi = k === n ? 127 : Math.round((127 * k) / n);
    out.push({ index: k - 1, vel: hi, lo: prev + 1, hi });
    prev = hi;
  }
  return out;
}

// ---------------------------------------------------------------------------- names

/** A file-name part: upper case, letters and digits, single underscores. */
export function nameSlug(name: string): string {
  const s = name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return s || 'TRACK';
}

export interface FileNameParts {
  slug: string;
  note: number | null;
  vel: number | null;
  slot: number | null;
  processing: 'dry' | 'wet' | null;
}

/** KICK_G1, HI_TOM_A2_VEL096, PERC_F3_VAR_B, KICK_G1_VEL127_DRY */
export function kitFileName(p: FileNameParts): string {
  const parts = [p.slug];
  if (p.note !== null) parts.push(fileNote(p.note));
  if (p.vel !== null) parts.push('VEL' + String(p.vel).padStart(3, '0'));
  if (p.slot !== null) parts.push('VAR', 'ABCD'[p.slot]!);
  if (p.processing) parts.push(p.processing.toUpperCase());
  return parts.join('_') + '.wav';
}

/** Make a name unique among those taken (case-insensitively): FOO.wav, FOO_2.wav, FOO_3.wav. */
export function uniqueName(taken: Set<string>, name: string): string {
  let out = name;
  const stem = name.replace(/\.wav$/i, '');
  for (let i = 2; taken.has(out.toLowerCase()); i++) out = `${stem}_${i}.wav`;
  taken.add(out.toLowerCase());
  return out;
}

// ---------------------------------------------------------------------------- manifest

export interface PitchSummary {
  kind: PitchAnalysis['kind'];
  fundamentalHz: number | null;
  midi: number | null;
  note: string | null;
  cents: number | null;
  confidence: number;
  stability: number;
  initial: string | null;
  sweepCents: number;
  reason: string;
  method: string;
  version: number;
}

export interface FileEntry {
  file: string;
  instrument: string;
  variation: string;
  processing: 'dry' | 'wet';
  velocity: { layer: number; of: number; midi: number; low: number; high: number };
  pitch: {
    /** "original": rendered as the sound is; "retuned": moved to `note` */
    mode: 'original' | 'retuned';
    /** the name the file carries (null: none, the sound has no single pitch or could not be tuned) */
    note: string | null;
    midi: number | null;
    targetHz: number | null;
    measuredHz: number | null;
    errorCents: number | null;
    /** confirmed: measured within tolerance. approximate: kept, off by more than that. unverified: could not be measured. */
    tuning: 'confirmed' | 'approximate' | 'unverified' | 'original' | 'none';
    /** what was done to the engine: whole semitones on the note, cents on the oscillator FINE, the sample layer's playback offset */
    offsetSemitones: number;
    fineCents: number;
    attempts: number;
  };
  format: WavFormat;
  sampleRate: number;
  channels: number;
  frames: number;
  seconds: number;
  /** peak after gain, linear */
  peak: number;
  /** the gain applied by normalisation (1: none) */
  gain: number;
  tail: 'auto' | 'custom';
  tailCut: boolean;
  clipped: boolean;
}

export interface KitManifest {
  format: typeof KIT_EXPORT_FORMAT;
  version: number;
  generator: string;
  createdAt: string;
  kit: { name: string; project: string; seed: number; seedText?: string; projectSeed: number; projectSeedText?: string; tempo: number; sampleSet: string | null };
  settings: KitExportOptions & { sampleRate: number; bitDepth: number; layerRanges: { layer: number; velocity: number; low: number; high: number }[]; verification: string };
  scale: { root: string; name: string; label: string; steps: number[]; notes: string[] } | null;
  /** the project's global scale and whether it was in force (absent: none was set) */
  projectScale?: { on: boolean; root: string; name: string; label: string; steps: number[] };
  /** the kit's synthesis settings as they were when exported */
  synth: { params: number[]; lfoTarget: number[]; velTarget: number[] };
  instruments: {
    id: string;
    name: string;
    role: string;
    slug: string;
    mode: string;
    trigger: number;
    sound: Omit<Track['sound'], 'variations'>;
    /** the instrument's scale setting in the project and the scale it resolved to (null: none in force) */
    scale?: { mode: string; active: { root: string; name: string; label: string; steps: number[] } | null };
    variations: { slot: string; name: string; params: Variation['params']; empty: boolean }[];
    analysis: Record<string, PitchSummary>;
  }[];
  files: FileEntry[];
  skipped: { file: string; reason: string }[];
  warnings: string[];
}

const summarise = (a: PitchAnalysis): PitchSummary => ({
  kind: a.kind,
  fundamentalHz: a.fundamental ? round(a.fundamental.hz, 3) : null,
  midi: a.fundamental?.midi ?? null,
  note: a.fundamental?.note ?? null,
  cents: a.fundamental?.cents ?? null,
  confidence: round(a.confidence, 3),
  stability: round(a.stability, 3),
  initial: a.initial?.note ?? null,
  sweepCents: round(a.sweepCents, 1),
  reason: a.reason,
  method: a.method,
  version: a.version,
});

function round(x: number, d: number): number {
  const m = Math.pow(10, d);
  return Math.round(x * m) / m;
}

// ---------------------------------------------------------------------------- the export

interface Target {
  track: Track;
  slug: string;
  slot: number | null;
  /** the slot actually rendered: an empty variation plays the base sound */
  analysis: PitchAnalysis;
  /** notes to render; null = the original pitch */
  notes: number[] | null;
  /** the label of the original pitch (null: no reliable pitch) */
  originalNote: number | null;
  retunable: boolean;
}

const tailWarn = (h: { truncated: boolean }): string => (h.truncated ? `THE TAIL WAS STILL AUDIBLE AT ${LIMITS.autoMaxDry} S AND WAS FADED OUT` : '');

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** Is this analysis one a note name can honestly be given to? */
function reliable(a: PitchAnalysis): boolean {
  return (a.kind === 'stable' || a.kind === 'swept') && !!a.fundamental && a.confidence >= LIMITS.minConfidence;
}

function variationOf(t: Track, slot: number): Variation | null {
  return t.sound.variations?.[slot] ?? null;
}

export async function exportKit(project: Project, options: KitExportOptions, deps: KitExportDeps): Promise<KitExportResult> {
  const r0 = resolveOptions(project, options);
  if ('error' in r0) throw new Error(r0.error);
  const r = r0;
  // ORIGINAL and the retuned modes start from the sound before scale tuning; PROJECT renders it as the project plays it
  const snapshot = r.tuned ? clone(project) : untuned(project);
  const warnings: string[] = [];
  const skipped: { file: string; reason: string }[] = [];
  const yieldUi = deps.yieldToUi ?? tick;
  const cancelled = () => deps.signal?.aborted;
  const check = () => {
    if (cancelled()) throw new KitExportCancelled();
  };
  const layers = velocityLayers(options.layers);
  const tailOpt: 'auto' | number = options.tail.mode === 'auto' ? 'auto' : options.tail.seconds;
  const analyse = deps.analyse ?? ((p: Project, t: PitchTarget) => analyseTarget(deps.module, p, deps.library, t));
  const progress = (stage: KitExportStage, instrument: string, done: number, total: number, file?: string) => deps.onProgress?.({ stage, instrument, file, done, total, warnings: warnings.length });

  // unique file-name stems for the instruments
  const stems = new Map<string, string>();
  const usedStems = new Set<string>();
  for (const t of r.tracks) {
    let s = nameSlug(t.name);
    for (let i = 2; usedStems.has(s); i++) s = `${nameSlug(t.name)}_${i}`;
    usedStems.add(s);
    stems.set(t.id, s);
  }

  // ---- stage 1: what each sound is (one render and analysis per instrument and variation)
  const targets: Target[] = [];
  const jobs: { track: Track; slot: number | null }[] = [];
  for (const t of r.tracks)
    for (const slot of r.slots) {
      if (slot !== null && !variationOf(t, slot)) {
        // an empty variation plays the base sound: nothing of its own to export
        if (options.variations === 'selected') warnings.push(`${t.name}: VARIATION ${slotLabel(slot)} IS EMPTY (IT PLAYS THE BASE SOUND), SKIPPED`);
        continue;
      }
      jobs.push({ track: t, slot });
    }
  if (!jobs.length) throw new Error('NOTHING TO EXPORT: THE SELECTED VARIATIONS ARE EMPTY');
  let n = 0;
  for (const j of jobs) {
    check();
    progress('analysing', j.track.name, n++, jobs.length);
    await yieldUi();
    const rec = await analyse(snapshot, { trackId: j.track.id, slot: j.slot, layer: 'mix' });
    const a = rec.analysis;
    const label = `${j.track.name}${j.slot === null ? '' : ' ' + slotLabel(j.slot)}`;
    if (a.kind === 'silent') {
      warnings.push(`${label}: THE SOUND IS SILENT, SKIPPED`);
      continue;
    }
    const ok = reliable(a);
    let notes = r.perTrack ? (r.perTrack.get(j.track.id)?.notes ?? null) : r.notes;
    if (r.perTrack && !notes) warnings.push(`${label}: NO SCALE IN FORCE ON THIS INSTRUMENT: EXPORTED AT ITS ORIGINAL PITCH`);
    if (notes && !ok) {
      warnings.push(`${label}: ${a.kind === 'stable' || a.kind === 'swept' ? 'PITCH NOT RELIABLE ENOUGH TO RETUNE' : a.kind === 'inharmonic' ? 'INHARMONIC, HAS NO SINGLE PITCH' : 'UNPITCHED'}: EXPORTED AT ITS ORIGINAL PITCH ONLY, WITHOUT A NOTE NAME`);
      notes = null;
    }
    targets.push({ track: j.track, slug: stems.get(j.track.id)!, slot: j.slot, analysis: a, notes, originalNote: ok ? a.fundamental!.midi : null, retunable: ok });
  }
  if (!targets.length) throw new Error('NOTHING TO EXPORT: EVERY SELECTED SOUND IS SILENT');

  const perGroup = (t: Target) => (t.notes?.length ?? 1) * layers.length;
  const total = targets.reduce((s, t) => s + perGroup(t) * r.processing.length, 0);
  if (total > LIMITS.maxFiles) throw new Error(`THAT IS ${total} FILES; THE LIMIT IS ${LIMITS.maxFiles}. USE FEWER LAYERS, NOTES, VARIATIONS OR INSTRUMENTS`);
  const groupBytes = Math.max(...targets.map(perGroup)) * 3 * 44100 * 8;
  if (options.normalise && groupBytes > LIMITS.maxGroupBytes) throw new Error('ONE INSTRUMENT HAS TOO MANY FILES TO NORMALISE TOGETHER. USE FEWER LAYERS OR NOTES, OR TURN NORMALISATION OFF');

  // ---- stage 2: render, tune, normalise, encode
  const entries: { name: string; data: Uint8Array }[] = [];
  const files: FileEntry[] = [];
  const names = new Set<string>(['kit.json']);
  const verifyAll = targets.reduce((s, t) => s + (t.notes && t.retunable ? t.notes.length * layers.length * r.processing.length : 0), 0) <= 400;
  let done = 0;

  interface Rendered {
    name: string;
    audio: Float32Array[];
    meta: Omit<FileEntry, 'file' | 'peak' | 'gain' | 'clipped' | 'frames' | 'seconds'>;
    peak: number;
  }

  for (const tg of targets) {
    const notes = tg.notes ?? [null];
    const solutions = new Map<number, number>(); // note → the tuning (semitone offset) that worked, shared by its layers and processings
    for (const proc of r.processing) {
      const group: Rendered[] = [];
      const flush = (list: Rendered[]) => {
        const maxPeak = Math.max(0, ...list.map((x) => x.peak));
        const gain = options.normalise && maxPeak > 0 ? LIMITS.peakTarget / maxPeak : 1;
        for (const x of list) {
          const audio = gain === 1 ? x.audio : x.audio.map((c) => c.map((v) => v * gain));
          const peak = x.peak * gain;
          const clipped = options.format !== 'float32' && peak > 1;
          if (clipped) warnings.push(`${x.name}: CLIPPED (PEAK ${(20 * Math.log10(peak)).toFixed(1)} DBFS). TURN NORMALISATION ON OR USE 32-BIT FLOAT`);
          const frames = audio[0]!.length;
          entries.push({ name: x.name, data: encodeWav(audio, x.meta.sampleRate, options.format) });
          files.push({ ...x.meta, file: x.name, frames, seconds: round(frames / x.meta.sampleRate, 4), peak: round(peak, 5), gain: round(gain, 6), clipped });
        }
      };
      for (const note of notes) {
        // loudest layer first: the tuning found there is the starting point for the softer ones
        for (const layer of layers.slice().reverse()) {
          check();
          const name0 = kitFileName({ slug: tg.slug, note: note ?? tg.originalNote, vel: options.layers > 1 ? layer.vel : null, slot: tg.slot, processing: options.processing === 'both' ? proc : null });
          progress('rendering', tg.track.name, done, total, name0);
          await yieldUi();
          const out = await renderOne(tg, proc, note, layer, solutions.get(note ?? -1), verifyAll || layer.index === layers.length - 1);
          if (note !== null && out.semis !== undefined) solutions.set(note, out.semis);
          done++;
          if (out.skip) {
            skipped.push({ file: name0, reason: out.skip });
            warnings.push(`${name0}: SKIPPED, ${out.skip}`);
            continue;
          }
          if (out.warn) warnings.push(`${name0}: ${out.warn}`);
          if (out.peak <= 1e-4) {
            skipped.push({ file: name0, reason: 'THE RENDER WAS SILENT' });
            warnings.push(`${name0}: SKIPPED, THE RENDER WAS SILENT`);
            continue;
          }
          const name = uniqueName(names, name0);
          group.push({ name, audio: out.audio, meta: out.meta, peak: out.peak });
          if (!options.normalise) {
            flush(group.splice(0));
          }
        }
      }
      if (group.length) flush(group);
    }
  }
  check();

  async function renderOne(tg: Target, proc: 'dry' | 'wet', note: number | null, layer: { index: number; vel: number; lo: number; hi: number }, start: number | undefined, verify: boolean) {
    const tr = tg.track;
    const hasSynth = tr.sound.mode !== 'sample';
    const rec: Omit<FileEntry, 'file' | 'peak' | 'gain' | 'clipped' | 'frames' | 'seconds'> = {
      instrument: tr.name,
      variation: slotLabel(tg.slot),
      processing: proc,
      velocity: { layer: layer.index + 1, of: options.layers, midi: layer.vel, low: layer.lo, high: layer.hi },
      pitch: { mode: 'original', note: null, midi: null, targetHz: null, measuredHz: null, errorCents: null, tuning: 'none', offsetSemitones: 0, fineCents: 0, attempts: 1 },
      format: options.format,
      sampleRate: 44100,
      channels: 2,
      tail: options.tail.mode,
      tailCut: false,
    };
    const base = { track: tr.id, slot: tg.slot, vel: layer.vel, wet: proc === 'wet', tail: tailOpt, maxSeconds: proc === 'wet' ? LIMITS.autoMaxWet : LIMITS.autoMaxDry } as const;
    const render = (semis: number) => {
      const synthSemis = hasSynth ? Math.round(tr.sound.note + semis) - tr.sound.note : 0;
      const fine = hasSynth ? Math.max(-55, Math.min(55, (semis - synthSemis) * 100)) : 0;
      return renderKitHit(deps.module, snapshot, deps.library, base.track, { ...base, pitch: semis, fineCents: fine }).then((h) => ({ h, fine }));
    };
    const finish = (h: Awaited<ReturnType<typeof render>>['h']) => {
      rec.sampleRate = h.rate;
      rec.channels = h.audio.length;
      rec.tailCut = h.truncated || h.faded;
      return h;
    };
    if (note === null) {
      // the original pitch: as the sound is
      const { h } = await render(0);
      finish(h);
      const orig = tg.originalNote;
      if (orig !== null) {
        const fund = tg.analysis.fundamental!;
        rec.pitch = { ...rec.pitch, mode: 'original', note: noteName(orig), midi: orig, targetHz: round(fund.hz, 3), measuredHz: round(fund.hz, 3), errorCents: fund.cents, tuning: 'original' };
      }
      return { audio: h.audio, peak: h.peak, meta: rec, semis: undefined as number | undefined, skip: '', warn: tailWarn(h) };
    }
    // retuned
    const fund = tg.analysis.fundamental!;
    const targetHz = midiToHz(note);
    let semis = start ?? note - hzToMidiFloat(fund.hz);
    let attempts = 0;
    let best: { h: Awaited<ReturnType<typeof render>>['h']; err: number | null; semis: number; fine: number } | null = null;
    const measurable = targetHz >= LIMITS.minVerifiableHz;
    for (;;) {
      attempts++;
      const { h, fine } = await render(semis);
      let err: number | null = null;
      if (verify && measurable) {
        const m = analysePitch(h.audio, h.rate, { maxSeconds: 1.5 });
        if ((m.kind === 'stable' || m.kind === 'swept') && m.fundamental) err = 1200 * Math.log2(targetHz / m.fundamental.hz);
      }
      if (!best || (err !== null && (best.err === null || Math.abs(err) < Math.abs(best.err)))) best = { h, err, semis, fine };
      if (err === null || Math.abs(err) <= LIMITS.confirmCents || attempts >= 3) break;
      semis += err / 100;
      check();
    }
    const b = best!;
    finish(b.h);
    const measured = b.err === null ? null : targetHz / Math.pow(2, b.err / 1200);
    let tuning: FileEntry['pitch']['tuning'] = 'unverified';
    let warn = '';
    if (b.err !== null) {
      if (Math.abs(b.err) <= LIMITS.confirmCents) tuning = 'confirmed';
      else if (Math.abs(b.err) <= LIMITS.approxCents) {
        tuning = 'approximate';
        warn = `TUNED TO ${noteName(note)} ONLY APPROXIMATELY (${b.err > 0 ? '+' : ''}${b.err.toFixed(0)} CENTS)`;
      } else {
        return { audio: b.h.audio, peak: 0, meta: rec, semis: b.semis, skip: `COULD NOT BE TUNED TO ${noteName(note)} (${Math.abs(b.err).toFixed(0)} CENTS ${b.err > 0 ? 'FLAT' : 'SHARP'} AT BEST)`, warn: '' };
      }
    } else if (!measurable) warn = `${noteName(note)} IS BELOW WHAT THE ANALYSIS CAN CONFIRM (${LIMITS.minVerifiableHz} HZ): TUNED BY CALCULATION, NOT MEASURED`;
    else if (verify) warn = `${noteName(note)}: THE RENDERED PITCH COULD NOT BE MEASURED, TUNED BY CALCULATION`;
    else tuning = 'unverified';
    rec.pitch = { mode: 'retuned', note: noteName(note), midi: note, targetHz: round(targetHz, 3), measuredHz: measured === null ? null : round(measured, 3), errorCents: b.err === null ? null : round(-b.err, 1), tuning, offsetSemitones: round(b.semis - b.fine / 100, 4), fineCents: round(b.fine, 2), attempts };
    return { audio: b.h.audio, peak: b.h.peak, meta: rec, semis: b.semis, skip: '', warn: warn || tailWarn(b.h) };
  }

  progress('packing', '', total, total);
  await yieldUi();
  check();
  const created = (deps.now ?? (() => new Date()))().toISOString();
  const manifest: KitManifest = {
    format: KIT_EXPORT_FORMAT,
    version: KIT_EXPORT_VERSION,
    generator: deps.generator ?? 'CLATTER',
    createdAt: created,
    kit: { name: snapshot.kit.name, project: snapshot.name, seed: snapshot.kit.seed, ...(snapshot.kit.seedText ? { seedText: snapshot.kit.seedText } : {}), projectSeed: snapshot.seed, ...(snapshot.seedText ? { projectSeedText: snapshot.seedText } : {}), tempo: snapshot.tempo, sampleSet: snapshot.sampleSet ?? null },
    settings: { ...clone(options), sampleRate: 44100, bitDepth: WAV_FORMATS[options.format].bits, layerRanges: layers.map((l) => ({ layer: l.index + 1, velocity: l.vel, low: l.lo, high: l.hi })), verification: verifyAll ? 'every file measured' : 'the loudest layer of each note measured; softer layers share its tuning' },
    scale: r.scaleInfo ? { root: r.scaleInfo.rootName, name: r.scaleInfo.scale, label: r.scaleInfo.label, steps: r.scaleInfo.steps, notes: r.scaleInfo.notes.map(noteName) } : null,
    ...(project.scale ? { projectScale: { on: project.scale.on, root: rootName(project.scale.root), name: project.scale.type, label: describeScale(project.scale).replace(/^\S+ /, ''), steps: scaleSteps(project.scale).slice() } } : {}),
    synth: clone(snapshot.kit.synth),
    instruments: r.tracks.map((t) => {
      const { variations, ...sound } = clone(t.sound);
      return {
        id: t.id,
        name: t.name,
        role: t.role,
        slug: stems.get(t.id)!,
        mode: t.sound.mode,
        trigger: t.sound.trigger,
        sound,
        scale: (() => {
          const st = trackScaleState(project, t);
          return { mode: st.mode, active: st.spec ? { root: rootName(st.spec.root), name: st.spec.type, label: describeScale(st.spec).replace(/^\S+ /, ''), steps: scaleSteps(st.spec).slice() } : null };
        })(),
        variations: [0, 1, 2, 3].map((i) => {
          const v = variations?.[i] ?? null;
          return { slot: 'ABCD'[i]!, name: v?.name ?? '', params: v?.params ?? {}, empty: !v };
        }),
        analysis: Object.fromEntries(targets.filter((x) => x.track.id === t.id).map((x) => [slotLabel(x.slot), summarise(x.analysis)])),
      };
    }),
    files,
    skipped,
    warnings,
  };
  entries.push({ name: 'kit.json', data: new TextEncoder().encode(JSON.stringify(manifest, null, 2) + '\n') });
  const data = createZip(entries);
  progress('done', '', total, total);
  return { file: { name: fileName([snapshot.kit.name, 'kit'], 'zip'), data, type: 'application/zip' }, files: files.length, warnings, skipped, manifest };
}

export { MIDI_MAX, MIDI_MIN };
