/**
 * Generative sound design: GENERATE KIT, MUTATE KIT, MUTATE VOICE and EVOLVE for the LXR engine.
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
 * CHARACTER (the flavour) changes the recipes themselves, not just a few multipliers: a MACHINE
 * kick is a clean sine with a short sweep, an ELECTRO kick a long round one, an INDUSTRIAL kick
 * is FM-driven and gritty, a GLITCH kick a crushed click with an extreme sweep, a DUB kick a
 * deep slow one (FLAVOUR_TUNING). WILDNESS (0-1) is how strictly a voice follows its
 * archetype: low draws from a narrow core of the recipe's ranges and its usual menu choices;
 * medium is the recipe as written; high widens the ranges, opens the menus, and with some
 * chance designs the voice as another archetype, with swells, sirens and rolls. Drive, resonance
 * and volume are NOT widened by WILDNESS: wild is not loud or harsh, it is different.
 *
 * Deterministic: the same kit, seed, CHARACTER, WILDNESS and locks give the same result. Locked
 * voices and locked parameters are never changed.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import type { SoundLocks, SynthKit } from '../model/types';
import type { KitFlavour } from '../rhythm/styles';
import { hash32, Rng, SALT } from '../rhythm/rng';
import { PAR } from './lxrParamIds';
import { nearestInScale, type ScaleSpec } from '../music/scale';

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
    noiseMix: [92, 127],
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
    cutoff: [85, 127],
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

/**
 * The FX bus DRIVE with the CLIP shape is the firmware's RAT distortion, whose COLOUR (P2) feeds
 * the output back into a gain of up to 2305: above this COLOUR it can self-oscillate into a steady
 * tone that outlives the drums (from 3 at full DRIVE, TONE and VOLUME; see test/fxclip.test.ts).
 * The generators stay at or under it; a COLOUR set by hand is left alone.
 */
export const CLIP_COLOUR_MAX = 2;

/** Keep a generated or mutated FX bus out of CLIP feedback oscillation (locked COLOUR untouched). */
export function tameFx(params: number[], locked: { has(p: number): boolean } = new Set<number>()): void {
  if (params[PAR.FX_TYPE] === 1 && params[PAR.FX_DIST_TYPE] === 2 && !locked.has(PAR.FX_P2) && (params[PAR.FX_P2] ?? 0) > CLIP_COLOUR_MAX) params[PAR.FX_P2] = CLIP_COLOUR_MAX;
}

const FLAVOURS: Record<KitFlavour, Lean> = {
  machine: { decay: 0.9, drive: 0, lfo: 0.1, fx: [{ type: 0, amount: [0, 0], p: [] }, { type: 4, amount: [15, 30], p: [[40, 70], [50, 70], [80, 110], [30, 60]] }] },
  electro: { decay: 1.25, drive: 5, fm: 1.1, lfo: 0.15, fx: [{ type: 4, amount: [15, 35], p: [[45, 80], [50, 80], [70, 110], [40, 75]] }, { type: 3, amount: [70, 100], p: [[10, 40], [40, 80], [50, 90], [40, 80]] }] },
  acoustic: { decay: 1, drive: 10, fm: 0.7, lfo: 0.05, fx: [{ type: 3, amount: [60, 100], p: [[5, 30], [40, 90], [40, 80], [50, 90]] }, { type: 0, amount: [0, 0], p: [] }] },
  industrial: { decay: 1.1, drive: 40, fm: 1.3, rate: [60, 127], lfo: 0.3, fx: [{ type: 1, amount: [40, 80], p: [[50, 110], [0, CLIP_COLOUR_MAX], [40, 100], [50, 90]], extra: { [PAR.FX_DIST_TYPE]: 2 } }, { type: 2, amount: [25, 50], p: [[20, 90], [0, 0], [0, 0], [0, 0]] }] },
  glitch: { decay: 0.7, drive: 20, fm: 1.4, rate: [20, 127], lfo: 0.55, fx: [{ type: 2, amount: [20, 50], p: [[30, 110], [0, 0], [0, 0], [0, 0]] }, { type: 4, amount: [25, 45], p: [[10, 40], [10, 40], [60, 110], [50, 90]], extra: { [PAR.FX_DELAY_TYPE]: 1 } }] },
  dub: { decay: 1.35, drive: 5, fm: 0.8, lfo: 0.2, fx: [{ type: 4, amount: [30, 50], p: [[60, 100], [60, 100], [40, 80], [70, 100]], extra: { [PAR.FX_DELAY_TYPE]: 1 } }] },
};

