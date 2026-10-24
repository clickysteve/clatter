/**
 * What the pattern grid shows, as plain data (no drawing, no DOM): for every step of every track,
 * does something sound there, how loud, how likely, and where did it come from. The grid shows
 * what will PLAY in the cycle being displayed (the realisation: probability, density, CHOP,
 * ROLLS, DESTROY, fills and evolution applied), so the picture is the audible rhythm. What is
 * written but silent this pass is drawn as an outline, and nothing else needs a symbol; the
 * provenance (generated, hand-edited, added by a transformation) goes to the tooltip and the
 * step editor.
 *
 *   state 'hit'     a block (its height is the loudest event's velocity)
 *   state 'silent'  a hit is written here but does not sound this pass (outline)
 *   state 'empty'   nothing is written and nothing sounds
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import type { Hit, Pattern, Resolution, Track } from '../model/types';
import type { EventKind, PerfEvent } from '../rhythm/events';
import { stepsPerBar } from '../rhythm/generate';
import { cellOrigin, sourceGrid, type CellOrigin } from '../rhythm/pattern';
import { CELL_DESTROYED, CELL_EVOLVED, CELL_MOVED, CELL_SUPPRESSED, type Realization } from '../rhythm/realize';

/** The musical structure of the steps, from the pattern's own resolution (CLATTER's bars are in 4). */
export interface GridMetrics {
  steps: number;
  /** steps in a beat (a quarter note): the resolution */
  perBeat: number;
  /** steps in a bar */
  perBar: number;
  beatsPerBar: number;
}

export const BEATS_PER_BAR = 4;

export function gridMetrics(p: { steps: number; res: Resolution }): GridMetrics {
  const perBar = stepsPerBar(p.res);
  return { steps: p.steps, perBeat: p.res, perBar, beatsPerBar: BEATS_PER_BAR };
}

/** Which kind of boundary lies at the left edge of a step: 3 bar, 2 beat, 1 step, 0 the pattern's start. */
export function boundaryAt(step: number, m: GridMetrics): 0 | 1 | 2 | 3 {
  if (step <= 0) return 0;
  if (step % m.perBar === 0) return 3;
  if (step % m.perBeat === 0) return 2;
  return 1;
}

/** "BAR 2 · BEAT 3" for a step (1-based). */
export function position(step: number, m: GridMetrics): { bar: number; beat: number; sub: number } {
  return { bar: Math.floor(step / m.perBar) + 1, beat: Math.floor((step % m.perBar) / m.perBeat) + 1, sub: (step % m.perBeat) + 1 };
}

export type CellState = 'empty' | 'hit' | 'silent';
export type SilentWhy = 'chance' | 'density' | 'moved';

export interface CellView {
  state: CellState;
  /** the written hit (baseline with hand edits laid over it) */
  hit: Hit | null;
  origin: CellOrigin;
  /** the velocity drawn: the loudest sounding event, else the written hit's */
  vel: number;
  /** sounding events in the cell, grace notes excluded (rolls, stutters, ratchets: more than one) */
  strokes: number;
  /** the generated baseline hit under a hand edit or a hand deletion (the pattern before editing) */
  base: Hit | null;
  /** the written hit's chance, 1-100 */
  prob: number;
  /** a grace note sounds before the hit */
  flam: boolean;
  /** it sounds although nothing is written here (a fill, a roll, a slice moved in, evolution) */
  added: boolean;
  /** why a written hit is silent this pass */
  why: SilentWhy | null;
  kinds: EventKind[];
  /** DESTROY changed or made what sounds here */
  destroyed: boolean;
  /** EVOLVE changed this step */
  evolved: boolean;
  /** beyond a polymeter track's own length */
  outside: boolean;
}

const EMPTY: CellView = { state: 'empty', hit: null, origin: 'empty', vel: 0, strokes: 0, base: null, prob: 100, flam: false, added: false, why: null, kinds: [], destroyed: false, evolved: false, outside: false };

