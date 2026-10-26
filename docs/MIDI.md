# MIDI

CLATTER plays external instruments, is played by controllers, sends and follows MIDI clock, and
drives external parameters from its modulation. Everything lives in one window:
**MIDI ▸ MIDI settings…** (or click the MIDI indicator at the right of the menu bar).

Nothing here is required: without Web MIDI (Safari) or a device, CLATTER plays its own sounds.
Use Chrome, Edge or Firefox for MIDI.

## The window

Five sections, side by side:

| Section | What it holds |
|---|---|
| **INPUT** | Device (one, **ALL INPUTS**, or none), channel filter (**OMNI** or 1-16), NOTES IN, RECORD, velocity sensitivity and the fixed level, an activity light, the last message and a small monitor |
| **OUTPUT** | Device, NOTES OUT, PANIC, an activity light; **CC OUT**: the four MIDI CC destinations of the modulation |
| **CLOCK & TRANSPORT** | INTERNAL / EXTERNAL / OFF, SEND CLOCK, SEND TRANSPORT, FOLLOW START/STOP, PAUSE / CONTINUE, the clock status |
| **TRACK ROUTING** | Per track: INT / MIDI / BOTH, output channel, note (with its name), length (AUTO or ms); the same for ALL TRACKS |
| **MIDI LEARN** | Per track: the incoming note that plays it, LEARN, duplicates (DUP); reset to GM DRUMS or PADS C1+; the four macros' CCs |

## Input

- **Device.** One input, or ALL INPUTS (every connected input, following plugging and
  unplugging). A remembered device is found again by id, or by name when its id changed (another
  USB port). A missing device is shown as NOT CONNECTED; nothing breaks.
- **Channel.** OMNI hears every channel; a channel number only that channel. Clock and transport
  are never filtered.
- **Note map.** Each track has an input note. CLATTER does **not** assume General MIDI: the
  default is GM drums, **PADS C1+** maps consecutive notes from C1 (36) as most pad controllers
  send, and **LEARN** takes the next note you play. A note mapped to two tracks plays both and is
  marked DUP. An unmapped note plays nothing and shows as UNMAPPED in the monitor.
- **Velocity.** Sensitivity 100 % plays what you play; 0 % plays every note at the FIXED level;
  in between blends. It is applied once, before the hit reaches the engine, so SYNTH, SAMPLE and
  HYBRID tracks and velocity modulation all see the same velocity.
- **Macros.** M1-M4 LEARN binds the next CC to a macro; alt-click forgets it.
- **Monitor.** The last messages (note, channel, velocity, the tracks played), updated a few
  times a second while the window is open; the status bar shows activity lights.

Note names use the convention where middle C (60) is C3, as many drum machines do (36 = C1).

## Output

Each track is **INTERNAL** (CLATTER's own sound), **MIDI** (the note only; CLATTER's sound for that
track is silent) or **BOTH** (the default, as CLATTER always did when an output was chosen). The
routing is independent of the track's SYNTH / SAMPLE / HYBRID source.

