/**
 * The link between the project and the sound engine, used identically for the live worklet
 * and for offline renders: tracks to engine tracks, the kit to engine parameters, scheduled
 * events to hits. One sequencer event becomes one hit; the engine decides which layers sound.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import type { ChainConfig } from '@slopfactory/core/engines';
import { repairChain } from '@slopfactory/core/engines';
import { ENGINE_RATE, type EngineSample, type EngineTrack, type HitEvent } from '../audio/engine';
import type { SampleLibrary } from '../audio/library';
import type { Project, SynthKit, Track, TrackSound } from '../model/types';
import { hasActiveRoutes, resolveMod } from '../mod/config';
import { isEmptyPatch } from '../mod/types';
import { legacyOutputFx, defaultOutputFx, type OutputFx } from '../audio/mixfx';
import type { TrackMod } from '../mod/types';
import { PPQ } from '../model/types';
import { resolveStepSound, soundSampleIds } from '../sound/stepSound';
import { PAR } from '../sound/lxrParamIds';
import { engineTunes, noteHint, type EngineTune, type TuneEnv } from '../music/tuning';
import { HARDWARE_ONLY } from '../sound/lxrParams';
import type { ScheduledEvent } from '../transport/scheduler';

/** What can be configured: the engine itself (offline) or the live worklet. */
export interface EngineTarget {
  setTrack(i: number, t: Partial<EngineTrack>): void;
  setParams(values: [number, number][], time?: number): void;
  setModTarget(kind: 0 | 1, voice: number, param: number): void;
  setBpm(bpm: number): void;
  setMaster(volume: number, clip: boolean, chain: ChainConfig): void;
  setSample(id: string, s: EngineSample): void;
  setMacros(values: number[]): void;
  setOutput(out: OutputFx): void;
}

/**
 * The modulation a track's sounds play, resolved for the engine: index 0 is the base, 1-4 are
 * variations A-D (null when a variation has no modulation override, so it plays the base's).
 * Empty when nothing modulates, which keeps the engine free of work.
 */
export function modsOf(s: TrackSound): TrackMod[] | (TrackMod | null)[] {
  const patched = (s.variations ?? []).some((v) => v?.mod && !isEmptyPatch(v.mod));
  const base = s.mod;
  if (!patched && !(base && (base.routes.length || Object.keys(base.sources).length))) return [];
  const list: (TrackMod | null)[] = [resolveMod(base, undefined)];
  for (let i = 0; i < 4; i++) {
    const v = s.variations?.[i];
    list.push(v?.mod && !isEmptyPatch(v.mod) ? resolveMod(base, v.mod) : null);
  }
  return list.some((m) => m && hasActiveRoutes(m)) ? list : [];
}

export const outputOf = (p: Project): OutputFx => p.master.out ?? legacyOutputFx();
export { defaultOutputFx };

export function engineTrackOf(t: Track, anySolo: boolean, tunes?: (EngineTune | null)[]): EngineTrack {
  const s = t.sound;
  return {
    mode: s.mode,
    trigger: s.trigger,
    note: s.note,
    synthLevel: s.synthLevel,
    sampleLevel: s.sampleLevel,
    samples: s.samples.slice(),
    pick: s.pick,
    start: s.start,
    end: s.end,
    tune: s.tune,
    fine: s.fine,
    gain: s.gain,
    pan: s.pan,
    reverse: s.reverse,
    offsetMs: s.offsetMs,
    choke: s.choke,
    volume: t.mix.volume,
    mixPan: t.mix.pan,
    audible: !t.mix.mute && (!anySolo || t.mix.solo),
    route: t.mix.route,
    filter: t.mix.filter,
    send: t.mix.send ?? 0,
    fx: t.mix.fx,
    mods: modsOf(s),
    // always present, so that taking a scale away clears the tuning the engine holds
    tunes,
  };
}

/** What the scale tuning may know about samples: the pitch their file names claim (a hint; measurements win). */
export const tuneEnvOf = (lib: SampleLibrary | null): TuneEnv => ({ hint: (id) => noteHint(lib?.get(id)?.name ?? '') });

/** A track as the engine plays it in a project: its sound, mix and scale tuning. */
export const engineTrackIn = (p: Project, t: Track, solo: boolean, lib: SampleLibrary | null): EngineTrack => engineTrackOf(t, solo, engineTunes(p, t, tuneEnvOf(lib)));

