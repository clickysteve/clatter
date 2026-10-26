/**
 * MIDI CC out from the modulation matrix.
 *
 * A route to MIDI CC 1-4 (registry destinations `midi.cc1`..`midi.cc4`) is executed here, on the
 * main thread, never in the AudioWorklet: each track that has such a route gets its own
 * ModRuntime (the same plain-TypeScript executor the engine runs), fed with the track's hits at
 * their scheduled times and advanced in 5 ms control steps up to the scheduler's lookahead. Each
 * step's value is quantised to the slot's resolution and sent, timestamped, only when it changed
 * and no sooner than the slot's rate allows (a change held back by the rate is sent when it may
 * be). So an LFO on a CC is smooth but never floods the hardware, and a still source sends
 * nothing at all.
 *
 *   CC value = base + (sum of the tracks' routes to the slot) × 127, clamped to 0-127
 *
 * The sources run on the musical clock: LFOs in sync mode follow the tempo, envelopes start on
 * the track's hits. Variation modulation overrides are not applied here (the base modulation
 * drives the CC).
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import { ModRuntime } from '../mod/runtime';
import { DEST_INDEX, MIDI_CC_DESTS } from '../mod/registry';
import type { TrackMod } from '../mod/types';
import type { CcSlot } from '../model/types';

const STEP = 0.005;
const DI = MIDI_CC_DESTS.map((id) => DEST_INDEX.get(id)!);

/** A value 0-127 at a resolution of `res` distinct values. */
export function quantiseCc(v: number, res: number): number {
  const c = Math.max(0, Math.min(127, v));
  const n = Math.max(2, Math.min(128, Math.round(res)));
  if (n >= 128) return Math.round(c);
  return Math.round((Math.round((c / 127) * (n - 1)) * 127) / (n - 1));
}

/** Does a modulation config route to any MIDI CC destination? */
export function usesCc(m: TrackMod | undefined): boolean {
  return ccSlotsOf(m).length > 0;
}

/** The CC slots (0-3) a modulation config routes to. */
export function ccSlotsOf(m: TrackMod | undefined): number[] {
  if (!m) return [];
  const out = new Set<number>();
  for (const r of m.routes) {
    const i = (MIDI_CC_DESTS as readonly string[]).indexOf(r.dst);
    if (i >= 0 && r.on && r.amt !== 0) out.add(i);
  }
  return [...out];
}

interface Lane {
  rt: ModRuntime;
  hits: { time: number; vel: number; barSec: number; patSec: number }[];
}

interface SlotState {
  last: number;
  lastAt: number;
}

export type CcSend = (slot: number, cfg: CcSlot, value: number, time: number) => void;

export class CcRunner {
  private lanes = new Map<number, Lane>();
  /** slots some route drives (a slot nobody routes to never sends) */
  private used = new Set<number>();
  private state: SlotState[] = MIDI_CC_DESTS.map(() => ({ last: -1, lastAt: -Infinity }));
  /** the time the runtimes have been advanced to (audio seconds) */
  private cursor = -1;
  /** messages sent (diagnostics) */
  sent = 0;

  /** Which tracks drive a CC, and with what (keeps running sources where the config is unchanged). */
  configure(mods: (TrackMod | undefined)[], bpm: number): void {
    const keep = new Set<number>();
    this.used.clear();
    mods.forEach((m, i) => {
      const slots = ccSlotsOf(m);
      if (!slots.length) return;
      for (const s of slots) this.used.add(s);
      keep.add(i);
      let lane = this.lanes.get(i);
      if (!lane) {
        lane = { rt: new ModRuntime(1 + i), hits: [] };
        this.lanes.set(i, lane);
        lane.rt.setConfig(m!);
      } else lane.rt.setConfig(m!, true);
      lane.rt.setBpm(bpm);
    });
    for (const i of [...this.lanes.keys()]) if (!keep.has(i)) this.lanes.delete(i);
  }

  get active(): boolean {
    return this.lanes.size > 0;
  }

  setBpm(bpm: number): void {
    for (const l of this.lanes.values()) l.rt.setBpm(bpm);
  }

  /** A track hit at audio time `time` (from the scheduler, before it sounds). */
  hit(track: number, time: number, vel: number, barSec = 0, patSec = 0): void {
    const l = this.lanes.get(track);
    if (l) l.hits.push({ time, vel, barSec, patSec });
  }

  /** Transport start (or stop): sources restart, nothing is held back. */
  reset(time: number): void {
    this.cursor = time;
    for (const l of this.lanes.values()) {
      l.hits = [];
      l.rt.setConfig(l.rt.cfg);
    }
    for (const s of this.state) s.lastAt = -Infinity;
  }

  /** Advance to audio time `until`, sending the CCs that changed. */
  run(until: number, slots: readonly CcSlot[], macros: Float32Array, send: CcSend): void {
    if (!this.lanes.size) return;
    if (this.cursor < 0) this.cursor = until;
    for (const l of this.lanes.values()) l.hits.sort((a, b) => a.time - b.time);
    let guard = 0;
    while (this.cursor + STEP <= until && guard++ < 2000) {
      const t = this.cursor + STEP;
      const sum = [0, 0, 0, 0];
      for (const l of this.lanes.values()) {
        while (l.hits.length && l.hits[0]!.time <= t) {
          const h = l.hits.shift()!;
          l.rt.trigger(h.vel, { barSec: h.barSec, patSec: h.patSec }, macros);
        }
        l.rt.advance(STEP, macros);
        for (let s = 0; s < DI.length; s++) sum[s]! += l.rt.dest[DI[s]!]!;
      }
      for (let s = 0; s < DI.length; s++) this.emit(s, slots[s], Math.max(-1, Math.min(1, sum[s]!)), t, send);
      this.cursor = t;
    }
    if (guard >= 2000) this.cursor = until;
  }

  private emit(s: number, cfg: CcSlot | undefined, mod: number, t: number, send: CcSend): void {
    if (!cfg || !cfg.on || !this.used.has(s)) return;
    const st = this.state[s]!;
    const v = quantiseCc(cfg.base + mod * 127, cfg.res);
    // unchanged: nothing to send; changed within the rate limit: the next allowed step sends the value it has then
    if (v === st.last) return;
    if (t - st.lastAt < 1 / Math.max(1, cfg.rate) - 1e-9) return;
    st.last = v;
    st.lastAt = t;
    this.sent++;
    send(s, cfg, v, t);
  }
}
