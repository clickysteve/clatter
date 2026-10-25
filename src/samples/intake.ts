/**
 * Collecting audio files from a folder or a ZIP archive, for mapping onto tracks.
 *
 * Nothing is decoded or stored here: a candidate is a path and a way to read its bytes (a File
 * is read lazily; a ZIP entry is already in memory). Metadata files, hidden files and macOS
 * resource forks are ignored, nested folders are kept as paths, and archives are read with
 * Slop Factory Core's limited ZIP reader, so a hostile archive cannot expand without bound.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import { readZip, ZipLimitError, type ZipEntry } from '@slopfactory/core/export';

export const AUDIO_EXT = /\.(wav|wave|aif|aiff|aifc|flac|mp3|ogg|oga|opus|m4a)$/i;
export const AUDIO_ACCEPT = 'audio/*,.wav,.aif,.aiff,.mp3,.ogg,.flac,.m4a';

/** Limits for archives of drum samples (a big kit is a few hundred MB at most). */
export const INTAKE_LIMITS = { maxEntries: 5000, maxEntryBytes: 64 * 1024 * 1024, maxTotalBytes: 768 * 1024 * 1024 };
/** most audio files offered from one folder or archive */
export const MAX_CANDIDATES = 1000;

export interface Candidate {
  /** path inside the folder or archive, '/'-separated, relative */
  path: string;
  size: number;
  type: string;
  bytes(): Promise<ArrayBuffer>;
}

export interface Intake {
  /** the folder's or archive's own name */
  source: string;
  candidates: Candidate[];
  /** files skipped: not audio, hidden or metadata */
  ignored: number;
  /** more audio files than MAX_CANDIDATES were found; the rest were left out */
  truncated: boolean;
}

/** Files that are never samples whatever their extension (metadata and operating-system litter). */
export function isJunk(path: string): boolean {
  const parts = path.split('/');
  const base = parts[parts.length - 1] ?? '';
  return parts.some((p) => p === '__MACOSX' || p === '.git') || base.startsWith('.') || base.startsWith('._') || /^(thumbs\.db|desktop\.ini)$/i.test(base);
}

/** A path that stays inside the folder: no '..', no drive or leading slash. */
export function cleanPath(p: string): string | null {
  const s = p.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!s || s.startsWith('/') || /^[a-z]:/i.test(s)) return null;
  const parts = s.split('/').filter((x) => x !== '' && x !== '.');
  return parts.length && !parts.includes('..') ? parts.join('/') : null;
}

/** The folder every path sits in, when there is exactly one ("TR-606/Kick.wav" and friends). */
function commonRoot(paths: string[]): string {
  const first = paths[0]?.split('/') ?? [];
  return first.length > 1 && paths.every((p) => p.startsWith(first[0] + '/')) ? first[0]! : '';
}

function finish(source: string, all: Candidate[], ignored: number, rootNamesSet: boolean): Intake {
  const root = commonRoot(all.filter((c) => !isJunk(c.path)).map((c) => c.path));
  if (root) {
    for (const c of all) if (c.path.startsWith(root + '/')) c.path = c.path.slice(root.length + 1);
    if (rootNamesSet) source = root;
  }
  const found = all.filter((c) => !isJunk(c.path) && AUDIO_EXT.test(c.path));
  found.sort((a, b) => a.path.localeCompare(b.path, 'en', { numeric: true }));
  return { source, candidates: found.slice(0, MAX_CANDIDATES), ignored: ignored + (all.length - found.length), truncated: found.length > MAX_CANDIDATES };
}

/** The audio files of a folder chosen with a directory input (`webkitRelativePath`) or of loose files. */
export function intakeFromFiles(files: File[]): Intake {
  const rel = (f: File): string => cleanPath((f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name) ?? f.name;
  // the chosen folder's own name leaves the paths: the set is named after it instead
  const all: Candidate[] = files.map((f) => ({ path: rel(f), size: f.size, type: f.type, bytes: () => f.arrayBuffer() }));
  return finish('SAMPLES', all, 0, true);
}

/** Read a ZIP archive within the intake limits. Throws with a message for the user. */
export async function readArchive(bytes: Uint8Array): Promise<ZipEntry[]> {
  try {
    return await readZip(bytes, INTAKE_LIMITS);
  } catch (e) {
    if (e instanceof ZipLimitError) throw new Error(`This archive is too large to import (${e.message}).`);
    throw new Error('This is not a readable ZIP archive.');
  }
}

/** The audio files of a ZIP archive (nested folders kept as paths). Throws with a message for the user. */
export async function intakeFromZip(bytes: Uint8Array, name: string): Promise<Intake> {
  return intakeFromEntries(await readArchive(bytes), name);
}

export function intakeFromEntries(entries: ZipEntry[], name: string): Intake {
  const all: Candidate[] = [];
  let ignored = 0;
  for (const e of entries) {
    const path = cleanPath(e.name);
    if (!path || e.name.endsWith('/')) {
      ignored++;
      continue;
    }
    const data = e.data;
    all.push({ path, size: data.byteLength, type: '', bytes: async () => data.slice().buffer });
  }
  return finish(name, all, ignored, false);
}
