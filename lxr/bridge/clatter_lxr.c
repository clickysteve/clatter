/*
 * clatter_lxr.c - the WebAssembly interface of CLATTER's port of the LXR-02 synthesis engine.
 *
 * Copyright (C) 2026 The CLATTER contributors
 * Portions adapted from the LXR firmware (Core/Src/Soundengine/DSPAudio/mixer.c,
 * Core/Src/Soundengine/Soundengine.c, Core/Src/Soundengine/MIDI/MidiVoiceControl.c,
 * Core/Src/Preset/presetManager.c, Core/Src/Soundengine/Sequencer/sequencer.c),
 * Copyright (C) 2012-2026 Erica Synths.
 * SPDX-License-Identifier: GPL-3.0-only
 *
 * This file is part of CLATTER, which is licensed under the GNU General Public License
 * version 3 only, with the additional terms of the LXR firmware's NOTICE.md (GPL-3.0
 * section 7). See LICENSE, NOTICE.md and docs/LXR_PORT.md.
 *
 * What it does
 * ------------
 * The LXR renders its six voices in blocks of OUTPUT_DMA_SIZE (64) samples from the codec's
 * DMA interrupt (mixer_calcNextSampleBlock), mixes them onto two stereo DACs and an FX bus,
 * and reads its parameters from the front panel. CLATTER keeps the voices, envelopes,
 * modulation, filters, distortion, decimation and FX bus exactly as the firmware computes
 * them and replaces only the hardware around them:
 *
 *   - clatter_render_block() runs one engine block in the firmware's order (modulation reset,
 *     LFOs, filter coefficients, the voices' asynchronous parts, then each voice's samples and
 *     its decimator: mixer.c), but writes each voice to its own stereo buffer (panned with the
 *     voice's own triggered pan law) instead of mixing onto the DACs, so CLATTER's mixer gets
 *     separate tracks and stems;
 *   - the FX bus is run separately (clatter_fx_process) on whatever CLATTER routes to it;
 *   - parameters arrive through the firmware's own handler (midiParser_ccHandler, extracted
 *     into lxr_params.c), so every value is interpreted as the hardware interprets it;
 *   - triggers call the firmware's voice triggers (voiceControl_noteOn's mapping);
 *   - per-hit parameter locks use the firmware's AutomationNode, as the LXR sequencer does
 *     for its step automation;
 *   - the hardware RNG becomes a seeded generator (deterministic offline renders).
 */
#include "Soundengine/config.h"
#include "Soundengine/DSPAudio/DrumVoice.h"
#include "Soundengine/DSPAudio/Snare.h"
#include "Soundengine/DSPAudio/HiHat.h"
#include "Soundengine/DSPAudio/CymbalVoice.h"
#include "Soundengine/DSPAudio/mixer.h"
#include "Soundengine/DSPAudio/modulationNode.h"
#include "Soundengine/DSPAudio/automationNode.h"
#include "Soundengine/DSPAudio/lfo.h"
#include "Soundengine/DSPAudio/FX/FxRamBuffer.h"
#include "Soundengine/MIDI/ParameterArray.h"
#include "Soundengine/MIDI/MidiParser.h"
#include "Soundengine/MIDI/MidiMessages.h"
#include "Soundengine/FxBus.h"
#include "Preset/InitKit.h"
#include "menu/menu.h"
#include "main.h"

/* defined in mixer.c, not declared in mixer.h */
void mixer_decimateBlock(const uint8_t voiceNr, int16_t* buffer);

#define EXPORT(name) __attribute__((export_name(#name)))

#define CLATTER_VOICES 6
#define CLATTER_TRIGGERS 7 /* drum 1-3, snare, cymbal, closed hat, open hat */
#define BLOCK OUTPUT_DMA_SIZE

/* ------------------------------------------------------------------ hardware replacements */
RNG_HandleTypeDef hrng = { 0x9e3779b9u };
GPIO_TypeDef clatter_jacks = { 0xffffffffu };
uint8_t activeParameters[NUM_PARAMS];
static uint16_t clatter_bpm = 120;

uint32_t HAL_RNG_GetRandomNumber(RNG_HandleTypeDef* h)
{
	/* xorshift32: the hardware RNG made reproducible */
	uint32_t x = h->state;
	x ^= x << 13;
	x ^= x >> 17;
	x ^= x << 5;
	h->state = x ? x : 0x9e3779b9u;
	return h->state;
}

float adc_getFaderVolume(uint8_t voice)
{
	(void)voice;
	return 1.f;
}

uint16_t seq_getBpm(void)
{
	return clatter_bpm;
}

