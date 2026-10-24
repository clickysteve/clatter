/**
 * The transport window: shared by every view (one transport, one state).
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import type { App } from '../../app/app';
import { button, h, num, Panel, select, win } from '../widgets';

export function transportWindow(app: App, screen: HTMLElement): { panel: Panel; meters: (l: number, r: number, clip: boolean) => void; rebuildPatterns: () => void } {
  const w = win(screen, { x: 8, y: 22, w: 1264, h: 50, title: 'CLATTER', area: 'transport', id: 'transport' });
  const panel = new Panel();
  const row = h('div', 'row', w.body);
  row.style.gap = '6px';
  button(panel, row, '▶ PLAY', () => void app.play(), { on: () => app.ui.playing, title: 'Play (space)' }).dataset.test = 'play';
  button(panel, row, '■ STOP', () => app.stop(), { title: 'Stop (space, esc)' }).dataset.test = 'stop';
  h('div', 'lbl', row, 'BPM');
  num(panel, row, { get: () => app.project.tempo, set: (v) => app.setTempo(v), min: 30, max: 300, step: 1, width: 44, title: 'Tempo (drag, or click and type)' }).dataset.test = 'bpm';
  h('div', 'lbl', row, 'SWING');
  num(panel, row, { get: () => app.project.swing, set: (v) => app.setSwing(v), min: 50, max: 75, format: (v) => v + '%', width: 40, title: 'Swing of the off-sixteenths' });
  h('div', 'lbl', row, '·');
  const pats = h('div', 'row', row);
  pats.style.gap = '2px';
  const patPanel = new Panel();
  const rebuildPatterns = () => {
    patPanel.clear();
    pats.innerHTML = '';
    for (const p of app.project.patterns) {
      const b = button(patPanel, pats, p.name, () => app.selectPattern(p.id), { on: () => app.project.current === p.id, queued: () => app.ui.queued === p.id, title: `Pattern ${p.name} (${p.steps} steps)` });
      b.style.minWidth = '20px';
    }
    button(patPanel, pats, '+', () => app.addPattern(false), { cls: 'small', title: 'New generated pattern' });
    button(patPanel, pats, 'DUP', () => app.addPattern(true), { cls: 'small', title: 'Duplicate this pattern' });
    button(patPanel, pats, 'DEL', () => app.deletePattern(app.project.current), { cls: 'small', title: 'Delete this pattern', disabled: () => app.project.patterns.length < 2 });
  };
  rebuildPatterns();
  panel.add(() => patPanel.refresh());
  button(panel, row, 'CHAIN', () => app.setChain(!app.project.chain.on), { on: () => app.project.chain.on, title: 'Play the patterns in a chain (each twice by default)' });
  h('div', 'lbl', row, 'QUANT');
  select(panel, row, {
    options: () => (['step', 'beat', 'bar', 'pattern'] as const).map((q) => ({ value: q, label: q.toUpperCase() })),
    get: () => app.project.quantize,
    set: (q) => app.setQuantize(q),
    title: 'Where PERFORM actions land',
  });
  const spacer = h('div', 'grow', row);
  void spacer;
  for (const [v, label] of [
    ['pattern', 'PATTERN'],
    ['sound', 'SOUND'],
    ['perform', 'PERFORM'],
  ] as const) {
    button(panel, row, label, () => app.setView(v), { on: () => app.ui.view === v, title: `${label} view` }).dataset.test = 'view-' + v;
  }
  h('div', 'lbl', row, '·');
  button(panel, row, 'UNDO', () => app.undo(), { disabled: () => !app.history.canUndo, title: 'Undo (⌘Z)' });
  button(panel, row, 'REDO', () => app.redo(), { disabled: () => !app.history.canRedo, title: 'Redo (⇧⌘Z)' });
  const mbox = h('div', 'col', row);
  mbox.style.gap = '1px';
  const mL = h('div', 'meter h', mbox);
  const mR = h('div', 'meter h', mbox);
  for (const m of [mL, mR]) Object.assign(m.style, { width: '70px', height: '6px' });
  const lL = h('div', 'lvl', mL);
  const lR = h('div', 'lvl', mR);
  const clipLed = h('div', 'led', row);
  clipLed.title = 'Clip: the master went over 0 dBFS (the soft clipper caught it)';
  button(panel, row, 'PANIC', () => app.panic(), { title: 'All sound and MIDI notes off now' });
  panel.add(() => {
    w.info.textContent = `${app.project.name} · ${app.pattern.name} ${app.pattern.steps} STEPS · ${app.ui.playing ? 'PLAYING' : 'STOPPED'}${app.ui.queued ? ' · NEXT ' + (app.project.patterns.find((p) => p.id === app.ui.queued)?.name ?? '') : ''}`;
  });
  let clipHold = 0;
  return {
    panel,
    rebuildPatterns,
    meters: (l, r, clip) => {
      const db = (x: number) => Math.max(0, Math.min(1, 1 + (20 * Math.log10(Math.max(1e-6, x))) / 48));
      lL.style.width = db(l) * 100 + '%';
      lR.style.width = db(r) * 100 + '%';
      if (clip) clipHold = 40;
      clipLed.classList.toggle('on', clipHold-- > 0);
    },
  };
}
