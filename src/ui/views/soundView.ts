/**
 * SOUND: what makes the sound. A track sidebar that is always there (name, voice, source, mute
 * and solo) and five contextual tabs for the selected track:
 *
 *   SYNTH       source, variations A-D, the LXR voice's parameters
 *   SAMPLE      the sample layer (of the base sound, or of the variation being edited)
 *   MODULATION  LFO and velocity, the variations and step sounds at a glance, the sound generators
 *   MIXER       every track's fader, pan, filter, mute, solo and FX send
 *   KIT & FX    generate and mutate the kit, voice locks, the FX bus, kit files
 *
 * The page does not scroll: each tab scrolls inside its own pane when it needs to. Switching tabs
 * only shows and hides panes, so nothing is lost; the open tab is remembered.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import { CHAIN_PRESETS, matchChainPreset, repairChain } from '@slopfactory/core/engines';
import type { App } from '../../app/app';
import { SOUND_TABS, type SoundTab } from '../../app/prefs';
import { SLOT_NAMES, VARIATION_SLOTS, type SamplePick } from '../../model/types';
import { FX_PARAM_LABELS, FX_PARAMS, GROUPS, PAR, TRIGGERS, VOICE_PARAMS, VOICES } from '../../sound/lxrParams';
import { importSamples, openFile } from '../menu';
import { button, ctl, download, group, h, num, Panel, range, select, vfader, win } from '../widgets';
import { subscribe, type View } from './patternView';
import { editingText, editVoice, generativeCard, paramCtl, slotBar, sourceStrip, variationTools, viewVoice } from './soundControls';
import { cpx, font } from '../scale';

const TAB_LABEL: Record<SoundTab, string> = { synth: 'SYNTH', sample: 'SAMPLE', modulation: 'MODULATION', mixer: 'MIXER', kit: 'KIT & FX' };
const TAB_TITLE: Record<SoundTab, string> = {
  synth: 'The selected track’s source, variations and LXR voice parameters',
  sample: 'The sample layer of the base sound or of the variation being edited',
  modulation: 'LFO and velocity, variations and step sounds at a glance, the sound generators',
  mixer: 'Every track: fader, pan, filter, mute, solo, FX send',
  kit: 'Generate and mutate the kit, lock voices, the FX bus, kit files',
};
const MODE_TAG = { synth: 'SYN', sample: 'SMP', hybrid: 'HYB' } as const;
/** the groups the MODULATION tab shows (the SYNTH tab has the rest) */
const MOD_GROUPS: readonly string[] = ['LFO', 'VELOCITY'];

type SampleKey = 'tune' | 'fine' | 'gain' | 'pan' | 'reverse';

