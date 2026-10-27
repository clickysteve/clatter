# Seeds

CLATTER's randomness is deterministic. Everything that looks random (generated patterns, kit
design, sound variations, WILDCARD, conditional triggers, modulation randoms, the offline export) is
a function of a **seed**, so the same seed with the same settings gives the same result. Since
Phase 4 a seed can be a word or a phrase such as `velvet-orbit` instead of a long number.

## One seed system

There is one seed system and it did not change: a seed is an unsigned 32-bit integer, fed to the keyed
hash `hash32`/`rand` (performance decisions) and the small generator `Rng` (mulberry32, sequential
generators) in `src/rhythm/rng.ts`. A phrase is only a readable name for such a number:

```
phrase --normalise--> canonical text --SEED HASH v1--> uint32 --> rng.ts (unchanged)
```

`src/rhythm/seed.ts` holds the phrase side; nothing in a generator knows about phrases.

## SEED HASH v1

Reimplementable anywhere:

1. Canonical text: NFKC-normalise, lower-case (Unicode default mapping, independent of the locale),
   split on white space, `-` and `_`, drop control and format characters (including zero-width ones),
   join with `-`, keep at most 80 code points, trim a trailing `-`. So `Velvet Orbit`, `velvet_orbit`
   and ` VELVET--ORBIT ` are the same seed, and so are composed and decomposed accents.
2. Encode as UTF-8 (done by hand, so no platform can differ).
3. FNV-1a, 32 bit: offset 2166136261, prime 16777619, over the bytes.
4. Murmur3 `fmix32`: `h ^= h>>>16; h *= 0x85ebca6b; h ^= h>>>13; h *= 0xc2b2ae35; h ^= h>>>16`.
5. A result of 0 becomes 1.

Reference values (pinned by `test/seeds.test.ts`): `velvet-orbit` = 3927013363, `haunted-machine` =
1423416732, `silver-moth` = 1212435622, `my-favourite-kick` = 470857457. The version is stored in
projects as `seedHash`. Version 1 is never changed; a different hash would be version 2, and a
project keeps the numbers its phrases named, so it would still reproduce.

## What can be typed

- **A phrase**: anything that is not only digits. It is normalised, shown in lower case and hashed.
- **Digits only** (up to 4294967295): a plain number, exactly as seeds have always been typed. This
  reproduces any old seed. (A phrase made only of digits, or a number too large for a seed, is a
  phrase.)
- **Empty** (or only separators): no seed. In a seed field it means "free": every press draws a new
  one. The empty phrase itself still hashes (to 2872998923) if a program asks.

## Memorable seeds

The dice and every press of a generator that is not holding a seed draw an adjective and a noun from two
lists of 256 plain words (`velvet-orbit`, `haunted-machine`): 65,536 phrases, using the platform's
secure random source. A phrase is hashed, never looked up in the lists, so the lists can change
without affecting any saved seed. (Two words are easy to read and say aloud; type anything longer for
more variety.)

## The seed field

`src/ui/seedField.ts`, one compact row wherever a generator has a seed:

| control | does |
|---|---|
| text | type a phrase or number, Enter: the generator's next press (and every one after) uses it |
| dice | a new two-word phrase, held for the next press |
| COPY / PASTE | the seed as text through the clipboard (PASTE uses it, like typing it) |
| CLEAR | free again: every press draws a new phrase and shows it in the field |
| FIXED | hold or release the seed without changing it |

The fields: **PATTERN > GENERATE** (GENERATE), **PATTERN > WILDCARD** (WILDCARD, replacing the number
field and FIXED SEED), **SOUND > KITS** (GENERATE KIT), **SOUND > VARIATIONS** (the sound generators:
GENERATE VARIATIONS, GENERATE SOUND, MUTATE SOUND), and **PATTERN > TRIGGER** (the project seed, below).
Typing in a field never plays a keyboard shortcut. Each field is remembered with the preferences, so a
held seed is still there after a reload.

## What is seeded, and from what

