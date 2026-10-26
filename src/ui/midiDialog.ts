/**
 * MIDI SETTINGS: one window, five sections side by side (not a long page):
 *
 *   INPUT              device (or ALL INPUTS), channel filter, notes in, velocity sensitivity, monitor
 *   OUTPUT             device, notes out, panic; CC OUT: the four MIDI CC destinations of the modulation
 *   CLOCK & TRANSPORT  INTERNAL / EXTERNAL / OFF, clock and transport out, following, status
 *   TRACK ROUTING      per track: INTERNAL / MIDI / BOTH, output channel, note, length
 *   MIDI LEARN         per track: the incoming note that plays it, LEARN, duplicates, mapping reset;
 *                      the macros' CCs
 *
 * What is per browser (devices, the input map, the clock mode) and what belongs to the project
 * (track routing, CC destinations) is said at the foot. Activity lights refresh while it is open.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import type { App } from '../app/app';
import { noteName } from '../midi/messages';
import { ALL_INPUTS, CC_SLOTS, CLOCK_LABEL, CLOCK_MODES, defaultCcSlots, duplicateNotes, findDevice, INPUT_MAPS, NO_NOTE, type DeviceRef, type InputMapId } from '../midi/settings';
import { TRACK_OUTS, type TrackOut } from '../model/types';
import { buttons, closeDialog, dialog } from './dialogs';
import { button, group, h, num, Panel, select } from './widgets';

const OUT_LABEL: Record<TrackOut, string> = { internal: 'INT', midi: 'MIDI', both: 'BOTH' };
const OUT_HELP: Record<TrackOut, string> = {
  internal: 'INTERNAL: plays CLATTER’s own sound (its SYNTH, SAMPLE or HYBRID source) and sends no MIDI',
  midi: 'MIDI: sends the notes to the output device only; CLATTER’s sound for this track is silent',
  both: 'BOTH: plays CLATTER’s sound and sends the notes',
};

const STATUS_TEXT: Record<string, string> = { off: 'OFF', waiting: 'WAITING FOR CLOCK', detected: 'CLOCK DETECTED', running: 'RUNNING', stopped: 'STOPPED BY THE MASTER', lost: 'CLOCK LOST · FREEWHEELING' };

/** Note display: name and number. */
const noteText = (n: number) => (n < 0 ? '—' : `${noteName(n)} ${n}`);

