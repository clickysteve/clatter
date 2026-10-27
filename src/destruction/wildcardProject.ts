/**
 * WILDCARD, the whole instrument: one seeded, deliberately unpredictable re-imagining that can
 * reach the tempo, the swing, the rhythm, step positions, hit probabilities, trigger conditions,
 * the synthesis kit, sound variations and step sounds, sample choices and their playback,
 * modulation, FX, the mixer and the output chain.
 *
 * It only uses what CLATTER really has: it calls the same generators the buttons call (the
 * rhythm mutator and generator, the kit mutator, the variation and step-sound generators, the
 * modulation generator) and the same data model, and keeps every value inside the range the
 * controls allow.
 *
 *   INTENSITY  0-100. At 10 the changes are small and mostly musical (a nudge of tempo, a few
 *              hits moved, a little FX); at 100 almost everything in scope can change by a lot.
 *   SCOPE      track · pattern · kit · project (see SCOPE_CATS for what each reaches).
 *   CATEGORIES any of them can be left out.
 *   SEED       the result is a pure function of (project, settings, seed, track, pool): the same
 *              project and seed always give the same result, which is how it is regenerated.
 *
 * Guard rails, whatever the intensity: nothing leaves its legal range; locked tracks, locked
 * voices and locked parameters, mutes and solos are respected; at least one audible track keeps a
 * usable level; sends and volumes are capped; changing the output stage keeps the limiter on;
 * the tempo stays inside 40-240 BPM and within a factor of about 1.5 of where it was.
 *
 * The caller makes the change one undo step (the history snapshots the whole project, tempo
 * and all). This module changes the project it is given in place and reports what it did.
 *
 * After The Breakery's WILDCARD (src/engine/wildcard.ts, MIT, see THIRD_PARTY_NOTICES.md): the
 * idea of a bounded, reported, seeded re-imagining; this implementation is CLATTER's.
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import { channelFxActive, defaultChannelFx, defaultOutputFx, type ChannelFx } from '../audio/mixfx';
import { generateMod, mutateMod, type ModTarget } from '../mod/presets';
import { clamp, type Grid, type Project, type StepSound, type Track, type TrigCond } from '../model/types';
import { PAR } from '../sound/lxrParamIds';
import { generate } from '../rhythm/generate';
import { mutate, summariseOps } from '../rhythm/mutate';
import { setHit, setSounds, setStepTrig, shiftTrack, sourceGrid } from '../rhythm/pattern';
import { hash32, Rng, SALT, strCode } from '../rhythm/rng';
import { checkedSeedText } from '../rhythm/seed';
import { styleById } from '../rhythm/styles';
import { distributeSounds, generateVariations, mutateSounds } from '../sound/soundgen';
import { kitPitchPlans, pitchPlanOf } from '../music/tuning';
import { mutateKit, voiceRolesOf } from '../sound/kitgen';
import { isEmptyStepSound } from '../sound/stepSound';
import { BPM_MAX, BPM_MIN, MAX_TEMPO_BARS, repairTempoAuto, type TempoAuto, type TempoPoint } from '../transport/tempo';
import { wildcard as classicWildcard } from './wildcard';

export type WildScope = 'track' | 'pattern' | 'kit' | 'project';
export const WILD_SCOPES: WildScope[] = ['track', 'pattern', 'kit', 'project'];
export const SCOPE_LABEL: Record<WildScope, string> = { track: 'SELECTED TRACK', pattern: 'SELECTED PATTERN', kit: 'ENTIRE KIT', project: 'ENTIRE PROJECT' };
export const SCOPE_HELP: Record<WildScope, string> = {
  track: 'The selected track: its rhythm and conditions in this pattern, its voice, sound, samples, modulation, channel FX and mixer strip.',
  pattern: 'The selected pattern, every track: rhythm, step positions, probabilities, conditions and which sound each step plays.',
  kit: 'Every track’s sound: the LXR kit and FX bus, variations, samples, modulation, channel FX and the mixer. The rhythm is left alone.',
  project: 'Everything: tempo and swing, every pattern, the whole kit, the mixer and the output chain.',
};

export const WILD_CATS = ['tempo', 'rhythm', 'triggers', 'sound', 'samples', 'mod', 'fx', 'mixer', 'output'] as const;
export type WildCat = (typeof WILD_CATS)[number];
export const CAT_LABEL: Record<WildCat, string> = { tempo: 'TEMPO', rhythm: 'RHYTHM', triggers: 'TRIGGERS', sound: 'SOUND', samples: 'SAMPLES', mod: 'MODULATION', fx: 'FX', mixer: 'MIXER', output: 'OUTPUT' };
export const CAT_HELP: Record<WildCat, string> = {
  tempo: 'BPM, swing and a tempo curve that moves the tempo over time',
  rhythm: 'hits added, removed, moved and rotated; generator controls; CHOP, ROLLS and DESTROY',
  triggers: 'hit probabilities and conditional triggers (every Nth, odd, alternating, previous step ...)',
  sound: 'the LXR kit, sound variations and which variation each step plays',
  samples: 'which samples tracks play, and their tuning, region, reverse, gain and pan',
  mod: 'modulation sources, destinations, depths and envelope shapes',
  fx: 'the LXR FX bus and each track’s channel processing',
  mixer: 'track levels, pan and FX sends',
  output: 'the master bus: filter, distortion, compression, width, limiter',
};

/** What each scope reaches. */
export const SCOPE_CATS: Record<WildScope, readonly WildCat[]> = {
  track: ['rhythm', 'triggers', 'sound', 'samples', 'mod', 'fx', 'mixer'],
  pattern: ['rhythm', 'triggers', 'sound'],
  kit: ['sound', 'samples', 'mod', 'fx', 'mixer'],
  project: WILD_CATS,
};
export const wildAffects = (scope: WildScope, cat: WildCat): boolean => SCOPE_CATS[scope].includes(cat);

