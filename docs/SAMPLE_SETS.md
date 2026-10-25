# Sample sets, synth kits and full kits

CLATTER treats a collection of drum samples as an instrument you can keep, swap and share, and
keeps it apart from the LXR synthesis. There are three kinds of kit, each with one clear owner for
every setting.

| | Owns | Never touches | File |
|---|---|---|---|
| **SYNTH KIT** | every LXR parameter, the modulation targets, the FX bus, each track's voice assignment (trigger, note), the variations' parameter overrides | samples, sample settings, source modes, mixer | `.clattersynth.json` |
| **SAMPLE SET** | which samples each track plays and how: tune, fine, gain, pan, reverse, region, pick | synthesis, voices, HYBRID levels, mixer, variations, patterns, step sounds, locks, conditions | `.kit.zip` |
| **FULL KIT** | a synth kit and a sample set together, plus what joins them: each track's source (SYNTH, SAMPLE, HYBRID), HYBRID balance and alignment, choke groups, the samples variations override, the mixer's volume, pan, route and filter | patterns, step sounds, locks, conditions, tempo, destruction settings | `.kit.zip` |

Mute and solo are performance state, not kit state, and are never saved. A sample's own
variation overrides (the sample-layer part of a variation) stay with the sample half: loading a
synth kit changes a variation's parameters and leaves its sample overrides where they are.

Load the halves independently: `Metallic Chaos` + `TR-606`, then change only the set to `TR-808`
and the synthesis stays exactly as it was.

## Using it

* **SOUND > SAMPLE**: the current set's name (with UNSAVED when the tracks' samples differ from
  the saved set), LOAD SET…, SAVE SET, IMPORT FOLDER…, IMPORT ZIP…, EXPORT SET, LIBRARY…, then the
  current track's sample editor, library list and audition buttons as before.
* **SOUND > KITS**: GENERATE / MUTATE KIT as before, and a KITS group with a line each for
  SYNTH KIT, SAMPLE SET and FULL KIT (SAVE… and LOAD…) and the LIBRARY….
* **KIT menu**: the same, plus Import sample folder… and Import sample ZIP….
* **FILE > Open project, bundle or kit…** recognises kit files, synth kit files and ZIPs of
  samples as well as projects.

The **kit library** dialog lists saved kits of one kind (tabs: SYNTH KIT, SAMPLE SET, FULL KIT):
SAVE CURRENT under the name above (a taken name asks you to press again to replace), LOAD…,
RENAME, DUPLICATE, DELETE (twice), EXPORT, IMPORT FILE…, IMPORT FOLDER…, IMPORT ZIP…, and REMOVE
UNUSED SAMPLES. Selecting a kit shows its instruments and how many samples are not in this
browser.

**LOAD… never loads blind.** It lists every track, what it plays now and what it will play, marks
the tracks that change, offers ▶ to hear the new sample, and states what is kept. A sample set
has two options: whether a SYNTH track that receives a sample becomes a SAMPLE track (default
yes; HYBRID tracks stay HYBRID), and whether tracks the set has no sound for keep their samples
(default) or are cleared. A track that receives samples takes the set's playback settings (a set
that has none gives neutral settings). One LOAD is one undo step.

## Importing a folder or ZIP

IMPORT FOLDER… (a directory chooser) and IMPORT ZIP… read the audio files (WAV, AIFF, FLAC, MP3,
OGG, M4A), ignoring everything else: metadata files, hidden files, macOS `__MACOSX` resource
forks, and paths that would escape the folder. Nested folders are kept as paths, and a single
enclosing folder is dropped, so `TR-606/Hats/Open/oh.wav` is `Hats/Open/oh.wav` in a set named
TR-606.

CLATTER then proposes a mapping (`src/samples/names.ts`, no browser needed, so it is reusable):

