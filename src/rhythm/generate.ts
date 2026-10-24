/**
 * GENERATE: new rhythmic material from a style, a seed and five controls.
 *
 * Deterministic: generate(tracks, settings, seed, geometry) always returns the same grids, and
 * every decision is a keyed hash of (seed, purpose, track, bar, step), so changing one track's
 * lock or one setting never reshuffles the rest. Locked tracks are never touched.
 *
 *   DENSITY     scales every lane's chances (strong positions stay; weak ones come and go)
 *   COMPLEXITY  moves weight off the beat: syncopations and pickups appear where a lane is silent
 *   VARIATION   how far later bars stray from the first (the motif)
 *   ACCENT      the contrast between strong and weak hits
 *   FILLS       the chance of a fill into the phrase end (snare, toms, percussion)
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import { clamp, type GenSettings, type Grid, type Hit, type Resolution, type Role } from '../model/types';
import { euclid } from './euclid';
import { rand, SALT, strCode } from './rng';
import { digitChance, styleById, type Lane, type Style } from './styles';

export interface GenTrack {
  id: string;
  role: Role;
  lock: boolean;
}

export interface Geometry {
  steps: number;
  res: Resolution;
}

/** Steps in one 4/4 bar at a resolution. */
export const stepsPerBar = (res: Resolution): number => res * 4;

/** Metric weight of a step: 1 bar downbeat, 0.8 beat, 0.5 half beat, 0.25 other (DOWNBEAT's). */
export function metricWeight(i: number, res: Resolution): number {
  const bar = stepsPerBar(res);
  if (i % bar === 0) return 1;
  if (i % res === 0) return 0.8;
  if (res % 2 === 0 && i % (res / 2) === 0) return 0.5;
  return 0.25;
}

/** The lane's chance and strength (digit 0-9) at a step of a bar, at any resolution. */
function laneAt(lane: Lane, step: number, res: Resolution): number {
  const p = lane.p ?? '';
  if (!p) return 0;
  const pos = (step * 16) / stepsPerBar(res);
  const i = Math.floor(pos + 1e-9);
  const onGrid = Math.abs(pos - i) < 1e-6;
  const c = digitChance(p[i % 16] ?? '.');
  return onGrid ? c : c * 0.25;
}

/** Density as an exponent on the chance: 0.5 neutral. */
function applyDensity(p: number, density: number): number {
  if (p >= 1) return density < 0.08 ? 0.6 : 1;
  if (p <= 0) return 0;
  const k = Math.pow(2, (0.5 - clamp(density, 0, 1)) * 3.2);
  return 1 - Math.pow(1 - p, 1 / k);
}

/** Velocity for a chance digit (strong digits are loud), shaped by ACCENT. */
function velocityFor(strength: number, accent: number, u: number): number {
  const base = 52 + strength * 62; // 0..1 → 52..114
  const spread = 0.4 + accent * 1.1;
  const v = 88 + (base - 88) * spread + (u * 2 - 1) * 7;
  return Math.round(clamp(v, 18, 127));
}

/** One bar of a lane: hits at each step of the bar. */
function laneBar(style: Style, lane: Lane, role: Role, tc: number, s: GenSettings, seed: number, bar: number, keyBar: number, res: Resolution, euclidRow: boolean[] | null, barOffset: number): (Hit | null)[] {
  const n = stepsPerBar(res);
  const out: (Hit | null)[] = new Array(n).fill(null);
  // average activity, for complexity pickups
  let activity = 0;
  if (lane.p) for (let i = 0; i < 16; i++) activity += digitChance(lane.p[i]!);
  activity /= 16;
  for (let i = 0; i < n; i++) {
    let chance: number;
    let strength: number;
    if (euclidRow) {
      const on = euclidRow[(barOffset + i) % euclidRow.length]!;
      chance = on ? 0.97 : 0;
      strength = on ? (metricWeight(i, res) >= 0.8 ? 0.85 : 0.6) : 0;
      if (!on && s.complexity > 0.4 && metricWeight(i, res) <= 0.25) chance = (s.complexity - 0.4) * 0.12;
    } else {
      const c = laneAt(lane, i, res);
      chance = c;
      strength = c;
      // COMPLEXITY: syncopated pickups where the lane is silent, mostly before strong beats
      if (c === 0 && activity > 0) {
        const w = metricWeight(i, res);
        const beforeStrong = metricWeight((i + 1) % n, res) >= 0.8 ? 1.6 : 1;
        chance = s.complexity * 0.22 * (1 - w) * beforeStrong * Math.min(1, activity * 3);
        strength = 0.3;
      } else if (c > 0 && c < 1) {
        // complexity also loosens the weaker written positions
        chance = c * (1 - s.complexity * 0.25 * metricWeight(i, res)) + s.complexity * 0.08;
      }
      // ghost notes
      if (lane.ghost && chance === 0 && metricWeight(i, res) <= 0.25) {
        chance = lane.ghost * (0.4 + s.complexity * 0.6);
        strength = 0.05;
      }
    }
    chance = applyDensity(chance, s.density);
    if (rand(seed, SALT.gen, tc, keyBar, i) < chance) {
      const vel = velocityFor(strength, s.accent, rand(seed, SALT.genVel, tc, bar, i));
      out[i] = { vel };
    }
  }
  void style;
  void role;
  return out;
}

