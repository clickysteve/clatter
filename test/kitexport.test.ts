/** The kit WAV exporter: rendering, variations, velocity layers, pitch ranges and labels, WAV files, ZIP and kit.json, cancellation, and that the kit is left alone. */
import { describe, expect, it, vi } from 'vitest';
import { readZip } from '@slopfactory/core/export';
import { bundledLibrary, lxrModule, presetProject, stats } from './helpers';
import { KitExportJob } from '../src/app/kitExportJob';
import { analysePitch, midiToHz } from '../src/analysis/pitch';
import { exportKit, KIT_EXPORT_DEFAULTS, KitExportCancelled, nameSlug, resolveOptions, uniqueName, velocityLayers, kitFileName, type KitExportOptions, type KitManifest } from '../src/export/kitExport';
import { chromaticRange, fileNote, noteName, parseNote, parseNoteList, scaleNotes } from '../src/export/notes';
import { decodeWav, encodeWav } from '../src/export/wavFile';
import { clone, type Project } from '../src/model/types';
import { PAR } from '../src/sound/lxrParamIds';

vi.setConfig({ testTimeout: 180000 });

const cents = (a: number, b: number) => Math.abs(1200 * Math.log2(a / b));
type Lib = Awaited<ReturnType<typeof bundledLibrary>>;

async function rig(preset = 'machine-room') {
  const lib = await bundledLibrary();
  const p = await presetProject(preset, lib);
  const id = (name: string) => p.tracks.find((t) => t.name === name)!.id;
  return { lib, p, id };
}

async function run(p: Project, lib: Lib, over: Partial<KitExportOptions> = {}, deps: Partial<Parameters<typeof exportKit>[2]> = {}) {
  const o: KitExportOptions = { ...clone(KIT_EXPORT_DEFAULTS), ...over, pitch: { ...KIT_EXPORT_DEFAULTS.pitch, ...(over.pitch ?? {}) } };
  const res = await exportKit(p, o, { module: lxrModule(), library: lib, now: () => new Date('2026-01-01T00:00:00Z'), ...deps });
  const entries = await readZip(res.file.data);
  const byName = new Map(entries.map((e) => [e.name, e.data]));
  const manifest = JSON.parse(new TextDecoder().decode(byName.get('kit.json')!)) as KitManifest;
  const wavs = entries.filter((e) => e.name.endsWith('.wav')).map((e) => e.name);
  return { res, entries, byName, manifest, wavs, wav: (n: string) => decodeWav(byName.get(n)!) };
}

describe('notes', () => {
  it('names and parses with C4 = 60', () => {
    expect(noteName(60)).toBe('C4');
    expect(noteName(69)).toBe('A4');
    expect(noteName(0)).toBe('C-1');
    expect(parseNote('C4')).toBe(60);
    expect(parseNote('a4')).toBe(69);
    expect(parseNote('F#1')).toBe(30);
    expect(parseNote('Gb1')).toBe(30);
    expect(parseNote('Fs1')).toBe(30);
    expect(parseNote('60')).toBe(60);
    expect(parseNote('midi:36')).toBe(36);
    expect(parseNote('C-1')).toBe(0);
    expect(parseNote('G9')).toBe(127);
    expect(parseNote('G#9')).toBeNull();
    expect(parseNote('128')).toBeNull();
    expect(parseNote('H2')).toBeNull();
    expect(parseNote('')).toBeNull();
    for (let n = 0; n <= 127; n++) expect(parseNote(noteName(n))).toBe(n);
    expect(fileNote(30)).toBe('Fs1');
  });
  it('builds chromatic ranges, scales and custom lists', () => {
    expect(chromaticRange(48, 50)).toEqual([48, 49, 50]);
    expect(chromaticRange(50, 48)).toEqual([48, 49, 50]);
    expect(scaleNotes(0, 'major', 60, 72).map(noteName)).toEqual(['C4', 'D4', 'E4', 'F4', 'G4', 'A4', 'B4', 'C5']);
    expect(scaleNotes(9, 'minorPentatonic', 45, 57).map(noteName)).toEqual(['A2', 'C3', 'D3', 'E3', 'G3', 'A3']);
    expect(parseNoteList('C2, F#2 48 C3-D3')).toEqual({ notes: [36, 42, 48, 49, 50] });
    expect(parseNoteList('36..38')).toEqual({ notes: [36, 37, 38] });
    expect('error' in parseNoteList('C2, banana')).toBe(true);
    expect('error' in parseNoteList('  ')).toBe(true);
  });
});

