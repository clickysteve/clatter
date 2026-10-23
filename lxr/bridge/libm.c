/*
 * libm.c - the few transcendental functions the LXR DSP uses, for the freestanding
 * WebAssembly build (there is no C library in it).
 *
 * Copyright (C) 2026 The CLATTER contributors
 * SPDX-License-Identifier: GPL-3.0-only
 *
 * Accuracy: relative error below 1e-15 for exp/log over the ranges the DSP uses (argument
 * reduction by powers of two and ln 2, then Taylor/atanh series), which is far beyond the
 * single-precision DSP's needs. Written for CLATTER; not derived from any C library.
 */
#include "libc/math.h"
#include <stdint.h>

static const double LN2 = 0.693147180559945309417232121458;

static double exp_terms(double x, int terms)
{
	if (x != x) return x;
	if (x > 709.0) return __builtin_inf();
	if (x < -745.0) return 0.0;
	/* x = k ln2 + r, |r| <= ln2/2 */
	const double kf = __builtin_floor(x / LN2 + 0.5);
	const double r = x - kf * LN2;
	/* exp(r) by Taylor series to 1e-17 */
	double term = 1.0, sum = 1.0;
	for (int i = 1; i < terms; i++)
	{
		term *= r / i;
		sum += term;
	}
	/* scale by 2^k through the exponent bits (k within the double range) */
	int64_t k = (int64_t)kf;
	double scale = 1.0;
	if (k > 0) { while (k > 1000) { scale *= 0x1p1000; k -= 1000; } }
	else { while (k < -1000) { scale *= 0x1p-1000; k += 1000; } }
	union { double d; uint64_t u; } p;
	p.u = (uint64_t)(k + 1023) << 52;
	return sum * p.d * scale;
}

double exp(double x) { return exp_terms(x, 22); }

/* single precision: 11 terms of the series are exact to 1e-11 for |r| <= ln2/2 */
float expf(float x) { return (float)exp_terms((double)x, 11); }

static double log_terms(double x, int terms)
{
	if (x != x || x < 0.0) return __builtin_nan("");
	if (x == 0.0) return -__builtin_inf();
	if (x == __builtin_inf()) return x;
	union { double d; uint64_t u; } v = { x };
	int e = (int)((v.u >> 52) & 0x7ff);
	if (e == 0) /* subnormal */
	{
		v.d = x * 0x1p54;
		e = (int)((v.u >> 52) & 0x7ff) - 54;
	}
	e -= 1023;
	v.u = (v.u & 0x000fffffffffffffULL) | 0x3ff0000000000000ULL; /* mantissa in [1, 2) */
	double m = v.d;
	if (m > 1.41421356237309504880) { m *= 0.5; e += 1; }
	/* log(m) = 2 atanh(s), s = (m-1)/(m+1), |s| < 0.172 */
	const double s = (m - 1.0) / (m + 1.0);
	const double s2 = s * s;
	double term = s, sum = 0.0;
	for (int i = 1; i < terms; i += 2)
	{
		sum += term / i;
		term *= s2;
	}
	return 2.0 * sum + e * LN2;
}

double log(double x) { return log_terms(x, 40); }

/* single precision: |s| < 0.172, terms to s^17 are exact to 1e-14 */
float logf(float x) { return (float)log_terms((double)x, 18); }

double pow(double x, double y)
{
	if (y == 0.0) return 1.0;
	if (x == 0.0) return y > 0.0 ? 0.0 : __builtin_inf();
	if (x < 0.0)
	{
		const double yi = __builtin_floor(y);
		if (yi != y) return __builtin_nan("");
		const double r = exp(y * log(-x));
		const int64_t odd = (int64_t)yi & 1;
		return odd ? -r : r;
	}
	return exp(y * log(x));
}

float powf(float x, float y) { return (float)pow((double)x, (double)y); }

double tanh(double x)
{
	if (x > 20.0) return 1.0;
	if (x < -20.0) return -1.0;
	if (x > -1e-5 && x < 1e-5) return x;
	const double e2 = exp(2.0 * x);
	return (e2 - 1.0) / (e2 + 1.0);
}

float tanhf(float x) { return (float)tanh((double)x); }

static double reduce(double x, int* quadrant)
{
	const double pio2 = 1.57079632679489661923132169164;
	const double q = __builtin_floor(x / pio2 + 0.5);
	*quadrant = (int)((int64_t)q & 3);
	return x - q * pio2;
}

static double sin_kernel(double r)
{
	double term = r, sum = r;
	const double r2 = r * r;
	for (int i = 1; i < 12; i++)
	{
		term *= -r2 / ((2 * i) * (2 * i + 1));
		sum += term;
	}
	return sum;
}

