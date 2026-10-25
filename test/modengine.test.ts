/** Modulation in the engine: it reaches the DSP, tracks are independent, shared LXR voices are deterministic, variations do not leak. */
import { describe, expect, it } from 'vitest';
import { BLOCK, ClatterEngine, silentTrack, type EngineTrack } from '../src/audio/engine';
import { defaultEnv, defaultLfo, defaultRoute } from '../src/mod/config';
import { DESTS, parOf } from '../src/mod/registry';
import type { TrackMod } from '../src/mod/types';
import { VOICE_PARAMS } from '../src/sound/lxrParams';
import { newLxr, zeroCrossings } from './helpers';

const mod = (routes: [string, string, number, object?][], sources: TrackMod['sources'] = {}): TrackMod => ({ sources, routes: routes.map(([src, dst, amt, o], i) => ({ ...defaultRoute(`r${i + 1}`, src as never, dst, amt), ...(o ?? {}) })) });
const pid = (v: number, g: string, l: string) => VOICE_PARAMS[v]!.find((p) => p.group === g && p.label === l)?.id;

function engine(tracks: Partial<EngineTrack>[], seed = 3) {
  const e = new ClatterEngine(newLxr(seed), tracks.length, seed);
  tracks.forEach((t, i) => e.setTrack(i, { ...silentTrack(), ...t }));
  return e;
}
function render(e: ClatterEngine, blocks: number) {
  const stems: Float32Array[] = [];
  let at = 0;
  const L = new Float32Array(BLOCK);
  const R = new Float32Array(BLOCK);
  e.stemSink = (t, l) => {
    (stems[t] ??= new Float32Array(blocks * BLOCK)).set(l, at);
  };
  for (let b = 0; b < blocks; b++) {
    at = b * BLOCK;
    e.renderBlock(L, R);
  }
  return stems;
}
const diff = (a: Float32Array, b: Float32Array, from = 0) => {
  let d = 0;
  for (let i = from; i < Math.min(a.length, b.length); i++) d += Math.abs(a[i]! - b[i]!);
  return d;
};

describe('which destinations respond (measured on the real engine)', () => {
  function run(v: number, setup: (e: ReturnType<typeof newLxr>) => void, change: ((e: ReturnType<typeof newLxr>) => void) | null) {
    const e = newLxr(5);
    setup(e);
    e.trigger(v, 127, 60);
    const out: number[] = [];
    for (let b = 0; b < 60; b++) {
      if (b === 6 && change) change(e);
      e.render();
      for (let i = 0; i < 64; i++) out.push(e.out[e.offset(v, 0) + i]!);
    }
    return out;
  }
  for (const d of DESTS.filter((x) => x.kind === 'lxr')) {
    it(`${d.id} is ${d.rate}`, () => {
      let tested = 0;
      for (let v = 0; v < 6; v++) {
        const p = parOf(d.id, v);
        if (p === undefined) continue;
        const setup = (e: ReturnType<typeof newLxr>) => {
          if (d.id === 'lxr.osc.pwm') e.setParam(pid(v, 'OSC', 'WAVE')!, 5);
          if (d.id === 'lxr.fm.freq') e.setParam(pid(v, 'FM', 'AMOUNT')!, 100);
          if (d.id === 'lxr.transient.pitch') e.setParam(pid(v, 'TRANSIENT', 'LEVEL')!, 110);
          if (d.id === 'lxr.mod1.freq') e.setParam(pid(v, 'MOD OSC 1', 'AMOUNT')!, 100);
          if (d.id === 'lxr.mod2.freq') e.setParam(pid(v, 'MOD OSC 2', 'AMOUNT')!, 100);
          if (d.id === 'lxr.filter.reso') {
            e.setParam(pid(v, 'FILTER', 'TYPE')!, 0);
            e.setParam(pid(v, 'FILTER', 'CUTOFF')!, 60);
          }
        };
        const alt = newLxr(5).getParam(p) > 64 ? 10 : 110;
        const a = run(v, setup, null);
        const b = run(v, setup, (e) => e.setParam(p, alt));
        let late = 0;
        for (let i = 6 * 64; i < a.length; i++) late += Math.abs(a[i]! - b[i]!);
        const c = run(v, (e) => (setup(e), e.setParam(p, alt)), null);
        let atTrigger = 0;
        for (let i = 0; i < a.length; i++) atTrigger += Math.abs(a[i]! - c[i]!);
        expect(atTrigger, `${d.id} voice ${v} at trigger`).toBeGreaterThan(0.5);
        if (d.rate === 'continuous') expect(late, `${d.id} voice ${v} mid-note`).toBeGreaterThan(0.05);
        else expect(late, `${d.id} voice ${v} is read at the trigger only`).toBe(0);
        tested++;
      }
      expect(tested).toBeGreaterThan(0);
    });
  }
});