export interface WildSettings {
  seed: number;
  /** the phrase that named the seed (absent: a plain number) */
  seedText?: string;
  /** 0-100 */
  intensity: number;
  scope: WildScope;
  cats: WildCat[];
}

export const defaultWild = (): WildSettings => ({ seed: 1, intensity: 50, scope: 'project', cats: [...WILD_CATS] });

export function repairWild(v: unknown): WildSettings {
  const d = defaultWild();
  if (!v || typeof v !== 'object') return d;
  const o = v as Record<string, unknown>;
  const n = (x: unknown, dv: number, lo: number, hi: number) => (typeof x === 'number' && Number.isFinite(x) ? Math.round(clamp(x, lo, hi)) : dv);
  const seed = n(o.seed, d.seed, 0, 0xffffffff);
  const seedText = checkedSeedText(seed, o.seedText);
  return {
    seed,
    ...(seedText ? { seedText } : {}),
    intensity: n(o.intensity, d.intensity, 0, 100),
    scope: WILD_SCOPES.includes(o.scope as WildScope) ? (o.scope as WildScope) : d.scope,
    cats: Array.isArray(o.cats) ? WILD_CATS.filter((c) => (o.cats as unknown[]).includes(c)) : d.cats,
  };
}

export interface WildInput {
  /** the selected track (scope TRACK) */
  track: string;
  /** the samples a track may be given (the library) */
  pool?: { id: string; role: string }[];
}

export interface WildResult {
  report: string[];
  /** how many things changed, by category */
  counts: Partial<Record<WildCat, number>>;
}

const round = (v: number, d = 0) => {
  const m = Math.pow(10, d);
  return Math.round(v * m) / m;
};

