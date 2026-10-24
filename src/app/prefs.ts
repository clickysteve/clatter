/**
 * Preferences: per browser, never part of a project (MIDI devices, the open view, export
 * settings). The palette preferences are Slop Factory Core's (`clatter.palette.*`).
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import { defaultMidiPrefs, type MidiPrefs } from '../midi/controller';

export interface Prefs {
  view: 'pattern' | 'sound' | 'perform';
  editMode: 'basic' | 'advanced';
  midi: MidiPrefs;
  exportBars: number;
  exportTail: number;
  /** keyboard plays the selected track on number keys etc. */
  seenHelp: boolean;
  /** collapsible panels the user closed (window id -> collapsed) */
  collapsed: Record<string, boolean>;
}

const KEY = 'clatter.prefs';

export const defaultPrefs = (): Prefs => ({ view: 'pattern', editMode: 'basic', midi: defaultMidiPrefs(), exportBars: 8, exportTail: 2, seenHelp: false, collapsed: {} });

export function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaultPrefs();
    const v = JSON.parse(raw) as Partial<Prefs>;
    const d = defaultPrefs();
    return {
      view: v.view === 'sound' || v.view === 'perform' ? v.view : 'pattern',
      editMode: v.editMode === 'advanced' ? 'advanced' : 'basic',
      midi: { ...d.midi, ...(v.midi ?? {}) },
      exportBars: typeof v.exportBars === 'number' ? Math.max(1, Math.min(256, v.exportBars)) : d.exportBars,
      exportTail: typeof v.exportTail === 'number' ? Math.max(0, Math.min(20, v.exportTail)) : d.exportTail,
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
