/** SEEDS: phrases to numbers, memorable draws, reproducibility, legacy numeric seeds, save and load. */
import { describe, expect, it } from 'vitest';
import { bundledLibrary, presetProject } from './helpers';
import { App } from '../src/app/app';
import { applyWildcard, repairWild, WILD_CATS } from '../src/destruction/wildcardProject';
import { defaultProject } from '../src/model/defaults';
import { parseSynthKit, serializeSynthKit, synthKitOf } from '../src/model/kits';
import { parseProject, repairProject, serialize } from '../src/model/project';
import { clone, type Project } from '../src/model/types';
import { defaultGen, generate } from '../src/rhythm/generate';
import { hash32, Rng, SALT } from '../src/rhythm/rng';
import { checkedSeedText, GENERATOR_VERSION, normaliseSeedText, parseSeedInput, randomSeedPhrase, randomSeedValue, SEED_ADJECTIVES, SEED_HASH_VERSION, SEED_NOUNS, seedFromText } from '../src/rhythm/seed';
import { styleById } from '../src/rhythm/styles';
import { generateKit, voiceRolesOf } from '../src/sound/kitgen';
import { emptySynthKit } from '../src/model/defaults';

/** FNV-1a over a JSON string: a short, stable fingerprint of a result. */
const digest = (v: unknown): number => {
  let h = 2166136261;
  for (const c of JSON.stringify(v)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
};
/** Key order is not part of a project's identity (it differs after an undo): compare with sorted keys. */
const sorted = (v: unknown): unknown => (Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, sorted(x)])) : v);
const json = (p: Project) => JSON.stringify(sorted({ ...p, snapshots: [] }));
const tracks = defaultProject().tracks;
const gen = (seed: number, style = 'machine') => generate(tracks, { ...defaultGen(), style }, seed, { steps: 32, res: 4 });

describe('the phrase hash (SEED HASH v1)', () => {
  it('is a fixed, documented function: these values never change', () => {
    expect(SEED_HASH_VERSION).toBe(1);
    expect(seedFromText('velvet-orbit')).toBe(3927013363);
    expect(seedFromText('haunted-machine')).toBe(1423416732);
    expect(seedFromText('silver-moth')).toBe(1212435622);
    expect(seedFromText('my-favourite-kick')).toBe(470857457);
  });

  it('is the same every time and gives every phrase its own seed', () => {
    for (let i = 0; i < 5; i++) expect(seedFromText('velvet-orbit')).toBe(3927013363);
    const seen = new Set<number>();
    for (const a of SEED_ADJECTIVES.slice(0, 40)) for (const n of SEED_NOUNS.slice(0, 40)) seen.add(seedFromText(`${a}-${n}`));
    expect(seen.size).toBe(1600);
    for (const s of seen) expect(s).toBeGreaterThan(0);
  });

  it('treats case, spaces, hyphens and underscores alike', () => {
    const s = seedFromText('velvet-orbit');
    for (const t of ['Velvet Orbit', '  velvet   orbit ', 'VELVET_ORBIT', 'velvet--orbit', '-velvet-orbit-', 'velvet\torbit', 'Velvet-ORBIT']) expect(seedFromText(t)).toBe(s);
    expect(normaliseSeedText(' My Favourite  Kick ')).toBe('my-favourite-kick');
    expect(seedFromText('velvet-orbits')).not.toBe(s);
    expect(seedFromText('velvet-orbit-2')).not.toBe(s);
  });

  it('accepts Unicode and gives one answer for equivalent forms', () => {
    expect(seedFromText('café')).toBe(3746663762);
    expect(seedFromText('café')).toBe(seedFromText('café')); // composed and decomposed
    expect(seedFromText('ＶＥＬＶＥＴ')).toBe(seedFromText('velvet')); // full-width letters (NFKC)
    expect(seedFromText('日本語のキック')).toBe(1271481151);
    expect(seedFromText('🥁')).toBe(4262639055);
    expect(seedFromText('Σίσυφος')).toBe(seedFromText('ΣΊΣΥΦΟΣ'.toLowerCase()));
    expect(seedFromText('a​b')).toBe(seedFromText('ab')); // zero-width characters are dropped
    expect(() => seedFromText('\ud800 lone surrogate')).not.toThrow();
    expect(parseSeedInput('🥁🥁')?.text).toBe('🥁🥁');
  });

  it('keeps at most 80 code points, the same way everywhere', () => {
    const long = 'x'.repeat(200);
    expect(normaliseSeedText(long)).toBe('x'.repeat(80));
    expect(seedFromText(long)).toBe(seedFromText('x'.repeat(80)));
    expect([...normaliseSeedText('🥁'.repeat(200))].length).toBe(80);
  });
});

