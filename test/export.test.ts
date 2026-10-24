/** Offline rendering and export: the same engine as playback, deterministic; stems, MIDI, hits. */
import { describe, expect, it } from 'vitest';
import { encodeWav16 } from '@slopfactory/core/export';
import { bundledLibrary, lxrModule, presetProject, stats } from './helpers';
import { renderHit, renderProject } from '../src/audio/render';
import { exportMidi, performance } from '../src/export/midiFile';

describe('render', () => {
  it('is deterministic: the same project renders the same samples', async () => {
    const lib = await bundledLibrary();
    const p = await presetProject('digital-detritus', lib);
    const a = await renderProject(lxrModule(), p, lib, { bars: 2, tail: 0.5 });
    const b = await renderProject(lxrModule(), p, lib, { bars: 2, tail: 0.5 });
    expect(a.frames).toBe(b.frames);
    expect(Buffer.from(a.master[0]!.buffer, a.master[0]!.byteOffset, a.master[0]!.byteLength).equals(Buffer.from(b.master[0]!.buffer, b.master[0]!.byteOffset, b.master[0]!.byteLength))).toBe(true);
    const s = stats(a.master[0]!);
    expect(s.finite).toBe(true);
    expect(s.peak).toBeGreaterThan(0.1);
    expect(s.peak).toBeLessThanOrEqual(1);
  });

  it('has the length of the bars plus the tail', async () => {
    const lib = await bundledLibrary();
    const p = await presetProject('machine-room', lib);
    const r = await renderProject(lxrModule(), p, lib, { bars: 4, tail: 1 });
    const expected = Math.round(4 * 4 * (60 / p.tempo) * 44100) + 44100;
    expect(r.frames).toBe(expected);
  });

  it('stems (plus the FX bus) add up to the master', async () => {
    const lib = await bundledLibrary();
    const p = await presetProject('metallic-weather', lib);
    p.master.clip = false;
    p.master.volume = 0.8;
    const r = await renderProject(lxrModule(), p, lib, { bars: 2, tail: 0.5, stems: true });
    const fxIds = new Set(p.tracks.filter((t) => t.mix.route === 'fx').map((t) => t.id));
    let err = 0;
    let ref = 0;
    for (let i = 0; i < r.frames; i += 7) {
      let sum = r.fx![0]![i]!;
      for (const t of p.tracks) if (!fxIds.has(t.id)) sum += r.stems[t.id]![0]![i]!;
      err = Math.max(err, Math.abs(sum - r.master[0]![i]!));
      ref = Math.max(ref, Math.abs(r.master[0]![i]!));
    }
    expect(ref).toBeGreaterThan(0.05);
    expect(err).toBeLessThan(1e-3);
  });

  it('encodes to a 16-bit WAV', async () => {
    const lib = await bundledLibrary();
    const p = await presetProject('after-hours', lib);
    const r = await renderProject(lxrModule(), p, lib, { bars: 1, tail: 0 });
    const wav = await encodeWav16(r.master, r.rate);
    const v = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    expect(String.fromCharCode(...wav.subarray(0, 4))).toBe('RIFF');
    expect(v.getUint16(22, true)).toBe(2);
    expect(v.getUint32(24, true)).toBe(44100);
    expect(v.getUint16(34, true)).toBe(16);
  });
});

describe('drum hits', () => {
  it('every track of a preset renders an audible one-shot that ends', async () => {
    const lib = await bundledLibrary();
    const p = await presetProject('wrong-answers', lib);
    for (const t of p.tracks) {
      const hit = await renderHit(lxrModule(), p, lib, t.id);
      const s = stats(hit[0]!);
      expect(s.finite, t.name).toBe(true);
      expect(s.peak, t.name).toBeGreaterThan(0.01);
      expect(hit[0]!.length, t.name).toBeLessThan(44100 * 4.5);
    }
  });
});

describe('MIDI file', () => {
  it('is a type-1 SMF with one track per CLATTER track and every performed note', async () => {
    const lib = await bundledLibrary();
    const p = await presetProject('dusty-breaks', lib);
    const bytes = exportMidi(p, { bars: 4 });
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe('MThd');
    const v = new DataView(bytes.buffer, bytes.byteOffset);
    expect(v.getUint16(8)).toBe(1);
    expect(v.getUint16(10)).toBeGreaterThanOrEqual(p.tracks.length);
    expect(v.getUint16(12)).toBe(96);
    // count note-ons (running status is not used by the writer)
    let ons = 0;
    for (let i = 14; i < bytes.length - 2; i++) if ((bytes[i]! & 0xf0) === 0x90 && bytes[i + 2]! > 0 && bytes[i + 1]! < 128) ons++;
    const perf = performance(p, 4);
    expect(perf.length).toBeGreaterThan(20);
    expect(ons).toBeGreaterThanOrEqual(perf.length);
  });
});
