/**
 * The portable modulation document and capability checks.
 *
 * `{ format: "clatter-mod", version: 1, mod, patches? }` is what a preset file, a synth kit and a
 * hardware port exchange. A platform declares what it can execute (`Capabilities`);
 * `unsupported()` lists, by stable id, the parts of a configuration it cannot, so a port can warn,
 * degrade or skip them explicitly instead of failing silently. Browser CLATTER supports
 * everything (`FULL_CAPABILITIES`); the hardware port starts from whatever it can verify.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import { repairMod, repairPatch } from './config';
import { DESTS } from './registry';
import { LFO_WAVES, MOD_FORMAT, MOD_VERSION, SOURCE_IDS, typeOfSource, type LfoWave, type ModPatch, type SourceId, type TrackMod } from './types';

export interface Capabilities {
  sources: SourceId[];
  destinations: string[];
  lfoWaves: LfoWave[];
  maxRoutes: number;
  envelopes: { multi: boolean; maxPoints: number };
  customWaveform: boolean;
  /** control-rate update interval, in milliseconds */
  controlMs: number;
}

export const FULL_CAPABILITIES: Capabilities = {
  sources: [...SOURCE_IDS],
  destinations: DESTS.map((d) => d.id),
  lfoWaves: [...LFO_WAVES],
  maxRoutes: 32,
  envelopes: { multi: true, maxPoints: 8 },
  customWaveform: true,
  controlMs: 1.45,
};

export interface ModDocument {
  format: typeof MOD_FORMAT;
  version: number;
  name?: string;
  mod: TrackMod;
  /** variation overrides, slot "A".."D" */
  patches?: Record<string, ModPatch>;
}

export function exportMod(mod: TrackMod, name?: string, patches?: Record<string, ModPatch>): string {
  const doc: ModDocument = { format: MOD_FORMAT, version: MOD_VERSION, ...(name ? { name } : {}), mod, ...(patches && Object.keys(patches).length ? { patches } : {}) };
  return JSON.stringify(doc, null, 1);
}

export function importMod(text: string): ModDocument {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new Error('This file is not valid JSON.');
  }
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== 'object' || o.format !== MOD_FORMAT) throw new Error('This is not a CLATTER modulation file.');
  if (typeof o.version === 'number' && o.version > MOD_VERSION) throw new Error('This modulation was saved by a newer version of CLATTER.');
  const doc: ModDocument = { format: MOD_FORMAT, version: MOD_VERSION, mod: repairMod(o.mod) ?? { sources: {}, routes: [] } };
  if (typeof o.name === 'string') doc.name = o.name.slice(0, 24);
  if (o.patches && typeof o.patches === 'object') {
    const p: Record<string, ModPatch> = {};
    for (const [k, x] of Object.entries(o.patches as Record<string, unknown>)) {
      const r = repairPatch(x);
      if (r) p[k] = r;
    }
    if (Object.keys(p).length) doc.patches = p;
  }
  return doc;
}

export interface Unsupported {
  kind: 'source' | 'destination' | 'wave' | 'route-limit' | 'envelope' | 'custom-waveform';
  id: string;
  detail: string;
}

/** What a platform cannot run of a configuration, by stable id. */
export function unsupported(m: TrackMod, cap: Capabilities): Unsupported[] {
  const out: Unsupported[] = [];
  for (const [id, s] of Object.entries(m.sources) as [SourceId, NonNullable<TrackMod['sources'][SourceId]>][]) {
    if (!cap.sources.includes(id)) out.push({ kind: 'source', id, detail: `${typeOfSource(id)} source` });
    if (s.type === 'lfo') {
      if (!cap.lfoWaves.includes(s.wave)) out.push({ kind: 'wave', id, detail: s.wave });
      if (s.wave === 'custom' && !cap.customWaveform) out.push({ kind: 'custom-waveform', id, detail: 'custom waveform' });
    }
    if (s.type === 'env' && s.kind === 'multi' && (!cap.envelopes.multi || s.pts.length > cap.envelopes.maxPoints)) out.push({ kind: 'envelope', id, detail: 'multistage envelope' });
  }
  for (const r of m.routes) if (!cap.destinations.includes(r.dst)) out.push({ kind: 'destination', id: r.dst, detail: `route ${r.id}` });
  if (m.routes.length > cap.maxRoutes) out.push({ kind: 'route-limit', id: String(cap.maxRoutes), detail: `${m.routes.length} routes` });
  return out;
}

/** A configuration reduced to what a platform can run (unsupported parts removed, nothing else touched). */
export function reduceTo(m: TrackMod, cap: Capabilities): TrackMod {
  const out = JSON.parse(JSON.stringify(m)) as TrackMod;
  const bad = new Set(unsupported(m, cap).filter((u) => u.kind === 'source' || u.kind === 'wave' || u.kind === 'envelope' || u.kind === 'custom-waveform').map((u) => u.id));
  for (const id of bad) delete out.sources[id as SourceId];
  out.routes = out.routes.filter((r) => cap.destinations.includes(r.dst) && cap.sources.includes(r.src) && !bad.has(r.src)).slice(0, cap.maxRoutes);
  return out;
}