export const anySolo = (p: Project): boolean => p.tracks.some((t) => t.mix.solo);

export function kitParams(kit: SynthKit): [number, number][] {
  const out: [number, number][] = [];
  for (let p = 1; p < kit.params.length; p++) if (!HARDWARE_ONLY.has(p)) out.push([p, kit.params[p] ?? 0]);
  return out;
}

/** Parameters that differ between two kits. */
export function kitDiff(a: SynthKit, b: SynthKit): [number, number][] {
  const out: [number, number][] = [];
  for (let p = 1; p < b.params.length; p++) if (!HARDWARE_ONLY.has(p) && a.params[p] !== b.params[p]) out.push([p, b.params[p] ?? 0]);
  return out;
}

export function sendKit(target: EngineTarget, kit: SynthKit): void {
  target.setParams(kitParams(kit));
  for (let v = 0; v < 6; v++) {
    target.setModTarget(0, v, kit.lfoTarget[v] ?? 0);
    target.setModTarget(1, v, kit.velTarget[v] ?? 0);
  }
}

export function masterChain(p: Project): ChainConfig {
  return repairChain(p.master.chain ?? null);
}

/** Configure an engine completely from a project. */
export function configureEngine(target: EngineTarget, p: Project, lib: SampleLibrary | null): void {
  const solo = anySolo(p);
  if (lib) {
    const used = new Set<string>();
    for (const t of p.tracks) for (const id of soundSampleIds(t.sound)) used.add(id);
    for (const pat of p.patterns) for (const e of Object.values(pat.edits)) for (const h of Object.values(e)) if (h?.sample) used.add(h.sample);
    for (const id of used) {
      const s = lib.get(id);
      if (s) target.setSample(id, { rate: s.rate, channels: s.channels });
    }
  }
  p.tracks.forEach((t, i) => target.setTrack(i, engineTrackIn(p, t, solo, lib)));
  sendKit(target, p.kit.synth);
  target.setBpm(p.tempo);
  target.setMaster(p.master.volume, p.master.clip, masterChain(p));
  target.setMacros(p.macros ?? [0, 0, 0, 0]);
  target.setOutput(outputOf(p));
}

/** A hit for the engine from a scheduled event (time in seconds; `spt` seconds per tick). */
export function hitOf(se: ScheduledEvent, p: Project, index: Map<string, number>, spt: number, fills?: ReadonlySet<string>): Omit<HitEvent, 'frame' | 'seq'> & { time: number } | null {
  const e = se.event;
  const ti = index.get(e.track);
  if (ti === undefined) return null;
  const t = p.tracks[ti]!;
  // the step's sound, resolved for this pass on the musical clock (see src/sound/stepSound.ts)
  const rs = e.snd ? resolveStepSound(t.sound, e.snd, (par) => p.kit.synth.params[par] ?? 0, { seed: p.seed, cycle: se.cycle, fill: e.kind === 'fill' || !!fills?.has(e.track), track: e.track, step: e.origin }) : null;
  const trig = rs ? rs.trig : t.sound.trigger;
  const locks: number[] = [];
  if (e.crush !== undefined && t.sound.mode !== 'sample') {
    const v = trig >= 5 ? 5 : trig;
    locks.push(PAR.VOICE_DECIMATION1 + v, e.crush);
  }
  return {
    ...(rs?.switched ? { trig: rs.trig } : {}),
    ...(rs?.params.length ? { sp: rs.params } : {}),
    ...(rs?.sample ? { smp: rs.sample } : {}),
    mv: rs?.variation != null ? rs.variation + 1 : 0,
    tb: (se.tick % (4 * PPQ)) * spt,
    tp: e.tick * spt,
    time: se.time,
    track: ti,
    vel: e.vel,
    pitch: e.pitch,
    gate: e.gate ? Math.max(1, Math.round(e.gate * spt * ENGINE_RATE)) : undefined,
    reverse: e.reverse,
    locks: locks.length ? locks : undefined,
    sample: e.sample,
  };
}

export function trackIndex(p: Project): Map<string, number> {
  return new Map(p.tracks.map((t, i) => [t.id, i] as const));
}
