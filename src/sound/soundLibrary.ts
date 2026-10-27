/**
 * The sound library: single sounds saved from SOUND DISCOVERY, kept in the browser and
 * portable as `.clattersound.json`.
 *
 * A saved sound is one LXR voice (every synthesis parameter of the voice and its LFO and velocity
 * targets, by parameter name), optionally with the modulation and variations of the track it came
 * from, and the seed metadata that made it. It carries no samples and nothing of the kit's other
 * voices, the FX bus, the mixer or the rhythm. Loading one only ever puts it in a candidate slot;
 * the instrument changes when it is applied.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import { repairMod, repairPatch } from '../mod/config';
import { clamp, clone, type SampleOverrides } from '../model/types';
import type { Archetype, Key } from './kitgen';
import { voiceKeys } from './kitgen';
import { candidateKey, characterLabel, type Candidate, type CandidateOrigin, type SoundExtras, type Values, type VariationSketch } from './discover';
import { CHARACTERS } from './discover';
import { checkedSeedText } from '../rhythm/seed';

export const SOUND_FORMAT = 'clatter-sound';
export const SOUND_VERSION = 1;
export const SOUND_EXT = '.clattersound.json';
export const LIBRARY_MAX = 500;
export const NAME_MAX = 24;
const STORAGE_KEY = 'clatter.sounds';

export interface LibrarySound {
  id: string;
  name: string;
  voice: number;
  values: Values;
  lfo: Key | null;
  vel: Key | null;
  extras?: SoundExtras;
  /** the seed metadata of the candidate it was saved from */
  origin?: CandidateOrigin;
  /** its pitch when it was saved (a note only when the analysis trusted one) */
  pitch?: { note: string; hz: number } | { kind: string };
  /** milliseconds since 1970 */
  at: number;
}

