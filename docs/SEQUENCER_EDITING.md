# Sequencer editing (PATTERN grid)

Pointer gestures live in `src/ui/stepGesture.ts` (a state machine with no DOM, tested in
`test/editing.test.ts`). The grid (`src/ui/grid.ts`) turns pointer events into steps and feeds it.
Every gesture is one undo step; selecting is not an edit.

| Gesture | Effect |
| --- | --- |
| Click an empty step | A hit at the NEW HIT VELOCITY, heard at once |
| Click a hit | Removes it |
| Press, drag up / down | Velocity of the pressed hit (a new one or an existing one), up is louder, one pixel is one step, 1-127. A `VEL n` plate and a gauge show the value. |
| Press, drag sideways | Paints hits along the track the gesture started on. Existing hits stay. Steps a fast pointer skips are filled. |
| Shift-drag | Erases hits along the track |
| Shift-click | Selects from the step being edited to the clicked step (again: extends from the same anchor) |
| Alt-drag | Selects a region |
| Click or drag in the bar header | Selects whole columns |
| Shift + Up / Down | Louder / softer by 8 (selection, else the step being edited) |
| Cmd/Ctrl A, C, V, Delete, Esc | Select all, copy, paste, clear, clear selection |

The first movement beyond 4 pixels decides sideways or vertical for the rest of the gesture, so painting
never changes a velocity and a velocity drag never paints. A gesture only touches its own track. Pointer
capture keeps it going when the pointer leaves the step, the row or the grid; losing the pointer ends the
gesture and keeps what was done as one undo step.

## Selection and tools

The selection is a rectangle (`app.ui.sel`). The VELOCITY TOOLS card (SEQUENCE tab) and the existing
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
