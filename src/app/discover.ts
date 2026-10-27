/**
 * SOUND DISCOVERY: the session behind the DISCOVER tab. Eight candidate sounds for the selected
 * instrument's voice, auditioned through the real LXR engine, compared with the sound they would
 * replace, mutated, saved and, only when asked, applied.
 *
 * Nothing in here writes to the project. Candidates live in this session; a candidate is heard by
 * rendering a single hit of the instrument offline in a private engine (the same render DRUM HITS
 * and the TUNER use) on a copy of the project with the candidate in place, and playing the result
 * on its own, so the live engine, the kit being played and the sequencer are not touched. Applying
 * goes through the app as one undoable step (`DiscoverDeps.apply`).
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import { soundFingerprint, normalizeTarget, type PitchRecord, type PitchTarget } from '../analysis/trackPitch';
import type { Project, SynthKit, Track } from '../model/types';
import { type SeedValue, seedLabel } from '../rhythm/seed';
import type { KitFlavour } from '../rhythm/styles';
import { strCode } from '../rhythm/rng';
import {
  applyToKit,
  archetypeOf,
  candidateKey,
  characterLabel,
  clampWildness,
  DISCOVER_COUNT,
  extrasOf,
  generateBatch,
  generateCandidate,
  keyOfPar,
  mutateCandidate,
  pitchBadge,
  projectWith,
  voiceValues,
  WILDNESS_DEFAULT,
  type Candidate,
} from '../sound/discover';
import { voiceKeys, voiceRolesOf, type Key } from '../sound/kitgen';
import { candidateOf, describeSound, SoundLibrary, type LibrarySound } from '../sound/soundLibrary';

export type Side = 'A' | 'B';

/** What the session needs from the application; the tests supply their own. */
export interface DiscoverDeps {
  project(): Project;
  /** the selected track */
  track(): Track;
  /** the kit flavour of the project's rhythm style (the CHARACTER when it is left on STYLE) */
  flavour(): KitFlavour;
  /** the seed for the next batch: the held one, or a new phrase */
  drawSeed(): SeedValue;
  /** one hit of the track, alone, in a private engine */
  render(p: Project, trackId: string): Promise<Float32Array[]>;
  /** play rendered audio (the previous audition stops) and stop it */
  play(audio: Float32Array[]): void | Promise<void>;
  stop(): void;
  /** the pitch of the track's sound in a project */
  analyse(p: Project, target: PitchTarget): Promise<PitchRecord>;
  /** the engine check of a kit voice (levels, audibility); absent: candidates are taken as designed */
  check?(kit: SynthKit, voice: number, seed: number): Promise<SynthKit>;
  /** write the candidate into the instrument as one undo step */
  apply(c: Candidate, withExtras: boolean): { locked: number };
  /** something the screen shows changed */
  changed(): void;
  say(text: string): void;
}

interface Slot {
  cand: Candidate | null;
  held: boolean;
  /** how many times this slot was drawn again */
  draw: number;
  /** what this slot held before its last MUTATE or LOAD (BACK) */
  back: Candidate[];
}

export interface VoiceState {
  slots: Slot[];
  selected: number | null;
  /** the slot standing in for the original on side A (null: the original) */
  compare: number | null;
  batch: SeedValue | null;
}

export interface Playing {
  side: Side;
  /** "ORIGINAL", "3", "3>2"... */
  label: string;
}

const BACK_MAX = 12;
const RENDER_CACHE = 16;

const emptyState = (): VoiceState => ({ slots: Array.from({ length: DISCOVER_COUNT }, () => ({ cand: null, held: false, draw: 0, back: [] })), selected: null, compare: null, batch: null });

export class DiscoverSession {
  character: KitFlavour | 'style' = 'style';
  wildness = WILDNESS_DEFAULT;
  /** the side the A/B switch is on */
  side: Side = 'B';
  /** what was last sent to the speakers (or is being rendered for them) */
  playing: Playing | null = null;
  /** a long operation, for the screen */
  busy: string | null = null;
  /** apply and audition candidates with their saved modulation and variations (library sounds) */
  extras = true;
  /** measure the pitch of a sound after it is auditioned (once; the result is kept) */
  autoPitch = true;
  readonly library: SoundLibrary;

