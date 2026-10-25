/**
 * The MIXER and FX tabs.
 *
 * MIXER: every channel (level, pan, one-knob filter, mute, solo, FX send and routing, meter) with
 * its channel processing, then the bus processing and the master. The signal path is the one
 * documented in src/audio/mixfx.ts and shown at the bottom of the tab.
 *
 * FX: the LXR's own FX bus (the firmware's effect: drive, ring modulator, compressor, delay) and
 * which tracks feed it.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import { CHAIN_PRESETS, matchChainPreset, repairChain } from '@slopfactory/core/engines';
import type { App } from '../../app/app';
import type { MetersMessage } from '../../audio/protocol';
import { channelFxActive, defaultChannelFx, type BusFx, type ChannelFx } from '../../audio/mixfx';
import { FX_PARAM_LABELS, FX_PARAMS, PAR } from '../../sound/lxrParams';
import { button, ctl, group, h, Panel, range, select, vfader } from '../widgets';
import { cpx } from '../scale';
import { paramCtl } from './soundControls';
import { subscribe } from './patternView';
import { db, setW, sgn, type PaneParts } from './soundUi';

const SIGNAL_PATH =
  'TRACK → ONE-KNOB FILTER → CHANNEL PROCESSING (TRANSIENT, EQ, SATURATION, SOFT CLIP, BIT REDUCTION) → FADER AND PAN → DRY TO THE BUS · SEND TO THE LXR FX BUS (FX ONLY: NO DRY) → BUS PROCESSING (FILTER, DISTORTION, COMPRESSOR, STEREO) → OUTPUT CHAIN → MASTER GAIN → WIDTH → SOFT CLIP → LIMITER → OUT';

const dbText = (v: number): string => {
  const d = v <= 0 ? -Infinity : v <= 0.8 ? -60 + (v / 0.8) * 60 : ((v - 0.8) / 0.2) * 15;
  return Number.isFinite(d) ? (d > 0 ? '+' : '') + d.toFixed(1) : '-∞';
};

export function mixerPane(app: App, pane: HTMLElement): PaneParts {
  const mx = new Panel();
  const t = () => app.track;
  const trackMeters: HTMLDivElement[] = [];
  let masterMeters: HTMLDivElement[] = [];
  let busGr: HTMLDivElement | null = null;
  let limGr: HTMLDivElement | null = null;

  // ---------------------------------------------------------------- strips
  const strips = h('div', 'mixer', pane);
  strips.dataset.test = 'mixer-strips';
  const build = () => {
    mx.clear();
    strips.innerHTML = '';
    trackMeters.length = 0;
    app.project.tracks.forEach((tr) => {
      const x = () => app.project.tracks.find((y) => y.id === tr.id) ?? tr;
      const s = h('div', 'strip', strips);
      s.dataset.channel = tr.id;
      const nm = h('div', 'sname', s, tr.name);
      nm.addEventListener('click', () => app.selectTrack(tr.id));
      nm.addEventListener('dblclick', () => void app.audition(tr.id));
      nm.title = 'Click: select (shows its channel processing). Double-click: hear it.';
      mx.add(() => {
        s.classList.toggle('sel', app.ui.track === tr.id);
        nm.textContent = x().name;
      });
      const fr = h('div', 'row stripfader', s);
      vfader(mx, fr, { get: () => x().mix.volume, set: (v) => app.setTrackMix(tr.id, { volume: v }, 'VOLUME'), begin: () => app.beginDrag('VOLUME'), end: () => app.endDrag(), height: 84, def: 0.8, title: 'Level (0.8 = 0 dB, double-click)' });
      const met = h('div', 'meter', fr);
      met.style.width = cpx(10);
      trackMeters.push(h('div', 'lvl', met));
      const dbl = h('div', 'hint', s);
      mx.add(() => (dbl.textContent = dbText(x().mix.volume) + ' DB'));
      range(mx, s, { get: () => Math.round(x().mix.pan * 100), set: (v) => app.setTrackMix(tr.id, { pan: v / 100 }, 'PAN'), min: -100, max: 100, def: 0, bip: true, format: (v) => (v === 0 ? 'C' : v < 0 ? 'L' + -v : 'R' + v), begin: () => app.beginDrag('PAN'), end: () => app.endDrag(), title: 'Pan' });
      range(mx, s, { get: () => Math.round(x().mix.filter * 100), set: (v) => app.setTrackMix(tr.id, { filter: v / 100 }, 'FILTER'), min: -100, max: 100, def: 0, bip: true, format: (v) => (v === 0 ? 'FLT' : v < 0 ? 'LP' : 'HP'), begin: () => app.beginDrag('FILTER'), end: () => app.endDrag(), title: 'One-knob filter: left low-pass, right high-pass' });
      range(mx, s, { get: () => Math.round((x().mix.send ?? 0) * 100), set: (v) => app.setTrackMix(tr.id, { send: v / 100 }, 'SEND'), min: 0, max: 100, def: 0, format: (v) => 'FX ' + v, begin: () => app.beginDrag('SEND'), end: () => app.endDrag(), title: 'Send to the LXR FX bus (the dry sound also plays)' });
      const ms = h('div', 'row stripbtns', s);
      button(mx, ms, 'M', () => app.setTrackMix(tr.id, { mute: !x().mix.mute }), { cls: 'small', on: () => x().mix.mute, title: 'Mute' });
      button(mx, ms, 'S', () => app.setTrackMix(tr.id, { solo: !x().mix.solo }), { cls: 'small', on: () => x().mix.solo, title: 'Solo' });
      button(mx, ms, 'FX', () => app.setTrackMix(tr.id, { route: x().mix.route === 'fx' ? 'main' : 'fx' }, 'ROUTE'), { cls: 'small', on: () => x().mix.route === 'fx', title: 'Output routing: FX ONLY plays the track through the LXR FX bus and not dry; off plays it dry (plus the send)' });
      button(mx, ms, 'PRC', () => app.selectTrack(tr.id), { cls: 'small', on: () => channelFxActive(x().mix.fx), title: 'Channel processing (lit when a stage is on): select the track to edit it below' });
    });
    const s = h('div', 'strip master', strips);
    s.dataset.channel = 'master';
    h('div', 'sname inv', s, 'MASTER');
    const fr = h('div', 'row stripfader', s);
    vfader(mx, fr, { get: () => app.project.master.volume, set: (v) => app.setMaster({ volume: v }, 'MASTER VOLUME'), begin: () => app.beginDrag('MASTER VOLUME'), end: () => app.endDrag(), height: 84, def: 0.8, title: 'Master gain' });
    const mL = h('div', 'meter', fr);
    const mR = h('div', 'meter', fr);
    for (const m of [mL, mR]) m.style.width = cpx(10);
    masterMeters = [h('div', 'lvl', mL), h('div', 'lvl', mR)];
    const dbl = h('div', 'hint', s);
    mx.add(() => (dbl.textContent = dbText(app.project.master.volume) + ' DB'));
    const lg = h('div', 'meter h grmeter', s);
    lg.title = 'Limiter gain reduction';
    limGr = h('div', 'lvl', lg);
    h('div', 'tiny', s, 'LIMITER GR');
    button(mx, s, 'CLIP', () => app.setMaster({ clip: !app.project.master.clip }, 'SOFT CLIP'), { cls: 'small', on: () => app.project.master.clip, title: 'Soft clipper on the master (before the limiter)' });
  };
  build();
  app.on('project', build);

  // ---------------------------------------------------------------- the processing rows
  const proc = h('div', 'mixproc', pane);
  const stageUi = (parent: HTMLElement, title: string, on: () => boolean, toggle: () => void, tip: string, body: (b: HTMLElement) => void) => {
    const g = group(parent, title);
    g.classList.add('col', 'procstage');
    g.title = tip;
    button(mx, g, 'ON', toggle, { cls: 'small', on, title: 'Bypass or enable. A stage that is off costs nothing and leaves the sound untouched.' });
    body(g);
    return g;
  };

  // channel processing of the selected track
  const cg = group(proc, 'CHANNEL PROCESSING');
  cg.classList.add('col', 'procgroup');
  cg.dataset.test = 'channel-proc';
  const cgt = cg.firstElementChild as HTMLElement | null;
  mx.add(() => cgt && (cgt.textContent = `CHANNEL PROCESSING · ${t().name}`));
  const chf = (): ChannelFx => t().mix.fx ?? defaultChannelFx();
  const chrow = h('div', 'procwrap', cg);
  const cstage = <K extends keyof ChannelFx>(label: string, key: K, tip: string, fields: { f: keyof ChannelFx[K] & string; label: string; min: number; max: number; scale: number; def: number; bip?: boolean; format?: (v: number) => string; title: string }[]) =>
    stageUi(chrow, label, () => (chf()[key] as { on: boolean }).on, () => app.patchChannelFx(t().id, key, { on: !(chf()[key] as { on: boolean }).on } as never, label), tip, (g) => {
      for (const o of fields) {
        const c = ctl(g, o.label, o.title);
        range(mx, c.slot, {
          get: () => Math.round(((chf()[key] as unknown as Record<string, number>)[o.f] ?? 0) * o.scale),
          set: (v) => app.patchChannelFx(t().id, key, { [o.f]: v / o.scale } as never, label),
          min: o.min, max: o.max, def: o.def, bip: o.bip, format: o.format, begin: () => app.beginDrag(label), end: () => app.endDrag(), title: o.title,
        });
      }
    });
  cstage('TRANSIENT', 'trans', 'Shape the attack and the sustain of the track', [
    { f: 'attack', label: 'ATTACK', min: -100, max: 100, scale: 100, def: 0, bip: true, format: sgn, title: 'Boost (+) or soften (-) the first moment of each hit' },
    { f: 'sustain', label: 'SUSTAIN', min: -100, max: 100, scale: 100, def: 0, bip: true, format: sgn, title: 'Lengthen (+) or shorten (-) the tail' },
  ]);
  cstage('EQ', 'eq', 'Low shelf, mid peak and high shelf', [
    { f: 'low', label: 'LOW', min: -15, max: 15, scale: 1, def: 0, bip: true, format: (v) => sgn(v) + ' DB', title: 'Low shelf (100 Hz)' },
    { f: 'mid', label: 'MID', min: -15, max: 15, scale: 1, def: 0, bip: true, format: (v) => sgn(v) + ' DB', title: 'Mid peak (1 kHz)' },
    { f: 'high', label: 'HIGH', min: -15, max: 15, scale: 1, def: 0, bip: true, format: (v) => sgn(v) + ' DB', title: 'High shelf (8 kHz)' },
  ]);
  cstage('SATURATION', 'sat', 'Warm distortion', [
    { f: 'drive', label: 'DRIVE', min: 0, max: 100, scale: 100, def: 30, format: (v) => v + '%', title: 'Amount of saturation' },
    { f: 'mix', label: 'MIX', min: 0, max: 100, scale: 100, def: 100, format: (v) => v + '%', title: 'Dry/wet' },
  ]);
  cstage('SOFT CLIP', 'clip', 'A smooth ceiling for the track', [{ f: 'thresh', label: 'THRESHOLD', min: 5, max: 100, scale: 100, def: 80, format: (v) => v + '%', title: 'Level where clipping begins' }]);
  cstage('BIT REDUCTION', 'crush', 'Bit depth and sample-rate reduction', [
    { f: 'bits', label: 'BITS', min: 2, max: 16, scale: 1, def: 10, title: 'Bit depth' },
    { f: 'rate', label: 'RATE', min: 0, max: 100, scale: 100, def: 20, format: (v) => v + '%', title: 'Sample-rate reduction (0 = none)' },
  ]);
  const cbtn = h('div', 'row wrap', cg);
  button(mx, cbtn, 'RESET CHANNEL', () => app.setChannelFx(t().id, undefined, 'RESET CHANNEL'), { cls: 'small', disabled: () => !t().mix.fx, title: 'Remove this channel’s processing' });
  h('div', 'hint', cbtn, 'EACH TRACK HAS ITS OWN PROCESSING. IT SITS AFTER THE ONE-KNOB FILTER AND BEFORE THE FADER.');

  // bus processing
  const bg = group(proc, 'BUS PROCESSING');
  bg.classList.add('col', 'procgroup');
  bg.dataset.test = 'bus-proc';
  const bwrap = h('div', 'procwrap', bg);
  const bf = (): BusFx => app.outputFx().bus;
  const bstage = <K extends keyof BusFx>(label: string, key: K, tip: string, fields: { f: string; label: string; min: number; max: number; scale: number; def: number; bip?: boolean; format?: (v: number) => string; title: string }[], extra?: (g: HTMLElement) => void) =>
    stageUi(bwrap, label, () => (bf()[key] as { on: boolean }).on, () => app.patchOutput((o) => ((o.bus[key] as { on: boolean }).on = !(o.bus[key] as { on: boolean }).on), label), tip, (g) => {
      for (const o of fields) {
        const c = ctl(g, o.label, o.title);
        range(mx, c.slot, {
          get: () => Math.round(((bf()[key] as unknown as Record<string, number>)[o.f] ?? 0) * o.scale),
          set: (v) => app.patchOutput((out) => ((out.bus[key] as unknown as Record<string, number>)[o.f] = v / o.scale), label),
          min: o.min, max: o.max, def: o.def, bip: o.bip, format: o.format, begin: () => app.beginDrag(label), end: () => app.endDrag(), title: o.title,
        });
      }
      extra?.(g);
    });
  bstage('FILTER', 'filter', 'High-pass and low-pass on the whole mix', [
    { f: 'hp', label: 'HIGH-PASS', min: 20, max: 2000, scale: 1, def: 30, format: (v) => v + ' HZ', title: 'Remove everything below this' },
    { f: 'lp', label: 'LOW-PASS', min: 500, max: 20000, scale: 1, def: 18000, format: (v) => v + ' HZ', title: 'Remove everything above this' },
  ]);
  bstage('DISTORTION', 'dist', 'Distortion of the whole mix', [
    { f: 'drive', label: 'DRIVE', min: 0, max: 100, scale: 100, def: 25, format: (v) => v + '%', title: 'Amount' },
    { f: 'mix', label: 'MIX', min: 0, max: 100, scale: 100, def: 50, format: (v) => v + '%', title: 'Dry/wet' },
  ], (g) => {
    const c = ctl(g, 'SHAPE', 'Distortion curve');
    select<string>(mx, c.slot, { options: () => [{ value: 'tube', label: 'TUBE' }, { value: 'fold', label: 'FOLD' }, { value: 'clip', label: 'CLIP' }], get: () => bf().dist.type, set: (v) => app.patchOutput((o) => (o.bus.dist.type = v as 'tube'), 'DISTORTION SHAPE') });
  });
  bstage('COMPRESSOR', 'comp', 'Glue compressor on the whole mix', [
    { f: 'thresh', label: 'THRESHOLD', min: -40, max: 0, scale: 1, def: -14, bip: false, format: (v) => v + ' DB', title: 'Level above which the mix is compressed' },
    { f: 'ratio', label: 'RATIO', min: 1, max: 20, scale: 1, def: 3, format: (v) => v + ':1', title: 'Compression ratio' },
    { f: 'attack', label: 'ATTACK', min: 1, max: 100, scale: 1, def: 10, format: (v) => v + ' MS', title: 'Attack time' },
    { f: 'release', label: 'RELEASE', min: 5, max: 1000, scale: 1, def: 120, format: (v) => v + ' MS', title: 'Release time' },
    { f: 'makeup', label: 'MAKEUP', min: 0, max: 18, scale: 1, def: 2, format: (v) => '+' + v + ' DB', title: 'Make-up gain' },
    { f: 'mix', label: 'MIX', min: 0, max: 100, scale: 100, def: 100, format: (v) => v + '%', title: 'Parallel compression: dry/wet' },
  ], (g) => {
    const m = h('div', 'meter h grmeter', g);
    m.title = 'Gain reduction';
    busGr = h('div', 'lvl', m);
    h('div', 'tiny', g, 'GAIN REDUCTION');
  });
  bstage('STEREO', 'stereo', 'Stereo width of the mix bus', [{ f: 'width', label: 'WIDTH', min: 0, max: 200, scale: 100, def: 120, format: (v) => v + '%', title: '0 is mono, 100 unchanged, 200 doubled' }]);

  // master
  const mg = group(proc, 'MASTER');
  mg.classList.add('col', 'procgroup');
  mg.dataset.test = 'master-proc';
  const mc = ctl(mg, 'WIDTH', 'Stereo width of the final output (0 mono, 100 unchanged)');
  range(mx, mc.slot, { get: () => Math.round(app.outputFx().width * 100), set: (v) => app.patchOutput((o) => (o.width = v / 100), 'MASTER WIDTH'), min: 0, max: 200, def: 100, format: (v) => v + '%', begin: () => app.beginDrag('MASTER WIDTH'), end: () => app.endDrag(), title: 'Master width' });
  const lr = h('div', 'row wrap', mg);
  button(mx, lr, 'LIMITER', () => app.patchOutput((o) => (o.limiter.on = !o.limiter.on), 'LIMITER'), { cls: 'small', on: () => app.outputFx().limiter.on, title: 'A zero-latency limiter at the very end: nothing leaves the master above the ceiling' }).dataset.test = 'limiter-toggle';
  const lc = ctl(mg, 'CEILING', 'The highest level that can leave the master');
  range(mx, lc.slot, { get: () => Math.round(app.outputFx().limiter.ceiling * 10), set: (v) => app.patchOutput((o) => (o.limiter.ceiling = v / 10), 'LIMITER CEILING'), min: -120, max: 0, def: -3, format: (v) => (v / 10).toFixed(1) + ' DB', begin: () => app.beginDrag('CEILING'), end: () => app.endDrag(), title: 'Ceiling' });
  const lrel = ctl(mg, 'RELEASE', 'How fast the limiter lets go');
  range(mx, lrel.slot, { get: () => Math.round(app.outputFx().limiter.release), set: (v) => app.patchOutput((o) => (o.limiter.release = v), 'LIMITER RELEASE'), min: 5, max: 1000, def: 80, format: (v) => v + ' MS', begin: () => app.beginDrag('RELEASE'), end: () => app.endDrag(), title: 'Release' });
  const oc = ctl(mg, 'OUTPUT FX', 'Slop Factory output processing on the master (Core engines)');
  select(mx, oc.slot, {
    options: () => [{ value: '', label: 'NONE' }, ...CHAIN_PRESETS.map((p) => ({ value: p.key, label: p.label }))],
    get: () => matchChainPreset(repairChain(app.project.master.chain)) ?? '',
    set: (k) => app.setMaster({ chain: k ? (CHAIN_PRESETS.find((p) => p.key === k)?.config ?? null) : null }, 'OUTPUT CHAIN'),
    title: 'Slop Factory output processing on the master',
  });
  mx.add(() => {
    const warn = !app.outputFx().limiter.on;
    lr.title = warn ? 'The limiter is off: this project plays as it did before the limiter existed' : '';
  });

  const path = h('div', 'hint signalpath', pane, 'SIGNAL PATH · ' + SIGNAL_PATH);
  path.dataset.test = 'signal-path';

  subscribe(app, ['mix', 'tracks', 'selection', 'master'], () => mx.refresh());

  return {
    panels: [mx],
    frame: (m: MetersMessage | null) => {
      if (!m) return;
      for (let i = 0; i < trackMeters.length; i++) setW(trackMeters[i]!, db(m.tracks[i] ?? 0), 'height');
      if (masterMeters[0]) setW(masterMeters[0], db(m.masterL), 'height');
      if (masterMeters[1]) setW(masterMeters[1], db(m.masterR), 'height');
      if (busGr) setW(busGr, m.busReduction / 18);
      if (limGr) setW(limGr, m.limitReduction / 12);
    },
  };
}

export function fxPane(app: App, pane: HTMLElement): PaneParts {
  const fp = new Panel();
  const body = h('div', 'fxws sndscroll', pane);
  const left = h('div', 'col', body);
  const right = h('div', 'col', body);
  const fxg = group(left, 'LXR FX BUS');
  fxg.classList.add('col');
  fxg.dataset.test = 'lxr-fx';
  const fxType = () => app.project.kit.synth.params[PAR.FX_TYPE] ?? 0;
  const only: Record<number, number> = { [PAR.FX_DIST_TYPE]: 1, [PAR.FX_WAVE]: 2, [PAR.FX_RATIO]: 3, [PAR.FX_DELAY_TYPE]: 4 };
  for (const p of FX_PARAMS) {
    const wrap = h('div', '', fxg);
    const isP = p.id >= PAR.FX_P1 && p.id <= PAR.FX_P4;
    paramCtl(app, wrap, p, fp, { base: true, labelOf: isP ? () => FX_PARAM_LABELS[fxType()]?.[p.id - PAR.FX_P1] ?? p.label : undefined });
    if (only[p.id] !== undefined) fp.add(() => (wrap.style.display = fxType() === only[p.id] ? '' : 'none'));
    if (isP) fp.add(() => (wrap.style.display = fxType() === 0 || FX_PARAM_LABELS[fxType()]?.[p.id - PAR.FX_P1] === '-' ? 'none' : ''));
  }
  h('div', 'hint', left, 'THE FX BUS IS THE LXR’S OWN EFFECT: ONE EFFECT SHARED BY EVERY TRACK THAT SENDS TO IT. IT BELONGS TO THE SYNTH KIT, SO VARIATIONS DO NOT CHANGE IT. ITS RETURN JOINS THE MIX BEFORE THE BUS PROCESSING IN THE MIXER.');

  const sg = group(right, 'WHO FEEDS THE FX BUS');
  sg.classList.add('col');
  const rows = h('div', 'col sends', sg);
  const build = () => {
    rows.innerHTML = '';
    for (const tr of app.project.tracks) {
      const x = () => app.project.tracks.find((y) => y.id === tr.id) ?? tr;
      const r = h('div', 'row sendrow', rows);
      const nm = h('div', 'sname grow', r, tr.name);
      nm.addEventListener('click', () => app.selectTrack(tr.id));
      fp.add(() => {
        nm.textContent = x().name;
        nm.classList.toggle('inv', app.ui.track === tr.id);
      });
      button(fp, r, 'FX ONLY', () => app.setTrackMix(tr.id, { route: x().mix.route === 'fx' ? 'main' : 'fx' }, 'ROUTE'), { cls: 'small', on: () => x().mix.route === 'fx', title: 'Play this track only through the FX bus (no dry sound)' });
      range(fp, r, { get: () => Math.round((x().mix.send ?? 0) * 100), set: (v) => app.setTrackMix(tr.id, { send: v / 100 }, 'SEND'), min: 0, max: 100, def: 0, format: (v) => 'SEND ' + v, begin: () => app.beginDrag('SEND'), end: () => app.endDrag(), title: 'Send level (the dry sound also plays)', width: 150 });
    }
  };
  build();
  app.on('project', build);
  h('div', 'hint', right, 'FX ONLY SENDS THE WHOLE TRACK TO THE BUS. THE SEND LEVEL ADDS A SHARE OF THE TRACK TO THE BUS AND KEEPS THE DRY SOUND. EITHER CAN BE MODULATED (FX SEND IN THE MODULATION MATRIX).');
  subscribe(app, ['kit', 'mix', 'tracks', 'selection', 'project', 'status'], () => fp.refresh());
  return { panels: [fp] };
}
