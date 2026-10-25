/**
 * Colour palettes on Slop Factory Core's palette system: CLATTER declares its roles (the
 * shared six, plus one area role per system so RHYTHM, SOUND, DESTRUCTION and PERFORM can have
 * their own ink), and Core does the rest: the style sheet, contrast warnings, preferences
 * (`clatter.palette.*`), palette files that import across Slop Factory applications, and the
 * palette editor. Purely cosmetic: nothing here touches the music.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import { ATARI, DARK, SHARED_PRESETS, SHARED_ROLES, PaletteLibrary, applyPalette, type Palette, type PaletteConfig } from '@slopfactory/core/palette';

const area = (id: string, label: string, help: string) => ({ id, label, help, css: `--area-${id}`, area: true, from: 'ink', contrast: 3 });

export const CLATTER_ROLES = [
  ...SHARED_ROLES,
  area('rhythm', 'Rhythm', 'pattern grid, generator, track controls'),
  area('destruction', 'Destruction', 'CHOP, ROLLS, DESTROY, WILDCARD'),
  area('sound', 'Sound', 'synth editor, samples, kit, mixer'),
  area('perform', 'Perform', 'the performance view'),
  area('transport', 'Transport', 'transport, patterns, menus'),
];

/** CLATTER's own colour palette: each system in its own ink. */
export const COLOUR: Palette = {
  id: 'colour',
  name: 'Colour',
  builtIn: true,
  colors: {
    desktop: '#2a2622',
    paper: '#f6f1e4',
    ink: '#1e1c1a',
    dim: '#8a8273',
    activity: '#d23c1e',
    selection: '#1f5f8b',
    rhythm: '#1f5f8b',
    destruction: '#a3301c',
    sound: '#2f6b3a',
    perform: '#6b3a8a',
    transport: '#1e1c1a',
  },
};

/** AMFAS (All My Friends Are Synths): the house colours, exactly as supplied in AMFAS.clatter-palette.json. */
export const AMFAS: Palette = {
  id: 'amfas',
  name: 'AMFAS',
  builtIn: true,
  colors: {
    desktop: '#ff6600',
    paper: '#fafafa',
    ink: '#1e1c1a',
    dim: '#4f4f4f',
    activity: '#d23c1e',
    selection: '#ff6600',
    rhythm: '#000000',
    destruction: '#ff0000',
    sound: '#c00202',
    perform: '#002db3',
    transport: '#ffa200',
  },
};

/** AMFAS INVERT: the same house on black, exactly as supplied in AMFAS INVERT.clatter-palette.json. */
export const AMFAS_INVERT: Palette = {
  id: 'amfas-invert',
  name: 'AMFAS INVERT',
  builtIn: true,
  colors: {
    desktop: '#ff6600',
    paper: '#000000',
    ink: '#ff643d',
    dim: '#f54242',
    activity: '#d23c1e',
    selection: '#ff6600',
    rhythm: '#ffffff',
    destruction: '#ff0000',
    sound: '#ffffff',
    perform: '#002db3',
    transport: '#ffa200',
  },
};

export const PALETTE_CONFIG: PaletteConfig = {
  app: 'clatter',
  roles: CLATTER_ROLES,
  builtIns: [{ ...ATARI, name: 'Classic' }, DARK, COLOUR, AMFAS, AMFAS_INVERT, ...SHARED_PRESETS.filter((p) => p.id !== ATARI.id && p.id !== DARK.id)],
  accept: ['emmm-palette', 'breakery-palette', 'downbeat-palette', 'anvil-palette', 'goodbits-palette'],
};

let lib: PaletteLibrary | null = null;

export function palettes(): PaletteLibrary {
  lib ??= new PaletteLibrary(PALETTE_CONFIG);
  return lib;
}

export function applySelectedPalette(): void {
  applyPalette(PALETTE_CONFIG, palettes().selected.colors);
}

/** Current colours (for canvas drawing). */
export function colors(): Record<string, string> {
  const c = palettes().selected.colors;
  return { ...c };
}
