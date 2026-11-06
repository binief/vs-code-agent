import * as fs from 'fs';
import * as path from 'path';
import { isInside, matchesGlob, toPosix } from '../paths';

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

export interface WalkSkipReasons {
  hidden: number;
  ignored: number;
  glob: number;
  oversized: number;
  outsideSymlink: number;
}

export interface WalkResult {
  entries: WalkEntry[];
  truncated: boolean;
  /** Files that were visited but filtered out by glob / hidden / size rules. */
  skipped: number;
  skipReasons: WalkSkipReasons;
  depthLimited: boolean;
  /** Directories or entries that could not be accessed. */
  inaccessible: number;
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
  let inaccessible = 0;
  const skipReasons: WalkSkipReasons = { hidden: 0, ignored: 0, glob: 0, oversized: 0, outsideSymlink: 0 };
  const skip = (reason: keyof WalkSkipReasons): void => { skipped++; skipReasons[reason]++; };

  while (queue.length > 0) {
    if (signal?.aborted) break;
    const { dir, depth } = queue.shift()!;
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      inaccessible++;
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
        let real: string;
        let st: fs.Stats;
        try {
          real = fs.realpathSync.native(abs);
          st = fs.statSync(abs);
        } catch {
          inaccessible++;
          continue;
        }
        if (!isInside(fs.realpathSync.native(rootAbs), real)) { skip('outsideSymlink'); continue; }
        if (st.isDirectory()) {
          if (!includeHidden && hidden) { skip('hidden'); continue; }
          if (depth + 1 <= maxDepth) queue.push({ dir: abs, depth: depth + 1 });
          else depthLimited = true;
          continue;
        }
        if (!includeHidden && hidden) {
          skip('hidden');
          continue;
        }
        if (maxFileBytes > 0 && st.size > maxFileBytes) {
          skip('oversized');
          continue;
        }
        if (!matchesGlob(rel, glob)) {
          skip('glob');
          continue;
        }
        if (entries.length >= maxEntries) { truncated = true; continue; }
        entries.push({ abs, rel, isDirectory: false, size: st.size });
        continue;
      }

      if (d.isDirectory()) {
        if (SKIP_DIRS.has(d.name)) {
          skip('ignored');
          continue;
        }
        if (!includeHidden && hidden) {
          skip('hidden');
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
        skip('hidden');
        continue;
      }
      let size = 0;
      try {
        size = fs.statSync(abs).size;
      } catch {
        inaccessible++;
        continue;
      }
      if (maxFileBytes > 0 && size > maxFileBytes) {
        skip('oversized');
        continue;
      }
      if (!matchesGlob(rel, glob)) {
        skip('glob');
        continue;
      }
      if (entries.length >= maxEntries) {
        truncated = true;
        continue;
      }
      entries.push({ abs, rel, isDirectory: false, size });
    }
  }

  return { entries, truncated, skipped, skipReasons, depthLimited, inaccessible };
}

/** Files only (used by the text search tool). */
export function walkFiles(options: WalkOptions): { files: WalkEntry[]; truncated: boolean; scanned: number; skipped: number; skipReasons: WalkSkipReasons; depthLimited: boolean; inaccessible: number } {
  const res = walk(options);
  return {
    files: res.entries.filter((e) => !e.isDirectory),
    truncated: res.truncated,
    scanned: res.entries.length,
    skipped: res.skipped,
    skipReasons: res.skipReasons,
    depthLimited: res.depthLimited,
    inaccessible: res.inaccessible,
  };
}
