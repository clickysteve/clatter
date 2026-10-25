/** Modulation: waveforms, sync, phase, retrigger, envelopes, random, steps, routing, ranges, smoothing, inheritance, presets, format. */
import { describe, expect, it } from 'vitest';
import { defaultEnv, defaultLfo, defaultRoute, defaultSource, diffMod, repairMod, resolveMod } from '../src/mod/config';
import { exportMod, FULL_CAPABILITIES, importMod, reduceTo, unsupported } from '../src/mod/format';
import { buildRecipe, FACTORY_PRESETS, fitMod, generateMod, mutateMod, randomiseSource } from '../src/mod/presets';
import { DESTS, destApplies, destsFor, parOf } from '../src/mod/registry';
import { ModRuntime, simulate, srcIndex } from '../src/mod/runtime';
import { envAt, envSegments, lfoWave, tableAt } from '../src/mod/shapes';
import { LFO_WAVES, type EnvDef, type LfoDef, type TrackMod } from '../src/mod/types';

const lfo = (o: Partial<LfoDef> = {}): LfoDef => ({ ...defaultLfo(), ...o });
const mod = (sources: TrackMod['sources'], routes: [string, string, number, Partial<TrackMod['routes'][0]>?][]): TrackMod => ({
  sources,
  routes: routes.map(([src, dst, amt, o], i) => ({ ...defaultRoute(`r${i + 1}`, src as never, dst, amt), ...o })),
});
const D = (id: string) => DESTS.findIndex((d) => d.id === id);

describe('LFO waveforms', () => {
  it('every waveform stays in -1..1 and is deterministic', () => {
    for (const wave of LFO_WAVES) {
      const d = lfo({ wave, table: Array.from({ length: 64 }, (_, i) => Math.sin(i / 10)) });
      for (let i = 0; i < 400; i++) {
        const v = lfoWave(d, i / 37, 3);
        expect(v).toBeGreaterThanOrEqual(-1);
        expect(v).toBeLessThanOrEqual(1);
        expect(lfoWave(d, i / 37, 3)).toBe(v);
      }
    }
  });
  it('has the textbook shapes', () => {
    const w = (wave: LfoDef['wave'], p: number, width = 0.5) => lfoWave(lfo({ wave, width }), p);
    expect(w('sine', 0.25)).toBeCloseTo(1);
    expect(w('sine', 0.75)).toBeCloseTo(-1);
    expect(w('tri', 0.5)).toBeCloseTo(1);
    expect(w('tri', 0)).toBeCloseTo(-1);
    expect(w('sawup', 0.25)).toBeCloseTo(-0.5);
    expect(w('sawdn', 0.25)).toBeCloseTo(0.5);
    expect(w('square', 0.49)).toBe(1);
    expect(w('square', 0.51)).toBe(-1);
    expect(w('pulse', 0.2, 0.25)).toBe(1);
    expect(w('pulse', 0.3, 0.25)).toBe(-1);
  });
  it('holds sample-and-hold within a cycle and changes between cycles', () => {
    const d = lfo({ wave: 'sh', seed: 7 });
    expect(lfoWave(d, 0.1)).toBe(lfoWave(d, 0.9));
    expect(lfoWave(d, 0.5)).not.toBe(lfoWave(d, 1.5));
  });
  it('stepped random is stepped, smooth random is continuous', () => {
    const st = lfo({ wave: 'step', seed: 2 });
    expect(lfoWave(st, 0.01)).toBe(lfoWave(st, 0.1));
    const sm = lfo({ wave: 'smooth', seed: 2 });
    let maxJump = 0;
    for (let i = 1; i < 4000; i++) maxJump = Math.max(maxJump, Math.abs(lfoWave(sm, i / 1000) - lfoWave(sm, (i - 1) / 1000)));
    expect(maxJump).toBeLessThan(0.05);
  });
  it('interpolates a custom table periodically', () => {
    const t = [0, 1, 0, -1];
    expect(tableAt(t, 0.25)).toBeCloseTo(1);
    expect(tableAt(t, 0)).toBeCloseTo(0);
    expect(tableAt(t, 1)).toBeCloseTo(tableAt(t, 0));
  });
});

