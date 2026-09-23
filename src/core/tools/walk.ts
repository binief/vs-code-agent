import * as fs from 'fs';
import * as path from 'path';
import { matchesGlob, toPosix } from '../paths';

/** Directories the tools refuse to walk into (build output, deps, VCS). */
export const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'out',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.venv',
  'venv',
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  'target',
  'vendor',
  '.gradle',
  '.idea',
  '.terraform',
  '.cache',
  'Pods',
  'obj',
  'bin',
  '.vscode-test',
]);

export interface WalkEntry {
  abs: string;
  rel: string;
  isDirectory: boolean;
  size: number;
}

export interface WalkOptions {
  root: string;
  /** Absolute directory to start from. Defaults to the root. */
  start?: string;
  glob?: string;
  maxDepth?: number;
  maxEntries?: number;
  includeHidden?: boolean;
  /** Skip files larger than this (0 = no limit). */
  maxFileBytes?: number;
  signal?: AbortSignal;
}

export interface WalkResult {
  entries: WalkEntry[];
  truncated: boolean;
  /** Files that were visited but filtered out by glob / hidden / size rules. */
  skipped: number;
  depthLimited: boolean;
}

/**
 * Deterministic, dependency-free directory walk.
 * Skips {@link SKIP_DIRS}, hidden entries (unless asked), symlinked directories
 * (so the walk cannot wander outside the workspace) and oversized files.
 */
export function walk(options: WalkOptions): WalkResult {
  const {
    root,
    start = root,
    glob,
    maxDepth = 12,
    maxEntries = 400,
    includeHidden = false,
    maxFileBytes = 0,
    signal,
  } = options;

  const rootAbs = path.resolve(root);
  const entries: WalkEntry[] = [];
  const queue: { dir: string; depth: number }[] = [{ dir: path.resolve(start), depth: 0 }];
  let truncated = false;
  let skipped = 0;
  let depthLimited = false;

  while (queue.length > 0) {
    if (signal?.aborted) break;
    const { dir, depth } = queue.shift()!;
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    dirents.sort((a, b) => a.name.localeCompare(b.name));

    for (const d of dirents) {
      if (signal?.aborted) break;
      const abs = path.join(dir, d.name);
      const rel = toPosix(path.relative(rootAbs, abs));
      const hidden = d.name.startsWith('.');

      if (d.isSymbolicLink()) {
        // Follow only if the link stays inside the workspace and points at a file.
        const real = fs.realpathSync.native(abs);
        const realRoot = fs.realpathSync.native(rootAbs);
        if (!real.startsWith(realRoot)) continue;
        const st = fs.statSync(abs);
        if (st.isDirectory()) {
          if (depth + 1 <= maxDepth) queue.push({ dir: abs, depth: depth + 1 });
          continue;
        }
        if (!includeHidden && hidden) {
          skipped++;
          continue;
        }
        if (maxFileBytes > 0 && st.size > maxFileBytes) {
          skipped++;
          continue;
        }
        if (!matchesGlob(rel, glob)) {
          skipped++;
          continue;
        }
        entries.push({ abs, rel, isDirectory: false, size: st.size });
        continue;
      }

      if (d.isDirectory()) {
        if (SKIP_DIRS.has(d.name)) {
          skipped++;
          continue;
        }
        if (!includeHidden && hidden) {
          skipped++;
          continue;
        }
        if (depth + 1 > maxDepth) {
          depthLimited = true;
          continue;
        }
        if (entries.length >= maxEntries) {
          truncated = true;
          continue;
        }
        entries.push({ abs, rel, isDirectory: true, size: 0 });
        queue.push({ dir: abs, depth: depth + 1 });
        continue;
      }

      if (!d.isFile()) continue;
      if (!includeHidden && hidden) {
        skipped++;
        continue;
      }
      let size = 0;
      try {
        size = fs.statSync(abs).size;
      } catch {
        continue;
      }
      if (maxFileBytes > 0 && size > maxFileBytes) {
        skipped++;
        continue;
      }
      if (!matchesGlob(rel, glob)) {
        skipped++;
        continue;
      }
      if (entries.length >= maxEntries) {
        truncated = true;
        continue;
      }
      entries.push({ abs, rel, isDirectory: false, size });
    }
  }

  return { entries, truncated, skipped, depthLimited };
}

/** Files only (used by the text search tool). */
export function walkFiles(options: WalkOptions): { files: WalkEntry[]; truncated: boolean; scanned: number } {
  const res = walk(options);
  return {
    files: res.entries.filter((e) => !e.isDirectory),
    truncated: res.truncated,
    scanned: res.entries.length,
  };
}
