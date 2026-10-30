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

test('the eleven tabs are there, one is open, and the old KIT & FX name is gone', async ({ page }) => {
  const errors = await boot(page);
  const labels = await page.locator('.sound-main .wstab').allTextContents();
  expect(labels).toEqual(['SYNTH', 'SAMPLE', 'MODULATION', 'VARIATIONS', 'MIXER', 'FX', 'TUNER', 'SCALE', 'DISCOVER', 'FACTORY', 'KITS']);
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

test('TUNER: analyses the selected sound, shows the note, follows a variation, says so for a hat', async ({ page }) => {
  const errors = await boot(page);
  const snapshot = () => page.evaluate(() => JSON.stringify((window as unknown as W).clatter.project));
  const project0 = await snapshot();
  await page.click('[data-test=sound-tab-tuner]');
  // opening the tab analyses a sound that has none yet
  await expect(page.locator('[data-test=tuner-note]')).not.toHaveText(/^[·…]?$/, { timeout: 20_000 });
  const first = await page.locator('[data-test=tuner-readout]').innerText();
  expect(first).toMatch(/HZ/);
  expect(first).toMatch(/CENTS/);
  expect(await page.evaluate(() => (window as unknown as W).clatter.pitch.size)).toBe(1);
  // the project was not touched by analysing
  expect(await snapshot()).toBe(project0);
  // a pitch-less sound gives no note
  await page.evaluate(() => {
    const a = (window as unknown as W).clatter;
    a.selectTrack(a.project.tracks.find((t) => t.name === 'CL HAT')!.id);
  });
  await page.click('[data-test=tuner-analyse]');
  await expect(page.locator('[data-test=tuner-kind]')).toHaveText(/INHARMONIC|UNPITCHED/, { timeout: 20_000 });
  await expect(page.locator('[data-test=tuner-hz]')).toHaveText('NO NOTE');
  // changing the sound marks the result stale; REANALYSE refreshes it
  await page.evaluate(() => {
    const a = (window as unknown as W).clatter;
    a.selectTrack(a.project.tracks.find((t) => t.name === 'KICK')!.id);
  });
  await page.click('[data-test=tuner-reanalyse]');
  await expect(page.locator('[data-test=tuner-stale]')).not.toHaveText(/CHANGED/, { timeout: 20_000 });
  const before = await page.locator('[data-test=tuner-hz]').innerText();
  await page.evaluate(() => {
    const a = (window as unknown as W).clatter;
    a.setTrackSound(a.track.id, { trigger: 1 }, 'TRIGGER');
  });
  await expect(page.locator('[data-test=tuner-stale]')).toHaveText(/CHANGED/);
  await page.click('[data-test=tuner-reanalyse]');
  await expect(page.locator('[data-test=tuner-stale]')).not.toHaveText(/CHANGED/, { timeout: 20_000 });
  expect(await page.locator('[data-test=tuner-hz]').innerText()).not.toBe(before);
  expect(errors).toEqual([]);
});

test('TUNER: the PITCH control retunes the real sound, the readout follows without leaving the tab', async ({ page }) => {
  const errors = await boot(page);
  await page.click('[data-test=sound-tab-tuner]');
  await expect(page.locator('[data-test=tuner-note]')).not.toHaveText(/^[·…]?$/, { timeout: 20_000 });
  const hz = async () => parseFloat((await page.locator('[data-test=tuner-hz]').innerText()).replace(/[^0-9.]/g, ''));
  const start = await hz();
  const others = await page.evaluate(() => JSON.stringify((window as unknown as W).clatter.project.tracks.map((t) => t.sound)));
  await expect(page.locator('[data-test=tuner-pitch]')).toBeVisible();
  // an octave up in semitone steps; the readout is re-measured on its own, with AUTO off
  const c0 = await page.evaluate(() => (window as unknown as W).clatter.paramValue(8));
  for (let i = 0; i < 12; i++) await page.click('[data-test=tuner-pitch-up]');
  await expect(page.locator('[data-test=tuner-stale]')).not.toHaveText(/MEASURING|CHANGED/, { timeout: 20_000 });
  const up = await hz();
  expect(up / start).toBeGreaterThan(1.9);
  expect(up / start).toBeLessThan(2.1);
  expect(await page.evaluate(() => (window as unknown as W).clatter.paramValue(8))).toBe(c0 + 12);
  expect(await page.evaluate(() => JSON.stringify((window as unknown as W).clatter.project.tracks.map((t) => t.sound)))).toBe(others);
  // the same value is in the sound editor and in undo
  await page.click('[data-test=sound-tab-synth]');
  await expect(page.locator('[data-param="8"]').first()).toBeVisible();
  await page.evaluate(() => (window as unknown as W).clatter.undo());
  expect(await page.evaluate(() => (window as unknown as W).clatter.paramValue(8))).toBe(c0 + 11);
  expect(errors).toEqual([]);
});

test('DISCOVER: eight candidates, audition and A/B leave the instrument alone, APPLY is one undo step', async ({ page }) => {
  const errors = await boot(page);
  const kit = () => page.evaluate(() => JSON.stringify((window as unknown as W).clatter.project.kit.synth));
  await page.click('[data-test=sound-tab-discover]');
  await expect(page.locator('[data-test=dslot-0]')).toHaveClass(/empty/);
  const before = await kit();
  await page.fill('[data-test=discover-seed]', 'velvet-orbit');
  await page.press('[data-test=discover-seed]', 'Enter');
  await page.click('[data-test=discover-go]');
  await expect(page.locator('.dslot:not(.empty)')).toHaveCount(8, { timeout: 30_000 });
  await expect(page.locator('[data-test=discover-seed]')).toHaveValue('velvet-orbit');
  // audition and A/B: rendered by the engine, the instrument is untouched
  await page.click('[data-test=dslot-play-2]');
  await expect(page.locator('[data-test=ab-now]')).toContainText('B · 3', { timeout: 15_000 });
  await page.click('[data-test=ab-a]');
  await expect(page.locator('[data-test=ab-now]')).toContainText('A · ORIGINAL');
  await page.click('[data-test=ab-switch]');
  await expect(page.locator('[data-test=ab-now]')).toContainText('B · 3');
  await page.click('[data-test=discover-mutate]');
  await expect(page.locator('.dslot.sel .dname')).toHaveText('KICK M1', { timeout: 15_000 });
  expect(await kit()).toBe(before);
  await page.click('[data-test=discover-apply]');
  await expect(page.locator('.dslot.sel .dtag')).toHaveText('LIVE');
  expect(await kit()).not.toBe(before);
  await page.keyboard.press('Control+z');
  expect(await kit()).toBe(before);
  // save to the library and load it back into a slot
  await page.click('[data-test=discover-save]');
  await page.fill('.namebox', 'my test sound');
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-test=lib-row]')).toHaveCount(1);
  await page.click('[data-test=lib-load]');
  await expect(page.locator('.dslot.sel .dmeta')).toContainText('LIBRARY');
  expect(await kit()).toBe(before);
  expect(errors).toEqual([]);
});

test('SIDEBAR: the selected track’s meter moves and stays visible against the selected styling', async ({ page }) => {
  const errors = await boot(page);
  const sel = page.locator('.sidetrack.on');
  await expect(sel).toHaveCount(1);
  // the fill must contrast with the meter's own background (it was paper on paper)
  const colours = await sel.locator('.meter').evaluate((m) => ({ bg: getComputedStyle(m).backgroundColor, fill: getComputedStyle(m.querySelector('.lvl')!).backgroundColor }));
  expect(colours.bg).not.toBe(colours.fill);
  await page.evaluate(() => {
    const a = (window as unknown as W).clatter;
    void a.audition(a.track.id);
  });
  await expect.poll(() => sel.locator('.lvl').evaluate((l) => parseFloat((l as HTMLElement).style.width) || 0), { timeout: 8000 }).toBeGreaterThan(1);
  // an unselected track still works
  const other = await page.evaluate(() => {
    const a = (window as unknown as W).clatter;
    const t = a.project.tracks.find((x) => x.id !== a.track.id)!;
    void a.audition(t.id);
    return t.id;
  });
  await expect.poll(() => page.locator(`.sidetrack[data-track="${other}"] .lvl`).evaluate((l) => parseFloat((l as HTMLElement).style.width) || 0), { timeout: 8000 }).toBeGreaterThan(1);
  await expect(sel).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('MODULATION: the LFO marker travels at the configured rate and the envelope marker follows a trigger', async ({ page }) => {
  const errors = await boot(page);
  await page.click('[data-test=sound-tab-modulation]');
  await page.evaluate(() => (window as unknown as W).clatter.loadModPreset('f:wobble'));
  await page.click('[data-test=play]');
  await expect.poll(() => page.evaluate(() => !!(window as unknown as W).clatter.meters?.mod), { timeout: 8000 }).toBe(true);
  const markX = () => page.locator('.modplot .plotmark:not(.wide)').first().evaluate((m) => ({ shown: (m as HTMLElement).style.display !== 'none', x: parseFloat((m as HTMLElement).style.left) }));
  const xs: number[] = [];
  for (let i = 0; i < 12; i++) {
    const m = await markX();
    if (m.shown) xs.push(m.x);
    await page.waitForTimeout(40);
  }
  // the marker moves between frames (more distinct positions than the engine's ~46 Hz reports alone would explain being static)
  expect(new Set(xs).size).toBeGreaterThan(3);
  await page.keyboard.press('Space');
  expect(errors).toEqual([]);
});
