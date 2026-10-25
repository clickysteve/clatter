/*
 * From DOWNBEAT (https://github.com/clickysteve/downbeat, src/midi/smf.ts),
 * Copyright (c) 2026 The DOWNBEAT contributors, MIT licence (see THIRD_PARTY_NOTICES.md).
 * Unmodified apart from this notice.
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
/** Standard MIDI File writing (types 0 and 1) and reading. */

export interface SmfEvent {
  /** Absolute tick at the file's resolution. */
  tick: number;
  bytes: number[];
}

export interface SmfTrack {
  name: string;
  events: SmfEvent[];
}

export interface SmfSpec {
  format: 0 | 1;
  ppq: number;
  bpm: number;
  /** further tempo changes (tick, bpm), after the first tempo at tick 0 */
  tempos?: { tick: number; bpm: number }[];
  timeSig: [number, number];
  tracks: SmfTrack[];
  /** Length of the file in ticks (end-of-track placement). */
  endTick?: number;
}

function vlq(n: number): number[] {
  let v = Math.max(0, Math.round(n));
  const out = [v & 0x7f];
  v >>= 7;
  while (v > 0) {
    out.unshift((v & 0x7f) | 0x80);
    v >>= 7;
  }
  return out;
}

const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u16 = (n: number) => [(n >>> 8) & 255, n & 255];
const ascii = (s: string) => Array.from(s).map((c) => c.charCodeAt(0) & 0x7f);

function chunk(type: string, data: number[]): number[] {
  return [...ascii(type), ...u32(data.length), ...data];
}

function trackData(events: SmfEvent[], name: string | null, meta: SmfEvent[], endTick: number): number[] {
  const all: SmfEvent[] = [...meta, ...events].map((e, i) => ({ ...e, i }) as SmfEvent & { i: number });
  // Stable by tick; note-offs (and velocity-0 note-ons) before note-ons at the same tick.
  const rank = (b: number[]) => (b[0] === 0xff ? 0 : (b[0]! & 0xf0) === 0x80 || ((b[0]! & 0xf0) === 0x90 && b[2] === 0) ? 1 : 2);
  (all as (SmfEvent & { i: number })[]).sort((a, b) => a.tick - b.tick || rank(a.bytes) - rank(b.bytes) || a.i - b.i);
  const out: number[] = [];
  let last = 0;
  if (name !== null) {
    const nb = ascii(name);
    out.push(0, 0xff, 0x03, ...vlq(nb.length), ...nb);
  }
  for (const e of all) {
    const t = Math.max(last, Math.round(e.tick));
    out.push(...vlq(t - last), ...e.bytes);
    last = t;
  }
  out.push(...vlq(Math.max(0, Math.round(endTick) - last)), 0xff, 0x2f, 0x00);
  return out;
}

export function writeSmf(spec: SmfSpec): Uint8Array {
  const usPerQ = Math.round(60000000 / spec.bpm);
  const [num, den] = spec.timeSig;
  const tempoMeta: SmfEvent = { tick: 0, bytes: [0xff, 0x51, 0x03, (usPerQ >> 16) & 255, (usPerQ >> 8) & 255, usPerQ & 255] };
  const later: SmfEvent[] = (spec.tempos ?? []).map((c) => {
    const us = Math.round(60000000 / c.bpm);
    return { tick: c.tick, bytes: [0xff, 0x51, 0x03, (us >> 16) & 255, (us >> 8) & 255, us & 255] };
  });
  const tsMeta: SmfEvent = { tick: 0, bytes: [0xff, 0x58, 0x04, num, Math.round(Math.log2(den)), 24, 8] };
  const end = spec.endTick ?? Math.max(0, ...spec.tracks.flatMap((t) => t.events.map((e) => e.tick)));
  const chunks: number[] = [];
  if (spec.format === 0) {
    const events = spec.tracks.flatMap((t) => t.events);
    chunks.push(...chunk('MTrk', trackData(events, spec.tracks[0]?.name ?? 'DOWNBEAT', [tempoMeta, tsMeta, ...later], end)));
    return new Uint8Array([...chunk('MThd', [...u16(0), ...u16(1), ...u16(spec.ppq)]), ...chunks]);
  }
  chunks.push(...chunk('MTrk', trackData([], 'DOWNBEAT', [tempoMeta, tsMeta, ...later], end)));
  for (const t of spec.tracks) chunks.push(...chunk('MTrk', trackData(t.events, t.name, [], end)));
  return new Uint8Array([...chunk('MThd', [...u16(1), ...u16(spec.tracks.length + 1), ...u16(spec.ppq)]), ...chunks]);
}

