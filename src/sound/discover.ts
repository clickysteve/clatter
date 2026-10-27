/**
 * SOUND DISCOVERY, the pure part: eight candidate sounds for one LXR voice, made with the
 * generator and the mutation CLATTER already has (src/sound/kitgen.ts), and what it takes to
 * try one without touching the instrument.
 *
 *   generateCandidate   one candidate: the voice DESIGNED by the kit generator for the chosen
 *                       CHARACTER (its kit flavour), then drawn back towards the sound it
 *                       replaces by 1 - WILDNESS. Wildness 1 is a new voice, wildness .1 is
 *                       the same voice moved a little. Menus (waveforms, filter types) are
 *                       taken whole or left, never blended.
 *   mutateCandidate     MUTATE VOICE on a candidate: the kit mutation, WILDNESS as its amount.
 *   projectWith         the project as it would be with a candidate in place (a shallow copy:
 *                       the live project is never written to).
 *   applyToKit          the candidate written into a kit, parameter locks respected.
 *
 * A candidate is held by the semantic names of the voice's parameters (`Key`), not by PAR
 * numbers, so it can move to another voice (a kick candidate on a tom) and into the library.
 *
 * Everything is a function of its inputs. The same seed, character, wildness, voice, starting
 * sound and locks make the same eight candidates; each candidate keeps what it takes to be made
 * again (`origin`). Deterministic, no clocks, no browser.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import type { PitchAnalysis } from '../analysis/pitch';
import { destApplies } from '../mod/registry';
import type { ModPatch, TrackMod } from '../mod/types';
import { clamp, clone, type Project, type SampleOverrides, type SoundLocks, type SynthKit, type Track, type Variation } from '../model/types';
import { GENERATOR_VERSION, type SeedValue } from '../rhythm/seed';
import { hash32, Rng, SALT, strCode } from '../rhythm/rng';
import type { KitFlavour } from '../rhythm/styles';
import { archetypeFor, designVoice, isMenuKey, lfoTargetFor, mutateKit, voiceKeys, voiceRolesOf, type Archetype, type Key } from './kitgen';

/** Candidates per batch. */
export const DISCOVER_COUNT = 8;
/** Bump when the candidate generator changes what a seed means. */
export const DISCOVER_GENERATOR = 1;

export const CHARACTERS: { id: KitFlavour; label: string; hint: string }[] = [
  { id: 'machine', label: 'MACHINE', hint: 'clean, tight drum-machine voices' },
  { id: 'electro', label: 'ELECTRO', hint: '808-ish: long, round, a little FM' },
  { id: 'acoustic', label: 'ACOUSTIC', hint: 'shorter, drier, less FM' },
  { id: 'industrial', label: 'INDUSTRIAL', hint: 'driven, harsh, metallic' },
  { id: 'glitch', label: 'GLITCH', hint: 'short, crushed, FM-heavy' },
  { id: 'dub', label: 'DUB', hint: 'long decays and space' },
];
export const characterLabel = (c: KitFlavour): string => CHARACTERS.find((x) => x.id === c)?.label ?? c.toUpperCase();

export const WILDNESS_MIN = 0.05;
export const WILDNESS_DEFAULT = 0.6;
export const clampWildness = (w: number): number => clamp(Number.isFinite(w) ? w : WILDNESS_DEFAULT, WILDNESS_MIN, 1);

export type Values = Partial<Record<Key, number>>;

/** The sound of a voice with its modulation and variations, as far as they are not part of the kit. */
export interface SoundExtras {
  mod?: TrackMod;
  variations?: (VariationSketch | null)[];
}
/** A variation held by parameter names, so it can follow a candidate to another voice. */
export interface VariationSketch {
  name: string;
  values: Values;
  sample?: SampleOverrides;
  mod?: ModPatch;
}

/** What it takes to make a candidate again. */
export interface CandidateOrigin {
  kind: 'generated' | 'library';
  /** the batch seed (the seed field) and its phrase */
  seed: number;
  seedText?: string;
  /** slot 0-7 in the batch, and how many times that slot was drawn again */
  index: number;
  draw: number;
  character: KitFlavour;
  /** 5-100 */
  wildness: number;
  /** the voice it was made for, and the archetype that voice played */
  voice: number;
  archetype: Archetype;
  /** each MUTATE since: the seed it drew and the wildness it used */
  lineage: { seed: number; wildness: number }[];
  /** fingerprint of the voice it was drawn from (a different starting sound is a different batch) */
  from: string;
  /** DISCOVER_GENERATOR and GENERATOR_VERSION when it was made */
  generator: number;
  /** the library sound it came from */
  library?: string;
}

