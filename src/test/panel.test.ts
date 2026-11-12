import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { after, test } from 'node:test';

/**
 * Rendering tests for the agent panel.
 *
 * The panel is plain HTML/CSS/JS with no browser in CI, so these tests mount
 * `media/panel.html` in jsdom exactly as the extension does (same four token
 * substitutions), evaluate `media/chat.js`, and drive it with the message shapes
 * `controller.ts` posts. That is the only way to catch the class of bug that
 * matters here: a streamed answer that is rebuilt on every token (killing the
 * scroll position), a reasoning lane that never folds, a collapsed tool row that
 * loses its output, or model text that becomes live markup.
 */

const repoRoot = path.resolve(__dirname, '..', '..');
const panelHtml = fs.readFileSync(path.join(repoRoot, 'media', 'panel.html'), 'utf8');
const panelJs = fs.readFileSync(path.join(repoRoot, 'media', 'chat.js'), 'utf8');

/**
 * jsdom ships no types and only a handful of members are used here.
 *
 * It is loaded defensively: when the installed jsdom is too new for the Node
 * version running the tests (the release workflow uses Node 20), requiring it
 * throws. A module-level throw would collapse this file into one opaque test
 * failure, so remember the reason and report it from each test instead.
 */
let jsdom: { JSDOM: any } | undefined;
let jsdomError = '';
try {
  jsdom = require('jsdom') as { JSDOM: any };
} catch (error) {
  jsdomError = error instanceof Error ? error.message : String(error);
}

interface Harness {
  window: any;
  doc: any;
  posted: any[];
  send: (message: unknown) => void;
  close: () => void;
}

/** Every mounted window, so a failed assertion cannot leave a timer running. */
const windows: any[] = [];

after(() => {
  for (const window of windows) {
    try {
      window.close();
    } catch {
      /* already closed */
    }
  }
  windows.length = 0;
});

function mount(): Harness {
  if (!jsdom) {
    throw new Error(
      `the panel tests need jsdom (a devDependency) to load under this Node ${process.version}: ${jsdomError}`,
    );
  }
  const JSDOM = jsdom.JSDOM;
  const html = panelHtml
    .replace('{{CSP}}', "default-src 'none'")
    .replace('{{CSS}}', 'chat.css')
    .replace('{{JS}}', 'chat.js')
    .replace('{{NONCE}}', 'test-nonce');
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://panel.test/' });
  const window = dom.window;
  const posted: any[] = [];
  window.acquireVsCodeApi = () => ({
    postMessage: (message: any) => posted.push(message),
    getState: () => undefined,
    setState: () => undefined,
  });
  window.eval(panelJs);
  windows.push(window);
  const send = (message: unknown) => window.dispatchEvent(new window.MessageEvent('message', { data: message }));
  return { window, doc: window.document, posted, send, close: () => window.close() };
}

const state = {
  status: 'idle',
  busy: false,
  step: 0,
  maxSteps: 12,
  provider: 'anthropic',
  model: 'claude-test',
  workspace: '/home/user/project',
  editPolicy: 'ask',
  commandPolicy: 'ask',
  keyPresent: true,
  toolCount: 10,
  stream: true,
  showThinking: true,
  agentFiles: [{ displayPath: 'agent.md', bytes: 120 }],
  agentFilesEnabled: true,
  contextTokens: 42000,
  contextWindow: 128000,
  contextPercent: 32.8,
};

const idle = { status: 'idle', step: 0, maxSteps: 12, tool: null, detail: null, startedAt: 0, taskStartedAt: 0 };

const answer = [
  '## Summary',
  '',
  'The **config loader** is in `src/config.ts`, see [docs](https://example.com/config).',
  '',
  '- first',
  '- second',
  '  - nested',
  '',
  '1. ordered one',
  '2. ordered two',
  '',
  '| Name | Type | Notes |',
  '| --- | :--: | ---: |',
  '| host | str | fast |',
  '',
  '```ts',
  'const x: number = 1;',
  '</code></pre><img src=x onerror="alert(1)">',
  '```',
  '',
  '<script>alert("xss")</script>',
].join('\n');

test('the panel boots with an empty transcript and honest status chips', () => {
  const h = mount();
  h.send({ type: 'init', items: [], state, activity: idle });

  assert.ok(h.posted.some((m) => m.type === 'ready'), 'the panel announces itself');
  assert.ok(h.doc.getElementById('empty'), 'an empty transcript offers the starting point');
  assert.equal(h.doc.getElementById('chip-provider').textContent, 'anthropic · claude-test');
  assert.equal(h.doc.getElementById('chip-agents').textContent, 'agents: 1');
  assert.equal(h.doc.getElementById('chip-context').textContent, 'ctx ~33%');
  assert.equal(h.doc.getElementById('status-text').textContent, 'Idle');
  assert.equal(h.doc.getElementById('status-dot').dataset.status, 'idle');
  h.close();
});

