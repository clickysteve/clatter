/** MIDI: settings and persistence, input (devices, channels, mapping, learn, velocity), output (routing, notes, panic), clock in and out, transport, CC out. No hardware: test doubles throughout. */
import { describe, expect, it } from 'vitest';
import { App } from '../src/app/app';
import { CcRunner, quantiseCc, usesCc } from '../src/midi/ccOut';
import { ExternalClock, PhaseLock, PulseEstimator } from '../src/midi/clock';
import { MidiController } from '../src/midi/controller';
import { InputRouter } from '../src/midi/input';
import { MidiOutput } from '../src/midi/output';
import { noteLength, TrackRouter } from '../src/midi/router';
import { defaultCcSlots, defaultMidiPrefs, duplicateNotes, findDevice, GM_MAP, INPUT_MAPS, repairCcSlots, repairMidiPrefs, scaleVelocity, type MidiPrefs } from '../src/midi/settings';
import { defaultRoute, defaultSource } from '../src/mod/config';
import { DESTS, destsFor } from '../src/mod/registry';
import { musicalDests } from '../src/mod/presets';
import { parseProject, serialize } from '../src/model/project';
import { PPQ, type CcSlot } from '../src/model/types';
import { setHit, setStepTrig } from '../src/rhythm/pattern';
import { Scheduler, type ScheduledEvent } from '../src/transport/scheduler';
import { defaultPrefs, loadPrefs } from '../src/app/prefs';

/** A virtual output: records what is sent. */
function sink(name = 'VIRTUAL') {
  const log: { bytes: number[]; t: number }[] = [];
  return { id: 'out-' + name, name, log, send: (bytes: number[], t?: number) => log.push({ bytes: [...bytes], t: t ?? 0 }), clear: () => undefined };
}

const isOn = (b: number[]) => (b[0]! & 0xf0) === 0x90 && b[2]! > 0;
const isOff = (b: number[]) => (b[0]! & 0xf0) === 0x80;

describe('settings and persistence', () => {
  it('migrates the first MIDI preferences (clock in/out flags, device ids)', () => {
    const p = repairMidiPrefs({ outId: 'o1', inId: 'i1', notesOut: false, clockOut: true, clockIn: false, notesIn: true, inChannel: 10 });
    expect(p.v).toBe(2);
    expect(p.out).toEqual({ id: 'o1', name: '' });
    expect(p.input).toEqual({ id: 'i1', name: '' });
    expect(p.clock).toBe('internal');
    expect(p.sendClock).toBe(true);
    expect(p.notesOut).toBe(false);
    expect(p.inChannel).toBe(10);
    expect(repairMidiPrefs({ clockIn: true }).clock).toBe('external');
  });

  it('repairs damaged preferences without throwing, and round-trips through storage', () => {
    const p = repairMidiPrefs({ v: 2, input: '*', inChannel: 99, clock: 'banana', velSens: 7, inMap: [36, 'x', 200], ccOut: [{ id: 'a', name: 'A' }, 5], macroLearn: [{ channel: null, number: 21 }, { number: -3 }] });
    expect(p.input).toBe('*');
    expect(p.inChannel).toBe(16);
    expect(p.clock).toBe('internal');
    expect(p.velSens).toBe(1);
    expect(p.inMap.slice(0, 3)).toEqual([36, GM_MAP[1], 127]);
    expect(p.ccOut[0]).toEqual({ id: 'a', name: 'A' });
    expect(p.ccOut[1]).toBeNull();
    expect(p.macroLearn[0]).toEqual({ channel: null, number: 21 });
    expect(p.macroLearn[1]).toBeNull();
    expect(repairMidiPrefs(JSON.parse(JSON.stringify(p)))).toEqual(p);
    expect(repairMidiPrefs(null)).toEqual(defaultMidiPrefs());
  });

  it('keeps device preferences per browser: they are in the preferences, never in a project', () => {
    const store = new Map<string, string>();
    (globalThis as unknown as { localStorage: Storage }).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k), clear: () => store.clear(), key: () => null, length: 0 };
    const pr = defaultPrefs();
    pr.midi.out = { id: 'x', name: 'DRUMS' };
    pr.midi.clock = 'external';
    store.set('clatter.prefs', JSON.stringify(pr));
    const back = loadPrefs();
    expect(back.midi.out).toEqual({ id: 'x', name: 'DRUMS' });
    expect(back.midi.clock).toBe('external');
    const app = new App();
    expect(serialize(app.project)).not.toContain('DRUMS');
    delete (globalThis as unknown as { localStorage?: Storage }).localStorage;
  });

  it('saves track routing and CC destinations in the project; older projects load unchanged', () => {
    const app = new App();
    const t = app.project.tracks[0]!;
    app.setTrackMidi(t.id, { out: 'midi', channel: 3, note: 40, len: 120 });
    app.setCcSlot(1, { cc: 20, base: 64 });
    const back = parseProject(serialize(app.project));
    expect(back.tracks[0]!.midi).toEqual({ channel: 3, note: 40, out: 'midi', len: 120 });
    expect(back.midiCc![1]).toMatchObject({ cc: 20, base: 64 });
    // a project from before: no routing (BOTH, as always), no CC destinations
    const old = JSON.parse(serialize(app.project));
    delete old.midiCc;
    old.tracks[0].midi = { channel: 10, note: 36 };
    const o = parseProject(JSON.stringify(old));
    expect(o.tracks[0]!.midi).toEqual({ channel: 10, note: 36 });
    expect(o.midiCc).toBeUndefined();
    expect(repairCcSlots([{ cc: 500, rate: 0 }])![0]).toMatchObject({ cc: 119, rate: 1 });
  });

  it('finds a remembered device by id, else by name (another port, another id), never a disconnected one', () => {
    const ports = [{ id: 'a', name: 'PADS', connected: true }, { id: 'b', name: 'DRUMS', connected: true }, { id: 'c', name: 'OLD', connected: false }];
    expect(findDevice({ id: 'b', name: 'X' }, ports)?.id).toBe('b');
    expect(findDevice({ id: 'zz', name: 'DRUMS' }, ports)?.id).toBe('b');
    expect(findDevice({ id: 'c', name: 'OLD' }, ports)).toBeNull();
    expect(findDevice(null, ports)).toBeNull();
  });
});

