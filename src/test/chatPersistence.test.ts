import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as Module from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, afterEach, test } from 'node:test';
import type { ChatMessage, ChatRequest, ProviderResponse } from '../core/types';
import { isTranscriptWellFormed } from '../core/transcript';
import { parseChatArchive } from '../vscode/chatArchive';

/** Exercise the real controller and VS Code filesystem calls without an editor. */
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-chat-'));
fs.writeFileSync(path.join(root, 'sample.txt'), 'The source file.\n');
interface StubUri {
  fsPath: string;
  path: string;
  scheme: string;
  authority: string;
  toString(): string;
  with(changes: { path?: string; scheme?: string; authority?: string }): StubUri;
}
const uri = (fsPath: string, scheme = 'file', authority = ''): StubUri => ({
  fsPath, path: fsPath, scheme, authority,
  toString: () => `${scheme}://${authority}${fsPath}`,
  with: (changes) => uri(changes.path ?? fsPath, changes.scheme ?? scheme, changes.authority ?? authority),
});

const dialogs: { open?: StubUri[]; save?: StubUri; confirm?: string; warnings: string[]; errors: string[] } = {
  warnings: [], errors: [],
};
let writeGate: { entered: () => void; wait: Promise<void> } | undefined;
let readGate: { file: string; entered: () => void; wait: Promise<void> } | undefined;
let renameFailures = 0;
let onRename: ((destination: StubUri) => void) | undefined;
const settings: Record<string, unknown> = {
  provider: 'openai', model: 'test-model', stream: true, showThinking: true,
  'mcp.enabled': false, 'agentFiles.enabled': false, 'context.diagnostics': false,
};

class StubDisposable {
  constructor(private readonly fn?: () => void) {}
  dispose(): void { this.fn?.(); }
}

const vscodeStub = {
  workspace: {
    workspaceFolders: [{ uri: uri(root), name: 'test', index: 0 }],
    workspaceFile: undefined as StubUri | undefined,
    textDocuments: [],
    isTrusted: true,
    getConfiguration: () => ({ get: (key: string) => settings[key] }),
    asRelativePath: (u: StubUri | string) => typeof u === 'string' ? u : path.relative(root, u.fsPath),
    fs: {
      readFile: async (u: StubUri) => {
        if (readGate?.file === u.fsPath) {
          const gate = readGate;
          readGate = undefined;
          gate.entered();
          await gate.wait;
        }
        return fs.promises.readFile(u.fsPath);
      },
      createDirectory: async (u: StubUri) => { await fs.promises.mkdir(u.fsPath, { recursive: true }); },
      writeFile: async (u: StubUri, data: Uint8Array) => {
        if (writeGate && path.basename(u.fsPath).startsWith('.current-chat-')) {
          const gate = writeGate;
          writeGate = undefined;
          gate.entered();
          await gate.wait;
        }
        await fs.promises.writeFile(u.fsPath, data);
      },
      rename: async (from: StubUri, to: StubUri) => {
        if (renameFailures > 0) {
          renameFailures--;
          throw new Error('storage unavailable');
        }
        await fs.promises.rename(from.fsPath, to.fsPath);
        onRename?.(to);
      },
      delete: async (u: StubUri) => fs.promises.rm(u.fsPath, { force: true }),
      stat: async (u: StubUri) => fs.promises.stat(u.fsPath),
    },
  },
  window: {
    activeTextEditor: undefined,
    showSaveDialog: async () => dialogs.save,
    showOpenDialog: async () => dialogs.open,
    showWarningMessage: async (message: string) => { dialogs.warnings.push(message); return dialogs.confirm; },
    showErrorMessage: async (message: string) => { dialogs.errors.push(message); return undefined; },
    showInformationMessage: async () => undefined,
  },
  env: { clipboard: { writeText: async (_text: string) => {} }, remoteName: undefined },
  commands: { executeCommand: async () => undefined },
  Uri: {
    file: uri,
    joinPath: (base: StubUri, ...parts: string[]) => uri(path.join(base.fsPath, ...parts), base.scheme, base.authority),
    from: (value: { path: string }) => uri(value.path),
  },
  Disposable: StubDisposable,
  EventEmitter: class { event = () => new StubDisposable(); fire(): void {} dispose(): void {} },
  languages: { getDiagnostics: () => [] },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  version: 'test',
};

const moduleProto = Module as unknown as { prototype: { require: (id: string) => unknown } };
const originalRequire = moduleProto.prototype.require;
moduleProto.prototype.require = function patchedRequire(this: unknown, id: string): unknown {
  if (id === 'vscode') return vscodeStub;
  return originalRequire.call(this, id);
};
const { HarnessController } = require('../vscode/controller') as typeof import('../vscode/controller');
const { ChatViewProvider } = require('../vscode/chatView') as typeof import('../vscode/chatView');
const providerModule = require('../core/providers') as typeof import('../core/providers');
const originalCreateProvider = providerModule.createProvider;
let respond: (request: ChatRequest) => Promise<ProviderResponse>;
(providerModule as any).createProvider = () => ({
  id: 'test', label: 'test provider', chat: (request: ChatRequest) => respond(request),
});

afterEach(() => {
  delete settings['chat.saveEnabled'];
  delete settings['chat.saveFolder'];
  vscodeStub.workspace.workspaceFolders = [{ uri: uri(root), name: 'test', index: 0 }];
  vscodeStub.workspace.workspaceFile = undefined;
  readGate = undefined;
  writeGate = undefined;
  onRename = undefined;
});

after(() => {
  (providerModule as any).createProvider = originalCreateProvider;
  moduleProto.prototype.require = originalRequire;
  fs.rmSync(root, { recursive: true, force: true });
});

