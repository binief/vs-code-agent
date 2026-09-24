import * as fs from 'fs';
import * as path from 'path';
import { diffPreview, readIfExists } from '../checkpoints';
import { applyEol, detectEol, eolName, normalizeEol, resolveEol } from '../lineEndings';
import { ensureDir, fileSize, formatBytes, looksBinary, resolveWorkspacePath, toPosix } from '../paths';
import { fail, ok, type Tool, type ToolContext, type ToolResult } from '../types';
import { walk } from './walk';

export const MAX_READ_LINES = 1500;

function maxBytes(ctx: ToolContext): number {
  return ctx.config.maxFileBytes > 0 ? ctx.config.maxFileBytes : 1024 * 1024;
}

function clip(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  return { text: `${text.slice(0, limit)}\n\u2026 [truncated at ${limit} characters]`, truncated: true };
}

/* ------------------------------------------------------------ list_files */

export const listFilesTool: Tool<{
  path?: string;
  glob?: string;
  max_depth?: number;
  max_entries?: number;
  include_hidden?: boolean;
  directories_only?: boolean;
}> = {
  name: 'list_files',
  description:
    'List files and directories in the workspace. Use it to discover the project layout before reading or editing. ' +
    'Skips dependency/build folders (node_modules, .git, dist, out, build, \u2026). Supports a glob filter such as "**/*.ts".',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory to list, workspace-relative. Defaults to the workspace root.' },
      glob: { type: 'string', description: 'Optional glob filter, e.g. "*.py", "src/**/*.ts", "*.{json,yml}".' },
      max_depth: { type: 'number', description: 'How many directory levels to descend. Default 3.' },
      max_entries: { type: 'number', description: 'Cap on returned entries. Default 300.' },
      include_hidden: { type: 'boolean', description: 'Include dot-files and dot-directories. Default false.' },
      directories_only: { type: 'boolean', description: 'Only return directories. Default false.' },
    },
  },
  async run(args, ctx) {
    const target = resolveWorkspacePath(ctx.root, args.path, { allowOutside: ctx.config.allowOutsideWorkspace });
    const res = walk({
      root: ctx.root,
      start: target.abs,
      glob: args.glob,
      maxDepth: Math.max(1, Math.min(args.max_depth ?? 3, 12)),
      maxEntries: Math.max(1, Math.min(args.max_entries ?? 300, 2000)),
      includeHidden: args.include_hidden === true,
      signal: ctx.signal,
    });

    let entries = res.entries;
    if (args.directories_only) entries = entries.filter((e) => e.isDirectory);

    if (entries.length === 0) {
      return ok(
        `No entries found under "${target.rel}"${args.glob ? ` matching "${args.glob}"` : ''}.`,
        '0 entries',
        { count: 0, relPath: target.rel },
      );
    }

    const lines = entries
      .sort((a, b) => {
        const aParts = a.rel.split('/');
        const bParts = b.rel.split('/');
        if (a.rel === b.rel) return 0;
        return a.rel.localeCompare(b.rel);
      })
      .map((e) => (e.isDirectory ? `${e.rel}/` : `${e.rel}  (${formatBytes(e.size)})`));

    const notes: string[] = [];
    if (res.truncated) notes.push('entry cap reached \u2014 narrow the request with "path" or "glob"');
    if (res.depthLimited) notes.push('depth limit reached \u2014 increase max_depth or list a subdirectory');
    if (res.skipped > 0) notes.push(`${res.skipped} hidden/ignored entries skipped`);

    const body = clip(lines.join('\n'), 24_000);
    const header = `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} under "${target.rel}" (root: ${ctx.root})`;
    const footer = notes.length ? `\n\nNote: ${notes.join('; ')}.` : '';
    return ok(`${header}\n${body.text}${footer}`, `${entries.length} entries`, {
      count: entries.length,
      relPath: target.rel,
      entries: entries.slice(0, 200).map((e) => e.rel),
    });
  },
};

/* ------------------------------------------------------------ read_file */

