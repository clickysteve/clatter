/**
 * MIDI settings, in two scopes:
 *
 *   PER BROWSER (MidiPrefs, saved with the preferences, never in a project): which devices, the
 *   input channel filter, the note each controller pad plays, velocity sensitivity, the clock
 *   mode and MIDI Learn of the macros. These describe the rig on this computer: a project
 *   opened elsewhere must not try to reach devices that are not there.
 *
 *   PER PROJECT (portable, stable identifiers, see TrackMidi and CcSlot in model/types.ts): where
 *   each track's notes go (INTERNAL, MIDI or BOTH), its output channel, note and length, and the
 *   MIDI CC destinations modulation can drive. This is musical routing and travels with the
 *   project (and to CLATTER Pocket, which may honour only part of it).
 *
 * Devices are remembered by id and by name: Web MIDI ids are stable within a browser, and a name
 * finds the same device again when the id changed (another USB port, another browser profile).
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import { clamp, GM_NOTE, type CcSlot, type Role } from '../model/types';

/** Every connected input. */
export const ALL_INPUTS = '*';
/** Input channel 0: OMNI. */
export const OMNI = 0;
/** How many MIDI CC destinations modulation can drive. */
export const CC_SLOTS = 4;
/** Tracks the input note map covers (CLATTER's ten drum tracks; more tracks are mapped by MIDI Learn). */
export const MAP_TRACKS = 12;
/** "No note" in the input map. */
export const NO_NOTE = -1;

export type ClockMode = 'internal' | 'external' | 'off';
export const CLOCK_MODES: ClockMode[] = ['internal', 'external', 'off'];
export const CLOCK_LABEL: Record<ClockMode, string> = { internal: 'INTERNAL', external: 'EXTERNAL', off: 'OFF' };

/** A device, by id and by name (the name finds it again if the id changes). */
export interface DeviceRef {
  id: string;
  name: string;
}

/** A CC (or note) bound by MIDI Learn: Slop Factory Core's LearnMapping source, absolute mode. */
export interface CcLearn {
  /** 1-16, or null for any channel */
  channel: number | null;
  number: number;
}

export interface MidiPrefs {
  /** settings version (absent in the first MIDI preferences) */
  v: 2;
  /** the output device, or null */
  out: DeviceRef | null;
  /** the input device, ALL_INPUTS for every input, or null for none */
  input: DeviceRef | typeof ALL_INPUTS | null;
  /** input channel: OMNI (0) or 1-16 */
  inChannel: number;
  /** incoming notes play tracks */
  notesIn: boolean;
  /** master switch for note output (each track also chooses INTERNAL, MIDI or BOTH) */
  notesOut: boolean;
  clock: ClockMode;
  /** INTERNAL: send MIDI clock (24 per quarter) */
  sendClock: boolean;
  /** INTERNAL: send Start, Stop, Continue and Song Position */
  sendTransport: boolean;
  /** EXTERNAL: follow incoming Start, Stop and Continue (off: only the tempo is followed) */
  followTransport: boolean;
  /** velocity sensitivity 0-1: 0 plays every note at `velFixed`, 1 plays the velocity received */
  velSens: number;
  velFixed: number;
  /** the note that plays each track (by track position), NO_NOTE for none */
  inMap: number[];
  /** the device each CC destination goes to (null: the output device) */
  ccOut: (DeviceRef | null)[];
  /** MIDI Learn of the four macros */
  macroLearn: (CcLearn | null)[];
}

/** General MIDI drum notes in CLATTER's default track order. */
export const GM_MAP: number[] = ['kick', 'snare', 'clap', 'chat', 'ohat', 'ltom', 'htom', 'cymbal', 'perc', 'fx'].map((r) => GM_NOTE[r as Role]);

/** Input maps to start from: General MIDI, or pads sending consecutive notes from C1 (36), as most pad controllers do out of the box. */
export const INPUT_MAPS = {
  gm: { label: 'GENERAL MIDI DRUMS', notes: (n: number) => Array.from({ length: n }, (_, i) => GM_MAP[i] ?? NO_NOTE) },
  pads: { label: 'PADS FROM C1 (36, 37, 38…)', notes: (n: number) => Array.from({ length: n }, (_, i) => 36 + i) },
} as const;
export type InputMapId = keyof typeof INPUT_MAPS;

export const defaultMidiPrefs = (): MidiPrefs => ({
  v: 2,
  out: null,
  input: null,
  inChannel: OMNI,
  notesIn: true,
  notesOut: true,
  clock: 'internal',
  sendClock: false,
  sendTransport: true,
  followTransport: true,
  velSens: 1,
  velFixed: 100,
  inMap: INPUT_MAPS.gm.notes(MAP_TRACKS),
  ccOut: new Array(CC_SLOTS).fill(null),
  macroLearn: [null, null, null, null],
});

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const int = (v: unknown, d: number, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(clamp(v, lo, hi)) : d);
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);

