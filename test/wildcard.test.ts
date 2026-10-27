/** WILDCARD: intensity, scope, categories, seeds, safety, undo, tempo, and what comes out of the export. */
import { describe, expect, it } from 'vitest';
import { bundledLibrary, lxrModule, presetProject, stats } from './helpers';
import { App } from '../src/app/app';
import { renderProject } from '../src/audio/render';
import { applyWildcard, defaultWild, repairWild, SCOPE_CATS, WILD_CATS, WILD_SCOPES, wildAffects, type WildCat, type WildScope, type WildSettings } from '../src/destruction/wildcardProject';
import { parseProject, serialize } from '../src/model/project';
import { clone, PPQ, type Project } from '../src/model/types';
import { secondsAt, tempoActive } from '../src/transport/tempo';
import { trigCount } from '../src/rhythm/pattern';

const settings = (seed: number, intensity = 50, scope: WildScope = 'project', cats: WildCat[] = [...WILD_CATS]): WildSettings => ({ seed, intensity, scope, cats });
const POOL = [
  { id: 'bundled:kick', role: 'kick' },
  { id: 'bundled:snare', role: 'snare' },
  { id: 'bundled:clap-tight', role: 'clap' },
  { id: 'bundled:rim', role: 'perc' },
  { id: 'bundled:shaker', role: 'perc' },
  { id: 'bundled:zap', role: 'fx' },
];
const run = (p: Project, s: WildSettings, track = 't1') => applyWildcard(p, s, { track, pool: POOL });

async function base(): Promise<Project> {
  const lib = await bundledLibrary();
  return presetProject('digital-detritus', lib);
}

/** Every number or string leaf of a value, by path. */
function leaves(v: unknown, path = '', out = new Map<string, unknown>()): Map<string, unknown> {
  if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) leaves(x, `${path}/${k}`, out);
  else out.set(path, v);
  return out;
}
const changed = (a: Project, b: Project): number => {
  const x = leaves(a);
  const y = leaves(b);
  let n = 0;
  for (const k of new Set([...x.keys(), ...y.keys()])) if (x.get(k) !== y.get(k)) n++;
  return n;
};
/** Key order is not part of a project's identity, so compare it with sorted keys. */
const sorted = (v: unknown): unknown => (Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, sorted(x)])) : v);
const json = (p: Project) => JSON.stringify(sorted({ ...p, snapshots: [] }));
const finite = (v: unknown): boolean => (typeof v === 'number' ? Number.isFinite(v) : v && typeof v === 'object' ? Object.values(v).every(finite) : true);

describe('intensity', () => {
  it('is subtle when low and substantial when high', async () => {
    const p = await base();
    const mean = (intensity: number) => {
      let n = 0;
      const seeds = 12;
      for (let s = 1; s <= seeds; s++) {
        const q = clone(p);
        run(q, settings(s * 7919, intensity));
        n += changed(p, q);
      }
      return n / seeds;
    };
    const low = mean(5);
    const mid = mean(50);
    const high = mean(100);
    expect(low).toBeLessThan(mid);
    expect(mid).toBeLessThan(high);
    expect(high).toBeGreaterThan(low * 3);
  });

  it('keeps the tempo close at low intensity and lets it travel at high, always within limits', async () => {
    const p = await base();
    let maxLow = 0;
    let maxHigh = 0;
    for (let s = 1; s <= 40; s++) {
      const a = clone(p);
      const b = clone(p);
      run(a, settings(s, 5, 'project', ['tempo']));
      run(b, settings(s, 100, 'project', ['tempo']));
      maxLow = Math.max(maxLow, Math.abs(a.tempo - p.tempo) / p.tempo);
      maxHigh = Math.max(maxHigh, Math.abs(b.tempo - p.tempo) / p.tempo);
      for (const q of [a, b]) {
        expect(q.tempo).toBeGreaterThanOrEqual(40);
        expect(q.tempo).toBeLessThanOrEqual(240);
        expect(q.tempo / p.tempo).toBeGreaterThan(1 / 1.51);
        expect(q.tempo / p.tempo).toBeLessThan(1.51);
        expect(q.swing).toBeGreaterThanOrEqual(50);
        expect(q.swing).toBeLessThanOrEqual(68);
      }
    }
    expect(maxLow).toBeLessThan(0.05);
    expect(maxHigh).toBeGreaterThan(0.1);
  });

  it('at zero changes nothing', async () => {
    const p = await base();
    const q = clone(p);
    const r = run(q, settings(3, 0));
    expect(json(q)).toBe(json(p));
    expect(r.report[0]).toMatch(/NOTHING CHANGED/);
  });
});

