/*
 * main.h - CLATTER replacement for the LXR board header. Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 *
 * mixer.c reads four GPIO pins that report which output jacks have a cable plugged in. In
 * CLATTER every output is "plugged in" (the GPIO input register reads all ones), so the
 * firmware's routing logic never re-routes a voice. CLATTER's own engine takes the voices'
 * outputs before that routing anyway (lxr/bridge/clatter_lxr.c).
 */
#ifndef CLATTER_MAIN_H
#define CLATTER_MAIN_H
#include "stm32f7xx_hal.h"
typedef struct { volatile uint32_t IDR; } GPIO_TypeDef;
extern GPIO_TypeDef clatter_jacks;
#define switch_l1_Pin 0x0040u
#define switch_l1_GPIO_Port (&clatter_jacks)
#define switch_r1_Pin 0x0080u
#define switch_r1_GPIO_Port (&clatter_jacks)
#define switch_l2_Pin 0x0008u
#define switch_l2_GPIO_Port (&clatter_jacks)
#define switch_r2_Pin 0x0010u
#define switch_r2_GPIO_Port (&clatter_jacks)
#endif
