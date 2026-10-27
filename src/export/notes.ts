/**
 * Note names, scales and note ranges for the kit exporter. One naming convention everywhere:
 * MIDI note 60 is C4 and 69 is A4 (440 Hz), the same as the TUNER (src/analysis/pitch.ts).
 * Sharps are written with "#" in the metadata and "s" in file names ("F#2" is "Fs2").
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import { noteName } from '../analysis/pitch';
import { SCALE_TYPES } from '../music/scale';

export { noteName };

export const MIDI_MIN = 0;
export const MIDI_MAX = 127;

const PITCH_CLASS: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/**
 * A note from a MIDI number ("60", "midi:60") or a name ("C4", "f#2", "Gb3", "C-1"); null when it
 * is neither or outside 0-127. Octave numbering: C4 = 60.
 */
export function parseNote(text: string): number | null {
  const s = text.trim();
  if (/^(midi:?)?\d+$/i.test(s)) {
    const n = Number(s.replace(/^midi:?/i, ''));
    return n >= MIDI_MIN && n <= MIDI_MAX ? n : null;
  }
  const m = /^([A-Ga-g])([#sSbB♯♭]?)(-?\d+)$/.exec(s);
  if (!m) return null;
  const base = PITCH_CLASS[m[1]!.toUpperCase()]!;
  const acc = m[2]!;
  const shift = acc === '#' || acc === 's' || acc === 'S' || acc === '♯' ? 1 : acc === 'b' || acc === 'B' || acc === '♭' ? -1 : 0;
  const n = (Number(m[3]) + 1) * 12 + base + shift;
  return n >= MIDI_MIN && n <= MIDI_MAX ? n : null;
}

/** The note as a file-name part: "F#2" becomes "Fs2". */
export const fileNote = (n: number): string => noteName(n).replace('#', 's');

/**
 * Scales as semitone offsets from the root: the shared table of src/music/scale.ts (the USER scale
 * is a project's own and has no name to export by).
 */
export const SCALES: Record<string, { label: string; steps: number[] }> = Object.fromEntries(SCALE_TYPES.filter((t) => t.id !== 'user').map((t) => [t.id, { label: t.label, steps: t.steps.slice() }]));

/** Every note from `lo` to `hi` inclusive (either order). */
export function chromaticRange(lo: number, hi: number): number[] {
  const a = Math.max(MIDI_MIN, Math.min(lo, hi));
  const b = Math.min(MIDI_MAX, Math.max(lo, hi));
  const out: number[] = [];
  for (let n = a; n <= b; n++) out.push(n);
  return out;
}

/** The notes of a scale (root is a pitch class 0-11, or any note: only its class counts) between `lo` and `hi`. */
export function scaleNotes(root: number, scale: string, lo: number, hi: number): number[] {
  const sc = SCALES[scale];
  if (!sc) throw new Error(`unknown scale "${scale}"`);
  const cls = new Set(sc.steps.map((s) => (((root % 12) + 12) % 12 + s) % 12));
  return chromaticRange(lo, hi).filter((n) => cls.has(n % 12));
}

/**
 * A custom note list: comma, space or semicolon separated notes and ranges ("C2-C3", "36..48",
 * "F#1, A2"). Returns the notes ascending without repeats, or the first thing that did not parse.
 */
export function parseNoteList(text: string): { notes: number[] } | { error: string } {
  const parts = text.split(/[,;\s]+/).filter(Boolean);
  if (!parts.length) return { error: 'ENTER AT LEAST ONE NOTE' };
  const set = new Set<number>();
  for (const part of parts) {
    const m = /^(.+?)(?:\.\.|(?<=[0-9A-Za-z#])-(?=[A-Ga-g]|midi|\d))(.+)$/i.exec(part);
    const single = parseNote(part);
    if (single !== null) {
      set.add(single);
      continue;
    }
    if (m) {
      const a = parseNote(m[1]!);
      const b = parseNote(m[2]!);
      if (a !== null && b !== null) {
        for (const n of chromaticRange(a, b)) set.add(n);
        continue;
      }
    }
    return { error: `NOT A NOTE: "${part}" (USE C2, F#3, 48 OR A RANGE LIKE C2-C3)` };
  }
  return { notes: [...set].sort((a, b) => a - b) };
}
