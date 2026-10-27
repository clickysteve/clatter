/** CONDITIONAL TRIGGERS: evaluation, the pass counter, seeding, fills, previous step, sound interplay, offline rendering. */
import { describe, expect, it } from 'vitest';
import { bundledLibrary, lxrModule, presetProject, stats } from './helpers';
import { Sequence } from '../src/app/sequence';
import { renderProject } from '../src/audio/render';
import { Scheduler, type ScheduledEvent } from '../src/transport/scheduler';
import { hitOf, trackIndex } from '../src/app/soundConfig';
import { clone, PPQ, stepTicks, type Pattern, type Project, type TrigCond } from '../src/model/types';
import { defaultTrig, describeTrig, repairTrig, trigHolds, TRIG_KINDS, type TrigContext } from '../src/rhythm/trigger';
import { setStepTrig, setLength, setResolution, trigCount, shiftTrack, copyRegion, pasteRegion } from '../src/rhythm/pattern';
import { parseProject, serialize } from '../src/model/project';
import { exportMidi } from '../src/export/midiFile';

const ctx = (over: Partial<TrigContext> = {}): TrigContext => ({ seed: 7, pattern: 'p1', pass: 0, cycle: 0, last: false, fill: false, track: 't1', step: 0, prev: false, ...over });
const holdsOver = (c: TrigCond, passes: number, over: Partial<TrigContext> = {}) => Array.from({ length: passes }, (_, i) => trigHolds(c, ctx({ pass: i, cycle: i, ...over })));

/** A pattern of `steps` steps with only these hits (track → steps), nothing transforming, every track plain. */
function blank(p: Project, steps: number, hits: Record<string, number[]>): Pattern {
  const pat = p.patterns[0]!;
  p.patterns = [pat];
  p.current = pat.id;
  pat.steps = steps;
  pat.res = 4;
  pat.gen = {};
  pat.edits = {};
  delete pat.sounds;
  delete pat.trig;
  for (const t of p.tracks) {
    t.play = { density: 100, fill: 0, humanize: 0, chance: 100, length: 0 };
    pat.gen[t.id] = Array.from({ length: steps }, (_, i) => ((hits[t.id] ?? []).includes(i) ? { vel: 110 } : null));
  }
  p.destruction.chop.on = false;
  p.destruction.rolls.on = false;
  p.destruction.destroy.on = false;
  p.evolve.target = 'off';
  p.swing = 50;
  delete p.tempoAuto;
  return pat;
}

/** What plays in cycle k: "track|step" keys of the source events. */
function playedIn(seq: Sequence, k: number): string[] {
  const plan = seq.plan(k);
  return seq
    .events(k, plan.pattern)
    .filter((e) => e.kind === 'source')
    .map((e) => `${e.track}|${e.step}`)
    .sort();
}

async function project() {
  const lib = await bundledLibrary();
  return { lib, p: await presetProject('machine-room', lib) };
}

