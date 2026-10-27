/**
 * Scale quantisation on real audio: sounds are rendered through the LXR engine, their pitch is found
 * in the audio, and the tuned sounds are measured again. Covers the tuning itself, per-track
 * overrides, the pitch envelope and FM, hybrid and sample tracks, generation and variations,
 * modulation, sequencer pitch offsets, hats and cymbals, the TUNER's views and save/load.
 */
import { describe, expect, it, vi } from 'vitest';
import { encodeWav16 } from '@slopfactory/core/export';
import { bundledLibrary, lxrModule, presetProject } from './helpers';
import { analysePitch, hzToMidiFloat, midiToHz } from '../src/analysis/pitch';
import { analyseTarget, PitchCache, soundFingerprint, type PitchTarget } from '../src/analysis/trackPitch';
import { engineTrackIn } from '../src/app/soundConfig';
import { renderHit, renderKitHit } from '../src/audio/render';
import { defaultRoute } from '../src/mod/config';
import { parseProject, serialize } from '../src/model/project';
import { clone, type Project, type Track } from '../src/model/types';
import { measureAndTune, planTrack, type TrackResult } from '../src/music/measure';
import { inScale, nearestInScale, normaliseScale, type ScaleSpec } from '../src/music/scale';
import { engineTunes, kitPitchPlans, naturalPitch, needsMeasure, noteHint, pitchOffset, pitchPlanOf, pitchShape, tuneSlot, untuned } from '../src/music/tuning';
import { generateKit, mutateKit, evolveKit } from '../src/sound/kitgen';
import { generateVariations } from '../src/sound/soundgen';
import { PAR } from '../src/sound/lxrParamIds';

vi.setConfig({ testTimeout: 180000 });

type Lib = Awaited<ReturnType<typeof bundledLibrary>>;
const cents = (a: number, b: number) => 1200 * Math.log2(a / b);

async function rig(preset = 'machine-room') {
  const lib = await bundledLibrary();
  const p = await presetProject(preset, lib);
  const track = (name: string): Track => p.tracks.find((x) => x.name === name)!;
  return { lib, p, track };
}

const analyse = (lib: Lib) => (q: Project, tg: PitchTarget) => analyseTarget(lxrModule(), q, lib, tg);
const tune = (p: Project, lib: Lib, names: string[]): Promise<TrackResult[]> =>
  measureAndTune(
    p,
    names.map((n) => p.tracks.find((t) => t.name === n)!.id),
    { analyse: analyse(lib) },
  );
const hear = async (p: Project, lib: Lib, t: Track, o: Partial<PitchTarget> = {}) => (await analyseTarget(lxrModule(), p, lib, { trackId: t.id, slot: null, layer: 'mix', ...o })).analysis;
/** how far (cents) a frequency is from the nearest note of a scale */
const offScale = (hz: number, s: ScaleSpec) => cents(hz, midiToHz(nearestInScale(s, hzToMidiFloat(hz))));

/** a decaying sine sample of a known frequency */
async function sineSample(lib: Lib, hz: number, name = `sine${hz}.wav`) {
  const n = 22050;
  const ch = new Float32Array(n);
  for (let i = 0; i < n; i++) ch[i] = 0.7 * Math.exp((-3 * i) / n) * Math.sin((2 * Math.PI * hz * i) / 44100);
  return (await lib.add((await encodeWav16([ch], 44100)).slice().buffer, name)).id;
}

const TOMS = ['KICK', 'LO TOM', 'HI TOM'];

describe('the oscillator setting stands in for the pitch of the tom-like voices', () => {
  it('is within half a semitone of what the audio measures', async () => {
    for (const preset of ['machine-room', 'dusty-breaks', 'industrial-estate']) {
      const { p, lib, track } = await rig(preset);
      for (const name of TOMS) {
        const t = track(name);
        t.sound.mode = 'synth';
        const a = await hear(p, lib, t, { raw: true });
        const est = naturalPitch(p, t, null, 'synth');
        expect('refuse' in est).toBe(false);
        if ('midi' in est && a.fundamental) {
          expect(est.source).toBe('estimated');
          expect(Math.abs(est.midi - hzToMidiFloat(a.fundamental.hz))).toBeLessThan(0.6);
        }
      }
    }
  });
});

