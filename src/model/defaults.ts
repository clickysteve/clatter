/**
 * Default tracks, sounds, mixer and project.
 *
 * Ten tracks. The LXR engine has six voices (three drum voices, snare, cymbal and a hihat with
 * closed and open triggers): seven tracks are synthesised on those voices by default, three play
 * samples (the LXR has no clap voice). Any track can be switched to SYNTH, SAMPLE or HYBRID; two
 * tracks on the same LXR voice share it (monophonic, as on the hardware: the later hit cuts the
 * earlier, as the LXR's closed and open hat do).
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import { defaultChop } from '../destruction/chop';
import { defaultDestroy } from '../destruction/destroy';
import { defaultRolls } from '../destruction/rolls';
import { defaultGen } from '../rhythm/generate';
import { defaultOutputFx } from '../audio/mixfx';
import { newPattern } from '../rhythm/pattern';
import { GENERATOR_VERSION, SEED_HASH_VERSION } from '../rhythm/seed';
import { GM_NOTE, ROLE_LABEL, SNAPSHOTS, type Project, type Role, type SynthKit, type Track, type TrackMix, type TrackPlay, type TrackSound } from './types';

export const defaultSound = (over: Partial<TrackSound> = {}): TrackSound => ({
  mode: 'synth',
  trigger: 0,
  note: 60,
  synthLevel: 0.8,
  sampleLevel: 0.8,
  pick: 'first',
  start: 0,
  end: 1,
  tune: 0,
  fine: 0,
  gain: 1,
  pan: 0,
  reverse: false,
  offsetMs: 0,
  choke: 0,
  ...over,
  samples: [...(over.samples ?? [])],
});

export const defaultMix = (over: Partial<TrackMix> = {}): TrackMix => ({ volume: 0.8, pan: 0, mute: false, solo: false, route: 'main', filter: 0, ...over });
export const defaultPlay = (over: Partial<TrackPlay> = {}): TrackPlay => ({ density: 100, fill: 0, humanize: 0, chance: 100, length: 0, ...over });

/** The default track layout: role, LXR trigger (or sample), mixer. */
export const TRACK_LAYOUT: { role: Role; sound: Partial<TrackSound>; mix?: Partial<TrackMix> }[] = [
  { role: 'kick', sound: { mode: 'synth', trigger: 0 } },
  { role: 'snare', sound: { mode: 'synth', trigger: 3 } },
  { role: 'clap', sound: { mode: 'sample', trigger: 3, samples: ['bundled:clap-tight'] }, mix: { route: 'fx', pan: -0.1 } },
  { role: 'chat', sound: { mode: 'synth', trigger: 5, choke: 1 }, mix: { pan: 0.15, volume: 0.72 } },
  { role: 'ohat', sound: { mode: 'synth', trigger: 6, choke: 1 }, mix: { pan: 0.15, volume: 0.7 } },
  { role: 'ltom', sound: { mode: 'synth', trigger: 1 }, mix: { pan: -0.3 } },
  { role: 'htom', sound: { mode: 'synth', trigger: 2 }, mix: { pan: 0.3, route: 'fx' } },
  { role: 'cymbal', sound: { mode: 'synth', trigger: 4 }, mix: { pan: -0.2, volume: 0.66 } },
  { role: 'perc', sound: { mode: 'sample', trigger: 2, samples: ['bundled:rim', 'bundled:shaker'], pick: 'cycle' }, mix: { route: 'fx', pan: 0.35, volume: 0.72 } },
  { role: 'fx', sound: { mode: 'sample', trigger: 4, samples: ['bundled:zap'] }, mix: { route: 'fx', pan: -0.35, volume: 0.65 } },
];

export function defaultTracks(): Track[] {
  return TRACK_LAYOUT.map((l, i) => ({
    id: `t${i + 1}`,
    name: ROLE_LABEL[l.role],
    role: l.role,
    sound: defaultSound(l.sound),
    mix: defaultMix(l.mix),
    play: defaultPlay(),
    midi: { channel: 10, note: GM_NOTE[l.role] },
    lock: false,
  }));
}

/** An LXR kit with every parameter at 0 (filled from the engine's init kit at start-up). */
export const emptySynthKit = (count = 247): SynthKit => ({ params: new Array(count).fill(0), lfoTarget: [0, 0, 0, 0, 0, 0], velTarget: [0, 0, 0, 0, 0, 0] });

export function defaultProject(): Project {
  const gen = defaultGen();
  const pattern = newPattern('p1', 'A', gen);
  return {
    format: 'clatter-project',
    version: 6,
    name: 'UNTITLED',
    tempo: 124,
    swing: 50,
    seed: 1,
    seedHash: SEED_HASH_VERSION,
    generator: GENERATOR_VERSION,
    tracks: defaultTracks(),
    kit: { name: 'INIT', seed: 0, synth: emptySynthKit() },
    soundLocks: { voices: [false, false, false, false, false, false], params: [] },
    patterns: [pattern],
    current: 'p1',
    chain: { on: false, entries: [] },
    gen,
    destruction: { chop: defaultChop(), rolls: defaultRolls(), destroy: defaultDestroy() },
    evolve: { target: 'off', every: 4, amount: 0.3, returnEvery: 4 },
    timbre: { amount: 0.5, seed: 1 },
    quantize: 'bar',
    master: { volume: 0.8, clip: true, chain: null, out: defaultOutputFx() },
    macros: [0, 0, 0, 0],
    snapshots: new Array(SNAPSHOTS).fill(null),
    notes: '',
  };
}
