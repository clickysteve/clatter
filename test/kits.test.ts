/** Sample sets, synth kits and full kits: naming, intake, libraries, loading, files, compatibility. */
import { describe, expect, it } from 'vitest';
import { encodeWav16, createZip } from '@slopfactory/core/export';
import { IndexedDbKitStore, KitError, MemoryKitStore, readKitArchive } from '@slopfactory/core/kits';
import { MemorySampleStore } from '@slopfactory/core/storage';
import { SampleLibrary } from '../src/audio/library';
import { KitManager } from '../src/app/kitManager';
import { defaultProject } from '../src/model/defaults';
import { kitOf, writeKitFile } from '../src/model/kitFile';
import { fullKitOf, parseSynthKit, serializeSynthKit, synthKitOf } from '../src/model/kits';
import { parseProject, serialize } from '../src/model/project';
import { clone, type Project, type Role } from '../src/model/types';
import { bestRole, guessRoles, proposeMapping, setNameFrom } from '../src/samples/names';
import { cleanPath, intakeFromEntries, intakeFromZip, isJunk, type Candidate } from '../src/samples/intake';
import { captureSet, planSet, defaultApply, targetsOf } from '../src/samples/sets';
import { mapKit } from '@slopfactory/core/kits';
import { newLxr } from './helpers';
import { readKit } from '../src/sound/kitcheck';
import { lockableParams } from '../src/sound/stepSound';
import { setHit } from '../src/rhythm/pattern';
import type { App } from '../src/app/app';

const init = readKit(newLxr(1));
/** a parameter of voice 0 that variations may override */
const P = lockableParams(0)[0]!.id;

/** a short, distinct WAV (the frequency makes each one a different file) */
async function wav(freq: number, len = 2205): Promise<Uint8Array> {
  const ch = new Float32Array(len);
  for (let i = 0; i < len; i++) ch[i] = Math.sin((2 * Math.PI * freq * i) / 44100) * 0.5 * (1 - i / len);
  return encodeWav16([ch], 44100);
}
const cand = async (path: string, freq: number): Promise<Candidate> => {
  const b = await wav(freq);
  return { path, size: b.byteLength, type: 'audio/wav', bytes: async () => b.slice().buffer };
};

const TR606: [string, number][] = [['606 Kick.wav', 60], ['606 Snare.wav', 200], ['606 CH.wav', 8000], ['606 OH.wav', 6000], ['606 LT.wav', 100], ['606 HT.wav', 150], ['606 Cymbal.wav', 5000]];

/** A project and the kit libraries over shared in-memory stores, standing in for the App. */
async function rig(project: Project = proj(), shared?: { audio: MemorySampleStore; sets: MemoryKitStore; full: MemoryKitStore }) {
  const audio = shared?.audio ?? new MemorySampleStore();
  const stores = { sets: shared?.sets ?? new MemoryKitStore(), full: shared?.full ?? new MemoryKitStore() };
  const library = new SampleLibrary(audio);
  const undo: string[] = [];
  const app = {
    project,
    library,
    initKit: init,
    host: { start: async () => undefined, ctx: null },
    emit: () => undefined,
    edit: (label: string, fn: () => void) => {
      undo.push(label);
      fn();
    },
    applyKitChange: (next: Project['kit']['synth']) => {
      project.kit.synth = next;
    },
    syncTracks: () => undefined,
    setSampleSetName: (n: string) => {
      if (n) project.sampleSet = n;
      else delete project.sampleSet;
    },
  } as unknown as App;
  const km = await KitManager.create(app, audio, stores);
  return { app, km, library, audio, stores, undo, project };
}

function proj(): Project {
  const p = defaultProject();
  p.kit.synth = clone(init);
  for (const t of p.tracks) t.sound.samples = [];
  return p;
}

const track = (p: Project, role: Role) => p.tracks.find((t) => t.role === role)!;

