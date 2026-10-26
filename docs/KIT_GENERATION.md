# Kit generation: profiles, CHARACTER and WILDNESS

**GENERATE KIT** makes a new set of drum sounds, **MUTATE KIT** changes the current one, and
**NEW** (on a voice row) designs one voice. All three are in the KITS tab of SOUND, beside
**CHARACTER** and **WILDNESS**. They change the kit only: never the patterns, the tempo, the
samples or the track sources. **WILDCARD** (PATTERN ▸ WILDCARD) is the separate, deliberately
disruptive operation that can transform everything, tempo included.

## Profiles

Each LXR voice is designed as an instrument: KICK, SNARE, CLAP, CLOSED HAT, OPEN HAT, LOW TOM,
HIGH TOM, CYMBAL, PERCUSSION or FX (stable ids `kick`, `snare`, `clap`, `chat`, `ohat`, `ltom`,
`htom`, `cymbal`, `perc`, `fx`). By default the profile comes from the tracks that play the voice
(AUTO); a voice row can override it (a cymbal on the kick voice), and the override stays until
set back to AUTO. Nothing is constrained by track names: any profile on any voice.

The LXR has three voice models, and each profile is written for each of them:

| Model | Voices | What it has |
|---|---|---|
| DRUM | DRUM 1-3 | oscillator, FM (real FM in MIX MODE 1), pitch envelope, transient, filter |
| SNARE | SNARE | tone plus noise (NOISE MIX), envelope repeats (claps) |
| METAL | CYMBAL, HIHAT | three oscillators for metallic spectra; the hihat has closed and open decays |

A kick on the METAL model is the best kick that model can make, not the DRUM recipe forced onto
it.

Values are truncated normals `[mean, spread, low, high]` in firmware units, calibrated against
the engine by measurement: coarse is the oscillator's MIDI note (24 = 33 Hz); drum decay 10, 24,
45 ≈ 125, 340, 790 ms; hat decay 2, 5, 8, 15 ≈ 25, 60, 95, 190 ms; open hat 12, 20, 30, 45 ≈
150, 260, 440, 770 ms; a SLOPE near 0 collapses any envelope to a few milliseconds; FM only acts
in MIX MODE 1; a low-pass dulls the snare's noise.

## Coherence

After drawing, relationships make the values one sound (`cohere` in `src/sound/profiles.ts`): the
lower a kick or tom, the deeper its pitch sweep; the sweep is shorter than the sound; a very short
body gets a click; kicks and toms keep FM small; a low-pass stays above the fundamental (and off
noisy and metallic profiles); a snare balances tone and noise; drive lowers the volume; an open
hat rings longer than the closed one; short instruments stay short. These are enforced with a
strength that falls as WILDNESS rises. Guards against silence (a slope near zero, a low-pass
closed below everything) apply at any wildness.

## Measured, not assumed

The kit check (`src/sound/kitcheck.ts`, in a Worker) renders every voice through the real engine,
analyses it (`src/sound/analysis.ts`: fundamental, attack, decay, length, spectral centroid,
low-frequency share, spectral flatness, high-frequency sustain, peak, RMS) and judges it against
its profile (`src/sound/judge.ts`). A voice that does not sound like its instrument is designed
again from a few other seeds and the best-judged candidate kept. The wilder the setting, the
fewer candidates; above 70 % none, so wild sounds are never pulled back. Then levels are matched
and inaudible voices replaced, as before. Share of voices the judge accepts as their instrument
(score ≥ 0.5), 20 kits each, after the engine check (kick, low tom, high tom, snare, cymbal,
hats):

| Generator | KICK | LO TOM | HI TOM | SNARE | CYMBAL | HATS |
|---|---|---|---|---|---|---|
| Previous designer | 95 % | 95 % | 95 % | 20 % | 95 % | 100 % |
| CLASSIC 20 % | 100 % | 100 % | 100 % | 100 % | 100 % | 100 % |
| CLASSIC 50 % | 100 % | 100 % | 100 % | 95 % | 100 % | 100 % |
| CLASSIC 80 % | 45 % | 55 % | 95 % | 20 % | 60 % | 45 % |
| EXPERIMENTAL 100 % | 20 % | 40 % | 50 % | 15 % | 40 % | 10 % |

