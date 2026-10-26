/**
 * Instrument-aware sound design: PROFILES, CHARACTER and WILDNESS.
 *
 *   PROFILE    what a voice should be: one of CLATTER's ten drum roles (kick, snare, clap, closed
 *              hat, open hat, low tom, high tom, cymbal, percussion, FX), each written for the three
 *              LXR voice models it can land on (DRUM: voices 1-3, an oscillator with FM, a pitch
 *              envelope and a transient; SNARE: voice 4, tone plus noise and envelope repeats; METAL:
 *              voices 5-6, three oscillators for cymbal and hat spectra). A kick on the metal model is
 *              the best kick that model can make, not the kick recipe forced onto it.
 *   CHARACTER  how it should sound: CLASSIC, ANALOG, DIGITAL, INDUSTRIAL, MINIMAL, EXPERIMENTAL lean
 *              the distributions (waveforms, FM, brightness, drive, decimation, transients, decay,
 *              LFOs, the FX bus); they are not presets.
 *   WILDNESS   0-1: how far the design may leave the profile. It is a continuous transformation of
 *              the distributions, not a range knob: as it rises the spreads widen, the bounds open
 *              towards the whole parameter range (each at its own rate), menus drift towards any
 *              choice, extreme EXCURSIONS of single parameters become likely, a voice may CROSS with
 *              another profile, and the relationships that make a sound coherent (COHERE) are
 *              enforced less and less. Only what would make a voice silent or broken stays enforced.
 *
 * Values are drawn as truncated normals [mean, spread, lo, hi] in firmware units, calibrated against
 * the engine itself (src/sound/analysis.ts; see docs/KIT_GENERATION.md): coarse is the oscillator's
 * MIDI note (24 = 33 Hz); drum decay 10/24/45 ≈ 125/340/790 ms; hat decay 2/5/8/15 ≈ 25/60/95/190 ms;
 * open hat 12/20/30/45 ≈ 150/260/440/770 ms; slope 0 collapses any envelope to a few ms; FM only
 * acts with MIX MODE 1; a low-pass dulls the snare's noise.
 *
 * Deterministic: everything is drawn from the Rng it is given.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import { CHARACTERS, ROLES, type Character, type KitGenRecord, type KitGenSettings, type Role } from '../model/types';
import type { KitFlavour } from '../rhythm/styles';
import { hash32, Rng } from '../rhythm/rng';
import type { Key } from './kitgen';

export type Profile = Role;
export const PROFILES: readonly Profile[] = ROLES;
export const PROFILE_LABEL: Record<Profile, string> = { kick: 'KICK', snare: 'SNARE', clap: 'CLAP', chat: 'CLOSED HAT', ohat: 'OPEN HAT', ltom: 'LOW TOM', htom: 'HIGH TOM', cymbal: 'CYMBAL', perc: 'PERCUSSION', fx: 'FX' };

export type Model = 'drum' | 'snare' | 'metal';
export const modelOf = (voice: number): Model => (voice < 3 ? 'drum' : voice === 3 ? 'snare' : 'metal');

/** A truncated normal [mean, spread, lo, hi], or weights for menu values. */
type Dist = [number, number, number, number];
type Menu = { w: Record<number, number> };
type Spec = Dist | Menu;
type Recipe = Partial<Record<Key, Spec>>;
const isMenu = (s: Spec): s is Menu => !Array.isArray(s);
const M = (w: Record<number, number>): Menu => ({ w });

/** How many values each menu has (wildness opens a menu to all of them). */
const MENU_SIZE: Partial<Record<Key, number>> = { wave: 6, fmWave: 6, m1wave: 6, m2wave: 6, fmMode: 2, ftype: 8, tWave: 14, repeat: 8 };

/** Never crossed, at any wildness: what would make a voice silent, stuck or broken. */
const HARD: Partial<Record<Key, [number, number]>> = { slope: [8, 127], decay: [1, 127], decayOpen: [2, 127], vol: [70, 127], attack: [0, 60], repeat: [0, 12] };

// waveforms: 0 SINE 1 TRI 2 SAW 3 REC 4 NOISE 5 PWM
// filters: 0 LP 1 HP 2 BP 3 UBP 4 NOTCH 5 PEAK 6 LP2 7 OFF
// transients: 0 SNAP 1 OFFSET 2 CLICK 3 CLICK2 4 TICK 5 KICK 6 RIM 7 DROP 8 HAT 9 CLAP 10 KICK2 11 SNARE 12 TOM 13 SNAP2

/** Defaults for keys a recipe leaves out. */
const NEUTRAL: Recipe = {
  fine: [63, 2, 58, 68],
  pwm: [60, 22, 15, 110],
  attack: [0, 0.6, 0, 2],
  pSlope: [30, 12, 5, 70],
  tFreq: [50, 12, 25, 85],
  reso: [12, 10, 0, 45],
  fdrive: [3, 6, 0, 25],
  drive: [10, 10, 0, 40],
  vol: [118, 4, 105, 127],
  rate: [127, 0, 127, 127],
};

