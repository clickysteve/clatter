/**
 * The TUNER tab: what pitch the selected sound actually has. ANALYSE CURRENT SOUND renders the
 * selected track's base sound (or the open variation, for a HYBRID track the chosen layer) alone
 * and offline, finds its fundamental in the audio and shows the note, the frequency, the cents
 * against the note, how sure the analysis is and, for a pitch-swept drum, how the pitch moves.
 * Unpitched and inharmonic sounds say so instead of showing a note. Nothing is analysed during
 * playback; AUTO follows edits with a pause so a dragged knob does not render on every move.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import type { App } from '../../app/app';
import { KIND_LABEL, PITCH_METHOD, centsBetween, midiToHz, noteName, type PitchAnalysis } from '../../analysis/pitch';
import type { PitchLayer, PitchRecord } from '../../analysis/trackPitch';
import { font } from '../scale';
import { button, group, h, Panel } from '../widgets';
import { subscribe } from './patternView';
import { slotBar } from './soundControls';
import { Plot, vis, type PaneParts } from './soundUi';

const AUTO_DELAY = 450;
const LAYERS: [PitchLayer, string, string][] = [
  ['mix', 'MIX', 'Both layers, as the track plays'],
  ['synth', 'SYNTH', 'Only the LXR voice'],
  ['sample', 'SAMPLE', 'Only the sample layer'],
];

const fmtHz = (hz: number): string => (hz >= 1000 ? hz.toFixed(0) : hz >= 100 ? hz.toFixed(1) : hz.toFixed(2)) + ' HZ';
const pct = (v: number): string => Math.round(v * 100) + '%';
const signed = (c: number): string => (c > 0 ? '+' : c < 0 ? '−' : '±') + Math.abs(c).toFixed(1);

/** How sure, in words. */
export function confidenceWord(a: PitchAnalysis): string {
  if (a.kind === 'silent') return 'NONE';
  if (a.kind === 'unpitched' || a.kind === 'inharmonic') return 'NO RELIABLE PITCH';
  return a.confidence >= 0.85 ? 'HIGH' : a.confidence >= 0.6 ? 'GOOD' : a.confidence >= 0.4 ? 'LOW' : 'VERY LOW';
}