const log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const approvals = { cancelAll: () => {}, forgetAll: () => {}, resolve: () => {}, rememberAlways: () => {} };
const proposals = { add: () => uri('/proposal'), dispose: () => {} };

function makeController(name: string) {
  const storage = path.join(root, 'storage', name);
  const state = new Map<string, unknown>();
  const context = {
    storageUri: uri(storage),
    workspaceState: { get: (key: string) => state.get(key), update: async (key: string, value: unknown) => state.set(key, value) },
    secrets: { get: async () => 'top-secret-api-key', store: async () => {}, delete: async () => {} },
  };
  const messages: any[] = [];
  const controller = new HarnessController(context as any, log as any, approvals as any, proposals as any);
  controller.onUiMessage((message) => messages.push(message));
  return { controller, storage, messages };
}

/** Always uses the same tool id, as real providers may on separate tasks. */
function toolProvider(requests: ChatMessage[][]): (request: ChatRequest) => Promise<ProviderResponse> {
  return async (request) => {
    requests.push(JSON.parse(JSON.stringify(request.messages)) as ChatMessage[]);
    let lastUser = request.messages.length - 1;
    while (lastUser >= 0 && request.messages[lastUser].role !== 'user') lastUser--;
    const task = request.messages.slice(lastUser + 1);
    const prompt = request.messages[lastUser].content;
    if (!task.some((message) => message.role === 'tool')) {
      request.onThinking?.('Checking the file.');
      request.onDelta?.('Reading the file.');
      return { text: 'Reading the file.', toolCalls: [{ id: 'repeated-call', name: 'read_file', arguments: '{"path":"sample.txt"}' }], usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } };
    }
    const text = `Answer to ${prompt}`;
    request.onDelta?.(text);
    return { text, toolCalls: [], usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } };
  };
}

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/* --------------------------------------------------------- persistence */

test('restart restores the view, model history, images and usage, and follow-ups stay distinct', async () => {
  const requests: ChatMessage[][] = [];
  respond = toolProvider(requests);
  const first = makeController('restart');
  await first.controller.run('Original question', [{ name: 'shot.png', dataUrl: `data:image/png;base64,${PNG}` }]);
  const before = plain(first.controller.getTranscript());
  const usage = first.controller.getState().cumulativeUsage;
  const savedText = await fs.promises.readFile(path.join(first.storage, 'current-chat.json'), 'utf8');
  const saved = parseChatArchive(savedText);
  assert.ok(!savedText.includes('top-secret-api-key'), 'credentials are not part of the archive');
  assert.ok(saved.history.some((m) => m.role === 'tool'));
  assert.ok(isTranscriptWellFormed(saved.history));
  assert.equal(saved.history.find((m) => m.role === 'user')?.images?.[0].data, PNG);

  const reopened = makeController('restart');
  await reopened.controller.whenReady();
  assert.deepEqual(reopened.controller.getTranscript(), before);
  assert.deepEqual(plain(reopened.controller.getState().cumulativeUsage), plain(usage));
  const otherWorkspace = makeController('another-workspace');
  await otherWorkspace.controller.whenReady();
  assert.deepEqual(otherWorkspace.controller.getTranscript(), [], 'a different workspace does not see this chat');

  await reopened.controller.run('Follow-up question');
  const followUp = requests.find((messages) => messages.at(-1)?.role === 'user' && messages.at(-1)?.content === 'Follow-up question');
  assert.ok(followUp, 'the new task reached the provider');
  assert.ok(followUp.some((m) => m.role === 'user' && m.content === 'Original question' && m.images?.[0].data === PNG));
  assert.ok(followUp.some((m) => m.role === 'tool' && m.content.includes('The source file')));
  assert.ok(followUp.some((m) => m.role === 'assistant' && m.content === 'Answer to Original question'));

  const after = reopened.controller.getTranscript();
  assert.deepEqual(plain(after.slice(0, before.length)), before, 'new streams do not mutate the previous task');
  assert.equal(new Set(after.map((item) => item.id)).size, after.length, 'every displayed item has a unique id');
  assert.equal(after.filter((item) => item.kind === 'tool').length, 2, 'reused provider tool IDs do not overwrite old cards');
  assert.equal(after.filter((item) => item.kind === 'user').length, 2);

  await reopened.controller.reset();
  const cleared = makeController('restart');
  await cleared.controller.whenReady();
  assert.deepEqual(cleared.controller.getTranscript(), [], 'new conversation clears persisted history');
  assert.equal(cleared.controller.getState().cumulativeUsage?.totalTokens, 0);
  await cleared.controller.run('Fresh start');
  const fresh = requests.find((messages) => messages.at(-1)?.content === 'Fresh start');
  assert.ok(fresh && !fresh.some((m) => m.content === 'Original question'), 'reset also clears model context');
});

test('export/import round-trips a complete chat, confirms replacement and survives restart', async () => {
  const requests: ChatMessage[][] = [];
  respond = toolProvider(requests);
  const source = makeController('source');
  await source.controller.run('Exported question');
  const exportedFile = path.join(root, 'exported-chat.json');
  dialogs.save = uri(exportedFile);
  await source.controller.exportChat();
  const exported = parseChatArchive(await fs.promises.readFile(exportedFile, 'utf8'));
  assert.equal(exported.format, 'coding-harness-chat');
  assert.equal(exported.inProgress, false);

  const target = makeController('target');
  await target.controller.run('Do not replace me without confirmation');
  const current = plain(target.controller.getTranscript());
  dialogs.open = [uri(exportedFile)];
  dialogs.confirm = undefined;
  await target.controller.importChat();
  assert.deepEqual(plain(target.controller.getTranscript()), current, 'cancelling confirmation keeps the old chat');

  dialogs.confirm = 'Replace Chat';
  await target.controller.importChat();
  assert.deepEqual(plain(target.controller.getTranscript()), plain(source.controller.getTranscript()));
  assert.ok(target.messages.some((message) => message.type === 'chat-replaced'));
  const restoredTarget = makeController('target');
  await restoredTarget.controller.whenReady();
  assert.deepEqual(plain(restoredTarget.controller.getTranscript()), plain(source.controller.getTranscript()));
  await restoredTarget.controller.run('Continue imported chat');
  const followUp = requests.find((messages) => messages.at(-1)?.content === 'Continue imported chat');
  assert.ok(followUp?.some((m) => m.role === 'user' && m.content === 'Exported question'));
  assert.ok(followUp?.some((m) => m.role === 'tool'));
  assert.ok(!followUp?.some((m) => m.content === 'Do not replace me without confirmation'));
});

