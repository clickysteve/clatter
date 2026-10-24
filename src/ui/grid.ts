/**
 * The pattern grid. Track rows (name, source, MUTE / SOLO / LOCK) beside a canvas of steps.
 *
 *   a hit          a block whose height is its velocity
 *   probability    hatched below 100 %
 *   hand edit      a notch in the top-left corner (a deleted baseline hit: a small ×)
 *   this cycle     dotted frame: suppressed (probability, density) · dot: added (fills, rolls,
 *                  chop) · hatch bar: destroyed · slash: moved away by CHOP · ^: evolved
 *
 * Pointer: click toggles a cell, drag paints (one undo step), Shift-drag selects a region,
 * Alt-drag up/down sets velocity, right-click selects one cell. A click anywhere inside a
 * cell edits that cell: hit-testing floors the logical position, never rounds.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import type { App } from '../app/app';
import { cellOrigin, sourceGrid } from '../rhythm/pattern';
import { stepsPerBar } from '../rhythm/generate';
import { CELL_ADDED, CELL_DESTROYED, CELL_EVOLVED, CELL_MOVED, CELL_SUPPRESSED } from '../rhythm/realize';
import { button, h, Panel } from './widgets';

const LABEL_W = 156;
const HEAD_H = 14;

export interface GridOptions {
  width: number;
  height: number;
  /** read-only (PERFORM) */
  readonly?: boolean;
  /** compact rows (no buttons) */
  compact?: boolean;
}

export class PatternGrid {
  readonly el: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private over: HTMLCanvasElement;
  private rows: HTMLDivElement;
  private panel = new Panel();
  private rowH = 22;
  private cellW = 16;
  private steps = 32;
  private gesture: null | { kind: 'paint'; on: boolean; last: string } | { kind: 'select'; t0: number; s0: number } | { kind: 'vel'; track: string; step: number; y0: number; v0: number } = null;

  constructor(
    private app: App,
    parent: HTMLElement,
    private o: GridOptions,
  ) {
    this.el = h('div', 'gridwrap', parent);
    Object.assign(this.el.style, { width: o.width + 'px', height: o.height + 'px' });
    this.rows = h('div', '', this.el);
    this.canvas = h('canvas', '', this.el);
    this.over = h('canvas', '', this.el);
    this.over.style.pointerEvents = 'none';
    for (const c of [this.canvas, this.over]) c.style.left = (o.compact ? 70 : LABEL_W) + 'px';
    this.canvas.setAttribute('role', 'grid');
    this.canvas.setAttribute('aria-label', 'Pattern grid');
    if (!o.readonly) this.bind();
    this.build();
  }

  private get labelW(): number {
    return this.o.compact ? 70 : LABEL_W;
  }

  /** Rebuild the track rows (tracks changed). */
  build(): void {
    const app = this.app;
    this.panel.clear();
    this.rows.innerHTML = '';
    const tracks = app.project.tracks;
    this.rowH = Math.max(14, Math.min(32, Math.floor((this.o.height - HEAD_H - 2) / tracks.length)));
    tracks.forEach((t, i) => {
      const r = h('div', 'trackrow', this.rows);
      Object.assign(r.style, { top: HEAD_H + i * this.rowH + 'px', height: this.rowH + 'px', width: this.labelW + 'px' });
      const name = h('div', 'tname', r, t.name);
      name.title = `${t.name}: click to select, double-click to hear`;
      name.addEventListener('click', () => app.selectTrack(t.id));
      name.addEventListener('dblclick', () => void app.audition(t.id));
      if (this.o.compact) {
        name.style.width = '62px';
        this.panel.add(() => r.classList.toggle('sel', app.ui.track === t.id));
        return;
      }
      const mode = h('div', 'mode', r);
      this.panel.add(() => {
        const tt = app.project.tracks.find((x) => x.id === t.id)!;
        mode.textContent = tt.sound.mode === 'synth' ? 'SYN' : tt.sound.mode === 'sample' ? 'SMP' : 'HYB';
        name.textContent = tt.name;
        r.classList.toggle('sel', app.ui.track === t.id);
      });
      button(this.panel, r, 'M', () => app.setTrackMix(t.id, { mute: !app.project.tracks[i]!.mix.mute }), { cls: 'small', on: () => !!app.project.tracks[i]?.mix.mute, title: 'Mute' });
      button(this.panel, r, 'S', () => app.setTrackMix(t.id, { solo: !app.project.tracks[i]!.mix.solo }), { cls: 'small', on: () => !!app.project.tracks[i]?.mix.solo, title: 'Solo' });
      button(this.panel, r, 'L', () => app.lockTrack(t.id), { cls: 'small', on: () => !!app.project.tracks[i]?.lock, title: 'Lock: generation and mutation leave this track alone' });
      button(this.panel, r, '▶', () => void app.audition(t.id), { cls: 'small', title: 'Hear this track' });
    });
    this.draw();
  }

