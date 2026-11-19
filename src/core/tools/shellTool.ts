import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { evaluateCommand } from '../policy';
import { resolveWorkspacePath } from '../paths';
import { fail, ok, type Tool } from '../types';

const MAX_OUTPUT_CHARS = 20_000;

/** No default timeout for detached commands — servers run indefinitely.
 *  Set `detached_timeout_ms` explicitly if you want auto-kill behavior. */
export const DETACHED_DEFAULT_TIMEOUT_MS: number | undefined = undefined;

/** Info about a currently running shell command. */
export interface RunningCommandInfo {
  pid: number;
  command: string;
  cwd: string;
  startedAt: number;
  detached: boolean;
}

/** Tracks currently running shell commands (both detached and non-detached)
 *  so they can be listed or killed when they hang. */
const runningCommands = new Map<
  number,
  { child: ReturnType<typeof spawn>; info: RunningCommandInfo }
>();

/** Returns info about all currently running shell commands. */
export function getRunningCommands(): RunningCommandInfo[] {
  return [...runningCommands.values()].map((entry) => entry.info);
}

/** Kills a running command by PID. Returns true if found and killed. */
export function killRunningCommand(pid: number): boolean {
  const entry = runningCommands.get(pid);
  if (!entry) return false;
  killTree(entry.child);
  runningCommands.delete(pid);
  return true;
}

/** Kills all running shell commands. Returns the count killed. */
export function killAllRunningCommands(): number {
  const count = runningCommands.size;
  for (const entry of runningCommands.values()) {
    killTree(entry.child);
  }
  runningCommands.clear();
  return count;
}

