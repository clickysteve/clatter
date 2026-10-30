/**
 * Persistence and compatibility of the SOUND overhaul: projects from before it open and sound as
 * they did, the new fields round-trip and are repaired, the modulation presets are kept, and
 * synth kits carry the modulation of the tracks.
 */
import { describe, expect, it } from 'vitest';
import { newLxr } from './helpers';
import { outputOf, modsOf } from '../src/app/soundConfig';
import { ModLibrary } from '../src/mod/library';
import { diffMod, repairMod } from '../src/mod/config';
import { buildRecipe } from '../src/mod/presets';
import { defaultProject } from '../src/model/defaults';
import { applyVoices, parseSynthKit, serializeSynthKit, synthKitOf } from '../src/model/kits';
import { parseProject, ProjectError, repairProject, serialize } from '../src/model/project';
import { defaultChannelFx, legacyOutputFx } from '../src/audio/mixfx';
import { readKit } from '../src/sound/kitcheck';

const init = readKit(newLxr(1));
const target = { mode: 'synth' as const, voice: 0 };

describe('projects from before the overhaul', () => {
  const legacy = (version: 1 | 2) => {
    const p = JSON.parse(serialize(defaultProject()));
    p.version = version;
    delete p.macros;
    delete p.master.out;
    for (const t of p.tracks) {
      delete t.sound.mod;
      delete t.mix.fx;
      delete t.mix.send;
    }
    return p;
  };

  it('open at version 3 without modulation, processing or a limiter, and sound the same', () => {
    for (const v of [1, 2] as const) {
      const p = parseProject(JSON.stringify(legacy(v)), init);
      expect(p.version).toBe(9);
      expect(p.tracks.every((t) => !t.sound.mod && !t.mix.fx)).toBe(true);
      expect(p.master.out).toBeUndefined();
      expect(outputOf(p)).toEqual(legacyOutputFx());
      expect(outputOf(p).limiter.on).toBe(false);
      expect(outputOf(p).width).toBe(1);
      expect(p.tracks.map((t) => modsOf(t.sound))).toEqual(p.tracks.map(() => []));
    }
  });

  it('a project from a newer CLATTER is refused with a message', () => {
    expect(() => repairProject({ ...legacy(2), version: 10 }, init)).toThrow(ProjectError);
  });

  it('new projects get the limiter, old ones do not', () => {
    expect(outputOf(defaultProject()).limiter.on).toBe(true);
  });
});

describe('modulation in a project file', () => {
  it('base modulation, variation patches, macros, channel processing and the output stage round-trip', () => {
    const p = defaultProject();
    const t = p.tracks[0]!;
    t.sound.mod = buildRecipe('wobble', target);
    const edited = JSON.parse(JSON.stringify(t.sound.mod));
    edited.routes[0].amt = -0.6;
    edited.sources.lfo2 = { ...edited.sources.lfo1, wave: 'saw' };
    t.sound.variations = [null, { name: 'DEEP', params: {}, mod: diffMod(t.sound.mod, repairMod(edited)!) }, null, null];
    p.macros = [0.25, 0.5, 0, 1];
    t.mix.fx = { ...defaultChannelFx(), sat: { on: true, drive: 0.6, mix: 0.7 } };
    t.mix.send = 0.4;
    p.master.out = { bus: { ...outputOf(p).bus, comp: { ...outputOf(p).bus.comp, on: true } }, width: 1.3, limiter: { on: true, ceiling: -1, release: 60 } };
    const text = serialize(p);
    const q = parseProject(text, init);
    expect(serialize(parseProject(serialize(q), init))).toBe(serialize(q));
    expect(q.tracks[0]!.sound.mod).toEqual(t.sound.mod);
    expect(q.tracks[0]!.sound.variations![1]!.mod).toEqual(t.sound.variations[1]!.mod);
    expect(q.macros).toEqual([0.25, 0.5, 0, 1]);
    expect(q.tracks[0]!.mix.fx).toEqual(t.mix.fx);
    expect(q.tracks[0]!.mix.send).toBe(0.4);
    expect(q.master.out).toEqual(p.master.out);
    const mods = modsOf(q.tracks[0]!.sound);
    expect(mods).toHaveLength(5);
    expect(mods[0]).not.toBeNull();
    expect(mods[1]).toBeNull();
    expect(mods[2]!.routes[0]!.amt).toBe(-0.6);
  });

  it('a variation without modulation overrides plays the base; nothing leaks between slots', () => {
    const p = defaultProject();
    const t = p.tracks[0]!;
    t.sound.mod = buildRecipe('wobble', target);
    t.sound.variations = [{ name: 'A', params: { 1: 5 } }, null, null, null];
    const mods = modsOf(t.sound);
    expect(mods[1]).toBeNull();
    expect(mods[0]!.routes).toHaveLength(t.sound.mod.routes.length);
  });

  it('hostile modulation data is repaired or dropped', () => {
    const p = JSON.parse(serialize(defaultProject()));
    p.tracks[0].sound.mod = {
      sources: { lfo1: { type: 'lfo', hz: 1e9, depth: 5, wave: 'nonsense' }, bogus: { type: 'lfo' }, env1: 'x' },
      routes: [
        { id: 'a', src: 'lfo1', dst: 'lxr.filter.cutoff', amt: 99, lo: 3, hi: -3 },
        { id: 'a', src: 'lfo1', dst: 'lxr.filter.cutoff', amt: -99 },
        { id: 'b', src: 'nope', dst: 'lxr.filter.cutoff' },
        { id: 'c', src: 'lfo1', dst: 'made.up.destination' },
        'x',
      ],
    };
    p.macros = [9, -1, 'x', null];
    p.tracks[1].mix.fx = { sat: { on: true, drive: 50, mix: -4 }, crush: { on: true, bits: 99, rate: 'x' } };
    p.master.out = { width: 50, limiter: { on: true, ceiling: 40, release: -1 }, bus: { comp: { on: true, ratio: 1000, thresh: 99 } } };
    const r = repairProject(p, init);
    const m = r.tracks[0]!.sound.mod!;
    expect(Object.keys(m.sources)).toEqual(['lfo1']);
    const lfo = m.sources.lfo1 as { hz: number; depth: number; wave: string };
    expect(lfo.hz).toBeLessThanOrEqual(100);
    expect(lfo.depth).toBe(1);
    expect(lfo.wave).toBe('sine');
    expect(m.routes.map((x) => x.id)).toEqual(['a', 'ax']);
    expect(m.routes.every((x) => Math.abs(x.amt) <= 1 && x.lo <= x.hi)).toBe(true);
    expect(r.macros!.every((v) => v >= 0 && v <= 1)).toBe(true);
    expect(r.tracks[1]!.mix.fx!.sat.drive).toBeLessThanOrEqual(1);
    expect(r.tracks[1]!.mix.fx!.crush.bits).toBeLessThanOrEqual(16);
    expect(r.master.out!.width).toBeLessThanOrEqual(2);
    expect(r.master.out!.limiter.ceiling).toBeLessThanOrEqual(0);
    expect(r.master.out!.bus.comp.ratio).toBeLessThanOrEqual(20);
  });
});

