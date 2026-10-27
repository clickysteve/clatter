import { describe, expect, it } from 'vitest';
import { analysePitch, hzToMidiFloat, midiToHz, noteName, pitchPoint } from '../src/analysis/pitch';

const R = 44100;

/** n seconds of a signal built from f(t). */
function make(seconds: number, f: (t: number, i: number) => number): Float32Array {
  const out = new Float32Array(Math.round(seconds * R));
  for (let i = 0; i < out.length; i++) out[i] = f(i / R, i);
  return out;
}
const cents = (a: number, b: number) => Math.abs(1200 * Math.log2(a / b));

/** deterministic white noise */
function noise(seconds: number, seed = 7): Float32Array {
  let s = seed;
  return make(seconds, () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s / 2 ** 32) * 2 - 1;
  });
}

/** a sine with a phase accumulated from a frequency track */
function sweep(seconds: number, hz: (t: number) => number, amp: (t: number) => number): Float32Array {
  let ph = 0;
  return make(seconds, (t) => {
    ph += (2 * Math.PI * hz(t)) / R;
    return amp(t) * Math.sin(ph);
  });
}

describe('notes', () => {
  it('names notes and measures cents', () => {
    expect(noteName(69)).toBe('A4');
    expect(noteName(60)).toBe('C4');
    expect(noteName(36)).toBe('C2');
    expect(pitchPoint(440)).toMatchObject({ midi: 69, note: 'A4', cents: 0 });
    expect(pitchPoint(midiToHz(45) * Math.pow(2, 20 / 1200))).toMatchObject({ note: 'A2', cents: 20 });
    expect(pitchPoint(midiToHz(45) * Math.pow(2, -30 / 1200)).cents).toBeCloseTo(-30, 0);
    expect(hzToMidiFloat(880)).toBeCloseTo(81, 6);
  });
});

describe('stable sines at known pitches', () => {
  for (const hz of [30, 41.2, 55, 82.41, 110, 146.83, 220, 261.63, 440, 1000, 2093]) {
    it(`${hz} Hz`, () => {
      const a = analysePitch(make(0.6, (t) => 0.8 * Math.sin(2 * Math.PI * hz * t)), R);
      expect(a.kind).toBe('stable');
      expect(cents(a.fundamental!.hz, hz)).toBeLessThan(5);
      expect(a.confidence).toBeGreaterThan(0.85);
      expect(a.stability).toBeGreaterThan(0.9);
      expect(Math.abs(a.sweepCents)).toBeLessThan(30);
    });
  }

  it('reports the note and the cents against it', () => {
    const a = analysePitch(make(0.5, (t) => Math.sin(2 * Math.PI * 110 * Math.pow(2, 25 / 1200) * t)), R);
    expect(a.fundamental!.note).toBe('A2');
    expect(a.fundamental!.cents).toBeGreaterThan(20);
    expect(a.fundamental!.cents).toBeLessThan(30);
  });

  it('is quiet-safe: a very low level sine is still found', () => {
    const a = analysePitch(make(0.5, (t) => 0.002 * Math.sin(2 * Math.PI * 220 * t)), R);
    expect(a.kind).toBe('stable');
    expect(cents(a.fundamental!.hz, 220)).toBeLessThan(5);
  });
});

describe('noisy tones', () => {
  const noisy = (hz: number, noiseLevel: number) => {
    const n = noise(0.5, 21);
    return make(0.5, (t, i) => 0.5 * Math.sin(2 * Math.PI * hz * t) + noiseLevel * n[i]!);
  };
  for (const hz of [60, 110, 196, 330, 523]) {
    it(`${hz} Hz under moderate noise stays within 15 cents`, () => {
      const a = analysePitch(noisy(hz, 0.16), R);
      expect(a.kind).toBe('stable');
      expect(cents(a.fundamental!.hz, hz)).toBeLessThan(15);
      expect(a.confidence).toBeGreaterThan(0.8);
    });
    it(`${hz} Hz buried in noise is never reported as another note with confidence`, () => {
      for (const lvl of [0.4, 0.6, 1]) {
        const a = analysePitch(noisy(hz, lvl), R);
        if (a.fundamental) expect(cents(a.fundamental.hz, hz) < 60 || a.confidence < 0.5, `${hz} @${lvl}: ${a.fundamental.hz} conf ${a.confidence}`).toBe(true);
      }
    });
  }
});

