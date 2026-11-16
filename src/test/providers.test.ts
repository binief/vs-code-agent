import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { OpenAiCompatibleProvider } from '../core/providers/openai';
import { toAnthropicMessages, toOpenAiMessages } from '../core/providers';
import {
  assistantMessageToText,
  buildChatmlSystemPrompt,
  extractThinking,
  parseChatmlText,
  parseToolCallBlock,
  serializeToolCall,
  serializeToolResult,
  stripMarkers,
  toolResultToText,
} from '../core/providers/chatml';
import { MockPlannerProvider, parseIntent, scaffold } from '../core/providers/mock';
import type { ChatMessage, ToolSpec } from '../core/types';

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

/* -------------------------------------------------------- ChatML text protocol */

const chatmlTools: ToolSpec[] = [
  {
    name: 'read_file',
    description: 'Read a file’s contents.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'search_text',
    description: 'Search text across files.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
];

test('serializeToolCall produces the text protocol block', () => {
  const out = serializeToolCall({ id: 'call_1', name: 'read_file', arguments: '{"path":"app.ts"}' });
  assert.equal(out, '<|tool_call|>read_file|call_1|{"path":"app.ts"}<|/tool_call|>');
});

test('serializeToolResult produces ok and error blocks', () => {
  const ok = serializeToolResult('call_1', 'read_file', true, 'export const a = 1;');
  assert.equal(ok, '<|tool_result|>call_1|ok\nexport const a = 1;\n<|/tool_result|>');
  const err = serializeToolResult('call_2', 'read_file', false, 'File not found');
  assert.equal(err, '<|tool_result|>call_2|error\nFile not found\n<|/tool_result|>');
});

test('parseToolCallBlock extracts name, id and arguments', () => {
  const call = parseToolCallBlock('read_file|call_1|{"path":"app.ts"}');
  assert.ok(call);
  assert.equal(call!.name, 'read_file');
  assert.equal(call!.id, 'call_1');
  assert.equal(call!.arguments, '{"path":"app.ts"}');
});

test('parseToolCallBlock rejects malformed blocks', () => {
  assert.equal(parseToolCallBlock(''), null);
  assert.equal(parseToolCallBlock('no_pipes'), null);
  assert.equal(parseToolCallBlock('name|'), null);
  assert.equal(parseToolCallBlock('name||{}'), null);
});

test('parseChatmlText extracts tool calls and returns clean text', () => {
  const { text, toolCalls } = parseChatmlText(
    'I will read the file.<|tool_call|>read_file|call_1|{"path":"app.ts"}<|/tool_call|>Done.',
  );
  assert.equal(text, 'I will read the file.Done.');
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].name, 'read_file');
  assert.equal(toolCalls[0].id, 'call_1');
  assert.equal(toolCalls[0].arguments, '{"path":"app.ts"}');
});

test('parseChatmlText skips malformed tool-call blocks', () => {
  const { text, toolCalls } = parseChatmlText(
    'Hello <|tool_call|>broken<|/tool_call|> world',
  );
  assert.equal(text, 'Hello  world');
  assert.equal(toolCalls.length, 0);
});

test('parseChatmlText handles multiple tool calls', () => {
  const { text, toolCalls } = parseChatmlText(
    '<|tool_call|>read_file|call_1|{"path":"a.ts"}<|/tool_call|><|tool_call|>search_text|call_2|{"query":"foo"}<|/tool_call|>',
  );
  assert.equal(text, '');
  assert.equal(toolCalls.length, 2);
  assert.equal(toolCalls[0].name, 'read_file');
  assert.equal(toolCalls[1].name, 'search_text');
});

test('stripMarkers removes all protocol markers', () => {
  assert.equal(
    stripMarkers('Hello <|tool_call|>x|y|{}<|/tool_call|> world <|tool_result|>y|ok\nhi\n<|/tool_result|>'),
    'Hello x|y|{} world y|ok\nhi\n',
  );
});

test('buildChatmlSystemPrompt augments with tools and protocol', () => {
  const out = buildChatmlSystemPrompt('You are helpful.', chatmlTools);
  assert.ok(out.includes('You are helpful.'));
  assert.ok(out.includes('<|tool_call|>tool_name|call_id|{"arg": "value"}<|/tool_call|>'));
  assert.ok(out.includes('read_file'));
  assert.ok(out.includes('search_text'));
  assert.ok(out.includes('Do not output protocol markers in your final answer to the user.'));
});

test('assistantMessageToText serializes tool calls as protocol blocks', () => {
  const out = assistantMessageToText({
    content: 'Reading the file now.',
    toolCalls: [{ id: 'call_1', name: 'read_file', arguments: '{"path":"app.ts"}' }],
  });
  assert.ok(out.includes('Reading the file now.'));
  assert.ok(out.includes('<|tool_call|>read_file|call_1|{"path":"app.ts"}<|/tool_call|>'));
});

