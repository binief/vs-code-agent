import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { HarnessSession } from '../core/agent';
import { isTranscriptWellFormed } from '../core/transcript';
import { ToolRegistry } from '../core/tools';
import { DEFAULT_CONFIG, resolveConfig, type ChatMessage, type ChatRequest, type HarnessEvent, type HarnessHost, type Provider } from '../core/types';

function workspace(tools: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-subagent-'));
  fs.writeFileSync(path.join(dir, 'agent.md'), `---\ntools: [${tools}]\n---\nProject instructions.\n`);
  fs.writeFileSync(path.join(dir, 'secret.txt'), 'Evidence from the file.\n');
  return dir;
}
class Host implements HarnessHost {
  constructor(readonly workspaceRoot: string) {}
  log(): void {}
  async requestApproval(): Promise<'apply'> { return 'apply'; }
}
const config = (enabled: boolean) => ({ ...DEFAULT_CONFIG, subagentsEnabled: enabled, stream: false,
  compaction: { ...DEFAULT_CONFIG.compaction, enabled: false } });
const delegation = (task = 'Inspect the file') => ({ id: 'delegate-1', name: 'delegate_task', arguments: JSON.stringify({ task, context: 'Check secret.txt only.' }) });
const isChild = (req: ChatRequest) => req.messages.some(m => m.role === 'user' && m.content.startsWith('Delegated task:'));

