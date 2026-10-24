/**
 * Agent instruction files.
 *
 * This module only *finds and renders* instructions. It deliberately contains
 * no rules of its own: the harness ships no built-in prompt, so whatever the
 * model is told to do has to come from one of these files (or from the user).
 *
 * File names are not fixed. A file is treated as instructions when any of these
 * is true:
 *   - its name is listed in `agentFiles.names` (`AGENTS.md`, `agent.md`, …),
 *   - its path matches one of `agentFiles.patterns` (`*.instructions.md`, …),
 *   - it is a Markdown file inside a dedicated instruction folder
 *     (`.agents/`, `.agent/`, `.github/instructions/`, `.vscode/instructions/`),
 *     whatever it is called — `code-review.md`, `test.md`, …,
 *   - it was listed explicitly in `agentFiles.extraPaths`.
 *
 * Discovery is deterministic and bounded:
 *   - the user-level file (`agentFiles.userPath`) when enabled, then
 *   - workspace files from the root outwards, then
 *   - files added explicitly from outside the workspace.
 *
 * An optional YAML front matter block (`description`, `applyTo`) is used as a
 * label in the prompt; it is not sent as instruction text.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { normalizeEol } from './lineEndings';
import { formatBytes, globToRegExp, isInside, toPosix } from './paths';
import { SKIP_DIRS } from './tools/walk';
import type { AgentFilesConfig } from './types';

export interface AgentFileInfo {
  /** Absolute path on disk. */
  path: string;
  /** Path shown to the user and in the prompt (`agent.md`, `~/…`, `/abs/…`). */
  displayPath: string;
  /** Workspace-relative directory the file governs; `''` when it applies to the whole workspace. */
  scope: string;
  origin: 'user' | 'workspace';
  /** Size on disk. */
  bytes: number;
  /** True when only the first `maxBytes` of the file were read. */
  truncated: boolean;
  content: string;
  /** `description:` from optional front matter. */
  description?: string;
  /** `applyTo:` from optional front matter, e.g. `**\/*.ts`. */
  applyTo?: string;
}

export interface AgentFileSkip {
  path: string;
  reason: string;
}

export interface AgentFilesResult {
  enabled: boolean;
  files: AgentFileInfo[];
  skipped: AgentFileSkip[];
  names: string[];
  patterns: string[];
  root: string;
  scanNested: boolean;
  maxDepth: number;
  includeUser: boolean;
  userPath: string;
  totalBytes: number;
  /** The pinned selection this result was filtered with, when there is one. */
  selection?: string[];
  /** Files found before the selection was applied (equal to `files.length` by default). */
  available?: number;
}

/** A filtered result, plus the selected paths that no longer matched anything. */
export interface SelectedAgentFiles extends AgentFilesResult {
  missing: string[];
}

export interface DiscoverAgentFilesOptions {
  root: string;
  config: AgentFilesConfig;
  /** Workspace-relative or absolute files the editor has open. */
  focusPaths?: string[];
}

/** Directories under the workspace root that are always searched for agent files. */
export const AGENT_CONFIG_DIRS = ['.github', '.vscode', '.agents', '.agent'] as const;

/**
 * Folders where *every* Markdown file is an instruction, whatever its name.
 * This is what makes `code-review.md`, `test.md`, … work without configuration.
 */
export const INSTRUCTION_DIRS = ['.agents', '.agent', '.github/instructions', '.vscode/instructions'] as const;

const HIDDEN_SCAN_DIRS = new Set<string>(AGENT_CONFIG_DIRS);

/** How deep a dedicated instruction folder is walked for Markdown files. */
const INSTRUCTION_DIR_MAX_DEPTH = 4;

function resolveHome(input: string): string {
  if (!input) return os.homedir();
  if (input === '~') return os.homedir();
  if (input.startsWith('~/') || input.startsWith('~\\')) return path.resolve(os.homedir(), input.slice(2));
  return path.isAbsolute(input) ? path.resolve(input) : path.resolve(os.homedir(), input);
}

