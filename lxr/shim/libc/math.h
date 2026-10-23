/*
 * Minimal <math.h> for the freestanding WebAssembly build of the LXR DSP.
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 *
 * sqrt, fabs and floor map to single WebAssembly instructions (compiler builtins). The
 * transcendental functions are implemented in lxr/bridge/libm.c.
 */
#ifndef CLATTER_MATH_H
#define CLATTER_MATH_H
#include "stdlib.h"

#define M_PI 3.14159265358979323846
#define M_PI_2 1.57079632679489661923
#define M_LN2 0.69314718055994530942
#define M_E 2.7182818284590452354
#define INFINITY (__builtin_inff())
#define NAN (__builtin_nanf(""))

static inline float sqrtf(float x) { return __builtin_sqrtf(x); }
static inline double sqrt(double x) { return __builtin_sqrt(x); }
static inline float fabsf(float x) { return __builtin_fabsf(x); }
static inline double fabs(double x) { return __builtin_fabs(x); }
static inline float floorf(float x) { return __builtin_floorf(x); }
static inline double floor(double x) { return __builtin_floor(x); }
static inline float ceilf(float x) { return __builtin_ceilf(x); }
static inline double ceil(double x) { return __builtin_ceil(x); }
static inline float truncf(float x) { return __builtin_truncf(x); }
/* fused multiply-add: the product of two floats is exact in double, so this rounds once
 * (to double) and once more to float, which matches a true fma except in rare ties. */
static inline float fmaf(float a, float b, float c) { return (float)((double)a * (double)b + (double)c); }

static inline double fma(double a, double b, double c) { return a * b + c; }
double fmod(double x, double y);
float fmodf(float x, float y);
double exp(double x);
float expf(float x);
double log(double x);
float logf(float x);
double pow(double x, double y);
float powf(float x, float y);
double tanh(double x);
float tanhf(float x);
double sin(double x);
float sinf(float x);
double cos(double x);
float cosf(float x);
#endif
