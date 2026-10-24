/**
 * Factory presets: complete starting points, each a different instrument setup (style, tempo,
 * swing, generated patterns, a kit designed for its flavour, sources per track, destruction,
 * evolution and FX). Built deterministically from fixed seeds, so a preset is the same every
 * time; the app then checks the kit through the engine (kitcheck.ts) for its levels.
 *
 * Samples are named by their bundled file ("bundled:clap-dusty"); the app resolves them to
 * content ids when the bundled library has loaded.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import { defaultProject } from './defaults';
import { type Project, type Role, type SynthKit, type TrackSound } from './types';
import { generate, stepsPerBar } from '../rhythm/generate';
import { mutate } from '../rhythm/mutate';
import { newPattern } from '../rhythm/pattern';
import { Rng } from '../rhythm/rng';
import { styleById, type KitFlavour } from '../rhythm/styles';
import { generateKit, voiceRolesOf } from '../sound/kitgen';

export interface PresetSpec {
  id: string;
  name: string;
  description: string;
  style: string;
  flavour: KitFlavour;
  tempo: number;
  swing: number;
  seed: number;
  kitSeed: number;
  gen?: Partial<Project['gen']>;
  /** source changes per role */
  sounds?: Partial<Record<Role, Partial<TrackSound>>>;
  mix?: Partial<Record<Role, Partial<Project['tracks'][number]['mix']>>>;
  play?: Partial<Record<Role, Partial<Project['tracks'][number]['play']>>>;
  destruction?: { chop?: Partial<Project['destruction']['chop']>; rolls?: Partial<Project['destruction']['rolls']>; destroy?: Partial<Project['destruction']['destroy']> };
  evolve?: Partial<Project['evolve']>;
  /** extra pattern B as a variation of A */
  variation?: number;
}

const B = (name: string) => `bundled:${name}`;

export const PRESETS: PresetSpec[] = [
  {
    id: 'machine-room',
    name: 'MACHINE ROOM',
    description: 'Four to the floor in a clean machine room: tight kick, offbeat hats, a clap and a short delay.',
    style: 'machine',
    flavour: 'machine',
    tempo: 128,
    swing: 52,
    seed: 1101,
    kitSeed: 2201,
    gen: { density: 0.55, complexity: 0.25, variation: 0.2, fills: 0.35 },
    sounds: { clap: { samples: [B('clap-tight')] }, perc: { samples: [B('rim'), B('shaker')], pick: 'cycle' }, fx: { samples: [B('zap')] } },
    variation: 0.3,
  },
  {
    id: 'broken-clock',
    name: 'BROKEN CLOCK',
    description: 'Every voice on its own cycle: fives and sevens against the bar, gently chopped.',
    style: 'polymeter',
    flavour: 'machine',
    tempo: 112,
    swing: 50,
    seed: 3303,
    kitSeed: 4404,
    gen: { density: 0.5, complexity: 0.4, variation: 0.1, fills: 0.2, bars: 4 },
    play: { perc: { length: 5 }, chat: { length: 7 }, htom: { length: 9 } },
    sounds: { perc: { samples: [B('glass-tick'), B('cowbell')], pick: 'cycle' }, clap: { samples: [B('clap-tight')] }, fx: { samples: [B('metal-clank')] } },
    destruction: { chop: { on: true, amount: 0.25, slice: 2 } },
  },
  {
    id: 'metallic-weather',
    name: 'METALLIC WEATHER',
    description: 'Ringing FM metal and noise under a ring modulator; the kit drifts as it plays.',
    style: 'glitch',
    flavour: 'industrial',
    tempo: 104,
    swing: 54,
    seed: 5505,
    kitSeed: 6606,
    gen: { density: 0.45, complexity: 0.6, variation: 0.4, fills: 0.3 },
    sounds: { perc: { samples: [B('metal-clank'), B('tambourine')], pick: 'random' }, fx: { samples: [B('noise-hit')], reverse: true } },
    mix: { cymbal: { volume: 0.74, route: 'fx' }, ohat: { route: 'fx' } },
    evolve: { target: 'sound', every: 2, amount: 0.45 },
  },
  {
    id: 'dusty-breaks',
    name: 'DUSTY BREAKS',
    description: 'A swung break with hybrid drums: dusty sampled transients over synthesised bodies, chopped and rolled.',
    style: 'breaks',
    flavour: 'acoustic',
    tempo: 94,
    swing: 58,
    seed: 7707,
    kitSeed: 8808,
    gen: { density: 0.55, complexity: 0.45, variation: 0.35, fills: 0.55 },
    sounds: {
      kick: { mode: 'hybrid', samples: [B('kick-dusty')], synthLevel: 0.7, sampleLevel: 0.6 },
      snare: { mode: 'hybrid', samples: [B('snare-crack')], synthLevel: 0.55, sampleLevel: 0.75 },
      chat: { mode: 'hybrid', samples: [B('hat-dusty')], synthLevel: 0.4, sampleLevel: 0.7 },
      clap: { samples: [B('clap-dusty')] },
      perc: { samples: [B('shaker'), B('tambourine')], pick: 'cycle' },
      fx: { samples: [B('conga')] },
    },
    play: { snare: { humanize: 25 }, chat: { humanize: 30 } },
    destruction: { chop: { on: true, amount: 0.35, slice: 4 }, rolls: { on: true, prob: 0.4, place: 'phrase', speed: '32' } },
    variation: 0.4,
  },
  {
    id: 'digital-detritus',
    name: 'DIGITAL DETRITUS',
    description: 'Euclidean glitches, decimated voices and a DESTROY layer that crushes, stutters and reverses.',
    style: 'glitch',
    flavour: 'glitch',
    tempo: 136,
    swing: 50,
    seed: 9909,
    kitSeed: 1010,
    gen: { density: 0.55, complexity: 0.7, variation: 0.5, fills: 0.4 },
    sounds: { perc: { samples: [B('zap'), B('glass-tick'), B('noise-hit')], pick: 'random' }, fx: { samples: [B('noise-hit')] }, clap: { samples: [B('clap-tight')] } },
    destruction: { destroy: { on: true, amount: 0.55, stutter: 0.4, crush: 0.5, reverse: 0.4, pitch: 0.3, gate: 0.3, skip: 0.1 } },
  },
  {
    id: 'industrial-estate',
    name: 'INDUSTRIAL ESTATE',
    description: 'Driven kicks, toms and clanging metal through the LXR distortion bus.',
    style: 'industrial',
    flavour: 'industrial',
    tempo: 118,
    swing: 50,
    seed: 1212,
    kitSeed: 1313,
    gen: { density: 0.6, complexity: 0.35, variation: 0.3, fills: 0.6 },
    sounds: { perc: { mode: 'hybrid', trigger: 2, samples: [B('metal-clank')], synthLevel: 0.6, sampleLevel: 0.5 }, clap: { samples: [B('clap-dusty')] }, fx: { samples: [B('noise-hit')] } },
    mix: { ltom: { route: 'fx' }, kick: { route: 'main' } },
    destruction: { chop: { on: true, amount: 0.3, slice: 4, retrigger: 0.5 } },
    variation: 0.35,
  },
  {
    id: 'wrong-answers',
    name: 'WRONG ANSWERS',
    description: 'Jungle tempo, heavily chopped and rolled; rhythm and kit both evolve as it plays.',
    style: 'jungle',
    flavour: 'acoustic',
    tempo: 172,
    swing: 50,
    seed: 1414,
    kitSeed: 1515,
    gen: { density: 0.6, complexity: 0.6, variation: 0.5, fills: 0.6 },
    sounds: { snare: { mode: 'hybrid', samples: [B('snare-crack')], synthLevel: 0.6, sampleLevel: 0.7 }, perc: { samples: [B('shaker'), B('rim')], pick: 'cycle' }, clap: { samples: [B('clap-dusty')] }, fx: { samples: [B('zap')] } },
    destruction: { chop: { on: true, amount: 0.7, slice: 2, retrigger: 0.5 }, rolls: { on: true, prob: 0.6, place: 'anywhere', speed: '32T' } },
    evolve: { target: 'both', every: 4, amount: 0.35, returnEvery: 3 },
  },
  {
    id: 'after-hours',
    name: 'AFTER HOURS',
    description: 'Late and sparse: dub space, ping-pong delay, long decays that slowly change colour.',
    style: 'dub',
    flavour: 'dub',
    tempo: 82,
    swing: 56,
    seed: 1616,
    kitSeed: 1717,
    gen: { density: 0.45, complexity: 0.3, variation: 0.25, fills: 0.3 },
    sounds: { perc: { samples: [B('rim'), B('conga')], pick: 'velocity' }, clap: { samples: [B('clap-dusty')] }, fx: { samples: [B('metal-clank')], tune: -7 } },
    mix: { snare: { route: 'fx' }, perc: { route: 'fx' } },
    evolve: { target: 'sound', every: 4, amount: 0.25 },
  },
];