test('toolResultToText produces a result block', () => {
  const out = toolResultToText('call_1', 'read_file', 'export const a = 1;', true);
  assert.equal(out, '<|tool_result|>call_1|ok\nexport const a = 1;\n<|/tool_result|>');
});

/* --------------------------------------------- OpenAI provider text tool mode */

/** Build a stub fetch that returns a non-streaming JSON response. */
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  });
}

test('OpenAI text mode omits structured tools from the request body', async () => {
  let sentBody: string | undefined;
  const stub = (async (_input: any, init?: any) => {
    sentBody = init?.body as string;
    return jsonResponse({
      choices: [{ message: { content: 'Hello!' }, finish_reason: 'stop' }],
    });
  }) as unknown as typeof fetch;
  const realFetch = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    const provider = new OpenAiCompatibleProvider({
      apiKey: 'test-key',
      baseUrl: 'https://example.test/v1',
      textToolMode: true,
    });
    await provider.chat({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'hi' },
      ],
      tools: [{ name: 'read_file', description: 'read', parameters: { type: 'object' } }],
    });
    assert.ok(sentBody);
    const parsed = JSON.parse(sentBody!);
    assert.equal(parsed.tools, undefined);
    assert.equal(parsed.tool_choice, undefined);
    assert.equal(parsed.parallel_tool_calls, undefined);
    // The system message must have been augmented with tool definitions.
    const sysMsg = parsed.messages.find((m: any) => m.role === 'system');
    assert.ok(sysMsg);
    assert.ok(sysMsg.content.includes('<|tool_call|>'));
    assert.ok(sysMsg.content.includes('read_file'));
    assert.ok(sysMsg.content.includes('You are a helpful assistant.'));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('OpenAI text mode parses tool calls from non-streaming response', async () => {
  const stub = (async () => {
    return jsonResponse({
      choices: [{
        message: {
          content: 'Reading it.<|tool_call|>read_file|call_1|{"path":"app.ts"}<|/tool_call|>',
        },
        finish_reason: 'tool_calls',
      }],
    });
  }) as unknown as typeof fetch;
  const realFetch = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    const provider = new OpenAiCompatibleProvider({
      apiKey: 'test-key',
      baseUrl: 'https://example.test/v1',
      textToolMode: true,
    });
    const response = await provider.chat({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'read app.ts' }],
      tools: [{ name: 'read_file', description: 'read', parameters: { type: 'object' } }],
    });
    assert.equal(response.toolCalls.length, 1);
    assert.equal(response.toolCalls[0].name, 'read_file');
    assert.equal(response.toolCalls[0].id, 'call_1');
    assert.equal(response.toolCalls[0].arguments, '{"path":"app.ts"}');
    // Markers stripped from user-facing text.
    assert.equal(response.text, 'Reading it.');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('OpenAI text mode strips markers from user-facing text', async () => {
  const stub = (async () => {
    return jsonResponse({
      choices: [{
        message: {
          content: 'Here is the file.<|tool_call|>read_file|call_1|{"path":"app.ts"}<|/tool_call|>',
        },
        finish_reason: 'stop',
      }],
    });
  }) as unknown as typeof fetch;
  const realFetch = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    const provider = new OpenAiCompatibleProvider({
      apiKey: 'test-key',
      baseUrl: 'https://example.test/v1',
      textToolMode: true,
    });
    const response = await provider.chat({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'read_file', description: 'read', parameters: { type: 'object' } }],
    });
    assert.equal(response.text, 'Here is the file.');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('OpenAI text mode ignores malformed tool calls (never executes them)', async () => {
  const stub = (async () => {
    return jsonResponse({
      choices: [{
        message: {
          content: 'I tried <|tool_call|>broken<|/tool_call|> but it failed.',
        },
        finish_reason: 'stop',
      }],
    });
  }) as unknown as typeof fetch;
  const realFetch = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    const provider = new OpenAiCompatibleProvider({
      apiKey: 'test-key',
      baseUrl: 'https://example.test/v1',
      textToolMode: true,
    });
    const response = await provider.chat({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'do something' }],
      tools: [{ name: 'read_file', description: 'read', parameters: { type: 'object' } }],
    });
    assert.equal(response.toolCalls.length, 0);
    // Malformed block text remains as plain text (not leaked as markers).
    assert.ok(response.text.includes('I tried'));
    assert.ok(response.text.includes('but it failed'));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('OpenAI text mode streaming parses split markers', async () => {
  const encoder = new TextEncoder();
  const events = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'I will ' } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: '<|tool_c' } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'all|>read_file|call_1|{\"path\":\"a.ts\"}' } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: '<|/tool_call|> done.' } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ finish_reason: 'stop' }] })}\n\n`,
    'data: [DONE]\n\n',
  ];
  const payload = encoder.encode(events.join(''));
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < payload.length; i += 5) chunks.push(payload.slice(i, i + 5));

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  const res = new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });

  const stub = (async () => res) as unknown as typeof fetch;
  const realFetch = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    const provider = new OpenAiCompatibleProvider({
      apiKey: 'test-key',
      baseUrl: 'https://example.test/v1',
      textToolMode: true,
    });
    const deltas: string[] = [];
    const response = await provider.chat({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'read a.ts' }],
      tools: [{ name: 'read_file', description: 'read', parameters: { type: 'object' } }],
      onDelta: (text) => deltas.push(text),
    });
    assert.equal(response.toolCalls.length, 1);
    assert.equal(response.toolCalls[0].name, 'read_file');
    assert.equal(response.toolCalls[0].id, 'call_1');
    // Raw markers never appear in deltas.
    assert.ok(!deltas.some((d) => d.includes('<|tool_call|>')));
    assert.ok(!deltas.some((d) => d.includes('<|/tool_call|>')));
    assert.equal(deltas.join(''), 'I will  done.');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('OpenAI text mode streaming routes thinking blocks to thinking lane', async () => {
  const encoder = new TextEncoder();
  const events = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'I will ' } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: '<|thinking|>' } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'planning' } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: '<|/thinking|> done.' } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ finish_reason: 'stop' }] })}\n\n`,
    'data: [DONE]\n\n',
  ];
  const payload = encoder.encode(events.join(''));
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < payload.length; i += 5) chunks.push(payload.slice(i, i + 5));

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  const res = new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });

  const stub = (async () => res) as unknown as typeof fetch;
  const realFetch = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    const provider = new OpenAiCompatibleProvider({
      apiKey: 'test-key',
      baseUrl: 'https://example.test/v1',
      textToolMode: true,
    });
    const deltas: string[] = [];
    const thoughts: string[] = [];
    const response = await provider.chat({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'read a.ts' }],
      tools: [{ name: 'read_file', description: 'read', parameters: { type: 'object' } }],
      onDelta: (text) => deltas.push(text),
      onThinking: (text) => thoughts.push(text),
    });
    // Thinking is routed to the thinking lane, not visible text.
    assert.equal(response.text, 'I will  done.');
    assert.equal(response.thinking, 'planning');
    // Raw thinking markers never appear in deltas.
    assert.ok(!deltas.some((d) => d.includes('<|thinking|>')));
    assert.ok(!deltas.some((d) => d.includes('<|/thinking|>')));
    assert.equal(deltas.join(''), 'I will  done.');
    assert.equal(thoughts.join(''), 'planning');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('OpenAI text mode no-tools requests remain normal (e.g. compaction)', async () => {
  let sentBody: string | undefined;
  const stub = (async (_input: any, init?: any) => {
    sentBody = init?.body as string;
    return jsonResponse({
      choices: [{ message: { content: 'Summary.' }, finish_reason: 'stop' }],
    });
  }) as unknown as typeof fetch;
  const realFetch = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    const provider = new OpenAiCompatibleProvider({
      apiKey: 'test-key',
      baseUrl: 'https://example.test/v1',
      textToolMode: true,
    });
    await provider.chat({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'summarize' }],
      tools: [],
    });
    assert.ok(sentBody);
    const parsed = JSON.parse(sentBody!);
    assert.equal(parsed.tools, undefined);
    // No system message augmentation when there are no tools.
    const sysMsg = parsed.messages.find((m: any) => m.role === 'system');
    assert.ok(!sysMsg || !sysMsg.content.includes('<|tool_call|>'));
  } finally {
    globalThis.fetch = realFetch;
  }
});

