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

after(() => {
  /* each test closes its own jsdom window */
});

test('the panel boots with an empty transcript and honest status chips', () => {
  const h = mount();
  h.send({ type: 'init', items: [], state, activity: idle });

  assert.ok(h.posted.some((m) => m.type === 'ready'), 'the panel announces itself');
  assert.ok(h.doc.getElementById('empty'), 'an empty transcript offers the starting point');
  assert.equal(h.doc.getElementById('chip-provider').textContent, 'anthropic · claude-test');
  assert.equal(h.doc.getElementById('chip-agents').textContent, 'agents: 1');
  assert.equal(h.doc.getElementById('chip-context').textContent, 'ctx 33%');
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
