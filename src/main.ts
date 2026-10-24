/**
 * CLATTER: start-up. Builds the 1280 × 800 logical screen (scaled to fit the window), the
 * menu bar, the transport and the three views, then boots the application (the LXR engine,
 * the bundled samples, the last session).
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import './ui/style.css';
import { App } from './app/app';
import { closeMenus, menubar } from './ui/menu';
import { applySelectedPalette } from './ui/palette';
import { transportWindow } from './ui/views/transport';
import { patternView, type View } from './ui/views/patternView';
import { soundView } from './ui/views/soundView';
import { performView } from './ui/views/performView';
import { bindKeys } from './ui/keys';
import { closePopups, h, win } from './ui/widgets';
import { aboutDialog } from './ui/dialogs';

const W = 1280;
const H = 800;

function stage(): HTMLElement {
  const st = h('div', '', document.body);
  st.id = 'stage';
  const screen = h('div', '', st);
  screen.id = 'screen';
  const fit = () => {
    const s = Math.min(window.innerWidth / W, window.innerHeight / H);
    // whole pixels when there is room for them (crisp 1-bit lines)
    const scale = s >= 1 ? Math.floor(s * 4) / 4 : s;
    screen.style.transform = `scale(${scale})`;
    screen.style.left = Math.max(0, (window.innerWidth - W * scale) / 2) + 'px';
    screen.style.top = Math.max(0, (window.innerHeight - H * scale) / 2) + 'px';
  };
  window.addEventListener('resize', fit);
  fit();
  return screen;
}

async function main(): Promise<void> {
  applySelectedPalette();
  const screen = stage();
  const loading = win(screen, { x: 440, y: 330, w: 400, h: 110, title: 'CLATTER', id: 'loading' });
  const msg = h('div', 'lbl', loading.body, 'LOADING THE LXR ENGINE AND THE SAMPLES…');
  h('div', 'tiny', loading.body, 'GENERATIVE DRUM SYNTHESIS · LXR-02 FIRMWARE DSP IN WEBASSEMBLY').style.marginTop = '10px';
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

  const { status } = menubar(app, screen);
  const st = h('div', '', status);
  st.dataset.test = 'status';
  const midiSt = h('div', 'tiny', status);
  const showStatus = () => {
    st.textContent = (app.ui.busy ? '… ' : '') + app.ui.status;
    const m = app.midi;
    midiSt.textContent = m.supported ? (m.state === 'ready' ? `MIDI ${m.prefs.outId ? 'OUT' : ''}${m.prefs.inId ? ' IN' : ''}`.trim() : '') : '';
  };
  app.on('status', showStatus);
  app.on('midi', showStatus);
  showStatus();

  const transport = transportWindow(app, screen);
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
  screen.addEventListener('pointerdown', (e) => {
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
