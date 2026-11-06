import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { HarnessSession } from '../core/agent';
import { compactHistory, estimateMessagesTokens, estimateRequestTokens, estimateTokens, shouldCompact } from '../core/compaction';
import { ToolRegistry } from '../core/tools';
import { isTranscriptWellFormed } from '../core/transcript';
import { DEFAULT_CONFIG, type ChatMessage, type ChatRequest, type HarnessConfig, type HarnessEvent, type HarnessHost, type Provider, type Tool } from '../core/types';

function config(overrides: Partial<HarnessConfig> = {}): HarnessConfig {
  return { ...DEFAULT_CONFIG, stream: false, maxOutputTokens: 128, ...overrides };
}

class Host implements HarnessHost {
  constructor(readonly workspaceRoot: string) {}
  log(): void {}
  async requestApproval(): Promise<'apply'> { return 'apply'; }
}

const longHistory = (): ChatMessage[] => [
  { role: 'user', content: 'Original task and constraints. '.repeat(80) },
  { role: 'assistant', content: 'Investigated evidence. '.repeat(50) },
  { role: 'user', content: 'Additional user instruction. '.repeat(40) },
  { role: 'assistant', content: 'Previous response. '.repeat(40) },
  { role: 'user', content: 'Recent request.' },
  { role: 'assistant', content: 'Recent answer.' },
];
const isSummary = (req: ChatRequest): boolean => req.messages[0]?.content.startsWith('Summarize the following conversation') ?? false;

test('token estimates account for tool schemas, framing, UTF-8 and reserved output', () => {
  const messages: ChatMessage[] = [{ role: 'user', content: 'hello' }];
  const tools = [{ name: 'huge', description: 'large schema '.repeat(100), parameters: { type: 'object' } }];
  assert.ok(estimateTokens('മലയാളം') > estimateTokens('abc'));
  assert.ok(estimateRequestTokens(messages, tools) > estimateRequestTokens(messages, []));
  const c = config({ compaction: { ...DEFAULT_CONFIG.compaction, contextWindowTokens: 2000 } });
  const usage = shouldCompact(messages, 'system', c, tools);
  assert.equal(usage.tokens, estimateRequestTokens([{ role: 'system', content: 'system' }, ...messages], tools) + c.maxOutputTokens);
  assert.ok(usage.tokens > estimateMessagesTokens(messages) + c.maxOutputTokens);
});

test('LLM compaction preserves tool groups, image attachments and configured model', async () => {
  const history = longHistory();
  const image = { mediaType: 'image/png', data: 'YWJj', name: 'screen.png' };
  history[0].images = [image];
  const seen: ChatRequest[] = [];
  const provider: Provider = { id: 'test', label: 'test', async chat(req) {
    seen.push(req);
    return { text: 'User requested a change; earlier evidence was inspected.', toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 } };
  } };
  const c = config({ compaction: { ...DEFAULT_CONFIG.compaction, keepLastMessages: 2, summaryModel: 'small-model' } });
  const result = await compactHistory(history, c, provider);
  assert.equal(result.result.compacted, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].model, 'small-model');
  assert.deepEqual(seen[0].tools, []);
  assert.ok(seen[0].messages[0].content.includes('Original task and constraints'));
  assert.deepEqual(seen[0].messages[0].images, [image]);
  assert.deepEqual(result.newHistory[0].images, [image]);
  assert.match(result.newHistory[0].content, /User requested a change/);
  assert.deepEqual(result.newHistory.slice(-2), history.slice(-2));
  assert.ok(isTranscriptWellFormed(result.newHistory));
  assert.ok(result.result.newTokens < result.result.originalTokens);
});

test('failed, truncated, empty or oversized summaries never replace the original conversation', async () => {
  const history = longHistory();
  const c = config({ compaction: { ...DEFAULT_CONFIG.compaction, keepLastMessages: 2 } });
  const providers: Provider[] = [
    { id: 'test', label: 'test', async chat() { throw new Error('offline'); } },
    { id: 'test', label: 'test', async chat() { return { text: 'truncated', toolCalls: [], finishReason: 'length' }; } },
    { id: 'test', label: 'test', async chat() { return { text: '', toolCalls: [] }; } },
    { id: 'test', label: 'test', async chat() { return { text: 'a'.repeat(100_000), toolCalls: [] }; } },
    { id: 'test', label: 'test', async chat() { return { text: 'text', toolCalls: [{ id: 'bad', name: 'bad', arguments: '{}' }] }; } },
  ];
  for (const provider of providers) {
    const result = await compactHistory(history, c, provider);
    assert.equal(result.result.compacted, false);
    assert.strictEqual(result.newHistory, history);
  }
});

