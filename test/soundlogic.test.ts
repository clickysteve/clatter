/** Step sounds: resolution order, conditions on the musical clock, generation, persistence, export. */
import { describe, expect, it } from 'vitest';
import { bundledLibrary, lxrModule, newLxr, presetProject, stats } from './helpers';
import { defaultProject } from '../src/model/defaults';
import { clone, type Grid, type Project, type SoundCond, type StepSound, type TrackSound } from '../src/model/types';
import { PAR } from '../src/sound/lxrParamIds';
import { condHolds, repairStepSound, resolveStepSound, triangle, type SoundContext } from '../src/sound/stepSound';
import { addEvolution, clearEvolution, distributeSounds, generateVariations, handMade, mutateSounds, roleClass } from '../src/sound/soundgen';
import { readKit } from '../src/sound/kitcheck';
import { parseProject, repairProject, serialize } from '../src/model/project';
import { copyRegion, pasteRegion, setLength, setStepSound, shiftTrack, soundCount, stepSoundAt } from '../src/rhythm/pattern';
import { renderProject } from '../src/audio/render';
import { hitOf, trackIndex } from '../src/app/soundConfig';
import { realize } from '../src/rhythm/realize';
import { Scheduler } from '../src/transport/scheduler';
import { Sequence } from '../src/app/sequence';

const kitParams = readKit(newLxr(1)).params;
const kit = (p: number) => kitParams[p] ?? 0;
const sound = (over: Partial<TrackSound> = {}): TrackSound => ({ ...defaultProject().tracks[0]!.sound, ...over });
const ctx = (over: Partial<SoundContext> = {}): SoundContext => ({ seed: 1, cycle: 0, fill: false, track: 't1', step: 0, ...over });
const NO_LOCKS = { voices: [false, false, false, false, false, false], params: [] as number[] };

describe('resolution order: kit → variation → step locks → rules', () => {
  const s = sound({ variations: [{ name: 'A', params: { [PAR.VELOD1]: 30, [PAR.DRIVE1]: 90 } }, null, null, null] });
  it('a step without a sound changes nothing', () => {
    const r = resolveStepSound(s, undefined, kit, ctx());
    expect(r.params).toEqual([]);
    expect(r.trig).toBe(0);
  });
  it('the variation is sparse: only its parameters are set', () => {
    const r = resolveStepSound(s, { v: 0 }, kit, ctx());
    expect(Object.fromEntries(pairs(r.params))).toEqual({ [PAR.VELOD1]: 30, [PAR.DRIVE1]: 90 });
  });
  it('step locks win over the variation, rules win over locks', () => {
    const r1 = resolveStepSound(s, { v: 0, locks: { [PAR.VELOD1]: 70 } }, kit, ctx());
    expect(Object.fromEntries(pairs(r1.params))[PAR.VELOD1]).toBe(70);
    const r2 = resolveStepSound(s, { v: 0, locks: { [PAR.VELOD1]: 70 }, rules: [{ p: PAR.VELOD1, op: 'set', a: 15, b: 0, cond: { k: 'always' } }] }, kit, ctx());
    expect(Object.fromEntries(pairs(r2.params))[PAR.VELOD1]).toBe(15);
  });
  it('add starts from the layer below, not just the kit', () => {
    const r = resolveStepSound(s, { v: 0, rules: [{ p: PAR.DRIVE1, op: 'add', a: 20, b: 0, cond: { k: 'always' } }] }, kit, ctx());
    expect(Object.fromEntries(pairs(r.params))[PAR.DRIVE1]).toBe(110);
    const k = resolveStepSound(s, { rules: [{ p: PAR.DRIVE1, op: 'add', a: 20, b: 0, cond: { k: 'always' } }] }, kit, ctx());
    expect(Object.fromEntries(pairs(k.params))[PAR.DRIVE1]).toBe(kit(PAR.DRIVE1) + 20);
  });
  it('values are clamped to the parameter and parameters of other voices are ignored', () => {
    const r = resolveStepSound(s, { locks: { [PAR.VELOD1]: 400, [PAR.VELOD4]: 50, [PAR.OSC_WAVE_DRUM1]: 99 } }, kit, ctx());
    const m = Object.fromEntries(pairs(r.params));
    expect(m[PAR.VELOD1]).toBe(127);
    expect(m[PAR.VELOD4]).toBeUndefined();
    expect(m[PAR.OSC_WAVE_DRUM1]).toBe(5); // a menu: last choice
  });
  it('a step voice switch resolves its locks against the voice that plays', () => {
    const r = resolveStepSound(s, { voice: 3, locks: { [PAR.VELOD4]: 40, [PAR.VELOD1]: 40 } }, kit, ctx());
    expect(r.trig).toBe(3);
    expect(r.switched).toBe(true);
    expect(Object.fromEntries(pairs(r.params))).toEqual({ [PAR.VELOD4]: 40 });
  });
  it('an empty variation slot plays the base sound', () => {
    expect(resolveStepSound(s, { v: 2 }, kit, ctx()).params).toEqual([]);
  });
});

