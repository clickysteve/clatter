import { describe, expect, it } from 'vitest';
import { encodeWav16 } from '@slopfactory/core/export';
import { bundledLibrary, lxrModule, presetProject } from './helpers';
import { analyseTarget, normalizeTarget, PitchCache, soundFingerprint, type PitchTarget } from '../src/analysis/trackPitch';
import { renderHit } from '../src/audio/render';
import { clone, type Project, type Track } from '../src/model/types';
import { PAR } from '../src/sound/lxrParamIds';

const cents = (a: number, b: number) => Math.abs(1200 * Math.log2(a / b));

async function rig(preset = 'machine-room') {
  const lib = await bundledLibrary();
  const p = await presetProject(preset, lib);
  const track = (name: string): Track => p.tracks.find((x) => x.name === name)!;
  const run = (t: Track, o: Partial<PitchTarget> = {}) => analyseTarget(lxrModule(), p, lib, { trackId: t.id, slot: null, layer: 'mix', ...o }).then((r) => r.analysis);
  return { lib, p, track, run };
}

/** a decaying sine sample, long enough to analyse */
async function sineSample(lib: Awaited<ReturnType<typeof bundledLibrary>>, hz: number) {
  const n = 22050;
  const ch = new Float32Array(n);
  for (let i = 0; i < n; i++) ch[i] = 0.7 * Math.exp((-3 * i) / n) * Math.sin((2 * Math.PI * hz * i) / 44100);
  return (await lib.add((await encodeWav16([ch], 44100)).slice().buffer, `sine${hz}.wav`)).id;
}

describe('pitch of rendered LXR voices', () => {
  it('a kick is a stable low note whose pitch follows the oscillator', async () => {
    const { p, track, run } = await rig();
    const k = track('KICK');
    p.kit.synth.params[PAR.MODAMNT1] = 0; // no pitch envelope
    const a = await run(k);
    expect(a.kind).toBe('stable');
    expect(a.fundamental!.hz).toBeGreaterThan(30);
    expect(a.fundamental!.hz).toBeLessThan(120);
    expect(a.confidence).toBeGreaterThan(0.85);
    // an octave up in COARSE is an octave up in the audio, whatever the parameter value means
    const base = a.fundamental!.hz;
    p.kit.synth.params[PAR.COARSE1] = (p.kit.synth.params[PAR.COARSE1] ?? 0) + 12;
    const up = await run(k);
    expect(cents(up.fundamental!.hz, base * 2)).toBeLessThan(40);
    p.kit.synth.params[PAR.COARSE1] = (p.kit.synth.params[PAR.COARSE1] ?? 0) - 5; // 7 semitones above the start
    const fifth = await run(k);
    expect(cents(fifth.fundamental!.hz, base * Math.pow(2, 7 / 12))).toBeLessThan(40);
  });

  it('a sub-bass below the searched range gets no wrong note', async () => {
    const { p, track, run } = await rig();
    const k = track('KICK');
    p.kit.synth.params[PAR.MODAMNT1] = 0;
    const base = (await run(k)).fundamental!.hz;
    p.kit.synth.params[PAR.COARSE1] = (p.kit.synth.params[PAR.COARSE1] ?? 0) - 12; // about 24 Hz
    const a = await run(k);
    // either honest about not knowing, or right; never an octave-up note presented with confidence
    if (a.fundamental) expect(cents(a.fundamental.hz, base / 2)).toBeLessThan(60);
  });

  it('a kick with a pitch envelope sweeps from a high attack to its body', async () => {
    const { p, track, run } = await rig();
    const k = track('KICK');
    p.kit.synth.params[PAR.MODAMNT1] = 0;
    const flat = await run(k);
    p.kit.synth.params[PAR.MODAMNT1] = 40;
    p.kit.synth.params[PAR.MOD_EG1] = 60;
    const a = await run(k);
    expect(a.kind).toBe('swept');
    expect(a.initial!.hz).toBeGreaterThan(a.settled!.hz * 1.5);
    expect(a.sweepCents).toBeGreaterThan(600);
    // the body is the pitch the same oscillator has without the envelope
    expect(cents(a.settled!.hz, flat.fundamental!.hz)).toBeLessThan(60);
    expect(a.fundamental).toEqual(a.settled);
    expect(a.settleTime).toBeGreaterThan(0.03);
    expect(a.contour.length).toBeGreaterThan(10);
  });

  it('toms are pitched; hats and cymbals never get a note', async () => {
    const { track, run } = await rig();
    for (const n of ['LO TOM', 'HI TOM']) {
      const a = await run(track(n));
      expect(['stable', 'swept'], n).toContain(a.kind);
      expect(a.fundamental, n).not.toBeNull();
      expect(a.confidence, n).toBeGreaterThan(0.6);
    }
    for (const n of ['CL HAT', 'OP HAT', 'CYMBAL']) {
      const a = await run(track(n));
      expect(['inharmonic', 'unpitched'], n).toContain(a.kind);
      expect(a.fundamental, n).toBeNull();
      expect(a.settled, n).toBeNull();
    }
  });

  it('a sample track with no sample is silent and gets no note', async () => {
    const { track, run } = await rig();
    const t = track('PERC');
    t.sound.mode = 'sample';
    t.sound.samples = [];
    const a = await run(t);
    expect(a.kind).toBe('silent');
    expect(a.fundamental).toBeNull();
    expect(a.confidence).toBe(0);
  });
});

