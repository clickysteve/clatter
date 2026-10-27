/**
 * Keyboard shortcuts (listed in HELP · Keys and gestures). In the PERFORM view the musical
 * actions are quantised, as the pads are.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import type { App } from '../app/app';
import { closeDialog, dialogOpen, helpDialog } from './dialogs';
import { closeMenus, openFile } from './menu';
import { closePopover, popoverOpen } from './popover';
import { closePopups, download } from './widgets';

export function bindKeys(app: App): void {
  let filling = false;
  window.addEventListener('keydown', (e) => {
    const el = e.target as HTMLElement | null;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();
    const q = app.ui.view === 'perform';
    if (e.key === 'Escape') {
      if (dialogOpen()) closeDialog();
      else if (popoverOpen()) closePopover();
      else if (document.querySelector('.dropdown, .msel-list')) {
        closeMenus();
        closePopups();
      } else if (app.ui.sel) app.select(null);
      else app.stop();
      e.preventDefault();
      return;
    }
    if (dialogOpen()) return;
    if (mod) {
      if (k === 'z' && e.shiftKey) app.redo();
      else if (k === 'z' || k === 'y') (k === 'y' ? app.redo() : app.undo());
      else if (k === 'c') app.copy();
      else if (k === 'v') app.paste();
      else if (k === 'a' && app.ui.view === 'pattern') app.selectAll();
      else if (k === 's') {
        const f = app.projectFile();
        download(f.name, f.data, f.type);
        app.say(`SAVED ${f.name}`);
      } else if (k === 'o') void openFile(app);
      else return;
      e.preventDefault();
      return;
    }
    if (e.altKey) return;
    if (e.shiftKey && /^Digit[1-9]$/.test(e.code)) {
      const p = app.project.patterns[Number(e.code.slice(5)) - 1];
      if (p) app.selectPattern(p.id);
      e.preventDefault();
      return;
    }
    // the keys that act on the pattern open the workspace tab they belong to
    const tab = ({ g: 'generate', v: 'generate', m: 'generate', r: 'generate', c: 'transform', l: 'transform', d: 'transform', w: 'wildcard' } as const)[k as 'g'];
    if (tab && app.ui.view === 'pattern' && !e.shiftKey && app.ui.workspace !== tab) app.setWorkspace(tab);
    switch (e.key === ' ' ? 'space' : k) {
      case 'space':
        if (e.repeat) break;
        app.togglePlay();
        break;
      case '1':
        app.setView('pattern');
        break;
      case '2':
        app.setView('sound');
        break;
      case '3':
        app.setView('perform');
        break;
      case 'g':
        app.generatePattern(q);
        break;
      case 'v':
        app.variation(q);
        break;
      case 'm':
        app.mutate(q);
        break;
      case 'r':
        app.regenerate(q);
        break;
      case 'k':
        if (e.shiftKey) void app.mutateKit(0.3, undefined, q);
        else void app.generateKit(q);
        break;
      case 'c':
        app.toggleChop(q);
        break;
      case 'l':
        app.toggleRolls(q);
        break;
      case 'd':
        app.toggleDestroy(q);
        break;
      case 'w':
        app.wildcard(q);
        break;
      case 'f':
        if (!filling) {
          filling = true;
          app.fill(true);
        }
        break;
      case 'delete':
      case 'backspace':
        app.deleteSelected();
        break;
      case '[':
        app.shiftTrack(app.ui.track, -1);
        break;
      case ']':
        app.shiftTrack(app.ui.track, 1);
        break;
      case 'arrowup':
      case 'arrowdown': {
        const ts = app.project.tracks;
        const i = app.trackIndexOf(app.ui.track) + (k === 'arrowup' ? -1 : 1);
        if (ts[i]) app.selectTrack(ts[i].id);
        break;
      }
      case '?':
        helpDialog();
        break;
      default:
        return;
    }
    e.preventDefault();
  });
  window.addEventListener('keyup', (e) => {
    if (e.key.toLowerCase() === 'f' && filling) {
      filling = false;
      app.fill(false);
    }
  });
  window.addEventListener('blur', () => {
    if (filling) {
      filling = false;
      app.fill(false);
    }
  });
}
