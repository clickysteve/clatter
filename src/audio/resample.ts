/**
 * Streaming rate conversion from the engine's 44.1 kHz to the AudioContext's rate, for
 * browsers that ignore the 44.1 kHz CLATTER asks for. Cubic (Catmull-Rom) interpolation over
 * the engine's output; the engine itself always runs at its native rate (the LXR's DSP
 * computes its filters, envelopes and pitches for a fixed sample rate).
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
export class StreamResampler {
  /** engine frames consumed per output frame */
  readonly ratio: number;
  private pos = 0;
  private hist: Float32Array[]; // last 4 input frames per channel: x[-1], x0, x1, x2
  private bufL: Float32Array;
  private bufR: Float32Array;

  constructor(
    inRate: number,
    outRate: number,
    private pull: (L: Float32Array, R: Float32Array, n: number) => void,
  ) {
    this.ratio = inRate / outRate;
    this.hist = [new Float32Array(4), new Float32Array(4)];
    this.bufL = new Float32Array(1);
    this.bufR = new Float32Array(1);
  }

  private advance(): void {
    this.pull(this.bufL, this.bufR, 1);
    for (let c = 0; c < 2; c++) {
      const h = this.hist[c]!;
      h[0] = h[1]!;
      h[1] = h[2]!;
      h[2] = h[3]!;
      h[3] = c === 0 ? this.bufL[0]! : this.bufR[0]!;
    }
  }

  process(L: Float32Array, R: Float32Array, n: number): void {
    for (let i = 0; i < n; i++) {
      while (this.pos >= 1) {
        this.advance();
        this.pos -= 1;
      }
      const t = this.pos;
      for (let c = 0; c < 2; c++) {
        const h = this.hist[c]!;
        const y0 = h[0]!;
        const y1 = h[1]!;
        const y2 = h[2]!;
        const y3 = h[3]!;
        const v = y1 + 0.5 * t * (y2 - y0 + t * (2 * y0 - 5 * y1 + 4 * y2 - y3 + t * (3 * (y1 - y2) + y3 - y0)));
        (c === 0 ? L : R)[i] = v;
      }
      this.pos += this.ratio;
    }
  }
}
