/**
 * How much a measured sound is like an instrument: a score 0-1 per profile from the features
 * analysis.ts measures (fundamental, length, spectral centroid, low-frequency share, noisiness,
 * high-frequency sustain). Each criterion is a band with soft edges; the score is their product,
 * so one badly missed criterion (a "kick" with no low end) sinks it.
 *
 * The bands are the conventional ranges of electronic drums, wide on purpose: the judge only has
 * to tell a kick from something that is not one, not choose a favourite kick.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import type { SoundFeatures } from './analysis';
import type { Profile } from './profiles';

/** 1 inside [lo, hi], falling to 0 over `soft` (a fraction of the band, at least 1 unit) outside. */
export function band(x: number, lo: number, hi: number, soft = 0.5): number {
  const w = Math.max(1e-6, (hi - lo) * soft, lo * soft * 0.5);
  if (x < lo) return Math.max(0, 1 - (lo - x) / w);
  if (x > hi) return Math.max(0, 1 - (x - hi) / w);
  return 1;
}

/** A log-frequency band (pitches, centroids). */
const fband = (hz: number, lo: number, hi: number, soft = 0.6) => (hz <= 0 ? 0 : band(Math.log2(hz), Math.log2(lo), Math.log2(hi), soft));

/**
 * The score of a sound as a profile. `open` is the open-hat trigger's sound when a hat voice plays
 * both hats (the closed one must be closed and the open one open).
 */
export function judge(profile: Profile, f: SoundFeatures, open?: SoundFeatures): number {
  if (f.peak < 0.01 || f.lengthMs < 10) return 0;
  // an unpitched (or sweeping) body counts half: the low end and the length still have to be right
  const pitch = (lo: number, hi: number) => (f.f0 > 0 ? 0.25 + 0.75 * fband(f.f0, lo, hi) : 0.55);
  switch (profile) {
    case 'kick':
      return pitch(30, 130) * band(f.lowRatio, 0.45, 1, 0.12) * band(f.lengthMs, 90, 900) * fband(f.centroid, 25, 900) * band(f.hfSustain, 0, 0.15, 1);
    case 'ltom':
      return pitch(55, 190) * band(f.lengthMs, 110, 900) * fband(f.centroid, 40, 1400) * band(f.flatness, 0, 0.3, 1);
    case 'htom':
      return pitch(95, 360) * band(f.lengthMs, 80, 700) * fband(f.centroid, 60, 2200) * band(f.flatness, 0, 0.3, 1);
    case 'snare':
      return band(f.flatness, 0.22, 1, 0.12) * fband(f.centroid, 1000, 9000, 0.3) * band(f.lengthMs, 70, 520) * band(f.lowRatio, 0, 0.35, 1);
    case 'clap':
      return band(f.flatness, 0.22, 1, 0.12) * fband(f.centroid, 800, 7500, 0.3) * band(f.lengthMs, 60, 520) * band(f.lowRatio, 0, 0.2, 1);
    case 'chat': {
      const c = fband(f.centroid, 3800, 20000) * band(f.lengthMs, 12, 220) * band(f.lowRatio, 0, 0.05, 2) * band(f.flatness, 0.12, 1, 1);
      if (!open) return c;
      return c * fband(open.centroid, 3500, 20000) * band(open.lengthMs, Math.max(150, f.lengthMs * 1.6), 1600);
    }
    case 'ohat':
      return fband(f.centroid, 3500, 20000) * band(f.lengthMs, 160, 1600) * band(f.lowRatio, 0, 0.05, 2) * band(f.flatness, 0.12, 1, 1);
    case 'cymbal':
      return fband(f.centroid, 3000, 20000) * band(f.lengthMs, 450, 4000) * band(f.flatness, 0.12, 1, 1) * band(f.lowRatio, 0, 0.05, 2);
    case 'perc':
      return band(f.lengthMs, 15, 650);
    default:
      return 1;
  }
}
