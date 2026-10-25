# CLATTER architecture

CLATTER is three systems that stay independent and meet only through small, explicit data:

```
        RHYTHM                         DESTRUCTION                      SOUND
  what is played                 how it is transformed              what makes the sound
  ----------------------         ------------------------           --------------------------
  styles, generate,              CHOP, ROLLS, DESTROY,              LXR kit (247 firmware
  mutate, variation,             WILDCARD: seeded layers            parameters + mod targets),
  pattern = baseline             over the realised events           track sources (SYNTH,
  + hand edits, per-track        (never over the written            SAMPLE, HYBRID), samples,
  density/fill/chance/length     pattern)                           mixer, FX bus, master
            \                          |                                 /
             \______ Sequence (realise a cycle → PerfEvents) ___________/
                                       |
                    Scheduler (look-ahead, one clock for audio, MIDI and export)
                                       |
             AudioWorklet: ClatterEngine (LXR WebAssembly + samples + mixer)
```

A hit belongs to a **track**; the track decides what sounds. The rhythm never names a sound
and the sound never knows which algorithm made a hit. A kit can change under a pattern, and a
pattern can play any kit.

## Source layout

| Directory | What |
|---|---|
| `lxr/` | The LXR firmware files (unchanged), CLATTER's shims and WebAssembly bridge, import and extraction tools. See [LXR_PORT.md](LXR_PORT.md). |
| `scripts/` | `build-lxr.mjs` (the WebAssembly build), `make-samples.mjs` (the bundled demonstration samples). |
| `src/audio/` | `lxr/lxr.ts` (the engine's TypeScript face), `engine.ts` (ClatterEngine: voices, samples, HYBRID, mixer, FX bus, master, meters, stems), `worklet.ts` and `host.ts` (the AudioWorklet and its main-thread side), `resample.ts`, `render.ts` (offline render), `library.ts` (samples). |
| `src/model/` | Types, defaults, project files (serialise, defensive repair), presets, kit files. |
| `src/rhythm/` | Seeded randomness, Euclid, styles, generation, mutation, pattern editing, realisation. |
| `src/destruction/` | CHOP, ROLLS, DESTROY, WILDCARD. |
| `src/sound/` | LXR parameter tables, the kit designer (generate, mutate, evolve), the kit check (in a Worker). |
| `src/transport/` | The look-ahead scheduler and its Worker ticker. |
| `src/midi/` | Web MIDI, messages, Standard MIDI Files (after DOWNBEAT), the controller (ports, clock in/out, notes in/out, panic). |
| `src/export/` | The MIDI file of the performance. |
| `src/app/` | The application: every action on the project, history, the sequence, sound configuration, preferences. |
| `src/ui/` | The interface (real-pixel layout, one interface scale in `scale.ts`, see [UI_REDESIGN.md](UI_REDESIGN.md)): widgets, the pattern grid (`grid.ts`, with `gridModel.ts` deciding what each cell shows), views, menus, dialogs, tooltips, keys, palettes. |
| `test/`, `e2e/` | Unit tests (Vitest, Node, the real WebAssembly engine) and browser tests (Playwright). |

## Rhythm

- **Determinism.** Every random choice is a keyed hash (`src/rhythm/rng.ts`, after DOWNBEAT):
  `rand(seed, salt, ...keys)`. The same seed and settings always give the same pattern; a
  change to one setting changes only what depends on it.
- **Patterns** are a generated **baseline** per track plus **hand edits** (step → hit, or a
  deletion). GENERATE, VARIATION, MUTATE and REGENERATE replace the baseline; hand edits stay
  anchored to their steps and win. KEEP bakes edits into the baseline; RESET drops them.
  Locked tracks are left alone by generation and mutation.
- **Realisation** (`realize.ts`): each cycle of a pattern turns into concrete `PerfEvent`s:
  probability, per-track density (weak metric positions drop first), fills into gaps, chance,
  humanise, ratchets and flams, swing, polymetric track lengths, and rhythm evolution. Each cycle
  has its own seed, so a pattern varies from cycle to cycle but cycle *k* is always the same.
- **Cells flags** record what each cycle did (suppressed, added, destroyed, moved, evolved).
  The grid (`src/ui/gridModel.ts`) turns the realisation into what it draws: a block where
  something sounds, an outline where a written hit stays silent, nothing elsewhere.

## Destruction

CHOP, ROLLS and DESTROY are pure functions `events → events` applied, in that order, to each
realised cycle. They read the settings, a seed and a take number (RE-CHOP / RE-ROLL / RE-DO
increment the take). Nothing is written back to the pattern: switching a layer off restores the
written rhythm exactly. DESTROY never touches hand-edited hits. WILDCARD changes settings (style
parameters, layer settings, swing, sometimes the kit) in one undoable step, within bounds. The
ideas and the rules come from The Breakery; the implementations are CLATTER's, on events rather
than audio.

## Sound

- **Tracks** (ten by default) each have a source: SYNTH (one of the LXR's seven triggers),
  SAMPLE (one or several samples, chosen per hit by order, cycle, chance, velocity or a per-hit
  choice) or HYBRID (both, with their own levels and an alignment offset). Choke groups cut
  tracks against each other.
- **The kit designer** (`kitgen.ts`) writes LXR parameter values from archetypes (kick, tom,
  perc, zap, snare, clap, hat, cymbal) and the style's flavour. **The kit check**
  (`kitcheck.ts`, in a Worker with its own engine instance) triggers every voice, measures it,
  redesigns inaudible voices and level-matches the rest before the kit is used. MUTATE moves
  unlocked parameters a bounded amount; EVOLVE drifts the kit while playing, deterministically,
  never further than a limit from where it started, and KIT HOME returns.
- **Locks.** Voices and individual parameters can be locked against generation, mutation and
  evolution.
- **Variations and step sounds** (`sound/stepSound.ts`, `sound/soundgen.ts`). A track has up to four
  sparse variations (A-D) of its base sound; a step may name one, a condition, another voice,
  parameter locks and rules. `resolveStepSound` is a pure function (kit → track → variation →
  step locks → rules) run once per hit in `app/soundConfig.ts` (`hitOf`); the hit carries the
  resulting `(param, value)` pairs to the engine, which sets them just before the trigger and
  restores the kit values at that voice's next hit. Randomness is keyed-hash based, so playback and
  export agree. See [STEP_SOUND.md](STEP_SOUND.md).

## The engine

`ClatterEngine` is plain TypeScript with no browser APIs, used **identically** in the
AudioWorklet (live) and in offline rendering (export, tests). Per 64-sample block it applies
the hits due in the block, renders the six LXR voices, routes each voice into the tracks that
play it, plays sample voices (linear interpolation, short fades for regions and reverse),
applies each track's gain, pan, one-knob filter, mute and solo, sends FX-routed tracks through
the LXR FX bus, then the master (Slop Factory Core's output chain, soft clipper) and the meters.
Events carry sample frame times; the engine never reads the clock.

## Timing

The scheduler (`src/transport/scheduler.ts`) asks the sequence for a cycle's events and sends
them to the worklet a fixed look-ahead (120 ms) before they are due, stamped in AudioContext
time; a Worker ticker keeps it running when the tab is in the background. Tempo changes
re-anchor at the planning horizon. Pattern switches, PERFORM actions and snapshots are queued to
a boundary (step, beat, bar or the end of the pattern). MIDI notes and clock use the same event
times converted to `performance.now()` time. Offline export drives the same scheduler with a
fake clock, so an export plays exactly what playback would have.

## State, undo and files

The project is one plain object. Every action goes through `App` (`src/app/app.ts`), which
records undo history (whole-document snapshots; a drag is one step), replans the scheduler,
updates the engine with only what changed, autosaves to local storage, and notifies the views
by topic. Project files are JSON (`.clatter.json`) or a ZIP bundle with the samples
(`.clatter.zip`); kits are `.clatterkit.zip`. Loading repairs anything damaged instead of
failing (`src/model/project.ts`). Samples are content-addressed (SHA-256) and stored in
IndexedDB (Slop Factory Core's storage).

## Slop Factory Core

CLATTER uses Core (MIT, pinned to a commit in `package.json`) for palettes and the palette
editor, sample decoding and waveform peaks, sample storage and project bundles, WAV and ZIP
writing, the output engine chain on the master, and the MIDI port and clock-follower
interfaces. Nothing from the LXR firmware is in Core, and CLATTER does not change Core.

## Tests

- `test/dsp.test.ts`: the compiled LXR engine (see LXR_PORT.md).
- `test/engine.test.ts`: tracks, samples, HYBRID levels and alignment, choke, routing, timing.
- `test/kitgen.test.ts`: kit generation, mutation, evolution, locks, audibility and levels.
- `test/rhythm.test.ts`: generation, determinism, styles, mutation, editing, realisation.
- `test/destruction.test.ts`: CHOP, ROLLS, DESTROY, WILDCARD.
- `test/scheduler.test.ts`: look-ahead, tempo changes, boundaries, MIDI clock.
- `test/project.test.ts`: files round-trip and repair, presets, kit files, history.
- `test/export.test.ts`: deterministic offline renders, stems that sum to the master, WAV,
  drum hits, the MIDI file.
- `test/gridmodel.test.ts`: what the grid shows is what plays (sounding, silent, added, deleted
  cells; beat and bar structure from the resolution).
- `e2e/app.spec.ts` (Playwright, Chromium): start-up and audio, grid hit-testing, editing by
  click, drag and right-click, cell boundaries and the SHOW ORIGINAL overlay, sideways scrolling,
  type sizes and overflow at 1920 × 1080, 1440 × 900 and 1366 × 768, palette legibility,
  generation, kits, HYBRID with a sample, project save and open, WAV and MIDI export.
