/**
 * Kit dialogs: the kit library (SYNTH KIT, SAMPLE SET, FULL KIT), what a load would change, and
 * the import mapping for a folder or ZIP of loose samples.
 *
 * The SOUND page itself only shows the current set and a few buttons; everything that lists,
 * previews or asks lives here, so the page never grows. Nothing in a dialog changes the project
 * until its LOAD button is pressed, and a load says first which tracks it will change.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import { KitError, type Kit, type KitSummary } from '@slopfactory/core/kits';
import { decodeSample, type DecodedSample } from '@slopfactory/core/sampler';
import type { App } from '../app/app';
import { errText, KIND_LABEL, type KitKind, type KitManager, type SynthKitRecord } from '../app/kitManager';
import { synthKitOf } from '../model/kits';
import { ROLE_LABEL, ROLES, type Role } from '../model/types';
import { baseName, proposeMapping, setNameFrom } from '../samples/names';
import { intakeFromFiles, type Candidate, type Intake } from '../samples/intake';
import { buttons, closeDialog, dialog } from './dialogs';
import { button, chooseFiles, chooseFolder, download, h, Panel, select } from './widgets';

const KINDS: KitKind[] = ['set', 'synth', 'full'];
const KIND_HINT: Record<KitKind, string> = {
  synth: 'THE LXR SYNTHESIS: PARAMETERS, MODULATION, FX BUS, VOICE ASSIGNMENTS, VARIATION PARAMETERS. LOADING ONE NEVER CHANGES SAMPLES.',
  set: 'WHICH SAMPLES EACH TRACK PLAYS, WITH TUNE, GAIN, PAN, REVERSE AND REGION. LOADING ONE NEVER CHANGES THE SYNTHESIS, THE MIXER OR THE RHYTHM.',
  full: 'A SYNTH KIT AND A SAMPLE SET TOGETHER, WITH EACH TRACK’S SOURCE (SYNTH, SAMPLE, HYBRID), THE HYBRID BALANCE AND THE MIXER.',
};

const nm = (app: App, id: string, fallback = 'MISSING'): string => app.library.get(id)?.name ?? fallback;

function nameInput(parent: HTMLElement, value: string, placeholder = 'NAME'): HTMLInputElement {
  const input = h('input', 'num kname', parent) as HTMLInputElement;
  input.maxLength = 24;
  input.placeholder = placeholder;
  input.value = value;
  input.spellcheck = false;
  input.addEventListener('keydown', (e) => e.stopPropagation());
  return input;
}

// ====================================================================== library
interface Row {
  id: string;
  name: string;
  info: string;
  when: number;
}

const rowOfKit = (k: KitSummary): Row => ({ id: k.id, name: k.name, info: `${k.instruments} INSTRUMENTS · ${k.samples} SAMPLES`, when: k.modified });
const rowOfSynth = (r: SynthKitRecord): Row => ({ id: r.id, name: r.name, info: `SEED ${r.data.seed} · ${Object.keys(r.data.voices).length} VOICES`, when: r.modified });

/** The kit library: browse, save, load, rename, duplicate, delete, import and export kits. */
export function kitLibraryDialog(app: App, start: KitKind = 'set', note = '', prefill = ''): void {
  if (!app.kitm) return;
  const km = app.kitm as KitManager;
  const box = dialog('KIT LIBRARY', 860);
  box.classList.add('kitdlg');
  let kind = start;
  let sel = '';
  let status = note;
  let armed = '';
  let busy = false;
  const panel = new Panel();
  const tabs = h('div', 'row', box);
  const tabEls = KINDS.map((k) => {
    const b = h('button', 'btn', tabs, KIND_LABEL[k]);
    b.type = 'button';
    b.dataset.test = 'kitlib-' + k;
    b.addEventListener('click', () => {
      kind = k;
      sel = '';
      armed = '';
      status = '';
      void render();
    });
    return b;
  });
  const hint = h('div', 'hint kithint', box);
  const cur = h('div', 'report', box);
  const nrow = h('div', 'row wrap', box);
  h('div', 'lbl', nrow, 'NAME');
  const name = nameInput(nrow, '');
  name.classList.add('grow');
  const saveBtn = button(panel, nrow, 'SAVE CURRENT', () => void act(save), { title: 'Save what is playing now under this name' });
  saveBtn.dataset.test = 'kit-save';
  const list = h('div', 'list kitlist', box);
  const detail = h('div', 'report', box);
  const arow = h('div', 'row wrap', box);
  const row2 = h('div', 'row wrap', box);
  const stat = h('div', 'report kitstatus', box);
  let rows: Row[] = [];

  const picked = (): Row | undefined => rows.find((r) => r.id === sel);
  const act = async (fn: () => Promise<void>): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      await fn();
    } catch (e) {
      status = errText(e);
    }
    busy = false;
    await render();
  };

  const load = () => {
    const r = picked();
    if (r) void loadDialog(app, kind, r.id);
  };
  const save = async () => {
    const n = name.value.trim();
    if (!n) throw new KitError('name', 'Type a name for the kit first.');
    const replace = armed.toLowerCase() === n.toLowerCase();
    try {
      if (kind === 'synth') await km.saveSynth(n, replace);
      else if (kind === 'full') await km.saveFull(n, replace);
      else await km.session.saveAs(n, { replace });
      armed = '';
      status = `SAVED ${KIND_LABEL[kind]} ${n.toUpperCase()}`;
      app.say(status);
    } catch (e) {
      if (e instanceof KitError && e.code === 'exists') {
        armed = n;
        status = `${errText(e).toUpperCase()} PRESS SAVE CURRENT AGAIN TO REPLACE IT.`;
        return;
      }
      throw e;
    }
  };
  const rename = async () => {
    const r = picked();
    if (!r) return;
    const n = name.value.trim();
    if (kind === 'synth') await km.renameSynth(r.id, n);
    else if (kind === 'set') await km.session.rename(r.id, n);
    else await km.full.renameKit(r.id, n);
    status = `RENAMED TO ${n.toUpperCase()}`;
  };
  const duplicate = async () => {
    const r = picked();
    if (!r) return;
    if (kind === 'synth') await km.duplicateSynth(r.id);
    else if (kind === 'set') await km.session.duplicate(r.id);
    else await km.full.duplicateKit(r.id);
    status = `DUPLICATED ${r.name}`;
  };
  const remove = async () => {
    const r = picked();
    if (!r) return;
    if (armed !== 'delete:' + r.id) {
      armed = 'delete:' + r.id;
      status = `PRESS DELETE AGAIN TO DELETE ${r.name}. ITS SAMPLES STAY IN THE LIBRARY UNLESS NOTHING ELSE USES THEM AND YOU REMOVE UNUSED SAMPLES.`;
      return;
    }
    armed = '';
    if (kind === 'synth') await km.deleteSynth(r.id);
    else if (kind === 'set') await km.session.delete(r.id);
    else await km.full.deleteKit(r.id);
    sel = '';
    status = `DELETED ${r.name}`;
  };
  const exportIt = async () => {
    const r = picked();
    const f = kind === 'synth' ? (r ? await km.exportSynth(r.id) : km.synthFile(synthKitOf(app.project))) : r ? await km.exportKit(kind, r.id) : await km.exportCurrent(kind, name.value.trim() || km.setName);
    download(f.name, f.data, f.type);
    status = `SAVED ${f.name}`;
  };
  const importFile = async () => {
    const [f] = await chooseFiles(kind === 'synth' ? '.json' : '.zip');
    if (f) await openKitFile(app, f, true);
  };

  const btn = (parent: HTMLElement, label: string, fn: () => void, o: { title?: string; need?: boolean; test?: string } = {}) => {
    const b = button(panel, parent, label, fn, { title: o.title, disabled: () => busy || (!!o.need && !picked()) });
    if (o.test) b.dataset.test = o.test;
    return b;
  };
  btn(arow, 'LOAD…', load, { need: true, title: 'See what loading it would change, then load it', test: 'kit-load' });
  btn(arow, 'RENAME', () => void act(rename), { need: true, title: 'Rename the selected kit to the name above' });
  btn(arow, 'DUPLICATE', () => void act(duplicate), { need: true, title: 'A copy (no audio is copied)' });
  btn(arow, 'DELETE', () => void act(remove), { need: true, title: 'Delete the selected kit' });
  btn(arow, 'EXPORT', () => void act(exportIt), { title: kind === 'synth' ? 'Export the selected synth kit (or the current one) as a file' : 'Export the selected kit (or what is playing now) as a portable .kit.zip' });
  btn(row2, 'IMPORT FILE…', () => void act(importFile), { title: kind === 'synth' ? 'A .clattersynth.json file' : 'A .kit.zip from any Slop Factory application, or a CLATTER kit from before' });
  const folder = btn(row2, 'IMPORT FOLDER…', () => void importFolder(app), { title: 'Choose a folder of drum samples; CLATTER proposes which sample goes on which track' });
  const zip = btn(row2, 'IMPORT ZIP…', () => void importZip(app), { title: 'A ZIP of drum samples, mapped the same way as a folder' });
  const unused = btn(row2, 'REMOVE UNUSED SAMPLES', () => void act(async () => void (status = `REMOVED ${await km.sets.removeUnused()} UNUSED SAMPLE(S)`)), { title: 'Delete stored samples that no kit and no project track uses' });
  panel.add(() => {
    for (const b of [folder, zip]) b.style.display = kind === 'synth' ? 'none' : '';
    unused.style.display = kind === 'synth' ? 'none' : '';
  });

  async function render(): Promise<void> {
    tabEls.forEach((b, i) => b.classList.toggle('on', KINDS[i] === kind));
    hint.textContent = KIND_HINT[kind];
    if (kind === 'synth') rows = (await km.listSynth()).map(rowOfSynth);
    else if (kind === 'set') rows = km.session.kits.map(rowOfKit);
    else rows = (await km.full.listKits()).map(rowOfKit);
    rows.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
    if (sel && !rows.some((r) => r.id === sel)) sel = '';
    const curName = kind === 'synth' ? app.project.kit.name : kind === 'set' ? km.setName + (km.session.currentId && km.session.dirty ? ' · UNSAVED CHANGES' : '') : km.fullName || 'NONE';
    cur.textContent = `NOW: ${curName}${km.persistent ? '' : ' · BROWSER STORAGE IS OFF: KITS LAST ONLY UNTIL THIS PAGE CLOSES'}`;
    list.innerHTML = '';
    for (const r of rows) {
      const li = h('div', 'li' + (r.id === sel ? ' on' : ''), list);
      li.dataset.kit = r.name;
      h('div', 'grow', li, r.name);
      h('div', 'tiny', li, r.info);
      li.addEventListener('click', () => {
        sel = r.id;
        name.value = r.name;
        armed = '';
        void render();
      });
      li.addEventListener('dblclick', load);
    }
    if (!rows.length) h('div', 'li', list, kind === 'set' ? 'NO SAMPLE SETS YET: IMPORT A FOLDER OR ZIP, OR SAVE THE CURRENT SAMPLES' : `NO ${KIND_LABEL[kind]}S SAVED YET`);
    detail.textContent = '';
    const r = picked();
    if (r && kind !== 'synth') {
      const kit = await (kind === 'set' ? km.sets : km.full).getKit(r.id);
      if (kit) {
        const missing = await (kind === 'set' ? km.sets : km.full).missing(kit);
        detail.textContent = `${kit.instruments.map((i) => i.label ?? i.role).join(' · ')}${missing.length ? ` · ${missing.length} SAMPLE(S) NOT IN THIS BROWSER` : ''}`;
      }
    }
    stat.textContent = status;
    panel.refresh();
  }
  buttons(box, [['CLOSE', closeDialog, true]]);
  // the name is set before the first (asynchronous) render, so nothing typed meanwhile is overwritten
  if (prefill) name.value = prefill;
  void render().then(() => {
    if (!prefill) return;
    name.focus();
    name.select();
  });
}

