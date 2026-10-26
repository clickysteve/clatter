/** SEQUENCER EDITING: pointer gestures (create, delete, velocity drag, paint, erase), selection, copy and paste, velocity tools, undo, trigger feedback. */
import { describe, expect, it } from 'vitest';
import { App } from '../src/app/app';
import { History } from '../src/app/history';
import { sourceGrid } from '../src/rhythm/pattern';
import { applyVelOp, dragVelocity } from '../src/rhythm/velocity';
import { trackCells, trigOutcome } from '../src/ui/gridModel';
import { DRAG_THRESHOLD, StepGesture, type Press } from '../src/ui/stepGesture';
import { realize } from '../src/rhythm/realize';
import { clone } from '../src/model/types';

/** An app with an empty pattern of 16 steps, so every hit in a test was put there by the test. */
function setup() {
  const app = new App();
  const p = app.pattern;
  p.steps = 16;
  p.res = 4;
  p.gen = {};
  p.edits = {};
  delete p.sounds;
  delete p.trig;
  for (const t of app.project.tracks) {
    t.play = { density: 100, fill: 0, humanize: 0, chance: 100, length: 0 };
    p.gen[t.id] = Array.from({ length: 16 }, () => null);
  }
  app.history.clear();
  app.ui.paintVel = 100;
  app.ui.sel = null;
  app.ui.cursor = null;
  const host = { ...app.gestureHost(), created: undefined };
  const g = new StepGesture(host);
  const ids = app.project.tracks.map((t) => t.id);
  // pixels: 40 px per step, 30 px per row
  const press = (ti: number, step: number, o: Partial<Press> = {}): Press => ({ track: ids[ti]!, trackIndex: ti, step, x: step * 40 + 20, y: ti * 30 + 15, shift: false, alt: false, ...o });
  const mv = (ti: number, step: number, dy = 0, dx = 0) => ({ x: step * 40 + 20 + dx, y: ti * 30 + 15 + dy, step, trackIndex: ti });
  const hit = (ti: number, step: number) => app.hitAt(ids[ti]!, step);
  const row = (ti: number) => sourceGrid(app.pattern, ids[ti]!).map((h) => (h ? 1 : 0)).join('');
  return { app, g, ids, press, mv, hit, row };
}

describe('step creation and deletion', () => {
  it('a click on an empty step makes a hit at the new-hit velocity, as one undo step', () => {
    const { app, g, press, mv, hit } = setup();
    app.ui.paintVel = 90;
    g.down(press(2, 5));
    g.up(mv(2, 5));
    expect(hit(2, 5)).toMatchObject({ vel: 90 });
    expect(app.history.undoLabel).toBe('ADD HIT');
    app.undo();
    expect(hit(2, 5)).toBeNull();
    app.redo();
    expect(hit(2, 5)?.vel).toBe(90);
  });

  it('a click on a hit removes it; a click that wanders less than the threshold still counts as a click', () => {
    const { app, g, press, mv, hit } = setup();
    g.down(press(0, 3));
    g.up(mv(0, 3));
    expect(hit(0, 3)).not.toBeNull();
    g.down(press(0, 3));
    g.move(mv(0, 3, DRAG_THRESHOLD - 1, 0));
    g.up(mv(0, 3));
    expect(hit(0, 3)).toBeNull();
    expect(app.history.undoLabel).toBe('DELETE HIT');
    app.undo();
    expect(hit(0, 3)).not.toBeNull();
  });
});

describe('velocity dragging', () => {
  it('dragging up from a new hit raises its velocity, down lowers it, within 1-127', () => {
    const { app, g, press, mv, hit } = setup();
    g.down(press(1, 4));
    g.move(mv(1, 4, -20));
    expect(g.mode).toBe('vel');
    expect(hit(1, 4)?.vel).toBe(120);
    expect(g.dragging?.vel).toBe(120);
    g.move(mv(1, 4, -200));
    expect(hit(1, 4)?.vel).toBe(127);
    g.move(mv(1, 4, 40));
    expect(hit(1, 4)?.vel).toBe(60);
    g.move(mv(1, 4, 900));
    expect(hit(1, 4)?.vel).toBe(1);
    g.up(mv(1, 4, 900));
    expect(g.dragging).toBeNull();
    // the whole gesture, creation included, is one undo step
    expect(app.history.undoLabel).toBe('VELOCITY');
    app.undo();
    expect(hit(1, 4)).toBeNull();
  });

  it('keeps every other property of an existing hit, and one undo restores the velocity', () => {
    const { app, g, ids, press, mv, hit } = setup();
    app.pattern.gen[ids[0]!]![6] = { vel: 80, prob: 50, note: 3, ratchet: 2, flam: true };
    g.down(press(0, 6));
    g.move(mv(0, 6, -10));
    g.move(mv(0, 6, -30));
    g.up(mv(0, 6, -30));
    expect(hit(0, 6)).toMatchObject({ vel: 110, prob: 50, note: 3, ratchet: 2, flam: true });
    app.undo();
    expect(hit(0, 6)).toMatchObject({ vel: 80, prob: 50, note: 3, ratchet: 2, flam: true });
  });

  it('keeps tracking when the pointer leaves the step (and the grid)', () => {
    const { g, press, mv, hit, app } = setup();
    g.down(press(3, 2));
    g.move(mv(3, 2, -10));
    // far to the right, above the grid: the step and track under the pointer no longer matter
    g.move({ x: 900, y: -200, step: 15, trackIndex: 0 });
    expect(g.mode).toBe('vel');
    expect(app.hitAt(app.project.tracks[3]!.id, 2)?.vel).toBe(127);
    expect(hit(0, 15)).toBeNull();
    g.up();
  });

  it('is a pure drag: up is louder, a pixel is a step of velocity', () => {
    expect(dragVelocity(64, -10)).toBe(74);
    expect(dragVelocity(64, 10)).toBe(54);
    expect(dragVelocity(64, -500)).toBe(127);
    expect(dragVelocity(64, 500)).toBe(1);
  });
});

