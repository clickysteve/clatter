/**
 * SAMPLE FACTORY, the listening half: what is measured on every rendered sound so it can be
 * judged, sorted, compared and named without keeping its audio.
 *
 *   qcCheck            quality control: silence, very low output, clipping, invalid samples, DC
 *                      offset, problematic tails. FLAGS, never deletions: a strange sound that
 *                      is musically interesting is the point of the factory.
 *   wavePeaks          a small waveform summary for the browser
 *   soundFeatures      a compact feature vector (spectral bands, level envelope, the existing
 *                      voice metrics) and `featureDistance` between two of them
 *   markDuplicates     near-duplicates, by distance in that feature space
 *   describeSound      one word for what a sound without a trustworthy pitch sounds like
 *
 * Everything reuses the analysis CLATTER already has (analyseVoice, the safety limits of the kit
 * generator, the YIN pitch analysis): no model, no dependency. Pure functions of the samples.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import { analyseVoice, type VoiceMetrics } from '../analysis/voiceAnalysis';
import { fft, type PitchAnalysis } from '../analysis/pitch';
import { safety, type Instrument } from './voiceScore';

// ---------------------------------------------------------------------------- quality control
export type QcId = 'invalid' | 'silent' | 'vanishes' | 'low' | 'clip' | 'dc' | 'drone' | 'cut' | 'click' | 'duplicate';
export type QcSeverity = 'fail' | 'warn';

export interface QcFlag {
  id: QcId;
  severity: QcSeverity;
  text: string;
}

export const QC_LIMITS = {
  /** peak under which a render counts as silent: -80 dBFS (the exporter's own limit) */
  silent: 1e-4,
  /** peak under which the output is extremely low: about -34 dBFS */
  low: 0.02,
  /** samples this close to full scale count as clipped when there are enough of them */
  clipLevel: 0.9995,
  clipSamples: 8,
  /** DC offset (mean over the sound, relative to its peak) that is worth a warning, and one that is a failure */
  dcWarn: 0.1,
  dcFail: 0.25,
  /** an envelope still this loud at the end of the render is a drone */
  droneTail: 0.3,
} as const;

export interface QcResult {
  flags: QcFlag[];
  status: 'ok' | 'warn' | 'fail';
}

export const qcStatus = (flags: readonly QcFlag[]): QcResult['status'] => (flags.some((f) => f.severity === 'fail') ? 'fail' : flags.length ? 'warn' : 'ok');

const db = (x: number): string => (x > 0 ? (20 * Math.log10(x)).toFixed(1) : '-inf');

/**
 * Check one rendered sound. `truncated` is the renderer's own report that the tail was still
 * audible when the render stopped. Duplicates are found across the collection
 * (`markDuplicates`), not here.
 */
export function qcCheck(audio: Float32Array[], m: VoiceMetrics, instr: Instrument, truncated: boolean): QcFlag[] {
  const flags: QcFlag[] = [];
  let peak = 0;
  let bad = 0;
  let hot = 0;
  for (const ch of audio) {
    for (let i = 0; i < ch.length; i++) {
      const v = ch[i]!;
      if (!Number.isFinite(v)) {
        bad++;
        continue;
      }
      const a = Math.abs(v);
      if (a > peak) peak = a;
    }
  }
  if (bad) {
    flags.push({ id: 'invalid', severity: 'fail', text: `${bad} INVALID SAMPLES (NOT A NUMBER OR INFINITE)` });
    return flags;
  }
  if (peak < QC_LIMITS.silent) {
    flags.push({ id: 'silent', severity: 'fail', text: 'SILENT' });
    return flags;
  }
  const s = safety(m, instr);
  if (s.flags.includes('vanishes')) flags.push({ id: 'vanishes', severity: 'fail', text: 'VANISHES: UNDER 8 MS OF SOUND' });
  if (s.flags.includes('click-only')) flags.push({ id: 'click', severity: 'warn', text: 'A CLICK ONLY: UNDER 14 MS OF SOUND' });
  if (peak < QC_LIMITS.low) flags.push({ id: 'low', severity: 'warn', text: `VERY LOW OUTPUT (PEAK ${db(peak)} DBFS)` });
  const level = QC_LIMITS.clipLevel * Math.max(1, peak);
  for (const ch of audio) for (let i = 0; i < ch.length; i++) if (Math.abs(ch[i]!) >= level) hot++;
  if (peak > 1) flags.push({ id: 'clip', severity: 'warn', text: `OVER FULL SCALE (PEAK ${db(peak)} DBFS) UNTIL NORMALISED` });
  else if (hot >= QC_LIMITS.clipSamples) flags.push({ id: 'clip', severity: 'warn', text: `CLIPPING (${hot} SAMPLES AT FULL SCALE)` });
  if (m.dc > QC_LIMITS.dcWarn) flags.push({ id: 'dc', severity: m.dc > QC_LIMITS.dcFail ? 'fail' : 'warn', text: `DC OFFSET ${Math.round(m.dc * 100)}% OF THE PEAK` });
  if (m.tailHot > QC_LIMITS.droneTail && instr !== 'cymbal') flags.push({ id: 'drone', severity: 'warn', text: 'THE TAIL NEVER DIES AWAY (A DRONE)' });
  else if (truncated) flags.push({ id: 'cut', severity: 'warn', text: 'THE TAIL WAS STILL AUDIBLE WHEN THE RENDER ENDED: FADED OUT THERE' });
  return flags;
}