test('answers render as Markdown, and model HTML can never become markup', () => {
  const h = mount();
  h.send({ type: 'init', items: [], state, activity: idle });
  h.send({ type: 'item', item: { id: 'a1', kind: 'assistant', text: answer, streaming: false } });

  const node = h.doc.querySelector('.msg.assistant');
  assert.ok(node.querySelector('h2'), 'headings');
  assert.equal(node.querySelectorAll('table th').length, 3, 'tables');
  assert.ok(node.querySelector('th.ta-center') && node.querySelector('th.ta-right'), 'column alignment');
  assert.equal(node.querySelectorAll('ol > li').length, 2, 'ordered lists');
  assert.ok(node.querySelectorAll('ul > li').length >= 3, 'nested unordered lists');
  assert.ok(node.querySelector('strong') && node.querySelector('p code'), 'inline formatting');
  assert.equal(node.querySelector('a').getAttribute('href'), 'https://example.com/config');

  const code = node.querySelector('.code-block code');
  assert.ok(code.textContent.includes('</code></pre>'), 'code keeps its literal text');
  assert.ok(node.textContent.includes('<script>alert("xss")</script>'), 'tags are shown as text');
  assert.equal(node.querySelectorAll('img, script').length, 0, 'no element is created from model output');
  assert.ok(node.querySelector('.code-copy'), 'each code block can be copied');
  assert.ok(!node.querySelector('.caret'), 'a finished answer has no caret');
  h.close();
});

test('a streamed answer is patched in place, not rebuilt', () => {
  const h = mount();
  h.send({ type: 'init', items: [], state, activity: idle });
  h.send({ type: 'item', item: { id: 'a1', kind: 'assistant', text: 'Hello', streaming: true } });
  const first = h.doc.querySelector('.msg.assistant');
  assert.ok(first.querySelector('.caret'), 'the caret marks the live answer');

  h.send({ type: 'update', item: { id: 'a1', text: 'Hello **world**', streaming: true } });
  const second = h.doc.querySelector('.msg.assistant');
  assert.equal(second, first, 'the same element must survive every token');
  assert.ok(second.textContent.includes('world'));
  assert.ok(second.querySelector('.caret'));

  h.send({ type: 'update', item: { id: 'a1', text: 'Hello **world**', streaming: false } });
  assert.equal(h.doc.querySelector('.msg.assistant'), first);
  assert.ok(!h.doc.querySelector('.msg.assistant .caret'), 'the caret goes when the stream ends');
  assert.ok(h.doc.querySelector('.msg.assistant > .msg-actions'), 'a finished answer can be copied');
  h.close();
});

test('thinking expands while it streams and folds once the answer lands', () => {
  const h = mount();
  h.send({ type: 'init', items: [], state, activity: idle });
  h.send({ type: 'item', item: { id: 't1', kind: 'thinking', text: 'Reading the loader…', streaming: true } });
  assert.ok(h.doc.querySelector('.thinking').classList.contains('open'), 'live reasoning is visible');

  h.send({ type: 'update', item: { id: 't1', text: 'Reading the loader… it parses JSON.', streaming: false, durationMs: 4200 } });
  const lane = h.doc.querySelector('.thinking');
  assert.ok(!lane.classList.contains('open'), 'finished reasoning folds away so the answer is not buried');
  assert.ok(lane.querySelector('.thinking-preview').textContent.includes('parses JSON'));
  assert.equal(lane.querySelector('.thinking-time').textContent, '4.2s');

  lane.querySelector('.thinking-head').dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
  assert.ok(lane.classList.contains('open'), 'and the reader can open it');
  h.close();
});

test('tool rows fold on success and keep a reader-opened row open', () => {
  const h = mount();
  h.send({ type: 'init', items: [], state, activity: idle });
  h.send({
    type: 'item',
    item: { id: 'x1', kind: 'tool', name: 'run_command', args: JSON.stringify({ command: 'npm test' }), status: 'running' },
  });
  const running = h.doc.querySelector('.tool');
  assert.ok(running.classList.contains('running') && running.classList.contains('open'));
  assert.equal(running.querySelector('.tool-arg').textContent, 'npm test');

  h.send({ type: 'update', item: { id: 'x1', status: 'ok', durationMs: 1200, detail: '108 passing' } });
  const ok = h.doc.querySelector('.tool');
  assert.ok(ok.classList.contains('ok'));
  assert.ok(!ok.classList.contains('open'), 'a success folds to one row');
  const output = [...ok.querySelectorAll('.tool-body pre')].map((pre: any) => pre.textContent).join('\n');
  assert.ok(output.includes('108 passing'), 'but the output is still there when it is expanded');

  ok.querySelector('.tool-head').dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
  assert.ok(ok.classList.contains('open'));
  h.send({ type: 'update', item: { id: 'x1', status: 'failed', detail: 'boom' } });
  assert.ok(h.doc.querySelector('.tool').classList.contains('open'), 'an explicit open survives the update');
  h.close();
});

