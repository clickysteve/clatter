/**
 * The widget toolkit: windows with slanted title tabs, buttons, sliders, number boxes and
 * pop-up selectors in the Slop Factory's 1-bit style (after emmm's widgets), in real pixels. Every widget
 * returns its element and registers an update function with the Panel it belongs to, so a
 * panel redraws its values without rebuilding.
 *
 * Numeric entry everywhere: click a slider or number box (it takes the keyboard focus), then
 * type a value and press Enter, or use the arrow keys (Shift for coarse steps). Double-click
 * returns a slider to its default. Alt-click (or right-click) on a synthesis slider locks it.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import { cpx } from './scale';

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', parent?: HTMLElement | null, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  parent?.appendChild(e);
  return e;
}

/** A set of widgets that update together. */
export class Panel {
  private updates: (() => void)[] = [];
  add(fn: () => void): void {
    this.updates.push(fn);
    fn();
  }
  refresh(): void {
    for (const u of this.updates) u();
  }
  clear(): void {
    this.updates = [];
  }
}

const SLANT = `<svg viewBox="0 0 16 17" preserveAspectRatio="none" width="16" height="17"><path d="M0 0 L16 17 L0 17 Z" style="fill:var(--paper)"/><path d="M0 0 L16 17" stroke="currentColor" style="stroke:var(--ink)" stroke-width="1" fill="none"/></svg>`;

export interface WinOptions {
  title: string;
  /** palette area (its own ink colour) */
  area?: string;
  id?: string;
  /** extra classes */
  cls?: string;
  /** the title bar folds the window away (tertiary panels) */
  collapsible?: boolean;
  /** the window starts folded */
  collapsed?: boolean;
  /** called when the user folds or unfolds it */
  onCollapse?: (collapsed: boolean) => void;
}

export interface Win {
  el: HTMLDivElement;
  body: HTMLDivElement;
  tools: HTMLDivElement;
  info: HTMLDivElement;
  setTitle(t: string): void;
  collapse(on: boolean): void;
}

/** A window: a slanted title tab, optional tools and info in the title bar, and a body that flows. */
export function win(parent: HTMLElement, o: WinOptions): Win {
  const el = h('div', 'win' + (o.cls ? ' ' + o.cls : '') + (o.collapsible ? ' collapsible' : ''), parent);
  if (o.area) el.dataset.area = o.area;
  if (o.id) el.id = o.id;
  const tb = h('div', 'titlebar', el);
  const title = h('div', 'title', tb, o.title);
  const slant = h('div', 'slant', tb);
  slant.innerHTML = SLANT;
  const info = h('div', 'info', tb);
  const tools = h('div', 'tools', tb);
  const body = h('div', 'body', el);
  el.setAttribute('role', 'region');
  el.setAttribute('aria-label', o.title);
  const collapse = (on: boolean) => {
    el.classList.toggle('collapsed', on);
    title.setAttribute('aria-expanded', String(!on));
  };
  if (o.collapsible) {
    title.tabIndex = 0;
    title.setAttribute('role', 'button');
    collapse(!!o.collapsed);
    const toggle = () => {
      const on = !el.classList.contains('collapsed');
      collapse(on);
      o.onCollapse?.(on);
    };
    tb.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.tools')) return;
      toggle();
    });
    title.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        toggle();
      }
    });
  }
  return { el, body, tools, info, setTitle: (t) => (title.textContent = t), collapse };
}

const openMore = new Set<string>();

/** A section that is closed until asked for: the home of tertiary controls. Returns its body. */
export function more(parent: HTMLElement, title: string, id: string): HTMLDivElement {
  const m = h('div', 'more' + (openMore.has(id) ? ' open' : ''), parent);
  const head = h('div', 'more-head', m, title);
  head.tabIndex = 0;
  head.setAttribute('role', 'button');
  const body = h('div', 'more-body', m);
  const toggle = () => {
    const on = m.classList.toggle('open');
    if (on) openMore.add(id);
    else openMore.delete(id);
    head.setAttribute('aria-expanded', String(on));
  };
  head.setAttribute('aria-expanded', String(m.classList.contains('open')));
  head.addEventListener('click', toggle);
  head.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      toggle();
    }
  });
  return body;
}