  private states = new Map<number, VoiceState>();
  private audio = new Map<string, Float32Array[]>();
  private pitches = new Map<string, PitchRecord>();
  private playSeq = 0;
  /** renders started (for tests and the screen: nothing renders unless asked) */
  renders = 0;

  constructor(private readonly d: DiscoverDeps, library?: SoundLibrary) {
    this.library = library ?? new SoundLibrary();
  }

  // ---------------------------------------------------------------- what is being discovered
  /** The voice of the selected track, or -1 for a sample track (no LXR voice to discover). */
  get voice(): number {
    const t = this.d.track();
    return t.sound.mode === 'sample' ? -1 : t.sound.trigger >= 5 ? 5 : t.sound.trigger;
  }

  /** The tracks that play this voice (applying a candidate changes them all). */
  sharedBy(): Track[] {
    const v = this.voice;
    return this.d.project().tracks.filter((t) => t.sound.mode !== 'sample' && (t.sound.trigger >= 5 ? 5 : t.sound.trigger) === v);
  }

  get state(): VoiceState {
    const v = this.voice;
    let s = this.states.get(v);
    if (!s) this.states.set(v, (s = emptyState()));
    return s;
  }

  get effectiveCharacter(): KitFlavour {
    return this.character === 'style' ? this.d.flavour() : this.character;
  }

  candidate(i: number | null): Candidate | null {
    return i === null ? null : (this.state.slots[i]?.cand ?? null);
  }

  get selected(): Candidate | null {
    return this.candidate(this.state.selected);
  }

  /** The candidates, wherever they are (a fresh batch fills all eight). */
  get count(): number {
    return this.state.slots.filter((s) => s.cand).length;
  }

  private opts(voice: number) {
    const p = this.d.project();
    return { voice, archetype: archetypeOf(p, voice), character: this.effectiveCharacter, wildness: clampWildness(this.wildness), locks: p.soundLocks };
  }

  private async refine(c: Candidate): Promise<Candidate> {
    if (!this.d.check) return c;
    const p = this.d.project();
    const checked = await this.d.check(applyToKit(p.kit.synth, c.voice, c).kit, c.voice, c.origin.seed ^ (c.origin.index * 31 + c.origin.draw));
    const values = voiceValues(checked, c.voice);
    const next = { ...c, values };
    return { ...next, key: candidateKey(next) };
  }

  // ---------------------------------------------------------------- generating
  /** Eight new candidates (held slots stay). */
  async discover(): Promise<void> {
    const v = this.voice;
    if (v < 0 || this.busy) return;
    const st = this.state;
    const seed = this.d.drawSeed();
    this.busy = 'DESIGNING CANDIDATES…';
    this.d.changed();
    try {
      const p = this.d.project();
      const skip = new Set(st.slots.flatMap((s, i) => (s.held && s.cand ? [i] : [])));
      const batch = generateBatch(p.kit.synth, seed, this.opts(v), skip);
      for (let i = 0; i < batch.length; i++) {
        const c = batch[i];
        if (!c) continue;
        st.slots[i] = { cand: await this.refine(c), held: false, draw: 0, back: [] };
      }
      st.batch = seed;
      if (st.selected === null || !st.slots[st.selected]?.cand) st.selected = st.slots.findIndex((s) => s.cand);
      if (st.compare !== null && !st.slots[st.compare]?.cand) st.compare = null;
      this.d.say(`DISCOVER ${characterLabel(this.effectiveCharacter)} ${Math.round(clampWildness(this.wildness) * 100)}% · SEED ${seedLabel(seed).toUpperCase()}`);
    } finally {
      this.busy = null;
      this.d.changed();
    }
  }

  /** Draw one slot again (same seed, next draw). */
  async regenerate(i: number): Promise<void> {
    const v = this.voice;
    const st = this.state;
    if (v < 0 || this.busy || !st.slots[i]) return;
    const seed = st.batch ?? this.d.drawSeed();
    this.busy = 'DESIGNING CANDIDATE…';
    this.d.changed();
    try {
      const slot = st.slots[i]!;
      const next = await this.refine(generateCandidate(this.d.project().kit.synth, seed, i, slot.draw + 1, this.opts(v)));
      if (slot.cand) slot.back = [...slot.back, slot.cand].slice(-BACK_MAX);
      slot.draw++;
      slot.cand = next;
      slot.held = false;
      st.batch = seed;
      st.selected = i;
    } finally {
      this.busy = null;
      this.d.changed();
    }
  }

