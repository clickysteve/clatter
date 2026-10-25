/**
 * The MODULATION tab: sources (4 LFOs, 2 envelopes, step modulation, random, smooth random,
 * sample and hold, velocity, trigger, 4 macros), a source editor whose plot is the engine's own
 * output (the same ModRuntime that plays the track), and the routing matrix. It edits the sound
 * being edited: the base, or the open variation as a sparse override of the base.
 *
 * Live feedback comes from the engine: while this tab is open the audio engine reports the
 * selected track's source outputs, route values and destination sums, and the markers and bars
 * follow them.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import type { App } from '../../app/app';
import type { MetersMessage } from '../../audio/protocol';
import { defaultEnv, defaultLfo, defaultSource, defaultStep } from '../../mod/config';
import { exportMod } from '../../mod/format';
import { FACTORY_PRESETS } from '../../mod/presets';
import { DEST_INDEX, destApplies, destDef, RATE_NOTE } from '../../mod/registry';
import { isBipolar, simulate, srcIndex } from '../../mod/runtime';
import { envSegments, sineTable } from '../../mod/shapes';
import {
  divBeats, DIVISIONS, LFO_WAVE_LABEL, LFO_WAVES, MAX_ENV_POINTS, MAX_STEPS, POLARITY_LABEL, RETRIGS, SOURCE_IDS, SOURCE_LABEL, typeOfSource,
  type EnvDef, type EnvPoint, type LfoDef, type ModRoute, type Polarity, type SourceDef, type SourceId, type StepDef,
} from '../../mod/types';
import { button, chooseFiles, ctl, download, group, h, num, Panel, range, select } from '../widgets';
import { slotBar } from './soundControls';
import { askName, Plot, setW, sgn, vis, type PaneParts } from './soundUi';
import { subscribe } from './patternView';

const DIV_OPTS = DIVISIONS.map((d) => ({ value: d.id as string, label: d.label }));
const RETRIG_LABEL: Record<string, string> = { hit: 'EVERY HIT', free: 'FREE RUN', bar: 'BAR LINE', pattern: 'PATTERN START' };
const KIND_TAG: Partial<Record<SourceId, string>> = { step: 'STEP', rnd: 'RND', smooth: 'SMTH', sh: 'S&H', vel: 'VEL', trig: 'TRIG' };

type Rec = Record<string, unknown>;
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export function modulationPane(app: App, pane: HTMLElement): PaneParts {
  const mp = new Panel();
  const sel = () => app.ui.modSel;
  const mod = () => app.editedMod();
  const def = (): SourceDef | undefined => mod().sources[sel()];
  const type = () => typeOfSource(sel());
  const cur = (): Rec => (def() ?? defaultSource(sel())) as unknown as Rec;
  const gn = (k: string) => cur()[k] as number;
  const gs = (k: string) => cur()[k] as string;
  const gb = (k: string) => cur()[k] as boolean;
  const trackIdx = () => app.project.tracks.findIndex((x) => x.id === app.track.id);

  // ================================================================ toolbar
  const top = h('div', 'col sndtop', pane);
  const r1 = h('div', 'row wrap', top);
  slotBar(app, r1, mp);
  const info = h('div', 'tiny grow', r1);
  mp.add(() => {
    const m = mod();
    const slot = app.ui.slot;
    const patch = slot === null ? undefined : app.track.sound.variations?.[slot]?.mod;
    const ov = Object.keys(patch?.sources ?? {}).length + Object.keys(patch?.routes ?? {}).length;
    info.textContent = `${app.track.name} · ${slot === null ? 'BASE MODULATION' : `VARIATION ${'ABCD'[slot]}: ${ov} OVERRIDE${ov === 1 ? '' : 'S'} OF THE BASE`} · ${m.routes.length} ROUTE${m.routes.length === 1 ? '' : 'S'}`;
  });
  const r2 = h('div', 'row wrap', top);
  let presetId = '';
  const userPreset = () => app.modLibrary.get(presetId);
  select<string>(mp, r2, {
    options: () => [
      { value: '', label: 'PRESET…' },
      ...FACTORY_PRESETS.map((p) => ({ value: p.id, label: p.name })),
      ...app.modLibrary.list().map((p) => ({ value: p.id, label: '★ ' + p.name })),
    ],
    get: () => presetId,
    set: (v) => {
      presetId = v;
      if (v) app.loadModPreset(v);
      mp.refresh();
    },
    title: 'Replace this sound’s modulation with a factory or saved preset (undo brings it back)',
  }).dataset.test = 'mod-preset';
  button(mp, r2, 'SAVE…', () => askName('SAVE MODULATION PRESET', app.track.name + ' MOD', (n) => app.saveModPreset(n)), { cls: 'small', title: 'Save this sound’s modulation as a preset' }).dataset.test = 'mod-save';
  button(mp, r2, 'DUP', () => app.duplicateModPreset(presetId), { cls: 'small', disabled: () => !userPreset(), title: 'Duplicate the selected saved preset' });
  button(mp, r2, 'RENAME…', () => askName('RENAME PRESET', userPreset()?.name ?? '', (n) => app.renameModPreset(presetId, n), 'RENAME'), { cls: 'small', disabled: () => !userPreset(), title: 'Rename the selected saved preset' });
  button(mp, r2, 'DELETE', () => {
    app.deleteModPreset(presetId);
    presetId = '';
    mp.refresh();
  }, { cls: 'small', disabled: () => !userPreset(), title: 'Delete the selected saved preset' });
  button(mp, r2, 'EXPORT', () => download(`${app.track.name.toLowerCase().replace(/\W+/g, '-')}.clatter-mod.json`, new TextEncoder().encode(exportMod(mod(), userPreset()?.name ?? app.track.name)), 'application/json'), { cls: 'small', title: 'This sound’s modulation as a portable .clatter-mod.json file' });
  button(mp, r2, 'IMPORT…', async () => {
    const [f] = await chooseFiles('.json,application/json');
    if (!f) return;
    const id = app.importModPreset(await f.text());
    if (id) {
      presetId = id;
      mp.refresh();
    }
  }, { cls: 'small', title: 'Add a .clatter-mod.json file to the saved presets' });
  let intensity = 0.5;
  h('div', 'lbl', r2, 'AMOUNT');
  num(mp, r2, { get: () => Math.round(intensity * 100), set: (v) => ((intensity = v / 100), mp.refresh()), min: 5, max: 100, format: (v) => v + '%', title: 'How much GENERATE and MUTATE change' });
  button(mp, r2, 'GENERATE', () => app.generateModulation(intensity), { cls: 'small', title: 'Musical random modulation for this track (a press is reproducible from the project seed)' }).dataset.test = 'mod-generate';
  button(mp, r2, 'MUTATE', () => app.mutateModulation(intensity), { cls: 'small', title: 'Nudge the sources and routes of this modulation' }).dataset.test = 'mod-mutate';
  button(mp, r2, 'CLEAR', () => app.clearModulation(), { cls: 'small', title: 'Remove every source and route of the sound being edited' });

  // ================================================================ three columns
  const grid = h('div', 'modws', pane);
  const colS = group(grid, 'SOURCES');
  colS.classList.add('col', 'modsrcs');
  const colE = group(grid, 'EDITOR');
  colE.classList.add('col', 'modedit');
  const colR = group(grid, 'ROUTING MATRIX');
  colR.classList.add('col', 'modroutes');

  // ---------------------------------------------------------------- sources list
  const slist = h('div', 'list srclist', colS);
  const rows = new Map<SourceId, { li: HTMLDivElement; bar: HTMLDivElement; tag: HTMLDivElement; n: HTMLDivElement }>();
  for (const id of SOURCE_IDS) {
    const li = h('div', 'li srcrow', slist);
    li.dataset.source = id;
    li.addEventListener('click', () => app.selectModSource(id));
    h('div', 'srcname', li, SOURCE_LABEL[id]);
    const tag = h('div', 'tiny srctag', li);
    const n = h('div', 'tiny srcn', li);
    const bar = h('div', 'lvl', h('div', 'meter h srcmeter', li));
    rows.set(id, { li, bar, tag, n });
  }
  mp.add(() => {
    const m = mod();
    const slot = app.ui.slot;
    const patch = slot === null ? undefined : app.track.sound.variations?.[slot]?.mod;
    for (const id of SOURCE_IDS) {
      const r = rows.get(id)!;
      const d = m.sources[id];
      const used = m.routes.filter((x) => x.src === id).length;
      const on = !!d || used > 0;
      r.li.classList.toggle('on', sel() === id);
      r.li.classList.toggle('idle', !on);
      const ty = typeOfSource(id);
      r.tag.textContent = d?.type === 'lfo' ? d.wave.toUpperCase().slice(0, 4) : d?.type === 'env' ? d.kind.toUpperCase() : (KIND_TAG[id] ?? (ty === 'macro' ? 'PERF' : ''));
      r.n.textContent = (patch?.sources?.[id] !== undefined ? '◇' : '') + (used ? `${used}→` : '');
    }
  });
  h('div', 'hint', colS, 'CLICK A SOURCE TO EDIT IT. A SOURCE WITH NO ROUTE MODULATES NOTHING. ◇ = THE OPEN VARIATION OVERRIDES IT.');
  const mg = group(colS, 'MACROS · PERFORM');
  mg.classList.add('col');
  for (let i = 0; i < 4; i++) {
    const c = ctl(mg, 'MACRO ' + (i + 1), 'A performance knob shared by every track: route it from the matrix to move anything. Saved with the project.');
    range(mp, c.slot, { get: () => Math.round(app.macros()[i]! * 100), set: (v) => app.setMacro(i, v / 100), min: 0, max: 100, def: 0, format: (v) => v + '%', title: 'Macro ' + (i + 1) });
  }

  // ---------------------------------------------------------------- editor
  const head = h('div', 'row wrap', colE);
  const title = h('div', 'grow srctitle', head);
  const live = h('div', 'tiny livev', head);
  const status = h('div', 'hint', colE);
  const plot = new Plot(colE, 'modplot');
  plot.el.dataset.test = 'mod-plot';
  const pm = plot.marker();
  const sm = plot.marker(true);
  const scroll = h('div', 'col modparams sndscroll', colE);

  const slider = (parent: HTMLElement, label: string, key: string, o: { min: number; max: number; scale?: number; def: number; bip?: boolean; format?: (v: number) => string; title: string; get?: () => number; set?: (v: number) => void }) => {
    const c = ctl(parent, label, o.title);
    const k = o.scale ?? 1;
    range(mp, c.slot, {
      get: o.get ?? (() => Math.round(gn(key) * k)),
      set: o.set ?? ((v) => app.setSource(sel(), { [key]: v / k }, label)),
      min: o.min, max: o.max, def: o.def, bip: o.bip, format: o.format ?? (k === 100 ? (v) => v + '%' : undefined),
      begin: () => app.beginDrag(label), end: () => app.endDrag(), title: o.title,
    });
    return c.row;
  };
  const pick = (parent: HTMLElement, label: string, key: string, options: { value: string; label: string }[], title: string) => {
    const c = ctl(parent, label, title);
    select<string>(mp, c.slot, { options: () => options, get: () => gs(key), set: (v) => app.setSource(sel(), { [key]: v }, label), title });
    return c.row;
  };
  const toggle = (parent: HTMLElement, label: string, key: string, title: string) => button(mp, parent, label, () => app.setSource(sel(), { [key]: !gb(key) }, label), { cls: 'small', on: () => gb(key), title });
  const seedRow = (parent: HTMLElement) => {
    const c = ctl(parent, 'SEED', 'The random stream of this source. The same seed always plays the same random values.');
    num(mp, c.slot, { get: () => gn('seed'), set: (v) => app.setSource(sel(), { seed: v }, 'SEED'), min: 0, max: 9999, title: 'Seed' });
    return c.row;
  };

  const boxes: Record<string, HTMLDivElement> = {};
  const box = (k: string) => (boxes[k] = h('div', 'col', scroll));

  // ---- LFO
  const lfoBox = box('lfo');
  const L = (): LfoDef => ({ ...defaultLfo(), ...(cur() as unknown as Partial<LfoDef>) });
  pick(lfoBox, 'WAVE', 'wave', LFO_WAVES.map((w) => ({ value: w, label: LFO_WAVE_LABEL[w] })), 'Waveform: sine, triangle, saw up/down, square, variable pulse, sample and hold, stepped random, smooth random, or one you draw').dataset.test = 'lfo-wave';
  const modeRow = h('div', 'row wrap', lfoBox);
  h('div', 'lbl', modeRow, 'RATE');
  const seg = h('div', 'seg', modeRow);
  button(mp, seg, 'SYNC', () => app.setSource(sel(), { mode: 'sync' }, 'LFO MODE'), { cls: 'small', on: () => L().mode === 'sync', title: 'Locked to the tempo (a division of the beat)' });
  button(mp, seg, 'FREE', () => app.setSource(sel(), { mode: 'free' }, 'LFO MODE'), { cls: 'small', on: () => L().mode === 'free', title: 'A rate in Hz, independent of the tempo' });
  const divRow = pick(lfoBox, 'DIVISION', 'div', DIV_OPTS, 'Cycle length as a division of the beat');
  const hzRow = slider(lfoBox, 'RATE HZ', 'hz', {
    min: 0, max: 100, def: 55, title: 'Cycles per second',
    get: () => Math.round((100 * Math.log(L().hz / 0.05)) / Math.log(800)),
    set: (v) => app.setSource(sel(), { hz: Math.round(0.05 * Math.pow(800, v / 100) * 100) / 100 }, 'LFO RATE'),
    format: () => L().hz.toFixed(L().hz < 10 ? 2 : 1) + ' HZ',
  });
  vis(mp, divRow, () => L().mode === 'sync');
  vis(mp, hzRow, () => L().mode === 'free');
  slider(lfoBox, 'PHASE', 'phase', { min: 0, max: 100, scale: 100, def: 0, title: 'Where in the cycle the LFO starts' });
  slider(lfoBox, 'DEPTH', 'depth', { min: 0, max: 100, scale: 100, def: 100, title: 'Size of the swing' });
  slider(lfoBox, 'OFFSET', 'offset', { min: -100, max: 100, scale: 100, def: 0, bip: true, format: sgn, title: 'Added after depth' });
  slider(lfoBox, 'WIDTH', 'width', { min: 2, max: 98, scale: 100, def: 50, title: 'Pulse width, or the skew of the other waves (50 = symmetric)' });
  slider(lfoBox, 'BEND', 'bend', { min: -100, max: 100, scale: 100, def: 0, bip: true, format: sgn, title: 'Shape the curve towards the peaks (+) or towards the centre (-)' });
  pick(lfoBox, 'RETRIGGER', 'retrig', RETRIGS.map((r) => ({ value: r, label: RETRIG_LABEL[r]! })), 'EVERY HIT restarts the LFO at each hit of the track. FREE RUN never restarts. BAR LINE and PATTERN START align its phase to the bar or the pattern at each hit.');
  const lfoTools = h('div', 'row wrap', lfoBox);
  toggle(lfoTools, 'UNIPOLAR', 'uni', 'Swing between 0 and 1 instead of -1 and 1');
  const seedL = seedRow(lfoBox);
  vis(mp, seedL, () => ['sh', 'step', 'smooth'].includes(L().wave));
  const customTools = h('div', 'row wrap', lfoBox);
  button(mp, customTools, 'SINE', () => app.setSource(sel(), { table: sineTable() }, 'CUSTOM WAVE'), { cls: 'small', title: 'Start the drawn wave from a sine' });
  button(mp, customTools, 'CLEAR', () => app.setSource(sel(), { table: new Array(64).fill(0) }, 'CUSTOM WAVE'), { cls: 'small', title: 'Flatten the drawn wave' });
  button(mp, customTools, 'SMOOTH', () => {
    const t = (L().table ?? sineTable()).slice();
    const o = t.map((_, i) => ((t[(i + 63) % 64]! + 2 * t[i]! + t[(i + 1) % 64]!) / 4));
    app.setSource(sel(), { table: o }, 'CUSTOM WAVE');
  }, { cls: 'small', title: 'Soften the drawn wave' });
  h('div', 'hint', customTools, 'DRAG IN THE PLOT TO DRAW ONE CYCLE.');
  vis(mp, customTools, () => L().wave === 'custom');

  // ---- ENVELOPE
  const envBox = box('env');
  const E = (): EnvDef => ({ ...defaultEnv(), ...(cur() as unknown as Partial<EnvDef>) });
  const envKind = pick(envBox, 'TYPE', 'kind', [{ value: 'adsr', label: 'ADSR' }, { value: 'ahdsr', label: 'AHDSR' }, { value: 'multi', label: 'MULTISTAGE' }], 'ADSR, AHDSR (adds a hold), or a multistage envelope of up to 8 breakpoints that can loop');
  envKind.dataset.test = 'env-kind';
  const syncRow = h('div', 'row wrap', envBox);
  toggle(syncRow, 'SYNC TO TEMPO', 'sync', 'Times are in beats instead of milliseconds');
  const time = (parent: HTMLElement, label: string, key: string, title: string) =>
    slider(parent, label, key, {
      min: 0, max: 100, def: 20, title,
      get: () => Math.round(100 * Math.pow(clamp(gn(key) / (E().sync ? 8 : 4000), 0, 1), 1 / 2.5)),
      set: (v) => {
        const x = (E().sync ? 8 : 4000) * Math.pow(v / 100, 2.5);
        app.setSource(sel(), { [key]: E().sync ? Math.round(x * 100) / 100 : Math.round(x) }, label);
      },
      format: () => (E().sync ? gn(key).toFixed(2) + ' B' : Math.round(gn(key)) + ' MS'),
    });
  const adsr = h('div', 'col', envBox);
  time(adsr, 'ATTACK', 'a', 'Time to rise to full');
  const holdRow = time(adsr, 'HOLD', 'h', 'Time held at full (AHDSR)');
  vis(mp, holdRow, () => E().kind === 'ahdsr');
  time(adsr, 'DECAY', 'd', 'Time to fall to the sustain level');
  slider(adsr, 'SUSTAIN', 's', { min: 0, max: 100, scale: 100, def: 0, title: 'Level held while the sustain lasts' });
  time(adsr, 'SUSTAIN TIME', 'gate', 'How long the sustain is held before the release (0: release at once; drum hits have no note-off)');
  time(adsr, 'RELEASE', 'r', 'Time to fall to zero');
  slider(adsr, 'CURVE', 'curve', { min: -100, max: 100, scale: 100, def: -40, bip: true, format: sgn, title: 'Shape of the segments: negative is fast then slow (exponential)' });
  vis(mp, adsr, () => E().kind !== 'multi');
  const multi = h('div', 'col', envBox);
  const ptsBox = h('div', 'col', multi);
  let ptsKey = '';
  const buildPts = () => {
    const pts = E().pts;
    const key = String(pts.length);
    if (key === ptsKey) return;
    ptsKey = key;
    ptsBox.innerHTML = '';
    const edit = (i: number, patch: Partial<EnvPoint>, label: string) => {
      const next = E().pts.map((p, j) => (j === i ? { ...p, ...patch } : { ...p }));
      app.setSource(sel(), { pts: next }, label);
    };
    pts.forEach((_, i) => {
      const r = h('div', 'row wrap ptrow', ptsBox);
      h('div', 'lbl', r, 'P' + (i + 1));
      num(mp, r, { get: () => Math.round(E().pts[i]?.t ?? 0), set: (v) => edit(i, { t: v }, 'POINT TIME'), min: 0, max: 20000, format: (v) => v + (E().sync ? '' : ' MS'), title: 'Segment time' });
      range(mp, r, { get: () => Math.round((E().pts[i]?.v ?? 0) * 100), set: (v) => edit(i, { v: v / 100 }, 'POINT LEVEL'), min: 0, max: 100, format: (v) => v + '%', width: 80, begin: () => app.beginDrag('POINT'), end: () => app.endDrag(), title: 'Level at the end of the segment' });
      range(mp, r, { get: () => Math.round((E().pts[i]?.c ?? 0) * 100), set: (v) => edit(i, { c: v / 100 }, 'POINT CURVE'), min: -100, max: 100, bip: true, def: 0, format: sgn, width: 70, begin: () => app.beginDrag('POINT'), end: () => app.endDrag(), title: 'Segment curve' });
      button(mp, r, '×', () => {
        const next = E().pts.filter((_, j) => j !== i);
        if (next.length) app.setSource(sel(), { pts: next, loop: null }, 'REMOVE POINT');
      }, { cls: 'small', title: 'Remove this point' });
    });
  };
  const mr = h('div', 'row wrap', multi);
  button(mp, mr, 'ADD POINT', () => {
    if (E().pts.length >= MAX_ENV_POINTS) return;
    app.setSource(sel(), { pts: [...E().pts.map((p) => ({ ...p })), { t: 150, v: 0, c: -0.3 }] }, 'ADD POINT');
  }, { cls: 'small', disabled: () => E().pts.length >= MAX_ENV_POINTS, title: 'Add a breakpoint (8 at most)' });
  const loopOpts = () => E().pts.map((_, i) => ({ value: i, label: 'P' + (i + 1) }));
  h('div', 'lbl', mr, 'LOOP');
  select<number>(mp, mr, {
    options: () => [{ value: -1, label: 'OFF' }, ...loopOpts()],
    get: () => E().loop?.from ?? -1,
    set: (v) => app.setSource(sel(), { loop: v < 0 ? null : { from: v, to: Math.max(v, E().loop?.to ?? E().pts.length - 1) } }, 'ENVELOPE LOOP'),
    title: 'Loop from the end of this point…',
  });
  h('div', 'lbl', mr, 'TO');
  select<number>(mp, mr, {
    options: () => loopOpts(),
    get: () => E().loop?.to ?? E().pts.length - 1,
    set: (v) => E().loop && app.setSource(sel(), { loop: { from: Math.min(E().loop!.from, v), to: v } }, 'ENVELOPE LOOP'),
    title: '…to the end of this point',
  });
  slider(multi, 'START', 'v0', { min: 0, max: 100, scale: 100, def: 0, title: 'The level the envelope starts from' });
  vis(mp, multi, () => E().kind === 'multi');
  pick(envBox, 'TRIGGERED BY', 'trig', [{ value: 'hit', label: 'EVERY HIT' }, { value: 'accent', label: 'ACCENTS' }, { value: 'ghost', label: 'GHOST NOTES' }], 'Which hits start the envelope');
  pick(envBox, 'ON A NEW HIT', 'retrig', [{ value: 'restart', label: 'RESTART' }, { value: 'legato', label: 'CONTINUE' }, { value: 'ignore', label: 'IGNORE' }], 'What a hit does to an envelope that is still running');
  mp.add(buildPts);

  // ---- STEP
  const stepBox = box('step');
  const S = (): StepDef => ({ ...defaultStep(), ...(cur() as unknown as Partial<StepDef>) });
  slider(stepBox, 'LENGTH', 'len', { min: 1, max: MAX_STEPS, def: 8, title: 'Number of steps (1-32). The step modulator has its own length, independent of the pattern.', format: (v) => v + ' STEPS' });
  pick(stepBox, 'CLOCK', 'div', DIV_OPTS, 'Step length as a division of the beat: its own clock, independent of the pattern’s');
  pick(stepBox, 'DIRECTION', 'dir', [{ value: 'fwd', label: 'FORWARD' }, { value: 'rev', label: 'REVERSE' }, { value: 'ping', label: 'PING-PONG' }, { value: 'rand', label: 'RANDOM' }], 'Order the steps play in');
  slider(stepBox, 'GLIDE', 'glide', { min: 0, max: 100, scale: 100, def: 0, title: '0 jumps from step to step, 100 glides across the whole step' });
  pick(stepBox, 'RESTART', 'retrig', [{ value: 'hit', label: 'EVERY HIT' }, { value: 'free', label: 'FREE RUN' }], 'EVERY HIT starts from step 1 at each hit of the track');
  const stepTools = h('div', 'row wrap', stepBox);
  const stepSet = (vals: number[], label: string) => app.setSource(sel(), { vals }, label);
  button(mp, stepTools, 'CLEAR', () => stepSet(new Array(MAX_STEPS).fill(0), 'CLEAR STEPS'), { cls: 'small', title: 'All steps to zero' });
  button(mp, stepTools, 'RAMP', () => stepSet(S().vals.map((_, i) => (i < S().len ? -1 + (2 * i) / Math.max(1, S().len - 1) : 0)), 'RAMP STEPS'), { cls: 'small', title: 'A rising ramp over the steps' });
  button(mp, stepTools, 'ALTERNATE', () => stepSet(S().vals.map((_, i) => (i % 2 ? -0.6 : 0.8)), 'ALTERNATE STEPS'), { cls: 'small', title: 'High and low steps in turn' });
  button(mp, stepTools, 'RANDOM', () => app.randomiseModSource(sel()), { cls: 'small', title: 'Fresh random step values' });
  h('div', 'hint', stepTools, 'DRAG IN THE PLOT TO DRAW THE STEPS. DOUBLE-CLICK A STEP TO ZERO IT.');

  // ---- RANDOM, SMOOTH, S&H
  const rndBox = box('rnd');
  pick(rndBox, 'CLOCK', 'div', DIV_OPTS, 'How often a new random value is drawn');
  const rndTools = h('div', 'row wrap', rndBox);
  toggle(rndTools, 'UNIPOLAR', 'uni', 'Values between 0 and 1 instead of -1 and 1');
  seedRow(rndBox);
  const shBox = box('sh');
  pick(shBox, 'CLOCK', 'div', DIV_OPTS, 'How often the input is sampled');
  pick(shBox, 'INPUT', 'from', [{ value: 'noise', label: 'NOISE' }, ...SOURCE_IDS.filter((s) => s !== 'sh').map((s) => ({ value: s as string, label: SOURCE_LABEL[s] }))], 'What is sampled: noise or another source of this track');
  const shTools = h('div', 'row wrap', shBox);
  toggle(shTools, 'UNIPOLAR', 'uni', 'Values between 0 and 1 instead of -1 and 1');
  seedRow(shBox);

  // ---- TRIGGER, VELOCITY, MACRO
  const trigBox = box('trig');
  slider(trigBox, 'DECAY', 'ms', { min: 0, max: 100, def: 40, title: 'How long the pulse of a hit takes to fall (5 ms to 5 s)', get: () => Math.round(100 * Math.log(gn('ms') / 5) / Math.log(1000)), set: (v) => app.setSource(sel(), { ms: Math.round(5 * Math.pow(1000, v / 100)) }, 'TRIGGER DECAY'), format: () => Math.round(gn('ms')) + ' MS' });
  const trigTools = h('div', 'row wrap', trigBox);
  toggle(trigTools, 'SCALE BY VELOCITY', 'vel', 'A harder hit makes a bigger pulse');
  h('div', 'hint', trigBox, 'A PULSE THAT JUMPS TO ITS FULL SIZE AT EVERY HIT AND FALLS AWAY: A SIMPLE WAY TO ACCENT THE START OF A SOUND.');
  const velBox = box('vel');
  h('div', 'hint', velBox, 'THE VELOCITY OF EACH HIT, 0 TO 1. IT NEEDS NO SETTINGS; ROUTE IT TO MAKE HARD HITS BRIGHTER OR LONGER.');
  const macroBox = box('macro');
  h('div', 'hint', macroBox, 'A PERFORMANCE KNOB (LEFT COLUMN). ONE VALUE IS SHARED BY EVERY TRACK THAT ROUTES IT.');

  const foot = h('div', 'row wrap', colE);
  button(mp, foot, 'ADD SOURCE', () => app.activateSource(sel()), { cls: 'small', title: 'Make this source active with default settings', disabled: () => !!def() || type() === 'macro' || sel() === 'vel' }).dataset.test = 'mod-add-source';
  button(mp, foot, 'RANDOMISE', () => app.randomiseModSource(sel()), { cls: 'small', disabled: () => !def() || sel() === 'vel' || type() === 'trig', title: 'Randomise this source’s settings (a related, musical result)' });
  button(mp, foot, 'REMOVE', () => app.removeSource(sel()), { cls: 'small', disabled: () => !def() && !mod().routes.some((r) => r.src === sel()), title: 'Remove this source and every route that uses it' });

  mp.add(() => {
    const t = type();
    const d = def();
    boxes.lfo!.style.display = t === 'lfo' ? '' : 'none';
    boxes.env!.style.display = t === 'env' ? '' : 'none';
    boxes.step!.style.display = t === 'step' ? '' : 'none';
    boxes.rnd!.style.display = t === 'rnd' || t === 'smooth' ? '' : 'none';
    boxes.sh!.style.display = t === 'sh' ? '' : 'none';
    boxes.trig!.style.display = t === 'trig' ? '' : 'none';
    boxes.vel!.style.display = t === 'vel' ? '' : 'none';
    boxes.macro!.style.display = t === 'macro' ? '' : 'none';
    title.textContent = SOURCE_LABEL[sel()];
    status.textContent = d || t === 'macro' || t === 'vel' ? '' : 'NOT ACTIVE: CHANGE A SETTING OR PRESS ADD SOURCE, OR ROUTE IT.';
    plot.el.style.display = t === 'macro' || t === 'vel' ? 'none' : '';
  });

  // ---- the plot: the engine's own output for this source
  let plotKey = '';
  let plotInfo: { span: number; cycles: number; total: number } = { span: 1, cycles: 1, total: 1 };
  const previewOf = (id: SourceId, d: SourceDef, bpm: number) => {
    const beat = 60 / bpm;
    let span = 1;
    let cycles = 1;
    let total = 1;
    switch (d.type) {
      case 'lfo': {
        const cyc = d.mode === 'sync' ? divBeats(d.div) * beat : 1 / d.hz;
        cycles = ['sh', 'step', 'smooth'].includes(d.wave) ? 4 : 1;
        span = cyc * cycles;
        break;
      }
      case 'env': {
        total = envSegments(d, d.sync ? beat : 0.001).reduce((a, s) => a + s.dur, 0);
        span = Math.max(0.05, total * 1.1);
        break;
      }
      case 'step':
        span = d.len * divBeats(d.div) * beat;
        break;
      case 'rnd':
      case 'smooth':
      case 'sh':
        span = 8 * divBeats(d.div) * beat;
        break;
      case 'trig':
        span = Math.max(0.05, (d.ms / 1000) * 4);
        break;
      default:
        return null;
    }
    const dt = span / 240;
    const vel = d.type === 'env' ? (d.trig === 'accent' ? 127 : d.trig === 'ghost' ? 20 : 100) : 100;
    const r = simulate({ sources: { [id]: d }, routes: [] }, { bpm, seconds: span, hitsAt: [0], dt, vel });
    return { span, cycles, total, y: r.out[srcIndex(id)]! };
  };
  const redrawPlot = () => {
    const id = sel();
    const d = def();
    const bpm = app.project.tempo;
    const key = id + '|' + bpm + '|' + JSON.stringify(d ?? null);
    if (key === plotKey) return;
    plotKey = key;
    if (!d || typeOfSource(id) === 'macro' || id === 'vel') {
      plot.set((g, W, H) => {
        g.font = `${Math.round(H / 5)}px VT323, monospace`;
        g.textBaseline = 'middle';
        g.fillText(d ? '' : 'NOT ACTIVE', 10, H / 2);
      });
      return;
    }
    const bip = isBipolar(d);
    const yOf = (v: number, H: number) => (bip ? H / 2 - v * (H / 2 - 3) : H - 3 - v * (H - 6));
    if (d.type === 'lfo' && d.wave === 'custom') {
      const t = d.table ?? sineTable();
      plotInfo = { span: 1, cycles: 1, total: 1 };
      plot.set((g, W, H) => {
        g.fillRect(0, Math.round(H / 2), W, 1);
        g.lineWidth = 2;
        g.beginPath();
        t.forEach((v, i) => {
          const x = ((i + 0.5) / t.length) * W;
          const y = H / 2 - v * (H / 2 - 3);
          if (i) g.lineTo(x, y);
          else g.moveTo(x, y);
        });
        g.stroke();
      });
      return;
    }
    if (d.type === 'step') {
      plotInfo = { span: 1, cycles: 1, total: 1 };
      plot.set((g, W, H) => {
        g.fillRect(0, Math.round(H / 2), W, 1);
        const w = W / d.len;
        for (let i = 0; i < d.len; i++) {
          const v = d.vals[i] ?? 0;
          const y = H / 2 - v * (H / 2 - 3);
          g.fillRect(Math.floor(i * w) + 1, Math.min(y, H / 2), Math.max(1, Math.ceil(w) - 2), Math.max(2, Math.abs(y - H / 2)));
        }
      });
      return;
    }
    const pv = previewOf(id, d, bpm);
    if (!pv) return;
    plotInfo = { span: pv.span, cycles: pv.cycles, total: pv.total };
    plot.set((g, W, H) => {
      if (bip) g.fillRect(0, Math.round(H / 2), W, 1);
      g.lineWidth = 2;
      g.beginPath();
      const n = pv.y.length;
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * W;
        const y = yOf(pv.y[i]!, H);
        if (i) g.lineTo(x, y);
        else g.moveTo(x, y);
      }
      g.stroke();
      if (pv.cycles > 1) {
        for (let c = 1; c < pv.cycles; c++) g.fillRect(Math.round((c / pv.cycles) * W), 0, 1, 6);
      }
    });
  };
  mp.add(redrawPlot);

  // drawing on the plot: the custom LFO wave and the step values
  let drag: { kind: 'table' | 'vals'; last: number } | null = null;
  const draw = (e: PointerEvent, first: boolean) => {
    const d = def();
    if (!drag || !d) return;
    const r = plot.cv.getBoundingClientRect();
    const x = clamp((e.clientX - r.left) / (r.width || 1), 0, 0.99999);
    const y = clamp((r.height / 2 - (e.clientY - r.top)) / (r.height / 2 - 3), -1, 1);
    const val = Math.round(y * 100) / 100;
    if (drag.kind === 'table' && d.type === 'lfo') {
      const t = (d.table ?? sineTable()).slice();
      const i = Math.floor(x * t.length);
      const from = first ? i : drag.last;
      const step = i >= from ? 1 : -1;
      for (let k = from; k !== i + step; k += step) t[k] = val;
      drag.last = i;
      app.setSource(sel(), { table: t }, 'CUSTOM WAVE');
    } else if (drag.kind === 'vals' && d.type === 'step') {
      const vals = d.vals.slice();
      const i = Math.floor(x * d.len);
      const from = first ? i : drag.last;
      const step = i >= from ? 1 : -1;
      for (let k = from; k !== i + step; k += step) vals[k] = val;
      drag.last = i;
      app.setSource(sel(), { vals }, 'STEP VALUES');
    }
  };
  plot.el.addEventListener('pointerdown', (e) => {
    const d = def();
    if (!d) return;
    const kind = d.type === 'lfo' && d.wave === 'custom' ? 'table' : d.type === 'step' ? 'vals' : null;
    if (!kind) return;
    drag = { kind, last: 0 };
    plot.el.setPointerCapture(e.pointerId);
    app.beginDrag(kind === 'table' ? 'CUSTOM WAVE' : 'STEP VALUES');
    draw(e, true);
  });
  plot.el.addEventListener('pointermove', (e) => drag && draw(e, false));
  const up = () => {
    if (drag) app.endDrag();
    drag = null;
  };
  plot.el.addEventListener('pointerup', up);
  plot.el.addEventListener('pointercancel', up);
  plot.el.addEventListener('dblclick', (e) => {
    const d = def();
    if (d?.type !== 'step') return;
    const r = plot.cv.getBoundingClientRect();
    const i = Math.floor(clamp((e.clientX - r.left) / (r.width || 1), 0, 0.99999) * d.len);
    const vals = d.vals.slice();
    vals[i] = 0;
    app.setSource(sel(), { vals }, 'STEP VALUES');
  });

  // ---------------------------------------------------------------- routing matrix
  const addRow = h('div', 'row wrap', colR);
  let addSrc: SourceId | '' = '';
  let addDst = '';
  const dstOptions = () => app.modDestinations().map((d) => ({ value: d.id, label: `${d.group} · ${d.label}` }));
  select<string>(mp, addRow, {
    options: () => SOURCE_IDS.map((s) => ({ value: s as string, label: SOURCE_LABEL[s] })),
    get: () => addSrc || sel(),
    set: (v) => ((addSrc = v as SourceId), mp.refresh()),
    title: 'The source of the new route (defaults to the source being edited)',
  });
  h('div', 'tiny', addRow, '→');
  select<string>(mp, addRow, {
    options: dstOptions,
    get: () => (dstOptions().some((o) => o.value === addDst) ? addDst : (dstOptions()[0]?.value ?? '')),
    set: (v) => ((addDst = v), mp.refresh()),
    title: 'The destination: only parameters that exist on this track’s source and voice are listed',
  });
  button(mp, addRow, 'ADD ROUTE', () => app.addRoute((addSrc || sel()) as SourceId, dstOptions().some((o) => o.value === addDst) ? addDst : (dstOptions()[0]?.value ?? '')), { cls: 'small', title: 'Connect the source to the destination' }).dataset.test = 'mod-add-route';
  const rinfo = h('div', 'hint', colR);
  const rlist = h('div', 'col routelist sndscroll', colR);
  interface RouteUi { id: string; bar: HTMLDivElement; dbar: HTMLDivElement; }
  let routeUi: RouteUi[] = [];
  let routeKey = '';
  const bip = (el: HTMLElement, v: number) => {
    const s = `${v.toFixed(3)}`;
    if (el.dataset.v === s) return;
    el.dataset.v = s;
    el.style.setProperty('--l', (v < 0 ? 50 + v * 50 : 50) + '%');
    el.style.setProperty('--w', Math.abs(v) * 50 + '%');
  };
  const buildRoutes = () => {
    const m = mod();
    const { mode, voice } = app.modTarget();
    const key = m.routes.map((r) => r.id).join(',') + '|' + mode + voice + '|' + app.ui.slot;
    if (key === routeKey) return;
    routeKey = key;
    rlist.innerHTML = '';
    routeUi = [];
    if (!m.routes.length) h('div', 'hint', rlist, 'NO ROUTES. PICK A SOURCE AND A DESTINATION ABOVE, OR LOAD A PRESET.');
    for (const r0 of m.routes) {
      const id = r0.id;
      const rt = (): ModRoute => mod().routes.find((x) => x.id === id) ?? r0;
      const blk = h('div', 'route', rlist);
      blk.dataset.route = id;
      const a = h('div', 'row wrap', blk);
      button(mp, a, 'ON', () => app.setRoute(id, { on: !rt().on }, 'ROUTE ON/OFF'), { cls: 'small', on: () => rt().on, title: 'Enable or bypass this route' });
      select<string>(mp, a, { options: () => SOURCE_IDS.map((s) => ({ value: s as string, label: SOURCE_LABEL[s] })), get: () => rt().src, set: (v) => app.setRoute(id, { src: v as SourceId }, 'ROUTE SOURCE'), title: 'Source' });
      h('div', 'tiny', a, '→');
      select<string>(mp, a, {
        options: () => {
          const o = dstOptions();
          return o.some((x) => x.value === rt().dst) ? o : [...o, { value: rt().dst, label: `${destDef(rt().dst)?.label ?? rt().dst} (NOT ON THIS TRACK)` }];
        },
        get: () => rt().dst,
        set: (v) => app.setRoute(id, { dst: v }, 'ROUTE DESTINATION'),
        title: 'Destination',
      });
      const tagEl = h('div', 'tiny rtag', a);
      button(mp, a, '×', () => app.removeRoute(id), { cls: 'small', title: 'Remove this route' });
      const b = h('div', 'row wrap', blk);
      range(mp, b, { get: () => Math.round(rt().amt * 100), set: (v) => app.setRoute(id, { amt: v / 100 }, 'ROUTE AMOUNT'), min: -100, max: 100, bip: true, def: 30, format: sgn, width: 150, begin: () => app.beginDrag('ROUTE AMOUNT'), end: () => app.endDrag(), title: 'Amount: the share of the destination’s range a full source swing moves it. Negative inverts.' });
      select<Polarity>(mp, b, { options: () => (Object.keys(POLARITY_LABEL) as Polarity[]).map((p) => ({ value: p, label: POLARITY_LABEL[p] })), get: () => rt().pol, set: (v) => app.setRoute(id, { pol: v }, 'ROUTE POLARITY'), title: 'AS IS: the source as it is. INVERT: flipped. UNIPOLAR: only the positive half-range 0..1.' });
      h('div', 'lbl', b, 'SMOOTH');
      num(mp, b, { get: () => rt().smooth, set: (v) => app.setRoute(id, { smooth: v }, 'ROUTE SMOOTHING'), min: 0, max: 2000, format: (v) => v + ' MS', title: 'Smoothing time (0 = none). Trigger-time destinations are not smoothed.' });
      const c = h('div', 'row wrap', blk);
      h('div', 'lbl', c, 'RANGE');
      num(mp, c, { get: () => Math.round(rt().lo * 100), set: (v) => app.setRoute(id, { lo: Math.min(v / 100, rt().hi) }, 'ROUTE RANGE'), min: -100, max: 100, format: sgn, title: 'Lowest contribution of this route (the modulation range)' });
      num(mp, c, { get: () => Math.round(rt().hi * 100), set: (v) => app.setRoute(id, { hi: Math.max(v / 100, rt().lo) }, 'ROUTE RANGE'), min: -100, max: 100, format: sgn, title: 'Highest contribution of this route' });
      const meters = h('div', 'grow routemeters', c);
      const bar = h('div', 'bipbar', meters);
      const dbar = h('div', 'bipbar dest', meters);
      bar.title = 'This route’s value now';
      dbar.title = 'The sum of every route into this destination now';
      const note = h('div', 'tiny rnote', blk);
      mp.add(() => {
        const r = rt();
        const dd = destDef(r.dst);
        const ok = destApplies(r.dst, mode, voice);
        blk.classList.toggle('dead', !ok);
        blk.classList.toggle('off', !r.on);
        const slot = app.ui.slot;
        const ov = slot !== null && app.track.sound.variations?.[slot]?.mod?.routes?.[id] !== undefined;
        tagEl.textContent = (ov ? '◇ ' : '') + (dd ? (dd.rate === 'trigger' ? 'AT HIT' : 'LIVE') : '');
        note.textContent = !ok ? 'THIS DESTINATION DOES NOT EXIST ON THIS TRACK: THE ROUTE IS IGNORED.' : dd ? `${dd.help} ${RATE_NOTE[dd.rate]}.${dd.note ? ' ' + dd.note + '.' : ''}` : '';
      });
      routeUi.push({ id, bar, dbar });
    }
  };
  mp.add(() => {
    buildRoutes();
    const n = mod().routes.length;
    rinfo.textContent = `${n} ROUTE${n === 1 ? '' : 'S'} · LIVE = FOLLOWS THE SOURCE WHILE THE SOUND PLAYS · AT HIT = READ WHEN THE HIT TRIGGERS · TWO BARS: THE ROUTE, THE DESTINATION’S SUM`;
  });
  subscribe(app, ['mod', 'tracks', 'selection', 'kit', 'project', 'view'], () => mp.refresh());

  // ---------------------------------------------------------------- live feedback from the engine
  const frame = (m: MetersMessage | null) => {
    const md = m?.mod;
    if (!md || md.track !== trackIdx()) return;
    const id = sel();
    const k = srcIndex(id);
    const cfg = mod();
    for (const sid of SOURCE_IDS) {
      const r = rows.get(sid)!;
      const v = md.out[srcIndex(sid)] ?? 0;
      const d = cfg.sources[sid];
      setW(r.bar, d && isBipolar(d) ? (v + 1) / 2 : sid === 'vel' || sid === 'trig' || sid.startsWith('m') ? Math.abs(v) : (v + 1) / 2);
    }
    const v = md.out[k] ?? 0;
    const txt = `OUT ${v >= 0 ? '+' : ''}${v.toFixed(2)}`;
    if (live.textContent !== txt) live.textContent = txt;
    const d = cfg.sources[id];
    const p = md.pos[k] ?? 0;
    if (d?.type === 'lfo' && plotInfo.cycles === 1 && d.wave !== 'custom') pm.at((((p - d.phase) % 1) + 1) % 1);
    else if (d?.type === 'lfo' && d.wave === 'custom') pm.at(p);
    else if (d?.type === 'env' && p > 0) pm.at((p * plotInfo.total) / plotInfo.span);
    else pm.at(null);
    if (d?.type === 'step') sm.at(Math.floor(p) / d.len, 1 / d.len);
    else sm.at(null);
    const routes = cfg.routes;
    for (let i = 0; i < routeUi.length; i++) {
      const u = routeUi[i]!;
      bip(u.bar, md.routes[i] ?? 0);
      const di = routes.find((r) => r.id === u.id)?.dst;
      const idx = di ? (DEST_INDEX.get(di) ?? -1) : -1;
      bip(u.dbar, idx >= 0 ? (md.dest[idx] ?? 0) : 0);
    }
  };

  let open = false;
  mp.add(() => open && app.watchMod(true));
  return {
    panels: [mp],
    frame,
    active: (on) => {
      open = on;
      app.watchMod(on);
      if (on) {
        plotKey = '';
        mp.refresh();
        plot.draw();
      }
    },
  };
}
