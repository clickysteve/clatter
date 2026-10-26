/**
 * The destination registry: every parameter modulation may move, described once.
 *
 * A destination has a STABLE id (it is what saved projects and the portable format name), a
 * display name, a valid range, the span a full-depth route moves it, whether it can be
 * modulated continuously or only when a hit triggers, and which track sources it applies to.
 * LXR destinations resolve to a different firmware parameter for each voice (or to none: the
 * voice does not have it); sample and track destinations are executed by CLATTER's engine.
 *
 * Which LXR parameters really respond while a voice sounds is not guessed: test/mod.test.ts
 * renders each one and checks that a mid-note change alters the audio (CONTINUOUS) or only the
 * next trigger (TRIGGER). Anything the engine does not honour is not in this list.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import { VOICE_PARAMS } from '../sound/lxrParams';

export type DestKind = 'lxr' | 'sample' | 'track' | 'midi';
export type DestRate = 'continuous' | 'trigger';
export type SourceMode = 'synth' | 'sample' | 'hybrid';

export interface DestDef {
  id: string;
  label: string;
  group: string;
  kind: DestKind;
  rate: DestRate;
  /** the movement of a route at amount 1 and source 1, in the destination's own unit */
  span: number;
  unit: string;
  /** LXR: [group, label] of the voice parameter */
  par?: [string, string];
  /** track modes the destination applies to */
  modes: SourceMode[];
  help: string;
  /** the destination only has an audible effect under a condition (shown in the UI) */
  note?: string;
  /** LXR voices (0-5) on which the engine responds; measured by test/modengine.test.ts */
  only?: number[];
}

const SY: SourceMode[] = ['synth', 'hybrid'];
const SA: SourceMode[] = ['sample', 'hybrid'];
const ALL: SourceMode[] = ['synth', 'sample', 'hybrid'];

const lx = (id: string, label: string, group: string, par: [string, string], rate: DestRate, span: number, help: string, note?: string, only?: number[]): DestDef => ({ id, label, group, kind: 'lxr', rate, span, unit: 'steps', par, modes: SY, help, note, ...(only ? { only } : {}) });

