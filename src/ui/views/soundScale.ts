/**
 * The SCALE tab: musical scale quantisation. The global scale (on or off, root, type, and for the
 * USER type the notes you draw) and, for every track, whether it follows it (GLOBAL), has its own
 * (CUSTOM) or is left alone (OFF). Each track row says what the scale does to its sound: the
 * pitch the sound has, the scale note it is moved to, and whether that comes from a measurement of
 * the rendered audio or only from the oscillator setting. Sounds without a reliable pitch are
 * listed as left alone. TUNE renders and measures the sounds; nothing else here renders.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import type { App } from '../../app/app';
import { planTrack, slotName, type LayerResult } from '../../music/measure';
import { NOTE_NAMES, SCALE_TYPES, cleanMask, defaultModeFor, describeScale, shortScale, trackScaleState, type TrackScaleMode } from '../../music/scale';
import type { Track } from '../../model/types';
import { button, group, h, Panel, select } from '../widgets';
import { subscribe } from './patternView';
import type { PaneParts } from './soundUi';

const MODES: [TrackScaleMode, string, string][] = [
  ['off', 'OFF', 'No pitch quantisation: this track plays at the pitch its sound has'],
  ['global', 'GLOBAL', 'Follow the global scale'],
  ['custom', 'CUSTOM', 'Use a scale of its own, whatever the global scale is'],
];

const SCALE_OPTIONS = () => SCALE_TYPES.filter((s) => s.menu).map((s) => ({ value: s.id, label: s.label }));
const ROOT_OPTIONS = () => NOTE_NAMES.map((n, i) => ({ value: i, label: n }));

const cents = (c: number): string => (c > 0 ? '+' : c < 0 ? '−' : '±') + Math.abs(Math.round(c)) + 'C';

/** One sound of a track in words: where it was, where the scale put it, and how that is known. */
export function describeLayer(l: LayerResult): string {
  const where = (l.slot === null ? '' : ' ' + slotName(l.slot)) + (l.layer === 'sample' ? ' SMP' : '');
  if (l.state === 'left') return `${where.trim() ? where.trim() + ': ' : ''}${l.reason ?? 'NOT TUNED'}`;
  if (l.source === 'follows') return `${where.trim() ? where.trim() + ': ' : ''}MOVES WITH THE OTHER LAYER`;
  const src = l.source === 'measured' ? 'MEASURED' : l.source === 'hint' ? 'FROM THE FILE NAME' : 'FROM THE OSCILLATOR SETTING';
  const move = l.state === 'in-tune' ? `${l.targetNote} ALREADY ON THE SCALE` : `${l.naturalNote} → ${l.targetNote} (${cents((l.shift ?? 0) * 100)})`;
  const after = l.verified && l.errorCents !== undefined ? ` · HEARD ${cents(l.errorCents)}` : '';
  return `${where.trim() ? where.trim() + ': ' : ''}${move} · ${src}${after}`;
}

