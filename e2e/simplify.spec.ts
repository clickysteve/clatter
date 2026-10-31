/** One pattern in a real browser: the fixed one-line status bar, selection, the STEP SOUND panel, double-click and Delete, live regeneration. */
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

async function geo(page: Page) {
  const canvas = page.locator('#pattern .gridwrap canvas').first();
  await canvas.scrollIntoViewIfNeeded();
  const box = (await canvas.boundingBox())!;
  const g = await canvas.evaluate((c) => ({ head: Number((c as HTMLCanvasElement).dataset.head), rowh: Number((c as HTMLCanvasElement).dataset.rowh), cellw: Number((c as HTMLCanvasElement).dataset.cellw) }));
  return { at: (tr: number, s: number) => [box.x + (s + 0.5) * g.cellw, box.y + g.head + (tr + 0.5) * g.rowh] as const, ...g };
}

const SIZES = [
  [1920, 1080, 90],
  [1440, 900, 90],
  [1366, 768, 90],
  [1366, 768, 75],
  [1440, 900, 125],
  [1366, 768, 150],
] as const;

for (const [w, h, scale] of SIZES) {
  test(`the status bar is one fixed line at ${w} × ${h}, ${scale} %: selecting steps never moves anything`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await boot(page);
    await page.evaluate((s) => (window as unknown as W).clatter.setUiScale(s / 100), scale);
    await page.waitForTimeout(250);
    const measure = () =>
      page.evaluate(() => {
        const foot = document.querySelector('#pattern .gridfoot') as HTMLElement;
        const where = foot.querySelector('.where') as HTMLElement;
        const grid = document.querySelector('#pattern .gridwrap') as HTMLElement;
        const ws = document.querySelector('.workspace') as HTMLElement;
        const lh = parseFloat(getComputedStyle(where).lineHeight) || where.getBoundingClientRect().height;
        return {
          foot: Math.round(foot.getBoundingClientRect().height * 100) / 100,
          gridTop: Math.round(grid.getBoundingClientRect().top),
          wsTop: Math.round(ws.getBoundingClientRect().top),
          oneLine: where.scrollHeight <= Math.ceil(where.clientHeight) + 1 && foot.scrollHeight <= Math.ceil(foot.clientHeight) + 1,
          nowrap: getComputedStyle(where).whiteSpace === 'nowrap',
          lh,
          pageX: document.documentElement.scrollWidth > window.innerWidth,
          pageY: document.documentElement.scrollHeight > window.innerHeight,
        };
      });
    const before = await measure();
    expect(before.nowrap).toBe(true);
    expect(before.oneLine).toBe(true);
    const g = await geo(page);
    // point at a step with a long description, then select one that has a sound and a condition
    await page.evaluate(() => {
      const a = (window as unknown as W).clatter;
      const t = a.project.tracks[2]!;
      a.paintCell(t.id, 3, true);
      a.editStepSound(() => ({ v: 1, locks: { 12: 40 } }), 'TEST', [{ track: t.id, step: 3 }]);
    });
    for (const [tr, s] of [[0, 0], [2, 3], [5, 11], [9, 15]] as const) {
      await page.mouse.move(...g.at(tr, s));
      await page.waitForTimeout(80);
      const m = await measure();
      expect(m.foot).toBe(before.foot);
      expect(m.gridTop).toBe(before.gridTop);
      expect(m.wsTop).toBe(before.wsTop);
      expect(m.oneLine).toBe(true);
      expect(m.pageX).toBe(false);
    }
    await page.mouse.click(...g.at(2, 3));
    const sel = await measure();
    expect(sel.foot).toBe(before.foot);
    expect(sel.wsTop).toBe(before.wsTop);
    expect(sel.pageX).toBe(false);
    // the selected track and step lead the line
    await page.mouse.move(5, 5);
    await expect(page.locator('#pattern .gridfoot .where')).toContainText(/STEP 4/);
  });
}

