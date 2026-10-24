import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { after, test } from 'node:test';

/**
 * The panel is plain CSS/JS with no build step, so these tests are how the
 * layout and rendering rules are held in place. The first regression they guard
 * is the one that made long transcripts unusable: the message list is a column
 * flex container, and without `flex-shrink: 0` on its children every bubble gets
 * squashed to fit the pane instead of the pane scrolling.
 */

const repoRoot = path.resolve(__dirname, '..', '..');
const css = fs.readFileSync(path.join(repoRoot, 'media', 'chat.css'), 'utf8');
const js = fs.readFileSync(path.join(repoRoot, 'media', 'chat.js'), 'utf8');
const view = fs.readFileSync(path.join(repoRoot, 'src', 'vscode', 'chatView.ts'), 'utf8');
/* The panel markup is a real HTML file (media/panel.html) that chatView.ts reads
   and fills in, so layout assertions run against the file itself. */
const panel = fs.readFileSync(path.join(repoRoot, 'media', 'panel.html'), 'utf8');

/** Pull a rule block out of the stylesheet by selector. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`(^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm'));
  assert.ok(match, `stylesheet has no rule for ${selector}`);
  return match![2];
}

after(() => {
  /* nothing to clean up */
});

/* --------------------------------------------------------------- scrolling */

test('the transcript scrolls instead of squashing its children', () => {
  const stream = rule('.stream');
  assert.match(stream, /overflow-y:\s*auto/, '.stream must scroll');
  assert.match(stream, /min-height:\s*0/, 'a flex child needs min-height:0 to allow shrinking below content');
  assert.match(stream, /flex-direction:\s*column/);

  // The actual regression: children of a column flex container default to
  // flex-shrink:1 and get compressed as the transcript grows.
  const children = rule('.stream > *');
  assert.match(children, /flex:\s*0\s+0\s+auto|flex-shrink:\s*0/, '.stream children must not shrink');
});

test('the page itself never double-scrolls behind the stream', () => {
  assert.match(rule('html,\nbody'), /overflow:\s*hidden/, 'body scrolling fights the inner scroll container');
  const app = rule('.app');
  assert.match(app, /min-height:\s*0/);
  assert.match(app, /height:\s*100%|max-height:\s*100vh/);
});

test('the stream sits in a positioning context for the jump button', () => {
  const wrap = rule('.stream-wrap');
  assert.match(wrap, /position:\s*relative/);
  assert.match(wrap, /min-height:\s*0/);
  assert.match(rule('.jump-latest'), /position:\s*absolute/);
  assert.match(panel, /id="jump-latest"/, 'the button must exist in the markup');
  assert.match(panel, /<div class="stream-wrap">/, 'the wrapper must exist in the markup');
});

test('auto-scroll yields to a reader who scrolled up', () => {
  // Forcing the viewport to the bottom on every repaint made earlier output
  // impossible to read while a task was running.
  assert.match(js, /stickToBottom/, 'expected a sticky-scroll flag');
  assert.match(js, /function nearBottom\(\)/);
  assert.ok(!/if \(nearBottom \|\| busy\) stream\.scrollTop/.test(js), 'the old force-scroll behaviour must be gone');
  assert.match(js, /btnJump\.hidden = false/, 'scrolling up should surface the jump button');
  assert.match(js, /btnJump\.addEventListener\('click'/, 'and the button must re-stick the view');
});

/* ---------------------------------------------------------------- thinking */

test('the thinking lane renders as a separate, collapsible block', () => {
  const thinking = rule('.thinking');
  assert.match(thinking, /flex:\s*0\s+0\s+auto/, 'thinking blocks must not be squashed either');

  // Collapsed by default, expanded only while it is streaming or when opened.
  assert.match(rule('.thinking-body'), /display:\s*none/);
  assert.match(rule('.thinking.open .thinking-body'), /display:\s*block/);
  assert.match(rule('.thinking-body'), /max-height/, 'a long rationale must not push the answer off screen');
  assert.match(rule('.thinking-body'), /overflow-y:\s*auto/);
});

test('the panel handles thinking items, and the controller feeds it deltas', () => {
  assert.match(js, /case 'thinking':/, 'the renderer must handle thinking items');
  assert.match(js, /function renderThinking\(/);

  // The webview only ever sees rendered items; thinking-delta is a core event
  // the controller turns into a `kind: 'thinking'` item.
  const controller = fs.readFileSync(path.join(repoRoot, 'out', 'vscode', 'controller.js'), 'utf8');
  assert.match(controller, /thinking-delta/, 'the controller must handle core thinking deltas');
  assert.match(controller, /kind: 'thinking'/, 'and emit thinking items for the panel');
  // Streaming state keeps it open and follows along; finished state collapses it.
  assert.match(js, /item\.streaming \? ' open' : ''/);
  assert.match(js, /tickThinking\(\)/, 'a live thinking block should follow its own scroll');
  assert.match(js, /formatMs\(item\.durationMs\)/, 'a finished one reports how long it ran');
});

test('an expanded thinking block survives the next repaint', () => {
  assert.match(js, /\.open = true/, 'open state must be preserved across updates');
});

test('the panel is wired to the showThinking setting', () => {
  assert.match(panel, /id="chip-thinking"/, 'a chip should report the setting');
  assert.match(js, /state\.showThinking !== false/);
});

/* ------------------------------------------------------------ ui contract */

test('every element the script looks up exists in the markup', () => {
  const ids = [...js.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]);
  assert.ok(ids.length >= 12, `expected a decent set of lookups, got ${ids.length}`);
  for (const id of new Set(ids)) {
    assert.match(panel, new RegExp(`id="${id}"`), `panel.html has no element with id="${id}"`);
  }
});

test('the markup is well-formed and nests the stream inside its wrapper', () => {
  // No compiler checks this HTML; a stray </div> silently breaks the layout,
  // so validate the tag structure here.
  assert.ok(panel.indexOf('<!DOCTYPE html>') === 0, 'the panel must be a complete document');

  // Substitution tokens and comments carry no structure (comments may mention
  // tags in prose), so drop them before walking the tags with a stack.
  const html = panel.replace(/\{\{[A-Z]+\}\}/g, 'x').replace(/<!--[\s\S]*?-->/g, '');
  const voidTags = new Set(['meta', 'link', 'br', 'hr', 'img', 'input', 'source']);
  const stack: string[] = [];
  for (const match of html.matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g)) {
    const [, closing, name, , selfClosing] = match;
    const tag = name.toLowerCase();
    if (voidTags.has(tag) || selfClosing) continue;
    if (closing) {
      const open = stack.pop();
      assert.equal(open, tag, `mismatched tag: expected </${open}> but found </${tag}>`);
    } else {
      stack.push(tag);
    }
  }
  assert.deepEqual(stack, [], `unclosed tags: ${stack.join(', ')}`);

  // The wrapper must actually contain the stream pane.
  const wrap = panel.indexOf('class="stream-wrap"');
  const streamPane = panel.indexOf('class="stream" id="stream"');
  const composer = panel.indexOf('class="composer"');
  assert.ok(wrap > 0 && streamPane > wrap && composer > streamPane, 'stream must sit inside the wrapper, above the composer');
});

