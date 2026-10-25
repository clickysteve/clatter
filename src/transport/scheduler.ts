/**
 * The transport: a lookahead scheduler on the audio clock.
 *
 * Musical time is ticks (PPQ per quarter) since START. A ticker (a Worker, so background tabs
 * keep time) calls pump() every ~25 ms; pump() plans every event from the HORIZON (what has
 * been scheduled) up to now + LOOKAHEAD and hands them, with exact AudioContext times, to the
 * engine and to MIDI. Musical timing never depends on animation frames: the playhead is only
 * drawn from the same clock.
 *
 * The approach follows DOWNBEAT's and The Breakery's transports (a worker ticker, a tempo
 * anchor, nothing scheduled twice): see THIRD_PARTY_NOTICES.md. Specifically:
 *
 *   - Cycles. A cycle is one pass of a pattern. Each cycle is planned when the horizon reaches
 *     it: the provider says which pattern plays (queued switch, chain) and how long it is.
 *   - Changes. Any change of state bumps a version; the current cycle is realised again and
 *     the events not yet scheduled come from the new realisation. Events already scheduled are
 *     never withdrawn or sent again (per-cycle sent keys), so an edit is heard within one
 *     lookahead window, without double triggers or dropped notes.
 *   - Quantised actions. at('bar', fn) runs fn when planning reaches the next bar line (or
 *     step, beat, pattern end), before anything at or after that line is scheduled, so a
 *     transformation or a snapshot lands exactly on the boundary.
 *   - Tempo. A tempo change re-anchors at the horizon: no gap, no overlap. Tempo automation
 *     (the `tempo` option) is the same thing done at every TEMPO_GRID boundary: planning stops
 *     there, asks for the tempo of the next cell and re-anchors, so time is piecewise linear in
 *     ticks and the playhead, MIDI clock and offline render all agree.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import { PPQ, type Quantize } from '../model/types';
import { TEMPO_GRID } from './tempo';
import type { PerfEvent } from '../rhythm/events';

export interface PlannedCycle {
  /** the pattern that plays */
  pattern: string;
  /** cycle length in ticks */
  ticks: number;
}

export interface CycleSource {
  /** which pattern plays cycle k, and how long it is (called once per cycle) */
  plan(k: number): PlannedCycle;
  /** the events of cycle k of a pattern (ticks from the cycle start), for the current state */
  events(k: number, pattern: string): readonly PerfEvent[];
}

export interface ScheduledEvent {
  time: number;
  /** absolute tick since START */
  tick: number;
  cycle: number;
  event: PerfEvent;
}

export interface SchedulerOptions {
  now: () => number;
  emit: (events: ScheduledEvent[]) => void;
  /** MIDI clock pulses (24 per quarter), with their times */
  clock?: (times: number[]) => void;
  /** a new cycle starts (for display and evolution) */
  onCycle?: (k: number, c: PlannedCycle, time: number) => void;
  /** bar lines as they are scheduled (sound evolution, chain) */
  onBar?: (bar: number, time: number, tick: number) => void;
  /** tempo automation: the BPM at a tick, or null for the plain tempo (see src/transport/tempo.ts) */
  tempo?: (tick: number) => number | null;
  /** the tempo automation changed the tempo (the engine follows it for tempo-synced effects) */
  onTempo?: (bpm: number, time: number) => void;
  lookahead?: number;
  /** delay from START to the first beat (seconds) */
  startDelay?: number;
}

interface CycleState {
  k: number;
  start: number;
  plan: PlannedCycle;
  sent: Set<string>;
  version: number;
  events: readonly PerfEvent[];
}

const PULSE = PPQ / 24;
const BAR = PPQ * 4;

/** From `tick` on (at `time`) a tick lasts `spt` seconds. */
interface Segment {
  tick: number;
  time: number;
  spt: number;
}

export class Scheduler {
  /** the plain tempo; the tempo in force can differ while tempo automation runs (see spt) */
  bpm = 120;
  running = false;
  private cur = 120;
  private segs: Segment[] = [{ tick: 0, time: 0, spt: 0.5 / PPQ }];
  /** ticks planned so far */
  horizon = 0;
  private cycles: CycleState[] = [];
  private version = 0;
  private pending: { tick: number; fn: () => void }[] = [];
  private nextPulse = 0;
  private nextBar = 0;
  readonly lookahead: number;

