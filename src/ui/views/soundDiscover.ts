/**
 * The DISCOVER tab: SOUND DISCOVERY. Eight candidate sounds for the selected instrument, made by
 * the generator and mutation the kit already has, heard through the real LXR engine one at a time,
 * compared against the original with an A/B switch, mutated, saved to a library and, only when
 * asked, applied (one undo step). Until APPLY the instrument, the kit and the running sequencer
 * are exactly as they were: auditions are rendered offline and played on their own.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import type { App } from '../../app/app';
import { savePrefs } from '../../app/prefs';
import { CHARACTERS, characterLabel, WILDNESS_MIN } from '../../sound/discover';
import { describeSound, SOUND_EXT } from '../../sound/soundLibrary';
import { VOICES } from '../../sound/lxrParams';
import { seedLabel } from '../../rhythm/seed';
import { confirmDialog } from '../dialogs';
import { seedField } from '../seedField';
import { button, chooseFiles, download, group, h, Panel, range, select, toast } from '../widgets';
import { subscribe } from './patternView';
import { askName, type PaneParts } from './soundUi';

const enc = new TextEncoder();

export function discoverPane(app: App, pane: HTMLElement): PaneParts {
  const dp = new Panel();
  const ds = app.discover;
  const sample = () => ds.voice < 0;
  const busy = () => !!ds.busy;

  // ---------------------------------------------------------------- controls
  const top = h('div', 'row wrap sndtop', pane);
  button(dp, top, 'DISCOVER 8', () => void ds.discover(), { cls: 'med', disabled: () => sample() || busy(), title: 'Eight new candidate sounds for this instrument. Held candidates stay. The instrument does not change.' }).dataset.test = 'discover-go';
  button(dp, top, 'MUTATE', () => void ds.mutate(), { cls: 'med', disabled: () => !ds.selected || busy(), title: 'Mutate the selected candidate (as far as WILDNESS says). The child takes its slot; BACK returns the parent. Press again to keep going.' }).dataset.test = 'discover-mutate';
  button(dp, top, 'APPLY', () => ds.apply(), { cls: 'med', disabled: () => !ds.selected || busy() || (!!ds.selected && ds.isLive(ds.selected)), title: 'Make the selected candidate the instrument’s sound. One undo step: UNDO brings the original back.' }).dataset.test = 'discover-apply';
  button(dp, top, 'SAVE…', () => saveSelected(), { cls: 'med', disabled: () => !ds.selected, title: 'Save the selected candidate to the sound library' }).dataset.test = 'discover-save';
  button(dp, top, 'PITCH', () => void ds.analyseAll(), { cls: 'med', disabled: () => sample() || busy(), title: 'Measure the pitch of the original and every candidate (the TUNER’s analysis; nothing is measured until you ask, or you audition one)' }).dataset.test = 'discover-pitch';
  button(dp, top, 'STOP', () => ds.stop(), { cls: 'med', disabled: () => !ds.playing, title: 'Stop the audition' });
  const info = h('div', 'report grow', top);
  dp.add(() => {
    if (sample()) {
      info.textContent = 'THIS IS A SAMPLE TRACK: SOUND DISCOVERY DESIGNS LXR SYNTH VOICES. SELECT A SYNTH OR HYBRID TRACK.';
      return;
    }
    const shared = ds.sharedBy();
    info.textContent = `${app.track.name} · ${VOICES[ds.voice]}${shared.length > 1 ? ' · SHARED BY ' + shared.map((x) => x.name).join(', ') : ''}${ds.busy ? ' · ' + ds.busy : ''}`;
  });

  const row2 = h('div', 'row wrap sndtop', pane);
  h('div', 'lbl', row2, 'CHARACTER').title = 'The sound world the candidates lean towards (the kit generator’s flavours). STYLE follows the rhythm style.';
  select(dp, row2, {
    options: () => [{ value: 'style' as const, label: 'STYLE · ' + characterLabel(app.discover.effectiveCharacter) }, ...CHARACTERS.map((c) => ({ value: c.id as string, label: c.label }))],
    get: () => ds.character,
    set: (v) => {
      ds.character = v as typeof ds.character;
      app.prefs.discover.character = ds.character;
      savePrefs(app.prefs);
      dp.refresh();
    },
    width: 150,
    title: 'Character: ' + CHARACTERS.map((c) => `${c.label} (${c.hint})`).join(', '),
  }).dataset.test = 'discover-character';
  h('div', 'lbl', row2, 'WILDNESS').title = 'How far candidates go from the current sound, and how far MUTATE moves. Low: the same voice, moved a little. High: new voices.';
  range(dp, row2, {
    get: () => Math.round(ds.wildness * 100),
    set: (v) => {
      ds.wildness = v / 100;
      app.prefs.discover.wildness = ds.wildness;
      savePrefs(app.prefs);
      dp.refresh();
    },
    min: Math.round(WILDNESS_MIN * 100),
    max: 100,
    def: 60,
    format: (v) => v + '%',
    width: 150,
    title: 'Wildness 5-100%',
  }).dataset.test = 'discover-wildness';
  const row3 = h('div', 'row sndtop', pane);
  h('div', 'lbl', row3, 'SEED').title = 'The seed of the next DISCOVER 8. Type a phrase to hold it: the same seed, character, wildness, voice, starting sound and locks make the same eight candidates.';
  const sh = h('div', 'grow', row3);
  seedField(dp, sh, { get: () => app.seedSlot('discover').value, fixed: () => app.seedSlot('discover').fixed, onFixed: (on) => app.setSeedFixed('discover', on), onInput: (t) => void app.setSeedInput('discover', t), onRoll: () => app.rollSeed('discover'), onClear: () => app.clearSeed('discover'), test: 'discover-seed' });

  // ---------------------------------------------------------------- the candidates
  const body = h('div', 'dscbody sndscroll', pane);
  const slotsEl = h('div', 'dslots', body);
  slotsEl.dataset.test = 'discover-slots';
  const side = h('div', 'dscside', body);

  const drawSlots = () => {
    slotsEl.innerHTML = '';
    const st = ds.state;
    st.slots.forEach((slot, i) => {
      const c = slot.cand;
      const el = h('div', 'dslot' + (c ? '' : ' empty') + (st.selected === i ? ' sel' : '') + (st.compare === i ? ' cmp' : ''), slotsEl);
      el.dataset.test = 'dslot-' + i;
      const head = h('div', 'dhead', el);
      h('span', 'dnum', head, String(i + 1));
      h('span', 'dname grow', head, c ? (c.origin.kind === 'library' ? c.name : c.origin.archetype.toUpperCase() + (c.origin.draw ? ' D' + c.origin.draw : '') + (c.origin.lineage.length ? ' M' + c.origin.lineage.length : '')) : '—').title = c ? 'D: drawn again with NEW. M: mutated.' : '';
      if (c && ds.isLive(c)) h('span', 'dtag', head, 'LIVE').title = 'This is the instrument’s sound right now';
      if (slot.held) h('span', 'dtag', head, 'HELD').title = 'DISCOVER 8 leaves this candidate alone';
      if (!c) {
        h('div', 'dpitch tiny', el, 'EMPTY');
        return;
      }
      const o = c.origin;
      h('div', 'dpitch', el, ds.pitchText(c)).title = 'The measured pitch. A note only when the analysis found a trustworthy one; noise, inharmonic and silent sounds say so.';
      h('div', 'dmeta tiny', el, o.kind === 'library' ? 'LIBRARY ' + (o.library ?? '') : `${characterLabel(o.character)} ${o.wildness}%${o.lineage.length ? ' · MUT ' + o.lineage.length : ''}`);
      const r = h('div', 'row dbtn', el);
      const b = (label: string, fn: () => void, title: string, on = false, disabled = false) => {
        const x = button(dp, r, label, (e) => {
          e.stopPropagation();
          fn();
        }, { cls: 'small' + (on ? ' on' : ''), title });
        x.disabled = disabled;
        return x;
      };
      b('▶', () => void ds.auditionSlot(i), 'Audition this candidate through the LXR engine').dataset.test = `dslot-play-${i}`;
      b('NEW', () => void ds.regenerate(i), 'Draw this slot again (same seed, next draw)', false, busy()).dataset.test = `dslot-new-${i}`;
      b('HOLD', () => ds.hold(i), 'Keep this candidate when DISCOVER 8 makes new ones', slot.held).dataset.test = `dslot-hold-${i}`;
      b('VS', () => ds.setCompare(st.compare === i ? null : i), 'Compare the selected candidate with this one instead of the original (side A)', st.compare === i).dataset.test = `dslot-vs-${i}`;
      if (ds.canBack(i)) b('BACK', () => ds.back(i), 'Return to what this slot held before its last MUTATE, NEW or LOAD').dataset.test = `dslot-back-${i}`;
      el.addEventListener('click', () => ds.select(i));
      el.addEventListener('dblclick', () => void ds.auditionSlot(i));
    });
  };
  dp.add(drawSlots);

  // ---------------------------------------------------------------- A/B
  const ab = group(side, 'A / B · ORIGINAL AGAINST CANDIDATE');
  ab.classList.add('col');
  const abr = h('div', 'row', ab);
  const aLabel = () => (ds.state.compare === null ? 'ORIGINAL' : (ds.candidate(ds.state.compare)?.name ?? 'ORIGINAL'));
  const bLabel = () => ds.selected?.name ?? '—';
  button(dp, abr, 'A', () => void ds.audition('A'), { cls: 'grow big', on: () => ds.playing?.side === 'A', disabled: () => sample(), label: () => `A · ${aLabel()}`, title: 'Hear the original sound (or the candidate chosen with VS)' }).dataset.test = 'ab-a';
  button(dp, abr, 'B', () => void ds.audition('B'), { cls: 'grow big', on: () => ds.playing?.side === 'B', disabled: () => !ds.selected, label: () => `B · ${bLabel()}`, title: 'Hear the selected candidate' }).dataset.test = 'ab-b';
  const abr2 = h('div', 'row wrap', ab);
  button(dp, abr2, 'SWITCH', () => void ds.toggle(), { cls: 'small', disabled: () => !ds.selected, title: 'Play the other side' }).dataset.test = 'ab-switch';
  button(dp, abr2, 'VS ORIGINAL', () => ds.setCompare(null), { cls: 'small', disabled: () => ds.state.compare === null, title: 'Side A is the original sound again' });
  button(dp, abr2, 'MOD+VARS', () => ((ds.extras = !ds.extras), dp.refresh()), { cls: 'small', on: () => ds.extras, disabled: () => !ds.selected?.extras, title: 'The selected candidate carries modulation and variations (a library sound): hear and apply them with it' }).dataset.test = 'discover-extras';
  const now = h('div', 'dnow', ab);
  now.dataset.test = 'ab-now';
  dp.add(() => {
    const p = ds.playing;
    now.textContent = p ? `NOW: ${p.side} · ${p.label}` : 'NOW: —';
    now.classList.toggle('orig', !!p && p.side === 'A' && ds.state.compare === null);
  });
  h('div', 'hint', ab, 'AUDITIONS ARE RENDERED BY THE LXR ENGINE AND PLAYED ON THEIR OWN. THE SEQUENCER AND THE INSTRUMENT ARE NOT TOUCHED UNTIL YOU APPLY.');

  // ---------------------------------------------------------------- library
  const lib = group(side, 'SOUND LIBRARY');
  lib.classList.add('col');
  const lr = h('div', 'row wrap', lib);
  button(dp, lr, 'SAVE ORIGINAL…', () => askName('SAVE THE CURRENT SOUND', app.track.name, (n) => {
    if (ds.saveOriginal(n)) toast('SAVED ' + n.toUpperCase(), 'info');
  }), { cls: 'small', disabled: sample, title: 'Save this instrument’s voice, with its modulation and variations, to the library' });
  button(dp, lr, 'IMPORT…', async () => {
    for (const f of await chooseFiles('.json', true)) {
      try {
        const r = ds.library.import(await f.text());
        toast(`${r.added.length} SOUND${r.added.length === 1 ? '' : 'S'} IMPORTED${r.skipped ? `, ${r.skipped} SKIPPED` : ''}`, 'info');
      } catch (e) {
        toast(e instanceof Error ? e.message.toUpperCase() : 'IMPORT FAILED', 'error');
      }
    }
    dp.refresh();
  }, { cls: 'small', title: 'Add sounds from a .clattersound.json file' }).dataset.test = 'lib-import';
  button(dp, lr, 'EXPORT ALL', () => download('clatter-sounds' + SOUND_EXT, enc.encode(ds.library.export()), 'application/json'), { cls: 'small', disabled: () => !ds.library.list().length, title: 'The whole library as one file' }).dataset.test = 'lib-export-all';
  const list = h('div', 'list dlib', lib);
  list.dataset.test = 'lib-list';
  dp.add(() => {
    list.innerHTML = '';
    const items = ds.library.list();
    if (!items.length) h('div', 'hint', list, 'NOTHING SAVED YET. SELECT A CANDIDATE AND PRESS SAVE.');
    for (const s of items) {
      const li = h('div', 'li dlibrow', list);
      li.dataset.test = 'lib-row';
      const name = h('div', 'grow', li);
      h('div', '', name, s.name);
      const pitch = s.pitch && 'note' in s.pitch ? ` · ${s.pitch.note}` : '';
      h('div', 'tiny', name, `${VOICES[s.voice]}${pitch}${describeSound(s) ? ' · ' + describeSound(s) : ''}`);
      const bs = h('div', 'row', li);
      button(dp, bs, 'LOAD', () => {
        if (ds.load(s.id) === null) toast('SELECT A SYNTH OR HYBRID TRACK FIRST', 'info');
      }, { cls: 'small', disabled: sample, title: 'Put it in a candidate slot (the instrument does not change until you apply it)' }).dataset.test = 'lib-load';
      button(dp, bs, 'RENAME', () => askName('RENAME SOUND', s.name, (n) => (ds.library.rename(s.id, n), ds.notify())), { cls: 'small' });
      button(dp, bs, 'EXPORT', () => download(s.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + SOUND_EXT, enc.encode(ds.library.export([s.id])), 'application/json'), { cls: 'small', title: 'This sound as a .clattersound.json file' });
      button(dp, bs, 'DELETE', () => confirmDialog('DELETE SOUND', `Delete “${s.name}” from the library?`, 'DELETE', () => (ds.library.remove(s.id), ds.notify())), { cls: 'small' }).dataset.test = 'lib-delete';
    }
  });

  const seedNote = h('div', 'report', side);
  dp.add(() => {
    const b = ds.state.batch;
    const c = ds.selected;
    seedNote.textContent = c ? `${c.name} · ${c.origin.kind === 'library' ? 'FROM LIBRARY' : 'SEED ' + seedLabel({ seed: c.origin.seed, ...(c.origin.seedText ? { text: c.origin.seedText } : {}) }).toUpperCase()} · SLOT ${c.origin.index + 1} DRAW ${c.origin.draw}` : b ? `BATCH SEED ${seedLabel(b).toUpperCase()}` : 'DISCOVER 8 TO BEGIN';
  });

  const saveSelected = () => {
    const i = ds.state.selected;
    const c = ds.selected;
    if (i === null || !c) return;
    askName('SAVE TO THE SOUND LIBRARY', `${app.track.name} ${c.name}`, (n) => {
      try {
        ds.save(i, n);
        toast('SAVED ' + n.toUpperCase(), 'info');
      } catch (e) {
        toast(e instanceof Error ? e.message.toUpperCase() : 'SAVE FAILED', 'error');
      }
    });
  };

  subscribe(app, ['discover', 'selection', 'tracks', 'kit', 'project', 'gen', 'history'], () => dp.refresh());
  return {
    panels: [dp],
    active: (on) => {
      if (!on) return;
      dp.refresh();
    },
  };
}
