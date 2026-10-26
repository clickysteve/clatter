/**
 * Generative sound design: GENERATE KIT, MUTATE KIT, MUTATE VOICE and EVOLVE for the LXR engine.
 *
 * Two generations of the designer live here. With a CHARACTER and a WILDNESS (the KITS workspace,
 * NEW VOICE, the K keys) voices are designed from instrument PROFILES (profiles.ts): ten drum
 * roles written for each LXR voice model, leaned by the character, relaxed continuously by the
 * wildness, and chosen between by measuring candidates in the engine (kitcheck.ts). Without them
 * (factory presets, WILDCARD's kit mutation, EVOLVE) the original archetype designer below runs
 * unchanged, so every preset and every stored seed still makes exactly the sound it always did.
 *
 * Not random parameter values: each voice is designed from an ARCHETYPE (kick, tom, perc,
 * snare, clap, hat, cymbal, zap) that knows how the LXR's parameters relate for that sound
 * (a kick is a low sine with a fast, deep pitch sweep; a hat is a high carrier with two noisy
 * FM modulators through a high-pass; a clap is the snare voice's noise with envelope repeats),
 * drawn inside ranges calibrated against the engine (decay 10 ≈ 125 ms, 20 ≈ 275 ms, 40 ≈ 670 ms;
 * coarse is the oscillator's MIDI note). A FLAVOUR (from the rhythm style) leans the ranges:
 * clean machine, 808-ish electro, acoustic-ish, industrial drive, glitch decimation and FM,
 * dub space. Mutation and evolution move parameters within the same bounds, so a mutated kit
 * never goes silent, never loses its kick's low end and never runs away. kitcheck.ts then
 * renders every voice through the real engine and fixes levels (and replaces a voice that would
 * still be inaudible).
 *
 * Deterministic: the same kit, seed and locks give the same result. Locked voices and locked
 * parameters are never changed.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import type { Character, Role, SoundLocks, SynthKit } from '../model/types';
import type { KitFlavour } from '../rhythm/styles';
import { hash32, Rng, SALT } from '../rhythm/rng';
import { PAR } from './lxrParamIds';
import { boundsAt, CHARACTER_DEFS, cohere, designProfileVoice, fxFlavour, isMenu, lfoKeys, modelOf, profileForVoice, recipeFor, type Profile } from './profiles';

export type Archetype = 'kick' | 'tom' | 'perc' | 'zap' | 'snare' | 'clap' | 'hat' | 'cymbal';

/** Semantic names of a voice's parameters → PAR numbers. */
export type Key =
  | 'wave' | 'coarse' | 'fine' | 'pwm'
  | 'fmAmt' | 'fmFreq' | 'fmWave' | 'fmMode'
  | 'm1wave' | 'm1freq' | 'm1amt' | 'm2wave' | 'm2freq' | 'm2amt'
  | 'noiseFreq' | 'noiseMix'
  | 'pDecay' | 'pSlope' | 'pAmt'
  | 'attack' | 'decay' | 'decayOpen' | 'slope' | 'repeat'
  | 'tWave' | 'tVol' | 'tFreq'
  | 'cutoff' | 'reso' | 'ftype' | 'fdrive'
  | 'lfoRate' | 'lfoSync' | 'lfoDepth' | 'lfoWave' | 'lfoRetrig' | 'lfoPhase'
  | 'velAmt' | 'velVol' | 'vol' | 'pan' | 'rate' | 'drive';