describe('harmonic sounds', () => {
  it('finds the fundamental of a sawtooth-like stack, not its loudest partial', () => {
    const f = 98;
    const a = analysePitch(make(0.6, (t) => [1, 0.4, 0.8, 0.3, 0.6].reduce((s, g, k) => s + g * Math.sin(2 * Math.PI * f * (k + 1) * t), 0) / 3), R);
    expect(a.kind).toBe('stable');
    expect(cents(a.fundamental!.hz, f)).toBeLessThan(8);
  });

  it('keeps the fundamental when a harmonic is much louder than it', () => {
    const f = 150;
    const a = analysePitch(make(0.6, (t) => 0.2 * Math.sin(2 * Math.PI * f * t) + 0.9 * Math.sin(2 * Math.PI * 3 * f * t) + 0.5 * Math.sin(2 * Math.PI * 4 * f * t)), R);
    expect(a.kind).toBe('stable');
    expect(cents(a.fundamental!.hz, f)).toBeLessThan(8);
  });

  it('an FM pair with an integer ratio is harmonic at the modulator', () => {
    // carrier 200 Hz, modulator 100 Hz, index 2: partials at multiples of 100 Hz
    const a = analysePitch(make(0.6, (t) => 0.7 * Math.sin(2 * Math.PI * 200 * t + 2 * Math.sin(2 * Math.PI * 100 * t))), R);
    expect(a.kind).toBe('stable');
    expect(cents(a.fundamental!.hz, 100)).toBeLessThan(10);
  });

  it('a decaying tone keeps its pitch while it fades', () => {
    const a = analysePitch(make(1, (t) => Math.exp(-t * 6) * Math.sin(2 * Math.PI * 180 * t)), R);
    expect(a.kind).toBe('stable');
    expect(cents(a.fundamental!.hz, 180)).toBeLessThan(8);
  });
});

describe('pitch sweeps and kick-like envelopes', () => {
  it('a kick: 180 Hz falling to 55 Hz settles on the body and reports the start', () => {
    const hz = (t: number) => 55 + (180 - 55) * Math.exp(-t / 0.035);
    const a = analysePitch(sweep(0.7, hz, (t) => Math.exp(-t * 5)), R);
    expect(a.kind).toBe('swept');
    expect(cents(a.settled!.hz, 55)).toBeLessThan(40);
    expect(a.fundamental!.hz).toBeCloseTo(a.settled!.hz, 6);
    expect(a.initial!.hz).toBeGreaterThan(a.settled!.hz * 1.5);
    expect(a.sweepCents).toBeGreaterThan(500);
    expect(a.settleTime).toBeGreaterThan(0.02);
    expect(a.confidence).toBeGreaterThan(0.5);
  });

  it('a slow linear sweep up is reported as moving upward', () => {
    const a = analysePitch(sweep(0.8, (t) => 100 + 150 * (t / 0.8), () => 0.8), R);
    expect(a.kind).toBe('swept');
    expect(a.sweepCents).toBeLessThan(-100);
    expect(a.initial!.hz).toBeLessThan(a.settled!.hz);
  });

  it('a tom: a gentle 20 percent drop is a sweep of a few hundred cents', () => {
    const a = analysePitch(sweep(0.6, (t) => 120 + 30 * Math.exp(-t / 0.05), (t) => Math.exp(-t * 4)), R);
    expect(a.kind).toBe('swept');
    expect(cents(a.settled!.hz, 120)).toBeLessThan(40);
    expect(a.sweepCents).toBeGreaterThan(100);
  });

  it('a steady kick body with a tiny click on top is stable', () => {
    const a = analysePitch(make(0.6, (t, i) => Math.exp(-t * 6) * Math.sin(2 * Math.PI * 50 * t) + (i < 40 ? 0.6 : 0)), R);
    expect(a.kind).toBe('stable');
    expect(cents(a.fundamental!.hz, 50)).toBeLessThan(25);
  });
});

