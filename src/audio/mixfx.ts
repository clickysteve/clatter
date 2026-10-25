/**
 * CLATTER's output processing: channel processing (per track), bus processing (the summed
 * mix) and master protection (width, limiter). The LXR's own FX bus is untouched (it is the
 * firmware's effect); everything here is CLATTER's, runs in the same engine as playback and
 * export, and is free when bypassed: a stage that is off is not called, so a bypassed chain
 * leaves the signal bit-identical.
 *
 *   track → one-knob filter → CHANNEL (transient, EQ, saturation, soft clip, bit reduction)
 *         → fader and pan → dry to the bus, and/or send to the LXR FX bus
 *   bus sum + FX return → BUS (filter, distortion, compressor, stereo)
 *         → Slop Factory output chain → master gain → WIDTH → soft clip → LIMITER → out
 *
 * No stage allocates while processing and none adds latency (the limiter has no look-ahead:
 * it reacts within the sample and a final clamp guarantees the ceiling).
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
export const MIX_RATE = 44100;

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const db2lin = (db: number): number => Math.pow(10, db / 20);
const lin2db = (x: number): number => 20 * Math.log10(Math.max(1e-9, x));
const flush = (x: number): number => (x < 1e-20 && x > -1e-20 ? 0 : x);

// ---------------------------------------------------------------------------- config
export interface ChannelFx {
  trans: { on: boolean; attack: number; sustain: number };
  eq: { on: boolean; low: number; mid: number; high: number };
  sat: { on: boolean; drive: number; mix: number };
  clip: { on: boolean; thresh: number };
  crush: { on: boolean; bits: number; rate: number };
}
export const defaultChannelFx = (): ChannelFx => ({
  trans: { on: false, attack: 0.3, sustain: 0 },
  eq: { on: false, low: 0, mid: 0, high: 0 },
  sat: { on: false, drive: 0.3, mix: 1 },
  clip: { on: false, thresh: 0.8 },
  crush: { on: false, bits: 10, rate: 0.2 },
});
export const channelFxActive = (c: ChannelFx | undefined): boolean => !!c && (c.trans.on || c.eq.on || c.sat.on || c.clip.on || c.crush.on);

export interface BusFx {
  filter: { on: boolean; hp: number; lp: number };
  dist: { on: boolean; type: 'tube' | 'fold' | 'clip'; drive: number; mix: number };
  comp: { on: boolean; thresh: number; ratio: number; attack: number; release: number; makeup: number; mix: number };
  stereo: { on: boolean; width: number };
}
export const defaultBusFx = (): BusFx => ({
  filter: { on: false, hp: 30, lp: 18000 },
  dist: { on: false, type: 'tube', drive: 0.25, mix: 0.5 },
  comp: { on: false, thresh: -14, ratio: 3, attack: 10, release: 120, makeup: 2, mix: 1 },
  stereo: { on: false, width: 1.2 },
});
export const busFxActive = (b: BusFx | undefined): boolean => !!b && (b.filter.on || b.dist.on || b.comp.on || b.stereo.on);

export interface OutputFx {
  bus: BusFx;
  /** master stereo width, 1 = unchanged */
  width: number;
  limiter: { on: boolean; ceiling: number; release: number };
}
export const defaultOutputFx = (): OutputFx => ({ bus: defaultBusFx(), width: 1, limiter: { on: true, ceiling: -0.3, release: 80 } });
/** What projects from before the output stage have: nothing added, so they sound as they did. */
export const legacyOutputFx = (): OutputFx => ({ bus: defaultBusFx(), width: 1, limiter: { on: false, ceiling: -0.3, release: 80 } });