function resolveExtra(root: string, input: string): string {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/') || input.startsWith('~\\')) return path.resolve(os.homedir(), input.slice(2));
  return path.isAbsolute(input) ? path.resolve(input) : path.resolve(root, input);
}

function displayPathFor(root: string, abs: string): string {
  const rootAbs = path.resolve(root);
  if (isInside(rootAbs, abs)) return toPosix(path.relative(rootAbs, path.resolve(abs))) || path.basename(abs);
  const home = os.homedir();
  if (isInside(home, abs)) return `~/${toPosix(path.relative(home, path.resolve(abs)))}`;
  return toPosix(abs);
}

function relativeTo(root: string, abs: string): string {
  return toPosix(path.relative(path.resolve(root), path.resolve(abs)));
}

function isInstructionDir(root: string, dir: string): boolean {
  if (!isInside(root, dir)) return false;
  const rel = relativeTo(root, dir).toLowerCase();
  return INSTRUCTION_DIRS.some((candidate) => {
    const wanted = candidate.toLowerCase();
    return rel === wanted || rel.endsWith(`/${wanted}`);
  });
}

/**
 * A file in `.github/`, `.agents/`, … describes the whole workspace; the folder
 * is storage, not scope. Only a file in an ordinary subdirectory scopes its
 * rules to that subtree.
 */
function scopeFor(root: string, abs: string): string {
  const rootAbs = path.resolve(root);
  if (!isInside(rootAbs, abs)) return '';
  const relDir = toPosix(path.dirname(relativeTo(root, abs)));
  if (relDir === '.') return '';
  const segments = relDir.split('/');
  // `.github/instructions/x.md` and `.agents/workflows/x.md` hold workspace-wide
  // rules: the folders say where the file lives, not what it applies to. Inside
  // a package, `packages/api/.agents/x.md` scopes to that package.
  const configAt = segments.findIndex((segment) => HIDDEN_SCAN_DIRS.has(segment));
  if (configAt !== -1) return segments.slice(0, configAt).join('/');
  return relDir;
}

function fileKey(abs: string): string {
  try {
    const real = fs.realpathSync.native(abs);
    return process.platform === 'win32' ? real.toLowerCase() : real;
  } catch {
    return process.platform === 'win32' ? path.resolve(abs).toLowerCase() : path.resolve(abs);
  }
}

export interface FileMatchOptions {
  root: string;
  dir: string;
  names: string[];
  patterns: string[];
  /** True inside a dedicated instruction folder: every `.md` counts. */
  anyMarkdown?: boolean;
}

/** True when `abs` matches one of the workspace-relative glob `patterns`. */
function matchesAnyPattern(root: string, abs: string, patterns: string[]): boolean {
  let rel = relativeTo(root, abs);
  // Files configured from outside the workspace match on their bare name.
  if (rel.startsWith('..')) rel = path.basename(abs);
  return patterns.some((pattern) => globToRegExp(toPosix(pattern)).test(rel));
}

/**
 * Literal directory a pattern starts in: `docs/**\/*.md` -> `docs`.
 * An empty string means "the workspace root".
 */