export function voiceKeys(v: number): Partial<Record<Key, number>> {
  const k = v;
  const common: Partial<Record<Key, number>> = {
    tWave: PAR.TRANS1_WAVE + k,
    tVol: PAR.TRANS1_VOL + k,
    tFreq: PAR.TRANS1_FREQ + k,
    cutoff: PAR.FILTER_FREQ_1 + k,
    reso: PAR.RESO_1 + k,
    ftype: PAR.FILTER_TYPE_1 + k,
    fdrive: PAR.FILTER_DRIVE_1 + k,
    lfoRate: PAR.FREQ_LFO1 + k,
    lfoSync: PAR.SYNC_LFO1 + k,
    lfoDepth: PAR.AMOUNT_LFO1 + k,
    lfoWave: PAR.WAVE_LFO1 + k,
    lfoRetrig: PAR.RETRIGGER_LFO1 + k,
    lfoPhase: PAR.OFFSET_LFO1 + k,
    velAmt: PAR.VELO_MOD_AMT_1 + k,
    velVol: PAR.VOLUME_MOD_ON_OFF1 + k,
    vol: PAR.VOL1 + k,
    pan: PAR.PAN1 + (k < 3 ? k : k + 2),
    rate: PAR.VOICE_DECIMATION1 + k,
  };
  if (v < 3)
    return {
      ...common,
      wave: PAR.OSC_WAVE_DRUM1 + k,
      coarse: PAR.COARSE1 + 2 * k,
      fine: PAR.FINE1 + 2 * k,
      pwm: PAR.PWM_1 + k,
      fmAmt: PAR.FMAMNT1 + 2 * k,
      fmFreq: PAR.FM_FREQ1 + 2 * k,
      fmWave: PAR.MOD_WAVE_DRUM1 + k,
      fmMode: PAR.MIX_MOD_1 + k,
      pDecay: PAR.MOD_EG1 + k,
      pSlope: PAR.PITCH_SLOPE1 + k,
      pAmt: PAR.MODAMNT1 + k,
      attack: PAR.VELOA1 + 2 * k,
      decay: PAR.VELOD1 + 2 * k,
      slope: PAR.VOL_SLOPE1 + k,
      drive: PAR.DRIVE1 + k,
    };
  if (v === 3)
    return {
      ...common,
      wave: PAR.OSC_WAVE_SNARE,
      coarse: PAR.COARSE4,
      fine: PAR.FINE4,
      pwm: PAR.PWM_4,
      noiseFreq: PAR.NOISE_FREQ1,
      noiseMix: PAR.MIX1,
      pDecay: PAR.MOD_EG4,
      pSlope: PAR.PITCH_SLOPE4,
      pAmt: PAR.MODAMNT4,
      attack: PAR.VELOA4,
      decay: PAR.VELOD4,
      slope: PAR.VOL_SLOPE4,
      repeat: PAR.REPEAT4,
      drive: PAR.SNARE_DISTORTION,
    };
  const cym = v === 4;
  return {
    ...common,
    wave: cym ? PAR.WAVE1_CYM : PAR.WAVE1_HH,
    coarse: cym ? PAR.COARSE5 : PAR.COARSE6,
    fine: cym ? PAR.FINE5 : PAR.FINE6,
    pwm: cym ? PAR.PWM_5 : PAR.PWM_6,
    m1wave: cym ? PAR.WAVE2_CYM : PAR.WAVE2_HH,
    m1freq: cym ? PAR.MOD_OSC_F1_CYM : PAR.MOD_OSC_F1,
    m1amt: cym ? PAR.MOD_OSC_GAIN1_CYM : PAR.MOD_OSC_GAIN1,
    m2wave: cym ? PAR.WAVE3_CYM : PAR.WAVE3_HH,
    m2freq: cym ? PAR.MOD_OSC_F2_CYM : PAR.MOD_OSC_F2,
    m2amt: cym ? PAR.MOD_OSC_GAIN2_CYM : PAR.MOD_OSC_GAIN2,
    attack: cym ? PAR.VELOA5 : PAR.VELOA6,
    decay: cym ? PAR.VELOD5 : PAR.VELOD6_CLOSED,
    decayOpen: cym ? undefined : PAR.VELOD6_OPEN,
    slope: cym ? PAR.VOL_SLOPE5 : PAR.VOL_SLOPE6,
    repeat: cym ? PAR.REPEAT5 : undefined,
    drive: cym ? PAR.CYMBAL_DISTORTION : PAR.HAT_DISTORTION,
  };
}

/** Value spec: a range [lo, hi] (inclusive) or a list of choices. */
type Spec = [number, number] | { pick: number[] };
type Recipe = Partial<Record<Key, Spec>>;

// waveforms: 0 SINE 1 TRI 2 SAW 3 REC 4 NOISE 5 PWM
// filter types (menu index): 0 LP 1 HP 2 BP 3 UBP 4 NOTCH 5 PEAK 6 LP2 7 OFF
// transients: 0 SNAP 1 OFFSET 2 CLICK 3 CLICK2 4 TICK 5 KICK 6 RIM 7 DROP 8 HAT 9 CLAP 10 KICK2 11 SNARE 12 TOM 13 SNAP2

