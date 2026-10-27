/**
 * The TRIGGER tab of the PATTERN workspace: whether the selected step plays. A condition decides
 * (a share of the passes, every Nth, first or last, odd or even, fill, the step before it), and
 * only a step that plays goes on to its sound. The tab edits the selected step (or every hit of
 * the selected region), lets you look at any pass of the pattern in the grid, and lists every
 * conditional step of the pattern so none hides.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import type { App } from '../../app/app';
import type { TrigCond } from '../../model/types';
import { defaultTrig, describeTrig, TRIG_HELP, TRIG_KINDS, TRIG_LABEL } from '../../rhythm/trigger';
import { randomSeedPhrase } from '../../rhythm/seed';
import { seedField } from '../seedField';
import { button, group, h, num, Panel, range, select } from '../widgets';

const QUICK: { label: string; cond: TrigCond; title: string }[] = [
  { label: 'ALWAYS', cond: { k: 'always' }, title: 'Plays every pass' },
  { label: '50%', cond: { k: 'prob', p: 50 }, title: 'Plays half the passes, chosen by the seed' },
  { label: 'ODD', cond: { k: 'odd' }, title: 'Passes 1, 3, 5 ...' },
  { label: 'EVEN', cond: { k: 'even' }, title: 'Passes 2, 4, 6 ...' },
  { label: 'EVERY 4', cond: { k: 'every', n: 4, at: 4 }, title: 'The 4th pass of every 4' },
  { label: 'FIRST', cond: { k: 'first' }, title: 'The first pass only' },
  { label: 'LAST', cond: { k: 'last' }, title: 'The final pass (when the length is known: exports)' },
  { label: 'FILL', cond: { k: 'fill' }, title: 'Only while a FILL is held' },
];

export function triggerEditor(app: App, pane: HTMLElement, panel: Panel): void {
  const cell = () => app.cursorCell();
  const track = () => {
    const c = cell();
    return c ? app.project.tracks.find((x) => x.id === c.track) : undefined;
  };
  const cond = (): TrigCond => {
    const c = cell();
    return (c && app.stepTrig(c.track, c.step)) || { k: 'always' };
  };
  const set = (c: TrigCond) => app.setStepTrigger(c.k === 'always' ? undefined : c);

  // ---------------------------------------------------------------- the step
  const card = h('div', 'wscard col', pane);
  card.dataset.test = 'step-trigger';
  const where = h('div', '', card);
  panel.add(() => {
    const c = cell();
    const t = track();
    if (!c || !t) return (where.textContent = 'NO STEP SELECTED: CLICK A STEP IN THE GRID');
    const hit = app.hitAt(c.track, c.step);
    const n = app.trigTargets().length;
    where.textContent = `${t.name} · STEP ${c.step + 1}${hit ? '' : ' · NO HIT: A CONDITION ONLY MATTERS ONCE THERE IS ONE'}${n > 1 ? ` · EDITS APPLY TO ${n} SELECTED HITS` : ''}`;
  });
  const body = h('div', 'col', card);
  panel.add(() => (body.style.display = cell() ? '' : 'none'));

  const kr = h('div', 'row wrap condedit', body);
  h('div', 'lbl', kr, 'PLAYS');
  select<TrigCond['k']>(panel, kr, {
    options: () => TRIG_KINDS.map((k) => ({ value: k, label: TRIG_LABEL[k] })),
    get: () => cond().k,
    set: (k) => set(k === cond().k ? cond() : defaultTrig(k)),
    title: 'When the step plays',
  }).dataset.test = 'trig-kind';
  const prob = range(panel, kr, {
    get: () => {
      const c = cond();
      return c.k === 'prob' ? c.p : 50;
    },
    set: (p) => set({ k: 'prob', p }),
    min: 0,
    max: 100,
    def: 50,
    format: (v) => v + '%',
    begin: () => app.beginDrag('TRIGGER CONDITION'),
    end: () => app.endDrag(),
    title: 'The share of the passes the step plays (seeded: the same project always makes the same choices)',
    width: 130,
  });
  prob.dataset.test = 'trig-prob';
  const every = h('div', 'row', kr);
  h('div', 'lbl', every, 'EVERY');
  num(panel, every, {
    get: () => {
      const c = cond();
      return c.k === 'every' ? c.n : 4;
    },
    set: (n) => {
      const c = cond();
      set({ k: 'every', n, at: c.k === 'every' ? Math.min(c.at, n) : n });
    },
    min: 2,
    max: 16,
    title: 'The length of the cycle in passes',
  }).dataset.test = 'trig-n';
  h('div', 'lbl', every, 'ON');
  num(panel, every, {
    get: () => {
      const c = cond();
      return c.k === 'every' ? c.at : 4;
    },
    set: (at) => {
      const c = cond();
      set({ k: 'every', n: c.k === 'every' ? c.n : 4, at });
    },
    min: 1,
    max: 16,
    title: 'Which pass of the cycle it plays on (EVERY 4 ON 4 is the 4th, 8th, 12th ...)',
  }).dataset.test = 'trig-at';
  const alt = h('div', 'row', kr);
  h('div', 'lbl', alt, 'RUN');
  num(panel, alt, {
    get: () => {
      const c = cond();
      return c.k === 'alt' ? c.run : 2;
    },
    set: (run) => set({ k: 'alt', run }),
    min: 1,
    max: 8,
    format: (v) => v + ' PASSES',
    title: 'Passes on, then the same number off',
  }).dataset.test = 'trig-run';
  panel.add(() => {
    const k = cond().k;
    prob.style.display = k === 'prob' ? '' : 'none';
    every.style.display = k === 'every' ? '' : 'none';
    alt.style.display = k === 'alt' ? '' : 'none';
  });
  const help = h('div', 'hint', body);
  panel.add(() => (help.textContent = TRIG_HELP[cond().k].toUpperCase()));

  const qr = h('div', 'row wrap', body);
  for (const q of QUICK) button(panel, qr, q.label, () => set(q.cond), { cls: 'grow', on: () => cond().k === q.cond.k && (q.cond.k !== 'prob' || (cond() as { p: number }).p === (q.cond as { p: number }).p), title: q.title }).dataset.test = 'trig-quick-' + q.label.toLowerCase().replace(/\W+/g, '-');
  const pr = h('div', 'row wrap', body);
  button(panel, pr, '+ IF PREVIOUS PLAYED', () => set({ k: 'prev' }), { cls: 'grow', on: () => cond().k === 'prev', title: TRIG_HELP.prev });
  button(panel, pr, '+ IF PREVIOUS DID NOT PLAY', () => set({ k: 'noprev' }), { cls: 'grow', on: () => cond().k === 'noprev', title: TRIG_HELP.noprev });
  button(panel, pr, 'NOT FILL', () => set({ k: 'nofill' }), { cls: 'grow', on: () => cond().k === 'nofill', title: TRIG_HELP.nofill });

  // ---------------------------------------------------------------- the pass on show
  const pc = h('div', 'wscard col', pane);
  const pg = group(pc, 'PASS ON SHOW');
  pg.classList.add('col');
  const prow = h('div', 'row wrap', pg);
  h('div', 'lbl', prow, 'PASS');
  num(panel, prow, {
    get: () => app.ui.previewPass,
    set: (v) => (app.setPreviewPass(v), panel.refresh()),
    min: 1,
    max: 64,
    title: 'Which pass of the pattern the grid shows while stopped: conditional steps that do not play on it are outlined',
  }).dataset.test = 'trig-pass';
  button(panel, prow, '◀', () => app.setPreviewPass(app.ui.previewPass - 1), { cls: 'small', title: 'The pass before' });
  button(panel, prow, '▶', () => app.setPreviewPass(app.ui.previewPass + 1), { cls: 'small', title: 'The next pass' });
  const pnote = h('div', 'hint', pg);
  panel.add(() => {
    pnote.textContent = app.ui.playing
      ? 'PLAYING: THE GRID FOLLOWS THE PASS THAT IS SOUNDING. LAST CYCLE NEEDS A KNOWN LENGTH, SO IT PLAYS IN AN EXPORT, NOT LIVE.'
      : 'THE GRID SHOWS THIS PASS WHILE STOPPED. PASSES COUNT FROM THE START OF THE PATTERN: A DIFFERENT PATTERN STARTS AT 1 AGAIN.';
  });
  const sr = h('div', 'row', pg);
  h('div', 'lbl', sr, 'SEED').title = 'The project seed: the same seed, pattern and settings make the same choices in every conditional step, probability, fill and export';
  const ps = h('div', 'grow', sr);
  seedField(panel, ps, {
    get: () => ({ seed: app.project.seed, ...(app.project.seedText ? { text: app.project.seedText } : {}) }),
    onInput: (text) => app.setProjectSeed(text),
    onRoll: () => app.setProjectSeed(randomSeedPhrase()),
    onClear: () => app.resetProjectSeed(),
    title: 'The seed of every conditional step, step-sound probability and fill. Changing it changes which steps play, so pick one that sounds right and keep it.',
    test: 'project-seed',
  });
  const cr = h('div', 'row wrap', pg);
  button(panel, cr, 'CLEAR THIS TRACK', () => app.clearTriggers(false), { cls: 'grow', disabled: () => !Object.keys(app.pattern.trig?.[app.ui.track] ?? {}).length, title: 'Every step of the selected track plays on every pass again' }).dataset.test = 'trig-clear-track';
  button(panel, cr, 'CLEAR ALL', () => app.clearTriggers(true), { cls: 'grow', disabled: () => !app.pattern.trig, title: 'Every step of the pattern plays on every pass again (undo brings them back)' }).dataset.test = 'trig-clear-all';

  // ---------------------------------------------------------------- every conditional step
  const lc = h('div', 'wscard col', pane);
  const lg = group(lc, 'CONDITIONAL STEPS');
  lg.classList.add('col');
  const list = h('div', 'col trig-list', lg);
  list.dataset.test = 'trig-list';
  let sig = '';
  panel.add(() => {
    const rows: { track: string; name: string; step: number; c: TrigCond }[] = [];
    for (const t of app.project.tracks) {
      for (const [k, c] of Object.entries(app.pattern.trig?.[t.id] ?? {})) rows.push({ track: t.id, name: t.name, step: Number(k), c });
    }
    rows.sort((a, b) => a.step - b.step || a.name.localeCompare(b.name));
    const next = JSON.stringify(rows);
    if (next === sig) return;
    sig = next;
    list.innerHTML = '';
    if (!rows.length) {
      h('div', 'hint', list, 'NONE: EVERY STEP PLAYS ON EVERY PASS');
      return;
    }
    for (const r of rows) {
      const row = h('div', 'row trig-row', list, `${r.name} · STEP ${r.step + 1} · ${describeTrig(r.c)}`);
      row.tabIndex = 0;
      row.style.cursor = 'pointer';
      row.title = 'Select this step';
      row.dataset.test = 'trig-row';
      const pick = () => {
        app.selectTrack(r.track);
        app.setCursor({ track: r.track, step: r.step });
      };
      row.addEventListener('click', pick);
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          pick();
        }
      });
    }
  });
}
