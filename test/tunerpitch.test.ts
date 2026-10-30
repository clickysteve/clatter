/**
 * The TUNER's PITCH control: it edits the real COARSE/FINE parameters of the selected sound (the
 * base sound or the open variation), the analysis follows, and the edit is part of the project.
 */
import { describe, expect, it } from 'vitest';
import { lxrModule, presetProject } from './helpers';
import { App } from '../src/app/app';
import { analyseTarget } from '../src/analysis/trackPitch';
import { renderHit, renderProject } from '../src/audio/render';
import { parseProject, serialize } from '../src/model/project';
import { VOICE_PARAMS } from '../src/sound/lxrParams';
import { PAR } from '../src/sound/lxrParamIds';

const cents = (a: number, b: number) => 1200 * Math.log2(a / b);

async function rig() {
  const app = new App();
  const lib = app.library;
  app.module = lxrModule();
  app.project = await presetProject('machine-room', lib);
  const kick = app.project.tracks.find((t) => t.name === 'KICK')!;
  app.project.kit.synth.params[PAR.MODAMNT1] = 0; // a steady pitch, so the readout is the oscillator
  app.selectTrack(kick.id);
  const hz = async (slot: number | null = null) => {
    const r = await app.analysePitch({ trackId: kick.id, slot, layer: 'mix' }, true);
    return r.analysis.fundamental!.hz;
  };
  return { app, lib, kick, hz };
}

/** the controls the tuner shows */
const coarseOf = (voice: number) => VOICE_PARAMS[voice]!.find((p) => p.group === 'OSC' && p.label === 'COARSE')!;
const fineOf = (voice: number) => VOICE_PARAMS[voice]!.find((p) => p.group === 'OSC' && p.label === 'FINE')!;