export interface ButtonOptions {
  on?: () => boolean;
  disabled?: () => boolean;
  queued?: () => boolean;
  cls?: string;
  title?: string;
  /** momentary: called with true on press, false on release */
  hold?: (down: boolean) => void;
  label?: () => string;
}

export function button(panel: Panel, parent: HTMLElement, label: string, onClick: ((e: MouseEvent) => void) | null, o: ButtonOptions = {}): HTMLButtonElement {
  const b = h('button', 'btn ' + (o.cls ?? ''), parent, label);
  b.type = 'button';
  if (o.title) b.title = o.title;
  if (onClick) b.addEventListener('click', (e) => onClick(e));
  if (o.hold) {
    const hold = o.hold;
    let down = false;
    const up = () => {
      if (!down) return;
      down = false;
      b.classList.remove('pressed');
      hold(false);
    };
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      down = true;
      b.classList.add('pressed');
      b.setPointerCapture(e.pointerId);
      hold(true);
    });
    b.addEventListener('pointerup', up);
    b.addEventListener('pointercancel', up);
  }
  panel.add(() => {
    if (o.on) b.classList.toggle('on', o.on());
    if (o.disabled) b.disabled = o.disabled();
    if (o.queued) b.classList.toggle('queued', o.queued());
    if (o.label) b.textContent = o.label();
  });
  return b;
}

export interface RangeOptions {
  get: () => number;
  set: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  /** value shown in the bar */
  format?: (v: number) => string;
  /** a bipolar control (fill from the centre) */
  bip?: boolean;
  /** value restored by double-click */
  def?: number;
  /** a typed number to a value (when the display differs from the value) */
  parse?: (typed: number) => number;
  begin?: () => void;
  end?: () => void;
  /** a lock mark (synthesis parameters) */
  locked?: () => boolean;
  /** alt-click / right-click */
  onAlt?: () => void;
  title?: string;
  width?: number;
}

const roundTo = (v: number, step: number) => Math.round(v / step) * step;

