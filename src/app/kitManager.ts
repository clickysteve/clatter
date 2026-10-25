/**
 * Kit management: the synth kit, sample set and full kit libraries.
 *
 * Reuses Slop Factory Core's kit system (`@slopfactory/core/kits`) rather than building another:
 *
 *   SAMPLE SETS   Core kits in the "clatter-sample-sets" database, driven by Core's KitSession
 *                 (SAVE, LOAD, RENAME, DUPLICATE, DELETE, IMPORT, EXPORT, UNSAVED tracking).
 *   FULL KITS     Core kits in the "clatter-full-kits" database, whose `ext.clatter` holds the synth
 *                 kit, source modes and mixer (src/model/kits.ts).
 *   SYNTH KITS    small JSON records kept with the sample-set library's application values.
 *   AUDIO         every library shares the one content-addressed sample store ("clatter-samples"),
 *                 so a sample is stored once however many sets, kits and projects use it.
 *
 * The App is reached through a few methods (`edit`, `applyKitChange`, `syncTracks`) so a load is
 * one undo step and the engine hears it at once. Nothing here touches patterns, step sounds,
 * parameter locks or conditions.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import { Auditioner, IndexedDbKitStore, KitError, KitLibrary, KitSession, MemoryKitStore, kitSamples, mapKit, readKitArchive, uniqueKitName, type ArchiveSample, type Kit, type KitData, type KitHost, type KitInstrument, type KitMapping, type KitStore } from '@slopfactory/core/kits';
import { decodeSample } from '@slopfactory/core/sampler';
import { IndexedDbSampleStore, MemorySampleStore, sampleFromBytes, type SampleStore } from '@slopfactory/core/storage';
import { readKitFile } from '../model/kitFile';
import { applyJoin, applyVoices, fullKitExtOf, fullKitOf, legacyToFullKit, parseSynthKit, serializeSynthKit, synthKitOf, SYNTH_KIT_EXT, type SynthKitData } from '../model/kits';
import { projectSamples } from '../model/project';
import { clone, ROLE_LABEL, type Role } from '../model/types';
import { CLATTER_EXT, CORE_ROLE, NEUTRAL, SET_SCHEMA, applyPlan, captureSet, defaultApply, planSet, setSignature, targetsOf, type ApplyOptions, type SetPlan } from '../samples/sets';
import { baseName, stem } from '../samples/names';
import { readArchive, intakeFromEntries, type Candidate, type Intake } from '../samples/intake';
import type { App } from './app';

export type KitKind = 'synth' | 'set' | 'full';
export const KIND_LABEL: Record<KitKind, string> = { synth: 'SYNTH KIT', set: 'SAMPLE SET', full: 'FULL KIT' };

/** A synth kit in the library. */
export interface SynthKitRecord {
  id: string;
  name: string;
  created: number;
  modified: number;
  data: SynthKitData;
}
const SYNTH_META = 'clatter:synth-kits';
export const MAX_SYNTH_KITS = 200;

export const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** What file a user chose to open, once looked at. */
export type OpenedKit =
  | { kind: 'set' | 'full'; id: string; name: string; added: number }
  | { kind: 'synth'; id: string; name: string }
  | { kind: 'samples'; intake: Intake }
  | { kind: 'bundle' };

export class KitManager {
  readonly sets: KitLibrary;
  readonly full: KitLibrary;
  readonly session: KitSession;
  readonly audition: Auditioner;
  /** kits outlive the page (false: this visit only) */
  readonly persistent: boolean;
  /** how a sample set is applied; the load dialog changes these */
  options: Pick<ApplyOptions, 'synthToSample' | 'emptyTracks'> = { synthToSample: true, emptyTracks: 'keep' };
  /** what the last load did, for the status line and tests */
  lastPlan: SetPlan | null = null;
  fullName = '';
  private fns = new Set<() => void>();

