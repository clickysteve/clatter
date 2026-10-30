/**
 * SOUND: what makes the sound. A track sidebar that is always there (name, voice, source, mute
 * and solo) and nine workspaces:
 *
 *   SYNTH       source (SYNTH, SAMPLE or HYBRID), BASE / A-D, the LXR voice's parameters
 *   SAMPLE      the sample layer (of the base sound, or of the variation being edited), sample sets
 *   MODULATION  sources (LFOs, envelopes, step, random...), editor, routing matrix (soundMod.ts)
 *   VARIATIONS  BASE against A-D, overrides, step usage, the sound generators (soundVar.ts)
 *   MIXER       channels with processing, bus processing, master (soundMix.ts)
 *   FX          the LXR FX bus and who feeds it (soundMix.ts)
 *   TUNER       the audible pitch of the selected sound, found in the rendered audio (soundTuner.ts)
 *   SCALE       the global scale and each track's scale: OFF, GLOBAL or CUSTOM (soundScale.ts)
 *   KITS        synth kits, sample sets, full kits, generation, voice locks (soundKits.ts)
 *
 * The page does not scroll: each tab scrolls inside its own pane when it needs to. Switching tabs
 * only shows and hides panes, so nothing is lost; the open tab is remembered.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import type { App } from '../../app/app';
import { SOUND_TABS, type SoundTab } from '../../app/prefs';
import { SLOT_NAMES, type SamplePick } from '../../model/types';
import { GROUPS, TRIGGERS, VOICE_PARAMS, VOICES } from '../../sound/lxrParams';
import { importSamples } from '../menu';
import { importFolder, importZip, kitLibraryDialog } from '../kitDialogs';
import { button, ctl, download, group, h, Panel, range, select, win } from '../widgets';
import { subscribe, type View } from './patternView';
import { editingText, editVoice, paramCtl, slotBar, sourceStrip, viewVoice } from './soundControls';
import { kitsPane } from './soundKits';
import { fxPane, mixerPane } from './soundMix';
import { modulationPane } from './soundMod';
import { tunerPane } from './soundTuner';
import { scalePane } from './soundScale';
import { discoverPane } from './soundDiscover';
import { factoryPane } from './soundFactory';
import { db, type PaneParts } from './soundUi';
import { variationsPane } from './soundVar';
import { font } from '../scale';
import { describeScale, shortScale, trackScaleState } from '../../music/scale';

const TAB_LABEL: Record<SoundTab, string> = { synth: 'SYNTH', sample: 'SAMPLE', modulation: 'MODULATION', variations: 'VARIATIONS', mixer: 'MIXER', fx: 'FX', tuner: 'TUNER', scale: 'SCALE', discover: 'DISCOVER', factory: 'FACTORY', kits: 'KITS' };
const TAB_TITLE: Record<SoundTab, string> = {
  synth: 'The selected track’s source, BASE / A-D and the LXR voice parameters',
  sample: 'The sample layer of the base sound or of the variation being edited, and sample sets',
  modulation: 'LFOs, envelopes, step modulation, random sources and macros, routed to any parameter',
  variations: 'The base sound beside variations A-D: overrides, step usage, conditional steps, the sound generators',
  mixer: 'Every channel with its processing, the bus processing and the master',
  fx: 'The LXR FX bus and which tracks feed it',
  tuner: 'The audible pitch of the selected sound: note, frequency, cents, confidence and pitch movement, measured in the rendered audio',
  scale: 'Musical scale quantisation: the global scale and each track’s OFF, GLOBAL or CUSTOM setting, and what the scale does to every sound',
  discover: 'SOUND DISCOVERY: eight candidate sounds for this instrument, auditioned through the LXR engine, compared with the original, mutated, saved and applied only when you say',
  factory: 'SAMPLE FACTORY: generate dozens of rendered, quality-checked sounds, audition and curate them, and export the best as a sample pack',
  kits: 'Synth kits, sample sets and full kits: save, load, import, export, generate, lock voices',
};
const MODE_TAG = { synth: 'SYN', sample: 'SMP', hybrid: 'HYB' } as const;

type SampleKey = 'tune' | 'fine' | 'gain' | 'pan' | 'reverse';

export function soundView(app: App, screen: HTMLElement): View {
  const root = h('div', 'view sound-view', screen);
  root.dataset.view = 'sound';
  const t = () => app.track;
  const sideMeters: HTMLDivElement[] = [];
  const voiceMeters: HTMLDivElement[] = [];

  // ================================================================ the track sidebar (always there)
  const lw = win(root, { title: 'TRACKS', area: 'sound', id: 'tracks' });
  lw.el.classList.add('sound-side');
  const lp = new Panel();
  lw.body.classList.add('col', 'sidebody');
  const list = h('div', 'sidelist', lw.body);
  const buildList = () => {
    list.innerHTML = '';
    sideMeters.length = 0;
    for (const tr of app.project.tracks) {
      const x = () => app.project.tracks.find((y) => y.id === tr.id) ?? tr;
      const li = h('div', 'sidetrack', list);
      li.dataset.track = tr.id;
      li.addEventListener('click', () => app.selectTrack(tr.id));
      li.addEventListener('dblclick', () => void app.audition(tr.id));
      const top = h('div', 'row', li);
      const nm = h('div', 'grow sname', top);
      const lock = h('div', 'tiny scaletag', top);
      const mode = h('div', 'tiny modetag', top);
      const bot = h('div', 'row', li);
      const src = h('div', 'tiny grow', bot);
      const ms = h('div', 'row msbtns', bot);
      const stop = (e: Event) => e.stopPropagation();
      ms.addEventListener('click', stop);
      ms.addEventListener('dblclick', stop);
      button(lp, ms, 'M', () => app.setTrackMix(tr.id, { mute: !x().mix.mute }), { cls: 'small', on: () => x().mix.mute, title: 'Mute' });
      button(lp, ms, 'S', () => app.setTrackMix(tr.id, { solo: !x().mix.solo }), { cls: 'small', on: () => x().mix.solo, title: 'Solo' });
      const met = h('div', 'meter h sidemeter', li);
      sideMeters.push(h('div', 'lvl', met));
      lp.add(() => {
        const s = x();
        li.classList.toggle('on', app.ui.track === s.id);
        nm.textContent = s.name;
        const sc = trackScaleState(app.project, s).spec;
        lock.textContent = sc ? '♪ ' + shortScale(sc) : '';
        lock.title = sc ? 'Scale-locked: ' + describeScale(sc) : '';
        mode.textContent = MODE_TAG[s.sound.mode];
        mode.title = s.sound.mode.toUpperCase();
        const names = s.sound.samples.map((id) => app.library.get(id)?.name ?? '?').join(', ');
        const nv = s.sound.variations?.filter(Boolean).length ?? 0;
        src.textContent = (s.sound.mode === 'sample' ? names.slice(0, 12) || 'NO SAMPLE' : TRIGGERS[s.sound.trigger]!) + (nv ? ` · ${nv}V` : '');
      });
    }
  };
  buildList();
  subscribe(app, ['tracks', 'selection', 'kit', 'library', 'project', 'mix', 'status', 'scale'], () => lp.refresh());
  app.on('project', buildList);

  // ================================================================ the main column: tabs, panes, status
  const main = h('div', 'sound-main', root);
  const bar = h('div', 'wsbar', main);
  bar.setAttribute('role', 'tablist');
  const info = h('div', 'wsinfo', bar);
  const panesEl = h('div', 'sndpanes', main);
  const status = h('div', 'sndstatus', main);
  const tp = new Panel();
  const parts = new Map<SoundTab, PaneParts>();
  const isOpen = new Map<SoundTab, boolean>();
  const tabEls = {} as Record<SoundTab, HTMLElement>;
  const panes = {} as Record<SoundTab, HTMLElement>;
  for (const [i, id] of SOUND_TABS.entries()) {
    const tab = h('div', 'wstab', bar, TAB_LABEL[id]);
    tab.setAttribute('role', 'tab');
    tab.tabIndex = 0;
    tab.title = TAB_TITLE[id];
    tab.dataset.test = 'sound-tab-' + id;
    tab.addEventListener('click', () => app.setSoundTab(id));
    tab.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        app.setSoundTab(id);
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        const to = SOUND_TABS[(i + (e.key === 'ArrowRight' ? 1 : SOUND_TABS.length - 1)) % SOUND_TABS.length]!;
        app.setSoundTab(to);
        tabEls[to].focus();
      }
    });
    tabEls[id] = tab;
    const pane = h('div', 'sndpane sndpane-' + id, panesEl);
    pane.setAttribute('role', 'tabpanel');
    pane.dataset.test = 'sound-pane-' + id;
    panes[id] = pane;
  }
  bar.insertBefore(info, null);
  tp.add(() => {
    for (const id of SOUND_TABS) {
      const on = app.ui.soundTab === id;
      tabEls[id].classList.toggle('on', on);
      tabEls[id].setAttribute('aria-selected', String(on));
      panes[id].classList.toggle('show', on);
    }
    const x = t();
    info.textContent = `${x.name} · ${x.sound.mode.toUpperCase()} · ${app.ui.slot === null ? 'BASE SOUND' : 'VARIATION ' + SLOT_NAMES[app.ui.slot]}`;
    for (const [id, part] of parts) {
      const on = app.ui.view === 'sound' && app.ui.soundTab === id;
      if (isOpen.get(id) !== on) {
        isOpen.set(id, on);
        part.active?.(on);
      }
    }
  });
  subscribe(app, ['view', 'selection', 'tracks', 'kit'], () => tp.refresh());

  const stp = new Panel();
  stp.add(() => {
    const used = Object.keys(app.pattern.sounds?.[t().id] ?? {}).length;
    status.textContent = `${editingText(app)} · ${used} STEP SOUND${used === 1 ? '' : 'S'} IN THIS PATTERN`;
  });
  subscribe(app, ['kit', 'tracks', 'selection', 'pattern', 'project'], () => stp.refresh());

  // ---------------------------------------------------------------- SYNTH
  const sy = new Panel();
  const syp = panes.synth;
  const tools = h('div', 'col sndtop', syp);
  sourceStrip(app, tools, sy);
  slotBar(app, h('div', 'row wrap', tools), sy);
  const chips = h('div', 'row wrap voicechips', tools);
  VOICES.forEach((vn, v) => {
    const c = button(sy, chips, vn, () => {
      viewVoice(v);
      const owner = app.project.tracks.find((x) => app.voiceOf(x) === v);
      if (owner) app.selectTrack(owner.id);
      else {
        buildSynth(true);
        sy.refresh();
      }
    }, { cls: 'small chip', on: () => editVoice(app) === v, title: 'Edit this voice' });
    voiceMeters.push(h('div', 'lvl', h('div', 'meter h chipmeter', c)));
  });
  const sb = h('div', 'row wrap', tools);
  button(sy, sb, 'BASIC', () => app.setEditMode('basic'), { cls: 'small', on: () => app.ui.editMode === 'basic', title: 'The parameters that matter most' });
  button(sy, sb, 'ADVANCED', () => app.setEditMode('advanced'), { cls: 'small', on: () => app.ui.editMode === 'advanced', title: 'Every parameter of the voice' });
  button(sy, sb, 'LOCK VOICE', () => app.lockVoice(editVoice(app)), { cls: 'small', on: () => !!app.project.soundLocks.voices[editVoice(app)], title: 'GENERATE KIT, MUTATE KIT and EVOLVE leave this voice alone' });
  button(sy, sb, 'MUTATE VOICE', () => void app.mutateKit(0.4, [editVoice(app)]), { cls: 'small', disabled: () => app.ui.busy, title: 'Controlled changes to this voice of the kit' });
  const syinfo = h('div', 'tiny grow', sb);
  const cols = h('div', 'synthcols sndscroll', syp);
  let shown = '';
  const buildSynth = (force = false) => {
    const v = editVoice(app);
    const key = `${v}:${app.ui.editMode}`;
    if (key === shown && !force) return sy.refresh();
    shown = key;
    cols.innerHTML = '';
    const basic = app.ui.editMode === 'basic';
    const params = VOICE_PARAMS[v]!.filter((p) => !basic || p.basic);
    for (const g of GROUPS) {
      const ps = params.filter((p) => p.group === g);
      if (!ps.length) continue;
      const box = group(cols, g);
      box.classList.add('col', 'synthgroup');
      for (const p of ps) paramCtl(app, box, p, sy);
    }
    h('div', 'hint', cols, (basic ? 'ADVANCED shows every parameter. ' : '') + 'The LFO and VELOCITY groups are the LXR’s own modulators; MODULATION has CLATTER’s sources and routing matrix. Alt-click a name to lock it against kit generation ◆. A ◇ marks a value the open variation overrides.');
    sy.refresh();
  };
  sy.add(() => {
    const v = editVoice(app);
    const owners = app.project.tracks.filter((x) => app.voiceOf(x) === v).map((x) => x.name);
    syinfo.textContent = `${VOICES[v]} · ${owners.length ? owners.join(', ') : 'NO TRACK PLAYS THIS VOICE'}`;
  });
  buildSynth();
  subscribe(app, ['kit', 'tracks', 'selection', 'view', 'project'], () => buildSynth());
  app.on('status', () => sy.refresh());

  // ---------------------------------------------------------------- SAMPLE
  const sp = new Panel();
  const sethead = h('div', 'row wrap sethead', panes.sample);
  h('div', 'lbl', sethead, 'SAMPLE SET');
  const setName = h('div', 'setname', sethead);
  setName.dataset.test = 'set-name';
  sp.add(() => {
    const km = app.kitm;
    const dirty = !!km && km.session.currentId !== null && km.session.dirty;
    setName.textContent = (km?.setName ?? 'NONE') + (dirty ? ' · UNSAVED' : '');
    setName.title = 'The sample set on the tracks. A set is the samples of all tracks with their playback settings; the synth kit is separate.';
  });
  button(sp, sethead, 'LOAD SET…', () => kitLibraryDialog(app, 'set'), { title: 'Choose a saved sample set; it shows which tracks change before loading. The synth kit is not touched.' }).dataset.test = 'set-load';
  button(sp, sethead, 'SAVE SET', () => {
    const km = app.kitm;
    if (!km) return;
    if (km.session.currentId) {
      void km.session.save().then(() => app.say(`SAMPLE SET ${km.session.name} SAVED`), (e) => app.say(String(e instanceof Error ? e.message : e)));
    } else kitLibraryDialog(app, 'set', '', km.setName === 'NONE' ? '' : km.setName);
  }, { title: 'Save the samples on the tracks to the current set (or name a new one)' }).dataset.test = 'set-save';
  button(sp, sethead, 'IMPORT FOLDER…', () => void importFolder(app), { title: 'A folder of drum samples: CLATTER proposes which sample goes on which track' }).dataset.test = 'set-import-folder';
  button(sp, sethead, 'IMPORT ZIP…', () => void importZip(app), { title: 'A ZIP of drum samples or a .kit.zip' }).dataset.test = 'set-import-zip';
  button(sp, sethead, 'EXPORT SET', () => {
    const km = app.kitm;
    if (!km) return;
    void km.exportCurrent('set', km.setName === 'NONE' ? app.project.name : km.setName).then((f) => download(f.name, f.data, f.type), (e) => app.say(`EXPORT FAILED: ${e instanceof Error ? e.message : String(e)}`));
  }, { title: 'The samples on the tracks as a portable .kit.zip (manifest, audio, assignments, playback settings)' }).dataset.test = 'set-export';
  button(sp, sethead, 'LIBRARY…', () => kitLibraryDialog(app, 'set'), { title: 'Browse, rename, duplicate, delete, import and export sample sets, synth kits and full kits' });
  subscribe(app, ['kits', 'project'], () => sp.refresh());
  const sbody = h('div', 'sample-body sndscroll', panes.sample);
  const sb1 = h('div', 'col', sbody);
  const sb2 = h('div', 'col', sbody);
  const note = h('div', 'hint', sb1);
  sp.add(() => {
    const sl = app.ui.slot;
    note.textContent = t().sound.mode === 'synth' ? 'THIS IS A SYNTH TRACK: CHOOSE SAMPLE OR HYBRID IN THE SYNTH TAB TO PLAY SAMPLES.' : sl === null ? 'EDITING THE BASE SAMPLE SETTINGS OF THIS TRACK.' : `EDITING VARIATION ${SLOT_NAMES[sl]}: A ◇ MARKS A SETTING THAT OVERRIDES THE TRACK’S (CLICK ITS NAME TO FOLLOW THE TRACK AGAIN).`;
  });
  const wave = h('div', 'wave', sb1);
  const wc = h('canvas', '', wave);
  wave.title = 'Drag: region start (left half) or end (right half)';
  const current = () => app.library.get(t().sound.samples[0] ?? '');
  const drawWave = () => {
    const W = wave.clientWidth - 4;
    const H = wave.clientHeight - 4;
    if (W < 10 || H < 10) return;
    const dpr = window.devicePixelRatio || 1;
    wc.width = Math.round(W * dpr);
    wc.height = Math.round(H * dpr);
    const g = wc.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cs = getComputedStyle(wave);
    const ink = cs.getPropertyValue('--ink').trim() || '#000';
    const paper = cs.getPropertyValue('--paper').trim() || '#fff';
    g.fillStyle = paper;
    g.fillRect(0, 0, W, H);
    const s = current();
    g.fillStyle = ink;
    if (!s) {
      g.font = `${font(18)}px VT323, monospace`;
      g.textBaseline = 'middle';
      g.fillText(t().sound.mode === 'synth' ? 'SYNTH TRACK: NO SAMPLE' : 'NO SAMPLE: CHOOSE ONE BELOW', 10, H / 2);
      return;
    }
    const n = s.peaks.length;
    const mid = H / 2;
    for (let i = 0; i < W; i++) {
      const pk = s.peaks[Math.floor((i / W) * n)] ?? 0;
      const hh = Math.max(1, pk * (H - 4) * 0.5);
      g.fillRect(i, mid - hh, 1, hh * 2);
    }
    const a = t().sound.start * W;
    const b = t().sound.end * W;
    g.fillStyle = paper;
    for (let y = 0; y < H; y += 2) {
      for (let x = (y / 2) % 2; x < a; x += 2) g.fillRect(x, y, 1, 1);
      for (let x = Math.ceil(b) + ((y / 2) % 2); x < W; x += 2) g.fillRect(x, y, 1, 1);
    }
    g.fillStyle = ink;
    g.fillRect(Math.floor(a), 0, 2, H);
    g.fillRect(Math.min(W - 2, Math.floor(b)), 0, 2, H);
  };
  new ResizeObserver(() => drawWave()).observe(wave);
  let waveDrag: 'start' | 'end' | null = null;
  const waveAt = (e: PointerEvent) => {
    const r = wc.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / (r.width || 1)));
  };
  wave.addEventListener('pointerdown', (e) => {
    if (!current()) return;
    const x = waveAt(e);
    const s = t().sound;
    waveDrag = Math.abs(x - s.start) < Math.abs(x - s.end) ? 'start' : 'end';
    wave.setPointerCapture(e.pointerId);
    app.beginDrag('REGION');
    wave.dispatchEvent(new PointerEvent('pointermove', e));
  });
  wave.addEventListener('pointermove', (e) => {
    if (!waveDrag) return;
    const x = waveAt(e);
    const s = t().sound;
    if (waveDrag === 'start') app.setTrackSound(t().id, { start: Math.min(x, s.end - 0.01) }, 'REGION');
    else app.setTrackSound(t().id, { end: Math.max(x, s.start + 0.01) }, 'REGION');
  });
  const waveUp = () => {
    if (waveDrag) app.endDrag();
    waveDrag = null;
  };
  wave.addEventListener('pointerup', waveUp);
  wave.addEventListener('pointercancel', waveUp);
  wave.addEventListener('dblclick', () => app.setTrackSound(t().id, { start: 0, end: 1 }, 'REGION'));
  sp.add(drawWave);
  const sinfo = h('div', 'report', sb1);
  sp.add(() => {
    const s = current();
    sinfo.textContent = s ? `${s.name} · ${s.duration.toFixed(2)} S · ${s.rate} HZ · ${s.channels.length > 1 ? 'STEREO' : 'MONO'}${s.bundled ? ' · BUNDLED' : ''}` : '';
  });
  /** a sample setting of the sound being edited (a variation overrides the track's) */
  const sampleRange = (label: string, key: SampleKey, title: string, o: { min: number; max: number; scale?: number; def: number; bip?: boolean; format?: (v: number) => string }) => {
    const c = ctl(sb1, label, title);
    const k = o.scale ?? 1;
    const mark = h('span', 'lock', c.name);
    sp.add(() => {
      const over = app.sampleOverridden(key);
      mark.textContent = over ? '◇' : '';
      c.row.classList.toggle('overridden', over);
    });
    c.name.addEventListener('click', () => app.sampleOverridden(key) && app.setEditedSample({ [key]: t().sound[key] }, label));
    range(sp, c.slot, { get: () => Math.round((app.sampleValue(key) as number) * k), set: (v) => app.setEditedSample({ [key]: v / k }, label), min: o.min, max: o.max, def: o.def, bip: o.bip, format: o.format, begin: () => app.beginDrag(label), end: () => app.endDrag(), title });
  };
  const sgn = (v: number) => (v > 0 ? '+' : '') + v;
  sampleRange('TUNE', 'tune', 'Sample pitch in semitones', { min: -24, max: 24, def: 0, bip: true, format: sgn });
  sampleRange('FINE', 'fine', 'Cents', { min: -100, max: 100, def: 0, bip: true, format: (v) => sgn(v) + 'C' });
  sampleRange('GAIN', 'gain', 'Sample gain before the mixer', { min: 0, max: 200, scale: 100, def: 100, format: (v) => v + '%' });
  sampleRange('PAN', 'pan', 'Sample pan before the mixer', { min: -100, max: 100, scale: 100, def: 0, bip: true });
  const pr = h('div', 'row wrap', sb1);
  button(sp, pr, 'REVERSE', () => app.setEditedSample({ reverse: !app.sampleValue('reverse') }, 'REVERSE'), { on: () => !!app.sampleValue('reverse') });
  h('div', 'lbl', pr, 'PICK');
  select(sp, pr, {
    options: () => (['first', 'cycle', 'random', 'velocity'] as SamplePick[]).map((v) => ({ value: v, label: v.toUpperCase() })),
    get: () => t().sound.pick,
    set: (v) => app.setTrackSound(t().id, { pick: v }, 'PICK'),
    title: 'Which of the track’s samples a hit plays (a hit can also name its own in the step editor)',
  });
  button(sp, pr, 'HIT WAV', async () => {
    try {
      const f = await app.exportHit(t().id);
      download(f.name, f.data, f.type);
    } catch (err) {
      app.say(`EXPORT FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, { title: 'Export this track’s sound as a one-shot WAV' });
  h('div', 'hint', sb2, 'ON THIS TRACK');
  const onTrack = h('div', 'list', sb2);
  h('div', 'hint', sb2, 'LIBRARY · CLICK: ASSIGN · SHIFT-CLICK: ADD · ▶ HEAR');
  const lib = h('div', 'list liblist', sb2);
  const libRow = h('div', 'row', sb2);
  button(sp, libRow, 'IMPORT…', () => void importSamples(app, t().id), { cls: 'grow', title: 'Import WAV, AIFF, MP3, OGG, FLAC: assigned to this track' }).dataset.test = 'import';
  const filter = h('div', 'hint', libRow);
  const buildLib = () => {
    onTrack.innerHTML = '';
    for (const id of t().sound.samples) {
      const s = app.library.get(id);
      const li = h('div', 'li', onTrack);
      h('div', 'grow', li, s?.name ?? 'MISSING SAMPLE');
      const pv = h('button', 'btn small', li, '▶');
      pv.title = 'Hear it';
      pv.addEventListener('click', () => void app.previewSample(id));
      const rm = h('button', 'btn small', li, '×');
      rm.title = 'Remove from this track';
      rm.addEventListener('click', () => app.removeSample(t().id, id));
    }
    if (!t().sound.samples.length) h('div', 'li', onTrack, 'NO SAMPLES ON THIS TRACK');
    lib.innerHTML = '';
    const items = app.library.list();
    filter.textContent = `${items.length} SAMPLES`;
    for (const s of items) {
      const li = h('div', 'li' + (t().sound.samples.includes(s.id) ? ' on' : ''), lib);
      li.dataset.sample = s.name;
      h('div', 'grow', li, s.name);
      h('div', 'tiny', li, s.role.toUpperCase());
      const pv = h('button', 'btn small', li, '▶');
      pv.title = 'Hear it';
      pv.addEventListener('click', (e) => {
        e.stopPropagation();
        void app.previewSample(s.id);
      });
      li.addEventListener('click', (e) => app.assignSample(t().id, s.id, e.shiftKey));
    }
  };
  buildLib();
  subscribe(app, ['tracks', 'selection', 'library', 'project', 'kit'], () => {
    buildLib();
    sp.refresh();
  });
  window.addEventListener('clatter-palette', drawWave);

  // ---------------------------------------------------------------- the other tabs
  parts.set('modulation', modulationPane(app, panes.modulation));
  parts.set('variations', variationsPane(app, panes.variations));
  parts.set('mixer', mixerPane(app, panes.mixer));
  parts.set('fx', fxPane(app, panes.fx));
  parts.set('tuner', tunerPane(app, panes.tuner));
  parts.set('scale', scalePane(app, panes.scale));
  parts.set('discover', discoverPane(app, panes.discover));
  parts.set('factory', factoryPane(app, panes.factory));
  parts.set('kits', kitsPane(app, panes.kits));
  tp.refresh();

  const all = [lp, tp, stp, sy, sp, ...[...parts.values()].flatMap((x) => x.panels)];
  return {
    root,
    frame: () => {
      const m = app.meters;
      if (!m) return;
      for (let i = 0; i < sideMeters.length; i++) sideMeters[i]!.style.width = db(m.tracks[i] ?? 0) * 100 + '%';
      for (let v = 0; v < voiceMeters.length; v++) voiceMeters[v]!.style.width = db(m.voices[v] ?? 0) * 100 + '%';
      const open = parts.get(app.ui.soundTab);
      open?.frame?.(m);
    },
    show: (on) => {
      root.classList.toggle('hidden', !on);
      if (on) {
        buildSynth(true);
        buildLib();
        for (const p of all) p.refresh();
      }
    },
  };
}
