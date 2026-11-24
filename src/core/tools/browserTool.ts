import { fail, type Tool } from '../types';

// `window` and `document` are referenced inside page.evaluate() callbacks,
// which run in the browser context, not the Node.js context.
declare const window: any;
declare const document: any;

/** Maximum number of elements to include in an accessibility snapshot. */
const MAX_SNAPSHOT_ELEMENTS = 60;

/** Maximum characters for any single element description in a snapshot. */
const MAX_ELEMENT_DESCRIPTION = 120;

/** Default action timeout in ms. */
const DEFAULT_ACTION_TIMEOUT_MS = 10_000;

/**
 * The VS Code built-in browser tools this manager relies on. They are exposed
 * to extensions through `vscode.lm.tools` / `vscode.lm.invokeTool`, which is
 * how Copilot drives the integrated browser. Keeping the call behind this
 * small interface lets the core tool stay platform-agnostic and unit-testable.
 */
export const REQUIRED_BROWSER_TOOL_NAMES = [
  'open_browser_page',
  'navigate_page',
  'read_page',
  'click_element',
  'type_in_page',
  'run_playwright_code',
] as const;

/** Result of invoking a platform browser tool. */
export interface BrowserInvocation {
  /** Concatenated text content returned by the tool. */
  text: string;
}

/** Bridge to VS Code's built-in browser tools (implemented in the vscode layer). */
export interface BrowserToolInvoker {
  /** Names of the language model tools currently available in this host. */
  availableTools(): Promise<readonly string[]>;
  /** Invoke a built-in browser tool with the given input. */
  invoke(name: string, input: Record<string, unknown>): Promise<BrowserInvocation>;
}

/**
 * Information about an interactive element in the page accessibility tree.
 */
export interface BrowserElement {
  /** Short role label, e.g. 'button', 'input', 'link', 'heading', 'text'. */
  role: string;
  /** Human-readable accessible name, e.g. button text or input label. */
  name: string;
  /** Stable reference index for targeting in subsequent actions. */
  ref: number;
  /** Suggested selector to target this element. */
  selector?: string;
}

/** Snapshot of the current page state returned after every action. */
export interface BrowserSnapshot {
  url: string;
  title: string;
  note?: string;
  elements: BrowserElement[];
}

/** Arguments for the browser_tool. */
export interface BrowserToolArgs {
  action:
    | 'navigate'
    | 'click'
    | 'type'
    | 'press_key'
    | 'scroll'
    | 'wait_for'
    | 'get_snapshot'
    | 'screenshot';
  url?: string;
  selector?: string;
  text?: string;
  key?: string;
  x?: number;
  y?: number;
  dx?: number;
  dy?: number;
  ms?: number;
  fullPage?: boolean;
}

/** Result of a browser action, including snapshot for LLM targeting. */
export interface BrowserActionResult {
  ok: boolean;
  url: string;
  title: string;
  elements: BrowserElement[];
  note?: string;
  screenshot?: string; // base64, only for screenshot action
  error?: string;
}

