/**
 * Development-only kit evaluator: generates a few hundred to a thousand kits with the real LXR
 * engine, renders every instrument of every kit and measures the audio (src/analysis/voiceAnalysis.ts),
 * then writes a JSON report and (optionally) a markdown summary and example WAV files.
 *
 *   npm run eval:kits                         1008 kits, report in eval/out/
 *   KITS=120 npm run eval:kits                a smaller sample
 *   LABEL=baseline OUT=docs/eval/baseline.json npm run eval:kits
 *   WAV=eval/out/wav npm run eval:kits        also write one example kit per CHARACTER x WILDNESS cell
 *
 * Reproducible: kit i is a pure function of i (character, wildness, seed, role layout) and the
 * generator under test. The same code gives the same report byte for byte (apart from "ms").
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'vitest';
import { analyseVoice, type VoiceMetrics } from '../src/analysis/voiceAnalysis';
import { analysePitch } from '../src/analysis/pitch';
import { encodeWav } from '../src/export/wavFile';
import { hash32 } from '../src/rhythm/rng';
import type { KitFlavour } from '../src/rhythm/styles';
import { checkKit, readKit, renderTrigger } from '../src/sound/kitcheck';
import { generateKit, mutateKit } from '../src/sound/kitgen';
import { INSTRUMENTS, convention, kitSameness, kitSpread, safety, similarity, type Instrument, type KitItem } from '../src/sound/voiceScore';
import { newLxr } from '../test/helpers';

const KITS = Number(process.env.KITS ?? 1008);
const LABEL = process.env.LABEL ?? 'current';
const OUT = process.env.OUT ?? `eval/out/${LABEL}.json`;
const WAV = process.env.WAV ?? '';
/** candidates per voice in the engine check (1: the generator alone, nothing chosen) */
const CANDIDATES = Number(process.env.CANDIDATES ?? 5);
const CHARACTERS: KitFlavour[] = ['machine', 'electro', 'acoustic', 'industrial', 'glitch', 'dub'];
const WILDNESS = [0.1, 0.4, 0.7, 1.0];
const CELLS = CHARACTERS.length * WILDNESS.length;
const BASE = 0xc1a77e5;

const noLocks = { voices: [false, false, false, false, false, false], params: [] as number[] };
const LAYOUTS = {
  standard: { roles: [['kick'], ['ltom'], ['htom'], ['snare'], ['cymbal'], ['chat', 'ohat']], inst: [['kick', 0, 0], ['ltom', 1, 1], ['htom', 2, 2], ['snare', 3, 3], ['cymbal', 4, 4], ['chat', 5, 5], ['ohat', 5, 6]] },
  alt: { roles: [['kick'], ['perc'], ['fx'], ['clap'], ['cymbal'], ['chat', 'ohat']], inst: [['kick', 0, 0], ['perc', 1, 1], ['fx', 2, 2], ['clap', 3, 3], ['cymbal', 4, 4], ['chat', 5, 5], ['ohat', 5, 6]] },
} as const;
type LayoutName = keyof typeof LAYOUTS;

interface Row {
  kit: number;
  character: KitFlavour;
  wildness: number;
  layout: LayoutName;
  instr: Instrument;
  m: VoiceMetrics;
  conv: number;
  flags: string[];
  pitchKind?: string;
  pitchStability?: number;
  pitchSweepCents?: number;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const sd = (xs: number[]) => {
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
};
const pct = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
};
const r3 = (x: number) => Math.round(x * 1000) / 1000;

