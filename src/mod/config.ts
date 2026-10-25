/**
 * Modulation configuration: defaults for each source, validation/repair of anything loaded,
 * and the inheritance between a track's base modulation and a variation's sparse patch.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import { destDef } from './registry';
import { sineTable, clamp } from './shapes';
import {
  CUSTOM_POINTS, DIVISIONS, LFO_WAVES, MAX_ENV_POINTS, MAX_STEPS, RETRIGS, SOURCE_IDS, typeOfSource,
  type EnvDef, type EnvPoint, type LfoDef, type ModPatch, type ModRoute, type Polarity, type SourceDef, type SourceId, type Sources, type StepDef, type TrackMod,
} from './types';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown, d: number, lo: number, hi: number): number => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : d);
const oneOf = <T extends string>(v: unknown, list: readonly T[], d: T): T => (list.includes(v as T) ? (v as T) : d);
const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d);
const divId = (v: unknown, d: string): string => (DIVISIONS.some((x) => x.id === v) ? (v as string) : d);

export const isSource = (id: unknown): id is SourceId => (SOURCE_IDS as readonly unknown[]).includes(id);

// ---------------------------------------------------------------------------- defaults
export function defaultLfo(seed = 1): LfoDef {
  return { type: 'lfo', wave: 'sine', mode: 'sync', hz: 4, div: '1/4', phase: 0, depth: 1, offset: 0, uni: false, retrig: 'hit', width: 0.5, bend: 0, seed };
}
export function defaultEnv(): EnvDef {
  return {
    type: 'env', kind: 'adsr', sync: false, a: 2, h: 0, d: 180, r: 120, s: 0, gate: 0, curve: -0.4, trig: 'hit', retrig: 'restart', v0: 0, loop: null,
    pts: [{ t: 5, v: 1, c: -0.3 }, { t: 120, v: 0.35, c: -0.4 }, { t: 200, v: 0, c: -0.4 }],
  };
}
export function defaultStep(seed = 1): StepDef {
  return { type: 'step', len: 8, vals: [1, -0.5, 0.25, -1, 0.75, 0, -0.25, 0.5, ...new Array(MAX_STEPS - 8).fill(0)], div: '1/16', dir: 'fwd', glide: 0, retrig: 'hit', seed };
}

export function defaultSource(id: SourceId): SourceDef {
  const n = SOURCE_IDS.indexOf(id) + 1;
  switch (typeOfSource(id)) {
    case 'lfo':
      return defaultLfo(n);
    case 'env':
      return defaultEnv();
    case 'step':
      return defaultStep(n);
    case 'rnd':
    case 'smooth':
      return { type: id as 'rnd' | 'smooth', div: '1/8', uni: false, seed: n };
    case 'sh':
      return { type: 'sh', div: '1/8', from: 'noise', uni: false, seed: n };
    case 'trig':
      return { type: 'trig', ms: 160, vel: true };
    default:
      return { type: 'vel' };
  }
}

export function defaultRoute(id: string, src: SourceId, dst: string, amt = 0.3): ModRoute {
  return { id, src, dst, amt, pol: 'bi', on: true, lo: -1, hi: 1, smooth: destDef(dst)?.rate === 'trigger' ? 0 : 4 };
}

/** The next free route id ("r1", "r2"...). */
export function newRouteId(m: TrackMod): string {
  for (let i = 1; ; i++) if (!m.routes.some((r) => r.id === `r${i}`)) return `r${i}`;
}

// ---------------------------------------------------------------------------- repair
function repairEnvPoints(v: unknown, d: EnvPoint[]): EnvPoint[] {
  if (!Array.isArray(v)) return d.map((p) => ({ ...p }));
  const out: EnvPoint[] = [];
  for (const p of v.slice(0, MAX_ENV_POINTS)) {
    if (!isObj(p)) continue;
    out.push({ t: num(p.t, 50, 0, 20000), v: num(p.v, 0, 0, 1), c: num(p.c, 0, -1, 1) });
  }
  return out.length ? out : d.map((p) => ({ ...p }));
}

