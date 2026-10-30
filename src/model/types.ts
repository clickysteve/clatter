/**
 * CLATTER's data model.
 *
 * Three systems, kept apart:
 *   RHYTHM       what is played: patterns of hits per track (one editable grid per track)
 *   SOUND        what makes the sound: the LXR kit (synthesis parameters) and each track's
 *                sound source (SYNTH, SAMPLE or HYBRID)
 *   DESTRUCTION  how rhythm (and sound, per hit) is transformed: CHOP, ROLLS, DESTROY
 *
 * The rhythm never names a sound: a hit belongs to a TRACK; the track decides what it plays.
 * The sound never knows which algorithm made a hit.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */

import type { ChannelFx, OutputFx } from '../audio/mixfx';
import type { ModPatch, TrackMod } from '../mod/types';
import type { TempoAuto } from '../transport/tempo';
import type { WildSettings } from '../destruction/wildcardProject';
import type { CandidateOrigin } from '../sound/discover';
import type { GlobalScale, TrackScale } from '../music/scale';

/** Ticks per quarter note (musical time unit; 24 per sixteenth). */
export const PPQ = 96;
export const MAX_STEPS = 64;
export const MAX_TRACKS = 12;
export const MAX_PATTERNS = 16;
export const SNAPSHOTS = 8;

/** Steps per beat: 16ths, 16th triplets, 32nds, 8th triplets. */
export type Resolution = 4 | 6 | 8 | 3;
export const RESOLUTIONS: Resolution[] = [4, 6, 8, 3];
export const RESOLUTION_LABEL: Record<Resolution, string> = { 4: '1/16', 6: '1/16T', 8: '1/32', 3: '1/8T' };

export const stepTicks = (res: Resolution): number => PPQ / res;

/** One hit in a step. */
export interface Hit {
  /** velocity 1-127 */
  vel: number;
  /** probability 0-100 (absent = 100) */
  prob?: number;
  /** pitch offset in semitones (absent = 0) */
  note?: number;
  /** flam: a soft grace note just before */
  flam?: boolean;
  /** ratchet: the step played 2-4 times */
  ratchet?: number;
  /** a specific sample for this hit (sample tracks with several samples) */
  sample?: string;
}

export type Grid = (Hit | null)[];

/** Sound variation slots per track: A, B, C, D. */
export const VARIATION_SLOTS = 4;
export const SLOT_NAMES = ['A', 'B', 'C', 'D'] as const;

/**
 * When a sound change applies. Evaluated on the musical clock: `cycle` is the number of passes
 * of a pattern since the transport started (0 on the first), never a UI counter.
 *
 *   always  every time          prob   n % of the time (seeded, so exports repeat)
 *   every   the Nth pass        first  the first pass of each cycle of N
 *   last    the last pass of each cycle of N
 *   alt     every second pass   fill   while a FILL is active (momentary FILL or a generated fill)
 */
export type SoundCond =
  | { k: 'always' }
  | { k: 'prob'; p: number }
  | { k: 'every'; n: number }
  | { k: 'first'; n: number }
  | { k: 'last'; n: number }
  | { k: 'alt' }
  | { k: 'fill' };
export type SoundCondKind = SoundCond['k'];

/**
 * Whether a programmed step plays at all (a trigger condition). Independent of the step's sound:
 * the condition is decided first, and only a step that plays resolves its sound variation.
 * A step with no entry is ALWAYS. Counting is per pattern pass: see src/rhythm/trigger.ts.
 *
 *   always   every pass                    prob    n % of the passes (seeded)
 *   every    pass `at` of every `n`        first   the first pass since the pattern began
 *   last     the final pass (length known) odd     passes 1, 3, 5...
 *   even     passes 2, 4, 6...             alt     `run` passes on, `run` off, repeating
 *   fill     only while a FILL is active   nofill  only while no FILL is active
 *   prev     if the step before it played  noprev  if the step before it did not
 */
export type TrigCond =
  | { k: 'always' }
  | { k: 'prob'; p: number }
  | { k: 'every'; n: number; at: number }
  | { k: 'first' }
  | { k: 'last' }
  | { k: 'odd' }
  | { k: 'even' }
  | { k: 'alt'; run: number }
  | { k: 'fill' }
  | { k: 'nofill' }
  | { k: 'prev' }
  | { k: 'noprev' };
export type TrigKind = TrigCond['k'];

/** Sample-layer settings a variation or a step can change (the track's own where absent). */
export interface SampleOverrides {
  samples?: string[];
  tune?: number;
  fine?: number;
  gain?: number;
  pan?: number;
  reverse?: boolean;
  start?: number;
  end?: number;
}

/**
 * A sound variation of one track: a sparse set of LXR parameter values over the kit (absent
 * parameters follow the kit) and sample-layer overrides. Slot A-D.
 */