describe('trigger conditions', () => {
  it('ALWAYS plays every pass and is not stored', () => {
    expect(holdsOver({ k: 'always' }, 6).every(Boolean)).toBe(true);
    expect(repairTrig({ k: 'always' })).toBeNull();
    expect(repairTrig({ k: 'prob', p: 100 })).toBeNull();
    expect(describeTrig({ k: 'always' })).toBe('ALWAYS');
  });

  it('FIRST plays on the first pass only', () => {
    expect(holdsOver({ k: 'first' }, 5)).toEqual([true, false, false, false, false]);
  });

  it('ODD plays on passes 1, 3, 5 and EVEN on 2, 4, 6 (counting from one)', () => {
    expect(holdsOver({ k: 'odd' }, 6)).toEqual([true, false, true, false, true, false]);
    expect(holdsOver({ k: 'even' }, 6)).toEqual([false, true, false, true, false, true]);
  });

  it('EVERY N ON M plays on pass M of each N', () => {
    expect(holdsOver({ k: 'every', n: 4, at: 4 }, 9)).toEqual([false, false, false, true, false, false, false, true, false]);
    expect(holdsOver({ k: 'every', n: 3, at: 1 }, 7)).toEqual([true, false, false, true, false, false, true]);
  });

  it('ALTERNATING plays RUN passes, rests RUN passes, and repeats', () => {
    expect(holdsOver({ k: 'alt', run: 2 }, 8)).toEqual([true, true, false, false, true, true, false, false]);
    expect(holdsOver({ k: 'alt', run: 1 }, 4)).toEqual(holdsOver({ k: 'odd' }, 4));
  });

  it('LAST plays only when the end of the run is known', () => {
    expect(trigHolds({ k: 'last' }, ctx({ last: true }))).toBe(true);
    expect(trigHolds({ k: 'last' }, ctx({ last: false }))).toBe(false);
  });

  it('FILL and NOT FILL follow the held fill', () => {
    expect(trigHolds({ k: 'fill' }, ctx({ fill: true }))).toBe(true);
    expect(trigHolds({ k: 'fill' }, ctx({ fill: false }))).toBe(false);
    expect(trigHolds({ k: 'nofill' }, ctx({ fill: true }))).toBe(false);
    expect(trigHolds({ k: 'nofill' }, ctx({ fill: false }))).toBe(true);
  });

  it('PREVIOUS PLAYED and NOT PLAYED follow the step before', () => {
    expect(trigHolds({ k: 'prev' }, ctx({ prev: true }))).toBe(true);
    expect(trigHolds({ k: 'prev' }, ctx({ prev: false }))).toBe(false);
    expect(trigHolds({ k: 'noprev' }, ctx({ prev: true }))).toBe(false);
    expect(trigHolds({ k: 'noprev' }, ctx({ prev: false }))).toBe(true);
  });

  it('PROBABILITY is seeded: the same context always gives the same answer, and the rate is about right', () => {
    const c: TrigCond = { k: 'prob', p: 30 };
    const a = holdsOver(c, 600);
    expect(holdsOver(c, 600)).toEqual(a);
    const rate = a.filter(Boolean).length / a.length;
    expect(rate).toBeGreaterThan(0.24);
    expect(rate).toBeLessThan(0.36);
    expect(holdsOver(c, 600, { seed: 8 })).not.toEqual(a);
    expect(holdsOver(c, 600, { step: 3 })).not.toEqual(a);
    expect(holdsOver({ k: 'prob', p: 0 }, 50).some(Boolean)).toBe(false);
  });

  it('every kind has a default, a label, and survives repair', () => {
    for (const k of TRIG_KINDS) {
      const c = defaultTrig(k);
      expect(c.k).toBe(k);
      expect(describeTrig(c).length).toBeGreaterThan(0);
      const r = repairTrig(c);
      if (k !== 'always') expect(r).toEqual(c);
    }
    expect(repairTrig({ k: 'every', n: 99, at: 99 })).toEqual({ k: 'every', n: 16, at: 16 });
    expect(repairTrig({ k: 'bogus' })).toBeNull();
    expect(repairTrig('x')).toBeNull();
  });
});

