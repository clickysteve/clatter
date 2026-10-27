/**
 * SOUND DISCOVERY: candidates from the existing generator and mutation, audition through the real
 * LXR engine, A/B, applying (one undo step), the sound library, seeds and pitch metadata.
 */
import { describe, expect, it } from 'vitest';
import { bundledLibrary, lxrModule, presetProject } from './helpers';
import { App } from '../src/app/app';
import { DiscoverSession, retarget, type DiscoverDeps } from '../src/app/discover';
import { analyseTarget } from '../src/analysis/trackPitch';
import { analysePitch } from '../src/analysis/pitch';
import { ENGINE_RATE } from '../src/audio/engine';
import { renderHit } from '../src/audio/render';
import { defaultProject } from '../src/model/defaults';
import { parseProject, repairProject, serialize } from '../src/model/project';
import { clone, type Project, type Track } from '../src/model/types';
import { seedFromText, type SeedValue } from '../src/rhythm/seed';
import {
  applyToKit,
  archetypeOf,
  DISCOVER_COUNT,
  extrasOf,
  generateBatch,
  generateCandidate,
  mutateCandidate,
  pitchBadge,
  projectWith,
  reproduce,
  soundWithExtras,
  voiceValues,
  type Candidate,
  type DiscoverOptions,
} from '../src/sound/discover';
import { PAR } from '../src/sound/lxrParamIds';
import { voiceKeys, voiceRolesOf } from '../src/sound/kitgen';
import { memoryStore, SoundLibrary, SOUND_FORMAT } from '../src/sound/soundLibrary';

const seed = (t: string): SeedValue => ({ seed: seedFromText(t), text: t });
const stable = (v: unknown): string => JSON.stringify(v);

async function rig(preset = 'machine-room') {
  const lib = await bundledLibrary();
  const p = await presetProject(preset, lib);
  const track = (name: string): Track => p.tracks.find((x) => x.name === name)!;
  const voiceOf = (t: Track) => (t.sound.trigger >= 5 ? 5 : t.sound.trigger);
  return { lib, p, track, voiceOf };
}

const optsFor = (p: Project, voice: number, over: Partial<DiscoverOptions> = {}): DiscoverOptions => ({ voice, archetype: archetypeOf(p, voice), character: 'electro', wildness: 0.6, locks: p.soundLocks, ...over });

/** a session over a project, with the real engine for rendering and a recording player */
async function session(trackName = 'KICK', opts: { check?: boolean } = {}) {
  const { lib, p, track } = await rig();
  let selected = track(trackName);
  const played: Float32Array[][] = [];
  const applied: { c: Candidate; extras: boolean }[] = [];
  let seedN = 0;
  const changes = { n: 0 };
  const deps: DiscoverDeps & { stops: number; rendersOf: string[] } = {
    stops: 0,
    rendersOf: [],
    project: () => p,
    track: () => selected,
    flavour: () => 'machine',
    drawSeed: () => seed(`test-seed-${seedN++ === 0 ? 'one' : 'two'}`),
    render: (pr, id) => renderHit(lxrModule(), pr, lib, id, 110, 3),
    play: (a) => void played.push(a),
    stop: () => void deps.stops++,
    analyse: (pr, target) => analyseTarget(lxrModule(), pr, lib, target),
    apply: (c, extras) => {
      applied.push({ c, extras });
      return { locked: 0 };
    },
    changed: () => void changes.n++,
    say: () => undefined,
  };
  if (opts.check) deps.check = async (kit) => kit;
  const s = new DiscoverSession(deps, new SoundLibrary(memoryStore()));
  return { s, p, lib, deps, played, applied, changes, select: (n: string) => (selected = track(n)), track };
}

