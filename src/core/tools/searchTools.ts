import * as fs from 'fs';
import { looksBinary, resolveWorkspacePath } from '../paths';
import { fail, ok, type Tool } from '../types';
import { walkFiles } from './walk';

/** Plain substring or regex search across workspace text files. */
export const searchTextTool: Tool<{
  query: string;
  path?: string;
  glob?: string;
  is_regex?: boolean;
  case_sensitive?: boolean;
  max_results?: number;
  context_lines?: number;
}> = {
  name: 'search_text',
  description:
    'Search file contents in the workspace (like ripgrep) and return "path:line: text" matches. ' +
    'Use it to find where a symbol, string or config key lives before reading or editing files.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Text to find. Treated as a regular expression when is_regex is true.' },
      path: { type: 'string', description: 'Directory (or file) to search, workspace-relative. Defaults to the workspace root.' },
      glob: { type: 'string', description: 'Optional file filter, e.g. "*.ts", "src/**/*.py".' },
      is_regex: { type: 'boolean', description: 'Interpret query as a regular expression. Default false.' },
      case_sensitive: { type: 'boolean', description: 'Match case exactly. Default false.' },
      max_results: { type: 'number', description: 'Maximum matches returned. Default 60.' },
      context_lines: { type: 'number', description: 'Lines of context around each match. Default 0.' },
    },
    required: ['query'],
  },
  async run(args, ctx) {
    if (!args.query) return fail('"query" must not be empty.', 'bad arguments');

    const target = resolveWorkspacePath(ctx.root, args.path, { allowOutside: ctx.config.allowOutsideWorkspace });
    const maxResults = Math.max(1, Math.min(args.max_results ?? 60, 500));
    const contextLines = Math.max(0, Math.min(args.context_lines ?? 0, 5));
    const maxFileBytes = ctx.config.maxFileBytes > 0 ? ctx.config.maxFileBytes : 1024 * 1024;

    let pattern: RegExp;
    try {
      const flags = args.case_sensitive ? 'g' : 'gi';
      pattern = new RegExp(args.is_regex ? args.query : escapeRegExp(args.query), flags);
    } catch (err) {
      return fail(`Invalid regular expression: ${(err as Error).message}`, 'bad regex');
    }

    let files;
    try {
      const startIsFile = fs.statSync(target.abs).isFile();
      files = startIsFile
        ? [{ abs: target.abs, rel: target.rel, isDirectory: false, size: fs.statSync(target.abs).size }]
        : walkFiles({
            root: ctx.root,
            start: target.abs,
            glob: args.glob,
            maxDepth: 12,
            maxEntries: 6000,
            maxFileBytes,
            signal: ctx.signal,
          }).files;
    } catch (err) {
      return fail(`Cannot search "${target.rel}": ${(err as Error).message}`, 'search failed');
    }

    const out: string[] = [];
    const filesWithMatches = new Set<string>();
    let totalMatches = 0;
    let filesScanned = 0;
    let stopped = false;

    outer: for (const file of files) {
      if (ctx.signal?.aborted) break;
      if (looksBinary(file.abs)) continue;
      let text: string;
      try {
        text = fs.readFileSync(file.abs, 'utf8');
      } catch {
        continue;
      }
      filesScanned++;
      const lines = text.split(/\r?\n/);
      let fileMatches = 0;
      for (let i = 0; i < lines.length; i++) {
        pattern.lastIndex = 0;
        if (!pattern.test(lines[i])) continue;
        if (fileMatches === 0 && contextLines > 0) out.push(`${file.rel}:`);
        const startLine = Math.max(0, i - contextLines);
        for (let j = startLine; j <= i; j++) {
          const prefix = j === i ? ':' : '-';
          out.push(`${file.rel}${prefix}${j + 1}${prefix} ${lines[j].slice(0, 300)}`);
        }
        fileMatches++;
        totalMatches++;
        filesWithMatches.add(file.rel);
        if (totalMatches >= maxResults) {
          stopped = true;
          break outer;
        }
      }
    }

    if (totalMatches === 0) {
      return ok(
        `No matches for "${args.query}" in ${filesScanned} file(s) scanned under "${target.rel}".`,
        '0 matches',
        { matches: 0 },
      );
    }

    const header = `${totalMatches}${stopped ? '+' : ''} match(es) for "${args.query}" in ${filesWithMatches.size} file(s) (${filesScanned} scanned)`;
    const footer = stopped ? `\n\n(stopped at the ${maxResults}-match limit; refine the query or raise max_results)` : '';
    return ok(`${header}\n${out.join('\n')}${footer}`, `${totalMatches} match(es)`, {
      matches: totalMatches,
      files: [...filesWithMatches],
    });
  },
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