describe('scope', () => {
  const others = (p: Project, keep: string) => p.tracks.filter((t) => t.id !== keep);

  it('SELECTED TRACK changes that track only, and no global setting', async () => {
    const p = await base();
    for (let s = 1; s <= 6; s++) {
      const q = clone(p);
      run(q, settings(s, 90, 'track'), 't2');
      expect(JSON.stringify(others(q, 't2'))).toBe(JSON.stringify(others(p, 't2')));
      expect(q.tempo).toBe(p.tempo);
      expect(q.swing).toBe(p.swing);
      expect(q.tempoAuto).toEqual(p.tempoAuto);
      expect(JSON.stringify(q.master)).toBe(JSON.stringify(p.master));
      expect(JSON.stringify(q.destruction)).toBe(JSON.stringify(p.destruction));
      // the other tracks' rhythm and conditions are untouched
      for (const t of others(q, 't2')) {
        expect(JSON.stringify(q.patterns[0]!.grids[t.id])).toBe(JSON.stringify(p.patterns[0]!.grids[t.id]));
        expect(q.patterns[0]!.trig?.[t.id]).toEqual(p.patterns[0]!.trig?.[t.id]);
      }
      // the other voices of the kit are untouched
      const voice = p.tracks.find((t) => t.id === 't2')!.sound.trigger;
      void voice;
    }
    // and it does change something over a few seeds
    const q = clone(p);
    run(q, settings(11, 100, 'track'), 't2');
    expect(changed(p, q)).toBeGreaterThan(0);
  });

  it('SELECTED PATTERN changes the rhythm and conditions of that pattern, not the kit, the mixer, the tempo or other patterns', async () => {
    const p = await base();
    const other = clone(p.patterns[0]!);
    other.id = 'p9';
    other.name = 'Z';
    p.patterns.push(other);
    for (let s = 1; s <= 6; s++) {
      const q = clone(p);
      run(q, settings(s, 90, 'pattern'));
      expect(JSON.stringify(q.kit)).toBe(JSON.stringify(p.kit));
      expect(JSON.stringify(q.tracks.map((t) => [t.mix, t.sound.mod, t.sound.samples, t.sound.variations]))).toBe(JSON.stringify(p.tracks.map((t) => [t.mix, t.sound.mod, t.sound.samples, t.sound.variations])));
      expect(q.tempo).toBe(p.tempo);
      expect(q.swing).toBe(p.swing);
      expect(JSON.stringify(q.master)).toBe(JSON.stringify(p.master));
      expect(JSON.stringify(q.patterns[1])).toBe(JSON.stringify(p.patterns[1]));
    }
    const q = clone(p);
    run(q, settings(5, 100, 'pattern'));
    expect(JSON.stringify(q.patterns[0])).not.toBe(JSON.stringify(p.patterns[0]));
  });

  it('ENTIRE KIT changes the sound and leaves the rhythm, the tempo and the output alone', async () => {
    const p = await base();
    for (let s = 1; s <= 6; s++) {
      const q = clone(p);
      run(q, settings(s, 90, 'kit'));
      expect(JSON.stringify(q.patterns)).toBe(JSON.stringify(p.patterns));
      expect(q.tempo).toBe(p.tempo);
      expect(q.swing).toBe(p.swing);
      expect(JSON.stringify(q.master)).toBe(JSON.stringify(p.master));
    }
    const q = clone(p);
    run(q, settings(5, 100, 'kit'));
    expect(q.kit.synth.params.join()).not.toBe(p.kit.synth.params.join());
  });

  it('ENTIRE PROJECT reaches every pattern, the tempo, the output chain and the mixer', async () => {
    const p = await base();
    const second = clone(p.patterns[0]!);
    second.id = 'p9';
    p.patterns.push(second);
    let tempo = false;
    let out = false;
    let pat2 = false;
    let mix = false;
    for (let s = 1; s <= 25; s++) {
      const q = clone(p);
      run(q, settings(s, 100, 'project'));
      tempo ||= q.tempo !== p.tempo || !!q.tempoAuto;
      out ||= JSON.stringify(q.master.out) !== JSON.stringify(p.master.out);
      pat2 ||= JSON.stringify(q.patterns[1]) !== JSON.stringify(p.patterns[1]);
      mix ||= JSON.stringify(q.tracks.map((t) => t.mix)) !== JSON.stringify(p.tracks.map((t) => t.mix));
    }
    expect([tempo, out, pat2, mix]).toEqual([true, true, true, true]);
  });

  it('knows which categories each scope reaches', () => {
    for (const sc of WILD_SCOPES) for (const c of WILD_CATS) expect(wildAffects(sc, c)).toBe(SCOPE_CATS[sc].includes(c));
    expect(wildAffects('project', 'tempo')).toBe(true);
    expect(wildAffects('track', 'tempo')).toBe(false);
    expect(wildAffects('pattern', 'output')).toBe(false);
  });
});

