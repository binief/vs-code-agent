/**
 * System-message builder.
 *
 * This module deliberately contains **no behavioural instructions**. It only
 * describes the environment, the workspace, the files the editor has open and
 * the tools that are available, then appends the agent instruction files
 * verbatim. Every instruction the model acts on comes from those files.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { formatAgentInstructions, type AgentFilesResult } from './agentFiles';
import { normalizeEol } from './lineEndings';
import { formatBytes, toPosix } from './paths';
import type { HarnessConfig, ToolSpec, WorkspaceContext } from './types';

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

const TOP_LEVEL_SKIP = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'out',
  'build',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
  '.next',
  'target',
]);

export interface GitSnapshot {
  branch?: string;
  head?: string;
  changes?: string[];
  changeCount?: number;
}

function gitDir(root: string): string | undefined {
  const dotGit = path.join(root, '.git');
  try {
    const stat = fs.statSync(dotGit);
    if (stat.isDirectory()) return dotGit;
    if (stat.isFile()) {
      const text = fs.readFileSync(dotGit, 'utf8').trim();
      const match = /^gitdir:\s*(.+)$/m.exec(text);
      if (match) return path.resolve(root, match[1].trim());
    }
  } catch {
    /* not a git checkout */
  }
  return undefined;
}

function readRef(dir: string, ref: string): string | undefined {
  try {
    return fs.readFileSync(path.join(dir, ref), 'utf8').trim();
  } catch {
    /* try packed-refs */
  }
  try {
    const packed = fs.readFileSync(path.join(dir, 'packed-refs'), 'utf8');
    for (const line of packed.split('\n')) {
      if (!line || line.startsWith('#')) continue;
      const [sha, name] = line.trim().split(/\s+/);
      if (name === ref) return sha;
    }
  } catch {
    /* no packed refs */
  }
  return undefined;
}

/** Cheap, read-only git facts: branch, HEAD and a bounded status list. */
export function readGitSnapshot(root: string): GitSnapshot | undefined {
  const dir = gitDir(root);
  if (!dir) return undefined;
  const out: GitSnapshot = {};
  try {
    const head = fs.readFileSync(path.join(dir, 'HEAD'), 'utf8').trim();
    if (head.startsWith('ref: ')) {
      const ref = head.slice(5).trim();
      out.branch = ref.replace(/^refs\/heads\//, '');
      out.head = readRef(dir, ref)?.slice(0, 8);
    } else {
      out.head = head.slice(0, 8);
    }
  } catch {
    return out;
  }
  try {
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: root,
      timeout: 1500,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const lines = status.split('\n').filter((line) => line.trim());
    out.changeCount = lines.length;
    out.changes = lines.slice(0, 12).map((line) => line.replace(/\s+$/, ''));
  } catch {
    /* git is absent, slow, or refused to run: the rest of the context still works */
  }
  return out;
}

function toolDescription(description: string): string {
  const oneLine = description.replace(/\s+/g, ' ').trim();
  return oneLine.length > 320 ? `${oneLine.slice(0, 317)}…` : oneLine;
}

function environmentSection(root: string, config: HarnessConfig, workspace?: WorkspaceContext): string {
  const git = readGitSnapshot(root);
  const folders = workspace?.folders?.length ? workspace.folders : [root];
  const shell =
    process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : process.env.SHELL || '/bin/sh';
  const lines = [
    `- Workspace root: ${toPosix(root)}`,
    ...(folders.length > 1 ? [`- Workspace folders: ${folders.map((f) => toPosix(f)).join(', ')}`] : []),
    `- Extension: Coding Harness (VS Code extension)`,
    `- Platform: ${process.platform} ${os.release()} (${process.arch})`,
    `- Shell: ${shell}`,
    `- Node.js: ${process.version}`,
    `- Editor: ${workspace?.editor ? `${workspace.editor.name} ${workspace.editor.version}` : 'unknown'}`,
    `- Time: ${new Date().toISOString()} (${Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time'})`,
    `- Line-ending policy: ${config.lineEndings}`,
    `- Workspace confinement: ${config.allowOutsideWorkspace ? 'off' : 'on (paths outside the workspace are refused)'}`,
    `- Edit approval: ${config.editPolicy}; command approval: ${config.commandPolicy}; command timeout: ${config.commandTimeoutMs} ms`,
  ];
  if (git?.branch) {
    lines.push(`- Git branch: ${git.branch}${git.head ? ` at ${git.head}` : ''}`);
  } else if (git?.head) {
    lines.push(`- Git HEAD: ${git.head} (detached)`);
  } else {
    lines.push('- Git: not a git checkout');
  }
  if (git?.changeCount !== undefined) {
    lines.push(
      `- Uncommitted changes: ${git.changeCount}` +
        (git.changes?.length ? `\n${git.changes.map((line) => `    ${line}`).join('\n')}` : ''),
    );
  }
  for (const [key, value] of Object.entries(workspace?.environment ?? {})) {
    if (value) lines.push(`- ${key}: ${value}`);
  }
  return lines.join('\n');
}

/** Project layout and manifest facts so the model does not have to ask for them. */
export function workspaceSnapshot(root: string): string {
  const lines: string[] = [];

  let topLevel: string[] = [];
  try {
    topLevel = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => !TOP_LEVEL_SKIP.has(d.name))
      .slice(0, 60)
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
      text = normalizeEol(fs.readFileSync(abs, 'utf8'));
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
    if (head) lines.push(`${manifest} (first ${Math.min(25, head.split('\n').length)} lines):\n${head}`);
  }

  return lines.join('\n') || 'The workspace root could not be read.';
}

