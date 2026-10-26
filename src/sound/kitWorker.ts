/**
 * Kit analysis in a Worker: renders voices through the LXR engine (kitcheck.ts) away from the
 * main thread, so the scheduler keeps time while a kit is generated.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import { LxrEngine } from '../audio/lxr/lxr';
import { checkKit, readKit, type CheckOptions } from './kitcheck';
import type { SynthKit } from '../model/types';

export type KitWorkerRequest = { type: 'init'; wasm: ArrayBuffer } | { type: 'check'; id: number; kit: SynthKit; opts: CheckOptions };
export type KitWorkerReply = { type: 'ready'; initKit: SynthKit } | { type: 'checked'; id: number; kit: SynthKit; report: ReturnType<typeof checkKit>['report'] } | { type: 'error'; id: number; message: string };

let module: WebAssembly.Module | null = null;
let init: SynthKit | null = null;

self.onmessage = async (e: MessageEvent<KitWorkerRequest>) => {
  const m = e.data;
  if (m.type === 'init') {
    module = await WebAssembly.compile(m.wasm);
    init = readKit(LxrEngine.fromModule(module, 1));
    (self as unknown as Worker).postMessage({ type: 'ready', initKit: init } satisfies KitWorkerReply);
    return;
  }
  if (!module) {
    (self as unknown as Worker).postMessage({ type: 'error', id: m.id, message: 'engine not ready' } satisfies KitWorkerReply);
    return;
  }
  try {
    // a fresh engine for every check: the firmware keeps some oscillator state across init (the
    // noise phase), so a reused engine would make the same request measure differently
    const r = checkKit(LxrEngine.fromModule(module, 1), m.kit, { ...m.opts, fallback: m.opts.fallback ?? init ?? undefined });
    (self as unknown as Worker).postMessage({ type: 'checked', id: m.id, kit: r.kit, report: r.report } satisfies KitWorkerReply);
  } catch (err) {
    (self as unknown as Worker).postMessage({ type: 'error', id: m.id, message: String(err) } satisfies KitWorkerReply);
  }
};