describe('candidate generation', () => {
  it('makes eight candidates for the voice, from a seed, character and wildness', async () => {
    const { p, track, voiceOf } = await rig();
    const v = voiceOf(track('KICK'));
    const batch = generateBatch(p.kit.synth, seed('velvet-orbit'), optsFor(p, v)) as Candidate[];
    expect(batch).toHaveLength(DISCOVER_COUNT);
    for (const [i, c] of batch.entries()) {
      expect(c.voice).toBe(v);
      expect(c.origin).toMatchObject({ kind: 'generated', index: i, draw: 0, character: 'electro', wildness: 60, seedText: 'velvet-orbit', archetype: 'kick' });
      expect(Object.keys(c.values).length).toBeGreaterThan(20);
      for (const x of Object.values(c.values)) expect(x).toBeGreaterThanOrEqual(0), expect(x).toBeLessThanOrEqual(127);
    }
    // eight different sounds
    expect(new Set(batch.map((c) => c.key)).size).toBe(DISCOVER_COUNT);
  });

  it('is a function of its seed: the same inputs make the same candidates, another seed other ones', async () => {
    const { p, track, voiceOf } = await rig();
    const v = voiceOf(track('SNARE'));
    const a = generateBatch(p.kit.synth, seed('velvet-orbit'), optsFor(p, v));
    const b = generateBatch(p.kit.synth, seed('velvet-orbit'), optsFor(p, v));
    expect(stable(a)).toBe(stable(b));
    const c = generateBatch(p.kit.synth, seed('silver-moth'), optsFor(p, v));
    expect(c.map((x) => x!.key)).not.toEqual(a.map((x) => x!.key));
    // a numeric seed is just as reproducible
    expect(stable(generateBatch(p.kit.synth, { seed: 42 }, optsFor(p, v)))).toBe(stable(generateBatch(p.kit.synth, { seed: 42 }, optsFor(p, v))));
  });

  it('uses the existing generator: wildness 1 is the kit generator’s own design of the voice', async () => {
    const { p, track, voiceOf } = await rig();
    const { designVoice } = await import('../src/sound/kitgen');
    const { Rng } = await import('../src/rhythm/rng');
    const { candidateSeed } = await import('../src/sound/discover');
    const v = voiceOf(track('KICK'));
    const s = seed('velvet-orbit');
    const c = generateCandidate(p.kit.synth, s, 3, 0, optsFor(p, v, { wildness: 1 }));
    const rng = new Rng(candidateSeed(s.seed, v, 3, 0));
    const d = designVoice(v, 'kick', 'electro', rng);
    for (const [k, x] of Object.entries(d.values)) if (voiceKeys(v)[k as keyof ReturnType<typeof voiceKeys>] !== undefined && !k.startsWith('lfo')) expect(c.values[k as keyof typeof c.values]).toBe(x);
  });

  it('wildness sets how far a candidate goes from the current sound', async () => {
    const { p, track, voiceOf } = await rig();
    const v = voiceOf(track('KICK'));
    const cur = voiceValues(p.kit.synth, v);
    const dist = (w: number) => {
      const batch = generateBatch(p.kit.synth, seed('velvet-orbit'), optsFor(p, v, { wildness: w })) as Candidate[];
      let sum = 0;
      for (const c of batch) for (const [k, x] of Object.entries(c.values)) sum += Math.abs(x - (cur[k as keyof typeof cur] ?? 0));
      return sum;
    };
    expect(dist(0.1)).toBeLessThan(dist(0.5));
    expect(dist(0.5)).toBeLessThan(dist(1));
  });

  it('character leans the candidates: dub rings longer than glitch', async () => {
    const { p, track, voiceOf } = await rig();
    const v = voiceOf(track('KICK'));
    const decay = (character: DiscoverOptions['character']) => {
      const batch = generateBatch(p.kit.synth, seed('velvet-orbit'), optsFor(p, v, { character, wildness: 1 })) as Candidate[];
      return batch.reduce((a, c) => a + (c.values.decay ?? 0), 0) / batch.length;
    };
    expect(decay('dub')).toBeGreaterThan(decay('glitch'));
  });

  it('parameter locks hold in every candidate', async () => {
    const { p, track, voiceOf } = await rig();
    const v = voiceOf(track('KICK'));
    const par = voiceKeys(v).decay!;
    const locks = { voices: [false, false, false, false, false, false], params: [par] };
    const batch = generateBatch(p.kit.synth, seed('velvet-orbit'), optsFor(p, v, { wildness: 1, locks })) as Candidate[];
    for (const c of batch) expect(c.values.decay).toBe(p.kit.synth.params[par]);
  });

  it('a candidate is not made by touching the kit', async () => {
    const { p, track, voiceOf } = await rig();
    const before = stable(p);
    generateBatch(p.kit.synth, seed('velvet-orbit'), optsFor(p, voiceOf(track('KICK'))));
    expect(stable(p)).toBe(before);
  });
});