/** A horizontal slider with drag, keyboard and typed entry. */
export function range(panel: Panel, parent: HTMLElement, o: RangeOptions): HTMLDivElement {
  const el = h('div', 'range' + (o.bip ? ' bip' : ''), parent);
  if (o.width) el.style.minWidth = cpx(o.width);
  el.tabIndex = 0;
  if (o.title) el.title = o.title;
  const fill = h('div', 'fill', el);
  const cur = h('div', 'cur', el);
  const val = h('div', 'val', el);
  const step = o.step ?? 1;
  const span = o.max - o.min;
  const clampV = (v: number) => Math.max(o.min, Math.min(o.max, roundTo(v, step)));
  let typed = '';
  const draw = () => {
    const v = o.get();
    const f = span ? (v - o.min) / span : 0;
    const pct = Math.max(0, Math.min(1, f)) * 100;
    if (o.bip) {
      const c = 50;
      fill.style.left = Math.min(c, pct) + '%';
      fill.style.width = Math.abs(pct - c) + '%';
      fill.style.backgroundImage = 'var(--grey)';
    } else {
      fill.style.left = '0';
      fill.style.width = pct + '%';
    }
    cur.style.left = `calc(${pct}% - 1px)`;
    val.textContent = typed ? typed + '_' : o.format ? o.format(v) : String(v);
    el.classList.toggle('locked', !!o.locked?.());
    el.classList.toggle('editing', !!typed);
  };
  const setV = (v: number) => {
    const c = clampV(v);
    if (c !== o.get()) o.set(c);
    draw();
  };
  let dragging = false;
  let startX = 0;
  let startV = 0;
  let width = 1;
  el.addEventListener('contextmenu', (e) => {
    if (o.onAlt) {
      e.preventDefault();
      o.onAlt();
      draw();
    }
  });
  el.addEventListener('pointerdown', (e) => {
    if (e.button === 2) return;
    if (e.altKey && o.onAlt) {
      o.onAlt();
      draw();
      return;
    }
    el.focus();
    typed = '';
    dragging = true;
    el.setPointerCapture(e.pointerId);
    const r = el.getBoundingClientRect();
    width = r.width || 1;
    startX = e.clientX;
    o.begin?.();
    // a click jumps to the position; dragging moves from there
    startV = o.min + ((e.clientX - r.left) / width) * span;
    setV(startV);
    startV = o.get();
  });
  el.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const fine = e.shiftKey ? 0.2 : 1;
    setV(startV + ((e.clientX - startX) / width) * span * fine);
  });
  const up = () => {
    if (!dragging) return;
    dragging = false;
    o.end?.();
  };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('dblclick', () => {
    if (o.def === undefined) return;
    o.begin?.();
    setV(o.def);
    o.end?.();
  });
  el.addEventListener('keydown', (e) => {
    const big = e.shiftKey ? 10 : 1;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
      o.begin?.();
      setV(o.get() + step * big);
      o.end?.();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
      o.begin?.();
      setV(o.get() - step * big);
      o.end?.();
    } else if (/^[0-9.\-+]$/.test(e.key)) {
      typed += e.key;
      draw();
    } else if (e.key === 'Backspace' && typed) {
      typed = typed.slice(0, -1);
      draw();
    } else if (e.key === 'Enter' && typed) {
      const n = parseFloat(typed);
      typed = '';
      if (Number.isFinite(n)) {
        o.begin?.();
        setV(o.parse ? o.parse(n) : n);
        o.end?.();
      }
      draw();
    } else if (e.key === 'Escape' && typed) {
      typed = '';
      draw();
    } else return;
    e.preventDefault();
    e.stopPropagation();
  });
  el.addEventListener('blur', () => {
    typed = '';
    draw();
  });
  panel.add(draw);
  return el;
}

/** A labelled control row. */
export function ctl(parent: HTMLElement, name: string, title?: string): { row: HTMLDivElement; name: HTMLDivElement; slot: HTMLDivElement } {
  const row = h('div', 'ctl', parent);
  const n = h('div', 'name', row, name);
  if (title) row.title = title;
  const slot = h('div', '', row);
  return { row, name: n, slot };
}

export interface NumOptions {
  get: () => number;
  set: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  format?: (v: number) => string;
  begin?: () => void;
  end?: () => void;
  width?: number;
  title?: string;
}

/** A number box: drag up/down, arrows, or type. */
export function num(panel: Panel, parent: HTMLElement, o: NumOptions): HTMLDivElement {
  const el = h('div', 'num', parent);
  el.tabIndex = 0;
  if (o.width) el.style.minWidth = cpx(o.width);
  if (o.title) el.title = o.title;
  const step = o.step ?? 1;
  let typed = '';
  const clampV = (v: number) => Math.max(o.min, Math.min(o.max, roundTo(v, step)));
  const draw = () => {
    el.textContent = typed ? typed + '_' : o.format ? o.format(o.get()) : String(o.get());
    el.classList.toggle('editing', !!typed);
  };
  const setV = (v: number) => {
    const c = clampV(v);
    if (c !== o.get()) o.set(c);
    draw();
  };
  let drag = false;
  let y0 = 0;
  let v0 = 0;
  el.addEventListener('pointerdown', (e) => {
    el.focus();
    typed = '';
    drag = true;
    y0 = e.clientY;
    v0 = o.get();
    el.setPointerCapture(e.pointerId);
    o.begin?.();
  });
  el.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const d = Math.round((y0 - e.clientY) / (e.shiftKey ? 8 : 3));
    setV(v0 + d * step);
  });
  const up = () => {
    if (!drag) return;
    drag = false;
    o.end?.();
  };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('keydown', (e) => {
    const big = e.shiftKey ? 10 : 1;
    if (e.key === 'ArrowUp') setV(o.get() + step * big);
    else if (e.key === 'ArrowDown') setV(o.get() - step * big);
    else if (/^[0-9.\-]$/.test(e.key)) {
      typed += e.key;
      draw();
    } else if (e.key === 'Backspace' && typed) {
      typed = typed.slice(0, -1);
      draw();
    } else if (e.key === 'Enter' && typed) {
      const n = parseFloat(typed);
      typed = '';
      if (Number.isFinite(n)) {
        o.begin?.();
        setV(n);
        o.end?.();
      }
      draw();
    } else if (e.key === 'Escape') {
      typed = '';
      draw();
    } else return;
    e.preventDefault();
    e.stopPropagation();
  });
  el.addEventListener('blur', () => {
    typed = '';
    draw();
  });
  panel.add(draw);
  return el;
}