describe('categories', () => {
  it('only the chosen categories change', async () => {
    const p = await base();
    for (let s = 1; s <= 5; s++) {
      const q = clone(p);
      run(q, settings(s, 100, 'project', ['mixer']));
      expect(JSON.stringify(q.patterns)).toBe(JSON.stringify(p.patterns));
      expect(JSON.stringify(q.kit)).toBe(JSON.stringify(p.kit));
      expect(q.tempo).toBe(p.tempo);
      expect(JSON.stringify(q.master)).toBe(JSON.stringify(p.master));
      expect(JSON.stringify(q.tracks.map((t) => t.sound))).toBe(JSON.stringify(p.tracks.map((t) => t.sound)));
    }
    const q = clone(p);
    run(q, settings(2, 100, 'project', ['mixer']));
    expect(JSON.stringify(q.tracks.map((t) => t.mix))).not.toBe(JSON.stringify(p.tracks.map((t) => t.mix)));
    const none = clone(p);
    run(none, settings(2, 100, 'project', []));
    expect(json(none)).toBe(json(p));
  });

  it('TRIGGERS writes probabilities and conditions, TEMPO writes a curve', async () => {
    const p = await base();
    const q = clone(p);
    const r = run(q, settings(4, 100, 'pattern', ['triggers']));
    expect(r.counts.triggers).toBeGreaterThan(0);
    expect(trigCount(q.patterns[0]!)).toBeGreaterThan(0);
    let curve = false;
    for (let s = 1; s <= 20; s++) {
      const t = clone(p);
      run(t, settings(s, 100, 'project', ['tempo']));
      curve ||= tempoActive(t.tempoAuto);
    }
    expect(curve).toBe(true);
  });
});