const TOM_DRUM = (coarse: Dist, decay: Dist): Recipe => ({
  wave: M({ 0: 5, 1: 2 }), coarse, pAmt: [40, 12, 15, 65], pDecay: [28, 7, 15, 45], pSlope: [30, 12, 10, 55], decay, slope: [42, 10, 28, 70],
  fmAmt: [8, 8, 0, 30], fmFreq: [50, 15, 25, 80], fmWave: M({ 0: 3, 1: 2 }), fmMode: M({ 0: 3, 1: 1 }),
  tWave: M({ 12: 3, 0: 2, 2: 1, 6: 1 }), tVol: [30, 14, 5, 60], cutoff: [110, 10, 82, 127], ftype: M({ 0: 5, 6: 2, 7: 2 }), drive: [10, 10, 0, 35],
});
const HAT_DRUM = (decay: Dist, slope: Dist): Recipe => ({
  wave: M({ 3: 2, 0: 1, 2: 1 }), coarse: [94, 7, 80, 110], pAmt: [4, 4, 0, 15], pDecay: [8, 4, 2, 20], decay, slope,
  fmAmt: [118, 7, 98, 127], fmFreq: [110, 10, 85, 127], fmWave: M({ 4: 4, 3: 1 }), fmMode: M({ 1: 1 }),
  tWave: M({ 8: 3, 4: 2 }), tVol: [25, 12, 5, 50], cutoff: [88, 10, 65, 115], ftype: M({ 1: 6, 2: 1 }), drive: [6, 6, 0, 25],
});
const NOISY_SNARE = (decay: Dist, slope: Dist): Recipe => ({
  wave: M({ 3: 1, 0: 1 }), coarse: [82, 8, 66, 100], noiseFreq: [124, 3, 112, 127], noiseMix: [122, 4, 110, 127], pAmt: [4, 4, 0, 15], pDecay: [8, 3, 2, 18], decay, slope, repeat: M({ 0: 1 }),
  tWave: M({ 8: 3, 4: 2 }), tVol: [20, 12, 0, 45], cutoff: [96, 10, 72, 118], ftype: M({ 1: 5, 7: 1 }), drive: [8, 8, 0, 30],
});
const HAT_METAL = (decay: Dist, decayOpen: Dist): Recipe => ({
  wave: M({ 3: 4, 0: 1, 2: 1, 5: 1 }), coarse: [92, 9, 74, 112], m1wave: M({ 3: 3, 0: 1, 2: 1, 5: 1 }), m1freq: [104, 14, 72, 127], m1amt: [100, 14, 72, 127],
  m2wave: M({ 4: 4, 3: 2 }), m2freq: [110, 11, 82, 127], m2amt: [104, 14, 76, 127], attack: [0, 0.4, 0, 1], decay, decayOpen, slope: [58, 12, 38, 92],
  tWave: M({ 8: 3, 4: 2, 0: 1 }), tVol: [18, 12, 0, 45], tFreq: [70, 14, 40, 100], cutoff: [86, 11, 58, 118], reso: [12, 10, 0, 40], ftype: M({ 1: 6, 2: 1, 3: 1 }), drive: [8, 8, 0, 30],
});
const TOM_METAL = (coarse: Dist, decay: Dist): Recipe => ({
  wave: M({ 0: 5, 1: 2 }), coarse, m1wave: M({ 0: 3, 1: 1 }), m1freq: [45, 15, 15, 80], m1amt: [22, 12, 0, 45], m2wave: M({ 0: 2, 1: 1 }), m2freq: [40, 15, 10, 80], m2amt: [10, 8, 0, 30],
  decay, decayOpen: decay, slope: [52, 10, 36, 80], repeat: M({ 0: 1 }), tWave: M({ 12: 3, 0: 2 }), tVol: [30, 14, 5, 60], cutoff: [108, 10, 82, 127], ftype: M({ 0: 4, 7: 2, 6: 1 }),
});
const TOM_SNARE = (coarse: Dist, decay: Dist): Recipe => ({
  wave: M({ 0: 4, 1: 2 }), coarse, noiseFreq: [80, 20, 40, 120], noiseMix: [14, 8, 0, 32], pAmt: [42, 12, 18, 66], pDecay: [24, 6, 12, 40], decay, slope: [42, 10, 28, 70], repeat: M({ 0: 1 }),
  tWave: M({ 12: 3, 0: 2 }), tVol: [30, 14, 5, 60], cutoff: [108, 10, 82, 127], ftype: M({ 0: 4, 7: 2 }), drive: [10, 10, 0, 35],
});

