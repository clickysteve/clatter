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
    return { playing: a.ui.playing, ctx: a.host.state, head: a.playhead() };
  });
  expect(s.playing).toBe(true);
  expect(s.ctx).toBe('running');
  // the meter is a momentary peak: wait for a hit rather than sampling one instant
  await expect.poll(() => page.evaluate(() => (window as unknown as W).clatter.meters?.masterL ?? 0), { intervals: [50], timeout: 4000 }).toBeGreaterThan(0.01);
  expect(s.head).not.toBeNull();
  await page.keyboard.press('Space');
  await expect.poll(() => page.evaluate(() => (window as unknown as W).clatter.ui.playing)).toBe(false);
  expect(errors).toEqual([]);
});

/** The grid canvas and its geometry (the canvas carries it). */
async function gridGeo(page: Page) {
  const canvas = page.locator('#pattern .gridwrap canvas').first();
  const box = (await canvas.boundingBox())!;
  const geo = await canvas.evaluate((c) => ({ head: Number((c as HTMLCanvasElement).dataset.head), rowh: Number((c as HTMLCanvasElement).dataset.rowh), cellw: Number((c as HTMLCanvasElement).dataset.cellw) }));
  return { box, ...geo };
}

test('a click inside a grid cell edits exactly that cell', async ({ page }) => {
  await boot(page);
  const g = await gridGeo(page);
  const info = await page.evaluate(() => {
    const a = (window as unknown as W).clatter;
    return { steps: a.pattern.steps, id: a.project.tracks[5]!.id };
  });
  // near the right/bottom edge of step 6 on track 6 (floors, never rounds)
  const x = g.box.x + 6 * g.cellw + g.cellw * 0.9;
  const y = g.box.y + g.head + 5 * g.rowh + g.rowh * 0.9;
  const before = await page.evaluate((id) => !!(window as unknown as W).clatter.hitAt(id, 6), info.id);
  await page.mouse.click(x, y);
  const after = await page.evaluate((id) => {
    const a = (window as unknown as W).clatter;
    return { six: !!a.hitAt(id, 6), seven: !!a.hitAt(id, 7), five: !!a.hitAt(id, 5), cursor: a.cursorCell() };
  }, info.id);
  expect(after.six).toBe(!before);
  expect(after.seven).toBe(false);
  expect(after.five).toBe(false);
  // the clicked step is the one being edited
  expect(after.cursor).toEqual({ track: info.id, step: 6 });
  await page.keyboard.press('Control+z');
  const undone = await page.evaluate((id) => !!(window as unknown as W).clatter.hitAt(id, 6), info.id);
  expect(undone).toBe(before);
});

test('click adds, click removes, right-click opens the step editor, Escape closes it', async ({ page }) => {
  await boot(page);
  const g = await gridGeo(page);
  const tr = 6;
  const id = await page.evaluate((t) => (window as unknown as W).clatter.project.tracks[t]!.id, tr);
  const at = (s: number) => [g.box.x + (s + 0.5) * g.cellw, g.box.y + g.head + (tr + 0.5) * g.rowh] as const;
  const has = (s: number) => page.evaluate(([i, st]) => !!(window as unknown as W).clatter.hitAt(i as string, st as number), [id, s]);
  expect(await has(3)).toBe(false);
  await page.mouse.click(...at(3));
  expect(await has(3)).toBe(true);
  await page.mouse.click(...at(3));
  expect(await has(3)).toBe(false);
  await page.mouse.click(...at(3));
  // the step editor under the grid shows the step
  await expect(page.locator('[data-test=pane-sequence]')).toContainText('STEP 4');
  await page.mouse.click(...at(3), { button: 'right' });
  await expect(page.locator('.popover')).toBeVisible();
  await expect(page.locator('.popover')).toContainText('VELOCITY');
  await expect(page.locator('.popover')).toContainText('CHANCE');
  await page.keyboard.press('Escape');
  await expect(page.locator('.popover')).toHaveCount(0);
  // drag paints, one undo
  await page.mouse.move(...at(8));
  await page.mouse.down();
  await page.mouse.move(...at(10), { steps: 4 });
  await page.mouse.up();
  expect(await has(8)).toBe(true);
  expect(await has(9)).toBe(true);
  expect(await has(10)).toBe(true);
  await page.keyboard.press('Control+z');
  expect(await has(8)).toBe(false);
  expect(await has(10)).toBe(false);
});