/** Apply a WILDCARD to a project, in place. */
export function applyWildcard(p: Project, s: WildSettings, input: WildInput): WildResult {
  const k = clamp(s.intensity, 0, 100) / 100;
  const counts: Partial<Record<WildCat, number>> = {};
  const report: string[] = [];
  const has = (c: WildCat) => s.cats.includes(c) && wildAffects(s.scope, c);
  const bump = (c: WildCat, n = 1) => (counts[c] = (counts[c] ?? 0) + n);
  if (k <= 0) return { report: ['INTENSITY 0: NOTHING CHANGED'], counts };
  const rng = (...salt: number[]) => new Rng(hash32(s.seed, SALT.wild, ...salt));

  const selected = p.tracks.find((t) => t.id === input.track) ?? p.tracks[0]!;
  const tracks: Track[] = s.scope === 'track' ? [selected] : p.tracks;
  const patterns = s.scope === 'project' ? p.patterns : [p.patterns.find((x) => x.id === p.current) ?? p.patterns[0]!];
  const voices = [...new Set(tracks.filter((t) => t.sound.mode !== 'sample').map((t) => (t.sound.trigger >= 5 ? 5 : t.sound.trigger)))];
  const kitOpts = { seed: s.seed, flavour: styleById(p.gen.style).kitFlavour, voiceRoles: voiceRolesOf(p.tracks), locks: p.soundLocks, pitch: kitPitchPlans(p) };

  // ------------------------------------------------------------------ TEMPO
  if (has('tempo')) {
    const r = rng(1);
    const parts: string[] = [];
    // the overall BPM: a nudge at low intensity, a real move at high, always inside sensible limits
    const amp = 0.03 + 0.25 * k;
    const lo = Math.max(40, p.tempo / 1.5);
    const hi = Math.min(240, p.tempo * 1.5);
    const bpm = Math.round(clamp(p.tempo * (1 + r.bell() * amp), lo, hi));
    if (bpm !== p.tempo) {
      parts.push(`BPM ${p.tempo} → ${bpm}`);
      p.tempo = bpm;
      bump('tempo');
    }
    // tempo changes over time
    if (r.chance(0.3 + 0.6 * k)) {
      const bars = Math.max(1, Math.round((patterns[0]?.steps ?? 16) / ((patterns[0]?.res ?? 4) * 4)));
      const auto = tempoCurve(r, k, p.tempo, bars);
      p.tempoAuto = auto.curve;
      parts.push(`TEMPO CURVE ${auto.name} ${auto.curve.bars} BARS`);
      bump('tempo');
    } else if (p.tempoAuto && r.chance(0.5 * k)) {
      delete p.tempoAuto;
      parts.push('TEMPO CURVE OFF');
      bump('tempo');
    }
    const swing = Math.round(clamp(p.swing + r.bell() * (2 + 8 * k), 50, 68));
    if (r.chance(0.3 + 0.5 * k) && swing !== p.swing) {
      parts.push(`SWING ${swing}%`);
      p.swing = swing;
      bump('tempo');
    }
    if (parts.length) report.push(parts.join(' · '));
  }

  // ------------------------------------------------------------------ RHYTHM and TRIGGERS, per pattern
  const unlocked = tracks.filter((t) => !t.lock);
  for (const pat of patterns) {
    const pr = (salt: number) => rng(2, strCode(pat.id), salt);
    if (has('rhythm') && unlocked.length) {
      const r = pr(1);
      const parts: string[] = [];
      const ids = unlocked.map((t) => t.id);
      // generator controls, transformations and (sometimes) a new baseline: the classic WILDCARD, gated by intensity
      if (s.scope === 'project' || s.scope === 'pattern') {
        if (r.chance(0.2 + 0.7 * k)) {
          const w = classicWildcard(p.gen, p.destruction, p.swing, hash32(s.seed, SALT.wild, strCode(pat.id), 91));
          p.gen = w.gen;
          p.destruction = w.destruction;
          if (w.regenerate && r.chance(0.3 + 0.7 * k)) {
            pat.settings = { ...w.gen };
            pat.seed = hash32(s.seed, SALT.wild, strCode(pat.id), 92);
            delete pat.seedText; // a derived number has no phrase
            const keep = Object.fromEntries(p.tracks.filter((t) => t.lock || !ids.includes(t.id)).map((t) => [t.id, sourceGrid(pat, t.id)]));
            pat.gen = generate(p.tracks, pat.settings, pat.seed, { steps: pat.steps, res: pat.res }, { ...pat.gen, ...keep });
            for (const id of ids) delete pat.edits[id];
            pat.generation++;
            parts.push('REGENERATED');
          }
          parts.push(...w.report.filter((x) => !x.startsWith('SWING') && !x.startsWith('KIT')).slice(0, 3));
        }
      }
      // hits added, removed, moved, swapped, rotated, reversed
      if (r.chance(0.35 + 0.65 * k)) {
        const lengths = Object.fromEntries(p.tracks.filter((t) => t.play.length > 0).map((t) => [t.id, t.play.length]));
        const src = Object.fromEntries(p.tracks.map((t) => [t.id, sourceGrid(pat, t.id)] as [string, Grid]));
        const m = mutate(src, ids, pat.res, new Rng(hash32(s.seed, SALT.wild, strCode(pat.id), 93)), 0.1 + 0.75 * k, lengths);
        for (const id of ids) {
          pat.gen[id] = m.grids[id]!;
          delete pat.edits[id];
        }
        pat.generation++;
        if (m.ops.length) parts.push(summariseOps(m.ops));
      }
      // step positions: a track's whole line moves
      if (k > 0.15) {
        const movers = unlocked.filter(() => r.chance(0.1 + 0.4 * k));
        for (const t of movers.slice(0, 1 + Math.round(3 * k))) {
          const by = r.pick([-2, -1, 1, 2, 4]);
          shiftTrack(pat, t.id, by);
          parts.push(`${t.name} SHIFT ${by > 0 ? '+' : ''}${by}`);
        }
      }
      if (parts.length) {
        bump('rhythm', parts.length);
        report.push(`${s.scope === 'project' ? 'PATTERN ' + pat.name + ': ' : ''}${parts.join(' · ')}`);
      }
    }

    if (has('triggers') && unlocked.length) {
      const r = pr(2);
      let probs = 0;
      let conds = 0;
      for (const t of unlocked) {
        const g = sourceGrid(pat, t.id);
        const steps = g.map((h, i) => (h ? i : -1)).filter((i) => i >= 0);
        if (!steps.length) continue;
        // hits that hold the groove stay certain: the first hit of a kick or snare, and the downbeat
        const anchor = new Set<number>([steps[0]!]);
        if (t.role === 'kick' || t.role === 'snare') anchor.add(0);
        const candidates = steps.filter((i) => !anchor.has(i));
        const room = Math.floor(steps.length * 0.6);
        let used = 0;
        for (const i of candidates) {
          if (used >= room) break;
          const roll = r.next();
          // probability: a share of the hits become uncertain (never impossible)
          if (roll < 0.04 + 0.28 * k) {
            const p0 = Math.round(clamp(100 - (10 + 55 * k) * (0.3 + 0.7 * r.next()), 20, 95) / 5) * 5;
            setHit(pat, t.id, i, { ...g[i]!, prob: p0 });
            probs++;
            used++;
          } else if (roll < 0.04 + 0.28 * k + 0.02 + 0.2 * k) {
            const c = wildTrig(r, k);
            if (c) {
              setStepTrig(pat, t.id, i, c);
              conds++;
              used++;
            }
          }
        }
        // at high intensity, old conditions of this track may go
        if (k > 0.6 && pat.trig?.[t.id]) for (const key of Object.keys(pat.trig[t.id]!)) if (r.chance(0.25 * k)) setStepTrig(pat, t.id, Number(key), undefined);
      }
      if (probs || conds) {
        bump('triggers', probs + conds);
        report.push(`${s.scope === 'project' ? 'PATTERN ' + pat.name + ': ' : ''}${probs} CHANCES · ${conds} CONDITIONS`);
      }
    }

    // which variation each step plays (the variations themselves are made below)
    if (has('sound') && s.scope !== 'kit' && tracks.length) {
      const r = pr(3);
      let n = 0;
      const geo = { steps: pat.steps, perBeat: pat.res, perBar: pat.res * 4 };
      for (const t of tracks) {
        if (t.sound.soundLock) continue;
        if (!r.chance(0.3 + 0.7 * k)) continue;
        const seed = hash32(s.seed, SALT.wild, strCode(pat.id), strCode(t.id), 94);
        const opts = { seed, take: 1, amount: clamp(0.25 + 0.75 * k, 0, 1), locks: p.soundLocks, ...geo, pitch: pitchPlanOf(p, t) };
        const next = pat.sounds?.[t.id] && r.chance(0.5) ? mutateSounds(t.sound, t.role, sourceGrid(pat, t.id), pat.sounds[t.id], p.kit.synth.params, { ...opts, amount: 0.3 + 0.6 * k }) : distributeSounds(t.sound, t.role, sourceGrid(pat, t.id), pat.sounds?.[t.id], p.kit.synth.params, opts);
        setSounds(pat, t.id, clean(next));
        n += Object.keys(next).length;
      }
      if (n) bump('sound', n);
    }
  }

  // ------------------------------------------------------------------ SOUND: the kit and the variations
  if (has('sound') && s.scope !== 'pattern') {
    const r = rng(4);
    const parts: string[] = [];
    if (voices.length && r.chance(0.35 + 0.65 * k)) {
      const amount = 0.08 + 0.55 * k;
      p.kit.synth = mutateKit(p.kit.synth, { ...kitOpts, seed: hash32(s.seed, SALT.wild, 95), amount, voices });
      p.kit.seed = hash32(s.seed, 96);
      delete p.kit.seedText;
      bump('sound', voices.length);
      parts.push(`KIT MUTATED ${Math.round(amount * 100)}% (${voices.length} VOICES)`);
    }
    let nv = 0;
    for (const t of tracks) {
      if (t.sound.soundLock || !r.chance(0.25 + 0.65 * k)) continue;
      const before = JSON.stringify(t.sound.variations ?? null);
      t.sound.variations = generateVariations(t.sound, t.role, p.kit.synth.params, { seed: hash32(s.seed, SALT.wild, strCode(t.id), 97), amount: 0.25 + 0.75 * k, locks: p.soundLocks, pitch: pitchPlanOf(p, t) });
      if (t.sound.variations.every((v) => !v)) delete t.sound.variations;
      if (JSON.stringify(t.sound.variations ?? null) !== before) nv++;
    }
    if (nv) {
      bump('sound', nv);
      parts.push(`VARIATIONS FOR ${nv} TRACKS`);
    }
    if (parts.length) report.push(parts.join(' · '));
  }

  // ------------------------------------------------------------------ SAMPLES
  if (has('samples')) {
    const r = rng(5);
    let n = 0;
    for (const t of tracks) {
      if (t.sound.mode === 'synth' || t.sound.soundLock || !t.sound.samples.length) continue;
      const so = t.sound;
      if (!r.chance(0.25 + 0.7 * k)) continue;
      const pool = (input.pool ?? []).filter((x) => x.role === t.role);
      const pool2 = pool.length ? pool : (input.pool ?? []);
      if (pool2.length > 1 && r.chance(0.2 + 0.5 * k)) {
        const pick = r.pick(pool2);
        if (pick && !so.samples.includes(pick.id)) so.samples = [pick.id, ...so.samples.slice(1, 3)];
      }
      if (so.samples.length > 1 && r.chance(0.5 * k)) so.pick = r.pick(['cycle', 'random', 'velocity'] as const);
      so.tune = Math.round(clamp(so.tune + r.bell() * (1 + 6 * k), -12, 12));
      so.fine = Math.round(clamp(so.fine + r.bell() * 30 * k, -50, 50));
      so.gain = round(clamp(so.gain * (1 + r.bell() * 0.3 * k), 0.4, 1.4), 2);
      so.pan = round(clamp(so.pan + r.bell() * 0.5 * k, -0.8, 0.8), 2);
      if (r.chance(0.05 + 0.2 * k)) so.reverse = !so.reverse;
      if (r.chance(0.2 + 0.4 * k)) {
        // a different region of the sample: always at least a tenth of it
        const start = round(r.next() * 0.35 * k, 2);
        so.start = Math.min(start, 0.6);
        so.end = round(clamp(1 - r.next() * 0.3 * k, so.start + 0.1, 1), 2);
      }
      n++;
    }
    if (n) {
      bump('samples', n);
      report.push(`SAMPLES: ${n} TRACKS`);
    }
  }

  // ------------------------------------------------------------------ MODULATION
  if (has('mod')) {
    const r = rng(6);
    let n = 0;
    for (const t of tracks) {
      if (t.sound.soundLock || !r.chance(0.3 + 0.6 * k)) continue;
      const target: ModTarget = { mode: t.sound.mode, voice: t.sound.trigger >= 5 ? 5 : t.sound.trigger };
      const seed = hash32(s.seed, SALT.wild, strCode(t.id), 98);
      const had = t.sound.mod && (Object.keys(t.sound.mod.sources).length || t.sound.mod.routes.length);
      const next = had && r.chance(0.65) ? mutateMod(t.sound.mod!, seed, target, 0.2 + 0.7 * k) : generateMod(seed, target, 0.2 + 0.8 * k);
      if (next.routes.length || Object.keys(next.sources).length) {
        t.sound.mod = next;
        n++;
      }
    }
    if (n) {
      bump('mod', n);
      report.push(`MODULATION: ${n} TRACKS`);
    }
  }

  // ------------------------------------------------------------------ FX: the LXR FX bus and channel processing
  if (has('fx')) {
    const r = rng(7);
    let n = 0;
    const prm = p.kit.synth.params;
    const nudge = (par: number, spread: number) => {
      if (p.soundLocks.params.includes(par)) return false;
      prm[par] = Math.round(clamp((prm[par] ?? 0) + r.bell() * spread * 127, 0, 127));
      return true;
    };
    if (s.scope !== 'track' && r.chance(0.3 + 0.6 * k)) {
      // the FX bus: wet/dry and its four parameters move; the type changes only at high intensity
      let any = nudge(PAR.FX_DRY_WET, 0.1 + 0.3 * k);
      for (const par of [PAR.FX_P1, PAR.FX_P2, PAR.FX_P3, PAR.FX_P4]) any = nudge(par, 0.08 + 0.35 * k) || any;
      if (any) {
        n++;
        report.push('FX BUS MOVED');
      }
    }
    for (const t of tracks) {
      if (!r.chance(0.2 + 0.55 * k)) continue;
      t.mix.fx = wildChannel(r, k, t.mix.fx);
      t.mix.send = round(clamp((t.mix.send ?? 0) + r.bell() * 0.3 * k, 0, 0.7), 2);
      n++;
    }
    if (n) bump('fx', n);
  }

  // ------------------------------------------------------------------ MIXER
  if (has('mixer')) {
    const r = rng(8);
    let n = 0;
    for (const t of tracks) {
      if (!r.chance(0.35 + 0.6 * k)) continue;
      t.mix.volume = round(clamp(t.mix.volume * (1 + r.bell() * 0.45 * k), 0.25, 0.95), 2);
      // the low end and the backbeat stay centred
      const wide = t.role === 'kick' ? 0.1 : t.role === 'snare' ? 0.25 : 1;
      t.mix.pan = round(clamp(t.mix.pan + r.bell() * 0.7 * k * wide, -0.85, 0.85), 2);
      n++;
    }
    if (n) {
      bump('mixer', n);
      report.push(`MIXER: ${n} STRIPS`);
    }
  }

  // ------------------------------------------------------------------ OUTPUT
  if (has('output')) {
    const r = rng(9);
    const out = (p.master.out ??= defaultOutputFx());
    const parts: string[] = [];
    if (r.chance(0.25 + 0.55 * k)) {
      out.bus.filter = { on: true, hp: Math.round(r.range(20, 40 + 140 * k)), lp: Math.round(r.range(20000 - 9000 * k, 20000)) };
      parts.push('BUS FILTER');
    }
    if (r.chance(0.15 + 0.5 * k)) {
      out.bus.dist = { on: true, type: r.pick(['tube', 'tube', 'fold', 'clip'] as const), drive: round(0.08 + 0.3 * k * r.next(), 2), mix: round(0.2 + 0.4 * r.next(), 2) };
      parts.push('BUS DISTORTION');
    }
    if (r.chance(0.2 + 0.5 * k)) {
      out.bus.comp = { on: true, thresh: Math.round(r.range(-22, -10)), ratio: round(r.range(1.8, 2.5 + 3 * k), 1), attack: Math.round(r.range(5, 30)), release: Math.round(r.range(60, 250)), makeup: Math.round(r.range(1, 4)), mix: round(r.range(0.6, 1), 2) };
      parts.push('BUS COMPRESSION');
    }
    if (r.chance(0.2 + 0.4 * k)) {
      out.bus.stereo = { on: true, width: round(r.range(0.8, 1.15 + 0.35 * k), 2) };
      parts.push('WIDTH');
    }
    if (parts.length) {
      // whatever was just added, the output stays under control
      out.limiter = { on: true, ceiling: -0.3, release: out.limiter.release };
      bump('output', parts.length);
      report.push(`OUTPUT: ${parts.join(' · ')}`);
    }
  }

  guard(p);
  if (!report.length) report.push('A QUIET ONE: NOTHING IN SCOPE CHANGED');
  return { report, counts };
}

