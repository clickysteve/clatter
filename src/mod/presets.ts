/**
 * Modulation presets and generation.
 *
 * Factory presets are recipes: each route lists destinations in order of preference and takes the
 * first one the track can use (a kick has no MOD OSC, a sample track has no filter cutoff), so a
 * preset always produces working routes for the track it is loaded on. Generation, randomising
 * one source and mutation are seeded (the same seed gives the same result) and keep every
 * value inside its range; depths stay moderate so a generated setup is usable rather than
 * maximal on every route.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import { defaultEnv, defaultLfo, defaultRoute, defaultSource, newRouteId, repairMod, repairSource } from './config';
import { destApplies, destDef, destsFor, type SourceMode } from './registry';
import { clamp, hash01, sineTable } from './shapes';
import { DIVISIONS, LFO_WAVES, MAX_STEPS, type DivId, type EnvDef, type LfoDef, type LfoWave, type SourceId, type StepDef, type TrackMod } from './types';

export interface ModTarget {
  mode: SourceMode;
  /** LXR voice 0-5 (for sample tracks: the voice the track would play, irrelevant to the destinations) */
  voice: number;
}

interface RouteRecipe {
  src: SourceId;
  /** preferred destinations, first applicable wins */
  dst: string[];
  amt: number;
  pol?: 'bi' | 'inv' | 'uni';
  smooth?: number;
}
interface Recipe {
  id: string;
  name: string;
  help: string;
  sources: Partial<Record<SourceId, Partial<LfoDef> | Partial<EnvDef> | Partial<StepDef> | Record<string, unknown>>>;
  routes: RouteRecipe[];
}

const lfo = (o: Partial<LfoDef>): Partial<LfoDef> => o;