/** Build a preset's project from the firmware's init kit. */
export function buildPreset(spec: PresetSpec, initKit: SynthKit): Project {
  const p = defaultProject();
  const style = styleById(spec.style);
  p.name = spec.name;
  p.tempo = spec.tempo;
  p.swing = spec.swing;
  p.seed = spec.seed;
  p.gen = { ...p.gen, style: spec.style, bars: style.bars, ...spec.gen };
  for (const t of p.tracks) {
    Object.assign(t.sound, spec.sounds?.[t.role] ?? {});
    Object.assign(t.mix, spec.mix?.[t.role] ?? {});
    Object.assign(t.play, spec.play?.[t.role] ?? {});
  }
  const a = newPattern('p1', 'A', p.gen);
  a.seed = spec.seed;
  a.gen = generate(p.tracks, p.gen, spec.seed, { steps: Math.min(64, stepsPerBar(4) * p.gen.bars), res: 4 });
  a.steps = Math.min(64, stepsPerBar(4) * p.gen.bars);
  p.patterns = [a];
  if (spec.variation) {
    const b = newPattern('p2', 'B', p.gen);
    b.steps = a.steps;
    b.seed = a.seed;
    b.gen = mutate(a.gen, p.tracks.map((t) => t.id), 4, new Rng(spec.seed ^ 0xb), spec.variation).grids;
    b.generation = 1;
    p.patterns.push(b);
    p.chain = { on: false, entries: [{ pattern: 'p1', repeats: 3 }, { pattern: 'p2', repeats: 1 }] };
  }
  p.current = 'p1';
  const d = spec.destruction ?? {};
  Object.assign(p.destruction.chop, d.chop ?? {});
  Object.assign(p.destruction.rolls, d.rolls ?? {});
  Object.assign(p.destruction.destroy, d.destroy ?? {});
  Object.assign(p.evolve, spec.evolve ?? {});
  p.kit = {
    name: spec.name,
    seed: spec.kitSeed,
    synth: generateKit(initKit, { seed: spec.kitSeed, flavour: spec.flavour, voiceRoles: voiceRolesOf(p.tracks), locks: p.soundLocks }),
  };
  return p;
}

/** Replace "bundled:<file>" references with sample ids. */
export function resolveBundled(p: Project, idOf: (file: string) => string | undefined): void {
  for (const t of p.tracks) t.sound.samples = t.sound.samples.map((s) => (s.startsWith('bundled:') ? idOf(s.slice(8)) ?? '' : s)).filter(Boolean);
}
