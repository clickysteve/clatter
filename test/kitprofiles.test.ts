/**
 * Instrument-aware generation: profiles, CHARACTER, WILDNESS, mutation, locks, seeds. The sounds
 * are checked by ear's proxy: rendered through the real LXR engine and measured (analysis.ts), not
 * only by their parameter values.
 */
import { describe, expect, it } from 'vitest';
import { newLxr } from './helpers';
import { analyse, fundamental } from '../src/sound/analysis';
import { checkKit, readKit, renderTrigger, voiceFeatures } from '../src/sound/kitcheck';
import { generateKit, mutateKit, resolveProfiles, voiceKeys, voiceRolesOf } from '../src/sound/kitgen';
import { judge } from '../src/sound/judge';
import { CHARACTER_DEFS, defaultKitGen, drawSpec, profileForVoice, recipeFor, repairKitGen, type Profile } from '../src/sound/profiles';
import { defaultTracks } from '../src/model/defaults';
import { App } from '../src/app/app';
import { parseProject, serialize } from '../src/model/project';
import { CHARACTERS, type Character, type SynthKit } from '../src/model/types';
import { Rng } from '../src/rhythm/rng';
import { defaultWild } from '../src/destruction/wildcardProject';
import { PAR } from '../src/sound/lxrParamIds';

const e = newLxr();
const init = readKit(e);
const roles = voiceRolesOf(defaultTracks());
const noLocks = { voices: [false, false, false, false, false, false], params: [] as number[] };
const profiles = resolveProfiles({ voiceRoles: roles });
const gen = (seed: number, character: Character, wildness: number, locks = noLocks, base = init) => generateKit(base, { seed, flavour: 'machine', voiceRoles: roles, locks, character, wildness });
const checked = (kit: SynthKit, seed: number, character: Character, wildness: number) => checkKit(newLxr(), kit, { flavour: 'machine', voiceRoles: roles, seed, fallback: init, gen: { character, wildness, profiles } }).kit;
const P = (v: number, k: keyof ReturnType<typeof voiceKeys>) => voiceKeys(v)[k]!;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const share = (xs: boolean[]) => xs.filter(Boolean).length / xs.length;

describe('profiles of the voices', () => {
  it('follow the tracks that play each voice, with overrides', () => {
    expect(profiles).toEqual(['kick', 'ltom', 'htom', 'snare', 'cymbal', 'chat']);
    expect(profileForVoice(5, ['ohat'])).toBe('ohat');
    expect(profileForVoice(3, ['clap'])).toBe('clap');
    expect(profileForVoice(4, ['chat'])).toBe('chat');
    expect(profileForVoice(2, ['fx'])).toBe('fx');
    expect(resolveProfiles({ voiceRoles: roles, profiles: ['cymbal', null, null, null, null, null] })[0]).toBe('cymbal');
  });

  it('every character leans the distributions (not a preset): they differ from CLASSIC and from each other', () => {
    const k = recipeFor('kick', 'drum', 'classic');
    expect(recipeFor('kick', 'drum', 'industrial').drive).not.toEqual(k.drive);
    expect(recipeFor('kick', 'drum', 'analog').cutoff).not.toEqual(k.cutoff);
    expect(recipeFor('kick', 'drum', 'minimal').decay).not.toEqual(k.decay);
    expect(new Set(CHARACTERS.map((c) => JSON.stringify(recipeFor('snare', 'snare', c)))).size).toBe(CHARACTERS.length);
  });
});

describe('reproducibility', () => {
  it('the same seed, character, wildness and locks make the same kit; another seed another', () => {
    for (const c of CHARACTERS) {
      expect(gen(42, c, 0.3)).toEqual(gen(42, c, 0.3));
      expect(gen(42, c, 0.3).params).not.toEqual(gen(43, c, 0.3).params);
    }
    expect(gen(42, 'classic', 0.3).params).not.toEqual(gen(42, 'digital', 0.3).params);
    expect(gen(42, 'classic', 0.3).params).not.toEqual(gen(42, 'classic', 0.7).params);
  });

  it('the engine check is deterministic too', () => {
    const a = checked(gen(7, 'classic', 0.2), 7, 'classic', 0.2);
    const b = checked(gen(7, 'classic', 0.2), 7, 'classic', 0.2);
    expect(a).toEqual(b);
  });

  it('keeps every parameter in the firmware range at every character and wildness', () => {
    for (const c of CHARACTERS)
      for (const w of [0, 0.5, 1])
        for (let s = 1; s <= 4; s++)
          for (const v of gen(s * 31, c, w).params) {
            expect(Number.isInteger(v)).toBe(true);
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThanOrEqual(127);
          }
  });
});

