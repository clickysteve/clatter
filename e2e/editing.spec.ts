/** Sequencer editing in a real browser: velocity drag with its readout, painting, erasing, selection, velocity tools, trigger marks. */
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

/** Clear track `tr` and return its id. */
async function emptyTrack(page: Page, tr: number): Promise<string> {
  return page.evaluate((t) => {
    const a = (window as unknown as W).clatter;
    const id = a.project.tracks[t]!.id;
    a.clearTrack(id);
    return id;
  }, tr);
}
const hitAt = (page: Page, id: string, s: number) => page.evaluate(([i, st]) => (window as unknown as W).clatter.hitAt(i as string, st as number)?.vel ?? null, [id, s]);

test('dragging up and down sets the velocity, with a readout; one undo step; the pointer may leave the step', async ({ page }) => {
  const errors = await boot(page);
  const g = await geo(page);
  const id = await emptyTrack(page, 6);
  const [x, y] = g.at(6, 4);
  await page.mouse.move(x, y);
  await page.mouse.down();
  expect(await hitAt(page, id, 4)).toBe(100);
  await page.mouse.move(x, y - 12, { steps: 3 });
  await page.mouse.move(x + g.cellw * 3, y - 20, { steps: 3 }); // wandered off to the right: still this step
  expect(await hitAt(page, id, 4)).toBe(120);
  expect(await hitAt(page, id, 7)).toBeNull();
  await page.mouse.move(x, y + 30, { steps: 4 });
  expect(await hitAt(page, id, 4)).toBe(70);
  await page.mouse.up();
  await page.keyboard.press('Control+z');
  expect(await hitAt(page, id, 4)).toBeNull();
  expect(errors).toEqual([]);
});

