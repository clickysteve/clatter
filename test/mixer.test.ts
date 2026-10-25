/** The output stage: gain staging, pan, mute and solo, sends, channel / bus / master processing, bypass, clipping protection. */
import { describe, expect, it } from 'vitest';
import { BLOCK, ClatterEngine, faderGain, silentTrack, type EngineTrack } from '../src/audio/engine';
import { ChannelProcessor, MasterProcessor, BusProcessor, defaultBusFx, defaultChannelFx, defaultOutputFx, legacyOutputFx, repairChannelFx, repairOutputFx, type ChannelFx, type OutputFx } from '../src/audio/mixfx';
import { PAR } from '../src/sound/lxrParamIds';
import { newLxr } from './helpers';

const tone = (hz: number, amp = 0.5, secs = 0.5) => {
  const n = Math.round(secs * 44100);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = Math.sin((2 * Math.PI * hz * i) / 44100) * amp;
  return x;
};
const rms = (x: ArrayLike<number>, from = 0, to = x.length) => {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i]! * x[i]!;
  return Math.sqrt(s / Math.max(1, to - from));
};
const peak = (x: ArrayLike<number>) => {
  let p = 0;
  for (let i = 0; i < x.length; i++) p = Math.max(p, Math.abs(x[i]!));
  return p;
};

function mk(tracks: Partial<EngineTrack>[], out?: OutputFx, amp = 0.5, hz = 200) {
  const e = new ClatterEngine(newLxr(2), tracks.length, 2);
  e.setSample('s', { rate: 44100, channels: [tone(hz, amp, 1)] });
  tracks.forEach((t, i) => e.setTrack(i, { ...silentTrack(), mode: 'sample', samples: ['s'], ...t }));
  e.setMaster(0.8, false);
  if (out) e.setOutput(out);
  return e;
}
function run(e: ClatterEngine, blocks = 120, hit = true) {
  const L: number[] = [];
  const R: number[] = [];
  const tr: number[][] = [];
  const bl = new Float32Array(BLOCK);
  const br = new Float32Array(BLOCK);
  e.stemSink = (t, l) => (tr[t] ??= []).push(...l);
  if (hit) for (let t = 0; t < e.tracks.length; t++) e.schedule({ frame: 0, track: t, vel: 127, pitch: 0 });
  for (let b = 0; b < blocks; b++) {
    e.renderBlock(bl, br);
    L.push(...bl);
    R.push(...br);
  }
  return { L, R, tr };
}

describe('gain staging, pan, mute, solo', () => {
  it('the fader follows the dB taper and scales the track', () => {
    const a = run(mk([{ volume: 0.8 }])).tr[0]!;
    const b = run(mk([{ volume: 0.6 }])).tr[0]!;
    const ratio = rms(b, 2000, 7000) / rms(a, 2000, 7000);
    expect(ratio).toBeCloseTo(faderGain(0.6) / faderGain(0.8), 1);
  });
  it('pan is equal-power and fully left or right at the ends', () => {
    const r = run(mk([{ mixPan: -1 }]));
    expect(rms(r.R, 2000, 7000)).toBeLessThan(rms(r.L, 2000, 7000) * 0.02);
    const c = run(mk([{ mixPan: 0 }]));
    expect(rms(c.L, 2000, 7000)).toBeCloseTo(rms(c.R, 2000, 7000), 3);
  });
  it('a track that is not audible (mute, or other tracks soloed) is silent', () => {
    const r = run(mk([{ audible: false }, { audible: true }]));
    expect(peak(r.tr[0]!)).toBe(0);
    expect(peak(r.tr[1]!)).toBeGreaterThan(0.05);
  });
});

describe('FX sends', () => {
  const withFx = (t: Partial<EngineTrack>) => {
    const e = mk([t]);
    e.setParam(PAR.FX_TYPE, 1); // drive
    e.setParam(PAR.FX_DRY_WET, 100);
    for (const p of [PAR.FX_P1, PAR.FX_P2, PAR.FX_P3, PAR.FX_P4]) e.setParam(p, 90);
    let fx = 0;
    e.fxSink = (l) => {
      for (const v of l) fx += Math.abs(v);
    };
    const r = run(e, 200);
    return { r, fx };
  };
  it('a send feeds the LXR FX bus while the dry signal still plays', () => {
    const none = withFx({ send: 0 });
    const some = withFx({ send: 1 });
    expect(none.fx).toBe(0);
    expect(some.fx).toBeGreaterThan(1);
    expect(rms(some.r.L, 2000, 7000)).toBeGreaterThan(rms(none.r.L, 2000, 7000) * 0.95);
  });
  it('route FX plays only through the bus; the dry signal is not in the main mix', () => {
    const only = withFx({ route: 'fx' });
    expect(only.fx).toBeGreaterThan(1);
  });
});

