import * as assert from 'node:assert/strict';
import * as Module from 'node:module';
import { after, test } from 'node:test';
import type { ChatRequest } from '../core/types';

class TextPart { constructor(readonly value: string) {} }
class CallPart { constructor(readonly callId: string, readonly name: string, readonly input: object) {} }
class ResultPart { constructor(readonly callId: string, readonly content: unknown[]) {} }
class DataPart {
  constructor(readonly data: Uint8Array, readonly mimeType: string) {}
  static image(data: Uint8Array, mime: string) { return new DataPart(data, mime); }
}
class Message {
  static User(content: string | unknown[]) { return new Message(1, typeof content === 'string' ? [new TextPart(content)] : content); }
  static Assistant(content: string | unknown[]) { return new Message(2, typeof content === 'string' ? [new TextPart(content)] : content); }
  constructor(readonly role: number, readonly content: unknown[]) {}
}
class CancellationSource {
  token = { isCancellationRequested: false };
  cancel() { this.token.isCancellationRequested = true; }
  dispose() {}
}
let select: (selector: unknown) => Promise<any[]> = async () => [];
const stub = {
  lm: { selectChatModels: (selector: unknown) => select(selector) },
  LanguageModelChatMessage: Message, LanguageModelChatMessageRole: { User: 1, Assistant: 2 },
  LanguageModelTextPart: TextPart, LanguageModelToolCallPart: CallPart, LanguageModelToolResultPart: ResultPart,
  LanguageModelDataPart: DataPart, CancellationTokenSource: CancellationSource,
};
const prototype = (Module as unknown as { prototype: { require: (id: string) => unknown } }).prototype;
const originalRequire = prototype.require;
prototype.require = function (this: unknown, id: string) { return id === 'vscode' ? stub : originalRequire.call(this, id); };
const { CopilotProvider, toCopilotMessages } = require('../vscode/copilotProvider') as typeof import('../vscode/copilotProvider');
after(() => { prototype.require = originalRequire; });

function request(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return { model: 'available-id', messages: [{ role: 'user', content: 'hello' }], tools: [], ...overrides };
}

test('Copilot converts instructions, images and tool history without losing call IDs', () => {
  const messages = toCopilotMessages([
    { role: 'system', content: 'Important policy' },
    { role: 'user', content: 'Look', images: [{ mediaType: 'image/png', data: 'YWJj' }] },
    { role: 'assistant', content: 'Checking', toolCalls: [{ id: 'c1', name: 'read', arguments: '{"path":"a"}' }, { id: 'c2', name: 'search', arguments: '{}' }] },
    { role: 'tool', toolCallId: 'c1', content: 'Result 1' },
    { role: 'tool', toolCallId: 'c2', content: 'Result 2' },
  ]) as unknown as Message[];
  assert.equal(messages[0].role, 1);
  assert.match((messages[0].content[0] as TextPart).value, /Important policy/);
  const image = messages[1].content[1] as DataPart;
  assert.equal(image.mimeType, 'image/png');
  assert.equal(Buffer.from(image.data).toString(), 'abc');
  const call = messages[2].content[1] as CallPart;
  assert.deepEqual([call.callId, call.name, call.input], ['c1', 'read', { path: 'a' }]);
  assert.deepEqual(messages[3].content.map((p) => (p as ResultPart).callId), ['c1', 'c2']);
});

test('Copilot streams text and tool calls using the chosen model and only supplied tools', async () => {
  const seen: any[] = [];
  const model = { id: 'available-id', vendor: 'copilot', async sendRequest(...args: any[]) {
    seen.push(args);
    return { stream: (async function* () { yield new TextPart('hello '); yield new TextPart('world'); yield new CallPart('id1', 'read', { path: 'a' }); })() };
  } };
  select = async (selector) => { assert.deepEqual(selector, { vendor: 'copilot', id: 'available-id' }); return [model]; };
  const fragments: string[] = [];
  const res = await new CopilotProvider().chat(request({ tools: [{ name: 'read', description: 'Read', parameters: { type: 'object' } }], onDelta: (part) => fragments.push(part), temperature: 0, maxTokens: 42 }));
  assert.deepEqual(fragments, ['hello ', 'world']);
  assert.equal(res.text, 'hello world');
  assert.deepEqual(res.toolCalls, [{ id: 'id1', name: 'read', arguments: '{"path":"a"}' }]);
  assert.deepEqual(seen[0][1].tools, [{ name: 'read', description: 'Read', inputSchema: { type: 'object' } }]);
  assert.equal(seen[0][1].modelOptions, undefined, 'unsupported temperature/output controls must not be fabricated');
  assert.equal(res.finishReason, undefined);
  assert.equal(res.usage, undefined);
});