  private constructor(
    private app: App,
    sets: KitStore,
    full: KitStore,
    readonly audio: SampleStore,
    persistent: boolean,
  ) {
    this.persistent = persistent;
    const inUse = (other: () => KitLibrary) => async () => [...projectSamples(this.app.project), ...(await this.kitSamplesOf(other()))];
    this.sets = new KitLibrary({ app: 'clatter', audio, store: sets, inUse: inUse(() => this.full) });
    this.full = new KitLibrary({ app: 'clatter', audio, store: full, inUse: inUse(() => this.sets) });
    this.session = new KitSession(this.sets, this.host(), { untitled: 'Untitled Set' });
    this.session.onChange(() => {
      this.syncProjectName();
      this.emit();
    });
    this.audition = new Auditioner({
      context: async () => {
        try {
          await this.app.host.start();
        } catch {
          return null;
        }
        return this.app.host.ctx;
      },
    });
  }

  /** Open the libraries (falling back to memory where IndexedDB is missing or blocked). */
  static async create(app: App, audio: SampleStore, stores?: { sets: KitStore; full: KitStore }): Promise<KitManager> {
    let sets: KitStore;
    let full: KitStore;
    let persistent = typeof indexedDB !== 'undefined';
    try {
      if (stores) {
        sets = stores.sets;
        full = stores.full;
        persistent = true;
        await sets.listKits();
        await full.listKits();
      } else {
        if (!persistent) throw new Error('no IndexedDB');
        sets = new IndexedDbKitStore('clatter-sample-sets');
        full = new IndexedDbKitStore('clatter-full-kits');
        await sets.listKits();
        await full.listKits();
      }
    } catch {
      persistent = false;
      sets = new MemoryKitStore();
      full = new MemoryKitStore();
    }
    const km = new KitManager(app, sets, full, audio, persistent);
    await km.session.resume().catch(() => undefined);
    km.fullName = (await km.full.getCurrent().then((id) => (id ? km.full.getKit(id) : null)).catch(() => null))?.name ?? '';
    return km;
  }

  /** The shared sample store: IndexedDB where available. */
  static audioStore(): SampleStore {
    try {
      if (typeof indexedDB !== 'undefined') return new IndexedDbSampleStore('clatter-samples');
    } catch {
      /* blocked */
    }
    return new MemorySampleStore();
  }

  onChange(fn: () => void): () => void {
    this.fns.add(fn);
    return () => this.fns.delete(fn);
  }
  emit(): void {
    for (const f of this.fns) f();
    this.app.emit(['kits']);
  }

  private async kitSamplesOf(lib: KitLibrary): Promise<string[]> {
    const out: string[] = [];
    for (const s of await lib.listKits()) {
      const k = await lib.getKit(s.id);
      if (k) out.push(...kitSamples(k));
    }
    return out;
  }

  // ------------------------------------------------------------------ sample sets
  private nameOf = (id: string): string | undefined => this.app.library.get(id)?.name;

  /** Bring a kit's samples into the app's sample library (decoded for the engine). Returns those it could not. */
  async prepare(ids: string[]): Promise<string[]> {
    const lib = this.app.library;
    const bad: string[] = [];
    for (const id of new Set(ids)) {
      if (lib.get(id)) continue;
      try {
        const missing = await lib.restore([id]);
        if (missing.length || !lib.get(id)) bad.push(id);
      } catch {
        bad.push(id);
      }
    }
    return bad;
  }

  private applyOptions(extra: Partial<ApplyOptions> = {}): ApplyOptions {
    return { ...defaultApply((id) => !!this.app.library.get(id)), ...this.options, ...extra };
  }

  /** What loading a kit's samples would do to the tracks right now. */
  async planFor(kit: KitData, extra: Partial<ApplyOptions> = {}): Promise<{ plan: SetPlan; mapping: KitMapping }> {
    await this.prepare(kit.instruments.flatMap((i) => i.samples.map((s) => s.sample)));
    const mapping = mapKit(kit, targetsOf(this.app.project));
    return { plan: planSet(this.app.project, mapping, this.applyOptions(extra)), mapping };
  }

