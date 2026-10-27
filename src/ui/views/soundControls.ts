/**
 * Controls shared by the SOUND view and the Step Sound editor: one LXR parameter (aware of the
 * variation being edited), the BASE / A-D selector, the track's source, a condition editor.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import type { App } from '../../app/app';
import { SLOT_NAMES, VARIATION_SLOTS, type SoundCond, type SourceMode } from '../../model/types';
import { formatValue, modTargets, PAR, targetLabel, TRIGGERS, type ParamDef } from '../../sound/lxrParams';
import { COND_KINDS, COND_LABEL, defaultCond, lockableParams } from '../../sound/stepSound';
import { button, ctl, h, num, Panel, range, select } from '../widgets';
import { pctRange } from './patternView';
import { seedField } from '../seedField';

const MODES: { value: SourceMode; label: string; title: string }[] = [
  { value: 'synth', label: 'SYNTH', title: 'The LXR voice' },
  { value: 'sample', label: 'SAMPLE', title: 'Samples only' },
  { value: 'hybrid', label: 'HYBRID', title: 'The LXR voice and the sample together, aligned' },
];

/** The voice the editors show: the selected track's, or the last one chosen for a sample track. */
let lastVoice = 0;
export function editVoice(app: App): number {
  const v = app.voiceOf(app.track);
  if (v >= 0) lastVoice = v;
  return lastVoice;
}
export function viewVoice(v: number): void {
  lastVoice = v;
}

/** What the SYNTH editor is editing, in words. */
export function editingText(app: App): string {
  const t = app.track;
  if (app.ui.slot === null) return `EDITING THE BASE SOUND OF ${t.name}: THE KIT. VARIATIONS FOLLOW IT WHERE THEY DO NOT OVERRIDE.`;
  const v = t.sound.variations?.[app.ui.slot];
  const n = v ? Object.keys(v.params).length + Object.keys(v.sample ?? {}).length : 0;
  const tag = v ? `${v.gen ? ' · GENERATED' : v.name ? '' : ' · BY HAND'}${v.lock ? ' · LOCKED' : ''}` : ' · EMPTY: IT PLAYS THE BASE SOUND UNTIL YOU CHANGE SOMETHING';
  return `EDITING VARIATION ${SLOT_NAMES[app.ui.slot]}${v?.name ? ' · ' + v.name : ''} OF ${t.name}${tag}${v ? ` · ${n} OVERRIDE${n === 1 ? '' : 'S'}` : ''}`;
}

/** BASE / A / B / C / D: which sound the editors work on. */
export function slotBar(app: App, parent: HTMLElement, panel: Panel): HTMLDivElement {
  const bar = h('div', 'seg slotbar', parent);
  bar.dataset.test = 'slotbar';
  const mk = (label: string, slot: number | null, title: string) => {
    const b = button(panel, bar, label, () => app.setSlot(slot), {
      on: () => app.ui.slot === slot,
      title,
      label: () => {
        if (slot === null) return 'BASE';
        const v = app.track.sound.variations?.[slot];
        return SLOT_NAMES[slot] + (v ? (v.lock ? '◆' : '') : '·');
      },
    });
    b.dataset.test = 'slot-' + (slot === null ? 'base' : SLOT_NAMES[slot]);
    return b;
  };
  mk('BASE', null, 'The base sound: the kit’s parameters for this voice');
  for (let i = 0; i < VARIATION_SLOTS; i++) mk(SLOT_NAMES[i]!, i, `Variation ${SLOT_NAMES[i]}: a sound of its own that follows the kit except where it overrides it (· = empty)`);
  return bar;
}

