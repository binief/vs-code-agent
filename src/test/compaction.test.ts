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
    fs.writeFileSync(path.join(dir, 'agent.md'), '---\ntools: [inspect]\n---\n');
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
    const c = config({ compaction: { ...DEFAULT_CONFIG.compaction, keepLastMessages: 2, contextWindowTokens: 2000, threshold: 0.5 } });
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
    const original = session.originalConversationSnapshot;
    assert.equal(original[0].content, 'Inspect the current task.');
    assert.deepEqual(original.filter((m) => m.role === 'assistant' && m.toolCalls?.length).map((m) => m.content), ['Inspecting 1.', 'Inspecting 2.']);
    assert.equal(original.filter((m) => m.role === 'tool').length, 2);
    assert.equal(original.at(-1)?.content, 'Finished.');
    assert.ok(!original.some((m) => /Conversation compacted/.test(m.content)), 'summaries never replace originals');
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
    const reported = first.find((e) => e.type === 'context' && e.breakdown?.source === 'provider');
    assert.ok(reported && reported.type === 'context' && reported.breakdown);
    const b = reported.breakdown;
    assert.equal(b.system + b.conversation + b.images + b.tools + b.framing + b.adjustment + b.outputReserve, 9128);
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

test('an oversized summary retries with a shorter target and aggregates both usages', async () => {
  const requests: ChatRequest[] = [];
  const provider: Provider = { id: 'test', label: 'test', async chat(req) {
    requests.push(req);
    return requests.length === 1
      ? { text: 'Too long. '.repeat(1500), toolCalls: [], usage: { inputTokens: 100, outputTokens: 50, cachedTokens: 20 } }
      : { text: 'Concise verified summary.', toolCalls: [], usage: { inputTokens: 80, outputTokens: 10, totalTokens: 90, cachedTokens: 10 } };
  } };
  const history = longHistory();
  const result = await compactHistory(history, config({ compaction: { ...DEFAULT_CONFIG.compaction, keepLastMessages: 2 } }), provider);
  assert.equal(result.result.compacted, true);
  assert.equal(requests.length, 2);
  const target = (request: ChatRequest) => Number(request.messages[0].content.match(/under approximately (\d+) tokens/)?.[1]);
  assert.ok(target(requests[1]) < target(requests[0]));
  assert.deepEqual(result.result.usage, { inputTokens: 180, outputTokens: 60, totalTokens: 240, cachedTokens: 30 });
  assert.equal(result.newHistory[0].content.includes('Concise verified summary.'), true);
  assert.deepEqual(result.newHistory.slice(-2), history.slice(-2));
});

test('oversized or incomplete summaries retain original messages and report all costs', async () => {
  for (const finishReason of [undefined, 'length']) {
    let calls = 0;
    const provider: Provider = { id: 'test', label: 'test', async chat() {
      calls++;
      return { text: 'Long. '.repeat(3000), toolCalls: [], finishReason, usage: { inputTokens: 10, outputTokens: 20 } };
    } };
    const history = longHistory();
    const { newHistory, result } = await compactHistory(history, config({ compaction: { ...DEFAULT_CONFIG.compaction, keepLastMessages: 2 } }), provider);
    assert.strictEqual(newHistory, history);
    assert.equal(result.compacted, false);
    assert.equal(calls, finishReason ? 3 : 2);
    assert.equal(result.usage?.totalTokens, finishReason ? 90 : 60);
    assert.match(result.summary, finishReason ? /output limit on three attempts/ : /did not reduce/);
    assert.doesNotMatch(result.summary, /Original context retained/);
  }
});

test('summary budget depends on the compactable prefix, not a large retained tail', async () => {
  const requests: ChatRequest[] = [];
  const provider: Provider = { id: 'test', label: 'test', async chat(req) { requests.push(req); return { text: 'Short summary.', toolCalls: [] }; } };
  const history = longHistory();
  const c = config({ compaction: { ...DEFAULT_CONFIG.compaction, keepLastMessages: 2 } });
  await compactHistory(history, c, provider);
  const enlarged = history.map((message, i) => i >= history.length - 2 ? { ...message, content: message.content.repeat(20000) } : message);
  await compactHistory(enlarged, c, provider);
  assert.equal(requests[0].maxTokens, requests[1].maxTokens);
  assert.equal(requests[0].messages[0].content, requests[1].messages[0].content);
});

