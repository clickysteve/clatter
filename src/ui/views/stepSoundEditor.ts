/**
 * The STEP SOUND tab of the PATTERN workspace: the sound of the step the cursor is on. Which
 * variation it plays (and a different one under a condition), which LXR voice it triggers,
 * parameter locks, conditional rules, a pass counter to audition the conditions, and the
 * generators. Everything is sparse: a step with no entry plays its track's sound.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import type { App } from '../../app/app';
import { SLOT_NAMES, VARIATION_SLOTS, type ParamRule, type StepSound } from '../../model/types';
import { formatValue, TRIGGERS } from '../../sound/lxrParams';
import { defaultCond, lockableParam, lockableParams } from '../../sound/stepSound';
import { button, group, h, num, Panel, range, select } from '../widgets';
import { condEditor, generativeCard } from './soundControls';

const OPS: { value: ParamRule['op']; label: string; title: string }[] = [
  { value: 'set', label: 'SET', title: 'The parameter is A while the condition holds' },
  { value: 'add', label: 'ADD', title: 'A is added to the parameter while the condition holds' },
  { value: 'range', label: 'RANDOM A-B', title: 'A random value between A and B, a new one each pass' },
  { value: 'alt', label: 'ALTERNATE', title: 'A on even passes, B on odd passes' },
  { value: 'evolve', label: 'EVOLVE', title: 'Glides from A to B over N passes and back again' },
];

export function stepSoundEditor(app: App, pane: HTMLElement, panel: Panel): void {
  const cell = () => app.cursorCell();
  const ss = (): StepSound | undefined => {
    const c = cell();
    return c ? app.stepSound(c.track, c.step) : undefined;
  };
  const track = () => {
    const c = cell();
    return c ? app.project.tracks.find((x) => x.id === c.track) : undefined;
  };
  const voice = () => ss()?.voice ?? track()?.sound.trigger ?? 0;
  const slotName = (v: number | null | undefined) => (v === null || v === undefined ? 'BASE' : SLOT_NAMES[v]!);

  // ---------------------------------------------------------------- the step
  const card = h('div', 'wscard col', pane);
  card.dataset.test = 'step-sound';
  const head = h('div', 'row wrap', card);
  const where = h('div', 'grow', head);
  panel.add(() => {
    const c = cell();
    const t = track();
    if (!c || !t) return (where.textContent = 'NO STEP SELECTED: CLICK A STEP IN THE GRID');
    const hit = app.hitAt(c.track, c.step);
    where.textContent = `${t.name} · STEP ${c.step + 1}${hit ? '' : ' · NO HIT: ADD ONE TO HEAR THE SOUND'}`;
  });
  const body = h('div', 'col', card);
  panel.add(() => (body.style.display = cell() ? '' : 'none'));

  const sr = h('div', 'row', body);
  h('div', 'lbl', sr, 'SOUND');
  const seg = h('div', 'seg slotbar', sr);
  seg.dataset.test = 'step-slotbar';
  const choose = (v: number | undefined, label: string) => {
    const b = button(panel, seg, label, () => app.setStepVariation(v), {
      on: () => ss()?.v === v,
      title: v === undefined ? 'The track’s base sound' : `Variation ${SLOT_NAMES[v]} of the track`,
      label: () => (v === undefined ? 'BASE' : label + (track()?.sound.variations?.[v] ? '' : '·')),
    });
    b.dataset.test = 'step-slot-' + label;
  };
  choose(undefined, 'BASE');
  for (let i = 0; i < VARIATION_SLOTS; i++) choose(i, SLOT_NAMES[i]!);

  const vr = h('div', 'row', body);
  h('div', 'lbl', vr, 'VOICE');
  select<number>(panel, vr, {
    options: () => [{ value: -1, label: 'TRACK’S OWN' }, ...TRIGGERS.map((n, i) => ({ value: i, label: n }))],
    get: () => ss()?.voice ?? -1,
    set: (v) => app.setStepVoice(v < 0 ? undefined : v),
    title: 'Trigger another LXR voice from this step. The voice’s monophonic limit still applies: a voice that is still sounding is retriggered.',
  }).dataset.test = 'step-voice';
  const vnote = h('div', 'hint', body);
  panel.add(() => {
    const v = ss()?.voice;
    vnote.textContent = v === undefined || v === track()?.sound.trigger ? '' : `THIS STEP TRIGGERS ${TRIGGERS[v]} INSTEAD. IT STILL PLAYS THROUGH THIS TRACK’S MIXER STRIP.`;
    vnote.style.display = vnote.textContent ? '' : 'none';
  });

  // a different variation while a condition holds
  const ar = h('div', 'row wrap', body);
  const altOn = () => !!ss()?.alt;
  button(panel, ar, 'IF', () => app.setStepAlt(altOn() ? null : { cond: defaultCond('prob'), v: 0 }), { on: altOn, label: () => (altOn() ? 'IF ON' : 'IF OFF'), title: 'Play a different variation (or the base sound) when a condition holds; otherwise the sound chosen above' }).dataset.test = 'step-alt';
  const altBox = h('div', 'row wrap', ar);
  condEditor(app, altBox, panel, () => ss()?.alt?.cond ?? defaultCond('prob'), (c) => ss()?.alt && app.setStepAlt({ cond: c, v: ss()!.alt!.v }), 'step-cond');
  h('div', 'lbl', altBox, 'PLAY');
  select<number>(panel, altBox, {
    options: () => [{ value: -1, label: 'BASE' }, ...SLOT_NAMES.slice(0, VARIATION_SLOTS).map((n, i) => ({ value: i, label: n }))],
    get: () => ss()?.alt?.v ?? -1,
    set: (v) => ss()?.alt && app.setStepAlt({ cond: ss()!.alt!.cond, v: v < 0 ? null : v }),
    title: 'The sound played while the condition holds',
  });
  panel.add(() => (altBox.style.display = altOn() ? '' : 'none'));

  // audition
  const pr = h('div', 'row wrap', body);
  h('div', 'lbl', pr, 'PASS').title = 'Which pass of the pattern to hear: conditions (EVERY, FIRST, LAST, ALTERNATE, EVOLVE) depend on it';
  num(panel, pr, { get: () => app.ui.previewPass, set: (v) => ((app.ui.previewPass = v), panel.refresh()), min: 1, max: 64, title: 'Which pass of the pattern to hear' }).dataset.test = 'step-pass';
  button(panel, pr, '▶ STEP', () => {
    const c = cell();
    if (c) void app.auditionStep(c.track, c.step);
  }, { title: 'Hear this step with its sound on the chosen pass' }).dataset.test = 'step-hear';
  button(panel, pr, '▶ BASE', () => {
    const c = cell();
    if (c) void app.auditionStep(c.track, c.step, true);
  }, { title: 'Hear the same step with the track’s base sound, to compare' }).dataset.test = 'step-hear-base';

  const cr = h('div', 'row wrap', body);
  button(panel, cr, 'COPY', () => app.copyStepSound(), { cls: 'grow', title: 'Copy this step’s sound' });
  button(panel, cr, 'PASTE', () => app.pasteStepSound(), { cls: 'grow', title: 'Paste it on this step (or on the selected steps)' });
  button(panel, cr, 'CLEAR LOCKS', () => app.clearStepLocks(), { cls: 'grow', disabled: () => !(ss()?.locks || ss()?.rules), title: 'Remove the locks and rules (the variation, condition and voice stay)' });
  button(panel, cr, 'CLEAR ALL', () => app.clearStepSounds(), { cls: 'grow', disabled: () => !ss(), title: 'This step plays its track’s sound again' }).dataset.test = 'step-clear';
  const sc = h('div', 'hint', body);
  panel.add(() => {
    const n = app.soundTargets().length;
    sc.textContent = n > 1 ? `THE SELECTION IS ${n} HITS: EDITS APPLY TO ALL OF THEM` : '';
    sc.style.display = n > 1 ? '' : 'none';
  });

  // ---------------------------------------------------------------- locks and rules
  const lk = h('div', 'wscard col', pane);
  const dyn = new Panel();
  const lg = group(lk, 'LOCKS');
  lg.classList.add('col');
  const lhint = h('div', 'hint', lg, 'A LOCK FIXES A PARAMETER FOR THIS STEP ONLY. IT RETURNS TO THE KIT AT THE VOICE’S NEXT HIT.');
  void lhint;
  const lockBox = h('div', 'col', lg);
  const addRow = h('div', 'row', lg);
  select<number>(panel, addRow, {
    options: () => [{ value: -1, label: 'ADD LOCK…' }, ...lockableParams(voice()).filter((p) => ss()?.locks?.[p.id] === undefined && p.kind !== 'target').map((p) => ({ value: p.id, label: p.group + ' ' + p.label }))],
    get: () => -1,
    set: (p) => p >= 0 && app.setStepLock(p, app.paramValue(p)),
    title: 'Fix a parameter on this step. It starts at the value the sound has now.',
  }).dataset.test = 'step-add-lock';
  const rg = group(lk, 'RULES');
  rg.classList.add('col');
  h('div', 'hint', rg, 'A RULE CHANGES A PARAMETER WHEN ITS CONDITION HOLDS. RULES ARE DETERMINISTIC: THE SAME PASS ALWAYS GIVES THE SAME SOUND.');
  const ruleBox = h('div', 'col', rg);
  button(panel, rg, 'ADD RULE', () => {
    const p = lockableParams(voice()).find((x) => x.kind !== 'target' && x.kind !== 'menu');
    if (p) app.addStepRule({ p: p.id, op: 'set', a: app.paramValue(p.id), b: app.paramValue(p.id), cond: defaultCond('prob') });
  }, { disabled: () => !cell() || (ss()?.rules?.length ?? 0) >= 8, title: 'Add a conditional rule (up to 8 per step)' }).dataset.test = 'step-add-rule';

  let sig = '';
  const rebuild = () => {
    const c = cell();
    const s = ss();
    const next = JSON.stringify([c, voice(), Object.keys(s?.locks ?? {}), (s?.rules ?? []).map((r) => [r.p, r.op, r.cond.k])]);
    if (next === sig) return dyn.refresh();
    sig = next;
    dyn.clear();
    lockBox.innerHTML = '';
    ruleBox.innerHTML = '';
    if (!c) return;
    for (const k of Object.keys(s?.locks ?? {})) {
      const p = lockableParam(voice(), Number(k));
      if (!p) continue;
      const row = h('div', 'row', lockBox);
      row.dataset.lock = k;
      const lab = h('div', 'lbl', row, `${p.group} ${p.label}`);
      lab.style.minWidth = '9em';
      const kit = () => formatValue(p, app.paramValue(p.id));
      range(dyn, row, {
        get: () => ss()?.locks?.[p.id] ?? 0,
        set: (v) => app.setStepLock(p.id, v),
        min: 0,
        max: p.max,
        bip: p.kind === 'bipolar',
        def: app.paramValue(p.id),
        format: (v) => formatValue(p, v),
        begin: () => app.beginDrag('STEP LOCK'),
        end: () => app.endDrag(),
        title: `${p.help} The sound has ${kit()} here.`,
      });
      button(dyn, row, '×', () => app.setStepLock(p.id, null), { cls: 'small', title: 'Unlock: back to the sound’s value' });
    }
    (s?.rules ?? []).forEach((r0, i) => {
      const r = () => ss()?.rules?.[i] ?? r0;
      const set = (patch: Partial<ParamRule>) => app.setStepRule(i, { ...r(), ...patch });
      const box = h('div', 'col rulebox', ruleBox);
      box.dataset.rule = String(i);
      const top = h('div', 'row wrap', box);
      select<number>(dyn, top, {
        options: () => lockableParams(voice()).filter((p) => p.kind !== 'target' && p.kind !== 'menu').map((p) => ({ value: p.id, label: p.group + ' ' + p.label })),
        get: () => r().p,
        set: (p) => set({ p }),
        title: 'The parameter the rule changes',
      });
      select<ParamRule['op']>(dyn, top, { options: () => OPS.map((o) => ({ value: o.value, label: o.label })), get: () => r().op, set: (op) => set({ op, n: op === 'evolve' ? (r().n ?? 8) : undefined }), title: OPS.find((o) => o.value === r0.op)?.title });
      button(dyn, top, '×', () => app.setStepRule(i, null), { cls: 'small', title: 'Remove the rule' });
      const vals = h('div', 'row wrap', box);
      const mid = (r0.op === 'add' ? -127 : 0);
      num(dyn, vals, { get: () => r().a, set: (a) => set({ a }), min: mid, max: 127, title: 'A' });
      const bNum = num(dyn, vals, { get: () => r().b, set: (b) => set({ b }), min: 0, max: 127, title: 'B' });
      const nNum = num(dyn, vals, { get: () => r().n ?? 8, set: (n) => set({ n }), min: 2, max: 64, format: (v) => v + ' PASSES', title: 'Passes for the glide to its end and back' });
      dyn.add(() => {
        bNum.style.display = r().op === 'range' || r().op === 'alt' || r().op === 'evolve' ? '' : 'none';
        nNum.style.display = r().op === 'evolve' ? '' : 'none';
      });
      condEditor(app, box, dyn, () => r().cond, (cond) => set({ cond }), 'rule-cond');
    });
    dyn.refresh();
  };
  panel.add(rebuild);

  // ---------------------------------------------------------------- the generators
  const gc = h('div', 'wscard col', pane);
  const gg = group(gc, 'GENERATE SOUND');
  gg.classList.add('col');
  generativeCard(app, gg, panel);
  void slotName;
}
