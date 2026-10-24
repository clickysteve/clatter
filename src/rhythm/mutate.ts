/**
 * MUTATE and VARIATION: a short list of musical edits applied to a copy of the grids.
 *
 * Adapted from DOWNBEAT's EXTENDED pattern mutation (src/extended/mutate.ts,
 * https://github.com/clickysteve/downbeat), Copyright (c) 2026 The DOWNBEAT contributors, MIT
 * licence (see THIRD_PARTY_NOTICES.md). CLATTER's changes: velocities instead of striker
 * levels, per-hit probability edits, locked tracks, a resolution-aware metric weight.
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 *
 * Strength (0-1) sets how many edits there are and which kinds are allowed: at low strength
 * only small, local edits on weak metric positions (the groove stays recognisable); at high
 * strength rotation, reversal, rests and recombined fragments can reshape the pattern.
 */
import type { Grid, Hit, Resolution } from '../model/types';
import { metricWeight } from './generate';
import type { Rng } from './rng';

export type MutationOp = 'add' | 'remove' | 'shift' | 'swap' | 'accent' | 'velocity' | 'rest' | 'recombine' | 'rotate' | 'reverse' | 'density' | 'chance';

export const OP_LABEL: Record<MutationOp, string> = {
  add: '+HIT',
  remove: '-HIT',
  shift: 'SHIFT',
  swap: 'SWAP',
  accent: 'ACCENT',
  velocity: 'VEL',
  rest: 'REST',
  recombine: 'RECOMBINE',
  rotate: 'ROTATE',
  reverse: 'REVERSE',
  density: 'DENSITY',
  chance: 'CHANCE',
};

const OPS: { op: MutationOp; weight: number; minStrength: number }[] = [
  { op: 'add', weight: 24, minStrength: 0 },
  { op: 'remove', weight: 20, minStrength: 0 },
  { op: 'shift', weight: 16, minStrength: 0 },
  { op: 'velocity', weight: 12, minStrength: 0 },
  { op: 'accent', weight: 8, minStrength: 0 },
  { op: 'chance', weight: 5, minStrength: 0.1 },
  { op: 'swap', weight: 8, minStrength: 0.15 },
  { op: 'density', weight: 5, minStrength: 0.3 },
  { op: 'rest', weight: 4, minStrength: 0.35 },
  { op: 'recombine', weight: 5, minStrength: 0.4 },
  { op: 'rotate', weight: 3, minStrength: 0.6 },
  { op: 'reverse', weight: 2, minStrength: 0.6 },
];

const cloneHit = (h: Hit | null | undefined): Hit | null => (h ? { ...h } : null);

export interface MutationResult {
  grids: Record<string, Grid>;
  ops: MutationOp[];
}

/**
 * Mutate. `targets` lists the tracks that may change (others are copied unchanged);
 * `lengths` each track's loop length (edits stay inside it).
 */