/** Where the library lives: the browser's storage, or a stand-in. */
export interface SoundStore {
  read(): string | null;
  write(text: string): void;
}
export const browserStore = (): SoundStore => ({
  read: () => {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  },
  write: (t) => {
    try {
      localStorage.setItem(STORAGE_KEY, t);
    } catch {
      /* storage full or blocked: the library keeps working in memory */
    }
  },
});
export const memoryStore = (): SoundStore => {
  let s: string | null = null;
  return { read: () => s, write: (t) => (s = t) };
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const name = (v: unknown, d: string): string => (typeof v === 'string' && v.trim() ? v.trim().toUpperCase().slice(0, NAME_MAX) : d);
const KEYS = new Set<string>(Object.keys(voiceKeys(0)).concat(Object.keys(voiceKeys(3)), Object.keys(voiceKeys(5))));

function repairValues(v: unknown, voice: number): Values {
  const out: Values = {};
  if (!isObj(v)) return out;
  const own = voiceKeys(voice);
  for (const [k, x] of Object.entries(v)) if (KEYS.has(k) && own[k as Key] !== undefined && typeof x === 'number' && Number.isFinite(x)) out[k as Key] = clamp(Math.round(x), 0, 127);
  return out;
}
const repairKey = (v: unknown, voice: number): Key | null => (typeof v === 'string' && voiceKeys(voice)[v as Key] !== undefined ? (v as Key) : null);

function repairSample(v: unknown): SampleOverrides | undefined {
  return isObj(v) ? (clone(v) as SampleOverrides) : undefined;
}

function repairExtras(v: unknown, voice: number): SoundExtras | undefined {
  if (!isObj(v)) return undefined;
  const out: SoundExtras = {};
  const mod = repairMod(v.mod);
  if (mod && (Object.keys(mod.sources).length || mod.routes.length)) out.mod = mod;
  if (Array.isArray(v.variations)) {
    const list = v.variations.slice(0, 4).map((x): VariationSketch | null => {
      if (!isObj(x)) return null;
      const s: VariationSketch = { name: name(x.name, 'VAR'), values: repairValues(x.values, voice) };
      const sm = repairSample(x.sample);
      if (sm) s.sample = sm;
      const pt = repairPatch(x.mod);
      if (pt) s.mod = pt;
      return s;
    });
    if (list.some(Boolean)) out.variations = list;
  }
  return out.mod || out.variations ? out : undefined;
}

export function repairOrigin(v: unknown, voice: number): LibrarySound['origin'] {
  if (!isObj(v)) return undefined;
  const seed = v.seed;
  if (typeof seed !== 'number' || !Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) return undefined;
  const character = CHARACTERS.find((c) => c.id === v.character)?.id;
  if (!character) return undefined;
  const text = checkedSeedText(seed, v.seedText);
  const lineage = Array.isArray(v.lineage)
    ? v.lineage.slice(0, 64).filter((m): m is { seed: number; wildness: number } => isObj(m) && Number.isInteger(m.seed) && typeof m.wildness === 'number').map((m) => ({ seed: (m.seed as number) >>> 0, wildness: clamp(Math.round(m.wildness), 5, 100) }))
    : [];
  const num = (x: unknown, d: number, lo: number, hi: number) => (typeof x === 'number' && Number.isFinite(x) ? clamp(Math.round(x), lo, hi) : d);
  const archetype = (['kick', 'tom', 'perc', 'zap', 'snare', 'clap', 'hat', 'cymbal'] as Archetype[]).find((a) => a === v.archetype) ?? 'perc';
  return {
    kind: v.kind === 'library' ? 'library' : 'generated',
    seed,
    ...(text ? { seedText: text } : {}),
    index: num(v.index, 0, 0, 7),
    draw: num(v.draw, 0, 0, 1e6),
    character,
    wildness: num(v.wildness, 60, 5, 100),
    voice,
    archetype,
    lineage,
    from: typeof v.from === 'string' ? v.from.slice(0, 16) : '',
    generator: num(v.generator, 0, 0, 1e9),
    ...(typeof v.library === 'string' && v.library ? { library: v.library.slice(0, NAME_MAX) } : {}),
  };
}

/** A valid library sound from parsed JSON, or null. */
export function repairSound(v: unknown, id: string): LibrarySound | null {
  if (!isObj(v)) return null;
  const voice = typeof v.voice === 'number' && Number.isInteger(v.voice) && v.voice >= 0 && v.voice <= 5 ? v.voice : -1;
  if (voice < 0) return null;
  const values = repairValues(v.values, voice);
  if (!Object.keys(values).length) return null;
  const out: LibrarySound = { id, name: name(v.name, 'SOUND'), voice, values, lfo: repairKey(v.lfo, voice), vel: repairKey(v.vel, voice), at: typeof v.at === 'number' && Number.isFinite(v.at) ? v.at : 0 };
  const extras = repairExtras(v.extras, voice);
  if (extras) out.extras = extras;
  const origin = repairOrigin(v.origin, voice);
  if (origin) out.origin = origin;
  if (isObj(v.pitch)) {
    if (typeof v.pitch.note === 'string' && typeof v.pitch.hz === 'number' && Number.isFinite(v.pitch.hz)) out.pitch = { note: v.pitch.note.slice(0, 4), hz: v.pitch.hz };
    else if (typeof v.pitch.kind === 'string') out.pitch = { kind: v.pitch.kind.slice(0, 12) };
  }
  return out;
}

/** The sound as a candidate (it lands in a slot; nothing is applied). */
export function candidateOf(s: LibrarySound): Candidate {
  const c = { voice: s.voice, values: clone(s.values), lfo: s.lfo, vel: s.vel, ...(s.extras ? { extras: clone(s.extras) } : {}) };
  const base: CandidateOrigin = s.origin
    ? { ...s.origin, lineage: s.origin.lineage.map((m) => ({ ...m })), library: s.name }
    : { kind: 'library', seed: 0, index: 0, draw: 0, character: 'machine', wildness: 0, voice: s.voice, archetype: 'perc', lineage: [], from: '', generator: 0, library: s.name };
  // a library sound is its own source: it is not remade from a seed, only from the file
  return { key: candidateKey(c), name: s.name, ...c, origin: { ...base, kind: 'library', library: s.name } };
}

/** Describe where a library sound came from, in a few words. */
export function describeSound(s: LibrarySound): string {
  const o = s.origin;
  const bits: string[] = [];
  if (o) bits.push(`${characterLabel(o.character)} ${o.wildness}%`, `SEED ${(o.seedText ?? String(o.seed)).toUpperCase()}`);
  if (s.extras?.mod) bits.push('MOD');
  if (s.extras?.variations) bits.push('VARS');
  return bits.join(' · ');
}

export interface SoundFile {
  format: typeof SOUND_FORMAT;
  version: number;
  sounds: Omit<LibrarySound, 'id'>[];
}

export class SoundLibrary {
  private items: LibrarySound[] = [];
  private nextId = 1;

  constructor(private readonly store: SoundStore = browserStore()) {
    this.load();
  }

  private load(): void {
    const raw = this.store.read();
    if (!raw) return;
    try {
      const v = JSON.parse(raw) as unknown;
      const list = isObj(v) && Array.isArray(v.sounds) ? v.sounds : [];
      for (const x of list.slice(0, LIBRARY_MAX)) {
        const s = repairSound(x, this.newId());
        if (s) this.items.push(s);
      }
    } catch {
      /* a damaged library starts empty */
    }
  }

  private newId(): string {
    return `s${this.nextId++}`;
  }

  private save(): void {
    this.store.write(JSON.stringify({ format: SOUND_FORMAT, version: SOUND_VERSION, sounds: this.items.map(({ id: _id, ...s }) => (void _id, s)) }));
  }

  list(): readonly LibrarySound[] {
    return this.items;
  }

  get(id: string): LibrarySound | undefined {
    return this.items.find((s) => s.id === id);
  }

  /** Save a candidate; returns the new library sound. */
  add(c: Candidate, nm: string, pitch?: LibrarySound['pitch'], at = Date.now()): LibrarySound {
    if (this.items.length >= LIBRARY_MAX) throw new Error(`The library is full (${LIBRARY_MAX} sounds).`);
    const s: LibrarySound = { id: this.newId(), name: name(nm, c.name), voice: c.voice, values: clone(c.values), lfo: c.lfo, vel: c.vel, at };
    if (c.extras) s.extras = clone(c.extras);
    s.origin = clone(c.origin);
    if (pitch) s.pitch = pitch;
    this.items.push(s);
    this.save();
    return s;
  }

  rename(id: string, nm: string): boolean {
    const s = this.get(id);
    if (!s) return false;
    s.name = name(nm, s.name);
    this.save();
    return true;
  }

  remove(id: string): boolean {
    const i = this.items.findIndex((s) => s.id === id);
    if (i < 0) return false;
    this.items.splice(i, 1);
    this.save();
    return true;
  }

  /** One sound, or the whole library, as the text of a `.clattersound.json` file. */
  export(ids?: string[]): string {
    const sounds = this.items.filter((s) => !ids || ids.includes(s.id)).map(({ id: _id, ...s }) => (void _id, s));
    const doc: SoundFile = { format: SOUND_FORMAT, version: SOUND_VERSION, sounds };
    return JSON.stringify(doc, null, 1);
  }

  /** Add the sounds of a file; unusable ones are counted, not guessed at. */
  import(text: string): { added: LibrarySound[]; skipped: number } {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Error('This file is not valid JSON.');
    }
    if (!isObj(v) || v.format !== SOUND_FORMAT) throw new Error('This is not a CLATTER sound file.');
    if (typeof v.version === 'number' && v.version > SOUND_VERSION) throw new Error('This sound was saved by a newer version of CLATTER.');
    const list = Array.isArray(v.sounds) ? v.sounds : [];
    const added: LibrarySound[] = [];
    let skipped = 0;
    for (const x of list) {
      const s = this.items.length + added.length >= LIBRARY_MAX ? null : repairSound(x, this.newId());
      if (s) added.push(s);
      else skipped++;
    }
    this.items.push(...added);
    if (added.length) this.save();
    return { added, skipped };
  }
}