  /** MUTATE the selected candidate: the child takes its slot, the parent is one BACK away. The instrument is not touched. */
  async mutate(i = this.state.selected): Promise<void> {
    const c = this.candidate(i);
    if (!c || i === null || this.busy) return;
    this.busy = 'MUTATING…';
    this.d.changed();
    try {
      const p = this.d.project();
      const child = await this.refine(mutateCandidate(p.kit.synth, c, { character: this.effectiveCharacter, wildness: this.wildness, locks: p.soundLocks, voiceRoles: voiceRolesOf(p.tracks) }));
      const slot = this.state.slots[i]!;
      slot.back = [...slot.back, c].slice(-BACK_MAX);
      slot.cand = child;
      this.state.selected = i;
      this.d.say(`MUTATE ${child.name} · ${Math.round(clampWildness(this.wildness) * 100)}%`);
    } finally {
      this.busy = null;
      this.d.changed();
    }
  }

  /** Step a slot back to what it held before its last MUTATE, DRAW or LOAD. */
  back(i: number): boolean {
    const slot = this.state.slots[i];
    const prev = slot?.back.pop();
    if (!slot || !prev) return false;
    slot.cand = prev;
    this.d.changed();
    return true;
  }

  canBack(i: number): boolean {
    return !!this.state.slots[i]?.back.length;
  }

  select(i: number): void {
    if (!this.state.slots[i]?.cand) return;
    this.state.selected = i;
    this.d.changed();
  }

  hold(i: number): void {
    const s = this.state.slots[i];
    if (!s?.cand) return;
    s.held = !s.held;
    this.d.changed();
  }

  /** Compare the selected candidate with another one instead of the original (null: back to the original). */
  setCompare(i: number | null): void {
    if (i !== null && !this.state.slots[i]?.cand) return;
    this.state.compare = i;
    this.d.changed();
  }

  // ---------------------------------------------------------------- hearing
  /** The sound on a side: A is the original (or the compared candidate), B the selected candidate. */
  private sound(side: Side): { p: Project; label: string; cand: Candidate | null } | null {
    const live = this.d.project();
    const t = this.d.track();
    if (side === 'A') {
      const c = this.candidate(this.state.compare);
      if (!c) return { p: live, label: 'ORIGINAL', cand: null };
      return { p: projectWith(live, t.id, c, this.extras), label: c.name, cand: c };
    }
    const c = this.selected;
    return c ? { p: projectWith(live, t.id, c, this.extras), label: c.name, cand: c } : null;
  }

  private auditionKey(p: Project, trackId: string): string {
    const t = p.tracks.find((x) => x.id === trackId);
    return strCode(JSON.stringify([soundFingerprint(p, { trackId, slot: null, layer: 'mix' }), t?.mix.fx ?? null, t?.mix.send ?? 0, p.master.out ?? null])).toString(36);
  }

  private async rendered(p: Project, trackId: string): Promise<Float32Array[]> {
    const key = this.auditionKey(p, trackId);
    const hit = this.audio.get(key);
    if (hit) return hit;
    this.renders++;
    const audio = await this.d.render(p, trackId);
    this.audio.set(key, audio);
    if (this.audio.size > RENDER_CACHE) this.audio.delete(this.audio.keys().next().value!);
    return audio;
  }

  /** Play one side through the real engine. A newer audition replaces an older one, started or not: one sound at a time. */
  async audition(side: Side = this.side): Promise<void> {
    const s = this.sound(side);
    if (!s || this.voice < 0) return;
    this.side = side;
    this.playing = { side, label: s.label };
    const seq = ++this.playSeq;
    this.d.changed();
    try {
      const audio = await this.rendered(s.p, this.d.track().id);
      if (seq !== this.playSeq) return;
      await this.d.play(audio);
      // what was heard gets its pitch measured once (cached; nothing is measured behind the player's back)
      if (this.autoPitch && seq === this.playSeq) void this.analyse(s.cand).catch(() => undefined);
    } catch (e) {
      if (seq === this.playSeq) this.d.say('AUDITION FAILED: ' + (e instanceof Error ? e.message : String(e)).toUpperCase());
    }
  }

