/** ONE PATTERN: no generated baseline and no edit overlay. Selection, notes, generation, undo, live regeneration, chaining, export and legacy projects. */
import { describe, expect, it } from 'vitest';
import { App } from '../src/app/app';
import { exportMidi } from '../src/export/midiFile';
import { parseProject, serialize } from '../src/model/project';
import { clone, type Pattern } from '../src/model/types';
import { generate } from '../src/rhythm/generate';
import { removeNote, setStepSound, setStepTrig, trackGrid, trigAt } from '../src/rhythm/pattern';
import { realize, type RealizeInput } from '../src/rhythm/realize';
import { Sequence } from '../src/app/sequence';
import { trackCells } from '../src/ui/gridModel';
import { StepGesture, type Press } from '../src/ui/stepGesture';
import { defaultProject } from '../src/model/defaults';
import { PAR } from '../src/sound/lxrParamIds';

/** An app whose current pattern is empty and 16 steps long, plus a gesture machine on it. */
function setup() {
  const app = new App();
  const p = app.pattern;
  p.steps = 16;
  p.res = 4;
  p.grids = {};
  delete p.sounds;
  delete p.trig;
  for (const t of app.project.tracks) {
    t.play = { density: 100, fill: 0, humanize: 0, chance: 100, length: 0 };
    p.grids[t.id] = Array.from({ length: 16 }, () => null);
  }
  app.project.evolve.target = 'off';
  app.history.clear();
  app.ui.paintVel = 100;
  app.ui.sel = null;
  app.ui.picks = [];
  app.ui.cursor = null;
  const g = new StepGesture({ ...app.gestureHost(), created: undefined });
  const ids = app.project.tracks.map((t) => t.id);
  const press = (ti: number, step: number, o: Partial<Press> = {}): Press => ({ track: ids[ti]!, trackIndex: ti, step, x: step * 40 + 20, y: ti * 30 + 15, shift: false, alt: false, ...o });
  const mv = (ti: number, step: number, dy = 0, dx = 0) => ({ x: step * 40 + 20 + dx, y: ti * 30 + 15 + dy, step, trackIndex: ti });
  const click = (ti: number, step: number, o: Partial<Press> = {}) => {
    g.down(press(ti, step, o));
    g.up(mv(ti, step));
  };
  const hit = (ti: number, step: number) => app.hitAt(ids[ti]!, step);
  const notes = () => Object.fromEntries(ids.map((id) => [id, trackGrid(app.pattern, id).map((h) => (h ? h.vel : 0))]));
  return { app, g, ids, press, mv, click, hit, notes };
}

const total = (app: App) => app.noteCount();