  private host(): KitHost {
    return {
      targets: () => targetsOf(this.app.project),
      capture: async (base) => {
        const set = captureSet(this.app.project, this.nameOf, base);
        return { instruments: set.instruments, ext: set.ext, audio: this.app.library.stored(this.app.project.tracks.flatMap((t) => t.sound.samples)) as ArchiveSample[] };
      },
      apply: async (kit, mapping) => {
        const ids = kit.instruments.flatMap((i) => i.samples.map((s) => s.sample));
        const bad = await this.prepare(ids);
        const plan = planSet(this.app.project, mapping, this.applyOptions());
        if (ids.length && bad.length === new Set(ids).size) throw new KitError('missing-audio', 'None of this set’s audio is in this browser. Import the set’s file again.');
        this.lastPlan = plan;
        this.app.edit('LOAD SAMPLE SET', () => applyPlan(this.app.project, plan), ['tracks']);
        this.app.syncTracks();
      },
      clear: () => {
        this.app.edit(
          'NEW SAMPLE SET',
          () => {
            for (const t of this.app.project.tracks) {
              t.sound.samples = [];
              if (t.sound.mode === 'sample') t.sound.mode = 'synth';
            }
          },
          ['tracks'],
        );
        this.app.syncTracks();
      },
      signature: () => setSignature(this.app.project),
    };
  }

  /** Mirror the current set's name into the project, so a saved project says which set it uses. */
  private syncProjectName(): void {
    const name = this.session.currentId ? this.session.name : '';
    if ((this.app.project.sampleSet ?? '') !== name) this.app.setSampleSetName(name);
  }

  /** The project was replaced (new, opened, preset): follow the set it names. */
  projectReplaced(): void {
    const want = this.app.project.sampleSet ?? '';
    const hit = this.session.kits.find((k) => k.name === want);
    this.session.currentId = hit?.id ?? null;
    this.session.name = hit ? hit.name : want || 'Untitled Set';
    if (hit) this.sets.getKit(hit.id).then((k) => k && (this.session.base = k)).catch(() => undefined);
    this.session.markSaved();
  }

  /** The name to show for the current sample set. */
  get setName(): string {
    return (this.session.currentId ? this.session.name : this.app.project.sampleSet) || 'NONE';
  }

  /**
   * Import chosen files as a new sample set: each pick's audio is decoded (to validate it) and
   * stored once (by content), then the set is saved. `picks` are roles with their file.
   */
  async createSet(name: string, picks: { role: Role; file: Candidate }[], o: { replace?: boolean; load?: boolean } = {}, progress?: (done: number, total: number) => void): Promise<Kit> {
    const instruments: KitInstrument[] = [];
    let done = 0;
    for (const { role, file } of picks) {
      progress?.(done++, picks.length);
      const bytes = await file.bytes();
      const r = await this.sets.addSample(bytes, baseName(file.path), file.type);
      instruments.push({
        role: CORE_ROLE[role],
        index: 0,
        label: ROLE_LABEL[role],
        samples: [{ sample: r.sample.id, name: stem(file.path), primary: true }],
        selection: 'fixed',
        ext: { [CLATTER_EXT]: { schema: SET_SCHEMA, ...NEUTRAL } },
      });
      await new Promise((res) => setTimeout(res));
    }
    progress?.(picks.length, picks.length);
    const kit = await this.sets.saveKit({ name, instruments, ext: { [CLATTER_EXT]: { schema: SET_SCHEMA, kind: 'sample-set' } } }, { replace: o.replace });
    await this.session.refresh();
    if (o.load) await this.session.load(kit.id);
    return kit;
  }

