/**
 * The portable modulation format (CLATTER MOD, version 1).
 *
 * Everything here is plain JSON with stable identifiers: source ids ("lfo1", "env2", "step"...),
 * destination ids ("lxr.filter.cutoff", "smp.pitch"...), route ids, envelope breakpoints and
 * custom LFO tables. It describes WHAT modulates WHAT and says nothing about how a platform
 * executes it: the browser engine (src/audio/engine.ts, src/mod/runtime.ts) is one executor,
 * CLATTER Pocket on the M-VAVE FM-1 will be another, and it may support only a subset (see
 * `Capabilities` in format.ts and docs/MODULATION.md).
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */

export const MOD_FORMAT = 'clatter-mod';
export const MOD_VERSION = 1;

// ---------------------------------------------------------------------------- sources
export const LFO_IDS = ['lfo1', 'lfo2', 'lfo3', 'lfo4'] as const;
export const ENV_IDS = ['env1', 'env2'] as const;
export const MACRO_IDS = ['m1', 'm2', 'm3', 'm4'] as const;
export const SOURCE_IDS = [...LFO_IDS, ...ENV_IDS, 'step', 'rnd', 'smooth', 'sh', 'vel', 'trig', ...MACRO_IDS] as const;
export type SourceId = (typeof SOURCE_IDS)[number];
export type SourceType = 'lfo' | 'env' | 'step' | 'rnd' | 'smooth' | 'sh' | 'vel' | 'trig' | 'macro';

export const typeOfSource = (id: SourceId): SourceType => (id.startsWith('lfo') ? 'lfo' : id.startsWith('env') ? 'env' : id.startsWith('m') ? 'macro' : (id as SourceType));
export const SOURCE_LABEL: Record<SourceId, string> = {
  lfo1: 'LFO 1', lfo2: 'LFO 2', lfo3: 'LFO 3', lfo4: 'LFO 4', env1: 'ENV 1', env2: 'ENV 2', step: 'STEP', rnd: 'RANDOM', smooth: 'SMOOTH', sh: 'S&H', vel: 'VELOCITY', trig: 'TRIGGER', m1: 'MACRO 1', m2: 'MACRO 2', m3: 'MACRO 3', m4: 'MACRO 4',
};

/** Musical divisions: id → length in beats (quarter notes). */
export const DIVISIONS = [
  { id: '4/1', label: '4/1', beats: 16 },
  { id: '2/1', label: '2/1', beats: 8 },
  { id: '1/1', label: '1/1', beats: 4 },
  { id: '1/2', label: '1/2', beats: 2 },
  { id: '1/2T', label: '1/2T', beats: 4 / 3 },
  { id: '1/4.', label: '1/4.', beats: 1.5 },
  { id: '1/4', label: '1/4', beats: 1 },
  { id: '1/4T', label: '1/4T', beats: 2 / 3 },
  { id: '1/8.', label: '1/8.', beats: 0.75 },
  { id: '1/8', label: '1/8', beats: 0.5 },
  { id: '1/8T', label: '1/8T', beats: 1 / 3 },
  { id: '1/16.', label: '1/16.', beats: 0.375 },
  { id: '1/16', label: '1/16', beats: 0.25 },
  { id: '1/16T', label: '1/16T', beats: 1 / 6 },
  { id: '1/32', label: '1/32', beats: 0.125 },
  { id: '1/32T', label: '1/32T', beats: 1 / 12 },
] as const;
export type DivId = (typeof DIVISIONS)[number]['id'];
export const divBeats = (d: string): number => DIVISIONS.find((x) => x.id === d)?.beats ?? 1;

export const LFO_WAVES = ['sine', 'tri', 'sawup', 'sawdn', 'square', 'pulse', 'sh', 'step', 'smooth', 'custom'] as const;
export type LfoWave = (typeof LFO_WAVES)[number];
export const LFO_WAVE_LABEL: Record<LfoWave, string> = { sine: 'SINE', tri: 'TRIANGLE', sawup: 'SAW UP', sawdn: 'SAW DOWN', square: 'SQUARE', pulse: 'PULSE', sh: 'SAMPLE+HOLD', step: 'STEPPED RANDOM', smooth: 'SMOOTH RANDOM', custom: 'CUSTOM' };

/**
 * When a source restarts. HIT: every hit of the track. FREE: never (it runs from the start of the
 * engine). BAR / PATTERN: the phase is aligned to the bar or pattern grid at each hit, so the
 * source behaves as if it had restarted on the bar line or at the pattern start.
 */
export const RETRIGS = ['hit', 'free', 'bar', 'pattern'] as const;
export type Retrig = (typeof RETRIGS)[number];

