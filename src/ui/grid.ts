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
 * outline.
 *
 * Pointer (the gestures are in stepGesture.ts, each one undo step): click an empty step adds a hit,
 * drag up / down from it (or from a hit) sets the velocity and shows it, drag sideways paints,
 * click a hit removes it, Shift-drag erases, Shift-click selects from the cursor to the step, Alt-drag
 * selects a region, a click in the header selects that column, right-click opens the step editor.
 * A click anywhere inside a cell edits that cell: hit-testing floors the position, never rounds.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import type { App } from '../app/app';
import { boundaryAt, describeCell, gridMetrics, trackCells, trigOutcome, type CellView, type GridMetrics } from './gridModel';
import { font, hit, logicalWidth, onScale, sz } from './scale';
import { StepGesture } from './stepGesture';
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
 * A step with a sound of its own: a corner triangle when it carries locks or rules, and a small
 * plate with the variation letter, "?" when a condition decides, ">" when it triggers another voice.
 */
function drawSoundMark(g: CanvasRenderingContext2D, x: number, y: number, w: number, s: NonNullable<CellView['snd']>, c: GridColors): void {
  const right = x + w - 1;
  if (s.edits) {
    g.fillStyle = c.ink;
    g.beginPath();
    g.moveTo(right, y + 1);
    g.lineTo(right - 9, y + 1);
    g.lineTo(right, y + 10);
    g.fill();
  }
  const text = (s.letter ?? '') + (s.cond ? '?' : '') + (s.voice ? '>' : '');
  if (!text) return;
  g.font = 'bold 10px VT323, monospace';
  g.textBaseline = 'middle';
  const tw = Math.ceil(g.measureText(text).width);
  const pw = tw + 4;
  const px = right - pw - (s.edits ? 7 : 1);
  const py = y + 1;
  g.fillStyle = c.paper;
  g.fillRect(px - 1, py - 1, pw + 2, 13);
  g.fillStyle = c.ink;
  g.fillRect(px, py, pw, 11);
  g.fillStyle = c.paper;
  g.fillText(text, px + 2, py + 6);
}

/**
 * A step whose trigger condition is not ALWAYS: a small right-angle mark in the bottom-left corner
 * (paper halo, ink body), so it reads over a hit block and on an empty cell alike. The words
 * (EVERY 4, 50%, FILL ONLY) are in the tooltip, the footer and the TRIGGER tab.
 */
function drawTrigMark(g: CanvasRenderingContext2D, x: number, y: number, h: number, c: GridColors): void {
  const bottom = y + h - 1;
  const left = x + 1;
  g.fillStyle = c.paper;
  g.beginPath();
  g.moveTo(left, bottom - 11);
  g.lineTo(left + 11, bottom);
  g.lineTo(left, bottom);
  g.fill();
  g.fillStyle = c.ink;
  g.beginPath();
  g.moveTo(left + 1, bottom - 8);
  g.lineTo(left + 8, bottom - 1);
  g.lineTo(left + 1, bottom - 1);
  g.fill();
}

/**
 * One cell: the hit as it sounds. (x, y) is the cell's top-left corner, w × h its size.
 * Shared by the grid and the grid key.
 */