  // ------------------------------------------------------------------ full kits
  /** Everything that makes the current sound, as a full kit (saved in the library). */
  async saveFull(name: string, replace = false): Promise<Kit> {
    const p = this.app.project;
    const set = captureSet(p, this.nameOf, null);
    const data = fullKitOf(p, name, set);
    const ids = kitSamples(data);
    const kit = await this.full.saveKit(data, { audio: this.app.library.stored(ids) as ArchiveSample[], replace });
    await this.full.setCurrent(kit.id);
    this.fullName = kit.name;
    this.emit();
    return kit;
  }

  async listFull(): Promise<Kit[]> {
    const out: Kit[] = [];
    for (const s of await this.full.listKits()) {
      const k = await this.full.getKit(s.id);
      if (k) out.push(k);
    }
    return out;
  }

  /** What a full kit would change (the sample half as a plan; the rest is described by the dialog). */
  async planFull(kit: KitData) {
    const { plan, mapping } = await this.planFor(kit, { synthToSample: false, emptyTracks: 'clear' });
    const { full, newer } = fullKitExtOf(kit, this.app.initKit ?? undefined);
    return { plan, mapping, full, newer };
  }

  /** Load a full kit: synth kit, sample set and the joining settings, as one undo step. */
  async loadFull(kit: Kit | KitData): Promise<SetPlan> {
    const { plan, full } = await this.planFull(kit);
    if (!full) throw new KitError('invalid', 'This is a sample set, not a full kit. Load it as a sample set.');
    const bad = await this.prepare(kitSamples(kit));
    if (bad.length && bad.length === new Set(kitSamples(kit)).size && kitSamples(kit).length) throw new KitError('missing-audio', 'None of this kit’s audio is in this browser. Import the kit’s file again.');
    this.lastPlan = plan;
    const p = this.app.project;
    this.app.edit(
      'LOAD FULL KIT',
      () => {
        this.app.applyKitChange(clone(full.synth.synth));
        p.kit.name = full.synth.name;
        p.kit.seed = full.synth.seed;
        applyVoices(p, full.synth.voices);
        applyPlan(p, plan);
        applyJoin(p, full, (id) => !!this.app.library.get(id));
        p.sampleSet = '';
      },
      ['kit', 'tracks', 'mix'],
    );
    this.app.syncTracks();
    if ('id' in kit) {
      await this.full.setCurrent(kit.id);
      this.fullName = kit.name;
    }
    this.session.currentId = null;
    this.session.name = 'Untitled Set';
    this.emit();
    return plan;
  }