test('automatic LLM compaction can summarize the current task and keep a valid tool transcript', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-compact-'));
  try {
    const seen: ChatRequest[] = [];
    const tool: Tool = { name: 'inspect', description: 'Read facts', parameters: { type: 'object' }, async run() {
      return { ok: true, content: 'Verified file content. '.repeat(250) };
    } };
    let turn = 0;
    const provider: Provider = { id: 'test', label: 'test', async chat(req) {
      seen.push(req);
      if (isSummary(req)) return { text: 'Goal: inspect facts. File content was verified.', toolCalls: [], usage: { inputTokens: 200, outputTokens: 20 } };
      turn++;
      if (turn <= 2) return { text: `Inspecting ${turn}.`, toolCalls: [{ id: `t${turn}`, name: 'inspect', arguments: '{}' }] };
      return { text: 'Finished.', toolCalls: [] };
    } };
    const c = config({ maxSteps: 5, compaction: { ...DEFAULT_CONFIG.compaction, keepLastMessages: 2, contextWindowTokens: 2000, threshold: 0.5 } });
    const session = new HarnessSession({ host: new Host(dir), provider, tools: new ToolRegistry([tool]), config: c });
    const events: HarnessEvent[] = [];
    const result = await session.runTask('Inspect the current task.', (e) => events.push(e));
    assert.equal(result.outcome, 'complete');
    const summary = seen.find(isSummary);
    assert.ok(summary, 'current-task messages must be sent to the summarizer');
    assert.match(summary.messages[0].content, /Inspect the current task/);
    const finalRequest = seen.filter((req) => !isSummary(req))[2];
    assert.ok(finalRequest.messages.some((m) => /Conversation compacted/.test(m.content)));
    assert.ok(isTranscriptWellFormed(finalRequest.messages));
    assert.ok(session.transcript.some((m) => /Conversation compacted/.test(m.content)));
    assert.ok(events.some((e) => e.type === 'notice' && e.message.includes('LLM compacted')));
    assert.ok((session.usage.inputTokens ?? 0) >= 200, 'summary usage is counted');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('provider context rejection triggers one LLM compaction and a retry even below the estimate threshold', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-overflow-'));
  try {
    let attempts = 0;
    let summaries = 0;
    const provider: Provider = { id: 'test', label: 'test', async chat(req) {
      if (isSummary(req)) { summaries++; return { text: 'Summary of earlier requirements.', toolCalls: [] }; }
      attempts++;
      if (attempts === 1) throw new Error('maximum context length exceeded');
      assert.ok(req.messages.some((m) => /Conversation compacted/.test(m.content)));
      assert.ok(isTranscriptWellFormed(req.messages));
      return { text: 'Recovered.', toolCalls: [] };
    } };
    const c = config({ compaction: { ...DEFAULT_CONFIG.compaction, autoCompact: false, keepLastMessages: 2 } });
    const session = new HarnessSession({ host: new Host(dir), provider, config: c });
    session.restoreConversation(longHistory());
    const events: HarnessEvent[] = [];
    const result = await session.runTask('Continue.', (e) => events.push(e));
    assert.equal(result.outcome, 'complete');
    assert.equal(attempts, 2);
    assert.equal(summaries, 1);
    assert.ok(events.some((e) => e.type === 'notice' && e.message.includes('context as too large')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('provider-reported input usage updates context and calibrates later requests', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-usage-'));
  try {
    let turn = 0;
    const provider: Provider = { id: 'test', label: 'test', async chat() {
      turn++;
      return { text: 'Done.', toolCalls: [], usage: { inputTokens: turn === 1 ? 9000 : 9000, outputTokens: 5 } };
    } };
    const c = config({ compaction: { ...DEFAULT_CONFIG.compaction, autoCompact: false, contextWindowTokens: 10000 } });
    const session = new HarnessSession({ host: new Host(dir), provider, config: c });
    const first: HarnessEvent[] = [];
    const firstResult = await session.runTask('Small prompt.', (e) => first.push(e));
    assert.equal(firstResult.contextTokens, session.getContextUsage().tokens);
    assert.ok(first.some((e) => e.type === 'context' && e.contextTokens === 9128 && e.contextPercent === 91.28));
    const second: HarnessEvent[] = [];
    await session.runTask('Next.', (e) => second.push(e));
    const firstEstimate = second.find((e): e is Extract<HarnessEvent, { type: 'context' }> => e.type === 'context');
    assert.ok(firstEstimate && firstEstimate.contextTokens >= 9000, 'later estimates should use the observed input calibration');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('old conversation messages are not silently trimmed at fixed message limits', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-history-'));
  try {
    const provider: Provider = { id: 'test', label: 'test', async chat() { return { text: 'Done.', toolCalls: [] }; } };
    const c = config({ compaction: { ...DEFAULT_CONFIG.compaction, enabled: false } });
    const session = new HarnessSession({ host: new Host(dir), provider, config: c });
    const messages: ChatMessage[] = Array.from({ length: 70 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `old-${i}` }));
    session.restoreConversation(messages);
    await session.runTask('New request', () => {});
    assert.equal(session.transcript[0].content, 'old-0');
    assert.equal(session.transcript.length, 72);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('failed compaction after a context rejection retains original conversation and reports the failure', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-failed-summary-'));
  try {
    const provider: Provider = { id: 'test', label: 'test', async chat(req) {
      if (isSummary(req)) throw new Error('summarizer unavailable');
      throw new Error('context exceeded');
    } };
    const c = config({ compaction: { ...DEFAULT_CONFIG.compaction, autoCompact: false, keepLastMessages: 2 } });
    const session = new HarnessSession({ host: new Host(dir), provider, config: c });
    const original = longHistory();
    session.restoreConversation(original);
    const events: HarnessEvent[] = [];
    const result = await session.runTask('Continue.', (e) => events.push(e));
    assert.equal(result.outcome, 'error');
    assert.deepEqual(session.transcript.slice(0, original.length), original);
    assert.ok(events.some((e) => e.type === 'notice' && e.message.includes('summarizer unavailable') && e.message.includes('retained')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('cancelling an in-flight summary preserves the original history and cancels the task', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-cancel-summary-'));
  try {
    let session: HarnessSession;
    const provider: Provider = { id: 'test', label: 'test', async chat(req) {
      if (isSummary(req)) {
        session.cancel();
        assert.equal(req.signal?.aborted, true);
        throw new Error('aborted');
      }
      throw new Error('context exceeded');
    } };
    const c = config({ compaction: { ...DEFAULT_CONFIG.compaction, autoCompact: false, keepLastMessages: 2 } });
    session = new HarnessSession({ host: new Host(dir), provider, config: c });
    const original = longHistory();
    session.restoreConversation(original);
    const result = await session.runTask('Continue.', () => {});
    assert.equal(result.outcome, 'cancelled');
    assert.deepEqual(session.transcript.slice(0, original.length), original);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('usage totals include both reported totals and calls without an explicit total', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-total-'));
  try {
    let turn = 0;
    const provider: Provider = { id: 'test', label: 'test', async chat() {
      turn++;
      return { text: 'Done.', toolCalls: [], usage: turn === 1 ? { inputTokens: 10, outputTokens: 5, totalTokens: 15 } : { inputTokens: 20, outputTokens: 6 } };
    } };
    const session = new HarnessSession({ host: new Host(dir), provider, config: config({ compaction: { ...DEFAULT_CONFIG.compaction, enabled: false } }) });
    await session.runTask('First.', () => {});
    await session.runTask('Second.', () => {});
    assert.equal(session.usage.inputTokens, 30);
    assert.equal(session.usage.outputTokens, 11);
    assert.equal(session.usage.totalTokens, 41);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('manual LLM compaction is cancellable and leaves history unchanged', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-manual-cancel-'));
  try {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const provider: Provider = { id: 'test', label: 'test', async chat(req) {
      entered();
      return await new Promise((_, reject) => req.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
    } };
    const session = new HarnessSession({ host: new Host(dir), provider, config: config({ compaction: { ...DEFAULT_CONFIG.compaction, keepLastMessages: 2 } }) });
    const original = longHistory();
    session.restoreConversation(original);
    const pending = session.compact();
    await started;
    assert.equal(session.isRunning, true);
    session.cancel();
    await assert.rejects(pending, /cancelled/);
    assert.deepEqual(session.transcript, original);
    assert.equal(session.isRunning, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