export const readFileTool: Tool<{
  path: string;
  start_line?: number;
  end_line?: number;
  max_lines?: number;
}> = {
  name: 'read_file',
  description:
    'Read a text file (line-numbered) or list a directory. Line endings are shown as LF so snippets match on ' +
    'Windows and Unix. Always read a file before editing it. Use start_line/end_line to read a slice of a large file.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, workspace-relative (relative paths are preferred).' },
      start_line: { type: 'number', description: 'First line to return (1-based, inclusive).' },
      end_line: { type: 'number', description: 'Last line to return (1-based, inclusive).' },
      max_lines: { type: 'number', description: `Cap on returned lines. Default ${MAX_READ_LINES}.` },
    },
    required: ['path'],
  },
  async run(args, ctx) {
    const target = resolveWorkspacePath(ctx.root, args.path, { allowOutside: ctx.config.allowOutsideWorkspace });

    // Directory: behave like a shallow listing instead of erroring out.
    try {
      if (fs.statSync(target.abs).isDirectory()) {
        const res = walk({ root: ctx.root, start: target.abs, maxDepth: 1, maxEntries: 200, signal: ctx.signal });
        const listing = res.entries.map((e) => (e.isDirectory ? `${e.rel}/` : `${e.rel} (${formatBytes(e.size)})`));
        return ok(
          `"${target.rel}" is a directory. Contents:\n${listing.join('\n')}`,
          'directory listing',
          { relPath: target.rel, isDirectory: true },
        );
      }
    } catch (err) {
      return fail(`Cannot access "${target.rel}": ${(err as Error).message}`, 'not found');
    }

    const size = fileSize(target.abs);
    if (size > maxBytes(ctx)) {
      return fail(
        `"${target.rel}" is ${formatBytes(size)}, larger than the ${formatBytes(maxBytes(ctx))} tool limit. ` +
          'Use read_file with start_line/end_line, or search_text to locate the relevant part.',
        'file too large',
        { relPath: target.rel },
      );
    }
    if (looksBinary(target.abs)) {
      return fail(`"${target.rel}" looks like a binary file; refusing to read it as text.`, 'binary file', {
        relPath: target.rel,
      });
    }

    let raw: string;
    try {
      raw = fs.readFileSync(target.abs, 'utf8');
    } catch (err) {
      return fail(`Cannot read "${target.rel}": ${(err as Error).message}`, 'read failed');
    }

    const fileEol = detectEol(raw);
    const allLines = normalizeEol(raw).split('\n');
    const total = allLines.length;
    const cap = Math.max(1, Math.min(args.max_lines ?? MAX_READ_LINES, 5000));
    const from = Math.max(1, args.start_line ?? 1);
    const to = Math.min(args.end_line ?? total, from + cap - 1, total);
    const slice = allLines.slice(from - 1, to);

    const numbered = slice.map((line, i) => `${String(from + i).padStart(5)}| ${line}`).join('\n');
    const clipped = clip(numbered, 40_000);
    const notes: string[] = [`${total} lines total`];
    if (fileEol && fileEol !== '\n') notes.push(`${eolName(fileEol)} line endings shown as LF for editing`);
    if (to < total) notes.push(`showing ${from}-${to}; request more with start_line/end_line`);
    if (clipped.truncated) notes.push('output clipped by size');

    return ok(
      `${target.rel} (${notes.join(', ')})\n${clipped.text}`,
      `read ${slice.length} line(s) of ${target.rel}`,
      { relPath: target.rel, lines: total },
    );
  },
};

/* ----------------------------------------------------------- write_file */