describe('the pass counter', () => {
  it('counts passes of a repeating pattern from zero', async () => {
    const { p } = await project();
    const pat = blank(p, 16, { t1: [0, 4] });
    setStepTrig(pat, 't1', 4, { k: 'every', n: 3, at: 3 });
    const seq = new Sequence({ project: () => p });
    const got = [0, 1, 2, 3, 4, 5].map((k) => playedIn(seq, k).includes('t1|4'));
    expect(got).toEqual([false, false, true, false, false, true]);
    // a hit without a condition plays every pass
    expect([0, 1, 2].every((k) => playedIn(seq, k).includes('t1|0'))).toBe(true);
  });

  it('a different pattern starts at its own first pass, and so does returning to a pattern', async () => {
    const { p } = await project();
    const a = blank(p, 16, { t1: [0, 4] });
    const b = clone(a);
    b.id = 'p2';
    b.name = 'B';
    p.patterns.push(b);
    setStepTrig(a, 't1', 4, { k: 'first' });
    setStepTrig(b, 't1', 4, { k: 'first' });
    let queued: string | null = null;
    const played: string[][] = [];
    const seq = new Sequence({ project: () => p, takeQueued: () => { const q = queued; queued = null; return q; }, onPattern: (id) => (p.current = id) });
    played.push(playedIn(seq, 0)); // A, pass 0
    played.push(playedIn(seq, 1)); // A, pass 1
    queued = 'p2';
    played.push(playedIn(seq, 2)); // B, pass 0
    played.push(playedIn(seq, 3)); // B, pass 1
    queued = 'p1';
    played.push(playedIn(seq, 4)); // A again: pass 0
    const has = played.map((x) => x.includes('t1|4'));
    expect(has).toEqual([true, false, true, false, true]);
  });

  it('a chain counts repeats of an entry, then restarts for the next entry', async () => {
    const { p } = await project();
    const a = blank(p, 16, { t1: [0] });
    const b = clone(a);
    b.id = 'p2';
    p.patterns.push(b);
    setStepTrig(a, 't1', 0, { k: 'even' });
    setStepTrig(b, 't1', 0, { k: 'first' });
    p.chain = { on: true, entries: [{ pattern: 'p1', repeats: 3 }, { pattern: 'p2', repeats: 2 }] };
    const seq = new Sequence({ project: () => p });
    const got = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => playedIn(seq, k).length > 0);
    // A x3 (passes 1-3: even plays on pass 2), B x2 (first plays on its first), then A again from pass 1
    expect(got).toEqual([false, true, false, true, false, false, true, false]);
  });

  it('restarting playback restarts the count', async () => {
    const { p } = await project();
    const pat = blank(p, 16, { t1: [0] });
    setStepTrig(pat, 't1', 0, { k: 'first' });
    const seq = new Sequence({ project: () => p });
    expect(playedIn(seq, 0).length).toBe(1);
    expect(playedIn(seq, 1).length).toBe(0);
    seq.reset();
    expect(playedIn(seq, 0).length).toBe(1);
  });

  it('LAST plays on the final cycle of an export and never when the length is unknown', async () => {
    const { p } = await project();
    const pat = blank(p, 32, { t1: [0] });
    setStepTrig(pat, 't1', 0, { k: 'last' });
    const known = new Sequence({ project: () => p, lengthTicks: () => 8 * 4 * PPQ });
    const got = [0, 1, 2, 3].map((k) => playedIn(known, k).length > 0);
    expect(got).toEqual([false, false, false, true]);
    const live = new Sequence({ project: () => p });
    expect([0, 1, 2, 3].map((k) => playedIn(live, k).length)).toEqual([0, 0, 0, 0]);
    // 5 bars of a 2-bar pattern: the third (partial) cycle reaches the end
    const odd = new Sequence({ project: () => p, lengthTicks: () => 5 * 4 * PPQ });
    expect([0, 1, 2].map((k) => playedIn(odd, k).length > 0)).toEqual([false, false, true]);
  });
});

