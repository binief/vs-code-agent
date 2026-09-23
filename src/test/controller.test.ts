import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as Module from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, test } from 'node:test';

/**
 * These tests drive the real {@link HarnessController} — the layer that turns
 * core events into panel messages — against a stubbed `vscode` module.
 *
 * That is the only way to check the thing the user actually sees without
 * launching an editor: which messages are posted, in what order, and how the
 * streamed text is accumulated and finalised.
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-controller-'));

const settings: Record<string, unknown> = {
  provider: 'mock',
  model: 'mock',
  baseUrl: '',
  apiKey: '',
  maxSteps: 8,
  temperature: 0.2,
  maxOutputTokens: 1024,
  editPolicy: 'auto',
  commandPolicy: 'auto-safe',
  allowDangerousCommands: false,
  commandTimeoutMs: 10_000,
  allowOutsideWorkspace: false,
  maxFileBytes: 262_144,
  includeDiagnosticsInPrompt: false,
  systemPromptExtra: '',
  stream: true,
};

class StubDisposable {
  constructor(private readonly fn?: () => void) {}
  dispose(): void {
    this.fn?.();
  }
}

const vscodeStub = {
  workspace: {
    workspaceFolders: [{ uri: { fsPath: root }, name: 'stub', index: 0 }],
    getConfiguration: () => ({ get: (key: string) => settings[key] }),
    onDidChangeConfiguration: () => new StubDisposable(),
    onDidChangeWorkspaceFolders: () => new StubDisposable(),
    registerTextDocumentContentProvider: () => new StubDisposable(),
    // Deliberately unsupported: the host must fall back to plain fs writes.
    openTextDocument: async () => {
      throw new Error('stub: openTextDocument unavailable');
    },
    applyEdit: async () => false,
    asRelativePath: (p: string) => p,
  },
  window: {
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    showInformationMessage: async () => undefined,
    showTextDocument: async () => {
      throw new Error('stub');
    },
    createOutputChannel: () => ({ appendLine: () => {}, show: () => {}, dispose: () => {} }),
    registerWebviewViewProvider: () => new StubDisposable(),
    activeTextEditor: undefined,
  },
  commands: { executeCommand: async () => undefined },
  Uri: { file: (p: string) => ({ fsPath: p }), joinPath: (...parts: unknown[]) => parts, from: (o: unknown) => o },
  Range: class {},
  Position: class {},
  WorkspaceEdit: class {
    replace(): void {}
    insert(): void {}
    createFile(): void {}
  },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  Disposable: StubDisposable,
  EventEmitter: class {
    event = () => new StubDisposable();
    fire(): void {}
    dispose(): void {}
  },
  languages: { getDiagnostics: () => new Map() },
};

// Intercept `require('vscode')` before the controller module is loaded.
const moduleProto = Module as unknown as { prototype: { require: (id: string) => unknown } };
const originalRequire = moduleProto.prototype.require;
moduleProto.prototype.require = function patchedRequire(this: unknown, id: string): unknown {
  if (id === 'vscode') return vscodeStub;
  return originalRequire.call(this, id);
};

/* Loaded after the stub is installed (CommonJS require, so it happens lazily). */
const { HarnessController } = require('../vscode/controller') as typeof import('../vscode/controller');

after(() => {
  moduleProto.prototype.require = originalRequire;
  fs.rmSync(root, { recursive: true, force: true });
});

function makeController() {
  const messages: any[] = [];
  const log = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
  const approvals = {
    request: async () => 'apply',
    resolve: () => {},
    cancelAll: () => {},
    rememberAlways: () => {},
    isAutoApproved: () => false,
    setBridge: () => {},
    forgetAll: () => {},
  };
  const proposals = { add: () => ({ toString: () => 'stub' }), dispose: () => {} };
  const context = { secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined } };

  const controller = new HarnessController(context as any, log as any, approvals as any, proposals as any);
  controller.onUiMessage((message) => messages.push(message));
  return { controller, messages };
}

test('the panel receives streamed text progressively, not in one lump', async () => {
  const { controller, messages } = makeController();
  await controller.run('create a python script called greet.py that prints hello');

  const itemPosts = messages.filter((m) => m.type === 'item');
  const updatePosts = messages.filter((m) => m.type === 'update');

  // Assistant bubbles are created with a stream id and grow in place.
  const assistantUpdates = updatePosts.filter((m) => m.item?.kind === 'assistant');
  assert.ok(assistantUpdates.length >= 2, `expected several repaints, got ${assistantUpdates.length}`);

  const firstAssistant = itemPosts.find((m) => m.item?.kind === 'assistant')?.item;
  assert.ok(firstAssistant, 'an assistant bubble must be created as soon as text arrives');
  assert.ok(firstAssistant.streaming, 'it is marked as streaming while text is arriving');
  assert.equal(firstAssistant.text, '', 'the bubble starts empty and fills up');

  // Within one turn the text only ever grows; turns are separate streams.
  const byId = new Map<string, string[]>();
  for (const update of assistantUpdates) {
    const list = byId.get(update.item.id) ?? [];
    list.push(update.item.text as string);
    byId.set(update.item.id, list);
  }
  assert.ok(byId.size >= 2, `expected one stream per turn, got ${byId.size}`);
  for (const [id, texts] of byId) {
    for (let i = 1; i < texts.length; i++) {
      assert.ok(texts[i].length >= texts[i - 1].length, `streamed text shrank within ${id}`);
    }
  }

  const transcript = controller.getTranscript().filter((i: any) => i.kind === 'assistant') as any[];
  assert.ok(transcript.length >= 2, 'narration for the actions plus a final summary');
  const lastTurn = transcript[transcript.length - 1];
  assert.equal(lastTurn.streaming, false, 'the final bubble stops showing the caret');
  assert.equal(lastTurn.final, true);
  assert.match(lastTurn.text, /Offline planner summary/);

  // Repaints are throttled: far fewer updates than streamed fragments.
  assert.ok(
    updatePosts.length < 60,
    `posts must be throttled, got ${updatePosts.length} updates for a streamed task`,
  );
});