describe('modulation reaches the audio', () => {
  it('an envelope on pitch bends a kick; the same kick unmodulated does not', () => {
    const hit = { frame: 0, track: 0, vel: 127, pitch: 0 };
    const plain = engine([{ trigger: 0 }]);
    plain.schedule({ ...hit });
    const a = render(plain, 60)[0]!;
    const bent = engine([{ trigger: 0, mods: [mod([['env1', 'lxr.osc.coarse', 0.8, { smooth: 0 }]], { env1: { ...defaultEnv(), a: 0, d: 150, s: 0, curve: -0.5 } })] }]);
    bent.schedule({ ...hit });
    const b = render(bent, 60)[0]!;
    expect(diff(a, b)).toBeGreaterThan(5);
    // the pitch is higher at the start and falls back
    expect(zeroCrossings(b, 0, 600)).toBeGreaterThan(zeroCrossings(a, 0, 600));
  });
  it('an LFO moves a filter while the note sounds, and a trigger-time destination is fixed per hit', () => {
    const lfo = { ...defaultLfo(), wave: 'square' as const, mode: 'free' as const, hz: 40, retrig: 'hit' as const, uni: true };
    const e = engine([{ trigger: 3, mods: [mod([['lfo1', 'lxr.filter.cutoff', 1, { smooth: 0 }]], { lfo1: lfo })] }]);
    const p = pid(3, 'FILTER', 'CUTOFF')!;
    e.setParam(p, 90);
    e.schedule({ frame: 0, track: 0, vel: 127, pitch: 0 });
    const seen = new Set<number>();
    for (let b = 0; b < 120; b++) {
      render(e, 1);
      seen.add(e.lxr.getParam(p));
    }
    expect(seen.size).toBeGreaterThan(1);
    expect(Math.min(...seen)).toBeLessThanOrEqual(90);
    expect(Math.max(...seen)).toBeGreaterThan(90);
  });
  it('values stay valid: extreme amounts clamp to 0-127', () => {
    const e = engine([{ trigger: 0, mods: [mod([['m1', 'lxr.filter.cutoff', 1, { smooth: 0 }], ['m2', 'lxr.filter.cutoff', 1, { smooth: 0 }]])] }]);
    e.setMacros([1, 1, 0, 0]);
    e.setParam(pid(0, 'FILTER', 'CUTOFF')!, 120);
    e.schedule({ frame: 0, track: 0, vel: 100, pitch: 0 });
    render(e, 20);
    expect(e.lxr.getParam(pid(0, 'FILTER', 'CUTOFF')!)).toBe(127);
    e.setMacros([-5, 9, 0, 0]);
    render(e, 20);
    const v = e.lxr.getParam(pid(0, 'FILTER', 'CUTOFF')!);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(127);
  });
});