describe('input: channels, mapping, learn, velocity', () => {
  function rig(over: Partial<MidiPrefs> = {}) {
    const prefs = { ...defaultMidiPrefs(), ...over };
    const hits: [number, number][] = [];
    const macros: [number, number][] = [];
    const learned: string[] = [];
    const r = new InputRouter(() => prefs, () => 10, { trigger: (t, v) => hits.push([t, v]), macro: (i, v) => macros.push([i, v]), learned: (_t, s) => learned.push(s) });
    return { prefs, hits, macros, learned, r };
  }

  it('plays the track mapped to a note (default: General MIDI) and nothing for an unmapped note', () => {
    const { r, hits } = rig();
    r.receive([0x99, 36, 100], 0);
    r.receive([0x99, 38, 90], 0);
    r.receive([0x99, 99, 90], 0);
    expect(hits).toEqual([[0, 100], [1, 90]]);
    expect(r.log.at(-1)).toContain('UNMAPPED');
  });

  it('filters by channel: OMNI hears every channel, a channel only itself', () => {
    const a = rig();
    a.r.receive([0x90, 36, 100], 0);
    a.r.receive([0x9f, 36, 100], 0);
    expect(a.hits.length).toBe(2);
    const b = rig({ inChannel: 10 });
    b.r.receive([0x90, 36, 100], 0);
    b.r.receive([0x99, 36, 100], 0);
    expect(b.hits).toEqual([[0, 100]]);
    expect(b.r.log[0]).toContain('FILTERED');
  });

  it('ignores note-ons with velocity 0 (note-offs), note-offs, and notes when NOTES IN is off', () => {
    const { r, hits, prefs } = rig();
    r.receive([0x99, 36, 0], 0);
    r.receive([0x89, 36, 64], 0);
    prefs.notesIn = false;
    r.receive([0x99, 36, 100], 0);
    expect(hits).toEqual([]);
  });

  it('a duplicate note plays both tracks and is reported', () => {
    const { r, hits, prefs } = rig();
    prefs.inMap[3] = 36;
    r.receive([0x99, 36, 100], 0);
    expect(hits).toEqual([[0, 100], [3, 100]]);
    expect([...duplicateNotes(prefs.inMap, 10)].sort()).toEqual([0, 3]);
    expect(duplicateNotes(GM_MAP).size).toBe(0);
  });

  it('MIDI Learn: the next note is the track’s; the next CC the macro’s, which then moves it', () => {
    const { r, hits, prefs, macros, learned } = rig();
    r.arm({ kind: 'track', index: 4 });
    r.receive([0x92, 72, 50], 0);
    expect(prefs.inMap[4]).toBe(72);
    expect(hits).toEqual([]); // the learning note does not play
    expect(learned[0]).toContain('TRACK 5');
    expect(r.learn).toBeNull();
    r.receive([0x92, 72, 50], 0);
    expect(hits).toEqual([[4, 50]]);
    r.arm({ kind: 'macro', index: 1 });
    r.receive([0xb0, 21, 10], 0);
    expect(prefs.macroLearn[1]).toEqual({ channel: null, number: 21 });
    r.receive([0xb3, 21, 127], 0);
    expect(macros).toEqual([[1, 1]]);
  });

  it('mapping reset: General MIDI drums, or pads from C1', () => {
    expect(INPUT_MAPS.gm.notes(10)).toEqual(GM_MAP);
    expect(INPUT_MAPS.pads.notes(4)).toEqual([36, 37, 38, 39]);
  });

  it('velocity sensitivity scales once: 100 % as played, 0 % fixed, in between blended', () => {
    expect(scaleVelocity(30, 1, 100)).toBe(30);
    expect(scaleVelocity(30, 0, 100)).toBe(100);
    expect(scaleVelocity(30, 0.5, 100)).toBe(65);
    expect(scaleVelocity(0, 1, 100)).toBe(1);
    const { r, hits } = rig({ velSens: 0.5 });
    r.receive([0x99, 36, 30], 0);
    expect(hits).toEqual([[0, 65]]);
  });

  it('several messages in one packet are each handled; clock bytes are not the input’s', () => {
    const { r, hits } = rig();
    r.receive([0x99, 36, 100, 0x99, 38, 80], 0);
    expect(hits).toEqual([[0, 100], [1, 80]]);
  });

  it('in the app, the velocity reaches the engine as received after scaling (applied once)', () => {
    const app = new App();
    const sent: unknown[] = [];
    app.host.send = (m) => void sent.push(m);
    app.midi.prefs.velSens = 1;
    app.midi.inject([0x99, 36, 77]);
    const hits = sent.filter((m) => (m as { type: string }).type === 'hits') as { hits: { vel: number; track: number }[] }[];
    expect(hits.length).toBe(1);
    expect(hits[0]!.hits[0]).toMatchObject({ track: 0, vel: 77 });
  });
});

