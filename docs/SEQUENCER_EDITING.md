# Sequencer editing (PATTERN grid)

Pointer gestures live in `src/ui/stepGesture.ts` (a state machine with no DOM, tested in
`test/editing.test.ts`). The grid (`src/ui/grid.ts`) turns pointer events into steps and feeds it.
Every gesture is one undo step; selecting is not an edit.

| Gesture | Effect |
| --- | --- |
| Click an empty step | A note at the NEW HIT VELOCITY, heard at once, and the step is selected |
| Click a note | Removes it (with its step sound and trigger condition), one undo step. A press that moves past the drag threshold (4 px, 10 px for touch) is a drag instead and never removes the note |
| Right-click a step | Selects it (note or empty) and opens the step editor |
| Press, drag up / down | Velocity of the pressed hit (the hit stays) (a new one or an existing one), up is louder, one pixel is one step, 1-127. A `VEL n` plate and a gauge show the value. |
| Press, drag sideways | Paints hits along the track the gesture started on. Existing hits stay. Steps a fast pointer skips are filled. |
| Shift-drag | Erases hits along the track |
| Shift-click | Adds the step to the selection, or takes it out again |
| Alt-drag | Selects a region |
| Click or drag in the bar header | Selects whole columns |
| Shift + Up / Down | Louder / softer by 8 (selection, else the step being edited) |
| Delete / Backspace | Deletes the selected notes (the step being edited when nothing else is selected) |
| Cmd/Ctrl A, C, V, Esc | Select all, copy, paste, clear selection |

The first movement beyond 4 pixels decides sideways or vertical for the rest of the gesture, so painting
never changes a velocity and a velocity drag never paints. A gesture only touches its own track. Pointer
capture keeps it going when the pointer leaves the step, the row or the grid; losing the pointer ends the
gesture and keeps what was done as one undo step.

## Selection and tools

The selection is a rectangle (`app.ui.sel`: Alt-drag, the bar header, select all) or a set of steps
picked one by one with Shift-click (`app.ui.picks`); `app.selectedCells()` is whichever is active. The
playhead and playback never change it. The VELOCITY TOOLS card (SEQUENCE tab) and the existing
VEL -/+ and CHANCE buttons act on the hits in it, else on the whole selected track: SET, -8 / +8, RAMP
(first to last hit, per track), RANDOM (range, a new roll each press, seeded so undo/redo is exact).
They live in `src/rhythm/velocity.ts` and change only the velocity: chance, pitch, ratchet, flam, step
sound and trigger condition stay. Copy and paste carry hits, step sounds and trigger conditions; paste
lands at the selection, else at the step being edited, and selects what it pasted.

## Reading the grid

Block height is velocity; an empty step has a short rule at its foot; an outline is written but silent;
the corner triangle is locks or rules; the plate is variation letter, `?` for a conditional sound and `>`
for a voice switch; the bottom-left right-angle is a trigger condition; a frame round each hit marks the
selection; the tinted column is the playhead.

## Conditional trigger feedback

While playing, each conditional step the playhead has passed on this cycle gets a mark in its top-left
corner: solid when it played, hollow when the condition held but the hit stayed silent (chance, density),
crossed when the condition skipped it (the step just skipped is crossed across the whole cell). Steps whose
sound switches by condition show the variation that sounds now. The marks read the realisation the
scheduler plays (`CELL_CONDITION` from `realize`, `trigOutcome` in `gridModel.ts`) and the same
`resolveStepSound` call the engine uses for the hit, so nothing is simulated in the UI.

## One pattern

A pattern is one grid of hits per track (`Pattern.grids`). There is no generated baseline and no edit
overlay: GENERATE, MUTATE, VARIATION, REGENERATE, WILDCARD and every hand edit write the same grids, so a
note is just a note whatever made it, and one UNDO restores whatever was there before. Step sounds,
trigger conditions and variations work the same way: a generator overwrites them, and only a lock
(track LOCK, variation lock, voice and parameter locks) protects anything. CLEAR PATTERN empties the
current pattern (notes, step sounds and conditions) and is one undo step. There is no Sound Lane: the main
grid selects the step and the STEP SOUND tab shows it, empty steps included.

## Status line

The line under the grid is one fixed-height line that never wraps: the selected (or pointed-at) track and
step come first, the short gesture hint gives way before them and truncates with an ellipsis. The full
gesture guide is in the ? KEY dialog.

## LIVE REGEN

GENERATE > LIVE REGEN is the playback feature that used to be called EVOLVE. RHYTHM and SOUND are
switches; EVERY n BARS and AMOUNT set how often and how far; RETURN sends the rhythm back to the pattern
as written after that many regenerations. Each regeneration is a seeded mutation of the pattern as it
stands (locked tracks are left alone), so a note you add shows in the next one, playback and export agree
(both realise through `src/rhythm/realize.ts`) and the same seed gives the same result. The grid shows the
cycle being played. The pattern itself is never rewritten: stop and it is as you left it.

## Projects

Schema version 8. A project saved before it holds `gen` (baseline) and `edits` (step to hit, or null for a
deletion) per pattern: loading lays each edit over the baseline and keeps the result as `grids`, so every
audible step, velocity, condition, step sound and variation survives. The `gen` provenance flags on
step sounds and variations are dropped.
