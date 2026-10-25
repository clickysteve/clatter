/**
 * MIDI file export: the performance (what plays, after the transformations) as a Standard
 * MIDI File, type 1, one track per CLATTER track on its MIDI channel and note. Written with
 * DOWNBEAT's SMF writer (src/midi/smf.ts). Pitch and the other per-hit sound effects are audio
 * only: a drum note is never transposed to another drum.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import { PPQ, type Project } from '../model/types';
import { Sequence } from '../app/sequence';
import { writeSmf, type SmfTrack } from '../midi/smf';
import { noteOff, noteOn } from '../midi/messages';
import { tempoChanges } from '../transport/tempo';

export interface MidiExportOptions {
  bars: number;
}

/** The project's performance over `bars` bars, as events per track (absolute ticks at PPQ). */
export function performance(p: Project, bars: number): { track: string; tick: number; vel: number; len: number }[] {
  const seq = new Sequence({ project: () => p, lengthTicks: () => bars * 4 * PPQ });
  const end = bars * 4 * PPQ;
  const out: { track: string; tick: number; vel: number; len: number }[] = [];
  let start = 0;
  for (let k = 0; start < end && k < 10000; k++) {
    const plan = seq.plan(k);
    for (const e of seq.events(k, plan.pattern)) {
      const t = start + e.tick;
      if (t >= end) continue;
      out.push({ track: e.track, tick: t, vel: e.vel, len: Math.max(1, Math.round(e.gate ?? PPQ / 8)) });
    }
    start += plan.ticks;
  }
  return out.sort((a, b) => a.tick - b.tick);
}

export function exportMidi(p: Project, o: MidiExportOptions): Uint8Array {
  const evs = performance(p, o.bars);
  const tracks: SmfTrack[] = p.tracks.map((t) => {
    const events: { tick: number; bytes: number[] }[] = [];
    for (const e of evs) {
      if (e.track !== t.id) continue;
      const tick = Math.round(e.tick);
      events.push({ tick, bytes: noteOn(t.midi.channel, t.midi.note, e.vel) });
      events.push({ tick: tick + e.len, bytes: noteOff(t.midi.channel, t.midi.note) });
    }
    return { name: t.name, events };
  });
  // tempo automation becomes the file's tempo map
  const changes = tempoChanges(p.tempo, p.tempoAuto, o.bars * 4 * PPQ);
  return writeSmf({ format: 1, ppq: PPQ, bpm: changes[0]!.bpm, tempos: changes.slice(1), timeSig: [4, 4], tracks, endTick: o.bars * 4 * PPQ });
}