/** Invariants that hold after any WILDCARD. */
export function guard(p: Project): void {
  p.tempo = clamp(p.tempo, BPM_MIN, BPM_MAX);
  p.swing = clamp(p.swing, 50, 75);
  if (p.tempoAuto) {
    const fixed = repairTempoAuto(p.tempoAuto);
    if (fixed) p.tempoAuto = fixed;
    else delete p.tempoAuto;
  }
  p.master.volume = clamp(p.master.volume, 0.5, 1);
  for (const t of p.tracks) {
    t.mix.volume = clamp(t.mix.volume, 0, 0.95);
    t.mix.pan = clamp(t.mix.pan, -1, 1);
    if (t.mix.send !== undefined) t.mix.send = clamp(t.mix.send, 0, 0.8);
  }
  // never a silent mixer: one audible track keeps a usable level
  const audible = p.tracks.filter((t) => !t.mix.mute && (!p.tracks.some((x) => x.mix.solo) || t.mix.solo));
  if (audible.length && !audible.some((t) => t.mix.volume >= 0.4)) audible[0]!.mix.volume = 0.7;
  // the kit: every value inside 0-127
  for (let i = 0; i < p.kit.synth.params.length; i++) p.kit.synth.params[i] = clamp(Math.round(p.kit.synth.params[i] ?? 0), 0, 127);
  // a master bus that is distorting or compressing keeps its limiter
  const o = p.master.out;
  if (o && (o.bus.dist.on || o.bus.comp.on)) o.limiter.on = true;
}

