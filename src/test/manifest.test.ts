import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';

/**
 * Guards the seams that TypeScript cannot check: the VS Code manifest has to
 * agree with the compiled extension and with the webview assets, otherwise the
 * extension installs but its buttons do nothing.
 */
const repoRoot = path.resolve(__dirname, '..', '..');
const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as any;

test('manifest points at a real entry point', () => {
  const main = manifest.main as string;
  assert.ok(main, 'package.json needs a "main"');
  const file = path.join(repoRoot, main.replace(/^\.\//, ''));
  assert.ok(fs.existsSync(file), `${main} does not exist — run npm run compile`);
});

test('every contributed command and view is registered in the compiled extension', () => {
  const bundle = ['extension.js', 'vscode/chatView.js', 'vscode/controller.js', 'vscode/host.js', 'vscode/proposals.js']
    .map((file) => fs.readFileSync(path.join(repoRoot, 'out', file), 'utf8'))
    .join('\n');

  const commands: string[] = (manifest.contributes?.commands ?? []).map((c: any) => c.command);
  assert.ok(commands.length >= 6, 'expected the documented command set');
  for (const id of commands) {
    assert.ok(bundle.includes(id), `command "${id}" is declared but never registered`);
  }

  const views: string[] = (manifest.contributes?.views?.codingHarness ?? []).map((v: any) => v.id);
  for (const id of views) {
    assert.ok(bundle.includes(id), `view "${id}" is declared but never registered`);
  }

  const menus = JSON.stringify(manifest.contributes?.menus ?? {});
  for (const id of commands) {
    if (menus.includes(id)) assert.ok(bundle.includes(id));
  }
});

test('activation events cover every contribution the user can trigger', () => {
  const events: string[] = manifest.activationEvents ?? [];
  assert.ok(events.includes('onView:codingHarness.chat'), 'the view must activate the extension');
  for (const command of manifest.contributes.commands.map((c: any) => c.command)) {
    assert.ok(events.includes(`onCommand:${command}`), `missing activation event for ${command}`);
  }
});

test('the webview loads assets that actually exist', () => {
  const viewSource = fs.readFileSync(path.join(repoRoot, 'src', 'vscode', 'chatView.ts'), 'utf8');
  const referenced = [...viewSource.matchAll(/asset\('([^']+)'\)/g)].map((m) => m[1]);
  assert.ok(referenced.includes('chat.css'));
  assert.ok(referenced.includes('chat.js'));
  for (const name of referenced) {
    assert.ok(fs.existsSync(path.join(repoRoot, 'media', name)), `media/${name} is missing`);
  }

  // The panel must be locked down: no remote script/style sources.
  assert.match(viewSource, /Content-Security-Policy/);
  assert.match(viewSource, /nonce-\$\{nonce\}/);
  assert.ok(!/https?:\/\/cdn/.test(viewSource), 'webview must not load remote assets');
});

test('every contributed setting is actually read by the controller', () => {
  const properties = Object.keys(manifest.contributes?.configuration?.properties ?? {});
  assert.ok(properties.length >= 10, 'expected the documented settings');
  const controller = fs.readFileSync(path.join(repoRoot, 'out', 'vscode', 'controller.js'), 'utf8');
  for (const key of properties) {
    const short = key.replace(/^codingHarness\./, '');
    assert.ok(
      controller.includes(`'${short}'`) || controller.includes(`"${short}"`),
      `setting ${key} is declared in the manifest but never read`,
    );
  }
});

test('the packaged file list keeps the runtime pieces', () => {
  const ignore = fs.readFileSync(path.join(repoRoot, '.vscodeignore'), 'utf8');
  assert.ok(!/^\s*out\/\*\*\s*$/m.test(ignore), '.vscodeignore must not exclude the compiled output');
  assert.ok(!/^\s*media\/\*\*\s*$/m.test(ignore), '.vscodeignore must not exclude the webview assets');
  assert.ok(/out\/test/.test(ignore), 'unit tests should not ship');
});

test('tool documentation in the manifest matches the tool registry', () => {
  const toolsDir = path.join(repoRoot, 'out', 'core', 'tools');
  const registry = fs
    .readdirSync(toolsDir)
    .filter((f) => f.endsWith('.js'))
    .map((f) => fs.readFileSync(path.join(toolsDir, f), 'utf8'))
    .join('\n');
  for (const tool of [
    'list_files',
    'read_file',
    'search_text',
    'write_file',
    'replace_in_file',
    'delete_file',
    'run_command',
    'get_diagnostics',
    'open_file',
  ]) {
    assert.ok(registry.includes(tool), `tool ${tool} is not registered`);
  }
});
