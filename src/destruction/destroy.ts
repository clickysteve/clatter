/**
 * DESTROY: event-level destruction of the finished pattern, hit by hit. Every effect has a
 * PROBABILITY (how many hits) scaled by AMOUNT; whether an effect takes a hit is a fixed draw
 * per (seed, take, effect, hit), so raising a probability destroys the same hits and more,
 * and RE-DESTROY (take + 1) draws again.
 *
 *   STUTTER  the hit repeated 2-4 times at 1/32 or 1/64, fading, before the next hit
 *   PITCH    transposed by up to an octave (synth: the LXR note; samples: playback rate)
 *   REVERSE  the sample layer played backwards
 *   GATE     the sound cut short (1/64 to 1/8)
 *   CRUSH    the LXR voice's sample-rate reduction locked on the hit (the LXR's own decimator)
 *   SKIP     the hit dropped
 *
 * After The Breakery's DESTROY (src/engine/destroy2.ts, https://github.com/clickysteve/the-breakery,
 * Copyright (c) 2026 The Breakery contributors, MIT licence, see THIRD_PARTY_NOTICES.md): the
 * effect matrix idea, fixed draws and the never-destroy-hand-edits rule. CRUSH and the synth
 * side are CLATTER's; this implementation is CLATTER's.
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import { clamp, type DestroySettings } from '../model/types';
import { rand, SALT, strCode } from '../rhythm/rng';
import type { PerfEvent } from '../rhythm/events';

export interface DestroyContext {
  seed: number;
  stepTicks: number;
}

export interface DestroyReport {
  hits: number;
  counts: Record<'stutter' | 'pitch' | 'reverse' | 'gate' | 'crush' | 'skip', number>;
}

export const defaultDestroy = (): DestroySettings => ({ on: false, amount: 0.5, stutter: 0.3, pitch: 0.25, reverse: 0.15, gate: 0.25, crush: 0.2, skip: 0.1, take: 0 });

const EFFECTS = ['skip', 'stutter', 'pitch', 'reverse', 'gate', 'crush'] as const;

export function destroy(source: readonly PerfEvent[], s: DestroySettings, ctx: DestroyContext): { events: PerfEvent[]; report: DestroyReport } {
  const report: DestroyReport = { hits: 0, counts: { stutter: 0, pitch: 0, reverse: 0, gate: 0, crush: 0, skip: 0 } };
  if (!s.on || s.amount <= 0) return { events: source.slice(), report };
  const T = ctx.stepTicks;
  const out: PerfEvent[] = [];
  const nextOnTrack = (e: PerfEvent): number => {
    let n = Infinity;
    for (const o of source) if (o.track === e.track && o.tick > e.tick + 1e-6 && o.tick < n) n = o.tick;
    return n;
  };
  for (const e of source) {
    const k = strCode(e.key);
    const takes = (fx: (typeof EFFECTS)[number], i: number) => rand(ctx.seed, SALT.destroy, s.take, i, k) < clamp(s[fx] * s.amount * 1.3, 0, 1);
    if (takes('skip', 0)) {
      report.counts.skip++;
      report.hits++;
      continue;
    }
    const d: PerfEvent = { ...e };
    let touched = false;
    if (takes('pitch', 2)) {
      const u = rand(ctx.seed, SALT.destroy, s.take, 20, k);
      d.pitch = clamp(d.pitch + Math.round((u * 2 - 1) * (3 + s.amount * 9)), -24, 24) || d.pitch + 12;
      report.counts.pitch++;
      touched = true;
    }
    if (takes('reverse', 3)) {
      d.reverse = true;
      report.counts.reverse++;
      touched = true;
    }
    if (takes('gate', 4)) {
      const u = rand(ctx.seed, SALT.destroy, s.take, 40, k);
      d.gate = [T / 4, T / 2, T, T * 2][Math.floor(u * 4)]!;
      report.counts.gate++;
      touched = true;
    }
    if (takes('crush', 5)) {
      const u = rand(ctx.seed, SALT.destroy, s.take, 50, k);
      d.crush = Math.round(8 + u * 50);
      report.counts.crush++;
      touched = true;
    }
    if (touched) d.destroyed = true;
    out.push(d);
    if (takes('stutter', 1)) {
      const u = rand(ctx.seed, SALT.destroy, s.take, 10, k);
      const sp = u < 0.6 ? T / 2 : T / 4;
      const room = Math.floor((nextOnTrack(e) - e.tick) / sp) - 1;
      const reps = Math.min(2 + Math.floor(u * 3), room, 8);
      for (let r = 1; r <= reps; r++) {
        const tick = e.tick + r * sp;
        out.push({ ...d, key: `${e.key}~st${r}`, tick, step: Math.floor(tick / T), kind: 'stutter', vel: Math.round(clamp(d.vel * Math.pow(0.78, r), 5, 127)), destroyed: true, flam: false, ratchet: undefined, pitch: d.pitch + (s.pitch > 0.5 ? -r : 0) });
      }
      if (reps > 0) {
        report.counts.stutter++;
        d.destroyed = true;
        touched = true;
      }
    }
    if (touched) report.hits++;
  }
  return { events: out, report };
}

export function describeDestroy(r: DestroyReport): string {
  if (!r.hits) return '0 HITS DESTROYED';
  const parts = Object.entries(r.counts)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k.toUpperCase()} ${n}`);
  return `${r.hits} HITS · ${parts.join(' · ')}`;
}
