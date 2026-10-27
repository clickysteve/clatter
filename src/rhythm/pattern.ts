/**
 * Pattern operations. A pattern is one grid of hits per track (`grids`): the single authoritative
 * pattern. GENERATE, VARIATION, MUTATE, the transformations and every hand edit write it directly,
 * so a note is just a note whatever made it. CHOP, ROLLS and DESTROY work on it at playback time
 * and never change it.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import { MAX_STEPS, clone, type GenSettings, type Grid, type Hit, type Pattern, type Resolution, type StepSound, type TrigCond } from '../model/types';
import { isEmptyStepSound } from '../sound/stepSound';
import { resize, stepsPerBar } from './generate';

/** A copy of a track's grid, exactly `p.steps` long. */
export function trackGrid(p: Pattern, trackId: string): Grid {
  const base = p.grids[trackId] ?? [];
  const out: Grid = new Array(p.steps).fill(null);
  for (let i = 0; i < p.steps; i++) out[i] = base[i] ? { ...base[i]! } : null;
  return out;
}

export function trackGrids(p: Pattern, trackIds: readonly string[]): Record<string, Grid> {
  const out: Record<string, Grid> = {};
  for (const id of trackIds) out[id] = trackGrid(p, id);
  return out;
}

/** Set a cell (null deletes). */
export function setHit(p: Pattern, trackId: string, step: number, hit: Hit | null): void {
  if (step < 0 || step >= p.steps) return;
  const g = (p.grids[trackId] ??= new Array(p.steps).fill(null));
  g[step] = hit ? { ...hit } : null;
}

/** Delete a note: its hit, and the step sound and trigger condition that belonged to it. */
export function removeNote(p: Pattern, trackId: string, step: number): void {
  setHit(p, trackId, step, null);
  setStepSound(p, trackId, step, undefined);
  setStepTrig(p, trackId, step, undefined);
}

export function sameHit(a: Hit | null | undefined, b: Hit | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.vel === b.vel && (a.prob ?? 100) === (b.prob ?? 100) && (a.note ?? 0) === (b.note ?? 0) && !!a.flam === !!b.flam && (a.ratchet ?? 1) === (b.ratchet ?? 1) && a.sample === b.sample;
}

/** Change the length in steps (the pattern repeats when it grows). */
export function setLength(p: Pattern, steps: number): void {
  const n = Math.max(1, Math.min(MAX_STEPS, Math.round(steps)));
  for (const id of Object.keys(p.grids)) p.grids[id] = resize(p.grids[id]!, n);
  // step sounds follow their steps; a longer pattern repeats them as it repeats the notes
  if (p.sounds) {
    const old = p.steps;
    for (const id of Object.keys(p.sounds)) {
      const src = p.sounds[id]!;
      const out: Record<number, StepSound> = {};
      for (let i = 0; i < n; i++) {
        const ss = src[i % old];
        if (ss && (i < old || !isEmptyStepSound(ss))) out[i] = clone(ss);
      }
      setSounds(p, id, out);
    }
  }
  // conditions repeat with the notes too
  if (p.trig) {
    const old = p.steps;
    for (const id of Object.keys(p.trig)) {
      const src = p.trig[id]!;
      const out: Record<number, TrigCond> = {};
      for (let i = 0; i < n; i++) {
        const c = src[i % old];
        if (c) out[i] = { ...c };
      }
      setTrigs(p, id, out);
    }
  }
  p.steps = n;
}

/** Change the resolution, keeping hits at the same musical time where the grid allows. */
export function setResolution(p: Pattern, res: Resolution, trackIds: readonly string[]): void {
  if (p.res === res) return;
  const ratio = res / p.res;
  const steps = Math.max(1, Math.min(MAX_STEPS, Math.round(p.steps * ratio)));
  const src = trackGrids(p, trackIds);
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
  if (p.sounds) {
    for (const id of Object.keys(p.sounds)) {
      const out: Record<number, StepSound> = {};
      for (const [k, ss] of Object.entries(p.sounds[id]!)) {
        const j = Math.round(Number(k) * ratio);
        if (j < steps && Math.abs(Number(k) * ratio - j) < 1e-6) out[j] = ss;
      }
      setSounds(p, id, out);
    }
  }
  if (p.trig) {
    for (const id of Object.keys(p.trig)) {
      const out: Record<number, TrigCond> = {};
      for (const [k, c] of Object.entries(p.trig[id]!)) {
        const j = Math.round(Number(k) * ratio);
        if (j < steps && Math.abs(Number(k) * ratio - j) < 1e-6) out[j] = c;
      }
      setTrigs(p, id, out);
    }
  }
  p.grids = gen;
  p.res = res;
  p.steps = steps;
}

// ---------------------------------------------------------------------------- trigger conditions
/** The trigger condition of a step (undefined: ALWAYS). */
export function trigAt(p: Pattern, trackId: string, step: number): TrigCond | undefined {
  return p.trig?.[trackId]?.[step];
}

/** Replace a track's conditions (an empty set removes the entry). */
export function setTrigs(p: Pattern, trackId: string, trigs: Record<number, TrigCond>): void {
  const keep = Object.entries(trigs).filter(([, c]) => c.k !== 'always');
  if (!keep.length) {
    if (p.trig) {
      delete p.trig[trackId];
      if (!Object.keys(p.trig).length) delete p.trig;
    }
    return;
  }
  (p.trig ??= {})[trackId] = Object.fromEntries(keep);
}