/** Name, randomise, mutate, duplicate, lock, clear and copy for the variation being edited. */
export function variationTools(app: App, parent: HTMLElement, panel: Panel): HTMLDivElement {
  const row = h('div', 'row wrap vartools', parent);
  const t = () => app.track;
  const slot = () => app.ui.slot;
  const cur = () => (slot() === null ? null : (t().sound.variations?.[slot()!] ?? null));
  const name = h('input', 'num', row) as HTMLInputElement;
  name.maxLength = 10;
  name.placeholder = 'NAME';
  name.style.width = '9em';
  name.title = 'Name of this variation';
  name.addEventListener('change', () => slot() !== null && app.renameVariation(t().id, slot()!, name.value));
  name.addEventListener('keydown', (e) => e.stopPropagation());
  const off = () => slot() === null;
  button(panel, row, 'NEW', () => slot() !== null && app.createVariation(t().id, slot()!), { disabled: () => off() || !!cur(), title: 'Start this variation from the current sound (it inherits everything until you change something)' });
  button(panel, row, 'DUPLICATE', () => {
    const s = slot();
    if (s === null) return;
    const to = [0, 1, 2, 3].map((i) => (i + s + 1) % 4).find((i) => !t().sound.variations?.[i]);
    if (to === undefined) return app.say('ALL FOUR SLOTS ARE IN USE');
    app.duplicateVariation(t().id, s, to);
  }, { disabled: () => off() || !cur(), title: 'Copy this variation to the next free slot' });
  button(panel, row, 'RANDOMISE', () => slot() !== null && app.randomizeVariation(t().id, slot()!, Math.max(0.35, app.project.timbre.amount)), { disabled: () => off() || !!cur()?.lock, title: 'A fresh related timbre from the base sound (uses TIMBRE)' });
  button(panel, row, 'MUTATE', () => slot() !== null && app.mutateVariation(t().id, slot()!, 0.5), { disabled: () => off() || !cur() || !!cur()?.lock, title: 'Nudge the values this variation overrides' });
  button(panel, row, 'LOCK', () => slot() !== null && app.lockVariation(t().id, slot()!), { on: () => !!cur()?.lock, disabled: () => off() || !cur(), title: 'Protect this variation from the sound generators' });
  button(panel, row, 'CLEAR', () => slot() !== null && app.clearVariation(t().id, slot()!), { disabled: () => off() || !cur(), title: 'Empty this slot (steps using it play the base sound)' });
  const copy = h('div', 'row', row);
  h('div', 'lbl', copy, 'COPY TO');
  select<string>(panel, copy, {
    options: () => [{ value: '', label: 'TRACK…' }, ...app.project.tracks.filter((x) => x.id !== t().id && (x.sound.mode === 'sample') === (t().sound.mode === 'sample')).map((x) => ({ value: x.id, label: x.name }))],
    get: () => '',
    set: (id) => id && slot() !== null && app.copyVariationTo(t().id, slot()!, id),
    title: 'Copy this variation to a compatible track (same kind of voice)',
  });
  panel.add(() => {
    if (document.activeElement !== name) name.value = cur()?.name ?? '';
    name.disabled = off() || !cur();
  });
  return row;
}

/** The track's source: SYNTH / SAMPLE / HYBRID, its LXR voice and the hybrid mix. */
export function sourceStrip(app: App, parent: HTMLElement, panel: Panel): HTMLDivElement {
  const t = () => app.track;
  const strip = h('div', 'row wrap sourcestrip', parent);
  strip.dataset.test = 'source-strip';
  const seg = h('div', 'seg', strip);
  for (const m of MODES) button(panel, seg, m.label, () => app.setTrackSound(t().id, { mode: m.value }, 'SOURCE'), { on: () => t().sound.mode === m.value, title: m.title }).dataset.test = 'mode-' + m.value;
  const vc = h('div', 'row', strip);
  h('div', 'lbl', vc, 'LXR VOICE');
  select(panel, vc, { options: () => TRIGGERS.map((n, i) => ({ value: i, label: n })), get: () => t().sound.trigger, set: (v) => app.setTrackSound(t().id, { trigger: v }, 'LXR VOICE'), title: 'Which LXR trigger plays this track (two tracks on one voice share it, as on the hardware)' });
  const nt = h('div', 'row', strip);
  h('div', 'lbl', nt, 'NOTE');
  range(panel, nt, { get: () => t().sound.note, set: (v) => app.setTrackSound(t().id, { note: v }, 'NOTE'), min: 24, max: 96, def: 60, bip: true, format: (v) => (v - 60 > 0 ? '+' : '') + (v - 60), begin: () => app.beginDrag('NOTE'), end: () => app.endDrag(), title: 'Synth note: 60 plays the voice at its programmed pitch', width: 120 });
  const ch = h('div', 'row', strip);
  h('div', 'lbl', ch, 'CHOKE');
  num(panel, ch, { get: () => t().sound.choke, set: (v) => app.setTrackSound(t().id, { choke: v }, 'CHOKE'), min: 0, max: 4, format: (v) => (v ? String(v) : 'OFF'), title: 'Tracks in the same choke group cut each other (0 = none)' });
  const hy = h('div', 'row wrap', strip);
  const hybrid = () => t().sound.mode === 'hybrid';
  const lv = (label: string, get: () => number, set: (v: number) => void, title: string) => {
    const c = ctl(hy, label, title);
    c.row.style.setProperty('--label-w', '80px');
    range(panel, c.slot, { get: () => Math.round(get() * 100), set: (v) => set(v / 100), min: 0, max: 100, format: (v) => v + '%', def: 80, begin: () => app.beginDrag(label), end: () => app.endDrag(), title, width: 110 });
    return c.row;
  };
  const a = lv('SYNTH', () => t().sound.synthLevel, (v) => app.setTrackSound(t().id, { synthLevel: v }, 'SYNTH LEVEL'), 'HYBRID: level of the synth layer');
  const b = lv('SAMPLE', () => t().sound.sampleLevel, (v) => app.setTrackSound(t().id, { sampleLevel: v }, 'SAMPLE LEVEL'), 'HYBRID: level of the sample layer');
  const al = ctl(hy, 'ALIGN', 'HYBRID: positive delays the sample, negative delays the synth (ms)');
  al.row.style.setProperty('--label-w', '70px');
  range(panel, al.slot, { get: () => t().sound.offsetMs, set: (v) => app.setTrackSound(t().id, { offsetMs: v }, 'ALIGN'), min: -30, max: 30, def: 0, bip: true, format: (v) => (v > 0 ? '+' : '') + v + 'MS', begin: () => app.beginDrag('ALIGN'), end: () => app.endDrag(), width: 120 });
  panel.add(() => {
    for (const x of [a, b, al.row]) x.style.display = hybrid() ? '' : 'none';
  });
  return strip;
}