/* ------------------------------------------------------------------ buffers shared with JS */
/* per voice: left then right, BLOCK floats each, scaled to [-1, 1] */
static float voiceOut[CLATTER_VOICES][2][BLOCK];
/* FX bus: interleaved stereo int16 in, interleaved stereo int16 out */
static int16_t fxIn[BLOCK * 2];
static int16_t fxOut[BLOCK * 2];
static int16_t fxDac2[BLOCK * 2];
/* the parameter edit buffer the UI reads back */
static uint8_t paramShadow[END_OF_SOUND_PARAMETERS];
/* per-trigger automation nodes (two locks per hit, as the LXR sequencer's steps) */
static AutomationNode lockNodes[CLATTER_TRIGGERS][2];
/* peak level per voice of the last block, for meters */
static float voicePeak[CLATTER_VOICES];

EXPORT(clatter_voice_out) float* clatter_voice_out(void) { return &voiceOut[0][0][0]; }
EXPORT(clatter_fx_in) int16_t* clatter_fx_in(void) { return fxIn; }
EXPORT(clatter_fx_out) int16_t* clatter_fx_out(void) { return fxOut; }
EXPORT(clatter_voice_peaks) float* clatter_voice_peaks(void) { return voicePeak; }
EXPORT(clatter_block_size) int clatter_block_size(void) { return BLOCK; }
EXPORT(clatter_sample_rate) float clatter_sample_rate(void) { return REAL_FS; }
EXPORT(clatter_param_count) int clatter_param_count(void) { return END_OF_SOUND_PARAMETERS; }
EXPORT(clatter_voice_count) int clatter_voice_count(void) { return CLATTER_VOICES; }

/* ------------------------------------------------------------------ parameters */
/*
 * Set sound parameter `p` (a Parameters.h index, PAR_*) to `value` (0-127, the front panel's
 * value). Dispatched exactly as the firmware's front panel parser and kit loader do: below
 * 128 as MIDI_CC p+1 (the firmware's offset), above as CC2 p-128.
 */
static void dispatchParam(uint16_t p)
{
	MidiMsg msg;
	msg.data2 = activeParameters[p];
	if (p < 128)
	{
		msg.status = MIDI_CC;
		msg.data1 = (uint8_t)((p + 1) & 0x7f);
	}
	else
	{
		msg.status = MIDI_CC2;
		msg.data1 = (uint8_t)((p - 128) & 0x7f);
	}
	midiParser_ccHandler(msg, 1, 0, 0.f);
}

EXPORT(clatter_set_param) void clatter_set_param(int p, int value)
{
	if (p <= 0 || p >= END_OF_SOUND_PARAMETERS) return;
	if (value < 0) value = 0;
	if (value > 127) value = 127;
	activeParameters[p] = (uint8_t)value;
	paramShadow[p] = (uint8_t)value;
	dispatchParam((uint16_t)p);
}

EXPORT(clatter_get_param) int clatter_get_param(int p)
{
	if (p < 0 || p >= END_OF_SOUND_PARAMETERS) return 0;
	return paramShadow[p];
}

/*
 * Modulation destinations. The firmware stores LFO and velocity targets as indices into the
 * menu's modTargets list and sends the parameter number to the engine; CLATTER sends the
 * parameter number directly (PAR_*, 0 = none). kind 0 = LFO of `voice`, 1 = velocity of `voice`.
 */
EXPORT(clatter_set_mod_target) void clatter_set_mod_target(int kind, int voice, int param)
{
	if (voice < 0 || voice >= CLATTER_VOICES) return;
	if (param < 0 || param >= END_OF_SOUND_PARAMETERS) param = 0;
	ModulationNode* node;
	if (kind == 1)
	{
		node = &velocityModulators[voice];
	}
	else
	{
		switch (voice)
		{
		case 0:
		case 1:
		case 2: node = &voiceArray[voice].lfo.modTarget; break;
		case 3: node = &snareVoice.lfo.modTarget; break;
		case 4: node = &cymbalVoice.lfo.modTarget; break;
		default: node = &hatVoice.lfo.modTarget; break;
		}
	}
	modNode_setDestination(node, (uint16_t)param);
}

EXPORT(clatter_set_bpm) void clatter_set_bpm(int bpm)
{
	if (bpm < 1) bpm = 1;
	if (bpm > 999) bpm = 999;
	if (clatter_bpm != bpm)
	{
		clatter_bpm = (uint16_t)bpm;
		lfo_recalcSync();
	}
}

