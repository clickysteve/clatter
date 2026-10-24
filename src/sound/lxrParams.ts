/**
 * The LXR-02 synthesis parameters as CLATTER presents them: every sound parameter of the six
 * voices and the FX bus, grouped by function, with the firmware's ranges and value names
 * (menu/MenuText.h, menu/menu.c parameter_dtypes, menu/Cc2Text.c modTargets).
 *
 * Values are always the firmware's 0-127 parameter values (the edit buffer the LXR keeps,
 * `activeParameters`), so a CLATTER kit is an LXR kit. Nothing here invents a parameter: each
 * entry is a `PAR_*` number the compiled engine interprets through the firmware's own
 * parameter handler.
 *
 * Copyright (C) 2026 The CLATTER contributors. Value names and groupings from the LXR firmware,
 * Copyright (C) 2012-2026 Erica Synths. SPDX-License-Identifier: GPL-3.0-only
 */
import { PAR, SOUND_PARAM_COUNT } from './lxrParamIds';

export { PAR, SOUND_PARAM_COUNT };

/** The six synthesis voices of the LXR engine. */
export const VOICES = ['DRUM 1', 'DRUM 2', 'DRUM 3', 'SNARE', 'CYMBAL', 'HIHAT'] as const;
export type VoiceIndex = 0 | 1 | 2 | 3 | 4 | 5;
export const VOICE_COUNT = 6;

/**
 * The seven triggers: drum 1-3, snare, cymbal, closed and open hat. The two hat triggers play
 * the same (monophonic) hihat voice with its closed or open decay, as on the LXR.
 */
export const TRIGGERS = ['DRUM 1', 'DRUM 2', 'DRUM 3', 'SNARE', 'CYMBAL', 'CL HAT', 'OP HAT'] as const;
export type TriggerIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export const voiceOfTrigger = (t: number): VoiceIndex => (t >= 5 ? 5 : t) as VoiceIndex;

/** Value names (firmware menu texts, spelled out). */
export const WAVEFORMS = ['SINE', 'TRI', 'SAW', 'REC', 'NOISE', 'PWM'];
export const FILTER_TYPES = ['LP', 'HP', 'BP', 'UBP', 'NOTCH', 'PEAK', 'LP2', 'OFF'];
export const TRANSIENTS = ['SNAP', 'OFFSET', 'CLICK', 'CLICK 2', 'TICK', 'KICK', 'RIM', 'DROP', 'HAT', 'CLAP', 'KICK 2', 'SNARE', 'TOM', 'SNAP 2'];
export const LFO_WAVES = ['SINE', 'TRI', 'SAW UP', 'SAW DN', 'SQUARE', 'RANDOM', 'EXP UP', 'EXP DN'];
export const LFO_RETRIGGER = ['OFF', 'V1', 'V2', 'V3', 'V4', 'V5', 'V6'];
export const LFO_SYNC = ['OFF', '4/1', '2/1', '1/1', '1/2', '1/3', '1/4', '1/6', '1/8', '1/12', '1/16', '1/32'];
export const FM_MODES = ['FM', 'MIX'];
export const ON_OFF = ['OFF', 'ON'];
export const FX_TYPES = ['OFF', 'DRIVE', 'RING', 'COMP', 'DELAY'];
export const DIST_TYPES = ['TUBE', 'FOLD', 'CLIP'];
export const RATIOS = ['1:1', '2:1', '3:1', '4:1', '6:1', '8:1'];
export const DELAY_TYPES = ['DELAY', 'PING-PONG'];

export type ParamKind = 'range' | 'bipolar' | 'menu' | 'percent' | 'target';

export interface ParamDef {
  /** firmware parameter number (PAR_*) */
  id: number;
  /** short label (CLATTER's spelled-out version of the LXR's three-letter name) */
  label: string;
  /** group within the voice's editor */
  group: string;
  kind: ParamKind;
  /** value names for menus */
  options?: readonly string[];
  /** largest value (menus: options.length - 1; percent: 100; otherwise 127) */
  max: number;
  /** shown in the BASIC editor */
  basic?: boolean;
  help: string;
  /** owning voice (0-5); absent for the FX bus */
  voice?: number;
}