export const CUSTOM_POINTS = 64;
export const MAX_STEPS = 32;
export const MAX_ENV_POINTS = 8;

export interface LfoDef {
  type: 'lfo';
  wave: LfoWave;
  mode: 'free' | 'sync';
  /** free rate, Hz */
  hz: number;
  div: DivId;
  /** start phase 0-1 */
  phase: number;
  /** 0-1 */
  depth: number;
  /** -1..1 added after depth */
  offset: number;
  /** unipolar output 0..1 instead of -1..1 */
  uni: boolean;
  retrig: Retrig;
  /** pulse width / skew 0.02-0.98 (0.5 = symmetric) */
  width: number;
  /** waveform bend -1..1 (negative: towards zero, positive: towards the peaks) */
  bend: number;
  /** CUSTOM: 64 points -1..1, one cycle */
  table?: number[];
  seed: number;
}

export type EnvKind = 'adsr' | 'ahdsr' | 'multi';
export interface EnvPoint {
  /** duration of the segment that ends at this point (ms, or beats when synced) */
  t: number;
  /** level 0-1 */
  v: number;
  /** segment curve -1..1 */
  c: number;
}
export interface EnvDef {
  type: 'env';
  kind: EnvKind;
  /** times are beats instead of milliseconds */
  sync: boolean;
  a: number;
  h: number;
  d: number;
  r: number;
  /** sustain level 0-1 */
  s: number;
  /** time the sustain is held before the release (0 = release at once) */
  gate: number;
  /** curve of the attack/decay/release segments, -1..1 */
  curve: number;
  /** which hits start it */
  trig: 'hit' | 'accent' | 'ghost';
  /** a hit while running: restart from zero, restart from where it is, or ignore the hit */
  retrig: 'restart' | 'legato' | 'ignore';
  /** MULTI: breakpoints after the starting level `v0` */
  v0: number;
  pts: EnvPoint[];
  /** MULTI: loop between two point indices (the loop runs from the end of point `from` to the end of point `to`) */
  loop: { from: number; to: number } | null;
}

export interface StepDef {
  type: 'step';
  len: number;
  /** -1..1 */
  vals: number[];
  div: DivId;
  dir: 'fwd' | 'rev' | 'ping' | 'rand';
  /** 0 = stepped, 1 = glides across the whole step */
  glide: number;
  retrig: 'hit' | 'free';
  seed: number;
}

export interface RndDef {
  type: 'rnd' | 'smooth';
  div: DivId;
  /** unipolar 0..1 instead of -1..1 */
  uni: boolean;
  seed: number;
}
export interface ShDef {
  type: 'sh';
  div: DivId;
  /** the source it samples, or noise */
  from: SourceId | 'noise';
  uni: boolean;
  seed: number;
}
export interface TrigDef {
  type: 'trig';
  /** decay of the pulse a hit makes (ms) */
  ms: number;
  /** the pulse is scaled by velocity */
  vel: boolean;
}
export interface VelDef {
  type: 'vel';
}

export type SourceDef = LfoDef | EnvDef | StepDef | RndDef | ShDef | TrigDef | VelDef;
export type Sources = Partial<Record<SourceId, SourceDef>>;

// ---------------------------------------------------------------------------- routes
export type Polarity = 'bi' | 'inv' | 'uni';
export const POLARITY_LABEL: Record<Polarity, string> = { bi: 'AS IS', inv: 'INVERT', uni: 'UNIPOLAR' };

export interface ModRoute {
  id: string;
  src: SourceId;
  /** stable destination id, see registry.ts */
  dst: string;
  /** -1..1: the share of the destination's span a full source swing moves it */
  amt: number;
  pol: Polarity;
  on: boolean;
  /** limits of this route's contribution, -1..1 (the modulation range) */
  lo: number;
  hi: number;
  /** smoothing time constant (ms) */
  smooth: number;
}

/** The modulation of one track (or the effective result for one of its variations). */
export interface TrackMod {
  sources: Sources;
  routes: ModRoute[];
}

/**
 * A variation's sparse override of the base modulation: a source (or route) changes only the
 * fields named; `null` removes it for this variation; a route id the base does not have adds
 * a whole route.
 */
export interface ModPatch {
  sources?: Partial<Record<SourceId, Record<string, unknown> | null>>;
  routes?: Record<string, Record<string, unknown> | null>;
}

export const emptyMod = (): TrackMod => ({ sources: {}, routes: [] });
export const isEmptyMod = (m: TrackMod | undefined): boolean => !m || (!Object.keys(m.sources).length && !m.routes.length);
export const isEmptyPatch = (p: ModPatch | undefined): boolean => !p || (!Object.keys(p.sources ?? {}).length && !Object.keys(p.routes ?? {}).length);