  /** A/B: play the other side. */
  toggle(): Promise<void> {
    return this.audition(this.side === 'A' ? 'B' : 'A');
  }

  /** Audition a slot (and select it). */
  async auditionSlot(i: number): Promise<void> {
    if (!this.state.slots[i]?.cand) return;
    this.state.selected = i;
    this.side = 'B';
    await this.audition('B');
  }

  stop(): void {
    this.playSeq++;
    this.d.stop();
    this.playing = null;
    this.d.changed();
  }

  /** Get the audio of the two sides ready, so the switch between them is instant. */
  async prepare(): Promise<void> {
    const t = this.d.track().id;
    for (const side of ['A', 'B'] as const) {
      const s = this.sound(side);
      if (s) await this.rendered(s.p, t);
    }
  }

  // ---------------------------------------------------------------- pitch (on request, cached)
  private target(): PitchTarget {
    const t = this.d.track();
    return normalizeTarget(this.d.project(), { trackId: t.id, slot: null, layer: t.sound.mode === 'hybrid' ? 'synth' : 'mix' });
  }

  private pitchKey(c: Candidate | null): string {
    return `${this.d.track().id}|${c ? c.key : 'original'}`;
  }

  private pitchProject(c: Candidate | null): Project {
    return c ? projectWith(this.d.project(), this.d.track().id, c, this.extras) : this.d.project();
  }

  /** The stored pitch of a candidate (null: the original) and whether the sound changed since. Never renders. */
  pitchOf(c: Candidate | null): { record: PitchRecord; stale: boolean } | null {
    const record = this.pitches.get(this.pitchKey(c));
    if (!record) return null;
    return { record, stale: record.fingerprint !== soundFingerprint(this.pitchProject(c), this.target()) };
  }

  /** What to print for a candidate's pitch: a note only when one was found and trusted. */
  pitchText(c: Candidate | null): string {
    const p = this.pitchOf(c);
    return p && !p.stale ? pitchBadge(p.record.analysis).text : '—';
  }

  /** Analyse one sound with the Phase 2 analysis; a fresh stored result is reused. */
  async analyse(c: Candidate | null): Promise<PitchRecord | null> {
    if (this.voice < 0) return null;
    const have = this.pitchOf(c);
    if (have && !have.stale) return have.record;
    const rec = await this.d.analyse(this.pitchProject(c), this.target());
    this.pitches.set(this.pitchKey(c), rec);
    this.d.changed();
    return rec;
  }

  /** Analyse the original and every candidate that has no fresh result (one at a time). */
  async analyseAll(): Promise<void> {
    if (this.busy || this.voice < 0) return;
    this.busy = 'ANALYSING PITCH…';
    this.d.changed();
    try {
      await this.analyse(null);
      for (const s of this.state.slots) if (s.cand) await this.analyse(s.cand);
    } finally {
      this.busy = null;
      this.d.changed();
    }
  }

  // ---------------------------------------------------------------- applying and saving
  /** Is this candidate already what the instrument is? */
  isLive(c: Candidate): boolean {
    const p = this.d.project();
    const { kit } = applyToKit(p.kit.synth, c.voice, c, p.soundLocks);
    const k = p.kit.synth;
    return kit.params.every((v, i) => v === k.params[i]) && kit.lfoTarget[c.voice] === k.lfoTarget[c.voice] && kit.velTarget[c.voice] === k.velTarget[c.voice];
  }

  /** APPLY: the candidate becomes the instrument's voice. One undo step; the original comes back with UNDO. */
  apply(i = this.state.selected): boolean {
    const c = this.candidate(i);
    if (!c || this.voice !== c.voice) return false;
    const r = this.d.apply(c, this.extras && !!c.extras);
    this.stop();
    this.d.say(`APPLIED ${c.name}${r.locked ? ` · ${r.locked} LOCKED PARAMETERS KEPT` : ''} · UNDO RESTORES THE ORIGINAL`);
    this.d.changed();
    return true;
  }

