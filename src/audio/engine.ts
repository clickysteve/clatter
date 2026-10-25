/**
 * ClatterEngine: CLATTER's sound engine. One implementation for live playback (inside the
 * AudioWorklet, worklet.ts) and offline rendering (export, drum hits, kit analysis): the same
 * code, the same numbers, so exports sound as playback does.
 *
 *   hit events ──► per track: SYNTH layer (an LXR trigger) and/or SAMPLE layer (sample voices)
 *               ──► track strip (filter, volume, pan, mute/solo) ──► MAIN bus or the LXR FX bus
 *   MAIN + FX bus return ──► master chain (Slop Factory Core output engines) ──► volume ──► clip
 *
 * Time is counted in engine frames at ENGINE_RATE. Everything runs in blocks of 64 frames,
 * the LXR's own block size: a synth trigger takes effect at the start of the block its event
 * falls in, as triggers do on the hardware (the LXR's sequencer also triggers between blocks).
 * Sample layers start at their exact frame; a HYBRID track starts both layers together (at the
 * block start, plus its alignment offset) so the layers stay locked to each other.
 *
 * The rhythm side never reaches in here: it sends hits (track, velocity, pitch, per-hit
 * destruction); the engine decides what sounds.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import { ChainStream, coreEngines, emptyChain, type ChainConfig } from '@slopfactory/core/engines';
import { LxrEngine, LXR_VOICES } from './lxr/lxr';
import { PAR } from '../sound/lxrParamIds';
import { DEST_INDEX, DESTS, parOf } from '../mod/registry';
import { ModRuntime } from '../mod/runtime';
import type { TrackMod } from '../mod/types';
import { BusProcessor, ChannelProcessor, MasterProcessor, defaultChannelFx, legacyOutputFx, type ChannelFx, type OutputFx } from './mixfx';

export const ENGINE_RATE = 44100;
export const BLOCK = 64;
export const MAX_SAMPLE_VOICES = 48;
/**
 * Sample layer headroom (-6 dB). Imported samples are usually normalised to full scale while
 * the LXR voices peak around -6 to -9 dBFS; this keeps a sample track at a level comparable to
 * a synthesised one at the same fader position (sample GAIN goes to 200 % for quiet files).
 */
export const SAMPLE_HEADROOM = 0.5;
/** anti-click fade for chokes, gates and stolen voices */
const FADE_FRAMES = Math.round(ENGINE_RATE * 0.004);
/** fade-in when a sample starts mid-way (region start, reverse) */
const ATTACK_FRAMES = 48;

/** A sample as the engine holds it: channels at its own rate. */
export interface EngineSample {
  rate: number;
  channels: Float32Array[];
}

/** One track's configuration (sound + mix), as the engine needs it. */
export interface EngineTrack {
  mode: 'synth' | 'sample' | 'hybrid';
  trigger: number;
  note: number;
  synthLevel: number;
  sampleLevel: number;
  samples: string[];
  pick: 'first' | 'cycle' | 'random' | 'velocity';
  start: number;
  end: number;
  tune: number;
  fine: number;
  gain: number;
  pan: number;
  reverse: boolean;
  offsetMs: number;
  choke: number;
  volume: number;
  mixPan: number;
  /** audible after mute and solo */
  audible: boolean;
  route: 'main' | 'fx';
  filter: number;
  /** send to the LXR FX bus while the track also plays to the main bus (0-1) */
  send: number;
  /** channel processing (absent: none) */
  fx?: ChannelFx;
  /**
   * The track's modulation: index 0 is the base sound's, 1-4 are variations A-D (null: the
   * variation uses the base's). Sent whole; the engine keeps source state across edits.
   */
  mods?: (TrackMod | null)[];
}

export const silentTrack = (): EngineTrack => ({
  mode: 'synth',
  trigger: 0,
  note: 60,
  synthLevel: 1,
  sampleLevel: 1,
  samples: [],
  pick: 'first',
  start: 0,
  end: 1,
  tune: 0,
  fine: 0,
  gain: 1,
  pan: 0,
  reverse: false,
  offsetMs: 0,
  choke: 0,
  volume: 0.8,
  mixPan: 0,
  audible: true,
  route: 'main',
  filter: 0,
  send: 0,
});

/** A hit: one sequencer event for one track. */
export interface HitEvent {
  /** engine frame */
  frame: number;
  track: number;
  /** 1-127 */
  vel: number;
  /** pitch offset in semitones (the hit's note, DESTROY's pitch) */
  pitch: number;
  /** DESTROY gate: frames until the sound is cut (0 = no gate) */
  gate?: number;
  /** DESTROY reverse (sample layer) */
  reverse?: boolean;
  /** synth per-hit parameter locks: [param, value, param, value] (LXR automation) */
  locks?: number[];
  /** a specific sample for this hit */
  sample?: string;
  /** play this LXR trigger (0-6) instead of the track's (per-step voice) */
  trig?: number;
  /**
   * Step sound: LXR parameter values for this hit, flat [param, value, ...]. They are set just
   * before the trigger and returned to the kit's values at the next trigger of the same voice
   * (the voice is monophonic, so a new hit replaces the old one; see docs/STEP_SOUND.md).
   */
  sp?: number[];
  /** step sound: sample-layer settings for this hit */
  smp?: Partial<EngineTrack>;
  /** modulation of the sound that plays: 0 = base, 1-4 = variation A-D */
  mv?: number;
  /** seconds since the bar line / since the pattern start (aligns BAR and PATTERN retriggers) */
  tb?: number;
  tp?: number;
  /** a monotonically increasing id, for ordering only */
  seq?: number;
}