export interface ParsedNote {
  tick: number;
  channel: number;
  note: number;
  velocity: number;
}

export interface ParsedSmf {
  format: number;
  ppq: number;
  bpm: number | null;
  timeSig: [number, number] | null;
  notes: ParsedNote[];
  lastTick: number;
}

export class SmfError extends Error {}

/** Parse a Standard MIDI File (PPQ resolution only). Collects note-ons, tempo and time signature. */
export function parseSmf(data: Uint8Array): ParsedSmf {
  let p = 0;
  const need = (n: number) => {
    if (p + n > data.length) throw new SmfError('The file ends unexpectedly.');
  };
  const str = (n: number) => {
    need(n);
    const s = String.fromCharCode(...data.subarray(p, p + n));
    p += n;
    return s;
  };
  const r32 = () => {
    need(4);
    const v = ((data[p]! << 24) | (data[p + 1]! << 16) | (data[p + 2]! << 8) | data[p + 3]!) >>> 0;
    p += 4;
    return v;
  };
  const r16 = () => {
    need(2);
    const v = (data[p]! << 8) | data[p + 1]!;
    p += 2;
    return v;
  };
  if (str(4) !== 'MThd') throw new SmfError('Not a Standard MIDI File (no MThd header).');
  const hlen = r32();
  const format = r16();
  const ntracks = r16();
  const division = r16();
  p += hlen - 6;
  if (division & 0x8000) throw new SmfError('SMPTE-timed MIDI files are not supported.');
  const out: ParsedSmf = { format, ppq: division, bpm: null, timeSig: null, notes: [], lastTick: 0 };
  for (let t = 0; t < ntracks && p < data.length; t++) {
    const id = str(4);
    const len = r32();
    const end = p + len;
    if (id !== 'MTrk') {
      p = end;
      continue;
    }
    let tick = 0;
    let running = 0;
    const vread = () => {
      let v = 0;
      for (let k = 0; k < 4; k++) {
        need(1);
        const b = data[p++]!;
        v = (v << 7) | (b & 0x7f);
        if (!(b & 0x80)) break;
      }
      return v;
    };
    while (p < end) {
      tick += vread();
      need(1);
      let status = data[p]!;
      if (status < 0x80) status = running;
      else p++;
      if (status === 0xff) {
        need(1);
        const type = data[p++]!;
        const l = vread();
        need(l);
        if (type === 0x51 && l === 3 && out.bpm === null) out.bpm = 60000000 / ((data[p]! << 16) | (data[p + 1]! << 8) | data[p + 2]!);
        if (type === 0x58 && l >= 2 && out.timeSig === null) out.timeSig = [data[p]!, 1 << data[p + 1]!];
        p += l;
        continue;
      }
      if (status === 0xf0 || status === 0xf7) {
        p += vread();
        continue;
      }
      running = status;
      const hi = status & 0xf0;
      const n = hi === 0xc0 || hi === 0xd0 ? 1 : 2;
      need(n);
      const a = data[p]!;
      const b = n === 2 ? data[p + 1]! : 0;
      p += n;
      if (hi === 0x90 && b > 0) out.notes.push({ tick, channel: (status & 0x0f) + 1, note: a, velocity: b });
      if (tick > out.lastTick) out.lastTick = tick;
    }
    p = end;
  }
  out.notes.sort((x, y) => x.tick - y.tick);
  return out;
}
