/**
 * EXPORT KIT: the dialog (what to render) and the progress card (what is rendering, cancel).
 * The settings live in the dialog's own state for the session; the render runs in the
 * background (src/app/kitExportJob.ts) and the dialog closes as soon as it starts.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import type { App } from '../app/app';
import { KIT_EXPORT_DEFAULTS, LAYER_CHOICES, resolveOptions, type KitExportOptions, type LayerCount, type PitchMode, type Processing, type VariationMode } from '../export/kitExport';
import { SCALES } from '../export/notes';
import { WAV_FORMATS, type WavFormat } from '../export/wavFile';
import { clone } from '../model/types';
import { buttons, closeDialog, dialog } from './dialogs';
import { cpx } from './scale';
import { button, h, Panel, select } from './widgets';

let remembered: KitExportOptions | null = null;

function textInput(parent: HTMLElement, get: () => string, set: (v: string) => void, width: number, title: string, onInput: () => void): HTMLInputElement {
  const input = h('input', 'mtext', parent) as HTMLInputElement;
  input.value = get();
  input.spellcheck = false;
  input.title = title;
  input.style.width = cpx(width);
  input.addEventListener('keydown', (e) => e.stopPropagation());
  input.addEventListener('input', () => {
    set(input.value);
    onInput();
  });
  return input;
}

export function exportKitDialog(app: App): void {
  const box = dialog('EXPORT KIT', 700);
  box.dataset.test = 'export-kit';
  const o: KitExportOptions = remembered ? clone(remembered) : clone(KIT_EXPORT_DEFAULTS);
  if (!o.trackIds.length) o.trackIds = [app.ui.track];
  o.trackIds = o.trackIds.filter((id) => app.project.tracks.some((t) => t.id === id));
  if (!o.trackIds.length) o.trackIds = [app.ui.track];
  const panel = new Panel();
  const scroll = h('div', 'scroll', box);
  const about = h('p', '', scroll, 'Output: a ZIP of WAV files with a kit.json. Renders each instrument of the kit alone, through the real synthesis and sample engine, as WAV files in a ZIP with a kit.json. Pitched sounds are retuned in the engine and measured; sounds without a single pitch are exported at their original pitch and not named as notes. The project is not changed.');
  about.style.margin = '0 0 8px';

  const row = (label: string): HTMLDivElement => {
    const r = h('div', 'row wrap', scroll);
    r.style.margin = '0 0 6px';
    r.style.gap = cpx(6);
    const l = h('div', 'lbl', r, label);
    l.style.minWidth = cpx(96);
    return r;
  };
  /** another label and control on the same row */
  const more2 = (r: HTMLElement, label: string): HTMLElement => {
    const l = h('div', 'lbl', r, label);
    l.style.marginLeft = cpx(12);
    return r;
  };
  const choice = <T extends string | number>(r: HTMLElement, opts: [T, string][], get: () => T, set: (v: T) => void, title: string, test: string) => {
    select<T>(panel, r, { options: () => opts.map(([value, label]) => ({ value, label })), get, set: (v) => { set(v); panel.refresh(); }, title }).dataset.test = test;
  };
  const toggles = (r: HTMLElement, items: { key: string; label: string; title?: string }[], has: (k: string) => boolean, flip: (k: string) => void, test: string) => {
    const seg = h('div', 'row wrap', r);
    seg.style.gap = cpx(4);
    for (const it of items) button(panel, seg, it.label, () => { flip(it.key); panel.refresh(); }, { on: () => has(it.key), title: it.title }).dataset.test = `${test}-${it.key}`;
  };

  // instruments
  const rInst = row('INSTRUMENTS');
  choice<'all' | 'selected'>(rInst, [['all', 'ALL TRACKS'], ['selected', 'SELECTED TRACKS']], () => o.instruments, (v) => (o.instruments = v), 'Every track of the kit, or only the ones chosen below', 'kx-instruments');
  more2(rInst, 'VARIATIONS');
  const rVar = rInst;
  const rTracks = row('');
  toggles(rTracks, app.project.tracks.map((t) => ({ key: t.id, label: t.name, title: `${t.name} (${t.sound.mode.toUpperCase()})` })), (k) => o.trackIds.includes(k), (k) => (o.trackIds = o.trackIds.includes(k) ? o.trackIds.filter((x) => x !== k) : [...o.trackIds, k]), 'kx-track');

  // variations
  choice<VariationMode>(rVar, [['base', 'BASE ONLY'], ['all', 'BASE + A/B/C/D'], ['selected', 'SELECTED']], () => o.variations, (v) => (o.variations = v), 'The base sound, the base and every populated variation, or a chosen set (an empty variation plays the base sound and is skipped)', 'kx-variations');
  const rSlots = row('');
  toggles(rSlots, [{ key: 'base', label: 'BASE' }, ...['A', 'B', 'C', 'D'].map((l) => ({ key: l, label: l }))], (k) => o.slots.includes(k === 'base' ? null : 'ABCD'.indexOf(k)), (k) => { const v = k === 'base' ? null : 'ABCD'.indexOf(k); o.slots = o.slots.includes(v) ? o.slots.filter((x) => x !== v) : [...o.slots, v]; }, 'kx-slot');

  // velocity layers
  const rVel = row('VELOCITY LAYERS');
  choice<LayerCount>(rVel, LAYER_CHOICES.map((n) => [n, n === 1 ? '1 (VEL 127)' : String(n)] as [LayerCount, string]), () => o.layers, (v) => (o.layers = v), 'Each layer is rendered at the top of its velocity range; the filenames carry VEL###', 'kx-layers');

  // pitch
  const rPitch = row('PITCH');
  choice<PitchMode>(rPitch, [['original', 'ORIGINAL PITCH'], ['project', 'AS TUNED'], ['global', 'GLOBAL SCALE'], ['track', 'TRACK SCALES'], ['chromatic', 'CHROMATIC RANGE'], ['scale', 'SELECTED SCALE'], ['custom', 'CUSTOM NOTE RANGE']], () => o.pitch.mode, (v) => (o.pitch.mode = v), 'ORIGINAL: each sound before scale tuning. AS TUNED: as the project plays it, scale-locked instruments on their notes. GLOBAL SCALE and TRACK SCALES: every note of the project’s global scale, or of each instrument’s own scale, in a range. Or a range, a chosen scale or a list', 'kx-pitch');
  const rNotes = row('');
  const fields: HTMLElement[] = [];
  const upd = () => panel.refresh();
  const mk = (cls: 'range' | 'scale' | 'custom', label: string, make: (p: HTMLElement) => void) => {
    const l = h('div', 'lbl', rNotes, label);
    const w = h('div', 'row', rNotes);
    make(w);
    fields.push(l, w);
    (l as HTMLElement).dataset.k = cls;
    w.dataset.k = cls;
  };
  mk('scale', 'ROOT', (p) => {
    textInput(p, () => o.pitch.root, (v) => (o.pitch.root = v), 48, 'The root of the scale: C, F#, Bb', upd).dataset.test = 'kx-root';
    select<string>(panel, p, { options: () => Object.entries(SCALES).map(([value, s]) => ({ value, label: s.label })), get: () => o.pitch.scale, set: (v) => (o.pitch.scale = v), title: 'Scale' }).dataset.test = 'kx-scale';
  });
  mk('range', 'FROM', (p) => textInput(p, () => o.pitch.lo, (v) => (o.pitch.lo = v), 64, 'Lowest note: a name (C2, F#3) or a MIDI number (C4 = 60)', upd).setAttribute('data-test', 'kx-lo'));
  mk('range', 'TO', (p) => textInput(p, () => o.pitch.hi, (v) => (o.pitch.hi = v), 64, 'Highest note', upd).setAttribute('data-test', 'kx-hi'));
  mk('custom', 'NOTES', (p) => textInput(p, () => o.pitch.list, (v) => (o.pitch.list = v), 280, 'Notes and ranges, e.g. C2, F#2, 48, C3-E3 (C4 = 60)', upd).setAttribute('data-test', 'kx-list'));

  // format, processing, tail, normalisation
  more2(rVel, 'AUDIO FORMAT');
  choice<WavFormat>(rVel, (Object.keys(WAV_FORMATS) as WavFormat[]).map((k) => [k, WAV_FORMATS[k].label]), () => o.format, (v) => (o.format = v), '44.1 kHz stereo WAV', 'kx-format');
  const rProc = row('PROCESSING');
  choice<Processing>(rProc, [['dry', 'DRY'], ['wet', 'WET'], ['both', 'BOTH']], () => o.processing, (v) => (o.processing = v), 'DRY: the voice and sample before the channel strip. WET: through the track’s EQ, saturation, filter and FX send (not the master). BOTH: two files each', 'kx-processing');
  more2(rProc, 'TAIL');
  const rTail = rProc;
  choice<'auto' | 'custom'>(rTail, [['auto', 'AUTOMATIC'], ['custom', 'CUSTOM DURATION']], () => o.tail.mode, (v) => (o.tail.mode = v), 'Automatic follows the sound until it has died away (-80 dB)', 'kx-tail');
  const secs = textInput(rTail, () => String(o.tail.seconds), (v) => { const n = parseFloat(v); if (Number.isFinite(n)) o.tail.seconds = n; }, 56, 'Seconds (0.05 to 30)', upd);
  secs.dataset.test = 'kx-seconds';
  h('div', 'lbl', rTail, 'S');
  more2(rProc, 'NORMALISE');
  choice<'on' | 'off'>(rProc, [['on', 'ON'], ['off', 'OFF']], () => (o.normalise ? 'on' : 'off'), (v) => (o.normalise = v === 'on'), 'On sets the loudest file of each instrument to -1 dBFS and gives all its files the same gain, so velocity layers and notes keep their balance. Off leaves the levels as rendered', 'kx-normalise');

  const status = h('div', 'report', box, '');
  status.dataset.test = 'kx-status';
  status.style.marginTop = cpx(6);

  panel.add(() => {
    (rTracks as HTMLElement).style.display = o.instruments === 'selected' ? '' : 'none';
    (rSlots as HTMLElement).style.display = o.variations === 'selected' ? '' : 'none';
    const m = o.pitch.mode;
    rNotes.style.display = m === 'original' || m === 'project' ? 'none' : '';
    for (const f of fields) {
      const k = (f as HTMLElement).dataset.k;
      f.style.display = ((m === 'chromatic' || m === 'global' || m === 'track') && k === 'range') || (m === 'scale' && (k === 'range' || k === 'scale')) || (m === 'custom' && k === 'custom') ? '' : 'none';
    }
    const show = o.tail.mode === 'custom';
    secs.style.display = show ? '' : 'none';
    (secs.nextElementSibling as HTMLElement).style.display = show ? '' : 'none';
    // an upper bound on the files (sounds that cannot be retuned make fewer)
    const r = resolveOptions(app.project, o);
    if ('error' in r) status.textContent = r.error;
    else {
      const populated = (t: (typeof r.tracks)[number], s: number | null) => s === null || !!t.sound.variations?.[s];
      const sounds = r.tracks.reduce((n, t) => n + r.slots.filter((s) => populated(t, s)).length, 0);
      const files = sounds * (r.notes?.length ?? 1) * o.layers * r.processing.length;
      status.textContent = `UP TO ${files} FILES FROM ${sounds} SOUND${sounds === 1 ? '' : 'S'}${r.notes ? ` × ${r.notes.length} NOTE${r.notes.length === 1 ? '' : 'S'}` : ''}${o.layers > 1 ? ` × ${o.layers} LAYERS` : ''}${r.processing.length > 1 ? ' × DRY AND WET' : ''}. SOUNDS WITHOUT A RELIABLE PITCH MAKE ONE SET.`;
    }
  });

  let pressed = false;
  const go = () => {
    if (pressed) return;
    remembered = clone(o);
    const r = app.startKitExport(o);
    if (!r.started) {
      status.textContent = r.error ?? 'EXPORT DID NOT START';
      return;
    }
    pressed = true;
    closeDialog();
  };
  buttons(box, [
    ['CANCEL', closeDialog],
    ['EXPORT', go, true],
  ]);
  panel.refresh();
}

