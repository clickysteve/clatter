/**
 * Euclidean rhythms: k hits spread as evenly as possible over n steps (Bresenham form,
 * equivalent to Bjorklund up to rotation, normalised so the first hit is on step 0).
 *
 * From DOWNBEAT (src/extended/euclid.ts, https://github.com/clickysteve/downbeat),
 * Copyright (c) 2026 The DOWNBEAT contributors, MIT licence (see THIRD_PARTY_NOTICES.md).
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
export function euclid(steps: number, hits: number, rotation = 0): boolean[] {
  const n = Math.max(1, Math.floor(steps));
  const k = Math.max(0, Math.min(n, Math.floor(hits)));
  const out: boolean[] = new Array<boolean>(n).fill(false);
  if (k === 0) return out;
  for (let i = 0; i < n; i++) out[i] = (i * k) % n < k;
  const r = ((Math.floor(rotation) % n) + n) % n;
  if (!r) return out;
  return out.map((_, i) => out[(i - r + n) % n]!);
}