export const DESTS: DestDef[] = [
  lx('lxr.osc.coarse', 'OSC COARSE', 'OSCILLATOR', ['OSC', 'COARSE'], 'continuous', 24, 'Oscillator pitch in semitones (full depth moves it 24).'),
  lx('lxr.osc.fine', 'OSC FINE', 'OSCILLATOR', ['OSC', 'FINE'], 'continuous', 63, 'Oscillator fine tune (full depth moves it a semitone).'),
  lx('lxr.osc.pwm', 'OSC PWM', 'OSCILLATOR', ['OSC', 'PWM'], 'continuous', 64, 'Pulse width.', 'AUDIBLE WITH THE PWM WAVEFORM'),
  lx('lxr.fm.amount', 'FM AMOUNT', 'FM', ['FM', 'AMOUNT'], 'continuous', 64, 'FM depth or modulator level.', undefined, [0, 1]),
  lx('lxr.fm.freq', 'FM FREQUENCY', 'FM', ['FM', 'FREQ'], 'continuous', 40, 'Modulator pitch.', 'NEEDS FM AMOUNT ABOVE 0', [0, 1]),
  lx('lxr.mod1.freq', 'MOD OSC 1 FREQ', 'FM', ['MOD OSC 1', 'FREQ'], 'continuous', 40, 'First modulator pitch (hi-hat).', undefined, [5]),
  lx('lxr.mod1.amount', 'MOD OSC 1 AMOUNT', 'FM', ['MOD OSC 1', 'AMOUNT'], 'continuous', 64, 'First modulator depth (hi-hat).', undefined, [5]),
  lx('lxr.mod2.freq', 'MOD OSC 2 FREQ', 'FM', ['MOD OSC 2', 'FREQ'], 'continuous', 40, 'Second modulator pitch (hi-hat).', undefined, [5]),
  lx('lxr.mod2.amount', 'MOD OSC 2 AMOUNT', 'FM', ['MOD OSC 2', 'AMOUNT'], 'continuous', 64, 'Second modulator depth (hi-hat).', undefined, [5]),
  lx('lxr.noise.freq', 'NOISE FREQ', 'NOISE', ['NOISE', 'NOISE FREQ'], 'continuous', 64, 'Snare noise sample-and-hold frequency.'),
  lx('lxr.noise.mix', 'NOISE MIX', 'NOISE', ['NOISE', 'NOISE MIX'], 'continuous', 64, 'Snare tone/noise balance.'),
  lx('lxr.pitch.amount', 'PITCH ENV AMOUNT', 'PITCH ENVELOPE', ['PITCH', 'AMOUNT'], 'continuous', 64, 'Pitch envelope depth.'),
  lx('lxr.pitch.decay', 'PITCH ENV DECAY', 'PITCH ENVELOPE', ['PITCH', 'DECAY'], 'continuous', 64, 'Pitch envelope decay.'),
  lx('lxr.pitch.slope', 'PITCH ENV SLOPE', 'PITCH ENVELOPE', ['PITCH', 'SLOPE'], 'continuous', 64, 'Pitch envelope curve.'),
  lx('lxr.amp.attack', 'AMP ATTACK', 'AMP ENVELOPE', ['AMP', 'ATTACK'], 'trigger', 40, 'Amplitude attack (read when the voice triggers).'),
  lx('lxr.amp.decay', 'AMP DECAY', 'AMP ENVELOPE', ['AMP', 'DECAY'], 'continuous', 64, 'Amplitude decay.'),
  lx('lxr.amp.slope', 'AMP SLOPE', 'AMP ENVELOPE', ['AMP', 'SLOPE'], 'continuous', 64, 'Amplitude envelope curve.'),
  lx('lxr.amp.repeat', 'AMP REPEAT', 'AMP ENVELOPE', ['AMP', 'REPEAT'], 'trigger', 40, 'Envelope repeats (snare, cymbal; read when the voice triggers).'),
  lx('lxr.transient.level', 'TRANSIENT LEVEL', 'TRANSIENT', ['TRANSIENT', 'LEVEL'], 'continuous', 64, 'Transient level.'),
  lx('lxr.transient.pitch', 'TRANSIENT PITCH', 'TRANSIENT', ['TRANSIENT', 'PITCH'], 'continuous', 40, 'Transient playback speed.', 'NEEDS TRANSIENT LEVEL ABOVE 0'),
  lx('lxr.filter.cutoff', 'FILTER CUTOFF', 'FILTER', ['FILTER', 'CUTOFF'], 'continuous', 64, 'Filter frequency.'),
  lx('lxr.filter.reso', 'FILTER RESONANCE', 'FILTER', ['FILTER', 'RESO'], 'continuous', 64, 'Filter resonance.', 'NEEDS A RESONANT FILTER TYPE'),
  lx('lxr.filter.drive', 'FILTER DRIVE', 'FILTER', ['FILTER', 'DRIVE'], 'continuous', 64, 'Filter input drive.'),
  lx('lxr.voice.drive', 'VOICE DRIVE', 'VOICE', ['MIX', 'DRIVE'], 'continuous', 64, 'Voice distortion.'),
  lx('lxr.voice.volume', 'VOICE VOLUME', 'VOICE', ['MIX', 'VOLUME'], 'continuous', 48, 'Voice volume.'),
  lx('lxr.voice.pan', 'VOICE PAN', 'VOICE', ['MIX', 'PAN'], 'trigger', 63, 'Voice pan (read when the voice triggers).'),
  lx('lxr.voice.rate', 'SAMPLE RATE', 'VOICE', ['MIX', 'RATE'], 'continuous', 64, 'Sample-rate reduction of the voice.'),

  { id: 'smp.pitch', label: 'SAMPLE PITCH', group: 'SAMPLE', kind: 'sample', rate: 'continuous', span: 12, unit: 'semitones', modes: SA, help: 'Playback pitch of the sample layer, in semitones, continuously (a sound that is playing bends).' },
  { id: 'smp.gain', label: 'SAMPLE GAIN', group: 'SAMPLE', kind: 'sample', rate: 'continuous', span: 1, unit: 'x', modes: SA, help: 'Gain of the sample layer (1 + modulation, never below 0).' },
  { id: 'smp.pan', label: 'SAMPLE PAN', group: 'SAMPLE', kind: 'sample', rate: 'continuous', span: 1, unit: 'pan', modes: SA, help: 'Pan of the sample layer.' },
  { id: 'smp.start', label: 'SAMPLE POSITION', group: 'SAMPLE', kind: 'sample', rate: 'trigger', span: 0.5, unit: 'of region', modes: SA, help: 'Where in the sample region playback starts (read when the hit triggers).' },
  { id: 'hyb.blend', label: 'SYNTH/SAMPLE BLEND', group: 'HYBRID', kind: 'sample', rate: 'continuous', span: 1, unit: 'blend', modes: ['hybrid'], help: 'Crossfade of a HYBRID track: negative towards the synth, positive towards the sample.' },
  { id: 'trk.volume', label: 'TRACK VOLUME', group: 'OUTPUT', kind: 'track', rate: 'continuous', span: 0.4, unit: 'fader', modes: ALL, help: 'The track fader (before processing).' },
  { id: 'trk.pan', label: 'TRACK PAN', group: 'OUTPUT', kind: 'track', rate: 'continuous', span: 1, unit: 'pan', modes: ALL, help: 'The track pan in the mixer.' },
  { id: 'trk.filter', label: 'TRACK FILTER', group: 'OUTPUT', kind: 'track', rate: 'continuous', span: 1, unit: 'knob', modes: ALL, help: 'The track’s one-knob filter (left low-pass, right high-pass).' },
  { id: 'trk.send', label: 'FX SEND', group: 'OUTPUT', kind: 'track', rate: 'continuous', span: 1, unit: 'send', modes: ALL, help: 'The track’s send to the LXR FX bus.' },
  // MIDI CC out: executed on the main thread by src/midi/ccOut.ts (never by the audio engine), so a
  // modulation source can drive a parameter of external hardware. The CC number, channel, device,
  // resolution and rate of each are set in the MIDI window.
  ...[1, 2, 3, 4].map((i): DestDef => ({ id: `midi.cc${i}`, label: `MIDI CC ${i}`, group: 'MIDI OUT', kind: 'midi', rate: 'continuous', span: 127, unit: 'CC', modes: ALL, help: `External MIDI CC destination ${i}: the CC number, channel and device are set in MIDI › MIDI settings (CC OUT). Sent from the main thread, rate-limited, only when the value changes.`, note: 'SENT AS MIDI CC (SEE THE MIDI WINDOW)' })),
];