/** Backwards-compatible aliases for detached process management. */
export const getDetachedProcesses = getRunningCommands;
export const killDetachedProcess = killRunningCommand;
export const killAllDetachedProcesses = killAllRunningCommands;

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
  opts: {
    cwd: string;
    timeoutMs: number;
    signal?: AbortSignal;
    env?: NodeJS.ProcessEnv;
    detached?: boolean;
    detached_timeout_ms?: number;
    /** Called incrementally with stdout/stderr text as it arrives. */
    onOutput?: (text: string, stream: 'stdout' | 'stderr') => void;
  },
): Promise<CommandOutput> {
  return new Promise((resolve) => {
    const started = Date.now();
    if (opts.signal?.aborted) {
      resolve({ exitCode: null, stdout: '', stderr: 'Cancelled before starting.', timedOut: false, durationMs: 0 });
      return;
    }
    const child = spawn(command, {
      cwd: opts.cwd,
      shell: true,
      env: { ...process.env, ...(opts.env ?? {}), CI: process.env.CI ?? '1' },
      windowsHide: true,
      detached: process.platform !== 'win32' || opts.detached === true,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const append = (target: 'out' | 'err') => (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      if (target === 'out') stdout = cap(stdout + text);
      else stderr = cap(stderr + text);
      opts.onOutput?.(text, target === 'out' ? 'stdout' : 'stderr');
    };

    child.stdout?.on('data', append('out'));
    child.stderr?.on('data', append('err'));

    /** Force-resolve the promise if the child does not exit after being killed. */
    const forceFinish = () => {
      if (!settled) {
        finish(null, 'SIGKILL');
      }
    };

    // Track the command so it can be listed/killed if it hangs.
    const info: RunningCommandInfo = {
      pid: child.pid ?? 0,
      command,
      cwd: opts.cwd,
      startedAt: started,
      detached: opts.detached === true,
    };
    runningCommands.set(child.pid ?? 0, { child, info });

    const cleanupTracking = () => {
      runningCommands.delete(child.pid ?? 0);
    };

    if (opts.detached === true) {
      // Detached mode: resolve after a short delay so initial output can be
      // captured, without waiting for background child processes to exit.
      // Servers run indefinitely — auto-kill only when detached_timeout_ms
      // is explicitly set by the caller.
      let timeoutTimer: NodeJS.Timeout | undefined;
      if (opts.detached_timeout_ms !== undefined) {
        timeoutTimer = setTimeout(() => {
          // Auto-kill detached process after explicit timeout.
          killTree(child);
          runningCommands.delete(child.pid ?? 0);
          if (!settled) {
            settled = true;
            opts.signal?.removeEventListener('abort', onAbort);
            resolve({
              exitCode: null,
              stdout,
              stderr: `${stderr}\n[detached process killed after ${opts.detached_timeout_ms}ms timeout]`,
              timedOut: true,
              signal: 'SIGKILL',
              durationMs: Date.now() - started,
            });
          }
        }, opts.detached_timeout_ms);
      }

      // Clean up from tracking when the process exits on its own.
      child.on('close', () => {
        cleanupTracking();
        if (timeoutTimer) clearTimeout(timeoutTimer);
      });

      setTimeout(() => {
        if (!settled) {
          settled = true;
          opts.signal?.removeEventListener('abort', onAbort);
          resolve({ exitCode: null, stdout, stderr, timedOut: false, signal: null, durationMs: Date.now() - started });
        }
      }, 500);
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      setTimeout(forceFinish, 2000);
    }, Math.max(500, opts.timeoutMs));

    const onAbort = () => {
      killTree(child);
      setTimeout(forceFinish, 2000);
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    // Guard against a race where the signal aborts between the pre-spawn
    // aborted check and the listener registration above.
    if (opts.signal?.aborted) onAbort();

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      cleanupTracking();
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
      // Terminate the shell process immediately, then clean up its process
      // tree (e.g. a Java process started via `start /b`) with taskkill /T.
      child.kill();
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
  /** When true, resolve as soon as the shell exits without waiting for
   *  background child processes (e.g. `start /b java -jar ...`) to finish.
   *  Useful for starting long-running servers. The child keeps running
   *  detached from the harness. */
  detached?: boolean;
  /** Auto-kill the detached process after this many milliseconds.
   *  When omitted, detached servers run indefinitely and are never auto-killed.
   *  Only applies when detached is true. */
  detached_timeout_ms?: number;
}> = {
  name: 'run_command',
  description:
    'Run a shell command in the workspace (POSIX sh, or cmd.exe on Windows) and return stdout/stderr with the exit code. ' +
    'Execution and approval depend on command policy; dangerous commands may be refused. ' +
    'Use `detached: true` to start a long-running background process (e.g. a dev server) ' +
    'and return immediately instead of waiting for it to exit.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The full command line to execute.' },
      cwd: { type: 'string', description: 'Working directory, workspace-relative. Defaults to the workspace root.' },
      timeout_ms: { type: 'number', description: 'Timeout in milliseconds. Defaults to the configured value (60s).' },
      purpose: { type: 'string', description: 'One short line telling the user why you are running this.' },
      detached: { type: 'boolean', description: 'Run in the background and return without waiting for completion.' },
      detached_timeout_ms: {
        type: 'number',
        description: 'Auto-kill detached process after this many ms. When omitted, detached servers run indefinitely.',
      },
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

    if (ctx.signal?.aborted) return fail('Cancelled before running this command.', 'cancelled', { cancelled: true });
    const timeoutMs = Math.max(1000, Math.min(args.timeout_ms ?? ctx.config.commandTimeoutMs, 10 * 60_000));
    ctx.host.log('info', `run_command${verdict.decision === 'allow' ? ' (auto)' : ''}: ${args.command} [cwd=${cwd.rel}]`);

    // Notify the user that a command is running and how to stop it if it hangs.
    // This is shown for every non-detached command so the user always has a
    // way to manually stop a long-running command.
    ctx.host.notify?.(
      `Command running: ${args.command}\nUse "Coding Harness: Stop Running Commands" to stop it if it takes too long.`,
      'info',
    );

    // Warn when a command looks like a long-running server but detached is not set,
    // so the user knows it may block the task until stopped.
    const LONG_RUNNING = /\\b(mvn|maven|gradle|mvnw|gradlew|java|node|python|python3|ruby|php|dotnet)\\b/;
    if (!args.detached && LONG_RUNNING.test(args.command)) {
      ctx.host.notify?.(
        `Command may run indefinitely: "${args.command}". Consider detached: true to start it in the background and return immediately.`,
        'warn',
      );
    }

    const result = await runShellCommand(args.command, {
      cwd: cwd.abs,
      timeoutMs,
      signal: ctx.signal,
      detached: args.detached,
      detached_timeout_ms: args.detached_timeout_ms,
    });

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
