# Sound workspaces, modulation and the mixer

This document describes the SOUND overhaul: the eight workspaces, the modulation engine, how
modulation shares the six LXR voices, how variations carry modulation, the mixer and output
stage, the file formats, and what remains out of reach.

## The workspaces

The SOUND view keeps its track sidebar (name, source mode, mute, solo, meter) and its transport.
Seven workspaces sit beside it, each laid out to fit the window without page scrolling (a pane
scrolls inside itself when it must):

| Tab | What it is for |
| --- | --- |
| SYNTH | The track's source (SYNTH, SAMPLE or HYBRID), BASE / A-D, the LXR voice's parameters. |
| SAMPLE | The sample layer of the base sound or of the variation being edited, and sample sets. |
| MODULATION | Sources, the source editor, the routing matrix, presets and generation. |
| VARIATIONS | BASE against A-D (overrides, step usage, conditional steps), the sound generators. |
| MIXER | Ten channels with processing, bus processing and the master. |
| FX | The LXR FX bus and which tracks feed it. |
| KITS | Synth kits, sample sets, full kits, kit generation and mutation, voice locks. |

Variations and generation moved out of MODULATION into VARIATIONS. The native LXR LFO and
velocity groups (firmware modulators, one target each) stay in SYNTH.

## Modulation sources

Every track has its own set of sources. A source modulates nothing until a route uses it.

* **LFO 1-4**: sine, triangle, saw up, saw down, square, variable pulse (width), sample and hold,
  stepped random, smooth random, and a custom drawn wave (64 points, drawn on the plot). Free
  rate (Hz) or tempo-synced (16 divisions from 4/1 to 1/32T, dotted and triplet), start phase,
  depth, offset, unipolar or bipolar, skew/width, bend, seed, and four retrigger modes:
  every hit, free run, bar line, pattern start (the last two align the phase to the bar or the
  pattern at each hit).
* **Envelope 1-2**: ADSR, AHDSR, or a multistage envelope with up to eight breakpoints (time,
  level, curve each) and a loop between two points. Times in milliseconds or in beats. A
  sustain time (drum hits have no note-off), a curve, a trigger filter (every hit, accents,
  ghost notes) and a retrigger rule (restart, continue, ignore).
* **STEP**: a step modulation sequencer of 1-32 steps with its own clock division, direction
  (forward, reverse, ping-pong, random), glide and restart rule, independent of the pattern.
* **RANDOM** (clocked random), **SMOOTH** (smooth random) and **S&H** (samples noise or another
  source on its clock). All are seeded: the same seed plays the same values.
* **VELOCITY** (the hit's velocity) and **TRIGGER** (a pulse at each hit that decays).
* **MACRO 1-4**: performance knobs shared by every track, saved with the project.

A source's plot is not a drawing of its settings: it is the output of the same `ModRuntime`
that plays the track, simulated for one cycle. While the tab is open the audio engine reports
the selected track's source outputs, route values and destination sums, and the markers, meters
and bars follow them.

## The routing matrix

A route has a source, a destination, an amount (-100 to +100 %), a polarity (as is, invert,
unipolar), an enable switch, a range (the lowest and highest contribution it may make) and a
smoothing time. Several routes into one destination sum and clamp to -1..1; one source can feed
any number of routes. A route into a destination the track does not have (after changing its
voice) is shown hatched and ignored.

Destinations live in one registry (`src/mod/registry.ts`) with stable ids. Each is classified:

* **continuous**: written every control block (about 1.45 ms) while the sound plays.
* **trigger**: read once when the hit triggers (the LXR firmware only reads these at the
  trigger, so modulating them continuously would be a fake control).

Which parameters of the engine really respond while a voice sounds was measured against the
real firmware (`test/modengine.test.ts` renders each destination); anything that does not
respond is not listed.

| Id | Class | Notes |
| --- | --- | --- |
| `lxr.osc.coarse`, `lxr.osc.fine`, `lxr.osc.pwm` | continuous | PWM is audible with the pulse waveform |
| `lxr.fm.amount`, `lxr.fm.freq` | continuous | toms (voices 0, 1) |
| `lxr.mod1.freq/amount`, `lxr.mod2.freq/amount` | continuous | hi-hat voice only |
| `lxr.noise.freq`, `lxr.noise.mix` | continuous | snare/clap family |
| `lxr.pitch.amount/decay/slope` | continuous | |
| `lxr.amp.decay`, `lxr.amp.slope` | continuous | |
| `lxr.amp.attack`, `lxr.amp.repeat` | **trigger** | read at the hit |
| `lxr.transient.level/pitch` | continuous | |
| `lxr.filter.cutoff/reso/drive` | continuous | resonance needs a resonant filter type |
| `lxr.voice.drive`, `lxr.voice.volume`, `lxr.voice.rate` | continuous | |
| `lxr.voice.pan` | **trigger** | |
| `smp.pitch`, `smp.gain`, `smp.pan` | continuous | the sample layer bends while it plays |
| `smp.start` | **trigger** | position inside the region |
| `hyb.blend` | continuous | crossfade of a HYBRID track |
| `trk.volume`, `trk.pan`, `trk.filter`, `trk.send` | continuous | mixer parameters, before the fader |

## Shared LXR voices

The LXR has six monophonic voices and one global parameter set; CL HAT and OP HAT share a
voice. Modulation must not leak between the tracks that share one:

1. **Independent modulation**: every track has its own `ModRuntime`; sources never read each
   other across tracks.
2. **Ownership**: the last track to trigger a voice owns its LXR modulation. When another
   track triggers the voice, the engine first restores every modulated parameter to its base
   value (the kit value, or a step lock if one is active), then applies the new owner's step
   locks and modulation.
3. **Determinism**: simultaneous triggers are processed in track order, so the same pattern
   always gives the same owner at every instant (tested: two runs are bit-identical).
4. **Sample and track destinations** are per-track and never shared.

The remaining honest limit: the LXR cannot play two sounds on one voice at once, so while one
track owns a voice the other's continuous LXR modulation is not running (its sample layer and
track destinations are unaffected).