function pairs(flat: number[]): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < flat.length; i += 2) out.push([flat[i]!, flat[i + 1]!]);
  return out;
}

describe('conditions are evaluated on the musical clock', () => {
  const at = (c: SoundCond, cycles: number[], over: Partial<SoundContext> = {}) => cycles.map((k) => condHolds(c, ctx({ cycle: k, ...over })));
  it('ALWAYS', () => expect(at({ k: 'always' }, [0, 1, 2])).toEqual([true, true, true]));
  it('EVERY N is the Nth pass of each run of N', () => {
    expect(at({ k: 'every', n: 4 }, [0, 1, 2, 3, 4, 5, 6, 7])).toEqual([false, false, false, true, false, false, false, true]);
    expect(at({ k: 'every', n: 1 }, [0, 1])).toEqual([true, true]);
  });
  it('FIRST OF N and LAST OF N', () => {
    expect(at({ k: 'first', n: 3 }, [0, 1, 2, 3, 4, 5])).toEqual([true, false, false, true, false, false]);
    expect(at({ k: 'last', n: 3 }, [0, 1, 2, 3, 4, 5])).toEqual([false, false, true, false, false, true]);
  });
  it('ALTERNATE', () => expect(at({ k: 'alt' }, [0, 1, 2, 3])).toEqual([false, true, false, true]));
  it('FILL follows the fill state only', () => {
    expect(condHolds({ k: 'fill' }, ctx({ fill: true }))).toBe(true);
    expect(condHolds({ k: 'fill' }, ctx({ fill: false }))).toBe(false);
  });
  it('PROBABILITY is seeded: the same pass always gives the same answer, and the share is right', () => {
    const c: SoundCond = { k: 'prob', p: 25 };
    const a = Array.from({ length: 2000 }, (_, k) => condHolds(c, ctx({ cycle: k })));
    const b = Array.from({ length: 2000 }, (_, k) => condHolds(c, ctx({ cycle: k })));
    expect(a).toEqual(b);
    const share = a.filter(Boolean).length / a.length;
    expect(share).toBeGreaterThan(0.2);
    expect(share).toBeLessThan(0.3);
    expect(condHolds({ k: 'prob', p: 0 }, ctx())).toBe(false);
    expect(condHolds({ k: 'prob', p: 100 }, ctx())).toBe(true);
    const other = Array.from({ length: 2000 }, (_, k) => condHolds(c, ctx({ cycle: k, seed: 2 })));
    expect(other).not.toEqual(a);
  });
  it('a conditional variation switches only on its passes', () => {
    const s = sound({ variations: [{ name: 'A', params: { [PAR.VELOD1]: 20 } }, { name: 'B', params: { [PAR.VELOD1]: 100 } }, null, null] });
    const ss: StepSound = { v: 0, alt: { cond: { k: 'every', n: 4 }, v: 1 } };
    const decay = (k: number) => Object.fromEntries(pairs(resolveStepSound(s, ss, kit, ctx({ cycle: k })).params))[PAR.VELOD1];
    expect([0, 1, 2, 3, 4, 7].map(decay)).toEqual([20, 20, 20, 100, 20, 100]);
    const toBase: StepSound = { v: 0, alt: { cond: { k: 'alt' }, v: null } };
    expect(resolveStepSound(s, toBase, kit, ctx({ cycle: 1 })).params).toEqual([]);
    expect(resolveStepSound(s, toBase, kit, ctx({ cycle: 0 })).params.length).toBe(2);
  });
  it('RANDOM RANGE stays in range, changes between passes, and repeats for a seed', () => {
    const ss: StepSound = { rules: [{ p: PAR.VELOD1, op: 'range', a: 40, b: 80, cond: { k: 'always' } }] };
    const vals = Array.from({ length: 50 }, (_, k) => Object.fromEntries(pairs(resolveStepSound(sound(), ss, kit, ctx({ cycle: k })).params))[PAR.VELOD1]!);
    expect(Math.min(...vals)).toBeGreaterThanOrEqual(40);
    expect(Math.max(...vals)).toBeLessThanOrEqual(80);
    expect(new Set(vals).size).toBeGreaterThan(10);
    const again = Array.from({ length: 50 }, (_, k) => Object.fromEntries(pairs(resolveStepSound(sound(), ss, kit, ctx({ cycle: k })).params))[PAR.VELOD1]!);
    expect(again).toEqual(vals);
  });
  it('ALTERNATE values and EVOLVE: bounded, periodic, back at the start', () => {
    const alt: StepSound = { rules: [{ p: PAR.FILTER_FREQ_1, op: 'alt', a: 40, b: 100, cond: { k: 'always' } }] };
    expect([0, 1, 2].map((k) => resolveStepSound(sound(), alt, kit, ctx({ cycle: k })).params[1])).toEqual([40, 100, 40]);
    const ev: StepSound = { rules: [{ p: PAR.FMAMNT1, op: 'evolve', a: 0, b: 40, n: 8, cond: { k: 'always' } }] };
    const v = (k: number) => resolveStepSound(sound(), ev, kit, ctx({ cycle: k })).params[1]!;
    expect(v(0)).toBe(kit(PAR.FMAMNT1));
    expect(v(8)).toBe(kit(PAR.FMAMNT1) + 40);
    expect(v(16)).toBe(v(0));
    for (let k = 0; k < 40; k++) expect(v(k)).toBeGreaterThanOrEqual(kit(PAR.FMAMNT1));
    expect(triangle(4, 8)).toBe(0.5);
    expect(triangle(12, 8)).toBe(0.5);
  });
  it('a rule only applies when its condition holds', () => {
    const ss: StepSound = { rules: [{ p: PAR.DRIVE1, op: 'add', a: 30, b: 0, cond: { k: 'fill' } }] };
    expect(resolveStepSound(sound(), ss, kit, ctx({ fill: false })).params).toEqual([]);
    expect(resolveStepSound(sound(), ss, kit, ctx({ fill: true })).params).toEqual([PAR.DRIVE1, kit(PAR.DRIVE1) + 30]);
  });
});

