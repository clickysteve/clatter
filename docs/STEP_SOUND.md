# Step sounds, variations and the SOUND workspace

CLATTER's sound is the real sound engine of the Erica Synths LXR-02 firmware (the `lxr.wasm` port, GPL-3.0). This document describes the
per-step sound system built on it: what the engine can and cannot do, how a step's sound is worked
out, how conditions count passes, how the generators behave, and where the limits are.

## What the engine allows (audit)

| Fact | Consequence |
| --- | --- |
| Six monophonic voices (DRUM 1-3, SNARE, CYMBAL, HIHAT; the hi-hat voice also plays the open hat) and **one global parameter set**. | A "different sound on one step" is a parameter change on the voice, applied just before that step's trigger and undone at the voice's next hit. |
| Parameters go through the firmware's own handler (`setParam`). Triggers land at 64-sample block starts. | Locks apply sample-accurately relative to the hit. There is no per-note parameter memory in the engine. |
| A voice cannot be re-modelled and a second instance cannot be added without firmware changes. | Not done. A step can **trigger another existing voice**; it cannot create one. |
| A monophonic voice that is still sounding is retriggered by the next hit. | Overlapping steps on one voice cut each other, as on the hardware. The lock of the earlier hit is replaced when the next hit applies its own. |

Nothing in the DSP was changed. The kit (the LXR parameters) is still the base of every sound, and
kit edits made while a lock is active are deferred and applied when the lock is released, so a
fader move is never lost and never leaks into a locked hit.

## Inheritance

A step inherits everything and overrides only what it names. Later layers win:

1. **KIT**: the LXR parameters of the project's kit.
2. **TRACK SOUND**: the track's voice (trigger), source (SYNTH, SAMPLE, HYBRID), tune, gain, and so on.
3. **VARIATION**: slot A-D of the track: a sparse set of parameters and sample settings. The step's
   `v`, or `alt.v` while the step's condition holds.
4. **STEP LOCKS**: fixed values on this step.
5. **CONDITIONAL RULES**: modifiers in the order written: `set`, `add`, `range`, `alt`, `evolve`,
   each behind its own condition.

Because every layer is sparse, changing a kit parameter changes every step that has not named it,
and changing a variation changes every step that uses it. The result is a flat list of
`(parameter, value)` pairs that travels with the hit to the engine.

## Conditions and the musical clock

Resolution is a pure function of `(project, hit, cycle, fill, seed)`. It runs on the main thread
when the hit is planned (the same place the rhythm is realised), so playback, offline export and a
reload all give the same sound. Nothing reads a wall clock or a UI counter.

* **Cycle `k`** is the number of passes of the pattern (of whichever pattern plays) since the
  transport started. Stopping and starting again returns to 0. Switching patterns does not reset it.
* Conditions, by pass number (`k` counts from 0, "pass" from 1):

| Condition | Holds when |
| --- | --- |
| ALWAYS | always |
| PROBABILITY p% | a keyed hash of `(seed, track, k, step)` is below p. The same pass always gives the same answer. |
| EVERY N | pass N, 2N, 3N ... (`k % N == N-1`) |
| FIRST OF N | pass 1, N+1, 2N+1 ... (`k % N == 0`) |
| LAST OF N | the same passes as EVERY N: the last of each block of N |
| ALTERNATE | every second pass (passes 2, 4, ...) |
| FILL | while a fill is held for the track (or the hit is a generated fill hit) |

* **RANDOM RANGE** rules draw a value in `[a, b]` from the same keyed hash, so a pass is repeatable.
* **EVOLVE** rules move a parameter from `a` to `b` over `n` passes and back (a triangle), so they
  are bounded and return to the base sound by themselves.
* The auditioning controls in the Step Sound editor (PASS, ▶ STEP, ▶ BASE) go through the same
  resolver with the chosen pass number, so what you hear is what that pass will play.

## Voice switching and conflicts

A step may trigger another LXR voice. The resolver then checks locks and variations against the
voice that actually plays (parameters that voice does not have are dropped). The sound stays in the
triggering track's mixer strip. Limits, stated plainly:

* The target voice is monophonic, so a switched step retriggers it.
* The LXR voices are not interchangeable: a kick locked onto the snare voice is the snare voice
  with the kick step's locks, not a new instrument.
* Sample tracks have no voice to switch; they get variations of tune, gain, pan, reverse and sample.

## The generators