describe('candidate mutation', () => {
  it('mutates a candidate with the kit mutation, repeatably, without touching the original', async () => {
    const { p, track, voiceOf } = await rig();
    const v = voiceOf(track('KICK'));
    const c = generateCandidate(p.kit.synth, seed('velvet-orbit'), 2, 0, optsFor(p, v));
    const before = stable(c);
    const m = { character: 'electro' as const, wildness: 0.6, locks: p.soundLocks, voiceRoles: voiceRolesOf(p.tracks) };
    const child = mutateCandidate(p.kit.synth, c, m);
    expect(stable(c)).toBe(before);
    expect(child.key).not.toBe(c.key);
    expect(child.origin.lineage).toHaveLength(1);
    expect(stable(mutateCandidate(p.kit.synth, c, m))).toBe(stable(child));
    // and again: a promising candidate can be mutated over and over
    const grand = mutateCandidate(p.kit.synth, child, m);
    expect(grand.origin.lineage).toHaveLength(2);
    expect(grand.key).not.toBe(child.key);
  });

  it('wildness sets how far MUTATE moves', async () => {
    const { p, track, voiceOf } = await rig();
    const v = voiceOf(track('KICK'));
    const c = generateCandidate(p.kit.synth, seed('velvet-orbit'), 2, 0, optsFor(p, v));
    const move = (w: number) => {
      let sum = 0;
      for (let i = 0; i < 12; i++) {
        const ch = mutateCandidate(p.kit.synth, c, { character: 'electro', wildness: w, locks: p.soundLocks, voiceRoles: voiceRolesOf(p.tracks), seed: 100 + i });
        for (const [k, x] of Object.entries(ch.values)) sum += Math.abs(x - (c.values[k as keyof typeof c.values] ?? 0));
      }
      return sum;
    };
    expect(move(0.1)).toBeLessThan(move(1));
  });

  it('only the voice changes, never another voice', async () => {
    const { p, track, voiceOf } = await rig();
    const v = voiceOf(track('KICK'));
    const c = generateCandidate(p.kit.synth, seed('velvet-orbit'), 0, 0, optsFor(p, v));
    const child = mutateCandidate(p.kit.synth, c, { character: 'electro', wildness: 1, locks: p.soundLocks, voiceRoles: voiceRolesOf(p.tracks) });
    const kit = applyToKit(p.kit.synth, v, child).kit;
    const own = new Set(Object.values(voiceKeys(v)));
    kit.params.forEach((x, i) => {
      if (!own.has(i)) expect(x).toBe(p.kit.synth.params[i]);
    });
  });

  it('a candidate (generated or mutated) can be made again from what it remembers', async () => {
    const { p, track, voiceOf } = await rig();
    const v = voiceOf(track('SNARE'));
    const roles = voiceRolesOf(p.tracks);
    const c0 = generateCandidate(p.kit.synth, seed('silver-moth'), 5, 2, optsFor(p, v, { character: 'industrial', wildness: 0.8 }));
    expect(stable(reproduce(p.kit.synth, c0.origin, p.soundLocks, roles))).toBe(stable(c0));
    let c = c0;
    for (let i = 0; i < 3; i++) c = mutateCandidate(p.kit.synth, c, { character: 'industrial', wildness: 0.4 + i / 10, locks: p.soundLocks, voiceRoles: roles });
    expect(stable(reproduce(p.kit.synth, c.origin, p.soundLocks, roles))).toBe(stable(c));
  });
});

describe('the session is non-destructive', () => {
  it('DISCOVER, NEW, MUTATE, HOLD, VS, audition and A/B leave the project exactly as it was', async () => {
    const { s, p, applied } = await session();
    const before = stable(p);
    await s.discover();
    expect(s.count).toBe(DISCOVER_COUNT);
    await s.auditionSlot(2);
    await s.regenerate(2);
    await s.mutate();
    s.hold(1);
    s.setCompare(4);
    await s.audition('A');
    await s.toggle();
    s.stop();
    expect(stable(p)).toBe(before);
    expect(applied).toHaveLength(0);
  });

  it('projectWith shares nothing it writes: the live project and its kit are untouched', async () => {
    const { p, track, voiceOf } = await rig();
    const before = stable(p);
    const k = track('KICK');
    const c = generateCandidate(p.kit.synth, seed('velvet-orbit'), 0, 0, optsFor(p, voiceOf(k), { wildness: 1 }));
    const q = projectWith(p, k.id, c, true);
    expect(stable(p)).toBe(before);
    expect(q.kit.synth.params).not.toEqual(p.kit.synth.params);
    expect(q.kit.synth).not.toBe(p.kit.synth);
  });

  it('a sample track has no LXR voice to discover', async () => {
    const { s, p, track } = await session();
    const k = track('KICK');
    k.sound.mode = 'sample';
    expect(s.voice).toBe(-1);
    await s.discover();
    expect(s.count).toBe(0);
    k.sound.mode = 'synth';
    void p;
  });

  it('candidates are kept per voice', async () => {
    const { s, select } = await session();
    await s.discover();
    const kickBatch = s.state.slots.map((x) => x.cand!.key);
    select('SNARE');
    expect(s.count).toBe(0);
    await s.discover();
    select('KICK');
    expect(s.state.slots.map((x) => x.cand!.key)).toEqual(kickBatch);
  });

  it('held candidates survive another DISCOVER 8; the rest are replaced', async () => {
    const { s } = await session();
    await s.discover();
    const first = s.state.slots.map((x) => x.cand!.key);
    s.hold(3);
    await s.discover();
    const second = s.state.slots.map((x) => x.cand!.key);
    expect(second[3]).toBe(first[3]);
    expect(second.filter((k, i) => k !== first[i])).toHaveLength(7);
  });

  it('NEW draws one slot again from the same seed and BACK returns it', async () => {
    const { s } = await session();
    await s.discover();
    const keys = s.state.slots.map((x) => x.cand!.key);
    await s.regenerate(5);
    const now = s.state.slots.map((x) => x.cand!.key);
    expect(now[5]).not.toBe(keys[5]);
    expect(now.filter((k, i) => i !== 5)).toEqual(keys.filter((_, i) => i !== 5));
    expect(s.state.slots[5]!.cand!.origin.draw).toBe(1);
    expect(s.back(5)).toBe(true);
    expect(s.state.slots[5]!.cand!.key).toBe(keys[5]);
  });

  it('MUTATE replaces the slot with the child, keeps the parent one BACK away, and can repeat', async () => {
    const { s } = await session();
    await s.discover();
    s.select(1);
    const parent = s.selected!.key;
    await s.mutate();
    const child = s.selected!;
    expect(child.key).not.toBe(parent);
    expect(child.origin.lineage).toHaveLength(1);
    await s.mutate();
    expect(s.selected!.origin.lineage).toHaveLength(2);
    s.back(1);
    s.back(1);
    expect(s.selected!.key).toBe(parent);
  });

  it('the engine check, when there is one, decides what a candidate is', async () => {
    const { s } = await session('KICK', { check: true });
    await s.discover();
    expect(s.count).toBe(DISCOVER_COUNT);
  });
});

