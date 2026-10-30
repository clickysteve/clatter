/**
 * The main thread's handle on the kit worker: check a kit, get it back level-matched.
 * Falls back to checking on the main thread when Workers are unavailable.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import KitWorker from './kitWorker.ts?worker';
import type { KitWorkerReply } from './kitWorker';
import { LxrEngine } from '../audio/lxr/lxr';
import { checkKit, readKit, type CheckOptions } from './kitcheck';
import type { SynthKit } from '../model/types';

export class KitService {
  private worker: Worker | null = null;
  /** main-thread fallback: the compiled engine, instantiated anew for every check (see kitWorker.ts) */
  private module: WebAssembly.Module | null = null;
  private waiting = new Map<number, (r: { kit: SynthKit }) => void>();
  private nextId = 1;
  initKit: SynthKit | null = null;
  readonly ready: Promise<SynthKit>;

  constructor(wasm: ArrayBuffer) {
    this.ready = new Promise<SynthKit>((resolve) => {
      try {
        const w = new KitWorker();
        this.worker = w;
        w.onmessage = (e: MessageEvent<KitWorkerReply>) => {
          const d = e.data;
          if (d.type === 'ready') {
            this.initKit = d.initKit;
            resolve(d.initKit);
          } else if (d.type === 'checked') {
            this.waiting.get(d.id)?.({ kit: d.kit });
            this.waiting.delete(d.id);
          } else if (d.type === 'error') {
            this.waiting.delete(d.id);
          }
        };
        w.onerror = () => void this.fallback(wasm).then(resolve);
        w.postMessage({ type: 'init', wasm: wasm.slice(0) });
      } catch {
        void this.fallback(wasm).then(resolve);
      }
    });
  }

  private async fallback(wasm: ArrayBuffer): Promise<SynthKit> {
    this.worker?.terminate();
    this.worker = null;
    this.module = await WebAssembly.compile(wasm.slice(0));
    this.initKit = readKit(LxrEngine.fromModule(this.module, 1));
    return this.initKit;
  }

  /** A level-matched, audible version of a kit (resolves with the input on failure). */
  async check(kit: SynthKit, opts: CheckOptions): Promise<SynthKit> {
    await this.ready;
    if (this.module) return checkKit(LxrEngine.fromModule(this.module, 1), kit, { ...opts, fallback: opts.fallback ?? this.initKit ?? undefined }).kit;
    const w = this.worker;
    if (!w) return kit;
    const id = this.nextId++;
    return new Promise<SynthKit>((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        resolve(kit);
      }, 8000);
      this.waiting.set(id, (r) => {
        clearTimeout(timer);
        resolve(r.kit);
      });
      w.postMessage({ type: 'check', id, kit, opts });
    });
  }
}
