/**
 * The SOUND workspaces in a real browser: MODULATION (sources, editor, routing matrix, presets,
 * live feedback from the engine), VARIATIONS, MIXER (ten channels), FX and KITS.
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
  await page.click('[data-test=view-sound]');
  return errors;
}

const clatter = (page: Page) => ({
  mod: () => page.evaluate(() => JSON.stringify((window as unknown as W).clatter.track.sound.mod ?? null)),
  slotMod: (i: number) => page.evaluate((n) => JSON.stringify((window as unknown as W).clatter.track.sound.variations?.[n]?.mod ?? null), i),
});

test('the seven tabs are there, one is open, and the old KIT & FX name is gone', async ({ page }) => {
  const errors = await boot(page);
  const labels = await page.locator('.sound-main .wstab').allTextContents();
  expect(labels).toEqual(['SYNTH', 'SAMPLE', 'MODULATION', 'VARIATIONS', 'MIXER', 'FX', 'KITS']);
  await page.click('[data-test=sound-tab-modulation]');
  await expect(page.locator('.sndpane.show')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('MODULATION: a route is added from the matrix, edited, played and removed; undo restores it', async ({ page }) => {
  const errors = await boot(page);
  const c = clatter(page);
  await page.click('[data-test=sound-tab-modulation]');
  expect(await c.mod()).toBe('null');
  await page.click('[data-test=mod-add-route]');
  expect(JSON.parse(await c.mod())).toMatchObject({ routes: [{ src: 'lfo1', on: true }] });
  // the source was activated with defaults and is shown in the editor
  await expect(page.locator('.srcrow[data-source=lfo1]')).toHaveClass(/on/);
  // edit a route amount through the app, then through undo
  await page.evaluate(() => {
    const a = (window as unknown as W).clatter;
    a.setRoute('r1', { amt: -0.5 });
  });
  expect(JSON.parse(await c.mod()).routes[0].amt).toBe(-0.5);
  await page.keyboard.press('Control+z');
  expect(JSON.parse(await c.mod()).routes[0].amt).not.toBe(-0.5);
  await page.locator('.route [title="Remove this route"]').first().click();
  expect(JSON.parse(await c.mod()).routes).toHaveLength(0);
  expect(errors).toEqual([]);
});

test('MODULATION: presets load, save and generate; only destinations of the track are listed', async ({ page }) => {
  const errors = await boot(page);
  await page.click('[data-test=sound-tab-modulation]');
  await page.evaluate(() => (window as unknown as W).clatter.loadModPreset('f:wobble'));
  const m = JSON.parse(await clatter(page).mod());
  expect(m.routes.length).toBeGreaterThan(0);
  const dests = await page.evaluate(() => (window as unknown as W).clatter.modDestinations().map((d) => d.id));
  expect(dests.every((d) => !d.startsWith('smp.'))).toBe(true); // a synth track has no sample destinations
  await page.evaluate(() => (window as unknown as W).clatter.generateModulation(0.6));
  const g = JSON.parse(await clatter(page).mod());
  expect(g.routes.length).toBeGreaterThan(0);
  await page.evaluate(() => (window as unknown as W).clatter.saveModPreset('E2E PRESET'));
  expect(await page.evaluate(() => (window as unknown as W).clatter.modLibrary.list().map((p) => p.name))).toContain('E2E PRESET');
  await page.reload();
  await page.waitForSelector('#transport');
  expect(await page.evaluate(() => (window as unknown as W).clatter.modLibrary.list().map((p) => p.name))).toContain('E2E PRESET');
  expect(errors).toEqual([]);
});

test('MODULATION: a variation stores only its differences, and the live engine feeds the editor', async ({ page }) => {
  const errors = await boot(page);
  const c = clatter(page);
  await page.click('[data-test=sound-tab-modulation]');
  await page.evaluate(() => (window as unknown as W).clatter.loadModPreset('f:wobble'));
  await page.evaluate(() => {
    const a = (window as unknown as W).clatter;
    a.createVariation(a.track.id, 0);
    a.setSlot(0);
    a.setRoute('r1', { amt: -0.7 });
  });
  const patch = JSON.parse(await c.slotMod(0));
  expect(patch.routes.r1).toEqual({ amt: -0.7 });
  expect(patch.sources).toBeUndefined();
  // the base is untouched
  expect(JSON.parse(await c.mod()).routes[0].amt).not.toBe(-0.7);
  // play: the engine reports the watched track's modulation
  await page.click('[data-test=play]');
  await expect.poll(() => page.evaluate(() => !!(window as unknown as W).clatter.meters?.mod), { timeout: 8000 }).toBe(true);
  await expect(page.locator('.livev')).toContainText('OUT');
  await page.keyboard.press('Space');
  expect(errors).toEqual([]);
});

test('VARIATIONS: the table compares BASE with A-D and counts overrides and steps', async ({ page }) => {
  const errors = await boot(page);
  await page.click('[data-test=sound-tab-variations]');
  await expect(page.locator('[data-test=var-table] tbody tr')).toHaveCount(5);
  await page.evaluate(() => {
    const a = (window as unknown as W).clatter;
    a.createVariation(a.track.id, 2);
    a.setSlot(2);
    a.setEditedParam(37, 99);
  });
  const row = page.locator('[data-test=var-row-C]');
  await expect(row).toContainText('C');
  await expect(row.locator('td').nth(1)).toHaveText('1');
  await expect(page.locator('[data-test=var-diff]')).toContainText('→');
  expect(errors).toEqual([]);
});

test('MIXER: ten channels are visible, with processing, bus and master', async ({ page }) => {
  const errors = await boot(page);
  await page.click('[data-test=sound-tab-mixer]');
  const strips = page.locator('[data-test=mixer-strips] .strip:not(.master)');
  await expect(strips).toHaveCount(10);
  for (let i = 0; i < 10; i++) await expect(strips.nth(i)).toBeInViewport();
  await expect(page.locator('[data-test=channel-proc]')).toBeVisible();
  await expect(page.locator('[data-test=bus-proc]')).toBeVisible();
  await expect(page.locator('[data-test=master-proc]')).toBeVisible();
  await expect(page.locator('[data-test=signal-path]')).toContainText('LIMITER');
  // channel processing is per track and persisted
  await page.evaluate(() => {
    const a = (window as unknown as W).clatter;
    a.patchChannelFx(a.track.id, 'sat', { on: true, drive: 0.7 });
  });
  expect(await page.evaluate(() => (window as unknown as W).clatter.track.mix.fx?.sat.on)).toBe(true);
  expect(await page.evaluate(() => (window as unknown as W).clatter.project.tracks[1]!.mix.fx)).toBeUndefined();
  expect(errors).toEqual([]);
});

test('FX and KITS: the LXR FX bus is its own tab; the three kit kinds sit side by side', async ({ page }) => {
  const errors = await boot(page);
  await page.click('[data-test=sound-tab-fx]');
  await expect(page.locator('[data-test=lxr-fx]')).toBeVisible();
  await page.click('[data-test=sound-tab-kits]');
  for (const k of ['synth', 'set', 'full']) await expect(page.locator(`[data-test=kit-card-${k}]`)).toBeVisible();
  await expect(page.locator('[data-test=generate-kit]')).toBeVisible();
  expect(errors).toEqual([]);
});