// ====================================================================== load
/** What loading a kit would change, then the LOAD button. */
export async function loadDialog(app: App, kind: KitKind, id: string): Promise<void> {
  if (!app.kitm) return;
  const km = app.kitm as KitManager;
  const box = dialog(`LOAD ${KIND_LABEL[kind]}`, 860);
  box.classList.add('kitdlg');
  h('div', 'report', box, 'WORKING OUT WHAT WILL CHANGE…');
  let synth: SynthKitRecord | undefined;
  let kit: Kit | undefined;
  try {
    if (kind === 'synth') synth = (await km.listSynth()).find((r) => r.id === id);
    else kit = (await (kind === 'set' ? km.sets : km.full).getKit(id)) ?? undefined;
  } catch (e) {
    app.say(errText(e));
  }
  if (!synth && !kit) {
    closeDialog();
    app.say('THAT KIT NO LONGER EXISTS');
    return;
  }
  const title = (synth?.name ?? kit?.name ?? '').toUpperCase();
  box.querySelector('h2')!.textContent = `LOAD ${KIND_LABEL[kind]}: ${title}`;
  box.querySelector('.report')?.remove();
  const panel = new Panel();
  const scroll = h('div', 'kscroll', box);
  const status = h('div', 'report kitstatus', box);
  let loading = false;

  const section = (t: string): HTMLElement => h('div', 'hint kitsec', scroll, t);
  const draw = async () => {
    scroll.innerHTML = '';
    const lines: string[] = [];
    if (kit && kind !== 'synth') {
      const { plan, mapping, full, newer } = kind === 'full' ? await km.planFull(kit) : { ...(await km.planFor(kit)), full: null, newer: false };
      if (kind === 'full' && !full) {
        h('div', 'report', scroll, 'THIS IS A SAMPLE SET, NOT A FULL KIT. LOAD IT AS A SAMPLE SET.');
        return;
      }
      if (kind === 'set') {
        const o = h('div', 'row wrap', scroll);
        button(panel, o, 'SYNTH TRACKS BECOME SAMPLE TRACKS', () => ((km.options.synthToSample = !km.options.synthToSample), void draw()), { on: () => km.options.synthToSample, title: 'A track playing the LXR voice only is switched to SAMPLE so you hear the new sample. HYBRID tracks stay HYBRID.' });
        button(panel, o, 'CLEAR TRACKS THE SET HAS NO SOUND FOR', () => ((km.options.emptyTracks = km.options.emptyTracks === 'clear' ? 'keep' : 'clear'), void draw()), { on: () => km.options.emptyTracks === 'clear', title: 'Off: tracks the set does not cover keep their samples.' });
        panel.refresh();
      }
      section('TRACK · NOW · AFTER LOADING');
      for (const t of app.project.tracks) {
        const tp = plan.tracks.find((x) => x.track === t.id);
        const now = t.sound.samples.length ? t.sound.samples.map((s) => nm(app, s)).join(', ') : t.sound.mode === 'synth' ? 'SYNTH' : 'NO SAMPLE';
        const after = !tp ? '(UNCHANGED)' : tp.samples === null ? '(UNCHANGED)' : tp.samples.length ? tp.samples.map((s) => nm(app, s, s.slice(0, 6))).join(', ') + (tp.mode === 'sample' ? ' · BECOMES SAMPLE' : '') : 'CLEARED' + (tp.mode === 'synth' ? ' · BACK TO SYNTH' : '');
        const li = h('div', 'maprow' + (tp && tp.samples !== null ? ' changes' : ''), scroll);
        h('div', 'mapname', li, t.name);
        h('div', 'now', li, now);
        h('div', 'mapafter', li, after);
        const first = tp?.samples?.[0];
        const b = h('button', 'btn small', li, '▶');
        b.title = 'Hear the first sample of this track';
        b.disabled = !first;
        if (first) b.addEventListener('click', () => void km.audition.playSample(kind === 'set' ? km.sets : km.full, first, { name: after }));
        if (tp?.missing.length) h('div', 'maprow-note', scroll, `${tp.missing.length} OF THIS TRACK’S SAMPLES ARE NOT IN THIS BROWSER`);
      }
      if (plan.unmapped.length) lines.push(`NOT USED (NO MATCHING TRACK): ${plan.unmapped.join(', ')}. THEY STAY IN THE KIT.`);
      if (newer) lines.push('THIS KIT WAS SAVED BY A NEWER CLATTER: ITS PLAYBACK SETTINGS WERE LEFT OUT.');
      if (kind === 'set') lines.push('KEEPS: THE SYNTH KIT, VOICES, HYBRID LEVELS, MIXER, VARIATIONS, PATTERNS, STEP SOUNDS, LOCKS AND CONDITIONS. A TRACK THAT RECEIVES SAMPLES TAKES THE SET’S PLAYBACK SETTINGS.');
      if (kind === 'full' && full) {
        section('ALSO REPLACES');
        lines.push(`SYNTH KIT ${full.synth.name}: ALL LXR PARAMETERS, MODULATION, FX BUS, VOICE ASSIGNMENTS AND VARIATION PARAMETERS`, 'EACH TRACK’S SOURCE (SYNTH, SAMPLE, HYBRID), HYBRID BALANCE AND ALIGNMENT, CHOKE GROUPS', full.mix ? 'THE MIXER: VOLUME, PAN, ROUTE AND FILTER OF EACH TRACK (MUTE AND SOLO STAY)' : 'THE MIXER IS LEFT ALONE (THIS KIT DOES NOT CARRY ONE)', 'KEEPS: PATTERNS, STEP SOUNDS, LOCKS, CONDITIONS, TEMPO AND DESTRUCTION SETTINGS');
      }
      void mapping;
    } else if (synth) {
      section('THIS SYNTH KIT REPLACES');
      lines.push(`ALL ${synth.data.synth.params.length} LXR PARAMETERS, MODULATION TARGETS AND THE FX BUS`, 'VOICE ASSIGNMENTS AND VARIATION PARAMETERS', 'KEEPS: EVERY TRACK’S SAMPLES AND SAMPLE SETTINGS, SOURCE MODES, HYBRID BALANCE, MIXER, PATTERNS, STEP SOUNDS, LOCKS AND CONDITIONS');
      section('VOICE ASSIGNMENTS');
      for (const t of app.project.tracks) {
        const v = synth.data.voices[t.role];
        const li = h('div', 'maprow' + (v && v.trigger !== t.sound.trigger ? ' changes' : ''), scroll);
        h('div', 'mapname', li, t.name);
        h('div', 'now', li, v ? `LXR VOICE ${t.sound.trigger + 1} → ${v.trigger + 1}` : '(UNCHANGED)');
      }
    }
    for (const l of lines) h('div', 'hint kitline', scroll, l);
  };
  await draw();
  buttons(box, [
    ['CANCEL', () => kitLibraryDialog(app, kind)],
    [
      'LOAD',
      () => {
        if (loading) return;
        loading = true;
        status.textContent = 'LOADING…';
        void (async () => {
          try {
            if (synth) {
              await km.loadSynth(synth.id);
              app.say(`SYNTH KIT ${synth.name} LOADED · SAMPLES UNCHANGED`);
            } else if (kind === 'full') {
              const plan = await km.loadFull(kit!);
              app.say(`FULL KIT ${kit!.name} LOADED${plan.tracks.some((t) => t.missing.length) ? ' · SOME SAMPLES ARE MISSING' : ''}`);
            } else {
              await km.session.load(kit!.id);
              const missing = km.lastPlan?.tracks.reduce((n, t) => n + t.missing.length, 0) ?? 0;
              app.say(`SAMPLE SET ${kit!.name} LOADED · SYNTH KIT UNCHANGED${missing ? ` · ${missing} SAMPLE(S) MISSING` : ''}`);
            }
            closeDialog();
          } catch (e) {
            loading = false;
            status.textContent = errText(e).toUpperCase();
          }
        })();
      },
      true,
    ],
  ]);
}

