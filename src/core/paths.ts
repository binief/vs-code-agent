import * as fs from 'fs';
import * as path from 'path';

/** Raised for any path that the sandbox refuses to touch. */
export class PathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathError';
  }
}

export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/** True when `abs` is `root` itself or lives underneath it. */
export function isInside(root: string, abs: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(abs));
  if (rel === '') return true;
  if (path.isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith(`..${path.sep}`);
}

/** realpath of the closest existing ancestor (handles not-yet-created files). */
export function realpathOfNearestExisting(target: string): string | undefined {
  let cur = path.resolve(target);
  for (let i = 0; i < 128; i++) {
    try {
      return fs.realpathSync.native(cur);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return undefined;
      cur = parent;
    }
  }
  return undefined;
}

export interface ResolvedPath {
  abs: string;
  /** Workspace-relative, posix separators. `.` for the root itself. */
  rel: string;
}

/**
 * Resolve a model-supplied path against the workspace root and refuse anything
 * that escapes it. Absolute paths are allowed only when they already point
 * inside the workspace (or `allowOutside` is set), and symlinks are resolved so
 * `workspace/link -> /etc` cannot be used as a getaway car.
 */
export function resolveWorkspacePath(
  root: string,
  input?: string,
  opts: { allowOutside?: boolean } = {},
): ResolvedPath {
  const rootAbs = path.resolve(root);
  const raw = (input ?? '.').trim() || '.';
  if (raw.includes('\0')) throw new PathError('Path contains a null byte.');

  const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(rootAbs, raw);

  if (!opts.allowOutside) {
    if (!isInside(rootAbs, abs)) {
      throw new PathError(
        `Path "${raw}" is outside the workspace (${rootAbs}). Refused. ` +
          'Use a workspace-relative path, or enable "codingHarness.allowOutsideWorkspace".',
      );
    }
    const realAbs = realpathOfNearestExisting(abs);
    const realRoot = realpathOfNearestExisting(rootAbs) ?? rootAbs;
    if (realAbs && !isInside(realRoot, realAbs)) {
      throw new PathError(`Path "${raw}" escapes the workspace through a symlink. Refused.`);
    }
  }

  const rel = toPosix(path.relative(rootAbs, abs)) || '.';
  return { abs, rel };
}

/** Same rules as {@link resolveWorkspacePath} but never throws: returns null. */
export function tryResolveWorkspacePath(
  root: string,
  input?: string,
  opts: { allowOutside?: boolean } = {},
): ResolvedPath | null {
  try {
    return resolveWorkspacePath(root, input, opts);
  } catch {
    return null;
  }
}

export function ensureDir(absDir: string): void {
  fs.mkdirSync(absDir, { recursive: true });
}

export function fileExists(abs: string): boolean {
  try {
    return fs.statSync(abs).isFile();
  } catch {
    return false;
  }
}

export function dirExists(abs: string): boolean {
  try {
    return fs.statSync(abs).isDirectory();
  } catch {
    return false;
  }
}

export function fileSize(abs: string): number {
  try {
    return fs.statSync(abs).size;
  } catch {
    return -1;
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

/** Heuristic: NUL byte in the first 8 KB means "do not hand this to the model". */
export function looksBinary(abs: string): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(abs, 'r');
    const buf = Buffer.alloc(8192);
    const read = fs.readSync(fd, buf, 0, buf.length, 0);
    for (let i = 0; i < read; i++) if (buf[i] === 0) return true;
    return false;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Translate a glob (`**`, `*`, `?`, `{a,b}`) into a RegExp.
 * Deliberately small: enough for `src/**\/*.ts`, `*.{js,ts}`, `test?/*`.
 */
export function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const followedBySlash = glob[i + 2] === '/';
        out += followedBySlash ? '(?:.*/)?' : '.*';
        i += followedBySlash ? 2 : 1;
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end === -1) {
        out += '\\{';
      } else {
        const options = glob
          .slice(i + 1, end)
          .split(',')
          .map((o) => o.replace(/[.+^${}()|[\]\\]/g, '\\$&'));
        out += `(?:${options.join('|')})`;
        i = end;
      }
    } else if ('.+^$()|[]\\'.includes(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  return new RegExp(`^${out}$`);
}

export function matchesGlob(relPath: string, glob: string | undefined): boolean {
  if (!glob) return true;
  const rel = toPosix(relPath);
  const base = rel.split('/').pop() ?? rel;
  const re = globToRegExp(toPosix(glob));
  return re.test(rel) || re.test(base);
}