/** The floating card that shows a running kit export: stage, instrument, files done, a bar and CANCEL. */
export function kitExportProgress(app: App): void {
  const card = h('div', 'kxcard', document.body);
  card.dataset.test = 'kx-progress';
  card.style.display = 'none';
  card.setAttribute('role', 'status');
  const title = h('div', 'kxtitle', card, 'EXPORT KIT');
  const line = h('div', 'kxline', card);
  const sub = h('div', 'report', card);
  const bar = h('div', 'kxbar', card);
  const fill = h('div', 'kxfill', bar);
  const panel = new Panel();
  const stop = button(panel, card, 'CANCEL', () => app.kitExport.cancel(), { title: 'Stop after the file being rendered; nothing is saved', disabled: () => app.kitExport.state.cancelling });
  stop.dataset.test = 'kx-cancel';
  const draw = () => {
    const s = app.kitExport.state;
    card.style.display = s.running ? '' : 'none';
    if (!s.running) return;
    const p = s.progress;
    title.textContent = s.cancelling ? 'CANCELLING…' : 'EXPORT KIT';
    if (!p) {
      line.textContent = 'STARTING…';
      sub.textContent = '';
      fill.style.width = '0%';
    } else if (p.stage === 'analysing') {
      line.textContent = `ANALYSING ${p.instrument}`;
      sub.textContent = `${p.done} OF ${p.total} SOUNDS`;
      fill.style.width = '0%';
    } else if (p.stage === 'rendering') {
      line.textContent = p.instrument;
      sub.textContent = `${p.done} OF ${p.total} FILES · ${p.file ?? ''}${p.warnings ? ` · ${p.warnings} WARNING${p.warnings === 1 ? '' : 'S'}` : ''}`;
      fill.style.width = `${Math.round((100 * p.done) / Math.max(1, p.total))}%`;
    } else {
      line.textContent = 'PACKING THE ZIP…';
      sub.textContent = `${p.total} FILES`;
      fill.style.width = '100%';
    }
    panel.refresh();
  };
  app.on('kitexport', draw);
  draw();
}
