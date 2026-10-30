/**
 * SAMPLE FACTORY, the designing half: which LXR voice and recipe makes each kind of percussion
 * sound, how a batch of them is planned, and how one sound of a batch is drawn from a seed.
 *
 * Nothing new is synthesised here. A sound is a Candidate (src/sound/discover.ts): one LXR voice
 * designed by the kit generator (`designVoice`, src/sound/kitgen.ts) for a CHARACTER and a
 * WILDNESS, rendered by the real engine. What the factory adds is the plan and two controls:
 *
 *   VARIATION   how far each sound of a batch strays from the batch's anchor design. At 0 they
 *               are one sound; at 100 % every sound is its own design.
 *   DIVERSITY   how far apart the sounds must be once they are RENDERED (the redraw rule is in
 *               src/app/factory.ts, the distance in src/sound/sampleQc.ts).
 *
 * The 10 instruments share the LXR's six voices (two hats on one voice, two toms on two drum
 * voices, a clap on the snare voice, percussion and FX on spare drum voices). The factory renders
 * each on a track of its own in a private project, so the live kit and the live tracks are never
 * involved. Deterministic: the same seed, settings, instrument, serial number, draw and attempt
 * make the same sound.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import { defaultMix, defaultPlay, defaultSound } from '../model/defaults';
import { clamp, GM_NOTE, ROLE_LABEL, type Project, type Role, type SynthKit, type Track } from '../model/types';
import { GENERATOR_VERSION, type SeedValue } from '../rhythm/seed';
import { hash32, Rng, SALT } from '../rhythm/rng';
import type { KitFlavour } from '../rhythm/styles';
import { applyToKit, characterLabel, clampWildness, keyOfPar, voiceValues, type Candidate, type CandidateOrigin, type Values } from './discover';
import { designVoice, isMenuKey, lfoTargetFor, voiceKeys, type Archetype, type Key } from './kitgen';
import { analysePitch, type PitchAnalysis, type PitchKind } from '../analysis/pitch';
import { peakOf } from '../analysis/voiceAnalysis';
import { describeSound, measure, qcCheck, qcStatus, soundFeatures, wavePeaks, type QcFlag } from './sampleQc';
import { INSTRUMENTS, type Instrument } from './voiceScore';

/** Bump when the same seed and settings would make a different factory sound. */
export const FACTORY_GENERATOR = 1;

export type FactoryInstrument = Instrument | 'mixed';

export interface InstrumentSpec {
  id: Instrument;
  label: string;
  /** the file-name part (CLATTER_KICK_C2_001.wav) */
  short: string;
  /** the folder in a pack */
  folder: string;
  /** the LXR voices that can play it, in the order a batch uses them */
  voices: number[];
  /** the trigger of the voice (the open hat is trigger 6 on the hat voice) */
  trigger: (voice: number) => number;
  archetype: Archetype;
  role: Role;
}

const same = (v: number): number => v;
export const INSTRUMENT_SPECS: Record<Instrument, InstrumentSpec> = {
  kick: { id: 'kick', label: 'KICK', short: 'KICK', folder: 'KICK', voices: [0], trigger: same, archetype: 'kick', role: 'kick' },
  snare: { id: 'snare', label: 'SNARE', short: 'SNARE', folder: 'SNARE', voices: [3], trigger: same, archetype: 'snare', role: 'snare' },
  clap: { id: 'clap', label: 'CLAP', short: 'CLAP', folder: 'CLAP', voices: [3], trigger: same, archetype: 'clap', role: 'clap' },
  chat: { id: 'chat', label: 'CLOSED HAT', short: 'CHAT', folder: 'CLOSED_HAT', voices: [5], trigger: () => 5, archetype: 'hat', role: 'chat' },
  ohat: { id: 'ohat', label: 'OPEN HAT', short: 'OHAT', folder: 'OPEN_HAT', voices: [5], trigger: () => 6, archetype: 'hat', role: 'ohat' },
  ltom: { id: 'ltom', label: 'LOW TOM', short: 'LTOM', folder: 'LOW_TOM', voices: [1], trigger: same, archetype: 'tom', role: 'ltom' },
  htom: { id: 'htom', label: 'HIGH TOM', short: 'HTOM', folder: 'HIGH_TOM', voices: [2], trigger: same, archetype: 'tom', role: 'htom' },
  cymbal: { id: 'cymbal', label: 'CYMBAL', short: 'CYMBAL', folder: 'CYMBAL', voices: [4], trigger: same, archetype: 'cymbal', role: 'cymbal' },
  perc: { id: 'perc', label: 'PERCUSSION', short: 'PERC', folder: 'PERCUSSION', voices: [2, 1], trigger: same, archetype: 'perc', role: 'perc' },
  fx: { id: 'fx', label: 'FX', short: 'FX', folder: 'FX', voices: [1, 2], trigger: same, archetype: 'zap', role: 'fx' },
};

