/**
 * Kit analysis through the real engine: every generated or mutated voice is rendered by the
 * LXR engine itself and measured, so CLATTER never hands the user a silent or clipping kit.
 *
 *   - level: each voice's VOLUME is set so its peak sits at a target for its archetype
 *     (kicks loudest, cymbals quietest);
 *   - silence: a voice that is still inaudible (or vanishes in under 15 ms) is designed again
 *     with another seed, and after a few tries falls back to the firmware's init kit voice;
 *   - selection (GENERATE KIT, MUTATE): each voice is designed several times, every candidate is
 *     rendered and analysed (analysis/voiceAnalysis.ts), scored for the instrument it is meant to
 *     be and for safety (voiceScore.ts), and the best is kept, nudged by how much it differs from
 *     the other voices of the kit. WILDNESS decides how much the instrument's conventions count.
 *     Everything is seeded, so the same kit, seed, CHARACTER and WILDNESS choose the same sounds,
 *     provided the engine passed in is a new instance: the LXR engine's cymbal keeps some state
 *     across init(), so a reused engine renders it a little differently each time.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import type { SynthKit } from '../model/types';
import type { LxrEngine } from '../audio/lxr/lxr';
import { analyseVoice, type VoiceMetrics } from '../analysis/voiceAnalysis';
import { hash32, Rng } from '../rhythm/rng';
import type { KitFlavour } from '../rhythm/styles';
import { archetypeFor, designVoice, designVoiceInto, KIT_WILDNESS_DEFAULT, mutateKit, snapCoarse, voiceKeys, type Archetype, type VoicePitchPlan } from './kitgen';
import { HARDWARE_ONLY } from './lxrParams';
import { judge, kitSameness, type Instrument, type KitItem } from './voiceScore';

/** Send a whole kit to an engine (all sound parameters, then the modulation targets). */
export function applyKit(e: { setParam(p: number, v: number): void; setModTarget(kind: 0 | 1, voice: number, param: number): void }, kit: SynthKit): void {
  for (let p = 1; p < kit.params.length; p++) {
    if (HARDWARE_ONLY.has(p)) continue;
    e.setParam(p, kit.params[p] ?? 0);
  }
  for (let v = 0; v < 6; v++) {
    e.setModTarget(0, v, kit.lfoTarget[v] ?? 0);
    e.setModTarget(1, v, kit.velTarget[v] ?? 0);
  }
}

/** Read the engine's whole kit (after init: the firmware's init kit). */
export function readKit(e: LxrEngine): SynthKit {
  const params: number[] = [];
  for (let p = 0; p < e.paramCount; p++) params.push(e.getParam(p));
  return { params, lfoTarget: [0, 0, 0, 0, 0, 0], velTarget: [0, 0, 0, 0, 0, 0] };
}

export interface VoiceMeasure {
  peak: number;
  rms: number;
  /** milliseconds until it falls below -60 dBFS */
  length: number;
}

/** Render one trigger alone with a kit and measure it. */
export function measureTrigger(e: LxrEngine, kit: SynthKit, trig: number, maxSeconds = 2.5, velocity = 127): VoiceMeasure {
  e.init(1234);
  applyKit(e, kit);
  e.trigger(trig, velocity, 60);
  const v = trig >= 5 ? 5 : trig;
  const blocks = Math.ceil((44100 * maxSeconds) / e.block);
  let peak = 0;
  let sum = 0;
  let n = 0;
  let last = 0;
  for (let b = 0; b < blocks; b++) {
    e.render();
    const oL = e.offset(v, 0);
    const oR = e.offset(v, 1);
    for (let i = 0; i < e.block; i++) {
      const a = Math.max(Math.abs(e.out[oL + i]!), Math.abs(e.out[oR + i]!));
      if (a > peak) peak = a;
      sum += a * a;
      n++;
      if (a > 0.001) last = b * e.block + i;
    }
    if (b * e.block - last > 44100 * 0.3 && b * e.block > 4410) break;
  }
  return { peak, rms: Math.sqrt(sum / Math.max(1, n)), length: (last / 44100) * 1000 };
}

/**
 * Render one trigger alone with a kit and return the voice's stereo output (the audio the
 * analysis judges). It stops early once the sound has been under -60 dBFS for 300 ms.
 */
