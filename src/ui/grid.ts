/**
 * The pattern grid: track rows (name, source, MUTE / SOLO / LOCK) beside a canvas of steps that
 * scrolls sideways. The names stay put while the steps scroll.
 *
 * What the picture means (the full account is in docs/UI_REDESIGN.md and the grid key dialog):
 *
 *   solid block      a hit that SOUNDS in the cycle shown; its height is its velocity
 *   split block      several strokes in one step (a ratchet, a roll, a stutter)
 *   outline block    written, but silent this pass (chance, density, moved or skipped)
 *   thin bar on top  the hit's chance, when below 100 %
 *   empty cell       nothing sounds there
 *
 * Structure: a hairline between steps, a heavier line between beats, the heaviest between bars,
 * every other beat lightly dotted, bar and beat numbers in the header (all derived from the
 * pattern's resolution). The playhead is a tinted column, the cursor a ring, the pointer a hover
 * outline. SHOW ORIGINAL adds the edit history (hand-edited hits, deleted generated hits).
 *
 * Pointer: click adds or removes a hit and selects it, drag paints (one undo step), Shift-drag
 * selects a region, Alt-drag (or Alt-wheel) sets velocity, right-click opens the step editor. A
 * click anywhere inside a cell edits that cell: hit-testing floors the position, never rounds.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import type { App } from '../app/app';
import { boundaryAt, describeCell, gridMetrics, trackCells, type CellView, type GridMetrics } from './gridModel';
import { font, hit, logicalWidth, onScale, sz } from './scale';
import { hideTip, showTip } from './tooltip';
import { button, h, Panel } from './widgets';

export interface GridOptions {
  /** read-only (PERFORM) */
  readonly?: boolean;
  /** names only, smaller cells */
  compact?: boolean;
  /**
   * The rows share the height that is left: `room()` is the most the grid frame may take (it
   * scrolls inside when even the smallest rows do not fit), `watch` changes size with it.
   */
  fit?: { watch: HTMLElement; room: () => number };
}

export interface GridColors {
  ink: string;
  paper: string;
  activity: string;
  selection: string;
}

export interface Cell {
  track: number;
  step: number;
}

/** Cell width limits and row height range, in unscaled pixels (see scale.ts). */
const CELL = { min: 30, max: 64, minCompact: 16, maxCompact: 40 };
const ROW = { min: 26, max: 52, compact: 28 };
const HEAD = { full: 32, compact: 26 };
const LABELS = { compact: 128, wide: 284, narrow: 244 };

/** A 4 × 4 dither (12 % dots), used for the shaded beats. */
function ditherPattern(g: CanvasRenderingContext2D, ink: string): CanvasPattern | null {
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 4;
  const k = c.getContext('2d')!;
  k.fillStyle = ink;
  k.fillRect(0, 0, 1, 1);
  k.fillRect(2, 2, 1, 1);
  return g.createPattern(c, 'repeat');
}

/** A diagonal hatch, for steps beyond a polymeter track's own length. */
function hatchPattern(g: CanvasRenderingContext2D, ink: string): CanvasPattern | null {
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 4;
  const k = c.getContext('2d')!;
  k.fillStyle = ink;
  for (let i = 0; i < 4; i++) k.fillRect(3 - i, i, 1, 1);
  return g.createPattern(c, 'repeat');
}

/**
 * One cell: the hit as it sounds. (x, y) is the cell's top-left corner, w × h its size.
 * Shared by the grid and the grid key.
 */