const ARCHETYPES: Record<Archetype, Recipe> = {
  kick: {
    wave: { pick: [0, 0, 0, 1] },
    coarse: [24, 36],
    fine: [58, 68],
    pAmt: [45, 110],
    pDecay: [12, 40],
    pSlope: [10, 60],
    attack: [0, 2],
    decay: [16, 34],
    slope: [20, 70],
    fmAmt: [0, 22],
    fmFreq: [30, 70],
    fmWave: { pick: [0, 1] },
    fmMode: { pick: [0] },
    tWave: { pick: [0, 2, 3, 5, 10, 13] },
    tVol: [20, 80],
    tFreq: [25, 60],
    cutoff: [70, 127],
    reso: [0, 30],
    ftype: { pick: [0, 0, 6] },
    drive: [0, 40],
    vol: [110, 127],
  },
  tom: {
    wave: { pick: [0, 0, 1] },
    coarse: [38, 60],
    fine: [55, 72],
    pAmt: [18, 60],
    pDecay: [16, 45],
    pSlope: [10, 50],
    attack: [0, 2],
    decay: [14, 28],
    slope: [10, 50],
    fmAmt: [0, 40],
    fmFreq: [40, 90],
    fmWave: { pick: [0, 1, 2] },
    fmMode: { pick: [0, 0, 1] },
    tWave: { pick: [0, 2, 12, 6] },
    tVol: [10, 60],
    tFreq: [25, 70],
    cutoff: [75, 127],
    reso: [0, 50],
    ftype: { pick: [0, 0, 6] },
    drive: [0, 35],
    vol: [100, 125],
  },
  perc: {
    wave: { pick: [0, 1, 2, 3, 5] },
    coarse: [58, 90],
    fine: [40, 88],
    pwm: [10, 110],
    pAmt: [0, 50],
    pDecay: [4, 25],
    pSlope: [0, 60],
    attack: [0, 3],
    decay: [5, 16],
    slope: [0, 40],
    fmAmt: [30, 110],
    fmFreq: [50, 110],
    fmWave: { pick: [0, 1, 2, 3, 4] },
    fmMode: { pick: [0, 0, 1] },
    tWave: { pick: [4, 6, 2, 8, 9] },
    tVol: [10, 70],
    tFreq: [30, 100],
    cutoff: [60, 127],
    reso: [0, 80],
    ftype: { pick: [0, 1, 2, 3, 5] },
    drive: [0, 60],
    vol: [100, 125],
  },
  zap: {
    wave: { pick: [0, 2, 3, 5] },
    coarse: [70, 105],
    fine: [30, 96],
    pwm: [0, 127],
    pAmt: [80, 127],
    pDecay: [5, 22],
    pSlope: [0, 80],
    attack: [0, 4],
    decay: [6, 20],
    slope: [0, 50],
    fmAmt: [40, 127],
    fmFreq: [20, 110],
    fmWave: { pick: [0, 2, 3, 4] },
    fmMode: { pick: [0, 1] },
    tWave: { pick: [0, 7, 13] },
    tVol: [20, 100],
    tFreq: [20, 110],
    cutoff: [50, 127],
    reso: [20, 100],
    ftype: { pick: [0, 2, 3, 5] },
    drive: [10, 90],
    vol: [96, 120],
  },
  snare: {
    wave: { pick: [0, 1, 1] },
    coarse: [42, 62],
    fine: [50, 76],
    noiseFreq: [90, 127],
    noiseMix: [45, 105],
    pAmt: [20, 80],
    pDecay: [8, 30],
    pSlope: [0, 40],
    attack: [0, 2],
    decay: [8, 20],
    slope: [0, 40],
    repeat: { pick: [0] },
    tWave: { pick: [0, 11, 2, 6, 13] },
    tVol: [20, 80],
    tFreq: [30, 70],
    cutoff: [50, 127],
    reso: [0, 50],
    ftype: { pick: [0, 1, 2, 3] },
    drive: [10, 60],
    vol: [105, 127],
  },
  clap: {
    wave: { pick: [0, 1] },
    coarse: [50, 70],
    noiseFreq: [105, 127],
    noiseMix: [100, 127],
    pAmt: [0, 30],
    pDecay: [6, 20],
    attack: [0, 2],
    decay: [9, 18],
    slope: [0, 30],
    repeat: [3, 6],
    tWave: { pick: [9, 0, 2] },
    tVol: [10, 60],
    tFreq: [30, 70],
    cutoff: [60, 110],
    reso: [10, 60],
    ftype: { pick: [2, 3, 1] },
    drive: [10, 50],
    vol: [110, 127],
  },
  hat: {
    wave: { pick: [3, 3, 0, 2, 5] },
    coarse: [70, 110],
    fine: [40, 88],
    pwm: [20, 100],
    m1wave: { pick: [3, 0, 2, 5] },
    m1freq: [70, 127],
    m1amt: [60, 127],
    m2wave: { pick: [4, 4, 3] },
    m2freq: [80, 127],
    m2amt: [70, 127],
    attack: [0, 1],
    decay: [2, 8],
    decayOpen: [12, 32],
    slope: [0, 30],
    tWave: { pick: [8, 4, 0, 2] },
    tVol: [0, 50],
    tFreq: [40, 100],
    cutoff: [70, 118],
    reso: [0, 60],
    ftype: { pick: [1, 1, 2, 3] },
    drive: [0, 40],
    vol: [100, 125],
  },
  cymbal: {
    wave: { pick: [3, 4, 0, 2, 5] },
    coarse: [60, 112],
    fine: [40, 88],
    pwm: [20, 100],
    m1wave: { pick: [3, 0, 2, 4] },
    m1freq: [60, 127],
    m1amt: [50, 127],
    m2wave: { pick: [4, 3, 0] },
    m2freq: [60, 127],
    m2amt: [50, 127],
    attack: [0, 3],
    decay: [40, 80],
    slope: [0, 40],
    repeat: { pick: [0] },
    tWave: { pick: [8, 4, 0] },
    tVol: [0, 50],
    tFreq: [40, 100],
    cutoff: [55, 110],
    reso: [0, 60],
    ftype: { pick: [1, 1, 2, 3] },
    drive: [0, 40],
    vol: [96, 120],
  },
};

