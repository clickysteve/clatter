/**
 * Deterministic randomness.
 *
 * Adapted from DOWNBEAT (src/engine/rng.ts, https://github.com/clickysteve/downbeat),
 * Copyright (c) 2026 The DOWNBEAT contributors, MIT licence (see THIRD_PARTY_NOTICES.md).
 * Modifications: CLATTER's purposes (SALT), string hashing for seeds, a few helpers.
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 *
 * Performance decisions use a *keyed hash*: the value for (seed, purpose, track, cycle, step)
 * is always the same, whatever order the scheduler asks in and however the lookahead windows
 * fall. Sequential operations (generation, mutation, kit design) use a small seeded generator.
 */

const M1 = 0x85ebca6b;
const M2 = 0xc2b2ae35;

function fmix(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, M1);
  h ^= h >>> 13;
  h = Math.imul(h, M2);
  h ^= h >>> 16;
  return h >>> 0;
}

/** 32-bit hash of a list of numbers (non-integers are scaled first). */
export function hash32(...xs: number[]): number {
  let h = 0x9e3779b9;
  for (const x of xs) {
    const k = Number.isInteger(x) ? x | 0 : Math.round(x * 4096) | 0;
    h = fmix((h ^ k) + 0x6a09e667 + (h << 6) + (h >>> 2));
  }
  return h;
}

/** Uniform [0, 1) from a keyed hash. */
export function rand(...xs: number[]): number {
  return hash32(...xs) / 4294967296;
}

/** Stable numeric code for a string (track ids, pattern ids, style names). */
export function strCode(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Purposes, so that different decisions never share a random value. */
export const SALT = {
  gen: 1,
  genVel: 2,
  genVar: 3,
  genFill: 4,
  density: 5,
  prob: 6,
  chance: 7,
  timing: 8,
  velVar: 9,
  fill: 10,
  fillVel: 11,
  chop: 12,
  rolls: 13,
  destroy: 14,
  evolve: 15,
  kit: 16,
  wildcard: 17,
  regen: 18,
  sndProb: 19,
  sndRange: 20,
  sndGen: 21,
  sndDist: 22,
  sndMut: 23,
  trig: 24,
  wild: 25,
  discover: 26,
  discoverMut: 27,
} as const;

/** Small seeded generator (mulberry32) for sequential operations. */
export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
  range(lo: number, hi: number): number {
    return lo + this.next() * (hi - lo);
  }
  irange(lo: number, hi: number): number {
    return lo + this.int(hi - lo + 1);
  }
  pick<T>(xs: readonly T[]): T {
    return xs[this.int(xs.length)]!;
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  /** Gaussian-ish (sum of three uniforms), mean 0, about ±1. */
  bell(): number {
    return (this.next() + this.next() + this.next() - 1.5) / 1.5;
  }
}

/** Weighted choice: index into weights by u in [0,1). */
export function weighted(weights: readonly number[], u: number): number {
  let total = 0;
  for (const w of weights) total += Math.max(0, w);
  if (total <= 0) return Math.floor(u * weights.length);
  let x = u * total;
  for (let i = 0; i < weights.length; i++) {
    x -= Math.max(0, weights[i]!);
    if (x < 0) return i;
  }
  return weights.length - 1;
}

export function randomSeed(): number {
  try {
    const a = new Uint32Array(1);
    crypto.getRandomValues(a);
    return a[0]! || 1;
  } catch {
    return (Math.random() * 4294967296) >>> 0 || 1;
  }
}