export interface SelectOptions<T> {
  options: () => { value: T; label: string }[];
  get: () => T;
  set: (v: T) => void;
  width?: number;
  title?: string;
}

let openList: HTMLDivElement | null = null;
export function closePopups(): void {
  openList?.remove();
  openList = null;
  document.querySelectorAll('.msel.open').forEach((x) => x.classList.remove('open'));
}

/** A pop-up selector (the Macintosh pop-up menu). */
export function select<T>(panel: Panel, parent: HTMLElement, o: SelectOptions<T>): HTMLDivElement {
  const el = h('div', 'msel', parent);
  el.tabIndex = 0;
  if (o.width) el.style.minWidth = cpx(o.width);
  if (o.title) el.title = o.title;
  const draw = () => {
    const v = o.get();
    el.textContent = o.options().find((x) => x.value === v)?.label ?? '—';
  };
  const open = () => {
    closePopups();
    const list = h('div', 'msel-list', document.body);
    const r = el.getBoundingClientRect();
    list.style.left = r.left + 'px';
    list.style.top = r.bottom + 2 + 'px';
    list.style.minWidth = r.width + 'px';
    const cur = o.get();
    for (const opt of o.options()) {
      const it = h('div', 'msel-item' + (opt.value === cur ? ' checked' : ''), list, opt.label);
      it.addEventListener('pointerup', (e) => {
        e.stopPropagation();
        closePopups();
        o.set(opt.value);
        draw();
      });
    }
    // keep inside the window: open upwards when there is no room below, shift left at the edge
    const lr = list.getBoundingClientRect();
    if (lr.bottom > window.innerHeight - 4) list.style.top = Math.max(4, r.top - lr.height - 2) + 'px';
    if (lr.right > window.innerWidth - 4) list.style.left = Math.max(4, window.innerWidth - 4 - lr.width) + 'px';
    el.classList.add('open');
    openList = list;
  };
  el.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    if (openList && el.classList.contains('open')) closePopups();
    else open();
  });
  el.addEventListener('keydown', (e) => {
    const opts = o.options();
    const i = opts.findIndex((x) => x.value === o.get());
    if (e.key === 'ArrowDown' && i < opts.length - 1) o.set(opts[i + 1]!.value);
    else if (e.key === 'ArrowUp' && i > 0) o.set(opts[i - 1]!.value);
    else if (e.key === 'Enter' || e.key === ' ') open();
    else return;
    e.preventDefault();
    e.stopPropagation();
    draw();
  });
  panel.add(draw);
  return el;
}

/** A group frame with an inverted title tab. */
export function group(parent: HTMLElement, title: string, cls = ''): HTMLDivElement {
  const g = h('div', 'group ' + cls, parent);
  h('div', 'gtitle', g, title);
  return g;
}