/** Run the voice analysis on a render (both channels). */
export function measure(audio: Float32Array[], rate: number): VoiceMetrics {
  return analyseVoice(audio[0]!, audio[1] ?? null, rate);
}

// ---------------------------------------------------------------------------- waveform
/** The shape of a sound in `n` columns: the largest absolute sample of each, relative to the sound's peak (0-1, three decimals). */
export function wavePeaks(audio: Float32Array[], n = 64): number[] {
  const len = audio[0]?.length ?? 0;
  if (!len) return new Array<number>(n).fill(0);
  const out = new Array<number>(n).fill(0);
  let peak = 0;
  for (let c = 0; c < n; c++) {
    const a = Math.floor((c * len) / n);
    const b = Math.max(a + 1, Math.floor(((c + 1) * len) / n));
    let m = 0;
    for (const ch of audio) for (let i = a; i < b && i < len; i++) m = Math.max(m, Math.abs(ch[i]!));
    out[c] = m;
    peak = Math.max(peak, m);
  }
  return out.map((v) => (peak > 0 ? Math.round((v / peak) * 1000) / 1000 : 0));
}

// ---------------------------------------------------------------------------- features
const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));
const BAND_EDGES = [40, 100, 220, 480, 1000, 2200, 4800, 10000, 18000];
const ENV_WINDOWS_MS: [number, number][] = [
  [0, 5],
  [5, 15],
  [15, 40],
  [40, 100],
  [100, 250],
  [250, 600],
  [600, 1500],
];
export const FEATURE_NAMES = [...BAND_EDGES.slice(0, -1).map((_, i) => `band${i}`), ...ENV_WINDOWS_MS.map(([a]) => `env${a}`), 'centroid', 'noise', 'tonality', 'length', 'attack', 'sweep', 'pitch'] as const;
export const FEATURE_COUNT = FEATURE_NAMES.length;
/** the spectral bands and the envelope say more about how a sound sounds than the scalars do */
const WEIGHTS = FEATURE_NAMES.map((n) => (n.startsWith('band') ? 1.2 : n.startsWith('env') ? 0.9 : n === 'pitch' ? 1.4 : 1));

const FFT_SIZE = 8192;

/**
 * A fixed-length feature vector for one sound, every value 0-1: the share of spectral power in eight bands
 * (square-rooted), the level envelope in seven windows after the onset (dB), and the centroid, noise
 * content, tonality, length, attack, pitch sweep and pitch from the voice metrics. Distances between
 * vectors say how alike two sounds are; they do not depend on how loud a sound is.
 */
