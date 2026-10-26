# Third-party notices

CLATTER (GPL-3.0-only, see [NOTICE.md](NOTICE.md)) includes or is derived from the following.
MIT-licensed code may be included in a GPL-3.0 work; its notices are kept here and in the
headers of the files concerned.

## Erica Synths LXR-02 firmware

- Source: <https://github.com/erica-synths/lxr-desktop-app>, revision `a43cd4fcda23ec3d577dc425261c3eb28bd5abff`
- Copyright (C) 2012-2026 Erica Synths
- Licence: GPL-3.0-only with additional terms under section 7 (trademarks, marking of modified
  versions). Full text and notice: `lxr/upstream/LICENSE`, `lxr/upstream/NOTICE.md`.
- Used: the sound engine (voices, envelopes, filters, modulation, decimation, FX bus, parameter
  handling, init kit), unchanged in `lxr/upstream/`, compiled to WebAssembly. Adapted portions
  in `lxr/bridge/clatter_lxr.c` and `lxr/bridge/lxr_params.c`. Details: `docs/LXR_PORT.md`.
- Not affiliated: CLATTER is not an Erica Synths product. "Erica Synths", "LXR" and "LXR-02"
  are trademarks of Erica Synths.

## DOWNBEAT

- Source: <https://github.com/clickysteve/downbeat> (revision `a82134d7210ca73553c98889a256a6c961d4f3c7`)
- Copyright (c) 2026 The DOWNBEAT contributors
- Licence: MIT (below)
- Used: `src/midi/messages.ts`, `src/midi/output.ts`, `src/midi/smf.ts`, `src/midi/webmidi.ts`
  (copied with small changes); `src/rhythm/rng.ts` (keyed-hash randomness), `src/rhythm/euclid.ts`
  and `src/rhythm/mutate.ts` (adapted); the ideas behind generation, realisation (density
  weights, probability, fills, swing) and the Worker ticker of the scheduler.

## The Breakery

- Source: <https://github.com/clickysteve/the-breakery> (revision `efa3adc13fb333d6ceb57e3833ab938d4da8ba5b`)
- Copyright (c) 2026 The Breakery contributors
- Licence: MIT (below)
- Used: the ideas and rules of CHOP, ROLLS, DESTROY and WILDCARD (operations, takes, fixed
  per-hit draws, never destroying hand edits), the layered non-destructive pipeline, and the
  GitHub Pages workflow pattern. CLATTER's implementations (`src/destruction/`) are its own,
  written for events instead of audio.
- Adapted code: `src/midi/clock.ts` (`PulseEstimator`, the least-squares tempo estimate from
  24 PPQN clock, and the Start/Stop/Continue/Song Position handling of `ExternalClock`), from The
  Breakery's `src/midi/clockIn.ts` (itself after DOWNBEAT's pulse estimator); CLATTER adds a
  tempo-following phase lock and freewheeling on clock loss.

## Slop Factory Core

- Source: <https://github.com/clickysteve/slopfactory-core> (revision `f567d817e12f09b5a2b62985524e40378a670fb5`, an npm dependency)
- Copyright (c) 2026 clickysteve and the ANVIL and Slop Factory Core contributors
- Licence: MIT (below). Core bundles DSP from The Good Bits
  (<https://github.com/clickysteve/the-good-bits>, MIT, same author); see Core's own `NOTICE.md`.
- Used (as a library, unmodified): palettes and the palette editor, sample decoding and
  waveform peaks, sample storage and bundles, WAV and ZIP writing, the output engine chain, MIDI
  interfaces.

## emmm

- <https://github.com/clickysteve/emmm>
- Used as a visual reference only: the 1-bit desktop look (windows with slanted title tabs,
  dithered fills, Tiny5 and Silkscreen type). No emmm code or assets are included; CLATTER's
  interface code and styles are its own, and lay out in real pixels (see docs/UI_REDESIGN.md).

## Fonts

- **Tiny5**, Copyright 2022-2024 The Tiny5 Project Authors (<https://github.com/Gissio/font_tiny5>)
- **Silkscreen**, Copyright 2001 The Silkscreen Project Authors (<https://github.com/googlefonts/silkscreen>)
- **VT323**, Copyright 2011 The VT323 Project Authors (<https://fontsource.org/fonts/vt323>)
- **IBM Plex Sans**, Copyright 2019 IBM Corp. (<https://github.com/IBM/plex>)
- All four are licensed under the SIL Open Font License 1.1 (below), bundled unmodified from the
  `@fontsource` packages. Tiny5 and Silkscreen are the pixel faces (labels, buttons, headings);
  VT323 is the secondary face (hints and reports); IBM Plex Sans sets the long texts (About,
  help, tooltips).

## Demonstration samples

`public/samples/*.wav` were synthesised by `scripts/make-samples.mjs` for CLATTER. They contain
no recordings or third-party material and are dedicated to the public domain (CC0 1.0).

## MIT licence (DOWNBEAT, The Breakery, Slop Factory Core)

The copyright lines are given above.

```
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## SIL Open Font License 1.1 (Tiny5, Silkscreen, VT323, IBM Plex Sans)

The copyright lines are given above.

```
-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```
