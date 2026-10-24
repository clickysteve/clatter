/**
 * CLATTER's data model.
 *
 * Three systems, kept apart:
 *   RHYTHM       what is played: patterns of hits per track (generated baseline + manual edits)
 *   SOUND        what makes the sound: the LXR kit (synthesis parameters) and each track's
 *                sound source (SYNTH, SAMPLE or HYBRID)
 *   DESTRUCTION  how rhythm (and sound, per hit) is transformed: CHOP, ROLLS, DESTROY
 *
 * The rhythm never names a sound: a hit belongs to a TRACK; the track decides what it plays.
 * The sound never knows which algorithm made a hit.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */

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

/** A pattern: the generated baseline plus the hand edits made over it. */
export interface Pattern {
  id: string;
  name: string;
  /** length in steps */
  steps: number;
  res: Resolution;
  /** baseline per track (generated, varied or captured) */
  gen: Record<string, Grid>;
  /** hand edits over the baseline: step → hit (placed or changed) or null (deleted) */
  edits: Record<string, Record<number, Hit | null>>;
  /** the seed and settings that made the baseline */
  seed: number;
  settings: GenSettings;
  /** how many VARIATIONs / MUTATEs led here (display) */
  generation: number;
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
  synth: SynthKit;
  sounds: Record<string, TrackSound>;
}

export interface SoundLocks {
  /** voices protected from GENERATE KIT / MUTATE KIT / EVOLVE */
  voices: boolean[];
  /** parameters protected (PAR_* numbers) */
  params: number[];
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
}

export interface Project {
  format: 'clatter-project';
  version: 1;
  name: string;
  tempo: number;
  /** swing 50-75 % */
  swing: number;
  /** the project seed (performance randomness) */
  seed: number;
  tracks: Track[];
  kit: { name: string; seed: number; synth: SynthKit };
  soundLocks: SoundLocks;
  patterns: Pattern[];
  current: string;
  chain: { on: boolean; entries: ChainEntry[] };
  gen: GenSettings;
  destruction: DestructionSettings;
  evolve: EvolveSettings;
  quantize: Quantize;
  master: MasterSettings;
  snapshots: (Snapshot | null)[];
  notes: string;
}

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const clone = <T>(x: T): T => (x === undefined ? x : (JSON.parse(JSON.stringify(x)) as T));