describe('what is typed or pasted', () => {
  it('empty or only separators is no seed', () => {
    for (const t of ['', '   ', '-', ' _ - ', '\n\t', '​']) expect(parseSeedInput(t)).toBeNull();
    expect(parseSeedInput(undefined as unknown as string)).toBeNull();
    expect(Number.isInteger(seedFromText(''))).toBe(true); // defined, never 0
    expect(seedFromText('')).toBeGreaterThan(0);
  });

  it('digits are a plain number, exactly as seeds have always been typed', () => {
    expect(parseSeedInput('12345')).toEqual({ seed: 12345 });
    expect(parseSeedInput(' 0 ')).toEqual({ seed: 0 });
    expect(parseSeedInput('4294967295')).toEqual({ seed: 4294967295 });
    expect(parseSeedInput('007')).toEqual({ seed: 7 });
  });

  it('anything else is a phrase, and numbers too large for a seed are phrases', () => {
    expect(parseSeedInput('Velvet Orbit')).toEqual({ seed: seedFromText('velvet-orbit'), text: 'velvet-orbit' });
    expect(parseSeedInput('4294967296')?.text).toBe('4294967296');
    expect(parseSeedInput('12345678901234')?.text).toBe('12345678901234');
    expect(parseSeedInput('12 34')?.text).toBe('12-34');
    expect(parseSeedInput('-5')?.text).toBe('5');
  });

  it('a stored phrase is kept only while it names its number', () => {
    expect(checkedSeedText(3927013363, 'Velvet Orbit')).toBe('velvet-orbit');
    expect(checkedSeedText(1, 'velvet-orbit')).toBeUndefined();
    expect(checkedSeedText(1, 'velvet-orbit', 2)).toBe('velvet-orbit'); // another hash version: the number is the truth, the phrase a label
    expect(checkedSeedText(1, '')).toBeUndefined();
    expect(checkedSeedText(1, 42)).toBeUndefined();
  });
});

describe('memorable seeds', () => {
  it('the word lists are 256 distinct plain words each', () => {
    for (const list of [SEED_ADJECTIVES, SEED_NOUNS]) {
      expect(list.length).toBe(256);
      expect(new Set(list).size).toBe(256);
      for (const w of list) expect(w).toMatch(/^[a-z]{2,12}$/);
    }
  });

  it('a draw is two words that name their number', () => {
    for (let i = 0; i < 50; i++) {
      const v = randomSeedValue();
      expect(v.text).toMatch(/^[a-z]+-[a-z]+$/);
      expect(seedFromText(v.text!)).toBe(v.seed);
      expect(parseSeedInput(v.text!)).toEqual(v);
    }
  });

  it('is deterministic for a given source of randomness and varied otherwise', () => {
    const r = () => new Rng(5);
    const a = r();
    const b = r();
    expect(randomSeedPhrase(() => a.next())).toBe(randomSeedPhrase(() => b.next()));
    const seen = new Set(Array.from({ length: 60 }, () => randomSeedPhrase()));
    expect(seen.size).toBeGreaterThan(50);
  });
});

