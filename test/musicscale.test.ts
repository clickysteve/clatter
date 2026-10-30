/** Musical scales: the shared definitions, quantising a note, root transposition, per-track overrides and the stored settings. */
import { describe, expect, it } from 'vitest';
import { SCALES } from '../src/export/notes';
import { defaultProject } from '../src/model/defaults';
import { parseProject, repairProject, serialize } from '../src/model/project';
import {
  DEFAULT_USER_MASK,
  PITCHED_ROLES,
  SCALE_TYPES,
  cleanMask,
  defaultGlobalScale,
  defaultModeFor,
  describeScale,
  distanceToScale,
  inScale,
  maskOfSteps,
  nearestInMask,
  nearestInScale,
  normaliseScale,
  notesInRange,
  parseRoot,
  pitchClasses,
  quantiseOffset,
  quantiseOffsetMask,
  absMask,
  repairGlobalScale,
  repairTrackScale,
  sameScale,
  scaleSteps,
  scaleType,
  shortScale,
  stepsOfMask,
  trackScaleState,
  type ScaleSpec,
} from '../src/music/scale';

const REQUIRED = ['chromatic', 'major', 'minor', 'harmonicMinor', 'majorPentatonic', 'minorPentatonic', 'dorian', 'phrygian', 'lydian', 'mixolydian', 'wholeTone', 'user'];

describe('the shared scale definitions', () => {
  it('has every scale the brief asks for, and the user scale', () => {
    for (const id of REQUIRED) expect(SCALE_TYPES.some((s) => s.id === id)).toBe(true);
    expect(SCALE_TYPES.filter((s) => s.menu).map((s) => s.id)).toEqual(REQUIRED);
  });

  it('defines each as ascending steps from the root inside one octave', () => {
    for (const t of SCALE_TYPES) {
      expect(t.steps[0]).toBe(0);
      expect([...t.steps].sort((a, b) => a - b)).toEqual(t.steps);
      expect(new Set(t.steps).size).toBe(t.steps.length);
      for (const s of t.steps) expect(s >= 0 && s < 12).toBe(true);
    }
  });

  it('gets the intervals right', () => {
    expect(scaleType('chromatic').steps).toHaveLength(12);
    expect(scaleType('major').steps).toEqual([0, 2, 4, 5, 7, 9, 11]);
    expect(scaleType('minor').steps).toEqual([0, 2, 3, 5, 7, 8, 10]);
    expect(scaleType('harmonicMinor').steps).toEqual([0, 2, 3, 5, 7, 8, 11]);
    expect(scaleType('majorPentatonic').steps).toEqual([0, 2, 4, 7, 9]);
    expect(scaleType('minorPentatonic').steps).toEqual([0, 3, 5, 7, 10]);
    expect(scaleType('dorian').steps).toEqual([0, 2, 3, 5, 7, 9, 10]);
    expect(scaleType('phrygian').steps).toEqual([0, 1, 3, 5, 7, 8, 10]);
    expect(scaleType('lydian').steps).toEqual([0, 2, 4, 6, 7, 9, 11]);
    expect(scaleType('mixolydian').steps).toEqual([0, 2, 4, 5, 7, 9, 10]);
    expect(scaleType('wholeTone').steps).toEqual([0, 2, 4, 6, 8, 10]);
  });

  it('is the same table the kit exporter reads', () => {
    for (const t of SCALE_TYPES.filter((x) => x.id !== 'user')) expect(SCALES[t.id]!.steps).toEqual(t.steps);
    expect(SCALES.user).toBeUndefined();
  });

  it('turns an unknown type into chromatic rather than throwing', () => {
    expect(scaleType('nonsense').id).toBe('chromatic');
    expect(normaliseScale({ root: 3, type: 'nonsense' })).toEqual({ root: 3, type: 'chromatic' });
  });
});

