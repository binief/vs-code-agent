import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { compactHistory } from '../core/compaction';
import { reduceArchivedToolOutputs } from '../core/toolOutputReduction';
import { isTranscriptWellFormed } from '../core/transcript';
import { DEFAULT_CONFIG, type ChatMessage, type Provider } from '../core/types';

const body = 'header ✅\n' + 'middle secret മലയാളം 😀\n'.repeat(400) + 'ERROR: exit code 1\n';
const group = (id: string, content = body): ChatMessage[] => [
  { role: 'assistant', content: '', toolCalls: [{ id, name: 'inspect', arguments: '{"path":"one"}' }] },
  { role: 'tool', name: 'inspect', toolCallId: id, content },
];
const original = (): ChatMessage[] => [
  { role: 'user', content: 'Old task' }, ...group('same', 'different original '.repeat(300)),
  ...group('same'), { role: 'assistant', content: 'Earlier answer' },
  { role: 'user', content: 'Current exact request', images: [{ mediaType: 'image/png', data: 'YWJj', name: 'image.png' }] },
  ...group('recent'), { role: 'assistant', content: 'Latest answer' },
];
const clone = (a: ChatMessage[]): ChatMessage[] => JSON.parse(JSON.stringify(a));

test('shortens only exactly recorded older results, preserves group, request, images and reused ID provenance', () => {
  const history = original(), archive = clone(history), snapshot = clone(archive);
  const result = reduceArchivedToolOutputs(history, archive, 2, history[6]);
  assert.equal(result.count, 2);
  assert.match(result.history[2].content, /message_index=3/);
  assert.match(result.history[4].content, /message_index=5/);
  assert.match(result.history[4].content, /ERROR: exit code 1/);
  assert.match(result.history[4].content, /Middle omitted/);
  assert.ok(!result.history[4].content.includes('�'));
  assert.strictEqual(result.history[6], history[6]);
  assert.strictEqual(result.history[8], history[8]);
  assert.ok(isTranscriptWellFormed(result.history));
  assert.deepEqual(archive, snapshot);
  assert.equal(history[4].content, body);
});

test('skips ambiguous duplicate IDs, mismatched archive, malformed transcripts and protected recent groups', () => {
  const history = original();
  const duplicate = [...clone(history), ...group('same')];
  const result = reduceArchivedToolOutputs(history, duplicate, 2, history[6]);
  assert.equal(result.count, 1);
  assert.strictEqual(result.history[4], history[4], 'identical reused ID is ambiguous');
  const mismatched = clone(history);
  mismatched[4].content += ' altered';
  assert.strictEqual(reduceArchivedToolOutputs(history, mismatched, 2, history[6]).history[4], history[4]);
  const mismatchedCall = clone(history);
  mismatchedCall[3].toolCalls![0].arguments = '{"path":"different"}';
  assert.strictEqual(reduceArchivedToolOutputs(history, mismatchedCall, 2, history[6]).history[4], history[4]);
  const bad = history.filter((_, i) => i !== 3);
  assert.strictEqual(reduceArchivedToolOutputs(bad, history, 2).history, bad);
  const allRecent = reduceArchivedToolOutputs(history, history, 100, history[6]);
  assert.equal(allRecent.count, 0);
});

test('disabled fallback discards tentative pruning when the summary fails', async () => {
  const history = original();
  let calls = 0;
  const provider: Provider = { id: 'fake', label: 'fake', async chat() { calls++; throw new Error('offline'); } };
  const config = { ...DEFAULT_CONFIG, compaction: { ...DEFAULT_CONFIG.compaction, keepLastMessages: 2, verbatimFallback: false } };
  const reduced = await compactHistory(history, config, provider, undefined, { archiveMessages: clone(history), preserveUserMessage: history[6], targetHistoryTokens: 1 });
  assert.ok(calls > 0);
  assert.equal(reduced.result.compacted, false);
  assert.match(reduced.result.summary, /offline/);
  assert.strictEqual(reduced.newHistory, history);
  assert.ok(isTranscriptWellFormed(reduced.newHistory));
});

test('LLM emergency compaction retains the exact current request and its image', async () => {
  const history = original();
  const provider: Provider = { id: 'fake', label: 'fake', async chat() { return { text: 'Short summary.', toolCalls: [] }; } };
  const config = { ...DEFAULT_CONFIG, compaction: { ...DEFAULT_CONFIG.compaction, keepLastMessages: 2 } };
  const result = await compactHistory(history, config, provider, undefined, { targetHistoryTokens: 1, preserveUserMessage: history[6] });
  assert.equal(result.result.strategy, 'llm');
  assert.equal(result.result.targetMet, false);
  assert.ok(result.newHistory.includes(history[6]));
  assert.deepEqual(result.newHistory.filter((m) => m.images?.length).flatMap((m) => m.images), history[6].images);
  assert.ok(isTranscriptWellFormed(result.newHistory));
});

test('a recent result protects its entire non-contiguous call group', () => {
  const history: ChatMessage[] = [
    { role: 'user', content: 'old' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'inspect', arguments: '{}' }, { id: 'b', name: 'inspect', arguments: '{}' }] },
    { role: 'tool', name: 'inspect', toolCallId: 'a', content: body },
    { role: 'assistant', content: 'intervening text' },
    { role: 'tool', name: 'inspect', toolCallId: 'b', content: body },
    { role: 'user', content: 'current' },
  ];
  assert.ok(isTranscriptWellFormed(history));
  assert.equal(reduceArchivedToolOutputs(history, clone(history), 3, history[5]).count, 0);
});

test('cancellation during summarization cannot commit tentative tool-output reduction', async () => {
  const history = original();
  const before = clone(history);
  const controller = new AbortController();
  const provider: Provider = { id: 'fake', label: 'fake', async chat() { controller.abort(); throw new Error('cancelled'); } };
  const config = { ...DEFAULT_CONFIG, compaction: { ...DEFAULT_CONFIG.compaction, keepLastMessages: 2 } };
  await assert.rejects(compactHistory(history, config, provider, controller.signal, {
    archiveMessages: clone(history), preserveUserMessage: history[6], targetHistoryTokens: 1, allowVerbatimFallback: true,
  }), /Compaction cancelled/);
  assert.deepEqual(history, before);
});
