import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { HarnessSession } from '../core/agent';
import { discoverAgentFiles, parseAgentFrontMatter, selectAgentFiles } from '../core/agentFiles';
import { resolveAgentToolPolicy } from '../core/toolPolicy';
import { ToolRegistry } from '../core/tools';
import { isTranscriptWellFormed } from '../core/transcript';
import { DEFAULT_CONFIG, type ChatMessage, type ChatRequest, type HarnessHost, type Provider, type Tool, type ToolSpec } from '../core/types';

const specs: ToolSpec[] = ['list_files', 'read_file', 'search_text', 'get_diagnostics', 'open_file', 'write_file', 'create_file', 'replace_in_file', 'delete_file', 'run_command', 'mcp_fs_write', 'mcp_fs_read'].map((name) => ({ name, description: '', parameters: { type: 'object' } }));
const root = () => fs.mkdtempSync(path.join(os.tmpdir(), 'harness-tool-policy-'));
const write = (dir: string, file: string, content: string) => { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), content); };
const discover = (dir: string, selection?: string[]) => selectAgentFiles(discoverAgentFiles({ root: dir, config: DEFAULT_CONFIG.agentFiles }), selection);

class Host implements HarnessHost {
  constructor(readonly workspaceRoot: string) {}
  log(): void {}
  async requestApproval(): Promise<'apply'> { return 'apply'; }
}

test('YAML front matter supports block and inline lists including an explicit empty list', () => {
  assert.deepEqual(parseAgentFrontMatter('---\ndescription: Example\ntags:\n  - testing\ntools:\n  - read\n  - search\n---\nBody').tools, ['read', 'search']);
  assert.deepEqual(parseAgentFrontMatter('---\ntools: [read, "search"]\n---\nBody').tools, ['read', 'search']);
  assert.deepEqual(parseAgentFrontMatter('---\ntools: []\n---\nBody').tools, []);
  assert.match(parseAgentFrontMatter('---\ntools: read\n---\nBody').toolPolicyError ?? '', /list/);
  assert.match(parseAgentFrontMatter('---\ntools: [read\n---\nBody').toolPolicyError ?? '', /Invalid YAML/);
  assert.match(parseAgentFrontMatter('---\ntools:\n - read\n').toolPolicyError ?? '', /Unclosed/);
});

