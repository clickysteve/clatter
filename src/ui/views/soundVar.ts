/**
 * The VARIATIONS tab: the track's base sound beside its four variations (A-D). Each variation
 * inherits everything it does not override (sparse inheritance), so the comparison counts what
 * each one changes (parameters, sample settings, modulation sources and routes) and how the
 * pattern uses it (steps, conditional steps). The generators live here too.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import type { App } from '../../app/app';
import { patchSize } from '../../mod/config';
import { SOURCE_LABEL, type SourceId } from '../../mod/types';
import { SLOT_NAMES, VARIATION_SLOTS, type Track, type Variation } from '../../model/types';
import { formatValue, VOICE_PARAMS, VOICES } from '../../sound/lxrParams';
import { describeCond } from '../../sound/stepSound';
import { button, group, h, Panel } from '../widgets';
import { subscribe } from './patternView';
import { editingText, generativeCard, slotBar, variationTools } from './soundControls';
import type { PaneParts } from './soundUi';

interface Usage {
  /** steps that play this sound outright */
  steps: number;
  /** steps that switch to it while a condition holds */
  cond: number;
}

/** How the open pattern uses each sound of a track: index 0 is the base, 1-4 are A-D. */
export function usageOf(app: App, t: Track): Usage[] {
  const out: Usage[] = Array.from({ length: VARIATION_SLOTS + 1 }, () => ({ steps: 0, cond: 0 }));
  const sounds = app.pattern.sounds?.[t.id] ?? {};
  for (let s = 0; s < app.pattern.steps; s++) {
    if (!app.hitAt(t.id, s)) continue;
    const ss = sounds[s];
    out[(ss?.v ?? -1) + 1]!.steps++;
    if (ss?.alt) out[(ss.alt.v ?? -1) + 1]!.cond++;
  }
  return out;
}

export function overrideCounts(v: Variation | null | undefined): { params: number; sample: number; mod: number } {
  return { params: v ? Object.keys(v.params).length : 0, sample: v ? Object.keys(v.sample ?? {}).length : 0, mod: v ? patchSize(v.mod) : 0 };
}

