/**
 * Step sounds: per-step changes to the LXR sound, resolved on the musical clock.
 *
 * A step inherits its track's sound and overrides only what it names:
 *
 *   1. KIT              the LXR parameters of the kit (the engine's own values)
 *   2. TRACK SOUND      the track's voice (LXR trigger) and sample settings
 *   3. VARIATION        slot A-D of the track: a sparse set of parameters (and sample settings);
 *                       the step's `v`, or `alt.v` while the alt condition holds
 *   4. STEP LOCKS       fixed parameter values on this step
 *   5. RULES            conditional modifiers, in the order written: set, add, range, alt, evolve
 *
 * Later layers win. Every layer is sparse, so changing a kit parameter changes every step that
 * has not named it. The result is a flat list of (parameter, value) pairs that travels with the
 * hit to the engine (see ClatterEngine.startSynth), so it applies at that hit's own time.
 *
 * Everything here is a pure function of (project, hit, cycle, fill, seed): the same performance
 * replays identically, in playback, in export and after a reload. Nothing reads a clock or a
 * UI counter. `cycle` is the number of passes of a pattern since the transport started.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import { clamp, VARIATION_SLOTS, type ParamRule, type SampleOverrides, type SoundCond, type StepSound, type TrackSound, type Variation } from '../model/types';
import { rand, SALT, strCode } from '../rhythm/rng';
import { paramDef, TRIGGERS, voiceOfTrigger, VOICE_PARAMS, type ParamDef } from './lxrParams';

// ---------------------------------------------------------------------------- parameters
const lockable = VOICE_PARAMS.map((list) => new Map(list.filter((p) => p.kind !== 'target').map((p) => [p.id, p] as const)));

/** The parameters of the voice a trigger plays that a variation, lock or rule may set. */
export function lockableParams(trig: number): ParamDef[] {
  return [...lockable[voiceOfTrigger(clamp(Math.round(trig), 0, 6))]!.values()];
}

/** The definition of parameter `p` when the voice of `trig` has it. */
export function lockableParam(trig: number, p: number): ParamDef | undefined {
  return lockable[voiceOfTrigger(clamp(Math.round(trig), 0, 6))]!.get(p);
}

const fit = (def: ParamDef, v: number): number => clamp(Math.round(v), 0, def.max);

// ---------------------------------------------------------------------------- conditions
export interface SoundContext {
  /** the project seed */
  seed: number;
  /** passes of a pattern since the transport started (0 = the first) */
  cycle: number;
  /** a FILL is active for this hit's track */
  fill: boolean;
  track: string;
  /** the source step */
  step: number;
}

export const defaultCond = (k: SoundCond['k'] = 'always'): SoundCond => {
  switch (k) {
    case 'prob':
      return { k, p: 50 };
    case 'every':
    case 'first':
    case 'last':
      return { k, n: 4 };
    default:
      return { k } as SoundCond;
  }
};

export const COND_KINDS: SoundCond['k'][] = ['always', 'prob', 'every', 'first', 'last', 'alt', 'fill'];
export const COND_LABEL: Record<SoundCond['k'], string> = { always: 'ALWAYS', prob: 'PROBABILITY', every: 'EVERY N', first: 'FIRST OF N', last: 'LAST OF N', alt: 'ALTERNATE', fill: 'FILL' };

/** Does a condition hold for this hit? `salt` separates the random draws of different conditions. */
export function condHolds(c: SoundCond, x: SoundContext, salt = 0): boolean {
  switch (c.k) {
    case 'always':
      return true;
    case 'prob':
      return rand(x.seed, SALT.sndProb, strCode(x.track), x.cycle, x.step, salt) < clamp(c.p, 0, 100) / 100;
    case 'every': {
      const n = Math.max(1, Math.round(c.n));
      return x.cycle % n === n - 1;
    }
    case 'first':
      return x.cycle % Math.max(1, Math.round(c.n)) === 0;
    case 'last': {
      const n = Math.max(1, Math.round(c.n));
      return x.cycle % n === n - 1;
    }
    case 'alt':
      return x.cycle % 2 === 1;
    case 'fill':
      return x.fill;
  }
}

export function describeCond(c: SoundCond): string {
  switch (c.k) {
    case 'always':
      return 'ALWAYS';
    case 'prob':
      return `${c.p}%`;
    case 'every':
      return `EVERY ${c.n}`;
    case 'first':
      return `FIRST OF ${c.n}`;
    case 'last':
      return `LAST OF ${c.n}`;
    case 'alt':
      return 'ALTERNATE';
    case 'fill':
      return 'FILL';
  }
}