  constructor(
    private source: CycleSource,
    private o: SchedulerOptions,
  ) {
    this.lookahead = o.lookahead ?? 0.12;
  }

  /** Seconds per tick, at the horizon. */
  get spt(): number {
    return 60 / (this.cur * PPQ);
  }

  /** The tempo in force at the horizon. */
  get currentBpm(): number {
    return this.cur;
  }

  timeOf(tick: number): number {
    const segs = this.segs;
    let i = segs.length - 1;
    while (i > 0 && segs[i]!.tick > tick) i--;
    const s = segs[i]!;
    return s.time + (tick - s.tick) * s.spt;
  }

  tickAt(time: number): number {
    const segs = this.segs;
    let i = segs.length - 1;
    while (i > 0 && segs[i]!.time > time) i--;
    const s = segs[i]!;
    return s.tick + (time - s.time) / s.spt;
  }

  /** From the horizon on, ticks last as long as `bpm` says. */
  private retime(bpm: number): void {
    const tick = this.horizon;
    const time = this.timeOf(tick);
    this.cur = bpm;
    const last = this.segs[this.segs.length - 1]!;
    const seg = { tick, time, spt: 60 / (bpm * PPQ) };
    if (last.tick === tick) this.segs[this.segs.length - 1] = seg;
    else this.segs.push(seg);
    if (this.segs.length > 512) this.segs.splice(0, this.segs.length - 256);
  }

  start(atTime?: number): void {
    this.running = true;
    this.cur = this.o.tempo?.(0) ?? this.bpm;
    this.segs = [{ tick: 0, time: atTime ?? this.o.now() + (this.o.startDelay ?? 0.06), spt: 60 / (this.cur * PPQ) }];
    this.horizon = 0;
    this.cycles = [];
    this.pending = [];
    this.nextPulse = 0;
    this.nextBar = 0;
    this.pump();
  }

  stop(): void {
    this.running = false;
    this.cycles = [];
    this.pending = [];
  }

  setTempo(bpm: number): void {
    const b = Math.max(20, Math.min(400, bpm));
    if (b === this.bpm && b === this.cur) return;
    this.bpm = b;
    // with tempo automation the next cell asks for its own tempo; without, the new one holds from here
    if (this.running) this.retime(this.o.tempo?.(this.horizon) ?? b);
    else this.cur = this.o.tempo?.(0) ?? b;
  }

  /** Tempo automation was changed, switched on or off: follow it from the horizon. */
  retempo(): void {
    if (this.running) this.followTempo();
    else this.cur = this.o.tempo?.(0) ?? this.bpm;
  }

  private followTempo(): void {
    const want = this.o.tempo?.(this.horizon) ?? this.bpm;
    if (Math.abs(want - this.cur) < 1e-9) return;
    this.retime(want);
    this.o.onTempo?.(want, this.timeOf(this.horizon));
  }

  /** The state changed: unscheduled events of the current and future cycles are realised again. */
  invalidate(): void {
    this.version++;
  }

  /** The cycle playing at a tick (display). */
  cycleAt(tick: number): { k: number; start: number; plan: PlannedCycle } | null {
    for (let i = this.cycles.length - 1; i >= 0; i--) {
      const c = this.cycles[i]!;
      if (tick >= c.start) return c;
    }
    return this.cycles[0] ?? null;
  }

  /** The absolute tick of the next boundary at or after the horizon. */
  boundary(q: Quantize): number {
    const h = this.horizon;
    const c = this.cycleAt(h);
    const cs = c ? c.start : 0;
    const ce = c ? c.start + c.plan.ticks : h;
    const rel = h - cs;
    const up = (unit: number) => cs + Math.ceil(rel / unit - 1e-9) * unit;
    switch (q) {
      case 'step':
        return up(PPQ / 4);
      case 'beat':
        return Math.min(up(PPQ), ce);
      case 'bar':
        return Math.min(up(BAR), ce);
      default:
        return rel <= 1e-9 ? cs : ce;
    }
  }

  /** Run fn at the next boundary (immediately when stopped). */
  at(q: Quantize, fn: () => void): number {
    if (!this.running) {
      fn();
      return 0;
    }
    const tick = this.boundary(q);
    this.pending.push({ tick, fn });
    this.pending.sort((a, b) => a.tick - b.tick);
    return tick;
  }