describe('the user scale', () => {
  it('is a 12-bit mask of steps above the root', () => {
    expect(maskOfSteps([0, 3, 5, 7, 10])).toBe(DEFAULT_USER_MASK);
    expect(stepsOfMask(DEFAULT_USER_MASK)).toEqual([0, 3, 5, 7, 10]);
    expect(scaleSteps({ root: 2, type: 'user', mask: maskOfSteps([0, 4, 9]) })).toEqual([0, 4, 9]);
  });
  it('never becomes empty and ignores bits above the octave', () => {
    expect(cleanMask(0)).toBe(1);
    expect(cleanMask(undefined)).toBe(DEFAULT_USER_MASK);
    expect(cleanMask(NaN)).toBe(DEFAULT_USER_MASK);
    expect(cleanMask(0x1fff)).toBe(0xfff);
    expect(scaleSteps({ root: 0, type: 'user', mask: 0 })).toEqual([0]);
  });
  it('compares equal scales equal, ignoring a mask that does not count', () => {
    expect(sameScale({ root: 0, type: 'major', mask: 5 }, { root: 12, type: 'major' })).toBe(true);
    expect(sameScale({ root: 0, type: 'user', mask: 5 }, { root: 0, type: 'user', mask: 7 })).toBe(false);
  });
});

describe('quantising a note', () => {
  const cMajor: ScaleSpec = { root: 0, type: 'major' };

  it('leaves a note of the scale alone', () => {
    for (const n of [48, 50, 52, 53, 55, 57, 59, 60]) expect(nearestInScale(cMajor, n)).toBe(n);
  });

  it('moves a note to the nearest one, the lower on a tie', () => {
    expect(nearestInScale(cMajor, 61)).toBe(60); // C# is between C and D: lower
    expect(nearestInScale(cMajor, 61.01)).toBe(62);
    expect(nearestInScale(cMajor, 60.49)).toBe(60);
    expect(nearestInScale(cMajor, 63)).toBe(62); // D# between D and E
    expect(nearestInScale(cMajor, 66)).toBe(65); // F# between F and G
    expect(nearestInScale(cMajor, 68)).toBe(67);
    expect(nearestInScale(cMajor, 70)).toBe(69);
    expect(nearestInScale({ root: 0, type: 'chromatic' }, 60.4)).toBe(60);
    expect(nearestInScale({ root: 0, type: 'chromatic' }, 60.6)).toBe(61);
  });

  it('always lands in the scale, never farther than another scale note, and is idempotent', () => {
    for (const t of SCALE_TYPES) {
      for (const root of [0, 1, 5, 11]) {
        const s: ScaleSpec = { root, type: t.id, mask: DEFAULT_USER_MASK };
        const pcs = pitchClasses(s);
        for (let m = 20; m < 100; m += 0.37) {
          const q = nearestInScale(s, m);
          expect(pcs[((q % 12) + 12) % 12]).toBe(true);
          expect(nearestInScale(s, q)).toBe(q);
          for (let c = Math.floor(m) - 12; c <= Math.ceil(m) + 12; c++) if (pcs[((c % 12) + 12) % 12]) expect(Math.abs(q - m)).toBeLessThanOrEqual(Math.abs(c - m) + 1e-9);
        }
      }
    }
  });

  it('handles a scale of a single note', () => {
    const one: ScaleSpec = { root: 4, type: 'user', mask: 1 };
    expect(nearestInScale(one, 60)).toBe(64);
    expect(nearestInScale(one, 70)).toBe(64); // E4 and E5 are both 6 away: the lower wins
    expect(nearestInScale(one, 71)).toBe(76);
  });

  it('reports the distance to move', () => {
    expect(distanceToScale(cMajor, 61)).toBe(-1);
    expect(distanceToScale(cMajor, 60.25)).toBeCloseTo(-0.25);
    expect(distanceToScale({ root: 0, type: 'chromatic' }, 61.3)).toBeCloseTo(-0.3);
  });

  it('agrees between the spec and the mask forms', () => {
    for (const t of SCALE_TYPES) {
      const s: ScaleSpec = { root: 7, type: t.id, mask: 0b100100100100 };
      for (let m = 30; m < 90; m += 0.5) expect(nearestInMask(absMask(s), m)).toBe(nearestInScale(s, m));
    }
  });
});