describe('names', () => {
  it('follows the examples and avoids collisions', () => {
    const k = (note: number | null, vel: number | null, slot: number | null, slug = 'KICK', processing: 'dry' | 'wet' | null = null) => kitFileName({ slug, note, vel, slot, processing });
    expect(k(31, null, null)).toBe('KICK_G1.wav');
    expect(k(38, null, null, 'LO_TOM')).toBe('LO_TOM_D2.wav');
    expect(k(45, 96, null, 'HI_TOM')).toBe('HI_TOM_A2_VEL096.wav');
    expect(k(53, null, 1, 'PERC')).toBe('PERC_F3_VAR_B.wav');
    expect(k(null, null, null, 'CLAP')).toBe('CLAP.wav');
    expect(k(31, 5, 2, 'KICK', 'wet')).toBe('KICK_G1_VEL005_VAR_C_WET.wav');
    expect(nameSlug('Lo Tom!')).toBe('LO_TOM');
    expect(nameSlug('   ')).toBe('TRACK');
    const taken = new Set<string>();
    expect([uniqueName(taken, 'A.wav'), uniqueName(taken, 'a.wav'), uniqueName(taken, 'A.wav')]).toEqual(['A.wav', 'a_2.wav', 'A_3.wav']);
  });
  it('splits velocity into layers rendered at the top of each range', () => {
    expect(velocityLayers(1)).toEqual([{ index: 0, vel: 127, lo: 1, hi: 127 }]);
    expect(velocityLayers(4).map((l) => l.vel)).toEqual([32, 64, 95, 127]);
    for (const n of [4, 8, 16]) {
      const l = velocityLayers(n);
      expect(l).toHaveLength(n);
      expect(l[0]!.lo).toBe(1);
      expect(l[n - 1]!.hi).toBe(127);
      for (let i = 1; i < n; i++) expect(l[i]!.lo).toBe(l[i - 1]!.hi + 1);
    }
  });
});

describe('WAV files', () => {
  const ramp = (n: number) => Float32Array.from({ length: n }, (_, i) => Math.sin(i / 7) * 0.5);
  it('writes correct headers and samples for 16, 24 and 32-bit float', () => {
    for (const [fmt, bits, code, align] of [['pcm16', 16, 1, 4], ['pcm24', 24, 1, 6], ['float32', 32, 3, 8]] as const) {
      const w = encodeWav([ramp(100), ramp(100).map((x) => -x)], 44100, fmt);
      const v = new DataView(w.buffer);
      expect(String.fromCharCode(...w.subarray(0, 4))).toBe('RIFF');
      expect(String.fromCharCode(...w.subarray(8, 12))).toBe('WAVE');
      expect(v.getUint32(4, true)).toBe(w.length - 8);
      expect(v.getUint16(20, true)).toBe(code);
      expect(v.getUint16(22, true)).toBe(2);
      expect(v.getUint32(24, true)).toBe(44100);
      expect(v.getUint32(28, true)).toBe(44100 * align);
      expect(v.getUint16(32, true)).toBe(align);
      expect(v.getUint16(34, true)).toBe(bits);
      const d = decodeWav(w);
      expect(d.frames).toBe(100);
      expect(d.format).toBe(fmt);
      const tol = fmt === 'pcm16' ? 1 / 32768 : fmt === 'pcm24' ? 1 / 8388608 : 0;
      for (let i = 0; i < 100; i++) {
        expect(Math.abs(d.channelData[0]![i]! - ramp(100)[i]!)).toBeLessThanOrEqual(tol);
        expect(Math.abs(d.channelData[1]![i]! + ramp(100)[i]!)).toBeLessThanOrEqual(tol);
      }
    }
  });
  it('clamps integer output at full scale and keeps float values over 1', () => {
    const hot = Float32Array.from([2, -2, 0.5]);
    expect(Array.from(decodeWav(encodeWav([hot], 44100, 'pcm16')).channelData[0]!).slice(0, 2)).toEqual([32767 / 32768, -1]);
    expect(Array.from(decodeWav(encodeWav([hot], 44100, 'pcm24')).channelData[0]!).slice(0, 2)).toEqual([8388607 / 8388608, -1]);
    expect(Array.from(decodeWav(encodeWav([hot], 44100, 'float32')).channelData[0]!)).toEqual([2, -2, 0.5]);
  });
});