describe('generated variations (checked in the real engine)', () => {
  const roles: [string, number, string][] = [['kick', 0, 'kick'], ['snare', 3, 'snare'], ['chat', 5, 'hat'], ['cymbal', 4, 'cymbal'], ['perc', 2, 'perc']];
  function peakOf(trig: number, params: Record<number, number>, base: readonly number[]): { peak: number; finite: boolean; tail: number } {
    const e = newLxr(3);
    for (let p = 1; p < base.length; p++) e.setParam(p, base[p]!);
    for (const [k, v] of Object.entries(params)) e.setParam(Number(k), v);
    e.trigger(trig, 110, 60);
    const v = trig >= 5 ? 5 : trig;
    let peak = 0;
    let finite = true;
    let tail = 0;
    for (let b = 0; b < 400; b++) {
      e.render();
      for (let i = 0; i < e.block; i++) {
        const x = Math.abs(e.out[e.offset(v, 0) + i]!);
        if (!Number.isFinite(x)) finite = false;
        if (x > peak) peak = x;
        if (b < 8) tail = Math.max(tail, x);
      }
    }
    return { peak, finite, tail };
  }
  it.each(roles)('%s: four related variations that differ from the base, stay in range and sound', (role, trig) => {
    const s = sound({ trigger: trig });
    for (const amount of [0.25, 0.6, 1]) {
      const vs = generateVariations(s, role, kitParams, { seed: 11, amount, locks: NO_LOCKS });
      expect(vs.filter(Boolean).length).toBe(4);
      const names = new Set(vs.map((v) => v!.name));
      expect(names.size).toBeGreaterThanOrEqual(3);
      for (const v of vs) {
        expect(Object.keys(v!.params).length).toBeGreaterThan(0);
        expect(v!.gen).toBe(true);
        for (const [k, val] of Object.entries(v!.params)) {
          expect(val).toBeGreaterThanOrEqual(0);
          expect(val).toBeLessThanOrEqual(127);
          expect(val).not.toBe(kitParams[Number(k)]);
        }
        const r = peakOf(trig, v!.params, kitParams);
        expect(r.finite).toBe(true);
        expect(r.peak, `${role} ${v!.name} @${amount}`).toBeGreaterThan(0.02);
        expect(r.peak).toBeLessThan(1.2);
      }
    }
  });
  it('different voice types get different strategies', () => {
    const names = (role: string, trig: number) => generateVariations(sound({ trigger: trig }), role, kitParams, { seed: 1, amount: 0.5, locks: NO_LOCKS }).map((v) => v!.name).sort();
    expect(names('kick', 0)).toEqual(['DEEP', 'DIRTY', 'FM', 'PUNCH']);
    expect(names('chat', 5)).toEqual(['BRIGHT', 'GRIT', 'METAL', 'TIGHT']);
    expect(names('snare', 3)).not.toEqual(names('kick', 0));
  });
  it('is reproducible for a seed and differs between seeds', () => {
    const a = generateVariations(sound(), 'kick', kitParams, { seed: 5, amount: 0.7, locks: NO_LOCKS });
    expect(generateVariations(sound(), 'kick', kitParams, { seed: 5, amount: 0.7, locks: NO_LOCKS })).toEqual(a);
    expect(generateVariations(sound(), 'kick', kitParams, { seed: 6, amount: 0.7, locks: NO_LOCKS })).not.toEqual(a);
  });
  it('higher TIMBRE moves parameters further', () => {
    const dist = (amount: number) => {
      const vs = generateVariations(sound(), 'kick', kitParams, { seed: 5, amount, locks: NO_LOCKS });
      return vs.reduce((a, v) => a + Object.entries(v!.params).reduce((b, [k, x]) => b + Math.abs(x - kitParams[Number(k)]!), 0), 0);
    };
    expect(dist(0.2)).toBeLessThan(dist(0.6));
    expect(dist(0.6)).toBeLessThan(dist(1));
  });
  it('respects locked parameters, locked voices, locked tracks, locked and hand-made slots', () => {
    const base = generateVariations(sound(), 'kick', kitParams, { seed: 1, amount: 0.8, locks: NO_LOCKS });
    const lockedParam = Number(Object.keys(base[0]!.params)[0]);
    const withLock = generateVariations(sound(), 'kick', kitParams, { seed: 1, amount: 0.8, locks: { ...NO_LOCKS, params: [lockedParam] } });
    for (const v of withLock) expect(v!.params[lockedParam]).toBeUndefined();
    expect(generateVariations(sound(), 'kick', kitParams, { seed: 1, amount: 0.8, locks: { ...NO_LOCKS, voices: [true, false, false, false, false, false] } }).every((v) => v === null)).toBe(true);
    expect(generateVariations(sound({ soundLock: true }), 'kick', kitParams, { seed: 1, amount: 0.8, locks: NO_LOCKS }).every((v) => v === null)).toBe(true);
    const mine = { name: 'MINE', params: { [PAR.VELOD1]: 99 } };
    const mixed = generateVariations(sound({ variations: [mine, { ...base[1]!, lock: true }, null, null] }), 'kick', kitParams, { seed: 9, amount: 0.8, locks: NO_LOCKS });
    expect(mixed[0]).toEqual(mine);
    expect(mixed[1]!.params).toEqual(base[1]!.params);
    expect(mixed[2]).not.toBeNull();
    // force replaces hand-made slots but never locked ones
    const forced = generateVariations(sound({ variations: [mine, { ...base[1]!, lock: true }, null, null] }), 'kick', kitParams, { seed: 9, amount: 0.8, locks: NO_LOCKS, force: true });
    expect(forced[0]).not.toEqual(mine);
    expect(forced[1]!.params).toEqual(base[1]!.params);
  });
  it('a SAMPLE track gets sample-layer variations, not LXR parameters', () => {
    const s = sound({ mode: 'sample', samples: ['a', 'b'] });
    const vs = generateVariations(s, 'perc', kitParams, { seed: 2, amount: 0.6, locks: NO_LOCKS });
    for (const v of vs) {
      expect(v!.params).toEqual({});
      expect(v!.sample).toBeDefined();
    }
  });
});

