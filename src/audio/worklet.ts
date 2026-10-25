/**
 * The AudioWorklet: runs ClatterEngine (the LXR engine, sample voices, mixer, FX bus and
 * master) in the audio thread. The main thread sends configuration and timed hits; nothing
 * here allocates per sample, and messages are handled between render quanta.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import { ClatterEngine, ENGINE_RATE } from './engine';
import { LxrEngine } from './lxr/lxr';
import { StreamResampler } from './resample';
import type { ToWorklet } from './protocol';
import { repairChain } from '@slopfactory/core/engines';

declare const sampleRate: number;
declare const currentTime: number;
declare const currentFrame: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}

interface Options {
  processorOptions: { wasm: ArrayBuffer; tracks: number; seed: number };
}

class ClatterProcessor extends AudioWorkletProcessor {
  private engine: ClatterEngine | null = null;
  private pending: ToWorklet[] = [];
  private resampler: StreamResampler | null = null;
  /** AudioContext time at which engine frame 0 is output */
  private t0 = 0;
  private quanta = 0;
  private L = new Float32Array(128);
  private R = new Float32Array(128);

  constructor(options: Options) {
    super(options);
    const { wasm, tracks, seed } = options.processorOptions;
    this.port.onmessage = (e: MessageEvent<ToWorklet>) => {
      if (this.engine) this.handle(e.data);
      else this.pending.push(e.data);
    };
    WebAssembly.compile(wasm)
      .then((mod) => {
        const lxr = LxrEngine.fromModule(mod, seed);
        const engine = new ClatterEngine(lxr, tracks, seed);
        this.engine = engine;
        if (sampleRate !== ENGINE_RATE) this.resampler = new StreamResampler(ENGINE_RATE, sampleRate, (l, r, n) => engine.process(l, r, n));
        this.t0 = currentTime;
        for (const m of this.pending) this.handle(m);
        this.pending = [];
        this.port.postMessage({ type: 'ready', rate: sampleRate, resampling: !!this.resampler });
      })
      .catch((err: unknown) => this.port.postMessage({ type: 'error', message: String(err) }));
  }

  /** AudioContext time → engine frame. */
  private frameOf(time: number): number {
    return Math.round((time - this.t0) * ENGINE_RATE);
  }

  private handle(m: ToWorklet): void {
    const e = this.engine!;
    switch (m.type) {
      case 'tracks':
        m.tracks.forEach((t, i) => e.setTrack(i, t));
        break;
      case 'track':
        e.setTrack(m.index, m.track);
        break;
      case 'params':
        if (m.time === undefined) for (const [p, v] of m.values) e.setParam(p, v);
        else e.scheduleAction(this.frameOf(m.time), () => m.values.forEach(([p, v]) => e.setParam(p, v)));
        break;
      case 'modTarget':
        e.setModTarget(m.kind, m.voice, m.param);
        break;
      case 'bpm':
        e.setBpm(m.bpm);
        break;
      case 'macros':
        e.setMacros(m.values);
        break;
      case 'output':
        e.setOutput(m.out);
        break;
      case 'modWatch':
        e.watchMod(m.track);
        break;
      case 'master':
        e.setMaster(m.volume, m.clip, m.chain === undefined ? undefined : repairChain(m.chain));
        break;
      case 'sample':
        e.setSample(m.id, { rate: m.rate, channels: m.channels });
        break;
      case 'dropSample':
        e.setSample(m.id, null);
        break;
      case 'hits':
        for (const h of m.hits) {
          const { time, ...rest } = h;
          e.schedule({ ...rest, frame: Math.max(e.frame, this.frameOf(time)) });
        }
        break;
      case 'cancel':
        e.cancelFrom(this.frameOf(m.time));
        break;
      case 'panic':
        e.panic();
        break;
      case 'reseed':
        e.lxr.seed(m.seed);
        break;
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    const e = this.engine;
    if (!out || !out[0]) return true;
    const n = out[0].length;
    if (!e) return true;
    if (this.L.length < n) {
      this.L = new Float32Array(n);
      this.R = new Float32Array(n);
    }
    if (this.resampler) this.resampler.process(this.L, this.R, n);
    else e.process(this.L, this.R, n);
    out[0].set(this.L.subarray(0, n));
    if (out[1]) out[1].set(this.R.subarray(0, n));
    if (++this.quanta % 8 === 0) {
      const m = e.takeMeters();
      this.port.postMessage({ type: 'meters', tracks: m.tracks, masterL: m.masterL, masterR: m.masterR, clipped: m.clipped, time: currentTime + n / sampleRate, voices: e.lxr.peaks.slice(), busReduction: m.busReduction, limitReduction: m.limitReduction, mod: m.mod });
    }
    void currentFrame;
    return true;
  }
}

registerProcessor('clatter-engine', ClatterProcessor);