describe('step painting', () => {
  it('a sideways drag makes hits along the track, filling steps the pointer skipped, as one undo step', () => {
    const { app, g, press, mv, row } = setup();
    g.down(press(4, 2));
    g.move(mv(4, 2, 0, 10));
    expect(g.mode).toBe('paint');
    g.move(mv(4, 7)); // a fast pointer: 3 to 6 were never reported
    g.up(mv(4, 7));
    expect(row(4)).toBe('0011111100000000');
    expect(app.history.undoLabel).toBe('PAINT');
    app.undo();
    expect(row(4)).toBe('0000000000000000');
  });

  it('painting leaves neighbouring tracks alone, even when the pointer drifts onto them', () => {
    const { g, press, mv, row } = setup();
    g.down(press(4, 1));
    g.move(mv(4, 3, 0, 80));
    g.move(mv(5, 6, 40));
    g.move(mv(3, 8, -45));
    g.up(mv(3, 8));
    expect(row(4)).toBe('0111111110000000');
    expect(row(3)).toBe('0000000000000000');
    expect(row(5)).toBe('0000000000000000');
  });

  it('painting leaves the hits that are there as they are, and sweeping backwards works', () => {
    const { g, app, ids, press, mv, row, hit } = setup();
    app.pattern.gen[ids[0]!]![5] = { vel: 33 };
    g.down(press(0, 8));
    g.move(mv(0, 7, 0, -20));
    g.move(mv(0, 3));
    g.up(mv(0, 3));
    expect(row(0)).toBe('0001111110000000');
    expect(hit(0, 5)?.vel).toBe(33);
    expect(hit(0, 4)?.vel).toBe(100);
  });

  it('a vertical start never paints, and a sideways start never changes a velocity', () => {
    const { g, press, mv, row, hit } = setup();
    g.down(press(0, 2));
    g.move(mv(0, 2, -12, 3));
    g.move(mv(0, 6, -12, 160)); // now far to the right: still the velocity of step 2
    g.up(mv(0, 6, -12));
    expect(row(0)).toBe('0010000000000000');
    expect(hit(0, 2)?.vel).toBe(112);
    g.down(press(1, 2));
    g.move(mv(1, 2, 0, 12));
    g.move(mv(1, 3, -80, 40));
    g.up(mv(1, 3, -80));
    expect(hit(1, 2)?.vel).toBe(100);
  });

  it('Shift-drag erases along the track, Shift-click selects, and neither touches other tracks', () => {
    const { app, g, ids, press, mv, row } = setup();
    for (const ti of [0, 1]) for (let s = 0; s < 8; s++) app.pattern.gen[ids[ti]!]![s] = { vel: 90 };
    g.down(press(0, 1, { shift: true }));
    g.move(mv(0, 1, 0, 12));
    expect(g.mode).toBe('erase');
    g.move(mv(1, 5, 30, 160));
    g.up(mv(1, 5, 30));
    expect(row(0)).toBe('1000001100000000');
    expect(row(1)).toBe('1111111100000000');
    expect(app.history.undoLabel).toBe('ERASE');
    app.undo();
    expect(row(0)).toBe('1111111100000000');
    // a Shift-click without moving erases nothing
    g.down(press(0, 2, { shift: true }));
    g.up(mv(0, 2));
    expect(row(0)).toBe('1111111100000000');
  });
});

