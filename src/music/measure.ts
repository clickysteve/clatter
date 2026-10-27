/**
 * Measuring a track's sounds and tuning them to its scale: the part of scale quantisation that
 * uses audio. For every sound a track can play (the base and variations A-D, and for HYBRID both
 * layers) the untuned sound is rendered alone and offline, its audible fundamental is found
 * (src/analysis) and stored on the track. The tuned sound is then rendered and measured again;
 * where it misses its note by more than a few cents, the correction found is stored too.
 *
 * A sound with no reliable fundamental is recorded as such and is not moved: tuning noise or a
 * bell to a note would only be a guess.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import { midiToHz, noteName } from '../analysis/pitch';
import type { PitchRecord, PitchTarget } from '../analysis/trackPitch';
import type { Project, Track } from '../model/types';
import { describeScale, trackScaleSpec, type ScaleSpec } from './scale';
import { layersOf, makeMeasure, naturalPitch, setMeasure, tuneSlot, type Layer, type Refusal, type Slot, type TuneEnv } from './tuning';

/** Within this many cents of the note counts as in tune. */
export const TOLERANCE_CENTS = 12;

export interface MeasureDeps {
  /** the pitch analysis of a sound (the app passes one that uses and fills its cache) */
  analyse: (project: Project, target: PitchTarget) => Promise<PitchRecord>;
  env?: TuneEnv;
  signal?: AbortSignal;
  progress?: (done: number, total: number, what: string) => void;
}

export interface LayerResult {
  slot: Slot;
  layer: Layer;
  /** tuned: moved onto a scale note. in-tune: already on it. left: not moved (see reason) */
  state: 'tuned' | 'in-tune' | 'left';
  reason?: string;
  source?: 'measured' | 'estimated' | 'hint' | 'follows';
  naturalHz?: number;
  naturalNote?: string;
  target?: number;
  targetNote?: string;
  /** semitones added to the sound */
  shift?: number;
  /** the tuned sound as measured: its fundamental and its distance from the target in cents */
  afterHz?: number;
  errorCents?: number;
  verified?: boolean;
}

export interface TrackResult {
  trackId: string;
  name: string;
  scale: string | null;
  layers: LayerResult[];
}

export const REFUSAL_TEXT: Record<Refusal, string> = {
  inharmonic: 'INHARMONIC: NO SINGLE PITCH TO TUNE',
  unpitched: 'UNPITCHED: NOT TUNED',
  silent: 'SILENT: NOT TUNED',
  unreliable: 'PITCH NOT RELIABLE ENOUGH TO TUNE',
  unmeasured: 'NOT MEASURED YET',
};

/** The slots a track can play: the base sound and each filled variation. */
export const slotsOf = (t: Track): Slot[] => [null, ...[0, 1, 2, 3].filter((i) => !!t.sound.variations?.[i])];

export const slotName = (slot: Slot): string => (slot === null ? 'BASE' : 'ABCD'[slot]!);

const targetOf = (t: Track, slot: Slot, layer: Layer, raw: boolean): PitchTarget => ({ trackId: t.id, slot, layer: t.sound.mode === 'hybrid' ? layer : 'mix', ...(raw ? { raw: true } : {}) });

/** What the scale does to each sound of a track, from what is stored (no audio). */
export function planTrack(p: Project, t: Track, env: TuneEnv = {}): LayerResult[] {
  const out: LayerResult[] = [];
  for (const slot of slotsOf(t)) {
    const s = tuneSlot(p, t, slot, env);
    for (const layer of layersOf(t)) {
      const lt = s?.[layer];
      if (lt && lt.source !== 'follows') {
        const hz = midiToHz(lt.natural);
        out.push({
          slot,
          layer,
          state: Math.abs(lt.shift) < 0.005 ? 'in-tune' : 'tuned',
          source: lt.source,
          naturalHz: hz,
          naturalNote: noteName(Math.round(lt.natural)),
          target: lt.target,
          targetNote: noteName(lt.target),
          shift: lt.shift,
        });
      } else if (lt) {
        out.push({ slot, layer, state: 'tuned', source: 'follows', shift: lt.shift, reason: 'FOLLOWS THE OTHER LAYER' });
      } else {
        const n = naturalPitch(p, t, slot, layer, env);
        out.push({ slot, layer, state: 'left', reason: 'refuse' in n ? REFUSAL_TEXT[n.refuse] : 'NO SCALE IN FORCE' });
      }
    }
  }
  return out;
}