// ====================================================================== import
const decodeCache = new WeakMap<Candidate, Promise<DecodedSample>>();

/** Choose a folder of drum samples and map it onto the tracks. */
export async function importFolder(app: App): Promise<void> {
  const files = await chooseFolder();
  if (!files.length) return;
  const intake = intakeFromFiles(files);
  if (!intake.candidates.length) return app.say(`NO AUDIO FILES IN THAT FOLDER (${intake.ignored} FILE(S) IGNORED)`);
  importDialog(app, intake);
}

/** Choose a ZIP: a kit file is saved to its library, a ZIP of samples is mapped. */
export async function importZip(app: App): Promise<void> {
  const [f] = await chooseFiles('.zip,application/zip');
  if (f) await openKitFile(app, f, true);
}

/**
 * Open a file the user chose as a kit: a synth kit, a sample set or full kit (saved to its
 * library, then offered for loading), or a ZIP of samples (offered for mapping). Returns false
 * for anything else (a project, a bundle), which the caller opens as before.
 */
export async function openKitFile(app: App, file: File, force = false): Promise<boolean> {
  const km = app.kitm;
  if (!km) return false;
  const isJson = /\.json$/i.test(file.name);
  const isZip = /\.zip$/i.test(file.name);
  if (!isJson && !isZip) return false;
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (isJson && !force) {
    try {
      if ((JSON.parse(new TextDecoder().decode(bytes)) as { format?: unknown }).format !== 'clatter-synth-kit') return false;
    } catch {
      return false;
    }
  }
  try {
    app.say(`READING ${file.name}…`);
    const r = await km.openFile(file.name, bytes);
    if (r.kind === 'bundle') {
      if (force) await app.openFile(file);
      return force;
    }
    if (r.kind === 'samples') {
      if (!r.intake.candidates.length) app.say(`NO AUDIO FILES IN ${file.name}`);
      else importDialog(app, r.intake);
      return true;
    }
    app.say(`${KIND_LABEL[r.kind]} ${r.name} IMPORTED`);
    await loadDialog(app, r.kind, r.id);
  } catch (e) {
    app.say(`COULD NOT IMPORT ${file.name}: ${errText(e)}`);
  }
  return true;
}