const clean = (m: Record<number, StepSound>): Record<number, StepSound> => Object.fromEntries(Object.entries(m).filter(([, v]) => !isEmptyStepSound(v)));

/** A trigger condition for one step, weighted towards the musical ones. */
function wildTrig(r: Rng, k: number): TrigCond | null {
  const roll = r.next();
  if (roll < 0.28) return { k: 'prob', p: Math.round(clamp(r.range(35, 90 - 25 * k), 20, 95) / 5) * 5 };
  if (roll < 0.5) {
    const n = r.pick([2, 3, 4, 4, 8]);
    return { k: 'every', n, at: r.chance(0.6) ? n : r.irange(1, n) };
  }
  if (roll < 0.62) return { k: 'odd' };
  if (roll < 0.74) return { k: 'even' };
  if (roll < 0.84) return { k: 'alt', run: r.pick([1, 2, 2, 4]) };
  if (roll < 0.9) return { k: 'first' };
  if (roll < 0.96) return { k: 'prev' };
  return k > 0.5 ? { k: 'noprev' } : { k: 'prob', p: 70 };
}

/** One channel strip's processing, moved a bounded amount. */
function wildChannel(r: Rng, k: number, cur: ChannelFx | undefined): ChannelFx {
  const fx = cur ? (JSON.parse(JSON.stringify(cur)) as ChannelFx) : defaultChannelFx();
  const kind = r.pick(['trans', 'eq', 'sat', 'crush', 'clip'] as const);
  switch (kind) {
    case 'trans':
      fx.trans = { on: true, attack: round(clamp(r.bell() * (0.3 + 0.6 * k), -1, 1), 2), sustain: round(clamp(r.bell() * (0.3 + 0.5 * k), -1, 1), 2) };
      break;
    case 'eq':
      fx.eq = { on: true, low: round(clamp(r.bell() * (2 + 7 * k), -9, 9), 1), mid: round(clamp(r.bell() * (2 + 6 * k), -9, 9), 1), high: round(clamp(r.bell() * (2 + 7 * k), -9, 9), 1) };
      break;
    case 'sat':
      fx.sat = { on: true, drive: round(0.1 + 0.5 * k * r.next(), 2), mix: round(0.4 + 0.6 * r.next(), 2) };
      break;
    case 'crush':
      // heavy bit reduction only at high intensity
      fx.crush = k > 0.55 ? { on: true, bits: r.irange(7, 11), rate: round(0.15 + 0.35 * r.next(), 2) } : { on: false, bits: 10, rate: 0.2 };
      break;
    case 'clip':
      fx.clip = { on: true, thresh: round(r.range(0.6, 0.95), 2) };
      break;
  }
  return channelFxActive(fx) ? fx : defaultChannelFx();
}

