/**
 * Pointer gestures on the pattern grid, as a small state machine with no DOM in it: the grid
 * feeds it pointer positions already turned into steps, and it calls the application's editing
 * functions. Every gesture is ONE undo step.
 *
 *   press an empty step       the hit is made and selected at once (at the new-hit velocity)
 *     then drag up / down     sets its velocity (up is louder)
 *     then drag sideways      paints hits along the same track
 *   press a hit               selects it; releasing without moving removes it (a click toggles)
 *     drag up / down          sets its velocity (the hit stays)
 *     drag sideways           paints hits on the empty steps (the hits that are there stay)
 *   Shift-press               release in place: add the step to the selection, or take it out
 *     drag sideways           erases hits along the same track
 *   Alt-press, drag           select a region
 *
 * The first movement past a small threshold decides between sideways and vertical for the rest
 * of the gesture, so painting never changes a velocity and a velocity drag never paints. The
 * track of a gesture is the track it started on: it never touches a neighbour.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import type { Hit } from '../model/types';
import { dragVelocity } from '../rhythm/velocity';

/** Pixels of movement before a press becomes a drag. */
export const DRAG_THRESHOLD = 4;
/** A fingertip wobbles more than a mouse: a touch press only becomes a drag past this. */
export const TOUCH_DRAG_THRESHOLD = 10;

export interface Region {
  t0: number;
  t1: number;
  s0: number;
  s1: number;
}

/** What the gesture needs from the application. */
export interface GestureHost {
  steps(): number;
  hitAt(track: string, step: number): Hit | null;
  /** the velocity a new hit gets */
  newVelocity(): number;
  /** an undo step opens; relabel names it once the gesture is known; end closes it */
  begin(label: string): void;
  relabel(label: string): void;
  end(): void;
  /** make (on) or remove (off) the hit; does nothing when it is already so */
  paint(track: string, step: number, on: boolean): void;
  setVelocity(track: string, step: number, vel: number): void;
  /** the cursor (the step being edited), or null */
  cursor(): { trackIndex: number; step: number } | null;
  setCursor(trackIndex: number, step: number): void;
  select(r: Region | null): void;
  /** Shift-click: add the step to the selection, or take it out */
  pick(track: string, step: number): void;
  /** a hit was just made by pressing (to hear it) */
  created?(track: string, step: number): void;
}

export interface Press {
  track: string;
  trackIndex: number;
  step: number;
  x: number;
  y: number;
  shift: boolean;
  alt: boolean;
  touch?: boolean;
}

export interface Move {
  x: number;
  y: number;
  step: number;
  /** the track index under the pointer (a region follows it; hits do not) */
  trackIndex: number;
}

type Phase = 'new' | 'hit' | 'shift' | 'paint' | 'erase' | 'vel' | 'region';

export class StepGesture {
  private phase: Phase | null = null;
  private start!: Press;
  private open = false;
  private last = 0;
  private v0 = 0;
  /** shown while a velocity drag is going on */
  private vel: { track: string; step: number; vel: number } | null = null;

  constructor(private host: GestureHost) {}

  get active(): boolean {
    return this.phase !== null;
  }

  get mode(): Phase | null {
    return this.phase;
  }

  /** The velocity being dragged (to draw it), else null. */
  get dragging(): { track: string; step: number; vel: number } | null {
    return this.phase === 'vel' ? this.vel : null;
  }

  down(p: Press): void {
    this.cancel();
    this.start = p;
    this.last = p.step;
    const h = this.host;
    if (p.alt) {
      this.phase = 'region';
      h.select({ t0: p.trackIndex, t1: p.trackIndex, s0: p.step, s1: p.step });
      return;
    }
    if (p.shift) {
      this.phase = 'shift';
      return;
    }
    h.setCursor(p.trackIndex, p.step);
    if (h.hitAt(p.track, p.step)) {
      this.phase = 'hit';
      this.v0 = h.hitAt(p.track, p.step)!.vel;
      return;
    }
    this.phase = 'new';
    this.v0 = h.newVelocity();
    this.begin('ADD HIT');
    h.paint(p.track, p.step, true);
    h.created?.(p.track, p.step);
  }

  move(m: Move): void {
    const ph = this.phase;
    if (!ph) return;
    const s = this.start;
    const h = this.host;
    if (ph === 'region') {
      h.select({ t0: s.trackIndex, t1: m.trackIndex, s0: s.step, s1: m.step });
      return;
    }
    if (ph === 'new' || ph === 'hit' || ph === 'shift') {
      const dx = m.x - s.x;
      const dy = m.y - s.y;
      if (Math.max(Math.abs(dx), Math.abs(dy)) < (s.touch ? TOUCH_DRAG_THRESHOLD : DRAG_THRESHOLD)) return;
      const vertical = Math.abs(dy) > Math.abs(dx);
      if (ph === 'shift') {
        if (vertical) return; // Shift only erases, along the track
        this.begin('ERASE');
        this.phase = 'erase';
        this.sweep(s.step, m.step, false);
      } else if (vertical) {
        if (ph === 'hit') this.begin('VELOCITY');
        else h.relabel('VELOCITY');
        this.phase = 'vel';
      } else {
        if (ph === 'hit') this.begin('PAINT');
        else h.relabel('PAINT');
        this.phase = 'paint';
        this.sweep(s.step, m.step, true);
      }
      this.last = m.step;
      if (this.phase !== 'vel') return;
    }
    if (this.phase === 'vel') {
      const v = dragVelocity(this.v0, m.y - s.y);
      this.vel = { track: s.track, step: s.step, vel: v };
      if (h.hitAt(s.track, s.step)?.vel !== v) h.setVelocity(s.track, s.step, v);
      return;
    }
    // paint / erase: every step between the last one and this one (a fast pointer skips cells)
    this.sweep(this.last, m.step, this.phase === 'paint');
    this.last = m.step;
  }

  up(_m?: Move): void {
    const ph = this.phase;
    if (!ph) return;
    const s = this.start;
    const h = this.host;
    if (ph === 'shift') h.pick(s.track, s.step);
    // a click on a hit that never became a drag removes it: one click, one undo step
    if (ph === 'hit') {
      this.begin('DELETE HIT');
      h.paint(s.track, s.step, false);
    }
    this.finish();
  }

  /** The pointer was lost or the gesture abandoned: what has been done stays, as one undo step. */
  cancel(): void {
    if (this.phase) this.finish();
  }

  private finish(): void {
    if (this.open) this.host.end();
    this.open = false;
    this.phase = null;
    this.vel = null;
  }

  private begin(label: string): void {
    if (this.open) return;
    this.open = true;
    this.host.begin(label);
  }

  private sweep(a: number, b: number, on: boolean): void {
    const n = this.host.steps();
    const lo = Math.max(0, Math.min(a, b));
    const hi = Math.min(n - 1, Math.max(a, b));
    for (let i = lo; i <= hi; i++) this.host.paint(this.start.track, i, on);
  }
}