/**
 * What each CHARACTER does to each archetype: keys listed here replace the archetype's range
 * or menu (the rest of the archetype stays). This is where MACHINE, ELECTRO, ACOUSTIC,
 * INDUSTRIAL, GLITCH and DUB stop being the same drum with different multipliers.
 */
const FLAVOUR_TUNING: Record<KitFlavour, Partial<Record<Archetype, Recipe>>> = {
  // classic drum machine: clean, tight, little FM
  machine: {
    kick: { wave: { pick: [0] }, pAmt: [55, 95], pDecay: [14, 30], decay: [16, 26], fmAmt: [0, 6], drive: [0, 14], tWave: { pick: [5, 10, 2] }, ftype: { pick: [0] } },
    tom: { wave: { pick: [0] }, fmAmt: [0, 10], decay: [14, 24], drive: [0, 12] },
    snare: { wave: { pick: [1] }, noiseMix: [95, 125], decay: [9, 16], drive: [0, 25], coarse: [48, 60] },
    clap: { decay: [9, 14], repeat: [3, 5] },
    hat: { wave: { pick: [3] }, m1wave: { pick: [3] }, m2wave: { pick: [4] }, decay: [2, 5], decayOpen: [14, 26], drive: [0, 12], cutoff: [85, 118] },
    cymbal: { decay: [40, 60], drive: [0, 15] },
  },
  // analog 808-ish: long, round, saturated warmth
  electro: {
    kick: { wave: { pick: [0, 0, 1] }, coarse: [22, 30], pAmt: [60, 100], pDecay: [24, 44], decay: [26, 42], slope: [30, 70], fmAmt: [0, 8], tWave: { pick: [0, 5, 13] }, cutoff: [85, 127], ftype: { pick: [0, 6] }, drive: [0, 28] },
    tom: { wave: { pick: [0, 1] }, coarse: [40, 58], pAmt: [35, 70], pDecay: [24, 50], decay: [20, 34] },
    snare: { wave: { pick: [0, 1, 1] }, coarse: [44, 56], noiseMix: [92, 120], noiseFreq: [80, 115], decay: [12, 24], pAmt: [30, 80], pDecay: [10, 28], cutoff: [95, 127], ftype: { pick: [0, 0, 2] } },
    clap: { decay: [12, 22], repeat: [2, 5], noiseFreq: [95, 125], ftype: { pick: [2, 2, 3] } },
    hat: { wave: { pick: [2, 3, 5] }, m1wave: { pick: [2, 3] }, m2wave: { pick: [4, 3] }, decay: [3, 9], decayOpen: [16, 36], cutoff: [70, 105], ftype: { pick: [1, 2] } },
    cymbal: { decay: [50, 80], cutoff: [55, 100] },
  },
  // minimal, dry, natural: short, plain, noisy snares, rim and tom transients
  acoustic: {
    kick: { wave: { pick: [0, 1] }, coarse: [28, 40], pAmt: [30, 65], pDecay: [8, 20], decay: [10, 20], fmAmt: [0, 4], tVol: [40, 100], tWave: { pick: [2, 5, 6, 10] }, drive: [0, 12] },
    tom: { wave: { pick: [0, 1] }, pAmt: [20, 45], pDecay: [8, 20], decay: [10, 18], fmAmt: [0, 6], tWave: { pick: [12, 6, 2] } },
    snare: { wave: { pick: [1] }, noiseMix: [100, 127], noiseFreq: [100, 127], decay: [6, 13], pAmt: [10, 40], tWave: { pick: [11, 6, 2] }, tVol: [50, 100], drive: [0, 25] },
    clap: { decay: [7, 12], repeat: [3, 6], noiseMix: [100, 127] },
    hat: { wave: { pick: [3] }, m1amt: [40, 90], m2amt: [70, 127], m2wave: { pick: [4] }, decay: [2, 5], decayOpen: [10, 22], cutoff: [80, 118], drive: [0, 6] },
    cymbal: { decay: [35, 55], m2wave: { pick: [4] } },
  },
  // driven, metallic, inharmonic
  industrial: {
    kick: { wave: { pick: [1, 2, 3, 0] }, coarse: [24, 38], pAmt: [70, 127], pDecay: [8, 24], decay: [14, 28], fmAmt: [25, 80], fmFreq: [20, 90], fmWave: { pick: [2, 3, 4] }, drive: [30, 90], fdrive: [25, 80] },
    tom: { wave: { pick: [1, 2, 3] }, fmAmt: [30, 90], drive: [30, 85], fdrive: [20, 70] },
    snare: { wave: { pick: [2, 3, 1] }, noiseMix: [95, 127], noiseFreq: [60, 110], decay: [10, 26], drive: [40, 95], ftype: { pick: [2, 3, 4, 5] }, reso: [30, 85], cutoff: [70, 120], fdrive: [20, 70] },
    clap: { drive: [40, 90], ftype: { pick: [2, 3, 4] }, reso: [30, 80], fdrive: [20, 60] },
    hat: { m1amt: [90, 127], m2amt: [90, 127], m1freq: [40, 127], m2freq: [40, 127], wave: { pick: [3, 2, 5] }, ftype: { pick: [2, 4, 5] }, drive: [30, 90], decay: [2, 10], reso: [25, 80] },
    cymbal: { m1amt: [90, 127], m2amt: [90, 127], decay: [40, 75], drive: [30, 90], ftype: { pick: [2, 4, 5] }, reso: [25, 80] },
  },
  // digital: crushed, extreme sweeps, short decays, FM at odd ratios
  glitch: {
    kick: { wave: { pick: [0, 3, 5] }, pAmt: [85, 127], pDecay: [4, 14], decay: [6, 14], fmAmt: [30, 100], fmFreq: [60, 127], fmWave: { pick: [0, 3, 4] }, tWave: { pick: [2, 4, 7, 13] }, tVol: [50, 110], drive: [10, 60] },
    tom: { pAmt: [60, 127], pDecay: [4, 16], decay: [5, 13], fmAmt: [30, 100], fmFreq: [50, 127] },
    snare: { wave: { pick: [3, 5, 1] }, decay: [4, 11], noiseMix: [85, 127], repeat: { pick: [0, 1, 2, 3] }, tWave: { pick: [4, 13, 2] }, tVol: [50, 110], drive: [20, 70] },
    clap: { decay: [4, 9], repeat: [4, 8] },
    hat: { decay: [1, 3], decayOpen: [6, 14], m1freq: [30, 127], m2freq: [30, 127], wave: { pick: [5, 3] } },
    cymbal: { decay: [22, 40], wave: { pick: [5, 3] } },
  },
  // dub: deep, slow, dark, with room to ring
  dub: {
    kick: { wave: { pick: [0] }, coarse: [20, 30], pAmt: [40, 80], pDecay: [26, 50], decay: [28, 48], slope: [40, 80], fmAmt: [0, 6], cutoff: [70, 100], ftype: { pick: [0, 6] }, drive: [0, 20] },
    tom: { wave: { pick: [0] }, decay: [22, 36], pAmt: [30, 60], pDecay: [28, 55], cutoff: [60, 95] },
    snare: { wave: { pick: [0, 1] }, coarse: [38, 52], noiseMix: [85, 115], noiseFreq: [60, 100], decay: [16, 30], cutoff: [70, 105], ftype: { pick: [0, 2] }, drive: [0, 25] },
    clap: { decay: [13, 24], cutoff: [50, 90], ftype: { pick: [2, 2, 0] } },
    hat: { decay: [3, 7], decayOpen: [18, 38], cutoff: [55, 95], ftype: { pick: [1, 2] }, m1amt: [40, 90], m2amt: [50, 100], drive: [0, 10] },
    cymbal: { decay: [55, 80], cutoff: [45, 85] },
  },
};

