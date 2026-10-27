/**
 * Scale tuning: how a track's sound is moved onto the notes of its scale.
 *
 * Two different things are kept apart, and the TUNER says which one it is showing:
 *
 *   MEASURED    the audible fundamental was found in rendered audio (src/analysis) and the sound is
 *               moved so that it lands on the nearest scale note. This is a correction of what
 *               you hear: the pitch envelope, FM, filters, mod and sample tuning are all in the
 *               measurement.
 *   ESTIMATED   no measurement exists, so the oscillator's own pitch (COARSE + the synth note)
 *               stands in for the fundamental. Only the LXR's tom-like drum voices (1-3) are
 *               treated that way, because for them the oscillator is the pitch you hear (the
 *               kit-wide calibration in test/scaletune.test.ts holds this to the audio). It is
 *               parameter quantisation, not a promise about the audio.
 *
 * What is stored in a project is only the measurement of the UNTUNED sound (Track.pitch) and the
 * scale (Project.scale, Track.scale). The move itself is computed from them whenever the engine
 * is configured, so changing the scale re-tunes at once without rendering anything, and a
 * measurement stays useful while the sound is edited in ways that move the pitch by a known
 * amount (COARSE, FINE, the synth NOTE, sample TUNE and FINE): the shift is added to it. An edit
 * that changes how the pitch is made (waveform, FM, pitch envelope, a different sample) makes it
 * obsolete and the sound falls back to the estimate, or to no tuning when there is none.
 *
 * Nothing here quantises a moving pitch. The move is one constant offset of the whole sound
 * (the synth note in whole semitones, the oscillator FINE for the cents the note cannot reach,
 * the sample playback rate), so a kick's downward sweep, FM ratios and modulation keep their
 * shape around the quantised pitch.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import { hzToMidiFloat } from '../analysis/pitch';
import { resolveMod } from '../mod/config';
import { voiceKeys, type Key, type VoicePitchPlan } from '../sound/kitgen';
import type { PitchMeasure, Project, SlotMeasure, Track } from '../model/types';
import { absMask, FINE_CENTS_PER_STEP, nearestInScale, normaliseScale, trackScaleSpec, type ScaleSpec } from './scale';

/** The measured pitch must have at least this confidence to move a sound. */
export const MIN_CONFIDENCE = 0.5;

export type Layer = 'synth' | 'sample';
export type Slot = number | null;

/** Which layers a track's pitch lives in. */
export const layersOf = (t: Track): Layer[] => (t.sound.mode === 'synth' ? ['synth'] : t.sound.mode === 'sample' ? ['sample'] : ['synth', 'sample']);

const voiceOf = (t: Track): number => (t.sound.trigger >= 5 ? 5 : t.sound.trigger);

// ---------------------------------------------------------------------------- what makes the pitch

/** Parameters that decide how a voice's pitch is made (not what it is: COARSE and FINE shift it by an exact amount). */
const SHAPE_KEYS: Key[] = ['wave', 'pwm', 'fmAmt', 'fmFreq', 'fmWave', 'fmMode', 'm1wave', 'm1freq', 'm1amt', 'm2wave', 'm2freq', 'm2amt', 'pDecay', 'pSlope', 'pAmt', 'noiseFreq', 'noiseMix'];

/** Modulation destinations that move or reshape pitch. */
export const PITCH_DEST = /^(lxr\.(osc|fm|pitch|mod[12])\.|smp\.(pitch|start))/;

function variationOf(t: Track, slot: Slot) {
  return slot === null ? null : (t.sound.variations?.[slot] ?? null);
}

/** The value of an LXR parameter as a slot plays it: the variation's override, else the kit's. */
function paramValue(p: Project, t: Track, slot: Slot, par: number): number {
  const v = variationOf(t, slot);
  return v?.params[par] ?? p.kit.synth.params[par] ?? 0;
}

/**
 * The pitch OFFSET of a sound in semitones, relative to nothing in particular: only differences
 * between two calls mean anything. Synth: COARSE + synth NOTE + FINE. Sample: TUNE + FINE.
 */
export function pitchOffset(p: Project, t: Track, slot: Slot, layer: Layer): number {
  if (layer === 'synth') {
    const k = voiceKeys(voiceOf(t));
    const coarse = k.coarse === undefined ? 0 : paramValue(p, t, slot, k.coarse);
    const fine = k.fine === undefined ? 64 : paramValue(p, t, slot, k.fine);
    return coarse + (t.sound.note - 60) + ((fine - 64) * FINE_CENTS_PER_STEP) / 100;
  }
  const o = variationOf(t, slot)?.sample;
  return (o?.tune ?? t.sound.tune) + (o?.fine ?? t.sound.fine) / 100;
}

