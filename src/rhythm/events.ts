/**
 * Performance events: what one cycle of a pattern actually plays, after the transformations
 * and the performance controls. The scheduler sends these to the sound engine and to MIDI.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
export type EventKind = 'source' | 'flam' | 'ratchet' | 'fill' | 'chop' | 'retrig' | 'roll' | 'stutter';

export interface PerfEvent {
  /** unique within the cycle: the scheduler never sends a key twice */
  key: string;
  /** ticks from the start of the cycle (fractional) */
  tick: number;
  track: string;
  vel: number;
  /** semitones */
  pitch: number;
  kind: EventKind;
  /** the source step this event comes from (-1: none) */
  origin: number;
  /** the step it plays on (display) */
  step: number;
  /** probability 0-100 still to be decided (performance stage) */
  prob?: number;
  flam?: boolean;
  ratchet?: number;
  sample?: string;
  /** DESTROY: gate length in ticks */
  gate?: number;
  /** DESTROY: reversed sample */
  reverse?: boolean;
  /** DESTROY: LXR sample-rate lock value (0-127) */
  crush?: number;
  /** made or changed by DESTROY */
  destroyed?: boolean;
}

export const cloneEvent = (e: PerfEvent): PerfEvent => ({ ...e });

export function byTime(a: PerfEvent, b: PerfEvent): number {
  return a.tick - b.tick || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}