describe('WILDNESS: a continuous transformation of the distributions', () => {
  it('at 0 % a kick’s pitch stays in its profile; at 100 % it ranges far wider', () => {
    const spec = recipeFor('kick', 'drum', 'classic').coarse!;
    const draw = (w: number) => Array.from({ length: 400 }, (_, i) => drawSpec('coarse', spec, w, new Rng(i + 1)));
    const lo = draw(0);
    const hi = draw(1);
    expect(Math.min(...lo)).toBeGreaterThanOrEqual(22);
    expect(Math.max(...lo)).toBeLessThanOrEqual(38);
    expect(Math.max(...hi) - Math.min(...hi)).toBeGreaterThan(70);
  });

  it('spread grows continuously with wildness (no steps)', () => {
    const spec = recipeFor('snare', 'snare', 'classic').noiseMix!;
    const sd = (w: number) => {
      const xs = Array.from({ length: 600 }, (_, i) => drawSpec('noiseMix', spec, w, new Rng(1000 + i)));
      const m = mean(xs);
      return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
    };
    const ws = [0, 0.2, 0.4, 0.6, 0.8, 1].map(sd);
    for (let i = 1; i < ws.length; i++) expect(ws[i]!).toBeGreaterThan(ws[i - 1]! * 0.98);
    expect(ws[5]!).toBeGreaterThan(ws[0]! * 3);
  });

  it('menus drift towards unusual choices: a low-wildness snare never takes a low-pass, a wild one may', () => {
    const spec = recipeFor('snare', 'snare', 'classic').ftype!;
    const lp = (w: number) => share(Array.from({ length: 400 }, (_, i) => drawSpec('ftype', spec, w, new Rng(i + 7)) === 0));
    expect(lp(0)).toBe(0);
    expect(lp(1)).toBeGreaterThan(0.05);
  });

  it('the judged likeness to the instruments falls as wildness rises (raw designs, rendered)', () => {
    const score = (w: number) => {
      const s: number[] = [];
      for (let k = 1; k <= 10; k++) {
        const kit = gen(k * 977, 'classic', w);
        for (let v = 0; v < 6; v++) {
          const { f, open } = voiceFeatures(e, kit, v, profiles[v]!, roles[v]!);
          s.push(judge(profiles[v]!, f, open));
        }
      }
      return mean(s);
    };
    const s10 = score(0.1);
    const s50 = score(0.5);
    const s90 = score(0.9);
    expect(s10).toBeGreaterThan(0.8);
    expect(s10).toBeGreaterThan(s50);
    expect(s50).toBeGreaterThan(s90);
    expect(s90).toBeLessThan(0.65);
  }, 60_000);
});

describe('CLASSIC at 20 %: a kick is a kick, a snare a snare, hats are hats (measured in the engine)', () => {
  const N = 16;
  const kits = Array.from({ length: N }, (_, i) => checked(gen(5000 + i * 131, 'classic', 0.2), i, 'classic', 0.2));
  const kick = kits.map((k) => analyse(renderTrigger(e, k, 0)));
  const snare = kits.map((k) => analyse(renderTrigger(e, k, 3)));
  const chat = kits.map((k) => analyse(renderTrigger(e, k, 5)));
  const ohat = kits.map((k) => analyse(renderTrigger(e, k, 6, 1.6)));
  const ltom = kits.map((k) => analyse(renderTrigger(e, k, 1)));
  const htom = kits.map((k) => analyse(renderTrigger(e, k, 2)));

  it('kicks: a low fundamental, most energy below 150 Hz, a fast attack, a controlled decay, little high sustain', () => {
    expect(share(kick.map((f) => f.f0 > 0 && f.f0 < 130))).toBeGreaterThanOrEqual(0.9);
    expect(share(kick.map((f) => f.lowRatio > 0.45))).toBeGreaterThanOrEqual(0.9);
    expect(share(kick.map((f) => f.attackMs < 12))).toBe(1);
    expect(share(kick.map((f) => f.lengthMs > 90 && f.lengthMs < 1000))).toBe(1);
    expect(share(kick.map((f) => f.hfSustain < 0.15))).toBe(1);
  });

  it('snares: noisy (flat spectrum), bright, short', () => {
    expect(share(snare.map((f) => f.flatness > 0.2))).toBeGreaterThanOrEqual(0.9);
    expect(share(snare.map((f) => f.centroid > 1000))).toBeGreaterThanOrEqual(0.9);
    expect(share(snare.map((f) => f.lengthMs > 70 && f.lengthMs < 520))).toBe(1);
  });

  it('hats: bright with no low end; the open hat rings longer than the closed one', () => {
    expect(share(chat.map((f) => f.centroid > 3500 && f.lowRatio < 0.05))).toBeGreaterThanOrEqual(0.9);
    expect(share(chat.map((f) => f.lengthMs < 220))).toBe(1);
    expect(share(ohat.map((f, i) => f.lengthMs > chat[i]!.lengthMs * 1.5))).toBe(1);
  });

  it('toms: pitched, the low tom below the high tom', () => {
    expect(share(ltom.map((f, i) => f.f0 > 0 && htom[i]!.f0 > 0 && f.f0 < htom[i]!.f0))).toBeGreaterThanOrEqual(0.9);
    for (const k of kits) expect(k.params[P(1, 'coarse')]!).toBeLessThan(k.params[P(2, 'coarse')]!);
  });

  it('every voice is audible, unclipped and judged its instrument', () => {
    for (const k of kits)
      for (let v = 0; v < 6; v++) {
        const { f, open } = voiceFeatures(e, k, v, profiles[v]!, roles[v]!);
        expect(f.peak).toBeGreaterThan(0.03);
        expect(f.peak).toBeLessThan(0.99);
        expect(judge(profiles[v]!, f, open), `voice ${v}`).toBeGreaterThan(0.5);
      }
  });
}, 120_000);

