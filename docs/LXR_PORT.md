# The LXR-02 synthesis engine in CLATTER

CLATTER's synthesised drums are the sound engine of the **Erica Synths LXR-02** firmware,
compiled to WebAssembly and run in an AudioWorklet. This document says exactly what was taken,
what was changed, how it is built and how it was checked.

CLATTER is an independent project. It is **not** an Erica Synths product and is not endorsed
by Erica Synths. It contains a **modified version** of the firmware's sound engine (GPL-3.0
section 7(c)); see [Licence](#licence).

## Source

| | |
|---|---|
| Repository | <https://github.com/erica-synths/lxr-desktop-app> |
| Revision | `a43cd4fcda23ec3d577dc425261c3eb28bd5abff` (recorded in `lxr/upstream/UPSTREAM_REVISION`) |
| Firmware | `LXR_V2_STM32F765/` (the LXR-02 firmware for the STM32F765) |
| Licence | GPL-3.0-only with additional terms under section 7 (`lxr/upstream/LICENSE`, `lxr/upstream/NOTICE.md`) |
| Copyright | © 2012-2026 Erica Synths |

`lxr/tools/import-upstream.sh /path/to/lxr-desktop-app` copies the files below into
`lxr/upstream/`. **Every imported file is byte-identical to upstream**; CLATTER's changes live
beside them, never inside them.

## What was taken

70 firmware files plus the licence and notice:

- **Voices**: `DrumVoice` (the three FM drum voices), `Snare`, `CymbalVoice`, `HiHat` (closed
  and open triggers on one voice).
- **Their building blocks**: `Oscillator`, `wavetable`, `SlopeEg2`, `Decay`, `snapEg`,
  `transientGenerator` and `transientTables` (the sampled attack clicks), `ResonantFilter`,
  `1PoleLp`, `distortion`, `lfo`, `modulationNode`, `automationNode`, `random`, `dither`,
  `BufferTools`, `squareRootLut`, `mixer` (block rendering, decimation).
- **The FX bus**: `FxBus` with `Distortion`, `Ringmod`, `Compressor`, `Delay` and the
  `FxRamBuffer` (half-precision delay memory).
- **Parameters**: `Parameters.h`, `ParameterArray`, `valueShaper`, `MidiMessages.h`, and
  `MidiParser.c` (only as the source of the parameter handler, below).
- **The init kit**: `Preset/initKit.c` (the factory starting values of every parameter).
- **Configuration**: `config.h` (both), `datatypes.h`, `globals.h`.

### What was not taken

The sequencer, menu and LCD, front panel and encoders, USB, the MIDI ports and parser, the
audio codec and DMA drivers, the bootloader, the STM32 HAL, CMSIS and every other
STMicroelectronics or third-party component. The **reverb** is not included: the firmware
compiles it out (`USE_REVERB 0`). The LXR hardware design is not part of the firmware licence
and nothing of it is used.

## How it runs

```
CLATTER (TypeScript)                       LXR engine (WebAssembly, lxr.wasm)
--------------------------------------     -----------------------------------------------
ClatterEngine (src/audio/engine.ts)        clatter_lxr.c       the WebAssembly interface
  per 64-sample block:                       clatter_set_param   -> midiParser_ccHandler
    apply hits for this block   ---------->  clatter_trigger(_locked) -> the voice triggers
    render the six voices       ---------->  clatter_render_block    -> mixer.c's order
    mix voices into tracks                   clatter_voice_out       <- six stereo buffers
    (+ samples, HYBRID, mixer)
    FX-routed tracks            ---------->  clatter_fx_process      -> FxBus_process
    master, output chain                     clatter_fx_out          <- FX return
```

- **Blocks.** The engine renders `OUTPUT_DMA_SIZE` = 64 samples at a time, the firmware's
  block. Triggers take effect at block starts (1.45 ms), as on the hardware.
- **Voices.** `clatter_render_block` runs the firmware's per-block sequence (modulation
  reset, LFOs, filter coefficients, each voice's asynchronous part, then each voice's samples
  and its decimator) exactly as `mixer.c` does, but writes each voice to its own stereo buffer
  with the voice's own pan (computed by the firmware when the voice is triggered) instead of
  summing onto the DACs. CLATTER's mixer then has separate tracks, solo, stems and routing.