/** How a flavour leans an archetype (applied after drawing; clamped to the archetype's bounds). */
interface Lean {
  decay?: number; // multiplier
  drive?: number; // added
  rate?: [number, number]; // decimation range (127 = full rate)
  fm?: number; // multiplier on FM / mod amounts
  lfo?: number; // chance of an LFO
  fx?: { type: number; amount: [number, number]; p: [number, number][]; extra?: Partial<Record<number, number>> }[];
}

const FLAVOURS: Record<KitFlavour, Lean> = {
  machine: { decay: 0.9, drive: 0, lfo: 0.1, fx: [{ type: 0, amount: [0, 0], p: [] }, { type: 4, amount: [15, 30], p: [[40, 70], [50, 70], [80, 110], [30, 60]] }] },
  electro: { decay: 1.25, drive: 5, fm: 1.1, lfo: 0.15, fx: [{ type: 4, amount: [15, 35], p: [[45, 80], [50, 80], [70, 110], [40, 75]] }, { type: 3, amount: [70, 100], p: [[10, 40], [40, 80], [50, 90], [40, 80]] }] },
  acoustic: { decay: 1, drive: 10, fm: 0.7, lfo: 0.05, fx: [{ type: 3, amount: [60, 100], p: [[5, 30], [40, 90], [40, 80], [50, 90]] }, { type: 0, amount: [0, 0], p: [] }] },
  industrial: { decay: 1.1, drive: 40, fm: 1.3, rate: [60, 127], lfo: 0.3, fx: [{ type: 1, amount: [40, 80], p: [[50, 110], [30, 90], [40, 100], [50, 90]], extra: { [PAR.FX_DIST_TYPE]: 2 } }, { type: 2, amount: [25, 50], p: [[20, 90], [0, 0], [0, 0], [0, 0]] }] },
  glitch: { decay: 0.7, drive: 20, fm: 1.4, rate: [20, 127], lfo: 0.55, fx: [{ type: 2, amount: [20, 50], p: [[30, 110], [0, 0], [0, 0], [0, 0]] }, { type: 4, amount: [25, 45], p: [[10, 40], [10, 40], [60, 110], [50, 90]], extra: { [PAR.FX_DELAY_TYPE]: 1 } }] },
  dub: { decay: 1.35, drive: 5, fm: 0.8, lfo: 0.2, fx: [{ type: 4, amount: [30, 50], p: [[60, 100], [60, 100], [40, 80], [70, 100]], extra: { [PAR.FX_DELAY_TYPE]: 1 } }] },
};

/** The archetype a voice plays, from the roles of the tracks that use it. */
export function archetypeFor(voice: number, roles: readonly string[]): Archetype {
  if (voice === 5) return 'hat';
  if (voice === 4) return roles.includes('chat') || roles.includes('ohat') ? 'hat' : 'cymbal';
  if (voice === 3) return roles.includes('clap') && !roles.includes('snare') ? 'clap' : 'snare';
  if (roles.includes('kick')) return 'kick';
  if (roles.includes('ltom') || roles.includes('htom')) return 'tom';
  if (roles.includes('fx')) return 'zap';
  if (roles.includes('perc') || roles.includes('clap')) return 'perc';
  return voice === 0 ? 'kick' : voice === 1 ? 'tom' : 'perc';
}

const isRange = (s: Spec): s is [number, number] => Array.isArray(s);
const clamp127 = (v: number) => Math.max(0, Math.min(127, Math.round(v)));

