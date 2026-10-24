/**
 * WILDCARD: one press re-imagines the current idea within limits. Each part draws from
 * musically informed distributions, never uniform noise: generation controls scatter around
 * their current values, a transformation is switched on only some of the time and at
 * moderate strengths, the swing moves a little, the kit is mutated a little. What it never
 * touches: the tempo, locked tracks, locked voices and parameters, mutes and solos, the mixer.
 *
 * After The Breakery's WILDCARD (src/engine/wildcard.ts, https://github.com/clickysteve/the-breakery,
 * Copyright (c) 2026 The Breakery contributors, MIT licence, see THIRD_PARTY_NOTICES.md): the
 * idea of a bounded, reported, seeded re-imagining; this implementation is CLATTER's.
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import { clamp, ROLL_SPEEDS, type DestructionSettings, type GenSettings } from '../model/types';
import { Rng } from '../rhythm/rng';
import { STYLES } from '../rhythm/styles';

export interface WildcardResult {
  gen: GenSettings;
  destruction: DestructionSettings;
  swing: number;
  /** regenerate the pattern with the new controls */
  regenerate: boolean;
  /** mutate the kit by this amount (0 = leave the kit) */
  kitMutation: number;
  report: string[];
}

export function wildcard(gen: GenSettings, d: DestructionSettings, swing: number, seed: number): WildcardResult {
  const r = new Rng(seed);
  const report: string[] = [];
  const g: GenSettings = { ...gen };
  const scatter = (v: number, w: number) => clamp(v + r.bell() * w, 0.05, 0.95);
  let regenerate = false;
  if (r.chance(0.3)) {
    const s = r.pick(STYLES.filter((x) => x.id !== g.style));
    g.style = s.id;
    report.push(`STYLE ${s.label}`);
    regenerate = true;
  }
  if (r.chance(0.7)) {
    g.density = scatter(g.density, 0.15);
    g.complexity = scatter(g.complexity, 0.2);
    g.variation = scatter(g.variation, 0.2);
    g.fills = scatter(g.fills, 0.2);
    report.push(`CONTROLS D${Math.round(g.density * 100)} C${Math.round(g.complexity * 100)} V${Math.round(g.variation * 100)}`);
    regenerate = true;
  }
  const out: DestructionSettings = { chop: { ...d.chop }, rolls: { ...d.rolls, targets: [...d.rolls.targets] }, destroy: { ...d.destroy } };
  if (r.chance(0.5)) {
    out.chop = { ...out.chop, on: r.chance(0.7), amount: clamp(0.2 + r.next() * 0.5, 0, 1), slice: r.pick([1, 2, 2, 4, 4, 8]), retrigger: r.next() * 0.6, take: out.chop.take + 1 + r.int(5) };
    report.push(out.chop.on ? `CHOP ${Math.round(out.chop.amount * 100)}% / ${out.chop.slice}` : 'CHOP OFF');
  }
  if (r.chance(0.45)) {
    out.rolls = { ...out.rolls, on: r.chance(0.65), prob: 0.2 + r.next() * 0.6, length: 3 + r.int(5), speed: r.pick(ROLL_SPEEDS), shape: r.pick(['even', 'crescendo', 'decrescendo', 'human'] as const), place: r.pick(['phrase', 'accent', 'anywhere'] as const), take: out.rolls.take + 1 + r.int(5) };
    report.push(out.rolls.on ? `ROLLS ${Math.round(out.rolls.prob * 100)}% ${out.rolls.speed}` : 'ROLLS OFF');
  }
  if (r.chance(0.35)) {
    const on = r.chance(0.5);
    out.destroy = { ...out.destroy, on, amount: 0.2 + r.next() * 0.45, stutter: r.next() * 0.6, pitch: r.next() * 0.5, reverse: r.next() * 0.4, gate: r.next() * 0.5, crush: r.next() * 0.5, skip: r.next() * 0.2, take: out.destroy.take + 1 + r.int(5) };
    report.push(on ? `DESTROY ${Math.round(out.destroy.amount * 100)}%` : 'DESTROY OFF');
  }
  let sw = swing;
  if (r.chance(0.35)) {
    sw = Math.round(clamp(swing + r.bell() * 6, 50, 68));
    if (sw !== swing) report.push(`SWING ${sw}%`);
  }
  const kitMutation = r.chance(0.55) ? 0.15 + r.next() * 0.3 : 0;
  if (kitMutation) report.push(`KIT MUTATED ${Math.round(kitMutation * 100)}%`);
  if (!report.length) report.push('A NEW TAKE');
  return { gen: g, destruction: out, swing: sw, regenerate, kitMutation, report };
}