describe('distributing sounds over a pattern', () => {
  const steps = 32;
  const grid = (every: number, vel = 100): Grid => Array.from({ length: steps }, (_, i) => (i % every === 0 ? { vel: i % 8 === 0 ? 120 : vel } : null));
  const dist = { steps, perBeat: 4, perBar: 16, take: 0, seed: 3, locks: NO_LOCKS };
  const withVars = (role: string, trig: number) => sound({ trigger: trig, variations: generateVariations(sound({ trigger: trig }), role, kitParams, { seed: 3, amount: 0.7, locks: NO_LOCKS }) });

  it('TIMBRE 0 assigns nothing; more TIMBRE assigns more', () => {
    const s = withVars('chat', 5);
    const g = grid(2);
    const n = (amount: number) => Object.keys(distributeSounds(s, 'chat', g, undefined, kitParams, { ...dist, amount })).length;
    expect(n(0)).toBe(0);
    expect(n(0.3)).toBeGreaterThan(0);
    expect(n(0.3)).toBeLessThanOrEqual(n(0.7));
    expect(n(0.7)).toBeLessThanOrEqual(n(1) + 4);
  });
  it('only hits get sounds; the variations come from the filled slots', () => {
    const s = withVars('perc', 2);
    const g = grid(3);
    const out = distributeSounds(s, 'perc', g, undefined, kitParams, { ...dist, amount: 0.8 });
    for (const [k, ss] of Object.entries(out)) {
      expect(g[Number(k)]).not.toBeNull();
      expect(ss.gen).toBe(true);
      if (ss.v !== undefined) expect(s.variations![ss.v]).not.toBeNull();
    }
  });
  it('a kick keeps its sound on the downbeats; a hat varies on more steps than a kick', () => {
    const k = withVars('kick', 0);
    const h = withVars('chat', 5);
    const gk = grid(4);
    const gh = grid(2);
    let kickDown = 0;
    let kickOff = 0;
    for (let take = 0; take < 20; take++) {
      const out = distributeSounds(k, 'kick', gk, undefined, kitParams, { ...dist, take, amount: 0.7 });
      kickDown += [0, 16].filter((i) => out[i]?.v !== undefined).length;
      kickOff += Object.entries(out).filter(([i, s]) => Number(i) % 16 !== 0 && s.v !== undefined).length;
    }
    expect(kickDown).toBeLessThan(kickOff / 4);
    expect(roleClass('kick')).toBe('steady');
    expect(roleClass('chat')).toBe('busy');
    expect(roleClass('perc')).toBe('free');
    const hat = Object.keys(distributeSounds(h, 'chat', gh, undefined, kitParams, { ...dist, amount: 0.7 })).length / gh.filter(Boolean).length;
    const kick = Object.keys(distributeSounds(k, 'kick', gk, undefined, kitParams, { ...dist, amount: 0.7 })).length / gk.filter(Boolean).length;
    expect(hat).toBeGreaterThan(kick);
  });
  it('is deterministic for a seed and take; a new take gives a different draw', () => {
    const s = withVars('perc', 2);
    const a = distributeSounds(s, 'perc', grid(2), undefined, kitParams, { ...dist, amount: 0.8 });
    expect(distributeSounds(s, 'perc', grid(2), undefined, kitParams, { ...dist, amount: 0.8 })).toEqual(a);
    expect(distributeSounds(s, 'perc', grid(2), undefined, kitParams, { ...dist, amount: 0.8, take: 1 })).not.toEqual(a);
  });
  it('keeps hand-made step sounds, and replaces generated ones', () => {
    const s = withVars('perc', 2);
    const mine: StepSound = { locks: { [PAR.VELOD3]: 33 } };
    const old: StepSound = { v: 0, gen: true };
    const out = distributeSounds(s, 'perc', grid(2), { 4: mine, 6: old }, kitParams, { ...dist, amount: 0.8 });
    expect(out[4]).toEqual(mine);
    expect(handMade(out[6])).toBe(false);
  });
  it('a region leaves everything outside it as it was', () => {
    const s = withVars('perc', 2);
    const before: Record<number, StepSound> = { 2: { v: 1, gen: true }, 20: { v: 2, gen: true } };
    const out = distributeSounds(s, 'perc', grid(2), before, kitParams, { ...dist, amount: 1, region: [8, 15] });
    expect(out[2]).toEqual(before[2]);
    expect(out[20]).toEqual(before[20]);
    expect(Object.keys(out).map(Number).some((i) => i >= 8 && i <= 15)).toBe(true);
  });
  it('a locked track or voice is left alone', () => {
    const s = withVars('perc', 2);
    expect(distributeSounds({ ...s, soundLock: true }, 'perc', grid(2), undefined, kitParams, { ...dist, amount: 1 })).toEqual({});
    expect(distributeSounds(s, 'perc', grid(2), undefined, kitParams, { ...dist, amount: 1, locks: { ...NO_LOCKS, voices: [false, false, true, false, false, false] } })).toEqual({});
  });
  it('locked parameters never appear in generated locks', () => {
    const s = withVars('perc', 2);
    const locked = [PAR.VELOD3, PAR.COARSE3, PAR.FILTER_FREQ_3, PAR.FMAMNT3, PAR.MODAMNT3, PAR.DRIVE3];
    for (let take = 0; take < 10; take++) {
      const out = distributeSounds(s, 'perc', grid(1), undefined, kitParams, { ...dist, take, amount: 1, locks: { ...NO_LOCKS, params: locked } });
      for (const ss of Object.values(out)) {
        for (const p of Object.keys(ss.locks ?? {})) expect(locked).not.toContain(Number(p));
        for (const r of ss.rules ?? []) expect(locked).not.toContain(r.p);
      }
    }
  });
  it('MUTATE SOUND changes some generated steps, never hand-made ones or the rhythm', () => {
    const s = withVars('perc', 2);
    const g = grid(2);
    const mine: StepSound = { v: 3 };
    const first = distributeSounds(s, 'perc', g, { 0: mine }, kitParams, { ...dist, amount: 0.8 });
    const out = mutateSounds(s, 'perc', g, first, kitParams, { ...dist, amount: 0.6, take: 1 });
    expect(out[0]).toEqual(mine);
    const changed = Object.keys({ ...first, ...out }).filter((i) => JSON.stringify(first[Number(i)]) !== JSON.stringify(out[Number(i)]));
    expect(changed.length).toBeGreaterThan(0);
    expect(changed.length).toBeLessThan(Object.keys(first).length + 6);
    for (const k of Object.keys(out)) expect(g[Number(k)]).not.toBeNull();
    expect(mutateSounds(s, 'perc', g, first, kitParams, { ...dist, amount: 0, take: 2 })).toEqual(first);
  });
  it('MUTATE SOUND keeps the EVOLVE glides of the steps it redraws', () => {
    const s = withVars('perc', 2);
    const g = grid(2);
    const evolved = addEvolution(s, 'perc', g, distributeSounds(s, 'perc', g, undefined, kitParams, { ...dist, amount: 0.8 }), { amount: 0.5, passes: 8, locks: { ...NO_LOCKS } });
    const glides = (o: Record<number, StepSound>) => Object.values(o).reduce((n, x) => n + (x.rules?.filter((r) => r.op === 'evolve').length ?? 0), 0);
    expect(glides(evolved)).toBeGreaterThan(0);
    const out = mutateSounds(s, 'perc', g, evolved, kitParams, { ...dist, amount: 1, take: 3 });
    expect(glides(out)).toBe(glides(evolved));
  });
  it('EVOLVE SOUND adds bounded glides and CLEAR removes only them', () => {
    const s = sound();
    const g = grid(4);
    const mine: StepSound = { locks: { [PAR.DRIVE1]: 50 } };
    const ev = addEvolution(s, 'kick', g, { 0: mine }, { amount: 0.5, passes: 8, locks: NO_LOCKS });
    expect(Object.keys(ev).length).toBe(g.filter(Boolean).length);
    for (const ss of Object.values(ev)) for (const r of ss.rules!) expect(r.op).toBe('evolve');
    expect(ev[0]!.locks).toEqual(mine.locks);
    const cleared = clearEvolution(ev);
    expect(cleared).toEqual({ 0: mine });
    const protectedEv = addEvolution(s, 'kick', g, undefined, { amount: 1, passes: 8, locks: { ...NO_LOCKS, params: [PAR.FMAMNT1, PAR.VELOD1] } });
    expect(Object.values(protectedEv).every((x) => !x.rules?.length)).toBe(true);
  });
});