/** Fader position (0-1, 0.8 = unity) to gain: a dB-linear taper with -60 dB at the bottom. */
export function faderGain(v: number): number {
  if (v <= 0.001) return 0;
  const db = (v - 0.8) * 75; // 0.8 → 0 dB, 1 → +15 dB, 0 → -60 dB
  return Math.pow(10, db / 20);
}

/** Equal-power pan gains for -1..1. */
function panGains(p: number): [number, number] {
  const a = ((Math.max(-1, Math.min(1, p)) + 1) * Math.PI) / 4;
  return [Math.cos(a) * Math.SQRT2, Math.sin(a) * Math.SQRT2];
}

/** CLATTER's one-knob track filter: a TPT state-variable filter (not part of the LXR engine). */
class TrackFilter {
  private ic1 = [0, 0];
  private ic2 = [0, 0];
  private g = 0;
  private k = 1.2;
  private mode = 0; // 0 off, 1 lp, 2 hp
  private amount = 0;

  set(amount: number): void {
    if (amount === this.amount) return;
    this.amount = amount;
    if (Math.abs(amount) < 0.01) {
      this.mode = 0;
      return;
    }
    const f = amount < 0 ? 20000 * Math.pow(80 / 20000, -amount) : 20 * Math.pow(8000 / 20, amount);
    this.mode = amount < 0 ? 1 : 2;
    this.g = Math.tan((Math.PI * Math.min(f, ENGINE_RATE * 0.45)) / ENGINE_RATE);
  }

  process(L: Float32Array, R: Float32Array, n: number): void {
    if (this.mode === 0) return;
    const g = this.g;
    const k = this.k;
    const a1 = 1 / (1 + g * (g + k));
    const a2 = g * a1;
    const a3 = g * a2;
    for (let c = 0; c < 2; c++) {
      const x = c === 0 ? L : R;
      let ic1 = this.ic1[c]!;
      let ic2 = this.ic2[c]!;
      for (let i = 0; i < n; i++) {
        const v0 = x[i]!;
        const v3 = v0 - ic2;
        const v1 = a1 * ic1 + a2 * v3;
        const v2 = ic2 + a2 * ic1 + a3 * v3;
        ic1 = 2 * v1 - ic1;
        ic2 = 2 * v2 - ic2;
        x[i] = this.mode === 1 ? v2 : v0 - k * v1 - v2;
      }
      this.ic1[c] = ic1;
      this.ic2[c] = ic2;
    }
  }

  reset(): void {
    this.ic1 = [0, 0];
    this.ic2 = [0, 0];
  }
}

/** One playing sample. */
interface SampleVoice {
  track: number;
  sample: EngineSample;
  /** position in source frames (fractional) */
  pos: number;
  /** source frames per engine frame (negative = reverse) */
  step: number;
  lo: number;
  hi: number;
  gainL: number;
  gainR: number;
  /** frames to wait before starting (sample-accurate start within a block) */
  delay: number;
  /** frames until the gate closes (Infinity = none) */
  gateLeft: number;
  fade: number;
  fading: boolean;
  age: number;
  choke: number;
  /** frames of fade-in left (a start inside a sample, or a reversed sample) */
  attack: number;
  /** playback rate before modulation, gain before pan and modulation, and pan */
  rate: number;
  dir: 1 | -1;
  gain: number;
  pan: number;
  curL: number;
  curR: number;
}

export interface EngineMeters {
  /** per track peak since last read, post-fader */
  tracks: Float32Array;
  masterL: number;
  masterR: number;
  /** the master went over 0 dBFS before the clipper */
  clipped: boolean;
  /** engine frame */
  frame: number;
  /** largest gain reduction since the last read (dB, positive): the bus compressor and the limiter */
  busReduction: number;
  limitReduction: number;
  /** the watched track's modulation (see watchMod) */
  mod?: { track: number; out: Float32Array; pos: Float32Array; routes: Float32Array; dest: Float32Array };
}

export class ClatterEngine {
  readonly lxr: LxrEngine;
  readonly tracks: EngineTrack[] = [];
  private samples = new Map<string, EngineSample>();
  private queue: HitEvent[] = [];
  private seq = 0;
  /** the engine frame of the next block */
  frame = 0;

  private voices: SampleVoice[] = [];
  /** which track owns each LXR voice's output (the track that last triggered it) */
  private voiceOwner = new Int16Array(LXR_VOICES).fill(-1);
  /** synth layer gain per LXR voice (gates, chokes, panic) and its target */
  private synthGain = new Float32Array(LXR_VOICES).fill(1);
  private synthTarget = new Float32Array(LXR_VOICES).fill(1);
  private synthGate = new Float64Array(LXR_VOICES).fill(Infinity);
  private synthLevel = new Float32Array(LXR_VOICES).fill(1);
  private synthChoke = new Int8Array(LXR_VOICES);
  /** synth triggers delayed by a HYBRID alignment (negative offset) */
  private delayedTriggers: { frame: number; fn: () => void }[] = [];
  /** the kit's value of every LXR parameter (what a step's locks return to) */
  private base: Uint8Array;
  /** per LXR voice: the parameters the last hit locked; and how many voices hold each */
  private locked: number[][] = Array.from({ length: LXR_VOICES }, () => []);
  private lockCount: Uint8Array;

