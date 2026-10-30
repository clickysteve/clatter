/**
 * SAMPLE FACTORY: batch generation through the real LXR engine, cancellation and retry,
 * deterministic seeds, quality control, near-duplicates, selection, WAV and ZIP validity, the pack
 * metadata, file-name collisions, import/export, and that the project is left alone.
 */
import { describe, expect, it, vi } from 'vitest';
import { readZip } from '@slopfactory/core/export';
import { bundledLibrary, lxrModule, presetProject } from './helpers';
import { FactorySession, MAX_ATTEMPTS, type FactoryDeps } from '../src/app/factory';
import { renderKitHit } from '../src/audio/render';
import { exportPack, exportable, packFileName, PackCancelled, parsePackManifest, readPack, serialText, type PackManifest } from '../src/export/packExport';
import { uniqueName } from '../src/export/kitExport';
import { decodeWav } from '../src/export/wavFile';
import { serialize } from '../src/model/project';
import { clone, type Project } from '../src/model/types';
import { seedFromText, type SeedValue } from '../src/rhythm/seed';
import { measure, qcCheck, qcStatus, DUPLICATE_DISTANCE, featureDistance, findDuplicates, soundFeatures, wavePeaks, describeSound, wantedDistance, FEATURE_COUNT } from '../src/sound/sampleQc';
import { COUNT_CHOICES, statusOf, clampCount, designSound, FACTORY_INSTRUMENTS, INSTRUMENT_SPECS, planBatch, STAGE_TRACK, stageProject, voiceFor, type FactorySound } from '../src/sound/factory';
import { voiceKeys } from '../src/sound/kitgen';
import { INSTRUMENTS } from '../src/sound/voiceScore';
import { SoundLibrary, memoryStore } from '../src/sound/soundLibrary';
import { applyToKit } from '../src/sound/discover';

vi.setConfig({ testTimeout: 240000 });

const seed = (t: string): SeedValue => ({ seed: seedFromText(t), text: t });
type Lib = Awaited<ReturnType<typeof bundledLibrary>>;

async function rig(opts: { seedText?: string; concurrency?: number; onYield?: (n: number) => void } = {}) {
  const lib: Lib = await bundledLibrary();
  const project: Project = await presetProject('machine-room', lib);
  const played: Float32Array[][] = [];
  const applied: { voice: number; values: unknown }[] = [];
  const notes: string[] = [];
  let yields = 0;
  let changes = 0;
  let sd = seed(opts.seedText ?? 'iron-orchid');
  const deps: FactoryDeps = {
    project: () => project,
    flavour: () => 'electro',
    drawSeed: () => sd,
    render: (p, o) => renderKitHit(lxrModule(), p, lib, STAGE_TRACK, { vel: 110, slot: null, wet: o.wet, tail: o.tail, maxSeconds: o.maxSeconds }),
    runPack: (pr, sounds, options, onProgress, signal) => exportPack(pr, sounds, options, { module: lxrModule(), library: lib, onProgress, signal, now: () => new Date('2026-01-01T00:00:00Z'), yieldToUi: async () => undefined }),
    deliver: (f) => void (delivered.push(f), undefined),
    play: (a) => void played.push(a),
    stop: () => undefined,
    apply: (c) => (applied.push({ voice: c.voice, values: c.values }), { locked: 0 }),
    changed: () => void changes++,
    say: (t) => void notes.push(t),
    notify: (t) => void notes.push(t),
    yieldToUi: async () => {
      opts.onYield?.(++yields);
    },
    concurrency: opts.concurrency ?? 2,
  };
  const delivered: { name: string; data: Uint8Array; type: string }[] = [];
  const fs = new FactorySession(deps, new SoundLibrary(memoryStore()));
  fs.character = 'electro';
  fs.wildness = 0.6;
  return { lib, project, fs, played, applied, notes, delivered, setSeed: (s: SeedValue) => (sd = s), changes: () => changes };
}

const sigs = (fs: FactorySession) => fs.sounds.map((s) => `${s.id}:${s.candidate.key}:${s.info?.peak.toFixed(5)}`);

describe('planning', () => {
  it('offers the ten instruments and MIXED, and the counts 8, 16, 32, 64, 128 plus custom values', () => {
    expect(FACTORY_INSTRUMENTS.map((i) => i.id)).toEqual([...INSTRUMENTS, 'mixed']);
    expect([...COUNT_CHOICES]).toEqual([8, 16, 32, 64, 128]);
    expect(clampCount(0)).toBe(1);
    expect(clampCount(1000)).toBe(256);
    expect(clampCount(37.4)).toBe(37);
    expect(clampCount(NaN)).toBe(16);
  });
  it('deals MIXED evenly, a new order each round, and numbers each instrument from 1', () => {
    const plan = planBatch({ instrument: 'mixed', count: 25, seed: seed('plan') });
    expect(plan).toHaveLength(25);
    const n = new Map<string, number>();
    for (const p of plan) n.set(p.instrument, (n.get(p.instrument) ?? 0) + 1);
    expect([...n.values()].sort()).toEqual([2, 2, 2, 2, 2, 3, 3, 3, 3, 3]);
    for (const i of INSTRUMENTS) expect(plan.filter((p) => p.instrument === i).map((p) => p.serial)).toEqual(Array.from({ length: n.get(i)! }, (_, k) => k + 1));
    expect(plan.map((p) => p.order)).toEqual(Array.from({ length: 25 }, (_, k) => k + 1));
    expect(planBatch({ instrument: 'mixed', count: 25, seed: seed('plan') })).toEqual(plan);
    expect(planBatch({ instrument: 'mixed', count: 25, seed: seed('other') }).map((p) => p.instrument)).not.toEqual(plan.map((p) => p.instrument));
    expect(planBatch({ instrument: 'kick', count: 3, seed: seed('x') }, { kick: 7 }).map((p) => `${p.instrument}${p.serial}`)).toEqual(['kick7', 'kick8', 'kick9']);
  });
  it('maps every instrument to a real LXR voice and trigger', () => {
    for (const i of INSTRUMENTS) {
      const spec = INSTRUMENT_SPECS[i];
      for (let n = 1; n <= 4; n++) {
        const v = voiceFor(i, n);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(5);
        expect(spec.trigger(v)).toBeLessThanOrEqual(6);
      }
    }
    expect(INSTRUMENT_SPECS.ohat.trigger(5)).toBe(6);
    expect(INSTRUMENT_SPECS.chat.trigger(5)).toBe(5);
  });
});

