/** HYBRID playback: synth, sample, combined layers, gain, choke, routing, timing. */
import { describe, expect, it } from 'vitest';
import { newLxr, stats } from './helpers';
import { ClatterEngine, BLOCK, faderGain, silentTrack } from '../src/audio/engine';

function sine(freq: number, secs: number, rate = 44100): Float32Array {
  const n = Math.round(secs * rate);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = Math.sin((2 * Math.PI * freq * i) / rate) * Math.exp(-i / (rate * secs * 0.4)) * 0.8;
  return x;
}

function mk(tracks = 4) {
  const e = new ClatterEngine(newLxr(3), tracks, 3);
  e.setSample('s1', { rate: 44100, channels: [sine(440, 0.5)] });
  e.setSample('s2', { rate: 22050, channels: [sine(220, 0.5, 22050)] });
  return e;
}

/** Render n frames, also capturing per-track stems. */
function render(e: ClatterEngine, frames: number) {
  const L = new Float32Array(frames);
  const R = new Float32Array(frames);
  const stems: Record<number, Float32Array> = {};
  let at = 0;
  e.stemSink = (t, l) => {
    (stems[t] ??= new Float32Array(frames + BLOCK)).set(l, at);
  };
  for (let i = 0; i < frames; i += BLOCK) {
    const l = L.subarray(i, i + BLOCK);
    const r = R.subarray(i, i + BLOCK);
    at = i;
    e.renderBlock(l, r);
  }
  return { L, R, stems };
}