describe('sounds without a reliable fundamental', () => {
  it('silence', () => {
    const a = analysePitch(new Float32Array(R), R);
    expect(a.kind).toBe('silent');
    expect(a.fundamental).toBeNull();
    expect(a.confidence).toBe(0);
  });

  it('digital near-silence', () => {
    expect(analysePitch(make(0.3, () => 1e-6), R).kind).toBe('silent');
  });

  it('white noise has no note', () => {
    const a = analysePitch(noise(0.6), R);
    expect(a.kind).toBe('unpitched');
    expect(a.fundamental).toBeNull();
    expect(a.initial).toBeNull();
    expect(a.confidence).toBeLessThan(0.35);
  });

  it('a decaying noise burst (snare/hat-like) has no note', () => {
    const n = noise(0.4, 3);
    const a = analysePitch(make(0.4, (t, i) => n[i]! * Math.exp(-t * 12)), R);
    expect(a.kind).toBe('unpitched');
    expect(a.fundamental).toBeNull();
  });

  it('filtered noise (a coloured hat) has no note', () => {
    const n = noise(0.4, 11);
    let y = 0;
    const hp = make(0.4, (t, i) => {
      const o = n[i]! - y;
      y += 0.3 * o;
      return o * Math.exp(-t * 20);
    });
    expect(analysePitch(hp, R).kind).toBe('unpitched');
  });

  it('a bell with unrelated partials is inharmonic and gets no note', () => {
    const parts = [1, 2.76, 5.4, 8.93, 13.34];
    const a = analysePitch(make(0.8, (t) => parts.reduce((s, r, k) => s + Math.sin(2 * Math.PI * 300 * r * t) / (k + 1), 0) * Math.exp(-t * 3) * 0.5), R);
    expect(a.kind).toBe('inharmonic');
    expect(a.fundamental).toBeNull();
    expect(a.partials.length).toBeGreaterThanOrEqual(3);
    expect(a.confidence).toBeLessThan(0.5);
  });

  it('two unrelated tones are inharmonic', () => {
    const a = analysePitch(make(0.6, (t) => 0.5 * Math.sin(2 * Math.PI * 211 * t) + 0.5 * Math.sin(2 * Math.PI * 337 * t)), R);
    expect(a.kind).toBe('inharmonic');
    expect(a.fundamental).toBeNull();
  });

  it('FM with an irrational ratio is inharmonic', () => {
    const a = analysePitch(make(0.6, (t) => 0.7 * Math.sin(2 * Math.PI * 220 * t + 3 * Math.sin(2 * Math.PI * 220 * 2.3 * t))), R);
    expect(a.kind).toBe('inharmonic');
    expect(a.fundamental).toBeNull();
  });

  it('never invents a note for anything unpitched or inharmonic', () => {
    for (const sig of [noise(0.5, 1), noise(0.5, 2), new Float32Array(2000)]) {
      const a = analysePitch(sig, R);
      if (a.kind !== 'stable' && a.kind !== 'swept') {
        expect(a.fundamental).toBeNull();
        expect(a.settled).toBeNull();
      }
    }
  });
});

describe('result format', () => {
  it('carries the reusable fields and no synthesis state', () => {
    const a = analysePitch(make(0.5, (t) => Math.sin(2 * Math.PI * 220 * t)), R);
    expect(a.version).toBe(1);
    expect(a.method).toMatch(/YIN/);
    expect(a.fundamental).toMatchObject({ note: 'A3', midi: 57 });
    expect(Object.keys(a).sort()).toEqual(['analysed', 'confidence', 'contour', 'fundamental', 'initial', 'kind', 'method', 'partials', 'rate', 'reason', 'settleTime', 'settled', 'stability', 'sweepCents', 'version']);
    // survives JSON (it is stored beside, not inside, the project)
    expect(JSON.parse(JSON.stringify(a)).fundamental.note).toBe('A3');
  });

  it('is deterministic and leaves its input untouched', () => {
    const x = make(0.4, (t) => Math.sin(2 * Math.PI * 130 * t));
    const copy = Float32Array.from(x);
    const a = analysePitch(x, R);
    expect(analysePitch(x, R)).toEqual(a);
    expect(x).toEqual(copy);
  });

  it('averages stereo and handles a short click', () => {
    const l = make(0.5, (t) => Math.sin(2 * Math.PI * 330 * t));
    const a = analysePitch([l, l], R);
    expect(cents(a.fundamental!.hz, 330)).toBeLessThan(5);
    const click = analysePitch(make(0.01, (t) => Math.sin(2 * Math.PI * 800 * t)), R);
    expect(['stable', 'unpitched', 'inharmonic']).toContain(click.kind);
  });
});