describe('LFO source', () => {
  it('free rate: one cycle per 1/hz seconds', () => {
    const m = mod({ lfo1: lfo({ mode: 'free', hz: 2, wave: 'sawup', retrig: 'free' }) }, []);
    const r = simulate(m, { seconds: 1, dt: 0.001 });
    const out = r.out[srcIndex('lfo1')]!;
    expect(out[0]).toBeCloseTo(-1, 1);
    expect(out[250]).toBeCloseTo(0, 1);
    expect(out[498]).toBeGreaterThan(0.9);
    expect(out[510]).toBeLessThan(-0.9); // wrapped after 0.5 s
  });
  it('tempo sync: a 1/4 LFO at 120 bpm has a 0.5 s period, and follows the tempo', () => {
    const m = mod({ lfo1: lfo({ mode: 'sync', div: '1/4', wave: 'sawup', retrig: 'free' }) }, []);
    const at = (bpm: number, sec: number) => simulate(m, { seconds: sec + 0.01, dt: 0.0005, bpm }).out[srcIndex('lfo1')]!;
    const a = at(120, 0.25);
    expect(a[Math.round(0.25 / 0.0005)]).toBeCloseTo(0, 1);
    const b = at(60, 0.5);
    expect(b[Math.round(0.5 / 0.0005)]).toBeCloseTo(0, 1);
    // dotted and triplet divisions
    const t = simulate(mod({ lfo1: lfo({ mode: 'sync', div: '1/4T', wave: 'sawup', retrig: 'free' }) }, []), { seconds: 0.4, dt: 0.0005, bpm: 120 }).out[srcIndex('lfo1')]!;
    expect(t[Math.round((0.5 * 2) / 3 / 0.0005) - 2]).toBeGreaterThan(0.95);
  });
  it('phase offsets the start', () => {
    const m = mod({ lfo1: lfo({ wave: 'sawup', phase: 0.5, retrig: 'hit', mode: 'free', hz: 1 }) }, []);
    expect(simulate(m, { seconds: 0.01 }).out[srcIndex('lfo1')]![0]).toBeCloseTo(0, 1);
  });
  it('depth, offset and unipolar mode', () => {
    const base = { wave: 'sawup' as const, retrig: 'free' as const, mode: 'free' as const, hz: 1 };
    const o = (x: Partial<LfoDef>) => simulate(mod({ lfo1: lfo({ ...base, ...x }) }, []), { seconds: 0.01 }).out[srcIndex('lfo1')]![0]!;
    expect(o({ depth: 0.5, phase: 0.5 + 0.25 })).toBeCloseTo(0.25, 1);
    expect(o({ uni: true })).toBeCloseTo(0, 1);
    expect(o({ offset: 0.4, depth: 0 })).toBeCloseTo(0.4, 2);
    expect(o({ offset: 1, depth: 1, phase: 0.9 })).toBeLessThanOrEqual(1);
  });
  it('retrigger modes: hit restarts, free does not, bar and pattern align to the grid', () => {
    const run = (retrig: LfoDef['retrig'], ctx: { barSec?: number; patSec?: number }) => {
      const rt = new ModRuntime(1);
      rt.setBpm(120);
      rt.setConfig(mod({ lfo1: lfo({ wave: 'sawup', mode: 'free', hz: 1, retrig }) }, []));
      for (let i = 0; i < 300; i++) rt.advance(0.001);
      const before = rt.out[srcIndex('lfo1')]!;
      rt.trigger(100, ctx);
      return { before, after: rt.out[srcIndex('lfo1')]! };
    };
    const hit = run('hit', {});
    expect(hit.after).toBeCloseTo(-1, 2);
    expect(hit.before).toBeGreaterThan(-1);
    const free = run('free', {});
    expect(free.after).toBeCloseTo(free.before, 3);
    expect(run('bar', { barSec: 0.5 }).after).toBeCloseTo(0, 2);
    expect(run('pattern', { patSec: 0.25, barSec: 0 }).after).toBeCloseTo(-0.5, 2);
  });
});

