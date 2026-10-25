/**
 * Sample sets and kits in a real browser: import a folder of TR-606 samples, review the mapping,
 * save it, reload, load it again from the library, combine it with a synth kit, save a full kit,
 * export the set and import it into a fresh browser.
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type W = { clatter: import('../src/app/app').App };

/** a short mono 16-bit WAV; the frequency makes each file different */
function wav(freq: number): Buffer {
  const n = 4410;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + n * 2, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(44100, 24);
  b.writeUInt32LE(88200, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / 44100) * 12000 * (1 - i / n)), 44 + i * 2);
  return b;
}

function folder(name: string, files: [string, number][]): string {
  const root = mkdtempSync(join(tmpdir(), 'clatter-'));
  const dir = join(root, name);
  mkdirSync(dir);
  for (const [f, hz] of files) writeFileSync(join(dir, f), wav(hz));
  return dir;
}
const TR606: [string, number][] = [['606 Kick.wav', 60], ['606 Snare.wav', 200], ['606 CH.wav', 8000], ['606 OH.wav', 6000], ['606 LT.wav', 100], ['606 HT.wav', 150], ['606 Cymbal.wav', 5000], ['notes.txt', 0]];
const TR808: [string, number][] = TR606.map(([f, hz]) => [f.replace('606', '808'), hz + 7]);

async function boot(page: Page, scale: number | null = null): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto('./');
  await page.evaluate((x) => {
    localStorage.clear();
    if (x !== null) localStorage.setItem('clatter.prefs', JSON.stringify({ uiScale: x }));
  }, scale);
  await page.goto('./');
  await page.waitForSelector('#transport', { timeout: 30_000 });
  await page.waitForFunction(() => !!(window as unknown as W).clatter?.kitm);
  return errors;
}

const goSample = async (page: Page) => {
  await page.click('[data-test=view-sound]');
  await page.click('[data-test=sound-tab-sample]');
};
const samples = (page: Page) => page.evaluate(() => Object.fromEntries((window as unknown as W).clatter.project.tracks.map((t) => [t.role, t.sound.samples.map((id) => (window as unknown as W).clatter.library.get(id)?.name ?? '?')])));

async function importFolder(page: Page, dir: string): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await page.click('[data-test=set-import-folder]');
  await (await chooser).setFiles(dir);
  await page.waitForSelector('.dialog .maprow.mapimport[data-role=kick]');
}

test('imports a TR-606 folder, maps it, saves it, and loads it again after a reload', async ({ page }) => {
  const errors = await boot(page);
  await goSample(page);
  const synthBefore = await page.evaluate(() => JSON.stringify((window as unknown as W).clatter.project.kit.synth));
  await importFolder(page, folder('TR-606', TR606));
  await expect(page.locator('.dialog h2')).toContainText('7 AUDIO FILE');
  await expect(page.locator('.dialog input.kname')).toHaveValue('TR-606');
  await expect(page.locator('.maprow[data-role=kick] .msel')).toHaveText(/606 Kick/);
  await expect(page.locator('.maprow[data-role=chat] .msel')).toHaveText(/606 CH/);
  await expect(page.locator('.maprow[data-role=ohat] .msel')).toHaveText(/606 OH/);
  await expect(page.locator('.maprow[data-role=cymbal] .msel')).toHaveText(/606 Cymbal/);
  await expect(page.locator('.maprow[data-role=clap] .msel')).toHaveText(/NONE/);
  // correct one: the clap is the snare file, then back to none
  await page.locator('.maprow[data-role=clap] .msel').click();
  await page.locator('.msel-item', { hasText: '606 Snare.wav' }).click();
  await expect(page.locator('.maprow[data-role=clap] .msel')).toHaveText(/606 Snare/);
  await page.locator('.maprow[data-role=clap] .msel').click();
  await page.locator('.msel-item', { hasText: 'NONE' }).click();
  await expect(page.locator('.dialog .report').nth(1)).toContainText('7 OF 10');
  // nothing on the tracks changed yet
  expect(await samples(page)).toMatchObject({ kick: expect.any(Array) });
  const beforeLoad = await samples(page);
  await page.screenshot({ path: '/tmp/claude-0/shots/import-1440.png' });
  await page.click('.mbutton:has-text("SAVE AND LOAD")');
  await page.waitForSelector('.dialog', { state: 'detached' });
  const after = await samples(page);
  expect(after.kick).toEqual(['606 KICK']);
  expect(after.snare).toEqual(['606 SNARE']);
  expect(after.clap).toEqual(beforeLoad.clap);
  expect(await page.evaluate(() => JSON.stringify((window as unknown as W).clatter.project.kit.synth))).toBe(synthBefore);
  await expect(page.locator('[data-test=set-name]')).toHaveText('TR-606');
  // close and reopen: a fresh page, a fresh project, no access to the original files
  await page.reload();
  await page.waitForFunction(() => !!(window as unknown as W).clatter?.kitm);
  await goSample(page);
  await expect(page.locator('[data-test=set-name]')).toHaveText('TR-606');
  await page.evaluate(() => (window as unknown as W).clatter.newProject());
  await expect(page.locator('[data-test=set-name]')).toHaveText('NONE');
  await page.click('[data-test=set-load]');
  await page.click('.kitlist [data-kit="TR-606"]');
  await page.click('[data-test=kit-load]');
  await expect(page.locator('.dialog h2')).toContainText('LOAD SAMPLE SET: TR-606');
  await expect(page.locator('.maprow.changes')).toHaveCount(7);
  await page.screenshot({ path: '/tmp/claude-0/shots/load-1440.png' });
  await page.click('.mbutton:has-text("LOAD")');
  await page.waitForSelector('.dialog', { state: 'detached' });
  expect((await samples(page)).kick).toEqual(['606 KICK']);
  expect((await samples(page)).cymbal).toEqual(['606 CYMBAL']);
  // undo takes the whole load back
  await page.evaluate(() => (window as unknown as W).clatter.undo());
  expect((await samples(page)).kick).toEqual([]);
  expect(errors).toEqual([]);
});