/** Group order in the editor. */
export const GROUPS = ['OSC', 'NOISE', 'MOD OSC 1', 'MOD OSC 2', 'FM', 'PITCH', 'AMP', 'TRANSIENT', 'FILTER', 'LFO', 'VELOCITY', 'MIX'] as const;

const r = (id: number, label: string, group: string, help: string, basic = false): ParamDef => ({ id, label, group, kind: 'range', max: 127, basic, help });
const b = (id: number, label: string, group: string, help: string, basic = false): ParamDef => ({ id, label, group, kind: 'bipolar', max: 127, basic, help });
const m = (id: number, label: string, group: string, options: readonly string[], help: string, basic = false): ParamDef => ({ id, label, group, kind: 'menu', options, max: options.length - 1, basic, help });

/** Parameters shared by every voice type, for voice index v (0-5) and firmware suffix n (1-6). */
function shared(v: number, n: number): ParamDef[] {
  const k = n - 1;
  const lfoFreq = PAR.FREQ_LFO1 + k;
  return [
    m(PAR.TRANS1_WAVE + k, 'WAVE', 'TRANSIENT', TRANSIENTS, 'Attack transient: SNAP adds a pitch snap, OFFSET starts the oscillator late in its cycle, the rest are short sampled clicks.'),
    r(PAR.TRANS1_VOL + k, 'LEVEL', 'TRANSIENT', 'Transient level (SNAP: snap depth, OFFSET: start offset).', true),
    r(PAR.TRANS1_FREQ + k, 'PITCH', 'TRANSIENT', 'Transient playback speed (about ¼× to 4×).'),
    r(PAR.FILTER_FREQ_1 + k, 'CUTOFF', 'FILTER', 'Filter frequency (exponential).', true),
    r(PAR.RESO_1 + k, 'RESO', 'FILTER', 'Filter resonance.', true),
    m(PAR.FILTER_TYPE_1 + k, 'TYPE', 'FILTER', FILTER_TYPES, 'Filter type of the state-variable filter.'),
    r(PAR.FILTER_DRIVE_1 + k, 'DRIVE', 'FILTER', 'Filter input drive.'),
    r(lfoFreq, 'RATE', 'LFO', 'LFO frequency (up to 200 Hz) when not synced.'),
    m(PAR.SYNC_LFO1 + k, 'SYNC', 'LFO', LFO_SYNC, 'Tempo-synced LFO rate (OFF = free RATE).'),
    r(PAR.AMOUNT_LFO1 + k, 'DEPTH', 'LFO', 'Modulation depth around the target’s value.'),
    m(PAR.WAVE_LFO1 + k, 'WAVE', 'LFO', LFO_WAVES, 'LFO waveform.'),
    m(PAR.RETRIGGER_LFO1 + k, 'RETRIG', 'LFO', LFO_RETRIGGER, 'Restart the LFO when this voice (V1-V6) is triggered.'),
    r(PAR.OFFSET_LFO1 + k, 'PHASE', 'LFO', 'LFO start phase on retrigger.'),
    { id: PAR.TARGET_LFO1 + k, label: 'TARGET', group: 'LFO', kind: 'target', max: SOUND_PARAM_COUNT - 1, help: 'The parameter the LFO modulates.' },
    { id: PAR.VEL_DEST_1 + k, label: 'VEL DEST', group: 'VELOCITY', kind: 'target', max: SOUND_PARAM_COUNT - 1, help: 'The parameter the hit velocity modulates.' },
    r(PAR.VELO_MOD_AMT_1 + k, 'VEL AMT', 'VELOCITY', 'Velocity modulation depth.'),
    m(PAR.VOLUME_MOD_ON_OFF1 + k, 'VEL>VOL', 'VELOCITY', ON_OFF, 'Velocity controls the voice’s volume.'),
    r(PAR.VOL1 + k, 'VOLUME', 'MIX', 'Voice volume.', true),
    b(PAR.PAN1 + (k < 3 ? k : k + 2), 'PAN', 'MIX', 'Voice pan (applied when the voice is triggered).'),
    r(PAR.VOICE_DECIMATION1 + k, 'RATE', 'MIX', 'Sample-rate reduction (127 = full rate).'),
  ].map((p) => ({ ...p, voice: v }) as ParamDef);
}