describe('independent tracks and shared LXR voices', () => {
  it('a hi-hat’s modulation does not change the cymbal', () => {
    const cym = (hatMod: boolean) => {
      const e = engine([{ trigger: 5, mods: hatMod ? [mod([['m1', 'lxr.filter.cutoff', -1, { smooth: 0 }]])] : [] }, { trigger: 4 }]);
      e.setMacros([1, 0, 0, 0]);
      e.schedule({ frame: 0, track: 0, vel: 127, pitch: 0 });
      e.schedule({ frame: 128, track: 1, vel: 127, pitch: 0 });
      return render(e, 80)[1]!;
    };
    expect(diff(cym(true), cym(false))).toBe(0);
  });
  it('two tracks on one voice: the later hit takes the voice, with its own modulation only', () => {
    const cutoff = pid(5, 'FILTER', 'CUTOFF')!;
    const e = engine([
      { trigger: 5, mods: [mod([['m1', 'lxr.filter.cutoff', -0.5, { smooth: 0 }]])] }, // CL HAT: down
      { trigger: 6, mods: [mod([['m1', 'lxr.filter.cutoff', 0.5, { smooth: 0 }]])] }, // OP HAT: up
    ]);
    e.setMacros([1, 0, 0, 0]);
    e.setParam(cutoff, 64);
    e.schedule({ frame: 0, track: 0, vel: 100, pitch: 0 });
    render(e, 4);
    const closed = e.lxr.getParam(cutoff);
    expect(closed).toBeLessThan(64);
    e.schedule({ frame: e.frame, track: 1, vel: 100, pitch: 0 });
    render(e, 4);
    const open = e.lxr.getParam(cutoff);
    expect(open).toBeGreaterThan(64);
    // the closed hat's modulation did not stack on the open hat's: it is exactly base + its own
    expect(open).toBe(Math.round(64 + 0.5 * 64));
    // and a track without modulation gets the plain kit value back
    const plain = engine([{ trigger: 5, mods: [mod([['m1', 'lxr.filter.cutoff', 0.5, { smooth: 0 }]])] }, { trigger: 6 }]);
    plain.setMacros([1, 0, 0, 0]);
    plain.setParam(cutoff, 64);
    plain.schedule({ frame: 0, track: 0, vel: 100, pitch: 0 });
    render(plain, 4);
    expect(plain.lxr.getParam(cutoff)).toBeGreaterThan(64);
    plain.schedule({ frame: plain.frame, track: 1, vel: 100, pitch: 0 });
    render(plain, 4);
    expect(plain.lxr.getParam(cutoff)).toBe(64);
  });
  it('simultaneous triggers: the order is deterministic and reproducible', () => {
    const cutoff = pid(5, 'FILTER', 'CUTOFF')!;
    const run = () => {
      const e = engine([
        { trigger: 5, mods: [mod([['m1', 'lxr.filter.cutoff', -0.5, { smooth: 0 }]])] },
        { trigger: 6, mods: [mod([['m1', 'lxr.filter.cutoff', 0.5, { smooth: 0 }]])] },
      ]);
      e.setMacros([1, 0, 0, 0]);
      e.setParam(cutoff, 64);
      e.schedule({ frame: 10, track: 0, vel: 100, pitch: 0 });
      e.schedule({ frame: 10, track: 1, vel: 100, pitch: 0 });
      const out = render(e, 30);
      return { cut: e.lxr.getParam(cutoff), a: out[0]!, b: out[1]! };
    };
    const x = run();
    const y = run();
    expect(x.cut).toBe(y.cut);
    expect(x.cut).toBe(96); // the second scheduled hit owns the voice
    expect(diff(x.a, y.a)).toBe(0);
    expect(diff(x.b, y.b)).toBe(0);
  });
  it('step locks and modulation share a parameter: modulation moves around the locked value and the kit value returns', () => {
    const cutoff = pid(3, 'FILTER', 'CUTOFF')!;
    const e = engine([{ trigger: 3, mods: [mod([['m1', 'lxr.filter.cutoff', 0.25, { smooth: 0 }]])] }]);
    e.setMacros([1, 0, 0, 0]);
    e.setParam(cutoff, 40);
    e.schedule({ frame: 0, track: 0, vel: 100, pitch: 0, sp: [cutoff, 100] });
    render(e, 4);
    expect(e.lxr.getParam(cutoff)).toBe(Math.min(127, 100 + 16));
    e.schedule({ frame: e.frame, track: 0, vel: 100, pitch: 0 });
    render(e, 4);
    expect(e.lxr.getParam(cutoff)).toBe(40 + 16);
  });
});

