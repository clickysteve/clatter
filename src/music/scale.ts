/**
 * Musical scales: the one definition every part of CLATTER shares (the global scale, a track's
 * own scale, scale-aware generation and variations, the TUNER and the kit exporter).
 *
 * A scale is a ROOT (a pitch class, 0 = C) and a TYPE. A type is a set of semitone steps from
 * the root; the USER type is a set the player draws (a 12-bit mask, bit 0 = the root). Notes are
 * MIDI numbers (60 = C4, 69 = A4), the same convention as the TUNER.
 *
 * Quantising a pitch means moving it to the nearest note of the scale. The tie between two
 * equally near notes goes to the lower one, so the result never depends on rounding noise.
 * Everything here is a pure function of its arguments.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */

/** How far the LXR oscillator FINE parameter moves the pitch per step (measured; the corrections of src/music/tuning.ts absorb the rest). */
export const FINE_CENTS_PER_STEP = 0.9;

export interface ScaleType {
  id: string;
  label: string;
  /** semitones above the root, ascending, 0 first */
  steps: number[];
  /** offered in the scale menus (the exporter also knows the others) */
  menu: boolean;
}

const S = (id: string, label: string, steps: number[], menu = true): ScaleType => ({ id, label, steps, menu });

/** The shared table. Order is the menu order; the USER type takes its steps from the mask. */
export const SCALE_TYPES: ScaleType[] = [
  S('chromatic', 'CHROMATIC', [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]),
  S('major', 'MAJOR', [0, 2, 4, 5, 7, 9, 11]),
  S('minor', 'NATURAL MINOR', [0, 2, 3, 5, 7, 8, 10]),
  S('harmonicMinor', 'HARMONIC MINOR', [0, 2, 3, 5, 7, 8, 11]),
  S('majorPentatonic', 'MAJOR PENTATONIC', [0, 2, 4, 7, 9]),
  S('minorPentatonic', 'MINOR PENTATONIC', [0, 3, 5, 7, 10]),
  S('dorian', 'DORIAN', [0, 2, 3, 5, 7, 9, 10]),
  S('phrygian', 'PHRYGIAN', [0, 1, 3, 5, 7, 8, 10]),
  S('lydian', 'LYDIAN', [0, 2, 4, 6, 7, 9, 11]),
  S('mixolydian', 'MIXOLYDIAN', [0, 2, 4, 5, 7, 9, 10]),
  S('wholeTone', 'WHOLE TONE', [0, 2, 4, 6, 8, 10]),
  S('user', 'USER', [0, 3, 5, 7, 10]),
  S('melodicMinor', 'MELODIC MINOR', [0, 2, 3, 5, 7, 9, 11], false),
  S('locrian', 'LOCRIAN', [0, 1, 3, 5, 6, 8, 10], false),
  S('blues', 'BLUES', [0, 3, 5, 6, 7, 10], false),
  S('diminished', 'DIMINISHED', [0, 2, 3, 5, 6, 8, 9, 11], false),
];

const BY_ID = new Map(SCALE_TYPES.map((s) => [s.id, s] as const));
export const isScaleType = (id: unknown): id is string => typeof id === 'string' && BY_ID.has(id);
export const scaleType = (id: string): ScaleType => BY_ID.get(id) ?? BY_ID.get('chromatic')!;

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

/** A scale as the rest of the code passes it around. `mask` matters only for the USER type. */
export interface ScaleSpec {
  /** pitch class of the root, 0-11 (0 = C) */
  root: number;
  type: string;
  /** USER: bit n set = the note n semitones above the root is in the scale */
  mask?: number;
}

export const ALL_STEPS = 0xfff;
/** The mask a new USER scale starts from: minor pentatonic. */
export const DEFAULT_USER_MASK = 0b010010101001;

export const pc = (n: number): number => ((Math.round(n) % 12) + 12) % 12;

export function maskOfSteps(steps: readonly number[]): number {
  let m = 0;
  for (const s of steps) m |= 1 << pc(s);
  return m;
}

/** The mask as semitone steps above the root, ascending. */
export function stepsOfMask(mask: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < 12; i++) if (mask & (1 << i)) out.push(i);
  return out;
}

/** A mask kept valid: 12 bits, at least one note (the root when the mask is empty). */
export function cleanMask(mask: unknown): number {
  const m = typeof mask === 'number' && Number.isFinite(mask) ? Math.round(mask) & ALL_STEPS : DEFAULT_USER_MASK;
  return m === 0 ? 1 : m;
}

