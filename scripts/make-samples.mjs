#!/usr/bin/env node
/**
 * Synthesises CLATTER's bundled demonstration samples (public/samples/*.wav and index.json).
 *
 * Every sound is made here from noise, oscillators, envelopes and filters: no recordings, no
 * third-party sample material. They are CLATTER's own and dedicated to the public domain
 * (CC0 1.0), see public/samples/README.md. Deterministic: running it again writes identical files.
 *
 *   node scripts/make-samples.mjs
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 * (this script); the generated audio: CC0-1.0.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RATE = 44100;
const out = resolve(dirname(fileURLToPath(import.meta.url)), '../public/samples');
mkdirSync(out, { recursive: true });

let seed = 0x1234567;
const noise = () => {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return ((seed >>> 0) / 4294967296) * 2 - 1;
};
const buf = (secs) => new Float32Array(Math.round(secs * RATE));
const env = (i, a, d) => {
  const t = i / RATE;
  return t < a ? t / a : Math.exp(-(t - a) / d);
};

/** State-variable filter over a buffer (mode: lp, bp, hp). */
function svf(x, freq, q, mode) {
  let lo = 0;
  let bp = 0;
  const f = 2 * Math.sin((Math.PI * Math.min(freq, RATE / 6)) / RATE);
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    lo += f * bp;
    const hi = x[i] - lo - q * bp;
    bp += f * hi;
    out[i] = mode === 'lp' ? lo : mode === 'bp' ? bp : hi;
  }
  return out;
}

const sat = (x, d) => Math.tanh(x * d) / Math.tanh(d);
function normalise(x, peak = 0.89) {
  let m = 0;
  for (const v of x) m = Math.max(m, Math.abs(v));
  if (m > 0) for (let i = 0; i < x.length; i++) x[i] = (x[i] / m) * peak;
  // 2 ms fade-out at the end
  const f = Math.min(x.length, 88);
  for (let i = 0; i < f; i++) x[x.length - 1 - i] *= i / f;
  return x;
}
function crush(x, bits, hold) {
  const q = Math.pow(2, bits - 1);
  let h = 0;
  for (let i = 0; i < x.length; i++) {
    if (i % hold === 0) h = Math.round(x[i] * q) / q;
    x[i] = h;
  }
  return x;
}