describe('one authoritative pattern', () => {
  it('a project holds one grid per track and no edit overlay or baseline', () => {
    const app = new App();
    app.generatePattern();
    const saved = JSON.parse(serialize(app.project));
    for (const pat of saved.patterns) {
      expect(Object.keys(pat)).toContain('grids');
      expect(pat.gen).toBeUndefined();
      expect(pat.edits).toBeUndefined();
    }
    expect(saved.version).toBe(9);
  });

  it('GENERATE makes the current pattern; the next edit changes it at once; one UNDO undoes only the edit, a second the generation', () => {
    const { app, ids, click, hit } = setup();
    const before = JSON.stringify(app.pattern.grids);
    app.generatePattern();
    const generated = JSON.stringify(app.pattern.grids);
    expect(generated).not.toBe(before);
    expect(total(app)).toBeGreaterThan(0);
    const free = trackGrid(app.pattern, ids[3]!).findIndex((h) => !h);
    click(3, free);
    expect(hit(3, free)).not.toBeNull();
    expect(JSON.stringify(app.pattern.grids)).not.toBe(generated);
    app.undo();
    expect(JSON.stringify(app.pattern.grids)).toBe(generated);
    app.undo();
    expect(JSON.stringify(app.pattern.grids)).toBe(before);
  });

  it('GENERATE, MUTATE and VARIATION work on every note the same way and are one undo step each', () => {
    const { app, click } = setup();
    for (const [name, run] of [['GENERATE', () => app.generatePattern()], ['MUTATE', () => app.mutate()], ['VARIATION', () => app.variation()]] as const) {
      click(0, 0);
      click(1, 8);
      const was = JSON.stringify(app.pattern.grids);
      run();
      expect(app.history.undoLabel).toBe(name);
      // MUTATE and VARIATION are random draws and may leave a two-note pattern as it is; only GENERATE must change it
      if (name === 'GENERATE') expect(JSON.stringify(app.pattern.grids)).not.toBe(was);
      app.undo();
      expect(JSON.stringify(app.pattern.grids)).toBe(was);
      app.clearPattern();
    }
  });

  it('a locked track is left alone by GENERATE and MUTATE, and a note is not protected by having been edited', () => {
    const { app, ids, click, hit } = setup();
    app.generatePattern();
    click(2, 5);
    const lockedRow = JSON.stringify(trackGrid(app.pattern, ids[0]!));
    app.lockTrack(ids[0]!);
    app.generatePattern();
    app.mutate();
    expect(JSON.stringify(trackGrid(app.pattern, ids[0]!))).toBe(lockedRow);
    // the clicked note on an unlocked track is not special: the pattern is exactly what the generator makes
    click(3, 7);
    app.generatePattern();
    const pat = app.pattern;
    const fresh = generate(app.project.tracks, app.project.gen, pat.seed, { steps: pat.steps, res: pat.res }, { [ids[0]!]: JSON.parse(lockedRow) });
    expect(pat.grids).toEqual(fresh);
    expect(hit(2, 5)).toEqual(fresh[ids[2]!]![5]);
  });

  it('CLEAR PATTERN empties every track (notes, step sounds and conditions) and one UNDO brings all back', () => {
    const { app, ids, click } = setup();
    click(0, 0);
    click(4, 6);
    setStepSound(app.pattern, ids[0]!, 0, { v: 1 });
    setStepTrig(app.pattern, ids[4]!, 6, { k: 'odd' });
    const before = JSON.stringify(app.project.patterns);
    app.clearPattern();
    expect(total(app)).toBe(0);
    expect(app.pattern.sounds).toBeUndefined();
    expect(app.pattern.trig).toBeUndefined();
    expect(app.history.undoLabel).toBe('CLEAR PATTERN');
    app.undo();
    expect(JSON.stringify(app.project.patterns)).toBe(before);
  });
});

