/**
 * Judging a rendered hit by how it sounds: how well it fits the instrument it is meant to be,
 * whether it is safe to hand to a player, how interesting it is, and how much two voices of a
 * kit are alike. Pure functions of the measurements in analysis/voiceAnalysis.ts.
 *
 * Instruments are TENDENCIES, not rules. Each profile is a list of trapezoids (zero outside
 * [a, d], one inside [b, c]) over a measurement. WILDNESS widens the shoulders of every trapezoid
 * and moves weight from "fits the convention" to "is interesting", so a high-wildness candidate
 * may be nothing like a kick and still win, while safety (no silence, no non-finite output, no
 * DC rumble, no endless drone) never relaxes.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import type { VoiceMetrics } from '../analysis/voiceAnalysis';

export type Instrument = 'kick' | 'ltom' | 'htom' | 'snare' | 'clap' | 'chat' | 'ohat' | 'cymbal' | 'perc' | 'fx';
export const INSTRUMENTS: Instrument[] = ['kick', 'ltom', 'htom', 'snare', 'clap', 'chat', 'ohat', 'cymbal', 'perc', 'fx'];

type Measure = 'low' | 'high' | 'centroid' | 'lengthMs' | 't20Ms' | 'attackMs' | 'noise' | 'tonality' | 'transientDb';
/** [a, b, c, d]: zero below a, rising to one at b, one up to c, falling to zero at d. */
type Trap = [number, number, number, number];
interface Criterion {
  m: Measure;
  t: Trap;
  w: number;
}

const PROFILES: Record<Instrument, Criterion[]> = {
  kick: [
    { m: 'low', t: [0.1, 0.35, 1, 1.01], w: 3 },
    { m: 'centroid', t: [30, 50, 1100, 3000], w: 2 },
    { m: 'lengthMs', t: [80, 170, 800, 1800], w: 1.5 },
    { m: 'attackMs', t: [-1, 0, 6, 25], w: 1 },
  ],
  ltom: [
    { m: 'low', t: [0.03, 0.15, 0.95, 1.01], w: 2 },
    { m: 'centroid', t: [60, 90, 1300, 3500], w: 2 },
    { m: 'lengthMs', t: [100, 200, 900, 2000], w: 1.5 },
    { m: 'tonality', t: [0.03, 0.15, 1, 1.01], w: 1.5 },
    { m: 'attackMs', t: [-1, 0, 8, 30], w: 1 },
  ],
  htom: [
    { m: 'low', t: [-1, 0, 0.6, 0.95], w: 1 },
    { m: 'centroid', t: [120, 200, 2500, 5000], w: 2 },
    { m: 'lengthMs', t: [80, 150, 700, 1600], w: 1.5 },
    { m: 'tonality', t: [0.03, 0.15, 1, 1.01], w: 1.5 },
    { m: 'attackMs', t: [-1, 0, 8, 30], w: 1 },
  ],
  snare: [
    { m: 'noise', t: [0.2, 0.4, 1, 1.01], w: 2 },
    { m: 'centroid', t: [600, 1400, 6500, 11000], w: 2 },
    { m: 'lengthMs', t: [50, 110, 500, 1200], w: 1.5 },
    { m: 'low', t: [-1, 0, 0.45, 0.85], w: 1 },
    { m: 'transientDb', t: [-4, 2, 60, 80], w: 1.5 },
  ],
  clap: [
    { m: 'noise', t: [0.25, 0.45, 1.01, 1.02], w: 2 },
    { m: 'centroid', t: [800, 1500, 7000, 12000], w: 2 },
    { m: 'lengthMs', t: [40, 90, 450, 1200], w: 1.5 },
    { m: 'low', t: [-1, 0, 0.2, 0.6], w: 1 },
  ],
  chat: [
    { m: 'lengthMs', t: [8, 25, 150, 400], w: 3 },
    { m: 'centroid', t: [2500, 4500, 15000, 16001], w: 2 },
    { m: 'high', t: [0.05, 0.25, 1.01, 1.02], w: 1.5 },
    { m: 'low', t: [-1, 0, 0.05, 0.3], w: 1.5 },
  ],
  ohat: [
    { m: 'lengthMs', t: [110, 220, 1000, 2200], w: 3 },
    { m: 'centroid', t: [2500, 4000, 15000, 16001], w: 2 },
    { m: 'high', t: [0.05, 0.2, 1.01, 1.02], w: 1.5 },
    { m: 'low', t: [-1, 0, 0.08, 0.3], w: 1.5 },
  ],
  cymbal: [
    { m: 'lengthMs', t: [250, 500, 2600, 5000], w: 3 },
    { m: 'centroid', t: [2000, 3500, 15000, 16001], w: 2 },
    { m: 'high', t: [0.05, 0.2, 1.01, 1.02], w: 1.5 },
    { m: 'noise', t: [0.25, 0.45, 1.01, 1.02], w: 1 },
    { m: 'low', t: [-1, 0, 0.08, 0.3], w: 1 },
  ],
  perc: [
    { m: 'lengthMs', t: [15, 40, 500, 1500], w: 2 },
    { m: 'centroid', t: [250, 500, 9000, 14000], w: 2 },
  ],
  fx: [
    { m: 'lengthMs', t: [10, 30, 1500, 3500], w: 1 },
    { m: 'centroid', t: [100, 200, 12000, 16000], w: 1 },
  ],
};