describe('options', () => {
  it('rejects what cannot be exported, in words', async () => {
    const { p } = await rig();
    const bad = (o: Partial<KitExportOptions>) => resolveOptions(p, { ...clone(KIT_EXPORT_DEFAULTS), ...o });
    expect(bad({ instruments: 'selected', trackIds: [] })).toHaveProperty('error');
    expect(bad({ instruments: 'selected', trackIds: ['nope'] })).toHaveProperty('error');
    expect(bad({ variations: 'selected', slots: [] })).toHaveProperty('error');
    expect(bad({ layers: 3 as never })).toHaveProperty('error');
    expect(bad({ format: 'mp3' as never })).toHaveProperty('error');
    expect(bad({ tail: { mode: 'custom', seconds: 0 } })).toHaveProperty('error');
    expect(bad({ tail: { mode: 'custom', seconds: 31 } })).toHaveProperty('error');
    expect(bad({ pitch: { ...KIT_EXPORT_DEFAULTS.pitch, mode: 'chromatic', lo: 'X9' } })).toHaveProperty('error');
    expect(bad({ pitch: { ...KIT_EXPORT_DEFAULTS.pitch, mode: 'custom', list: 'C2, nope' } })).toHaveProperty('error');
    expect(bad({ pitch: { ...KIT_EXPORT_DEFAULTS.pitch, mode: 'scale', scale: 'nope' } })).toHaveProperty('error');
    const ok = bad({ pitch: { ...KIT_EXPORT_DEFAULTS.pitch, mode: 'scale', root: 'A', scale: 'minor', lo: 'A1', hi: 'A2' } });
    expect('error' in ok).toBe(false);
    expect((ok as { notes: number[] }).notes.map(noteName)).toEqual(['A1', 'B1', 'C2', 'D2', 'E2', 'F2', 'G2', 'A2']);
  });
  it('refuses more files than the limit before rendering anything', async () => {
    const { p, lib } = await rig();
    let rendered = 0;
    await expect(run(p, lib, { pitch: { ...KIT_EXPORT_DEFAULTS.pitch, mode: 'chromatic', lo: '0', hi: '127' }, layers: 16 }, { onProgress: (g) => { if (g.stage === 'rendering') rendered++; } })).rejects.toThrow(/LIMIT/);
    expect(rendered).toBe(0);
  });
});