test('the grid draws a boundary for every step, heavier at beats, heaviest at bars', async ({ page }) => {
  await boot(page);
  const g = await gridGeo(page);
  const px = await page.evaluate(() => {
    const c = document.querySelector('#pattern .gridwrap canvas') as HTMLCanvasElement;
    const dpr = window.devicePixelRatio || 1;
    const ctx = c.getContext('2d')!;
    const head = Number(c.dataset.head);
    const rowh = Number(c.dataset.rowh);
    const cellw = Number(c.dataset.cellw);
    const a = (window as unknown as W).clatter;
    // an empty row (the second-to-last track plays nothing on beats 1..4 of the preset?) use the row with fewest hits
    const grids = a.project.tracks.map((t) => a.pattern.gen[t.id] ?? []);
    let row = 0;
    let fewest = 1e9;
    grids.forEach((gr, i) => {
      const n = gr.filter(Boolean).length;
      if (n < fewest) ((fewest = n), (row = i));
    });
    // sample the middle of the row, 3 px above the bottom (clear of hits and labels), at each edge
    const y = Math.round((head + row * rowh + rowh * 0.12) * dpr);
    const lum = (x: number) => {
      const d = ctx.getImageData(Math.round(x * dpr), y, 1, 1).data;
      return (d[0]! + d[1]! + d[2]!) / 3;
    };
    const out: number[] = [];
    for (let s = 1; s <= 16; s++) out.push(lum(Math.round(s * cellw)));
    const inside = lum(Math.round(cellw * 0.5));
    return { edges: out, inside };
  });
  // every step edge is visibly drawn (darker than the open cell), 16 sixteenths = 4 beats = 1 bar
  for (let s = 1; s <= 16; s++) expect(px.edges[s - 1]!).toBeLessThan(px.inside > 200 ? 215 : px.inside);
  const step = px.edges[0]!;
  const beat = px.edges[3]!;
  const bar = px.edges[15]!;
  expect(beat).toBeLessThan(step);
  expect(bar).toBeLessThan(beat + 1);
  expect(g.cellw).toBeGreaterThanOrEqual(28);
});

test('a deleted generated hit is an empty cell; SHOW ORIGINAL reveals it', async ({ page }) => {
  await boot(page);
  const g = await gridGeo(page);
  const found = await page.evaluate(() => {
    const a = (window as unknown as W).clatter;
    const t = a.project.tracks[0]!;
    const step = (a.pattern.gen[t.id] ?? []).findIndex((h) => !!h);
    a.toggleCell(t.id, step); // delete the generated hit
    return { step, hit: !!a.hitAt(t.id, step) };
  });
  expect(found.hit).toBe(false);
  const cellInk = async () => {
    await page.mouse.move(5, 5);
    await page.waitForTimeout(150);
    return page.evaluate(
      ([step, head, cellw, rowh]) => {
        const c = document.querySelector('#pattern .gridwrap canvas') as HTMLCanvasElement;
        const dpr = window.devicePixelRatio || 1;
        const ctx = c.getContext('2d')!;
        const x0 = Math.round((step! * cellw! + 3) * dpr);
        const w = Math.round((cellw! - 6) * dpr);
        const y0 = Math.round((head! + 3) * dpr);
        const h = Math.round((rowh! - 8) * dpr);
        const d = ctx.getImageData(x0, y0, w, h).data;
        let dark = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i]! < 100) dark++;
        return dark;
      },
      [found.step, g.head, g.cellw, g.rowh],
    );
  };
  // nothing to see (a few dither dots at most) ...
  expect(await cellInk()).toBeLessThan(40);
  await page.click('[data-test=show-original]');
  // ... until the overlay is on: a crossed outline appears
  expect(await cellInk()).toBeGreaterThan(20);
  await page.click('[data-test=show-original]');
  expect(await cellInk()).toBeLessThan(40);
});

