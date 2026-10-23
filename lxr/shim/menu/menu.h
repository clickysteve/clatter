/* menu/menu.h - CLATTER replacement. Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 * The DSP needs only the edit buffer of sound parameter values (activeParameters). */
#ifndef CLATTER_MENU_H
#define CLATTER_MENU_H
#include "stm32f7xx_hal.h"
#include "Parameters.h"
extern uint8_t activeParameters[NUM_PARAMS];
#endif