const SOUNDS = {
  'clap-dusty': ['clap', () => {
    const x = buf(0.32);
    for (let i = 0; i < x.length; i++) {
      const t = i / RATE;
      let e = 0;
      for (const o of [0, 0.011, 0.021]) if (t >= o) e = Math.max(e, Math.exp(-(t - o) / 0.006));
      e = Math.max(e, t > 0.03 ? Math.exp(-(t - 0.03) / 0.09) * 0.55 : 0);
      x[i] = noise() * e;
    }
    const y = svf(x, 1150, 0.6, 'bp');
    return normalise(crush(y.map((v) => sat(v, 3)), 10, 2));
  }],
  'clap-tight': ['clap', () => {
    const x = buf(0.2);
    for (let i = 0; i < x.length; i++) {
      const t = i / RATE;
      let e = 0;
      for (const o of [0, 0.008, 0.015]) if (t >= o) e = Math.max(e, Math.exp(-(t - o) / 0.004));
      e = Math.max(e, t > 0.02 ? Math.exp(-(t - 0.02) / 0.05) * 0.5 : 0);
      x[i] = noise() * e;
    }
    return normalise(svf(svf(x, 1600, 0.8, 'bp'), 600, 1, 'hp'));
  }],
  rim: ['perc', () => {
    const x = buf(0.08);
    for (let i = 0; i < x.length; i++) x[i] = (Math.sin((2 * Math.PI * 1720 * i) / RATE) * 0.7 + Math.sin((2 * Math.PI * 520 * i) / RATE) * 0.5 + noise() * 0.4 * env(i, 0, 0.002)) * env(i, 0.0005, 0.012);
    return normalise(x.map((v) => sat(v, 2)));
  }],
  shaker: ['perc', () => {
    const x = buf(0.14);
    for (let i = 0; i < x.length; i++) {
      const t = i / RATE;
      x[i] = noise() * (Math.exp(-Math.pow((t - 0.03) / 0.018, 2)) + 0.6 * Math.exp(-Math.pow((t - 0.08) / 0.015, 2)));
    }
    return normalise(svf(x, 5200, 0.7, 'hp'));
  }],
  cowbell: ['perc', () => {
    const x = buf(0.3);
    for (let i = 0; i < x.length; i++) {
      const sq = (f) => (Math.sin((2 * Math.PI * f * i) / RATE) > 0 ? 1 : -1);
      x[i] = (sq(540) + sq(800)) * (0.7 * env(i, 0.0005, 0.02) + 0.3 * env(i, 0.0005, 0.12));
    }
    return normalise(svf(x, 900, 0.5, 'bp'));
  }],
  conga: ['perc', () => {
    const x = buf(0.32);
    let ph = 0;
    for (let i = 0; i < x.length; i++) {
      const f = 230 + 90 * Math.exp(-i / (RATE * 0.01));
      ph += (2 * Math.PI * f) / RATE;
      x[i] = Math.sin(ph) * env(i, 0.001, 0.09) + noise() * 0.3 * env(i, 0, 0.003);
    }
    return normalise(x);
  }],
  tambourine: ['perc', () => {
    const x = buf(0.28);
    const parts = [5300, 6750, 7900, 9200, 10700];
    for (let i = 0; i < x.length; i++) {
      let s = 0;
      for (const p of parts) s += Math.sin((2 * Math.PI * p * i) / RATE + p);
      x[i] = (s * 0.15 + noise() * 0.6) * env(i, 0.002, 0.06) * (1 + 0.5 * Math.sin((2 * Math.PI * 23 * i) / RATE));
    }
    return normalise(svf(x, 4000, 0.7, 'hp'));
  }],
  'kick-dusty': ['kick', () => {
    const x = buf(0.4);
    let ph = 0;
    for (let i = 0; i < x.length; i++) {
      const f = 52 + 120 * Math.exp(-i / (RATE * 0.025));
      ph += (2 * Math.PI * f) / RATE;
      x[i] = sat(Math.sin(ph) * env(i, 0.001, 0.13) * 1.4 + noise() * 0.5 * env(i, 0, 0.002), 2.5);
    }
    return normalise(crush(svf(x, 5000, 0.8, 'lp'), 12, 2));
  }],
  'snare-crack': ['snare', () => {
    const x = buf(0.3);
    let ph = 0;
    for (let i = 0; i < x.length; i++) {
      ph += (2 * Math.PI * (185 + 60 * Math.exp(-i / (RATE * 0.01)))) / RATE;
      x[i] = Math.sin(ph) * env(i, 0.001, 0.05) * 0.7 + noise() * env(i, 0.001, 0.08);
    }
    return normalise(svf(x, 300, 0.8, 'hp').map((v) => sat(v, 1.8)));
  }],
  'metal-clank': ['fx', () => {
    const x = buf(0.6);
    const fs = [312, 427, 691, 1093, 1611];
    for (let i = 0; i < x.length; i++) {
      let s = 0;
      fs.forEach((f, k) => (s += Math.sin((2 * Math.PI * f * i) / RATE) * Math.exp(-i / (RATE * (0.25 - k * 0.035)))));
      x[i] = s * (noise() * 0.15 + 0.85) + noise() * env(i, 0, 0.004);
    }
    return normalise(x.map((v) => sat(v, 1.5)));
  }],
  zap: ['fx', () => {
    const x = buf(0.2);
    let ph = 0;
    for (let i = 0; i < x.length; i++) {
      ph += (2 * Math.PI * (80 + 3200 * Math.exp(-i / (RATE * 0.02)))) / RATE;
      x[i] = (Math.sin(ph) > 0 ? 1 : -1) * env(i, 0.0005, 0.05);
    }
    return normalise(svf(x, 4000, 0.6, 'lp'));
  }],
  'noise-hit': ['fx', () => {
    const x = buf(0.35);
    for (let i = 0; i < x.length; i++) x[i] = noise() * env(i, 0.001, 0.08);
    return normalise(crush(svf(x, 2500, 0.3, 'bp'), 5, 6));
  }],
  'glass-tick': ['chat', () => {
    const x = buf(0.06);
    for (let i = 0; i < x.length; i++) x[i] = (Math.sin((2 * Math.PI * 7300 * i) / RATE) + noise() * 0.6) * env(i, 0, 0.006);
    return normalise(svf(x, 6000, 0.7, 'hp'));
  }],
  'hat-dusty': ['chat', () => {
    const x = buf(0.12);
    for (let i = 0; i < x.length; i++) x[i] = noise() * env(i, 0.0005, 0.02);
    return normalise(crush(svf(x, 7000, 0.5, 'hp'), 9, 2));
  }],
  'tom-skin': ['ltom', () => {
    const x = buf(0.5);
    let ph = 0;
    for (let i = 0; i < x.length; i++) {
      ph += (2 * Math.PI * (110 + 40 * Math.exp(-i / (RATE * 0.04)))) / RATE;
      x[i] = Math.sin(ph) * env(i, 0.001, 0.16) + svfNoise(i) * env(i, 0, 0.01);
    }
    return normalise(x);
  }],
};
function svfNoise() {
  return noise() * 0.4;
}

function wav16(x) {
  const n = x.length;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + n * 2, 4);
  b.write('WAVE', 8);
  b.write('fmt ', 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(RATE, 24);
  b.writeUInt32LE(RATE * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767))), 44 + i * 2);
  return b;
}

const index = [];
for (const [name, [role, make]] of Object.entries(SOUNDS)) {
  const file = `${name}.wav`;
  writeFileSync(join(out, file), wav16(make()));
  index.push({ file, name: name.toUpperCase(), role });
}
writeFileSync(join(out, 'index.json'), JSON.stringify(index, null, 2) + '\n');
console.log(`wrote ${index.length} samples to public/samples`);
