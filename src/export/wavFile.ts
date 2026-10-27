/**
 * WAV encoding for the kit exporter: 16-bit and 24-bit integer PCM, and 32-bit float. Written
 * out by hand so the header is exactly what the format says (RIFF/WAVE, "fmt " then "data";
 * float files add the "fact" chunk the format requires for non-PCM).
 *
 * Integer output is rounded and clamped to full scale; nothing else is done to the audio (no
 * dither, no limiter), so what the engine rendered is what the file holds.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */

export type WavFormat = 'pcm16' | 'pcm24' | 'float32';

export const WAV_FORMATS: Record<WavFormat, { label: string; bits: number; float: boolean }> = {
  pcm16: { label: 'WAV 16-BIT', bits: 16, float: false },
  pcm24: { label: 'WAV 24-BIT', bits: 24, float: false },
  float32: { label: 'WAV 32-BIT FLOAT', bits: 32, float: true },
};

export function encodeWav(channels: Float32Array[], rate: number, format: WavFormat): Uint8Array {
  const { bits, float } = WAV_FORMATS[format];
  const n = channels.length;
  const frames = channels[0]?.length ?? 0;
  if (!n) throw new Error('a WAV needs at least one channel');
  const bytes = bits / 8;
  const dataLen = frames * n * bytes;
  const fact = float ? 12 : 0;
  const out = new Uint8Array(44 + fact + dataLen);
  const v = new DataView(out.buffer);
  const tag = (o: number, s: string) => {
    for (let i = 0; i < 4; i++) out[o + i] = s.charCodeAt(i);
  };
  tag(0, 'RIFF');
  v.setUint32(4, 36 + fact + dataLen, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, float ? 3 : 1, true);
  v.setUint16(22, n, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * n * bytes, true);
  v.setUint16(32, n * bytes, true);
  v.setUint16(34, bits, true);
  let o = 36;
  if (float) {
    tag(o, 'fact');
    v.setUint32(o + 4, 4, true);
    v.setUint32(o + 8, frames, true);
    o += 12;
  }
  tag(o, 'data');
  v.setUint32(o + 4, dataLen, true);
  o += 8;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < n; c++) {
      const x = channels[c]![i] ?? 0;
      if (bits === 32) v.setFloat32(o, x, true);
      else if (bits === 16) v.setInt16(o, Math.max(-32768, Math.min(32767, Math.round(x * 32768))), true);
      else {
        const s = Math.max(-8388608, Math.min(8388607, Math.round(x * 8388608)));
        v.setUint8(o, s & 0xff);
        v.setUint8(o + 1, (s >> 8) & 0xff);
        v.setUint8(o + 2, (s >> 16) & 0xff);
      }
      o += bytes;
    }
  }
  return out;
}

export interface WavInfo {
  format: WavFormat;
  channels: number;
  rate: number;
  frames: number;
  bits: number;
}

/** Read a WAV this module wrote back: header fields and the samples (for tests and verification). */
export function decodeWav(data: Uint8Array): WavInfo & { channelData: Float32Array[] } {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const tag = (o: number) => String.fromCharCode(data[o]!, data[o + 1]!, data[o + 2]!, data[o + 3]!);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV file');
  let o = 12;
  let fmt: { code: number; ch: number; rate: number; bits: number } | null = null;
  while (o + 8 <= data.length) {
    const id = tag(o);
    const len = v.getUint32(o + 4, true);
    if (id === 'fmt ') fmt = { code: v.getUint16(o + 8, true), ch: v.getUint16(o + 10, true), rate: v.getUint32(o + 12, true), bits: v.getUint16(o + 22, true) };
    if (id === 'data') {
      if (!fmt) throw new Error('data before fmt');
      const bytes = fmt.bits / 8;
      const frames = Math.floor(len / (bytes * fmt.ch));
      const ch = Array.from({ length: fmt.ch }, () => new Float32Array(frames));
      let p = o + 8;
      for (let i = 0; i < frames; i++)
        for (let c = 0; c < fmt.ch; c++) {
          let x: number;
          if (fmt.bits === 32) x = v.getFloat32(p, true);
          else if (fmt.bits === 16) x = v.getInt16(p, true) / 32768;
          else x = (((v.getUint8(p) | (v.getUint8(p + 1) << 8) | (v.getInt8(p + 2) << 16)) | 0) / 8388608);
          ch[c]![i] = x;
          p += bytes;
        }
      return { format: fmt.code === 3 ? 'float32' : fmt.bits === 24 ? 'pcm24' : 'pcm16', channels: fmt.ch, rate: fmt.rate, frames, bits: fmt.bits, channelData: ch };
    }
    o += 8 + len + (len & 1);
  }
  throw new Error('no data chunk');
}
