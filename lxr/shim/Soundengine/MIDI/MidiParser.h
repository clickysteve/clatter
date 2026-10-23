/* Soundengine/MIDI/MidiParser.h - CLATTER replacement. Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 * Declares the parameter handler extracted from the firmware's MidiParser.c into
 * lxr/bridge/lxr_params.c. */
#ifndef CLATTER_MIDIPARSER_H
#define CLATTER_MIDIPARSER_H
#include "stm32f7xx_hal.h"
#include "Soundengine/MIDI/MidiMessages.h"
extern uint8_t midiParser_originalCcValues[0xff];
extern uint8_t midi_MidiChannels[8];
void midiParser_ccHandler(MidiMsg msg, uint8_t updateOriginalValue, uint8_t isFloatModulator, float v);
float midiParser_calcDetune(uint8_t value);
#endif