/**
 * A short hash of everything that decides how the pitch of this slot and layer is made. Two
 * sounds with the same shape differ in pitch only by their `pitchOffset`.
 */
export function pitchShape(p: Project, t: Track, slot: Slot, layer: Layer): string {
  const parts: unknown[] = [layer, t.sound.mode];
  if (layer === 'synth') {
    const v = voiceOf(t);
    const k = voiceKeys(v);
    parts.push(v, p.kit.synth.lfoTarget[v] ?? 0, p.kit.synth.velTarget[v] ?? 0);
    for (const key of SHAPE_KEYS) {
      const par = k[key];
      if (par !== undefined) parts.push(paramValue(p, t, slot, par));
    }
  } else {
    const o = variationOf(t, slot)?.sample;
    parts.push(o?.samples ?? t.sound.samples, o?.start ?? t.sound.start, o?.end ?? t.sound.end, o?.reverse ?? t.sound.reverse);
  }
  const mod = resolveMod(t.sound.mod, variationOf(t, slot)?.mod);
  const pitchRoutes = mod.routes.filter((r) => r.on && PITCH_DEST.test(r.dst));
  if (pitchRoutes.length) parts.push(pitchRoutes, mod.sources);
  return fnv(JSON.stringify(parts));
}

function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

// ---------------------------------------------------------------------------- measurements

const usable = (m: PitchMeasure): boolean => (m.kind === 'stable' || m.kind === 'swept') && m.hz !== undefined && m.conf >= MIN_CONFIDENCE;

/** The stored measures of a track for a layer, base first. */
function measures(t: Track, layer: Layer): { slot: Slot; m: PitchMeasure }[] {
  const out: { slot: Slot; m: PitchMeasure }[] = [];
  const base = t.pitch?.base?.[layer];
  if (base) out.push({ slot: null, m: base });
  t.pitch?.vars?.forEach((s, i) => {
    const m = s?.[layer];
    if (m) out.push({ slot: i, m });
  });
  return out;
}

/** A measurement of the UNTUNED sound of a slot and layer, tagged with what the sound is now. Take it before the render, so it describes the sound that was rendered. */
export function makeMeasure(p: Project, t: Track, slot: Slot, layer: Layer, m: { kind: PitchMeasure['kind']; hz?: number; conf: number; at?: number }): PitchMeasure {
  return { kind: m.kind, ...(m.hz !== undefined ? { hz: m.hz } : {}), conf: m.conf, shape: pitchShape(p, t, slot, layer), off: pitchOffset(p, t, slot, layer), at: m.at ?? Date.now() };
}

/** Put a measurement on the track (replacing the old one for that slot and layer). */
export function setMeasure(t: Track, slot: Slot, layer: Layer, m: PitchMeasure): void {
  const pitch = (t.pitch ??= {});
  if (slot === null) pitch.base = { ...(pitch.base ?? {}), [layer]: m } as SlotMeasure;
  else {
    const vars = (pitch.vars ??= [null, null, null, null]);
    vars[slot] = { ...(vars[slot] ?? {}), [layer]: m } as SlotMeasure;
  }
}

export function clearMeasures(t: Track): void {
  delete t.pitch;
}

export type Refusal = 'inharmonic' | 'unpitched' | 'silent' | 'unreliable' | 'unmeasured';

export interface Natural {
  /** the sound's untuned fundamental as a (fractional) MIDI number */
  midi: number;
  source: 'measured' | 'estimated' | 'hint';
  /** the measure behind it (measured) */
  measure?: PitchMeasure;
  /** a measure of another slot, moved by the known pitch difference */
  shifted?: boolean;
}

/** Look for a MIDI note in a sample's file name: "kick_C2.wav", "Tom-F#3", "bd A1". */
export function noteHint(name: string): number | null {
  const stem = name.replace(/\.[a-z0-9]{1,5}$/i, '');
  const m = /(?:^|[\s_\-.])([A-Ga-g])([#b]?)(-?\d)(?=$|[\s_\-.])/.exec(stem);
  if (!m) return null;
  const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1]!.toUpperCase() as 'C']!;
  const shift = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0;
  const n = (Number(m[3]) + 1) * 12 + base + shift;
  return n >= 0 && n <= 127 ? n : null;
}

export interface TuneEnv {
  /** the pitch a sample's metadata (its file name) claims, MIDI; the measurement always wins */
  hint?: (sampleId: string) => number | null;
}

