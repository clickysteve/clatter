/**
 * Project files: JSON text, validated and repaired on load (missing fields filled from the
 * defaults, values clamped, unknown fields dropped), so an old, hand-edited or damaged file
 * opens rather than breaking the instrument. Samples are referenced by their content id
 * (SHA-256); a bundle (.clatter.zip, Slop Factory Core's bundle format) carries the audio.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import { defaultMix, defaultPlay, defaultProject, defaultSound, defaultTracks, emptySynthKit } from './defaults';
import { clamp, MAX_PATTERNS, MAX_STEPS, MAX_TRACKS, RESOLUTIONS, ROLES, ROLL_SPEEDS, SNAPSHOTS, VARIATION_SLOTS, type Grid, type Hit, type Pattern, type PitchMeasure, type Project, type SlotMeasure, type TrackPitch, type Resolution, type Role, type SynthKit, type Track } from './types';
import { defaultGen } from '../rhythm/generate';
import { STYLES } from '../rhythm/styles';
import { defaultChop } from '../destruction/chop';
import { defaultRolls } from '../destruction/rolls';
import { defaultDestroy } from '../destruction/destroy';
import { SOUND_PARAM_COUNT } from '../sound/lxrParamIds';
import { repairStepSound, repairVariation, soundSampleIds } from '../sound/stepSound';
import { repairMod } from '../mod/config';
import { repairTrig } from '../rhythm/trigger';
import { repairWild } from '../destruction/wildcardProject';
import { checkedSeedText, GENERATOR_VERSION, SEED_HASH_VERSION } from '../rhythm/seed';
import { repairTempoAuto } from '../transport/tempo';
import { repairOrigin } from '../sound/soundLibrary';
import { repairChannelFx, repairOutputFx } from '../audio/mixfx';
import { repairGlobalScale, repairTrackScale } from '../music/scale';

export const PROJECT_FORMAT = 'clatter-project';
export const PROJECT_EXT = '.clatter.json';
export const BUNDLE_EXT = '.clatter.zip';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown, d: number, lo = -Infinity, hi = Infinity): number => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : d);
const int = (v: unknown, d: number, lo: number, hi: number): number => Math.round(num(v, d, lo, hi));
const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d);
const str = (v: unknown, d: string, max = 64): string => (typeof v === 'string' ? v.slice(0, max) : d);
const oneOf = <T extends string | number>(v: unknown, list: readonly T[], d: T): T => (list.includes(v as T) ? (v as T) : d);

export class ProjectError extends Error {}

export function serialize(p: Project): string {
  return JSON.stringify(p);
}

function repairHit(v: unknown): Hit | null {
  if (!isObj(v)) return null;
  const h: Hit = { vel: int(v.vel, 100, 1, 127) };
  if (v.prob !== undefined) h.prob = int(v.prob, 100, 0, 100);
  if (h.prob === 100) delete h.prob;
  if (v.note !== undefined && v.note !== 0) h.note = int(v.note, 0, -24, 24);
  if (v.flam === true) h.flam = true;
  if (v.ratchet !== undefined && v.ratchet !== 1) h.ratchet = int(v.ratchet, 1, 1, 4);
  if (typeof v.sample === 'string') h.sample = v.sample.slice(0, 80);
  return h;
}

function repairGrid(v: unknown, steps: number): Grid {
  const a = Array.isArray(v) ? v : [];
  const g: Grid = new Array(steps).fill(null);
  for (let i = 0; i < steps; i++) g[i] = repairHit(a[i]);
  return g;
}

/** `{ seedText }` when the stored phrase still names the number, else nothing. */
function seedPart(seed: number, text: unknown, hash: number): { seedText?: string } {
  const t = checkedSeedText(seed, text, hash);
  return t ? { seedText: t } : {};
}