static double cos_kernel(double r)
{
	double term = 1.0, sum = 1.0;
	const double r2 = r * r;
	for (int i = 1; i < 12; i++)
	{
		term *= -r2 / ((2 * i - 1) * (2 * i));
		sum += term;
	}
	return sum;
}

double sin(double x)
{
	int q;
	const double r = reduce(x, &q);
	switch (q)
	{
	case 0: return sin_kernel(r);
	case 1: return cos_kernel(r);
	case 2: return -sin_kernel(r);
	default: return -cos_kernel(r);
	}
}

double cos(double x)
{
	int q;
	const double r = reduce(x, &q);
	switch (q)
	{
	case 0: return cos_kernel(r);
	case 1: return -sin_kernel(r);
	case 2: return -cos_kernel(r);
	default: return sin_kernel(r);
	}
}

float sinf(float x) { return (float)sin((double)x); }
float cosf(float x) { return (float)cos((double)x); }

double fmod(double x, double y)
{
	if (y == 0.0) return __builtin_nan("");
	const double q = __builtin_trunc(x / y);
	return x - q * y;
}

float fmodf(float x, float y) { return (float)fmod((double)x, (double)y); }

/* ---------------------------------------------------------------- string functions */
#include "libc/string.h"

void* memset(void* dst, int c, size_t n)
{
	unsigned char* d = (unsigned char*)dst;
	while (n--) *d++ = (unsigned char)c;
	return dst;
}

void* memcpy(void* dst, const void* src, size_t n)
{
	unsigned char* d = (unsigned char*)dst;
	const unsigned char* s = (const unsigned char*)src;
	while (n--) *d++ = *s++;
	return dst;
}

void* memmove(void* dst, const void* src, size_t n)
{
	unsigned char* d = (unsigned char*)dst;
	const unsigned char* s = (const unsigned char*)src;
	if (d < s) while (n--) *d++ = *s++;
	else { d += n; s += n; while (n--) *--d = *--s; }
	return dst;
}

/* ---------------------------------------------------------------- IEEE half precision */
/*
 * The FX bus's delay memory (FxRamBuffer.c) is an array of __fp16, as on the Cortex-M7
 * (-mfp16-format=ieee). The compiler converts with these two runtime helpers (the names and
 * signatures of LLVM's compiler-rt builtins). Round to nearest, ties to even; overflow to
 * infinity; subnormals kept.
 */
float __extendhfsf2(unsigned short h)
{
	const uint32_t sign = (uint32_t)(h & 0x8000u) << 16;
	const uint32_t exp = (h >> 10) & 0x1fu;
	uint32_t man = h & 0x3ffu;
	union { uint32_t u; float f; } r;
	if (exp == 0)
	{
		if (man == 0) { r.u = sign; return r.f; }
		/* subnormal half: normalise */
		int e = -1;
		do { man <<= 1; e++; } while ((man & 0x400u) == 0);
		man &= 0x3ffu;
		r.u = sign | ((uint32_t)(127 - 15 - e) << 23) | (man << 13);
		return r.f;
	}
	if (exp == 31)
	{
		r.u = sign | 0x7f800000u | (man << 13);
		return r.f;
	}
	r.u = sign | ((exp + 127 - 15) << 23) | (man << 13);
	return r.f;
}

unsigned short __truncsfhf2(float f)
{
	union { float f; uint32_t u; } v = { f };
	const uint32_t sign = (v.u >> 16) & 0x8000u;
	const int32_t exp = (int32_t)((v.u >> 23) & 0xffu);
	uint32_t man = v.u & 0x7fffffu;
	if (exp == 255) return (unsigned short)(sign | 0x7c00u | (man ? 0x200u : 0u));
	int32_t e = exp - 127 + 15;
	if (e >= 31) return (unsigned short)(sign | 0x7c00u);
	if (e <= 0)
	{
		if (e < -10) return (unsigned short)sign;
		man |= 0x800000u;
		const uint32_t shift = (uint32_t)(14 - e);
		uint32_t half = man >> shift;
		const uint32_t rem = man & ((1u << shift) - 1u);
		const uint32_t mid = 1u << (shift - 1u);
		if (rem > mid || (rem == mid && (half & 1u))) half++;
		return (unsigned short)(sign | half);
	}
	uint32_t half = ((uint32_t)e << 10) | (man >> 13);
	const uint32_t rem = man & 0x1fffu;
	if (rem > 0x1000u || (rem == 0x1000u && (half & 1u))) half++; /* may carry into the exponent: correct */
	return (unsigned short)(sign | half);
}