export const writeFileTool: Tool<{
  path: string;
  content: string;
  mode?: 'overwrite' | 'create' | 'append';
}> = {
  name: 'write_file',
  description:
    'Create or overwrite a file with the full content you provide. Intermediate directories are created. ' +
    'Prefer replace_in_file for small edits to existing files. Content must be the complete new file body. ' +
    'Line endings are normalized for the model and written with the existing file style (or the OS style for new files).',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, workspace-relative.' },
      content: { type: 'string', description: 'Full file content.' },
      mode: {
        type: 'string',
        enum: ['overwrite', 'create', 'append'],
        description: 'overwrite (default), create (fail if the file exists), or append.',
      },
    },
    required: ['path', 'content'],
  },
  async run(args, ctx): Promise<ToolResult> {
    const target = resolveWorkspacePath(ctx.root, args.path, { allowOutside: ctx.config.allowOutsideWorkspace });
    const mode = args.mode ?? 'overwrite';
    if (typeof args.content !== 'string') return fail('"content" must be a string.', 'bad arguments');

    const existing = readIfExists(target.abs);

    if (mode === 'create' && existing !== null) {
      return fail(
        `"${target.rel}" already exists. Use read_file first, then mode "overwrite" or replace_in_file.`,
        'file exists',
        { relPath: target.rel },
      );
    }
    if (mode === 'append' && existing === null) {
      return fail(`"${target.rel}" does not exist, so there is nothing to append to.`, 'missing file');
    }

    // Model text is canonicalized to LF, then written using the existing
    // file's style. New files use the host OS style unless the setting
    // overrides it.
    const existingEol = existing === null ? null : detectEol(existing);
    const logicalNext = mode === 'append'
      ? `${normalizeEol(existing ?? '')}${normalizeEol(args.content)}`
      : normalizeEol(args.content);
    const writeEol = resolveEol(ctx.config.lineEndings, existingEol);
    const next = applyEol(logicalNext, writeEol);
    const diff = diffPreview(target.rel, existing, next);
    ctx.host.log('debug', `write_file ${target.rel} (${mode}) ${diff.length} chars of diff`);

    try {
      const requested = { kind: 'write' as const, relPath: target.rel, absPath: target.abs, newContent: next, oldContent: existing ?? undefined };
      const decision = await requestEditApproval(ctx, requested, diff, `Write ${target.rel}`);
      if (decision === 'reject') {
        return fail('User rejected this file write. Do not retry it verbatim; ask what to change instead.', 'rejected by user');
      }
      const previous = checkpoint(ctx, target.abs, target.rel);
      await applyWrite(ctx, target.abs, next, previous);
    } catch (err) {
      return fail(`Failed to write "${target.rel}": ${(err as Error).message}`, 'write failed');
    }

    const lineCount = normalizeEol(next).split('\n').length;
    const verb = existing === null ? 'Created' : mode === 'append' ? 'Appended to' : 'Overwrote';
    return ok(
      `${verb} "${target.rel}" (${formatBytes(Buffer.byteLength(next, 'utf8'))}, ${lineCount} lines, ${eolName(writeEol)} line endings).`,
      `${verb.toLowerCase()} ${target.rel}`,
      { relPath: target.rel, change: existing === null ? 'created' : 'modified', lines: lineCount },
    );
  },
};

/* ------------------------------------------------------- replace_in_file */

export const replaceInFileTool: Tool<{
  path: string;
  old_text: string;
  new_text: string;
  count?: number;
}> = {
  name: 'replace_in_file',
  description:
    'Replace an exact text snippet inside an existing file. The default replaces the first occurrence; line endings ' +
    'are matched independently of the platform and the file style is preserved. The call fails if old_text is not ' +
    'found (read the file first). Pass count to replace more occurrences, or an empty new_text to delete the snippet.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File to edit, workspace-relative.' },
      old_text: { type: 'string', description: 'Exact snippet to find, including indentation.' },
      new_text: { type: 'string', description: 'Replacement text (may be empty to delete).' },
      count: { type: 'number', description: 'How many occurrences to replace. Default 1; use -1 for all.' },
    },
    required: ['path', 'old_text', 'new_text'],
  },
  async run(args, ctx) {
    const target = resolveWorkspacePath(ctx.root, args.path, { allowOutside: ctx.config.allowOutsideWorkspace });
    const original = readIfExists(target.abs);
    if (original === null) {
      return fail(`"${target.rel}" does not exist. Use write_file to create it.`, 'missing file', { relPath: target.rel });
    }
    if (!args.old_text) return fail('"old_text" must not be empty; use write_file to rewrite the whole file.', 'bad arguments');

    const fileEol = detectEol(original);
    // Match line endings independently of the platform. This lets a model
    // use the LF text returned by read_file against a CRLF file on Windows.
    const normalizedOriginal = normalizeEol(original);
    const needle = normalizeEol(args.old_text);
    const replacement = normalizeEol(args.new_text ?? '');
    const occurrences = countOccurrences(normalizedOriginal, needle);
    if (occurrences === 0) {
      return fail(
        `old_text was not found in "${target.rel}". Line endings are matched regardless of platform; read the file and copy the exact snippet (including indentation).`,
        'snippet not found',
        { relPath: target.rel },
      );
    }

    const wanted = args.count === undefined ? 1 : args.count < 0 ? occurrences : args.count;
    const logicalNext = replaceN(normalizedOriginal, needle, replacement, wanted);
    const writeEol = resolveEol(ctx.config.lineEndings, fileEol);
    const next = applyEol(logicalNext, writeEol);
    const replaced = Math.min(wanted, occurrences);

    const diff = diffPreview(target.rel, original, next);
    const decision = await requestEditApproval(
      ctx,
      { kind: 'write', relPath: target.rel, absPath: target.abs, newContent: next, oldContent: original },
      diff,
      `Edit ${target.rel}`,
    );
    if (decision === 'reject') {
      return fail('User rejected this edit. Do not retry it verbatim; ask what to change instead.', 'rejected by user');
    }

    const previous = checkpoint(ctx, target.abs, target.rel);
    try {
      await applyWrite(ctx, target.abs, next, previous);
    } catch (err) {
      return fail(`Failed to edit "${target.rel}": ${(err as Error).message}`, 'write failed');
    }

    const remaining = occurrences - replaced;
    const note = remaining > 0 ? ` ${remaining} further occurrence(s) left untouched.` : '';
    return ok(
      `Replaced ${replaced} occurrence(s) in "${target.rel}".${note} Written with ${eolName(writeEol)} line endings.`,
      `edited ${target.rel}`,
      {
        relPath: target.rel,
        change: 'modified',
        replacements: replaced,
      },
    );
  },
};