export function soundView(app: App, screen: HTMLElement): View {
  const root = h('div', 'view sound-view', screen);
  root.dataset.view = 'sound';
  const t = () => app.track;
  const trackMeters: HTMLDivElement[] = [];
  const sideMeters: HTMLDivElement[] = [];
  const voiceMeters: HTMLDivElement[] = [];
  let masterMeters: HTMLDivElement[] = [];

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
        mode.textContent = MODE_TAG[s.sound.mode];
        mode.title = s.sound.mode.toUpperCase();
        const names = s.sound.samples.map((id) => app.library.get(id)?.name ?? '?').join(', ');
        const nv = s.sound.variations?.filter(Boolean).length ?? 0;
        src.textContent = (s.sound.mode === 'sample' ? names.slice(0, 12) || 'NO SAMPLE' : TRIGGERS[s.sound.trigger]!) + (nv ? ` · ${nv}V` : '');
      });
    }
  };
  buildList();
  subscribe(app, ['tracks', 'selection', 'kit', 'library', 'project', 'mix', 'status'], () => lp.refresh());
  app.on('project', buildList);

  // ================================================================ the main column: tabs, panes, status
  const main = h('div', 'sound-main', root);
  const bar = h('div', 'wsbar', main);
  bar.setAttribute('role', 'tablist');
  const info = h('div', 'wsinfo', bar);
  const panesEl = h('div', 'sndpanes', main);
  const status = h('div', 'sndstatus', main);
  const tp = new Panel();
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
  variationTools(app, tools, sy);
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
    const params = VOICE_PARAMS[v]!.filter((p) => (!basic || p.basic) && !MOD_GROUPS.includes(p.group));
    for (const g of GROUPS) {
      const ps = params.filter((p) => p.group === g);
      if (!ps.length) continue;
      const box = group(cols, g);
      box.classList.add('col', 'synthgroup');
      for (const p of ps) paramCtl(app, box, p, sy);
    }
    h('div', 'hint', cols, (basic ? 'ADVANCED shows every parameter. ' : '') + 'LFO and VELOCITY are in MODULATION. Alt-click a name to lock it against kit generation ◆. A ◇ marks a value the open variation overrides.');
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

  // ---------------------------------------------------------------- MODULATION
  const mo = new Panel();
  const mbody = h('div', 'modgrid sndscroll', panes.modulation);
  const mcol1 = h('div', 'col', mbody);
  const mcol2 = h('div', 'col', mbody);
  const mcol3 = h('div', 'col', mbody);
  h('div', 'hint', mcol1, 'THE MODULATION OF THE VOICE BEING EDITED (VARIATIONS CAN OVERRIDE THE AMOUNTS, NOT THE TARGETS).');
  const modBox = h('div', 'col', mcol1);
  let modShown = '';
  const buildMod = () => {
    const v = editVoice(app);
    if (modShown === String(v)) return mo.refresh();
    modShown = String(v);
    modBox.innerHTML = '';
    for (const g of MOD_GROUPS) {
      const ps = VOICE_PARAMS[v]!.filter((p) => p.group === g);
      if (!ps.length) continue;
      const box = group(modBox, `${g} · ${VOICES[v]}`);
      box.classList.add('col');
      for (const p of ps) paramCtl(app, box, p, mo);
    }
    mo.refresh();
  };
  // the four variations of the selected track
  const vg = group(mcol2, 'VARIATIONS OF THIS TRACK');
  vg.classList.add('col');
  const vlist = h('div', 'list', vg);
  const vrows: HTMLDivElement[] = [];
  for (let i = 0; i < VARIATION_SLOTS; i++) {
    const li = h('div', 'li', vlist);
    li.dataset.test = 'var-row-' + SLOT_NAMES[i];
    li.addEventListener('click', () => {
      app.setSlot(i);
      app.setSoundTab('synth');
    });
    li.title = 'Edit this variation in the SYNTH tab';
    vrows.push(li);
  }
  mo.add(() => {
    const tr = t();
    vrows.forEach((li, i) => {
      const v = tr.sound.variations?.[i];
      const uses = Object.values(app.pattern.sounds?.[tr.id] ?? {}).filter((s) => s.v === i || s.alt?.v === i).length;
      const n = v ? Object.keys(v.params).length + Object.keys(v.sample ?? {}).length : 0;
      li.textContent = `${SLOT_NAMES[i]} · ${v ? (v.name || (v.gen ? 'GENERATED' : 'BY HAND')) + (v.lock ? ' ◆' : '') + ` · ${n} OVERRIDE${n === 1 ? '' : 'S'}` : 'EMPTY'} · ${uses} STEP${uses === 1 ? '' : 'S'}`;
      li.classList.toggle('on', app.ui.slot === i);
    });
  });
  // the step sounds of the selected track in this pattern
  const stg = group(mcol2, 'STEP SOUNDS IN THIS PATTERN');
  stg.classList.add('col');
  const slist = h('div', 'list steplist', stg);
  mo.add(() => {
    slist.innerHTML = '';
    const tr = t();
    const entries = Object.entries(app.pattern.sounds?.[tr.id] ?? {}).sort((a, b) => Number(a[0]) - Number(b[0]));
    if (!entries.length) h('div', 'li', slist, 'NONE: SELECT A STEP AND USE STEP SOUND IN THE PATTERN VIEW, OR GENERATE BELOW');
    for (const [k] of entries) {
      const li = h('div', 'li', slist, `STEP ${Number(k) + 1} · ${app.describeStepSound(tr.id, Number(k))}`);
      li.addEventListener('click', () => {
        app.selectTrack(tr.id);
        app.setCursor({ track: tr.id, step: Number(k) });
        app.setView('pattern');
        app.setWorkspace('sound');
      });
    }
  });
  const gg = group(mcol3, 'GENERATE');
  gg.classList.add('col');
  generativeCard(app, gg, mo);
  buildMod();
  subscribe(app, ['kit', 'tracks', 'selection', 'pattern', 'project', 'gen'], () => {
    buildMod();
    mo.refresh();
  });

  // ---------------------------------------------------------------- MIXER
  const mx = new Panel();
  const mb = h('div', 'mixer sndscroll', panes.mixer);
  const buildMixer = () => {
    mx.clear();
    mb.innerHTML = '';
    trackMeters.length = 0;
    app.project.tracks.forEach((tr) => {
      const x = () => app.project.tracks.find((y) => y.id === tr.id) ?? tr;
      const s = h('div', 'strip', mb);
      const nm = h('div', 'sname', s, tr.name);
      nm.addEventListener('click', () => app.selectTrack(tr.id));
      nm.addEventListener('dblclick', () => void app.audition(tr.id));
      mx.add(() => {
        s.classList.toggle('sel', app.ui.track === tr.id);
        nm.textContent = x().name;
      });
      const fr = h('div', 'row', s);
      fr.style.gap = cpx(6);
      fr.style.alignItems = 'stretch';
      vfader(mx, fr, { get: () => x().mix.volume, set: (v) => app.setTrackMix(tr.id, { volume: v }, 'VOLUME'), begin: () => app.beginDrag('VOLUME'), end: () => app.endDrag(), height: 120, def: 0.8, title: 'Volume (0.8 = 0 dB, double-click)' });
      const met = h('div', 'meter', fr);
      met.style.width = cpx(10);
      trackMeters.push(h('div', 'lvl', met));
      const db = h('div', 'hint', s);
      mx.add(() => {
        const v = x().mix.volume;
        const d = v <= 0 ? -Infinity : v <= 0.8 ? -60 + (v / 0.8) * 60 : ((v - 0.8) / 0.2) * 15;
        db.textContent = Number.isFinite(d) ? (d > 0 ? '+' : '') + d.toFixed(1) : '-∞';
      });
      range(mx, s, { get: () => Math.round(x().mix.pan * 100), set: (v) => app.setTrackMix(tr.id, { pan: v / 100 }, 'PAN'), min: -100, max: 100, def: 0, bip: true, format: (v) => (v === 0 ? 'C' : v < 0 ? 'L' + -v : 'R' + v), begin: () => app.beginDrag('PAN'), end: () => app.endDrag(), title: 'Pan' });
      range(mx, s, { get: () => Math.round(x().mix.filter * 100), set: (v) => app.setTrackMix(tr.id, { filter: v / 100 }, 'FILTER'), min: -100, max: 100, def: 0, bip: true, format: (v) => (v === 0 ? 'FLT' : v < 0 ? 'LP' : 'HP'), begin: () => app.beginDrag('FILTER'), end: () => app.endDrag(), title: 'One-knob filter: left low-pass, right high-pass' });
      const ms = h('div', 'row', s);
      ms.style.gap = cpx(3);
      button(mx, ms, 'M', () => app.setTrackMix(tr.id, { mute: !x().mix.mute }), { cls: 'small', on: () => x().mix.mute, title: 'Mute' });
      button(mx, ms, 'S', () => app.setTrackMix(tr.id, { solo: !x().mix.solo }), { cls: 'small', on: () => x().mix.solo, title: 'Solo' });
      button(mx, ms, 'FX', () => app.setTrackMix(tr.id, { route: x().mix.route === 'fx' ? 'main' : 'fx' }, 'ROUTE'), { cls: 'small', on: () => x().mix.route === 'fx', title: 'Route through the LXR FX bus (instead of straight to the master)' });
    });
    const s = h('div', 'strip', mb);
    s.style.marginLeft = 'auto';
    h('div', 'sname', s, 'MASTER').classList.add('inv');
    const fr = h('div', 'row', s);
    fr.style.gap = cpx(6);
    fr.style.alignItems = 'stretch';
    vfader(mx, fr, { get: () => app.project.master.volume, set: (v) => app.setMaster({ volume: v }, 'MASTER VOLUME'), begin: () => app.beginDrag('MASTER VOLUME'), end: () => app.endDrag(), height: 120, def: 0.8, title: 'Master volume' });
    const mL = h('div', 'meter', fr);
    const mR = h('div', 'meter', fr);
    for (const m of [mL, mR]) m.style.width = cpx(10);
    masterMeters = [h('div', 'lvl', mL), h('div', 'lvl', mR)];
    button(mx, s, 'CLIP', () => app.setMaster({ clip: !app.project.master.clip }, 'SOFT CLIP'), { cls: 'small', on: () => app.project.master.clip, title: 'Soft clipper on the master' });
    select(mx, s, {
      options: () => [{ value: '', label: 'NO OUT FX' }, ...CHAIN_PRESETS.map((p) => ({ value: p.key, label: p.label }))],
      get: () => matchChainPreset(repairChain(app.project.master.chain)) ?? '',
      set: (k) => app.setMaster({ chain: k ? (CHAIN_PRESETS.find((p) => p.key === k)?.config ?? null) : null }, 'OUTPUT CHAIN'),
      title: 'Slop Factory output processing on the master (Core engines)',
    });
  };
  buildMixer();
  app.on('project', buildMixer);
  subscribe(app, ['mix', 'tracks', 'selection', 'master'], () => mx.refresh());

  // ---------------------------------------------------------------- KIT AND FX
  const kp = new Panel();
  const kbody = h('div', 'kitgrid sndscroll', panes.kit);
  const kleft = h('div', 'col', kbody);
  const kright = h('div', 'col', kbody);
  const kr = h('div', 'row wrap', kleft);
  let mutAmt = 0.3;
  button(kp, kr, 'GENERATE KIT', () => void app.generateKit(), { cls: 'med grow', disabled: () => app.ui.busy, title: 'A new set of synthesised drums designed for the style (K). Locked voices and parameters stay.' }).dataset.test = 'generate-kit';
  button(kp, kr, 'MUTATE KIT', () => void app.mutateKit(mutAmt), { cls: 'med grow', disabled: () => app.ui.busy, title: 'Controlled changes to every unlocked voice (⇧K)' });
  num(kp, kr, { get: () => Math.round(mutAmt * 100), set: (v) => ((mutAmt = v / 100), kp.refresh()), min: 5, max: 100, format: (v) => v + '%', title: 'How far MUTATE goes' });
  const kn = h('div', 'report', kleft);
  kp.add(() => (kn.textContent = `${app.project.kit.name} · SEED ${app.project.kit.seed}${app.ui.busy ? ' · CHECKING THE KIT IN THE ENGINE…' : ''} · ${app.project.soundLocks.params.length} PARAMS LOCKED`));
  const kf = h('div', 'row wrap', kleft);
  button(kp, kf, 'EXPORT KIT', () => {
    const f = app.kitFile();
    download(f.name, f.data, f.type);
  }, { cls: 'grow', title: 'Save the kit (.clatterkit.zip)' });
  button(kp, kf, 'LOAD KIT…', () => void openFile(app, '.zip'), { cls: 'grow', title: 'Load a kit, project or bundle' });
  const vg2 = group(kleft, 'VOICES · LOCK AND MUTATE');
  vg2.classList.add('col');
  VOICES.forEach((vn, v) => {
    const r = h('div', 'row', vg2);
    button(kp, r, vn, () => {
      viewVoice(v);
      const owner = app.project.tracks.find((x) => app.voiceOf(x) === v);
      if (owner) app.selectTrack(owner.id);
      app.setSoundTab('synth');
    }, { cls: 'grow', title: 'Edit this voice in the SYNTH tab' });
    button(kp, r, 'L', () => app.lockVoice(v), { cls: 'small', on: () => !!app.project.soundLocks.voices[v], title: 'Lock: GENERATE KIT, MUTATE KIT and EVOLVE leave this voice alone' });
    button(kp, r, 'MUT', () => void app.mutateKit(0.4, [v]), { cls: 'small', title: 'Mutate this voice', disabled: () => app.ui.busy });
  });
  const fxg = group(kright, 'LXR FX BUS');
  fxg.classList.add('col');
  const fxType = () => app.project.kit.synth.params[PAR.FX_TYPE] ?? 0;
  for (const p of FX_PARAMS) {
    const wrap = h('div', '', fxg);
    const isP = p.id >= PAR.FX_P1 && p.id <= PAR.FX_P4;
    paramCtl(app, wrap, p, kp, { base: true, labelOf: isP ? () => FX_PARAM_LABELS[fxType()]?.[p.id - PAR.FX_P1] ?? p.label : undefined });
    const only: Record<number, number> = { [PAR.FX_DIST_TYPE]: 1, [PAR.FX_WAVE]: 2, [PAR.FX_RATIO]: 3, [PAR.FX_DELAY_TYPE]: 4 };
    if (only[p.id] !== undefined) kp.add(() => (wrap.style.display = fxType() === only[p.id] ? '' : 'none'));
  }
  h('div', 'hint', kright, 'Tracks with FX on in the mixer play through the bus. The FX bus belongs to the kit: variations do not change it.');
  subscribe(app, ['kit', 'status', 'project'], () => kp.refresh());

  const all = [lp, tp, stp, sy, sp, mo, mx, kp];
  return {
    root,
    frame: () => {
      const m = app.meters;
      if (!m) return;
      const db = (x: number) => Math.max(0, Math.min(1, 1 + (20 * Math.log10(Math.max(1e-6, x))) / 48));
      for (let i = 0; i < trackMeters.length; i++) trackMeters[i]!.style.height = db(m.tracks[i] ?? 0) * 100 + '%';
      for (let i = 0; i < sideMeters.length; i++) sideMeters[i]!.style.width = db(m.tracks[i] ?? 0) * 100 + '%';
      for (let v = 0; v < voiceMeters.length; v++) voiceMeters[v]!.style.width = db(m.voices[v] ?? 0) * 100 + '%';
      if (masterMeters[0]) masterMeters[0].style.height = db(m.masterL) * 100 + '%';
      if (masterMeters[1]) masterMeters[1].style.height = db(m.masterR) * 100 + '%';
    },
    show: (on) => {
      root.classList.toggle('hidden', !on);
      if (on) {
        buildSynth(true);
        modShown = '';
        buildMod();
        buildLib();
        for (const p of all) p.refresh();
      }
    },
  };
}
