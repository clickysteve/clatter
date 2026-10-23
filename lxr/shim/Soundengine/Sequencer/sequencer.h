/* Soundengine/Sequencer/sequencer.h - CLATTER replacement. Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 * The LXR's step sequencer is not used: CLATTER has its own. The DSP needs the default note
 * (the note at which a voice plays at its programmed pitch) and the tempo (tempo-synced LFOs). */
#ifndef CLATTER_SEQUENCER_H
#define CLATTER_SEQUENCER_H
#include "stm32f7xx_hal.h"
#define SEQ_DEFAULT_NOTE 60
uint16_t seq_getBpm(void);
#endif
