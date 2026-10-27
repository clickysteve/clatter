/**
 * Generative sound design: related timbres from an existing sound, and where to use them.
 *
 *   generateVariations  fills a track's slots A-D with variations of its base sound. Each voice
 *                       type has its own recipes (a kick gets PUNCH, DEEP, FM and DIRTY; a hat
 *                       gets TIGHT, BRIGHT, METAL and GRIT), written as moves of the firmware's own
 *                       parameters, kept inside ranges that stay audible, and widened only by TIMBRE.
 *   distributeSounds    assigns the variations (and small parameter locks, conditional
 *                       alternatives and random ranges, as TIMBRE grows) to the steps of a track by
 *                       its role: a kick keeps its main sound on the beat, a hi-hat varies often
 *                       and subtly, percussion roams.
 *   mutateSounds        redraws some of the step sounds of the hits; the rhythm never moves.
 *   addEvolution /      bounded glides on a few parameters over successive passes; they return home.
 *   clearEvolution
 *
 * All of it is a function of its seed: the same inputs give the same sounds. A sound is just a
 * sound, whoever made it, and the generators write over it; only locks protect: locked tracks,
 * locked variations, locked voices and locked parameters. One undo restores the sounds before.
 *
 * TIMBRE (0-1) is a designed curve, not a scale on every random number:
 *   0      nothing: every step plays its track's sound
 *   .25    subtle: a few weak hits get tiny decay and pitch shifts
 *   .5     noticeable: variations on off-beats and ghosts, a conditional alternative now and then
 *   .75    strong: most hits vary, several parameters move, conditions appear
 *   1      experimental: wide ranges, random ranges and the lowest decays, still inside DSP limits
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import { clamp, VARIATION_SLOTS, type Grid, type ParamRule, type SampleOverrides, type SoundCond, type SoundLocks, type StepSound, type TrackSound, type Variation } from '../model/types';
import { hash32, Rng, SALT, strCode } from '../rhythm/rng';
import { archetypeFor, snapCoarse, voiceKeys, type Archetype, type Key, type VoicePitchPlan } from './kitgen';
import { isEmptyStepSound, lockableParam } from './stepSound';

// ---------------------------------------------------------------------------- recipes
interface Move {
  key: Key;
  /** change in parameter units at full intensity */
  d: number;
}
interface Recipe {
  name: string;
  moves: Move[];
}

const R = (name: string, ...moves: [Key, number][]): Recipe => ({ name, moves: moves.map(([key, d]) => ({ key, d })) });

const RECIPES: Record<Archetype, Recipe[]> = {
  kick: [
    R('PUNCH', ['decay', -34], ['pAmt', 14], ['pDecay', -22], ['tVol', 20]),
    R('DEEP', ['decay', 30], ['coarse', -7], ['pDecay', 20], ['fmAmt', -20]),
    R('FM', ['fmAmt', 45], ['fmFreq', 14], ['pAmt', 12]),
    R('DIRTY', ['drive', 55], ['fdrive', 30], ['cutoff', -12]),
  ],
  tom: [
    R('SHORT', ['decay', -30], ['pAmt', 10]),
    R('LOW', ['coarse', -7], ['decay', 20]),
    R('FM', ['fmAmt', 40], ['fmFreq', 12]),
    R('BRIGHT', ['cutoff', 18], ['tVol', 15]),
  ],
  perc: [
    R('TICK', ['decay', -32], ['tVol', 22], ['cutoff', 12]),
    R('ZAP', ['pAmt', 25], ['pDecay', 25], ['fmAmt', 20]),
    R('FM', ['fmAmt', 42], ['fmFreq', 16]),
    R('GRIT', ['drive', 50], ['fdrive', 25], ['coarse', 5]),
  ],
  zap: [
    R('SHORT', ['decay', -30], ['pAmt', 14]),
    R('FALL', ['pAmt', 28], ['pDecay', 28]),
    R('FM', ['fmAmt', 44], ['fmFreq', 18]),
    R('GRIT', ['drive', 50], ['fdrive', 28]),
  ],
  snare: [
    R('SNAP', ['decay', -28], ['tVol', 20], ['noiseMix', 12]),
    R('BODY', ['decay', 25], ['noiseMix', -18], ['coarse', -3]),
    R('NOISY', ['noiseMix', 30], ['noiseFreq', 25]),
    R('CRUSH', ['drive', 50], ['fdrive', 25]),
  ],
  clap: [
    R('TIGHT', ['decay', -26], ['repeat', -14], ['tVol', 15]),
    R('WIDE', ['decay', 22], ['repeat', 16]),
    R('NOISY', ['noiseMix', 26], ['noiseFreq', 22]),
    R('CRUSH', ['drive', 48], ['fdrive', 22]),
  ],
  hat: [
    R('TIGHT', ['decay', -25], ['decayOpen', -35], ['cutoff', 10]),
    R('BRIGHT', ['cutoff', 25], ['m1amt', 20], ['reso', 10]),
    R('METAL', ['m1amt', 30], ['m2amt', 25], ['m1freq', 14], ['m2freq', -14]),
    R('GRIT', ['tVol', 25], ['drive', 40]),
  ],
  cymbal: [
    R('SHORT', ['decay', -40], ['cutoff', 10]),
    R('LONG', ['decay', 30], ['cutoff', -6]),
    R('SHIMMER', ['m1amt', 30], ['m2amt', 25], ['m2freq', 12]),
    R('DARK', ['cutoff', -30], ['coarse', -5]),
  ],
};