The judge is a coarse proxy for listening (it tells a kick from something that is not one); the
CLASSIC 20 % figures are asserted by `test/kitprofiles.test.ts` with the measurements themselves
(fundamental, low-frequency share, noisiness, brightness, lengths).

## WILDNESS (0-100 %, default 30 %)

A continuous transformation of the distributions, not presets and not one range knob. As it
rises:

- the spreads widen (each parameter by its own spread);
- each bound opens towards the whole 0-127 range, faster where there is more room;
- menus (waveforms, filter types, transients, MIX MODE) drift from the profile's weights towards
  every choice;
- **excursions** become likely: a single parameter drawn anywhere in its open range;
- a voice may **cross** with another profile (each parameter from either);
- coherence is enforced less, the engine check chooses less, decimation and LFOs appear more.

Rough guide: 0-20 % recognisable electronic percussion; 20-40 % characterful but clear; 40-60 %
experimental; 60-80 % unusual and abstract; 80-100 % largely unconstrained.

## CHARACTER (default CLASSIC)

A character leans the distributions (`CHARACTER_DEFS`): waveform and transient weights, FM depth
and how often real FM is used, brightness (cutoff, noise frequency), resonance, drive and filter
drive, transient level, decay length, decimation, LFO likelihood, pitch spread, the FX bus and how
wet it is, and how quickly relationships relax.

| Character | Lean |
|---|---|
| CLASSIC | the profiles as they are |
| ANALOG | sines and triangles, little FM, softer transients, darker filters, no decimation |
| DIGITAL | real FM, square, saw and PWM spectra, clicks, brighter, some decimation |
| INDUSTRIAL | drive and filter drive, resonance, hard transients, decimation, unusual pitch |
| MINIMAL | short decays, little FM and drive, no LFOs, a nearly dry FX bus |
| EXPERIMENTAL | LFOs, noise and PWM, resonance, odd transients, looser relationships |

## MUTATE

Relative to the current kit. For each unlocked voice a fresh profile-consistent target is
designed with the character and wildness; each unlocked parameter moves part of the way towards
it (and a little beyond, by noise) inside bounds the wildness opens, never pushing a value
outward past where it already is unless the wildness allows; menus change rarely at low
wildness; at high wildness the voice may take on new modulation. Relationships are re-applied
gently. Low wildness keeps each drum what it is (still judged as its instrument in the tests);
high wildness lets it leave its role. One undo step; locked voices and parameters, samples,
source modes and variation inheritance are untouched. MUTATE VOICE does the same for one voice.

EVOLVE and WILDCARD's kit mutation keep using the previous designer, and the factory presets are
still built by it, so every preset and stored seed makes exactly the sound it always did.

## Seeds and records

Every press uses a seed. **HOLD** keeps the seed for the next press; typing a seed holds it. The
same seed, character, wildness, profiles, locks and starting kit make the same kit (the engine
check uses a freshly instantiated engine for each check, because the firmware keeps its noise
oscillators' phase across a reset). The kit records how it was made (`project.kit.gen`: version,
operation, seed, character, wildness, the profile of each voice); the settings live in
`project.kitGen`. Both are optional: older projects load unchanged and sound the same.

## Tests

`test/kitprofiles.test.ts`: profiles and overrides, characters differ, reproducibility (also
through the engine check), firmware ranges, wildness ranges and continuity, menus, likeness
falling with wildness (rendered), CLASSIC 20 % kicks, snares, hats and toms measured in the
engine, character differences in parameters and in sound, locks, mutation distance and identity,
NEW VOICE with an override, undo, samples untouched, WILDCARD separate, older projects.
