/**
 * The three kinds of kit, and who owns what.
 *
 *   SYNTH KIT   the LXR synthesis state: every sound parameter and modulation target, the FX bus
 *               (all in `project.kit.synth`), each track's voice assignment (trigger, note) and its
 *               variations' parameter overrides. File: `.clattersynth.json`.
 *   SAMPLE SET  which samples each track plays and how (tune, gain, pan, reverse, region, pick).
 *               A Slop Factory Core kit; see src/samples/sets.ts. File: `.kit.zip`.
 *   FULL KIT    both, plus what joins them: each track's source mode (SYNTH, SAMPLE, HYBRID), the
 *               HYBRID balance and alignment, choke groups, the samples variations override, and
 *               the mixer. It is a Core kit whose `ext.clatter` carries the rest, so any Slop
 *               Factory application opens it as a plain sample set. File: `.kit.zip`.
 *
 * Every setting has one owner. A synth kit never writes sample fields and a sample set never
 * writes synth fields; a full kit is exactly the two together plus the joining fields, so loading
 * it reproduces the sound and loading either half alone cannot disturb the other.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import { SAMPLE_ID, type KitData, type KitInstrument } from '@slopfactory/core/kits';
import { defaultSound } from './defaults';
import { repairKit } from './project';
import { ROLE_LABEL, ROLES, VARIATION_SLOTS, clamp, clone, type Kit, type Project, type Role, type SampleOverrides, type SourceMode, type SynthKit, type TrackMix, type TrackSound, type Variation } from './types';
import { repairVariation } from '../sound/stepSound';
import { CLATTER_EXT, CORE_ROLE, SET_SCHEMA, clatterExt } from '../samples/sets';

export const SYNTH_KIT_FORMAT = 'clatter-synth-kit';
export const SYNTH_KIT_VERSION = 1;
export const SYNTH_KIT_EXT = '.clattersynth.json';
export const FULL_KIT_SCHEMA = 1;
/** role of the extra instrument that carries samples only variations use, so a full kit file has their audio */
export const VARIATION_ROLE = 'clatter:variation-samples';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown, d: number, lo: number, hi: number): number => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : d);
const name24 = (v: unknown, d: string): string => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 24) : d);

// ---------------------------------------------------------------- synth kit
/** one voice assignment: which LXR voice a track of this role plays, and its variations' parameters */
export interface VoiceConfig {
  trigger: number;
  note: number;
  variations?: (Variation | null)[];
}
export interface SynthKitData {
  name: string;
  seed: number;
  synth: SynthKit;
  /** by track role */
  voices: Record<string, VoiceConfig>;
}

/** the first track of each role: the one a kit speaks for */
const firstOfRole = (p: Project) => ROLES.map((r) => p.tracks.find((t) => t.role === r)).filter((t): t is Project['tracks'][number] => !!t);

const withoutSample = (v: Variation | null): Variation | null => {
  if (!v) return null;
  const { sample: _s, ...rest } = v;
  void _s;
  return clone(rest);
};

export function synthKitOf(p: Project): SynthKitData {
  const voices: Record<string, VoiceConfig> = {};
  for (const t of firstOfRole(p)) {
    voices[t.role] = { trigger: t.sound.trigger, note: t.sound.note, ...(t.sound.variations ? { variations: t.sound.variations.map(withoutSample) } : {}) };
  }
  return { name: p.kit.name, seed: p.kit.seed, synth: clone(p.kit.synth), voices };
}

/**
 * Write a kit's voice assignments and variation parameters onto the tracks. A variation's
 * sample-layer overrides belong to the sample half, so they stay where they are. The LXR
 * parameters themselves are applied by the application (the engine needs the difference).
 */
export function applyVoices(p: Project, voices: Record<string, VoiceConfig>): string[] {
  const changed: string[] = [];
  for (const t of p.tracks) {
    const v = voices[t.role];
    if (!v) continue;
    t.sound.trigger = v.trigger;
    t.sound.note = v.note;
    if (v.variations) {
      const prev = t.sound.variations ?? [];
      const next: (Variation | null)[] = Array.from({ length: VARIATION_SLOTS }, (_, i) => {
        const incoming = v.variations![i] ? clone(v.variations![i]!) : null;
        const own = prev[i]?.sample;
        if (incoming) return own ? { ...incoming, sample: own } : incoming;
        return own ? { name: prev[i]!.name, params: {}, sample: own } : null;
      });
      if (next.some(Boolean)) t.sound.variations = next;
      else delete t.sound.variations;
    }
    changed.push(t.name);
  }
  return changed;
}

function repairVoices(v: unknown): Record<string, VoiceConfig> {
  const out: Record<string, VoiceConfig> = {};
  if (!isObj(v)) return out;
  for (const r of ROLES) {
    const o = v[r];
    if (!isObj(o)) continue;
    const cfg: VoiceConfig = { trigger: Math.round(num(o.trigger, 0, 0, 6)), note: Math.round(num(o.note, 60, 0, 127)) };
    if (Array.isArray(o.variations)) {
      const list = Array.from({ length: VARIATION_SLOTS }, (_, i) => withoutSample(repairVariation((o.variations as unknown[])[i])));
      if (list.some(Boolean)) cfg.variations = list;
    }
    out[r] = cfg;
  }
  return out;
}

