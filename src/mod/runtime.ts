/**
 * ModRuntime: executes one track's modulation. Plain TypeScript, no browser APIs, no timers: it
 * is advanced by the engine in control-rate steps (one per 64-frame block, about 1.45 ms), so the
 * AudioWorklet, offline renders and tests run identical numbers.
 *
 *   sources (LFOs, envelopes, step sequencer, random, S&H, velocity, trigger, macros)
 *      → routes (amount, polarity, range, smoothing)
 *      → per-destination sums, clamped to -1..1 (`dest`, indexed like DESTS)
 *
 * Nothing here allocates while a block is processed, except an envelope's timeline when a hit
 * starts it. The runtime knows nothing about the LXR: the engine turns `dest` values into
 * parameter writes (see ClatterEngine.applyMods).
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import { DEST_INDEX, DESTS } from './registry';
import { clamp, envAt, envSegments, hashBi, hash01, lfoWave, type EnvSeg } from './shapes';
import { divBeats, SOURCE_IDS, typeOfSource, type EnvDef, type LfoDef, type RndDef, type ShDef, type SourceDef, type SourceId, type StepDef, type TrackMod, type TrigDef } from './types';

const N = SOURCE_IDS.length;
const SRC_INDEX = new Map(SOURCE_IDS.map((id, i) => [id, i] as const));
export const srcIndex = (id: SourceId): number => SRC_INDEX.get(id)!;

/** Timing context of a hit: seconds since the bar line and since the start of the pattern. */
export interface HitContext {
  barSec?: number;
  patSec?: number;
}

interface Slot {
  id: SourceId;
  idx: number;
  def: SourceDef;
  cyc: number;
  hits: number;
  acc: number;
  held: number;
  tick: number;
  level: number;
  t: number;
  running: boolean;
  segs: EnvSeg[];
}

const newSlot = (id: SourceId, def: SourceDef): Slot => ({ id, idx: srcIndex(id), def, cyc: 0, hits: 0, acc: 0, held: 0, tick: -1, level: 0, t: 0, running: false, segs: [] });

/** The step number `k` of a sequence of `len` steps in a direction. */
export function stepIndex(dir: StepDef['dir'], len: number, k: number, seed: number, hits: number): number {
  if (len <= 1) return 0;
  switch (dir) {
    case 'rev':
      return len - 1 - (k % len);
    case 'ping': {
      const n = 2 * len - 2;
      const j = k % n;
      return j < len ? j : n - j;
    }
    case 'rand':
      return Math.min(len - 1, Math.floor(hash01(seed, hits, k) * len));
    default:
      return k % len;
  }
}

/** Is the source's output bipolar (-1..1)? Unipolar sources (envelopes, macros...) are 0..1. */
export function isBipolar(def: SourceDef | undefined): boolean {
  if (!def) return false;
  switch (def.type) {
    case 'lfo':
    case 'rnd':
    case 'smooth':
    case 'sh':
      return !def.uni;
    case 'step':
      return true;
    default:
      return false;
  }
}

export class ModRuntime {
  cfg: TrackMod = { sources: {}, routes: [] };
  bpm = 120;
  /** current output of every source id (-1..1) */
  readonly out = new Float32Array(N);
  /** display position of every source: LFO cycle phase, envelope time progress, current step index */
  readonly pos = new Float32Array(N);
  /** per destination (indexed like DESTS): the summed modulation, -1..1 */
  readonly dest = new Float32Array(DESTS.length);
  /** per route (config order): its current contribution after smoothing */
  readonly routeVal = new Float32Array(64);
  /** destination indices this config modulates */
  active: number[] = [];
  private slots: Slot[] = [];
  private bySrc: (Slot | undefined)[] = new Array(N).fill(undefined);
  private rstate = new Float32Array(64);
  private primed = false;
  private vel = 0;
  private trigLevel = 0;
  /** a monotone count of hits (salts random streams) */
  hits = 0;

  constructor(readonly seed = 1) {}

  get hasRoutes(): boolean {
    return this.active.length > 0;
  }

  /**
   * Replace the configuration. By default all source state restarts and the smoothing re-primes
   * (nothing leaks from the previous configuration). With `keep`, sources and routes that are
   * still there continue where they were: editing a depth while a pattern plays does not
   * restart the LFOs.
   */
  setConfig(cfg: TrackMod | null, keep = false): void {
    const old = new Map(this.slots.map((s) => [s.id, s] as const));
    const oldR = new Map(this.cfg.routes.map((r, i) => [r.id, this.rstate[i]!] as const));
    this.cfg = cfg ?? { sources: {}, routes: [] };
    this.slots = [];
    this.bySrc.fill(undefined);
    for (const id of SOURCE_IDS) {
      const def = this.cfg.sources[id];
      if (!def) continue;
      const s = newSlot(id, def);
      const o = keep ? old.get(id) : undefined;
      if (o && o.def.type === def.type) Object.assign(s, { cyc: o.cyc, hits: o.hits, acc: o.acc, held: o.held, tick: o.tick, level: o.level, t: o.t, running: o.running, segs: o.segs });
      this.slots.push(s);
      this.bySrc[s.idx] = s;
    }
    const act = new Set<number>();
    this.cfg.routes.forEach((r) => {
      const di = DEST_INDEX.get(r.dst);
      if (r.on && di !== undefined && r.amt !== 0) act.add(di);
    });
    this.active = [...act];
    this.dest.fill(0);
    this.out.fill(0);
    this.pos.fill(0);
    this.rstate.fill(0);
    this.routeVal.fill(0);
    if (keep) this.cfg.routes.forEach((r, i) => (this.rstate[i] = oldR.get(r.id) ?? 0));
    this.primed = keep;
    if (!keep) {
      this.vel = 0;
      this.trigLevel = 0;
    }
  }

