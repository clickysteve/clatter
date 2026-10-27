/** TEMPO AUTOMATION: the curve, the scheduler's clock, offline rendering, the MIDI tempo map, the app. */
import { describe, expect, it } from 'vitest';
import { bundledLibrary, lxrModule, presetProject } from './helpers';
import { App } from '../src/app/app';
import { renderProject } from '../src/audio/render';
import { exportMidi } from '../src/export/midiFile';
import { PPQ, type Project } from '../src/model/types';
import { parseProject, serialize } from '../src/model/project';
import { Scheduler, type ScheduledEvent } from '../src/transport/scheduler';
import { bpmAt, mulAtBar, repairTempoAuto, secondsAt, TEMPO_GRID, tempoChanges, type TempoAuto } from '../src/transport/tempo';
import type { PerfEvent } from '../src/rhythm/events';

const BAR = PPQ * 4;
const stepUp: TempoAuto = { on: true, bars: 4, points: [{ bar: 0, mul: 1 }, { bar: 2, mul: 1.5 }] };
const ramp: TempoAuto = { on: true, bars: 4, points: [{ bar: 0, mul: 1, ramp: true }, { bar: 2, mul: 1.5 }] };

describe('the tempo curve', () => {
  it('holds a step until the next point and glides over a ramp, looping', () => {
    expect([0, 1, 1.99, 2, 3.9].map((b) => mulAtBar(stepUp, b))).toEqual([1, 1, 1, 1.5, 1.5]);
    expect(mulAtBar(ramp, 1)).toBeCloseTo(1.25, 6);
    expect(mulAtBar(ramp, 2)).toBeCloseTo(1.5, 6);
    expect(mulAtBar(ramp, 3.99)).toBeCloseTo(1.5, 6); // the last point holds until the loop starts again
    expect(bpmAt(100, ramp, 4 * BAR)).toBe(100);
    const back: TempoAuto = { on: true, bars: 4, points: [{ bar: 0, mul: 1 }, { bar: 2, mul: 1.5, ramp: true }] };
    expect(mulAtBar(back, 3)).toBeCloseTo(1.25, 6); // the last point glides back to the first
  });

  it('scales the BPM, stays inside the limits and is the BPM itself when off', () => {
    expect(bpmAt(120, stepUp, 0)).toBe(120);
    expect(bpmAt(120, stepUp, 2 * BAR)).toBe(180);
    expect(bpmAt(120, stepUp, 4 * BAR)).toBe(120);
    expect(bpmAt(250, stepUp, 2 * BAR)).toBe(300);
    expect(bpmAt(120, { ...stepUp, on: false }, 2 * BAR)).toBe(120);
    expect(bpmAt(120, undefined, 5000)).toBe(120);
  });

  it('adds up seconds the way the scheduler counts them', () => {
    expect(secondsAt(120, undefined, 4 * BAR)).toBeCloseTo(8, 9);
    expect(secondsAt(120, stepUp, 2 * BAR)).toBeCloseTo(4, 9);
    expect(secondsAt(120, stepUp, 4 * BAR)).toBeCloseTo(4 + 8 / 3, 9);
    expect(secondsAt(120, ramp, 4 * BAR)).toBeGreaterThan(secondsAt(120, stepUp, 4 * BAR) - 1.2);
  });

  it('is repaired: sorted, starting at bar 0, multipliers inside 0.5-2', () => {
    const r = repairTempoAuto({ on: true, bars: 4, points: [{ bar: 3, mul: 9 }, { bar: 1, mul: 0.1, ramp: true }, { bar: 1, mul: 1 }, 'x'] })!;
    expect(r.points[0]!.bar).toBe(0);
    expect(r.points.every((p) => p.mul >= 0.5 && p.mul <= 2)).toBe(true);
    expect(r.points.map((p) => p.bar)).toEqual([0, 3]);
    expect(repairTempoAuto({ points: [] })).toBeUndefined();
    expect(repairTempoAuto(null)).toBeUndefined();
  });

  it('lists the tempo changes for a MIDI file', () => {
    const c = tempoChanges(120, stepUp, 4 * BAR);
    expect(c[0]).toEqual({ tick: 0, bpm: 120 });
    expect(c[1]).toEqual({ tick: 2 * BAR, bpm: 180 });
    expect(c).toHaveLength(2);
    expect(tempoChanges(120, undefined, 4 * BAR)).toEqual([{ tick: 0, bpm: 120 }]);
  });
});

