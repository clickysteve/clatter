/**
 * ROLLS: runs of retriggers leading into hits. A roll is LENGTH strokes of one drum, SPEED
 * apart, ending one stroke before a CANDIDATE hit of a target track; the hit itself is never
 * moved or changed. PROBABILITY is the chance each eligible candidate gets a roll, drawn per
 * candidate (raising it only adds rolls); at most two rolls a bar. RE-ROLL draws again.
 *
 * After The Breakery's ROLLS transformation (src/engine/rollLayer.ts,
 * https://github.com/clickysteve/the-breakery, Copyright (c) 2026 The Breakery contributors,
 * MIT licence, see THIRD_PARTY_NOTICES.md); this implementation is CLATTER's.
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import { clamp, ROLL_TICKS, type RollSettings } from '../model/types';
import { rand, SALT, strCode } from '../rhythm/rng';
import type { PerfEvent } from '../rhythm/events';

export interface RollContext {
  seed: number;
  steps: number;
  stepTicks: number;
  stepsPerBar: number;
  roles: Record<string, string>;
}

export interface RollReport {
  rolls: number;
  strokes: number;
  reason: string;
}

export const MAX_ROLLS_PER_BAR = 2;

export const defaultRolls = (): RollSettings => ({ on: false, prob: 0.5, length: 4, speed: '32', shape: 'crescendo', place: 'phrase', targets: ['snare', 'clap', 'chat', 'htom', 'ltom', 'perc'], take: 0 });

function shapeVel(shape: RollSettings['shape'], v: number, j: number, n: number, u: number): number {
  const k = n > 1 ? j / (n - 1) : 1;
  switch (shape) {
    case 'crescendo':
      return v * (0.3 + 0.55 * k);
    case 'decrescendo':
      return v * (0.85 - 0.5 * k);
    case 'human':
      return v * (0.45 + 0.3 * u + 0.15 * k);
    default:
      return v * 0.62;
  }
}

export function rolls(source: readonly PerfEvent[], s: RollSettings, ctx: RollContext): { events: PerfEvent[]; report: RollReport } {
  const out = source.slice();
  const report: RollReport = { rolls: 0, strokes: 0, reason: '' };
  if (!s.on) return { events: out, report: { ...report, reason: 'OFF' } };
  if (!s.targets.length) return { events: out, report: { ...report, reason: 'NO TARGET TRACKS' } };
  if (s.prob <= 0) return { events: out, report: { ...report, reason: 'PROBABILITY 0%' } };
  const T = ctx.stepTicks;
  const sp = ROLL_TICKS[s.speed];
  const cycleT = ctx.steps * T;
  const barT = ctx.stepsPerBar * T;
  const lastBarStart = Math.floor((ctx.steps - 1) / ctx.stepsPerBar) * barT;
  const beatT = (ctx.stepsPerBar / 4) * T;
  const isTarget = (e: PerfEvent) => s.targets.includes(ctx.roles[e.track] as never) && e.kind !== 'roll' && e.kind !== 'retrig';
  const cands = source.filter(isTarget).filter((e) => {
    switch (s.place) {
      case 'phrase':
        return e.tick >= cycleT - 2 * beatT || (ctx.steps / ctx.stepsPerBar >= 2 && e.tick >= lastBarStart / 2 + barT / 2 - 2 * beatT && e.tick < lastBarStart / 2 + barT / 2);
      case 'accent':
        return e.vel >= 100 && e.tick >= beatT;
      default:
        return e.tick >= beatT;
    }
  });
  if (!cands.length) return { events: out, report: { ...report, reason: 'NO TARGET HITS IN PLACE' } };
  const perBar = new Map<number, number>();
  const sorted = cands
    .map((e) => ({ e, u: rand(ctx.seed, SALT.rolls, s.take, strCode(e.key)) }))
    .sort((a, b) => a.u - b.u);
  let eligible = 0;
  for (const { e, u } of sorted) {
    // the previous hit of the same drum: the roll must start after it
    let prev = -Infinity;
    for (const o of out) if (o.track === e.track && o.tick < e.tick - 1e-6 && o.tick > prev) prev = o.tick;
    const barStart = Math.floor(e.tick / barT) * barT;
    const earliest = Math.max(prev + sp, barStart);
    const room = Math.floor((e.tick - earliest) / sp);
    const n = Math.min(clamp(Math.round(s.length), 2, 12), room);
    if (n < 2) continue;
    eligible++;
    if (u >= s.prob) continue;
    const bar = Math.floor(e.tick / barT);
    if ((perBar.get(bar) ?? 0) >= MAX_ROLLS_PER_BAR) continue;
    perBar.set(bar, (perBar.get(bar) ?? 0) + 1);
    for (let j = 0; j < n; j++) {
      const tick = e.tick - (n - j) * sp;
      const uv = rand(ctx.seed, SALT.rolls, s.take, strCode(e.key), j);
      out.push({ ...e, key: `${e.key}~roll${j}`, tick, step: Math.floor(tick / T), kind: 'roll', vel: Math.round(clamp(shapeVel(s.shape, e.vel, j, n, uv), 8, 127)), prob: undefined, flam: false, ratchet: undefined });
    }
    report.rolls++;
    report.strokes += n;
  }
  if (!report.rolls) report.reason = eligible ? `NONE OF ${eligible} ELIGIBLE CHOSEN AT ${Math.round(s.prob * 100)}%` : 'NO ROOM BEFORE THE TARGET HITS';
  return { events: out, report };
}

export function describeRolls(r: RollReport): string {
  return r.rolls ? `${r.rolls} ROLLS · ${r.strokes} RETRIGGERS` : `0 ROLLS · ${r.reason}`;
}