/**
 * The mapping of a folder or ZIP onto the tracks: a proposal to accept or correct, with
 * audition. Saving puts the set in the library; SAVE AND LOAD also puts it on the tracks.
 */
export function importDialog(app: App, intake: Intake): void {
  if (!app.kitm) return;
  const km = app.kitm as KitManager;
  const box = dialog(`IMPORT SAMPLES: ${intake.candidates.length} AUDIO FILE(S)`, 900);
  box.classList.add('kitdlg');
  const files = intake.candidates;
  const roles = ROLES.filter((r) => app.project.tracks.some((t) => t.role === r));
  const proposal = proposeMapping(files.map((f) => ({ path: f.path })), roles);
  const pick = new Map<Role, number>();
  for (const r of roles) if (proposal.pick[r] !== null) pick.set(r, proposal.pick[r]!);
  const panel = new Panel();
  const src = `${intake.source}${intake.ignored ? ` · ${intake.ignored} OTHER FILE(S) IGNORED` : ''}${intake.truncated ? ' · ONLY THE FIRST 1000 AUDIO FILES ARE SHOWN' : ''}`;
  h('div', 'report', box, src.toUpperCase());
  const nrow = h('div', 'row wrap', box);
  h('div', 'lbl', nrow, 'SET NAME');
  const name = nameInput(nrow, setNameFrom(intake.source), 'SET NAME');
  name.classList.add('grow');
  h('div', 'hint kithint', box, 'CLATTER HAS GUESSED WHICH FILE IS WHICH. CHANGE ANY ROW, LEAVE TRACKS EMPTY, OR HEAR A FILE WITH ▶. NOTHING ON YOUR TRACKS CHANGES UNTIL YOU PRESS SAVE AND LOAD.');
  const head = h('div', 'maprow mapimport maphead', box);
  for (const t of ['TRACK', 'FILE', '', 'ON THE TRACK NOW']) h('div', '', head, t);
  const scroll = h('div', 'kscroll', box);
  const rowsEl = new Map<Role, HTMLElement>();
  const fileLabel = (i: number) => files[i]!.path;
  for (const r of roles) {
    const tr = app.project.tracks.find((t) => t.role === r)!;
    const li = h('div', 'maprow mapimport', scroll);
    li.dataset.role = r;
    rowsEl.set(r, li);
    const lab = h('div', 'mapname', li, ROLE_LABEL[r]);
    lab.title = tr.name;
    const cell = h('div', 'mapfile', li);
    select<number>(panel, cell, {
      options: () => {
        const cands = proposal.candidates[r].map((c) => c.file);
        const rest = files.map((_, i) => i).filter((i) => !cands.includes(i));
        return [
          { value: -1, label: '— NONE —' },
          ...cands.map((i) => ({ value: i, label: (cands.length > 1 ? '≈ ' : '') + fileLabel(i) })),
          ...rest.map((i) => ({ value: i, label: fileLabel(i) })),
        ];
      },
      get: () => pick.get(r) ?? -1,
      set: (v) => {
        if (v < 0) pick.delete(r);
        else pick.set(r, v);
        panel.refresh();
      },
      title: proposal.ambiguous.includes(r) ? 'Several files could be this: ≈ marks the likely ones' : 'The file for this track',
    });
    const pv = h('button', 'btn small', li, '▶');
    pv.title = 'Hear the chosen file';
    pv.addEventListener('click', () => {
      const i = pick.get(r);
      if (i !== undefined) void audition(i);
    });
    const now = h('div', 'now', li, '');
    panel.add(() => {
      const i = pick.get(r);
      li.classList.toggle('empty', i === undefined);
      li.classList.toggle('amb', proposal.ambiguous.includes(r) && i === proposal.pick[r]);
      pv.disabled = i === undefined;
      now.textContent = tr.sound.samples.length ? tr.sound.samples.map((s) => nm(app, s)).join(', ') : tr.sound.mode === 'synth' ? 'SYNTH' : '—';
    });
  }
  const sum = h('div', 'report', box);
  panel.add(() => {
    const used = new Set(pick.values());
    const unused = files.filter((_, i) => !used.has(i));
    const amb = proposal.ambiguous.filter((r) => pick.get(r) === proposal.pick[r]);
    sum.textContent = `${pick.size} OF ${roles.length} TRACKS MAPPED${amb.length ? ` · ${amb.length} AMBIGUOUS (≈): CHECK ${amb.map((r) => ROLE_LABEL[r]).join(', ')}` : ''}${unused.length ? ` · NOT USED: ${unused.slice(0, 8).map((f) => baseName(f.path)).join(', ')}${unused.length > 8 ? ` +${unused.length - 8}` : ''}` : ''}`;
  });
  const stat = h('div', 'report kitstatus', box);
  const audition = async (i: number): Promise<void> => {
    const f = files[i]!;
    try {
      let p = decodeCache.get(f);
      if (!p) decodeCache.set(f, (p = f.bytes().then((b) => decodeSample(b, baseName(f.path)))));
      await km.audition.play(await p, { key: f.path });
    } catch (e) {
      stat.textContent = `CANNOT HEAR ${baseName(f.path)}: ${errText(e)}`.toUpperCase();
    }
  };
  let busy = false;
  let replace = false;
  const go = async (load: boolean) => {
    if (busy) return;
    const n = name.value.trim();
    if (!n) {
      stat.textContent = 'GIVE THE SET A NAME';
      return;
    }
    if (!pick.size) {
      stat.textContent = 'NO TRACK HAS A FILE: CHOOSE AT LEAST ONE';
      return;
    }
    busy = true;
    try {
      const picks = [...pick].map(([role, i]) => ({ role, file: files[i]! }));
      await km.createSet(n, picks, { replace, load }, (d, t) => (stat.textContent = `IMPORTING ${d} OF ${t}…`));
      closeDialog();
      app.say(`SAMPLE SET ${n.toUpperCase()} SAVED${load ? ' AND LOADED · SYNTH KIT UNCHANGED' : ''}`);
      if (!load) kitLibraryDialog(app, 'set', `SAVED ${n.toUpperCase()}. LOAD IT WHEN YOU ARE READY.`);
    } catch (e) {
      busy = false;
      if (e instanceof KitError && e.code === 'exists') {
        replace = true;
        stat.textContent = `${errText(e).toUpperCase()} PRESS THE BUTTON AGAIN TO REPLACE IT, OR CHANGE THE NAME.`;
      } else stat.textContent = errText(e).toUpperCase();
    }
  };
  name.addEventListener('input', () => (replace = false));
  buttons(box, [
    ['CANCEL', closeDialog],
    ['SAVE SET', () => void go(false)],
    ['SAVE AND LOAD', () => void go(true), true],
  ]);
  panel.refresh();
}