const cancelled = (d: MeasureDeps) => {
  if (d.signal?.aborted) throw new Error('CANCELLED');
};

/**
 * Measure the given tracks (default: all with a scale in force, or any when `force`) and tune them.
 * Writes the measurements into `project` (the tracks' `pitch`); the caller refreshes the engine.
 */
export async function measureAndTune(project: Project, trackIds: string[], deps: MeasureDeps): Promise<TrackResult[]> {
  const results: TrackResult[] = [];
  const tracks = trackIds.map((id) => project.tracks.find((t) => t.id === id)).filter((t): t is Track => !!t);
  const total = tracks.reduce((n, t) => n + slotsOf(t).length * layersOf(t).length, 0);
  let done = 0;
  for (const t of tracks) {
    // ---- 1. the natural pitch of every sound
    for (const slot of slotsOf(t)) {
      for (const layer of layersOf(t)) {
        cancelled(deps);
        deps.progress?.(done++, total, `${t.name} ${slotName(slot)}`);
        const pending = deps.analyse(project, targetOf(t, slot, layer, true));
        // the analysis snapshots the project when it is called: tag the measurement with the sound as it is now
        const tag = makeMeasure(project, t, slot, layer, { kind: 'silent', conf: 0 });
        const rec = await pending;
        const a = rec.analysis;
        const reliable = (a.kind === 'stable' || a.kind === 'swept') && !!a.fundamental;
        setMeasure(t, slot, layer, { ...tag, kind: a.kind, conf: a.confidence, ...(reliable ? { hz: a.fundamental!.hz } : {}), at: rec.at });
      }
    }
    // ---- 2. what the tuned sound does, and the correction where it misses
    const spec: ScaleSpec | null = trackScaleSpec(project, t);
    const layers: LayerResult[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      layers.length = 0;
      const again: { slot: Slot; layer: Layer; err: number; target: number }[] = [];
      for (const r of planTrack(project, t, deps.env)) {
        cancelled(deps);
        if (r.state === 'left' || r.source === 'follows' || r.target === undefined) {
          layers.push(r);
          continue;
        }
        const rec = await deps.analyse(project, targetOf(t, r.slot, r.layer, false));
        const a = rec.analysis;
        if ((a.kind === 'stable' || a.kind === 'swept') && a.fundamental) {
          const err = 1200 * Math.log2(a.fundamental.hz / midiToHz(r.target));
          layers.push({ ...r, afterHz: a.fundamental.hz, errorCents: err, verified: true });
          if (Math.abs(err) > TOLERANCE_CENTS && attempt === 0) again.push({ slot: r.slot, layer: r.layer, err, target: r.target });
        } else layers.push({ ...r, verified: false, reason: 'THE TUNED SOUND HAS NO MEASURABLE PITCH' });
      }
      if (!again.length) break;
      for (const x of again) {
        const m = (x.slot === null ? t.pitch?.base?.[x.layer] : t.pitch?.vars?.[x.slot]?.[x.layer]) ?? null;
        if (m) m.adj = { target: x.target, cents: (m.adj?.target === x.target ? m.adj.cents : 0) - x.err };
      }
    }
    results.push({ trackId: t.id, name: t.name, scale: spec ? describeScale(spec) : null, layers });
  }
  deps.progress?.(total, total, '');
  return results;
}