test('an approval posts a decision and then hides its buttons', () => {
  const h = mount();
  h.send({ type: 'init', items: [], state, activity: idle });
  h.send({
    type: 'item',
    item: {
      id: 'p1',
      kind: 'approval',
      approvalId: 'req-1',
      request: { kind: 'write', path: 'src/app.ts', title: 'Edit file', detail: '@@ -1 +1 @@\n-old\n+new' },
    },
  });

  const card = h.doc.querySelector('.approval');
  assert.ok(card.querySelector('.diff .add') && card.querySelector('.diff .del'), 'the change is shown as a diff');
  const buttons = [...card.querySelectorAll('.approval-actions button')];
  assert.equal(buttons.length, 4, 'apply / always / reject / diff');
  buttons[0].click();
  assert.ok(h.posted.some((m) => m.type === 'approval-response' && m.id === 'req-1' && m.decision === 'apply'));

  h.send({ type: 'update', item: { id: 'p1', decision: 'apply' } });
  assert.ok(!h.doc.querySelector('.approval .approval-actions'), 'a decided approval cannot be decided twice');
  h.close();
});

test('images staged in the composer travel with the message', async () => {
  const h = mount();
  h.send({ type: 'init', items: [], state, activity: idle });
  const fileInput = h.doc.getElementById('file-input');
  const file = new h.window.File([Buffer.from('89504e470d0a1a0a', 'hex')], 'shot.png', { type: 'image/png' });
  Object.defineProperty(fileInput, 'files', { value: [file] });
  fileInput.dispatchEvent(new h.window.Event('change', { bubbles: true }));

  await new Promise((resolve) => setTimeout(resolve, 30));
  const tray = h.doc.getElementById('attachments');
  assert.ok(!tray.hidden, 'the tray appears');
  assert.equal(tray.querySelectorAll('.attachment').length, 1);

  h.doc.getElementById('input').value = '';
  h.doc.getElementById('btn-send').click();
  const submit = h.posted.filter((m) => m.type === 'submit').pop();
  assert.ok(submit, 'an image on its own is a valid prompt');
  assert.ok(submit.images[0].dataUrl.startsWith('data:image/png;base64,'), 'bytes travel as a data URL');
  assert.ok(tray.hidden, 'and the tray empties');
  h.close();
});

test('the agents chip opens a picker, pins a subset and refuses an empty pin', () => {
  const h = mount();
  h.send({ type: 'init', items: [], state: { ...state, agentFiles: [{ displayPath: 'agent.md' }], agentFilesAvailable: 3 }, activity: idle });
  assert.equal(h.doc.getElementById('chip-agents').textContent, 'agents: 1', 'no pin yet: just the active count');

  h.doc.getElementById('chip-agents').click();
  assert.ok(!h.doc.getElementById('agents-modal').hidden, 'the chip opens the picker');
  assert.ok(h.posted.some((m) => m.type === 'get-agent-settings'), 'and asks for the discovered files');

  h.send({
    type: 'agent-settings',
    enabled: true,
    selection: null,
    available: 3,
    root: '/r',
    files: [
      { displayPath: 'agent.md', scope: '', origin: 'workspace', bytes: 10, truncated: false, active: true },
      { displayPath: '.agents/review.md', scope: '', origin: 'workspace', bytes: 20, truncated: false, active: true },
      { displayPath: 'api/agent.md', scope: 'api', origin: 'workspace', bytes: 30, truncated: false, active: true },
    ],
  });
  assert.equal(h.doc.querySelectorAll('.agent-row').length, 3);
  assert.ok(h.doc.querySelector('.agent-meta').textContent.includes('workspace root'));
  assert.ok(h.doc.getElementById('agents-all').checked, '"every discovered file" is the default');

  const boxes = [...h.doc.querySelectorAll('.agent-check')];
  assert.ok(boxes.every((box: any) => box.disabled), 'individual rows are disabled while "every file" is checked');

  // Choose a single file: an empty pin must be refused, a real one posted.
  const all = h.doc.getElementById('agents-all');
  all.checked = false;
  all.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  assert.ok(boxes.every((box: any) => !box.disabled));
  for (const box of boxes) box.checked = false;
  h.doc.getElementById('agents-save').click();
  assert.ok(h.doc.getElementById('agents-modal-status').classList.contains('error'));
  assert.ok(!h.posted.some((m) => m.type === 'save-agent-selection'), 'nothing is saved when nothing is selected');

  // Now pin one file (the row class follows the checkbox).
  boxes[2].checked = true;
  boxes[2].dispatchEvent(new h.window.Event('change', { bubbles: true }));
  assert.ok(boxes[2].closest('.agent-row').classList.contains('active'));
  h.doc.getElementById('agents-save').click();
  const save = h.posted.filter((m) => m.type === 'save-agent-selection').pop();
  // Spread first: the array was built inside the jsdom realm, and deepStrictEqual
  // compares prototypes across realms.
  assert.deepEqual([...save.selection], ['api/agent.md']);

  h.send({ type: 'agent-settings-saved', ok: true, selection: ['api/agent.md'] });
  assert.equal(h.doc.getElementById('agents-modal-status').textContent, 'Saved ✓');

  // The chip reports the pin as active/total once state arrives.
  h.send({ type: 'state', state: { ...state, agentFiles: [{ displayPath: 'api/agent.md' }], agentFilesAvailable: 3, agentSelection: ['api/agent.md'] } });
  assert.equal(h.doc.getElementById('chip-agents').textContent, 'agents: 1/3');
  assert.ok(h.doc.getElementById('chip-agents').classList.contains('pinned'));
  h.close();
});