export const RECIPES: Recipe[] = [
  {
    id: 'wobble', name: 'WOBBLE', help: 'A slow, tempo-locked wobble on the filter or pitch.',
    sources: { lfo1: lfo({ wave: 'sine', mode: 'sync', div: '1/8', retrig: 'hit' }) },
    routes: [{ src: 'lfo1', dst: ['lxr.filter.cutoff', 'lxr.osc.coarse', 'smp.pitch', 'trk.filter'], amt: 0.4 }],
  },
  {
    id: 'metallic', name: 'METALLIC', help: 'Fast square modulation of the modulator oscillators: inharmonic, bell-like.',
    sources: { lfo1: lfo({ wave: 'square', mode: 'free', hz: 18, retrig: 'hit' }), lfo2: lfo({ wave: 'tri', mode: 'free', hz: 7.3, retrig: 'free' }) },
    routes: [
      { src: 'lfo1', dst: ['lxr.mod1.amount', 'lxr.fm.amount', 'lxr.noise.mix', 'smp.pitch'], amt: 0.3 },
      { src: 'lfo2', dst: ['lxr.mod2.freq', 'lxr.fm.freq', 'lxr.osc.fine', 'smp.pitch'], amt: 0.35 },
    ],
  },
  {
    id: 'breathing', name: 'BREATHING', help: 'A slow swell of level and brightness, one breath every two bars.',
    sources: { lfo1: lfo({ wave: 'sine', mode: 'sync', div: '2/1', retrig: 'bar', uni: true }) },
    routes: [
      { src: 'lfo1', dst: ['lxr.filter.cutoff', 'trk.filter'], amt: 0.35 },
      { src: 'lfo1', dst: ['lxr.voice.volume', 'smp.gain', 'trk.volume'], amt: 0.3 },
    ],
  },
  {
    id: 'unstable', name: 'UNSTABLE', help: 'Drifting pitch and timbre from smooth random: like an old oscillator.',
    sources: { smooth: { type: 'smooth', div: '1/8', uni: false, seed: 11 }, rnd: { type: 'rnd', div: '1/16', uni: false, seed: 5 } },
    routes: [
      { src: 'smooth', dst: ['lxr.osc.fine', 'smp.pitch'], amt: 0.45, smooth: 12 },
      { src: 'rnd', dst: ['lxr.filter.cutoff', 'lxr.fm.amount', 'trk.filter'], amt: 0.2, smooth: 12 },
    ],
  },
  {
    id: 'evolving', name: 'EVOLVING', help: 'Four slow, unrelated LFOs: the sound is never quite the same twice.',
    sources: {
      lfo1: lfo({ wave: 'sine', mode: 'sync', div: '4/1', retrig: 'free', phase: 0.1 }),
      lfo2: lfo({ wave: 'tri', mode: 'sync', div: '2/1', retrig: 'free', phase: 0.45 }),
      lfo3: lfo({ wave: 'smooth', mode: 'sync', div: '1/1', retrig: 'free', seed: 9 }),
    },
    routes: [
      { src: 'lfo1', dst: ['lxr.filter.cutoff', 'trk.filter'], amt: 0.3 },
      { src: 'lfo2', dst: ['lxr.fm.amount', 'lxr.noise.mix', 'smp.pan'], amt: 0.3 },
      { src: 'lfo3', dst: ['lxr.amp.decay', 'lxr.osc.fine', 'smp.pitch'], amt: 0.25 },
    ],
  },
  {
    id: 'pitchdrop', name: 'PERCUSSIVE PITCH DROP', help: 'An envelope throws the pitch up and lets it fall on every hit.',
    sources: { env1: { type: 'env', kind: 'adsr', a: 0, d: 110, s: 0, r: 40, curve: -0.6 } },
    routes: [{ src: 'env1', dst: ['lxr.osc.coarse', 'smp.pitch', 'lxr.mod1.freq'], amt: 0.55, smooth: 1 }],
  },
  {
    id: 'randfilter', name: 'RANDOM FILTER', help: 'A new random filter position on every sixteenth.',
    sources: { sh: { type: 'sh', div: '1/16', from: 'noise', uni: false, seed: 3 } },
    routes: [{ src: 'sh', dst: ['lxr.filter.cutoff', 'trk.filter', 'smp.pitch'], amt: 0.4, smooth: 6 }],
  },
  {
    id: 'rhythmfm', name: 'RHYTHMIC FM', help: 'A stepped sequence of FM depth: a rhythm inside the sound.',
    sources: { step: { type: 'step', len: 8, div: '1/16', dir: 'fwd', glide: 0, retrig: 'free', vals: [1, 0, 0.5, 0, 0.8, 0.2, 0, 0.6, ...new Array(MAX_STEPS - 8).fill(0)] } },
    routes: [
      { src: 'step', dst: ['lxr.fm.amount', 'lxr.mod1.amount', 'lxr.noise.mix', 'smp.pitch'], amt: 0.45, pol: 'uni' },
      { src: 'step', dst: ['lxr.fm.freq', 'lxr.mod2.freq', 'lxr.osc.fine'], amt: 0.25 },
    ],
  },
  {
    id: 'drift', name: 'SLOW TIMBRAL DRIFT', help: 'Two long smooth-random curves wander across filter and drive.',
    sources: { smooth: { type: 'smooth', div: '2/1', uni: false, seed: 21 }, lfo1: lfo({ wave: 'smooth', mode: 'sync', div: '4/1', retrig: 'free', seed: 4 }) },
    routes: [
      { src: 'smooth', dst: ['lxr.filter.cutoff', 'trk.filter'], amt: 0.35, smooth: 40 },
      { src: 'lfo1', dst: ['lxr.voice.drive', 'lxr.filter.drive', 'smp.pan'], amt: 0.25, smooth: 40 },
    ],
  },
  {
    id: 'stepped', name: 'STEPPED MODULATION', help: 'A step sequence moves the filter, a second one the pitch: robotic and rhythmic.',
    sources: { step: { type: 'step', len: 6, div: '1/8', dir: 'fwd', glide: 0.2, retrig: 'free', vals: [0.8, -0.2, 0.4, -0.8, 0.1, 0.6, ...new Array(MAX_STEPS - 6).fill(0)] } },
    routes: [
      { src: 'step', dst: ['lxr.filter.cutoff', 'trk.filter'], amt: 0.45 },
      { src: 'step', dst: ['lxr.osc.coarse', 'smp.pitch'], amt: 0.2 },
    ],
  },
];

export interface ModPreset {
  id: string;
  name: string;
  help?: string;
  factory?: boolean;
  /** the modulation, as it was built (user presets keep it whole, with its destinations) */
  mod?: TrackMod;
}

export const FACTORY_PRESETS: ModPreset[] = RECIPES.map((r) => ({ id: 'f:' + r.id, name: r.name, help: r.help, factory: true }));