test('sideways paints, Shift-drag erases, and neighbouring tracks are untouched', async ({ page }) => {
  await boot(page);
  const g = await geo(page);
  const id = await emptyTrack(page, 6);
  const above = await page.evaluate(() => (window as unknown as W).clatter.project.tracks[5]!.id);
  const before = await page.evaluate((i) => JSON.stringify((window as unknown as W).clatter.pattern.grids[i]), above);
  await page.mouse.move(...g.at(6, 2));
  await page.mouse.down();
  await page.mouse.move(...g.at(5, 8), { steps: 8 }); // drifts up onto the next row
  await page.mouse.up();
  for (let s = 2; s <= 8; s++) expect(await hitAt(page, id, s)).not.toBeNull();
  expect(await page.evaluate((i) => JSON.stringify((window as unknown as W).clatter.pattern.grids[i]), above)).toBe(before);
  await page.keyboard.down('Shift');
  await page.mouse.move(...g.at(6, 4));
  await page.mouse.down();
  await page.mouse.move(...g.at(6, 6), { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  expect(await hitAt(page, id, 3)).not.toBeNull();
  for (const s of [4, 5, 6]) expect(await hitAt(page, id, s)).toBeNull();
  expect(await hitAt(page, id, 7)).not.toBeNull();
});

test('Shift-click and Alt-drag select, the velocity tools act on the selection, copy and paste carry the hits', async ({ page }) => {
  await boot(page);
  const g = await geo(page);
  const id = await emptyTrack(page, 6);
  await page.evaluate((i) => {
    const a = (window as unknown as W).clatter;
    for (const s of [0, 2, 4, 6]) a.paintCell(i, s, true);
    a.setCursor({ track: i, step: 0 });
  }, id);
  // Shift-click adds steps to the selection one by one, and takes them out again
  await page.keyboard.down('Shift');
  await page.mouse.click(...g.at(6, 4));
  await page.mouse.click(...g.at(6, 2));
  await page.keyboard.up('Shift');
  expect(await page.evaluate(() => (window as unknown as W).clatter.ui.picks.map((p) => p.step))).toEqual([0, 4, 2]);
  await page.keyboard.down('Shift');
  await page.mouse.click(...g.at(6, 4));
  await page.keyboard.up('Shift');
  expect(await page.evaluate(() => (window as unknown as W).clatter.ui.picks.map((p) => p.step))).toEqual([0, 2]);
  await page.keyboard.press('Delete');
  expect(await hitAt(page, id, 0)).toBeNull();
  expect(await hitAt(page, id, 2)).toBeNull();
  expect(await hitAt(page, id, 4)).not.toBeNull();
  await page.keyboard.press('Control+z');
  expect(await hitAt(page, id, 0)).not.toBeNull();
  // Alt-drag: a region
  await page.keyboard.down('Alt');
  await page.mouse.move(...g.at(6, 0));
  await page.mouse.down();
  await page.mouse.move(...g.at(6, 6), { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up('Alt');
  expect(await page.evaluate(() => (window as unknown as W).clatter.ui.sel)).toMatchObject({ s0: 0, s1: 6 });
  await page.locator('[data-test=vel-ramp]').click();
  const vels = await Promise.all([0, 2, 4, 6].map((s) => hitAt(page, id, s)));
  expect(vels[0]).toBe(40);
  expect(vels[3]).toBe(120);
  expect(vels[0]! < vels[1]! && vels[1]! < vels[2]! && vels[2]! < vels[3]!).toBe(true);
  await page.keyboard.press('Control+c');
  await page.evaluate((i) => {
    const a = (window as unknown as W).clatter;
    a.select({ t0: a.trackIndexOf(i), t1: a.trackIndexOf(i), s0: 8, s1: 8 });
  }, id);
  await page.keyboard.press('Control+v');
  expect(await hitAt(page, id, 8)).toBe(40);
  expect(await hitAt(page, id, 14)).toBe(120);
  await page.keyboard.press('Control+z');
  expect(await hitAt(page, id, 14)).toBeNull();
  expect(await hitAt(page, id, 6)).toBe(120);
});

test('conditional steps are marked as the playhead passes them: played solid, skipped hollow', async ({ page }) => {
  const errors = await boot(page);
  const g = await geo(page);
  await page.evaluate(() => {
    const a = (window as unknown as W).clatter;
    const id = a.project.tracks[0]!.id;
    a.pattern.grids[id] = Array.from({ length: a.pattern.steps }, (_, i) => (i === 0 || i === 4 ? { vel: 100 } : null));
    a.pattern.trig = { [id]: { 0: { k: 'first' }, 4: { k: 'every', n: 2, at: 2 } } };
    a.select(null);
  });
  await page.click('[data-test=play]');
  // pass 1 of the pattern: FIRST plays, EVERY 2 ON 2 is skipped. Read the overlay once the playhead is past both.
  const lum = await page.evaluate(
    ([cellw, head]) =>
      new Promise<{ played: number; skipped: number } | null>((resolve) => {
        const a = (window as unknown as W).clatter;
        const over = document.querySelectorAll('#pattern .gridwrap canvas')[1] as HTMLCanvasElement;
        const t0 = performance.now();
        const tick = () => {
          const pos = a.playhead();
          if (pos && pos.cycle === 0 && pos.step > 6) {
            const k = over.getContext('2d')!;
            const dpr = window.devicePixelRatio || 1;
            const px = (step: number) => {
              const d = k.getImageData(Math.round((Math.round(step * (cellw as number)) + 3 + 2) * dpr), Math.round(((head as number) + 3 + 4) * dpr), 1, 1).data;
              return d[3] === 0 ? 255 : (d[0]! + d[1]! + d[2]!) / 3;
            };
            resolve({ played: px(0), skipped: px(4) });
          } else if (performance.now() - t0 > 20000) resolve(null);
          else requestAnimationFrame(tick);
        };
        tick();
      }),
    [g.cellw, g.head],
  );
  expect(lum).not.toBeNull();
  expect(lum!.played).toBeLessThan(110);
  expect(lum!.skipped).toBeGreaterThan(150);
  await page.click('[data-test=play]');
  expect(errors).toEqual([]);
});