describe('modulation presets', () => {
  const memory = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  };

  it('save, duplicate, rename, delete, export and import', () => {
    const store = memory();
    const lib = new ModLibrary(store);
    const mod = buildRecipe('wobble', target);
    const a = lib.save('my wobble', mod);
    expect(a.name).toBe('MY WOBBLE');
    const b = lib.save('my wobble', mod);
    expect(b.name).not.toBe(a.name);
    const c = lib.duplicate(a.id)!;
    expect(c.mod).toEqual(a.mod);
    lib.rename(c.id, 'Renamed');
    expect(lib.get(c.id)!.name).toBe('RENAMED');
    const file = lib.exportOne(a.id)!;
    expect(JSON.parse(file).format).toBe('clatter-mod');
    const imported = lib.import(file);
    expect(imported.mod).toEqual(a.mod);
    lib.remove(b.id);
    expect(lib.get(b.id)).toBeUndefined();
    // a restart keeps them
    const again = new ModLibrary(store);
    expect(again.list().map((p) => p.name)).toEqual(lib.list().map((p) => p.name));
  });

  it('survives a broken store and refuses foreign files', () => {
    const lib = new ModLibrary({ getItem: () => '{not json', setItem: () => undefined });
    expect(lib.list()).toEqual([]);
    expect(() => lib.import('{"format":"something-else"}')).toThrow(/modulation/i);
    expect(() => lib.import('nope')).toThrow(/JSON/);
    expect(() => lib.import('{"format":"clatter-mod","version":99,"mod":{}}')).toThrow(/newer/);
  });
});

describe('kits carry modulation', () => {
  it('a synth kit file keeps each track’s modulation and variation patches and loads them back', () => {
    const p = defaultProject();
    const kick = p.tracks[0]!;
    kick.sound.mod = buildRecipe('wobble', target);
    kick.sound.variations = [{ name: 'X', params: {}, mod: { routes: { r1: { amt: -0.5 } } } }, null, null, null];
    const text = serializeSynthKit(synthKitOf(p));
    const data = parseSynthKit(text, init);
    const q = defaultProject();
    applyVoices(q, data.voices);
    expect(q.tracks[0]!.sound.mod).toEqual(kick.sound.mod);
    expect(q.tracks[0]!.sound.variations![0]!.mod).toEqual(kick.sound.variations[0]!.mod);
  });

  it('a synth kit from before modulation loads and leaves a track’s modulation alone', () => {
    const p = defaultProject();
    const data = JSON.parse(serializeSynthKit(synthKitOf(p)));
    data.version = 1;
    for (const v of Object.values<{ mod?: unknown }>(data.voices)) delete v.mod;
    const q = defaultProject();
    q.tracks[0]!.sound.mod = buildRecipe('wobble', target);
    applyVoices(q, parseSynthKit(JSON.stringify(data), init).voices);
    expect(q.tracks[0]!.sound.mod).toBeDefined();
  });
});