function quarters(bars: number): PerfEvent[] {
  const evs: PerfEvent[] = [];
  for (let i = 0; i < bars * 4; i++) evs.push({ key: `a|${i}`, tick: i * PPQ, track: 'a', vel: 100, pitch: 0, kind: 'source', origin: i, step: i * 4 });
  return evs;
}

describe('the scheduler follows the curve', () => {
  function run(auto: TempoAuto | undefined, bars = 4, dt = 0.01) {
    let now = 0;
    const out: ScheduledEvent[] = [];
    const tempos: [number, number][] = [];
    const s = new Scheduler(
      { plan: () => ({ pattern: 'p', ticks: bars * BAR }), events: () => quarters(bars) },
      {
        now: () => now,
        emit: (e) => out.push(...e),
        startDelay: 0,
        tempo: auto ? (t) => bpmAt(120, auto, t) : undefined,
        onTempo: (b, t) => tempos.push([b, t]),
      },
    );
    s.bpm = 120;
    s.start(0);
    while (now < secondsAt(120, auto, bars * BAR) + 0.5) {
      now += dt;
      s.pump();
    }
    return { s, out, tempos };
  }

  it('without a curve nothing changes: quarters every half second', () => {
    const { out } = run(undefined);
    expect(out.slice(0, 5).map((e) => e.time)).toEqual([0, 0.5, 1, 1.5, 2]);
  });

  it('a step: the beats before bar 3 are 0.5 s apart and after it 1/3 s apart', () => {
    const { out, tempos } = run(stepUp);
    const t = out.map((e) => e.time);
    expect(t[7]).toBeCloseTo(3.5, 9);
    expect(t[8]).toBeCloseTo(4, 9); // bar 3 beat 1: exactly where the tempo changes
    expect(t[9]! - t[8]!).toBeCloseTo(1 / 3, 9);
    expect(t[15]! - t[14]!).toBeCloseTo(1 / 3, 9);
    expect(tempos.map((x) => x[0])).toContain(180);
    expect(tempos[0]![1]).toBeCloseTo(4, 9);
  });

  it('every event lands at exactly the time the curve says, ramps included, whatever the pump interval', () => {
    for (const auto of [stepUp, ramp]) {
      for (const dt of [0.003, 0.025, 0.09]) {
        const out = run(auto, 4, dt).out.filter((e) => e.cycle === 0);
        expect(out.length).toBe(16);
        for (const e of out) expect(e.time).toBeCloseTo(secondsAt(120, auto, e.tick), 9);
      }
    }
  });

  it('the clock maps ticks to seconds and back across the tempo change', () => {
    const { s } = run(ramp);
    for (const tick of [0, 100, 500, 800, 1200, 1500]) expect(s.tickAt(s.timeOf(tick))).toBeCloseTo(tick, 6);
    expect(s.timeOf(1536)).toBeCloseTo(secondsAt(120, ramp, 1536), 6);
  });

  it('a manual tempo change still works with no curve', () => {
    let now = 0;
    const out: ScheduledEvent[] = [];
    const s = new Scheduler({ plan: () => ({ pattern: 'p', ticks: 4 * BAR }), events: () => quarters(4) }, { now: () => now, emit: (e) => out.push(...e), startDelay: 0 });
    s.bpm = 120;
    s.start(0);
    while (now < 1.2) {
      now += 0.01;
      s.pump();
    }
    s.setTempo(240);
    while (now < 5) {
      now += 0.01;
      s.pump();
    }
    const t = out.map((e) => e.time);
    expect(t[1]! - t[0]!).toBeCloseTo(0.5, 9);
    expect(t[t.length - 1]! - t[t.length - 2]!).toBeCloseTo(0.25, 9);
  });
});