test('a sample set and a synth kit load independently; a full kit holds both; the set exports to another browser', async ({ page, browser }) => {
  const errors = await boot(page);
  await goSample(page);
  await importFolder(page, folder('TR-606', TR606));
  await page.click('.mbutton:has-text("SAVE AND LOAD")');
  await page.waitForSelector('.dialog', { state: 'detached' });
  await importFolder(page, folder('TR-808', TR808));
  await page.click('.mbutton:has-text("SAVE SET")');
  await page.waitForSelector('.dialog:has-text("KIT LIBRARY")');
  await page.click('.mbutton:has-text("CLOSE")');
  // a synth kit: generate, save as METALLIC
  await page.click('[data-test=sound-tab-kits]');
  await page.click('[data-test=generate-kit]');
  await expect(page.locator('[data-test=generate-kit]')).toBeEnabled();
  await page.click('[data-test=kit-save-synth]');
  await page.fill('.dialog input.kname', 'Metallic Chaos');
  await page.click('[data-test=kit-save]');
  await expect(page.locator('.kitstatus')).toContainText('SAVED SYNTH KIT METALLIC CHAOS');
  await page.click('.mbutton:has-text("CLOSE")');
  const metallic = await page.evaluate(() => JSON.stringify((window as unknown as W).clatter.project.kit.synth));
  // change the synth, then load the saved synth kit back: the samples do not move
  await page.click('[data-test=generate-kit]');
  await expect(page.locator('[data-test=generate-kit]')).toBeEnabled();
  expect(await page.evaluate(() => JSON.stringify((window as unknown as W).clatter.project.kit.synth))).not.toBe(metallic);
  const s606 = await samples(page);
  await page.click('[data-test=kit-load-synth]');
  await page.click('.kitlist [data-kit="METALLIC CHAOS"]');
  await page.click('[data-test=kit-load]');
  await expect(page.locator('.dialog')).toContainText('KEEPS: EVERY TRACK’S SAMPLES');
  await page.click('.mbutton:has-text("LOAD")');
  await page.waitForSelector('.dialog', { state: 'detached' });
  expect(await page.evaluate(() => JSON.stringify((window as unknown as W).clatter.project.kit.synth))).toBe(metallic);
  expect(await samples(page)).toEqual(s606);
  // switch to TR-808: the synth stays
  await page.click('[data-test=kit-load-set]');
  await page.click('.kitlist [data-kit="TR-808"]');
  await page.click('[data-test=kit-load]');
  await page.click('.mbutton:has-text("LOAD")');
  await page.waitForSelector('.dialog', { state: 'detached' });
  expect((await samples(page)).kick).toEqual(['808 KICK']);
  expect(await page.evaluate(() => JSON.stringify((window as unknown as W).clatter.project.kit.synth))).toBe(metallic);
  // save the combination as a full kit
  await page.click('[data-test=kit-save-full]');
  await page.fill('.dialog input.kname', 'Chaos 808');
  await page.click('[data-test=kit-save]');
  await expect(page.locator('.kitstatus')).toContainText('SAVED FULL KIT CHAOS 808');
  await page.click('.mbutton:has-text("CLOSE")');
  // mess up both halves, load the full kit
  await page.evaluate(() => {
    const a = (window as unknown as W).clatter;
    void a.kitm!.session.load(a.kitm!.session.kits.find((k) => k.name === 'TR-606')!.id);
  });
  await page.click('[data-test=generate-kit]');
  await expect(page.locator('[data-test=generate-kit]')).toBeEnabled();
  await page.click('[data-test=kit-load-full]');
  await page.click('.kitlist [data-kit="Chaos 808"]');
  await page.click('[data-test=kit-load]');
  await page.click('.mbutton:has-text("LOAD")');
  await page.waitForSelector('.dialog', { state: 'detached' });
  expect((await samples(page)).kick).toEqual(['808 KICK']);
  expect(await page.evaluate(() => JSON.stringify((window as unknown as W).clatter.project.kit.synth))).toBe(metallic);
  // export TR-606 and import it into a brand new browser profile
  const exported = await page.evaluate(async () => {
    const a = (window as unknown as W).clatter;
    const id = a.kitm!.session.kits.find((k) => k.name === 'TR-606')!.id;
    const f = await a.kitm!.exportKit('set', id);
    let s = '';
    for (const b of f.data) s += String.fromCharCode(b);
    return { name: f.name, b64: btoa(s) };
  });
  expect(exported.name).toBe('TR-606.kit.zip');
  const ctx2 = await browser.newContext({ baseURL: 'http://localhost:4174/' });
  const page2 = await ctx2.newPage();
  const errors2 = await boot(page2);
  await goSample(page2);
  expect(await page2.evaluate(() => (window as unknown as W).clatter.kitm!.session.kits.length)).toBe(0);
  const chooser = page2.waitForEvent('filechooser');
  await page2.click('[data-test=set-import-zip]');
  await (await chooser).setFiles({ name: exported.name, mimeType: 'application/zip', buffer: Buffer.from(exported.b64, 'base64') });
  await expect(page2.locator('.dialog h2')).toContainText('LOAD SAMPLE SET: TR-606');
  await page2.click('.mbutton:has-text("LOAD")');
  await page2.waitForSelector('.dialog', { state: 'detached' });
  expect((await samples(page2)).kick).toEqual(['606 KICK']);
  expect((await samples(page2)).cymbal).toEqual(['606 CYMBAL']);
  await ctx2.close();
  expect(errors).toEqual([]);
  expect(errors2).toEqual([]);
});