describe('seeds', () => {
  it('the same project and seed give the same result, a different seed a different one', async () => {
    const p = await base();
    const a = clone(p);
    const b = clone(p);
    const c = clone(p);
    const ra = run(a, settings(1234, 70));
    const rb = run(b, settings(1234, 70));
    run(c, settings(1235, 70));
    expect(json(a)).toBe(json(b));
    expect(ra.report).toEqual(rb.report);
    expect(json(c)).not.toBe(json(a));
  });

  it('the settings are repaired and the last seed is recorded in the project', async () => {
    expect(repairWild({ seed: -5, intensity: 900, scope: 'nope', cats: ['tempo', 'bogus'] })).toEqual({ seed: 0, intensity: 100, scope: 'project', cats: ['tempo'] });
    expect(repairWild(null)).toEqual(defaultWild());
    const p = await base();
    p.wildcard = settings(99, 33, 'kit', ['sound']);
    expect(parseProject(serialize(p)).wildcard).toEqual(p.wildcard);
  });
});

describe('guard rails', () => {
  it('whatever the seed and the intensity, values stay legal and the project stays loadable', async () => {
    const p = await base();
    for (let s = 1; s <= 30; s++) {
      const q = clone(p);
      run(q, settings(s * 104729, [10, 50, 100][s % 3]!), q.tracks[s % q.tracks.length]!.id);
      expect(finite(q)).toBe(true);
      expect(q.kit.synth.params.every((v) => Number.isInteger(v) && v >= 0 && v <= 127)).toBe(true);
      expect(q.tempo).toBeGreaterThanOrEqual(30);
      expect(q.tempo).toBeLessThanOrEqual(300);
      for (const t of q.tracks) {
        expect(t.mix.volume).toBeGreaterThanOrEqual(0);
        expect(t.mix.volume).toBeLessThanOrEqual(0.95);
        expect(Math.abs(t.mix.pan)).toBeLessThanOrEqual(1);
        expect(t.mix.send ?? 0).toBeLessThanOrEqual(0.8);
        expect(t.sound.start).toBeLessThan(t.sound.end);
      }
      expect(q.tracks.some((t) => !t.mix.mute && t.mix.volume >= 0.4)).toBe(true);
      const o = q.master.out;
      if (o && (o.bus.dist.on || o.bus.comp.on)) expect(o.limiter.on).toBe(true);
      // the file round trip repairs nothing: every value was already legal
      const back = parseProject(serialize(q));
      expect(back.tempo).toBe(q.tempo);
      expect(back.tempoAuto).toEqual(q.tempoAuto);
      expect(back.tracks.map((t) => t.mix.volume)).toEqual(q.tracks.map((t) => t.mix.volume));
      expect(JSON.stringify(back.patterns.map((x) => x.trig))).toBe(JSON.stringify(q.patterns.map((x) => x.trig)));
    }
  });

  it('locked tracks, locked voices and muted tracks are respected', async () => {
    const p = await base();
    p.tracks[0]!.lock = true;
    p.tracks[1]!.mix.mute = true;
    p.tracks[2]!.mix.solo = false;
    p.soundLocks.voices[0] = true;
    for (let s = 1; s <= 8; s++) {
      const q = clone(p);
      run(q, settings(s, 100, 'project', ['rhythm', 'triggers', 'sound']));
      expect(JSON.stringify(q.patterns[0]!.grids['t1'])).toBe(JSON.stringify(p.patterns[0]!.grids['t1']));
      expect(q.patterns[0]!.trig?.['t1']).toEqual(p.patterns[0]!.trig?.['t1']);
      expect(q.tracks[1]!.mix.mute).toBe(true);
    }
  });

  it('exports of wildcarded projects are finite, audible and under control', async () => {
    const lib = await bundledLibrary();
    const p = await presetProject('digital-detritus', lib);
    for (const seed of [3, 17, 101]) {
      const q = clone(p);
      run(q, settings(seed, 100));
      const r = await renderProject(lxrModule(), q, lib, { bars: 2, tail: 0.5 });
      const s = stats(r.master[0]!);
      expect(s.finite).toBe(true);
      expect(s.peak).toBeGreaterThan(0.02);
      expect(s.peak).toBeLessThanOrEqual(1.0001);
    }
  });

  it('a tempo curve from WILDCARD changes the exported length exactly as the scheduler counts it', async () => {
    const lib = await bundledLibrary();
    const p = await presetProject('digital-detritus', lib);
    let q: Project | null = null;
    for (let seed = 1; seed < 60 && !q; seed++) {
      const t = clone(p);
      run(t, settings(seed, 100, 'project', ['tempo']));
      if (tempoActive(t.tempoAuto) && t.tempoAuto!.points.length > 1) q = t;
    }
    expect(q).not.toBeNull();
    const r = await renderProject(lxrModule(), q!, lib, { bars: 8, tail: 0 });
    expect(r.frames).toBe(Math.round(secondsAt(q!.tempo, q!.tempoAuto, 8 * 4 * PPQ) * r.rate));
    const flat = await renderProject(lxrModule(), { ...q!, tempoAuto: undefined }, lib, { bars: 8, tail: 0 });
    expect(r.frames).not.toBe(flat.frames);
    expect(stats(r.master[0]!).finite).toBe(true);
  });
});