/** A tempo curve around the BPM: gentle at low intensity, pronounced at high, always a musical shape. */
export function tempoCurve(r: Rng, k: number, bpm: number, patternBars: number): { name: string; curve: TempoAuto } {
  const loop = clamp(patternBars * r.pick([1, 2, 2, 4]), 2, Math.min(16, MAX_TEMPO_BARS));
  const d = 0.02 + 0.14 * k;
  // keep the tempo inside sensible limits: the multiplier range that stays within 50-240 BPM
  const lo = Math.max(0.5, 50 / bpm);
  const hi = Math.min(2, 240 / bpm);
  const m = (v: number) => round(clamp(v, lo, hi), 3);
  const shape = r.pick(['BREATHE', 'PUSH', 'DRAG', 'STAGGER', 'ACCELERANDO'] as const);
  const pts: TempoPoint[] = [];
  const half = loop / 2;
  switch (shape) {
    case 'BREATHE': // slow and fast against the beat, gliding both ways
      pts.push({ bar: 0, mul: 1, ramp: true }, { bar: half, mul: m(1 + d), ramp: true });
      break;
    case 'PUSH': // the last bars lean forward, then snap back
      pts.push({ bar: 0, mul: 1 }, { bar: loop - Math.max(1, Math.round(loop / 4)), mul: m(1 + d * 0.8) });
      break;
    case 'DRAG': // the last bars hold back
      pts.push({ bar: 0, mul: 1 }, { bar: loop - Math.max(1, Math.round(loop / 4)), mul: m(1 - d * 0.8) });
      break;
    case 'STAGGER': // each bar a little different, in steps
      for (let b = 0; b < loop; b += Math.max(1, Math.round(loop / 4))) pts.push({ bar: b, mul: b === 0 ? 1 : m(1 + r.bell() * d) });
      break;
    case 'ACCELERANDO': // a steady push over the loop, then back
      pts.push({ bar: 0, mul: 1, ramp: true }, { bar: loop - 1, mul: m(1 + d * 1.2), ramp: false });
      break;
  }
  const curve = repairTempoAuto({ on: true, bars: loop, points: pts }) ?? { on: true, bars: loop, points: [{ bar: 0, mul: 1 }] };
  return { name: shape, curve };
}

