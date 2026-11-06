import * as fs from 'fs';
import { normalizeEol } from '../lineEndings';
import { looksBinary, resolveWorkspacePath } from '../paths';
import { fail, ok, type Tool } from '../types';
import { walkFiles, type WalkEntry } from './walk';

/** Plain substring or JavaScript regex search across workspace text files. */
export const searchTextTool: Tool<{
  query: string;
  path?: string;
  glob?: string;
  is_regex?: boolean;
  case_sensitive?: boolean;
  multiline?: boolean;
  max_results?: number;
  context_lines?: number;
}> = {
  name: 'search_text',
  description:
    'Search workspace text files and return path:line matches. Line endings are normalized to LF; searches are line-by-line unless multiline is true.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Literal text, or a JavaScript regular expression when is_regex is true. Text is searched with LF line endings.' },
      path: { type: 'string', description: 'Directory (or file) to search, workspace-relative. Defaults to the workspace root.' },
      glob: { type: 'string', description: 'Optional file filter for directory searches, e.g. "*.ts", "src/**/*.py".' },
      is_regex: { type: 'boolean', description: 'Interpret query as a JavaScript regular expression. Default false.' },
      case_sensitive: { type: 'boolean', description: 'Match case exactly. Default false.' },
      multiline: { type: 'boolean', description: 'Search normalized whole-file text, allowing matches across lines. Regex ^ and $ match line boundaries; dot does not match newlines. Default false.' },
      max_results: { type: 'number', description: 'Maximum matching lines (default mode) or matches (multiline mode). Default 60, maximum 500.' },
      context_lines: { type: 'number', description: 'Lines of context before and after each match. Default 0, maximum 5.' },
    },
    required: ['query'],
  },
  async run(args, ctx) {
    if (!args.query) return fail('"query" must not be empty.', 'bad arguments');

    const target = resolveWorkspacePath(ctx.root, args.path, { allowOutside: ctx.config.allowOutsideWorkspace });
    const maxResults = Math.max(1, Math.min(args.max_results ?? 60, 500));
    const contextLines = Math.max(0, Math.min(args.context_lines ?? 0, 5));
    const maxFileBytes = ctx.config.maxFileBytes > 0 ? ctx.config.maxFileBytes : 1024 * 1024;
    const multiline = args.multiline === true;

    let pattern: RegExp;
    try {
      const flags = `g${args.case_sensitive ? '' : 'i'}${multiline ? 'm' : ''}`;
      pattern = new RegExp(args.is_regex ? args.query : escapeRegExp(normalizeEol(args.query)), flags);
    } catch (err) {
      return fail(`Invalid regular expression: ${(err as Error).message}`, 'bad regex');
    }

    let files: WalkEntry[];
    let skipped = 0;
    let skipReasons = { hidden: 0, ignored: 0, glob: 0, oversized: 0, outsideSymlink: 0 };
    let inaccessible = 0;
    let traversalTruncated = false;
    let depthLimited = false;
    let explicitFileTooLarge = false;
    try {
      const stat = fs.statSync(target.abs);
      if (stat.isFile()) {
        if (stat.size > maxFileBytes) {
          files = [];
          skipped = 1;
          skipReasons.oversized = 1;
          explicitFileTooLarge = true;
        } else files = [{ abs: target.abs, rel: target.rel, isDirectory: false, size: stat.size }];
      } else {
        const result = walkFiles({ root: ctx.root, start: target.abs, glob: args.glob, maxDepth: 12, maxEntries: 6000, maxFileBytes, signal: ctx.signal });
        files = result.files;
        skipped = result.skipped;
        skipReasons = result.skipReasons;
        inaccessible = result.inaccessible;
        traversalTruncated = result.truncated;
        depthLimited = result.depthLimited;
      }
    } catch (err) {
      return fail(`Cannot search "${target.rel}": ${(err as Error).message}`, 'search failed');
    }

    const out: string[] = [];
    const filesWithMatches = new Set<string>();
    let totalMatches = 0;
    let filesScanned = 0;
    let binarySkipped = 0;
    let encodingSkipped = 0;
    let readErrors = 0;
    let stopped = false;
    let outputChars = 0;
    let outputClipped = false;

    outer: for (const file of files) {
      if (ctx.signal?.aborted) break;
      if (looksBinary(file.abs)) { binarySkipped++; continue; }
      let text: string;
      try {
        const bytes = fs.readFileSync(file.abs);
        const decoded = bytes.toString('utf8');
        if (!Buffer.from(decoded, 'utf8').equals(bytes)) { encodingSkipped++; continue; }
        text = normalizeEol(decoded);
      } catch {
        readErrors++;
        continue;
      }
      filesScanned++;
      const lines = text.split('\n');
      const emit = (first: number, last: number): void => {
        const from = Math.max(0, first - contextLines);
        const to = Math.min(lines.length - 1, last + contextLines);
        for (let i = from; i <= Math.min(to, from + 19); i++) {
          const prefix = i >= first && i <= last ? ':' : '-';
          const line = `${file.rel}${prefix}${i + 1}${prefix} ${lines[i].slice(0, 300)}`;
          if (lines[i].length > 300) outputClipped = true;
          if (outputChars + line.length + 1 <= 40_000) { out.push(line); outputChars += line.length + 1; }
          else outputClipped = true;
        }
        if (to - from >= 20) outputClipped = true;
        totalMatches++;
        filesWithMatches.add(file.rel);
      };

      if (!multiline) {
        for (let i = 0; i < lines.length; i++) {
          pattern.lastIndex = 0;
          if (!pattern.test(lines[i])) continue;
          emit(i, i);
          if (totalMatches >= maxResults) { stopped = true; break outer; }
        }
      } else {
        // Binary search offsets against line starts to avoid repeatedly slicing
        // and counting the entire prefix for each match.
        const starts = [0];
        for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
        const lineAt = (offset: number): number => {
          let lo = 0;
          let hi = starts.length;
          while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (starts[mid] <= offset) lo = mid + 1;
            else hi = mid;
          }
          return Math.max(0, lo - 1);
        };
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(text))) {
          const first = lineAt(match.index);
          const last = lineAt(match.index + Math.max(0, match[0].length - 1));
          emit(first, last);
          if (totalMatches >= maxResults) { stopped = true; break outer; }
          // RegExp.exec does not advance for zero-length matches.
          if (match[0].length === 0) pattern.lastIndex++;
        }
      }
    }

    const notes = [
      `Search mode: ${multiline ? 'multiline' : 'line-by-line'}; ${args.is_regex ? 'JavaScript regex' : 'literal'}; line endings normalized to LF.`,
      explicitFileTooLarge ? `The specified file exceeds the ${maxFileBytes}-byte file size limit and was not searched.` :
        skipped ? `${skipped} entries skipped by filters: ${skipReasons.hidden} hidden, ${skipReasons.ignored} ignored directories, ${skipReasons.glob} glob, ${skipReasons.oversized} oversized (limit ${maxFileBytes} bytes), ${skipReasons.outsideSymlink} outside-workspace symlinks.` : '',
      binarySkipped ? `${binarySkipped} binary file(s) skipped.` : '',
      encodingSkipped ? `${encodingSkipped} non-UTF-8 file(s) skipped.` : '',
      inaccessible || readErrors ? `${inaccessible + readErrors} path(s) could not be read.` : '',
      traversalTruncated ? 'Directory traversal stopped at the 6000-entry limit; results may be incomplete.' : '',
      depthLimited ? 'Directory traversal reached the depth limit (12); results may be incomplete.' : '',
      stopped ? `Stopped at the ${maxResults}-match limit; results may be incomplete.` : '',
      outputClipped ? 'Some matching or context lines were omitted or truncated (300 characters per line, 20 lines per match or 40000-character output limit).' : '',
      ctx.signal?.aborted ? 'Search was cancelled; results may be incomplete.' : '',
    ].filter(Boolean).join('\n');
    const stats = { matches: totalMatches, files: [...filesWithMatches], filesScanned, skipped, skipReasons, binarySkipped, encodingSkipped, inaccessible: inaccessible + readErrors, traversalTruncated, depthLimited, stopped, outputClipped, cancelled: Boolean(ctx.signal?.aborted), multiline };
    if (totalMatches === 0) {
      return ok(`No matches for "${args.query}" in ${filesScanned} file(s) scanned under "${target.rel}".\n${notes}`, '0 matches', stats);
    }
    const header = `${totalMatches}${stopped ? '+' : ''} match(es) for "${args.query}" in ${filesWithMatches.size} file(s) (${filesScanned} scanned)`;
    return ok(`${header}\n${out.join('\n')}\n\n${notes}`, `${totalMatches} match(es)`, stats);
  },
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