/** Where an instrument usually sits: centroid in Hz and length in ms (for the interest term). */
const TYPICAL: Record<Instrument, { centroid: number; length: number }> = {
  kick: { centroid: 140, length: 450 },
  ltom: { centroid: 300, length: 450 },
  htom: { centroid: 600, length: 350 },
  snare: { centroid: 3000, length: 220 },
  clap: { centroid: 2800, length: 220 },
  chat: { centroid: 8000, length: 60 },
  ohat: { centroid: 7500, length: 450 },
  cymbal: { centroid: 6500, length: 1400 },
  perc: { centroid: 2000, length: 200 },
  fx: { centroid: 3000, length: 400 },
};

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

function trap(v: number, [a, b, c, d]: Trap, slack: number): number {
  const lo = b - (b - a) * (1 + slack);
  const hi = c + (d - c) * (1 + slack);
  if (v >= b && v <= c) return 1;
  if (v < b) return v <= lo ? 0 : (v - lo) / (b - lo);
  return v >= hi ? 0 : (hi - v) / (hi - c);
}

export interface Safety {
  /** 0 (unusable) to 1 */
  factor: number;
  flags: string[];
}

/**
 * Whether a hit is something a player can be handed at any WILDNESS: audible, finite, not an
 * offset, not a drone. `maxSeconds` is how long the sound was rendered for (a tail that is
 * still hot at the end of a short render is a drone).
 */
export function safety(m: VoiceMetrics, instr: Instrument = 'perc'): Safety {
  const flags: string[] = [];
  if (!Number.isFinite(m.peak)) return { factor: 0, flags: ['not-finite'] };
  if (m.silent) return { factor: 0, flags: ['silent'] };
  if (m.lengthMs < 8) return { factor: 0, flags: ['vanishes'] };
  let f = 1;
  if (m.dc > 0.25) {
    flags.push('dc-offset');
    f *= 0.2;
  }
  if (m.tailHot > 0.3 && instr !== 'cymbal') {
    flags.push('drone');
    f *= 0.25;
  }
  if (m.lengthMs < 14) {
    flags.push('click-only');
    f *= 0.4;
  }
  if (m.peak > 12) {
    flags.push('runaway-level');
    f *= 0.3;
  }
  return { factor: f, flags };
}

/** How well a hit fits the instrument's convention, 0-1 (1: every tendency met). */
export function convention(instr: Instrument, m: VoiceMetrics, wildness = 0): number {
  const slack = 2 * clamp01(wildness);
  let s = 0;
  let w = 0;
  for (const c of PROFILES[instr]) {
    s += c.w * trap(m[c.m], c.t, slack);
    w += c.w;
  }
  return w ? s / w : 1;
}

/** How unusual and lively a hit is, 0-1: far from the instrument's usual place, moving, mixed noise and tone. */
export function interest(instr: Instrument, m: VoiceMetrics): number {
  const t = TYPICAL[instr];
  const spectral = m.centroid > 0 ? clamp01(Math.abs(Math.log2(m.centroid / t.centroid)) / 3) : 0;
  const decay = m.lengthMs > 0 ? clamp01(Math.abs(Math.log2(m.lengthMs / t.length)) / 2.5) : 0;
  const motion = clamp01(Math.abs(m.sweepOct) / 2);
  const mixed = 4 * m.noise * (1 - m.noise);
  return (spectral + decay + motion + mixed) / 4;
}

export interface Judgement {
  /** what selection maximises */
  score: number;
  convention: number;
  interest: number;
  safety: Safety;
}