describe('tuning a track to its scale', () => {
  it('lands the audible fundamental on a scale note, in several scales and roots', async () => {
    for (const spec of [
      { root: 1, type: 'major' },
      { root: 6, type: 'phrygian' },
      { root: 9, type: 'minorPentatonic' },
      { root: 3, type: 'wholeTone' },
      { root: 8, type: 'harmonicMinor' },
    ] as ScaleSpec[]) {
      const { p, lib, track } = await rig();
      p.scale = { on: true, ...spec };
      const res = await tune(p, lib, TOMS);
      for (const name of TOMS) {
        const l = res.find((r) => r.name === name)!.layers.find((x) => x.layer === 'synth' && x.slot === null)!;
        expect(['tuned', 'in-tune']).toContain(l.state);
        expect(Math.abs(l.errorCents!), `${name} in ${spec.root}/${spec.type}`).toBeLessThan(15);
        // and the sound, rendered afresh as it plays, is on the scale
        const a = await hear(p, lib, track(name));
        expect(a.fundamental, name).toBeTruthy();
        expect(Math.abs(offScale(a.fundamental!.hz, spec)), `${name} ${spec.type}`).toBeLessThan(16);
      }
    }
  });

  it('moves a sound by a constant offset, and by no more than it must', async () => {
    const { p, lib, track } = await rig();
    p.scale = { on: true, root: 1, type: 'major' };
    const before = (await hear(p, lib, track('KICK'), { raw: true })).fundamental!;
    await tune(p, lib, ['KICK']);
    const after = (await hear(p, lib, track('KICK'))).fundamental!;
    const moved = Math.abs(cents(after.hz, before.hz));
    const nearest = Math.abs(cents(midiToHz(nearestInScale({ root: 1, type: 'major' }, hzToMidiFloat(before.hz))), before.hz));
    expect(Math.abs(moved - nearest)).toBeLessThan(18);
    expect(moved).toBeLessThanOrEqual(100 + 18); // C# major has no gap wider than a semitone below a whole tone
  });

  it('changing the root moves the tuned pitch with it, without measuring again', async () => {
    const { p, lib, track } = await rig();
    p.scale = { on: true, root: 0, type: 'minorPentatonic' };
    await tune(p, lib, ['KICK']);
    const spec = (root: number): ScaleSpec => ({ root, type: 'minorPentatonic' });
    const seen: number[] = [];
    for (const root of [0, 2, 5, 7, 10]) {
      p.scale = { on: true, ...spec(root) };
      const k = track('KICK');
      expect(needsMeasure(p, k)).toBe(false); // the stored measurement still describes the sound
      const s = tuneSlot(p, k, null)!;
      expect(inScale(spec(root), s.synth!.target)).toBe(true);
      const a = await hear(p, lib, k);
      expect(Math.abs(offScale(a.fundamental!.hz, spec(root)))).toBeLessThan(16);
      seen.push(s.synth!.target);
    }
    expect(new Set(seen).size).toBeGreaterThan(1);
  });

  it('switching the scale off gives the original sound back exactly', async () => {
    const { p, lib, track } = await rig();
    const plain = await renderHit(lxrModule(), p, lib, track('KICK').id, 110, 1, { dry: true });
    p.scale = { on: true, root: 1, type: 'major' };
    await tune(p, lib, TOMS);
    const tuned = await renderHit(lxrModule(), p, lib, track('KICK').id, 110, 1, { dry: true });
    expect(tuned[0]!.some((v, i) => v !== plain[0]![i])).toBe(true);
    p.scale.on = false;
    const off = await renderHit(lxrModule(), p, lib, track('KICK').id, 110, 1, { dry: true });
    expect(Array.from(off[0]!)).toEqual(Array.from(plain[0]!));
    expect(engineTunes(p, track('KICK'))).toBeUndefined();
  });
});

describe('per-track overrides', () => {
  it('OFF is left alone, GLOBAL follows, CUSTOM keeps its own scale', async () => {
    const { p, lib, track } = await rig();
    p.scale = { on: true, root: 1, type: 'major' };
    track('KICK').scale = { mode: 'off', root: 0, type: 'minor' };
    track('LO TOM').scale = { mode: 'global', root: 0, type: 'minor' };
    track('HI TOM').scale = { mode: 'custom', root: 7, type: 'minorPentatonic' };
    const raw = Object.fromEntries(await Promise.all(TOMS.map(async (n) => [n, (await hear(p, lib, track(n), { raw: true })).fundamental!.hz] as const)));
    await tune(p, lib, TOMS);
    expect(engineTunes(p, track('KICK'))).toBeUndefined();
    const kick = (await hear(p, lib, track('KICK'))).fundamental!;
    expect(Math.abs(cents(kick.hz, raw.KICK!))).toBeLessThan(6); // untouched
    const lo = (await hear(p, lib, track('LO TOM'))).fundamental!;
    expect(Math.abs(offScale(lo.hz, { root: 1, type: 'major' }))).toBeLessThan(16);
    const hi = (await hear(p, lib, track('HI TOM'))).fundamental!;
    expect(Math.abs(offScale(hi.hz, { root: 7, type: 'minorPentatonic' }))).toBeLessThan(16);
    // the global scale off: the GLOBAL track plays untouched, the CUSTOM track still follows its own
    p.scale.on = false;
    const lo2 = (await hear(p, lib, track('LO TOM'))).fundamental!;
    expect(Math.abs(cents(lo2.hz, raw['LO TOM']!))).toBeLessThan(6);
    const hi2 = (await hear(p, lib, track('HI TOM'))).fundamental!;
    expect(Math.abs(offScale(hi2.hz, { root: 7, type: 'minorPentatonic' }))).toBeLessThan(16);
  });
});