test('a long pattern scrolls inside the grid; the track names stay put', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => (window as unknown as W).clatter.setLength(64));
  await page.waitForTimeout(200);
  const m = await page.evaluate(() => {
    const sc = document.querySelector('#pattern .gridscroll') as HTMLElement;
    const lab = document.querySelector('#pattern .trackrow .tname') as HTMLElement;
    const x0 = lab.getBoundingClientRect().left;
    sc.scrollLeft = 400;
    const canvas = sc.querySelector('canvas') as HTMLCanvasElement;
    return { scroll: sc.scrollWidth, client: sc.clientWidth, cell: Number(canvas.dataset.cellw), labelMoved: lab.getBoundingClientRect().left !== x0, pageOverflow: document.documentElement.scrollWidth > window.innerWidth, mainOverflow: (document.getElementById('main') as HTMLElement).scrollWidth > (document.getElementById('main') as HTMLElement).clientWidth };
  });
  expect(m.scroll).toBeGreaterThan(m.client);
  expect(m.cell).toBeGreaterThanOrEqual(24); // the smallest cell at any scale (the minimum hit target)
  expect(m.labelMoved).toBe(false);
  expect(m.pageOverflow).toBe(false);
  expect(m.mainOverflow).toBe(false);
});

for (const [w, h] of [
  [1920, 1080],
  [1440, 900],
  [1366, 768],
] as const) {
  test(`readable at ${w} × ${h}: type sizes, no overflow, no clipped controls`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await boot(page);
    for (const view of ['pattern', 'sound', 'perform'] as const) {
      await page.click(`[data-test=view-${view}]`);
      await page.waitForTimeout(250);
      const r = await page.evaluate(() => {
        const bad: string[] = [];
        const tiny: string[] = [];
        const main = document.getElementById('main')!;
        const visible = (e: Element) => {
          const r = e.getBoundingClientRect();
          const cs = getComputedStyle(e);
          return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && !(e.closest('.hidden'));
        };
        // every element that holds its own text
        const walker = document.createTreeWalker(document.getElementById('app')!, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          if (!n.textContent?.trim()) continue;
          const el = n.parentElement!;
          if (!visible(el)) continue;
          const fs = parseFloat(getComputedStyle(el).fontSize);
          if (fs < 13) tiny.push(`${el.className || el.tagName}:${fs}:${n.textContent!.trim().slice(0, 20)}`);
        }
        // text must fit its control
        for (const el of document.querySelectorAll<HTMLElement>('.btn, .num, .msel, .pad, .range .val, .xtab, .strip .sname')) {
          if (!visible(el)) continue;
          if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflow !== 'visible' && !el.classList.contains('sname')) bad.push(`${el.className}:${el.textContent}`);
        }
        return { tiny, bad, pageX: document.documentElement.scrollWidth > window.innerWidth, mainX: main.scrollWidth > main.clientWidth + 1 };
      });
      expect(r.tiny, `${view}: small text`).toEqual([]);
      expect(r.bad, `${view}: clipped controls`).toEqual([]);
      expect(r.pageX, `${view}: page overflows sideways`).toBe(false);
      expect(r.mainX, `${view}: work area overflows sideways`).toBe(false);
    }
  });
}

/** Open the page at a saved interface scale (null: the default). */
async function bootAt(page: Page, scale: number | null): Promise<void> {
  await page.goto('./');
  await page.evaluate((x) => {
    localStorage.clear();
    if (x !== null) localStorage.setItem('clatter.prefs', JSON.stringify({ uiScale: x }));
  }, scale);
  await page.goto('./');
  await page.waitForSelector('#transport', { timeout: 30_000 });
}

test('the interface is 90 % by default; VIEW changes it live and it is remembered', async ({ page }) => {
  await boot(page);
  const scale = () => page.evaluate(() => Number(document.documentElement.dataset.scale));
  expect(await scale()).toBe(90);
  const rowh = () => page.evaluate(() => Number((document.querySelector('#pattern canvas') as HTMLCanvasElement).dataset.rowh));
  const before = await rowh();
  await page.locator('#menubar .menu', { hasText: 'VIEW' }).click();
  await page.locator('.dropdown .item', { hasText: 'Interface size' }).hover();
  await page.locator('.dropdown.sub .item', { hasText: '125%' }).dispatchEvent('pointerup');
  await expect.poll(scale).toBe(125);
  await expect.poll(rowh).toBeGreaterThan(before);
  await page.reload();
  await page.waitForSelector('#transport');
  expect(await scale()).toBe(125);
  await page.evaluate(() => (window as unknown as W).clatter.setUiScale(0.9));
  expect(await scale()).toBe(90);
});