/** A recipe made for a track: routes take the first destination the track can use. */
export function buildRecipe(id: string, t: ModTarget): TrackMod {
  const r = RECIPES.find((x) => 'f:' + x.id === id || x.id === id);
  if (!r) return { sources: {}, routes: [] };
  const raw = { sources: {} as Record<string, unknown>, routes: [] as unknown[] };
  for (const [sid, o] of Object.entries(r.sources)) raw.sources[sid] = { ...defaultSource(sid as SourceId), ...o };
  let n = 0;
  for (const rr of r.routes) {
    const dst = rr.dst.find((d) => destApplies(d, t.mode, t.voice));
    if (!dst) continue;
    raw.routes.push({ ...defaultRoute(`r${++n}`, rr.src, dst, rr.amt), pol: rr.pol ?? 'bi', smooth: rr.smooth ?? (destDef(dst)?.rate === 'trigger' ? 0 : 4) });
  }
  const m = repairMod(raw) ?? { sources: {}, routes: [] };
  // sources no route uses are not kept
  const used = new Set(m.routes.map((x) => x.src));
  for (const sid of Object.keys(m.sources)) if (!used.has(sid as SourceId) && ![...used].some((u) => (m.sources[u] as { from?: string } | undefined)?.from === sid)) delete m.sources[sid as SourceId];
  return m;
}

/** A user preset: the modulation of a track, kept whole. */
export function presetFrom(id: string, name: string, mod: TrackMod): ModPreset {
  return { id, name: name.toUpperCase().slice(0, 24), mod: repairMod(JSON.parse(JSON.stringify(mod))) ?? { sources: {}, routes: [] } };
}

/** A user preset on a track: routes whose destination the track cannot use are dropped. */
export function fitMod(m: TrackMod, t: ModTarget): TrackMod {
  const out = JSON.parse(JSON.stringify(m)) as TrackMod;
  out.routes = out.routes.filter((r) => destApplies(r.dst, t.mode, t.voice));
  return out;
}

// ---------------------------------------------------------------------------- generation
const pick = <T>(list: readonly T[], seed: number, salt: number): T => list[Math.min(list.length - 1, Math.floor(hash01(seed, salt, 17) * list.length))]!;
const range = (seed: number, salt: number, lo: number, hi: number): number => lo + hash01(seed, salt, 31) * (hi - lo);

/** Destinations worth modulating on a voice, most musical first. */
export function musicalDests(t: ModTarget): string[] {
  const all = destsFor(t.mode, t.voice).filter((d) => d.rate === 'continuous' && d.kind !== 'midi').map((d) => d.id);
  const prefer = t.mode === 'sample'
    ? ['smp.pitch', 'trk.filter', 'smp.pan', 'smp.gain', 'trk.pan']
    : t.voice === 3
      ? ['lxr.filter.cutoff', 'lxr.noise.mix', 'lxr.osc.coarse', 'lxr.pitch.amount', 'lxr.amp.decay', 'lxr.filter.drive', 'lxr.transient.level']
      : t.voice >= 4
        ? ['lxr.filter.cutoff', 'lxr.mod1.amount', 'lxr.mod2.freq', 'lxr.mod1.freq', 'lxr.osc.fine', 'lxr.filter.drive', 'lxr.transient.level']
        : ['lxr.osc.coarse', 'lxr.filter.cutoff', 'lxr.fm.amount', 'lxr.pitch.amount', 'lxr.amp.decay', 'lxr.pitch.decay', 'lxr.filter.drive', 'lxr.transient.level'];
  const out = prefer.filter((d) => all.includes(d));
  for (const d of all) if (!out.includes(d) && d !== 'lxr.voice.volume' && d !== 'trk.volume') out.push(d);
  return out;
}

const SYNC_DIVS: DivId[] = ['2/1', '1/1', '1/2', '1/4', '1/8', '1/16', '1/8T', '1/4.'];
const SOFT_WAVES: LfoWave[] = ['sine', 'tri', 'sawdn', 'smooth', 'sine', 'tri'];