describe('rendering instruments', () => {
  it('renders one instrument as a real, finite, non-silent, deterministic stereo file at 44.1 kHz', async () => {
    const { p, lib, id } = await rig();
    const a = await run(p, lib, { instruments: 'selected', trackIds: [id('KICK')] });
    const b = await run(p, lib, { instruments: 'selected', trackIds: [id('KICK')] });
    expect(a.wavs).toHaveLength(1);
    const w = a.wav(a.wavs[0]!);
    expect([w.channels, w.rate, w.bits]).toEqual([2, 44100, 24]);
    const s = stats(w.channelData[0]!);
    expect(s.finite).toBe(true);
    expect(s.peak).toBeGreaterThan(0.5);
    expect(w.frames).toBeGreaterThan(5000);
    expect(Buffer.from(a.byName.get(a.wavs[0]!)!).equals(Buffer.from(b.byName.get(b.wavs[0]!)!))).toBe(true);
  });

  it('renders every track of the kit and keeps instruments apart', async () => {
    const { p, lib, id } = await rig();
    const all = await run(p, lib);
    expect(all.wavs.length).toBe(p.tracks.length);
    for (const t of p.tracks) expect(all.manifest.instruments.some((i) => i.name === t.name)).toBe(true);
    // changing another track's sound or mixer changes nothing in this track's file
    const q = clone(p);
    const clap = q.tracks.find((t) => t.name === 'CLAP')!;
    clap.sound.gain = 0.2;
    clap.mix.volume = 0.3;
    q.tracks.find((t) => t.name === 'SNARE')!.sound.trigger = 1;
    const other = await run(q, lib);
    for (const name of ['KICK.wav', 'HI_TOM.wav', 'CL_HAT.wav']) {
      const f = all.wavs.find((w) => w.startsWith(name.replace('.wav', '')))!;
      expect(Buffer.from(all.byName.get(f)!).equals(Buffer.from(other.byName.get(f)!)), name).toBe(true);
    }
    // a muted or soloed track in the project is still rendered
    const m = clone(p);
    m.tracks.find((t) => t.name === 'KICK')!.mix.mute = true;
    m.tracks.find((t) => t.name === 'SNARE')!.mix.solo = true;
    const muted = await run(m, lib, { instruments: 'selected', trackIds: [id('KICK')] });
    expect(stats(muted.wav(muted.wavs[0]!).channelData[0]!).peak).toBeGreaterThan(0.5);
  });

  it('keeps stereo: a hard-panned sample stays on its side', async () => {
    const { p, lib, id } = await rig();
    const q = clone(p);
    q.tracks.find((t) => t.name === 'CLAP')!.sound.pan = -1;
    q.tracks.find((t) => t.name === 'CLAP')!.mix.pan = 0.8; // the fader pan is not part of a sample
    const r = await run(q, lib, { instruments: 'selected', trackIds: [id('CLAP')], normalise: false });
    const w = r.wav(r.wavs[0]!);
    expect(stats(w.channelData[0]!).peak).toBeGreaterThan(0.05);
    expect(stats(w.channelData[1]!).peak).toBeLessThan(stats(w.channelData[0]!).peak * 0.2);
  });

  it('DRY, WET and BOTH: the channel strip is in WET only', async () => {
    const { p, lib } = await rig();
    const q = clone(p);
    const hat = q.tracks.find((t) => t.name === 'HI TOM')!;
    hat.mix.filter = 0.85; // one-knob high-pass
    const sel = { instruments: 'selected' as const, trackIds: [hat.id], normalise: false };
    const dry = await run(q, lib, { ...sel, processing: 'dry' });
    const wet = await run(q, lib, { ...sel, processing: 'wet' });
    const both = await run(q, lib, { ...sel, processing: 'both' });
    expect(both.wavs).toHaveLength(2);
    const named = (r: typeof dry, proc: string) => r.wavs.find((w) => w.endsWith(`_${proc}.wav`))!;
    expect(both.wavs.map((w) => w.replace(/_[A-G]s?\d_/, '_')).sort()).toEqual(['HI_TOM_DRY.wav', 'HI_TOM_WET.wav']);
    const rms = (r: typeof dry) => stats(r.wav(r.wavs[0]!).channelData[0]!).rms;
    expect(rms(wet)).toBeLessThan(rms(dry) * 0.95);
    expect(Buffer.from(both.byName.get(named(both, 'DRY'))!).equals(Buffer.from(dry.byName.get(dry.wavs[0]!)!))).toBe(true);
    expect(Buffer.from(both.byName.get(named(both, 'WET'))!).equals(Buffer.from(wet.byName.get(wet.wavs[0]!)!))).toBe(true);
    expect(dry.manifest.files[0]!.processing).toBe('dry');
    expect(wet.manifest.files[0]!.processing).toBe('wet');
  });

  it('automatic tails follow the sound to silence; a custom tail is exactly that long', async () => {
    const { p, lib, id } = await rig();
    const sel = { instruments: 'selected' as const, trackIds: [id('CYMBAL')], normalise: false };
    const auto = await run(p, lib, { ...sel, tail: { mode: 'auto', seconds: 2 } });
    const w = auto.wav(auto.wavs[0]!);
    const l = w.channelData[0]!;
    // ends within 20 ms of the last audible sample, and nothing audible is cut off
    const st = stats(l);
    expect(st.last).toBeLessThan(l.length);
    expect(l.length - st.last).toBeLessThan(44100 * 0.05);
    expect(Math.abs(l[l.length - 1]!)).toBeLessThan(1e-3);
    expect(auto.manifest.files[0]!.tailCut).toBe(false);
    const fixed = await run(p, lib, { ...sel, tail: { mode: 'custom', seconds: 0.25 } });
    expect(fixed.wav(fixed.wavs[0]!).frames).toBe(Math.round(0.25 * 44100));
    expect(Math.abs(fixed.wav(fixed.wavs[0]!).channelData[0]!.at(-1)!)).toBeLessThan(1e-3);
    const long = await run(p, lib, { ...sel, tail: { mode: 'custom', seconds: 4 } });
    expect(long.wav(long.wavs[0]!).frames).toBe(4 * 44100);
    expect(long.wav(long.wavs[0]!).frames).toBeGreaterThan(w.frames);
  });
});

describe('variations', () => {
  it('exports BASE, populated variations only, or a selection, each named VAR_x', async () => {
    const { p, lib } = await rig();
    const q = clone(p);
    const kick = q.tracks.find((t) => t.name === 'KICK')!;
    kick.sound.variations = [{ name: 'UP', params: { [PAR.COARSE1]: (q.kit.synth.params[PAR.COARSE1] ?? 64) + 12 } }, null, { name: 'DOWN', params: { [PAR.COARSE1]: (q.kit.synth.params[PAR.COARSE1] ?? 64) - 5 } }, null];
    const sel = { instruments: 'selected' as const, trackIds: [kick.id] };
    const base = await run(q, lib, { ...sel, variations: 'base' });
    expect(base.wavs).toHaveLength(1);
    const all = await run(q, lib, { ...sel, variations: 'all' });
    expect(all.wavs.sort()).toHaveLength(3);
    expect(all.wavs.some((n) => n.endsWith('_VAR_A.wav'))).toBe(true);
    expect(all.wavs.some((n) => n.endsWith('_VAR_C.wav'))).toBe(true);
    // the variation is a different sound: an octave up for A
    const a = all.manifest.files.find((f) => f.variation === 'A')!;
    const b0 = all.manifest.files.find((f) => f.variation === 'BASE')!;
    expect(cents(a.pitch.targetHz!, b0.pitch.targetHz! * 2)).toBeLessThan(60);
    const sele = await run(q, lib, { ...sel, variations: 'selected', slots: [1, 2] });
    expect(sele.wavs).toEqual(['KICK_VAR_C.wav'].map((n) => sele.wavs.find((w) => w.includes('VAR_C')) ?? n));
    expect(sele.res.warnings.some((w) => /VARIATION B IS EMPTY/.test(w))).toBe(true);
  });
  it('a variation renders its own parameters, which differ from the base', async () => {
    const { p, lib } = await rig();
    const q = clone(p);
    const snare = q.tracks.find((t) => t.name === 'SNARE')!;
    snare.sound.variations = [{ name: 'LONG', params: { [PAR.VELOD4]: 120 } }, null, null, null];
    const r = await run(q, lib, { instruments: 'selected', trackIds: [snare.id], variations: 'all', normalise: false });
    const [vA, vB] = [r.manifest.files.find((f) => f.variation === 'A')!, r.manifest.files.find((f) => f.variation === 'BASE')!];
    expect(Buffer.from(r.byName.get(vA.file)!).equals(Buffer.from(r.byName.get(vB.file)!))).toBe(false);
  });
});

