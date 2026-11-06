import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as Module from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, test } from 'node:test';
import { CheckpointStore } from '../core/checkpoints';
import { replaceInFileTool, writeFileTool } from '../core/tools/fsTools';
import { DEFAULT_CONFIG } from '../core/types';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-vscode-eol-'));
let applied = 0;
let saveSucceeds = true;
let openThrows = false;
let activeDoc: any;

class Edit {
  content = '';
  replace(_uri: unknown, _range: unknown, content: string): void { this.content = content; }
  insert(_uri: unknown, _position: unknown, content: string): void { this.content = content; }
  createFile(): void {}
}
const vscodeStub: any = {
  Uri: { file: (p: string) => ({ fsPath: p, scheme: 'file' }) },
  EndOfLine: { LF: 1, CRLF: 2 },
  Range: class { constructor(..._args: unknown[]) {} },
  Position: class { constructor(..._args: unknown[]) {} },
  WorkspaceEdit: Edit,
  workspace: {
    textDocuments: [],
    async openTextDocument() {
      if (openThrows) throw new Error('editor unavailable');
      return activeDoc;
    },
    async applyEdit(edit: Edit) {
      applied++;
      // Model VS Code's normalization of inserted text to its document EOL.
      activeDoc.content = edit.content.replace(/\r\n?|\n/g, activeDoc.eol === 2 ? '\r\n' : '\n');
      activeDoc.isDirty = true;
      return true;
    },
  },
};
const moduleProto = Module as unknown as { prototype: { require: (id: string) => unknown } };
const originalRequire = moduleProto.prototype.require;
moduleProto.prototype.require = function patchedRequire(this: unknown, id: string): unknown {
  if (id === 'vscode') return vscodeStub;
  return originalRequire.call(this, id);
};
const { VsCodeHost } = require('../vscode/host') as typeof import('../vscode/host');
after(() => { moduleProto.prototype.require = originalRequire; fs.rmSync(root, { recursive: true, force: true }); });

function setup(name: string, original: string, eol = 1, dirty = false) {
  const file = path.join(root, name);
  fs.writeFileSync(file, original);
  applied = 0; saveSucceeds = true; openThrows = false;
  activeDoc = {
    uri: vscodeStub.Uri.file(file), content: original, eol, encoding: 'utf8', isDirty: dirty,
    getText() { return this.content; },
    positionAt(offset: number) { return offset; },
    async save() { if (!saveSucceeds) return false; fs.writeFileSync(file, this.content); this.isDirty = false; return true; },
  };
  vscodeStub.workspace.textDocuments = [activeDoc];
  const log = { debug() {}, info() {}, warn() {}, error() {} };
  const host = new VsCodeHost({ root, log: log as any, approvals: {} as any });
  return { host, file, doc: activeDoc };
}

test('VS Code host uses direct writes for mixed and CR-only line endings', async () => {
  for (const content of ['A\r\nB\nC\r', 'A\rB\r']) {
    const { host, file } = setup('mixed.txt', 'old\n', 1);
    await host.applyFileWrite(file, content);
    assert.equal(applied, 0);
    assert.equal(fs.readFileSync(file, 'utf8'), content);
  }
});

test('VS Code host preserves explicit line-ending changes and uses editor undo when compatible', async () => {
  const { host, file } = setup('regular.txt', 'a\n', 1);
  await host.applyFileWrite(file, 'b\n');
  assert.equal(applied, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), 'b\n');
  await host.applyFileWrite(file, 'c\r\n');
  assert.equal(applied, 1, 'editor would coerce CRLF to LF');
  assert.equal(fs.readFileSync(file, 'utf8'), 'c\r\n');
});

test('VS Code host never overwrites dirty documents, including fallback and mixed writes', async () => {
  for (const content of ['new\n', 'new\r\nother\n', 'new\r']) {
    const { host, file } = setup('dirty.txt', 'disk\n', 1, true);
    await assert.rejects(host.applyFileWrite(file, content), /unsaved editor changes/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'disk\n');
    assert.equal(applied, 0);
  }
});

test('VS Code host does not fall back to disk after an applied edit fails to save', async () => {
  const { host, file } = setup('save-fails.txt', 'disk\n', 1);
  saveSucceeds = false;
  await assert.rejects(host.applyFileWrite(file, 'new\n'), /could not save/);
  assert.equal(applied, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), 'disk\n');
});

test('VS Code host supports filesystem fallback and creates new files with requested endings', async () => {
  const { host, file } = setup('fallback.txt', 'disk\n', 1);
  openThrows = true;
  await host.applyFileWrite(file, 'new\n');
  assert.equal(fs.readFileSync(file, 'utf8'), 'new\n');
  const created = path.join(root, 'new.txt');
  await host.applyFileWrite(created, 'created\r\n');
  assert.equal(fs.readFileSync(created, 'utf8'), 'created\r\n');
});

test('VS Code host writes BOM content directly to preserve the byte order mark', async () => {
  const { host, file } = setup('bom.txt', '\uFEFFold\n', 1);
  await host.applyFileWrite(file, '\uFEFFnew\n');
  assert.equal(applied, 0);
  assert.deepEqual(fs.readFileSync(file), Buffer.from('\uFEFFnew\n', 'utf8'));
});

test('exact-write requests bypass editor edits and save-time formatters', async () => {
  const { host, file } = setup('exact.txt', 'a\nb\n', 1);
  await host.applyFileWrite(file, 'a\nB\n', { preserveBytes: true });
  assert.equal(applied, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), 'a\nB\n');
});

test('VS Code host writes directly when editor encoding is not UTF-8', async () => {
  const { host, file, doc } = setup('encoding.txt', 'old\n', 1);
  doc.encoding = 'windows1252';
  await host.applyFileWrite(file, 'café\n');
  assert.equal(applied, 0);
  assert.deepEqual(fs.readFileSync(file), Buffer.from('café\n', 'utf8'));
});

test('actual replacement and append tools request exact writes from the VS Code host', async () => {
  const { host, file } = setup('integration.txt', 'before\r\ntarget\nafter\r', 1);
  const ctx = { root, host, config: { ...DEFAULT_CONFIG, editPolicy: 'auto' as const }, checkpoints: new CheckpointStore(true), approval: async () => 'apply' as const };
  const replace = await replaceInFileTool.run({ path: 'integration.txt', old_text: 'target', new_text: 'changed' }, ctx);
  assert.equal(replace.ok, true);
  assert.equal(applied, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), 'before\r\nchanged\nafter\r');
  const append = await writeFileTool.run({ path: 'integration.txt', content: 'tail', mode: 'append' }, ctx);
  assert.equal(append.ok, true);
  assert.equal(applied, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), 'before\r\nchanged\nafter\rtail');
  const reverted = await ctx.checkpoints.revertAll();
  assert.deepEqual(reverted.failed, []);
  assert.equal(fs.readFileSync(file, 'utf8'), 'before\r\ntarget\nafter\r');
});

test('VS Code host detects unsaved changes through a symlink alias', async () => {
  const { host, file, doc } = setup('linked-target.txt', 'disk\n', 1, true);
  const link = path.join(root, 'linked-alias.txt');
  try { fs.symlinkSync(file, link, 'file'); } catch { return; }
  doc.uri = vscodeStub.Uri.file(link);
  await assert.rejects(host.applyFileWrite(file, 'agent\n', { preserveBytes: true }), /unsaved editor changes/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'disk\n');
});
