import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBenchmark } from '../benchmark/local';
import type { Provider } from '../core/types';

test('local benchmark scores exact fixture outcomes, without exposing shell or MCP tools', async () => {
  const provider: Provider = { id: 'test', label: 'scripted', async chat(req) {
    assert.ok(!req.tools.some((tool) => tool.name === 'run_command' || tool.name.startsWith('mcp_')));
    const prompt = req.messages.find((m) => m.role === 'user')!.content;
    const completed = req.messages.some((m) => m.role === 'tool');
    if (completed) return { text: prompt.includes('marker') ? 'delta-473' : 'done', toolCalls: [] };
    if (prompt.includes('marker')) return { text: '', toolCalls: [{ id: 'r', name: 'read_file', arguments: '{"path":"notes/service.txt"}' }] };
    const oldText = prompt.includes('production') ? '[production]\ncolor=blue' : 'color=blue';
    const newText = prompt.includes('production') ? '[production]\ncolor=green' : 'color=green';
    return { text: '', toolCalls: [{ id: 'e', name: 'replace_in_file', arguments: JSON.stringify({ path: 'settings.txt', old_text: oldText, new_text: newText }) }] };
  } };
  const results = await runBenchmark(provider, 'fake', 2, 20000);
  assert.equal(results.length, 6);
  assert.ok(results.every((r) => r.passed), JSON.stringify(results));
  assert.ok(results.every((r) => r.steps === 2 && r.toolCalls === 1));
});

test('benchmark checks actual outcomes, not just the model claiming success', async () => {
  const provider: Provider = { id: 'test', label: 'bad', async chat() { return { text: 'Everything is done.', toolCalls: [] }; } };
  const results = await runBenchmark(provider, 'fake', 1, 20000);
  assert.ok(results.every((r) => !r.passed));
});
