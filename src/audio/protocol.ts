/**
 * Messages between the main thread (AudioHost) and the AudioWorklet (worklet.ts).
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import type { EngineTrack, HitEvent } from './engine';

/** A hit timed in AudioContext seconds (the worklet converts to engine frames). */
export type TimedHit = Omit<HitEvent, 'frame' | 'seq'> & { time: number };

export type ToWorklet =
  | { type: 'tracks'; tracks: EngineTrack[] }
  | { type: 'track'; index: number; track: Partial<EngineTrack> }
  | { type: 'params'; values: [number, number][]; /** AudioContext time to apply them (absent: now) */ time?: number }
  | { type: 'modTarget'; kind: 0 | 1; voice: number; param: number }
  | { type: 'bpm'; bpm: number }
  | { type: 'macros'; values: number[] }
  | { type: 'output'; out: import('./mixfx').OutputFx }
  | { type: 'modWatch'; track: number }
  | { type: 'master'; volume: number; clip: boolean; chain?: unknown }
  | { type: 'sample'; id: string; rate: number; channels: Float32Array[] }
  | { type: 'dropSample'; id: string }
  | { type: 'hits'; hits: TimedHit[] }
  | { type: 'cancel'; time: number }
  | { type: 'panic' }
  | { type: 'reseed'; seed: number };

export interface MetersMessage {
  type: 'meters';
  tracks: Float32Array;
  masterL: number;
  masterR: number;
  clipped: boolean;
  /** AudioContext time of the meters (end of the last rendered quantum) */
  time: number;
  /** LXR voice peaks (synthesis activity) */
  voices: Float32Array;
  /** gain reduction of the bus compressor and of the limiter (dB, positive) */
  busReduction: number;
  limitReduction: number;
  /** the watched track's modulation sources, positions, routes and destination sums */
  mod?: { track: number; out: Float32Array; pos: Float32Array; routes: Float32Array; dest: Float32Array };
}

export type FromWorklet = { type: 'ready'; rate: number; resampling: boolean } | { type: 'error'; message: string } | MetersMessage;