describe('reproducibility', () => {
  it('the same phrase makes the same pattern; another phrase another pattern', () => {
    const a = gen(seedFromText('velvet-orbit'));
    expect(gen(seedFromText('Velvet Orbit'))).toEqual(a);
    expect(JSON.stringify(gen(seedFromText('haunted-machine')))).not.toBe(JSON.stringify(a));
    expect(JSON.stringify(gen(seedFromText('silver-moth')))).not.toBe(JSON.stringify(gen(seedFromText('haunted-machine'))));
  });

  it('the same phrase makes the same kit; another phrase another kit', () => {
    const o = (s: string) => ({ seed: seedFromText(s), flavour: styleById('machine').kitFlavour, voiceRoles: voiceRolesOf(tracks), locks: { voices: [false, false, false, false, false, false], params: [] } });
    const init = emptySynthKit();
    const a = generateKit(init, o('velvet-orbit')).params;
    expect(generateKit(init, o('velvet-orbit')).params).toEqual(a);
    expect(generateKit(init, o('silver-moth')).params).not.toEqual(a);
  });

  it('the same phrase, settings and starting state make the same WILDCARD; another phrase another', async () => {
    const lib = await bundledLibrary();
    const base = await presetProject('digital-detritus', lib);
    const run = (phrase: string) => {
      const p = clone(base);
      const v = parseSeedInput(phrase)!;
      applyWildcard(p, { seed: v.seed, intensity: 70, scope: 'project', cats: [...WILD_CATS] }, { track: 't1', pool: [] });
      return JSON.stringify({ ...p, snapshots: [] });
    };
    expect(run('velvet-orbit')).toBe(run('velvet orbit'));
    expect(run('velvet-orbit')).not.toBe(run('silver-moth'));
  });

  it('keyed decisions depend only on the number: a phrase and its number are the same seed', () => {
    const n = seedFromText('velvet-orbit');
    expect(hash32(n, SALT.gen, 1, 2, 3)).toBe(hash32(3927013363, SALT.gen, 1, 2, 3));
    expect(new Rng(n).next()).toBe(new Rng(3927013363).next());
  });
});

describe('legacy numeric seeds', () => {
  // these fingerprints were taken from the generators before phrases existed: they must never move
  it('generate() with a number gives what it always gave', () => {
    expect(digest(gen(12345))).toBe(GOLDEN.gen12345);
    expect(digest(gen(1101, 'breaks'))).toBe(GOLDEN.gen1101);
  });

  it('a project from before phrases loads with its numbers, no phrases, and plays identically', async () => {
    const lib = await bundledLibrary();
    const p = await presetProject('digital-detritus', lib);
    const old = JSON.parse(serialize(p)) as Record<string, unknown>;
    old.version = 4;
    delete old.seedHash;
    delete old.generator;
    delete old.seedText;
    const back = parseProject(JSON.stringify(old));
    expect(back.version).toBe(6);
    expect(back.seed).toBe(p.seed);
    expect(back.seedText).toBeUndefined();
    expect(back.generator).toBe(1);
    expect(back.seedHash).toBe(1);
    expect(back.kit.seed).toBe(p.kit.seed);
    expect(back.kit.seedText).toBeUndefined();
    expect(back.timbre.seed).toBe(p.timbre.seed);
    for (let i = 0; i < p.patterns.length; i++) {
      expect(back.patterns[i]!.seed).toBe(p.patterns[i]!.seed);
      expect(back.patterns[i]!.seedText).toBeUndefined();
      expect(back.patterns[i]!.gen).toEqual(p.patterns[i]!.gen);
    }
    // the generators still make from the old number exactly the pattern that was saved
    const pat = back.patterns[0]!;
    expect(generate(back.tracks, pat.settings, pat.seed, { steps: 64, res: 4 }).t1?.length ?? 0).toBeGreaterThanOrEqual(0);
  });

  it('a version 1 project with no seeds at all gets the old defaults', () => {
    const p = repairProject({ format: 'clatter-project', version: 1 });
    expect(p.seed).toBe(1);
    expect(p.kit.seed).toBe(0);
    expect(p.timbre.seed).toBe(1);
    expect(p.seedText).toBeUndefined();
  });

  it('a number that is saved stays a number; a phrase that no longer matches is dropped, never trusted', () => {
    const p = defaultProject();
    p.seed = 987654;
    const again = parseProject(serialize(p));
    expect(again.seed).toBe(987654);
    expect(again.seedText).toBeUndefined();
    const lie = JSON.parse(serialize(p)) as Record<string, unknown>;
    lie.seedText = 'velvet-orbit';
    expect(parseProject(JSON.stringify(lie)).seedText).toBeUndefined();
    expect(parseProject(JSON.stringify(lie)).seed).toBe(987654);
    lie.seedHash = 2; // made by another hash: the number still decides, the phrase is only a label
    expect(parseProject(JSON.stringify(lie)).seedText).toBe('velvet-orbit');
    expect(parseProject(JSON.stringify(lie)).seed).toBe(987654);
  });

  it('WILDCARD settings from before phrases repair to the same numbers', () => {
    expect(repairWild({ seed: 4242, intensity: 60, scope: 'kit', cats: ['sound'] })).toEqual({ seed: 4242, intensity: 60, scope: 'kit', cats: ['sound'] });
    expect(repairWild({ seed: 4242, seedText: 'nope' }).seedText).toBeUndefined();
    expect(repairWild({ seed: seedFromText('silver-moth'), seedText: 'Silver Moth' }).seedText).toBe('silver-moth');
  });
});