/** A vertical fader (mixer). */
export function vfader(panel: Panel, parent: HTMLElement, o: { get: () => number; set: (v: number) => void; begin?: () => void; end?: () => void; height: number; def?: number; title?: string }): HTMLDivElement {
  const el = h('div', 'vfader', parent);
  el.style.height = cpx(o.height);
  el.tabIndex = 0;
  if (o.title) el.title = o.title;
  const fill = h('div', 'fill', el);
  const cap = h('div', 'cap', el);
  const draw = () => {
    const v = Math.max(0, Math.min(1, o.get()));
    fill.style.height = v * 100 + '%';
    cap.style.bottom = `calc(${v * 100}% - 2px)`;
  };
  let drag = false;
  let y0 = 0;
  let v0 = 0;
  let hgt = 1;
  el.addEventListener('pointerdown', (e) => {
    el.focus();
    drag = true;
    const r = el.getBoundingClientRect();
    hgt = r.height || 1;
    el.setPointerCapture(e.pointerId);
    o.begin?.();
    v0 = 1 - (e.clientY - r.top) / hgt;
    y0 = e.clientY;
    o.set(Math.max(0, Math.min(1, v0)));
    v0 = o.get();
    draw();
  });
  el.addEventListener('pointermove', (e) => {
    if (!drag) return;
    o.set(Math.max(0, Math.min(1, v0 + ((y0 - e.clientY) / hgt) * (e.shiftKey ? 0.2 : 1))));
    draw();
  });
  const up = () => {
    if (drag) o.end?.();
    drag = false;
  };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('dblclick', () => {
    if (o.def === undefined) return;
    o.begin?.();
    o.set(o.def);
    o.end?.();
    draw();
  });
  el.addEventListener('keydown', (e) => {
    const d = e.shiftKey ? 0.1 : 0.01;
    if (e.key === 'ArrowUp') o.set(Math.min(1, o.get() + d));
    else if (e.key === 'ArrowDown') o.set(Math.max(0, o.get() - d));
    else return;
    e.preventDefault();
    e.stopPropagation();
    draw();
  });
  panel.add(draw);
  return el;
}

/** Trigger a download of bytes. */
export function download(name: string, data: Uint8Array, type: string): void {
  const url = URL.createObjectURL(new Blob([data as Uint8Array<ArrayBuffer>], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/** A message that stays until it is dismissed (errors) or for a few seconds (information). */
export function toast(text: string, level: 'info' | 'error'): void {
  let host = document.getElementById('toasts');
  if (!host) {
    host = h('div', '', document.body);
    host.id = 'toasts';
    host.setAttribute('role', 'status');
    host.setAttribute('aria-live', 'polite');
  }
  const t = h('div', 'toast ' + level, host, text);
  t.dataset.test = 'toast-' + level;
  if (level === 'error') t.setAttribute('role', 'alert');
  const close = () => t.remove();
  t.addEventListener('click', close);
  t.title = 'Click to dismiss';
  if (level === 'info') setTimeout(close, 5000);
  while (host.children.length > 4) host.firstElementChild?.remove();
}

/** Ask the browser for files. */
export function chooseFiles(accept: string, multiple = false): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.style.display = 'none';
    input.addEventListener('change', () => {
      resolve([...(input.files ?? [])]);
      input.remove();
    });
    input.addEventListener('cancel', () => {
      resolve([]);
      input.remove();
    });
    document.body.appendChild(input);
    input.click();
  });
}

/** Ask the browser for a folder; every file in it (and below) comes back with its relative path. */
export function chooseFolder(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.setAttribute('webkitdirectory', '');
    input.multiple = true;
    input.style.display = 'none';
    input.addEventListener('change', () => {
      resolve([...(input.files ?? [])]);
      input.remove();
    });
    input.addEventListener('cancel', () => {
      resolve([]);
      input.remove();
    });
    document.body.appendChild(input);
    input.click();
  });
}

export const pct = (v: number): string => Math.round(v * 100) + '%';
