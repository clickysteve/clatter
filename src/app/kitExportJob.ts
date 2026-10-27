/**
 * Background kit export: start, hand control back at once, render file by file while the
 * instrument stays usable, report progress, honour a cancel, and say so loudly when it fails.
 * One kit export at a time. Like ExportRunner it knows nothing of the DOM or the engine: it is
 * given the export function, a delivery function and a notifier, so the whole flow is testable.
 * It does not touch the pattern/audio ExportRunner.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
import { KitExportCancelled, resolveOptions, type KitExportOptions, type KitExportResult, type KitProgress } from '../export/kitExport';
import type { Project } from '../model/types';

export interface KitExportState {
  running: boolean;
  cancelling: boolean;
  progress: KitProgress | null;
  /** the last finished run: counts, or the error / cancellation */
  last: { ok: boolean; text: string; warnings: string[] } | null;
}

export interface KitExportJobDeps {
  /** the project as it is now (read once, at the start) */
  project(): Project;
  run(project: Project, options: KitExportOptions, onProgress: (p: KitProgress) => void, signal: AbortSignal): Promise<KitExportResult>;
  deliver(file: KitExportResult['file']): void;
  notify(text: string, level: 'info' | 'error'): void;
  status?(text: string): void;
}

export class KitExportJob {
  state: KitExportState = { running: false, cancelling: false, progress: null, last: null };
  /** told after every change of `state` */
  onChange?: () => void;
  private ctl: AbortController | null = null;

  constructor(private d: KitExportJobDeps) {}

  get busy(): boolean {
    return this.state.running;
  }

  start(options: KitExportOptions): { started: boolean; error?: string; done?: Promise<void> } {
    if (this.state.running) return { started: false, error: 'A KIT EXPORT IS ALREADY RUNNING' };
    const project = this.d.project();
    const v = resolveOptions(project, options);
    if ('error' in v) return { started: false, error: v.error };
    this.ctl = new AbortController();
    this.state = { running: true, cancelling: false, progress: null, last: null };
    this.onChange?.();
    return { started: true, done: this.run(project, options, this.ctl.signal) };
  }

  /** Stop at the next file; nothing is delivered. */
  cancel(): void {
    if (!this.state.running || this.state.cancelling) return;
    this.state = { ...this.state, cancelling: true };
    this.ctl?.abort();
    this.d.status?.('CANCELLING KIT EXPORT…');
    this.onChange?.();
  }

  private async run(project: Project, options: KitExportOptions, signal: AbortSignal): Promise<void> {
    let last = '';
    try {
      const res = await this.d.run(
        project,
        options,
        (p) => {
          this.state = { ...this.state, progress: p };
          const text = p.stage === 'analysing' ? `KIT EXPORT: ANALYSING ${p.instrument} ${p.done + 1}/${p.total}` : p.stage === 'rendering' ? `KIT EXPORT: ${p.instrument} ${p.done}/${p.total} ${p.file ?? ''}` : p.stage === 'packing' ? 'KIT EXPORT: PACKING THE ZIP…' : '';
          if (text && text !== last) {
            last = text;
            this.d.status?.(text);
          }
          this.onChange?.();
        },
        signal,
      );
      this.d.deliver(res.file);
      const w = res.warnings.length;
      const text = `EXPORTED ${res.file.name}: ${res.files} FILES${res.skipped.length ? `, ${res.skipped.length} SKIPPED` : ''}${w ? `, ${w} WARNING${w === 1 ? '' : 'S'} (SEE kit.json)` : ''}`;
      this.state = { ...this.state, last: { ok: true, text, warnings: res.warnings } };
      this.d.notify(text, w || res.skipped.length ? 'error' : 'info');
    } catch (err) {
      if (err instanceof KitExportCancelled || signal.aborted) {
        this.state = { ...this.state, last: { ok: false, text: 'KIT EXPORT CANCELLED: NOTHING WAS SAVED', warnings: [] } };
        this.d.notify('KIT EXPORT CANCELLED: NOTHING WAS SAVED', 'info');
      } else {
        const text = `KIT EXPORT FAILED: ${err instanceof Error ? err.message : String(err)}`;
        this.state = { ...this.state, last: { ok: false, text, warnings: [] } };
        this.d.notify(text, 'error');
      }
    } finally {
      this.state = { ...this.state, running: false, cancelling: false };
      this.ctl = null;
      this.onChange?.();
    }
  }
}
