/**
 * CLATTER's MIDI: one note output (each track INTERNAL, MIDI or BOTH, with its own channel, note
 * and length), clock and transport out, MIDI CC out from the modulation matrix, and input from one
 * device or ALL INPUTS (notes play tracks through an editable map with MIDI Learn and velocity
 * sensitivity; clock, Start, Stop, Continue and Song Position follow an external master).
 *
 * Built on DOWNBEAT's Web MIDI access and note-safe output (webmidi.ts, output.ts), The
 * Breakery's clock estimator (clock.ts), and typed with Slop Factory Core's MIDI interfaces
 * (MidiOutputPort, ClockFollower). Each concern is its own module so it can be tested without a
 * browser: settings.ts (what is saved where), input.ts, router.ts, clock.ts, ccOut.ts.
 *
 * Nothing here is required: without Web MIDI or a device, CLATTER plays its own sounds.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import type { CcSlot } from '../model/types';
import { CcRunner } from './ccOut';
import { ExternalClock } from './clock';
import { InputRouter, type LearnTarget } from './input';
import { CLOCK, CONTINUE, controlChange, describe, songPosition, START, STOP } from './messages';
import { MidiOutput, type MidiSink } from './output';
import { TrackRouter } from './router';
import { ALL_INPUTS, CC_SLOTS, findDevice, repairMidiPrefs, type ClockMode, type DeviceRef, type MidiPrefs } from './settings';
import { MidiAccess, type MidiState, type PortInfo } from './webmidi';

export { defaultMidiPrefs, type MidiPrefs } from './settings';

export interface MidiHandlers {
  /** an incoming note plays a track (position in the project) */
  trigger(track: number, vel: number): void;
  /** a learned CC moved a macro (0-3) to 0-1 */
  macro?(index: number, value: number): void;
  /** how many tracks the project has */
  trackCount(): number;
  /** EXTERNAL clock: Start (from 0) or Continue (from `pulse`) */
  extStart(pulse: number, continued: boolean): void;
  extStop(): void;
  /** EXTERNAL clock: pulse n arrived at `ms` (performance.now()) */
  extPulse(n: number, ms: number): void;
  extTempo(bpm: number): void;
  extLost(): void;
  /** preferences or state changed (save, redraw) */
  changed(): void;
  message?(text: string): void;
}

export interface Activity {
  at: number;
  text: string;
}

export class MidiController {
  readonly access: MidiAccess;
  readonly out: MidiOutput;
  readonly router: TrackRouter;
  readonly input: InputRouter;
  readonly clock: ExternalClock;
  readonly cc = new CcRunner();
  prefs: MidiPrefs;
  /** the last message sent (not clock) */
  outLast: Activity | null = null;
  /** clock pulses sent (diagnostics) */
  clockSent = 0;
  private ccSinks = new Map<string, MidiSink>();
  /** constructing: the owner is not ready for notifications yet */
  private booting = true;

