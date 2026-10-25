/** Step sounds: per-hit LXR parameter locks in the real engine, voice routing, overlap and restore. */
import { describe, expect, it } from 'vitest';
import { newLxr, stats, zeroCrossings } from './helpers';
import { BLOCK, ClatterEngine, silentTrack, type HitEvent } from '../src/audio/engine';
import { PAR } from '../src/sound/lxrParamIds';

function mk(tracks = 3) {
  const e = new ClatterEngine(newLxr(5), tracks, 5);
  for (let i = 0; i < tracks; i++) e.setTrack(i, { ...silentTrack(), mode: 'synth', trigger: i === 0 ? 0 : i === 1 ? 3 : 0 });
  return e;
}

/** Render with hits; returns each track's left stem. */
function run(hits: Partial<HitEvent>[], frames: number, setup?: (e: ClatterEngine) => void) {
  const e = mk();
  setup?.(e);
  for (const h of hits) e.schedule({ frame: 0, track: 0, vel: 127, pitch: 0, ...h });
  const stems: Float32Array[] = [0, 1, 2].map(() => new Float32Array(frames + BLOCK));
  let at = 0;
  e.stemSink = (t, l) => stems[t]!.set(l, at);
  const L = new Float32Array(BLOCK);
  const R = new Float32Array(BLOCK);
  for (let i = 0; i < frames; i += BLOCK) {
    at = i;
    e.renderBlock(L, R);
  }
  return { e, stems };
}

const SEC = 44100;