  // --- modulation (src/mod): one runtime per track that has any
  private rt: (ModRuntime | null)[] = [];
  private modCfg: (TrackMod | null)[][] = [];
  private modKey: string[] = [];
  /** the configuration slot a track's runtime runs: 0 base, 1-4 variation A-D */
  private modSlot: Int8Array;
  /** per LXR voice: the parameters modulation wrote, so they can be restored */
  private modOwned: number[][] = Array.from({ length: LXR_VOICES }, () => []);
  /** the last value modulation wrote to each parameter (-1: none) */
  private modLast: Int16Array;
  /** the value a step lock holds a parameter at while locked */
  private lockVal: Uint8Array;
  macros = new Float32Array(4);
  private tPitch: Float32Array;
  private tGain: Float32Array;
  private tSmpPan: Float32Array;
  private tBlendSynth: Float32Array;
  private tBlendSmp: Float32Array;
  private tVol: Float32Array;
  private tMixPan: Float32Array;
  private tFilter: Float32Array;
  private tSend: Float32Array;
  private tStart: Float32Array;
  private tMod: Uint8Array;
  private watch = -1;
  private bpm = 120;

  // --- output processing (src/audio/mixfx.ts)
  private chan: ChannelProcessor[] = [];
  private bus = new BusProcessor();
  private master = new MasterProcessor();
  private output: OutputFx = legacyOutputFx();

  private filters: TrackFilter[] = [];
  private trackBufL: Float32Array[] = [];
  private trackBufR: Float32Array[] = [];
  private smoothGL: Float32Array;
  private smoothGR: Float32Array;
  private cycle: Int32Array;
  private masterL = new Float32Array(BLOCK);
  private masterR = new Float32Array(BLOCK);
  private fxSumL = new Float32Array(BLOCK);
  private fxSumR = new Float32Array(BLOCK);
  private fxUsed = false;
  private fxTail = 0;
  private chain: ChainStream;
  private chainOn = false;
  masterVolume = 0.8;
  masterClip = true;
  private masterGain = faderGain(0.8);

  private meterTracks: Float32Array;
  private meterL = 0;
  private meterR = 0;
  private clipped = false;
  private rngState = 0x2545f491;

  /** when set, the FX bus return of each block is copied here (the FX stem) */
  fxSink: ((L: Float32Array, R: Float32Array, n: number) => void) | null = null;
  /** when set, each block's post-fader track outputs are copied here (stems) */
  stemSink: ((track: number, L: Float32Array, R: Float32Array, n: number) => void) | null = null;

  constructor(lxr: LxrEngine, trackCount: number, seed = 1) {
    this.lxr = lxr;
    this.base = new Uint8Array(lxr.paramCount);
    this.lockCount = new Uint8Array(lxr.paramCount);
    this.lockVal = new Uint8Array(lxr.paramCount);
    this.modLast = new Int16Array(lxr.paramCount).fill(-1);
    this.modSlot = new Int8Array(trackCount);
    const f = (v = 0) => new Float32Array(trackCount).fill(v);
    this.tPitch = f(); this.tGain = f(1); this.tSmpPan = f(); this.tBlendSynth = f(1); this.tBlendSmp = f(1);
    this.tVol = f(); this.tMixPan = f(); this.tFilter = f(); this.tSend = f(); this.tStart = f();
    this.tMod = new Uint8Array(trackCount);
    for (let p = 0; p < lxr.paramCount; p++) this.base[p] = lxr.getParam(p);
    for (let i = 0; i < trackCount; i++) {
      this.tracks.push(silentTrack());
      this.filters.push(new TrackFilter());
      this.rt.push(null);
      this.modCfg.push([]);
      this.modKey.push('');
      this.chan.push(new ChannelProcessor());
      this.trackBufL.push(new Float32Array(BLOCK));
      this.trackBufR.push(new Float32Array(BLOCK));
    }
    this.smoothGL = new Float32Array(trackCount);
    this.smoothGR = new Float32Array(trackCount);
    this.cycle = new Int32Array(trackCount);
    this.meterTracks = new Float32Array(trackCount);
    this.chain = new ChainStream(coreEngines(), emptyChain(), ENGINE_RATE, seed);
    this.rngState = (seed * 2654435761) >>> 0 || 1;
  }

  // ------------------------------------------------------------------ configuration
  setTrack(i: number, t: Partial<EngineTrack>): void {
    const cur = this.tracks[i];
    if (!cur) return;
    const { mods, ...rest } = t;
    Object.assign(cur, rest);
    this.filters[i]!.set(cur.filter);
    this.chan[i]!.set(cur.fx ?? defaultChannelFx());
    if (mods !== undefined) this.setMods(i, mods);
  }

  /** Install a track's modulation. Source state survives an edit; a track that loses all modulation is restored. */
  private setMods(i: number, mods: (TrackMod | null)[] | undefined): void {
    const key = JSON.stringify(mods ?? null);
    if (key === this.modKey[i]) return;
    this.modKey[i] = key;
    const list = mods ?? [];
    this.modCfg[i] = list;
    const any = list.some((m) => m && (m.routes.length || Object.keys(m.sources).length));
    let rt = this.rt[i];
    if (!any) {
      if (rt) this.dropMods(i);
      return;
    }
    if (!rt) {
      rt = new ModRuntime(this.rngState + i);
      rt.setBpm(this.bpm);
      this.rt[i] = rt;
    }
    this.useSlot(i, this.modSlot[i]!, true);
  }

  /** Select which configuration (base or a variation) a track's runtime runs. */
  private useSlot(i: number, slot: number, force = false): void {
    const rt = this.rt[i];
    if (!rt) return;
    const list = this.modCfg[i]!;
    const eff = list[slot] ? slot : 0;
    if (eff === this.modSlot[i] && !force) return;
    const sameSlot = eff === this.modSlot[i];
    this.modSlot[i] = eff;
    for (let lv = 0; lv < LXR_VOICES; lv++) if (this.voiceOwner[lv] === i) this.releaseMods(lv);
    rt.setConfig(list[eff] ?? null, sameSlot);
    this.tMod[i] = rt.hasRoutes ? 1 : 0;
    this.pullTrackMods(i);
    if (!rt.hasRoutes) this.resetTrackMods(i);
  }