export const FACTORY_INSTRUMENTS: { id: FactoryInstrument; label: string }[] = [...INSTRUMENTS.map((id) => ({ id, label: INSTRUMENT_SPECS[id].label })), { id: 'mixed', label: 'MIXED' }];
export const instrumentLabel = (i: FactoryInstrument): string => (i === 'mixed' ? 'MIXED' : INSTRUMENT_SPECS[i].label);

// ---------------------------------------------------------------------------- settings
export const COUNT_CHOICES = [8, 16, 32, 64, 128] as const;
export const COUNT_MIN = 1;
export const COUNT_MAX = 256;
export const clampCount = (n: number): number => (Number.isFinite(n) ? Math.max(COUNT_MIN, Math.min(COUNT_MAX, Math.round(n))) : 16);
export const clampPct = (n: number, def: number): number => (Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : def);

export interface FactorySettings {
  instrument: FactoryInstrument;
  count: number;
  /** the kit generator's flavour */
  character: KitFlavour;
  /** 5-100 (percent, as the other WILDNESS controls) */
  wildness: number;
  /** 0-100: how far sounds stray from the batch's anchor design */
  variation: number;
  /** 0-100: how far apart sounds must be once rendered */
  diversity: number;
  seed: SeedValue;
}

export const FACTORY_DEFAULTS = { instrument: 'mixed' as FactoryInstrument, count: 32, variation: 70, diversity: 50 };

// ---------------------------------------------------------------------------- the plan
export interface PlanSlot {
  instrument: Instrument;
  /** 1-based number among the sounds of this instrument; part of the file name */
  serial: number;
  /** 1-based position in the batch: generation order */
  order: number;
}

/**
 * The slots of a batch. One instrument: its sounds in turn. MIXED: the ten instruments dealt in
 * a seeded order, a new order each round, so any count is as even as it can be.
 */
export function planBatch(s: Pick<FactorySettings, 'instrument' | 'count' | 'seed'>, firstSerial: Partial<Record<Instrument, number>> = {}): PlanSlot[] {
  const out: PlanSlot[] = [];
  const next: Partial<Record<Instrument, number>> = {};
  const serial = (i: Instrument): number => {
    const n = next[i] ?? firstSerial[i] ?? 1;
    next[i] = n + 1;
    return n;
  };
  const rng = new Rng(hash32(s.seed.seed, SALT.factoryMix));
  let deck: Instrument[] = [];
  for (let order = 1; order <= s.count; order++) {
    let instrument: Instrument;
    if (s.instrument === 'mixed') {
      if (!deck.length) {
        deck = INSTRUMENTS.slice();
        for (let i = deck.length - 1; i > 0; i--) {
          const j = rng.int(i + 1);
          [deck[i], deck[j]] = [deck[j]!, deck[i]!];
        }
      }
      instrument = deck.pop()!;
    } else instrument = s.instrument;
    out.push({ instrument, serial: serial(instrument), order });
  }
  return out;
}