// ---------------------------------------------------------------------------- biquad
class Biquad {
  b0 = 1; b1 = 0; b2 = 0; a1 = 0; a2 = 0;
  private z1 = 0; private z2 = 0;
  setPeak(f: number, gainDb: number, q: number): void {
    const A = Math.pow(10, gainDb / 40);
    const w = (2 * Math.PI * f) / MIX_RATE;
    const al = Math.sin(w) / (2 * q);
    const c = Math.cos(w);
    const a0 = 1 + al / A;
    this.b0 = (1 + al * A) / a0; this.b1 = (-2 * c) / a0; this.b2 = (1 - al * A) / a0; this.a1 = (-2 * c) / a0; this.a2 = (1 - al / A) / a0;
  }
  setShelf(f: number, gainDb: number, high: boolean): void {
    const A = Math.pow(10, gainDb / 40);
    const w = (2 * Math.PI * f) / MIX_RATE;
    const c = Math.cos(w);
    const al = (Math.sin(w) / 2) * Math.SQRT2;
    const t = 2 * Math.sqrt(A) * al;
    let a0: number;
    if (!high) {
      a0 = A + 1 + (A - 1) * c + t;
      this.b0 = (A * (A + 1 - (A - 1) * c + t)) / a0;
      this.b1 = (2 * A * (A - 1 - (A + 1) * c)) / a0;
      this.b2 = (A * (A + 1 - (A - 1) * c - t)) / a0;
      this.a1 = (-2 * (A - 1 + (A + 1) * c)) / a0;
      this.a2 = (A + 1 + (A - 1) * c - t) / a0;
    } else {
      a0 = A + 1 - (A - 1) * c + t;
      this.b0 = (A * (A + 1 + (A - 1) * c + t)) / a0;
      this.b1 = (-2 * A * (A - 1 + (A + 1) * c)) / a0;
      this.b2 = (A * (A + 1 + (A - 1) * c - t)) / a0;
      this.a1 = (2 * (A - 1 - (A + 1) * c)) / a0;
      this.a2 = (A + 1 - (A - 1) * c - t) / a0;
    }
  }
  run(x: number): number {
    const y = this.b0 * x + this.z1;
    this.z1 = flush(this.b1 * x - this.a1 * y + this.z2);
    this.z2 = flush(this.b2 * x - this.a2 * y);
    return y;
  }
  reset(): void {
    this.z1 = this.z2 = 0;
  }
}

/** A TPT state-variable filter, one channel: low-pass or high-pass. */
class Svf {
  private ic1 = 0; private ic2 = 0;
  g = 0; k = Math.SQRT2;
  set(f: number, q = 0.7): void {
    this.g = Math.tan((Math.PI * clamp(f, 10, MIX_RATE * 0.45)) / MIX_RATE);
    this.k = 1 / q;
  }
  run(x: number, hp: boolean): number {
    const a1 = 1 / (1 + this.g * (this.g + this.k));
    const a2 = this.g * a1;
    const a3 = this.g * a2;
    const v3 = x - this.ic2;
    const v1 = a1 * this.ic1 + a2 * v3;
    const v2 = this.ic2 + a2 * this.ic1 + a3 * v3;
    this.ic1 = flush(2 * v1 - this.ic1);
    this.ic2 = flush(2 * v2 - this.ic2);
    return hp ? x - this.k * v1 - v2 : v2;
  }
  reset(): void {
    this.ic1 = this.ic2 = 0;
  }
}

// ---------------------------------------------------------------------------- channel
export class ChannelProcessor {
  cfg: ChannelFx = defaultChannelFx();
  private eq: Biquad[][] = [[new Biquad(), new Biquad(), new Biquad()], [new Biquad(), new Biquad(), new Biquad()]];
  private fast = 0; private slow = 0; private tg = 1;
  private holdL = 0; private holdR = 0; private ph = 0;
  private eqKey = '';

  set(cfg: ChannelFx): void {
    this.cfg = cfg;
    const k = `${cfg.eq.low}|${cfg.eq.mid}|${cfg.eq.high}`;
    if (k !== this.eqKey) {
      this.eqKey = k;
      for (const ch of this.eq) {
        ch[0]!.setShelf(120, cfg.eq.low, false);
        ch[1]!.setPeak(1000, cfg.eq.mid, 0.8);
        ch[2]!.setShelf(6000, cfg.eq.high, true);
      }
    }
  }

  get active(): boolean {
    return channelFxActive(this.cfg);
  }