/* ----------------------------------------------------------- delete_file */

export const deleteFileTool: Tool<{ path: string; reason?: string }> = {
  name: 'delete_file',
  description: 'Delete a single file. Always requires explicit user confirmation.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File to delete, workspace-relative.' },
      reason: { type: 'string', description: 'Why the file should be deleted (shown to the user).' },
    },
    required: ['path'],
  },
  async run(args, ctx) {
    const target = resolveWorkspacePath(ctx.root, args.path, { allowOutside: ctx.config.allowOutsideWorkspace });
    if (!fs.existsSync(target.abs)) return fail(`"${target.rel}" does not exist.`, 'missing file');
    if (fs.statSync(target.abs).isDirectory()) {
      return fail(`"${target.rel}" is a directory; deleting directories is not supported.`, 'not a file');
    }

    const decision = await ctx.approval({
      kind: 'delete',
      title: `Delete ${target.rel}`,
      detail: args.reason ? `Reason: ${args.reason}\n\n${target.rel}` : target.rel,
      relPath: target.rel,
      absPath: target.abs,
    });
    if (decision === 'reject') return fail('User rejected the deletion.', 'rejected by user');

    // Snapshot right before the removal so the delete can be undone.
    checkpoint(ctx, target.abs, target.rel);
    try {
      fs.rmSync(target.abs, { force: true });
    } catch (err) {
      return fail(`Failed to delete "${target.rel}": ${(err as Error).message}`, 'delete failed');
    }
    return ok(`Deleted "${target.rel}".`, `deleted ${target.rel}`, { relPath: target.rel, change: 'deleted' });
  },
};

/* ------------------------------------------------------------- helpers */

async function requestEditApproval(
  ctx: ToolContext,
  req: { kind: 'write'; relPath: string; absPath: string; newContent: string; oldContent?: string },
  diff: string,
  title: string,
): Promise<'apply' | 'reject'> {
  if (ctx.config.editPolicy === 'auto') return 'apply';
  return ctx.approval({
    kind: 'write',
    title,
    detail: diff,
    relPath: req.relPath,
    absPath: req.absPath,
    newContent: req.newContent,
    oldContent: req.oldContent,
  });
}

/**
 * Capture a file's current state for the undo stack. Called immediately before
 * a mutating operation (never before the approval prompt) so that "files
 * changed" and revert only ever report changes that really happened.
 * Returns the content that was on disk, or null when the file did not exist.
 */
function checkpoint(ctx: ToolContext, abs: string, rel: string): string | null {
  const current = readIfExists(abs);
  if (current === null) ctx.checkpoints.recordAsAbsent(abs, rel);
  else ctx.checkpoints.record(abs, rel);
  return current;
}

/**
 * Write through the host when it offers a better mechanism (VS Code uses a
 * WorkspaceEdit so Ctrl+Z works), otherwise fall back to plain fs.
 */
async function applyWrite(ctx: ToolContext, abs: string, content: string, previous: string | null): Promise<void> {
  if (previous === null && fs.existsSync(abs)) {
    throw new Error(`refusing to overwrite "${toPosix(abs)}" (it appeared after the tool started)`);
  }
  ensureDir(path.dirname(abs));
  if (ctx.host.applyFileWrite) {
    await ctx.host.applyFileWrite(abs, content);
    return;
  }
  fs.writeFileSync(abs, content, 'utf8');
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

function replaceN(haystack: string, needle: string, replacement: string, count: number): string {
  let out = '';
  let cursor = 0;
  let replaced = 0;
  while (replaced < count) {
    const idx = haystack.indexOf(needle, cursor);
    if (idx === -1) break;
    out += haystack.slice(cursor, idx) + replacement;
    cursor = idx + needle.length;
    replaced++;
  }
  return out + haystack.slice(cursor);
}
