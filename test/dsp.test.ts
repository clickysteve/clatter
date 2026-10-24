/** The LXR engine compiled to WebAssembly: initialisation, voices, parameters, rates, FX. */
import { describe, expect, it } from 'vitest';
import { newLxr, stats, zeroCrossings } from './helpers';
import { PAR, SOUND_PARAM_COUNT } from '../src/sound/lxrParamIds';

/** Render one voice for `secs` after triggering it. */
function renderVoice(trig: number, opts: { secs?: number; vel?: number; note?: number; setup?: (e: ReturnType<typeof newLxr>) => void } = {}) {
  const e = newLxr(7);
  opts.setup?.(e);
  e.trigger(trig, opts.vel ?? 127, opts.note ?? 60);
  const v = trig >= 5 ? 5 : trig;
  const blocks = Math.ceil((44100 * (opts.secs ?? 0.5)) / e.block);
  const out = new Float32Array(blocks * e.block);
  const others = new Float32Array(blocks * e.block);
  for (let b = 0; b < blocks; b++) {
    e.render();
    for (let i = 0; i < e.block; i++) {
      out[b * e.block + i] = e.out[e.offset(v, 0) + i]!;
      for (let o = 0; o < 6; o++) if (o !== v) others[b * e.block + i] = Math.max(others[b * e.block + i]!, Math.abs(e.out[e.offset(o, 0) + i]!));
    }
  }
  return { out, others };
}

