/** Intelligent kit generation: audio analysis, instrument scoring, candidate selection, CHARACTER, WILDNESS. */
import { describe, expect, it, vi } from 'vitest';
import { newLxr } from './helpers';
import { analyseVoice, type VoiceMetrics } from '../src/analysis/voiceAnalysis';
import { hash32 } from '../src/rhythm/rng';
import type { KitFlavour } from '../src/rhythm/styles';
import { checkKit, DEFAULT_CANDIDATES, probesFor, readKit, renderTrigger, unsuitable } from '../src/sound/kitcheck';
import { generateKit, KIT_GENERATOR, mutateKit, voiceKeys } from '../src/sound/kitgen';
import { convention, judge, kitSameness, looksLike, safety, similarity, type Instrument } from '../src/sound/voiceScore';
import { PAR } from '../src/sound/lxrParamIds';
import { defaultProject } from '../src/model/defaults';
import { parseProject, repairProject, serialize } from '../src/model/project';
import type { SynthKit } from '../src/model/types';

// these render real kits through the engine
vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 });

const e = newLxr();
const init = readKit(e);
const CHARACTERS: KitFlavour[] = ['machine', 'electro', 'acoustic', 'industrial', 'glitch', 'dub'];
const STANDARD = [['kick'], ['ltom'], ['htom'], ['snare'], ['cymbal'], ['chat', 'ohat']];
const ALT = [['kick'], ['perc'], ['fx'], ['clap'], ['cymbal'], ['chat', 'ohat']];
const noLocks = { voices: [false, false, false, false, false, false], params: [] as number[] };
const INSTR: [Instrument, number][] = [['kick', 0], ['ltom', 1], ['htom', 2], ['snare', 3], ['cymbal', 4], ['chat', 5], ['ohat', 6]];

/** GENERATE KIT as the application does it: design, then the engine check with candidate selection. */
function makeKit(seed: number, flavour: KitFlavour, wildness: number, candidates = DEFAULT_CANDIDATES, roles = STANDARD): SynthKit {
  const raw = generateKit(init, { seed, flavour, voiceRoles: roles, locks: noLocks, wildness });
  return checkKit(newLxr(), raw, { flavour, voiceRoles: roles, seed, fallback: init, wildness, select: candidates > 1 ? { mode: 'design', candidates } : undefined }).kit;
}

function measure(kit: SynthKit, trig: number, secs = 2.5): VoiceMetrics {
  const r = renderTrigger(newLxr(), kit, trig, secs);
  return analyseVoice(r.left, r.right);
}

const seeds = (n: number, salt = 1) => Array.from({ length: n }, (_, i) => hash32(0x51ee, salt, i));
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const sd = (xs: number[]) => Math.sqrt(mean(xs.map((x) => (x - mean(xs)) ** 2)));