/** The recipe of an archetype in a CHARACTER. */
export function recipeFor(archetype: Archetype, flavour: KitFlavour): Recipe {
  return { ...ARCHETYPES[archetype], ...(FLAVOUR_TUNING[flavour]?.[archetype] ?? {}) };
}

/** Version of the kit generator: bump when the same seed, CHARACTER and WILDNESS would make a different kit. */
export const KIT_GENERATOR = 2;

/** The WILDNESS a kit is generated with when none is given: the recipes as written. */
export const KIT_WILDNESS_DEFAULT = 0.5;

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

/** How wide WILDNESS draws around the middle of a range: .4 at 0, 1 at .5 (the range as written), 1.9 at 1. */
const widthAt = (w: number): number => (w < 0.5 ? 0.4 + 1.2 * w : 1 + 1.8 * (w - 0.5));

/** Wildness is not loudness or harshness: these keep the recipe's own range at any WILDNESS. */
const NO_WIDEN: ReadonlySet<Key> = new Set<Key>(['vol', 'drive', 'fdrive', 'reso', 'pan', 'rate', 'velAmt', 'velVol', 'lfoDepth', 'attack']);

/** Every choice of a menu, for the high-WILDNESS draw outside the archetype's usual picks. */
const WILD_MENU: Partial<Record<Key, number[]>> = {
  wave: [0, 1, 2, 3, 4, 5],
  fmWave: [0, 1, 2, 3, 4, 5],
  m1wave: [0, 1, 2, 3, 4, 5],
  m2wave: [0, 1, 2, 3, 4, 5],
  tWave: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
  ftype: [0, 1, 2, 3, 4, 5, 6],
  fmMode: [0, 1],
};