export interface ParamCtlOptions {
  /** edit the kit whatever variation is selected (the FX bus, modulation targets) */
  base?: boolean;
  labelOf?: () => string;
}

/** One LXR parameter. With a variation selected it shows and sets that variation's value. */
export function paramCtl(app: App, parent: HTMLElement, p: ParamDef, panel: Panel, o: ParamCtlOptions = {}): void {
  const locked = () => app.project.soundLocks.params.includes(p.id);
  const slotted = () => !o.base && app.ui.slot !== null && lockableParams(app.track.sound.trigger).some((x) => x.id === p.id);
  const get = () => (o.base ? (app.project.kit.synth.params[p.id] ?? 0) : app.paramValue(p.id));
  const set = (v: number) => (o.base ? app.setParam(p.id, v, p.label) : app.setEditedParam(p.id, v, p.label));
  const c = ctl(parent, p.label, `${p.help}${p.kind === 'target' ? '' : ' (ALT-click the name: lock against kit generation. With a variation open, click the name of an overridden value to follow the kit again.)'}`);
  c.row.dataset.param = String(p.id);
  const lk = h('span', 'lock', c.name);
  panel.add(() => {
    if (o.labelOf) c.name.firstChild!.textContent = o.labelOf();
    const over = !o.base && app.paramOverridden(p.id);
    lk.textContent = (locked() ? '◆' : '') + (over ? '◇' : '');
    c.row.classList.toggle('overridden', over);
  });
  c.name.addEventListener('click', (e) => {
    if (e.altKey) app.lockParam(p.id);
    else if (slotted() && app.paramOverridden(p.id)) app.inheritParam(p.id);
  });
  if (p.kind === 'menu') {
    select(panel, c.slot, { options: () => (p.options ?? []).map((x, i) => ({ value: i, label: x })), get, set });
  } else if (p.kind === 'target') {
    const v = p.voice ?? 0;
    const lfo = p.id === PAR.TARGET_LFO1 + v;
    select(panel, c.slot, {
      options: () => [{ value: 0, label: 'NONE' }, ...modTargets(v).map((x) => ({ value: x.id, label: targetLabel(x.id) }))],
      get: () => (lfo ? app.project.kit.synth.lfoTarget[v] : app.project.kit.synth.velTarget[v]) ?? 0,
      set: (x) => app.setModTarget(lfo ? 0 : 1, v, x),
      title: 'The kit’s modulation target (the same for every variation)',
    });
  } else {
    range(panel, c.slot, {
      get,
      set,
      min: 0,
      max: p.max,
      bip: p.kind === 'bipolar',
      def: p.kind === 'bipolar' ? 63 : undefined,
      parse: p.kind === 'bipolar' ? (n) => n + 63 : undefined,
      format: (v) => formatValue(p, v),
      locked,
      onAlt: () => app.lockParam(p.id),
      begin: () => app.beginDrag(p.label),
      end: () => app.endDrag(),
    });
  }
}

