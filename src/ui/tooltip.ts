/**
 * Tooltips in the interface's own style. Every element with a `title` gets one, after a short
 * delay (the browser's own tooltip is suppressed by moving the title into `data-tip`); the pattern
 * grid shows richer ones for the cell under the pointer (`showTip`). A tooltip is never the only
 * way to learn something basic: the grid's footer and the step editor say the same things.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import { h } from './widgets';

let tip: HTMLDivElement | null = null;
let timer = 0;
let current: HTMLElement | null = null;

export interface TipContent {
  /** the heading (pixel face) */
  head?: string;
  /** lines of text; a leading "**" marks a line as emphasised */
  lines: string[];
}

export function hideTip(): void {
  clearTimeout(timer);
  tip?.remove();
  tip = null;
  current = null;
}

/** Show a tooltip near a point (client pixels); it stays inside the window. */
export function showTip(x: number, y: number, c: TipContent): void {
  tip?.remove();
  tip = h('div', 'mtip', document.body);
  if (c.head) h('div', 'th', tip, c.head);
  for (const l of c.lines) {
    const d = h('div', 'tl', tip);
    if (l.startsWith('**')) {
      h('b', '', d, l.slice(2));
    } else d.textContent = l;
  }
  const r = tip.getBoundingClientRect();
  let left = x + 14;
  let top = y + 18;
  if (left + r.width > window.innerWidth - 6) left = Math.max(6, x - r.width - 14);
  if (top + r.height > window.innerHeight - 6) top = Math.max(6, y - r.height - 14);
  tip.style.left = left + 'px';
  tip.style.top = top + 'px';
}

/** Turn every `title` in the document into an in-style tooltip. */
export function installTooltips(): void {
  document.addEventListener('pointerover', (e) => {
    const target = e.target instanceof Element ? e.target : null;
    const t = target?.closest<HTMLElement>('[title],[data-tip]') ?? null;
    if (!t || t === current) return;
    const title = t.getAttribute('title');
    if (title) {
      t.dataset.tip = title;
      // the native tooltip goes, the accessible name stays
      if (!t.hasAttribute('aria-label') && !t.textContent?.trim()) t.setAttribute('aria-label', title);
      t.removeAttribute('title');
    }
    const text = t.dataset.tip;
    if (!text) return;
    hideTip();
    current = t;
    const x = e.clientX;
    const y = e.clientY;
    timer = window.setTimeout(() => showTip(x, y, { lines: [text] }), 450);
  });
  document.addEventListener('pointerout', (e) => {
    if (current && !current.contains(e.relatedTarget as Node | null)) hideTip();
  });
  document.addEventListener('pointerdown', hideTip, true);
  window.addEventListener('blur', hideTip);
  window.addEventListener('scroll', hideTip, true);
}
