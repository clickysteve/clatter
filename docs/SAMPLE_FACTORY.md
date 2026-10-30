# Sample Factory

SOUND > FACTORY turns CLATTER's sound generator into a sample-pack workshop: make a collection of
LXR percussion sounds (say 100), hear every one rendered by the real engine, let the quality checks
flag the broken ones, curate the best twenty, and export a properly organised ZIP without leaving
CLATTER. The kit and the tracks are not touched until you press SEND TO KIT.

There is no second synthesiser, renderer, analyser or exporter. Every piece is the one the rest of
CLATTER uses:

| Job | Reused from |
|---|---|
| designing a sound | `designVoice` (CHARACTER recipes, WILDNESS), `src/sound/kitgen.ts` |
| rendering a hit | `renderKitHit` in the real LXR engine, `src/audio/render.ts` |
| judging a render | `analyseVoice` and the safety limits of `src/sound/voiceScore.ts` |
| pitch | the TUNER's `analysePitch`, `src/analysis/pitch.ts` |
| WAV files | `encodeWav` (16-bit, 24-bit, 32-bit float), `src/export/wavFile.ts` |
| ZIP | `createZip` / `readZip` from Slop Factory Core |
| names, levels, tails | `uniqueName`, `LIMITS` (-1 dBFS, tail limits) of the kit exporter |
| saving sounds | the sound library of SOUND > DISCOVER |
| seeds | the phrase seeds of [SEEDS.md](SEEDS.md), a seed field of their own |
| applying a sound | the DISCOVER apply: one undo step, parameter locks kept |

What is new is in `src/sound/factory.ts` (the plan, the two controls below, the stage a sound is
rendered on), `src/sound/sampleQc.ts` (quality control, features, similarity, names),
`src/app/factory.ts` (the session), `src/export/packExport.ts` (the pack) and
`src/ui/views/soundFactory.ts` (the tab).

## Making a batch

| | |
|---|---|
| INSTRUMENT | kick, snare, clap, closed hat, open hat, low tom, high tom, cymbal, percussion, FX, or MIXED (all ten, dealt in a seeded order so any count is as even as it can be) |
| COUNT | 8, 16, 32, 64, 128 or your own number from 1 to 256. The collection holds 512 sounds. |
| CHARACTER | the kit generator's characters: MACHINE, ELECTRO, ACOUSTIC, INDUSTRIAL, GLITCH, DUB. STYLE follows the rhythm style. The same setting as SOUND > DISCOVER and KITS. |
| WILDNESS | 5 to 100 %: how strictly a sound follows its instrument's recipe. The same 0-100 % system as GENERATE KIT. |
| VARIATION | 0 to 100 %: how far each sound strays from the batch's anchor design (see below) |
| DIVERSITY | 0 to 100 %: how far apart the rendered sounds must be (see below) |
| SEED | a phrase or a number. The same seed, settings and an empty collection make the same sounds. |
| GENERATE | adds a batch to the collection. Numbers carry on (KICK 001-008, then 009...). |
| CANCEL | stops after the sounds being rendered now. What is done stays. |
| RETRY | renders again what failed or was cancelled |
| REGENERATE | draws the selected sounds again: same slot and seed, next draw. They replace the old ones. |
| CLEAR / CLEAR ALL | removes the sounds except favourites / everything. Frees all cached audio. |

The instruments share the LXR's six voices, and each is rendered on a track of its own in a private
project: kick on drum 1, low tom drum 2, high tom drum 3, snare and clap on the snare voice (the
clap is designed with the clap recipe), cymbal on the cymbal voice, closed and open hat on the hat
voice (triggers 5 and 6), percussion on drums 3 and 2, FX on drums 2 and 3. A sound is a whole voice;
it is not blended with the current kit's voice, and parameter locks do not apply to it. At a high
WILDNESS the generator may design a voice as another archetype (a hat as a cymbal, a tom as a zap);
the label is the instrument you asked for and the metadata records what it was designed as.

### VARIATION and DIVERSITY

They are two different controls, at two different stages.

- **VARIATION** acts on the *parameters*, before anything is rendered. For each instrument the batch
  has an anchor design, the same for all its sounds. Each sound also has a design of its own. VARIATION
  is how much of the way from the anchor to its own design a sound goes (a waveform or filter type,
  which cannot be halfway, is taken from its own design with that probability). At 0 the sounds are
  one sound with tiny differences left from parameters the recipe does not set; at 100 each sound is an
  independent design.
- **DIVERSITY** acts on the *audio*, after rendering. In generation order, a sound whose measured
  features are closer to an earlier sound of its instrument than the diversity asks for is drawn
  again (the same slot, next attempt, at most three more times) and the most distinct attempt is kept.
  At 0 nothing is redrawn and related sounds are welcome; at 100 the batch is made to spread over the
  sound space. Decisions depend only on earlier sounds, so the result does not depend on how many
  sounds are rendered at once. A redraw that fails a hard quality check is never kept.