export function repairSource(id: SourceId, v: unknown): SourceDef | null {
  if (!isObj(v)) return null;
  const type = typeOfSource(id);
  const dflt = defaultSource(id);
  switch (type) {
    case 'lfo': {
      const d = dflt as LfoDef;
      const out: LfoDef = {
        type: 'lfo',
        wave: oneOf(v.wave, LFO_WAVES, d.wave),
        mode: oneOf(v.mode, ['free', 'sync'] as const, d.mode),
        hz: num(v.hz, d.hz, 0.01, 100),
        div: divId(v.div, d.div) as LfoDef['div'],
        phase: num(v.phase, 0, 0, 1),
        depth: num(v.depth, 1, 0, 1),
        offset: num(v.offset, 0, -1, 1),
        uni: bool(v.uni, false),
        retrig: oneOf(v.retrig, RETRIGS, 'hit'),
        width: num(v.width, 0.5, 0.02, 0.98),
        bend: num(v.bend, 0, -1, 1),
        seed: Math.round(num(v.seed, d.seed, 0, 0xffffff)),
      };
      if (Array.isArray(v.table)) {
        const t = v.table.slice(0, CUSTOM_POINTS).map((x) => num(x, 0, -1, 1));
        while (t.length < CUSTOM_POINTS) t.push(0);
        out.table = t;
      } else if (out.wave === 'custom') out.table = sineTable();
      return out;
    }
    case 'env': {
      const d = dflt as EnvDef;
      const pts = repairEnvPoints(v.pts, d.pts);
      let loop: EnvDef['loop'] = null;
      if (isObj(v.loop)) {
        const from = Math.round(num(v.loop.from, 0, 0, pts.length - 1));
        const to = Math.round(num(v.loop.to, pts.length - 1, 0, pts.length - 1));
        if (to >= from) loop = { from, to };
      }
      return {
        type: 'env',
        kind: oneOf(v.kind, ['adsr', 'ahdsr', 'multi'] as const, d.kind),
        sync: bool(v.sync, false),
        a: num(v.a, d.a, 0, 20000),
        h: num(v.h, 0, 0, 20000),
        d: num(v.d, d.d, 0, 20000),
        r: num(v.r, d.r, 0, 20000),
        s: num(v.s, d.s, 0, 1),
        gate: num(v.gate, 0, 0, 20000),
        curve: num(v.curve, d.curve, -1, 1),
        trig: oneOf(v.trig, ['hit', 'accent', 'ghost'] as const, 'hit'),
        retrig: oneOf(v.retrig, ['restart', 'legato', 'ignore'] as const, 'restart'),
        v0: num(v.v0, 0, 0, 1),
        pts,
        loop,
      };
    }
    case 'step': {
      const d = dflt as StepDef;
      const vals = Array.isArray(v.vals) ? v.vals.slice(0, MAX_STEPS).map((x) => num(x, 0, -1, 1)) : d.vals.slice();
      while (vals.length < MAX_STEPS) vals.push(0);
      return {
        type: 'step',
        len: Math.round(num(v.len, d.len, 1, MAX_STEPS)),
        vals,
        div: divId(v.div, d.div) as StepDef['div'],
        dir: oneOf(v.dir, ['fwd', 'rev', 'ping', 'rand'] as const, 'fwd'),
        glide: num(v.glide, 0, 0, 1),
        retrig: oneOf(v.retrig, ['hit', 'free'] as const, 'hit'),
        seed: Math.round(num(v.seed, d.seed, 0, 0xffffff)),
      };
    }
    case 'rnd':
    case 'smooth':
      return { type: type as 'rnd' | 'smooth', div: divId(v.div, '1/8') as StepDef['div'], uni: bool(v.uni, false), seed: Math.round(num(v.seed, 1, 0, 0xffffff)) };
    case 'sh':
      return { type: 'sh', div: divId(v.div, '1/8') as StepDef['div'], from: isSource(v.from) && v.from !== 'sh' ? v.from : 'noise', uni: bool(v.uni, false), seed: Math.round(num(v.seed, 1, 0, 0xffffff)) };
    case 'trig':
      return { type: 'trig', ms: num(v.ms, 160, 5, 5000), vel: bool(v.vel, true) };
    case 'vel':
      return { type: 'vel' };
    default:
      return null;
  }
}

export function repairRoute(v: unknown, i: number): ModRoute | null {
  if (!isObj(v) || !isSource(v.src) || typeof v.dst !== 'string' || !destDef(v.dst)) return null;
  const lo = num(v.lo, -1, -1, 1);
  const hi = num(v.hi, 1, -1, 1);
  return {
    id: typeof v.id === 'string' && v.id ? v.id.slice(0, 12) : `r${i + 1}`,
    src: v.src,
    dst: v.dst,
    amt: num(v.amt, 0.3, -1, 1),
    pol: oneOf(v.pol, ['bi', 'inv', 'uni'] as const, 'bi') as Polarity,
    on: bool(v.on, true),
    lo: Math.min(lo, hi),
    hi: Math.max(lo, hi),
    smooth: num(v.smooth, 4, 0, 2000),
  };
}

export function repairMod(v: unknown): TrackMod | undefined {
  if (!isObj(v)) return undefined;
  const sources: Sources = {};
  if (isObj(v.sources)) {
    for (const id of SOURCE_IDS) {
      const s = repairSource(id, (v.sources as Obj)[id]);
      if (s) (sources as Record<string, SourceDef>)[id] = s;
    }
  }
  const routes: ModRoute[] = [];
  const seen = new Set<string>();
  if (Array.isArray(v.routes)) {
    v.routes.slice(0, 32).forEach((r, i) => {
      const rr = repairRoute(r, i);
      if (!rr) return;
      while (seen.has(rr.id)) rr.id += 'x';
      seen.add(rr.id);
      routes.push(rr);
    });
  }
  return !Object.keys(sources).length && !routes.length ? undefined : { sources, routes };
}

