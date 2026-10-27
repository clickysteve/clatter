/**
 * Preferences: per browser, never part of a project (MIDI devices, the open view, export
 * settings). The palette preferences are Slop Factory Core's (`clatter.palette.*`).
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import { defaultMidiPrefs, type MidiPrefs } from '../midi/controller';
import { EXPORT_DEFAULTS } from './exportJob';
import { defaultWild, repairWild, type WildSettings } from '../destruction/wildcardProject';
import { DEFAULT_SCALE, snapScale } from '../ui/scale';
import { checkedSeedText, type SeedValue } from '../rhythm/seed';
import { CHARACTERS, clampWildness, WILDNESS_DEFAULT } from '../sound/discover';
import type { KitFlavour } from '../rhythm/styles';

/** The generators that have a seed field of their own. (WILDCARD keeps its seed with its other settings.) */
export const SEED_SLOTS = ['pattern', 'kit', 'sound', 'discover'] as const;
export type SeedSlot = (typeof SEED_SLOTS)[number] | 'wildcard';

/**
 * The seed a generator uses on its next press. FIXED: every press uses this seed (the same
 * settings and starting state give the same result). Not fixed: every press draws a new memorable
 * phrase and shows it here, so the last result can always be made again.
 */
export interface SeedSlotPref {
  value: SeedValue | null;
  fixed: boolean;
}

/** The tabs of the PATTERN view's workspace under the grid. */
export const WORKSPACES = ['sequence', 'trigger', 'sound', 'generate', 'transform', 'wildcard', 'track'] as const;
export type Workspace = (typeof WORKSPACES)[number];

/** The tabs of the SOUND view. (Before the overhaul the last one was 'kit': KIT & FX.) */
export const SOUND_TABS = ['synth', 'sample', 'modulation', 'variations', 'mixer', 'fx', 'tuner', 'scale', 'discover', 'kits'] as const;
export type SoundTab = (typeof SOUND_TABS)[number];

export interface Prefs {
  view: 'pattern' | 'sound' | 'perform';
  /** the tab open under the pattern grid */
  workspace: Workspace;
  /** the tab open in the SOUND view */
  soundTab: SoundTab;
  /** the sound lane under the selected track in the pattern grid */
  soundLane: boolean;
  /** interface scale (1 = 100 %); see src/ui/scale.ts */
  uiScale: number;
  editMode: 'basic' | 'advanced';
  midi: MidiPrefs;
  exportBars: number;
  exportTail: number;
  /** WILDCARD: intensity, scope, categories, the seed of the last press, and whether the seed is held between presses */
  wildcard: WildSettings & { fixed: boolean };
  /** the seed field of each generator (GENERATE, GENERATE KIT, the sound generators) */
  seeds: Record<(typeof SEED_SLOTS)[number], SeedSlotPref>;
  /** SOUND DISCOVERY: the character (a kit flavour; 'style' follows the rhythm style) and the wildness 0.05-1 */
  discover: { character: KitFlavour | 'style'; wildness: number };
  /** keyboard plays the selected track on number keys etc. */
  seenHelp: boolean;
  /** collapsible panels the user closed (window id -> collapsed) */
  collapsed: Record<string, boolean>;
}

const KEY = 'clatter.prefs';

export const defaultPrefs = (): Prefs => ({ view: 'pattern', workspace: 'sequence', soundTab: 'synth', soundLane: false, uiScale: DEFAULT_SCALE, editMode: 'basic', midi: defaultMidiPrefs(), exportBars: EXPORT_DEFAULTS.bars, exportTail: EXPORT_DEFAULTS.tail, wildcard: { ...defaultWild(), fixed: false }, seeds: { pattern: { value: null, fixed: false }, kit: { value: null, fixed: false }, sound: { value: null, fixed: false }, discover: { value: null, fixed: false } }, discover: { character: 'style', wildness: WILDNESS_DEFAULT }, seenHelp: false, collapsed: {} });

function repairSlot(v: unknown): SeedSlotPref {
  const o = v && typeof v === 'object' ? (v as { value?: { seed?: unknown; text?: unknown }; fixed?: unknown }) : {};
  const seed = o.value?.seed;
  if (typeof seed !== 'number' || !Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) return { value: null, fixed: false };
  const text = checkedSeedText(seed, o.value?.text);
  return { value: { seed, ...(text ? { text } : {}) }, fixed: o.fixed === true };
}

export function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaultPrefs();
    const v = JSON.parse(raw) as Partial<Prefs>;
    const d = defaultPrefs();
    return {
      view: v.view === 'sound' || v.view === 'perform' ? v.view : 'pattern',
      workspace: WORKSPACES.find((w) => w === v.workspace) ?? 'sequence',
      soundTab: SOUND_TABS.find((w) => w === v.soundTab) ?? ((v.soundTab as string) === 'kit' ? 'kits' : 'synth'),
      soundLane: v.soundLane === true,
      uiScale: snapScale(v.uiScale),
      editMode: v.editMode === 'advanced' ? 'advanced' : 'basic',
      midi: { ...d.midi, ...(v.midi ?? {}) },
      // export length is not remembered between visits: a fresh export dialog offers the defaults
      wildcard: { ...repairWild(v.wildcard), fixed: (v.wildcard as { fixed?: unknown } | undefined)?.fixed === true },
      seeds: Object.fromEntries(SEED_SLOTS.map((s) => [s, repairSlot((v.seeds as Record<string, unknown> | undefined)?.[s])])) as Prefs['seeds'],
      discover: { character: CHARACTERS.find((c) => c.id === v.discover?.character)?.id ?? 'style', wildness: clampWildness(typeof v.discover?.wildness === 'number' ? v.discover.wildness : WILDNESS_DEFAULT) },
      exportBars: d.exportBars,
      exportTail: d.exportTail,
      seenHelp: v.seenHelp === true,
      collapsed: v.collapsed && typeof v.collapsed === 'object' ? Object.fromEntries(Object.entries(v.collapsed).filter(([, x]) => typeof x === 'boolean')) : {},
    };
  } catch {
    return defaultPrefs();
  }
}

export function savePrefs(p: Prefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* storage blocked: preferences last for this session */
  }
}