export function variationsPane(app: App, pane: HTMLElement): PaneParts {
  const vp = new Panel();
  const t = () => app.track;
  const top = h('div', 'col sndtop', pane);
  slotBar(app, h('div', 'row wrap', top), vp);
  variationTools(app, top, vp);
  const mrow = h('div', 'row wrap', top);
  button(vp, mrow, 'MUTATE MODULATION', () => app.ui.slot !== null && app.mutateVariationMod(t().id, app.ui.slot, 0.5), { cls: 'small', disabled: () => app.ui.slot === null || !!t().sound.variations?.[app.ui.slot]?.lock, title: 'Give this variation a related modulation: the base’s, mutated, stored as differences only' }).dataset.test = 'var-mutate-mod';
  button(vp, mrow, 'CLEAR MODULATION', () => app.ui.slot !== null && app.clearVariationMod(t().id, app.ui.slot), { cls: 'small', disabled: () => app.ui.slot === null || !t().sound.variations?.[app.ui.slot]?.mod, title: 'The variation follows the base modulation again' });
  const sinfo = h('div', 'tiny grow', mrow);
  vp.add(() => (sinfo.textContent = editingText(app)));

  const body = h('div', 'varws sndscroll', pane);
  const left = h('div', 'col', body);
  const right = h('div', 'col', body);

  // ---------------------------------------------------------------- BASE against A-D
  const cg = group(left, 'BASE AND VARIATIONS · ' + 'THIS TRACK');
  cg.classList.add('col');
  const title = cg.firstElementChild as HTMLElement | null;
  const tbl = h('table', 'vartable', cg);
  tbl.dataset.test = 'var-table';
  const hd = h('tr', '', h('thead', '', tbl));
  for (const c of ['SOUND', 'PARAMS', 'SAMPLE', 'MOD', 'STEPS', 'COND', '']) h('th', '', hd, c);
  const tb = h('tbody', '', tbl);
  const trs: { tr: HTMLTableRowElement; cells: HTMLElement[] }[] = [];
  for (let i = -1; i < VARIATION_SLOTS; i++) {
    const tr = h('tr', 'varrow', tb);
    tr.dataset.test = 'var-row-' + (i < 0 ? 'BASE' : SLOT_NAMES[i]);
    const cells = Array.from({ length: 6 }, () => h('td', '', tr));
    const act = h('td', 'varact', tr);
    button(vp, act, 'EDIT', () => app.setSlot(i < 0 ? null : i), { cls: 'small', title: 'Edit this sound in the SYNTH, SAMPLE and MODULATION tabs' });
    tr.addEventListener('dblclick', () => {
      app.setSlot(i < 0 ? null : i);
      app.setSoundTab('synth');
    });
    trs.push({ tr, cells });
  }
  vp.add(() => {
    const tr0 = t();
    if (title) title.textContent = `BASE AND VARIATIONS · ${tr0.name}`;
    const use = usageOf(app, tr0);
    const base = tr0.sound.mod ? Object.keys(tr0.sound.mod.sources).length + tr0.sound.mod.routes.length : 0;
    trs.forEach(({ tr, cells }, k) => {
      const slot = k - 1;
      const v = slot < 0 ? null : tr0.sound.variations?.[slot];
      tr.classList.toggle('on', app.ui.slot === (slot < 0 ? null : slot));
      tr.classList.toggle('empty', slot >= 0 && !v);
      const c = overrideCounts(v);
      cells[0]!.textContent = slot < 0 ? 'BASE · THE KIT' : `${SLOT_NAMES[slot]} · ${v ? (v.name || 'UNNAMED') + (v.lock ? ' ◆' : '') : 'EMPTY'}`;
      cells[1]!.textContent = slot < 0 ? '—' : v ? String(c.params) : '·';
      cells[2]!.textContent = slot < 0 ? '—' : v ? String(c.sample) : '·';
      cells[3]!.textContent = slot < 0 ? String(base) + ' SRC+RTE' : v ? String(c.mod) : '·';
      cells[4]!.textContent = String(use[k]!.steps);
      cells[5]!.textContent = String(use[k]!.cond);
    });
  });
  h('div', 'hint', cg, 'A VARIATION FOLLOWS THE BASE EXCEPT WHERE IT OVERRIDES (SPARSE INHERITANCE). PARAMS / SAMPLE / MOD COUNT THE OVERRIDES. STEPS: HITS THAT PLAY THE SOUND. COND: HITS THAT SWITCH TO IT WHILE A CONDITION HOLDS. DOUBLE-CLICK A ROW TO EDIT IT.');

  // ---------------------------------------------------------------- what the open variation changes
  const dg = group(left, 'WHAT THE OPEN SOUND CHANGES');
  dg.classList.add('col');
  const dlist = h('div', 'list difflist', dg);
  dlist.dataset.test = 'var-diff';
  vp.add(() => {
    dlist.innerHTML = '';
    const slot = app.ui.slot;
    if (slot === null) return void h('div', 'li', dlist, 'THE BASE SOUND: SELECT A VARIATION TO SEE HOW IT DIFFERS');
    const v = t().sound.variations?.[slot];
    if (!v) return void h('div', 'li', dlist, 'EMPTY: IT PLAYS THE BASE SOUND UNTIL YOU CHANGE SOMETHING');
    const voice = Math.max(0, app.voiceOf(t()));
    const defs = VOICE_PARAMS[voice] ?? [];
    const rows: string[] = [];
    for (const [k, val] of Object.entries(v.params)) {
      const p = defs.find((x) => x.id === Number(k));
      const base = app.project.kit.synth.params[Number(k)] ?? 0;
      rows.push(p ? `${p.group} ${p.label}: ${formatValue(p, base)} → ${formatValue(p, val)}` : `PARAM ${k}: ${base} → ${val}`);
    }
    for (const [k, val] of Object.entries(v.sample ?? {})) rows.push(`SAMPLE ${k.toUpperCase()}: ${String(val)}`);
    for (const [id, s] of Object.entries(v.mod?.sources ?? {})) rows.push(`MOD ${SOURCE_LABEL[id as SourceId] ?? id}: ${s === null ? 'REMOVED' : Object.keys(s).join(', ').toUpperCase()}`);
    for (const [id, r] of Object.entries(v.mod?.routes ?? {})) rows.push(`MOD ROUTE ${id}: ${r === null ? 'REMOVED' : Object.keys(r).join(', ').toUpperCase()}`);
    if (!rows.length) rows.push('NO OVERRIDES: IT SOUNDS LIKE THE BASE');
    for (const r of rows.slice(0, 60)) h('div', 'li', dlist, r);
    if (rows.length > 60) h('div', 'li', dlist, `… ${rows.length - 60} MORE`);
    h('div', 'tiny', dlist, VOICES[voice]);
  });

  // ---------------------------------------------------------------- conditional steps
  const sg = group(right, 'STEP SOUNDS IN THIS PATTERN');
  sg.classList.add('col');
  const slist = h('div', 'list steplist', sg);
  vp.add(() => {
    slist.innerHTML = '';
    const tr = t();
    const entries = Object.entries(app.pattern.sounds?.[tr.id] ?? {}).sort((a, b) => Number(a[0]) - Number(b[0]));
    if (!entries.length) h('div', 'li', slist, 'NONE: SELECT A STEP AND USE STEP SOUND IN THE PATTERN VIEW, OR GENERATE BELOW');
    for (const [k, ss] of entries) {
      const li = h('div', 'li', slist, `STEP ${Number(k) + 1} · ${app.describeStepSound(tr.id, Number(k))}${ss.alt ? ' · ' + describeCond(ss.alt.cond) : ''}`);
      li.addEventListener('click', () => {
        app.selectTrack(tr.id);
        app.setCursor({ track: tr.id, step: Number(k) });
        app.setView('pattern');
        app.setWorkspace('sound');
      });
    }
  });
  const all = h('div', 'tiny', sg);
  vp.add(() => {
    let steps = 0;
    let cond = 0;
    for (const tr of app.project.tracks) {
      for (const ss of Object.values(app.pattern.sounds?.[tr.id] ?? {})) {
        steps++;
        if (ss.alt) cond++;
      }
    }
    all.textContent = `ALL TRACKS: ${steps} STEP SOUND${steps === 1 ? '' : 'S'}, ${cond} CONDITIONAL`;
  });
  const gg = group(right, 'GENERATE');
  gg.classList.add('col');
  generativeCard(app, gg, vp);

  subscribe(app, ['kit', 'tracks', 'selection', 'pattern', 'project', 'gen', 'mod'], () => vp.refresh());
  return { panels: [vp] };
}