describe('recognising drum samples from file names', () => {
  const cases: [string, Role][] = [
    ['606 Kick.wav', 'kick'], ['BD0075.WAV', 'kick'], ['Bass Drum 1.wav', 'kick'], ['TR606_BD.wav', 'kick'], ['kik_03.wav', 'kick'],
    ['Snare.aif', 'snare'], ['SD0010.wav', 'snare'], ['606-SNR.wav', 'snare'],
    ['Clap.wav', 'clap'], ['CP.wav', 'clap'], ['hand_clap_02.wav', 'clap'],
    ['Closed Hat.wav', 'chat'], ['CH.wav', 'chat'], ['hihat_closed.wav', 'chat'], ['CHH 3.wav', 'chat'], ['HH Closed.wav', 'chat'], ['ClosedHat.wav', 'chat'],
    ['Open Hat.wav', 'ohat'], ['OH.wav', 'ohat'], ['hihat open.wav', 'ohat'], ['OHH.wav', 'ohat'], ['HatOpen.wav', 'ohat'],
    ['Low Tom.wav', 'ltom'], ['LT.wav', 'ltom'], ['tom_low.wav', 'ltom'], ['TomLo.wav', 'ltom'],
    ['High Tom.wav', 'htom'], ['HT.wav', 'htom'], ['tom-high.wav', 'htom'],
    ['Cymbal.wav', 'cymbal'], ['CY.wav', 'cymbal'], ['Ride.wav', 'cymbal'], ['crash 2.wav', 'cymbal'],
    ['Perc.wav', 'perc'], ['Cowbell.wav', 'perc'], ['rimshot.wav', 'perc'],
    ['FX.wav', 'fx'], ['sfx_riser.wav', 'fx'],
  ];
  it.each(cases)('%s is %s', (file, role) => expect(bestRole(file)?.role).toBe(role));

  it('uses folder names when the file name says nothing', () => {
    expect(bestRole('Kicks/01.wav')?.role).toBe('kick');
    expect(bestRole('606/Hats/Open/03.wav')?.role).toBe('ohat');
    expect(bestRole('Toms/Low/a.wav')?.role).toBe('ltom');
  });

  it('does not invent a role for a file it cannot place', () => {
    expect(bestRole('take 7 final.wav')).toBeNull();
    expect(bestRole('01.wav')).toBeNull();
  });

  it('gives a plain "hat" to the closed hat and a plain "tom" to neither tom with confidence', () => {
    const hat = guessRoles('hat.wav');
    expect(hat.chat).toBeGreaterThan(hat.ohat ?? 0);
    const tom = guessRoles('tom.wav');
    expect(tom.ltom).toBeLessThan(0.5);
  });

  it('proposes a TR-606 mapping, one file per track, and names the set from the folder', () => {
    const files = TR606.map(([path]) => ({ path }));
    const m = proposeMapping(files);
    const named = (r: Role) => (m.pick[r] === null ? null : files[m.pick[r]!]!.path);
    expect(named('kick')).toBe('606 Kick.wav');
    expect(named('snare')).toBe('606 Snare.wav');
    expect(named('chat')).toBe('606 CH.wav');
    expect(named('ohat')).toBe('606 OH.wav');
    expect(named('ltom')).toBe('606 LT.wav');
    expect(named('htom')).toBe('606 HT.wav');
    expect(named('cymbal')).toBe('606 Cymbal.wav');
    expect(named('clap')).toBeNull();
    expect(m.unused).toEqual([]);
    expect(setNameFrom('TR-606_Samples.kit.zip')).toBe('TR-606 SAMPLES');
  });

  it('breaks ties deterministically and reports the ambiguity', () => {
    const files = ['kick 2.wav', 'kick 10.wav', 'kick 1.wav', 'Sub/kick.wav'].map((path) => ({ path }));
    const m = proposeMapping(files);
    expect(files[m.pick.kick!]!.path).toBe('kick 1.wav');
    expect(m.ambiguous).toContain('kick');
    expect(m.candidates.kick).toHaveLength(4);
    expect(proposeMapping(files)).toEqual(m);
  });

  it('never gives one file to two tracks', () => {
    const files = [{ path: 'hat.wav' }, { path: 'closed hat.wav' }];
    const m = proposeMapping(files);
    const picks = Object.values(m.pick).filter((x) => x !== null);
    expect(new Set(picks).size).toBe(picks.length);
  });
});