  private dropMods(i: number): void {
    for (let lv = 0; lv < LXR_VOICES; lv++) if (this.voiceOwner[lv] === i) this.releaseMods(lv);
    this.rt[i] = null;
    this.tMod[i] = 0;
    this.modSlot[i] = 0;
    this.resetTrackMods(i);
  }

  private resetTrackMods(i: number): void {
    this.tPitch[i] = 0; this.tGain[i] = 1; this.tSmpPan[i] = 0; this.tBlendSynth[i] = 1; this.tBlendSmp[i] = 1;
    this.tVol[i] = 0; this.tMixPan[i] = 0; this.tFilter[i] = 0; this.tSend[i] = 0; this.tStart[i] = 0;
  }

  /** The performance macros (0-1). */
  setMacros(values: ArrayLike<number>): void {
    for (let i = 0; i < 4; i++) this.macros[i] = Math.max(0, Math.min(1, values[i] ?? 0));
  }

  /** Output processing: bus, width, limiter. */
  setOutput(o: OutputFx): void {
    this.output = o;
    this.bus.set(o.bus);
  }

  /** Report the modulation of one track in the meters (-1: none). The UI sets it only while the editor is visible. */
  watchMod(track: number): void {
    this.watch = track;
  }

  setSample(id: string, s: EngineSample | null): void {
    if (s) this.samples.set(id, s);
    else {
      this.samples.delete(id);
      this.voices = this.voices.filter((v) => this.samples.get(id) !== v.sample);
    }
  }

  hasSample(id: string): boolean {
    return this.samples.has(id);
  }

  /** Set a kit parameter. A parameter a sounding step has locked takes the value at the voice's next hit. */
  setParam(p: number, v: number): void {
    if (p > 0 && p < this.base.length) {
      this.base[p] = Math.max(0, Math.min(127, v | 0));
      this.modLast[p] = -1;
      if (this.lockCount[p]) return;
    }
    this.lxr.setParam(p, v);
  }

  /** The value a parameter holds before modulation: a sounding step's lock, else the kit's. */
  private effBase(p: number): number {
    return this.lockCount[p] ? this.lockVal[p]! : this.base[p]!;
  }

  /** Write the LXR destinations of a track's modulation onto the voice it owns. */
  private applyLxrMods(ti: number, lv: number, continuousOnly: boolean): void {
    const rt = this.rt[ti]!;
    const owned = this.modOwned[lv]!;
    for (const di of rt.active) {
      const d = DESTS[di]!;
      if (d.kind !== 'lxr' || (continuousOnly && d.rate === 'trigger')) continue;
      const p = parOf(d.id, lv);
      if (p === undefined) continue;
      const v = Math.max(0, Math.min(127, Math.round(this.effBase(p) + rt.dest[di]! * d.span)));
      if (v === this.modLast[p]) continue;
      this.modLast[p] = v;
      this.lxr.setParam(p, v);
      if (!owned.includes(p)) owned.push(p);
    }
  }

  /** Give a voice back its own values (a different track takes it, the modulation changes or stops). */
  private releaseMods(lv: number): void {
    const owned = this.modOwned[lv]!;
    if (!owned.length) return;
    for (const p of owned) {
      this.lxr.setParam(p, this.effBase(p));
      this.modLast[p] = -1;
    }
    owned.length = 0;
  }

  /** Sample, hybrid and track destinations from the runtime's sums. */
  private pullTrackMods(ti: number): void {
    const rt = this.rt[ti];
    if (!rt || !this.tMod[ti]) return;
    const d = rt.dest;
    const at = (id: string) => d[DEST_INDEX.get(id)!]!;
    const span = (id: string) => DESTS[DEST_INDEX.get(id)!]!.span;
    this.tPitch[ti] = at('smp.pitch') * span('smp.pitch');
    this.tGain[ti] = Math.max(0, 1 + at('smp.gain') * span('smp.gain'));
    this.tSmpPan[ti] = at('smp.pan');
    const b = at('hyb.blend');
    this.tBlendSynth[ti] = 1 - Math.max(0, b);
    this.tBlendSmp[ti] = 1 + Math.min(0, b);
    this.tStart[ti] = at('smp.start') * span('smp.start');
    this.tVol[ti] = at('trk.volume') * span('trk.volume');
    this.tMixPan[ti] = at('trk.pan');
    this.tFilter[ti] = at('trk.filter');
    this.tSend[ti] = at('trk.send');
  }

  /**
   * Make the LXR voice `lv` carry exactly the parameters `sp` ([param, value, ...]) for the hit
   * about to be triggered: what its previous hit locked and this one does not goes back to the
   * kit's value; what this hit locks is set. The values go through the firmware's own
   * parameter handler (LxrEngine.setParam), so they mean what they mean on the hardware.
   */
  private applyLocks(lv: number, sp: number[] | undefined): void {
    const prev = this.locked[lv]!;
    if (!prev.length && !sp?.length) return;
    const next: number[] = [];
    if (sp) for (let i = 0; i + 1 < sp.length; i += 2) next.push(sp[i]! | 0);
    for (const p of prev) this.lockCount[p]!--;
    for (const p of prev) if (!next.includes(p) && !this.lockCount[p]) {
      this.modLast[p] = -1;
      this.lxr.setParam(p, this.base[p]!);
    }
    if (sp) {
      for (let i = 0; i + 1 < sp.length; i += 2) {
        const p = sp[i]! | 0;
        if (p <= 0 || p >= this.base.length) continue;
        this.lockCount[p]!++;
        const val = Math.max(0, Math.min(127, sp[i + 1]! | 0));
        this.lockVal[p] = val;
        this.modLast[p] = -1;
        this.lxr.setParam(p, val);
      }
    }
    this.locked[lv] = next.filter((p) => p > 0 && p < this.base.length);
  }