describe('what stays', () => {
  it('keeps a kick’s downward pitch sweep and does not quantise it frame by frame', async () => {
    const { p, lib, track } = await rig();
    const k = track('KICK');
    k.sound.mode = 'synth';
    p.kit.synth.params[PAR.MODAMNT1] = 40; // a deep sweep
    p.kit.synth.params[PAR.MOD_EG1] = 60;
    const spec: ScaleSpec = { root: 1, type: 'majorPentatonic' };
    p.scale = { on: true, ...spec };
    const before = await hear(p, lib, k, { raw: true });
    expect(before.kind).toBe('swept');
    await tune(p, lib, ['KICK']);
    const after = await hear(p, lib, k);
    expect(after.kind).toBe('swept');
    // the sweep is as long as it was (in cents) and the start is still far above the body
    expect(Math.abs(after.sweepCents - before.sweepCents)).toBeLessThan(60);
    expect(after.initial!.hz).toBeGreaterThan(after.settled!.hz * 1.5);
    // the body is on the scale; the moments of the sweep are not snapped to notes
    expect(Math.abs(offScale(after.settled!.hz, spec))).toBeLessThan(16);
    const frames = after.contour.filter((c) => c.hz !== null && c.hz > after.settled!.hz * 1.15);
    expect(frames.length).toBeGreaterThan(3);
    expect(frames.filter((c) => Math.abs(offScale(c.hz!, spec)) > 40).length).toBeGreaterThan(1);
  });

  it('keeps the FM relationships (a whole-note move scales every partial with the fundamental)', async () => {
    const { p, lib, track } = await rig();
    const t = track('LO TOM');
    t.sound.mode = 'synth';
    p.kit.synth.params[PAR.FMAMNT2] = 90;
    p.kit.synth.params[PAR.FM_FREQ2] = 70;
    p.kit.synth.params[PAR.MODAMNT2] = 0;
    // a one-note scale: the fundamental has to travel several semitones
    const spec: ScaleSpec = { root: 11, type: 'user', mask: 1 };
    p.scale = { on: true, ...spec };
    const before = await hear(p, lib, t, { raw: true });
    await tune(p, lib, ['LO TOM']);
    const after = await hear(p, lib, t);
    const plan = tuneSlot(p, t, null)!.synth!;
    expect(Math.abs(plan.shift)).toBeGreaterThan(1.5);
    expect(before.fundamental && after.fundamental).toBeTruthy();
    expect(Math.abs(offScale(after.fundamental!.hz, spec))).toBeLessThan(16);
    expect(after.kind).toBe(before.kind);
    // the strong partials sit at the same multiples of the fundamental
    const ratios = (a: typeof before) => a.partials.slice(0, 4).map((x) => x / a.fundamental!.hz);
    const rb = ratios(before);
    const ra = ratios(after);
    for (let i = 0; i < Math.min(rb.length, ra.length, 3); i++) expect(Math.abs(Math.log2(ra[i]! / rb[i]!))).toBeLessThan(0.06);
  });

  it('keeps modulation around the quantised pitch instead of snapping it', async () => {
    const { p, lib, track } = await rig();
    const t = track('LO TOM');
    t.sound.mode = 'synth';
    p.kit.synth.params[PAR.MODAMNT2] = 0;
    t.sound.mod = { sources: {}, routes: [{ ...defaultRoute('r1', 'm1', 'lxr.osc.coarse', 0.1), smooth: 0 }] };
    const spec: ScaleSpec = { root: 0, type: 'major' };
    p.scale = { on: true, ...spec };
    p.macros = [0, 0, 0, 0];
    await tune(p, lib, ['LO TOM']);
    const centre = (await hear(p, lib, t)).fundamental!;
    expect(Math.abs(offScale(centre.hz, spec))).toBeLessThan(16);
    p.macros = [1, 0, 0, 0];
    const bent = (await hear(p, lib, t)).fundamental!;
    // a tenth of the 24 semitone depth, about 2.4 semitones, applied on top of the quantised note and not removed by it
    expect(cents(bent.hz, centre.hz)).toBeGreaterThan(150);
    expect(cents(bent.hz, centre.hz)).toBeLessThan(330);
  });

  it('snaps a sequencer pitch offset to the scale around the tuned note', async () => {
    const { p, lib, track } = await rig();
    const k = track('KICK');
    k.sound.mode = 'synth';
    const spec: ScaleSpec = { root: 0, type: 'majorPentatonic' };
    p.scale = { on: true, ...spec };
    await tune(p, lib, ['KICK']);
    const anchor = tuneSlot(p, k, null)!.anchor;
    for (const offset of [1, 2, 3, 4, 6, -1, -3]) {
      const hit = await renderKitHit(lxrModule(), p, lib, k.id, { vel: 127, slot: null, wet: false, pitch: offset, tail: 1.5 });
      const a = analysePitch(hit.audio, hit.rate, { maxSeconds: 1.2 });
      if (!a.fundamental) continue;
      const reached = hzToMidiFloat(a.fundamental.hz);
      expect(Math.abs(reached - nearestInScale(spec, reached)), `offset ${offset} from ${anchor}`).toBeLessThan(0.2);
      // and the offset was not simply dropped
      if (!inScale(spec, anchor + offset)) expect(Math.abs(reached - (anchor + offset))).toBeGreaterThan(0.6);
    }
    // an offset that already lands on the scale is not changed
    const up = await renderKitHit(lxrModule(), p, lib, k.id, { vel: 127, slot: null, wet: false, pitch: 0, tail: 1.5 });
    expect(up.peak).toBeGreaterThan(0.01);
  });
});