export function drawCell(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, v: CellView, c: GridColors, showOriginal = false): void {
  const pad = 3;
  const bx = x + pad;
  const bw = w - pad * 2;
  const innerH = h - 11;
  const bottom = y + h - 4;
  const blockH = (vel: number) => Math.max(6, Math.round((innerH * vel) / 127));
  const dashed = (rx: number, ry: number, rw: number, rh: number, fill: boolean) => {
    if (fill) {
      g.fillStyle = c.paper;
      g.fillRect(rx, ry, rw, rh);
    }
    g.strokeStyle = c.ink;
    g.lineWidth = 1;
    g.setLineDash([3, 2]);
    g.strokeRect(rx + 0.5, ry + 0.5, rw - 1, rh - 1);
    g.setLineDash([]);
  };
  if (v.state === 'hit') {
    const bh = blockH(v.vel);
    const by = bottom - bh;
    g.fillStyle = c.ink;
    let left = bx;
    if (v.flam) {
      // the grace note: a short block just before
      const gh = Math.max(4, Math.round(bh * 0.5));
      g.fillRect(bx, bottom - gh, 4, gh);
      left = bx + 7;
    }
    const width = bx + bw - left;
    if (v.strokes > 1) {
      const n = Math.min(v.strokes, Math.max(2, Math.floor(width / 6)));
      const gap = 2;
      const sw = Math.max(2, Math.floor((width - gap * (n - 1)) / n));
      for (let k = 0; k < n; k++) g.fillRect(left + k * (sw + gap), by, sw, bh);
    } else g.fillRect(left, by, width, bh);
  } else if (v.state === 'silent') {
    const bh = blockH(v.vel);
    dashed(bx, bottom - bh, bw, bh, true);
  }
  // the chance, when it is not certain: a short bar along the top, full length = always
  if (v.hit && v.prob < 100) {
    const x0 = x + 11;
    const full = w - 11 - pad;
    g.fillStyle = c.ink;
    g.globalAlpha = 0.45;
    g.fillRect(x0, y + 4, full, 1);
    g.globalAlpha = 1;
    g.fillRect(x0, y + 3, Math.max(2, Math.round((full * v.prob) / 100)), 3);
  }
  if (showOriginal) {
    if (v.origin === 'edit' && v.hit) {
      // a hand edit: a corner flag
      g.fillStyle = c.paper;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + 11, y);
      g.lineTo(x, y + 11);
      g.fill();
      g.fillStyle = c.ink;
      g.beginPath();
      g.moveTo(x + 1, y + 1);
      g.lineTo(x + 9, y + 1);
      g.lineTo(x + 1, y + 9);
      g.fill();
    } else if (v.origin === 'deleted' && v.base) {
      // a generated hit you deleted: the outline it had, crossed out
      const bh = blockH(v.base.vel);
      const by = bottom - bh;
      dashed(bx, by, bw, bh, true);
      g.strokeStyle = c.ink;
      g.beginPath();
      g.moveTo(bx + 3, by + 3);
      g.lineTo(bx + bw - 3, by + bh - 3);
      g.moveTo(bx + bw - 3, by + 3);
      g.lineTo(bx + 3, by + bh - 3);
      g.stroke();
    }
  }
}

export class PatternGrid {
  readonly el: HTMLDivElement;
  private labels: HTMLDivElement;
  private rows: HTMLDivElement;
  private scroll: HTMLDivElement;
  private inner: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private over: HTMLCanvasElement;
  private panel = new Panel();
  private rowH = sz(ROW.max);
  private headH = sz(HEAD.full);
  private cellW = 32;
  private steps = 32;
  private metrics: GridMetrics = { steps: 32, perBeat: 4, perBar: 16, beatsPerBar: 4 };
  private views: CellView[][] = [];
  private hover: Cell | null = null;
  private gesture: null | { kind: 'paint'; on: boolean; last: string } | { kind: 'select'; t0: number; s0: number } | { kind: 'vel'; track: string; step: number; y0: number; v0: number } = null;
  private lastKey = '';
  private lastUser = 0;
  private tipTimer = 0;
  private pendingDraw = 0;
  /** the pointer is over this cell (null: left the grid) */
  onHover: ((c: Cell | null) => void) | null = null;
  /** right-click on a cell */
  onContext: ((c: Cell, e: MouseEvent) => void) | null = null;

