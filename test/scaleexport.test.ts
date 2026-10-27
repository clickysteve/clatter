/** The kit exporter with scales: original is untouched by the scale, project is as tuned, global and track modes name files by the pitch actually heard. */
import { describe, expect, it, vi } from 'vitest';
import { readZip } from '@slopfactory/core/export';
import { bundledLibrary, lxrModule, presetProject } from './helpers';
import { analysePitch, hzToMidiFloat, midiToHz } from '../src/analysis/pitch';
import { analyseTarget } from '../src/analysis/trackPitch';
import { exportKit, KIT_EXPORT_DEFAULTS, resolveOptions, type KitExportOptions, type KitManifest } from '../src/export/kitExport';
import { decodeWav } from '../src/export/wavFile';
import { measureAndTune } from '../src/music/measure';
import { inScale } from '../src/music/scale';
import { clone, type Project } from '../src/model/types';

vi.setConfig({ testTimeout: 180000 });

type Lib = Awaited<ReturnType<typeof bundledLibrary>>;
const cents = (a: number, b: number) => Math.abs(1200 * Math.log2(a / b));

async function rig() {
  const lib = await bundledLibrary();
  const p = await presetProject('machine-room', lib);
  const id = (name: string) => p.tracks.find((t) => t.name === name)!.id;
  return { lib, p, id };
}

async function run(p: Project, lib: Lib, over: Partial<KitExportOptions>) {
  const o: KitExportOptions = { ...clone(KIT_EXPORT_DEFAULTS), ...over, pitch: { ...KIT_EXPORT_DEFAULTS.pitch, ...(over.pitch ?? {}) } };
  const res = await exportKit(p, o, { module: lxrModule(), library: lib, now: () => new Date('2026-01-01T00:00:00Z') });
  const entries = await readZip(res.file.data);
  const byName = new Map(entries.map((e) => [e.name, e.data]));
  const manifest = JSON.parse(new TextDecoder().decode(byName.get('kit.json')!)) as KitManifest;
  return { manifest, wav: (n: string) => decodeWav(byName.get(n)!) };
}

const tuneAll = (p: Project, lib: Lib, ids: string[]) => measureAndTune(p, ids, { analyse: (q, tg) => analyseTarget(lxrModule(), q, lib, tg) });

describe('kit export and scales', () => {
  it('refuses global and track modes when no scale applies', async () => {
    const { p, id } = await rig();
    const o = (mode: 'global' | 'track'): KitExportOptions => ({ ...clone(KIT_EXPORT_DEFAULTS), instruments: 'selected', trackIds: [id('KICK')], pitch: { ...KIT_EXPORT_DEFAULTS.pitch, mode, lo: 'C2', hi: 'C3' } });
    p.scale = undefined as never;
    expect(resolveOptions(p, o('global'))).toHaveProperty('error');
    p.scale = { on: false, root: 0, type: 'major' };
    expect(resolveOptions(p, o('track'))).toHaveProperty('error');
  });

  it('GLOBAL SCALE gives only scale notes, each heard where its name says, and leaves the source kit alone', async () => {
    const { p, lib, id } = await rig();
    p.scale = { on: true, root: 2, type: 'minorPentatonic' };
    const before = JSON.stringify(p);
    const r = await run(p, lib, { instruments: 'selected', trackIds: [id('LO TOM')], pitch: { ...KIT_EXPORT_DEFAULTS.pitch, mode: 'global', lo: 'D2', hi: 'D3' } });
    expect(JSON.stringify(p)).toBe(before);
    expect(r.manifest.files.length).toBeGreaterThan(3);
    for (const f of r.manifest.files) {
      expect(inScale({ root: 2, type: 'minorPentatonic' }, f.pitch.midi!), f.file).toBe(true);
      const w = r.wav(f.file);
      const a = analysePitch(w.channelData, w.rate);
      expect(a.fundamental, f.file).not.toBeNull();
      expect(cents(a.fundamental!.hz, midiToHz(f.pitch.midi!)), f.file).toBeLessThan(30);
    }
  });

  it('TRACK SCALES uses each track’s own scale and skips none that has one', async () => {
    const { p, lib, id } = await rig();
    p.scale = { on: true, root: 0, type: 'major' };
    const t = p.tracks.find((x) => x.name === 'HI TOM')!;
    t.scale = { mode: 'custom', root: 9, type: 'minorPentatonic' } as never;
    const r = await run(p, lib, { instruments: 'selected', trackIds: [id('HI TOM')], pitch: { ...KIT_EXPORT_DEFAULTS.pitch, mode: 'track', lo: 'A2', hi: 'A3' } });
    for (const f of r.manifest.files) expect(inScale({ root: 9, type: 'minorPentatonic' }, f.pitch.midi!), f.file).toBe(true);
  });

  it('ORIGINAL is not changed by the scale; AS TUNED is on the scale', async () => {
    const { p, lib, id } = await rig();
    const kick = id('KICK');
    const plain = await run(p, lib, { instruments: 'selected', trackIds: [kick] });
    p.scale = { on: true, root: 1, type: 'major' };
    await tuneAll(p, lib, [kick]);
    const orig = await run(p, lib, { instruments: 'selected', trackIds: [kick] });
    expect(orig.manifest.files[0]!.pitch.measuredHz).toBeCloseTo(plain.manifest.files[0]!.pitch.measuredHz!, 0);
    const tuned = await run(p, lib, { instruments: 'selected', trackIds: [kick], pitch: { ...KIT_EXPORT_DEFAULTS.pitch, mode: 'project' } });
    const f = tuned.manifest.files[0]!;
    expect(f.pitch.tuning).not.toBe('none');
    const m = hzToMidiFloat(f.pitch.measuredHz!);
    expect(Math.abs(m - Math.round(m))).toBeLessThan(0.5);
    expect(inScale({ root: 1, type: 'major' }, Math.round(m))).toBe(true);
  });
});
