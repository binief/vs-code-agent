import { spawn, spawnSync, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { evaluateCommand } from '../policy';
import { resolveWorkspacePath } from '../paths';
import { fail, ok, type Tool } from '../types';

const MAX_OUTPUT_CHARS = 20_000;
/** Max number of output lines to keep per running command for monitoring. */
const MAX_OUTPUT_LINES = 200;

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
  /** Most recent output lines (capped), for monitoring background commands. */
  outputLines: string[];
}

/** Internal tracking entry: child process plus buffered output. */
interface RunningCommandEntry {
  child: ReturnType<typeof spawn>;
  info: RunningCommandInfo;
  /** Accumulator for incomplete lines that span chunks. */
  outputBuffer: string;
}

/** Tracks currently running shell commands (both detached and non-detached)
 *  so they can be listed or killed when they hang. */
const runningCommands = new Map<number, RunningCommandEntry>();

/** Optional callback invoked whenever the running-commands set changes,
 *  so the host layer can sync the webview UI proactively. */
let onRunningCommandsChange: (() => void) | undefined;

/** Register a callback to be invoked on every running-commands change. */
export function setRunningCommandsChangeHandler(handler: () => void): void {
  onRunningCommandsChange = handler;
}

/** Unregister the global handler (e.g. when the owning controller shuts down). */
export function clearRunningCommandsChangeHandler(): void {
  onRunningCommandsChange = undefined;
}

/** Notify listeners that the running-commands set has changed. */
function notifyRunningCommandsChange(): void {
  onRunningCommandsChange?.();
}

/** Returns info about all currently running shell commands. */
export function getRunningCommands(): RunningCommandInfo[] {
  return [...runningCommands.values()].map((entry) => entry.info);
}

/** Returns the most recent output lines for a running command (capped). */
export function getRunningCommandOutput(pid: number): string[] {
  const entry = runningCommands.get(pid);
  return entry ? [...entry.info.outputLines] : [];
}

/** Kills a running command by PID. Returns true if found and killed. */
export function killRunningCommand(pid: number): boolean {
  const entry = runningCommands.get(pid);
  if (!entry) return false;
  killTree(entry.child);
  runningCommands.delete(pid);
  notifyRunningCommandsChange();
  return true;
}