describe('envelopes', () => {
  const env = (o: Partial<EnvDef>): EnvDef => ({ ...defaultEnv(), ...o });
  const trace = (e: EnvDef, seconds = 1, hits = [0], bpm = 120) => simulate(mod({ env1: e }, []), { seconds, dt: 0.001, hitsAt: hits, bpm }).out[srcIndex('env1')]!;
  it('ADSR rises, decays to sustain, holds for the gate, releases to zero', () => {
    const e = env({ kind: 'adsr', a: 10, d: 100, s: 0.5, gate: 200, r: 100, curve: 0 });
    const o = trace(e);
    expect(o[0]).toBe(0);
    expect(o[10]).toBeGreaterThan(0.95);
    expect(o[60]).toBeCloseTo(0.5 + 0.5 * 0.5, 1);
    expect(o[250]).toBeCloseTo(0.5, 2);
    expect(o[360]).toBeCloseTo(0.5 * (1 - 50 / 100), 1);
    expect(o[500]).toBe(0);
  });
  it('AHDSR holds at the peak', () => {
    const o = trace(env({ kind: 'ahdsr', a: 5, h: 100, d: 50, s: 0, r: 10, curve: 0 }));
    expect(o[50]).toBeCloseTo(1, 2);
    expect(o[104]).toBeCloseTo(1, 1);
    expect(o[140]).toBeLessThan(0.5);
  });
  it('curve bends a segment', () => {
    const lin = trace(env({ a: 100, d: 1, s: 1, r: 1, curve: 0 }))[50]!;
    const slow = trace(env({ a: 100, d: 1, s: 1, r: 1, curve: 0.8 }))[50]!;
    const fast = trace(env({ a: 100, d: 1, s: 1, r: 1, curve: -0.8 }))[50]!;
    expect(fast).toBeGreaterThan(lin);
    expect(slow).toBeLessThan(lin);
  });
  it('multistage interpolates between breakpoints', () => {
    const e = env({ kind: 'multi', v0: 0, pts: [{ t: 100, v: 1, c: 0 }, { t: 100, v: 0.2, c: 0 }, { t: 100, v: 0.8, c: 0 }, { t: 100, v: 0, c: 0 }], loop: null });
    const o = trace(e);
    expect(o[50]).toBeCloseTo(0.5, 1);
    expect(o[150]).toBeCloseTo(0.6, 1);
    expect(o[250]).toBeCloseTo(0.5, 1);
    expect(o[350]).toBeCloseTo(0.4, 1);
    expect(o[600]).toBe(0);
  });
  it('a multistage loop repeats between two points', () => {
    const e = env({ kind: 'multi', v0: 0, pts: [{ t: 50, v: 1, c: 0 }, { t: 50, v: 0, c: 0 }, { t: 50, v: 0.5, c: 0 }], loop: { from: 0, to: 1 } });
    const o = trace(e, 1);
    expect(o[50]).toBeCloseTo(1, 1);
    expect(o[99]).toBeCloseTo(0, 1);
    expect(o[125]).toBeCloseTo(0.5, 1); // looped: the descent again
    expect(o[149]).toBeCloseTo(0, 1);
    expect(o[900]).toBeGreaterThanOrEqual(0);
  });
  it('tempo-synced times are beats', () => {
    const e = env({ sync: true, a: 0.5, d: 0.0001, s: 1, r: 0.0001, curve: 0 });
    expect(trace(e, 1, [0], 120)[125]).toBeCloseTo(0.5, 1); // half a beat at 120 bpm = 0.25 s... a=0.5 beat → rises over 250 ms
    expect(trace(e, 1, [0], 60)[250]).toBeCloseTo(0.5, 1);
  });
  it('retrigger: restart goes to zero, legato continues, ignore keeps running', () => {
    const base = { a: 100, d: 400, s: 0, r: 10, curve: 0 };
    const at = (retrig: EnvDef['retrig']) => trace(env({ ...base, retrig }), 0.4, [0, 0.15])[155]!;
    expect(at('restart')).toBeLessThan(0.1);
    expect(at('legato')).toBeGreaterThan(0.5);
    expect(at('ignore')).toBeGreaterThan(0.7);
  });
  it('trigger filter: accent only responds to loud hits', () => {
    const e = env({ trig: 'accent', a: 1, d: 100, s: 0 });
    const soft = simulate(mod({ env1: e }, []), { seconds: 0.1, vel: 60, dt: 0.001 }).out[srcIndex('env1')]!;
    const loud = simulate(mod({ env1: e }, []), { seconds: 0.1, vel: 120, dt: 0.001 }).out[srcIndex('env1')]!;
    expect(Math.max(...soft)).toBe(0);
    expect(Math.max(...loud)).toBeGreaterThan(0.9);
  });
  it('envAt/envSegments are consistent for a plain ADSR', () => {
    const segs = envSegments(env({ kind: 'adsr', a: 100, d: 100, s: 0.3, r: 100, gate: 0, curve: 0 }), 0.001);
    expect(envAt(segs, 0.1, null).v).toBeCloseTo(1);
    expect(envAt(segs, 0.2, null).v).toBeCloseTo(0.3);
    expect(envAt(segs, 0.4, null).done).toBe(true);
  });
});

