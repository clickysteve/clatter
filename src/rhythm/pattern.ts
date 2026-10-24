/**
 * Pattern operations. A pattern's SOURCE for a track is its baseline (`gen`: generated, varied,
 * captured) with the hand edits laid over it (`edits`). Generation, VARIATION and MUTATE change
 * the baseline and never the edits, so a hand edit survives every generative change until the
 * user clears it (RESET, CLEAR EDITS). The transformations (CHOP, ROLLS, DESTROY) work on the
 * source at playback time and never change it.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import { MAX_STEPS, type GenSettings, type Grid, type Hit, type Pattern, type Resolution } from '../model/types';
import { resize, stepsPerBar } from './generate';

export function sourceGrid(p: Pattern, trackId: string): Grid {
  const base = p.gen[trackId] ?? [];
  const edits = p.edits[trackId];
  const out: Grid = new Array(p.steps).fill(null);
  for (let i = 0; i < p.steps; i++) out[i] = base[i] ? { ...base[i]! } : null;
  if (edits) {
    for (const [k, h] of Object.entries(edits)) {
      const i = Number(k);
      if (i >= 0 && i < p.steps) out[i] = h ? { ...h } : null;
    }
  }
  return out;
}

export function sourceGrids(p: Pattern, trackIds: readonly string[]): Record<string, Grid> {
  const out: Record<string, Grid> = {};
  for (const id of trackIds) out[id] = sourceGrid(p, id);
  return out;
}

/** Where a cell's content comes from. */
export type CellOrigin = 'empty' | 'gen' | 'edit' | 'deleted';

export function cellOrigin(p: Pattern, trackId: string, step: number): CellOrigin {
  const e = p.edits[trackId];
  if (e && step in e) return e[step] ? 'edit' : 'deleted';
  return p.gen[trackId]?.[step] ? 'gen' : 'empty';
}

/** Set a cell by hand (null deletes). An edit equal to the baseline is dropped. */
export function setHit(p: Pattern, trackId: string, step: number, hit: Hit | null): void {
  if (step < 0 || step >= p.steps) return;
  const base = p.gen[trackId]?.[step] ?? null;
  const edits = (p.edits[trackId] ??= {});
  if (sameHit(base, hit)) delete edits[step];
  else edits[step] = hit ? { ...hit } : null;
  if (!Object.keys(edits).length) delete p.edits[trackId];
}

export function sameHit(a: Hit | null | undefined, b: Hit | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.vel === b.vel && (a.prob ?? 100) === (b.prob ?? 100) && (a.note ?? 0) === (b.note ?? 0) && !!a.flam === !!b.flam && (a.ratchet ?? 1) === (b.ratchet ?? 1) && a.sample === b.sample;
}

/** Number of hand edits in a pattern (for one track, or all). */
export function editCount(p: Pattern, trackId?: string): number {
  if (trackId) return Object.keys(p.edits[trackId] ?? {}).length;
  return Object.values(p.edits).reduce((a, e) => a + Object.keys(e).length, 0);
}

/** Bake the hand edits into the baseline (CAPTURE / KEEP). */
export function commitEdits(p: Pattern, trackIds: readonly string[]): void {
  for (const id of trackIds) p.gen[id] = sourceGrid(p, id);
  p.edits = {};
}

/** Change the length in steps (the baseline repeats when it grows; edits past the end go). */
export function setLength(p: Pattern, steps: number): void {
  const n = Math.max(1, Math.min(MAX_STEPS, Math.round(steps)));
  for (const id of Object.keys(p.gen)) p.gen[id] = resize(p.gen[id]!, n);
  for (const id of Object.keys(p.edits)) {
    const e = p.edits[id]!;
    for (const k of Object.keys(e)) if (Number(k) >= n) delete e[Number(k)];
  }
  p.steps = n;
}

/** Change the resolution, keeping hits at the same musical time where the grid allows. */
export function setResolution(p: Pattern, res: Resolution, trackIds: readonly string[]): void {
  if (p.res === res) return;
  const ratio = res / p.res;
  const steps = Math.max(1, Math.min(MAX_STEPS, Math.round(p.steps * ratio)));
  const src = sourceGrids(p, trackIds);
  const gen: Record<string, Grid> = {};
  for (const id of trackIds) {
    const g: Grid = new Array(steps).fill(null);
    src[id]!.forEach((h, i) => {
      if (!h) return;
      const j = Math.round(i * ratio);
      if (j < steps && Math.abs(i * ratio - j) < 1e-6 && !g[j]) g[j] = h;
    });
    gen[id] = g;
  }
  p.gen = gen;
  p.edits = {};
  p.res = res;
  p.steps = steps;
}

/** Rotate a track's source by n steps (written into edits over the baseline). */
export function shiftTrack(p: Pattern, trackId: string, n: number): void {
  const src = sourceGrid(p, trackId);
  const len = src.length;
  for (let i = 0; i < len; i++) setHit(p, trackId, i, src[(((i - n) % len) + len) % len] ?? null);
}

/** Clear a track (as edits, so RESET can bring it back). */
export function clearTrack(p: Pattern, trackId: string): void {
  for (let i = 0; i < p.steps; i++) setHit(p, trackId, i, null);
}

/** A rectangular region copied from the grid. */
export interface Clip {
  steps: number;
  rows: (Hit | null)[][];
}

export function copyRegion(p: Pattern, trackIds: readonly string[], from: number, to: number): Clip {
  const a = Math.max(0, Math.min(from, to));
  const b = Math.min(p.steps - 1, Math.max(from, to));
  return { steps: b - a + 1, rows: trackIds.map((id) => sourceGrid(p, id).slice(a, b + 1)) };
}

export function pasteRegion(p: Pattern, trackIds: readonly string[], at: number, clip: Clip): void {
  clip.rows.forEach((row, r) => {
    const id = trackIds[r];
    if (!id) return;
    row.forEach((h, k) => setHit(p, id, at + k, h));
  });
}

export function newPattern(id: string, name: string, settings: GenSettings, res: Resolution = 4): Pattern {
  const steps = Math.min(MAX_STEPS, stepsPerBar(res) * Math.max(1, settings.bars));
  return { id, name, steps, res, gen: {}, edits: {}, seed: 1, settings: { ...settings }, generation: 0 };
}
