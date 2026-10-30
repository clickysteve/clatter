/**
 * The sample-pack exporter: the sounds chosen in the SAMPLE FACTORY as individual WAV files in a
 * ZIP, one folder per instrument, with a pack.json that says what every file is and how to make
 * it again.
 *
 * It is the kit exporter's machinery, not a second one: every file is a fresh single-hit render
 * by the real LXR engine (`renderKitHit`, src/audio/render.ts) of the sound alone in a private
 * project, encoded by `encodeWav` (src/export/wavFile.ts) and packed by the same ZIP writer, with
 * the same formats, levels (-1 dBFS normalisation), DRY or WET rendering and tail choices. The
 * sample rate is the engine's 44.1 kHz: the kit exporter does not resample and neither does this.
 * Each file is encoded as soon as it is rendered and its floating-point audio dropped, so memory
 * holds only the encoded files.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import { createZip, fileName, readZip } from '@slopfactory/core/export';
import { PITCH_METHOD, PITCH_ANALYSIS_VERSION } from '../analysis/pitch';
import type { SampleLibrary } from '../audio/library';
import { renderKitHit } from '../audio/render';
import { type FactorySound, flagsOf, INSTRUMENT_SPECS, STAGE_TRACK, stageProject, statusOf } from '../sound/factory';
import { voiceKeys, type Key } from '../sound/kitgen';
import { VOICES } from '../sound/lxrParams';
import type { Candidate } from '../sound/discover';
import type { Project } from '../model/types';
import { INSTRUMENTS, type Instrument } from '../sound/voiceScore';
import { LIMITS, uniqueName } from './kitExport';
import { fileNote } from './notes';
import { encodeWav, WAV_FORMATS, type WavFormat } from './wavFile';

export const PACK_FORMAT = 'clatter-sample-pack';
export const PACK_VERSION = 1;
export const PACK_MANIFEST = 'pack.json';
/** the most files in one pack, and the most encoded audio held at once (bytes) */
export const PACK_LIMITS = { maxFiles: 1024, maxBytes: 400 * 1024 * 1024 } as const;

export type PackProcessing = 'dry' | 'wet' | 'both';

export interface PackOptions {
  format: WavFormat;
  processing: PackProcessing;
  tail: { mode: 'auto' | 'custom'; seconds: number };
  normalise: boolean;
  /** the file name of the ZIP is made from this */
  name: string;
}

export const PACK_DEFAULTS: PackOptions = { format: 'pcm24', processing: 'dry', tail: { mode: 'auto', seconds: 2 }, normalise: true, name: 'SAMPLE PACK' };

export type PackStage = 'rendering' | 'packing' | 'done';
export interface PackProgress {
  stage: PackStage;
  done: number;
  total: number;
  file?: string;
  warnings: number;
}

export class PackCancelled extends Error {
  constructor() {
    super('PACK EXPORT CANCELLED');
    this.name = 'PackCancelled';
  }
}

export interface PackDeps {
  module: WebAssembly.Module;
  library: SampleLibrary | null;
  onProgress?: (p: PackProgress) => void;
  signal?: AbortSignal;
  yieldToUi?: () => Promise<void>;
  now?: () => Date;
}

export interface PackFileEntry {
  file: string;
  folder: string;
  processing: 'dry' | 'wet';
  format: WavFormat;
  sampleRate: number;
  bitDepth: number;
  channels: number;
  frames: number;
  seconds: number;
  /** peak after gain, linear */
  peak: number;
  /** the gain normalisation applied (1: none) */
  gain: number;
  clipped: boolean;
  tailCut: boolean;
}