/** A step's sound in words, for tooltips and the grid key. */
export function describeStepSound(sound: TrackSound, ss: StepSound): string {
  const name = (i: number | null) => (i === null ? 'BASE' : String.fromCharCode(65 + i) + (sound.variations?.[i]?.name ? ` ${sound.variations[i]!.name}` : ''));
  const parts: string[] = [];
  if (ss.v !== undefined) parts.push('SOUND ' + name(ss.v));
  if (ss.alt) parts.push(`IF ${describeCond(ss.alt.cond)} → ${name(ss.alt.v)}`);
  if (ss.voice !== undefined) parts.push('VOICE ' + (TRIGGERS[ss.voice] ?? '?'));
  const nl = Object.keys(ss.locks ?? {}).length;
  if (nl) parts.push(`${nl} LOCK${nl > 1 ? 'S' : ''}`);
  const nr = ss.rules?.length ?? 0;
  if (nr) parts.push(`${nr} RULE${nr > 1 ? 'S' : ''}`);
  return parts.join(' · ') + (ss.gen ? ' (GENERATED)' : '');
}

// ---------------------------------------------------------------------------- resolution
export interface ResolvedSound {
  /** the LXR trigger that plays (the step's voice, or the track's) */
  trig: number;
  /** the voice was switched by the step */
  switched: boolean;
  /** (parameter, value) pairs applied for this hit, flat */
  params: number[];
  /** sample-layer settings for this hit */
  sample?: SampleOverrides;
  /** the variation that sounded (null = base) and whether a condition chose it */
  variation: number | null;
  conditional: boolean;
}

/** A triangle 0 → 1 → 0 over 2n passes: EVOLVE's bounded, returning glide. */
export function triangle(cycle: number, n: number): number {
  const len = Math.max(1, Math.round(n));
  const t = (cycle % (2 * len)) / len;
  return t <= 1 ? t : 2 - t;
}

function ruleValue(r: ParamRule, cur: number, x: SoundContext, index: number): number {
  switch (r.op) {
    case 'set':
      return r.a;
    case 'add':
      return cur + r.a;
    case 'range': {
      const lo = Math.min(r.a, r.b);
      const hi = Math.max(r.a, r.b);
      return lo + rand(x.seed, SALT.sndRange, strCode(x.track), x.cycle, x.step, r.p, index) * (hi - lo);
    }
    case 'alt':
      return x.cycle % 2 === 0 ? r.a : r.b;
    case 'evolve':
      return cur + r.a + (r.b - r.a) * triangle(x.cycle, r.n ?? 8);
  }
}

/**
 * Resolve a step's sound for one hit. `kit` gives the current kit value of a parameter (the
 * starting point of `add` rules). Returns the no-override result when the step has nothing.
 */
export function resolveStepSound(sound: TrackSound, ss: StepSound | undefined, kit: (p: number) => number, x: SoundContext): ResolvedSound {
  const trig = ss?.voice !== undefined ? clamp(Math.round(ss.voice), 0, 6) : sound.trigger;
  const out: ResolvedSound = { trig, switched: trig !== sound.trigger && ss?.voice !== undefined, params: [], variation: null, conditional: false };
  if (!ss) return out;
  const vals = new Map<number, number>();
  const allowed = lockable[voiceOfTrigger(trig)]!;

  // 3. variation: the step's, or the alternative while its condition holds
  let slot: number | null = ss.v !== undefined ? ss.v : null;
  if (ss.alt && condHolds(ss.alt.cond, x, 1000)) {
    slot = ss.alt.v;
    out.conditional = ss.alt.cond.k !== 'always';
  }
  const v = slot !== null ? sound.variations?.[slot] : null;
  if (v) {
    out.variation = slot;
    for (const [k, val] of Object.entries(v.params)) {
      const def = allowed.get(Number(k));
      if (def) vals.set(def.id, fit(def, val));
    }
    if (v.sample) out.sample = { ...v.sample };
  }

  // 4. step locks
  if (ss.locks) {
    for (const [k, val] of Object.entries(ss.locks)) {
      const def = allowed.get(Number(k));
      if (def) vals.set(def.id, fit(def, val));
    }
  }

  // 5. rules, in order
  if (ss.rules) {
    ss.rules.forEach((r, i) => {
      const def = allowed.get(r.p);
      if (!def || !condHolds(r.cond, x, i + 1)) return;
      // add / glide on a menu would jump between unrelated choices: only set and alt apply there
      if (def.kind === 'menu' && r.op !== 'set' && r.op !== 'alt') return;
      const cur = vals.get(def.id) ?? kit(def.id);
      vals.set(def.id, fit(def, ruleValue(r, cur, x, i)));
      if (r.cond.k !== 'always') out.conditional = true;
    });
  }
  for (const [p, val] of vals) out.params.push(p, val);
  return out;
}

// ---------------------------------------------------------------------------- hygiene
export function isEmptyStepSound(s: StepSound | undefined): boolean {
  if (!s) return true;
  return s.v === undefined && !s.alt && s.voice === undefined && !(s.locks && Object.keys(s.locks).length) && !(s.rules && s.rules.length);
}