/**
 * The cells of one track. `real` is the realisation being displayed (null: nothing is known about
 * this pass, so every written hit counts as sounding).
 */
export function trackCells(p: Pattern, t: Track, real: Realization | null): CellView[] {
  const src = sourceGrid(p, t.id);
  const flags = real?.cells[t.id];
  const byStep = new Map<number, PerfEvent[]>();
  if (real) {
    for (const e of real.events) {
      if (e.track !== t.id || e.step < 0 || e.step >= p.steps) continue;
      const l = byStep.get(e.step);
      if (l) l.push(e);
      else byStep.set(e.step, [e]);
    }
  }
  const poly = t.play.length > 0 && t.play.length < p.steps;
  const out: CellView[] = [];
  for (let s = 0; s < p.steps; s++) {
    if (poly && s >= t.play.length) {
      out.push({ ...EMPTY, outside: true });
      continue;
    }
    const hit = src[s] ?? null;
    const f = flags?.[s] ?? 0;
    const origin = cellOrigin(p, t.id, s);
    const prob = hit?.prob ?? 100;
    const base = origin === 'gen' || origin === 'empty' ? null : (p.gen[t.id]?.[s] ?? null);
    const evolved = (f & CELL_EVOLVED) !== 0;
    const evs = byStep.get(s) ?? [];
    const main = evs.filter((e) => e.kind !== 'flam');
    const flam = evs.some((e) => e.kind === 'flam');
    let sounds: boolean;
    let strokes: number;
    let vel: number;
    if (!real) {
      sounds = !!hit;
      strokes = hit ? Math.max(1, hit.ratchet ?? 1) : 0;
      vel = hit?.vel ?? 0;
    } else if (poly) {
      // a polymeter track repeats its own loop across the cycle: columns show the loop, not the repeats
      sounds = !!hit && !(f & CELL_SUPPRESSED) && !(f & CELL_MOVED);
      strokes = sounds ? Math.max(1, hit?.ratchet ?? 1) : 0;
      vel = hit?.vel ?? 0;
    } else {
      sounds = main.length > 0;
      strokes = main.length;
      vel = sounds ? Math.max(...main.map((e) => e.vel)) : (hit?.vel ?? 0);
    }
    const kinds = [...new Set(main.map((e) => e.kind))];
    const destroyed = main.some((e) => e.destroyed) || (f & CELL_DESTROYED) !== 0;
    if (sounds) {
      out.push({ state: 'hit', hit, origin, vel, strokes, base, prob, flam: flam || (!!hit?.flam && poly), added: !hit, why: null, kinds, destroyed, evolved, outside: false });
    } else if (hit) {
      const why: SilentWhy = f & CELL_SUPPRESSED ? (prob < 100 || t.play.chance < 100 ? 'chance' : 'density') : 'moved';
      out.push({ state: 'silent', hit, origin, vel, strokes: 0, base, prob, flam: false, added: false, why, kinds: [], destroyed: false, evolved, outside: false });
    } else {
      out.push({ ...EMPTY, origin, evolved, base });
    }
  }
  return out;
}

const KIND_TEXT: Record<EventKind, string> = {
  source: 'the written hit',
  flam: 'a grace note (flam)',
  ratchet: 'a ratchet repeat',
  fill: 'a fill',
  chop: 'a slice moved here by CHOP',
  retrig: 'a CHOP retrigger',
  roll: 'a ROLLS stroke',
  stutter: 'a DESTROY stutter',
};

const ORIGIN_TEXT: Record<CellOrigin, string> = {
  empty: 'nothing written',
  gen: 'generated',
  edit: 'written by hand (a hand edit)',
  deleted: 'a generated hit you deleted',
};

