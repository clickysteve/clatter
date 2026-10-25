/**
 * Tempo automation: a loop of tempo changes that runs under the whole performance.
 *
 * The curve is a list of points (bar, multiplier) over `bars` bars, repeating. The tempo at any
 * moment is the project's BPM times the curve, so the BPM control still scales the whole
 * thing. A point either holds its multiplier until the next point (a step) or glides to the
 * next one (a ramp); the last point glides back to the first at the end of the loop. The
 * tempo is held constant within each TEMPO_GRID (a 32nd note), which is how the scheduler
 * plays it and how an export renders it, so playback and export keep identical time.
 *
 * Musical time (ticks) is untouched: only the seconds between ticks change.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import { clamp, PPQ } from '../model/types';

export interface TempoPoint {
  /** position in the loop, in bars from its start (0 for the first point) */
  bar: number;
  /** tempo multiplier */
  mul: number;
  /** glide to the next point instead of holding */
  ramp?: boolean;
}

export interface TempoAuto {
  on: boolean;
  /** loop length in bars */
  bars: number;
  points: TempoPoint[];
}

/** The tempo is constant within a cell of this many ticks. */
export const TEMPO_GRID = PPQ / 8;
export const BPM_MIN = 30;
export const BPM_MAX = 300;
export const MUL_MIN = 0.5;
export const MUL_MAX = 2;
export const MAX_TEMPO_POINTS = 32;
export const MAX_TEMPO_BARS = 64;
const BAR_TICKS = PPQ * 4;

export const tempoActive = (a: TempoAuto | undefined): a is TempoAuto => !!a && a.on && a.points.length > 0;

/** The multiplier at a position in bars within the loop. */
export function mulAtBar(a: TempoAuto, pos: number): number {
  const pts = a.points;
  const n = pts.length;
  if (n === 1) return pts[0]!.mul;
  let i = n - 1;
  for (let k = 0; k < n; k++) {
    if (pts[k]!.bar > pos) {
      i = k - 1;
      break;
    }
  }
  if (i < 0) i = n - 1;
  const p = pts[i]!;
  if (!p.ramp) return p.mul;
  const next = pts[(i + 1) % n]!;
  const from = p.bar;
  const to = i === n - 1 ? next.bar + a.bars : next.bar;
  const at = i === n - 1 && pos < from ? pos + a.bars : pos;
  const f = to > from ? clamp((at - from) / (to - from), 0, 1) : 0;
  return p.mul + (next.mul - p.mul) * f;
}

/** The tempo in BPM at a tick since the start of the performance (the cell's start decides). */
export function bpmAt(base: number, a: TempoAuto | undefined, tick: number): number {
  if (!tempoActive(a)) return base;
  const cell = Math.floor(tick / TEMPO_GRID + 1e-9) * TEMPO_GRID;
  const pos = (cell / BAR_TICKS) % a.bars;
  return clamp(base * mulAtBar(a, pos), BPM_MIN, BPM_MAX);
}

/** Seconds from the start to a tick, exactly as the scheduler counts them. */
export function secondsAt(base: number, a: TempoAuto | undefined, ticks: number): number {
  if (!tempoActive(a)) return (ticks * 60) / (base * PPQ);
  let s = 0;
  let t = 0;
  while (t < ticks - 1e-9) {
    const end = Math.min(ticks, (Math.floor(t / TEMPO_GRID + 1e-9) + 1) * TEMPO_GRID);
    s += ((end - t) * 60) / (bpmAt(base, a, t) * PPQ);
    t = end;
  }
  return s;
}

/** The tempo changes in a stretch of ticks as MIDI wants them: [tick, bpm] whenever it changes. */
export function tempoChanges(base: number, a: TempoAuto | undefined, endTick: number): { tick: number; bpm: number }[] {
  const out: { tick: number; bpm: number }[] = [{ tick: 0, bpm: bpmAt(base, a, 0) }];
  if (!tempoActive(a)) return out;
  for (let t = TEMPO_GRID; t < endTick; t += TEMPO_GRID) {
    const b = bpmAt(base, a, t);
    if (Math.abs(b - out[out.length - 1]!.bpm) >= 0.05) out.push({ tick: t, bpm: b });
  }
  return out;
}

export const defaultTempoAuto = (): TempoAuto => ({ on: true, bars: 4, points: [{ bar: 0, mul: 1 }] });

/** A valid curve from anything (project files): sorted, first point at bar 0, multipliers in range. */
export function repairTempoAuto(v: unknown): TempoAuto | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const num = (x: unknown, d: number, lo: number, hi: number) => (typeof x === 'number' && Number.isFinite(x) ? clamp(x, lo, hi) : d);
  const bars = Math.round(num(o.bars, 4, 1, MAX_TEMPO_BARS));
  const raw = Array.isArray(o.points) ? o.points.slice(0, MAX_TEMPO_POINTS) : [];
  const pts: TempoPoint[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const q = r as Record<string, unknown>;
    const bar = Math.round(num(q.bar, 0, 0, bars - 0.25) * 4) / 4;
    pts.push({ bar, mul: Math.round(num(q.mul, 1, MUL_MIN, MUL_MAX) * 1000) / 1000, ...(q.ramp === true ? { ramp: true } : {}) });
  }
  if (!pts.length) return undefined;
  pts.sort((a, b) => a.bar - b.bar);
  const uniq = pts.filter((p, i) => i === 0 || p.bar !== pts[i - 1]!.bar);
  uniq[0] = { ...uniq[0]!, bar: 0 };
  return { on: o.on !== false, bars, points: uniq };
}
