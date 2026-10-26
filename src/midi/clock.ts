/*
 * PulseEstimator and the transport handling of ExternalClock are adapted from The Breakery
 * (https://github.com/clickysteve/the-breakery, src/midi/clockIn.ts), Copyright (c) 2026 The
 * Breakery contributors, MIT licence (see THIRD_PARTY_NOTICES.md), itself after DOWNBEAT's
 * PulseEstimator. Modifications: CLATTER follows the tempo with a phase lock (PhaseLock) instead
 * of advancing one tick per pulse; clock loss freewheels instead of stopping.
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
/**
 * Following an external MIDI clock, on Slop Factory Core's `ClockFollower` interface.
 *
 * CLATTER is TEMPO-FOLLOWING (one of the two philosophies of Core's MIDI roadmap): the measured
 * tempo drives CLATTER's own lookahead scheduler, so the audio engine keeps its sample-accurate
 * timing, and a phase lock (PhaseLock) nudges that tempo by a few percent so that pulse n of the
 * master lands on tick n × 4 of CLATTER (24 pulses per quarter, 96 ticks per quarter).
 *
 *   FA Start      play from the top: the first F8 after it is the downbeat
 *   FB Continue   play on from where Stop left off (or from a received Song Position)
 *   FC Stop       stop, keeping the position
 *   F2 Song Pos.  while stopped, move to a position (MIDI beats: sixteenths)
 *   F8 Clock      measure the tempo; while running, lock the phase
 *
 * A clock that stops arriving (CLOCK_LOSS_MS) is LOST: CLATTER freewheels at the last tempo,
 * says so, and when pulses return it locks again to the nearest pulse (no jump back, no stop).
 */
import type { ClockFollower } from '@slopfactory/core/midi';
import { CLOCK, CONTINUE, SONG_POSITION, START, STOP } from './messages';

export const CLOCK_PPQ = 24;
export const CLOCK_LOSS_MS = 500;

const SHORT = 6;
const LONG = 48;
const GAP_FACTOR = 4;

/** Measures a 24 PPQN clock stream. */
export class PulseEstimator {
  private times: number[] = [];
  private shown: number | null = null;

  add(t: number): void {
    const last = this.times[this.times.length - 1];
    if (last !== undefined) {
      const dt = t - last;
      const p = this.periodMs();
      // a long silence (clock stopped and restarted) is not a slow tempo
      if (dt <= 0 || dt > 1000 || (p !== null && dt > p * GAP_FACTOR)) this.times = [];
    }
    this.times.push(t);
    if (this.times.length > LONG + 1) this.times.splice(0, this.times.length - (LONG + 1));
  }

  reset(): void {
    this.times = [];
    this.shown = null;
  }

  get count(): number {
    return this.times.length;
  }

  /** Mean of the last few intervals, or null. */
  periodMs(): number | null {
    const n = Math.min(SHORT, this.times.length - 1);
    if (n < 1) return null;
    return (this.times[this.times.length - 1]! - this.times[this.times.length - 1 - n]!) / n;
  }

  /** Least-squares tempo over up to two beats, or null before a quarter beat. */
  rawBpm(): number | null {
    const n = this.times.length;
    if (n - 1 < CLOCK_PPQ / 4) return null;
    const t0 = this.times[0]!;
    const mx = (n - 1) / 2;
    let my = 0;
    for (const t of this.times) my += t - t0;
    my /= n;
    let sxy = 0;
    let sxx = 0;
    for (let i = 0; i < n; i++) {
      const dx = i - mx;
      sxy += dx * (this.times[i]! - t0 - my);
      sxx += dx * dx;
    }
    const p = sxy / sxx;
    return p > 0 ? 60000 / (p * CLOCK_PPQ) : null;
  }

  /** Displayed tempo with hysteresis, so jitter does not make it flicker. */
  bpm(): number | null {
    const raw = this.rawBpm();
    if (raw === null) {
      this.shown = null;
      return null;
    }
    const tol = Math.max(0.15, raw * 0.002);
    if (this.shown === null || Math.abs(raw - this.shown) > tol) this.shown = Math.round(raw * 10) / 10;
    return this.shown;
  }
}

export interface ClockEvents {
  /** FA (from 0) or FB (from the stopped position): play from pulse `from` */
  start(from: number, continued: boolean): void;
  stop(): void;
  /** pulse `n` (counted from the start of the song) arrived at `ms` (performance.now()) */
  pulse(n: number, ms: number): void;
  /** the tempo estimate changed */
  tempo(bpm: number): void;
  /** the clock stopped arriving */
  lost(): void;
  /** status changed (display) */
  changed(): void;
}

export class ExternalClock implements ClockFollower {
  status: ClockFollower['status'] = 'off';
  bpm = 0;
  readonly pulses = new PulseEstimator();
  /** the next pulse's position from the start of the song */
  next = 0;
  running = false;
  /** follow Start/Stop/Continue (off: only the tempo) */
  transport = true;
  private lastMs = -Infinity;

