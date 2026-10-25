/**
 * The user's modulation presets: saved, loaded, duplicated, renamed, deleted, exported and
 * imported as portable `clatter-mod` documents. Kept per browser (like the kit libraries'
 * indexes), through a small storage interface so tests run without a browser.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import { exportMod, importMod } from './format';
import { presetFrom, type ModPreset } from './presets';
import type { TrackMod } from './types';

export interface KeyValueStore {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}
export const MOD_LIBRARY_KEY = 'clatter.modpresets';

export class ModLibrary {
  private items: ModPreset[] = [];

  constructor(private store: KeyValueStore | null) {
    this.load();
  }

  private load(): void {
    try {
      const raw = this.store?.getItem(MOD_LIBRARY_KEY);
      const v = raw ? (JSON.parse(raw) as unknown) : [];
      if (!Array.isArray(v)) return;
      this.items = v.flatMap((x) => {
        if (!x || typeof x !== 'object' || typeof (x as { id?: unknown }).id !== 'string' || typeof (x as { name?: unknown }).name !== 'string') return [];
        try {
          const doc = importMod(JSON.stringify({ format: 'clatter-mod', version: 1, mod: (x as { mod?: unknown }).mod }));
          return [presetFrom((x as { id: string }).id, (x as { name: string }).name, doc.mod)];
        } catch {
          return [];
        }
      });
    } catch {
      this.items = [];
    }
  }

  private persist(): void {
    try {
      this.store?.setItem(MOD_LIBRARY_KEY, JSON.stringify(this.items));
    } catch {
      /* storage blocked: the presets last for this session */
    }
  }

  list(): ModPreset[] {
    return this.items.slice();
  }

  get(id: string): ModPreset | undefined {
    return this.items.find((p) => p.id === id);
  }

  private uniqueName(name: string): string {
    const base = name.toUpperCase().trim().slice(0, 22) || 'PRESET';
    let n = base;
    for (let i = 2; this.items.some((p) => p.name === n); i++) n = `${base.slice(0, 20)} ${i}`;
    return n;
  }

  private newId(): string {
    for (let i = this.items.length + 1; ; i++) if (!this.items.some((p) => p.id === 'u' + i)) return 'u' + i;
  }

  save(name: string, mod: TrackMod): ModPreset {
    const p = presetFrom(this.newId(), this.uniqueName(name), mod);
    this.items.push(p);
    this.persist();
    return p;
  }

  duplicate(id: string): ModPreset | undefined {
    const src = this.get(id);
    if (!src?.mod) return undefined;
    return this.save(src.name + ' COPY', src.mod);
  }

  rename(id: string, name: string): void {
    const p = this.get(id);
    if (!p) return;
    p.name = this.uniqueName(name === p.name ? name + ' ' : name).replace(/ $/, '');
    this.persist();
  }

  remove(id: string): void {
    this.items = this.items.filter((p) => p.id !== id);
    this.persist();
  }

  exportOne(id: string): string | undefined {
    const p = this.get(id);
    return p?.mod ? exportMod(p.mod, p.name) : undefined;
  }

  import(text: string): ModPreset {
    const doc = importMod(text);
    return this.save(doc.name ?? 'IMPORTED', doc.mod);
  }
}
