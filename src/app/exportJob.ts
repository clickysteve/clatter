/**
 * Background export: validate the settings, start, hand control back at once, render while the
 * instrument stays usable, deliver the file when it is done and say so loudly when it fails.
 * One export at a time: a second request while one runs is refused, not queued, so an
 * accidental double click cannot produce two files.
 *
 * The runner knows nothing about the DOM or the engine: it is given a renderer, a delivery
 * function (the browser download) and a notifier, so the whole flow is testable.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */

export type ExportKind = 'master' | 'stems' | 'midi';

export interface ExportFile {
  name: string;
  data: Uint8Array;
  type: string;
}

/** What a fresh export dialog offers. */
export const EXPORT_DEFAULTS = { bars: 4, tail: 0 } as const;
export const EXPORT_LIMITS = { minBars: 1, maxBars: 256, minTail: 0, maxTail: 20 } as const;

export const EXPORT_LABEL: Record<ExportKind, string> = { master: 'MASTER WAV', stems: 'STEMS (ZIP)', midi: 'MIDI FILE' };

export type ExportCheck = { ok: true; bars: number; tail: number } | { ok: false; error: string };

/** Bars are whole numbers 1-256; the tail is 0-20 seconds (ignored for MIDI). */
export function validateExport(kind: ExportKind, bars: unknown, tail: unknown): ExportCheck {
  const b = typeof bars === 'number' ? bars : Number.NaN;
  if (!Number.isFinite(b) || !Number.isInteger(b) || b < EXPORT_LIMITS.minBars || b > EXPORT_LIMITS.maxBars) return { ok: false, error: `BARS MUST BE A WHOLE NUMBER FROM ${EXPORT_LIMITS.minBars} TO ${EXPORT_LIMITS.maxBars}` };
  if (kind === 'midi') return { ok: true, bars: b, tail: 0 };
  const t = typeof tail === 'number' ? tail : Number.NaN;
  if (!Number.isFinite(t) || t < EXPORT_LIMITS.minTail || t > EXPORT_LIMITS.maxTail) return { ok: false, error: `TAIL MUST BE FROM ${EXPORT_LIMITS.minTail} TO ${EXPORT_LIMITS.maxTail} SECONDS` };
  return { ok: true, bars: b, tail: t };
}

export interface ExportDeps {
  render(kind: ExportKind, bars: number, tail: number, onProgress: (fraction: number) => void): Promise<ExportFile> | ExportFile;
  /** hand the finished file to the user (the browser download) */
  deliver(file: ExportFile): void;
  /** a message the user must see; errors are not allowed to vanish into the status line */
  notify(text: string, level: 'info' | 'error'): void;
  /** progress text for the status line */
  status?(text: string): void;
}

export interface ExportStart {
  started: boolean;
  /** why nothing started (invalid settings, or an export is already running) */
  error?: string;
  /** resolves when the export has finished (delivered or failed); never rejects */
  done?: Promise<void>;
}

export class ExportRunner {
  private running = false;
  /** a change listener for the toolbar (the EXPORT button disables itself while one runs) */
  onChange?: () => void;

  constructor(private d: ExportDeps) {}

  get busy(): boolean {
    return this.running;
  }

  start(kind: ExportKind, bars: unknown, tail: unknown): ExportStart {
    const v = validateExport(kind, bars, tail);
    if (!v.ok) return { started: false, error: v.error };
    if (this.running) return { started: false, error: 'AN EXPORT IS ALREADY RUNNING' };
    this.running = true;
    this.onChange?.();
    return { started: true, done: this.run(kind, v.bars, v.tail) };
  }

  private async run(kind: ExportKind, bars: number, tail: number): Promise<void> {
    const label = EXPORT_LABEL[kind];
    try {
      this.d.status?.(`RENDERING ${label}…`);
      let last = -1;
      const file = await this.d.render(kind, bars, tail, (f) => {
        const pct = Math.round(Math.max(0, Math.min(1, f)) * 100);
        if (pct !== last) {
          last = pct;
          this.d.status?.(`RENDERING ${label} ${pct}%`);
        }
      });
      this.d.deliver(file);
      this.d.notify(`EXPORTED ${file.name}`, 'info');
    } catch (err) {
      this.d.notify(`EXPORT FAILED: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      this.running = false;
      this.onChange?.();
    }
  }
}