/** The picks that appear most often in a list (a pick list repeats its usual choices). */
const usual = (pick: number[]): number[] => {
  const n = new Map<number, number>();
  for (const v of pick) n.set(v, (n.get(v) ?? 0) + 1);
  const top = Math.max(...n.values());
  return [...n].filter(([, c]) => c === top).map(([v]) => v);
};

/** One value of a recipe key at a WILDNESS: narrow and usual when low, wide and open when high. */
function drawAt(key: Key, spec: Spec, rng: Rng, w: number): number {
  if (isRange(spec)) {
    if (NO_WIDEN.has(key)) return draw(spec, rng);
    const c = (spec[0] + spec[1]) / 2;
    const h = ((spec[1] - spec[0]) / 2) * widthAt(w);
    return clamp127(rng.range(c - h, c + h + 0.999));
  }
  const menu = WILD_MENU[key];
  if (menu && w > 0.65 && rng.chance((w - 0.65) * 1.7)) return rng.pick(menu);
  return rng.pick(w < 0.35 ? usual(spec.pick) : spec.pick);
}

/** Bounds a mutation may move a value in (the archetype's range, widened a little, more so at high WILDNESS). */
function bounds(spec: Spec, w = KIT_WILDNESS_DEFAULT): [number, number] {
  if (isRange(spec)) {
    const c = (spec[0] + spec[1]) / 2;
    const h = ((spec[1] - spec[0]) / 2) * widthAt(w);
    const pad = (spec[1] - spec[0]) * 0.15 + 2;
    return [clamp127(c - h - pad), clamp127(c + h + pad)];
  }
  return [Math.min(...spec.pick), Math.max(...spec.pick)];
}

/** Other archetypes a voice can be designed as when WILDNESS asks for an unexpected identity. */
const IDENTITIES: Archetype[][] = [
  ['kick', 'tom', 'perc', 'zap'],
  ['kick', 'tom', 'perc', 'zap'],
  ['kick', 'tom', 'perc', 'zap'],
  ['snare', 'clap'],
  ['hat', 'cymbal'],
  ['hat', 'cymbal'],
];