function patternDirectory(pattern: string): string {
  const literal = pattern.split(/[*?{]/)[0];
  if (!literal.includes('/')) return '';
  const dir = literal.slice(0, literal.lastIndexOf('/'));
  return dir.replace(/\/$/, '');
}

/** Patterns anchored with `**` have to walk the tree; plain names do not. */
function patternNeedsTree(pattern: string): boolean {
  return /^\*\*\//.test(pattern) || pattern.includes('/**/');
}

/** Files in `dir` that are instruction files, one per matching name. */
function matchingFiles(options: FileMatchOptions): string[] {
  const { root, dir, names, patterns, anyMarkdown = false } = options;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const wantedNames = new Set(names.map((name) => name.toLowerCase()));
  const picked = new Map<string, string>();
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const lower = entry.name.toLowerCase();
    let wanted = anyMarkdown && lower.endsWith('.md');
    if (!wanted && wantedNames.has(lower)) wanted = true;
    if (!wanted && patterns.length > 0) {
      const abs = path.join(dir, entry.name);
      wanted = matchesAnyPattern(root, abs, patterns);
    }
    if (!wanted) continue;
    const abs = path.join(dir, entry.name);
    try {
      if (!fs.statSync(abs).isFile()) continue;
    } catch {
      continue;
    }
    // A name matches once, but a pattern or an instruction folder may also pick
    // up a file under a different name: key by real path so nothing duplicates.
    picked.set(fileKey(abs), abs);
  }
  return [...picked.values()];
}

interface ReadResult {
  content: string;
  bytes: number;
  truncated: boolean;
}

/** Read at most `maxBytes` from a file, normalising newlines to LF. */
function readLimited(abs: string, maxBytes: number): ReadResult | undefined {
  let fd: number | undefined;
  try {
    const stat = fs.statSync(abs);
    if (!stat.isFile()) return undefined;
    const length = Math.max(0, Math.min(stat.size, maxBytes));
    fd = fs.openSync(abs, 'r');
    const buffer = Buffer.alloc(length);
    if (length > 0) fs.readSync(fd, buffer, 0, length, 0);
    let content = buffer.toString('utf8');
    // Cut a multi-byte character at the cap rather than emit a replacement char.
    if (stat.size > length && content.endsWith('\uFFFD')) content = content.slice(0, -1);
    return { content: normalizeEol(content), bytes: stat.size, truncated: stat.size > length };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Nothing useful to do.
      }
    }
  }
}

/**
 * Split an optional `---` front matter block off the top of a file.
 *
 * Only `description` and `applyTo`/`scope` are recognised. A block with no
 * recognised key is left in place, so a Markdown horizontal rule is never eaten.
 */