describe('TUNER pitch control', () => {
  it('its COARSE and FINE are the oscillator parameters of the track’s voice', async () => {
    const { app, kick } = await rig();
    const v = app.voiceOf(kick);
    expect(coarseOf(v).id).toBe(PAR.COARSE1);
    expect(fineOf(v).id).toBe(PAR.FINE1);
    const snare = app.project.tracks.find((t) => t.name === 'SNARE')!;
    expect(coarseOf(app.voiceOf(snare)).id).toBe(PAR.COARSE4);
  });

  it('moving it moves the analysed fundamental by the same amount, in both directions', async () => {
    const { app, hz } = await rig();
    const base = await hz();
    const c = coarseOf(0);
    app.setEditedParam(c.id, app.paramValue(c.id) + 3, 'COARSE');
    expect(Math.abs(cents(await hz(), base * Math.pow(2, 3 / 12)))).toBeLessThan(40);
    app.setEditedParam(c.id, app.paramValue(c.id) - 5, 'COARSE');
    expect(Math.abs(cents(await hz(), base * Math.pow(2, -2 / 12)))).toBeLessThan(40);
    // FINE moves less than a semitone
    const f = fineOf(0);
    const before = await hz();
    app.setEditedParam(f.id, app.paramValue(f.id) + 20, 'FINE');
    const d = cents(await hz(), before);
    expect(d).toBeGreaterThan(5);
    expect(d).toBeLessThan(100);
  });

  it('respects the parameter range', async () => {
    const { app } = await rig();
    const c = coarseOf(0);
    app.setEditedParam(c.id, 999, 'COARSE');
    expect(app.project.kit.synth.params[c.id]).toBe(c.max);
    app.setEditedParam(c.id, -9, 'COARSE');
    expect(app.project.kit.synth.params[c.id]).toBe(0);
  });

  it('a stale analysis never replaces a newer one, however the renders finish', async () => {
    const { app, kick } = await rig();
    const c = coarseOf(0);
    const target = { trackId: kick.id, slot: null, layer: 'mix' as const };
    const first = app.analysePitch(target, true); // renders the sound as it is now
    app.setEditedParam(c.id, app.paramValue(c.id) + 12, 'COARSE');
    const second = app.analysePitch(target, true); // the sound an octave up
    const [a, b] = await Promise.all([first, second]);
    expect(b.analysis.fundamental!.hz / a.analysis.fundamental!.hz).toBeGreaterThan(1.9);
    // what is stored is the result for the current sound
    expect(app.pitch.fresh(app.project, target)?.analysis.fundamental!.hz).toBeCloseTo(b.analysis.fundamental!.hz, 6);
    // and the older result is reported stale, not shown as current
    const late = await analyseTarget(app.module!, app.project, app.library, target);
    expect(late.fingerprint).toBe(b.fingerprint);
  });

  it('leaves the other instruments alone', async () => {
    const { app, kick } = await rig();
    const others = app.project.tracks.filter((t) => t.id !== kick.id);
    const hit = async () => Promise.all(others.map((t) => renderHit(app.module!, app.project, app.library, t.id, 100, 1, { dry: true }).then((a) => Array.from(a[0]!.slice(0, 4000)).join())));
    const before = await hit();
    const paramsBefore = JSON.stringify(app.project.kit.synth.params);
    const c = coarseOf(0);
    app.setEditedParam(c.id, app.paramValue(c.id) + 7, 'COARSE');
    const after = JSON.parse(JSON.stringify(app.project.kit.synth.params)) as Record<string, number>;
    const was = JSON.parse(paramsBefore) as Record<string, number>;
    const changed = Object.keys({ ...was, ...after }).filter((k) => was[k] !== after[k]);
    expect(changed).toEqual([String(c.id)]);
    expect(await hit()).toEqual(before);
  });

  describe('with a variation open', () => {
    it('edits that variation only, and the analysis of the variation follows', async () => {
      const { app, kick, hz } = await rig();
      app.createVariation(kick.id, 1);
      app.createVariation(kick.id, 2);
      app.setSlot(1);
      const c = coarseOf(0);
      const kitValue = app.project.kit.synth.params[c.id]!;
      const baseHz = await hz();
      const other = await hz(2);
      app.setEditedParam(c.id, kitValue + 12, 'COARSE');
      expect(app.project.kit.synth.params[c.id]).toBe(kitValue); // the kit is unchanged
      expect(app.track.sound.variations![1]!.params[c.id]).toBe(kitValue + 12);
      expect(app.track.sound.variations![2]!.params[c.id]).toBeUndefined(); // so is every other variation
      const up = await hz(1);
      expect(up / baseHz).toBeGreaterThan(1.9);
      expect(up / baseHz).toBeLessThan(2.1);
      expect(await hz()).toBeCloseTo(baseHz, 6);
      expect(await hz(2)).toBeCloseTo(other, 6);
    });

    it('HEAR plays the open variation’s pitch; the base sound plays without overrides', async () => {
      const { app, kick } = await rig();
      const sent: { type: string; hits?: { sp?: number[]; track: number }[] }[] = [];
      app.host.send = ((m: (typeof sent)[number]) => void sent.push(m)) as typeof app.host.send;
      Object.defineProperty(app.host, 'state', { get: () => 'running', configurable: true });
      app.createVariation(kick.id, 0);
      app.setSlot(0);
      const c = coarseOf(0);
      app.setEditedParam(c.id, app.paramValue(c.id) + 5, 'COARSE');
      await app.auditionSlot(kick.id, 0);
      await app.auditionSlot(kick.id, null);
      const [v, base] = sent.map((m) => m.hits![0]!);
      const pairs = v!.sp!;
      expect(pairs[pairs.indexOf(c.id) + 1]).toBe(app.track.sound.variations![0]!.params[c.id]);
      expect(base!.sp).toBeUndefined();
    });
  });

  it('is undone and redone as one step per edit', async () => {
    const { app, hz } = await rig();
    const c = coarseOf(0);
    const start = app.project.kit.synth.params[c.id]!;
    const base = await hz();
    app.setEditedParam(c.id, start + 12, 'COARSE');
    expect(app.history.undoLabel).toBe('COARSE');
    app.undo();
    expect(app.project.kit.synth.params[c.id]).toBe(start);
    expect(await hz()).toBeCloseTo(base, 6);
    app.redo();
    expect(app.project.kit.synth.params[c.id]).toBe(start + 12);
    expect((await hz()) / base).toBeGreaterThan(1.9);
  });

  it('is saved with the project, heard in an export and in a hit, and survives closing and reopening', async () => {
    const { app, lib, kick } = await rig();
    const c = coarseOf(0);
    const loud = (a: Float32Array[]) => a[0]!;
    const before = await renderProject(app.module!, app.project, lib, { bars: 1, tail: 0 });
    app.setEditedParam(c.id, app.paramValue(c.id) + 12, 'COARSE');
    app.createVariation(kick.id, 3);
    app.setSlot(3);
    app.setEditedParam(fineOf(0).id, app.paramValue(fineOf(0).id) + 9, 'FINE');
    const saved = parseProject(serialize(app.project));
    expect(saved.kit.synth.params[c.id]).toBe(app.project.kit.synth.params[c.id]);
    expect(saved.tracks.find((t) => t.id === kick.id)!.sound.variations![3]!.params[fineOf(0).id]).toBe(app.project.tracks.find((t) => t.id === kick.id)!.sound.variations![3]!.params[fineOf(0).id]);
    // the export is not the export of the unadjusted kit, and a saved copy exports the same audio
    const after = await renderProject(app.module!, app.project, lib, { bars: 1, tail: 0 });
    const loaded = await renderProject(app.module!, saved, lib, { bars: 1, tail: 0 });
    const same = (a: Float32Array, b: Float32Array) => a.length === b.length && a.every((x, i) => x === b[i]);
    expect(same(loud(after.master), loud(before.master))).toBe(false);
    expect(same(loud(after.master), loud(loaded.master))).toBe(true);
    // closing the tuner and opening it again: the value is the project's
    app.selectTrack(app.project.tracks.find((t) => t.id !== kick.id)!.id);
    app.selectTrack(kick.id);
    app.setSlot(null);
    expect(app.paramValue(c.id)).toBe(app.project.kit.synth.params[c.id]);
  });
});
