/**
 * The FACTORY tab: SAMPLE FACTORY. Make a collection of LXR percussion sounds (an instrument or a
 * mix of all ten, 8-256 of them), hear every one rendered by the real engine, let the quality
 * checks flag the broken ones (never delete the strange ones), sort and filter, favourite and
 * select the best, and send them to the kit, the sound library or a sample-pack ZIP.
 *
 * Until SEND TO KIT the kit and the tracks are exactly as they were: sounds are rendered offline
 * on a stage of their own and played on their own.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import type { App } from '../../app/app';
import { SORTS, type SortKey } from '../../app/factory';
import { savePrefs } from '../../app/prefs';
import { WAV_FORMATS, type WavFormat } from '../../export/wavFile';
import type { PackProcessing } from '../../export/packExport';
import { CHARACTERS, characterLabel, WILDNESS_MIN } from '../../sound/discover';
import { COUNT_CHOICES, COUNT_MAX, FACTORY_INSTRUMENTS, flagsOf, INSTRUMENT_SPECS, type FactoryInstrument, type FactorySound, statusOf } from '../../sound/factory';
import { VOICES } from '../../sound/lxrParams';
import type { Instrument } from '../../sound/voiceScore';
import { buttons, closeDialog, dialog } from '../dialogs';
import { seedField } from '../seedField';
import { button, chooseFiles, h, num, Panel, range, select, toast } from '../widgets';
import { subscribe } from './patternView';
import type { PaneParts } from './soundUi';

const CUSTOM = -1;
const db = (x: number): string => (x > 0 ? (20 * Math.log10(x)).toFixed(1) : '−∞');

export function factoryPane(app: App, pane: HTMLElement): PaneParts {
  const fp = new Panel();
  const fs = app.factory;
  const busy = () => fs.busy;
  const remember = () => {
    const p = app.prefs.factory;
    p.instrument = fs.instrument;
    p.count = fs.count;
    p.variation = fs.variation;
    p.diversity = fs.diversity;
    p.qcStrict = fs.qcStrict;
    p.format = fs.pack.format;
    p.processing = fs.pack.processing;
    p.tailMode = fs.pack.tail.mode;
    p.tailSeconds = fs.pack.tail.seconds;
    p.normalise = fs.pack.normalise;
    app.prefs.discover.character = fs.character;
    app.prefs.discover.wildness = fs.wildness;
    savePrefs(app.prefs);
  };
  const set = (fn: () => void) => {
    fn();
    remember();
    fp.refresh();
  };

  // ---------------------------------------------------------------- what to make
  const r1 = h('div', 'row wrap sndtop', pane);
  h('div', 'lbl', r1, 'INSTRUMENT').title = 'One kind of sound, or MIXED: all ten dealt in turn';
  select(fp, r1, { options: () => FACTORY_INSTRUMENTS.map((i) => ({ value: i.id as string, label: i.label })), get: () => fs.instrument, set: (v) => set(() => (fs.instrument = v as FactoryInstrument)), width: 120, title: 'Kick, snare, clap, closed hat, open hat, low tom, high tom, cymbal, percussion, FX or MIXED' }).dataset.test = 'factory-instrument';
  h('div', 'lbl', r1, 'COUNT');
  select(fp, r1, {
    options: () => [...COUNT_CHOICES.map((n) => ({ value: n, label: String(n) })), { value: CUSTOM, label: COUNT_CHOICES.includes(fs.count as never) ? 'CUSTOM…' : `CUSTOM · ${fs.count}` }],
    get: () => (COUNT_CHOICES.includes(fs.count as never) ? fs.count : CUSTOM),
    set: (v) => {
      if (v !== CUSTOM) return set(() => (fs.count = v));
      custom.style.display = '';
    },
    width: 100,
    title: 'How many sounds in the next batch: 8, 16, 32, 64, 128 or a number of your own',
  }).dataset.test = 'factory-count';
  const custom = num(fp, r1, { get: () => fs.count, set: (v) => set(() => (fs.count = v)), min: 1, max: COUNT_MAX, width: 60, title: `Any number from 1 to ${COUNT_MAX} (over 128 takes a while)` });
  custom.dataset.test = 'factory-count-custom';
  custom.style.display = 'none';
  fp.add(() => {
    if (!COUNT_CHOICES.includes(fs.count as never)) custom.style.display = '';
  });
  h('div', 'lbl', r1, 'CHARACTER');
  select(fp, r1, {
    options: () => [{ value: 'style' as string, label: 'STYLE · ' + characterLabel(fs.effectiveCharacter) }, ...CHARACTERS.map((c) => ({ value: c.id as string, label: c.label }))],
    get: () => fs.character,
    set: (v) => set(() => (fs.character = v as typeof fs.character)),
    width: 150,
    title: 'The kit generator’s characters: ' + CHARACTERS.map((c) => `${c.label} (${c.hint})`).join(', '),
  }).dataset.test = 'factory-character';

  const r2 = h('div', 'row wrap sndtop', pane);
  const slider = (label: string, title: string, get: () => number, put: (v: number) => void, test: string, min = 0, def = 50) => {
    h('div', 'lbl', r2, label).title = title;
    range(fp, r2, { get, set: (v) => set(() => put(v)), min, max: 100, def, format: (v) => v + '%', width: 130, title }).dataset.test = test;
  };
  slider('WILDNESS', 'How strictly each sound follows its instrument’s recipe. Low: a conventional kick is a kick. High: unusual shapes, envelopes and identities. The same 0-100 % as GENERATE KIT.', () => Math.round(fs.wildness * 100), (v) => (fs.wildness = v / 100), 'factory-wildness', Math.round(WILDNESS_MIN * 100), 60);
  slider('VARIATION', 'How far each sound strays from the batch’s anchor design. 0: one sound, nearly. 100: every sound its own design.', () => fs.variation, (v) => (fs.variation = v), 'factory-variation', 0, 70);
  slider('DIVERSITY', 'How far apart the RENDERED sounds must be. Low: related sounds are welcome. High: a sound too like an earlier one is drawn again (up to three times) and the most different attempt kept.', () => fs.diversity, (v) => (fs.diversity = v), 'factory-diversity', 0, 50);
  const r2b = h('div', 'row sndtop', pane);
  h('div', 'lbl', r2b, 'SEED').title = 'The seed of the next batch. The same seed, settings and an empty collection make the same sounds.';
  const sh = h('div', 'grow', r2b);
  seedField(fp, sh, { get: () => app.seedSlot('factory').value, fixed: () => app.seedSlot('factory').fixed, onFixed: (on) => app.setSeedFixed('factory', on), onInput: (t) => void app.setSeedInput('factory', t), onRoll: () => app.rollSeed('factory'), onClear: () => app.clearSeed('factory'), test: 'factory-seed' });

  // ---------------------------------------------------------------- run
  const r3 = h('div', 'row wrap sndtop', pane);
  button(fp, r3, 'GENERATE', () => void fs.generate(), { cls: 'med', disabled: busy, title: 'Make the batch: every sound is designed, rendered by the LXR engine, measured and checked. The kit does not change.' }).dataset.test = 'factory-generate';
  button(fp, r3, 'CANCEL', () => fs.cancel(), { cls: 'med', disabled: () => !fs.job || fs.job.cancelling, title: 'Stop after the sounds being rendered now. What is done stays; RETRY finishes the rest.' }).dataset.test = 'factory-cancel';
  button(fp, r3, 'RETRY', () => void fs.retry(), { cls: 'med', disabled: () => busy() || !fs.sounds.some((s) => s.status === 'failed' || s.status === 'cancelled'), title: 'Render again the sounds that failed or were cancelled' }).dataset.test = 'factory-retry';
  button(fp, r3, 'REGENERATE', () => void fs.regenerateSelected(), { cls: 'med', disabled: () => busy() || !fs.selected.length, title: 'Draw the selected sounds again (same slot and seed, next draw). They replace the old ones; favourites stay marked.' }).dataset.test = 'factory-regen';
  button(fp, r3, 'CLEAR', () => (fs.sounds.some((s) => s.favourite) ? fs.clear(false) : fs.clear(true)), { cls: 'med', disabled: () => busy() || !fs.sounds.length, title: 'Remove the sounds, except favourites' }).dataset.test = 'factory-clear';
  button(fp, r3, 'CLEAR ALL', () => fs.clear(true), { cls: 'small', disabled: () => busy() || !fs.sounds.some((s) => s.favourite), title: 'Remove everything, favourites too' }).dataset.test = 'factory-clear-all';
  button(fp, r3, 'STOP', () => fs.stop(), { cls: 'small', disabled: () => !fs.playing });
  const bar = h('div', 'fbar grow', r3);
  const fill = h('div', 'fill', bar);
  const barText = h('div', 'ftext', bar);
  bar.dataset.test = 'factory-progress';
  fp.add(() => {
    const j = fs.job;
    const c = fs.counts();
    const pct = j ? (j.total ? j.done / j.total : 1) : 0;
    fill.style.width = Math.round(pct * 100) + '%';
    barText.textContent = j
      ? `${j.kind.toUpperCase()} ${j.done}/${j.total}${j.failed ? ` · ${j.failed} FAILED` : ''}${j.cancelling ? ' · CANCELLING…' : ''}`
      : c.total
        ? `${c.total} SOUNDS · ${c.selected} SELECTED · ${c.favourites} ★ · ${c.flagged} FLAGGED${c.failed ? ` · ${c.failed} FAILED` : ''}${c.queued ? ` · ${c.queued} NOT RENDERED` : ''}`
        : 'NOTHING GENERATED YET';
  });

  // ---------------------------------------------------------------- the browser's controls
  const r4 = h('div', 'row wrap sndtop', pane);
  h('div', 'lbl', r4, 'SORT');
  select(fp, r4, { options: () => SORTS.map((s) => ({ value: s.id as string, label: s.label })), get: () => fs.view.sort, set: (v) => fs.setView({ sort: v as SortKey }), width: 150, title: 'Sounds without a trustworthy pitch go last when sorting by pitch. SIMILARITY: closest to the reference sound first (✱ on a row sets it).' }).dataset.test = 'factory-sort';
  button(fp, r4, 'DESC', () => fs.setView({ desc: !fs.view.desc }), { cls: 'small', on: () => fs.view.desc, title: 'Reverse the order' }).dataset.test = 'factory-desc';
  h('div', 'lbl', r4, 'SHOW');
  select(fp, r4, { options: () => [{ value: 'all', label: 'ALL KINDS' }, ...FACTORY_INSTRUMENTS.filter((i) => i.id !== 'mixed').map((i) => ({ value: i.id as string, label: i.label }))], get: () => fs.view.instrument, set: (v) => fs.setView({ instrument: v as Instrument | 'all' }), width: 120 }).dataset.test = 'factory-filter-instrument';
  select(fp, r4, { options: () => [{ value: 'all', label: 'ALL QUALITY' }, { value: 'passing', label: 'PASSING' }, { value: 'flagged', label: 'FLAGGED' }], get: () => fs.view.qc, set: (v) => fs.setView({ qc: v as 'all' | 'passing' | 'flagged' }), width: 110, title: 'Show every sound, only those that pass the quality checks (or were accepted), or only the flagged ones' }).dataset.test = 'factory-filter-qc';
  button(fp, r4, '★ ONLY', () => fs.setView({ favourites: !fs.view.favourites }), { cls: 'small', on: () => fs.view.favourites, title: 'Only favourites' }).dataset.test = 'factory-filter-fav';
  button(fp, r4, 'SELECTED', () => fs.setView({ selectedOnly: !fs.view.selectedOnly }), { cls: 'small', on: () => fs.view.selectedOnly, title: 'Only selected sounds' }).dataset.test = 'factory-filter-sel';
  button(fp, r4, 'SELECT ALL', () => report(fs.selectVisible(true)), { cls: 'small', title: 'Select every sound in view (with the quality filter on, sounds that failed a check are left out)' }).dataset.test = 'factory-select-all';
  button(fp, r4, 'NONE', () => fs.selectVisible(false), { cls: 'small', title: 'Deselect every sound in view' }).dataset.test = 'factory-select-none';
  button(fp, r4, 'INVERT', () => fs.invertVisible(), { cls: 'small', title: 'Swap selected and unselected in view' });
  button(fp, r4, 'QC FILTER', () => set(() => fs.setQcStrict(!fs.qcStrict)), { cls: 'small', on: () => fs.qcStrict, title: 'ON: sounds that FAIL a quality check (silent, invalid, vanishing, heavy DC offset) are not selected in bulk or exported unless you accept them with KEEP. OFF: nothing is held back. Warnings never hold anything back.' }).dataset.test = 'factory-qc-strict';
  const report = (n: number) => {
    const held = fs.visible().filter((s) => s.status === 'ready' && !s.selected && fs.qcStrict && !s.keep && s.info?.flags.some((f) => f.severity === 'fail')).length;
    if (held) toast(`${n} SELECTED · ${held} FAILING SOUND${held === 1 ? '' : 'S'} LEFT OUT (KEEP ACCEPTS ONE, THE QUALITY FILTER OFF ALL)`, 'info');
  };

  // ---------------------------------------------------------------- the sounds
  const list = h('div', 'flist sndscroll', pane);
  list.dataset.test = 'factory-list';
  const rows = new Map<string, { el: HTMLElement; rev: number; playing: boolean; ref: boolean; strict: boolean }>();
  const drawWave = (cv: HTMLCanvasElement, s: FactorySound) => {
    const peaks = s.info?.wave;
    if (!peaks) return;
    const W = 96;
    const H = 24;
    cv.width = W;
    cv.height = H;
    const g = cv.getContext('2d');
    if (!g) return;
    const cs = getComputedStyle(cv);
    g.fillStyle = cs.getPropertyValue('--paper').trim() || '#fff';
    g.fillRect(0, 0, W, H);
    g.fillStyle = cs.getPropertyValue('--ink').trim() || '#000';
    const bw = W / peaks.length;
    for (let i = 0; i < peaks.length; i++) {
      const hgt = Math.max(1, Math.round(peaks[i]! * (H - 2)));
      g.fillRect(Math.floor(i * bw), Math.floor((H - hgt) / 2), Math.max(1, Math.ceil(bw) - 1), hgt);
    }
  };
  const fillRow = (el: HTMLElement, s: FactorySound) => {
    el.innerHTML = '';
    el.className = 'frow' + (s.selected ? ' sel' : '') + (s.status === 'failed' ? ' failed' : '') + (fs.playing === s.id ? ' playing' : '') + (statusOf(s) === 'fail' && !s.keep ? ' bad' : '');
    el.dataset.test = 'factory-row';
    el.dataset.id = s.id;
    const spec = INSTRUMENT_SPECS[s.instrument];
    const check = h('div', 'fcheck' + (s.selected ? ' on' : ''), el, s.selected ? '■' : '□');
    check.title = 'Select this sound';
    check.dataset.test = 'factory-check';
    check.addEventListener('click', () => fs.select(s.id));
    const star = h('div', 'fstar' + (s.favourite ? ' on' : ''), el, s.favourite ? '★' : '☆');
    star.title = 'Favourite: CLEAR keeps favourites';
    star.dataset.test = 'factory-fav';
    star.addEventListener('click', () => fs.favourite(s.id));
    const play = h('button', 'btn small fplay', el, s.status === 'ready' ? '▶' : '…');
    play.disabled = s.status !== 'ready';
    play.title = 'Audition: rendered by the LXR engine and played on its own';
    play.dataset.test = 'factory-play';
    play.addEventListener('click', () => void fs.audition(s.id));
    if (s.status !== 'ready') {
      const name = h('div', 'fname', el);
      h('div', '', name, `${spec.label} ${String(s.serial).padStart(3, '0')}`);
      h('div', 'tiny', name, s.status === 'failed' ? `FAILED: ${(s.error ?? '').toUpperCase()}` : s.status === 'cancelled' ? 'CANCELLED · RETRY RENDERS IT' : s.status === 'rendering' ? 'RENDERING…' : 'QUEUED');
      return;
    }
    const i = s.info!;
    const cv = h('canvas', 'fwave', el);
    drawWave(cv, s);
    const name = h('div', 'fname', el);
    h('div', '', name, `${spec.label} ${String(s.serial).padStart(3, '0')}`).title = `${s.candidate.name} · generation order ${s.order} · ${VOICES[s.candidate.voice]}`;
    h('div', 'tiny', name, `${characterLabel(s.made.character)} ${s.made.wildness}%${s.draw ? ' · DRAW ' + s.draw : ''}${s.attempt ? ' · TRY ' + (s.attempt + 1) : ''}`);
    h('div', 'fpitch', el, i.pitch.reliable ? i.pitch.text : i.pitch.kind === 'skipped' ? i.word : i.pitch.text).title = i.pitch.reliable ? 'Measured pitch (the TUNER’s analysis)' : i.pitch.kind === 'skipped' ? 'No pitch is measured for this instrument: a word for how it sounds' : 'No trustworthy single pitch: no note is given';
    h('div', 'fnum', el, i.seconds.toFixed(2) + ' S').title = 'Duration of the render';
    h('div', 'fnum', el, db(i.peak) + ' DB').title = 'Peak level before normalisation';
    const fl = flagsOf(s);
    const flags = h('div', 'fflags', el);
    for (const f of fl) h('span', 'dtag' + (f.severity === 'fail' ? ' fail' : ''), flags, f.id === 'duplicate' ? 'DUP' : f.id.toUpperCase()).title = f.text;
    if (!fl.length) h('span', 'tiny', flags, 'OK');
    const acts = h('div', 'row fact', el);
    const b = (label: string, title: string, fn: () => void, on = false) => {
      const x = h('button', 'btn small' + (on ? ' on' : ''), acts, label);
      x.title = title;
      x.addEventListener('click', fn);
      return x;
    };
    if (statusOf(s) === 'fail') b('KEEP', 'Accept this sound although it fails a quality check', () => fs.keep(s.id), s.keep).dataset.test = 'factory-keep';
    b('✱', 'Make this the reference for SIMILARITY sorting', () => fs.setView({ reference: s.id, sort: 'similarity' }), fs.view.reference === s.id);
    b('KIT', 'Send to a kit slot (one undo step)', () => sendDialog(s)).dataset.test = 'factory-send';
  };
  const sendDialog = (s: FactorySound) => {
    const box = dialog(`SEND ${s.candidate.name} TO A KIT SLOT`, 520);
    h('p', '', box, 'The sound becomes the voice of the slot you choose. One undo step: UNDO brings the old voice back. Parameter locks are kept.');
    const grid = h('div', 'row wrap', box);
    VOICES.forEach((vn, k) => {
      const x = h('button', 'btn med' + (k === s.candidate.voice ? ' on' : ''), grid, `${k + 1} · ${vn}`);
      x.dataset.test = 'factory-slot-' + k;
      x.addEventListener('click', () => {
        closeDialog();
        fs.sendToKit(s.id, k);
      });
    });
    buttons(box, [['CANCEL', closeDialog]]);
  };
  const drawList = () => {
    const vis = fs.visible();
    const keep = new Set(vis.map((s) => s.id));
    for (const [id, r] of rows)
      if (!keep.has(id) || !fs.byId(id)) {
        r.el.remove();
        rows.delete(id);
      }
    const ref = fs.view.reference;
    vis.forEach((s, k) => {
      let r = rows.get(s.id);
      const playing = fs.playing === s.id;
      if (!r) rows.set(s.id, (r = { el: h('div', 'frow'), rev: -1, playing: false, ref: false, strict: fs.qcStrict }));
      if (r.rev !== s.rev || r.playing !== playing || r.ref !== (ref === s.id) || r.strict !== fs.qcStrict) {
        fillRow(r.el, s);
        r.rev = s.rev;
        r.playing = playing;
        r.ref = ref === s.id;
        r.strict = fs.qcStrict;
      }
      if (list.children[k] !== r.el) list.insertBefore(r.el, list.children[k] ?? null);
    });
    if (!vis.length) {
      if (!list.querySelector('.fempty')) h('div', 'hint fempty', list, fs.sounds.length ? 'NO SOUND MATCHES THE FILTERS.' : 'GENERATE A BATCH TO BEGIN. EVERY SOUND IS RENDERED BY THE LXR ENGINE; THE KIT IS NOT TOUCHED.');
    } else list.querySelector('.fempty')?.remove();
  };
  fp.add(drawList);

  // ---------------------------------------------------------------- using the sounds
  const out = h('div', 'col fout', pane);
  const o1 = h('div', 'row wrap', out);
  const selectedLine = h('div', 'report grow', o1);
  fp.add(() => {
    const p = fs.packState;
    if (p.running) {
      selectedLine.textContent = p.progress ? `${p.progress.stage.toUpperCase()} ${p.progress.done}/${p.progress.total} ${p.progress.file ?? ''}` : 'STARTING…';
      return;
    }
    const { ok, blocked } = fs.exportable();
    selectedLine.textContent = p.last && !fs.selected.length ? p.last.text : fs.selected.length ? `${fs.selected.length} SELECTED · ${ok.length} CAN BE EXPORTED${blocked.length ? ` · ${blocked.length} HELD BACK BY THE QUALITY FILTER` : ''}` : (p.last?.text ?? 'SELECT SOUNDS TO SEND, SAVE OR EXPORT');
  });
  button(fp, o1, 'SEND TO KIT', () => {
    const sel = fs.selected;
    if (sel.length === 1) sendDialog(sel[0]!);
  }, { cls: 'med', disabled: () => fs.selected.length !== 1, title: 'Make the one selected sound the voice of a kit slot. One undo step.' }).dataset.test = 'factory-send-selected';
  button(fp, o1, 'SAVE', () => {
    try {
      toast(`SAVED ${fs.saveToLibrary(fs.selected)} TO THE LIBRARY (SOUND > DISCOVER)`, 'info');
    } catch (e) {
      toast(e instanceof Error ? e.message.toUpperCase() : 'SAVE FAILED', 'error');
    }
  }, { cls: 'med', disabled: () => !fs.selected.length, title: 'Save the selected sounds to the sound library (SOUND > DISCOVER can load them)' }).dataset.test = 'factory-save';
  button(fp, o1, 'EXPORT PACK', () => void fs.exportPack(), { cls: 'med', disabled: () => fs.packState.running || !fs.selected.length, title: 'The selected sounds as a ZIP: one folder per instrument, CLATTER_KICK_C2_001.wav style names, and pack.json with the seeds and synthesis parameters' }).dataset.test = 'factory-export';
  button(fp, o1, 'CANCEL EXPORT', () => fs.cancelPack(), { cls: 'small', disabled: () => !fs.packState.running || fs.packState.cancelling }).dataset.test = 'factory-export-cancel';
  button(fp, o1, 'IMPORT PACK…', async () => {
    for (const f of await chooseFiles('.zip,.json', false)) {
      try {
        const n = await fs.importPack(new Uint8Array(await f.arrayBuffer()));
        toast(`${n} SOUNDS IMPORTED`, 'info');
      } catch (e) {
        toast(e instanceof Error ? e.message.toUpperCase() : 'IMPORT FAILED', 'error');
      }
    }
  }, { cls: 'small', disabled: busy, title: 'Add the sounds of a CLATTER sample pack (its ZIP or pack.json) to the collection. They are rendered again from their synthesis parameters.' }).dataset.test = 'factory-import';

  const o2 = h('div', 'row wrap', out);
  h('div', 'lbl', o2, 'PACK').title = 'How the pack is written: the kit exporter’s formats, levels and render choices';
  select(fp, o2, { options: () => (Object.keys(WAV_FORMATS) as WavFormat[]).map((f) => ({ value: f as string, label: WAV_FORMATS[f].label })), get: () => fs.pack.format, set: (v) => set(() => (fs.pack.format = v as WavFormat)), width: 150, title: 'The WAV formats the kit exporter writes' }).dataset.test = 'factory-format';
  h('div', 'tiny', o2, '44.1 KHZ').title = 'The engine renders at 44.1 kHz and, like the kit exporter, CLATTER does not resample';
  select(fp, o2, { options: () => [{ value: 'dry', label: 'DRY' }, { value: 'wet', label: 'WET' }, { value: 'both', label: 'DRY + WET' }], get: () => fs.pack.processing, set: (v) => set(() => (fs.pack.processing = v as PackProcessing)), width: 100, title: 'DRY: the voice as the engine makes it. WET: through the channel strip and FX send of the track that plays the same voice in this project.' }).dataset.test = 'factory-processing';
  h('div', 'lbl', o2, 'TAIL');
  select(fp, o2, { options: () => [{ value: 'auto', label: 'AUTO' }, { value: 'custom', label: 'CUSTOM' }], get: () => fs.pack.tail.mode, set: (v) => set(() => (fs.pack.tail.mode = v as 'auto' | 'custom')), width: 90, title: 'AUTO: until the sound has died away. CUSTOM: exactly this many seconds' }).dataset.test = 'factory-tail';
  num(fp, o2, { get: () => fs.pack.tail.seconds, set: (v) => set(() => (fs.pack.tail.seconds = v)), min: 0.05, max: 30, step: 0.05, format: (v) => v.toFixed(2) + ' S', width: 72, title: 'Tail length in seconds (CUSTOM)' }).dataset.test = 'factory-tail-seconds';
  button(fp, o2, 'NORMALISE', () => set(() => (fs.pack.normalise = !fs.pack.normalise)), { cls: 'small', on: () => fs.pack.normalise, title: 'Scale every file to -1 dBFS' }).dataset.test = 'factory-normalise';

  subscribe(app, ['factory', 'discover', 'project', 'kit'], () => fp.refresh());
  return {
    panels: [fp],
    active: (on) => {
      if (!on) return;
      fp.refresh();
    },
  };
}