export interface Candidate {
  /** content hash: two candidates with the same sound have the same key */
  key: string;
  name: string;
  voice: number;
  values: Values;
  /** the voice's LFO and velocity modulation targets, by parameter name (null: none) */
  lfo: Key | null;
  vel: Key | null;
  origin: CandidateOrigin;
  extras?: SoundExtras;
}

// ---------------------------------------------------------------------------- reading and writing a voice
const keysOf = (voice: number): [Key, number][] => Object.entries(voiceKeys(voice)).filter((e): e is [Key, number] => e[1] !== undefined);

/** The parameter name for a firmware parameter on a voice, if it has one. */
export function keyOfPar(voice: number, par: number): Key | null {
  for (const [k, p] of keysOf(voice)) if (p === par) return k;
  return null;
}

/** The sound of one voice in a kit, by parameter name. */
export function voiceValues(kit: SynthKit, voice: number): Values {
  const out: Values = {};
  for (const [k, p] of keysOf(voice)) out[k] = kit.params[p] ?? 0;
  return out;
}

const fnv = (s: string): string => strCode(s).toString(36);

/** A short fingerprint of a voice's sound in a kit (what a batch was drawn from). */
export function voiceFingerprint(kit: SynthKit, voice: number): string {
  return fnv(JSON.stringify([voiceValues(kit, voice), kit.lfoTarget[voice] ?? 0, kit.velTarget[voice] ?? 0]));
}

export function candidateKey(c: Pick<Candidate, 'voice' | 'values' | 'lfo' | 'vel' | 'extras'>): string {
  return fnv(JSON.stringify([c.voice, Object.entries(c.values).sort(([a], [b]) => (a < b ? -1 : 1)), c.lfo, c.vel, c.extras ?? null]));
}

/**
 * The kit with the candidate's voice written in. A locked parameter keeps its value; returns what
 * was left alone. The input kit is not modified.
 */
export function applyToKit(kit: SynthKit, voice: number, c: Pick<Candidate, 'values' | 'lfo' | 'vel'>, locks?: Pick<SoundLocks, 'params'>): { kit: SynthKit; locked: number } {
  const next: SynthKit = { params: kit.params.slice(), lfoTarget: kit.lfoTarget.slice(), velTarget: kit.velTarget.slice() };
  const keys = voiceKeys(voice);
  const held = new Set(locks?.params ?? []);
  let locked = 0;
  for (const [k, v] of Object.entries(c.values) as [Key, number][]) {
    const p = keys[k];
    if (p === undefined) continue;
    if (held.has(p)) {
      if (next.params[p] !== v) locked++;
      continue;
    }
    next.params[p] = clamp(Math.round(v), 0, 127);
  }
  const target = (k: Key | null): number => (k ? (keys[k] ?? 0) : 0);
  if (!held.has(target(c.lfo))) next.lfoTarget[voice] = target(c.lfo);
  next.velTarget[voice] = target(c.vel);
  return { kit: next, locked };
}

// ---------------------------------------------------------------------------- extras (modulation, variations)
/** The modulation and variations of a track, held by name for the library. */
export function extrasOf(track: Track, voice: number): SoundExtras | undefined {
  const out: SoundExtras = {};
  const m = track.sound.mod;
  if (m && (Object.keys(m.sources).length || m.routes.length)) out.mod = clone(m);
  const vs = track.sound.variations;
  if (vs?.some(Boolean)) {
    out.variations = vs.map((v) => {
      if (!v) return null;
      const values: Values = {};
      for (const [p, val] of Object.entries(v.params)) {
        const k = keyOfPar(voice, Number(p));
        if (k) values[k] = val;
      }
      const s: VariationSketch = { name: v.name, values };
      if (v.sample) s.sample = clone(v.sample);
      if (v.mod) s.mod = clone(v.mod);
      return s;
    });
  }
  return out.mod || out.variations ? out : undefined;
}