test('the stylesheet only uses theme variables, never hard-coded colours', () => {
  const hexes = [...css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
  // A handful of palette fallbacks are allowed (var(--x, #fff)); anything else
  // would break in light themes.
  for (const hex of hexes) {
    const index = css.indexOf(hex);
    const before = css.slice(Math.max(0, index - 60), index);
    assert.ok(before.includes('var(--'), `${hex} is used outside a var() fallback`);
  }
});

test('chatView loads the panel markup from media/panel.html', () => {
  assert.match(view, /readFileSync/, 'the markup must come from a file, not an inline template');
  assert.match(view, /'media', 'panel\.html'/, 'and from media/panel.html specifically');
  assert.match(view, /vscode\.Uri\.joinPath\(this\.extensionUri, 'media', 'panel\.html'\)\.fsPath/);

  // Everything the file needs substituted is declared in the file itself.
  for (const token of ['{{CSP}}', '{{CSS}}', '{{JS}}', '{{NONCE}}']) {
    assert.ok(panel.includes(token), `panel.html should contain ${token}`);
  }
  // The CSP token must be inside the meta tag, not escaped as text.
  assert.match(panel, /http-equiv="Content-Security-Policy" content="\{\{CSP\}\}"/);
  assert.match(panel, /<script nonce="\{\{NONCE\}\}" src="\{\{JS\}\}"><\/script>/);
  assert.match(panel, /<link rel="stylesheet" href="\{\{CSS\}\}" \/>/);
});

/* ------------------------------------------------------------- mcp dialog */

test('the MCP settings dialog is wired end to end', () => {
  // Markup: the dialog, its form fields and its buttons exist.
  assert.match(panel, /id="mcp-modal"/, 'the dialog markup must exist');
  assert.match(panel, /id="mcp-server-list"/);
  assert.match(panel, /id="mcp-enabled"/);
  assert.match(panel, /id="mcp-timeout"/);
  assert.match(panel, /id="mcp-add"/);
  assert.match(panel, /id="mcp-target"/);
  assert.match(panel, /id="mcp-save"/);
  assert.match(panel, /id="mcp-reload"/);
  assert.match(panel, /id="mcp-modal-status"/);
  // The header MCP button opens the dialog instead of just reloading.
  assert.match(panel, /id="btn-mcp"/);
  assert.match(js, /btnMcp\.addEventListener\('click', openMcpModal\)/);

  // Script: asks for the snapshot, renders it, saves and reloads.
  assert.match(js, /type: 'get-mcp-settings'/);
  assert.match(js, /type: 'save-mcp-settings'/);
  assert.match(js, /case 'mcp-settings':/);
  assert.match(js, /case 'mcp-settings-saved':/);
  // Validation happens client-side before saving.
  assert.match(js, /function collectServers\(/);
  assert.match(js, /URL must start with http:\/\/ or https:\/\//);

  // The extension side answers the dialog (chatView.ts), and loads its markup
  // from media/panel.html instead of building an HTML string inline.
  assert.match(view, /case 'get-mcp-settings':/);
  assert.match(view, /case 'save-mcp-settings':/);
});

test('the MCP dialog styling has no hard-coded palette of its own', () => {
  assert.match(css, /\.modal-backdrop/);
  assert.match(css, /\.mcp-badge\.error/);
  assert.match(css, /\.modal-backdrop\[hidden\]\s*\{[^}]*display:\s*none/, 'a hidden dialog must not show');
});