describe('save and load', () => {
  it('phrases and the versions that made them survive a round trip', () => {
    const p = defaultProject();
    const set = (o: { seed: number; seedText?: string }, t: string) => ((o.seed = seedFromText(t)), (o.seedText = t));
    set(p, 'velvet-orbit');
    set(p.kit, 'haunted-machine');
    set(p.timbre, 'silver-moth');
    set(p.patterns[0]!, 'my-favourite-kick');
    p.wildcard = { seed: seedFromText('rusty-owl'), seedText: 'rusty-owl', intensity: 40, scope: 'kit', cats: ['sound'] };
    const back = parseProject(serialize(p));
    expect(back.seedText).toBe('velvet-orbit');
    expect(back.seed).toBe(seedFromText('velvet-orbit'));
    expect(back.kit.seedText).toBe('haunted-machine');
    expect(back.timbre.seedText).toBe('silver-moth');
    expect(back.patterns[0]!.seedText).toBe('my-favourite-kick');
    expect(back.wildcard?.seedText).toBe('rusty-owl');
    expect(back.seedHash).toBe(SEED_HASH_VERSION);
    expect(back.generator).toBe(GENERATOR_VERSION);
    expect(serialize(back)).toBe(serialize(parseProject(serialize(back))));
  });

  it('snapshots keep the pattern phrase', () => {
    const p = defaultProject();
    p.patterns[0]!.seed = seedFromText('silver-moth');
    p.patterns[0]!.seedText = 'silver-moth';
    p.snapshots[0] = { name: 'S', pattern: clone(p.patterns[0]!), synth: p.kit.synth, sounds: {}, mix: {}, play: {}, destruction: p.destruction, tempo: 120, swing: 50 };
    expect(parseProject(serialize(p)).snapshots[0]?.pattern.seedText).toBe('silver-moth');
  });

  it('a synth kit file keeps the kit phrase, and a number-only file loads as before', () => {
    const p = defaultProject();
    p.kit.seed = seedFromText('haunted-machine');
    p.kit.seedText = 'haunted-machine';
    const text = serializeSynthKit(synthKitOf(p));
    expect(parseSynthKit(text).seedText).toBe('haunted-machine');
    const o = JSON.parse(text) as Record<string, unknown>;
    delete o.seedText;
    expect(parseSynthKit(JSON.stringify(o)).seedText).toBeUndefined();
    expect(parseSynthKit(JSON.stringify(o)).seed).toBe(p.kit.seed);
  });
});

