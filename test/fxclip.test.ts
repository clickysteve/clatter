/**
 * The FX bus DRIVE with the CLIP shape (the firmware's RAT distortion) self-oscillates when its
 * COLOUR feedback is high: a steady tone that outlives the drums. The kit generators, MUTATE and
 * WILDCARD must never leave a kit there (CLIP_COLOUR_MAX in src/sound/kitgen.ts).
 */
import { describe, expect, it } from 'vitest';
import { lxrModule, newLxr } from './helpers';
import { renderProject } from '../src/audio/render';
import { defaultProject, defaultTracks } from '../src/model/defaults';
import { readKit } from '../src/sound/kitcheck';
import { CLIP_COLOUR_MAX, generateKit, mutateKit, voiceRolesOf } from '../src/sound/kitgen';
import { applyWildcard, defaultWild, WILD_CATS } from '../src/destruction/wildcardProject';
import { PAR } from '../src/sound/lxrParamIds';
import type { KitFlavour } from '../src/rhythm/styles';

const FLAVOURS: KitFlavour[] = ['machine', 'electro', 'acoustic', 'industrial', 'glitch', 'dub'];
const init = readKit(newLxr());
const roles = voiceRolesOf(defaultTracks());
const noLocks = { voices: [false, false, false, false, false, false], params: [] as number[] };
const isClip = (p: number[]) => p[PAR.FX_TYPE] === 1 && p[PAR.FX_DIST_TYPE] === 2;

/** Peak of the master in the last second, after a bar of nothing and a three-second tail: the FX bus alone. */
async function clipTail(drive: number, colour: number, tone = 127, volume = 127): Promise<number> {
  const p = defaultProject();
  p.kit.synth = { ...init, params: init.params.slice() };
  const prm = p.kit.synth.params;
  prm[PAR.FX_TYPE] = 1;
  prm[PAR.FX_DIST_TYPE] = 2;
  prm[PAR.FX_DRY_WET] = 60;
  prm[PAR.FX_P1] = drive;
  prm[PAR.FX_P2] = colour;
  prm[PAR.FX_P3] = tone;
  prm[PAR.FX_P4] = volume;
  for (const pt of p.patterns) for (const k of Object.keys(pt.grids)) pt.grids[k] = pt.grids[k]!.map(() => null);
  const r = await renderProject(lxrModule(), p, null, { bars: 1, tail: 3 });
  const L = r.master[0]!;
  let m = 0;
  for (let i = L.length - 44100; i < L.length; i++) m = Math.max(m, Math.abs(L[i]!));
  return m;
}

describe('FX bus CLIP feedback', () => {
  it('oscillates on its own above the limit and stays silent at it', async () => {
    // a kit like the one that showed the fault (INDUSTRIAL design: DRIVE 107, COLOUR 68)
    expect(await clipTail(107, 68, 43, 60)).toBeGreaterThan(0.05);
    expect(await clipTail(127, CLIP_COLOUR_MAX + 1)).toBeGreaterThan(0.05);
    // the limit holds at the worst case and across DRIVE
    for (const drive of [50, 90, 127]) expect(await clipTail(drive, CLIP_COLOUR_MAX)).toBeLessThan(1e-3);
  }, 60_000);

  it('GENERATE KIT never designs a CLIP FX bus that can oscillate', () => {
    let clips = 0;
    for (const flavour of FLAVOURS)
      for (const wildness of [0, 0.6, 1])
        for (let s = 1; s <= 40; s++) {
          const k = generateKit(init, { seed: s * 7919, flavour, wildness, voiceRoles: roles, locks: noLocks });
          if (!isClip(k.params)) continue;
          clips++;
          expect(k.params[PAR.FX_P2]).toBeLessThanOrEqual(CLIP_COLOUR_MAX);
        }
    expect(clips).toBeGreaterThan(0);
  });

  it('MUTATE KIT and WILDCARD keep a CLIP bus under the limit, but leave a locked COLOUR alone', () => {
    const clip = generateKit(init, { seed: 1, flavour: 'industrial', voiceRoles: roles, locks: noLocks });
    clip.params[PAR.FX_TYPE] = 1;
    clip.params[PAR.FX_DIST_TYPE] = 2;
    clip.params[PAR.FX_P2] = 90;
    for (let s = 1; s <= 200; s++) {
      const m = mutateKit(clip, { seed: s, flavour: 'industrial', voiceRoles: roles, locks: noLocks, amount: 1 });
      // FX moves only on some draws; when it moves, it lands under the limit
      if (m.params[PAR.FX_P2] !== 90) expect(m.params[PAR.FX_P2]).toBeLessThanOrEqual(CLIP_COLOUR_MAX);
    }
    const locked = mutateKit(clip, { seed: 3, flavour: 'industrial', voiceRoles: roles, locks: { ...noLocks, params: [PAR.FX_P2] }, amount: 1 });
    expect(locked.params[PAR.FX_P2]).toBe(90);

    let moved = 0;
    for (let s = 1; s <= 60; s++) {
      const p = defaultProject();
      p.kit.synth = { ...clip, params: clip.params.slice() };
      applyWildcard(p, { ...defaultWild(), seed: s, intensity: 100, scope: 'project', cats: [...WILD_CATS] }, { track: p.tracks[0]!.id, pool: [] });
      const q = p.kit.synth.params;
      if (!isClip(q) || q[PAR.FX_P2] === 90) continue;
      moved++;
      expect(q[PAR.FX_P2]).toBeLessThanOrEqual(CLIP_COLOUR_MAX);
    }
    expect(moved).toBeGreaterThan(0);
  });
});
