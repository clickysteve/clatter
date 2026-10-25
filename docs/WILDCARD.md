# WILDCARD

One button that varies the whole instrument. PATTERN > WILDCARD (key W).

- **Intensity** 0-100%: low is subtle, high is substantial. Safety limits hold at every level.
- **Scope**: selected track, selected pattern, entire kit, entire project.
- **Categories** (can each be left out): TEMPO, RHYTHM, TRIGGERS, SOUND, SAMPLES, MODULATION, FX,
  MIXER, OUTPUT. A scope only reaches the categories that make sense for it:
  track: rhythm, triggers, sound, samples, modulation, fx, mixer.
  pattern: rhythm, triggers, step sounds (not the kit).
  kit: sound, samples, modulation, fx, mixer (not patterns, tempo or output).
  project: everything, including tempo, swing and the output stage.
- **Seed**: the result is a pure function of the project, the settings, the seed and the track.
  Each press draws a new seed unless FIXED SEED is on; the seed of the last press is shown and
  can be typed to reproduce a result. TRY ANOTHER undoes the last WILDCARD and presses again.
- **Undo**: one undo step, tempo included, and redo brings it forward.

## Tempo

A tempo curve is a loop of points (bar, multiplier, optional ramp) over 1-64 bars that multiplies the
BPM, so the BPM control still scales it. The multiplier is limited to 0.5-2 (WILDCARD stays within about 1.5x) and the result
within 30-300 BPM (WILDCARD keeps it within 40-240). The tempo is constant inside 12-tick cells, so
playback, the playhead, MIDI clock, MIDI export (tempo map) and WAV export agree. The CURVE toggle
in the transport (and the pane) switches it on and off; CLEAR CURVE removes it.

## Guard rails

Values stay in range, locked tracks, voices and parameters are respected, at least one audible
track keeps a usable level, volumes and sends are capped, the limiter stays on, and the master
output cannot be pushed into clipping. Old projects load unchanged.