describe('LXR engine (WebAssembly)', () => {
  it('initialises with the firmware geometry', () => {
    const e = newLxr();
    expect(e.block).toBe(64);
    expect(e.paramCount).toBe(SOUND_PARAM_COUNT);
    expect(e.nativeRate).toBeCloseTo(44140, 0);
  });

  it('is silent until triggered', () => {
    const e = newLxr();
    for (let b = 0; b < 50; b++) {
      e.render();
      expect(stats(e.out).peak).toBe(0);
    }
  });

  it.each([0, 1, 2, 3, 4, 5, 6])('trigger %i produces a finite, unclipped drum hit that decays', (trig) => {
    const { out, others } = renderVoice(trig, { secs: trig === 4 ? 4 : 1.5 });
    const s = stats(out);
    expect(s.finite).toBe(true);
    expect(s.peak).toBeGreaterThan(0.05);
    expect(s.peak).toBeLessThan(1);
    // decays to silence within the render (no stuck voice)
    expect(s.last).toBeLessThan(out.length - 1000);
    // only its own voice sounds
    expect(stats(others).peak).toBe(0);
  });

  it('plays the kick at a low pitch that falls (pitch envelope)', () => {
    const { out } = renderVoice(0);
    const early = zeroCrossings(out, 0, 2205);
    const late = zeroCrossings(out, 4410, 6615);
    expect(early).toBeGreaterThan(late);
    expect(late).toBeLessThan(20); // under ~200 Hz
  });

  it('transposes with the note number', () => {
    const a = zeroCrossings(renderVoice(0, { note: 60 }).out, 0, 8000);
    const b = zeroCrossings(renderVoice(0, { note: 72 }).out, 0, 8000);
    expect(b / a).toBeGreaterThan(1.7);
    expect(b / a).toBeLessThan(2.3);
  });

  it('applies parameter changes: decay, volume, coarse tune, drive', () => {
    const base = stats(renderVoice(0, { secs: 2 }).out);
    const long = stats(renderVoice(0, { secs: 2, setup: (e) => e.setParam(PAR.VELOD1, 127) }).out);
    const short = stats(renderVoice(0, { secs: 2, setup: (e) => e.setParam(PAR.VELOD1, 5) }).out);
    expect(long.last).toBeGreaterThan(base.last);
    expect(short.last).toBeLessThan(base.last);
    const quiet = stats(renderVoice(0, { setup: (e) => e.setParam(PAR.VOL1, 20) }).out);
    expect(quiet.peak).toBeLessThan(base.peak * 0.3);
    const high = zeroCrossings(renderVoice(0, { setup: (e) => e.setParam(PAR.COARSE1, 90) }).out, 0, 4000);
    expect(high).toBeGreaterThan(zeroCrossings(renderVoice(0).out, 0, 4000) * 3);
    const driven = stats(renderVoice(0, { setup: (e) => e.setParam(PAR.DRIVE1, 127) }).out);
    expect(driven.rms).toBeGreaterThan(base.rms * 1.5);
    expect(newLxr().getParam(PAR.VELOD1)).toBeGreaterThan(0);
  });

  it('responds to velocity when VEL>VOL is on', () => {
    const on = (e: ReturnType<typeof newLxr>) => e.setParam(PAR.VOLUME_MOD_ON_OFF4, 1);
    const loud = stats(renderVoice(3, { vel: 127, setup: on }).out).peak;
    const soft = stats(renderVoice(3, { vel: 30, setup: on }).out).peak;
    expect(soft).toBeLessThan(loud * 0.6);
  });

  it('closed and open hat share the hihat voice with different decays', () => {
    const cl = stats(renderVoice(5, { secs: 1 }).out);
    const op = stats(renderVoice(6, { secs: 1 }).out);
    expect(op.last).toBeGreaterThan(cl.last * 1.5);
  });

  it('per-hit locks apply for one hit and then return', () => {
    const e = newLxr(3);
    const len = (lockDecay: number | null) => {
      if (lockDecay === null) e.trigger(0, 127, 60);
      else e.triggerLocked(0, 127, 60, PAR.VELOD1, lockDecay, 0, 0);
      let last = 0;
      for (let b = 0; b < 600; b++) {
        e.render();
        for (let i = 0; i < 64; i++) if (Math.abs(e.out[i]!) > 1e-3) last = b;
      }
      return last;
    };
    const plain = len(null);
    const locked = len(5);
    const after = len(null);
    expect(locked).toBeLessThan(plain);
    expect(after).toBe(plain);
  });

  it('LFO modulation changes the sound (LFO 1 → coarse tune)', () => {
    const plain = zeroCrossings(renderVoice(0).out, 0, 8000);
    const mod = zeroCrossings(
      renderVoice(0, {
        setup: (e) => {
          e.setParam(PAR.FREQ_LFO1, 100);
          e.setParam(PAR.AMOUNT_LFO1, 127);
          e.setModTarget(0, 0, PAR.COARSE1);
        },
      }).out,
      0,
      8000,
    );
    expect(mod).not.toBe(plain);
  });

  it('renders several voices at once without interference', () => {
    const e = newLxr(5);
    for (let t = 0; t < 7; t++) e.trigger(t, 100, 60);
    const peaks = new Float32Array(6);
    for (let b = 0; b < 100; b++) {
      e.render();
      for (let v = 0; v < 6; v++) for (let i = 0; i < 64; i++) peaks[v] = Math.max(peaks[v]!, Math.abs(e.out[e.offset(v, 0) + i]!));
    }
    for (let v = 0; v < 6; v++) expect(peaks[v]).toBeGreaterThan(0.02);
  });

  it('is deterministic for a seed (offline rendering)', () => {
    const a = renderVoice(3).out;
    const b = renderVoice(3).out;
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('keeps every buffer stable over a long run (no NaN, no runaway)', () => {
    const e = newLxr(9);
    e.setParam(PAR.FX_TYPE, 4);
    e.setParam(PAR.FX_P4, 127);
    for (let b = 0; b < 44100 / 64 * 20; b++) {
      if (b % 50 === 0) for (let t = 0; t < 7; t++) e.trigger(t, 50 + (b % 77), 48 + (b % 24));
      e.render();
      for (let i = 0; i < 128; i++) e.fxIn[i] = e.out[i % 64]! * 20000;
      e.processFx();
      const s = stats(e.out);
      expect(s.finite).toBe(true);
      expect(s.peak).toBeLessThan(1.01);
    }
  });

  it('runs the LXR FX bus (delay echoes)', () => {
    const e = newLxr();
    e.setParam(PAR.FX_TYPE, 4); // delay
    e.setParam(PAR.FX_DRY_WET, 50);
    e.setParam(PAR.FX_P1, 60);
    e.setParam(PAR.FX_P2, 60);
    e.setParam(PAR.FX_P3, 100); // tone: open
    e.setParam(PAR.FX_P4, 90);
    const energy: number[] = [];
    for (let b = 0; b < 1000; b++) {
      e.fxIn.fill(0);
      if (b === 0) for (let i = 0; i < 64; i++) e.fxIn[i * 2] = e.fxIn[i * 2 + 1] = 20000 * Math.sin(i / 3);
      e.processFx();
      let s = 0;
      for (let i = 0; i < 128; i++) s += Math.abs(e.fxOut[i]!);
      energy.push(s);
    }
    const echoes = energy.filter((x, i) => i > 0 && x > 2000 && energy[i - 1]! <= 2000).length;
    expect(echoes).toBeGreaterThan(3);
  });
});