* File names are split into word tokens (punctuation, camel case, letters/digits), and matched
  against a table of names and abbreviations with a confidence each: kick / bd / bass drum,
  snare / sd / snr, clap / cp, closed hat / ch / chh / hhc, open hat / oh / ohh / hho, low tom /
  lt, high tom / ht, cymbal / cy / crash / ride, perc / rim / cowbell / shaker / conga, fx and
  more. Modifiers combine across words ("hat" + "open", "tom" + "low"). Folder names count at a
  lower weight ("Kicks/01.wav").
* Each track gets at most one file and each file at most one track, most confident pairs first.
  Ties (several kicks) go to the shallowest folder, then the shortest name, then natural order, so
  the same folder always gives the same proposal.
* The dialog shows one row per track with the file, a pop-up of the likely files first (marked ≈
  when several fit) then every other file, ▶ to audition a file before choosing it, and what the
  track plays now. Leave a row at NONE to leave that track empty.
* Nothing on the tracks changes until SAVE AND LOAD. SAVE SET only puts the set in the library.
  Saving stores each chosen file once (by content), reports progress, and stops with a message
  if the browser's storage is full, leaving nothing half-saved.

## Storage

Reuses Slop Factory Core 0.5 (`@slopfactory/core/kits`): `KitLibrary`, `KitSession`, `mapKit`,
`readKitArchive`/`writeKitArchive`, `Auditioner`, `IndexedDbKitStore`, plus Core's content-hashed
`IndexedDbSampleStore`, ZIP reader and writer, and sample decoder.

| IndexedDB database | Holds |
|---|---|
| `clatter-samples` | the audio: original file bytes keyed by SHA-256. One copy however many sets, kits and projects use it. (Existing samples need no migration.) |
| `clatter-sample-sets` | sample sets, the sample index, and synth kits (small JSON in the library's application values) |
| `clatter-full-kits` | full kits |

A sample is never deleted while a saved set, a saved full kit or a track of the project uses it
(`KitLibrary.inUse`). Without IndexedDB (private windows in some browsers) kits work for the
visit and the dialogs say so. Decoded audio is cached by Core within a memory budget; CLATTER's
own library decodes a sample when a set that uses it is loaded, not at import.

A set whose audio is missing from this browser (storage cleared, kit shared by reference) loads
what it can, says how many samples are missing, and refuses only when none of its audio is
present. Damaged or incomplete files are refused whole with a message and change nothing.

## The portable format

A sample set is a Slop Factory kit file: a ZIP (any unzip tool opens it), named
`<name>.kit.zip`, from Core's `docs/KITS.md`.

```
manifest.json
samples/01-kick.wav
samples/02-snare.wav
```

```json
{
 "format": "slopfactory-kit",
 "version": 1,
 "generator": { "app": "clatter", "core": "0.5.0" },
 "kit": {
  "name": "TR-606",
  "description": "optional",
  "instruments": [
   { "role": "kick", "index": 0, "label": "KICK", "selection": "fixed",
     "samples": [{ "sample": "9f2c…e1", "name": "606 KICK", "primary": true }],
     "ext": { "clatter": { "schema": 1, "tune": 0, "fine": 0, "gain": 1, "pan": 0, "reverse": false, "start": 0, "end": 1, "pick": "first" } } }
  ],
  "ext": { "clatter": { "schema": 1, "kind": "sample-set" } }
 },
 "samples": [{ "id": "9f2c…e1", "file": "samples/01-kick.wav", "name": "606 KICK.wav", "type": "audio/wav", "size": 8864, "format": "wav" }]
}
```

* **Roles** are Core's drum vocabulary (`kick`, `snare`, `clap`, `hat-closed`, `hat-open`,
  `tom-low`, `tom-high`, `crash`, `ride`, `perc`, `fx` …). CLATTER maps its tracks onto them
  (CL HAT is `hat-closed`, CYMBAL is `crash` and accepts `ride`, PERC accepts `rim`, `cowbell`,
  `shaker`, `clave`, `conga`, LO TOM accepts `tom-mid`), so a kit from The Breakery or DOWNBEAT
  loads here and a set from here loads there. Instruments the set has and CLATTER has no track
  for stay in the kit, and are kept when you save it again.
