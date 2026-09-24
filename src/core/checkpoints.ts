import * as fs from 'fs';
import * as path from 'path';
import { normalizeEol } from './lineEndings';

export interface FileSnapshot {
  abs: string;
  rel: string;
  existed: boolean;
  /** Original content when `existed`; empty string otherwise. */
  content: string;
}

export interface RevertReport {
  restored: string[];
  deleted: string[];
  failed: { path: string; error: string }[];
}

/**
 * Remembers the pre-task content of every file the agent touches, so a whole
 * task can be undone with one command (including files that did not exist).
 *
 * One store instance backs one session; `begin()` marks a new task and
 * `revertAll()` rolls the workspace back to the start of that task.
 */
export class CheckpointStore {
  private snapshots = new Map<string, FileSnapshot>();
  private label = '';

  constructor(private readonly enabled = true) {}

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Start a new checkpoint group (called at the beginning of every task). */
  begin(label: string): void {
    this.snapshots.clear();
    this.label = label;
  }

  /** Paths touched since `begin()`, in the order they were first seen. */
  touched(): FileSnapshot[] {
    return [...this.snapshots.values()];
  }

  relativePaths(): string[] {
    return this.touched().map((s) => s.rel);
  }

  get taskLabel(): string {
    return this.label;
  }

  /** Record a file's original state; no-op if this path was already recorded. */
  record(abs: string, rel: string): void {
    if (!this.enabled || this.snapshots.has(abs)) return;
    let existed = false;
    let content = '';
    try {
      const stat = fs.statSync(abs);
      if (stat.isFile()) {
        existed = true;
        content = fs.readFileSync(abs, 'utf8');
      }
    } catch {
      existed = false;
    }
    this.snapshots.set(abs, { abs, rel, existed, content });
  }

  /** For file creation: the file must not exist afterwards on revert. */
  recordAsAbsent(abs: string, rel: string): void {
    if (!this.enabled || this.snapshots.has(abs)) return;
    this.snapshots.set(abs, { abs, rel, existed: false, content: '' });
  }

  async revertAll(): Promise<RevertReport> {
    const report: RevertReport = { restored: [], deleted: [], failed: [] };
    // Reverse order so nested/created directories unwind cleanly.
    const all = this.touched().reverse();
    for (const snap of all) {
      try {
        if (snap.existed) {
          fs.mkdirSync(path.dirname(snap.abs), { recursive: true });
          fs.writeFileSync(snap.abs, snap.content, 'utf8');
          report.restored.push(snap.rel);
        } else if (fs.existsSync(snap.abs)) {
          fs.rmSync(snap.abs, { force: true });
          report.deleted.push(snap.rel);
        }
      } catch (err) {
        report.failed.push({ path: snap.rel, error: (err as Error).message });
      }
    }
    if (report.failed.length === 0) this.snapshots.clear();
    return report;
  }

  clear(): void {
    this.snapshots.clear();
  }
}

/** Write helper used by the file tools; returns the previous content (or null). */
export function readIfExists(abs: string): string | null {
  try {
    if (!fs.statSync(abs).isFile()) return null;
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

/** Very small unified-diff generator, good enough for approval previews. */
export function diffPreview(relPath: string, oldText: string | null, newText: string): string {
  // Approval previews should not show a change merely because the file uses
  // CRLF while model output uses LF.
  const oldLines = normalizeEol(oldText ?? '').split('\n');
  const newLines = normalizeEol(newText).split('\n');
  const header = oldText === null ? `--- /dev/null\n+++ b/${relPath}` : `--- a/${relPath}\n+++ b/${relPath}`;

  // Trim common head/tail to keep the preview readable.
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++;
  let endOld = oldLines.length - 1;
  let endNew = newLines.length - 1;
  while (endOld >= start && endNew >= start && oldLines[endOld] === newLines[endNew]) {
    endOld--;
    endNew--;
  }

  const context = 3;
  const from = Math.max(0, start - context);
  const oldTo = Math.min(oldLines.length - 1, endOld + context);
  const newTo = Math.min(newLines.length - 1, endNew + context);

  const body: string[] = [];
  body.push(`@@ -${from + 1},${oldTo - from + 1} +${from + 1},${newTo - from + 1} @@`);
  for (let i = from; i <= oldTo; i++) {
    const line = oldLines[i];
    const changed = i < start || i > endOld;
    body.push(changed ? ` ${line}` : `-${line}`);
  }
  for (let i = from; i <= newTo; i++) {
    const changed = i < start || i > endNew;
    if (changed) continue; // already emitted as context
    body.push(`+${newLines[i]}`);
  }

  const maxLines = 200;
  const clipped = body.length > maxLines
    ? [...body.slice(0, maxLines), `\u2026 ${body.length - maxLines} more diff lines omitted`]
    : body;
  return `${header}\n${clipped.join('\n')}`;
}