export interface PackSoundEntry {
  id: string;
  instrument: Instrument;
  label: string;
  serial: number;
  order: number;
  name: string;
  favourite: boolean;
  files: PackFileEntry[];
  word: string;
  pitch: { kind: string; reliable: boolean; note: string | null; midi: number | null; hz: number | null; cents: number | null; confidence: number; method: string; version: number; measuredOn: string };
  quality: { status: 'ok' | 'warn' | 'fail'; flags: { id: string; severity: string; text: string }[]; acceptedAnyway: boolean };
  generation: { seed: number; seedText?: string; soundSeed: number; character: string; wildness: number; variation: number; diversity: number; draw: number; attempt: number; generator: number; archetype: string };
  synth: { voice: number; voiceName: string; trigger: number; parameters: Record<string, number>; par: Record<number, number>; lfoTarget: string | null; velTarget: string | null };
  measured: { peak: number; rms: number; centroid: number; noise: number; tonality: number; lengthMs: number; attackMs: number };
}

export interface PackManifest {
  format: typeof PACK_FORMAT;
  version: number;
  generator: string;
  createdAt: string;
  project: { name: string; tempo: number; seed: number; seedText?: string };
  settings: PackOptions & { sampleRate: number; bitDepth: number; normalisedTo: string | null; layout: string };
  counts: Record<string, number>;
  sounds: PackSoundEntry[];
  skipped: { id: string; reason: string }[];
  warnings: string[];
}

