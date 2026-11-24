import * as path from 'path';
import { fail, ok, type Tool } from '../types';
import { resolveWorkspacePath } from '../paths';

// `window` and `document` are referenced inside page.evaluate() callbacks,
// which run in the browser context, not the Node.js context.
declare const window: any;
declare const document: any;

/** Maximum number of elements to include in an accessibility snapshot. */
const MAX_SNAPSHOT_ELEMENTS = 60;

/** Maximum characters for any single element description in a snapshot. */
const MAX_ELEMENT_DESCRIPTION = 120;

/** Default navigation timeout in ms. */
const DEFAULT_NAVIGATE_TIMEOUT_MS = 30_000;

/** Default action timeout in ms. */
const DEFAULT_ACTION_TIMEOUT_MS = 10_000;

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

/**
 * Manages a persistent Playwright browser session per workspace.
 *
 * Lazily installs `playwright-core` on first use (detect-and-prompt), then
 * launches a headless Chromium with an isolated context so cookies, localStorage,
 * and page state persist across tool calls within a session.
 */
export class BrowserManager {
  private browser: any = null;
  private context: any = null;
  private page: any = null;
  private started = false;
  private playwright: any = null;

  /** Whether Playwright is available (installed or already present). */
  async isPlaywrightAvailable(): Promise<boolean> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const pw = require('playwright-core');
      this.playwright = pw;
      return true;
    } catch {
      return false;
    }
  }

  /** Prompt the user to install Playwright, then launch the browser. */
  async ensureStarted(log: (level: string, message: string) => void): Promise<void> {
    if (this.started) return;

    const available = await this.isPlaywrightAvailable();
    if (!available) {
      throw new Error(
        'Browser automation requires Playwright, which is not installed. ' +
          'Run "npm install playwright-core" in the workspace to enable browser tools.',
      );
    }

    try {
      // Launch headless Chromium with an isolated browser context.
      this.browser = await this.playwright.chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });
      this.context = await this.browser.newContext();
      this.page = await this.context.newPage();
      this.started = true;
      log('info', 'BrowserManager: headless Chromium started');
    } catch (err) {
      throw new Error(
        `Failed to start headless browser: ${(err as Error).message}. ` +
          'Ensure Playwright is installed and a Chromium browser is available.',
      );
    }
  }

  /** Close the browser and release all resources. Called on extension deactivation. */
  async close(): Promise<void> {
    try {
      if (this.page) {
        await this.page.close().catch(() => {});
        this.page = null;
      }
      if (this.context) {
        await this.context.close().catch(() => {});
        this.context = null;
      }
      if (this.browser) {
        await this.browser.close().catch(() => {});
        this.browser = null;
      }
    } catch {
      /* best-effort cleanup */
    }
    this.started = false;
  }

  /** Get the current page, throwing if not started. */
  private requirePage(): any {
    if (!this.page) throw new Error('Browser not started. Call navigate() first.');
    return this.page;
  }

  /** Navigate to a URL and return a snapshot. */
  async navigate(url: string, log: (level: string, message: string) => void): Promise<BrowserActionResult> {
    const page = await this.ensureStartedAndGetPage(log);
    try {
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: DEFAULT_NAVIGATE_TIMEOUT_MS,
      });
      const snapshot = await this.captureSnapshot(page);
      return { ok: true, url, title: await page.title().catch(() => ''), elements: snapshot.elements, note: snapshot.note };
    } catch (err) {
      const message = (err as Error).message;
      const snapshot = this.page ? await this.captureSnapshot(this.page) : { elements: [], note: undefined };
      return {
        ok: false,
        url,
        title: '',
        elements: snapshot.elements,
        error: message,
        note: snapshot.note,
      };
    }
  }

  /** Click an element by selector or coordinates. */
  async click(selector?: string, x?: number, y?: number): Promise<BrowserActionResult> {
    const page = this.requirePage();
    let targetDesc = '';
    try {
      if (selector) {
        await page.click(selector, { timeout: DEFAULT_ACTION_TIMEOUT_MS });
        targetDesc = selector;
      } else if (x !== undefined && y !== undefined) {
        await page.mouse.click(x, y);
        targetDesc = `(${x},${y})`;
      } else {
        return failResult(page, 'click requires a selector or x/y coordinates');
      }
      const snapshot = await this.captureSnapshot(page);
      return { ok: true, url: page.url(), title: await page.title().catch(() => ''), elements: snapshot.elements, note: snapshot.note };
    } catch (err) {
      return failResult(page, `click(${targetDesc}) failed: ${(err as Error).message}`);
    }
  }

  /** Type text into an element by selector. */
  async type(selector: string, text: string): Promise<BrowserActionResult> {
    const page = this.requirePage();
    try {
      await page.fill(selector, text, { timeout: DEFAULT_ACTION_TIMEOUT_MS });
      const snapshot = await this.captureSnapshot(page);
      return { ok: true, url: page.url(), title: await page.title().catch(() => ''), elements: snapshot.elements, note: snapshot.note };
    } catch (err) {
      return failResult(page, `type(${selector}) failed: ${(err as Error).message}`);
    }
  }

  /** Press a key on the keyboard. */
  async pressKey(key: string): Promise<BrowserActionResult> {
    const page = this.requirePage();
    try {
      await page.keyboard.press(key, { timeout: DEFAULT_ACTION_TIMEOUT_MS });
      const snapshot = await this.captureSnapshot(page);
      return { ok: true, url: page.url(), title: await page.title().catch(() => ''), elements: snapshot.elements, note: snapshot.note };
    } catch (err) {
      return failResult(page, `press_key(${key}) failed: ${(err as Error).message}`);
    }
  }

  /** Scroll at an element or coordinates. */
  async scroll(selector?: string, x?: number, y?: number, dx = 0, dy = 300): Promise<BrowserActionResult> {
    const page = this.requirePage();
    let targetDesc = '';
    try {
      if (selector) {
        await page.hover(selector, { timeout: DEFAULT_ACTION_TIMEOUT_MS });
        targetDesc = selector;
      } else if (x !== undefined && y !== undefined) {
        await page.mouse.move(x, y);
        targetDesc = `(${x},${y})`;
      } else {
        return failResult(page, 'scroll requires a selector or x/y coordinates');
      }
      await page.evaluate(([dX, dY]: [number, number]) => {
        (window as any).scrollBy(dX, dY);
      }, [dx, dy]);
      const snapshot = await this.captureSnapshot(page);
      return { ok: true, url: page.url(), title: await page.title().catch(() => ''), elements: snapshot.elements, note: snapshot.note };
    } catch (err) {
      return failResult(page, `scroll(${targetDesc}) failed: ${(err as Error).message}`);
    }
  }

  /** Wait for an element to appear or a fixed time. */
  async waitFor(selector?: string, ms?: number): Promise<BrowserActionResult> {
    const page = this.requirePage();
    try {
      if (selector) {
        await page.waitForSelector(selector, { timeout: ms ?? DEFAULT_ACTION_TIMEOUT_MS });
      } else if (ms) {
        await page.waitForTimeout(ms);
      } else {
        return failResult(page, 'wait_for requires a selector or ms timeout');
      }
      const snapshot = await this.captureSnapshot(page);
      return { ok: true, url: page.url(), title: await page.title().catch(() => ''), elements: snapshot.elements, note: snapshot.note };
    } catch (err) {
      return failResult(page, `wait_for failed: ${(err as Error).message}`);
    }
  }

  /** Capture an accessibility snapshot of the current page. */
  async getSnapshot(): Promise<BrowserActionResult> {
    const page = this.requirePage();
    const snapshot = await this.captureSnapshot(page);
    return { ok: true, url: page.url(), title: await page.title().catch(() => ''), elements: snapshot.elements, note: snapshot.note };
  }

  /** Capture a screenshot of the current page. */
  async screenshot(fullPage = false): Promise<BrowserActionResult> {
    const page = this.requirePage();
    try {
      const buffer = await page.screenshot({ fullPage, type: 'png' });
      const base64 = buffer.toString('base64');
      const snapshot = await this.captureSnapshot(page);
      return {
        ok: true,
        url: page.url(),
        title: await page.title().catch(() => ''),
        elements: snapshot.elements,
        screenshot: base64,
        note: snapshot.note,
      };
    } catch (err) {
      return failResult(page, `screenshot failed: ${(err as Error).message}`);
    }
  }

  /** Ensure started and return the page. */
  private async ensureStartedAndGetPage(log: (level: string, message: string) => void): Promise<any> {
    if (!this.started) await this.ensureStarted(log);
    return this.requirePage();
  }

  /** Build a token-efficient accessibility snapshot of interactive elements. */
  private async captureSnapshot(page: any): Promise<BrowserSnapshot> {
    const url = page.url();
    const title = await page.title().catch(() => '');
    let note: string | undefined;

    // Detect iframe embedding restrictions that Simple Browser would enforce.
    try {
      const frameAncestors = await page.evaluate(() => {
        const meta = (document as any).querySelector('meta[http-equiv="Content-Security-Policy"]');
        return meta ? meta.getAttribute('content') : null;
      });
      if (frameAncestors && /frame-ancestors/.test(frameAncestors)) {
        note = 'Page may not render in Simple Browser due to CSP frame-ancestors; Playwright automation still functional.';
      }
    } catch {
      /* ignore CSP check failures */
    }

    let elements: BrowserElement[] = [];
    try {
      const axTree = await page.accessibility.snapshot({ interestingOnly: true, root: page.locator('body') });
      elements = this.flattenAxTree(axTree, 0);
    } catch {
      // Fallback: query common interactive selectors directly.
      elements = await this.fallbackSnapshot(page);
    }

    // Cap elements to keep the snapshot token-efficient.
    if (elements.length > MAX_SNAPSHOT_ELEMENTS) {
      elements = elements.slice(0, MAX_SNAPSHOT_ELEMENTS);
      note = (note ? note + ' ' : '') + `Snapshot capped at ${MAX_SNAPSHOT_ELEMENTS} elements.`;
    }

    return { url, title, elements, note };
  }

  /** Flatten the Playwright accessibility tree into BrowserElement list. */
  private flattenAxTree(node: any, depth: number, refCounter = [0]): BrowserElement[] {
    if (!node || depth > 6) return [];
    const elements: BrowserElement[] = [];

    const role = node.role;
    const name = node.name || '';
    const interactiveRoles = new Set([
      'button', 'link', 'textbox', 'combobox', 'checkbox', 'radio', 'menuitem',
      'tab', 'search', 'slider', 'spinbutton', 'heading', 'listbox', 'option',
    ]);

    if (role && interactiveRoles.has(role) && name) {
      const selector = this.buildSelector(node);
      elements.push({
        role,
        name: name.slice(0, MAX_ELEMENT_DESCRIPTION),
        ref: refCounter[0]++,
        selector,
      });
    }

    if (node.children) {
      for (const child of node.children) {
        elements.push(...this.flattenAxTree(child, depth + 1, refCounter));
      }
    }

    return elements;
  }

  /** Best-effort selector for an accessibility node. */
  private buildSelector(node: any): string | undefined {
    // Playwright AX nodes don't always expose a direct selector; return best-effort.
    if (node.name) {
      // Use role + accessible name as a Playwright-compatible selector.
      return `${node.role.toLowerCase()}:has-text("${node.name.replace(/"/g, '\\"')}")`;
    }
    return undefined;
  }

  /** Fallback snapshot using direct DOM queries when accessibility tree fails. */
  private async fallbackSnapshot(page: any): Promise<BrowserElement[]> {
    const selectors = [
      'button', 'a', 'input', 'select', 'textarea', '[role="button"]',
      '[role="link"]', '[role="textbox"]', '[role="checkbox"]',
    ];
    const elements: BrowserElement[] = [];
    let ref = 0;
    for (const sel of selectors) {
      try {
        const count = await page.locator(sel).count();
        for (let i = 0; i < Math.min(count, 10); i++) {
          const loc = page.locator(sel).nth(i);
          const name = ((await loc.textContent().catch(() => '')) || (await loc.getAttribute('aria-label').catch(() => '')) || '').slice(0, MAX_ELEMENT_DESCRIPTION);
          const visible = await loc.isVisible().catch(() => false);
          if (visible && name) {
            elements.push({ role: sel, name, ref: ref++, selector: `${sel}:nth-match("${name}", ${i + 1})` });
          }
        }
      } catch {
        /* ignore selector failures */
      }
    }
    return elements;
  }
}