/** A fill into the end of the last bar for fill roles. */
function fillBar(row: (Hit | null)[], role: Role, tc: number, s: GenSettings, seed: number, bar: number, res: Resolution): void {
  const n = row.length;
  const beat = res;
  const lenBeats = rand(seed, SALT.genFill, tc, bar, 99) < 0.35 + s.fills * 0.3 ? 2 : 1;
  const from = n - beat * lenBeats;
  const tom = role === 'ltom' || role === 'htom';
  for (let i = from; i < n; i++) {
    const k = (i - from) / (n - from);
    let chance = 0.35 + s.fills * 0.5;
    if (tom) chance *= role === 'htom' ? 1 - k * 0.6 : 0.4 + k * 0.6; // high toms first, low toms last
    if (rand(seed, SALT.genFill, tc, bar, i) < chance) {
      row[i] = { vel: Math.round(clamp(60 + k * 55 + (rand(seed, SALT.genVel, tc, bar, i, 7) - 0.5) * 16, 30, 127)) };
    }
  }
}

/** Generate grids for every unlocked track. Locked tracks keep `previous`. */
export function generate(tracks: readonly GenTrack[], s: GenSettings, seed: number, geo: Geometry, previous: Record<string, Grid> = {}, onlyFromBar = 0): Record<string, Grid> {
  const style = styleById(s.style);
  const res = geo.res;
  const perBar = stepsPerBar(res);
  const bars = Math.max(1, Math.ceil(geo.steps / perBar));
  const out: Record<string, Grid> = {};
  for (const t of tracks) {
    const prev = previous[t.id];
    if (t.lock && prev) {
      out[t.id] = resize(prev, geo.steps);
      continue;
    }
    const lane = style.lanes[t.role];
    const tc = strCode(t.id) ^ strCode(t.role);
    const grid: Grid = new Array(geo.steps).fill(null);
    if (lane) {
      let euclidRow: boolean[] | null = null;
      if (lane.euclid) {
        const len = Math.round(lane.euclid.len[0] + rand(seed, SALT.gen, tc, 777) * (lane.euclid.len[1] - lane.euclid.len[0]));
        const hits0 = lane.euclid.hits[0] + rand(seed, SALT.gen, tc, 778) * (lane.euclid.hits[1] - lane.euclid.hits[0] + 1);
        const hits = clamp(Math.floor(hits0 * (0.6 + s.density * 0.8)), 1, len);
        const rot = Math.floor(rand(seed, SALT.gen, tc, 779) * len);
        // lengths are in sixteenths: scale to the resolution
        const scaled = Math.max(1, Math.round((len * res) / 4));
        euclidRow = euclid(scaled, hits, (rot * res) / 4);
      }
      const motif = laneBar(style, lane, t.role, tc, s, seed, 0, 0, res, euclidRow, 0);
      for (let b = 0; b < bars; b++) {
        let row: (Hit | null)[];
        if (b === 0 || euclidRow) {
          row = euclidRow ? laneBar(style, lane, t.role, tc, s, seed, b, 0, res, euclidRow, b * perBar) : motif.map((h) => (h ? { ...h } : null));
        } else {
          // later bars: the motif, with VARIATION re-drawing some steps
          const fresh = laneBar(style, lane, t.role, tc, s, seed, b, b, res, null, 0);
          row = motif.map((h, i) => {
            const vary = rand(seed, SALT.genVar, tc, b, i) < s.variation * 0.55 * (1.2 - metricWeight(i, res));
            const pick = vary ? fresh[i] : h;
            return pick ? { ...pick, vel: vary ? pick.vel : clamp(pick.vel + Math.round((rand(seed, SALT.genVel, tc, b, i, 3) - 0.5) * 10), 1, 127) } : null;
          });
        }
        // FILLS into the phrase end
        if (b === bars - 1 && style.fillRoles.includes(t.role) && rand(seed, SALT.genFill, tc, b) < s.fills) fillBar(row, t.role, tc, s, seed, b, res);
        for (let i = 0; i < perBar; i++) {
          const g = b * perBar + i;
          if (g < geo.steps) grid[g] = row[i] ?? null;
        }
      }
    }
    if (onlyFromBar > 0 && prev) {
      const keep = Math.min(geo.steps, onlyFromBar * perBar);
      for (let i = 0; i < keep; i++) grid[i] = prev[i] ? { ...prev[i]! } : null;
    }
    out[t.id] = grid;
  }
  arrange(tracks, out, style, res);
  // a crash (or cymbal) on the downbeat after a fill
  return out;
}

/** Cross-track rules: open hats choke closed hats on the same step; kick clears the backbeat. */
function arrange(tracks: readonly GenTrack[], grids: Record<string, Grid>, style: Style, res: Resolution): void {
  const of = (role: Role) => tracks.filter((t) => t.role === role && !t.lock).map((t) => grids[t.id]!).filter(Boolean);
  const open = tracks.filter((t) => t.role === 'ohat').map((t) => grids[t.id]!);
  for (const ch of of('chat')) for (const op of open) for (let i = 0; i < ch.length; i++) if (op?.[i] && ch[i]) ch[i] = null;
  if (style.separateKickSnare) {
    const snares = tracks.filter((t) => t.role === 'snare').map((t) => grids[t.id]!);
    for (const k of of('kick'))
      for (const sn of snares)
        for (let i = 0; i < k.length; i++) {
          const beat = i % (res * 4);
          if (sn?.[i] && k[i] && (beat === res || beat === res * 3) && sn[i]!.vel > 90) k[i] = null;
        }
  }
}

/** A grid at a new length (repeats when longer). */
export function resize(g: Grid, steps: number): Grid {
  const out: Grid = new Array(steps).fill(null);
  if (!g.length) return out;
  for (let i = 0; i < steps; i++) {
    const h = g[i % g.length];
    out[i] = h ? { ...h } : null;
  }
  return out;
}

export const defaultGen = (): GenSettings => ({ style: 'machine', density: 0.5, complexity: 0.3, variation: 0.3, accent: 0.5, fills: 0.4, bars: 2 });