describe('designing', () => {
  it('is deterministic: the same inputs make the same sound, a new seed, serial or draw a different one', async () => {
    const { project } = await rig();
    const base = project.kit.synth;
    const d = (over: Partial<Parameters<typeof designSound>[0]> = {}) => designSound({ base, seed: seed('a'), instrument: 'kick', serial: 1, draw: 0, attempt: 0, character: 'electro', wildness: 60, variation: 70, ...over });
    expect(d()).toEqual(d());
    expect(d().key).not.toBe(d({ seed: seed('b') }).key);
    expect(d().key).not.toBe(d({ serial: 2 }).key);
    expect(d().key).not.toBe(d({ draw: 1 }).key);
    expect(d().key).not.toBe(d({ attempt: 1 }).key);
    expect(d().key).not.toBe(d({ character: 'industrial' }).key);
  });
  it('VARIATION 0 makes related sounds, 100 makes independent ones', async () => {
    const { project } = await rig();
    const spread = (variation: number) => {
      const sounds = Array.from({ length: 12 }, (_, i) => designSound({ base: project.kit.synth, seed: seed('v'), instrument: 'ltom', serial: i + 1, draw: 0, attempt: 0, character: 'machine', wildness: 50, variation }));
      let total = 0;
      let n = 0;
      for (const k of Object.keys(sounds[0]!.values) as (keyof (typeof sounds)[0]['values'])[]) {
        const xs = sounds.map((s) => s.values[k]!);
        const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
        total += xs.reduce((a, b) => a + Math.abs(b - mean), 0) / xs.length;
        n++;
      }
      return total / n;
    };
    expect(spread(0)).toBeLessThan(0.5);
    expect(spread(30)).toBeLessThan(spread(100));
    expect(spread(100)).toBeGreaterThan(spread(0) * 4);
  });
  it('stays on the voice of its instrument and renders on a stage of its own', async () => {
    const { project } = await rig();
    const before = serialize(project);
    for (const i of INSTRUMENTS) {
      const c = designSound({ base: project.kit.synth, seed: seed('stage'), instrument: i, serial: 1, draw: 0, attempt: 0, character: 'machine', wildness: 60, variation: 70 });
      expect(c.voice).toBe(voiceFor(i, 1));
      const st = stageProject(project, i, c);
      expect(st.tracks).toHaveLength(1);
      expect(st.tracks[0]!.id).toBe(STAGE_TRACK);
      expect(st.tracks[0]!.sound.trigger).toBe(INSTRUMENT_SPECS[i].trigger(c.voice));
      expect(st.patterns).toEqual([]);
      // the sound's voice is in the stage's kit; the other voices are the live kit's
      const keys = voiceKeys(c.voice);
      for (const [k, v] of Object.entries(c.values)) expect(st.kit.synth.params[keys[k as keyof typeof keys]!]).toBe(v);
    }
    expect(serialize(project)).toBe(before);
  });
});

describe('quality control', () => {
  const rate = 44100;
  const tone = (n: number, amp: number, hz = 80) => Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / rate) * Math.exp(-i / (rate * 0.12)));
  const check = (a: Float32Array[], instr: (typeof INSTRUMENTS)[number] = 'kick', truncated = false) => qcCheck(a, measure(a, rate), instr, truncated);
  const ids = (a: Float32Array[], instr?: (typeof INSTRUMENTS)[number]) => check(a, instr).map((f) => f.id);

  it('passes a healthy sound', () => {
    const t = tone(rate / 2, 0.6);
    expect(check([t, t])).toEqual([]);
  });
  it('flags silence, a vanishing click, and very low output', () => {
    const z = new Float32Array(rate / 4);
    expect(ids([z, z])).toEqual(['silent']);
    const click = new Float32Array(rate / 4);
    click[100] = 0.8;
    click[101] = -0.5;
    expect(ids([click, click]).some((id) => id === 'vanishes' || id === 'click')).toBe(true);
    const quiet = tone(rate / 2, 0.005);
    const r = check([quiet, quiet]);
    expect(r.map((f) => f.id)).toContain('low');
    expect(qcStatus(r)).toBe('warn');
  });
  it('flags clipping and level beyond full scale', () => {
    const hot = tone(rate / 2, 3).map((v) => Math.max(-1, Math.min(1, v)));
    const r = check([hot, hot]);
    expect(r.find((f) => f.id === 'clip')?.text).toMatch(/CLIPPING/);
    const over = tone(rate / 2, 1.8);
    expect(check([over, over]).find((f) => f.id === 'clip')?.text).toMatch(/OVER FULL SCALE/);
  });
  it('fails invalid samples', () => {
    const t = tone(rate / 2, 0.5);
    t[500] = NaN;
    t[600] = Infinity;
    const r = check([t, t]);
    expect(r.map((f) => f.id)).toEqual(['invalid']);
    expect(qcStatus(r)).toBe('fail');
  });
  it('flags a DC offset, and fails a heavy one', () => {
    const dc = (o: number) => tone(rate / 2, 0.3).map((v) => v + o);
    expect(check([dc(0.05), dc(0.05)]).find((f) => f.id === 'dc')?.severity).toBe('warn');
    const heavy = check([dc(0.6), dc(0.6)]);
    expect(heavy.find((f) => f.id === 'dc')?.severity).toBe('fail');
    expect(qcStatus(heavy)).toBe('fail');
  });
  it('flags a tail that never dies and a tail cut off by the render', () => {
    const drone = Float32Array.from({ length: rate * 2 }, (_, i) => 0.4 * Math.sin((2 * Math.PI * 110 * i) / rate));
    expect(ids([drone, drone])).toContain('drone');
    const t = tone(rate / 2, 0.6);
    expect(check([t, t], 'kick', true).map((f) => f.id)).toContain('cut');
  });
  it('never discards: a flag is information, and every severity is overridable in the session', () => {
    expect(qcStatus([])).toBe('ok');
    expect(qcStatus([{ id: 'low', severity: 'warn', text: '' }])).toBe('warn');
  });
});