test('the agents picker offers to create a file when nothing was found', () => {
  const h = mount();
  h.send({ type: 'init', items: [], state: { ...state, agentFiles: [], agentFilesAvailable: 0 }, activity: idle });
  h.doc.getElementById('chip-agents').click();
  h.send({ type: 'agent-settings', enabled: true, selection: null, available: 0, root: '/r', files: [] });

  assert.ok(!h.doc.getElementById('agents-empty').hidden, 'the empty state is shown');
  assert.equal(h.doc.querySelectorAll('.agent-row').length, 0);
  h.doc.getElementById('agents-create').click();
  assert.ok(h.posted.some((m) => m.type === 'create-agent-file'));
  h.close();
});

test('the mcp dialog renders a snapshot and validates before saving', () => {
  const h = mount();
  h.send({ type: 'init', items: [], state, activity: idle });
  h.doc.getElementById('btn-mcp').click();
  assert.ok(!h.doc.getElementById('mcp-modal').hidden, 'the header button opens the dialog');
  assert.ok(h.posted.some((m) => m.type === 'get-mcp-settings'), 'and asks for a snapshot');

  h.send({
    type: 'mcp-settings',
    enabled: true,
    timeoutMs: 15000,
    servers: {
      fs: { type: 'stdio', command: 'npx', args: ['-y', 'server-filesystem'] },
      remote: { type: 'http', url: 'https://mcp.test/mcp' },
    },
    fileServers: {},
    sources: [],
    errors: [],
    supportsWorkspace: true,
    status: { fs: { running: true, tools: 4 } },
  });
  assert.equal(h.doc.querySelectorAll('.mcp-server').length, 2);
  assert.equal(h.doc.querySelector('.mcp-server .mcp-badge').textContent, '4 tools');

  h.doc.getElementById('mcp-add').click();
  h.doc.getElementById('mcp-save').click();
  assert.ok(h.doc.getElementById('mcp-modal-status').classList.contains('error'), 'an unnamed server is refused');
  assert.ok(!h.posted.some((m) => m.type === 'save-mcp-settings'), 'and nothing is written');
  h.close();
});

/* ---------------------------------------------------------- copy and chats */

test('message, streaming answer, code and tool copy buttons send exact text and wait for confirmation', () => {
  const h = mount();
  h.send({ type: 'init', items: [
    { id: 'u1', kind: 'user', text: 'A user question' },
    { id: 'a1', kind: 'assistant', text: 'First', final: false, streaming: true },
    { id: 't1', kind: 'tool', toolCallId: 't', name: 'read_file', args: '{}', status: 'ok', detail: 'raw tool output' },
  ], state, activity: idle });

  const userButton = h.doc.querySelector('[aria-label="Copy this message"]');
  userButton.click();
  let copy = h.posted.filter((m) => m.type === 'copy').pop();
  assert.equal(copy.text, 'A user question');
  assert.ok(!userButton.classList.contains('copied'), 'do not claim success before the host writes');
  h.send({ type: 'copy-result', id: copy.id, ok: false });
  assert.ok(!userButton.classList.contains('copied'), 'a failed copy is not reported as successful');

  h.send({ type: 'update', item: { id: 'a1', text: 'Updated **answer**\n\n```ts\nconst x = 1;\n```', streaming: true } });
  const answerButton = h.doc.querySelector('[aria-label="Copy this answer"]');
  assert.ok(answerButton, 'copy is available during streaming');
  answerButton.click();
  copy = h.posted.filter((m) => m.type === 'copy').pop();
  assert.equal(copy.text, 'Updated **answer**\n\n```ts\nconst x = 1;\n```', 'the latest raw Markdown is copied');
  h.send({ type: 'copy-result', id: copy.id, ok: true });
  assert.ok(answerButton.classList.contains('copied'));
  assert.equal(answerButton.title, 'Copied');
  assert.ok(answerButton.querySelector('svg'), 'feedback must not replace the icon');

  const codeButton = h.doc.querySelector('.code-copy');
  codeButton.click();
  copy = h.posted.filter((m) => m.type === 'copy').pop();
  assert.equal(copy.text, 'const x = 1;');
  h.send({ type: 'copy-result', id: copy.id, ok: true });
  assert.equal(codeButton.textContent, 'Copied');

  const toolButton = [...h.doc.querySelectorAll('.tool-actions button')].find((b: any) => b.textContent === 'Copy output') as any;
  toolButton.click();
  copy = h.posted.filter((m) => m.type === 'copy').pop();
  assert.equal(copy.text, 'raw tool output');
  h.close();
});