test('clicking an empty step and clicking a note: select, keep; click toggles; Delete removes the selection; the STEP SOUND panel follows', async ({ page }) => {
  const errors = await boot(page);
  const g = await geo(page);
  await page.evaluate(() => {
    const a = (window as unknown as W).clatter;
    a.clearPattern();
  });
  const tr = 4;
  const id = await page.evaluate((t) => (window as unknown as W).clatter.project.tracks[t]!.id, tr);
  const has = (s: number) => page.evaluate(([i, st]) => !!(window as unknown as W).clatter.hitAt(i as string, st as number), [id, s]);
  await page.mouse.click(...g.at(tr, 2));
  expect(await has(2)).toBe(true);
  await page.mouse.click(...g.at(tr, 2));
  expect(await has(2)).toBe(false);
  await page.mouse.click(...g.at(tr, 2));
  expect(await has(2)).toBe(true);
  // the STEP SOUND tab shows the step, for a note and for an empty step
  await page.click('[data-test=ws-sound]');
  await expect(page.locator('[data-test=pane-sound]')).toContainText('STEP 3');
  await page.mouse.click(...g.at(tr, 6), { button: 'right' });
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-test=pane-sound]')).toContainText('STEP 7');
  expect(await has(6)).toBe(false);
  await expect(page.locator('[data-test=pane-sound]')).toContainText(/NO HIT/);
  // a click on the note removes it, one undo brings it back
  await page.mouse.click(...g.at(tr, 2));
  expect(await has(2)).toBe(false);
  await page.keyboard.press('Control+z');
  expect(await has(2)).toBe(true);
  // Shift-click adds to what is selected (the note just clicked), Delete removes the picks and nothing else
  await page.mouse.click(...g.at(tr, 8));
  await page.mouse.click(...g.at(tr, 10));
  await page.keyboard.down('Shift');
  await page.mouse.click(...g.at(tr, 8));
  await page.keyboard.up('Shift');
  await page.keyboard.press('Backspace');
  expect(await has(8)).toBe(false);
  expect(await has(10)).toBe(false);
  expect(await has(2)).toBe(true);
  // the playhead never changes the selection
  const sel = await page.evaluate(() => JSON.stringify((window as unknown as W).clatter.cursorCell()));
  await page.click('[data-test=play]');
  await page.waitForTimeout(900);
  expect(await page.evaluate(() => JSON.stringify((window as unknown as W).clatter.cursorCell()))).toBe(sel);
  await page.keyboard.press('Space');
  expect(errors).toEqual([]);
});

test('the ? KEY lists every gesture; the permanent hint is short', async ({ page }) => {
  await boot(page);
  const hint = await page.locator('#pattern .gridfoot .hint').textContent();
  expect(hint!.length).toBeLessThan(90);
  await page.click('[data-test=grid-key]');
  const dlg = page.locator('.dialog');
  for (const t of ['Click a note', 'Shift-drag', 'Shift-click', 'Right-click a step', 'Delete / Backspace']) await expect(dlg).toContainText(t);
  await page.keyboard.press('Escape');
});

test('LIVE REGEN has an explicit switch and interval, and the grid shows the regenerated cycle', async ({ page }) => {
  await boot(page);
  await page.click('[data-test=ws-generate]');
  const rhythm = page.locator('[data-test=live-rhythm]');
  await expect(rhythm).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as W).clatter.project.evolve.target)).not.toMatch(/rhythm|both/);
  await rhythm.click();
  expect(await page.evaluate(() => (window as unknown as W).clatter.project.evolve.target)).toMatch(/rhythm|both/);
  await expect(page.locator('[data-test=live-every]')).toBeVisible();
  const written = await page.evaluate(() => JSON.stringify((window as unknown as W).clatter.pattern.grids));
  await page.evaluate(() => (window as unknown as W).clatter.setEvolve({ every: 1, amount: 1 }));
  await page.click('[data-test=play]');
  await page.waitForTimeout(4500);
  await page.keyboard.press('Space');
  // regeneration is a playback feature: the written pattern is as it was
  expect(await page.evaluate(() => JSON.stringify((window as unknown as W).clatter.pattern.grids))).toBe(written);
  await rhythm.click();
  expect(await page.evaluate(() => (window as unknown as W).clatter.project.evolve.target)).not.toMatch(/rhythm|both/);
});