describe('step sound parameter locks (real LXR engine)', () => {
  it('a locked decay shortens the hit', () => {
    const base = run([{}], SEC).stems[0]!;
    const short = run([{ sp: [PAR.VELOD1, 8] }], SEC).stems[0]!;
    const tailBase = stats(base.subarray(6000, 16000)).rms;
    const tailShort = stats(short.subarray(6000, 16000)).rms;
    expect(tailBase).toBeGreaterThan(0.01);
    expect(stats(base.subarray(0, 4000)).peak).toBeGreaterThan(0.05);
    expect(stats(short.subarray(0, 4000)).peak).toBeGreaterThan(0.01);
    expect(tailShort).toBeLessThan(tailBase * 0.5);
  });

  it('a locked coarse tune changes the pitch', () => {
    const lo = run([{ sp: [PAR.COARSE1, 63 - 12] }], SEC / 2).stems[0]!;
    const hi = run([{ sp: [PAR.COARSE1, 63 + 12] }], SEC / 2).stems[0]!;
    expect(zeroCrossings(hi, 4000, 12000)).toBeGreaterThan(zeroCrossings(lo, 4000, 12000) * 1.5);
  });

  it('several locks on one hit all apply and give a different sound from the base', () => {
    const base = run([{}], SEC / 2).stems[0]!;
    const sp = [PAR.VELOD1, 20, PAR.FMAMNT1, 120, PAR.DRIVE1, 100, PAR.FILTER_FREQ_1, 80];
    const locked = run([{ sp }], SEC / 2).stems[0]!;
    let diff = 0;
    for (let i = 0; i < SEC / 2; i++) diff += Math.abs(base[i]! - locked[i]!);
    expect(diff).toBeGreaterThan(5);
    expect(stats(locked).finite).toBe(true);
    expect(stats(locked).peak).toBeLessThan(1.5);
  });

  it('returns to the kit at the next hit of the voice, and only then', () => {
    const { e } = run([{ sp: [PAR.VELOD1, 8] }], BLOCK * 4);
    // the locked value stays while the hit sounds
    expect(e.lxr.getParam(PAR.VELOD1)).toBe(8);
    const kitValue = e.lxr.getParam(PAR.VELOD2);
    e.schedule({ frame: e.frame, track: 0, vel: 100, pitch: 0 });
    const L = new Float32Array(BLOCK);
    e.renderBlock(L, new Float32Array(BLOCK));
    expect(e.lxr.getParam(PAR.VELOD1)).not.toBe(8);
    expect(e.lxr.getParam(PAR.VELOD2)).toBe(kitValue);
  });

  it('a kit edit while a lock holds the parameter takes effect at the next hit', () => {
    const { e } = run([{ sp: [PAR.VELOD1, 8] }], BLOCK * 4);
    e.setParam(PAR.VELOD1, 99);
    expect(e.lxr.getParam(PAR.VELOD1)).toBe(8);
    e.schedule({ frame: e.frame, track: 0, vel: 100, pitch: 0 });
    e.renderBlock(new Float32Array(BLOCK), new Float32Array(BLOCK));
    expect(e.lxr.getParam(PAR.VELOD1)).toBe(99);
  });

  it('an earlier hit sounds exactly as it would alone until the later hit starts (no retroactive change)', () => {
    const gap = BLOCK * 200;
    const alone = run([{ sp: [PAR.VELOD1, 120] }], gap + BLOCK * 20).stems[0]!;
    const both = run([{ sp: [PAR.VELOD1, 120] }, { frame: gap, sp: [PAR.VELOD1, 5, PAR.COARSE1, 100, PAR.FMAMNT1, 127] }], gap + BLOCK * 20).stems[0]!;
    for (let i = 0; i < gap; i++) expect(both[i]).toBe(alone[i]);
    let diff = 0;
    for (let i = gap; i < gap + BLOCK * 20; i++) diff += Math.abs(both[i]! - alone[i]!);
    expect(diff).toBeGreaterThan(0.1);
  });

  it("one voice's locks do not touch another voice", () => {
    const snare = (sp?: number[]) => run([{ track: 1, vel: 110 }, { track: 0, vel: 110, sp }], SEC / 4).stems[1]!;
    const plain = snare();
    const locked = snare([PAR.VELOD1, 4, PAR.COARSE1, 100, PAR.DRIVE1, 127]);
    for (let i = 0; i < SEC / 4; i++) expect(locked[i]).toBe(plain[i]);
  });

  it('a step can route its hit to another LXR voice; the track keeps the output', () => {
    const { stems, e } = run([{ trig: 3 }], SEC / 4);
    expect(stats(stems[0]!).peak).toBeGreaterThan(0.05);
    expect(e.lxr.peaks[0]).toBe(0);
    // the same as the snare track playing it
    const snare = run([{ track: 1 }], SEC / 4).stems[1]!;
    for (let i = 0; i < 4096; i++) expect(stems[0]![i]).toBeCloseTo(snare[i]!, 6);
  });

  it('locks apply to the voice the step plays, not the track’s own', () => {
    const base = run([{ trig: 3 }], SEC / 4).stems[0]!;
    const locked = run([{ trig: 3, sp: [PAR.VELOD4, 6] }], SEC / 4).stems[0]!;
    expect(stats(locked.subarray(SEC / 8, SEC / 4)).rms).toBeLessThan(stats(base.subarray(SEC / 8, SEC / 4)).rms);
  });

  it('panic returns every locked parameter to the kit', () => {
    const { e } = run([{ sp: [PAR.VELOD1, 8, PAR.COARSE1, 100] }], BLOCK * 4);
    const kit = run([], BLOCK).e;
    e.panic();
    expect(e.lxr.getParam(PAR.VELOD1)).toBe(kit.lxr.getParam(PAR.VELOD1));
    expect(e.lxr.getParam(PAR.COARSE1)).toBe(kit.lxr.getParam(PAR.COARSE1));
  });

  it('a sample layer takes per-hit sample settings', () => {
    const e = new ClatterEngine(newLxr(5), 1, 5);
    const x = new Float32Array(3000).fill(0.5);
    e.setSample('a', { rate: 44100, channels: [x] });
    e.setSample('b', { rate: 44100, channels: [x] });
    e.setTrack(0, { ...silentTrack(), mode: 'sample', samples: ['a'], gain: 1 });
    e.schedule({ frame: 0, track: 0, vel: 127, pitch: 0 });
    e.schedule({ frame: 8192, track: 0, vel: 127, pitch: 0, smp: { gain: 0.25 } });
    const L = new Float32Array(16384);
    const R = new Float32Array(16384);
    for (let i = 0; i < 16384; i += BLOCK) e.renderBlock(L.subarray(i, i + BLOCK), R.subarray(i, i + BLOCK));
    expect(stats(L.subarray(500, 2500)).peak).toBeGreaterThan(stats(L.subarray(8700, 10700)).peak * 1.5);
  });
});