// ---------------------------------------------------------------------------- the analysis itself
describe('rendered-audio analysis', () => {
  const rate = 44100;
  const burst = (n: number, f: (i: number) => number): Float32Array => Float32Array.from({ length: n }, (_, i) => f(i));
  let seed = 7;
  const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296) * 2 - 1;

  it('measures a decaying sine as a low, tonal, soft-edged sound with a known length', () => {
    const x = burst(rate / 2, (i) => 0.8 * Math.sin((2 * Math.PI * 55 * i) / rate) * Math.exp(-i / (rate * 0.08)));
    const m = analyseVoice(x, x);
    expect(m.peak).toBeCloseTo(0.8, 1);
    expect(m.low).toBeGreaterThan(0.9);
    expect(m.centroid).toBeGreaterThan(40);
    expect(m.centroid).toBeLessThan(90);
    expect(m.tonality).toBeGreaterThan(0.8);
    expect(m.noise).toBeLessThan(0.3);
    // 0.8 * exp(-t / 0.08) falls under 0.001 at t = 0.08 * ln(800) = 0.535 s, so it runs to the end of this half second
    expect(m.lengthMs).toBeGreaterThan(400);
    expect(m.t20Ms).toBeGreaterThan(120);
    expect(m.t20Ms).toBeLessThan(220);
    expect(m.clipFrac).toBe(0);
    expect(m.silent).toBe(false);
  });

  it('measures a short noise burst as bright, noisy, short and transient', () => {
    const x = burst(rate / 5, (i) => 0.7 * rnd() * Math.exp(-i / (rate * 0.012)));
    const m = analyseVoice(x, x);
    expect(m.noise).toBeGreaterThan(0.6);
    expect(m.high).toBeGreaterThan(0.4);
    expect(m.centroid).toBeGreaterThan(4000);
    expect(m.lengthMs).toBeLessThan(120);
    expect(m.transientDb).toBeGreaterThan(5);
  });

  it('sees clipping, silence, offsets and non-finite output', () => {
    const loud = burst(rate / 10, () => 1);
    expect(analyseVoice(loud, loud).clipFrac).toBeGreaterThan(0.9);
    expect(analyseVoice(new Float32Array(1000)).silent).toBe(true);
    const nan = burst(1000, (i) => (i === 10 ? NaN : 0.5));
    expect(safety(analyseVoice(nan), 'perc').factor).toBe(0);
    const dc = burst(rate / 2, () => 0.4);
    expect(analyseVoice(dc, dc).dc).toBeGreaterThan(0.9);
    expect(safety(analyseVoice(dc, dc), 'perc').flags).toContain('dc-offset');
  });

  it('sees a pitch that falls', () => {
    let ph = 0;
    const x = burst(rate / 3, (i) => {
      const f = 50 + 250 * Math.exp(-i / (rate * 0.03));
      ph += (2 * Math.PI * f) / rate;
      return 0.8 * Math.sin(ph) * Math.exp(-i / (rate * 0.15));
    });
    const m = analyseVoice(x, x);
    expect(m.sweepOct).toBeGreaterThan(1);
  });
});

describe('instrument scoring', () => {
  const rate = 44100;
  const tone = (hz: number, tau: number, n = rate / 2): Float32Array => Float32Array.from({ length: n }, (_, i) => 0.7 * Math.sin((2 * Math.PI * hz * i) / rate) * Math.exp(-i / (rate * tau)));
  let seed = 3;
  const noise = (tau: number, n: number): Float32Array => Float32Array.from({ length: n }, (_, i) => 0.7 * (((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296) * 2 - 1) * Math.exp(-i / (rate * tau)));

  it('knows a kick from a hat from a drone, as tendencies', () => {
    const kick = analyseVoice(tone(52, 0.09));
    const hat = analyseVoice(noise(0.01, rate / 4));
    expect(looksLike('kick', kick)).toBe(true);
    expect(looksLike('kick', hat)).toBe(false);
    expect(looksLike('chat', hat)).toBe(true);
    expect(looksLike('chat', kick)).toBe(false);
    const open = analyseVoice(noise(0.12, rate));
    expect(looksLike('ohat', open)).toBe(true);
    expect(convention('ohat', open)).toBeGreaterThan(convention('chat', open));
    const drone = analyseVoice(Float32Array.from({ length: rate }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 100 * i) / rate)));
    expect(safety(drone, 'kick').flags).toContain('drone');
  });

  it('lets WILDNESS relax the convention but never the safety', () => {
    const hatLikeKick = analyseVoice(noise(0.01, rate / 4));
    const strict = judge('kick', hatLikeKick, 0);
    const wild = judge('kick', hatLikeKick, 1);
    expect(wild.score).toBeGreaterThan(strict.score);
    const silent = analyseVoice(new Float32Array(2000));
    expect(judge('kick', silent, 1).score).toBe(0);
    expect(judge('kick', silent, 0).score).toBe(0);
  });

  it('calls two near-identical voices similar and two different ones not', () => {
    const a = { instr: 'ltom' as const, m: analyseVoice(tone(110, 0.1)) };
    const b = { instr: 'htom' as const, m: analyseVoice(tone(112, 0.1)) };
    const c = { instr: 'htom' as const, m: analyseVoice(tone(330, 0.1)) };
    expect(similarity(a, b)).toBeGreaterThan(0.5);
    expect(similarity(a, c)).toBeLessThan(0.3);
    expect(kitSameness([a, b])).toBeGreaterThan(kitSameness([a, c]));
  });
});