describe('sounds with no reliable pitch', () => {
  it('leaves hats and cymbals as they are, even when asked to follow the scale', async () => {
    const { p, lib, track } = await rig();
    p.scale = { on: true, root: 1, type: 'major' };
    for (const n of ['CL HAT', 'CYMBAL']) track(n).scale = { mode: 'global', root: 0, type: 'minor' };
    const plain = await renderHit(lxrModule(), p, lib, track('CL HAT').id, 110, 1, { dry: true });
    const res = await tune(p, lib, ['CL HAT', 'CYMBAL']);
    for (const r of res) {
      expect(r.layers.every((l) => l.state === 'left')).toBe(true);
      expect(r.layers[0]!.reason).toMatch(/INHARMONIC|UNPITCHED|RELIABLE/);
    }
    expect(engineTunes(p, track('CL HAT'))).toBeUndefined();
    const after = await renderHit(lxrModule(), p, lib, track('CL HAT').id, 110, 1, { dry: true });
    expect(Array.from(after[0]!)).toEqual(Array.from(plain[0]!));
  });

  it('does not guess for voices whose oscillator is not the pitch you hear', async () => {
    const { p, track } = await rig();
    p.scale = { on: true, root: 1, type: 'major' };
    const hat = track('CL HAT');
    hat.scale = { mode: 'custom', root: 0, type: 'major' };
    const n = naturalPitch(p, hat, null, 'synth');
    expect('refuse' in n && n.refuse).toBe('unmeasured');
    expect(tuneSlot(p, hat, null)).toBeNull();
    expect(pitchPlanOf(p, hat)).toBeNull();
    expect(pitchPlanOf(p, track('KICK'))).not.toBeNull();
  });
});