/**
 * The selection score of a hit meant as `instr`. At WILDNESS 0 only convention counts; as it
 * rises the weight moves to interest (never past 0.7), and the convention's own tolerance grows.
 * Safety multiplies everything and does not relax.
 */
export function judge(instr: Instrument, m: VoiceMetrics, wildness = 0.5): Judgement {
  const w = clamp01(wildness);
  const sf = safety(m, instr);
  const conv = convention(instr, m, w);
  const intr = interest(instr, m);
  const iw = 0.7 * w * w;
  return { score: sf.factor * ((1 - iw) * conv + iw * intr), convention: conv, interest: intr, safety: sf };
}

/** Does a hit look like its instrument at the strict (WILDNESS 0) reading? Used by the evaluator and the tests. */
export const looksLike = (instr: Instrument, m: VoiceMetrics, threshold = 0.6): boolean => safety(m, instr).factor > 0 && convention(instr, m, 0) >= threshold;

// ---------------------------------------------------------------------------- kit-level contrast
export interface KitItem {
  instr: Instrument;
  m: VoiceMetrics;
}

const octaves = (a: number, b: number): number => (a > 0 && b > 0 ? Math.abs(Math.log2(a / b)) : 0);

/**
 * How alike two voices of a kit are, 0 (clearly different) to 1 (the same sound twice). Only
 * the pairs that are easy to confuse are judged: the two toms, the hats and the cymbal, a clap
 * and a snare, everything against the kick.
 */
export function similarity(a: KitItem, b: KitItem): number {
  const key = [a.instr, b.instr].sort().join('+');
  const spectral = octaves(a.m.centroid, b.m.centroid);
  const decay = octaves(a.m.lengthMs, b.m.lengthMs);
  const pitch = octaves(a.m.zcLateHz || a.m.centroid, b.m.zcLateHz || b.m.centroid);
  const near = (d: number, within: number) => clamp01(1 - d / within);
  switch (key) {
    case 'htom+ltom':
      return Math.min(near(pitch, 0.5), near(spectral, 0.6)) * 0.6 + near(decay, 0.5) * 0.4 * Math.min(near(pitch, 0.5), near(spectral, 0.6));
    case 'chat+ohat':
      return near(decay, 1.2) * 0.7 + near(spectral, 0.6) * 0.3;
    case 'cymbal+ohat':
    case 'chat+cymbal':
      return near(decay, 1) * 0.5 + near(spectral, 0.7) * 0.5;
    case 'clap+snare':
      return near(spectral, 0.5) * 0.6 + near(decay, 0.6) * 0.4;
    case 'kick+ltom':
      return near(spectral, 0.7) * 0.6 + near(decay, 0.7) * 0.4;
    default:
      return 0.5 * near(spectral, 0.8) * near(decay, 0.8);
  }
}

/** Sum of the similarities of every pair of items, lower is a more varied kit. */
export function kitSameness(items: KitItem[]): number {
  let s = 0;
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) s += similarity(items[i]!, items[j]!);
  return s;
}

export interface KitSpread {
  /** standard deviation of log2 of the decay lengths (octaves) */
  decaySpread: number;
  /** range of log2 of the spectral centroids (octaves) */
  centroidRange: number;
  /** highest peak over lowest, in dB, of the leveled voices */
  levelRangeDb: number;
  /** loudest peak of the kit */
  maxPeak: number;
  /** standard deviation of the high-frequency share: how differently aggressive the voices are */
  brightSpread: number;
}

export function kitSpread(items: KitItem[]): KitSpread {
  const ok = items.filter((i) => i.m.lengthMs > 0 && i.m.centroid > 0);
  if (!ok.length) return { decaySpread: 0, centroidRange: 0, levelRangeDb: 0, maxPeak: 0, brightSpread: 0 };
  const sd = (xs: number[]) => {
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    return Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
  };
  const cs = ok.map((i) => Math.log2(i.m.centroid));
  const peaks = ok.map((i) => i.m.peak).filter((p) => p > 0);
  return {
    decaySpread: sd(ok.map((i) => Math.log2(i.m.lengthMs))),
    centroidRange: Math.max(...cs) - Math.min(...cs),
    levelRangeDb: peaks.length ? 20 * Math.log10(Math.max(...peaks) / Math.min(...peaks)) : 0,
    maxPeak: peaks.length ? Math.max(...peaks) : 0,
    brightSpread: sd(ok.map((i) => i.m.high)),
  };
}
