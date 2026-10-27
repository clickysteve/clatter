/**
 * Realisation: what one cycle of a pattern plays.
 *
 *   SOURCE (baseline + hand edits)
 *     -> EVOLVE      a mutation of the source per generation (rhythm evolution), optional
 *     -> CHOP        slices rearranged                      (destruction layer)
 *     -> ROLLS       retriggers leading into hits           (destruction layer)
 *     -> PERFORMANCE probability, density, flams, ratchets, fills, humanise
 *     -> DESTROY     per-hit stutter, pitch, reverse, gate, crush, skip (destruction layer)
 *     -> SWING
 *
 * A pure function of (input, cycle): every random decision is a keyed hash (DOWNBEAT's
 * determinism: the same project and seed replay the same performance, whatever order the
 * scheduler asks in). Nothing here changes the pattern: switching any layer off gives the
 * source back exactly. The performance stage follows DOWNBEAT's realisation (density by
 * strength, per-step probability, fills into gaps; src/engine/realize.ts, MIT, see
 * THIRD_PARTY_NOTICES.md), reworked for CLATTER's velocity-based hits.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import { chop, type ChopReport } from '../destruction/chop';
import { destroy, type DestroyReport } from '../destruction/destroy';
import { rolls, type RollReport } from '../destruction/rolls';
import { clamp, PPQ, stepTicks, type DestructionSettings, type EvolveSettings, type Grid, type Pattern, type Role, type TrackPlay } from '../model/types';
import { byTime, type PerfEvent } from './events';
import { stepsPerBar } from './generate';
import { mutate } from './mutate';
import { trackGrids } from './pattern';
import { hash32, rand, Rng, SALT, strCode } from './rng';
import { needsPrev, trigRow } from './trigger';

export interface RealizeTrack {
  id: string;
  role: Role;
  lock: boolean;
  play: TrackPlay;
}

export interface RealizeInput {
  seed: number;
  swing: number;
  pattern: Pattern;
  tracks: readonly RealizeTrack[];
  destruction: DestructionSettings;
  evolve: EvolveSettings;
  /**
   * Where this cycle sits for trigger conditions (see src/rhythm/trigger.ts): the pass of its
   * pattern (0 = the first), whether it is the final one of a run whose length is known, and
   * the tracks with a FILL held. Absent: pass = cycle, nothing known, no fills.
   */
  trig?: { pass: number; last: boolean; fills?: ReadonlySet<string> };
}

export const CELL_PLAYED = 1;
export const CELL_SUPPRESSED = 2;
export const CELL_ADDED = 4;
export const CELL_DESTROYED = 8;
export const CELL_MOVED = 16;
export const CELL_EVOLVED = 32;
/** a written hit that its trigger condition kept from playing on this pass */
export const CELL_CONDITION = 64;

export interface Realization {
  cycle: number;
  cycleTicks: number;
  events: PerfEvent[];
  /** per track, per source position: CELL_* flags */
  cells: Record<string, Uint8Array>;
  /** rhythm evolution generation (0 = the source) */
  generation: number;
  reports: { chop: ChopReport; rolls: RollReport; destroy: DestroyReport };
}

/** Density exponents by strength (soft hits drop out first): DOWNBEAT's DENSITY_WEIGHT. */
const DENSITY_WEIGHT = [1.6, 1.3, 1.0, 0.7, 0.4];
const levelOf = (vel: number) => clamp(Math.floor((vel / 128) * 5), 0, 4);
export const FLAM_TICKS = PPQ / 16;

/** Swing as a time warp over pairs of sixteenths (DOWNBEAT's swingWarp, in ticks). */
export function swingTick(tick: number, swing: number): number {
  if (swing <= 50) return tick;
  const s = (clamp(swing, 50, 75) - 50) / 50;
  const sx = PPQ / 4;
  const x = tick / sx;
  const pair = Math.floor(x / 2) * 2;
  const f = x - pair;
  return (pair + (f < 1 ? f * (1 + s) : 1 + s + (f - 1) * (1 - s))) * sx;
}

/** The evolved source for a cycle (rhythm evolution), or the source itself. */
export function evolvedGrids(input: RealizeInput, cycle: number, src: Record<string, Grid>): { grids: Record<string, Grid>; generation: number } {
  const ev = input.evolve;
  if ((ev.target !== 'rhythm' && ev.target !== 'both') || ev.amount <= 0) return { grids: src, generation: 0 };
  const p = input.pattern;
  const bars = Math.max(1, p.steps / stepsPerBar(p.res));
  let gen = Math.floor((cycle * bars) / Math.max(1, ev.every));
  if (ev.returnEvery > 0) gen %= ev.returnEvery + 1;
  if (gen <= 0) return { grids: src, generation: 0 };
  const targets = input.tracks.filter((t) => !t.lock).map((t) => t.id);
  const lengths: Record<string, number> = {};
  for (const t of input.tracks) if (t.play.length > 0) lengths[t.id] = t.play.length;
  const rng = new Rng(hash32(input.seed, SALT.evolve, strCode(p.id), p.seed, gen));
  return { grids: mutate(src, targets, p.res, rng, ev.amount * 0.6, lengths).grids, generation: gen };
}