The notes are exactly the hits CLATTER plays: after conditional triggers, probability, density,
fills, swing, CHOP, ROLLS, DESTROY and evolution, from the same scheduler, with the same
timestamps (Web MIDI timestamped sends, inside the scheduler's lookahead). Mute and solo apply;
a conditional step that does not play sends no note. Sound variations and step sounds never
change a track's MIDI note.

Every note-on is sent with its note-off (length: AUTO = the hit's gate, else half a step; or a
fixed length). Notes end at once when a track is muted, its routing, channel or note changes,
the output device changes, playback stops, or **PANIC** is pressed (every note CLATTER started,
then All Notes Off and All Sound Off on all 16 channels). A device that disappears is forgotten
without sending to it; when it returns it is used again.

## Clock and transport

- **INTERNAL.** CLATTER keeps time. With SEND CLOCK it sends 24 pulses per quarter, following
  tempo changes and the tempo curve exactly (the pulses come from the same tempo map as the
  notes). With SEND TRANSPORT it sends Start (or Song Position then Continue after a PAUSE),
  Stop, and Song Position 0 on stop.
- **EXTERNAL.** CLATTER follows incoming clock. The tempo is estimated by least squares over up
  to two beats (The Breakery's estimator) and a phase lock nudges CLATTER's own scheduler (by at
  most 5 %) so that pulse *n* of the master lands on CLATTER's tick *n* × 4. Audio keeps its
  sample-accurate timing: CLATTER is tempo-following, not pulse-stepped. Start plays from the top
  on the next pulse, Continue from where Stop left off (or a received Song Position), Stop stops.
  With FOLLOW START/STOP off only the tempo is followed. A clock that stops arriving for half a
  second is **LOST**: CLATTER freewheels at the last tempo and relocks to the nearest pulse when
  it returns.
- **OFF.** No clock is sent or followed.

**Tempo automation and the external clock.** While CLATTER follows an external clock, the
project's BPM and its tempo curve are **suspended, not lost**: the transport shows `EXT` and the
measured tempo; a BPM change (by hand or WILDCARD) is stored for later. Switching back to
INTERNAL restores the project's tempo and curve from the next scheduled moment.

**PAUSE / CONTINUE** (⇧SPACE, or in the window) stops keeping the position (on a sixteenth) and
continues from it, sending Song Position and Continue.

## MIDI CC out from modulation

The modulation matrix has four extra destinations, **MIDI CC 1-4** (group MIDI OUT), on every
track. Route any source to one (an LFO, an envelope started by the track's hits, the step
sequencer, a macro…). In the window, each destination has a CC number, channel, BASE value (the
value with no modulation; 64 centres a bipolar source), RES (how many distinct values: 128 = all,
fewer = coarser steps and fewer messages), HZ (the most messages per second) and a device (MAIN =
the output device, or any other output).

The CC value is `BASE + (sum of the routes to it) × 127`, clamped to 0-127. It is computed on
the main thread, never in the audio thread: a copy of the same modulation runtime the engine uses
runs for each track with a CC route, advanced in 5 ms steps up to the scheduler's lookahead and
fed with the track's hits at their scheduled times. A value is sent only when it changes and no
sooner than the rate allows; a source that holds still sends nothing; a destination nothing
routes to never sends. Variation modulation overrides do not apply to CC destinations (the base
modulation drives them). The random modulation generators never choose a MIDI destination.

## What is saved where

| Per browser (preferences) | In the project (portable) |
|---|---|
| Input and output devices (id and name), CC devices | Track routing (INTERNAL / MIDI / BOTH), channel, note, length |
| Input channel filter, NOTES IN / OUT, velocity sensitivity | The four CC destinations (CC, channel, base, resolution, rate) |
| The input note map, macro CCs | |
| Clock mode, SEND CLOCK / TRANSPORT, FOLLOW START/STOP | |

A project opened on another computer (or by CLATTER Pocket) carries its musical routing with
stable identifiers and never tries to reach devices that are not there. Projects from before
these settings load unchanged (every track BOTH, no CC destinations). The first MIDI preferences
(`outId`, `inId`, `clockIn`, `clockOut`) are migrated.

## Code

| File | Role |
|---|---|
| `src/midi/settings.ts` | Preferences and project data, repair and migration, device lookup, velocity, duplicates |
| `src/midi/input.ts` | Channel filter, note map, MIDI Learn, macros, monitor |
| `src/midi/router.ts` | Track notes out, per-track release, note lengths |
| `src/midi/output.ts`, `webmidi.ts`, `messages.ts` | Note-safe output, Web MIDI access (ALL INPUTS, extra sinks), messages (after DOWNBEAT) |
| `src/midi/clock.ts` | Tempo estimate, external transport, clock loss, the phase lock (after The Breakery) |
| `src/midi/ccOut.ts` | MIDI CC out from the modulation matrix |
| `src/midi/controller.ts` | Ties them together for the app |
| `src/ui/midiDialog.ts` | The window |

Slop Factory Core's MIDI module is interfaces only; CLATTER implements `MidiOutputPort`,
`ClockFollower` and the `LearnMapping` source shape, as its roadmap asks of applications before
code moves into Core.

## Tests

`test/midi.test.ts` (device lookup and persistence, channel filtering, mapping, learn,
velocity, routing in the app, note-on/off, mute and stop, panic, conditional triggers, clock
in, the phase lock, clock out with tempo automation, transport, external clock precedence, CC
out) and `e2e/midi.spec.ts` (the window, learn, sequencing, clock out and an external master,
disconnection) against a **virtual** Web MIDI device. No hardware was used to test this.