describe('features and near-duplicates', () => {
  const rate = 44100;
  const hit = (hz: number, decay: number, noise = 0) => Float32Array.from({ length: rate / 2 }, (_, i) => Math.exp(-i / (rate * decay)) * ((1 - noise) * Math.sin((2 * Math.PI * hz * i) / rate) + noise * (Math.sin(i * 12.9898) * 43758.5453 - Math.floor(Math.sin(i * 12.9898) * 43758.5453) - 0.5) * 2));
  const feat = (a: Float32Array) => soundFeatures([a, a], measure([a, a], rate));

  it('makes a fixed-length vector in 0-1, summarises the waveform, and ignores loudness', () => {
    const a = hit(60, 0.1);
    const f = feat(a);
    expect(f).toHaveLength(FEATURE_COUNT);
    for (const x of f) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(1);
    }
    const quiet = a.map((v) => v * 0.25);
    expect(featureDistance(f, feat(quiet))).toBeLessThan(0.01);
    const w = wavePeaks([a, a]);
    expect(w).toHaveLength(64);
    expect(Math.max(...w)).toBe(1);
  });
  it('is zero for the same sound and grows with the difference', () => {
    const a = feat(hit(60, 0.1));
    const near = feat(hit(62, 0.1));
    const far = feat(hit(2500, 0.03, 0.6));
    expect(featureDistance(a, a)).toBe(0);
    expect(featureDistance(a, near)).toBeLessThan(DUPLICATE_DISTANCE * 2);
    expect(featureDistance(a, far)).toBeGreaterThan(featureDistance(a, near) * 3);
    expect(featureDistance(a, far)).toBeCloseTo(featureDistance(far, a), 10);
  });
  it('finds near-duplicates within an instrument and marks the later one', () => {
    const a = feat(hit(60, 0.1));
    const items = [
      { id: 'k1', group: 'kick', order: 1, features: a },
      { id: 'k2', group: 'kick', order: 2, features: feat(hit(60.2, 0.1)) },
      { id: 'k3', group: 'kick', order: 3, features: feat(hit(900, 0.04, 0.5)) },
      { id: 's1', group: 'snare', order: 4, features: a },
      { id: 'k4', group: 'kick', order: 5, features: a },
    ];
    const d = findDuplicates(items);
    expect(d.get('k2')).toBe('k1');
    expect(d.get('k4')).toBe('k1');
    expect(d.has('k1')).toBe(false);
    expect(d.has('k3')).toBe(false);
    // another instrument is never a duplicate
    expect(d.has('s1')).toBe(false);
    // order decides which is the original, not list position
    expect([...findDuplicates([...items].reverse()).entries()].sort()).toEqual([...d.entries()].sort());
  });
  it('asks for more distance at a higher DIVERSITY', () => {
    expect(wantedDistance(0)).toBeLessThan(wantedDistance(0.5));
    expect(wantedDistance(0.5)).toBeLessThan(wantedDistance(1));
  });
  it('gives a word for what a sound is like', () => {
    const m = (over: Partial<ReturnType<typeof measure>>) => ({ ...measure([hit(60, 0.1)], rate), ...over });
    expect(describeSound(m({ noise: 0.9, centroid: 3000 }), null)).toBe('NOISY');
    expect(describeSound(m({ noise: 0.9, centroid: 9000 }), null)).toBe('HISSY');
    expect(describeSound(m({ noise: 0.3, tonality: 0.6, centroid: 5000 }), 'inharmonic')).toBe('METALLIC');
    expect(describeSound(m({ noise: 0.1, tonality: 0.1, centroid: 800, lengthMs: 400, transientDb: 3, sweepOct: 0 }), 'stable')).toBe('DARK');
  });
});