describe('collecting audio from folders and ZIP archives', () => {
  it('ignores metadata, hidden files and macOS forks, keeps nested folders, and strips one root folder', async () => {
    const enc = new TextEncoder();
    const w = await wav(100);
    const zip = createZip([
      { name: 'TR-606/Kick.wav', data: w },
      { name: 'TR-606/Hats/Open/oh.wav', data: w },
      { name: 'TR-606/readme.txt', data: enc.encode('hi') },
      { name: '__MACOSX/TR-606/._Kick.wav', data: enc.encode('x') },
      { name: 'TR-606/.DS_Store', data: enc.encode('x') },
      { name: 'TR-606/Thumbs.db', data: enc.encode('x') },
    ]);
    const intake = await intakeFromZip(zip, 'TR-606.zip');
    expect(intake.candidates.map((c) => c.path)).toEqual(['Hats/Open/oh.wav', 'Kick.wav']);
    expect(intake.ignored).toBeGreaterThanOrEqual(4);
    expect(bestRole(intake.candidates[0]!.path)?.role).toBe('ohat');
  });

  it('refuses paths that escape the folder, and archives that are not ZIPs', async () => {
    expect(cleanPath('../evil.wav')).toBeNull();
    expect(cleanPath('/abs/kick.wav')).toBeNull();
    expect(cleanPath('C:\\x\\kick.wav')).toBeNull();
    expect(cleanPath('a\\b/./kick.wav')).toBe('a/b/kick.wav');
    expect(isJunk('a/.hidden.wav')).toBe(true);
    await expect(intakeFromZip(new Uint8Array([1, 2, 3, 4]), 'x.zip')).rejects.toThrow(/ZIP/);
    expect(intakeFromEntries([{ name: '../x.wav', data: new Uint8Array(4) }], 'x').candidates).toEqual([]);
  });
});