export interface Variation {
  name: string;
  /** PAR_* number → 0-127 */
  params: Record<number, number>;
  sample?: SampleOverrides;
  /** sparse override of the track's base modulation (absent: the variation modulates as the base does) */
  mod?: ModPatch;
  /** protected from the sound generators */
  lock?: boolean;
}

/**
 * A rule changing one parameter of a step's sound when its condition holds.
 *   set     the value `a`            add     the kit/variation value plus `a` (± 127)
 *   range   a random value in a..b   alt     `a` on even passes, `b` on odd ones
 *   evolve  the value plus a glide from `a` to `b` over `n` passes and back again (bounded, returns home)
 */
export interface ParamRule {
  p: number;
  op: 'set' | 'add' | 'range' | 'alt' | 'evolve';
  a: number;
  b: number;
  n?: number;
  cond: SoundCond;
}

/**
 * What one step sounds like, as sparse overrides on its track's sound. Inheritance:
 *   KIT → TRACK SOUND → VARIATION → STEP LOCKS → CONDITIONAL RULES
 */
export interface StepSound {
  /** variation slot 0-3 (absent: the track's base sound) */
  v?: number;
  /** a different variation (or the base sound, null) while a condition holds */
  alt?: { cond: SoundCond; v: number | null };
  /** play another LXR trigger (0-6) instead of the track's */
  voice?: number;
  /** fixed parameter values: PAR_* → 0-127 */
  locks?: Record<number, number>;
  rules?: ParamRule[];
}

/** Track roles: what a track is for musically (generation and default sounds). */
export const ROLES = ['kick', 'snare', 'clap', 'chat', 'ohat', 'ltom', 'htom', 'cymbal', 'perc', 'fx'] as const;
export type Role = (typeof ROLES)[number];
export const ROLE_LABEL: Record<Role, string> = {
  kick: 'KICK',
  snare: 'SNARE',
  clap: 'CLAP',
  chat: 'CL HAT',
  ohat: 'OP HAT',
  ltom: 'LO TOM',
  htom: 'HI TOM',
  cymbal: 'CYMBAL',
  perc: 'PERC',
  fx: 'FX',
};
/** General MIDI drum notes per role (MIDI out and file defaults). */
export const GM_NOTE: Record<Role, number> = { kick: 36, snare: 38, clap: 39, chat: 42, ohat: 46, ltom: 45, htom: 50, cymbal: 49, perc: 37, fx: 56 };

export type SourceMode = 'synth' | 'sample' | 'hybrid';
export type SamplePick = 'first' | 'cycle' | 'random' | 'velocity';

/** What a track sounds like (part of the KIT). */
export interface TrackSound {
  mode: SourceMode;
  /** LXR trigger 0-6 (drum 1-3, snare, cymbal, closed hat, open hat) */
  trigger: number;
  /** synth note: 60 plays the voice at its programmed pitch */
  note: number;
  /** HYBRID levels 0-1 */
  synthLevel: number;
  sampleLevel: number;
  /** sample ids (content hashes); several = per-hit selection */
  samples: string[];
  pick: SamplePick;
  /** sample region, 0-1 of its length */
  start: number;
  end: number;
  /** sample tuning in semitones, and cents */
  tune: number;
  fine: number;
  /** sample gain 0-2 and pan -1..1 (before the track's mixer) */
  gain: number;
  pan: number;
  reverse: boolean;
  /** HYBRID alignment in ms: positive delays the sample, negative the synth */
  offsetMs: number;
  /** choke group 0 (none) - 4 */
  choke: number;
  /** the track's modulation: sources and routes (absent: none). Variations override it sparsely (Variation.mod). */
  mod?: TrackMod;
  /** sound variations A-D (null = empty slot); absent in projects older than 0.2 */
  variations?: (Variation | null)[];
  /** protect this track's variations from the sound generators */
  soundLock?: boolean;
}

export interface TrackMix {
  /** fader 0-1 (0.8 = 0 dB) */
  volume: number;
  pan: number;
  mute: boolean;
  solo: boolean;
  /** MAIN: the master bus. FX: through the LXR FX bus only (as the LXR routes a voice to FX). */
  route: 'main' | 'fx';
  /** one-knob filter: -1 low-pass .. 0 off .. 1 high-pass */
  filter: number;
  /** send to the LXR FX bus 0-1 (with route MAIN the dry signal also plays; absent in older projects: 0) */
  send?: number;
  /** channel processing: transient shaper, EQ, saturation, soft clip, bit reduction (absent: none) */
  fx?: ChannelFx;
}