export function mutate(source: Record<string, Grid>, targets: readonly string[], res: Resolution, rng: Rng, strength: number, lengths: Record<string, number> = {}): MutationResult {
  const s = Math.max(0, Math.min(1, strength));
  const grids: Record<string, Grid> = {};
  for (const [id, g] of Object.entries(source)) grids[id] = g.map(cloneHit);
  const ids = targets.filter((id) => grids[id] && grids[id]!.length);
  const ops: MutationOp[] = [];
  if (!ids.length || s <= 0) return { grids, ops };
  let hits = 0;
  for (const id of ids) hits += grids[id]!.filter(Boolean).length;
  const n = Math.max(1, Math.round(Math.pow(s, 1.4) * (hits * 0.5 + 3)));
  const allowed = OPS.filter((o) => s >= o.minStrength);
  const total = allowed.reduce((a, o) => a + o.weight, 0);
  const grid = Math.max(1, res);

  /** A position, preferring weak metric positions at low strength. */
  const pickPos = (len: number, pred: (i: number) => boolean): number => {
    const cand: number[] = [];
    const w: number[] = [];
    for (let i = 0; i < len; i++) {
      if (!pred(i)) continue;
      cand.push(i);
      w.push(Math.max(0.02, 1 - metricWeight(i, res) * (1 - s)));
    }
    if (!cand.length) return -1;
    let x = rng.next() * w.reduce((a, b) => a + b, 0);
    for (let k = 0; k < cand.length; k++) {
      x -= w[k]!;
      if (x < 0) return cand[k]!;
    }
    return cand[cand.length - 1]!;
  };

  for (let k = 0; k < n; k++) {
    let x = rng.next() * total;
    let def = allowed[0]!;
    for (const o of allowed) {
      x -= o.weight;
      if (x < 0) {
        def = o;
        break;
      }
    }
    const id = rng.pick(ids);
    const t = grids[id]!;
    const len = Math.max(1, Math.min(lengths[id] || t.length, t.length));
    if (apply(def.op, t, len)) ops.push(def.op);
  }
  return { grids, ops };

  function apply(op: MutationOp, t: Grid, len: number): boolean {
    switch (op) {
      case 'add': {
        const i = pickPos(len, (j) => !t[j]);
        if (i < 0) return false;
        t[i] = { vel: 45 + rng.int(45) };
        return true;
      }
      case 'remove': {
        const i = pickPos(len, (j) => !!t[j] && (s > 0.5 || t[j]!.vel < 100 || metricWeight(j, res) < 0.8));
        if (i < 0) return false;
        t[i] = null;
        return true;
      }
      case 'shift': {
        const i = pickPos(len, (j) => !!t[j]);
        if (i < 0) return false;
        const j = (i + (rng.chance(0.5) ? 1 : -1) + len) % len;
        if (t[j]) return false;
        t[j] = t[i]!;
        t[i] = null;
        return true;
      }
      case 'swap': {
        const i = pickPos(len, (j) => !!t[j] || !!t[(j + 1) % len]);
        if (i < 0) return false;
        const j = (i + 1) % len;
        const a = t[i] ?? null;
        t[i] = t[j] ?? null;
        t[j] = a;
        return true;
      }
      case 'velocity': {
        const i = pickPos(len, (j) => !!t[j]);
        if (i < 0) return false;
        const h = t[i]!;
        h.vel = Math.max(1, Math.min(127, h.vel + (rng.chance(0.5) ? 1 : -1) * (12 + rng.int(18))));
        return true;
      }
      case 'accent': {
        const i = pickPos(len, (j) => !!t[j]);
        if (i < 0) return false;
        const h = t[i]!;
        h.vel = h.vel >= 110 ? 80 : 118 + rng.int(9);
        return true;
      }
      case 'chance': {
        const i = pickPos(len, (j) => !!t[j] && metricWeight(j, res) < 1);
        if (i < 0) return false;
        const h = t[i]!;
        h.prob = (h.prob ?? 100) >= 100 ? 40 + rng.int(45) : undefined;
        if (h.prob === undefined) delete h.prob;
        return true;
      }
      case 'density': {
        const add = rng.chance(0.5);
        let done = false;
        for (let c = 0; c < 2; c++) {
          const i = pickPos(len, (j) => (add ? !t[j] : !!t[j]));
          if (i < 0) break;
          t[i] = add ? { vel: 40 + rng.int(30) } : null;
          done = true;
        }
        return done;
      }
      case 'rest': {
        const runLen = 2 + rng.int(3);
        const start = pickPos(len, (j) => metricWeight(j, res) < 1);
        if (start < 0) return false;
        let any = false;
        for (let c = 0; c < runLen && start + c < len; c++) {
          if (t[start + c]) any = true;
          t[start + c] = null;
        }
        return any;
      }
      case 'recombine': {
        const frag = Math.max(1, Math.min(len, grid));
        const slots = Math.floor(len / frag);
        if (slots < 2) return false;
        const a = rng.int(slots);
        let b = rng.int(slots - 1);
        if (b >= a) b++;
        for (let c = 0; c < frag; c++) t[b * frag + c] = cloneHit(t[a * frag + c]);
        return true;
      }
      case 'rotate': {
        const dir = rng.chance(0.5) ? 1 : -1;
        const seg = t.slice(0, len);
        for (let i = 0; i < len; i++) t[(i + dir + len) % len] = seg[i] ?? null;
        return true;
      }
      case 'reverse': {
        const frag = Math.max(2, Math.min(len, grid));
        const slots = Math.floor(len / frag);
        if (slots < 1) return false;
        const a = rng.int(slots) * frag;
        const seg = t.slice(a, a + frag).reverse();
        for (let c = 0; c < frag; c++) t[a + c] = seg[c] ?? null;
        return true;
      }
    }
  }
}

/** Fraction of positions that differ between two sets of grids. */
export function distance(a: Record<string, Grid>, b: Record<string, Grid>): number {
  let diff = 0;
  let total = 0;
  for (const id of Object.keys(a)) {
    const x = a[id]!;
    const y = b[id] ?? [];
    for (let i = 0; i < x.length; i++) {
      const p = x[i];
      const q = y[i];
      if (p || q) total++;
      if (!!p !== !!q || (p && q && Math.abs(p.vel - q.vel) > 20)) diff++;
    }
  }
  return total ? diff / total : 0;
}

/** "+HIT 2 · SHIFT 1" for the status line. */
export function summariseOps(ops: MutationOp[]): string {
  const counts = new Map<MutationOp, number>();
  for (const o of ops) counts.set(o, (counts.get(o) ?? 0) + 1);
  return [...counts].map(([o, c]) => `${OP_LABEL[o]} ${c}`).join(' · ') || 'NO CHANGE';
}