Use low VARIATION and DIVERSITY for a family of related kicks, high for a surprising pack.

## Quality control

Every render is analysed and flagged. A flag is information, never a deletion: a strange sound that
is musically interesting is the point.

| Flag | Severity | When |
|---|---|---|
| INVALID | fail | a sample that is not a number or is infinite |
| SILENT | fail | peak under -80 dBFS |
| VANISHES | fail | under 8 ms of sound |
| DC | warn, fail from 25 % | mean offset over the sound, relative to its peak, over 10 % |
| LOW | warn | peak under about -34 dBFS |
| CLIP | warn | the render is over full scale, or 8 or more samples sit at full scale |
| CLICK | warn | under 14 ms of sound |
| DRONE | warn | the tail is still loud when the render ends (cymbals are exempt) |
| CUT | warn | the render reached its 6 second limit with the sound audible, and was faded there |
| DUP | warn | a near-duplicate of an earlier sound of the same instrument |

The limits are the kit generator's own safety limits (`safety` in `voiceScore.ts`) plus the checks
above; the thresholds live in `QC_LIMITS` and are tested.

The **QC FILTER** button is the override. ON (default): sounds that *fail* a check are left out of
SELECT ALL / INVERT and held back from the pack, unless you accept one with KEEP on its row. OFF:
nothing is held back. Warnings never hold anything back. The SHOW menu filters the browser to ALL,
PASSING (no flags, or accepted) or FLAGGED.

## Similarity and near-duplicates

Each sound is reduced to 22 numbers in 0-1, from the rendered audio and the existing voice analysis:
the share of spectral power in eight bands, the level envelope in seven windows after the onset,
and the centroid, noise content, tonality, length, attack, pitch sweep and pitch. They do not depend
on loudness. The distance between two sounds is a weighted Euclidean distance (0 identical). A
sound closer than 0.035 to an earlier sound of its instrument is flagged DUP; the threshold was set
on factory batches (an instrument with a narrow recipe, such as the kick, flags more). There is no
machine-learning model and no dependency: it is the analysis CLATTER already runs on every kit voice.

SORT > SIMILARITY lists the sounds nearest to a reference first. The ✱ button on a row sets the
reference; without one it is the first favourite, else the first selected sound.

## The browser

One row per sound: select, favourite, audition (▶), a 64-column waveform, the instrument and
number, the CHARACTER and WILDNESS it was made with, the pitch (or a word for how it sounds), the
duration, the peak level before normalisation, the flags, and ✱ (reference) and KIT.

- **Pitch** is measured with the TUNER's analysis for the instruments that have one (kick, toms,
  percussion, FX). A note is shown only for a stable or swept pitch with confidence 0.5 or more, the
  exporter's own limit. Everything else says NOISE, INHARM or NO NOTE. Snare, clap, hats and cymbal are
  not measured, which also keeps a large batch quick; they show a word instead.
- **SORT**: generation order, pitch (sounds without a trustworthy pitch go last), duration,
  brightness (spectral centroid), loudness (RMS), tonality, similarity. DESC reverses.
- **SHOW**: an instrument, quality, favourites only, selected only. Selection counts only change
  what is in view when you press SELECT ALL / NONE / INVERT.
- Audition renders the sound again through the engine (deterministically: it is the sound that was
  measured) and plays it on its own. The last six auditions are cached; nothing else keeps audio.

## Non-destructive workflow

Generating, auditioning, favouriting, regenerating, saving and exporting never write to the project
(a test compares the serialised project before and after). The only step that writes:

- **KIT** on a row, or SEND TO KIT with one sound selected: choose a kit slot 1-6 (the six LXR
  voices). The sound becomes that voice, as one undo step with parameter locks kept; UNDO restores
  the old voice. A sound can go to any slot: it is retargeted to the parameters that voice has.
- **SAVE** puts the selected sounds in the sound library (`.clattersound.json`, the same file
  SOUND > DISCOVER loads).

## The sample pack

EXPORT PACK writes the selected sounds as a ZIP:

```
SAMPLE-PACK.zip
  KICK/CLATTER_KICK_C2_001.wav
  SNARE/CLATTER_SNARE_NOISY_014.wav
  FX/CLATTER_FX_METALLIC_008.wav
  ...
  pack.json
```

Folders: KICK, SNARE, CLAP, CLOSED_HAT, OPEN_HAT, LOW_TOM, HIGH_TOM, CYMBAL, PERCUSSION, FX. A
MIXED sound goes in the folder of its instrument.

