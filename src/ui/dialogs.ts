/**
 * Dialogs: about, licence and source, credits, keyboard shortcuts, export, palette.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import type { App } from '../app/app';
import { paletteEditor } from '@slopfactory/core/palette';
import { applyPalette } from '@slopfactory/core/palette';
import { PALETTE_CONFIG, palettes } from './palette';
import type { Hit } from '../model/types';
import { drawCell } from './grid';
import type { CellView } from './gridModel';
import { download, h, num, Panel } from './widgets';
import { cpx, sz } from './scale';

const SOURCE_URL = 'https://github.com/clickysteve/clatter';
const LXR_URL = 'https://github.com/erica-synths/lxr-desktop-app';

let open: { veil: HTMLDivElement; box: HTMLDivElement } | null = null;

export function closeDialog(): void {
  open?.veil.remove();
  open = null;
}

export function dialogOpen(): boolean {
  return !!open;
}

/** A dialog centred in the window: `w` is its widest; it narrows with the window and scrolls inside. */
export function dialog(title: string, w: number): HTMLDivElement {
  closeDialog();
  const veil = h('div', 'veil', document.body);
  veil.addEventListener('pointerdown', (e) => {
    if (e.target === veil) closeDialog();
  });
  const box = h('div', 'dialog', veil);
  box.style.width = cpx(w);
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-label', title);
  h('h2', '', box, title);
  open = { veil, box };
  return box;
}

function buttons(box: HTMLElement, list: [string, () => void, boolean?][]): void {
  const row = h('div', 'btnrow', box);
  for (const [label, fn, def] of list) {
    const b = h('button', 'mbutton' + (def ? ' default' : ''), row, label);
    b.addEventListener('click', fn);
    if (def) setTimeout(() => b.focus({ preventScroll: true }));
  }
}

export function aboutDialog(): void {
  const box = dialog('CLATTER', 720);
  const s = h('div', 'scroll', box);
  s.innerHTML = `
<p><b>Generative drum synthesis and rhythmic destruction.</b> A browser drum workstation from the Slop Factory:
generate a rhythm, generate a kit, mutate both, perform.</p>
<h3>SYNTHESIS</h3>
<p>CLATTER's synthesised drums are the drum voices, envelopes, filters, modulation,
decimation and FX bus of the <b>Erica Synths LXR-02</b>'s open-source firmware, compiled unchanged (apart
from the hardware interface) to WebAssembly. CLATTER is an independent project: it is <b>not</b> an
Erica Synths product, is not endorsed by Erica Synths, and is a <b>modified version</b> of that firmware's
sound engine. "Erica Synths", "LXR" and "LXR-02" are trademarks of Erica Synths, used here only to say
truthfully where the synthesis comes from. Firmware: <a href="${LXR_URL}" target="_blank" rel="noopener">${LXR_URL}</a>,
Copyright © 2012-2026 Erica Synths, GPL-3.0-only with the additional terms in its NOTICE.md.</p>
<h3>RHYTHM AND INTERFACE</h3>
<p>Generative ideas, mutation, Euclid and MIDI code from <b>DOWNBEAT</b>; CHOP, ROLLS, DESTROY and
WILDCARD after <b>The Breakery</b>; the 1-bit interface after <b>emmm</b>; palettes, sample decoding and storage,
output engines and WAV/ZIP export from <b>Slop Factory Core</b> (all MIT, see THIRD_PARTY_NOTICES.md).</p>
<h3>LICENCE</h3>
<p>CLATTER is free software under the <b>GNU General Public License version 3 only</b>, with the
LXR firmware's additional terms (GPL-3.0 section 7: trademarks; modified versions marked as modified). It comes with
<b>no warranty</b>. You may study, change and share it; if you share it, share its source under the same licence.
Full texts with this page: <a href="LICENSE.txt" target="_blank">LICENSE</a>, <a href="NOTICE.md" target="_blank">NOTICE</a>,
<a href="THIRD_PARTY_NOTICES.md" target="_blank">THIRD-PARTY NOTICES</a>, <a href="LXR_FIRMWARE_NOTICE.md" target="_blank">LXR FIRMWARE NOTICE</a>.</p>
<h3>SOURCE</h3>
<p>The complete corresponding source of this page, including the extracted firmware files, the
WebAssembly build script and every modification, is at <a href="${SOURCE_URL}" target="_blank" rel="noopener">${SOURCE_URL}</a>
(<a href="${SOURCE_URL}/commit/${__BUILD_COMMIT__}" target="_blank" rel="noopener">the commit that built it</a> is shown below). The page itself is built from that source with <code>npm ci &amp;&amp; npm run build</code>;
<code>node scripts/build-lxr.mjs</code> rebuilds the engine.</p>
<p>Type: Tiny5, Silkscreen, VT323 and IBM Plex Sans, under the SIL Open Font License 1.1 (see THIRD-PARTY NOTICES).</p>
<p><code>BUILD ${__BUILD_COMMIT__} · ${__BUILD_DATE__}</code></p>`;
  buttons(box, [['OK', closeDialog, true]]);
}