test('selected chat text uses the VS Code clipboard without hijacking input copy', () => {
  const h = mount();
  h.send({ type: 'init', items: [{ id: 'a', kind: 'assistant', text: 'Select this passage', final: true }], state, activity: idle });
  const text = h.doc.querySelector('.msg-body p').firstChild;
  const range = h.doc.createRange();
  range.setStart(text, 7);
  range.setEnd(text, 11);
  const selection = h.window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);

  const shortcut = new h.window.KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true, cancelable: true });
  h.doc.body.dispatchEvent(shortcut);
  assert.equal(shortcut.defaultPrevented, true);
  assert.equal(h.posted.filter((m) => m.type === 'copy').pop().text, 'this');

  const before = h.posted.filter((m) => m.type === 'copy').length;
  const inputShortcut = new h.window.KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true, cancelable: true });
  h.doc.getElementById('input').dispatchEvent(inputShortcut);
  assert.equal(inputShortcut.defaultPrevented, false);
  assert.equal(h.posted.filter((m) => m.type === 'copy').length, before);

  let copied = '';
  const copyEvent = new h.window.Event('copy', { bubbles: true, cancelable: true });
  Object.defineProperty(copyEvent, 'clipboardData', { value: { setData: (_type: string, value: string) => { copied = value; } } });
  h.doc.body.dispatchEvent(copyEvent);
  assert.equal(copyEvent.defaultPrevented, true);
  assert.equal(copied, 'this', 'context-menu copy gets plain selected text');
  h.close();
});

test('streaming updates do not destroy an active text selection', () => {
  const h = mount();
  h.send({ type: 'init', items: [{ id: 'a', kind: 'assistant', text: 'Hello reader', final: false, streaming: true }], state, activity: idle });
  const body = h.doc.querySelector('.msg-body');
  const text = body.querySelector('p').firstChild;
  const range = h.doc.createRange();
  range.setStart(text, 0);
  range.setEnd(text, 5);
  const selection = h.window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);

  h.send({ type: 'update', item: { id: 'a', text: 'Hello reader, more arrived', streaming: true } });
  assert.equal(selection.toString(), 'Hello');
  assert.equal(body.querySelector('p').firstChild, text, 'the selected DOM is not replaced');
  selection.removeAllRanges();
  h.doc.dispatchEvent(new h.window.Event('selectionchange'));
  assert.ok(body.textContent.includes('more arrived'), 'the deferred repaint catches up');
  h.close();
});

test('chat import/export actions, replacement, and interrupted approvals are wired safely', () => {
  const h = mount();
  h.send({ type: 'init', items: [], state, activity: idle });
  h.doc.getElementById('btn-import-chat').click();
  h.doc.getElementById('btn-export-chat').click();
  assert.ok(h.posted.some((m) => m.type === 'import-chat'));
  assert.ok(h.posted.some((m) => m.type === 'export-chat'));

  h.send({ type: 'state', state: { ...state, busy: true } });
  assert.equal(h.doc.getElementById('btn-import-chat').disabled, true);
  assert.equal(h.doc.getElementById('btn-export-chat').disabled, true);
  assert.equal(h.doc.getElementById('btn-reset').disabled, true);

  h.doc.getElementById('input').value = 'old draft';
  h.send({ type: 'chat-replaced', items: [
    { id: 'old-approval', kind: 'approval', approvalId: 'x', request: { kind: 'command', title: 'Run', detail: 'echo test' }, interrupted: true },
    { id: 'restored', kind: 'assistant', text: 'Restored answer', final: true },
  ], state, activity: idle });
  assert.equal(h.doc.getElementById('input').value, '');
  assert.ok(h.doc.querySelector('.msg.assistant').textContent.includes('Restored answer'));
  assert.match(h.doc.querySelector('.approval-head').textContent, /Interrupted/);
  assert.equal(h.doc.querySelectorAll('.approval-actions button').length, 0, 'stale approvals are never actionable');
  h.close();
});

test('a selected thinking stream stays readable and catches up after selection', () => {
  const h = mount();
  h.send({ type: 'init', items: [{ id: 't', kind: 'thinking', text: 'Thinking aloud', streaming: true }], state, activity: idle });
  const lane = h.doc.querySelector('.thinking');
  const body = lane.querySelector('.thinking-body');
  const text = body.firstChild;
  const range = h.doc.createRange();
  range.setStart(text, 0);
  range.setEnd(text, 8);
  const selection = h.window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  h.send({ type: 'update', item: { id: 't', text: 'Thinking aloud, now finished', streaming: false, durationMs: 100 } });
  assert.equal(selection.toString(), 'Thinking');
  assert.ok(lane.classList.contains('open'), 'finishing does not hide text being selected');
  selection.removeAllRanges();
  h.doc.dispatchEvent(new h.window.Event('selectionchange'));
  assert.equal(body.textContent, 'Thinking aloud, now finished');
  h.close();
});