function draw(spec: Spec, rng: Rng): number {
  if (isRange(spec)) return clamp127(rng.range(spec[0], spec[1] + 0.999));
  return rng.pick(spec.pick);
}

/** Bounds a mutation may move a value in (the archetype's range, widened a little). */
function bounds(spec: Spec): [number, number] {
  if (isRange(spec)) {
    const w = (spec[1] - spec[0]) * 0.15 + 2;
    return [clamp127(spec[0] - w), clamp127(spec[1] + w)];
  }
  return [Math.min(...spec.pick), Math.max(...spec.pick)];
}

export interface VoiceDesign {
  archetype: Archetype;
  values: Partial<Record<Key, number>>;
}

/** Design one voice from scratch. */
export function designVoice(voice: number, archetype: Archetype, flavour: KitFlavour, rng: Rng): VoiceDesign {
  const recipe = ARCHETYPES[archetype];
  const lean = FLAVOURS[flavour];
  const keys = voiceKeys(voice);
  const values: Partial<Record<Key, number>> = {};
  for (const [k, spec] of Object.entries(recipe) as [Key, Spec][]) {
    if (keys[k] === undefined) continue;
    values[k] = draw(spec, rng);
  }
  // flavour leanings
  const dec = lean.decay ?? 1;
  for (const k of ['decay', 'decayOpen'] as const) if (values[k] !== undefined) values[k] = clampTo(recipe[k], values[k]! * dec);
  if (values.drive !== undefined) values.drive = clampTo(recipe.drive, values.drive + (lean.drive ?? 0) * rng.next());
  for (const k of ['fmAmt', 'm1amt', 'm2amt'] as const) if (values[k] !== undefined && lean.fm) values[k] = clampTo(recipe[k], values[k]! * lean.fm);
  values.rate = lean.rate && rng.chance(0.4) ? clamp127(rng.range(lean.rate[0], lean.rate[1])) : 127;
  // the defaults of the controls the archetype leaves alone
  values.attack ??= 0;
  values.velVol = 1;
  values.velAmt = 0;
  values.pan = 63;
  values.fdrive = rng.chance(0.3) ? clamp127(rng.range(0, 40)) : 0;
  if (keys.pwm !== undefined) values.pwm ??= clamp127(rng.range(0, 90));
  if (keys.fine !== undefined) values.fine ??= clamp127(rng.range(56, 70));
  // an LFO, sometimes
  if (rng.chance(lean.lfo ?? 0.1)) {
    values.lfoWave = rng.int(8);
    values.lfoSync = rng.chance(0.6) ? rng.pick([4, 6, 8, 10]) : 0;
    values.lfoRate = clamp127(rng.range(10, 90));
    values.lfoDepth = clamp127(rng.range(10, 50));
    values.lfoRetrig = rng.chance(0.6) ? voice + 1 : 0;
    values.lfoPhase = 0;
  } else {
    values.lfoDepth = 0;
    values.lfoRate = 0;
    values.lfoSync = 0;
    values.lfoWave = 0;
    values.lfoRetrig = 0;
    values.lfoPhase = 0;
  }
  return { archetype, values };
}

function clampTo(spec: Spec | undefined, v: number): number {
  if (!spec) return clamp127(v);
  const [lo, hi] = isRange(spec) ? spec : [Math.min(...spec.pick), Math.max(...spec.pick)];
  return clamp127(Math.max(lo, Math.min(hi, v)));
}

/** LFO targets that make musical sense per archetype. */
function lfoTarget(voice: number, a: Archetype, rng: Rng): number {
  const k = voiceKeys(voice);
  const opts: (number | undefined)[] = a === 'hat' || a === 'cymbal' ? [k.cutoff, k.m1freq, k.coarse, k.decay] : a === 'kick' ? [k.cutoff, k.pAmt, k.decay] : [k.cutoff, k.coarse, k.fmAmt, k.pAmt, k.noiseMix];
  const ok = opts.filter((x): x is number => x !== undefined);
  return ok.length ? rng.pick(ok) : 0;
}

export interface KitGenOptions {
  seed: number;
  flavour: KitFlavour;
  /** roles of the tracks using each voice */
  voiceRoles: string[][];
  locks: SoundLocks;
  /** also design the FX bus */
  fx?: boolean;
  /** the profile designer: a character (with it, `flavour` is not used) */
  character?: Character;
  /** 0-1 (default 0.3) */
  wildness?: number;
  /** per voice: the profile to design (null or absent: from the voice's tracks) */
  profiles?: (Role | null)[];
  /** only these voices (default: all six; the FX bus only with all six) */
  voices?: number[];
}

