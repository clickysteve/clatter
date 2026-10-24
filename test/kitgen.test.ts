/** Generative sound design: kits, mutation, locks, seeds, valid ranges, audibility. */
import { describe, expect, it } from 'vitest';
import { newLxr } from './helpers';
import { checkKit, measureTrigger, readKit } from '../src/sound/kitcheck';
import { evolveKit, generateKit, mutateKit, voiceKeys, voiceRolesOf } from '../src/sound/kitgen';
import { defaultTracks } from '../src/model/defaults';
import { PAR } from '../src/sound/lxrParamIds';
import type { KitFlavour } from '../src/rhythm/styles';

const e = newLxr();
const init = readKit(e);
const roles = voiceRolesOf(defaultTracks());
const noLocks = { voices: [false, false, false, false, false, false], params: [] as number[] };
const FLAVOURS: KitFlavour[] = ['machine', 'electro', 'acoustic', 'industrial', 'glitch', 'dub'];

describe('kit generation', () => {
  it('is reproducible from its seed', () => {
    const a = generateKit(init, { seed: 42, flavour: 'machine', voiceRoles: roles, locks: noLocks });
    const b = generateKit(init, { seed: 42, flavour: 'machine', voiceRoles: roles, locks: noLocks });
    const c = generateKit(init, { seed: 43, flavour: 'machine', voiceRoles: roles, locks: noLocks });
    expect(a).toEqual(b);
    expect(a.params).not.toEqual(c.params);
  });

  it('keeps every parameter in the firmware range', () => {
    for (const flavour of FLAVOURS)
      for (let s = 1; s < 6; s++) {
        const k = generateKit(init, { seed: s, flavour, voiceRoles: roles, locks: noLocks });
        for (const v of k.params) {
          expect(Number.isInteger(v)).toBe(true);
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(127);
        }
      }
  });

  it.each(FLAVOURS)('%s kits are audible, unclipped and level-matched after the engine check', (flavour) => {
    for (let s = 1; s <= 3; s++) {
      const raw = generateKit(init, { seed: s * 101, flavour, voiceRoles: roles, locks: noLocks });
      const { kit, report } = checkKit(e, raw, { flavour, voiceRoles: roles, seed: s, fallback: init });
      for (let v = 0; v < 6; v++) {
        const m = measureTrigger(e, kit, v);
        expect(m.peak, `voice ${v}`).toBeGreaterThan(0.03);
        expect(m.peak, `voice ${v}`).toBeLessThan(0.99);
        expect(m.length, `voice ${v}`).toBeGreaterThan(15);
      }
      expect(report.levels.length).toBe(6);
      // level-matched: no voice is left far below the others
      for (const l of report.levels) expect(l).toBeGreaterThan(0.09);
    }
  });

  it('kick voices are low and pitched down by their envelope', () => {
    const k = generateKit(init, { seed: 7, flavour: 'electro', voiceRoles: roles, locks: noLocks });
    const coarse = k.params[voiceKeys(0).coarse!]!;
    expect(coarse).toBeLessThanOrEqual(40);
    expect(k.params[voiceKeys(0).pAmt!]!).toBeGreaterThan(30);
  });

  it('never touches locked voices or locked parameters', () => {
    const locks = { voices: [true, false, false, false, false, false], params: [PAR.VELOD4] };
    const k = generateKit(init, { seed: 9, flavour: 'glitch', voiceRoles: roles, locks });
    for (const p of Object.values(voiceKeys(0))) if (p !== undefined) expect(k.params[p]).toBe(init.params[p]);
    expect(k.params[PAR.VELOD4]).toBe(init.params[PAR.VELOD4]);
    const m = mutateKit(k, { seed: 3, flavour: 'glitch', voiceRoles: roles, locks, amount: 1 });
    for (const p of Object.values(voiceKeys(0))) if (p !== undefined) expect(m.params[p]).toBe(init.params[p]);
    expect(m.params[PAR.VELOD4]).toBe(init.params[PAR.VELOD4]);
  });

  it('MUTATE VOICE changes only that voice; small amounts make small changes', () => {
    const k = generateKit(init, { seed: 5, flavour: 'machine', voiceRoles: roles, locks: noLocks });
    const m = mutateKit(k, { seed: 8, flavour: 'machine', voiceRoles: roles, locks: noLocks, amount: 0.5, voices: [3] });
    const own = new Set(Object.values(voiceKeys(3)));
    let changed = 0;
    m.params.forEach((v, p) => {
      if (v !== k.params[p]) {
        expect(own.has(p)).toBe(true);
        changed++;
      }
    });
    expect(changed).toBeGreaterThan(0);
    const small = mutateKit(k, { seed: 8, flavour: 'machine', voiceRoles: roles, locks: noLocks, amount: 0.05 });
    const big = mutateKit(k, { seed: 8, flavour: 'machine', voiceRoles: roles, locks: noLocks, amount: 1 });
    const dist = (x: number[]) => x.reduce((a, v, p) => a + Math.abs(v - k.params[p]!), 0);
    expect(dist(small.params)).toBeLessThan(dist(big.params));
  });

  it('EVOLVE stays near home', () => {
    const home = generateKit(init, { seed: 11, flavour: 'dub', voiceRoles: roles, locks: noLocks });
    let k = home;
    for (let i = 0; i < 40; i++) k = evolveKit(k, home, { seed: 100 + i, flavour: 'dub', voiceRoles: roles, locks: noLocks, amount: 0.5 });
    const maxDrift = Math.max(...k.params.map((v, p) => Math.abs(v - home.params[p]!)));
    expect(maxDrift).toBeLessThanOrEqual(6 + 0.5 * 30);
  });
});
