/**
 * Rendered-audio analysis of one drum hit: the measurements the kit generator and the
 * development-time evaluator (eval/kits.eval.ts) use to judge a sound by how it sounds, not by
 * the numbers that made it.
 *
 * Everything here is a pure function of the samples. Nothing allocates per sample, nothing
 * depends on a browser, and the whole analysis costs about a millisecond for a second of audio:
 * it runs on the kit worker's render buffers, never inside the real-time audio callback. The
 * slow YIN pitch tracker (analysis/pitch.ts) is not part of it; `analysePitchDetail` adds that
 * for reports only.
 *
 * Measurements (levels and the envelope follow the louder channel; the spectrum and the pitch estimate
 * use `mono` = (L + R) / 2):
 *   peak, rms        linear, over the audible part (until the envelope falls under -60 dBFS)
 *   clipFrac         fraction of samples at or beyond 0.99
 *   dc               mean over the audible part, relative to the peak
 *   attackMs         from the onset (2 % of the peak) to the loudest 1 ms
 *   t20Ms, t60Ms     from the loudest point until the envelope is 20 / 60 dB under it
 *   lengthMs         until the envelope falls under -60 dBFS (absolute)
 *   tailHot          the envelope at the end of the render, relative to the peak (a drone is close to 1)
 *   transientDb      level of the first 6 ms after the onset against the next 6-60 ms
 *   centroid         spectral centroid in Hz (power weighted, 30 Hz - 16 kHz) of the first 186 ms
 *   low, mid, high   share of the spectral power under 150 Hz, 150 Hz - 5 kHz and over 5 kHz
 *   flatness         0 (one pure tone) to 1 (white noise): geometric over arithmetic mean of the power
 *   tonality         share of the power inside the six strongest spectral peaks
 *   noise            0-1 noise content from flatness and tonality
 *   zcEarlyHz/LateHz zero-crossing frequency estimate of the first 12 ms and of 60-160 ms after the onset
 *   sweepOct         octaves the apparent pitch falls (positive) or rises (negative) between those
 *   pitchStability   0-1: how steady the zero-crossing rate is across the body (1 = steady)
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import { fft } from './pitch';

export const ANALYSIS_RATE = 44100;
/** Level under which a sound counts as ended: -60 dBFS. */
const END = 0.001;

export interface VoiceMetrics {
  rate: number;
  samples: number;
  peak: number;
  rms: number;
  silent: boolean;
  clipFrac: number;
  dc: number;
  attackMs: number;
  t20Ms: number;
  t60Ms: number;
  lengthMs: number;
  tailHot: number;
  transientDb: number;
  centroid: number;
  low: number;
  mid: number;
  high: number;
  flatness: number;
  tonality: number;
  noise: number;
  zcEarlyHz: number;
  zcLateHz: number;
  sweepOct: number;
  pitchStability: number;
}

const BLOCK = 44; // 1 ms envelope blocks at 44.1 kHz

export function emptyMetrics(rate = ANALYSIS_RATE): VoiceMetrics {
  return { rate, samples: 0, peak: 0, rms: 0, silent: true, clipFrac: 0, dc: 0, attackMs: 0, t20Ms: 0, t60Ms: 0, lengthMs: 0, tailHot: 0, transientDb: 0, centroid: 0, low: 0, mid: 0, high: 0, flatness: 1, tonality: 0, noise: 1, zcEarlyHz: 0, zcLateHz: 0, sweepOct: 0, pitchStability: 0 };
}

/** Frequency estimate from the rate of zero crossings of x[from..to) (0 when there are too few). */
function zeroCrossHz(x: Float32Array, from: number, to: number, rate: number): number {
  let n = 0;
  let first = -1;
  let last = -1;
  for (let i = Math.max(1, from); i < Math.min(to, x.length); i++) {
    if (x[i - 1]! < 0 !== x[i]! < 0) {
      if (first < 0) first = i;
      last = i;
      n++;
    }
  }
  if (n < 3 || last <= first) return 0;
  return ((n - 1) / 2) * (rate / (last - first));
}