/** The profile each voice is designed as: an override, else from the roles of its tracks. */
export function resolveProfiles(o: Pick<KitGenOptions, 'voiceRoles' | 'profiles'>): Profile[] {
  return [0, 1, 2, 3, 4, 5].map((v) => o.profiles?.[v] ?? profileForVoice(v, o.voiceRoles[v] ?? []));
}

/** Write a design into a kit (respecting parameter locks). */
function apply(kit: SynthKit, voice: number, d: VoiceDesign, locked: Set<number>): void {
  const keys = voiceKeys(voice);
  for (const [k, v] of Object.entries(d.values) as [Key, number][]) {
    const p = keys[k];
    if (p === undefined || locked.has(p)) continue;
    kit.params[p] = v;
  }
}

/** GENERATE KIT: every unlocked voice designed afresh. */
export function generateKit(base: SynthKit, o: KitGenOptions): SynthKit {
  if (o.character) return generateProfileKit(base, o, o.character);
  const kit: SynthKit = { params: base.params.slice(), lfoTarget: base.lfoTarget.slice(), velTarget: base.velTarget.slice() };
  const locked = new Set(o.locks.params);
  for (let v = 0; v < 6; v++) {
    if (o.locks.voices[v]) continue;
    const rng = new Rng(hash32(o.seed, SALT.kit, v));
    const a = archetypeFor(v, o.voiceRoles[v] ?? []);
    const d = designVoice(v, a, o.flavour, rng);
    apply(kit, v, d, locked);
    kit.lfoTarget[v] = (d.values.lfoDepth ?? 0) > 0 ? lfoTarget(v, a, rng) : 0;
    kit.velTarget[v] = 0;
  }
  if (o.fx !== false && !locked.has(PAR.FX_TYPE)) designFx(kit, new Rng(hash32(o.seed, SALT.kit, 99)), o.flavour, locked);
  return kit;
}

/** The FX bus for a flavour. */
export function designFx(kit: SynthKit, rng: Rng, flavour: KitFlavour, locked: Set<number> = new Set()): void {
  const opts = FLAVOURS[flavour].fx ?? [];
  if (!opts.length) return;
  const f = rng.pick(opts);
  const set = (p: number, v: number) => {
    if (!locked.has(p)) kit.params[p] = clamp127(v);
  };
  set(PAR.FX_TYPE, f.type);
  set(PAR.FX_DRY_WET, rng.range(f.amount[0], f.amount[1]));
  const ps = [PAR.FX_P1, PAR.FX_P2, PAR.FX_P3, PAR.FX_P4];
  ps.forEach((p, i) => {
    const r = f.p[i];
    if (r) set(p, rng.range(r[0], r[1]));
  });
  for (const [p, v] of Object.entries(f.extra ?? {})) set(Number(p), v as number);
}

/**
 * MUTATE: controlled changes. Each unlocked parameter of the chosen voices moves with
 * probability ~amount, by a step proportional to amount, inside its archetype's bounds;
 * menus (waveforms, filter types) change rarely.
 */
export function mutateKit(base: SynthKit, o: KitGenOptions & { amount: number; voices?: number[] }): SynthKit {
  if (o.character) return mutateProfileKit(base, o, o.character);
  const kit: SynthKit = { params: base.params.slice(), lfoTarget: base.lfoTarget.slice(), velTarget: base.velTarget.slice() };
  const locked = new Set(o.locks.params);
  const amount = Math.max(0, Math.min(1, o.amount));
  const voices = o.voices ?? [0, 1, 2, 3, 4, 5];
  for (const v of voices) {
    if (o.locks.voices[v]) continue;
    const rng = new Rng(hash32(o.seed, SALT.kit, 1000 + v));
    const a = archetypeFor(v, o.voiceRoles[v] ?? []);
    const recipe = ARCHETYPES[a];
    const keys = voiceKeys(v);
    for (const [k, spec] of Object.entries(recipe) as [Key, Spec][]) {
      const p = keys[k];
      if (p === undefined || locked.has(p)) continue;
      if (!rng.chance(0.25 + amount * 0.6)) continue;
      if (isRange(spec)) {
        const [lo, hi] = bounds(spec);
        const cur = kit.params[p]!;
        const step = rng.bell() * (hi - lo) * (0.08 + amount * 0.4);
        kit.params[p] = clamp127(Math.max(lo, Math.min(hi, cur + step)));
      } else if (rng.chance(amount * 0.35)) {
        kit.params[p] = rng.pick(spec.pick);
      }
    }
  }
  if (voices.length === 6 && rng01(o.seed) < amount * 0.25 && !locked.has(PAR.FX_TYPE)) {
    const r = new Rng(hash32(o.seed, SALT.kit, 1099));
    for (const p of [PAR.FX_P1, PAR.FX_P2, PAR.FX_P3, PAR.FX_P4]) if (!locked.has(p)) kit.params[p] = clamp127(kit.params[p]! + r.bell() * 25 * amount);
  }
  return kit;
}