describe('channel processing', () => {
  const proc = (fx: Partial<ChannelFx>, x: Float32Array) => {
    const p = new ChannelProcessor();
    p.set({ ...defaultChannelFx(), ...fx });
    const L = x.slice();
    const R = x.slice();
    for (let i = 0; i < L.length; i += BLOCK) p.process(L.subarray(i, i + BLOCK), R.subarray(i, i + BLOCK), BLOCK);
    return L;
  };
  const x = tone(200, 0.3, 0.2);
  it('saturation adds level at low input and compresses peaks', () => {
    const y = proc({ sat: { on: true, drive: 0.8, mix: 1 } }, x);
    expect(rms(y)).toBeGreaterThan(rms(x) * 1.5);
    expect(peak(y)).toBeLessThanOrEqual(1.001);
  });
  it('soft clip holds the threshold', () => {
    const loud = tone(200, 1.5, 0.1);
    expect(peak(proc({ clip: { on: true, thresh: 0.5 } }, loud))).toBeLessThanOrEqual(0.5);
  });
  it('bit reduction quantises', () => {
    const y = proc({ crush: { on: true, bits: 3, rate: 0 } }, x);
    expect(new Set(Array.from(y, (v) => Math.round(v * 1e4))).size).toBeLessThanOrEqual(9);
    expect(peak(proc({ crush: { on: true, bits: 16, rate: 0 } }, x))).toBeCloseTo(0.3, 2);
  });
  it('EQ boosts and cuts around its bands', () => {
    const lowTone = tone(60, 0.2, 0.3);
    expect(rms(proc({ eq: { on: true, low: 12, mid: 0, high: 0 } }, lowTone), 4000)).toBeGreaterThan(rms(lowTone, 4000) * 2.5);
    expect(rms(proc({ eq: { on: true, low: -12, mid: 0, high: 0 } }, lowTone), 4000)).toBeLessThan(rms(lowTone, 4000) * 0.4);
    const hi = tone(10000, 0.2, 0.3);
    expect(rms(proc({ eq: { on: true, low: 0, mid: 0, high: 12 } }, hi), 4000)).toBeGreaterThan(rms(hi, 4000) * 2.5);
  });
  it('the transient shaper accents the attack of a decaying hit', () => {
    const hit = tone(150, 0.6, 0.4).map((v, i) => v * Math.exp(-i / 4000));
    const early = (y: Float32Array) => rms(y, 0, 400);
    const base = early(hit);
    expect(early(proc({ trans: { on: true, attack: 1, sustain: 0 } }, hit))).toBeGreaterThan(base * 1.3);
    expect(early(proc({ trans: { on: true, attack: -1, sustain: 0 } }, hit))).toBeLessThan(base * 0.9);
  });
  it('bypassed stages are bit-identical to no processing, in a whole engine', () => {
    const plain = run(mk([{}]));
    const off = run(mk([{ fx: defaultChannelFx() }]));
    expect(off.L).toEqual(plain.L);
    const on = run(mk([{ fx: { ...defaultChannelFx(), sat: { on: true, drive: 0.8, mix: 1 } } }]));
    expect(on.L).not.toEqual(plain.L);
  });
});

describe('bus processing', () => {
  const bus = (cfg: Partial<ReturnType<typeof defaultBusFx>>, x: Float32Array, stereo?: Float32Array) => {
    const p = new BusProcessor();
    p.set({ ...defaultBusFx(), ...cfg });
    const L = x.slice();
    const R = (stereo ?? x).slice();
    for (let i = 0; i < L.length; i += BLOCK) p.process(L.subarray(i, i + BLOCK), R.subarray(i, i + BLOCK), BLOCK);
    return { L, R, gr: p.reduction };
  };
  it('the compressor reduces a loud signal by the ratio above the threshold and leaves a quiet one', () => {
    const loud = tone(200, 0.9, 0.5);
    const c = { comp: { on: true, thresh: -20, ratio: 4, attack: 1, release: 100, makeup: 0, mix: 1 } };
    const y = bus(c, loud);
    expect(rms(y.L, 10000)).toBeLessThan(rms(loud, 10000) * 0.5);
    expect(y.gr).toBeGreaterThan(6);
    const quiet = tone(200, 0.02, 0.3);
    expect(rms(bus(c, quiet).L, 4000)).toBeCloseTo(rms(quiet, 4000), 3);
  });
  it('the filter removes highs and lows', () => {
    const hi = tone(8000, 0.4, 0.2);
    expect(rms(bus({ filter: { on: true, hp: 30, lp: 800 } }, hi).L, 3000)).toBeLessThan(rms(hi, 3000) * 0.05);
    const lo = tone(50, 0.4, 0.3);
    expect(rms(bus({ filter: { on: true, hp: 400, lp: 18000 } }, lo).L, 6000)).toBeLessThan(rms(lo, 6000) * 0.1);
  });
  it('distortion changes the waveform', () => {
    const y = bus({ dist: { on: true, type: 'tube', drive: 0.9, mix: 1 } }, tone(200, 0.3, 0.2)).L;
    expect(rms(y)).toBeGreaterThan(0.3 * Math.SQRT1_2 * 1.2);
  });
  it('stereo width: 0 is mono, 1 unchanged, 2 wider', () => {
    const l = tone(200, 0.4, 0.1);
    const r = tone(300, 0.4, 0.1);
    const mono = bus({ stereo: { on: true, width: 0 } }, l, r);
    expect(Array.from(mono.L)).toEqual(Array.from(mono.R));
    const same = bus({ stereo: { on: true, width: 1 } }, l, r);
    expect(Array.from(same.L)).toEqual(Array.from(l));
    const wide = bus({ stereo: { on: true, width: 2 } }, l, r);
    expect(rms(wide.L.map((v, i) => v - wide.R[i]!))).toBeGreaterThan(rms(l.map((v, i) => v - r[i]!)) * 1.9);
  });
  it('in the engine the bus is a stage between the mix and the master, and off it changes nothing', () => {
    const base = run(mk([{}], legacyOutputFx()));
    const off = run(mk([{}], { ...legacyOutputFx(), bus: defaultBusFx() }));
    expect(off.L).toEqual(base.L);
    const comp = run(mk([{}], { ...legacyOutputFx(), bus: { ...defaultBusFx(), comp: { on: true, thresh: -30, ratio: 8, attack: 1, release: 50, makeup: 0, mix: 1 } } }));
    expect(rms(comp.L, 4000, 7000)).toBeLessThan(rms(base.L, 4000, 7000) * 0.6);
  });
});