test('a huge single tool result is chunked into bounded LLM requests and compacted as a complete group', async () => {
  const data = ('verified evidence 😀 <entry>\n').repeat(2000);
  const history: ChatMessage[] = [
    { role: 'user', content: 'Investigate and preserve the user constraints.' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'one', name: 'inspect', arguments: '{}' }] },
    { role: 'tool', toolCallId: 'one', name: 'inspect', content: data },
  ];
  const requests: ChatRequest[] = [];
  const provider: Provider = { id: 'test', label: 'test', async chat(req) {
    requests.push(req);
    assert.ok(estimateMessagesTokens(req.messages) + (req.maxTokens ?? 0) <= 1800, 'summary request stays within the safety budget');
    return { text: 'Verified chunk and user context.', toolCalls: [], usage: { inputTokens: 12, outputTokens: 4 } };
  } };
  const c = config({ compaction: { ...DEFAULT_CONFIG.compaction, contextWindowTokens: 2000, keepLastMessages: 10 } });
  const { newHistory, result } = await compactHistory(history, c, provider, undefined, { targetHistoryTokens: 600 });
  assert.equal(result.compacted, true);
  assert.ok(requests.length > 2);
  assert.ok(isTranscriptWellFormed(newHistory));
  assert.equal(newHistory.length, 1, 'the last complete tool group can be summarized under pressure');
  assert.equal(result.usage?.inputTokens, requests.length * 12);
  const parts = requests.map((req) => req.messages[0].content.split('Conversation JSON or consecutive fragment:\n')[1]);
  assert.ok(parts.join('').includes('Investigate and preserve the user constraints'));
  assert.ok(parts.join('').includes('verified evidence 😀'));
});

test('chunked summarization failure and cancellation preserve the complete original history', async () => {
  const history: ChatMessage[] = [
    { role: 'user', content: 'important text '.repeat(5000) },
    { role: 'assistant', content: 'recent' },
    { role: 'user', content: 'continue' },
  ];
  const c = config({ compaction: { ...DEFAULT_CONFIG.compaction, contextWindowTokens: 2000, keepLastMessages: 2 } });
  let calls = 0;
  const failure: Provider = { id: 'test', label: 'test', async chat() {
    if (++calls === 3) throw new Error('summary service failed');
    return { text: 'Chunk summary.', toolCalls: [], usage: { inputTokens: 10, outputTokens: 2 } };
  } };
  const result = await compactHistory(history, c, failure);
  assert.strictEqual(result.newHistory, history);
  assert.equal(result.result.compacted, false);
  assert.match(result.result.summary, /summary service failed/);
  assert.equal(result.result.usage?.totalTokens, 24);
  const controller = new AbortController();
  const cancelling: Provider = { id: 'test', label: 'test', async chat() { controller.abort(); throw new Error('cancelled'); } };
  await assert.rejects(compactHistory(history, c, cancelling, controller.signal), /cancelled/);
  assert.equal(history[0].content.includes('important text'), true);
});

test('chunked compaction preserves image attachments and summarizes them in bounded vision calls', async () => {
  const image = { mediaType: 'image/png', data: 'YWJj', name: 'screen.png' };
  const history: ChatMessage[] = [
    { role: 'user', content: 'Screenshot context. '.repeat(3000), images: [image] },
    { role: 'assistant', content: 'recent' },
    { role: 'user', content: 'continue' },
  ];
  const requests: ChatRequest[] = [];
  const provider: Provider = { id: 'test', label: 'test', async chat(req) {
    requests.push(req);
    return { text: req.messages[0].images ? 'Image showed a screenshot.' : 'Relevant context.', toolCalls: [] };
  } };
  const c = config({ compaction: { ...DEFAULT_CONFIG.compaction, contextWindowTokens: 3000, keepLastMessages: 2 } });
  const { result, newHistory } = await compactHistory(history, c, provider);
  assert.equal(result.compacted, true);
  assert.ok(requests.some((request) => request.messages[0].images?.[0] === image));
  assert.deepEqual(newHistory[0].images, [image]);
});

test('compaction splits a summary request further after provider context rejection', async () => {
  const history = longHistory();
  const requests: ChatRequest[] = [];
  const provider: Provider = { id: 'test', label: 'test', async chat(req) {
    requests.push(req);
    if (estimateMessagesTokens(req.messages) > 550) throw new Error('maximum context length exceeded');
    return { text: 'Compact verified summary.', toolCalls: [] };
  } };
  const c = config({ compaction: { ...DEFAULT_CONFIG.compaction, contextWindowTokens: 10000, keepLastMessages: 2 } });
  const { result } = await compactHistory(history, c, provider);
  assert.equal(result.compacted, true);
  assert.ok(requests.length > 1);
});

