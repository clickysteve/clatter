/** The pattern grid's data: what shows as sounding, silent or empty, and nothing about where a note came from. */
import { describe, expect, it } from 'vitest';
import { defaultProject } from '../src/model/defaults';
import { clone, type Pattern, type Resolution } from '../src/model/types';
import { defaultGen, generate } from '../src/rhythm/generate';
import { newPattern, setHit } from '../src/rhythm/pattern';
import { realize, type RealizeInput } from '../src/rhythm/realize';
import { boundaryAt, describeCell, gridMetrics, position, sourceLabel, summaryLine, trackCells } from '../src/ui/gridModel';

function setup(res: Resolution = 4) {
  const proj = defaultProject();
  const gen = { ...defaultGen(), style: 'machine' };
  const p: Pattern = newPattern('p1', 'A', gen, res);
  p.grids = generate(proj.tracks, gen, 7, { steps: p.steps, res: p.res });
  const input: RealizeInput = { seed: 3, swing: 50, pattern: p, tracks: proj.tracks, destruction: clone(proj.destruction), evolve: proj.evolve };
  return { proj, p, input };
}

describe('grid structure follows the resolution', () => {
  it('derives beats and bars from the pattern, not from 16', () => {
    for (const [res, perBeat, perBar] of [
      [4, 4, 16],
      [8, 8, 32],
      [6, 6, 24],
      [3, 3, 12],
    ] as const) {
      const m = gridMetrics({ steps: perBar * 2, res });
      expect([m.perBeat, m.perBar]).toEqual([perBeat, perBar]);
      expect(boundaryAt(0, m)).toBe(0);
      expect(boundaryAt(1, m)).toBe(1);
      expect(boundaryAt(perBeat, m)).toBe(2);
      expect(boundaryAt(perBar, m)).toBe(3);
      expect(boundaryAt(perBar + perBeat, m)).toBe(2);
    }
  });

  it('names the bar and beat of a step', () => {
    const m = gridMetrics({ steps: 32, res: 4 });
    expect(position(0, m)).toEqual({ bar: 1, beat: 1, sub: 1 });
    expect(position(5, m)).toEqual({ bar: 1, beat: 2, sub: 2 });
    expect(position(16, m)).toEqual({ bar: 2, beat: 1, sub: 1 });
    expect(position(31, m)).toEqual({ bar: 2, beat: 4, sub: 4 });
  });
});