export function repairSynthKit(v: unknown, init?: SynthKit): SynthKitData {
  const o = isObj(v) ? v : {};
  return { name: name24(o.name, 'KIT'), seed: Math.round(num(o.seed, 0, 0, 0xffffffff)), synth: repairKit(o.synth, init), voices: repairVoices(o.voices) };
}

export function serializeSynthKit(k: SynthKitData): string {
  return JSON.stringify({ format: SYNTH_KIT_FORMAT, version: SYNTH_KIT_VERSION, ...k }, null, 1);
}

/** A synth kit from a file's text (anything else throws an Error with a message for the user). */
export function parseSynthKit(text: string, init?: SynthKit): SynthKitData {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new Error('This file is not valid JSON.');
  }
  if (!isObj(v) || v.format !== SYNTH_KIT_FORMAT) throw new Error('This is not a CLATTER synth kit.');
  if (typeof v.version === 'number' && v.version > SYNTH_KIT_VERSION) throw new Error('This synth kit was saved by a newer version of CLATTER.');
  return repairSynthKit(v, init);
}

// ---------------------------------------------------------------- full kit
/** what a track's source needs besides its voice and its samples */
export interface SourceConfig {
  mode: SourceMode;
  synthLevel: number;
  sampleLevel: number;
  offsetMs: number;
  choke: number;
  soundLock?: boolean;
  /** the samples each variation slot overrides (the audio travels in the kit's VARIATION_ROLE instrument) */
  variationSamples?: (SampleOverrides | null)[];
}
export type MixConfig = Pick<TrackMix, 'volume' | 'pan' | 'route' | 'filter'>;

/** CLATTER's data in a full kit's `ext.clatter` */
export interface FullKitExt {
  schema: number;
  kind: 'full-kit';
  synth: SynthKitData;
  sources: Record<string, SourceConfig>;
  /** absent for kits from before the mixer travelled with kits: the mixer is left alone */
  mix?: Record<string, MixConfig>;
}

export function sourcesOf(sounds: Record<string, TrackSound>): Record<string, SourceConfig> {
  const out: Record<string, SourceConfig> = {};
  for (const [role, s] of Object.entries(sounds)) {
    const vs = s.variations?.map((v) => (v?.sample ? clone(v.sample) : null));
    out[role] = { mode: s.mode, synthLevel: s.synthLevel, sampleLevel: s.sampleLevel, offsetMs: s.offsetMs, choke: s.choke, ...(s.soundLock ? { soundLock: true } : {}), ...(vs?.some(Boolean) ? { variationSamples: vs } : {}) };
  }
  return out;
}

const variationSampleIds = (sources: Record<string, SourceConfig>): string[] => [...new Set(Object.values(sources).flatMap((s) => (s.variationSamples ?? []).flatMap((o) => o?.samples ?? [])))].filter((id) => SAMPLE_ID.test(id));

/** Assemble a full kit: the sample set's instruments plus CLATTER's joining data. */
export function fullKitOf(p: Project, name: string, set: { instruments: KitInstrument[]; ext: Record<string, unknown> }): KitData {
  const sounds: Record<string, TrackSound> = {};
  for (const t of firstOfRole(p)) sounds[t.role] = t.sound;
  const sources = sourcesOf(sounds);
  const mix: Record<string, MixConfig> = {};
  for (const t of firstOfRole(p)) mix[t.role] = { volume: t.mix.volume, pan: t.mix.pan, route: t.mix.route, filter: t.mix.filter };
  const extra = variationSampleIds(sources);
  const instruments = [...set.instruments, ...(extra.length ? [{ role: VARIATION_ROLE, label: 'VARIATION SAMPLES', samples: extra.map((sample) => ({ sample })) }] : [])];
  const ext: FullKitExt = { schema: FULL_KIT_SCHEMA, kind: 'full-kit', synth: synthKitOf(p), sources, mix };
  return { name, instruments, ext: { ...set.ext, [CLATTER_EXT]: ext } };
}

function repairOverrides(v: unknown): SampleOverrides | null {
  const r = repairVariation({ name: '', params: {}, sample: v });
  return r?.sample ?? null;
}

function repairSources(v: unknown): Record<string, SourceConfig> {
  const out: Record<string, SourceConfig> = {};
  if (!isObj(v)) return out;
  const ds = defaultSound();
  for (const r of ROLES) {
    const o = v[r];
    if (!isObj(o)) continue;
    const vs = Array.isArray(o.variationSamples) ? Array.from({ length: VARIATION_SLOTS }, (_, i) => repairOverrides((o.variationSamples as unknown[])[i])) : undefined;
    out[r] = {
      mode: o.mode === 'sample' || o.mode === 'hybrid' || o.mode === 'synth' ? o.mode : ds.mode,
      synthLevel: num(o.synthLevel, ds.synthLevel, 0, 1),
      sampleLevel: num(o.sampleLevel, ds.sampleLevel, 0, 1),
      offsetMs: num(o.offsetMs, 0, -50, 50),
      choke: Math.round(num(o.choke, 0, 0, 4)),
      ...(o.soundLock === true ? { soundLock: true } : {}),
      ...(vs?.some(Boolean) ? { variationSamples: vs } : {}),
    };
  }
  return out;
}

