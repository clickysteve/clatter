/**
 * Lightweight sound analysis: what a rendered drum hit is like, measured, not guessed from its
 * parameters. Used by the kit check (kitcheck.ts) to choose between candidate designs of a voice,
 * and by the tests to verify that a generated kick is a kick.
 *
 *   peak, rms        level
 *   attackMs         time to 90 % of the peak
 *   decayMs          time from the peak until it stays below -20 dB of it
 *   lengthMs         time until it stays below -60 dBFS
 *   f0               the fundamental of the body (autocorrelation, 50-120 ms, or 10-50 ms for short sounds), 0 if unpitched
 *   centroid         spectral centroid (Hz) of the energy-weighted spectrum of the first 300 ms
 *   lowRatio         share of that energy below 150 Hz
 *   flatness         spectral flatness 0 (tonal) - 1 (noise), over 200 Hz - 16 kHz
 *   hfSustain        share of energy above 5 kHz in the tail (from 150 ms)
 *
 * One 2048-point FFT per frame, four frames: a few milliseconds per sound.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */

export interface SoundFeatures {
  peak: number;
  rms: number;
  attackMs: number;
  decayMs: number;
  lengthMs: number;
  f0: number;
  centroid: number;
  lowRatio: number;
  flatness: number;
  hfSustain: number;
}

const N = 2048;

/** In-place radix-2 FFT of (re, im), length a power of two. */
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

const HANN = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));

/** Power spectrum (N/2 bins) of the frame starting at `from`. */
function power(x: Float32Array, from: number): Float64Array {
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let i = 0; i < N; i++) re[i] = (x[from + i] ?? 0) * HANN[i]!;
  fft(re, im);
  const p = new Float64Array(N / 2);
  for (let i = 0; i < N / 2; i++) p[i] = re[i]! * re[i]! + im[i]! * im[i]!;
  return p;
}

/** The fundamental (Hz) of x[from..from+len] by normalised autocorrelation, 0 when nothing is periodic. */
export function fundamental(x: Float32Array, rate: number, from: number, len: number, minHz = 30, maxHz = 1200): number {
  const lo = Math.floor(rate / maxHz);
  const hi = Math.min(Math.ceil(rate / minHz), len - 1);
  let e0 = 0;
  for (let i = 0; i < len; i++) e0 += (x[from + i] ?? 0) ** 2;
  if (e0 < 1e-9) return 0;
  const r = new Float64Array(hi + 2);
  for (let lag = lo; lag <= hi + 1; lag++) {
    let s = 0;
    let e1 = 0;
    for (let i = 0; i + lag < len; i++) {
      const a = x[from + i] ?? 0;
      const b = x[from + i + lag] ?? 0;
      s += a * b;
      e1 += b * b;
    }
    r[lag] = s / Math.sqrt(e0 * e1 + 1e-12);
  }
  // the first strong peak (avoids octave errors towards long lags)
  let best = 0;
  let bestLag = 0;
  for (let lag = lo + 1; lag <= hi; lag++) {
    const v = r[lag]!;
    if (v > r[lag - 1]! && v >= r[lag + 1]! && v > 0.5) {
      if (v > best * 1.08) {
        best = v;
        bestLag = lag;
      }
      if (v > 0.85) break;
    }
  }
  if (!bestLag) return 0;
  // parabolic interpolation
  const a = r[bestLag - 1]!;
  const b = r[bestLag]!;
  const c = r[bestLag + 1]!;
  const d = a - 2 * b + c;
  const off = d !== 0 ? (0.5 * (a - c)) / d : 0;
  return rate / (bestLag + off);
}

export function analyse(x: Float32Array, rate = 44100): SoundFeatures {
  let peak = 0;
  let at = 0;
  let sum = 0;
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i]!);
    sum += a * a;
    if (a > peak) {
      peak = a;
      at = i;
    }
  }
  const ms = (n: number) => (n / rate) * 1000;
  if (peak < 1e-6) return { peak: 0, rms: 0, attackMs: 0, decayMs: 0, lengthMs: 0, f0: 0, centroid: 0, lowRatio: 0, flatness: 0, hfSustain: 0 };
  let onset = 0;
  while (onset < x.length && Math.abs(x[onset]!) < peak * 0.05) onset++;
  let a90 = onset;
  while (a90 < x.length && Math.abs(x[a90]!) < peak * 0.9) a90++;
  // envelope ends: last sample above -20 dB of the peak, and above -60 dBFS
  let d20 = at;
  let end = 0;
  for (let i = x.length - 1; i >= 0; i--) {
    const a = Math.abs(x[i]!);
    if (!end && a > 0.001) end = i;
    if (a > peak * 0.1) {
      d20 = i;
      break;
    }
  }
  if (!end) for (let i = x.length - 1; i >= 0; i--) if (Math.abs(x[i]!) > 0.001) {
    end = i;
    break;
  }
  // the body's pitch: after a kick's sweep when the sound is long enough, early for short sounds
  const long = end - onset > rate * 0.16;
  const f0 = fundamental(x, rate, onset + Math.round(rate * (long ? 0.05 : 0.01)), Math.round(rate * (long ? 0.07 : 0.04)));
  // energy-weighted spectrum over the first 300 ms
  const frames = [0, 0.02, 0.06, 0.15].map((s) => onset + Math.round(s * rate));
  const acc = new Float64Array(N / 2);
  let tail: Float64Array | null = null;
  for (const f of frames) {
    if (f >= x.length) break;
    const p = power(x, f);
    for (let i = 0; i < acc.length; i++) acc[i]! += p[i]!;
    if (f === frames[3]) tail = p;
  }
  const hz = (i: number) => (i * rate) / N;
  let tot = 0;
  let wsum = 0;
  let low = 0;
  let lg = 0;
  let ar = 0;
  let nf = 0;
  for (let i = 1; i < acc.length; i++) {
    const p = acc[i]!;
    tot += p;
    wsum += p * hz(i);
    if (hz(i) < 150) low += p;
    if (hz(i) >= 200 && hz(i) <= 16000) {
      lg += Math.log(p + 1e-18);
      ar += p;
      nf++;
    }
  }
  const flatness = nf && ar > 0 ? Math.exp(lg / nf) / (ar / nf) : 0;
  let hf = 0;
  if (tail) {
    let t = 0;
    let h = 0;
    for (let i = 1; i < tail.length; i++) {
      t += tail[i]!;
      if (hz(i) > 5000) h += tail[i]!;
    }
    hf = t > 0 ? h / t : 0;
  }
  return {
    peak,
    rms: Math.sqrt(sum / x.length),
    attackMs: ms(a90 - onset),
    decayMs: ms(Math.max(0, d20 - at)),
    lengthMs: ms(end),
    f0,
    centroid: tot > 0 ? wsum / tot : 0,
    lowRatio: tot > 0 ? low / tot : 0,
    flatness: Math.min(1, flatness),
    hfSustain: hf,
  };
}