| system | seed | stored in the project |
|---|---|---|
| GENERATE (pattern) | the GENERATE field | `patterns[].seed`, `seedText` |
| GENERATE KIT | the KITS field | `kit.seed`, `seedText` |
| DISCOVER 8 (SOUND > DISCOVER) | the DISCOVER field | each candidate's `origin` (seed, slot, draw, character, wildness); an applied one is recorded in `discovered` |
| sound variations, GENERATE SOUND, MUTATE SOUND | the VARIATIONS field | `timbre.seed`, `seedText` |
| WILDCARD | the WILDCARD field | `wildcard.seed`, `seedText` |
| conditional triggers (PROB, FILL), step-sound probabilities and ranges, CHOP, ROLLS, DESTROY, evolution, modulation generation | the project seed | `seed`, `seedText` |
| offline export (audio and MIDI) | the project seed (and the stored kit and modulation seeds) | no extra state |
| modulation sources (LFO S&H, random, step) | each source's own 0-9999 stream number | `sound.mod.sources.*.seed` |
| VARIATION, MUTATE, REGENERATE, MUTATE KIT/VOICE/VARIATION, random velocity | a fresh number per press | nothing: the result is stored, not the seed |

The last row is deliberate. Those are edits of what is already there, so the result depends on the
starting state and is kept in the project; they are not meant to be replayed from a seed.
Modulation source seeds are small stream numbers inside one track's modulation, set with the source,
and stay numbers.

Numbers that are derived from another seed (WILDCARD gives patterns and the kit seeds of their own)
carry no phrase. A phrase is stored only next to the number it names.

## What decides the result

The same **seed**, **generator version**, **parameters** (style, DENSITY, COMPLEXITY, VARIATION,
ACCENT, FILLS, BARS; TIMBRE; WILDCARD intensity, scope and categories, which is its "wildness"),
**character** (the style's kit flavour and the track roles) and **starting state** make the same
result. Where the starting state matters:

- GENERATE keeps locked tracks and hand edits, so the same seed over a different starting pattern
  differs on those tracks. The pattern stores its settings and seed so it can be seen again.
- REGENERATE keeps bar 1 and regenerates the rest from a fresh seed.
- GENERATE KIT and the sound generators skip locked voices, parameters and variations, and the kit
  generator starts from the current kit for any parameter it does not design.
- WILDCARD is a function of the whole project it starts from (and the selected track for scope TRACK,
  and the sample library for SAMPLES), so undo before pressing again; WILDCARD with a held seed after
  an undo reproduces the result exactly. A project with edits since is a different starting state.
- Conditional triggers and probabilities depend on the pass, which counts from the start of the
  pattern.

## Legacy compatibility

- A number is still a seed. A project from before phrases has only numbers; it loads with its
  numbers, no phrases and the same results (`test/seeds.test.ts` pins fingerprints of generator
  output for numeric seeds).
- Project schema is **version 5**. New fields are all optional: `seedText` (pattern, kit, timbre,
  project, wildcard), `seedHash` (default 1) and `generator` (default 1). Files of version 4 or
  earlier load unchanged; older CLATTERs refuse version 5.
- On load a phrase is kept only if its hash still equals the stored number (or the file says it was
  made with another hash version, in which case the phrase is just a label). A phrase that does not
  match is dropped and the number stays. The number is always the truth.
- Synth kits (`.clattersynth.json`), full kits and `.clatterkit.zip` carry `seedText` when there is
  one; files without it load as before. EXPORT KIT's `kit.json` lists `seedText` and
  `projectSeedText` when they exist.
- The factory presets keep their numeric seeds.

## Generator version

`GENERATOR_VERSION` (in `src/rhythm/seed.ts`, saved as `generator`) is the version of the generators'
decisions: what a seed, settings and starting state make. It is 1 for every project made so far (no
generator changed in Phase 4). Saved patterns, kits and sounds are stored, not recomputed from their
seed, so a project never changes when a generator is improved; the version is for the day a seed has
to be replayed (WILDCARD from a seed, reproducing a pattern) against a generator that has since
changed on purpose: bump it then, and keep the old behaviour behind the stored number.