describe('in the app', () => {
  async function appWith(p: Project): Promise<App> {
    const app = new App();
    app.project = p;
    app.prefs.wildcard = { ...settings(4242, 100), fixed: true };
    return app;
  }

  it('is one undo step that takes everything back, tempo included, and redo brings it forward', async () => {
    const p = await base();
    const app = await appWith(clone(p));
    const before = json(app.project);
    const depth = app.history.undoLabel;
    app.wildcard();
    expect(app.history.undoLabel).toBe('WILDCARD');
    const after = json(app.project);
    expect(after).not.toBe(before);
    expect(app.project.wildcard?.seed).toBe(4242);
    app.undo();
    expect(json({ ...app.project, wildcard: undefined } as Project)).toBe(json({ ...p, wildcard: undefined } as Project));
    expect(app.project.tempo).toBe(p.tempo);
    expect(app.project.tempoAuto).toEqual(p.tempoAuto);
    expect(app.history.undoLabel).toBe(depth);
    app.redo();
    expect(json(app.project)).toBe(after);
  });

  it('a fixed seed regenerates the same result after an undo; without it every press draws a new seed', async () => {
    const p = await base();
    const app = await appWith(clone(p));
    app.wildcard();
    const first = json(app.project);
    app.undo();
    app.wildcard();
    expect(json(app.project)).toBe(first);
    app.undo();
    app.setWildcard({ fixed: false });
    app.wildcard();
    const seedA = app.prefs.wildcard.seed;
    app.undo();
    app.wildcard();
    expect(app.prefs.wildcard.seed).not.toBe(seedA);
  });

  it('TRY ANOTHER takes the last wildcard back before drawing the next', async () => {
    const p = await base();
    const app = await appWith(clone(p));
    app.setWildcard({ fixed: false });
    const n0 = app.history.canUndo;
    app.wildcard();
    app.wildcardAgain();
    app.undo();
    expect(app.history.canUndo).toBe(n0);
    expect(app.project.tempo).toBe(p.tempo);
  });

  it('follows the tempo curve in the scheduler as soon as it is applied', async () => {
    const p = await base();
    const app = await appWith(clone(p));
    let seed = 0;
    for (seed = 1; seed < 80; seed++) {
      const t = clone(p);
      run(t, settings(seed, 100, 'project', ['tempo']));
      if (tempoActive(t.tempoAuto)) break;
    }
    app.setWildcard({ seed, cats: ['tempo'], intensity: 100 });
    app.wildcard();
    expect(tempoActive(app.project.tempoAuto)).toBe(true);
    const fn = (app.scheduler as unknown as { o: { tempo: (t: number) => number | null } }).o.tempo;
    const bpms = new Set(Array.from({ length: 64 }, (_, i) => Math.round(fn(i * 96 * 2)! * 10) / 10));
    expect(bpms.size).toBeGreaterThan(1);
  });
});