export function helpDialog(): void {
  const box = dialog('KEYS AND GESTURES', 780);
  const s = h('div', 'scroll', box);
  const sections: [string, [string, string][]][] = [
    [
      'PLAYING AND GENERATING',
      [
        ['SPACE', 'play / stop'],
        ['ESC', 'stop, close a dialog or panel, clear the selection'],
        ['1  2  3', 'PATTERN, SOUND, PERFORM'],
        ['G  V  M', 'generate a pattern, make a variation, mutate'],
        ['R', 'regenerate after bar 1'],
        ['K  /  SHIFT+K', 'generate a kit / mutate the kit'],
        ['C  L  D  W', 'CHOP, ROLLS, DESTROY on/off, WILDCARD'],
        ['F (hold)', 'FILL'],
        ['SHIFT 1-9', 'switch pattern (queued to the end of the cycle while playing)'],
      ],
    ],
    [
      'EDITING THE GRID',
      [
        ['CLICK', 'add a hit to an empty step, or remove the hit on a step; the step is selected for editing under the grid'],
        ['DRAG', 'paint hits on (or off, if you started on a hit); one undo step'],
        ['SHIFT-DRAG', 'select a region (COPY, PASTE, CLEAR and VEL work on it)'],
        ['ALT-DRAG, ALT-WHEEL', 'velocity of the hit under the pointer'],
        ['RIGHT-CLICK', 'select the step and open its editor: velocity, chance, pitch, ratchet, flam, sample'],
        ['ARROWS ← →, ENTER', 'with the grid focused: move along the track, add or remove the hit'],
        ['↑ ↓', 'select the previous / next track'],
        ['[  ]', 'shift the selected track one step'],
        ['DELETE', 'clear the selection (or the selected track)'],
        ['⌘/CTRL C, V', 'copy, paste (the selection or the pattern)'],
        ['⌘/CTRL Z, ⌘/CTRL SHIFT Z', 'undo, redo'],
        ['TRACK NAME: DOUBLE-CLICK', 'hear the track'],
      ],
    ],
    [
      'SLIDERS AND NUMBERS',
      [
        ['DRAG', 'set a slider (SHIFT: fine); drag a number box up and down'],
        ['CLICK, THEN TYPE', 'type a value and press ENTER'],
        ['ARROWS', 'step a focused slider or number box (SHIFT: bigger steps)'],
        ['DOUBLE-CLICK', 'a slider back to its default'],
        ['ALT-CLICK (synth sliders)', 'lock / unlock the parameter (kit generation leaves it alone)'],
        ['PERFORM: SNAPSHOT', 'click recalls (on the next quantise boundary); STORE then click stores'],
      ],
    ],
  ];
  for (const [title, rows] of sections) {
    h('h3', '', s, title);
    const t = h('table', '', s);
    for (const [k, v] of rows) {
      const tr = h('tr', '', t);
      h('td', 'k', tr, k);
      h('td', '', tr, v);
    }
  }
  buttons(box, [
    ['READING THE GRID', gridKeyDialog],
    ['OK', closeDialog, true],
  ]);
}