describe('CHARACTER: meaningfully different results', () => {
  const N = 12;
  const kitsOf = (c: Character) => Array.from({ length: N }, (_, i) => gen(9000 + i * 17, c, 0.3));
  const all = Object.fromEntries(CHARACTERS.map((c) => [c, kitsOf(c)])) as Record<Character, SynthKit[]>;
  const avg = (c: Character, v: number, k: keyof ReturnType<typeof voiceKeys>) => mean(all[c].map((kit) => kit.params[P(v, k)]!));

  it('INDUSTRIAL drives harder and decimates more than CLASSIC', () => {
    for (const v of [0, 3, 5]) expect(avg('industrial', v, 'drive')).toBeGreaterThan(avg('classic', v, 'drive') + 15);
    const crushed = (c: Character) => share(all[c].flatMap((kit) => [0, 1, 2, 3, 4, 5].map((v) => kit.params[P(v, 'rate')]! < 127)));
    expect(crushed('industrial')).toBeGreaterThan(crushed('classic') + 0.15);
  });

  it('DIGITAL uses real FM and brighter metal than ANALOG; ANALOG is darker and rounder', () => {
    const fm1 = (c: Character) => share(all[c].flatMap((kit) => [0, 1, 2].map((v) => kit.params[P(v, 'fmMode')] === 1)));
    expect(fm1('digital')).toBeGreaterThan(fm1('analog') + 0.2);
    expect(avg('digital', 5, 'm1amt')).toBeGreaterThan(avg('analog', 5, 'm1amt') + 20);
    expect(avg('analog', 0, 'cutoff')).toBeLessThan(avg('digital', 0, 'cutoff') - 8);
    // heard: DIGITAL percussion is brighter than ANALOG (snare voice centroid)
    const cent = (c: Character) => mean(all[c].map((kit) => analyse(renderTrigger(e, kit, 3)).centroid));
    expect(cent('digital')).toBeGreaterThan(cent('analog'));
  });

  it('MINIMAL is shorter and has no LFOs; EXPERIMENTAL modulates most', () => {
    expect(avg('minimal', 0, 'decay')).toBeLessThan(avg('classic', 0, 'decay') - 3);
    const lfo = (c: Character) => share(all[c].flatMap((kit) => [0, 1, 2, 3, 4, 5].map((v) => kit.params[P(v, 'lfoDepth')]! > 0)));
    expect(lfo('minimal')).toBe(0);
    expect(lfo('experimental')).toBeGreaterThan(lfo('classic') + 0.3);
  });

  it('EXPERIMENTAL at 100 % is far less conventional than CLASSIC at 10 %', () => {
    const s = (c: Character, w: number) => {
      const xs: number[] = [];
      for (let i = 0; i < 6; i++) {
        const kit = gen(300 + i, c, w);
        for (let v = 0; v < 6; v++) {
          const { f, open } = voiceFeatures(e, kit, v, profiles[v]!, roles[v]!);
          xs.push(judge(profiles[v]!, f, open));
        }
      }
      return mean(xs);
    };
    expect(s('experimental', 1)).toBeLessThan(s('classic', 0.1) - 0.3);
  }, 60_000);
});

