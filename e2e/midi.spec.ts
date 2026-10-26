/**
 * MIDI in a real browser, against a VIRTUAL Web MIDI device (navigator.requestMIDIAccess replaced
 * before the page loads): no hardware is involved. The virtual output records every message with
 * its timestamp; the virtual input lets the test play notes, CCs and clock into CLATTER.
 *
 * Also the KITS workspace's generation controls (CHARACTER, WILDNESS, GENERATE, MUTATE, NEW VOICE).
 */
import { expect, test, type Page } from '@playwright/test';

type W = { clatter: import('../src/app/app').App; __midi: { sent: { data: number[]; t: number }[]; play(data: number[]): void; unplug(kind: 'input' | 'output'): void; plug(kind: 'input' | 'output'): void } };

/** Installs a virtual MIDI access with one input ("VIRTUAL PADS") and one output ("VIRTUAL DRUMS"). */
function virtualMidi(): void {
  const sent: { data: number[]; t: number }[] = [];
  const listeners: ((e: unknown) => void)[] = [];
  const mkPort = (type: 'input' | 'output', id: string, name: string) => {
    const p: Record<string, unknown> = { type, id, name, manufacturer: 'TEST', state: 'connected', connection: 'open', onmidimessage: null };
    if (type === 'output') {
      p.send = (data: number[], t?: number) => sent.push({ data: Array.from(data), t: t ?? performance.now() });
      p.clear = () => undefined;
    }
    return p;
  };
  const input = mkPort('input', 'in-1', 'VIRTUAL PADS');
  const output = mkPort('output', 'out-1', 'VIRTUAL DRUMS');
  const access: Record<string, unknown> = { inputs: new Map([['in-1', input]]), outputs: new Map([['out-1', output]]), onstatechange: null, sysexEnabled: false };
  const change = (port: Record<string, unknown>) => {
    const fn = access.onstatechange as ((e: unknown) => void) | null;
    fn?.({ port });
    for (const l of listeners) l({ port });
  };
  (navigator as unknown as { requestMIDIAccess: () => Promise<unknown> }).requestMIDIAccess = () => Promise.resolve(access);
  (window as unknown as W).__midi = {
    sent,
    play: (data: number[]) => {
      const fn = input.onmidimessage as ((e: unknown) => void) | null;
      fn?.({ data: Uint8Array.from(data), timeStamp: performance.now() });
    },
    unplug: (kind) => {
      const p = kind === 'input' ? input : output;
      p.state = 'disconnected';
      change(p);
    },
    plug: (kind) => {
      const p = kind === 'input' ? input : output;
      p.state = 'connected';
      change(p);
    },
  };
}

async function boot(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(virtualMidi);
  await page.goto('./');
  await page.evaluate(() => localStorage.clear());
  await page.goto('./');
  await page.waitForSelector('#transport', { timeout: 30_000 });
  return errors;
}


async function openMidi(page: Page): Promise<void> {
  await page.locator('#menubar .menu', { hasText: 'MIDI' }).click();
  await page.locator('.dropdown .item', { hasText: 'MIDI settings' }).click();
  await expect(page.locator('[data-test=midi-dialog]')).toBeVisible();
}

test('the MIDI window: enable, choose devices, five compact sections', async ({ page }) => {
  const errors = await boot(page);
  await openMidi(page);
  await page.click('[data-test=midi-enable]');
  await expect.poll(() => page.evaluate(() => (window as unknown as W).clatter.midi.state)).toBe('ready');
  for (const t of ['INPUT', 'OUTPUT', 'CLOCK & TRANSPORT', 'TRACK ROUTING', 'MIDI LEARN']) await expect(page.locator('.mididlg .gtitle', { hasText: t }).first()).toBeVisible();
  // choose the virtual devices through the pop-ups
  await page.click('[data-test=midi-output]');
  await page.locator('.msel-item', { hasText: 'VIRTUAL DRUMS' }).click();
  await page.click('[data-test=midi-input]');
  await page.locator('.msel-item', { hasText: 'ALL INPUTS' }).click();
  const st = await page.evaluate(() => {
    const m = (window as unknown as W).clatter.midi;
    return { out: m.outputName, input: m.prefs.input, listening: m.access.listening };
  });
  expect(st.out).toBe('VIRTUAL DRUMS');
  expect(st.input).toBe('*');
  expect(st.listening).toEqual(['VIRTUAL PADS']);
  // compact: the window fits the viewport (it scrolls inside, the page never sprawls)
  const box = await page.locator('[data-test=midi-dialog]').boundingBox();
  expect(box!.height).toBeLessThanOrEqual(800);
  // the device preference is saved per browser, not in the project
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('clatter.prefs') ?? '{}').midi);
  expect(saved.out).toEqual({ id: 'out-1', name: 'VIRTUAL DRUMS' });
  await page.screenshot({ path: 'test-results/midi-settings.png' });
  expect(errors).toEqual([]);
});