  setBpm(bpm: number): void {
    this.bpm = clamp(bpm, 20, 400);
  }

  private period(div: string): number {
    return (divBeats(div) * 60) / this.bpm;
  }

  /** A hit starts: restart the sources whose retrigger says so, then recompute (the values at time zero). */
  trigger(vel: number, ctx: HitContext = {}, macros?: Float32Array): void {
    this.hits++;
    this.vel = clamp(vel, 0, 127) / 127;
    for (const s of this.slots) {
      const d = s.def;
      switch (d.type) {
        case 'lfo': {
          const rate = this.lfoRate(d);
          if (d.retrig === 'hit') {
            s.cyc = 0;
            s.hits = this.hits;
          } else if (d.retrig === 'bar') s.cyc = rate * (ctx.barSec ?? 0);
          else if (d.retrig === 'pattern') s.cyc = rate * (ctx.patSec ?? 0);
          break;
        }
        case 'env':
          this.startEnv(s, d, this.vel);
          break;
        case 'step':
          if (d.retrig === 'hit') {
            s.acc = 0;
            s.hits = this.hits;
          }
          break;
        default:
          break;
      }
    }
    const tdef = this.bySrc[srcIndex('trig')]?.def as TrigDef | undefined;
    this.trigLevel = tdef && !tdef.vel ? 1 : this.vel;
    this.compute(macros, 0);
  }

  private lfoRate(d: LfoDef): number {
    return d.mode === 'free' ? d.hz : this.bpm / 60 / divBeats(d.div);
  }

  private startEnv(s: Slot, d: EnvDef, vel: number): void {
    const v127 = vel * 127;
    if (d.trig === 'accent' && v127 < 100) return;
    if (d.trig === 'ghost' && v127 >= 64) return;
    if (s.running && d.retrig === 'ignore') return;
    const from = s.running && d.retrig === 'legato' ? s.level : 0;
    s.segs = envSegments(d, d.sync ? 60 / this.bpm : 0.001, from);
    s.t = 0;
    s.running = true;
  }

  /** Advance by dt seconds and recompute. */
  advance(dt: number, macros?: Float32Array): void {
    for (const s of this.slots) {
      const d = s.def;
      switch (d.type) {
        case 'lfo':
          s.cyc += this.lfoRate(d) * dt;
          break;
        case 'env':
          if (s.running) {
            s.t += dt;
            const r = envAt(s.segs, s.t, d.kind === 'multi' ? d.loop : null);
            s.level = r.v;
            if (r.done) {
              s.running = false;
              s.level = d.kind === 'multi' ? (d.pts[d.pts.length - 1]?.v ?? 0) : 0;
            }
          }
          break;
        case 'step':
        case 'rnd':
        case 'smooth':
        case 'sh':
          s.acc += dt;
          break;
        default:
          break;
      }
    }
    if (this.trigLevel > 1e-4) {
      const t = this.bySrc[srcIndex('trig')]?.def as TrigDef | undefined;
      this.trigLevel *= Math.exp(-dt / (Math.max(5, t?.ms ?? 160) / 1000));
    } else this.trigLevel = 0;
    this.compute(macros, dt);
  }

  /** Recompute outputs and destination sums without advancing time. */
  evaluate(macros?: Float32Array): void {
    this.compute(macros, 0);
  }

