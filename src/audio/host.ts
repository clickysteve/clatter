/**
 * AudioHost: the main thread's side of live audio. Creates the AudioContext (asking for the
 * engine's native 44.1 kHz so no rate conversion is needed), loads the LXR WebAssembly and the
 * engine worklet, and passes configuration and timed hits to it. Meters come back from the
 * worklet about every 23 ms.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import workletUrl from './worklet.ts?worker&url';
import wasmUrl from './lxr/lxr.wasm?url';
import { ENGINE_RATE } from './engine';
import type { FromWorklet, MetersMessage, ToWorklet } from './protocol';

export type AudioState = 'off' | 'starting' | 'running' | 'suspended' | 'failed';

let wasmBytes: Promise<ArrayBuffer> | null = null;

/** The LXR WebAssembly module's bytes (fetched once). */
export function lxrWasm(): Promise<ArrayBuffer> {
  if (!wasmBytes) {
    wasmBytes = fetch(wasmUrl).then((r) => {
      if (!r.ok) throw new Error(`could not load the LXR engine (${r.status})`);
      return r.arrayBuffer();
    });
  }
  return wasmBytes;
}

export class AudioHost {
  ctx: AudioContext | null = null;
  node: AudioWorkletNode | null = null;
  state: AudioState = 'off';
  error = '';
  resampling = false;
  private queue: { msg: ToWorklet; transfer?: Transferable[] }[] = [];
  private meterFns = new Set<(m: MetersMessage) => void>();
  private stateFns = new Set<(s: AudioState) => void>();
  private startP: Promise<void> | null = null;

  constructor(
    readonly trackCount: number,
    readonly seed: number,
  ) {}

  onMeters(fn: (m: MetersMessage) => void): () => void {
    this.meterFns.add(fn);
    return () => this.meterFns.delete(fn);
  }

  onState(fn: (s: AudioState) => void): () => void {
    this.stateFns.add(fn);
    return () => this.stateFns.delete(fn);
  }

  private setState(s: AudioState): void {
    this.state = s;
    for (const f of this.stateFns) f(s);
  }

  /** Start audio (must follow a user gesture the first time). Resolves when the engine runs. */
  start(): Promise<void> {
    if (this.startP) {
      if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume();
      return this.startP;
    }
    this.setState('starting');
    this.startP = (async () => {
      try {
        let ctx: AudioContext;
        try {
          ctx = new AudioContext({ sampleRate: ENGINE_RATE, latencyHint: 'interactive' });
        } catch {
          ctx = new AudioContext({ latencyHint: 'interactive' });
        }
        this.ctx = ctx;
        const [bytes] = await Promise.all([lxrWasm(), ctx.audioWorklet.addModule(workletUrl)]);
        const node = new AudioWorkletNode(ctx, 'clatter-engine', {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [2],
          processorOptions: { wasm: bytes.slice(0), tracks: this.trackCount, seed: this.seed },
        });
        const ready = new Promise<void>((resolve, reject) => {
          node.port.onmessage = (e: MessageEvent<FromWorklet>) => {
            const d = e.data;
            if (d.type === 'ready') {
              this.resampling = d.resampling;
              resolve();
            } else if (d.type === 'error') reject(new Error(d.message));
            else if (d.type === 'meters') for (const f of this.meterFns) f(d);
          };
        });
        node.connect(ctx.destination);
        this.node = node;
        for (const q of this.queue) node.port.postMessage(q.msg, q.transfer ?? []);
        this.queue = [];
        if (ctx.state === 'suspended') await ctx.resume();
        await ready;
        ctx.onstatechange = () => this.setState(ctx.state === 'running' ? 'running' : ctx.state === 'suspended' ? 'suspended' : 'off');
        this.setState(ctx.state === 'running' ? 'running' : 'suspended');
      } catch (err) {
        this.error = err instanceof Error ? err.message : String(err);
        this.setState('failed');
        throw err;
      }
    })();
    return this.startP;
  }

  get running(): boolean {
    return this.state === 'running' && !!this.node;
  }

  send(msg: ToWorklet, transfer?: Transferable[]): void {
    if (this.node) this.node.port.postMessage(msg, transfer ?? []);
    else this.queue.push({ msg, transfer });
  }

  /** AudioContext time now. */
  get now(): number {
    return this.ctx?.currentTime ?? 0;
  }

  /** Seconds between the context's clock and what is heard. */
  get latency(): number {
    const c = this.ctx;
    if (!c) return 0;
    return (c.outputLatency || 0) + (c.baseLatency || 0);
  }

  /** AudioContext time for a performance.now() time (incoming MIDI clock). */
  audioTimeOf(ms: number): number {
    const c = this.ctx;
    if (!c) return ms / 1000;
    const ts = c.getOutputTimestamp?.();
    if (ts && ts.contextTime !== undefined && ts.performanceTime !== undefined && ts.performanceTime > 0) {
      return ts.contextTime + (ms - ts.performanceTime) / 1000;
    }
    return c.currentTime + (ms - performance.now()) / 1000;
  }

  /** performance.now() milliseconds for an AudioContext time (MIDI timestamps). */
  perfTimeOf(time: number): number {
    const c = this.ctx;
    if (!c) return performance.now();
    const ts = c.getOutputTimestamp?.();
    if (ts && ts.contextTime !== undefined && ts.performanceTime !== undefined && ts.performanceTime > 0) {
      return ts.performanceTime + (time - ts.contextTime) * 1000;
    }
    return performance.now() + (time - c.currentTime) * 1000;
  }
}
