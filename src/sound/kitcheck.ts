/**
 * Kit analysis through the real engine: every generated or mutated voice is rendered by the
 * LXR engine itself and measured, so CLATTER never hands the user a silent or clipping kit.
 *
 *   - level: each voice's VOLUME is set so its peak sits at a target for its archetype
 *     (kicks loudest, cymbals quietest);
 *   - silence: a voice that is still inaudible (or vanishes in under 15 ms) is designed again
 *     with another seed, and after a few tries falls back to the firmware's init kit voice.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import type { SynthKit } from '../model/types';
import type { LxrEngine } from '../audio/lxr/lxr';
import { hash32, Rng } from '../rhythm/rng';
import type { KitFlavour } from '../rhythm/styles';
import { archetypeFor, designVoice, voiceKeys, type Archetype } from './kitgen';
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
}

export interface CheckReport {
  levels: number[];
  redesigned: number[];
  fallback: number[];
}

/** Level-match every voice and replace inaudible ones. Returns a new kit. */
export function checkKit(e: LxrEngine, kit0: SynthKit, o: CheckOptions): { kit: SynthKit; report: CheckReport } {
  const kit: SynthKit = { params: kit0.params.slice(), lfoTarget: kit0.lfoTarget.slice(), velTarget: kit0.velTarget.slice() };
  const report: CheckReport = { levels: [], redesigned: [], fallback: [] };
  for (const v of o.voices ?? [0, 1, 2, 3, 4, 5]) {
    const keys = voiceKeys(v);
    const volP = keys.vol!;
    const a = archetypeFor(v, o.voiceRoles[v] ?? []);
    const trig = TRIGGER_OF_VOICE[v]!;
    let m = measureTrigger(e, kit, trig);
    let tries = 0;
    while ((m.peak < 0.03 || m.length < 15) && tries < 5 && !o.locked?.[v]) {
      const d = designVoice(v, a, o.flavour, new Rng(hash32(o.seed, 777, v, tries)));
      for (const [k, val] of Object.entries(d.values)) {
        const p = keys[k as keyof typeof keys];
        if (p !== undefined) kit.params[p] = val as number;
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
