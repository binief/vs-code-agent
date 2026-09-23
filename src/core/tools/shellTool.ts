import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { evaluateCommand } from '../policy';
import { resolveWorkspacePath } from '../paths';
import { fail, ok, type Tool } from '../types';

const MAX_OUTPUT_CHARS = 20_000;

export interface CommandOutput {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  signal?: NodeJS.Signals | null;
  durationMs: number;
}

/** Runs a shell command and captures its output. Exported for tests. */
export function runShellCommand(
  command: string,
  opts: { cwd: string; timeoutMs: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv },
): Promise<CommandOutput> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, {
      cwd: opts.cwd,
      shell: true,
      env: { ...process.env, ...(opts.env ?? {}), CI: process.env.CI ?? '1' },
      windowsHide: true,
      detached: process.platform !== 'win32',
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const append = (target: 'out' | 'err') => (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      if (target === 'out') stdout = cap(stdout + text);
      else stderr = cap(stderr + text);
    };

    child.stdout?.on('data', append('out'));
    child.stderr?.on('data', append('err'));

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, Math.max(500, opts.timeoutMs));

    const onAbort = () => {
      killTree(child);
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ exitCode, stdout, stderr, timedOut, signal, durationMs: Date.now() - started });
    };

    child.on('error', (err) => {
      stderr = cap(`${stderr}${stderr ? '\n' : ''}spawn error: ${err.message}`);
      finish(-1, null);
    });
    child.on('close', (code, signal) => finish(code, signal));
  });
}

function cap(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n\u2026 [output truncated]`;
}

function killTree(child: ReturnType<typeof spawn>): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

/** Workspace-shell tool: the only tool that can have side effects beyond files. */
export const runCommandTool: Tool<{
  command: string;
  cwd?: string;
  timeout_ms?: number;
  purpose?: string;
}> = {
  name: 'run_command',
  description:
    'Run a shell command in the workspace (POSIX sh, or cmd.exe on Windows) and return stdout/stderr with the exit code. ' +
    'Use it for tests, builds, linters, git inspection and running scripts. Read-only commands run automatically; ' +
    'anything with side effects asks the user first, and dangerous commands are refused.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The full command line to execute.' },
      cwd: { type: 'string', description: 'Working directory, workspace-relative. Defaults to the workspace root.' },
      timeout_ms: { type: 'number', description: 'Timeout in milliseconds. Defaults to the configured value (60s).' },
      purpose: { type: 'string', description: 'One short line telling the user why you are running this.' },
    },
    required: ['command'],
  },
  async run(args, ctx) {
    if (!args.command || !args.command.trim()) return fail('"command" must not be empty.', 'bad arguments');

    let cwd;
    try {
      cwd = resolveWorkspacePath(ctx.root, args.cwd, { allowOutside: ctx.config.allowOutsideWorkspace });
    } catch (err) {
      return fail(`Cannot use that working directory: ${(err as Error).message}`, 'bad cwd');
    }
    if (!fs.existsSync(cwd.abs) || !fs.statSync(cwd.abs).isDirectory()) {
      return fail(`Working directory "${cwd.rel}" does not exist.`, 'bad cwd');
    }

    const verdict = evaluateCommand(args.command, {
      policy: ctx.config.commandPolicy,
      allowDangerousCommands: ctx.config.allowDangerousCommands,
    });

    if (verdict.decision === 'deny') {
      return fail(
        `Command refused: ${verdict.reason}.\nCommand: ${args.command}\n` +
          'Choose a safer, more targeted command, or ask the user to run it themselves.',
        'command refused',
        { refused: true },
      );
    }

    if (verdict.decision === 'ask') {
      const decision = await ctx.approval({
        kind: 'command',
        title: 'Run command',
        detail: `${args.command}\n\ncwd: ${cwd.rel === '.' ? '. (workspace root)' : cwd.rel}\nreason: ${verdict.reason}${
          args.purpose ? `\npurpose: ${args.purpose}` : ''
        }`,
        command: args.command,
        relPath: cwd.rel,
      });
      if (decision === 'reject') {
        return fail(
          'User rejected running this command. Do not retry it; continue without it or explain why it is needed.',
          'rejected by user',
          { rejected: true },
        );
      }
    }

    const timeoutMs = Math.max(1000, Math.min(args.timeout_ms ?? ctx.config.commandTimeoutMs, 10 * 60_000));
    ctx.host.log('info', `run_command${verdict.decision === 'allow' ? ' (auto)' : ''}: ${args.command} [cwd=${cwd.rel}]`);
    const result = await runShellCommand(args.command, { cwd: cwd.abs, timeoutMs, signal: ctx.signal });

    const parts: string[] = [];
    parts.push(`$ ${args.command}${cwd.rel === '.' ? '' : `   (cwd: ${cwd.rel})`}`);
    if (result.stdout.trim()) parts.push(`stdout:\n${result.stdout.trimEnd()}`);
    if (result.stderr.trim()) parts.push(`stderr:\n${result.stderr.trimEnd()}`);
    if (!result.stdout.trim() && !result.stderr.trim()) parts.push('(no output)');

    const status = result.timedOut
      ? `timed out after ${timeoutMs} ms`
      : result.signal
        ? `terminated (${result.signal})`
        : `exit code ${result.exitCode}`;
    parts.push(status);

    const summary = result.timedOut
      ? `timed out: ${trimCommand(args.command)}`
      : `exit ${result.exitCode}: ${trimCommand(args.command)}`;

    const failedRun = result.timedOut || result.exitCode !== 0;
    const content = parts.join('\n\n');
    const meta = {
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      mayHaveModifiedFiles: true,
    };
    return failedRun ? fail(content, summary, meta) : ok(content, summary, meta);
  },
};

function trimCommand(command: string): string {
  const oneLine = command.replace(/\s+/g, ' ').trim();
  return oneLine.length > 60 ? `${oneLine.slice(0, 57)}\u2026` : oneLine;
}

/** Resolve a binary from the workspace (used by the agent for hints). */
export function findBinary(name: string, cwd: string): string | undefined {
  const local = path.join(cwd, 'node_modules', '.bin', name);
  if (fs.existsSync(local)) return local;
  return undefined;
}
