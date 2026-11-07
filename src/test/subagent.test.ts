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