export function tunerPane(app: App, pane: HTMLElement): PaneParts {
  const tp = new Panel();
  const t = () => app.track;
  let layer: PitchLayer = 'mix';
  let auto = false;
  let busy = false;
  let error = '';
  let timer: ReturnType<typeof setTimeout> | null = null;
  let open = false;

  const target = () => ({ trackId: t().id, slot: app.ui.slot, layer });
  const stored = () => app.pitch.lookup(app.project, target());

  // ---------------------------------------------------------------- controls
  const top = h('div', 'col sndtop', pane);
  slotBar(app, h('div', 'row wrap', top), tp);
  const bar = h('div', 'row wrap', top);
  const run = async (force: boolean) => {
    if (busy) return;
    if (!app.module) {
      error = 'THE ENGINE IS NOT LOADED YET';
      return tp.refresh();
    }
    if (!force && !stored()?.stale && stored()) return;
    busy = true;
    error = '';
    tp.refresh();
    // let "ANALYSING" paint before the render and the analysis take the thread
    await new Promise<void>((r) => setTimeout(r, 20));
    try {
      await app.analysePitch(target(), force);
    } catch (e) {
      error = e instanceof Error ? e.message.toUpperCase() : String(e);
    }
    busy = false;
    tp.refresh();
    // the sound changed while it was being analysed: AUTO catches up
    if (auto && open && stored()?.stale) schedule();
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!auto || !open || app.ui.view !== 'sound' || app.ui.soundTab !== 'tuner') return;
    const s = stored();
    if (s && !s.stale) return;
    timer = setTimeout(() => {
      timer = null;
      void run(false);
    }, AUTO_DELAY);
  };
  button(tp, bar, 'ANALYSE CURRENT SOUND', () => void run(false), { cls: 'med', disabled: () => busy, title: 'Render this sound alone, offline, and find its pitch. Nothing you hear or save changes. A result that is still valid is shown at once.' }).dataset.test = 'tuner-analyse';
  button(tp, bar, 'REANALYSE', () => void run(true), { disabled: () => busy, title: 'Render and analyse again, even if the sound has not changed' }).dataset.test = 'tuner-reanalyse';
  button(tp, bar, 'AUTO', () => {
    auto = !auto;
    if (auto) schedule();
    tp.refresh();
  }, { on: () => auto, title: 'Analyse again a moment after the sound changes, and when you select another track or variation. Off by default.' }).dataset.test = 'tuner-auto';
  const layers = h('div', 'seg', bar);
  for (const [id, label, title] of LAYERS) {
    button(tp, layers, label, () => {
      layer = id;
      tp.refresh();
      schedule();
    }, { on: () => layer === id, cls: 'small', title }).dataset.test = 'tuner-layer-' + id;
  }
  vis(tp, layers, () => t().sound.mode === 'hybrid');
  const info = h('div', 'tiny grow', bar);
  tp.add(() => {
    const where = app.ui.slot === null ? 'BASE SOUND' : 'VARIATION ' + 'ABCD'[app.ui.slot];
    info.textContent = busy ? 'ANALYSING…' : `${t().name} · ${t().sound.mode.toUpperCase()}${t().sound.mode === 'hybrid' ? ' · ' + layer.toUpperCase() : ''} · ${where}`;
  });

  // ---------------------------------------------------------------- the readout and the tuning indicator
  const body = h('div', 'tunerws sndscroll', pane);
  const left = h('div', 'col', body);
  const right = h('div', 'col', body);
  const tg = group(left, 'TUNER');
  tg.classList.add('col');
  tg.dataset.test = 'tuner-readout';
  const note = h('div', 'tnote', tg);
  note.dataset.test = 'tuner-note';
  const hzLine = h('div', 'thz', tg);
  hzLine.dataset.test = 'tuner-hz';
  const centsLine = h('div', 'tcents', tg);
  centsLine.dataset.test = 'tuner-cents';
  const needle = new Plot(tg, 'tneedle');
  needle.el.style.cursor = 'default';
  const kind = h('div', 'tkind', tg);
  kind.dataset.test = 'tuner-kind';
  const why = h('div', 'report', tg);
  const meters = h('div', 'tmeters', tg);
  const meter = (label: string) => {
    const row = h('div', 'row tmeter', meters);
    h('div', 'lbl', row, label);
    const m = h('div', 'meter h grow', row);
    const l = h('div', 'lvl', m);
    const v = h('div', 'tiny tval', row);
    return { l, v };
  };
  const confM = meter('CONFIDENCE');
  const stabM = meter('STABILITY');
  const stale = h('div', 'tstale', tg);
  stale.dataset.test = 'tuner-stale';

  // ---------------------------------------------------------------- pitch over time
  const mg = group(right, 'PITCH OVER TIME');
  mg.classList.add('col');
  const graph = new Plot(mg, 'tgraph');
  graph.el.style.cursor = 'default';
  graph.el.dataset.test = 'tuner-graph';
  const moveRows = h('div', 'col tmove', mg);
  moveRows.dataset.test = 'tuner-move';
  const dg = group(right, 'DETAILS');
  dg.classList.add('col');
  const details = h('div', 'list tdetails', dg);
  details.dataset.test = 'tuner-details';
  h('div', 'hint', dg, 'THE PITCH IS FOUND IN THE RENDERED AUDIO (YIN, NOT A SPECTRUM PEAK), SO IT INCLUDES THE PITCH ENVELOPE, FM, FILTERS, MODULATION AND SAMPLE TUNING. A4 = 440 HZ. SOUNDS BELOW ABOUT 30 HZ OR WITH NO STEADY PERIOD ARE REPORTED AS SUCH, NEVER GIVEN A GUESSED NOTE.');

  // ---------------------------------------------------------------- drawing
  let current: PitchAnalysis | null = null;
  let dim = false;

  needle.set((g, W, H, ink, paper) => {
    const a = current;
    const fund = a?.fundamental;
    const mid = H * 0.55;
    // scale: -50 .. +50 cents
    const x = (c: number) => ((c + 50) / 100) * (W - 8) + 4;
    g.fillStyle = ink;
    for (let c = -50; c <= 50; c += 5) {
      const big = c % 25 === 0;
      const hh = c === 0 ? H * 0.5 : big ? H * 0.3 : c % 10 === 0 ? H * 0.2 : H * 0.1;
      g.fillRect(Math.round(x(c)) - (c === 0 ? 1 : 0), mid - hh / 2 + H * 0.15, c === 0 ? 3 : 1, hh);
    }
    g.font = `${font(14)}px VT323, monospace`;
    g.textBaseline = 'top';
    for (const c of [-50, -25, 0, 25, 50]) {
      g.textAlign = c === -50 ? 'left' : c === 50 ? 'right' : 'center';
      g.fillText(c === 0 ? '0' : (c > 0 ? '+' : '−') + Math.abs(c), c === -50 ? 2 : c === 50 ? W - 2 : x(c), 1);
    }
    g.textAlign = 'left';
    if (!fund) {
      g.fillStyle = paper;
      g.fillRect(W * 0.2, H * 0.45, W * 0.6, H * 0.4);
      g.fillStyle = ink;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.font = `${font(18)}px VT323, monospace`;
      g.fillText(a ? 'NO PITCH' : 'NOT ANALYSED', W / 2, H * 0.65);
      g.textAlign = 'left';
      return;
    }
    const nx = x(Math.max(-50, Math.min(50, fund.cents)));
    g.fillStyle = ink;
    g.fillRect(Math.round(nx) - 2, H * 0.3, 5, H * 0.65);
    g.fillStyle = paper;
    g.fillRect(Math.round(nx), H * 0.34, 1, H * 0.57);
    // a swept sound: a ghost mark where it starts, when that is within the scale (rarely, it is a different note)
    if (a && a.kind === 'swept' && a.initial && a.initial.midi === fund.midi) {
      g.fillStyle = ink;
      for (let y = Math.floor(H * 0.3); y < H * 0.95; y += 3) g.fillRect(Math.round(x(Math.max(-50, Math.min(50, a.initial.cents)))), y, 1, 1);
    }
  });

  graph.set((g, W, H, ink, paper) => {
    const a = current;
    g.font = `${font(14)}px VT323, monospace`;
    g.textBaseline = 'top';
    const pts = a?.contour ?? [];
    const voiced = pts.filter((p) => p.hz !== null);
    if (!a || !voiced.length) {
      g.textBaseline = 'middle';
      g.textAlign = 'center';
      g.font = `${font(18)}px VT323, monospace`;
      g.fillText(!a ? 'NOT ANALYSED' : 'NO PITCH TRACK', W / 2, H / 2);
      g.textAlign = 'left';
      return;
    }
    const left = font(34);
    const tMax = Math.max(0.05, pts[pts.length - 1]!.t + 0.005);
    const hzs = voiced.map((p) => p.hz!);
    const lo = Math.log2(Math.min(...hzs) / 1.12);
    const hi = Math.log2(Math.max(...hzs) * 1.12);
    const span = Math.max(hi - lo, 0.35);
    const mid = (lo + hi) / 2;
    const y0 = mid - span / 2;
    const X = (t: number) => left + (t / tMax) * (W - left - 6);
    const Y = (hz: number) => H - 4 - ((Math.log2(hz) - y0) / span) * (H - 8);
    // horizontal lines at the C notes in view, labelled
    for (let m = 0; m < 128; m += 12) {
      const hz = midiToHz(m);
      const y = Y(hz);
      if (y < 4 || y > H - 4) continue;
      for (let x = left; x < W; x += 4) g.fillRect(x, Math.round(y), 1, 1);
      g.fillText(noteName(m), 2, Math.min(H - font(12), y - font(7)));
    }
    // the level under the line, so the quiet tail is not mistaken for pitch
    for (const p of pts) g.fillRect(Math.round(X(p.t)), Math.round(H - 3 - p.level * font(16)), Math.max(1, Math.round((W - left) / pts.length) - 1), Math.max(1, Math.round(p.level * font(16))));
    // the settled pitch
    if (a.settled) {
      const y = Math.round(Y(a.settled.hz));
      g.fillRect(left, y, W - left, 1);
      g.fillText(`${a.settled.note} ${a.settled.hz.toFixed(1)}`, left + 4, Math.max(2, y - font(14)));
    }
    // the pitch track, broken where no pitch was found
    g.lineWidth = Math.max(2, font(2));
    g.lineJoin = 'round';
    g.strokeStyle = ink;
    g.beginPath();
    let prev = -10;
    pts.forEach((p, i) => {
      if (p.hz === null) return;
      if (i - prev > 2) g.moveTo(X(p.t), Y(p.hz));
      else g.lineTo(X(p.t), Y(p.hz));
      prev = i;
    });
    g.stroke();
    // the first frame, boxed
    const first = voiced[0]!;
    g.fillStyle = ink;
    g.fillRect(Math.round(X(first.t)) - 3, Math.round(Y(first.hz!)) - 3, 7, 7);
    g.fillStyle = paper;
    g.fillRect(Math.round(X(first.t)) - 1, Math.round(Y(first.hz!)) - 1, 3, 3);
    g.fillStyle = ink;
    g.textBaseline = 'alphabetic';
    g.fillText(`${(tMax * 1000).toFixed(0)} MS`, W - font(54), H - 3 - font(18));
    if (dim) {
      g.fillStyle = paper;
      for (let y = 0; y < H; y += 2) for (let x = (y / 2) % 2; x < W; x += 2) g.fillRect(x, y, 1, 1);
    }
  });

  // ---------------------------------------------------------------- the panel
  const row = (parent: HTMLElement, label: string, value: string) => {
    const r = h('div', 'row tmrow', parent);
    h('div', 'lbl', r, label);
    h('div', 'grow', r, value);
  };
  tp.add(() => {
    const s = stored();
    const rec: PitchRecord | null = s?.record ?? null;
    const a = rec?.analysis ?? null;
    current = a;
    dim = !!s?.stale;
    note.textContent = busy && !a ? '…' : a?.fundamental ? a.fundamental.note : a ? '—' : '·';
    hzLine.textContent = a?.fundamental ? fmtHz(a.fundamental.hz) : a ? 'NO NOTE' : 'PRESS ANALYSE CURRENT SOUND';
    centsLine.textContent = a?.fundamental ? `${signed(a.fundamental.cents)} CENTS · ${Math.abs(a.fundamental.cents) <= 5 ? 'IN TUNE' : a.fundamental.cents > 0 ? 'SHARP' : 'FLAT'}` : '';
    kind.textContent = a ? KIND_LABEL[a.kind] : '';
    kind.classList.toggle('none', !!a && !a.fundamental);
    why.textContent = error ? 'ANALYSIS FAILED: ' + error : (a?.reason ?? '');
    confM.l.style.width = (a ? a.confidence * 100 : 0) + '%';
    confM.v.textContent = a ? `${pct(a.confidence)} · ${confidenceWord(a)}` : '';
    stabM.l.style.width = (a?.fundamental ? a.stability * 100 : 0) + '%';
    stabM.v.textContent = a?.fundamental ? pct(a.stability) : '';
    tg.classList.toggle('stale', dim);
    stale.textContent = dim ? 'THE SOUND HAS CHANGED SINCE THIS ANALYSIS: REANALYSE' : rec ? `ANALYSED ${new Date(rec.at).toLocaleTimeString()}` : '';
    // movement
    moveRows.innerHTML = '';
    if (a?.fundamental && a.initial && a.settled) {
      row(moveRows, 'INITIAL', `${a.initial.note} · ${fmtHz(a.initial.hz)} (${signed(a.initial.cents)}C)`);
      row(moveRows, 'SETTLED', `${a.settled.note} · ${fmtHz(a.settled.hz)} (${signed(a.settled.cents)}C)`);
      if (a.kind === 'swept') {
        const semis = Math.abs(a.sweepCents) / 100;
        row(moveRows, 'MOVEMENT', `${a.sweepCents > 0 ? 'FALLS' : 'RISES'} ${semis.toFixed(1)} SEMITONES (${Math.abs(Math.round(a.sweepCents))} CENTS) IN ${Math.round(a.settleTime * 1000)} MS`);
      } else row(moveRows, 'MOVEMENT', 'NONE: THE PITCH HOLDS');
    } else h('div', 'tiny', moveRows, a ? 'NO PITCH TO FOLLOW' : '');
    // details
    details.innerHTML = '';
    if (a) {
      if (a.partials.length) h('div', 'li', details, `STRONG PARTIALS: ${a.partials.map((p) => (p >= 1000 ? (p / 1000).toFixed(2) + 'K' : p.toFixed(0))).join(' · ')} HZ`);
      if (a.fundamental && a.kind === 'stable' && a.partials.length) h('div', 'li', details, `AS MULTIPLES OF THE FUNDAMENTAL: ${a.partials.slice(0, 6).map((p) => (p / a.fundamental!.hz).toFixed(2)).join(' · ')}`);
      h('div', 'li', details, `MIDI NOTE ${a.fundamental ? a.fundamental.midi : '—'} · ${a.analysed.toFixed(2)} S ANALYSED · ${a.contour.filter((c) => c.hz !== null).length}/${a.contour.length} FRAMES VOICED`);
      h('div', 'li', details, `METHOD ${a.method} (v${a.version}) · ${PITCH_METHOD === a.method ? 'CURRENT' : 'OLDER METHOD'}`);
      if (a.fundamental && a.kind === 'swept') h('div', 'li', details, `ATTACK ${a.initial ? centsBetween(a.initial.hz, a.fundamental.hz).toFixed(0) : '—'} CENTS ABOVE THE BODY`);
    } else h('div', 'li', details, 'NO ANALYSIS YET');
    needle.draw();
    graph.draw();
  });

  subscribe(app, ['kit', 'tracks', 'selection', 'project', 'library', 'view'], () => {
    tp.refresh();
    schedule();
  });

  return {
    panels: [tp],
    active: (on) => {
      open = on;
      if (on) {
        tp.refresh();
        // opening the tab analyses a sound that has never been analysed (one render, on demand), not one that was
        if (!stored()) void run(false);
        else schedule();
      } else if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