describe('velocity layers and normalisation', () => {
  it('renders N layers, louder with velocity, named VEL###, with metadata ranges', async () => {
    const { p, lib, id } = await rig();
    for (const n of [4, 8] as const) {
      const r = await run(p, lib, { instruments: 'selected', trackIds: [id('SNARE')], layers: n, normalise: false });
      expect(r.wavs).toHaveLength(n);
      const files = r.manifest.files.slice().sort((a, b) => a.velocity.midi - b.velocity.midi);
      expect(files[0]!.velocity).toMatchObject({ layer: 1, of: n, low: 1 });
      expect(files.at(-1)!.velocity).toMatchObject({ midi: 127, high: 127 });
      for (let i = 1; i < n; i++) expect(files[i]!.peak).toBeGreaterThan(files[i - 1]!.peak);
      expect(r.wavs.some((w) => /^SNARE_.*VEL127\.wav$/.test(w))).toBe(true);
      expect(r.wavs.every((w) => /_VEL\d{3}\.wav$/.test(w) || /_[A-G]s?\d_VEL\d{3}\.wav$/.test(w))).toBe(true);
    }
    const one = await run(p, lib, { instruments: 'selected', trackIds: [id('SNARE')], layers: 1 });
    expect(one.wavs.every((w) => !/VEL/.test(w))).toBe(true);
  });

  it('normalisation puts the loudest file at -1 dBFS and keeps the balance between layers', async () => {
    const { p, lib, id } = await rig();
    const sel = { instruments: 'selected' as const, trackIds: [id('SNARE')], layers: 4 as const, format: 'float32' as const };
    const raw = await run(p, lib, { ...sel, normalise: false });
    const norm = await run(p, lib, { ...sel, normalise: true });
    const peaks = (r: typeof raw) => r.manifest.files.slice().sort((a, b) => a.velocity.midi - b.velocity.midi).map((f) => f.peak);
    const [pr, pn] = [peaks(raw), peaks(norm)];
    expect(Math.max(...pn)).toBeCloseTo(0.8912509, 3);
    for (let i = 0; i < 4; i++) expect(pn[i]! / pn[3]!).toBeCloseTo(pr[i]! / pr[3]!, 3);
    // the gain is the same for every file of the instrument and recorded
    const gains = new Set(norm.manifest.files.map((f) => f.gain));
    expect(gains.size).toBe(1);
    // and the audio really is the raw audio scaled by it
    const f = norm.manifest.files[0]!;
    const rawFile = raw.manifest.files.find((x) => x.velocity.midi === f.velocity.midi)!;
    const a = raw.wav(rawFile.file).channelData[0]!;
    const b = norm.wav(f.file).channelData[0]!;
    const i = a.findIndex((v) => Math.abs(v) > 0.05);
    expect(b[i]! / a[i]!).toBeCloseTo(f.gain, 3);
    // normalisation off never rescales
    expect(new Set(raw.manifest.files.map((x) => x.gain))).toEqual(new Set([1]));
  });

  it('warns about clipping an integer file made without normalisation', async () => {
    const { p, lib } = await rig();
    const q = clone(p);
    const t = q.tracks.find((x) => x.name === 'CLAP')!;
    t.sound.gain = 2;
    const loud = await run(q, lib, { instruments: 'selected', trackIds: [t.id], normalise: false, format: 'pcm16' });
    const fl = await run(q, lib, { instruments: 'selected', trackIds: [t.id], normalise: false, format: 'float32' });
    const peak = fl.manifest.files[0]!.peak;
    if (peak > 1) {
      expect(loud.manifest.files[0]!.clipped).toBe(true);
      expect(loud.res.warnings.some((w) => /CLIPPED/.test(w))).toBe(true);
      expect(fl.manifest.files[0]!.clipped).toBe(false);
    } else expect(loud.manifest.files[0]!.clipped).toBe(false);
  });
});