describe('audition through the real engine', () => {
  it('renders the candidate with the LXR engine and plays exactly that audio', async () => {
    const { s, played } = await session();
    await s.discover();
    await s.auditionSlot(0);
    expect(played).toHaveLength(1);
    const [l, r] = played[0]!;
    expect(l!.length).toBeGreaterThan(2000);
    expect(l!.length).toBe(r!.length);
    let peak = 0;
    for (const x of l!) peak = Math.max(peak, Math.abs(x));
    expect(peak).toBeGreaterThan(0.01);
    expect(Number.isFinite(peak)).toBe(true);
  });

  it('the candidate sounds like the candidate: it is the offline render of the project with it in place', async () => {
    const { s, p, lib, played, track } = await session();
    await s.discover();
    await s.auditionSlot(4);
    const c = s.candidate(4)!;
    const direct = await renderHit(lxrModule(), projectWith(p, track('KICK').id, c, true), lib, track('KICK').id, 110, 3);
    expect(played[0]![0]!.length).toBe(direct[0]!.length);
    expect(Array.from(played[0]![0]!.slice(0, 2000))).toEqual(Array.from(direct[0]!.slice(0, 2000)));
  });

  it('different candidates sound different; the original is its own sound', async () => {
    const { s, played } = await session();
    await s.discover();
    await s.auditionSlot(0);
    await s.auditionSlot(1);
    await s.audition('A');
    const eq = (a: Float32Array[], b: Float32Array[]) => a[0]!.length === b[0]!.length && a[0]!.every((x, i) => x === b[0]![i]);
    expect(eq(played[0]!, played[1]!)).toBe(false);
    expect(eq(played[0]!, played[2]!)).toBe(false);
  });

  it('the running sequencer is not involved: auditioning sends nothing to the live engine', async () => {
    const app = new App();
    app.module = lxrModule();
    const sent: unknown[] = [];
    app.host.send = (m) => void sent.push(m);
    const before = stable(app.project);
    await app.discover.discover();
    // rendering happens offline and the player has no browser audio here, which the session reports instead of failing
    await app.discover.auditionSlot(1);
    await app.discover.audition('A');
    expect(app.discover.renders).toBe(2);
    expect(sent).toHaveLength(0); // nothing reached the live engine
    expect(stable(app.project)).toBe(before);
  });

  it('only the last of several quick auditions is played; the one before it is cancelled', async () => {
    const { s, played } = await session();
    await s.discover();
    await s.prepare();
    const first = s.auditionSlot(0);
    const second = s.auditionSlot(1);
    await Promise.all([first, second]);
    expect(played).toHaveLength(1);
    expect(s.playing).toEqual({ side: 'B', label: s.candidate(1)!.name });
  });

  it('stop cancels a pending audition', async () => {
    const { s, played, deps } = await session();
    await s.discover();
    const p = s.auditionSlot(0);
    s.stop();
    await p;
    expect(played).toHaveLength(0);
    expect(deps.stops).toBeGreaterThan(0);
    expect(s.playing).toBeNull();
  });
});

