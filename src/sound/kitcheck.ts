/**
 * Kit analysis through the real engine: every generated or mutated voice is rendered by the
 * LXR engine itself and measured, so CLATTER never hands the user a silent or clipping kit.
 *
 *   - level: each voice's VOLUME is set so its peak sits at a target for its archetype
 *     (kicks loudest, cymbals quietest);
 *   - silence: a voice that is still inaudible (or vanishes in under 15 ms) is designed again
 *     with another seed, and after a few tries falls back to the firmware's init kit voice;
 *   - recognition (profile designs, with `gen`): each voice is rendered, analysed (analysis.ts)
 *     and judged against its profile (judge.ts). A voice that does not sound like its instrument
 *     is designed again a few times from other seeds and the best-judged candidate is kept. The
 *     wilder the generation, the less this applies; above 70 % it does not apply at all, so wild
 *     sounds are never pulled back to convention.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import type { SynthKit } from '../model/types';
import type { LxrEngine } from '../audio/lxr/lxr';
import { hash32, Rng } from '../rhythm/rng';
import type { KitFlavour } from '../rhythm/styles';
import { archetypeFor, designProfileInto, designVoice, orderToms, voiceKeys, type Archetype } from './kitgen';
import { analyse, type SoundFeatures } from './analysis';
import { judge } from './judge';
import type { Profile } from './profiles';
import type { Character } from '../model/types';
import { HARDWARE_ONLY } from './lxrParams';

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

/** Render one trigger alone with a kit: the voice's mono output (left + right) / 2. */
export function renderTrigger(e: LxrEngine, kit: SynthKit, trig: number, seconds = 1.2, velocity = 127): Float32Array {
  e.init(1234);
  applyKit(e, kit);
  e.trigger(trig, velocity, 60);
  const v = trig >= 5 ? 5 : trig;
  const blocks = Math.ceil((44100 * seconds) / e.block);
  const out = new Float32Array(blocks * e.block);
  for (let b = 0; b < blocks; b++) {
    e.render();
    const oL = e.offset(v, 0);
    const oR = e.offset(v, 1);
    for (let i = 0; i < e.block; i++) out[b * e.block + i] = (e.out[oL + i]! + e.out[oR + i]!) * 0.5;
  }
  return out;
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
  /** profile designs: judge each voice against its profile and choose between candidates */
  gen?: { character: Character; wildness: number; profiles: Profile[] };
  /** parameters the candidates must not change (locked) */
  lockedParams?: number[];
}

/** Level targets per profile (as the archetype targets). */
const PROFILE_TARGET: Record<Profile, number> = { kick: 0.5, ltom: 0.42, htom: 0.42, perc: 0.36, fx: 0.3, snare: 0.45, clap: 0.42, chat: 0.28, ohat: 0.28, cymbal: 0.24 };

/** A voice rendered and measured as its profile is heard (the open-hat trigger for an open hat; both hats for a shared hat voice). */
export function voiceFeatures(e: LxrEngine, kit: SynthKit, voice: number, profile: Profile, roles: readonly string[]): { f: SoundFeatures; open?: SoundFeatures } {
  const trig = voice === 5 && profile === 'ohat' ? 6 : voice;
  const f = analyse(renderTrigger(e, kit, trig, profile === 'cymbal' ? 1.8 : profile === 'ohat' ? 1.5 : 1.2));
  const open = voice === 5 && profile === 'chat' && roles.includes('ohat') ? analyse(renderTrigger(e, kit, 6, 1.5)) : undefined;
  return { f, open };
}

/** How well a voice of a kit sounds like its profile, 0-1. */
export function voiceScore(e: LxrEngine, kit: SynthKit, voice: number, profile: Profile, roles: readonly string[]): number {
  const { f, open } = voiceFeatures(e, kit, voice, profile, roles);
  return judge(profile, f, open);
}

function copyVoice(from: SynthKit, to: SynthKit, voice: number): void {
  for (const p of Object.values(voiceKeys(voice))) if (p !== undefined) to.params[p] = from.params[p]!;
  to.lfoTarget[voice] = from.lfoTarget[voice]!;
  to.velTarget[voice] = from.velTarget[voice]!;
}