export function renderTrigger(e: LxrEngine, kit: SynthKit, trig: number, maxSeconds = 2.5, velocity = 127): { left: Float32Array; right: Float32Array } {
  e.init(1234);
  applyKit(e, kit);
  e.trigger(trig, velocity, 60);
  const v = trig >= 5 ? 5 : trig;
  const blocks = Math.ceil((44100 * maxSeconds) / e.block);
  const left = new Float32Array(blocks * e.block);
  const right = new Float32Array(blocks * e.block);
  let last = 0;
  let n = 0;
  for (let b = 0; b < blocks; b++) {
    e.render();
    const oL = e.offset(v, 0);
    const oR = e.offset(v, 1);
    for (let i = 0; i < e.block; i++) {
      const l = e.out[oL + i]!;
      const r = e.out[oR + i]!;
      left[n] = l;
      right[n] = r;
      if (Math.abs(l) > 0.001 || Math.abs(r) > 0.001) last = n;
      n++;
    }
    if (b * e.block - last > 44100 * 0.3 && b * e.block > 4410) break;
  }
  return { left: left.subarray(0, n), right: right.subarray(0, n) };
}

/** Target peaks per archetype (stereo-panned voice outputs at velocity 127). */
const TARGET: Record<Archetype, number> = { kick: 0.5, tom: 0.42, perc: 0.36, zap: 0.3, snare: 0.45, clap: 0.42, hat: 0.28, cymbal: 0.24 };

const TRIGGER_OF_VOICE = [0, 1, 2, 3, 4, 5];

export interface CheckOptions {
  flavour: KitFlavour;
  voiceRoles: string[][];
  seed: number;
  /** voices to check (default: all) */
  voices?: number[];
  /** voices that must not be redesigned (locked) */
  locked?: boolean[];
  /** the firmware's init kit, the last resort for a voice */
  fallback?: SynthKit;
  /** per voice: the scale a redesigned voice's pitch must stay on (plain data: this travels to a Worker) */
  pitch?: (VoicePitchPlan | null)[];
  /** 0-1: how strictly voices must follow their instrument (default KIT_WILDNESS_DEFAULT) */
  wildness?: number;
  /** parameters that must not be redesigned (locked) */
  lockedParams?: number[];
  /** choose among several candidates per voice (plain data: this travels to a Worker) */
  select?: SelectOptions;
}

export interface SelectOptions {
  /** `design`: the other candidates are new designs of the voice; `mutate`: other mutations of `base` */
  mode: 'design' | 'mutate';
  /** candidates evaluated per voice, the incoming one included */
  candidates: number;
  /** mutate: the kit before the mutation, and its amount */
  base?: SynthKit;
  amount?: number;
}

/** Candidates per voice when none is given. Each costs one to two short renders (about 5 ms each in the engine). */
export const DEFAULT_CANDIDATES = 5;

export interface CheckReport {
  levels: number[];
  redesigned: number[];
  fallback: number[];
  /** per voice: how many candidates were rendered, which one was kept (0 = the incoming one) and its score */
  selection: { voice: number; rendered: number; kept: number; score: number; flags: string[] }[];
}