describe('probability, fills and the previous step in the realisation', () => {
  it('a probability condition is reproducible across sequences and varies across passes', async () => {
    const { p } = await project();
    const pat = blank(p, 16, { t1: [0, 4, 8, 12] });
    for (const s of [0, 4, 8, 12]) setStepTrig(pat, 't1', s, { k: 'prob', p: 50 });
    const run = () => {
      const seq = new Sequence({ project: () => p });
      return Array.from({ length: 24 }, (_, k) => playedIn(seq, k).join(','));
    };
    expect(run()).toEqual(run());
    expect(new Set(run()).size).toBeGreaterThan(4);
  });

  it('FILL ONLY plays while a fill is held for that track, NOT FILL while it is not', async () => {
    const { p } = await project();
    const pat = blank(p, 16, { t1: [0, 4] });
    setStepTrig(pat, 't1', 0, { k: 'fill' });
    setStepTrig(pat, 't1', 4, { k: 'nofill' });
    let fills = new Set<string>();
    const seq = new Sequence({ project: () => p, fills: () => fills });
    expect(playedIn(seq, 0)).toEqual(['t1|4']);
    fills = new Set(['t1']);
    seq.bump();
    expect(playedIn(seq, 0)).toEqual(['t1|0']);
    fills = new Set(['t2']);
    seq.bump();
    expect(playedIn(seq, 0)).toEqual(['t1|4']);
  });

  it('PREVIOUS PLAYED follows a step that did or did not play, within a pass and across passes', async () => {
    const { p } = await project();
    const pat = blank(p, 16, { t1: [3, 4, 5, 6, 15, 0] });
    setStepTrig(pat, 't1', 4, { k: 'prob', p: 0 }); // never plays
    setStepTrig(pat, 't1', 5, { k: 'prev' }); // so this never plays
    setStepTrig(pat, 't1', 6, { k: 'noprev' }); // step 5 did not play, so this does
    setStepTrig(pat, 't1', 0, { k: 'prev' }); // the last step of the pass before (step 15, always)
    const seq = new Sequence({ project: () => p });
    const first = playedIn(seq, 0);
    expect(first).toContain('t1|3');
    expect(first).not.toContain('t1|4');
    expect(first).not.toContain('t1|5');
    expect(first).toContain('t1|6');
    expect(first).not.toContain('t1|0'); // nothing before the first pass
    expect(playedIn(seq, 1)).toContain('t1|0'); // step 15 played in the pass before
  });

  it('a condition on an empty step does nothing, and a silent step marks the grid as silent by condition', async () => {
    const { p } = await project();
    const pat = blank(p, 16, { t1: [0] });
    setStepTrig(pat, 't1', 8, { k: 'odd' });
    setStepTrig(pat, 't1', 0, { k: 'even' });
    const seq = new Sequence({ project: () => p });
    expect(playedIn(seq, 0)).toEqual([]);
    const { CELL_CONDITION } = await import('../src/rhythm/realize');
    expect(seq.realization(0, pat.id).cells['t1']![0]! & CELL_CONDITION).toBe(CELL_CONDITION);
    expect(seq.realization(1, pat.id).cells['t1']![0]! & CELL_CONDITION).toBe(0);
  });

  it('the source view ignores conditions (SOURCE shows what is written)', async () => {
    const { p } = await project();
    const pat = blank(p, 16, { t1: [0] });
    setStepTrig(pat, 't1', 0, { k: 'even' });
    const seq = new Sequence({ project: () => p, sourceOnly: () => true });
    expect(playedIn(seq, 0)).toEqual(['t1|0']);
  });

  it('a project without conditions realises exactly as before', async () => {
    const { p } = await project();
    const a = new Sequence({ project: () => p });
    const q = clone(p);
    q.patterns.forEach((x) => delete x.trig);
    const b = new Sequence({ project: () => q });
    for (let k = 0; k < 6; k++) expect(JSON.stringify(b.events(k, b.plan(k).pattern))).toBe(JSON.stringify(a.events(k, a.plan(k).pattern)));
  });
});

describe('conditions and sound variations are independent', () => {
  it('a step that does not play triggers nothing; one that plays resolves its variation and locks', async () => {
    const { p } = await project();
    const pat = blank(p, 16, { t1: [0, 4] });
    pat.sounds = { t1: { 0: { v: 1 }, 4: { v: 2 } } };
    setStepTrig(pat, 't1', 0, { k: 'odd' });
    setStepTrig(pat, 't1', 4, { k: 'even' });
    p.tracks[0]!.sound.variations = [null, { name: 'B', params: {} }, { name: 'C', params: {} }, null];
    const idx = trackIndex(p);
    const hits: { cycle: number; mv: number }[] = [];
    let now = 0;
    const seq = new Sequence({ project: () => p });
    const sched = new Scheduler(seq, {
      now: () => now,
      startDelay: 0,
      lookahead: 0.05,
      emit: (evs: ScheduledEvent[]) => {
        for (const se of evs) {
          const h = hitOf(se, p, idx, sched.spt);
          if (h) hits.push({ cycle: se.cycle, mv: h.mv ?? 0 });
        }
      },
    });
    sched.bpm = 240;
    sched.start(0);
    while (now < 8 * 16 * stepTicks(4) * (60 / (240 * PPQ))) {
      now += 0.01;
      sched.pump();
    }
    // odd step 0 (variation B = 2) on passes 1, 3; even step 4 (variation C = 3) on passes 2, 4
    const byCycle = new Map<number, number[]>();
    for (const h of hits) byCycle.set(h.cycle, [...(byCycle.get(h.cycle) ?? []), h.mv]);
    expect(byCycle.get(0)).toEqual([2]);
    expect(byCycle.get(1)).toEqual([3]);
    expect(byCycle.get(2)).toEqual([2]);
    expect(byCycle.get(3)).toEqual([3]);
  });

  it('a conditional sound change on a step with a trigger condition still follows the sound clock', async () => {
    const { p } = await project();
    const pat = blank(p, 16, { t1: [0] });
    pat.sounds = { t1: { 0: { alt: { cond: { k: 'alt' }, v: 1 } } } };
    setStepTrig(pat, 't1', 0, { k: 'prob', p: 100 }); // 100 is "always": not stored
    p.tracks[0]!.sound.variations = [null, { name: 'B', params: {} }, null, null];
    const seq = new Sequence({ project: () => p });
    const idx = trackIndex(p);
    const mv = (k: number) => {
      const e = seq.events(k, seq.plan(k).pattern)[0]!;
      return hitOf({ time: 0, tick: 0, cycle: k, event: e }, p, idx, 0.001)!.mv;
    };
    expect([mv(0), mv(1), mv(2), mv(3)]).toEqual([0, 2, 0, 2]);
  });
});