  // ------------------------------------------------------------------ synth kits
  async listSynth(): Promise<SynthKitRecord[]> {
    const v = await this.sets.getMeta<SynthKitRecord[]>(SYNTH_META).catch(() => undefined);
    return Array.isArray(v) ? v.filter((r) => r && typeof r.id === 'string' && typeof r.name === 'string' && r.data) : [];
  }
  private async putSynth(list: SynthKitRecord[]): Promise<void> {
    await this.sets.setMeta(SYNTH_META, list);
    this.emit();
  }
  /** Save the current synthesis kit. KitError('exists') if the name is taken (unless `replace`). */
  async saveSynth(name: string, replace = false): Promise<SynthKitRecord> {
    const clean = name.trim().slice(0, 24).toUpperCase();
    if (!clean) throw new KitError('name', 'A kit needs a name.');
    const list = await this.listSynth();
    const clash = list.find((r) => r.name.toLowerCase() === clean.toLowerCase());
    if (clash && !replace) throw new KitError('exists', `A synth kit named "${clash.name}" already exists.`);
    if (!clash && list.length >= MAX_SYNTH_KITS) throw new KitError('too-large', 'The synth kit library is full. Delete some kits first.');
    const now = Date.now();
    const data = synthKitOf(this.app.project);
    data.name = clean;
    const rec: SynthKitRecord = { id: clash?.id ?? `${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`, name: clean, created: clash?.created ?? now, modified: now, data };
    await this.putSynth([...list.filter((r) => r !== clash), rec]);
    if (this.app.project.kit.name !== clean) this.app.edit('RENAME KIT', () => (this.app.project.kit.name = clean), ['kit']);
    return rec;
  }
  async loadSynth(id: string): Promise<SynthKitRecord> {
    const rec = (await this.listSynth()).find((r) => r.id === id);
    if (!rec) throw new KitError('not-found', 'That synth kit no longer exists.');
    this.applySynthData(rec.data);
    return rec;
  }
  /** Apply a synth kit: LXR parameters and modulation, voice assignments, variation parameters. Samples are untouched. */
  applySynthData(data: SynthKitData): void {
    const p = this.app.project;
    this.app.edit(
      'LOAD SYNTH KIT',
      () => {
        this.app.applyKitChange(clone(data.synth));
        p.kit.name = data.name;
        p.kit.seed = data.seed;
        applyVoices(p, data.voices);
      },
      ['kit', 'tracks'],
    );
    this.app.syncTracks();
    this.emit();
  }
  async renameSynth(id: string, name: string): Promise<void> {
    const clean = name.trim().slice(0, 24).toUpperCase();
    const list = await this.listSynth();
    if (!clean) throw new KitError('name', 'A kit needs a name.');
    if (list.some((r) => r.id !== id && r.name.toLowerCase() === clean.toLowerCase())) throw new KitError('exists', `A synth kit named "${clean}" already exists.`);
    await this.putSynth(list.map((r) => (r.id === id ? { ...r, name: clean, modified: Date.now(), data: { ...r.data, name: clean } } : r)));
  }
  async duplicateSynth(id: string): Promise<SynthKitRecord> {
    const list = await this.listSynth();
    const src = list.find((r) => r.id === id);
    if (!src) throw new KitError('not-found', 'That synth kit no longer exists.');
    const name = uniqueKitName(`${src.name} COPY`.slice(0, 24), list.map((r) => r.name)).toUpperCase().slice(0, 24);
    const now = Date.now();
    const rec = { ...clone(src), id: `${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`, name, created: now, modified: now };
    rec.data.name = name;
    await this.putSynth([...list, rec]);
    return rec;
  }
  async deleteSynth(id: string): Promise<void> {
    await this.putSynth((await this.listSynth()).filter((r) => r.id !== id));
  }
  async exportSynth(id: string): Promise<{ name: string; data: Uint8Array; type: string }> {
    const rec = (await this.listSynth()).find((r) => r.id === id);
    if (!rec) throw new KitError('not-found', 'That synth kit no longer exists.');
    return this.synthFile(rec.data);
  }
  synthFile(data: SynthKitData): { name: string; data: Uint8Array; type: string } {
    const slug = data.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'synth-kit';
    return { name: slug + SYNTH_KIT_EXT, data: new TextEncoder().encode(serializeSynthKit(data)), type: 'application/json' };
  }
  /** Import a synth kit file into the library (a taken name gets a number). */
  async importSynth(text: string): Promise<SynthKitRecord> {
    const data = parseSynthKit(text, this.app.initKit ?? undefined);
    const list = await this.listSynth();
    data.name = uniqueKitName(data.name, list.map((r) => r.name)).toUpperCase().slice(0, 24);
    const now = Date.now();
    const rec: SynthKitRecord = { id: `${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`, name: data.name, created: now, modified: now, data };
    await this.putSynth([...list, rec]);
    return rec;
  }

  // ------------------------------------------------------------------ files
  /**
   * Look at a file the user chose and put it where it belongs: a synth kit file, a sample set
   * or full kit (`.kit.zip`, from CLATTER or any Slop Factory application), a kit from before the
   * split (`.clatterkit.zip`, which becomes a full kit), or a ZIP of loose samples (offered for
   * mapping). Sample sets and kits are saved to their library; nothing changes in the project.
   */
  async openFile(name: string, bytes: Uint8Array): Promise<OpenedKit> {
    if (/\.json$/i.test(name)) {
      const rec = await this.importSynth(new TextDecoder().decode(bytes));
      return { kind: 'synth', id: rec.id, name: rec.name };
    }
    const entries = await readArchive(bytes);
    const manifest = entries.find((e) => e.name === 'manifest.json');
    if (manifest) {
      let format = '';
      try {
        format = String((JSON.parse(new TextDecoder().decode(manifest.data)) as { format?: unknown }).format);
      } catch {
        /* not a manifest */
      }
      if (format === 'slopfactory-bundle') return { kind: 'bundle' };
      if (format === 'slopfactory-kit') return this.importKitArchive(bytes);
    }
    if (entries.some((e) => e.name === 'kit.json')) return this.importLegacyKit(bytes);
    return { kind: 'samples', intake: intakeFromEntries(entries, name) };
  }