/** A patch from anything (project files); unknown fields are dropped, values clamped by applying it. */
export function repairPatch(v: unknown): ModPatch | undefined {
  if (!isObj(v)) return undefined;
  const out: ModPatch = {};
  if (isObj(v.sources)) {
    const s: NonNullable<ModPatch['sources']> = {};
    for (const id of SOURCE_IDS) {
      const x = (v.sources as Obj)[id];
      if (x === null) s[id] = null;
      else if (isObj(x)) s[id] = JSON.parse(JSON.stringify(x)) as Obj;
    }
    if (Object.keys(s).length) out.sources = s;
  }
  if (isObj(v.routes)) {
    const r: NonNullable<ModPatch['routes']> = {};
    for (const [id, x] of Object.entries(v.routes as Obj).slice(0, 64)) {
      if (x === null) r[id.slice(0, 12)] = null;
      else if (isObj(x)) r[id.slice(0, 12)] = JSON.parse(JSON.stringify(x)) as Obj;
    }
    if (Object.keys(r).length) out.routes = r;
  }
  return out.sources || out.routes ? out : undefined;
}

// ---------------------------------------------------------------------------- inheritance
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** The modulation a variation plays: the base with the patch applied (the base is not changed). */
export function resolveMod(base: TrackMod | undefined, patch: ModPatch | undefined): TrackMod {
  const out: TrackMod = clone(base ?? { sources: {}, routes: [] });
  if (!patch) return out;
  for (const [id, p] of Object.entries(patch.sources ?? {})) {
    if (!isSource(id)) continue;
    if (p === null) {
      delete out.sources[id];
      continue;
    }
    const cur = out.sources[id];
    const merged = repairSource(id, { ...(cur ?? defaultSource(id)), ...p });
    if (merged) (out.sources as Record<string, SourceDef>)[id] = merged;
  }
  for (const [rid, p] of Object.entries(patch.routes ?? {})) {
    const i = out.routes.findIndex((r) => r.id === rid);
    if (p === null) {
      if (i >= 0) out.routes.splice(i, 1);
      continue;
    }
    const merged = repairRoute({ ...(i >= 0 ? out.routes[i] : {}), ...p, id: rid }, out.routes.length);
    if (!merged) continue;
    if (i >= 0) out.routes[i] = merged;
    else out.routes.push(merged);
  }
  return out;
}

/** The smallest patch that turns `base` into `edited`. */
export function diffMod(base: TrackMod | undefined, edited: TrackMod): ModPatch | undefined {
  const b = base ?? { sources: {}, routes: [] };
  const out: ModPatch = {};
  const sources: NonNullable<ModPatch['sources']> = {};
  for (const id of SOURCE_IDS) {
    const bs = b.sources[id] as unknown as Obj | undefined;
    const es = edited.sources[id] as unknown as Obj | undefined;
    if (!es && bs) sources[id] = null;
    else if (es && !bs) sources[id] = clone(es);
    else if (es && bs && !same(es, bs)) {
      const d: Obj = {};
      for (const k of Object.keys(es)) if (!same(es[k], bs[k])) d[k] = clone(es[k]);
      sources[id] = d;
    }
  }
  if (Object.keys(sources).length) out.sources = sources;
  const routes: NonNullable<ModPatch['routes']> = {};
  for (const br of b.routes) if (!edited.routes.some((r) => r.id === br.id)) routes[br.id] = null;
  for (const er of edited.routes) {
    const br = b.routes.find((r) => r.id === er.id);
    if (!br) routes[er.id] = clone(er) as unknown as Obj;
    else if (!same(br, er)) {
      const d: Obj = {};
      for (const k of Object.keys(er) as (keyof ModRoute)[]) if (!same(er[k], br[k])) d[k] = clone(er[k]);
      routes[er.id] = d;
    }
  }
  if (Object.keys(routes).length) out.routes = routes;
  return out.sources || out.routes ? out : undefined;
}

/** How many sources and routes a patch changes. */
export function patchSize(p: ModPatch | undefined): number {
  return Object.keys(p?.sources ?? {}).length + Object.keys(p?.routes ?? {}).length;
}

/** Sources that are active: defined, or used by an enabled route (vel, trig and macros need no definition). */
export function activeSources(m: TrackMod | undefined): Set<SourceId> {
  const s = new Set<SourceId>();
  if (!m) return s;
  for (const id of Object.keys(m.sources)) s.add(id as SourceId);
  for (const r of m.routes) if (r.on) s.add(r.src);
  return s;
}

export const hasActiveRoutes = (m: TrackMod | undefined): boolean => !!m && m.routes.some((r) => r.on && r.amt !== 0);
