/**
 * Sample sets: the sample half of a kit.
 *
 * A SAMPLE SET is a Slop Factory Core kit (`slopfactory-kit`: instruments with samples, kept in
 * the shared kit library and moved between browsers as a `.kit.zip`). CLATTER adds, under the
 * `clatter` key of each instrument's `ext`, the playback settings a track needs (tune, gain,
 * pan, reverse, region, pick), and a schema number under the kit's own `ext.clatter`.
 *
 * What a set owns, per track: which samples it plays and how they play. What it never touches:
 * the LXR synthesis kit, the track's voice, HYBRID levels and alignment, the mixer, variations,
 * step sounds, parameter locks, conditions, patterns. Loading one changes only the tracks the set
 * has a sound for (and, when asked, clears the tracks it has none for).
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import { mapKit, type KitData, type KitInstrument, type KitMapping, type KitSampleRef, type KitTarget } from '@slopfactory/core/kits';
import { SAMPLE_ID } from '@slopfactory/core/kits';
import { clamp, type Project, type Role, type SamplePick, type Track } from '../model/types';

export const CLATTER_EXT = 'clatter';
/** the schema of CLATTER's data inside a kit's `ext.clatter` and its instruments' */
export const SET_SCHEMA = 1;
/** most samples one track plays */
export const MAX_TRACK_SAMPLES = 16;

/** CLATTER's track roles in Core's drum vocabulary */
export const CORE_ROLE: Record<Role, string> = {
  kick: 'kick',
  snare: 'snare',
  clap: 'clap',
  chat: 'hat-closed',
  ohat: 'hat-open',
  ltom: 'tom-low',
  htom: 'tom-high',
  cymbal: 'crash',
  perc: 'perc',
  fx: 'fx',
};
/** other roles a track takes when the set has none of its own */
const ACCEPTS: Record<Role, string[]> = {
  kick: [],
  snare: ['snare-ghost', 'rim'],
  clap: [],
  chat: ['hat-pedal'],
  ohat: [],
  ltom: ['tom-mid'],
  htom: ['tom-mid'],
  cymbal: ['ride'],
  perc: ['rim', 'cowbell', 'shaker', 'clave', 'conga'],
  fx: ['unassigned'],
};

/** The tracks as instruments a set can be mapped onto. */
export function targetsOf(p: Project): KitTarget[] {
  return p.tracks.map((t) => ({ id: t.id, role: CORE_ROLE[t.role], label: t.name, capacity: MAX_TRACK_SAMPLES, accepts: ACCEPTS[t.role] }));
}

/** the playback settings a set carries per track */
export interface SetSettings {
  tune: number;
  fine: number;
  gain: number;
  pan: number;
  reverse: boolean;
  start: number;
  end: number;
  pick: SamplePick;
}
export const NEUTRAL: SetSettings = { tune: 0, fine: 0, gain: 1, pan: 0, reverse: false, start: 0, end: 1, pick: 'first' };

const PICKS: SamplePick[] = ['first', 'cycle', 'random', 'velocity'];
const SELECTION: Record<SamplePick, string> = { first: 'fixed', cycle: 'roundrobin', random: 'random', velocity: 'velocity' };
const PICK_OF: Record<string, SamplePick> = { fixed: 'first', auto: 'first', roundrobin: 'cycle', random: 'random', weighted: 'random', velocity: 'velocity' };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const n = (v: unknown, d: number, lo: number, hi: number): number => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : d);

export const settingsOf = (t: Track): SetSettings => ({ tune: t.sound.tune, fine: t.sound.fine, gain: t.sound.gain, pan: t.sound.pan, reverse: t.sound.reverse, start: t.sound.start, end: t.sound.end, pick: t.sound.pick });

/** CLATTER's data in an object's `ext`, or null (absent, or of a newer schema: `newer` says which). */
export function clatterExt(ext: unknown): { data: Record<string, unknown> | null; newer: boolean } {
  const c = isObj(ext) ? ext[CLATTER_EXT] : undefined;
  if (!isObj(c)) return { data: null, newer: false };
  if (typeof c.schema === 'number' && c.schema > SET_SCHEMA) return { data: null, newer: true };
  return { data: c, newer: false };
}

/** The playback settings of an instrument: CLATTER's own, else what its selection suggests, else neutral. */
export function instrumentSettings(ins: KitInstrument): { settings: SetSettings; newer: boolean } {
  const { data, newer } = clatterExt(ins.ext);
  const pick = PICK_OF[ins.selection ?? ''] ?? 'first';
  if (!data) return { settings: { ...NEUTRAL, pick }, newer };
  const start = n(data.start, 0, 0, 0.99);
  const end = n(data.end, 1, 0.01, 1);
  return {
    newer,
    settings: {
      tune: Math.round(n(data.tune, 0, -24, 24)),
      fine: Math.round(n(data.fine, 0, -100, 100)),
      gain: n(data.gain, 1, 0, 2),
      pan: n(data.pan, 0, -1, 1),
      reverse: data.reverse === true,
      start: Math.min(start, end - 0.01),
      end: Math.max(end, start + 0.01),
      pick: PICKS.includes(data.pick as SamplePick) ? (data.pick as SamplePick) : pick,
    },
  };
}

/** Which of several tracks of one role this is (0 for the first). */
const occurrence = (p: Project, t: Track): number => p.tracks.filter((x) => x.role === t.role).indexOf(t);

