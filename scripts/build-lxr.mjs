#!/usr/bin/env node
/**
 * Builds the LXR synthesis engine (lxr/) into WebAssembly: src/audio/lxr/lxr.wasm.
 *
 * Plain clang with the wasm32 target and wasm-ld (LLVM 15 or newer; no Emscripten, no C
 * library: lxr/shim and lxr/bridge/libm.c provide the little the DSP needs). The flags follow
 * the firmware's own build (-O3 -ffast-math -freciprocal-math, IEEE half floats for the FX
 * buffer); -mnontrapping-fptoint makes float-to-integer conversions saturate as the
 * Cortex-M7's VCVT does instead of trapping.
 *
 *   node scripts/build-lxr.mjs            build
 *   node scripts/build-lxr.mjs --check    build into a temporary file and fail if it differs
 *                                         from the committed one
 * Environment: CLANG (default clang), LXR_WASM_OUT.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, mkdirSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lxr = join(root, 'lxr');
const clang = process.env.CLANG || 'clang';
const check = process.argv.includes('--check');
const outFile = process.env.LXR_WASM_OUT || join(root, 'src/audio/lxr/lxr.wasm');

/** Every .c file under a directory. */
function sources(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (name.endsWith('.c')) out.push(p);
  }
  return out;
}

const UPSTREAM_SKIP = new Set(['MidiParser.c']); // only its handler is used: bridge/lxr_params.c
const files = [
  ...sources(join(lxr, 'upstream/Core/Src')).filter((f) => !UPSTREAM_SKIP.has(f.split('/').pop())),
  ...sources(join(lxr, 'bridge')),
];

const common = [
  '--target=wasm32',
  '-O3',
  '-ffast-math',
  '-freciprocal-math',
  '-mnontrapping-fptoint',
  '-mbulk-memory',
  '-ffreestanding',
  '-fno-builtin',
  '-nostdlib',
  '-w',
  '-I', join(lxr, 'shim'),
  '-I', join(lxr, 'shim/libc'),
  '-I', join(lxr, 'upstream/Core/Inc'),
];
const link = [
  '-Wl,--no-entry',
  '-Wl,--strip-all',
  '-Wl,-z,stack-size=262144',
  '-Wl,--initial-memory=4194304',
  '-Wl,--max-memory=4194304',
];

const tmp = mkdtempSync(join(tmpdir(), 'clatter-lxr-'));
const target = check ? join(tmp, 'lxr.wasm') : outFile;
mkdirSync(dirname(target), { recursive: true });
execFileSync(clang, [...common, ...link, ...files, '-o', target], { stdio: 'inherit' });
const bytes = readFileSync(target);
console.log(`lxr.wasm: ${bytes.length} bytes from ${files.length} C files`);
if (check) {
  if (!existsSync(outFile) || !readFileSync(outFile).equals(bytes)) {
    console.error('lxr.wasm differs from the committed build: run node scripts/build-lxr.mjs');
    process.exit(1);
  }
  console.log('lxr.wasm matches the committed build');
}
