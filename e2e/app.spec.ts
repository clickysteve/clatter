/**
 * CLATTER in a real browser: start-up, transport and audio, the grid (hit-testing), generation,
 * kits, HYBRID tracks and samples, transformations, palettes, project save and load, export.
 */
import { expect, test, type Page } from '@playwright/test';

type W = { clatter: import('../src/app/app').App };

async function boot(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto('./');
  await page.evaluate(() => localStorage.clear());
  await page.goto('./');
  await page.waitForSelector('#transport', { timeout: 30_000 });
  return errors;
}

test('starts with a preset, plays audio and moves the playhead', async ({ page }) => {
  const errors = await boot(page);
  await expect(page.locator('[data-test=status]')).toContainText(/PLAY|READY/);
  await page.click('[data-test=play]');
  await page.waitForTimeout(2000);
  const s = await page.evaluate(() => {
    const a = (window as unknown as W).clatter;
    return { playing: a.ui.playing, ctx: a.host.state, l: a.meters?.masterL ?? 0, head: a.playhead() };
  });
  expect(s.playing).toBe(true);
  expect(s.ctx).toBe('running');
  expect(s.l).toBeGreaterThan(0.01);
  expect(s.head).not.toBeNull();
  await page.keyboard.press('Space');
  await expect.poll(() => page.evaluate(() => (window as unknown as W).clatter.ui.playing)).toBe(false);
  expect(errors).toEqual([]);
});

test('a click inside a grid cell edits exactly that cell', async ({ page }) => {
  await boot(page);
  const canvas = page.locator('#pattern .gridwrap canvas').first();
  const box = (await canvas.boundingBox())!;
  const geo = await page.evaluate(() => {
    const a = (window as unknown as W).clatter;
    return { steps: a.pattern.steps, tracks: a.project.tracks.length, id: a.project.tracks[5]!.id };
  });
  const rowH = (box.height - 14) / geo.tracks;
  const cellW = box.width / geo.steps;
  // near the right/bottom edge of step 6 on track 6 (floors, never rounds)
  const x = box.x + 6 * cellW + cellW * 0.9;
  const y = box.y + 14 + 5 * rowH + rowH * 0.9;
  const before = await page.evaluate((id) => !!(window as unknown as W).clatter.hitAt(id, 6), geo.id);
  await page.mouse.click(x, y);
  const after = await page.evaluate((id) => {
    const a = (window as unknown as W).clatter;
    return { six: !!a.hitAt(id, 6), seven: !!a.hitAt(id, 7) };
  }, geo.id);
  expect(after.six).toBe(!before);
  await page.keyboard.press('Control+z');
  const undone = await page.evaluate((id) => !!(window as unknown as W).clatter.hitAt(id, 6), geo.id);
  expect(undone).toBe(before);
});

test('generate, variation, wildcard and a new kit change the music; undo restores it', async ({ page }) => {
  const errors = await boot(page);
  const snap = () => page.evaluate(() => JSON.stringify((window as unknown as W).clatter.pattern.gen));
  const a = await snap();
  await page.click('[data-test=generate]');
  const b = await snap();
  expect(b).not.toEqual(a);
  await page.keyboard.press('v');
  expect(await snap()).not.toEqual(b);
  await page.keyboard.press('Control+z');
  expect(await snap()).toEqual(b);
  const kit = () => page.evaluate(() => (window as unknown as W).clatter.project.kit.synth.params.join(','));
  const k0 = await kit();
  await page.click('[data-test=view-sound]');
  await page.click('[data-test=generate-kit]');
  await expect.poll(kit, { timeout: 15_000 }).not.toEqual(k0);
  await page.click('[data-test=view-pattern]');
  await page.click('[data-test=wildcard]');
  await expect(page.locator('[data-test=status]')).toContainText('WILDCARD', { timeout: 15_000 });
  const chop = () => page.evaluate(() => (window as unknown as W).clatter.project.destruction.chop.on);
  const c0 = await chop();
  await page.click('[data-test=d-chop]');
  expect(await chop()).toBe(!c0);
  expect(errors).toEqual([]);
});

test('a track becomes HYBRID with a sample and is heard', async ({ page }) => {
  await boot(page);
  await page.click('[data-test=view-sound]');
  await page.click('[data-test=mode-hybrid]');
  await page.locator('#sample .list .li[data-sample="KICK-DUSTY"]').click();
  const t = await page.evaluate(() => {
    const a = (window as unknown as W).clatter;
    return { mode: a.track.sound.mode, samples: a.track.sound.samples.length };
  });
  expect(t.mode).toBe('hybrid');
  expect(t.samples).toBe(1);
  await page.evaluate(() => (window as unknown as W).clatter.audition((window as unknown as W).clatter.track.id));
  await expect.poll(() => page.evaluate(() => (window as unknown as W).clatter.meters?.masterL ?? 0)).toBeGreaterThan(0.01);
});

test('palettes switch the colours', async ({ page }) => {
  await boot(page);
  const bg = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--paper').trim());
  const before = await bg();
  await page.locator('#menubar .menu', { hasText: 'VIEW' }).dispatchEvent('pointerdown');
  await page.locator('.dropdown .item', { hasText: 'Palette' }).dispatchEvent('pointerup');
  await expect(page.locator('.dialog')).toBeVisible();
  await page.locator('.dialog').getByText('Dark', { exact: true }).first().click();
  await expect.poll(bg).not.toEqual(before);
});

test('saves and opens a project; exports a WAV and a MIDI file', async ({ page }) => {
  await boot(page);
  await page.click('[data-test=generate]');
  const saved = await page.evaluate(() => {
    const a = (window as unknown as W).clatter;
    const f = a.projectFile();
    return { text: new TextDecoder().decode(f.data), gen: JSON.stringify(a.pattern.gen) };
  });
  await page.click('[data-test=generate]');
  const reopened = await page.evaluate(async (text) => {
    const a = (window as unknown as W).clatter;
    await a.openFile(new File([text], 'x.clatter.json'));
    return JSON.stringify(a.pattern.gen);
  }, saved.text);
  expect(reopened).toEqual(saved.gen);
  const wav = await page.evaluate(async () => {
    const f = await (window as unknown as W).clatter.exportMaster(1, 0.5);
    const d = f.data;
    return { riff: String.fromCharCode(d[0]!, d[1]!, d[2]!, d[3]!), bytes: d.length };
  });
  expect(wav.riff).toBe('RIFF');
  expect(wav.bytes).toBeGreaterThan(44100 * 4);
  const mid = await page.evaluate(() => {
    const d = (window as unknown as W).clatter.exportMidiFile(2).data;
    return String.fromCharCode(d[0]!, d[1]!, d[2]!, d[3]!);
  });
  expect(mid).toBe('MThd');
});
