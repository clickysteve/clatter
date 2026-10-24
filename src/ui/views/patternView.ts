/**
 * PATTERN: RHYTHM and DESTRUCTION. The generator, the grid, the step inspector, the
 * transformation layers and the selected track's performance controls.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import type { App, Topic } from '../../app/app';
import { RESOLUTION_LABEL, RESOLUTIONS, ROLE_LABEL, ROLES, ROLL_SPEEDS, type Hit, type Resolution, type Role } from '../../model/types';
import { STYLES, styleById } from '../../rhythm/styles';
import { PatternGrid } from '../grid';
import { button, ctl, group, h, num, Panel, range, select, win } from '../widgets';

export interface View {
  root: HTMLDivElement;
  /** every animation frame while visible */
  frame(): void;
  show(on: boolean): void;
}

/** A 0-1 setting shown as a percentage. */
export function pctRange(panel: Panel, parent: HTMLElement, app: App, label: string, get: () => number, set: (v: number) => void, title?: string, def?: number): HTMLDivElement {
  const c = ctl(parent, label, title);
  return range(panel, c.slot, {
    get: () => Math.round(get() * 100),
    set: (v) => set(v / 100),
    min: 0,
    max: 100,
    format: (v) => v + '%',
    def: def === undefined ? undefined : Math.round(def * 100),
    begin: () => app.beginDrag(label),
    end: () => app.endDrag(),
    title,
  });
}

export function subscribe(app: App, topics: Topic[], fn: () => void): void {
  for (const t of topics) app.on(t, fn);
}

