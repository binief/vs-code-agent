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
fs.writeFileSync(path.join(root, 'agent.md'), '---\ntools: [read, search, edit, execute]\n---\n');

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
    getConfiguration: () => ({ get: (key: string) => settings[key], inspect: (key: string) => ({ key, defaultValue: false }), update: async (key: string, value: unknown, _target: number) => { settings[key] = value; } }),
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
  ConfigurationTarget: { Global: 1, Workspace: 2 },
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

/** Backing store for the stubbed `context.workspaceState`. */
const workspaceStateStore = new Map<string, unknown>();

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
  const context = {
    secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined },
    workspaceState: {
      get: (key: string) => workspaceStateStore.get(key),
      update: async (key: string, value: unknown) => {
        if (value === undefined) workspaceStateStore.delete(key);
        else workspaceStateStore.set(key, value);
      },
    },
  };

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

test('the panel gets a thinking lane that streams then collapses', async () => {
  const { controller, messages } = makeController();
  await controller.run('create a python script called think.py that prints hello');

  const thinkingItems = controller.getTranscript().filter((i: any) => i.kind === 'thinking') as any[];
  assert.ok(thinkingItems.length >= 2, `expected one lane per turn, got ${thinkingItems.length}`);

  const created = messages.find((m) => m.type === 'item' && m.item?.kind === 'thinking')?.item;
  assert.ok(created, 'the lane must be created as soon as reasoning arrives');
  assert.equal(created.streaming, true, 'it starts in the streaming state');
  assert.equal(created.text, '', 'and grows in place from empty');
  assert.ok(created.startedAt > 0, 'start time drives the live indicator');

  const updates = messages.filter((m) => m.type === 'update' && m.item?.kind === 'thinking');
  assert.ok(updates.length >= 2, `expected progressive repaints, got ${updates.length}`);

  for (const lane of thinkingItems) {
    assert.equal(lane.streaming, false, 'every lane is closed when its turn ends');
    assert.ok(lane.text.length > 20, 'and keeps the rationale text');
    assert.ok(lane.durationMs >= 0, 'with a duration to display');
  }

  // Thinking must not be mixed into the assistant bubbles.
  const assistantText = controller
    .getTranscript()
    .filter((i: any) => i.kind === 'assistant')
    .map((i: any) => i.text)
    .join('\n');
  assert.ok(!assistantText.includes('I do not know the layout of this workspace'), 'reasoning leaked into answers');
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

/* ------------------------------------------------- agent file selection */

test('the agents picker pins a subset, persists it and keeps the chip honest', async () => {
  const { controller, messages } = makeController();
  fs.writeFileSync(path.join(root, 'agent.md'), 'root rules\n');
  fs.mkdirSync(path.join(root, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', 'code-review.md'), 'review rules\n');

  // Default is "everything discovered".
  const initial = await controller.getAgentSettings();
  assert.equal(initial.selection, null);
  assert.deepEqual(initial.files.map((file) => file.displayPath).sort(), ['.agents/code-review.md', 'agent.md']);
  assert.ok(initial.files.every((file) => file.active));
  assert.equal(controller.getState().agentFilesAvailable, 2);

  await controller.saveAgentSelection(['agent.md']);
  const saved = messages.filter((message) => message.type === 'agent-settings-saved').pop();
  assert.equal(saved.ok, true);
  assert.deepEqual(saved.selection, ['agent.md']);
  assert.deepEqual(workspaceStateStore.get('codingHarness.agentSelection'), ['agent.md'], 'the pin is stored per workspace');

  const state = controller.getState();
  assert.deepEqual(state.agentFiles?.map((file) => file.displayPath), ['agent.md'], 'only the pinned file is active');
  assert.equal(state.agentFilesCount, 1);
  assert.equal(state.agentFilesAvailable, 2, 'the chip shows 1/2');

  // A pin that names nothing that exists must be refused, not silently applied.
  await controller.saveAgentSelection(['nope.md']);
  const failed = messages.filter((message) => message.type === 'agent-settings-saved').pop();
  assert.equal(failed.ok, false);
  assert.match(failed.error, /exist|found/i);
  assert.deepEqual(controller.getState().agentFiles?.map((file) => file.displayPath), ['agent.md'], 'the old pin survives');

  // null restores every discovered file and clears the stored pin.
  await controller.saveAgentSelection(null);
  assert.equal(controller.getState().agentFiles?.length, 2);
  assert.equal(workspaceStateStore.get('codingHarness.agentSelection'), undefined);

  fs.rmSync(path.join(root, '.agents'), { recursive: true, force: true });
  fs.rmSync(path.join(root, 'agent.md'), { force: true });
});

test('subagents setting is off by default and follows VS Code configuration', () => {
  const { controller } = makeController();
  try {
    assert.equal(controller.readConfig().subagentsEnabled, false);
    settings['subagents.enabled'] = true;
    assert.equal(controller.readConfig().subagentsEnabled, true);
    settings['subagents.enabled'] = false;
    assert.equal(controller.readConfig().subagentsEnabled, false);
  } finally { delete settings['subagents.enabled']; }
});

test('context preview resolves explicit delegation permission with the setting on and off', async () => {
  const { controller } = makeController();
  const file = path.join(root, 'agent.md');
  const previous = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
  const openDocument = vscodeStub.workspace.openTextDocument;
  const showDocument = vscodeStub.window.showTextDocument;
  let preview = '';
  try {
    fs.writeFileSync(file, '---\ntools: [read, delegate_task]\n---\nInstructions.');
    (vscodeStub.workspace as any).openTextDocument = async (value: { content: string }) => { preview = value.content; return {}; };
    (vscodeStub.window as any).showTextDocument = async () => ({});
    settings['subagents.enabled'] = false;
    await controller.previewContext();
    assert.ok(preview.includes('read_file'));
    assert.ok(!preview.includes('delegate_task'));
    settings['subagents.enabled'] = true;
    await controller.previewContext();
    assert.ok(preview.includes('delegate_task'));
  } finally {
    if (previous === undefined) fs.rmSync(file, { force: true }); else fs.writeFileSync(file, previous);
    vscodeStub.workspace.openTextDocument = openDocument;
    vscodeStub.window.showTextDocument = showDocument;
    delete settings['subagents.enabled'];
  }
});

test('quick settings persist and read back both feature toggles', async () => {
  const { controller, messages } = makeController();
  try {
    assert.equal(controller.getFeatureSettings().subagentsEnabled, false);
    assert.equal(controller.getFeatureSettings().localFallback, false);
    await controller.saveFeatureSettings({ subagentsEnabled: true, localFallback: true, target: 'workspace' });
    assert.equal(settings['subagents.enabled'], true);
    assert.equal(settings['compaction.localFallback'], true);
    assert.equal(controller.readConfig().subagentsEnabled, true);
    assert.equal(controller.readConfig().compaction.localFallback, true);
    assert.ok(messages.some((m) => m.type === 'feature-settings-saved' && m.ok && m.settings.localFallback));
    await controller.saveFeatureSettings({ subagentsEnabled: false, localFallback: false, target: 'user' });
    assert.equal(controller.readConfig().subagentsEnabled, false);
    assert.equal(controller.readConfig().compaction.localFallback, false);
    await controller.saveFeatureSettings({ subagentsEnabled: 'true', localFallback: true, target: 'workspace' });
    assert.ok(messages.some((m) => m.type === 'feature-settings-saved' && !m.ok && /Invalid/.test(m.error)));
  } finally {
    delete settings['subagents.enabled'];
    delete settings['compaction.localFallback'];
  }
});

test('subagent progress is reflected in the live activity strip and clears on completion', () => {
  const { controller, messages } = makeController();
  (controller as any).handleEvent({ type: 'subagent-progress', step: 2 });
  assert.equal(controller.getActivity().status, 'subagent');
  assert.match(controller.getActivity().detail ?? '', /step 2/);
  (controller as any).handleEvent({ type: 'subagent-progress', tool: 'read_file' });
  assert.match(controller.getActivity().detail ?? '', /read_file/);
  (controller as any).handleEvent({ type: 'tool-end', id: 'd', name: 'delegate_task', ok: true, summary: 'subagent finished', detail: '', durationMs: 10 });
  assert.equal(controller.getActivity().status, 'thinking');
  assert.ok(messages.some((message) => message.type === 'activity' && message.activity.status === 'subagent'));
});

test('unregistered feature settings are detected before either value is written', async () => {
  const originalConfig = vscodeStub.workspace.getConfiguration;
  try {
    for (const missing of ['subagents.enabled', 'compaction.localFallback']) {
      let writes = 0;
      (vscodeStub.workspace as any).getConfiguration = () => ({
        get: (key: string) => settings[key],
        // A user value alone is not proof that VS Code registered the schema.
        inspect: (key: string) => key === missing ? { key, workspaceValue: true } : { key, defaultValue: false },
        update: async () => { writes++; },
      });
      const { controller, messages } = makeController();
      await controller.saveFeatureSettings({ subagentsEnabled: true, localFallback: true, target: 'workspace' });
      assert.equal(writes, 0);
      const result = messages.find((message) => message.type === 'feature-settings-saved');
      assert.equal(result.ok, false);
      assert.match(result.error, new RegExp(`codingHarness\\.${missing.replace('.', '\\.')}`));
      assert.match(result.error, /No settings were changed/);
      assert.match(result.error, /Developer: Reload Window/);
    }
  } finally { vscodeStub.workspace.getConfiguration = originalConfig; }
});

test('registry errors during a write report partial success and reload guidance', async () => {
  const originalConfig = vscodeStub.workspace.getConfiguration;
  try {
    const written: string[] = [];
    (vscodeStub.workspace as any).getConfiguration = () => ({
      get: (key: string) => settings[key],
      inspect: (key: string) => ({ key, defaultValue: false }),
      update: async (key: string, value: unknown) => {
        if (key === 'compaction.localFallback') throw new Error('codingHarness.compaction.localFallback is not a registered configuration');
        written.push(key);
        settings[key] = value;
      },
    });
    const { controller, messages } = makeController();
    await controller.saveFeatureSettings({ subagentsEnabled: true, localFallback: true, target: 'user' });
    assert.deepEqual(written, ['subagents.enabled']);
    const result = messages.find((message) => message.type === 'feature-settings-saved');
    assert.equal(result.ok, false);
    assert.match(result.error, /Some settings may have changed/);
    assert.match(result.error, /Developer: Reload Window/);
    assert.equal(result.settings.subagentsEnabled, true);
    assert.equal(result.settings.localFallback, false);
  } finally {
    delete settings['subagents.enabled'];
    vscodeStub.workspace.getConfiguration = originalConfig;
  }
});

test('unrelated settings failures keep their actual error rather than suggesting reload', async () => {
  const originalConfig = vscodeStub.workspace.getConfiguration;
  try {
    (vscodeStub.workspace as any).getConfiguration = () => ({
      get: (key: string) => settings[key],
      inspect: (key: string) => ({ key, defaultValue: false }),
      update: async () => { throw new Error('settings file is read-only'); },
    });
    const { controller, messages } = makeController();
    await controller.saveFeatureSettings({ subagentsEnabled: true, localFallback: true, target: 'workspace' });
    const result = messages.find((message) => message.type === 'feature-settings-saved');
    assert.match(result.error, /read-only/);
    assert.match(result.error, /Some settings may have changed/);
    assert.doesNotMatch(result.error, /Reload Window/);
  } finally { vscodeStub.workspace.getConfiguration = originalConfig; }
});

test('compaction diagnostics are bounded, clearable, and label child requests', () => {
  const { controller } = makeController();
  const emit = (trace: any, source?: 'main' | 'subagent') => (controller as any).handleEvent({ type: 'compaction-trace', trace, source });
  emit({ kind: 'begin' });
  for (let request = 1; request <= 12; request++) {
    emit({ kind: 'request', request, attempt: 1, model: 'model', maxTokens: 512, streaming: true,
      prompt: 'p'.repeat(49_000), images: [{ name: 'screen.png', mediaType: 'image/png' }] }, 'subagent');
    emit({ kind: 'delta', request, channel: 'response', text: 'r'.repeat(60_000) }, 'subagent');
    emit({ kind: 'complete', request, text: 'r'.repeat(60_000), finishReason: 'stop', toolCalls: [] }, 'subagent');
  }
  const trace = controller.getCompactionTrace();
  assert.equal(trace.entries.length, 10);
  assert.equal(trace.dropped, 2);
  assert.equal(trace.entries[0].request, 3);
  assert.equal(trace.entries[0].source, 'subagent');
  assert.match(trace.entries[0].prompt, /display truncated/);
  assert.match(trace.entries[0].response, /display truncated/);
  assert.ok(trace.entries[0].response.length < 48_100);
  controller.clearCompactionTrace();
  emit({ kind: 'delta', request: 12, channel: 'response', text: 'late fragment' }, 'subagent');
  assert.deepEqual(controller.getCompactionTrace().entries, []);
  emit({ kind: 'request', request: 13, attempt: 1, model: 'model', maxTokens: 512, streaming: false, prompt: 'next', images: [] }, 'subagent');
  assert.equal(controller.getCompactionTrace().entries[0].request, 13);
});