  process(L: Float32Array, R: Float32Array, n: number): void {
    const c = this.cfg;
    if (c.trans.on) this.transient(L, R, n);
    if (c.eq.on && (c.eq.low || c.eq.mid || c.eq.high)) {
      for (let ch = 0; ch < 2; ch++) {
        const x = ch === 0 ? L : R;
        const f = this.eq[ch]!;
        for (let i = 0; i < n; i++) x[i] = f[2]!.run(f[1]!.run(f[0]!.run(x[i]!)));
      }
    }
    if (c.sat.on) {
      const g = 1 + c.sat.drive * 9;
      const norm = 1 / Math.tanh(g);
      const m = c.sat.mix;
      for (let i = 0; i < n; i++) {
        L[i] = L[i]! * (1 - m) + Math.tanh(L[i]! * g) * norm * m;
        R[i] = R[i]! * (1 - m) + Math.tanh(R[i]! * g) * norm * m;
      }
    }
    if (c.clip.on) {
      const t = clamp(c.clip.thresh, 0.05, 1);
      for (let i = 0; i < n; i++) {
        L[i] = t * Math.tanh(L[i]! / t);
        R[i] = t * Math.tanh(R[i]! / t);
      }
    }
    if (c.crush.on) {
      const q = Math.pow(2, clamp(Math.round(c.crush.bits), 2, 16) - 1);
      const step = 1 + clamp(c.crush.rate, 0, 1) * 31;
      for (let i = 0; i < n; i++) {
        this.ph += 1;
        if (this.ph >= step) {
          this.ph -= step;
          this.holdL = Math.round(L[i]! * q) / q;
          this.holdR = Math.round(R[i]! * q) / q;
        }
        L[i] = this.holdL;
        R[i] = this.holdR;
      }
    }
  }

  private transient(L: Float32Array, R: Float32Array, n: number): void {
    const { attack, sustain } = this.cfg.trans;
    const af = 1 - Math.exp(-1 / (0.001 * MIX_RATE));
    const as = 1 - Math.exp(-1 / (0.035 * MIX_RATE));
    const ag = 1 - Math.exp(-1 / (0.0004 * MIX_RATE));
    for (let i = 0; i < n; i++) {
      const lvl = Math.max(Math.abs(L[i]!), Math.abs(R[i]!));
      this.fast += (lvl - this.fast) * af;
      this.slow += (lvl - this.slow) * as;
      const up = Math.max(0, this.fast - this.slow) / (this.fast + 1e-6);
      const down = Math.max(0, this.slow - this.fast) / (this.slow + 1e-6);
      const want = clamp(1 + attack * up * 2 + sustain * down * 1.5, 0.05, 4);
      this.tg += (want - this.tg) * ag;
      L[i] = L[i]! * this.tg;
      R[i] = R[i]! * this.tg;
    }
    this.fast = flush(this.fast);
    this.slow = flush(this.slow);
  }

  reset(): void {
    for (const ch of this.eq) for (const b of ch) b.reset();
    this.fast = this.slow = 0;
    this.tg = 1;
    this.holdL = this.holdR = 0;
  }
}

// ---------------------------------------------------------------------------- bus
export class BusProcessor {
  cfg: BusFx = defaultBusFx();
  private hp = [new Svf(), new Svf()];
  private lp = [new Svf(), new Svf()];
  private env = 0; private gr = 0;
  /** the largest gain reduction since the last read, dB (positive) */
  reduction = 0;
  private key = '';

  set(cfg: BusFx): void {
    this.cfg = cfg;
    const k = `${cfg.filter.hp}|${cfg.filter.lp}`;
    if (k !== this.key) {
      this.key = k;
      for (const f of this.hp) f.set(cfg.filter.hp, 0.7);
      for (const f of this.lp) f.set(cfg.filter.lp, 0.7);
    }
  }

  get active(): boolean {
    return busFxActive(this.cfg);
  }