describe('root transposition', () => {
  it('moves every note of a scale with its root', () => {
    for (const t of SCALE_TYPES) {
      for (let r = 0; r < 12; r++) {
        const base = pitchClasses({ root: 0, type: t.id, mask: DEFAULT_USER_MASK });
        const moved = pitchClasses({ root: r, type: t.id, mask: DEFAULT_USER_MASK });
        for (let pc = 0; pc < 12; pc++) expect(moved[(pc + r) % 12]).toBe(base[pc]);
      }
    }
  });

  it('quantises the same way a transposed scale quantises a transposed note', () => {
    for (const t of SCALE_TYPES) {
      for (let r = 1; r < 12; r++) {
        for (let m = 36; m < 84; m += 0.41) {
          expect(nearestInScale({ root: r, type: t.id, mask: DEFAULT_USER_MASK }, m + r)).toBe(nearestInScale({ root: 0, type: t.id, mask: DEFAULT_USER_MASK }, m) + r);
        }
      }
    }
  });

  it('knows the notes of C major and D minor', () => {
    expect(notesInRange({ root: 0, type: 'major' }, 60, 72)).toEqual([60, 62, 64, 65, 67, 69, 71, 72]);
    expect(notesInRange({ root: 2, type: 'minor' }, 62, 74)).toEqual([62, 64, 65, 67, 69, 70, 72, 74]);
    expect(inScale({ root: 9, type: 'minorPentatonic' }, 57)).toBe(true);
    expect(inScale({ root: 9, type: 'minorPentatonic' }, 58)).toBe(false);
  });

  it('names scales and roots', () => {
    expect(describeScale({ root: 6, type: 'minor' })).toBe('F# NATURAL MINOR');
    expect(shortScale({ root: 0, type: 'majorPentatonic' })).toBe('C PMAJ');
    expect(parseRoot('f#')).toBe(6);
    expect(parseRoot('Bb')).toBe(10);
    expect(parseRoot('4')).toBe(4);
    expect(parseRoot('H')).toBeNull();
    expect(parseRoot('12')).toBeNull();
  });
});

describe('a sequencer pitch offset', () => {
  it('snaps so the note it reaches is on the scale', () => {
    const cMajor: ScaleSpec = { root: 0, type: 'major' };
    expect(quantiseOffset(cMajor, 60, 0)).toBe(0);
    expect(quantiseOffset(cMajor, 60, 2)).toBe(2);
    expect(quantiseOffset(cMajor, 60, 1)).toBe(0); // C# → C (the lower on a tie)
    expect(quantiseOffset(cMajor, 60, 6)).toBe(5); // F# → F
    expect(quantiseOffset(cMajor, 64, -1)).toBe(-2); // D# → D
    expect(quantiseOffset(cMajor, 60, -12)).toBe(-12);
    for (let o = -24; o <= 24; o++) expect(inScale(cMajor, 60 + quantiseOffset(cMajor, 60, o))).toBe(true);
    expect(quantiseOffsetMask(absMask(cMajor), 60, 6)).toBe(5);
  });
});