describe('locks', () => {
  it('generation and mutation never touch a locked voice or a locked parameter', () => {
    const base = gen(1, 'classic', 0.3);
    const locks = { voices: [false, true, false, false, false, false], params: [P(0, 'coarse'), P(3, 'noiseMix'), PAR.FX_TYPE] };
    for (const c of CHARACTERS)
      for (const w of [0, 0.5, 1]) {
        for (const k of [gen(99, c, w, locks, base), mutateKit(base, { seed: 5, flavour: 'machine', voiceRoles: roles, locks, character: c, wildness: w, amount: 1 })]) {
          for (const p of Object.values(voiceKeys(1))) if (p !== undefined) expect(k.params[p]).toBe(base.params[p]);
          for (const p of locks.params) expect(k.params[p]).toBe(base.params[p]);
          expect(k.lfoTarget[1]).toBe(base.lfoTarget[1]);
        }
      }
  });

  it('the engine check never redesigns a locked voice, and candidates keep locked parameters', () => {
    const base = gen(3, 'classic', 0.1);
    const kit = gen(4, 'classic', 0.1, { voices: [true, false, false, false, false, false], params: [P(3, 'coarse')] }, base);
    const out = checkKit(e, kit, { flavour: 'machine', voiceRoles: roles, seed: 1, locked: [true, false, false, false, false, false], lockedParams: [P(3, 'coarse')], gen: { character: 'classic', wildness: 0.1, profiles } }).kit;
    for (const p of Object.values(voiceKeys(0))) if (p !== undefined) expect(out.params[p]).toBe(base.params[p]);
    expect(out.params[P(3, 'coarse')]).toBe(base.params[P(3, 'coarse')]);
  });
});

describe('MUTATE KIT: relative to the current kit', () => {
  const dist = (a: SynthKit, b: SynthKit, v: number) => Object.values(voiceKeys(v)).filter((p): p is number => p !== undefined).reduce((s, p) => s + Math.abs(a.params[p]! - b.params[p]!), 0);
  const base = checked(gen(77, 'classic', 0.2), 77, 'classic', 0.2);
  const mut = (w: number, seed: number) => mutateKit(base, { seed, flavour: 'machine', voiceRoles: roles, locks: noLocks, character: 'classic', wildness: w, amount: 0.12 + 0.75 * w });

  it('low wildness makes restrained changes, high wildness substantial ones; both less than a new kit at low wildness', () => {
    const d = (w: number) => mean(Array.from({ length: 8 }, (_, i) => dist(base, mut(w, i + 1), 0)));
    expect(d(0.1)).toBeGreaterThan(0);
    expect(d(0.1)).toBeLessThan(d(0.5));
    expect(d(0.5)).toBeLessThan(d(0.95));
    const fresh = mean(Array.from({ length: 8 }, (_, i) => dist(base, gen(500 + i, 'classic', 0.1), 0)));
    expect(d(0.1)).toBeLessThan(fresh / 2);
  });

  it('at low wildness the drums keep their identity (still judged as kick, snare, hats)', () => {
    for (let i = 1; i <= 6; i++) {
      const k = mut(0.15, i);
      for (const v of [0, 3, 5]) {
        const { f, open } = voiceFeatures(e, k, v, profiles[v]!, roles[v]!);
        expect(judge(profiles[v]!, f, open), `seed ${i} voice ${v}`).toBeGreaterThan(0.4);
      }
    }
  });

  it('only the chosen voices change (MUTATE VOICE)', () => {
    const k = mutateKit(base, { seed: 3, flavour: 'machine', voiceRoles: roles, locks: noLocks, character: 'classic', wildness: 0.5, amount: 0.5, voices: [3] });
    for (const v of [0, 1, 2, 4, 5]) expect(dist(base, k, v)).toBe(0);
    expect(dist(base, k, 3)).toBeGreaterThan(0);
  });
});

