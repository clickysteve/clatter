/**
 * SOUND: what makes the sound. Track sources (SYNTH, SAMPLE, HYBRID), the LXR synth editor
 * (the firmware's own parameters), the sample library and the selected track's sample, the
 * mixer, and the kit (generate, mutate, lock, evolve), FX bus and master.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import { CHAIN_PRESETS, matchChainPreset, repairChain } from '@slopfactory/core/engines';
import type { App } from '../../app/app';
import { ROLE_LABEL, type SamplePick, type SourceMode } from '../../model/types';
import { FX_PARAM_LABELS, FX_PARAMS, formatValue, GROUPS, modTargets, PAR, targetLabel, TRIGGERS, VOICE_PARAMS, VOICES, type ParamDef } from '../../sound/lxrParams';
import { importSamples } from '../menu';
import { button, ctl, download, group, h, num, Panel, range, select, vfader, win } from '../widgets';
import { pctRange, subscribe, type View } from './patternView';

const MODES: { value: SourceMode; label: string }[] = [
  { value: 'synth', label: 'SYNTH' },
  { value: 'sample', label: 'SAMPLE' },
  { value: 'hybrid', label: 'HYBRID' },
];

export function soundView(app: App, screen: HTMLElement): View {
  const root = h('div', 'view', screen);
  root.dataset.view = 'sound';
  const t = () => app.track;
  /** The voice shown in the synth editor: the selected track's, or the last one chosen. */
  let voice = 0;
  const trackMeters: HTMLDivElement[] = [];
  const voiceMeters: HTMLDivElement[] = [];
  const editVoice = () => {
    const v = app.voiceOf(t());
    if (v >= 0) voice = v;
    return voice;
  };

  // ---------------------------------------------------------------- TRACKS
  const lw = win(root, { x: 8, y: 84, w: 250, h: 708, title: 'TRACKS', area: 'sound', id: 'tracks' });
  const lp = new Panel();
  const lb = lw.body;
  lb.classList.add('col');
  const list = h('div', 'list', lb);
  list.style.height = '232px';
  const buildList = () => {
    list.innerHTML = '';
    for (const tr of app.project.tracks) {
      const li = h('div', 'li', list);
      li.dataset.track = tr.id;
      const nm = h('div', 'grow', li);
      const src = h('div', 'tiny', li);
      li.addEventListener('click', () => app.selectTrack(tr.id));
      li.addEventListener('dblclick', () => void app.audition(tr.id));
      lp.add(() => {
        const x = app.project.tracks.find((y) => y.id === tr.id);
        if (!x) return;
        li.classList.toggle('on', app.ui.track === x.id);
        nm.textContent = x.name;
        const smp = x.sound.samples.map((id) => app.library.get(id)?.name ?? '?').join(', ');
        src.textContent = x.sound.mode === 'synth' ? TRIGGERS[x.sound.trigger]! : x.sound.mode === 'sample' ? smp.slice(0, 18) || 'NO SAMPLE' : `${TRIGGERS[x.sound.trigger]} + ${smp.slice(0, 10)}`;
        src.style.color = 'inherit';
      });
    }
  };
  buildList();
  const sg = group(lb, 'SOURCE');
  sg.classList.add('col');
  const nr = h('div', 'row', sg);
  const name = h('input', 'num', nr) as HTMLInputElement;
  name.style.width = '90px';
  name.maxLength = 10;
  name.title = 'Track name';
  name.addEventListener('change', () => app.setTrackName(t().id, name.value));
  name.addEventListener('keydown', (e) => e.stopPropagation());
  lp.add(() => {
    if (document.activeElement !== name) name.value = t().name;
  });
  h('div', 'tiny', nr, '');
  const roleLbl = h('div', 'tiny', nr);
  lp.add(() => (roleLbl.textContent = 'ROLE ' + ROLE_LABEL[t().role]));
  button(lp, nr, '▶', () => void app.audition(t().id), { cls: 'small', title: 'Hear it' });
  const mr = h('div', 'row', sg);
  for (const m of MODES) button(lp, mr, m.label, () => app.setTrackSound(t().id, { mode: m.value }, 'SOURCE'), { cls: 'grow', on: () => t().sound.mode === m.value, title: m.value === 'hybrid' ? 'The LXR voice and the sample together, aligned' : m.value === 'synth' ? 'The LXR voice' : 'Samples only' }).dataset.test = 'mode-' + m.value;
  const trc = ctl(sg, 'LXR VOICE', 'Which LXR trigger plays this track (two tracks on one voice share it, as on the hardware)');
  select(lp, trc.slot, { options: () => TRIGGERS.map((n, i) => ({ value: i, label: n })), get: () => t().sound.trigger, set: (v) => app.setTrackSound(t().id, { trigger: v }, 'LXR VOICE') });
  const noteC = ctl(sg, 'NOTE', 'Synth note: 60 plays the voice at its programmed pitch');
  range(lp, noteC.slot, { get: () => t().sound.note, set: (v) => app.setTrackSound(t().id, { note: v }, 'NOTE'), min: 24, max: 96, def: 60, bip: true, format: (v) => (v - 60 > 0 ? '+' : '') + (v - 60), begin: () => app.beginDrag('NOTE'), end: () => app.endDrag() });
  pctRange(lp, sg, app, 'SYNTH LVL', () => t().sound.synthLevel, (v) => app.setTrackSound(t().id, { synthLevel: v }, 'SYNTH LEVEL'), 'HYBRID: level of the synth layer', 0.8);
  pctRange(lp, sg, app, 'SAMPLE LVL', () => t().sound.sampleLevel, (v) => app.setTrackSound(t().id, { sampleLevel: v }, 'SAMPLE LEVEL'), 'HYBRID: level of the sample layer', 0.8);
  const off = ctl(sg, 'ALIGN', 'HYBRID: positive delays the sample, negative delays the synth (ms)');
  range(lp, off.slot, { get: () => t().sound.offsetMs, set: (v) => app.setTrackSound(t().id, { offsetMs: v }, 'ALIGN'), min: -30, max: 30, def: 0, bip: true, format: (v) => (v > 0 ? '+' : '') + v + 'MS', begin: () => app.beginDrag('ALIGN'), end: () => app.endDrag() });
  const ch = ctl(sg, 'CHOKE', 'Tracks in the same choke group cut each other (0 = none)');
  num(lp, ch.slot, { get: () => t().sound.choke, set: (v) => app.setTrackSound(t().id, { choke: v }, 'CHOKE'), min: 0, max: 4, width: 26, format: (v) => (v ? String(v) : 'OFF') });
  // the six LXR voices
  const vg = group(lb, 'LXR VOICES');
  vg.classList.add('col');
  VOICES.forEach((vn, v) => {
    const r = h('div', 'row', vg);
    button(lp, r, vn, () => {
      voice = v;
      const owner = app.project.tracks.find((x) => app.voiceOf(x) === v);
      if (owner) app.selectTrack(owner.id);
      else lp.refresh();
      synth.refresh();
    }, { cls: 'grow', on: () => editVoice() === v, title: 'Edit this voice' });
    const m = h('div', 'meter h', r);
    Object.assign(m.style, { width: '40px', height: '6px' });
    const lvl = h('div', 'lvl', m);
    voiceMeters.push(lvl);
    button(lp, r, 'L', () => app.lockVoice(v), { cls: 'small', on: () => !!app.project.soundLocks.voices[v], title: 'Lock: GENERATE KIT, MUTATE KIT and EVOLVE leave this voice alone' });
    button(lp, r, 'MUT', () => void app.mutateKit(0.4, [v]), { cls: 'small', title: 'Mutate this voice', disabled: () => app.ui.busy });
  });
  subscribe(app, ['tracks', 'selection', 'kit', 'library', 'project', 'status'], () => lp.refresh());
  app.on('project', buildList);

  // ---------------------------------------------------------------- SYNTH EDITOR
  const ew = win(root, { x: 266, y: 84, w: 640, h: 470, title: 'SYNTH', area: 'sound', id: 'synth' });
  const synth = new Panel();
  const et = ew.tools;
  /** the title-bar tools outlive the editor's rebuilds */
  const ep = new Panel();
  button(ep, et, 'BASIC', () => app.setEditMode('basic'), { cls: 'small', on: () => app.ui.editMode === 'basic', title: 'The parameters that matter most' });
  button(ep, et, 'ADVANCED', () => app.setEditMode('advanced'), { cls: 'small', on: () => app.ui.editMode === 'advanced', title: 'Every parameter of the voice' });
  button(ep, et, 'LOCK VOICE', () => app.lockVoice(editVoice()), { cls: 'small', on: () => !!app.project.soundLocks.voices[editVoice()] });
  button(ep, et, 'MUTATE VOICE', () => void app.mutateKit(0.4, [editVoice()]), { cls: 'small', disabled: () => app.ui.busy });
  const eb = ew.body;
  const cols = h('div', '', eb);
  Object.assign(cols.style, { columnCount: '3', columnGap: '6px', columnFill: 'balance', maxHeight: '100%' });
  const paramCtl = (parent: HTMLElement, p: ParamDef, panel: Panel, labelOf?: () => string) => {
    const locked = () => app.project.soundLocks.params.includes(p.id);
    const c = ctl(parent, p.label, `${p.help}${p.kind === 'target' ? '' : ' (ALT-click: lock against kit generation)'}`);
    c.row.dataset.param = String(p.id);
    if (labelOf) panel.add(() => (c.name.textContent = labelOf()));
    const lk = h('span', 'lock', c.name);
    panel.add(() => (lk.textContent = locked() ? '◆' : ''));
    if (p.kind === 'menu') {
      select(panel, c.slot, { options: () => (p.options ?? []).map((o, i) => ({ value: i, label: o })), get: () => app.project.kit.synth.params[p.id] ?? 0, set: (v) => app.setParam(p.id, v, p.label) });
      c.name.addEventListener('click', (e) => e.altKey && app.lockParam(p.id));
    } else if (p.kind === 'target') {
      const v = p.voice ?? 0;
      const lfo = p.id === PAR.TARGET_LFO1 + v;
      select(panel, c.slot, {
        options: () => [{ value: 0, label: 'NONE' }, ...modTargets(v).map((x) => ({ value: x.id, label: targetLabel(x.id) }))],
        get: () => (lfo ? app.project.kit.synth.lfoTarget[v] : app.project.kit.synth.velTarget[v]) ?? 0,
        set: (x) => app.setModTarget(lfo ? 0 : 1, v, x),
      });
    } else {
      range(panel, c.slot, {
        get: () => app.project.kit.synth.params[p.id] ?? 0,
        set: (v) => app.setParam(p.id, v, p.label),
        min: 0,
        max: p.max,
        bip: p.kind === 'bipolar',
        def: p.kind === 'bipolar' ? 63 : undefined,
        parse: p.kind === 'bipolar' ? (n) => n + 63 : undefined,
        format: (v) => formatValue(p, v),
        locked,
        onAlt: () => app.lockParam(p.id),
        begin: () => app.beginDrag(p.label),
        end: () => app.endDrag(),
      });
    }
  };
  let shown = '';
  const buildSynth = () => {
    ep.refresh();
    const v = editVoice();
    const key = `${v}:${app.ui.editMode}`;
    if (key === shown) return synth.refresh();
    shown = key;
    synth.clear();
    cols.innerHTML = '';
    const basic = app.ui.editMode === 'basic';
    const params = VOICE_PARAMS[v]!.filter((p) => !basic || p.basic);
    for (const g of GROUPS) {
      const ps = params.filter((p) => p.group === g);
      if (!ps.length) continue;
      const box = group(cols, g);
      Object.assign(box.style, { breakInside: 'avoid', marginBottom: '6px' });
      box.classList.add('col');
      for (const p of ps) paramCtl(box, p, synth);
    }
    if (basic) {
      const hint = h('div', 'tiny', cols, 'ADVANCED: EVERY PARAMETER · ALT-CLICK A SLIDER TO LOCK IT ◆');
      hint.style.whiteSpace = 'normal';
    }
    synth.add(() => {
      const owners = app.project.tracks.filter((x) => app.voiceOf(x) === v).map((x) => x.name);
      ew.setTitle(`SYNTH · ${VOICES[v]}`);
      ew.info.textContent = owners.length ? owners.join(', ') : 'NO TRACK PLAYS THIS VOICE';
    });
  };
  buildSynth();
  subscribe(app, ['kit', 'tracks', 'selection', 'view', 'project'], buildSynth);
  app.on('status', () => (synth.refresh(), ep.refresh()));

  // ---------------------------------------------------------------- SAMPLE
  const smw = win(root, { x: 914, y: 84, w: 358, h: 470, title: 'SAMPLE', area: 'sound', id: 'sample' });
  const sp = new Panel();
  const sb = smw.body;
  sb.classList.add('col');
  const wave = h('div', 'wave', sb);
  wave.style.height = '64px';
  const wc = h('canvas', '', wave);
  wc.width = 344;
  wc.height = 62;
  wave.title = 'Drag: region start (left half) or end (right half)';
  const current = () => app.library.get(t().sound.samples[0] ?? '');
  const drawWave = () => {
    const g = wc.getContext('2d')!;
    const cs = getComputedStyle(wave);
    const ink = cs.getPropertyValue('--ink').trim() || '#000';
    const paper = cs.getPropertyValue('--paper').trim() || '#fff';
    g.fillStyle = paper;
    g.fillRect(0, 0, wc.width, wc.height);
    const s = current();
    g.fillStyle = ink;
    if (!s) {
      g.font = '8px Silkscreen, monospace';
      g.fillText(t().sound.mode === 'synth' ? 'SYNTH TRACK: NO SAMPLE' : 'NO SAMPLE: CHOOSE ONE BELOW', 8, 34);
      return;
    }
    const n = s.peaks.length;
    const mid = wc.height / 2;
    for (let i = 0; i < wc.width; i++) {
      const pk = s.peaks[Math.floor((i / wc.width) * n)] ?? 0;
      const hh = Math.max(1, pk * (wc.height - 4) * 0.5);
      g.fillRect(i, mid - hh, 1, hh * 2);
    }
    const a = t().sound.start * wc.width;
    const b = t().sound.end * wc.width;
    g.fillStyle = paper;
    for (let y = 0; y < wc.height; y += 2) {
      for (let x = (y / 2) % 2; x < a; x += 2) g.fillRect(x, y, 1, 1);
      for (let x = Math.ceil(b) + ((y / 2) % 2); x < wc.width; x += 2) g.fillRect(x, y, 1, 1);
    }
    g.fillStyle = ink;
    g.fillRect(Math.floor(a), 0, 1, wc.height);
    g.fillRect(Math.min(wc.width - 1, Math.floor(b)), 0, 1, wc.height);
  };
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
  const sinfo = h('div', 'report', sb);
  sp.add(() => {
    const s = current();
    sinfo.textContent = s ? `${s.name} · ${s.duration.toFixed(2)} S · ${s.rate} HZ · ${s.channels.length > 1 ? 'STEREO' : 'MONO'}${s.bundled ? ' · BUNDLED' : ''}` : '';
  });
  const tune = ctl(sb, 'TUNE', 'Sample pitch in semitones');
  range(sp, tune.slot, { get: () => t().sound.tune, set: (v) => app.setTrackSound(t().id, { tune: v }, 'TUNE'), min: -24, max: 24, def: 0, bip: true, format: (v) => (v > 0 ? '+' : '') + v, begin: () => app.beginDrag('TUNE'), end: () => app.endDrag() });
  const fine = ctl(sb, 'FINE', 'Cents');
  range(sp, fine.slot, { get: () => t().sound.fine, set: (v) => app.setTrackSound(t().id, { fine: v }, 'FINE'), min: -100, max: 100, def: 0, bip: true, format: (v) => (v > 0 ? '+' : '') + v + 'C', begin: () => app.beginDrag('FINE'), end: () => app.endDrag() });
  const gain = ctl(sb, 'GAIN', 'Sample gain before the mixer');
  range(sp, gain.slot, { get: () => Math.round(t().sound.gain * 100), set: (v) => app.setTrackSound(t().id, { gain: v / 100 }, 'GAIN'), min: 0, max: 200, def: 100, format: (v) => v + '%', begin: () => app.beginDrag('GAIN'), end: () => app.endDrag() });
  const pan = ctl(sb, 'PAN', 'Sample pan before the mixer');
  range(sp, pan.slot, { get: () => Math.round(t().sound.pan * 100), set: (v) => app.setTrackSound(t().id, { pan: v / 100 }, 'SAMPLE PAN'), min: -100, max: 100, def: 0, bip: true, begin: () => app.beginDrag('SAMPLE PAN'), end: () => app.endDrag() });
  const pr = h('div', 'row', sb);
  button(sp, pr, 'REVERSE', () => app.setTrackSound(t().id, { reverse: !t().sound.reverse }, 'REVERSE'), { on: () => t().sound.reverse });
  h('div', 'lbl', pr, 'PICK');
  select(sp, pr, {
    options: () => (['first', 'cycle', 'random', 'velocity'] as SamplePick[]).map((v) => ({ value: v, label: v.toUpperCase() })),
    get: () => t().sound.pick,
    set: (v) => app.setTrackSound(t().id, { pick: v }, 'PICK'),
    width: 76,
    title: 'Which of the track’s samples a hit plays (a hit can also name its own in STEP)',
  });
  button(sp, pr, 'HIT WAV', async () => {
    try {
      const f = await app.exportHit(t().id);
      download(f.name, f.data, f.type);
    } catch (err) {
      app.say(`EXPORT FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, { cls: 'small', title: 'Export this track’s sound as a one-shot WAV' });
  const onTrack = h('div', 'list', sb);
  onTrack.style.height = '42px';
  h('div', 'tiny', sb, 'LIBRARY · CLICK: ASSIGN · SHIFT: ADD · ▶ HEAR');
  const lib = h('div', 'list', sb);
  lib.style.flex = '1';
  lib.style.minHeight = '0';
  const libRow = h('div', 'row', sb);
  button(sp, libRow, 'IMPORT…', () => void importSamples(app, t().id), { cls: 'grow', title: 'Import WAV, AIFF, MP3, OGG, FLAC: assigned to this track' }).dataset.test = 'import';
  const filter = h('div', 'tiny', libRow);
  const buildLib = () => {
    onTrack.innerHTML = '';
    for (const id of t().sound.samples) {
      const s = app.library.get(id);
      const li = h('div', 'li', onTrack);
      h('div', 'grow', li, s?.name ?? 'MISSING SAMPLE');
      const pv = h('button', 'btn small', li, '▶');
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
      li.style.color = '';
      const pv = h('button', 'btn small', li, '▶');
      pv.addEventListener('click', (e) => {
        e.stopPropagation();
        void app.previewSample(s.id);
      });
      li.addEventListener('click', (e) => app.assignSample(t().id, s.id, e.shiftKey));
    }
  };
  buildLib();
  subscribe(app, ['tracks', 'selection', 'library', 'project'], () => {
    buildLib();
    sp.refresh();
  });
  window.addEventListener('clatter-palette', drawWave);

  // ---------------------------------------------------------------- MIXER
  const mw = win(root, { x: 266, y: 562, w: 640, h: 230, title: 'MIXER', area: 'sound', id: 'mixer' });
  const mp = new Panel();
  const mb = mw.body;
  mb.classList.add('row');
  mb.style.alignItems = 'stretch';
  mb.style.gap = '2px';
  mb.style.padding = '4px';
  const buildMixer = () => {
    mp.clear();
    mb.innerHTML = '';
    trackMeters.length = 0;
    app.project.tracks.forEach((tr) => {
      const x = () => app.project.tracks.find((y) => y.id === tr.id) ?? tr;
      const s = h('div', 'strip', mb);
      s.style.width = '52px';
      const nm = h('div', 'sname', s, tr.name);
      nm.addEventListener('click', () => app.selectTrack(tr.id));
      nm.addEventListener('dblclick', () => void app.audition(tr.id));
      mp.add(() => {
        s.classList.toggle('sel', app.ui.track === tr.id);
        nm.textContent = x().name;
      });
      const fr = h('div', 'row', s);
      fr.style.gap = '2px';
      fr.style.alignItems = 'stretch';
      vfader(mp, fr, { get: () => x().mix.volume, set: (v) => app.setTrackMix(tr.id, { volume: v }, 'VOLUME'), begin: () => app.beginDrag('VOLUME'), end: () => app.endDrag(), height: 92, def: 0.8, title: 'Volume (0.8 = 0 dB, double-click)' });
      const met = h('div', 'meter', fr);
      met.style.width = '5px';
      const lvl = h('div', 'lvl', met);
      trackMeters.push(lvl);
      const db = h('div', 'tiny', s);
      mp.add(() => {
        const v = x().mix.volume;
        const d = v <= 0 ? -Infinity : v <= 0.8 ? -60 + (v / 0.8) * 60 : ((v - 0.8) / 0.2) * 15;
        db.textContent = Number.isFinite(d) ? (d > 0 ? '+' : '') + d.toFixed(1) : '-∞';
      });
      range(mp, s, { get: () => Math.round(x().mix.pan * 100), set: (v) => app.setTrackMix(tr.id, { pan: v / 100 }, 'PAN'), min: -100, max: 100, def: 0, bip: true, format: (v) => (v === 0 ? 'C' : v < 0 ? 'L' + -v : 'R' + v), begin: () => app.beginDrag('PAN'), end: () => app.endDrag(), title: 'Pan', width: 46 });
      range(mp, s, { get: () => Math.round(x().mix.filter * 100), set: (v) => app.setTrackMix(tr.id, { filter: v / 100 }, 'FILTER'), min: -100, max: 100, def: 0, bip: true, format: (v) => (v === 0 ? 'FLT' : v < 0 ? 'LP' : 'HP'), begin: () => app.beginDrag('FILTER'), end: () => app.endDrag(), title: 'One-knob filter: left low-pass, right high-pass', width: 46 });
      const ms = h('div', 'row', s);
      ms.style.gap = '1px';
      button(mp, ms, 'M', () => app.setTrackMix(tr.id, { mute: !x().mix.mute }), { cls: 'small', on: () => x().mix.mute, title: 'Mute' });
      button(mp, ms, 'S', () => app.setTrackMix(tr.id, { solo: !x().mix.solo }), { cls: 'small', on: () => x().mix.solo, title: 'Solo' });
      button(mp, ms, 'FX', () => app.setTrackMix(tr.id, { route: x().mix.route === 'fx' ? 'main' : 'fx' }, 'ROUTE'), { cls: 'small', on: () => x().mix.route === 'fx', title: 'Route through the LXR FX bus (instead of straight to the master)' });
    });
    const s = h('div', 'strip', mb);
    s.style.width = '64px';
    s.style.marginLeft = 'auto';
    h('div', 'sname', s, 'MASTER').classList.add('inv');
    const fr = h('div', 'row', s);
    fr.style.gap = '2px';
    vfader(mp, fr, { get: () => app.project.master.volume, set: (v) => app.setMaster({ volume: v }, 'MASTER VOLUME'), begin: () => app.beginDrag('MASTER VOLUME'), end: () => app.endDrag(), height: 92, def: 0.8, title: 'Master volume' });
    const mL = h('div', 'meter', fr);
    const mR = h('div', 'meter', fr);
    for (const m of [mL, mR]) m.style.width = '5px';
    masterMeters = [h('div', 'lvl', mL), h('div', 'lvl', mR)];
    button(mp, s, 'CLIP', () => app.setMaster({ clip: !app.project.master.clip }, 'SOFT CLIP'), { cls: 'small', on: () => app.project.master.clip, title: 'Soft clipper on the master' });
    select(mp, s, {
      options: () => [{ value: '', label: 'NO OUT FX' }, ...CHAIN_PRESETS.map((p) => ({ value: p.key, label: p.label }))],
      get: () => matchChainPreset(repairChain(app.project.master.chain)) ?? '',
      set: (k) => app.setMaster({ chain: k ? (CHAIN_PRESETS.find((p) => p.key === k)?.config ?? null) : null }, 'OUTPUT CHAIN'),
      width: 60,
      title: 'Slop Factory output processing on the master (Core engines)',
    });
  };
  let masterMeters: HTMLDivElement[] = [];
  buildMixer();
  app.on('project', buildMixer);
  subscribe(app, ['mix', 'tracks', 'selection', 'master'], () => mp.refresh());

  // ---------------------------------------------------------------- KIT, FX
  const kw = win(root, { x: 914, y: 562, w: 358, h: 230, title: 'KIT', area: 'sound', id: 'kit' });
  const kp = new Panel();
  const kb = kw.body;
  kb.classList.add('col');
  const kr = h('div', 'row', kb);
  button(kp, kr, 'GENERATE KIT', () => void app.generateKit(), { cls: 'grow', disabled: () => app.ui.busy, title: 'A new set of synthesised drums designed for the style (K). Locked voices and parameters stay.' }).dataset.test = 'generate-kit';
  button(kp, kr, 'MUTATE KIT', () => void app.mutateKit(mutAmt), { cls: 'grow', disabled: () => app.ui.busy, title: 'Controlled changes to every unlocked voice (⇧K)' });
  let mutAmt = 0.3;
  num(kp, kr, { get: () => Math.round(mutAmt * 100), set: (v) => ((mutAmt = v / 100), kp.refresh()), min: 5, max: 100, width: 34, format: (v) => v + '%', title: 'How far MUTATE goes' });
  const kn = h('div', 'report', kb);
  kp.add(() => (kn.textContent = `${app.project.kit.name} · SEED ${app.project.kit.seed}${app.ui.busy ? ' · CHECKING THE KIT IN THE ENGINE…' : ''} · ${app.project.soundLocks.params.length} PARAMS LOCKED`));
  const fxg = group(kb, 'LXR FX BUS');
  fxg.style.flex = '1';
  const fxc = h('div', '', fxg);
  Object.assign(fxc.style, { columnCount: '2', columnGap: '6px' });
  const fxType = () => app.project.kit.synth.params[PAR.FX_TYPE] ?? 0;
  for (const p of FX_PARAMS) {
    const wrap = h('div', '', fxc);
    wrap.style.marginBottom = '3px';
    const isP = p.id >= PAR.FX_P1 && p.id <= PAR.FX_P4;
    paramCtl(wrap, p, kp, isP ? () => FX_PARAM_LABELS[fxType()]?.[p.id - PAR.FX_P1] ?? p.label : undefined);
    const only: Record<number, number> = { [PAR.FX_DIST_TYPE]: 1, [PAR.FX_WAVE]: 2, [PAR.FX_RATIO]: 3, [PAR.FX_DELAY_TYPE]: 4 };
    if (only[p.id] !== undefined) kp.add(() => (wrap.style.display = fxType() === only[p.id] ? '' : 'none'));
  }
  const tip = h('div', 'tiny', kb, 'TRACKS WITH FX ON IN THE MIXER PLAY THROUGH THE BUS');
  void tip;
  subscribe(app, ['kit', 'status', 'project'], () => kp.refresh());

  const all = [lp, ep, synth, sp, mp, kp];
  return {
    root,
    frame: () => {
      const m = app.meters;
      if (!m) return;
      const db = (x: number) => Math.max(0, Math.min(1, 1 + (20 * Math.log10(Math.max(1e-6, x))) / 48));
      for (let i = 0; i < trackMeters.length; i++) trackMeters[i]!.style.height = db(m.tracks[i] ?? 0) * 100 + '%';
      for (let v = 0; v < voiceMeters.length; v++) voiceMeters[v]!.style.width = db(m.voices[v] ?? 0) * 100 + '%';
      if (masterMeters[0]) masterMeters[0].style.height = db(m.masterL) * 100 + '%';
      if (masterMeters[1]) masterMeters[1].style.height = db(m.masterR) * 100 + '%';
    },
    show: (on) => {
      root.classList.toggle('hidden', !on);
      if (on) {
        shown = '';
        buildSynth();
        buildLib();
        for (const p of all) p.refresh();
      }
    },
  };
}