/** How to read the pattern grid, with the real glyphs drawn by the grid's own code. */
export function gridKeyDialog(): void {
  const box = dialog('READING THE GRID', 780);
  const s = h('div', 'scroll', box);
  const cs = getComputedStyle(document.documentElement);
  const ink = cs.getPropertyValue('--ink').trim() || '#000';
  const paper = cs.getPropertyValue('--paper').trim() || '#fff';
  const colors = { ink, paper, activity: cs.getPropertyValue('--activity').trim() || ink, selection: cs.getPropertyValue('--selection').trim() || ink };
  const hit = (vel: number, prob = 100): Hit => ({ vel, prob });
  const base: CellView = { state: 'hit', hit: hit(100), origin: 'gen', vel: 100, strokes: 1, base: null, prob: 100, flam: false, added: false, why: null, kinds: ['source'], destroyed: false, evolved: false, outside: false, snd: null };
  const empty: CellView = { ...base, state: 'empty', hit: null, vel: 0, strokes: 0, kinds: [] };
  const items: [CellView, boolean, string, string][] = [
    [{ ...base, vel: 110 }, false, 'A hit that sounds', 'A solid block. The grid shows what actually plays in the cycle on show, so you can read the rhythm straight off it. The taller the block, the harder the hit (velocity).'],
    [{ ...base, vel: 55 }, false, 'A quieter hit', 'The same block, shorter.'],
    [{ ...base, strokes: 3, vel: 90 }, false, 'Several strokes in one step', 'A split block: a ratchet, a roll or a stutter plays more than once in the step.'],
    [{ ...base, flam: true, vel: 100 }, false, 'A flam', 'A short block just before the hit: a soft grace note.'],
    [{ ...base, hit: hit(100, 50), prob: 50, vel: 100 }, false, 'A hit that may not play', 'A thin bar along the top of the step shows its chance. A full-length bar is certain; half length is 50 %. The block is solid when it plays this time round.'],
    [{ ...base, state: 'silent', hit: hit(100, 50), prob: 50, why: 'chance', vel: 100 }, false, 'Written, but silent this pass', 'An outlined block: the hit is in your pattern but did not play in the cycle on show (its chance, the track’s density, or CHOP or DESTROY moving or skipping it). Clicking removes it.'],
    [empty, false, 'An empty step', 'Nothing sounds, and nothing is written. Clicking adds a hit (the pointer shows a faint preview of it).'],
    [{ ...base, origin: 'edit' }, true, 'SHOW ORIGINAL: a hand edit', 'With SHOW ORIGINAL on, a small flag in the corner marks a hit you wrote by hand.'],
    [{ ...base, snd: { letter: 'B', cond: false, voice: false, edits: false, condText: '', text: '' } }, false, 'A step with its own sound', 'A small plate at the top right names the variation (A to D) the step plays instead of the track’s base sound.'],
    [{ ...base, snd: { letter: 'C', cond: true, voice: false, edits: true, condText: '', text: '' } }, false, 'A conditional sound, with locks', 'A “?” after the letter means a condition decides (a share of the passes, every Nth, first or last, alternate, fill). The corner triangle means the step has parameter locks or rules. Hover the step to read them.'],
    [{ ...base, snd: { letter: null, cond: false, voice: true, edits: false, condText: '', text: '' } }, false, 'A step that triggers another voice', 'A “>” means the step plays another LXR voice than its track’s.'],
    [{ ...empty, origin: 'deleted', base: hit(100) }, true, 'SHOW ORIGINAL: a deleted hit', 'A crossed-out outline marks a generated hit you deleted. Without SHOW ORIGINAL it is simply an empty step.'],
  ];
  h('p', '', s, 'Every step has its own cell. The lines between cells get heavier at beats and heavier again at bars; every other beat is lightly dotted, and the header counts bars and beats. All of that follows the pattern’s resolution (GRID), so it stays right for 1/16, 1/32 and triplet patterns.');
  const legend = h('div', 'legend', s);
  const dpr = window.devicePixelRatio || 1;
  for (const [view, showOriginal, title, text] of items) {
    const c = h('canvas', '', legend);
    // drawn on a 72 x 40 sheet, shown at the interface scale
    const cw = sz(72);
    const ch = sz(40);
    c.width = Math.round(cw * dpr);
    c.height = Math.round(ch * dpr);
    c.style.width = cw + 'px';
    c.style.height = ch + 'px';
    const g = c.getContext('2d')!;
    g.setTransform((dpr * cw) / 72, 0, 0, (dpr * ch) / 40, 0, 0);
    g.fillStyle = paper;
    g.fillRect(0, 0, 72, 40);
    drawCell(g, 20, 0, 32, 40, view, colors, showOriginal);
    g.fillStyle = ink;
    g.globalAlpha = 0.28;
    g.fillRect(20, 0, 1, 40);
    g.fillRect(52, 0, 1, 40);
    g.globalAlpha = 1;
    const d = h('div', '', legend);
    h('b', '', d, title);
    h('div', '', d, text);
  }
  h('h3', '', s, 'THE PLAYHEAD AND THE POINTER');
  h('p', '', s, 'While playing, the current step is lit in the header and shaded down the grid; it never covers a hit. The ringed step is the one you are editing (the step editor under the grid shows it). A dashed outline follows the pointer. Tracks that are muted, or silenced by another track’s solo, are faded.');
  h('h3', '', s, 'EDITING');
  h('p', '', s, 'Click a step to add or remove its hit, drag to paint, Shift-drag to select a region, Alt-drag to change a velocity, right-click for the step editor. The hover line under the grid and the tooltips say exactly what a step is: sounding or silent, its velocity and chance, where it came from (generated, hand-edited, added by a fill, ROLLS or CHOP) and what has changed it.');
  buttons(box, [['OK', closeDialog, true]]);
}

