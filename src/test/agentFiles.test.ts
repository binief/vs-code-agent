import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, test } from 'node:test';

import { agentFilesSummary, discoverAgentFiles, formatAgentInstructions } from '../core/agentFiles';
import { DEFAULT_CONFIG, type AgentFilesConfig } from '../core/types';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-agent-files-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function config(overrides: Partial<AgentFilesConfig> = {}): AgentFilesConfig {
  return { ...DEFAULT_CONFIG.agentFiles, ...overrides };
}

function names(result: { files: { displayPath: string }[] }): string[] {
  return result.files.map((file) => file.displayPath).sort();
}

function workspace(): string {
  const root = fs.mkdtempSync(path.join(tmp, 'ws-'));
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'root rules\n');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'agent.md'), 'src rules\n');
  fs.mkdirSync(path.join(root, '.github'), { recursive: true });
  fs.writeFileSync(path.join(root, '.github', 'agent.md'), 'github rules\n');
  fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'agent.md'), 'dependency rules\n');
  return root;
}

test('root and config-directory agent files are discovered by default', () => {
  const root = workspace();
  const result = discoverAgentFiles({ root, config: config() });
  const files = result.files.map((file) => file.displayPath).sort();
  assert.deepEqual(files, ['.github/agent.md', 'AGENTS.md']);
  assert.ok(!result.files.some((file) => file.content.includes('dependency rules')), 'node_modules must be ignored');
});

test('scanNested walks subdirectories up to maxDepth', () => {
  const root = workspace();
  const result = discoverAgentFiles({ root, config: config({ scanNested: true }) });
  const files = result.files.map((file) => file.displayPath).sort();
  assert.deepEqual(files, ['.github/agent.md', 'AGENTS.md', 'src/agent.md']);
  assert.ok(result.files.find((file) => file.displayPath === 'src/agent.md')?.scope === 'src');
});

test('an open editor pulls in a nested agent file without scanNested', () => {
  const root = workspace();
  const file = path.join(root, 'src', 'index.ts');
  fs.writeFileSync(file, 'export {};\n');
  const result = discoverAgentFiles({ root, config: config(), focusPaths: [file] });
  assert.ok(result.files.some((entry) => entry.displayPath === 'src/agent.md'));
});

