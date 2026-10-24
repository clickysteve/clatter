/**
 * Offline rendering: the master, stems and single drum hits, with the same engine, the same
 * sequence and the same scheduler as live playback, driven by a simulated clock. Rendering is
 * deterministic: the LXR's noise generator, the engine's random sample picks and every rhythmic
 * decision are seeded, so the same project renders the same file every time.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import { ClatterEngine, BLOCK, ENGINE_RATE, type EngineSample, type EngineTrack } from './engine';
import { LxrEngine } from './lxr/lxr';
import type { SampleLibrary } from './library';
import { clone, PPQ, type Project, type SynthKit } from '../model/types';
import { Sequence } from '../app/sequence';
import { configureEngine, hitOf, kitDiff, trackIndex, type EngineTarget } from '../app/soundConfig';
import { Scheduler } from '../transport/scheduler';
import type { ChainConfig } from '@slopfactory/core/engines';

export interface RenderOptions {
  /** bars of music to render */
  bars: number;
  /** seconds of tail after the music (envelopes, delays) */
  tail: number;
  stems?: boolean;
  /** sound evolution during the render: the kit at each bar line */
  kitAtBar?: (bar: number) => SynthKit | null;
  onProgress?: (fraction: number) => void;
  /** yield to the browser every so many blocks (0 = never) */
  yieldEvery?: number;
}

export interface RenderResult {
  rate: number;
  frames: number;
  master: Float32Array[];
  /** per track id, post-fader (tracks routed to FX: before the FX bus) */
  stems: Record<string, Float32Array[]>;
  /** the FX bus return */
  fx: Float32Array[] | null;
}