export interface VoiceDesign {
  archetype: Archetype;
  values: Partial<Record<Key, number>>;
}

/**
 * Design one voice from scratch. WILDNESS (default .5) is how strictly it follows the archetype:
 * see the header. The archetype in the result is the one the voice was actually designed as,
 * which at high WILDNESS can differ from the one asked for.
 */
export function designVoice(voice: number, archetype: Archetype, flavour: KitFlavour, rng: Rng, wildness: number = KIT_WILDNESS_DEFAULT): VoiceDesign {
  const w = Math.max(0, Math.min(1, wildness));
  // an unexpected identity, more often the wilder it gets
  if (w > 0.7 && rng.chance((w - 0.7) * 1.5)) {
    const others = (IDENTITIES[voice] ?? []).filter((a) => a !== archetype);
    if (others.length) archetype = rng.pick(others);
  }
  const recipe = recipeFor(archetype, flavour);
  const lean = FLAVOURS[flavour];
  const keys = voiceKeys(voice);
  const values: Partial<Record<Key, number>> = {};
  for (const [k, spec] of Object.entries(recipe) as [Key, Spec][]) {
    if (keys[k] === undefined) continue;
    values[k] = drawAt(k, spec, rng, w);
  }
  // flavour leanings
  const dec = lean.decay ?? 1;
  for (const k of ['decay', 'decayOpen'] as const) if (values[k] !== undefined) values[k] = clampTo(recipe[k], values[k]! * dec, w);
  if (values.drive !== undefined) values.drive = clampTo(recipe.drive, values.drive + (lean.drive ?? 0) * rng.next());
  const fm = lean.fm ? lean.fm * (0.6 + 0.8 * w) : 0.6 + 0.8 * w;
  for (const k of ['fmAmt', 'm1amt', 'm2amt'] as const) if (values[k] !== undefined) values[k] = clampTo(recipe[k], values[k]! * fm, w);
  values.rate = lean.rate && rng.chance(0.8 * w) ? clamp127(rng.range(lean.rate[0], lean.rate[1])) : 127;
  // the defaults of the controls the archetype leaves alone
  values.attack ??= 0;
  values.velVol = 1;
  values.velAmt = 0;
  values.pan = 63;
  values.fdrive ??= rng.chance(0.6 * w) ? clamp127(rng.range(0, 40)) : 0;
  if (keys.pwm !== undefined) values.pwm ??= clamp127(rng.range(0, 90));
  if (keys.fine !== undefined) values.fine ??= clamp127(rng.range(56, 70));
  // a low-pass over a noise voice shuts the noise away (measured: cutoff 78 leaves a snare at 250 Hz and 5 % noise)
  if ((archetype === 'snare' || archetype === 'clap') && flavour !== 'dub' && w < 0.8 && (values.ftype === 0 || values.ftype === 6) && values.cutoff !== undefined) values.cutoff = Math.max(values.cutoff, 100);
  // the two toms are two pitches: the low tom (voice 1) a little under, the high tom (voice 2) well over the recipe's middle
  if (archetype === 'tom' && values.coarse !== undefined) values.coarse = clamp127(values.coarse + (voice === 2 ? 6 : voice === 1 ? -4 : 0));
  // unconventional envelopes and pitch behaviour, from a high WILDNESS: swells, sirens, rolls
  if (w > 0.6) {
    const p = (w - 0.6) * 1.5;
    if (rng.chance(p * 0.5)) values.attack = rng.irange(3, 16);
    if (values.pAmt !== undefined && rng.chance(p * 0.5)) {
      values.pAmt = rng.irange(90, 127);
      values.pDecay = rng.irange(40, 90);
    }
    if (keys.repeat !== undefined && archetype !== 'clap' && rng.chance(p * 0.4)) values.repeat = rng.irange(2, 8);
    if (values.slope !== undefined && rng.chance(p * 0.4)) values.slope = rng.irange(0, 127);
  }
  // an LFO, sometimes
  if (rng.chance(Math.min(0.9, (lean.lfo ?? 0.1) * (0.3 + 1.4 * w)))) {
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

/** v kept inside the range of a recipe key (widened with WILDNESS when it is given). */
function clampTo(spec: Spec | undefined, v: number, w?: number): number {
  if (!spec) return clamp127(v);
  const [lo, hi] = isRange(spec) ? (w === undefined ? spec : bounds(spec, w)) : [Math.min(...spec.pick), Math.max(...spec.pick)];
  return clamp127(Math.max(lo, Math.min(hi, v)));
}

/** LFO targets that make musical sense per archetype. */
function lfoTarget(voice: number, a: Archetype, rng: Rng): number {
  const k = voiceKeys(voice);
  const opts: (number | undefined)[] = a === 'hat' || a === 'cymbal' ? [k.cutoff, k.m1freq, k.coarse, k.decay] : a === 'kick' ? [k.cutoff, k.pAmt, k.decay] : [k.cutoff, k.coarse, k.fmAmt, k.pAmt, k.noiseMix];
  const ok = opts.filter((x): x is number => x !== undefined);
  return ok.length ? rng.pick(ok) : 0;
}

/** The LFO target a voice of this archetype would get (SOUND DISCOVERY draws it for its candidates). */
export const lfoTargetFor = lfoTarget;

/** Is this parameter a menu (a waveform, a filter type) rather than a continuous control? Blends take the one or the other, never a value between. */
export function isMenuKey(archetype: Archetype, key: Key): boolean {
  const spec = ARCHETYPES[archetype][key];
  return spec ? !isRange(spec) : MENU_KEYS.has(key);
}
const MENU_KEYS: ReadonlySet<Key> = new Set<Key>(['wave', 'fmWave', 'fmMode', 'm1wave', 'm2wave', 'tWave', 'ftype', 'lfoWave', 'lfoSync', 'lfoRetrig']);

/**
 * Where a voice's pitch must land when its track is scale-locked: the scale and the track's synth
 * note (60 plays the voice's own pitch). Only the tom-like voices (0-2) get one: for the others
 * the oscillator is not the pitch you hear (see src/music/tuning.ts).
 */
export interface VoicePitchPlan {
  spec: ScaleSpec;
  note: number;
}

/** COARSE as the oscillator's MIDI note put on the nearest scale note, counting the synth note. */
export function snapCoarse(plan: VoicePitchPlan, coarse: number): number {
  const nominal = coarse + (plan.note - 60);
  return clamp127(coarse + nearestInScale(plan.spec, nominal) - nominal);
}

export interface KitGenOptions {
  seed: number;
  flavour: KitFlavour;
  /** roles of the tracks using each voice */
  voiceRoles: string[][];
  locks: SoundLocks;
  /** also design the FX bus */
  fx?: boolean;
  /** scale-locked voices: their oscillator pitch is chosen from (or kept on) the scale */
  pitch?: (voice: number) => VoicePitchPlan | null;
  /** 0-1: how strictly voices follow their archetype (default KIT_WILDNESS_DEFAULT) */
  wildness?: number;
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

/** Seed of the nth design of a voice: the first (variant 0) is the kit's own, the rest are the alternatives the engine check may choose from. */
export const voiceSeed = (seed: number, voice: number, variant: number): number => (variant === 0 ? hash32(seed, SALT.kit, voice) : hash32(seed, SALT.kit, voice, 7000 + variant));

/**
 * One voice of `kit` designed afresh (variant 0 is what GENERATE KIT makes; variants 1, 2, ... are
 * other designs of the same voice for the same seed, CHARACTER and WILDNESS). Locked parameters are
 * kept and a scale-locked voice stays on its scale. Returns the designed voice's archetype.
 */
export function designVoiceInto(kit: SynthKit, voice: number, o: KitGenOptions, variant = 0): Archetype {
  const locked = new Set(o.locks.params);
  const rng = new Rng(voiceSeed(o.seed, voice, variant));
  const a = archetypeFor(voice, o.voiceRoles[voice] ?? []);
  const d = designVoice(voice, a, o.flavour, rng, o.wildness);
  const plan = o.pitch?.(voice);
  if (plan && d.values.coarse !== undefined) d.values.coarse = snapCoarse(plan, d.values.coarse);
  apply(kit, voice, d, locked);
  kit.lfoTarget[voice] = (d.values.lfoDepth ?? 0) > 0 ? lfoTarget(voice, d.archetype, rng) : 0;
  kit.velTarget[voice] = 0;
  return d.archetype;
}

/** GENERATE KIT: every unlocked voice designed afresh. */
export function generateKit(base: SynthKit, o: KitGenOptions): SynthKit {
  const kit: SynthKit = { params: base.params.slice(), lfoTarget: base.lfoTarget.slice(), velTarget: base.velTarget.slice() };
  const locked = new Set(o.locks.params);
  for (let v = 0; v < 6; v++) {
    if (o.locks.voices[v]) continue;
    designVoiceInto(kit, v, o, 0);
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
  tameFx(kit.params, locked);
}

/**
 * MUTATE: controlled changes. Each unlocked parameter of the chosen voices moves with
 * probability ~amount, by a step proportional to amount, inside its archetype's bounds;
 * menus (waveforms, filter types) change rarely.
 */
export function mutateKit(base: SynthKit, o: KitGenOptions & { amount: number; voices?: number[] }): SynthKit {
  const kit: SynthKit = { params: base.params.slice(), lfoTarget: base.lfoTarget.slice(), velTarget: base.velTarget.slice() };
  const locked = new Set(o.locks.params);
  const amount = Math.max(0, Math.min(1, o.amount));
  const voices = o.voices ?? [0, 1, 2, 3, 4, 5];
  for (const v of voices) {
    if (o.locks.voices[v]) continue;
    const rng = new Rng(hash32(o.seed, SALT.kit, 1000 + v));
    const a = archetypeFor(v, o.voiceRoles[v] ?? []);
    const recipe = recipeFor(a, o.flavour);
    const keys = voiceKeys(v);
    const plan = o.pitch?.(v);
    for (const [k, spec] of Object.entries(recipe) as [Key, Spec][]) {
      const p = keys[k];
      if (p === undefined || locked.has(p)) continue;
      if (!rng.chance(0.25 + amount * 0.6)) continue;
      if (isRange(spec)) {
        const [lo, hi] = bounds(spec, o.wildness);
        const cur = kit.params[p]!;
        const step = rng.bell() * (hi - lo) * (0.08 + amount * 0.4);
        kit.params[p] = clamp127(Math.max(lo, Math.min(hi, cur + step)));
      } else if (rng.chance(amount * 0.35)) {
        kit.params[p] = rng.pick(spec.pick);
      }
      // a scale-locked voice keeps its pitch on the scale: only a COARSE that moved is snapped
      if (plan && k === 'coarse' && kit.params[p] !== base.params[p]) kit.params[p] = snapCoarse(plan, kit.params[p]!);
    }
  }
  if (voices.length === 6 && rng01(o.seed) < amount * 0.25 && !locked.has(PAR.FX_TYPE)) {
    const r = new Rng(hash32(o.seed, SALT.kit, 1099));
    for (const p of [PAR.FX_P1, PAR.FX_P2, PAR.FX_P3, PAR.FX_P4]) if (!locked.has(p)) kit.params[p] = clamp127(kit.params[p]! + r.bell() * 25 * amount);
    tameFx(kit.params, locked);
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
  // a pull back towards HOME can leave a scale-locked voice's pitch between notes: put it back on one
  for (let v = 0; v < 6; v++) {
    const plan = o.pitch?.(v);
    const par = voiceKeys(v).coarse;
    if (plan && par !== undefined && !o.locks.params.includes(par) && !o.locks.voices[v] && step.params[par] !== current.params[par]) step.params[par] = snapCoarse(plan, step.params[par]!);
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