test('any Markdown file in an instruction folder loads, whatever it is called', () => {
  const root = fs.mkdtempSync(path.join(tmp, 'named-'));
  fs.writeFileSync(path.join(root, 'README.md'), '# not instructions\n');
  fs.mkdirSync(path.join(root, '.agents', 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', 'code-review.md'), 'Review the diff.\n');
  fs.writeFileSync(path.join(root, '.agents', 'workflows', 'test.md'), 'Run the tests.\n');
  fs.mkdirSync(path.join(root, '.github', 'instructions'), { recursive: true });
  fs.writeFileSync(path.join(root, '.github', 'instructions', 'go-style.md'), 'Use gofmt.\n');
  fs.writeFileSync(path.join(root, '.github', 'PULL_REQUEST_TEMPLATE.md'), 'Not an instruction.\n');

  const result = discoverAgentFiles({ root, config: config() });
  assert.deepEqual(names(result), [
    '.agents/code-review.md',
    '.agents/workflows/test.md',
    '.github/instructions/go-style.md',
  ]);
  // Ordinary Markdown in the root or in a plain config folder stays out.
  assert.ok(!result.files.some((file) => file.displayPath === 'README.md'));
  assert.ok(!result.files.some((file) => file.displayPath.includes('PULL_REQUEST_TEMPLATE')));
  // Storage folders do not scope the rules to themselves.
  assert.equal(result.files.every((file) => file.scope === ''), true);
});

test('glob patterns load files with arbitrary names', () => {
  const root = fs.mkdtempSync(path.join(tmp, 'patterns-'));
  fs.writeFileSync(path.join(root, 'README.md'), '# readme\n');
  fs.mkdirSync(path.join(root, 'docs', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'rules', 'release.md'), 'Release process.\n');
  fs.writeFileSync(path.join(root, 'docs', 'notes.md'), 'Loose notes.\n');
  fs.writeFileSync(path.join(root, 'style.instructions.md'), 'Use two spaces.\n');

  const oneDir = discoverAgentFiles({ root, config: config({ patterns: ['docs/rules/*.md'] }) });
  assert.deepEqual(names(oneDir), ['docs/rules/release.md']);

  const tree = discoverAgentFiles({ root, config: config({ patterns: ['docs/**/*.md'] }) });
  assert.deepEqual(names(tree), ['docs/notes.md', 'docs/rules/release.md']);

  const nestedName = discoverAgentFiles({ root, config: config({ patterns: ['**/code-review.md'] }) });
  assert.deepEqual(names(nestedName), []);

  // The default pattern only matches files at the workspace root.
  const defaults = discoverAgentFiles({ root, config: config() });
  assert.deepEqual(names(defaults), ['style.instructions.md']);
});

test('front matter labels a file without becoming instruction text', () => {
  const root = fs.mkdtempSync(path.join(tmp, 'matter-'));
  fs.mkdirSync(path.join(root, '.agents'));
  fs.writeFileSync(
    path.join(root, '.agents', 'code-review.md'),
    '---\ndescription: Review checklist\napplyTo: "**/*.ts"\n---\n\nOnly review TypeScript changes.\n',
  );
  // A horizontal rule is not front matter and stays in the body.
  fs.writeFileSync(path.join(root, '.agents', 'plain.md'), '---\nJust a document.\n');

  const result = discoverAgentFiles({ root, config: config() });
  const review = result.files.find((file) => file.displayPath === '.agents/code-review.md');
  assert.ok(review);
  assert.equal(review.description, 'Review checklist');
  assert.equal(review.applyTo, '**/*.ts');
  assert.equal(review.content, 'Only review TypeScript changes.\n');
  assert.doesNotMatch(review.content, /description:/);

  const rendered = formatAgentInstructions(result);
  assert.match(rendered, /declared for \*\*\/\*\.ts/);
  assert.match(rendered, /Review checklist/);

  const plain = result.files.find((file) => file.displayPath === '.agents/plain.md');
  assert.match(plain?.content ?? '', /^---\nJust a document\./);
});

test('a package can keep its own instruction folder, scoped to that package', () => {
  const root = fs.mkdtempSync(path.join(tmp, 'pkg-'));
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'root rules\n');
  fs.mkdirSync(path.join(root, '.agents'));
  fs.writeFileSync(path.join(root, '.agents', 'global.md'), 'global rules\n');
  fs.mkdirSync(path.join(root, 'packages', 'api', '.agents'), { recursive: true });
  fs.writeFileSync(path.join(root, 'packages', 'api', '.agents', 'review.md'), 'api rules\n');

  const result = discoverAgentFiles({
    root,
    config: config(),
    focusPaths: [path.join(root, 'packages', 'api', 'src', 'index.ts')],
  });
  assert.deepEqual(
    result.files.map((file) => file.displayPath),
    ['AGENTS.md', '.agents/global.md', 'packages/api/.agents/review.md'],
    'root files first, then collected rules, then the active package',
  );
  assert.equal(result.files.at(-1)?.scope, 'packages/api');
  assert.match(formatAgentInstructions(result), /packages\/api\/\.agents\/review\.md — applies to packages\/api\/\*\*/);
});

test('case-insensitive names match on every platform', () => {
  const root = fs.mkdtempSync(path.join(tmp, 'case-'));
  fs.writeFileSync(path.join(root, 'Agents.MD'), 'mixed case\n');
  const result = discoverAgentFiles({ root, config: config() });
  assert.equal(result.files.length, 1);
  assert.match(result.files[0].content, /mixed case/);
});

test('agent files in the ancestor chain of an open editor load beyond maxDepth', () => {
  const root = workspace();
  const deep = path.join(root, 'packages', 'api', 'src', 'deep');
  fs.mkdirSync(deep, { recursive: true });
  fs.writeFileSync(path.join(root, 'packages', 'api', 'agent.md'), 'api rules\n');
  const file = path.join(deep, 'index.ts');
  fs.writeFileSync(file, 'export {};\n');

  const withoutFocus = discoverAgentFiles({ root, config: config({ maxDepth: 1 }) });
  assert.ok(!withoutFocus.files.some((entry) => entry.displayPath === 'packages/api/agent.md'), 'too deep without focus');

  const withFocus = discoverAgentFiles({ root, config: config({ maxDepth: 1 }), focusPaths: [file] });
  const api = withFocus.files.find((entry) => entry.displayPath === 'packages/api/agent.md');
  assert.ok(api, 'the active file pulls in its ancestor agent.md');
  assert.match(api.content, /api rules/);
});

test('the per-file and total budgets are enforced without cutting instructions mid-word', () => {
  const root = fs.mkdtempSync(path.join(tmp, 'budget-'));
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'a'.repeat(5000));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'agent.md'), 'second file\n');

  const truncated = discoverAgentFiles({ root, config: config({ scanNested: true, maxBytes: 3000, maxTotalBytes: 100_000 }) });
  assert.equal(truncated.files.length, 2);
  assert.equal(truncated.files[0].truncated, true);
  assert.equal(truncated.files[0].content.length, 3000);

  const tooSmall = discoverAgentFiles({ root, config: config({ scanNested: true, maxBytes: 3000, maxTotalBytes: 3005 }) });
  assert.equal(tooSmall.files.length, 1, 'the second file does not fit and is skipped');
  assert.ok(tooSmall.skipped.some((entry) => /budget/.test(entry.reason)));
});