describe('pattern editing keeps conditions with their steps', () => {
  it('lengthening repeats them, resizing the grid moves them, shifting rotates them, copy and paste carry them', async () => {
    const { p } = await project();
    const pat = blank(p, 8, { t1: [0, 4] });
    setStepTrig(pat, 't1', 4, { k: 'every', n: 2, at: 2 });
    setLength(pat, 16);
    expect(pat.trig?.t1?.[12]).toEqual({ k: 'every', n: 2, at: 2 });
    expect(trigCount(pat)).toBe(2);
    shiftTrack(pat, 't1', 1);
    expect(pat.trig?.t1?.[5]).toBeDefined();
    const ids = p.tracks.map((t) => t.id);
    const clip = copyRegion(pat, ids, 0, 15);
    expect(clip.trig?.[0]).toBeDefined();
    const q = blank(clone(p), 16, {});
    pasteRegion(q, ids, 0, clip);
    expect(q.trig?.t1?.[5]).toEqual({ k: 'every', n: 2, at: 2 });
    setResolution(pat, 8, ids);
    expect(Object.keys(pat.trig?.t1 ?? {}).sort()).toEqual(['10', '26']);
    setStepTrig(pat, 't1', 10, undefined);
    setStepTrig(pat, 't1', 26, { k: 'always' });
    expect(pat.trig).toBeUndefined();
  });
});

describe('projects and files', () => {
  it('conditions and the version survive a save and load; an older project loads unchanged', async () => {
    const { p } = await project();
    const pat = p.patterns[0]!;
    setStepTrig(pat, 't1', 3, { k: 'alt', run: 3 });
    setStepTrig(pat, 't2', 4, { k: 'noprev' });
    const back = parseProject(serialize(p));
    expect(back.version).toBe(7);
    expect(back.patterns[0]!.trig).toEqual(pat.trig);
    const old = JSON.parse(serialize(p));
    old.version = 3;
    delete old.patterns[0].trig;
    const loaded = parseProject(JSON.stringify(old));
    expect(loaded.patterns[0]!.trig).toBeUndefined();
    expect(loaded.version).toBe(7);
    // damaged entries are dropped, steps beyond the pattern too
    old.patterns[0].trig = { t1: { 2: { k: 'bogus' }, 3: { k: 'prob', p: 40 }, 9999: { k: 'odd' } }, nope: { 1: { k: 'odd' } } };
    expect(parseProject(JSON.stringify(old)).patterns[0]!.trig).toEqual({ t1: { 3: { k: 'prob', p: 40 } } });
  });
});