describe('step sounds in the pattern', () => {
  const proj = (): Project => {
    const p = defaultProject();
    return p;
  };
  it('follow a pattern through length changes, shifts, copy and paste', () => {
    const p = proj().patterns[0]!;
    p.steps = 16;
    setStepSound(p, 't1', 4, { v: 1 });
    setStepSound(p, 't1', 12, { locks: { [PAR.VELOD1]: 20 } });
    expect(soundCount(p)).toBe(2);
    shiftTrack(p, 't1', 2);
    expect(stepSoundAt(p, 't1', 6)).toEqual({ v: 1 });
    expect(stepSoundAt(p, 't1', 14)?.locks).toBeDefined();
    const clip = copyRegion(p, ['t1'], 4, 8);
    const q = clone(p);
    pasteRegion(q, ['t1'], 0, clip);
    expect(stepSoundAt(q, 't1', 2)).toEqual({ v: 1 });
    setLength(p, 32);
    expect(stepSoundAt(p, 't1', 22)).toEqual({ v: 1 });
    setLength(p, 8);
    expect(stepSoundAt(p, 't1', 14)).toBeUndefined();
    expect(stepSoundAt(p, 't1', 6)).toEqual({ v: 1 });
    setStepSound(p, 't1', 6, undefined);
    expect(p.sounds).toBeUndefined();
  });
});