test('context breakdown is shown on demand and calls out a large output reserve', () => {
  const h = mount();
  h.send({ type: 'init', items: [], state: { ...state, contextWindow: 60000, contextTokens: 69257, contextPercent: 115.4,
    contextBreakdown: { system: 5000, conversation: 3000, images: 0, tools: 1254, framing: 3, adjustment: 0, outputReserve: 60000, source: 'estimate', policyKnown: true } }, activity: idle });
  const panel = h.doc.getElementById('context-breakdown');
  assert.equal(panel.hidden, true);
  h.doc.getElementById('chip-context').click();
  assert.equal(panel.hidden, false);
  assert.match(panel.textContent, /reserved output 60000/);
  assert.match(panel.textContent, /tool schemas 1254/);
  assert.match(h.doc.getElementById('compact-text').textContent, /Max Output Tokens/);
  h.doc.getElementById('btn-context-preview').click();
  assert.ok(h.posted.some((m) => m.type === 'preview-context'));
  h.close();
});

test('the delegated task is visible in its tool card', () => {
  const h = mount();
  h.send({ type: 'init', items: [{ id: 'delegation', kind: 'tool', toolCallId: 'd', name: 'delegate_task',
    args: JSON.stringify({ task: 'Inspect authentication flow' }), status: 'running' }], state, activity: idle });
  assert.equal(h.doc.querySelector('.tool-name').textContent, 'delegate_task');
  assert.equal(h.doc.querySelector('.tool-arg').textContent, 'Inspect authentication flow');
  assert.equal(h.doc.querySelector('.tool-icon use').getAttribute('href'), '#i-spark');
  h.close();
});

test('compaction activity shows request, elapsed time, and Stop without exposing model text', () => {
  const h = mount();
  h.send({ type: 'init', items: [], state: { ...state, busy: true, status: 'thinking' }, activity: idle });
  h.send({ type: 'activity', activity: {
    ...idle, status: 'compacting', startedAt: Date.now() - 5000,
    detail: 'request 2, attempt 1/3 — waiting for provider (Stop to cancel)',
  } });
  assert.equal(h.doc.getElementById('activity').hidden, false);
  assert.equal(h.doc.getElementById('activity-text').textContent, 'LLM compaction');
  assert.match(h.doc.getElementById('activity-detail').textContent, /request 2.*waiting for provider/);
  assert.match(h.doc.getElementById('activity-elapsed').textContent, /\d+s/);
  assert.equal(h.doc.getElementById('btn-stop').hidden, false);
  h.doc.getElementById('btn-stop').click();
  assert.ok(h.posted.some((message) => message.type === 'cancel'));
  h.send({ type: 'activity', activity: idle });
  assert.equal(h.doc.getElementById('activity').hidden, true);
  h.close();
});

test('settings GUI exposes subagents and local fallback, saves scope, and launches local compaction', () => {
  const h = mount();
  h.send({ type: 'init', items: [], state, activity: idle });
  h.doc.getElementById('btn-settings').click();
  assert.equal(h.doc.getElementById('feature-modal').hidden, false);
  assert.ok(h.posted.some((m) => m.type === 'get-feature-settings'));
  h.send({ type: 'feature-settings', subagentsEnabled: false, localFallback: false, hasWorkspace: true });
  assert.equal(h.doc.getElementById('feature-compact-local').disabled, true);
  const sub = h.doc.getElementById('feature-subagents');
  const local = h.doc.getElementById('feature-local-fallback');
  sub.checked = true;
  local.checked = true;
  h.doc.getElementById('feature-save').click();
  assert.ok(h.posted.some((m) => m.type === 'save-feature-settings' && m.subagentsEnabled === true && m.localFallback === true && m.target === 'workspace'));
  h.send({ type: 'feature-settings-saved', ok: true, settings: { subagentsEnabled: true, localFallback: true, hasWorkspace: true } });
  assert.equal(h.doc.getElementById('feature-status').textContent, 'Saved ✓');
  assert.equal(h.doc.getElementById('feature-compact-local').disabled, false);
  h.doc.getElementById('feature-compact-local').click();
  assert.ok(h.posted.some((m) => m.type === 'compact-local'));
  assert.equal(h.doc.getElementById('feature-modal').hidden, true);
  h.close();
});