const RECIPES: Record<Model, Record<Profile, Recipe>> = {
  drum: {
    kick: {
      wave: M({ 0: 6, 1: 2, 5: 0.4 }), coarse: [29, 3.5, 22, 38], pAmt: [78, 16, 45, 115], pDecay: [26, 6, 16, 42], pSlope: [35, 14, 10, 70], attack: [0, 0.6, 0, 2], decay: [22, 5, 12, 36], slope: [46, 12, 26, 80],
      fmAmt: [6, 6, 0, 24], fmFreq: [45, 12, 20, 75], fmWave: M({ 0: 3, 1: 2 }), fmMode: M({ 0: 4, 1: 1 }),
      tWave: M({ 0: 2, 2: 2, 3: 1, 5: 2, 10: 2, 13: 1 }), tVol: [45, 16, 12, 85], tFreq: [45, 12, 20, 70], cutoff: [112, 10, 88, 127], reso: [8, 8, 0, 30], ftype: M({ 0: 5, 6: 2, 7: 2 }), drive: [12, 12, 0, 45], vol: [122, 3, 112, 127],
    },
    ltom: TOM_DRUM([43, 3, 36, 50], [19, 4, 12, 28]),
    htom: TOM_DRUM([54, 3, 47, 62], [16, 3, 10, 24]),
    snare: {
      wave: M({ 1: 3, 0: 2 }), coarse: [50, 4, 42, 60], pAmt: [40, 14, 15, 70], pDecay: [15, 5, 6, 28], decay: [12, 3, 7, 20], slope: [36, 10, 20, 60],
      fmAmt: [100, 16, 70, 127], fmFreq: [96, 14, 62, 127], fmWave: M({ 4: 6, 3: 1 }), fmMode: M({ 1: 1 }),
      tWave: M({ 11: 3, 2: 1, 6: 1 }), tVol: [45, 15, 15, 80], cutoff: [106, 12, 76, 127], ftype: M({ 7: 3, 1: 2, 2: 1, 3: 1 }), drive: [18, 12, 0, 50],
    },
    clap: {
      wave: M({ 0: 1, 1: 1 }), coarse: [58, 5, 48, 68], pAmt: [10, 8, 0, 30], pDecay: [10, 4, 3, 20], decay: [9, 2, 5, 15], slope: [22, 10, 10, 42],
      fmAmt: [116, 8, 95, 127], fmFreq: [106, 14, 72, 127], fmWave: M({ 4: 1 }), fmMode: M({ 1: 1 }),
      tWave: M({ 9: 4, 2: 1 }), tVol: [55, 14, 25, 90], cutoff: [86, 11, 62, 110], reso: [30, 14, 6, 60], ftype: M({ 2: 4, 3: 2, 1: 1 }), drive: [18, 12, 0, 45],
    },
    chat: HAT_DRUM([4, 1.4, 2, 7], [30, 10, 12, 55]),
    ohat: HAT_DRUM([15, 4, 8, 24], [52, 10, 34, 80]),
    cymbal: { ...HAT_DRUM([32, 6, 22, 46], [62, 10, 44, 92]), coarse: [86, 9, 70, 108], cutoff: [78, 12, 50, 108] },
    perc: {
      wave: M({ 0: 2, 1: 2, 2: 1, 3: 1, 5: 1 }), coarse: [70, 9, 55, 92], pAmt: [25, 15, 0, 60], pDecay: [12, 5, 4, 25], decay: [9, 3, 4, 16], slope: [35, 14, 12, 70],
      fmAmt: [55, 25, 10, 110], fmFreq: [76, 18, 40, 115], fmWave: M({ 0: 2, 1: 1, 2: 1, 3: 1 }), fmMode: M({ 1: 3, 0: 1 }),
      tWave: M({ 6: 2, 4: 2, 2: 1, 8: 1 }), tVol: [35, 15, 5, 70], cutoff: [100, 14, 62, 127], reso: [30, 18, 0, 80], ftype: M({ 0: 2, 2: 2, 5: 1, 7: 2 }), drive: [15, 14, 0, 55],
    },
    fx: {
      wave: M({ 0: 1, 2: 1, 3: 1, 5: 1 }), coarse: [84, 15, 50, 115], pwm: [64, 35, 0, 127], pAmt: [104, 16, 70, 127], pDecay: [14, 6, 4, 32], pSlope: [40, 25, 0, 90], decay: [13, 6, 5, 32], slope: [40, 18, 10, 80],
      fmAmt: [80, 30, 20, 127], fmFreq: [64, 30, 10, 120], fmWave: M({ 0: 1, 2: 1, 3: 1, 4: 1 }), fmMode: M({ 1: 3, 0: 1 }),
      tWave: M({ 0: 1, 7: 2, 13: 2 }), tVol: [50, 25, 10, 110], tFreq: [60, 30, 10, 120], cutoff: [92, 20, 50, 127], reso: [60, 25, 10, 110], ftype: M({ 0: 1, 2: 1, 3: 1, 5: 1 }), drive: [40, 24, 0, 100],
    },
  },
  snare: {
    snare: {
      wave: M({ 1: 3, 0: 2, 5: 1 }), coarse: [50, 4, 42, 60], noiseFreq: [116, 9, 92, 127], noiseMix: [80, 13, 55, 105], pAmt: [45, 15, 15, 80], pDecay: [14, 5, 6, 28], pSlope: [20, 10, 0, 40],
      decay: [13, 3, 8, 20], slope: [42, 12, 22, 72], repeat: M({ 0: 1 }), tWave: M({ 11: 3, 0: 1, 2: 1, 6: 1, 13: 1 }), tVol: [45, 15, 15, 80],
      cutoff: [104, 12, 78, 127], reso: [10, 10, 0, 40], ftype: M({ 7: 5, 1: 3, 3: 1 }), drive: [22, 12, 5, 55],
    },
    clap: {
      wave: M({ 0: 1, 1: 1 }), coarse: [58, 5, 48, 68], noiseFreq: [121, 5, 106, 127], noiseMix: [117, 7, 102, 127], pAmt: [8, 6, 0, 25], pDecay: [10, 4, 4, 20],
      decay: [10, 2.5, 6, 16], slope: [26, 10, 10, 45], repeat: [4.5, 1, 3, 6], tWave: M({ 9: 5, 2: 1 }), tVol: [40, 15, 10, 70],
      cutoff: [88, 10, 66, 110], reso: [30, 14, 10, 60], ftype: M({ 2: 4, 3: 2, 1: 2 }), drive: [20, 12, 5, 50],
    },
    kick: {
      wave: M({ 0: 5, 1: 1 }), coarse: [32, 3.5, 25, 40], noiseFreq: [60, 20, 20, 100], noiseMix: [6, 5, 0, 20], pAmt: [82, 14, 52, 115], pDecay: [24, 5, 14, 38],
      decay: [20, 4, 12, 30], slope: [46, 10, 28, 75], repeat: M({ 0: 1 }), tWave: M({ 5: 2, 10: 2, 0: 1 }), tVol: [40, 15, 10, 80], cutoff: [110, 10, 86, 127], ftype: M({ 0: 4, 7: 2 }), drive: [12, 10, 0, 40],
    },
    ltom: TOM_SNARE([43, 3, 36, 50], [17, 4, 11, 26]),
    htom: TOM_SNARE([54, 3, 47, 62], [14, 3, 9, 22]),
    chat: NOISY_SNARE([4, 1.4, 2, 7], [30, 10, 12, 55]),
    ohat: NOISY_SNARE([15, 4, 9, 24], [52, 10, 34, 80]),
    cymbal: { ...NOISY_SNARE([32, 6, 22, 46], [62, 10, 44, 92]), cutoff: [80, 12, 54, 110] },
    perc: {
      wave: M({ 0: 2, 1: 1, 3: 1, 5: 1 }), coarse: [68, 8, 52, 90], noiseFreq: [100, 20, 50, 127], noiseMix: [40, 25, 0, 100], pAmt: [25, 15, 0, 60], pDecay: [10, 4, 3, 22],
      decay: [8, 3, 4, 15], slope: [34, 12, 12, 65], repeat: M({ 0: 3, 1: 1, 2: 1 }), tWave: M({ 6: 2, 4: 2, 2: 1 }), tVol: [35, 15, 5, 70], cutoff: [100, 14, 62, 127], reso: [35, 20, 0, 85], ftype: M({ 2: 2, 7: 2, 5: 1, 1: 1 }),
    },
    fx: {
      wave: M({ 0: 1, 2: 1, 3: 1, 5: 1 }), coarse: [80, 18, 40, 115], noiseFreq: [64, 35, 0, 127], noiseMix: [64, 35, 0, 127], pAmt: [100, 20, 60, 127], pDecay: [14, 7, 3, 35], pSlope: [40, 25, 0, 90],
      decay: [14, 7, 4, 35], slope: [40, 18, 10, 80], repeat: [3, 2, 0, 8], tWave: M({ 7: 2, 13: 2, 1: 1 }), tVol: [50, 25, 0, 110], cutoff: [90, 20, 45, 127], reso: [55, 25, 10, 110], ftype: M({ 0: 1, 2: 1, 3: 1, 5: 1 }), drive: [40, 24, 0, 100],
    },
  },
  metal: {
    chat: HAT_METAL([4, 1.4, 2, 8], [24, 6, 14, 40]),
    ohat: HAT_METAL([6, 2, 3, 10], [29, 6, 18, 46]),
    cymbal: {
      wave: M({ 3: 3, 4: 1, 0: 1, 2: 1 }), coarse: [84, 12, 60, 112], m1wave: M({ 3: 3, 0: 1, 2: 1, 4: 1 }), m1freq: [96, 18, 60, 127], m1amt: [96, 16, 60, 127],
      m2wave: M({ 4: 3, 3: 2, 0: 1 }), m2freq: [100, 16, 60, 127], m2amt: [98, 16, 60, 127], attack: [0, 1, 0, 3], decay: [56, 11, 36, 90], decayOpen: [56, 11, 36, 90], slope: [72, 14, 46, 110], repeat: M({ 0: 1 }),
      tWave: M({ 8: 3, 4: 1, 0: 1 }), tVol: [15, 12, 0, 45], tFreq: [70, 14, 40, 100], cutoff: [70, 12, 45, 105], reso: [10, 10, 0, 40], ftype: M({ 1: 5, 2: 1, 3: 1 }), drive: [8, 8, 0, 30], vol: [114, 5, 100, 127],
    },
    kick: {
      wave: M({ 0: 5, 1: 1 }), coarse: [31, 3.5, 24, 40], m1wave: M({ 0: 1 }), m1freq: [30, 10, 5, 55], m1amt: [10, 7, 0, 25], m2wave: M({ 0: 1 }), m2freq: [25, 10, 5, 50], m2amt: [5, 5, 0, 18],
      decay: [22, 4, 14, 32], decayOpen: [22, 4, 14, 32], slope: [56, 10, 40, 82], repeat: M({ 0: 1 }), tWave: M({ 5: 2, 10: 2, 0: 1 }), tVol: [50, 15, 20, 90], cutoff: [104, 12, 80, 127], ftype: M({ 0: 5, 7: 1 }),
    },
    ltom: TOM_METAL([43, 3, 36, 50], [20, 4, 13, 28]),
    htom: TOM_METAL([54, 3, 47, 62], [17, 3, 11, 24]),
    snare: {
      wave: M({ 1: 2, 0: 1, 3: 1 }), coarse: [55, 5, 45, 66], m1wave: M({ 4: 1, 3: 1 }), m1freq: [80, 18, 40, 120], m1amt: [72, 15, 45, 100], m2wave: M({ 4: 1 }), m2freq: [110, 12, 80, 127], m2amt: [110, 10, 86, 127],
      decay: [10, 3, 6, 16], decayOpen: [10, 3, 6, 16], slope: [46, 10, 30, 70], repeat: M({ 0: 1 }), tWave: M({ 11: 3, 2: 1 }), tVol: [40, 15, 10, 75], cutoff: [100, 14, 70, 127], ftype: M({ 1: 3, 7: 2, 3: 1 }),
    },
    clap: {
      wave: M({ 4: 1, 3: 1 }), coarse: [70, 8, 55, 90], m1wave: M({ 4: 2, 3: 1 }), m1freq: [100, 15, 70, 127], m1amt: [110, 10, 85, 127], m2wave: M({ 4: 1 }), m2freq: [110, 12, 80, 127], m2amt: [115, 8, 95, 127],
      decay: [6, 2, 3, 10], decayOpen: [6, 2, 3, 10], slope: [30, 10, 15, 50], repeat: [4, 1, 2, 6], tWave: M({ 9: 4, 2: 1 }), tVol: [45, 15, 15, 80], cutoff: [86, 10, 62, 110], reso: [28, 14, 8, 55], ftype: M({ 2: 4, 3: 2 }),
    },
    perc: {
      wave: M({ 0: 2, 3: 1, 2: 1, 5: 1 }), coarse: [76, 10, 56, 100], m1wave: M({ 0: 1, 3: 1, 2: 1 }), m1freq: [70, 25, 20, 120], m1amt: [50, 25, 0, 100], m2wave: M({ 0: 1, 3: 1, 4: 1 }), m2freq: [70, 25, 20, 120], m2amt: [40, 25, 0, 100],
      decay: [7, 3, 3, 14], decayOpen: [7, 3, 3, 14], slope: [40, 14, 15, 70], repeat: M({ 0: 3, 1: 1 }), tWave: M({ 6: 2, 4: 2, 2: 1 }), tVol: [30, 15, 5, 65], cutoff: [98, 14, 60, 127], reso: [35, 20, 0, 85], ftype: M({ 2: 2, 1: 1, 7: 2, 5: 1 }),
    },
    fx: {
      wave: M({ 0: 1, 2: 1, 3: 1, 4: 1, 5: 1 }), coarse: [70, 25, 20, 120], m1wave: M({ 0: 1, 2: 1, 3: 1, 4: 1, 5: 1 }), m1freq: [64, 35, 0, 127], m1amt: [90, 30, 20, 127], m2wave: M({ 0: 1, 2: 1, 3: 1, 4: 1 }), m2freq: [64, 35, 0, 127], m2amt: [80, 30, 10, 127],
      decay: [20, 14, 3, 60], decayOpen: [30, 14, 6, 70], slope: [50, 25, 10, 110], repeat: [2, 3, 0, 8], tWave: M({ 7: 2, 13: 2, 1: 1 }), tVol: [45, 25, 0, 110], cutoff: [80, 25, 35, 127], reso: [60, 28, 5, 115], ftype: M({ 0: 1, 1: 1, 2: 1, 3: 1, 5: 1 }), drive: [40, 25, 0, 100],
    },
  },
};