/** The MIDI CC destination ids, in slot order. */
export const MIDI_CC_DESTS = ['midi.cc1', 'midi.cc2', 'midi.cc3', 'midi.cc4'] as const;

export const DEST_BY_ID = new Map(DESTS.map((d) => [d.id, d] as const));
export const DEST_INDEX = new Map(DESTS.map((d, i) => [d.id, i] as const));
export const destDef = (id: string): DestDef | undefined => DEST_BY_ID.get(id);

// per voice: destination id → firmware parameter
const byVoice: Map<string, number>[] = VOICE_PARAMS.map((list, byVoiceIndex) => {
  const m = new Map<string, number>();
  for (const d of DESTS) {
    if (d.kind !== 'lxr' || !d.par) continue;
    const [g, l] = d.par;
    const hits = list.filter((p) => p.group === g && p.label === l);
    // the hi-hat has two decays: modulation reaches the closed one; the open one is read at the open trigger
    if (hits.length) m.set(d.id, hits[0]!.id);
    if (d.only && !d.only.includes(byVoiceIndex)) m.delete(d.id);
  }
  return m;
});

/** The firmware parameter an LXR destination moves on a voice (0-5), or undefined if the voice has none. */
export function parOf(dest: string, voice: number): number | undefined {
  return byVoice[voice]?.get(dest);
}

/** Does a destination exist, apply to the track's mode, and (LXR) exist on the voice? */
export function destApplies(dest: string, mode: SourceMode, voice: number): boolean {
  const d = DEST_BY_ID.get(dest);
  if (!d || !d.modes.includes(mode)) return false;
  return d.kind !== 'lxr' || parOf(dest, voice) !== undefined;
}

/** Destinations a track of this mode and voice can use, in registry order. */
export function destsFor(mode: SourceMode, voice: number): DestDef[] {
  return DESTS.filter((d) => destApplies(d.id, mode, voice));
}

export const RATE_NOTE: Record<DestRate, string> = {
  continuous: 'FOLLOWS THE SOURCE WHILE THE SOUND PLAYS',
  trigger: 'READ ONCE, WHEN THE HIT TRIGGERS',
};