/** Level-match every voice and replace inaudible ones. Returns a new kit. */
export function checkKit(e: LxrEngine, kit0: SynthKit, o: CheckOptions): { kit: SynthKit; report: CheckReport } {
  const kit: SynthKit = { params: kit0.params.slice(), lfoTarget: kit0.lfoTarget.slice(), velTarget: kit0.velTarget.slice() };
  const report: CheckReport = { levels: [], redesigned: [], fallback: [], selection: [] };
  const lockedParams = new Set(o.lockedParams ?? []);
  const w = o.wildness ?? KIT_WILDNESS_DEFAULT;
  if (o.select && o.select.candidates > 1) selectVoices(e, kit, o, report);
  for (const v of o.voices ?? [0, 1, 2, 3, 4, 5]) {
    const keys = voiceKeys(v);
    const volP = keys.vol!;
    const a = archetypeFor(v, o.voiceRoles[v] ?? []);
    const trig = TRIGGER_OF_VOICE[v]!;
    let m = measureTrigger(e, kit, trig);
    let tries = 0;
    while ((m.peak < 0.03 || m.length < 15) && tries < 5 && !o.locked?.[v]) {
      const d = designVoice(v, a, o.flavour, new Rng(hash32(o.seed, 777, v, tries)), w);
      const plan = o.pitch?.[v];
      if (plan && d.values.coarse !== undefined) d.values.coarse = snapCoarse(plan, d.values.coarse);
      for (const [k, val] of Object.entries(d.values)) {
        const p = keys[k as keyof typeof keys];
        if (p !== undefined && !lockedParams.has(p)) kit.params[p] = val as number;
      }
      kit.lfoTarget[v] = 0;
      m = measureTrigger(e, kit, trig);
      tries++;
      if (!report.redesigned.includes(v)) report.redesigned.push(v);
    }
    if ((m.peak < 0.03 || m.length < 15) && o.fallback && !o.locked?.[v]) {
      for (const p of Object.values(keys)) if (p !== undefined) kit.params[p] = o.fallback.params[p] ?? 0;
      kit.lfoTarget[v] = 0;
      kit.params[keys.velVol!] = 1;
      m = measureTrigger(e, kit, trig);
      report.fallback.push(v);
    }
    // loudness rescue: a voice far below its target even at full volume has its filter
    // opened (a band-pass far above a low tone, a closed low-pass) and its volume raised
    if (!o.locked?.[v] && m.peak < TARGET[a] * 0.4) {
      kit.params[volP] = 127;
      if (keys.ftype !== undefined && keys.cutoff !== undefined) {
        kit.params[keys.ftype] = a === 'hat' || a === 'cymbal' ? 1 : 0;
        kit.params[keys.cutoff] = a === 'hat' || a === 'cymbal' ? Math.min(kit.params[keys.cutoff]!, 90) : Math.max(kit.params[keys.cutoff]!, 105);
      }
      m = measureTrigger(e, kit, trig);
    }
    // level: VOLUME is a linear gain after the voice (two passes, the snare's drive follows it)
    if (!o.locked?.[v]) {
      for (let pass = 0; pass < 2 && m.peak > 0.001; pass++) {
        const want = TARGET[a];
        const cur = kit.params[volP]!;
        const next = Math.max(20, Math.min(127, Math.round((cur * want) / m.peak)));
        if (Math.abs(next - cur) < 2) break;
        kit.params[volP] = next;
        m = measureTrigger(e, kit, trig);
      }
    }
    report.levels[v] = m.peak;
  }
  return { kit, report };
}

// ---------------------------------------------------------------------------- selection
interface Probe {
  instr: Instrument;
  trig: number;
  /** longest render, seconds */
  secs: number;
}

/** What to render and judge for a voice: the instruments its tracks play and the triggers that sound them. */
export function probesFor(v: number, a: Archetype, roles: readonly string[]): Probe[] {
  if (v === 5) return [{ instr: 'chat', trig: 5, secs: 0.8 }, { instr: 'ohat', trig: 6, secs: 1.1 }];
  if (v === 4) return a === 'hat' ? [{ instr: 'chat', trig: 4, secs: 0.8 }] : [{ instr: 'cymbal', trig: 4, secs: 1.8 }];
  if (v === 3) return [{ instr: a === 'clap' ? 'clap' : 'snare', trig: 3, secs: 0.8 }];
  const instr: Instrument = roles.includes('kick') ? 'kick' : roles.includes('ltom') ? 'ltom' : roles.includes('htom') ? 'htom' : roles.includes('perc') ? 'perc' : roles.includes('fx') ? 'fx' : v === 0 ? 'kick' : v === 1 ? 'ltom' : 'htom';
  return [{ instr, trig: v, secs: 1 }];
}

/**
 * Parameter combinations that are known (from the evaluator, docs/KIT_EVALUATION.md) to give an
 * unusable voice at any WILDNESS, found without rendering: a filter that closes the voice off,
 * an envelope that ends before it starts. Cheap, so many candidates can be thrown away before
 * the few that survive are rendered.
 */
export function unsuitable(kit: SynthKit, v: number, a: Archetype): string | null {
  const k = voiceKeys(v);
  const get = (key: keyof typeof k): number | undefined => (k[key] === undefined ? undefined : kit.params[k[key]!]);
  const ftype = get('ftype');
  const cutoff = get('cutoff');
  const decay = get('decay');
  const vol = get('vol');
  if (vol !== undefined && vol < 20) return 'volume';
  if (decay !== undefined && decay < 1 && a !== 'hat') return 'decay';
  if (ftype !== undefined && cutoff !== undefined) {
    // a low-pass shut down over the voice, a high-pass up above everything it can say
    if ((ftype === 0 || ftype === 6) && cutoff < 18) return 'filter-closed';
    if (ftype === 1 && cutoff > 122) return 'filter-closed';
  }
  return null;
}