/** Re-randomise one source: its character changes, its routes stay. */
export function randomiseSource(m: TrackMod, id: SourceId, seed: number): TrackMod {
  const out = JSON.parse(JSON.stringify(m)) as TrackMod;
  const cur = out.sources[id];
  const base = cur ?? defaultSource(id);
  let next: Record<string, unknown> = { ...base };
  switch (base.type) {
    case 'lfo': {
      const sync = hash01(seed, 1) < 0.7;
      next = {
        ...base,
        wave: pick(hash01(seed, 2) < 0.8 ? SOFT_WAVES : LFO_WAVES.filter((w) => w !== 'custom'), seed, 3),
        mode: sync ? 'sync' : 'free',
        div: pick(SYNC_DIVS, seed, 4),
        hz: Math.round(Math.exp(range(seed, 5, Math.log(0.3), Math.log(20))) * 100) / 100,
        phase: Math.round(range(seed, 6, 0, 1) * 8) / 8,
        width: Math.round(range(seed, 7, 0.25, 0.75) * 100) / 100,
        depth: Math.round(range(seed, 8, 0.6, 1) * 100) / 100,
        seed: Math.floor(hash01(seed, 9) * 100000),
      };
      break;
    }
    case 'env': {
      const multi = hash01(seed, 1) < 0.3;
      next = {
        ...base,
        kind: multi ? 'multi' : 'adsr',
        a: Math.round(range(seed, 2, 0, 30)),
        d: Math.round(range(seed, 3, 40, 500)),
        r: Math.round(range(seed, 4, 20, 300)),
        s: Math.round(range(seed, 5, 0, 0.5) * 100) / 100,
        curve: Math.round(range(seed, 6, -0.8, 0.2) * 100) / 100,
        pts: [
          { t: Math.round(range(seed, 7, 1, 20)), v: 1, c: -0.3 },
          { t: Math.round(range(seed, 8, 30, 200)), v: Math.round(range(seed, 9, 0.1, 0.7) * 100) / 100, c: -0.3 },
          { t: Math.round(range(seed, 10, 60, 400)), v: 0, c: -0.5 },
        ],
      };
      break;
    }
    case 'step': {
      const len = Math.round(range(seed, 1, 3, 12));
      next = {
        ...base,
        len,
        div: pick(['1/8', '1/16', '1/16', '1/8T', '1/16T'] as DivId[], seed, 2),
        dir: pick(['fwd', 'fwd', 'ping', 'rev', 'rand'] as StepDef['dir'][], seed, 3),
        glide: pick([0, 0, 0.3, 0.6], seed, 4),
        vals: Array.from({ length: MAX_STEPS }, (_, i) => (i < len ? Math.round(range(seed, 20 + i, -1, 1) * 8) / 8 : 0)),
        seed: Math.floor(hash01(seed, 5) * 100000),
      };
      break;
    }
    case 'rnd':
    case 'smooth':
    case 'sh':
      next = { ...base, div: pick(['1/4', '1/8', '1/16', '1/2'] as DivId[], seed, 1), seed: Math.floor(hash01(seed, 2) * 100000) };
      break;
    case 'trig':
      next = { ...base, ms: Math.round(range(seed, 1, 40, 500)) };
      break;
    default:
      return out;
  }
  const rep = repairSource(id, next);
  if (rep) (out.sources as Record<string, unknown>)[id] = rep;
  return out;
}

/**
 * A musically useful setup for a track: one or two LFOs and often an envelope or a random source,
 * routed to destinations the track really has, at moderate depths. `intensity` 0-1 sets how many
 * routes and how deep; the seed makes it reproducible.
 */
export function generateMod(seed: number, t: ModTarget, intensity = 0.5): TrackMod {
  const dests = musicalDests(t);
  const m: TrackMod = { sources: {}, routes: [] };
  if (!dests.length) return m;
  const k = clamp(intensity, 0.05, 1);
  const nRoutes = clamp(Math.round(1 + k * 3 * hash01(seed, 1) + k), 1, 4);
  const srcPool: SourceId[] = ['lfo1', 'lfo2', 'env1', 'smooth', 'step', 'sh', 'rnd'];
  const chosen: SourceId[] = [];
  for (let i = 0; i < nRoutes; i++) {
    let s = pick(srcPool, seed, 10 + i);
    if (i === 0 && hash01(seed, 99) < 0.6) s = 'lfo1';
    chosen.push(s);
  }
  const usedDests = new Map<string, number>();
  chosen.forEach((src, i) => {
    let d = pick(dests.slice(0, Math.max(3, Math.ceil(dests.length * 0.7))), seed, 40 + i);
    for (let tries = 0; tries < 6 && (usedDests.get(d) ?? 0) >= 2; tries++) d = pick(dests, seed, 50 + i + tries);
    usedDests.set(d, (usedDests.get(d) ?? 0) + 1);
    if (!m.sources[src] && src !== 'vel') m.sources[src] = (randomiseSource(m, src, seed + i * 7).sources[src] ?? defaultSource(src)) as never;
    const def = destDef(d)!;
    // envelopes move things one way; slow sources can be deeper than fast ones
    const maxAmt = def.rate === 'trigger' ? 0.5 : 0.65;
    const amt = Math.round(range(seed, 60 + i, 0.12, maxAmt * (0.4 + 0.6 * k)) * 100) / 100 * (hash01(seed, 70 + i) < 0.3 && !src.startsWith('env') ? -1 : 1);
    m.routes.push({ ...defaultRoute(newRouteId(m), src, d, amt), pol: src.startsWith('env') || src === 'sh' ? 'bi' : 'bi' });
  });
  // a lone LFO needs a defined waveform that is not a spike train at full depth
  for (const r of m.routes) {
    const s = m.sources[r.src];
    if (s && s.type === 'lfo' && (s.wave === 'square' || s.wave === 'pulse' || s.wave === 'step') && Math.abs(r.amt) > 0.4) r.amt = Math.sign(r.amt) * 0.3;
  }
  return repairMod(m) ?? m;
}