function drum(v: 0 | 1 | 2): ParamDef[] {
  const n = v + 1;
  const k = v;
  return [
    m(PAR.OSC_WAVE_DRUM1 + k, 'WAVE', 'OSC', WAVEFORMS, 'Main oscillator waveform.', true),
    b(PAR.COARSE1 + 2 * k, 'COARSE', 'OSC', 'Pitch in semitones (MIDI note of the oscillator at note 60).', true),
    b(PAR.FINE1 + 2 * k, 'FINE', 'OSC', 'Fine tune, ± a semitone.'),
    r(PAR.PWM_1 + k, 'PWM', 'OSC', 'Pulse width of the PWM waveform.'),
    r(PAR.FMAMNT1 + 2 * k, 'AMOUNT', 'FM', 'FM depth (FM mode, follows the pitch envelope) or modulator level (MIX mode).', true),
    b(PAR.FM_FREQ1 + 2 * k, 'FREQ', 'FM', 'Modulator pitch.'),
    m(PAR.MOD_WAVE_DRUM1 + k, 'WAVE', 'FM', WAVEFORMS, 'Modulator waveform.'),
    m(PAR.MIX_MOD_1 + k, 'MODE', 'FM', FM_MODES, 'FM: the modulator modulates the oscillator. MIX: both are heard.'),
    r(PAR.MOD_EG1 + k, 'DECAY', 'PITCH', 'Pitch envelope decay.', true),
    r(PAR.PITCH_SLOPE1 + k, 'SLOPE', 'PITCH', 'Pitch envelope curve.'),
    r(PAR.MODAMNT1 + k, 'AMOUNT', 'PITCH', 'Pitch envelope depth.', true),
    r(PAR.VELOA1 + 2 * k, 'ATTACK', 'AMP', 'Amplitude attack.'),
    r(PAR.VELOD1 + 2 * k, 'DECAY', 'AMP', 'Amplitude decay.', true),
    r(PAR.VOL_SLOPE1 + k, 'SLOPE', 'AMP', 'Amplitude envelope curve.'),
    r(PAR.DRIVE1 + k, 'DRIVE', 'MIX', 'Voice distortion.', true),
    ...shared(v, n),
  ].map((p) => ({ ...p, voice: v }) as ParamDef);
}

function snare(): ParamDef[] {
  return [
    m(PAR.OSC_WAVE_SNARE, 'WAVE', 'OSC', WAVEFORMS, 'Tonal oscillator waveform.'),
    b(PAR.COARSE4, 'COARSE', 'OSC', 'Tone pitch in semitones.', true),
    b(PAR.FINE4, 'FINE', 'OSC', 'Fine tune.'),
    r(PAR.PWM_4, 'PWM', 'OSC', 'Pulse width of the PWM waveform.'),
    r(PAR.NOISE_FREQ1, 'NOISE FREQ', 'NOISE', 'Noise sample-and-hold frequency (darker below).', true),
    r(PAR.MIX1, 'NOISE MIX', 'NOISE', 'Balance between the tone and the noise.', true),
    r(PAR.MOD_EG4, 'DECAY', 'PITCH', 'Pitch envelope decay.'),
    r(PAR.PITCH_SLOPE4, 'SLOPE', 'PITCH', 'Pitch envelope curve.'),
    r(PAR.MODAMNT4, 'AMOUNT', 'PITCH', 'Pitch envelope depth.', true),
    r(PAR.VELOA4, 'ATTACK', 'AMP', 'Amplitude attack.'),
    r(PAR.VELOD4, 'DECAY', 'AMP', 'Amplitude decay.', true),
    r(PAR.VOL_SLOPE4, 'SLOPE', 'AMP', 'Amplitude envelope curve.'),
    r(PAR.REPEAT4, 'REPEAT', 'AMP', 'Envelope repeats (clap-like retriggering).', true),
    r(PAR.SNARE_DISTORTION, 'DRIVE', 'MIX', 'Voice distortion.', true),
    ...shared(3, 4),
  ].map((p) => ({ ...p, voice: 3 }) as ParamDef);
}