/** Per-track performance controls (DOWNBEAT-style realisation). */
export interface TrackPlay {
  /** density 0-100: weak hits drop out first */
  density: number;
  /** generated fills into gaps 0-100 */
  fill: number;
  /** timing looseness 0-100 */
  humanize: number;
  /** probability scale 0-100 (applies to every hit's own probability) */
  chance: number;
  /** loop length in steps (0 = pattern length): polymeter */
  length: number;
}

/**
 * What the pitch analysis found in the UNTUNED sound of one layer of one slot. Only a record of
 * a measurement: the scale move itself is computed from it (src/music/tuning.ts).
 */
export interface PitchMeasure {
  kind: 'stable' | 'swept' | 'inharmonic' | 'unpitched' | 'silent';
  /** the settled fundamental in Hz (absent: the sound has none) */
  hz?: number;
  /** 0-1 */
  conf: number;
  /** what makes the pitch of the sound it was measured from (changes when the sound's character changes) */
  shape: string;
  /** the sound's pitch offset in semitones when it was measured (later COARSE/FINE/NOTE/TUNE edits are added to the measurement) */
  off: number;
  /** a correction in cents found by measuring the tuned sound, valid for the scale note it was found at */
  adj?: { target: number; cents: number };
  /** milliseconds since 1970 */
  at: number;
}

export interface SlotMeasure {
  synth?: PitchMeasure;
  sample?: PitchMeasure;
}

/** Measurements by slot: the base sound and variations A-D. */
export interface TrackPitch {
  base?: SlotMeasure;
  vars?: (SlotMeasure | null)[];
}

export interface Track {
  id: string;
  name: string;
  role: Role;
  sound: TrackSound;
  mix: TrackMix;
  play: TrackPlay;
  midi: { channel: number; note: number };
  /** LOCK: generation and mutation leave this track's rhythm alone */
  lock: boolean;
  /** scale quantisation: OFF, GLOBAL or CUSTOM (absent: GLOBAL for pitched roles, OFF for the rest; see src/music/scale.ts) */
  scale?: TrackScale;
  /** measurements of the untuned sound that scale quantisation corrects (see src/music/tuning.ts) */
  pitch?: TrackPitch;
}

/** Rhythm generation settings. */
export interface GenSettings {
  style: string;
  /** overall hit density 0-1 */
  density: number;
  /** syncopation / off-grid emphasis 0-1 */
  complexity: number;
  /** how much bars differ from each other 0-1 */
  variation: number;
  /** accent strength 0-1 */
  accent: number;
  /** fill into the phrase end 0-1 */
  fills: number;
  bars: number;
}

/** A pattern: one editable grid per track. Generation, mutation, transforms and hand edits all write it directly. */
export interface Pattern {
  id: string;
  name: string;
  /** length in steps */
  steps: number;
  res: Resolution;
  /** the notes: one grid per track, the single authoritative pattern */
  grids: Record<string, Grid>;
  /** the seed and settings of the last generation (the next GENERATE starts from them) */
  seed: number;
  /** the phrase that named the seed (absent: a plain number, as in every project before 0.5) */
  seedText?: string;
  settings: GenSettings;
  /** how many VARIATIONs / MUTATEs led here (display) */
  generation: number;
  /** step sounds: track → step → StepSound (sparse; absent in projects older than 0.2) */
  sounds?: Record<string, Record<number, StepSound>>;
  /** trigger conditions: track → step → condition (sparse: absent = ALWAYS; absent in projects older than 0.4) */
  trig?: Record<string, Record<number, TrigCond>>;
}

/** CHOP: the pattern cut into slices and rearranged (after The Breakery's CHOP). */
export interface ChopSettings {
  on: boolean;
  amount: number;
  /** slice in steps */
  slice: number;
  retrigger: number;
  take: number;
}

export const ROLL_SPEEDS = ['16', '16T', '32', '32T', '64'] as const;
export type RollSpeed = (typeof ROLL_SPEEDS)[number];
/** ticks between roll strokes */
export const ROLL_TICKS: Record<RollSpeed, number> = { '16': 24, '16T': 16, '32': 12, '32T': 8, '64': 6 };
export type RollPlace = 'phrase' | 'accent' | 'anywhere';
export type RollShape = 'even' | 'crescendo' | 'decrescendo' | 'human';

/** ROLLS: retriggers leading into hits (after The Breakery's ROLLS). */
export interface RollSettings {
  on: boolean;
  prob: number;
  length: number;
  speed: RollSpeed;
  shape: RollShape;
  place: RollPlace;
  /** roles that may roll */
  targets: Role[];
  take: number;
}

/** DESTROY: event-level destruction, per hit (after The Breakery's DESTROY). */
export interface DestroySettings {
  on: boolean;
  /** master amount 0-1 (scales every probability) */
  amount: number;
  stutter: number;
  pitch: number;
  reverse: number;
  gate: number;
  /** CRUSH: LXR sample-rate reduction locked on the hit (synth) */
  crush: number;
  /** SKIP: hits dropped */
  skip: number;
  take: number;
}