/** Set (or, when ALWAYS or undefined, clear) the condition of one step. */
export function setStepTrig(p: Pattern, trackId: string, step: number, c: TrigCond | undefined): void {
  if (step < 0 || step >= p.steps) return;
  const cur = { ...(p.trig?.[trackId] ?? {}) };
  if (!c || c.k === 'always') delete cur[step];
  else cur[step] = c;
  setTrigs(p, trackId, cur);
}

/** Number of steps with a condition (for one track, or all). */
export function trigCount(p: Pattern, trackId?: string): number {
  if (trackId) return Object.keys(p.trig?.[trackId] ?? {}).length;
  return Object.values(p.trig ?? {}).reduce((a, e) => a + Object.keys(e).length, 0);
}

// ---------------------------------------------------------------------------- step sounds
/** The step sound of a cell (undefined when it plays its track's sound). */
export function stepSoundAt(p: Pattern, trackId: string, step: number): StepSound | undefined {
  return p.sounds?.[trackId]?.[step];
}

/** Replace a track's step sounds (an empty set removes the entry). */
export function setSounds(p: Pattern, trackId: string, sounds: Record<number, StepSound>): void {
  const keep = Object.entries(sounds).filter(([, ss]) => !isEmptyStepSound(ss));
  if (!keep.length) {
    if (p.sounds) {
      delete p.sounds[trackId];
      if (!Object.keys(p.sounds).length) delete p.sounds;
    }
    return;
  }
  (p.sounds ??= {})[trackId] = Object.fromEntries(keep);
}

/** Set (or, when empty, clear) the sound of one step. */
export function setStepSound(p: Pattern, trackId: string, step: number, ss: StepSound | undefined): void {
  if (step < 0 || step >= p.steps) return;
  const cur = { ...(p.sounds?.[trackId] ?? {}) };
  if (!ss || isEmptyStepSound(ss)) delete cur[step];
  else cur[step] = ss;
  setSounds(p, trackId, cur);
}

/** Number of steps with a sound override (for one track, or all). */
export function soundCount(p: Pattern, trackId?: string): number {
  if (trackId) return Object.keys(p.sounds?.[trackId] ?? {}).length;
  return Object.values(p.sounds ?? {}).reduce((a, e) => a + Object.keys(e).length, 0);
}

/** Rotate a track by n steps. */
export function shiftTrack(p: Pattern, trackId: string, n: number): void {
  const src = trackGrid(p, trackId);
  const len = src.length;
  for (let i = 0; i < len; i++) setHit(p, trackId, i, src[(((i - n) % len) + len) % len] ?? null);
  const snd = p.sounds?.[trackId];
  if (snd) {
    const out: Record<number, StepSound> = {};
    for (const [k, ss] of Object.entries(snd)) out[(((Number(k) + n) % len) + len) % len] = ss;
    setSounds(p, trackId, out);
  }
  const trg = p.trig?.[trackId];
  if (trg) {
    const out: Record<number, TrigCond> = {};
    for (const [k, c] of Object.entries(trg)) out[(((Number(k) + n) % len) + len) % len] = c;
    setTrigs(p, trackId, out);
  }
}

/** Clear a track's notes. */
export function clearTrack(p: Pattern, trackId: string): void {
  for (let i = 0; i < p.steps; i++) removeNote(p, trackId, i);
}

/** A rectangular region copied from the grid. */
export interface Clip {
  steps: number;
  rows: (Hit | null)[][];
  /** the rows' step sounds (relative step → sound), when any */
  sounds?: Record<number, StepSound>[];
  /** the rows' trigger conditions (relative step → condition), when any */
  trig?: Record<number, TrigCond>[];
}

export function copyRegion(p: Pattern, trackIds: readonly string[], from: number, to: number): Clip {
  const a = Math.max(0, Math.min(from, to));
  const b = Math.min(p.steps - 1, Math.max(from, to));
  const clip: Clip = { steps: b - a + 1, rows: trackIds.map((id) => trackGrid(p, id).slice(a, b + 1)) };
  if (p.sounds && trackIds.some((id) => p.sounds![id])) {
    clip.sounds = trackIds.map((id) => {
      const row: Record<number, StepSound> = {};
      for (let i = a; i <= b; i++) {
        const ss = p.sounds![id]?.[i];
        if (ss) row[i - a] = clone(ss);
      }
      return row;
    });
  }
  if (p.trig && trackIds.some((id) => p.trig![id])) {
    clip.trig = trackIds.map((id) => {
      const row: Record<number, TrigCond> = {};
      for (let i = a; i <= b; i++) {
        const c = p.trig![id]?.[i];
        if (c) row[i - a] = { ...c };
      }
      return row;
    });
  }
  return clip;
}

export function pasteRegion(p: Pattern, trackIds: readonly string[], at: number, clip: Clip): void {
  clip.rows.forEach((row, r) => {
    const id = trackIds[r];
    if (!id) return;
    row.forEach((h, k) => setHit(p, id, at + k, h));
    if (clip.sounds) row.forEach((_, k) => setStepSound(p, id, at + k, clip.sounds![r]?.[k] ? clone(clip.sounds![r]![k]!) : undefined));
    if (clip.trig) row.forEach((_, k) => setStepTrig(p, id, at + k, clip.trig![r]?.[k] ? { ...clip.trig![r]![k]! } : undefined));
  });
}

export function newPattern(id: string, name: string, settings: GenSettings, res: Resolution = 4): Pattern {
  const steps = Math.min(MAX_STEPS, stepsPerBar(res) * Math.max(1, settings.bars));
  return { id, name, steps, res, grids: {}, seed: 1, settings: { ...settings }, generation: 0 };
}
