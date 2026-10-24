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
import type { Project, SynthKit, Track } from '../model/types';
import { PAR } from '../sound/lxrParamIds';
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
}

export function engineTrackOf(t: Track, anySolo: boolean): EngineTrack {
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
  };
}

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
    for (const t of p.tracks) for (const id of t.sound.samples) used.add(id);
    for (const pat of p.patterns) for (const e of Object.values(pat.edits)) for (const h of Object.values(e)) if (h?.sample) used.add(h.sample);
    for (const id of used) {
      const s = lib.get(id);
      if (s) target.setSample(id, { rate: s.rate, channels: s.channels });
    }
  }
  p.tracks.forEach((t, i) => target.setTrack(i, engineTrackOf(t, solo)));
  sendKit(target, p.kit.synth);
  target.setBpm(p.tempo);
  target.setMaster(p.master.volume, p.master.clip, masterChain(p));
}

/** A hit for the engine from a scheduled event (time in seconds; `spt` seconds per tick). */
export function hitOf(se: ScheduledEvent, p: Project, index: Map<string, number>, spt: number): Omit<HitEvent, 'frame' | 'seq'> & { time: number } | null {
  const e = se.event;
  const ti = index.get(e.track);
  if (ti === undefined) return null;
  const t = p.tracks[ti]!;
  const locks: number[] = [];
  if (e.crush !== undefined && t.sound.mode !== 'sample') {
    const v = t.sound.trigger >= 5 ? 5 : t.sound.trigger;
    locks.push(PAR.VOICE_DECIMATION1 + v, e.crush);
  }
  return {
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