for (const [w, h, scale] of [
  [1440, 900, 0.9],
  [1440, 900, 1],
  [1366, 768, 0.9],
  [1920, 1080, 0.9],
  [1920, 1080, 1.25],
  [1440, 900, 1.25],
] as const) {
  test(`PATTERN fits one window at ${w} × ${h}, ${scale * 100} %: no page scroll, the workspace tabs scroll inside`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await bootAt(page, scale);
    for (const tab of ['sequence', 'generate', 'transform', 'track'] as const) {
      await page.click(`[data-test=ws-${tab}]`);
      await page.waitForTimeout(150);
      const r = await page.evaluate(() => {
        const main = document.getElementById('main')!;
        const ws = document.querySelector('.workspace') as HTMLElement;
        const seq = document.querySelector('#pattern') as HTMLElement;
        const grid = document.querySelector('#pattern .gridwrap') as HTMLElement;
        const pane = document.querySelector('.wspane.show') as HTMLElement;
        const box = (e: Element) => e.getBoundingClientRect();
        return {
          pageY: document.documentElement.scrollHeight > window.innerHeight,
          mainY: main.scrollHeight > main.clientHeight + 1,
          pageX: document.documentElement.scrollWidth > window.innerWidth,
          seqOverWs: box(seq).bottom > box(ws).top + 1,
          wsOff: box(ws).bottom > window.innerHeight + 1,
          gridRows: grid.scrollHeight <= grid.clientHeight + 1,
          paneX: pane.scrollWidth > pane.clientWidth + 1,
        };
      });
      expect(r.pageY, `${tab}: page scrolls vertically`).toBe(false);
      expect(r.mainY, `${tab}: work area scrolls vertically`).toBe(false);
      expect(r.pageX, `${tab}: page scrolls sideways`).toBe(false);
      expect(r.seqOverWs, `${tab}: the sequencer runs into the workspace`).toBe(false);
      expect(r.wsOff, `${tab}: the workspace is cut off`).toBe(false);
      expect(r.paneX, `${tab}: the panel scrolls sideways`).toBe(false);
      // every track is on show unless the window is short for this scale
      if (scale <= 1 && h >= 900) expect(r.gridRows, `${tab}: grid rows are cut off`).toBe(true);
    }
  });
}

test('keys open the workspace tab they belong to; the tab is remembered', async ({ page }) => {
  await boot(page);
  const tab = () => page.evaluate(() => (window as unknown as W).clatter.ui.workspace);
  expect(await tab()).toBe('sequence');
  await page.keyboard.press('c');
  expect(await tab()).toBe('transform');
  await page.keyboard.press('g');
  expect(await tab()).toBe('generate');
  await page.click('[data-test=ws-track]');
  expect(await tab()).toBe('track');
  await page.reload();
  await page.waitForSelector('#transport');
  expect(await tab()).toBe('track');
  await expect(page.locator('.wspane.show')).toHaveCount(1);
});

