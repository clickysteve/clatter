/**
 * Sequence: the project as the scheduler sees it. Decides which pattern plays each cycle
 * (a queued pattern switch, or the chain) and realises the cycle's events from the current
 * state. Pure apart from its cache: live playback, offline export and MIDI export all use it,
 * so what is exported is what plays.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import { stepTicks, type Pattern, type Project, type Track } from '../model/types';
import type { PerfEvent } from '../rhythm/events';
import { realize, type Realization } from '../rhythm/realize';
import type { CycleSource, PlannedCycle } from '../transport/scheduler';

export interface SequenceOptions {
  /** the project now */
  project: () => Project;
  /** a pattern switch waiting for the end of the cycle (consumed when used) */
  takeQueued?: () => string | null;
  /** tracks playing a momentary FILL */
  fills?: () => ReadonlySet<string>;
  /** play only the written source */
  sourceOnly?: () => boolean;
  /** a cycle began with this pattern (the app makes it current) */
  onPattern?: (id: string, k: number) => void;
}

export class Sequence implements CycleSource {
  version = 0;
  private cache = new Map<string, Realization>();
  private chainPos = 0;
  private chainRep = 0;
  private lastPattern = '';
  /** the latest realisation per cycle (display) */
  latest: Realization | null = null;

  constructor(private o: SequenceOptions) {}

  bump(): void {
    this.version++;
    this.cache.clear();
  }

  reset(): void {
    this.chainPos = 0;
    this.chainRep = 0;
    this.lastPattern = '';
    this.cache.clear();
  }

  private pattern(id: string): Pattern {
    const p = this.o.project();
    return p.patterns.find((x) => x.id === id) ?? p.patterns.find((x) => x.id === p.current) ?? p.patterns[0]!;
  }

  plan(k: number): PlannedCycle {
    const proj = this.o.project();
    let id = proj.current;
    const queued = k > 0 ? this.o.takeQueued?.() ?? null : null;
    const chain = proj.chain.on ? proj.chain.entries.filter((e) => proj.patterns.some((p) => p.id === e.pattern)) : [];
    if (queued) {
      id = queued;
    } else if (chain.length) {
      if (k === 0) {
        this.chainPos = Math.max(0, chain.findIndex((e) => e.pattern === proj.current));
        this.chainRep = 0;
      } else {
        this.chainRep++;
        if (this.chainRep >= Math.max(1, chain[this.chainPos % chain.length]!.repeats)) {
          this.chainRep = 0;
          this.chainPos = (this.chainPos + 1) % chain.length;
        }
      }
      id = chain[this.chainPos % chain.length]!.pattern;
    }
    const p = this.pattern(id);
    if (p.id !== this.lastPattern) {
      this.lastPattern = p.id;
      this.o.onPattern?.(p.id, k);
    }
    return { pattern: p.id, ticks: p.steps * stepTicks(p.res) };
  }

  /** The realisation of cycle k of a pattern (cached for the current version). */
  realization(k: number, patternId: string): Realization {
    const key = `${k}|${patternId}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const proj = this.o.project();
    const fills = this.o.fills?.();
    const tracks: Track[] = fills && fills.size ? proj.tracks.map((t) => (fills.has(t.id) ? { ...t, play: { ...t.play, fill: Math.max(t.play.fill, 85) } } : t)) : proj.tracks;
    const r = realize({ seed: proj.seed, swing: proj.swing, pattern: this.pattern(patternId), tracks, destruction: proj.destruction, evolve: proj.evolve, sourceOnly: this.o.sourceOnly?.() }, k);
    if (this.cache.size > 16) this.cache.clear();
    this.cache.set(key, r);
    this.latest = r;
    return r;
  }

  events(k: number, patternId: string): readonly PerfEvent[] {
    return this.realization(k, patternId).events;
  }
}