describe('in the app: undo, samples, metadata, Wildcard stays separate, older projects', () => {
  it('GENERATE KIT records seed, character, wildness and profiles, and the same settings remake it (HOLD)', async () => {
    const app = new App();
    app.initKit = init;
    app.setKitGen({ character: 'digital', wildness: 0.4, hold: true, seed: 1234 });
    await app.generateKit();
    const first = app.project.kit.synth.params.slice();
    expect(app.project.kit.gen).toMatchObject({ v: 2, op: 'generate', seed: 1234, character: 'digital', wildness: 0.4, profiles });
    await app.mutateKit();
    await app.generateKit();
    expect(app.project.kit.synth.params).toEqual(first);
  });

  it('MUTATE KIT is one undo step and never touches samples, source modes, patterns or tempo', async () => {
    const app = new App();
    const before = JSON.parse(JSON.stringify({ tracks: app.project.tracks.map((t) => ({ ...t.sound, mod: undefined })), patterns: app.project.patterns, tempo: app.project.tempo }));
    const kit0 = app.project.kit.synth.params.slice();
    app.setKitGen({ wildness: 0.9 });
    await app.mutateKit();
    const after = JSON.parse(JSON.stringify({ tracks: app.project.tracks.map((t) => ({ ...t.sound, mod: undefined })), patterns: app.project.patterns, tempo: app.project.tempo }));
    expect(after).toEqual(before);
    expect(app.project.kit.synth.params).not.toEqual(kit0);
    expect(app.history.undoLabel).toBe('MUTATE KIT');
    app.undo();
    expect(app.project.kit.synth.params).toEqual(kit0);
  });

  it('NEW VOICE with a profile override designs one voice only and remembers the override', async () => {
    const app = new App();
    // the engine check as the app runs it (a Worker in the browser)
    app.kits = { check: async (kit: SynthKit, o: Parameters<typeof checkKit>[2]) => checkKit(newLxr(), kit, { ...o, fallback: init }).kit } as never;
    app.project.kit.synth = gen(5, 'classic', 0.2);
    const kit0 = app.project.kit.synth.params.slice();
    app.setKitGen({ hold: true, seed: 31337, wildness: 0.2 });
    await app.generateVoice(0, 'cymbal');
    expect(app.kitGen.profiles[0]).toBe('cymbal');
    expect(app.project.kit.gen?.op).toBe('voice');
    for (const v of [1, 2, 3, 4, 5]) for (const p of Object.values(voiceKeys(v))) if (p !== undefined) expect(app.project.kit.synth.params[p]).toBe(kit0[p]);
    // a cymbal-like sound on the kick voice: bright, not a kick
    const f = analyse(renderTrigger(e, app.project.kit.synth, 0, 1.5));
    expect(f.centroid).toBeGreaterThan(2500);
  });

  it('WILDCARD still transforms the whole instrument (tempo included); GENERATE KIT never touches the tempo', async () => {
    const app = new App();
    app.initKit = init;
    app.setKitGen({ wildness: 1, character: 'experimental' });
    const tempo = app.project.tempo;
    const pat = JSON.stringify(app.project.patterns);
    await app.generateKit();
    expect(app.project.tempo).toBe(tempo);
    expect(JSON.stringify(app.project.patterns)).toBe(pat);
    app.prefs.wildcard = { ...defaultWild(), intensity: 100, seed: 4242, fixed: true };
    app.wildcard();
    expect(app.history.undoLabel).toBe('WILDCARD');
    expect(app.project.tempo).not.toBe(tempo);
  });

  it('older projects and kits load unchanged: no generation settings, the same sound', () => {
    const app = new App();
    app.project.kit.synth = gen(8, 'industrial', 0.6);
    const old = JSON.parse(serialize(app.project));
    delete old.kitGen;
    delete old.kit.gen;
    const back = parseProject(JSON.stringify(old));
    expect(back.kitGen).toBeUndefined();
    expect(back.kit.gen).toBeUndefined();
    expect(back.kit.synth.params).toEqual(app.project.kit.synth.params);
    // with settings: they round-trip
    app.setKitGen({ character: 'minimal', wildness: 0.66, profiles: ['fx', null, null, null, null, null] });
    expect(parseProject(serialize(app.project)).kitGen).toEqual(app.project.kitGen);
    expect(repairKitGen({ character: 'nope', wildness: 9 })).toEqual({ ...defaultKitGen(), wildness: 1 });
    void CHARACTER_DEFS;
  });

  it('the fundamental estimator finds a sine’s pitch', () => {
    const x = Float32Array.from({ length: 4410 }, (_, i) => Math.sin((2 * Math.PI * 110 * i) / 44100));
    expect(fundamental(x, 44100, 0, 4000)).toBeCloseTo(110, 0);
  });
});

void (null as unknown as Profile);