describe('A/B comparison', () => {
  it('switches between the original and the selected candidate, always naming what is heard', async () => {
    const { s, played } = await session();
    await s.discover();
    s.select(2);
    await s.audition('A');
    expect(s.playing).toEqual({ side: 'A', label: 'ORIGINAL' });
    await s.toggle();
    expect(s.playing).toEqual({ side: 'B', label: s.candidate(2)!.name });
    await s.toggle();
    expect(s.playing?.side).toBe('A');
    expect(played).toHaveLength(3);
    expect(played[0]![0]!.length === played[1]![0]!.length && played[0]![0]!.every((x, i) => x === played[1]![0]![i])).toBe(false);
    // the same side is the same audio
    expect(played[0]![0]!.every((x, i) => x === played[2]![0]![i])).toBe(true);
  });

  it('switching again is instant: both sides are rendered once', async () => {
    const { s } = await session();
    await s.discover();
    s.select(2);
    await s.prepare();
    const n = s.renders;
    for (let i = 0; i < 6; i++) await s.toggle();
    expect(s.renders).toBe(n);
  });

  it('VS compares the selected candidate with another candidate instead of the original', async () => {
    const { s } = await session();
    await s.discover();
    s.select(2);
    s.setCompare(5);
    await s.audition('A');
    expect(s.playing).toEqual({ side: 'A', label: s.candidate(5)!.name });
    s.setCompare(null);
    await s.audition('A');
    expect(s.playing!.label).toBe('ORIGINAL');
  });

  it('the original side is the live instrument, whatever is applied later', async () => {
    const { s, p, track } = await session();
    await s.discover();
    await s.audition('A');
    const aBefore = s.renders;
    p.kit.synth.params[voiceKeys(0).decay!] = 99; // the instrument changes (as an apply would)
    await s.audition('A');
    expect(s.renders).toBe(aBefore + 1);
    void track;
  });
});

