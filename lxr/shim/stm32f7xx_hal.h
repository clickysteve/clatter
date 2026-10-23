/*
 * stm32f7xx_hal.h - CLATTER replacement for the STM32 HAL header.
 *
 * Copyright (C) 2026 The CLATTER contributors
 * SPDX-License-Identifier: GPL-3.0-only
 *
 * The LXR firmware's DSP files include the STM32F7 HAL for its integer types and for the
 * Cortex-M7 DSP intrinsics (CMSIS). CLATTER compiles those files unchanged for WebAssembly,
 * so this header provides exactly what they use, in portable C:
 *
 *   - the C integer types,
 *   - the CMSIS SIMD/saturation intrinsics, re-implemented bit-exactly from the ARMv7E-M
 *     Architecture Reference Manual (QADD16, QSUB16, SADD16, PKHBT, SSAT, USAT, QADD, QSUB,
 *     SMLALD, CLZ),
 *   - the hardware random number generator (HAL_RNG_GetRandomNumber), replaced by a seeded
 *     xorshift generator so offline renders are deterministic (see lxr/bridge/clatter_lxr.c).
 *
 * Nothing here is STMicroelectronics code.
 */
#ifndef CLATTER_STM32F7XX_HAL_H
#define CLATTER_STM32F7XX_HAL_H

#include <stdint.h>
#include <stddef.h>
#include "libc/string.h"
#include "libc/math.h"

#ifndef UINT32_MAX
#define UINT32_MAX 0xffffffffu
#endif

#define __STATIC_FORCEINLINE static inline __attribute__((always_inline))

/* ---------------------------------------------------------------- saturation helpers */
__STATIC_FORCEINLINE int32_t clatter_sat16(int32_t x)
{
	return x > 32767 ? 32767 : (x < -32768 ? -32768 : x);
}

/* SSAT: signed saturate to `bits` bits (1..32). */
#define __SSAT(ARG1, ARG2) clatter_ssat((int32_t)(ARG1), (ARG2))
__STATIC_FORCEINLINE int32_t clatter_ssat(int32_t val, uint32_t bits)
{
	if (bits >= 1u && bits <= 32u)
	{
		const int32_t max = (int32_t)((1u << (bits - 1u)) - 1u);
		const int32_t min = -1 - max;
		if (val > max) return max;
		if (val < min) return min;
	}
	return val;
}

/* USAT: unsigned saturate to `bits` bits (0..31). */
#define __USAT(ARG1, ARG2) clatter_usat((int32_t)(ARG1), (ARG2))
__STATIC_FORCEINLINE uint32_t clatter_usat(int32_t val, uint32_t bits)
{
	if (bits <= 31u)
	{
		const uint32_t max = (1u << bits) - 1u;
		if (val > (int32_t)max) return max;
		if (val < 0) return 0u;
	}
	return (uint32_t)val;
}

/* ---------------------------------------------------------------- packed 16-bit SIMD */
__STATIC_FORCEINLINE int16_t clatter_lo(uint32_t x) { return (int16_t)(x & 0xffffu); }
__STATIC_FORCEINLINE int16_t clatter_hi(uint32_t x) { return (int16_t)(x >> 16); }
__STATIC_FORCEINLINE uint32_t clatter_pack(int32_t lo, int32_t hi)
{
	return ((uint32_t)(uint16_t)lo) | (((uint32_t)(uint16_t)hi) << 16);
}

/* QADD16: two saturating signed 16-bit additions. */
__STATIC_FORCEINLINE uint32_t __QADD16(uint32_t op1, uint32_t op2)
{
	return clatter_pack(clatter_sat16((int32_t)clatter_lo(op1) + clatter_lo(op2)),
	                    clatter_sat16((int32_t)clatter_hi(op1) + clatter_hi(op2)));
}

/* QSUB16: two saturating signed 16-bit subtractions. */
__STATIC_FORCEINLINE uint32_t __QSUB16(uint32_t op1, uint32_t op2)
{
	return clatter_pack(clatter_sat16((int32_t)clatter_lo(op1) - clatter_lo(op2)),
	                    clatter_sat16((int32_t)clatter_hi(op1) - clatter_hi(op2)));
}

/* SADD16: two wrapping signed 16-bit additions (the GE flags are not modelled). */
__STATIC_FORCEINLINE uint32_t __SADD16(uint32_t op1, uint32_t op2)
{
	return clatter_pack((int32_t)clatter_lo(op1) + clatter_lo(op2),
	                    (int32_t)clatter_hi(op1) + clatter_hi(op2));
}

/* PKHBT: bottom half of ARG1, top half from (ARG2 << ARG3). */
#define __PKHBT(ARG1, ARG2, ARG3) \
	((((uint32_t)(ARG1)) & 0x0000FFFFu) | ((((uint32_t)(ARG2)) << (ARG3)) & 0xFFFF0000u))

/* QADD / QSUB: saturating 32-bit add and subtract. */
__STATIC_FORCEINLINE int32_t __QADD(int32_t op1, int32_t op2)
{
	const int64_t r = (int64_t)op1 + op2;
	return r > INT32_MAX ? INT32_MAX : (r < INT32_MIN ? INT32_MIN : (int32_t)r);
}
__STATIC_FORCEINLINE int32_t __QSUB(int32_t op1, int32_t op2)
{
	const int64_t r = (int64_t)op1 - op2;
	return r > INT32_MAX ? INT32_MAX : (r < INT32_MIN ? INT32_MIN : (int32_t)r);
}

/* SMLALD: dual 16x16 multiply, both products added to a 64-bit accumulator. */
__STATIC_FORCEINLINE uint64_t __SMLALD(uint32_t op1, uint32_t op2, uint64_t acc)
{
	const int64_t p = (int64_t)clatter_lo(op1) * clatter_lo(op2) + (int64_t)clatter_hi(op1) * clatter_hi(op2);
	return (uint64_t)((int64_t)acc + p);
}

/* CLZ: count leading zeros (32 for zero, as the instruction returns). */
__STATIC_FORCEINLINE uint8_t __CLZ(uint32_t value)
{
	return value == 0u ? 32u : (uint8_t)__builtin_clz(value);
}

/* APSR: only read by calcNoise(), which the voices never call. Reports no overflow. */
typedef union
{
	struct { uint32_t _reserved0:27; uint32_t Q:1; uint32_t V:1; uint32_t C:1; uint32_t Z:1; uint32_t N:1; } b;
	uint32_t w;
} APSR_Type;
__STATIC_FORCEINLINE uint32_t __get_APSR(void) { return 0u; }

/* ---------------------------------------------------------------- random number generator */
typedef struct { uint32_t state; } RNG_HandleTypeDef;
extern RNG_HandleTypeDef hrng;
uint32_t HAL_RNG_GetRandomNumber(RNG_HandleTypeDef* h);

#endif