describe('batch generation through the engine', () => {
  it('renders every sound with the real engine, measures it and keeps no audio', async () => {
    const { fs, project, changes } = await rig();
    const before = serialize(project);
    fs.instrument = 'mixed';
    fs.count = 10;
    await fs.generate();
    expect(fs.sounds).toHaveLength(10);
    expect(fs.job).toBeNull();
    expect(changes()).toBeGreaterThan(0);
    for (const s of fs.sounds) {
      expect(s.status).toBe('ready');
      const i = s.info!;
      expect(i.rate).toBe(44100);
      expect(i.frames).toBeGreaterThan(441);
      expect(Number.isFinite(i.peak)).toBe(true);
      expect(i.peak).toBeGreaterThan(1e-4);
      expect(i.wave).toHaveLength(64);
      expect(i.features).toHaveLength(FEATURE_COUNT);
      expect(i.word).toMatch(/^[A-Z]+$/);
    }
    // each instrument once, exactly the ten
    expect(new Set(fs.sounds.map((s) => s.instrument)).size).toBe(10);
    // nothing but numbers is held for audio
    expect(JSON.stringify(fs.sounds)).not.toMatch(/Float32Array/);
    expect(serialize(project)).toBe(before);
  });
  it('measures pitch only where it means something, and names a note only for a reliable one', async () => {
    const { fs } = await rig();
    fs.instrument = 'mixed';
    fs.count = 20;
    await fs.generate();
    for (const s of fs.sounds) {
      const p = s.info!.pitch;
      if (['chat', 'ohat', 'cymbal', 'snare', 'clap'].includes(s.instrument)) expect(p.kind).toBe('skipped');
      if (p.reliable) {
        expect(p.note).toMatch(/^[A-G]#?-?\d$/);
        expect(p.confidence).toBeGreaterThanOrEqual(0.5);
        expect(['stable', 'swept']).toContain(p.kind);
      } else expect(p.note).toBeNull();
    }
    expect(fs.sounds.some((s) => s.info!.pitch.reliable)).toBe(true);
  });
  it('is deterministic: the same seed and settings make the same sounds, a different seed different ones', async () => {
    const a = await rig({ seedText: 'copper-tide' });
    const b = await rig({ seedText: 'copper-tide', concurrency: 1 });
    const c = await rig({ seedText: 'glass-ember' });
    for (const r of [a, b, c]) {
      r.fs.instrument = 'mixed';
      r.fs.count = 12;
      await r.fs.generate();
    }
    // the number of sounds rendered at once makes no difference
    expect(sigs(a.fs)).toEqual(sigs(b.fs));
    expect(sigs(c.fs)).not.toEqual(sigs(a.fs));
  });
  it('honours INSTRUMENT, COUNT and CHARACTER', async () => {
    const { fs } = await rig();
    fs.instrument = 'ohat';
    fs.count = 8;
    fs.character = 'glitch';
    await fs.generate();
    expect(fs.sounds).toHaveLength(8);
    expect(fs.sounds.every((s) => s.instrument === 'ohat' && s.candidate.voice === 5 && s.made.character === 'glitch')).toBe(true);
    expect(fs.sounds.map((s) => s.serial)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    // a second batch adds to the first and carries on numbering
    fs.count = 2;
    await fs.generate();
    expect(fs.sounds.map((s) => s.serial)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(new Set(fs.sounds.map((s) => s.id)).size).toBe(10);
  });
  it('DIVERSITY redraws sounds that are too alike and keeps the most different attempt; 0 redraws nothing', async () => {
    const run = async (diversity: number) => {
      const r = await rig({ seedText: 'same-same' });
      r.fs.instrument = 'kick';
      r.fs.count = 12;
      r.fs.variation = 5;
      r.fs.diversity = diversity;
      await r.fs.generate();
      return r.fs;
    };
    const low = await run(0);
    const high = await run(100);
    expect(low.sounds.every((s) => s.attempt === 0)).toBe(true);
    expect(high.sounds.some((s) => s.attempt > 0)).toBe(true);
    expect(high.sounds.every((s) => s.attempt <= MAX_ATTEMPTS)).toBe(true);
    const nn = (fs: FactorySession) => {
      const f = fs.sounds.map((s) => s.info!.features);
      return f.map((a, i) => Math.min(...f.filter((_, j) => j !== i).map((b) => featureDistance(a, b))));
    };
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(mean(nn(high))).toBeGreaterThan(mean(nn(low)));
    // and it flags what stays alike
    expect(low.sounds.filter((s) => s.dupOf).length).toBeGreaterThan(high.sounds.filter((s) => s.dupOf).length - 1);
  });
  it('can make a hundred sounds, select the best twenty and export an organised pack', async () => {
    const { fs, delivered, project } = await rig({ seedText: 'hundred-weird' });
    const before = serialize(project);
    fs.instrument = 'mixed';
    fs.count = 100;
    fs.wildness = 0.9;
    fs.diversity = 60;
    await fs.generate();
    expect(fs.sounds).toHaveLength(100);
    expect(fs.counts().failed).toBe(0);
    // the best twenty: favourites first, then the most interesting that pass
    fs.setView({ sort: 'loudness', desc: true });
    const best = fs.visible().filter((s) => !s.dupOf && s.info!.flags.every((f) => f.severity !== 'fail')).slice(0, 20);
    expect(best).toHaveLength(20);
    fs.selectMany(best);
    expect(fs.selected).toHaveLength(20);
    fs.pack.name = 'HUNDRED WEIRD';
    await fs.exportPack();
    expect(delivered).toHaveLength(1);
    const entries = await readZip(delivered[0]!.data);
    const wavs = entries.filter((e) => e.name.endsWith('.wav'));
    expect(wavs).toHaveLength(20);
    expect(wavs.every((e) => /^[A-Z_]+\/CLATTER_[A-Z]+_[A-Za-z0-9]+_\d{3}\.wav$/.test(e.name))).toBe(true);
    expect(entries.map((e) => e.name)).toContain('pack.json');
    expect(serialize(project)).toBe(before);
  });
});

describe('cancel, retry, clear, regenerate', () => {
  it('cancels a batch, keeps what is done, and RETRY finishes the rest', async () => {
    let fsRef: FactorySession | null = null;
    const r = await rig({ concurrency: 1, onYield: (n) => n === 8 && fsRef!.cancel() });
    fsRef = r.fs;
    const { fs } = r;
    fs.instrument = 'perc';
    fs.count = 16;
    fs.diversity = 0;
    await fs.generate();
    const c = fs.counts();
    expect(c.ready).toBeGreaterThan(0);
    expect(c.ready).toBeLessThan(16);
    expect(fs.sounds.filter((s) => s.status === 'cancelled').length).toBe(16 - c.ready);
    expect(fs.job).toBeNull();
    const done = sigs(fs).slice(0, c.ready);
    fsRef = null;
    await fs.retry();
    expect(fs.counts().ready).toBe(16);
    // sounds finished before the cancel were not touched
    expect(sigs(fs).slice(0, c.ready)).toEqual(done);
  });
  it('marks a sound that cannot render as failed and RETRY renders it again', async () => {
    const r = await rig();
    let n = 0;
    const deps = (r.fs as unknown as { d: FactoryDeps }).d;
    const real = deps.render;
    deps.render = (p, o) => (++n === 2 ? Promise.reject(new Error('engine hiccup')) : real(p, o));
    r.fs.instrument = 'clap';
    r.fs.count = 4;
    r.fs.diversity = 0;
    await r.fs.generate();
    const failed = r.fs.sounds.filter((s) => s.status === 'failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]!.error).toBe('engine hiccup');
    await r.fs.retry();
    expect(r.fs.counts().ready).toBe(4);
    expect(r.fs.sounds.every((s) => !s.error)).toBe(true);
  });
  it('REGENERATE draws the selected sounds again; CLEAR keeps favourites unless asked', async () => {
    const { fs } = await rig();
    fs.instrument = 'snare';
    fs.count = 6;
    fs.diversity = 0;
    await fs.generate();
    const before = fs.sounds.map((s) => s.candidate.key);
    fs.select('snare-2', true);
    fs.select('snare-5', true);
    fs.keep('snare-5', true);
    await fs.regenerateSelected();
    const after = fs.sounds.map((s) => s.candidate.key);
    expect(after.filter((k, i) => k !== before[i])).toHaveLength(2);
    expect(fs.byId('snare-2')!.draw).toBe(1);
    expect(fs.byId('snare-2')!.selected).toBe(true);
    expect(fs.byId('snare-5')!.keep).toBe(false);
    expect(fs.counts().ready).toBe(6);
    fs.favourite('snare-3', true);
    fs.clear();
    expect(fs.sounds.map((s) => s.id)).toEqual(['snare-3']);
    fs.clear(true);
    expect(fs.sounds).toEqual([]);
    // numbering starts again after CLEAR ALL
    await fs.generate();
    expect(fs.sounds[0]!.serial).toBe(1);
  });
});

describe('selection, sorting and filtering', () => {
  it('sorts by every key, pitchless sounds last, and filters', async () => {
    const { fs } = await rig({ seedText: 'sort-me' });
    fs.instrument = 'mixed';
    fs.count = 30;
    fs.diversity = 0;
    await fs.generate();
    const key = (k: string, s: FactorySound) => {
      const i = s.info!;
      return k === 'duration' ? i.seconds : k === 'brightness' ? i.centroid : k === 'tonality' ? i.tonality : k === 'loudness' ? 20 * Math.log10(i.rms) : k === 'pitch' ? i.pitch.hz : s.order;
    };
    for (const k of ['order', 'duration', 'brightness', 'tonality', 'loudness'] as const) {
      fs.setView({ sort: k, desc: false });
      const asc = fs.visible().map((s) => key(k, s) as number);
      expect(asc).toEqual([...asc].sort((a, b) => a - b));
      fs.setView({ desc: true });
      const desc = fs.visible().map((s) => key(k, s) as number);
      expect(desc).toEqual([...desc].sort((a, b) => b - a));
    }
    fs.setView({ sort: 'pitch', desc: false });
    const p = fs.visible().map((s) => s.info!.pitch.hz);
    const firstNull = p.findIndex((x) => x === null);
    expect(firstNull).toBeGreaterThan(0);
    expect(p.slice(0, firstNull)).toEqual([...p.slice(0, firstNull)].sort((a, b) => a! - b!));
    expect(p.slice(firstNull).every((x) => x === null)).toBe(true);
    fs.setView({ desc: true });
    expect(fs.visible().map((s) => s.info!.pitch.hz).findIndex((x) => x === null)).toBeGreaterThan(0);
    // similarity to a reference: the reference itself first, then by distance
    const ref = fs.sounds[3]!;
    fs.setView({ sort: 'similarity', desc: false, reference: ref.id });
    const v = fs.visible();
    expect(v[0]!.id).toBe(ref.id);
    const d = v.map((s) => featureDistance(s.info!.features, ref.info!.features));
    expect(d).toEqual([...d].sort((a, b) => a - b));
    // filters
    fs.setView({ sort: 'order', desc: false, reference: null, instrument: 'kick' });
    expect(fs.visible().every((s) => s.instrument === 'kick')).toBe(true);
    expect(fs.visible().length).toBeGreaterThan(0);
    fs.setView({ instrument: 'all' });
    fs.favourite(fs.sounds[0]!.id, true);
    fs.setView({ favourites: true });
    expect(fs.visible().map((s) => s.id)).toEqual([fs.sounds[0]!.id]);
    fs.setView({ favourites: false, selectedOnly: true });
    expect(fs.visible()).toEqual([]);
    fs.select(fs.sounds[4]!.id);
    expect(fs.visible().map((s) => s.id)).toEqual([fs.sounds[4]!.id]);
  });
  it('select all / none / invert act on what is in view, and the quality filter holds failing sounds back until KEEP', async () => {
    const { fs } = await rig();
    fs.instrument = 'kick';
    fs.count = 8;
    fs.diversity = 0;
    await fs.generate();
    // make one sound fail: a silent one
    const bad = fs.sounds[2]!;
    bad.info!.flags = [{ id: 'silent', severity: 'fail', text: 'SILENT' }];
    expect(fs.selectVisible(true)).toBe(7);
    expect(bad.selected).toBe(false);
    fs.selectVisible(false);
    expect(fs.selected).toHaveLength(0);
    fs.invertVisible();
    expect(fs.selected).toHaveLength(7);
    fs.selectVisible(false);
    // filter by quality
    fs.setView({ qc: 'flagged' });
    const flagged = fs.sounds.filter((s) => statusOf(s) !== 'ok').map((s) => s.id);
    expect(flagged).toContain(bad.id);
    expect(fs.visible().map((s) => s.id)).toEqual(flagged);
    fs.setView({ qc: 'passing' });
    expect(fs.visible()).toHaveLength(8 - flagged.length);
    expect(fs.visible().every((s) => !flagged.includes(s.id))).toBe(true);
    // KEEP overrides, so does switching the filter off
    fs.keep(bad.id);
    fs.setView({ qc: 'all' });
    expect(fs.selectVisible(true)).toBe(8);
    fs.keep(bad.id, false);
    expect(fs.exportable().blocked.map((s) => s.id)).toEqual([bad.id]);
    fs.setQcStrict(false);
    expect(fs.exportable().blocked).toEqual([]);
    expect(fs.exportable().ok).toHaveLength(8);
    // a warning never holds anything back
    bad.info!.flags = [{ id: 'low', severity: 'warn', text: 'LOW' }];
    fs.setQcStrict(true);
    expect(exportable([bad], true).ok).toEqual([bad]);
  });
  it('flags near-duplicates across the collection and unflags them when the original is cleared', async () => {
    const { fs } = await rig();
    fs.instrument = 'kick';
    fs.count = 3;
    fs.diversity = 0;
    fs.variation = 0;
    await fs.generate();
    // two identical sounds are duplicates of each other
    fs.sounds[2]!.info!.features = fs.sounds[0]!.info!.features.slice();
    fs.markDuplicates();
    expect(fs.sounds[2]!.dupOf).toBe(fs.sounds[0]!.id);
    expect(fs.sounds[0]!.dupOf).toBeUndefined();
    fs.setView({ qc: 'flagged' });
    expect(fs.visible().map((s) => s.id)).toContain(fs.sounds[2]!.id);
    fs.sounds[2]!.info!.features = fs.sounds[2]!.info!.features.map((x, i) => (i === 0 ? x : 1 - x));
    fs.markDuplicates();
    expect(fs.sounds[2]!.dupOf).toBeUndefined();
  });
});

describe('auditioning and using sounds without touching the project', () => {
  it('plays audio rendered by the engine and caches a few', async () => {
    const { fs, played } = await rig();
    fs.instrument = 'kick';
    fs.count = 8;
    fs.diversity = 0;
    await fs.generate();
    const renders = fs.renders;
    await fs.audition('kick-1');
    expect(played).toHaveLength(1);
    const a = played[0]!;
    expect(a).toHaveLength(2);
    expect(a[0]!.length).toBeGreaterThan(441);
    expect(a[0]!.every(Number.isFinite)).toBe(true);
    expect(Math.max(...a[0]!.map(Math.abs))).toBeGreaterThan(0.01);
    expect(fs.renders).toBe(renders + 1);
    await fs.audition('kick-1');
    expect(fs.renders).toBe(renders + 1);
    // the audition is the sound that was measured
    expect(Math.max(...a[0]!.map(Math.abs), ...a[1]!.map(Math.abs))).toBeCloseTo(fs.byId('kick-1')!.info!.peak, 4);
    for (let i = 1; i <= 8; i++) await fs.audition('kick-' + i);
    expect((fs as unknown as { audio: Map<string, unknown> }).audio.size).toBeLessThanOrEqual(6);
    fs.clear(true);
    expect((fs as unknown as { audio: Map<string, unknown> }).audio.size).toBe(0);
  });
  it('leaves the project, the kit and the history exactly as they were until SEND TO KIT', async () => {
    const { fs, project, applied } = await rig();
    const snapshot = serialize(project);
    fs.instrument = 'mixed';
    fs.count = 10;
    await fs.generate();
    await fs.audition(fs.sounds[0]!.id);
    fs.select(fs.sounds[1]!.id);
    fs.favourite(fs.sounds[2]!.id);
    await fs.regenerateSelected();
    await fs.exportPack();
    expect(serialize(project)).toBe(snapshot);
    expect(applied).toEqual([]);
    // SEND TO KIT is the one step that writes, and goes through the app's undoable apply
    const k = fs.sounds.find((s) => s.instrument === 'kick')!;
    fs.sendToKit(k.id);
    fs.sendToKit(k.id, 2);
    expect(applied).toHaveLength(2);
    expect(applied[0]!.voice).toBe(0);
    expect(applied[1]!.voice).toBe(2);
    expect(serialize(project)).toBe(snapshot);
  });
  it('writes a sound into the kit the way DISCOVER does: the voice, locks respected', async () => {
    const { fs, project } = await rig();
    fs.instrument = 'kick';
    fs.count = 1;
    await fs.generate();
    const c = fs.sounds[0]!.candidate;
    const lockedPar = voiceKeys(0).coarse!;
    const r = applyToKit(project.kit.synth, 0, c, { params: [lockedPar] });
    expect(r.kit.params[lockedPar]).toBe(project.kit.synth.params[lockedPar]);
    expect(r.kit.params[voiceKeys(0).decay!]).toBe(c.values.decay);
  });
  it('saves selected sounds to the library, the format SOUND > DISCOVER reads', async () => {
    const { fs } = await rig();
    fs.instrument = 'ltom';
    fs.count = 3;
    await fs.generate();
    expect(fs.saveToLibrary(fs.sounds)).toBe(3);
    const lib = fs.library.list();
    expect(lib).toHaveLength(3);
    expect(lib[0]!.name).toMatch(/^LTOM 001/);
    const copy = new SoundLibrary(memoryStore());
    expect(copy.import(fs.library.export()).added).toHaveLength(3);
  });
});

describe('the sample pack', () => {
  async function made(opts: { instrument?: 'mixed' | 'kick' | 'snare'; count?: number } = {}) {
    const r = await rig({ seedText: 'pack-test' });
    r.fs.instrument = opts.instrument ?? 'mixed';
    r.fs.count = opts.count ?? 12;
    r.fs.diversity = 0;
    await r.fs.generate();
    return r;
  }
  const open = async (data: Uint8Array) => {
    const entries = await readZip(data);
    const byName = new Map(entries.map((e) => [e.name, e.data]));
    const manifest = JSON.parse(new TextDecoder().decode(byName.get('pack.json')!)) as PackManifest;
    return { entries, byName, manifest, wavs: entries.filter((e) => e.name.endsWith('.wav')) };
  };

  it('writes valid WAVs in instrument folders with the names asked for', async () => {
    const { fs, delivered } = await made();
    fs.selectMany(fs.sounds);
    fs.pack.format = 'pcm24';
    await fs.exportPack();
    const { wavs, manifest } = await open(delivered[0]!.data);
    expect(wavs).toHaveLength(fs.exportable().ok.length);
    for (const w of wavs) {
      const [folder, file] = w.name.split('/');
      expect(Object.values(INSTRUMENT_SPECS).map((s) => s.folder)).toContain(folder);
      expect(file).toMatch(/^CLATTER_(KICK|SNARE|CLAP|CHAT|OHAT|LTOM|HTOM|CYMBAL|PERC|FX)_[A-Za-z0-9]+_\d{3}\.wav$/);
      const d = decodeWav(w.data);
      expect(d.rate).toBe(44100);
      expect(d.bits).toBe(24);
      expect(d.channels).toBe(2);
      expect(d.frames).toBeGreaterThan(441);
      const peak = Math.max(...d.channelData.map((c) => c.reduce((m, v) => Math.max(m, Math.abs(v)), 0)));
      // normalised to -1 dBFS
      expect(peak).toBeGreaterThan(0.88);
      expect(peak).toBeLessThan(0.9);
      expect(d.channelData.every((c) => c.every(Number.isFinite))).toBe(true);
    }
    expect(manifest.sounds.flatMap((s) => s.files.map((f) => f.file)).sort()).toEqual(wavs.map((w) => w.name).sort());
  });
  it('puts a note in the name only for a reliable pitch, a word otherwise', async () => {
    const { fs, delivered } = await made({ count: 20 });
    fs.selectMany(fs.sounds);
    await fs.exportPack();
    const { manifest } = await open(delivered[0]!.data);
    let notes = 0;
    for (const s of manifest.sounds) {
      const file = s.files[0]!.file.split('/')[1]!;
      const tag = file.split('_')[2]!;
      const isNote = /^[A-G]s?-?\d$/.test(tag);
      expect(isNote).toBe(s.pitch.reliable);
      if (isNote) {
        notes++;
        expect(s.pitch.note).toMatch(/^[A-G]#?-?\d$/);
        expect(s.pitch.midi).not.toBeNull();
      } else {
        expect(s.pitch.note).toBeNull();
        expect(tag).toBe(s.word);
      }
    }
    expect(notes).toBeGreaterThan(0);
    expect(notes).toBeLessThan(manifest.sounds.length);
    // the examples in the brief
    const fake = (instrument: 'kick' | 'snare' | 'fx', serial: number, pitch: Partial<FactorySound['info'] extends infer I ? (I extends { pitch: infer P } ? P : never) : never>, word: string) => ({ instrument, serial, info: { pitch: { reliable: false, midi: null, ...pitch }, word } }) as unknown as Pick<FactorySound, 'instrument' | 'serial' | 'info'>;
    expect(packFileName(fake('kick', 1, { reliable: true, midi: 36 }, 'DARK'), null)).toBe('CLATTER_KICK_C2_001.wav');
    expect(packFileName(fake('snare', 14, {}, 'NOISY'), null)).toBe('CLATTER_SNARE_NOISY_014.wav');
    expect(packFileName(fake('fx', 8, {}, 'METALLIC'), null)).toBe('CLATTER_FX_METALLIC_008.wav');
    expect(packFileName(fake('kick', 1, { reliable: true, midi: 30 }, 'DARK'), 'wet')).toBe('CLATTER_KICK_Fs1_001_WET.wav');
    expect(serialText(7)).toBe('007');
    expect(serialText(1234)).toBe('1234');
  });
  it('is a valid ZIP: CRCs check, and pack.json is there', async () => {
    const { fs, delivered } = await made({ count: 6 });
    fs.selectMany(fs.sounds);
    await fs.exportPack();
    const f = delivered[0]!;
    expect(f.type).toBe('application/zip');
    expect(f.name).toMatch(/\.zip$/);
    expect([...f.data.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const { entries } = await open(f.data);
    expect(entries.map((e) => e.name)).toContain('pack.json');
    expect(new Set(entries.map((e) => e.name.toLowerCase())).size).toBe(entries.length);
    // flipping a byte in a file is caught by the reader
    const bad = f.data.slice();
    bad[bad.length >> 1]! ^= 0xff;
    await expect(readZip(bad)).rejects.toThrow();
  });
  it('records the seed, character, wildness, variation, diversity and every synthesis parameter', async () => {
    const { fs, delivered, project } = await made({ count: 8 });
    fs.selectMany(fs.sounds);
    await fs.exportPack();
    const { manifest } = await open(delivered[0]!.data);
    expect(manifest.format).toBe('clatter-sample-pack');
    expect(manifest.version).toBe(1);
    expect(manifest.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(manifest.project.name).toBe(project.name);
    expect(manifest.settings).toMatchObject({ format: 'pcm24', processing: 'dry', normalise: true, sampleRate: 44100, bitDepth: 24, tail: { mode: 'auto' } });
    expect(manifest.sounds).toHaveLength(8);
    for (const s of manifest.sounds) {
      const src = fs.byId(s.id)!;
      expect(s.generation).toMatchObject({ seed: seedFromText('pack-test'), seedText: 'pack-test', character: 'electro', wildness: 60, variation: 70, diversity: 0, draw: 0, attempt: 0 });
      expect(s.generation.soundSeed).toBe(src.candidate.origin.seed);
      expect(s.synth.voice).toBe(src.candidate.voice);
      expect(s.synth.parameters).toEqual(src.candidate.values);
      const keys = voiceKeys(s.synth.voice);
      for (const [k, v] of Object.entries(s.synth.parameters)) expect(s.synth.par[keys[k as keyof typeof keys]!]).toBe(v);
      expect(s.quality.status).toMatch(/ok|warn|fail/);
      expect(s.measured.peak).toBeCloseTo(src.info!.peak, 4);
      expect(s.files[0]).toMatchObject({ sampleRate: 44100, bitDepth: 24, channels: 2 });
    }
  });
  it('keeps the exporter choices: bit depth, normalisation, DRY / WET / both, tail', async () => {
    const { fs, delivered } = await made({ instrument: 'kick', count: 2 });
    fs.selectMany(fs.sounds);
    const peakOf = (d: Uint8Array) => {
      const w = decodeWav(d);
      return { w, peak: Math.max(...w.channelData.map((c) => c.reduce((m, v) => Math.max(m, Math.abs(v)), 0))) };
    };
    fs.pack = { ...fs.pack, format: 'pcm16', normalise: false, processing: 'dry', tail: { mode: 'custom', seconds: 0.5 } };
    await fs.exportPack();
    let o = await open(delivered.at(-1)!.data);
    let w = peakOf(o.wavs[0]!.data);
    expect(w.w.bits).toBe(16);
    expect(w.w.frames).toBe(Math.round(0.5 * 44100));
    expect(w.peak).toBeLessThan(0.6);
    expect(o.manifest.settings.normalisedTo).toBeNull();
    fs.pack = { ...fs.pack, format: 'float32', normalise: true, tail: { mode: 'auto', seconds: 2 }, processing: 'both' };
    await fs.exportPack();
    o = await open(delivered.at(-1)!.data);
    expect(o.wavs).toHaveLength(4);
    expect(o.wavs.map((x) => x.name).filter((n) => /_DRY\.wav$/.test(n))).toHaveLength(2);
    expect(o.wavs.map((x) => x.name).filter((n) => /_WET\.wav$/.test(n))).toHaveLength(2);
    w = peakOf(o.wavs[0]!.data);
    expect(w.w.format).toBe('float32');
    expect(w.peak).toBeCloseTo(0.8912509, 3);
  });
  it('holds back sounds that fail the quality filter, unless they were accepted or the filter is off', async () => {
    const { fs, delivered } = await made({ instrument: 'kick', count: 3 });
    fs.selectMany(fs.sounds);
    fs.sounds[1]!.info!.flags = [{ id: 'invalid', severity: 'fail', text: 'INVALID' }];
    fs.select(fs.sounds[1]!.id, true);
    await fs.exportPack();
    let o = await open(delivered.at(-1)!.data);
    expect(o.wavs).toHaveLength(2);
    fs.keep(fs.sounds[1]!.id, true);
    await fs.exportPack();
    o = await open(delivered.at(-1)!.data);
    expect(o.wavs).toHaveLength(3);
    expect(o.manifest.sounds.find((s) => s.id === 'kick-2')!.quality.acceptedAnyway).toBe(true);
  });
  it('refuses to export nothing, and says why', async () => {
    const { fs, delivered, notes } = await made({ instrument: 'kick', count: 2 });
    await fs.exportPack();
    expect(delivered).toHaveLength(0);
    expect(notes.at(-1)).toMatch(/SELECT SOME SOUNDS/);
  });
  it('cancels an export and delivers nothing', async () => {
    const r = await made({ instrument: 'snare', count: 6 });
    r.fs.selectMany(r.fs.sounds);
    const ctl = new AbortController();
    let n = 0;
    await expect(
      exportPack(r.project, r.fs.selected, r.fs.pack, { module: lxrModule(), library: r.lib, signal: ctl.signal, yieldToUi: async () => void (++n === 3 && ctl.abort()) }),
    ).rejects.toBeInstanceOf(PackCancelled);
    // through the session: a cancel mid-export is reported and nothing is delivered
    let m = 0;
    const deps = (r.fs as unknown as { d: FactoryDeps }).d;
    deps.runPack = (pr, sounds, options, onProgress, signal) => exportPack(pr, sounds, options, { module: lxrModule(), library: r.lib, onProgress, signal, yieldToUi: async () => void (++m === 2 && r.fs.cancelPack()) });
    await r.fs.exportPack();
    expect(r.delivered).toHaveLength(0);
    expect(r.fs.packState.last).toMatchObject({ ok: false, text: expect.stringMatching(/CANCELLED/) });
    expect(r.fs.packState.running).toBe(false);
  });
  it('never gives two files the same name, and numbers an imported sound that arrives with a taken number', async () => {
    expect(uniqueName(new Set(), 'A.wav')).toBe('A.wav');
    const taken = new Set<string>();
    expect([uniqueName(taken, 'CLATTER_KICK_C2_001.wav'), uniqueName(taken, 'clatter_kick_c2_001.wav'), uniqueName(taken, 'CLATTER_KICK_C2_001.wav')]).toEqual(['CLATTER_KICK_C2_001.wav', 'clatter_kick_c2_001_2.wav', 'CLATTER_KICK_C2_001_3.wav']);
    const { fs, delivered } = await made({ instrument: 'kick', count: 4 });
    fs.selectMany(fs.sounds);
    await fs.exportPack();
    // importing the pack into the same collection: every sound arrives again, with new numbers
    await fs.importPack(delivered[0]!.data);
    expect(fs.sounds).toHaveLength(8);
    expect(fs.sounds.map((s) => s.serial)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(new Set(fs.sounds.map((s) => s.id)).size).toBe(8);
    fs.selectMany(fs.sounds);
    await fs.exportPack();
    const { wavs } = await open(delivered[1]!.data);
    expect(wavs).toHaveLength(8);
    expect(new Set(wavs.map((w) => w.name.toLowerCase())).size).toBe(8);
  });
  it('round-trips: a pack imports as the same sounds, re-rendered to the same audio', async () => {
    const a = await made({ count: 10 });
    a.fs.favourite(a.fs.sounds[2]!.id, true);
    a.fs.selectMany(a.fs.sounds);
    await a.fs.exportPack();
    const zip = a.delivered[0]!.data;
    const b = await rig();
    await b.fs.importPack(zip);
    expect(b.fs.sounds).toHaveLength(a.fs.exportable().ok.length);
    for (const s of b.fs.sounds) {
      const orig = a.fs.byId(s.id)!;
      expect(s.imported).toBe(true);
      expect(s.status).toBe('ready');
      expect(s.candidate.voice).toBe(orig.candidate.voice);
      expect(s.candidate.values).toEqual(orig.candidate.values);
      expect(s.candidate.lfo).toBe(orig.candidate.lfo);
      expect(s.info!.peak).toBeCloseTo(orig.info!.peak, 6);
      expect(s.info!.features).toEqual(orig.info!.features);
      expect(s.favourite).toBe(orig.favourite);
      expect(s.made).toMatchObject({ character: 'electro', wildness: 60, seed: orig.made.seed });
    }
    // and exports again to the same files
    b.fs.selectMany(b.fs.sounds);
    await b.fs.exportPack();
    const x = await open(zip);
    const y = await open(b.delivered[0]!.data);
    expect(y.wavs.map((w) => w.name)).toEqual(x.wavs.map((w) => w.name));
    for (const [i, w] of y.wavs.entries()) expect(w.data).toEqual(x.wavs[i]!.data);
  });
  it('reads a bare pack.json, rejects anything else, and skips sounds it cannot make again', async () => {
    const { fs, delivered } = await made({ instrument: 'kick', count: 2 });
    fs.selectMany(fs.sounds);
    await fs.exportPack();
    const { byName, manifest } = await open(delivered[0]!.data);
    const json = byName.get('pack.json')!;
    expect((await readPack(json)).sounds).toHaveLength(2);
    expect(() => parsePackManifest('nope')).toThrow(/NOT JSON/);
    expect(() => parsePackManifest('{"format":"clatter-project"}')).toThrow(/NOT A CLATTER SAMPLE PACK/);
    expect(() => parsePackManifest(JSON.stringify({ ...manifest, version: 99 }))).toThrow(/NEWER/);
    const odd = clone(manifest);
    odd.sounds[0]!.synth.voice = 9;
    odd.sounds[1]!.synth.parameters = { decay: 70, notAParameter: 5, wave: 999 } as never;
    const r = parsePackManifest(JSON.stringify(odd));
    expect(r.skipped).toBe(1);
    expect(r.sounds).toHaveLength(1);
    expect(r.sounds[0]!.candidate.values).toEqual({ decay: 70, wave: 127 });
    await expect(readPack(new Uint8Array([0x50, 0x4b, 3, 4, 0, 0]))).rejects.toThrow();
  });
});

describe('the engine is the real one', () => {
  it('renders different sounds for different parameters and the same sound again', async () => {
    const { fs, project, lib } = await rig();
    fs.instrument = 'kick';
    fs.count = 2;
    fs.diversity = 0;
    await fs.generate();
    const render = (i: number) => renderKitHit(lxrModule(), stageProject(project, 'kick', fs.sounds[i]!.candidate), lib, STAGE_TRACK, { vel: 110, slot: null, wet: false, tail: 'auto' });
    const a1 = await render(0);
    const a2 = await render(0);
    const b = await render(1);
    expect(a1.audio[0]).toEqual(a2.audio[0]);
    expect(a1.audio[0]!.length === b.audio[0]!.length && a1.audio[0]!.every((v, k) => v === b.audio[0]![k])).toBe(false);
    expect(a1.rate).toBe(44100);
  });
});
