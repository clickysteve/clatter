/* IO/adcPots.h - CLATTER replacement. Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 * The LXR has a volume fader per voice, read by the ADC. CLATTER has no faders on the
 * synthesis engine (its mixer is after the engine), so every fader reads full scale. */
#ifndef CLATTER_ADCPOTS_H
#define CLATTER_ADCPOTS_H
#include "stm32f7xx_hal.h"
float adc_getFaderVolume(uint8_t voice);
#endif