describe('sample set library', () => {
  async function tr606(r: Awaited<ReturnType<typeof rig>>, name = 'TR-606') {
    const files = await Promise.all(TR606.map(([p, f]) => cand(p, f)));
    const m = proposeMapping(files);
    const picks = (Object.entries(m.pick) as [Role, number | null][]).filter(([, i]) => i !== null).map(([role, i]) => ({ role, file: files[i!]! }));
    return r.km.createSet(name, picks);
  }

  it('saves an imported folder as a set, lists it, and survives a restart without the original files', async () => {
    const r = await rig();
    const kit = await tr606(r);
    expect(kit.instruments).toHaveLength(7);
    expect((await r.km.sets.listKits()).map((k) => k.name)).toEqual(['TR-606']);
    // a new session over the same stores (a browser restart): a fresh project, a fresh in-memory library
    const r2 = await rig(proj(), { audio: r.audio, sets: r.stores.sets, full: r.stores.full });
    expect(r2.km.session.kits.map((k) => k.name)).toEqual(['TR-606']);
    await r2.km.session.load(r2.km.session.kits[0]!.id);
    const kick = track(r2.project, 'kick');
    expect(kick.sound.samples).toHaveLength(1);
    expect(r2.library.get(kick.sound.samples[0]!)).toBeDefined();
    expect(kick.sound.mode).toBe('sample');
    expect(track(r2.project, 'clap').sound.samples).toEqual([]);
    expect(track(r2.project, 'clap').sound.mode).toBe(track(proj(), 'clap').sound.mode);
  });

  it('stores the same audio once however many sets use it', async () => {
    const r = await rig();
    await tr606(r, 'A');
    const before = (await r.audio.list()).length;
    await tr606(r, 'B');
    expect((await r.audio.list()).length).toBe(before);
    expect((await r.km.sets.listKits()).length).toBe(2);
  });

  it('renames, duplicates and deletes without losing samples another set uses', async () => {
    const r = await rig();
    const a = await tr606(r, 'A');
    const copy = await r.km.sets.duplicateKit(a.id);
    await r.km.sets.renameKit(a.id, 'B');
    expect((await r.km.sets.listKits()).map((k) => k.name).sort()).toEqual(['A Copy', 'B']);
    await r.km.sets.deleteKit(a.id, { removeUnusedSamples: true });
    expect((await r.km.sets.listKits()).map((k) => k.id)).toEqual([copy.id]);
    expect((await r.audio.list()).length).toBe(7);
  });

  it('refuses a duplicate name unless asked to replace', async () => {
    const r = await rig();
    await tr606(r, 'SAME');
    await expect(tr606(r, 'same')).rejects.toMatchObject({ code: 'exists' });
    await expect(tr606(r, 'same').catch(() => 'x')).resolves.toBe('x');
  });

  it('loading a set leaves synthesis, the rhythm, step sounds, locks and unrelated settings alone', async () => {
    const r = await rig();
    const p = r.project;
    const kick = track(p, 'kick');
    setHit(p.patterns[0]!, kick.id, 4, { vel: 99 });
    p.patterns[0]!.sounds = { [kick.id]: { 4: { v: 0, locks: { 5: 44 }, rules: [{ p: 5, op: 'add', a: 3, b: 0, cond: { k: 'every', n: 2 } }] } } };
    kick.sound.variations = [{ name: 'V', params: { [P]: 3 }, sample: { gain: 0.5 } }, null, null, null];
    kick.sound.mode = 'hybrid';
    kick.sound.synthLevel = 0.3;
    kick.sound.sampleLevel = 0.6;
    kick.sound.offsetMs = 7;
    kick.mix.volume = 0.4;
    p.soundLocks.params = [3, 4];
    const before = JSON.stringify({ kit: p.kit, patterns: p.patterns, locks: p.soundLocks, mix: p.tracks.map((t) => t.mix), play: p.tracks.map((t) => t.play), vars: kick.sound.variations, sl: [kick.sound.synthLevel, kick.sound.sampleLevel, kick.sound.offsetMs, kick.sound.mode, kick.sound.trigger] });
    const kit = await tr606(r);
    await r.km.session.load(kit.id);
    const after = JSON.stringify({ kit: p.kit, patterns: p.patterns, locks: p.soundLocks, mix: p.tracks.map((t) => t.mix), play: p.tracks.map((t) => t.play), vars: kick.sound.variations, sl: [kick.sound.synthLevel, kick.sound.sampleLevel, kick.sound.offsetMs, kick.sound.mode, kick.sound.trigger] });
    expect(after).toBe(before);
    expect(kick.sound.samples).toHaveLength(1);
    expect(r.undo).toContain('LOAD SAMPLE SET');
  });

  it('switching sample sets changes only samples; the synth kit stays', async () => {
    const r = await rig();
    const synth = JSON.stringify(synthKitOf(r.project));
    const a = await tr606(r, 'TR-606');
    const files = await Promise.all(TR606.map(([p, f]) => cand(p.replace('606', '808'), f + 1)));
    const m = proposeMapping(files);
    const b = await r.km.createSet('TR-808', (Object.entries(m.pick) as [Role, number | null][]).filter(([, i]) => i !== null).map(([role, i]) => ({ role, file: files[i!]! })));
    await r.km.session.load(a.id);
    const ka = track(r.project, 'kick').sound.samples[0];
    await r.km.session.load(b.id);
    const kb = track(r.project, 'kick').sound.samples[0];
    expect(kb).not.toBe(ka);
    expect(JSON.stringify(synthKitOf(r.project))).toBe(synth);
    expect(r.km.session.name).toBe('TR-808');
    expect(r.project.sampleSet).toBe('TR-808');
  });

  it('carries playback settings with the set and applies them on load', async () => {
    const r = await rig();
    const kit = await tr606(r);
    await r.km.session.load(kit.id);
    const snare = track(r.project, 'snare');
    Object.assign(snare.sound, { tune: 3, fine: -20, gain: 1.4, pan: 0.25, reverse: true, start: 0.1, end: 0.8, pick: 'random' });
    expect(r.km.session.dirty).toBe(true);
    const saved = await r.km.session.save();
    expect(r.km.session.dirty).toBe(false);
    Object.assign(snare.sound, { tune: 0, gain: 1, reverse: false, start: 0, end: 1, pick: 'first' });
    await r.km.session.load(saved.id);
    expect(snare.sound).toMatchObject({ tune: 3, fine: -20, gain: 1.4, pan: 0.25, reverse: true, start: 0.1, end: 0.8, pick: 'random' });
  });

  it('can clear tracks the set has no sound for, only when asked', async () => {
    const r = await rig();
    const kit = await tr606(r);
    const clap = track(r.project, 'clap');
    const l = await r.library.add((await wav(333)).slice().buffer, 'mine.wav');
    clap.sound.samples = [l.id];
    clap.sound.mode = 'sample';
    await r.km.session.load(kit.id);
    expect(clap.sound.samples).toEqual([l.id]);
    r.km.options.emptyTracks = 'clear';
    await r.km.session.load(kit.id);
    expect(clap.sound.samples).toEqual([]);
    expect(clap.sound.mode).toBe('synth');
  });

  it('reports missing audio, loads what it can, and refuses when nothing is there', async () => {
    const r = await rig();
    const kit = await tr606(r);
    const ids = kit.instruments.map((i) => i.samples[0]!.sample);
    await r.audio.delete(ids[0]!);
    const r2 = await rig(proj(), { audio: r.audio, sets: r.stores.sets, full: r.stores.full });
    const k = (await r2.km.sets.getKit(kit.id))!;
    expect(await r2.km.sets.missing(k)).toEqual([ids[0]]);
    const { plan } = await r2.km.planFor(k);
    expect(plan.tracks.flatMap((t) => t.missing)).toEqual([ids[0]]);
    await r2.km.session.load(kit.id);
    expect(track(r2.project, 'kick').sound.samples).toEqual([]);
    expect(track(r2.project, 'snare').sound.samples).toHaveLength(1);
    for (const id of ids) await r.audio.delete(id).catch(() => undefined);
    const r3 = await rig(proj(), { audio: r.audio, sets: r.stores.sets, full: r.stores.full });
    await expect(r3.km.session.load(kit.id)).rejects.toMatchObject({ code: 'missing-audio' });
    expect(track(r3.project, 'snare').sound.samples).toEqual([]);
  });

  it('does not delete samples the project or another kit still uses', async () => {
    const r = await rig();
    const kit = await tr606(r);
    await r.km.session.load(kit.id);
    const id = track(r.project, 'kick').sound.samples[0]!;
    await expect(r.km.sets.removeSample(id)).rejects.toMatchObject({ code: 'in-use' });
  });

  it('reports a full disk instead of saving half a set', async () => {
    const r = await rig();
    r.audio.quotaBytes = 3000;
    await expect(tr606(r)).rejects.toMatchObject({ code: 'quota' });
    expect(await r.km.sets.listKits()).toEqual([]);
  });
});