test('adaptive compaction happens even with fewer messages than keepLastMessages', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-adaptive-'));
  try {
    let taskCalls = 0;
    let summaryCalls = 0;
    const provider: Provider = { id: 'test', label: 'test', async chat(req) {
      if (isSummary(req)) { summaryCalls++; return { text: 'Earlier user requirements summarized.', toolCalls: [] }; }
      taskCalls++;
      return { text: 'Complete.', toolCalls: [] };
    } };
    const c = config({ compaction: { ...DEFAULT_CONFIG.compaction, contextWindowTokens: 5000, keepLastMessages: 10, threshold: 0.65 } });
    const session = new HarnessSession({ host: new Host(dir), provider, tools: new ToolRegistry([]), config: c });
    session.restoreConversation([{ role: 'user', content: 'Long verified task. '.repeat(650) }]);
    const result = await session.runTask('Continue.', () => {});
    assert.equal(result.outcome, 'complete');
    assert.equal(taskCalls, 1);
    assert.ok(summaryCalls >= 1);
    assert.ok(session.transcript.some((m) => m.content.includes('Conversation compacted')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('cancelling after a completed summary chunk retains its reported usage', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-cancel-chunks-'));
  try {
    let calls = 0;
    let session: HarnessSession;
    const provider: Provider = { id: 'test', label: 'test', async chat() {
      if (++calls === 1) return { text: 'First chunk summary.', toolCalls: [], usage: { inputTokens: 50, outputTokens: 8 } };
      session.cancel();
      throw new Error('cancelled');
    } };
    const c = config({ compaction: { ...DEFAULT_CONFIG.compaction, contextWindowTokens: 2000, keepLastMessages: 2 } });
    session = new HarnessSession({ host: new Host(dir), provider, tools: new ToolRegistry([]), config: c });
    const original: ChatMessage[] = [
      { role: 'user', content: 'Important task details. '.repeat(3000) },
      { role: 'assistant', content: 'Recent.' },
      { role: 'user', content: 'Continue.' },
    ];
    session.restoreConversation(original);
    await assert.rejects(session.compact(), /cancelled/);
    assert.deepEqual(session.transcript, original);
    assert.equal(session.usage.totalTokens, 58);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('chunked compaction has a bounded provider request count', async () => {
  const history: ChatMessage[] = [
    { role: 'user', content: 'A'.repeat(250000) },
    { role: 'assistant', content: 'recent' },
    { role: 'user', content: 'continue' },
  ];
  let calls = 0;
  const provider: Provider = { id: 'test', label: 'test', async chat() { calls++; return { text: 'Summary.', toolCalls: [] }; } };
  const c = config({ compaction: { ...DEFAULT_CONFIG.compaction, contextWindowTokens: 1000, keepLastMessages: 2 } });
  const result = await compactHistory(history, c, provider);
  assert.equal(result.result.compacted, false);
  assert.strictEqual(result.newHistory, history);
  assert.equal(calls, 0, 'fail before incurring costs if the minimum number of chunks exceeds the cap');
  assert.match(result.result.summary, /64-request safety limit/);
});

test('summary target fits the reserved output capacity of a small configured window', async () => {
  const history = longHistory();
  const requests: ChatRequest[] = [];
  const provider: Provider = { id: 'test', label: 'test', async chat(req) { requests.push(req); return { text: 'Short verified summary.', toolCalls: [] }; } };
  const c = config({ compaction: { ...DEFAULT_CONFIG.compaction, contextWindowTokens: 1000, keepLastMessages: 2 } });
  const { result } = await compactHistory(history, c, provider);
  assert.equal(result.compacted, true);
  assert.ok(requests.length > 0);
  for (const req of requests) {
    const target = Number(req.messages[0].content.match(/under approximately (\d+) tokens/)?.[1]);
    assert.ok(target <= (req.maxTokens ?? 0), `summary target ${target} must fit ${req.maxTokens} output tokens`);
    assert.ok(estimateMessagesTokens(req.messages) + (req.maxTokens ?? 0) <= 900);
  }
});

test('length-stopped summaries get larger output budgets and succeed without losing original history', async () => {
  for (const finishReason of ['length', 'max_tokens']) {
    const requests: ChatRequest[] = [];
    const provider: Provider = { id: 'test', label: 'test', async chat(req) {
      requests.push(req);
      if (requests.length < 3) return { text: requests.length === 1 ? '' : 'Partial', toolCalls: [], finishReason, usage: { inputTokens: 10, outputTokens: 20 } };
      return { text: 'Concise complete summary.', toolCalls: [], finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5 } };
    } };
    const original = longHistory();
    const snapshot = JSON.stringify(original);
    const { result, newHistory } = await compactHistory(original, config({ compaction: { ...DEFAULT_CONFIG.compaction, keepLastMessages: 2 } }), provider);
    assert.equal(result.compacted, true);
    assert.equal(requests.length, 3);
    assert.ok(requests[1].maxTokens! > requests[0].maxTokens!);
    assert.ok(requests[2].maxTokens! > requests[1].maxTokens!);
    assert.ok(requests[2].maxTokens! <= 8192);
    assert.ok(requests.every((req) => estimateMessagesTokens(req.messages) + req.maxTokens! <= DEFAULT_CONFIG.compaction.contextWindowTokens * 0.9));
    assert.equal(JSON.stringify(original), snapshot);
    assert.ok(newHistory[0].content.includes('Concise complete summary.'));
    assert.equal(result.usage?.totalTokens, 75);
  }
});

test('a constrained context window bounds every retry even when summaries are truncated', async () => {
  const requests: ChatRequest[] = [];
  const provider: Provider = { id: 'test', label: 'test', async chat(req) {
    requests.push(req);
    return { text: '', toolCalls: [], finishReason: 'length' };
  } };
  const history = longHistory();
  const c = config({ compaction: { ...DEFAULT_CONFIG.compaction, contextWindowTokens: 1000, keepLastMessages: 2 } });
  const { result, newHistory } = await compactHistory(history, c, provider);
  assert.equal(result.compacted, false);
  assert.strictEqual(newHistory, history);
  assert.match(result.summary, /output limit on three attempts/);
  assert.equal(requests.length, 3);
  for (const req of requests) {
    assert.ok(estimateMessagesTokens(req.messages) + req.maxTokens! <= 900);
    assert.ok(req.maxTokens! <= 300);
  }
});

test('automatic compaction failure reports one retention notice and leaves original context intact', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-compact-length-'));
  try {
    let summaries = 0;
    const provider: Provider = { id: 'test', label: 'test', async chat(req) {
      if (isSummary(req)) { summaries++; return { text: 'Partial', toolCalls: [], finishReason: 'length', usage: { inputTokens: 10, outputTokens: 20 } }; }
      return { text: 'Continued.', toolCalls: [] };
    } };
    const c = config({ compaction: { ...DEFAULT_CONFIG.compaction, autoCompact: true, keepLastMessages: 2, contextWindowTokens: 2000, threshold: 0.5 } });
    const session = new HarnessSession({ host: new Host(dir), provider, config: c });
    const history = longHistory();
    session.restoreConversation(history, {}, history, true);
    const events: HarnessEvent[] = [];
    await session.runTask('Continue', (event) => events.push(event));
    assert.equal(summaries, 3);
    assert.deepEqual(session.transcript.slice(0, history.length), history);
    assert.deepEqual(session.originalConversationSnapshot.slice(0, history.length), history);
    const notice = events.find((event): event is Extract<HarnessEvent, { type: 'notice' }> => event.type === 'notice' && event.message.includes('Could not compact'));
    assert.ok(notice);
    assert.match(notice.message, /output limit on three attempts/);
    assert.equal((notice.message.match(/Original context/gi) ?? []).length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('context breakdown includes reserved output and excludes tools denied by the selected agent policy', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-context-breakdown-'));
  try {
    fs.writeFileSync(path.join(dir, 'agent.md'), '---\ntools: [read_file]\n---\nsmall instruction');
    const large: Tool = { name: 'huge_mcp', description: 'extra schema '.repeat(10_000), parameters: { type: 'object' }, async run() { return { ok: true, content: 'unused' }; } };
    const provider: Provider = { id: 'fake', label: 'fake', async chat() { return { text: 'done', toolCalls: [] }; } };
    const c = config({ maxOutputTokens: 60_000, compaction: { ...DEFAULT_CONFIG.compaction, autoCompact: false, contextWindowTokens: 60_000 } });
    const registry = new ToolRegistry(); registry.add(large);
    const session = new HarnessSession({ host: new Host(dir), provider, config: c, tools: registry, agentSelection: ['agent.md'] });
    const result = await session.runTask('hello', () => {});
    const b = result.contextBreakdown!;
    assert.equal(b.policyKnown, true);
    assert.equal(b.outputReserve, 60_000);
    assert.ok(b.tools < 10_000, 'disallowed huge schema is not counted');
    assert.equal(result.contextTokens, b.system + b.conversation + b.images + b.tools + b.framing + b.adjustment + b.outputReserve);
    assert.ok(result.contextTokens! > 60_000, 'output reservation alone consumes the window');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a new task with an oversized output reserve warns about fixed context without attempting empty compaction', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-context-reserve-'));
  try {
    let calls = 0;
    const provider: Provider = { id: 'fake', label: 'fake', async chat() { calls++; return { text: 'done', toolCalls: [] }; } };
    const c = config({ maxOutputTokens: 60_000, compaction: { ...DEFAULT_CONFIG.compaction, contextWindowTokens: 60_000 } });
    const session = new HarnessSession({ host: new Host(dir), provider, config: c });
    const events: HarnessEvent[] = [];
    await session.runTask('One short prompt', (e) => events.push(e));
    assert.equal(calls, 1);
    assert.ok(events.some((e) => e.type === 'notice' && /before there is older history to compact/.test(e.message) && /60000-token output reserve/.test(e.message)));
    assert.ok(!events.some((e) => e.type === 'notice' && /Could not compact conversation/.test(e.message)));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
