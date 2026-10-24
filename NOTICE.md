# CLATTER: copyright, licence and trademark notice

Copyright (C) 2026 The CLATTER contributors.

CLATTER is free software: you can redistribute it and/or modify it under the terms of the
**GNU General Public License version 3 only** (GPL-3.0-only) as published by the Free Software
Foundation, with the additional terms below. The licence text is in [LICENSE](LICENSE).

CLATTER is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without
even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
General Public License for more details.

## The LXR firmware

CLATTER contains and is a modified version of parts of the Erica Synths LXR-02 firmware
(<https://github.com/erica-synths/lxr-desktop-app>, revision
`a43cd4fcda23ec3d577dc425261c3eb28bd5abff`), Copyright (C) 2012-2026 Erica Synths, licensed
under GPL-3.0-only with additional terms under section 7. The imported files are in
`lxr/upstream/`, unchanged, with the firmware's own `LICENSE` and `NOTICE.md`. What was taken
and changed is documented in [docs/LXR_PORT.md](docs/LXR_PORT.md).

Because CLATTER is a work based on that firmware, the firmware's additional terms apply to
CLATTER as a whole:

1. **Trademarks (GPL-3.0 section 7(e)).** This licence does not grant any rights under
   trademark law in the names "Erica Synths", "LXR" and "LXR-02" or in the associated logos.
   CLATTER uses these names only to state truthfully where its synthesis engine comes from. It
   uses no Erica Synths logo and is **not** made, approved, endorsed or supported by Erica
   Synths, and is not affiliated with Erica Synths. Anyone distributing CLATTER or a work based
   on it must not suggest otherwise.
2. **Marking of modified versions (GPL-3.0 section 7(c)).** CLATTER is a modified version of the
   firmware's sound engine and says so in its About box and documentation. Modified versions of
   CLATTER must likewise be marked as modified and must not be presented as official Erica
   Synths software or as the original CLATTER.

The LXR hardware design (schematics, layouts, panel, enclosure, appearance) is the property of
Erica Synths, is not licensed under the GPL and is not part of CLATTER.

## Source code

The complete corresponding source for the CLATTER web application, including the LXR firmware
files, CLATTER's modifications, the WebAssembly build script and every other script used to
build it, is at <https://github.com/clickysteve/clatter>. The application's About box shows the
commit it was built from. `npm ci && npm run build` builds the site; `node
scripts/build-lxr.mjs` rebuilds the WebAssembly engine (clang and wasm-ld).

## Other components

CLATTER reuses MIT-licensed code and ideas from DOWNBEAT, The Breakery and Slop Factory Core,
bundles two OFL-licensed fonts, and ships its own CC0 demonstration samples. See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
