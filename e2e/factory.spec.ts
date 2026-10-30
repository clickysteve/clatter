/**
 * SAMPLE FACTORY in a real browser: generate a batch through the engine, curate, and export a pack
 * without the kit or the project changing.
 */
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

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
  await page.click('[data-test=sound-tab-factory]');
  return errors;
}

const project = (page: Page) => page.evaluate(() => JSON.stringify((window as unknown as W).clatter.project));

test('FACTORY: generate, audition, curate and export a pack; the project is never touched', async ({ page }) => {
  const errors = await boot(page);
  await expect(page.locator('[data-test=factory-list] .fempty')).toBeVisible();
  const before = await project(page);
  await page.fill('[data-test=factory-seed]', 'velvet-orbit');
  await page.press('[data-test=factory-seed]', 'Enter');
  // 16 mixed sounds
  await page.click('[data-test=factory-count]');
  await page.locator('.msel-item', { hasText: /^16$/ }).click();
  await page.click('[data-test=factory-generate]');
  await expect(page.locator('[data-test=factory-row]')).toHaveCount(16, { timeout: 60_000 });
  await expect(page.locator('[data-test=factory-progress]')).toContainText('16 SOUNDS', { timeout: 60_000 });
  await expect(page.locator('[data-test=factory-row] .fplay:not([disabled])')).toHaveCount(16);
  await expect(page.locator('[data-test=factory-seed]')).toHaveValue('velvet-orbit');
  // audition
  await page.locator('[data-test=factory-play]').first().click();
  await expect(page.locator('.frow.playing')).toHaveCount(1, { timeout: 15_000 });
  // favourite and select
  await page.locator('[data-test=factory-fav]').nth(1).click();
  await page.locator('[data-test=factory-check]').nth(0).click();
  await page.locator('[data-test=factory-check]').nth(1).click();
  await expect(page.locator('.frow.sel')).toHaveCount(2);
  // sort and filter
  await page.click('[data-test=factory-sort]');
  await page.locator('.msel-item', { hasText: 'BRIGHTNESS' }).click();
  await page.click('[data-test=factory-filter-fav]');
  await expect(page.locator('[data-test=factory-row]')).toHaveCount(1);
  await page.click('[data-test=factory-filter-fav]');
  await expect(page.locator('[data-test=factory-row]')).toHaveCount(16);
  // export the selection
  const dl = page.waitForEvent('download', { timeout: 60_000 });
  await page.click('[data-test=factory-export]');
  const file = await dl;
  expect(file.suggestedFilename()).toMatch(/sample-pack.*\.zip$/);
  const path = await file.path();
  const bytes = readFileSync(path!);
  expect([...bytes.subarray(0, 4)]).toEqual([0x50, 0x4b, 3, 4]);
  expect(bytes.toString('latin1')).toContain('pack.json');
  expect(bytes.toString('latin1')).toMatch(/CLATTER_[A-Z]+_[A-Za-z0-9]+_\d{3}\.wav/);
  expect(await project(page)).toBe(before);
  // CLEAR keeps the favourite, CLEAR ALL empties
  await page.click('[data-test=factory-clear]');
  await expect(page.locator('[data-test=factory-row]')).toHaveCount(1);
  await page.click('[data-test=factory-clear-all]');
  await expect(page.locator('[data-test=factory-row]')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('FACTORY: cancel a batch, then retry; SEND TO KIT is one undo step', async ({ page }) => {
  const errors = await boot(page);
  const kit = () => page.evaluate(() => JSON.stringify((window as unknown as W).clatter.project.kit.synth));
  const before = await kit();
  await page.click('[data-test=factory-instrument]');
  await page.locator('.msel-item', { hasText: /^KICK$/ }).click();
  await page.click('[data-test=factory-count]');
  await page.locator('.msel-item', { hasText: /^32$/ }).click();
  await page.click('[data-test=factory-generate]');
  await expect(page.locator('[data-test=factory-cancel]')).toBeEnabled();
  await page.click('[data-test=factory-cancel]');
  await expect(page.locator('[data-test=factory-generate]')).toBeEnabled({ timeout: 30_000 });
  const rendered = await page.locator('[data-test=factory-row] .fplay:not([disabled])').count();
  expect(rendered).toBeLessThan(32);
  if (rendered < 32) {
    await expect(page.locator('[data-test=factory-retry]')).toBeEnabled();
    await page.click('[data-test=factory-retry]');
  }
  await expect(page.locator('[data-test=factory-row] .fplay:not([disabled])')).toHaveCount(32, { timeout: 90_000 });
  expect(await kit()).toBe(before);
  await page.locator('[data-test=factory-send]').first().click();
  await page.click('[data-test=factory-slot-0]');
  expect(await kit()).not.toBe(before);
  await page.keyboard.press('Control+z');
  expect(await kit()).toBe(before);
  expect(errors).toEqual([]);
});