/** Where a new sound starts in a stem: the peak level of a short block jumps to well over anything in the 35 ms before. */
function onsets(x: Float32Array, rate: number, minGap = 0.05, thresh = 0.05): number[] {
  const B = 128;
  const env: number[] = [];
  for (let i = 0; i + B <= x.length; i += B) {
    let m = 0;
    for (let j = 0; j < B; j++) m = Math.max(m, Math.abs(x[i + j]!));
    env.push(m);
  }
  const out: number[] = [];
  for (let b = 0; b < env.length; b++) {
    const before = Math.max(0, ...env.slice(Math.max(0, b - 12), b));
    if (env[b]! > thresh && env[b]! > 2 * before && (!out.length || (b * B - out[out.length - 1]!) / rate >= minGap)) out.push(b * B);
  }
  return out;
}

async function kickOnly(bars: number, auto?: TempoAuto) {
  const lib = await bundledLibrary();
  const p: Project = await presetProject('machine-room', lib);
  p.tempo = 120;
  p.swing = 50;
  const pat = p.patterns[0]!;
  p.patterns = [pat];
  p.current = pat.id;
  pat.steps = 16;
  pat.res = 4;
  delete pat.sounds;
  delete pat.trig;
  for (const t of p.tracks) {
    t.play = { density: 100, fill: 0, humanize: 0, chance: 100, length: 0 };
    pat.grids[t.id] = Array.from({ length: 16 }, (_, i) => (t.id === 't1' && i % 4 === 0 ? { vel: 120 } : null));
  }
  p.destruction.chop.on = p.destruction.rolls.on = p.destruction.destroy.on = false;
  p.evolve.target = 'off';
  if (auto) p.tempoAuto = auto;
  void bars;
  return { lib, p };
}

