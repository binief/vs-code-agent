import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, test } from 'node:test';

import { loadMcpConfigFiles, mergeMcpServers } from '../core/tools/mcpConfig';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mcp-config-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function workspace(): string {
  return fs.mkdtempSync(path.join(tmp, 'ws-'));
}

test('reads the VS Code servers shape and expands placeholders', async () => {
  const root = workspace();
  fs.mkdirSync(path.join(root, '.vscode'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.vscode', 'mcp.json'),
    JSON.stringify({
      servers: {
        local: {
          type: 'stdio',
          command: 'node',
          args: ['${workspaceFolder}/server.js'],
          env: { TOKEN: '${env:TEST_MCP_TOKEN}', HOME_DIR: '${userHome}' },
        },
        remote: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer x' } },
      },
      inputs: [],
    }),
  );

  const result = await loadMcpConfigFiles(root, ['.vscode/mcp.json'], { env: { TEST_MCP_TOKEN: 'secret' } });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.sources, [{ path: '.vscode/mcp.json', serverIds: ['local', 'remote'] }]);
  assert.equal(result.servers.local.command, 'node');
  assert.deepEqual(result.servers.local.args, [`${root}/server.js`]);
  assert.equal(result.servers.local.env?.TOKEN, 'secret');
  assert.equal(result.servers.local.env?.HOME_DIR, os.homedir());
  assert.equal(result.servers.remote.url, 'https://mcp.example.com/mcp');
  assert.equal(result.origins.local, '.vscode/mcp.json');
});

test('reads the Claude/Cursor mcpServers shape and resolves ${input:…}', async () => {
  const root = workspace();
  fs.writeFileSync(
    path.join(root, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        github: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
          env: { GITHUB_TOKEN: '${input:github-token}' },
        },
      },
      inputs: [{ id: 'github-token', description: 'GitHub token', password: true }],
    }),
  );

  const result = await loadMcpConfigFiles(root, ['.mcp.json'], { resolveInput: () => 'tok-123' });
  assert.deepEqual(result.errors, []);
  assert.equal(result.servers.github.env?.GITHUB_TOKEN, 'tok-123');
  assert.deepEqual(result.inputs.map((input) => input.id), ['github-token']);

  const missing = await loadMcpConfigFiles(root, ['.mcp.json']);
  assert.equal(missing.servers.github.env?.GITHUB_TOKEN, '');
  assert.ok(missing.errors.some((error) => /input "github-token" was not provided/.test(error.message)));
});

test('later files override earlier ones, and settings override files', async () => {
  const root = workspace();
  fs.writeFileSync(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: { shared: { command: 'first' } } }));
  fs.writeFileSync(path.join(root, 'mcp.json'), JSON.stringify({ servers: { shared: { command: 'second' } } }));

  const files = await loadMcpConfigFiles(root, ['.mcp.json', 'mcp.json']);
  assert.equal(files.servers.shared.command, 'second');
  assert.equal(files.origins.shared, 'mcp.json');

  const merged = mergeMcpServers(files, { shared: { command: 'settings' }, extra: { url: 'https://x.test/mcp' } });
  assert.equal(merged.servers.shared.command, 'settings');
  assert.equal(merged.origins.shared, 'settings');
  assert.equal(merged.servers.extra.url, 'https://x.test/mcp');
});

test('invalid JSON is reported per file and never hides the healthy files', async () => {
  const root = workspace();
  fs.writeFileSync(path.join(root, 'broken.json'), '{ not json');
  fs.writeFileSync(path.join(root, 'mcp.json'), JSON.stringify({ servers: { ok: { command: 'node' } } }));

  const result = await loadMcpConfigFiles(root, ['broken.json', 'mcp.json']);
  assert.equal(result.servers.ok.command, 'node');
  assert.ok(result.errors.some((error) => error.path === 'broken.json' && /invalid JSON/.test(error.message)));
});

test('missing config files are not an error', async () => {
  const root = workspace();
  const result = await loadMcpConfigFiles(root, ['nope.json', '.vscode/mcp.json']);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.sources, []);
  assert.deepEqual(result.servers, {});
});

test('default config file list is used by the extension defaults', async () => {
  const root = workspace();
  fs.writeFileSync(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: { auto: { command: 'node' } } }));
  const result = await loadMcpConfigFiles(root, ['.vscode/mcp.json', '.mcp.json', 'mcp.json']);
  assert.equal(result.servers.auto.command, 'node');
  assert.deepEqual(result.sources.map((source) => source.path), ['.mcp.json']);
});
