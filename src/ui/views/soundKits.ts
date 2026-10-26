/**
 * The KITS tab: the three kinds of kit side by side (synth kit, sample set, full kit), what each
 * one contains, kit generation and mutation, and the voice locks. Loading one half never touches
 * the other, or the patterns; everything that lists, renames, duplicates, deletes or imports
 * lives in the KIT LIBRARY dialog, one press away from each kind.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import type { App } from '../../app/app';
import { errText, type KitKind } from '../../app/kitManager';
import { synthKitOf } from '../../model/kits';
import { VOICES } from '../../sound/lxrParams';
import { kitLibraryDialog, openKitFile } from '../kitDialogs';
import { button, chooseFiles, download, group, h, num, Panel, range, select } from '../widgets';
import { CHARACTERS } from '../../model/types';
import { CHARACTER_DEFS, PROFILE_LABEL, PROFILES, type Profile } from '../../sound/profiles';
import { viewVoice } from './soundControls';
import { subscribe } from './patternView';
import type { PaneParts } from './soundUi';

const CONTENT: Record<KitKind, string> = {
  synth: 'THE LXR SYNTHESIS: PARAMETERS, THE FX BUS, VOICE ASSIGNMENTS, EACH TRACK’S MODULATION AND VARIATION PARAMETERS. NO SAMPLES.',
  set: 'WHICH SAMPLES EACH TRACK PLAYS, WITH TUNE, GAIN, PAN, REVERSE AND REGION. NO SYNTHESIS, MIXER OR RHYTHM.',
  full: 'A SYNTH KIT AND A SAMPLE SET TOGETHER, WITH SOURCE MODES, HYBRID BALANCE, THE MIXER (LEVELS, SENDS, CHANNEL PROCESSING) AND THE OUTPUT STAGE. NEVER THE PATTERNS.',
};

export function kitsPane(app: App, pane: HTMLElement): PaneParts {
  const kp = new Panel();
  const top = h('div', 'row wrap sndtop kitgen', pane);
  top.dataset.test = 'kit-gen';
  h('div', 'lbl', top, 'CHARACTER');
  const cs = select(kp, top, {
    options: () => CHARACTERS.map((c) => ({ value: c, label: CHARACTER_DEFS[c].label })),
    get: () => app.kitGen.character,
    set: (c) => app.setCharacter(c),
    width: 116,
    title: 'How the kit should sound: CLASSIC drum machine, ANALOG warmth, DIGITAL FM and metal, INDUSTRIAL aggression, MINIMAL restraint, EXPERIMENTAL oddness. It leans how sounds are designed; it is not a preset.',
  });
  cs.dataset.test = 'kit-character';
  h('div', 'lbl', top, 'WILDNESS');
  const wr = range(kp, top, {
    get: () => Math.round(app.kitGen.wildness * 100),
    set: (v) => app.setKitGen({ wildness: v / 100 }),
    min: 0,
    max: 100,
    def: 30,
    width: 150,
    format: (v) => v + '%',
    title: 'How far GENERATE KIT and MUTATE KIT may leave conventional drums. 0-20 %: recognisable electronic percussion; 20-40 %: characterful but clear; 40-60 %: experimental; 60-80 %: unusual and abstract; 80-100 %: largely unconstrained. It only changes the kit: WILDCARD (PATTERN ▸ WILDCARD) is the one that transforms rhythm, tempo and everything else.',
  });
  wr.dataset.test = 'kit-wildness';
  button(kp, top, 'GENERATE KIT', () => void app.generateKit(), { cls: 'med', disabled: () => app.ui.busy, title: 'A new kit (K): each voice designed as its instrument (kick, snare, hats…) with this CHARACTER and WILDNESS, then checked in the engine so it sounds like one. Locked voices and parameters stay; samples, patterns and tempo are never touched.' }).dataset.test = 'generate-kit';
  button(kp, top, 'MUTATE KIT', () => void app.mutateKit(), { cls: 'med', disabled: () => app.ui.busy, title: 'Change the current kit (⇧K), as far as the WILDNESS allows: low keeps each drum what it is, high lets sounds leave their roles. Locked voices and parameters stay; one undo step.' }).dataset.test = 'mutate-kit';
  const seedRow = h('div', 'row kitseed', top);
  h('div', 'lbl', seedRow, 'SEED');
  num(kp, seedRow, { get: () => app.kitGen.seed, set: (v) => app.setKitGen({ seed: Math.max(1, Math.round(v)), hold: true }), min: 1, max: 4294967295, width: 96, title: 'The seed of the last GENERATE KIT. Type one (or press HOLD) to make the same kit again: the same seed, character, wildness and locks give the same result.' });
  button(kp, seedRow, 'HOLD', () => app.setKitGen({ hold: !app.kitGen.hold }), { cls: 'small', on: () => app.kitGen.hold, title: 'Keep this seed for the next GENERATE KIT and NEW VOICE (off: every press is new)' }).dataset.test = 'kit-seed-hold';
  const kn = h('div', 'report grow', top);
  kp.add(() => {
    const g = app.project.kit.gen;
    kn.textContent = `${app.project.kit.name}${g ? ` · ${CHARACTER_DEFS[g.character].label} ${Math.round(g.wildness * 100)}% · SEED ${g.seed}` : ` · SEED ${app.project.kit.seed}`}${app.ui.busy ? ' · CHECKING THE KIT IN THE ENGINE…' : ''} · ${app.project.soundLocks.params.length} PARAMS LOCKED`;
  });

  const body = h('div', 'kitws sndscroll', pane);
  const cards = h('div', 'kitcards', body);
  const card = (kind: KitKind, label: string, current: () => string, dirty: () => boolean) => {
    const g = group(cards, label);
    g.classList.add('col', 'kitcard');
    g.dataset.test = 'kit-card-' + kind;
    const nm = h('div', 'setname', g);
    nm.dataset.test = 'kit-name-' + kind;
    kp.add(() => {
      nm.textContent = current() + (dirty() ? ' · UNSAVED' : '');
    });
    h('div', 'hint', g, CONTENT[kind]);
    const r = h('div', 'row wrap', g);
    button(kp, r, 'SAVE…', () => kitLibraryDialog(app, kind, '', current() === 'NONE' ? '' : current()), { cls: 'small', title: `Save what is playing now as a ${label.toLowerCase()}` }).dataset.test = `kit-save-${kind}`;
    button(kp, r, 'LOAD…', () => kitLibraryDialog(app, kind), { cls: 'small', title: 'Choose one: it shows what changes before anything does' }).dataset.test = `kit-load-${kind}`;
    button(kp, r, 'LIBRARY…', () => kitLibraryDialog(app, kind), { cls: 'small', title: 'Rename, duplicate, delete, import and export' }).dataset.test = `kit-library-${kind}`;
    const r2 = h('div', 'row wrap', g);
    button(kp, r2, 'EXPORT', async () => {
      const km = app.kitm;
      if (!km) return;
      try {
        const f = kind === 'synth' ? km.synthFile(synthKitOf(app.project)) : await km.exportCurrent(kind, current() === 'NONE' ? app.project.name : current());
        download(f.name, f.data, f.type);
      } catch (e) {
        app.say(`EXPORT FAILED: ${errText(e)}`);
      }
    }, { cls: 'small', title: 'The current ' + label.toLowerCase() + ' as a portable file' }).dataset.test = `kit-export-${kind}`;
    button(kp, r2, 'IMPORT…', async () => {
      const files = await chooseFiles('.zip,.json');
      for (const f of files) await openKitFile(app, f, true);
    }, { cls: 'small', title: 'A kit file (.kit.zip, .clattersynth.json) goes to the library and offers to load' }).dataset.test = `kit-import-${kind}`;
    return g;
  };
  card('synth', 'SYNTH KIT', () => app.project.kit.name, () => false);
  card('set', 'SAMPLE SET', () => app.kitm?.setName ?? 'NONE', () => {
    const km = app.kitm;
    return !!km && km.session.currentId !== null && km.session.dirty;
  });
  card('full', 'FULL KIT', () => app.kitm?.fullName || 'NONE', () => false);

  const lower = h('div', 'kitlower', body);
  const vg = group(lower, 'VOICES · PROFILE, NEW, LOCK, MUTATE');
  vg.classList.add('col', 'voicegroup');
  VOICES.forEach((vn, v) => {
    const r = h('div', 'row voicerow', vg);
    button(kp, r, vn, () => {
      viewVoice(v);
      const owner = app.project.tracks.find((x) => app.voiceOf(x) === v);
      if (owner) app.selectTrack(owner.id);
      app.setSoundTab('synth');
    }, { cls: 'grow', title: 'Edit this voice in the SYNTH tab' });
    const who = h('div', 'tiny voiceowners', r);
    kp.add(() => {
      const owners = app.project.tracks.filter((x) => app.voiceOf(x) === v).map((x) => x.name);
      who.textContent = owners.length ? owners.join(', ') : '—';
    });
    const ps = select<Profile | null>(kp, r, {
      options: () => [{ value: null, label: `AUTO · ${PROFILE_LABEL[app.voiceProfiles()[v]!]}` }, ...PROFILES.map((p) => ({ value: p, label: PROFILE_LABEL[p] }))],
      get: () => app.kitGen.profiles[v] ?? null,
      set: (p) => {
        const list = [...app.kitGen.profiles];
        list[v] = p;
        app.setKitGen({ profiles: list });
      },
      width: 128,
      title: 'The instrument this voice is designed as. AUTO follows the tracks that play it; choose another to make, say, a cymbal on the kick voice (GENERATE KIT and NEW keep using it).',
    });
    ps.dataset.test = 'voice-profile-' + v;
    button(kp, r, 'NEW', () => void app.generateVoice(v), { cls: 'small', title: 'Design this voice afresh as its profile, with the CHARACTER and WILDNESS above', disabled: () => app.ui.busy || !!app.project.soundLocks.voices[v] }).dataset.test = 'new-voice-' + v;
    button(kp, r, 'LOCK', () => app.lockVoice(v), { cls: 'small', on: () => !!app.project.soundLocks.voices[v], title: 'GENERATE KIT, MUTATE KIT and EVOLVE leave this voice alone' }).dataset.test = 'lock-voice-' + v;
    button(kp, r, 'MUTATE', () => void app.mutateKit(undefined, [v]), { cls: 'small', title: 'Mutate this voice only (as far as the WILDNESS allows)', disabled: () => app.ui.busy || !!app.project.soundLocks.voices[v] });
  });
  h('div', 'hint', vg, 'A LOCKED VOICE IS NEVER CHANGED BY GENERATE KIT, MUTATE KIT OR EVOLVE. ALT-CLICK A PARAMETER NAME IN THE SYNTH TAB TO LOCK JUST THAT PARAMETER. WILDNESS SHAPES THE KIT ONLY; WILDCARD TRANSFORMS THE WHOLE INSTRUMENT.');

  const sg = group(lower, 'SAMPLES ON THE TRACKS');
  sg.classList.add('col');
  const sl = h('div', 'list', sg);
  kp.add(() => {
    sl.innerHTML = '';
    for (const tr of app.project.tracks) {
      const names = tr.sound.samples.map((id) => app.library.get(id)?.name ?? '?').join(', ');
      const li = h('div', 'li', sl, `${tr.name} · ${tr.sound.mode.toUpperCase()} · ${tr.sound.mode === 'synth' ? '—' : names || 'NO SAMPLE'}`);
      li.addEventListener('click', () => {
        app.selectTrack(tr.id);
        app.setSoundTab('sample');
      });
    }
  });
  h('div', 'hint', sg, 'LOADING A SAMPLE SET CHANGES ONLY THESE. LOADING A SYNTH KIT CHANGES ONLY THE SYNTHESIS.');

  subscribe(app, ['kit', 'status', 'project', 'kits', 'tracks', 'library'], () => kp.refresh());
  return { panels: [kp] };
}