for (const [w, h, scale] of [
  [1920, 1080, 0.9],
  [1440, 900, 0.9],
  [1366, 768, 0.9],
  [1440, 900, 1],
  [1440, 900, 1.25],
  [1366, 768, 1.25],
] as const) {
  test(`SAMPLE and KIT & FX tabs, the library and the import dialog fit at ${w} × ${h}, ${scale * 100} %`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await boot(page, scale);
    await goSample(page);
    const fit = async (what: string) => {
      const r = await page.evaluate(() => {
        const pane = document.querySelector('.sndpane.show') as HTMLElement | null;
        const dlg = document.querySelector('.dialog') as HTMLElement | null;
        const box = (e: Element) => e.getBoundingClientRect();
        return {
          pageY: document.documentElement.scrollHeight > window.innerHeight,
          pageX: document.documentElement.scrollWidth > window.innerWidth,
          paneX: pane ? pane.scrollWidth > pane.clientWidth + 1 : false,
          dlgOff: dlg ? box(dlg).bottom > window.innerHeight + 1 || box(dlg).right > window.innerWidth + 1 || box(dlg).top < -1 : false,
          dlgX: dlg ? dlg.scrollWidth > dlg.clientWidth + 1 : false,
        };
      });
      expect(r.pageY, `${what}: page scrolls vertically`).toBe(false);
      expect(r.pageX, `${what}: page scrolls sideways`).toBe(false);
      expect(r.paneX, `${what}: pane scrolls sideways`).toBe(false);
      expect(r.dlgOff, `${what}: dialog off screen`).toBe(false);
      expect(r.dlgX, `${what}: dialog scrolls sideways`).toBe(false);
    };
    await fit('SAMPLE');
    await expect(page.locator('.sethead')).toBeVisible();
    await page.screenshot({ path: `/tmp/claude-0/shots/sample-${w}-${scale * 100}.png` });
    await page.click('[data-test=sound-tab-kits]');
    await fit('KIT & FX');
    await page.screenshot({ path: `/tmp/claude-0/shots/kit-${w}-${scale * 100}.png` });
    await page.click('[data-test=kit-library-set]');
    await fit('LIBRARY');
    await page.screenshot({ path: `/tmp/claude-0/shots/library-${w}-${scale * 100}.png` });
    await page.click('.mbutton:has-text("CLOSE")');
    await goSample(page);
    await importFolder(page, folder('TR-606', TR606));
    await fit('IMPORT');
    await page.screenshot({ path: `/tmp/claude-0/shots/import-${w}-${scale * 100}.png` });
    // the buttons of the dialog are reachable
    await expect(page.locator('.mbutton:has-text("SAVE AND LOAD")')).toBeInViewport();
    await page.click('.mbutton:has-text("CANCEL")');
  });
}
