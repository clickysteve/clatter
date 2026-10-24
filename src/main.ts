/**
 * CLATTER: start-up. Builds the page (menu bar, transport and view tabs above a scrolling work
 * area, laid out in real pixels) and the three views, then boots the application (the LXR
 * engine, the bundled samples, the last session).
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import './ui/style.css';
import { App } from './app/app';
import { loadPrefs } from './app/prefs';
import { closeMenus, menubar } from './ui/menu';
import { applySelectedPalette } from './ui/palette';
import { transportWindow } from './ui/views/transport';
import { patternView, type View } from './ui/views/patternView';
import { soundView } from './ui/views/soundView';
import { performView } from './ui/views/performView';
import { bindKeys } from './ui/keys';
import { closePopups, h, win } from './ui/widgets';
import { installTooltips } from './ui/tooltip';
import { aboutDialog } from './ui/dialogs';
import { cpx, initScale } from './ui/scale';

/** The page: fixed chrome (menu bar, transport, view tabs) above a work area that scrolls. */
function shell(): { chrome: HTMLElement; main: HTMLElement } {
  const root = h('div', '', document.body);
  root.id = 'app';
  const chrome = h('div', '', root);
  chrome.id = 'chrome';
  const main = h('div', '', root);
  main.id = 'main';
  main.addEventListener('scroll', () => closePopups(), { passive: true });
  return { chrome, main };
}

async function main(): Promise<void> {
  initScale(loadPrefs().uiScale);
  applySelectedPalette();
  installTooltips();
  const { chrome, main: screen } = shell();
  const loading = win(screen, { title: 'CLATTER', id: 'loading', cls: 'loading' });
  const msg = h('div', 'lbl', loading.body, 'LOADING THE LXR ENGINE AND THE SAMPLES…');
  msg.style.marginBottom = cpx(10);
  h('div', 'hint', loading.body, 'Generative drum synthesis · LXR-02 firmware DSP in WebAssembly');
  const app = new App();
  (window as unknown as { clatter: App }).clatter = app;
  try {
    await app.boot(import.meta.env.BASE_URL);
  } catch (err) {
    msg.textContent = `CLATTER COULD NOT START: ${err instanceof Error ? err.message : String(err)}`;
    msg.style.whiteSpace = 'normal';
    console.error(err);
    return;
  }
  loading.el.remove();

  const { bar, status } = menubar(app, chrome);
  const st = h('div', '', status);
  st.dataset.test = 'status';
  const midiSt = h('div', '', status);
  const showStatus = () => {
    st.textContent = (app.ui.busy ? '… ' : '') + app.ui.status;
    const m = app.midi;
    midiSt.textContent = m.supported ? (m.state === 'ready' ? `MIDI ${m.prefs.outId ? 'OUT' : ''}${m.prefs.inId ? ' IN' : ''}`.trim() : '') : '';
  };
  app.on('status', showStatus);
  app.on('midi', showStatus);
  showStatus();

  const transport = transportWindow(app, chrome, bar);
  for (const t of ['transport', 'pattern', 'history', 'project', 'view'] as const) app.on(t, () => transport.panel.refresh());
  app.on('pattern', () => transport.rebuildPatterns());
  app.on('project', () => transport.rebuildPatterns());

  const views: Record<'pattern' | 'sound' | 'perform', View> = {
    pattern: patternView(app, screen),
    sound: soundView(app, screen),
    perform: performView(app, screen),
  };
  let shown: keyof typeof views | null = null;
  const showView = () => {
    if (shown === app.ui.view) return;
    shown = app.ui.view;
    for (const [k, v] of Object.entries(views)) v.show(k === shown);
    document.documentElement.dataset.view = shown;
  };
  app.on('view', showView);
  showView();
  window.addEventListener('clatter-palette', () => {
    for (const v of Object.values(views)) v.show(false);
    shown = null;
    showView();
  });

  bindKeys(app);
  document.addEventListener('pointerdown', (e) => {
    const t = e.target as HTMLElement;
    if (!t.closest('.dropdown, #menubar .menu')) closeMenus();
    if (!t.closest('.msel-list, .msel')) closePopups();
  });

  const frame = () => {
    if (shown) views[shown].frame();
    const m = app.meters;
    if (m) transport.meters(m.masterL, m.masterR, m.clipped);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  if (!app.prefs.seenHelp) {
    app.prefs.seenHelp = true;
    app.say('PRESS SPACE TO PLAY · G GENERATE · K NEW KIT · ? KEYS');
  }
  if (location.hash === '#about') aboutDialog();
}

void main();