// ---------------------------------------------------------------------------- designing a sound
/** The instruments whose sounds are measured for pitch: the others have no single fundamental to find, and the measurement is the slowest part of the factory. */
export const PITCHED: ReadonlySet<Instrument> = new Set<Instrument>(['kick', 'ltom', 'htom', 'perc', 'fx']);

export const instrumentIndex = (i: Instrument): number => INSTRUMENTS.indexOf(i);

/** The seed of one drawing of one sound. */
export const soundSeed = (batch: number, instrument: Instrument, serial: number, draw: number, attempt: number): number => hash32(batch, SALT.factory, instrumentIndex(instrument), serial, draw, attempt);

/** The voice an instrument's serial number plays on (percussion and FX alternate between two). */
export function voiceFor(instrument: Instrument, serial: number): number {
  const v = INSTRUMENT_SPECS[instrument].voices;
  return v[(serial - 1) % v.length]!;
}

export interface DesignInput {
  base: SynthKit;
  seed: SeedValue;
  instrument: Instrument;
  serial: number;
  draw: number;
  attempt: number;
  character: KitFlavour;
  /** 5-100 */
  wildness: number;
  /** 0-100 */
  variation: number;
}

/**
 * One sound of a batch. Two designs are made by the kit generator for the voice: the batch's
 * ANCHOR (the same for every sound of the instrument in this batch) and the sound's OWN. VARIATION
 * is how much of the way from the anchor to its own design the sound goes (a menu such as a
 * waveform is taken whole, with that probability). Parameters the generator does not set keep the
 * starting kit's values.
 */
export function designSound(i: DesignInput): Candidate {
  const spec = INSTRUMENT_SPECS[i.instrument];
  const voice = voiceFor(i.instrument, i.serial);
  const w = clampWildness(i.wildness / 100);
  const v = clamp(i.variation, 0, 100) / 100;
  const seed = soundSeed(i.seed.seed, i.instrument, i.serial, i.draw, i.attempt);
  const rng = new Rng(seed);
  const own = designVoice(voice, spec.archetype, i.character, rng, w);
  const anchor = designVoice(voice, spec.archetype, i.character, new Rng(hash32(i.seed.seed, SALT.factoryAnchor, instrumentIndex(i.instrument), voice)), w);
  const keys = voiceKeys(voice);
  const cur = voiceValues(i.base, voice);
  const values: Values = { ...cur };
  for (const [k, d] of Object.entries(own.values) as [Key, number][]) {
    if (keys[k] === undefined) continue;
    const a = anchor.values[k];
    if (a === undefined || v >= 1) values[k] = d;
    else if (isMenuKey(own.archetype, k)) values[k] = rng.chance(v) ? d : a;
    else values[k] = clamp(Math.round(a + (d - a) * v), 0, 127);
  }
  // the LFO target belongs to the design the LFO came from
  const lfoOn = (values.lfoDepth ?? 0) > 0;
  const lfo: Key | null = lfoOn ? keyOfPar(voice, lfoTargetFor(voice, own.archetype, rng)) : null;
  const vel = keyOfPar(voice, i.base.velTarget[voice] ?? 0);
  const origin: CandidateOrigin = {
    kind: 'generated',
    seed: i.seed.seed,
    ...(i.seed.text ? { seedText: i.seed.text } : {}),
    index: i.serial - 1,
    draw: i.draw,
    character: i.character,
    wildness: Math.round(w * 100),
    voice,
    archetype: own.archetype,
    lineage: [],
    from: '',
    generator: FACTORY_GENERATOR * 1000 + GENERATOR_VERSION,
  };
  const key = hash32(seed, ...Object.values(values).map((x) => x ?? 0)).toString(36);
  return { key, name: `${spec.short} ${String(i.serial).padStart(3, '0')}${i.draw ? '.' + i.draw : ''}`, voice, values, lfo, vel, origin };
}