/** Nudge an existing configuration: values move a bounded amount, now and then a wave or a destination changes. */
export function mutateMod(m: TrackMod, seed: number, t: ModTarget, intensity = 0.4): TrackMod {
  const out = JSON.parse(JSON.stringify(m)) as TrackMod;
  const k = clamp(intensity, 0.05, 1);
  const jig = (v: number, lo: number, hi: number, s: number) => clamp(v + (hash01(seed, s, 3) * 2 - 1) * (hi - lo) * 0.25 * k, lo, hi);
  let salt = 100;
  for (const [id, s] of Object.entries(out.sources) as [SourceId, NonNullable<TrackMod['sources'][SourceId]>][]) {
    salt++;
    if (s.type === 'lfo') {
      s.depth = Math.round(jig(s.depth, 0.2, 1, salt) * 100) / 100;
      s.hz = Math.round(Math.exp(jig(Math.log(s.hz), Math.log(0.1), Math.log(40), salt + 1)) * 100) / 100;
      s.phase = Math.round(jig(s.phase, 0, 1, salt + 2) * 100) / 100;
      s.width = Math.round(jig(s.width, 0.2, 0.8, salt + 3) * 100) / 100;
      if (hash01(seed, salt + 4) < 0.25 * k) {
        s.wave = pick(LFO_WAVES.filter((w) => w !== 'custom'), seed, salt + 5);
      }
      if (hash01(seed, salt + 6) < 0.3 * k) s.div = pick(SYNC_DIVS, seed, salt + 7);
    } else if (s.type === 'env') {
      s.d = Math.round(jig(s.d, 20, 800, salt));
      s.r = Math.round(jig(s.r, 10, 600, salt + 1));
      s.a = Math.round(jig(s.a, 0, 60, salt + 2));
      s.s = Math.round(jig(s.s, 0, 0.8, salt + 3) * 100) / 100;
      s.curve = Math.round(jig(s.curve, -1, 1, salt + 4) * 100) / 100;
      s.pts = s.pts.map((p, i) => ({ t: Math.round(jig(p.t, 1, 600, salt + 10 + i)), v: i === s.pts.length - 1 ? 0 : Math.round(jig(p.v, 0, 1, salt + 20 + i) * 100) / 100, c: p.c }));
    } else if (s.type === 'step') {
      s.vals = s.vals.map((v, i) => (i < s.len && hash01(seed, salt + 30 + i) < 0.5 * k ? Math.round(jig(v, -1, 1, salt + 50 + i) * 8) / 8 : v));
    } else if (s.type !== 'vel' && s.type !== 'trig') {
      if (hash01(seed, salt + 60) < 0.4 * k) s.seed = Math.floor(hash01(seed, salt + 61) * 100000);
    }
    void id;
  }
  out.routes.forEach((r, i) => {
    r.amt = Math.round(jig(r.amt, -0.8, 0.8, 200 + i) * 100) / 100;
    if (hash01(seed, 300 + i) < 0.15 * k) {
      const ds = musicalDests(t);
      if (ds.length) r.dst = pick(ds, seed, 310 + i);
    }
  });
  if (hash01(seed, 400) < 0.3 * k && out.routes.length > 1) out.routes.splice(Math.floor(hash01(seed, 401) * out.routes.length), 1);
  return repairMod(out) ?? out;
}

export { defaultEnv, defaultLfo, sineTable, DIVISIONS };
