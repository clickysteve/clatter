/**
 * Incoming channel messages: the channel filter, the note map (which pads play which tracks),
 * velocity sensitivity, MIDI Learn and the monitor. Pure: no Web MIDI, no audio; the controller
 * feeds it bytes and it calls back.
 *
 *   note on     → every track whose input note it is (a duplicate plays both, and is shown)
 *   learn armed → the next note on is that track's note (or the next CC that macro's CC)
 *   CC          → a macro, if one learned it
 *
 * An unmapped note plays nothing: CLATTER does not assume General MIDI. It is shown in the
 * monitor as UNMAPPED so the user knows to map or learn it.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import { noteName } from './messages';
import { NO_NOTE, OMNI, scaleVelocity, type MidiPrefs } from './settings';

export type LearnTarget = { kind: 'track'; index: number } | { kind: 'macro'; index: number };

export interface InputHandlers {
  /** play a track (position in the project) at a velocity */
  trigger(track: number, vel: number): void;
  /** a macro (0-3) moved to 0-1 */
  macro?(index: number, value: number): void;
  /** MIDI Learn finished: the preferences changed */
  learned(target: LearnTarget, text: string): void;
}

export interface InputActivity {
  /** performance.now() of the last message */
  at: number;
  text: string;
}

/** The monitor keeps this many lines. */
const LOG = 24;

export class InputRouter {
  learn: LearnTarget | null = null;
  /** recent messages, newest last */
  readonly log: string[] = [];
  last: InputActivity | null = null;
  /** messages received (diagnostics) */
  count = 0;

  constructor(
    private prefs: () => MidiPrefs,
    private tracks: () => number,
    private h: InputHandlers,
  ) {}

  /** Arm MIDI Learn (null cancels). */
  arm(t: LearnTarget | null): void {
    this.learn = t;
  }

  /** One channel message (several may share a packet: each is handled). */
  receive(data: ArrayLike<number>, now: number): void {
    let i = 0;
    while (i < data.length) {
      const s = data[i]!;
      if (s < 0x80) {
        i++;
        continue;
      }
      if (s >= 0xf0) return; // system messages are the clock's
      const type = s & 0xf0;
      const len = type === 0xc0 || type === 0xd0 ? 2 : 3;
      this.message(s, data[i + 1] ?? 0, data[i + 2] ?? 0, now);
      i += len;
    }
  }

  private message(s: number, a: number, b: number, now: number): void {
    const p = this.prefs();
    const type = s & 0xf0;
    const ch = (s & 0x0f) + 1;
    this.count++;
    const filtered = p.inChannel !== OMNI && ch !== p.inChannel;
    if (type === 0x90 && b > 0) {
      if (filtered) return this.show(now, `CH${ch} ${noteName(a)} (${a}) VEL ${b} · FILTERED`);
      if (this.learn?.kind === 'track') {
        const t = this.learn;
        p.inMap[t.index] = a;
        this.learn = null;
        const text = `LEARNED ${noteName(a)} (${a}) FOR TRACK ${t.index + 1}`;
        this.show(now, text);
        this.h.learned(t, text);
        return;
      }
      const vel = scaleVelocity(b, p.velSens, p.velFixed);
      const hits: number[] = [];
      if (p.notesIn) for (let t = 0; t < Math.min(this.tracks(), p.inMap.length); t++) if (p.inMap[t] === a && a !== NO_NOTE) hits.push(t);
      this.show(now, `CH${ch} ${noteName(a)} (${a}) VEL ${b}${hits.length ? ` → ${hits.map((t) => 'T' + (t + 1)).join('+')}${vel !== b ? ` @${vel}` : ''}` : p.notesIn ? ' · UNMAPPED' : ' · NOTES IN OFF'}`);
      for (const t of hits) this.h.trigger(t, vel);
      return;
    }
    if (type === 0xb0) {
      if (filtered) return;
      if (this.learn?.kind === 'macro') {
        const t = this.learn;
        p.macroLearn[t.index] = { channel: p.inChannel === OMNI ? null : ch, number: a };
        this.learn = null;
        const text = `LEARNED CC ${a} FOR MACRO ${t.index + 1}`;
        this.show(now, text);
        this.h.learned(t, text);
        return;
      }
      let used = false;
      p.macroLearn.forEach((m, i) => {
        if (m && m.number === a && (m.channel === null || m.channel === ch)) {
          used = true;
          this.h.macro?.(i, b / 127);
        }
      });
      this.show(now, `CH${ch} CC ${a} = ${b}${used ? ' → MACRO' : ''}`);
    }
    // note off, aftertouch, pitch bend: drums ignore them
  }

  private show(now: number, text: string): void {
    this.last = { at: now, text };
    this.log.push(text);
    if (this.log.length > LOG) this.log.shift();
  }
}