// ---------------------------------------------------------------------------- the stage
/**
 * The project a sound is rendered in: the live project's kit with the sound's voice written in
 * (parameter locks are NOT applied: a factory sound is a whole voice), on a single track of its
 * own that plays the right trigger. Tracks, patterns and the master chain of the live project do
 * not come into it, so nothing leaks into the render and the live project is never written to.
 * WET renders use the channel strip (send, FX route) of the live track that plays the same voice.
 */
export const STAGE_TRACK = 'factory';

export function stageProject(live: Project, instrument: Instrument, c: Pick<Candidate, 'voice' | 'values' | 'lfo' | 'vel'>): Project {
  const spec = INSTRUMENT_SPECS[instrument];
  const kit = applyToKit(live.kit.synth, c.voice, c).kit;
  const mate = live.tracks.find((t) => t.sound.mode === 'synth' && (t.sound.trigger >= 5 ? 5 : t.sound.trigger) === c.voice && t.role === spec.role) ?? live.tracks.find((t) => t.sound.mode === 'synth' && (t.sound.trigger >= 5 ? 5 : t.sound.trigger) === c.voice);
  const mix = mate ? { ...defaultMix(), ...JSON.parse(JSON.stringify(mate.mix)), mute: false, solo: false } : defaultMix();
  const track: Track = {
    id: STAGE_TRACK,
    name: ROLE_LABEL[spec.role],
    role: spec.role,
    sound: defaultSound({ mode: 'synth', trigger: spec.trigger(c.voice) }),
    mix,
    play: defaultPlay(),
    midi: { channel: 10, note: GM_NOTE[spec.role] },
    lock: false,
  };
  const { scale: _scale, tempoAuto: _auto, ...rest } = live;
  void _scale;
  void _auto;
  return { ...rest, tracks: [track], patterns: [], chain: { on: false, entries: [] }, kit: { ...live.kit, synth: kit } };
}

/** A short description of how a sound was made, for tooltips and the status line. */
export const describeSettings = (s: Pick<FactorySettings, 'character' | 'wildness' | 'variation' | 'diversity'>): string => `${characterLabel(s.character)} · WILDNESS ${s.wildness}% · VARIATION ${s.variation}% · DIVERSITY ${s.diversity}%`;

// ---------------------------------------------------------------------------- what is kept of a sound
/**
 * A rendered sound is measured once and its audio dropped: a few hundred numbers are all the
 * browser, the sort orders and the pack metadata need. The audio is rendered again, identically,
 * to be heard or exported.
 */
export interface SoundPitch {
  /** the analysis' verdict; "skipped" for the instruments that are not measured (hats, cymbal, snare, clap) */
  kind: PitchKind | 'skipped';
  /** a note only where the analysis is sure of one (confidence 0.5 and a stable or swept pitch) */
  reliable: boolean;
  note: string | null;
  midi: number | null;
  hz: number | null;
  cents: number | null;
  confidence: number;
  /** what to print: C2, C2 +12C, NOISE, INHARM, NO NOTE, — */
  text: string;
}

export interface SoundInfo {
  rate: number;
  frames: number;
  /** length of the render in seconds */
  seconds: number;
  /** linear, before any normalisation */
  peak: number;
  rms: number;
  centroid: number;
  noise: number;
  tonality: number;
  lengthMs: number;
  attackMs: number;
  dc: number;
  sweepOct: number;
  /** the render ended while the sound was still audible */
  truncated: boolean;
  pitch: SoundPitch;
  /** 64 columns of the waveform, relative to its peak */
  wave: number[];
  features: number[];
  /** the quality checks of this sound alone (duplicates are found across the collection) */
  flags: QcFlag[];
  /** how it sounds, in a word (the file name when there is no note) */
  word: string;
}

export type SoundStatus = 'queued' | 'rendering' | 'ready' | 'failed' | 'cancelled';

/** The settings a sound was made with (a batch's settings, kept with each of its sounds). */
export interface MadeWith {
  character: KitFlavour;
  wildness: number;
  variation: number;
  diversity: number;
  seed: SeedValue;
}