  /** Queued quantised actions (display). */
  get queued(): number {
    return this.pending.length;
  }

  private cycleFor(tick: number): CycleState {
    let last = this.cycles[this.cycles.length - 1];
    if (!last) {
      const plan = this.source.plan(0);
      last = { k: 0, start: 0, plan, sent: new Set(), version: -1, events: [] };
      this.cycles.push(last);
      this.o.onCycle?.(0, plan, this.timeOf(0));
    }
    while (tick >= last.start + last.plan.ticks) {
      const k: number = last.k + 1;
      const start: number = last.start + last.plan.ticks;
      const plan = this.source.plan(k);
      last = { k, start, plan, sent: new Set(), version: -1, events: [] };
      this.cycles.push(last);
      this.o.onCycle?.(k, plan, this.timeOf(start));
    }
    // forget cycles well behind
    while (this.cycles.length > 4) this.cycles.shift();
    for (let i = this.cycles.length - 1; i >= 0; i--) if (tick >= this.cycles[i]!.start) return this.cycles[i]!;
    return this.cycles[0]!;
  }

  /** Plan up to now + lookahead. */
  pump(): void {
    if (!this.running) return;
    const until = this.tickAt(this.o.now() + this.lookahead);
    let guard = 0;
    while (this.horizon < until && guard++ < 1000) {
      // the next stop: a quantised action, a cycle end, or the target
      let stopAt = until;
      if (this.pending.length && this.pending[0]!.tick < stopAt) stopAt = Math.max(this.horizon, this.pending[0]!.tick);
      this.followTempo();
      if (this.o.tempo) {
        const cell = (Math.floor(this.horizon / TEMPO_GRID + 1e-9) + 1) * TEMPO_GRID;
        if (cell < stopAt) stopAt = cell;
      }
      const c = this.cycleFor(this.horizon);
      const ce = c.start + c.plan.ticks;
      if (ce < stopAt) stopAt = ce;
      if (stopAt <= this.horizon && this.pending.length && this.pending[0]!.tick <= this.horizon) {
        const p = this.pending.shift()!;
        p.fn();
        continue;
      }
      this.planRange(c, this.horizon, stopAt);
      this.horizon = stopAt;
      while (this.pending.length && this.pending[0]!.tick <= this.horizon) this.pending.shift()!.fn();
    }
  }

  private planRange(c: CycleState, from: number, to: number): void {
    if (c.version !== this.version) {
      c.events = this.source.events(c.k, c.plan.pattern);
      c.version = this.version;
    }
    const out: ScheduledEvent[] = [];
    for (const e of c.events) {
      const tick = c.start + e.tick;
      if (tick < from - 1e-9 || tick >= to - 1e-9) continue;
      if (c.sent.has(e.key)) continue;
      c.sent.add(e.key);
      out.push({ time: this.timeOf(tick), tick, cycle: c.k, event: e });
    }
    if (out.length) this.o.emit(out);
    // bar lines and MIDI clock in this range
    while (this.nextBar < to - 1e-9) {
      if (this.nextBar >= from - 1e-9) this.o.onBar?.(Math.round(this.nextBar / BAR), this.timeOf(this.nextBar), this.nextBar);
      this.nextBar += BAR;
    }
    if (this.o.clock) {
      const pulses: number[] = [];
      while (this.nextPulse < to - 1e-9) {
        if (this.nextPulse >= from - 1e-9) pulses.push(this.timeOf(this.nextPulse));
        this.nextPulse += PULSE;
      }
      if (pulses.length) this.o.clock(pulses);
    } else {
      while (this.nextPulse < to) this.nextPulse += PULSE;
    }
  }
}

/** A ticker in a Worker: background tabs throttle it far less than main-thread timers. */
export function startTicker(fn: () => void, ms = 25): () => void {
  try {
    const src = `let t=null;onmessage=(e)=>{if(e.data==='stop'){clearInterval(t);t=null;}else{clearInterval(t);t=setInterval(()=>postMessage(0),${ms});}}`;
    const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    const w = new Worker(url);
    w.onmessage = () => fn();
    w.postMessage('start');
    return () => {
      w.postMessage('stop');
      w.terminate();
      URL.revokeObjectURL(url);
    };
  } catch {
    const id = setInterval(fn, ms);
    return () => clearInterval(id);
  }
}