/** Keys that are menus or nothing a move may shift (the recipes only use continuous keys). */
const FLOOR: Partial<Record<Key, [number, number]>> = {
  // [normal floor, experimental floor] / ceilings are handled below
  decay: [12, 4],
  decayOpen: [12, 4],
  cutoff: [28, 12],
  tVol: [0, 0],
};
const CEIL: Partial<Record<Key, [number, number]>> = {
  drive: [112, 127],
  fdrive: [100, 127],
  reso: [96, 120],
  fmAmt: [118, 127],
  m1amt: [118, 127],
  m2amt: [118, 127],
};

/** Move one parameter, inside limits that keep it audible (wider as TIMBRE passes .9). */
function moved(key: Key, from: number, d: number, extreme: boolean): number {
  const lo = FLOOR[key]?.[extreme ? 1 : 0] ?? 0;
  const hi = CEIL[key]?.[extreme ? 1 : 0] ?? 127;
  const to = clamp(Math.round(from + d), lo, hi);
  // never move a value across a limit it already crossed
  return from < lo ? Math.max(from, to) : from > hi ? Math.min(from, to) : to;
}

export interface GenOptions {
  seed: number;
  /** TIMBRE 0-1 */
  amount: number;
  locks: SoundLocks;
  /** the track is scale-locked: pitch moves (COARSE) land on notes of the scale, so a variation does not leave it */
  pitch?: VoicePitchPlan | null;
}

/** Intensity of a variation at a TIMBRE: subtle at the bottom, full at 1. */
const intensity = (amount: number): number => 0.3 + 0.7 * clamp(amount, 0, 1);

const archetypeOf = (sound: TrackSound, role: string): Archetype => archetypeFor(sound.trigger >= 5 ? 5 : sound.trigger, [role]);
export const voiceOf = (sound: TrackSound): number => (sound.trigger >= 5 ? 5 : sound.trigger);

/** Is this slot free for a generator to write? (not locked) */
export function slotWritable(sound: TrackSound, i: number): boolean {
  const v = sound.variations?.[i];
  return !v || !v.lock;
}

/** The sample-layer moves of a variation (SAMPLE and HYBRID tracks). */
function sampleMoves(sound: TrackSound, slot: number, k: number, rng: Rng): SampleOverrides {
  const s: SampleOverrides = {};
  const kinds = ['tune', 'reverse', 'gain', 'pan'] as const;
  const kind = kinds[slot % kinds.length]!;
  switch (kind) {
    case 'tune':
      s.tune = clamp(Math.round((rng.chance(0.5) ? 1 : -1) * (3 + 9 * k)), -24, 24);
      break;
    case 'reverse':
      s.reverse = !sound.reverse;
      s.gain = clamp(sound.gain * 0.9, 0, 2);
      break;
    case 'gain':
      s.gain = clamp(sound.gain * (0.6 + 0.2 * (1 - k)), 0, 2);
      s.fine = clamp(Math.round(rng.range(-30, 30) * k), -100, 100);
      break;
    case 'pan':
      s.pan = clamp((rng.chance(0.5) ? 1 : -1) * (0.3 + 0.5 * k), -1, 1);
      break;
  }
  // a track with several samples can use another one in a variation
  if (sound.samples.length > 1) s.samples = [sound.samples[(slot + 1) % sound.samples.length]!];
  return s;
}

/**
 * Variations of a track's sound for slots A-D. Locked slots are kept, every other slot is
 * written. Returns the whole slot list (or the input when the track,
 * its voice or every slot is protected).
 */