export function repairCond(v: unknown): SoundCond {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const n = (x: unknown, d: number, lo: number, hi: number) => (typeof x === 'number' && Number.isFinite(x) ? Math.round(clamp(x, lo, hi)) : d);
  switch (o.k) {
    case 'prob':
      return { k: 'prob', p: n(o.p, 50, 0, 100) };
    case 'every':
    case 'first':
    case 'last':
      return { k: o.k, n: n(o.n, 4, 1, 64) };
    case 'alt':
    case 'fill':
      return { k: o.k };
    default:
      return { k: 'always' };
  }
}

/** A valid StepSound from anything (project files, pasted data); empty entries come back undefined. */
export function repairStepSound(v: unknown): StepSound | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const s: StepSound = {};
  const slot = (x: unknown) => (typeof x === 'number' && Number.isInteger(x) && x >= 0 && x < VARIATION_SLOTS ? x : undefined);
  if (slot(o.v) !== undefined) s.v = slot(o.v);
  if (o.alt && typeof o.alt === 'object') {
    const a = o.alt as Record<string, unknown>;
    s.alt = { cond: repairCond(a.cond), v: a.v === null ? null : (slot(a.v) ?? null) };
  }
  if (typeof o.voice === 'number' && Number.isInteger(o.voice) && o.voice >= 0 && o.voice <= 6) s.voice = o.voice;
  if (o.locks && typeof o.locks === 'object') {
    const locks: Record<number, number> = {};
    for (const [k, val] of Object.entries(o.locks as Record<string, unknown>)) {
      const def = paramDef(Number(k));
      if (def && typeof val === 'number' && Number.isFinite(val)) locks[def.id] = fit(def, val);
    }
    if (Object.keys(locks).length) s.locks = locks;
  }
  if (Array.isArray(o.rules)) {
    const rules: ParamRule[] = [];
    for (const r of o.rules.slice(0, 8)) {
      if (!r || typeof r !== 'object') continue;
      const q = r as Record<string, unknown>;
      const def = paramDef(Number(q.p));
      const op = q.op;
      if (!def || (op !== 'set' && op !== 'add' && op !== 'range' && op !== 'alt' && op !== 'evolve')) continue;
      const lo = op === 'add' ? -def.max : 0;
      const num = (x: unknown, d: number) => (typeof x === 'number' && Number.isFinite(x) ? Math.round(clamp(x, lo, def.max)) : d);
      const rule: ParamRule = { p: def.id, op, a: num(q.a, 0), b: num(q.b, def.max), cond: repairCond(q.cond) };
      if (op === 'evolve') rule.n = typeof q.n === 'number' ? Math.round(clamp(q.n, 1, 64)) : 8;
      rules.push(rule);
    }
    if (rules.length) s.rules = rules;
  }
  if (o.gen === true) s.gen = true;
  return isEmptyStepSound(s) ? undefined : s;
}

export function repairVariation(v: unknown): Variation | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const params: Record<number, number> = {};
  if (o.params && typeof o.params === 'object') {
    for (const [k, val] of Object.entries(o.params as Record<string, unknown>)) {
      const def = paramDef(Number(k));
      if (def && def.kind !== 'target' && typeof val === 'number' && Number.isFinite(val)) params[def.id] = fit(def, val);
    }
  }
  const out: Variation = { name: typeof o.name === 'string' ? o.name.slice(0, 12) : '', params };
  if (o.sample && typeof o.sample === 'object') {
    const q = o.sample as Record<string, unknown>;
    const s: SampleOverrides = {};
    const f = (x: unknown, lo: number, hi: number) => (typeof x === 'number' && Number.isFinite(x) ? clamp(x, lo, hi) : undefined);
    if (Array.isArray(q.samples)) s.samples = q.samples.filter((x): x is string => typeof x === 'string').slice(0, 16);
    for (const [k, lo, hi] of [['tune', -24, 24], ['fine', -100, 100], ['gain', 0, 2], ['pan', -1, 1], ['start', 0, 0.99], ['end', 0.01, 1]] as const) {
      const n = f(q[k], lo, hi);
      if (n !== undefined) s[k] = n;
    }
    if (typeof q.reverse === 'boolean') s.reverse = q.reverse;
    if (Object.keys(s).length) out.sample = s;
  }
  if (o.gen === true) out.gen = true;
  if (o.lock === true) out.lock = true;
  return out;
}

/** The sample ids a sound (its base and its variations) can play. */
export function soundSampleIds(sound: TrackSound): string[] {
  const ids = new Set(sound.samples);
  for (const v of sound.variations ?? []) for (const id of v?.sample?.samples ?? []) ids.add(id);
  return [...ids];
}

/** Display name of slot i of a track ("A", or "A · PUNCH"). */
export function slotLabel(sound: TrackSound, i: number): string {
  const n = sound.variations?.[i]?.name;
  return String.fromCharCode(65 + i) + (n ? ` · ${n}` : '');
}
