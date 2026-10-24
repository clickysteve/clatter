/**
 * Dialogs: about, licence and source, credits, keyboard shortcuts, export, palette.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import type { App } from '../app/app';
import { paletteEditor } from '@slopfactory/core/palette';
import { applyPalette } from '@slopfactory/core/palette';
import { PALETTE_CONFIG, palettes } from './palette';
import { download, h, num, Panel } from './widgets';

const SOURCE_URL = 'https://github.com/clickysteve/clatter';
const LXR_URL = 'https://github.com/erica-synths/lxr-desktop-app';

let open: { veil: HTMLDivElement; box: HTMLDivElement } | null = null;

export function closeDialog(): void {
  open?.veil.remove();
  open?.box.remove();
  open = null;
}

export function dialogOpen(): boolean {
  return !!open;
}

export function dialog(title: string, w: number, hgt: number): HTMLDivElement {
  closeDialog();
  const screen = document.getElementById('screen')!;
  const veil = h('div', 'veil', screen);
  veil.addEventListener('pointerdown', closeDialog);
  const box = h('div', 'dialog', screen);
  Object.assign(box.style, { left: (1280 - w) / 2 + 'px', top: Math.max(30, (800 - hgt) / 2) + 'px', width: w + 'px', maxHeight: hgt + 'px' });
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', title);
  h('h2', '', box, title);
  open = { veil, box };
  return box;
}

function buttons(box: HTMLElement, list: [string, () => void, boolean?][]): void {
  const row = h('div', 'row', box);
  row.style.justifyContent = 'flex-end';
  row.style.marginTop = '10px';
  for (const [label, fn, def] of list) {
    const b = h('button', 'mbutton' + (def ? ' default' : ''), row, label);
    b.addEventListener('click', fn);
  }
}

export function aboutDialog(): void {
  const box = dialog('CLATTER', 560, 640);
  const s = h('div', 'scroll', box);
  s.style.maxHeight = '540px';
  s.innerHTML = `
<p><b>Generative drum synthesis and rhythmic destruction.</b> A browser drum workstation from the Slop Factory:
generate a rhythm, generate a kit, mutate both, perform.</p>
<p><b>Synthesis.</b> CLATTER's synthesised drums are the drum voices, envelopes, filters, modulation,
decimation and FX bus of the <b>Erica Synths LXR-02</b>'s open-source firmware, compiled unchanged (apart
from the hardware interface) to WebAssembly. CLATTER is an independent project: it is <b>not</b> an
Erica Synths product, is not endorsed by Erica Synths, and is a <b>modified version</b> of that firmware's
sound engine. "Erica Synths", "LXR" and "LXR-02" are trademarks of Erica Synths, used here only to say
truthfully where the synthesis comes from. Firmware: <a href="${LXR_URL}" target="_blank" rel="noopener">${LXR_URL}</a>,
Copyright © 2012-2026 Erica Synths, GPL-3.0-only with the additional terms in its NOTICE.md.</p>
<p><b>Rhythm.</b> Generative ideas, mutation, Euclid and MIDI code from <b>DOWNBEAT</b>; CHOP, ROLLS, DESTROY and
WILDCARD after <b>The Breakery</b>; the 1-bit interface after <b>emmm</b>; palettes, sample decoding and storage,
output engines and WAV/ZIP export from <b>Slop Factory Core</b> (all MIT, see THIRD_PARTY_NOTICES.md).</p>
<p><b>Licence.</b> CLATTER is free software under the <b>GNU General Public License version 3 only</b>, with the
LXR firmware's additional terms (GPL-3.0 section 7: trademarks; modified versions marked as modified). It comes with
<b>no warranty</b>. You may study, change and share it; if you share it, share its source under the same licence.</p>
<p><b>Source.</b> The complete corresponding source of this page, including the extracted firmware files, the
WebAssembly build script and every modification, is at <a href="${SOURCE_URL}" target="_blank" rel="noopener">${SOURCE_URL}</a>
(the commit that built it is shown below). The page itself is built from that source with <code>npm ci && npm run build</code>;
<code>node scripts/build-lxr.mjs</code> rebuilds the engine.</p>
<p class="tiny">BUILD ${__BUILD_COMMIT__} · ${__BUILD_DATE__}</p>`;
  buttons(box, [['OK', closeDialog, true]]);
}

export function helpDialog(): void {
  const box = dialog('KEYS AND GESTURES', 600, 640);
  const s = h('div', 'scroll', box);
  s.style.maxHeight = '560px';
  const rows: [string, string][] = [
    ['SPACE', 'play / stop'],
    ['ESC', 'stop, close, clear the selection'],
    ['1 2 3', 'PATTERN, SOUND, PERFORM'],
    ['G / V / M', 'generate a pattern / variation / mutate'],
    ['R', 'regenerate after bar 1'],
    ['K / SHIFT+K', 'generate a kit / mutate the kit'],
    ['C / L / D / W', 'CHOP, ROLLS, DESTROY on/off, WILDCARD'],
    ['F (hold)', 'FILL'],
    ['SHIFT 1-9', 'switch pattern (queued to the end of the cycle while playing)'],
    ['⌘/CTRL Z, ⌘/CTRL SHIFT Z', 'undo, redo'],
    ['⌘/CTRL C, V', 'copy, paste (the selection or the pattern)'],
    ['DELETE', 'clear the selection'],
    ['[ ]', 'shift the selected track one step'],
    ['↑ ↓', 'select the previous / next track'],
    ['GRID: CLICK, DRAG', 'add or remove hits; drag paints (one undo step)'],
    ['GRID: SHIFT-DRAG', 'select a region'],
    ['GRID: ALT-DRAG, WHEEL', 'velocity of a hit'],
    ['GRID: RIGHT-CLICK', 'select one cell (STEP window)'],
    ['SLIDERS', 'drag (SHIFT: fine), click then type a value + ENTER, arrows, double-click: default'],
    ['SYNTH SLIDERS: ALT-CLICK', 'lock / unlock the parameter (kit generation leaves it alone)'],
    ['TRACK NAME: DOUBLE-CLICK', 'hear the track'],
    ['PERFORM: SNAPSHOT', 'click recalls (on the next quantise boundary); STORE then click stores'],
  ];
  const t = h('table', '', s);
  for (const [k, v] of rows) {
    const tr = h('tr', '', t);
    h('td', 'k', tr, k);
    h('td', '', tr, v);
  }
  buttons(box, [['OK', closeDialog, true]]);
}

export function exportDialog(app: App, what: 'master' | 'stems' | 'midi'): void {
  const box = dialog(what === 'master' ? 'EXPORT MASTER WAV' : what === 'stems' ? 'EXPORT STEMS' : 'EXPORT MIDI FILE', 380, 260);
  const panel = new Panel();
  const p = h('p', '', box, what === 'midi' ? 'The performance (what plays, after CHOP, ROLLS, DESTROY and evolution) as a Standard MIDI File, one track per CLATTER track.' : 'Rendered offline through the same engine as playback (44.1 kHz, 16-bit). Seeded: the same project gives the same file.');
  void p;
  const row = h('div', 'row', box);
  h('div', 'lbl', row, 'BARS');
  num(panel, row, { get: () => app.prefs.exportBars, set: (v) => (app.prefs.exportBars = v), min: 1, max: 256, width: 46 });
  if (what !== 'midi') {
    h('div', 'lbl', row, 'TAIL S');
    num(panel, row, { get: () => app.prefs.exportTail, set: (v) => (app.prefs.exportTail = v), min: 0, max: 20, width: 40 });
  }
  const status = h('p', 'tiny', box, '');
  const go = async () => {
    try {
      status.textContent = 'RENDERING…';
      const prog = (f: number) => (status.textContent = `RENDERING ${Math.round(f * 100)}%`);
      const f = what === 'master' ? await app.exportMaster(app.prefs.exportBars, app.prefs.exportTail, prog) : what === 'stems' ? await app.exportStems(app.prefs.exportBars, app.prefs.exportTail, prog) : app.exportMidiFile(app.prefs.exportBars);
      download(f.name, f.data, f.type);
      status.textContent = `SAVED ${f.name}`;
      app.say(`EXPORTED ${f.name}`);
    } catch (err) {
      status.textContent = `FAILED: ${err instanceof Error ? err.message : String(err)}`;
    }
  };
  buttons(box, [
    ['CANCEL', closeDialog],
    ['EXPORT', () => void go(), true],
  ]);
}

export function paletteDialog(): void {
  const box = dialog('PALETTE', 340, 520);
  const host = h('div', '', box);
  host.style.position = 'relative';
  const ed = paletteEditor(host, palettes(), { apply: (c) => applyPalette(PALETTE_CONFIG, c), onChange: () => window.dispatchEvent(new Event('clatter-palette')) });
  host.style.height = ed.height + 'px';
  buttons(box, [['DONE', closeDialog, true]]);
}

export function confirmDialog(title: string, text: string, ok: string, fn: () => void): void {
  const box = dialog(title, 360, 200);
  h('p', '', box, text);
  buttons(box, [
    ['CANCEL', closeDialog],
    [
      ok,
      () => {
        closeDialog();
        fn();
      },
      true,
    ],
  ]);
}

declare const __BUILD_COMMIT__: string;
declare const __BUILD_DATE__: string;