test('invalid imports and cancelled pickers leave the current chat untouched', async () => {
  respond = toolProvider([]);
  const target = makeController('bad-import');
  await target.controller.run('Keep this');
  const current = plain(target.controller.getTranscript());
  const bad = path.join(root, 'bad.json');
  await fs.promises.writeFile(bad, '{"format":"coding-harness-chat","version":999}');
  dialogs.open = [uri(bad)];
  dialogs.confirm = 'Replace Chat';
  const errorCount = dialogs.errors.length;
  await target.controller.importChat();
  assert.equal(dialogs.errors.length, errorCount + 1);
  assert.match(dialogs.errors.at(-1)!, /unsupported version/i);
  assert.deepEqual(plain(target.controller.getTranscript()), current);
  dialogs.open = undefined;
  await target.controller.importChat();
  assert.deepEqual(plain(target.controller.getTranscript()), current);
  const reopened = makeController('bad-import');
  await reopened.controller.whenReady();
  assert.deepEqual(reopened.controller.getTranscript(), current);
});

test('queued writes cannot resurrect a chat after it is reset', async () => {
  respond = toolProvider([]);
  const subject = makeController('write-order');
  let signalEntered!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { signalEntered = resolve; });
  const wait = new Promise<void>((resolve) => { release = resolve; });
  writeGate = { entered: signalEntered, wait };
  const running = subject.controller.run('An older snapshot');
  await entered;
  const reset = subject.controller.reset();
  release();
  await Promise.all([running, reset]);
  const reopened = makeController('write-order');
  await reopened.controller.whenReady();
  assert.deepEqual(reopened.controller.getTranscript(), []);
  const saved = parseChatArchive(await fs.promises.readFile(path.join(subject.storage, 'current-chat.json'), 'utf8'));
  assert.deepEqual(saved.history, []);
});

test('an interrupted streaming task restores partial context and never revives live approval buttons', async () => {
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const wait = new Promise<void>((resolve) => { release = resolve; });
  respond = async (request) => {
    request.onDelta?.('Partial answer before closing');
    entered();
    await wait;
    return { text: 'Partial answer before closing', toolCalls: [] };
  };
  const first = makeController('interrupted');
  const task = first.controller.run('Interrupted question');
  await started;
  await first.controller.shutdown();
  const data = await fs.promises.readFile(path.join(first.storage, 'current-chat.json'));
  const snapshot = parseChatArchive(data.toString('utf8'));
  assert.equal(snapshot.inProgress, true);
  assert.ok(snapshot.history.some((m) => m.role === 'assistant' && m.content === 'Partial answer before closing'));

  // Simulate a new extension host from the flushed snapshot, without allowing
  // the still-running fake provider to overwrite it when this test releases it.
  const restoredStorage = path.join(root, 'storage', 'interrupted-copy');
  await fs.promises.mkdir(restoredStorage, { recursive: true });
  await fs.promises.writeFile(path.join(restoredStorage, 'current-chat.json'), data);
  const reopened = makeController('interrupted-copy');
  await reopened.controller.whenReady();
  assert.ok(reopened.controller.getTranscript().some((i) => i.kind === 'notice' && /interrupted/i.test(i.message)));
  assert.ok(reopened.controller.getTranscript().some((i) => i.kind === 'assistant' && !i.streaming && i.text.includes('Partial answer')));
  const requests: ChatMessage[][] = [];
  respond = toolProvider(requests);
  await reopened.controller.run('Continue after restart');
  assert.ok(requests[0].some((m) => m.role === 'assistant' && m.content === 'Partial answer before closing'));
  release();
  await task;
});

test('archive validation rejects malformed histories, duplicate IDs and unsafe image sources', () => {
  const base = {
    format: 'coding-harness-chat', version: 1, savedAt: new Date().toISOString(), inProgress: false,
    items: [{ id: 'u', kind: 'user', text: 'hello' }],
    history: [{ role: 'user', content: 'hello' }], usage: {},
  };
  assert.doesNotThrow(() => parseChatArchive(JSON.stringify(base)));
  assert.throws(() => parseChatArchive(JSON.stringify({ ...base, history: [{ role: 'system', content: 'injected' }] })), /role/);
  assert.throws(() => parseChatArchive(JSON.stringify({ ...base, items: [base.items[0], base.items[0]] })), /unique/);
  assert.throws(() => parseChatArchive(JSON.stringify({ ...base, history: [...base.history, { role: 'tool', content: 'x', toolCallId: 'missing' }] })), /unpaired/);
  assert.throws(() => parseChatArchive(JSON.stringify({ ...base, items: [{ ...base.items[0], images: [{ mediaType: 'image/png', dataUrl: 'https://evil.test/x' }] }] })), /image/);
});