export function exportDialog(app: App, what: 'master' | 'stems' | 'midi'): void {
  const box = dialog(what === 'master' ? 'EXPORT MASTER WAV' : what === 'stems' ? 'EXPORT STEMS' : 'EXPORT MIDI FILE', 520);
  const panel = new Panel();
  const p = h('p', '', box, what === 'midi' ? 'The performance (what plays, after CHOP, ROLLS, DESTROY and evolution) as a Standard MIDI File, one track per CLATTER track.' : 'Rendered offline through the same engine as playback (44.1 kHz, 16-bit). Seeded: the same project gives the same file.');
  void p;
  const row = h('div', 'row wrap', box);
  row.style.margin = '6px 0 10px';
  h('div', 'lbl', row, 'BARS');
  num(panel, row, { get: () => app.prefs.exportBars, set: (v) => (app.prefs.exportBars = v), min: 1, max: 256 });
  if (what !== 'midi') {
    h('div', 'lbl', row, 'TAIL (SECONDS)');
    num(panel, row, { get: () => app.prefs.exportTail, set: (v) => (app.prefs.exportTail = v), min: 0, max: 20 });
  }
  const status = h('div', 'report', box, '');
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
  const box = dialog('PALETTE', 600);
  const scroll = h('div', 'scroll', box);
  const host = h('div', 'paletteeditor-host', scroll);
  host.style.position = 'relative';
  const ed = paletteEditor(host, palettes(), { apply: (c) => applyPalette(PALETTE_CONFIG, c), onChange: () => window.dispatchEvent(new Event('clatter-palette')) });
  host.style.height = ed.height + 'px';
  buttons(box, [['DONE', closeDialog, true]]);
}

export function confirmDialog(title: string, text: string, ok: string, fn: () => void): void {
  const box = dialog(title, 520);
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