describe('selection', () => {
  it('Shift-click selects from the cursor to the step; a second one extends from the same anchor', () => {
    const { app, g, press, mv } = setup();
    g.down(press(1, 2));
    g.up(mv(1, 2));
    g.down(press(3, 6, { shift: true }));
    g.up(mv(3, 6));
    expect(app.ui.sel).toEqual({ t0: 1, t1: 3, s0: 2, s1: 6 });
    g.down(press(2, 9, { shift: true }));
    g.up(mv(2, 9));
    expect(app.ui.sel).toEqual({ t0: 1, t1: 2, s0: 2, s1: 9 });
  });

  it('Alt-drag selects a region and a plain click clears it', () => {
    const { app, g, press, mv } = setup();
    g.down(press(0, 1, { alt: true }));
    g.move(mv(2, 4));
    g.up(mv(2, 4));
    expect(app.ui.sel).toEqual({ t0: 0, t1: 2, s0: 1, s1: 4 });
    expect(app.history.canUndo).toBe(false); // selecting is not an edit
    g.down(press(5, 9));
    g.up(mv(5, 9));
    expect(app.ui.sel).toBeNull();
  });

  it('DELETE clears the hits of the selection in one undo step; Select All covers the pattern', () => {
    const { app, ids, row } = setup();
    for (let s = 0; s < 16; s++) app.pattern.gen[ids[0]!]![s] = { vel: 80 };
    app.select({ t0: 0, t1: 0, s0: 4, s1: 7 });
    expect(app.selectedHitCount()).toBe(4);
    app.clearSelection();
    expect(row(0)).toBe('1111000011111111');
    app.undo();
    expect(row(0)).toBe('1111111111111111');
    app.selectAll();
    expect(app.ui.sel).toEqual({ t0: 0, t1: app.project.tracks.length - 1, s0: 0, s1: 15 });
    expect(app.selectedHitCount()).toBe(16);
  });
});

describe('copy and paste', () => {
  it('carries velocity, chance, pitch, ratchet, step sounds and trigger conditions, and selects what it pasted', () => {
    const { app, ids } = setup();
    const t = ids[0]!;
    app.pattern.gen[t]![1] = { vel: 70, prob: 60, note: 2, ratchet: 3, flam: true };
    app.pattern.gen[t]![2] = { vel: 111 };
    app.pattern.sounds = { [t]: { 1: { v: 2, locks: { 5: 40 } } } };
    app.pattern.trig = { [t]: { 2: { k: 'every', n: 4, at: 2 } } };
    app.select({ t0: 0, t1: 0, s0: 1, s1: 2 });
    app.copy();
    app.select({ t0: 0, t1: 0, s0: 9, s1: 9 });
    app.paste();
    expect(app.hitAt(t, 9)).toMatchObject({ vel: 70, prob: 60, note: 2, ratchet: 3, flam: true });
    expect(app.hitAt(t, 10)?.vel).toBe(111);
    expect(app.pattern.sounds![t]![9]).toEqual({ v: 2, locks: { 5: 40 } });
    expect(app.pattern.trig![t]![10]).toEqual({ k: 'every', n: 4, at: 2 });
    // a copy, not a shared object
    app.pattern.sounds![t]![9]!.v = 0;
    expect(app.pattern.sounds![t]![1]!.v).toBe(2);
    expect(app.ui.sel).toEqual({ t0: 0, t1: 0, s0: 9, s1: 10 });
    expect(app.history.undoLabel).toBe('PASTE');
    app.undo();
    expect(app.hitAt(t, 9)).toBeNull();
    expect(app.pattern.trig![t]![10]).toBeUndefined();
  });

  it('pastes at the step being edited when nothing is selected', () => {
    const { app, ids } = setup();
    const t = ids[2]!;
    app.pattern.gen[t]![0] = { vel: 50 };
    app.select({ t0: 2, t1: 2, s0: 0, s1: 1 });
    app.copy();
    app.select(null);
    app.selectTrack(t);
    app.ui.cursor = { track: t, step: 6 };
    app.paste();
    expect(app.hitAt(t, 6)?.vel).toBe(50);
  });
});