/* ------------------------------------------------ extractThinking */

test('extractThinking extracts thinking blocks and returns clean text', () => {
  const { text, thinking } = extractThinking(
    'Here is my answer.<|thinking|>I need to think about this.<|/thinking|>Done.',
  );
  assert.equal(text, 'Here is my answer.Done.');
  assert.equal(thinking, 'I need to think about this.');
});

test('extractThinking handles multiple thinking blocks', () => {
  const { text, thinking } = extractThinking(
    '<|thinking|>first thought<|/thinking|>middle<|thinking|>second thought<|/thinking|>end',
  );
  assert.equal(text, 'middleend');
  assert.equal(thinking, 'first thoughtsecond thought');
});

test('extractThinking returns empty for no thinking blocks', () => {
  const { text, thinking } = extractThinking('Just plain text.');
  assert.equal(text, 'Just plain text.');
  assert.equal(thinking, '');
});

test('extractThinking handles empty input', () => {
  const { text, thinking } = extractThinking('');
  assert.equal(text, '');
  assert.equal(thinking, '');
});

test('extractThinking leaves incomplete thinking blocks in place', () => {
  const { text, thinking } = extractThinking(
    'Hello <|thinking|>incomplete thought',
  );
  assert.equal(text, 'Hello <|thinking|>incomplete thought');
  assert.equal(thinking, '');
});

test('extractThinking strips thinking markers but keeps text between blocks', () => {
  const { text, thinking } = extractThinking(
    'A<|thinking|>think<|/thinking|>B<|thinking|>think2<|/thinking|>C',
  );
  assert.equal(text, 'ABC');
  assert.equal(thinking, 'thinkthink2');
});
