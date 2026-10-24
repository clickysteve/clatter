/*
 * From DOWNBEAT (https://github.com/clickysteve/downbeat, src/midi/webmidi.ts),
 * Copyright (c) 2026 The DOWNBEAT contributors, MIT licence (see THIRD_PARTY_NOTICES.md).
 * Modifications: messages name CLATTER; ports typed with Slop Factory Core's MidiPortInfo.
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
/**
 * Web MIDI access: device discovery, hot-plug, one output and one input.
 *
 * CLATTER never requires a device. Without Web MIDI (or with access refused)
 * the instrument still plays through its internal sounds.
 */
import type { MidiSink } from './output';

export type MidiState = 'unsupported' | 'idle' | 'pending' | 'denied' | 'ready';

export interface PortInfo {
  id: string;
  name: string;
  connected: boolean;
}

export interface MidiAccessEvents {
  onPorts(): void;
  onOutputLost(id: string): void;
  onOutputReturned(id: string): void;
  onInputLost(id: string): void;
  onInputReturned(id: string): void;
}

export type InputHandler = (data: Uint8Array, timeStamp: number) => void;

class WebMidiSink implements MidiSink {
  constructor(private port: MIDIOutput) {}
  get id(): string {
    return this.port.id;
  }
  get name(): string {
    return this.port.name ?? this.port.id;
  }
  send(bytes: number[], timestamp?: number): void {
    this.port.send(bytes, timestamp);
  }
  clear(): void {
    const p = this.port as MIDIOutput & { clear?: () => void };
    if (typeof p.clear === 'function') p.clear();
  }
}

export class MidiAccess {
  access: MIDIAccess | null = null;
  state: MidiState = MidiAccess.supported() ? 'idle' : 'unsupported';
  message = MidiAccess.supported() ? 'MIDI not yet enabled' : 'This browser has no Web MIDI. Internal sounds still work; use Chrome, Edge or Firefox for MIDI.';
  private outId: string | null = null;
  private outLost = false;
  private inId: string | null = null;
  private inLost = false;
  private handler: InputHandler | null = null;
  private attached: MIDIInput | null = null;

  constructor(private events: MidiAccessEvents) {}

  static supported(): boolean {
    return typeof navigator !== 'undefined' && typeof navigator.requestMIDIAccess === 'function';
  }

  async request(): Promise<MidiState> {
    if (!MidiAccess.supported()) return this.state;
    if (this.access) return this.state;
    this.state = 'pending';
    this.message = 'Asking the browser for MIDI access…';
    this.events.onPorts();
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false });
    } catch (err) {
      this.state = 'denied';
      this.message = `MIDI access was refused (${err instanceof Error ? err.message : String(err)}). Allow MIDI for this site to use external instruments.`;
      this.events.onPorts();
      return this.state;
    }
    this.access.onstatechange = (e: Event) => this.handleState(e as MIDIConnectionEvent);
    this.state = 'ready';
    this.message = 'MIDI ready';
    this.attach();
    this.events.onPorts();
    return this.state;
  }

  outputs(): PortInfo[] {
    const list: PortInfo[] = [];
    this.access?.outputs.forEach((p) => list.push({ id: p.id, name: p.name ?? p.id, connected: p.state === 'connected' }));
    return list;
  }

  inputs(): PortInfo[] {
    const list: PortInfo[] = [];
    this.access?.inputs.forEach((p) => list.push({ id: p.id, name: p.name ?? p.id, connected: p.state === 'connected' }));
    return list;
  }

  /** Open an output by id. Returns a sink, or null when unavailable. */
  openOutput(id: string | null): MidiSink | null {
    this.outId = id;
    this.outLost = false;
    if (!id || !this.access) return null;
    const port = this.access.outputs.get(id);
    if (!port || port.state !== 'connected') return null;
    return new WebMidiSink(port);
  }

  /** Listen to one input (null to stop). Re-attaches automatically when replugged. */
  openInput(id: string | null, handler: InputHandler | null): boolean {
    this.detach();
    this.inId = id;
    this.handler = handler;
    this.inLost = false;
    return this.attach();
  }

  get inputReady(): boolean {
    return !!this.attached;
  }

  private attach(): boolean {
    if (!this.access || !this.inId || !this.handler) return false;
    const port = this.access.inputs.get(this.inId);
    if (!port || port.state !== 'connected') return false;
    const h = this.handler;
    port.onmidimessage = (e: MIDIMessageEvent) => {
      if (e.data) h(e.data, e.timeStamp);
    };
    this.attached = port;
    return true;
  }

  private detach(): void {
    if (this.attached) this.attached.onmidimessage = null;
    this.attached = null;
  }

  private handleState(e: MIDIConnectionEvent): void {
    const port = e.port;
    if (port?.type === 'input' && port.id === this.inId) {
      if (port.state === 'disconnected' && !this.inLost) {
        this.inLost = true;
        this.detach();
        this.events.onInputLost(port.id);
      } else if (port.state === 'connected' && this.inLost) {
        this.inLost = false;
        if (this.attach()) this.events.onInputReturned(port.id);
      }
    }
    if (port?.type === 'output' && port.id === this.outId) {
      if (port.state === 'disconnected' && !this.outLost) {
        this.outLost = true;
        this.events.onOutputLost(port.id);
      } else if (port.state === 'connected' && this.outLost) {
        this.outLost = false;
        this.events.onOutputReturned(port.id);
      }
    }
    this.events.onPorts();
  }
}