describe('which scale a track plays in', () => {
  const project = (g?: Partial<ReturnType<typeof defaultGlobalScale>>) => {
    const p = defaultProject();
    if (g) p.scale = { ...defaultGlobalScale(), ...g };
    return p;
  };
  const track = (p: ReturnType<typeof defaultProject>, role: string) => p.tracks.find((t) => t.role === role)!;

  it('is none anywhere until a global scale is switched on', () => {
    const p = project();
    for (const t of p.tracks) expect(trackScaleState(p, t).spec).toBeNull();
    const q = project({ on: false, root: 2, type: 'major' });
    expect(trackScaleState(q, track(q, 'kick')).source).toBe('global-off');
  });

  it('puts pitched roles on GLOBAL and the rest OFF until a track is set', () => {
    for (const r of PITCHED_ROLES) expect(defaultModeFor(r)).toBe('global');
    for (const r of ['snare', 'clap', 'chat', 'ohat', 'cymbal', 'fx']) expect(defaultModeFor(r)).toBe('off');
    const p = project({ on: true, root: 9, type: 'minor' });
    expect(trackScaleState(p, track(p, 'kick')).spec).toEqual({ root: 9, type: 'minor' });
    expect(trackScaleState(p, track(p, 'chat')).spec).toBeNull();
    expect(trackScaleState(p, track(p, 'chat')).source).toBe('off');
  });

  it('lets a track opt out, follow the global scale or use its own', () => {
    const p = project({ on: true, root: 0, type: 'major' });
    const kick = track(p, 'kick');
    const snare = track(p, 'snare');
    kick.scale = { mode: 'off', root: 0, type: 'minor' };
    expect(trackScaleState(p, kick).spec).toBeNull();
    snare.scale = { mode: 'global', root: 5, type: 'dorian' };
    expect(trackScaleState(p, snare).spec).toEqual({ root: 0, type: 'major' }); // the track's own fields do not count while it follows
    kick.scale = { mode: 'custom', root: 5, type: 'dorian' };
    expect(trackScaleState(p, kick).spec).toEqual({ root: 5, type: 'dorian' });
    expect(trackScaleState(p, kick).source).toBe('custom');
    p.scale!.on = false;
    expect(trackScaleState(p, kick).spec).toEqual({ root: 5, type: 'dorian' }); // independent of the global scale
    expect(trackScaleState(p, snare).spec).toBeNull();
  });
});

describe('stored settings', () => {
  it('repairs damaged scale data instead of trusting it', () => {
    expect(repairGlobalScale(undefined)).toBeUndefined();
    expect(repairGlobalScale('x')).toBeUndefined();
    expect(repairGlobalScale({ on: 'yes', root: 14, type: 'nonsense' })).toEqual({ on: false, root: 2, type: 'minor' });
    expect(repairGlobalScale({ on: true, root: -1, type: 'user', mask: 0 })).toEqual({ on: true, root: 11, type: 'user', mask: 1 });
    expect(repairTrackScale({ mode: 'weird', root: 3, type: 'lydian' })).toEqual({ mode: 'global', root: 3, type: 'lydian' });
    expect(repairTrackScale(null)).toBeUndefined();
  });

  it('survives saving and loading, in every field', () => {
    const p = defaultProject();
    p.scale = { on: true, root: 6, type: 'user', mask: maskOfSteps([0, 2, 7]) };
    p.tracks[0]!.scale = { mode: 'custom', root: 3, type: 'user', mask: maskOfSteps([0, 4, 7, 11]) };
    p.tracks[1]!.scale = { mode: 'off', root: 0, type: 'minor' };
    const back = parseProject(serialize(p));
    expect(back.version).toBe(9);
    expect(back.scale).toEqual(p.scale);
    expect(back.tracks[0]!.scale).toEqual(p.tracks[0]!.scale);
    expect(back.tracks[1]!.scale).toEqual(p.tracks[1]!.scale);
    expect(back.tracks[2]!.scale).toBeUndefined();
  });

  it('opens a project from before scales unchanged, with no scale in force', () => {
    const p = JSON.parse(serialize(defaultProject()));
    p.version = 6;
    delete p.scale;
    for (const t of p.tracks) delete t.scale;
    const old = repairProject(p);
    expect(old.version).toBe(9);
    expect(old.scale).toBeUndefined();
    for (const t of old.tracks) {
      expect(t.scale).toBeUndefined();
      expect(t.pitch).toBeUndefined();
      expect(trackScaleState(old, t).spec).toBeNull();
    }
  });

  it('refuses a project from a newer version', () => {
    expect(() => repairProject({ format: 'clatter-project', version: 10 })).toThrow();
  });
});
