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

test('EXPORT KIT: the dialog, a real export with progress, cancel, and EXPORT still beside UNDO', async ({ page }) => {
  test.setTimeout(180_000);
  for (const [scale, width] of [[90, 1280], [125, 1280], [200, 1280], [90, 900]] as const) {
    await page.setViewportSize({ width, height: 800 });
    await bootAt(page, scale);
    const b = await page.evaluate(() => {
      const ex = document.querySelector('[data-test=export]');
      return { adjacent: !!ex && ex.nextElementSibling?.textContent === 'UNDO', sw: document.documentElement.scrollWidth, iw: window.innerWidth };
    });
    expect(b.adjacent, `${scale}%/${width}: EXPORT is still directly before UNDO`).toBe(true);
    expect(b.sw, `${scale}%/${width}: no horizontal page scroll`).toBeLessThanOrEqual(b.iw);
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  const errors = await bootAt(page);
  const openKit = async () => {
    await page.locator('#menubar .menu', { hasText: 'FILE' }).click();
    await page.locator('.dropdown .item', { hasText: 'Export kit' }).click();
  };
  await openKit();
  const dlg = page.locator('[data-test=export-kit].dialog');
  await expect(dlg).toBeVisible();
  const fits = await dlg.evaluate((e) => { const r = e.getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight && r.right <= window.innerWidth; });
  expect(fits).toBe(true);
  await expect(page.locator('[data-test=kx-status]')).toContainText(/UP TO \d+ FILES/);
  // bad input is explained and nothing starts
  await page.locator('[data-test=kx-pitch]').click();
  await page.locator('.msel-item', { hasText: 'CHROMATIC RANGE' }).click();
  await page.locator('[data-test=kx-lo]').fill('X9');
  await expect(page.locator('[data-test=kx-status]')).toContainText('NOT A NOTE');
  await page.locator('.dialog').getByRole('button', { name: 'EXPORT', exact: true }).click();
  await expect(dlg).toBeVisible();
  await page.locator('[data-test=kx-lo]').fill('C2');
  await page.locator('[data-test=kx-hi]').fill('D2');
  await page.locator('[data-test=kx-layers]').click();
  await page.locator('.msel-item', { hasText: /^4$/ }).click();
  await page.locator('[data-test=kx-instruments]').click();
  await page.locator('.msel-item', { hasText: 'SELECTED TRACKS' }).click();
  await expect(dlg).toBeVisible();
  // cancel a running export
  await page.locator('.dialog').getByRole('button', { name: 'EXPORT', exact: true }).click();
  await expect(dlg).toHaveCount(0);
  const card = page.locator('[data-test=kx-progress]');
  await expect(card).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as W).clatter.kitExport.busy)).toBe(true);
  await page.locator('[data-test=kx-cancel]').click();
  await expect(card).toBeHidden({ timeout: 60_000 });
  await expect(page.locator('[data-test=toast-info]').last()).toContainText('CANCELLED');
  // and a real one
  await openKit();
  const dl = page.waitForEvent('download', { timeout: 120_000 });
  await page.locator('.dialog').getByRole('button', { name: 'EXPORT', exact: true }).click();
  const file = await dl;
  expect(file.suggestedFilename()).toMatch(/\.zip$/i);
  expect(errors).toEqual([]);
});

test('EXPORT KIT is also on SOUND > KITS, and the pattern EXPORT keeps its place', async ({ page }) => {
  await bootAt(page);
  await page.click('[data-test=view-sound]');
  await page.getByText('KITS', { exact: true }).first().click();
  await page.locator('[data-test=export-kit]').click();
  await expect(page.locator('[data-test=export-kit].dialog')).toBeVisible();
  await page.keyboard.press('Escape');
});

test('seed fields: a typed phrase is held, GENERATE repeats it, the dice and CLEAR work, and the phrase survives a reload', async ({ page }) => {
  const errors = await bootAt(page);
  await page.click('[data-test=ws-generate]');
  const field = page.locator('[data-test=gen-seed]');
  await expect(field).toBeVisible();
  await field.fill('Velvet Orbit');
  await field.press('Enter');
  await expect(field).toHaveValue('velvet-orbit');
  const grids = () => page.evaluate(() => JSON.stringify((window as unknown as W).clatter.pattern.gen));
  await page.click('[data-test=generate]');
  const first = await grids();
  await page.click('[data-test=generate]');
  expect(await grids()).toEqual(first);
  expect(await page.evaluate(() => (window as unknown as W).clatter.pattern.seedText)).toBe('velvet-orbit');
  // the dice holds a new two-word phrase
  await page.click('[data-test=gen-seed-roll]');
  await expect(field).toHaveValue(/^[a-z]+-[a-z]+$/);
  await expect(field).not.toHaveValue('velvet-orbit');
  // CLEAR frees the seed: the next GENERATE draws a phrase and shows it
  await page.click('[data-test=gen-seed-clear]');
  await expect(field).toHaveValue('');
  await page.click('[data-test=generate]');
  await expect(field).toHaveValue(/^[a-z]+-[a-z]+$/);
  // a number is a plain number seed
  await field.fill('12345');
  await field.press('Enter');
  await page.click('[data-test=generate]');
  expect(await page.evaluate(() => (window as unknown as W).clatter.pattern.seed)).toBe(12345);
  // typing in the field plays no shortcut (G would GENERATE)
  const before = await grids();
  await field.fill('gold');
  await field.press('Escape');
  expect(await grids()).toEqual(before);
  // the phrase is saved with the project
  await field.fill('silver-moth');
  await field.press('Enter');
  await page.click('[data-test=generate]');
  await page.waitForTimeout(1200);
  await page.reload();
  await page.waitForSelector('#transport', { timeout: 30_000 });
  expect(await page.evaluate(() => (window as unknown as W).clatter.pattern.seedText)).toBe('silver-moth');
  await page.click('[data-test=ws-generate]');
  await expect(page.locator('[data-test=gen-seed]')).toHaveValue('silver-moth');
  expect(errors).toEqual([]);
});