describe('output: routing, notes, mute, stop, panic, devices', () => {
  it('a note on and its note off are both timestamped (note-off after the length)', () => {
    const s = sink();
    const out = new MidiOutput(() => 0);
    out.setSink(s);
    const r = new TrackRouter(out, () => 0);
    r.play(0, 10, 36, 100, 1000, 50);
    expect(s.log).toEqual([{ bytes: [0x99, 36, 100], t: 1000 }, { bytes: [0x89, 36, 0], t: 1050 }]);
  });

  it('note length: fixed ms, else the gate, else half a step', () => {
    expect(noteLength(80, 10, 125)).toBe(80);
    expect(noteLength(0, 30, 125)).toBe(30);
    expect(noteLength(undefined, undefined, 125)).toBe(62.5);
  });

  it('releasing a track (mute, routing change) ends its notes now and only its notes', () => {
    let now = 0;
    const s = sink();
    const out = new MidiOutput(() => now);
    out.setSink(s);
    const r = new TrackRouter(out, () => now);
    r.play(0, 10, 36, 100, 10, 500);
    r.play(1, 10, 38, 100, 10, 500);
    now = 100;
    s.log.length = 0;
    r.releaseTrack(0);
    expect(s.log).toEqual([{ bytes: [0x89, 36, 0], t: 100 }]);
    expect(r.pending(0)).toBe(0);
    expect(r.pending(1)).toBe(1);
  });

  it('stop ends every note and sends Stop and Song Position 0; pause keeps the position (no SPP 0)', () => {
    const c = new MidiController({ trigger: () => undefined, trackCount: () => 10, extStart: () => undefined, extStop: () => undefined, extPulse: () => undefined, extTempo: () => undefined, extLost: () => undefined, changed: () => undefined }, {}, () => 0);
    const s = sink();
    c.out.setSink(s);
    c.note(0, 10, 36, 100, 0, 1000);
    c.stop();
    expect(c.out.heldCount()).toBe(0);
    expect(s.log.map((x) => x.bytes[0])).toContain(0xfc);
    expect(s.log.some((x) => x.bytes[0] === 0xf2 && x.bytes[1] === 0 && x.bytes[2] === 0)).toBe(true);
    s.log.length = 0;
    c.stop(true);
    expect(s.log.some((x) => x.bytes[0] === 0xf2)).toBe(false);
  });

  it('panic: All Notes Off and All Sound Off on all 16 channels', () => {
    const s = sink();
    const out = new MidiOutput(() => 0);
    out.setSink(s);
    out.panic();
    expect(s.log.filter((x) => x.bytes[1] === 123).length).toBe(16);
    expect(s.log.filter((x) => x.bytes[1] === 120).length).toBe(16);
  });

  it('switching device ends notes on the old one; a vanished device is forgotten without sending', () => {
    const a = sink('A');
    const b = sink('B');
    const out = new MidiOutput(() => 0);
    out.setSink(a);
    out.noteOn(10, 36, 100, 0);
    out.setSink(b);
    expect(a.log.at(-1)!.bytes).toEqual([0x89, 36, 0]);
    out.noteOn(10, 38, 100, 0);
    out.deviceLost();
    expect(out.device).toBeNull();
    expect(out.heldCount()).toBe(0);
    expect(b.log.length).toBe(1);
  });

  it('NOTES OUT off sends nothing; no device sends nothing', () => {
    const c = new MidiController({ trigger: () => undefined, trackCount: () => 10, extStart: () => undefined, extStop: () => undefined, extPulse: () => undefined, extTempo: () => undefined, extLost: () => undefined, changed: () => undefined }, {}, () => 0);
    c.note(0, 10, 36, 100, 0, 10);
    const s = sink();
    c.out.setSink(s);
    c.prefs.notesOut = false;
    c.note(0, 10, 36, 100, 0, 10);
    expect(s.log).toEqual([]);
  });
});

