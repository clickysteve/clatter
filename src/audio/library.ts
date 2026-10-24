/**
 * The sample library: every sample CLATTER knows, decoded once, identified by the SHA-256 of
 * its file (Slop Factory Core's content-addressed storage), so the same file imported twice is
 * one sample and a sample can sit on any number of tracks and kits without being copied.
 *
 * Decoding (WAV/AIFF by Core's parsers at their native rate, other formats by the browser) and
 * storage (IndexedDB, original bytes) are Slop Factory Core's. A sample can be assigned to any
 * track whatever its name suggests: `role` is only a hint for the default choices.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import { decodeSample, waveformPeaks } from '@slopfactory/core/sampler';
import { sampleFromBytes, type SampleStore, type StoredSample } from '@slopfactory/core/storage';

export interface LibrarySample {
  id: string;
  name: string;
  /** what it is probably for (kick, snare, clap, chat, perc, fx...); only a hint */
  role: string;
  bundled: boolean;
  rate: number;
  channels: Float32Array[];
  duration: number;
  /** waveform overview (128 bins, 0-1) */
  peaks: number[];
  /** original file bytes (for bundles and kit export) */
  bytes: ArrayBuffer;
  type: string;
}

/** A role guessed from a file name. */
export function guessRole(name: string): string {
  const n = name.toLowerCase();
  const rules: [RegExp, string][] = [
    [/kick|bd|bass ?drum|kik/, 'kick'],
    [/snare|sd|snr/, 'snare'],
    [/clap|clp|cp/, 'clap'],
    [/open|oh|ohat/, 'ohat'],
    [/hat|hh|ch\b|chh/, 'chat'],
    [/tom|conga|bongo/, 'ltom'],
    [/crash|ride|cym/, 'cymbal'],
    [/rim|shak|cow|tamb|perc|clav|wood/, 'perc'],
  ];
  for (const [re, role] of rules) if (re.test(n)) return role;
  return 'fx';
}

export class SampleLibrary {
  readonly items = new Map<string, LibrarySample>();
  private fns = new Set<() => void>();

  constructor(private store: SampleStore | null) {}

  onChange(fn: () => void): () => void {
    this.fns.add(fn);
    return () => this.fns.delete(fn);
  }

  private changed(): void {
    for (const f of this.fns) f();
  }

  get(id: string): LibrarySample | undefined {
    return this.items.get(id);
  }

  list(): LibrarySample[] {
    return [...this.items.values()].sort((a, b) => Number(b.bundled) - Number(a.bundled) || a.name.localeCompare(b.name));
  }

  /** Add file bytes (decode, store, index). Returns the sample (existing if already known). */
  async add(bytes: ArrayBuffer, name: string, opts: { role?: string; bundled?: boolean; type?: string; persist?: boolean } = {}): Promise<LibrarySample> {
    const stored = await sampleFromBytes(bytes, name, opts.type ?? '');
    const known = this.items.get(stored.id);
    if (known) return known;
    const dec = await decodeSample(bytes.slice(0), name);
    if (opts.persist !== false && this.store && !opts.bundled) {
      try {
        await this.store.put(stored);
      } catch {
        /* storage full or unavailable: the sample still works in this session */
      }
    }
    const item: LibrarySample = {
      id: stored.id,
      name: name.replace(/\.[a-z0-9]+$/i, '').toUpperCase().slice(0, 24),
      role: opts.role ?? guessRole(name),
      bundled: !!opts.bundled,
      rate: dec.sampleRate,
      channels: dec.channels,
      duration: dec.duration,
      peaks: waveformPeaks(dec, 128),
      bytes,
      type: stored.type,
    };
    this.items.set(item.id, item);
    this.changed();
    return item;
  }

  async importFile(file: File): Promise<LibrarySample> {
    return this.add(await file.arrayBuffer(), file.name, { type: file.type });
  }

  /** The demonstration samples shipped with CLATTER (public/samples). */
  async loadBundled(base: string, fetcher: (url: string) => Promise<Response> = (u) => fetch(u)): Promise<LibrarySample[]> {
    const res = await fetcher(`${base}samples/index.json`);
    if (!res.ok) return [];
    const index = (await res.json()) as { file: string; name: string; role: string }[];
    const out: LibrarySample[] = [];
    await Promise.all(
      index.map(async (e) => {
        try {
          const r = await fetcher(`${base}samples/${e.file}`);
          if (!r.ok) return;
          const s = await this.add(await r.arrayBuffer(), e.file, { role: e.role, bundled: true, type: 'audio/wav' });
          out.push(s);
        } catch {
          /* a missing demo sample is not fatal */
        }
      }),
    );
    return out;
  }

  /** Load the user's stored samples (all of them, or the given ids). */
  async restore(ids?: string[]): Promise<string[]> {
    if (!this.store) return [];
    const missing: string[] = [];
    try {
      const list = ids ?? (await this.store.list()).map((m) => m.id);
      for (const id of list) {
        if (this.items.has(id)) continue;
        const s = await this.store.get(id);
        if (!s) {
          missing.push(id);
          continue;
        }
        await this.add(s.bytes, s.name, { type: s.type, persist: false });
      }
    } catch {
      /* storage unavailable */
    }
    return missing;
  }

  /** Stored-sample records for bundles and kit files. */
  stored(ids: Iterable<string>): StoredSample[] {
    const out: StoredSample[] = [];
    for (const id of new Set(ids)) {
      const s = this.items.get(id);
      if (s) out.push({ id: s.id, name: s.name + '.wav', type: s.type, size: s.bytes.byteLength, added: 0, bytes: s.bytes });
    }
    return out;
  }

  /** Bundled samples for a role (default sound choices). */
  forRole(role: string): LibrarySample[] {
    return this.list().filter((s) => s.role === role);
  }
}
