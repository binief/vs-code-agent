import { resolveWorkspacePath } from '../paths';
import { fail, ok, type Tool } from '../types';

/** Current compiler/linter problems from the editor (VS Code diagnostics). */
export const getDiagnosticsTool: Tool<{ path?: string; severity?: 'error' | 'warning' | 'all' }> = {
  name: 'get_diagnostics',
  description:
    'Get the current errors and warnings the editor knows about (TypeScript, ESLint, Pylance, \u2026). ' +
    'Use it after editing files to verify the change compiled, or to explore what is already broken.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Limit to one file, workspace-relative. Omit for the whole workspace.' },
      severity: { type: 'string', enum: ['error', 'warning', 'all'], description: 'Filter by severity. Default all.' },
    },
  },
  async run(args, ctx) {
    if (!ctx.host.getDiagnostics) {
      return fail('Diagnostics are not available in this host.', 'unsupported');
    }
    const rel = args.path
      ? resolveWorkspacePath(ctx.root, args.path, { allowOutside: ctx.config.allowOutsideWorkspace }).rel
      : undefined;

    const all = await ctx.host.getDiagnostics(rel);
    const wanted = all.filter((d) =>
      args.severity === 'error' ? d.severity === 'error' : args.severity === 'warning' ? d.severity === 'warning' : true,
    );

    if (wanted.length === 0) {
      return ok(
        rel ? `No problems reported for "${rel}".` : 'No problems reported for the workspace.',
        'no problems',
        { count: 0 },
      );
    }

    const errors = wanted.filter((d) => d.severity === 'error').length;
    const warnings = wanted.filter((d) => d.severity === 'warning').length;
    const lines = wanted
      .slice(0, 200)
      .map((d) => `${d.file}:${d.line}  ${d.severity.toUpperCase()}  ${d.message}${d.source ? `  [${d.source}]` : ''}`);
    const extra = wanted.length > 200 ? `\n\u2026 ${wanted.length - 200} more` : '';

    return ok(`${errors} error(s), ${warnings} warning(s)\n${lines.join('\n')}${extra}`, `${errors} error(s), ${warnings} warning(s)`, {
      errors,
      warnings,
      count: wanted.length,
      files: [...new Set(wanted.map((d) => d.file))],
    });
  },
};

/** Open a file (and optionally a line) in the editor so the user can see it. */
export const openFileTool: Tool<{ path: string; line?: number; reason?: string }> = {
  name: 'open_file',
  description:
    'Open a file in the editor, optionally jumping to a line. Use it when it helps the user look at the result, ' +
    'or after finishing a change. It does not modify anything.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File to open, workspace-relative.' },
      line: { type: 'number', description: '1-based line number to reveal.' },
      reason: { type: 'string', description: 'Short note about why this file is being opened.' },
    },
    required: ['path'],
  },
  async run(args, ctx) {
    if (!ctx.host.openFile) return fail('Opening files is not supported in this host.', 'unsupported');
    const target = resolveWorkspacePath(ctx.root, args.path, { allowOutside: ctx.config.allowOutsideWorkspace });
    try {
      await ctx.host.openFile(target.abs, args.line);
    } catch (err) {
      return fail(`Could not open "${target.rel}": ${(err as Error).message}`, 'open failed');
    }
    return ok(
      `Opened "${target.rel}"${args.line ? ` at line ${args.line}` : ''}.${args.reason ? ` (${args.reason})` : ''}`,
      `opened ${target.rel}`,
      { relPath: target.rel },
    );
  },
};