describe('step selection and editing', () => {
  it('clicking an empty step makes a note and selects it; clicking a note removes it', () => {
    const { app, ids, click, hit } = setup();
    click(2, 4);
    expect(hit(2, 4)).not.toBeNull();
    expect(app.cursorCell()).toEqual({ track: ids[2], step: 4 });
    click(5, 9);
    expect(app.cursorCell()).toEqual({ track: ids[5], step: 9 });
    click(2, 4);
    expect(hit(2, 4)).toBeNull();
    expect(app.cursorCell()).toEqual({ track: ids[2], step: 4 });
    expect(app.noteCount()).toBe(1);
  });

  it('deleting a note (click, deleteNote) deletes the note, its step sound and its condition; UNDO restores all three', () => {
    const { app, ids, click, hit } = setup();
    click(1, 3);
    setStepSound(app.pattern, ids[1]!, 3, { v: 2 });
    setStepTrig(app.pattern, ids[1]!, 3, { k: 'even' });
    app.deleteNote(ids[1]!, 3);
    expect(hit(1, 3)).toBeNull();
    expect(app.stepSound(ids[1]!, 3)).toBeUndefined();
    expect(trigAt(app.pattern, ids[1]!, 3)).toBeUndefined();
    app.undo();
    expect(hit(1, 3)).not.toBeNull();
    expect(app.stepSound(ids[1]!, 3)).toEqual({ v: 2 });
    expect(trigAt(app.pattern, ids[1]!, 3)).toEqual({ k: 'even' });
  });

  it('dragging vertically from a note sets its velocity and never paints; dragging sideways paints and never changes a velocity', () => {
    const { app, g, press, mv, ids, click, hit, notes } = setup();
    click(0, 2);
    const v0 = hit(0, 2)!.vel;
    g.down(press(0, 2));
    g.move(mv(0, 2, -30));
    g.move(mv(0, 3, -30)); // wandering sideways after the direction was decided changes nothing else
    g.up(mv(0, 3, -30));
    expect(hit(0, 2)!.vel).toBeGreaterThan(v0);
    expect(hit(0, 3)).toBeNull();
    const after = hit(0, 2)!.vel;
    g.down(press(0, 5));
    g.move(mv(0, 6, 1));
    g.move(mv(0, 9, 2));
    g.up(mv(0, 9, 2));
    expect([5, 6, 7, 8, 9].every((s) => hit(0, s) !== null)).toBe(true);
    expect(hit(0, 2)!.vel).toBe(after);
    expect(notes()[ids[0]!]![5]).toBe(100);
    // the whole paint is one undo step
    app.undo();
    expect([5, 6, 7, 8, 9].every((s) => hit(0, s) === null)).toBe(true);
  });

  it('Shift-drag erases along the track as one undo step', () => {
    const { app, g, press, mv, click, hit } = setup();
    for (const s of [1, 2, 3, 4]) click(1, s);
    g.down(press(1, 1, { shift: true }));
    g.move(mv(1, 2));
    g.move(mv(1, 4));
    g.up(mv(1, 4));
    expect([1, 2, 3, 4].every((s) => hit(1, s) === null)).toBe(true);
    app.undo();
    expect([1, 2, 3, 4].every((s) => hit(1, s) !== null)).toBe(true);
  });

  it('Shift-click builds a multi-step selection; Delete removes exactly those notes in one undo step', () => {
    const { app, ids, click, hit } = setup();
    for (const [t, s] of [[0, 0], [0, 4], [3, 8], [5, 12]] as const) click(t, s);
    app.setCursor({ track: ids[0]!, step: 0 });
    click(3, 8, { shift: true });
    click(5, 12, { shift: true });
    expect(app.selectedCells()).toEqual([{ track: ids[0], step: 0 }, { track: ids[3], step: 8 }, { track: ids[5], step: 12 }]);
    app.deleteSelected();
    expect(app.history.undoLabel).toBe('DELETE NOTES');
    expect(app.noteCount()).toBe(1);
    expect(hit(0, 4)).not.toBeNull();
    app.undo();
    expect(app.noteCount()).toBe(4);
  });

  it('velocity tools act on the picked notes only', () => {
    const { app, ids, click, hit } = setup();
    for (const s of [0, 4, 8]) click(0, s);
    app.setCursor({ track: ids[0]!, step: 0 });
    click(0, 8, { shift: true });
    app.editVelocity({ k: 'set', v: 40 });
    expect([hit(0, 0)!.vel, hit(0, 4)!.vel, hit(0, 8)!.vel]).toEqual([40, 100, 40]);
  });

  it('Delete with nothing but the cursor deletes that one note, never the whole track', () => {
    const { app, ids, click, hit } = setup();
    for (const s of [0, 1, 2]) click(0, s);
    app.setCursor({ track: ids[0]!, step: 1 });
    app.deleteSelected();
    expect([hit(0, 0) !== null, hit(0, 1) !== null, hit(0, 2) !== null]).toEqual([true, false, true]);
  });

  it('the selection belongs to the user: the playhead and playback never move it', () => {
    const { app, ids, click } = setup();
    click(2, 7);
    app.select({ t0: 1, t1: 2, s0: 3, s1: 5 });
    const before = JSON.stringify([app.ui.sel, app.ui.picks, app.ui.cursor, app.ui.track]);
    app.setLength(16);
    app.emit(['transport']);
    expect(JSON.stringify([app.ui.sel, app.ui.picks, app.ui.cursor, app.ui.track])).toBe(before);
    expect(ids.length).toBeGreaterThan(0);
  });
});