  refreshRows(): void {
    this.panel.refresh();
  }

  private ink(): string {
    return getComputedStyle(this.el).getPropertyValue('--ink').trim() || '#000';
  }
  private paper(): string {
    return getComputedStyle(this.el).getPropertyValue('--paper').trim() || '#fff';
  }
  private activity(): string {
    return getComputedStyle(this.el).getPropertyValue('--activity').trim() || this.ink();
  }

  /** Redraw every cell. */
  draw(): void {
    const app = this.app;
    const p = app.pattern;
    const tracks = app.project.tracks;
    this.steps = p.steps;
    const w = this.o.width - this.labelW - 2;
    this.cellW = Math.max(6, Math.floor(w / p.steps));
    const cw = this.cellW * p.steps;
    const ch = HEAD_H + this.rowH * tracks.length;
    for (const c of [this.canvas, this.over]) {
      c.width = cw;
      c.height = ch;
      c.style.width = cw + 'px';
      c.style.height = ch + 'px';
    }
    const g = this.canvas.getContext('2d')!;
    const ink = this.ink();
    const paper = this.paper();
    g.fillStyle = paper;
    g.fillRect(0, 0, cw, ch);
    const perBar = stepsPerBar(p.res);
    // header: bar and beat numbers
    g.fillStyle = ink;
    g.font = '8px Silkscreen, monospace';
    g.textBaseline = 'top';
    for (let s = 0; s < p.steps; s++) {
      if (s % perBar === 0) g.fillText(String(s / perBar + 1), s * this.cellW + 2, 3);
      else if (s % p.res === 0) g.fillRect(s * this.cellW + 2, 7, 1, 1);
    }
    g.fillRect(0, HEAD_H - 1, cw, 1);
    const real = app.displayRealization();
    tracks.forEach((t, ti) => {
      const y = HEAD_H + ti * this.rowH;
      const grid = sourceGrid(p, t.id);
      const flags = real.cells[t.id];
      const dim = t.mix.mute || (tracks.some((x) => x.mix.solo) && !t.mix.solo);
      for (let s = 0; s < p.steps; s++) {
        const x = s * this.cellW;
        // grid lines
        g.fillStyle = ink;
        if (s % perBar === 0) g.fillRect(x, y, 1, this.rowH);
        else if (s % p.res === 0) for (let yy = y; yy < y + this.rowH; yy += 2) g.fillRect(x, yy, 1, 1);
        const hit = grid[s];
        const f = flags?.[s] ?? 0;
        const ix = x + 2;
        const iw = this.cellW - 3;
        const iy = y + 2;
        const ih = this.rowH - 4;
        if (t.play.length > 0 && s >= t.play.length) {
          // beyond a polymeter track's own length
          for (let yy = iy; yy < iy + ih; yy += 3) for (let xx = ix + ((yy / 3) % 2); xx < ix + iw; xx += 3) g.fillRect(xx, yy, 1, 1);
          continue;
        }
        if (hit) {
          const hh = Math.max(3, Math.round((ih * hit.vel) / 127));
          g.fillStyle = ink;
          if ((hit.prob ?? 100) < 100) {
            g.strokeStyle = ink;
            g.strokeRect(ix + 0.5, iy + ih - hh + 0.5, iw - 1, hh - 1);
            for (let k = -hh; k < iw; k += 3) {
              g.beginPath();
              g.moveTo(ix + Math.max(0, k), iy + ih - Math.max(0, -k));
              g.lineTo(ix + Math.min(iw, k + hh), iy + ih - Math.min(hh, iw - k + 0));
              g.stroke();
            }
          } else g.fillRect(ix, iy + ih - hh, iw, hh);
          if (dim) {
            g.fillStyle = paper;
            for (let yy = iy + ih - hh; yy < iy + ih; yy += 2) for (let xx = ix + (yy % 2); xx < ix + iw; xx += 2) g.fillRect(xx, yy, 1, 1);
          }
          if (hit.flam) {
            g.fillStyle = paper;
            g.fillRect(ix + 1, iy + ih - hh + 1, 2, 2);
          }
          if (hit.ratchet && hit.ratchet > 1) {
            g.fillStyle = paper;
            for (let k = 1; k < hit.ratchet; k++) g.fillRect(ix + Math.round((iw * k) / hit.ratchet), iy + ih - hh, 1, hh);
          }
        }
        const origin = cellOrigin(p, t.id, s);
        g.fillStyle = ink;
        if (origin === 'edit') {
          g.fillRect(ix - 1, iy - 1, 4, 1);
          g.fillRect(ix - 1, iy - 1, 1, 4);
        } else if (origin === 'deleted') {
          g.fillRect(ix + iw / 2 - 2, iy + ih / 2 - 2, 1, 1);
          g.fillRect(ix + iw / 2 + 1, iy + ih / 2 + 1, 1, 1);
          g.fillRect(ix + iw / 2 - 2, iy + ih / 2 + 1, 1, 1);
          g.fillRect(ix + iw / 2 + 1, iy + ih / 2 - 2, 1, 1);
        }
        // what this cycle did
        const act = this.activity();
        if (f & CELL_SUPPRESSED) {
          g.fillStyle = act;
          for (let xx = ix; xx < ix + iw; xx += 2) {
            g.fillRect(xx, iy, 1, 1);
            g.fillRect(xx, iy + ih - 1, 1, 1);
          }
        }
        if (f & CELL_ADDED && !hit) {
          g.fillStyle = act;
          g.fillRect(ix + Math.floor(iw / 2) - 1, iy + Math.floor(ih / 2) - 1, 3, 3);
        }
        if (f & CELL_DESTROYED) {
          g.fillStyle = act;
          for (let xx = 0; xx < iw; xx += 2) g.fillRect(ix + xx, iy + (xx % 4 === 0 ? 0 : 1), 1, 1);
        }
        if (f & CELL_MOVED && hit) {
          g.strokeStyle = paper;
          g.beginPath();
          g.moveTo(ix, iy + ih);
          g.lineTo(ix + iw, iy + ih - Math.round((ih * hit.vel) / 127));
          g.stroke();
        }
        if (f & CELL_EVOLVED) {
          g.fillStyle = act;
          g.fillRect(ix + iw - 3, iy, 3, 1);
          g.fillRect(ix + iw - 2, iy + 1, 1, 1);
        }
      }
      g.fillStyle = ink;
      g.fillRect(0, y + this.rowH - 1, cw, 1);
    });
    g.fillRect(cw - 1, 0, 1, ch);
    this.drawOverlay(-1);
  }