describe('kit evaluation', () => {
  it(`evaluates ${KITS} kits (${LABEL})`, () => {
    const e = newLxr();
    const init = readKit(e);
    const rows: Row[] = [];
    const kitStats: { kit: number; character: KitFlavour; wildness: number; layout: LayoutName; spread: ReturnType<typeof kitSpread>; sameness: number; tomPair: number | null; hatPair: number; ms: number }[] = [];
    const examples: { name: string; audio: Float32Array[] }[] = [];
    const t0 = Date.now();
    for (let i = 0; i < KITS; i++) {
      const cell = i % CELLS;
      const character = CHARACTERS[cell % CHARACTERS.length]!;
      const wildness = WILDNESS[Math.floor(cell / CHARACTERS.length)]!;
      const seedIndex = Math.floor(i / CELLS);
      const layoutName: LayoutName = seedIndex % 3 === 2 ? 'alt' : 'standard';
      const layout = LAYOUTS[layoutName];
      const seed = hash32(BASE, seedIndex);
      const t1 = performance.now();
      const raw = generateKit(init, { seed, flavour: character, voiceRoles: layout.roles.map((r) => [...r]), locks: noLocks, wildness } as never);
      const { kit } = checkKit(newLxr(), raw, { flavour: character, voiceRoles: layout.roles.map((r) => [...r]), seed, fallback: init, wildness, select: CANDIDATES > 1 ? { mode: 'design', candidates: CANDIDATES } : undefined } as never);
      const ms = performance.now() - t1;
      const items: KitItem[] = [];
      for (const [instr, , trig] of layout.inst) {
        const { left, right } = renderTrigger(newLxr(), kit, trig, 2.5);
        const m = analyseVoice(left, right);
        const sf = safety(m, instr);
        const row: Row = { kit: i, character, wildness, layout: layoutName, instr, m, conv: convention(instr, m, 0), flags: sf.flags };
        if ((instr === 'kick' || instr === 'ltom' || instr === 'htom') && seedIndex % 4 === 0) {
          const p = analysePitch([left, right], 44100, { maxSeconds: 0.6, hop: 0.02 });
          row.pitchKind = p.kind;
          row.pitchStability = r3(p.stability);
          row.pitchSweepCents = Math.round(p.sweepCents);
        }
        rows.push(row);
        items.push({ instr, m });
        if (WAV && seedIndex === 0) {
          const peak = Math.max(m.peak, 1e-6);
          examples.push({ name: `${character}-w${Math.round(wildness * 100)}/${instr}.wav`, audio: [left.map((x) => x / Math.max(1, peak)), right.map((x) => x / Math.max(1, peak))] });
        }
      }
      const tl = items.find((x) => x.instr === 'ltom');
      const th = items.find((x) => x.instr === 'htom');
      const hc = items.find((x) => x.instr === 'chat')!;
      const ho = items.find((x) => x.instr === 'ohat')!;
      kitStats.push({ kit: i, character, wildness, layout: layoutName, spread: kitSpread(items), sameness: kitSameness(items), tomPair: tl && th ? similarity(tl, th) : null, hatPair: similarity(hc, ho), ms });
    }
    const seconds = (Date.now() - t0) / 1000;

    // ------------------------------------------------------------------ aggregate
    const byInstr = (f: (r: Row) => boolean = () => true) => {
      const out: Record<string, unknown> = {};
      for (const instr of INSTRUMENTS) {
        const rs = rows.filter((r) => r.instr === instr && f(r));
        if (!rs.length) continue;
        const col = (g: (m: VoiceMetrics) => number) => rs.map((r) => g(r.m));
        out[instr] = {
          n: rs.length,
          silentPct: r3((100 * rs.filter((r) => r.m.silent || r.flags.includes('vanishes')).length) / rs.length),
          clipPct: r3((100 * rs.filter((r) => r.m.clipFrac > 0.0005).length) / rs.length),
          unsafePct: r3((100 * rs.filter((r) => r.flags.length > 0).length) / rs.length),
          looksLikePct: r3((100 * rs.filter((r) => r.conv >= 0.6 && r.flags.length === 0).length) / rs.length),
          convention: r3(mean(rs.map((r) => r.conv))),
          peak: { mean: r3(mean(col((m) => m.peak))), p10: r3(pct(col((m) => m.peak), 0.1)), p90: r3(pct(col((m) => m.peak), 0.9)) },
          rmsDb: r3(mean(col((m) => 20 * Math.log10(Math.max(m.rms, 1e-6))))),
          attackMs: { p10: r3(pct(col((m) => m.attackMs), 0.1)), p50: r3(pct(col((m) => m.attackMs), 0.5)), p90: r3(pct(col((m) => m.attackMs), 0.9)) },
          lengthMs: { p10: Math.round(pct(col((m) => m.lengthMs), 0.1)), p50: Math.round(pct(col((m) => m.lengthMs), 0.5)), p90: Math.round(pct(col((m) => m.lengthMs), 0.9)) },
          t20Ms: { p50: Math.round(pct(col((m) => m.t20Ms), 0.5)) },
          centroidHz: { p10: Math.round(pct(col((m) => m.centroid), 0.1)), p50: Math.round(pct(col((m) => m.centroid), 0.5)), p90: Math.round(pct(col((m) => m.centroid), 0.9)) },
          low: r3(mean(col((m) => m.low))),
          high: r3(mean(col((m) => m.high))),
          tonality: r3(mean(col((m) => m.tonality))),
          noise: r3(mean(col((m) => m.noise))),
          transientDb: r3(mean(col((m) => m.transientDb))),
          sweepOct: r3(mean(col((m) => m.sweepOct))),
          pitchStability: r3(mean(col((m) => m.pitchStability))),
          lengthOctSd: r3(sd(col((m) => Math.log2(Math.max(1, m.lengthMs))))),
          centroidOctSd: r3(sd(col((m) => Math.log2(Math.max(30, m.centroid))))),
        };
      }
      return out;
    };

    // a feature vector per sound, standardised per instrument, for distinctness and diversity
    const feat = (m: VoiceMetrics) => [Math.log2(Math.max(30, m.centroid)), Math.log2(Math.max(5, m.lengthMs)), m.low * 4, m.high * 4, m.noise * 3, m.tonality * 3, Math.log2(1 + m.attackMs), m.sweepOct];
    const sdByInstr = new Map<Instrument, number[]>();
    for (const instr of INSTRUMENTS) {
      const rs = rows.filter((r) => r.instr === instr);
      if (!rs.length) continue;
      const F = rs.map((r) => feat(r.m));
      sdByInstr.set(instr, F[0]!.map((_, k) => sd(F.map((f) => f[k]!)) || 1));
    }
    const z = (r: Row) => feat(r.m).map((v, k) => v / sdByInstr.get(r.instr)![k]!);
    const dist = (a: number[], b: number[]) => Math.sqrt(a.reduce((s, v, k) => s + (v - b[k]!) ** 2, 0));

    const groupMean = (g: (r: Row) => string) => {
      const groups = new Map<string, Map<Instrument, number[][]>>();
      for (const r of rows) {
        const k = g(r);
        if (!groups.has(k)) groups.set(k, new Map());
        const gm = groups.get(k)!;
        if (!gm.has(r.instr)) gm.set(r.instr, []);
        gm.get(r.instr)!.push(z(r));
      }
      return groups;
    };
    /** mean distance between the per-instrument centroids of the groups: how separable the groups sound */
    const separation = (g: (r: Row) => string) => {
      const groups = groupMean(g);
      const keys = [...groups.keys()];
      const centre = (k: string, instr: Instrument) => {
        const v = groups.get(k)!.get(instr);
        return v ? v[0]!.map((_, j) => mean(v.map((x) => x[j]!))) : null;
      };
      let tot = 0;
      let n = 0;
      for (let a = 0; a < keys.length; a++)
        for (let b = a + 1; b < keys.length; b++)
          for (const instr of INSTRUMENTS) {
            const ca = centre(keys[a]!, instr);
            const cb = centre(keys[b]!, instr);
            if (ca && cb) {
              tot += dist(ca, cb);
              n++;
            }
          }
      return r3(n ? tot / n : 0);
    };
    /** mean distance of a sound to its nearest other sound of the same instrument inside the group: low means the group repeats itself */
    const nearest = (f: (r: Row) => boolean) => {
      const ds: number[] = [];
      for (const instr of INSTRUMENTS) {
        const rs = rows.filter((r) => r.instr === instr && f(r));
        const Z = rs.map(z);
        for (let a = 0; a < Z.length; a++) {
          let best = Infinity;
          for (let b = 0; b < Z.length; b++) if (a !== b) best = Math.min(best, dist(Z[a]!, Z[b]!));
          if (Number.isFinite(best)) ds.push(best);
        }
      }
      return r3(mean(ds));
    };

    const kitAgg = (f: (k: (typeof kitStats)[number]) => boolean) => {
      const ks = kitStats.filter(f);
      return {
        kits: ks.length,
        decaySpreadOct: r3(mean(ks.map((k) => k.spread.decaySpread))),
        centroidRangeOct: r3(mean(ks.map((k) => k.spread.centroidRange))),
        levelRangeDb: r3(mean(ks.map((k) => k.spread.levelRangeDb))),
        maxPeak: r3(mean(ks.map((k) => k.spread.maxPeak))),
        loudKitsPct: r3((100 * ks.filter((k) => k.spread.maxPeak > 0.9).length) / Math.max(1, ks.length)),
        brightSpread: r3(mean(ks.map((k) => k.spread.brightSpread))),
        sameness: r3(mean(ks.map((k) => k.sameness))),
        tomsTooAlikePct: r3((100 * ks.filter((k) => k.tomPair !== null && k.tomPair > 0.5).length) / Math.max(1, ks.filter((k) => k.tomPair !== null).length)),
        hatsTooAlikePct: r3((100 * ks.filter((k) => k.hatPair > 0.5).length) / Math.max(1, ks.length)),
        sameDecayKitsPct: r3((100 * ks.filter((k) => k.spread.decaySpread < 0.6).length) / Math.max(1, ks.length)),
        msPerKit: Math.round(mean(ks.map((k) => k.ms))),
      };
    };

    // ------------------------------------------------------------------ MUTATE: the plain mutation against the chosen one
    const mutation: Record<string, unknown> = {};
    const MUT = Number(process.env.MUT_KITS ?? Math.min(KITS, 144));
    if (MUT > 0) {
      const acc = { plain: [] as Row[], chosen: [] as Row[] };
      const moved = { plain: [] as number[], chosen: [] as number[] };
      const msAcc = { plain: [] as number[], chosen: [] as number[] };
      for (let i = 0; i < MUT; i++) {
        const cell = i % CELLS;
        const character = CHARACTERS[cell % CHARACTERS.length]!;
        const wildness = WILDNESS[Math.floor(cell / CHARACTERS.length)]!;
        const seed = hash32(BASE, Math.floor(i / CELLS), 9);
        const roles = LAYOUTS.standard.roles.map((r) => [...r]);
        const raw = generateKit(init, { seed, flavour: character, voiceRoles: roles, locks: noLocks, wildness } as never);
        const kit0 = checkKit(newLxr(), raw, { flavour: character, voiceRoles: roles, seed, fallback: init, wildness, select: CANDIDATES > 1 ? { mode: 'design', candidates: CANDIDATES } : undefined } as never).kit;
        const mseed = hash32(seed, 4242);
        const mutated = mutateKit(kit0, { seed: mseed, flavour: character, voiceRoles: roles, locks: noLocks, amount: 0.4, wildness } as never);
        const t2 = performance.now();
        const plain = checkKit(newLxr(), mutated, { flavour: character, voiceRoles: roles, seed: mseed, fallback: init, wildness } as never).kit;
        const t3 = performance.now();
        const chosen = checkKit(newLxr(), mutated, { flavour: character, voiceRoles: roles, seed: mseed, fallback: init, wildness, select: CANDIDATES > 1 ? { mode: 'mutate', candidates: CANDIDATES, base: kit0, amount: 0.4 } : undefined } as never).kit;
        const t4 = performance.now();
        msAcc.plain.push(t3 - t2);
        msAcc.chosen.push(t4 - t3);
        for (const [instr, , trig] of LAYOUTS.standard.inst) {
          const mo = analyseVoice(...Object.values(renderTrigger(newLxr(), kit0, trig, 2.5)) as [Float32Array, Float32Array]);
          for (const [which, k] of [['plain', plain], ['chosen', chosen]] as const) {
            const r = renderTrigger(newLxr(), k, trig, 2.5);
            const m = analyseVoice(r.left, r.right);
            acc[which].push({ kit: i, character, wildness, layout: 'standard', instr, m, conv: convention(instr, m, 0), flags: safety(m, instr).flags });
            moved[which].push(Math.abs(Math.log2(Math.max(30, m.centroid) / Math.max(30, mo.centroid))) + Math.abs(Math.log2(Math.max(5, m.lengthMs) / Math.max(5, mo.lengthMs))));
          }
        }
      }
      for (const which of ['plain', 'chosen'] as const) {
        const rs = acc[which];
        mutation[which] = {
          sounds: rs.length,
          unsafePct: r3((100 * rs.filter((r) => r.flags.length > 0).length) / rs.length),
          silentPct: r3((100 * rs.filter((r) => r.m.silent || r.flags.includes('vanishes')).length) / rs.length),
          looksLikePct: r3((100 * rs.filter((r) => r.conv >= 0.6 && r.flags.length === 0).length) / rs.length),
          lowWildLooksLikePct: r3((100 * rs.filter((r) => r.wildness <= 0.4 && r.conv >= 0.6 && r.flags.length === 0).length) / Math.max(1, rs.filter((r) => r.wildness <= 0.4).length)),
          movedOctaves: r3(mean(moved[which])),
          msPerKit: Math.round(mean(msAcc[which])),
        };
      }
    }

    const report = {
      label: LABEL,
      kits: KITS,
      sounds: rows.length,
      seconds: Math.round(seconds),
      overall: byInstr(),
      byWildness: Object.fromEntries(WILDNESS.map((w) => [String(w), { instruments: byInstr((r) => r.wildness === w), kit: kitAgg((k) => k.wildness === w), nearestNeighbour: nearest((r) => r.wildness === w) }])),
      byCharacter: Object.fromEntries(CHARACTERS.map((c) => [c, { instruments: byInstr((r) => r.character === c), kit: kitAgg((k) => k.character === c) }])),
      characterSeparation: separation((r) => r.character),
      wildnessSeparation: separation((r) => String(r.wildness)),
      kit: kitAgg(() => true),
      mutation,
      pitch: Object.fromEntries(
        (['kick', 'ltom', 'htom'] as Instrument[]).map((instr) => {
          const rs = rows.filter((r) => r.instr === instr && r.pitchKind);
          const kinds: Record<string, number> = {};
          for (const r of rs) kinds[r.pitchKind!] = (kinds[r.pitchKind!] ?? 0) + 1;
          return [instr, { n: rs.length, kinds, stability: r3(mean(rs.map((r) => r.pitchStability ?? 0))), sweepCents: Math.round(mean(rs.map((r) => r.pitchSweepCents ?? 0))) }];
        }),
      ),
      unsafeExamples: rows.filter((r) => r.flags.length).slice(0, 12).map((r) => ({ kit: r.kit, character: r.character, wildness: r.wildness, layout: r.layout, instr: r.instr, flags: r.flags, peak: r3(r.m.peak), lengthMs: Math.round(r.m.lengthMs) })),
      flags: Object.fromEntries(
        [...new Set(rows.flatMap((r) => r.flags))].map((f) => [f, rows.filter((r) => r.flags.includes(f)).length]),
      ),
    };
    const path = resolve(OUT);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(report, null, 1) + '\n');
    if (WAV) {
      for (const x of examples) {
        const p = resolve(WAV, x.name);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, encodeWav(x.audio, 44100, 'pcm16'));
      }
    }
    console.log(`evaluated ${KITS} kits, ${rows.length} sounds in ${seconds.toFixed(0)} s → ${path}`);
  });
});