// ---------------------------------------------------------------------------- generation
describe('deterministic generation', () => {
  it('gives the same kit for the same seed, CHARACTER and WILDNESS, through the whole pipeline', () => {
    for (const flavour of ['machine', 'glitch'] as KitFlavour[])
      for (const w of [0.1, 0.9]) {
        const a = makeKit(1234, flavour, w);
        const b = makeKit(1234, flavour, w);
        expect(a).toEqual(b);
        expect(makeKit(1235, flavour, w).params).not.toEqual(a.params);
      }
  });

  it('gives a different kit for another CHARACTER or WILDNESS', () => {
    const a = makeKit(77, 'machine', 0.5);
    expect(makeKit(77, 'dub', 0.5).params).not.toEqual(a.params);
    expect(makeKit(77, 'machine', 0.95).params).not.toEqual(a.params);
  });

  it('keeps every parameter an integer in 0-127 at every CHARACTER and WILDNESS', () => {
    for (const flavour of CHARACTERS)
      for (const w of [0, 0.25, 0.5, 0.75, 1])
        for (const s of seeds(3)) {
          const k = generateKit(init, { seed: s, flavour, voiceRoles: STANDARD, locks: noLocks, wildness: w });
          for (const v of k.params) {
            expect(Number.isInteger(v)).toBe(true);
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThanOrEqual(127);
          }
          const m = mutateKit(k, { seed: s, flavour, voiceRoles: STANDARD, locks: noLocks, amount: 0.6, wildness: w });
          for (const v of m.params) {
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThanOrEqual(127);
          }
        }
  });
});

describe('audible, safe output', () => {
  it.each([0.05, 0.5, 1])('every voice of every CHARACTER is audible, unclipped and not a drone at WILDNESS %s', (w) => {
    for (const flavour of CHARACTERS)
      for (const s of seeds(2, 2)) {
        const kit = makeKit(s, flavour, w, DEFAULT_CANDIDATES, s % 2 ? ALT : STANDARD);
        for (const [instr, trig] of INSTR) {
          const m = measure(kit, trig);
          const label = `${flavour} w${w} seed ${s} ${instr}`;
          expect(m.silent, label).toBe(false);
          expect(m.peak, label).toBeGreaterThan(0.03);
          expect(m.peak, label).toBeLessThan(0.99);
          expect(m.clipFrac, label).toBe(0);
          expect(m.lengthMs, label).toBeGreaterThan(8);
          expect(safety(m, instr).factor, label).toBeGreaterThan(0.2);
        }
      }
  });

  it('keeps a kit from being loud all round', () => {
    for (const w of [0.1, 1])
      for (const s of seeds(4, 3)) {
        const kit = makeKit(s, 'industrial', w);
        const peaks = INSTR.map(([, t]) => measure(kit, t).peak);
        expect(Math.max(...peaks)).toBeLessThan(0.8);
        expect(Math.max(...peaks) / Math.min(...peaks)).toBeLessThan(6);
      }
  });
});

