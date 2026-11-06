import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { HarnessSession } from '../core/agent';
import { ConsecutiveSentenceTracker, RepeatedToolCallTracker, ThinkingStreamGuard } from '../core/loopTracking';
import { isTranscriptWellFormed } from '../core/transcript';
import { ToolRegistry } from '../core/tools';
import { DEFAULT_CONFIG, type ChatMessage, type ChatRequest, type HarnessEvent, type HarnessHost, type Provider, type ProviderResponse, type Tool } from '../core/types';

test('sentence tracker handles tiny deltas, resets on a different sentence and supports Unicode', () => {
  const tracker = new ConsecutiveSentenceTracker();
  const sentence = 'Please read the file. ';
  let result = { looping: false, count: 0 };
  for (const ch of sentence.repeat(2)) result = tracker.add(ch);
  assert.equal(result.count, 2);
  tracker.add('A different sentence breaks the streak. ');
  for (const ch of sentence.repeat(2)) result = tracker.add(ch);
  assert.equal(result.looping, false);
  for (const ch of sentence) result = tracker.add(ch);
  assert.equal(result.looping, true);
  tracker.add('Something different.');
  assert.equal(tracker.add(sentence).count, 1);
  tracker.reset();
  assert.equal(tracker.add('നമുക്ക് ഫയൽ പരിശോധിക്കാം. '.repeat(3)).looping, true);
  tracker.reset();
  assert.equal(tracker.add(sentence + 'OK. ' + sentence.repeat(2)).looping, false);
});

test('tool tracker compares canonical arguments and resets on any different call or result', () => {
  const tracker = new RepeatedToolCallTracker();
  const call = { id: '1', name: 'read_file', arguments: '{"path":"a","opts":{"b":2,"a":1}}' };
  const result = { ok: true, content: 'unchanged' };
  assert.equal(tracker.record(call, result), 1);
  assert.equal(tracker.record({ ...call, id: '2', arguments: '{"opts":{"a":1,"b":2},"path":"a"}' }, result), 2);
  assert.equal(tracker.record(call, result), 3);
  assert.equal(tracker.record(call, { ...result, content: 'changed' }), 1);
  assert.equal(tracker.record({ ...call, name: 'other' }, result), 1);
  assert.equal(tracker.record(call, result), 1);
  tracker.reset();
  assert.equal(tracker.record(call, result), 1);
});

class FakeHost implements HarnessHost {
  constructor(readonly workspaceRoot: string) {}
  log(): void {}
  async requestApproval(): Promise<'apply'> { return 'apply'; }
}

function workspace(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'harness-loop-')); }