describe('persistence', () => {
  it('step sounds, variations, conditions, rules and timbre survive a save and reload', () => {
    const p = defaultProject();
    p.tracks[0]!.sound.variations = [{ name: 'PUNCH', params: { [PAR.VELOD1]: 30 }, gen: true }, null, { name: 'X', params: {}, sample: { tune: 5, samples: ['a'] }, lock: true }, null];
    p.tracks[0]!.sound.soundLock = true;
    const ss: StepSound = {
      v: 0,
      alt: { cond: { k: 'every', n: 4 }, v: 2 },
      voice: 1,
      locks: { [PAR.VELOD2]: 40 },
      rules: [{ p: PAR.FMAMNT2, op: 'evolve', a: 0, b: 30, n: 8, cond: { k: 'prob', p: 40 } }, { p: PAR.COARSE2, op: 'range', a: 50, b: 70, cond: { k: 'fill' } }],
      gen: true,
    };
    setStepSound(p.patterns[0]!, 't1', 3, ss);
    p.timbre = { amount: 0.8, seed: 77 };
    const back = parseProject(serialize(p));
    expect(back.patterns[0]!.sounds).toEqual(p.patterns[0]!.sounds);
    expect(back.tracks[0]!.sound.variations).toEqual(p.tracks[0]!.sound.variations);
    expect(back.tracks[0]!.sound.soundLock).toBe(true);
    expect(back.timbre).toEqual({ amount: 0.8, seed: 77 });
    expect(back.version).toBe(4);
  });
  it('a project from before step sounds loads with sensible defaults', () => {
    const old = JSON.parse(serialize(defaultProject())) as Record<string, unknown>;
    old.version = 1;
    delete old.timbre;
    for (const t of old.tracks as { sound: Record<string, unknown> }[]) {
      delete t.sound.variations;
      delete t.sound.soundLock;
    }
    for (const pt of old.patterns as Record<string, unknown>[]) delete pt.sounds;
    const p = repairProject(old);
    expect(p.timbre.amount).toBe(0.5);
    expect(p.patterns[0]!.sounds).toBeUndefined();
    expect(p.tracks[0]!.sound.variations).toBeUndefined();
    expect(p.version).toBe(4);
  });
  it('damaged sound data is repaired, never trusted', () => {
    const r = repairStepSound({ v: 9, voice: 12, alt: { cond: { k: 'nonsense' }, v: 7 }, locks: { [PAR.VELOD1]: 999, 99999: 3, x: 1 }, rules: [{ p: PAR.VELOD1, op: 'fly', a: 1, b: 2 }, { p: PAR.VELOD1, op: 'range', a: -50, b: 900, cond: { k: 'prob', p: 500 } }] });
    expect(r?.v).toBeUndefined();
    expect(r?.voice).toBeUndefined();
    expect(r?.alt).toEqual({ cond: { k: 'always' }, v: null });
    expect(r?.locks).toEqual({ [PAR.VELOD1]: 127 });
    expect(r?.rules).toEqual([{ p: PAR.VELOD1, op: 'range', a: 0, b: 127, cond: { k: 'prob', p: 100 } }]);
    expect(repairStepSound({})).toBeUndefined();
    expect(repairStepSound('x')).toBeUndefined();
    const p = defaultProject();
    (p.patterns[0] as unknown as Record<string, unknown>).sounds = { t1: { 5: { locks: { [PAR.VELOD1]: -3 } }, 999: { v: 1 } }, nope: { 0: { v: 1 } } };
    const back = repairProject(JSON.parse(JSON.stringify(p)));
    expect(back.patterns[0]!.sounds).toEqual({ t1: { 5: { locks: { [PAR.VELOD1]: 0 } } } });
  });
  it('snapshots keep variations and step sounds', () => {
    const p = defaultProject();
    p.tracks[0]!.sound.variations = [{ name: 'A', params: { [PAR.VELOD1]: 10 } }, null, null, null];
    setStepSound(p.patterns[0]!, 't1', 0, { v: 0 });
    p.snapshots[0] = { name: 'S', pattern: clone(p.patterns[0]!), synth: clone(p.kit.synth), sounds: Object.fromEntries(p.tracks.map((t) => [t.id, clone(t.sound)])), mix: Object.fromEntries(p.tracks.map((t) => [t.id, clone(t.mix)])), play: Object.fromEntries(p.tracks.map((t) => [t.id, clone(t.play)])), destruction: clone(p.destruction), tempo: 120, swing: 50 };
    const back = parseProject(serialize(p));
    expect(back.snapshots[0]!.pattern.sounds?.t1?.[0]).toEqual({ v: 0 });
    expect(back.snapshots[0]!.sounds.t1!.variations![0]!.params).toEqual({ [PAR.VELOD1]: 10 });
  });
});

