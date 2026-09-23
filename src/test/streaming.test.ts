import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, test } from 'node:test';
import { HarnessSession } from '../core/agent';
import { AnthropicProvider } from '../core/providers/anthropic';
import { MockPlannerProvider } from '../core/providers/mock';
import { OpenAiCompatibleProvider } from '../core/providers/openai';
import {
  DEFAULT_CONFIG,
  type ChatRequest,
  type HarnessEvent,
  type HarnessHost,
  type Provider,
  type ProviderResponse,
} from '../core/types';

/* --------------------------------------------------------------- helpers */

const realFetch = globalThis.fetch;

after(() => {
  globalThis.fetch = realFetch;
});

/** Build a Response whose body is an SSE byte stream, split at odd boundaries. */
function sseResponse(events: string[], options: { contentType?: string; status?: number } = {}): Response {
  const encoder = new TextEncoder();
  const payload = encoder.encode(events.join(''));
  // Deliberately chunk mid-line to prove the parsers buffer correctly.
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < payload.length; i += 7) chunks.push(payload.slice(i, i + 7));

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });

  return new Response(body, {
    status: options.status ?? 200,
    headers: { 'content-type': options.contentType ?? 'text/event-stream' },
  });
}

function stubFetch(response: Response | (() => Response)): { calls: ChatRequest[] } {
  const state = { calls: [] as ChatRequest[] };
  const impl = async (input: any, init?: any) => {
    state.calls.push({ url: String(input), body: JSON.parse(init?.body ?? '{}') } as unknown as ChatRequest);
    return typeof response === 'function' ? response() : response;
  };
  globalThis.fetch = impl as unknown as typeof fetch;
  return state;
}

function sseChunk(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/* ----------------------------------------------------- OpenAI SSE parsing */

test('OpenAI provider streams text deltas and assembles split tool calls', async () => {
  const stub = stubFetch(
    sseResponse([
      sseChunk({ choices: [{ delta: { role: 'assistant', content: 'I will ' } }] }),
      sseChunk({ choices: [{ delta: { content: 'read the file.' } }] }),
      // A tool call arriving over three chunks, name split across two of them.
      sseChunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'read_' } }] } }] }),
      sseChunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'file', arguments: '{"path":' } }] } }] }),
      sseChunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"src/app.ts"}' } }] } }] }),
      sseChunk({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      sseChunk({ usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 }, choices: [] }),
      'data: [DONE]\n\n',
    ]),
  );

  const provider = new OpenAiCompatibleProvider({ apiKey: 'test-key', baseUrl: 'https://example.test/v1' });
  const deltas: string[] = [];
  const response = await provider.chat({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ name: 'read_file', description: 'read', parameters: { type: 'object' } }],
    onDelta: (text) => deltas.push(text),
  });

  assert.deepEqual(deltas, ['I will ', 'read the file.']);
  assert.equal(response.text, 'I will read the file.');
  assert.equal(response.toolCalls.length, 1);
  assert.equal(response.toolCalls[0].name, 'read_file');
  assert.equal(response.toolCalls[0].id, 'call_a');
  assert.deepEqual(JSON.parse(response.toolCalls[0].arguments), { path: 'src/app.ts' });
  assert.equal(response.finishReason, 'tool_calls');
  assert.equal(response.usage?.totalTokens, 19);

  // The request must actually ask for a stream.
  assert.equal((stub.calls[0] as any).body.stream, true);
});

test('OpenAI provider falls back to plain JSON when the endpoint ignores stream', async () => {
  stubFetch(
    new Response(
      JSON.stringify({
        choices: [{ message: { content: 'no streaming here' }, finish_reason: 'stop' }],
        usage: { total_tokens: 3 },
      }),
      { headers: { 'content-type': 'application/json' } },
    ),
  );

  const deltas: string[] = [];
  const provider = new OpenAiCompatibleProvider({ apiKey: 'k', baseUrl: 'https://example.test/v1' });
  const response = await provider.chat({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    onDelta: (t) => deltas.push(t),
  });

  assert.equal(response.text, 'no streaming here');
  assert.deepEqual(deltas, ['no streaming here'], 'the UI still receives the text');
});