describe('portable files', () => {
  async function exportedTr606() {
    const r = await rig();
    const files = await Promise.all(TR606.map(([p, f]) => cand(p, f)));
    const m = proposeMapping(files);
    const kit = await r.km.createSet('TR-606', (Object.entries(m.pick) as [Role, number | null][]).filter(([, i]) => i !== null).map(([role, i]) => ({ role, file: files[i!]! })));
    const out = await r.km.exportKit('set', kit.id);
    return { r, kit, out };
  }

  it('exports a manifest with stable relative asset references, then reimports it in another browser', async () => {
    const { out, kit } = await exportedTr606();
    expect(out.name).toBe('TR-606.kit.zip');
    const read = await readKitArchive(out.data);
    expect(read.kit.name).toBe('TR-606');
    expect(read.samples).toHaveLength(7);
    const paths = (await (await import('@slopfactory/core/export')).readZip(out.data)).map((e) => e.name);
    expect(paths).toContain('manifest.json');
    expect(paths.filter((p) => p.startsWith('samples/'))).toHaveLength(7);
    expect(paths.every((p) => !p.startsWith('/') && !p.includes('..') && !p.includes(':'))).toBe(true);
    // another browser: nothing in storage
    const other = await rig();
    const opened = await other.km.openFile(out.name, out.data);
    expect(opened).toMatchObject({ kind: 'set', name: 'TR-606', added: 7 });
    await other.km.session.load((opened as { id: string }).id);
    expect(track(other.project, 'kick').sound.samples[0]).toBe(kit.instruments.find((i) => i.role === 'kick')!.samples[0]!.sample);
    expect(other.library.get(track(other.project, 'kick').sound.samples[0]!)).toBeDefined();
    // importing the same file again keeps the audio once and renames the set
    const again = await other.km.openFile(out.name, out.data);
    expect(again).toMatchObject({ kind: 'set', name: 'TR-606 2', added: 0 });
    expect((await other.audio.list()).length).toBe(7);
  });

  it('rejects damaged, unknown and newer files with a message and changes nothing', async () => {
    const { out } = await exportedTr606();
    const r = await rig();
    await expect(r.km.openFile('x.zip', new Uint8Array([1, 2, 3]))).rejects.toThrow(/ZIP/);
    const enc = new TextEncoder();
    const bad = createZip([{ name: 'manifest.json', data: enc.encode('{"format":"slopfactory-kit","version":1,"kit":{"name":"X","instruments":"no"},"samples":[]}') }]);
    await expect(r.km.openFile('bad.kit.zip', bad)).rejects.toBeInstanceOf(KitError);
    const newer = createZip([{ name: 'manifest.json', data: enc.encode('{"format":"slopfactory-kit","version":99,"generator":{"app":"x"},"kit":{"name":"X","instruments":[]},"samples":[]}') }]);
    await expect(r.km.openFile('new.kit.zip', newer)).rejects.toMatchObject({ code: 'version' });
    // a kit whose audio is cut short is refused whole
    const entries = await (await import('@slopfactory/core/export')).readZip(out.data);
    const cut = createZip(entries.filter((e) => !e.name.startsWith('samples/01')));
    await expect(r.km.openFile('cut.kit.zip', cut)).rejects.toBeInstanceOf(KitError);
    expect(await r.km.sets.listKits()).toEqual([]);
    expect(await r.audio.list()).toEqual([]);
    expect(() => parseSynthKit('{"format":"nope"}')).toThrow(/synth kit/);
    expect(() => parseSynthKit('{"format":"clatter-synth-kit","version":9}')).toThrow(/newer/);
  });

  it('offers a ZIP of loose samples for mapping instead of importing it blindly', async () => {
    const r = await rig();
    const zip = createZip(await Promise.all(TR606.map(async ([p, f]) => ({ name: 'Drums/' + p, data: await wav(f) }))));
    const opened = await r.km.openFile('Roland TR-606.zip', zip);
    expect(opened.kind).toBe('samples');
    if (opened.kind !== 'samples') return;
    expect(opened.intake.candidates).toHaveLength(7);
    expect(await r.km.sets.listKits()).toEqual([]);
  });
});