  /** Every voice back to the kit's parameters (panic, stop). */
  releaseLocks(): void {
    for (let lv = 0; lv < LXR_VOICES; lv++) {
      this.releaseMods(lv);
      this.applyLocks(lv, undefined);
    }
  }

  setModTarget(kind: 0 | 1, voice: number, param: number): void {
    this.lxr.setModTarget(kind, voice, param);
  }

  setBpm(bpm: number): void {
    this.bpm = bpm;
    this.lxr.setBpm(bpm);
    for (const r of this.rt) r?.setBpm(bpm);
  }

  setMaster(volume: number, clip: boolean, chain?: ChainConfig): void {
    this.masterVolume = volume;
    this.masterGain = faderGain(volume);
    this.masterClip = clip;
    if (chain) {
      this.chain.set(chain);
      this.chainOn = chain.stages.length > 0 && !chain.bypass;
    }
  }

  /** Queue a hit (any order; kept sorted by frame). */
  schedule(h: HitEvent): void {
    h.seq = this.seq++;
    const q = this.queue;
    let i = q.length;
    while (i > 0 && (q[i - 1]!.frame > h.frame || (q[i - 1]!.frame === h.frame && q[i - 1]!.seq! > h.seq))) i--;
    q.splice(i, 0, h);
  }

  /** Drop queued hits at or after a frame (a transport stop or a pattern change). */
  cancelFrom(frame: number): void {
    this.queue = this.queue.filter((h) => h.frame < frame);
    this.delayedTriggers = this.delayedTriggers.filter((d) => d.frame < frame);
  }

  /** Silence everything quickly (PANIC, stop): sample voices fade, synth layers fade until retriggered. */
  panic(): void {
    this.queue = [];
    this.delayedTriggers = [];
    for (const v of this.voices) v.fading = true;
    this.synthTarget.fill(0);
    this.releaseLocks();
  }

  // ------------------------------------------------------------------ hits
  private rand(): number {
    let x = this.rngState;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.rngState = x >>> 0;
    return this.rngState / 4294967296;
  }

  private chokeGroup(group: number, exceptTrack: number): void {
    if (!group) return;
    for (const v of this.voices) if (v.choke === group && v.track !== exceptTrack) v.fading = true;
    for (let lv = 0; lv < LXR_VOICES; lv++) {
      const owner = this.voiceOwner[lv]!;
      if (owner >= 0 && owner !== exceptTrack && this.synthChoke[lv] === group) this.synthTarget[lv] = 0;
    }
  }

  private pickSample(t: EngineTrack, ti: number, h: HitEvent): EngineSample | null {
    if (h.sample && this.samples.has(h.sample)) return this.samples.get(h.sample)!;
    const ids = t.samples.filter((id) => this.samples.has(id));
    if (!ids.length) return null;
    let id: string;
    switch (t.pick) {
      case 'cycle':
        id = ids[this.cycle[ti]! % ids.length]!;
        this.cycle[ti]!++;
        break;
      case 'random':
        id = ids[Math.floor(this.rand() * ids.length)]!;
        break;
      case 'velocity':
        id = ids[Math.min(ids.length - 1, Math.floor(((h.vel - 1) / 127) * ids.length))]!;
        break;
      default:
        id = ids[0]!;
    }
    return this.samples.get(id)!;
  }

  private startSample(ti: number, track: EngineTrack, h: HitEvent, delayFrames: number): void {
    const t = h.smp ? { ...track, ...h.smp } : track;
    const s = this.pickSample(t, ti, h);
    if (!s || !s.channels.length) return;
    const len = s.channels[0]!.length;
    const region0 = Math.max(0, Math.min(len - 1, Math.floor(t.start * len)));
    const hi = Math.max(region0 + 1, Math.min(len, Math.ceil(t.end * len)));
    // modulation of the start position moves the start into the region (read at the trigger)
    const lo = this.tMod[ti] && this.tStart[ti] ? Math.max(0, Math.min(hi - 1, Math.floor(region0 + (hi - region0) * Math.max(0, Math.min(0.95, this.tStart[ti]!))))) : region0;
    const semis = t.tune + t.fine / 100 + h.pitch;
    const rate = (s.rate / ENGINE_RATE) * Math.pow(2, semis / 12);
    const reverse = t.reverse !== !!h.reverse;
    const vel = Math.max(1, Math.min(127, h.vel)) / 127;
    const g = Math.pow(vel, 1.3) * t.gain * SAMPLE_HEADROOM * (t.mode === 'hybrid' ? t.sampleLevel : 1);
    const mp = this.tMod[ti] ? this.tSmpPan[ti]! : 0;
    const mg = this.tMod[ti] ? this.tGain[ti]! * (t.mode === 'hybrid' ? this.tBlendSmp[ti]! : 1) : 1;
    const [pl, pr] = panGains(t.pan + mp);
    if (this.voices.length >= MAX_SAMPLE_VOICES) {
      // steal the oldest
      let oldest = 0;
      for (let i = 1; i < this.voices.length; i++) if (this.voices[i]!.age > this.voices[oldest]!.age) oldest = i;
      this.voices.splice(oldest, 1);
    }
    this.voices.push({
      track: ti,
      sample: s,
      pos: reverse ? hi - 1 : lo,
      step: reverse ? -rate : rate,
      lo,
      hi,
      gainL: g * mg * pl,
      gainR: g * mg * pr,
      rate,
      dir: reverse ? -1 : 1,
      gain: g,
      pan: t.pan,
      curL: g * mg * pl,
      curR: g * mg * pr,
      delay: delayFrames,
      gateLeft: h.gate && h.gate > 0 ? h.gate + delayFrames : Infinity,
      fade: 1,
      fading: false,
      age: 0,
      choke: t.choke,
      attack: lo > 0 || reverse ? ATTACK_FRAMES : 0,
    });
  }