  constructor(
    private events: ClockEvents,
    private now: () => number,
  ) {}

  get active(): boolean {
    return this.status !== 'off';
  }

  /** Start or stop following. */
  setActive(on: boolean): void {
    if (on === this.active) return;
    this.running = false;
    this.next = 0;
    this.pulses.reset();
    this.lastMs = -Infinity;
    this.bpm = 0;
    this.set(on ? 'waiting' : 'off');
  }

  /** A clock tempo is known (CLATTER may follow it). */
  get locked(): boolean {
    return this.active && this.bpm > 0 && this.status !== 'lost' && this.status !== 'waiting';
  }

  receive(status: number, time: number, data?: number[]): void {
    if (!this.active) return;
    const now = this.now();
    // a timestamp from the future, or long past, is not to be trusted: use now
    const t = Number.isFinite(time) && time > 0 && time <= now + 5 && time >= now - 1000 ? time : now;
    if (status === CLOCK) this.pulse(t);
    else if (!this.transport) return;
    else if (status === START) {
      this.next = 0;
      this.running = true;
      this.events.start(0, false);
      this.set('running');
    } else if (status === CONTINUE) {
      if (this.running) return;
      this.running = true;
      this.events.start(this.next, true);
      this.set('running');
    } else if (status === STOP) {
      if (!this.running) return;
      this.running = false;
      this.events.stop();
      this.set('stopped');
    } else if (status === SONG_POSITION && data && data.length >= 2 && !this.running) {
      this.next = ((data[0]! & 0x7f) | ((data[1]! & 0x7f) << 7)) * 6;
      this.events.changed();
    }
  }

  /** Raw bytes (several realtime messages may share a packet). */
  receiveBytes(bytes: ArrayLike<number>, time: number): void {
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i]!;
      if (b === SONG_POSITION) {
        if (i + 2 < bytes.length) this.receive(b, time, [bytes[i + 1]!, bytes[i + 2]!]);
        i += 2;
      } else if (b >= 0xf8) this.receive(b, time);
      else if (b >= 0x80) return;
    }
  }

  private pulse(t: number): void {
    this.pulses.add(t);
    this.lastMs = t;
    const bpm = this.pulses.bpm();
    if (bpm !== null && bpm !== this.bpm) {
      this.bpm = bpm;
      this.events.tempo(bpm);
    }
    if (bpm !== null && (this.status === 'waiting' || this.status === 'lost' || this.status === 'stopped')) this.set(this.running ? 'running' : 'detected');
    if (!this.running) return;
    const n = this.next++;
    this.events.pulse(n, t);
  }

  /** Call regularly: notices a clock that stopped arriving. */
  watch(): void {
    if (!this.active) return;
    if (this.now() - this.lastMs <= CLOCK_LOSS_MS) return;
    if (this.status === 'running' || this.status === 'detected' || this.status === 'stopped') {
      this.pulses.reset();
      if (this.status === 'running') this.events.lost();
      this.set(this.running ? 'lost' : 'waiting');
    }
  }

  private set(s: ClockFollower['status']): void {
    if (s === this.status) return;
    this.status = s;
    this.events.changed();
  }
}

/**
 * Locks CLATTER's scheduler to the master's pulses. Each pulse says where the master is (pulse n
 * = tick n × ticksPerPulse); the scheduler says where CLATTER is at that moment. The tempo sent
 * to the scheduler is the measured tempo, corrected by a proportional term so the error closes
 * within about a beat, limited to ±maxCorrection (so a tempo change is never audible as a jump).
 * An error larger than `relockTicks` (after a loss, or a master that jumped) re-anchors instead:
 * the master's pulse count is offset so CLATTER carries on from where it is.
 */
export class PhaseLock {
  /** added to the master's pulse ticks (re-anchoring) */
  offset = 0;
  /** the last error, in ticks (positive: CLATTER is ahead) */
  error = 0;
  constructor(
    readonly ticksPerPulse = 4,
    readonly gain = 0.35,
    readonly maxCorrection = 0.05,
    readonly relockTicks = 48,
  ) {}

  reset(offset = 0): void {
    this.offset = offset;
    this.error = 0;
  }

  /** The tempo to run at, given the master's pulse n and CLATTER's tick at the pulse's time. */
  correct(bpm: number, n: number, tickAtPulse: number, ppq: number): number {
    let err = tickAtPulse - (n * this.ticksPerPulse + this.offset);
    if (Math.abs(err) > this.relockTicks) {
      // re-anchor to the nearest pulse: no jump in what is playing
      this.offset = Math.round((tickAtPulse - n * this.ticksPerPulse) / this.ticksPerPulse) * this.ticksPerPulse;
      err = tickAtPulse - (n * this.ticksPerPulse + this.offset);
    }
    this.error = err;
    const c = Math.max(-this.maxCorrection, Math.min(this.maxCorrection, (-err / ppq) * this.gain));
    return bpm * (1 + c);
  }
}
