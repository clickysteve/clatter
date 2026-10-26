# TUNER and pitch analysis

The TUNER tab of SOUND tells you what pitch the selected sound actually has. It looks at the
audio the sound produces, not at the oscillator parameters, so the answer includes the pitch
envelope, FM, filters, modulation, variations, sample tuning and the HYBRID mix.

## Using it

- **ANALYSE CURRENT SOUND** renders the selected track's sound alone and offline, analyses it and
  shows the result. If the sound has not changed since it was last analysed, the stored result is
  shown at once.
- **REANALYSE** renders and analyses again.
- **AUTO** (off by default) analyses again about half a second after the sound changes, and when
  you select another track or variation. Nothing is ever analysed during normal playback.
  Opening the tab analyses a sound that has never been analysed (one render).
- **BASE / A-D** chooses what is analysed: the base sound or one variation. An empty variation is
  the base sound.
- **MIX / SYNTH / SAMPLE** (HYBRID tracks only) analyses both layers together, as the track plays, or
  one layer alone.

The readout shows the note, the frequency, the cents against the note, a tuning indicator
(-50 to +50 cents), the pitch classification, how confident the analysis is and how steady the
pitch is. For a pitch-swept sound it also shows INITIAL, SETTLED and the MOVEMENT, and a
pitch-over-time graph (log frequency, C notes marked, the level of the sound along the bottom so
the faint tail is not mistaken for pitch). When the sound changes after an analysis, the readout
dims and says so until you analyse again.

## Classes

| class | meaning | note shown |
| --- | --- | --- |
| STABLE PITCH | one steady fundamental | yes |
| PITCH SWEEP | the pitch moves at least a semitone one way (a kick or tom envelope); the headline is the settled body pitch, the attack pitch is reported as INITIAL | yes (settled) |
| INHARMONIC | strong partials that share no single fundamental (bells, metallic FM, cymbals) | no |
| UNPITCHED | no partial stands out of the noise (snares, claps, hats) | no |
| SILENT | nothing to analyse | no |

A note name is never given to an INHARMONIC, UNPITCHED or SILENT sound.

## Method

`src/analysis/pitch.ts`, method `YIN+SPECTRUM/1`:

1. **YIN** (de Cheveigne and Kawahara, 2002) over 23 ms frames every 10 ms, 25 to 4000 Hz: the
   difference function, cumulative mean normalisation, an absolute threshold. The first dip wins
   (so a low drum is not heard an octave down) and the dip's depth is the frame's confidence. The
   dip is located on the raw difference function with parabolic interpolation.
2. The frame track is cleaned (a 5-point median removes 4+ semitone slips) and summarised: INITIAL is
   the first voiced frames, SETTLED is the longest steady stretch at the end (within 60 cents), the
   SWEEP is the distance between them. It counts as a sweep when it is at least 100 cents and the
   pitch moves one way (Spearman correlation of pitch with time of at least 0.5).
3. A Hann-windowed spectrum of the attack finds the strong partials (25 dB over the median
   floor). They have to bear the period out: the energy must sit on whole multiples of f0, and the
   first strong partial must be within the first two or three harmonics. Otherwise the period
   is treated as a coincidence of the waveform and the sound is INHARMONIC. A FFT peak is never taken as
   the fundamental, except as a labelled low-confidence fallback for one lone tone below 1 kHz
   when no period can be measured (a very low sub or a very short blip).

Confidence is the energy-weighted depth of the YIN dips, scaled down when only part of the
sound is voiced. Stability is how little the pitch wanders where it settles.

## The result record

`PitchAnalysis` (`src/analysis/pitch.ts`) is the reusable result. It is plain JSON:

```
version, method          1, "YIN+SPECTRUM/1"
kind                     stable | swept | inharmonic | unpitched | silent
fundamental              { hz, midi, note, cents } or null
confidence, stability    0-1
initial, settled         { hz, midi, note, cents } or null
sweepCents, settleTime   cents the pitch falls (negative: rises); seconds until within 50 cents
contour                  [{ t, hz | null, conf, level }] per 10 ms frame
partials                 strong spectral partials in Hz
rate, analysed, reason   sample rate, seconds analysed, the verdict in words
```

`PitchRecord` (`src/analysis/trackPitch.ts`) wraps it with the target (track, slot, layer), a
fingerprint of the sound and a timestamp. `app.pitch` holds the records in memory beside the
project: they are never saved in the project file and are not part of the synthesis parameters. Later
phases (sample export, scale quantisation) read `app.pitch` or call `app.analysePitch(target)`.

### Invalidation

The fingerprint is a hash of everything that can change the one dry hit that is analysed: the
track's sound (source, trigger, samples, tuning, modulation, the analysed variation but not the
others), the whole synth kit (the engine shares state between voices), the macros, the project
seed and the analysis layer. The pattern, tempo, mixer and other tracks' sounds are not in it. A
record whose fingerprint no longer matches is stale; the UI says so and `app.analysePitch` renders
again.

## What is rendered

The same single-hit render as DRUM HITS (`renderHit` in `src/audio/render.ts`), on a clone of the
project in a private engine, at velocity 127, with the track at unity and centred, its channel
processing and the master chain bypassed. Variations travel with the hit exactly as a step that
names them would play (`resolveStepSound`), including their modulation. The live engine, the
transport, the project and the sample library are not touched. Without the new options `renderHit`
is unchanged.

## Accuracy and limits

- Synthetic sines from 30 Hz to 3 kHz, at offsets of 0, +23 and -37 cents: mean error 0.3 cents,
  worst 3 cents. Harmonic stacks, decaying tones and integer-ratio FM give the right fundamental.
- With noise at about 10 dB signal-to-noise the error stays within about 5 cents; at 5 dB it can
  reach a few percent at low pitches, with lower confidence. In heavier noise a lone tone is
  reported by the spectral fallback with confidence capped at 0.5, or not at all.
- Below about 30 Hz no note is given (the sound is reported as inharmonic or unpitched).
- A sweep that settles within about 25 ms is blurred by the 23 ms frame: INITIAL is then an average over
  the attack, not the first instant.
- FM or partial sets whose ratios are very close to a simple fraction have a real near-period, so
  they are reported as STABLE at that period (for example a ratio of 1.4142 locks near 5:7).
- A missing fundamental is reported when the first strong partial is the 2nd harmonic or lower;
  higher than that the sound is called inharmonic.
- A HYBRID mix of two layers with different pitches is usually INHARMONIC: analyse the layers separately.
- A kit parameter change anywhere stales every stored result (the engine shares voice state).
- Only the first 1.5 seconds after the onset are analysed.
