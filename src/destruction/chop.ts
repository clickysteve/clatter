/**
 * CHOP: the pattern cut into slices and rearranged, the way a producer edits a sampled break,
 * but on the sequencer's events (nothing here touches audio).
 *
 * The idea and the operations (RECALL, SWAP, REPEAT, DOUBLE, RETRIGGER, GAP; the first slice
 * never edited; the chance growing through the bar; a ceiling on retriggers per bar) follow
 * The Breakery's CHOP (src/engine/chopper.ts, https://github.com/clickysteve/the-breakery,
 * Copyright (c) 2026 The Breakery contributors, MIT licence, see THIRD_PARTY_NOTICES.md). This
 * implementation is CLATTER's, written for its own event model.
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 *
 * Non-destructive and deterministic: RESULT = CHOP(SOURCE, settings, seed, take). AMOUNT 0 or
 * CHOP off returns the source events unchanged; RE-CHOP (take + 1) draws again.
 */
import { clamp, type ChopSettings } from '../model/types';
import { rand, SALT } from '../rhythm/rng';
import type { PerfEvent } from '../rhythm/events';

export type ChopOp = 'keep' | 'recall' | 'swap' | 'repeat' | 'double' | 'retrigger' | 'gap';

export interface ChopReport {
  slices: number;
  edited: number;
  ops: Partial<Record<ChopOp, number>>;
}

export interface ChopContext {
  seed: number;
  steps: number;
  stepTicks: number;
  stepsPerBar: number;
  /** track id → role (the lead of a retrigger is the snare, else the kick, else any) */
  roles: Record<string, string>;
}

export const defaultChop = (): ChopSettings => ({ on: false, amount: 0.45, slice: 4, retrigger: 0.3, take: 0 });

const LEAD = ['snare', 'clap', 'kick', 'perc', 'htom', 'ltom', 'chat'];