describe('step, random and trigger sources', () => {
  it('step sequence runs at its own length and clock, independent of anything else', () => {
    const m = mod({ step: { ...(defaultSource('step') as never as import('../src/mod/types').StepDef), len: 3, vals: [1, 0.5, -1, ...new Array(29).fill(0)], div: '1/8', retrig: 'free' } }, []);
    const r = simulate(m, { seconds: 2, dt: 0.001, bpm: 120 });
    const o = r.out[srcIndex('step')]!;
    expect(o[10]).toBe(1);
    expect(o[260]).toBe(0.5); // 1/8 at 120 bpm = 0.25 s
    expect(o[510]).toBe(-1);
    expect(o[760]).toBe(1); // wrapped after 3 steps
  });
  it('directions', () => {
    const mk = (dir: 'rev' | 'ping') => simulate(mod({ step: { ...(defaultSource('step') as never as import('../src/mod/types').StepDef), len: 3, vals: [1, 2, 3, ...new Array(29).fill(0)].map((v) => v / 4), div: '1/8', dir, retrig: 'free' } }, []), { seconds: 1.6, dt: 0.001, bpm: 120 }).out[srcIndex('step')]!;
    const rev = mk('rev');
    expect([rev[10], rev[260], rev[510]]).toEqual([0.75, 0.5, 0.25]);
    const ping = mk('ping');
    expect([ping[10], ping[260], ping[510], ping[760]].map((x) => Math.round(x! * 4))).toEqual([1, 2, 3, 2]);
  });
  it('clocked random is stepped and reproducible; the seed matters', () => {
    const run = (seed: number) => simulate(mod({ rnd: { type: 'rnd', div: '1/8', uni: false, seed } }, []), { seconds: 1, dt: 0.001, bpm: 120 }).out[srcIndex('rnd')]!;
    const a = run(1);
    expect(a[10]).toBe(a[200]);
    expect(a[10]).not.toBe(a[300]);
    expect([...run(1)]).toEqual([...a]);
    expect([...run(2)]).not.toEqual([...a]);
  });
  it('smooth random never jumps', () => {
    const o = simulate(mod({ smooth: { type: 'smooth', div: '1/16', uni: false, seed: 3 } }, []), { seconds: 2, dt: 0.0005, bpm: 120 }).out[srcIndex('smooth')]!;
    let jump = 0;
    for (let i = 1; i < o.length; i++) jump = Math.max(jump, Math.abs(o[i]! - o[i - 1]!));
    expect(jump).toBeLessThan(0.06);
  });
  it('sample and hold samples another source on its clock', () => {
    const m = mod({ lfo1: lfo({ wave: 'sawup', mode: 'free', hz: 1, retrig: 'free' }), sh: { type: 'sh', div: '1/4', from: 'lfo1', uni: false, seed: 1 } }, []);
    const r = simulate(m, { seconds: 1, dt: 0.001, bpm: 120 });
    const sh = r.out[srcIndex('sh')]!;
    expect(sh[100]).toBeCloseTo(sh[400]!, 5); // held within the 0.5 s step
    expect(sh[100]).not.toBeCloseTo(sh[600]!, 2); // changed on the next one
  });
  it('velocity and trigger follow the hit', () => {
    const m = mod({ trig: { type: 'trig', ms: 100, vel: true } }, []);
    const r = simulate(m, { seconds: 0.5, dt: 0.001, vel: 127, hitsAt: [0.1] });
    const vel = r.out[srcIndex('vel')]!;
    const trig = r.out[srcIndex('trig')]!;
    expect(vel[50]).toBe(0);
    expect(vel[200]).toBeCloseTo(1);
    expect(trig[105]).toBeGreaterThan(0.9);
    expect(trig[300]).toBeLessThan(0.2);
  });
  it('macros read the performance controls', () => {
    const m = mod({}, [['m2', 'trk.pan', 1]]);
    const r = simulate(m, { seconds: 0.01, macros: [0, 0.75, 0, 0] });
    expect(r.dest[D('trk.pan')]![0]).toBeCloseTo(0.75);
  });
});