describe('pitch ranges and labels', () => {
  const sel = (id: string) => ({ instruments: 'selected' as const, trackIds: [id] });

  it('original pitch: named by the measured note when it is reliable, with its cents', async () => {
    const { p, lib, id } = await rig();
    const r = await run(p, lib, sel(id('KICK')));
    const f = r.manifest.files[0]!;
    expect(f.pitch.tuning).toBe('original');
    expect(f.pitch.mode).toBe('original');
    expect(r.wavs[0]).toBe(`KICK_${fileNote(f.pitch.midi!)}.wav`);
    // the label is true of the audio in the file
    const w = r.wav(r.wavs[0]!);
    const a = analysePitch(w.channelData, w.rate);
    expect(cents(a.fundamental!.hz, midiToHz(f.pitch.midi!))).toBeLessThan(50);
  });

  it('chromatic range: every note is made, and the audio is at the pitch the name says', async () => {
    const { p, lib, id } = await rig();
    const r = await run(p, lib, { ...sel(id('KICK')), pitch: { ...KIT_EXPORT_DEFAULTS.pitch, mode: 'chromatic', lo: 'C2', hi: 'G2' } });
    expect(r.wavs.sort()).toEqual(['KICK_C2.wav', 'KICK_Cs2.wav', 'KICK_D2.wav', 'KICK_Ds2.wav', 'KICK_E2.wav', 'KICK_F2.wav', 'KICK_Fs2.wav', 'KICK_G2.wav']);
    for (const f of r.manifest.files) {
      const w = r.wav(f.file);
      const a = analysePitch(w.channelData, w.rate);
      expect(a.fundamental, f.file).not.toBeNull();
      expect(cents(a.fundamental!.hz, midiToHz(f.pitch.midi!)), f.file).toBeLessThan(25);
      expect(f.pitch).toMatchObject({ mode: 'retuned', tuning: 'confirmed' });
      expect(Math.abs(f.pitch.errorCents!)).toBeLessThan(20);
    }
  });

  it('scale and custom ranges give exactly their notes; MIDI numbers work; high notes retune sample layers', async () => {
    const { p, lib, id } = await rig();
    const sc = await run(p, lib, { ...sel(id('HI TOM')), pitch: { ...KIT_EXPORT_DEFAULTS.pitch, mode: 'scale', root: 'D', scale: 'minorPentatonic', lo: 'D2', hi: 'D3' } });
    expect(sc.manifest.files.map((f) => f.pitch.note).sort()).toEqual(['A2', 'C3', 'D2', 'D3', 'F2', 'G2']);
    expect(sc.manifest.scale).toMatchObject({ root: 'D', name: 'minorPentatonic', notes: ['D2', 'F2', 'G2', 'A2', 'C3', 'D3'] });
    const cu = await run(p, lib, { ...sel(id('PERC')), pitch: { ...KIT_EXPORT_DEFAULTS.pitch, mode: 'custom', list: '48, F#3 A3' } });
    expect(cu.manifest.files.map((f) => f.pitch.note)).toEqual(['C3', 'Fs3'.replace('s', '#'), 'A3']);
    expect(cu.wavs.sort()).toEqual(['PERC_A3.wav', 'PERC_C3.wav', 'PERC_Fs3.wav']);
    for (const f of cu.manifest.files) {
      const w = cu.wav(f.file);
      const a = analysePitch(w.channelData, w.rate);
      expect(cents(a.fundamental!.hz, midiToHz(f.pitch.midi!)), f.file).toBeLessThan(30);
    }
  });

  it('a sound without a single pitch is exported once, at its original pitch, with no note and a warning', async () => {
    const { p, lib, id } = await rig();
    for (const name of ['CLAP', 'CYMBAL']) {
      const r = await run(p, lib, { ...sel(id(name)), pitch: { ...KIT_EXPORT_DEFAULTS.pitch, mode: 'chromatic', lo: 'C2', hi: 'C3' } });
      expect(r.wavs).toEqual([`${nameSlug(name)}.wav`]);
      expect(r.manifest.files[0]!.pitch).toMatchObject({ note: null, midi: null, tuning: 'none', mode: 'original' });
      expect(r.res.warnings.some((w) => w.startsWith(name) && /ORIGINAL PITCH ONLY/.test(w))).toBe(true);
    }
  });

  it('files that cannot be confirmed are labelled in the metadata as such (below the analysable range)', async () => {
    const { p, lib, id } = await rig();
    const r = await run(p, lib, { ...sel(id('KICK')), pitch: { ...KIT_EXPORT_DEFAULTS.pitch, mode: 'custom', list: 'C0' } });
    const f = r.manifest.files[0]!;
    expect(f.pitch.tuning).toBe('unverified');
    expect(f.pitch.measuredHz).toBeNull();
    expect(r.res.warnings.some((w) => /BELOW WHAT THE ANALYSIS CAN CONFIRM|COULD NOT BE MEASURED/.test(w)) || r.res.skipped.length > 0).toBe(true);
  });

  it('velocity layers share the tuning of their note', async () => {
    const { p, lib, id } = await rig();
    const r = await run(p, lib, { ...sel(id('KICK')), layers: 4, pitch: { ...KIT_EXPORT_DEFAULTS.pitch, mode: 'custom', list: 'E2' } });
    expect(r.wavs.sort()).toEqual(['KICK_E2_VEL032.wav', 'KICK_E2_VEL064.wav', 'KICK_E2_VEL095.wav', 'KICK_E2_VEL127.wav']);
    for (const f of r.manifest.files) expect(f.pitch.tuning).toBe('confirmed');
  });
});