export function generateVariations(sound: TrackSound, role: string, kit: readonly number[], o: GenOptions): (Variation | null)[] {
  const cur: (Variation | null)[] = Array.from({ length: VARIATION_SLOTS }, (_, i) => sound.variations?.[i] ?? null);
  if (sound.soundLock) return cur;
  const synth = sound.mode !== 'sample';
  const sample = sound.mode !== 'synth';
  const voice = voiceOf(sound);
  if (synth && o.locks.voices[voice]) return cur;
  const keys = voiceKeys(voice);
  const arch = archetypeOf(sound, role);
  const recipes = RECIPES[arch];
  const k = intensity(o.amount);
  const extreme = o.amount > 0.9;
  const rng = new Rng(hash32(o.seed, SALT.sndGen, strCode(role), voice));
  const order = recipes.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  for (let slot = 0; slot < VARIATION_SLOTS; slot++) {
    const existing = cur[slot];
    if (existing?.lock) continue;
    const recipe = recipes[order[slot % recipes.length]!]!;
    const params: Record<number, number> = {};
    if (synth) {
      // above .75 a second recipe is folded in at a lower weight: stranger, still related
      const parts: [Recipe, number][] = [[recipe, k]];
      if (o.amount > 0.75) parts.push([recipes[order[(slot + 1) % recipes.length]!]!, (o.amount - 0.75) * 2]);
      for (const [rec, w] of parts) {
        for (const m of rec.moves) {
          const id = keys[m.key];
          if (id === undefined || o.locks.params.includes(id) || !lockableParam(sound.trigger, id)) continue;
          const jitter = 0.8 + rng.next() * 0.4;
          const from = params[id] ?? kit[id] ?? 0;
          params[id] = moved(m.key, from, m.d * w * jitter, extreme);
        }
      }
      // the variation's oscillator pitch is a note of the scale, as the base's is
      if (o.pitch && keys.coarse !== undefined && params[keys.coarse] !== undefined) params[keys.coarse] = snapCoarse(o.pitch, params[keys.coarse]!);
      for (const id of Object.keys(params).map(Number)) if (params[id] === (kit[id] ?? 0)) delete params[id];
    }
    const v: Variation = { name: recipe.name.slice(0, 10), params };
    if (sample) {
      const sm = sampleMoves(sound, slot, k, rng);
      if (!synth) v.name = sm.reverse ? 'REVERSE' : sm.tune ? 'TUNED' : sm.pan !== undefined ? 'PANNED' : 'SOFT';
      v.sample = sm;
    }
    cur[slot] = Object.keys(params).length || v.sample ? v : null;
  }
  return cur;
}

// ---------------------------------------------------------------------------- distribution
export type RoleClass = 'steady' | 'backbeat' | 'busy' | 'free';

/** How a track's role shapes where variations go. */
export function roleClass(role: string): RoleClass {
  switch (role) {
    case 'kick':
      return 'steady';
    case 'snare':
    case 'clap':
      return 'backbeat';
    case 'chat':
    case 'ohat':
      return 'busy';
    default:
      return 'free';
  }
}

export interface DistributeOptions extends GenOptions {
  /** a number for each fresh draw (MUTATE and DISTRIBUTE again use new takes) */
  take: number;
  steps: number;
  perBeat: number;
  perBar: number;
  /** only these steps (inclusive); default all */
  region?: [number, number];
}

const DECAY_KEYS: Key[] = ['decay'];

/**
 * Step sounds for a track's hits. Returns the track's whole set of step sounds: everything outside
 * `region` as it was, the rest redrawn for the hits that exist.
 */