function repairPattern(v: unknown, trackIds: string[], i: number, seedHash: number): Pattern {
  const o = isObj(v) ? v : {};
  const patSeed = int(o.seed, 1, 0, 0xffffffff);
  const res = oneOf(o.res, RESOLUTIONS, 4) as Resolution;
  const steps = int(o.steps, 32, 1, MAX_STEPS);
  // before version 8 a pattern was a generated baseline (`gen`) with hand edits over it (`edits`):
  // the effective pattern is the baseline with each edit laid over it (null deletes)
  const grids: Record<string, Grid> = {};
  const og = isObj(o.grids) ? o.grids : isObj(o.gen) ? o.gen : {};
  const oe = isObj(o.grids) || !isObj(o.edits) ? {} : o.edits;
  for (const id of trackIds) {
    const g = repairGrid(og[id], steps);
    const e = oe[id];
    if (isObj(e)) {
      for (const [k, h] of Object.entries(e)) {
        const s = Number(k);
        if (Number.isInteger(s) && s >= 0 && s < steps) g[s] = h === null ? null : repairHit(h);
      }
    }
    grids[id] = g;
  }
  // step sounds (projects before version 2 have none)
  let sounds: Pattern['sounds'];
  if (isObj(o.sounds)) {
    for (const id of trackIds) {
      const e: unknown = (o.sounds as Obj)[id];
      if (!isObj(e)) continue;
      const out: Record<number, import('./types').StepSound> = {};
      for (const [k, ss] of Object.entries(e as Obj)) {
        const st = Number(k);
        const r = Number.isInteger(st) && st >= 0 && st < steps ? repairStepSound(ss) : undefined;
        if (r) out[st] = r;
      }
      if (Object.keys(out).length) (sounds ??= {})[id] = out;
    }
  }
  // trigger conditions (projects before version 4 have none: every step plays, as it always did)
  let trig: Pattern['trig'];
  if (isObj(o.trig)) {
    for (const id of trackIds) {
      const e: unknown = (o.trig as Obj)[id];
      if (!isObj(e)) continue;
      const out: Record<number, import('./types').TrigCond> = {};
      for (const [k, c] of Object.entries(e as Obj)) {
        const st = Number(k);
        const r = Number.isInteger(st) && st >= 0 && st < steps ? repairTrig(c) : null;
        if (r) out[st] = r;
      }
      if (Object.keys(out).length) (trig ??= {})[id] = out;
    }
  }
  const sg = isObj(o.settings) ? o.settings : {};
  const dg = defaultGen();
  return {
    id: str(o.id, `p${i + 1}`, 16),
    name: str(o.name, String.fromCharCode(65 + i), 12),
    steps,
    res,
    grids,
    seed: patSeed,
    ...seedPart(patSeed, o.seedText, seedHash),
    settings: {
      style: oneOf(sg.style, STYLES.map((s) => s.id), dg.style),
      density: num(sg.density, dg.density, 0, 1),
      complexity: num(sg.complexity, dg.complexity, 0, 1),
      variation: num(sg.variation, dg.variation, 0, 1),
      accent: num(sg.accent, dg.accent, 0, 1),
      fills: num(sg.fills, dg.fills, 0, 1),
      bars: int(sg.bars, dg.bars, 1, 8),
    },
    generation: int(o.generation, 0, 0, 1e6),
    ...(sounds ? { sounds } : {}),
    ...(trig ? { trig } : {}),
  };
}

export function repairKit(v: unknown, fallback?: SynthKit): SynthKit {
  const o = isObj(v) ? v : {};
  const base = fallback ?? emptySynthKit(SOUND_PARAM_COUNT);
  const params = Array.isArray(o.params) ? o.params : base.params;
  const out: SynthKit = { params: [], lfoTarget: [], velTarget: [] };
  for (let p = 0; p < SOUND_PARAM_COUNT; p++) out.params.push(int(params[p], base.params[p] ?? 0, 0, 127));
  for (let v2 = 0; v2 < 6; v2++) {
    out.lfoTarget.push(int((o.lfoTarget as unknown[] | undefined)?.[v2], 0, 0, SOUND_PARAM_COUNT - 1));
    out.velTarget.push(int((o.velTarget as unknown[] | undefined)?.[v2], 0, 0, SOUND_PARAM_COUNT - 1));
  }
  return out;
}