test('OpenAI provider does not stream when no onDelta handler is given', async () => {
  const stub = stubFetch(
    new Response(JSON.stringify({ choices: [{ message: { content: 'plain' } }] }), {
      headers: { 'content-type': 'application/json' },
    }),
  );
  const provider = new OpenAiCompatibleProvider({ apiKey: 'k', baseUrl: 'https://example.test/v1' });
  await provider.chat({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }], tools: [] });
  assert.equal((stub.calls[0] as any).body.stream, false);
});

test('OpenAI stream surfaces provider errors delivered mid-stream', async () => {
  stubFetch(sseResponse([sseChunk({ error: { message: 'rate limit exceeded' } })]));
  const provider = new OpenAiCompatibleProvider({ apiKey: 'k', baseUrl: 'https://example.test/v1' });
  await assert.rejects(
    () =>
      provider.chat({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        onDelta: () => {},
      }),
    /rate limit exceeded/,
  );
});

test('OpenAI stream survives keep-alive comments and blank lines', async () => {
  stubFetch(
    sseResponse([
      ': ping\n\n',
      '\n',
      sseChunk({ choices: [{ delta: { content: 'still here' } }] }),
      'data: [DONE]\n\n',
    ]),
  );
  const provider = new OpenAiCompatibleProvider({ apiKey: 'k', baseUrl: 'https://example.test/v1' });
  const response = await provider.chat({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    onDelta: () => {},
  });
  assert.equal(response.text, 'still here');
});

/* -------------------------------------------------- Anthropic SSE parsing */