describe('STEP SOUND follows the selected step, occupied or empty', () => {
  it('an empty step selected with a right-click is the step the sound editor works on', () => {
    const { app, ids, hit } = setup();
    app.setCursor({ track: ids[4]!, step: 11 });
    expect(hit(4, 11)).toBeNull();
    expect(app.cursorCell()).toEqual({ track: ids[4], step: 11 });
    expect(app.soundTargets()).toEqual([{ track: ids[4], step: 11 }]);
    setStepSound(app.pattern, ids[4]!, 11, { v: 1 });
    expect(app.stepSound(ids[4]!, 11)).toEqual({ v: 1 });
  });

  it('after a click the target is that note; after Shift-clicks it is every picked step', () => {
    const { app, ids, click } = setup();
    click(1, 2);
    expect(app.soundTargets()).toEqual([{ track: ids[1], step: 2 }]);
    click(3, 6, { shift: true });
    click(5, 9, { shift: true });
    expect(app.soundTargets().length).toBe(3);
    expect(app.cursorCell()).toEqual({ track: ids[5], step: 9 });
  });

  it('conditions, step sounds and velocity edits all live in the one pattern and survive each other', () => {
    const { app, ids, click, hit } = setup();
    click(0, 4);
    setStepSound(app.pattern, ids[0]!, 4, { v: 3, locks: { 5: 10 } });
    setStepTrig(app.pattern, ids[0]!, 4, { k: 'every', n: 2, at: 1 });
    app.setHitProps(ids[0]!, 4, { vel: 60 });
    expect(hit(0, 4)!.vel).toBe(60);
    expect(app.stepSound(ids[0]!, 4)).toEqual({ v: 3, locks: { 5: 10 } });
    expect(trigAt(app.pattern, ids[0]!, 4)).toEqual({ k: 'every', n: 2, at: 1 });
    removeNote(app.pattern, ids[0]!, 4);
    expect(app.stepSound(ids[0]!, 4)).toBeUndefined();
  });
});

describe('live regeneration', () => {
  function rig(target: 'rhythm' | 'off') {
    const app = new App();
    app.generatePattern();
    app.pattern.seed = 42;
    app.pattern.grids = generate(app.project.tracks, app.project.gen, 42, { steps: app.pattern.steps, res: app.pattern.res });
    const p = app.project;
    p.seed = 5;
    p.evolve = { target, every: 1, amount: 1, returnEvery: 0 };
    const input = (): RealizeInput => ({ seed: p.seed, swing: 50, pattern: app.pattern, tracks: p.tracks, destruction: clone(p.destruction), evolve: p.evolve });
    const played = (cycle: number) => realize(input(), cycle).events.filter((e) => e.kind === 'source').map((e) => `${e.track}|${e.step}`).sort().join();
    return { app, p, input, played };
  }

  it('with it off the pattern repeats exactly; with it on later cycles differ, and the pattern itself is never rewritten', () => {
    const off = rig('off');
    expect(off.played(0)).toBe(off.played(5));
    const on = rig('rhythm');
    const written = JSON.stringify(on.app.pattern.grids);
    expect(on.played(0)).toBe(off.played(0));
    expect(on.played(3)).not.toBe(on.played(0));
    expect(JSON.stringify(on.app.pattern.grids)).toBe(written);
  });

  it('is reproducible: the same seed and pattern give the same regeneration, in playback and in export', () => {
    const a = rig('rhythm');
    const b = rig('rhythm');
    for (const c of [1, 2, 7]) expect(a.played(c)).toBe(b.played(c));
    expect(Buffer.from(exportMidi(a.p, { bars: 8 })).toString('hex')).toBe(Buffer.from(exportMidi(b.p, { bars: 8 })).toString('hex'));
    const seq = new Sequence({ project: () => a.p });
    const viaSeq = seq.events(3, a.app.pattern.id).filter((e) => e.kind === 'source').map((e) => `${e.track}|${e.step}`).sort().join();
    expect(viaSeq).toBe(a.played(3));
  });

  it('works on the pattern as it stands: a note you add shows in the very next regeneration; locked tracks never change', () => {
    const { app, p, played, input } = rig('rhythm');
    const id = p.tracks[0]!.id;
    app.lockTrack(id);
    const lockedRow = (c: number) => realize(input(), c).events.filter((e) => e.kind === 'source' && e.track === id).map((e) => e.step).join();
    expect(lockedRow(0)).toBe(lockedRow(4));
    const other = p.tracks[6]!.id;
    const free = trackGrid(app.pattern, other).findIndex((h) => !h);
    const before = played(0);
    app.ui.paintVel = 100;
    app.toggleCell(other, free);
    expect(played(0)).not.toBe(before);
    expect(played(0)).toContain(`${other}|${free}`);
  });

  it('the grid shows the regenerated cycle', () => {
    const { app, p, input } = rig('rhythm');
    let evolved = 0;
    for (const t of p.tracks) for (const c of trackCells(app.pattern, t, realize(input(), 3))) if (c.evolved) evolved++;
    expect(evolved).toBeGreaterThan(0);
  });
});