/** Power spectrum of 8192 samples of `x` from `start` (Hann window), bins 0..4096. */
function powerSpectrum(x: Float32Array, start: number, size: number): Float64Array {
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const n = Math.min(size, x.length - start);
  for (let i = 0; i < n; i++) re[i] = x[start + i]! * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1)));
  fft(re, im);
  const p = new Float64Array(size / 2 + 1);
  for (let k = 0; k <= size / 2; k++) p[k] = re[k]! * re[k]! + im[k]! * im[k]!;
  return p;
}

/**
 * Analyse one rendered hit. `left` and `right` are the engine's voice output at `rate`
 * (right may be omitted for a mono sound). The render should begin at the trigger.
 */
export function analyseVoice(left: Float32Array, right: Float32Array | null = null, rate = ANALYSIS_RATE): VoiceMetrics {
  const m = emptyMetrics(rate);
  const len = right ? Math.min(left.length, right.length) : left.length;
  m.samples = len;
  if (!len) return m;
  const mono = new Float32Array(len);
  let peak = 0;
  let nonFinite = false;
  for (let i = 0; i < len; i++) {
    const l = left[i]!;
    const r = right ? right[i]! : l;
    if (!Number.isFinite(l) || !Number.isFinite(r)) {
      nonFinite = true;
      continue;
    }
    mono[i] = (l + r) / 2;
    const a = Math.max(Math.abs(l), Math.abs(r));
    if (a > peak) peak = a;
  }
  m.peak = peak;
  if (nonFinite) {
    m.peak = Infinity;
    return m;
  }
  if (peak < 1e-4) return m;
  m.silent = peak < 0.003;

  // 1 ms envelope (block peaks of the mono sum, relative scale kept absolute)
  const bs = Math.max(1, Math.round((BLOCK * rate) / ANALYSIS_RATE));
  const nb = Math.ceil(len / bs);
  const env = new Float32Array(nb);
  let clip = 0;
  for (let b = 0; b < nb; b++) {
    let e = 0;
    for (let i = b * bs; i < Math.min(len, (b + 1) * bs); i++) {
      const l = Math.abs(left[i]!);
      const r = right ? Math.abs(right[i]!) : l;
      const a = Math.max(l, r);
      if (a > e) e = a;
      if (a >= 0.99) clip++;
    }
    env[b] = e;
  }
  m.clipFrac = clip / len;
  // peak hold over 12 ms: a low tone's 1 ms block peaks follow its waveform (a 55 Hz sine is near zero for 5 ms of every 18), not its level
  const hold = Math.max(1, Math.round((12 * rate) / 1000 / bs));
  const held = new Float32Array(nb);
  for (let b = 0; b < nb; b++) {
    let e = 0;
    for (let j = Math.max(0, b - hold + 1); j <= b; j++) if (env[j]! > e) e = env[j]!;
    held[b] = e;
  }
  env.set(held);
  let pk = 0;
  let pkB = 0;
  for (let b = 0; b < nb; b++)
    if (env[b]! > pk) {
      pk = env[b]!;
      pkB = b;
    }
  const msPerBlock = (bs / rate) * 1000;
  let endB = 0;
  for (let b = 0; b < nb; b++) if (env[b]! > END) endB = b;
  m.lengthMs = (endB + 1) * msPerBlock;
  const onsetB = (() => {
    for (let b = 0; b < nb; b++) if (env[b]! >= pk * 0.02) return b;
    return 0;
  })();
  m.attackMs = Math.max(0, (pkB - onsetB) * msPerBlock);
  const find = (frac: number): number => {
    for (let b = pkB; b < nb; b++) if (env[b]! < pk * frac) return (b - pkB) * msPerBlock;
    return (nb - pkB) * msPerBlock;
  };
  m.t20Ms = find(0.1);
  m.t60Ms = find(0.001);
  m.tailHot = pk > 0 ? env[nb - 1]! / pk : 0;

  // level over the audible part, and its offset
  const aEnd = Math.min(len, (endB + 1) * bs);
  const onset = onsetB * bs;
  let sum = 0;
  let mean = 0;
  for (let i = 0; i < aEnd; i++) {
    sum += mono[i]! * mono[i]!;
    mean += mono[i]!;
  }
  m.rms = Math.sqrt(sum / Math.max(1, aEnd));
  m.dc = pk > 0 ? Math.abs(mean / Math.max(1, aEnd)) / pk : 0;

  // transient: the first 6 ms against the next 54
  const w1 = Math.round(0.006 * rate);
  const w2 = Math.round(0.06 * rate);
  let e1 = 0;
  let e2 = 0;
  for (let i = onset; i < Math.min(len, onset + w1); i++) e1 += mono[i]! * mono[i]!;
  for (let i = onset + w1; i < Math.min(len, onset + w2); i++) e2 += mono[i]! * mono[i]!;
  const p1 = e1 / w1;
  const p2 = e2 / Math.max(1, w2 - w1);
  m.transientDb = 10 * Math.log10((p1 + 1e-12) / (p2 + 1e-12));

  // spectrum of the first 186 ms from the onset
  const size = 8192;
  const pw = powerSpectrum(mono, onset, size);
  const binHz = rate / size;
  let tot = 0;
  let wsum = 0;
  let lo = 0;
  let mi = 0;
  let hi = 0;
  let logSum = 0;
  let cnt = 0;
  let arith = 0;
  const k0 = Math.max(1, Math.ceil(30 / binHz));
  const k1 = Math.min(size / 2, Math.floor(16000 / binHz));
  for (let k = k0; k <= k1; k++) {
    const v = pw[k]!;
    tot += v;
    wsum += v * k * binHz;
    const f = k * binHz;
    if (f < 150) lo += v;
    else if (f < 5000) mi += v;
    else hi += v;
    if (f >= 100 && f <= 12000) {
      logSum += Math.log(v + 1e-18);
      arith += v;
      cnt++;
    }
  }
  if (tot > 0) {
    m.centroid = wsum / tot;
    m.low = lo / tot;
    m.mid = mi / tot;
    m.high = hi / tot;
  }
  if (cnt && arith > 0) m.flatness = Math.min(1, Math.exp(logSum / cnt) / (arith / cnt));
  // tonality: power in the six strongest local maxima (each with its 2 neighbours either side)
  if (tot > 0) {
    const peaks: [number, number][] = [];
    for (let k = k0 + 1; k < k1; k++) if (pw[k]! > pw[k - 1]! && pw[k]! >= pw[k + 1]!) peaks.push([pw[k]!, k]);
    peaks.sort((a, b) => b[0] - a[0]);
    const used = new Uint8Array(pw.length);
    let share = 0;
    let took = 0;
    for (const [, k] of peaks) {
      if (took >= 6) break;
      if (used[k]) continue;
      for (let j = Math.max(k0, k - 3); j <= Math.min(k1, k + 3); j++) {
        if (!used[j]) share += pw[j]!;
        used[j] = 1;
      }
      took++;
    }
    m.tonality = Math.min(1, share / tot);
  }
  // noise: flat spectrum and no dominant peaks (flatness is on a power scale, so it is small even for noise through a filter)
  m.noise = Math.max(0, Math.min(1, 0.5 * Math.min(1, m.flatness * 8) + 0.5 * (1 - m.tonality)));

  // cheap pitch movement
  const w = (s: number) => Math.round((s / 1000) * rate);
  m.zcEarlyHz = zeroCrossHz(mono, onset, onset + w(12), rate);
  m.zcLateHz = zeroCrossHz(mono, onset + w(60), onset + w(160), rate);
  if (m.zcEarlyHz > 0 && m.zcLateHz > 0) m.sweepOct = Math.log2(m.zcEarlyHz / m.zcLateHz);
  // steadiness across the body: zero-crossing rate in six 25 ms windows
  const rates: number[] = [];
  for (let s = 40; s < 190; s += 25) {
    const z = zeroCrossHz(mono, onset + w(s), onset + w(s + 25), rate);
    if (z > 0) rates.push(Math.log2(z));
  }
  if (rates.length >= 3) {
    const mean2 = rates.reduce((a, b) => a + b, 0) / rates.length;
    const sd = Math.sqrt(rates.reduce((a, b) => a + (b - mean2) ** 2, 0) / rates.length);
    m.pitchStability = Math.max(0, 1 - sd * 2);
  }
  return m;
}

/** Peak of a rendered voice, the cheap part of `analyseVoice` (for quick rejects). */
export function peakOf(left: Float32Array, right: Float32Array | null = null): number {
  let p = 0;
  for (let i = 0; i < left.length; i++) p = Math.max(p, Math.abs(left[i]!), right ? Math.abs(right[i]!) : 0);
  return p;
}