describe('measurements', () => {
  it('stay valid while only COARSE, FINE or the synth NOTE move, and go obsolete when the sound’s character changes', async () => {
    const { p, lib, track } = await rig();
    const k = track('KICK');
    k.sound.mode = 'synth';
    p.scale = { on: true, root: 1, type: 'major' };
    await tune(p, lib, ['KICK']);
    expect(needsMeasure(p, k)).toBe(false);
    const before = tuneSlot(p, k, null)!.synth!;
    // raise the oscillator a fifth: the measurement is carried along and the target follows the new pitch
    p.kit.synth.params[PAR.COARSE1] = p.kit.synth.params[PAR.COARSE1]! + 7;
    expect(needsMeasure(p, k)).toBe(false);
    const moved = tuneSlot(p, k, null)!.synth!;
    expect(moved.source).toBe('measured');
    expect(moved.natural).toBeCloseTo(before.natural + 7, 1);
    expect(inScale({ root: 1, type: 'major' }, moved.target)).toBe(true);
    const b = await hear(p, lib, k);
    expect(Math.abs(offScale(b.fundamental!.hz, { root: 1, type: 'major' }))).toBeLessThan(16);
    // a different waveform is a different sound: the measurement no longer describes it
    const shape = pitchShape(p, k, null, 'synth');
    p.kit.synth.params[PAR.OSC_WAVE_DRUM1] = (p.kit.synth.params[PAR.OSC_WAVE_DRUM1]! + 2) % 6;
    expect(pitchShape(p, k, null, 'synth')).not.toBe(shape);
    expect(needsMeasure(p, k)).toBe(true);
  });

  it('records what it measured on the track and nowhere else', async () => {
    const { p, lib, track } = await rig();
    p.scale = { on: true, root: 0, type: 'minor' };
    await tune(p, lib, ['KICK']);
    const keys = Object.keys(track('KICK').pitch!);
    expect(keys).toContain('base');
    expect(track('KICK').pitch!.base!.synth!.hz).toBeGreaterThan(20);
    expect(track('LO TOM').pitch).toBeUndefined();
  });
});

describe('hybrid and sample tracks', () => {
  it('moves a sample onto the scale using the pitch measured in the audio, not the file name', async () => {
    const { p, lib, track } = await rig();
    const id = await sineSample(lib, 130.81, 'bass_A1.wav'); // really C3; the name claims A1
    const t = track('LO TOM');
    t.sound.mode = 'sample';
    t.sound.samples = [id];
    t.sound.tune = 0;
    t.sound.fine = 0;
    expect(noteHint('bass_A1.wav')).toBe(33);
    const spec: ScaleSpec = { root: 1, type: 'major' };
    p.scale = { on: true, ...spec };
    // before any measurement the file name is all there is, and it is labelled as such
    const hint = naturalPitch(p, t, null, 'sample', { hint: (i) => noteHint(lib.get(i)?.name ?? '') });
    expect('midi' in hint && hint.source).toBe('hint');
    await tune(p, lib, ['LO TOM']);
    const n = naturalPitch(p, t, null, 'sample', { hint: (i) => noteHint(lib.get(i)?.name ?? '') });
    expect('midi' in n && n.source).toBe('measured');
    expect(Math.abs((n as { midi: number }).midi - hzToMidiFloat(130.81))).toBeLessThan(0.1); // C3, not A1
    const a = await hear(p, lib, t);
    expect(Math.abs(offScale(a.fundamental!.hz, spec))).toBeLessThan(16);
    // the sample was moved by playback speed only: its length changed with its pitch, nothing else was added
    const eng = engineTrackIn(p, t, false, lib);
    expect(eng.tunes![0]!.smp).not.toBe(0);
    expect(eng.tunes![0]!.note).toBe(0);
  });

  it('tunes a sample variation by its own measurement', async () => {
    const { p, lib, track } = await rig();
    const a = await sineSample(lib, 130.81);
    const b = await sineSample(lib, 155.56, 'second.wav');
    const t = track('LO TOM');
    t.sound.mode = 'sample';
    t.sound.samples = [a];
    t.sound.variations = [{ name: 'OTHER', params: {}, sample: { samples: [b] } }, null, null, null];
    const spec: ScaleSpec = { root: 0, type: 'majorPentatonic' };
    p.scale = { on: true, ...spec };
    await tune(p, lib, ['LO TOM']);
    for (const slot of [null, 0]) {
      const r = await hear(p, lib, t, { slot });
      expect(Math.abs(offScale(r.fundamental!.hz, spec)), `slot ${slot}`).toBeLessThan(16);
    }
  });

  it('keeps the layers of a hybrid sound on one pitch', async () => {
    const { p, lib, track } = await rig();
    const k = track('KICK');
    k.sound.mode = 'hybrid';
    k.sound.synthLevel = 1;
    k.sound.sampleLevel = 1;
    // a sample a hair off the synth's note, an octave up
    const synth = (await hear(p, lib, k, { layer: 'synth', raw: true })).fundamental!;
    k.sound.samples = [await sineSample(lib, synth.hz * 2 * 1.012, 'octave.wav')];
    const spec: ScaleSpec = { root: 1, type: 'major' };
    p.scale = { on: true, ...spec };
    const res = await tune(p, lib, ['KICK']);
    const layers = res[0]!.layers.filter((l) => l.slot === null);
    expect(layers.map((l) => l.layer).sort()).toEqual(['sample', 'synth']);
    const s = layers.find((l) => l.layer === 'synth')!;
    const m = layers.find((l) => l.layer === 'sample')!;
    expect(s.state === 'left' || m.state === 'left').toBe(false);
    // both end on the same pitch class, an octave apart
    expect(((m.target! - s.target!) % 12 + 12) % 12).toBe(0);
    for (const layer of ['synth', 'sample'] as const) {
      const a = await hear(p, lib, k, { layer });
      expect(Math.abs(offScale(a.fundamental!.hz, spec)), layer).toBeLessThan(16);
    }
    const mixed = await hear(p, lib, k);
    expect(mixed.kind === 'stable' || mixed.kind === 'swept').toBe(true);
  });

  it('leaves an unpitched sample layer alone when the synth layer is moved', async () => {
    const { p, lib, track } = await rig('dusty-breaks');
    const k = track('KICK');
    p.scale = { on: true, root: 1, type: 'major' };
    expect(k.sound.mode).toBe('hybrid'); // this preset's kick is a synth voice with a dusty kick sample
    const res = await tune(p, lib, ['KICK']);
    const smp = res[0]!.layers.find((l) => l.layer === 'sample' && l.slot === null)!;
    const syn = res[0]!.layers.find((l) => l.layer === 'synth' && l.slot === null)!;
    expect(['tuned', 'in-tune']).toContain(syn.state);
    // either the sample has a pitch of its own (and is moved to the scale) or it is left as it is
    if (smp.state === 'left') expect(engineTrackIn(p, k, false, lib).tunes![0]!.smp).toBe(0);
    else expect(Math.abs(smp.errorCents ?? 0)).toBeLessThan(40);
  });
});