describe('instrument tendencies at low WILDNESS', () => {
  const kits = seeds(12, 4).map((s, i) => makeKit(s, CHARACTERS[i % CHARACTERS.length]!, 0.1));
  const rows = kits.map((k) => Object.fromEntries(INSTR.map(([i, t]) => [i, measure(k, t)]))) as Record<Instrument, VoiceMetrics>[];

  it('mostly makes kicks that are kicks, snares that are snares, hats that are hats', () => {
    for (const [instr, min] of [['kick', 0.9], ['snare', 0.75], ['chat', 0.85], ['ohat', 0.85], ['cymbal', 0.85], ['ltom', 0.85], ['htom', 0.85]] as [Instrument, number][]) {
      const like = rows.filter((r) => looksLike(instr, r[instr])).length / rows.length;
      expect(like, instr).toBeGreaterThanOrEqual(min);
    }
  });

  it('gives a kick a low body, an open hat a longer decay than a closed hat, a cymbal the longest', () => {
    for (const r of rows) {
      expect(r.kick.low).toBeGreaterThan(0.3);
      expect(r.ohat.lengthMs).toBeGreaterThan(r.chat.lengthMs * 1.5);
      expect(r.chat.centroid).toBeGreaterThan(2500);
      expect(r.cymbal.lengthMs).toBeGreaterThan(r.chat.lengthMs);
    }
  });

  it('keeps the two toms apart', () => {
    const apart = rows.filter((r) => r.htom.centroid > r.ltom.centroid * 1.15).length / rows.length;
    expect(apart).toBeGreaterThanOrEqual(0.85);
  });

  it('does not give a kit one decay for everything', () => {
    const spread = kits.map((_, i) => sd(INSTR.map(([ins]) => Math.log2(Math.max(10, rows[i]![ins].lengthMs)))));
    expect(Math.min(...spread)).toBeGreaterThan(0.6);
  });
});

describe('CHARACTER differentiation', () => {
  const S = seeds(8, 5);
  const byChar = Object.fromEntries(CHARACTERS.map((c) => [c, S.map((s) => makeKit(s, c, 0.5))])) as Record<KitFlavour, SynthKit[]>;
  const avg = (c: KitFlavour, trig: number, f: (m: VoiceMetrics) => number) => mean(byChar[c].map((k) => f(measure(k, trig))));

  it('makes DUB kicks longer than MACHINE kicks, and those longer than GLITCH kicks', () => {
    const len = (c: KitFlavour) => avg(c, 0, (m) => m.lengthMs);
    expect(len('dub')).toBeGreaterThan(len('machine') * 1.4);
    expect(len('machine')).toBeGreaterThan(len('glitch') * 1.3);
  });

  it('makes INDUSTRIAL driven and GLITCH crushed where MACHINE is clean', () => {
    const drive = (c: KitFlavour) => mean(byChar[c].map((k) => k.params[voiceKeys(3).drive!]! + k.params[voiceKeys(0).drive!]!));
    expect(drive('industrial')).toBeGreaterThan(drive('machine') + 40);
    const crush = (c: KitFlavour) => mean(byChar[c].flatMap((k) => [0, 1, 2, 3, 4, 5].map((v) => (k.params[voiceKeys(v).rate!]! < 127 ? 1 : 0))));
    expect(crush('glitch')).toBeGreaterThan(crush('machine'));
    const fm = (c: KitFlavour) => mean(byChar[c].map((k) => k.params[voiceKeys(0).fmAmt!]!));
    expect(fm('industrial')).toBeGreaterThan(fm('machine') + 15);
  });

  it('makes DUB snares darker than ACOUSTIC snares', () => {
    expect(avg('acoustic', 3, (m) => m.centroid)).toBeGreaterThan(avg('dub', 3, (m) => m.centroid) * 1.5);
  });

  it('makes six kits that are all measurably different from each other', () => {
    const feat = (c: KitFlavour) =>
      INSTR.flatMap(([, t]) => {
        const ms = byChar[c].map((k) => measure(k, t));
        return [Math.log2(Math.max(30, mean(ms.map((m) => m.centroid)))), Math.log2(Math.max(5, mean(ms.map((m) => m.lengthMs)))), mean(ms.map((m) => m.noise)) * 3, mean(ms.map((m) => m.high)) * 3];
      });
    const F = CHARACTERS.map(feat);
    for (let a = 0; a < F.length; a++)
      for (let b = a + 1; b < F.length; b++) {
        const d = Math.sqrt(F[a]!.reduce((s, v, k) => s + (v - F[b]![k]!) ** 2, 0));
        expect(d, `${CHARACTERS[a]} vs ${CHARACTERS[b]}`).toBeGreaterThan(0.6);
      }
  });
});