/** The full-kit data of a kit, or null if it is a plain sample set. `newer`: written by a later CLATTER. */
export function fullKitExtOf(kit: Pick<KitData, 'ext'>, init?: SynthKit): { full: FullKitExt | null; newer: boolean } {
  const { data, newer } = clatterExt(kit.ext);
  if (!data || data.kind !== 'full-kit') return { full: null, newer };
  const mix: Record<string, MixConfig> | undefined = isObj(data.mix)
    ? Object.fromEntries(
        ROLES.flatMap((r) => {
          const m = (data.mix as Obj)[r];
          return isObj(m) ? [[r, { volume: num(m.volume, 0.8, 0, 1), pan: num(m.pan, 0, -1, 1), route: m.route === 'fx' ? 'fx' : 'main', filter: num(m.filter, 0, -1, 1) } as MixConfig]] : [];
        }),
      )
    : undefined;
  return { full: { schema: Number(data.schema) || 1, kind: 'full-kit', synth: repairSynthKit(data.synth, init), sources: repairSources(data.sources), ...(mix ? { mix } : {}) }, newer: false };
}

/** Write the joining data of a full kit onto the tracks: source modes, hybrid balance, variation samples, mixer. */
export function applyJoin(p: Project, full: FullKitExt, available: (id: string) => boolean): void {
  for (const t of p.tracks) {
    const s = full.sources[t.role];
    if (s) {
      t.sound.mode = s.mode;
      t.sound.synthLevel = s.synthLevel;
      t.sound.sampleLevel = s.sampleLevel;
      t.sound.offsetMs = s.offsetMs;
      t.sound.choke = s.choke;
      if (s.soundLock) t.sound.soundLock = true;
      else delete t.sound.soundLock;
      if (s.variationSamples) {
        const vars = t.sound.variations ?? [];
        s.variationSamples.forEach((o, i) => {
          if (!o) return;
          const ov = clone(o);
          if (ov.samples) ov.samples = ov.samples.filter(available);
          const cur = vars[i] ?? { name: '', params: {} };
          vars[i] = { ...cur, sample: ov };
        });
        t.sound.variations = Array.from({ length: VARIATION_SLOTS }, (_, i) => vars[i] ?? null);
      }
    }
    const m = full.mix?.[t.role];
    if (m) Object.assign(t.mix, m);
  }
}

// ---------------------------------------------------------------- legacy kits (.clatterkit.zip)
/**
 * A `.clatterkit.zip` from before kits were split (synth parameters, and every track's whole
 * sound keyed by role) as a full kit, with the samples it names. Nothing in the old file is lost:
 * the old kit's meaning is exactly a full kit's.
 */
export function legacyToFullKit(old: Kit, nameOf: (id: string) => string | undefined): KitData {
  const instruments: KitInstrument[] = [];
  const sounds: Record<string, TrackSound> = {};
  const voices: Record<string, VoiceConfig> = {};
  for (const r of ROLES) {
    const s = old.sounds[r];
    if (!s) continue;
    const snd: TrackSound = { ...defaultSound(), ...s, samples: [...(s.samples ?? [])] };
    sounds[r] = snd;
    voices[r] = { trigger: snd.trigger, note: snd.note, ...(snd.variations ? { variations: snd.variations.map(withoutSample) } : {}) };
    snd.samples = snd.samples.filter((id) => SAMPLE_ID.test(id));
    if (snd.samples.length) {
      instruments.push({
        role: CORE_ROLE[r as Role],
        index: 0,
        label: ROLE_LABEL[r as Role],
        samples: snd.samples.map((id, i) => ({ sample: id, ...(nameOf(id) ? { name: nameOf(id) } : {}), ...(i === 0 ? { primary: true } : {}) })),
        selection: { first: 'fixed', cycle: 'roundrobin', random: 'random', velocity: 'velocity' }[snd.pick],
        ext: { [CLATTER_EXT]: { schema: SET_SCHEMA, tune: snd.tune, fine: snd.fine, gain: snd.gain, pan: snd.pan, reverse: snd.reverse, start: snd.start, end: snd.end, pick: snd.pick } },
      });
    }
  }
  const sources = sourcesOf(sounds);
  const extra = variationSampleIds(sources);
  if (extra.length) instruments.push({ role: VARIATION_ROLE, label: 'VARIATION SAMPLES', samples: extra.map((sample) => ({ sample })) });
  const ext: FullKitExt = { schema: FULL_KIT_SCHEMA, kind: 'full-kit', synth: { name: old.name, seed: old.seed, synth: old.synth, voices }, sources };
  return { name: old.name, instruments, ext: { [CLATTER_EXT]: ext } };
}
