/**
 * Velocity editing as plain functions: what each tool does to a run of velocities (the hits of
 * the selection, in step order). The application applies one of these to every track of the
 * selection as ONE undo step.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import { Rng } from './rng';

export const VEL_MIN = 1;
export const VEL_MAX = 127;

export const clampVel = (v: number): number => Math.max(VEL_MIN, Math.min(VEL_MAX, Math.round(v)));

export type VelOp =
  | { k: 'set'; v: number }
  /** add (or subtract) an amount */
  | { k: 'nudge'; d: number }
  /** multiply */
  | { k: 'scale'; f: number }
  /** a straight line from the first hit to the last */
  | { k: 'ramp'; from: number; to: number }
  /** a random velocity in a range, from a seed */
  | { k: 'random'; lo: number; hi: number; seed: number };

export const VEL_LABEL: Record<VelOp['k'], string> = { set: 'SET VELOCITY', nudge: 'NUDGE VELOCITY', scale: 'SCALE VELOCITY', ramp: 'VELOCITY RAMP', random: 'RANDOM VELOCITY' };

/** The new velocities for a run of `vels` (first to last in time). Always within 1-127. */
export function applyVelOp(vels: readonly number[], op: VelOp): number[] {
  const n = vels.length;
  switch (op.k) {
    case 'set':
      return vels.map(() => clampVel(op.v));
    case 'nudge':
      return vels.map((v) => clampVel(v + op.d));
    case 'scale':
      return vels.map((v) => clampVel(v * op.f));
    case 'ramp':
      return vels.map((_, i) => clampVel(n <= 1 ? op.from : op.from + ((op.to - op.from) * i) / (n - 1)));
    case 'random': {
      const lo = Math.min(op.lo, op.hi);
      const hi = Math.max(op.lo, op.hi);
      const rng = new Rng(op.seed);
      return vels.map(() => clampVel(lo + rng.next() * (hi - lo)));
    }
  }
}

/** The velocity of a vertical drag: up is louder, one pixel is `gain` steps of velocity. */
export function dragVelocity(start: number, dy: number, gain = 1): number {
  return clampVel(start - dy * gain);
}