describe('variations and stale values', () => {
  const base = mod([['m1', 'lxr.filter.cutoff', 0.5, { smooth: 0 }], ['m1', 'lxr.osc.coarse', 0.5, { smooth: 0 }]]);
  const varA = { ...base, routes: base.routes.map((r) => (r.id === 'r1' ? { ...r, on: false } : r)) }; // A disables the cutoff route
  const varB: TrackMod = { ...base, routes: [...base.routes, defaultRoute('r3', 'm1', 'lxr.voice.drive', 0.5)].map((r) => ({ ...r, smooth: 0 })) };
  it('the right modulation plays for the base and for each variation, and nothing leaks between them', () => {
    const cutoff = pid(0, 'FILTER', 'CUTOFF')!;
    const drive = pid(0, 'MIX', 'DRIVE')!;
    const e = engine([{ trigger: 0, mods: [base, varA, varB, null, null] }]);
    e.setMacros([1, 0, 0, 0]);
    e.setParam(cutoff, 50);
    e.setParam(drive, 30);
    const hit = (mv: number) => {
      e.schedule({ frame: e.frame, track: 0, vel: 100, pitch: 0, mv });
      render(e, 4);
      return { cutoff: e.lxr.getParam(cutoff), drive: e.lxr.getParam(drive) };
    };
    expect(hit(0)).toEqual({ cutoff: 50 + 32, drive: 30 });
    expect(hit(1)).toEqual({ cutoff: 50, drive: 30 }); // A: no cutoff route, and the base's is not left behind
    expect(hit(2)).toEqual({ cutoff: 50 + 32, drive: 30 + 32 }); // B: adds a route
    expect(hit(0)).toEqual({ cutoff: 50 + 32, drive: 30 }); // base again: B's drive route is gone
    expect(hit(3)).toEqual({ cutoff: 50 + 32, drive: 30 }); // C has no override: it plays the base's
  });
  it('a variation switch restarts its sources, a repeated slot keeps free-running ones', () => {
    const lfo = { ...defaultLfo(), wave: 'sawup' as const, mode: 'free' as const, hz: 1, retrig: 'free' as const };
    const withLfo = (depth: number): TrackMod => mod([['lfo1', 'trk.pan', 1, { smooth: 0 }]], { lfo1: { ...lfo, depth } });
    const e = engine([{ trigger: 0, mods: [withLfo(1), withLfo(0.5), null, null, null] }]);
    const probe = () => {
      const m = (e as unknown as { rt: { out: Float32Array }[] }).rt[0]!;
      return m.out[0]!;
    };
    e.schedule({ frame: 0, track: 0, vel: 100, pitch: 0, mv: 0 });
    render(e, 200);
    const a = probe();
    e.schedule({ frame: e.frame, track: 0, vel: 100, pitch: 0, mv: 0 });
    render(e, 1);
    expect(Math.abs(probe() - a)).toBeLessThan(0.1); // same slot: still running
    e.schedule({ frame: e.frame, track: 0, vel: 100, pitch: 0, mv: 1 });
    render(e, 1);
    expect(probe()).toBeLessThan(-0.45); // new slot: restarted at the start of its cycle
  });
  it('removing modulation restores the kit’s values', () => {
    const cutoff = pid(0, 'FILTER', 'CUTOFF')!;
    const e = engine([{ trigger: 0, mods: [base] }]);
    e.setMacros([1, 0, 0, 0]);
    e.setParam(cutoff, 50);
    e.schedule({ frame: 0, track: 0, vel: 100, pitch: 0 });
    render(e, 4);
    expect(e.lxr.getParam(cutoff)).toBe(82);
    e.setTrack(0, { mods: [] });
    render(e, 2);
    expect(e.lxr.getParam(cutoff)).toBe(50);
  });
  it('editing a depth while playing does not restart free-running sources', () => {
    const lfo = { ...defaultLfo(), wave: 'sawup' as const, mode: 'free' as const, hz: 1, retrig: 'free' as const };
    const a = mod([['lfo1', 'trk.pan', 0.5]], { lfo1: lfo });
    const e = engine([{ trigger: 0, mods: [a] }]);
    render(e, 100);
    const rt = (e as unknown as { rt: { out: Float32Array }[] }).rt[0]!;
    const before = rt.out[0]!;
    e.setTrack(0, { mods: [{ ...a, routes: [{ ...a.routes[0]!, amt: 0.6 }] }] });
    render(e, 1);
    expect(rt.out[0]!).toBeGreaterThan(before);
    expect(rt.out[0]!).toBeGreaterThan(-0.9);
  });
});

