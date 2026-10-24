/*
 * From DOWNBEAT (https://github.com/clickysteve/downbeat, src/midi/output.ts),
 * Copyright (c) 2026 The DOWNBEAT contributors, MIT licence (see THIRD_PARTY_NOTICES.md).
 * Modifications: the sink type is Slop Factory Core's MidiOutputPort.
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
/**
 * MIDI output with note-safety guarantees.
 *
 * Every note-on gets an id. A (channel, note) pair is released only when
 * every id holding it has been released, so two voices sharing a channel and
 * note (a fill borrowing a sound, a flam) never cut each other, and a stale
 * note-off (after a panic or a device change) is ignored instead of cutting a
 * newer note. A repeated note-on for a held pair is preceded by a note-off,
 * so drum machines retrigger cleanly.
 *
 * The output remembers the latest timestamp handed to the device. If the
 * device cannot cancel queued messages (no `clear()`), emergency note-offs
 * are stamped after everything already queued so they cannot be overtaken.
 */
import { allNotesOff, allSoundOff, noteOff, noteOn } from './messages';

import type { MidiOutputPort } from '@slopfactory/core/midi';

/** Anything that can receive timestamped MIDI bytes (a Web MIDI port, a test double): Core's MidiOutputPort. */
export type MidiSink = MidiOutputPort;

/** A tap sees every message sent, whether or not a device is connected. */
export type MidiTap = (bytes: number[], timestamp: number) => void;

interface Held {
  channel: number;
  note: number;
  ids: Set<number>;
}

export class MidiOutput {
  private sink: MidiSink | null = null;
  private held = new Map<number, Held>();
  private taps = new Set<MidiTap>();
  private clearListeners = new Set<() => void>();
  private nextId = 1;
  private latestQueued = 0;
  /** Note-offs handed to the device for the future; a clear() would drop them. */
  private queuedOffs = new Map<number, number>();
  /** Send failures (diagnostics). */
  errors = 0;
  /** Messages handed to the device (diagnostics). */
  sent = 0;

  constructor(private now: () => number) {}

  get device(): MidiSink | null {
    return this.sink;
  }

  tap(fn: MidiTap): () => void {
    this.taps.add(fn);
    return () => this.taps.delete(fn);
  }

  /** Called whenever queued messages are cancelled (stop, panic, device switch). */
  onClear(fn: () => void): () => void {
    this.clearListeners.add(fn);
    return () => this.clearListeners.delete(fn);
  }

  /** Switch device. Notes held on the old device are released there first. */
  setSink(sink: MidiSink | null): void {
    if (this.sink === sink) return;
    if (this.sink) this.releaseAll(true);
    this.sink = sink;
    this.latestQueued = 0;
  }

  /** The current device vanished: nothing can be sent to it, so forget its notes. */
  deviceLost(): void {
    const old = this.sink;
    this.sink = null;
    if (old) {
      const t = this.now();
      for (const h of this.held.values()) this.emitTaps(noteOff(h.channel, h.note), t);
      this.held.clear();
      this.queuedOffs.clear();
    }
  }

  /** Raw send (clock, transport, program change). */
  send(bytes: number[], timestamp = this.now()): void {
    if (this.sink) {
      try {
        this.sink.send(bytes, timestamp);
        this.sent++;
        if (timestamp > this.latestQueued) this.latestQueued = timestamp;
      } catch {
        this.errors++;
      }
    }
    this.emitTaps(bytes, timestamp);
  }

  private emitTaps(bytes: number[], t: number): void {
    for (const fn of this.taps) fn(bytes, t);
  }

  /** Start a note; returns its id. Retriggers if the pair is already held. */
  noteOn(channel: number, note: number, velocity: number, timestamp: number): number {
    const key = channel * 128 + note;
    const id = this.nextId++;
    if (this.queuedOffs.size > 64) {
      const n = this.now();
      for (const [k, at] of this.queuedOffs) if (at <= n) this.queuedOffs.delete(k);
    }
    const h = this.held.get(key);
    if (h && h.ids.size > 0) {
      this.send(noteOff(channel, note), timestamp);
      h.ids.add(id);
    } else {
      this.held.set(key, { channel, note, ids: new Set([id]) });
    }
    this.send(noteOn(channel, note, velocity), timestamp);
    return id;
  }

  /** Release a note by id. Unknown or already released ids are ignored. */
  noteOff(channel: number, note: number, id: number, timestamp: number): void {
    const key = channel * 128 + note;
    const h = this.held.get(key);
    if (!h || !h.ids.delete(id)) return;
    if (h.ids.size === 0) {
      this.held.delete(key);
      this.send(noteOff(channel, note), timestamp);
      if (timestamp > this.now()) this.queuedOffs.set(key, Math.max(timestamp, this.queuedOffs.get(key) ?? 0));
    }
  }

  heldCount(): number {
    return this.held.size;
  }

  /**
   * Release everything now. With `cancelQueued`, ask the device to drop queued
   * messages first; if it cannot, the note-offs are stamped after the latest
   * queued message so a pending note-on cannot overtake them.
   */
  releaseAll(cancelQueued: boolean): void {
    let t = this.now();
    const release = new Map<number, { channel: number; note: number }>();
    for (const [k, h] of this.held) release.set(k, h);
    if (cancelQueued && this.sink && typeof this.sink.clear === 'function') {
      try {
        this.sink.clear();
        this.latestQueued = 0;
        for (const [k, at] of this.queuedOffs) {
          if (at > t) release.set(k, { channel: Math.floor(k / 128), note: k % 128 });
        }
      } catch {
        this.errors++;
      }
    }
    this.queuedOffs.clear();
    if (cancelQueued) for (const fn of this.clearListeners) fn();
    if (this.latestQueued > t) t = this.latestQueued + 1;
    this.held.clear();
    for (const h of release.values()) this.send(noteOff(h.channel, h.note), t);
  }

  /** Panic: release tracked notes, then All Notes Off / All Sound Off on every channel. */
  panic(): void {
    this.releaseAll(true);
    const t = Math.max(this.now(), this.latestQueued + 1);
    for (let c = 1; c <= 16; c++) {
      this.send(allNotesOff(c), t);
      this.send(allSoundOff(c), t);
    }
  }
}
