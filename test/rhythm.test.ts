/** RHYTHM: generation, realisation, timing, probability, velocity, swing, length, independence. */
import { describe, expect, it } from 'vitest';
import { defaultGen, generate, stepsPerBar } from '../src/rhythm/generate';
import { STYLES } from '../src/rhythm/styles';
import { realize, swingTick, CELL_SUPPRESSED, type RealizeInput } from '../src/rhythm/realize';
import { newPattern, setHit, trackGrid, setLength, copyRegion, pasteRegion } from '../src/rhythm/pattern';
import { mutate } from '../src/rhythm/mutate';
import { Rng } from '../src/rhythm/rng';
import { defaultProject } from '../src/model/defaults';
import { PPQ, stepTicks, type Pattern } from '../src/model/types';

function setup(style = 'machine', seed = 7) {
  const proj = defaultProject();
  const gen = { ...defaultGen(), style };
  const p = newPattern('p1', 'A', gen);
  p.seed = seed;
  p.grids = generate(proj.tracks, gen, seed, { steps: p.steps, res: p.res });
  const input: RealizeInput = { seed: 1, swing: 50, pattern: p, tracks: proj.tracks, destruction: proj.destruction, evolve: proj.evolve };
  return { proj, p, input };
}

describe('generation', () => {
  it('is deterministic for a seed and differs between seeds', () => {
    const a = setup('breaks', 5).p.grids;
    const b = setup('breaks', 5).p.grids;
    const c = setup('breaks', 6).p.grids;
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).not.toEqual(JSON.stringify(c));
  });

  it.each(STYLES.map((s) => s.id))('%s produces a coherent pattern (kick present, not saturated)', (style) => {
    const { p, proj } = setup(style, 3);
    const kick = proj.tracks.find((t) => t.role === 'kick')!;
    const kicks = p.grids[kick.id]!.filter(Boolean).length;
    expect(kicks).toBeGreaterThan(0);
    let total = 0;
    for (const t of proj.tracks) total += p.grids[t.id]!.filter(Boolean).length;
    expect(total).toBeLessThan(p.steps * proj.tracks.length * 0.6);
    for (const t of proj.tracks) for (const h of p.grids[t.id]!) if (h) {
      expect(h.vel).toBeGreaterThanOrEqual(1);
      expect(h.vel).toBeLessThanOrEqual(127);
    }
  });

  it('MACHINE keeps four on the floor', () => {
    const { p, proj } = setup('machine', 11);
    const kick = p.grids[proj.tracks[0]!.id]!;
    for (let i = 0; i < p.steps; i += 4) expect(kick[i]).not.toBeNull();
  });

  it('density scales the number of hits', () => {
    const proj = defaultProject();
    const count = (density: number) => {
      const g = generate(proj.tracks, { ...defaultGen(), style: 'breaks', density }, 9, { steps: 32, res: 4 });
      return Object.values(g).reduce((a, r) => a + r.filter(Boolean).length, 0);
    };
    expect(count(0.1)).toBeLessThan(count(0.5));
    expect(count(0.5)).toBeLessThan(count(0.95));
  });

  it('locked tracks keep their rhythm', () => {
    const { p, proj } = setup('electro', 2);
    proj.tracks[1]!.lock = true;
    const again = generate(proj.tracks, { ...defaultGen(), style: 'jungle' }, 99, { steps: p.steps, res: p.res }, p.grids);
    expect(again[proj.tracks[1]!.id]).toEqual(p.grids[proj.tracks[1]!.id]);
    expect(again[proj.tracks[0]!.id]).not.toEqual(p.grids[proj.tracks[0]!.id]);
  });

  it('a track is independent of the other tracks (keys per track)', () => {
    const proj = defaultProject();
    const a = generate(proj.tracks, defaultGen(), 4, { steps: 32, res: 4 });
    const fewer = generate(proj.tracks.slice(0, 3), defaultGen(), 4, { steps: 32, res: 4 });
    expect(fewer[proj.tracks[0]!.id]).toEqual(a[proj.tracks[0]!.id]);
  });

  it('REGENERATE keeps the first bar', () => {
    const { p, proj } = setup('broken', 8);
    const regen = generate(proj.tracks, p.settings, 1234, { steps: p.steps, res: p.res }, p.grids, 1);
    const bar = stepsPerBar(p.res);
    for (const t of proj.tracks) expect(regen[t.id]!.slice(0, bar)).toEqual(p.grids[t.id]!.slice(0, bar));
  });
});

