# Conditional triggers

Every step can carry a condition that decides whether it plays on this pass of its pattern. Set
it in PATTERN > TRIGGER; a small mark in the corner of the cell shows which steps are
conditional, and a step silenced by its condition on the current pass is drawn hollow.

## Conditions

ALWAYS (default, not stored), PROBABILITY 0-100, EVERY N ON M, FIRST CYCLE, LAST CYCLE, ODD CYCLES,
EVEN CYCLES, ALTERNATING (RUN passes on, RUN passes off), FILL ONLY, NOT FILL, PREVIOUS PLAYED,
PREVIOUS NOT PLAYED.

## The pass counter

A pass is one run of a pattern from its first step to its last. The counter starts at 0.

- A pattern that repeats (looping, or a chain entry with repeats) counts up.
- Switching to another pattern starts that pattern at pass 0.
- Returning to a pattern after another one starts it at pass 0 again.
- Starting playback, and starting an export, begin at pass 0.

So a two-bar pattern exported for eight bars has four independent passes (0 to 3). ODD plays on
passes 1 and 3 (the 1st and 3rd), EVEN on 2 and 4, EVERY 4 ON 4 on the 4th only.

The older sound-variation conditions keep their meaning (passes since the transport started).

## Details worth knowing

- PROBABILITY is a keyed hash of project seed, pattern, track, pass and step. Playback and export
  agree, and the same project always plays the same way.
- LAST CYCLE needs a known length, so it plays in an export (and a MIDI export) and stays silent
  while playing live.
- FILL ONLY follows the held FILL in PERFORM. It is silent in an export; NOT FILL always plays there.
- PREVIOUS PLAYED looks at the step before on the same track: it holds a hit and its own
  condition passed. At the first step of a pass it looks at the last step of the pass before
  (never on the first pass), resolved one level deep.
- Conditions are decided first. Only a step that plays then resolves its sound variation, so
  conditions and variations are independent.
- Conditions follow their steps when a pattern is lengthened, shifted or changes resolution,
  and when steps are copied and pasted.
- Projects without conditions load unchanged (project version 4 only adds optional fields).