describe('pattern chaining and export read the edited pattern', () => {
  it('each pattern in a chain plays its own notes, edits included, and the MIDI export carries them', () => {
    const { app, ids, click } = setup();
    click(0, 0);
    app.addPattern(false);
    const b = app.project.patterns[1]!;
    for (const t of app.project.tracks) b.grids[t.id] = Array.from({ length: b.steps }, () => null);
    b.steps = 16;
    b.res = 4;
    for (const t of app.project.tracks) b.grids[t.id] = Array.from({ length: 16 }, () => null);
    b.grids[ids[1]!]![4] = { vel: 90 };
    app.project.chain = { on: true, entries: [{ pattern: app.project.patterns[0]!.id, repeats: 1 }, { pattern: b.id, repeats: 1 }] };
    app.project.current = app.project.patterns[0]!.id;
    const seq = new Sequence({ project: () => app.project });
    const keys = [0, 1, 2, 3].map((k) => {
      const plan = seq.plan(k);
      return seq.events(k, plan.pattern).filter((e) => e.kind === 'source').map((e) => `${plan.pattern}:${e.track}|${e.step}`).join();
    });
    expect(keys[0]).toBe(`${app.project.patterns[0]!.id}:${ids[0]}|0`);
    expect(keys[1]).toBe(`${b.id}:${ids[1]}|4`);
    expect(keys[2]).toBe(keys[0]);
    expect(keys[3]).toBe(keys[1]);
    const midi = exportMidi(app.project, { bars: 4 });
    expect(midi.length).toBeGreaterThan(40);
    // editing pattern A changes the export at once
    const before = Buffer.from(midi).toString('hex');
    app.project.current = app.project.patterns[0]!.id;
    app.toggleCell(ids[2]!, 8);
    expect(Buffer.from(exportMidi(app.project, { bars: 4 })).toString('hex')).not.toBe(before);
  });
});