export function chop(source: readonly PerfEvent[], s: ChopSettings, ctx: ChopContext): { events: PerfEvent[]; report: ChopReport } {
  const report: ChopReport = { slices: 0, edited: 0, ops: {} };
  if (!s.on || s.amount <= 0) return { events: source.slice(), report };
  const slice = clamp(Math.round(s.slice), 1, ctx.steps);
  const nSlices = Math.ceil(ctx.steps / slice);
  report.slices = nSlices;
  const T = ctx.stepTicks;
  const sliceOf = (e: PerfEvent) => Math.floor(e.tick / T / slice + 1e-9);
  const bySlice: PerfEvent[][] = Array.from({ length: nSlices }, () => []);
  for (const e of source) {
    const k = sliceOf(e);
    if (k >= 0 && k < nSlices) bySlice[k]!.push(e);
  }
  const out: PerfEvent[] = [];
  const retrigsInBar = new Map<number, number>();
  const take = s.take;
  /** events of slice `from` moved to play in slice `to` (optionally only the first half, twice) */
  const place = (from: number, to: number, op: ChopOp, half = false) => {
    const shift = (to - from) * slice * T;
    const srcEvents = bySlice[from] ?? [];
    const halfLen = (slice * T) / 2;
    for (const e of srcEvents) {
      const local = e.tick - from * slice * T;
      if (half && local >= halfLen) continue;
      const reps = half ? 2 : 1;
      for (let r = 0; r < reps; r++) {
        const tick = e.tick + shift + r * halfLen;
        if (tick >= ctx.steps * T) continue;
        out.push({ ...e, key: `${e.key}~c${to}.${r}`, tick, step: Math.floor(tick / T), kind: op === 'keep' ? e.kind : 'chop' });
      }
    }
  };
  for (let k = 0; k < nSlices; k++) {
    const startStep = k * slice;
    const bar = Math.floor(startStep / ctx.stepsPerBar);
    const inBar = (startStep % ctx.stepsPerBar) / ctx.stepsPerBar;
    const lastBar = bar === Math.floor((ctx.steps - 1) / ctx.stepsPerBar);
    const pEdit = k === 0 ? 0 : clamp(s.amount * (0.45 + inBar * 0.7 + (lastBar ? 0.25 : 0)), 0, 0.95);
    let op: ChopOp = 'keep';
    if (rand(ctx.seed, SALT.chop, take, k, 1) < pEdit) {
      const w: [ChopOp, number][] = [
        ['recall', 1.0],
        ['swap', k + 1 < nSlices ? 0.6 : 0],
        ['repeat', 0.8],
        ['double', 0.5 + s.retrigger * 0.4],
        ['retrigger', s.retrigger * 1.4],
        ['gap', 0.25 + s.amount * 0.2],
      ];
      const total = w.reduce((a, [, x]) => a + x, 0);
      let u = rand(ctx.seed, SALT.chop, take, k, 2) * total;
      for (const [o, x] of w) {
        u -= x;
        if (u < 0) {
          op = o;
          break;
        }
      }
      if ((op === 'retrigger' || op === 'double') && (retrigsInBar.get(bar) ?? 0) >= 2) op = 'repeat';
    }
    switch (op) {
      case 'keep':
        place(k, k, 'keep');
        break;
      case 'recall': {
        // prefer the same place in an earlier bar (a motif), else a slice that starts with a kick or snare
        const perBar = Math.max(1, Math.round(ctx.stepsPerBar / slice));
        const cands: number[] = [];
        for (let j = 0; j < nSlices; j++) if (j !== k && bySlice[j]!.length) cands.push(j);
        let pick = k - perBar >= 0 && bySlice[k - perBar]!.length ? k - perBar : -1;
        if (pick < 0 || rand(ctx.seed, SALT.chop, take, k, 3) < 0.5) {
          const strong = cands.filter((j) => bySlice[j]!.some((e) => e.tick === j * slice * T && /kick|snare|clap/.test(ctx.roles[e.track] ?? '')));
          const pool = strong.length ? strong : cands;
          if (pool.length) pick = pool[Math.floor(rand(ctx.seed, SALT.chop, take, k, 4) * pool.length)]!;
        }
        if (pick < 0) place(k, k, 'keep');
        else place(pick, k, 'recall');
        break;
      }
      case 'swap':
        place(k + 1, k, 'swap');
        place(k, k + 1, 'swap');
        k++;
        report.ops.swap = (report.ops.swap ?? 0) + 1;
        report.edited++;
        continue;
      case 'repeat':
        place(k - 1, k, 'repeat');
        break;
      case 'double':
        place(k, k, 'double', true);
        retrigsInBar.set(bar, (retrigsInBar.get(bar) ?? 0) + 1);
        break;
      case 'retrigger': {
        // the slice's lead hit, retriggered across the slice as a crescendo
        const evs = bySlice[k]!;
        let lead: PerfEvent | undefined;
        for (const role of LEAD) {
          lead = evs.find((e) => ctx.roles[e.track] === role);
          if (lead) break;
        }
        lead ??= evs[0];
        place(k, k, 'keep');
        if (lead) {
          const speeds = [T, T / 2, T / 3, T / 4];
          const sp = speeds[Math.floor(rand(ctx.seed, SALT.chop, take, k, 5) * (1 + s.retrigger * 3))] ?? T / 2;
          const startT = startStep * T;
          const endT = Math.min(ctx.steps, startStep + slice) * T;
          const count = Math.max(2, Math.floor((endT - startT) / sp));
          for (let r = 0; r < count; r++) {
            const tick = startT + r * sp;
            if (tick === lead.tick) continue;
            out.push({ ...lead, key: `${lead.key}~r${k}.${r}`, tick, step: Math.floor(tick / T), kind: 'retrig', vel: Math.round(clamp(lead.vel * (0.45 + (0.5 * r) / count), 10, 127)), prob: undefined, flam: false, ratchet: undefined });
          }
          retrigsInBar.set(bar, (retrigsInBar.get(bar) ?? 0) + 1);
        }
        break;
      }
      case 'gap':
        // silence, sometimes keeping the kick
        for (const e of bySlice[k]!) if (ctx.roles[e.track] === 'kick' && rand(ctx.seed, SALT.chop, take, k, 6) < 0.5) out.push({ ...e });
        break;
    }
    if (op !== 'keep') {
      report.ops[op] = (report.ops[op] ?? 0) + 1;
      report.edited++;
    }
  }
  // merge duplicates on the same track and tick (the louder wins)
  const seen = new Map<string, PerfEvent>();
  for (const e of out) {
    const id = `${e.track}@${e.tick.toFixed(3)}`;
    const prev = seen.get(id);
    if (!prev || e.vel > prev.vel) seen.set(id, e);
  }
  return { events: [...seen.values()], report };
}

export function describeChop(r: ChopReport): string {
  if (!r.slices) return 'CHOP OFF';
  const ops = Object.entries(r.ops)
    .map(([k, v]) => `${k.toUpperCase()} ${v}`)
    .join(' · ');
  return `${r.edited}/${r.slices} SLICES${ops ? ' · ' + ops : ''}`;
}
