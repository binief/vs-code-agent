import * as fs from 'fs';
import * as path from 'path';
import { formatBytes, toPosix } from './paths';
import type { HarnessConfig, ToolSpec } from './types';

const INTERESTING_TOP_LEVEL = [
  'package.json',
  'pyproject.toml',
  'requirements.txt',
  'Cargo.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'Gemfile',
  'composer.json',
  'Makefile',
  'justfile',
  'docker-compose.yml',
  'Dockerfile',
  'tsconfig.json',
];

/** Cheap, synchronous project snapshot so the model does not need to ask for it. */
export function workspaceSnapshot(root: string, config: HarnessConfig): string {
  const lines: string[] = [`Workspace root: ${toPosix(root)}`];

  let topLevel: string[] = [];
  try {
    topLevel = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => !['node_modules', '.git', 'dist', 'out', 'build', '__pycache__', '.venv', 'venv'].includes(d.name))
      .slice(0, 40)
      .map((d) => (d.isDirectory() ? `${d.name}/` : d.name));
  } catch {
    /* unreadable root: not fatal */
  }
  if (topLevel.length) lines.push(`Top level: ${topLevel.join('  ')}`);

  for (const manifest of INTERESTING_TOP_LEVEL) {
    const abs = path.join(root, manifest);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size > 256 * 1024) continue;
    let text = '';
    try {
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    if (manifest === 'package.json') {
      try {
        const pkg = JSON.parse(text) as {
          name?: string;
          scripts?: Record<string, string>;
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
          packageManager?: string;
        };
        const scripts = Object.keys(pkg.scripts ?? {}).slice(0, 14);
        const deps = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})].slice(0, 30);
        lines.push(
          `package.json: name=${pkg.name ?? '?'}${pkg.packageManager ? `, packageManager=${pkg.packageManager}` : ''}` +
            (scripts.length ? `\n  scripts: ${scripts.join(', ')}` : '') +
            (deps.length ? `\n  dependencies (first 30): ${deps.join(', ')}` : ''),
        );
      } catch {
        lines.push('package.json: (unparseable)');
      }
      continue;
    }
    const head = text.split('\n').slice(0, 25).join('\n').trim();
    lines.push(`${manifest} (first ${Math.min(25, head.split('\n').length)} lines):\n${head}`);
  }

  try {
    const head = fs.readFileSync(path.join(root, '.git', 'HEAD'), 'utf8').trim();
    const branch = head.startsWith('ref: refs/heads/') ? head.slice('ref: refs/heads/'.length) : head.slice(0, 12);
    lines.push(`git branch: ${branch}`);
  } catch {
    /* not a git repo */
  }

  lines.push(`Platform: ${process.platform} \u2014 shell tool uses ${process.platform === 'win32' ? 'cmd.exe' : '/bin/sh'}.`);
  return lines.join('\n');
}

export interface SystemPromptOptions {
  root: string;
  config: HarnessConfig;
  tools: ToolSpec[];
  /** Compact "file:line SEVERITY message" list of current editor problems. */
  diagnostics?: string[];
}

const BASE = `You are Coding Harness, an autonomous coding agent running inside a VS Code extension.
You work only through the tools provided. You cannot see the user's screen or their editor state except
through tool results, so verify with tools instead of guessing.

## Operating rules
1. EXPLORE FIRST. Before editing, locate the relevant code with list_files / search_text and read the
   files you are about to change (read_file). Never invent file contents, APIs or paths.
2. SMALL, FOCUSED CHANGES. Make the smallest edit that satisfies the request. Prefer replace_in_file with
   an exact snippet over rewriting a whole file with write_file. Preserve existing formatting, quoting and
   style; do not reformat unrelated code and do not delete unrelated code.
3. CREATE ONLY WHAT IS NEEDED. Do not add dependencies, configs or scaffolding the user did not ask for.
   If a dependency seems necessary, explain it and ask instead of silently changing manifests.
4. VERIFY. After editing, sanity-check your work: use get_diagnostics, run the project's own test/build/lint
   command when one exists in the snapshot below, or at minimum re-read the changed region. Fix what your
   own change broke. Never claim something works if you did not check it.
5. STAY IN SCOPE. The tools are confined to the workspace. If a task needs something outside the workspace
   or a command the safety layer refuses, say so plainly instead of working around it.
6. PARALLELISE READS. Independent reads/searches can be requested in one turn; file writes are applied in order.
7. ONE LINE OF INTENT. Start each turn with a single short sentence saying what you are about to do. No
   preamble about being an AI, no restating the whole request.
8. FINISH CLEARLY. When the task is done (or you are blocked), stop calling tools and reply with a short
   summary: what changed, which files, how you verified it, and anything the user should decide next.
9. If the request is ambiguous or destructive, ask a single clarifying question instead of guessing.
10. If a tool is refused or rejected by the user, do not retry it verbatim \u2014 adapt or explain why it matters.`;

export function buildSystemPrompt(opts: SystemPromptOptions): string {
  const { root, config, tools, diagnostics } = opts;
  const parts: string[] = [BASE];

  parts.push(`## Environment\n${workspaceSnapshot(root, config)}`);

  parts.push(
    `## Tools\n` +
      tools.map((t) => `- \`${t.name}\`: ${t.description}`).join('\n') +
      `\nEdits and side-effecting commands may require user approval; a rejection comes back as a failed tool\n` +
      `result and you should adapt rather than repeat. Current policies: editPolicy=${config.editPolicy}, ` +
      `commandPolicy=${config.commandPolicy}, workspace confinement=${config.allowOutsideWorkspace ? 'off' : 'on'}.`,
  );

  if (diagnostics && diagnostics.length) {
    parts.push(
      `## Current editor problems (snapshot, may be stale)\n` +
        diagnostics.slice(0, 40).join('\n') +
        (diagnostics.length > 40 ? `\n\u2026 ${diagnostics.length - 40} more` : ''),
    );
  }

  if (config.systemPromptExtra?.trim()) {
    parts.push(`## Project-specific instructions (from the user's settings)\n${config.systemPromptExtra.trim()}`);
  }

  return parts.join('\n\n');
}

export function summarizeDiagnostics(
  diags: { file: string; line: number; severity: string; message: string }[],
  limit = 40,
): string[] {
  return diags
    .filter((d) => d.severity === 'error' || d.severity === 'warning')
    .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1))
    .slice(0, limit)
    .map((d) => `${d.file}:${d.line} ${d.severity.toUpperCase()} ${d.message.slice(0, 160)}`);
}

export function describeFile(abs: string): string {
  try {
    const stat = fs.statSync(abs);
    return `${toPosix(abs)} (${formatBytes(stat.size)})`;
  } catch {
    return toPosix(abs);
  }
}