describe('engine', () => {
  it('silent when nothing plays', () => {
    const e = mk();
    expect(stats(render(e, 4410).L).peak).toBe(0);
  });

  it('SYNTH: a track triggers its LXR voice', () => {
    const e = mk();
    e.setTrack(0, { ...silentTrack(), mode: 'synth', trigger: 0 });
    e.schedule({ frame: 0, track: 0, vel: 127, pitch: 0 });
    const s = stats(render(e, 22050).stems[0]!);
    expect(s.peak).toBeGreaterThan(0.05);
  });

  it('SAMPLE: plays a sample at its own rate, sample-accurately', () => {
    const e = mk();
    e.setTrack(1, { ...silentTrack(), mode: 'sample', samples: ['s1'] });
    e.schedule({ frame: 100, track: 1, vel: 127, pitch: 0 });
    const { stems } = render(e, 4410);
    const st = stems[1]!;
    for (let i = 0; i < 100; i++) expect(st[i]).toBe(0);
    expect(Math.abs(st[101]!)).toBeGreaterThan(0);
    // pitch +12 doubles the frequency: half the zero crossings' spacing
    const e2 = mk();
    e2.setTrack(1, { ...silentTrack(), mode: 'sample', samples: ['s1'], tune: 12 });
    e2.schedule({ frame: 0, track: 1, vel: 127, pitch: 0 });
    const zc = (x: Float32Array) => {
      let n = 0;
      for (let i = 1; i < 4000; i++) if (x[i - 1]! < 0 !== x[i]! < 0) n++;
      return n;
    };
    expect(zc(render(e2, 4410).stems[1]!) / zc(st)).toBeGreaterThan(1.8);
  });

  it('SAMPLE: resamples a 22.05 kHz sample to the engine rate', () => {
    const e = mk();
    e.setTrack(1, { ...silentTrack(), mode: 'sample', samples: ['s2'] });
    e.schedule({ frame: 0, track: 1, vel: 127, pitch: 0 });
    const st = render(e, 44100).stems[1]!;
    let n = 0;
    for (let i = 1; i < 4410; i++) if (st[i - 1]! < 0 !== st[i]! < 0) n++;
    expect(n).toBeGreaterThan(40); // 220 Hz → 44 crossings in 0.1 s
    expect(n).toBeLessThan(48);
  });

  it('HYBRID: one hit triggers both layers with their own levels', () => {
    const only = (mode: 'synth' | 'sample' | 'hybrid', synthLevel = 1, sampleLevel = 1) => {
      const e = mk();
      e.setTrack(0, { ...silentTrack(), mode, trigger: 0, samples: ['s1'], synthLevel, sampleLevel });
      e.schedule({ frame: 0, track: 0, vel: 127, pitch: 0 });
      return render(e, 22050).stems[0]!;
    };
    const syn = only('synth');
    const smp = only('sample');
    const hyb = only('hybrid');
    let err = 0;
    for (let i = 0; i < hyb.length; i++) err = Math.max(err, Math.abs(hyb[i]! - (syn[i]! + smp[i]!)));
    expect(err).toBeLessThan(1e-4);
    const half = only('hybrid', 0.5, 0);
    for (let i = 0; i < 2000; i++) expect(half[i]).toBeCloseTo(syn[i]! * 0.5, 5);
  });

  it('gain staging: fader, velocity and mute', () => {
    expect(faderGain(0.8)).toBeCloseTo(1, 6);
    expect(faderGain(0)).toBe(0);
    const peak = (vol: number, vel: number, audible = true) => {
      const e = mk();
      e.setTrack(1, { ...silentTrack(), mode: 'sample', samples: ['s1'], volume: vol, audible });
      e.schedule({ frame: 0, track: 1, vel, pitch: 0 });
      return stats(render(e, 4410).L).peak;
    };
    expect(peak(0.8, 127)).toBeGreaterThan(peak(0.5, 127) * 2);
    expect(peak(0.8, 40)).toBeLessThan(peak(0.8, 127) * 0.4);
    expect(peak(0.8, 127, false)).toBe(0);
  });

  it('choke groups cut the other tracks in the group with a short fade', () => {
    const e = mk();
    e.setTrack(0, { ...silentTrack(), mode: 'sample', samples: ['s1'], choke: 1 });
    e.setTrack(1, { ...silentTrack(), mode: 'sample', samples: ['s1'], choke: 1 });
    e.schedule({ frame: 0, track: 0, vel: 127, pitch: 0 });
    e.schedule({ frame: 4410, track: 1, vel: 127, pitch: 0 });
    const st = render(e, 22050).stems[0]!;
    expect(stats(st.subarray(2000, 4000)).peak).toBeGreaterThan(0.1);
    expect(stats(st.subarray(4410 + 400, 22050)).peak).toBe(0);
    // the fade is gradual (no click): no jump bigger than the signal allows
    let jump = 0;
    for (let i = 4400; i < 4700; i++) jump = Math.max(jump, Math.abs(st[i]! - st[i - 1]!));
    expect(jump).toBeLessThan(0.2);
  });

  it('DESTROY gate cuts a synth layer and the LXR voice returns on the next hit', () => {
    const e = mk();
    e.setTrack(0, { ...silentTrack(), mode: 'synth', trigger: 3 });
    e.schedule({ frame: 0, track: 0, vel: 127, pitch: 0, gate: 441 });
    e.schedule({ frame: 22050, track: 0, vel: 127, pitch: 0 });
    const st = render(e, 44100).stems[0]!;
    expect(stats(st.subarray(1000, 20000)).peak).toBeLessThan(1e-6);
    expect(stats(st.subarray(22100, 24000)).peak).toBeGreaterThan(0.05);
  });

  it('routes FX tracks through the LXR FX bus', () => {
    const e = mk();
    e.setTrack(1, { ...silentTrack(), mode: 'sample', samples: ['s1'], route: 'fx' });
    e.schedule({ frame: 0, track: 1, vel: 127, pitch: 0 });
    // FX off passes the bus through
    expect(stats(render(e, 4410).L).peak).toBeGreaterThan(0.1);
  });

  it('two tracks on one LXR voice share it (monophonic, the later hit owns it)', () => {
    const e = mk();
    e.setTrack(0, { ...silentTrack(), mode: 'synth', trigger: 5 });
    e.setTrack(1, { ...silentTrack(), mode: 'synth', trigger: 6 });
    e.schedule({ frame: 0, track: 0, vel: 127, pitch: 0 });
    e.schedule({ frame: 2048, track: 1, vel: 127, pitch: 0 });
    const { stems } = render(e, 8192);
    expect(stats(stems[0]!.subarray(0, 2048)).peak).toBeGreaterThan(0.01);
    expect(stats(stems[0]!.subarray(2112, 8192)).peak).toBe(0);
    expect(stats(stems[1]!.subarray(2112, 8192)).peak).toBeGreaterThan(0.01);
  });
});
