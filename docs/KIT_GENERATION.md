# Kit generation

GENERATE KIT, MUTATE KIT / MUTATE VOICE and SOUND > DISCOVER all design LXR voices with one generator (`src/sound/kitgen.ts`). It is not a second engine: it was extended to understand the audio it makes.

## Controls

CHARACTER and WILDNESS are on SOUND > KITS and SOUND > DISCOVER and are the same two settings in both places.

- **CHARACTER** is one of the six kit flavours: MACHINE, ELECTRO, ACOUSTIC, INDUSTRIAL, GLITCH, DUB, or STYLE (the flavour of the rhythm style). The names were kept because projects and prefs refer to them. Rough equivalents of the names in the brief: Classic = MACHINE, Analog = ELECTRO, Minimal = ACOUSTIC (dry, plain), Industrial = INDUSTRIAL, Digital = GLITCH. Experimental is WILDNESS turned up, in any CHARACTER. DUB has no counterpart in the brief.
- **WILDNESS** (5 to 100 %) is how strictly a voice follows its instrument.

The same seed, CHARACTER and WILDNESS make the same kit. A generated kit records them (`kit.made`, project version 9); a loaded kit has none.

## How a voice is made

1. **Recipe.** Each instrument (kick, tom, perc, zap, snare, clap, hat, cymbal) has ranges and menu choices for the LXR parameters. Each CHARACTER replaces some of them (`FLAVOUR_TUNING`): a MACHINE kick is a clean sine with a short sweep, an ELECTRO kick long and round, an INDUSTRIAL kick FM and drive, a GLITCH kick a crushed click with an extreme sweep, a DUB kick deep and slow.
2. **WILDNESS shapes the draw.** Low: a narrow core of each range and the usual menu choices, few LFOs, little FM and decimation. Medium: the recipe as written. High: ranges up to 1.9 times wider, every waveform and transient open, a chance (up to 45 %) of designing the voice as another instrument, and swells, pitch sirens, envelope rolls and odd slopes. Drive, resonance and volume are not widened: wild is different, not louder or harsher. Levels are matched afterwards at every WILDNESS.
3. **Candidates.** The engine check (`checkKit`, in the kit worker) renders 5 designs of each voice (the generator's own plus 4 more from the same seed; for MUTATE the plain mutation plus 4 more of the same kit). Parameter combinations known to give nothing (filter shut over the voice, volume too low) are thrown away before rendering.
4. **Analysis** (`src/analysis/voiceAnalysis.ts`) of each render: peak, RMS, silence, clipping, DC, attack, decay (-20 and -60 dB), length, tail, transient strength, spectral centroid, low / mid / high energy, tonality, noise, flatness, zero-crossing pitch at attack and body, pitch movement and stability. About a millisecond per render; it runs in the worker, never in the audio callback. The slow YIN tracker is used only in reports.
5. **Scoring** (`src/sound/voiceScore.ts`). Each instrument has tendencies as soft ranges (a kick has low-frequency body, a closed hat is short and bright, an open hat is longer, a snare has a transient and noise). Score = safety x ((1-k) x convention + k x interest), with k = 0.7 x WILDNESS squared. Convention tolerance also widens with WILDNESS. Safety (silent, non-finite, DC offset, drone, click-only, runaway level) never relaxes. The voice 5 hat is judged as closed and open.
6. **Kit contrast.** The best candidates of all voices are re-picked a little (within 0.15 of each voice's best) to reduce the sum of pairwise similarity: toms alike, hats alike, hats against cymbal, clap against snare, everything against the kick.
7. **Repair and levels** as before: silent voices are redesigned, volumes are set per instrument.

Locks hold: locked voices and locked parameters are never redesigned, selected or overwritten (`lockedParams`). Nothing runs unless the player presses a generate or mutate control.

DISCOVER candidates use the same generator at the candidate's WILDNESS and the same safety check; they are not chosen among alternatives, because they are blends with the current sound.

## Engine determinism

The LXR cymbal keeps some state across `init()`, so a reused engine renders it slightly differently each time (peak varies by about 0.02 % and flips integer volume steps). The kit check therefore uses a new engine instance per check (under 1 ms). Anything that compares renders should do the same.

## Evaluating it

`npm run eval:kits` (development only, not part of the app or `npm test`) generates 1008 kits (6 CHARACTERs x 4 WILDNESS levels x 42 seeds, 2/3 kick-toms-snare layout, 1/3 perc-fx-clap), renders every instrument with the real engine, analyses it and writes JSON. `KITS=120` runs a sample, `WAV=dir` writes one example kit per CHARACTER and WILDNESS. `npm run eval:report` makes the before/after table. Results: `docs/eval/baseline.json`, `docs/eval/after.json`, `docs/eval/REPORT.md`, example WAVs in `docs/eval/wav-*`.

### Findings (1008 kits, 7056 sounds each)

Problems found in the old generator:
- **Snares were mostly tonal.** 69 % did not look like snares; median centroid 351 Hz and 22 % noise. Cause: the noise mix only dominates above about 100, and low-pass filters under cutoff 100 shut it away.
- **The two toms were one pitch.** Same recipe, median centroid 156 Hz for both; 10.7 % of kits had indistinguishable toms; 36 % of high toms did not sound high.
- **Cymbals and glitch hats** missed their instrument 25 % and 37 to 38 % of the time.
- **WILDNESS did nothing** for GENERATE KIT (it existed only in DISCOVER) and CHARACTER mostly changed multipliers.
- Kit levels, silence and clipping were already fine (0 % silent or clipped).

Results (details in REPORT.md): snares that look like snares 31 % to 96 % at low WILDNESS; high toms 64 % to 100 %; toms too alike 10.7 % to 0.1 %; kit sameness 0.91 to 0.50; CHARACTER separation 0.99 to 1.17; WILDNESS separation 0 to 1.55; kick decay spread at WILDNESS 100 % is 1.3 octaves against 1.0 at 10 %, and kick centroid spread 2.3 against 0.4 octaves. At 10 % WILDNESS 96 to 100 % of every instrument fits its convention; at 100 % only 35 to 92 % do, by design. Unsafe sounds: 0.2 % of closed hats and 0.1 % of cymbals (a very short click at WILDNESS 100 %).
MUTATE: at WILDNESS 10 to 40 % mutated sounds that fit their instrument go 91 % to 100 %, and they move further (0.27 to 0.38 octaves).

### Limits and costs
- A whole GENERATE KIT check takes about 585 ms in the worker (was 164 ms); MUTATE VOICE about 100 ms. Selection is 5 candidates; 3 would be about 40 % cheaper.
- Closed and open hats that are too alike rose from 1.2 % to 4.2 % of kits (the open hat decay is chosen with its own range at low WILDNESS).
- Kick and tom pitch is less stable than before (YIN stability 0.90 to 0.75): CHARACTER FM and sweeps are now audible. Wild sounds are meant to move.
- The instrument tendencies are measured, not heard; they are rough and tunable in `voiceScore.ts`.
- Factory presets are regenerated by the new generator, so they sound different. Saved projects are unchanged.
- Samples, the FX bus and per-step sound variations are not judged.
