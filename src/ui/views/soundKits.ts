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
import { button, chooseFiles, download, group, h, num, Panel } from '../widgets';
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
  const top = h('div', 'row wrap sndtop', pane);
  let mutAmt = 0.3;
  button(kp, top, 'GENERATE KIT', () => void app.generateKit(), { cls: 'med', disabled: () => app.ui.busy, title: 'A new set of synthesised drums designed for the style (K). Locked voices and parameters stay.' }).dataset.test = 'generate-kit';
  button(kp, top, 'MUTATE KIT', () => void app.mutateKit(mutAmt), { cls: 'med', disabled: () => app.ui.busy, title: 'Controlled changes to every unlocked voice (⇧K)' }).dataset.test = 'mutate-kit';
  h('div', 'lbl', top, 'AMOUNT');
  num(kp, top, { get: () => Math.round(mutAmt * 100), set: (v) => ((mutAmt = v / 100), kp.refresh()), min: 5, max: 100, format: (v) => v + '%', title: 'How far MUTATE goes' });
  const kn = h('div', 'report grow', top);
  kp.add(() => (kn.textContent = `${app.project.kit.name} · SEED ${app.project.kit.seed}${app.ui.busy ? ' · CHECKING THE KIT IN THE ENGINE…' : ''} · ${app.project.soundLocks.params.length} PARAMS LOCKED`));

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
  const vg = group(lower, 'VOICES · ASSIGNMENT, LOCK, MUTATE');
  vg.classList.add('col');
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
    button(kp, r, 'LOCK', () => app.lockVoice(v), { cls: 'small', on: () => !!app.project.soundLocks.voices[v], title: 'GENERATE KIT, MUTATE KIT and EVOLVE leave this voice alone' }).dataset.test = 'lock-voice-' + v;
    button(kp, r, 'MUTATE', () => void app.mutateKit(0.4, [v]), { cls: 'small', title: 'Mutate this voice only', disabled: () => app.ui.busy || !!app.project.soundLocks.voices[v] });
  });
  h('div', 'hint', vg, 'A LOCKED VOICE IS NEVER CHANGED BY GENERATE KIT, MUTATE KIT OR EVOLVE. ALT-CLICK A PARAMETER NAME IN THE SYNTH TAB TO LOCK JUST THAT PARAMETER.');

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
