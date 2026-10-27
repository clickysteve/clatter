# EXPORT KIT

EXPORT KIT (FILE > Export kit, and EXPORT WAVS on the FULL KIT card of SOUND > KITS) renders the instruments of
the current kit as individual WAV files in a ZIP archive with a `kit.json` that says what every
file is. The existing EXPORT (master, stems, MIDI) and DRUM HITS are unchanged.

## What is rendered

Every file is a fresh single-hit render of one track, alone, in a private engine seeded from the
project (`renderKitHit` in `src/audio/render.ts`). It is the real LXR synthesis and the engine's own
sample and HYBRID layers, with the track's variation parameters, sample overrides, voice switch and
modulation exactly as a step that names that variation plays them. Nothing is recorded from the
running instrument and no other track can leak in (the other tracks are muted in the render, and a
test checks that changing another track changes nothing in this track's file). The same project
gives byte-identical files. The project is cloned; it is never modified.

The master chain, soft clip and output limiter are out of the way (the exporter normalises and
reports clipping itself). The track is at unity and centred; a sample's own pan stays.

## Options

| option | choices |
| --- | --- |
| Instruments | all tracks, or selected tracks |
| Variations | BASE only, BASE plus every populated variation A-D, or a chosen set. An empty variation plays the base sound, so it is skipped (with a warning when chosen by hand) |
| Velocity layers | 1, 4, 8 or 16. N layers split 1-127 evenly and each is rendered at the top of its range (4 layers: 32, 64, 95, 127). One layer is velocity 127 and has no VEL in its name |
| Pitch | original pitch, chromatic range, selected scale (root, scale, range), custom note list |
| Audio format | WAV 16-bit, 24-bit, 32-bit float (44.1 kHz stereo; integer files are rounded and clamped, no dither) |
| Processing | DRY, WET, BOTH. DRY is the voice and sample before the channel strip. WET keeps the track's EQ, saturation, one-knob filter and FX send/route (not the master). BOTH writes two files |
| Tail | AUTOMATIC: until the sound has been under -80 dBFS for 350 ms (WET 600 ms), at most 10 s (WET 15 s). If a tail is still audible at the limit it is faded over 20 ms and the file says `tailCut`. CUSTOM: exactly that many seconds (0.05-30), with a 5 ms fade if the sound is still audible |
| Normalisation | ON: the loudest file of each instrument, variation and processing is set to -1 dBFS and every file of that group gets the same gain, so velocity layers and notes keep their balance. OFF: levels as rendered, and an integer file over full scale is reported as CLIPPED |
| Output | ZIP archive |

The dialog also takes notes as names (`C2`, `F#3`, `Bb1`) or MIDI numbers (`36`), custom lists such
as `C2, F#2, 48, C3-E3`, and uses one octave convention everywhere: C4 = 60, A4 = 440 Hz (the same
as the TUNER). Limit: 4096 files per export.

## Pitch

The starting point is the TUNER's analysis of the rendered audio (`src/analysis`, reused through the
app's cache): what the oscillators, pitch envelope, FM, filters and samples add up to. For a
pitch-swept sound the target note is the settled body pitch.

The target is reached in the engine, not by pitch-shifting a finished file:

- **Synth voices**: the hit's note input. One semitone moves the voice one semitone, and the
  LXR scales its pitch envelope and FM with it (checked on the kick, snare and toms). The note is a
  whole number, so the remaining cents are set on the voice's oscillator FINE parameter for that
  hit only (about 0.9 cents per step; the kit is untouched).
- **Sample layer**: the sample engine's playback rate, continuous. Like the engine's own sample
  TUNE this changes the length of the sample; there is no time-stretching.
- **HYBRID**: both layers move together, starting from the analysis of the mix.

Every retuned file is then measured with the same pitch analysis. If it is more than 15 cents from
the target the tuning is corrected and the file rendered again (up to three renders). The result is
in `kit.json` as `pitch.tuning`:

| tuning | meaning |
| --- | --- |
| `confirmed` | measured within 15 cents of the note in the name |
| `approximate` | kept, within 40 cents; a warning is recorded |
| `unverified` | the pitch could not be measured (below 32 Hz, or the analysis no longer hears one pitch); tuned by calculation, with a warning |
| `original` | original pitch mode, named after the measured note, with its cents in `errorCents` |
| `none` | no pitch claimed |

A file more than 40 cents off after the corrections is **not written**: it is listed under `skipped`
with the reason. A sound with no single reliable pitch (noise, hats, cymbals, bells, metallic FM,
or an analysis under 0.5 confidence) is exported at its original pitch only, once per velocity
layer, with no note in its name, and a warning says why. With more than 400 pitched files only the
loudest velocity layer of each note is measured; softer layers share its tuning (`kit.json` says so
under `settings.verification`).

Limits: the analysis cannot confirm notes below about 32 Hz; very short sweeps blur; sounds whose
timbre changes with pitch (FM with a fixed modulator) keep the pitch of the note but not their
timbre; LXR voices are monophonic, so layers are separate files, not chords.

## Files

```
KICK_G1.wav                  one layer, one note
HI_TOM_A2_VEL096.wav         velocity layer (top of its range)
PERC_F3_VAR_B.wav            variation B
KICK_G1_VEL127_VAR_A_WET.wav BOTH processing: _DRY / _WET
CLAP.wav                     unpitched: no note in the name
kit.json
```

Names are upper case; a sharp is written `s` (`F#2` is `Fs2`; `kit.json` has `F#2`). Two tracks with
the same name get `_2`, and any remaining collision gets a numeric suffix (checked without regard to case).

## kit.json (format `clatter-kit-export`, version 1)

`kit` (name, project, seeds, tempo, sample set), `settings` (the options, 44100 Hz, bit depth, the
velocity ranges, how pitch was verified), `scale` (root, name, notes) when a scale was used, `synth`
(the kit's parameters, LFO and velocity targets as they were), `instruments` (id, name, role, source
mode, trigger, the track's sound settings, variation names and parameter overrides, and the pitch
analysis of each exported sound), `files` (per file: instrument, variation, processing, velocity
layer and range, pitch and tuning record, format, frames, seconds, peak, normalisation gain, tail
and clipping flags), `skipped` and `warnings`. Only the creation time varies between runs.

## Progress and cancel

A card at the bottom left shows the stage (analysing, rendering, packing), the instrument and file
being rendered, files done out of the total, and CANCEL. The render runs file by file in the
background and gives the browser a turn between files; the interface stays usable. Cancelling
stops after the file in progress and saves nothing. A failure is shown as an error notice. One kit
export at a time (`src/app/kitExportJob.ts`); it does not use or block the pattern EXPORT.

## Code

`src/export/kitExport.ts` (plan, tuning loop, normalisation, manifest, ZIP), `src/export/notes.ts`
(names, scales, ranges), `src/export/wavFile.ts` (WAV writer and reader), `renderKitHit` in
`src/audio/render.ts`, `src/app/kitExportJob.ts`, `src/ui/kitExportDialog.ts`; tests in
`test/kitexport.test.ts` and `e2e/features.spec.ts`.