/** An app whose sequencer is driven by hand: engine hits and MIDI notes are recorded. */
function appRig() {
  const app = new App();
  const engine: { track: number; vel: number }[] = [];
  app.host.send = (m) => {
    const x = m as { type: string; hits?: { track: number; vel: number }[] };
    if (x.type === 'hits') engine.push(...x.hits!);
  };
  const s = sink();
  app.midi.out.setSink(s);
  const p = app.pattern;
  for (const t of app.project.tracks) {
    p.gen[t.id] = new Array(p.steps).fill(null);
    p.edits[t.id] = {};
  }
  let now = 0;
  const out: ScheduledEvent[] = [];
  const sched = new Scheduler(app.sequence, { now: () => now, emit: (e) => out.push(...e), startDelay: 0 });
  const play = (cycles: number) => {
    app.sequence.reset();
    app.sequence.bump();
    sched.setTempo(120);
    sched.start(0);
    const end = (cycles * p.steps * 0.125) - 0.001;
    while (now < end - 0.15) {
      now += 0.025;
      sched.pump();
    }
    (app as unknown as { emitHits(e: ScheduledEvent[]): void }).emitHits(out.filter((e) => e.time < end));
  };
  return { app, engine, s, play, p };
}

describe('routing in the app: INTERNAL, MIDI, BOTH with the same musical events', () => {
  it('INTERNAL plays only the engine, MIDI only the note, BOTH both', () => {
    const { app, engine, s, play, p } = appRig();
    const [k, sn, cl] = app.project.tracks;
    setHit(p, k!.id, 0, { vel: 100 });
    setHit(p, sn!.id, 4, { vel: 100 });
    setHit(p, cl!.id, 8, { vel: 100 });
    app.project.tracks[0]!.midi.out = 'internal';
    app.project.tracks[1]!.midi.out = 'midi';
    app.project.tracks[2]!.midi.out = 'both';
    play(1);
    expect(engine.map((h) => h.track).sort()).toEqual([0, 2]);
    expect(s.log.filter((x) => isOn(x.bytes)).map((x) => x.bytes[1])).toEqual([app.project.tracks[1]!.midi.note, app.project.tracks[2]!.midi.note]);
    expect(s.log.filter((x) => isOff(x.bytes)).length).toBe(2);
  });

  it('a muted track sends no MIDI; solo leaves only the soloed track', () => {
    const { app, s, play, p } = appRig();
    const [k, sn] = app.project.tracks;
    setHit(p, k!.id, 0, { vel: 100 });
    setHit(p, sn!.id, 4, { vel: 100 });
    app.project.tracks[0]!.mix.mute = true;
    play(1);
    expect(s.log.filter((x) => isOn(x.bytes)).map((x) => x.bytes[1])).toEqual([sn!.midi.note]);
  });

  it('conditional triggers decide whether the MIDI note is sent, exactly as the engine hit', () => {
    const { app, engine, s, play, p } = appRig();
    const k = app.project.tracks[0]!;
    for (const st of [0, 4, 8, 12]) setHit(p, k.id, st, { vel: 100 });
    // step 4 on the second pass of every two only; step 8 never on the first pass
    setStepTrig(p, k.id, 4, { k: 'every', n: 2, at: 2 });
    setStepTrig(p, k.id, 8, { k: 'even' });
    play(2);
    const notes = s.log.filter((x) => isOn(x.bytes)).length;
    expect(engine.length).toBe(4 + 4 - 2); // pass 1: 0, 12; pass 2: all four
    expect(notes).toBe(engine.length);
  });

  it('sound variations and step sounds never change the MIDI note', () => {
    const { app, s, play, p } = appRig();
    const k = app.project.tracks[0]!;
    setHit(p, k.id, 0, { vel: 100, note: 7 });
    p.sounds = { [k.id]: { 0: { v: 1, voice: 2 } } };
    play(1);
    expect(s.log.filter((x) => isOn(x.bytes)).map((x) => x.bytes.slice(0, 2))).toEqual([[0x90 | (k.midi.channel - 1), k.midi.note]]);
  });

  it('changing a track’s routing ends its sounding notes; muting does too', () => {
    const { app, s } = appRig();
    const t = app.project.tracks[0]!;
    (app.midi as unknown as { now: () => number }).now = () => 0;
    app.midi.note(0, 10, 36, 100, 0, 10_000);
    s.log.length = 0;
    app.setTrackMidi(t.id, { out: 'internal' });
    expect(s.log.some((x) => isOff(x.bytes) && x.bytes[1] === 36)).toBe(true);
    app.midi.note(0, 10, 36, 100, 0, 10_000);
    s.log.length = 0;
    app.setTrackMix(t.id, { mute: true });
    expect(s.log.some((x) => isOff(x.bytes) && x.bytes[1] === 36)).toBe(true);
  });
});

