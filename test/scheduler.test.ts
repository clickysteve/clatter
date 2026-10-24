/** TRANSPORT: step timing, no double triggers or drops, changes, quantised actions, tempo. */
import { describe, expect, it } from 'vitest';
import { Scheduler, type ScheduledEvent } from '../src/transport/scheduler';
import type { PerfEvent } from '../src/rhythm/events';
import { PPQ } from '../src/model/types';

const T = PPQ / 4;
function ev(step: number, track = 'a', vel = 100): PerfEvent {
  return { key: `${track}|${step}`, tick: step * T, track, vel, pitch: 0, kind: 'source', origin: step, step };
}

function rig(steps = 16, events: () => PerfEvent[] = () => [0, 4, 8, 12].map((s) => ev(s))) {
  let now = 0;
  const out: ScheduledEvent[] = [];
  const s = new Scheduler(
    { plan: () => ({ pattern: 'p', ticks: steps * T }), events: () => events() },
    { now: () => now, emit: (e) => out.push(...e), startDelay: 0 },
  );
  const run = (seconds: number, dt = 0.025) => {
    const end = now + seconds;
    while (now < end) {
      now += dt;
      s.pump();
    }
  };
  return { s, out, run, setNow: (t: number) => (now = t) };
}

describe('scheduler', () => {
  it('schedules steps at exact times (120 BPM: a sixteenth is 125 ms)', () => {
    const { s, out, run } = rig();
    s.bpm = 120;
    s.start(0);
    run(4.1);
    const times = out.map((e) => e.time);
    expect(times.slice(0, 9)).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4]);
  });

  it('never sends an event twice and never drops one, whatever the window size', () => {
    for (const dt of [0.003, 0.017, 0.025, 0.09]) {
      const { s, out, run } = rig();
      s.start(0);
      run(10, dt);
      const keys = out.map((e) => `${e.cycle}:${e.event.key}`);
      expect(new Set(keys).size).toBe(keys.length);
      const expected = Math.floor(10.1 / 2) * 4; // 4 hits per 2-second bar at 120 BPM
      expect(Math.abs(out.length - expected)).toBeLessThanOrEqual(4);
      // no drift: event n is at n * 0.5 s
      out.forEach((e, n) => expect(e.time).toBeCloseTo(n * 0.5, 9));
    }
  });

  it('applies a change within one lookahead window, without repeating sent events', () => {
    let events = [0, 4, 8, 12].map((s) => ev(s));
    const { s, out, run } = rig(16, () => events);
    s.start(0);
    run(0.6);
    events = [0, 2, 4, 6, 8, 10, 12, 14].map((x) => ev(x));
    s.invalidate();
    run(1.5);
    const firstCycle = out.filter((e) => e.cycle === 0).map((e) => e.event.step);
    expect(firstCycle).toEqual([0, 4, 6, 8, 10, 12, 14]);
  });

  it('runs a quantised action exactly on the next bar line', () => {
    const { s, run } = rig(32);
    s.start(0);
    run(0.3);
    let at = -1;
    const tick = s.at('bar', () => (at = s.horizon));
    expect(tick).toBe(PPQ * 4);
    run(3);
    expect(at).toBe(PPQ * 4);
  });

  it('keeps time across a tempo change (no gap, no overlap)', () => {
    const { s, out, run } = rig(16, () => Array.from({ length: 16 }, (_, i) => ev(i)));
    s.start(0);
    run(1);
    s.setTempo(60);
    run(4);
    const t = out.map((e) => e.time);
    for (let i = 1; i < t.length; i++) {
      const d = t[i]! - t[i - 1]!;
      expect(d).toBeGreaterThan(0.124);
      expect(d).toBeLessThan(0.2501);
    }
  });

  it('moves to the next cycle (pattern) seamlessly', () => {
    const plans = ['A', 'B', 'A'];
    let now = 0;
    const out: ScheduledEvent[] = [];
    const s = new Scheduler(
      { plan: (k) => ({ pattern: plans[k % 3]!, ticks: (plans[k % 3] === 'A' ? 16 : 8) * T }), events: (_k, p) => (p === 'A' ? [ev(0, 'A')] : [ev(0, 'B'), ev(4, 'B')]) },
      { now: () => now, emit: (e) => out.push(...e) },
    );
    s.start(0);
    while (now < 6) {
      now += 0.02;
      s.pump();
    }
    expect(out.slice(0, 4).map((e) => `${e.event.track}@${e.time}`)).toEqual(['A@0', 'B@2', 'B@2.5', 'A@3']);
  });
});