interface Cand {
  kit: SynthKit;
  metrics: VoiceMetrics[];
  score: number;
  flags: string[];
}

const copyVoice = (to: SynthKit, from: SynthKit, v: number): void => {
  for (const p of Object.values(voiceKeys(v))) if (p !== undefined) to.params[p] = from.params[p] ?? 0;
  to.lfoTarget[v] = from.lfoTarget[v] ?? 0;
  to.velTarget[v] = from.velTarget[v] ?? 0;
};

/**
 * Choose each voice among several candidates by rendering them (see the header). Writes the
 * chosen voices into `kit`.
 */
function selectVoices(e: LxrEngine, kit: SynthKit, o: CheckOptions, report: CheckReport): void {
  const sel = o.select!;
  const w = o.wildness ?? KIT_WILDNESS_DEFAULT;
  const voices = (o.voices ?? [0, 1, 2, 3, 4, 5]).filter((v) => !o.locked?.[v]);
  const gen = { seed: o.seed, flavour: o.flavour, voiceRoles: o.voiceRoles, locks: { voices: [false, false, false, false, false, false], params: o.lockedParams ?? [] }, wildness: w, pitch: (v: number) => o.pitch?.[v] ?? null };
  const pools: { v: number; probes: Probe[]; cands: Cand[] }[] = [];
  for (const v of voices) {
    const a = archetypeFor(v, o.voiceRoles[v] ?? []);
    const probes = probesFor(v, a, o.voiceRoles[v] ?? []);
    const list: SynthKit[] = [kit];
    let variant = 1;
    for (let tries = 0; list.length < sel.candidates && tries < sel.candidates * 4; tries++, variant++) {
      const c: SynthKit = { params: kit.params.slice(), lfoTarget: kit.lfoTarget.slice(), velTarget: kit.velTarget.slice() };
      if (sel.mode === 'design') designVoiceInto(c, v, gen, variant);
      else if (sel.base) copyVoice(c, mutateKit(sel.base, { ...gen, seed: hash32(o.seed, 31337, v, variant), amount: sel.amount ?? 0.3, voices: [v] }), v);
      else break;
      if (unsuitable(c, v, a)) continue;
      list.push(c);
    }
    const cands: Cand[] = list.map((c) => {
      const metrics = probes.map((p) => {
        const r = renderTrigger(e, c, p.trig, p.secs);
        return analyseVoice(r.left, r.right);
      });
      const js = probes.map((p, i) => judge(p.instr, metrics[i]!, w));
      return { kit: c, metrics, score: js.reduce((x, j) => x + j.score, 0) / js.length, flags: js.flatMap((j, i) => (j.safety.flags.length ? [`${probes[i]!.instr}:${j.safety.flags.join('+')}`] : [])) };
    });
    pools.push({ v, probes, cands });
  }
  // the best of each voice, then a couple of passes letting each voice trade a little score for contrast with the rest
  const choice = pools.map((p) => p.cands.reduce((b, c, i) => (c.score > p.cands[b]!.score ? i : b), 0));
  const itemsOf = (chosen: number[]): KitItem[] => pools.flatMap((p, i) => p.probes.map((pr, j) => ({ instr: pr.instr, m: p.cands[chosen[i]!]!.metrics[j]! })));
  const LAMBDA = 0.2;
  const total = (chosen: number[]) => pools.reduce((s, p, i) => s + p.cands[chosen[i]!]!.score, 0) - LAMBDA * kitSameness(itemsOf(chosen));
  if (pools.length > 1)
    for (let pass = 0; pass < 2; pass++)
      for (let i = 0; i < pools.length; i++) {
        const best = pools[i]!.cands.reduce((b, c) => Math.max(b, c.score), 0);
        let bestIdx = choice[i]!;
        let bestTotal = total(choice);
        for (let c = 0; c < pools[i]!.cands.length; c++) {
          if (c === choice[i] || pools[i]!.cands[c]!.score < best - 0.15) continue;
          const t = total(choice.map((x, k) => (k === i ? c : x)));
          if (t > bestTotal + 1e-9) {
            bestTotal = t;
            bestIdx = c;
          }
        }
        choice[i] = bestIdx;
      }
  pools.forEach((p, i) => {
    const c = p.cands[choice[i]!]!;
    copyVoice(kit, c.kit, p.v);
    report.selection.push({ voice: p.v, rendered: p.cands.length, kept: choice[i]!, score: Math.round(c.score * 1000) / 1000, flags: c.flags });
  });
}