// ---------------------------------------------------------------------------- character

export interface CharacterDef {
  label: string;
  help: string;
  /** added to wildness when relationships relax (EXPERIMENTAL is looser, MINIMAL tighter) */
  bias: number;
  /** multiplier on decay means */
  decay: number;
  /** added to drive and filter drive means */
  drive: number;
  fdrive: number;
  /** multiplier on FM and modulator amounts, and the weight of real FM (MIX MODE 1) */
  fm: number;
  fmMode1: number;
  /** added to filter cutoff and noise frequency means (brightness) */
  bright: number;
  reso: number;
  /** multiplier on transient level */
  trans: number;
  /** weight multipliers on oscillator waveforms (and modulator waveforms) */
  waves: Record<number, number>;
  /** weight multipliers on transient waveforms */
  trWaves: Record<number, number>;
  /** chance of sample-rate reduction, and how far it may go (127 = none) */
  crush: number;
  crushLo: number;
  /** chance of a voice LFO */
  lfo: number;
  /** semitones of extra pitch spread (unusual pitch relationships) */
  pitch: number;
  /** FX bus flavours to choose from, and the wet amount scale */
  fx: KitFlavour[];
  wet: number;
}

export const CHARACTER_DEFS: Record<Character, CharacterDef> = {
  classic: {
    label: 'CLASSIC', help: 'Recognisable electronic drum-machine sounds: the profiles as they are.',
    bias: 0, decay: 1, drive: 0, fdrive: 0, fm: 1, fmMode1: 1, bright: 0, reso: 0, trans: 1, waves: {}, trWaves: {}, crush: 0, crushLo: 127, lfo: 0.06, pitch: 0, fx: ['machine', 'electro'], wet: 1,
  },
  analog: {
    label: 'ANALOG', help: 'Rounded and warm: sines and triangles, little FM, softer transients, darker filters, no decimation.',
    bias: -0.03, decay: 1.12, drive: -4, fdrive: 4, fm: 0.4, fmMode1: 0.4, bright: -12, reso: 4, trans: 0.6, waves: { 0: 2.6, 1: 2.2, 2: 0.4, 3: 0.4, 4: 0.6, 5: 0.4 }, trWaves: { 0: 2, 12: 2, 5: 1.5, 10: 1.5, 2: 0.5, 4: 0.4, 8: 0.7, 6: 0.6 }, crush: 0, crushLo: 127, lfo: 0.08, pitch: 0, fx: ['acoustic', 'dub'], wet: 1,
  },
  digital: {
    label: 'DIGITAL', help: 'Bright, metallic and FM-rich: real FM, square and saw spectra, clicks, a little decimation.',
    bias: 0.02, decay: 0.95, drive: 0, fdrive: 0, fm: 1.7, fmMode1: 4, bright: 14, reso: 6, trans: 1.25, waves: { 2: 2, 3: 2.6, 5: 2.2, 0: 0.5, 1: 0.6 }, trWaves: { 2: 2, 3: 2, 4: 2.2, 8: 1.6, 0: 0.6, 12: 0.5 }, crush: 0.3, crushLo: 70, lfo: 0.15, pitch: 2, fx: ['electro', 'glitch'], wet: 1,
  },
  industrial: {
    label: 'INDUSTRIAL', help: 'Aggressive: hard transients, drive and filter drive, resonance, decimation, unusual pitch relationships, harsher spectra.',
    bias: 0.08, decay: 1.05, drive: 38, fdrive: 28, fm: 1.35, fmMode1: 2.5, bright: 6, reso: 16, trans: 1.5, waves: { 2: 2, 3: 2, 4: 1.6, 5: 1.6, 0: 0.6 }, trWaves: { 6: 2, 9: 1.5, 13: 2, 7: 1.6, 3: 1.6, 0: 0.6 }, crush: 0.55, crushLo: 40, lfo: 0.3, pitch: 5, fx: ['industrial'], wet: 1,
  },
  minimal: {
    label: 'MINIMAL', help: 'Short, restrained and sparse: short decays, little FM, little drive, no LFOs, a nearly dry FX bus.',
    bias: -0.1, decay: 0.6, drive: -8, fdrive: -3, fm: 0.4, fmMode1: 0.6, bright: 0, reso: -5, trans: 0.7, waves: { 0: 2, 1: 1.5 }, trWaves: { 2: 2, 4: 2, 0: 1 }, crush: 0, crushLo: 127, lfo: 0, pitch: 0, fx: ['machine'], wet: 0.35,
  },
  experimental: {
    label: 'EXPERIMENTAL', help: 'Unusual synthesis combinations and evolving timbres: LFOs, noise and PWM, resonance, odd transients, looser relationships.',
    bias: 0.2, decay: 1.2, drive: 10, fdrive: 10, fm: 1.5, fmMode1: 2, bright: 0, reso: 20, trans: 1.1, waves: { 4: 2, 5: 2, 2: 1.2 }, trWaves: { 7: 2, 13: 2, 1: 2 }, crush: 0.4, crushLo: 20, lfo: 0.6, pitch: 8, fx: ['glitch', 'dub', 'industrial'], wet: 1,
  },
};