export function parseAgentFrontMatter(text: string): {
  description?: string;
  applyTo?: string;
  body: string;
} {
  const lines = text.split('\n');
  if ((lines[0] ?? '').trim() !== '---') return { body: text };
  let end = -1;
  for (let i = 1; i < lines.length && i <= 40; i += 1) {
    if (lines[i].trim() === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) return { body: text };

  let description: string | undefined;
  let applyTo: string | undefined;
  for (const raw of lines.slice(1, end)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line
      .slice(0, colon)
      .trim()
      .toLowerCase()
      .replace(/[-_\s]/g, '');
    const value = line
      .slice(colon + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
    if (!value) continue;
    if (key === 'description') description = value;
    else if (key === 'applyto' || key === 'scope') applyTo = value;
  }
  if (!description && !applyTo) return { body: text };
  return { description, applyTo, body: lines.slice(end + 1).join('\n').replace(/^\n+/, '') };
}

/**
 * Find the instruction files that apply to a task. Never throws: unreadable
 * files and directories are reported in `skipped`.
 */
export function discoverAgentFiles(options: DiscoverAgentFilesOptions): AgentFilesResult {
  const root = path.resolve(options.root);
  const config = options.config;
  const names = Array.isArray(config.names) ? config.names.map((name) => name.trim()).filter(Boolean) : [];
  const patterns = Array.isArray(config.patterns) ? config.patterns.map((pattern) => pattern.trim()).filter(Boolean) : [];
  const maxDepth = Number.isFinite(config.maxDepth) ? Math.max(0, Math.trunc(config.maxDepth)) : 2;
  const result: AgentFilesResult = {
    enabled: Boolean(config.enabled),
    files: [],
    skipped: [],
    names,
    patterns,
    root,
    scanNested: Boolean(config.scanNested),
    maxDepth,
    includeUser: Boolean(config.includeUser),
    userPath: config.userPath ?? '',
    totalBytes: 0,
  };
  if (!result.enabled) return result;

  const maxBytes = Number.isFinite(config.maxBytes) ? Math.max(1, Math.trunc(config.maxBytes)) : 64 * 1024;
  const totalBudget = Number.isFinite(config.maxTotalBytes)
    ? Math.max(1, Math.trunc(config.maxTotalBytes))
    : 128 * 1024;
  const seen = new Set<string>();
  const candidates: { abs: string; origin: 'user' | 'workspace'; explicit: boolean }[] = [];
  let realRoot: string | undefined;
  try {
    realRoot = fs.realpathSync.native(root);
  } catch {
    realRoot = root;
  }

  const addCandidate = (abs: string, origin: 'user' | 'workspace', explicit = false): void => {
    // A symlink inside the workspace may not smuggle in a file from outside it.
    if (!explicit && origin === 'workspace' && realRoot) {
      let real: string;
      try {
        real = fs.realpathSync.native(abs);
      } catch {
        result.skipped.push({ path: displayPathFor(root, abs), reason: 'unreadable symlink' });
        return;
      }
      if (!isInside(realRoot, real)) {
        result.skipped.push({ path: displayPathFor(root, abs), reason: 'symlink escapes the workspace' });
        return;
      }
    }
    const key = fileKey(abs);
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ abs, origin, explicit });
  };

  if (config.includeUser && config.userPath) {
    const userAbs = resolveHome(config.userPath);
    if (fs.existsSync(userAbs)) addCandidate(userAbs, 'user');
    else result.skipped.push({ path: displayPathFor(root, userAbs), reason: 'user agent file not found' });
  }

  /** Scan one directory non-recursively. */
  const scanDirectory = (dir: string, anyMarkdown = false): void => {
    for (const abs of matchingFiles({ root, dir, names, patterns, anyMarkdown })) {
      addCandidate(abs, 'workspace');
    }
  };

  /** Walk a dedicated instruction folder: every Markdown file counts. */
  const scanInstructionTree = (dir: string): void => {
    const queue: { dir: string; depth: number }[] = [{ dir, depth: 0 }];
    let visited = 0;
    while (queue.length > 0 && visited < 2000) {
      const current = queue.shift()!;
      visited += 1;
      scanDirectory(current.dir, true);
      if (current.depth >= INSTRUCTION_DIR_MAX_DEPTH) continue;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(current.dir, { withFileTypes: true });
      } catch {
        continue;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
        if (entry.name.startsWith('.')) continue;
        queue.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 });
      }
    }
  };

  const visitedDirs = new Set<string>();
  const visit = (dir: string): boolean => {
    const key = path.resolve(dir);
    if (visitedDirs.has(key)) return false;
    visitedDirs.add(key);
    if (isInstructionDir(root, dir)) {
      scanInstructionTree(dir);
      return true;
    }
    scanDirectory(dir);
    // A package may keep its own `.agents/` next to its code; those rules apply
    // to that package only.
    for (const hidden of ['.agents', '.agent']) {
      const child = path.join(dir, hidden);
      try {
        if (fs.statSync(child).isDirectory()) {
          visitedDirs.add(path.resolve(child));
          scanInstructionTree(child);
        }
      } catch {
        // Not present.
      }
    }
    return true;
  };

  for (const extra of config.extraPaths ?? []) {
    if (!extra || !extra.trim()) continue;
    const abs = resolveExtra(root, extra.trim());
    if (!fs.existsSync(abs)) {
      result.skipped.push({ path: displayPathFor(root, abs), reason: 'extra path not found' });
      continue;
    }
    let isDirectory = false;
    try {
      isDirectory = fs.statSync(abs).isDirectory();
    } catch {
      // Treated as unreadable below.
    }
    if (isDirectory) {
      // An explicitly configured directory is scanned for the configured names
      // and patterns; a dedicated instruction folder also takes any `.md`.
      if (isInstructionDir(root, abs)) {
        scanInstructionTree(abs);
        continue;
      }
      const queue: { dir: string; depth: number }[] = [{ dir: abs, depth: 0 }];
      let visited = 0;
      while (queue.length > 0 && visited < 1000) {
        const { dir, depth } = queue.shift()!;
        visited += 1;
        for (const file of matchingFiles({ root, dir, names, patterns })) addCandidate(file, 'workspace', true);
        if (depth >= result.maxDepth) continue;
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
          if (entry.name.startsWith('.') && !HIDDEN_SCAN_DIRS.has(entry.name)) continue;
          queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
        }
      }
      continue;
    }
    addCandidate(abs, 'workspace', true);
  }

  // Root and the conventional config directories are always checked.
  visit(root);
  for (const name of HIDDEN_SCAN_DIRS) {
    const dir = path.join(root, name);
    try {
      if (fs.statSync(dir).isDirectory()) visit(dir);
    } catch {
      // Not present.
    }
  }
  // `.github/instructions` and `.vscode/instructions` are not config dirs
  // themselves, so open them explicitly.
  for (const name of INSTRUCTION_DIRS) {
    const dir = path.join(root, name);
    try {
      if (fs.statSync(dir).isDirectory()) visit(dir);
    } catch {
      // Not present.
    }
  }

  /** Breadth-first walk of `start` down to `depthLimit`, visiting each directory. */
  const walkDirs = (start: string, depthLimit: number): void => {
    // The start directory itself may hold matching files (`docs/rules/*.md`).
    visit(start);
    if (depthLimit <= 0) return;
    const queue: { dir: string; depth: number }[] = [{ dir: start, depth: 0 }];
    let visited = 0;
    while (queue.length > 0 && visited < 5000) {
      const { dir, depth } = queue.shift()!;
      visited += 1;
      if (depth >= depthLimit) continue;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (SKIP_DIRS.has(entry.name)) continue;
        if (entry.name.startsWith('.') && !HIDDEN_SCAN_DIRS.has(entry.name)) continue;
        visit(path.join(dir, entry.name));
        queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
      }
    }
  };

  // Patterns may point at a directory (`docs/*.md`) or at the whole tree
  // (`**/rules/*.md`). What a plain `*.md` pattern needs is only the root,
  // which is already visited.
  let patternTree = false;
  const patternDirs = new Set<string>();
  for (const pattern of patterns) {
    if (patternNeedsTree(pattern)) patternTree = true;
    const dir = patternDirectory(pattern);
    if (dir) patternDirs.add(dir);
  }
  for (const rel of patternDirs) {
    const abs = resolveExtra(root, rel);
    if (!isInside(root, abs)) continue;
    try {
      if (fs.statSync(abs).isDirectory()) walkDirs(abs, Math.max(1, result.maxDepth));
    } catch {
      // A directory that does not exist cannot hold instructions.
    }
  }
  if (patternTree) walkDirs(root, Math.max(1, result.maxDepth));

  // Optional breadth-first walk of the whole tree.
  if (result.scanNested && result.maxDepth > 0) walkDirs(root, result.maxDepth);

  // Ancestors of open editors apply even when they are outside `maxDepth`.
  for (const focus of options.focusPaths ?? []) {
    if (!focus || !focus.trim()) continue;
    const abs = path.isAbsolute(focus) ? path.resolve(focus) : path.resolve(root, focus);
    if (!isInside(root, abs)) continue;
    let dir: string;
    try {
      dir = fs.statSync(abs).isDirectory() ? abs : path.dirname(abs);
    } catch {
      dir = path.dirname(abs);
    }
    for (let guard = 0; guard < 256; guard += 1) {
      visit(dir);
      if (path.resolve(dir) === root) break;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  // User file first, then the workspace from the root outwards (so a more
  // specific subtree file is read last), then explicitly configured files that
  // live outside the workspace.
  const rankOf = (candidate: { abs: string; origin: 'user' | 'workspace' }): number => {
    if (candidate.origin === 'user') return 0;
    return isInside(root, path.resolve(candidate.abs)) ? 1 : 2;
  };
  const depthOf = (abs: string): number => {
    const scope = scopeFor(root, abs);
    return scope ? scope.split('/').length : 0;
  };
  // A rule file that sits next to the code outranks one filed away in `.agents/`
  // at the same level, so `packages/api/agent.md` is read after the repo root
  // but before `.agents/` collections.
  const hiddenOf = (abs: string): number =>
    relativeTo(root, path.dirname(abs))
      .split('/')
      .some((segment) => segment.startsWith('.'))
      ? 1
      : 0;
  candidates.sort((a, b) => {
    const rank = rankOf(a) - rankOf(b);
    if (rank !== 0) return rank;
    const depth = depthOf(a.abs) - depthOf(b.abs);
    if (depth !== 0) return depth;
    const hidden = hiddenOf(a.abs) - hiddenOf(b.abs);
    if (hidden !== 0) return hidden;
    return displayPathFor(root, a.abs).localeCompare(displayPathFor(root, b.abs));
  });

  let budgetLeft = totalBudget;
  for (const candidate of candidates) {
    const display = displayPathFor(root, candidate.abs);
    let intended = 0;
    try {
      intended = Math.min(fs.statSync(candidate.abs).size, maxBytes);
    } catch {
      result.skipped.push({ path: display, reason: 'unreadable' });
      continue;
    }
    // Skip a file rather than append half of it: a truncated rule reads as a
    // different rule. Per-file truncation is still allowed while the file fits
    // in the total budget.
    if (intended > budgetLeft) {
      result.skipped.push({
        path: display,
        reason: `does not fit in the ${formatBytes(totalBudget)} instruction budget`,
      });
      continue;
    }
    const read = readLimited(candidate.abs, intended);
    if (!read) {
      result.skipped.push({ path: display, reason: 'unreadable' });
      continue;
    }
    const parsed = parseAgentFrontMatter(read.content);
    const contentBytes = Buffer.byteLength(parsed.body, 'utf8');
    if (contentBytes > budgetLeft) {
      result.skipped.push({
        path: display,
        reason: `does not fit in the ${formatBytes(totalBudget)} instruction budget`,
      });
      continue;
    }
    result.files.push({
      path: path.resolve(candidate.abs),
      displayPath: display,
      scope: scopeFor(root, candidate.abs),
      origin: candidate.origin,
      bytes: read.bytes,
      truncated: read.truncated,
      content: parsed.body,
      ...(parsed.description ? { description: parsed.description } : {}),
      ...(parsed.applyTo ? { applyTo: parsed.applyTo } : {}),
    });
    result.totalBytes += contentBytes;
    budgetLeft -= contentBytes;
  }

  return result;
}

/**
 * Restrict a discovery result to the files the user pinned.
 *
 * This is the manual switch: `undefined` or `null` means "everything that was
 * discovered", a list means "only these". Paths may be given as the
 * workspace-relative `displayPath` shown in the panel or as an absolute path;
 * the result keeps discovery order, so the root-to-leaf reading order survives
 * and a subtree file still comes after the root file it refines.
 *
 * Nothing is invented here: paths that no longer exist are reported as
 * `missing` rather than silently replaced, so the caller can prune its stored
 * selection instead of running a task with instructions the user did not pick.
 */
export function selectAgentFiles(result: AgentFilesResult, selection?: readonly string[] | null): SelectedAgentFiles {
  const available = result.available ?? result.files.length;
  if (selection == null) return { ...result, available, missing: [] };

  const wanted = new Set(selection.map((entry) => toPosix(entry.trim()).replace(/^\.\//, '')).filter(Boolean));
  if (wanted.size === 0) return { ...result, available, missing: [] };

  const files = result.files.filter(
    (file) => wanted.has(toPosix(file.displayPath)) || wanted.has(toPosix(file.path)),
  );
  const matched = new Set<string>();
  for (const file of files) {
    matched.add(toPosix(file.displayPath));
    matched.add(toPosix(file.path));
  }
  const missing = [...wanted].filter((path) => !matched.has(path));
  return {
    ...result,
    files,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    available,
    selection: selection.slice(),
    missing,
  };
}

function isOutsideDisplayPath(displayPath: string): boolean {
  return displayPath.startsWith('~') || displayPath.startsWith('/') || /^[A-Za-z]:\//.test(displayPath);
}

function describeLocation(file: AgentFileInfo): string {
  const bits: string[] = [];
  if (file.origin === 'user') bits.push('user-level, applies to every workspace');
  else if (file.scope) bits.push(`applies to ${file.scope}/**`);
  else if (isOutsideDisplayPath(file.displayPath)) bits.push('explicit file outside the workspace');
  else if (!file.displayPath.includes('/')) bits.push('workspace root');
  else bits.push('applies to the whole workspace');
  if (file.applyTo) bits.push(`declared for ${file.applyTo}`);
  if (file.description) bits.push(file.description);
  return bits.join(' · ');
}

/**
 * Render loaded instructions for the system message. Each file keeps its own
 * heading so the model can tell which subtree a rule belongs to.
 */
export function formatAgentInstructions(result: AgentFilesResult): string {
  if (!result.enabled) {
    return 'Agent instruction loading is disabled (codingHarness.agentFiles.enabled is false). No instructions were loaded.';
  }
  const describeSources = (): string => {
    const parts: string[] = [];
    if (result.names.length) parts.push(`named ${result.names.join(', ')}`);
    if (result.patterns.length) parts.push(`matching ${result.patterns.join(', ')}`);
    parts.push(`and any .md inside ${INSTRUCTION_DIRS.join(', ')}`);
    return parts.join('; ');
  };

  if (result.files.length === 0) {
    const searched: string[] = ['the workspace root and its config folders'];
    if (result.scanNested && result.maxDepth > 0) searched.push(`subdirectories to depth ${result.maxDepth}`);
    if (result.includeUser) searched.push(`the user-level file ${result.userPath}`);
    const lines = [
      'No agent instruction files were found.',
      `Looked for ${describeSources()} in ${searched.join('; ')}.`,
      result.skipped.length ? `Skipped: ${result.skipped.length} path(s) (see the extension log).` : '',
      'The extension has no built-in prompt; this system message contains context only.',
    ];
    return lines.filter(Boolean).join('\n');
  }

  const external = result.files.filter((file) => !isInside(result.root, file.path) && file.origin !== 'user').length;
  const pinned = result.selection && result.available && result.available > result.files.length
    ? ` The user pinned this selection: ${result.files.length} of ${result.available} discovered file(s) are included; the rest were deliberately left out.`
    : '';
  const lines = [
    `${result.files.length} file(s), ${formatBytes(result.totalBytes)}. ` +
      'Files are ordered from the workspace root outwards; a file in a subdirectory applies to that subtree.' +
      (external > 0
        ? ` ${external} file(s) were added explicitly from outside the workspace (codingHarness.agentFiles.extraPaths) and come last.`
        : '') +
      pinned,
  ];
  for (const file of result.files) {
    lines.push('');
    lines.push(`## ${file.displayPath} — ${describeLocation(file)}${file.truncated ? ' (truncated)' : ''}`);
    lines.push('');
    lines.push(file.content.trim());
  }
  return lines.join('\n');
}

/** One-line summary for logs and the panel, e.g. `agent.md [root], api/agent.md [api]`. */
export function agentFilesSummary(result: AgentFilesResult): string {
  if (!result.enabled) return 'disabled';
  if (result.files.length === 0) return 'none found';
  return result.files
    .map((file) => `${file.displayPath} [${file.origin === 'user' ? 'user' : file.scope || 'root'}]`)
    .join(', ');
}