function describeOpenFile(file: { path: string; languageId?: string; dirty?: boolean; lineCount?: number }): string {
  const bits: string[] = [];
  if (file.languageId) bits.push(file.languageId);
  if (file.lineCount !== undefined) bits.push(`${file.lineCount} lines`);
  if (file.dirty) bits.push('unsaved changes');
  return `${toPosix(file.path)}${bits.length ? ` (${bits.join(', ')})` : ''}`;
}

function openEditorsSection(workspace: WorkspaceContext | undefined, config: HarnessConfig): string {
  const lines: string[] = [];
  const active = workspace?.activeFile;
  const open = workspace?.openFiles ?? [];

  if (active) {
    lines.push(`- Active file: ${describeOpenFile(active)}`);
    if (active.selection) {
      lines.push(`- Selection in the active file: lines ${active.selection.startLine}-${active.selection.endLine}`);
    }
  }
  const others = open.filter((file) => !file.active && file.path !== active?.path);
  if (others.length) {
    lines.push(`- Other open editors (${others.length}):`);
    for (const file of others.slice(0, 25)) lines.push(`    ${describeOpenFile(file)}`);
    if (others.length > 25) lines.push(`    … ${others.length - 25} more`);
  }
  if (!active && open.length === 0) {
    lines.push('- No editor tabs were open when this task started.');
  }
  const limit = config.maxFileBytes > 0 ? formatBytes(config.maxFileBytes) : 'no limit';
  lines.push(`- File size limit for tools: ${limit} (codingHarness.maxFileBytes)`);
  return lines.join('\n');
}

function diagnosticsSection(diagnostics: string[] | undefined): string {
  if (!diagnostics?.length) return '- Current editor problems: none reported.';
  const lines = [
    `- Current editor problems (snapshot, may be stale):`,
    ...diagnostics.slice(0, 40).map((line) => `    ${line}`),
  ];
  if (diagnostics.length > 40) lines.push(`    … ${diagnostics.length - 40} more`);
  return lines.join('\n');
}

function toolsSection(config: HarnessConfig, tools: ToolSpec[]): string {
  const lines = [`Available tools (${tools.length}):`];
  for (const tool of tools) lines.push(`- \`${tool.name}\` — ${toolDescription(tool.description)}`);
  lines.push(
    '',
    'Tool behaviour comes from the extension, not from this message: edits are checkpointed and can be reverted; ' +
      `writes follow editPolicy=${config.editPolicy}; shell commands follow commandPolicy=${config.commandPolicy}.`,
  );
  return lines.join('\n');
}

export interface SystemPromptOptions {
  root: string;
  config: HarnessConfig;
  tools: ToolSpec[];
  /** Compact "file:line SEVERITY message" list of current editor problems. */
  diagnostics?: string[];
  /** Editor/workspace facts gathered from the host. */
  workspace?: WorkspaceContext;
  /** Instruction files loaded for this task. */
  agentFiles?: AgentFilesResult;
}

/**
 * Build the system message: factual context first, instruction files last.
 * There is no hard-coded prompt to fall back to when no agent file exists.
 */
export function buildSystemPrompt(opts: SystemPromptOptions): string {
  const { root, config, tools, diagnostics, workspace, agentFiles } = opts;
  const parts: string[] = [];

  if (config.context.environment) {
    parts.push(`# Environment\n${environmentSection(root, config, workspace)}`);
  }
  if (config.context.workspace) {
    parts.push(`# Workspace\n${workspaceSnapshot(root)}`);
  }
  if (config.context.files || config.context.diagnostics) {
    const fileLines: string[] = [];
    if (config.context.files) fileLines.push(openEditorsSection(workspace, config));
    if (config.context.diagnostics) fileLines.push(diagnosticsSection(diagnostics));
    parts.push(`# Files\n${fileLines.join('\n')}`);
  }
  if (config.context.tools) {
    parts.push(`# Tools\n${toolsSection(config, tools)}`);
  }
  parts.push(
    `# Agent instructions\n${agentFiles ? formatAgentInstructions(agentFiles) : 'No agent instruction files were loaded for this task.'}`,
  );

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