export const defaultKitGen = (): KitGenSettings => ({ character: 'classic', wildness: 0.3, profiles: [null, null, null, null, null, null], hold: false, seed: 1 });

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

export function repairKitGen(v: unknown): KitGenSettings | undefined {
  if (!isObj(v)) return undefined;
  const d = defaultKitGen();
  const pr = Array.isArray(v.profiles) ? v.profiles : [];
  return {
    character: CHARACTERS.includes(v.character as Character) ? (v.character as Character) : d.character,
    wildness: typeof v.wildness === 'number' && Number.isFinite(v.wildness) ? Math.max(0, Math.min(1, v.wildness)) : d.wildness,
    profiles: [0, 1, 2, 3, 4, 5].map((i) => (PROFILES.includes(pr[i] as Profile) ? (pr[i] as Profile) : null)),
    hold: v.hold === true,
    seed: typeof v.seed === 'number' && Number.isInteger(v.seed) && v.seed > 0 ? v.seed >>> 0 : d.seed,
  };
}

export function repairKitGenRecord(v: unknown): KitGenRecord | undefined {
  if (!isObj(v) || v.v !== 2) return undefined;
  const pr = Array.isArray(v.profiles) ? v.profiles : [];
  return {
    v: 2,
    op: v.op === 'mutate' || v.op === 'voice' ? v.op : 'generate',
    seed: typeof v.seed === 'number' && Number.isFinite(v.seed) ? v.seed >>> 0 : 0,
    character: CHARACTERS.includes(v.character as Character) ? (v.character as Character) : 'classic',
    wildness: typeof v.wildness === 'number' && Number.isFinite(v.wildness) ? Math.max(0, Math.min(1, v.wildness)) : 0.3,
    profiles: [0, 1, 2, 3, 4, 5].map((i) => (PROFILES.includes(pr[i] as Profile) ? (pr[i] as Profile) : 'perc')),
  };
}