  private startSynth(ti: number, t: EngineTrack, h: HitEvent): void {
    const trig = Math.max(0, Math.min(6, (h.trig ?? t.trigger) | 0));
    const lv = trig >= 5 ? 5 : trig;
    // whoever played this voice last gives it back its own values before the new owner's
    // step locks and modulation apply (the voice is monophonic: one owner at a time)
    this.releaseMods(lv);
    this.applyLocks(lv, h.sp);
    this.voiceOwner[lv] = ti;
    if (this.tMod[ti]) this.applyLxrMods(ti, lv, false);
    this.synthGain[lv] = 1;
    this.synthTarget[lv] = 1;
    this.synthGate[lv] = h.gate && h.gate > 0 ? h.gate : Infinity;
    this.synthLevel[lv] = t.mode === 'hybrid' ? t.synthLevel : 1;
    this.synthChoke[lv] = t.choke;
    const note = Math.max(0, Math.min(127, Math.round(t.note + h.pitch)));
    const vel = Math.max(1, Math.min(127, Math.round(h.vel)));
    if (h.locks && h.locks.length >= 2) this.lxr.triggerLocked(trig, vel, note, h.locks[0]! | 0, h.locks[1]! | 0, h.locks[2]! | 0, h.locks[3]! | 0);
    else this.lxr.trigger(trig, vel, note);
  }

  private applyHit(h: HitEvent, blockStart: number): void {
    const ti = h.track;
    const t = this.tracks[ti];
    if (!t) return;
    const within = Math.max(0, h.frame - blockStart);
    this.chokeGroup(t.choke, ti);
    const rt = this.rt[ti];
    if (rt) {
      this.useSlot(ti, h.mv ?? 0);
      if (this.tMod[ti]) {
        rt.trigger(h.vel, { barSec: h.tb, patSec: h.tp }, this.macros);
        this.pullTrackMods(ti);
      }
    }
    if (t.mode === 'synth') {
      this.startSynth(ti, t, h);
    } else if (t.mode === 'sample') {
      this.startSample(ti, t, h, within);
    } else {
      const off = Math.round((t.offsetMs / 1000) * ENGINE_RATE);
      if (off >= 0) {
        this.startSynth(ti, t, h);
        this.startSample(ti, t, h, off);
      } else {
        this.startSample(ti, t, h, 0);
        const at = blockStart - off;
        this.delayedTriggers.push({ frame: at, fn: () => this.startSynth(ti, t, h) });
      }
    }
  }

  /** Run an action (a parameter change) at an engine frame, between blocks. */
  scheduleAction(frame: number, fn: () => void): void {
    this.delayedTriggers.push({ frame, fn });
  }

  /** Trigger a hit now (audition, MIDI input): applied at the next block. */
  hitNow(track: number, vel: number, pitch = 0, extra: Partial<HitEvent> = {}): void {
    this.schedule({ frame: this.frame, track, vel, pitch, ...extra });
  }

  // ------------------------------------------------------------------ rendering
  /**
   * Render n frames (any count; processed in blocks of 64, the remainder kept for the next
   * call) into L/R. Returns nothing; read meters with takeMeters().
   */
  private pendL = new Float32Array(BLOCK);
  private pendR = new Float32Array(BLOCK);
  private pendAt = BLOCK;

  process(L: Float32Array, R: Float32Array, n: number): void {
    let i = 0;
    while (i < n) {
      if (this.pendAt >= BLOCK) {
        this.renderBlock(this.pendL, this.pendR);
        this.pendAt = 0;
      }
      const take = Math.min(BLOCK - this.pendAt, n - i);
      L.set(this.pendL.subarray(this.pendAt, this.pendAt + take), i);
      R.set(this.pendR.subarray(this.pendAt, this.pendAt + take), i);
      this.pendAt += take;
      i += take;
    }
  }

  /** The engine frame of the next sample process() will output. */
  get outputFrame(): number {
    return this.frame - (BLOCK - this.pendAt);
  }

