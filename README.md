# CLATTER

**Generative drum synthesis and rhythmic destruction**, in the browser. Generate a rhythm,
generate a kit, mutate both, chop and destroy what plays, perform it.

CLATTER is a Slop Factory drum workstation built from three systems that stay independent:

- **RHYTHM**: generative patterns in eleven styles (seeded, so a seed always gives the same
  pattern), variation and mutation, per-track density, fills, chance and polymetric length, and a
  full step editor (velocity, probability, pitch, ratchets, flams, per-hit samples) whose hand
  edits survive regeneration. Rhythm intelligence after DOWNBEAT.
- **SOUND**: the drum voices, envelopes, filters, modulation, decimation and FX bus of the
  **Erica Synths LXR-02**'s open-source firmware, compiled to WebAssembly and running in an
  AudioWorklet. Every track is SYNTH, SAMPLE or HYBRID (an LXR voice and a sample together,
  aligned). GENERATE KIT designs a kit for the style and checks every voice in the engine;
  MUTATE KIT, MUTATE VOICE, LOCK VOICE / PARAMETER and EVOLVE change it in controlled ways.
- **DESTRUCTION**: CHOP, ROLLS, DESTROY and WILDCARD (after The Breakery) transform each cycle
  of what plays, seeded and non-destructive: switch them off and the written pattern returns.

And: a mixer with meters, FX routing and Slop Factory output processing; a PERFORM view with
quantised pads, fills, mutes, macros and snapshots; Web MIDI (notes and clock in and out,
recording, panic); export of the master, stems, a MIDI file, every drum hit and the kit; project
files, bundles with samples, sample sets (import a folder or ZIP of drum samples, save, load, export), synth kits and full kits (`docs/SAMPLE_SETS.md`), undo for everything, eight factory presets, and the
Slop Factory's 1-bit look with its palettes (Classic, Dark, Colour, your own).

> CLATTER is an independent project. It is **not** an Erica Synths product and is not endorsed by
> Erica Synths. It contains a modified version of the LXR-02 firmware's sound engine.
> "Erica Synths", "LXR" and "LXR-02" are trademarks of Erica Synths.

## Use

Open the site (or run it locally, below) in a current Chrome, Edge, Firefox or Safari. Press
**SPACE** to play. **G** generates a pattern, **K** a kit, **W** plays the wildcard; **?** lists
every key. Projects autosave in the browser; FILE saves them as files.

Views: **PATTERN** (the grid and its step editor; generator, transformation toolbar, track and
edit panels under it; **? KEY** explains the grid), **SOUND** (a track sidebar
and SYNTH, SAMPLE, MODULATION, MIXER and KIT & FX tabs; variations A-D per track), the **STEP SOUND**
tab of PATTERN (per-step variations, parameter locks, conditions, voice switching, generators), **PERFORM** (pads, patterns,
snapshots, mutes, macros). Factory presets: MACHINE ROOM, BROKEN CLOCK, METALLIC WEATHER, DUSTY
BREAKS, DIGITAL DETRITUS, INDUSTRIAL ESTATE, WRONG ANSWERS, AFTER HOURS.

## Build and run

Node 22 or newer.

```
npm ci
npm run dev          # http://localhost:5231
npm run build        # dist/ (static site, relative paths)
npm test             # unit tests (the real WebAssembly engine in Node)
npm run build && npx playwright test   # browser tests (Chromium)
```

The LXR engine (`src/audio/lxr/lxr.wasm`) is committed. To rebuild it from the C sources you
need clang and wasm-ld (LLVM 15+; checked with clang 18):

```
npm run build:lxr    # rebuild
npm run check:lxr    # rebuild and compare with the committed binary
```

## Deployment

`.github/workflows/pages.yml` type-checks, rebuilds the engine from source, runs the unit and
browser tests and builds every push; pushes to `main` are deployed to GitHub Pages. The custom
domain `clatter.allmyfriendsaresynths.com` is set by the `CNAME` file, which the workflow copies
into the site. For it to serve, the repository's Pages source must be set to **GitHub Actions**
and the domain needs a DNS `CNAME` record pointing to `clickysteve.github.io`. Because asset
paths are relative, the same build also works at `https://clickysteve.github.io/clatter/`.

## Documentation

- [docs/LXR_PORT.md](docs/LXR_PORT.md): what was taken from the LXR firmware, what changed, how
  it is built and checked, and how it differs from the hardware.
- [docs/STEP_SOUND.md](docs/STEP_SOUND.md): variations, step sounds, locks and conditions on the
  LXR engine: inheritance, the musical clock, generators, limits (voices, MIDI).
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): the three systems, the engine, timing, state,
  files and tests.

## Licence

CLATTER is free software under the **GNU General Public License version 3 only**
([LICENSE](LICENSE)), with the LXR firmware's additional terms under GPL-3.0 section 7
(trademarks; modified versions marked as modified): see [NOTICE.md](NOTICE.md). It reuses
MIT-licensed code from DOWNBEAT, The Breakery and Slop Factory Core and bundles OFL-licensed
fonts: see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The demonstration samples are
CLATTER's own (CC0).

This repository is the complete corresponding source of the published site; its About box links
the commit it was built from, and the licence texts are published with it.