export function scalePane(app: App, pane: HTMLElement): PaneParts {
  const sp = new Panel();
  const top = h('div', 'col sndtop', pane);

  // ---------------------------------------------------------------- the global scale
  const gl = h('div', 'row wrap', top);
  h('div', 'lbl', gl, 'GLOBAL SCALE');
  button(sp, gl, 'ON', () => app.setGlobalScale({ on: !app.scale.on }, app.scale.on ? 'SCALE OFF' : 'SCALE ON'), { cls: 'small', on: () => app.scale.on, title: 'Quantise the tracks that follow the global scale to it' }).dataset.test = 'scale-on';
  select(sp, gl, { options: ROOT_OPTIONS, get: () => app.scale.root, set: (v) => app.setGlobalScale({ root: v }, 'SCALE ROOT'), width: 56, title: 'Root note' }).dataset.test = 'scale-root';
  select(sp, gl, { options: SCALE_OPTIONS, get: () => app.scale.type, set: (v) => app.setGlobalScale({ type: v }, 'SCALE TYPE'), width: 180, title: 'Scale type' }).dataset.test = 'scale-type';
  button(sp, gl, 'TUNE ALL', () => void app.tuneToScale().catch((e) => app.say(`TUNING FAILED: ${e instanceof Error ? e.message.toUpperCase() : String(e)}`)), { disabled: () => app.tuning || !app.module, title: 'Render and measure every scale-locked sound again and move it onto its scale. The sounds are measured automatically when something changes; this measures them all afresh.' }).dataset.test = 'scale-tune-all';
  const gsum = h('div', 'tiny grow', gl);
  sp.add(() => {
    const g = app.scale;
    gsum.textContent = (g.on ? `${describeScale(g)} · ` : 'OFF · ') + (app.tuning ? 'TUNING…' : '');
  });

  // the USER scale's notes, drawn over the 12 pitch classes from the root
  const gu = h('div', 'row wrap', top);
  const userKeys = h('div', 'seg', gu);
  const guLbl = h('div', 'lbl', gu, 'USER NOTES');
  NOTE_NAMES.forEach((_, i) => {
    button(sp, userKeys, '', () => {
      const m = cleanMask(app.scale.mask);
      app.setGlobalScale({ mask: cleanMask(m ^ (1 << i)) }, 'USER SCALE');
    }, { cls: 'small', on: () => (cleanMask(app.scale.mask) & (1 << i)) !== 0, label: () => NOTE_NAMES[(app.scale.root + i) % 12]!, title: 'Add or remove this note of the user scale' }).dataset.test = 'scale-user-' + i;
  });
  sp.add(() => {
    const on = app.scale.type === 'user';
    gu.style.display = on ? '' : 'none';
    guLbl.style.display = on ? '' : 'none';
  });
  h('div', 'hint', top, 'A TRACK THAT FOLLOWS A SCALE HAS ITS SOUND MOVED, AS ONE STEADY OFFSET, SO THAT ITS AUDIBLE PITCH LANDS ON THE NEAREST NOTE OF THE SCALE. A KICK’S DOWNWARD SWEEP, FM AND MODULATION KEEP THEIR SHAPE AROUND THE NEW PITCH. NOISY AND METALLIC SOUNDS ARE LEFT ALONE.');

  // ---------------------------------------------------------------- the tracks
  const body = h('div', 'sndscroll', pane);
  const tg = group(body, 'TRACKS');
  tg.classList.add('col');
  const tp = new Panel();
  let built = '';
  const rows = h('div', 'col scalerows', tg);

  const build = () => {
    const key = app.project.tracks.map((t) => t.id).join('|');
    if (key === built) return tp.refresh();
    built = key;
    rows.innerHTML = '';
    tp.clear();
    for (const tr of app.project.tracks) addRow(tr.id);
    tp.refresh();
  };

  const addRow = (id: string) => {
    const x = (): Track => app.project.tracks.find((t) => t.id === id)!;
    const box = h('div', 'scalerow', rows);
    box.dataset.track = id;
    const r1 = h('div', 'row wrap', box);
    const lock = h('div', 'scalelock', r1);
    const nm = h('div', 'sname', r1);
    nm.style.minWidth = '90px';
    const seg = h('div', 'seg', r1);
    for (const [mode, label, title] of MODES)
      button(tp, seg, label, () => app.setTrackScale(id, { mode }), { cls: 'small', on: () => trackScaleState(app.project, x()).mode === mode, title }).dataset.test = `scale-mode-${mode}-${id}`;
    const custom = h('div', 'row', r1);
    select(tp, custom, { options: ROOT_OPTIONS, get: () => x().scale?.root ?? 0, set: (v) => app.setTrackScale(id, { root: v }, 'TRACK SCALE ROOT'), width: 56, title: 'Root of this track’s own scale' }).dataset.test = 'scale-track-root-' + id;
    select(tp, custom, { options: SCALE_OPTIONS, get: () => x().scale?.type ?? 'minor', set: (v) => app.setTrackScale(id, { type: v }, 'TRACK SCALE TYPE'), width: 180, title: 'Scale of this track' }).dataset.test = 'scale-track-type-' + id;
    button(tp, r1, 'TUNE', () => void app.tuneToScale([id]).catch((e) => app.say(`TUNING FAILED: ${e instanceof Error ? e.message.toUpperCase() : String(e)}`)), { cls: 'small', disabled: () => app.tuning || !app.module || !trackScaleState(app.project, x()).spec, title: 'Render and measure this track’s sounds again and move them onto the scale' }).dataset.test = 'scale-tune-' + id;
    const user = h('div', 'row wrap', box);
    const uk = h('div', 'seg', user);
    NOTE_NAMES.forEach((_, i) =>
      button(tp, uk, '', () => app.setTrackScale(id, { mask: cleanMask(cleanMask(x().scale?.mask) ^ (1 << i)), type: 'user' }, 'USER SCALE'), { cls: 'small', on: () => (cleanMask(x().scale?.mask) & (1 << i)) !== 0, label: () => NOTE_NAMES[((x().scale?.root ?? 0) + i) % 12]!, title: 'Add or remove this note of the track’s user scale' }),
    );
    const info = h('div', 'report scaleinfo', box);
    info.dataset.test = 'scale-info-' + id;
    tp.add(() => {
      const t = x();
      const st = trackScaleState(app.project, t);
      box.classList.toggle('locked', !!st.spec);
      lock.textContent = st.spec ? '♪' : '';
      lock.title = st.spec ? 'Scale-locked: ' + describeScale(st.spec) : 'Not scale-locked';
      nm.textContent = t.name;
      custom.style.display = st.mode === 'custom' ? '' : 'none';
      user.style.display = st.mode === 'custom' && (t.scale?.type ?? 'minor') === 'user' ? '' : 'none';
      if (!st.spec) {
        info.textContent = st.mode === 'off' ? (defaultModeFor(t.role) === 'off' ? 'OFF · NOT A PITCHED SOUND BY DEFAULT' : 'OFF') : 'FOLLOWS THE GLOBAL SCALE, WHICH IS OFF';
        return;
      }
      const lines = planTrack(app.project, t, app.tuneEnv).map(describeLayer);
      const head = `${st.source === 'custom' ? 'OWN SCALE' : 'GLOBAL'} · ${shortScale(st.spec)}`;
      info.textContent = head + (lines.length ? ' · ' + lines.join(' | ') : '');
    });
  };

  build();
  subscribe(app, ['tracks', 'scale', 'project', 'kit', 'library'], () => {
    sp.refresh();
    build();
  });

  return {
    panels: [sp, tp],
    active: (on) => {
      if (on) {
        sp.refresh();
        build();
      }
    },
  };
}