describe('routing', () => {
  const sq = lfo({ wave: 'sawup', mode: 'free', hz: 1, retrig: 'free', phase: 0.75 }); // out = 0.5 at t=0
  it('amount scales, polarity inverts or makes unipolar', () => {
    const v = (amt: number, pol: 'bi' | 'inv' | 'uni') => simulate(mod({ lfo1: sq }, [['lfo1', 'trk.pan', amt, { pol }]]), { seconds: 0.01 }).dest[D('trk.pan')]![0]!;
    expect(v(0.5, 'bi')).toBeCloseTo(0.25, 2);
    expect(v(0.5, 'inv')).toBeCloseTo(-0.25, 2);
    expect(v(1, 'uni')).toBeCloseTo(0.75, 2);
    expect(v(-1, 'bi')).toBeCloseTo(-0.5, 2);
  });
  it('a disabled route does nothing', () => {
    const r = simulate(mod({ lfo1: sq }, [['lfo1', 'trk.pan', 1, { on: false }]]), { seconds: 0.01 });
    expect(r.dest[D('trk.pan')]![0]).toBe(0);
  });
  it('several sources sum on one destination and several destinations share a source', () => {
    const m = mod({ lfo1: sq, lfo2: lfo({ ...sq, phase: 0.5 }) }, [['lfo1', 'trk.pan', 0.4], ['lfo2', 'trk.pan', 0.4], ['lfo1', 'trk.filter', 0.2]]);
    const r = simulate(m, { seconds: 0.01 });
    expect(r.dest[D('trk.pan')]![0]).toBeCloseTo(0.5 * 0.4 + 0 * 0.4, 2);
    expect(r.dest[D('trk.filter')]![0]).toBeCloseTo(0.1, 2);
  });
  it('sums clamp to -1..1 and route ranges limit a contribution', () => {
    const big = simulate(mod({ lfo1: lfo({ ...sq, phase: 0.5 + 0.25, wave: 'sawup' }) }, [['m1', 'trk.pan', 1], ['m2', 'trk.pan', 1], ['m3', 'trk.pan', 1]]), { seconds: 0.01, macros: [1, 1, 1, 0] });
    expect(big.dest[D('trk.pan')]![0]).toBe(1);
    const lim = simulate(mod({}, [['m1', 'trk.pan', 1, { lo: 0, hi: 0.3 }]]), { seconds: 0.01, macros: [1, 0, 0, 0] });
    expect(lim.dest[D('trk.pan')]![0]).toBeCloseTo(0.3);
  });
  it('smoothing glides to a new value without a jump, a zero time follows exactly', () => {
    const run = (smooth: number) => {
      const rt = new ModRuntime(1);
      rt.setConfig(mod({}, [['m1', 'trk.pan', 1, { smooth }]]));
      const mc = new Float32Array([0, 0, 0, 0]);
      rt.advance(0.001, mc);
      mc[0] = 1;
      rt.advance(0.001, mc);
      const first = rt.dest[D('trk.pan')]!;
      for (let i = 0; i < 400; i++) rt.advance(0.001, mc);
      return { first, last: rt.dest[D('trk.pan')]! };
    };
    const slow = run(50);
    expect(slow.first).toBeLessThan(0.1);
    expect(slow.last).toBeGreaterThan(0.99);
    expect(run(0).first).toBe(1);
  });
  it('a configuration change leaves nothing of the old one', () => {
    const rt = new ModRuntime(1);
    rt.setConfig(mod({}, [['m1', 'trk.pan', 1]]));
    rt.advance(0.001, new Float32Array([1, 0, 0, 0]));
    expect(rt.dest[D('trk.pan')]).toBe(1);
    rt.setConfig(mod({}, [['m1', 'trk.filter', 1]]));
    expect(rt.dest[D('trk.pan')]).toBe(0);
    expect(rt.active).toEqual([D('trk.filter')]);
  });
});