export interface DestructionSettings {
  chop: ChopSettings;
  rolls: RollSettings;
  destroy: DestroySettings;
}

/** Where a voice's sound came from when it was applied from SOUND DISCOVERY. */
export interface DiscoveredSound {
  name: string;
  origin: CandidateOrigin;
}

/** What a generated kit was made with: the seed, this and the generator version name the kit again. */
export interface KitMade {
  /** KIT_GENERATOR when it was made */
  generator: number;
  character: import('../rhythm/styles').KitFlavour;
  /** 0-1 */
  wildness: number;
}

/** The LXR kit: every sound parameter value (0-127) and the modulation targets. */
export interface SynthKit {
  params: number[];
  /** LFO target per voice (PAR_* number, 0 = none) */
  lfoTarget: number[];
  /** velocity modulation target per voice */
  velTarget: number[];
}

/** A complete kit: the synthesis kit and every track's sound source. */
export interface Kit {
  name: string;
  seed: number;
  seedText?: string;
  synth: SynthKit;
  sounds: Record<string, TrackSound>;
}

export interface SoundLocks {
  /** voices protected from GENERATE KIT / MUTATE KIT / EVOLVE */
  voices: boolean[];
  /** parameters protected (PAR_* numbers) */
  params: number[];
}

/** TIMBRE: how much sound variation the sound generators introduce (0-1), and their seed. */
export interface TimbreSettings {
  amount: number;
  seed: number;
  /** the phrase that named the seed (absent: a plain number) */
  seedText?: string;
}

export type EvolveTarget = 'off' | 'rhythm' | 'sound' | 'both';

export interface EvolveSettings {
  /** what evolves on its own while playing */
  target: EvolveTarget;
  /** every n bars */
  every: number;
  /** strength 0-1 */
  amount: number;
  /** rhythm: pull back to the pattern after this many generations (0 = never) */
  returnEvery: number;
}

export type Quantize = 'step' | 'beat' | 'bar' | 'pattern';

export interface Snapshot {
  name: string;
  pattern: Pattern;
  synth: SynthKit;
  sounds: Record<string, TrackSound>;
  mix: Record<string, TrackMix>;
  play: Record<string, TrackPlay>;
  destruction: DestructionSettings;
  tempo: number;
  swing: number;
}

export interface ChainEntry {
  pattern: string;
  repeats: number;
}

export interface MasterSettings {
  volume: number;
  /** soft clipper on the master (protects against overs) */
  clip: boolean;
  /** Slop Factory Core output chain (plain JSON ChainConfig) */
  chain: unknown;
  /** bus processing, stereo width and the limiter (absent in older projects: none) */
  out?: OutputFx;
}

export interface Project {
  format: 'clatter-project';
  version: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
  /** the four performance macros 0-1 (absent: 0) */
  macros?: number[];
  name: string;
  tempo: number;
  /** tempo automation: a loop of tempo changes under the performance (absent in projects older than 0.4: none) */
  tempoAuto?: TempoAuto;
  /** swing 50-75 % */
  swing: number;
  /** the global scale (absent in projects older than 0.7: none; see src/music/scale.ts) */
  scale?: GlobalScale;
  /** the project seed (performance randomness) */
  seed: number;
  /** the phrase that named the project seed (absent: a plain number) */
  seedText?: string;
  /** the version of the phrase-to-number hash the phrases were made with (absent: 1; see src/rhythm/seed.ts) */
  seedHash?: number;
  /** the version of the generators that made the seeded material (absent: 1, the generators of every older project) */
  generator?: number;
  tracks: Track[];
  kit: { name: string; seed: number; seedText?: string; /** how GENERATE KIT made it (absent: unknown, an older project or a loaded kit) */ made?: KitMade; synth: SynthKit };
  /** the sample set the tracks' samples came from or were saved as (display; the samples themselves are on the tracks) */
  sampleSet?: string;
  soundLocks: SoundLocks;
  /** the candidate last applied to each voice from SOUND DISCOVERY (voice 0-5 → its name and the seed metadata that makes it again; record only) */
  discovered?: Record<number, DiscoveredSound>;
  patterns: Pattern[];
  current: string;
  chain: { on: boolean; entries: ChainEntry[] };
  gen: GenSettings;
  destruction: DestructionSettings;
  evolve: EvolveSettings;
  /** the sound generators' amount and seed */
  timbre: TimbreSettings;
  quantize: Quantize;
  /** the settings and seed of the last WILDCARD applied (record only; absent if none) */
  wildcard?: WildSettings;
  master: MasterSettings;
  snapshots: (Snapshot | null)[];
  notes: string;
}

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const clone = <T>(x: T): T => (x === undefined ? x : (JSON.parse(JSON.stringify(x)) as T));
