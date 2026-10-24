/**
 * CLATTER's MIDI: one output (notes per track, clock, transport) and one input (notes from
 * pads or keyboards trigger tracks; clock and Start/Stop follow an external master).
 *
 * Built on DOWNBEAT's Web MIDI access and note-safe output (webmidi.ts, output.ts) and typed
 * with Slop Factory Core's MIDI interfaces (MidiOutputPort, ClockFollower, MidiPortInfo). The
 * clock follower is tempo-following (as emmm's): the estimated tempo drives CLATTER's own
 * scheduler, so the audio engine keeps its sample-accurate timing.
 *
 * Nothing here is required: without Web MIDI or a device, CLATTER plays its own sounds.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import type { ClockFollower } from '@slopfactory/core/midi';
import { CLOCK, CONTINUE, START, STOP } from './messages';
import { MidiOutput } from './output';
import { MidiAccess, type MidiState, type PortInfo } from './webmidi';

/** Tempo from incoming MIDI clock (24 per quarter): a trimmed mean of recent intervals. */
export class TempoFollower implements ClockFollower {
  status: ClockFollower['status'] = 'off';
  bpm = 0;
  private times: number[] = [];
  private last = 0;

  constructor(
    private onTempo: (bpm: number) => void,
    private onTransport: (msg: 'start' | 'stop' | 'continue') => void,
  ) {}

  receive(status: number, time: number): void {
    if (status === CLOCK) {
      if (this.status === 'off' || this.status === 'lost' || this.status === 'stopped') this.status = 'waiting';
      if (this.last && time - this.last < 500) {
        this.times.push(time - this.last);
        if (this.times.length > 48) this.times.shift();
        if (this.times.length >= 12) {
          const sorted = [...this.times].sort((a, b) => a - b);
          const trim = Math.floor(sorted.length * 0.2);
          const mid = sorted.slice(trim, sorted.length - trim);
          const avg = mid.reduce((a, b) => a + b, 0) / mid.length;
          const bpm = Math.round((60000 / (avg * 24)) * 10) / 10;
          if (bpm >= 30 && bpm <= 300 && Math.abs(bpm - this.bpm) >= 0.3) {
            this.bpm = bpm;
            this.onTempo(bpm);
          }
          if (this.status === 'waiting') this.status = 'detected';
        }
      }
      this.last = time;
    } else if (status === START) {
      this.status = 'running';
      this.onTransport('start');
    } else if (status === CONTINUE) {
      this.status = 'running';
      this.onTransport('continue');
    } else if (status === STOP) {
      this.status = 'stopped';
      this.onTransport('stop');
    }
  }

  /** Call regularly: no clock for a while means the master went away. */
  check(now: number): void {
    if (this.last && now - this.last > 600 && this.status !== 'off') {
      this.status = 'lost';
      this.times = [];
      this.last = 0;
    }
  }
}

export interface MidiPrefs {
  outId: string | null;
  inId: string | null;
  /** send notes for every hit */
  notesOut: boolean;
  /** send MIDI clock and Start/Stop */
  clockOut: boolean;
  /** follow incoming clock and Start/Stop */
  clockIn: boolean;
  /** play tracks from incoming notes */
  notesIn: boolean;
  /** input channel (0 = any) */
  inChannel: number;
}

export const defaultMidiPrefs = (): MidiPrefs => ({ outId: null, inId: null, notesOut: true, clockOut: false, clockIn: false, notesIn: true, inChannel: 0 });

export interface MidiHandlers {
  /** a note arrived: (channel 1-16, note, velocity) */
  note(channel: number, note: number, vel: number): void;
  tempo(bpm: number): void;
  transport(msg: 'start' | 'stop' | 'continue'): void;
  changed(): void;
  message?(text: string): void;
}

export class MidiController {
  readonly access: MidiAccess;
  readonly out: MidiOutput;
  readonly follower: TempoFollower;
  prefs: MidiPrefs;
  /** recent messages for the monitor */
  log: string[] = [];

  constructor(
    private h: MidiHandlers,
    prefs: MidiPrefs,
  ) {
    this.prefs = { ...defaultMidiPrefs(), ...prefs };
    this.out = new MidiOutput(() => performance.now());
    this.follower = new TempoFollower(
      (b) => this.prefs.clockIn && h.tempo(b),
      (m) => this.prefs.clockIn && h.transport(m),
    );
    this.access = new MidiAccess({
      onPorts: () => h.changed(),
      onOutputLost: () => {
        this.out.deviceLost();
        h.message?.('MIDI OUTPUT DISCONNECTED');
        h.changed();
      },
      onOutputReturned: (id) => {
        this.out.setSink(this.access.openOutput(id));
        h.message?.('MIDI OUTPUT RECONNECTED');
        h.changed();
      },
      onInputLost: () => {
        h.message?.('MIDI INPUT DISCONNECTED');
        h.changed();
      },
      onInputReturned: () => {
        h.message?.('MIDI INPUT RECONNECTED');
        h.changed();
      },
    });
  }

  get state(): MidiState {
    return this.access.state;
  }

  get supported(): boolean {
    return MidiAccess.supported();
  }

  async enable(): Promise<MidiState> {
    const s = await this.access.request();
    if (s === 'ready') {
      this.selectOutput(this.prefs.outId);
      this.selectInput(this.prefs.inId);
    }
    this.h.changed();
    return s;
  }

  outputs(): PortInfo[] {
    return this.access.outputs();
  }

  inputs(): PortInfo[] {
    return this.access.inputs();
  }

  selectOutput(id: string | null): void {
    this.prefs.outId = id;
    this.out.setSink(this.access.openOutput(id));
    this.h.changed();
  }

  selectInput(id: string | null): void {
    this.prefs.inId = id;
    this.access.openInput(id, (data, ts) => this.receive(data, ts));
    this.h.changed();
  }

  private receive(data: Uint8Array, ts: number): void {
    const s = data[0] ?? 0;
    if (s >= 0xf8 || s === 0xf2) {
      this.follower.receive(s, ts);
      return;
    }
    const type = s & 0xf0;
    const ch = (s & 0x0f) + 1;
    if (this.prefs.inChannel && ch !== this.prefs.inChannel) return;
    if (type === 0x90 && (data[2] ?? 0) > 0) {
      this.pushLog(`IN  CH${ch} NOTE ${data[1]} VEL ${data[2]}`);
      if (this.prefs.notesIn) this.h.note(ch, data[1] ?? 0, data[2] ?? 0);
    }
  }

  private pushLog(t: string): void {
    this.log.push(t);
    if (this.log.length > 40) this.log.shift();
  }

  /** A hit as a MIDI note (timestamp in performance.now() ms). */
  note(channel: number, note: number, vel: number, at: number, lengthMs = 60): void {
    if (!this.prefs.notesOut || !this.out.device) return;
    const id = this.out.noteOn(channel, note, vel, at);
    this.out.noteOff(channel, note, id, at + lengthMs);
  }

  clock(times: number[]): void {
    if (!this.prefs.clockOut || !this.out.device) return;
    for (const t of times) this.out.send([CLOCK], t);
  }

  start(at: number): void {
    if (this.prefs.clockOut && this.out.device) this.out.send([START], at);
  }

  stop(): void {
    if (this.out.device) {
      if (this.prefs.clockOut) this.out.send([STOP]);
      this.out.releaseAll(true);
    }
  }

  panic(): void {
    this.out.panic();
  }
}