**Names** are `CLATTER_<INSTRUMENT>_<NOTE or WORD>_<NUMBER>.wav`. The note appears only where the
pitch is reliable (sharps as `s`: `Fs1`); a sound without a reliable pitch is named by a word for how it
sounds (NOISY, HISSY, METALLIC, CLANG, SWEPT, CLICKY, BRIGHT, BOOMY, LONG, PUNCHY, DARK, SOFT), from a
fixed list of rules, so the same measurements give the same word. The number is the sound's serial
within its instrument and is never reused in a session. With DRY + WET a `_DRY` / `_WET` suffix is
added. Collisions are impossible by construction and are also caught by `uniqueName` (case-insensitive,
`_2`, `_3`).

**Options** are the kit exporter's, and only those:

| | |
|---|---|
| FORMAT | WAV 16-bit, 24-bit (default), 32-bit float |
| RATE | 44.1 kHz. The engine's rate; the kit exporter does not resample and neither does this, so there is no sample-rate choice |
| RENDER | DRY (the voice as the engine makes it), WET (through the channel strip and FX send of the track that plays the same voice in this project; without one it is the same as DRY), or both |
| TAIL | AUTO (until the sound has died away, at most 10 s dry, 15 s wet) or CUSTOM seconds (0.05-30) |
| NORMALISE | scale each file to -1 dBFS (default on). Off with 16/24-bit and a hot sound: the file clips and says so in the warnings |

Each file is rendered again by the engine from the sound's parameters, encoded at once, and its
floating-point audio dropped, so memory holds only encoded files (limit 400 MB, 1024 files).
Packing is one stored (uncompressed) ZIP pass over the encoded files, which for a normal pack takes
well under a second and is the only step that cannot be interrupted; CANCEL EXPORT works up to it and
delivers nothing.

**pack.json** (format `clatter-sample-pack`, version 1) holds the project and export settings, the
counts per instrument, the warnings, and for each sound: its files (rate, bit depth, frames, seconds,
peak, gain, clipped, tail cut), the descriptive word, the pitch block (kind, reliable, note, Hz, cents,
confidence, method; measured on the DRY audition render), the quality flags and whether you accepted
it anyway, its generation (batch seed and phrase, the sound's own seed, CHARACTER, WILDNESS,
VARIATION, DIVERSITY, draw, attempt, generator version, archetype designed), its measurements, and
the synthesis (the voice and trigger, every parameter by name and by LXR parameter number, LFO and
velocity targets).

**IMPORT PACK** reads such a ZIP, or the bare pack.json. The sounds are added to the collection,
selected, and rendered again from their parameters, so what you hear is what the pack was made from;
the audio is bit-identical to the exported files (tested). A sound whose number is taken gets the next free
number. Sounds CLATTER cannot make again (an unknown instrument, a voice that does not exist) are
skipped and counted; unknown parameters are dropped and values clamped to 0-127.

## Performance

- Rendering a sound takes 10-100 ms in the engine and the analysis a few hundred at most; a batch of
  100 takes well under a minute on a laptop.
- Sounds render a few at a time (two by default; `FactoryDeps.concurrency`) and the browser gets a
  turn between every step, so the interface stays responsive and CANCEL takes effect within one
  sound. The rendering runs on the page, in short slices, as the DRUM HITS and the kit export do. The
  audio engine's worklet is never involved: nothing is sent to it.
- A batch keeps numbers, not audio: about 3 KB per sound. Audio exists only while a sound is being
  measured, in the six-sound audition cache, and while a pack is rendered.
- The list redraws only the rows that changed, and at most about ten times a second while a batch runs.
- The download link is released ten seconds after the file is handed over (the existing download
  helper).

## Limits

- Percussion and FX share the drum voices, so a voice can have a different sound in the factory than
  the kit's track on it; the factory never uses the kit's own voice settings (it takes only the
  parameters the recipe does not set from the current kit).
- LXR voices are monophonic and one-shot; there are no velocity layers or round-robins in a factory
  pack. Use EXPORT KIT for those.
- Pitch is reported, not forced: factory sounds are not retuned to a note. A pitch below about 30 Hz
  is not measured.
- The collection is in memory. It survives tab changes but not a reload: SAVE the sounds you want
  to the library, or EXPORT PACK and IMPORT it later.
- The seeds make the same sounds from an empty collection on the same version of the generator
  (`FACTORY_GENERATOR`, `GENERATOR_VERSION`); pack.json carries everything needed to rebuild a
  sound regardless.

## Tests

`test/factory.test.ts` (against the real engine): planning and counts, deterministic design,
VARIATION and DIVERSITY, quality control on synthetic faults, features and near-duplicates, batch
generation, cancellation and retry, REGENERATE and CLEAR, sorting and filtering, selection and the
quality filter, audition, non-destructive behaviour, WAV validity, ZIP validity and corruption,
metadata, names and collisions, import/export round trip. `e2e/factory.spec.ts`: the tab in a real
browser, generate, curate, export, cancel, retry, SEND TO KIT and undo.
