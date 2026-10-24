/**
 * The transport: shared by every view (one transport, one state). A bar of play, tempo, pattern
 * selection and undo. The view tabs sit in the menu bar above it. Both stay on screen.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import type { App } from '../../app/app';
import { button, h, num, Panel, select } from '../widgets';
import { cpx } from '../scale';

export function transportWindow(app: App, chrome: HTMLElement, menubar: HTMLElement): { panel: Panel; meters: (l: number, r: number, clip: boolean) => void; rebuildPatterns: () => void } {
  const bar = h('div', 'bar', chrome);
  bar.id = 'transport';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Transport');
  const panel = new Panel();

  // play and tempo
  const play = h('div', 'cluster', bar);
  button(panel, play, '▶ PLAY', () => void app.play(), { on: () => app.ui.playing, title: 'Play (space)' }).dataset.test = 'play';
  button(panel, play, '■ STOP', () => app.stop(), { title: 'Stop (space, esc)' }).dataset.test = 'stop';
  h('div', 'lbl', play, 'BPM');
  num(panel, play, { get: () => app.project.tempo, set: (v) => app.setTempo(v), min: 30, max: 300, step: 1, title: 'Tempo (drag, or click and type)' }).dataset.test = 'bpm';
  h('div', 'lbl', play, 'SWING');
  num(panel, play, { get: () => app.project.swing, set: (v) => app.setSwing(v), min: 50, max: 75, format: (v) => v + '%', title: 'Swing of the off-sixteenths' });

  // patterns
  h('div', 'sep', bar);
  const patterns = h('div', 'cluster', bar);
  const pats = h('div', 'row', patterns);
  pats.style.gap = cpx(4);
  const patPanel = new Panel();
  const rebuildPatterns = () => {
    patPanel.clear();
    pats.innerHTML = '';
    for (const p of app.project.patterns) {
      button(patPanel, pats, p.name, () => app.selectPattern(p.id), { on: () => app.project.current === p.id, queued: () => app.ui.queued === p.id, title: `Pattern ${p.name} (${p.steps} steps)` });
    }
    button(patPanel, pats, '+', () => app.addPattern(false), { title: 'New generated pattern' });
    button(patPanel, pats, 'DUP', () => app.addPattern(true), { title: 'Duplicate this pattern' });
    button(patPanel, pats, 'DEL', () => app.deletePattern(app.project.current), { title: 'Delete this pattern', disabled: () => app.project.patterns.length < 2 });
  };
  rebuildPatterns();
  panel.add(() => patPanel.refresh());
  button(panel, patterns, 'CHAIN', () => app.setChain(!app.project.chain.on), { on: () => app.project.chain.on, title: 'Play the patterns in a chain (each twice by default)' });
  h('div', 'lbl', patterns, 'QUANT');
  select(panel, patterns, {
    options: () => (['step', 'beat', 'bar', 'pattern'] as const).map((q) => ({ value: q, label: q.toUpperCase() })),
    get: () => app.project.quantize,
    set: (q) => app.setQuantize(q),
    title: 'Where PERFORM actions land',
  });

  // history, level and panic
  const end = h('div', 'cluster end', bar);
  button(panel, end, 'UNDO', () => app.undo(), { disabled: () => !app.history.canUndo, title: 'Undo (⌘Z)' });
  button(panel, end, 'REDO', () => app.redo(), { disabled: () => !app.history.canRedo, title: 'Redo (⇧⌘Z)' });
  const mbox = h('div', 'col meterbox', end);
  mbox.style.gap = cpx(3);
  const mL = h('div', 'meter h', mbox);
  const mR = h('div', 'meter h', mbox);
  for (const m of [mL, mR]) Object.assign(m.style, { width: cpx(84), height: cpx(10) });
  const lL = h('div', 'lvl', mL);
  const lR = h('div', 'lvl', mR);
  const clipLed = h('div', 'led', end);
  clipLed.title = 'Clip: the master went over 0 dBFS (the soft clipper caught it)';
  button(panel, end, 'PANIC', () => app.panic(), { title: 'All sound and MIDI notes off now' });

  // the view tabs, in the menu bar between the menus and the status
  const tabs = h('div', '', menubar);
  menubar.insertBefore(tabs, menubar.querySelector('.status'));
  tabs.id = 'viewtabs';
  tabs.setAttribute('role', 'tablist');
  for (const [v, label, key] of [
    ['pattern', 'PATTERN', '1'],
    ['sound', 'SOUND', '2'],
    ['perform', 'PERFORM', '3'],
  ] as const) {
    const tab = h('div', 'tab', tabs, label);
    tab.setAttribute('role', 'tab');
    tab.tabIndex = 0;
    tab.title = `${label} view (${key})`;
    h('span', 'key', tab, key);
    tab.dataset.test = 'view-' + v;
    tab.addEventListener('click', () => app.setView(v));
    tab.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') app.setView(v);
    });
    panel.add(() => {
      tab.classList.toggle('on', app.ui.view === v);
      tab.setAttribute('aria-selected', String(app.ui.view === v));
    });
  }
  const info = h('div', 'info', tabs);
  panel.add(() => {
    info.textContent = `${app.project.name} · PATTERN ${app.pattern.name} · ${app.pattern.steps} STEPS · ${app.ui.playing ? 'PLAYING' : 'STOPPED'}${app.ui.queued ? ' · NEXT ' + (app.project.patterns.find((p) => p.id === app.ui.queued)?.name ?? '') : ''}`;
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