describe('legacy projects (generated baseline plus hand edits) open as one pattern', () => {
  /** A version-7 project as the old CLATTER saved it. */
  function legacy() {
    const p = defaultProject();
    const ids = p.tracks.map((t) => t.id);
    const pat = p.patterns[0]!;
    pat.steps = 16;
    pat.res = 4;
    const saved = JSON.parse(serialize(p));
    const sp = saved.patterns[0];
    sp.steps = 16;
    const gen: Record<string, ({ vel: number; prob?: number } | null)[]> = {};
    for (const id of ids) gen[id] = Array.from({ length: 16 }, () => null);
    gen[ids[0]!]![0] = { vel: 110 };
    gen[ids[0]!]![4] = { vel: 100 };
    gen[ids[0]!]![8] = { vel: 100 };
    gen[ids[1]!]![4] = { vel: 90, prob: 50 };
    sp.gen = gen;
    // an added note, a changed note (velocity), a deleted note
    sp.edits = { [ids[0]!]: { 2: { vel: 77, ratchet: 2 }, 4: { vel: 55 }, 8: null }, [ids[2]!]: { 15: { vel: 64, flam: true } } };
    delete sp.grids;
    sp.sounds = { [ids[0]!]: { 4: { v: 1, gen: true, locks: { [PAR.VELOD3]: 20 } }, 2: { v: 2 } } };
    sp.trig = { [ids[0]!]: { 4: { k: 'every', n: 2, at: 1 } } };
    saved.version = 7;
    saved.patterns[0].generation = 3;
    return { saved, ids, text: JSON.stringify(saved) };
  }

  it('resolves gen + edits into the effective pattern and keeps every audible step, velocity, condition and sound', () => {
    const { text, ids } = legacy();
    const p = parseProject(text);
    expect(p.version).toBe(9);
    const g = (i: number) => p.patterns[0]!.grids[ids[i]!]!.map((h) => (h ? h.vel : 0));
    expect(g(0)).toEqual([110, 0, 77, 0, 55, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(p.patterns[0]!.grids[ids[0]!]![2]).toEqual({ vel: 77, ratchet: 2 });
    expect(g(1)[4]).toBe(90);
    expect(p.patterns[0]!.grids[ids[1]!]![4]).toEqual({ vel: 90, prob: 50 });
    expect(p.patterns[0]!.grids[ids[2]!]![15]).toEqual({ vel: 64, flam: true });
    expect(p.patterns[0]!.trig).toEqual({ [ids[0]!]: { 4: { k: 'every', n: 2, at: 1 } } });
    expect(p.patterns[0]!.sounds![ids[0]!]![4]).toEqual({ v: 1, locks: { [PAR.VELOD3]: 20 } });
    expect(p.patterns[0]!.sounds![ids[0]!]![2]).toEqual({ v: 2 });
    expect(p.patterns[0]!.generation).toBe(3);
  });

  it('what plays is exactly what the old effective pattern played', () => {
    const { text, ids } = legacy();
    const p = parseProject(text);
    const events = realize({ seed: p.seed, swing: 50, pattern: p.patterns[0]!, tracks: p.tracks.map((t) => ({ ...t, play: { ...t.play, density: 100, chance: 100, fill: 0 } })), destruction: { ...p.destruction, chop: { ...p.destruction.chop, on: false }, rolls: { ...p.destruction.rolls, on: false }, destroy: { ...p.destruction.destroy, on: false } }, evolve: { ...p.evolve, target: 'off' } }, 0).events.filter((e) => e.kind === 'source' && e.track === ids[0]).map((e) => e.step);
    expect(events).toEqual([0, 2, 4]);
  });

  it('saves in the simplified form: no gen, no edits, no leftover flags; reloading changes nothing', () => {
    const { text } = legacy();
    const once = serialize(parseProject(text));
    const saved = JSON.parse(once);
    expect(saved.patterns[0].gen).toBeUndefined();
    expect(saved.patterns[0].edits).toBeUndefined();
    expect(JSON.stringify(saved.patterns[0].sounds)).not.toContain('"gen"');
    expect(serialize(parseProject(once))).toBe(once);
  });

  it('a project saved by this version is not mistaken for a legacy one, and a new-format file ignores stray old fields', () => {
    const { saved, ids } = legacy();
    const p = parseProject(JSON.stringify(saved));
    const again = JSON.parse(serialize(p));
    again.patterns[0].edits = { [ids[0]!]: { 0: null } };
    again.patterns[0].gen = { [ids[0]!]: [] };
    const q = parseProject(JSON.stringify(again)) as { patterns: Pattern[] };
    expect(q.patterns[0]!.grids[ids[0]!]![0]).toEqual({ vel: 110 });
  });

  it('a fresh generated pattern equals what the generator makes (no hidden layer)', () => {
    const app = new App();
    app.generatePattern();
    const pat = app.pattern;
    expect(pat.grids).toEqual(generate(app.project.tracks, app.project.gen, pat.seed, { steps: pat.steps, res: pat.res }));
  });
});
