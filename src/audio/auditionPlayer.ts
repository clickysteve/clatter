/**
 * Plays an audition: audio the engine already rendered, one sound at a time, straight to the
 * speakers on the application's own AudioContext. It never goes through the live engine, so the
 * sequencer, the kit and the mixer are not involved; a new sound fades the old one out first, so
 * two auditions never pile up.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import { ENGINE_RATE } from './engine';

const FADE = 0.012;

export class AuditionPlayer {
  private src: AudioBufferSourceNode | null = null;
  private gain: GainNode | null = null;

  /** `context` starts the audio (a click is a user gesture) and returns the context. */
  constructor(private readonly context: () => Promise<AudioContext | null>) {}

  async play(audio: Float32Array[], rate = ENGINE_RATE): Promise<void> {
    const ctx = await this.context();
    if (!ctx || !audio.length || !audio[0]!.length) return;
    this.stop(ctx);
    const buf = ctx.createBuffer(2, audio[0]!.length, rate);
    buf.copyToChannel(audio[0] as Float32Array<ArrayBuffer>, 0);
    buf.copyToChannel((audio[1] ?? audio[0]!) as Float32Array<ArrayBuffer>, 1);
    const src = ctx.createBufferSource();
    const gain = ctx.createGain();
    src.buffer = buf;
    src.connect(gain).connect(ctx.destination);
    src.onended = () => {
      if (this.src === src) this.src = this.gain = null;
    };
    this.src = src;
    this.gain = gain;
    src.start(ctx.currentTime + FADE);
  }

  /** Fade out whatever is playing. */
  stop(ctx?: AudioContext): void {
    const { src, gain } = this;
    if (!src || !gain) return;
    this.src = this.gain = null;
    try {
      const t = ctx?.currentTime ?? 0;
      gain.gain.cancelScheduledValues(t);
      gain.gain.setValueAtTime(gain.gain.value, t);
      gain.gain.linearRampToValueAtTime(0, t + FADE);
      src.stop(t + FADE + 0.005);
    } catch {
      /* already stopped */
    }
  }
}