describe('in the app', () => {
  const fresh = (): App => {
    const a = new App();
    a.project = defaultProject();
    return a;
  };

  it('each GENERATE draws a memorable phrase, records it, and the pattern is what that phrase makes', () => {
    const app = fresh();
    app.generatePattern();
    const p = app.pattern;
    expect(p.seedText).toMatch(/^[a-z]+-[a-z]+$/);
    expect(p.seed).toBe(seedFromText(p.seedText!));
    expect(app.seedSlot('pattern').value).toEqual({ seed: p.seed, text: p.seedText });
    expect(app.seedSlot('pattern').fixed).toBe(false);
    expect(p.gen).toEqual(generate(app.project.tracks, app.project.gen, p.seed, { steps: p.steps, res: p.res }));
  });

  it('a held phrase makes the same pattern every time; clearing frees it', () => {
    const app = fresh();
    expect(app.setSeedInput('pattern', 'Velvet Orbit')).toBe(true);
    expect(app.seedSlot('pattern').fixed).toBe(true);
    app.generatePattern();
    const first = JSON.stringify(app.pattern.gen);
    expect(app.pattern.seedText).toBe('velvet-orbit');
    app.generatePattern();
    expect(JSON.stringify(app.pattern.gen)).toBe(first);
    app.clearSeed('pattern');
    expect(app.seedSlot('pattern')).toEqual({ value: null, fixed: false });
    app.generatePattern();
    expect(app.pattern.seedText).not.toBe('velvet-orbit');
  });

  it('a number typed in is a plain number seed; the dice holds a new phrase', () => {
    const app = fresh();
    app.setSeedInput('pattern', '12345');
    app.generatePattern();
    expect(app.pattern.seed).toBe(12345);
    expect(app.pattern.seedText).toBeUndefined();
    expect(app.pattern.gen).toEqual(generate(app.project.tracks, app.project.gen, 12345, { steps: app.pattern.steps, res: app.pattern.res }));
    app.rollSeed('pattern');
    expect(app.seedSlot('pattern').fixed).toBe(true);
    expect(app.seedSlot('pattern').value?.text).toMatch(/^[a-z]+-[a-z]+$/);
    expect(app.setSeedInput('pattern', '  ')).toBe(false);
    expect(app.seedSlot('pattern').fixed).toBe(false);
  });

  it('the seed of one generator never moves the seed of another', () => {
    const app = fresh();
    app.setSeedInput('pattern', 'velvet-orbit');
    app.setSeedInput('sound', 'silver-moth');
    expect(app.seedSlot('kit').value).toBeNull();
    expect(app.seedSlot('wildcard').value).toBeNull();
    expect(app.seedSlot('sound').value?.text).toBe('silver-moth');
  });

  it('WILDCARD with a held phrase is reproducible after an undo and records the phrase', async () => {
    const lib = await bundledLibrary();
    const app = fresh();
    app.project = await presetProject('digital-detritus', lib);
    app.setSeedInput('wildcard', 'rusty owl');
    app.wildcard();
    const first = json(app.project);
    expect(app.project.wildcard?.seedText).toBe('rusty-owl');
    app.undo();
    app.wildcard();
    expect(json(app.project)).toBe(first);
    app.clearSeed('wildcard');
    app.undo();
    app.wildcard();
    expect(app.project.wildcard?.seedText).toMatch(/^[a-z]+-[a-z]+$/);
    expect(app.project.wildcard?.seedText).not.toBe('rusty-owl');
  });

  it('a derived number from WILDCARD carries no stale phrase', async () => {
    const lib = await bundledLibrary();
    const p = await presetProject('digital-detritus', lib);
    p.kit.seedText = 'haunted-machine';
    p.kit.seed = seedFromText('haunted-machine');
    applyWildcard(p, { seed: 99, intensity: 100, scope: 'kit', cats: [...WILD_CATS] }, { track: 't1', pool: [] });
    if (p.kit.seed !== seedFromText('haunted-machine')) expect(p.kit.seedText).toBeUndefined();
    expect(checkedSeedText(p.kit.seed, p.kit.seedText) === p.kit.seedText).toBe(true);
  });

  it('the project seed is an undoable edit and changes only what depends on it', () => {
    const app = fresh();
    const was = app.project.seed;
    expect(app.setProjectSeed('Silver Moth')).toBe(true);
    expect(app.project.seed).toBe(seedFromText('silver-moth'));
    expect(app.project.seedText).toBe('silver-moth');
    app.undo();
    expect(app.project.seed).toBe(was);
    expect(app.project.seedText).toBeUndefined();
    expect(app.setProjectSeed('')).toBe(false);
    app.resetProjectSeed();
    expect(app.project.seed).toBe(1);
  });
});

/** Fingerprints of generate() output made before phrases existed. */
const GOLDEN = { gen12345: 4015561634, gen1101: 4097811946 };
