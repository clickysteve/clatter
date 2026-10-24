import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { LxrEngine } from '../src/audio/lxr/lxr';

let mod: WebAssembly.Module | null = null;

/** The committed WebAssembly build of the LXR engine. */
export function lxrModule(): WebAssembly.Module {
  if (!mod) mod = new WebAssembly.Module(readFileSync(resolve(__dirname, '../src/audio/lxr/lxr.wasm')));
  return mod;
}

export function newLxr(seed = 1): LxrEngine {
  return LxrEngine.fromModule(lxrModule(), seed);
}

export function stats(x: ArrayLike<number>) {
  let peak = 0;
  let sum = 0;
  let last = -1;
  let finite = true;
  for (let i = 0; i < x.length; i++) {
    const v = x[i]!;
    if (!Number.isFinite(v)) finite = false;
    const a = Math.abs(v);
    if (a > peak) peak = a;
    sum += v * v;
    if (a > 1e-3) last = i;
  }
  return { peak, rms: Math.sqrt(sum / Math.max(1, x.length)), last, finite };
}

export function zeroCrossings(x: ArrayLike<number>, from = 0, to = x.length): number {
  let n = 0;
  for (let i = from + 1; i < to; i++) if (x[i - 1]! < 0 !== x[i]! < 0) n++;
  return n;
}

/** The bundled demonstration samples, loaded from public/samples as the browser would. */
export async function bundledLibrary(): Promise<import('../src/audio/library').SampleLibrary> {
  const { SampleLibrary } = await import('../src/audio/library');
  const lib = new SampleLibrary(null);
  const root = resolve(__dirname, '../public/');
  await lib.loadBundled('/', async (url) => {
    const bytes = readFileSync(resolve(root, url.replace(/^\//, '')));
    return new Response(bytes);
  });
  return lib;
}

/** A factory preset as the application builds it at start-up (kit checked in the engine). */
export async function presetProject(id: string, lib: import('../src/audio/library').SampleLibrary) {
  const { PRESETS, buildPreset, resolveBundled } = await import('../src/model/presets');
  const { checkKit, readKit } = await import('../src/sound/kitcheck');
  const { voiceRolesOf } = await import('../src/sound/kitgen');
  const spec = PRESETS.find((p) => p.id === id)!;
  const e = newLxr(1);
  const init = readKit(e);
  const p = buildPreset(spec, init);
  const ids = new Map(lib.list().map((s) => [s.name.toLowerCase(), s.id]));
  resolveBundled(p, (f) => ids.get(f.replace(/\.wav$/i, '').toLowerCase()));
  p.kit.synth = checkKit(newLxr(1), p.kit.synth, { flavour: spec.flavour, voiceRoles: voiceRolesOf(p.tracks), seed: spec.kitSeed, locked: p.soundLocks.voices }).kit;
  return p;
}