/** A track's sound with extras written in for a voice: modulation that does not exist on the voice is left out. */
export function soundWithExtras(track: Track, voice: number, extras: SoundExtras): Track['sound'] {
  const sound = clone(track.sound);
  if (extras.mod) {
    const mod = clone(extras.mod);
    mod.routes = mod.routes.filter((r) => destApplies(r.dst, sound.mode, voice));
    sound.mod = mod;
  }
  if (extras.variations) {
    const keys = voiceKeys(voice);
    sound.variations = extras.variations.map((s): Variation | null => {
      if (!s) return null;
      const params: Record<number, number> = {};
      for (const [k, v] of Object.entries(s.values) as [Key, number][]) {
        const p = keys[k];
        if (p !== undefined) params[p] = v;
      }
      const v: Variation = { name: s.name, params };
      if (s.sample) v.sample = clone(s.sample);
      if (s.mod) v.mod = clone(s.mod);
      return v;
    });
  }
  return sound;
}

/**
 * The project with a candidate in place, for rendering or analysing it. Shares everything it does
 * not change with the live project (render and analysis clone before they touch anything); the
 * live project, its kit and its tracks are never written to.
 */
export function projectWith(p: Project, trackId: string, c: Candidate, withExtras: boolean): Project {
  const track = p.tracks.find((t) => t.id === trackId);
  if (!track) return p;
  const kit = applyToKit(p.kit.synth, c.voice, c, p.soundLocks).kit;
  const tracks = withExtras && c.extras ? p.tracks.map((t) => (t.id === trackId ? { ...t, sound: soundWithExtras(t, c.voice, c.extras!) } : t)) : p.tracks;
  return { ...p, tracks, kit: { ...p.kit, synth: kit } };
}

// ---------------------------------------------------------------------------- generation
export interface DiscoverOptions {
  voice: number;
  /** the archetype the voice plays (see `archetypeOf`) */
  archetype: Archetype;
  character: KitFlavour;
  /** 0.05-1 */
  wildness: number;
  locks: SoundLocks;
}

/** The archetype a voice plays, from the roles of the tracks that use it. */
export function archetypeOf(p: Project, voice: number): Archetype {
  return archetypeFor(voice, voiceRolesOf(p.tracks)[voice] ?? []);
}

/** The seed of one candidate. */
export const candidateSeed = (batch: number, voice: number, index: number, draw: number): number => hash32(batch, SALT.discover, voice, index, draw);

/** Candidate `index` of a batch (draw 0), or the same slot drawn again (draw 1, 2...). Pure. */
export function generateCandidate(base: SynthKit, seed: SeedValue, index: number, draw: number, o: DiscoverOptions): Candidate {
  const w = clampWildness(o.wildness);
  const rng = new Rng(candidateSeed(seed.seed, o.voice, index, draw));
  const cur = voiceValues(base, o.voice);
  const design = designVoice(o.voice, o.archetype, o.character, rng);
  const target = lfoTargetFor(o.voice, o.archetype, rng);
  const keys = voiceKeys(o.voice);
  const held = new Set(o.locks.params);
  const values: Values = { ...cur };
  for (const [k, d] of Object.entries(design.values) as [Key, number][]) {
    const p = keys[k];
    if (p === undefined || held.has(p)) continue;
    const c = cur[k];
    if (c === undefined) values[k] = d;
    else if (isMenuKey(o.archetype, k)) values[k] = rng.chance(w) ? d : c;
    else values[k] = clamp(Math.round(c + (d - c) * w), 0, 127);
  }
  const designLfo = (design.values.lfoDepth ?? 0) > 0;
  const lfoOn = (values.lfoDepth ?? 0) > 0;
  const lfo: Key | null = lfoOn ? (designLfo ? keyOfPar(o.voice, target) : (keyOfPar(o.voice, base.lfoTarget[o.voice] ?? 0) ?? keyOfPar(o.voice, target))) : null;
  const vel = keyOfPar(o.voice, base.velTarget[o.voice] ?? 0);
  const origin: CandidateOrigin = {
    kind: 'generated',
    seed: seed.seed,
    ...(seed.text ? { seedText: seed.text } : {}),
    index,
    draw,
    character: o.character,
    wildness: Math.round(w * 100),
    voice: o.voice,
    archetype: o.archetype,
    lineage: [],
    from: voiceFingerprint(base, o.voice),
    generator: DISCOVER_GENERATOR * 1000 + GENERATOR_VERSION,
  };
  const c = { voice: o.voice, values, lfo, vel };
  return { key: candidateKey(c), name: `${index + 1}${draw ? '.' + draw : ''}`, ...c, origin };
}