describe('clock in', () => {
  it('estimates the tempo from 24 pulses per quarter', () => {
    const e = new PulseEstimator();
    const period = 60000 / (128 * 24);
    for (let i = 0; i < 48; i++) e.add(1000 + i * period + (i % 2 ? 0.4 : -0.4));
    expect(e.bpm()).toBeCloseTo(128, 0);
  });

  function clockRig(transport = true) {
    let now = 0;
    const ev: string[] = [];
    const pulses: number[] = [];
    let bpm = 0;
    const c = new ExternalClock({ start: (f, cont) => ev.push(`start ${f} ${cont}`), stop: () => ev.push('stop'), pulse: (n) => pulses.push(n), tempo: (b) => (bpm = b), lost: () => ev.push('lost'), changed: () => undefined }, () => now);
    c.transport = transport;
    c.setActive(true);
    const tick = (n: number, period: number) => {
      for (let i = 0; i < n; i++) {
        now += period;
        c.receive(0xf8, now);
      }
    };
    return { c, ev, pulses, tick, bpm: () => bpm, setNow: (t: number) => (now = t), now: () => now };
  }

  it('Start, Stop, Continue and Song Position', () => {
    const r = clockRig();
    r.tick(30, 20);
    expect(r.c.status).toBe('detected');
    expect(r.bpm()).toBeCloseTo(125, 0);
    r.c.receive(0xfa, r.now());
    r.tick(24, 20);
    expect(r.pulses.length).toBe(24);
    r.c.receive(0xfc, r.now());
    expect(r.ev).toEqual(['start 0 false', 'stop']);
    // Continue from where Stop left off
    r.c.receive(0xfb, r.now());
    expect(r.ev.at(-1)).toBe('start 24 true');
    r.c.receive(0xfc, r.now());
    // Song Position (in sixteenths) while stopped
    r.c.receiveBytes([0xf2, 8, 0], r.now());
    r.c.receive(0xfb, r.now());
    expect(r.ev.at(-1)).toBe('start 48 true');
  });

  it('with FOLLOW START/STOP off only the tempo is followed', () => {
    const r = clockRig(false);
    r.c.receive(0xfa, 0);
    r.tick(30, 20);
    expect(r.ev).toEqual([]);
    expect(r.bpm()).toBeCloseTo(125, 0);
  });

  it('detects a lost clock (freewheel) and recovers when pulses return', () => {
    const r = clockRig();
    r.tick(30, 20);
    r.c.receive(0xfa, r.now());
    r.tick(10, 20);
    r.setNow(r.now() + 800);
    r.c.watch();
    expect(r.c.status).toBe('lost');
    expect(r.ev).toContain('lost');
    expect(r.c.running).toBe(true); // still playing: freewheeling
    r.tick(30, 20);
    expect(r.c.status).toBe('running');
  });

  it('the phase lock corrects towards the master, within a few percent, and re-anchors after a jump', () => {
    const l = new PhaseLock();
    // CLATTER 8 ticks ahead at pulse 100: slow down a little
    const slow = l.correct(120, 100, 400 + 8, PPQ);
    expect(slow).toBeLessThan(120);
    expect(slow).toBeGreaterThan(120 * 0.95);
    // behind: speed up
    expect(l.correct(120, 100, 400 - 8, PPQ)).toBeGreaterThan(120);
    // far off (a loss, a master jump): re-anchor, no correction burst
    const r = l.correct(120, 100, 400 + 500, PPQ);
    expect(Math.abs(r - 120)).toBeLessThan(120 * 0.02);
    expect(Math.abs(l.error)).toBeLessThan(4);
  });

  it('closes the phase: a simulated scheduler converges on the master', () => {
    const l = new PhaseLock();
    const master = 120;
    // CLATTER starts 20 ms late, at a slightly wrong tempo
    let tick = -((0.02 * master * PPQ) / 60);
    let bpm = 121;
    const period = 60 / (master * 24);
    for (let n = 0; n < 24 * 32; n++) {
      if (n % 6 === 0) bpm = l.correct(master, n, tick, PPQ);
      tick += (period * bpm * PPQ) / 60;
    }
    expect(Math.abs(l.error)).toBeLessThan(0.5);
  });
});