* **Assets** are referenced by SHA-256 (`sample`) and by a relative path inside the archive
  (`samples/…`). No absolute paths, URLs or object URLs appear anywhere. A sample shared by
  several instruments is stored once.
* **Versions.** Core checks the archive format and version (newer is refused with a message that
  says so). CLATTER's own data sits under `ext.clatter` with its own `schema`: data from a newer
  schema is ignored (the samples still load, with neutral settings) and the load dialog says so.
  Every field is range-checked on read; unknown fields are dropped; text is cleaned.
* **Limits** (Core's): 256 samples per instrument, 2000 sample references per kit; CLATTER plays up
  to 16 samples per track, the first 16 of an instrument.
* **Playback settings** are per instrument: `tune` (-24..24 semitones), `fine` (-100..100 cents),
  `gain` (0..2), `pan` (-1..1), `reverse`, `start`/`end` (0..1 of the sample), `pick` (`first`,
  `cycle`, `random`, `velocity`, also carried as Core's `selection`).

### Full kits

The same file, with `kit.ext.clatter` extended:

```json
"ext": { "clatter": { "schema": 1, "kind": "full-kit",
  "synth":   { "name": "METALLIC CHAOS", "seed": 2201, "synth": { "params": [...], "lfoTarget": [...], "velTarget": [...] },
               "voices": { "kick": { "trigger": 0, "note": 60, "variations": [...] } } },
  "sources": { "kick": { "mode": "hybrid", "synthLevel": 0.35, "sampleLevel": 0.65, "offsetMs": -4, "choke": 2,
                         "variationSamples": [{ "samples": ["…"], "tune": 4 }, null, null, null] } },
  "mix":     { "kick": { "volume": 0.5, "pan": 0, "route": "fx", "filter": 0 } } } }
```

Samples only a variation uses travel in an extra instrument with the role
`clatter:variation-samples`, so the file carries all the audio. Any Slop Factory application opens
a full kit as a plain sample set (the instruments are standard); only CLATTER reads `ext.clatter`.
A full kit has no mixer data in files from before this feature, and then leaves the mixer alone.

### Synth kits

`.clattersynth.json`: `{ "format": "clatter-synth-kit", "version": 1, "name", "seed", "synth":
{params, lfoTarget, velTarget}, "voices": { role: { trigger, note, variations? } } }`. Variations
here carry parameters only. Newer versions are refused; values are repaired on read like a
project's.

## Compatibility and migration

* **Projects** are unchanged (still version 2). One optional field, `sampleSet`, names the set the
  tracks' samples came from (display only; the samples themselves stay on the tracks), absent in
  older projects and ignored by older readers. Opening a project never touches the libraries, and
  deleting a set never changes a project.
* **`.clatterkit.zip`** (the previous kit file: synthesis plus every track's whole sound, with the
  audio) still opens. It is imported into the FULL KIT library, because that is exactly what it
  was: its samples are re-hashed and stored, its synth and track sounds become the full kit's
  parts, and loading it reproduces what the old loader did. Old files are only read; CLATTER now
  writes `.kit.zip`.
* **Project bundles** (`.clatter.zip`) are unchanged.

## For CLATTER Pocket (M-VAVE FM-1)

The musical data (roles, assignments, selection, playback settings) is separate from the audio
(content-hashed assets), and every CLATTER-specific field is under a versioned `ext.clatter`, so a
device that cannot play arbitrary samples can read the instrument list and settings, report
what it cannot honour (the load dialog's "not used" and "newer schema" lines are the model for
that), and leave the rest. Nothing in the browser implementation assumes the FM-1's limits.

## Tests

`test/kits.test.ts` (names, intake, libraries, loading, files, compatibility) and
`e2e/samplesets.spec.ts` (the whole flow in a browser, the layout at three window sizes and three
scales).