/** The untuned fundamental of one slot and layer, or why there is none. */
export function naturalPitch(p: Project, t: Track, slot: Slot, layer: Layer, env: TuneEnv = {}): Natural | { refuse: Refusal } {
  const shape = pitchShape(p, t, slot, layer);
  const off = pitchOffset(p, t, slot, layer);
  const list = measures(t, layer);
  // the slot's own measure first, then the base's, then any other that has the same shape
  const ordered = [...list.filter((x) => x.slot === slot), ...list.filter((x) => x.slot === null && x.slot !== slot), ...list.filter((x) => x.slot !== null && x.slot !== slot)];
  let refusal: Refusal | null = null;
  for (const { slot: s, m } of ordered) {
    if (m.shape !== shape) continue;
    if (!usable(m)) {
      refusal ??= m.kind === 'inharmonic' ? 'inharmonic' : m.kind === 'unpitched' ? 'unpitched' : m.kind === 'silent' ? 'silent' : 'unreliable';
      continue;
    }
    return { midi: hzToMidiFloat(m.hz!) + (off - m.off), source: 'measured', measure: m, shifted: s !== slot };
  }
  if (refusal) return { refuse: refusal };
  if (layer === 'synth') {
    // the oscillator is the pitch you hear in the tom-like drum voices only
    if (voiceOf(t) <= 2) return { midi: off + 0, source: 'estimated' };
    return { refuse: 'unmeasured' };
  }
  const ids = (variationOf(t, slot)?.sample?.samples ?? t.sound.samples) as string[];
  const hint = ids.length === 1 ? (env.hint?.(ids[0]!) ?? null) : null;
  if (hint !== null) return { midi: hint + off, source: 'hint' };
  return { refuse: 'unmeasured' };
}

// ---------------------------------------------------------------------------- the tuning of a slot

export interface LayerTune {
  /** the scale note the layer is moved to */
  target: number;
  /** where it was */
  natural: number;
  /** semitones added to it */
  shift: number;
  source: Natural['source'] | 'follows';
  /** the measured correction was applied */
  corrected?: boolean;
}

export interface SlotTune {
  spec: ScaleSpec;
  synth?: LayerTune;
  sample?: LayerTune;
  /** what the layers that were left alone are (and why) */
  left: Partial<Record<Layer, Refusal>>;
  /** the note offsets are counted from: the synth layer's target, else the sample's */
  anchor: number;
}

/** A unison or octave pair: the layers sound as one pitch and must stay one pitch. */
const sameNote = (a: number, b: number): boolean => {
  const d = a - b - 12 * Math.round((a - b) / 12);
  return Math.abs(d) <= 0.75;
};

/**
 * The move that puts a slot's sound on its scale, or null when the track has no scale in force
 * or no layer of the slot has a pitch that can be trusted (nothing is moved on a guess).
 */
export function tuneSlot(p: Project, t: Track, slot: Slot, env: TuneEnv = {}): SlotTune | null {
  const spec = trackScaleSpec(p, t);
  if (!spec) return null;
  const nat: Partial<Record<Layer, Natural>> = {};
  const left: Partial<Record<Layer, Refusal>> = {};
  for (const l of layersOf(t)) {
    const n = naturalPitch(p, t, slot, l, env);
    if ('refuse' in n) left[l] = n.refuse;
    else nat[l] = n;
  }
  const S = nat.synth;
  const M = nat.sample;
  if (!S && !M) return null;
  const out: SlotTune = { spec, left, anchor: 0 };
  const adj = (layer: Layer, n: Natural, target: number): { shift: number; corrected: boolean } => {
    const a = n.measure?.adj;
    const corrected = !!a && a.target === target && !n.shifted;
    return { shift: target - n.midi + (corrected ? a!.cents / 100 : 0), corrected };
  };
  const make = (layer: Layer, n: Natural, target: number): LayerTune => {
    const a = adj(layer, n, target);
    return { target, natural: n.midi, shift: a.shift, source: n.source, ...(a.corrected ? { corrected: true } : {}) };
  };
  if (S) out.synth = make('synth', S, nearestInScale(spec, S.midi));
  if (M) {
    if (S && sameNote(S.midi, M.midi)) {
      // layers that sound as one pitch end on one pitch (the nearest octave of the synth's note)
      const ts = out.synth!.target;
      out.sample = make('sample', M, ts + 12 * Math.round((M.midi - ts) / 12));
    } else out.sample = make('sample', M, nearestInScale(spec, M.midi));
  }
  // a layer with no pitch of its own that can be trusted follows the other one only when it has not been found unpitched
  if (S && !M && left.sample === 'unmeasured') out.sample = { target: 0, natural: 0, shift: out.synth!.shift, source: 'follows' };
  if (M && !S && left.synth === 'unmeasured') out.synth = { target: 0, natural: 0, shift: out.sample!.shift, source: 'follows' };
  out.anchor = out.synth && out.synth.source !== 'follows' ? out.synth.target : out.sample!.target;
  return out;
}

