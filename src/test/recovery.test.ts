import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, test } from 'node:test';
import { HarnessSession } from '../core/agent';
import { compactHistory } from '../core/compaction';
import { httpError, isRetryableProviderError, retryDelayMs } from '../core/providers/errors';
import { auditToolMessages, isTranscriptWellFormed, repairToolMessages } from '../core/transcript';
import {
  DEFAULT_CONFIG,
  type ChatMessage,
  type ChatRequest,
  type HarnessConfig,
  type HarnessEvent,
  type HarnessHost,
  type Provider,
  type ProviderResponse,
} from '../core/types';

/**
 * These tests cover the ways a run used to end before the task was finished:
 * a transcript the provider refuses, a transient API failure, a reply cut off
 * by the output limit, and a compaction that cut through a tool-call group.
 */

const tempDirs: string[] = [];

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-recovery-'));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

class FakeHost implements HarnessHost {
  readonly approvals: number = 0;
  constructor(readonly workspaceRoot: string) {}
  log(): void {}
  async requestApproval(): Promise<'apply'> {
    return 'apply';
  }
}

function config(overrides: Partial<HarnessConfig> = {}): HarnessConfig {
  return { ...DEFAULT_CONFIG, provider: 'openai', includeDiagnosticsInPrompt: false, ...overrides };
}

const writeCall = (id: string, file: string): { id: string; name: string; arguments: string } => ({
  id,
  name: 'write_file',
  arguments: JSON.stringify({ path: file, mode: 'create', content: `${file}\n` }),
});

/**
 * A provider that enforces the rules the real APIs enforce, so a bad transcript
 * fails the test the way it would fail in the editor.
 */
class StrictProvider implements Provider {
  readonly id = 'openai';
  readonly label = 'strict';
  readonly requests: ChatRequest[] = [];
  constructor(private readonly respond: (turn: number) => ProviderResponse | Error) {}

  async chat(req: ChatRequest): Promise<ProviderResponse> {
    const { orphanToolResults, unansweredToolCalls } = auditToolMessages(req.messages);
    if (orphanToolResults.length || unansweredToolCalls.length) {
      throw httpError(
        400,
        `Invalid transcript: orphan tool results [${orphanToolResults.join(', ')}], ` +
          `unanswered tool calls [${unansweredToolCalls.join(', ')}]`,
      );
    }
    this.requests.push(req);
    const response = this.respond(this.requests.length);
    if (response instanceof Error) throw response;
    return response;
  }
}

/* ------------------------------------------------------------ transcript */

test('repairToolMessages drops orphaned results and unanswered calls', () => {
  const messages: ChatMessage[] = [
    { role: 'user', content: 'do it' },
    { role: 'assistant', content: 'both', toolCalls: [
      { id: 'a', name: 'read_file', arguments: '{}' },
      { id: 'b', name: 'read_file', arguments: '{}' },
    ] },
    { role: 'tool', toolCallId: 'a', name: 'read_file', content: 'contents' },
    { role: 'tool', toolCallId: 'ghost', name: 'read_file', content: 'never asked for' },
    { role: 'user', content: 'next' },
  ];

  const audit = auditToolMessages(messages);
  assert.deepEqual(audit.orphanToolResults, ['ghost']);
  assert.deepEqual(audit.unansweredToolCalls, ['b']);
  assert.equal(isTranscriptWellFormed(messages), false);

  const repaired = repairToolMessages(messages);
  assert.equal(isTranscriptWellFormed(repaired), true);
  assert.deepEqual(repaired[1].toolCalls?.map((c) => c.id), ['a']);
  assert.equal(repaired[1].content, 'both', 'prose the turn produced must survive');
  assert.equal(repaired.filter((m) => m.role === 'tool').length, 1);
  assert.deepEqual(repaired.map((m) => m.role), ['user', 'assistant', 'tool', 'user']);

  // A drop-in nothing to fix must not churn the array.
  assert.equal(repairToolMessages(repaired), repaired);
});

test('a cancelled tool batch leaves a transcript the provider still accepts', async () => {
  const dir = makeWorkspace();
  const provider = new StrictProvider((turn) =>
    turn === 1
      ? {
          text: 'Writing three files.',
          usage: {},
          toolCalls: [writeCall('c1', 'a.txt'), writeCall('c2', 'b.txt'), writeCall('c3', 'c.txt')],
        }
      : { text: 'Follow-up done.', usage: {}, toolCalls: [] },
  );
  const session = new HarnessSession({ host: new FakeHost(dir), config: config({ maxSteps: 6 }), provider });

  // Cancel as soon as the first of the three writes lands.
  const first = await session.runTask('write three files', (event: HarnessEvent) => {
    if (event.type === 'tool-end') session.cancel();
  });
  assert.equal(first.outcome, 'cancelled');
  assert.equal(isTranscriptWellFormed([...session.transcript]), true, 'history must not keep a dangling tool call');

  // The next task in the same conversation must still be able to call the model.
  const second = await session.runTask('now do something else', () => {});
  assert.equal(second.outcome, 'complete');
  assert.equal(second.summary, 'Follow-up done.');
});