/** Sound variations of a track sound (absent in projects before version 2). */
function repairVariations(s: Obj): Pick<import('./types').TrackSound, 'variations' | 'soundLock'> {
  const out: Pick<import('./types').TrackSound, 'variations' | 'soundLock'> = {};
  if (Array.isArray(s.variations)) {
    const list = Array.from({ length: VARIATION_SLOTS }, (_, i) => repairVariation(s.variations![i as never]));
    if (list.some(Boolean)) out.variations = list;
  }
  if (s.soundLock === true) out.soundLock = true;
  return out;
}

function repairTrack(v: unknown, i: number, def: Track | undefined): Track {
  const o = isObj(v) ? v : {};
  const d = def ?? defaultTracks()[0]!;
  const s = isObj(o.sound) ? o.sound : {};
  const m = isObj(o.mix) ? o.mix : {};
  const pl = isObj(o.play) ? o.play : {};
  const midi = isObj(o.midi) ? o.midi : {};
  const ds = defaultSound(d.sound);
  return {
    id: str(o.id, `t${i + 1}`, 16),
    name: str(o.name, d.name, 12),
    role: oneOf(o.role, ROLES, d.role) as Role,
    sound: {
      mode: oneOf(s.mode, ['synth', 'sample', 'hybrid'] as const, ds.mode),
      trigger: int(s.trigger, ds.trigger, 0, 6),
      note: int(s.note, 60, 0, 127),
      synthLevel: num(s.synthLevel, ds.synthLevel, 0, 1),
      sampleLevel: num(s.sampleLevel, ds.sampleLevel, 0, 1),
      samples: Array.isArray(s.samples) ? s.samples.filter((x): x is string => typeof x === 'string').slice(0, 16) : [],
      pick: oneOf(s.pick, ['first', 'cycle', 'random', 'velocity'] as const, 'first'),
      start: num(s.start, 0, 0, 0.99),
      end: num(s.end, 1, 0.01, 1),
      tune: num(s.tune, 0, -24, 24),
      fine: num(s.fine, 0, -100, 100),
      gain: num(s.gain, 1, 0, 2),
      pan: num(s.pan, 0, -1, 1),
      reverse: bool(s.reverse, false),
      offsetMs: num(s.offsetMs, 0, -50, 50),
      choke: int(s.choke, ds.choke, 0, 4),
      ...(repairMod(s.mod) ? { mod: repairMod(s.mod) } : {}),
      ...repairVariations(s),
    },
    mix: {
      ...defaultMix(d.mix),
      volume: num(m.volume, d.mix.volume, 0, 1),
      pan: num(m.pan, d.mix.pan, -1, 1),
      mute: bool(m.mute, false),
      solo: bool(m.solo, false),
      route: oneOf(m.route, ['main', 'fx'] as const, d.mix.route),
      filter: num(m.filter, 0, -1, 1),
      ...(num(m.send, 0, 0, 1) > 0 ? { send: num(m.send, 0, 0, 1) } : {}),
      ...(repairChannelFx(m.fx) ? { fx: repairChannelFx(m.fx) } : {}),
    },
    play: { ...defaultPlay(), density: num(pl.density, 100, 0, 100), fill: num(pl.fill, 0, 0, 100), humanize: num(pl.humanize, 0, 0, 100), chance: num(pl.chance, 100, 0, 100), length: int(pl.length, 0, 0, MAX_STEPS) },
    midi: { channel: int(midi.channel, d.midi.channel, 1, 16), note: int(midi.note, d.midi.note, 0, 127) },
    lock: bool(o.lock, false),
    ...(repairTrackScale(o.scale) ? { scale: repairTrackScale(o.scale) } : {}),
    ...(repairTrackPitch(o.pitch) ? { pitch: repairTrackPitch(o.pitch) } : {}),
  };
}

const MEASURE_KINDS = ['stable', 'swept', 'inharmonic', 'unpitched', 'silent'] as const;