/**
 * The tracks' samples as a set's instruments. `base` is the set last loaded or saved: its
 * instruments that no track here can play (a set from a bigger instrument) are kept, so saving
 * never loses what a set carried.
 */
export function captureSet(p: Project, nameOf: (id: string) => string | undefined, base: KitData | null): { instruments: KitInstrument[]; ext: Record<string, unknown> } {
  const instruments: KitInstrument[] = [];
  for (const t of p.tracks) {
    const ids = t.sound.samples.filter((id) => SAMPLE_ID.test(id));
    if (!ids.length) continue;
    const samples: KitSampleRef[] = ids.map((id, i) => ({ sample: id, ...(nameOf(id) ? { name: nameOf(id) } : {}), ...(i === 0 ? { primary: true } : {}) }));
    instruments.push({
      role: CORE_ROLE[t.role],
      index: occurrence(p, t),
      label: t.name,
      samples,
      selection: SELECTION[t.sound.pick],
      ext: { [CLATTER_EXT]: { schema: SET_SCHEMA, ...settingsOf(t) } },
    });
  }
  if (base) {
    const kept = mapKit(base, targetsOf(p)).unmapped.filter((u) => u.reason === 'no-target').map((u) => u.instrument);
    for (const k of kept) if (!instruments.includes(k)) instruments.push(k);
  }
  return { instruments, ext: { ...(base?.ext ?? {}), [CLATTER_EXT]: { schema: SET_SCHEMA, kind: 'sample-set' } } };
}

/** A cheap fingerprint of the sample half of the tracks, for UNSAVED. */
export function setSignature(p: Project): string {
  return p.tracks.map((t) => [t.id, t.sound.samples.join('+'), t.sound.pick, t.sound.start, t.sound.end, t.sound.tune, t.sound.fine, t.sound.gain, t.sound.pan, t.sound.reverse ? 1 : 0].join(':')).join('|');
}

export interface ApplyOptions {
  /** a track with a SYNTH source that receives samples becomes a SAMPLE track (default true) */
  synthToSample: boolean;
  /** tracks the set has no sound for: keep their samples (default) or clear them */
  emptyTracks: 'keep' | 'clear';
  /** whether a sample's audio can be played (in this browser) */
  available: (id: string) => boolean;
}
export const defaultApply = (available: (id: string) => boolean): ApplyOptions => ({ synthToSample: true, emptyTracks: 'keep', available });

/** What loading a set does to one track. */
export interface TrackPlan {
  track: string;
  name: string;
  /** the set's sample ids for this track (absent from the plan: the track keeps its own) */
  samples: string[] | null;
  settings: SetSettings | null;
  /** 'sample': becomes a SAMPLE track; 'synth': a SAMPLE track left with no sample goes back to SYNTH */
  mode: 'sample' | 'synth' | null;
  /** the set's samples whose audio is not in this browser */
  missing: string[];
}
export interface SetPlan {
  tracks: TrackPlan[];
  /** instruments of the set that no track plays */
  unmapped: string[];
  /** playback settings written by a newer CLATTER were left out */
  newer: boolean;
}

/** What loading `mapping` would do (nothing is changed). */
export function planSet(p: Project, mapping: KitMapping, opts: ApplyOptions): SetPlan {
  const plans = new Map<string, TrackPlan>();
  let newer = false;
  for (const m of mapping.mapped) {
    const t = p.tracks.find((x) => x.id === m.target.id);
    if (!t) continue;
    const want = m.samples.map((s) => s.sample);
    const have = want.filter((id) => opts.available(id));
    const missing = want.filter((id) => !opts.available(id));
    const a = instrumentSettings(m.instrument);
    newer ||= a.newer;
    const prior = plans.get(t.id);
    if (prior) {
      // two instruments for one track (several of a role): their samples play together as alternates
      prior.samples = [...new Set([...(prior.samples ?? []), ...have])].slice(0, MAX_TRACK_SAMPLES);
      prior.missing.push(...missing);
      continue;
    }
    plans.set(t.id, {
      track: t.id,
      name: t.name,
      samples: have.length ? have.slice(0, MAX_TRACK_SAMPLES) : null,
      settings: have.length ? a.settings : null,
      mode: have.length && t.sound.mode === 'synth' && opts.synthToSample ? 'sample' : null,
      missing,
    });
  }
  if (opts.emptyTracks === 'clear') {
    for (const target of mapping.empty) {
      const t = p.tracks.find((x) => x.id === target.id);
      if (t && t.sound.samples.length) plans.set(t.id, { track: t.id, name: t.name, samples: [], settings: null, mode: t.sound.mode === 'sample' ? 'synth' : null, missing: [] });
    }
  }
  const unmapped = mapping.unmapped.map((u) => u.instrument.label ?? u.instrument.role);
  return { tracks: p.tracks.map((t) => plans.get(t.id)).filter((x): x is TrackPlan => !!x), unmapped, newer };
}

/** Apply a plan to the project's tracks (a set's samples and playback settings, nothing else). */
export function applyPlan(p: Project, plan: SetPlan): void {
  for (const tp of plan.tracks) {
    const t = p.tracks.find((x) => x.id === tp.track);
    if (!t) continue;
    if (tp.samples) t.sound.samples = [...tp.samples];
    if (tp.settings) Object.assign(t.sound, tp.settings);
    if (tp.mode) t.sound.mode = tp.mode;
  }
}
