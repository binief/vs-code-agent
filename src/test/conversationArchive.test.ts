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

test('manual tool-output reduction requires the built-in archive reader and preserves exact originals across restore', async () => {
  const dir = tmp();
  try {
    const output = 'BEGIN\n' + 'middle important evidence\n'.repeat(300) + 'END error=42';
    const history: ChatMessage[] = [
      { role: 'user', content: 'Earlier request' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'old', name: 'inspect', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'old', name: 'inspect', content: output },
      { role: 'assistant', content: 'Earlier answer' },
      { role: 'user', content: 'Latest request' }, { role: 'assistant', content: 'Latest answer' },
    ];
    const c = { ...config, compaction: { ...config.compaction, keepLastMessages: 2, verbatimFallback: false } };
    const run = async (policy: string, collision = false) => {
      fs.writeFileSync(path.join(dir, 'agent.md'), `---\ntools: [${policy}]\n---\nAgent`);
      let calls = 0;
      const provider: Provider = { id: 'fake', label: 'fake', async chat(req) {
        calls++;
        if (req.messages[0].content.startsWith('Summarize the following')) throw new Error('do not summarize');
        if (calls === 1) return { text: '', toolCalls: [{ id: 'r', name: 'read_conversation', arguments: JSON.stringify({ message_index: 3, offset: 6 }) }] };
        assert.match(req.messages.at(-1)?.content ?? '', /middle important evidence/);
        return { text: 'done', toolCalls: [] };
      } };
      const custom: Tool[] = collision ? [{ name: 'read_conversation', description: 'custom', parameters: { type: 'object' }, async run() { throw new Error('must not run'); } }] : [];
      const session = new HarnessSession({ host: new Host(dir), provider, config: c, tools: new ToolRegistry(custom), agentSelection: ['agent.md'] });
      session.restoreConversation(JSON.parse(JSON.stringify(history)), {}, JSON.parse(JSON.stringify(history)), true);
      const result = await session.compact();
      return { result, session, calls };
    };
    const searchOnly = await run('search');
    assert.equal(searchOnly.result.compacted, false);
    assert.equal(searchOnly.session.conversationSnapshot[2].content, output);
    const collision = await run('read', true);
    assert.equal(collision.result.compacted, false);
    const permitted = await run('read');
    assert.equal(permitted.result.strategy, 'tool-output');
    assert.equal(permitted.calls, 0, 'pruning does not call the provider or rerun the tool');
    assert.match(permitted.session.conversationSnapshot[2].content, /message_index=3/);
    assert.equal(permitted.session.originalConversationSnapshot[2].content, output);
    const persisted = JSON.parse(JSON.stringify({ history: permitted.session.conversationSnapshot, original: permitted.session.originalConversationSnapshot }));
    let turn = 0;
    const provider: Provider = { id: 'fake', label: 'fake', async chat(req) {
      if (++turn === 1) {
        assert.match(req.messages.find((m) => m.toolCallId === 'old')?.content ?? '', /message_index=3/);
        return { text: '', toolCalls: [{ id: 'read', name: 'read_conversation', arguments: '{"message_index":3,"offset":6}' }] };
      }
      assert.match(req.messages.at(-1)?.content ?? '', /middle important evidence/);
      return { text: 'done', toolCalls: [] };
    } };
    const reopened = new HarnessSession({ host: new Host(dir), provider, config: c, agentSelection: ['agent.md'] });
    reopened.restoreConversation(persisted.history, {}, persisted.original, true);
    const task = await reopened.runTask('Retrieve the recorded output.', () => {});
    assert.equal(task.outcome, 'complete', task.summary);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('overflow recovery reduces old recorded tool outputs first and lets the model retrieve the middle', async () => {
  const dir = tmp();
  try {
    const output = 'start\n' + 'bulk-data '.repeat(900) + 'hidden UNIQUE_EVIDENCE\n' + 'end-data '.repeat(900);
    const history: ChatMessage[] = [
      { role: 'user', content: 'Old task' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'old', name: 'inspect', arguments: '{}' }] },
      { role: 'tool', name: 'inspect', toolCallId: 'old', content: output },
      { role: 'assistant', content: 'Old answer' },
      { role: 'user', content: 'Previous question' }, { role: 'assistant', content: 'Previous answer' },
    ];
    let turn = 0;
    const provider: Provider = { id: 'fake', label: 'fake', async chat(req) {
      if (++turn === 1) throw new Error('maximum context length exceeded');
      if (turn === 2) {
        const old = req.messages.find((m) => m.toolCallId === 'old');
        assert.match(old?.content ?? '', /message_index=3/);
        assert.ok(!old?.content.includes('UNIQUE_EVIDENCE'));
        assert.ok(req.messages.some((m) => m.role === 'user' && m.content === 'Current request'));
        return { text: '', toolCalls: [{ id: 'lookup', name: 'read_conversation', arguments: JSON.stringify({ message_index: 3, offset: output.indexOf('hidden UNIQUE_EVIDENCE') }) }] };
      }
      assert.match(req.messages.at(-1)?.content ?? '', /hidden UNIQUE_EVIDENCE/);
      return { text: 'done', toolCalls: [] };
    } };
    const c = { ...config, compaction: { ...config.compaction, keepLastMessages: 2 } };
    const session = new HarnessSession({ host: new Host(dir), provider, config: c });
    session.restoreConversation(JSON.parse(JSON.stringify(history)), {}, JSON.parse(JSON.stringify(history)), true);
    const notices: string[] = [];
    const task = await session.runTask('Current request', (event) => { if (event.type === 'notice') notices.push(event.message); });
    assert.equal(task.outcome, 'complete', task.summary);
    assert.ok(notices.some((s) => s.includes('Shortened 1 older recorded tool')));
    assert.equal(session.originalConversationSnapshot[2].content, output);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ranked search is available through search policy, excludes active copies, and returns bounded untrusted results', async () => {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, 'agent.md'), '---\ntools: [search]\n---\nAgent');
    const original: ChatMessage[] = [
      { role: 'user', content: 'Earlier diagnosis: src/core/agent.ts failed with Error42' },
      { role: 'assistant', content: 'Related core agent issue' },
      { role: 'user', content: 'Already active src/core/agent.ts' },
    ];
    const active = [original[2]];
    let turn = 0;
    const provider: Provider = { id: 'fake', label: 'fake', async chat(req) {
      if (++turn === 1) {
        assert.ok(req.tools.some((t) => t.name === 'search_conversation'));
        assert.ok(!req.tools.some((t) => t.name === 'read_conversation'));
        return { text: '', toolCalls: [{ id: 's', name: 'search_conversation', arguments: JSON.stringify({ query: 'src/core/agent.ts', mode: 'ranked' }) }] };
      }
      const content = req.messages.at(-1)?.content ?? '';
      assert.match(content, /Ranked scan-window/);
      assert.match(content, /message_index=1/);
      assert.doesNotMatch(content, /message_index=3/);
      assert.match(content, /untrusted history/);
      return { text: 'done', toolCalls: [] };
    } };
    const session = new HarnessSession({ host: new Host(dir), provider, config, agentSelection: ['agent.md'] });
    session.restoreConversation(JSON.parse(JSON.stringify(active)), {}, JSON.parse(JSON.stringify(original)), true);
    const task = await session.runTask('Find the old path', () => {});
    assert.equal(task.outcome, 'complete', task.summary);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
