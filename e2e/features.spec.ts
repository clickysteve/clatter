/** Export dialog, EXPORT beside UNDO, AMFAS palettes, conditional triggers and WILDCARD in a real browser. */
import { expect, test, type Page } from '@playwright/test';

type W = { clatter: import('../src/app/app').App };

async function bootAt(page: Page, scale: number | null = null): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('./');
  await page.evaluate((x) => {
    localStorage.clear();
    if (x !== null) localStorage.setItem('clatter.prefs', JSON.stringify({ uiScale: x }));
  }, scale);
  await page.goto('./');
  await page.waitForSelector('#transport', { timeout: 30_000 });
  return errors;
}

test('EXPORT sits directly beside UNDO at every scale and width', async ({ page }) => {
  for (const [scale, width] of [[75, 1280], [90, 1280], [125, 1280], [200, 1280], [90, 900], [125, 800]] as const) {
    await page.setViewportSize({ width, height: 800 });
    await bootAt(page, scale);
    const b = await page.evaluate(() => {
      const r = (e: Element | null) => (e ? e.getBoundingClientRect().toJSON() : null);
      const ex = document.querySelector('[data-test=export]');
      const un = [...document.querySelectorAll('#transport button')].find((x) => x.textContent === 'UNDO') ?? null;
      return { ex: r(ex), un: r(un), sw: document.documentElement.scrollWidth, iw: window.innerWidth, adjacent: !!ex && ex.nextElementSibling === un };
    });
    expect(b.ex, `${scale}%/${width}`).not.toBeNull();
    expect(b.adjacent, `${scale}%/${width}: EXPORT is the element before UNDO`).toBe(true);
    expect(b.ex!.width).toBeGreaterThan(20);
    expect(b.sw, `${scale}%/${width}: no horizontal page scroll`).toBeLessThanOrEqual(b.iw);
  }
});

test('the export dialog offers 4 bars and no tail, closes at once and delivers a file', async ({ page }) => {
  const errors = await bootAt(page);
  await page.click('[data-test=export]');
  await expect(page.locator('.dialog')).toBeVisible();
  expect(await page.locator('[data-test=export-bars] input, [data-test=export-bars]').first().evaluate((e) => (e as HTMLInputElement).value ?? e.textContent)).toContain('4');
  expect(await page.evaluate(() => [(window as unknown as W).clatter.prefs.exportBars, (window as unknown as W).clatter.prefs.exportTail])).toEqual([4, 0]);
  const dl = page.waitForEvent('download', { timeout: 45_000 });
  await page.locator('.dialog').getByRole('button', { name: 'EXPORT' }).click();
  await expect(page.locator('.dialog')).toHaveCount(0);
  const file = await dl;
  expect(file.suggestedFilename()).toMatch(/\.wav$/i);
  expect(errors).toEqual([]);
});

test('AMFAS and AMFAS INVERT can be chosen', async ({ page }) => {
  await bootAt(page);
  for (const [name, paper] of [['AMFAS', '#fafafa'], ['AMFAS INVERT', '#000000']] as const) {
    await page.locator('#menubar .menu', { hasText: 'VIEW' }).click();
    await page.locator('.dropdown .item', { hasText: 'Palette' }).click();
    await page.locator('.dialog').getByText(name, { exact: true }).first().click();
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--paper').trim())).toBe(paper);
    await page.getByRole('button', { name: 'DONE' }).click();
  }
});

test('a conditional trigger can be set and WILDCARD is one undo step', async ({ page }) => {
  const errors = await bootAt(page);
  await page.click('[data-test=ws-trigger]');
  await expect(page.locator('[data-test=step-trigger]')).toBeVisible();
  await page.evaluate(() => {
    const a = (window as unknown as W).clatter;
    a.select({ track: a.ui.track, step: 0 } as never);
  });
  await page.click('[data-test=ws-wildcard]');
  await expect(page.locator('[data-test=wildcard-card]')).toBeVisible();
  // key order is not identity: compare with sorted keys
  const snap = () =>
    page.evaluate(() => {
      const sort = (v: unknown): unknown => (Array.isArray(v) ? v.map(sort) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, sort(x)])) : v);
      return JSON.stringify(sort({ ...(window as unknown as W).clatter.project, wildcard: undefined, snapshots: [] }));
    });
  const before = await snap();
  await page.click('[data-test=wildcard-go]');
  await expect.poll(snap, { timeout: 15_000 }).not.toEqual(before);
  await page.keyboard.press('Control+z');
  expect(await snap()).toEqual(before);
  expect(errors).toEqual([]);
});