// ---------------------------------------------------------------------------- profile of a voice

const DRUM_ORDER: Profile[] = ['kick', 'ltom', 'htom', 'snare', 'clap', 'perc', 'fx', 'chat', 'ohat', 'cymbal'];

/** The profile a voice is designed as, from the roles of the tracks that play it. */
export function profileForVoice(voice: number, roles: readonly string[]): Profile {
  const has = (r: Profile) => roles.includes(r);
  if (voice === 5) return has('ohat') && !has('chat') ? 'ohat' : 'chat';
  if (voice === 4) return has('cymbal') || (!has('chat') && !has('ohat')) ? 'cymbal' : has('chat') ? 'chat' : 'ohat';
  if (voice === 3) return has('snare') || !roles.length ? 'snare' : (DRUM_ORDER.find(has) ?? 'snare');
  return DRUM_ORDER.find(has) ?? (voice === 0 ? 'kick' : voice === 1 ? 'ltom' : 'htom');
}

// ---------------------------------------------------------------------------- drawing

/** Gaussian (Box-Muller). */
function gauss(rng: Rng): number {
  const u = Math.max(1e-9, rng.next());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng.next());
}

const clamp127 = (v: number) => Math.max(0, Math.min(127, Math.round(v)));
const ease = (w: number) => Math.pow(Math.max(0, Math.min(1, w)), 1.6);