/** Kills all running shell commands. Returns the count killed. */
export function killAllRunningCommands(): number {
  const count = runningCommands.size;
  for (const entry of runningCommands.values()) {
    killTree(entry.child);
  }
  runningCommands.clear();
  if (count > 0) notifyRunningCommandsChange();
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
    /** Kill the command if no stdout/stderr output arrives within this many ms. */
    idleTimeoutMs?: number;
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
    // Non-interactive environment: prevent pagers, prompts, and TTY-driven
    // UI from blocking on stdin. stdin is set to 'ignore' (/dev/null) so any
    // command that reads from stdin gets EOF immediately instead of hanging.
    const nonInteractiveEnv = {
      CI: '1',
      GIT_PAGER: 'cat',
      PAGER: 'cat',
      TERM: 'dumb',
      NO_COLOR: '1',
      DEBIAN_FRONTEND: 'noninteractive',
      ...(opts.env ?? {}),
    };
    const child = spawn(command, {
      cwd: opts.cwd,
      shell: true,
      env: { ...process.env, ...nonInteractiveEnv },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32' || opts.detached === true,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    /** Timer that kills the process if no output arrives within idleTimeoutMs. */
    let idleTimer: NodeJS.Timeout | undefined;

    const resetIdleTimer = () => {
      if (!opts.idleTimeoutMs || opts.idleTimeoutMs <= 0) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        timedOut = true;
        killTree(child);
        setTimeout(forceFinish, 2000);
      }, opts.idleTimeoutMs);
    };

    const append = (target: 'out' | 'err') => (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      if (target === 'out') stdout = cap(stdout + text);
      else stderr = cap(stderr + text);
      opts.onOutput?.(text, target === 'out' ? 'stdout' : 'stderr');
      resetIdleTimer();

      // Buffer output for monitoring background/detached commands.
      const entry = runningCommands.get(child.pid ?? 0);
      if (entry) {
        entry.outputBuffer += text;
        const lines = entry.outputBuffer.split('\n');
        // Everything before the last fragment is a complete line.
        for (let i = 0; i < lines.length - 1; i++) {
          const line = lines[i].trimEnd();
          if (line) {
            entry.info.outputLines.push(`[${target}] ${line}`);
            if (entry.info.outputLines.length > MAX_OUTPUT_LINES) {
              entry.info.outputLines.shift();
            }
          }
        }
        entry.outputBuffer = lines[lines.length - 1];
      }
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
      outputLines: [],
    };
    runningCommands.set(child.pid ?? 0, { child, info, outputBuffer: '' });
    notifyRunningCommandsChange();

    const cleanupTracking = () => {
      // Flush any remaining partial line before removing from tracking.
      const entry = runningCommands.get(child.pid ?? 0);
      if (entry && entry.outputBuffer.trim()) {
        entry.info.outputLines.push(`[stdout] ${entry.outputBuffer.trim()}`);
        if (entry.info.outputLines.length > MAX_OUTPUT_LINES) {
          entry.info.outputLines.shift();
        }
      }
      runningCommands.delete(child.pid ?? 0);
      notifyRunningCommandsChange();
    };

    /** Kill the child process tree and resolve as cancelled/terminated. */
    const onAbort = () => {
      killTree(child);
      if (idleTimer) clearTimeout(idleTimer);
      if (!opts.detached) {
        setTimeout(forceFinish, 2000);
      } else if (!settled) {
        settled = true;
        opts.signal?.removeEventListener('abort', onAbort);
        cleanupTracking();
        resolve({ exitCode: null, stdout, stderr, timedOut: false, signal: 'SIGKILL', durationMs: Date.now() - started });
      }
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    // Guard against a race where the signal aborts between the pre-spawn
    // aborted check and the listener registration above.
    if (opts.signal?.aborted) onAbort();

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
          notifyRunningCommandsChange();
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
        opts.signal?.removeEventListener('abort', onAbort);
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

    // Start the idle watchdog so a command that produces no output is killed.
    resetIdleTimer();

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (idleTimer) clearTimeout(idleTimer);
      opts.signal?.removeEventListener('abort', onAbort);
      cleanupTracking();
      resolve({ exitCode, stdout, stderr, timedOut, signal, durationMs: Date.now() - started });
    };

    child.on('error', (err) => {
      stderr = cap(`${stderr}${stderr ? '\n' : ''}spawn error: ${err.message}`);
      finish(-1, null);
    });
    // Use 'exit' instead of 'close': 'close' waits for all stdio streams to
    // close, which never happens if a grandchild inherits and holds stdout.
    // 'exit' fires as soon as the process terminates, which is what we need.
    child.on('exit', (code, signal) => finish(code, signal));
  });
}