test('subagent setting defaults off and cannot bypass the selected agent policy', async () => {
  assert.equal(resolveConfig(undefined).subagentsEnabled, false);
  for (const [enabled, tools] of [[false, 'read, subagent'], [true, 'read'], [true, ''], [false, 'read, delegate_task']] as const) {
    const dir = workspace(tools);
    try {
      const requests: ChatRequest[] = [];
      const provider: Provider = { id: 'test', label: 'test', async chat(req) {
        requests.push(req);
        return requests.length === 1 ? { text: '', toolCalls: [delegation()] } : { text: 'Finished.', toolCalls: [] };
      } };
      const session = new HarnessSession({ host: new Host(dir), config: config(enabled), provider });
      const result = await session.runTask('Check.', () => {});
      assert.equal(result.outcome, 'complete');
      assert.equal(requests.length, 2);
      assert.ok(requests.every(req => !req.tools.some(t => t.name === 'delegate_task')));
      assert.match(session.transcript.find(m => m.role === 'tool')?.content ?? '', /not allowed/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test('a separate read-only child passes back only findings, with usage and denied calls reported', async () => {
  const dir = workspace('read, search, edit, execute, mcp, subagent');
  try {
    const requests: ChatRequest[] = [];
    let childTurns = 0;
    let mainTurns = 0;
    const provider: Provider = { id: 'test', label: 'test', async chat(req) {
      requests.push(req);
      if (isChild(req)) {
        childTurns++;
        assert.ok(!JSON.stringify(req.messages).includes('PARENT_PRIVATE_HISTORY'));
        assert.deepEqual(req.tools.map(t => t.name), ['list_files', 'read_file', 'search_text', 'get_diagnostics']);
        if (childTurns === 1) return { text: '', toolCalls: [
          { id: 'read', name: 'read_file', arguments: '{"path":"secret.txt"}' },
          { id: 'write', name: 'write_file', arguments: '{"path":"secret.txt","content":"modified"}' },
          { id: 'mcp', name: 'mcp_server_write', arguments: '{}' },
          { id: 'nested', name: 'delegate_task', arguments: '{"task":"nested"}' },
        ], usage: { inputTokens: 10, outputTokens: 2 } };
        assert.ok(req.messages.some(m => m.role === 'tool' && m.content.includes('Evidence from the file.')));
        assert.equal(req.messages.filter(m => m.role === 'tool' && m.content.includes('not allowed')).length, 3);
        return { text: 'secret.txt:1 contains evidence. No other files checked.', toolCalls: [], usage: { inputTokens: 11, outputTokens: 3 } };
      }
      mainTurns++;
      if (mainTurns === 1) {
        assert.ok(req.tools.some(t => t.name === 'delegate_task'));
        return { text: '', toolCalls: [delegation()], usage: { inputTokens: 1, outputTokens: 1 } };
      }
      const handoff = req.messages.find(m => m.role === 'tool' && m.name === 'delegate_task');
      assert.match(handoff?.content ?? '', /unverified handoff/);
      assert.match(handoff?.content ?? '', /secret.txt:1 contains evidence/);
      assert.match(handoff?.content ?? '', /failed tools/);
      assert.ok(!req.messages.some(m => m.role === 'tool' && m.name === 'read_file'));
      return { text: 'Main agent finished.', toolCalls: [], usage: { inputTokens: 2, outputTokens: 2 } };
    } };
    const session = new HarnessSession({ host: new Host(dir), config: config(true), provider });
    session.restoreConversation([{ role: 'user', content: 'PARENT_PRIVATE_HISTORY' }]);
    const events: HarnessEvent[] = [];
    const result = await session.runTask('Investigate.', e => events.push(e));
    assert.equal(result.outcome, 'complete');
    assert.equal(result.usage.inputTokens, 24);
    assert.equal(result.usage.outputTokens, 8);
    assert.equal(fs.readFileSync(path.join(dir, 'secret.txt'), 'utf8'), 'Evidence from the file.\n');
    assert.ok(events.some(e => e.type === 'tool-end' && e.name === 'delegate_task' && e.summary.includes('warnings')));
    assert.ok(events.some(e => e.type === 'subagent-progress' && e.step === 1));
    assert.ok(events.some(e => e.type === 'subagent-progress' && e.tool === 'read_file'));
    assert.ok(isTranscriptWellFormed([...session.transcript]));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('failed child is not presented as a successful result', async () => {
  const dir = workspace('read, delegate_task');
  try {
    let mainTurns = 0;
    const provider: Provider = { id: 'test', label: 'test', async chat(req) {
      if (isChild(req)) throw new Error('child model unavailable');
      return ++mainTurns === 1 ? { text: '', toolCalls: [delegation()] } : { text: 'Could not investigate.', toolCalls: [] };
    } };
    const session = new HarnessSession({ host: new Host(dir), config: config(true), provider });
    const events: HarnessEvent[] = [];
    await session.runTask('Inspect.', e => events.push(e));
    assert.ok(events.some(e => e.type === 'tool-end' && e.name === 'delegate_task' && !e.ok));
    assert.match(session.transcript.find(m => m.role === 'tool' && m.name === 'delegate_task')?.content ?? '', /Subagent error.*child model unavailable/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('cancelling the parent aborts a running child and leaves a paired transcript', async () => {
  const dir = workspace('read, subagent');
  try {
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let aborted = false;
    const provider: Provider = { id: 'test', label: 'test', async chat(req) {
      if (!isChild(req)) return { text: '', toolCalls: [delegation()] };
      entered();
      await new Promise<void>(resolve => {
        if (req.signal?.aborted) { aborted = true; resolve(); return; }
        req.signal?.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true });
      });
      throw new Error('aborted');
    } };
    const session = new HarnessSession({ host: new Host(dir), config: config(true), provider });
    const run = session.runTask('Inspect.', () => {});
    await started;
    session.cancel();
    const result = await run;
    assert.equal(result.outcome, 'cancelled');
    assert.equal(aborted, true);
    assert.ok(isTranscriptWellFormed([...session.transcript]));
    assert.match(session.transcript.find(m => m.role === 'tool')?.content ?? '', /cancelled/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('multiple selected agent policies must all permit delegation', async () => {
  const dir = workspace('read, subagent');
  try {
    fs.mkdirSync(path.join(dir, '.agents'));
    fs.writeFileSync(path.join(dir, '.agents', 'review.md'), '---\ntools: [read]\n---\nReview.');
    const seen: ChatMessage[][] = [];
    const provider: Provider = { id: 'test', label: 'test', async chat(req) {
      assert.ok(!req.tools.some(t => t.name === 'delegate_task'));
      seen.push(req.messages);
      return seen.length === 1 ? { text: '', toolCalls: [delegation()] } : { text: 'Done.', toolCalls: [] };
    } };
    const session = new HarnessSession({ host: new Host(dir), config: config(true), provider });
    await session.runTask('Inspect.', () => {});
    assert.match(session.transcript.find(m => m.role === 'tool')?.content ?? '', /not allowed/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('delegation without explicitly permitted read tools fails before starting a child', async () => {
  const dir = workspace('subagent');
  try {
    let turns = 0;
    const provider: Provider = { id: 'test', label: 'test', async chat(req) {
      assert.ok(!isChild(req));
      return ++turns === 1 ? { text: '', toolCalls: [delegation()] } : { text: 'No read permission.', toolCalls: [] };
    } };
    const session = new HarnessSession({ host: new Host(dir), config: config(true), provider });
    await session.runTask('Inspect.', () => {});
    assert.equal(turns, 2);
    assert.match(session.transcript.find(m => m.role === 'tool')?.content ?? '', /No read-only built-in tools/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('incomplete child output is returned in full across continuation turns', async () => {
  const dir = workspace('read, subagent');
  try {
    let mainTurn = 0;
    let childTurn = 0;
    const provider: Provider = { id: 'test', label: 'test', async chat(req) {
      if (isChild(req)) return ++childTurn === 1
        ? { text: 'First finding.', toolCalls: [], finishReason: 'length' }
        : { text: 'Second finding.', toolCalls: [], finishReason: 'stop' };
      return ++mainTurn === 1 ? { text: '', toolCalls: [delegation()] } : { text: 'Done.', toolCalls: [] };
    } };
    const session = new HarnessSession({ host: new Host(dir), config: config(true), provider });
    await session.runTask('Investigate.', () => {});
    const handoff = session.transcript.find(m => m.role === 'tool' && m.name === 'delegate_task')?.content ?? '';
    assert.match(handoff, /First finding\.[\s\S]*Second finding\./);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});


test('a custom tool cannot impersonate a read-only builtin in a child', async () => {
  const dir = workspace('read_file, subagent');
  try {
    let executed = false;
    let turns = 0;
    const registry = new ToolRegistry([{ name: 'read_file', description: 'custom', parameters: { type: 'object' },
      async run() { executed = true; return { ok: true, content: 'unsafe' }; } }]);
    const provider: Provider = { id: 'test', label: 'test', async chat(req) {
      assert.ok(!isChild(req));
      return ++turns === 1 ? { text: '', toolCalls: [delegation()] } : { text: 'No safe read tool.', toolCalls: [] };
    } };
    const session = new HarnessSession({ host: new Host(dir), config: config(true), provider, registry });
    await session.runTask('Inspect.', () => {});
    assert.equal(executed, false);
    assert.match(session.transcript.find(m => m.role === 'tool')?.content ?? '', /No read-only built-in tools/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('enabled mode automatically runs a separate child before every parent task', async () => {
  const dir = workspace('read, search, subagent');
  try {
    const calls: Array<{ child: boolean; request: ChatRequest }> = [];
    const provider: Provider = { id: 'test', label: 'test', async chat(req) {
      const child = isChild(req);
      calls.push({ child, request: JSON.parse(JSON.stringify({ ...req, signal: undefined })) });
      return child
        ? { text: 'Evidence: secret.txt has a verified line.', toolCalls: [], usage: { inputTokens: 10, outputTokens: 2 } }
        : { text: 'Parent response.', toolCalls: [], usage: { inputTokens: 5, outputTokens: 1 } };
    } };
    const session = new HarnessSession({ host: new Host(dir), config: config(true), provider });
    session.restoreConversation([{ role: 'user', content: 'PRIVATE_OLD_PARENT_HISTORY' }]);
    const events: HarnessEvent[] = [];
    await session.runTask('First task UNIQUE_TASK_TEXT', e => events.push(e));
    await session.runTask('Hello', e => events.push(e));
    assert.deepEqual(calls.map(c => c.child), [true, false, true, false]);
    assert.ok(calls[0].request.messages.some(m => m.content.includes('First task UNIQUE_TASK_TEXT')));
    assert.ok(calls[2].request.messages.some(m => m.content.includes('Hello')));
    assert.ok(!JSON.stringify(calls[0].request.messages).includes('PRIVATE_OLD_PARENT_HISTORY'));
    assert.ok(calls[1].request.messages.some(m => m.role === 'tool' && m.name === 'delegate_task' && m.content.includes('Evidence: secret.txt')));
    assert.ok(calls[0].request.tools.every(t => ['list_files', 'read_file', 'search_text', 'get_diagnostics'].includes(t.name)));
    assert.ok(events.some(e => e.type === 'notice' && e.message.includes('automatic read-only subagent')));
    assert.equal(events.filter(e => e.type === 'tool-start' && e.name === 'delegate_task').length, 2);
    assert.equal(events.filter(e => e.type === 'subagent-progress' && e.step === 1).length, 2);
    const synthetic = session.transcript.filter(m => m.role === 'assistant').flatMap(m => m.toolCalls ?? []).filter(call => call.id.startsWith('auto-subagent-'));
    assert.equal(synthetic.length, 2);
    assert.notEqual(synthetic[0].id, synthetic[1].id);
    assert.ok(!synthetic[0].arguments.includes('UNIQUE_TASK_TEXT'), 'the original prompt must not be repeated in tool arguments');
    assert.ok(isTranscriptWellFormed([...session.transcript]));
    assert.equal(session.usage.inputTokens, 30);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('automatic delegation respects disabled and missing policy permissions and warns before fallback', async () => {
  for (const [enabled, tools, warning] of [[false, 'read, subagent', false], [true, 'read', true], [true, 'subagent', true], [true, '', true]] as const) {
    const dir = workspace(tools);
    try {
      const seen: ChatRequest[] = [];
      const events: HarnessEvent[] = [];
      const provider: Provider = { id: 'test', label: 'test', async chat(req) { seen.push(req); return { text: 'Main response.', toolCalls: [] }; } };
      const session = new HarnessSession({ host: new Host(dir), config: config(enabled), provider });
      const result = await session.runTask('Hello', e => events.push(e));
      assert.equal(result.outcome, 'complete');
      assert.equal(seen.length, 1);
      assert.ok(!isChild(seen[0]));
      assert.equal(events.some(e => e.type === 'notice' && e.level === 'warn' && e.message.includes('Automatic subagent')), warning);
      assert.ok(isTranscriptWellFormed([...session.transcript]));
      assert.equal(seen[0].tools.some(t => t.name === 'delegate_task'), enabled && tools === 'subagent');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test('automatic child failure warns and still allows the main agent to answer', async () => {
  const dir = workspace('read, subagent');
  try {
    const seen: boolean[] = [];
    const events: HarnessEvent[] = [];
    const provider: Provider = { id: 'test', label: 'test', async chat(req) {
      const child = isChild(req); seen.push(child);
      if (child) throw new Error('model unavailable');
      return { text: 'Continuing without findings.', toolCalls: [] };
    } };
    const session = new HarnessSession({ host: new Host(dir), config: config(true), provider });
    const result = await session.runTask('Inspect', e => events.push(e));
    assert.equal(result.outcome, 'complete');
    assert.deepEqual(seen, [true, false]);
    assert.ok(events.some(e => e.type === 'notice' && e.level === 'warn' && e.message.includes('Continuing with the main agent')));
    assert.ok(events.some(e => e.type === 'tool-end' && e.name === 'delegate_task' && !e.ok));
    assert.ok(session.transcript.some(m => m.role === 'tool' && /Subagent error.*model unavailable/.test(m.content)));
    assert.ok(isTranscriptWellFormed([...session.transcript]));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('automatic child omits images and cancellation prevents the parent model call', async () => {
  const dir = workspace('read, subagent');
  try {
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const calls: ChatRequest[] = [];
    let aborted = false;
    const provider: Provider = { id: 'test', label: 'test', async chat(req) {
      calls.push(req);
      entered();
      await new Promise<void>(resolve => req.signal?.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }));
      throw new Error('cancelled');
    } };
    const session = new HarnessSession({ host: new Host(dir), config: config(true), provider });
    const run = session.runTask('What is this?', () => {}, { images: [{ mediaType: 'image/png', data: 'c2VjcmV0' }] });
    await started;
    session.cancel();
    const result = await run;
    assert.equal(result.outcome, 'cancelled');
    assert.equal(aborted, true);
    assert.equal(calls.length, 1);
    assert.ok(isChild(calls[0]));
    assert.ok(calls[0].messages.some(m => m.content.includes('images, but they are not available')));
    assert.ok(!JSON.stringify(calls[0].messages).includes('c2VjcmV0'));
    assert.ok(isTranscriptWellFormed([...session.transcript]));
    assert.match(session.transcript.find(m => m.role === 'tool')?.content ?? '', /cancelled/i);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('automatic delegation obeys intersected tool policies and keeps recovery snapshots valid', async () => {
  const dir = workspace('read, subagent');
  try {
    fs.mkdirSync(path.join(dir, '.agents'));
    fs.writeFileSync(path.join(dir, '.agents', 'restricted.md'), '---\ntools: [read]\n---\nReview.');
    const calls: ChatRequest[] = [];
    const events: HarnessEvent[] = [];
    const provider: Provider = { id: 'test', label: 'test', async chat(req) { calls.push(req); return { text: 'Main answer.', toolCalls: [] }; } };
    const session = new HarnessSession({ host: new Host(dir), config: config(true), provider });
    const result = await session.runTask('Inspect', e => events.push(e));
    assert.equal(result.outcome, 'complete');
    assert.equal(calls.length, 1);
    assert.equal(isChild(calls[0]), false);
    assert.ok(events.some(e => e.type === 'notice' && e.level === 'warn' && e.message.includes('do not permit delegation')));
    assert.ok(!calls[0].tools.some(t => t.name === 'delegate_task'));
    assert.ok(isTranscriptWellFormed(session.conversationSnapshot));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('in-flight automatic child preserves a provider-safe conversation snapshot', async () => {
  const dir = workspace('read, subagent');
  try {
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const provider: Provider = { id: 'test', label: 'test', async chat(req) {
      if (isChild(req)) { entered(); await gate; return { text: 'Child findings.', toolCalls: [] }; }
      return { text: 'Parent.', toolCalls: [] };
    } };
    const session = new HarnessSession({ host: new Host(dir), config: config(true), provider });
    const run = session.runTask('Investigate', () => {});
    await started;
    const snapshot = session.conversationSnapshot;
    assert.ok(isTranscriptWellFormed(snapshot));
    assert.ok(snapshot.some(m => m.role === 'user' && m.content === 'Investigate'));
    assert.ok(!snapshot.some(m => m.role === 'assistant' && m.toolCalls?.length));
    release();
    await run;
    assert.ok(isTranscriptWellFormed(session.conversationSnapshot));
    assert.ok(session.conversationSnapshot.some(m => m.role === 'tool' && m.content.includes('Child findings.')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('automatic and requested children forward streams and tools without leaking their transcript to the parent', async () => {
  const dir = workspace('read, subagent');
  try {
    let childRuns = 0;
    let mainTurns = 0;
    const events: HarnessEvent[] = [];
    const provider: Provider = { id: 'test', label: 'test', async chat(req) {
      if (isChild(req)) {
        const toolResults = req.messages.filter(m => m.role === 'tool');
        if (!toolResults.length) {
          childRuns++;
          req.onThinking?.('PRIVATE THINKING');
          req.onDelta?.('PRIVATE INTERMEDIATE');
          return { text: 'PRIVATE INTERMEDIATE', toolCalls: [{ id: 'same-tool', name: 'read_file', arguments: '{"path":"secret.txt"}' },
            { id: 'denied', name: 'write_file', arguments: '{}' }] };
        }
        req.onDelta?.('Public findings');
        return { text: 'Public findings', toolCalls: [] };
      }
      assert.ok(!JSON.stringify(req.messages).includes('PRIVATE INTERMEDIATE'));
      assert.ok(!JSON.stringify(req.messages).includes('PRIVATE THINKING'));
      assert.ok(!req.messages.some(m => m.role === 'tool' && m.name === 'read_file'));
      return ++mainTurns === 1 ? { text: '', toolCalls: [delegation()] } : { text: 'Parent answer', toolCalls: [] };
    } };
    const session = new HarnessSession({ host: new Host(dir), config: { ...config(true), stream: true, showThinking: true }, provider });
    await session.runTask('Inspect', e => events.push(e));
    assert.equal(childRuns, 2);
    const child = events.filter(e => e.type === 'subagent-event');
    assert.equal(new Set(child.map(e => e.delegation)).size, 2);
    assert.ok(child.some(e => e.event.type === 'assistant-delta' && e.event.text.includes('PRIVATE')));
    assert.ok(child.some(e => e.event.type === 'thinking-delta' && e.event.text.includes('PRIVATE')));
    assert.equal(child.filter(e => e.event.type === 'tool-start' && e.event.name === 'read_file').length, 2);
    assert.ok(child.some(e => e.event.type === 'tool-end' && e.event.name === 'read_file' && e.event.ok && e.event.detail.includes('Evidence')));
    assert.ok(child.some(e => e.event.type === 'tool-end' && e.event.name === 'write_file' && !e.event.ok));
    assert.ok(!JSON.stringify(session.transcript).includes('PRIVATE INTERMEDIATE'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('cancelling a child after it streams prevents the parent model call', async () => {
  const dir = workspace('read, subagent');
  try {
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let calls = 0;
    const events: HarnessEvent[] = [];
    const provider: Provider = { id: 'test', label: 'test', async chat(req) {
      calls++;
      assert.ok(isChild(req));
      req.onDelta?.('partial child response');
      entered();
      await new Promise<void>(resolve => req.signal?.addEventListener('abort', () => resolve(), { once: true }));
      throw new Error('cancelled');
    } };
    const session = new HarnessSession({ host: new Host(dir), config: { ...config(true), stream: true }, provider });
    const run = session.runTask('Inspect', e => events.push(e));
    await started;
    session.cancel();
    assert.equal((await run).outcome, 'cancelled');
    assert.equal(calls, 1);
    assert.ok(events.some(e => e.type === 'subagent-event' && e.event.type === 'assistant-delta' && e.event.text === 'partial child response'));
    assert.ok(!JSON.stringify(session.conversationSnapshot).includes('partial child response'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