const rng01 = (seed: number) => new Rng(hash32(seed, 4242)).next();

/**
 * EVOLVE: one small step of a slow timbral drift. Moves a few parameters a little, and pulls
 * each one back towards HOME (the kit the evolution started from) once it has drifted far, so
 * an evolving kit wanders around its character instead of away from it.
 */
export function evolveKit(current: SynthKit, home: SynthKit, o: KitGenOptions & { amount: number }): SynthKit {
  const step = mutateKit(current, { ...o, amount: o.amount * 0.35 });
  const maxDrift = 6 + o.amount * 30;
  for (let p = 0; p < step.params.length; p++) {
    const h = home.params[p]!;
    const d = step.params[p]! - h;
    if (Math.abs(d) > maxDrift) step.params[p] = clamp127(h + Math.sign(d) * maxDrift);
  }
  return step;
}

/** Which voices a set of tracks uses (and with which roles). */
export function voiceRolesOf(tracks: readonly { role: string; sound: { mode: string; trigger: number } }[]): string[][] {
  const out: string[][] = [[], [], [], [], [], []];
  for (const t of tracks) {
    if (t.sound.mode === 'sample') continue;
    const v = t.sound.trigger >= 5 ? 5 : t.sound.trigger;
    out[v]!.push(t.role);
  }
  return out;
}

// ---------------------------------------------------------------------------- profiles, character, wildness

/** Write values into a voice, respecting locked parameters. */
function applyValues(kit: SynthKit, voice: number, values: Partial<Record<Key, number>>, locked: Set<number>): void {
  const keys = voiceKeys(voice);
  for (const [k, v] of Object.entries(values) as [Key, number][]) {
    const p = keys[k];
    if (p === undefined || locked.has(p)) continue;
    kit.params[p] = v;
  }
}

function pickLfoTarget(voice: number, profile: Profile, rng: Rng): number {
  const keys = voiceKeys(voice);
  const ok = lfoKeys(profile).map((k) => keys[k]).filter((x): x is number => x !== undefined);
  return ok.length ? rng.pick(ok) : 0;
}

/** Design one voice from its profile into a kit (used by GENERATE KIT, NEW VOICE and the engine check's candidates). */
export function designProfileInto(kit: SynthKit, voice: number, profile: Profile, character: Character, wildness: number, rng: Rng, locked: Set<number>): void {
  const d = designProfileVoice(voice, voiceKeys(voice), profile, character, wildness, rng);
  applyValues(kit, voice, d.values, locked);
  kit.lfoTarget[voice] = d.lfo ? pickLfoTarget(voice, profile, rng) : 0;
  kit.velTarget[voice] = 0;
}

/** Low tom below high tom: two drum voices playing toms keep their order unless the kit is wild. */
export function orderToms(kit: SynthKit, profiles: Profile[], designed: number[], wildness: number, locked: Set<number>): void {
  if (wildness >= 0.7) return;
  const lo = designed.find((v) => v < 4 && profiles[v] === 'ltom');
  const hi = designed.find((v) => v < 4 && profiles[v] === 'htom');
  if (lo === undefined || hi === undefined) return;
  const pl = voiceKeys(lo).coarse!;
  const ph = voiceKeys(hi).coarse!;
  if (locked.has(pl) || locked.has(ph)) return;
  const gap = 5;
  if (kit.params[pl]! + gap <= kit.params[ph]!) return;
  const a = Math.min(kit.params[pl]!, kit.params[ph]!);
  const b = Math.max(kit.params[pl]!, kit.params[ph]!);
  kit.params[pl] = a;
  kit.params[ph] = Math.min(127, Math.max(b, a + gap));
}