  constructor(
    private app: App,
    parent: HTMLElement,
    private o: GridOptions = {},
  ) {
    this.el = h('div', 'gridwrap', parent);
    this.labels = h('div', 'gridlabels', this.el);
    h('div', 'ghead', this.labels, o.compact ? '' : 'TRACKS');
    this.rows = h('div', '', this.labels);
    this.scroll = h('div', 'gridscroll' + (o.readonly ? ' readonly' : ''), this.el);
    this.inner = h('div', 'gridinner', this.scroll);
    this.canvas = h('canvas', '', this.inner);
    this.over = h('canvas', '', this.inner);
    this.over.style.pointerEvents = 'none';
    this.canvas.setAttribute('role', 'grid');
    this.canvas.setAttribute('aria-label', 'Pattern grid');
    if (!o.readonly) {
      this.canvas.tabIndex = 0;
      this.bind();
    }
    this.headH = sz(o.compact ? HEAD.compact : HEAD.full);
    this.el.style.setProperty('--head-h', this.headH + 'px');
    // the user scrolling (or about to) pauses the playhead following
    for (const ev of ['wheel', 'pointerdown'] as const) this.scroll.addEventListener(ev, () => (this.lastUser = performance.now()), { passive: true });
    const ro = new ResizeObserver(() => this.schedule());
    ro.observe(this.scroll);
    if (o.fit) ro.observe(o.fit.watch);
    const relayout = () => {
      this.headH = sz(o.compact ? HEAD.compact : HEAD.full);
      this.el.style.setProperty('--head-h', this.headH + 'px');
      this.applyRowHeight();
      this.schedule();
    };
    window.addEventListener('resize', relayout);
    onScale(relayout);
    this.build();
  }

  private get labelW(): number {
    if (this.o.compact) return sz(LABELS.compact);
    return sz(logicalWidth() < 1300 ? LABELS.narrow : LABELS.wide);
  }

  private applyRowHeight(): void {
    this.rowH = this.rowHeight();
    this.el.style.setProperty('--row-h', this.rowH + 'px');
    this.labels.style.width = this.labelW + 'px';
    this.rows.querySelectorAll<HTMLElement>('[data-hide-narrow]').forEach((b) => (b.style.display = logicalWidth() < 1300 ? 'none' : ''));
  }

  /**
   * Row height: with `fit`, the tracks share the height they are given (down to the smallest row
   * that still holds its buttons: below that the grid scrolls inside its frame); otherwise fixed.
   */
  private rowHeight(): number {
    if (this.o.compact) return sz(ROW.compact);
    const lo = hit(ROW.min);
    const hi = sz(ROW.max);
    const fit = this.o.fit;
    const n = this.app.project.tracks.length;
    if (!fit || !n) return hi;
    const room = fit.room();
    if (room <= 0) return hi; // not laid out yet
    return Math.max(lo, Math.min(hi, Math.floor((room - (this.el.offsetHeight - this.el.clientHeight) - this.headH) / n)));
  }

  /** The left edge of a step in pixels (cells share the width exactly; edges snap to whole pixels). */
  private X(step: number): number {
    return Math.round(step * this.cellW);
  }

  private schedule(): void {
    if (this.pendingDraw) return;
    this.pendingDraw = requestAnimationFrame(() => {
      this.pendingDraw = 0;
      this.draw();
    });
  }

