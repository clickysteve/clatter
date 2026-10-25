/**
 * PATTERN: a single-window instrument. The pattern grid (the sequencer) is always on screen;
 * under it a tabbed workspace holds the controls for what you are doing:
 *
 *   SEQUENCE   the step being edited, and the selection tools (copy, paste, clear, shift)
 *   GENERATE   style and the generator, accent and fills, evolution
 *   TRANSFORM  CHOP, ROLLS, DESTROY and WILDCARD
 *   TRACK      the selected track: source, mute and solo, performance, loop length and MIDI
 *   STEP SOUND the sound of the selected step: variation, voice, locks, conditions, generators
 *
 * The page does not scroll: the grid takes the height that is left above the workspace (its rows
 * shrink to fit, then it scrolls inside its frame) and a workspace tab whose controls need more
 * room scrolls inside its own panel. Keys that act on the pattern (G, V, M, R, C, L, D, W) open
 * the tab they belong to.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import type { App, Topic } from '../../app/app';
import { WORKSPACES, type Workspace } from '../../app/prefs';
import { RESOLUTION_LABEL, RESOLUTIONS, ROLE_LABEL, ROLES, ROLL_SPEEDS, type Resolution, type Role, type SourceMode } from '../../model/types';
import { STYLES, styleById } from '../../rhythm/styles';
import { gridKeyDialog } from '../dialogs';
import { PatternGrid, type Cell } from '../grid';
import { summaryLine } from '../gridModel';
import { openPopover } from '../popover';
import { onScale, sz } from '../scale';
import { button, ctl, group, h, num, Panel, range, select, win } from '../widgets';
import { stepEditor } from './stepEditor';
import { stepSoundEditor } from './stepSoundEditor';

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

/** The workspace under the grid: a share of the window's height, within these limits (unscaled pixels). */
const WORKSPACE = { min: 168, max: 300, share: 0.28 };

const WS_LABEL: Record<Workspace, string> = { sequence: 'SEQUENCE', generate: 'GENERATE', transform: 'TRANSFORM', track: 'TRACK', sound: 'STEP SOUND' };
const WS_TITLE: Record<Workspace, string> = {
  sequence: 'The step being edited, and the tools for the selection',
  generate: 'Generate, vary and mutate the pattern',
  transform: 'CHOP, ROLLS, DESTROY and WILDCARD',
  track: 'The selected track: source, performance, loop length, MIDI',
  sound: 'The sound of the selected step: variation, voice, locks, conditions',
};

