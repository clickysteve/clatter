/**
 * Rhythm styles: how each kind of track behaves in a style.
 *
 * A LANE gives, for each sixteenth of a 4/4 bar, the chance of a hit (a digit: '9' always, '5'
 * about half the time, '.' never) and, through the same digits, how strong the hit is (louder
 * digits are louder hits). A lane can instead be EUCLIDEAN (hits spread evenly over a cycle that
 * need not fit the bar: cross-rhythms). The generator (generate.ts) scales these by DENSITY,
 * shifts weight off the beat with COMPLEXITY, varies the bars with VARIATION and writes FILLS
 * into the phrase end.
 *
 * The probability-per-position idea follows DOWNBEAT's metric weighting (its mutation prefers
 * weak positions) and The Breakery's style recipes (a style weights shared operations rather
 * than having an algorithm of its own); the styles and every number are CLATTER's.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import type { Role } from '../model/types';

export interface Lane {
  /** 16 characters: '0'-'9' chance and strength, '.' none */
  p?: string;
  /** Euclidean lane: hits and cycle length ranges */
  euclid?: { hits: [number, number]; len: [number, number] };
  /** chance of soft ghost notes in this lane's empty off-beats (0-1) */
  ghost?: number;
}

export interface Style {
  id: string;
  label: string;
  description: string;
  tempo: [number, number];
  swing: [number, number];
  /** typical length in bars */
  bars: number;
  lanes: Partial<Record<Role, Lane>>;
  /** roles that play fills at the phrase end */
  fillRoles: Role[];
  /** the kick avoids the backbeat snare */
  separateKickSnare: boolean;
  /** sound character the kit generator leans towards */
  kitFlavour: KitFlavour;
}

export type KitFlavour = 'machine' | 'electro' | 'acoustic' | 'industrial' | 'glitch' | 'dub';

