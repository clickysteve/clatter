/**
 * Waveforms and envelope curves: pure functions, no state, shared by the engine and the editor
 * (the editor draws exactly what the engine computes).
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import { CUSTOM_POINTS, type EnvDef, type LfoDef, type LfoWave } from './types';

/** A deterministic hash of integers to [0, 1). */
export function hash01(a: number, b = 0, c = 0, d = 0): number {
  let h = (Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca6b) ^ Math.imul(c | 0, 0xc2b2ae35) ^ Math.imul(d | 0, 0x27d4eb2f)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}
/** -1..1 */
export const hashBi = (a: number, b = 0, c = 0, d = 0): number => hash01(a, b, c, d) * 2 - 1;

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const frac = (x: number): number => x - Math.floor(x);

/** Warp a phase so that its midpoint moves to `w` (0.5 = unchanged): skew for sine and triangle. */
export function warp(p: number, w: number): number {
  const k = clamp(w, 0.02, 0.98);
  return p < k ? (p / k) * 0.5 : 0.5 + ((p - k) / (1 - k)) * 0.5;
}

/** Catmull-Rom interpolation of a periodic table at phase p (0-1). */
export function tableAt(t: readonly number[], p: number): number {
  const n = t.length;
  if (!n) return 0;
  const x = frac(p) * n;
  const i = Math.floor(x);
  const f = x - i;
  const y0 = t[(i + n - 1) % n]!;
  const y1 = t[i % n]!;
  const y2 = t[(i + 1) % n]!;
  const y3 = t[(i + 2) % n]!;
  return clamp(y1 + 0.5 * f * (y2 - y0 + f * (2 * y0 - 5 * y1 + 4 * y2 - y3 + f * (3 * (y1 - y2) + y3 - y0))), -1, 1);
}

export const randomSteps = (w: LfoWave): number => (w === 'sh' ? 1 : w === 'step' ? 8 : w === 'smooth' ? 4 : 0);

/**
 * One LFO value, -1..1, for a cycle position `cyc` (cycles since the source started; the integer
 * part counts cycles, the fraction is the phase). `salt` separates the random streams of
 * different sources and hits.
 */
export function lfoWave(d: Pick<LfoDef, 'wave' | 'width' | 'bend' | 'table' | 'seed'>, cyc: number, salt = 0): number {
  const p = frac(cyc);
  let w: number;
  switch (d.wave) {
    case 'sine':
      w = Math.sin(2 * Math.PI * warp(p, d.width));
      break;
    case 'tri': {
      const q = warp(p, d.width);
      w = q < 0.5 ? q * 4 - 1 : 3 - q * 4;
      break;
    }
    case 'sawup':
      w = p * 2 - 1;
      break;
    case 'sawdn':
      w = 1 - p * 2;
      break;
    case 'square':
      w = p < 0.5 ? 1 : -1;
      break;
    case 'pulse':
      w = p < clamp(d.width, 0.02, 0.98) ? 1 : -1;
      break;
    case 'sh':
    case 'step': {
      const n = randomSteps(d.wave);
      w = hashBi(d.seed, salt, Math.floor(cyc * n));
      break;
    }
    case 'smooth': {
      const x = cyc * 4;
      const i = Math.floor(x);
      const f = x - i;
      const a = hashBi(d.seed, salt, i);
      const b = hashBi(d.seed, salt, i + 1);
      w = a + (b - a) * (0.5 - 0.5 * Math.cos(Math.PI * f));
      break;
    }
    case 'custom':
      w = d.table ? tableAt(d.table, p) : 0;
      break;
  }
  if (d.bend) {
    const k = Math.pow(2, -clamp(d.bend, -1, 1) * 2);
    w = Math.sign(w) * Math.pow(Math.abs(w), k);
  }
  return w;
}

/** The shape of one curved segment: x 0-1 → 0-1; c < 0 starts fast, c > 0 starts slow. */
export function curveShape(x: number, c: number): number {
  if (Math.abs(c) < 0.001) return x;
  const k = c * 5;
  return (Math.exp(k * x) - 1) / (Math.exp(k) - 1);
}

/** One segment of an envelope timeline. */
export interface EnvSeg {
  /** start time (s) */
  t0: number;
  /** duration (s) */
  dur: number;
  from: number;
  to: number;
  c: number;
  /** the segment is the sustain hold (a flat level) */
  hold?: boolean;
}

/**
 * The timeline of an envelope: ADSR and AHDSR as segments, MULTI as its breakpoints. `unit` is
 * seconds per time unit (0.001 for milliseconds, 60 / bpm for beats). The sustain segment holds
 * the sustain level for `gate`; the release follows at once when the gate is 0.
 */
export function envSegments(e: EnvDef, unit: number, from0 = 0): EnvSeg[] {
  const segs: EnvSeg[] = [];
  let t = 0;
  const push = (dur: number, from: number, to: number, c: number, hold = false) => {
    const d = Math.max(0, dur) * unit;
    segs.push({ t0: t, dur: d, from, to, c, ...(hold ? { hold } : {}) });
    t += d;
  };
  if (e.kind === 'multi') {
    let level = from0 || e.v0;
    for (const p of e.pts) {
      push(p.t, level, p.v, p.c);
      level = p.v;
    }
    return segs;
  }
  push(e.a, from0, 1, e.curve);
  if (e.kind === 'ahdsr' && e.h > 0) push(e.h, 1, 1, 0, true);
  push(e.d, 1, e.s, -e.curve);
  if (e.gate > 0) push(e.gate, e.s, e.s, 0, true);
  push(e.r, e.s, 0, -e.curve);
  return segs;
}

/** The level at time `t` (s) in a timeline; `done` is true past the end of a non-looping envelope. */
export function envAt(segs: readonly EnvSeg[], t: number, loop: { from: number; to: number } | null): { v: number; done: boolean } {
  if (!segs.length) return { v: 0, done: true };
  const last = segs[segs.length - 1]!;
  const end = last.t0 + last.dur;
  if (loop) {
    const a = segs[clamp(loop.from, 0, segs.length - 1)]!;
    const bSeg = segs[clamp(loop.to, 0, segs.length - 1)]!;
    const ls = a.t0 + a.dur;
    const le = bSeg.t0 + bSeg.dur;
    if (le > ls && t >= le) t = ls + ((t - ls) % (le - ls));
  }
  if (t >= end) return { v: last.to, done: !loop };
  for (const s of segs) {
    if (t < s.t0 + s.dur) {
      if (s.dur <= 0) continue;
      const x = (t - s.t0) / s.dur;
      return { v: s.from + (s.to - s.from) * curveShape(x, s.c), done: false };
    }
  }
  return { v: last.to, done: !loop };
}

/** A fresh custom waveform: one sine cycle. */
export const sineTable = (): number[] => Array.from({ length: CUSTOM_POINTS }, (_, i) => Math.sin((2 * Math.PI * i) / CUSTOM_POINTS));