  /** Render exactly one block of 64 frames. */
  renderBlock(outL: Float32Array, outR: Float32Array): void {
    const start = this.frame;
    const end = start + BLOCK;
    // hits due in this block
    while (this.queue.length && this.queue[0]!.frame < end) this.applyHit(this.queue.shift()!, start);
    if (this.delayedTriggers.length) {
      const due = this.delayedTriggers.filter((d) => d.frame < end);
      if (due.length) {
        this.delayedTriggers = this.delayedTriggers.filter((d) => d.frame >= end);
        for (const d of due) d.fn();
      }
    }

    const lxr = this.lxr;
    lxr.render();
    const nT = this.tracks.length;
    for (let ti = 0; ti < nT; ti++) {
      this.trackBufL[ti]!.fill(0);
      this.trackBufR[ti]!.fill(0);
    }

    // synth layers: each LXR voice into the track that owns it
    const fadeStep = 1 / FADE_FRAMES;
    for (let lv = 0; lv < LXR_VOICES; lv++) {
      const owner = this.voiceOwner[lv]!;
      if (owner < 0) continue;
      const t = this.tracks[owner]!;
      if (t.mode === 'sample') continue;
      const bl = this.trackBufL[owner]!;
      const br = this.trackBufR[owner]!;
      const oL = lxr.offset(lv, 0);
      const oR = lxr.offset(lv, 1);
      const out = lxr.out;
      let g = this.synthGain[lv]!;
      let target = this.synthTarget[lv]!;
      let gate = this.synthGate[lv]!;
      const level = this.synthLevel[lv]! * (t.mode === 'hybrid' && this.tMod[owner] ? this.tBlendSynth[owner]! : 1);
      for (let i = 0; i < BLOCK; i++) {
        if (gate !== Infinity) {
          gate--;
          if (gate <= 0) {
            target = 0;
            gate = Infinity;
          }
        }
        if (g !== target) g = g < target ? Math.min(target, g + fadeStep) : Math.max(target, g - fadeStep);
        const k = g * level;
        bl[i]! += out[oL + i]! * k;
        br[i]! += out[oR + i]! * k;
      }
      this.synthGain[lv] = g;
      this.synthTarget[lv] = target;
      this.synthGate[lv] = gate;
    }

    // sample layers
    if (this.voices.length) {
      const keep: SampleVoice[] = [];
      for (const v of this.voices) {
        if (this.renderVoice(v)) keep.push(v);
      }
      this.voices = keep;
    }

    // track strips
    const mL = this.masterL;
    const mR = this.masterR;
    mL.fill(0);
    mR.fill(0);
    this.fxSumL.fill(0);
    this.fxSumR.fill(0);
    let anyFx = false;
    for (let ti = 0; ti < nT; ti++) {
      const t = this.tracks[ti]!;
      const bl = this.trackBufL[ti]!;
      const br = this.trackBufR[ti]!;
      const tm = this.tMod[ti]!;
      if (tm && this.tFilter[ti]) this.filters[ti]!.set(Math.max(-1, Math.min(1, t.filter + this.tFilter[ti]!)));
      else if (tm) this.filters[ti]!.set(t.filter);
      this.filters[ti]!.process(bl, br, BLOCK);
      const ch = this.chan[ti]!;
      if (ch.active) ch.process(bl, br, BLOCK);
      const g = t.audible ? faderGain(Math.max(0, Math.min(1, t.volume + (tm ? this.tVol[ti]! : 0)))) : 0;
      const [pl, pr] = panGains(t.mixPan + (tm ? this.tMixPan[ti]! : 0));
      const sendLvl = t.route === 'fx' ? 0 : Math.max(0, Math.min(1, t.send + (tm ? this.tSend[ti]! : 0)));
      const tl = g * pl;
      const tr = g * pr;
      let gl = this.smoothGL[ti]!;
      let gr = this.smoothGR[ti]!;
      let peak = this.meterTracks[ti]!;
      const toFx = t.route === 'fx';
      const dL = toFx ? this.fxSumL : mL;
      const dR = toFx ? this.fxSumR : mR;
      const fL = this.fxSumL;
      const fR = this.fxSumR;
      for (let i = 0; i < BLOCK; i++) {
        gl += (tl - gl) * 0.01;
        gr += (tr - gr) * 0.01;
        const l = bl[i]! * gl;
        const r = br[i]! * gr;
        bl[i] = l;
        br[i] = r;
        dL[i]! += l;
        dR[i]! += r;
        if (sendLvl > 0) {
          fL[i]! += l * sendLvl;
          fR[i]! += r * sendLvl;
        }
        const a = Math.max(Math.abs(l), Math.abs(r));
        if (a > peak) peak = a;
      }
      this.smoothGL[ti] = gl;
      this.smoothGR[ti] = gr;
      this.meterTracks[ti] = peak;
      if ((toFx || sendLvl > 0) && (gl > 1e-5 || gr > 1e-5)) anyFx = true;
      if (this.stemSink) this.stemSink(ti, bl, br, BLOCK);
    }

    // the LXR FX bus: int16 in and out, as on the hardware
    if (anyFx) this.fxTail = ENGINE_RATE * 8; // keep running for delay tails
    if (anyFx || this.fxTail > 0 || this.fxUsed) {
      const fin = lxr.fxIn;
      for (let i = 0; i < BLOCK; i++) {
        fin[i * 2] = Math.max(-32768, Math.min(32767, Math.round(this.fxSumL[i]! * 32767)));
        fin[i * 2 + 1] = Math.max(-32768, Math.min(32767, Math.round(this.fxSumR[i]! * 32767)));
      }
      lxr.processFx();
      const fo = lxr.fxOut;
      const fl = this.fxSumL;
      const fr = this.fxSumR;
      for (let i = 0; i < BLOCK; i++) {
        fl[i] = fo[i * 2]! / 32768;
        fr[i] = fo[i * 2 + 1]! / 32768;
        mL[i]! += fl[i]!;
        mR[i]! += fr[i]!;
      }
      if (this.fxSink) this.fxSink(fl, fr, BLOCK);
      this.fxTail = Math.max(0, this.fxTail - BLOCK);
      this.fxUsed = this.fxTail > 0;
    }

    // bus processing, then the master: output chain, gain, width, soft clip, limiter
    if (this.bus.active) this.bus.process(mL, mR, BLOCK);
    if (this.chainOn) this.chain.process(mL, mR, BLOCK);
    const mg = this.masterGain;
    let pl = this.meterL;
    let pr = this.meterR;
    for (let i = 0; i < BLOCK; i++) {
      const l = mL[i]! * mg;
      const r = mR[i]! * mg;
      const al = Math.abs(l);
      const ar = Math.abs(r);
      if (al > 1 || ar > 1) this.clipped = true;
      if (al > pl) pl = al;
      if (ar > pr) pr = ar;
      outL[i] = l;
      outR[i] = r;
    }
    this.meterL = pl;
    this.meterR = pr;
    const o = this.output;
    this.master.width(outL, outR, BLOCK, o.width);
    if (this.masterClip) {
      for (let i = 0; i < BLOCK; i++) {
        outL[i] = softClip(outL[i]!);
        outR[i] = softClip(outR[i]!);
      }
    }
    if (o.limiter.on) this.master.limit(outL, outR, BLOCK, o.limiter.ceiling, o.limiter.release);
    this.postBlockMods();
    this.frame = end;
  }