test('MIDI Learn maps a pad to a track; the pad plays it; the monitor shows it', async ({ page }) => {
  const errors = await boot(page);
  await openMidi(page);
  await page.click('[data-test=midi-enable]');
  await page.click('[data-test=midi-input]');
  await page.locator('.msel-item', { hasText: 'VIRTUAL PADS' }).click();
  await page.click('[data-test=learn-2]');
  await page.evaluate(() => (window as unknown as W).__midi.play([0x99, 60, 100]));
  await expect.poll(() => page.evaluate(() => (window as unknown as W).clatter.midi.prefs.inMap[2])).toBe(60);
  await expect(page.locator('[data-test=in-note-2]')).toHaveText(/C3 60/);
  // the learned pad now plays track 3 (and the note shows in the monitor)
  await page.evaluate(() => (window as unknown as W).__midi.play([0x99, 60, 90]));
  await expect(page.locator('[data-test=midi-monitor]')).toContainText('→ T3');
  // a note nobody has is UNMAPPED (no General MIDI assumption)
  await page.evaluate(() => (window as unknown as W).__midi.play([0x99, 99, 90]));
  await expect(page.locator('[data-test=midi-monitor]')).toContainText('UNMAPPED');
  // the channel filter
  await page.evaluate(() => (window as unknown as W).clatter.midi.update({ inChannel: 5 }));
  await page.evaluate(() => (window as unknown as W).__midi.play([0x99, 60, 90]));
  await expect(page.locator('[data-test=midi-monitor]')).toContainText('FILTERED');
  expect(errors).toEqual([]);
});

test('sequencing external MIDI: per-track routing, note-offs, mute, stop and panic', async ({ page }) => {
  const errors = await boot(page);
  await page.evaluate(async () => {
    const a = (window as unknown as W).clatter;
    await a.midi.enable();
    a.midi.selectOutput({ id: 'out-1', name: 'VIRTUAL DRUMS' });
    // track 1 (kick) to MIDI only, the rest INTERNAL; kick on channel 10 note 36
    a.project.tracks.forEach((t, i) => a.setTrackMidi(t.id, { out: i === 0 ? 'midi' : 'internal', channel: 10, note: 36 + i }));
  });
  await page.evaluate(() => void (window as unknown as W).clatter.play());
  await page.waitForTimeout(2200);
  const r = await page.evaluate(() => {
    const m = (window as unknown as W).__midi;
    const ons = m.sent.filter((x) => (x.data[0]! & 0xf0) === 0x90);
    const offs = m.sent.filter((x) => (x.data[0]! & 0xf0) === 0x80);
    return { ons: ons.map((x) => x.data), offs: offs.length, onT: ons.map((x) => x.t), offT: offs.map((x) => x.t) };
  });
  expect(r.ons.length).toBeGreaterThan(1);
  // only the MIDI-routed track sends: kick, channel 10, note 36
  for (const d of r.ons) expect(d.slice(0, 2)).toEqual([0x99, 36]);
  expect(r.offs).toBeGreaterThanOrEqual(r.ons.length - 1);
  // stop: everything ends, Stop is sent only with SEND TRANSPORT (on by default) in INTERNAL
  await page.evaluate(() => (window as unknown as W).clatter.stop());
  const after = await page.evaluate(() => {
    const m = (window as unknown as W).__midi;
    return { stop: m.sent.some((x) => x.data[0] === 0xfc), held: (window as unknown as W).clatter.midi.out.heldCount() };
  });
  expect(after.stop).toBe(true);
  expect(after.held).toBe(0);
  // panic: All Notes Off on 16 channels
  await page.evaluate(() => (window as unknown as W).clatter.panic());
  const cc123 = await page.evaluate(() => (window as unknown as W).__midi.sent.filter((x) => (x.data[0]! & 0xf0) === 0xb0 && x.data[1] === 123).length);
  expect(cc123).toBe(16);
  expect(errors).toEqual([]);
});