export function distributeSounds(sound: TrackSound, role: string, grid: Grid, existing: Record<number, StepSound> | undefined, kit: readonly number[], o: DistributeOptions): Record<number, StepSound> {
  const out: Record<number, StepSound> = {};
  const [r0, r1] = o.region ?? [0, o.steps - 1];
  for (const [k, ss] of Object.entries(existing ?? {})) {
    const i = Number(k);
    if (i < r0 || i > r1) out[i] = ss;
  }
  if (sound.soundLock || (sound.mode !== 'sample' && o.locks.voices[voiceOf(sound)])) return out;
  const slots = [0, 1, 2, 3].filter((i) => sound.variations?.[i]);
  const amount = clamp(o.amount, 0, 1);
  if (amount <= 0) return out;
  const cls = roleClass(role);
  const tc = strCode(role);
  const keys = voiceKeys(voiceOf(sound));
  const lastBar = o.steps - o.perBar;
  const lastHit = (() => {
    for (let i = Math.min(r1, grid.length - 1); i >= r0; i--) if (grid[i]) return i;
    return -1;
  })();
  const r = (i: number, salt: number) => hash32(o.seed, SALT.sndDist, tc, o.take, i, salt) / 4294967296;

  for (let i = r0; i <= r1 && i < grid.length; i++) {
    const hit = grid[i];
    if (!hit || out[i]) continue;
    const strong = i % o.perBeat === 0;
    const down = i % o.perBar === 0;
    const accent = hit.vel >= 105;
    const ghost = hit.vel < 72;
    const inFill = i >= lastBar;
    // chance that this hit leaves its track's sound at all
    let p: number;
    switch (cls) {
      case 'steady':
        p = down ? 0.05 : strong ? 0.2 : 0.85;
        break;
      case 'backbeat':
        p = accent ? 0.2 : ghost ? 0.9 : 0.5;
        break;
      case 'busy':
        p = strong ? 0.6 : 0.9;
        break;
      default:
        p = 1;
    }
    p *= Math.min(1, amount * 1.25);
    const ss: StepSound = {};
    if (slots.length && r(i, 1) < p) {
      // louder hits favour the first slots; quiet ones the later
      const w = cls === 'free' ? r(i, 2) : Math.pow(r(i, 2), accent ? 1.8 : 1);
      ss.v = slots[Math.min(slots.length - 1, Math.floor(w * slots.length * (0.6 + 0.6 * amount)))]!;
    }
    // a conditional alternative: the sound changes now and then without moving the rhythm
    const condP = clamp((amount - 0.4) * 1.1, 0, 1) * (cls === 'free' ? 1 : cls === 'busy' ? 0.8 : 0.5);
    if (slots.length && r(i, 3) < condP) {
      const other = slots.filter((s) => s !== ss.v);
      const target = other.length ? other[Math.floor(r(i, 4) * other.length)]! : null;
      let cond: SoundCond;
      if (inFill && r(i, 5) < 0.5) cond = { k: 'fill' };
      else if (i === lastHit) cond = { k: 'every', n: r(i, 6) < 0.5 ? 4 : 2 };
      else {
        const c = r(i, 7);
        cond = c < 0.4 ? { k: 'prob', p: 20 + Math.round(r(i, 8) * 30) } : c < 0.7 ? { k: 'alt' } : { k: 'every', n: [3, 4, 8][Math.floor(r(i, 9) * 3)]! };
      }
      ss.alt = { cond, v: target };
    }
    // small parameter locks: subtle decay and pitch shifts, more of them as TIMBRE grows
    const lockP = clamp((amount - 0.2) * 1.4, 0, 1) * (ghost || !strong ? 1 : 0.4);
    if (sound.mode !== 'sample' && r(i, 10) < lockP) {
      const locks: Record<number, number> = {};
      const n = amount > 0.75 ? 3 : amount > 0.45 ? 2 : 1;
      const pool: Key[] = [...DECAY_KEYS, 'coarse', 'cutoff', 'fmAmt', 'pAmt', 'drive', 'noiseMix', 'm1amt'];
      const usable = pool.filter((k) => {
        const id = keys[k];
        return id !== undefined && !o.locks.params.includes(id) && lockableParam(sound.trigger, id);
      });
      for (let q = 0; q < n && usable.length; q++) {
        const key = usable.splice(Math.floor(r(i, 11 + q) * usable.length), 1)[0]!;
        const id = keys[key]!;
        const span = key === 'coarse' ? 1 + Math.round(amount * 4) : 4 + amount * 26;
        const d = (r(i, 20 + q) * 2 - 1) * span;
        locks[id] = moved(key, kit[id] ?? 0, d, amount > 0.9);
        if (key === 'coarse' && o.pitch) locks[id] = snapCoarse(o.pitch, locks[id]!);
      }
      if (Object.keys(locks).length) ss.locks = locks;
    }
    // experimental: a random range on the decay, a new value every pass (seeded)
    if (sound.mode !== 'sample' && amount > 0.9 && r(i, 30) < (amount - 0.9) * 8 && keys.decay !== undefined && !o.locks.params.includes(keys.decay) && lockableParam(sound.trigger, keys.decay)) {
      const base = kit[keys.decay] ?? 64;
      const rule: ParamRule = { p: keys.decay, op: 'range', a: moved('decay', base, -30, true), b: moved('decay', base, 20, true), cond: { k: 'always' } };
      ss.rules = [rule];
    }
    // glides added by EVOLVE SOUND stay when the rest is redrawn
    const glides = existing?.[i]?.rules?.filter((q) => q.op === 'evolve');
    if (glides?.length) ss.rules = [...(ss.rules ?? []), ...glides];
    if (!isEmptyStepSound(ss)) out[i] = ss;
  }
  return out;
}

