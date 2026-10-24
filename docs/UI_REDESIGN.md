# Interface redesign: audit, decisions, how to read the grid

This document records what was wrong with CLATTER's first interface, what the grid's symbols
actually meant, and the structure that replaced it. The aim: keep the 1980s Atari GEM / emmm
look (black desktop, white windows with heavy frames and slanted title tabs, dithered fills,
inverted selections, pixel type) and make an instrument that is comfortable for hours.

## 1. Audit of the first interface

**The root cause was the layout system, not the font sizes.** Every window was placed with
absolute coordinates (`left`, `top`, `width`, `height`) in a fixed logical screen of 1280 × 800
pixels, and the whole screen was then scaled with a CSS `transform` to fit the browser window.
Consequences:

| Finding | Where |
| --- | --- |
| Text was 8 to 11 px in the logical screen (Silkscreen 8 px for captions, Tiny5 10 to 11 px for labels and values). At 1366 × 768 the screen scaled to 0.96, so it was *smaller* than that. Scaling tiny bitmap text by a non-integer factor also blurred it. | `style.css` |
| Controls were 13 to 16 px high with 3 to 4 px gaps: precision clicking. Sliders were 13 px high; M, S, L buttons 13 px. | `.btn`, `.range`, `.num` |
| Panels were crowded because their size was fixed: the GENERATE panel packed 8 sliders, 6 buttons and the EVOLVE group into 250 × 300 px; the DESTRUCTION window showed every parameter of CHOP, ROLLS, DESTROY (20 controls) permanently; a block of 6 tiny numeric fields sat on one line in TRACK. | `patternView.ts` |
| Permanently visible information that is rarely needed: the 7-line grid legend, evolution settings, MIDI fields, seed readouts. | `patternView.ts` |
| The grid had **no visible step boundaries**: only dotted lines at beats and a solid line at bars. Cells were 16 px wide (992 px / 32 steps), shrinking further as the pattern grew; a 64-step pattern got 8 px cells. | `grid.ts` |
| The grid was fitted to a fixed 992 × 440 box (`cellW = floor(width / steps)`, `rowH = height / tracks`), so it could not scroll and could not keep its cells usable. | `grid.ts` |
| Pop-up lists and dialogs computed their position against the 1280 logical width (`getBoundingClientRect() / (width / 1280)`), another coupling to the fixed screen. | `widgets.ts`, `dialogs.ts` |
| The right-click was the only way to select one cell for the STEP inspector, and wheel-over-a-hit silently changed velocity. | `grid.ts` |
| The About dialog set 15 paragraphs of legal text in the 11 px pixel font. | `dialogs.ts` |
| A dead control: the role pop-up in TRACK had a no-op setter and `pointer-events: none`. | `patternView.ts` |

### What each mark in the old grid meant

Read from `src/ui/grid.ts` (before this change):

| Mark | Meaning in the code |
| --- | --- |
| Solid block, height = velocity | The *written* hit (baseline plus hand edits), whether or not it played this cycle. |
| Hatched (diagonal lines) block | The written hit has a chance below 100 %. |
| Paper-coloured dither over a block | The track is muted, or silenced by another track's solo. |
| 2 × 2 square at a block's top-left | The hit has a flam. |
| Vertical paper lines inside a block | The hit has a ratchet (one line per repeat). |
| A 4 px notch at a cell's top-left corner | The hit is a hand edit (`origin === 'edit'`). |
| **Four dots forming an X in the middle of an empty cell** | A generated hit you deleted by hand (`origin === 'deleted'`). |
| **Dotted top and bottom edges of a cell** | `CELL_SUPPRESSED`: the written hit did not play this cycle (probability or density). |
| **A 3 × 3 dot in the middle of an empty cell** | `CELL_ADDED`: something that is not written plays here (a fill, a roll stroke, a slice CHOP moved in). |
| A line of dots along the top of a cell | `CELL_DESTROYED`: DESTROY changed the hit. |
| A diagonal paper slash across a block | `CELL_MOVED`: the written hit was moved away by CHOP, or skipped by DESTROY. |
| A small zigzag in the top-right corner | `CELL_EVOLVED`: rhythm evolution changed the step. |
| Dotted vertical lines at every beat, a solid line at every bar | Structure. Steps in between had no boundary at all. |
| A dotted frame in the selection | A region selected with Shift-drag. |

So the "dots" were four different things (a deleted generated hit, a suppressed hit, an added
hit, a destroyed hit), distinguishable only by position and count. And the primary picture drew
the *written* pattern with a layer of cycle effects on top, so a hit that did not play looked
the same as one that did.

## 2. What the grid shows now

The grid shows **what will play** in the cycle on show (while playing, the cycle being heard;
stopped, the first cycle). The data comes from the realisation (`src/rhythm/realize.ts`:
probability, density, fills, evolution, CHOP, ROLLS, DESTROY, swing), turned into plain cell
data by `src/ui/gridModel.ts` (unit-tested in `test/gridmodel.test.ts`). Four symbols, all
explained in the **? KEY** dialog (`gridKeyDialog` in `src/ui/dialogs.ts`, drawn with the grid's
own drawing code):

| Symbol | Meaning |
| --- | --- |
| Solid block, height = velocity | A hit that sounds. |
| Block split into slices | More than one stroke in the step (ratchet, roll, stutter). |
| Short block just before the hit | A flam. |
| Thin bar along the top, length = chance | The hit's chance when below 100 %. |
| Outline (dashed) block | Written but silent this pass (chance, density, moved or skipped). Clicking removes it. |
| Empty cell | Nothing sounds. A deleted generated hit is **just empty**. |

