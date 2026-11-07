import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { HarnessSession } from '../core/agent';
import { ToolRegistry } from '../core/tools';
import { isTranscriptWellFormed } from '../core/transcript';
import { DEFAULT_CONFIG, type HarnessEvent, type HarnessHost, type Provider, type Tool } from '../core/types';

const provider: Provider = { id: 'fake', label: 'fake', async chat() { return { text: 'Done.', toolCalls: [] }; } };
class Host implements HarnessHost {
  approvals = 0;
  constructor(readonly workspaceRoot: string, private readonly accept = true) {}
  log(): void {}
  async requestApproval(): Promise<'apply' | 'reject'> { this.approvals++; return this.accept ? 'apply' : 'reject'; }
}
const config = { ...DEFAULT_CONFIG, stream: false, compaction: { ...DEFAULT_CONFIG.compaction, autoCompact: false }, verificationCommand: 'node -e "process.exit(0)"' };

test('verification is opt-in, runs once under normal approval, and records a provider-safe result', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-verification-'));
  try {
    const host = new Host(dir);
    const session = new HarnessSession({ host, provider, config: { ...config, commandPolicy: 'ask' } });
    const events: HarnessEvent[] = [];
    const result = await session.runTask('Do it', (e) => events.push(e));
    assert.equal(result.outcome, 'complete');
    assert.equal(host.approvals, 1);
    assert.equal(result.toolCalls, 1);
    assert.ok(events.some((e) => e.type === 'notice' && /verification command passed/.test(e.message)));
    assert.ok(isTranscriptWellFormed([...session.transcript]));
    const off = new HarnessSession({ host, provider, config: { ...config, verificationCommand: undefined } });
    assert.equal((await off.runTask('Nothing', () => {})).toolCalls, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('verification failure, rejection, policy denial and name collision cannot report verified completion', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-verification-'));
  try {
    const failure = new HarnessSession({ host: new Host(dir), provider, config: { ...config, commandPolicy: 'auto-all', verificationCommand: 'node -e "process.exit(7)"' } });
    const events: HarnessEvent[] = [];
    assert.equal((await failure.runTask('Check', (e) => events.push(e))).outcome, 'error');
    assert.ok(events.some((e) => e.type === 'notice' && /unverified/.test(e.message)));
    assert.ok(isTranscriptWellFormed([...failure.transcript]));
    const rejected = new HarnessSession({ host: new Host(dir, false), provider, config: { ...config, commandPolicy: 'ask' } });
    assert.equal((await rejected.runTask('Check', () => {})).outcome, 'error');
    fs.writeFileSync(path.join(dir, 'agent.md'), '---\ntools: [read]\n---\npolicy');
    const denied = new HarnessSession({ host: new Host(dir), provider, config, agentSelection: ['agent.md'] });
    assert.equal((await denied.runTask('Check', () => {})).outcome, 'error');
    let ran = false;
    const custom: Tool = { name: 'run_command', description: 'custom', parameters: { type: 'object' }, async run() { ran = true; return { ok: true, content: 'yes' }; } };
    fs.rmSync(path.join(dir, 'agent.md'));
    const collision = new HarnessSession({ host: new Host(dir), provider, config, tools: new ToolRegistry([custom]) });
    assert.equal((await collision.runTask('Check', () => {})).outcome, 'error');
    assert.equal(ran, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('cancelling when verification starts prevents the configured command from running', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-verification-cancel-'));
  try {
    const marker = path.join(dir, 'should-not-exist');
    const command = `node -e "require('fs').writeFileSync(${JSON.stringify(marker).replace(/"/g, "'")},'bad')"`;
    const session = new HarnessSession({ host: new Host(dir), provider, config: { ...config, commandPolicy: 'auto-all', verificationCommand: command } });
    const result = await session.runTask('Test cancel', (event) => { if (event.type === 'tool-start' && event.name === 'run_command') session.cancel(); });
    assert.equal(result.outcome, 'cancelled');
    assert.equal(fs.existsSync(marker), false);
    assert.ok(isTranscriptWellFormed([...session.transcript]));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