function device(v: unknown): DeviceRef | null {
  if (!isObj(v) || typeof v.id !== 'string' || !v.id) return null;
  return { id: v.id.slice(0, 256), name: typeof v.name === 'string' ? v.name.slice(0, 128) : '' };
}

function learn(v: unknown): CcLearn | null {
  if (!isObj(v)) return null;
  const n = int(v.number, -1, -1, 127);
  if (n < 0) return null;
  return { channel: v.channel === null ? null : int(v.channel, 1, 1, 16), number: n };
}

/**
 * MIDI preferences from storage. The first version (outId, inId, clockIn, clockOut) is migrated:
 * following clock becomes EXTERNAL, sending clock INTERNAL with clock out, neither INTERNAL.
 */
export function repairMidiPrefs(v: unknown): MidiPrefs {
  const d = defaultMidiPrefs();
  if (!isObj(v)) return d;
  if (v.v !== 2) {
    const id = (x: unknown) => (typeof x === 'string' && x ? { id: x, name: '' } : null);
    return {
      ...d,
      out: id(v.outId),
      input: id(v.inId),
      inChannel: int(v.inChannel, 0, 0, 16),
      notesIn: bool(v.notesIn, true),
      notesOut: bool(v.notesOut, true),
      clock: v.clockIn === true ? 'external' : 'internal',
      sendClock: v.clockOut === true,
    };
  }
  const map = Array.isArray(v.inMap) ? v.inMap : [];
  return {
    v: 2,
    out: device(v.out),
    input: v.input === ALL_INPUTS ? ALL_INPUTS : device(v.input),
    inChannel: int(v.inChannel, OMNI, 0, 16),
    notesIn: bool(v.notesIn, d.notesIn),
    notesOut: bool(v.notesOut, d.notesOut),
    clock: CLOCK_MODES.includes(v.clock as ClockMode) ? (v.clock as ClockMode) : d.clock,
    sendClock: bool(v.sendClock, d.sendClock),
    sendTransport: bool(v.sendTransport, d.sendTransport),
    followTransport: bool(v.followTransport, d.followTransport),
    velSens: typeof v.velSens === 'number' && Number.isFinite(v.velSens) ? clamp(v.velSens, 0, 1) : d.velSens,
    velFixed: int(v.velFixed, d.velFixed, 1, 127),
    inMap: Array.from({ length: MAP_TRACKS }, (_, i) => int(map[i], d.inMap[i]!, NO_NOTE, 127)),
    ccOut: Array.from({ length: CC_SLOTS }, (_, i) => device((v.ccOut as unknown[] | undefined)?.[i])),
    macroLearn: [0, 1, 2, 3].map((i) => learn((v.macroLearn as unknown[] | undefined)?.[i])),
  };
}

/** The velocity a track plays for a received velocity: sensitivity blends the fixed level with what was played. */
export function scaleVelocity(vel: number, sens: number, fixed: number): number {
  const v = clamp(vel, 1, 127);
  return Math.round(clamp(fixed + (v - fixed) * clamp(sens, 0, 1), 1, 127));
}

/** Track positions whose input note another track also uses (shown as duplicates). */
export function duplicateNotes(map: readonly number[], count = map.length): Set<number> {
  const by = new Map<number, number[]>();
  for (let i = 0; i < count; i++) {
    const n = map[i] ?? NO_NOTE;
    if (n < 0) continue;
    const l = by.get(n) ?? [];
    l.push(i);
    by.set(n, l);
  }
  const out = new Set<number>();
  for (const l of by.values()) if (l.length > 1) for (const i of l) out.add(i);
  return out;
}

/** Find a remembered device among the available ones: by id, else by name. */
export function findDevice<T extends { id: string; name: string; connected?: boolean }>(ref: DeviceRef | null, ports: readonly T[]): T | null {
  if (!ref) return null;
  const live = ports.filter((p) => p.connected !== false);
  return live.find((p) => p.id === ref.id) ?? (ref.name ? (live.find((p) => p.name === ref.name) ?? null) : null);
}

// ---------------------------------------------------------------------------- per project

/** A CC destination's defaults: CC 74 (brightness) and up, channel 1, centred at 64 for bipolar sources. */
export const defaultCcSlot = (i: number): CcSlot => ({ on: true, cc: [74, 71, 1, 11][i] ?? 74, channel: 1, base: 0, res: 128, rate: 50 });
export const defaultCcSlots = (): CcSlot[] => Array.from({ length: CC_SLOTS }, (_, i) => defaultCcSlot(i));

export function repairCcSlots(v: unknown): CcSlot[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return Array.from({ length: CC_SLOTS }, (_, i) => {
    const o = isObj(v[i]) ? (v[i] as Obj) : {};
    const d = defaultCcSlot(i);
    return { on: bool(o.on, d.on), cc: int(o.cc, d.cc, 0, 119), channel: int(o.channel, d.channel, 1, 16), base: int(o.base, d.base, 0, 127), res: int(o.res, d.res, 2, 128), rate: int(o.rate, d.rate, 1, 100) };
  });
}