test('settings GUI reports scope overrides and exposes the full settings screen', () => {
  const h = mount();
  h.send({ type: 'init', items: [], state, activity: idle });
  h.doc.getElementById('btn-settings').click();
  h.send({ type: 'feature-settings', subagentsEnabled: false, localFallback: false, hasWorkspace: false });
  assert.equal(h.doc.getElementById('feature-target').value, 'user');
  h.doc.getElementById('feature-subagents').checked = true;
  h.doc.getElementById('feature-save').click();
  h.send({ type: 'feature-settings-saved', ok: true, settings: { subagentsEnabled: false, localFallback: false, hasWorkspace: false } });
  assert.match(h.doc.getElementById('feature-status').textContent, /overrides/);
  assert.equal(h.doc.getElementById('feature-subagents').checked, false);
  h.doc.getElementById('feature-all-settings').click();
  assert.ok(h.posted.some((m) => m.type === 'open-settings'));
  h.close();
});

test('activity strip identifies active subagent work', () => {
  const h = mount();
  h.send({ type: 'init', items: [], state: { ...state, busy: true }, activity: idle });
  h.send({ type: 'activity', activity: { ...idle, status: 'subagent', startedAt: Date.now(), detail: 'Read-only investigation · step 2' } });
  assert.equal(h.doc.getElementById('activity-text').textContent, 'Subagent working');
  assert.match(h.doc.getElementById('activity-detail').textContent, /step 2/);
  h.close();
});

test('feature settings errors remain readable in the dialog body and allow retry', () => {
  const h = mount();
  h.send({ type: 'init', items: [], state, activity: idle });
  h.doc.getElementById('btn-settings').click();
  h.send({ type: 'feature-settings', subagentsEnabled: false, localFallback: false, hasWorkspace: true });
  h.doc.getElementById('feature-subagents').checked = true;
  h.doc.getElementById('feature-save').click();
  h.send({ type: 'feature-settings-saved', ok: false, error: 'VS Code has not registered codingHarness.subagents.enabled. No settings were changed. Run Developer: Reload Window.', settings: { subagentsEnabled: false, localFallback: false, hasWorkspace: true } });
  const status = h.doc.getElementById('feature-status');
  assert.ok(status.closest('.modal-body'));
  assert.match(status.textContent, /Developer: Reload Window/);
  assert.equal(status.classList.contains('error'), true);
  assert.equal(h.doc.getElementById('feature-save').disabled, false);
  assert.equal(h.doc.getElementById('feature-subagents').checked, true, 'unsaved edits remain visible');
  h.close();
});

test('compaction inspector shows live requests and responses without treating text as HTML', () => {
  const h = mount();
  const entry = { request: 1, attempt: 1, source: 'main', model: 'local-model', maxTokens: 1024, streaming: true,
    prompt: 'Summarize sensitive context <script>alert(1)</script>', response: 'First fragment', reasoning: 'Thinking fragment',
    images: [], imageCount: 0, status: 'waiting' };
  h.send({ type: 'init', items: [], state: { ...state, busy: true }, activity: idle, compactionTrace: { entries: [entry], dropped: 0 } });
  const details = h.doc.getElementById('compaction-trace');
  assert.equal(details.hidden, false);
  assert.equal(details.open, false, 'sensitive details start collapsed');
  details.open = true;
  assert.equal(h.doc.getElementById('compaction-trace-prompt').textContent, entry.prompt);
  assert.equal(h.doc.getElementById('compaction-trace-prompt').querySelector('script'), null);
  assert.equal(h.doc.getElementById('compaction-trace-response').textContent, 'First fragment');
  assert.equal(h.doc.getElementById('compaction-trace-reasoning').textContent, 'Thinking fragment');
  assert.match(h.doc.getElementById('compaction-trace-meta').textContent, /local-model.*1024.*stream requested/);
  h.send({ type: 'compaction-trace', trace: { entries: [{ ...entry, response: 'First fragment plus more' }], dropped: 0 } });
  assert.equal(h.doc.getElementById('compaction-trace-response').textContent, 'First fragment plus more');
  h.doc.getElementById('compaction-copy-prompt').click();
  assert.ok(h.posted.some((m) => m.type === 'copy' && m.text === entry.prompt));
  h.doc.getElementById('compaction-trace-clear').click();
  assert.ok(h.posted.some((m) => m.type === 'clear-compaction-trace'));
  h.send({ type: 'compaction-trace', trace: { entries: [], dropped: 0 } });
  assert.equal(details.hidden, true);
  assert.equal(h.doc.getElementById('compaction-trace-prompt').textContent, '');
  assert.equal(h.doc.getElementById('compaction-trace-response').textContent, '');
  h.close();
});