/**
 * MUTATE SOUND: redraws a share (`amount`) of the step sounds of the hits, from a fresh take, and
 * keeps the rest. The rhythm is untouched.
 */
export function mutateSounds(sound: TrackSound, role: string, grid: Grid, existing: Record<number, StepSound> | undefined, kit: readonly number[], o: DistributeOptions & { amount: number }): Record<number, StepSound> {
  const fresh = distributeSounds(sound, role, grid, undefined, kit, { ...o, amount: Math.max(o.amount, clamp(o.amount, 0, 1) > 0 ? 0.35 : 0) });
  const out: Record<number, StepSound> = { ...(existing ?? {}) };
  if (sound.soundLock) return out;
  const [r0, r1] = o.region ?? [0, o.steps - 1];
  const tc = strCode(role);
  for (let i = r0; i <= r1 && i < grid.length; i++) {
    if (!grid[i]) continue;
    if (hash32(o.seed, SALT.sndMut, tc, o.take, i) / 4294967296 >= o.amount) continue;
    // EVOLVE glides are a separate layer: a redrawn step keeps them
    const glides = out[i]?.rules?.filter((r) => r.op === 'evolve') ?? [];
    const next: StepSound | undefined = fresh[i] ? { ...fresh[i]! } : glides.length ? {} : undefined;
    if (next && glides.length) next.rules = [...(next.rules ?? []), ...glides];
    if (next) out[i] = next;
    else delete out[i];
  }
  return out;
}

// ---------------------------------------------------------------------------- evolution
/** Parameters EVOLVE glides for a voice, and the depth at full amount. */
function evolveTargets(sound: TrackSound, role: string): { key: Key; depth: number }[] {
  switch (archetypeOf(sound, role)) {
    case 'kick':
    case 'tom':
      return [{ key: 'fmAmt', depth: 40 }, { key: 'decay', depth: -22 }];
    case 'snare':
    case 'clap':
      return [{ key: 'noiseMix', depth: 30 }, { key: 'decay', depth: -20 }];
    case 'hat':
      return [{ key: 'cutoff', depth: 30 }, { key: 'm1amt', depth: 26 }];
    case 'cymbal':
      return [{ key: 'm1amt', depth: 30 }, { key: 'cutoff', depth: -25 }];
    default:
      return [{ key: 'pAmt', depth: 30 }, { key: 'fmAmt', depth: 30 }];
  }
}

/**
 * EVOLVE SOUND: every hit gets glide rules on a couple of its voice's parameters. The value
 * moves from the step's own up to `depth` away over `passes` passes of the pattern and back
 * again (a triangle), so it is bounded and returns to the base sound on its own.
 */
export function addEvolution(sound: TrackSound, role: string, grid: Grid, existing: Record<number, StepSound> | undefined, o: { amount: number; passes: number; locks: SoundLocks }): Record<number, StepSound> {
  const out: Record<number, StepSound> = { ...(existing ?? {}) };
  if (sound.mode === 'sample') return out;
  const keys = voiceKeys(voiceOf(sound));
  const targets = evolveTargets(sound, role).filter((t) => {
    const id = keys[t.key];
    return id !== undefined && !o.locks.params.includes(id) && lockableParam(sound.trigger, id);
  });
  for (let i = 0; i < grid.length; i++) {
    if (!grid[i]) continue;
    const ss: StepSound = { ...(out[i] ?? {}), rules: [...(out[i]?.rules ?? []).filter((r) => r.op !== 'evolve')] };
    for (const t of targets) ss.rules!.push({ p: keys[t.key]!, op: 'evolve', a: 0, b: Math.round(t.depth * clamp(o.amount, 0, 1)), n: clamp(Math.round(o.passes), 1, 64), cond: { k: 'always' } });
    out[i] = ss;
  }
  return out;
}

/** Remove the glide rules (and nothing else). */
export function clearEvolution(existing: Record<number, StepSound> | undefined): Record<number, StepSound> {
  const out: Record<number, StepSound> = {};
  for (const [k, ss] of Object.entries(existing ?? {})) {
    const rules = ss.rules?.filter((r) => r.op !== 'evolve');
    const next: StepSound = { ...ss, ...(rules?.length ? { rules } : {}) };
    if (!rules?.length) delete next.rules;
    if (!isEmptyStepSound(next)) out[Number(k)] = next;
  }
  return out;
}