test('clock out follows the tempo; external clock takes over the tempo and suspends the curve', async ({ page }) => {
  const errors = await boot(page);
  await page.evaluate(async () => {
    const a = (window as unknown as W).clatter;
    await a.midi.enable();
    a.midi.selectOutput({ id: 'out-1', name: 'VIRTUAL DRUMS' });
    a.midi.selectInput('*');
    a.midi.update({ sendClock: true });
    a.setTempo(150);
    await a.play();
  });
  await page.waitForTimeout(1500);
  const clk = await page.evaluate(() => {
    const s = (window as unknown as W).__midi.sent.filter((x) => x.data[0] === 0xf8).map((x) => x.t);
    const d: number[] = [];
    for (let i = 1; i < s.length; i++) d.push(s[i]! - s[i - 1]!);
    d.sort((a, b) => a - b);
    return { n: s.length, median: d[Math.floor(d.length / 2)] ?? 0, start: (window as unknown as W).__midi.sent.some((x) => x.data[0] === 0xfa) };
  });
  expect(clk.start).toBe(true);
  expect(clk.n).toBeGreaterThan(40);
  expect(clk.median).toBeCloseTo(60000 / (150 * 24), 0);
  await page.evaluate(() => (window as unknown as W).clatter.stop());

  // EXTERNAL: a virtual master at 100 BPM; Start begins playback, the tempo follows
  await page.evaluate(() => (window as unknown as W).clatter.setClockMode('external'));
  await page.evaluate(() => {
    const m = (window as unknown as W).__midi;
    const period = 60000 / (100 * 24);
    let n = 0;
    (window as unknown as { __clk: number }).__clk = window.setInterval(() => {
      m.play([0xf8]);
      if (++n === 24) m.play([0xfa]);
    }, period) as unknown as number;
  });
  await expect.poll(() => page.evaluate(() => (window as unknown as W).clatter.ui.playing), { timeout: 6000 }).toBe(true);
  await page.waitForTimeout(2000);
  const ext = await page.evaluate(() => {
    const a = (window as unknown as W).clatter;
    return { bpm: a.effectiveBpm(), project: a.project.tempo, following: a.externalTempo, label: document.querySelector('[data-test=ext-tempo]')?.textContent ?? '' };
  });
  expect(ext.following).toBe(true);
  // setInterval jitter in a headless browser: within a few percent of the master
  expect(Math.abs(ext.bpm - 100)).toBeLessThan(6);
  // the project's own tempo is kept for later
  expect(ext.project).toBe(150);
  expect(ext.label).toContain('EXT');
  // master Stop stops CLATTER
  await page.evaluate(() => (window as unknown as W).__midi.play([0xfc]));
  await expect.poll(() => page.evaluate(() => (window as unknown as W).clatter.ui.playing)).toBe(false);
  // back to INTERNAL: the project's tempo again
  await page.evaluate(() => {
    window.clearInterval((window as unknown as { __clk: number }).__clk);
    (window as unknown as W).clatter.setClockMode('internal');
  });
  expect(await page.evaluate(() => (window as unknown as W).clatter.effectiveBpm())).toBe(150);
  expect(errors).toEqual([]);
});

test('a disconnected output is handled and comes back', async ({ page }) => {
  const errors = await boot(page);
  await page.evaluate(async () => {
    const a = (window as unknown as W).clatter;
    await a.midi.enable();
    a.midi.selectOutput({ id: 'out-1', name: 'VIRTUAL DRUMS' });
  });
  await page.evaluate(() => (window as unknown as W).__midi.unplug('output'));
  expect(await page.evaluate(() => (window as unknown as W).clatter.midi.outputMissing)).toBe(true);
  await page.evaluate(() => (window as unknown as W).__midi.plug('output'));
  await expect.poll(() => page.evaluate(() => (window as unknown as W).clatter.midi.outputName)).toBe('VIRTUAL DRUMS');
  expect(errors).toEqual([]);
});

test('KITS: character, wildness, generate, mutate and a profile override on one voice', async ({ page }) => {
  const errors = await boot(page);
  await page.evaluate(() => {
    const a = (window as unknown as W).clatter;
    a.setView('sound');
    a.setSoundTab('kits');
  });
  await expect(page.locator('[data-test=kit-wildness]')).toBeVisible();
  await expect(page.locator('[data-test=kit-wildness]')).toContainText('30%');
  await page.click('[data-test=kit-character]');
  await page.locator('.msel-item', { hasText: 'INDUSTRIAL' }).click();
  await page.click('[data-test=generate-kit]');
  await expect.poll(() => page.evaluate(() => (window as unknown as W).clatter.project.kit.gen?.character), { timeout: 20_000 }).toBe('industrial');
  const before = await page.evaluate(() => (window as unknown as W).clatter.project.kit.synth.params.slice());
  await page.click('[data-test=mutate-kit]');
  await expect.poll(() => page.evaluate(() => (window as unknown as W).clatter.project.kit.gen?.op), { timeout: 20_000 }).toBe('mutate');
  const after = await page.evaluate(() => (window as unknown as W).clatter.project.kit.synth.params.slice());
  expect(after).not.toEqual(before);
  // a cymbal on the kick voice
  await page.click('[data-test=voice-profile-0]');
  await page.locator('.msel-item', { hasText: 'CYMBAL' }).click();
  await page.click('[data-test=new-voice-0]');
  await expect.poll(() => page.evaluate(() => (window as unknown as W).clatter.project.kit.gen?.op), { timeout: 20_000 }).toBe('voice');
  expect(await page.evaluate(() => (window as unknown as W).clatter.project.kit.gen?.profiles[0])).toBe('cymbal');
  // undo is one step per operation
  await page.evaluate(() => (window as unknown as W).clatter.undo());
  expect(await page.evaluate(() => (window as unknown as W).clatter.project.kit.synth.params)).toEqual(after);
  await page.screenshot({ path: 'test-results/kits-generation.png' });
  expect(errors).toEqual([]);
});
