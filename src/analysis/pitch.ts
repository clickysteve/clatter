/**
 * Pitch analysis of rendered percussion. It works on audio, never on parameter values: the
 * audible pitch of a drum is whatever the oscillators, the pitch envelope, FM, filters and
 * samples add up to.
 *
 * Method (version 1):
 *
 *   1. YIN (de Cheveigne and Kawahara 2002) over short frames: the difference function, its
 *      cumulative mean normalisation and an absolute threshold. The first dip under the
 *      threshold wins, which keeps a low drum from being heard an octave down, and the depth of
 *      the dip is the frame's confidence. A FFT peak is never taken for the fundamental.
 *   2. The per-frame f0 track is cleaned (a median over neighbours), then summarised in a way
 *      that suits drums: the INITIAL pitch (the first voiced frames, the attack of a pitch
 *      envelope), the SETTLED body pitch (the longest steady stretch at the end) and the sweep
 *      between them in cents.
 *   3. When no coherent period is found, a Hann-windowed spectrum of the attack decides between
 *      INHARMONIC (several strong, unrelated partials: bells, cymbals, metallic FM) and UNPITCHED
 *      (noise: no partial stands out of the floor). Only pitched results carry a note name.
 *
 * Pure functions of (samples, rate): no clock, no randomness, no engine, so the same audio
 * always gives the same result. `PitchAnalysis` is the reusable record later phases (sample
 * export, scale quantisation) read; it carries nothing of the synthesis parameters.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */

export const PITCH_ANALYSIS_VERSION = 1;
export const PITCH_METHOD = 'YIN+SPECTRUM/1';
/** Concert pitch: MIDI note 69 is this many Hz. */
export const A4_HZ = 440;

export type PitchKind = 'stable' | 'swept' | 'inharmonic' | 'unpitched' | 'silent';

export const KIND_LABEL: Record<PitchKind, string> = { stable: 'STABLE PITCH', swept: 'PITCH SWEEP', inharmonic: 'INHARMONIC', unpitched: 'UNPITCHED', silent: 'SILENT' };

/** A frequency with its nearest equal-tempered note. */
export interface PitchPoint {
  hz: number;
  /** the nearest MIDI note number (60 = C4, 69 = A4) */
  midi: number;
  /** the note name with octave, e.g. "A1", "F#2" */
  note: string;
  /** deviation from that note, -50 to +50 */
  cents: number;
}

/** One analysis frame of the pitch track. `hz` is null where no pitch was found. */
export interface ContourPoint {
  /** seconds from the onset of the sound (centre of the frame) */
  t: number;
  hz: number | null;
  /** 0-1 */
  conf: number;
  /** frame level, linear (0-1) */
  level: number;
}

export interface PitchAnalysis {
  version: number;
  method: string;
  kind: PitchKind;
  /**
   * The headline pitch, null when there is no reliable single fundamental. For a STABLE sound
   * the median pitch; for a SWEEP the settled body pitch (see `initial`).
   */
  fundamental: PitchPoint | null;
  /** 0-1: how sure the analysis is that the sound has this one fundamental */
  confidence: number;
  /** 0-1: how steady the pitch is where it settles (1 = no wander) */
  stability: number;
  /** the pitch at the attack and the settled body pitch (equal for a stable sound); null when unpitched */
  initial: PitchPoint | null;
  settled: PitchPoint | null;
  /** initial against settled in cents (positive: the pitch falls to its body) */
  sweepCents: number;
  /** seconds from the onset until the pitch is within 50 cents of its settled value */
  settleTime: number;
  /** the pitch track over time */
  contour: ContourPoint[];
  /** strongest spectral partials in Hz, ascending (filled for inharmonic and, when found, pitched sounds) */
  partials: number[];
  /** sample rate and seconds of audio analysed */
  rate: number;
  analysed: number;
  /** why, in words */
  reason: string;
}

export interface PitchOptions {
  /** lowest and highest fundamental searched (Hz) */
  minHz?: number;
  maxHz?: number;
  /** analysis hop in seconds */
  hop?: number;
  /** seconds of sound analysed after the onset */
  maxSeconds?: number;
}

// ---------------------------------------------------------------------------- notes
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export const hzToMidiFloat = (hz: number): number => 69 + 12 * Math.log2(hz / A4_HZ);
export const midiToHz = (m: number): number => A4_HZ * Math.pow(2, (m - 69) / 12);
export const noteName = (n: number): string => NAMES[((n % 12) + 12) % 12]! + (Math.floor(n / 12) - 1);

