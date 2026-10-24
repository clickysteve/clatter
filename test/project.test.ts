/** Projects, presets, kits and undo: save and load round-trips, defensive repair, history. */
import { describe, expect, it } from 'vitest';
import { bundledLibrary, newLxr, presetProject } from './helpers';
import { parseProject, ProjectError, repairProject, serialize } from '../src/model/project';
import { PRESETS } from '../src/model/presets';
import { kitOf, readKitFile, writeKitFile } from '../src/model/kitFile';
import { readKit } from '../src/sound/kitcheck';
import { History } from '../src/app/history';
import { defaultProject } from '../src/model/defaults';
import { setHit, sourceGrid } from '../src/rhythm/pattern';

const init = readKit(newLxr(1));

describe('project files', () => {
  it('round-trip exactly (patterns, edits, kit, mixer, transformations)', async () => {
    const lib = await bundledLibrary();
    const p = await presetProject('wrong-answers', lib);
    const t = p.tracks[2]!.id;
    setHit(p.patterns[0]!, t, 3, { vel: 77, prob: 40, ratchet: 3 });
    p.tracks[4]!.mix.volume = 0.5;
    const text = serialize(p);
    const q = parseProject(text, init);
    expect(JSON.parse(serialize(q))).toEqual(JSON.parse(text));
    expect(sourceGrid(q.patterns[0]!, t)[3]).toEqual({ vel: 77, prob: 40, ratchet: 3 });
  });

  it('repairs damaged or hostile data instead of failing', () => {
    const p = JSON.parse(serialize(defaultProject()));
    p.tempo = 'fast';
    p.swing = 400;
    p.tracks[0].sound.trigger = 99;
    p.tracks[1].mix.volume = -3;
    p.patterns[0].steps = 10000;
    p.patterns[0].gen.t1 = 'nonsense';
    p.kit.synth.params = [1, 2, 3];
    p.current = 'missing';
    const r = repairProject(p, init);
    expect(r.tempo).toBeGreaterThanOrEqual(30);
    expect(r.swing).toBeLessThanOrEqual(75);
    expect(r.tracks[0]!.sound.trigger).toBeLessThanOrEqual(6);
    expect(r.tracks[1]!.mix.volume).toBeGreaterThanOrEqual(0);
    expect(r.patterns[0]!.steps).toBeLessThanOrEqual(64);
    expect(r.kit.synth.params.length).toBe(init.params.length);
    expect(r.patterns.some((x) => x.id === r.current)).toBe(true);
  });

  it('rejects files that are not CLATTER projects', () => {
    expect(() => parseProject('{"format":"something-else"}', init)).toThrow(ProjectError);
    expect(() => parseProject('not json', init)).toThrow(ProjectError);
  });
});

describe('presets', () => {
  it('there are eight, and each is a different piece of music with a different kit', async () => {
    const lib = await bundledLibrary();
    expect(PRESETS.length).toBe(8);
    const built = await Promise.all(PRESETS.map((s) => presetProject(s.id, lib)));
    const kits = new Set(built.map((p) => p.kit.synth.params.join(',')));
    const pats = new Set(built.map((p) => JSON.stringify(p.patterns[0]!.gen)));
    expect(kits.size).toBe(8);
    expect(pats.size).toBe(8);
    for (const p of built) for (const t of p.tracks) for (const id of t.sound.samples) expect(lib.get(id), `${p.name} ${t.name}`).toBeDefined();
  });

  it('are deterministic', async () => {
    const lib = await bundledLibrary();
    const a = await presetProject('broken-clock', lib);
    const b = await presetProject('broken-clock', lib);
    expect(JSON.parse(serialize(a))).toEqual(JSON.parse(serialize(b)));
  });
});

describe('kit files', () => {
  it('carry the synthesis kit, every track source and the samples', async () => {
    const lib = await bundledLibrary();
    const p = await presetProject('dusty-breaks', lib);
    const kit = kitOf(p);
    const ids = Object.values(kit.sounds).flatMap((s) => s.samples);
    expect(ids.length).toBeGreaterThan(0);
    const bytes = writeKitFile(kit, lib.stored(ids));
    const r = await readKitFile(bytes);
    expect(r.kit.synth.params).toEqual(kit.synth.params);
    expect(r.kit.sounds).toEqual(kit.sounds);
    expect(new Set(r.samples.map((s) => s.id))).toEqual(new Set(ids));
  });
});

describe('history', () => {
  it('undoes and redoes; a gesture (even around nested steps) is one step', () => {
    let state = { v: 0 };
    const h = new History(
      () => ({ ...state }),
      (s) => (state = { ...s }),
    );
    h.push('A');
    state.v = 1;
    h.begin('DRAG');
    for (let i = 2; i < 6; i++) {
      h.begin('INNER');
      state.v = i;
      h.commit();
    }
    h.commit();
    expect(state.v).toBe(5);
    expect(h.undo()).toBe('DRAG');
    expect(state.v).toBe(1);
    expect(h.undo()).toBe('A');
    expect(state.v).toBe(0);
    expect(h.redo()).toBe('A');
    expect(h.redo()).toBe('DRAG');
    expect(state.v).toBe(5);
    expect(h.canRedo).toBe(false);
  });
});
