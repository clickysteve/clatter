/**
 * The WILDCARD tab of the PATTERN workspace: one press re-imagines the instrument. INTENSITY says
 * how far, SCOPE says how much of the instrument, the categories say which kinds of thing, and
 * the SEED makes a result reproducible. One undo step takes the whole thing back, tempo included.
 * Below it, the tempo curve WILDCARD (or you) made, so tempo changes over time are visible and
 * can be switched off.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import type { App } from '../../app/app';
import { CAT_HELP, CAT_LABEL, SCOPE_HELP, SCOPE_LABEL, WILD_CATS, WILD_SCOPES, wildAffects } from '../../destruction/wildcardProject';
import { bpmAt, tempoActive } from '../../transport/tempo';
import { button, group, h, num, Panel, range } from '../widgets';

const feel = (i: number): string => (i < 15 ? 'A NUDGE' : i < 35 ? 'SUBTLE' : i < 60 ? 'ADVENTUROUS' : i < 85 ? 'WILD' : 'UNHINGED');

export function wildcardPane(app: App, pane: HTMLElement, panel: Panel): void {
  const w = () => app.prefs.wildcard;

  // ---------------------------------------------------------------- the press
  const card = h('div', 'wscard col', pane);
  card.dataset.test = 'wildcard-card';
  const top = h('div', 'row wrap', card);
  const go = button(panel, top, 'WILDCARD', () => app.wildcard(), { cls: 'med grow', title: 'Re-imagine the instrument within the scope and intensity below (W). One undo step.' });
  go.dataset.test = 'wildcard-go';
  go.style.flex = '2';
  button(panel, top, 'TRY ANOTHER', () => app.wildcardAgain(), { cls: 'med grow', disabled: () => app.history.undoLabel !== 'WILDCARD', title: 'Take the last WILDCARD back and try another seed' }).dataset.test = 'wildcard-again';
  button(panel, top, 'UNDO', () => app.undo(), { cls: 'med', disabled: () => !app.history.canUndo, title: 'Undo (⌘Z): one step takes the whole WILDCARD back, tempo included' });

  const ir = h('div', 'row', card);
  h('div', 'lbl', ir, 'INTENSITY').title = 'How far it goes: a nudge at the bottom, almost anything at the top';
  const inten = range(panel, ir, {
    get: () => w().intensity,
    set: (v) => app.setWildcard({ intensity: v }),
    min: 0,
    max: 100,
    def: 50,
    format: (v) => v + '%',
    title: 'How far it goes. At 10% a few hits move and the tempo drifts a little; at 100% almost everything in scope can change a lot. Values always stay inside their legal range.',
    width: 220,
  });
  inten.dataset.test = 'wildcard-intensity';
  const feelEl = h('div', 'hint', ir);
  panel.add(() => (feelEl.textContent = feel(w().intensity)));

  const sr = h('div', 'row wrap', card);
  h('div', 'lbl', sr, 'SCOPE').title = 'How much of the instrument it may change';
  const seg = h('div', 'seg', sr);
  seg.dataset.test = 'wildcard-scope';
  for (const sc of WILD_SCOPES) button(panel, seg, SCOPE_LABEL[sc], () => app.setWildcard({ scope: sc }), { on: () => w().scope === sc, title: SCOPE_HELP[sc] }).dataset.test = 'wildcard-scope-' + sc;
  const scopeHelp = h('div', 'hint', card);
  panel.add(() => (scopeHelp.textContent = SCOPE_HELP[w().scope].toUpperCase()));

  const cr = h('div', 'row wrap', card);
  h('div', 'lbl', cr, 'INCLUDE').title = 'The kinds of change it may make; a category the scope does not reach is dimmed';
  for (const c of WILD_CATS) {
    button(panel, cr, CAT_LABEL[c], () => app.setWildcard({ cats: w().cats.includes(c) ? w().cats.filter((x) => x !== c) : [...w().cats, c] }), {
      on: () => w().cats.includes(c) && wildAffects(w().scope, c),
      disabled: () => !wildAffects(w().scope, c),
      title: `${CAT_LABEL[c]}: ${CAT_HELP[c]}${''}`,
    }).dataset.test = 'wildcard-cat-' + c;
  }

  const sd = h('div', 'row wrap', card);
  h('div', 'lbl', sd, 'SEED').title = 'The same project and seed always make the same WILDCARD: undo, then press again with FIXED SEED on';
  num(panel, sd, { get: () => w().seed, set: (v) => app.setWildcard({ seed: v }), min: 0, max: 4294967295, title: 'The seed of the last press. Type one to reproduce a result.' }).dataset.test = 'wildcard-seed';
  button(panel, sd, 'FIXED SEED', () => app.setWildcard({ fixed: !w().fixed }), { on: () => w().fixed, title: 'On: every press uses this seed (undo, press again: the same result). Off: every press draws a new seed and shows it here.' }).dataset.test = 'wildcard-fixed';
  const rec = h('div', 'hint', sd);
  panel.add(() => {
    const last = app.project.wildcard;
    rec.textContent = last ? `LAST IN THIS PROJECT: SEED ${last.seed} · ${last.intensity}% · ${SCOPE_LABEL[last.scope]}` : '';
  });

  // ---------------------------------------------------------------- the tempo curve
  const tc = h('div', 'wscard col', pane);
  const tg = group(tc, 'TEMPO OVER TIME');
  tg.classList.add('col');
  const line = h('div', '', tg);
  const cv = h('canvas', 'tempocurve', tg) as HTMLCanvasElement;
  cv.dataset.test = 'tempo-curve';
  const css = cv.style;
  css.width = '100%';
  css.height = 'calc(48 * var(--px))';
  css.border = 'var(--u) solid var(--ink)';
  const row = h('div', 'row wrap', tg);
  button(panel, row, 'CURVE ON', () => app.toggleTempoAuto(), { cls: 'grow', on: () => tempoActive(app.project.tempoAuto), disabled: () => !app.project.tempoAuto, label: () => (tempoActive(app.project.tempoAuto) ? 'CURVE ON' : 'CURVE OFF'), title: 'Play the tempo curve (the BPM is scaled by it) or hold the plain BPM' }).dataset.test = 'tempo-toggle';
  button(panel, row, 'CLEAR CURVE', () => app.setTempoAuto(undefined, 'CLEAR TEMPO CURVE'), { cls: 'grow', disabled: () => !app.project.tempoAuto, title: 'Remove the tempo curve' }).dataset.test = 'tempo-clear';
  h('div', 'hint', tg, 'THE CURVE LOOPS UNDER THE PERFORMANCE, SCALES THE BPM, AND IS PLAYED AND EXPORTED EXACTLY AS IT SOUNDS.');

  const draw = () => {
    const a = app.project.tempoAuto;
    const base = app.project.tempo;
    if (!a) {
      line.textContent = `NO TEMPO CURVE: ${base} BPM THROUGHOUT`;
    } else {
      const bars = a.bars;
      const vals = Array.from({ length: 64 }, (_, i) => bpmAt(base, { ...a, on: true }, (i / 64) * bars * 384));
      line.textContent = `${a.on ? '' : 'OFF · '}${bars} BARS · ${a.points.length} POINT${a.points.length === 1 ? '' : 'S'} · ${Math.round(Math.min(...vals))} TO ${Math.round(Math.max(...vals))} BPM`;
    }
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(60, Math.round(cv.clientWidth * dpr));
    const H = Math.max(20, Math.round(cv.clientHeight * dpr));
    if (cv.width !== W) cv.width = W;
    if (cv.height !== H) cv.height = H;
    const g = cv.getContext('2d');
    if (!g) return;
    const cs = getComputedStyle(document.documentElement);
    const ink = cs.getPropertyValue('--ink').trim() || '#000';
    const paper = cs.getPropertyValue('--paper').trim() || '#fff';
    g.fillStyle = paper;
    g.fillRect(0, 0, W, H);
    g.fillStyle = ink;
    g.globalAlpha = 0.3;
    g.fillRect(0, Math.round(H / 2), W, 1);
    g.globalAlpha = 1;
    if (!a) return;
    const pts: number[] = [];
    for (let x = 0; x < W; x++) pts.push(bpmAt(base, { ...a, on: true }, (x / W) * a.bars * 384));
    const lo = Math.min(base, ...pts) * 0.97;
    const hi = Math.max(base, ...pts) * 1.03;
    g.globalAlpha = a.on ? 1 : 0.35;
    g.fillStyle = ink;
    pts.forEach((b, x) => {
      const y = Math.round(H - 3 - ((b - lo) / Math.max(1, hi - lo)) * (H - 6));
      g.fillRect(x, y, 1, 3 * dpr);
    });
    g.globalAlpha = 1;
  };
  panel.add(draw);
}