/** The recipe of a profile on a model, leaned by a character. */
export function recipeFor(profile: Profile, model: Model, ch: Character): Recipe {
  const base = { ...NEUTRAL, ...RECIPES[model][profile] };
  const c = CHARACTER_DEFS[ch];
  const out: Recipe = {};
  for (const [k, spec] of Object.entries(base) as [Key, Spec][]) {
    if (isMenu(spec)) {
      const w: Record<number, number> = { ...spec.w };
      const mult = k === 'wave' || k === 'fmWave' || k === 'm1wave' || k === 'm2wave' ? c.waves : k === 'tWave' ? c.trWaves : k === 'fmMode' ? { 1: c.fmMode1 } : null;
      if (mult) {
        for (const [v, m] of Object.entries(mult)) {
          const i = Number(v);
          // a character may favour a value the profile only allows a little of
          w[i] = (w[i] ?? (Object.keys(spec.w).length > 1 && m > 1 ? 0.3 : 0)) * m;
        }
      }
      out[k] = { w };
      continue;
    }
    let [m, s, lo, hi] = spec;
    const lean = (shift: number, mul = 1) => {
      m = m * mul + shift;
      const span = hi - lo;
      lo = Math.max(0, Math.min(lo * mul + shift, m - span * 0.1));
      hi = Math.min(127, Math.max(hi * mul + shift, m + span * 0.1));
    };
    if (k === 'decay' || k === 'decayOpen') lean(0, c.decay);
    else if (k === 'drive') lean(c.drive);
    else if (k === 'fdrive') lean(c.fdrive);
    else if (k === 'fmAmt' || k === 'm1amt' || k === 'm2amt') lean(0, c.fm);
    else if (k === 'cutoff' || k === 'noiseFreq') lean(c.bright);
    else if (k === 'reso') lean(c.reso);
    else if (k === 'tVol') lean(0, c.trans);
    else if (k === 'coarse') s += c.pitch * 0.6;
    out[k] = [m, s, lo, hi];
  }
  return out;
}

function hardClamp(k: Key, v: number): number {
  const h = HARD[k];
  return h ? Math.max(h[0], Math.min(h[1], v)) : v;
}

/** One value from a spec at a wildness (0-1). */
export function drawSpec(k: Key, spec: Spec, w: number, rng: Rng): number {
  const e = ease(w);
  if (isMenu(spec)) {
    const n = MENU_SIZE[k] ?? Math.max(...Object.keys(spec.w).map(Number)) + 1;
    let total = 0;
    for (const x of Object.values(spec.w)) total += Math.max(0, x);
    // the profile's weights, relaxed towards every choice of the menu
    const p: number[] = [];
    for (let i = 0; i < n; i++) p.push((1 - e) * (total > 0 ? Math.max(0, spec.w[i] ?? 0) / total : 1 / n) + e / n);
    let u = rng.next();
    for (let i = 0; i < n; i++) {
      u -= p[i]!;
      if (u < 0) return hardClamp(k, i);
    }
    return hardClamp(k, n - 1);
  }
  const [m, s, lo, hi] = spec;
  // bounds open towards the whole range, faster on the side with more room; the spread widens
  const lw = lo * (1 - e);
  const hw = hi + (127 - hi) * e;
  const sw = s * (1 + 2.2 * w) + (hw - lw) * 0.12 * e;
  let v: number;
  if (rng.chance(0.3 * w * w)) v = rng.range(lw, hw); // an excursion: anywhere in the open range
  else {
    v = m + sw * gauss(rng);
    // truncate (redraw once, then clamp) so the edges are not piled up
    if (v < lw || v > hw) v = m + sw * gauss(rng);
  }
  return hardClamp(k, clamp127(Math.max(lw, Math.min(hw, v))));
}

/** The bounds a value may move in at a wildness (mutation). */
export function boundsAt(k: Key, spec: Spec, w: number): [number, number] {
  const e = ease(w);
  if (isMenu(spec)) {
    const n = MENU_SIZE[k] ?? 128;
    return [0, n - 1];
  }
  const [, , lo, hi] = spec;
  const h = HARD[k] ?? [0, 127];
  return [Math.max(h[0], Math.round(lo * (1 - e))), Math.min(h[1], Math.round(hi + (127 - hi) * e))];
}

export interface ProfileDesign {
  profile: Profile;
  /** the profile it crossed with (wild), if any */
  cross: Profile | null;
  values: Partial<Record<Key, number>>;
  /** an LFO target to choose (the caller resolves it on the voice) */
  lfo: boolean;
}

/** Which keys a model has (the caller passes voiceKeys(v)). */
export type VoiceKeyMap = Partial<Record<Key, number>>;

/**
 * Design one voice from a profile, a character and a wildness. Relationships between parameters
 * are applied afterwards (cohere) with a strength that falls as wildness rises.
 */
