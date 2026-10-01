import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, test } from 'node:test';

import { buildSystemPrompt } from '../core/prompt';
import { MockPlannerProvider } from '../core/providers/mock';
import { DEFAULT_CONFIG, type ChatMessage } from '../core/types';

/**
 * Regression tests for a real complaint: "improve UI" produced an analysis and
 * a summary of suggestions instead of edited files. The fix is two-sided —
 * the system prompt must define changed-files-plus-verification as the only
 * acceptable end state for task requests, and the offline planner must say
 * "nothing was changed" instead of printing a summary that looks like work.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-prompt-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('the system prompt drives gather → decide → act for task requests', () => {
  const prompt = buildSystemPrompt({ root: tmp, config: DEFAULT_CONFIG, tools: [], diagnostics: [] });

  assert.match(prompt, /three moves: gather, decide, act/, 'the work loop is explicit');
  assert.match(prompt, /GATHER before deciding/, 'step one grounds decisions in real files');
  assert.match(prompt, /request to EDIT the workspace/, 'tasks are edit requests, not advice requests');
  assert.match(prompt, /improve the UI/, 'the canonical vague ask is addressed by name');
  assert.match(prompt, /changed files plus proof/, 'the end state is edits + verification');
  assert.match(prompt, /ONLY when the user\s+explicitly asked/, 'plans are opt-in, not a fallback');
  assert.match(prompt, /never the substitute for doing it/, 'the closing rule names the failure mode');
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

  // The mock verifies its own writes with a syntax check before wrapping up.
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