  process(L: Float32Array, R: Float32Array, n: number): void {
    const c = this.cfg;
    if (c.filter.on) {
      const useHp = c.filter.hp > 21;
      const useLp = c.filter.lp < 19000;
      for (let ch = 0; ch < 2; ch++) {
        const x = ch === 0 ? L : R;
        for (let i = 0; i < n; i++) {
          let v = x[i]!;
          if (useHp) v = this.hp[ch]!.run(v, true);
          if (useLp) v = this.lp[ch]!.run(v, false);
          x[i] = v;
        }
      }
    }
    if (c.dist.on) {
      const g = 1 + c.dist.drive * 7;
      const m = c.dist.mix;
      const shape = (x: number): number => {
        switch (c.dist.type) {
          case 'fold': {
            const y = x * g * 0.5;
            return Math.sin(y * Math.PI * 0.5) * 0.9;
          }
          case 'clip':
            return clamp(x * g, -1, 1) / Math.max(1, g * 0.35);
          default:
            return Math.tanh(x * g) / Math.tanh(g * 0.8);
        }
      };
      for (let i = 0; i < n; i++) {
        L[i] = L[i]! * (1 - m) + shape(L[i]!) * m;
        R[i] = R[i]! * (1 - m) + shape(R[i]!) * m;
      }
    }
    if (c.comp.on) this.compress(L, R, n);
    if (c.stereo.on && c.stereo.width !== 1) {
      const w = clamp(c.stereo.width, 0, 2);
      for (let i = 0; i < n; i++) {
        const m = (L[i]! + R[i]!) * 0.5;
        const s = (L[i]! - R[i]!) * 0.5 * w;
        L[i] = m + s;
        R[i] = m - s;
      }
    }
  }

  private compress(L: Float32Array, R: Float32Array, n: number): void {
    const { thresh, ratio, attack, release, makeup, mix } = this.cfg.comp;
    const aA = 1 - Math.exp(-1 / (Math.max(0.1, attack) * 0.001 * MIX_RATE));
    const aR = 1 - Math.exp(-1 / (Math.max(5, release) * 0.001 * MIX_RATE));
    const mk = db2lin(makeup);
    const slope = 1 - 1 / Math.max(1, ratio);
    for (let i = 0; i < n; i++) {
      const x = Math.max(Math.abs(L[i]!), Math.abs(R[i]!));
      this.env += (x - this.env) * (x > this.env ? aA : aR);
      const over = lin2db(this.env) - thresh;
      const target = over > 0 ? over * slope : 0;
      this.gr += (target - this.gr) * (target > this.gr ? aA : aR);
      if (this.gr > this.reduction) this.reduction = this.gr;
      const g = db2lin(-this.gr) * mk;
      L[i] = L[i]! * (1 - mix) + L[i]! * g * mix;
      R[i] = R[i]! * (1 - mix) + R[i]! * g * mix;
    }
    this.env = flush(this.env);
  }

  reset(): void {
    for (const f of [...this.hp, ...this.lp]) f.reset();
    this.env = this.gr = 0;
  }
}

// ---------------------------------------------------------------------------- master
export class MasterProcessor {
  private g = 1;
  /** the largest limiter gain reduction since the last read, dB */
  reduction = 0;

  /** Stereo width (M/S) in place; 1 leaves the signal untouched. */
  width(L: Float32Array, R: Float32Array, n: number, w: number): void {
    if (w === 1) return;
    const k = clamp(w, 0, 2);
    for (let i = 0; i < n; i++) {
      const m = (L[i]! + R[i]!) * 0.5;
      const s = (L[i]! - R[i]!) * 0.5 * k;
      L[i] = m + s;
      R[i] = m - s;
    }
  }

  /** A peak limiter with instant attack and a release time, then a hard clamp at the ceiling. */
  limit(L: Float32Array, R: Float32Array, n: number, ceilingDb: number, releaseMs: number): void {
    const ceil = db2lin(clamp(ceilingDb, -12, 0));
    const rel = 1 - Math.exp(-1 / (Math.max(5, releaseMs) * 0.001 * MIX_RATE));
    for (let i = 0; i < n; i++) {
      const peak = Math.max(Math.abs(L[i]!), Math.abs(R[i]!));
      const need = peak > ceil ? ceil / peak : 1;
      if (need < this.g) this.g = need;
      else this.g += (1 - this.g) * rel;
      const l = L[i]! * this.g;
      const r = R[i]! * this.g;
      L[i] = clamp(l, -ceil, ceil);
      R[i] = clamp(r, -ceil, ceil);
      const red = -lin2db(this.g);
      if (red > this.reduction) this.reduction = red;
    }
  }

  reset(): void {
    this.g = 1;
  }
}