describe('offline export follows the curve', () => {
  it('a tempo step changes where the beats fall and how long the file is', async () => {
    const { lib, p } = await kickOnly(4, stepUp);
    const r = await renderProject(lxrModule(), p, lib, { bars: 4, tail: 0, stems: true });
    expect(r.frames).toBe(Math.round(secondsAt(120, stepUp, 4 * BAR) * r.rate));
    const on = onsets(r.stems['t1']![0]!, r.rate);
    expect(on).toHaveLength(16);
    on.forEach((s, i) => {
      const want = secondsAt(120, stepUp, i * PPQ) * r.rate;
      expect(Math.abs(s - want)).toBeLessThan(0.006 * r.rate); // within 6 ms (the attack of the sound)
    });
    // before the change the beats are 0.5 s apart, after it 1/3 s
    expect((on[1]! - on[0]!) / r.rate).toBeCloseTo(0.5, 1);
    expect((on[12]! - on[11]!) / r.rate).toBeCloseTo(1 / 3, 1);
    // the same project without a curve is longer and has no such change
    const plain = await renderProject(lxrModule(), { ...p, tempoAuto: undefined }, lib, { bars: 4, tail: 0 });
    expect(plain.frames).toBe(Math.round(8 * plain.rate));
    expect(r.frames).toBeLessThan(plain.frames);
  });

  it('a ramp slows the gaps between beats gradually', async () => {
    const { lib, p } = await kickOnly(4, { on: true, bars: 4, points: [{ bar: 0, mul: 1, ramp: true }, { bar: 4, mul: 1 }] });
    p.tempoAuto = { on: true, bars: 4, points: [{ bar: 0, mul: 1, ramp: true }, { bar: 2, mul: 1.5 }] };
    const r = await renderProject(lxrModule(), p, lib, { bars: 2, tail: 0, stems: true });
    const on = onsets(r.stems['t1']![0]!, r.rate, 0.05);
    const gaps = on.slice(1).map((v, i) => (v - on[i]!) / r.rate);
    expect(gaps).toHaveLength(7);
    for (let i = 1; i < gaps.length; i++) expect(gaps[i]!).toBeLessThan(gaps[i - 1]! + 1e-3); // faster and faster
    expect(gaps[0]!).toBeGreaterThan(gaps[6]! + 0.05);
  });

  it('the tail comes after the music, and the same project renders the same file', async () => {
    const { lib, p } = await kickOnly(2, stepUp);
    const a = await renderProject(lxrModule(), p, lib, { bars: 2, tail: 1 });
    const b = await renderProject(lxrModule(), p, lib, { bars: 2, tail: 1 });
    expect(a.frames).toBe(Math.round(secondsAt(120, stepUp, 2 * BAR) * a.rate) + a.rate);
    expect(Buffer.from(a.master[0]!.buffer, a.master[0]!.byteOffset, a.master[0]!.byteLength).equals(Buffer.from(b.master[0]!.buffer, b.master[0]!.byteOffset, b.master[0]!.byteLength))).toBe(true);
  });

  it('conditions and a curve together: every cycle is evaluated at its own tempo', async () => {
    const { lib, p } = await kickOnly(4, stepUp);
    p.patterns[0]!.trig = { t1: { 4: { k: 'even' } } };
    p.patterns[0]!.grids['t1']![4] = { vel: 120 };
    const r = await renderProject(lxrModule(), p, lib, { bars: 4, tail: 0, stems: true });
    // a bar per cycle: all four beats play, except beat 2 (step 4, EVEN) which sounds in the 2nd and 4th bars only
    const on = onsets(r.stems['t1']![0]!, r.rate);
    expect(on).toHaveLength(14);
    // beat 2 of bars 1 and 3 is missing: after the first beat the next onset is a whole beat later
    expect((on[1]! - on[0]!) / r.rate).toBeCloseTo(1, 1);
  });

  it('the MIDI file carries the tempo map', async () => {
    const { p } = await kickOnly(4, stepUp);
    const midi = exportMidi(p, { bars: 4 });
    const tempos: number[] = [];
    for (let i = 0; i < midi.length - 5; i++) if (midi[i] === 0xff && midi[i + 1] === 0x51 && midi[i + 2] === 3) tempos.push((midi[i + 3]! << 16) | (midi[i + 4]! << 8) | midi[i + 5]!);
    expect(tempos).toEqual([500000, 333333]);
    const plain = exportMidi({ ...p, tempoAuto: undefined }, { bars: 4 });
    let n = 0;
    for (let i = 0; i < plain.length - 2; i++) if (plain[i] === 0xff && plain[i + 1] === 0x51) n++;
    expect(n).toBe(1);
  });
});

describe('the project and the app', () => {
  it('a curve is saved, loaded, and absent in older projects', async () => {
    const { p } = await kickOnly(2, stepUp);
    const back = parseProject(serialize(p));
    expect(back.tempoAuto).toEqual(stepUp);
    const old = JSON.parse(serialize(p));
    delete old.tempoAuto;
    old.version = 3;
    expect(parseProject(JSON.stringify(old)).tempoAuto).toBeUndefined();
  });

  it('setting, switching off and clearing the curve are undoable and reach the scheduler', () => {
    const app = new App();
    app.project.tempo = 100;
    expect(app.effectiveBpm()).toBe(100);
    app.setTempoAuto(stepUp);
    expect(app.project.tempoAuto).toEqual(stepUp);
    expect(app.scheduler.currentBpm).toBe(100); // bar 1 of the curve
    app.toggleTempoAuto();
    expect(app.project.tempoAuto!.on).toBe(false);
    app.undo();
    expect(app.project.tempoAuto!.on).toBe(true);
    app.undo();
    expect(app.project.tempoAuto).toBeUndefined();
    app.redo();
    expect(app.project.tempoAuto).toEqual(stepUp);
    // the scheduler's tempo function is the curve times the BPM
    const s = (app.scheduler as unknown as { o: { tempo: (t: number) => number | null } }).o;
    expect(s.tempo(2 * BAR)).toBe(150);
    app.toggleTempoAuto();
    expect(s.tempo(2 * BAR)).toBeNull();
  });
});

void TEMPO_GRID;
