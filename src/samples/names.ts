/**
 * Recognising drum samples from file names, and proposing which file goes on which track.
 *
 * Drum-machine sample packs name things every way: "606 Kick.wav", "BD0075.WAV", "TR606_CH.wav",
 * "Hats/Open/oh_02.wav", "Tom Low", "LT". The guess works on word-like tokens (split on
 * punctuation, camel case and letter/digit boundaries), a table of words and abbreviations with a
 * confidence each, and a few modifiers (open/closed, low/high). The folder names count too, a
 * little less than the file's own. Nothing here reads audio or touches the browser, so the same
 * logic serves a folder, a ZIP or any future source.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import { ROLES, type Role } from '../model/types';

/** A file offered for mapping. */
export interface FileRef {
  /** path inside the folder or archive, '/'-separated */
  path: string;
}

export const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
export const stem = (path: string): string => baseName(path).replace(/\.[a-z0-9]{1,5}$/i, '');

/** Lower-case word tokens: split on punctuation, camelCase and between letters and digits. */
export function tokens(s: string): string[] {
  return s
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-zA-Z])(\d)/g, '$1 $2')
    .replace(/(\d)([a-zA-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

type Scores = Partial<Record<Role, number>>;
const put = (m: Scores, role: Role, v: number): void => {
  if ((m[role] ?? 0) < v) m[role] = v;
};

/** words that name an instrument outright: word → [role, confidence] */
const WORDS: Record<string, [Role, number][]> = {
  kick: [['kick', 1]],
  kik: [['kick', 1]],
  kck: [['kick', 0.9]],
  bd: [['kick', 0.95]],
  bassdrum: [['kick', 1]],
  bdrum: [['kick', 0.9]],
  bass: [['kick', 0.5]],
  snare: [['snare', 1]],
  snaredrum: [['snare', 1]],
  snr: [['snare', 0.95]],
  sd: [['snare', 0.95]],
  sn: [['snare', 0.8]],
  clap: [['clap', 1]],
  claps: [['clap', 1]],
  handclap: [['clap', 1]],
  clp: [['clap', 0.95]],
  cp: [['clap', 0.9]],
  closedhat: [['chat', 1]],
  closedhihat: [['chat', 1]],
  chat: [['chat', 1]],
  chh: [['chat', 1]],
  hhc: [['chat', 1]],
  ch: [['chat', 0.9]],
  openhat: [['ohat', 1]],
  openhihat: [['ohat', 1]],
  ohat: [['ohat', 1]],
  ohh: [['ohat', 1]],
  hho: [['ohat', 1]],
  oh: [['ohat', 0.9]],
  hat: [['chat', 0.55]],
  hats: [['chat', 0.55]],
  hihat: [['chat', 0.55]],
  hihats: [['chat', 0.55]],
  hh: [['chat', 0.55]],
  closed: [['chat', 0.6]],
  open: [['ohat', 0.6]],
  lt: [['ltom', 0.95]],
  ltom: [['ltom', 1]],
  lowtom: [['ltom', 1]],
  lotom: [['ltom', 1]],
  floortom: [['ltom', 0.9]],
  ht: [['htom', 0.95]],
  htom: [['htom', 1]],
  hightom: [['htom', 1]],
  hitom: [['htom', 1]],
  mt: [['ltom', 0.5], ['htom', 0.5]],
  mtom: [['ltom', 0.5], ['htom', 0.5]],
  midtom: [['ltom', 0.5], ['htom', 0.5]],
  tom: [['ltom', 0.4], ['htom', 0.4]],
  toms: [['ltom', 0.4], ['htom', 0.4]],
  cymbal: [['cymbal', 1]],
  cymbals: [['cymbal', 1]],
  cym: [['cymbal', 1]],
  cymb: [['cymbal', 1]],
  cy: [['cymbal', 0.9]],
  crash: [['cymbal', 1]],
  ride: [['cymbal', 1]],
  cr: [['cymbal', 0.75]],
  rd: [['cymbal', 0.7]],
  perc: [['perc', 1]],
  percussion: [['perc', 1]],
  rim: [['perc', 0.6]],
  rimshot: [['perc', 0.65]],
  rs: [['perc', 0.6]],
  cowbell: [['perc', 1]],
  cb: [['perc', 0.7]],
  shaker: [['perc', 1]],
  tambourine: [['perc', 1]],
  tamb: [['perc', 1]],
  clave: [['perc', 1]],
  claves: [['perc', 1]],
  conga: [['perc', 0.85]],
  congas: [['perc', 0.85]],
  bongo: [['perc', 0.85]],
  wood: [['perc', 0.8]],
  woodblock: [['perc', 1]],
  maracas: [['perc', 1]],
  cabasa: [['perc', 1]],
  guiro: [['perc', 1]],
  triangle: [['perc', 0.9]],
  fx: [['fx', 1]],
  sfx: [['fx', 1]],
  effect: [['fx', 1]],
  effects: [['fx', 1]],
  noise: [['fx', 0.8]],
  zap: [['fx', 0.8]],
  sweep: [['fx', 0.8]],
  riser: [['fx', 0.9]],
  impact: [['fx', 0.8]],
};

const CLOSED = new Set(['closed', 'close', 'cl', 'c', 'shut', 'tight', 'pedal']);
const OPEN = new Set(['open', 'op', 'o', 'long', 'loose']);
const LOW = new Set(['low', 'lo', 'l', 'floor', 'big', 'large', 'lg']);
const HIGH = new Set(['high', 'hi', 'h', 'small', 'sm', 'rack']);
const MID = new Set(['mid', 'med', 'md', 'm']);

/** The roles a token list could be, with a confidence 0-1 each. */
function scoreTokens(toks: string[]): Scores {
  const m: Scores = {};
  const set = new Set(toks);
  // words, and adjacent pairs and triples joined ("closed" "hat" → "closedhat")
  const grams: string[] = [...toks];
  for (let i = 0; i + 1 < toks.length; i++) grams.push(toks[i]! + toks[i + 1]!);
  for (let i = 0; i + 2 < toks.length; i++) grams.push(toks[i]! + toks[i + 1]! + toks[i + 2]!);
  for (const g of grams) for (const [role, v] of WORDS[g] ?? (g.length > 3 && g.endsWith('s') ? WORDS[g.slice(0, -1)] : undefined) ?? []) put(m, role, v);

  const hat = set.has('hat') || set.has('hats') || set.has('hihat') || set.has('hh');
  if (hat) {
    if (toks.some((t) => CLOSED.has(t))) put(m, 'chat', 0.95);
    if (toks.some((t) => OPEN.has(t))) {
      put(m, 'ohat', 0.95);
      if (!toks.some((t) => CLOSED.has(t))) m.chat = Math.min(m.chat ?? 0, 0.2);
    }
  }
  const tom = set.has('tom') || set.has('toms');
  if (tom) {
    const lo = toks.some((t) => LOW.has(t));
    const hi = toks.some((t) => HIGH.has(t));
    const mid = toks.some((t) => MID.has(t));
    if (lo && !hi) {
      put(m, 'ltom', 1);
      m.htom = Math.min(m.htom ?? 0, 0.2);
    } else if (hi && !lo) {
      put(m, 'htom', 1);
      m.ltom = Math.min(m.ltom ?? 0, 0.2);
    } else if (mid) {
      put(m, 'ltom', 0.5);
      put(m, 'htom', 0.5);
    }
  }
  // "bass drum": "drum" alone says nothing, but "bass" + "drum" is a kick
  if (set.has('bass') && set.has('drum')) put(m, 'kick', 1);
  if (set.has('snare') || set.has('sn')) m.perc = Math.min(m.perc ?? 0, 0.3);
  return m;
}

/**
 * How likely a path is each CLATTER role (0-1). The file's own name counts fully, the folders it
 * sits in at 0.8 (so "Kicks/01.wav" is a kick, and "606/Open/hat.wav" an open hat).
 */
export function guessRoles(path: string): Scores {
  const parts = path.split('/').filter(Boolean);
  const file = tokens(stem(path));
  const own = scoreTokens(file);
  const all: string[] = [];
  for (const d of parts.slice(0, -1)) all.push(...tokens(d));
  const inherited = scoreTokens([...all, ...file]);
  const out: Scores = { ...own };
  for (const r of ROLES) {
    const v = (inherited[r] ?? 0) * (own[r] === undefined && Object.keys(own).length ? 0.7 : 0.8);
    if (v > (out[r] ?? 0)) out[r] = v;
  }
  return out;
}

/** The best guess for a path, or null when nothing was recognised. */
export function bestRole(path: string): { role: Role; score: number } | null {
  let best: { role: Role; score: number } | null = null;
  for (const [r, v] of Object.entries(guessRoles(path)) as [Role, number][]) if (!best || v > best.score) best = { role: r, score: v };
  return best && best.score >= MIN_CANDIDATE ? best : null;
}

/** below this a file is not offered for a role at all */
export const MIN_CANDIDATE = 0.35;
/** below this a file is not picked automatically (it is still offered) */
export const MIN_AUTO = 0.5;

export interface Proposal {
  /** the file proposed for each role (an index into the files), or null */
  pick: Record<Role, number | null>;
  /** every file that could be that role, best first */
  candidates: Record<Role, { file: number; score: number }[]>;
  /** roles where several files fit about equally well, so the choice was a tie-break */
  ambiguous: Role[];
  /** files used by no role */
  unused: number[];
}

const natural = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const depth = (p: string): number => p.split('/').length;

/**
 * Propose which file plays which role. Each role gets at most one file and each file at most one
 * role; the most confident pairs are settled first. Ties (several kicks) go to the shallowest
 * folder, then the shortest name, then natural order ("kick 1" before "kick 2"), so the result
 * is the same on every run. `roles` limits the roles considered (default all ten).
 */
export function proposeMapping(files: FileRef[], roles: readonly Role[] = ROLES): Proposal {
  const scores = files.map((f) => guessRoles(f.path));
  const rank = (a: number, b: number): number => depth(files[a]!.path) - depth(files[b]!.path) || baseName(files[a]!.path).length - baseName(files[b]!.path).length || natural.compare(files[a]!.path, files[b]!.path);
  const pick = Object.fromEntries(ROLES.map((r) => [r, null])) as Record<Role, number | null>;
  const candidates = Object.fromEntries(ROLES.map((r) => [r, [] as { file: number; score: number }[]])) as Proposal['candidates'];
  for (const r of roles) {
    for (let i = 0; i < files.length; i++) {
      const s = scores[i]![r] ?? 0;
      if (s >= MIN_CANDIDATE) candidates[r].push({ file: i, score: s });
    }
    candidates[r].sort((a, b) => b.score - a.score || rank(a.file, b.file));
  }
  const pairs: { role: Role; file: number; score: number }[] = [];
  for (const r of roles) for (const c of candidates[r]) if (c.score >= MIN_AUTO) pairs.push({ role: r, ...c });
  pairs.sort((a, b) => b.score - a.score || rank(a.file, b.file) || ROLES.indexOf(a.role) - ROLES.indexOf(b.role));
  const used = new Set<number>();
  for (const p of pairs) {
    if (pick[p.role] !== null || used.has(p.file)) continue;
    pick[p.role] = p.file;
    used.add(p.file);
  }
  const ambiguous = roles.filter((r) => {
    const c = candidates[r].filter((x) => !used.has(x.file) || x.file === pick[r]);
    return pick[r] !== null && c.length > 1 && c[1]!.score >= c[0]!.score - 0.05;
  });
  return { pick, candidates, ambiguous, unused: files.map((_, i) => i).filter((i) => !used.has(i)) };
}

/** A set name from the folder or archive it came from ("TR-606 Samples.zip" → "TR-606 SAMPLES"). */
export function setNameFrom(source: string): string {
  const base = source.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? '';
  const n = base.replace(/(\.kit)?\.[a-z0-9]{1,5}$/i, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return (n || 'SAMPLE SET').toUpperCase().slice(0, 24);
}