/** The semitone steps above the root of a scale, ascending. */
export function scaleSteps(s: ScaleSpec): number[] {
  return s.type === 'user' ? stepsOfMask(cleanMask(s.mask)) : scaleType(s.type).steps;
}

/** The pitch classes of a scale as a 12-entry table indexed by pitch class (0 = C). */
export function pitchClasses(s: ScaleSpec): boolean[] {
  const out = new Array<boolean>(12).fill(false);
  for (const st of scaleSteps(s)) out[pc(s.root + st)] = true;
  return out;
}

/** Is this note (a MIDI number, rounded) in the scale? */
export function inScale(s: ScaleSpec, midi: number): boolean {
  return pitchClasses(s)[pc(midi)]!;
}

/**
 * The scale note nearest to a pitch given as a (fractional) MIDI number. A pitch exactly between
 * two notes goes to the lower one. Always returns a whole MIDI number.
 */
export function nearestInScale(s: ScaleSpec, midi: number): number {
  return nearestInMask(absMask(s), midi);
}

/** The scale as a mask of absolute pitch classes (bit 0 = C), for code that must not carry a spec around. */
export function absMask(s: ScaleSpec): number {
  const classes = pitchClasses(s);
  let m = 0;
  for (let i = 0; i < 12; i++) if (classes[i]) m |= 1 << i;
  return m;
}

/** `nearestInScale` for an absolute pitch-class mask. */
export function nearestInMask(mask: number, midi: number): number {
  const base = Math.round(midi);
  let best = base;
  let bestD = Infinity;
  for (let d = 0; d <= 12; d++) {
    for (const cand of d === 0 ? [base] : [base - d, base + d]) {
      if (!(mask & (1 << pc(cand)))) continue;
      const dist = Math.abs(cand - midi);
      if (dist < bestD - 1e-9 || (Math.abs(dist - bestD) <= 1e-9 && cand < best)) {
        best = cand;
        bestD = dist;
      }
    }
  }
  return best;
}

/** A sequencer offset snapped so `anchor + offset` is in the scale given as a mask (the engine's form of `quantiseOffset`). */
export const quantiseOffsetMask = (mask: number, anchor: number, offset: number): number => nearestInMask(mask, anchor + offset) - Math.round(anchor);

/** How far (in semitones, signed) a pitch must move to land on its nearest scale note. */
export const distanceToScale = (s: ScaleSpec, midi: number): number => nearestInScale(s, midi) - midi;

/**
 * A sequencer pitch offset, snapped so `anchor + offset` is a scale note. `anchor` is the pitch
 * the track plays at offset 0 (already a scale note once the track is tuned); the result is a
 * whole number of semitones.
 */
export function quantiseOffset(s: ScaleSpec, anchor: number, offset: number): number {
  return nearestInScale(s, anchor + offset) - Math.round(anchor);
}

/** The notes of the scale from `lo` to `hi` inclusive. */
export function notesInRange(s: ScaleSpec, lo: number, hi: number): number[] {
  const classes = pitchClasses(s);
  const out: number[] = [];
  for (let n = Math.max(0, Math.min(lo, hi)); n <= Math.min(127, Math.max(lo, hi)); n++) if (classes[pc(n)]) out.push(n);
  return out;
}

export const rootName = (root: number): string => NOTE_NAMES[pc(root)]!;

const SHORT: Record<string, string> = { chromatic: 'CHR', major: 'MAJ', minor: 'MIN', harmonicMinor: 'HMIN', majorPentatonic: 'PMAJ', minorPentatonic: 'PMIN', dorian: 'DOR', phrygian: 'PHR', lydian: 'LYD', mixolydian: 'MIX', wholeTone: 'WHL', user: 'USR', melodicMinor: 'MMIN', locrian: 'LOC', blues: 'BLU', diminished: 'DIM' };

/** "C MIN", "F# PMAJ": a tag that fits a track's row */
export const shortScale = (s: ScaleSpec): string => `${rootName(s.root)} ${SHORT[s.type] ?? s.type.toUpperCase()}`;

/** "C MINOR", "F# USER" */
export function describeScale(s: ScaleSpec): string {
  return `${rootName(s.root)} ${scaleType(s.type).label}`;
}

/** A scale to compare and store: the mask only counts for USER. */
export function normaliseScale(s: ScaleSpec): ScaleSpec {
  const root = pc(s.root);
  const type = isScaleType(s.type) ? s.type : 'chromatic';
  return type === 'user' ? { root, type, mask: cleanMask(s.mask) } : { root, type };
}