describe('inheritance (variation patches)', () => {
  const base = mod({ lfo1: lfo({ depth: 0.5 }), env1: defaultEnv() }, [['lfo1', 'lxr.filter.cutoff', 0.4], ['env1', 'lxr.osc.coarse', 0.5]]);
  it('a patch overrides single fields and keeps everything else', () => {
    const r = resolveMod(base, { sources: { lfo1: { depth: 0.9 } }, routes: { r1: { dst: 'lxr.filter.drive' } } });
    expect((r.sources.lfo1 as LfoDef).depth).toBe(0.9);
    expect((r.sources.lfo1 as LfoDef).wave).toBe('sine');
    expect(r.routes[0]!.dst).toBe('lxr.filter.drive');
    expect(r.routes[0]!.amt).toBe(0.4);
    expect((base.sources.lfo1 as LfoDef).depth).toBe(0.5); // the base is untouched
  });
  it('a patch can disable a route, remove a source and add a route', () => {
    const r = resolveMod(base, { sources: { env1: null }, routes: { r2: { on: false }, r9: { src: 'lfo1', dst: 'trk.pan', amt: 0.2 } } });
    expect(r.sources.env1).toBeUndefined();
    expect(r.routes.find((x) => x.id === 'r2')!.on).toBe(false);
    expect(r.routes.find((x) => x.id === 'r9')!.dst).toBe('trk.pan');
  });
  it('diff is the smallest patch and round-trips', () => {
    const edited = resolveMod(base, { sources: { lfo1: { depth: 0.9 } } });
    edited.routes[1]!.on = false;
    const p = diffMod(base, edited)!;
    expect(p.sources).toEqual({ lfo1: { depth: 0.9 } });
    expect(p.routes).toEqual({ r2: { on: false } });
    expect(resolveMod(base, p)).toEqual(edited);
    expect(diffMod(base, resolveMod(base, undefined))).toBeUndefined();
  });
});

describe('registry', () => {
  it('lists real firmware parameters per voice and never an invented one', () => {
    for (const d of DESTS.filter((x) => x.kind === 'lxr')) {
      const voices = [0, 1, 2, 3, 4, 5].filter((v) => parOf(d.id, v) !== undefined);
      expect(voices.length, d.id).toBeGreaterThan(0);
    }
    expect(parOf('lxr.mod1.freq', 0)).toBeUndefined(); // a kick has no MOD OSC
    expect(parOf('lxr.mod1.freq', 5)).toBeDefined();
    expect(parOf('lxr.noise.mix', 3)).toBeDefined();
    expect(destApplies('smp.pitch', 'synth', 0)).toBe(false);
    expect(destApplies('smp.pitch', 'hybrid', 0)).toBe(true);
    expect(destApplies('hyb.blend', 'sample', 0)).toBe(false);
    expect(destsFor('sample', 0).every((d) => d.kind !== 'lxr')).toBe(true);
  });
  it('ids are unique and stable', () => {
    expect(new Set(DESTS.map((d) => d.id)).size).toBe(DESTS.length);
  });
});

