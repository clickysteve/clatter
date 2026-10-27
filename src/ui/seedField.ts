/**
 * The seed field: an editable phrase with a dice, COPY, PASTE and CLEAR, used wherever a
 * generator has a seed. It speaks phrases ("velvet-orbit"); a number typed or pasted is a plain
 * number seed (that is how every older project's seeds look). See src/rhythm/seed.ts.
 *
 *   type + Enter   hold this seed: the generator's next press uses it (FIXED)
 *   dice           a new memorable phrase, held the same way
 *   COPY / PASTE   share a seed as text
 *   CLEAR          free again: every press draws a new phrase and shows it here
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import { seedLabel, SEED_TEXT_MAX, type SeedValue } from '../rhythm/seed';
import { button, h, toast, type Panel } from './widgets';

export interface SeedFieldOptions {
  /** the seed shown; null: none yet */
  get: () => SeedValue | null;
  /** whether the generator holds this seed between presses (a FIXED toggle is shown when given) */
  fixed?: () => boolean;
  onFixed?: (on: boolean) => void;
  /** a phrase or number was typed or pasted */
  onInput: (text: string) => void;
  onRoll: () => void;
  onClear: () => void;
  /** shown when there is no seed */
  placeholder?: string;
  title?: string;
  /** data-test prefix */
  test: string;
}

const DIE = `<svg viewBox="0 0 12 12" width="16" height="16" aria-hidden="true"><rect x="0.5" y="0.5" width="11" height="11" fill="none" stroke="currentColor"/><g fill="currentColor"><rect x="2" y="2" width="2" height="2"/><rect x="8" y="2" width="2" height="2"/><rect x="5" y="5" width="2" height="2"/><rect x="2" y="8" width="2" height="2"/><rect x="8" y="8" width="2" height="2"/></g></svg>`;

export function seedField(panel: Panel, parent: HTMLElement, o: SeedFieldOptions): HTMLDivElement {
  const row = h('div', 'row seedfield', parent);
  if (o.title) row.title = o.title;
  const input = h('input', 'num seedin grow', row);
  input.type = 'text';
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.maxLength = SEED_TEXT_MAX + 20;
  input.placeholder = o.placeholder ?? 'NEW PHRASE EACH TIME';
  input.dataset.test = o.test;
  input.setAttribute('aria-label', 'Seed');

  const shown = () => {
    const v = o.get();
    return v ? seedLabel(v) : '';
  };
  let editing = false;
  const draw = () => {
    if (!editing) input.value = shown();
    input.classList.toggle('held', !!o.fixed?.());
  };
  const commit = () => {
    editing = false;
    const t = input.value.trim();
    if (t === shown()) return draw();
    if (t) o.onInput(t);
    else o.onClear();
    draw();
  };
  input.addEventListener('focus', () => input.select());
  input.addEventListener('input', () => (editing = true));
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    e.stopPropagation(); // typing a phrase never plays the keyboard shortcuts
    if (e.key === 'Enter') {
      input.blur();
    } else if (e.key === 'Escape') {
      editing = false;
      draw();
      input.blur();
    }
  });
  panel.add(draw);

  const die = button(panel, row, '', () => o.onRoll(), { cls: 'small seeddie', title: 'A new memorable seed (two words)' });
  die.innerHTML = DIE;
  die.dataset.test = o.test + '-roll';
  die.setAttribute('aria-label', 'New random seed');

  const copy = button(panel, row, 'COPY', async () => {
    const t = shown();
    if (!t) return toast('NO SEED TO COPY YET', 'info');
    try {
      await navigator.clipboard.writeText(t);
      toast('SEED COPIED: ' + t.toUpperCase(), 'info');
    } catch {
      input.focus();
      input.select();
      toast('SELECTED: PRESS ⌘C / CTRL+C TO COPY', 'info');
    }
  }, { cls: 'small', title: 'Copy this seed as text' });
  copy.dataset.test = o.test + '-copy';

  const paste = button(panel, row, 'PASTE', async () => {
    try {
      const t = (await navigator.clipboard.readText()).trim();
      if (!t) return toast('THE CLIPBOARD IS EMPTY', 'info');
      o.onInput(t);
      draw();
    } catch {
      input.focus();
      toast('PRESS ⌘V / CTRL+V, THEN ENTER', 'info');
    }
  }, { cls: 'small', title: 'Use the seed on the clipboard (a phrase, or a number)' });
  paste.dataset.test = o.test + '-paste';

  const clear = button(panel, row, 'CLEAR', () => {
    o.onClear();
    draw();
  }, { cls: 'small', title: 'Clear: every press draws a new seed again', disabled: () => !o.get() && !o.fixed?.() });
  clear.dataset.test = o.test + '-clear';

  if (o.onFixed && o.fixed) {
    const fixed = o.fixed;
    const fx = button(panel, row, 'FIXED', () => o.onFixed!(!fixed()), { cls: 'small', on: fixed, disabled: () => !o.get(), title: 'On: every press uses this seed, so the same settings give the same result. Off: every press draws a new seed and shows it here.' });
    fx.dataset.test = o.test + '-fixed';
  }
  return row;
}