/* ----------------------------------------------------------- compaction */

test('compaction never starts the kept tail with an orphaned tool result', () => {
  const history: ChatMessage[] = [
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: 'a1', toolCalls: [{ id: 't1', name: 'read_file', arguments: '{}' }] },
    { role: 'tool', toolCallId: 't1', name: 'read_file', content: 'r1' },
    { role: 'user', content: 'u2' },
    { role: 'assistant', content: 'a2', toolCalls: [
      { id: 't2', name: 'read_file', arguments: '{}' },
      { id: 't3', name: 'read_file', arguments: '{}' },
      { id: 't4', name: 'read_file', arguments: '{}' },
    ] },
    { role: 'tool', toolCallId: 't2', name: 'read_file', content: 'r2' },
    { role: 'tool', toolCallId: 't3', name: 'read_file', content: 'r3' },
    { role: 'tool', toolCallId: 't4', name: 'read_file', content: 'r4' },
    { role: 'user', content: 'u3' },
    { role: 'assistant', content: 'a3', toolCalls: [{ id: 't5', name: 'read_file', arguments: '{}' }] },
    { role: 'tool', toolCallId: 't5', name: 'read_file', content: 'r5' },
  ];

  const { newHistory, result } = compactHistory(history, config({ compaction: {
    ...DEFAULT_CONFIG.compaction,
    keepLastMessages: 6,
  } }));

  assert.equal(result.compacted, true);
  assert.equal(isTranscriptWellFormed(newHistory), true);
  // The summary opens the compacted history as a user turn: Anthropic rejects a
  // conversation whose first message is not from the user.
  assert.equal(newHistory[0].role, 'user');
  assert.match(newHistory[0].content, /Conversation compacted/);
  // Every kept assistant tool call keeps its result.
  assert.ok(newHistory.some((m) => m.role === 'tool'));
});

test('a follow-up task after mid-task compaction sends a well-formed prompt', async () => {
  const dir = makeWorkspace();
  const seen: ChatMessage[][] = [];
  let turn = 0;
  const provider: Provider = {
    id: 'openai',
    label: 'scripted',
    async chat(req: ChatRequest): Promise<ProviderResponse> {
      seen.push(req.messages.filter((m) => m.role !== 'system'));
      turn++;
      if (turn <= 3) {
        return {
          text: `turn ${turn}`,
          usage: {},
          toolCalls: [writeCall(`c${turn}`, `f${turn}.txt`)],
        };
      }
      return { text: 'done', usage: {}, toolCalls: [] };
    },
  };

  const compaction = { ...DEFAULT_CONFIG.compaction, threshold: 0.0001, contextWindowTokens: 500, keepLastMessages: 4 };
  const session = new HarnessSession({ host: new FakeHost(dir), config: config({ maxSteps: 8, compaction }), provider });

  await session.runTask('first task', () => {});
  seen.length = 0;
  const result = await session.runTask('second task', () => {});

  assert.equal(result.outcome, 'complete');
  assert.ok(seen.length > 0);
  for (const messages of seen) {
    assert.equal(isTranscriptWellFormed(messages), true, 'every provider call needs a coherent transcript');
    assert.equal(new Set(messages.map((m) => m.content)).size, messages.length, 'compaction must not duplicate messages');
  }
});

/* ------------------------------------------------------ provider failures */

test('a transient provider failure is retried and the task still finishes', async () => {
  const dir = makeWorkspace();
  const events: HarnessEvent[] = [];
  let attempts = 0;
  const provider: Provider = {
    id: 'openai',
    label: 'flaky',
    async chat(): Promise<ProviderResponse> {
      attempts++;
      if (attempts === 1) throw httpError(429, 'HTTP 429 from endpoint: rate limited');
      return { text: 'Recovered and finished.', usage: {}, toolCalls: [] };
    },
  };

  const session = new HarnessSession({ host: new FakeHost(dir), config: config({ maxSteps: 4 }), provider });
  const result = await session.runTask('do the thing', (event) => events.push(event));

  assert.equal(attempts, 2, 'the 429 must be retried once');
  assert.equal(result.outcome, 'complete');
  assert.equal(result.summary, 'Recovered and finished.');
  const retryNotice = events.find(
    (event): event is Extract<HarnessEvent, { type: 'notice' }> => event.type === 'notice' && /retrying/i.test(event.message),
  );
  assert.ok(retryNotice, 'the panel should say the call is being retried');
  assert.equal(retryNotice.level, 'warn');
});

