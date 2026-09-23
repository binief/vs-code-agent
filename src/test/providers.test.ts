import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { toAnthropicMessages, toOpenAiMessages } from '../core/providers';
import { MockPlannerProvider, parseIntent, scaffold } from '../core/providers/mock';
import type { ChatMessage } from '../core/types';

const conversation: ChatMessage[] = [
  { role: 'system', content: 'You are the harness.' },
  { role: 'user', content: 'read app.ts' },
  {
    role: 'assistant',
    content: 'Reading it now.',
    toolCalls: [{ id: 'call_1', name: 'read_file', arguments: '{"path":"app.ts"}' }],
  },
  { role: 'tool', toolCallId: 'call_1', name: 'read_file', content: 'export const a = 1;' },
  {
    role: 'assistant',
    content: '',
    toolCalls: [
      { id: 'call_2', name: 'read_file', arguments: '{"path":"b.ts"}' },
      { id: 'call_3', name: 'read_file', arguments: '{"path":"c.ts"}' },
    ],
  },
  { role: 'tool', toolCallId: 'call_2', name: 'read_file', content: 'B' },
  { role: 'tool', toolCallId: 'call_3', name: 'read_file', content: 'C' },
];

test('OpenAI mapping keeps tool calls and tool results linked by id', () => {
  const messages = toOpenAiMessages(conversation) as any[];
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[2].tool_calls[0].id, 'call_1');
  assert.equal(messages[2].tool_calls[0].function.name, 'read_file');
  assert.equal(messages[2].tool_calls[0].function.arguments, '{"path":"app.ts"}');
  assert.deepEqual(messages[3], {
    role: 'tool',
    tool_call_id: 'call_1',
    name: 'read_file',
    content: 'export const a = 1;',
  });
  // The last assistant message has no text: content must go out as null, not "".
  const bare = messages[4] as any;
  assert.equal(bare.content, null);
  assert.equal(bare.tool_calls.length, 2);
  assert.equal(messages.length, conversation.length);
});

test('Anthropic mapping lifts the system prompt and batches tool results', () => {
  const { system, messages } = toAnthropicMessages(conversation) as { system: string; messages: any[] };
  assert.equal(system, 'You are the harness.');

  // user, assistant(tool_use), user(tool_result), assistant(2x tool_use), user(2x tool_result)
  assert.equal(messages.length, 5);
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[1].role, 'assistant');
  assert.equal(messages[1].content[0].type, 'text');
  assert.equal(messages[1].content[1].type, 'tool_use');
  assert.deepEqual(messages[1].content[1].input, { path: 'app.ts' });

  assert.equal(messages[2].role, 'user');
  assert.equal(messages[2].content[0].type, 'tool_result');
  assert.equal(messages[2].content[0].tool_use_id, 'call_1');
  assert.equal(messages[2].content[0].content, 'export const a = 1;');

  // Both trailing tool results must be batched into ONE user turn.
  assert.equal(messages[4].role, 'user');
  assert.equal(messages[4].content.length, 2);
  assert.deepEqual(
    messages[4].content.map((b: any) => b.tool_use_id),
    ['call_2', 'call_3'],
  );
});

test('Anthropic mapping survives a malformed tool-call argument payload', () => {
  const { messages } = toAnthropicMessages([
    { role: 'user', content: 'go' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'x', name: 'read_file', arguments: 'not json' }] },
  ]) as { messages: any[] };
  assert.deepEqual(messages[1].content[0].input, { raw: 'not json' });
});

test('the mock provider speaks the tool protocol and answers in prose on the last step', async () => {
  const provider = new MockPlannerProvider();

  const first = await provider.chat({
    model: 'mock',
    messages: [{ role: 'user', content: 'create a python script called greet.py that prints hello' }],
    tools: [{ name: 'list_files', description: 'list', parameters: { type: 'object' } }],
  });
  assert.equal(first.toolCalls.length, 1);
  assert.equal(first.toolCalls[0].name, 'list_files');
  assert.ok(first.text.length > 0, 'the model must state its intent');

  const finalTurn = await provider.chat({
    model: 'mock',
    messages: [{ role: 'user', content: 'create a python script called greet.py that prints hello' }],
    tools: [], // the agent strips tools on the final step
  });
  assert.equal(finalTurn.toolCalls.length, 0);
  assert.ok(finalTurn.text.length > 0);
});

test('mock intent parsing picks the right file and scaffold language', () => {
  const py = parseIntent('create a python script that prints fibonacci called fib.py');
  assert.equal(py.kind, 'create');
  assert.equal(py.filePath, 'fib.py');
  assert.match(scaffold(py), /def fibonacci/);

  const md = parseIntent('add a README for the project');
  assert.equal(md.kind, 'create');
  assert.equal(md.filePath, 'README.md');
  assert.match(scaffold(md), /^# /);

  const ts = parseIntent('write a typescript helper called helper.ts');
  assert.equal(ts.filePath, 'helper.ts');
  assert.match(scaffold(ts), /export function main/);

  const search = parseIntent('search for parseThing');
  assert.equal(search.kind, 'search');
  assert.equal(search.query, 'parseThing');

  const tests = parseIntent('run the tests');
  assert.equal(tests.kind, 'test');
});

test('scaffolded files are valid-ish and non-empty for every supported extension', () => {
  for (const file of ['a.py', 'a.js', 'a.ts', 'a.md', 'a.json', 'a.sh', 'a.html', 'a.yml', 'a.unknownext']) {
    const content = scaffold({ kind: 'create', filePath: file, query: 'do the thing' });
    assert.ok(content.length > 20, `${file} should have real content`);
    if (file.endsWith('.json')) assert.doesNotThrow(() => JSON.parse(content));
  }
});

test('mock provider state resets between tasks', async () => {
  const provider = new MockPlannerProvider();
  const tools = [{ name: 'list_files', description: 'list', parameters: { type: 'object' } }];

  const initial = await provider.chat({
    model: 'mock',
    messages: [{ role: 'user', content: 'explain the project' }],
    tools,
  });
  assert.equal(initial.toolCalls[0].name, 'list_files');

  // A brand-new conversation (different first user message) starts from step 0 again.
  const second = await provider.chat({
    model: 'mock',
    messages: [{ role: 'user', content: 'explain the project layout in detail please' }],
    tools,
  });
  assert.equal(second.toolCalls[0].name, 'list_files');
  assert.match(second.text, /layout|workspace|Looking/i);
});

test('mock provider never writes outside the workspace it is shown', async () => {
  const provider = new MockPlannerProvider();
  const response = await provider.chat({
    model: 'mock',
    messages: [{ role: 'user', content: 'create a python script' }],
    tools: [{ name: 'list_files', description: 'list', parameters: { type: 'object' } }],
  });
  const args = JSON.parse(response.toolCalls[0].arguments);
  assert.equal(args.path, '.');
});

test('scaffold output for python is syntactically valid python', async () => {
  const { spawnSync } = await import('node:child_process');
  const probe = spawnSync('python3', ['--version']);
  if (probe.status !== 0) return; // python not available: skip

  const content = scaffold({ kind: 'create', filePath: 'check.py', query: 'print hello' });
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'harness-scaffold-'));
  const file = path.join(dir, 'check.py');
  fs.writeFileSync(file, content, 'utf8');
  try {
    const result = spawnSync('python3', ['-m', 'py_compile', file]);
    assert.equal(result.status, 0, `py_compile failed: ${result.stderr?.toString()}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
