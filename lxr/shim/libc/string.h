/* Minimal <string.h> for the freestanding WebAssembly build of the LXR DSP.
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only */
#ifndef CLATTER_STRING_H
#define CLATTER_STRING_H
#include <stddef.h>
void* memset(void* dst, int c, size_t n);
void* memcpy(void* dst, const void* src, size_t n);
void* memmove(void* dst, const void* src, size_t n);
#endif