  /** Rebuild the track rows (tracks changed). */
  build(): void {
    const app = this.app;
    this.panel.clear();
    this.rows.innerHTML = '';
    const tracks = app.project.tracks;
    this.applyRowHeight();
    tracks.forEach((t, i) => {
      const r = h('div', 'trackrow', this.rows);
      r.dataset.track = t.id;
      const name = h('div', 'tname', r, t.name);
      name.title = `${t.name}: click to select, double-click to hear`;
      name.addEventListener('click', () => app.selectTrack(t.id));
      name.addEventListener('dblclick', () => void app.audition(t.id));
      if (this.o.compact) {
        this.panel.add(() => {
          const tt = app.project.tracks.find((x) => x.id === t.id);
          if (!tt) return;
          name.textContent = tt.name;
          r.classList.toggle('sel', app.ui.track === t.id);
          r.classList.toggle('dimmed', tt.mix.mute || (app.project.tracks.some((x) => x.mix.solo) && !tt.mix.solo));
        });
        return;
      }
      const mode = h('div', 'mode', r);
      this.panel.add(() => {
        const tt = app.project.tracks.find((x) => x.id === t.id)!;
        mode.textContent = tt.sound.mode === 'synth' ? 'SYN' : tt.sound.mode === 'sample' ? 'SMP' : 'HYB';
        mode.title = tt.sound.mode.toUpperCase() + ' track';
        name.textContent = tt.name;
        r.classList.toggle('sel', app.ui.track === t.id);
        r.classList.toggle('dimmed', tt.mix.mute || (app.project.tracks.some((x) => x.mix.solo) && !tt.mix.solo));
      });
      button(this.panel, r, 'M', () => app.setTrackMix(t.id, { mute: !app.project.tracks[i]!.mix.mute }), { cls: 'small', on: () => !!app.project.tracks[i]?.mix.mute, title: 'Mute' });
      button(this.panel, r, 'S', () => app.setTrackMix(t.id, { solo: !app.project.tracks[i]!.mix.solo }), { cls: 'small', on: () => !!app.project.tracks[i]?.mix.solo, title: 'Solo' });
      button(this.panel, r, 'L', () => app.lockTrack(t.id), { cls: 'small', on: () => !!app.project.tracks[i]?.lock, title: 'Lock: generation and mutation leave this track alone' });
      const hear = button(this.panel, r, '▶', () => void app.audition(t.id), { cls: 'small', title: 'Hear this track' });
      hear.dataset.hideNarrow = '1';
    });
    this.applyRowHeight();
    this.draw();
  }

  refreshRows(): void {
    this.panel.refresh();
  }

  private colors(): GridColors {
    const cs = getComputedStyle(this.el);
    const ink = cs.getPropertyValue('--ink').trim() || '#000';
    return {
      ink,
      paper: cs.getPropertyValue('--paper').trim() || '#fff',
      activity: cs.getPropertyValue('--activity').trim() || ink,
      selection: cs.getPropertyValue('--selection').trim() || ink,
    };
  }

  /** The cell views of the cycle on show (what sounds), one list per track. */
  cellViews(): CellView[][] {
    return this.views;
  }