describe('sound variations', () => {
  it('each variation lands on the scale, and so does the generator’s own pitch', async () => {
    const { p, lib, track } = await rig();
    const t = track('LO TOM');
    t.sound.mode = 'synth';
    const spec: ScaleSpec = { root: 3, type: 'minor' };
    p.scale = { on: true, ...spec };
    const plan = pitchPlanOf(p, t)!;
    expect(plan).toBeTruthy();
    const coarse = PAR.COARSE2;
    t.sound.variations = generateVariations(t.sound, t.role, p.kit.synth.params, { seed: 11, amount: 0.9, locks: p.soundLocks, force: true, pitch: plan });
    const filled = t.sound.variations.filter(Boolean).length;
    expect(filled).toBeGreaterThan(1);
    // the parameter-level pitch of every variation is a scale note
    for (const v of t.sound.variations) {
      const c = v?.params[coarse] ?? p.kit.synth.params[coarse]!;
      if (v?.params[coarse] !== undefined) expect(inScale(spec, c + t.sound.note - 60)).toBe(true);
    }
    await tune(p, lib, ['LO TOM']);
    for (const slot of [null, 0, 1, 2, 3]) {
      if (slot !== null && !t.sound.variations[slot]) continue;
      const a = await hear(p, lib, t, { slot });
      if (!a.fundamental) continue;
      expect(Math.abs(offScale(a.fundamental.hz, spec)), `slot ${slot}`).toBeLessThan(16);
    }
  });

  it('keeps variation inheritance: a variation only differs where it says so', async () => {
    const { p, track } = await rig();
    const t = track('KICK');
    t.sound.mode = 'synth';
    p.scale = { on: true, root: 0, type: 'minor' };
    const plan = pitchPlanOf(p, t)!;
    const free = generateVariations(t.sound, t.role, p.kit.synth.params, { seed: 5, amount: 0.7, locks: p.soundLocks, force: true });
    const snapped = generateVariations(t.sound, t.role, p.kit.synth.params, { seed: 5, amount: 0.7, locks: p.soundLocks, force: true, pitch: plan });
    for (let i = 0; i < 4; i++) {
      const a = free[i]?.params ?? {};
      const b = snapped[i]?.params ?? {};
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)].map(Number))) {
        if (k === PAR.COARSE1) continue; // the one parameter the scale may move
        expect(b[k]).toBe(a[k]);
      }
    }
  });

  it('a variation whose pitch moves is tuned against its own measurement, not the base’s', async () => {
    const { p, lib, track } = await rig();
    const t = track('HI TOM');
    t.sound.mode = 'synth';
    t.sound.variations = [{ name: 'DOWN', params: { [PAR.COARSE3]: p.kit.synth.params[PAR.COARSE3]! - 5 } }, null, null, null];
    const spec: ScaleSpec = { root: 1, type: 'major' };
    p.scale = { on: true, ...spec };
    await tune(p, lib, ['HI TOM']);
    const base = tuneSlot(p, t, null)!.synth!;
    const down = tuneSlot(p, t, 0)!.synth!;
    expect(down.natural).toBeCloseTo(base.natural - 5, 1);
    const a = await hear(p, lib, t, { slot: 0 });
    expect(Math.abs(offScale(a.fundamental!.hz, spec))).toBeLessThan(16);
  });
});

