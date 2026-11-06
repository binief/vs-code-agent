import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { HarnessSession } from '../core/agent';
import { ToolRegistry } from '../core/tools';
import { DEFAULT_CONFIG, type ChatMessage, type ChatRequest, type HarnessHost, type Provider, type Tool } from '../core/types';

class Host implements HarnessHost {
  constructor(readonly workspaceRoot: string) {}
  log(): void {}
  async requestApproval(): Promise<'apply'> { return 'apply'; }
}
function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-archive-')); }
const config = { ...DEFAULT_CONFIG, stream: false, maxSteps: 10, maxOutputTokens: 256, compaction: { ...DEFAULT_CONFIG.compaction, autoCompact: false } };
const compacted: ChatMessage[] = [{ role: 'user', content: '[Conversation compacted: summary only]' }, { role: 'assistant', content: 'Done.' }];

test('retrieval searches original tool arguments literally, pages exact Unicode text, and never sends the archive automatically', async () => {
  const dir = tmp();
  try {
    const long = '😀'.repeat(1600) + ' visible ending';
    const original: ChatMessage[] = [
      { role: 'user', content: long },
      { role: 'assistant', content: 'Looked.', toolCalls: [{ id: 'old', name: 'read_file', arguments: '{"path":"MISSING.*[x]"}' }] },
      { role: 'tool', toolCallId: 'old', name: 'read_file', content: 'file result' },
      { role: 'assistant', content: 'Earlier answer.' },
    ];
    const requests: ChatRequest[] = [];
    let page1 = '';
    const provider: Provider = { id: 'fake', label: 'fake', async chat(req) {
      requests.push(req);
      const n = requests.length;
      if (n === 1) {
        assert.ok(!req.messages.some((m) => m.content === long), 'original data stays outside the model context');
        assert.ok(req.tools.some((t) => t.name === 'search_conversation'));
        assert.ok(req.tools.some((t) => t.name === 'read_conversation'));
        return { text: '', toolCalls: [{ id: 's', name: 'search_conversation', arguments: JSON.stringify({ query: 'missing.*[X]' }) }] };
      }
      if (n === 2) {
        const result = req.messages.at(-1)?.content ?? '';
        assert.match(result, /message_index=2 role=assistant/);
        assert.match(result, /MISSING\.\*\[x\]/);
        return { text: '', toolCalls: [{ id: 'a', name: 'read_conversation', arguments: '{"message_index":2}' }] };
      }
      if (n === 3) {
        assert.match(req.messages.at(-1)?.content ?? '', /path/);
        return { text: '', toolCalls: [{ id: 'b', name: 'read_conversation', arguments: '{"message_index":1}' }] };
      }
      if (n === 4) {
        page1 = req.messages.at(-1)?.content ?? '';
        const next = Number(/next_offset=(\d+)/.exec(page1)?.[1]);
        assert.ok(next > 0 && next < long.length);
        assert.equal(next % 2, 0, 'does not split emoji surrogate pairs');
        return { text: '', toolCalls: [{ id: 'c', name: 'read_conversation', arguments: JSON.stringify({ message_index: 1, offset: next }) }] };
      }
      assert.match(req.messages.at(-1)?.content ?? '', /Archived message 1/);
      assert.ok(!page1.includes('visible ending'));
      return { text: 'done', toolCalls: [] };
    } };
    const session = new HarnessSession({ host: new Host(dir), provider, config });
    session.restoreConversation(compacted, {}, original, true);
    const result = await session.runTask('Find previous details.', () => {});
    assert.equal(result.outcome, 'complete', result.summary);
    assert.deepEqual(session.originalConversationSnapshot.slice(0, original.length), original);
    assert.ok(!session.originalConversationSnapshot.some((m) => m.content === compacted[0].content));
    session.reset();
    assert.deepEqual(session.originalConversationSnapshot, []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('archive access obeys individual and group permissions, and a colliding custom tool is not implicitly granted', async () => {
  const dir = tmp();
  try {
    const run = async (policy: string, collision = false): Promise<{ names: string[]; results: ChatMessage[]; executed: number }> => {
      fs.writeFileSync(path.join(dir, 'agent.md'), `---\ntools: [${policy}]\n---\nAgent`);
      let executed = 0;
      const tools: Tool[] = collision ? [{ name: 'read_conversation', description: 'custom', parameters: { type: 'object' }, async run() { executed++; return { ok: true, content: 'custom result' }; } }] : [];
      let first = true;
      let names: string[] = [];
      let results: ChatMessage[] = [];
      const provider: Provider = { id: 'fake', label: 'fake', async chat(req) {
        if (first) {
          first = false; names = req.tools.map((t) => t.name);
          return { text: '', toolCalls: [
            { id: 's', name: 'search_conversation', arguments: '{"query":"secret"}' },
            { id: 'r', name: 'read_conversation', arguments: '{"message_index":1}' },
          ] };
        }
        results = req.messages.filter((m) => m.role === 'tool');
        return { text: 'done', toolCalls: [] };
      } };
      const session = new HarnessSession({ host: new Host(dir), provider, config, ...(collision ? { tools: new ToolRegistry(tools) } : {}), agentSelection: ['agent.md'] });
      session.restoreConversation(compacted, {}, [{ role: 'user', content: 'secret' }], true);
      await session.runTask('test', () => {});
      return { names, results, executed };
    };
    const none = await run('');
    assert.ok(!none.names.includes('search_conversation') && !none.names.includes('read_conversation'));
    assert.equal(none.results.filter((m) => m.content.includes('not allowed')).length, 2);
    const exact = await run('read_file');
    assert.ok(!exact.names.includes('search_conversation') && !exact.names.includes('read_conversation'));
    assert.equal(exact.results.filter((m) => m.content.includes('not allowed')).length, 2);
    const search = await run('search');
    assert.ok(search.names.includes('search_conversation'));
    assert.ok(!search.names.includes('read_conversation'));
    assert.match(search.results.find((m) => m.toolCallId === 's')?.content ?? '', /secret/);
    assert.match(search.results.find((m) => m.toolCallId === 'r')?.content ?? '', /not allowed/);
    const read = await run('read');
    assert.ok(read.names.includes('search_conversation') && read.names.includes('read_conversation'));
    const custom = await run('read', true);
    assert.equal(custom.executed, 0);
    assert.ok(!custom.names.includes('read_conversation'));
    assert.match(custom.results.find((m) => m.toolCallId === 'r')?.content ?? '', /not allowed/);
    const explicit = await run('read_conversation');
    assert.ok(explicit.names.includes('read_conversation'));
    assert.ok(!explicit.names.includes('search_conversation'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('in-flight original snapshots preserve unanswered calls while active snapshots remain provider-safe', async () => {
  const dir = tmp();
  try {
    let entered!: () => void; let release!: () => void;
    const started = new Promise<void>((r) => { entered = r; });
    const wait = new Promise<void>((r) => { release = r; });
    const tool: Tool = { name: 'slow', description: 'slow', parameters: { type: 'object' }, async run() { entered(); await wait; return { ok: true, content: 'result' }; } };
    let turn = 0;
    const provider: Provider = { id: 'fake', label: 'fake', async chat() { return ++turn === 1 ? { text: '', toolCalls: [{ id: 'slow1', name: 'slow', arguments: '{}' }] } : { text: 'done', toolCalls: [] }; } };
    const session = new HarnessSession({ host: new Host(dir), provider, config, tools: new ToolRegistry([tool]) });
    const task = session.runTask('Wait', () => {});
    await started;
    assert.equal(session.originalConversationSnapshot.at(-1)?.toolCalls?.[0].id, 'slow1');
    assert.ok(!session.conversationSnapshot.some((m) => m.toolCalls?.some((c) => c.id === 'slow1')));
    release(); await task;
    assert.equal(session.originalConversationSnapshot.find((m) => m.role === 'tool')?.content, 'result');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('archived tool messages preserve precisely the pages actually given to the model', async () => {
  const dir = tmp();
  try {
    const payload = 'large output 😀 '.repeat(1500);
    const tool: Tool = { name: 'large', description: '', parameters: { type: 'object' }, async run() { return { ok: true, content: payload }; } };
    let visible = '';
    let turn = 0;
    const provider: Provider = { id: 'fake', label: 'fake', async chat(req) {
      if (++turn === 1) return { text: '', toolCalls: [{ id: 'large', name: 'large', arguments: '{}' }] };
      visible = req.messages.find((m) => m.role === 'tool' && m.name === 'large')?.content ?? '';
      return { text: 'done', toolCalls: [] };
    } };
    const session = new HarnessSession({ host: new Host(dir), provider, config, tools: new ToolRegistry([tool]) });
    await session.runTask('Read output', () => {});
    assert.match(visible, /Partial output/);
    assert.notEqual(visible, payload);
    assert.equal(session.originalConversationSnapshot.find((m) => m.role === 'tool' && m.name === 'large')?.content, visible);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('conversation search bounds its scan, resumes by UTF-16 offset and finds boundary-spanning literals', async () => {
  const dir = tmp();
  try {
    const original: ChatMessage[] = [
      { role: 'user', content: 'x'.repeat(1_000_000) + 'needle' },
      { role: 'assistant', content: 'y'.repeat(999_997) + 'boundaryword' },
    ];
    let turn = 0;
    const provider: Provider = { id: 'fake', label: 'fake', async chat(req) {
      const last = req.messages.at(-1)?.content ?? '';
      switch (++turn) {
        case 1: return { text: '', toolCalls: [{ id: 's1', name: 'search_conversation', arguments: '{"query":"needle"}' }] };
        case 2:
          assert.match(last, /0 matching message/);
          assert.match(last, /next_start_index=1 next_start_offset=1000000/);
          return { text: '', toolCalls: [{ id: 's2', name: 'search_conversation', arguments: '{"query":"needle","start_index":1,"start_offset":1000000}' }] };
        case 3:
          assert.match(last, /message_index=1 role=user offset=1000000/);
          return { text: '', toolCalls: [{ id: 's3', name: 'search_conversation', arguments: '{"query":"boundaryword","start_index":2}' }] };
        case 4:
          assert.match(last, /message_index=2 role=assistant offset=999997/);
          return { text: 'done', toolCalls: [] };
        default: throw new Error('unexpected turn');
      }
    } };
    const session = new HarnessSession({ host: new Host(dir), provider, config });
    session.restoreConversation(compacted, {}, original, true);
    const result = await session.runTask('Find archived data', () => {});
    assert.equal(result.outcome, 'complete', result.summary);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