for (const showThinking of [true, false]) {
  test(`stream loop is interrupted and retried with display ${showThinking ? 'on' : 'off'}`, async () => {
    const dir = workspace();
    try {
      const events: HarnessEvent[] = [];
      const seen: ChatMessage[][] = [];
      let firstSignal: AbortSignal | undefined;
      const provider: Provider = {
        id: 'loop', label: 'loop',
        async chat(req) {
          seen.push(req.messages);
          if (seen.length === 1) {
            firstSignal = req.signal;
            for (const ch of 'I need to check the file. '.repeat(5)) {
              req.onThinking?.(ch);
              if (req.signal?.aborted) break;
            }
            // Some providers return a partial response rather than throwing on abort.
            return { text: '', toolCalls: [{ id: 'partial', name: 'read_file', arguments: '{}' }] };
          }
          return { text: 'Recovered.', toolCalls: [] };
        },
      };
      const session = new HarnessSession({ host: new FakeHost(dir), provider, config: { ...DEFAULT_CONFIG, stream: true, showThinking, maxSteps: 5 } });
      const result = await session.runTask('test', (event) => events.push(event));
      assert.equal(result.outcome, 'complete');
      assert.equal(result.toolCalls, 0);
      assert.equal(firstSignal?.aborted, true);
      assert.equal(seen.length, 2);
      assert.ok(seen[1].some((m) => m.role === 'user' && m.content.includes('reasoning repeated')));
      assert.ok(isTranscriptWellFormed(seen[1]));
      assert.ok(events.some((e) => e.type === 'notice' && e.message.includes('stream was interrupted')));
      assert.equal(events.some((e) => e.type === 'thinking-delta'), showThinking);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}

test('repeated interrupted thinking attempts stop instead of retrying indefinitely', async () => {
  const dir = workspace();
  try {
    let calls = 0;
    const provider: Provider = { id: 'loop', label: 'loop', async chat(req) {
      calls++;
      req.onThinking?.('I need to check the file. '.repeat(3));
      throw new Error('aborted');
    } };
    const session = new HarnessSession({ host: new FakeHost(dir), provider, config: { ...DEFAULT_CONFIG, stream: true, maxSteps: 10 } });
    const result = await session.runTask('test', () => {});
    assert.equal(calls, 3);
    assert.equal(result.outcome, 'error');
    assert.match(result.summary, /repeated thinking interruptions/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('repeated tool calls produce a notice and a provider-safe nudge after all tool results', async () => {
  const dir = workspace();
  try {
    const events: HarnessEvent[] = [];
    const seen: ChatMessage[][] = [];
    let executed = 0;
    const tool: Tool = { name: 'inspect', description: 'inspect', parameters: { type: 'object' }, async run() {
      executed++;
      return { ok: true, content: 'no change' };
    } };
    const provider: Provider = { id: 'loop', label: 'loop', async chat(req): Promise<ProviderResponse> {
      seen.push(req.messages);
      if (seen.length === 1) return { text: '', toolCalls: [1, 2, 3].map((id) => ({ id: String(id), name: 'inspect', arguments: '{"x":1}' })) };
      return { text: 'Done', toolCalls: [] };
    } };
    const session = new HarnessSession({ host: new FakeHost(dir), provider, tools: new ToolRegistry([tool]), config: { ...DEFAULT_CONFIG, maxSteps: 5 } });
    const result = await session.runTask('test', (e) => events.push(e));
    assert.equal(result.outcome, 'complete');
    assert.equal(executed, 3);
    assert.ok(events.some((e) => e.type === 'notice' && /Tool loop detected/.test(e.message)));
    assert.ok(isTranscriptWellFormed(seen[1]));
    assert.equal(seen[1].filter((m) => m.role === 'tool').length, 3);
    assert.equal(seen[1].at(-1)?.role, 'user');
    assert.match(seen[1].at(-1)?.content ?? '', /Do not repeat/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('successful progress resets consecutive thinking interruptions', async () => {
  const dir = workspace();
  try {
    let calls = 0;
    const provider: Provider = { id: 'loop', label: 'loop', async chat(req) {
      calls++;
      if (calls === 1 || calls === 3 || calls === 4) {
        req.onThinking?.('I need to check the file. '.repeat(3));
        throw new Error('aborted');
      }
      if (calls === 2) return { text: '', toolCalls: [{ id: 'read', name: 'list_files', arguments: '{}' }] };
      return { text: 'Done.', toolCalls: [] };
    } };
    const session = new HarnessSession({ host: new FakeHost(dir), provider, config: { ...DEFAULT_CONFIG, maxSteps: 7, stream: true } });
    const result = await session.runTask('test', () => {});
    assert.equal(result.outcome, 'complete');
    assert.equal(calls, 5);
    assert.equal(result.toolCalls, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('user cancellation takes precedence over loop recovery', async () => {
  const dir = workspace();
  try {
    let session: HarnessSession;
    let calls = 0;
    const provider: Provider = { id: 'cancel', label: 'cancel', async chat(req) {
      calls++;
      session.cancel();
      assert.equal(req.signal?.aborted, true);
      throw new Error('cancelled');
    } };
    session = new HarnessSession({ host: new FakeHost(dir), provider, config: { ...DEFAULT_CONFIG, stream: true, maxSteps: 5 } });
    const result = await session.runTask('test', () => {});
    assert.equal(result.outcome, 'cancelled');
    assert.equal(calls, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('completed non-streaming response reports repetition without discarding its answer', async () => {
  const dir = workspace();
  try {
    const events: HarnessEvent[] = [];
    const provider: Provider = { id: 'plain', label: 'plain', async chat() {
      return { text: 'Done.', thinking: 'I need to check the file. '.repeat(3), toolCalls: [] };
    } };
    const session = new HarnessSession({ host: new FakeHost(dir), provider, config: { ...DEFAULT_CONFIG, stream: false, showThinking: false, maxSteps: 5 } });
    const result = await session.runTask('test', (e) => events.push(e));
    assert.equal(result.outcome, 'complete');
    assert.equal(result.summary, 'Done.');
    assert.ok(events.some((e) => e.type === 'notice' && e.message.includes('completed response')));
    assert.ok(!events.some((e) => e.type === 'thinking' || e.type === 'thinking-delta'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('thinking guard catches sentence, alternating block and punctuation-free phrase independent of chunking', () => {
  const a = 'First I will inspect files. ';
  const b = 'Next I will check the project. ';
  const examples: Array<[string, string]> = [
    [a.repeat(3) + b, 'sentence'],
    [(a + b).repeat(20), 'block'],
    ['checking the same file and inspecting its contents repeatedly '.repeat(20), 'phrase'],
  ];
  for (const [text, expected] of examples) {
    const whole = new ThinkingStreamGuard(0).add(text);
    assert.equal(whole.reason, expected);
    const split = new ThinkingStreamGuard(0);
    let accepted = '';
    let reason: string | undefined;
    for (const char of text) {
      const result = split.add(char);
      accepted += result.accepted;
      if (result.reason) { reason = result.reason; break; }
    }
    assert.equal(reason, expected);
    assert.equal(accepted, whole.accepted);
  }
});

test('sentence detection remembers a loop inside a chunk and resets after the pattern breaks', () => {
  const tracker = new ConsecutiveSentenceTracker();
  const a = 'First I will inspect files. ';
  const b = 'Next I will check the project. ';
  assert.equal(tracker.add(a.repeat(3) + b).looping, true);
  assert.equal(tracker.add('One more different sentence. ').looping, false);
  assert.equal(tracker.add((a + b).repeat(2)).looping, false);
  assert.equal(tracker.add(a + b).reason, 'repeated 2-sentence block');
});

test('thinking guard enforces a separate configurable budget and permits long unique content when disabled', () => {
  const unique = Array.from({ length: 1000 }, (_, i) => `Unique item ${i} has an independent observation. `).join('');
  const bounded = new ThinkingStreamGuard(500).add(unique);
  assert.equal(bounded.reason, 'budget');
  assert.equal(bounded.accepted.length, 500);
  const unbounded = new ThinkingStreamGuard(0).add(unique);
  assert.equal(unbounded.reason, undefined);
  assert.equal(unbounded.accepted, unique);
});

test('thinking budget interrupts despite hidden display and the next attempt receives a budget-specific nudge', async () => {
  const dir = workspace();
  try {
    const events: HarnessEvent[] = [];
    const seen: ChatMessage[][] = [];
    let aborted = false;
    const provider: Provider = { id: 'long', label: 'long', async chat(req) {
      seen.push(req.messages);
      if (seen.length === 1) {
        req.onThinking?.('A long but nonrepeating explanation is still being generated.');
        aborted = !!req.signal?.aborted;
        return { text: '', toolCalls: [{ id: 'bad', name: 'list_files', arguments: '{}' }] };
      }
      return { text: 'Recovered.', toolCalls: [] };
    } };
    const session = new HarnessSession({ host: new FakeHost(dir), provider, config: { ...DEFAULT_CONFIG, showThinking: false, stream: true, thinkingMaxChars: 40, maxSteps: 5 } });
    const result = await session.runTask('test', (e) => events.push(e));
    assert.equal(result.outcome, 'complete');
    assert.equal(result.toolCalls, 0);
    assert.ok(aborted);
    assert.ok(events.some((e) => e.type === 'notice' && /40-character safety budget/.test(e.message)));
    assert.ok(seen[1].some((m) => m.role === 'user' && m.content.includes('thinking length budget')));
    assert.ok(!events.some((e) => e.type === 'thinking' || e.type === 'thinking-delta'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('display is bounded independently when the thinking budget is disabled', async () => {
  const dir = workspace();
  try {
    const events: HarnessEvent[] = [];
    const unique = Array.from({ length: 400 }, (_, i) => `Observation ${i} contains different evidence. `).join('');
    const provider: Provider = { id: 'long', label: 'long', async chat(req) {
      req.onThinking?.(unique);
      assert.equal(req.signal?.aborted, false);
      return { text: 'Done.', toolCalls: [] };
    } };
    const session = new HarnessSession({ host: new FakeHost(dir), provider, config: { ...DEFAULT_CONFIG, showThinking: true, stream: true, thinkingMaxChars: 0, maxSteps: 5 } });
    const result = await session.runTask('test', (e) => events.push(e));
    assert.equal(result.outcome, 'complete');
    const displayed = events.filter((e): e is Extract<HarnessEvent, { type: 'thinking-delta' }> => e.type === 'thinking-delta').map((e) => e.text).join('');
    assert.ok(displayed.length < 12050);
    assert.match(displayed, /thinking display truncated/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
