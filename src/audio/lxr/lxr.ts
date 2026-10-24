/**
 * LxrEngine: the WebAssembly build of the LXR-02 synthesis engine (lxr/, built by
 * scripts/build-lxr.mjs), wrapped for TypeScript. Usable in the AudioWorklet, in offline
 * renders and in tests (no Web Audio needed).
 *
 * The engine runs at its native rate (REAL_FS, 44 140 Hz on the hardware; CLATTER plays it at
 * 44 100 Hz, see docs/LXR_PORT.md) in blocks of 64 frames and gives each of its six voices its
 * own stereo output.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */

interface LxrExports {
  memory: WebAssembly.Memory;
  clatter_init(seed: number): void;
  clatter_seed(seed: number): void;
  clatter_voice_out(): number;
  clatter_voice_peaks(): number;
  clatter_fx_in(): number;
  clatter_fx_out(): number;
  clatter_block_size(): number;
  clatter_sample_rate(): number;
  clatter_param_count(): number;
  clatter_set_param(p: number, v: number): void;
  clatter_get_param(p: number): number;
  clatter_set_mod_target(kind: number, voice: number, param: number): void;
  clatter_set_bpm(bpm: number): void;
  clatter_load_init_kit(): void;
  clatter_trigger(trig: number, vel: number, note: number): void;
  clatter_trigger_locked(trig: number, vel: number, note: number, p1: number, v1: number, p2: number, v2: number): void;
  clatter_render_block(): void;
  clatter_fx_process(): void;
  clatter_fx_clear(): void;
}

export const LXR_BLOCK = 64;
export const LXR_VOICES = 6;

export class LxrEngine {
  readonly block: number;
  /** voice outputs: [voice][channel][frame] flattened, 6 × 2 × 64 */
  readonly out: Float32Array;
  readonly peaks: Float32Array;
  readonly fxIn: Int16Array;
  readonly fxOut: Int16Array;
  readonly paramCount: number;

  private constructor(private x: LxrExports) {
    this.block = x.clatter_block_size();
    this.paramCount = x.clatter_param_count();
    this.out = new Float32Array(x.memory.buffer, x.clatter_voice_out(), LXR_VOICES * 2 * this.block);
    this.peaks = new Float32Array(x.memory.buffer, x.clatter_voice_peaks(), LXR_VOICES);
    this.fxIn = new Int16Array(x.memory.buffer, x.clatter_fx_in(), this.block * 2);
    this.fxOut = new Int16Array(x.memory.buffer, x.clatter_fx_out(), this.block * 2);
  }

  /** Instantiate from a compiled module (AudioWorklet, workers) or the .wasm bytes. */
  static async create(source: WebAssembly.Module | BufferSource, seed = 1): Promise<LxrEngine> {
    const inst = source instanceof WebAssembly.Module ? await WebAssembly.instantiate(source, {}) : (await WebAssembly.instantiate(source, {})).instance;
    const e = new LxrEngine(inst.exports as unknown as LxrExports);
    e.init(seed);
    return e;
  }

  /** Synchronous instantiation from a compiled module (allowed in workers and worklets). */
  static fromModule(module: WebAssembly.Module, seed = 1): LxrEngine {
    const inst = new WebAssembly.Instance(module, {});
    const e = new LxrEngine(inst.exports as unknown as LxrExports);
    e.init(seed);
    return e;
  }

  /** Reset every voice and the FX bus and load the firmware's init kit. */
  init(seed: number): void {
    this.x.clatter_init(seed >>> 0 || 1);
  }

  seed(seed: number): void {
    this.x.clatter_seed(seed >>> 0 || 1);
  }

  get nativeRate(): number {
    return this.x.clatter_sample_rate();
  }

  setParam(p: number, v: number): void {
    this.x.clatter_set_param(p, v);
  }

  getParam(p: number): number {
    return this.x.clatter_get_param(p);
  }

  /** kind 0 = LFO, 1 = velocity; param = PAR_* number (0 = none). */
  setModTarget(kind: 0 | 1, voice: number, param: number): void {
    this.x.clatter_set_mod_target(kind, voice, param);
  }

  setBpm(bpm: number): void {
    this.x.clatter_set_bpm(Math.round(bpm));
  }

  trigger(trig: number, velocity: number, note = 60): void {
    this.x.clatter_trigger(trig, velocity, note);
  }

  triggerLocked(trig: number, velocity: number, note: number, p1: number, v1: number, p2: number, v2: number): void {
    this.x.clatter_trigger_locked(trig, velocity, note, p1, v1, p2, v2);
  }

  /** Render one block into `out` (6 voices × L/R × 64). */
  render(): void {
    this.x.clatter_render_block();
  }

  /** Run the FX bus on `fxIn` into `fxOut`. */
  processFx(): void {
    this.x.clatter_fx_process();
  }

  clearFx(): void {
    this.x.clatter_fx_clear();
  }

  /** Offset of voice v's channel c in `out`. */
  offset(v: number, c: number): number {
    return (v * 2 + c) * this.block;
  }
}