function repairMeasure(v: unknown): PitchMeasure | undefined {
  if (!isObj(v) || !MEASURE_KINDS.includes(v.kind as never) || typeof v.shape !== 'string') return undefined;
  const m: PitchMeasure = {
    kind: v.kind as PitchMeasure['kind'],
    conf: num(v.conf, 0, 0, 1),
    shape: v.shape.slice(0, 16),
    off: num(v.off, 0, -1000, 1000),
    at: num(v.at, 0, 0),
  };
  if (typeof v.hz === 'number' && Number.isFinite(v.hz) && v.hz > 1 && v.hz < 30000) m.hz = v.hz;
  if (isObj(v.adj) && typeof v.adj.target === 'number') m.adj = { target: int(v.adj.target, 60, 0, 127), cents: num(v.adj.cents, 0, -100, 100) };
  return m;
}

function repairSlotMeasure(v: unknown): SlotMeasure | null {
  if (!isObj(v)) return null;
  const synth = repairMeasure(v.synth);
  const sample = repairMeasure(v.sample);
  return synth || sample ? { ...(synth ? { synth } : {}), ...(sample ? { sample } : {}) } : null;
}

/** A track's scale measurements (absent in projects before version 7). */
function repairTrackPitch(v: unknown): TrackPitch | undefined {
  if (!isObj(v)) return undefined;
  const base = repairSlotMeasure(v.base);
  const vars = Array.isArray(v.vars) ? Array.from({ length: VARIATION_SLOTS }, (_, i) => repairSlotMeasure((v.vars as unknown[])[i])) : null;
  if (!base && !vars?.some(Boolean)) return undefined;
  return { ...(base ? { base } : {}), ...(vars?.some(Boolean) ? { vars } : {}) };
}

/** The record of what SOUND DISCOVERY applied to each voice (a damaged entry is dropped). */
function repairDiscovered(v: unknown): { discovered?: Record<number, import('./types').DiscoveredSound> } {
  if (!isObj(v)) return {};
  const out: Record<number, import('./types').DiscoveredSound> = {};
  for (const [k, x] of Object.entries(v)) {
    const voice = Number(k);
    if (!Number.isInteger(voice) || voice < 0 || voice > 5 || !isObj(x)) continue;
    const origin = repairOrigin(x.origin, voice);
    if (origin) out[voice] = { name: str(x.name, 'SOUND', 24), origin };
  }
  return Object.keys(out).length ? { discovered: out } : {};
}