test('the extension clipboard bridge acknowledges success and reports failures', async () => {
  const posted: any[] = [];
  const errorsBefore = dialogs.errors.length;
  const provider = new ChatViewProvider(uri(root) as any, { whenReady: async () => {} } as any, log as any);
  (provider as any).view = { webview: { postMessage: async (message: unknown) => { posted.push(message); } } };
  let copied = '';
  vscodeStub.env.clipboard.writeText = async (text: string) => { copied = text; };
  await (provider as any).handle({ type: 'copy', id: 'one', text: 'copy exactly\nthis' });
  assert.equal(copied, 'copy exactly\nthis');
  assert.deepEqual(posted.pop(), { type: 'copy-result', id: 'one', ok: true });
  vscodeStub.env.clipboard.writeText = async () => { throw new Error('unavailable'); };
  await (provider as any).handle({ type: 'copy', id: 'two', text: 'x' });
  assert.deepEqual(posted.pop(), { type: 'copy-result', id: 'two', ok: false });
  assert.equal(dialogs.errors.length, errorsBefore + 1);
});

test('an unreadable saved chat is not overwritten just by opening and closing VS Code', async () => {
  const storage = path.join(root, 'storage', 'corrupt');
  await fs.promises.mkdir(storage, { recursive: true });
  const file = path.join(storage, 'current-chat.json');
  await fs.promises.writeFile(file, '{unfinished json');
  const subject = makeController('corrupt');
  const warningsBefore = dialogs.warnings.length;
  await subject.controller.whenReady();
  assert.ok(dialogs.warnings.length > warningsBefore, 'the failed restore is visible to the user');
  await subject.controller.shutdown();
  assert.equal(await fs.promises.readFile(file, 'utf8'), '{unfinished json', 'the original remains available for recovery');
});

test('pending approvals and running tools in an imported interrupted chat become inert', async () => {
  const file = path.join(root, 'pending-chat.json');
  const archive = {
    format: 'coding-harness-chat', version: 1, savedAt: new Date().toISOString(), inProgress: true,
    items: [
      { id: 'user', kind: 'user', text: 'Do the change' },
      { id: 'thinking', kind: 'thinking', text: 'Working', streaming: true },
      { id: 'tool', kind: 'tool', toolCallId: 'x', name: 'write_file', args: '{}', status: 'running' },
      { id: 'approval', kind: 'approval', approvalId: 'x', request: { kind: 'write', title: 'Write', detail: '+changed' } },
    ],
    history: [{ role: 'user', content: 'Do the change' }], usage: {},
  };
  await fs.promises.writeFile(file, JSON.stringify(archive));
  const target = makeController('pending-import');
  dialogs.open = [uri(file)];
  await target.controller.importChat();
  const items = target.controller.getTranscript();
  const approval = items.find((item) => item.kind === 'approval');
  assert.ok(approval?.kind === 'approval' && approval.interrupted && !approval.decision);
  const tool = items.find((item) => item.kind === 'tool');
  assert.ok(tool?.kind === 'tool' && tool.status === 'failed' && tool.summary === 'Interrupted');
  const thinking = items.find((item) => item.kind === 'thinking');
  assert.ok(thinking?.kind === 'thinking' && !thinking.streaming);
  assert.ok(items.some((item) => item.kind === 'notice' && /interrupted/i.test(item.message)));
  const reopened = makeController('pending-import');
  await reopened.controller.whenReady();
  const restored = reopened.controller.getTranscript().find((item) => item.kind === 'approval');
  assert.ok(restored?.kind === 'approval' && restored.interrupted, 'interrupted approvals stay inert after another restart');
});

test('reset, import and export cannot replace or capture an active task', async () => {
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const wait = new Promise<void>((resolve) => { release = resolve; });
  respond = async () => {
    entered();
    await wait;
    return { text: 'Finished', toolCalls: [] };
  };
  const subject = makeController('busy-actions');
  const task = subject.controller.run('Active task');
  await started;
  await subject.controller.reset();
  await subject.controller.importChat();
  await subject.controller.exportChat();
  assert.ok(subject.controller.getTranscript().some((item) => item.kind === 'user' && item.text === 'Active task'));
  assert.ok(dialogs.warnings.some((message) => /before starting a new conversation/i.test(message)));
  assert.ok(dialogs.warnings.some((message) => /before importing/i.test(message)));
  assert.ok(dialogs.warnings.some((message) => /before exporting/i.test(message)));
  release();
  await task;
});