// ---------------------------------------------------------------------------- what the engine gets

/**
 * One slot's tuning in the engine's terms. `note` is a whole number of semitones on the synth
 * note, `cents` the rest, on the oscillator FINE; `smp` is the sample layer's playback shift in
 * semitones. `q` snaps a hit's pitch offset (the sequencer's PITCH, DESTROY) to the scale around
 * the track's tuned note: `mask` is the scale as absolute pitch classes, `anchor` the note offsets count from.
 */
export interface EngineTune {
  note: number;
  cents: number;
  smp: number;
  q?: { mask: number; anchor: number };
}

export function engineTuneOf(s: SlotTune): EngineTune {
  const w = s.synth ? Math.round(s.synth.shift) : 0;
  return {
    note: w,
    cents: s.synth ? (s.synth.shift - w) * 100 : 0,
    smp: s.sample ? s.sample.shift : 0,
    q: { mask: absMask(s.spec), anchor: s.anchor },
  };
}

/**
 * The tuning of a track for the engine: index 0 is the base sound, 1-4 are variations A-D. A slot
 * that cannot be tuned is null (it plays untouched). Undefined when the track has no scale in
 * force or nothing in it can be tuned, which keeps the engine free of work.
 */
export function engineTunes(p: Project, t: Track, env: TuneEnv = {}): (EngineTune | null)[] | undefined {
  if (!trackScaleSpec(p, t)) return undefined;
  const list: (EngineTune | null)[] = [];
  const base = tuneSlot(p, t, null, env);
  list.push(base ? engineTuneOf(base) : null);
  for (let i = 0; i < 4; i++) {
    if (!t.sound.variations?.[i]) {
      list.push(list[0] ?? null);
      continue;
    }
    const s = tuneSlot(p, t, i, env);
    list.push(s ? engineTuneOf(s) : null);
  }
  return list.some(Boolean) ? list : undefined;
}

/** A project as if no scale were in force: for measuring the natural pitch of a sound and for exporting it untuned. */
export function untuned(p: Project): Project {
  const q = JSON.parse(JSON.stringify(p)) as Project;
  if (q.scale) q.scale = { ...q.scale, on: false };
  for (const t of q.tracks) {
    const spec = t.scale ?? { mode: 'off' as const, root: 0, type: 'minor' };
    t.scale = { ...spec, mode: 'off' };
  }
  return q;
}

export { FINE_CENTS_PER_STEP, normaliseScale };

// ---------------------------------------------------------------------------- generation

/**
 * Where a track's oscillator pitch must land when the sound generators write for it: null when
 * it has no scale in force, plays no synth voice, or plays a voice whose oscillator is not the
 * pitch you hear (the generators leave those alone; the measured tuning handles the rest).
 */
export function pitchPlanOf(p: Project, t: Track): VoicePitchPlan | null {
  const spec = trackScaleSpec(p, t);
  if (!spec || t.sound.mode === 'sample' || voiceOf(t) > 2) return null;
  return { spec, note: t.sound.note };
}

/** The plan for each LXR voice, taken from the first track that plays the voice and is scale-locked (a voice has one kit sound). */
export function kitPitchPlans(p: Project): (voice: number) => VoicePitchPlan | null {
  const plans: (VoicePitchPlan | null)[] = [0, 1, 2, 3, 4, 5].map((v) => {
    for (const t of p.tracks) if (t.sound.mode !== 'sample' && voiceOf(t) === v) {
      const plan = pitchPlanOf(p, t);
      if (plan) return plan;
    }
    return null;
  });
  return (voice) => plans[voice] ?? null;
}

/** `kitPitchPlans` as plain data, one entry per voice (for the kit worker). */
export const pitchPlanList = (p: Project): (VoicePitchPlan | null)[] => {
  const f = kitPitchPlans(p);
  return [0, 1, 2, 3, 4, 5].map((v) => f(v));
};

/** Does any sound of the track lack a measurement that still describes it? (Estimates and hints do not count.) */
export function needsMeasure(p: Project, t: Track): boolean {
  const slots: Slot[] = [null, ...[0, 1, 2, 3].filter((i) => !!t.sound.variations?.[i])];
  for (const slot of slots)
    for (const layer of layersOf(t)) {
      const shape = pitchShape(p, t, slot, layer);
      if (!measures(t, layer).some((x) => x.m.shape === shape)) return true;
    }
  return false;
}
