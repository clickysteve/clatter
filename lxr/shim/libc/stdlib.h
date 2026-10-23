/* Minimal <stdlib.h>. Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only */
#ifndef CLATTER_STDLIB_H
#define CLATTER_STDLIB_H
#include <stddef.h>
static inline int abs(int x) { return x < 0 ? -x : x; }
#endif