describe('sample, hybrid and track destinations', () => {
  const sine = (secs = 0.4) => {
    const n = Math.round(secs * 44100);
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = Math.sin((2 * Math.PI * 200 * i) / 44100) * 0.8;
    return x;
  };
  const withSample = (t: Partial<EngineTrack>) => {
    const e = engine([{ mode: 'sample', samples: ['s'], ...t }]);
    e.setSample('s', { rate: 44100, channels: [sine()] });
    return e;
  };
  it('sample pitch modulation bends a playing sample', () => {
    const plain = withSample({});
    plain.schedule({ frame: 0, track: 0, vel: 127, pitch: 0 });
    const a = render(plain, 100)[0]!;
    const up = withSample({ mods: [mod([['m1', 'smp.pitch', 1, { smooth: 0 }]])] });
    up.setMacros([1, 0, 0, 0]); // +12 semitones
    up.schedule({ frame: 0, track: 0, vel: 127, pitch: 0 });
    const b = render(up, 100)[0]!;
    expect(zeroCrossings(b, 200, 3000) / zeroCrossings(a, 200, 3000)).toBeGreaterThan(1.8);
  });
  it('sample gain and pan modulation', () => {
    const run = (m: TrackMod) => {
      const e = withSample({ mods: [m] });
      e.setMacros([1, 0, 0, 0]);
      const L = new Float32Array(64);
      const R = new Float32Array(64);
      e.schedule({ frame: 0, track: 0, vel: 127, pitch: 0 });
      let l = 0;
      let r = 0;
      for (let b = 0; b < 40; b++) {
        e.renderBlock(L, R);
        for (let i = 0; i < 64; i++) {
          l += Math.abs(L[i]!);
          r += Math.abs(R[i]!);
        }
      }
      return { l, r };
    };
    const centre = run(mod([]));
    const panned = run(mod([['m1', 'smp.pan', 1, { smooth: 0 }]]));
    expect(panned.r).toBeGreaterThan(panned.l * 5);
    expect(centre.l).toBeCloseTo(centre.r, 3);
    const louder = run(mod([['m1', 'smp.gain', 1, { smooth: 0 }]]));
    expect(louder.l).toBeGreaterThan(centre.l * 1.8);
    const silent = run(mod([['m1', 'smp.gain', -1, { smooth: 0 }]]));
    expect(silent.l).toBeLessThan(centre.l * 0.05);
  });
  it('HYBRID blend crossfades the layers', () => {
    const run = (blend: number) => {
      const e = engine([{ mode: 'hybrid', trigger: 0, samples: ['s'], mods: [mod([['m1', 'hyb.blend', 1, { smooth: 0 }]])] }]);
      e.setSample('s', { rate: 44100, channels: [sine()] });
      e.setMacros([blend, 0, 0, 0]);
      e.schedule({ frame: 0, track: 0, vel: 127, pitch: 0 });
      return render(e, 60)[0]!;
    };
    const both = run(0);
    const sampleOnly = run(1);
    const rms = (x: Float32Array) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);
    expect(rms(sampleOnly)).toBeLessThan(rms(both) * 1.01);
    expect(rms(sampleOnly)).toBeGreaterThan(0.05);
  });
  it('a sample start position moves into the region at the trigger', () => {
    const run = (start: number) => {
      const e = withSample({ mods: [mod([['m1', 'smp.start', 1, { smooth: 0 }]])] });
      e.setMacros([start, 0, 0, 0]);
      e.schedule({ frame: 0, track: 0, vel: 127, pitch: 0 });
      return render(e, 320)[0]!;
    };
    const last = (x: Float32Array) => {
      let k = -1;
      x.forEach((v, i) => {
        if (Math.abs(v) > 1e-3) k = i;
      });
      return k;
    };
    const full = run(0);
    const late = run(1); // starts half-way into the region
    const lastFull = last(full);
    const lastLate = last(late);
    expect(lastLate).toBeLessThan(lastFull * 0.7);
  });
  it('track destinations move volume, pan, filter and send', () => {
    const run = (dst: string, macro: number) => {
      const e = withSample({ mods: [mod([['m1', dst, 1, { smooth: 0 }]])] });
      e.setMacros([macro, 0, 0, 0]);
      e.schedule({ frame: 0, track: 0, vel: 127, pitch: 0 });
      return render(e, 40)[0]!;
    };
    const rms = (x: Float32Array) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);
    expect(rms(run('trk.volume', 1))).toBeGreaterThan(rms(run('trk.volume', 0)) * 1.5);
    // a high-pass filter removes most of a 200 Hz tone
    expect(rms(run('trk.filter', 1))).toBeLessThan(rms(run('trk.filter', 0)) * 0.5);
  });
});