/* Load the firmware's init kit (Core/Src/Preset/initKit.c), as preset_init() does. */
EXPORT(clatter_load_init_kit) void clatter_load_init_kit(void)
{
	for (int p = 0; p < END_OF_SOUND_PARAMETERS && p + 8 < INIT_KIT_SIZE; p++)
	{
		activeParameters[p] = initKit[p + 8];
		paramShadow[p] = initKit[p + 8];
	}
	for (int p = 1; p < END_OF_SOUND_PARAMETERS; p++) dispatchParam((uint16_t)p);
	for (int v = 0; v < CLATTER_VOICES; v++)
	{
		clatter_set_mod_target(0, v, 0);
		clatter_set_mod_target(1, v, 0);
	}
}

/* ------------------------------------------------------------------ triggers */
/*
 * Trigger a voice, as MidiVoiceControl.c's voiceControl_noteOn does. trig: 0-2 drum 1-3,
 * 3 snare, 4 cymbal, 5 closed hat, 6 open hat (the hat's two triggers share one voice).
 * note: 60 plays the programmed pitch (SEQ_DEFAULT_NOTE); velocity 1-127.
 */
static void trigger(int trig, int vel, int note)
{
	if (vel < 1) vel = 1;
	if (vel > 127) vel = 127;
	if (note < 0) note = 0;
	if (note > 127) note = 127;
	if (trig < 3)
		Drum_trigger((uint8_t)trig, (uint8_t)vel, (uint8_t)note);
	else if (trig < 4)
		Snare_trigger((uint8_t)vel, (uint8_t)note);
	else if (trig < 5)
		Cymbal_trigger((uint8_t)vel, (uint8_t)note);
	else
		HiHat_trigger((uint8_t)vel, (uint8_t)(trig - 5), (uint8_t)note);
}

EXPORT(clatter_trigger) void clatter_trigger(int trig, int vel, int note)
{
	if (trig < 0 || trig >= CLATTER_TRIGGERS) return;
	/* a hit without locks returns its automated parameters to their values, as a sequencer
	   step without automation does */
	autoNode_setDestination(&lockNodes[trig][0], NO_AUTOMATION);
	autoNode_setDestination(&lockNodes[trig][1], NO_AUTOMATION);
	trigger(trig, vel, note);
}

/* firmware automation numbering: parameters below 128 carry the +1 offset of the CC handler */
static uint16_t autoDest(int p)
{
	if (p <= 0 || p >= END_OF_SOUND_PARAMETERS) return NO_AUTOMATION;
	return (uint16_t)(p < 127 ? p + 1 : p);
}

/*
 * Trigger with up to two parameter locks (p = PAR_* or 0, v = 0-127): the parameter takes the
 * value for this hit and returns to its own value at the next hit of the same trigger,
 * exactly as the LXR sequencer applies its two automation parameters per step
 * (seq_triggerVoice -> autoNode_setDestination / autoNode_updateValue).
 */
EXPORT(clatter_trigger_locked) void clatter_trigger_locked(int trig, int vel, int note, int p1, int v1, int p2, int v2)
{
	if (trig < 0 || trig >= CLATTER_TRIGGERS) return;
	autoNode_setDestination(&lockNodes[trig][0], autoDest(p1));
	autoNode_setDestination(&lockNodes[trig][1], autoDest(p2));
	autoNode_updateValue(&lockNodes[trig][0], (uint8_t)(v1 < 0 ? 0 : v1 > 127 ? 127 : v1));
	autoNode_updateValue(&lockNodes[trig][1], (uint8_t)(v2 < 0 ? 0 : v2 > 127 ? 127 : v2));
	trigger(trig, vel, note);
}

/* ------------------------------------------------------------------ rendering */
static void voiceToOutput(int v, const int16_t* data, float panL, float panR)
{
	float peak = 0.f;
	for (int i = 0; i < BLOCK; i++)
	{
		/* the mixer's pan law and int16 conversion (mixer_addDataToOutput), kept in float */
		const float l = (float)(int16_t)(data[i] * panL);
		const float r = (float)(int16_t)(data[i] * panR);
		voiceOut[v][0][i] = l * (1.f / 32768.f);
		voiceOut[v][1][i] = r * (1.f / 32768.f);
		const float a = fabsf((float)data[i]);
		if (a > peak) peak = a;
	}
	voicePeak[v] = peak * (1.f / 32768.f);
}

/*
 * One engine block of BLOCK samples for all six voices. Adapted from mixer.c's
 * mixer_calcNextSampleBlock (same order of operations); the per-voice outputs replace the DAC
 * and FX-bus mixing.
 */