test('Copilot model selection never falls back to another model or vendor', async () => {
  const provider = new CopilotProvider();
  select = async () => [{ id: 'other', vendor: 'copilot' }, { id: 'available-id', vendor: 'other' }];
  await assert.rejects(provider.chat(request()), /not currently available/);
  await assert.rejects(provider.chat(request({ model: '' })), /Select Copilot Model/);
});

test('Copilot cancellation reaches VS Code and stops stream callbacks', async () => {
  const abort = new AbortController();
  let token: any;
  select = async () => [{ id: 'available-id', vendor: 'copilot', async sendRequest(_messages: unknown, _options: unknown, suppliedToken: unknown) {
    token = suppliedToken;
    return { stream: (async function* () { yield new TextPart('one'); abort.abort(); yield new TextPart('ignored'); })() };
  } }];
  const fragments: string[] = [];
  await assert.rejects(new CopilotProvider().chat(request({ signal: abort.signal, onDelta: (text) => fragments.push(text) })), /cancel/i);
  assert.equal(token.isCancellationRequested, true);
  assert.deepEqual(fragments, ['one']);
});

test('Copilot surfaces consent and unavailable image support without discarding data', async () => {
  select = async () => [{ id: 'available-id', vendor: 'copilot', async sendRequest() { throw Object.assign(new Error('denied'), { code: 'NoPermissions' }); } }];
  await assert.rejects(new CopilotProvider().chat(request()), /denied Copilot model access/);
  const saved = stub.LanguageModelDataPart;
  try {
    (stub as any).LanguageModelDataPart = undefined;
    await assert.rejects(new CopilotProvider().chat(request({ messages: [{ role: 'user', content: '', images: [{ mediaType: 'image/png', data: 'YWJj' }] }] })), /Images with Copilot require/);
  } finally { stub.LanguageModelDataPart = saved; }
  assert.throws(() => toCopilotMessages([{ role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 'read', arguments: 'broken json' }] }]), /not valid JSON/);
});

test('Copilot runs the harness tool loop with agent-file policy enforced', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { HarnessSession } = await import('../core/agent');
  const { DEFAULT_CONFIG } = await import('../core/types');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-harness-'));
  try {
    fs.writeFileSync(path.join(root, 'agent.md'), '---\ntools: [read]\n---\nKeep findings grounded.\n');
    fs.writeFileSync(path.join(root, 'evidence.txt'), 'verified evidence');
    let calls = 0;
    select = async () => [{ id: 'available-id', vendor: 'copilot', async sendRequest(messages: Message[], options: any) {
      calls++;
      assert.ok(options.tools.some((tool: any) => tool.name === 'read_file'));
      assert.ok(!options.tools.some((tool: any) => tool.name === 'run_command'));
      if (calls === 1) return { stream: (async function* () { yield new CallPart('read-id', 'read_file', { path: 'evidence.txt' }); })() };
      const result = messages.flatMap((m) => m.content).find((part) => part instanceof ResultPart) as ResultPart;
      assert.equal(result.callId, 'read-id');
      assert.match((result.content[0] as TextPart).value, /verified evidence/);
      return { stream: (async function* () { yield new TextPart('Found evidence.'); })() };
    } }];
    const session = new HarnessSession({ host: { workspaceRoot: root, log() {}, async requestApproval() { return 'reject'; } },
      config: { ...DEFAULT_CONFIG, provider: 'copilot', model: 'available-id', mcp: { ...DEFAULT_CONFIG.mcp, enabled: false } }, provider: new CopilotProvider() });
    const result = await session.runTask('Read evidence.txt', () => {});
    assert.equal(result.outcome, 'complete');
    assert.equal(result.summary, 'Found evidence.');
    assert.equal(calls, 2);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Stop interrupts Copilot model lookup even if VS Code has not returned models', async () => {
  const abort = new AbortController();
  select = async () => new Promise(() => {});
  const pending = new CopilotProvider().chat(request({ signal: abort.signal }));
  abort.abort();
  await assert.rejects(pending, /cancel/i);
});