describe('from the pattern to the engine, on the musical clock', () => {
  function proj(): Project {
    const p = defaultProject();
    p.kit.synth.params = kitParams.slice();
    const pat = p.patterns[0]!;
    pat.steps = 16;
    pat.gen = { t1: Array.from({ length: 16 }, (_, i) => (i % 4 === 0 ? { vel: 110 } : null)) };
    p.tracks[0]!.sound.variations = [{ name: 'SHORT', params: { [PAR.VELOD1]: 12 } }, { name: 'LONG', params: { [PAR.VELOD1]: 120 } }, null, null];
    setStepSound(pat, 't1', 8, { v: 0, alt: { cond: { k: 'every', n: 4 }, v: 1 } });
    return p;
  }
  function plan(p: Project, cycles: number, fills?: Set<string>) {
    const seq = new Sequence({ project: () => p });
    const hits: { cycle: number; step: number; sp?: number[]; trig?: number }[] = [];
    const idx = trackIndex(p);
    const sched = new Scheduler(seq, {
      now: () => t,
      lookahead: 0.5,
      startDelay: 0,
      emit: (evs) => {
        for (const se of evs) {
          const h = hitOf(se, p, idx, sched.spt, fills);
          if (h && h.track === 0) hits.push({ cycle: se.cycle, step: se.event.step, sp: h.sp, trig: h.trig });
        }
      },
    });
    let t = 0;
    sched.bpm = 600;
    sched.start(0);
    for (let i = 0; i < cycles * 40; i++) {
      t += 0.05;
      sched.pump();
    }
    return hits;
  }
  it('step 9 plays its variation, and the long one every fourth pass, in playback order', () => {
    const hits = plan(proj(), 8);
    const at = hits.filter((h) => h.step === 8);
    expect(at.length).toBeGreaterThanOrEqual(8);
    expect(at.slice(0, 8).map((h) => h.sp?.[1])).toEqual([12, 12, 12, 120, 12, 12, 12, 120]);
    expect(hits.filter((h) => h.step === 4).every((h) => !h.sp)).toBe(true);
  });
  it('the same performance plays the same sounds again (restart semantics)', () => {
    const a = plan(proj(), 6);
    const b = plan(proj(), 6);
    expect(b).toEqual(a);
  });
  it('FILL conditions follow the momentary fill state', () => {
    const p = proj();
    setStepSound(p.patterns[0]!, 't1', 12, { rules: [{ p: PAR.DRIVE1, op: 'set', a: 120, b: 0, cond: { k: 'fill' } }] });
    const quiet = plan(p, 2).filter((h) => h.step === 12);
    const filling = plan(p, 2, new Set(['t1'])).filter((h) => h.step === 12);
    expect(quiet.every((h) => !h.sp)).toBe(true);
    expect(filling.every((h) => h.sp?.[0] === PAR.DRIVE1 && h.sp[1] === 120)).toBe(true);
  });
  it('a hit that moves (CHOP) keeps the sound of the step it came from', () => {
    const p = proj();
    p.destruction.chop = { on: true, amount: 1, slice: 4, retrigger: 0.3, take: 3 };
    const r = realize({ seed: p.seed, swing: 50, pattern: p.patterns[0]!, tracks: p.tracks, destruction: p.destruction, evolve: p.evolve }, 0);
    for (const e of r.events) if (e.track === 't1' && e.snd) expect(e.origin).toBe(8);
  });
  it('a voice switch sends the other trigger with the hit', () => {
    const p = proj();
    setStepSound(p.patterns[0]!, 't1', 4, { voice: 3 });
    const h = plan(p, 1).find((x) => x.step === 4)!;
    expect(h.trig).toBe(3);
  });
});