test('compaction inspector preserves a selected request across retries and defers selected text repaints', () => {
  const h = mount();
  const entry = { request: 1, attempt: 1, source: 'main', model: 'model', maxTokens: 512, streaming: true,
    prompt: 'First prompt', response: 'Partial response', reasoning: '', images: [], imageCount: 0, status: 'waiting' };
  h.send({ type: 'init', items: [], state, activity: idle, compactionTrace: { entries: [entry], dropped: 0 } });
  h.doc.getElementById('compaction-trace').open = true;
  const response = h.doc.getElementById('compaction-trace-response');
  const selection = h.window.getSelection();
  const range = h.doc.createRange();
  range.selectNodeContents(response);
  selection.removeAllRanges();
  selection.addRange(range);
  h.send({ type: 'compaction-trace', trace: { entries: [{ ...entry, response: 'Partial response continued' }], dropped: 0 } });
  assert.equal(response.textContent, 'Partial response');
  assert.equal(selection.toString(), 'Partial response');
  selection.removeAllRanges();
  h.doc.dispatchEvent(new h.window.Event('selectionchange'));
  assert.equal(response.textContent, 'Partial response continued');
  const second = { ...entry, request: 2, attempt: 2, prompt: 'Second prompt', response: '', status: 'waiting' };
  h.send({ type: 'compaction-trace', trace: { entries: [entry, second], dropped: 0 } });
  assert.equal(h.doc.getElementById('compaction-trace-request').value, '2');
  h.doc.getElementById('compaction-trace-request').value = '1';
  h.doc.getElementById('compaction-trace-request').dispatchEvent(new h.window.Event('change'));
  h.send({ type: 'compaction-trace', trace: { entries: [entry, second, { ...entry, request: 3 }], dropped: 1 } });
  assert.equal(h.doc.getElementById('compaction-trace-request').value, '1');
  assert.match(h.doc.getElementById('compaction-trace-meta').textContent, /older requests omitted/);
  h.close();
});

test('Copilot selection is accessible in settings and does not claim an API key is missing', () => {
  const h = mount();
  h.send({ type: 'init', items: [], state: { ...state, provider: 'copilot', model: 'chosen-id', keyPresent: false }, activity: idle });
  const chip = h.doc.getElementById('chip-provider');
  assert.match(chip.textContent, /copilot.*chosen-id/);
  assert.match(chip.title, /VS Code sign-in/);
  assert.equal(chip.classList.contains('warn'), false);
  h.doc.getElementById('btn-settings').click();
  h.doc.getElementById('feature-copilot').click();
  assert.ok(h.posted.some((message) => message.type === 'select-copilot-model'));
  h.close();
});

test('Copilot compaction details do not claim unsupported output limits or finish reasons', () => {
  const h = mount();
  h.send({ type: 'init', items: [], state, activity: idle, compactionTrace: { dropped: 0, entries: [{ request: 1, attempt: 1,
    source: 'main', provider: 'copilot', model: 'id', maxTokens: 512, streaming: true, prompt: 'prompt', response: 'summary',
    reasoning: '', images: [], imageCount: 0, status: 'finished' }] } });
  const meta = h.doc.getElementById('compaction-trace-meta').textContent;
  assert.match(meta, /output limit and temperature controlled by VS Code/);
  assert.match(meta, /finish reason unavailable/);
  assert.doesNotMatch(meta, /max output: 512/);
  h.close();
});

test('settings describe automatic subagent attempts and warning fallback', () => {
  const h = mount();
  h.doc.getElementById('btn-settings').click();
  const modalText = h.doc.getElementById('feature-modal').textContent;
  assert.match(modalText, /Run a read-only subagent for every task/);
  assert.match(modalText, /warning appears and the main agent continues/);
  h.close();
});

test('subagent response, thought, notices and tool cards stay labeled through streaming updates', () => {
  const { doc, send } = mount();
  const source = { source: 'subagent', parentToolCallId: 'delegate' };
  send({ type: 'item', item: { ...source, id: 'a', kind: 'assistant', text: 'working', streaming: true, final: false } });
  send({ type: 'update', item: { ...source, id: 'a', kind: 'assistant', text: 'done', streaming: false, final: true } });
  send({ type: 'item', item: { ...source, id: 't', kind: 'thinking', text: 'considering', streaming: true } });
  send({ type: 'update', item: { ...source, id: 't', kind: 'thinking', text: 'considered', streaming: false, durationMs: 8 } });
  send({ type: 'item', item: { ...source, id: 'tool', kind: 'tool', toolCallId: 'tool', name: 'read_file', args: '{"path":"x"}', status: 'running' } });
  send({ type: 'update', item: { ...source, id: 'tool', kind: 'tool', toolCallId: 'tool', name: 'read_file', args: '{"path":"x"}', status: 'failed', summary: 'failed', detail: 'no file' } });
  send({ type: 'item', item: { ...source, id: 'n', kind: 'notice', level: 'warn', message: 'child warning' } });
  assert.match(doc.querySelector('[data-id="a"]').textContent, /Subagent.*temporary/);
  assert.match(doc.querySelector('[data-id="t"] .thinking-label').textContent, /Subagent.*Thought/);
  assert.match(doc.querySelector('[data-id="tool"]').textContent, /Subagent/);
  assert.match(doc.querySelector('[data-id="tool"]').textContent, /no file/);
  assert.match(doc.querySelector('[data-id="n"]').textContent, /Subagent.*child warning/);
  send({ type: 'remove-item', id: 'tool' });
  assert.equal(doc.querySelector('[data-id="tool"]'), null);
});