export interface FactorySound {
  /** instrument and serial: "kick-3" */
  id: string;
  instrument: Instrument;
  /** the number in the file name: 1-based among this instrument's sounds, never reused */
  serial: number;
  /** generation order, 1-based, across batches */
  order: number;
  status: SoundStatus;
  error?: string;
  draw: number;
  /** the redraw (DIVERSITY) that was kept: 0 is the first design */
  attempt: number;
  candidate: Candidate;
  made: MadeWith;
  selected: boolean;
  favourite: boolean;
  /** the player accepts this sound whatever the quality checks say */
  keep: boolean;
  info?: SoundInfo;
  /** the earlier sound this one nearly repeats */
  dupOf?: string;
  /** counts every change, so the screen redraws only what moved */
  rev: number;
  /** it came from a pack file */
  imported?: boolean;
}

export const flagsOf = (s: Pick<FactorySound, 'info' | 'dupOf'>): QcFlag[] => [...(s.info?.flags ?? []), ...(s.dupOf ? [{ id: 'duplicate' as const, severity: 'warn' as const, text: `NEAR-DUPLICATE OF ${s.dupOf.toUpperCase()}` }] : [])];
export const statusOf = (s: Pick<FactorySound, 'info' | 'dupOf'>): 'ok' | 'warn' | 'fail' => qcStatus(flagsOf(s));

// ---------------------------------------------------------------------------- measuring a render
/** The analysis confidence under which a pitch gets no note name (the kit exporter's own limit). */
export const PITCH_MIN_CONFIDENCE = 0.5;
/** The longest tail a factory render follows. */
export const RENDER_MAX_SECONDS = 6;

export function soundPitch(a: PitchAnalysis | null): SoundPitch {
  if (!a) return { kind: 'skipped', reliable: false, note: null, midi: null, hz: null, cents: null, confidence: 0, text: '—' };
  const f = a.fundamental;
  if ((a.kind === 'stable' || a.kind === 'swept') && f && a.confidence >= PITCH_MIN_CONFIDENCE) {
    const c = Math.round(f.cents);
    const off = Math.abs(c) >= 10 ? ` ${c > 0 ? '+' : '−'}${Math.abs(c)}C` : '';
    return { kind: a.kind, reliable: true, note: f.note, midi: f.midi, hz: f.hz, cents: f.cents, confidence: a.confidence, text: f.note + (a.kind === 'swept' ? '↓' : '') + off };
  }
  const text = a.kind === 'silent' ? 'SILENT' : a.kind === 'unpitched' ? 'NOISE' : a.kind === 'inharmonic' ? 'INHARM' : 'NO NOTE';
  return { kind: a.kind, reliable: false, note: null, midi: null, hz: null, cents: null, confidence: a.confidence, text };
}

/** Measure one render of an instrument: everything the factory keeps of it (the audio is not part of it). */
export function analyseRender(audio: Float32Array[], rate: number, instrument: Instrument, truncated: boolean): SoundInfo {
  const m = measure(audio, rate);
  const pa = PITCHED.has(instrument) && !m.silent ? analysePitch(audio, rate, { maxSeconds: 1.2 }) : null;
  const frames = audio[0]?.length ?? 0;
  const pitch = soundPitch(pa);
  return {
    rate,
    frames,
    seconds: frames / rate,
    peak: peakOf(audio[0]!, audio[1] ?? null),
    rms: m.rms,
    centroid: m.centroid,
    noise: m.noise,
    tonality: m.tonality,
    lengthMs: m.lengthMs,
    attackMs: m.attackMs,
    dc: m.dc,
    sweepOct: m.sweepOct,
    truncated,
    pitch,
    wave: wavePeaks(audio, 64),
    features: soundFeatures(audio, m, pa),
    flags: qcCheck(audio, m, instrument, truncated),
    word: describeSound(m, pa ? pa.kind : null),
  };
}