export interface CheckReport {
  levels: number[];
  redesigned: number[];
  fallback: number[];
  /** profile designs: each voice's judged score after the check (-1: not judged) */
  scores: number[];
}

/**
 * Level-match every voice and replace inaudible ones. Returns a new kit. For a result that
 * depends only on its inputs, give it a freshly instantiated engine: the firmware keeps its noise
 * oscillators' phase across init, so earlier renders on the same engine change noisy voices.
 */
export function checkKit(e: LxrEngine, kit0: SynthKit, o: CheckOptions): { kit: SynthKit; report: CheckReport } {
  const kit: SynthKit = { params: kit0.params.slice(), lfoTarget: kit0.lfoTarget.slice(), velTarget: kit0.velTarget.slice() };
  const report: CheckReport = { levels: [], redesigned: [], fallback: [], scores: [] };
  const lockedP = new Set(o.lockedParams ?? []);
  for (const v of o.voices ?? [0, 1, 2, 3, 4, 5]) {
    const keys = voiceKeys(v);
    const volP = keys.vol!;
    const roles = o.voiceRoles[v] ?? [];
    const a = archetypeFor(v, roles);
    const profile = o.gen?.profiles[v];
    const trig = TRIGGER_OF_VOICE[v]!;
    const redesign = (salt: number, k: number) => {
      if (o.gen && profile) designProfileInto(kit, v, profile, o.gen.character, o.gen.wildness, new Rng(hash32(o.seed, salt, v, k)), lockedP);
      else {
        const d = designVoice(v, a, o.flavour, new Rng(hash32(o.seed, salt, v, k)));
        for (const [key, val] of Object.entries(d.values)) {
          const p = keys[key as keyof typeof keys];
          if (p !== undefined) kit.params[p] = val as number;
        }
        kit.lfoTarget[v] = 0;
      }
    };
    // recognition: candidates for a voice that does not sound like its profile (less, the wilder)
    report.scores[v] = -1;
    if (o.gen && profile && !o.locked?.[v]) {
      const weight = Math.max(0, Math.min(1, 1 - o.gen.wildness / 0.7));
      if (weight > 0) {
        let best = voiceScore(e, kit, v, profile, roles);
        const tries = Math.round(2 + 4 * weight);
        if (best < 0.85) {
          const keep: SynthKit = { params: kit.params.slice(), lfoTarget: kit.lfoTarget.slice(), velTarget: kit.velTarget.slice() };
          for (let k = 0; k < tries && best < 0.95; k++) {
            redesign(555, k);
            const sc = voiceScore(e, kit, v, profile, roles);
            if (sc > best) {
              best = sc;
              copyVoice(kit, keep, v);
              if (!report.redesigned.includes(v)) report.redesigned.push(v);
            }
          }
          copyVoice(keep, kit, v);
        }
        report.scores[v] = best;
      }
    }
    // candidates are designed alone: keep the low tom below the high tom
    if (o.gen && report.redesigned.includes(v)) orderToms(kit, o.gen.profiles, (o.voices ?? [0, 1, 2, 3, 4, 5]).filter((x) => !o.locked?.[x]), o.gen.wildness, lockedP);
    let m = measureTrigger(e, kit, trig);
    let tries = 0;
    while ((m.peak < 0.03 || m.length < 15) && tries < 5 && !o.locked?.[v]) {
      redesign(777, tries);
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
    const target = profile ? PROFILE_TARGET[profile] : TARGET[a];
    const metal = profile ? profile === 'chat' || profile === 'ohat' || profile === 'cymbal' : a === 'hat' || a === 'cymbal';
    if (!o.locked?.[v] && m.peak < target * 0.4) {
      kit.params[volP] = 127;
      if (keys.ftype !== undefined && keys.cutoff !== undefined) {
        kit.params[keys.ftype] = metal ? 1 : 0;
        kit.params[keys.cutoff] = metal ? Math.min(kit.params[keys.cutoff]!, 90) : Math.max(kit.params[keys.cutoff]!, 105);
      }
      m = measureTrigger(e, kit, trig);
    }
    // level: VOLUME is a linear gain after the voice (two passes, the snare's drive follows it)
    if (!o.locked?.[v]) {
      for (let pass = 0; pass < 2 && m.peak > 0.001; pass++) {
        const want = target;
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