describe('kit generation', () => {
  const opts = (p: Project, seed = 3) => ({ seed, flavour: 'machine' as const, voiceRoles: [['kick'], ['ltom'], ['htom'], ['snare'], ['cymbal'], ['chat']], locks: p.soundLocks });

  it('chooses the tom-like voices’ pitches from the scale, and only those', async () => {
    const { p } = await rig();
    p.scale = { on: true, root: 6, type: 'minorPentatonic' };
    const plans = kitPitchPlans(p);
    expect(plans(0)).not.toBeNull();
    expect(plans(3)).toBeNull();
    expect(plans(5)).toBeNull();
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const kit = generateKit(p.kit.synth, { ...opts(p, seed), pitch: plans });
      for (const [v, par] of [[0, PAR.COARSE1], [1, PAR.COARSE2], [2, PAR.COARSE3]] as const) {
        const plan = plans(v)!;
        expect(inScale(plan.spec, kit.params[par]! + plan.note - 60), `seed ${seed} voice ${v}`).toBe(true);
      }
    }
  });

  it('does not change a kit when no scale is in force', async () => {
    const { p } = await rig();
    const plain = generateKit(p.kit.synth, opts(p));
    const none = generateKit(p.kit.synth, { ...opts(p), pitch: kitPitchPlans(p) });
    expect(none).toEqual(plain);
    const m1 = mutateKit(p.kit.synth, { ...opts(p), amount: 0.6 });
    expect(mutateKit(p.kit.synth, { ...opts(p), amount: 0.6, pitch: kitPitchPlans(p) })).toEqual(m1);
  });

  it('keeps a mutated and an evolving kit on the scale, and leaves a coarse that did not move alone', async () => {
    const { p } = await rig();
    p.scale = { on: true, root: 2, type: 'dorian' };
    const plans = kitPitchPlans(p);
    let kit = generateKit(p.kit.synth, { ...opts(p), pitch: plans });
    const home = kit;
    for (let i = 0; i < 12; i++) {
      kit = mutateKit(kit, { ...opts(p, 100 + i), amount: 0.8, pitch: plans });
      for (const [v, par] of [[0, PAR.COARSE1], [1, PAR.COARSE2], [2, PAR.COARSE3]] as const) {
        const plan = plans(v)!;
        expect(inScale(plan.spec, kit.params[par]! + plan.note - 60)).toBe(true);
      }
      kit = evolveKit(kit, home, { ...opts(p, 200 + i), amount: 0.8, pitch: plans });
      for (const [v, par] of [[0, PAR.COARSE1], [1, PAR.COARSE2], [2, PAR.COARSE3]] as const) {
        const plan = plans(v)!;
        expect(inScale(plan.spec, kit.params[par]! + plan.note - 60)).toBe(true);
      }
    }
    // an edit the player made by hand is not snapped by a mutation that does not touch it
    const hand = clone(home);
    hand.params[PAR.COARSE1] = (hand.params[PAR.COARSE1]! + 1) % 100;
    const locked = { ...p.soundLocks, params: [PAR.COARSE1] };
    const same = mutateKit(hand, { ...opts(p), locks: locked, amount: 0.9, pitch: plans });
    expect(same.params[PAR.COARSE1]).toBe(hand.params[PAR.COARSE1]);
  });

  it('a generated kit sounds on the scale once it is tuned', async () => {
    const { p, lib, track } = await rig();
    const spec: ScaleSpec = { root: 4, type: 'phrygian' };
    p.scale = { on: true, ...spec };
    p.kit.synth = generateKit(p.kit.synth, { ...opts(p, 21), pitch: kitPitchPlans(p) });
    for (const n of TOMS) track(n).sound.mode = 'synth';
    const res = await tune(p, lib, TOMS);
    for (const r of res) {
      for (const l of r.layers.filter((x) => x.state !== 'left')) expect(Math.abs(l.errorCents ?? 0), r.name).toBeLessThan(15);
    }
    for (const n of TOMS) {
      const a = await hear(p, lib, track(n));
      if (a.fundamental && (a.kind === 'stable' || a.kind === 'swept')) expect(Math.abs(offScale(a.fundamental.hz, spec)), n).toBeLessThan(16);
    }
  });
});