test('cancelling a live stream preserves the partial answer in model history', async () => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  respond = async (request) => {
    request.onDelta?.('Visible partial answer');
    entered();
    await new Promise<void>((_resolve, reject) => {
      request.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
    return { text: '', toolCalls: [] };
  };
  const subject = makeController('cancel-partial');
  const task = subject.controller.run('Explain');
  await started;
  subject.controller.cancel();
  await task;
  const saved = parseChatArchive(await fs.promises.readFile(path.join(subject.storage, 'current-chat.json'), 'utf8'));
  assert.equal(saved.inProgress, false);
  assert.ok(saved.history.some((message) => message.role === 'assistant' && message.content === 'Visible partial answer'));
});

test('an active task is autosaved before it finishes', { timeout: 6000 }, async () => {
  let entered!: () => void;
  let release!: () => void;
  let saved!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const written = new Promise<void>((resolve) => { saved = resolve; });
  const subject = makeController('autosave-live');
  onRename = (destination) => {
    if (destination.fsPath === path.join(subject.storage, 'current-chat.json')) saved();
  };
  respond = async (request) => {
    request.onDelta?.('Live response');
    entered();
    await wait;
    return { text: 'Live response', toolCalls: [] };
  };
  const task = subject.controller.run('Save my progress');
  try {
    await started;
    await written;
    const snapshot = parseChatArchive(await fs.promises.readFile(path.join(subject.storage, 'current-chat.json'), 'utf8'));
    assert.equal(snapshot.inProgress, true);
    assert.ok(snapshot.history.some((message) => message.content === 'Save my progress'));
    assert.ok(snapshot.history.some((message) => message.content === 'Live response'));
  } finally {
    onRename = undefined;
    release();
    await task;
  }
});

test('the chat view waits for restoration before its initial render', async () => {
  respond = toolProvider([]);
  const source = makeController('view-ready');
  await source.controller.run('Restore before rendering');
  const reopened = makeController('view-ready');
  const posted: any[] = [];
  const view = new ChatViewProvider(uri(root) as any, reopened.controller, log as any);
  (view as any).view = { webview: { postMessage: async (message: unknown) => { posted.push(message); } } };
  await (view as any).handle({ type: 'ready' });
  const init = posted.find((message) => message.type === 'init');
  assert.ok(init, 'the view is initialized');
  assert.ok(init.items.some((item: any) => item.kind === 'user' && item.text === 'Restore before rendering'));
  assert.equal(init.state.model, 'test-model', 'configuration is refreshed for the restored panel');
});

test('a restored conversation can be compacted before starting another task', async () => {
  const requests: ChatMessage[][] = [];
  respond = toolProvider(requests);
  const source = makeController('compact-restored');
  for (let index = 0; index < 4; index++) await source.controller.run(`Task ${index}`);
  const original = parseChatArchive(await fs.promises.readFile(path.join(source.storage, 'current-chat.json'), 'utf8'));
  assert.ok(original.history.length > 10);
  const reopened = makeController('compact-restored');
  await reopened.controller.whenReady();
  await reopened.controller.compactHistory();
  const compacted = parseChatArchive(await fs.promises.readFile(path.join(source.storage, 'current-chat.json'), 'utf8'));
  assert.ok(compacted.history.length < original.history.length);
  assert.match(compacted.history[0].content, /Conversation compacted/);
  const again = makeController('compact-restored');
  await again.controller.whenReady();
  await again.controller.run('After compaction');
  const followUp = requests.find((messages) => messages.at(-1)?.content === 'After compaction');
  assert.ok(followUp?.some((message) => message.content.includes('Conversation compacted')));
});

test('a failed autosave warns without losing the live chat and can be retried', async () => {
  respond = toolProvider([]);
  const subject = makeController('save-failure');
  const warningsBefore = dialogs.warnings.length;
  renameFailures = 1;
  await subject.controller.run('Keep despite save error');
  assert.ok(dialogs.warnings.slice(warningsBefore).some((message) => /could not save/i.test(message)));
  assert.ok(subject.controller.getTranscript().some((item) => item.kind === 'user' && item.text === 'Keep despite save error'));
  await subject.controller.shutdown();
  const reopened = makeController('save-failure');
  await reopened.controller.whenReady();
  assert.ok(reopened.controller.getTranscript().some((item) => item.kind === 'user' && item.text === 'Keep despite save error'));
});

/* -------------------------------------------------------- save settings */

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function simpleProvider(requests: ChatMessage[][] = []): (request: ChatRequest) => Promise<ProviderResponse> {
  return async (request) => {
    requests.push(plain(request.messages));
    const lastUser = [...request.messages].reverse().find((message) => message.role === 'user');
    const text = `Answer to ${lastUser?.content ?? ''}`;
    request.onDelta?.(text);
    return { text, toolCalls: [] };
  };
}

async function customChatFiles(folder: string): Promise<string[]> {
  return (await fs.promises.readdir(folder))
    .filter((name) => /^coding-harness-chat-[a-f0-9]{24}\.json$/.test(name))
    .sort()
    .map((name) => path.join(folder, name));
}

test('opting out skips restore and autosave while manual import and export remain available', async () => {
  respond = simpleProvider();
  const source = makeController('opt-out');
  await source.controller.run('Previously saved');
  const oldFile = path.join(source.storage, 'current-chat.json');
  const oldBytes = await fs.promises.readFile(oldFile, 'utf8');
  const oldExport = path.join(root, 'opt-out-import.json');
  dialogs.save = uri(oldExport);
  await source.controller.exportChat();

  settings['chat.saveEnabled'] = false;
  const subject = makeController('opt-out');
  await subject.controller.whenReady();
  assert.deepEqual(subject.controller.getTranscript(), [], 'disabled saving does not restore an old chat');
  await subject.controller.run('Only in memory');
  const privateExport = path.join(root, 'opt-out-export.json');
  dialogs.save = uri(privateExport);
  await subject.controller.exportChat();
  assert.ok(parseChatArchive(await fs.promises.readFile(privateExport, 'utf8')).history.some((m) => m.content === 'Only in memory'));
  dialogs.open = [uri(oldExport)];
  dialogs.confirm = 'Replace Chat';
  await subject.controller.importChat();
  await subject.controller.run('Follow-up while disabled');
  await subject.controller.shutdown();
  assert.equal(await fs.promises.readFile(oldFile, 'utf8'), oldBytes, 'turning saving off leaves the previous file untouched');

  const stillDisabled = makeController('opt-out');
  await stillDisabled.controller.whenReady();
  assert.deepEqual(stillDisabled.controller.getTranscript(), []);

  settings['chat.saveEnabled'] = true;
  await subject.controller.refreshState();
  const reopened = makeController('opt-out');
  await reopened.controller.whenReady();
  const transcript = reopened.controller.getTranscript();
  assert.ok(transcript.some((item) => item.kind === 'user' && item.text === 'Previously saved'));
  assert.ok(transcript.some((item) => item.kind === 'user' && item.text === 'Follow-up while disabled'));
  assert.ok(!transcript.some((item) => item.kind === 'user' && item.text === 'Only in memory'));
});

test('a reset while saving is disabled is persisted when saving is turned on again', async () => {
  respond = simpleProvider();
  const subject = makeController('disabled-reset');
  await subject.controller.run('Clear this');
  const file = path.join(subject.storage, 'current-chat.json');
  const previous = await fs.promises.readFile(file, 'utf8');
  settings['chat.saveEnabled'] = false;
  await subject.controller.refreshState();
  await subject.controller.reset();
  assert.equal(await fs.promises.readFile(file, 'utf8'), previous);
  settings['chat.saveEnabled'] = true;
  await subject.controller.refreshState();
  const reopened = makeController('disabled-reset');
  await reopened.controller.whenReady();
  assert.deepEqual(reopened.controller.getTranscript(), [], 'an explicit reset does not revive the old chat');
});

test('disabling saving cancels an in-flight temporary write and preserves the old file', { timeout: 6000 }, async () => {
  respond = simpleProvider();
  const subject = makeController('disable-during-write');
  await subject.controller.run('Old snapshot');
  const file = path.join(subject.storage, 'current-chat.json');
  const oldBytes = await fs.promises.readFile(file, 'utf8');
  const entered = deferred();
  const release = deferred();
  writeGate = { entered: entered.resolve, wait: release.promise };
  const running = subject.controller.run('Private follow-up');
  try {
    await entered.promise;
    settings['chat.saveEnabled'] = false;
    const changing = subject.controller.refreshState();
    release.resolve();
    await Promise.all([running, changing]);
    assert.equal(await fs.promises.readFile(file, 'utf8'), oldBytes);
    assert.ok(!(await fs.promises.readdir(subject.storage)).some((name) => name.endsWith('.tmp')), 'temporary data is cleaned up');
    assert.ok(subject.controller.getTranscript().some((item) => item.kind === 'user' && item.text === 'Private follow-up'));
    const disabled = makeController('disable-during-write');
    await disabled.controller.whenReady();
    assert.deepEqual(disabled.controller.getTranscript(), []);
    settings['chat.saveEnabled'] = true;
    await subject.controller.refreshState();
    const reopened = makeController('disable-during-write');
    await reopened.controller.whenReady();
    assert.ok(reopened.controller.getTranscript().some((item) => item.kind === 'user' && item.text === 'Private follow-up'));
  } finally {
    release.resolve();
    await running;
  }
});

test('changing folder cancels a stale in-flight write and saves the current chat at the new location', { timeout: 6000 }, async () => {
  const requests: ChatMessage[][] = [];
  respond = simpleProvider(requests);
  const subject = makeController('move-during-write');
  await subject.controller.run('First question');
  const oldFile = path.join(subject.storage, 'current-chat.json');
  const oldBytes = await fs.promises.readFile(oldFile, 'utf8');
  const newFolder = path.join(root, 'save-folder', 'nested');
  const entered = deferred();
  const release = deferred();
  writeGate = { entered: entered.resolve, wait: release.promise };
  const running = subject.controller.run('Second question');
  try {
    await entered.promise;
    settings['chat.saveFolder'] = newFolder;
    const changing = subject.controller.refreshState();
    release.resolve();
    await Promise.all([running, changing]);
    assert.equal(await fs.promises.readFile(oldFile, 'utf8'), oldBytes, 'moving does not alter or delete the previous file');
    assert.ok(!(await fs.promises.readdir(subject.storage)).some((name) => name.endsWith('.tmp')));
    const files = await customChatFiles(newFolder);
    assert.equal(files.length, 1);
    const saved = parseChatArchive(await fs.promises.readFile(files[0], 'utf8'));
    assert.ok(saved.history.some((message) => message.content === 'First question'));
    assert.ok(saved.history.some((message) => message.content === 'Second question'));

    const reopened = makeController('move-during-write');
    await reopened.controller.whenReady();
    await reopened.controller.run('Continue in new folder');
    const followUp = requests.find((messages) => messages.at(-1)?.content === 'Continue in new folder');
    assert.ok(followUp?.some((message) => message.content === 'First question'));
    assert.ok(followUp?.some((message) => message.content === 'Second question'));
    const customBytes = await fs.promises.readFile(files[0], 'utf8');
    settings['chat.saveFolder'] = '';
    await reopened.controller.refreshState();
    assert.equal(await fs.promises.readFile(files[0], 'utf8'), customBytes, 'moving back also leaves the old file intact');
    const backInDefault = makeController('move-during-write');
    await backInDefault.controller.whenReady();
    assert.ok(backInDefault.controller.getTranscript().some((item) => item.kind === 'user' && item.text === 'Continue in new folder'));
  } finally {
    release.resolve();
    await running;
  }
});

test('save folders resolve relative paths, home paths and remote filesystem URIs', async () => {
  respond = simpleProvider();
  settings['chat.saveFolder'] = '.harness/saved-chats';
  const subject = makeController('relative-folder');
  await subject.controller.run('Relative folder');
  const relativeFolder = path.join(root, '.harness', 'saved-chats');
  const [relativeFile] = await customChatFiles(relativeFolder);
  assert.ok(relativeFile);
  assert.ok(parseChatArchive(await fs.promises.readFile(relativeFile, 'utf8')).history.some((m) => m.content === 'Relative folder'));
  assert.ok(!fs.existsSync(path.join(subject.storage, 'current-chat.json')), 'custom saves do not fall back to workspace storage');
  await subject.controller.shutdown();

  settings['chat.saveFolder'] = '~/coding-harness-test';
  let resolved = (subject.controller as any).readChatSaveSettings();
  assert.equal(resolved.location.directory.fsPath, path.join(os.homedir(), 'coding-harness-test'));
  settings['chat.saveFolder'] = '~';
  resolved = (subject.controller as any).readChatSaveSettings();
  assert.equal(resolved.location.directory.fsPath, os.homedir());

  vscodeStub.workspace.workspaceFolders[0].uri = uri(root, 'vscode-remote', 'ssh-remote+server');
  settings['chat.saveFolder'] = '/var/chats';
  resolved = (subject.controller as any).readChatSaveSettings();
  assert.equal(resolved.location.directory.scheme, 'vscode-remote');
  assert.equal(resolved.location.directory.authority, 'ssh-remote+server');
  assert.equal(resolved.location.directory.path, '/var/chats');
  settings['chat.saveFolder'] = 'relative/chats';
  resolved = (subject.controller as any).readChatSaveSettings();
  assert.equal(resolved.location.directory.scheme, 'vscode-remote');
  assert.equal(resolved.location.directory.path, path.join(root, 'relative', 'chats'));
});

test('a shared save folder isolates workspaces and saved multi-root workspace files', async () => {
  respond = simpleProvider();
  const folder = path.join(root, 'shared-chats');
  settings['chat.saveFolder'] = folder;
  const first = makeController('shared-a');
  await first.controller.run('Workspace A');

  const secondRoot = path.join(root, 'second-workspace');
  await fs.promises.mkdir(secondRoot, { recursive: true });
  vscodeStub.workspace.workspaceFolders = [{ uri: uri(secondRoot), name: 'other', index: 0 }];
  const second = makeController('shared-b');
  await second.controller.run('Workspace B');
  const reopenedSecond = makeController('shared-b');
  await reopenedSecond.controller.whenReady();
  assert.ok(reopenedSecond.controller.getTranscript().some((item) => item.kind === 'user' && item.text === 'Workspace B'));
  assert.ok(!reopenedSecond.controller.getTranscript().some((item) => item.kind === 'user' && item.text === 'Workspace A'));

  vscodeStub.workspace.workspaceFolders = [{ uri: uri(root), name: 'test', index: 0 }];
  const reopenedFirst = makeController('shared-a');
  await reopenedFirst.controller.whenReady();
  assert.ok(reopenedFirst.controller.getTranscript().some((item) => item.kind === 'user' && item.text === 'Workspace A'));
  assert.ok(!reopenedFirst.controller.getTranscript().some((item) => item.kind === 'user' && item.text === 'Workspace B'));

  vscodeStub.workspace.workspaceFile = uri(path.join(root, 'one.code-workspace'));
  const multiOne = makeController('shared-multi-one');
  await multiOne.controller.run('Multi-root one');
  vscodeStub.workspace.workspaceFile = uri(path.join(root, 'two.code-workspace'));
  const multiTwo = makeController('shared-multi-two');
  await multiTwo.controller.run('Multi-root two');
  assert.equal((await customChatFiles(folder)).length, 4, 'each workspace gets a different stable file');
  vscodeStub.workspace.workspaceFile = uri(path.join(root, 'one.code-workspace'));
  const reopenedMulti = makeController('shared-multi-one');
  await reopenedMulti.controller.whenReady();
  assert.ok(reopenedMulti.controller.getTranscript().some((item) => item.kind === 'user' && item.text === 'Multi-root one'));
  assert.ok(!reopenedMulti.controller.getTranscript().some((item) => item.kind === 'user' && item.text === 'Multi-root two'));
});

test('opting out during startup does not restore an in-flight read', { timeout: 6000 }, async () => {
  respond = simpleProvider();
  const source = makeController('disable-during-restore');
  await source.controller.run('Old chat');
  const file = path.join(source.storage, 'current-chat.json');
  const original = await fs.promises.readFile(file, 'utf8');
  const entered = deferred();
  const release = deferred();
  readGate = { file, entered: entered.resolve, wait: release.promise };
  const subject = makeController('disable-during-restore');
  try {
    await entered.promise;
    settings['chat.saveEnabled'] = false;
    const changing = subject.controller.refreshState();
    release.resolve();
    await Promise.all([subject.controller.whenReady(), changing]);
    assert.deepEqual(subject.controller.getTranscript(), []);
    await subject.controller.shutdown();
    assert.equal(await fs.promises.readFile(file, 'utf8'), original);
  } finally {
    release.resolve();
    await subject.controller.whenReady();
  }
});

test('changing the folder during startup restores the latest destination, not the stale one', { timeout: 6000 }, async () => {
  respond = simpleProvider();
  const original = makeController('move-during-restore');
  await original.controller.run('Default chat');
  const defaultFile = path.join(original.storage, 'current-chat.json');
  const folder = path.join(root, 'alternate-startup-folder');
  settings['chat.saveFolder'] = folder;
  const alternate = makeController('alternate-startup');
  await alternate.controller.run('Alternate chat');
  settings['chat.saveFolder'] = '';

  const entered = deferred();
  const release = deferred();
  readGate = { file: defaultFile, entered: entered.resolve, wait: release.promise };
  const subject = makeController('move-during-restore');
  try {
    await entered.promise;
    settings['chat.saveFolder'] = folder;
    const changing = subject.controller.refreshState();
    release.resolve();
    await Promise.all([subject.controller.whenReady(), changing]);
    assert.ok(subject.controller.getTranscript().some((item) => item.kind === 'user' && item.text === 'Alternate chat'));
    assert.ok(!subject.controller.getTranscript().some((item) => item.kind === 'user' && item.text === 'Default chat'));
  } finally {
    release.resolve();
    await subject.controller.whenReady();
  }
});

test('an invalid or unwritable custom folder warns, keeps the chat, and can be corrected', async () => {
  respond = simpleProvider();
  settings['chat.saveFolder'] = 'bad\0folder';
  const warningCount = dialogs.warnings.length;
  const subject = makeController('invalid-folder');
  await subject.controller.run('Do not lose this');
  assert.ok(dialogs.warnings.slice(warningCount).some((message) => /could not use the chat saving settings/i.test(message)));
  assert.ok(!fs.existsSync(path.join(subject.storage, 'current-chat.json')));
  const notADirectory = path.join(root, 'not-a-directory');
  await fs.promises.writeFile(notADirectory, 'a file');
  settings['chat.saveFolder'] = notADirectory;
  await subject.controller.refreshState();
  assert.ok(dialogs.warnings.slice(warningCount).some((message) => /could not save/i.test(message)));
  assert.ok(subject.controller.getTranscript().some((item) => item.kind === 'user' && item.text === 'Do not lose this'));
  const goodFolder = path.join(root, 'corrected-save-folder');
  settings['chat.saveFolder'] = goodFolder;
  await subject.controller.refreshState();
  const [file] = await customChatFiles(goodFolder);
  assert.ok(parseChatArchive(await fs.promises.readFile(file, 'utf8')).history.some((m) => m.content === 'Do not lose this'));
});

test('choosing an empty destination does not overwrite an existing saved chat until the current chat changes', async () => {
  respond = simpleProvider();
  const folder = path.join(root, 'existing-destination');
  settings['chat.saveFolder'] = folder;
  const saved = makeController('empty-destination-source');
  await saved.controller.run('Keep existing chat');
  const [file] = await customChatFiles(folder);
  const original = await fs.promises.readFile(file, 'utf8');
  settings['chat.saveFolder'] = '';
  const empty = makeController('empty-destination-target');
  await empty.controller.whenReady();
  settings['chat.saveFolder'] = folder;
  await empty.controller.refreshState();
  await empty.controller.shutdown();
  assert.equal(await fs.promises.readFile(file, 'utf8'), original);
  assert.deepEqual(empty.controller.getTranscript(), [], 'changing the folder never replaces the live chat');
});

test('a configured destination with an older chat is replaced by the current chat, without deleting the old source', async () => {
  respond = simpleProvider();
  const folder = path.join(root, 'overwrite-destination');
  settings['chat.saveFolder'] = folder;
  const old = makeController('overwrite-old');
  await old.controller.run('Older destination chat');
  const [file] = await customChatFiles(folder);

  settings['chat.saveFolder'] = '';
  const current = makeController('overwrite-current');
  await current.controller.run('Current chat');
  const oldSource = path.join(current.storage, 'current-chat.json');
  const sourceBytes = await fs.promises.readFile(oldSource, 'utf8');
  settings['chat.saveFolder'] = folder;
  await current.controller.refreshState();
  const replaced = parseChatArchive(await fs.promises.readFile(file, 'utf8'));
  assert.ok(replaced.history.some((message) => message.content === 'Current chat'));
  assert.ok(!replaced.history.some((message) => message.content === 'Older destination chat'));
  assert.equal(await fs.promises.readFile(oldSource, 'utf8'), sourceBytes);
  assert.ok(current.controller.getTranscript().some((item) => item.kind === 'user' && item.text === 'Current chat'));
});

test('changing the folder during a running task saves its progress and final result there', { timeout: 6000 }, async () => {
  const entered = deferred();
  const release = deferred();
  respond = async (request) => {
    request.onDelta?.('Partial output');
    entered.resolve();
    await release.promise;
    return { text: 'Partial output', toolCalls: [] };
  };
  const subject = makeController('folder-during-task');
  const running = subject.controller.run('Active question');
  try {
    await entered.promise;
    const folder = path.join(root, 'live-task-saves');
    settings['chat.saveFolder'] = folder;
    await subject.controller.refreshState();
    const [file] = await customChatFiles(folder);
    const live = parseChatArchive(await fs.promises.readFile(file, 'utf8'));
    assert.equal(live.inProgress, true);
    assert.ok(live.history.some((message) => message.content === 'Active question'));
    assert.ok(live.history.some((message) => message.content === 'Partial output'));
    release.resolve();
    await running;
    const complete = parseChatArchive(await fs.promises.readFile(file, 'utf8'));
    assert.equal(complete.inProgress, false);
    assert.ok(complete.history.some((message) => message.content === 'Partial output'));
    assert.ok(!fs.existsSync(path.join(subject.storage, 'current-chat.json')));
  } finally {
    release.resolve();
    await running;
  }
});

test('invalid setting types fail closed instead of accidentally saving', async () => {
  respond = simpleProvider();
  settings['chat.saveEnabled'] = 'false';
  const warnings = dialogs.warnings.length;
  const subject = makeController('invalid-enabled-type');
  await subject.controller.run('Must stay in memory');
  await subject.controller.shutdown();
  assert.ok(dialogs.warnings.slice(warnings).some((message) => /chat saving settings/i.test(message)));
  assert.ok(!fs.existsSync(path.join(subject.storage, 'current-chat.json')));
  settings['chat.saveEnabled'] = true;
  settings['chat.saveFolder'] = 123;
  await subject.controller.refreshState();
  assert.ok(!fs.existsSync(path.join(subject.storage, 'current-chat.json')), 'an invalid folder never falls back to default storage');
  settings['chat.saveFolder'] = '';
  await subject.controller.refreshState();
  const saved = parseChatArchive(await fs.promises.readFile(path.join(subject.storage, 'current-chat.json'), 'utf8'));
  assert.ok(saved.history.some((message) => message.content === 'Must stay in memory'));
});

test('shutdown applies changed save settings even if the configuration event has not run', async () => {
  respond = simpleProvider();
  const subject = makeController('shutdown-pending-settings');
  await subject.controller.run('Save before closing');
  const folder = path.join(root, 'shutdown-destination');
  settings['chat.saveFolder'] = folder;
  await subject.controller.shutdown();
  const [file] = await customChatFiles(folder);
  const archive = parseChatArchive(await fs.promises.readFile(file, 'utf8'));
  assert.ok(archive.history.some((message) => message.content === 'Save before closing'));
});