export function midiDialog(app: App): void {
  const box = dialog('MIDI SETTINGS', 1180);
  box.classList.add('mididlg');
  box.dataset.test = 'midi-dialog';
  const p = new Panel();
  const m = app.midi;
  const body = h('div', 'midigrid', box);

  // ---------------------------------------------------------------- access
  const access = h('div', 'midiaccess', body);
  p.add(() => {
    access.textContent = !m.supported ? 'THIS BROWSER HAS NO WEB MIDI: INTERNAL SOUNDS STILL WORK (USE CHROME, EDGE OR FIREFOX FOR MIDI).' : m.state === 'ready' ? '' : m.access.message.toUpperCase();
    access.style.display = access.textContent ? '' : 'none';
  });
  if (m.supported) {
    const en = button(p, body, 'ENABLE MIDI', () => void m.enable(), { cls: 'med midienable', title: 'Ask the browser for MIDI access' });
    en.dataset.test = 'midi-enable';
    p.add(() => (en.style.display = m.state === 'ready' ? 'none' : ''));
  }

  const deviceOptions = (ports: () => { id: string; name: string; connected: boolean }[], pref: () => DeviceRef | null, extra: { value: string; label: string }[]) => () => {
    const list = [...extra, ...ports().map((x) => ({ value: x.id, label: x.name.toUpperCase() + (x.connected ? '' : ' (OFF)') }))];
    const r = pref();
    if (r && !findDevice(r, ports())) list.push({ value: r.id, label: `${(r.name || 'DEVICE').toUpperCase()} (NOT CONNECTED)` });
    return list;
  };

  // ---------------------------------------------------------------- INPUT
  const gi = group(body, 'INPUT', 'col midisec');
  const ri = h('div', 'mrow', gi);
  h('div', 'lbl', ri, 'DEVICE');
  select(p, ri, {
    options: deviceOptions(() => m.inputs(), () => (m.prefs.input && m.prefs.input !== ALL_INPUTS ? m.prefs.input : null), [{ value: '', label: 'NONE' }, { value: ALL_INPUTS, label: 'ALL INPUTS' }]),
    get: () => (m.prefs.input === ALL_INPUTS ? ALL_INPUTS : (m.prefs.input?.id ?? '')),
    set: (id) => {
      if (!id) m.selectInput(null);
      else if (id === ALL_INPUTS) m.selectInput(ALL_INPUTS);
      else m.selectInput(m.inputs().find((x) => x.id === id) ?? (m.prefs.input !== ALL_INPUTS && m.prefs.input?.id === id ? m.prefs.input : { id, name: '' }));
    },
    width: 200,
    title: 'Where notes, clock and transport come from. ALL INPUTS listens to every connected device and follows plugging.',
  }).dataset.test = 'midi-input';
  const ri2 = h('div', 'mrow', gi);
  h('div', 'lbl', ri2, 'CHANNEL');
  select(p, ri2, {
    options: () => [{ value: 0, label: 'OMNI' }, ...Array.from({ length: 16 }, (_, i) => ({ value: i + 1, label: `CH ${i + 1}` }))],
    get: () => m.prefs.inChannel,
    set: (c) => m.update({ inChannel: c }),
    width: 80,
    title: 'Only notes and CCs on this channel are heard (OMNI: every channel). Clock is never filtered.',
  }).dataset.test = 'midi-in-channel';
  button(p, ri2, 'NOTES IN', () => m.update({ notesIn: !m.prefs.notesIn }), { cls: 'small', on: () => m.prefs.notesIn, title: 'Incoming notes play the tracks they are mapped to (MIDI LEARN)' });
  button(p, ri2, 'RECORD', () => ((app.ui.record = !app.ui.record), app.emit(['midi'])), { cls: 'small', on: () => app.ui.record, title: 'While playing, incoming notes are written into the pattern' });
  const ri3 = h('div', 'mrow', gi);
  h('div', 'lbl', ri3, 'VELOCITY');
  num(p, ri3, { get: () => Math.round(m.prefs.velSens * 100), set: (v) => m.update({ velSens: v / 100 }), min: 0, max: 100, format: (v) => v + '%', width: 52, title: 'Velocity sensitivity: 100 % plays what you play, 0 % plays every note at the fixed level. Applied once, before the sound (synth, sample and hybrid alike, and velocity modulation).' }).dataset.test = 'midi-vel-sens';
  h('div', 'lbl', ri3, 'FIXED');
  num(p, ri3, { get: () => m.prefs.velFixed, set: (v) => m.update({ velFixed: v }), min: 1, max: 127, width: 40, title: 'The velocity at 0 % sensitivity (and the centre the sensitivity scales around)' });
  const inLed = h('div', 'mrow', gi);
  const ledI = h('div', 'led midiled', inLed);
  ledI.title = 'Input activity';
  const inLast = h('div', 'tiny grow midilast', inLed);
  inLast.dataset.test = 'midi-in-last';
  const mon = h('div', 'midimon tiny', gi);
  mon.dataset.test = 'midi-monitor';

  // ---------------------------------------------------------------- OUTPUT
  const go = group(body, 'OUTPUT', 'col midisec');
  const ro = h('div', 'mrow', go);
  h('div', 'lbl', ro, 'DEVICE');
  select(p, ro, {
    options: deviceOptions(() => m.outputs(), () => m.prefs.out, [{ value: '', label: 'NONE' }]),
    get: () => m.prefs.out?.id ?? '',
    set: (id) => m.selectOutput(id ? (m.outputs().find((x) => x.id === id) ?? m.prefs.out) : null),
    width: 200,
    title: 'The device track notes, clock and transport go to',
  }).dataset.test = 'midi-output';
  const ro2 = h('div', 'mrow', go);
  button(p, ro2, 'NOTES OUT', () => m.update({ notesOut: !m.prefs.notesOut }), { cls: 'small', on: () => m.prefs.notesOut, title: 'Send the notes of tracks routed to MIDI or BOTH (TRACK ROUTING)' });
  button(p, ro2, 'PANIC', () => app.panic(), { cls: 'small', title: 'All notes off now: every note CLATTER started, then All Notes Off and All Sound Off on all 16 channels' }).dataset.test = 'midi-panic';
  const outLed = h('div', 'mrow', go);
  const ledO = h('div', 'led midiled', outLed);
  ledO.title = 'Output activity';
  const outLast = h('div', 'tiny grow midilast', outLed);
  outLast.dataset.test = 'midi-out-last';
  h('div', 'msub', go, 'CC OUT · MODULATION ▸ MIDI CC 1-4');
  const cct = h('div', 'mtable cctable', go);
  for (const t of ['', 'CC', 'CH', 'BASE', 'RES', 'HZ', 'DEVICE']) h('div', 'mth', cct, t);
  const slots = () => app.project.midiCc ?? defaultCcSlots();
  for (let i = 0; i < CC_SLOTS; i++) {
    button(p, cct, `${i + 1}`, () => app.setCcSlot(i, { on: !slots()[i]!.on }), { cls: 'small', on: () => slots()[i]!.on, title: `MIDI CC ${i + 1}: route a modulation source to it in SOUND ▸ MODULATION (destination MIDI CC ${i + 1})` });
    num(p, cct, { get: () => slots()[i]!.cc, set: (v) => app.setCcSlot(i, { cc: v }), min: 0, max: 119, width: 34, title: 'Controller number' }).dataset.test = `cc-num-${i}`;
    num(p, cct, { get: () => slots()[i]!.channel, set: (v) => app.setCcSlot(i, { channel: v }), min: 1, max: 16, width: 28, title: 'MIDI channel' });
    num(p, cct, { get: () => slots()[i]!.base, set: (v) => app.setCcSlot(i, { base: v }), min: 0, max: 127, width: 34, title: 'The value with no modulation (64 centres a bipolar LFO)' });
    num(p, cct, { get: () => slots()[i]!.res, set: (v) => app.setCcSlot(i, { res: v }), min: 2, max: 128, width: 34, title: 'Output resolution: how many distinct values (128 = every CC value; fewer = coarser steps, fewer messages)' });
    num(p, cct, { get: () => slots()[i]!.rate, set: (v) => app.setCcSlot(i, { rate: v }), min: 1, max: 100, width: 34, title: 'Most messages per second. A value is sent only when it changes.' });
    select(p, cct, {
      options: deviceOptions(() => m.outputs(), () => m.prefs.ccOut[i] ?? null, [{ value: '', label: 'MAIN' }]),
      get: () => m.prefs.ccOut[i]?.id ?? '',
      set: (id) => {
        const list = [...m.prefs.ccOut];
        list[i] = id ? (m.outputs().find((x) => x.id === id) ?? list[i] ?? null) : null;
        if (list[i]) list[i] = { id: list[i]!.id, name: list[i]!.name };
        m.update({ ccOut: list });
      },
      title: 'The device this CC goes to (MAIN: the output device above). Per browser.',
    });
  }

  // ---------------------------------------------------------------- CLOCK & TRANSPORT
  const gc = group(body, 'CLOCK & TRANSPORT', 'col midisec');
  const rc = h('div', 'mrow', gc);
  for (const mode of CLOCK_MODES)
    button(p, rc, CLOCK_LABEL[mode], () => app.setClockMode(mode), {
      cls: 'small',
      on: () => m.prefs.clock === mode,
      title: mode === 'internal' ? 'INTERNAL: CLATTER keeps time with its own tempo (and its tempo curve), and can send clock' : mode === 'external' ? 'EXTERNAL: CLATTER follows incoming MIDI clock; its own tempo and tempo curve wait until you switch back' : 'OFF: no clock is sent or followed; CLATTER keeps its own time',
    }).dataset.test = `clock-${mode}`;
  const rc2 = h('div', 'mrow', gc);
  const send = button(p, rc2, 'SEND CLOCK', () => m.update({ sendClock: !m.prefs.sendClock }), { cls: 'small', on: () => m.prefs.sendClock, disabled: () => m.prefs.clock !== 'internal', title: 'INTERNAL: send MIDI clock (24 per quarter, following tempo changes and the tempo curve)' });
  send.dataset.test = 'clock-send';
  button(p, rc2, 'SEND TRANSPORT', () => m.update({ sendTransport: !m.prefs.sendTransport }), { cls: 'small', on: () => m.prefs.sendTransport, disabled: () => m.prefs.clock !== 'internal', title: 'INTERNAL: send Start, Stop, Continue and Song Position' });
  const rc3 = h('div', 'mrow', gc);
  button(p, rc3, 'FOLLOW START/STOP', () => m.update({ followTransport: !m.prefs.followTransport }), { cls: 'small', on: () => m.prefs.followTransport, disabled: () => m.prefs.clock !== 'external', title: 'EXTERNAL: incoming Start, Stop and Continue start and stop CLATTER (off: only the tempo is followed)' });
  const rc4 = h('div', 'mrow', gc);
  button(p, rc4, app.ui.playing ? 'PAUSE' : 'CONTINUE', () => app.togglePause(), { cls: 'small', label: () => (app.ui.playing ? 'PAUSE' : app.resumeTick > 0 ? 'CONTINUE' : 'PLAY'), title: 'PAUSE keeps the position; CONTINUE plays on from it (MIDI Song Position and Continue) (⇧SPACE)' }).dataset.test = 'midi-pause';
  const cst = h('div', 'report midiclock', gc);
  cst.dataset.test = 'clock-status';
  h('div', 'hint', gc, 'WITH EXTERNAL CLOCK THE TEMPO AND TEMPO CURVE ARE SUSPENDED (KEPT, NOT LOST) AND COME BACK WHEN YOU SWITCH TO INTERNAL. A LOST CLOCK FREEWHEELS AT THE LAST TEMPO AND RELOCKS WHEN IT RETURNS.');

  // ---------------------------------------------------------------- TRACK ROUTING
  const gr = group(body, 'TRACK ROUTING', 'col midisec midiwide');
  const rt = h('div', 'mtable routetable', gr);
  for (const t of ['TRACK', 'ROUTE', 'CH', 'NOTE', 'LENGTH']) h('div', 'mth', rt, t);
  const tracks = () => app.project.tracks;
  const rows = Math.min(tracks().length, 12);
  for (let i = 0; i < rows; i++) {
    const tr = () => tracks()[i]!;
    const name = h('div', 'mtd tname', rt);
    p.add(() => (name.textContent = `${i + 1} ${tr()?.name ?? ''} · ${tr()?.sound.mode.toUpperCase() ?? ''}`));
    const seg = h('div', 'row mseg', rt);
    for (const o of TRACK_OUTS) button(p, seg, OUT_LABEL[o], () => app.setTrackMidi(tr().id, { out: o }), { cls: 'small', on: () => (tr().midi.out ?? 'both') === o, title: OUT_HELP[o] }).dataset.test = `route-${i}-${o}`;
    num(p, rt, { get: () => tr().midi.channel, set: (v) => app.setTrackMidi(tr().id, { channel: v }), min: 1, max: 16, width: 28, title: 'Output channel' });
    num(p, rt, { get: () => tr().midi.note, set: (v) => app.setTrackMidi(tr().id, { note: v }), min: 0, max: 127, width: 64, format: noteText, title: 'Output note (sound variations and step sounds never change it)' }).dataset.test = `out-note-${i}`;
    num(p, rt, { get: () => tr().midi.len ?? 0, set: (v) => app.setTrackMidi(tr().id, { len: v }), min: 0, max: 2000, step: 5, width: 60, format: (v) => (v ? `${v} MS` : 'AUTO'), title: 'Note length (AUTO: the hit’s gate, else half a step)' });
  }
  const rall = h('div', 'mrow', gr);
  h('div', 'lbl', rall, 'ALL TRACKS');
  for (const o of TRACK_OUTS) button(p, rall, OUT_LABEL[o], () => app.setAllTracksMidi({ out: o }), { cls: 'small', title: OUT_HELP[o] + ' (every track)' });
  button(p, rall, 'CH 10', () => app.setAllTracksMidi({ channel: 10 }), { cls: 'small', title: 'Every track on channel 10 (General MIDI drums)' });

  // ---------------------------------------------------------------- MIDI LEARN
  const gl = group(body, 'MIDI LEARN', 'col midisec');
  const lt = h('div', 'mtable learntable', gl);
  for (const t of ['TRACK', 'IN NOTE', '', '']) h('div', 'mth', lt, t);
  for (let i = 0; i < rows; i++) {
    const nm = h('div', 'mtd tname', lt);
    p.add(() => (nm.textContent = `${i + 1} ${tracks()[i]?.name ?? ''}`));
    const nb = num(p, lt, { get: () => m.prefs.inMap[i] ?? NO_NOTE, set: (v) => app.setInputNote(i, v), min: -1, max: 127, width: 64, format: noteText, title: 'The incoming note that plays this track (type a number; − for none)' });
    nb.dataset.test = `in-note-${i}`;
    button(p, lt, 'LEARN', () => app.armLearn(m.input.learn?.kind === 'track' && m.input.learn.index === i ? null : { kind: 'track', index: i }), { cls: 'small', on: () => m.input.learn?.kind === 'track' && m.input.learn.index === i, title: 'Press, then play a pad or key: that note plays this track' }).dataset.test = `learn-${i}`;
    const dup = h('div', 'tiny mdup', lt);
    p.add(() => {
      const d = duplicateNotes(m.prefs.inMap, rows).has(i);
      dup.textContent = d ? 'DUP' : '';
      dup.title = d ? 'Another track has the same note: one pad plays both' : '';
    });
  }
  const rl = h('div', 'mrow', gl);
  h('div', 'lbl', rl, 'RESET');
  for (const [id, mp] of Object.entries(INPUT_MAPS) as [InputMapId, (typeof INPUT_MAPS)[InputMapId]][]) {
    button(p, rl, id === 'gm' ? 'GM DRUMS' : 'PADS C1+', () => m.update({ inMap: mp.notes(m.prefs.inMap.length) }), { cls: 'small', title: mp.label }).dataset.test = `map-reset-${id}`;
  }
  h('div', 'msub', gl, 'MACROS ◂ CC');
  const ml = h('div', 'mrow', gl);
  for (let i = 0; i < 4; i++) {
    button(p, ml, `M${i + 1}`, () => app.armLearn(m.input.learn?.kind === 'macro' && m.input.learn.index === i ? null : { kind: 'macro', index: i }), {
      cls: 'small',
      on: () => m.input.learn?.kind === 'macro' && m.input.learn.index === i,
      label: () => `M${i + 1} ${m.prefs.macroLearn[i] ? 'CC' + m.prefs.macroLearn[i]!.number : '—'}`,
      title: 'Press, then move a knob: its CC moves this macro. Alt-click to forget.',
    });
  }
  ml.addEventListener('click', (e) => {
    if (!(e as MouseEvent).altKey) return;
    const b = (e.target as HTMLElement).closest('button');
    const i = b ? [...ml.children].indexOf(b) : -1;
    if (i >= 0) {
      const list = [...m.prefs.macroLearn];
      list[i] = null;
      m.update({ macroLearn: list });
      app.armLearn(null);
    }
  });
  const learnSt = h('div', 'report', gl);
  learnSt.dataset.test = 'learn-status';

  h('div', 'hint midifoot', box, 'PER BROWSER: DEVICES, THE INPUT MAP, VELOCITY AND THE CLOCK MODE (A PROJECT OPENED ELSEWHERE NEVER REACHES FOR DEVICES THAT ARE NOT THERE). IN THE PROJECT: TRACK ROUTING AND THE CC DESTINATIONS.');
  buttons(box, [['CLOSE', () => (app.armLearn(null), closeDialog()), true]]);

  // ---------------------------------------------------------------- live
  const live = () => {
    const now = performance.now();
    const li = m.input.last;
    ledI.classList.toggle('on', !!li && now - li.at < 150);
    inLast.textContent = li ? li.text : 'NO INPUT YET';
    const lo = m.outLast;
    ledO.classList.toggle('on', !!lo && now - lo.at < 150 && lo.at <= now);
    outLast.textContent = m.outputName ? (lo ? lo.text : 'READY') : m.outputMissing ? 'DEVICE NOT CONNECTED' : 'NO OUTPUT';
    mon.textContent = m.input.log.slice(-5).join('\n');
    const c = m.clock;
    const ext = m.prefs.clock === 'external';
    cst.textContent = ext ? `${STATUS_TEXT[c.status] ?? c.status.toUpperCase()}${c.bpm ? ` · ${c.bpm.toFixed(1)} BPM` : ''}${app.externalTempo ? ` · RUNNING AT ${app.effectiveBpm().toFixed(1)} · ERROR ${app.phaseError.toFixed(1)} TICKS` : ''}` : m.prefs.clock === 'internal' ? `INTERNAL ${app.effectiveBpm().toFixed(1)} BPM${m.sendingClock ? ' · SENDING CLOCK' : ''}` : 'NO CLOCK';
    learnSt.textContent = m.input.learn ? (m.input.learn.kind === 'track' ? `LEARN: PLAY A NOTE FOR TRACK ${m.input.learn.index + 1}` : `LEARN: MOVE A KNOB FOR MACRO ${m.input.learn.index + 1}`) : '';
  };
  const timer = setInterval(() => {
    if (!box.isConnected) {
      clearInterval(timer);
      app.armLearn(null);
      off();
      off2();
      return;
    }
    live();
  }, 100);
  const off = app.on('midi', () => p.refresh());
  const off2 = app.on('transport', () => p.refresh());
  p.refresh();
  live();
}