export function patternView(app: App, screen: HTMLElement): View {
  const root = h('div', 'view', screen);
  root.dataset.view = 'pattern';

  // ---------------------------------------------------------------- GENERATE
  const gw = win(root, { x: 8, y: 84, w: 250, h: 300, title: 'GENERATE', area: 'rhythm', id: 'generate' });
  const gp = new Panel();
  const gb = gw.body;
  gb.classList.add('col');
  const sr = ctl(gb, 'STYLE', 'The rhythmic language the generator speaks');
  select(gp, sr.slot, { options: () => STYLES.map((s) => ({ value: s.id, label: s.label })), get: () => app.project.gen.style, set: (v) => app.setGen({ style: v }, 'STYLE'), title: 'Style' }).dataset.test = 'style';
  const desc = h('div', 'report', gb);
  desc.style.whiteSpace = 'normal';
  desc.style.height = '18px';
  gp.add(() => (desc.textContent = styleById(app.project.gen.style).description));
  pctRange(gp, gb, app, 'DENSITY', () => app.project.gen.density, (v) => app.setGen({ density: v }, 'DENSITY'), 'How many hits');
  pctRange(gp, gb, app, 'COMPLEX', () => app.project.gen.complexity, (v) => app.setGen({ complexity: v }, 'COMPLEXITY'), 'Syncopation, off-grid emphasis, ghost notes');
  pctRange(gp, gb, app, 'VARIATION', () => app.project.gen.variation, (v) => app.setGen({ variation: v }, 'VARIATION'), 'How much the bars differ from each other');
  pctRange(gp, gb, app, 'ACCENT', () => app.project.gen.accent, (v) => app.setGen({ accent: v }, 'ACCENT'), 'Velocity contrast between strong and weak hits');
  pctRange(gp, gb, app, 'FILLS', () => app.project.gen.fills, (v) => app.setGen({ fills: v }, 'FILLS'), 'Fills into the end of the phrase');
  const br = ctl(gb, 'BARS', 'Length of a generated pattern');
  num(gp, br.slot, { get: () => app.project.gen.bars, set: (v) => app.setGen({ bars: v }, 'BARS'), min: 1, max: 4, width: 30 });
  const r1 = h('div', 'row', gb);
  button(gp, r1, 'GENERATE', () => app.generatePattern(), { cls: 'grow', title: 'A new pattern in this style (G). Locked tracks and hand edits stay.' }).dataset.test = 'generate';
  button(gp, r1, 'VARIATION', () => app.variation(), { cls: 'grow', title: 'A related pattern (V)' });
  button(gp, r1, 'MUTATE', () => app.mutate(), { cls: 'grow', title: 'Small controlled changes (M)' });
  const r2 = h('div', 'row', gb);
  button(gp, r2, 'REGEN', () => app.regenerate(), { cls: 'grow', title: 'New material after bar 1 (R)' });
  button(gp, r2, 'KEEP', () => app.keepEdits(), { cls: 'grow', title: 'Bake the hand edits into the pattern', disabled: () => app.editCount() === 0 });
  button(gp, r2, 'RESET', () => app.reset(), { cls: 'grow', title: 'Back to the generated pattern: hand edits cleared, CHOP/ROLLS/DESTROY off' });
  const evo = group(gb, 'EVOLVE');
  const er = h('div', 'row', evo);
  select(gp, er, {
    options: () => (['off', 'rhythm', 'sound', 'both'] as const).map((v) => ({ value: v, label: v.toUpperCase() })),
    get: () => app.project.evolve.target,
    set: (v) => app.setEvolve({ target: v }),
    width: 64,
    title: 'What changes on its own while playing: the rhythm mutates, the kit drifts, or both',
  }).dataset.test = 'evolve';
  h('div', 'lbl', er, 'EVERY');
  num(gp, er, { get: () => app.project.evolve.every, set: (v) => app.setEvolve({ every: v }), min: 1, max: 32, width: 26, title: 'Every n bars' });
  h('div', 'lbl', er, 'AMT');
  num(gp, er, { get: () => Math.round(app.project.evolve.amount * 100), set: (v) => app.setEvolve({ amount: v / 100 }), min: 0, max: 100, width: 30, format: (v) => v + '%', title: 'How far each step goes' });
  const ret = h('div', 'row', evo);
  h('div', 'lbl', ret, 'RETURN');
  num(gp, ret, { get: () => app.project.evolve.returnEvery, set: (v) => app.setEvolve({ returnEvery: v }), min: 0, max: 32, width: 26, format: (v) => (v ? String(v) : 'OFF'), title: 'Rhythm: back to the written pattern after this many generations (0 never)' });
  button(gp, ret, 'KIT HOME', () => app.evolveReturn(), { cls: 'small', title: 'Sound: back to the kit the evolution started from' });
  const ginfo = h('div', 'report', gb);
  gp.add(() => (ginfo.textContent = `SEED ${app.pattern.seed} · GEN ${app.pattern.generation} · ${app.editCount()} HAND EDITS`));
  subscribe(app, ['gen', 'pattern', 'transport'], () => gp.refresh());

  // ---------------------------------------------------------------- PATTERN grid
  const pw = win(root, { x: 266, y: 84, w: 1006, h: 470, title: 'PATTERN', area: 'rhythm', id: 'pattern' });
  const pp = new Panel();
  const tools = pw.tools;
  h('div', 'lbl', tools, 'LEN');
  num(pp, tools, { get: () => app.pattern.steps, set: (v) => app.setLength(v), min: 1, max: 64, width: 26, title: 'Pattern length in steps' }).dataset.test = 'length';
  select(pp, tools, { options: () => RESOLUTIONS.map((r) => ({ value: r, label: RESOLUTION_LABEL[r] })), get: () => app.pattern.res, set: (r: Resolution) => app.setResolution(r), width: 46, title: 'Step resolution' });
  h('div', 'lbl', tools, 'VEL');
  num(pp, tools, { get: () => app.ui.paintVel, set: (v) => ((app.ui.paintVel = v), pp.refresh()), min: 1, max: 127, width: 28, title: 'Velocity of new hits' });
  button(pp, tools, 'SOURCE', null, { cls: 'small', on: () => app.ui.sourceOnly, hold: (d) => app.setSourceOnly(d), title: 'Hold: hear only the written pattern (no density, fills, CHOP, ROLLS, DESTROY)' });
  const grid = new PatternGrid(app, pw.body, { width: 992, height: 440 });
  pp.add(() => {
    const p = app.pattern;
    pw.setTitle(`PATTERN ${p.name}`);
    pw.info.textContent = `${p.steps} STEPS · ${RESOLUTION_LABEL[p.res]} · ${app.editCount()} EDITS`;
  });
  subscribe(app, ['pattern', 'destruction'], () => {
    grid.draw();
    pp.refresh();
  });
  subscribe(app, ['tracks', 'mix', 'project'], () => {
    grid.build();
    pp.refresh();
  });
  app.on('selection', () => {
    grid.refreshRows();
    grid.drawOverlay(-1);
  });
  window.addEventListener('clatter-palette', () => grid.draw());

  // ---------------------------------------------------------------- STEP inspector
  const sw = win(root, { x: 8, y: 392, w: 250, h: 400, title: 'STEP', area: 'rhythm', id: 'step' });
  const sp = new Panel();
  const sb = sw.body;
  sb.classList.add('col');
  const cell = (): { track: string; step: number; hit: Hit | null } | null => {
    const s = app.ui.sel;
    if (!s || s.t0 !== s.t1 || s.s0 !== s.s1) return null;
    const t = app.project.tracks[s.t0];
    if (!t) return null;
    return { track: t.id, step: s.s0, hit: app.hitAt(t.id, s.s0) };
  };
  const where = h('div', 'lbl', sb);
  const one = h('div', 'col', sb);
  const hitCtl = (label: string, title: string, get: (hh: Hit) => number, set: (v: number) => Partial<Hit>, min: number, max: number, fmt?: (v: number) => string, bip = false) => {
    const c = ctl(one, label, title);
    range(sp, c.slot, {
      get: () => {
        const x = cell()?.hit;
        return x ? get(x) : min;
      },
      set: (v) => {
        const x = cell();
        if (x?.hit) app.setHitProps(x.track, x.step, set(v), label);
      },
      min,
      max,
      format: fmt,
      bip,
      begin: () => app.beginDrag(label),
      end: () => app.endDrag(),
    });
  };
  hitCtl('VELOCITY', 'How hard (1-127)', (x) => x.vel, (v) => ({ vel: v }), 1, 127);
  hitCtl('CHANCE', 'Probability this hit plays each time round', (x) => x.prob ?? 100, (v) => ({ prob: v }), 0, 100, (v) => v + '%');
  hitCtl('PITCH', 'Pitch offset in semitones', (x) => x.note ?? 0, (v) => ({ note: v }), -24, 24, (v) => (v > 0 ? '+' : '') + v, true);
  hitCtl('RATCHET', 'Play the step 1-4 times', (x) => x.ratchet ?? 1, (v) => ({ ratchet: v }), 1, 4, (v) => '×' + v);
  const fr = h('div', 'row', one);
  button(sp, fr, 'FLAM', () => {
    const x = cell();
    if (x?.hit) app.setHitProps(x.track, x.step, { flam: !x.hit.flam }, 'FLAM');
  }, { on: () => !!cell()?.hit?.flam, title: 'A soft grace note just before' });
  const smp = h('div', 'msel-holder', fr);
  select(sp, smp, {
    options: () => {
      const x = cell();
      const t = x && app.project.tracks.find((tt) => tt.id === x.track);
      const list = [{ value: '', label: 'TRACK PICK' }];
      for (const id of t?.sound.samples ?? []) list.push({ value: id, label: app.library.get(id)?.name ?? 'MISSING' });
      return list;
    },
    get: () => cell()?.hit?.sample ?? '',
    set: (v) => {
      const x = cell();
      if (x?.hit) app.setHitProps(x.track, x.step, { sample: v || undefined }, 'HIT SAMPLE');
    },
    width: 120,
    title: 'The sample this hit plays (tracks with several samples)',
  });
  const add = button(sp, one, 'ADD HIT HERE', () => {
    const x = cell();
    if (x && !x.hit) app.toggleCell(x.track, x.step);
  }, { title: 'This step is empty: add a hit' });
  sp.add(() => {
    const x = cell();
    const s = app.ui.sel;
    one.style.display = x ? '' : 'none';
    add.style.display = x && !x.hit ? '' : 'none';
    if (x) {
      const t = app.project.tracks.find((tt) => tt.id === x.track)!;
      where.textContent = `${t.name} · STEP ${x.step + 1}${x.hit ? '' : ' (EMPTY)'}`;
    } else if (s) where.textContent = `SELECTION ${Math.abs(s.t1 - s.t0) + 1} TRACKS × ${Math.abs(s.s1 - s.s0) + 1} STEPS`;
    else where.textContent = `${app.track.name}: RIGHT-CLICK A CELL TO EDIT IT`;
    for (const r of one.querySelectorAll<HTMLElement>('.range')) r.style.opacity = x?.hit ? '' : '0.3';
  });
  const eg = group(sb, 'EDIT · SELECTION OR TRACK');
  const e1 = h('div', 'row', eg);
  button(sp, e1, 'VEL −', () => app.editSelection((x) => ({ ...x, vel: Math.max(1, Math.round(x.vel * 0.85)) }), 'SOFTER'), { cls: 'grow', title: 'Softer' });
  button(sp, e1, 'VEL +', () => app.editSelection((x) => ({ ...x, vel: Math.min(127, Math.round(x.vel * 1.15 + 1)) }), 'LOUDER'), { cls: 'grow', title: 'Louder' });
  button(sp, e1, 'CHANCE 50', () => app.editSelection((x) => ({ ...x, prob: 50 }), 'CHANCE'), { cls: 'grow', title: 'Every hit 50% probability' });
  button(sp, e1, '100', () => app.editSelection((x) => ({ ...x, prob: 100 }), 'CHANCE'), { title: 'Every hit always plays' });
  const e2 = h('div', 'row', eg);
  button(sp, e2, 'COPY', () => app.copy(), { cls: 'grow', title: 'Copy the selection (or the whole pattern) ⌘C' });
  button(sp, e2, 'PASTE', () => app.paste(), { cls: 'grow', disabled: () => !app.clip, title: 'Paste at the selection (or the start) ⌘V' });
  button(sp, e2, 'CLEAR', () => (app.ui.sel ? app.clearSelection() : app.clearTrack(app.ui.track)), { cls: 'grow', title: 'Clear the selection (or the selected track) DEL' });
  const e3 = h('div', 'row', eg);
  button(sp, e3, '◀ SHIFT', () => app.shiftTrack(app.ui.track, -1), { cls: 'grow', title: 'Shift the selected track one step earlier [' });
  button(sp, e3, 'SHIFT ▶', () => app.shiftTrack(app.ui.track, 1), { cls: 'grow', title: 'Shift the selected track one step later ]' });
  button(sp, e3, 'NONE', () => app.select(null), { cls: 'grow', title: 'Clear the selection (ESC)' });
  const legend = group(sb, 'GRID KEY');
  legend.innerHTML += `<div class="tiny" style="white-space:normal;line-height:9px">BLOCK HEIGHT = VELOCITY · HATCHED = CHANCE &lt; 100% · CORNER NOTCH = HAND EDIT · × = DELETED GENERATED HIT · RED DOTS = SUPPRESSED THIS CYCLE · CENTRE DOT = ADDED (FILL, ROLL, CHOP) · TOP ZIGZAG = DESTROYED · ^ = EVOLVED</div>`;
  subscribe(app, ['selection', 'pattern', 'tracks'], () => sp.refresh());

  // ---------------------------------------------------------------- DESTRUCTION
  const dw = win(root, { x: 266, y: 562, w: 640, h: 230, title: 'DESTRUCTION', area: 'destruction', id: 'destruction' });
  const dp = new Panel();
  const db = dw.body;
  db.classList.add('row');
  db.style.alignItems = 'stretch';
  db.style.gap = '6px';
  const d = () => app.project.destruction;
  const dset = (label: string, f: (x: ReturnType<typeof d>) => void) => app.setDestruction(f, label);
  const dpct = (parent: HTMLElement, label: string, get: () => number, set: (v: number) => void, title: string) => pctRange(dp, parent, app, label, get, set, title);
  const col = (title: string, on: () => boolean, toggle: () => void, again: () => void, againLabel: string, key: string) => {
    const g = group(db, title, 'grow');
    g.classList.add('col');
    const r = h('div', 'row', g);
    button(dp, r, title, toggle, { on, cls: 'grow', title: `${title} on/off (${key})` }).dataset.test = 'd-' + title.toLowerCase();
    button(dp, r, againLabel, again, { title: `Draw ${title} again (a new take)` });
    return g;
  };
  const cg = col('CHOP', () => d().chop.on, () => app.toggleChop(), () => app.rechop(), 'RE-CHOP', 'C');
  dpct(cg, 'AMOUNT', () => d().chop.amount, (v) => dset('CHOP AMOUNT', (x) => (x.chop.amount = v)), 'How many slices are rearranged');
  const sl = ctl(cg, 'SLICE', 'Slice length in steps');
  num(dp, sl.slot, { get: () => d().chop.slice, set: (v) => dset('CHOP SLICE', (x) => (x.chop.slice = v)), min: 1, max: 16, width: 30 });
  dpct(cg, 'RETRIG', () => d().chop.retrigger, (v) => dset('CHOP RETRIGGER', (x) => (x.chop.retrigger = v)), 'Share of edits that are retriggers');
  const cRep = h('div', 'report', cg);
  const rg = col('ROLLS', () => d().rolls.on, () => app.toggleRolls(), () => app.reroll(), 'RE-ROLL', 'L');
  dpct(rg, 'CHANCE', () => d().rolls.prob, (v) => dset('ROLL CHANCE', (x) => (x.rolls.prob = v)), 'Chance each candidate hit gets a roll (two a bar at most)');
  const rl = ctl(rg, 'STROKES', 'Strokes in a roll');
  num(dp, rl.slot, { get: () => d().rolls.length, set: (v) => dset('ROLL LENGTH', (x) => (x.rolls.length = v)), min: 2, max: 16, width: 30 });
  const rs = ctl(rg, 'SPEED');
  select(dp, rs.slot, { options: () => ROLL_SPEEDS.map((v) => ({ value: v, label: '1/' + v })), get: () => d().rolls.speed, set: (v) => dset('ROLL SPEED', (x) => (x.rolls.speed = v)), width: 60 });
  const rsh = ctl(rg, 'SHAPE');
  select(dp, rsh.slot, { options: () => (['even', 'crescendo', 'decrescendo', 'human'] as const).map((v) => ({ value: v, label: v.toUpperCase() })), get: () => d().rolls.shape, set: (v) => dset('ROLL SHAPE', (x) => (x.rolls.shape = v)), width: 90 });
  const rp = ctl(rg, 'WHERE');
  select(dp, rp.slot, { options: () => (['phrase', 'accent', 'anywhere'] as const).map((v) => ({ value: v, label: v.toUpperCase() })), get: () => d().rolls.place, set: (v) => dset('ROLL PLACE', (x) => (x.rolls.place = v)), width: 90, title: 'Phrase ends, accents, or any hit' });
  const tg = h('div', 'row', rg);
  tg.style.flexWrap = 'wrap';
  tg.style.gap = '1px';
  for (const role of ROLES) {
    button(dp, tg, ROLE_LABEL[role].replace(' ', ''), () => dset('ROLL TARGETS', (x) => (x.rolls.targets = x.rolls.targets.includes(role) ? x.rolls.targets.filter((r) => r !== role) : [...x.rolls.targets, role as Role])), { cls: 'small', on: () => d().rolls.targets.includes(role), title: `Rolls on ${ROLE_LABEL[role]}` });
  }
  const rRep = h('div', 'report', rg);
  const xg = col('DESTROY', () => d().destroy.on, () => app.toggleDestroy(), () => app.redestroy(), 'RE-DO', 'D');
  dpct(xg, 'AMOUNT', () => d().destroy.amount, (v) => dset('DESTROY AMOUNT', (x) => (x.destroy.amount = v)), 'Scales every effect');
  for (const [k, label, title] of [
    ['stutter', 'STUTTER', 'Hits repeated 2-4 times at 1/32 or 1/64'],
    ['pitch', 'PITCH', 'Hits transposed (up to an octave)'],
    ['reverse', 'REVERSE', 'Sample layer played backwards'],
    ['gate', 'GATE', 'Sounds cut short'],
    ['crush', 'CRUSH', "The LXR's sample-rate reduction locked on the hit"],
    ['skip', 'SKIP', 'Hits dropped'],
  ] as const) {
    dpct(xg, label, () => d().destroy[k], (v) => dset('DESTROY ' + label, (x) => (x.destroy[k] = v)), title);
  }
  const xRep = h('div', 'report', xg);
  const wc = h('div', 'col', db);
  wc.style.width = '80px';
  const wb = button(dp, wc, 'WILDCARD', () => void app.wildcard(), { cls: 'big grow', title: 'One bounded, seeded re-imagining of style, density, transformations, swing and (sometimes) the kit. One undo step. (W)' });
  wb.dataset.test = 'wildcard';
  wb.style.whiteSpace = 'normal';
  const wrep = h('div', 'tiny', wc, 'UNDO TAKES IT BACK');
  wrep.style.whiteSpace = 'normal';
  const reports = () => {
    const r = app.destructionReport();
    cRep.textContent = r.chop;
    rRep.textContent = r.rolls;
    xRep.textContent = r.destroy;
    cRep.title = r.chop;
    rRep.title = r.rolls;
    xRep.title = r.destroy;
  };
  dp.add(reports);
  subscribe(app, ['destruction', 'pattern', 'transport'], () => dp.refresh());

  // ---------------------------------------------------------------- TRACK
  const tw = win(root, { x: 914, y: 562, w: 358, h: 230, title: 'TRACK', area: 'rhythm', id: 'track' });
  const tp = new Panel();
  const tb = tw.body;
  tb.classList.add('col');
  const t = () => app.track;
  const tr = h('div', 'row', tb);
  select(tp, tr, { options: () => app.project.tracks.map((x) => ({ value: x.id, label: x.name })), get: () => app.ui.track, set: (v) => app.selectTrack(v), width: 90, title: 'The selected track (↑ ↓)' });
  select(tp, tr, { options: () => ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r] })), get: () => t().role, set: () => undefined, width: 70, title: 'Role (what the generator writes for this track)' }).style.pointerEvents = 'none';
  button(tp, tr, 'M', () => app.setTrackMix(t().id, { mute: !t().mix.mute }), { cls: 'small', on: () => t().mix.mute, title: 'Mute' });
  button(tp, tr, 'S', () => app.setTrackMix(t().id, { solo: !t().mix.solo }), { cls: 'small', on: () => t().mix.solo, title: 'Solo' });
  button(tp, tr, 'LOCK', () => app.lockTrack(t().id), { cls: 'small', on: () => t().lock, title: 'Generation and mutation leave this track alone' });
  button(tp, tr, '▶', () => void app.audition(t().id), { cls: 'small', title: 'Hear it' });
  const play = (label: string, k: 'density' | 'fill' | 'humanize' | 'chance', title: string) => {
    const c = ctl(tb, label, title);
    range(tp, c.slot, { get: () => t().play[k], set: (v) => app.setTrackPlay(t().id, { [k]: v }, label), min: 0, max: 100, format: (v) => v + '%', def: k === 'density' || k === 'chance' ? 100 : 0, begin: () => app.beginDrag(label), end: () => app.endDrag(), title });
  };
  play('DENSITY', 'density', 'Weak hits drop out first as this goes down');
  play('FILL', 'fill', 'Generated hits in the gaps (seeded, different every cycle)');
  play('HUMANIZE', 'humanize', 'Timing and velocity looseness');
  play('CHANCE', 'chance', "Scales every hit's probability");
  const lr = ctl(tb, 'LENGTH', 'Loop length of this track in steps (OFF = the pattern length): polymeter');
  num(tp, lr.slot, { get: () => t().play.length, set: (v) => app.setTrackPlay(t().id, { length: v }, 'TRACK LENGTH'), min: 0, max: 64, width: 32, format: (v) => (v ? String(v) : 'OFF') });
  const mr = h('div', 'row', tb);
  h('div', 'lbl', mr, 'MIDI CH');
  num(tp, mr, { get: () => t().midi.channel, set: (v) => app.setTrackMidi(t().id, { channel: v }), min: 1, max: 16, width: 26 });
  h('div', 'lbl', mr, 'NOTE');
  num(tp, mr, { get: () => t().midi.note, set: (v) => app.setTrackMidi(t().id, { note: v }), min: 0, max: 127, width: 30 });
  button(tp, mr, 'FILL', null, { cls: 'small', hold: (dn) => app.fill(dn, [t().id]), on: () => app.ui.fills.has(t().id), title: 'Hold: fill this track' });
  tp.add(() => (tw.info.textContent = `${t().sound.mode.toUpperCase()} · ${t().lock ? 'LOCKED' : 'UNLOCKED'}`));
  subscribe(app, ['tracks', 'selection', 'mix', 'midi', 'project'], () => tp.refresh());

  const all = [gp, pp, sp, dp, tp];
  let lastCycle = -1;
  return {
    root,
    frame: () => {
      const pos = app.playhead();
      // each cycle realises differently (probability, fills, transformations): redraw its marks
      if (pos && pos.cycle !== lastCycle) {
        lastCycle = pos.cycle;
        grid.draw();
        dp.refresh();
      }
      grid.drawOverlay(pos && pos.pattern === app.pattern.id ? pos.step : -1);
    },
    show: (on) => {
      root.classList.toggle('hidden', !on);
      if (on) {
        grid.draw();
        for (const p of all) p.refresh();
      }
    },
  };
}