describe('SAMPLE and HYBRID tracks', () => {
  it('a sample track is analysed from its audio, and TUNE moves it', async () => {
    const { lib, track, run } = await rig();
    const t = track('PERC');
    t.sound.mode = 'sample';
    t.sound.samples = [await sineSample(lib, 220)];
    t.sound.tune = 0;
    t.sound.fine = 0;
    const a = await run(t);
    expect(a.kind).toBe('stable');
    expect(cents(a.fundamental!.hz, 220)).toBeLessThan(20);
    expect(a.fundamental!.note).toBe('A3');
    t.sound.tune = 12;
    const up = await run(t);
    expect(cents(up.fundamental!.hz, 440)).toBeLessThan(20);
    t.sound.tune = 0;
    t.sound.fine = 50;
    const fine = await run(t);
    expect(cents(fine.fundamental!.hz, 220)).toBeGreaterThan(35);
    expect(cents(fine.fundamental!.hz, 220)).toBeLessThan(65);
  });

  it('a hybrid track can be analysed as the mix, the synth layer or the sample layer', async () => {
    const { lib, p, track, run } = await rig();
    const t = track('KICK');
    p.kit.synth.params[PAR.MODAMNT1] = 0;
    t.sound.mode = 'hybrid';
    t.sound.samples = [await sineSample(lib, 330)];
    const synth = await run(t, { layer: 'synth' });
    const sample = await run(t, { layer: 'sample' });
    expect(synth.fundamental!.hz).toBeLessThan(120);
    expect(cents(sample.fundamental!.hz, 330)).toBeLessThan(20);
    const mix = await run(t, { layer: 'mix' });
    expect(mix.kind === 'inharmonic' || mix.fundamental !== null).toBe(true);
    // on a SYNTH track the layer is meaningless and is ignored
    const syn = track('LO TOM');
    expect(normalizeTarget(p, { trackId: syn.id, slot: null, layer: 'sample' }).layer).toBe('mix');
  });
});

describe('variations', () => {
  it('analyses the variation that was asked for, not the base', async () => {
    const { p, track, run } = await rig();
    const t = track('HI TOM');
    const base = await run(t);
    const coarse = p.kit.synth.params[PAR.COARSE3] ?? 0;
    t.sound.variations = [null, { name: 'UP', params: { [PAR.COARSE3]: Math.min(127, coarse + 12) } }, null, null];
    const again = await run(t);
    const up = await run(t, { slot: 1 });
    expect(cents(again.fundamental!.hz, base.fundamental!.hz)).toBeLessThan(5);
    expect(cents(up.fundamental!.hz, base.fundamental!.hz * 2)).toBeLessThan(60);
    // an empty slot is the base sound
    const empty = await run(t, { slot: 0 });
    expect(cents(empty.fundamental!.hz, base.fundamental!.hz)).toBeLessThan(5);
    expect(normalizeTarget(p, { trackId: t.id, slot: 0, layer: 'mix' }).slot).toBeNull();
    expect(normalizeTarget(p, { trackId: t.id, slot: 1, layer: 'mix' }).slot).toBe(1);
  });
});

describe('analysis changes nothing', () => {
  it('leaves the project untouched and renders the same hit as before', async () => {
    const { lib, p, track, run } = await rig();
    const before = JSON.stringify(p);
    for (const n of ['KICK', 'SNARE', 'CLAP', 'CL HAT']) await run(track(n));
    expect(JSON.stringify(p)).toBe(before);
    const t = track('KICK');
    const plain = await renderHit(lxrModule(), p, lib, t.id);
    const viaOpts = await renderHit(lxrModule(), p, lib, t.id, 127, 4, { slot: null, layer: 'mix' });
    expect(viaOpts[0]!.length).toBe(plain[0]!.length);
    expect(viaOpts[0]!.every((v, i) => v === plain[0]![i])).toBe(true);
  });

  it('is deterministic: the same sound gives the same result', async () => {
    const { track, run } = await rig();
    const a = await run(track('SNARE'));
    const b = await run(track('SNARE'));
    expect(b).toEqual(a);
  });
});

