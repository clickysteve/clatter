# Scale quantisation (SOUND > SCALE)

CLATTER can hold a track on a musical scale. The scale is a global setting (on or off, root, type) that each track follows (GLOBAL), overrides (CUSTOM) or ignores (OFF). A track that is scale-locked shows a ♪ in the SCALE tab and in the SOUND sidebar.

## Scale types

Chromatic, major, natural minor, harmonic minor, major and minor pentatonic, dorian, phrygian, lydian, mixolydian, whole tone, and USER (notes drawn over the twelve pitch classes from the root). The table lives in `src/music/scale.ts` and is shared by the SCALE tab, the generators and the kit exporter. Melodic minor, locrian, blues and diminished are available to the exporter and to projects but not in the menus.

By default, kick, snare, toms, perc and zap-like tracks follow the global scale, and hats, cymbals and similar noisy roles are OFF. You can change any track.

## What is quantised

Only the intended **fundamental**. A tuned track gets one constant offset so that its audible fundamental lands on the nearest scale note (ties go to the lower note). Nothing is quantised frame by frame:

- A kick's downward pitch envelope keeps its shape, around the new base pitch.
- FM keeps its ratios. The offset is applied to the oscillator, not to the modulators, so FM sidebands move with the carrier.
- Noise, metallic and otherwise unpitched sounds are refused and play untouched. The SCALE tab says why.

The offset is made of whole semitones on the synth NOTE plus a small remainder on the oscillator FINE. For a sample layer it is a continuous playback shift.

## Measured, estimated and hint pitch

Each sound's pitch has a source, shown in the SCALE tab and the TUNER:

- MEASURED: found in rendered audio. Always preferred, stored in the project and carried along when only COARSE, FINE, NOTE or tune move, and dropped when the sound's character changes.
- ESTIMATED: from the oscillator setting, for the tom-like synth voices 0 to 2 only. Used before a measurement exists, and checked by the tests to be within about half a semitone of the audio.
- FROM THE FILE NAME: a note in a sample's file name. Only a hint: it is never trusted over a measurement.

TUNE (per track) and TUNE ALL render, measure, apply, then render the tuned sound again. If it is still more than 12 cents away a correction is stored and checked once more. Changing something re-tunes in the background after 700 ms; the explicit button is one undo step.

## Hybrid tracks

A synth layer and a sample layer within 0.75 semitone of one another are treated as one pitch and both move together. Otherwise each is tuned on its own.

## Generation and variations

Generators (kit generation, mutation, evolution, sound variations, step sound locks, Wildcard) snap COARSE onto the scale for scale-locked tracks. Hats, cymbals and tracks with the scale OFF are not touched. Variations are tuned against their own measurement and keep inheritance: they stay in the scale and an unchanged value still follows the base.

## Modulation

Modulation works around the quantised pitch and is not snapped. The tuning offset is part of the base sound; routes (LFOs, envelopes, macros, step mod) add to it. A route to OSC COARSE with 0.1 depth moves the sound about 2.4 semitones from the quantised pitch (tested on audio). A sequencer step pitch offset is the exception: it is snapped to the scale around the tuned note.

## Kit exporter

Pitch modes: ORIGINAL (the sound untuned, whatever the scale is), AS TUNED (the project as it plays), GLOBAL SCALE and TRACK SCALES (each with a note range), plus the earlier chromatic, scale and custom lists. File names come from the pitch measured in the exported audio. The source kit is never changed. The manifest gains an optional `projectScale` and a per-instrument `scale`.

## Project format

Schema version 7 adds `scale`, `track.scale` and `track.pitch` (stored measurements). Older projects load unchanged, with the scale off. A project saved by a newer version is refused.

## Limits

- Synth correction beyond the whole-semitone NOTE is limited to the oscillator FINE. Remaining error after verification is reported, not hidden (HEARD ±nC).
- Sounds with no stable fundamental, such as noise, clap, hats and cymbals, cannot be put on a scale.
- LXR voices are monophonic, so one track cannot play a chord.
- The cents-per-step of the oscillator FINE parameter is an engine constant that is not exactly known (a direct sweep suggested a much smaller range than the registry states). Tuning therefore verifies by measurement and stores a correction instead of trusting it; a residual error on a synth voice shows as HEARD ±nC and in the TUNER.
- Pitch analysis is of rendered audio, so a wet effect chain can change what is measured.