export function designProfileVoice(voice: number, keys: VoiceKeyMap, profile: Profile, ch: Character, wildness: number, rng: Rng): ProfileDesign {
  const model = modelOf(voice);
  const c = CHARACTER_DEFS[ch];
  const w = Math.max(0, Math.min(1, wildness + c.bias * (0.5 + wildness)));
  const recipe = recipeFor(profile, model, ch);
  // at high wildness a voice may cross with another profile: each parameter from either
  let cross: Profile | null = null;
  let crossRecipe: Recipe | null = null;
  if (rng.chance(0.65 * Math.pow(w, 2.5))) {
    cross = rng.pick(PROFILES.filter((p) => p !== profile));
    crossRecipe = recipeFor(cross, model, ch);
  }
  const values: Partial<Record<Key, number>> = {};
  for (const k of Object.keys(keys) as Key[]) {
    let spec = recipe[k];
    if (crossRecipe && crossRecipe[k] && rng.chance(0.5)) spec = crossRecipe[k];
    if (!spec) continue;
    values[k] = drawSpec(k, spec, w, rng);
  }
  if (keys.decayOpen !== undefined && values.decayOpen === undefined && values.decay !== undefined) values.decayOpen = values.decay;
  // decimation and modulation the character asks for (more of both as wildness rises)
  if (keys.rate !== undefined) values.rate = rng.chance(Math.min(0.9, c.crush * (0.5 + w) + 0.15 * w * w)) ? clamp127(rng.range(Math.min(c.crushLo, 127 - 80 * w), 127)) : 127;
  values.velVol = 1;
  values.velAmt = 0;
  values.pan = 63;
  // a character without LFOs (MINIMAL) only gets one when it is made wild
  const lfo = rng.chance(Math.min(0.85, c.lfo + 0.4 * Math.pow(Math.max(0, c.lfo > 0 ? w : (w - 0.5) * 2), 1.5)));
  if (lfo) {
    values.lfoWave = rng.int(8);
    values.lfoSync = rng.chance(0.6) ? rng.pick([4, 6, 8, 10]) : 0;
    values.lfoRate = clamp127(rng.range(10, 90));
    values.lfoDepth = clamp127(rng.range(8, 30 + 50 * w));
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
  cohere(values, profile, model, w, rng);
  return { profile, cross, values, lfo };
}

/**
 * Relationships that make a set of values one sound. `strength` (from wildness) blends each value
 * towards what the relationship wants; the silence guards apply at any wildness.
 */
export function cohere(v: Partial<Record<Key, number>>, profile: Profile, model: Model, wildness: number, rng: Rng, scale = 1): void {
  const r = Math.pow(1 - Math.max(0, Math.min(1, wildness)), 1.3) * scale;
  const pull = (k: Key, target: number, s = r) => {
    if (v[k] === undefined) return;
    v[k] = clamp127(v[k]! + (target - v[k]!) * s);
  };
  const atMost = (k: Key, max: number, s = r) => v[k] !== undefined && v[k]! > max && pull(k, max, s);
  const atLeast = (k: Key, min: number, s = r) => v[k] !== undefined && v[k]! < min && pull(k, min, s);
  const kickLike = profile === 'kick' || profile === 'ltom' || profile === 'htom';

  // pitch and pitch envelope: the lower a kick or tom, the deeper its sweep, and the sweep is shorter than the sound
  if (kickLike && v.coarse !== undefined && v.pAmt !== undefined) atLeast('pAmt', Math.min(120, (profile === 'kick' ? 60 : 30) + (36 - v.coarse) * 1.5));
  if (v.pDecay !== undefined && v.decay !== undefined) atMost('pDecay', Math.round(v.decay * 1.5 + 6));
  // transient and decay: a very short body needs a click to be heard as a hit
  if (v.decay !== undefined && v.tVol !== undefined && v.decay < 6 && model !== 'metal') atLeast('tVol', 25);
  // FM and brightness: a kick or tom stays round (real FM only a little)
  if (kickLike && v.fmMode === 1) atMost('fmAmt', 28);
  // filter and fundamental: a low-pass stays well above the fundamental; a high-pass on hats leaves something
  const lp = v.ftype === 0 || v.ftype === 6;
  if (lp && v.coarse !== undefined) atLeast('cutoff', Math.min(120, 40 + v.coarse * 0.6));
  if (lp && (profile === 'snare' || profile === 'clap' || profile === 'chat' || profile === 'ohat' || profile === 'cymbal')) atLeast('cutoff', 108);
  // noise and transient balance: a snare is tone and noise; a very noisy one needs less click
  if (profile === 'snare' && model === 'snare') {
    atLeast('noiseMix', 55);
    atMost('noiseMix', 108);
    if ((v.noiseMix ?? 0) > 100) atMost('tVol', 50);
  }
  if (profile === 'clap' && model === 'snare') atLeast('noiseMix', 100);
  // distortion and level: drive adds level, the volume makes room (the engine check matches levels)
  if (v.drive !== undefined && v.vol !== undefined) atMost('vol', Math.round(127 - v.drive * 0.2), 1);
  // hats: the open decay is longer than the closed one
  if (v.decayOpen !== undefined && v.decay !== undefined && (profile === 'chat' || profile === 'ohat')) atLeast('decayOpen', Math.min(127, v.decay * 2 + 8));
  // no unusable sustained tones at low wildness: short sounds stay short
  const cap: Partial<Record<Profile, number>> = { kick: 40, snare: 24, clap: 20, chat: model === 'drum' ? 8 : 10, ltom: 32, htom: 28, perc: 22 };
  const c = cap[profile];
  if (c !== undefined) atMost('decay', c);
  // a slope near zero collapses the envelope: never, at any wildness, below what is audible
  if (v.slope !== undefined && v.slope < 12) v.slope = 12;
  // a low-pass closed below the fundamental is silence: never
  if (lp && v.cutoff !== undefined && v.cutoff < 22) v.cutoff = 22 + rng.int(10);
  if ((v.ftype === 1) && v.cutoff !== undefined && v.cutoff > 122) v.cutoff = 122;
}

/** LFO targets that make musical sense for a profile, as key names (the caller resolves them). */
export function lfoKeys(profile: Profile): Key[] {
  if (profile === 'chat' || profile === 'ohat' || profile === 'cymbal') return ['cutoff', 'm1freq', 'coarse', 'decay'];
  if (profile === 'kick') return ['cutoff', 'pAmt', 'decay'];
  return ['cutoff', 'coarse', 'fmAmt', 'pAmt', 'noiseMix'];
}

/** The FX bus flavour for a character (from its seed). */
export function fxFlavour(ch: Character, seed: number): KitFlavour {
  const l = CHARACTER_DEFS[ch].fx;
  return l[hash32(seed, 4711) % l.length]!;
}

export { isMenu };
export type { Spec, Recipe };
