#!/usr/bin/env bash
# Copies the LXR-02 firmware files that CLATTER compiles from a checkout of
# https://github.com/erica-synths/lxr-desktop-app into lxr/upstream/.
#
#   lxr/tools/import-upstream.sh /path/to/lxr-desktop-app
#
# The list below is the complete set of upstream files CLATTER uses. Files are copied
# unchanged; CLATTER's modifications are applied afterwards by lxr/tools/apply-patches.sh
# and documented in docs/LXR_PORT.md. Hardware headers (HAL, GPIO, menu, sequencer) are
# NOT imported: lxr/shim/ replaces them.
set -euo pipefail
SRC="${1:?usage: import-upstream.sh /path/to/lxr-desktop-app}"
DST="$(cd "$(dirname "$0")/.." && pwd)/upstream"
FILES=(
  LICENSE
  NOTICE.md
  Core/Inc/Parameters.h
  Core/Inc/config.h
  Core/Inc/Soundengine/config.h
  Core/Inc/Soundengine/datatypes.h
  Core/Inc/Soundengine/globals.h
  Core/Inc/Soundengine/FxBus.h
  Core/Inc/Soundengine/MIDI/MidiMessages.h
  Core/Inc/Soundengine/MIDI/MidiNoteNumbers.h
  Core/Inc/Soundengine/MIDI/ParameterArray.h
  Core/Inc/Soundengine/MIDI/valueShaper.h
  Core/Inc/Soundengine/DSPAudio/1PoleLp.h
  Core/Inc/Soundengine/DSPAudio/BufferTools.h
  Core/Inc/Soundengine/DSPAudio/CymbalVoice.h
  Core/Inc/Soundengine/DSPAudio/Decay.h
  Core/Inc/Soundengine/DSPAudio/DrumVoice.h
  Core/Inc/Soundengine/DSPAudio/HiHat.h
  Core/Inc/Soundengine/DSPAudio/Oscillator.h
  Core/Inc/Soundengine/DSPAudio/ResonantFilter.h
  Core/Inc/Soundengine/DSPAudio/Samples.h
  Core/Inc/Soundengine/DSPAudio/SlopeEg2.h
  Core/Inc/Soundengine/DSPAudio/Snare.h
  Core/Inc/Soundengine/DSPAudio/automationNode.h
  Core/Inc/Soundengine/DSPAudio/distortion.h
  Core/Inc/Soundengine/DSPAudio/dither.h
  Core/Inc/Soundengine/DSPAudio/lfo.h
  Core/Inc/Soundengine/DSPAudio/mixer.h
  Core/Inc/Soundengine/DSPAudio/modulationNode.h
  Core/Inc/Soundengine/DSPAudio/random.h
  Core/Inc/Soundengine/DSPAudio/snapEg.h
  Core/Inc/Soundengine/DSPAudio/squareRootLut.h
  Core/Inc/Soundengine/DSPAudio/transientGenerator.h
  Core/Inc/Soundengine/DSPAudio/transientTables.h
  Core/Inc/Soundengine/DSPAudio/wavetable.h
  Core/Inc/Soundengine/DSPAudio/FX/Compressor.h
  Core/Inc/Soundengine/DSPAudio/FX/Delay.h
  Core/Inc/Soundengine/DSPAudio/FX/Distortion.h
  Core/Inc/Soundengine/DSPAudio/FX/FxRamBuffer.h
  Core/Inc/Soundengine/DSPAudio/FX/Ringmod.h
  Core/Src/Soundengine/FxBus.c
  Core/Src/Soundengine/MIDI/ParameterArray.c
  Core/Src/Soundengine/MIDI/MidiParser.c
  Core/Src/Soundengine/DSPAudio/1PoleLp.c
  Core/Src/Soundengine/DSPAudio/BufferTools.c
  Core/Src/Soundengine/DSPAudio/CymbalVoice.c
  Core/Src/Soundengine/DSPAudio/Decay.c
  Core/Src/Soundengine/DSPAudio/DrumVoice.c
  Core/Src/Soundengine/DSPAudio/HiHat.c
  Core/Src/Soundengine/DSPAudio/Oscillator.c
  Core/Src/Soundengine/DSPAudio/ResonantFilter.c
  Core/Src/Soundengine/DSPAudio/SlopeEg2.c
  Core/Src/Soundengine/DSPAudio/Snare.c
  Core/Src/Soundengine/DSPAudio/automationNode.c
  Core/Src/Soundengine/DSPAudio/distortion.c
  Core/Src/Soundengine/DSPAudio/dither.c
  Core/Src/Soundengine/DSPAudio/lfo.c
  Core/Src/Soundengine/DSPAudio/mixer.c
  Core/Src/Soundengine/DSPAudio/modulationNode.c
  Core/Src/Soundengine/DSPAudio/random.c
  Core/Src/Soundengine/DSPAudio/snapEg.c
  Core/Src/Soundengine/DSPAudio/squareRootLut.c
  Core/Src/Soundengine/DSPAudio/transientGenerator.c
  Core/Src/Soundengine/DSPAudio/transientTables.c
  Core/Src/Soundengine/DSPAudio/wavetable.c
  Core/Src/Soundengine/DSPAudio/FX/Compressor.c
  Core/Src/Soundengine/DSPAudio/FX/Delay.c
  Core/Src/Soundengine/DSPAudio/FX/Distortion.c
  Core/Src/Soundengine/DSPAudio/FX/FxRamBuffer.c
  Core/Src/Soundengine/DSPAudio/FX/Ringmod.c
  Core/Src/Preset/initKit.c
  Core/Inc/Preset/InitKit.h
)
rm -rf "$DST"
for f in "${FILES[@]}"; do
  mkdir -p "$DST/$(dirname "$f")"
  cp "$SRC/$f" "$DST/$f"
done
( cd "$SRC" && git rev-parse HEAD ) > "$DST/UPSTREAM_REVISION"
echo "imported ${#FILES[@]} files from $(cat "$DST/UPSTREAM_REVISION")"