function metal(v: 4 | 5): ParamDef[] {
  const cym = v === 4;
  return [
    m(cym ? PAR.WAVE1_CYM : PAR.WAVE1_HH, 'WAVE', 'OSC', WAVEFORMS, 'Carrier waveform.'),
    b(cym ? PAR.COARSE5 : PAR.COARSE6, 'COARSE', 'OSC', 'Carrier pitch.', true),
    b(cym ? PAR.FINE5 : PAR.FINE6, 'FINE', 'OSC', 'Fine tune.'),
    r(cym ? PAR.PWM_5 : PAR.PWM_6, 'PWM', 'OSC', 'Pulse width of the PWM waveform.'),
    m(cym ? PAR.WAVE2_CYM : PAR.WAVE2_HH, 'WAVE', 'MOD OSC 1', WAVEFORMS, 'First modulator waveform.'),
    b(cym ? PAR.MOD_OSC_F1_CYM : PAR.MOD_OSC_F1, 'FREQ', 'MOD OSC 1', 'First modulator pitch.', true),
    r(cym ? PAR.MOD_OSC_GAIN1_CYM : PAR.MOD_OSC_GAIN1, 'AMOUNT', 'MOD OSC 1', 'First modulator depth.', true),
    m(cym ? PAR.WAVE3_CYM : PAR.WAVE3_HH, 'WAVE', 'MOD OSC 2', WAVEFORMS, 'Second modulator waveform.'),
    b(cym ? PAR.MOD_OSC_F2_CYM : PAR.MOD_OSC_F2, 'FREQ', 'MOD OSC 2', 'Second modulator pitch.'),
    r(cym ? PAR.MOD_OSC_GAIN2_CYM : PAR.MOD_OSC_GAIN2, 'AMOUNT', 'MOD OSC 2', 'Second modulator depth.'),
    r(cym ? PAR.VELOA5 : PAR.VELOA6, 'ATTACK', 'AMP', 'Amplitude attack.'),
    ...(cym
      ? [r(PAR.VELOD5, 'DECAY', 'AMP', 'Amplitude decay.', true), r(PAR.VOL_SLOPE5, 'SLOPE', 'AMP', 'Amplitude envelope curve.'), r(PAR.REPEAT5, 'REPEAT', 'AMP', 'Envelope repeats.')]
      : [
          r(PAR.VELOD6_CLOSED, 'CLOSED', 'AMP', 'Decay of the closed hat trigger.', true),
          r(PAR.VELOD6_OPEN, 'OPEN', 'AMP', 'Decay of the open hat trigger.', true),
          r(PAR.VOL_SLOPE6, 'SLOPE', 'AMP', 'Amplitude envelope curve.'),
        ]),
    r(cym ? PAR.CYMBAL_DISTORTION : PAR.HAT_DISTORTION, 'DRIVE', 'MIX', 'Voice distortion.', true),
    ...shared(v, v + 1),
  ].map((p) => ({ ...p, voice: v }) as ParamDef);
}

/** Every voice's parameters, in editor order. */
export const VOICE_PARAMS: ParamDef[][] = [drum(0), drum(1), drum(2), snare(), metal(4), metal(5)];