export function drawCell(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, v: CellView, c: GridColors): void {
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
  // an empty step is still a place to click: a short rule at its foot
  if (v.state === 'empty' && !v.outside) {
    g.fillStyle = c.ink;
    g.globalAlpha = 0.22;
    g.fillRect(bx + 2, bottom, bw - 4, 1);
    g.globalAlpha = 1;
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
  if (v.snd && v.state !== 'empty') drawSoundMark(g, x, y, w, v.snd, c);
  if (v.trig && v.state !== 'empty') drawTrigMark(g, x, y, h, c);
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
  private gesture: StepGesture;
  /** a header press selects columns: where it started */
  private columns: number | null = null;
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
    this.gesture = new StepGesture(app.gestureHost());
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
    const ch = this.headH + this.rowH * (tracks.length);
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
        drawCell(g, x, y, cwid, R - 1, v, c);
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
    const key = `${Math.floor(step)}|${this.hover ? this.hover.track + ':' + this.hover.step : ''}|${sel ? `${sel.t0},${sel.t1},${sel.s0},${sel.s1}` : ''}|${cur ? cur.track + ':' + cur.step : ''}|${app.ui.picks.map((x) => x.track + ':' + x.step).join(',')}|${app.ui.track}|${this.cellW}|${app.ui.paintVel}|${this.gesture.dragging?.vel ?? ''}|${app.ui.playing ? app.playhead()?.cycle : ''}`;
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

    // a region (Alt-drag, Shift-click, a click in the header)
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
      // the hits inside it, so what a tool will change is plain: a frame round each
      g.lineWidth = 2;
      for (let ti2 = t0; ti2 <= t1; ti2++) {
        const row = this.views[ti2];
        if (!row) continue;
        for (let st = s0; st <= Math.min(s1, this.steps - 1); st++) {
          const v = row[st];
          if (!v?.hit || v.outside) continue;
          const x = this.X(st);
          g.strokeStyle = c.paper;
          g.strokeRect(x + 2.5, H + ti2 * R + 2.5, this.X(st + 1) - x - 5, R - 6);
          g.strokeStyle = c.selection;
          g.strokeRect(x + 3.5, H + ti2 * R + 3.5, this.X(st + 1) - x - 7, R - 8);
        }
      }
    }

    // steps picked one by one (Shift-click): a frame round each
    if (app.ui.picks.length && !this.o.readonly) {
      g.lineWidth = 2;
      for (const pk of app.ui.picks) {
        const pi = app.trackIndexOf(pk.track);
        if (pi < 0 || pk.step >= this.steps) continue;
        const x = this.X(pk.step);
        const w = this.X(pk.step + 1) - x;
        g.fillStyle = c.selection;
        g.globalAlpha = 0.1;
        g.fillRect(x, H + pi * R, w, R - 1);
        g.globalAlpha = 1;
        g.strokeStyle = c.paper;
        g.strokeRect(x + 2.5, H + pi * R + 2.5, w - 5, R - 6);
        g.strokeStyle = c.selection;
        g.strokeRect(x + 3.5, H + pi * R + 3.5, w - 7, R - 8);
      }
    }

    // the pointer
    const hv = this.hover;
    if (hv && !this.o.readonly && !this.gesture.active) {
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

    // a velocity being dragged: the value beside the hit, with the scale it moves on
    const dv = this.gesture.dragging;
    if (dv) {
      const di = app.trackIndexOf(dv.track);
      if (di >= 0) this.drawVelReadout(g, c, this.X(dv.step), this.X(dv.step + 1) - this.X(dv.step), H + di * R, R, dv.vel);
    }

    // trigger feedback: what the sequencer decided for each conditional step, as the playhead passes
    if (step >= 0 && step < this.steps && app.ui.playing) this.drawOutcomes(g, c, Math.floor(step));

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

  /** "VEL 87" on a plate above (or below) the hit being dragged. */
  private drawVelReadout(g: CanvasRenderingContext2D, c: GridColors, x: number, w: number, y: number, R: number, vel: number): void {
    const text = `VEL ${vel}`;
    g.font = `${font(18)}px VT323, monospace`;
    g.textBaseline = 'middle';
    const tw = Math.ceil(g.measureText(text).width) + 12;
    const ph = Math.round(font(18)) + 8;
    const px = Math.max(2, Math.min(this.X(this.steps) - tw - 2, x + Math.round((w - tw) / 2)));
    const py = y - ph - 2 < this.headH ? y + R : y - ph - 2;
    g.fillStyle = c.paper;
    g.fillRect(px - 2, py - 2, tw + 4, ph + 4);
    g.fillStyle = c.ink;
    g.fillRect(px, py, tw, ph);
    g.fillStyle = c.paper;
    g.fillText(text, px + 6, py + ph / 2);
    // a thin gauge down the hit's cell: 1 at the bottom, 127 at the top
    g.fillStyle = c.ink;
    g.fillRect(x + w - 4, y + 3, 2, R - 8);
    g.fillStyle = c.paper;
    const gy = y + 3 + Math.round(((R - 8) * (127 - vel)) / 126);
    g.fillRect(x + w - 6, gy - 1, 6, 4);
    g.fillStyle = c.ink;
    g.fillRect(x + w - 5, gy, 4, 2);
  }

  /**
   * For every conditional step the playhead has passed on this cycle: a mark in the top-left corner,
   * solid when it played, hollow when the condition held but the hit stayed silent (chance, density),
   * crossed when the condition skipped it; a step that was just skipped gets a cross over the whole cell.
   * A step whose sound switches by condition shows the variation that sounds now.
   */
  private drawOutcomes(g: CanvasRenderingContext2D, c: GridColors, upTo: number): void {
    const app = this.app;
    const R = this.rowH;
    const H = this.headH;
    const pos = app.playhead();
    const m = 8;
    this.views.forEach((row, ti) => {
      const t = app.project.tracks[ti];
      if (!t) return;
      const y = H + ti * R;
      for (let s = 0; s <= upTo && s < row.length; s++) {
        const v = row[s]!;
        if (v.outside) continue;
        const out = trigOutcome(v);
        const x = this.X(s);
        const w = this.X(s + 1) - x;
        if (out) {
          const mx = x + 3;
          const my = y + 3;
          g.fillStyle = c.paper;
          g.fillRect(mx - 1, my - 1, m + 2, m + 2);
          g.fillStyle = c.ink;
          if (out === 'played') g.fillRect(mx, my, m, m);
          else {
            g.strokeStyle = c.ink;
            g.lineWidth = 1;
            g.strokeRect(mx + 0.5, my + 0.5, m - 1, m - 1);
            if (out === 'skipped') {
              g.beginPath();
              g.moveTo(mx + 1, my + 1);
              g.lineTo(mx + m - 1, my + m - 1);
              g.moveTo(mx + m - 1, my + 1);
              g.lineTo(mx + 1, my + m - 1);
              g.stroke();
            }
          }
          if (out === 'skipped' && s === upTo) {
            // just now: the whole cell crossed out
            g.strokeStyle = c.ink;
            g.lineWidth = 2;
            g.beginPath();
            g.moveTo(x + 5, y + 5);
            g.lineTo(x + w - 5, y + R - 8);
            g.moveTo(x + w - 5, y + 5);
            g.lineTo(x + 5, y + R - 8);
            g.stroke();
          }
        }
        if (v.snd?.cond && v.state === 'hit' && pos) {
          const vi = app.playingVariation(t.id, s, pos.cycle);
          const text = vi === null ? '·' : String.fromCharCode(65 + vi);
          g.font = 'bold 12px VT323, monospace';
          g.textBaseline = 'middle';
          const bw = Math.ceil(g.measureText(text).width) + 6;
          const bx = x + w - bw - 3;
          const by = y + R - 17;
          g.fillStyle = c.paper;
          g.fillRect(bx - 1, by - 1, bw + 2, 14);
          g.strokeStyle = c.ink;
          g.lineWidth = 1;
          g.strokeRect(bx + 0.5, by + 0.5, bw, 12);
          g.fillStyle = c.ink;
          g.fillText(text, bx + 3, by + 7);
        }
      }
    });
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

  /** The step column under the pointer, clamped to the pattern (the pointer may be above, below or beside the grid). */
  private stepAt(e: PointerEvent | MouseEvent): number {
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    let step = Math.floor(x / this.cellW);
    if (step + 1 <= this.steps && x >= this.X(step + 1)) step++;
    else if (step > 0 && x < this.X(step)) step--;
    return Math.max(0, Math.min(this.steps - 1, step));
  }

  private inHeader(e: PointerEvent | MouseEvent): boolean {
    const r = this.canvas.getBoundingClientRect();
    return e.clientY - r.top < this.headH && e.clientY >= r.top && e.clientX >= r.left;
  }

  /** The pointer says what a press would do: a hit is dragged for velocity, an empty step takes a new hit, Alt selects. */
  private setCursorStyle(e: PointerEvent | MouseEvent): void {
    const m = this.gesture.mode;
    let cur = '';
    if (m === 'vel') cur = 'ns-resize';
    else if (m === 'paint' || m === 'erase') cur = 'col-resize';
    else if (m === 'region') cur = 'crosshair';
    else if (!m) {
      if (this.inHeader(e)) cur = 's-resize';
      else if (e.altKey) cur = 'crosshair';
      else {
        const cell = this.cellAt(e);
        const v = cell ? this.views[cell.track]?.[cell.step] : null;
        cur = !cell || !v || v.outside ? '' : v.hit ? 'ns-resize' : 'cell';
      }
    }
    this.canvas.style.cursor = cur;
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
    if (cell && e && !this.gesture.active) {
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
      app.ui.picks = [];
      app.selectTrack(t.id);
      app.select({ t0: cell.track, t1: cell.track, s0: cell.step, s1: cell.step });
      this.drawOverlay(this.lastHead);
      this.onContext?.(cell, e);
    });
    const press = (e: PointerEvent, cell: Cell) => ({ track: app.project.tracks[cell.track]!.id, trackIndex: cell.track, step: cell.step, x: e.clientX, y: e.clientY, shift: e.shiftKey, alt: e.altKey, touch: e.pointerType === 'touch' });
    c.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      // the header: a press selects that step across every track, a drag along it selects the columns
      if (this.inHeader(e)) {
        const step = this.stepAt(e);
        c.setPointerCapture(e.pointerId);
        c.focus({ preventScroll: true });
        const from = e.shiftKey ? (app.ui.sel?.s0 ?? step) : step;
        this.columns = from;
        app.select({ t0: 0, t1: app.project.tracks.length - 1, s0: from, s1: step });
        return;
      }
      const cell = this.cellAt(e);
      if (!cell) return;
      hideTip();
      c.setPointerCapture(e.pointerId);
      c.focus({ preventScroll: true });
      this.gesture.down(press(e, cell));
      this.setCursorStyle(e);
      this.redrawOverlay();
    });
    c.addEventListener('pointermove', (e) => {
      if (this.columns !== null) {
        app.select({ t0: 0, t1: app.project.tracks.length - 1, s0: this.columns, s1: this.stepAt(e) });
        return;
      }
      if (!this.gesture.active) {
        this.setHover(this.cellAt(e), e);
        this.setCursorStyle(e);
        return;
      }
      // a gesture stays on the track it started on: the pointer may wander off the rows or the grid
      const cell = this.cellAt(e);
      const step = this.stepAt(e);
      const ti = cell?.track ?? Math.max(0, Math.min(app.project.tracks.length - 1, Math.floor((e.clientY - this.canvas.getBoundingClientRect().top - this.headH) / this.rowH)));
      this.hover = { track: ti, step };
      this.onHover?.(this.hover);
      this.gesture.move({ x: e.clientX, y: e.clientY, step, trackIndex: ti });
      this.redrawOverlay();
    });
    c.addEventListener('pointerleave', () => {
      if (!this.gesture.active) this.setHover(null);
    });
    const end = (e: PointerEvent) => {
      if (this.columns !== null) {
        this.columns = null;
        return;
      }
      if (!this.gesture.active) return;
      const ti = Math.max(0, Math.min(app.project.tracks.length - 1, Math.floor((e.clientY - this.canvas.getBoundingClientRect().top - this.headH) / this.rowH)));
      this.gesture.up({ x: e.clientX, y: e.clientY, step: this.stepAt(e), trackIndex: ti });
      this.setCursorStyle(e);
      this.lastKey = '';
      this.drawOverlay(this.lastHead);
    };
    c.addEventListener('pointerup', end);
    // the pointer was taken away (a system gesture, a lost capture): what has been done stays, as one undo step
    const lost = () => {
      this.columns = null;
      if (this.gesture.active) {
        this.gesture.cancel();
        this.redrawOverlay();
      }
    };
    c.addEventListener('pointercancel', lost);
    c.addEventListener('lostpointercapture', lost);
    window.addEventListener('blur', lost);

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
      // Shift + ↑ ↓: louder / softer, by 8, on the selected hits (else the hit being edited)
      if (e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        const d = e.key === 'ArrowUp' ? 8 : -8;
        const cur = app.cursorCell();
        if (app.ui.sel && app.selectedHitCount()) app.editVelocity({ k: 'nudge', d });
        else if (cur && app.hitAt(cur.track, cur.step)) app.setHitProps(cur.track, cur.step, { vel: Math.max(1, Math.min(127, app.hitAt(cur.track, cur.step)!.vel + d)) }, 'VELOCITY');
        else return;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
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