  private lastHead = -2;

  /** The playhead and the selection (cheap: every animation frame). */
  drawOverlay(step: number): void {
    if (step === this.lastHead && step !== -1) return;
    this.lastHead = step;
    const g = this.over.getContext('2d')!;
    g.clearRect(0, 0, this.over.width, this.over.height);
    const ink = this.ink();
    const act = this.activity();
    if (step >= 0 && step < this.steps) {
      const x = Math.floor(step) * this.cellW;
      g.globalCompositeOperation = 'difference';
      g.fillStyle = '#ffffff';
      g.fillRect(x + 1, HEAD_H, this.cellW - 1, 3);
      g.globalCompositeOperation = 'source-over';
      g.strokeStyle = act;
      g.lineWidth = 1;
      g.strokeRect(x + 0.5, 0.5, this.cellW - 1, this.over.height - 1);
    }
    const sel = this.app.ui.sel;
    if (sel && !this.o.readonly) {
      const t0 = Math.min(sel.t0, sel.t1);
      const t1 = Math.max(sel.t0, sel.t1);
      const s0 = Math.min(sel.s0, sel.s1);
      const s1 = Math.max(sel.s0, sel.s1);
      g.strokeStyle = ink;
      g.setLineDash([2, 2]);
      g.strokeRect(s0 * this.cellW + 0.5, HEAD_H + t0 * this.rowH + 0.5, (s1 - s0 + 1) * this.cellW - 1, (t1 - t0 + 1) * this.rowH - 1);
      g.setLineDash([]);
    }
  }