function cap(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n\u2026 [output truncated]`;
}

/**
 * Snapshot all descendant PIDs of a process on Unix, deepest-first. This must
 * happen BEFORE any kill: once the parent dies its children are reparented, so
 * a later `ps -eo pid,ppid` scan can no longer find them.
 */
function descendantPidsUnix(rootPid: number): number[] {
  const childrenOf = new Map<number, number[]>();
  try {
    const stdout = execFileSync('ps', ['-eo', 'pid,ppid'], { encoding: 'utf8' });
    for (const line of stdout.trim().split('\n').slice(1)) {
      const parts = line.trim().split(/\s+/);
      const pid = Number(parts[0]);
      const ppid = Number(parts[1]);
      if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(ppid)) continue;
      const siblings = childrenOf.get(ppid) ?? [];
      siblings.push(pid);
      childrenOf.set(ppid, siblings);
    }
  } catch {
    return []; // ps unavailable; fall back to process-group kill only
  }

  const descendants: number[] = [];
  const visit = (pid: number): void => {
    for (const childPid of childrenOf.get(pid) ?? []) {
      visit(childPid);
      descendants.push(childPid);
    }
  };
  visit(rootPid);
  return descendants;
}

/**
 * Windows keeps the (possibly dead) parent PID in Win32_Process.ParentProcessId
 * after a process exits, so descendants can still be found by walking the tree.
 * `taskkill /T` cannot do that: it requires a live root. This is what lets us
 * kill cmd windows left behind by `start /b` after the shell has already gone.
 */
function descendantPidsWindows(rootPid: number): number[] {
  // One CIM query, then breadth-first walk of the parent -> children map.
  const script = `
$procs = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId
$children = @{}
foreach ($p in $procs) {
  $key = [int]$p.ParentProcessId
  if (-not $children.ContainsKey($key)) { $children[$key] = [System.Collections.Generic.List[int]]::new() }
  $children[$key].Add([int]$p.ProcessId)
}
$queue = [System.Collections.Generic.Queue[int]]::new()
$queue.Enqueue(${rootPid})
$result = [System.Collections.Generic.List[int]]::new()
while ($queue.Count -gt 0) {
  $current = $queue.Dequeue()
  foreach ($next in $children[$current]) { $result.Add($next); $queue.Enqueue($next) }
}
$result | ForEach-Object { $_ }
`;
  try {
    const stdout = execFileSync('powershell', ['-NoProfile', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
    });
    // Number('') is 0, and killing PID 0 targets the whole process group.
    return stdout.split(/\s+/).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
}

function killTree(child: ReturnType<typeof spawn>): void {
  if (child.pid === undefined) return;
  const pid = child.pid;

  if (process.platform === 'win32') {
    // A live root can be handled by taskkill /T alone. When the shell has
    // already exited (e.g. `start /b` kept a child holding the output pipe),
    // taskkill /T fails, so find the orphaned tree by PID and kill it first.
    // Kill deepest-first so a parent cannot reparent its children mid-walk.
    let rootAlive = true;
    try { process.kill(pid, 0); } catch { rootAlive = false; }
    const descendants = rootAlive ? [] : descendantPidsWindows(pid).reverse();
    for (const descendant of descendants) {
      try { process.kill(descendant, 'SIGKILL'); } catch { /* already gone */ }
    }
    // taskkill /T /F also catches children spawned between the scan and now,
    // but only works while the root is alive. Run it synchronously so tracking
    // is not cleared before the tree is gone.
    try {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
        windowsHide: true,
        encoding: 'utf8',
        timeout: 5000,
      });
    } catch {
      /* taskkill unavailable; child.kill below still stops the shell */
    }
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    return;
  }

  // Snapshot descendants first, then kill the process group and each
  // descendant explicitly. Descendants that created their own process group
  // escape the group kill, and would be unfindable after the parent dies.
  const descendants = descendantPidsUnix(pid);
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    /* shell is not a process-group leader; individual kills below still run */
  }
  for (const descendant of descendants) {
    try { process.kill(descendant, 'SIGKILL'); } catch { /* already gone */ }
  }
  // Finally ensure the shell itself is dead. SIGKILL cannot be caught or
  // ignored, so this is the only reliable way to stop it.
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* child may already be gone */
  }
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
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
  /** Kill the command if no stdout/stderr output arrives within this many ms.
   *  When omitted, no idle watchdog is used. */
  idle_timeout_ms?: number;
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
      idle_timeout_ms: {
        type: 'number',
        description: 'Kill the command if no stdout/stderr output arrives within this many ms.',
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

    // When a command looks like a long-running server and detached is not set,
    // offer to move it to the background so the task can keep moving forward.
    const LONG_RUNNING = /\b(mvn|maven|gradle|mvnw|gradlew|java|node|python|python3|ruby|php|dotnet)\b/;
    let detached = args.detached === true;
    if (!detached && LONG_RUNNING.test(args.command) && ctx.host.prompt) {
      const choice = await ctx.host.prompt(
        `Command may run indefinitely: "${args.command}".\nRun it in the background so the task can continue?`,
        ['Run in background', 'Run in foreground', 'Cancel'],
      );
      if (choice === 2) {
        return fail('User cancelled running this command.', 'cancelled', { cancelled: true });
      }
      detached = choice === 0;
    }

    const result = await runShellCommand(args.command, {
      cwd: cwd.abs,
      timeoutMs,
      signal: ctx.signal,
      detached,
      detached_timeout_ms: args.detached_timeout_ms,
      idleTimeoutMs: args.idle_timeout_ms,
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