export function patternView(app: App, screen: HTMLElement): View {
  const root = h('div', 'view pattern-view', screen);
  root.dataset.view = 'pattern';

  // ================================================================ the sequencer (always on screen)
  const pw = win(root, { title: 'PATTERN', area: 'rhythm', id: 'pattern', cls: 'sequencer' });
  const pp = new Panel();
  const pb = pw.body;
  pb.classList.add('col');

  const tb = h('div', 'row wrap toolbar', pb);
  h('div', 'lbl', tb, 'STEPS');
  num(pp, tb, { get: () => app.pattern.steps, set: (v) => app.setLength(v), min: 1, max: 64, title: 'Pattern length in steps' }).dataset.test = 'length';
  h('div', 'lbl', tb, 'GRID');
  select(pp, tb, { options: () => RESOLUTIONS.map((r) => ({ value: r, label: RESOLUTION_LABEL[r] })), get: () => app.pattern.res, set: (r: Resolution) => app.setResolution(r), title: 'Step resolution: the note length of one step' });
  h('div', 'lbl', tb, 'NEW HIT VELOCITY');
  num(pp, tb, { get: () => app.ui.paintVel, set: (v) => ((app.ui.paintVel = v), pp.refresh(), grid.redrawOverlay()), min: 1, max: 127, title: 'Velocity of the hits you add by clicking' });
  h('div', 'grow', tb);
  button(pp, tb, 'SOURCE', null, { on: () => app.ui.sourceOnly, hold: (d) => app.setSourceOnly(d), title: 'Hold: hear and see only the written pattern (no density, fills, CHOP, ROLLS, DESTROY)' });
  button(pp, tb, 'SHOW ORIGINAL', () => app.setShowOriginal(!app.ui.showOriginal), { on: () => app.ui.showOriginal, title: 'Also show the edit history: hand-edited hits (corner flag) and generated hits you deleted (crossed outline). Off: the grid shows only what plays.' }).dataset.test = 'show-original';
  button(pp, tb, 'KEEP EDITS', () => app.keepEdits(), { disabled: () => app.editCount() === 0, title: 'Bake the hand edits into the pattern (generation and mutation then work on them)' });
  button(pp, tb, 'RESET', () => app.reset(), { title: 'Back to the generated pattern: hand edits cleared, CHOP/ROLLS/DESTROY off' });
  button(pp, tb, '? KEY', () => gridKeyDialog(), { title: 'How to read the grid, and how to edit it' }).dataset.test = 'grid-key';

  // the grid takes the height that is left above the workspace
  const gridhost = h('div', 'gridhost', pb);
  const wsHeight = () => Math.max(sz(WORKSPACE.min), Math.min(sz(WORKSPACE.max), Math.round(window.innerHeight * WORKSPACE.share)));
  let gridEl: HTMLElement | null = null; // set once the grid exists (it asks for its room while it is built)
  const room = () => {
    if (!gridEl || !root.clientHeight) return 0;
    const gap = parseFloat(getComputedStyle(root).rowGap) || 0;
    return root.clientHeight - wsHeight() - gap - (pw.el.offsetHeight - gridEl.offsetHeight);
  };
  const grid = new PatternGrid(app, gridhost, { fit: { watch: root, room } });
  gridEl = grid.el;
  const foot = h('div', 'gridfoot', pb);
  const where = h('div', 'tiny where grow', foot);
  where.style.color = 'var(--ink)';
  const gestures = h('div', 'hint', foot, 'CLICK: ADD / REMOVE · DRAG: PAINT · SHIFT-DRAG: SELECT · ALT-DRAG: VELOCITY · RIGHT-CLICK: EDIT THE STEP');
  gestures.style.flex = '0 1 auto';
  let hovered: Cell | null = null;
  const showWhere = () => {
    const c = hovered ?? (() => {
      const cur = app.cursorCell();
      return cur ? { track: app.trackIndexOf(cur.track), step: cur.step } : null;
    })();
    const v = c ? grid.view(c) : null;
    const t = c ? app.project.tracks[c.track] : null;
    where.textContent = c && v && t ? summaryLine(t.name, c.step, v, { steps: app.pattern.steps, perBeat: app.pattern.res, perBar: app.pattern.res * 4, beatsPerBar: 4 }) : 'POINT AT A STEP';
  };
  grid.onHover = (c) => {
    hovered = c;
    showWhere();
  };

  // ================================================================ the workspace (tabs)
  const ws = h('div', 'workspace', root);
  const wsbar = h('div', 'wsbar', ws);
  wsbar.setAttribute('role', 'tablist');
  const wsinfo = h('div', 'wsinfo', wsbar);
  const wspanes = h('div', 'wspanes', ws);
  const sizeWorkspace = () => (ws.style.flexBasis = wsHeight() + 'px');
  sizeWorkspace();
  window.addEventListener('resize', sizeWorkspace);
  onScale(sizeWorkspace);
  const wp = new Panel();
  const tabEls = {} as Record<Workspace, HTMLElement>;
  const panes = {} as Record<Workspace, HTMLElement>;
  const infos = {} as Record<Workspace, () => string>;
  for (const [i, id] of WORKSPACES.entries()) {
    const t = h('div', 'wstab', wsbar, WS_LABEL[id]);
    t.setAttribute('role', 'tab');
    t.tabIndex = 0;
    t.title = WS_TITLE[id];
    t.dataset.test = 'ws-' + id;
    t.addEventListener('click', () => app.setWorkspace(id));
    t.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        app.setWorkspace(id);
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        const to = WORKSPACES[(i + (e.key === 'ArrowRight' ? 1 : WORKSPACES.length - 1)) % WORKSPACES.length]!;
        app.setWorkspace(to);
        tabEls[to].focus();
      }
    });
    tabEls[id] = t;
    const pane = h('div', 'wspane wspane-' + id, wspanes);
    pane.setAttribute('role', 'tabpanel');
    pane.dataset.test = 'pane-' + id;
    panes[id] = pane;
  }
  wsbar.insertBefore(wsinfo, null); // the context line stays at the right of the tabs
  wp.add(() => {
    for (const id of WORKSPACES) {
      const on = app.ui.workspace === id;
      tabEls[id].classList.toggle('on', on);
      tabEls[id].setAttribute('aria-selected', String(on));
      panes[id].classList.toggle('show', on);
    }
    wsinfo.textContent = infos[app.ui.workspace]?.() ?? '';
  });
  const card = (pane: HTMLElement, cls = ''): HTMLDivElement => h('div', 'wscard col ' + cls, pane);
  app.on('workspace', () => wp.refresh());

  // ---------------------------------------------------------------- SEQUENCE
  const sq = panes.sequence;
  const ss = card(sq, 'stepcard');
  const sp = new Panel();
  stepEditor(app, ss, sp);
  let pop: Panel | null = null;
  grid.onContext = (cell, e) => {
    const t = app.project.tracks[cell.track]!;
    openPopover(e.clientX, e.clientY, `EDIT STEP ${cell.step + 1} · ${t.name}`, (body) => {
      pop = new Panel();
      stepEditor(app, body, pop);
    });
  };
  const eb = card(sq, 'editcard');
  const ep = new Panel();
  const ehint = h('div', 'hint', eb);
  ep.add(() => {
    const s = app.ui.sel;
    ehint.textContent = s && !(s.t0 === s.t1 && s.s0 === s.s1) ? `ACTS ON THE SELECTED REGION: ${Math.abs(s.t1 - s.t0) + 1} TRACKS × ${Math.abs(s.s1 - s.s0) + 1} STEPS` : s ? 'ACTS ON THE SELECTED STEP' : `NOTHING SELECTED: ACTS ON THE WHOLE ${app.track.name} TRACK (SHIFT-DRAG IN THE GRID TO SELECT A REGION)`;
  });
  const e1 = h('div', 'row wrap', eb);
  button(ep, e1, 'VEL −', () => app.editSelection((x) => ({ ...x, vel: Math.max(1, Math.round(x.vel * 0.85)) }), 'SOFTER'), { cls: 'grow', title: 'Softer' });
  button(ep, e1, 'VEL +', () => app.editSelection((x) => ({ ...x, vel: Math.min(127, Math.round(x.vel * 1.15 + 1)) }), 'LOUDER'), { cls: 'grow', title: 'Louder' });
  button(ep, e1, 'CHANCE 50', () => app.editSelection((x) => ({ ...x, prob: 50 }), 'CHANCE'), { cls: 'grow', title: 'Every hit 50% probability' });
  button(ep, e1, 'CHANCE 100', () => app.editSelection((x) => ({ ...x, prob: 100 }), 'CHANCE'), { cls: 'grow', title: 'Every hit always plays' });
  const e2 = h('div', 'row wrap', eb);
  button(ep, e2, 'COPY', () => app.copy(), { cls: 'grow', title: 'Copy the selection (or the whole pattern) ⌘C' });
  button(ep, e2, 'PASTE', () => app.paste(), { cls: 'grow', disabled: () => !app.clip, title: 'Paste at the selection (or the start) ⌘V' });
  button(ep, e2, 'CLEAR', () => (app.ui.sel ? app.clearSelection() : app.clearTrack(app.ui.track)), { cls: 'grow', title: 'Clear the selection (or the selected track) DEL' });
  button(ep, e2, 'NONE', () => app.select(null), { cls: 'grow', title: 'Clear the selection (ESC)' });
  const e3 = h('div', 'row wrap', eb);
  button(ep, e3, '◀ SHIFT', () => app.shiftTrack(app.ui.track, -1), { cls: 'grow', title: 'Shift the selected track one step earlier [' });
  button(ep, e3, 'SHIFT ▶', () => app.shiftTrack(app.ui.track, 1), { cls: 'grow', title: 'Shift the selected track one step later ]' });
  infos.sequence = () => {
    const c = app.cursorCell();
    const t = c ? app.project.tracks.find((x) => x.id === c.track) : null;
    return t && c ? `${t.name} · STEP ${c.step + 1}` : 'NO STEP SELECTED';
  };
  subscribe(app, ['selection', 'pattern', 'tracks'], () => {
    ep.refresh();
    wp.refresh();
  });

  pp.add(() => {
    const p = app.pattern;
    pw.setTitle(`PATTERN ${p.name}`);
    pw.info.textContent = `${p.steps} STEPS · ${RESOLUTION_LABEL[p.res]} · ${app.editCount()} HAND EDITS`;
  });
  subscribe(app, ['pattern', 'destruction'], () => {
    grid.draw();
    pp.refresh();
    sp.refresh();
    pop?.refresh();
    showWhere();
  });
  subscribe(app, ['tracks', 'mix', 'project'], () => {
    grid.build();
    pp.refresh();
    sp.refresh();
    showWhere();
  });
  app.on('selection', () => {
    grid.refreshRows();
    grid.redrawOverlay();
    sp.refresh();
    pop?.refresh();
    showWhere();
  });
  window.addEventListener('clatter-palette', () => grid.draw());

  // ---------------------------------------------------------------- STEP SOUND
  const np = new Panel();
  stepSoundEditor(app, panes.sound, np);
  infos.sound = () => {
    const c = app.cursorCell();
    const t = c ? app.project.tracks.find((x) => x.id === c.track) : null;
    if (!t || !c) return 'NO STEP SELECTED';
    const d = app.describeStepSound(c.track, c.step);
    return `${t.name} · STEP ${c.step + 1} · ${d || 'PLAYS THE TRACK’S SOUND'}`;
  };
  subscribe(app, ['selection', 'pattern', 'tracks', 'kit', 'project', 'gen'], () => {
    np.refresh();
    wp.refresh();
  });

  // ---------------------------------------------------------------- GENERATE
  const gp = new Panel();
  const gpane = panes.generate;
  const gb = card(gpane);
  const sr = ctl(gb, 'STYLE', 'The rhythmic language the generator speaks');
  select(gp, sr.slot, { options: () => STYLES.map((s) => ({ value: s.id, label: s.label })), get: () => app.project.gen.style, set: (v) => app.setGen({ style: v }, 'STYLE'), title: 'Style' }).dataset.test = 'style';
  (sr.slot.firstElementChild as HTMLElement).classList.add('fluid');
  sr.slot.style.display = 'flex';
  const desc = h('div', 'hint desc', gb);
  gp.add(() => (desc.textContent = styleById(app.project.gen.style).description));
  const r1 = h('div', 'row', gb);
  const gen = button(gp, r1, 'GENERATE', () => app.generatePattern(), { cls: 'med grow', title: 'A new pattern in this style (G). Locked tracks and hand edits stay.' });
  gen.dataset.test = 'generate';
  gen.style.flex = '1.4';
  button(gp, r1, 'VARIATION', () => app.variation(), { cls: 'med grow', title: 'A related pattern (V)' });
  button(gp, r1, 'MUTATE', () => app.mutate(), { cls: 'med grow', title: 'Small controlled changes (M)' });
  const rb = h('div', 'row', gb);
  h('div', 'lbl', rb, 'BARS').title = 'Length of a generated pattern';
  num(gp, rb, { get: () => app.project.gen.bars, set: (v) => app.setGen({ bars: v }, 'BARS'), min: 1, max: 4, title: 'Length of a generated pattern' });
  button(gp, rb, 'REGENERATE AFTER BAR 1', () => app.regenerate(), { cls: 'grow', title: 'New material after bar 1 (R)' });
  const ginfo = h('div', 'report', gb);
  gp.add(() => (ginfo.textContent = `SEED ${app.pattern.seed} · GENERATION ${app.pattern.generation} · ${app.editCount()} HAND EDITS`));
  const gc = card(gpane);
  pctRange(gp, gc, app, 'DENSITY', () => app.project.gen.density, (v) => app.setGen({ density: v }, 'DENSITY'), 'How many hits');
  pctRange(gp, gc, app, 'COMPLEXITY', () => app.project.gen.complexity, (v) => app.setGen({ complexity: v }, 'COMPLEXITY'), 'Syncopation, off-grid emphasis, ghost notes');
  pctRange(gp, gc, app, 'VARIATION', () => app.project.gen.variation, (v) => app.setGen({ variation: v }, 'VARIATION'), 'How much the bars differ from each other');
  pctRange(gp, gc, app, 'ACCENT', () => app.project.gen.accent, (v) => app.setGen({ accent: v }, 'ACCENT'), 'Velocity contrast between strong and weak hits');
  pctRange(gp, gc, app, 'FILLS', () => app.project.gen.fills, (v) => app.setGen({ fills: v }, 'FILLS'), 'Fills into the end of the phrase');
  const evo = group(card(gpane), 'EVOLVE');
  evo.classList.add('col');
  const et = ctl(evo, 'TARGET', 'What changes on its own while playing: the rhythm mutates, the kit drifts, or both');
  select(gp, et.slot, {
    options: () => (['off', 'rhythm', 'sound', 'both'] as const).map((v) => ({ value: v, label: v.toUpperCase() })),
    get: () => app.project.evolve.target,
    set: (v) => app.setEvolve({ target: v }),
    title: 'What changes on its own while playing: the rhythm mutates, the kit drifts, or both',
  }).dataset.test = 'evolve';
  const ee = ctl(evo, 'EVERY', 'Every n bars');
  num(gp, ee.slot, { get: () => app.project.evolve.every, set: (v) => app.setEvolve({ every: v }), min: 1, max: 32, title: 'Every n bars' });
  pctRange(gp, evo, app, 'AMOUNT', () => app.project.evolve.amount, (v) => app.setEvolve({ amount: v }), 'How far each step goes');
  const er = ctl(evo, 'RETURN', 'Rhythm: back to the written pattern after this many generations (0 never)');
  const erow = h('div', 'row', er.slot);
  num(gp, erow, { get: () => app.project.evolve.returnEvery, set: (v) => app.setEvolve({ returnEvery: v }), min: 0, max: 32, format: (v) => (v ? String(v) : 'OFF'), title: 'Rhythm: back to the written pattern after this many generations (0 never)' });
  button(gp, erow, 'KIT HOME', () => app.evolveReturn(), { title: 'Sound: back to the kit the evolution started from' });
  infos.generate = () => `${styleById(app.project.gen.style).label} · ${Math.round(app.project.gen.density * 100)}% DENSITY`;
  subscribe(app, ['gen', 'pattern', 'transport'], () => {
    gp.refresh();
    wp.refresh();
  });

  // ---------------------------------------------------------------- TRANSFORM
  const dp = new Panel();
  const xpane = panes.transform;
  const d = () => app.project.destruction;
  const dset = (label: string, f: (x: ReturnType<typeof d>) => void) => app.setDestruction(f, label);
  const dpct = (parent: HTMLElement, label: string, get: () => number, set: (v: number) => void, title: string) => pctRange(dp, parent, app, label, get, set, title);
  type XKey = 'chop' | 'rolls' | 'destroy';
  let active: XKey = 'chop';
  const tabs = h('div', 'xtabs', xpane);
  const xbody = h('div', 'xbody', xpane);
  const panels = {} as Record<XKey, HTMLDivElement>;
  const xtabEls = {} as Record<XKey, HTMLDivElement>;
  const sub = {} as Record<XKey, HTMLDivElement>;
  const select_ = (k: XKey) => {
    active = k;
    for (const key of Object.keys(panels) as XKey[]) {
      panels[key].classList.toggle('show', key === k);
      xtabEls[key].classList.toggle('active', key === k);
    }
  };
  const tab = (k: XKey, label: string, key: string, toggle: () => void) => {
    const t = h('div', 'xtab', tabs);
    xtabEls[k] = t;
    const on = h('div', 'xon', t);
    on.title = `${label} on/off (${key})`;
    on.setAttribute('role', 'checkbox');
    on.tabIndex = 0;
    on.dataset.test = 'd-' + k;
    on.addEventListener('click', toggle);
    on.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        toggle();
      }
    });
    const name = h('div', 'xname', t, label);
    name.title = `Show the ${label} settings`;
    name.addEventListener('click', () => select_(k));
    sub[k] = h('div', 'tiny', name);
    dp.add(() => {
      t.classList.toggle('on', d()[k].on);
      on.setAttribute('aria-checked', String(d()[k].on));
    });
    return t;
  };
  tab('chop', 'CHOP', 'C', () => app.toggleChop());
  tab('rolls', 'ROLLS', 'L', () => app.toggleRolls());
  tab('destroy', 'DESTROY', 'D', () => app.toggleDestroy());
  const wb = button(dp, tabs, 'WILDCARD', () => void app.wildcard(), { cls: 'med', title: 'One bounded, seeded re-imagining of style, density, transformations, swing and (sometimes) the kit. One undo step (W). Undo takes it back.' });
  wb.dataset.test = 'wildcard';
  const panelFor = (k: XKey, title: string, key: string, toggle: () => void, again: () => void, againLabel: string) => {
    const p = h('div', 'xpanel', xbody);
    panels[k] = p;
    const head = h('div', 'row wrap', p);
    button(dp, head, title, toggle, { on: () => d()[k].on, label: () => `${title} ${d()[k].on ? 'ON' : 'OFF'}`, title: `${title} on/off (${key})` });
    button(dp, head, againLabel, again, { title: `Draw ${title} again (a new take)` });
    return p;
  };
  // CHOP
  const cg = panelFor('chop', 'CHOP', 'C', () => app.toggleChop(), () => app.rechop(), 'RE-CHOP');
  const cgrid = h('div', 'xgrid', cg);
  dpct(cgrid, 'AMOUNT', () => d().chop.amount, (v) => dset('CHOP AMOUNT', (x) => (x.chop.amount = v)), 'How many slices are rearranged');
  const sl = ctl(cgrid, 'SLICE', 'Slice length in steps');
  num(dp, sl.slot, { get: () => d().chop.slice, set: (v) => dset('CHOP SLICE', (x) => (x.chop.slice = v)), min: 1, max: 16, title: 'Slice length in steps' });
  dpct(cgrid, 'RETRIGGER', () => d().chop.retrigger, (v) => dset('CHOP RETRIGGER', (x) => (x.chop.retrigger = v)), 'Share of edits that are retriggers');
  const cRep = h('div', 'report', cg);
  // ROLLS
  const rg = panelFor('rolls', 'ROLLS', 'L', () => app.toggleRolls(), () => app.reroll(), 'RE-ROLL');
  const rgrid = h('div', 'xgrid', rg);
  dpct(rgrid, 'CHANCE', () => d().rolls.prob, (v) => dset('ROLL CHANCE', (x) => (x.rolls.prob = v)), 'Chance each candidate hit gets a roll (two a bar at most)');
  const rl = ctl(rgrid, 'STROKES', 'Strokes in a roll');
  num(dp, rl.slot, { get: () => d().rolls.length, set: (v) => dset('ROLL LENGTH', (x) => (x.rolls.length = v)), min: 2, max: 16, title: 'Strokes in a roll' });
  const rs = ctl(rgrid, 'SPEED', 'Note length of a stroke');
  select(dp, rs.slot, { options: () => ROLL_SPEEDS.map((v) => ({ value: v, label: '1/' + v })), get: () => d().rolls.speed, set: (v) => dset('ROLL SPEED', (x) => (x.rolls.speed = v)), title: 'Note length of a stroke' });
  const rsh = ctl(rgrid, 'SHAPE', 'How the strokes’ velocities move');
  select(dp, rsh.slot, { options: () => (['even', 'crescendo', 'decrescendo', 'human'] as const).map((v) => ({ value: v, label: v.toUpperCase() })), get: () => d().rolls.shape, set: (v) => dset('ROLL SHAPE', (x) => (x.rolls.shape = v)), title: 'How the strokes’ velocities move' });
  const rp = ctl(rgrid, 'WHERE', 'Phrase ends, accents, or any hit');
  select(dp, rp.slot, { options: () => (['phrase', 'accent', 'anywhere'] as const).map((v) => ({ value: v, label: v.toUpperCase() })), get: () => d().rolls.place, set: (v) => dset('ROLL PLACE', (x) => (x.rolls.place = v)), title: 'Phrase ends, accents, or any hit' });
  const tl = h('div', 'lbl', rg, 'ROLL ON THESE TRACKS');
  void tl;
  const tg = h('div', 'pills', rg);
  for (const role of ROLES) {
    button(dp, tg, ROLE_LABEL[role].replace(' ', ''), () => dset('ROLL TARGETS', (x) => (x.rolls.targets = x.rolls.targets.includes(role) ? x.rolls.targets.filter((r) => r !== role) : [...x.rolls.targets, role as Role])), { cls: 'small', on: () => d().rolls.targets.includes(role), title: `Rolls on ${ROLE_LABEL[role]}` });
  }
  const rRep = h('div', 'report', rg);
  // DESTROY
  const xg = panelFor('destroy', 'DESTROY', 'D', () => app.toggleDestroy(), () => app.redestroy(), 'RE-DO');
  const xgrid = h('div', 'xgrid', xg);
  dpct(xgrid, 'AMOUNT', () => d().destroy.amount, (v) => dset('DESTROY AMOUNT', (x) => (x.destroy.amount = v)), 'Scales every effect');
  for (const [k, label, title] of [
    ['stutter', 'STUTTER', 'Hits repeated 2-4 times at 1/32 or 1/64'],
    ['pitch', 'PITCH', 'Hits transposed (up to an octave)'],
    ['reverse', 'REVERSE', 'Sample layer played backwards'],
    ['gate', 'GATE', 'Sounds cut short'],
    ['crush', 'CRUSH', "The LXR's sample-rate reduction locked on the hit"],
    ['skip', 'SKIP', 'Hits dropped'],
  ] as const) {
    dpct(xgrid, label, () => d().destroy[k], (v) => dset('DESTROY ' + label, (x) => (x.destroy[k] = v)), title);
  }
  const xRep = h('div', 'report', xg);
  select_(active);
  const reports = () => {
    const r = app.destructionReport();
    cRep.textContent = r.chop;
    rRep.textContent = r.rolls;
    xRep.textContent = r.destroy;
    sub.chop.textContent = d().chop.on ? 'ON · ' + Math.round(d().chop.amount * 100) + '%' : 'OFF';
    sub.rolls.textContent = d().rolls.on ? 'ON · ' + Math.round(d().rolls.prob * 100) + '%' : 'OFF';
    sub.destroy.textContent = d().destroy.on ? 'ON · ' + Math.round(d().destroy.amount * 100) + '%' : 'OFF';
  };
  dp.add(reports);
  infos.transform = () => (['chop', 'rolls', 'destroy'] as const).map((k) => `${k.toUpperCase()} ${d()[k].on ? 'ON' : 'OFF'}`).join(' · ');
  subscribe(app, ['destruction', 'pattern', 'transport'], () => {
    dp.refresh();
    wp.refresh();
  });

  // ---------------------------------------------------------------- TRACK
  const tp = new Panel();
  const tpane = panes.track;
  const t = () => app.track;
  const tbd = card(tpane);
  const tr = h('div', 'row', tbd);
  select(tp, tr, { options: () => app.project.tracks.map((x) => ({ value: x.id, label: x.name })), get: () => app.ui.track, set: (v) => app.selectTrack(v), title: 'The selected track (↑ ↓)' }).classList.add('fluid');
  const role = h('div', 'hint', tr);
  tp.add(() => (role.textContent = 'ROLE: ' + ROLE_LABEL[t().role]));
  // the source of the sound, always on show
  const modes: { value: SourceMode; label: string; title: string }[] = [
    { value: 'synth', label: 'SYNTH', title: 'The LXR voice' },
    { value: 'sample', label: 'SAMPLE', title: 'Samples only' },
    { value: 'hybrid', label: 'HYBRID', title: 'The LXR voice and the sample together, aligned' },
  ];
  const seg = h('div', 'seg fluid', tbd);
  for (const m of modes) button(tp, seg, m.label, () => app.setTrackSound(t().id, { mode: m.value }, 'SOURCE'), { on: () => t().sound.mode === m.value, title: m.title + ' (change it here or in SOUND)' }).dataset.test = 'track-mode-' + m.value;
  const tbtn = h('div', 'row wrap', tbd);
  button(tp, tbtn, 'MUTE', () => app.setTrackMix(t().id, { mute: !t().mix.mute }), { on: () => t().mix.mute, title: 'Mute' });
  button(tp, tbtn, 'SOLO', () => app.setTrackMix(t().id, { solo: !t().mix.solo }), { on: () => t().mix.solo, title: 'Solo' });
  button(tp, tbtn, 'LOCK', () => app.lockTrack(t().id), { on: () => t().lock, title: 'Generation and mutation leave this track alone' });
  button(tp, tbtn, '▶ HEAR', () => void app.audition(t().id), { title: 'Hear it' });
  button(tp, tbtn, 'FILL', null, { hold: (dn) => app.fill(dn, [t().id]), on: () => app.ui.fills.has(t().id), title: 'Hold: fill this track' });
  const tpc = card(tpane);
  const pg = group(tpc, 'PERFORMANCE');
  pg.classList.add('col');
  const play = (label: string, k: 'density' | 'fill' | 'humanize' | 'chance', title: string) => {
    const c = ctl(pg, label, title);
    range(tp, c.slot, { get: () => t().play[k], set: (v) => app.setTrackPlay(t().id, { [k]: v }, label), min: 0, max: 100, format: (v) => v + '%', def: k === 'density' || k === 'chance' ? 100 : 0, begin: () => app.beginDrag(label), end: () => app.endDrag(), title });
  };
  play('DENSITY', 'density', 'Weak hits drop out first as this goes down');
  play('FILL', 'fill', 'Generated hits in the gaps (seeded, different every cycle)');
  play('HUMANIZE', 'humanize', 'Timing and velocity looseness');
  play('CHANCE', 'chance', "Scales every hit's probability");
  const tm = group(card(tpane), 'LOOP LENGTH AND MIDI');
  tm.classList.add('col');
  const lr = ctl(tm, 'LENGTH', 'Loop length of this track in steps (OFF = the pattern length): polymeter');
  num(tp, lr.slot, { get: () => t().play.length, set: (v) => app.setTrackPlay(t().id, { length: v }, 'TRACK LENGTH'), min: 0, max: 64, format: (v) => (v ? String(v) : 'OFF'), title: 'Loop length in steps (OFF = the pattern length): polymeter' });
  const mc = ctl(tm, 'MIDI CHANNEL');
  num(tp, mc.slot, { get: () => t().midi.channel, set: (v) => app.setTrackMidi(t().id, { channel: v }), min: 1, max: 16 });
  const mn = ctl(tm, 'MIDI NOTE');
  num(tp, mn.slot, { get: () => t().midi.note, set: (v) => app.setTrackMidi(t().id, { note: v }), min: 0, max: 127 });
  infos.track = () => `${t().name} · ${t().sound.mode.toUpperCase()} · ${t().lock ? 'LOCKED' : 'UNLOCKED'}`;
  subscribe(app, ['tracks', 'selection', 'mix', 'midi', 'project', 'kit', 'library'], () => {
    tp.refresh();
    wp.refresh();
  });

  const all = [gp, pp, sp, dp, tp, ep, wp, np];
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
        grid.build();
        for (const p of all) p.refresh();
        showWhere();
      }
    },
  };
}