describe('the ZIP and kit.json', () => {
  it('holds the WAV files and a versioned manifest that says what each one is', async () => {
    const { p, lib, id } = await rig();
    const q = clone(p);
    q.tracks.find((t) => t.name === 'KICK')!.sound.variations = [{ name: 'UP', params: { [PAR.COARSE1]: 70 } }, null, null, null];
    const r = await run(q, lib, { instruments: 'selected', trackIds: [id('KICK'), id('SNARE')], variations: 'all', layers: 4, pitch: { ...KIT_EXPORT_DEFAULTS.pitch, mode: 'custom', list: 'C2' }, format: 'pcm16', processing: 'both' });
    const m = r.manifest;
    expect(r.res.file.name).toMatch(/\.zip$/);
    expect(r.res.file.type).toBe('application/zip');
    expect(r.entries.map((e) => e.name).sort()).toEqual([...r.wavs, 'kit.json'].sort());
    expect(new Set(r.wavs).size).toBe(r.wavs.length);
    expect(m.format).toBe('clatter-kit-export');
    expect(m.version).toBe(1);
    expect(m.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(m.kit).toMatchObject({ name: q.kit.name, seed: q.kit.seed, projectSeed: q.seed, tempo: q.tempo });
    expect(m.settings).toMatchObject({ sampleRate: 44100, bitDepth: 16, layers: 4, processing: 'both', format: 'pcm16', normalise: true });
    expect(m.settings.layerRanges.map((l) => l.velocity)).toEqual([32, 64, 95, 127]);
    expect(m.synth.params).toEqual(q.kit.synth.params);
    expect(m.instruments.map((i) => i.name)).toEqual(['KICK', 'SNARE']);
    const kick = m.instruments[0]!;
    expect(kick.variations[0]).toMatchObject({ slot: 'A', name: 'UP', params: { [PAR.COARSE1]: 70 }, empty: false });
    expect(kick.variations[1]).toMatchObject({ empty: true });
    expect(kick.sound.mode).toBe('synth');
    expect(Object.keys(kick.analysis).sort()).toEqual(['A', 'BASE']);
    expect(kick.analysis.BASE).toMatchObject({ kind: expect.stringMatching(/stable|swept/), method: 'YIN+SPECTRUM/1' });
    // every file listed exists, with the format it was asked for, and is described by the manifest
    expect(m.files).toHaveLength(r.wavs.length);
    expect(r.wavs.length).toBe((2 + 1) * 4 * 2); // KICK base and A, SNARE base (its variations are empty)
    for (const f of m.files) {
      const w = r.wav(f.file);
      expect([w.bits, w.rate, w.channels, w.frames]).toEqual([16, f.sampleRate, f.channels, f.frames]);
      expect(f.format).toBe('pcm16');
      expect(Math.abs(stats(w.channelData[0]!).peak - f.peak)).toBeLessThan(0.002);
    }
    // the same project gives the same archive
    const again = await run(q, lib, { instruments: 'selected', trackIds: [id('KICK'), id('SNARE')], variations: 'all', layers: 4, pitch: { ...KIT_EXPORT_DEFAULTS.pitch, mode: 'custom', list: 'C2' }, format: 'pcm16', processing: 'both' });
    expect(Buffer.from(again.res.file.data).equals(Buffer.from(r.res.file.data))).toBe(true);
  });

  it('names two tracks with the same name apart', async () => {
    const { p, lib } = await rig();
    const q = clone(p);
    q.tracks.find((t) => t.name === 'HI TOM')!.name = 'LO TOM';
    const r = await run(q, lib, { instruments: 'selected', trackIds: q.tracks.filter((t) => t.name === 'LO TOM').map((t) => t.id) });
    expect(r.wavs.map((w) => w.replace(/_[A-G]s?\d\.wav$/, '')).sort()).toEqual(['LO_TOM', 'LO_TOM_2']);
  });

  it('writes 24-bit and float files with their own headers', async () => {
    const { p, lib, id } = await rig();
    for (const [format, bits] of [['pcm24', 24], ['float32', 32]] as const) {
      const r = await run(p, lib, { instruments: 'selected', trackIds: [id('SNARE')], format });
      expect(r.wav(r.wavs[0]!)).toMatchObject({ bits, format, rate: 44100, channels: 2 });
    }
  });
});

describe('progress, cancellation and the source kit', () => {
  it('reports the stage, instrument and files done', async () => {
    const { p, lib, id } = await rig();
    const seen: string[] = [];
    let last = 0;
    await run(p, lib, { instruments: 'selected', trackIds: [id('KICK'), id('SNARE')], layers: 4 }, { onProgress: (g) => { seen.push(g.stage + ':' + g.instrument); last = g.done; } });
    expect(seen[0]).toBe('analysing:KICK');
    expect(seen).toContain('rendering:SNARE');
    expect(seen.at(-1)).toBe('done:');
    expect(last).toBe(8);
  });

  it('stops when cancelled, delivers nothing, and is usable again', async () => {
    const { p, lib } = await rig();
    const ctl = new AbortController();
    let files = 0;
    await expect(run(p, lib, { layers: 4 }, { signal: ctl.signal, onProgress: (g) => { if (g.stage === 'rendering' && ++files === 3) ctl.abort(); } })).rejects.toBeInstanceOf(KitExportCancelled);
    expect(files).toBeLessThan(6);
    const delivered: string[] = [];
    const notes: string[] = [];
    const job = new KitExportJob({
      project: () => p,
      run: (project, options, onProgress, signal) => exportKit(project, options, { module: lxrModule(), library: lib, onProgress, signal }),
      deliver: (f) => delivered.push(f.name),
      notify: (t, l) => notes.push(`${l}: ${t}`),
    });
    const s = job.start({ ...clone(KIT_EXPORT_DEFAULTS), layers: 4 });
    expect(s.started).toBe(true);
    expect(job.start(clone(KIT_EXPORT_DEFAULTS)).started).toBe(false);
    await new Promise((r) => setTimeout(r, 150));
    job.cancel();
    expect(job.state.cancelling).toBe(true);
    await s.done;
    expect(delivered).toEqual([]);
    expect(notes).toEqual(['info: KIT EXPORT CANCELLED: NOTHING WAS SAVED']);
    expect(job.busy).toBe(false);
    const ok = job.start({ ...clone(KIT_EXPORT_DEFAULTS), instruments: 'selected', trackIds: [p.tracks[0]!.id] });
    await ok.done;
    expect(delivered).toHaveLength(1);
    expect(notes.at(-1)).toMatch(/^info: EXPORTED .*\.zip: 1 FILES/);
  });

  it('reports an error instead of failing quietly, and refuses bad settings at the start', async () => {
    const { p } = await rig();
    const notes: string[] = [];
    const job = new KitExportJob({ project: () => p, run: async () => { throw new Error('boom'); }, deliver: () => notes.push('delivered'), notify: (t, l) => notes.push(`${l}: ${t}`) });
    expect(job.start({ ...clone(KIT_EXPORT_DEFAULTS), layers: 3 as never })).toMatchObject({ started: false, error: expect.stringMatching(/LAYERS/) });
    await job.start(clone(KIT_EXPORT_DEFAULTS)).done;
    expect(notes).toEqual(['error: KIT EXPORT FAILED: boom']);
    expect(job.state.last?.ok).toBe(false);
  });

  it('never changes the project it exports', async () => {
    const { p, lib } = await rig();
    const before = JSON.stringify(p);
    await run(p, lib, { variations: 'all', layers: 4, processing: 'both', pitch: { ...KIT_EXPORT_DEFAULTS.pitch, mode: 'chromatic', lo: 'C2', hi: 'D2' }, instruments: 'selected', trackIds: p.tracks.slice(0, 3).map((t) => t.id) });
    expect(JSON.stringify(p)).toBe(before);
  });

  it('leaves the existing pattern export untouched', async () => {
    const { renderProject } = await import('../src/audio/render');
    const { p, lib } = await rig();
    const a = await renderProject(lxrModule(), p, lib, { bars: 1, tail: 0 });
    await run(p, lib, { instruments: 'selected', trackIds: [p.tracks[0]!.id] });
    const b = await renderProject(lxrModule(), p, lib, { bars: 1, tail: 0 });
    expect(Buffer.from(a.master[0]!.buffer, a.master[0]!.byteOffset, a.master[0]!.byteLength).equals(Buffer.from(b.master[0]!.buffer, b.master[0]!.byteOffset, b.master[0]!.byteLength))).toBe(true);
  });
});