  /** Save a candidate to the library; its pitch goes with it when it has been measured. */
  save(i: number, name: string): LibrarySound | null {
    const c = this.candidate(i);
    if (!c) return null;
    const have = this.pitchOf(c);
    const a = have && !have.stale ? have.record.analysis : null;
    const badge = pitchBadge(a);
    const pitch = a ? (badge.reliable && a.fundamental ? { note: a.fundamental.note, hz: Math.round(a.fundamental.hz * 100) / 100 } : { kind: a.kind }) : undefined;
    // modulation and variations come with a candidate that has them, or from the track being discovered when it is the live sound
    const withTrack = c.extras ?? (this.isLive(c) ? extrasOf(this.d.track(), c.voice) : undefined);
    const s = this.library.add({ ...c, ...(withTrack ? { extras: withTrack } : {}) }, name, pitch);
    this.d.changed();
    return s;
  }

  /** Save the instrument as it is now (the original) to the library. */
  saveOriginal(name: string): LibrarySound | null {
    const v = this.voice;
    if (v < 0) return null;
    const p = this.d.project();
    const t = this.d.track();
    const target = (par: number) => keyOfPar(v, par);
    const c: Candidate = {
      key: '',
      name: t.name,
      voice: v,
      values: voiceValues(p.kit.synth, v),
      lfo: target(p.kit.synth.lfoTarget[v] ?? 0),
      vel: target(p.kit.synth.velTarget[v] ?? 0),
      origin: { kind: 'library', seed: 0, index: 0, draw: 0, character: this.effectiveCharacter, wildness: 0, voice: v, archetype: archetypeOf(p, v), lineage: [], from: '', generator: 0 },
      ...(extrasOf(t, v) ? { extras: extrasOf(t, v)! } : {}),
    };
    c.key = candidateKey(c);
    const s = this.library.add(c, name);
    this.d.changed();
    return s;
  }

  /** Put a library sound in a candidate slot (the selected one, else the first free); the instrument is not touched. */
  load(id: string): number | null {
    const s = this.library.get(id);
    const v = this.voice;
    if (!s || v < 0) return null;
    let c = candidateOf(s);
    if (c.voice !== v) c = retarget(c, v);
    const st = this.state;
    let i = st.slots.findIndex((x) => !x.cand);
    if (i < 0) i = st.selected ?? st.slots.findIndex((x) => !x.held);
    if (i < 0) i = 0;
    const slot = st.slots[i]!;
    if (slot.cand) slot.back = [...slot.back, slot.cand].slice(-BACK_MAX);
    slot.cand = c;
    slot.held = false;
    st.selected = i;
    this.d.say(`LOADED ${s.name}${s.voice !== v ? ' · MOVED TO THIS VOICE' : ''}${describeSound(s) ? ' · ' + describeSound(s) : ''}`);
    this.d.changed();
    return i;
  }

  /** The screen should redraw (the library changed). */
  notify(): void {
    this.d.changed();
  }

  /** A new project: nothing carries over (the saved library does). */
  reset(): void {
    this.states.clear();
    this.audio.clear();
    this.pitches.clear();
    this.playSeq++;
    this.d.stop();
    this.playing = null;
  }

  /** Forget the candidates of the selected voice. */
  clear(): void {
    this.states.delete(this.voice);
    this.playing = null;
    this.d.changed();
  }
}

/** A candidate on another voice: the parameters that voice has, its modulation targets by name. */
export function retarget(c: Candidate, voice: number): Candidate {
  const keys = voiceKeys(voice);
  const values: Candidate['values'] = {};
  for (const [k, v] of Object.entries(c.values) as [Key, number][]) if (keys[k] !== undefined) values[k] = v;
  const lfo = c.lfo && keys[c.lfo] !== undefined ? c.lfo : null;
  const vel = c.vel && keys[c.vel] !== undefined ? c.vel : null;
  const next = { voice, values, lfo, vel, ...(c.extras ? { extras: c.extras } : {}) };
  return { ...c, ...next, key: candidateKey(next), origin: { ...c.origin, voice } };
}