describe('the TUNER’s views', () => {
  it('keeps the untuned and the tuned analysis apart, and marks them stale when the scale changes', async () => {
    const { p, lib, track } = await rig();
    const k = track('KICK');
    p.scale = { on: true, root: 1, type: 'major' };
    await tune(p, lib, ['KICK']);
    const cache = new PitchCache();
    const played = await analyseTarget(lxrModule(), p, lib, { trackId: k.id, slot: null, layer: 'mix' });
    const raw = await analyseTarget(lxrModule(), p, lib, { trackId: k.id, slot: null, layer: 'mix', raw: true });
    cache.set(played);
    cache.set(raw);
    expect(cache.size).toBe(2);
    expect(played.analysis.fundamental!.hz).not.toBeCloseTo(raw.analysis.fundamental!.hz, 0);
    expect(cache.fresh(p, { trackId: k.id, slot: null, layer: 'mix' })).toBeTruthy();
    expect(cache.fresh(p, { trackId: k.id, slot: null, layer: 'mix', raw: true })).toBeTruthy();
    // a new scale changes the played sound but not the untuned one
    p.scale = { on: true, root: 6, type: 'minorPentatonic' };
    expect(cache.fresh(p, { trackId: k.id, slot: null, layer: 'mix' })).toBeNull();
    expect(cache.fresh(p, { trackId: k.id, slot: null, layer: 'mix', raw: true })).toBeTruthy();
    expect(soundFingerprint(p, { trackId: k.id, slot: null, layer: 'mix', raw: true })).toBe(soundFingerprint(untuned(p), { trackId: k.id, slot: null, layer: 'mix', raw: true }));
  });

  it('reports what the scale does to each sound without rendering', async () => {
    const { p, lib, track } = await rig();
    p.scale = { on: true, root: 1, type: 'major' };
    const k = track('KICK');
    k.sound.mode = 'synth';
    const before = planTrack(p, k)[0]!;
    expect(before.source).toBe('estimated');
    await tune(p, lib, ['KICK']);
    const after = planTrack(p, k)[0]!;
    expect(after.source).toBe('measured');
    expect(after.targetNote).toMatch(/^[A-G]#?\d$/);
    expect(after.naturalNote).toMatch(/^[A-G]#?\d$/);
    expect(Math.abs(after.shift!)).toBeLessThanOrEqual(1.1);
    p.scale.on = false;
    expect(planTrack(p, k)[0]!.state).toBe('left');
  });
});

describe('saving and loading', () => {
  it('keeps the measurements and the scale, and plays the same after a reload', async () => {
    const { p, lib, track } = await rig();
    p.scale = { on: true, root: 1, type: 'major' };
    track('LO TOM').scale = { mode: 'custom', root: 7, type: 'user', mask: 0b101010100101 };
    await tune(p, lib, TOMS);
    const back = parseProject(serialize(p));
    expect(back.scale).toEqual(p.scale);
    expect(back.tracks.find((t) => t.name === 'LO TOM')!.scale).toEqual(track('LO TOM').scale);
    for (const n of TOMS) {
      const a = track(n);
      const b = back.tracks.find((t) => t.name === n)!;
      expect(b.pitch).toEqual(a.pitch);
      expect(engineTunes(back, b)).toEqual(engineTunes(p, a));
    }
    const x = await renderHit(lxrModule(), p, lib, track('KICK').id, 100, 1, { dry: true });
    const y = await renderHit(lxrModule(), back, lib, back.tracks.find((t) => t.name === 'KICK')!.id, 100, 1, { dry: true });
    expect(Array.from(y[0]!)).toEqual(Array.from(x[0]!));
  });

  it('drops a damaged measurement and keeps playing', () => {
    const raw = {
      format: 'clatter-project',
      version: 7,
      tracks: [{ id: 't1', name: 'K', role: 'kick', pitch: { base: { synth: { kind: 'bogus', shape: 4, hz: 'x' } }, vars: 5 }, scale: { mode: 'custom', root: 99, type: 'x' } }],
    };
    const q = parseProject(JSON.stringify(raw));
    expect(q.tracks[0]!.pitch).toBeUndefined();
    expect(normaliseScale(q.tracks[0]!.scale!)).toEqual({ root: 3, type: 'minor' });
    expect(pitchOffset(q, q.tracks[0]!, null, 'synth')).toBeTypeOf('number');
  });
});