export function realize(input: RealizeInput, cycle: number): Realization {
  const p = input.pattern;
  const T = stepTicks(p.res);
  const steps = p.steps;
  const cycleTicks = steps * T;
  const perBar = stepsPerBar(p.res);
  const seed = input.seed;
  const ids = input.tracks.map((t) => t.id);
  const roles: Record<string, string> = {};
  for (const t of input.tracks) roles[t.id] = t.role;
  const src = trackGrids(p, ids);
  const { grids, generation } = evolvedGrids(input, cycle, src);
  const cells: Record<string, Uint8Array> = {};

  // 1. events of the (evolved) source; polymeter: a track with its own length runs across cycles
  let events: PerfEvent[] = [];
  const posOf = (t: RealizeTrack, i: number) => (t.play.length > 0 && t.play.length < steps ? (cycle * steps + i) % t.play.length : i);
  const tinfo = input.trig ?? { pass: cycle, last: false };
  for (const t of input.tracks) {
    const g = grids[t.id] ?? [];
    const s = src[t.id] ?? [];
    const row = new Uint8Array(steps);
    cells[t.id] = row;
    // trigger conditions first: which of the written steps play on this pass
    const conds = p.trig?.[t.id];
    let plays: boolean[] | null = null;
    if (conds && Object.keys(conds).length) {
      const base = { seed, pattern: p.id, pass: tinfo.pass, cycle, last: tinfo.last, fill: !!tinfo.fills?.has(t.id), track: t.id };
      let before = false;
      if (tinfo.pass > 0 && cycle > 0 && Object.values(conds).some(needsPrev)) {
        const gp = evolvedGrids(input, cycle - 1, src).grids[t.id] ?? [];
        const pp = (i: number) => (t.play.length > 0 && t.play.length < steps ? ((cycle - 1) * steps + i) % t.play.length : i);
        before = trigRow(steps, (i) => !!gp[pp(i)], (i) => conds[pp(i)], { ...base, pass: tinfo.pass - 1, cycle: cycle - 1, last: false }, false)[steps - 1]!;
      }
      plays = trigRow(steps, (i) => !!g[posOf(t, i)], (i) => conds[posOf(t, i)], base, before);
    }
    for (let i = 0; i < steps; i++) {
      const pos = posOf(t, i);
      const h = g[pos];
      if (!!h !== !!s[pos]) row[pos]! |= CELL_EVOLVED;
      if (!h) continue;
      if (plays && !plays[i]) {
        row[pos]! |= CELL_SUPPRESSED | CELL_CONDITION;
        continue;
      }
      events.push({ key: `${t.id}|${i}`, tick: i * T, track: t.id, vel: h.vel, pitch: h.note ?? 0, kind: 'source', origin: pos, step: i, prob: h.prob, flam: h.flam, ratchet: h.ratchet, sample: h.sample });
    }
  }

  const ctx = { seed: hash32(seed, strCode(p.id)), steps, stepTicks: T, stepsPerBar: perBar, roles };
  const d = input.destruction;
  const reports = {
    chop: { slices: 0, edited: 0, ops: {} } as ChopReport,
    rolls: { rolls: 0, strokes: 0, reason: 'OFF' } as RollReport,
    destroy: { hits: 0, counts: { stutter: 0, pitch: 0, reverse: 0, gate: 0, crush: 0, skip: 0 } } as DestroyReport,
  };

  // 2. CHOP, 3. ROLLS
  const c = chop(events, d.chop, ctx);
  events = c.events;
  reports.chop = c.report;
  const r = rolls(events, d.rolls, ctx);
  events = r.events;
  reports.rolls = r.report;

  // 4. performance
  const performed: PerfEvent[] = [];
  const byId = new Map(input.tracks.map((t) => [t.id, t] as const));
  for (const e of events) {
    const t = byId.get(e.track);
    if (!t) continue;
    const tc = strCode(t.id);
    const x = e.tick / T;
    const row = cells[t.id]!;
    // probability: the hit's own, scaled by the track's CHANCE
    const prob = ((e.prob ?? 100) / 100) * (t.play.chance / 100);
    if (prob < 1 && rand(seed, SALT.prob, tc, cycle, x) >= prob) {
      if (e.kind === 'source') row[e.origin]! |= CELL_SUPPRESSED;
      continue;
    }
    // density: soft hits drop out first
    const dens = t.play.density / 100;
    if (dens < 1 && !(dens > 0 && rand(seed, SALT.density, tc, cycle, x) < Math.pow(dens, DENSITY_WEIGHT[levelOf(e.vel)]!))) {
      if (e.kind === 'source') row[e.origin]! |= CELL_SUPPRESSED;
      continue;
    }
    const hum = t.play.humanize / 100;
    const jitter = hum > 0 ? (rand(seed, SALT.timing, tc, cycle, x) * 2 - 1) * hum * (T / 4) : 0;
    const vel = hum > 0 ? clamp(Math.round(e.vel * (1 + (rand(seed, SALT.velVar, tc, cycle, x) * 2 - 1) * hum * 0.18)), 1, 127) : e.vel;
    const base = { ...e, vel, tick: Math.max(0, e.tick + jitter) };
    if (e.kind === 'source') row[e.origin]! |= CELL_PLAYED;
    else if (e.step >= 0 && e.step < steps) row[posOf(t, e.step)]! |= CELL_ADDED;
    if (e.flam) performed.push({ ...base, key: e.key + '~f', tick: Math.max(0, base.tick - FLAM_TICKS), vel: Math.max(1, Math.round(vel * 0.55)), kind: 'flam', flam: false });
    const rat = clamp(Math.round(e.ratchet ?? 1), 1, 4);
    if (rat > 1) {
      for (let k = 0; k < rat; k++) performed.push({ ...base, key: `${e.key}~x${k}`, tick: base.tick + (k * T) / rat, vel: Math.max(1, Math.round(vel * (1 - k * 0.12))), kind: k ? 'ratchet' : e.kind, ratchet: undefined });
    } else performed.push(base);
  }

  // fills into the gaps of the last bar
  const fromStep = Math.max(0, steps - perBar);
  for (const t of input.tracks) {
    if (t.play.fill <= 0) continue;
    const tc = strCode(t.id);
    const mine = performed.filter((e) => e.track === t.id).map((e) => e.tick / T);
    for (let i = fromStep; i < steps; i++) {
      if (mine.some((m) => Math.abs(m - i) < 0.99)) continue;
      const k = (i - fromStep) / Math.max(1, steps - fromStep);
      if (rand(seed, SALT.fill, tc, cycle, i) >= (t.play.fill / 100) * (0.25 + 0.75 * k)) continue;
      const vel = Math.round(40 + rand(seed, SALT.fillVel, tc, cycle, i) * 45 + k * 25);
      performed.push({ key: `${t.id}|F${i}`, tick: i * T, track: t.id, vel, pitch: 0, kind: 'fill', origin: -1, step: i });
      cells[t.id]![posOf(t, i)]! |= CELL_ADDED;
    }
  }

  // 5. DESTROY
  let final = performed;
  const ds = destroy(performed, d.destroy, { seed: ctx.seed, stepTicks: T });
  final = ds.events;
  reports.destroy = ds.report;
  for (const e of final) {
    if (!e.destroyed || e.step < 0 || e.step >= steps) continue;
    const t = byId.get(e.track);
    if (t) cells[t.id]![posOf(t, e.step)]! |= CELL_DESTROYED;
  }
  // a source hit that no longer plays at its own place (chopped away, skipped)
  for (const t of input.tracks) {
    const row = cells[t.id]!;
    const g = grids[t.id] ?? [];
    for (let i = 0; i < steps; i++) {
      const pos = posOf(t, i);
      if (!g[pos] || row[pos]! & CELL_SUPPRESSED) continue;
      const here = final.some((e) => e.track === t.id && e.step === i);
      if (!here) row[pos]! |= CELL_MOVED;
    }
  }

  // step sounds: each event carries the sound of the source step it plays
  const sounds = p.sounds;
  if (sounds) {
    for (const e of final) {
      if (e.origin >= 0) {
        const ss = sounds[e.track]?.[e.origin];
        if (ss) e.snd = ss;
      }
    }
  }

  // 6. swing (on the sixteenth grid; triplet grids are not swung)
  if (input.swing > 50 && p.res % 2 === 0) for (const e of final) e.tick = swingTick(e.tick, input.swing);
  for (const e of final) e.tick = clamp(e.tick, 0, cycleTicks - 1e-6);
  final.sort(byTime);
  return { cycle, cycleTicks, events: final, cells, generation, reports };
}