export const sameScale = (a: ScaleSpec, b: ScaleSpec): boolean => {
  const x = normaliseScale(a);
  const y = normaliseScale(b);
  return x.root === y.root && x.type === y.type && (x.mask ?? 0) === (y.mask ?? 0);
};

// ---------------------------------------------------------------------------- the project's settings

/** The global scale: one scale, switched on or off. */
export interface GlobalScale extends ScaleSpec {
  on: boolean;
}

export type TrackScaleMode = 'off' | 'global' | 'custom';
export const TRACK_SCALE_MODES: readonly TrackScaleMode[] = ['off', 'global', 'custom'];

/** A track's scale setting: OFF, follow the GLOBAL scale, or its own CUSTOM scale. */
export interface TrackScale extends ScaleSpec {
  mode: TrackScaleMode;
}

export const defaultGlobalScale = (): GlobalScale => ({ on: false, root: 0, type: 'minor' });
export const defaultTrackScale = (mode: TrackScaleMode = 'global'): TrackScale => ({ mode, root: 0, type: 'minor' });

/** Roles whose sound is a pitched tone by default; the rest (snares, claps, hats, cymbals) are not scale-locked until asked. */
export const PITCHED_ROLES: readonly string[] = ['kick', 'ltom', 'htom', 'perc'];
export const isPitchedRole = (role: string): boolean => PITCHED_ROLES.includes(role);

/** The mode a track has when it never was set: GLOBAL for a pitched role, OFF otherwise. */
export const defaultModeFor = (role: string): TrackScaleMode => (isPitchedRole(role) ? 'global' : 'off');

interface ScaleHolder {
  scale?: GlobalScale;
  tracks?: unknown;
}

export interface TrackScaleState {
  mode: TrackScaleMode;
  /** the scale actually in force (null: none) */
  spec: ScaleSpec | null;
  /** why there is none, or where the scale comes from */
  source: 'off' | 'global' | 'global-off' | 'custom';
}

/** The scale a track plays in: its mode applied to the project's global scale. */
export function trackScaleState(project: { scale?: GlobalScale }, track: { role: string; scale?: TrackScale }): TrackScaleState {
  const mode = track.scale?.mode ?? defaultModeFor(track.role);
  if (mode === 'off') return { mode, spec: null, source: 'off' };
  if (mode === 'custom') {
    const t = track.scale;
    return { mode, spec: t ? normaliseScale(t) : normaliseScale(defaultTrackScale('custom')), source: 'custom' };
  }
  const g = project.scale;
  if (!g || !g.on) return { mode, spec: null, source: 'global-off' };
  return { mode, spec: normaliseScale(g), source: 'global' };
}

export const trackScaleSpec = (project: ScaleHolder, track: { role: string; scale?: TrackScale }): ScaleSpec | null => trackScaleState(project, track).spec;

/** Repair a stored scale spec (loading a project). */
export function repairScaleSpec(v: unknown, fallback: ScaleSpec): ScaleSpec {
  const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  const root = typeof o.root === 'number' && Number.isFinite(o.root) ? pc(o.root) : fallback.root;
  const type = isScaleType(o.type) ? o.type : fallback.type;
  return type === 'user' ? { root, type, mask: cleanMask(o.mask ?? fallback.mask) } : { root, type };
}

export function repairGlobalScale(v: unknown): GlobalScale | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const d = defaultGlobalScale();
  const o = v as Record<string, unknown>;
  return { on: o.on === true, ...repairScaleSpec(o, d) };
}

export function repairTrackScale(v: unknown): TrackScale | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const mode = TRACK_SCALE_MODES.includes(o.mode as TrackScaleMode) ? (o.mode as TrackScaleMode) : 'global';
  return { mode, ...repairScaleSpec(o, defaultTrackScale()) };
}

/** Parse a root typed as "C", "f#", "Bb" or a pitch class number. */
export function parseRoot(text: string): number | null {
  const s = text.trim();
  if (/^\d+$/.test(s)) return Number(s) < 12 ? Number(s) : null;
  const m = /^([A-Ga-g])([#sSbB♯♭]?)$/.exec(s);
  if (!m) return null;
  const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1]!.toUpperCase() as 'C'];
  const acc = m[2]!;
  const shift = acc === '#' || acc === 's' || acc === 'S' || acc === '♯' ? 1 : acc === '' ? 0 : -1;
  return pc(base + shift);
}