describe('what the grid shows is what plays', () => {
  it('with nothing in the way, every written hit sounds and every other step is empty', () => {
    const { proj, p, input } = setup();
    const real = realize(input, 0);
    for (const t of proj.tracks) {
      const cells = trackCells(p, t, real);
      cells.forEach((c, s) => {
        const written = !!p.grids[t.id]?.[s];
        expect(c.state).toBe(written ? 'hit' : 'empty');
        expect(c.added).toBe(false);
      });
    }
  });

  it('a hit that stays silent (chance) is an outline, still written', () => {
    const { proj, p, input } = setup();
    const kick = proj.tracks[0]!;
    // a certain hit and a never hit side by side
    setHit(p, kick.id, 1, { vel: 100, prob: 100 });
    setHit(p, kick.id, 2, { vel: 100, prob: 0 });
    const real = realize(input, 0);
    const cells = trackCells(p, kick, real);
    expect(cells[1]!.state).toBe('hit');
    expect(cells[2]!.state).toBe('silent');
    expect(cells[2]!.why).toBe('chance');
    expect(cells[2]!.prob).toBe(0);
    // it is still written: a click would remove it
    expect(cells[2]!.hit).not.toBeNull();
  });

  it('the cell count of sounding hits equals the distinct steps that play', () => {
    const { proj, p, input } = setup();
    input.destruction.rolls = { ...input.destruction.rolls, on: true, prob: 1, place: 'anywhere', length: 4 };
    input.destruction.chop = { ...input.destruction.chop, on: true, amount: 0.9 };
    for (let cycle = 0; cycle < 3; cycle++) {
      const real = realize(input, cycle);
      for (const t of proj.tracks) {
        const cells = trackCells(p, t, real);
        const sounding = new Set(real.events.filter((e) => e.track === t.id && e.kind !== 'flam').map((e) => e.step));
        const shown = new Set(cells.flatMap((c, s) => (c.state === 'hit' ? [s] : [])));
        expect([...shown].sort((a, b) => a - b)).toEqual([...sounding].sort((a, b) => a - b));
      }
    }
  });

  it('a hit added by a transformation is solid but not written', () => {
    const { proj, p, input } = setup();
    input.destruction.rolls = { ...input.destruction.rolls, on: true, prob: 1, place: 'anywhere', length: 4 };
    const real = realize(input, 0);
    let added = 0;
    for (const t of proj.tracks) {
      for (const c of trackCells(p, t, real)) {
        if (c.added) {
          added++;
          expect(c.state).toBe('hit');
          expect(c.hit).toBeNull();
          expect(c.kinds.length).toBeGreaterThan(0);
          expect(sourceLabel(c)).toMatch(/^ · ADDED BY/);
        }
      }
    }
    expect(added).toBeGreaterThan(0);
  });

  it('a hit CHOP moved away is an outline at home and a block where it landed', () => {
    const { proj, p, input } = setup();
    input.destruction.chop = { ...input.destruction.chop, on: true, amount: 1 };
    const real = realize(input, 0);
    const moved = proj.tracks.flatMap((t) => trackCells(p, t, real).filter((c) => c.state === 'silent' && c.why === 'moved'));
    expect(moved.length).toBeGreaterThan(0);
  });

  it('rhythm evolution: what it removes is an outline, what it adds is a block, both say EVOLVE', () => {
    const { proj, p, input } = setup();
    input.evolve = { target: 'rhythm', every: 1, amount: 1, returnEvery: 0 };
    const real = realize(input, 3);
    let seen = 0;
    for (const t of proj.tracks) {
      for (const c of trackCells(p, t, real)) {
        if (!c.evolved) continue;
        seen++;
        if (c.state === 'silent') expect(c.why).toBe('evolved');
        if (c.state === 'hit' && !c.hit) expect(sourceLabel(c)).toMatch(/EVOLVE/);
      }
    }
    expect(seen).toBeGreaterThan(0);
  });

  it('a deleted note is an empty cell, and a placed one is just a note', () => {
    const { proj, p, input } = setup();
    const kick = proj.tracks[0]!;
    const step = p.grids[kick.id]!.findIndex((h) => !!h);
    setHit(p, kick.id, step, null);
    const gone = trackCells(p, kick, realize(input, 0))[step]!;
    expect(gone.state).toBe('empty');
    expect(gone.hit).toBeNull();
    expect(summaryLine('KICK', step, gone, gridMetrics(p))).toMatch(/EMPTY/);
    const t = proj.tracks[5]!;
    const free = p.grids[t.id]!.findIndex((h) => !h);
    setHit(p, t.id, free, { vel: 90 });
    const c = trackCells(p, t, realize(input, 0))[free]!;
    expect(c.state).toBe('hit');
    expect(c.hit?.vel).toBe(90);
    expect('origin' in c).toBe(false);
    expect(sourceLabel(c)).toBe('');
  });

  it('polymeter: steps beyond the track’s own loop are marked outside', () => {
    const { proj, p, input } = setup();
    const t = clone(proj.tracks[3]!);
    t.play.length = 5;
    const cells = trackCells(p, t, realize({ ...input, tracks: proj.tracks.map((x) => (x.id === t.id ? t : x)) }, 0));
    expect(cells.slice(0, 5).every((c) => !c.outside)).toBe(true);
    expect(cells.slice(5).every((c) => c.outside && c.state === 'empty')).toBe(true);
  });

  it('describes a cell in words', () => {
    const { proj, p, input } = setup();
    const kick = proj.tracks[0]!;
    const cells = trackCells(p, kick, realize(input, 0));
    const d = describeCell('KICK', 0, cells[0]!, gridMetrics(p));
    expect(d.head).toBe('KICK · STEP 1');
    expect(d.lines.join(' ')).toMatch(/Sounds/);
    expect(d.lines.join(' ')).not.toMatch(/Source|generated|hand/i);
  });
});
