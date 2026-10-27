/**
 * Pitch analysis of one sound of the project: render it alone and offline, analyse the audio,
 * and remember the result beside the project (never inside it) until a parameter that can change
 * the sound changes.
 *
 * The render is the same single-hit render DRUM HITS uses, on a clone of the project with the
 * track soloed in a private engine: the live kit, the transport, the sample library and the
 * project are not touched, and analysing a sound cannot modify it.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import { ENGINE_RATE } from '../audio/engine';
import type { SampleLibrary } from '../audio/library';
import { renderHit } from '../audio/render';
import { clone, type Project } from '../model/types';
import { analysePitch, PITCH_ANALYSIS_VERSION, PITCH_METHOD, type PitchAnalysis } from './pitch';

export type PitchLayer = 'mix' | 'synth' | 'sample';

/** What is analysed: a track's base sound (slot null) or one of its variations (0-3), and for HYBRID which layer. */
export interface PitchTarget {
  trackId: string;
  slot: number | null;
  layer: PitchLayer;
}

/** A stored result: the analysis plus what it was made from. */
export interface PitchRecord {
  target: PitchTarget;
  /** hash of everything that can change the rendered sound (see `soundFingerprint`) */
  fingerprint: string;
  analysis: PitchAnalysis;
  /** milliseconds since 1970 */
  at: number;
}

export const targetKey = (t: PitchTarget): string => `${t.trackId}|${t.slot ?? 'base'}|${t.layer}`;

/** The layer only means something on a HYBRID track; a variation that is empty is the base sound. */
export function normalizeTarget(p: Project, t: PitchTarget): PitchTarget {
  const tr = p.tracks.find((x) => x.id === t.trackId);
  const layer = tr?.sound.mode === 'hybrid' ? t.layer : 'mix';
  const slot = t.slot != null && tr?.sound.variations?.[t.slot] ? t.slot : null;
  return { trackId: t.trackId, slot, layer };
}

function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * A short hash of everything that can change how the target sounds: the track's sound (its
 * source, samples, tuning, modulation and the variation being analysed, but not the other
 * variations), the synth kit (all voices share the engine state, so any kit parameter counts),
 * the macros and the project seed. The pattern, the tempo, the mixer and other tracks'
 * sounds are not in it: they cannot change the single dry hit that is analysed.
 */
export function soundFingerprint(p: Project, target: PitchTarget): string {
  const t = normalizeTarget(p, target);
  const tr = p.tracks.find((x) => x.id === t.trackId);
  if (!tr) return 'missing';
  const { variations, choke: _choke, soundLock: _lock, ...sound } = tr.sound;
  void _choke;
  void _lock;
  const k = p.kit.synth;
  return fnv(
    JSON.stringify({
      v: PITCH_ANALYSIS_VERSION,
      sound,
      variation: t.slot == null ? null : (variations?.[t.slot] ?? null),
      layer: t.layer,
      params: k.params,
      lfo: k.lfoTarget,
      vel: k.velTarget,
      macros: p.macros ?? null,
      seed: p.seed,
    }),
  );
}

/** Render the target alone and analyse it. */
export async function analyseTarget(module: WebAssembly.Module, live: Project, lib: SampleLibrary | null, target: PitchTarget): Promise<PitchRecord> {
  // work on a snapshot: the fingerprint must describe the sound that was rendered, even if the user keeps editing meanwhile
  const project = clone(live);
  const t = normalizeTarget(project, target);
  if (!project.tracks.some((x) => x.id === t.trackId)) throw new Error('that track no longer exists');
  const audio = await renderHit(module, project, lib, t.trackId, 127, 3, { slot: t.slot, layer: t.layer, dry: true });
  const analysis = analysePitch(audio, ENGINE_RATE);
  return { target: t, fingerprint: soundFingerprint(project, t), analysis, at: Date.now() };
}

/** Results by target, kept in memory beside the project. A result whose fingerprint no longer matches is stale. */
export class PitchCache {
  private map = new Map<string, PitchRecord>();

  /** The stored result for a target, and whether the sound has changed since it was made. */
  lookup(p: Project, target: PitchTarget): { record: PitchRecord; stale: boolean } | null {
    const t = normalizeTarget(p, target);
    const record = this.map.get(targetKey(t));
    if (!record) return null;
    return { record, stale: record.fingerprint !== soundFingerprint(p, t) };
  }

  /** A fresh result, or null when there is none or the sound changed. */
  fresh(p: Project, target: PitchTarget): PitchRecord | null {
    const l = this.lookup(p, target);
    return l && !l.stale ? l.record : null;
  }

  set(record: PitchRecord): void {
    this.map.set(targetKey(record.target), record);
  }

  /** Forget everything (a new project) or one track (it was deleted). */
  clear(trackId?: string): void {
    if (!trackId) return this.map.clear();
    for (const k of [...this.map.keys()]) if (k.startsWith(trackId + '|')) this.map.delete(k);
  }

  get size(): number {
    return this.map.size;
  }
}

export { PITCH_ANALYSIS_VERSION, PITCH_METHOD };