describe('offline export evaluates every cycle', () => {
  it('eight bars of a two-bar pattern are four independent cycles: odd and even steps alternate in the audio', async () => {
    const { lib, p } = await project();
    p.tempo = 120;
    const pat = blank(p, 32, { t1: [0], t2: [16, 24] });
    setStepTrig(pat, 't2', 16, { k: 'even' }); // the snare on bar 2 beat 1: cycles 2 and 4
    setStepTrig(pat, 't2', 24, { k: 'odd' }); // the snare on bar 2 beat 3: cycles 1 and 3
    const r = await renderProject(lxrModule(), p, lib, { bars: 8, tail: 0, stems: true });
    const snare = r.stems['t2']![0]!;
    const rate = r.rate;
    const rms = (from: number, len = 0.35) => stats(snare.subarray(Math.round(from * rate), Math.round((from + len) * rate))).rms;
    const cycle = 4; // seconds: two bars at 120 BPM
    const at = (c: number, step: number) => rms(c * cycle + (step * 0.125));
    // step 16 is 2.0 s into a cycle, step 24 is 3.0 s
    expect(at(0, 16)).toBeLessThan(1e-4);
    expect(at(1, 16)).toBeGreaterThan(0.005);
    expect(at(2, 16)).toBeLessThan(1e-4);
    expect(at(3, 16)).toBeGreaterThan(0.005);
    expect(at(0, 24)).toBeGreaterThan(0.005);
    expect(at(1, 24)).toBeLessThan(1e-4);
    expect(at(2, 24)).toBeGreaterThan(0.005);
    expect(at(3, 24)).toBeLessThan(1e-4);
    // the cycles are not copies of each other: the loudness profile of cycles 1 and 3 (same steps) is far closer than 0 and 1
    const profile = (c: number) => Array.from({ length: 16 }, (_, w) => rms(c * cycle + w * 0.25, 0.25));
    const dist = (a: number[], b: number[]) => a.reduce((t, v, i) => t + Math.abs(v - b[i]!), 0);
    expect(dist(profile(0), profile(1))).toBeGreaterThan(0.01);
    expect(dist(profile(1), profile(3))).toBeLessThan(dist(profile(0), profile(1)) * 0.5);
    expect(dist(profile(0), profile(2))).toBeLessThan(dist(profile(0), profile(1)) * 0.5);
  });

  it('LAST CYCLE plays only the final cycle of the export, FIRST only the first', async () => {
    const { lib, p } = await project();
    p.tempo = 120;
    const pat = blank(p, 32, { t1: [0], t2: [0] });
    setStepTrig(pat, 't1', 0, { k: 'first' });
    setStepTrig(pat, 't2', 0, { k: 'last' });
    const r = await renderProject(lxrModule(), p, lib, { bars: 8, tail: 0, stems: true });
    const band = (id: string, c: number) => stats(r.stems[id]![0]!.subarray(Math.round(c * 4 * r.rate), Math.round((c * 4 + 0.35) * r.rate))).rms;
    expect([0, 1, 2, 3].map((c) => band('t1', c) > 0.005)).toEqual([true, false, false, false]);
    expect([0, 1, 2, 3].map((c) => band('t2', c) > 0.005)).toEqual([false, false, false, true]);
  });

  it('probability renders identically every time', async () => {
    const { lib, p } = await project();
    const pat = blank(p, 16, { t1: [0, 4, 8, 12], t2: [4, 12] });
    for (const s of [0, 4, 8, 12]) setStepTrig(pat, 't1', s, { k: 'prob', p: 50 });
    const a = await renderProject(lxrModule(), p, lib, { bars: 8, tail: 0 });
    const b = await renderProject(lxrModule(), p, lib, { bars: 8, tail: 0 });
    expect(Buffer.from(a.master[0]!.buffer, a.master[0]!.byteOffset, a.master[0]!.byteLength).equals(Buffer.from(b.master[0]!.buffer, b.master[0]!.byteOffset, b.master[0]!.byteLength))).toBe(true);
    // a different project seed makes different choices
    const c = clone(p);
    c.seed = p.seed + 12345;
    const d = await renderProject(lxrModule(), c, lib, { bars: 8, tail: 0 });
    expect(Buffer.from(a.master[0]!.buffer, a.master[0]!.byteOffset, a.master[0]!.byteLength).equals(Buffer.from(d.master[0]!.buffer, d.master[0]!.byteOffset, d.master[0]!.byteLength))).toBe(false);
  });

  it('the MIDI file carries the conditions too', async () => {
    const { p } = await project();
    const pat = blank(p, 16, { t1: [0, 8] });
    setStepTrig(pat, 't1', 8, { k: 'even' });
    const notes = (bytes: Uint8Array) => {
      let n = 0;
      for (let i = 0; i < bytes.length - 2; i++) if ((bytes[i]! & 0xf0) === 0x90 && bytes[i + 2]! > 0 && bytes[i + 1] === p.tracks[0]!.midi.note) n++;
      return n;
    };
    // 4 bars = 4 passes of a one-bar pattern: step 0 four times, step 8 on the two even passes
    expect(notes(exportMidi(p, { bars: 4 }))).toBe(6);
  });
});