/** The eight candidates of a batch (the slots in `skip` are not made). */
export function generateBatch(base: SynthKit, seed: SeedValue, o: DiscoverOptions, skip: ReadonlySet<number> = new Set()): (Candidate | null)[] {
  return Array.from({ length: DISCOVER_COUNT }, (_, i) => (skip.has(i) ? null : generateCandidate(base, seed, i, 0, o)));
}

export interface MutateOptions {
  character: KitFlavour;
  wildness: number;
  locks: SoundLocks;
  /** the roles of the tracks using each voice (the archetype of the voice follows them) */
  voiceRoles: string[][];
  /** where the mutation sits in the candidate's lineage (the seed is drawn from it, so MUTATE is repeatable) */
  seed?: number;
}

/** The seed of a candidate's next mutation: a function of the candidate, so the same candidate always mutates the same way. */
export const mutationSeed = (c: Candidate): number => hash32(strCode(c.key), SALT.discoverMut, c.origin.lineage.length);

/** MUTATE on a candidate: the kit's mutation of this one voice. The original candidate is not modified. */
export function mutateCandidate(base: SynthKit, c: Candidate, o: MutateOptions): Candidate {
  const w = clampWildness(o.wildness);
  const seed = o.seed ?? mutationSeed(c);
  const kit0 = applyToKit(base, c.voice, c).kit;
  // the candidate itself is the starting sound; only parameter locks stand in the way
  const kit = mutateKit(kit0, { seed, flavour: o.character, voiceRoles: o.voiceRoles, locks: { voices: [false, false, false, false, false, false], params: o.locks.params }, amount: w, voices: [c.voice] });
  const values = voiceValues(kit, c.voice);
  const next = { voice: c.voice, values, lfo: c.lfo, vel: c.vel, ...(c.extras ? { extras: c.extras } : {}) };
  return {
    key: candidateKey(next),
    name: `${c.name.split('>')[0]}>${c.origin.lineage.length + 1}`,
    ...next,
    origin: { ...c.origin, character: o.character, lineage: [...c.origin.lineage, { seed, wildness: Math.round(w * 100) }] },
  };
}

/** Make a candidate again from what it remembers (generated candidates; a library sound is its own source). */
export function reproduce(base: SynthKit, origin: CandidateOrigin, locks: SoundLocks, voiceRoles: string[][]): Candidate | null {
  if (origin.kind !== 'generated') return null;
  let c = generateCandidate(base, { seed: origin.seed, ...(origin.seedText ? { text: origin.seedText } : {}) }, origin.index, origin.draw, { voice: origin.voice, archetype: origin.archetype, character: origin.character, wildness: origin.wildness / 100, locks });
  for (const m of origin.lineage) c = mutateCandidate(base, c, { character: origin.character, wildness: m.wildness / 100, locks, voiceRoles, seed: m.seed });
  return c;
}

// ---------------------------------------------------------------------------- pitch labels
/**
 * What to print for a candidate's measured pitch. A note only where the analysis found one it
 * trusts: unpitched, inharmonic, silent and low-confidence sounds are named for what they are.
 */
export function pitchBadge(a: PitchAnalysis | null | undefined): { text: string; reliable: boolean } {
  if (!a) return { text: '—', reliable: false };
  if (a.kind === 'silent') return { text: 'SILENT', reliable: false };
  if (a.kind === 'unpitched') return { text: 'NOISE', reliable: false };
  if (a.kind === 'inharmonic') return { text: 'INHARM', reliable: false };
  if (!a.fundamental || a.confidence < 0.4) return { text: 'NO NOTE', reliable: false };
  const cents = Math.round(a.fundamental.cents);
  const off = Math.abs(cents) >= 10 ? (cents > 0 ? '+' : '−') + Math.abs(cents) + 'C' : '';
  return { text: a.fundamental.note + (a.kind === 'swept' ? '↓' : '') + (off ? ' ' + off : ''), reliable: true };
}