export function pitchPoint(hz: number): PitchPoint {
  const m = hzToMidiFloat(hz);
  const n = Math.round(m);
  return { hz, midi: n, note: noteName(n), cents: Math.round((m - n) * 1000) / 10 };
}

export const centsBetween = (a: number, b: number): number => 1200 * Math.log2(a / b);

// ---------------------------------------------------------------------------- small statistics
function median(v: number[]): number {
  if (!v.length) return NaN;
  const s = v.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function weightedMedian(v: number[], w: number[]): number {
  if (!v.length) return NaN;
  const idx = v.map((_, i) => i).sort((a, b) => v[a]! - v[b]!);
  const total = w.reduce((a, b) => a + b, 0) || 1;
  let acc = 0;
  for (const i of idx) {
    acc += w[i]!;
    if (acc >= total / 2) return v[i]!;
  }
  return v[idx[idx.length - 1]!]!;
}

/** Spearman correlation of a series with its index (-1 falling, +1 rising). */
function rankCorrelation(v: number[]): number {
  const n = v.length;
  if (n < 3) return 0;
  const order = v.map((_, i) => i).sort((a, b) => v[a]! - v[b]!);
  const rank = new Array<number>(n);
  order.forEach((i, r) => (rank[i] = r));
  let d2 = 0;
  for (let i = 0; i < n; i++) d2 += (rank[i]! - i) ** 2;
  return 1 - (6 * d2) / (n * (n * n - 1));
}

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));
const round = (x: number, d: number): number => Math.round(x * 10 ** d) / 10 ** d;

// ---------------------------------------------------------------------------- FFT
/** In-place radix-2 FFT (size a power of two). */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const xr = re[b]! * cr - im[b]! * ci;
        const xi = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - xr;
        im[b] = im[a]! - xi;
        re[a] = re[a]! + xr;
        im[a] = im[a]! + xi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

// ---------------------------------------------------------------------------- YIN
const YIN_DIP = 0.15;
/** a frame is voiced when its normalised difference dips under this (confidence over 0.7) */
const VOICED = 0.3;

interface Frame {
  hz: number | null;
  conf: number;
}

/** One YIN frame over `sig[s .. s + W + tauMax)`. */
function yin(sig: Float32Array, s: number, W: number, tauMin: number, tauMax: number, cm: Float64Array, df: Float64Array, rate: number): Frame {
  // difference function and its cumulative mean normalisation, in one pass
  cm[0] = 1;
  let run = 0;
  for (let tau = 1; tau <= tauMax; tau++) {
    let d = 0;
    for (let j = 0; j < W; j++) {
      const e = sig[s + j]! - sig[s + j + tau]!;
      d += e * e;
    }
    df[tau] = d;
    run += d;
    cm[tau] = run > 0 ? (d * tau) / run : 1;
  }
  // the first dip under the threshold; its bottom is the lowest point of the stretch that stays under it
  // (walking downhill only would stop on the first ripple that noise puts in the curve)
  let best = -1;
  for (let tau = tauMin; tau <= tauMax; tau++) {
    if (cm[tau]! < YIN_DIP) {
      best = tau;
      while (tau + 1 <= tauMax && cm[tau + 1]! < YIN_DIP) {
        tau++;
        if (cm[tau]! < cm[best]!) best = tau;
      }
      break;
    }
  }
  if (best < 0) {
    // no clean dip: the first local minimum that is nearly as deep as the deepest (not a later multiple of the period)
    let lo = Infinity;
    for (let tau = tauMin; tau <= tauMax; tau++) lo = Math.min(lo, cm[tau]!);
    for (let tau = tauMin + 1; tau < tauMax; tau++) {
      if (cm[tau]! <= lo * 1.1 + 0.02 && cm[tau]! <= cm[tau - 1]! && cm[tau]! <= cm[tau + 1]!) {
        best = tau;
        break;
      }
    }
  }
  if (best < 0) return { hz: null, conf: 0 };
  const c = cm[best]!;
  const conf = clamp01(1 - c);
  if (c > VOICED) return { hz: null, conf };
  // the normalised curve is tilted by its running mean: settle on the bottom of the raw difference nearby, then interpolate it
  for (let k = Math.max(tauMin, best - 4); k <= Math.min(tauMax, best + 4); k++) if (df[k]! < df[best]!) best = k;
  let tau = best;
  if (best > tauMin && best < tauMax) {
    const a = df[best - 1]!;
    const b = df[best]!;
    const g = df[best + 1]!;
    const den = a - 2 * b + g;
    if (den > 1e-18) tau = best + (a - g) / (2 * den);
  }
  return { hz: rate / tau, conf };
}

