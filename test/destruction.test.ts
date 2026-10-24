/** DESTRUCTION: CHOP, ROLLS, DESTROY, WILDCARD-free layering, edit preservation. */
import { describe, expect, it } from 'vitest';
import { defaultGen, generate } from '../src/rhythm/generate';
import { realize, type RealizeInput } from '../src/rhythm/realize';
import { newPattern, setHit } from '../src/rhythm/pattern';
import { defaultProject } from '../src/model/defaults';
import { clone, type DestructionSettings } from '../src/model/types';

function setup(style = 'breaks', seed = 21) {
  const proj = defaultProject();
  const gen = { ...defaultGen(), style };
  const p = newPattern('p1', 'A', gen);
  p.gen = generate(proj.tracks, gen, seed, { steps: p.steps, res: p.res });
  const input: RealizeInput = { seed: 3, swing: 50, pattern: p, tracks: proj.tracks, destruction: clone(proj.destruction), evolve: proj.evolve };
  return { proj, p, input };
}
const sig = (evs: { track: string; tick: number; vel: number }[]) => evs.map((e) => `${e.track}@${e.tick.toFixed(2)}:${e.vel}`).join(',');
const with_ = (input: RealizeInput, f: (d: DestructionSettings) => void): RealizeInput => {
  const d = clone(input.destruction);
  f(d);
  return { ...input, destruction: d };
};

describe('CHOP', () => {
  it('off (or amount 0) gives the source exactly', () => {
    const { input } = setup();
    const base = realize(input, 0).events;
    expect(sig(realize(with_(input, (d) => (d.chop.amount = 0, d.chop.on = true)), 0).events)).toBe(sig(base));
  });
  it('rearranges the pattern, reproducibly, and RE-CHOP draws again', () => {
    const { input } = setup();
    const base = sig(realize(input, 0).events);
    const on = with_(input, (d) => Object.assign(d.chop, { on: true, amount: 0.9 }));
    const a = realize(on, 0);
    expect(sig(a.events)).not.toBe(base);
    expect(sig(realize(on, 0).events)).toBe(sig(a.events));
    expect(a.reports.chop.edited).toBeGreaterThan(0);
    const next = with_(on, (d) => (d.chop.take = 1));
    expect(sig(realize(next, 0).events)).not.toBe(sig(a.events));
    // the first slice is never edited
    const T = 24;
    const first = (evs: typeof a.events) => sig(evs.filter((e) => e.tick < 4 * T && e.kind !== 'retrig'));
    expect(first(a.events)).toBe(first(realize(input, 0).events));
  });
});

describe('ROLLS', () => {
  it('adds retriggers before target hits without moving any source hit', () => {
    const { input } = setup();
    const on = with_(input, (d) => Object.assign(d.rolls, { on: true, prob: 1, place: 'anywhere', length: 4 }));
    const base = realize(input, 0).events;
    const r = realize(on, 0);
    expect(r.reports.rolls.rolls).toBeGreaterThan(0);
    const rollEvents = r.events.filter((e) => e.kind === 'roll');
    expect(rollEvents.length).toBe(r.reports.rolls.strokes);
    // every source event is still there, unchanged
    const src = r.events.filter((e) => e.kind !== 'roll');
    expect(sig(src)).toBe(sig(base));
    // at most two rolls a bar
    expect(r.reports.rolls.rolls).toBeLessThanOrEqual(2 * 2);
  });
  it('raising the probability only adds rolls', () => {
    const { input } = setup('jungle', 4);
    const lo = realize(with_(input, (d) => Object.assign(d.rolls, { on: true, prob: 0.3, place: 'anywhere' })), 0).events.filter((e) => e.kind === 'roll');
    const hi = realize(with_(input, (d) => Object.assign(d.rolls, { on: true, prob: 0.8, place: 'anywhere' })), 0).events.filter((e) => e.kind === 'roll');
    expect(hi.length).toBeGreaterThanOrEqual(lo.length);
  });
});

describe('DESTROY', () => {
  it('destroys hits (stutter, pitch, gate, crush, reverse, skip) and RE-DESTROY draws again', () => {
    const { input } = setup('machine', 5);
    const on = with_(input, (d) => Object.assign(d.destroy, { on: true, amount: 1, stutter: 0.6, pitch: 0.6, gate: 0.6, crush: 0.6, reverse: 0.6, skip: 0.2 }));
    const r = realize(on, 0);
    const c = r.reports.destroy.counts;
    expect(c.stutter + c.pitch + c.gate + c.crush + c.reverse + c.skip).toBeGreaterThan(5);
    expect(r.events.some((e) => e.kind === 'stutter')).toBe(true);
    expect(r.events.some((e) => e.gate)).toBe(true);
    expect(r.events.some((e) => e.crush)).toBe(true);
    expect(sig(realize(with_(on, (d) => (d.destroy.take = 9)), 0).events)).not.toBe(sig(r.events));
  });
  it('never destroys hand-edited hits', () => {
    const { input, p, proj } = setup('machine', 5);
    const id = proj.tracks[0]!.id;
    for (let i = 0; i < p.steps; i++) setHit(p, id, i, { vel: 3 }); // a velocity the generator never writes, so every cell is an edit
    const on = with_(input, (d) => Object.assign(d.destroy, { on: true, amount: 1, skip: 1, pitch: 1, gate: 1, stutter: 1 }));
    const mine = realize(on, 0).events.filter((e) => e.track === id && e.kind === 'source');
    expect(mine.length).toBe(p.steps);
    for (const e of mine) {
      expect(e.destroyed).toBeFalsy();
      expect(e.pitch).toBe(0);
    }
  });
  it('switching every layer off returns the source exactly (non-destructive)', () => {
    const { input } = setup();
    const all = with_(input, (d) => {
      Object.assign(d.chop, { on: true, amount: 1 });
      Object.assign(d.rolls, { on: true, prob: 1 });
      Object.assign(d.destroy, { on: true, amount: 1 });
    });
    expect(sig(realize(all, 0).events)).not.toBe(sig(realize(input, 0).events));
    const off = with_(all, (d) => {
      d.chop.on = false;
      d.rolls.on = false;
      d.destroy.on = false;
    });
    expect(sig(realize(off, 0).events)).toBe(sig(realize(input, 0).events));
  });
});