describe('export renders the step sounds', () => {
  it('a conditional sound change is audible in the render and the render repeats exactly', async () => {
    const lib = await bundledLibrary();
    const p = await presetProject('machine-room', lib);
    const kick = p.tracks.find((t) => t.role === 'kick')!;
    const pat = p.patterns[0]!;
    const steps = pat.steps;
    pat.gen[kick.id] = Array.from({ length: steps }, (_, i) => (i % 4 === 0 ? { vel: 120 } : null));
    const plain = await renderProject(lxrModule(), p, lib, { bars: 8, tail: 0.5 });
    const q = clone(p);
    q.tracks.find((t) => t.role === 'kick')!.sound.variations = [{ name: 'DIRTY', params: { [PAR.VELOD1 + 2 * kick.sound.trigger]: 10, [PAR.DRIVE1 + kick.sound.trigger]: 120 }, gen: true }, null, null, null];
    for (let i = 0; i < steps; i += 4) setStepSound(q.patterns[0]!, kick.id, i, { v: 0, alt: { cond: { k: 'every', n: 2 }, v: null } });
    const a = await renderProject(lxrModule(), q, lib, { bars: 8, tail: 0.5 });
    const b = await renderProject(lxrModule(), q, lib, { bars: 8, tail: 0.5 });
    expect(Buffer.from(a.master[0]!.buffer, a.master[0]!.byteOffset, a.master[0]!.byteLength).equals(Buffer.from(b.master[0]!.buffer, b.master[0]!.byteOffset, b.master[0]!.byteLength))).toBe(true);
    let diff = 0;
    for (let i = 0; i < a.frames; i += 3) diff += Math.abs(a.master[0]![i]! - plain.master[0]![i]!);
    expect(diff).toBeGreaterThan(1);
    expect(stats(a.master[0]!).finite).toBe(true);
    expect(stats(a.master[0]!).peak).toBeLessThanOrEqual(1);
  });
});
