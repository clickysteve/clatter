# Sound Discovery

SOUND > DISCOVER finds new sounds for the selected instrument without touching it. It makes eight
candidates, lets you hear each one through the real LXR engine, compare it with the original,
mutate it, save it, and apply it. Nothing changes until APPLY.

There is no second synthesis or mutation engine. A candidate is made by the kit generator
(`designVoice`, `src/sound/kitgen.ts`) and mutated by the kit mutation (`mutateKit`); Discovery adds
the candidate browser around them (`src/sound/discover.ts`, `src/app/discover.ts`,
`src/ui/views/soundDiscover.ts`).

## What a candidate is

One LXR voice: every synthesis parameter of the voice, its LFO and velocity targets. It is held by
the parameter's name (`decay`, `cutoff`, `fmAmt`...), not by number, so it can move to another voice
and into the library. Candidates are made for the voice of the selected track. A voice shared by
several tracks changes for all of them when applied, and the tab says which tracks share it. A sample
track has no voice, so there is nothing to discover on it.

## Controls

| | |
|---|---|
| CHARACTER | the sound world: the kit generator's flavours MACHINE, ELECTRO, ACOUSTIC, INDUSTRIAL, GLITCH, DUB. STYLE follows the rhythm style. |
| WILDNESS | 5 to 100 %. How far a candidate goes from the current sound. |
| SEED | the seed of the next DISCOVER 8 (a phrase or a number, see SEEDS.md). |
| DISCOVER 8 | eight new candidates. Held candidates stay. |
| NEW | draw one slot again: same seed, next draw. |
| HOLD | keep this candidate through the next DISCOVER 8. |
| BACK | return a slot to what it held before its last MUTATE, NEW or LOAD. |
| MUTATE | mutate the selected candidate. The child takes its slot; press again to keep going. |
| VS | compare the selected candidate with this one instead of the original. |
| APPLY | write the candidate into the instrument. One undo step. |
| SAVE | save the candidate to the sound library. |
| PITCH | measure the original and the candidates (see Pitch). |

### Wildness and character

A candidate is the generator's own design of the voice for the CHARACTER, drawn back towards the sound
it replaces by `1 - wildness`: at 100 % it is the generator's design, at 10 % it is the current voice
moved a little. Menus (waveforms, filter types) are taken whole or left, never blended. Parameter locks
hold: a locked parameter has its current value in every candidate and is never overwritten by APPLY.
MUTATE uses WILDNESS as the mutation amount and the CHARACTER's archetype bounds, so a mutated
candidate never goes silent or loses its low end.

After they are designed, candidates go through the engine check that GENERATE KIT uses (levels
matched, inaudible voices redesigned), so candidates are level matched and A/B is fair.

## Audition and A/B

A hit is rendered offline by a private LXR engine on a copy of the project with the candidate in place
(the same render DRUM HITS and the TUNER use: the real engine, the track's own modulation and
processing), and played on its own. The live engine, the kit being played and the sequencer are never
sent anything, so the running pattern carries on and does not change. One audition plays at a time: a
new one fades the old one out, and a click that is superseded before its audio is ready is cancelled.
Rendered audio is cached by the sound's fingerprint, so switching between the two sides again is
instant.

Side A is the original (the live instrument as it is now, so it follows an APPLY or UNDO) or a candidate
chosen with VS. Side B is the selected candidate. The tab says which is playing: `NOW: B · 3`.

## Applying and undo

APPLY writes the candidate's voice into the kit (locked parameters keep their values) and records where
it came from in the project (`discovered`, schema version 6). It is one undo step labelled APPLY
CANDIDATE; UNDO brings the original back, REDO the candidate. A candidate loaded from the library with
modulation and variations (MOD+VARS) can bring them with it; UNDO takes them away again.

## Pitch

Pitch uses the TUNER's analysis (`src/analysis`) and its fingerprint cache. Nothing is analysed behind
your back: PITCH measures the original and each candidate once, and an audition measures the sound you
heard once. A result is kept until anything that can change the sound changes. A note is shown only
where the analysis found one it trusts. Unpitched sounds show NOISE, inharmonic ones INHARM, silent ones
SILENT, and a low-confidence result NO NOTE. A sweeping drum shows its body pitch with a down arrow.
For a HYBRID track the synth layer is measured, because the candidate is the synth voice.

## Seeds

The batch seed is the DISCOVER seed field (phrase or number, held or fresh each press). Candidate `i`
draw `d` is a function of the seed, the voice, `i` and `d`, so the same seed, character, wildness, voice,
starting sound and locks make the same eight candidates. Each candidate remembers `origin`: the seed and
its phrase, slot, draw, character, wildness, voice, archetype, each MUTATE (its seed and wildness), a
fingerprint of the voice it was drawn from and the generator version. `reproduce()` makes the candidate
again from that. A MUTATE is itself a function of the candidate, so repeating it repeats.

## Sound library

SAVE keeps a candidate in the browser (`localStorage`, key `clatter.sounds`) and in portable
`.clattersound.json` files. A saved sound holds every parameter of the voice, its LFO and velocity
targets, the seed metadata, its pitch when it was measured (never an unreliable note), and the modulation
and variations of the track when saving the original or a candidate that is the live sound. It holds no
samples, no other voices, no FX bus, mixer or rhythm. Variations are held by parameter name and
modulation by destination id, so a sound moves to another voice: parameters the voice does not have are
left out, and modulation routes to destinations the voice does not have are dropped.

LOAD puts a library sound in a candidate slot (the selected one when all eight are used), never
into the instrument. RENAME, DELETE, EXPORT (one) and EXPORT ALL / IMPORT work on the file. Import
repairs what it reads: values are clamped, unknown parameters and damaged sounds are skipped and
counted, files from a newer CLATTER are refused.

## Limits

* LXR voices are monophonic and shared: applying a candidate changes every track on that voice.
* The engine check runs on the voice with the kit as it is; the level it settles on is for a hit at the
  default velocity.
* Candidates are not stored in the project, only what was applied. Reload the page and the batch is gone;
  the seed brings it back.