describe('the cache', () => {
  const target = (t: Track): PitchTarget => ({ trackId: t.id, slot: null, layer: 'mix' });

  it('keeps a result until a parameter that can change the sound changes', async () => {
    const { lib, p, track } = await rig();
    const k = track('KICK');
    const cache = new PitchCache();
    expect(cache.lookup(p, target(k))).toBeNull();
    const rec = await analyseTarget(lxrModule(), p, lib, target(k));
    cache.set(rec);
    expect(cache.fresh(p, target(k))).toBe(rec);

    // things that cannot change the single dry hit: the pattern, tempo, mixer, other tracks' sounds, names
    const q = clone(p) as Project;
    q.tempo += 7;
    q.name = 'other';
    q.tracks.find((x) => x.id === k.id)!.mix.volume = 0.3;
    q.tracks.find((x) => x.id === k.id)!.mix.pan = 0.5;
    q.tracks.find((x) => x.id === track('SNARE').id)!.sound.tune = 5;
    q.tracks.find((x) => x.id === track('SNARE').id)!.sound.variations = [{ name: 'X', params: { [PAR.COARSE4]: 20 } }, null, null, null];
    expect(soundFingerprint(q, target(k))).toBe(soundFingerprint(p, target(k)));
    expect(cache.fresh(q, target(k))).not.toBeNull();

    // things that can
    const changes: [string, (x: Project) => void][] = [
      ['kit parameter', (x) => void (x.kit.synth.params[PAR.COARSE1] = (x.kit.synth.params[PAR.COARSE1] ?? 0) + 1)],
      ['pitch envelope', (x) => void (x.kit.synth.params[PAR.MODAMNT1] = 3)],
      ['trigger', (x) => void (x.tracks.find((y) => y.id === k.id)!.sound.trigger = 1)],
      ['source mode', (x) => void (x.tracks.find((y) => y.id === k.id)!.sound.mode = 'sample')],
      ['sample tune', (x) => void (x.tracks.find((y) => y.id === k.id)!.sound.tune = 2)],
      ['macro', (x) => void (x.macros = [0.5, 0, 0, 0])],
      ['seed', (x) => void (x.seed += 1)],
    ];
    for (const [what, f] of changes) {
      const x = clone(p) as Project;
      f(x);
      expect(soundFingerprint(x, target(k)), what).not.toBe(soundFingerprint(p, target(k)));
      expect(cache.fresh(x, target(k)), what).toBeNull();
      expect(cache.lookup(x, target(k))!.stale, what).toBe(true);
    }
  });

  it('a variation counts only for its own slot and for what it overrides', async () => {
    const { p, track } = await rig();
    const t = track('HI TOM');
    const x = clone(p) as Project;
    const tx = x.tracks.find((y) => y.id === t.id)!;
    tx.sound.variations = [null, { name: 'B', params: { [PAR.COARSE3]: 70 } }, null, null];
    const base: PitchTarget = { trackId: t.id, slot: null, layer: 'mix' };
    const b: PitchTarget = { trackId: t.id, slot: 1, layer: 'mix' };
    // the base sound does not depend on variation B...
    expect(soundFingerprint(x, base)).toBe(soundFingerprint(p, base));
    // ...but B does
    expect(soundFingerprint(x, b)).not.toBe(soundFingerprint(p, b));
    tx.sound.variations[1]!.params[PAR.COARSE3] = 71;
    const y = clone(x) as Project;
    expect(soundFingerprint(y, b)).toBe(soundFingerprint(x, b));
    y.tracks.find((z) => z.id === t.id)!.sound.variations![1]!.params[PAR.COARSE3] = 72;
    expect(soundFingerprint(y, b)).not.toBe(soundFingerprint(x, b));
  });

  it('forgets a track and keeps results per target', async () => {
    const { lib, p, track } = await rig();
    const cache = new PitchCache();
    for (const n of ['KICK', 'SNARE']) cache.set(await analyseTarget(lxrModule(), p, lib, { trackId: track(n).id, slot: null, layer: 'mix' }));
    expect(cache.size).toBe(2);
    cache.clear(track('KICK').id);
    expect(cache.size).toBe(1);
    expect(cache.lookup(p, { trackId: track('SNARE').id, slot: null, layer: 'mix' })).not.toBeNull();
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it('refuses a track that does not exist', async () => {
    const { lib, p } = await rig();
    await expect(analyseTarget(lxrModule(), p, lib, { trackId: 'nope', slot: null, layer: 'mix' })).rejects.toThrow();
  });
});