type LogFn = (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;

const noopLog: LogFn = () => {};

/**
 * Drives browser automation through VS Code's integrated browser tools.
 *
 * No browser engine or Playwright package is shipped with this extension:
 * the `open_browser_page`, `navigate_page`, `type_in_page`, `click_element`,
 * `read_page` and `run_playwright_code` tools are built into VS Code and are
 * the same tools Copilot uses. This manager only translates browser_tool
 * arguments into calls to those tools and normalizes their results.
 */
export class BrowserManager {
  private invoker?: BrowserToolInvoker;
  private pageId?: string;
  private started = false;
  private log: LogFn = noopLog;

  constructor(invoker?: BrowserToolInvoker, log?: LogFn) {
    this.invoker = invoker;
    if (log) this.log = log;
  }

  /** Attach the platform bridge after construction (used by test hosts). */
  setInvoker(invoker: BrowserToolInvoker): void {
    this.invoker = invoker;
  }

  /** Verify that the built-in browser tools are available. */
  private async ensureStarted(log?: LogFn): Promise<BrowserToolInvoker> {
    if (log) this.log = log;
    const invoker = this.invoker;
    if (!invoker) {
      throw new Error(
        'Browser automation is not available in this environment: no browser tool bridge was configured.',
      );
    }
    if (this.started) return invoker;

    const available = await invoker.availableTools();
    const missing = REQUIRED_BROWSER_TOOL_NAMES.filter((name) => !available.includes(name));
    if (missing.length > 0) {
      throw new Error(
        'VS Code built-in browser tools are not available. ' +
          'Use VS Code with the integrated browser enabled (workbench.browser.enableChatTools). ' +
          `Missing tools: ${missing.join(', ')}.`,
      );
    }
    this.started = true;
    this.log('info', 'BrowserManager: using VS Code integrated browser tools');
    return invoker;
  }

  /** Invoke a built-in tool, surfacing a clear error when it fails. */
  private async call(invoker: BrowserToolInvoker, name: string, input: Record<string, unknown>): Promise<string> {
    try {
      const result = await invoker.invoke(name, input);
      return result.text ?? '';
    } catch (err) {
      throw new Error(`${name} failed: ${(err as Error).message}`);
    }
  }

  /** Extract the JSON value returned by a `run_playwright_code` snippet. */
  private parseCodeResult(text: string): any {
    const match = text.match(/Result:\s*([^\r\n]*)/);
    if (!match) {
      throw new Error(`Unexpected browser tool result: ${text.slice(0, 200)}`);
    }
    try {
      return JSON.parse(match[1]);
    } catch {
      throw new Error(`Could not parse browser tool result: ${match[1].slice(0, 200)}`);
    }
  }

  /** Run a Playwright snippet inside VS Code's integrated browser page. */
  private async runCode(invoker: BrowserToolInvoker, pageId: string, code: string): Promise<any> {
    const text = await this.call(invoker, 'run_playwright_code', {
      pageId,
      code,
      timeoutMs: DEFAULT_ACTION_TIMEOUT_MS,
    });
    return this.parseCodeResult(text);
  }

  /** Short human-readable summary from a built-in tool result. */
  private shortNote(text: string): string | undefined {
    const cleaned = text.replace(/Result:[\s\S]*$/m, '').trim();
    if (!cleaned) return undefined;
    return cleaned.length > 700 ? `${cleaned.slice(0, 700)}…` : cleaned;
  }

  /** Build a failed action result with current page state where possible. */
  private async failed(invoker: BrowserToolInvoker | undefined, error: string): Promise<BrowserActionResult> {
    let snapshot: BrowserSnapshot = { url: '', title: '', elements: [] };
    if (invoker && this.pageId) {
      try {
        snapshot = await this.captureSnapshot(invoker, this.pageId);
      } catch {
        /* keep the empty snapshot */
      }
    }
    return { ok: false, url: snapshot.url, title: snapshot.title, elements: snapshot.elements, error };
  }

  /** Navigate to a URL and return a snapshot. */
  async navigate(url: string, log?: LogFn): Promise<BrowserActionResult> {
    let invoker: BrowserToolInvoker;
    try {
      invoker = await this.ensureStarted(log);
    } catch (err) {
      return this.failed(undefined, (err as Error).message);
    }

    try {
      if (!this.pageId) {
        const text = await this.call(invoker, 'open_browser_page', { url, forceNew: true });
        const match = text.match(/Page ID:\s*([^\s]+)/);
        if (!match) return this.failed(invoker, `Could not open browser page: ${text.slice(0, 200)}`);
        this.pageId = match[1];
        const snapshot = await this.captureSnapshot(invoker, this.pageId, this.shortNote(text));
        return { ok: true, ...snapshot };
      }

      const text = await this.call(invoker, 'navigate_page', { pageId: this.pageId, type: 'url', url });
      const snapshot = await this.captureSnapshot(invoker, this.pageId, this.shortNote(text));
      return { ok: true, ...snapshot };
    } catch (err) {
      return this.failed(invoker, (err as Error).message);
    }
  }

  /** Click an element by selector/ref or coordinates. */
  async click(selector?: string, x?: number, y?: number): Promise<BrowserActionResult> {
    let invoker: BrowserToolInvoker;
    try {
      invoker = await this.ensureStarted();
    } catch (err) {
      return this.failed(undefined, (err as Error).message);
    }
    if (!this.pageId) return this.failed(invoker, 'Navigate to a page before clicking.');

    try {
      if (selector) {
        const input: Record<string, unknown> = { pageId: this.pageId, element: selector };
        const ref = selector.startsWith('aria-ref=') ? selector.slice('aria-ref='.length) : undefined;
        if (ref) input.ref = ref;
        else input.selector = selector;
        await this.call(invoker, 'click_element', input);
      } else if (x !== undefined && y !== undefined) {
        await this.runCode(invoker, this.pageId, `await page.mouse.click(${x}, ${y}); return { ok: true };`);
      } else {
        return this.failed(invoker, 'click requires a selector or x/y coordinates');
      }
      const snapshot = await this.captureSnapshot(invoker, this.pageId);
      return { ok: true, ...snapshot };
    } catch (err) {
      return this.failed(invoker, `click failed: ${(err as Error).message}`);
    }
  }

  /** Type text into an element by selector. */
  async type(selector: string, text: string): Promise<BrowserActionResult> {
    let invoker: BrowserToolInvoker;
    try {
      invoker = await this.ensureStarted();
    } catch (err) {
      return this.failed(undefined, (err as Error).message);
    }
    if (!this.pageId) return this.failed(invoker, 'Navigate to a page before typing.');

    try {
      const input: Record<string, unknown> = { pageId: this.pageId, text, element: selector };
      const ref = selector.startsWith('aria-ref=') ? selector.slice('aria-ref='.length) : undefined;
      if (ref) input.ref = ref;
      else input.selector = selector;
      await this.call(invoker, 'type_in_page', input);
      const snapshot = await this.captureSnapshot(invoker, this.pageId);
      return { ok: true, ...snapshot };
    } catch (err) {
      return this.failed(invoker, `type(${selector}) failed: ${(err as Error).message}`);
    }
  }

  /** Press a key on the keyboard, optionally after focusing a target element. */
  async pressKey(key: string, selector?: string): Promise<BrowserActionResult> {
    let invoker: BrowserToolInvoker;
    try {
      invoker = await this.ensureStarted();
    } catch (err) {
      return this.failed(undefined, (err as Error).message);
    }
    if (!this.pageId) return this.failed(invoker, 'Navigate to a page before pressing keys.');

    try {
      const input: Record<string, unknown> = { pageId: this.pageId, key };
      if (selector) {
        input.element = selector;
        const ref = selector.startsWith('aria-ref=') ? selector.slice('aria-ref='.length) : undefined;
        if (ref) input.ref = ref;
        else input.selector = selector;
      }
      await this.call(invoker, 'type_in_page', input);
      const snapshot = await this.captureSnapshot(invoker, this.pageId);
      return { ok: true, ...snapshot };
    } catch (err) {
      return this.failed(invoker, `press_key(${key}) failed: ${(err as Error).message}`);
    }
  }

  /** Scroll at an element or coordinates. */
  async scroll(selector?: string, x?: number, y?: number, dx = 0, dy = 300): Promise<BrowserActionResult> {
    let invoker: BrowserToolInvoker;
    try {
      invoker = await this.ensureStarted();
    } catch (err) {
      return this.failed(undefined, (err as Error).message);
    }
    if (!this.pageId) return this.failed(invoker, 'Navigate to a page before scrolling.');

    try {
      let code = '';
      if (selector) {
        code += `await page.locator(${JSON.stringify(selector)}).hover();\n`;
      } else if (x !== undefined && y !== undefined) {
        code += `await page.mouse.move(${x}, ${y});\n`;
      } else {
        return this.failed(invoker, 'scroll requires a selector or x/y coordinates');
      }
      code += `await page.mouse.wheel(${dx}, ${dy}); return { ok: true };`;
      await this.runCode(invoker, this.pageId, code);
      const snapshot = await this.captureSnapshot(invoker, this.pageId);
      return { ok: true, ...snapshot };
    } catch (err) {
      return this.failed(invoker, `scroll failed: ${(err as Error).message}`);
    }
  }

  /** Wait for an element to appear or a fixed time. */
  async waitFor(selector?: string, ms?: number): Promise<BrowserActionResult> {
    let invoker: BrowserToolInvoker;
    try {
      invoker = await this.ensureStarted();
    } catch (err) {
      return this.failed(undefined, (err as Error).message);
    }
    if (!this.pageId) return this.failed(invoker, 'Navigate to a page before waiting.');

    try {
      if (selector) {
        const timeout = ms ?? DEFAULT_ACTION_TIMEOUT_MS;
        await this.runCode(
          invoker,
          this.pageId,
          `await page.locator(${JSON.stringify(selector)}).waitFor({ state: 'visible', timeout: ${timeout} }); return { ok: true };`,
        );
      } else if (ms) {
        await this.runCode(invoker, this.pageId, `await page.waitForTimeout(${ms}); return { ok: true };`);
      } else {
        return this.failed(invoker, 'wait_for requires a selector or ms timeout');
      }
      const snapshot = await this.captureSnapshot(invoker, this.pageId);
      return { ok: true, ...snapshot };
    } catch (err) {
      return this.failed(invoker, `wait_for failed: ${(err as Error).message}`);
    }
  }

  /** Capture an accessibility-style snapshot of the current page. */
  async getSnapshot(): Promise<BrowserActionResult> {
    let invoker: BrowserToolInvoker;
    try {
      invoker = await this.ensureStarted();
    } catch (err) {
      return this.failed(undefined, (err as Error).message);
    }
    if (!this.pageId) return this.failed(invoker, 'Navigate to a page before taking a snapshot.');

    try {
      const note = await this.pageNote(invoker, this.pageId);
      const snapshot = await this.captureSnapshot(invoker, this.pageId, note);
      return { ok: true, ...snapshot };
    } catch (err) {
      return this.failed(invoker, (err as Error).message);
    }
  }

  /** Capture a screenshot of the current page. */
  async screenshot(fullPage = false): Promise<BrowserActionResult> {
    let invoker: BrowserToolInvoker;
    try {
      invoker = await this.ensureStarted();
    } catch (err) {
      return this.failed(undefined, (err as Error).message);
    }
    if (!this.pageId) return this.failed(invoker, 'Navigate to a page before taking a screenshot.');

    try {
      const base64 = await this.runCode(
        invoker,
        this.pageId,
        `return (await page.screenshot({ type: 'png', fullPage: ${fullPage ? 'true' : 'false'} })).toString('base64');`,
      );
      const snapshot = await this.captureSnapshot(invoker, this.pageId);
      return { ok: true, ...snapshot, screenshot: typeof base64 === 'string' ? base64 : String(base64) };
    } catch (err) {
      return this.failed(invoker, `screenshot failed: ${(err as Error).message}`);
    }
  }

  /** Drop the current page handle. VS Code owns the tab and its lifetime. */
  async close(): Promise<void> {
    this.pageId = undefined;
    this.started = false;
  }

  /** Get a short page summary (including recent console errors) for the model. */
  private async pageNote(invoker: BrowserToolInvoker, pageId: string): Promise<string | undefined> {
    try {
      const text = await this.call(invoker, 'read_page', { pageId });
      return this.shortNote(text);
    } catch {
      return undefined;
    }
  }

  /** Collect page metadata and interactive elements in one round trip each. */
  private async captureSnapshot(
    invoker: BrowserToolInvoker,
    pageId: string,
    note?: string,
  ): Promise<BrowserSnapshot> {
    let url = '';
    let title = '';
    let elements: BrowserElement[] = [];

    try {
      const meta = await this.runCode(invoker, pageId, 'return { url: page.url(), title: await page.title() };');
      url = typeof meta?.url === 'string' ? meta.url : '';
      title = typeof meta?.title === 'string' ? meta.title : '';
    } catch {
      /* metadata is best effort */
    }

    try {
      elements = await this.runCode(invoker, pageId, SNAPSHOT_CODE);
      if (!Array.isArray(elements)) elements = [];
      elements = elements.slice(0, MAX_SNAPSHOT_ELEMENTS).map((el: any, index: number) => ({
        role: String(el?.role ?? 'element').slice(0, 40),
        name: String(el?.name ?? '').slice(0, MAX_ELEMENT_DESCRIPTION),
        ref: typeof el?.ref === 'number' ? el.ref : index + 1,
        selector: typeof el?.selector === 'string' ? el.selector : undefined,
      }));
    } catch {
      /* elements are best effort */
    }

    const result: BrowserSnapshot = { url, title, elements };
    if (note) result.note = note;
    return result;
  }
}

/**
 * Playwright snippet run inside VS Code's browser page. It marks visible
 * interactive elements with a stable `data-cdh-ref` attribute so subsequent
 * tool calls can target them without guessing CSS selectors.
 */
const SNAPSHOT_CODE = `
return await page.evaluate((max) => {
  const selectors = [
    'a[href]', 'button', 'input', 'select', 'textarea',
    '[role="button"]', '[role="link"]', '[role="textbox"]',
    '[role="checkbox"]', '[role="combobox"]', '[role="tab"]',
    '[role="menuitem"]', '[role="searchbox"]',
  ];
  const nodes = Array.from(document.querySelectorAll(selectors.join(',')));
  const out = [];
  for (const el of nodes) {
    if (out.length >= max) break;
    const rect = el.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) continue;
    const style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    const ref = 'cdh' + (out.length + 1);
    el.setAttribute('data-cdh-ref', ref);
    const role = (el.getAttribute('role') || el.tagName.toLowerCase()).toLowerCase();
    const name = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.textContent || '')
      .trim().replace(/\\s+/g, ' ').slice(0, ${MAX_ELEMENT_DESCRIPTION});
    out.push({ role, name, ref: out.length + 1, selector: '[data-cdh-ref="' + ref + '"]' });
  }
  return out;
}, ${MAX_SNAPSHOT_ELEMENTS});
`;

/**
 * browser_tool: automate a web browser inside VS Code's integrated browser.
 *
 * Exposes navigate, click, type, press_key, scroll, wait_for, get_snapshot,
 * and screenshot actions. Returns a structured accessibility snapshot after
 * every action so the LLM can target elements by role/name/ref without
 * guessing coordinates. The browser runtime is provided by VS Code itself
 * (the same tools Copilot uses), so nothing is bundled with this extension.
 */
export const browserTool: Tool<BrowserToolArgs> = {
  name: 'browser_tool',
  description:
    'Automate a web browser inside VS Code integrated browser. Navigate, click, type, press keys, scroll, wait, inspect page snapshot, and capture screenshots. ' +
    'Uses the browser tools built into VS Code; no browser engine is bundled with the extension. ' +
    'Page state persists across calls within the same session.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['navigate', 'click', 'type', 'press_key', 'scroll', 'wait_for', 'get_snapshot', 'screenshot'],
        description: 'Browser action to perform.',
      },
      url: { type: 'string', description: 'URL to navigate to (navigate action).' },
      selector: { type: 'string', description: 'CSS selector or accessibility role/name to target (click/type/press_key/scroll/wait_for).' },
      text: { type: 'string', description: 'Text to type (type action).' },
      key: { type: 'string', description: 'Key to press (press_key action, e.g. Enter, Escape, Tab).' },
      x: { type: 'number', description: 'X coordinate (fallback click/scroll target).' },
      y: { type: 'number', description: 'Y coordinate (fallback click/scroll target).' },
      dx: { type: 'number', description: 'Horizontal scroll delta.' },
      dy: { type: 'number', description: 'Vertical scroll delta.' },
      ms: { type: 'number', description: 'Wait timeout in ms (wait_for action).' },
      fullPage: { type: 'boolean', description: 'Capture full page screenshot (screenshot action).' },
    },
    required: ['action'],
  },
  async run(args, ctx) {
    const host = ctx.host;
    const browser = host.browser;
    if (!browser) {
      return fail('Browser automation is not available in this environment.', 'browser unavailable');
    }

    // Respect browsePolicy: deny-all blocks, ask always prompts, auto-safe
    // prompts for navigation and form-submitting actions only.
    const stateChanging = args.action === 'navigate' || args.action === 'click' || args.action === 'type' || args.action === 'press_key';
    if (stateChanging) {
      const policy = ctx.config.browsePolicy ?? 'auto-safe';
      if (policy === 'deny-all') {
        return fail('Browser automation is disabled by browsePolicy (deny-all).', 'browser disabled', { disabled: true });
      }
      if (policy === 'ask' || policy === 'auto-safe') {
        const target = args.url ?? args.selector ?? args.key ?? args.text ?? args.action;
        const detail = `Action: ${args.action}\nTarget: ${String(target).slice(0, 200)}`;
        const decision = await ctx.approval({
          kind: 'navigate',
          title: `Browser: ${args.action}`,
          detail,
          command: args.url,
        });
        if (decision === 'reject') {
          return fail('User rejected browser action.', 'rejected by user', { rejected: true });
        }
      }
    }

    if (ctx.signal?.aborted) {
      return fail('Cancelled before running browser action.', 'cancelled', { cancelled: true });
    }

    const log = (level: 'debug' | 'info' | 'warn' | 'error', message: string) => host.log(level, message);

    try {
      switch (args.action) {
        case 'navigate':
          if (!args.url) return fail('"url" is required for navigate.', 'bad arguments');
          return await browser.navigate(args.url, log);
        case 'click':
          return await browser.click(args.selector, args.x, args.y);
        case 'type':
          if (!args.selector || args.text === undefined) return fail('"selector" and "text" are required for type.', 'bad arguments');
          return await browser.type(args.selector, args.text);
        case 'press_key':
          if (!args.key) return fail('"key" is required for press_key.', 'bad arguments');
          return await browser.pressKey(args.key, args.selector);
        case 'scroll':
          return await browser.scroll(args.selector, args.x, args.y, args.dx ?? 0, args.dy ?? 300);
        case 'wait_for':
          return await browser.waitFor(args.selector, args.ms);
        case 'get_snapshot':
          return await browser.getSnapshot();
        case 'screenshot':
          return await browser.screenshot(args.fullPage ?? false);
        default:
          return fail(`Unknown action: ${args.action}.`, 'bad arguments');
      }
    } catch (err) {
      return fail(`Browser action failed: ${(err as Error).message}.`, 'browser error');
    }
  },
};