describe('velocity tools', () => {
  function seeded() {
    const s = setup();
    for (const [ti, steps] of [[0, [0, 4, 8, 12]], [1, [2, 6]]] as const) for (const st of steps) s.app.pattern.gen[s.ids[ti]!]![st] = { vel: 64, prob: 70 };
    return s;
  }
  const vels = (app: App, id: string) => sourceGrid(app.pattern, id).flatMap((h) => (h ? [h.vel] : []));

  it('SET gives every selected hit a velocity, and leaves the rest of the hit alone', () => {
    const { app, ids } = seeded();
    app.select({ t0: 0, t1: 1, s0: 0, s1: 15 });
    expect(app.editVelocity({ k: 'set', v: 100 })).toBe(6);
    expect(vels(app, ids[0]!)).toEqual([100, 100, 100, 100]);
    expect(app.hitAt(ids[1]!, 2)).toMatchObject({ vel: 100, prob: 70 });
    expect(app.history.undoLabel).toBe('SET VELOCITY');
    app.undo();
    expect(vels(app, ids[0]!)).toEqual([64, 64, 64, 64]);
  });

  it('NUDGE clamps to 1-127; with nothing selected the tools act on the selected track only', () => {
    const { app, ids } = seeded();
    app.selectTrack(ids[1]!);
    app.editVelocity({ k: 'nudge', d: 100 });
    expect(vels(app, ids[1]!)).toEqual([127, 127]);
    expect(vels(app, ids[0]!)).toEqual([64, 64, 64, 64]);
    app.editVelocity({ k: 'nudge', d: -500 });
    expect(vels(app, ids[1]!)).toEqual([1, 1]);
  });

  it('RAMP runs from the first selected hit to the last, on each track, over the hits (not the steps)', () => {
    const { app, ids } = seeded();
    app.select({ t0: 0, t1: 1, s0: 0, s1: 15 });
    app.editVelocity({ k: 'ramp', from: 20, to: 110 });
    expect(vels(app, ids[0]!)).toEqual([20, 50, 80, 110]);
    expect(vels(app, ids[1]!)).toEqual([20, 110]);
    expect(applyVelOp([5], { k: 'ramp', from: 33, to: 99 })).toEqual([33]);
  });

  it('RANDOM stays in range, is repeatable from its seed, and differs between tracks', () => {
    const { app, ids } = seeded();
    app.select({ t0: 0, t1: 1, s0: 0, s1: 15 });
    app.editVelocity({ k: 'random', lo: 40, hi: 90, seed: 7 });
    const a = [...vels(app, ids[0]!), ...vels(app, ids[1]!)];
    expect(a.every((v) => v >= 40 && v <= 90)).toBe(true);
    expect(new Set(a).size).toBeGreaterThan(2);
    expect(applyVelOp([1, 1, 1, 1], { k: 'random', lo: 10, hi: 20, seed: 3 })).toEqual(applyVelOp([1, 1, 1, 1], { k: 'random', lo: 20, hi: 10, seed: 3 }));
    app.undo();
    expect(vels(app, ids[0]!)).toEqual([64, 64, 64, 64]);
    app.redo();
    expect([...vels(app, ids[0]!), ...vels(app, ids[1]!)]).toEqual(a);
  });

  it('does nothing, and makes no undo step, when there are no hits', () => {
    const { app } = setup();
    expect(app.editVelocity({ k: 'set', v: 90 })).toBe(0);
    expect(app.history.canUndo).toBe(false);
  });
});

describe('history', () => {
  it('relabel renames the open gesture, and only that', () => {
    const h = new History<number>(() => 0, () => {});
    h.relabel('X');
    h.begin('ADD HIT');
    h.relabel('PAINT');
    h.commit();
    expect(h.undoLabel).toBe('PAINT');
  });

  it('a cancelled gesture (pointer lost) keeps its work as one undo step', () => {
    const { app, g, press, mv, row } = setup();
    g.down(press(0, 0));
    g.move(mv(0, 0, 0, 20));
    g.move(mv(0, 3));
    g.cancel();
    expect(g.active).toBe(false);
    expect(row(0)).toBe('1111000000000000');
    app.undo();
    expect(row(0)).toBe('0000000000000000');
    expect(app.history.canUndo).toBe(false);
  });
});

describe('conditional trigger feedback', () => {
  function cells(pass: number) {
    const { app, ids } = setup();
    const t = ids[0]!;
    for (const s of [0, 4, 8, 12]) app.pattern.gen[t]![s] = { vel: 100 };
    app.pattern.trig = { [t]: { 0: { k: 'first' }, 4: { k: 'every', n: 2, at: 2 }, 8: { k: 'always' } } };
    const tr = app.project.tracks[0]!;
    const real = realize({ seed: app.project.seed, swing: 50, pattern: app.pattern, tracks: app.project.tracks, destruction: clone(app.project.destruction), evolve: app.project.evolve, trig: { pass, last: false } }, pass);
    return trackCells(app.pattern, tr, real);
  }

  it('reads the sequencer’s own decision: played when the condition holds, skipped when it does not', () => {
    const first = cells(0);
    expect(trigOutcome(first[0]!)).toBe('played'); // FIRST on the first pass
    expect(trigOutcome(first[4]!)).toBe('skipped'); // EVERY 2 ON 2 on pass 1
    const second = cells(1);
    expect(trigOutcome(second[0]!)).toBe('skipped');
    expect(trigOutcome(second[4]!)).toBe('played');
  });

  it('marks nothing for unconditional or empty steps', () => {
    const c = cells(0);
    expect(trigOutcome(c[8]!)).toBeNull(); // ALWAYS is no condition
    expect(trigOutcome(c[12]!)).toBeNull();
    expect(trigOutcome(c[1]!)).toBeNull();
  });
});