test('Anthropic provider streams text and reassembles tool_use JSON', async () => {
  const stub = stubFetch(
    sseResponse([
      'event: message_start\n' +
        sseChunk({ type: 'message_start', message: { usage: { input_tokens: 21 } } }).replace(/^data: /, 'data: '),
      'event: content_block_start\n' + sseChunk({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
      'event: content_block_delta\n' +
        sseChunk({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Checking ' } }),
      'event: content_block_delta\n' +
        sseChunk({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'the tests.' } }),
      'event: content_block_start\n' +
        sseChunk({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'run_command' } }),
      'event: content_block_delta\n' +
        sseChunk({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"comma' } }),
      'event: content_block_delta\n' +
        sseChunk({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'nd":"npm test"}' } }),
      'event: message_delta\n' +
        sseChunk({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 33 } }),
      'event: message_stop\n' + sseChunk({ type: 'message_stop' }),
    ]),
  );

  const provider = new AnthropicProvider({ apiKey: 'k', baseUrl: 'https://api.anthropic.test' });
  const deltas: string[] = [];
  const response = await provider.chat({
    model: 'claude-sonnet-4-5',
    messages: [{ role: 'user', content: 'run the tests' }],
    tools: [{ name: 'run_command', description: 'run', parameters: { type: 'object' } }],
    onDelta: (t) => deltas.push(t),
  });

  assert.deepEqual(deltas, ['Checking ', 'the tests.']);
  assert.equal(response.text, 'Checking the tests.');
  assert.equal(response.toolCalls.length, 1);
  assert.equal(response.toolCalls[0].name, 'run_command');
  assert.equal(response.toolCalls[0].id, 'toolu_1');
  assert.deepEqual(JSON.parse(response.toolCalls[0].arguments), { command: 'npm test' });
  assert.equal(response.finishReason, 'tool_use');
  assert.equal(response.usage?.inputTokens, 21);
  assert.equal(response.usage?.outputTokens, 33);
  assert.equal((stub.calls[0] as any).body.stream, true, 'the request must ask for a stream');
});

/* ------------------------------------------------------------- thinking */

test('OpenAI provider streams reasoning_content into the thinking lane', async () => {
  stubFetch(
    sseResponse([
      // DeepSeek-style: reasoning arrives first, on its own field.
      sseChunk({ choices: [{ delta: { reasoning_content: 'The user wants ' } }] }),
      sseChunk({ choices: [{ delta: { reasoning_content: 'the tests run.' } }] }),
      sseChunk({ choices: [{ delta: { content: 'Running them now.' } }] }),
      sseChunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    ]),
  );

  const provider = new OpenAiCompatibleProvider({ apiKey: 'k', baseUrl: 'https://example.test/v1' });
  const answer: string[] = [];
  const reasoning: string[] = [];
  const response = await provider.chat({
    model: 'deepseek-reasoner',
    messages: [{ role: 'user', content: 'run the tests' }],
    tools: [],
    onDelta: (t) => answer.push(t),
    onThinking: (t) => reasoning.push(t),
  });

  assert.deepEqual(reasoning, ['The user wants ', 'the tests run.']);
  assert.deepEqual(answer, ['Running them now.'], 'reasoning must not leak into the answer stream');
  assert.equal(response.text, 'Running them now.');
  assert.equal(response.thinking, 'The user wants the tests run.');
});

test('OpenAI provider accepts the OpenRouter `reasoning` field too', async () => {
  stubFetch(
    sseResponse([
      sseChunk({ choices: [{ delta: { reasoning: 'weighing options' } }] }),
      sseChunk({ choices: [{ delta: { content: 'Done.' } }] }),
    ]),
  );
  const provider = new OpenAiCompatibleProvider({ apiKey: 'k', baseUrl: 'https://example.test/v1' });
  const reasoning: string[] = [];
  const response = await provider.chat({
    model: 'some-model',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    onDelta: () => {},
    onThinking: (t) => reasoning.push(t),
  });
  assert.deepEqual(reasoning, ['weighing options']);
  assert.equal(response.thinking, 'weighing options');
});

test('OpenAI provider keeps reasoning when the endpoint ignores stream', async () => {
  stubFetch(
    new Response(
      JSON.stringify({
        choices: [{ message: { content: 'Answer.', reasoning_content: 'Thought first.' }, finish_reason: 'stop' }],
      }),
      { headers: { 'content-type': 'application/json' } },
    ),
  );
  const provider = new OpenAiCompatibleProvider({ apiKey: 'k', baseUrl: 'https://example.test/v1' });
  const reasoning: string[] = [];
  const response = await provider.chat({
    model: 'deepseek-reasoner',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    onDelta: () => {},
    onThinking: (t) => reasoning.push(t),
  });
  assert.deepEqual(reasoning, ['Thought first.']);
  assert.equal(response.text, 'Answer.');
  assert.equal(response.thinking, 'Thought first.');
});

test('Anthropic provider streams extended thinking blocks separately', async () => {
  stubFetch(
    sseResponse([
      'event: content_block_start\n' +
        sseChunk({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }),
      'event: content_block_delta\n' +
        sseChunk({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Let me check ' } }),
      'event: content_block_delta\n' +
        sseChunk({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'the file list.' } }),
      // signature chunks must be ignored, not rendered
      'event: content_block_delta\n' +
        sseChunk({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'abc123' } }),
      'event: content_block_start\n' +
        sseChunk({ type: 'content_block_start', index: 1, content_block: { type: 'text' } }),
      'event: content_block_delta\n' +
        sseChunk({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Here is the answer.' } }),
      'event: message_delta\n' + sseChunk({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
    ]),
  );

  const provider = new AnthropicProvider({ apiKey: 'k', baseUrl: 'https://api.anthropic.test' });
  const answer: string[] = [];
  const reasoning: string[] = [];
  const response = await provider.chat({
    model: 'claude-sonnet-4-5',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    onDelta: (t) => answer.push(t),
    onThinking: (t) => reasoning.push(t),
  });

  assert.deepEqual(reasoning, ['Let me check ', 'the file list.']);
  assert.deepEqual(answer, ['Here is the answer.']);
  assert.equal(response.thinking, 'Let me check the file list.');
  assert.ok(!JSON.stringify(reasoning).includes('abc123'), 'signatures must not be displayed');
});

test('Anthropic provider reads thinking blocks from a non-streaming reply', async () => {
  stubFetch(
    new Response(
      JSON.stringify({
        content: [
          { type: 'thinking', thinking: 'Considered the options.' },
          { type: 'text', text: 'The answer is 42.' },
        ],
        stop_reason: 'end_turn',
      }),
      { headers: { 'content-type': 'application/json' } },
    ),
  );
  const provider = new AnthropicProvider({ apiKey: 'k', baseUrl: 'https://api.anthropic.test' });
  const reasoning: string[] = [];
  const response = await provider.chat({
    model: 'claude-sonnet-4-5',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    onDelta: () => {},
    onThinking: (t) => reasoning.push(t),
  });
  assert.deepEqual(reasoning, ['Considered the options.']);
  assert.equal(response.text, 'The answer is 42.');
  assert.equal(response.thinking, 'Considered the options.');
});

test('the offline planner narrates its reasoning via onThinking', async () => {
  const provider = new MockPlannerProvider();
  const reasoning: string[] = [];
  const answer: string[] = [];
  const response = await provider.chat({
    model: 'mock',
    messages: [{ role: 'user', content: 'create a python script called demo.py' }],
    tools: [{ name: 'list_files', description: 'list', parameters: { type: 'object' } }],
    onDelta: (t) => answer.push(t),
    onThinking: (t) => reasoning.push(t),
  });
  assert.ok(reasoning.length > 3, `expected a reasoning stream, got ${reasoning.length} chunks`);
  assert.ok(reasoning.join(' ').length > 40, 'the reasoning should say something substantive');
  assert.equal(answer.join(''), response.text, 'the answer lane is separate');
});

/* ------------------------------------------------------------- mock typing */

test('the offline planner streams its narration word by word', async () => {
  const provider = new MockPlannerProvider();
  const deltas: string[] = [];
  const response = await provider.chat({
    model: 'mock',
    messages: [{ role: 'user', content: 'create a python script called demo.py' }],
    tools: [{ name: 'list_files', description: 'list', parameters: { type: 'object' } }],
    onDelta: (t) => deltas.push(t),
  });

  assert.ok(deltas.length > 2, 'expected several chunks, got ' + deltas.length);
  assert.equal(deltas.join(''), response.text);
  assert.ok(response.toolCalls.length === 1);
});

test('mock streaming stops promptly when the task is cancelled', async () => {
  const provider = new MockPlannerProvider();
  const controller = new AbortController();
  const deltas: string[] = [];
  const promise = provider.chat({
    model: 'mock',
    messages: [{ role: 'user', content: 'create a python script called demo.py' }],
    tools: [],
    signal: controller.signal,
    onDelta: (t) => {
      deltas.push(t);
      controller.abort();
    },
  });
  await promise;
  assert.equal(deltas.length, 1, 'aborting must stop the typing animation');
});

/* -------------------------------------------------------------- the agent */

class FakeHost implements HarnessHost {
  readonly approvals: string[] = [];
  constructor(readonly workspaceRoot: string) {}
  log(): void {}
  async requestApproval(): Promise<'apply'> {
    return 'apply';
  }
}

/** Provider that streams a scripted turn, so the loop can be tested in isolation. */
class ScriptedStreamingProvider implements Provider {
  readonly id = 'scripted';
  readonly label = 'Scripted';
  readonly seenDeltas = true;
  constructor(private readonly turns: Array<{ text: string; toolCalls?: any[] }>) {}
  async chat(req: ChatRequest): Promise<ProviderResponse> {
    const turn = this.turns.shift() ?? { text: 'done' };
    if (req.onDelta) {
      for (const word of turn.text.split(/(\s+)/)) if (word) req.onDelta(word);
    }
    return { text: turn.text, toolCalls: turn.toolCalls ?? [] };
  }
}

test('the agent emits assistant-delta events and finalises the same bubble', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-stream-'));
  try {
    const events: HarnessEvent[] = [];
    const session = new HarnessSession({
      host: new FakeHost(dir),
      config: { ...DEFAULT_CONFIG, provider: 'mock', stream: true, maxSteps: 4 },
      provider: new ScriptedStreamingProvider([
        { text: 'Looking at the layout now.', toolCalls: [{ id: 'c1', name: 'list_files', arguments: '{"path":"."}' }] },
        { text: 'All done: nothing needed changing.' },
      ]),
    });

    const result = await session.runTask('explain the project', (e) => events.push(e));

    const deltas = events.filter((e): e is Extract<HarnessEvent, { type: 'assistant-delta' }> => e.type === 'assistant-delta');
    assert.ok(deltas.length > 3, 'text should arrive in many chunks');
    assert.ok(deltas.every((d) => d.id.startsWith('assistant-')), 'deltas carry a stream id');

    // Each model turn is its own stream: deltas must not bleed between turns.
    const byId = new Map<string, string>();
    for (const delta of deltas) byId.set(delta.id, (byId.get(delta.id) ?? '') + delta.text);
    const ids = [...byId.keys()];
    assert.equal(ids.length, 2);
    assert.equal(byId.get(ids[0]), 'Looking at the layout now.');
    assert.equal(byId.get(ids[1]), 'All done: nothing needed changing.');

    const finals = events.filter((e): e is Extract<HarnessEvent, { type: 'assistant' }> => e.type === 'assistant');
    assert.equal(finals.length, 2);
    assert.equal(finals[0].id, ids[0], 'the completion event belongs to the streamed bubble');
    assert.equal(finals[0].streamed, true);
    assert.equal(finals[0].final, false);
    assert.equal(finals[1].id, ids[1]);
    assert.equal(finals[1].streamed, true);
    assert.equal(finals[1].final, true);
    assert.equal(result.outcome, 'complete');
    assert.equal(result.summary, 'All done: nothing needed changing.');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the agent emits thinking events and keeps them out of its own summary', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-thinking-'));
  try {
    const events: HarnessEvent[] = [];
    const session = new HarnessSession({
      host: new FakeHost(dir),
      config: { ...DEFAULT_CONFIG, provider: 'mock', stream: true, showThinking: true, maxSteps: 4 },
      provider: new MockPlannerProvider(),
    });

    await session.runTask('create a python script called think.py that prints hello', (e) => events.push(e));

    const deltas = events.filter(
      (e): e is Extract<HarnessEvent, { type: 'thinking-delta' }> => e.type === 'thinking-delta',
    );
    assert.ok(deltas.length > 2, `expected a streamed rationale, got ${deltas.length} chunks`);
    assert.ok(deltas.every((d) => d.id.startsWith('thinking-')));

    const done = events.filter((e): e is Extract<HarnessEvent, { type: 'thinking' }> => e.type === 'thinking');
    assert.ok(done.length >= 1, 'the lane must be closed with a duration');
    assert.ok(done[0].durationMs >= 0);
    assert.equal(done[0].text, deltas.filter((d) => d.id === done[0].id).map((d) => d.text).join(''));

    // The reasoning must not be treated as the assistant's answer.
    const finals = events.filter((e): e is Extract<HarnessEvent, { type: 'assistant' }> => e.type === 'assistant');
    assert.ok(finals.length > 0);
    for (const final of finals) {
      assert.ok(!final.text.includes('The request needs context first'), 'reasoning leaked into the answer text');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('showThinking=false suppresses the reasoning lane entirely', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-thinking-off-'));
  try {
    const events: HarnessEvent[] = [];
    const session = new HarnessSession({
      host: new FakeHost(dir),
      config: { ...DEFAULT_CONFIG, provider: 'mock', stream: true, showThinking: false, maxSteps: 3 },
      provider: new MockPlannerProvider(),
    });

    await session.runTask('create a python script called quiet.py that prints hello', (e) => events.push(e));
    assert.equal(events.filter((e) => e.type === 'thinking-delta').length, 0);
    assert.equal(events.filter((e) => e.type === 'thinking').length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('streaming can be switched off and the task still completes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-stream-'));
  try {
    const events: HarnessEvent[] = [];
    const session = new HarnessSession({
      host: new FakeHost(dir),
      config: { ...DEFAULT_CONFIG, provider: 'mock', stream: false, maxSteps: 4 },
      provider: new ScriptedStreamingProvider([{ text: 'Nothing to stream here.' }]),
    });

    const result = await session.runTask('say something', (e) => events.push(e));
    assert.equal(events.filter((e) => e.type === 'assistant-delta').length, 0);
    const finals = events.filter((e): e is Extract<HarnessEvent, { type: 'assistant' }> => e.type === 'assistant');
    assert.equal(finals.length, 1);
    assert.equal(finals[0].streamed, false);
    assert.equal(finals[0].text, 'Nothing to stream here.');
    assert.equal(result.outcome, 'complete');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