## Variations

`TrackSound.mod` is the base modulation. A variation stores a **sparse patch** (`Variation.mod`):
only the fields that differ (`{ routes: { r1: { amt: -0.5 } } }`), `null` to remove a source or
route, a new route id to add one. Everything else is inherited, so changing the base later
changes every variation that did not override it. A hit carries its variation (0 = base, 1-4 =
A-D) to the engine, which keeps one resolved configuration per slot and switches on the hit;
the previous slot's modulation is released first, so nothing leaks. Switching to another
variation restarts its sources; repeating a slot keeps free-running sources running.

## Presets and generation

Factory presets: wobble, metallic, breathing, unstable, evolving, percussive pitch drop, random
filter movement, rhythmic FM, slow timbral drift, stepped modulation. They are *recipes*: each
route lists preferred destinations and the first one the track has wins, so a preset builds
sensible routes for a kick, a hi-hat, a sample or a hybrid track. User presets are saved,
duplicated, renamed, deleted, exported and imported as `.clatter-mod.json` files. GENERATE makes
reproducible musical random modulation (seeded from the project seed, with an amount), MUTATE
nudges what is there, RANDOMISE changes one source.

## Mixer and output stage

```
track → one-knob filter → CHANNEL PROCESSING
        (transient, EQ, saturation, soft clip, bit reduction)
      → fader and pan → dry to the bus, and/or send to the LXR FX bus
bus sum + FX return → BUS PROCESSING (filter, distortion, compressor, stereo)
      → Slop Factory output chain → master gain → width → soft clip → limiter → out
```

Every stage that is off is not called, and a bypassed chain is bit-identical to none. Nothing
allocates while processing and nothing adds latency (the limiter reacts within the sample and a
final clamp guarantees the ceiling). Output routing per track is MAIN (dry, plus the send) or
FX ONLY (through the LXR FX bus, no dry sound).

## Files and compatibility

* Project schema **version 3**. New optional fields: `macros`, `Track.sound.mod`,
  `Variation.mod`, `TrackMix.send` and `.fx`, `MasterSettings.out`. Versions 1 and 2 load
  unchanged and sound as before: a project without `master.out` plays with `legacyOutputFx()`
  (limiter off, width 1), which is bit-identical to the old output; new projects get the limiter
  on at -0.3 dB.
* Synth kit files version 2 carry each track's modulation and variation patches; version 1 files
  still load and leave a track's modulation alone. Full kits carry the mixer (send, channel
  processing, output routing). Loading one half of a kit never touches the other half or the
  patterns.
* The **portable modulation format** `clatter-mod` v1 (`src/mod/format.ts`) is plain JSON with
  stable ids for sources, destinations and routes. It says what modulates what and not how a
  platform runs it. `Capabilities` describes an executor (sources, destinations, waveforms, route
  count, multistage envelopes, custom waves, control rate); `unsupported()` names what a platform
  cannot run and `reduceTo()` degrades a configuration to what it can (unsupported parts dropped,
  nothing else touched). The browser is the full executor; CLATTER Pocket (the hardware port)
  can implement a subset and load the same files.

## Determinism

Sources that depend on the clock (free-running LFOs, random sources) start from the engine's
frame time, so a live render and an offline export started at a different moment differ in the
phase of free-running sources. Retrigger modes HIT, BAR and PATTERN are deterministic: the same
pattern gives the same modulation on every pass, in playback and in export.

## Limits

* The LXR firmware's own LFO and velocity targets (SYNTH tab) are untouched; they are not
  routed from the matrix.
* Modulation runs at control rate (one step per 64-frame block). Audio-rate modulation would need
  firmware changes.
* One LXR voice cannot sound two tracks at once (see above).
* The hi-hat's open decay is read at the open trigger only.