export const STYLES: Style[] = [
  {
    id: 'machine',
    label: 'MACHINE',
    description: 'Four on the floor, offbeat hats, claps on two and four.',
    tempo: [124, 138],
    swing: [50, 54],
    bars: 2,
    separateKickSnare: false,
    kitFlavour: 'machine',
    fillRoles: ['clap', 'perc', 'htom'],
    lanes: {
      kick: { p: '9...9...9...9..1' },
      clap: { p: '....9.......9...' },
      snare: { p: '............2...' },
      chat: { p: '2.9.2.9.2.9.2.9.' },
      ohat: { p: '..3...3...3...3.' },
      perc: { p: '..2.1..3..2.1.3.', ghost: 0.1 },
      ltom: { p: '...........1....' },
      htom: { p: '..............1.' },
      cymbal: { p: '2...............' },
      fx: { p: '.......1.......1' },
    },
  },
  {
    id: 'electro',
    label: 'ELECTRO',
    description: 'Syncopated machine kicks, a hard backbeat, busy hats.',
    tempo: [118, 132],
    swing: [50, 56],
    bars: 2,
    separateKickSnare: true,
    kitFlavour: 'electro',
    fillRoles: ['snare', 'htom', 'ltom'],
    lanes: {
      kick: { p: '9.....6...5.2..1' },
      snare: { p: '....9.......9...' },
      clap: { p: '....3.......4...' },
      chat: { p: '6464646464646464' },
      ohat: { p: '.......3.......2' },
      perc: { p: '..3..3....3..3..' },
      htom: { p: '............2.3.' },
      ltom: { p: '...........2..2.' },
      cymbal: { p: '2...............' },
      fx: { p: '...1.......1....' },
    },
  },
  {
    id: 'breaks',
    label: 'BREAKS',
    description: 'A funk break: syncopated kicks, ghosted snare, eighth hats.',
    tempo: [92, 110],
    swing: [52, 60],
    bars: 2,
    separateKickSnare: true,
    kitFlavour: 'acoustic',
    fillRoles: ['snare', 'htom', 'ltom'],
    lanes: {
      kick: { p: '9.....5.2.7....3' },
      snare: { p: '....9..2.2..9..2', ghost: 0.35 },
      clap: { p: '............1...' },
      chat: { p: '8.6.8.6.8.6.8.6.' },
      ohat: { p: '......3.......3.' },
      perc: { p: '...2.......2....' },
      htom: { p: '..............1.' },
      ltom: { p: '...............1' },
      cymbal: { p: '3...............' },
    },
  },
  {
    id: 'jungle',
    label: 'JUNGLE',
    description: 'Fast chopped breaks: displaced snares, rolling ghosts.',
    tempo: [160, 176],
    swing: [50, 54],
    bars: 2,
    separateKickSnare: true,
    kitFlavour: 'acoustic',
    fillRoles: ['snare', 'perc', 'htom'],
    lanes: {
      kick: { p: '9.........7...2.' },
      snare: { p: '....9.2..3.29.2.', ghost: 0.45 },
      clap: { p: '................' },
      chat: { p: '7575757575757575' },
      ohat: { p: '..2.......2.....' },
      perc: { p: '...2..3....2..3.' },
      htom: { p: '.............2..' },
      ltom: { p: '..............2.' },
      cymbal: { p: '4.......1.......' },
      fx: { p: '...............1' },
    },
  },
  {
    id: 'halftime',
    label: 'HALFTIME',
    description: 'Half-time weight: snare on three, busy sixteenth hats.',
    tempo: [140, 174],
    swing: [50, 56],
    bars: 2,
    separateKickSnare: true,
    kitFlavour: 'electro',
    fillRoles: ['snare', 'htom', 'ltom', 'perc'],
    lanes: {
      kick: { p: '9......3..4.....' },
      snare: { p: '........9.......', ghost: 0.15 },
      clap: { p: '........4.......' },
      chat: { p: '7454745474547454' },
      ohat: { p: '......2.......2.' },
      perc: { p: '.3....2....3..2.' },
      htom: { p: '.............2..' },
      ltom: { p: '..............2.' },
      cymbal: { p: '3...............' },
      fx: { p: '..........1.....' },
    },
  },
  {
    id: 'broken',
    label: 'BROKEN',
    description: 'Broken beat: off-centre kicks and a snare that will not sit still.',
    tempo: [112, 126],
    swing: [54, 62],
    bars: 2,
    separateKickSnare: true,
    kitFlavour: 'acoustic',
    fillRoles: ['snare', 'perc'],
    lanes: {
      kick: { p: '9..4..6...5..3..' },
      snare: { p: '....9..3.2..8...', ghost: 0.25 },
      clap: { p: '............3...' },
      chat: { p: '6.4.6.4.6.4.6.4.' },
      ohat: { p: '...2.......3....' },
      perc: { p: '..3...2..3....2.' },
      htom: { p: '..........2.....' },
      ltom: { p: '.............2..' },
      cymbal: { p: '2...............' },
    },
  },
  {
    id: 'garage',
    label: 'GARAGE',
    description: 'Two-step shuffle: skippy kicks, rimshots, swung hats.',
    tempo: [128, 136],
    swing: [58, 66],
    bars: 2,
    separateKickSnare: true,
    kitFlavour: 'machine',
    fillRoles: ['perc', 'snare'],
    lanes: {
      kick: { p: '9......5..6.....' },
      snare: { p: '....9.......9...' },
      clap: { p: '....4.......4...' },
      chat: { p: '..7...7...7...7.' },
      ohat: { p: '.......3........' },
      perc: { p: '...3....2..3....', ghost: 0.15 },
      htom: { p: '..............2.' },
      cymbal: { p: '1...............' },
    },
  },
  {
    id: 'industrial',
    label: 'INDUSTRIAL',
    description: 'Heavy kicks, metal percussion, toms and noise.',
    tempo: [110, 130],
    swing: [50, 52],
    bars: 2,
    separateKickSnare: false,
    kitFlavour: 'industrial',
    fillRoles: ['ltom', 'htom', 'perc', 'snare'],
    lanes: {
      kick: { p: '9..5..9.9..5..7.' },
      snare: { p: '....9.......9..3' },
      clap: { p: '....5.......5...' },
      chat: { p: '5.3.5.3.5.3.5.3.' },
      ohat: { p: '..2.......2.....' },
      ltom: { p: '..3.....3..2....' },
      htom: { p: '......3.......3.' },
      perc: { p: '7..5.4..7..5.4..' },
      cymbal: { p: '4.......2.......' },
      fx: { p: '......2.........' },
    },
  },
  {
    id: 'glitch',
    label: 'GLITCH',
    description: 'Euclidean cross-rhythms that drift against the bar.',
    tempo: [96, 140],
    swing: [50, 58],
    bars: 2,
    separateKickSnare: false,
    kitFlavour: 'glitch',
    fillRoles: ['perc', 'fx', 'snare'],
    lanes: {
      kick: { euclid: { hits: [3, 5], len: [7, 13] } },
      snare: { euclid: { hits: [2, 3], len: [9, 16] } },
      clap: { euclid: { hits: [1, 2], len: [11, 16] } },
      chat: { euclid: { hits: [5, 9], len: [11, 16] } },
      ohat: { euclid: { hits: [1, 3], len: [7, 13] } },
      perc: { euclid: { hits: [3, 7], len: [5, 13] } },
      ltom: { euclid: { hits: [1, 3], len: [7, 15] } },
      htom: { euclid: { hits: [1, 3], len: [5, 11] } },
      cymbal: { euclid: { hits: [1, 1], len: [15, 31] } },
      fx: { euclid: { hits: [1, 3], len: [9, 17] } },
    },
  },
  {
    id: 'polymeter',
    label: 'POLYMETER',
    description: 'Every voice on its own cycle: three, five, seven against four.',
    tempo: [100, 124],
    swing: [50, 54],
    bars: 4,
    separateKickSnare: false,
    kitFlavour: 'machine',
    fillRoles: ['perc'],
    lanes: {
      kick: { p: '9.......9.......' },
      snare: { euclid: { hits: [2, 2], len: [6, 7] } },
      clap: { euclid: { hits: [1, 1], len: [5, 5] } },
      chat: { euclid: { hits: [3, 4], len: [5, 7] } },
      ohat: { euclid: { hits: [1, 1], len: [3, 3] } },
      perc: { euclid: { hits: [2, 3], len: [5, 7] } },
      htom: { euclid: { hits: [1, 2], len: [7, 9] } },
      ltom: { euclid: { hits: [1, 1], len: [9, 11] } },
      cymbal: { p: '2...............' },
    },
  },
  {
    id: 'dub',
    label: 'DUB',
    description: 'Sparse and heavy: space for the delay to fill.',
    tempo: [68, 90],
    swing: [52, 60],
    bars: 2,
    separateKickSnare: true,
    kitFlavour: 'dub',
    fillRoles: ['perc', 'snare'],
    lanes: {
      kick: { p: '9.......4.......' },
      snare: { p: '........9.......' },
      clap: { p: '........2.......' },
      chat: { p: '..5...5...5...5.' },
      ohat: { p: '..2.......2.....' },
      perc: { p: '...3......3.....' },
      htom: { p: '..............2.' },
      fx: { p: '.......2........' },
    },
  },
];

export function styleById(id: string): Style {
  return STYLES.find((s) => s.id === id) ?? STYLES[0]!;
}

/** The chance (0-1) a digit stands for. */
export const digitChance = (c: string): number => (c >= '0' && c <= '9' ? Number(c) / 9 : 0);
