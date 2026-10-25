/**
 * Conditional triggers: whether a programmed step plays on this pass of its pattern.
 *
 * THE COUNTER. A pass is one run of a pattern from its first step to its last. The counter
 * (`pass`, 0 for the first) counts consecutive passes of the same pattern:
 *   - a pattern repeating (looping, or a chain entry with repeats) counts up;
 *   - switching to a different pattern (queued switch, chain step) starts that pattern at pass 0,
 *     so every conditioned pattern begins at its own first pass;
 *   - starting playback (or an export) starts at pass 0.
 * Returning to a pattern after another one starts it at pass 0 again: counts do not survive a
 * visit elsewhere. (Sound conditions keep their older meaning: passes since the transport
 * started. See docs/CONDITIONS.md.)
 *
 * RANDOMNESS. PROBABILITY is a keyed hash of (project seed, pattern, track, step, cycle), never a
 * clock, so playback and export agree and the same project always plays the same way.
 *
 * "PLAYED". PREV and NOT PREV ask whether the previous step of the same track played: it holds a
 * hit and its own condition passed. At the first step of a pass the previous step is the last
 * step of the pass before (never, on the first pass). That earlier pass is resolved one level
 * deep: its own first step counts the pass before it as not played.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import { clamp, type TrigCond, type TrigKind } from '../model/types';
import { rand, SALT, strCode } from './rng';

export const TRIG_KINDS: TrigKind[] = ['always', 'prob', 'every', 'first', 'last', 'odd', 'even', 'alt', 'fill', 'nofill', 'prev', 'noprev'];
export const TRIG_LABEL: Record<TrigKind, string> = {
  always: 'ALWAYS',
  prob: 'PROBABILITY',
  every: 'EVERY N',
  first: 'FIRST CYCLE',
  last: 'LAST CYCLE',
  odd: 'ODD CYCLES',
  even: 'EVEN CYCLES',
  alt: 'ALTERNATING',
  fill: 'FILL ONLY',
  nofill: 'NOT FILL',
  prev: 'PREVIOUS PLAYED',
  noprev: 'PREVIOUS NOT PLAYED',
};
export const TRIG_HELP: Record<TrigKind, string> = {
  always: 'The step plays every pass.',
  prob: 'The step plays this percentage of the passes. Seeded: the same project always makes the same choices.',
  every: 'The step plays on pass AT of every N passes (EVERY 4 ON 4: the 4th, 8th, 12th pass).',
  first: 'The step plays on the first pass of the pattern only.',
  last: 'The step plays on the final pass. The length must be known (an export, with its bars): while playing live it stays silent.',
  odd: 'The step plays on passes 1, 3, 5 ...',
  even: 'The step plays on passes 2, 4, 6 ...',
  alt: 'The step plays for RUN passes, rests for RUN passes, and repeats (RUN 1 is the same as ODD).',
  fill: 'The step plays only while a FILL is held for its track (PERFORM). It is silent in an export.',
  nofill: 'The step plays unless a FILL is held for its track.',
  prev: 'The step plays if the step before it on this track played.',
  noprev: 'The step plays if the step before it on this track did not play.',
};

export function defaultTrig(k: TrigKind = 'always'): TrigCond {
  switch (k) {
    case 'prob':
      return { k, p: 50 };
    case 'every':
      return { k, n: 4, at: 4 };
    case 'alt':
      return { k, run: 2 };
    default:
      return { k } as TrigCond;
  }
}

export const isDefaultTrig = (c: TrigCond | undefined): boolean => !c || c.k === 'always';

/** The few characters the grid and tooltips use. */
export function describeTrig(c: TrigCond): string {
  switch (c.k) {
    case 'always':
      return 'ALWAYS';
    case 'prob':
      return `${c.p}%`;
    case 'every':
      return `EVERY ${c.n} ON ${c.at}`;
    case 'first':
      return 'FIRST CYCLE';
    case 'last':
      return 'LAST CYCLE';
    case 'odd':
      return 'ODD CYCLES';
    case 'even':
      return 'EVEN CYCLES';
    case 'alt':
      return `ALTERNATING ${c.run}`;
    case 'fill':
      return 'FILL ONLY';
    case 'nofill':
      return 'NOT FILL';
    case 'prev':
      return 'IF PREVIOUS PLAYED';
    case 'noprev':
      return 'IF PREVIOUS DID NOT PLAY';
  }
}

/** A repaired condition from anything (project files, pasted data); null when it is not one. */
export function repairTrig(v: unknown): TrigCond | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const k = o.k as TrigKind;
  if (!TRIG_KINDS.includes(k)) return null;
  const n = (x: unknown, d: number, lo: number, hi: number) => (typeof x === 'number' && Number.isFinite(x) ? Math.round(clamp(x, lo, hi)) : d);
  switch (k) {
    case 'always':
      return null; // the default is not stored
    case 'prob': {
      const p = n(o.p, 50, 0, 100);
      return p >= 100 ? null : { k, p };
    }
    case 'every': {
      const m = n(o.n, 4, 2, 16);
      return { k, n: m, at: n(o.at, m, 1, m) };
    }
    case 'alt':
      return { k, run: n(o.run, 2, 1, 8) };
    default:
      return { k } as TrigCond;
  }
}

export interface TrigContext {
  seed: number;
  /** the pattern's id */
  pattern: string;
  /** passes of this pattern in a row (0 = the first) */
  pass: number;
  /** cycles since the transport started (keys the random draws) */
  cycle: number;
  /** this is the final pass of a run whose length is known (false when it is not known) */
  last: boolean;
  /** a FILL is active for this track */
  fill: boolean;
  track: string;
  /** the source step */
  step: number;
  /** the step before it played (see the file header) */
  prev: boolean;
}

export function trigHolds(c: TrigCond, x: TrigContext): boolean {
  switch (c.k) {
    case 'always':
      return true;
    case 'prob':
      return rand(x.seed, SALT.trig, strCode(x.pattern), strCode(x.track), x.cycle, x.step) < clamp(c.p, 0, 100) / 100;
    case 'every':
      return x.pass % c.n === c.at - 1;
    case 'first':
      return x.pass === 0;
    case 'last':
      return x.last;
    case 'odd':
      return x.pass % 2 === 0; // passes 1, 3, 5 ... counted from one
    case 'even':
      return x.pass % 2 === 1;
    case 'alt':
      return Math.floor(x.pass / Math.max(1, c.run)) % 2 === 0;
    case 'fill':
      return x.fill;
    case 'nofill':
      return !x.fill;
    case 'prev':
      return x.prev;
    case 'noprev':
      return !x.prev;
  }
}

export const needsPrev = (c: TrigCond | undefined): boolean => !!c && (c.k === 'prev' || c.k === 'noprev');

/**
 * Which steps of a track play on a pass, in step order. `hit(i)` says whether step i holds a
 * hit; `cond(i)` is its condition. `before` is whether the last step of the pass before played.
 */
export function trigRow(steps: number, hit: (i: number) => boolean, cond: (i: number) => TrigCond | undefined, base: Omit<TrigContext, 'step' | 'prev'>, before: boolean): boolean[] {
  const out: boolean[] = new Array(steps).fill(false);
  for (let i = 0; i < steps; i++) {
    if (!hit(i)) continue;
    const c = cond(i);
    out[i] = !c || trigHolds(c, { ...base, step: i, prev: i > 0 ? out[i - 1]! : before });
  }
  return out;
}