/** The FX bus (one per engine, as on the LXR). P1-P4 mean different things per FX type. */
export const FX_PARAMS: ParamDef[] = [
  m(PAR.FX_TYPE, 'FX', 'FX', FX_TYPES, 'The FX bus effect: tracks routed to FX are heard through it.', true),
  { id: PAR.FX_DRY_WET, label: 'AMOUNT', group: 'FX', kind: 'percent', max: 100, basic: true, help: 'Dry/wet of the FX bus.' },
  m(PAR.FX_DIST_TYPE, 'SHAPE', 'FX', DIST_TYPES, 'Distortion curve (DRIVE).'),
  m(PAR.FX_WAVE, 'WAVE', 'FX', WAVEFORMS, 'Ring modulator waveform (RING).'),
  m(PAR.FX_RATIO, 'RATIO', 'FX', RATIOS, 'Compression ratio (COMP).'),
  m(PAR.FX_DELAY_TYPE, 'MODE', 'FX', DELAY_TYPES, 'Delay mode (DELAY).'),
  r(PAR.FX_P1, 'P1', 'FX', 'DRIVE: drive · RING: frequency · COMP: attack · DELAY: time.', true),
  r(PAR.FX_P2, 'P2', 'FX', 'DRIVE: colour · COMP: release · DELAY: range.'),
  r(PAR.FX_P3, 'P3', 'FX', 'DRIVE: tone · COMP: threshold · DELAY: tone.'),
  r(PAR.FX_P4, 'P4', 'FX', 'DRIVE: volume · COMP: gain · DELAY: feedback.'),
  r(PAR.VOICE_DECIMATION_ALL, 'ALL RATE', 'FX', 'Sample-rate reduction of every voice (127 = full rate).'),
];

/** P1-P4's meaning for each FX type (the firmware's FX menu pages). */
export const FX_PARAM_LABELS: Record<number, [string, string, string, string]> = {
  0: ['P1', 'P2', 'P3', 'P4'],
  1: ['DRIVE', 'COLOUR', 'TONE', 'VOLUME'],
  2: ['FREQ', '-', '-', '-'],
  3: ['ATTACK', 'RELEASE', 'THRESH', 'GAIN'],
  4: ['TIME', 'RANGE', 'TONE', 'FEEDBACK'],
};

const byId = new Map<number, ParamDef>();
for (const list of [...VOICE_PARAMS, FX_PARAMS]) for (const p of list) if (!byId.has(p.id)) byId.set(p.id, p);

export function paramDef(id: number): ParamDef | undefined {
  return byId.get(id);
}

/** Which voice a parameter belongs to (-1 = global / FX). */
export function voiceOfParam(id: number): number {
  for (let v = 0; v < VOICE_PARAMS.length; v++) if (VOICE_PARAMS[v]!.some((p) => p.id === id)) return v;
  return -1;
}

/** Parameters an LFO or velocity can modulate for voice v (the firmware's modTargets for that voice). */
export function modTargets(v: number): ParamDef[] {
  const own = (VOICE_PARAMS[v] ?? []).filter((p) => p.kind !== 'target' && p.id !== PAR.TARGET_LFO1 + v && p.id !== PAR.VEL_DEST_1 + v);
  return [...own, ...FX_PARAMS.filter((p) => p.id >= PAR.FX_P1 && p.id <= PAR.FX_P4), byId.get(PAR.VOICE_DECIMATION_ALL)!];
}

/** Display text of a value. */
export function formatValue(p: ParamDef, value: number): string {
  switch (p.kind) {
    case 'menu':
      return p.options?.[value] ?? String(value);
    case 'bipolar':
      return (value - 63 > 0 ? '+' : '') + (value - 63);
    case 'percent':
      return value + '%';
    case 'target':
      return value === 0 ? 'NONE' : targetLabel(value);
    default:
      return String(value);
  }
}

/** "SNARE DECAY" style label for a modulation target. */
export function targetLabel(id: number): string {
  if (id === 0) return 'NONE';
  const p = byId.get(id);
  if (!p) return `#${id}`;
  const v = voiceOfParam(id);
  const owner = v >= 0 ? '' : 'FX ';
  return `${owner}${p.group === p.label ? '' : p.group + ' '}${p.label}`.trim();
}

/** Parameters whose value is not part of the sound (routing on the hardware). */
export const HARDWARE_ONLY = new Set<number>([
  PAR.AUDIO_OUT1, PAR.AUDIO_OUT2, PAR.AUDIO_OUT3, PAR.AUDIO_OUT4, PAR.AUDIO_OUT5, PAR.AUDIO_OUT6,
  PAR.FX_ROUTING, PAR.MORPH_KIT_DEST, PAR.VOICE_LFO1, PAR.VOICE_LFO2, PAR.VOICE_LFO3, PAR.VOICE_LFO4, PAR.VOICE_LFO5, PAR.VOICE_LFO6,
]);