describe('master processing and clipping protection', () => {
  it('the limiter never exceeds its ceiling, however hot the mix', () => {
    const out: OutputFx = { ...defaultOutputFx(), limiter: { on: true, ceiling: -3, release: 50 } };
    const e = mk(Array.from({ length: 6 }, () => ({ volume: 1 })), out, 1.0);
    const r = run(e, 200);
    const ceil = Math.pow(10, -3 / 20);
    expect(peak(r.L)).toBeLessThanOrEqual(ceil + 1e-6);
    expect(peak(r.R)).toBeLessThanOrEqual(ceil + 1e-6);
    expect(peak(r.L)).toBeGreaterThan(ceil * 0.9); // and it is not just silence
  });
  it('without the limiter, the soft clipper alone still keeps the output within ±1', () => {
    const e = mk(Array.from({ length: 6 }, () => ({ volume: 1 })), legacyOutputFx(), 1.0);
    e.setMaster(0.8, true);
    expect(peak(run(e, 200).L)).toBeLessThanOrEqual(1);
  });
  it('the limiter reports its gain reduction and releases', () => {
    const m = new MasterProcessor();
    const L = tone(200, 2, 0.05);
    const R = L.slice();
    m.limit(L, R, L.length, -1, 50);
    expect(m.reduction).toBeGreaterThan(6);
    const quiet = tone(200, 0.1, 0.6);
    const q = quiet.slice();
    m.limit(q, q.slice(), q.length, -1, 50);
    expect(q[q.length - 1]).toBeCloseTo(quiet[quiet.length - 1]!, 3);
  });
  it('master width 0 makes the output mono; 1 leaves it alone', () => {
    const l = tone(200, 0.4, 0.05);
    const r = tone(310, 0.4, 0.05);
    const m = new MasterProcessor();
    const a = l.slice();
    const b = r.slice();
    m.width(a, b, a.length, 1);
    expect(Array.from(a)).toEqual(Array.from(l));
    m.width(a, b, a.length, 0);
    expect(Array.from(a)).toEqual(Array.from(b));
  });
  it('the limiter off and width 1 (what older projects have) leave the master as it was', () => {
    const a = run(mk([{}], legacyOutputFx())).L;
    const b = run(mk([{}], { ...legacyOutputFx(), width: 1, limiter: { on: false, ceiling: -0.3, release: 80 } })).L;
    expect(b).toEqual(a);
  });
});

describe('persistence of the output stage', () => {
  it('channel and output settings are repaired, clamped and round-trip', () => {
    const fx = repairChannelFx({ sat: { on: true, drive: 9 }, eq: { on: true, low: -99 }, crush: { bits: 99 } })!;
    expect(fx.sat.drive).toBe(1);
    expect(fx.eq.low).toBe(-15);
    expect(fx.crush.bits).toBe(16);
    expect(repairChannelFx(JSON.parse(JSON.stringify(fx)))).toEqual(fx);
    const out = repairOutputFx({ width: 9, limiter: { on: true, ceiling: -40 } })!;
    expect(out.width).toBe(2);
    expect(out.limiter.ceiling).toBe(-12);
    expect(repairOutputFx(JSON.parse(JSON.stringify(out)))).toEqual(out);
    expect(repairOutputFx('nonsense')).toBeUndefined();
  });
});