describe('external clock in the app: precedence over the tempo and the curve', () => {
  it('follows the master’s tempo, suspends the tempo curve, keeps and restores the internal tempo', () => {
    const app = new App();
    app.project.tempo = 140;
    app.project.tempoAuto = { on: true, bars: 2, points: [{ bar: 0, scale: 1 }, { bar: 1, scale: 1.5 }] } as never;
    app.setClockMode('external');
    expect(app.externalTempo).toBe(false);
    // a master at 100 BPM
    const period = 60000 / (100 * 24);
    // pulses from the last 0.75 s (the follower distrusts timestamps far from now)
    const t0 = performance.now() - 30 * period;
    for (let i = 0; i < 30; i++) app.midi.clock.receive(0xf8, t0 + i * period);
    expect(app.externalTempo).toBe(true);
    expect(app.effectiveBpm()).toBeCloseTo(100, 0);
    const s = (app.scheduler as unknown as { o: { tempo: (t: number) => number | null } }).o;
    expect(s.tempo(4 * PPQ)).toBeNull(); // the curve waits
    // a tempo change (WILDCARD, the BPM box) is kept for later, the master still rules
    app.setTempo(90);
    expect(app.effectiveBpm()).toBeCloseTo(100, 0);
    expect(app.project.tempo).toBe(90);
    app.setClockMode('internal');
    expect(app.externalTempo).toBe(false);
    expect(app.scheduler.bpm).toBe(90);
    expect(s.tempo(4 * PPQ)).not.toBeNull();
  });
});

