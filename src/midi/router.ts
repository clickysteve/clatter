/**
 * Track notes out: each scheduled hit of a track routed to MIDI (or BOTH) becomes a timestamped
 * note-on and note-off on the note-safe output (output.ts). The router remembers, per track,
 * which notes are still to end, so muting a track, changing its routing, its channel or its
 * note ends exactly that track's notes at once, without touching the others.
 *
 * Note-offs are handed to the device with the note-on (both timestamped, inside the
 * scheduler's lookahead), so a busy main thread can never stretch a note.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import { noteOff } from './messages';
import type { MidiOutput } from './output';

interface Sounding {
  track: number;
  channel: number;
  note: number;
  /** note-off time (performance.now() ms) */
  off: number;
}

/** AUTO note length: the hit's own gate, else half a step, never under 10 ms. */
export function noteLength(lenMs: number | undefined, gateMs: number | undefined, stepMs: number): number {
  if (lenMs && lenMs > 0) return Math.max(5, lenMs);
  if (gateMs && gateMs > 0) return Math.max(10, gateMs);
  return Math.max(10, stepMs / 2);
}

export class TrackRouter {
  private sounding: Sounding[] = [];
  /** notes sent (diagnostics, activity) */
  sent = 0;

  constructor(
    private out: MidiOutput,
    private now: () => number,
  ) {}

  /** A hit as a note: on at `at`, off `lengthMs` later (timestamps in performance.now() ms). */
  play(track: number, channel: number, note: number, vel: number, at: number, lengthMs: number): void {
    if (!this.out.device) return;
    const id = this.out.noteOn(channel, note, vel, at);
    const off = at + Math.max(5, lengthMs);
    this.out.noteOff(channel, note, id, off);
    this.sent++;
    this.prune();
    this.sounding.push({ track, channel, note, off });
  }

  private prune(): void {
    if (this.sounding.length < 64) return;
    const n = this.now();
    this.sounding = this.sounding.filter((s) => s.off > n);
  }

  /** Notes of a track still to end. */
  pending(track: number): number {
    const n = this.now();
    return this.sounding.filter((s) => s.track === track && s.off > n).length;
  }

  /**
   * End a track's notes now (mute, routing or note change). The queued note-offs still arrive
   * later and are harmless; a note-on already queued inside the lookahead plays and ends on its
   * own note-off.
   */
  releaseTrack(track: number): void {
    const n = this.now();
    const done = new Set<number>();
    for (const s of this.sounding) {
      if (s.track !== track || s.off <= n) continue;
      const key = s.channel * 128 + s.note;
      if (done.has(key)) continue;
      done.add(key);
      this.out.send(noteOff(s.channel, s.note), n);
    }
    this.sounding = this.sounding.filter((s) => s.track !== track);
  }

  /** Forget everything (the output released all its notes: stop, panic, device change). */
  clear(): void {
    this.sounding = [];
  }
}
