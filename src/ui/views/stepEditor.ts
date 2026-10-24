/**
 * The step editor: velocity, chance, pitch, ratchet, flam and sample of the step the cursor is
 * on, and the button that adds or removes its hit. Built twice: under the grid (always there)
 * and in the floating panel a right-click opens.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import type { App } from '../../app/app';
import type { Hit } from '../../model/types';
import { gridMetrics, position } from '../gridModel';
import { button, ctl, h, Panel, range, select } from '../widgets';

export function stepEditor(app: App, parent: HTMLElement, panel: Panel): void {
  const cell = (): { track: string; step: number; hit: Hit | null } | null => {
    const c = app.cursorCell();
    return c ? { track: c.track, step: c.step, hit: app.hitAt(c.track, c.step) } : null;
  };
  const head = h('div', 'row wrap', parent);
  const where = h('div', 'grow', head);
  const toggle = button(panel, head, 'ADD HIT', () => {
    const x = cell();
    if (!x) return;
    app.toggleCell(x.track, x.step);
    if (!x.hit) void app.audition(x.track, app.ui.paintVel);
  }, { label: () => (cell()?.hit ? 'REMOVE HIT' : 'ADD HIT'), title: 'Add a hit to this step, or remove the one that is there' });
  toggle.dataset.test = 'step-toggle';
  const hint = h('div', 'hint', parent);
  const NOTHING = 'Click a step in the grid to add or remove a hit and edit it here. Right-click a step to edit it in a small panel. Arrow keys move along the track when the grid has focus.';
  const EMPTY = 'This step is empty. Add a hit (the button, or click the step again) to set its velocity, chance, pitch and ratchet.';
  const body = h('div', 'stepctl', parent);
  const hitCtl = (label: string, title: string, get: (hh: Hit) => number, set: (v: number) => Partial<Hit>, min: number, max: number, fmt?: (v: number) => string, bip = false) => {
    const c = ctl(body, label, title);
    c.row.style.setProperty('--label-w', '96px');
    range(panel, c.slot, {
      get: () => {
        const x = cell()?.hit;
        return x ? get(x) : min;
      },
      set: (v) => {
        const x = cell();
        if (x?.hit) app.setHitProps(x.track, x.step, set(v), label);
      },
      min,
      max,
      format: fmt,
      bip,
      begin: () => app.beginDrag(label),
      end: () => app.endDrag(),
      title,
    });
  };
  hitCtl('VELOCITY', 'How hard the hit plays (1 to 127)', (x) => x.vel, (v) => ({ vel: v }), 1, 127);
  hitCtl('CHANCE', 'Probability that this hit plays each time round', (x) => x.prob ?? 100, (v) => ({ prob: v }), 0, 100, (v) => v + '%');
  hitCtl('PITCH', 'Pitch offset in semitones', (x) => x.note ?? 0, (v) => ({ note: v }), -24, 24, (v) => (v > 0 ? '+' : '') + v, true);
  hitCtl('RATCHET', 'Play the step 1 to 4 times', (x) => x.ratchet ?? 1, (v) => ({ ratchet: v }), 1, 4, (v) => '×' + v);
  const extra = h('div', 'row wrap', parent);
  button(panel, extra, 'FLAM', () => {
    const x = cell();
    if (x?.hit) app.setHitProps(x.track, x.step, { flam: !x.hit.flam }, 'FLAM');
  }, { on: () => !!cell()?.hit?.flam, title: 'A soft grace note just before the hit' });
  h('div', 'lbl', extra, 'SAMPLE');
  select(panel, extra, {
    options: () => {
      const x = cell();
      const t = x && app.project.tracks.find((tt) => tt.id === x.track);
      const list = [{ value: '', label: 'TRACK PICK' }];
      for (const id of t?.sound.samples ?? []) list.push({ value: id, label: app.library.get(id)?.name ?? 'MISSING' });
      return list;
    },
    get: () => cell()?.hit?.sample ?? '',
    set: (v) => {
      const x = cell();
      if (x?.hit) app.setHitProps(x.track, x.step, { sample: v || undefined }, 'HIT SAMPLE');
    },
    title: 'The sample this hit plays (tracks with several samples)',
  });
  panel.add(() => {
    const x = cell();
    toggle.style.display = x ? '' : 'none';
    hint.textContent = x ? EMPTY : NOTHING;
    hint.style.display = x?.hit ? 'none' : '';
    body.style.display = x?.hit ? '' : 'none';
    extra.style.display = x?.hit ? '' : 'none';
    if (!x) {
      where.textContent = 'NO STEP SELECTED';
      return;
    }
    const t = app.project.tracks.find((tt) => tt.id === x.track)!;
    const pos = position(x.step, gridMetrics(app.pattern));
    where.textContent = `${t.name} · STEP ${x.step + 1} · BAR ${pos.bar} BEAT ${pos.beat}${x.hit ? '' : ' · EMPTY'}`;
  });
}