test('user-level instructions are opt-in and rendered first', () => {
  const root = workspace();
  const userPath = path.join(tmp, 'user-agent.md');
  fs.writeFileSync(userPath, 'user wide rules\n');

  const off = discoverAgentFiles({ root, config: config() });
  assert.ok(!off.files.some((file) => file.content.includes('user wide rules')));

  const on = discoverAgentFiles({ root, config: config({ includeUser: true, userPath }) });
  assert.equal(on.files[0].origin, 'user');
  assert.match(on.files[0].content, /user wide rules/);
  assert.match(formatAgentInstructions(on), /user-level/);
});

test('extraPath directories are scanned for the configured names', () => {
  const root = fs.mkdtempSync(path.join(tmp, 'extra-'));
  const docs = path.join(root, 'docs');
  fs.mkdirSync(docs, { recursive: true });
  fs.writeFileSync(path.join(docs, 'agent.md'), 'docs rules\n');

  const off = discoverAgentFiles({ root, config: config() });
  assert.equal(off.files.length, 0);

  const on = discoverAgentFiles({ root, config: config({ extraPaths: ['docs'] }) });
  assert.equal(on.files.length, 1);
  assert.match(on.files[0].content, /docs rules/);
  assert.equal(on.files[0].scope, 'docs');
});

test('a symlinked agent file cannot escape the workspace', () => {
  if (process.platform === 'win32') return;
  const root = fs.mkdtempSync(path.join(tmp, 'link-'));
  const outside = path.join(tmp, 'outside-rules.md');
  fs.writeFileSync(outside, 'outside rules\n');
  fs.symlinkSync(outside, path.join(root, 'agent.md'));

  const result = discoverAgentFiles({ root, config: config() });
  assert.equal(result.files.length, 0);
  assert.ok(result.skipped.some((entry) => /symlink escapes/.test(entry.reason)));

  // An explicitly configured path is trusted, so the same link is allowed.
  const explicit = discoverAgentFiles({ root, config: config({ extraPaths: ['agent.md'] }) });
  assert.equal(explicit.files.length, 1);
});

test('agent files outside the workspace load only when configured explicitly', () => {
  const base = fs.mkdtempSync(path.join(tmp, 'outside-'));
  const root = path.join(base, 'project');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'project rules\n');
  const shared = path.join(base, 'shared');
  fs.mkdirSync(shared);
  fs.writeFileSync(path.join(shared, 'agent.md'), 'shared team rules\n');

  const notConfigured = discoverAgentFiles({ root, config: config() });
  assert.deepEqual(notConfigured.files.map((file) => file.displayPath), ['AGENTS.md']);

  const absolute = discoverAgentFiles({ root, config: config({ extraPaths: [path.join(shared, 'agent.md')] }) });
  assert.equal(absolute.files.length, 2);
  assert.equal(absolute.files.at(-1)?.origin, 'workspace');
  assert.match(absolute.files.at(-1)?.content ?? '', /shared team rules/);
  const rendered = formatAgentInstructions(absolute);
  assert.match(rendered, /outside the workspace/);
  assert.ok(rendered.indexOf('AGENTS.md') < rendered.indexOf('shared/agent.md'), 'workspace files come first');

  const relative = discoverAgentFiles({ root, config: config({ extraPaths: ['../shared/agent.md'] }) });
  assert.ok(relative.files.some((file) => file.content.includes('shared team rules')), '../ paths resolve against the root');

  const directory = discoverAgentFiles({ root, config: config({ extraPaths: [shared] }) });
  assert.ok(directory.files.some((file) => file.content.includes('shared team rules')), 'a directory is scanned for names');
});

test('missing paths are reported, not thrown', () => {
  const root = workspace();
  const result = discoverAgentFiles({
    root,
    config: config({ extraPaths: ['does/not/exist.md', '.github'] }),
  });
  assert.ok(result.skipped.some((entry) => entry.path.includes('does/not/exist.md')));
  assert.ok(result.files.some((entry) => entry.displayPath === '.github/agent.md'));
  assert.ok(agentFilesSummary(result).includes('.github/agent.md'));
});

test('an empty workspace renders a factual "none found" note, never built-in rules', () => {
  const root = fs.mkdtempSync(path.join(tmp, 'empty-'));
  const result = discoverAgentFiles({ root, config: config() });
  const text = formatAgentInstructions(result);
  assert.match(text, /No agent instruction files were found/);
  assert.match(text, /no built-in prompt/i);
  assert.doesNotMatch(text, /You are|You must|Always |add an agent file/i);
});

test('discovery honors enabled=false', () => {
  const root = workspace();
  const result = discoverAgentFiles({ root, config: config({ enabled: false }) });
  assert.equal(result.enabled, false);
  assert.equal(result.files.length, 0);
  assert.match(formatAgentInstructions(result), /disabled/);
});