All generators work on the tracks and steps in scope (the grid selection, else every track), are
seeded (same seed, same result), and are one undo step each.

* **GENERATE VARIATIONS** fills the slots A-D that are not locked with timbres designed for each track's role
  (a kick: PUNCH, DEEP, FM, DIRTY; a hat: TIGHT, BRIGHT, METAL, GRIT; and so on). Moves are expressed
  in the firmware's own parameters and kept inside audible ranges.
* **DISTRIBUTE** assigns variations to steps by role: a kick keeps its main sound on the beat, a
  hi-hat varies often and subtly, percussion roams. Higher TIMBRE adds small locks, conditional
  alternatives and random ranges.
* **MUTATE SOUND** redraws a share of the step sounds of the hits. The rhythm never moves and EVOLVE
  glides on the redrawn steps are kept.
* **EVOLVE SOUND** adds bounded glides over 8 passes. END EVOLUTION removes only them.
* **GENERATE SOUND** is GENERATE VARIATIONS then DISTRIBUTE. **MUTATE BOTH** mutates the rhythm and the sound.
* **TIMBRE** (0-100%) is a designed curve: 0 nothing; 25 subtle (a few weak hits get tiny decay and
  pitch shifts); 50 noticeable; 75 strong; 100 experimental, still inside DSP limits.

A step sound or variation is just a sound, whoever made it, and the generators write over it (one
undo restores the previous ones). What they never touch: locked tracks, locked variations, locked
voices and locked parameters, and the rhythm. CLEAR VARIATIONS and CLEAR STEP SOUNDS empty them.

## Where things live

* SOUND view: a persistent track sidebar plus SYNTH, SAMPLE, MODULATION, VARIATIONS, MIXER, FX and KITS tabs (see MODULATION.md).
  Each tab scrolls inside its pane; the page does not. The open tab is remembered.
* PATTERN view: the STEP SOUND tab under the grid and the grid markers. Select a step in the grid (a note or an empty step) and the tab shows it.
* PERFORM view: NEW SOUNDS and MUTATE SOUND pads (quantised) and a TIMBRE macro.
* Grid markers: a plate at the top right names the variation (A-D), `?` means a condition decides,
  `>` means another voice is triggered; a corner triangle means locks or rules. Hover for the words.

## Persistence, export, MIDI

* Projects are version 2 (additive: version 1 files load unchanged). Load repairs anything
  malformed (unknown parameters, out-of-range values, bad conditions) rather than rejecting the file.
  Variations and step sounds are part of snapshots, undo/redo.
* Offline export (master and stems) runs the same resolver and engine path as playback; a test
  renders both and compares them.
* **MIDI**: notes carry pitch and velocity only. CLATTER does not send per-step LXR parameters over
  MIDI (the LXR hardware takes them as NRPN/CC, which this app does not emit), so variations, locks
  and rules are heard only in CLATTER's own engine. The SMF export contains the rhythm as
  before. A voice switch is not expressed in the MIDI file either.

## Examples

* A hi-hat with a lock on filter cutoff at 40 and a rule "ALTERNATE: decay 20 / 80": the cutoff is
  fixed on that step and the decay flips every pass.
* A kick step: sound A on the beat, and "IF EVERY 4 → BASE": the punchy variation plays three times
  in four and the plain kick every fourth pass.
* A snare roll step with "IF FILL → C": variation C only while FILL is held.

## Attribution

The engine is the Erica Synths LXR-02 firmware's sound engine compiled to WebAssembly, under GPL-3.0
with the firmware's additional terms; this project is GPL-3.0-only and is not an Erica Synths
product. See `docs/LXR_PORT.md`, `NOTICE.md` and `THIRD_PARTY_NOTICES.md`.

## Screenshots (90 % interface scale)

* `docs/img/sound-synth-1440x900.png`: SOUND, SYNTH tab with variation A open, at 1440 × 900.
* `docs/img/pattern-step-sound-1440x900.png`: PATTERN with the STEP SOUND tab and step markers.
* `docs/img/sound-modulation-1366x768.png`: SOUND, MODULATION tab at 1366 × 768.

## Modulation in variations and step sounds

Since the SOUND overhaul a variation may also override the track's modulation (a sparse patch,
`Variation.mod`; see [MODULATION.md](MODULATION.md)). A step that names a variation (or switches
to one under a condition) therefore plays that variation's modulation as well as its parameters.
Step locks and modulation can share a parameter: modulation moves around the locked value, and
the kit value returns at the voice's next hit.