  /** Redraw every cell. */
  draw(): void {
    const app = this.app;
    const p = app.pattern;
    const tracks = app.project.tracks;
    const avail = this.scroll.clientWidth;
    if (avail < 60) return; // hidden: the resize observer calls again when it shows
    this.applyRowHeight();
    this.steps = p.steps;
    const m = gridMetrics(p);
    this.metrics = m;
    const compact = !!this.o.compact;
    const lo = hit(compact ? CELL.minCompact : CELL.min);
    const hi = sz(compact ? CELL.maxCompact : CELL.max);
    // cells share the width exactly (their edges snap to whole pixels); never narrower than the minimum: scroll instead
    this.cellW = Math.max(lo, Math.min(hi, (avail - 1) / p.steps));
    const cw = this.X(p.steps);
    const ch = this.headH + this.rowH * tracks.length;
    const dpr = window.devicePixelRatio || 1;
    this.inner.style.width = cw + 'px';
    this.inner.style.height = ch + 'px';
    for (const c of [this.canvas, this.over]) {
      c.width = Math.round(cw * dpr);
      c.height = Math.round(ch * dpr);
      c.style.width = cw + 'px';
      c.style.height = ch + 'px';
    }
    this.canvas.dataset.head = String(this.headH);
    this.canvas.dataset.rowh = String(this.rowH);
    this.canvas.dataset.cellw = String(this.cellW);
    const g = this.canvas.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const c = this.colors();
    const real = app.displayRealization();
    this.views = tracks.map((t) => trackCells(p, t, real));
    const dither = ditherPattern(g, c.ink);
    const hatch = hatchPattern(g, c.ink);
    const R = this.rowH;
    const H = this.headH;
    const rowsH = R * tracks.length;
    g.fillStyle = c.paper;
    g.fillRect(0, 0, cw, ch);

    // every other beat is dotted, so beats read as stripes (and bars as pairs of them)
    if (dither) {
      g.fillStyle = dither;
      for (let b = 1; b * m.perBeat < p.steps; b += 2) {
        const x0 = this.X(b * m.perBeat);
        const w = this.X(Math.min(p.steps, (b + 1) * m.perBeat)) - x0;
        g.fillRect(x0, H, w, rowsH);
      }
    }

    // header: bar chips, beat numbers, step ticks
    g.fillStyle = c.ink;
    g.textBaseline = 'middle';
    for (let s = 0; s < p.steps; s++) {
      const x = this.X(s);
      const b = boundaryAt(s, m);
      if (s === 0 || b === 3) {
        const label = `BAR ${Math.floor(s / m.perBar) + 1}`;
        g.font = `${font(16)}px Tiny5, monospace`;
        const tw = Math.ceil(g.measureText(label).width) + 12;
        g.fillStyle = c.ink;
        g.fillRect(x + 2, 3, Math.min(tw, this.X(p.steps) - x - 4), H - 8);
        g.fillStyle = c.paper;
        g.fillText(label, x + 8, H / 2 - 1);
      } else if (b === 2) {
        g.font = `${font(18)}px VT323, monospace`;
        g.fillStyle = c.ink;
        g.fillText(String(Math.floor((s % m.perBar) / m.perBeat) + 1), x + 5, H / 2);
      } else {
        g.fillStyle = c.ink;
        g.globalAlpha = 0.45;
        g.fillRect(x, H - 8, 1, 5);
        g.globalAlpha = 1;
      }
    }
    // the header's own rule
    g.fillStyle = c.ink;
    g.fillRect(0, H - 2, cw, 2);

    // row rules and cells
    const dimmedRows = tracks.map((t) => t.mix.mute || (tracks.some((x) => x.mix.solo) && !t.mix.solo));
    g.globalAlpha = 0.3;
    g.fillStyle = c.ink;
    for (let ti = 0; ti < tracks.length - 1; ti++) g.fillRect(0, H + (ti + 1) * R - 1, cw, 1);
    g.globalAlpha = 1;
    const showOriginal = app.ui.showOriginal;
    tracks.forEach((t, ti) => {
      const y = H + ti * R;
      const row = this.views[ti]!;
      for (let s = 0; s < p.steps; s++) {
        const v = row[s]!;
        const x = this.X(s);
        const cwid = this.X(s + 1) - x;
        if (v.outside) {
          if (hatch) {
            g.fillStyle = hatch;
            g.globalAlpha = 0.5;
            g.fillRect(x, y, cwid, R - 1);
            g.globalAlpha = 1;
          }
          continue;
        }
        drawCell(g, x, y, cwid, R - 1, v, c, showOriginal);
      }
      if (dimmedRows[ti]) {
        g.globalAlpha = 0.62;
        g.fillStyle = c.paper;
        g.fillRect(0, y, cw, R - 1);
        g.globalAlpha = 1;
      }
    });

    // step lines, then beat lines, then bar lines (the later and heavier on top)
    for (let s = 1; s < p.steps; s++) {
      const b = boundaryAt(s, m);
      const x = this.X(s);
      g.fillStyle = c.ink;
      if (b === 1) {
        g.globalAlpha = 0.28;
        g.fillRect(x, H, 1, rowsH);
      } else if (b === 2) {
        g.globalAlpha = 0.65;
        g.fillRect(x - 1, H, 2, rowsH);
      } else {
        g.globalAlpha = 1;
        g.fillRect(x - 2, 0, 4, ch);
      }
    }
    g.globalAlpha = 1;
    g.fillStyle = c.ink;
    g.fillRect(cw - 2, 0, 2, ch);
    this.lastKey = '';
    this.drawOverlay(this.lastHead);
  }

  private lastHead = -1;

  /** Redraw the overlay now (the selection or the pointer changed), keeping the playhead where it is. */
  redrawOverlay(): void {
    this.lastKey = '';
    this.drawOverlay(this.lastHead);
  }