EXPORT(clatter_render_block) void clatter_render_block(void)
{
	modNode_resetTargets();
	modNode_reassignVeloMod();

	lfo_dispatchNextValue(&voiceArray[0].lfo);
	lfo_dispatchNextValue(&voiceArray[1].lfo);
	lfo_dispatchNextValue(&voiceArray[2].lfo);
	lfo_dispatchNextValue(&snareVoice.lfo);
	lfo_dispatchNextValue(&cymbalVoice.lfo);
	lfo_dispatchNextValue(&hatVoice.lfo);

	SVF_recalcFreq(&voiceArray[0].filter);
	SVF_recalcFreq(&voiceArray[1].filter);
	SVF_recalcFreq(&voiceArray[2].filter);
	SVF_recalcFreq(&snareVoice.filter);
	SVF_recalcFreq(&cymbalVoice.filter);
	SVF_recalcFreq(&hatVoice.filter);

	calcDrumVoiceAsync(0);
	calcDrumVoiceAsync(1);
	calcDrumVoiceAsync(2);
	Snare_calcAsync();
	Cymbal_calcAsync();
	HiHat_calcAsync();

	int16_t sampleData[BLOCK];
	for (int v = 0; v < 3; v++)
	{
		calcDrumVoiceSyncBlock((uint8_t)v, sampleData, BLOCK);
		mixer_decimateBlock((uint8_t)v, sampleData);
		voiceToOutput(v, sampleData, voiceArray[v].triggeredPanL, voiceArray[v].triggeredPanR);
	}
	Snare_calcSyncBlock(sampleData, BLOCK);
	mixer_decimateBlock(3, sampleData);
	voiceToOutput(3, sampleData, snareVoice.triggeredPanL, snareVoice.triggeredPanR);

	Cymbal_calcSyncBlock(sampleData, BLOCK);
	mixer_decimateBlock(4, sampleData);
	voiceToOutput(4, sampleData, cymbalVoice.triggeredPanL, cymbalVoice.triggeredPanR);

	HiHat_calcSyncBlock(sampleData, BLOCK);
	mixer_decimateBlock(5, sampleData);
	voiceToOutput(5, sampleData, hatVoice.triggeredPanL, hatVoice.triggeredPanR);
}

/*
 * The LXR FX bus on one block of what CLATTER routes to it: fxIn (interleaved stereo int16)
 * through FxBus_process into fxOut (interleaved stereo int16). The bus mixes its own dry/wet
 * (FX AMOUNT), exactly as on the hardware, where a voice routed to the FX bus is heard only
 * through it.
 */
EXPORT(clatter_fx_process) void clatter_fx_process(void)
{
	for (int i = 0; i < BLOCK * 2; i++)
	{
		fxOut[i] = 0;
		fxDac2[i] = 0;
	}
	fxBus.audioRouting = MIXER_ROUTING_DAC1_STEREO;
	FxBus_process(fxIn, &fxDac2[0], &fxDac2[1], &fxOut[0], &fxOut[1], BLOCK);
}

/* Clear the FX bus's delay memory (the firmware's FX buffer), for a clean start or export. */
EXPORT(clatter_fx_clear) void clatter_fx_clear(void)
{
	for (int i = 0; i <= FX_BUFFER_SIZE; i++) FX_BUFFER[i] = 0;
}

/* ------------------------------------------------------------------ lifetime */
/*
 * Initialise the engine as soundengine_init() does (Soundengine.c), without the codec, the
 * sequencer and the Euclidean generator, then load the init kit. `seed` seeds the noise and
 * random LFO generator.
 */
EXPORT(clatter_init) void clatter_init(uint32_t seed)
{
	hrng.state = seed ? seed : 0x9e3779b9u;
	clatter_bpm = 120;
	for (int i = 0; i < NUM_PARAMS; i++) activeParameters[i] = 0;
	for (int i = 0; i < END_OF_SOUND_PARAMETERS; i++) paramShadow[i] = 0;
	clatter_fx_clear();

	mixer_init();
	parameterArray_init();
	for (int i = 0; i < 6; i++) modNode_init(&velocityModulators[i]);
	for (int i = 0; i < 8; i++) midi_MidiChannels[i] = 0;
	initDrumVoice();
	Snare_init();
	HiHat_init();
	Cymbal_init();
	for (int t = 0; t < CLATTER_TRIGGERS; t++)
	{
		autoNode_init(&lockNodes[t][0]);
		autoNode_init(&lockNodes[t][1]);
	}
	clatter_load_init_kit();
}

/* Reseed the generator only (deterministic export from a known state). */
EXPORT(clatter_seed) void clatter_seed(uint32_t seed)
{
	hrng.state = seed ? seed : 0x9e3779b9u;
}