test('a permanent provider failure still ends the run with the provider message', async () => {
  const dir = makeWorkspace();
  let attempts = 0;
  const provider: Provider = {
    id: 'openai',
    label: 'broken',
    async chat(): Promise<ProviderResponse> {
      attempts++;
      throw httpError(400, 'HTTP 400 from endpoint: model does not exist');
    },
  };

  const session = new HarnessSession({ host: new FakeHost(dir), config: config({ maxSteps: 4 }), provider });
  const result = await session.runTask('do the thing', () => {});

  assert.equal(attempts, 1, 'a bad request must not be retried');
  assert.equal(result.outcome, 'error');
  assert.match(result.summary, /model does not exist/);
});

test('a stream that dies mid-answer is retried and the half-rendered bubble is closed', async () => {
  const dir = makeWorkspace();
  const events: HarnessEvent[] = [];
  let attempts = 0;
  const provider: Provider = {
    id: 'openai',
    label: 'flaky-stream',
    async chat(req: ChatRequest): Promise<ProviderResponse> {
      attempts++;
      if (attempts === 1) {
        req.onDelta?.('Half an ans');
        req.onDelta?.('wer…');
        throw new Error('fetch failed: socket hang up');
      }
      req.onDelta?.('The complete answer.');
      return { text: 'The complete answer.', toolCalls: [], usage: {} };
    },
  };

  const session = new HarnessSession({ host: new FakeHost(dir), config: config({ maxSteps: 4 }), provider });
  const result = await session.runTask('answer me', (event) => events.push(event));

  assert.equal(attempts, 2);
  assert.equal(result.outcome, 'complete');
  assert.equal(result.summary, 'The complete answer.');

  const finals = events.filter((e): e is Extract<HarnessEvent, { type: 'assistant' }> => e.type === 'assistant');
  const abandoned = finals.find((e) => !e.final && e.text === 'Half an answer…');
  assert.ok(abandoned, 'the abandoned attempt must be closed so the panel stops streaming it');
  assert.ok(finals.some((e) => e.id.includes('retry') && e.final === true), 'the retry is its own bubble');
});

test('only failures that can succeed on a retry are retried', () => {
  assert.equal(isRetryableProviderError(httpError(429, 'too many requests')), true);
  assert.equal(isRetryableProviderError(httpError(503, 'overloaded')), true);
  assert.equal(isRetryableProviderError(new Error('fetch failed')), true);
  assert.equal(isRetryableProviderError(new Error('socket hang up')), true);

  assert.equal(isRetryableProviderError(httpError(400, 'bad request')), false);
  assert.equal(isRetryableProviderError(httpError(401, 'invalid api key')), false);
  assert.equal(isRetryableProviderError(httpError(404, 'no such model')), false);
  assert.equal(isRetryableProviderError(new Error('tool "x" failed')), false);

  // Retry-After wins over the exponential default.
  assert.equal(retryDelayMs(httpError(429, 'slow down', 7_000), 5), 7_000);
  assert.ok(retryDelayMs(httpError(500, 'boom'), 1) <= 500);
  assert.ok(retryDelayMs(httpError(500, 'boom'), 4) <= 5_000);
});

/* --------------------------------------------------- truncated model turns */

test('a reply cut off by the output limit is continued, not treated as the answer', async () => {
  const dir = makeWorkspace();
  let turn = 0;
  const provider: Provider = {
    id: 'openai',
    label: 'verbose',
    async chat(): Promise<ProviderResponse> {
      turn++;
      if (turn === 1) {
        return { text: 'Here is the file you asked for: function main() {', toolCalls: [], finishReason: 'length', usage: {} };
      }
      return { text: 'Continued: ... } — done.', toolCalls: [], finishReason: 'stop', usage: {} };
    },
  };

  const session = new HarnessSession({ host: new FakeHost(dir), config: config({ maxSteps: 4 }), provider });
  const result = await session.runTask('write the function', () => {});

  assert.equal(turn, 2, 'the run must ask the model to continue instead of stopping');
  assert.equal(result.outcome, 'complete');
  assert.equal(result.summary, 'Continued: ... } — done.');
  assert.equal(session.transcript.some((m) => m.role === 'user' && /cut off/i.test(m.content)), true);
});