describe('WILDNESS', () => {
  it('draws a wider range of kicks the higher it is', () => {
    const S = seeds(40, 6);
    const spread = (w: number, f: (k: SynthKit) => number) => sd(S.map((s) => f(generateKit(init, { seed: s, flavour: 'machine', voiceRoles: STANDARD, locks: noLocks, wildness: w }))));
    const decay = (k: SynthKit) => k.params[voiceKeys(0).decay!]!;
    const coarse = (k: SynthKit) => k.params[voiceKeys(0).coarse!]!;
    expect(spread(1, decay)).toBeGreaterThan(spread(0.1, decay) * 1.5);
    expect(spread(1, coarse)).toBeGreaterThan(spread(0.1, coarse) * 1.5);
  });

  it('keeps low WILDNESS to the usual choices and opens the menus when high', () => {
    const S = seeds(60, 7);
    const waves = (w: number) => new Set(S.map((s) => generateKit(init, { seed: s, flavour: 'machine', voiceRoles: STANDARD, locks: noLocks, wildness: w }).params[voiceKeys(5).wave!]));
    expect(waves(0.1).size).toBe(1);
    expect(waves(1).size).toBeGreaterThanOrEqual(3);
  });

  it('makes more unexpected instrument identities when high, and few when low', () => {
    const S = seeds(24, 8);
    const rate = (w: number) => {
      let notLike = 0;
      for (const s of S) {
        const k = makeKit(s, 'electro', w);
        if (!looksLike('kick', measure(k, 0)) || !looksLike('snare', measure(k, 3))) notLike++;
      }
      return notLike / S.length;
    };
    const low = rate(0.1);
    const high = rate(1);
    expect(high).toBeGreaterThan(low + 0.25);
    expect(low).toBeLessThan(0.2);
  });

  it('does not mean louder, harsher or more distorted', () => {
    const S = seeds(30, 9);
    const avgP = (w: number, f: (k: SynthKit) => number) => mean(S.map((s) => f(generateKit(init, { seed: s, flavour: 'machine', voiceRoles: STANDARD, locks: noLocks, wildness: w }))));
    const drive = (k: SynthKit) => mean([0, 3, 4, 5].map((v) => k.params[voiceKeys(v).drive!]!));
    const reso = (k: SynthKit) => mean([0, 1, 2, 3, 4, 5].map((v) => k.params[voiceKeys(v).reso!]!));
    // drive, resonance and volume are drawn from the recipe's own range at any WILDNESS
    expect(avgP(1, drive)).toBeLessThan(avgP(0.1, drive) + 8);
    expect(avgP(1, reso)).toBeLessThan(avgP(0.1, reso) + 8);
    // after the check every voice sits at the same level whatever the WILDNESS
    const peak = (w: number) => mean(seeds(6, 10).flatMap((s) => { const k = makeKit(s, 'machine', w); return INSTR.map(([, t]) => measure(k, t).peak); }));
    expect(Math.abs(peak(1) - peak(0.1))).toBeLessThan(0.06);
  });

  it('makes odder sounds without making unusable ones', () => {
    for (const s of seeds(10, 11)) {
      const k = makeKit(s, 'glitch', 1);
      for (const [instr, t] of INSTR) {
        const m = measure(k, t);
        expect(safety(m, instr).factor, `seed ${s} ${instr}`).toBeGreaterThan(0.2);
      }
    }
  });
});

