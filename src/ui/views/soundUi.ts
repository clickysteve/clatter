/**
 * Small pieces the SOUND tabs share: a name prompt, a canvas plot that follows the palette and
 * the window, a live marker, and the pane contract (what a tab gives the SOUND view).
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import type { MetersMessage } from '../../audio/protocol';
import { buttons, closeDialog, dialog } from '../dialogs';
import { h, type Panel } from '../widgets';

/** What a SOUND tab hands back to the view that hosts it. */
export interface PaneParts {
  panels: Panel[];
  /** called every animation frame while the tab is the open one */
  frame?: (m: MetersMessage | null) => void;
  /** the tab was opened (true) or left (false) */
  active?: (on: boolean) => void;
}

/** Ask for a name (a preset, a kit...). */
export function askName(title: string, initial: string, ok: (name: string) => void, label = 'SAVE'): void {
  const box = dialog(title, 420);
  const input = h('input', 'num namebox', box) as HTMLInputElement;
  input.maxLength = 22;
  input.value = initial;
  input.style.width = '100%';
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') go();
    if (e.key === 'Escape') closeDialog();
  });
  const go = () => {
    const v = input.value.trim();
    if (!v) return;
    closeDialog();
    ok(v);
  };
  buttons(box, [['CANCEL', closeDialog], [label, go, true]]);
  setTimeout(() => {
    input.focus({ preventScroll: true });
    input.select();
  });
}

export type PlotFn = (g: CanvasRenderingContext2D, W: number, H: number, ink: string, paper: string) => void;

/** A canvas that redraws when the window or the palette changes. Draw with `set`, overlay with `marker`. */
export class Plot {
  readonly el: HTMLDivElement;
  readonly cv: HTMLCanvasElement;
  private fn: PlotFn | null = null;

  constructor(parent: HTMLElement, cls = '') {
    this.el = h('div', 'plot ' + cls, parent);
    this.cv = h('canvas', '', this.el);
    new ResizeObserver(() => this.draw()).observe(this.el);
    window.addEventListener('clatter-palette', () => this.draw());
  }

  set(fn: PlotFn): void {
    this.fn = fn;
    this.draw();
  }

  draw(): void {
    const W = this.el.clientWidth - 4;
    const H = this.el.clientHeight - 4;
    if (!this.fn || W < 10 || H < 10) return;
    const dpr = window.devicePixelRatio || 1;
    this.cv.width = Math.round(W * dpr);
    this.cv.height = Math.round(H * dpr);
    const g = this.cv.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cs = getComputedStyle(this.el);
    const ink = cs.getPropertyValue('--ink').trim() || '#000';
    const paper = cs.getPropertyValue('--paper').trim() || '#fff';
    g.fillStyle = paper;
    g.fillRect(0, 0, W, H);
    g.fillStyle = ink;
    g.strokeStyle = ink;
    this.fn(g, W, H, ink, paper);
  }

  /** A small square over the plot at (x, y) in 0..1 of its width and height (y from the top). */
  dot(): { el: HTMLDivElement; at: (x: number | null, y: number) => void } {
    const el = h('div', 'plotdot', this.el);
    let last = '';
    return {
      el,
      at: (x, y) => {
        const sig = x === null ? 'none' : `${(x * 1000).toFixed(0)}|${(y * 1000).toFixed(0)}`;
        if (sig === last) return;
        last = sig;
        if (x === null) el.style.display = 'none';
        else {
          el.style.display = 'block';
          el.style.left = Math.max(0, Math.min(1, x)) * 100 + '%';
          el.style.top = `calc(3px + (100% - 6px) * ${Math.max(0, Math.min(1, y)).toFixed(3)})`;
        }
      },
    };
  }

  /** A vertical line over the plot; move it with `at(0..1)`. */
  marker(wide = false): { el: HTMLDivElement; at: (x: number | null, w?: number) => void } {
    const el = h('div', 'plotmark' + (wide ? ' wide' : ''), this.el);
    let last = '';
    return {
      el,
      at: (x, w) => {
        const s = x === null ? 'none' : `${(x * 100).toFixed(2)}|${w ?? 0}`;
        if (s === last) return;
        last = s;
        if (x === null) el.style.display = 'none';
        else {
          el.style.display = '';
          el.style.left = x * 100 + '%';
          if (w !== undefined) el.style.width = w * 100 + '%';
        }
      },
    };
  }
}

/** Set a style property only when it changed (live meters run every frame). */
export function setW(el: HTMLElement, frac: number, prop: 'width' | 'height' = 'width'): void {
  const v = Math.max(0, Math.min(1, frac));
  const s = (Math.round(v * 1000) / 10).toFixed(1) + '%';
  if (el.dataset.w === s) return;
  el.dataset.w = s;
  el.style[prop] = s;
}

export const sgn = (v: number): string => (v > 0 ? '+' : '') + v;
export const db = (x: number): number => Math.max(0, Math.min(1, 1 + (20 * Math.log10(Math.max(1e-6, x))) / 48));

/** Show or hide an element as a panel state changes. */
export function vis(panel: Panel, el: HTMLElement, cond: () => boolean): void {
  panel.add(() => {
    el.style.display = cond() ? '' : 'none';
  });
}