/** Build a failed action result with current page state. */
async function failResult(page: any, error: string): Promise<BrowserActionResult> {
  let elements: BrowserElement[] = [];
  let url = '';
  let title = '';
  try {
    url = page.url();
    title = await page.title().catch(() => '');
    const snap = await page.accessibility.snapshot({ interestingOnly: true, root: page.locator('body') });
    elements = []; // keep minimal on failure
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _ = snap;
  } catch {
    /* ignore */
  }
  return { ok: false, url, title, elements, error };
}

/**
 * browser_tool: automate a web browser inside VS Code Simple Browser.
 *
 * Exposes navigate, click, type, press_key, scroll, wait_for, get_snapshot,
 * and screenshot actions. Returns a structured accessibility snapshot after
 * every action so the LLM can target elements by role/name/ref without
 * guessing coordinates.
 */
export const browserTool: Tool<BrowserToolArgs> = {
  name: 'browser_tool',
  description:
    'Automate a web browser inside VS Code Simple Browser. Navigate, click, type, press keys, scroll, wait, inspect page snapshot, and capture screenshots. ' +
    'Multi-step state (cookies, localStorage) persists across calls within a workspace session. ' +
    'On first use, prompts to install Playwright if not already present.',
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
          return await browser.pressKey(args.key);
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