test('tool groups expand and multiple selected policies intersect; unselected files do not grant capabilities', () => {
  const dir = root();
  try {
    write(dir, 'agent.md', '---\ntools:\n  - read\n  - search\n  - edit\n  - execute\n  - mcp\n---\nGeneral agent');
    write(dir, '.agents/reviewer.md', '---\ntools: [read, search]\n---\nReview only');
    const all = resolveAgentToolPolicy(discover(dir), specs);
    assert.deepEqual(all.tools.map((t) => t.name), ['list_files', 'read_file', 'search_text', 'get_diagnostics', 'open_file']);
    const general = resolveAgentToolPolicy(discover(dir, ['agent.md']), specs);
    assert.deepEqual(general.tools.map((t) => t.name), specs.map((t) => t.name));
    const restricted = resolveAgentToolPolicy(discover(dir, ['.agents/reviewer.md']), specs);
    assert.ok(!restricted.tools.some((tool) => ['write_file', 'run_command', 'mcp_fs_write'].includes(tool.name)));
    assert.equal(restricted.restricted, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('no metadata retains legacy behavior; empty list allows no tools; exact names work', () => {
  const dir = root();
  try {
    write(dir, 'agent.md', 'Instructions only.');
    assert.deepEqual(resolveAgentToolPolicy(discover(dir), specs), { tools: specs, restricted: false });
    write(dir, 'agent.md', '---\ntools: []\n---\nInstructions.');
    assert.deepEqual(resolveAgentToolPolicy(discover(dir), specs), { tools: [], restricted: true });
    write(dir, 'agent.md', '---\ntools: [mcp_fs_read]\n---\nInstructions.');
    assert.deepEqual(resolveAgentToolPolicy(discover(dir), specs).tools.map((tool) => tool.name), ['mcp_fs_read']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('invalid, unknown, missing, skipped, and truncated agent policies fail closed', () => {
  const dir = root();
  try {
    for (const text of ['---\ntools: nope\n---\n', '---\ntools: [edit, no_such_tool]\n---\n', '---\ntools: [read\n---\n']) {
      write(dir, 'agent.md', text);
      assert.throws(() => resolveAgentToolPolicy(discover(dir), specs), /tool|YAML/i);
    }
    write(dir, 'agent.md', '---\ntools: [read]\n---\n');
    assert.throws(() => resolveAgentToolPolicy(discover(dir, ['missing.md']), specs), /could not be loaded/);
    const found = discover(dir);
    found.files[0].truncated = true;
    assert.throws(() => resolveAgentToolPolicy(found, specs), /truncated/);
    const skipped = discover(dir);
    skipped.skipped.push({ path: 'lost.md', reason: 'unreadable' });
    assert.throws(() => resolveAgentToolPolicy(skipped, specs), /could not be loaded/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('only allowed tools reach the provider, and invented denied calls never execute', async () => {
  const dir = root();
  try {
    write(dir, 'agent.md', '---\ndescription: Read only\ntools:\n  - read\n  - search\n---\nReview.');
    const executed: string[] = [];
    const tools = specs.map((spec): Tool => ({ ...spec, async run() { executed.push(spec.name); return { ok: true, content: 'done' }; } }));
    const seen: ChatRequest[] = [];
    const provider: Provider = { id: 'test', label: 'test', async chat(req) {
      seen.push(req);
      if (seen.length === 1) return { text: '', toolCalls: ['read_file', 'replace_in_file', 'run_command', 'mcp_fs_write'].map((name, i) => ({ id: String(i), name, arguments: '{}' })) };
      return { text: 'Done.', toolCalls: [] };
    } };
    const session = new HarnessSession({ host: new Host(dir), provider, tools: new ToolRegistry(tools), agentSelection: ['agent.md'], config: { ...DEFAULT_CONFIG, stream: false, maxSteps: 5 } });
    const result = await session.runTask('Review.', () => {});
    assert.equal(result.outcome, 'complete');
    assert.deepEqual(executed, ['read_file']);
    assert.deepEqual(seen[0].tools.map((tool) => tool.name), ['list_files', 'read_file', 'search_text', 'get_diagnostics', 'open_file', 'search_conversation', 'read_conversation']);
    const system = seen[0].messages.find((message) => message.role === 'system')?.content ?? '';
    assert.doesNotMatch(system, /`replace_in_file`/);
    assert.ok(isTranscriptWellFormed(seen[1].messages));
    assert.equal(seen[1].messages.filter((m) => m.role === 'tool' && m.content.includes('not allowed')).length, 3);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a missing selected agent file prevents provider calls rather than falling back', async () => {
  const dir = root();
  try {
    write(dir, 'agent.md', '---\ntools: [edit]\n---\n');
    let calls = 0;
    const provider: Provider = { id: 'test', label: 'test', async chat() { calls++; return { text: 'done', toolCalls: [] }; } };
    const session = new HarnessSession({ host: new Host(dir), provider, agentSelection: ['missing.md'], config: { ...DEFAULT_CONFIG, stream: false } });
    const result = await session.runTask('test', () => {});
    assert.equal(result.outcome, 'error');
    assert.match(result.summary, /could not be loaded/);
    assert.equal(calls, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a denied real file edit cannot modify the workspace even with automatic approvals', async () => {
  const dir = root();
  try {
    write(dir, 'agent.md', '---\ntools: [read, search]\n---\nReview only.');
    write(dir, 'example.txt', 'original content');
    let calls = 0;
    const provider: Provider = { id: 'test', label: 'test', async chat() {
      calls++;
      return calls === 1 ? { text: '', toolCalls: [{ id: 'edit', name: 'write_file', arguments: JSON.stringify({ path: 'example.txt', content: 'changed' }) }] } : { text: 'Done.', toolCalls: [] };
    } };
    const session = new HarnessSession({ host: new Host(dir), provider, agentSelection: ['agent.md'], config: { ...DEFAULT_CONFIG, stream: false, editPolicy: 'auto' } });
    const result = await session.runTask('Review.', () => {});
    assert.equal(result.outcome, 'complete');
    assert.equal(fs.readFileSync(path.join(dir, 'example.txt'), 'utf8'), 'original content');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