// ---------------------------------------------------------------------------- spectrum
interface Peak {
  hz: number;
  power: number;
}

/** Strong tonal peaks of the attack: partials that stand well out of the noise floor. */
function spectralPeaks(x: Float32Array, rate: number): Peak[] {
  const N = rate > 50000 ? 16384 : 8192;
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const n = Math.min(N, x.length);
  for (let i = 0; i < n; i++) re[i] = x[i]! * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1 || 1)));
  fft(re, im);
  const half = N / 2;
  const P = new Float64Array(half);
  for (let k = 0; k < half; k++) P[k] = re[k]! * re[k]! + im[k]! * im[k]!;
  const bin = rate / N;
  const k0 = Math.max(2, Math.ceil(30 / bin));
  const k1 = half - 3;
  let top = 0;
  for (let k = k0; k <= k1; k++) top = Math.max(top, P[k]!);
  if (top <= 0) return [];
  const floor = Math.max(median(Array.from(P.subarray(k0, k1 + 1))), top * 1e-9);
  // 25 dB over the median is far beyond the scatter of a noise spectrum (about 11 dB at the top)
  const gate = Math.max(floor * 316, top * 10 ** -3.5);
  const mask = Float64Array.from(P);
  const out: Peak[] = [];
  for (let found = 0; found < 8; found++) {
    let kb = -1;
    let pb = gate;
    for (let k = k0; k <= k1; k++) {
      if (mask[k]! > pb && P[k]! >= P[k - 1]! && P[k]! >= P[k + 1]!) {
        pb = mask[k]!;
        kb = k;
      }
    }
    if (kb < 0) break;
    // parabolic interpolation on the log power
    const a = Math.log(P[kb - 1]! + 1e-30);
    const b = Math.log(P[kb]! + 1e-30);
    const c = Math.log(P[kb + 1]! + 1e-30);
    const den = a - 2 * b + c;
    const off = den < -1e-12 ? (0.5 * (a - c)) / den : 0;
    out.push({ hz: (kb + off) * bin, power: P[kb]! });
    for (let k = Math.max(0, kb - 4); k <= Math.min(half - 1, kb + 4); k++) mask[k] = 0;
  }
  return out.sort((p, q) => p.hz - q.hz);
}

/**
 * How well the strong partials are whole multiples of f0, by energy and by count. A partial
 * matches the n-th harmonic when it is within 3% of f0 plus 0.4% per harmonic number, but never
 * tighter than one spectral bin (the measurement cannot be). `lowest` is the harmonic number of
 * the lowest strong partial: when the first real energy is far above f0 the "pitch" is a
 * near-common divisor of unrelated partials (a bell), not something the ear hears as a note.
 */
function harmonicShare(peaks: Peak[], f0: number, binHz: number): { energy: number; count: number; lowest: number } {
  let on = 0;
  let all = 0;
  let hit = 0;
  for (const p of peaks) {
    all += p.power;
    const r = p.hz / f0;
    const n = Math.max(1, Math.round(r));
    if (Math.abs(r - n) <= Math.max(0.03 + 0.004 * n, binHz / f0)) {
      on += p.power;
      hit++;
    }
  }
  return { energy: all > 0 ? on / all : 1, count: peaks.length ? hit / peaks.length : 1, lowest: peaks.length ? peaks[0]!.hz / f0 : 1 };
}

// ---------------------------------------------------------------------------- the analysis
function empty(kind: PitchKind, rate: number, reason: string, extra: Partial<PitchAnalysis> = {}): PitchAnalysis {
  return {
    version: PITCH_ANALYSIS_VERSION,
    method: PITCH_METHOD,
    kind,
    fundamental: null,
    confidence: 0,
    stability: 0,
    initial: null,
    settled: null,
    sweepCents: 0,
    settleTime: 0,
    contour: [],
    partials: [],
    rate,
    analysed: 0,
    reason,
    ...extra,
  };
}

