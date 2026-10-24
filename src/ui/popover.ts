/**
 * A small floating panel next to the pointer (the step editor opened by a right-click on a cell).
 * One at a time; Escape, a press outside it or scrolling closes it.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import { h } from './widgets';

let open: { el: HTMLDivElement; off: () => void } | null = null;

export function popoverOpen(): boolean {
  return !!open;
}

export function closePopover(): void {
  open?.off();
  open?.el.remove();
  open = null;
}

/** Open a popover near (x, y); `build` fills its body. */
export function openPopover(x: number, y: number, title: string, build: (body: HTMLDivElement) => void): HTMLDivElement {
  closePopover();
  const el = h('div', 'popover', document.body);
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', title);
  const head = h('div', 'phead', el);
  h('div', 'grow', head, title);
  const x1 = h('button', 'btn small', head, '×');
  x1.title = 'Close (Esc)';
  x1.addEventListener('click', closePopover);
  const body = h('div', 'col', el);
  build(body);
  const r = el.getBoundingClientRect();
  el.style.left = Math.max(8, Math.min(x + 14, window.innerWidth - r.width - 8)) + 'px';
  el.style.top = Math.max(8, Math.min(y + 14, window.innerHeight - r.height - 8)) + 'px';
  const down = (e: PointerEvent) => {
    if (!el.contains(e.target as Node) && !(e.target as HTMLElement).closest?.('.msel-list')) closePopover();
  };
  const scroll = (e: Event) => {
    if (!el.contains(e.target as Node)) closePopover();
  };
  // after this event: the press that opened it must not close it
  setTimeout(() => {
    if (open?.el !== el) return;
    document.addEventListener('pointerdown', down, true);
    window.addEventListener('scroll', scroll, true);
  });
  open = {
    el,
    off: () => {
      document.removeEventListener('pointerdown', down, true);
      window.removeEventListener('scroll', scroll, true);
    },
  };
  return el;
}