  private compute(macros: Float32Array | undefined, dt: number): void {
    const out = this.out;
    // generators first; sample and hold last, since it reads the others
    for (const s of this.slots) {
      const d = s.def;
      switch (d.type) {
        case 'lfo': {
          let w = lfoWave(d, s.cyc + d.phase, d.retrig === 'hit' ? s.hits : 0);
          if (d.uni) w = (w + 1) / 2;
          out[s.idx] = clamp(w * d.depth + d.offset, -1, 1);
          this.pos[s.idx] = (((s.cyc + d.phase) % 1) + 1) % 1;
          break;
        }
        case 'env': {
          if (!s.running && s.level === 0 && !s.segs.length) s.level = d.kind === 'multi' ? d.v0 : 0;
          out[s.idx] = s.level;
          const total = s.segs.length ? s.segs[s.segs.length - 1]!.t0 + s.segs[s.segs.length - 1]!.dur : 0;
          this.pos[s.idx] = s.running && total > 0 ? Math.min(1, s.t / total) : 0;
          break;
        }
        case 'step': {
          const per = this.period(d.div);
          const k = Math.floor(s.acc / per);
          const f = s.acc / per - k;
          const i = stepIndex(d.dir, d.len, k, d.seed, s.hits);
          const cur = d.vals[i] ?? 0;
          let v = cur;
          if (d.glide > 0 && k > 0) {
            const prev = d.vals[stepIndex(d.dir, d.len, k - 1, d.seed, s.hits)] ?? 0;
            const x = Math.min(1, f / d.glide);
            v = prev + (cur - prev) * (0.5 - 0.5 * Math.cos(Math.PI * x));
          }
          out[s.idx] = v;
          this.pos[s.idx] = i;
          break;
        }
        case 'rnd': {
          const per = this.period(d.div);
          const k = Math.floor(s.acc / per);
          const v = hashBi(d.seed, 7, k);
          out[s.idx] = d.uni ? (v + 1) / 2 : v;
          this.pos[s.idx] = (s.acc / per) % 1;
          break;
        }
        case 'smooth': {
          const per = this.period(d.div);
          const x = s.acc / per;
          const k = Math.floor(x);
          const f = x - k;
          const a = hashBi(d.seed, 11, k);
          const b = hashBi(d.seed, 11, k + 1);
          const v = a + (b - a) * (0.5 - 0.5 * Math.cos(Math.PI * f));
          out[s.idx] = d.uni ? (v + 1) / 2 : v;
          this.pos[s.idx] = f;
          break;
        }
        default:
          break;
      }
    }
    for (const s of this.slots) {
      if (s.def.type !== 'sh') continue;
      const d = s.def as ShDef;
      const per = this.period(d.div);
      const k = Math.floor(s.acc / per);
      if (k !== s.tick) {
        s.tick = k;
        s.held = d.from === 'noise' ? hashBi(d.seed, 13, k) : out[srcIndex(d.from)]!;
        if (d.uni && d.from === 'noise') s.held = (s.held + 1) / 2;
      }
      out[s.idx] = s.held;
      this.pos[s.idx] = (s.acc / per) % 1;
    }
    out[srcIndex('vel')] = this.vel;
    out[srcIndex('trig')] = this.trigLevel;
    for (let i = 0; i < 4; i++) out[srcIndex(`m${i + 1}` as SourceId)] = macros ? (macros[i] ?? 0) : 0;

    // routes → destinations
    this.dest.fill(0);
    const routes = this.cfg.routes;
    for (let i = 0; i < routes.length && i < 64; i++) {
      const r = routes[i]!;
      const di = DEST_INDEX.get(r.dst);
      if (!r.on || di === undefined) {
        this.routeVal[i] = 0;
        this.rstate[i] = 0;
        continue;
      }
      const si = srcIndex(r.src);
      let x = out[si]!;
      if (r.pol === 'inv') x = -x;
      else if (r.pol === 'uni' && isBipolar(this.bySrc[si]?.def)) x = (x + 1) / 2;
      let c = clamp(x * r.amt, r.lo, r.hi);
      if (r.smooth > 0 && this.primed && dt > 0) {
        const a = 1 - Math.exp(-dt / (r.smooth / 1000));
        c = this.rstate[i]! + (c - this.rstate[i]!) * a;
      }
      this.rstate[i] = c;
      this.routeVal[i] = c;
      this.dest[di]! += c;
    }
    for (const di of this.active) this.dest[di] = clamp(this.dest[di]!, -1, 1);
    this.primed = true;
  }

  /** The source's type, for displays. */
  typeOf(id: SourceId): string {
    return typeOfSource(id);
  }
}

/** Run a configuration on its own for `seconds` (tests, editor previews): a value per control step. */
export function simulate(cfg: TrackMod, o: { bpm?: number; seconds: number; hitsAt?: number[]; vel?: number; dt?: number; macros?: number[]; seed?: number }): { t: Float32Array; out: Float32Array[]; dest: Float32Array[] } {
  const rt = new ModRuntime(o.seed ?? 1);
  rt.setBpm(o.bpm ?? 120);
  rt.setConfig(cfg);
  const dt = o.dt ?? 64 / 44100;
  const n = Math.ceil(o.seconds / dt);
  const t = new Float32Array(n);
  const out: Float32Array[] = SOURCE_IDS.map(() => new Float32Array(n));
  const dest: Float32Array[] = DESTS.map(() => new Float32Array(n));
  const macros = Float32Array.from(o.macros ?? [0, 0, 0, 0]);
  const hits = [...(o.hitsAt ?? [0])].sort((a, b) => a - b);
  let hi = 0;
  rt.evaluate(macros);
  for (let i = 0; i < n; i++) {
    const now = i * dt;
    while (hi < hits.length && hits[hi]! <= now + 1e-9) {
      rt.trigger(o.vel ?? 100, { barSec: now % ((4 * 60) / rt.bpm), patSec: now }, macros);
      hi++;
    }
    t[i] = now;
    for (let s = 0; s < N; s++) out[s]![i] = rt.out[s]!;
    for (let d = 0; d < DESTS.length; d++) dest[d]![i] = rt.dest[d]!;
    rt.advance(dt, macros);
  }
  return { t, out, dest };
}

export type { RndDef };