describe('candidate selection', () => {
  it('scores the chosen kit at least as well as the generator alone, and better on average', () => {
    const score = (k: SynthKit, w: number) => mean(INSTR.map(([instr, t]) => judge(instr, measure(k, t), w).score));
    const gains: number[] = [];
    for (const s of seeds(10, 12)) {
      const flavour = CHARACTERS[s % 6]!;
      const plain = score(makeKit(s, flavour, 0.2, 1), 0.2);
      const chosen = score(makeKit(s, flavour, 0.2, DEFAULT_CANDIDATES), 0.2);
      gains.push(chosen - plain);
      expect(chosen).toBeGreaterThan(plain - 0.04);
    }
    expect(mean(gains)).toBeGreaterThan(0.01);
  });

  it('reports what it rendered and kept', () => {
    const raw = generateKit(init, { seed: 5, flavour: 'machine', voiceRoles: STANDARD, locks: noLocks, wildness: 0.3 });
    const { report } = checkKit(newLxr(), raw, { flavour: 'machine', voiceRoles: STANDARD, seed: 5, fallback: init, wildness: 0.3, select: { mode: 'design', candidates: 4 } });
    expect(report.selection.length).toBe(6);
    for (const s of report.selection) {
      expect(s.rendered).toBeGreaterThan(1);
      expect(s.rendered).toBeLessThanOrEqual(4);
      expect(s.kept).toBeLessThan(s.rendered);
    }
  });

  it('throws out hopeless parameter combinations without rendering them', () => {
    const k = { ...init, params: init.params.slice() };
    const keys = voiceKeys(0);
    k.params[keys.ftype!] = 0;
    k.params[keys.cutoff!] = 4;
    expect(unsuitable(k, 0, 'kick')).toBe('filter-closed');
    k.params[keys.cutoff!] = 100;
    k.params[keys.vol!] = 100;
    k.params[keys.decay!] = 20;
    expect(unsuitable(k, 0, 'kick')).toBeNull();
  });

  it('judges the voice 5 as closed and open hat', () => {
    expect(probesFor(5, 'hat', ['chat', 'ohat']).map((p) => p.trig)).toEqual([5, 6]);
    expect(probesFor(3, 'clap', ['clap']).map((p) => p.instr)).toEqual(['clap']);
  });

  it('keeps the two toms and the two hats from being the same sound', () => {
    let alike = 0;
    const S = seeds(16, 13);
    for (const s of S) {
      const k = makeKit(s, 'machine', 0.3);
      const t = similarity({ instr: 'ltom', m: measure(k, 1) }, { instr: 'htom', m: measure(k, 2) });
      if (t > 0.5) alike++;
    }
    expect(alike / S.length).toBeLessThan(0.1);
  });
});

describe('MUTATE with selection', () => {
  it('keeps every mutated voice audible and in range, and moves the sound', () => {
    for (const s of seeds(5, 14)) {
      const base = makeKit(s, 'electro', 0.5);
      const mutated = mutateKit(base, { seed: s, flavour: 'electro', voiceRoles: STANDARD, locks: noLocks, amount: 0.5, wildness: 0.5 });
      const { kit } = checkKit(newLxr(), mutated, { flavour: 'electro', voiceRoles: STANDARD, seed: s, fallback: init, wildness: 0.5, select: { mode: 'mutate', candidates: DEFAULT_CANDIDATES, base, amount: 0.5 } });
      expect(kit.params).not.toEqual(base.params);
      for (const [instr, t] of INSTR) {
        const m = measure(kit, t);
        expect(m.peak).toBeGreaterThan(0.03);
        expect(safety(m, instr).factor).toBeGreaterThan(0.2);
      }
      for (const v of kit.params) expect(v >= 0 && v <= 127 && Number.isInteger(v)).toBe(true);
    }
  });

  it('is deterministic', () => {
    const base = makeKit(9, 'dub', 0.5);
    const run = () => {
      const mutated = mutateKit(base, { seed: 4, flavour: 'dub', voiceRoles: STANDARD, locks: noLocks, amount: 0.4, wildness: 0.5, voices: [1] });
      return checkKit(newLxr(), mutated, { flavour: 'dub', voiceRoles: STANDARD, seed: 4, voices: [1], fallback: init, wildness: 0.5, select: { mode: 'mutate', candidates: 4, base, amount: 0.4 } }).kit;
    };
    expect(run()).toEqual(run());
  });

  it('changes only the voice it was asked to change', () => {
    const base = makeKit(21, 'machine', 0.5);
    const mutated = mutateKit(base, { seed: 8, flavour: 'machine', voiceRoles: STANDARD, locks: noLocks, amount: 0.5, wildness: 0.5, voices: [3] });
    const { kit } = checkKit(newLxr(), mutated, { flavour: 'machine', voiceRoles: STANDARD, seed: 8, voices: [3], fallback: init, wildness: 0.5, select: { mode: 'mutate', candidates: 4, base, amount: 0.5 } });
    const own = new Set(Object.values(voiceKeys(3)));
    kit.params.forEach((v, p) => {
      if (v !== base.params[p]) expect(own.has(p)).toBe(true);
    });
  });
});