/** Estimate the pitch of a rendered sound (one channel, or several that are averaged). */
export function analysePitch(input: Float32Array | Float32Array[], rate: number, opts: PitchOptions = {}): PitchAnalysis {
  const chans = Array.isArray(input) ? input : [input];
  const len = Math.min(...chans.map((c) => c.length));
  if (!len) return empty('silent', rate, 'NO AUDIO');
  const mono = new Float32Array(len);
  for (const c of chans) for (let i = 0; i < len; i++) mono[i]! += c[i]! / chans.length;

  let peak = 0;
  for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(mono[i]!));
  if (!(peak >= 1e-4)) return empty('silent', rate, 'THE SOUND IS SILENT');

  // start at the onset, analyse a bounded stretch
  let onset = 0;
  while (onset < len && Math.abs(mono[onset]!) < peak * 0.02) onset++;
  const maxLen = Math.round((opts.maxSeconds ?? 1.5) * rate);
  const x = mono.subarray(onset, Math.min(len, onset + maxLen));

  const W = Math.round((1024 * rate) / 44100);
  const tauMax = Math.floor(rate / (opts.minHz ?? 25));
  const tauMin = Math.max(2, Math.floor(rate / (opts.maxHz ?? 4000)));
  const hop = Math.max(1, Math.round((opts.hop ?? 0.01) * rate));
  const sig = new Float32Array(x.length + W + tauMax + 1);
  sig.set(x);
  const cm = new Float64Array(tauMax + 2);
  const df = new Float64Array(tauMax + 2);

  // frames: quiet ones are skipped (40 dB under the peak), the rest run through YIN
  const contour: ContourPoint[] = [];
  let activeFrames = 0;
  for (let s = 0; s + W / 2 < x.length; s += hop) {
    let sum = 0;
    const end = Math.min(x.length, s + W);
    for (let j = s; j < end; j++) sum += x[j]! * x[j]!;
    const rms = Math.sqrt(sum / W);
    const level = Math.min(1, rms / peak);
    const t = round((s + W / 2) / rate, 4);
    if (level < 0.01) {
      contour.push({ t, hz: null, conf: 0, level: round(level, 4) });
      continue;
    }
    activeFrames++;
    const f = yin(sig, s, W, tauMin, tauMax, cm, df, rate);
    contour.push({ t, hz: f.hz, conf: round(f.conf, 3), level: round(level, 4) });
  }
  const analysed = x.length / rate;

  // clean the track: a 5-point median in the log domain over runs of voiced frames removes octave slips
  const hzs = contour.map((c) => c.hz);
  for (let i = 0; i < contour.length; i++) {
    const c = contour[i]!;
    if (c.hz === null) continue;
    const near: number[] = [];
    for (let k = Math.max(0, i - 2); k <= Math.min(contour.length - 1, i + 2); k++) if (hzs[k] !== null) near.push(Math.log2(hzs[k]!));
    if (near.length >= 3) {
      const m = median(near);
      if (Math.abs(Math.log2(c.hz) - m) * 1200 > 400) c.hz = null; // a slip of 4+ semitones from its neighbours: not a pitch
    }
  }
  for (const c of contour) if (c.hz !== null) c.hz = round(c.hz, 3);

  const active = contour.filter((c) => c.level >= 0.01);
  const voiced = contour.filter((c) => c.hz !== null);
  const wOf = (c: ContourPoint) => c.level * Math.max(0.05, c.conf);
  const coverage = active.length ? voiced.length / active.length : 0;
  const meanConf = voiced.length ? voiced.reduce((a, c) => a + c.conf * c.level, 0) / (voiced.reduce((a, c) => a + c.level, 0) || 1) : 0;
  let confidence = clamp01(meanConf * Math.min(1, coverage * 1.5));
  if (voiced.length < 3) confidence *= 0.6; // a click: too brief to be sure

  const peaks = spectralPeaks(x.subarray(0, Math.min(x.length, 8192 * Math.max(1, Math.round(rate / 44100)))), rate);
  const partials = peaks.map((p) => round(p.hz, 1));

  // ---- a coherent period was found
  pitched: if (voiced.length >= 2 && confidence >= 0.5) {
    const hz = voiced.map((c) => c.hz!);
    const lg = hz.map((v) => Math.log2(v));
    const w = voiced.map(wOf);
    // the settled body: the longest steady stretch at the end (within 60 cents of the final pitch, one slip allowed)
    const tail = lg.slice(-Math.max(3, Math.ceil(lg.length * 0.3)));
    const ref = median(tail);
    let start = lg.length - 1;
    let slips = 0;
    for (let i = lg.length - 1; i >= 0; i--) {
      if (Math.abs(lg[i]! - ref) * 1200 <= 60) start = i;
      else if (++slips > 1) break;
    }
    const body = hz.slice(start);
    const settledHz = weightedMedian(body, w.slice(start));
    const first = hz.slice(0, Math.min(3, hz.length));
    const initialHz = median(first);
    const sweep = centsBetween(initialHz, settledHz);
    // a sweep moves one way: the pitch rank follows time, which separates a falling kick from a wandering estimate
    const swept = Math.abs(sweep) >= 100 && start > 0 && Math.abs(rankCorrelation(lg)) >= 0.5;
    const headHz = swept ? settledHz : weightedMedian(hz, w);
    const dev = (swept ? body : hz).map((v) => centsBetween(v, swept ? settledHz : headHz));
    const stability = round(clamp01(1 - (median(dev.map(Math.abs)) * 1.4826) / 40), 3);
    const share = peaks.length >= 1 ? harmonicShare(peaks, headHz, rate / (rate > 50000 ? 16384 : 8192)) : { energy: 1, count: 1, lowest: 1 };
    // the spectrum has to bear the period out: strong partials on its multiples, and real energy at or near it. A period that the
    // spectrum contradicts (unrelated partials carrying the energy, the first partial well above it) is a coincidence of the
    // waveform, not a note; a lone tone elsewhere in the spectrum is handled below as the spectral estimate.
    const spectrumAgrees = peaks.length === 0 || (peaks.length === 1 ? share.lowest >= 0.8 && share.lowest <= 2.5 : share.energy >= 0.6 && (share.count >= 0.5 || confidence >= 0.9) && share.lowest <= 2.5);
    // a sweep smears its partials, so it is held to a stricter YIN confidence instead
    if (swept ? confidence < 0.7 : !spectrumAgrees) break pitched;
    let from = voiced.length - 1;
    while (from > 0 && Math.abs(centsBetween(voiced[from - 1]!.hz!, settledHz)) <= 50) from--;
    const settleTime = swept ? voiced[from]!.t : 0;
    const fundamental = pitchPoint(headHz);
    return {
      version: PITCH_ANALYSIS_VERSION,
      method: PITCH_METHOD,
      kind: swept ? 'swept' : 'stable',
      fundamental,
      confidence: round(confidence, 3),
      stability,
      initial: pitchPoint(initialHz),
      settled: pitchPoint(settledHz),
      sweepCents: round(sweep, 1),
      settleTime,
      contour,
      partials,
      rate,
      analysed,
      reason: swept ? `THE PITCH MOVES ${Math.abs(Math.round(sweep))} CENTS ${sweep > 0 ? 'DOWN' : 'UP'} FROM ${pitchPoint(initialHz).note} TO ITS SETTLED BODY ${fundamental.note}` : `A STEADY PERIOD OF ${round(headHz, 2)} HZ`,
    };
  }

  // ---- no coherent period: tonal or noisy?
  if (peaks.length >= 2) {
    return empty('inharmonic', rate, `${peaks.length} STRONG PARTIALS THAT SHARE NO SINGLE FUNDAMENTAL`, { confidence: round(confidence * 0.5, 3), partials, contour, analysed });
  }
  if (peaks.length === 1) {
    // one tone but no period (too low, or too short for the frames): the spectral peak, with modest confidence. A lone high ring (a clap, a hat) is not taken for a note.
    const hz = peaks[0]!.hz;
    if (hz >= 30 && hz <= 1000) {
      const pp = pitchPoint(hz);
      return {
        ...empty('stable', rate, 'A SINGLE SPECTRAL TONE WITHOUT A MEASURABLE PERIOD: THE ESTIMATE IS LESS CERTAIN', { partials, contour, analysed }),
        fundamental: pp,
        initial: pp,
        settled: pp,
        confidence: round(Math.min(0.5, Math.max(confidence, 0.3)), 3),
        stability: 0.5,
      };
    }
  }
  return empty('unpitched', rate, 'NO PARTIAL STANDS OUT OF THE NOISE: THERE IS NO RELIABLE PITCH', { confidence: round(Math.min(confidence, 0.3), 3), contour, analysed });
}