/** The tooltip's words for a cell (the grid's footer and the step editor say the same). */
export function describeCell(name: string, step: number, v: CellView, m: GridMetrics): { head: string; lines: string[] } {
  const pos = position(step, m);
  const lines: string[] = [`Bar ${pos.bar}, beat ${pos.beat}${m.perBeat > 1 ? `, step ${pos.sub} of ${m.perBeat}` : ''}`];
  if (v.outside) {
    lines.push('Beyond this track’s own loop length (polymeter).');
    return { head: `${name} · STEP ${step + 1}`, lines };
  }
  if (v.state === 'hit') {
    lines.push(`**Sounds: velocity ${v.vel}${v.strokes > 1 ? `, ${v.strokes} strokes` : ''}`);
    if (v.hit) {
      lines.push(`Chance ${v.prob}%${v.hit.note ? ` · pitch ${v.hit.note > 0 ? '+' : ''}${v.hit.note}` : ''}${v.hit.ratchet && v.hit.ratchet > 1 ? ` · ratchet ×${v.hit.ratchet}` : ''}${v.hit.flam ? ' · flam' : ''}`);
    }
  } else if (v.state === 'silent') {
    const why = v.why === 'chance' ? `its chance is ${v.prob < 100 ? v.prob + '%' : 'scaled by the track'} and it stayed silent this pass` : v.why === 'density' ? 'the track’s DENSITY dropped it this pass' : 'CHOP moved it away or DESTROY skipped it this pass';
    lines.push(`**Written but silent this pass: ${why}.`);
    lines.push(`Velocity ${v.vel} · chance ${v.prob}%`);
  } else {
    lines.push('**Empty. Click to add a hit.');
  }
  lines.push(`Source: ${v.added ? 'not written here; ' + (v.kinds.map((k) => KIND_TEXT[k]).join(', ') || 'a transformation') : ORIGIN_TEXT[v.origin]}`);
  const fx: string[] = [];
  if (v.added && v.state === 'hit') fx.push('made by a transformation or fill');
  if (v.kinds.some((k) => k === 'chop' || k === 'retrig')) fx.push('CHOP');
  if (v.kinds.includes('roll')) fx.push('ROLLS');
  if (v.destroyed) fx.push('DESTROY');
  if (v.evolved) fx.push('EVOLVE');
  if (fx.length) lines.push(`Transformation: ${[...new Set(fx)].join(', ')}`);
  return { head: `${name} · STEP ${step + 1}`, lines };
}

const KIND_SHORT: Partial<Record<EventKind, string>> = { fill: 'FILL', chop: 'CHOP', retrig: 'CHOP', roll: 'ROLLS', stutter: 'DESTROY' };

/** Where a cell's content came from, in a few words (for the grid's footer). */
export function sourceLabel(v: CellView): string {
  if (v.state === 'hit' && v.added) return 'ADDED BY ' + ([...new Set(v.kinds.map((k) => KIND_SHORT[k]).filter(Boolean))].join(' + ') || 'A TRANSFORMATION');
  if (v.origin === 'edit') return 'HAND EDIT';
  if (v.origin === 'deleted') return 'GENERATED HIT DELETED BY HAND';
  if (v.origin === 'gen') return 'GENERATED';
  return 'NOTHING WRITTEN';
}

/** One line about a cell for the grid's footer (hover, or the cursor). */
export function summaryLine(name: string, step: number, v: CellView, m: GridMetrics): string {
  const pos = position(step, m);
  const where = `${name} · STEP ${step + 1} (BAR ${pos.bar} BEAT ${pos.beat})`;
  if (v.outside) return `${where} · OUTSIDE THIS TRACK'S LOOP`;
  if (v.state === 'hit') return `${where} · SOUNDS · VELOCITY ${v.vel}${v.hit ? ` · CHANCE ${v.prob}%` : ''}${v.strokes > 1 ? ` · ${v.strokes} STROKES` : ''} · ${sourceLabel(v)}`;
  if (v.state === 'silent') return `${where} · WRITTEN, SILENT THIS PASS (${v.why === 'chance' ? 'CHANCE' : v.why === 'density' ? 'DENSITY' : 'MOVED OR SKIPPED'}) · VELOCITY ${v.vel} · ${sourceLabel(v)}`;
  return `${where} · EMPTY${v.origin === 'deleted' ? ' (A GENERATED HIT WAS DELETED)' : ''}`;
}