describe('locks and manual edits survive', () => {
  it('never overwrites a locked voice or a locked parameter, through generation, selection and mutation', () => {
    const locks = { voices: [true, false, false, false, false, false], params: [PAR.VELOD4, voiceKeys(5).cutoff!] };
    for (const flavour of ['glitch', 'dub'] as KitFlavour[]) {
      const raw = generateKit(init, { seed: 31, flavour, voiceRoles: STANDARD, locks, wildness: 0.9 });
      const { kit } = checkKit(newLxr(), raw, { flavour, voiceRoles: STANDARD, seed: 31, fallback: init, wildness: 0.9, locked: locks.voices, lockedParams: locks.params, select: { mode: 'design', candidates: DEFAULT_CANDIDATES } });
      for (const p of Object.values(voiceKeys(0))) if (p !== undefined) expect(kit.params[p]).toBe(init.params[p]);
      for (const p of locks.params) expect(kit.params[p]).toBe(init.params[p]);
      const mutated = mutateKit(kit, { seed: 2, flavour, voiceRoles: STANDARD, locks, amount: 0.8, wildness: 0.9 });
      const again = checkKit(newLxr(), mutated, { flavour, voiceRoles: STANDARD, seed: 2, fallback: init, wildness: 0.9, locked: locks.voices, lockedParams: locks.params, select: { mode: 'mutate', candidates: DEFAULT_CANDIDATES, base: kit, amount: 0.8 } }).kit;
      for (const p of Object.values(voiceKeys(0))) if (p !== undefined) expect(again.params[p]).toBe(init.params[p]);
      for (const p of locks.params) expect(again.params[p]).toBe(init.params[p]);
    }
  });
});

describe('saved projects', () => {
  it('records and restores how a kit was generated', () => {
    const p = defaultProject();
    p.kit.made = { generator: KIT_GENERATOR, character: 'industrial', wildness: 0.8 };
    const back = parseProject(serialize(p), init);
    expect(back.version).toBe(9);
    expect(back.kit.made).toEqual({ generator: KIT_GENERATOR, character: 'industrial', wildness: 0.8 });
  });

  it('opens a version 8 project (no record) and a damaged record', () => {
    const p = defaultProject();
    const raw = JSON.parse(serialize(p));
    raw.version = 8;
    delete raw.kit.made;
    const old = repairProject(raw, init);
    expect(old.kit.made).toBeUndefined();
    expect(old.version).toBe(9);
    raw.kit.made = { generator: 'x', character: 'jazz', wildness: 9 };
    expect(repairProject(raw, init).kit.made).toBeUndefined();
    raw.kit.made = { generator: 2, character: 'dub', wildness: 9 };
    expect(repairProject(raw, init).kit.made?.wildness).toBe(1);
  });

  it('keeps a kit saved by an older generator exactly as it was', () => {
    const k = makeKit(55, 'machine', 0.5);
    const p = defaultProject();
    p.kit.synth = k;
    const back = parseProject(serialize(p), init);
    expect(back.kit.synth).toEqual(k);
  });
});

describe('performance', () => {
  it('checks a whole kit with candidate selection in well under a second', () => {
    const raw = generateKit(init, { seed: 3, flavour: 'machine', voiceRoles: STANDARD, locks: noLocks, wildness: 0.5 });
    const t = performance.now();
    for (let i = 0; i < 3; i++) checkKit(newLxr(), raw, { flavour: 'machine', voiceRoles: STANDARD, seed: 3 + i, fallback: init, wildness: 0.5, select: { mode: 'design', candidates: DEFAULT_CANDIDATES } });
    expect((performance.now() - t) / 3).toBeLessThan(1500);
  });
});