  constructor(
    private h: MidiHandlers,
    prefs: unknown,
    private now: () => number = () => performance.now(),
  ) {
    this.prefs = repairMidiPrefs(prefs);
    this.out = new MidiOutput(now);
    this.router = new TrackRouter(this.out, now);
    this.out.tap((bytes, t) => {
      if (bytes[0] === CLOCK) return;
      this.outLast = { at: Math.min(t, this.now()), text: describe(bytes).toUpperCase() };
    });
    this.input = new InputRouter(() => this.prefs, () => h.trackCount(), {
      trigger: (t, v) => h.trigger(t, v),
      macro: (i, v) => h.macro?.(i, v),
      learned: (_t, text) => {
        h.message?.(text);
        h.changed();
      },
    });
    this.clock = new ExternalClock(
      {
        start: (from, continued) => h.extStart(from, continued),
        stop: () => h.extStop(),
        pulse: (n, ms) => h.extPulse(n, ms),
        tempo: (bpm) => h.extTempo(bpm),
        lost: () => {
          h.message?.('MIDI CLOCK LOST: FREEWHEELING AT THE LAST TEMPO');
          h.extLost();
        },
        changed: () => {
          if (!this.booting) h.changed();
        },
      },
      now,
    );
    this.clock.transport = this.prefs.followTransport;
    this.clock.setActive(this.prefs.clock === 'external');
    this.booting = false;
    this.access = new MidiAccess({
      onPorts: () => {
        this.restore();
        h.changed();
      },
      onOutputLost: () => {
        this.out.deviceLost();
        this.router.clear();
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
      this.openOutput();
      this.openInput();
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

  /** The output in use (connected), or null. */
  get outputName(): string | null {
    return this.out.device ? this.out.device.name : null;
  }

  /** Is the preferred output missing (remembered but not connected)? */
  get outputMissing(): boolean {
    return !!this.prefs.out && !this.out.device;
  }

  get inputMissing(): boolean {
    return !!this.prefs.input && !this.access.inputReady && this.state === 'ready';
  }

  private openOutput(): void {
    const port = findDevice(this.prefs.out, this.outputs());
    this.out.setSink(port ? this.access.openOutput(port.id) : this.access.openOutput(this.prefs.out?.id ?? null));
    if (!this.out.device) this.router.clear();
  }

  private openInput(): void {
    const i = this.prefs.input;
    const handler = (d: Uint8Array, ts: number) => this.receive(d, ts);
    if (i === ALL_INPUTS) this.access.openInput(ALL_INPUTS, handler);
    else {
      const port = findDevice(i, this.inputs());
      this.access.openInput(port?.id ?? i?.id ?? null, i ? handler : null);
    }
  }

  /** A remembered device came back (perhaps under another id): use it again. */
  private restore(): void {
    if (this.state !== 'ready') return;
    if (this.prefs.out && !this.out.device && findDevice(this.prefs.out, this.outputs())) this.openOutput();
    if (this.prefs.input && this.prefs.input !== ALL_INPUTS && !this.access.inputReady && findDevice(this.prefs.input, this.inputs())) this.openInput();
    this.ccSinks.clear();
  }

  selectOutput(port: DeviceRef | null): void {
    this.prefs.out = port ? { id: port.id, name: port.name } : null;
    this.router.clear();
    this.openOutput();
    this.h.changed();
  }

  selectInput(port: DeviceRef | typeof ALL_INPUTS | null): void {
    this.prefs.input = port === ALL_INPUTS ? ALL_INPUTS : port ? { id: port.id, name: port.name } : null;
    this.openInput();
    this.h.changed();
  }

  /** Change preferences that need no device work (channel, velocity, flags), then save. */
  update(p: Partial<MidiPrefs>): void {
    Object.assign(this.prefs, p);
    this.clock.transport = this.prefs.followTransport;
    this.h.changed();
  }

  setClockMode(mode: ClockMode): void {
    if (this.prefs.clock === mode) return;
    this.prefs.clock = mode;
    this.clock.setActive(mode === 'external');
    this.h.changed();
  }

  /** CLATTER follows an external clock that is present now. */
  get following(): boolean {
    return this.prefs.clock === 'external' && this.clock.locked;
  }

  /** Clock goes out: INTERNAL mode, clock on, a device. */
  get sendingClock(): boolean {
    return this.prefs.clock === 'internal' && this.prefs.sendClock && !!this.out.device;
  }

  private get sendingTransport(): boolean {
    return this.prefs.clock === 'internal' && this.prefs.sendTransport && !!this.out.device;
  }

  armLearn(t: LearnTarget | null): void {
    this.input.arm(t);
    this.h.changed();
  }

  private receive(data: Uint8Array, ts: number): void {
    const s = data[0] ?? 0;
    if (s >= 0xf8 || s === 0xf2) {
      if (this.prefs.clock === 'external') this.clock.receiveBytes(data, ts);
      return;
    }
    this.input.receive(data, this.now());
  }

  /** Feed bytes as if received (tests, virtual devices). */
  inject(data: number[], ts = this.now()): void {
    this.receive(Uint8Array.from(data), ts);
  }

  // ---------------------------------------------------------------- output

  /** A track hit as a note (timestamps in performance.now() ms). */
  note(track: number, channel: number, note: number, vel: number, at: number, lengthMs: number): void {
    if (!this.prefs.notesOut) return;
    this.router.play(track, channel, note, vel, at, lengthMs);
  }

  /** End a track's notes now (mute, routing, channel or note change). */
  releaseTrack(track: number): void {
    this.router.releaseTrack(track);
  }

  clockOut(times: number[]): void {
    if (!this.sendingClock) return;
    for (const t of times) this.out.send([CLOCK], t);
    this.clockSent += times.length;
  }

  /** Transport started: Start from the top, or Song Position and Continue from a position (in pulses). */
  start(at: number, fromPulse = 0): void {
    if (!this.sendingTransport) return;
    if (fromPulse > 0) {
      this.out.send(songPosition(fromPulse / 6), at - 1);
      this.out.send([CONTINUE], at);
    } else this.out.send([START], at);
  }

  /** Transport stopped (or paused, keeping the position for Continue). Every note ends. */
  stop(paused = false): void {
    if (this.out.device) {
      if (this.sendingTransport) {
        this.out.send([STOP]);
        if (!paused) this.out.send(songPosition(0));
      }
      this.out.releaseAll(true);
    }
    this.router.clear();
  }

  panic(): void {
    this.out.panic();
    this.router.clear();
  }

  /** A CC destination's value, to its device (or the output) at audio-mapped `atMs`. */
  sendCc(slot: number, cfg: CcSlot, value: number, atMs: number): void {
    const ref = this.prefs.ccOut[slot] ?? null;
    const bytes = controlChange(cfg.channel, cfg.cc, value);
    if (!ref) {
      this.out.send(bytes, atMs);
      return;
    }
    let sink = this.ccSinks.get(ref.id);
    if (!sink) {
      const port = findDevice(ref, this.outputs());
      const s = port ? this.access.sink(port.id) : null;
      if (!s) return;
      sink = s;
      this.ccSinks.set(ref.id, s);
    }
    try {
      sink.send(bytes, atMs);
      this.outLast = { at: this.now(), text: describe(bytes).toUpperCase() };
    } catch {
      this.ccSinks.delete(ref.id);
    }
  }

  /** CC slots that have a device of their own that is missing. */
  ccMissing(): number[] {
    const out: number[] = [];
    for (let i = 0; i < CC_SLOTS; i++) {
      const r = this.prefs.ccOut[i];
      if (r && !findDevice(r, this.outputs())) out.push(i);
    }
    return out;
  }
}
