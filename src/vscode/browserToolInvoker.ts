import * as vscode from 'vscode';
import type { BrowserInvocation, BrowserToolInvoker } from '../core/tools/browserTool';

/**
 * Bridges browser_tool to the browser tools that are built into VS Code.
 *
 * Those tools (`open_browser_page`, `read_page`, `click_element`,
 * `type_in_page`, `run_playwright_code`, …) are the same tools Copilot uses to
 * drive the integrated browser. They are registered in VS Code's language
 * model tool registry and are callable from any extension through the stable
 * `vscode.lm.invokeTool` API. No browser engine or Playwright dependency is
 * needed in this extension.
 */
export function createBrowserToolInvoker(): BrowserToolInvoker {
  return {
    async availableTools(): Promise<readonly string[]> {
      const tools = vscode.lm?.tools;
      if (!tools) return [];
      return tools.map((tool) => tool.name);
    },

    async invoke(name: string, input: Record<string, unknown>): Promise<BrowserInvocation> {
      const result = await vscode.lm.invokeTool(name, {
        toolInvocationToken: undefined,
        input,
      });

      let text = '';
      for (const part of result?.content ?? []) {
        if (part instanceof vscode.LanguageModelTextPart) {
          text += part.value;
        } else {
          const value = (part as { value?: unknown } | undefined)?.value;
          if (typeof value === 'string') text += value;
        }
      }
      // The extension API does not expose `toolResultError`, but VS Code sets
      // `hasError` on the result when a built-in tool reported a failure.
      if ((result as { hasError?: boolean }).hasError) {
        throw new Error(text.trim() || 'Browser tool reported an error.');
      }
      return { text };
    },
  };
}
