/** The export runner and defaults, and the two AMFAS stock palettes. */
import { describe, expect, it } from 'vitest';
import { EXPORT_DEFAULTS, ExportRunner, validateExport, type ExportFile } from '../src/app/exportJob';
import { defaultPrefs } from '../src/app/prefs';
import { AMFAS, AMFAS_INVERT, PALETTE_CONFIG } from '../src/ui/palette';

const file: ExportFile = { name: 'x.wav', data: new Uint8Array(4), type: 'audio/wav' };
function runner(render: () => Promise<ExportFile> | ExportFile) {
  const log: string[] = [];
  const r = new ExportRunner({ render: async () => render(), deliver: (f) => log.push(`deliver ${f.name}`), notify: (t, l) => log.push(`${l}: ${t}`) });
  return { r, log };
}

describe('export defaults and validation', () => {
  it('offers 4 bars and no tail', () => {
    expect(EXPORT_DEFAULTS).toEqual({ bars: 4, tail: 0 });
    const d = defaultPrefs();
    expect([d.exportBars, d.exportTail]).toEqual([4, 0]);
  });
  it('rejects bad bars and tails, ignores the tail for MIDI', () => {
    for (const b of [0, 257, 1.5, Number.NaN, '4', undefined]) expect(validateExport('master', b, 0).ok).toBe(false);
    for (const t of [-1, 21, Number.NaN, '1']) expect(validateExport('master', 4, t).ok).toBe(false);
    expect(validateExport('master', 4, 0)).toEqual({ ok: true, bars: 4, tail: 0 });
    expect(validateExport('midi', 4, 'junk')).toEqual({ ok: true, bars: 4, tail: 0 });
  });
});

describe('export runner', () => {
  it('starts at once, delivers the file and says so', async () => {
    const { r, log } = runner(() => file);
    const s = r.start('master', 4, 0);
    expect(s.started).toBe(true);
    expect(r.busy).toBe(true);
    await s.done;
    expect(r.busy).toBe(false);
    expect(log).toEqual(['deliver x.wav', 'info: EXPORTED x.wav']);
  });
  it('refuses a second export while one runs, so a double click makes one file', async () => {
    let release!: () => void;
    const { r, log } = runner(() => new Promise((res) => (release = () => res(file))));
    const a = r.start('master', 4, 0);
    const b = r.start('master', 4, 0);
    expect(b.started).toBe(false);
    expect(b.error).toMatch(/ALREADY/);
    release();
    await a.done;
    expect(log.filter((l) => l.startsWith('deliver'))).toHaveLength(1);
    expect(r.start('master', 4, 0).started).toBe(true);
  });
  it('reports a failure visibly and can be used again', async () => {
    const { r, log } = runner(() => {
      throw new Error('boom');
    });
    await r.start('stems', 4, 0).done;
    expect(log).toEqual(['error: EXPORT FAILED: boom']);
    expect(r.busy).toBe(false);
  });
  it('does not start on invalid settings', () => {
    const { r } = runner(() => file);
    const s = r.start('master', 0, 0);
    expect(s.started).toBe(false);
    expect(s.error).toBeTruthy();
    expect(r.busy).toBe(false);
  });
});

describe('AMFAS palettes', () => {
  it('are built in, with the exact colours', () => {
    const ids = PALETTE_CONFIG.builtIns.map((p) => p.id);
    expect(ids).toContain('amfas');
    expect(ids).toContain('amfas-invert');
    expect(AMFAS.colors).toEqual({ desktop: '#ff6600', paper: '#fafafa', ink: '#1e1c1a', dim: '#4f4f4f', activity: '#d23c1e', selection: '#ff6600', rhythm: '#000000', destruction: '#ff0000', sound: '#c00202', perform: '#002db3', transport: '#ffa200' });
    expect(AMFAS_INVERT.colors).toEqual({ desktop: '#ff6600', paper: '#000000', ink: '#ff643d', dim: '#f54242', activity: '#d23c1e', selection: '#ff6600', rhythm: '#ffffff', destruction: '#ff0000', sound: '#ffffff', perform: '#002db3', transport: '#ffa200' });
    expect(AMFAS_INVERT.name).toBe('AMFAS INVERT');
  });
});