  /** After a block: advance every track's modulation one control step and write what changed. */
  private postBlockMods(): void {
    const dt = BLOCK / ENGINE_RATE;
    for (let ti = 0; ti < this.rt.length; ti++) {
      const rt = this.rt[ti];
      if (!rt) continue;
      rt.advance(dt, this.macros);
      if (!this.tMod[ti]) continue;
      for (let lv = 0; lv < LXR_VOICES; lv++) if (this.voiceOwner[lv] === ti && this.tracks[ti]!.mode !== 'sample') this.applyLxrMods(ti, lv, true);
      this.pullTrackMods(ti);
    }
  }

  /** Render one sample voice into its track's buffer; false when it has finished. */
  private renderVoice(v: SampleVoice): boolean {
    const bl = this.trackBufL[v.track];
    const br = this.trackBufR[v.track];
    if (!bl || !br) return false;
    const ch = v.sample.channels;
    const c0 = ch[0]!;
    const c1 = ch[1] ?? c0;
    const fadeStep = 1 / FADE_FRAMES;
    let i = 0;
    let dL = 0;
    let dR = 0;
    let tgtL = 0;
    let tgtR = 0;
    if (this.tMod[v.track]) {
      // modulated pitch, gain and pan: the gains ramp across the block so they never step
      v.step = v.dir * v.rate * Math.pow(2, this.tPitch[v.track]! / 12);
      const tr = this.tracks[v.track]!;
      const mg = this.tGain[v.track]! * (tr.mode === 'hybrid' ? this.tBlendSmp[v.track]! : 1);
      const [pl, pr] = panGains(v.pan + this.tSmpPan[v.track]!);
      dL = (v.gain * mg * pl - v.curL) / BLOCK;
      dR = (v.gain * mg * pr - v.curR) / BLOCK;
      tgtL = v.gain * mg * pl;
      tgtR = v.gain * mg * pr;
    }
    if (v.delay > 0) {
      const d = Math.min(BLOCK, v.delay);
      v.delay -= d;
      v.gateLeft -= d;
      i = d;
      if (i >= BLOCK) return true;
    }
    for (; i < BLOCK; i++) {
      if (v.gateLeft !== Infinity && --v.gateLeft <= 0) v.fading = true;
      if (v.fading) {
        v.fade -= fadeStep;
        if (v.fade <= 0) return false;
      }
      const p = v.pos;
      if (p < v.lo || p >= v.hi - 1) {
        if (!(v.step < 0 && p >= v.lo && p < v.hi)) return false;
      }
      const ip = Math.floor(p);
      const f = p - ip;
      const x0 = c0[ip]!;
      const x1 = c0[ip + 1] ?? x0;
      const y0 = c1[ip]!;
      const y1 = c1[ip + 1] ?? y0;
      let g = v.fade;
      // a start inside a sample ramps in, so it never clicks
      if (v.attack > 0) {
        g *= 1 - v.attack / ATTACK_FRAMES;
        v.attack--;
      }
      if (dL !== 0 || dR !== 0) {
        v.curL += dL;
        v.curR += dR;
        bl[i]! += (x0 + (x1 - x0) * f) * v.curL * g;
        br[i]! += (y0 + (y1 - y0) * f) * v.curR * g;
      } else {
        bl[i]! += (x0 + (x1 - x0) * f) * v.gainL * g;
        br[i]! += (y0 + (y1 - y0) * f) * v.gainR * g;
      }
      v.pos += v.step;
    }
    if (dL !== 0 || dR !== 0) {
      v.curL = tgtL;
      v.curR = tgtR;
    }
    v.age++;
    return true;
  }

  /** Meters since the last call (peaks reset). */
  takeMeters(): EngineMeters {
    const m: EngineMeters = { tracks: this.meterTracks.slice(), masterL: this.meterL, masterR: this.meterR, clipped: this.clipped, frame: this.frame, busReduction: this.bus.reduction, limitReduction: this.master.reduction };
    this.bus.reduction = 0;
    this.master.reduction = 0;
    const w = this.watch >= 0 ? this.rt[this.watch] : null;
    if (w) m.mod = { track: this.watch, out: w.out.slice(), pos: w.pos.slice(), routes: w.routeVal.slice(0, 32), dest: w.dest.slice() };
    this.meterTracks.fill(0);
    this.meterL = 0;
    this.meterR = 0;
    this.clipped = false;
    return m;
  }

  /** Active sample voices (diagnostics, tests). */
  get activeSampleVoices(): number {
    return this.voices.length;
  }

  /** Queued hits (diagnostics, tests). */
  get queued(): number {
    return this.queue.length;
  }
}

/** A gentle soft clipper: transparent below -3 dBFS, saturating to ±1. */
export function softClip(x: number): number {
  const t = 0.708;
  const a = Math.abs(x);
  if (a <= t) return x;
  const over = (a - t) / (1 - t);
  const y = t + (1 - t) * Math.tanh(over);
  return x < 0 ? -y : y;
}

/** The PAR numbers that a kit loader sends (every sound parameter except hardware routing). */
export const KIT_PARAM_RANGE = { first: 1, last: PAR.END_OF_SOUND_PARAMETERS - 1 };