describe('synth kits', () => {
  it('save, load and export carry synthesis only; samples and sets are untouched', async () => {
    const r = await rig();
    const p = r.project;
    const l = await r.library.add((await wav(222)).slice().buffer, 'mine.wav');
    track(p, 'snare').sound.samples = [l.id];
    track(p, 'snare').sound.tune = 5;
    track(p, 'kick').sound.variations = [{ name: 'A1', params: { [P]: 2 }, sample: { gain: 0.3 } }, null, null, null];
    const rec = await r.km.saveSynth('Metallic Chaos');
    expect(rec.name).toBe('METALLIC CHAOS');
    expect(rec.data.voices.kick!.variations![0]!.sample).toBeUndefined();
    // change everything about the sound, then load the kit back
    p.kit.synth.params[10] = (p.kit.synth.params[10]! + 50) % 128;
    track(p, 'kick').sound.trigger = 3;
    track(p, 'kick').sound.variations = [{ name: 'Z', params: { [P]: 4 }, sample: { gain: 0.9 } }, null, null, null];
    track(p, 'snare').sound.samples = [];
    await r.km.loadSynth(rec.id);
    expect(p.kit.synth).toEqual(rec.data.synth);
    expect(p.kit.name).toBe('METALLIC CHAOS');
    expect(track(p, 'kick').sound.trigger).toBe(rec.data.voices.kick!.trigger);
    expect(track(p, 'kick').sound.variations![0]!.params).toEqual({ [P]: 2 });
    expect(track(p, 'kick').sound.variations![0]!.sample).toEqual({ gain: 0.9 });
    expect(track(p, 'snare').sound.samples).toEqual([]);
    expect(track(p, 'snare').sound.tune).toBe(5);
    // file round trip
    const file = r.km.synthFile(rec.data);
    expect(file.name).toBe('metallic-chaos.clattersynth.json');
    const back = parseSynthKit(new TextDecoder().decode(file.data), init);
    expect(back.synth).toEqual(rec.data.synth);
    const imported = await r.km.importSynth(new TextDecoder().decode(file.data));
    expect(imported.name).toBe('METALLIC CHAOS 2');
    expect((await r.km.listSynth()).map((x) => x.name)).toEqual(['METALLIC CHAOS', 'METALLIC CHAOS 2']);
  });

  it('survives a restart, and rename, duplicate and delete work', async () => {
    const r = await rig();
    const rec = await r.km.saveSynth('One');
    await expect(r.km.saveSynth('one')).rejects.toMatchObject({ code: 'exists' });
    await r.km.renameSynth(rec.id, 'Two');
    const dup = await r.km.duplicateSynth(rec.id);
    expect(dup.name).toBe('TWO COPY');
    const r2 = await rig(proj(), { audio: r.audio, sets: r.stores.sets, full: r.stores.full });
    expect((await r2.km.listSynth()).map((x) => x.name)).toEqual(['TWO', 'TWO COPY']);
    await r2.km.deleteSynth(rec.id);
    expect((await r2.km.listSynth()).map((x) => x.name)).toEqual(['TWO COPY']);
  });

  it('loading a synth kit does not change the current sample set name', async () => {
    const r = await rig();
    r.project.sampleSet = 'TR-606';
    const rec = await r.km.saveSynth('K');
    await r.km.loadSynth(rec.id);
    expect(r.project.sampleSet).toBe('TR-606');
  });
});