describe('pitch metadata', () => {
  it('nothing is analysed until asked, and an audition measures what was heard once', async () => {
    const { s } = await session();
    await s.discover();
    expect(s.pitchOf(s.candidate(0))).toBeNull();
    expect(s.pitchText(s.candidate(0))).toBe('—');
    await s.auditionSlot(0);
    await new Promise((r) => setTimeout(r, 400));
    const a = s.pitchOf(s.candidate(0));
    expect(a).not.toBeNull();
    expect(a!.stale).toBe(false);
    expect(s.pitchOf(s.candidate(1))).toBeNull();
  });

  it('a stored result is reused; it goes stale when the sound changes', async () => {
    const { s, p } = await session();
    await s.discover();
    const c = s.candidate(0)!;
    const r1 = await s.analyse(c);
    const r2 = await s.analyse(c);
    expect(r2).toBe(r1);
    p.kit.synth.params[PAR.FX_TYPE] = (p.kit.synth.params[PAR.FX_TYPE] ?? 0) + 1;
    expect(s.pitchOf(c)!.stale).toBe(true);
    expect(s.pitchText(c)).toBe('—');
  });

  it('analyses the candidate, not the original', async () => {
    const { s } = await session();
    await s.discover();
    const c = (await s.analyse(s.candidate(0)))!;
    const o = (await s.analyse(null))!;
    expect(c.fingerprint).not.toBe(o.fingerprint);
  });

  it('PITCH measures the original and each candidate once, then leaves them alone', async () => {
    const { s, deps } = await session();
    await s.discover();
    let n = 0;
    const inner = deps.analyse;
    deps.analyse = (p, t) => (n++, inner(p, t));
    await s.analyseAll();
    expect(n).toBe(DISCOVER_COUNT + 1);
    await s.analyseAll();
    expect(n).toBe(DISCOVER_COUNT + 1);
  });

  it('labels a note only when the analysis trusts one', async () => {
    const rate = ENGINE_RATE;
    const sine = (hz: number) => Float32Array.from({ length: rate }, (_, i) => 0.7 * Math.exp((-2 * i) / rate) * Math.sin((2 * Math.PI * hz * i) / rate));
    const note = pitchBadge(analysePitch(sine(110), rate));
    expect(note.reliable).toBe(true);
    expect(note.text).toMatch(/^A2/);
    // white noise: no note, and it says so
    let x = 12345;
    const noise = Float32Array.from({ length: rate }, (_, i) => ((x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32 - 0.5) * Math.exp((-4 * i) / rate));
    const n = pitchBadge(analysePitch(noise, rate));
    expect(n.reliable).toBe(false);
    expect(n.text).not.toMatch(/[A-G]#?\d/);
    expect(pitchBadge(null)).toEqual({ text: '—', reliable: false });
    expect(pitchBadge(analysePitch(new Float32Array(rate), rate)).text).toBe('SILENT');
  });
});

describe('applying a candidate', () => {
  it('APPLY writes the candidate into the instrument as one undo step; UNDO brings the original back', async () => {
    const app = new App();
    app.project = defaultProject();
    const k = app.project.tracks.find((t) => t.role === 'kick')!;
    app.selectTrack(k.id);
    const v = app.voiceOf(k);
    const original = voiceValues(app.project.kit.synth, v);
    const lfoT = app.project.kit.synth.lfoTarget[v];
    await app.discover.discover();
    app.discover.select(3);
    const c = app.discover.selected!;
    expect(stable(voiceValues(app.project.kit.synth, v))).toBe(stable(original)); // still the original
    const undoDepth = app.history.undoLabel;
    expect(app.discover.apply()).toBe(true);
    expect(app.history.undoLabel).toBe('APPLY CANDIDATE');
    expect(stable(voiceValues(app.project.kit.synth, v))).toBe(stable(c.values));
    expect(app.discover.isLive(c)).toBe(true);
    expect(app.project.discovered![v]).toMatchObject({ name: c.name, origin: { seed: c.origin.seed, index: 3 } });
    app.undo();
    expect(stable(voiceValues(app.project.kit.synth, v))).toBe(stable(original));
    expect(app.project.kit.synth.lfoTarget[v]).toBe(lfoT);
    expect(app.project.discovered?.[v]).toBeUndefined();
    expect(app.history.undoLabel).toBe(undoDepth);
    app.redo();
    expect(stable(voiceValues(app.project.kit.synth, v))).toBe(stable(c.values));
  });

  it('only that voice changes, and only the kit', async () => {
    const app = new App();
    app.project = defaultProject();
    const k = app.project.tracks.find((t) => t.role === 'kick')!;
    app.selectTrack(k.id);
    const before = clone(app.project);
    await app.discover.discover();
    app.discover.select(0);
    app.discover.apply();
    const own = new Set(Object.values(voiceKeys(app.voiceOf(k))));
    app.project.kit.synth.params.forEach((x, i) => {
      if (!own.has(i)) expect(x).toBe(before.kit.synth.params[i]);
    });
    expect(stable(app.project.patterns)).toBe(stable(before.patterns));
    expect(stable(app.project.tracks)).toBe(stable(before.tracks));
  });

  it('locked parameters keep their value', async () => {
    const app = new App();
    app.project = defaultProject();
    const k = app.project.tracks.find((t) => t.role === 'kick')!;
    app.selectTrack(k.id);
    const par = voiceKeys(app.voiceOf(k)).decay!;
    app.project.soundLocks.params.push(par);
    const was = app.project.kit.synth.params[par];
    await app.discover.discover();
    app.discover.select(1);
    app.discover.apply();
    expect(app.project.kit.synth.params[par]).toBe(was);
  });

  it('with modulation and variations from the library, they come with it and UNDO takes them away', async () => {
    const app = new App();
    app.project = defaultProject();
    const k = app.project.tracks.find((t) => t.role === 'kick')!;
    app.selectTrack(k.id);
    const v = app.voiceOf(k);
    k.sound.mod = { sources: { lfo1: { type: 'lfo', wave: 'sine', mode: 'free', hz: 2, div: '1/4', phase: 0, depth: 1, offset: 0, uni: false, retrig: 'hit', width: 0.5, bend: 0, seed: 1 } }, routes: [{ id: 'r1', src: 'lfo1', dst: 'lxr.filter.cutoff', amt: 0.4, pol: 'bi', on: true, lo: -1, hi: 1, smooth: 0 }] };
    k.sound.variations = [{ name: 'PUNCH', params: { [voiceKeys(v).decay!]: 30 } }, null, null, null];
    const lib = app.discover.library;
    const saved = app.discover.saveOriginal('KICK WITH EVERYTHING')!;
    expect(saved.extras?.mod?.routes).toHaveLength(1);
    expect(saved.extras?.variations?.[0]).toMatchObject({ name: 'PUNCH', values: { decay: 30 } });
    // another project state, then load and apply
    delete k.sound.mod;
    k.sound.variations = [null, null, null, null];
    app.discover.load(saved.id);
    app.discover.apply();
    expect(k.sound.mod ?? app.track.sound.mod).toBeTruthy();
    expect(app.track.sound.mod!.routes).toHaveLength(1);
    expect(app.track.sound.variations![0]).toMatchObject({ name: 'PUNCH', params: { [voiceKeys(v).decay!]: 30 } });
    app.undo();
    expect(app.track.sound.mod).toBeUndefined();
    expect(app.track.sound.variations![0]).toBeNull();
    lib.remove(saved.id);
  });
});

describe('the sound library', () => {
  const candidate = async (): Promise<{ c: Candidate; p: Project }> => {
    const { p, track, voiceOf } = await rig();
    return { c: generateCandidate(p.kit.synth, seed('velvet-orbit'), 3, 0, optsFor(p, voiceOf(track('KICK')))), p };
  };

  it('saves a sound with every parameter of the voice and the seed metadata that made it', async () => {
    const { c } = await candidate();
    const lib = new SoundLibrary(memoryStore());
    const s = lib.add(c, 'My kick', { note: 'A1', hz: 55 }, 1);
    expect(s.name).toBe('MY KICK');
    expect(s.values).toEqual(c.values);
    expect(Object.keys(s.values).length).toBe(Object.keys(voiceKeys(c.voice)).length);
    expect(s.origin).toMatchObject({ seed: c.origin.seed, seedText: 'velvet-orbit', index: 3, character: 'electro', wildness: 60 });
    expect(s.pitch).toEqual({ note: 'A1', hz: 55 });
  });

  it('keeps its sounds in storage: save, load, rename, delete', async () => {
    const { c } = await candidate();
    const store = memoryStore();
    const lib = new SoundLibrary(store);
    const a = lib.add(c, 'ONE');
    lib.add(c, 'TWO');
    const again = new SoundLibrary(store);
    expect(again.list().map((s) => s.name)).toEqual(['ONE', 'TWO']);
    expect(stable(again.list()[0]!.values)).toBe(stable(c.values));
    expect(again.rename(again.list()[0]!.id, 'first')).toBe(true);
    expect(again.remove(again.list()[1]!.id)).toBe(true);
    const third = new SoundLibrary(store);
    expect(third.list().map((s) => s.name)).toEqual(['FIRST']);
    expect(lib.get(a.id)!.name).toBe('ONE');
  });

  it('exports and imports a file; damaged files are refused, damaged sounds skipped', async () => {
    const { c } = await candidate();
    const a = new SoundLibrary(memoryStore());
    a.add(c, 'ONE');
    a.add(c, 'TWO');
    const text = a.export();
    expect(JSON.parse(text)).toMatchObject({ format: SOUND_FORMAT, version: 1 });
    const b = new SoundLibrary(memoryStore());
    const r = b.import(text);
    expect(r.added).toHaveLength(2);
    expect(stable(b.list().map(({ id: _i, ...s }) => s))).toBe(stable(a.list().map(({ id: _i, ...s }) => s)));
    // one sound only
    expect(JSON.parse(a.export([a.list()[1]!.id])).sounds).toHaveLength(1);
    expect(() => b.import('{nope')).toThrow(/JSON/);
    expect(() => b.import('{"format":"something-else"}')).toThrow(/not a CLATTER sound/);
    const bad = JSON.parse(text);
    bad.sounds.push({ voice: 99, values: { decay: 3 } }, { voice: 0, values: {} }, 'x');
    const r2 = new SoundLibrary(memoryStore()).import(JSON.stringify(bad));
    expect(r2.added).toHaveLength(2);
    expect(r2.skipped).toBe(3);
  });

  it('clamps and filters what a file can say', async () => {
    const lib = new SoundLibrary(memoryStore());
    const file = { format: SOUND_FORMAT, version: 1, sounds: [{ name: 'x'.repeat(80), voice: 0, values: { decay: 900, cutoff: -4, notAKey: 5, fmAmt: 'x' }, lfo: 'notAKey', origin: { seed: 7, character: 'dub', wildness: 5000, index: 99, draw: 2, lineage: [{ seed: 1, wildness: 50 }, { nope: 1 }] } }] };
    const r = lib.import(JSON.stringify(file));
    const s = r.added[0]!;
    expect(s.name.length).toBeLessThanOrEqual(24);
    expect(s.values).toEqual({ decay: 127, cutoff: 0 });
    expect(s.lfo).toBeNull();
    expect(s.origin).toMatchObject({ wildness: 100, index: 7, lineage: [{ seed: 1, wildness: 50 }] });
  });

  it('loading puts a sound in a candidate slot and leaves the instrument alone', async () => {
    const { s, p, applied } = await session();
    await s.discover();
    const c = s.candidate(6)!;
    const saved = s.save(6, 'keeper')!;
    s.select(2);
    const before = stable(p);
    expect(s.load(saved.id)).toBe(2);  // the selected slot takes it (no slot is empty)
    expect(stable(p)).toBe(before);
    expect(applied).toHaveLength(0);
    expect(s.selected!.values).toEqual(c.values);
    expect(s.selected!.origin.kind).toBe('library');
    expect(s.canBack(2)).toBe(true);
  });

  it('a kick candidate can move to a tom voice; parameters the voice lacks are dropped', async () => {
    const { s, select, p } = await session();
    await s.discover();
    const saved = s.save(0, 'kick sound')!;
    select('SNARE');
    const i = s.load(saved.id)!;
    expect(i).toBe(0);
    const c = s.selected!;
    expect(c.voice).toBe(3);
    const own = voiceKeys(3);
    for (const k of Object.keys(c.values)) expect(own[k as keyof typeof own]).toBeDefined();
    expect(retarget(s.candidate(0)!, 3).voice).toBe(3);
    void p;
  });

  it('saving a candidate keeps its pitch when it was measured, never an unreliable note', async () => {
    const { s } = await session();
    await s.discover();
    await s.analyse(s.candidate(0));
    const saved = s.save(0, 'pitched')!;
    const a = s.pitchOf(s.candidate(0))!.record.analysis;
    if (pitchBadge(a).reliable) expect(saved.pitch).toMatchObject({ note: a.fundamental!.note });
    else expect(saved.pitch).toEqual({ kind: a.kind });
    expect(s.save(1, 'unmeasured')!.pitch).toBeUndefined();
  });

  it('extras travel by name: variations and modulation follow a sound to another voice', async () => {
    const { p, track } = await rig();
    const k = track('KICK');
    k.sound.variations = [{ name: 'LONG', params: { [voiceKeys(0).decay!]: 70 } }, null, null, null];
    const e = extrasOf(k, 0)!;
    expect(e.variations![0]).toMatchObject({ name: 'LONG', values: { decay: 70 } });
    const sn = track('SNARE');
    const sound = soundWithExtras(sn, 3, e);
    expect(sound.variations![0]!.params[voiceKeys(3).decay!]).toBe(70);
    void p;
  });
});

describe('seeds', () => {
  it('a held phrase makes the same eight candidates again, with the seed in each', async () => {
    const a = await session();
    await a.s.discover();
    const first = a.s.state.slots.map((x) => x.cand!);
    const b = await session();
    await b.s.discover();
    expect(b.s.state.slots.map((x) => x.cand!.key)).toEqual(first.map((c) => c.key));
    expect(first.every((c) => c.origin.seedText === 'test-seed-one' && c.origin.seed === seedFromText('test-seed-one'))).toBe(true);
    // the next batch draws the next seed and differs
    await a.s.discover();
    expect(a.s.state.slots[0]!.cand!.origin.seedText).toBe('test-seed-two');
    expect(a.s.state.slots[0]!.cand!.key).not.toBe(first[0]!.key);
  });

  it('the seed field is the DISCOVER seed: a typed phrase is held and used', async () => {
    const app = new App();
    app.project = defaultProject();
    app.setSeedInput('discover', 'velvet-orbit');
    expect(app.seedSlot('discover')).toMatchObject({ fixed: true, value: { seed: seedFromText('velvet-orbit'), text: 'velvet-orbit' } });
    await app.discover.discover();
    expect(app.discover.state.batch).toEqual({ seed: seedFromText('velvet-orbit'), text: 'velvet-orbit' });
    const one = app.discover.state.slots.map((x) => x.cand!.key);
    app.discover.clear();
    await app.discover.discover();
    expect(app.discover.state.slots.map((x) => x.cand!.key)).toEqual(one);
  });

  it('the seed metadata of an applied candidate is saved in the project and survives a round trip', async () => {
    const app = new App();
    app.project = defaultProject();
    app.selectTrack(app.project.tracks.find((t) => t.role === 'snare')!.id);
    app.setSeedInput('discover', 'silver-moth');
    await app.discover.discover();
    app.discover.select(4);
    app.discover.apply();
    const back = parseProject(serialize(app.project));
    expect(back.version).toBe(8);
    expect(back.discovered![3]).toMatchObject({ name: '5', origin: { kind: 'generated', seed: seedFromText('silver-moth'), seedText: 'silver-moth', index: 4, draw: 0, character: 'machine', voice: 3, archetype: 'snare' } });
    // and the metadata is enough to make that sound again
    const origin = back.discovered![3]!.origin;
    const fresh = defaultProject();
    const again = reproduce(fresh.kit.synth, origin, fresh.soundLocks, voiceRolesOf(fresh.tracks));
    expect(again!.values).toEqual(voiceValues(app.project.kit.synth, 3));
  });

  it('projects without the record, and damaged records, load', () => {
    const p = repairProject({ format: 'clatter-project', version: 5 });
    expect(p.discovered).toBeUndefined();
    const q = repairProject({ format: 'clatter-project', version: 6, discovered: { 0: { name: 'x', origin: { seed: -3 } }, 9: {}, 3: 'no' } });
    expect(q.discovered).toBeUndefined();
  });
});
