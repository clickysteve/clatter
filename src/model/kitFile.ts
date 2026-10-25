/**
 * Kit files (.clatterkit.zip): a complete sound kit. The LXR synthesis kit (every sound
 * parameter and the modulation targets) and each track's source (SYNTH / SAMPLE / HYBRID,
 * trigger, sample settings), keyed by track role so a kit maps onto any project, with the
 * samples' audio inside (Slop Factory Core's stored ZIP).
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import { createZip, readZip } from '@slopfactory/core/export';
import type { StoredSample } from '@slopfactory/core/storage';
import { clone, type Kit, type Project, type SynthKit, type TrackSound } from './types';
import { repairKit } from './project';

export const KIT_FORMAT = 'clatter-kit';
export const KIT_EXT = '.clatterkit.zip';

interface KitJson {
  format: typeof KIT_FORMAT;
  version: 1;
  name: string;
  seed: number;
  synth: SynthKit;
  /** per track role */
  sounds: Record<string, TrackSound>;
  samples: { id: string; name: string; file: string }[];
}

export function kitOf(p: Project): Kit {
  const sounds: Record<string, TrackSound> = {};
  for (const t of p.tracks) if (!(t.role in sounds)) sounds[t.role] = clone(t.sound);
  return { name: p.kit.name, seed: p.kit.seed, synth: p.kit.synth, sounds };
}

export function writeKitFile(kit: Kit, samples: StoredSample[]): Uint8Array {
  const enc = new TextEncoder();
  const files = samples.map((s, i) => ({ s, file: `samples/${String(i + 1).padStart(2, '0')}-${s.id.slice(0, 12)}.wav` }));
  const json: KitJson = { format: KIT_FORMAT, version: 1, name: kit.name, seed: kit.seed, synth: kit.synth, sounds: kit.sounds, samples: files.map(({ s, file }) => ({ id: s.id, name: s.name, file })) };
  return createZip([{ name: 'kit.json', data: enc.encode(JSON.stringify(json, null, 1)) }, ...files.map(({ s, file }) => ({ name: file, data: new Uint8Array(s.bytes) }))]);
}

export interface ReadKitResult {
  kit: Kit;
  samples: { id: string; name: string; bytes: ArrayBuffer }[];
}

export async function readKitFile(bytes: Uint8Array): Promise<ReadKitResult> {
  const entries = await readZip(bytes, { maxEntries: 200, maxEntryBytes: 64 * 1024 * 1024, maxTotalBytes: 256 * 1024 * 1024 });
  const main = entries.find((e) => e.name === 'kit.json');
  if (!main) throw new Error('This is not a CLATTER kit (no kit.json).');
  const v = JSON.parse(new TextDecoder().decode(main.data)) as Partial<KitJson>;
  if (v.format !== KIT_FORMAT) throw new Error('This is not a CLATTER kit.');
  const samples: ReadKitResult['samples'] = [];
  for (const s of v.samples ?? []) {
    const e = entries.find((x) => x.name === s.file);
    if (e) samples.push({ id: s.id, name: s.name, bytes: e.data.slice().buffer });
  }
  return { kit: { name: String(v.name ?? 'KIT').slice(0, 24), seed: Number(v.seed) || 0, synth: repairKit(v.synth), sounds: (v.sounds ?? {}) as Record<string, TrackSound> }, samples };
}