export function soundFeatures(audio: Float32Array[], m: VoiceMetrics, pitch?: PitchAnalysis | null): number[] {
  const rate = m.rate;
  const len = audio[0]?.length ?? 0;
  const mono = new Float32Array(len);
  let peak = 0;
  for (let i = 0; i < len; i++) {
    let s = 0;
    for (const ch of audio) s += ch[i] ?? 0;
    mono[i] = s / audio.length;
    peak = Math.max(peak, Math.abs(mono[i]!));
  }
  let onset = 0;
  while (onset < len && Math.abs(mono[onset]!) < peak * 0.02) onset++;
  const out: number[] = [];
  // spectrum of the first 186 ms after the onset
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  const n = Math.min(FFT_SIZE, len - onset);
  for (let i = 0; i < n; i++) re[i] = mono[onset + i]! * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)));
  if (n > 0) fft(re, im);
  const bands = new Array<number>(BAND_EDGES.length - 1).fill(0);
  let total = 0;
  for (let k = 1; k <= FFT_SIZE / 2; k++) {
    const hz = (k * rate) / FFT_SIZE;
    const p = re[k]! * re[k]! + im[k]! * im[k]!;
    for (let b = 0; b < bands.length; b++)
      if (hz >= BAND_EDGES[b]! && hz < BAND_EDGES[b + 1]!) {
        bands[b]! += p;
        total += p;
        break;
      }
  }
  for (const b of bands) out.push(total > 0 ? Math.sqrt(b / total) : 0);
  // level envelope after the onset, in dB under the peak
  for (const [a, b] of ENV_WINDOWS_MS) {
    const from = onset + Math.floor((a * rate) / 1000);
    const to = Math.min(len, onset + Math.floor((b * rate) / 1000));
    let sum = 0;
    for (let i = from; i < to; i++) sum += mono[i]! * mono[i]!;
    const rms = to > from ? Math.sqrt(sum / (to - from)) : 0;
    out.push(peak > 0 && rms > 0 ? clamp01(1 + (20 * Math.log10(rms / peak)) / 60) : 0);
  }
  out.push(m.centroid > 0 ? clamp01(Math.log2(m.centroid / 40) / Math.log2(16000 / 40)) : 0);
  out.push(clamp01(m.noise));
  out.push(clamp01(m.tonality));
  out.push(m.lengthMs > 0 ? clamp01(Math.log2(Math.max(m.lengthMs, 10) / 10) / Math.log2(6000 / 10)) : 0);
  out.push(clamp01(Math.log2(1 + Math.max(0, m.attackMs)) / Math.log2(1 + 40)));
  out.push(clamp01(0.5 + m.sweepOct / 6));
  const hz = pitch && pitch.fundamental && (pitch.kind === 'stable' || pitch.kind === 'swept') ? pitch.fundamental.hz : 0;
  out.push(hz > 0 ? clamp01(Math.log2(hz / 25) / Math.log2(4000 / 25)) : 0);
  return out.map((v) => Math.round(v * 1e4) / 1e4);
}

/** How different two sounds are, 0 (the same to every measure) to 1. */
export function featureDistance(a: readonly number[], b: readonly number[]): number {
  let s = 0;
  let w = 0;
  for (let i = 0; i < WEIGHTS.length; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    s += WEIGHTS[i]! * d * d;
    w += WEIGHTS[i]!;
  }
  return Math.sqrt(s / w);
}

/** Two sounds closer than this are near-duplicates (calibrated on factory batches: see test/factory.test.ts). */
export const DUPLICATE_DISTANCE = 0.035;

/** The distance a new sound should keep from its neighbours at a DIVERSITY of 0-1. */
export const wantedDistance = (diversity: number): number => 0.01 + 0.12 * clamp01(diversity);

export interface Featured {
  id: string;
  group: string;
  order: number;
  features: readonly number[];
}

/**
 * Near-duplicates: within a group (an instrument), a sound that is closer than `threshold` to an
 * earlier one (lower `order`) is a duplicate of it. Returns duplicate id → the earlier id it repeats.
 */
export function findDuplicates(items: readonly Featured[], threshold = DUPLICATE_DISTANCE): Map<string, string> {
  const out = new Map<string, string>();
  const byGroup = new Map<string, Featured[]>();
  for (const it of items) (byGroup.get(it.group) ?? byGroup.set(it.group, []).get(it.group)!).push(it);
  for (const list of byGroup.values()) {
    list.sort((a, b) => a.order - b.order);
    const kept: Featured[] = [];
    for (const it of list) {
      let best: { id: string; d: number } | null = null;
      for (const k of kept) {
        const d = featureDistance(it.features, k.features);
        if (d < threshold && (!best || d < best.d)) best = { id: k.id, d };
      }
      if (best) out.set(it.id, best.id);
      else kept.push(it);
    }
  }
  return out;
}

/** The smallest distance from `f` to any of `others` (1 when there are none). */
export function nearest(f: readonly number[], others: readonly (readonly number[])[]): number {
  let d = 1;
  for (const o of others) d = Math.min(d, featureDistance(f, o));
  return d;
}

// ---------------------------------------------------------------------------- naming
/**
 * One word for a sound that has no pitch to name it by: how it sounds. A rule list, first match
 * wins, so the same measurements always give the same word.
 */
export function describeSound(m: VoiceMetrics, kind: PitchAnalysis['kind'] | null): string {
  if (m.noise > 0.8) return m.centroid > 6500 ? 'HISSY' : 'NOISY';
  if ((kind === 'inharmonic' || m.tonality > 0.3) && m.centroid > 3000) return 'METALLIC';
  if (kind === 'inharmonic' || (!kind && m.tonality > 0.5)) return 'CLANG';
  if (m.sweepOct > 1.2 && m.centroid < 3000) return 'SWEPT';
  if (m.lengthMs < 60) return 'CLICKY';
  if (m.centroid > 7000) return 'BRIGHT';
  if (m.centroid < 300) return 'BOOMY';
  if (m.lengthMs > 1500) return 'LONG';
  if (m.transientDb > 12) return 'PUNCHY';
  if (m.centroid < 1500) return 'DARK';
  return 'SOFT';
}