  /** The cell under the pointer: logical position, floored (a click inside a cell is that cell). */
  cellAt(e: PointerEvent | MouseEvent): { track: number; step: number } | null {
    const r = this.canvas.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const x = ((e.clientX - r.left) * this.canvas.width) / r.width;
    const y = ((e.clientY - r.top) * this.canvas.height) / r.height;
    if (y < HEAD_H) return null;
    const step = Math.floor(x / this.cellW);
    const track = Math.floor((y - HEAD_H) / this.rowH);
    if (step < 0 || step >= this.steps || track < 0 || track >= this.app.project.tracks.length) return null;
    return { track, step };
  }

  private bind(): void {
    const app = this.app;
    const c = this.canvas;
    c.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const cell = this.cellAt(e);
      if (!cell) return;
      app.selectTrack(app.project.tracks[cell.track]!.id);
      app.select({ t0: cell.track, t1: cell.track, s0: cell.step, s1: cell.step });
      this.drawOverlay(-1);
    });
    c.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const cell = this.cellAt(e);
      if (!cell) return;
      c.setPointerCapture(e.pointerId);
      const t = app.project.tracks[cell.track]!;
      if (e.shiftKey) {
        this.gesture = { kind: 'select', t0: cell.track, s0: cell.step };
        app.select({ t0: cell.track, t1: cell.track, s0: cell.step, s1: cell.step });
        this.drawOverlay(-1);
        return;
      }
      const hit = app.hitAt(t.id, cell.step);
      if (e.altKey && hit) {
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
      if (!gs) return;
      if (gs.kind === 'vel') {
        const v = Math.max(1, Math.min(127, Math.round(gs.v0 + (gs.y0 - e.clientY))));
        const hit = app.hitAt(gs.track, gs.step);
        if (hit && hit.vel !== v) {
          app.setHitProps(gs.track, gs.step, { vel: v }, 'VELOCITY');
        }
        return;
      }
      const cell = this.cellAt(e);
      if (!cell) return;
      if (gs.kind === 'select') {
        app.select({ t0: gs.t0, t1: cell.track, s0: gs.s0, s1: cell.step });
        this.drawOverlay(-1);
      } else {
        const key = `${cell.track}:${cell.step}`;
        if (key === gs.last) return;
        gs.last = key;
        app.paintCell(app.project.tracks[cell.track]!.id, cell.step, gs.on);
      }
    });
    const end = () => {
      const gs = this.gesture;
      this.gesture = null;
      if (!gs) return;
      if (gs.kind === 'paint') app.endPaint();
      if (gs.kind === 'vel') app.endDrag();
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener(
      'wheel',
      (e) => {
        const cell = this.cellAt(e);
        if (!cell) return;
        const t = app.project.tracks[cell.track]!;
        const hit = app.hitAt(t.id, cell.step);
        if (!hit) return;
        e.preventDefault();
        app.setHitProps(t.id, cell.step, { vel: Math.max(1, Math.min(127, hit.vel + (e.deltaY < 0 ? 6 : -6))) }, 'VELOCITY');
      },
      { passive: false },
    );
  }
}