describe('clock and transport out', () => {
  function ctl(prefs: Partial<MidiPrefs>) {
    const c = new MidiController({ trigger: () => undefined, trackCount: () => 10, extStart: () => undefined, extStop: () => undefined, extPulse: () => undefined, extTempo: () => undefined, extLost: () => undefined, changed: () => undefined }, { ...defaultMidiPrefs(), ...prefs }, () => 0);
    const s = sink();
    c.out.setSink(s);
    return { c, s };
  }

  it('INTERNAL with SEND CLOCK sends F8 at the times given; OFF and EXTERNAL never do', () => {
    const a = ctl({ clock: 'internal', sendClock: true });
    a.c.clockOut([10, 20.8]);
    expect(a.s.log).toEqual([{ bytes: [0xf8], t: 10 }, { bytes: [0xf8], t: 20.8 }]);
    for (const clock of ['off', 'external'] as const) {
      const b = ctl({ clock, sendClock: true });
      b.c.clockOut([10]);
      b.c.start(10);
      expect(b.s.log).toEqual([]);
    }
  });

  it('Start from the top, Song Position then Continue from a position', () => {
    const a = ctl({ clock: 'internal' });
    a.c.start(100);
    expect(a.s.log).toEqual([{ bytes: [0xfa], t: 100 }]);
    a.s.log.length = 0;
    a.c.start(200, 96); // pulse 96 = beat 4 = sixteenth 16
    expect(a.s.log.map((x) => x.bytes)).toEqual([[0xf2, 16, 0], [0xfb]]);
  });

  it('the scheduler’s clock follows tempo automation (pulse spacing changes with the tempo)', () => {
    let now = 0;
    const times: number[] = [];
    const s = new Scheduler({ plan: () => ({ pattern: 'p', ticks: 16 * 24 }), events: () => [] }, { now: () => now, emit: () => undefined, clock: (t) => times.push(...t), tempo: (tick) => (tick < 4 * PPQ ? 120 : 60), startDelay: 0 });
    s.start(0);
    while (now < 4) {
      now += 0.025;
      s.pump();
    }
    const d0 = times[1]! - times[0]!;
    const late = times.findIndex((t) => t > 2.5);
    const d1 = times[late + 1]! - times[late]!;
    expect(d0).toBeCloseTo(60 / (120 * 24), 6);
    expect(d1).toBeCloseTo(60 / (60 * 24), 6);
  });

  it('starting from a position: nothing earlier plays, pulses and bars stay on the grid', () => {
    let now = 0;
    const out: ScheduledEvent[] = [];
    const pulses: number[] = [];
    const evs = [0, 4, 8, 12].map((st) => ({ key: `a|${st}`, tick: st * 24, track: 'a', vel: 100, pitch: 0, kind: 'source' as const, origin: st, step: st }));
    const s = new Scheduler({ plan: () => ({ pattern: 'p', ticks: 16 * 24 }), events: () => evs }, { now: () => now, emit: (e) => out.push(...e), clock: (t) => pulses.push(...t), startDelay: 0 });
    s.start(0, 6 * 24);
    while (now < 0.6) {
      now += 0.025;
      s.pump();
    }
    expect(out[0]!.tick).toBe(8 * 24);
    // the first played event is two sixteenths after the start point (120 BPM: 250 ms)
    expect(out[0]!.time).toBeCloseTo(0.25, 6);
    expect(pulses[0]).toBeCloseTo(0, 9);
  });

  it('PAUSE and CONTINUE in the app keep the position (on a sixteenth)', () => {
    const app = new App();
    app.ui.playing = true;
    (app.scheduler as unknown as { running: boolean }).running = true;
    app.scheduler.tickAt = () => 5 * 24 + 7;
    app.stop(true);
    expect(app.resumeTick).toBe(5 * 24);
    app.ui.playing = true;
    app.stop();
    expect(app.resumeTick).toBe(0);
  });
});

