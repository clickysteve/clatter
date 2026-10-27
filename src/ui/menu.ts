/**
 * The menu bar: CLATTER, FILE, EDIT, KIT, VIEW, MIDI, HELP, and the status on the right.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import type { App } from '../app/app';
import { PRESETS } from '../model/presets';
import { exportKitDialog } from './kitExportDialog';
import { aboutDialog, confirmDialog, exportDialog, helpDialog, paletteDialog } from './dialogs';
import { importFolder, importZip, kitLibraryDialog, openKitFile } from './kitDialogs';
import { DEFAULT_SCALE, SCALES, scaleLabel } from './scale';
import { chooseFiles, closePopups, download, h } from './widgets';

interface Item {
  label: string;
  key?: string;
  action?: () => void;
  checked?: () => boolean;
  disabled?: () => boolean;
  sub?: () => Item[];
}
type Entry = Item | 'sep';

let openMenu: { el: HTMLElement; drop: HTMLElement } | null = null;

export function closeMenus(): void {
  openMenu?.drop.remove();
  openMenu?.el.classList.remove('open');
  openMenu = null;
}

export function menubar(app: App, screen: HTMLElement): { bar: HTMLElement; status: HTMLElement } {
  const bar = h('div', '', screen);
  bar.id = 'menubar';
  bar.setAttribute('role', 'menubar');
  const save = (f: { name: string; data: Uint8Array; type: string }) => {
    download(f.name, f.data, f.type);
    app.say(`SAVED ${f.name}`);
  };
  const run = async (label: string, f: () => Promise<{ name: string; data: Uint8Array; type: string }>) => {
    app.say(`${label}…`);
    try {
      save(await f());
    } catch (err) {
      app.say(`${label} FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const menus: [string, () => Entry[], string?][] = [
    ['CLATTER', () => [{ label: 'About CLATTER, licence and source…', action: aboutDialog }, { label: 'Keys and gestures…', key: '?', action: helpDialog }], 'logo'],
    [
      'FILE',
      () => [
        { label: 'New project (LXR init kit)', action: () => confirmDialog('NEW PROJECT', 'Start a new project? The current one stays in the undo history.', 'NEW', () => app.newProject()) },
        { label: 'Factory presets', sub: () => PRESETS.map((p) => ({ label: p.name, action: () => void app.loadPreset(p.id) })) },
        'sep',
        { label: 'Open project, bundle or kit…', key: '⌘O', action: () => void openFile(app) },
        { label: 'Save project (.clatter.json)', key: '⌘S', action: () => save(app.projectFile()) },
        { label: 'Save bundle with samples (.clatter.zip)', action: () => save(app.bundleFile()) },
        'sep',
        { label: 'Import samples…', action: () => void importSamples(app) },
        'sep',
        { label: 'Export master WAV…', action: () => exportDialog(app, 'master') },
        { label: 'Export stems (ZIP)…', action: () => exportDialog(app, 'stems') },
        { label: 'Export MIDI file…', action: () => exportDialog(app, 'midi') },
        { label: 'Export kit (WAV files)…', action: () => exportKitDialog(app) },
        { label: 'Export drum hits (ZIP of WAVs)', action: () => void run('RENDERING HITS', () => app.exportHits()) },
        { label: 'Kit library…', action: () => kitLibraryDialog(app, 'set') },
      ],
    ],
    [
      'EDIT',
      () => [
        { label: `Undo ${app.history.undoLabel}`, key: '⌘Z', action: () => app.undo(), disabled: () => !app.history.canUndo },
        { label: `Redo ${app.history.redoLabel}`, key: '⇧⌘Z', action: () => app.redo(), disabled: () => !app.history.canRedo },
        'sep',
        { label: 'Copy', key: '⌘C', action: () => app.copy() },
        { label: 'Paste', key: '⌘V', action: () => app.paste(), disabled: () => !app.clip },
        { label: 'Delete selected notes', key: 'DEL', action: () => app.deleteSelected() },
        { label: 'Clear pattern', action: () => app.clearPattern() },
      ],
    ],
    [
      'KIT',
      () => [
        { label: 'Generate kit', key: 'K', action: () => void app.generateKit() },
        { label: 'Mutate kit', key: '⇧K', action: () => void app.mutateKit(0.3) },
        { label: 'Mutate selected voice', action: () => voiceMutate(app) },
        'sep',
        { label: 'Synth kit: save or load…', action: () => kitLibraryDialog(app, 'synth', '', app.project.kit.name) },
        { label: 'Sample set: save or load…', action: () => kitLibraryDialog(app, 'set', '', app.kitm?.setName === 'NONE' ? '' : app.kitm?.setName) },
        { label: 'Full kit: save or load…', action: () => kitLibraryDialog(app, 'full', '', app.kitm?.fullName) },
        'sep',
        { label: 'Import sample folder…', action: () => void importFolder(app) },
        { label: 'Import sample ZIP…', action: () => void importZip(app) },
      ],
    ],
    [
      'VIEW',
      () => [
        { label: 'Pattern', key: '1', action: () => app.setView('pattern'), checked: () => app.ui.view === 'pattern' },
        { label: 'Sound', key: '2', action: () => app.setView('sound'), checked: () => app.ui.view === 'sound' },
        { label: 'Perform', key: '3', action: () => app.setView('perform'), checked: () => app.ui.view === 'perform' },
        'sep',
        { label: 'Synth editor: basic', action: () => app.setEditMode('basic'), checked: () => app.ui.editMode === 'basic' },
        { label: 'Synth editor: advanced', action: () => app.setEditMode('advanced'), checked: () => app.ui.editMode === 'advanced' },
        'sep',
        { label: 'Interface size', sub: () => SCALES.map((v) => ({ label: scaleLabel(v) + (v === DEFAULT_SCALE ? ' (default)' : ''), action: () => app.setUiScale(v), checked: () => app.prefs.uiScale === v })) },
        { label: 'Palette…', action: paletteDialog },
      ],
    ],
    [
      'MIDI',
      () => {
        const m = app.midi;
        const list: Entry[] = [];
        if (!m.supported) return [{ label: 'This browser has no Web MIDI', disabled: () => true }];
        if (m.state !== 'ready') list.push({ label: 'Enable MIDI…', action: () => void m.enable() });
        else {
          list.push({ label: 'Output', sub: () => [{ label: 'None', action: () => m.selectOutput(null), checked: () => !m.prefs.outId }, ...m.outputs().map((p) => ({ label: p.name, action: () => m.selectOutput(p.id), checked: () => m.prefs.outId === p.id }))] });
          list.push({ label: 'Input', sub: () => [{ label: 'None', action: () => m.selectInput(null), checked: () => !m.prefs.inId }, ...m.inputs().map((p) => ({ label: p.name, action: () => m.selectInput(p.id), checked: () => m.prefs.inId === p.id }))] });
        }
        const flag = (label: string, k: 'notesOut' | 'clockOut' | 'clockIn' | 'notesIn') => ({ label, action: () => ((m.prefs[k] = !m.prefs[k]), app.emit(['midi'])), checked: () => m.prefs[k] });
        list.push('sep', flag('Send notes', 'notesOut'), flag('Send clock and start/stop', 'clockOut'), flag('Follow incoming clock', 'clockIn'), flag('Play tracks from incoming notes', 'notesIn'));
        list.push({ label: 'Record incoming notes into the pattern', action: () => ((app.ui.record = !app.ui.record), app.emit(['midi'])), checked: () => app.ui.record });
        list.push('sep', { label: 'Panic: all notes off', action: () => app.panic() });
        return list;
      },
    ],
    ['HELP', () => [{ label: 'Keys and gestures…', action: helpDialog }, { label: 'About, licence and source…', action: aboutDialog }]],
  ];
  const buildList = (drop: HTMLElement, entries: Entry[]) => {
    for (const e of entries) {
      if (e === 'sep') {
        h('div', 'sep', drop);
        continue;
      }
      const it = h('div', 'item' + (e.checked?.() ? ' checked' : '') + (e.disabled?.() ? ' disabled' : ''), drop);
      h('span', '', it, e.label);
      if (e.key) h('span', 'key', it, e.key);
      if (e.sub) {
        h('span', 'key', it, '▸');
        it.addEventListener('pointerenter', () => {
          drop.querySelectorAll('.dropdown.sub').forEach((x) => x.remove());
          const sub = h('div', 'dropdown sub', drop);
          sub.style.left = drop.offsetWidth - 2 + 'px';
          sub.style.top = it.offsetTop + 'px';
          buildList(sub, e.sub!());
        });
        continue;
      }
      it.addEventListener('pointerup', (ev) => {
        ev.stopPropagation();
        if (e.disabled?.()) return;
        closeMenus();
        e.action?.();
      });
    }
  };
  for (const [name, entries, cls] of menus) {
    const el = h('div', 'menu' + (cls ? ' ' + cls : ''), bar, name);
    el.setAttribute('role', 'menuitem');
    el.addEventListener('pointerdown', (ev) => {
      ev.stopPropagation();
      // a press inside this menu's own drop-down is a menu item, not the title
      if ((ev.target as HTMLElement).closest('.dropdown')) return;
      closePopups();
      const was = openMenu?.el === el;
      closeMenus();
      if (!was) open();
    });
    // with a menu open, moving across the bar opens the others (as on the Macintosh)
    el.addEventListener('pointerenter', () => {
      if (openMenu && openMenu.el !== el) {
        closeMenus();
        open();
      }
    });
    const open = () => {
      const drop = h('div', 'dropdown', el);
      buildList(drop, entries());
      el.classList.add('open');
      openMenu = { el, drop };
    };
  }
  const status = h('div', 'status', bar);
  return { bar, status };
}

function voiceMutate(app: App): void {
  const v = app.voiceOf(app.track);
  if (v < 0) return app.say('THE SELECTED TRACK PLAYS SAMPLES ONLY');
  void app.mutateKit(0.4, [v]);
}

export async function openFile(app: App, accept = '.json,.zip'): Promise<void> {
  const [f] = await chooseFiles(accept);
  if (!f) return;
  try {
    if (await openKitFile(app, f)) return;
    await app.openFile(f);
  } catch (err) {
    app.say(`COULD NOT OPEN ${f.name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function importSamples(app: App, assignTo?: string): Promise<void> {
  const files = await chooseFiles('audio/*,.wav,.aif,.aiff,.mp3,.ogg,.flac,.m4a', true);
  if (files.length) await app.importSamples(files, assignTo);
}