  /** The playhead, the selected track, the hover and the cursor (cheap: every animation frame). */
  drawOverlay(step: number): void {
    const app = this.app;
    const sel = app.ui.sel;
    const cur = this.o.readonly ? null : app.cursorCell();
    const key = `${Math.floor(step)}|${this.hover ? this.hover.track + ':' + this.hover.step : ''}|${sel ? `${sel.t0},${sel.t1},${sel.s0},${sel.s1}` : ''}|${cur ? cur.track + ':' + cur.step : ''}|${app.ui.track}|${this.cellW}|${app.ui.paintVel}`;
    this.lastHead = step;
    if (key === this.lastKey) return;
    this.lastKey = key;
    const dpr = window.devicePixelRatio || 1;
    const g = this.over.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, this.over.width, this.over.height);
    const c = this.colors();
    const R = this.rowH;
    const H = this.headH;
    const tracks = app.project.tracks;
    const rowsH = R * tracks.length;
    const cw = this.X(this.steps);

    // the selected track
    const ti = app.trackIndexOf(app.ui.track);
    if (ti >= 0) {
      g.fillStyle = c.ink;
      g.globalAlpha = 0.07;
      g.fillRect(0, H + ti * R, cw, R - 1);
      g.globalAlpha = 1;
      g.fillStyle = c.ink;
      g.fillRect(0, H + ti * R, 4, R - 1);
    }

    // a region (Shift-drag)
    if (sel && !this.o.readonly && !(sel.t0 === sel.t1 && sel.s0 === sel.s1)) {
      const t0 = Math.min(sel.t0, sel.t1);
      const t1 = Math.max(sel.t0, sel.t1);
      const s0 = Math.min(sel.s0, sel.s1);
      const s1 = Math.max(sel.s0, sel.s1);
      g.fillStyle = c.selection;
      g.globalAlpha = 0.1;
      g.fillRect(this.X(s0), H + t0 * R, this.X(s1 + 1) - this.X(s0), (t1 - t0 + 1) * R);
      g.globalAlpha = 1;
      g.strokeStyle = c.selection;
      g.lineWidth = 3;
      g.setLineDash([6, 4]);
      g.strokeRect(this.X(s0) + 1.5, H + t0 * R + 1.5, this.X(s1 + 1) - this.X(s0) - 3, (t1 - t0 + 1) * R - 3);
      g.setLineDash([]);
    }

    // the pointer
    const hv = this.hover;
    if (hv && !this.o.readonly && !this.gesture) {
      const x = this.X(hv.step);
      const w = this.X(hv.step + 1) - x;
      const y = H + hv.track * R;
      const v = this.views[hv.track]?.[hv.step];
      if (v && !v.outside) {
        if (v.state === 'empty') {
          // what a click would add: the new hit at its velocity, faintly
          const bh = Math.max(6, Math.round(((R - 12) * app.ui.paintVel) / 127));
          g.fillStyle = c.ink;
          g.globalAlpha = 0.28;
          g.fillRect(x + 3, y + R - 5 - bh, w - 6, bh);
          g.globalAlpha = 1;
        }
        g.strokeStyle = c.ink;
        g.lineWidth = 2;
        g.setLineDash([4, 3]);
        g.strokeRect(x + 1.5, y + 1.5, w - 3, R - 4);
        g.setLineDash([]);
      }
    }

    // the cursor: a solid ring
    if (cur) {
      const ci = app.trackIndexOf(cur.track);
      if (ci >= 0) {
        const x = this.X(cur.step);
        const w = this.X(cur.step + 1) - x;
        const y = H + ci * R;
        g.strokeStyle = c.selection;
        g.lineWidth = 3;
        g.strokeRect(x + 1.5, y + 1.5, w - 3, R - 4);
        g.strokeStyle = c.paper;
        g.lineWidth = 1;
        g.strokeRect(x + 4.5, y + 4.5, w - 9, R - 10);
      }
    }