/** A complete, valid project from parsed JSON (anything else throws ProjectError). */
export function repairProject(v: unknown, initKit?: SynthKit): Project {
  if (!isObj(v)) throw new ProjectError('This is not a CLATTER project.');
  if (v.format !== undefined && v.format !== PROJECT_FORMAT) throw new ProjectError(`This file is not a CLATTER project (${String(v.format)}).`);
  if (typeof v.version === 'number' && v.version > 8) throw new ProjectError('This project was saved by a newer version of CLATTER.');
  const d = defaultProject();
  const defs = defaultTracks();
  const rawTracks = Array.isArray(v.tracks) ? v.tracks.slice(0, MAX_TRACKS) : [];
  const tracks = (rawTracks.length ? rawTracks : defs).map((t, i) => repairTrack(t, i, defs[i]));
  // unique ids
  const seen = new Set<string>();
  tracks.forEach((t, i) => {
    if (seen.has(t.id)) t.id = `t${i + 1}x`;
    seen.add(t.id);
  });
  const ids = tracks.map((t) => t.id);
  const rawPatterns = Array.isArray(v.patterns) ? v.patterns.slice(0, MAX_PATTERNS) : [];
  const patterns = (rawPatterns.length ? rawPatterns : d.patterns).map((p, i) => repairPattern(p, ids, i, int(v.seedHash, SEED_HASH_VERSION, 1, 1e6)));
  const pids = new Set<string>();
  patterns.forEach((p, i) => {
    if (pids.has(p.id)) p.id = `p${i + 1}x`;
    pids.add(p.id);
  });
  const kit = isObj(v.kit) ? v.kit : {};
  const dest = isObj(v.destruction) ? v.destruction : {};
  const ch = isObj(dest.chop) ? dest.chop : {};
  const ro = isObj(dest.rolls) ? dest.rolls : {};
  const de = isObj(dest.destroy) ? dest.destroy : {};
  const dc = defaultChop();
  const dr = defaultRolls();
  const dd = defaultDestroy();
  const ev = isObj(v.evolve) ? v.evolve : {};
  const gen = isObj(v.gen) ? v.gen : {};
  const chain = isObj(v.chain) ? v.chain : {};
  const master = isObj(v.master) ? v.master : {};
  const locks = isObj(v.soundLocks) ? v.soundLocks : {};
  const dg = defaultGen();
  // seeds: the numbers are the truth (old projects have only numbers); a phrase is kept only while it still names its number
  const seedHash = int(v.seedHash, SEED_HASH_VERSION, 1, 1e6);
  const projectSeed = int(v.seed, 1, 0, 0xffffffff);
  const kitSeed = int(kit.seed, 0, 0, 0xffffffff);
  const timbreSeed = int(isObj(v.timbre) ? v.timbre.seed : undefined, 1, 0, 0xffffffff);
  const p: Project = {
    format: 'clatter-project',
    version: 8,
    name: str(v.name, 'UNTITLED', 40),
    tempo: num(v.tempo, d.tempo, 30, 300),
    ...(repairTempoAuto(v.tempoAuto) ? { tempoAuto: repairTempoAuto(v.tempoAuto) } : {}),
    swing: num(v.swing, 50, 50, 75),
    ...(repairGlobalScale(v.scale) ? { scale: repairGlobalScale(v.scale) } : {}),
    seed: projectSeed,
    ...seedPart(projectSeed, v.seedText, seedHash),
    seedHash,
    generator: int(v.generator, GENERATOR_VERSION, 1, 1e6),
    tracks,
    kit: { name: str(kit.name, 'KIT', 24), seed: kitSeed, ...seedPart(kitSeed, kit.seedText, seedHash), synth: repairKit(kit.synth, initKit) },
    ...(str(v.sampleSet, '', 24) ? { sampleSet: str(v.sampleSet, '', 24) } : {}),
    soundLocks: {
      voices: [0, 1, 2, 3, 4, 5].map((i) => bool((locks.voices as unknown[] | undefined)?.[i], false)),
      params: Array.isArray(locks.params) ? locks.params.filter((x): x is number => Number.isInteger(x) && x > 0 && x < SOUND_PARAM_COUNT) : [],
    },
    ...repairDiscovered(v.discovered),
    patterns,
    current: typeof v.current === 'string' && pids.has(v.current) ? v.current : patterns[0]!.id,
    chain: {
      on: bool(chain.on, false),
      entries: Array.isArray(chain.entries) ? chain.entries.filter(isObj).filter((e) => pids.has(String(e.pattern))).slice(0, 64).map((e) => ({ pattern: String(e.pattern), repeats: int(e.repeats, 1, 1, 16) })) : [],
    },
    gen: {
      style: oneOf(gen.style, STYLES.map((s) => s.id), dg.style),
      density: num(gen.density, dg.density, 0, 1),
      complexity: num(gen.complexity, dg.complexity, 0, 1),
      variation: num(gen.variation, dg.variation, 0, 1),
      accent: num(gen.accent, dg.accent, 0, 1),
      fills: num(gen.fills, dg.fills, 0, 1),
      bars: int(gen.bars, dg.bars, 1, 8),
    },
    destruction: {
      chop: { on: bool(ch.on, false), amount: num(ch.amount, dc.amount, 0, 1), slice: int(ch.slice, dc.slice, 1, 16), retrigger: num(ch.retrigger, dc.retrigger, 0, 1), take: int(ch.take, 0, 0, 1e6) },
      rolls: {
        on: bool(ro.on, false),
        prob: num(ro.prob, dr.prob, 0, 1),
        length: int(ro.length, dr.length, 2, 12),
        speed: oneOf(ro.speed, ROLL_SPEEDS, dr.speed),
        shape: oneOf(ro.shape, ['even', 'crescendo', 'decrescendo', 'human'] as const, dr.shape),
        place: oneOf(ro.place, ['phrase', 'accent', 'anywhere'] as const, dr.place),
        targets: Array.isArray(ro.targets) ? (ro.targets.filter((x) => ROLES.includes(x as Role)) as Role[]) : dr.targets,
        take: int(ro.take, 0, 0, 1e6),
      },
      destroy: {
        on: bool(de.on, false),
        amount: num(de.amount, dd.amount, 0, 1),
        stutter: num(de.stutter, dd.stutter, 0, 1),
        pitch: num(de.pitch, dd.pitch, 0, 1),
        reverse: num(de.reverse, dd.reverse, 0, 1),
        gate: num(de.gate, dd.gate, 0, 1),
        crush: num(de.crush, dd.crush, 0, 1),
        skip: num(de.skip, dd.skip, 0, 1),
        take: int(de.take, 0, 0, 1e6),
      },
    },
    evolve: { target: oneOf(ev.target, ['off', 'rhythm', 'sound', 'both'] as const, 'off'), every: int(ev.every, 4, 1, 64), amount: num(ev.amount, 0.3, 0, 1), returnEvery: int(ev.returnEvery, 4, 0, 64) },
    timbre: { amount: num(isObj(v.timbre) ? v.timbre.amount : undefined, 0.5, 0, 1), seed: timbreSeed, ...seedPart(timbreSeed, isObj(v.timbre) ? v.timbre.seedText : undefined, seedHash) },
    quantize: oneOf(v.quantize, ['step', 'beat', 'bar', 'pattern'] as const, 'bar'),
    ...(isObj(v.wildcard) ? { wildcard: repairWild(v.wildcard) } : {}),
    master: { volume: num(master.volume, 0.8, 0, 1), clip: bool(master.clip, true), chain: master.chain ?? null, ...(repairOutputFx(master.out) ? { out: repairOutputFx(master.out) } : {}) },
    ...(Array.isArray(v.macros) ? { macros: [0, 1, 2, 3].map((i) => num((v.macros as unknown[])[i], 0, 0, 1)) } : {}),
    snapshots: new Array(SNAPSHOTS).fill(null),
    notes: str(v.notes, '', 4000),
  };
  // snapshots: stored whole; repaired through the same functions
  if (Array.isArray(v.snapshots)) {
    v.snapshots.slice(0, SNAPSHOTS).forEach((s, i) => {
      if (!isObj(s)) return;
      try {
        const sp = repairProject({ ...v, snapshots: [], patterns: [s.pattern], kit: { synth: s.synth }, tracks: tracks.map((t) => ({ ...t, sound: (s.sounds as Obj | undefined)?.[t.id] ?? t.sound, mix: (s.mix as Obj | undefined)?.[t.id] ?? t.mix, play: (s.play as Obj | undefined)?.[t.id] ?? t.play })), destruction: s.destruction, tempo: s.tempo, swing: s.swing }, initKit);
        p.snapshots[i] = {
          name: str(s.name, `SNAP ${i + 1}`, 16),
          pattern: sp.patterns[0]!,
          synth: sp.kit.synth,
          sounds: Object.fromEntries(sp.tracks.map((t) => [t.id, t.sound])),
          mix: Object.fromEntries(sp.tracks.map((t) => [t.id, t.mix])),
          play: Object.fromEntries(sp.tracks.map((t) => [t.id, t.play])),
          destruction: sp.destruction,
          tempo: sp.tempo,
          swing: sp.swing,
        };
      } catch {
        /* a damaged snapshot is dropped */
      }
    });
  }
  return p;
}

export function parseProject(text: string, initKit?: SynthKit): Project {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new ProjectError('The file is not valid JSON.');
  }
  return repairProject(v, initKit);
}

/** Every sample id a project refers to. */
export function projectSamples(p: Project): string[] {
  const ids = new Set<string>();
  for (const t of p.tracks) for (const s of soundSampleIds(t.sound)) ids.add(s);
  for (const g of p.patterns.flatMap((pt) => Object.values(pt.grids))) for (const h of g) if (h?.sample) ids.add(h.sample);
  for (const s of p.snapshots) if (s) for (const snd of Object.values(s.sounds)) for (const id of soundSampleIds(snd)) ids.add(id);
  return [...ids];
}
