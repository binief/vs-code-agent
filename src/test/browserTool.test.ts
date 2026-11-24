import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BrowserManager,
  REQUIRED_BROWSER_TOOL_NAMES,
  type BrowserInvocation,
  type BrowserToolInvoker,
} from '../core/tools/browserTool';

class FakeInvoker implements BrowserToolInvoker {
  readonly calls: Array<{ name: string; input: Record<string, unknown> }> = [];

  constructor(private readonly available: readonly string[] = REQUIRED_BROWSER_TOOL_NAMES) {}

  async availableTools(): Promise<readonly string[]> {
    return this.available;
  }

  async invoke(name: string, input: Record<string, unknown>): Promise<BrowserInvocation> {
    this.calls.push({ name, input });
    if (name === 'open_browser_page') {
      return { text: `Page ID: page-1\n\nSummary:\nPage Title: Demo\nURL: ${String(input.url)}` };
    }
    if (name === 'navigate_page') {
      return { text: `Navigated to ${String(input.url)}` };
    }
    if (name === 'run_playwright_code') {
      const code = String(input.code);
      let value: unknown = { ok: true };
      if (code.includes('page.screenshot')) value = 'aGVsbG8=';
      else if (code.includes('data-cdh-ref')) {
        value = [{ role: 'button', name: 'Go', ref: 1, selector: '[data-cdh-ref="cdh1"]' }];
      } else if (code.includes('page.url()')) {
        value = { url: 'http://example.com/', title: 'Demo' };
      }
      return { text: `Result: ${JSON.stringify(value)}` };
    }
    return { text: '' };
  }

  find(name: string): Record<string, unknown> | undefined {
    return this.calls.find((call) => call.name === name)?.input;
  }
}

test('browser manager uses VS Code built-in browser tools for navigation and snapshots', async () => {
  const invoker = new FakeInvoker();
  const manager = new BrowserManager(invoker);

  const result = await manager.navigate('http://example.com/');

  assert.equal(result.ok, true);
  assert.equal(result.url, 'http://example.com/');
  assert.equal(result.title, 'Demo');
  assert.deepEqual(result.elements, [{ role: 'button', name: 'Go', ref: 1, selector: '[data-cdh-ref="cdh1"]' }]);
  assert.deepEqual(invoker.find('open_browser_page'), { url: 'http://example.com/', forceNew: true });

  const second = await manager.navigate('http://example.com/next');
  assert.equal(second.ok, true);
  assert.deepEqual(invoker.find('navigate_page'), { pageId: 'page-1', type: 'url', url: 'http://example.com/next' });
});

test('browser manager dispatches interaction actions through built-in tools', async () => {
  const invoker = new FakeInvoker();
  const manager = new BrowserManager(invoker);
  await manager.navigate('http://example.com/');

  const clicked = await manager.click('[data-cdh-ref="cdh1"]');
  assert.equal(clicked.ok, true);
  assert.deepEqual(invoker.find('click_element'), {
    pageId: 'page-1',
    element: '[data-cdh-ref="cdh1"]',
    selector: '[data-cdh-ref="cdh1"]',
  });

  const typed = await manager.type('#search', 'hello');
  assert.equal(typed.ok, true);
  assert.deepEqual(invoker.find('type_in_page'), {
    pageId: 'page-1',
    text: 'hello',
    element: '#search',
    selector: '#search',
  });

  const pressed = await manager.pressKey('Enter');
  assert.equal(pressed.ok, true);
  assert.ok(
    invoker.calls.some(
      (call) => call.name === 'type_in_page' && call.input.key === 'Enter' && !call.input.selector,
    ),
  );

  const pressedOnTarget = await manager.pressKey('Enter', '#search');
  assert.equal(pressedOnTarget.ok, true);
  assert.ok(
    invoker.calls.some(
      (call) =>
        call.name === 'type_in_page' &&
        call.input.key === 'Enter' &&
        call.input.selector === '#search' &&
        call.input.element === '#search',
    ),
  );
});

test('browser manager returns screenshots from the integrated browser page', async () => {
  const invoker = new FakeInvoker();
  const manager = new BrowserManager(invoker);
  await manager.navigate('http://example.com/');

  const result = await manager.screenshot(true);

  assert.equal(result.ok, true);
  assert.equal(result.screenshot, 'aGVsbG8=');
  assert.ok(
    invoker.calls.some(
      (call) => call.name === 'run_playwright_code' && String(call.input.code).includes('fullPage: true'),
    ),
  );
});

test('browser manager reports a clear error when built-in browser tools are missing', async () => {
  const manager = new BrowserManager(new FakeInvoker([]));

  const result = await manager.navigate('http://example.com/');

  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /built-in browser tools are not available/i);
  assert.match(result.error ?? '', /workbench\.browser\.enableChatTools/);
});
