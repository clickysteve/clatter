/**
 * PERFORM: big controls for playing CLATTER live. Every change lands on the next quantise
 * boundary (TRANSPORT · QUANT) while playing; FILL and SOURCE are momentary; snapshots store
 * and recall the whole sound and rhythm state.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import type { App } from '../../app/app';
import { SNAPSHOTS } from '../../model/types';
import { PAR } from '../../sound/lxrParamIds';
import { PatternGrid } from '../grid';
import { ctl, h, Panel, range, win } from '../widgets';
import { subscribe, type View } from './patternView';

interface PadOptions {
  sub?: () => string;
  on?: () => boolean;
  queued?: () => boolean;
  hold?: (down: boolean) => void;
  title?: string;
  empty?: () => boolean;
}

function pad(panel: Panel, parent: HTMLElement, label: string, fn: ((e: MouseEvent) => void) | null, o: PadOptions = {}): HTMLDivElement {
  const p = h('div', 'pad', parent);
  p.tabIndex = 0;
  p.setAttribute('role', 'button');
  const l = h('div', '', p, label);
  const sub = h('span', 'sub', l);
  if (o.title) p.title = o.title;
  if (fn) {
    p.addEventListener('click', fn);
    p.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') fn(e as unknown as MouseEvent);
    });
  }
  if (o.hold) {
    const hold = o.hold;
    let down = false;
    const up = () => {
      if (!down) return;
      down = false;
      p.classList.remove('on');
      hold(false);
    };
    p.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      down = true;
      p.setPointerCapture(e.pointerId);
      p.classList.add('on');
      hold(true);
    });
    p.addEventListener('pointerup', up);
    p.addEventListener('pointercancel', up);
  }
  panel.add(() => {
    if (o.sub) sub.textContent = o.sub();
    if (o.on) p.classList.toggle('on', o.on());
    if (o.queued) p.classList.toggle('queued', o.queued());
    if (o.empty) p.classList.toggle('empty', o.empty());
  });
  return p;
}

function padGrid(parent: HTMLElement, cols: number, gap = 12, rows = 0): HTMLDivElement {
  const g = h('div', '', parent);
  Object.assign(g.style, { display: 'grid', gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridAutoRows: '1fr', gap: gap + 'px' });
  if (rows) g.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
  return g;
}

export function performView(app: App, screen: HTMLElement): View {
  const root = h('div', 'view', screen);
  root.dataset.view = 'perform';
  const top = h('div', 'perform-top', root);
  const side = h('div', 'col', top);
  side.style.gap = '16px';
  const mid = h('div', 'perform-mid', root);
  const q = () => app.project.quantize.toUpperCase();

  // ---------------------------------------------------------------- PADS
  const aw = win(top, { title: 'PERFORM', area: 'perform', id: 'perform' });
  top.insertBefore(aw.el, side);
  const ap = new Panel();
  const ag = padGrid(aw.body, 4);
  pad(ap, ag, 'GENERATE', () => app.generatePattern(true), { sub: () => 'NEXT ' + q(), title: 'A new pattern (G)' }).dataset.test = 'p-generate';
  pad(ap, ag, 'VARIATION', () => app.variation(true), { sub: () => 'RELATED', title: 'A related pattern (V)' });
  pad(ap, ag, 'MUTATE', () => app.mutate(true), { sub: () => 'SMALL CHANGES', title: 'Small controlled changes (M)' });
  pad(ap, ag, 'REGEN', () => app.regenerate(true), { sub: () => 'AFTER BAR 1', title: 'New material after the first bar (R)' });
  pad(ap, ag, 'FILL', null, { hold: (d) => app.fill(d), sub: () => 'HOLD', title: 'Hold for a fill (F)' }).dataset.test = 'p-fill';
  pad(ap, ag, 'SOURCE', null, { hold: (d) => app.setSourceOnly(d), sub: () => 'HOLD: WRITTEN ONLY', title: 'Hold: only the written pattern, no transformations' });
  pad(ap, ag, 'WILDCARD', () => void app.wildcard(true), { sub: () => 'RE-IMAGINE', title: 'One bounded re-imagining (W)' });
  pad(ap, ag, 'RESET', () => app.reset(), { sub: () => 'TO THE PATTERN', title: 'Hand edits cleared and transformations off' });
  const d = () => app.project.destruction;
  pad(ap, ag, 'CHOP', () => app.toggleChop(true), { on: () => d().chop.on, sub: () => (d().chop.on ? 'ON' : 'OFF'), title: 'CHOP on/off (C)' });
  pad(ap, ag, 'ROLLS', () => app.toggleRolls(true), { on: () => d().rolls.on, sub: () => (d().rolls.on ? 'ON' : 'OFF'), title: 'ROLLS on/off (L)' });
  pad(ap, ag, 'DESTROY', () => app.toggleDestroy(true), { on: () => d().destroy.on, sub: () => (d().destroy.on ? 'ON' : 'OFF'), title: 'DESTROY on/off (D)' });
  pad(ap, ag, 'NEW TAKE', () => {
    if (d().chop.on) app.rechop(true);
    if (d().rolls.on) app.reroll(true);
    if (d().destroy.on) app.redestroy(true);
  }, { sub: () => 'RE-DRAW WHAT IS ON', title: 'A new take of every transformation that is on' });
  pad(ap, ag, 'NEW KIT', () => void app.generateKit(true), { sub: () => (app.ui.busy ? 'CHECKING…' : 'GENERATE'), title: 'Generate a kit (K)' });
  pad(ap, ag, 'MUTATE KIT', () => void app.mutateKit(0.25, undefined, true), { sub: () => '25%', title: 'Mutate the kit' });
  pad(ap, ag, 'EVOLVE', () => app.setEvolve({ target: app.project.evolve.target === 'off' ? 'both' : 'off' }), { on: () => app.project.evolve.target !== 'off', sub: () => (app.project.evolve.target === 'off' ? 'OFF' : `${app.project.evolve.target.toUpperCase()} /${app.project.evolve.every}`), title: 'Rhythm and sound evolve on their own' });
  pad(ap, ag, 'KIT HOME', () => app.evolveReturn(), { sub: () => 'UNDO THE DRIFT', title: 'Back to the kit the evolution started from' });
  subscribe(app, ['destruction', 'transport', 'kit', 'status', 'pattern'], () => ap.refresh());

  // ---------------------------------------------------------------- PATTERNS
  const pw = win(side, { title: 'PATTERNS', area: 'perform', id: 'p-patterns' });
  const pp = new Panel();
  const pg = padGrid(pw.body, 4, 8);
  const buildPatterns = () => {
    pp.clear();
    pg.innerHTML = '';
    for (const p of app.project.patterns) {
      pad(pp, pg, p.name, () => app.selectPattern(p.id), { on: () => app.project.current === p.id, queued: () => app.ui.queued === p.id, sub: () => `${p.steps}`, title: `Pattern ${p.name}: switches at the end of the cycle` });
    }
  };
  buildPatterns();
  subscribe(app, ['pattern', 'transport', 'project'], () => {
    if (pg.children.length !== app.project.patterns.length) buildPatterns();
    pp.refresh();
  });

  // ---------------------------------------------------------------- SNAPSHOTS
  const nw = win(side, { title: 'SNAPSHOTS', area: 'perform', id: 'snapshots' });
  const np = new Panel();
  let storing = false;
  const store = h('button', 'btn small', nw.tools, 'STORE');
  store.title = 'Then click a pad to store the current state there';
  store.addEventListener('click', () => {
    storing = !storing;
    np.refresh();
  });
  np.add(() => store.classList.toggle('armed', storing));
  const ng = padGrid(nw.body, 4, 8);
  for (let i = 0; i < SNAPSHOTS; i++) {
    pad(np, ng, String(i + 1), (e) => {
      if (storing || e.shiftKey) {
        app.storeSnapshot(i);
        storing = false;
      } else app.recallSnapshot(i);
      np.refresh();
    }, { empty: () => !app.project.snapshots[i], sub: () => (storing ? 'STORE' : app.project.snapshots[i] ? 'RECALL' : 'EMPTY'), title: 'Click: recall (on the next quantise boundary). STORE then click (or shift-click): store' }).dataset.test = 'snap-' + i;
  }
  subscribe(app, ['snapshots', 'project'], () => np.refresh());

  // ---------------------------------------------------------------- MUTES
  const mw = win(mid, { title: 'TRACKS', area: 'perform', id: 'mutes' });
  const mp = new Panel();
  const mg = padGrid(mw.body, 5, 8);
  const buildMutes = () => {
    mp.clear();
    mg.innerHTML = '';
    for (const tr of app.project.tracks) {
      const x = () => app.project.tracks.find((y) => y.id === tr.id) ?? tr;
      pad(mp, mg, tr.name, (e) => (e.shiftKey ? app.setTrackMix(tr.id, { solo: !x().mix.solo }) : app.setTrackMix(tr.id, { mute: !x().mix.mute })), {
        on: () => !x().mix.mute,
        sub: () => (x().mix.solo ? 'SOLO' : x().mix.mute ? 'MUTED' : 'ON'),
        title: 'Click: mute. Shift-click: solo',
      });
    }
  };
  buildMutes();
  subscribe(app, ['mix', 'tracks'], () => mp.refresh());
  app.on('project', buildMutes);

  // ---------------------------------------------------------------- MACROS
  const xw = win(mid, { title: 'MACROS', area: 'perform', id: 'macros' });
  mid.insertBefore(xw.el, mw.el);
  const xp = new Panel();
  const xb = xw.body;
  xb.classList.add('col');
  xb.style.gap = '10px';
  const macro = (label: string, title: string, get: () => number, set: (v: number) => void, min = 0, max = 100, fmt: (v: number) => string = (v) => v + '%') => {
    const c = ctl(xb, label, title);
    range(xp, c.slot, { get, set, min, max, format: fmt, begin: () => app.beginDrag(label), end: () => app.endDrag(), title });
  };
  const avg = (f: (t: (typeof app.project.tracks)[number]) => number) => Math.round(app.project.tracks.reduce((a, t) => a + f(t), 0) / app.project.tracks.length);
  macro('DENSITY', 'Every track’s density at once: weak hits go first', () => avg((t) => t.play.density), (v) => app.project.tracks.forEach((t) => app.setTrackPlay(t.id, { density: v }, 'DENSITY')));
  macro('FILL', 'Generated hits in the gaps, every track', () => avg((t) => t.play.fill), (v) => app.project.tracks.forEach((t) => app.setTrackPlay(t.id, { fill: v }, 'FILL')));
  macro('HUMANIZE', 'Looseness, every track', () => avg((t) => t.play.humanize), (v) => app.project.tracks.forEach((t) => app.setTrackPlay(t.id, { humanize: v }, 'HUMANIZE')));
  macro('DESTROY', 'DESTROY amount', () => Math.round(d().destroy.amount * 100), (v) => app.setDestruction((x) => (x.destroy.amount = v / 100), 'DESTROY AMOUNT'));
  macro('CHOP', 'CHOP amount', () => Math.round(d().chop.amount * 100), (v) => app.setDestruction((x) => (x.chop.amount = v / 100), 'CHOP AMOUNT'));
  macro('ROLLS', 'ROLL chance', () => Math.round(d().rolls.prob * 100), (v) => app.setDestruction((x) => (x.rolls.prob = v / 100), 'ROLL CHANCE'));
  macro('FX', 'LXR FX bus amount', () => app.project.kit.synth.params[PAR.FX_DRY_WET] ?? 0, (v) => app.setParam(PAR.FX_DRY_WET, v, 'FX AMOUNT'), 0, 127, (v) => String(v));
  macro('SWING', 'Swing', () => app.project.swing, (v) => app.setSwing(v), 50, 75);
  macro('MASTER', 'Master volume', () => Math.round(app.project.master.volume * 100), (v) => app.setMaster({ volume: v / 100 }, 'MASTER VOLUME'));
  subscribe(app, ['tracks', 'destruction', 'kit', 'transport', 'master', 'project'], () => xp.refresh());

  // ---------------------------------------------------------------- mini grid
  const gw = win(root, { title: 'NOW PLAYING', area: 'perform', id: 'nowplaying' });
  const grid = new PatternGrid(app, gw.body, { readonly: true, compact: true });
  const gp = new Panel();
  gp.add(() => (gw.info.textContent = `${app.pattern.name} · ${app.ui.status}`));
  subscribe(app, ['pattern', 'destruction', 'mix'], () => grid.draw());
  app.on('tracks', () => grid.build());
  app.on('status', () => gp.refresh());

  let lastCycle = -1;
  const all = [ap, pp, np, mp, xp, gp];
  return {
    root,
    frame: () => {
      const pos = app.playhead();
      if (pos && pos.cycle !== lastCycle) {
        lastCycle = pos.cycle;
        grid.draw();
      }
      grid.drawOverlay(pos && pos.pattern === app.pattern.id ? pos.step : -1);
    },
    show: (on) => {
      root.classList.toggle('hidden', !on);
      if (on) {
        grid.build();
        for (const p of all) p.refresh();
      }
    },
  };
}