describe('full kits', () => {
  it('restore the synth kit, the sample set, source modes, hybrid balance and mixer together', async () => {
    const r = await rig();
    const p = r.project;
    const a = await r.library.add((await wav(310)).slice().buffer, 'a.wav');
    const b = await r.library.add((await wav(410)).slice().buffer, 'b.wav');
    const k = track(p, 'kick');
    Object.assign(k.sound, { mode: 'hybrid', samples: [a.id], synthLevel: 0.35, sampleLevel: 0.65, offsetMs: -4, tune: 2, gain: 1.2, choke: 2 });
    k.sound.variations = [{ name: 'V1', params: { [P]: 1 }, sample: { samples: [b.id], tune: 4 } }, null, null, null];
    k.mix.volume = 0.5;
    k.mix.route = 'fx';
    p.kit.synth.params[12] = 77;
    const want = clone({ sound: k.sound, mix: k.mix, synth: p.kit.synth, kit: p.kit.name });
    const saved = await r.km.saveFull('Hybrid Kit');
    expect(saved.instruments.some((i) => i.role === 'clatter:variation-samples')).toBe(true);
    // wreck it, then load
    Object.assign(k.sound, { mode: 'synth', samples: [], synthLevel: 0.8, tune: 0, gain: 1, choke: 0 });
    k.sound.variations = undefined;
    k.mix.volume = 0.8;
    k.mix.route = 'main';
    p.kit.synth.params[12] = 1;
    await r.km.loadFull(saved);
    expect({ sound: k.sound, mix: k.mix, synth: p.kit.synth, kit: p.kit.name }).toEqual(want);
    expect(r.undo).toContain('LOAD FULL KIT');
  });

  it('keep rhythm, step sounds and parameter locks untouched', async () => {
    const r = await rig();
    const p = r.project;
    const saved = await r.km.saveFull('F');
    setHit(p.patterns[0]!, track(p, 'snare').id, 6, { vel: 70 });
    p.patterns[0]!.sounds = { [track(p, 'snare').id]: { 6: { locks: { 5: 20 } } } };
    p.soundLocks.params = [9];
    const before = JSON.stringify({ patterns: p.patterns, locks: p.soundLocks });
    await r.km.loadFull(saved);
    expect(JSON.stringify({ patterns: p.patterns, locks: p.soundLocks })).toBe(before);
  });

  it('export as a plain Slop Factory kit that another browser can load whole', async () => {
    const r = await rig();
    const p = r.project;
    const a = await r.library.add((await wav(311)).slice().buffer, 'a.wav');
    track(p, 'snare').sound.samples = [a.id];
    track(p, 'snare').sound.mode = 'hybrid';
    track(p, 'snare').mix.pan = 0.3;
    const saved = await r.km.saveFull('Portable');
    const out = await r.km.exportKit('full', saved.id);
    expect(out.name).toBe('Portable.kit.zip');
    const read = await readKitArchive(out.data);
    expect(read.kit.instruments.find((i) => i.role === 'snare')).toBeDefined();
    const other = await rig(proj());
    const opened = await other.km.openFile(out.name, out.data);
    expect(opened.kind).toBe('full');
    const kit = (await other.km.full.getKit((opened as { id: string }).id))!;
    await other.km.loadFull(kit);
    expect(track(other.project, 'snare').sound.samples).toEqual([a.id]);
    expect(track(other.project, 'snare').sound.mode).toBe('hybrid');
    expect(track(other.project, 'snare').mix.pan).toBe(0.3);
    expect(other.project.kit.synth).toEqual(p.kit.synth);
  });

  it('refuse to be loaded from a plain sample set, saying so', async () => {
    const r = await rig();
    const l = await r.library.add((await wav(250)).slice().buffer, 'x.wav');
    track(r.project, 'kick').sound.samples = [l.id];
    await r.km.session.saveAs('Plain');
    const kit = (await r.km.sets.listKits())[0]!;
    await expect(r.km.loadFull((await r.km.sets.getKit(kit.id))!)).rejects.toThrow(/sample set/);
  });

  it('a newer kit schema keeps its samples but ignores settings it cannot read', async () => {
    const r = await rig();
    const l = await r.library.add((await wav(251)).slice().buffer, 'x.wav');
    const set = captureSet({ ...r.project, tracks: r.project.tracks.map((t) => (t.role === 'kick' ? { ...t, sound: { ...t.sound, samples: [l.id], gain: 1.5 } } : t)) }, () => 'x', null);
    set.instruments[0]!.ext = { clatter: { schema: 99, gain: 0.1, wild: true } };
    const kit = { name: 'Future', instruments: set.instruments, ext: set.ext };
    const mapping = mapKit(kit, targetsOf(r.project));
    const plan = planSet(r.project, mapping, defaultApply(() => true));
    expect(plan.newer).toBe(true);
    expect(plan.tracks[0]!.settings!.gain).toBe(1);
  });
});