test('every palette keeps the grid and tabs legible', async ({ page }) => {
  await boot(page);
  const lum = (hex: string) => {
    const n = parseInt(hex.replace('#', ''), 16);
    const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f((n >> 16) & 255) + 0.7152 * f((n >> 8) & 255) + 0.0722 * f(n & 255);
  };
  const ratio = (a: string, b: string) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
  for (const name of ['Classic', 'Dark', 'Colour', 'Amber', 'C64']) {
    await page.locator('#menubar .menu', { hasText: 'VIEW' }).click();
    await page.locator('.dropdown .item', { hasText: 'Palette' }).click();
    await page.locator('.dialog').getByText(name, { exact: true }).first().click();
    await page.getByRole('button', { name: 'DONE' }).click();
    const c = await page.evaluate(() => {
      const cs = getComputedStyle(document.querySelector('#viewtabs .tab:not(.on)')!);
      const root = getComputedStyle(document.documentElement);
      const rgb = (s: string) => '#' + (s.match(/\d+/g) ?? []).slice(0, 3).map((x) => Number(x).toString(16).padStart(2, '0')).join('');
      return { tab: rgb(cs.color), tabBg: rgb(cs.backgroundColor), ink: root.getPropertyValue('--ink').trim(), paper: root.getPropertyValue('--paper').trim() };
    });
    expect(ratio(c.tab, c.tabBg), `${name}: view tab text on its tab`).toBeGreaterThan(3);
    expect(ratio(c.ink, c.paper), `${name}: ink on paper`).toBeGreaterThan(3);
  }
});

test('generate, variation, wildcard and a new kit change the music; undo restores it', async ({ page }) => {
  const errors = await boot(page);
  const snap = () => page.evaluate(() => JSON.stringify((window as unknown as W).clatter.pattern.gen));
  const a = await snap();
  await page.click('[data-test=ws-generate]');
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
  await page.click('[data-test=ws-transform]');
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
  // real clicks: a press on an item must not close the menu before the release
  await page.locator('#menubar .menu', { hasText: 'VIEW' }).click();
  await page.locator('.dropdown .item', { hasText: 'Palette' }).click();
  await expect(page.locator('.dialog')).toBeVisible();
  await page.locator('.dialog').getByText('Dark', { exact: true }).first().click();
  await expect.poll(bg).not.toEqual(before);
});

test('saves and opens a project; exports a WAV and a MIDI file', async ({ page }) => {
  await boot(page);
  await page.click('[data-test=ws-generate]');
  await page.click('[data-test=generate]');
  const saved = await page.evaluate(() => {
    const a = (window as unknown as W).clatter;
    const f = a.projectFile();
    return { text: new TextDecoder().decode(f.data), gen: JSON.stringify(a.pattern.gen) };
  });
  await page.click('[data-test=ws-generate]');
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

test('dialogs are set in readable body type with room between the lines', async ({ page }) => {
  await boot(page);
  await page.locator('#menubar .menu', { hasText: 'CLATTER' }).click();
  await page.locator('.dropdown .item', { hasText: 'About CLATTER' }).click();
  const about = await page.evaluate(() => {
    const ps = [...document.querySelectorAll<HTMLElement>('.dialog .scroll p')];
    return ps.map((p) => {
      const cs = getComputedStyle(p);
      return { size: parseFloat(cs.fontSize), line: parseFloat(cs.lineHeight), fits: p.scrollWidth <= p.clientWidth + 1 };
    });
  });
  expect(about.length).toBeGreaterThan(4);
  for (const p of about) {
    expect(p.size).toBeGreaterThanOrEqual(14);
    expect(p.line / p.size).toBeGreaterThanOrEqual(1.5);
    expect(p.fits).toBe(true);
  }
  // the legal notices are all still there
  const text = await page.locator('.dialog').innerText();
  for (const s of ['Erica Synths', 'GNU General Public License', 'no warranty', 'trademarks', 'modified version', 'LXR firmware', 'DOWNBEAT', 'The Breakery', 'emmm', 'Slop Factory Core', 'corresponding source']) expect(text).toContain(s);
  // the dialog fits the window and scrolls inside itself
  const box = await page.locator('.dialog').boundingBox();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
});

test('menu items work with ordinary clicks (About, Keys)', async ({ page }) => {
  await boot(page);
  await page.locator('#menubar .menu', { hasText: 'CLATTER' }).click();
  await page.locator('.dropdown .item', { hasText: 'About CLATTER' }).click();
  await expect(page.locator('.dialog')).toContainText('GNU General Public License');
  await page.keyboard.press('Escape');
  await expect(page.locator('.dialog')).toHaveCount(0);
  await page.locator('#menubar .menu', { hasText: 'HELP' }).click();
  await page.locator('.dropdown .item', { hasText: 'Keys and gestures' }).click();
  await expect(page.locator('.dialog')).toContainText('SPACE');
});
