import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, test } from 'node:test';

import { discoverAgentFiles } from '../core/agentFiles';
import { MockPlannerProvider } from '../core/providers/mock';
import { buildSystemPrompt } from '../core/prompt';
import { DEFAULT_CONFIG, resolveConfig, type ChatMessage, type HarnessConfig } from '../core/types';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-prompt-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function config(overrides: Partial<HarnessConfig> = {}): HarnessConfig {
  return resolveConfig({ ...DEFAULT_CONFIG, ...overrides });
}

test('the system message is context only — no built-in behavioural prompt', () => {
  const prompt = buildSystemPrompt({
    root: tmp,
    config: DEFAULT_CONFIG,
    tools: [],
    diagnostics: [],
    workspace: {
      editor: { name: 'Visual Studio Code', version: '1.95.0' },
      openFiles: [],
    },
    agentFiles: discoverAgentFiles({ root: tmp, config: DEFAULT_CONFIG.agentFiles }),
  });

  assert.match(prompt, /^# Environment/m, 'the environment comes first');
  assert.match(prompt, /# Workspace/);
  assert.match(prompt, /# Files/);
  assert.match(prompt, /# Tools/);
  assert.match(prompt, /# Agent instructions/);
  assert.match(prompt, /No agent instruction files were found/);

  // The old hard-coded personality/rules must be gone.
  assert.doesNotMatch(prompt, /You are Coding Harness/);
  assert.doesNotMatch(prompt, /three moves: gather, decide, act/);
  assert.doesNotMatch(prompt, /EXPLORE FIRST/);
  assert.doesNotMatch(prompt, /ONLY when the user\s+explicitly asked/);
});

test('environment, workspace and editor context are described factually', () => {
  const prompt = buildSystemPrompt({
    root: tmp,
    config: config(),
    tools: [{ name: 'read_file', description: 'Read a file.', parameters: { type: 'object' } }],
    diagnostics: ['src/a.ts:4 ERROR expected ;'],
    workspace: {
      editor: { name: 'Visual Studio Code', version: '1.95.0' },
      folders: [tmp],
      activeFile: { path: 'src/a.ts', languageId: 'typescript', lineCount: 20, dirty: true, active: true, selection: { startLine: 3, endLine: 5 } },
      openFiles: [
        { path: 'src/a.ts', languageId: 'typescript', lineCount: 20, dirty: true, active: true, selection: { startLine: 3, endLine: 5 } },
        { path: 'README.md', languageId: 'markdown', lineCount: 8, dirty: false },
      ],
      environment: { 'Workspace trust': 'trusted' },
    },
    agentFiles: discoverAgentFiles({ root: tmp, config: DEFAULT_CONFIG.agentFiles }),
  });

  assert.match(prompt, /Platform: /);
  assert.match(prompt, /Node\.js: /);
  assert.match(prompt, /Editor: Visual Studio Code 1\.95\.0/);
  assert.match(prompt, /Workspace trust: trusted/);
  assert.match(prompt, /Active file: src\/a\.ts \(typescript, 20 lines, unsaved changes\)/);
  assert.match(prompt, /Selection in the active file: lines 3-5/);
  assert.match(prompt, /Other open editors/);
  assert.match(prompt, /src\/a\.ts:4 ERROR expected/);
  assert.match(prompt, /`read_file` — Read a file\./);
});

test('agent instruction files are appended verbatim and scoped by directory', () => {
  const root = fs.mkdtempSync(path.join(tmp, 'with-agent-'));
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'Use pnpm for everything.\n');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'agent.md'), 'Only touch the src folder with tests first.\n');

  const agentFiles = discoverAgentFiles({ root, config: { ...DEFAULT_CONFIG.agentFiles, scanNested: true } });
  const prompt = buildSystemPrompt({ root, config: config(), tools: [], agentFiles });

  assert.match(prompt, /AGENTS\.md — workspace root/);
  assert.match(prompt, /Use pnpm for everything\./);
  assert.match(prompt, /src\/agent\.md — applies to src\/\*\*/);
  assert.match(prompt, /Only touch the src folder with tests first\./);

  // Instructions close the message so they are the most recent context.
  assert.ok(prompt.lastIndexOf('Use pnpm') > prompt.lastIndexOf('# Tools'), 'instructions come after the tool list');
});

test('context sections can be switched off independently', () => {
  const prompt = buildSystemPrompt({
    root: tmp,
    config: config({
      context: { environment: false, workspace: false, files: false, diagnostics: false, tools: false },
    }),
    tools: [],
    agentFiles: discoverAgentFiles({ root: tmp, config: DEFAULT_CONFIG.agentFiles }),
  });

  assert.doesNotMatch(prompt, /# Environment/);
  assert.doesNotMatch(prompt, /# Workspace/);
  assert.doesNotMatch(prompt, /# Files/);
  assert.doesNotMatch(prompt, /# Tools/);
  assert.match(prompt, /# Agent instructions/);
});

test('diagnostics stay available when open-editor facts are switched off', () => {
  const prompt = buildSystemPrompt({
    root: tmp,
    config: config({ context: { ...DEFAULT_CONFIG.context, files: false, diagnostics: true } }),
    tools: [],
    diagnostics: ['src/b.ts:9 WARNING unused variable'],
    workspace: { openFiles: [{ path: 'src/b.ts', languageId: 'typescript', lineCount: 12 }] },
    agentFiles: discoverAgentFiles({ root: tmp, config: DEFAULT_CONFIG.agentFiles }),
  });

  assert.match(prompt, /# Files/);
  assert.match(prompt, /src\/b\.ts:9 WARNING unused variable/);
  assert.doesNotMatch(prompt, /Open editors|Active file/);
});

test('the offline planner openly declines open-ended asks instead of summarising them', async () => {
  const provider = new MockPlannerProvider();
  const tools = [{ name: 'list_files', description: 'list files', parameters: {} }];

  const first = await provider.chat({
    model: 'mock',
    messages: [{ role: 'user', content: 'improve the UI' }],
    tools,
  });
  assert.equal(first.toolCalls.length, 1, 'looking at the layout is still legitimate');

  const history: ChatMessage[] = [
    { role: 'user', content: 'improve the UI' },
    { role: 'assistant', content: first.text, toolCalls: first.toolCalls },
    { role: 'tool', toolCallId: first.toolCalls[0].id, name: 'list_files', content: 'index.html\nmedia/\napp.js' },
  ];
  const reply = await provider.chat({ model: 'mock', messages: history, tools });

  assert.equal(reply.toolCalls.length, 0);
  assert.match(reply.text, /nothing was changed/i);
  assert.match(reply.text, /real model/, 'it must point at the real fix — a configured model');
  assert.doesNotMatch(reply.text, /Offline planner summary/, 'no fake "work summary" for a task that never ran');
});

test('the offline planner still summarises tasks it actually performed', async () => {
  const provider = new MockPlannerProvider();
  const tools = [{ name: 'any', description: 'x', parameters: {} }];

  const first = await provider.chat({
    model: 'mock',
    messages: [{ role: 'user', content: 'create a python script called ok.py that prints ok' }],
    tools,
  });
  assert.equal(first.toolCalls[0]?.name, 'list_files');

  const second = await provider.chat({
    model: 'mock',
    messages: [
      { role: 'user', content: 'create a python script called ok.py that prints ok' },
      { role: 'assistant', content: first.text, toolCalls: first.toolCalls },
      { role: 'tool', toolCallId: first.toolCalls[0].id, name: 'list_files', content: 'README.md' },
    ],
    tools,
  });
  assert.equal(second.toolCalls[0]?.name, 'write_file');

  const third = await provider.chat({
    model: 'mock',
    messages: [
      { role: 'user', content: 'create a python script called ok.py that prints ok' },
      { role: 'assistant', content: first.text, toolCalls: first.toolCalls },
      { role: 'tool', toolCallId: first.toolCalls[0].id, name: 'list_files', content: 'README.md' },
      { role: 'assistant', content: second.text, toolCalls: second.toolCalls },
      { role: 'tool', toolCallId: second.toolCalls[0].id, name: 'write_file', content: 'created ok.py' },
    ],
    tools,
  });
  assert.equal(third.toolCalls[0]?.name, 'run_command');

  const reply = await provider.chat({
    model: 'mock',
    messages: [
      { role: 'user', content: 'create a python script called ok.py that prints ok' },
      { role: 'assistant', content: first.text, toolCalls: first.toolCalls },
      { role: 'tool', toolCallId: first.toolCalls[0].id, name: 'list_files', content: 'README.md' },
      { role: 'assistant', content: second.text, toolCalls: second.toolCalls },
      { role: 'tool', toolCallId: second.toolCalls[0].id, name: 'write_file', content: 'created ok.py' },
      { role: 'assistant', content: third.text, toolCalls: third.toolCalls },
      { role: 'tool', toolCallId: third.toolCalls[0].id, name: 'run_command', content: '(exit 0)' },
    ],
    tools,
  });
  assert.equal(reply.toolCalls.length, 0);
  assert.match(reply.text, /Offline planner summary/, 'real work still earns a summary');
});
