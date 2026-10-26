/**
 * Preferences: per browser, never part of a project (MIDI devices, the open view, export
 * settings). The palette preferences are Slop Factory Core's (`clatter.palette.*`).
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import { defaultMidiPrefs, repairMidiPrefs, type MidiPrefs } from '../midi/settings';
import { EXPORT_DEFAULTS } from './exportJob';
import { defaultWild, repairWild, type WildSettings } from '../destruction/wildcardProject';
import { DEFAULT_SCALE, snapScale } from '../ui/scale';

/** The tabs of the PATTERN view's workspace under the grid. */
export const WORKSPACES = ['sequence', 'trigger', 'sound', 'generate', 'transform', 'wildcard', 'track'] as const;
export type Workspace = (typeof WORKSPACES)[number];

/** The tabs of the SOUND view. (Before the overhaul the last one was 'kit': KIT & FX.) */
export const SOUND_TABS = ['synth', 'sample', 'modulation', 'variations', 'mixer', 'fx', 'kits'] as const;
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
  /** keyboard plays the selected track on number keys etc. */
  seenHelp: boolean;
  /** collapsible panels the user closed (window id -> collapsed) */
  collapsed: Record<string, boolean>;
}

const KEY = 'clatter.prefs';

export const defaultPrefs = (): Prefs => ({ view: 'pattern', workspace: 'sequence', soundTab: 'synth', soundLane: false, uiScale: DEFAULT_SCALE, editMode: 'basic', midi: defaultMidiPrefs(), exportBars: EXPORT_DEFAULTS.bars, exportTail: EXPORT_DEFAULTS.tail, wildcard: { ...defaultWild(), fixed: false }, seenHelp: false, collapsed: {} });

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
      midi: repairMidiPrefs(v.midi),
      // export length is not remembered between visits: a fresh export dialog offers the defaults
      wildcard: { ...repairWild(v.wildcard), fixed: (v.wildcard as { fixed?: unknown } | undefined)?.fixed === true },
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
