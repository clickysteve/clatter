/**
 * Undo and redo: snapshots of the musical document (never recomputed: an undo restores
 * exactly what was there, including generated material and its seeds). A drag is one step:
 * begin() at the start, commit() at the end.
 *
 * Copyright (C) 2026 The CLATTER contributors. SPDX-License-Identifier: GPL-3.0-only
 */
export interface HistoryEntry<T> {
  label: string;
  state: T;
}

export class History<T> {
  private undoStack: HistoryEntry<T>[] = [];
  private redoStack: HistoryEntry<T>[] = [];
  private open: HistoryEntry<T> | null = null;
  /** nested gestures (a drag around a setter that is itself one step) close at the outermost */
  private depth = 0;

  constructor(
    private capture: () => T,
    private restore: (s: T) => void,
    private limit = 80,
  ) {}

  /** Record the state before a change. */
  push(label: string): void {
    if (this.open) return;
    this.undoStack.push({ label, state: this.capture() });
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
  }

  /** A gesture that may change things many times: one undo step. */
  begin(label: string): void {
    this.depth++;
    if (this.open) return;
    this.open = { label, state: this.capture() };
  }

  /** Rename the gesture that is open (it turned out to be something else than it started as). */
  relabel(label: string): void {
    if (this.open) this.open.label = label;
  }

  commit(changed = true): void {
    if (this.depth > 0) this.depth--;
    if (!this.open || this.depth > 0) return;
    if (changed) {
      this.undoStack.push(this.open);
      if (this.undoStack.length > this.limit) this.undoStack.shift();
      this.redoStack = [];
    }
    this.open = null;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  get undoLabel(): string {
    return this.undoStack[this.undoStack.length - 1]?.label ?? '';
  }

  get redoLabel(): string {
    return this.redoStack[this.redoStack.length - 1]?.label ?? '';
  }

  undo(): string | null {
    const e = this.undoStack.pop();
    if (!e) return null;
    this.redoStack.push({ label: e.label, state: this.capture() });
    this.restore(e.state);
    return e.label;
  }

  redo(): string | null {
    const e = this.redoStack.pop();
    if (!e) return null;
    this.undoStack.push({ label: e.label, state: this.capture() });
    this.restore(e.state);
    return e.label;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.open = null;
    this.depth = 0;
  }
}