- **Parameters.** Every value goes through the firmware's own `midiParser_ccHandler`, so a
  value means exactly what it means on the hardware (exponential cutoff, decay curves, menus,
  LFO sync, FX parameters per FX type). Parameter numbers are the firmware's `PAR_*` numbers
  (`src/sound/lxrParamIds.ts` is generated from `Parameters.h`).
- **Modulation.** The LFO and velocity targets are the firmware's modulation nodes.
- **Per-hit locks** (CRUSH in DESTROY) use the firmware's `AutomationNode`, the mechanism the
  LXR sequencer uses for step automation: set for one hit, restored afterwards.
- **FX bus.** The firmware's FX bus (OFF, DRIVE, RING, COMP, DELAY) processes whatever CLATTER
  routes to it (a track's FX switch in the mixer, as the LXR routes a voice to FX).
- **Kits.** A kit is the 0-127 value of every sound parameter plus the six LFO and six velocity
  targets, the same data an LXR kit holds. New projects start from the firmware's init kit.

## What CLATTER changed, and why

All changes are in CLATTER's own files (`lxr/shim/`, `lxr/bridge/`), none in `lxr/upstream/`.

| Change | Where | Why |
|---|---|---|
| HAL and CMSIS headers replaced | `lxr/shim/stm32f7xx_hal.h`, `stm32f7xx.h` | The DSP includes the HAL for integer types and the Cortex-M7 DSP intrinsics. CLATTER re-implements the intrinsics it uses (QADD16, QSUB16, SADD16, PKHBT, SSAT, USAT, QADD, QSUB, SMLALD, CLZ) bit-exactly from the ARMv7E-M reference manual in portable C. No ST or Arm code. |
| Hardware RNG | `clatter_lxr.c` | `HAL_RNG_GetRandomNumber` becomes a seeded xorshift32, so a render is identical every time (export, tests). Noise is noise either way. |
| Fader ADCs | `clatter_lxr.c` | `adc_getFaderVolume` returns 1 (faders up). CLATTER's mixer sets the levels. |
| Menu, front panel, sequencer, codec headers | `lxr/shim/` | Minimal declarations so the DSP compiles; nothing in them makes sound. `seq_getBpm` returns CLATTER's tempo (LFO sync). |
| C library | `lxr/bridge/libm.c`, `lxr/shim/libc/` | The build is freestanding: `expf`, `logf`, `powf`, `tanhf`, `sinf`, `cosf`, `fmodf`, `memset`/`memcpy`/`memmove` and IEEE half-float conversion (the FX buffer is `__fp16`) are implemented by CLATTER. |
| Parameter handler | `lxr/bridge/lxr_params.c`, generated by `lxr/tools/extract-params.py` | The handler is copied verbatim from `MidiParser.c` with three edits: hardware includes (UART, USB, clock sync, CortexParser) removed; the sequencer track-mute cases do nothing; the FX type case no longer switches the LCD menu page. |
| Per-voice output | `clatter_lxr.c` (`clatter_render_block`) | Adapted from `mixer.c`: same order of operations, one stereo buffer per voice instead of the DAC mix. |
| FX bus input | `clatter_lxr.c` (`clatter_fx_process`) | CLATTER fills the FX bus input with the tracks routed to it (samples included), then runs `FxBus_process`. |

## Known differences from the hardware

- **Sample rate.** The firmware computes everything for `REAL_FS` = 44 140 Hz (the codec clock
  the STM32 can make). CLATTER runs the same code at 44 100 Hz, so everything plays 0.09 %
  slower: pitches 1.6 cents flat, envelopes 0.09 % longer. Inaudible in practice, and kept
  deliberately: changing `REAL_FS` would mean modifying the firmware. If the browser's audio
  cannot run at 44.1 kHz, CLATTER resamples its 44.1 kHz output to the device rate (Catmull-Rom).
- **Floating point.** WebAssembly single precision is IEEE-754 like the Cortex-M7's FPU, and
  both builds use `-ffast-math`, but the compilers order and contract operations differently
  and the transcendental functions differ in their last bits. Output is therefore not
  bit-identical to a hardware recording, though the integer intrinsics are reproduced exactly.
- **Float to integer.** `-mnontrapping-fptoint` makes conversions saturate, as the Cortex-M7's
  `VCVT` does, instead of trapping.
- **Voice mixing.** On the hardware the six voices sum onto two DACs with the output routing
  menu; in CLATTER each voice goes to the CLATTER track(s) that play it. Two tracks on the same
  voice share it (monophonic, the later hit takes over), as on the hardware.
- **Not included:** reverb (disabled in the firmware), the sequencer and its parameter locks
  (CLATTER has its own sequencer; it uses the automation node only for CRUSH), morphing between
  kits, the audio inputs.

## Build

```
node scripts/build-lxr.mjs           # writes src/audio/lxr/lxr.wasm
node scripts/build-lxr.mjs --check   # rebuilds into a temporary file and compares
```

Requirements: clang and wasm-ld (LLVM 15 or newer with the wasm32 target; built and checked
with Ubuntu clang 18.1.3). No Emscripten and no C library. Flags: `--target=wasm32 -O3
-ffast-math -freciprocal-math -mnontrapping-fptoint -mbulk-memory -ffreestanding -fno-builtin
-nostdlib`; 4 MB of fixed memory, 256 KB of stack, no imports. The 30 firmware `.c` files
(all imported sources except `MidiParser.c`) and CLATTER's three bridge files compile to
`lxr.wasm` (about 222 KB, 103 KB gzipped).

The committed `lxr.wasm` is what `npm run build` bundles locally. The deployment workflow
rebuilds it from source before testing and building the site, so the published page always
runs an engine built from the published source, and warns if the committed binary differs.

## Verification

`test/dsp.test.ts` runs the compiled engine in Node and checks, among other things: the
firmware geometry (6 voices, 64-sample blocks, 247 parameters); silence until triggered; that
the kick's pitch falls (pitch envelope) and follows the note number; that decay, volume,
coarse tune and drive change the sound as they should; velocity response; closed and open hat
on one voice with different decays; per-hit locks that apply for one hit and return; LFO
modulation; several voices at once; determinism for a seed; long-run stability (no NaN, no
runaway); and the FX bus delay. `test/kitgen.test.ts` checks that generated kits are audible
and level-matched through the real engine. The engine costs about 2 % of one core in real time
for all six voices and the FX bus (measured in Node).

## Licence

The firmware is licensed under the GNU General Public License version 3 only, with an
additional permission and additional terms under section 7 (`lxr/upstream/NOTICE.md`). CLATTER
as a whole is therefore distributed under GPL-3.0-only with the same additional terms:

- **Trademarks (7(e)).** "Erica Synths", "LXR" and "LXR-02" are Erica Synths' trademarks.
  CLATTER uses the names only to state truthfully where its synthesis comes from, uses none of
  Erica Synths' logos, and does not suggest it comes from, is approved by or is affiliated with
  Erica Synths.
- **Marking (7(c)).** CLATTER is a modified version: its interface, About box, README and this
  document say so, and it is never presented as official Erica Synths software.

The complete corresponding source of the published site (CLATTER's code, the imported firmware
files, the shims, the bridge and the build scripts) is this repository, and the About box names
the commit the page was built from. See [NOTICE.md](../NOTICE.md) and
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