describe('MIDI CC out from the modulation matrix', () => {
  it('the MIDI CC destinations are in the registry for every track kind, and never chosen by the random generators', () => {
    const ids = DESTS.filter((d) => d.kind === 'midi').map((d) => d.id);
    expect(ids).toEqual(['midi.cc1', 'midi.cc2', 'midi.cc3', 'midi.cc4']);
    for (const mode of ['synth', 'sample', 'hybrid'] as const) expect(destsFor(mode, 0).some((d) => d.id === 'midi.cc1')).toBe(true);
    expect(musicalDests({ mode: 'synth', voice: 0 }).some((d) => d.startsWith('midi.'))).toBe(false);
  });

  it('quantises to the resolution', () => {
    expect(quantiseCc(64.4, 128)).toBe(64);
    expect(quantiseCc(64, 2)).toBe(127);
    expect(quantiseCc(60, 2)).toBe(0);
    expect(quantiseCc(-5, 128)).toBe(0);
    expect(quantiseCc(200, 16)).toBe(127);
  });

  function lfoRoute(dst = 'midi.cc1', amt = 0.5) {
    const lfo = { ...defaultSource('lfo1'), mode: 'free', hz: 2 } as never;
    return { sources: { lfo1: lfo }, routes: [defaultRoute('r1', 'lfo1', dst, amt)] };
  }

  it('an LFO on MIDI CC 1 sends a moving CC, rate-limited, only on change', () => {
    const r = new CcRunner();
    r.configure([lfoRoute()], 120);
    const slots: CcSlot[] = defaultCcSlots().map((s) => ({ ...s, base: 64, rate: 20 }));
    const sent: { v: number; t: number }[] = [];
    r.reset(0);
    r.run(2, slots, new Float32Array(4), (_s, _c, v, t) => sent.push({ v, t }));
    expect(sent.length).toBeGreaterThan(10);
    // never faster than 20 per second
    for (let i = 1; i < sent.length; i++) expect(sent[i]!.t - sent[i - 1]!.t).toBeGreaterThanOrEqual(0.05 - 1e-6);
    // never the same value twice in a row
    for (let i = 1; i < sent.length; i++) expect(sent[i]!.v).not.toBe(sent[i - 1]!.v);
    const vs = sent.map((x) => x.v);
    expect(Math.max(...vs) - Math.min(...vs)).toBeGreaterThan(40);
  });

  it('a still source sends one value and then nothing; a coarse resolution sends fewer messages', () => {
    const still = new CcRunner();
    still.configure([{ sources: {}, routes: [defaultRoute('r1', 'm1', 'midi.cc2', 1)] }], 120);
    const sent: number[] = [];
    still.reset(0);
    const macros = Float32Array.from([0.5, 0, 0, 0]);
    still.run(1, defaultCcSlots(), macros, (s, _c, v) => sent.push(s * 1000 + v));
    expect(sent).toEqual([1000 + 64]);
    const fine = new CcRunner();
    const coarse = new CcRunner();
    fine.configure([lfoRoute()], 120);
    coarse.configure([lfoRoute()], 120);
    let nf = 0;
    let nc = 0;
    fine.reset(0);
    coarse.reset(0);
    fine.run(2, defaultCcSlots().map((s) => ({ ...s, rate: 100 })), new Float32Array(4), () => nf++);
    coarse.run(2, defaultCcSlots().map((s) => ({ ...s, rate: 100, res: 8 })), new Float32Array(4), () => nc++);
    expect(nc).toBeLessThan(nf / 2);
  });

  it('a switched-off slot sends nothing; tracks without CC routes run nothing', () => {
    const r = new CcRunner();
    r.configure([lfoRoute(), { sources: {}, routes: [] }, undefined], 120);
    expect(usesCc(undefined)).toBe(false);
    let n = 0;
    r.reset(0);
    r.run(1, defaultCcSlots().map((s) => ({ ...s, on: false })), new Float32Array(4), () => n++);
    expect(n).toBe(0);
    const none = new CcRunner();
    none.configure([{ sources: {}, routes: [defaultRoute('r', 'lfo1', 'lxr.filter.cutoff', 1)] }], 120);
    expect(none.active).toBe(false);
  });

  it('envelopes start on the track’s hits', () => {
    const r = new CcRunner();
    r.configure([{ sources: { env1: defaultSource('env1') }, routes: [defaultRoute('r', 'env1', 'midi.cc1', 1)] }], 120);
    const sent: number[] = [];
    r.reset(0);
    r.run(0.5, defaultCcSlots().map((s) => ({ ...s, rate: 100 })), new Float32Array(4), (_s, _c, v) => sent.push(v));
    const before = sent.length;
    r.hit(0, 0.6, 127);
    r.run(1.2, defaultCcSlots().map((s) => ({ ...s, rate: 100 })), new Float32Array(4), (_s, _c, v) => sent.push(v));
    expect(sent.length).toBeGreaterThan(before + 3);
    expect(Math.max(...sent)).toBeGreaterThan(100);
  });
});