describe('compatibility', () => {
  it('opens a kit file from before the split as a full kit and reproduces it', async () => {
    const r = await rig();
    const p = r.project;
    const a = await r.library.add((await wav(777)).slice().buffer, 'a.wav');
    const k = track(p, 'kick');
    Object.assign(k.sound, { mode: 'hybrid', samples: [a.id], synthLevel: 0.4, tune: -3 });
    p.kit.name = 'OLD KIT';
    p.kit.synth.params[20] = 99;
    const old = writeKitFile(kitOf(p), r.library.stored([a.id]));
    const fresh = await rig();
    const opened = await fresh.km.openFile('OLD KIT.clatterkit.zip', old);
    expect(opened).toMatchObject({ kind: 'full', name: 'OLD KIT' });
    const kit = (await fresh.km.full.getKit((opened as { id: string }).id))!;
    await fresh.km.loadFull(kit);
    const fk = track(fresh.project, 'kick');
    expect(fk.sound).toMatchObject({ mode: 'hybrid', samples: [a.id], synthLevel: 0.4, tune: -3 });
    expect(fresh.project.kit.synth.params[20]).toBe(99);
    expect(fresh.project.kit.name).toBe('OLD KIT');
    expect(fresh.library.get(a.id)).toBeDefined();
  });

  it('projects saved before sample sets open unchanged, and the set name round-trips', () => {
    const p = defaultProject();
    const text = serialize(p);
    expect(JSON.parse(text).sampleSet).toBeUndefined();
    const q = parseProject(text, init);
    expect(q.sampleSet).toBeUndefined();
    q.sampleSet = 'TR-606';
    expect(parseProject(serialize(q), init).sampleSet).toBe('TR-606');
    const bad = JSON.parse(text);
    bad.sampleSet = 12345;
    expect(parseProject(JSON.stringify(bad), init).sampleSet).toBeUndefined();
  });

  it('a project keeps its samples whatever happens to the libraries', async () => {
    const r = await rig();
    const kit = await (async () => {
      const files = await Promise.all(TR606.map(([p, f]) => cand(p, f)));
      const m = proposeMapping(files);
      return r.km.createSet('TR-606', (Object.entries(m.pick) as [Role, number | null][]).filter(([, i]) => i !== null).map(([role, i]) => ({ role, file: files[i!]! })));
    })();
    await r.km.session.load(kit.id);
    const text = serialize(r.project);
    await r.km.sets.deleteKit(kit.id);
    const back = parseProject(text, init);
    expect(track(back, 'kick').sound.samples).toEqual(track(r.project, 'kick').sound.samples);
    expect(back.sampleSet).toBe('TR-606');
  });

  it('serialises synth kits deterministically', () => {
    const p = proj();
    const a = serializeSynthKit(synthKitOf(p));
    expect(a).toBe(serializeSynthKit(synthKitOf(p)));
    expect(fullKitOf(p, 'X', { instruments: [], ext: {} }).ext).toHaveProperty('clatter.kind', 'full-kit');
  });

  it('uses IndexedDB kit stores in the browser, and only memory without them', () => {
    expect(typeof IndexedDbKitStore).toBe('function');
  });
});