describe('realisation', () => {
  it('places steps at exact ticks with the source velocities', () => {
    const { input, p, proj } = setup('machine', 1);
    const r = realize(input, 0);
    const T = stepTicks(p.res);
    expect(T).toBe(PPQ / 4);
    for (const e of r.events.filter((x) => x.kind === 'source')) {
      expect(e.tick).toBe(e.step * T);
      const h = trackGrid(p, e.track)[e.step]!;
      expect(e.vel).toBe(h.vel);
    }
    expect(r.cycleTicks).toBe(p.steps * T);
    void proj;
  });

  it('is identical however often it is asked (determinism)', () => {
    const { input } = setup('jungle', 3);
    const tracks = input.tracks.map((t) => ({ ...t, play: { ...t.play, humanize: 40, chance: 70, fill: 50 } }));
    const a = realize({ ...input, tracks }, 5);
    const b = realize({ ...input, tracks }, 5);
    expect(a.events).toEqual(b.events);
  });

  it('per-step probability plays a hit about that often', () => {
    const { input, p, proj } = setup('machine', 1);
    const id = proj.tracks[0]!.id;
    const pat: Pattern = { ...p, grids: { ...p.grids, [id]: p.grids[id]!.map(() => ({ vel: 100, prob: 30 })) } };
    let played = 0;
    let total = 0;
    for (let c = 0; c < 40; c++) {
      const r = realize({ ...input, pattern: pat }, c);
      played += r.events.filter((e) => e.track === id).length;
      total += pat.steps;
    }
    expect(played / total).toBeGreaterThan(0.2);
    expect(played / total).toBeLessThan(0.4);
    const r = realize({ ...input, pattern: pat }, 0);
    expect(Array.from(r.cells[id]!).some((f) => f & CELL_SUPPRESSED)).toBe(true);
  });

  it('density drops soft hits before loud ones', () => {
    const { input, p, proj } = setup('machine', 1);
    const id = proj.tracks[0]!.id;
    const pat: Pattern = { ...p, grids: { ...p.grids, [id]: p.grids[id]!.map((_, i) => ({ vel: i % 2 ? 30 : 127 })) } };
    const tracks = proj.tracks.map((t) => (t.id === id ? { ...t, play: { ...t.play, density: 50 } } : t));
    let soft = 0;
    let loud = 0;
    for (let c = 0; c < 30; c++) for (const e of realize({ ...input, pattern: pat, tracks }, c).events.filter((e) => e.track === id)) e.vel > 100 ? loud++ : soft++;
    expect(loud).toBeGreaterThan(soft * 1.5);
  });

  it('swing delays the off-sixteenths only', () => {
    expect(swingTick(0, 66)).toBe(0);
    expect(swingTick(48, 66)).toBe(48);
    expect(swingTick(24, 66)).toBeGreaterThan(24);
    expect(swingTick(24, 50)).toBe(24);
  });

  it('honours the pattern length and polymeter track lengths', () => {
    const { input, p, proj } = setup('machine', 1);
    setLength(p, 12);
    const r = realize(input, 0);
    for (const e of r.events) expect(e.tick).toBeLessThan(12 * stepTicks(p.res));
    const id = proj.tracks[0]!.id;
    const grid = p.grids[id]!.map(() => null as null | { vel: number });
    grid[0] = { vel: 100 };
    const pat = { ...p, steps: 16, grids: { ...p.grids, [id]: [...grid, ...new Array(4).fill(null)] } };
    const tracks = proj.tracks.map((t) => (t.id === id ? { ...t, play: { ...t.play, length: 3 } } : t));
    const hits = realize({ ...input, pattern: pat, tracks }, 0).events.filter((e) => e.track === id).map((e) => e.step);
    expect(hits).toEqual([0, 3, 6, 9, 12, 15]);
  });
});

describe('editing', () => {
  it('an edited step is just a step: the next generation replaces it unless the track is locked', () => {
    const { p, proj } = setup('machine', 1);
    const id = proj.tracks[1]!.id;
    setHit(p, id, 3, { vel: 99 });
    expect(trackGrid(p, id)[3]).toEqual({ vel: 99 });
    expect(p.grids[id]![3]).toEqual({ vel: 99 });
    const jungle = generate(proj.tracks, { ...p.settings, style: 'jungle' }, 77, { steps: p.steps, res: p.res }, p.grids);
    expect(jungle[id]).not.toEqual(p.grids[id]);
    const locked = proj.tracks.map((t) => (t.id === id ? { ...t, lock: true } : t));
    const kept = generate(locked, { ...p.settings, style: 'jungle' }, 77, { steps: p.steps, res: p.res }, p.grids);
    expect(kept[id]![3]).toEqual({ vel: 99 });
  });

  it('copy and paste a region', () => {
    const { p, proj } = setup('breaks', 4);
    const ids = proj.tracks.map((t) => t.id);
    const clip = copyRegion(p, ids, 0, 3);
    pasteRegion(p, ids, 8, clip);
    for (const id of ids) expect(trackGrid(p, id).slice(8, 12)).toEqual(trackGrid(p, id).slice(0, 4));
  });

  it('mutation changes only target tracks and is seeded', () => {
    const { p, proj } = setup('breaks', 4);
    const ids = proj.tracks.map((t) => t.id);
    const a = mutate(p.grids, [ids[0]!], 4, new Rng(5), 0.6);
    const b = mutate(p.grids, [ids[0]!], 4, new Rng(5), 0.6);
    expect(a).toEqual(b);
    for (const id of ids.slice(1)) expect(a.grids[id]).toEqual(p.grids[id]);
  });
});