Structure, derived from the pattern's resolution (`gridMetrics`; CLATTER's bars are in 4, so a
beat is `res` steps and a bar `4 × res`): a hairline at every step, a 2 px line at every beat,
a 4 px line at every bar, every other beat dotted, bar chips (`BAR 2`) and beat numbers in the
header.

Provenance (generated, hand-edited, added by ROLLS, moved by CHOP, changed by DESTROY or
EVOLVE) is not drawn in the grid. It is in:

* the **hover tooltip** and the **footer line** under the grid (track, step, bar and beat,
  sounds or silent and why, velocity, chance, source, transformation);
* the **step editor** under the grid;
* **SHOW ORIGINAL** (off by default): a corner flag marks hand-edited hits, a crossed-out
  outline marks generated hits you deleted.

Playhead: a tinted column (it never covers a block), the step lit in the header with its
number, a heavy edge on each side. Cursor (the step being edited): a solid ring. Pointer: a
dashed outline, plus a faint preview of the hit a click would add. Muted rows fade.

## 3. Structure of the PATTERN view

* **Primary** (always on screen, even at 1366 × 768): the transport (play, tempo, swing,
  pattern buttons, chain, quantise, undo, panic), the view tabs, the pattern grid with its
  track rows (name, SYN/SMP/HYB chip, M, S, L, hear), and the step editor under it.
* **Secondary** (a band of windows under the grid that flows into 1 to 4 columns, each folds
  away from its title bar and remembers it): **GENERATE** (style, density, complexity,
  variation, GENERATE, VARIATION, MUTATE), **TRANSFORM** (see below), **TRACK** (the selected
  track), **EDIT** (copy, paste, clear, shift, velocity and chance for the selection).
* **Tertiary**: GENERATE's *MORE* section (accent, fills, bars, regenerate, evolution), TRACK's
  *loop length and MIDI* section, each transformation's parameters (shown for the one chosen
  in the toolbar), the grid key and keys dialogs.

**TRANSFORM** is a toolbar of CHOP, ROLLS, DESTROY and WILDCARD. Each of the first three has a
check box (on/off, as before: C, L, D) and a name that shows its parameters in the panel under
the toolbar, so all 20 controls remain, one transformation at a time. WILDCARD runs as before.

**TRACK** shows SYNTH, SAMPLE and HYBRID as a joined three-way control (the current one
inverted; it also changes the mode), then mute, solo, lock, hear, fill, then the performance
sliders in a group.

## 4. Editing

Everything that worked still works. New or changed:

* **Click** adds or removes a hit *and* selects the step: the step editor under the grid shows
  its velocity, chance, pitch, ratchet, flam and sample. No right-click needed.
* **Right-click** still selects the step, and opens the same editor in a floating panel.
* **Arrow keys** (←, →, Home, End, Enter) work when the grid has focus.
* **Alt-drag** velocity is unchanged. **Alt + wheel** (was: plain wheel) sets velocity under
  the pointer: the page now scrolls, and a plain wheel over a hit must not change a velocity by
  accident.
* Hit-testing floors the pointer position and uses the same snapped cell edges that are drawn,
  so a click is always in the cell it lands on (`e2e/app.spec.ts`).
* Long patterns scroll sideways inside the grid; the track names stay in place, the playhead is
  followed while playing (unless you are scrolling), cells are never narrower than 30 px.

## 5. Typography

Real pixels, never scaled.

| Use | Face | Size |
| --- | --- | --- |
| Labels, buttons, numbers, menus, window titles | Tiny5 (pixel) | 16 px (exactly 2 × its 8 px grid, so it stays crisp) |
| Mode chips, group titles | Silkscreen (pixel) | 16 px |
| Dialog headings, pads | Tiny5 | 24 px |
| Secondary text (reports, hints, info lines, key hints) | VT323 | 18 px |
| Dialogs, help, About, tooltips (long text, mixed case) | IBM Plex Sans | 14.5 to 15.5 px, line height 1.4 to 1.6 |

Controls are 32 px high (28 px for the small ones in tracks), sliders 30 px, pads 84 px,
buttons never narrower than their height. `e2e/app.spec.ts` checks that no visible text is
smaller than 14 px and that no control clips its text at 1920 × 1080, 1440 × 900 and
1366 × 768.

## 6. Layout and scaling

* No fixed screen: the page is `menu bar / transport / view tabs` (fixed) above a work area that
  scrolls vertically. Windows are CSS grid and flex items.
* The band under the grid, the SOUND view's columns and the PERFORM view's pads re-flow with the
  window; at 1366 × 768 the grid, its footer and the step editor fit above the fold; at 1024
  the grid scrolls sideways inside itself and nothing else overflows.
* The pop-up lists, dialogs and tooltips are positioned in window coordinates.
* The palette editor (Slop Factory Core, fixed pixel layout) is shown scaled as a unit.

## 7. Palettes

All colours are the roles of Slop Factory Core's palette system (`--ink`, `--paper`, `--dim`,
`--activity`, `--selection`, `--desktop`, plus the area inks); the stylesheet contains no
literal black or white outside the pattern data-URIs that Core overrides. Structure in the
grid is drawn with ink at different opacities, so it follows any palette. The view tabs sit on
paper (not on the desktop) so a dark palette whose desktop and paper are alike still reads.
Tested with Classic, Dark, Colour, the other built-ins, and a custom palette.

## 8. Fonts and licences

IBM Plex Sans (SIL OFL 1.1) and VT323 (SIL OFL 1.1) were added beside Tiny5 and Silkscreen, from
the `@fontsource` packages, with their notices in THIRD_PARTY_NOTICES.md.