describe('presets and generation', () => {
  const targets = [{ mode: 'synth' as const, voice: 0 }, { mode: 'synth' as const, voice: 3 }, { mode: 'synth' as const, voice: 5 }, { mode: 'sample' as const, voice: 0 }, { mode: 'hybrid' as const, voice: 4 }];
  it('every factory preset makes working routes for every kind of track', () => {
    expect(FACTORY_PRESETS.length).toBeGreaterThanOrEqual(10);
    for (const p of FACTORY_PRESETS) {
      for (const t of targets) {
        const m = buildRecipe(p.id, t);
        expect(m.routes.length, `${p.name} on ${t.mode}${t.voice}`).toBeGreaterThan(0);
        for (const r of m.routes) {
          expect(destApplies(r.dst, t.mode, t.voice)).toBe(true);
          if (r.src.startsWith('lfo') || r.src.startsWith('env') || ['step', 'rnd', 'smooth', 'sh'].includes(r.src)) expect(m.sources[r.src], `${p.name} ${r.src}`).toBeDefined();
        }
        // and they actually move something
        const out = simulate(m, { seconds: 1, bpm: 124, dt: 0.002 });
        const moved = m.routes.some((r) => {
          const a = out.dest[D(r.dst)]!;
          return Math.max(...a) - Math.min(...a) > 0.01;
        });
        expect(moved, `${p.name} on ${t.mode}${t.voice} moves`).toBe(true);
      }
    }
  });
  it('generation is seeded, stays in range and never maxes every route', () => {
    for (const t of targets) {
      for (let seed = 1; seed <= 25; seed++) {
        const m = generateMod(seed, t, 0.7);
        expect(m.routes.length).toBeGreaterThan(0);
        expect(m.routes.length).toBeLessThanOrEqual(4);
        expect(JSON.stringify(generateMod(seed, t, 0.7))).toBe(JSON.stringify(m));
        expect(repairMod(m)).toEqual(m);
        for (const r of m.routes) {
          expect(destApplies(r.dst, t.mode, t.voice)).toBe(true);
          expect(Math.abs(r.amt)).toBeLessThanOrEqual(0.66);
        }
      }
    }
    expect(JSON.stringify(generateMod(1, targets[0]!))).not.toBe(JSON.stringify(generateMod(2, targets[0]!)));
  });
  it('mutation changes a configuration a bounded amount; randomising touches one source', () => {
    const m = generateMod(4, targets[0]!, 0.6);
    const mut = mutateMod(m, 9, targets[0]!, 0.3);
    expect(JSON.stringify(mut)).not.toBe(JSON.stringify(m));
    for (const r of mut.routes) expect(Math.abs(r.amt)).toBeLessThanOrEqual(0.8);
    const src = Object.keys(m.sources)[0] as never;
    const rnd = randomiseSource(m, src, 3);
    for (const k of Object.keys(m.sources)) if (k !== src) expect(rnd.sources[k as never]).toEqual(m.sources[k as never]);
    expect(rnd.routes).toEqual(m.routes);
  });
  it('a user preset fits another track by dropping what it cannot use', () => {
    const m = buildRecipe('f:metallic', { mode: 'synth', voice: 5 });
    const fit = fitMod(m, { mode: 'sample', voice: 0 });
    for (const r of fit.routes) expect(destApplies(r.dst, 'sample', 0)).toBe(true);
  });
});

describe('portable format', () => {
  it('round-trips, repairs and versions', () => {
    const m = buildRecipe('f:evolving', { mode: 'synth', voice: 0 });
    m.sources.lfo4 = { ...lfo({ wave: 'custom' }), table: Array.from({ length: 64 }, (_, i) => Math.sin(i / 5)) };
    const doc = importMod(exportMod(m, 'TEST', { A: { routes: { r1: { on: false } } } }));
    expect(doc.mod).toEqual(repairMod(m));
    expect((doc.mod.sources.lfo4 as LfoDef).table).toHaveLength(64);
    expect(doc.patches!.A).toEqual({ routes: { r1: { on: false } } });
    expect(() => importMod('{"format":"other"}')).toThrow();
    expect(() => importMod(JSON.stringify({ format: 'clatter-mod', version: 99, mod: {} }))).toThrow(/newer/);
  });
  it('drops garbage instead of failing', () => {
    const m = repairMod({ sources: { lfo1: { wave: 'nope', depth: 9 }, bogus: {} }, routes: [{ src: 'lfo1', dst: 'lxr.nothing' }, { src: 'lfo1', dst: 'trk.pan', amt: 5 }] })!;
    expect((m.sources.lfo1 as LfoDef).wave).toBe('sine');
    expect((m.sources.lfo1 as LfoDef).depth).toBe(1);
    expect(m.routes).toHaveLength(1);
    expect(m.routes[0]!.amt).toBe(1);
  });
  it('names exactly what a limited platform cannot run', () => {
    const m = mod({ lfo1: lfo({ wave: 'custom' }), env1: { ...defaultEnv(), kind: 'multi' }, step: defaultSource('step') }, [['lfo1', 'lxr.filter.cutoff', 0.4], ['step', 'smp.pitch', 0.2]]);
    const pocket = { ...FULL_CAPABILITIES, sources: ['lfo1', 'env1'] as never, lfoWaves: ['sine', 'tri'] as never, customWaveform: false, destinations: ['lxr.filter.cutoff'], envelopes: { multi: false, maxPoints: 0 } };
    const u = unsupported(m, pocket);
    expect(u.map((x) => x.kind).sort()).toEqual(['custom-waveform', 'destination', 'envelope', 'source', 'wave'].sort());
    const reduced = reduceTo(m, pocket);
    expect(Object.keys(reduced.sources)).toEqual([]);
    expect(reduced.routes).toEqual([]);
    expect(unsupported(m, FULL_CAPABILITIES)).toEqual([]);
  });
});