function generateProfileKit(base: SynthKit, o: KitGenOptions, ch: Character): SynthKit {
  const kit: SynthKit = { params: base.params.slice(), lfoTarget: base.lfoTarget.slice(), velTarget: base.velTarget.slice() };
  const locked = new Set(o.locks.params);
  const w = Math.max(0, Math.min(1, o.wildness ?? 0.3));
  const profiles = resolveProfiles(o);
  const voices = o.voices ?? [0, 1, 2, 3, 4, 5];
  const designed: number[] = [];
  for (const v of voices) {
    if (o.locks.voices[v]) continue;
    designProfileInto(kit, v, profiles[v]!, ch, w, new Rng(hash32(o.seed, SALT.kit, 200 + v)), locked);
    designed.push(v);
  }
  orderToms(kit, profiles, designed, w, locked);
  if (voices.length === 6 && o.fx !== false && !locked.has(PAR.FX_TYPE)) {
    designFx(kit, new Rng(hash32(o.seed, SALT.kit, 299)), fxFlavour(ch, o.seed), locked);
    if (!locked.has(PAR.FX_DRY_WET)) kit.params[PAR.FX_DRY_WET] = clamp127(kit.params[PAR.FX_DRY_WET]! * CHARACTER_DEFS[ch].wet);
  }
  return kit;
}

/**
 * MUTATE with a character and a wildness: relative to the current kit. Each voice gets a fresh
 * profile-consistent TARGET; unlocked parameters move part of the way towards it (and a little
 * beyond, by noise), inside bounds that the wildness opens. At low wildness the moves are small
 * and stay inside the profile, so a kick stays that kick; at high wildness they are large, menus
 * change, and the target itself may be wild. Relationships are re-applied gently afterwards.
 * `amount` (0-1) scales how much moves; by default it follows the wildness.
 */
function mutateProfileKit(base: SynthKit, o: KitGenOptions & { amount: number }, ch: Character): SynthKit {
  const kit: SynthKit = { params: base.params.slice(), lfoTarget: base.lfoTarget.slice(), velTarget: base.velTarget.slice() };
  const locked = new Set(o.locks.params);
  const w = Math.max(0, Math.min(1, o.wildness ?? 0.3));
  const a = Math.max(0, Math.min(1, o.amount));
  const profiles = resolveProfiles(o);
  const voices = o.voices ?? [0, 1, 2, 3, 4, 5];
  for (const v of voices) {
    if (o.locks.voices[v]) continue;
    const rng = new Rng(hash32(o.seed, SALT.kit, 1200 + v));
    const profile = profiles[v]!;
    const keys = voiceKeys(v);
    const target = designProfileVoice(v, keys, profile, ch, w, rng);
    const recipe = recipeFor(profile, modelOf(v), ch);
    const cur: Partial<Record<Key, number>> = {};
    for (const [k, p] of Object.entries(keys) as [Key, number][]) cur[k] = kit.params[p]!;
    const next: Partial<Record<Key, number>> = { ...cur };
    for (const [k, p] of Object.entries(keys) as [Key, number][]) {
      const spec = recipe[k];
      const tgt = target.values[k];
      if (!spec || tgt === undefined || locked.has(p)) continue;
      if (!rng.chance(0.2 + 0.7 * a)) continue;
      const c = cur[k]!;
      if (isMenu(spec)) {
        if (rng.chance(0.03 + 0.5 * Math.pow(a, 1.5) * (0.3 + w))) next[k] = tgt;
        continue;
      }
      const [lo, hi] = boundsAt(k, spec, w);
      const f = (0.08 + 0.6 * a) * (0.5 + rng.next());
      const noise = (rng.next() + rng.next() - 1) * (hi - lo) * 0.05 * a;
      next[k] = clamp127(Math.max(Math.min(lo, c), Math.min(Math.max(hi, c), c + (tgt - c) * f + noise)));
    }
    // a wild mutation may take on the target's modulation too
    if (w > 0.45 && rng.chance((w - 0.45) * 0.8)) {
      for (const k of ['lfoWave', 'lfoSync', 'lfoRate', 'lfoDepth', 'lfoRetrig', 'lfoPhase'] as const) if (target.values[k] !== undefined) next[k] = target.values[k];
      kit.lfoTarget[v] = target.lfo ? pickLfoTarget(v, profile, rng) : 0;
    }
    cohere(next, profile, modelOf(v), w, rng, 0.5);
    for (const [k, p] of Object.entries(keys) as [Key, number][]) if (!locked.has(p) && next[k] !== undefined && next[k] !== cur[k]) kit.params[p] = next[k]!;
  }
  if (voices.length === 6 && !locked.has(PAR.FX_TYPE)) {
    const r = new Rng(hash32(o.seed, SALT.kit, 1299));
    if (r.chance(a * 0.4)) for (const p of [PAR.FX_P1, PAR.FX_P2, PAR.FX_P3, PAR.FX_P4]) if (!locked.has(p)) kit.params[p] = clamp127(kit.params[p]! + r.bell() * 30 * a);
  }
  return kit;
}