/** Kind (and N or %) of a sound condition. */
export function condEditor(app: App, parent: HTMLElement, panel: Panel, get: () => SoundCond, set: (c: SoundCond) => void, test = 'cond'): HTMLDivElement {
  const row = h('div', 'row wrap condedit', parent);
  const k = select<SoundCond['k']>(panel, row, {
    options: () => COND_KINDS.map((x) => ({ value: x, label: COND_LABEL[x] })),
    get: () => get().k,
    set: (kind) => set(kind === get().k ? get() : defaultCond(kind)),
    title: 'When the change applies: always, a share of the passes, every Nth pass, the first or last pass of N, alternating passes, or during a fill',
  });
  k.dataset.test = test + '-kind';
  const n = num(panel, row, {
    get: () => {
      const c = get();
      return c.k === 'prob' ? c.p : 'n' in c ? c.n : 0;
    },
    set: (v) => {
      const c = get();
      if (c.k === 'prob') set({ k: 'prob', p: v });
      else if ('n' in c) set({ ...c, n: v });
    },
    min: 1,
    max: 100,
    format: (v) => (get().k === 'prob' ? v + '%' : String(v)),
    title: 'Percent for PROBABILITY, passes for EVERY / FIRST / LAST',
  });
  panel.add(() => {
    const c = get();
    n.style.display = c.k === 'prob' || 'n' in c ? '' : 'none';
    if (c.k !== 'prob' && 'n' in c) n.title = 'The cycle length in passes of the pattern';
  });
  return row;
}

/** TIMBRE and the sound generators. They act on the selection, or on every track without one. */
export function generativeCard(app: App, parent: HTMLElement, panel: Panel): HTMLDivElement {
  const box = h('div', 'col gencard', parent);
  box.dataset.test = 'sound-generate';
  const scope = h('div', 'hint', box);
  panel.add(() => {
    const s = app.ui.sel;
    scope.textContent = s ? `ACTS ON THE SELECTION: ${Math.abs(s.t1 - s.t0) + 1} TRACKS × ${Math.abs(s.s1 - s.s0) + 1} STEPS` : 'ACTS ON EVERY TRACK (SHIFT-DRAG IN THE GRID TO SELECT A REGION)';
  });
  pctRange(panel, box, app, 'TIMBRE', () => app.project.timbre.amount, (v) => app.setTimbre(v), 'How far the generated sounds stray from the base sound: 0 is a whisper, 100 is a different instrument of the same family', 0.35);
  const sdr = h('div', 'row', box);
  h('div', 'lbl', sdr, 'SEED').title = 'The seed of the sound generators. Type a phrase (or a number) to hold it: the same seed, TIMBRE and track roles make the same sounds.';
  const sdh = h('div', 'grow', sdr);
  seedField(panel, sdh, { get: () => app.seedSlot('sound').value, fixed: () => app.seedSlot('sound').fixed, onFixed: (on) => app.setSeedFixed('sound', on), onInput: (t) => void app.setSeedInput('sound', t), onRoll: () => app.rollSeed('sound'), onClear: () => app.clearSeed('sound'), test: 'sound-seed' });
  const r1 = h('div', 'row wrap', box);
  button(panel, r1, 'GENERATE VARIATIONS', () => app.generateVariationsFor(), { cls: 'grow', title: 'Fill the free slots A-D with related timbres designed for each track’s role. Hand-made and locked variations stay.' }).dataset.test = 'gen-variations';
  button(panel, r1, 'DISTRIBUTE', () => app.distributeVariations(), { cls: 'grow', title: 'Assign the variations to steps by role (accents, ghosts, off-beats, fills). Hand-made step sounds stay.' }).dataset.test = 'distribute';
  const r2 = h('div', 'row wrap', box);
  button(panel, r2, 'GENERATE SOUND', () => app.generateSound(), { cls: 'grow', title: 'Variations and their distribution in one undo step' }).dataset.test = 'gen-sound';
  button(panel, r2, 'MUTATE SOUND', () => app.mutateSound(0.3), { cls: 'grow', title: 'Redraw a share of the generated step sounds. The rhythm and hand-made sounds stay.' }).dataset.test = 'mutate-sound';
  button(panel, r2, 'MUTATE BOTH', () => app.mutateBoth(), { cls: 'grow', title: 'Mutate the rhythm and the sound together (one undo step)' });
  const r3 = h('div', 'row wrap', box);
  button(panel, r3, 'EVOLVE SOUND', () => app.addSoundEvolution(), { cls: 'grow', title: 'Bounded glides on a few parameters over 8 passes, then back to the base sound' }).dataset.test = 'evolve-sound';
  button(panel, r3, 'END EVOLUTION', () => app.clearSoundEvolution(), { cls: 'grow', title: 'Remove the glides' });
  const r4 = h('div', 'row wrap', box);
  button(panel, r4, 'RESET GENERATED', () => app.clearSoundsInScope(false), { cls: 'grow', title: 'Remove the generated step sounds (hand-made ones stay)' });
  button(panel, r4, 'RESET VARIATIONS', () => app.resetGeneratedVariations(), { cls: 'grow', title: 'Empty the generated variation slots (hand-made and locked ones stay)' });
  button(panel, r4, 'CLEAR ALL STEP SOUNDS', () => app.clearSoundsInScope(true), { cls: 'grow', title: 'Remove every step sound in scope, hand-made ones too (undo brings them back)' });
  return box;
}

export { pctRange };