  private async importKitArchive(bytes: Uint8Array): Promise<OpenedKit> {
    const read = await readKitArchive(bytes);
    const isFull = fullKitExtOf(read.kit).full !== null;
    const lib = isFull ? this.full : this.sets;
    const r = await lib.importKit(bytes, { save: true });
    if (isFull) await this.full.setCurrent(r.kit.id);
    await this.session.refresh();
    this.emit();
    return { kind: isFull ? 'full' : 'set', id: r.kit.id, name: r.kit.name, added: r.added };
  }

  /** A `.clatterkit.zip` (before synth kits and sample sets were separate) as a full kit. */
  private async importLegacyKit(bytes: Uint8Array): Promise<OpenedKit> {
    const old = await readKitFile(bytes);
    const audio: ArchiveSample[] = [];
    const remap = new Map<string, string>();
    for (const s of old.samples) {
      const stored = await sampleFromBytes(s.bytes, s.name);
      audio.push(stored);
      remap.set(s.id, stored.id);
    }
    const fix = (id: string) => remap.get(id) ?? id;
    for (const snd of Object.values(old.kit.sounds)) {
      snd.samples = (snd.samples ?? []).map(fix).filter((id) => audio.some((a) => a.id === id));
      for (const v of snd.variations ?? []) if (v?.sample?.samples) v.sample.samples = v.sample.samples.map(fix).filter((id) => audio.some((a) => a.id === id));
    }
    const names = new Map(audio.map((a) => [a.id, a.name.replace(/\.[a-z0-9]+$/i, '').toUpperCase().slice(0, 24)]));
    const data = legacyToFullKit(old.kit, (id) => names.get(id));
    const taken = (await this.full.listKits()).map((k) => k.name);
    data.name = uniqueKitName(data.name, taken);
    // a v1 kit's decoded audio is validated by Core when saved; samples that do not decode fail the whole import
    for (const a of audio) await decodeSample(a.bytes.slice(0), a.name);
    const kit = await this.full.saveKit(data, { audio });
    await this.full.setCurrent(kit.id);
    this.emit();
    return { kind: 'full', id: kit.id, name: kit.name, added: audio.length };
  }

  /** A sample set or full kit as a portable `.kit.zip`. */
  async exportKit(kind: 'set' | 'full', id: string): Promise<{ name: string; data: Uint8Array; type: string }> {
    const lib = kind === 'set' ? this.sets : this.full;
    const kit = await lib.getKit(id);
    if (!kit) throw new KitError('not-found', 'That kit no longer exists.');
    const out = await lib.exportKit(kit);
    return { name: out.fileName, data: out.bytes, type: 'application/zip' };
  }

  /** The current sound as a portable file without saving it first. */
  async exportCurrent(kind: 'set' | 'full', name: string): Promise<{ name: string; data: Uint8Array; type: string }> {
    const p = this.app.project;
    const set = captureSet(p, this.nameOf, this.session.base);
    const data: KitData = kind === 'full' ? fullKitOf(p, name, set) : { name, instruments: set.instruments, ext: set.ext };
    const ids = kitSamples(data);
    const out = await (kind === 'full' ? this.full : this.sets).exportKit(data, this.app.library.stored(ids) as ArchiveSample[]);
    return { name: out.fileName, data: out.bytes, type: 'application/zip' };
  }
}
