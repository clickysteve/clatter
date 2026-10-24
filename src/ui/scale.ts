/**
 * Interface scale: the one place that decides how big things are.
 *
 * The interface is laid out in real pixels. A single factor (default 90 %, set from the VIEW menu
 * and kept in the preferences) multiplies every scale-dependent dimension:
 *
 *   - `--s` and `--px` (one scaled CSS pixel) for the stylesheet: `calc(24 * var(--px))`;
 *   - the named tokens below (type sizes, control heights, gaps), rounded to whole pixels so that
 *     borders and the pixel typefaces stay crisp, as custom properties on the root element;
 *   - `sz()` and `font()` for code that draws or measures (the pattern grid's canvas);
 *   - `lt-NNN` classes on the root element for the layout breakpoints, in unscaled "logical"
 *     pixels (viewport width / scale), so a layout at 125 % re-flows as on a narrower window.
 *
 * Fixed values stay fixed on purpose: hairlines, 1 to 2 px borders, dither patterns, the
 * minimum hit target (`HIT_MIN`) and canvas details that are already whole-pixel art.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */

/** The choices in VIEW, smallest first. */
export const SCALES = [0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2] as const;
export const DEFAULT_SCALE = 0.9;

/** No control is smaller than this in either direction, at any scale (CSS pixels). */
export const HIT_MIN = 24;

/** Layout breakpoints (logical pixels): the root element gets `lt-<n>` while the logical width is below n. */
export const BREAKPOINTS = [700, 900, 1100, 1300, 1500, 1700] as const;

/** The root element gets `short` while the logical height is below this (secondary hints drop out). */
export const SHORT_HEIGHT = 760;

/** Unscaled sizes (CSS pixels at 100 %) of the named tokens. Type first, then controls. */
const TOKENS: Record<string, number> = {
  fs: 16, // Tiny5: labels, buttons, values (2x its 8 px grid at 100 %)
  'fs-2': 18, // VT323: secondary text
  'fs-prose': 15.5, // IBM Plex Sans: dialogs and help
  'fs-tip': 14.5, // tooltips
  'fs-lg': 24, // dialog headings, pads, big buttons
  'fs-code': 14,
  u: 2, // the "pixel unit": frames, control borders, drop shadows
  'ctl-h': 32,
  'ctl-h-sm': 28,
  'ctl-h-med': 44,
  gap: 8,
  pad: 12,
  'label-w': 112,
};

let current = DEFAULT_SCALE;
const listeners = new Set<(s: number) => void>();

/** The nearest offered scale; anything unusable gives the default. */
export function snapScale(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULT_SCALE;
  return SCALES.reduce((best, s) => (Math.abs(s - v) < Math.abs(best - v) ? s : best), SCALES[0] as number);
}

export const getScale = (): number => current;

/** A length scaled and rounded to whole pixels (never below 1). */
export const sz = (base: number): number => Math.max(1, Math.round(base * current));

/** A type size scaled and rounded to whole pixels. */
export const font = (base: number): number => Math.max(1, Math.round(base * current));

/** A control dimension: scaled, but never below the minimum hit target. */
export const hit = (base: number): number => Math.max(HIT_MIN, sz(base));

/** The viewport width in unscaled pixels (what a breakpoint compares against). */
export const logicalWidth = (): number => window.innerWidth / current;

function applyBreakpoints(): void {
  document.documentElement.classList.toggle('short', window.innerHeight / current < SHORT_HEIGHT);
  const w = logicalWidth();
  for (const b of BREAKPOINTS) document.documentElement.classList.toggle(`lt-${b}`, w < b);
}

/** Write the factor and every token to the root element. */
function apply(): void {
  const r = document.documentElement;
  r.style.setProperty('--s', String(current));
  r.style.setProperty('--px', `${current}px`);
  for (const [name, base] of Object.entries(TOKENS)) r.style.setProperty(`--${name}`, `${name.startsWith('fs') ? font(base) : sz(base)}px`);
  r.dataset.scale = String(Math.round(current * 100));
  applyBreakpoints();
}

/** Set the scale (snapped to an offered one), apply it and tell the listeners. Returns the scale in force. */
export function setScale(v: number): number {
  const next = snapScale(v);
  if (next === current && document.documentElement.dataset.scale) return current;
  current = next;
  apply();
  for (const f of listeners) f(current);
  return current;
}

/** Start-up: apply the saved scale before anything is built, and follow the window's width. */
export function initScale(v: unknown): void {
  current = snapScale(v);
  apply();
  window.addEventListener('resize', applyBreakpoints);
}

/** Call back when the scale changes (the grid redraws, popups close). */
export function onScale(f: (s: number) => void): void {
  listeners.add(f);
}

export const scaleLabel = (s: number): string => `${Math.round(s * 100)}%`;

/** A CSS length that follows the scale (for inline styles): `cpx(10)` is ten scaled pixels. */
export const cpx = (n: number): string => `calc(${n} * var(--px))`;