export interface PackResult {
  file: { name: string; data: Uint8Array; type: string };
  files: number;
  warnings: string[];
  skipped: { id: string; reason: string }[];
  manifest: PackManifest;
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const round = (x: number, n: number): number => Math.round(x * 10 ** n) / 10 ** n;

// ---------------------------------------------------------------------------- names
/** The number in a file name: 001, or 0001 once there are more than 999. */
export const serialText = (n: number): string => String(n).padStart(n > 999 ? 4 : 3, '0');

/**
 * CLATTER_KICK_C2_001.wav, CLATTER_SNARE_NOISY_014.wav, CLATTER_FX_METALLIC_008.wav: the
 * instrument, then the note when the pitch is reliable and the word that describes the sound when it
 * is not (a note is never put on a sound that has no single pitch), then the number.
 */
export function packFileName(s: Pick<FactorySound, 'instrument' | 'serial' | 'info'>, processing: 'dry' | 'wet' | null): string {
  const spec = INSTRUMENT_SPECS[s.instrument];
  const p = s.info?.pitch;
  const tag = p?.reliable && p.midi !== null ? fileNote(p.midi) : (s.info?.word ?? 'SOUND');
  return ['CLATTER', spec.short, tag, serialText(s.serial), ...(processing ? [processing.toUpperCase()] : [])].join('_') + '.wav';
}

// ---------------------------------------------------------------------------- manifest pieces
export function synthEntry(c: Pick<Candidate, 'voice' | 'values' | 'lfo' | 'vel'>, trigger: number): PackSoundEntry['synth'] {
  const keys = voiceKeys(c.voice);
  const par: Record<number, number> = {};
  const parameters: Record<string, number> = {};
  for (const [k, v] of Object.entries(c.values) as [Key, number][]) {
    parameters[k] = v;
    const id = keys[k];
    if (id !== undefined) par[id] = v;
  }
  return { voice: c.voice, voiceName: VOICES[c.voice] ?? '', trigger, parameters, par, lfoTarget: c.lfo, velTarget: c.vel };
}

// ---------------------------------------------------------------------------- export
export interface Exportable {
  /** sounds that may go in the pack */
  ok: FactorySound[];
  /** selected sounds that fail the quality checks and have not been accepted */
  blocked: FactorySound[];
}

/** Split selected sounds into those that can be exported and those held back by a failing quality check. `strict` false: the player overrides the quality filter. */
export function exportable(selected: readonly FactorySound[], strict: boolean): Exportable {
  const ok: FactorySound[] = [];
  const blocked: FactorySound[] = [];
  for (const s of selected) {
    if (s.status !== 'ready' || !s.info) continue;
    if (strict && !s.keep && s.info.flags.some((f) => f.severity === 'fail')) blocked.push(s);
    else ok.push(s);
  }
  return { ok, blocked };
}

export function validateOptions(o: PackOptions): string | null {
  if (!(o.format in WAV_FORMATS)) return 'UNKNOWN WAV FORMAT';
  if (!['dry', 'wet', 'both'].includes(o.processing)) return 'UNKNOWN PROCESSING';
  if (o.tail.mode === 'custom' && !(o.tail.seconds >= LIMITS.minTail && o.tail.seconds <= LIMITS.maxTail)) return `TAIL MUST BE ${LIMITS.minTail}-${LIMITS.maxTail} SECONDS`;
  return null;
}

/** Render the sounds again, encode them, and pack them. The project is only read. */
export async function exportPack(project: Project, sounds: readonly FactorySound[], options: PackOptions, deps: PackDeps): Promise<PackResult> {
  const bad = validateOptions(options);
  if (bad) throw new Error(bad);
  if (!sounds.length) throw new Error('NOTHING TO EXPORT: SELECT SOME SOUNDS FIRST');
  const procs: ('dry' | 'wet')[] = options.processing === 'both' ? ['dry', 'wet'] : [options.processing];
  if (sounds.length * procs.length > PACK_LIMITS.maxFiles) throw new Error(`TOO MANY FILES (${sounds.length * procs.length}): THE LIMIT IS ${PACK_LIMITS.maxFiles}`);
  const yieldUi = deps.yieldToUi ?? tick;
  const check = () => {
    if (deps.signal?.aborted) throw new PackCancelled();
  };
  const warnings: string[] = [];
  const skipped: { id: string; reason: string }[] = [];
  const ordered = sounds.slice().sort((a, b) => INSTRUMENTS.indexOf(a.instrument) - INSTRUMENTS.indexOf(b.instrument) || a.serial - b.serial);
  const total = ordered.length * procs.length;
  const taken = new Set<string>();
  const entries: { name: string; data: Uint8Array }[] = [];
  const out: PackSoundEntry[] = [];
  let bytes = 0;
  let done = 0;
  const tail: 'auto' | number = options.tail.mode === 'auto' ? 'auto' : options.tail.seconds;
  const progress = (stage: PackStage, file?: string) => deps.onProgress?.({ stage, done, total, file, warnings: warnings.length });

  for (const s of ordered) {
    const spec = INSTRUMENT_SPECS[s.instrument];
    const files: PackFileEntry[] = [];
    for (const proc of procs) {
      check();
      const label = packFileName(s, options.processing === 'both' ? proc : null);
      progress('rendering', label);
      await yieldUi();
      const stage = stageProject(project, s.instrument, s.candidate);
      const hit = await renderKitHit(deps.module, stage, deps.library, STAGE_TRACK, { vel: 110, slot: null, wet: proc === 'wet', tail, maxSeconds: proc === 'wet' ? LIMITS.autoMaxWet : LIMITS.autoMaxDry });
      done++;
      if (hit.peak <= 1e-4) {
        skipped.push({ id: s.id, reason: `THE ${proc.toUpperCase()} RENDER WAS SILENT` });
        warnings.push(`${label}: SKIPPED, THE RENDER WAS SILENT`);
        continue;
      }
      const gain = options.normalise ? LIMITS.peakTarget / hit.peak : 1;
      const audio = gain === 1 ? hit.audio : hit.audio.map((c) => c.map((v) => v * gain));
      const peak = hit.peak * gain;
      const clipped = options.format !== 'float32' && peak > 1;
      if (clipped) warnings.push(`${label}: CLIPPED (PEAK ${(20 * Math.log10(peak)).toFixed(1)} DBFS). TURN NORMALISATION ON OR USE 32-BIT FLOAT`);
      const name = `${spec.folder}/${uniqueName(taken, label)}`;
      const data = encodeWav(audio, hit.rate, options.format);
      bytes += data.length;
      if (bytes > PACK_LIMITS.maxBytes) throw new Error(`THE PACK IS TOO LARGE (OVER ${PACK_LIMITS.maxBytes / 1024 / 1024} MB): EXPORT FEWER SOUNDS OR SHORTER TAILS`);
      entries.push({ name, data });
      files.push({ file: name, folder: spec.folder, processing: proc, format: options.format, sampleRate: hit.rate, bitDepth: WAV_FORMATS[options.format].bits, channels: audio.length, frames: audio[0]!.length, seconds: round(audio[0]!.length / hit.rate, 4), peak: round(peak, 5), gain: round(gain, 6), clipped, tailCut: hit.truncated || hit.faded });
      if (hit.truncated) warnings.push(`${label}: THE TAIL WAS STILL AUDIBLE AT ${proc === 'wet' ? LIMITS.autoMaxWet : LIMITS.autoMaxDry} SECONDS AND WAS FADED OUT THERE`);
    }
    if (!files.length) continue;
    const i = s.info!;
    const q = flagsOf(s);
    out.push({
      id: s.id,
      instrument: s.instrument,
      label: spec.label,
      serial: s.serial,
      order: s.order,
      name: s.candidate.name,
      favourite: s.favourite,
      files,
      word: i.word,
      pitch: { kind: i.pitch.kind, reliable: i.pitch.reliable, note: i.pitch.reliable ? i.pitch.note : null, midi: i.pitch.reliable ? i.pitch.midi : null, hz: i.pitch.reliable && i.pitch.hz !== null ? round(i.pitch.hz, 3) : null, cents: i.pitch.reliable && i.pitch.cents !== null ? round(i.pitch.cents, 1) : null, confidence: round(i.pitch.confidence, 3), method: PITCH_METHOD, version: PITCH_ANALYSIS_VERSION, measuredOn: 'the DRY audition render, before normalisation' },
      quality: { status: statusOf(s), flags: q.map((f) => ({ id: f.id, severity: f.severity, text: f.text })), acceptedAnyway: s.keep },
      generation: { seed: s.made.seed.seed, ...(s.made.seed.text ? { seedText: s.made.seed.text } : {}), soundSeed: s.candidate.origin.seed, character: s.made.character, wildness: s.made.wildness, variation: s.made.variation, diversity: s.made.diversity, draw: s.draw, attempt: s.attempt, generator: s.candidate.origin.generator, archetype: s.candidate.origin.archetype },
      synth: synthEntry(s.candidate, INSTRUMENT_SPECS[s.instrument].trigger(s.candidate.voice)),
      measured: { peak: round(i.peak, 5), rms: round(i.rms, 5), centroid: round(i.centroid, 1), noise: round(i.noise, 3), tonality: round(i.tonality, 3), lengthMs: round(i.lengthMs, 1), attackMs: round(i.attackMs, 2) },
    });
  }
  check();
  if (!entries.length) throw new Error('NOTHING TO EXPORT: EVERY SELECTED SOUND RENDERED SILENT');
  progress('packing');
  await yieldUi();
  check();
  const counts: Record<string, number> = {};
  for (const e of out) counts[e.instrument] = (counts[e.instrument] ?? 0) + e.files.length;
  const manifest: PackManifest = {
    format: PACK_FORMAT,
    version: PACK_VERSION,
    generator: 'CLATTER',
    createdAt: (deps.now ?? (() => new Date()))().toISOString(),
    project: { name: project.name, tempo: project.tempo, seed: project.seed, ...(project.seedText ? { seedText: project.seedText } : {}) },
    settings: { ...options, sampleRate: 44100, bitDepth: WAV_FORMATS[options.format].bits, normalisedTo: options.normalise ? '-1 dBFS peak' : null, layout: 'one folder per instrument' },
    counts,
    sounds: out,
    skipped,
    warnings,
  };
  entries.push({ name: PACK_MANIFEST, data: new TextEncoder().encode(JSON.stringify(manifest, null, 2) + '\n') });
  const data = createZip(entries);
  done = total;
  progress('done');
  return { file: { name: fileName([options.name || project.name, 'sample-pack'], 'zip'), data, type: 'application/zip' }, files: entries.length - 1, warnings, skipped, manifest };
}

// ---------------------------------------------------------------------------- reading a pack
export interface ImportedSound {
  instrument: Instrument;
  serial: number;
  candidate: Pick<Candidate, 'voice' | 'values' | 'lfo' | 'vel'>;
  favourite: boolean;
  made: { character: string; wildness: number; variation: number; diversity: number; seed: number; seedText?: string; draw: number; attempt: number };
}

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** The sounds a pack.json describes (anything that is not a sound CLATTER can make again is left out and counted). */
export function parsePackManifest(json: string): { sounds: ImportedSound[]; skipped: number } {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error('NOT A CLATTER SAMPLE PACK (THE FILE IS NOT JSON)');
  }
  const m = raw as Partial<PackManifest> | null;
  if (!m || m.format !== PACK_FORMAT) throw new Error('NOT A CLATTER SAMPLE PACK');
  if (!isNum(m.version) || m.version > PACK_VERSION) throw new Error('THIS PACK WAS MADE BY A NEWER CLATTER');
  const sounds: ImportedSound[] = [];
  let skipped = 0;
  for (const e of Array.isArray(m.sounds) ? (m.sounds as Partial<PackSoundEntry>[]) : []) {
    const inst = INSTRUMENTS.find((i) => i === e.instrument);
    const syn = e.synth;
    const g = e.generation;
    if (!inst || !syn || !g || !isNum(syn.voice) || syn.voice < 0 || syn.voice > 5 || typeof syn.parameters !== 'object' || !syn.parameters) {
      skipped++;
      continue;
    }
    const keys = voiceKeys(syn.voice);
    const values: Candidate['values'] = {};
    for (const [k, v] of Object.entries(syn.parameters)) if (keys[k as Key] !== undefined && isNum(v)) values[k as Key] = Math.max(0, Math.min(127, Math.round(v)));
    const key = (k: string | null | undefined): Key | null => (k && keys[k as Key] !== undefined ? (k as Key) : null);
    sounds.push({
      instrument: inst,
      serial: isNum(e.serial) && e.serial >= 1 ? Math.floor(e.serial) : 1,
      candidate: { voice: syn.voice, values, lfo: key(syn.lfoTarget), vel: key(syn.velTarget) },
      favourite: !!e.favourite,
      made: { character: String(g.character), wildness: isNum(g.wildness) ? g.wildness : 60, variation: isNum(g.variation) ? g.variation : 70, diversity: isNum(g.diversity) ? g.diversity : 50, seed: isNum(g.seed) ? g.seed >>> 0 : 0, ...(g.seedText ? { seedText: String(g.seedText) } : {}), draw: isNum(g.draw) ? g.draw : 0, attempt: isNum(g.attempt) ? g.attempt : 0 },
    });
  }
  return { sounds, skipped };
}

/** A pack as a ZIP (its pack.json) or as the bare pack.json. */
export async function readPack(bytes: Uint8Array): Promise<ReturnType<typeof parsePackManifest>> {
  const zip = bytes.length > 3 && bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (!zip) return parsePackManifest(new TextDecoder().decode(bytes));
  const entries = await readZip(bytes, { maxEntries: PACK_LIMITS.maxFiles + 8, maxEntryBytes: 64 * 1024 * 1024, maxTotalBytes: PACK_LIMITS.maxBytes });
  const m = entries.find((e) => e.name === PACK_MANIFEST);
  if (!m) throw new Error(`NOT A CLATTER SAMPLE PACK (NO ${PACK_MANIFEST})`);
  return parsePackManifest(new TextDecoder().decode(m.data));
}