/** An EngineTarget over an engine (offline). */
export function directTarget(e: ClatterEngine, frameOfTime: (t: number) => number = (t) => Math.round(t * ENGINE_RATE)): EngineTarget {
  return {
    setTrack: (i, t) => e.setTrack(i, t as Partial<EngineTrack>),
    setParams: (values, time) => {
      if (time === undefined) for (const [p, v] of values) e.setParam(p, v);
      else e.scheduleAction(frameOfTime(time), () => values.forEach(([p, v]) => e.setParam(p, v)));
    },
    setModTarget: (k, v, p) => e.setModTarget(k, v, p),
    setBpm: (b) => e.setBpm(b),
    setMaster: (vol, clip, chain: ChainConfig) => e.setMaster(vol, clip, chain),
    setSample: (id, s: EngineSample) => e.setSample(id, s),
  };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

export async function newEngine(module: WebAssembly.Module, p: Project, lib: SampleLibrary | null): Promise<ClatterEngine> {
  const lxr = LxrEngine.fromModule(module, p.seed || 1);
  const e = new ClatterEngine(lxr, p.tracks.length, p.seed || 1);
  configureEngine(directTarget(e), p, lib);
  return e;
}

/** Render the project from the start of its current pattern (or chain). */
export async function renderProject(module: WebAssembly.Module, project: Project, lib: SampleLibrary | null, o: RenderOptions): Promise<RenderResult> {
  const p = clone(project);
  const e = await newEngine(module, p, lib);
  const target = directTarget(e);
  let frame = 0;
  const seq = new Sequence({ project: () => p });
  const index = trackIndex(p);
  let lastKit = p.kit.synth;
  const musicFrames = Math.round(o.bars * 4 * PPQ * (60 / (p.tempo * PPQ)) * ENGINE_RATE);
  const sched = new Scheduler(seq, {
    now: () => frame / ENGINE_RATE,
    lookahead: 0.05,
    startDelay: 0,
    emit: (evs) => {
      for (const se of evs) {
        if (se.time * ENGINE_RATE >= musicFrames) continue; // the next cycle's downbeat is not part of the render
        const h = hitOf(se, p, index, sched.spt);
        if (!h) continue;
        const { time, ...rest } = h;
        e.schedule({ ...rest, frame: Math.round(time * ENGINE_RATE) });
      }
    },
    onBar: (bar, time) => {
      const k = o.kitAtBar?.(bar);
      if (k) {
        const d = kitDiff(lastKit, k);
        if (d.length) target.setParams(d, time);
        lastKit = k;
      }
    },
  });
  sched.bpm = p.tempo;
  const total = musicFrames + Math.round(o.tail * ENGINE_RATE);
  const blocks = Math.ceil(total / BLOCK);
  const frames = blocks * BLOCK;
  const L = new Float32Array(frames);
  const R = new Float32Array(frames);
  const stems: Record<string, Float32Array[]> = {};
  let fx: Float32Array[] | null = null;
  if (o.stems) {
    for (const t of p.tracks) stems[t.id] = [new Float32Array(frames), new Float32Array(frames)];
    fx = [new Float32Array(frames), new Float32Array(frames)];
    e.stemSink = (ti, l, r) => {
      const s = stems[p.tracks[ti]!.id]!;
      s[0]!.set(l, frame);
      s[1]!.set(r, frame);
    };
    e.fxSink = (l, r) => {
      fx![0]!.set(l, frame);
      fx![1]!.set(r, frame);
    };
  }
  sched.start(0);
  for (let b = 0; b < blocks; b++) {
    if (frame < musicFrames) sched.pump();
    else if (sched.running) sched.stop();
    e.renderBlock(L.subarray(frame, frame + BLOCK), R.subarray(frame, frame + BLOCK));
    frame += BLOCK;
    if (o.yieldEvery && b % o.yieldEvery === 0) {
      o.onProgress?.(b / blocks);
      await tick();
    }
  }
  // events scheduled beyond the end of the music are dropped by stopping; trim to `total`
  const cut = (x: Float32Array) => x.subarray(0, total);
  o.onProgress?.(1);
  return {
    rate: ENGINE_RATE,
    frames: total,
    master: [cut(L), cut(R)],
    stems: Object.fromEntries(Object.entries(stems).map(([k, v]) => [k, v.map(cut)])),
    fx: fx ? fx.map(cut) : null,
  };
}

/** One hit of one track, rendered alone until it falls silent (DRUM HITS). */
export async function renderHit(module: WebAssembly.Module, project: Project, lib: SampleLibrary | null, trackId: string, vel = 127, maxSeconds = 4): Promise<Float32Array[]> {
  const p = clone(project);
  // the track alone, at unity on the main bus, centred
  p.tracks.forEach((t) => {
    t.mix.mute = t.id !== trackId;
    t.mix.solo = false;
    if (t.id === trackId) {
      t.mix.volume = 0.8;
      t.mix.pan = 0;
      t.mix.route = 'main';
      t.mix.filter = 0;
    }
  });
  p.master.volume = 0.8;
  p.master.chain = null;
  const e = await newEngine(module, p, lib);
  const ti = p.tracks.findIndex((t) => t.id === trackId);
  e.schedule({ frame: 0, track: ti, vel, pitch: 0 });
  const maxBlocks = Math.ceil((maxSeconds * ENGINE_RATE) / BLOCK);
  const L: number[] = [];
  const R: number[] = [];
  const bl = new Float32Array(BLOCK);
  const br = new Float32Array(BLOCK);
  let quiet = 0;
  for (let b = 0; b < maxBlocks; b++) {
    e.renderBlock(bl, br);
    let peak = 0;
    for (let i = 0; i < BLOCK; i++) {
      L.push(bl[i]!);
      R.push(br[i]!);
      peak = Math.max(peak, Math.abs(bl[i]!), Math.abs(br[i]!));
    }
    quiet = peak < 0.0005 ? quiet + 1 : 0;
    if (b > 8 && quiet * BLOCK > ENGINE_RATE * 0.1) break;
  }
  // trim the trailing silence, keep 10 ms
  let end = L.length;
  while (end > 1 && Math.abs(L[end - 1]!) < 0.0005 && Math.abs(R[end - 1]!) < 0.0005) end--;
  end = Math.min(L.length, end + 441);
  return [Float32Array.from(L.slice(0, end)), Float32Array.from(R.slice(0, end))];
}