    // the playhead: a tinted column that never covers a hit, with its step lit in the header
    if (step >= 0 && step < this.steps) {
      const s = Math.floor(step);
      const x = this.X(s);
      const w = this.X(s + 1) - x;
      g.fillStyle = c.activity;
      g.globalAlpha = 0.13;
      g.fillRect(x, H, w, rowsH);
      g.globalAlpha = 1;
      g.fillRect(x, 0, w, H - 2);
      g.fillRect(x, H, 3, rowsH);
      g.fillRect(x + w - 3, H, 3, rowsH);
      g.fillStyle = c.paper;
      g.font = `${font(18)}px VT323, monospace`;
      g.textBaseline = 'middle';
      g.textAlign = 'center';
      g.fillText(String(s + 1), x + w / 2, H / 2 - 1);
      g.textAlign = 'start';
      this.follow(x);
    }
  }

  /** While playing, keep the playhead in view if the grid scrolls (unless the user is scrolling). */
  private follow(x: number): void {
    const sc = this.scroll;
    if (sc.scrollWidth <= sc.clientWidth + 1 || !this.app.ui.playing) return;
    if (performance.now() - this.lastUser < 2500) return;
    if (x < sc.scrollLeft || x + this.cellW > sc.scrollLeft + sc.clientWidth) sc.scrollLeft = Math.max(0, x - this.cellW * 2);
  }

  /** Scroll so that a step is visible. */
  reveal(step: number): void {
    const sc = this.scroll;
    const x = this.X(step);
    if (x < sc.scrollLeft) sc.scrollLeft = Math.max(0, x - this.cellW);
    else if (x + this.cellW > sc.scrollLeft + sc.clientWidth) sc.scrollLeft = x + this.cellW * 2 - sc.clientWidth;
  }

  /** The cell under the pointer: logical position, floored (a click inside a cell is that cell). */
  cellAt(e: PointerEvent | MouseEvent): Cell | null {
    const r = this.canvas.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    if (y < this.headH || x < 0) return null;
    let step = Math.floor(x / this.cellW);
    // the drawn edges are snapped to whole pixels: test against them, so a click is always in the cell it lands on
    if (step + 1 <= this.steps && x >= this.X(step + 1)) step++;
    else if (step > 0 && x < this.X(step)) step--;
    const track = Math.floor((y - this.headH) / this.rowH);
    if (step < 0 || step >= this.steps || track < 0 || track >= this.app.project.tracks.length) return null;
    return { track, step };
  }

  /** The tooltip words for a cell. */
  describe(c: Cell): { head: string; lines: string[] } | null {
    const v = this.views[c.track]?.[c.step];
    const t = this.app.project.tracks[c.track];
    if (!v || !t) return null;
    return describeCell(t.name, c.step, v, this.metrics);
  }

  view(c: Cell): CellView | null {
    return this.views[c.track]?.[c.step] ?? null;
  }

  private setHover(cell: Cell | null, e?: PointerEvent): void {
    const same = (!cell && !this.hover) || (cell && this.hover && cell.track === this.hover.track && cell.step === this.hover.step);
    if (same) return;
    this.hover = cell;
    clearTimeout(this.tipTimer);
    hideTip();
    this.onHover?.(cell);
    this.drawOverlay(this.lastHead);
    if (cell && e && !this.gesture) {
      const x = e.clientX;
      const y = e.clientY;
      this.tipTimer = window.setTimeout(() => {
        const d = this.describe(cell);
        if (d && this.hover === cell) showTip(x, y, d);
      }, 380);
    }
  }

  private bind(): void {
    const app = this.app;
    const c = this.canvas;
    c.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const cell = this.cellAt(e);
      if (!cell) return;
      const t = app.project.tracks[cell.track]!;
      app.ui.cursor = { track: t.id, step: cell.step };
      app.selectTrack(t.id);
      app.select({ t0: cell.track, t1: cell.track, s0: cell.step, s1: cell.step });
      this.drawOverlay(this.lastHead);
      this.onContext?.(cell, e);
    });
    c.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const cell = this.cellAt(e);
      if (!cell) return;
      hideTip();
      c.setPointerCapture(e.pointerId);
      c.focus({ preventScroll: true });
      const t = app.project.tracks[cell.track]!;
      if (e.shiftKey) {
        this.gesture = { kind: 'select', t0: cell.track, s0: cell.step };
        app.select({ t0: cell.track, t1: cell.track, s0: cell.step, s1: cell.step });
        this.drawOverlay(this.lastHead);
        return;
      }
      const hit = app.hitAt(t.id, cell.step);
      app.ui.cursor = { track: t.id, step: cell.step };
      if (e.altKey && hit) {
        app.selectTrack(t.id);
        app.beginDrag('VELOCITY');
        this.gesture = { kind: 'vel', track: t.id, step: cell.step, y0: e.clientY, v0: hit.vel };
        return;
      }
      if (app.ui.sel) app.select(null);
      app.selectTrack(t.id);
      app.beginPaint();
      this.gesture = { kind: 'paint', on: !hit, last: `${cell.track}:${cell.step}` };
      app.paintCell(t.id, cell.step, !hit);
      if (!hit) void app.audition(t.id, app.ui.paintVel);
    });
    c.addEventListener('pointermove', (e) => {
      const gs = this.gesture;
      if (!gs) {
        this.setHover(this.cellAt(e), e);
        return;
      }
      if (gs.kind === 'vel') {
        const v = Math.max(1, Math.min(127, Math.round(gs.v0 + (gs.y0 - e.clientY))));
        const hit = app.hitAt(gs.track, gs.step);
        if (hit && hit.vel !== v) app.setHitProps(gs.track, gs.step, { vel: v }, 'VELOCITY');
        return;
      }
      const cell = this.cellAt(e);
      if (!cell) return;
      this.hover = cell;
      this.onHover?.(cell);
      if (gs.kind === 'select') {
        app.select({ t0: gs.t0, t1: cell.track, s0: gs.s0, s1: cell.step });
        this.drawOverlay(this.lastHead);
      } else {
        const key = `${cell.track}:${cell.step}`;
        if (key === gs.last) return;
        gs.last = key;
        app.paintCell(app.project.tracks[cell.track]!.id, cell.step, gs.on);
      }
    });
    c.addEventListener('pointerleave', () => {
      if (!this.gesture) this.setHover(null);
    });
    const end = () => {
      const gs = this.gesture;
      this.gesture = null;
      if (!gs) return;
      if (gs.kind === 'paint') app.endPaint();
      if (gs.kind === 'vel') app.endDrag();
      this.lastKey = '';
      this.drawOverlay(this.lastHead);
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    // Alt + wheel: velocity of the hit under the pointer (the plain wheel scrolls the page)
    c.addEventListener(
      'wheel',
      (e) => {
        if (!e.altKey) return;
        const cell = this.cellAt(e);
        if (!cell) return;
        const t = app.project.tracks[cell.track]!;
        const hit = app.hitAt(t.id, cell.step);
        if (!hit) return;
        e.preventDefault();
        const d = e.deltaY || e.deltaX;
        app.setHitProps(t.id, cell.step, { vel: Math.max(1, Math.min(127, hit.vel + (d < 0 ? 6 : -6))) }, 'VELOCITY');
      },
      { passive: false },
    );
    // the keyboard: arrows move the cursor along the track, Enter adds or removes the hit there
    c.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const cur = app.cursorCell() ?? { track: app.ui.track, step: -1 };
      const steps = app.pattern.steps;
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'Home' || e.key === 'End') {
        const next = e.key === 'Home' ? 0 : e.key === 'End' ? steps - 1 : Math.max(0, Math.min(steps - 1, (cur.step < 0 ? (e.key === 'ArrowRight' ? -1 : steps) : cur.step) + (e.key === 'ArrowRight' ? 1 : -1)));
        app.setCursor({ track: cur.track, step: next });
        this.reveal(next);
      } else if (e.key === 'Enter' && cur.step >= 0) {
        app.toggleCell(cur.track, cur.step);
        void app.audition(cur.track, app.ui.paintVel);
      } else return;
      e.preventDefault();
      e.stopPropagation();
    });
  }
}