test('every turn is finalised exactly once and keeps its own text', async () => {
  const { controller, messages } = makeController();
  await controller.reset();
  await controller.run('create a python script called twice.py that prints hello');

  const assistantTexts = controller
    .getTranscript()
    .filter((i: any) => i.kind === 'assistant')
    .map((i: any) => i.text);

  // The first narration belongs to the tool-using turn, the last to the summary.
  assert.ok(assistantTexts.some((t) => /Creating twice\.py/.test(t)), 'the action narration is preserved');
  assert.ok(assistantTexts.every((t) => typeof t === 'string' && t.length > 0), 'no empty bubbles are left behind');

  // Each bubble was created once (by its stream id) and never duplicated.
  const created = messages.filter((m) => m.type === 'item' && m.item?.kind === 'assistant').map((m) => m.item.id);
  assert.equal(new Set(created).size, created.length, 'stream ids must be unique per turn');
});

test('the activity strip reports each phase, including the tool being run', async () => {
  const { controller, messages } = makeController();
  await controller.run('create a python script called activity.py that prints hello');

  const activities = messages.filter((m) => m.type === 'activity').map((m) => m.activity);
  const executing = activities.find((a) => a.status === 'executing');
  assert.ok(executing, 'the strip must switch to "executing" while a tool runs');
  assert.ok(['list_files', 'write_file', 'run_command'].includes(executing.tool), `unexpected tool ${executing.tool}`);
  assert.ok(executing.startedAt > 0, 'the elapsed timer needs a start time');

  const detail = activities.map((a) => a.detail).filter(Boolean);
  assert.ok(detail.length > 0, 'the strip should say what is being touched');
  assert.ok(
    detail.some((d: string) => /\.py|--check|\./.test(d)),
    `expected a file or command detail, got ${JSON.stringify(detail)}`,
  );

  // Idle at the end so the strip disappears.
  assert.equal(activities[activities.length - 1].status, 'idle');
});

test('tool cards move from running to finished with a live start time', async () => {
  const { controller, messages } = makeController();
  await controller.run('create a python script called cards.py that prints hello');

  const running = messages.find((m) => m.type === 'item' && m.item?.kind === 'tool' && m.item.status === 'running');
  assert.ok(running, 'a tool card must appear when the tool starts');
  assert.ok(running.item.startedAt > 0, 'running cards carry a start time for the elapsed timer');

  const finished = messages.filter((m) => m.type === 'update' && m.item?.kind === 'tool');
  assert.ok(finished.length >= 2, 'each tool card is updated when it finishes');
  assert.ok(
    finished.every((m) => m.item.status === 'ok' || m.item.status === 'failed'),
    'finished cards report an outcome',
  );
  assert.ok(finished.every((m) => m.item.durationMs >= 0), 'finished cards report a duration');
  assert.ok(
    finished.some((m) => m.item.name === 'write_file' && m.item.relPath === 'cards.py'),
    'the write results name the file they touched',
  );
});

test('a finished task reports the outcome and the files it changed', async () => {
  const { controller, messages } = makeController();
  await controller.run('create a python script called outcome.py that prints hello');

  const done = messages.find((m) => m.type === 'item' && m.item?.kind === 'done');
  assert.ok(done, 'the panel gets a completion card');
  assert.equal(done.item.reason, 'complete');
  assert.ok(done.item.filesChanged.includes('outcome.py'), `got ${JSON.stringify(done.item.filesChanged)}`);
  assert.ok(fs.existsSync(path.join(root, 'outcome.py')), 'the file really exists on disk');
});

test('streaming can be disabled and the panel still renders each turn', async () => {
  settings.stream = false;
  try {
    const { controller, messages } = makeController();
    await controller.run('create a python script called plain.py that prints hello');

    const updates = messages.filter((m) => m.type === 'update' && m.item?.kind === 'assistant');
    assert.equal(updates.length, 0, 'no incremental repaints when streaming is off');

    const transcript = controller.getTranscript().filter((i: any) => i.kind === 'assistant') as any[];
    assert.ok(transcript.length >= 2, 'text still appears, just per turn');
    assert.ok(transcript.every((i) => !i.streaming), 'no bubble is left in the streaming state');
    assert.match(transcript[transcript.length - 1].text, /Offline planner summary/);
  } finally {
    settings.stream = true;
  }
});
