import { readFileSync } from 'node:fs';
import * as vscode from 'vscode';
import type { ApprovalDecision, ApprovalRequest } from '../core/types';
import type { HarnessController } from './controller';
import type { Logger } from './log';

export const CHAT_VIEW_ID = 'codingHarness.chat';

/**
 * Renders the agent panel and forwards user intent back to the controller.
 * Everything stateful lives in the controller, so this class stays a pipe:
 * HTML + CSP once, then messages in both directions.
 */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private messageDisposable?: vscode.Disposable;
  private templateHtml?: string;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly controller: HarnessController,
    private readonly log: Logger,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    view.webview.html = this.render(view.webview);

    this.messageDisposable?.dispose();
    this.messageDisposable = view.webview.onDidReceiveMessage((message) => void this.handle(message));

    view.onDidChangeVisibility(() => {
      if (view.visible) this.post({ type: 'state', state: this.controller.getState() });
    });
  }

  /** True when the approval was actually delivered to a visible panel. */
  postApproval(id: string, request: ApprovalRequest): boolean {
    if (!this.view || !this.view.visible) return false;
    this.post({ type: 'approval-request', id, request });
    return true;
  }

  post(message: unknown): void {
    void this.view?.webview.postMessage(message);
  }

  /** Reveal the panel (used by commands that need the user's attention). */
  async reveal(): Promise<void> {
    try {
      await vscode.commands.executeCommand(`${CHAT_VIEW_ID}.focus`);
    } catch {
      await vscode.commands.executeCommand('workbench.view.extension.codingHarness');
    }
  }

  dispose(): void {
    this.messageDisposable?.dispose();
  }

  /** Refresh the agents dialog after a change made outside it (file created). */
  private async postAgentSettings(): Promise<void> {
    this.post({ type: 'agent-settings', ...(await this.controller.getAgentSettings()) });
  }

  private async handle(message: any): Promise<void> {
    if (!message || typeof message.type !== 'string') return;
    await this.controller.whenReady();
    switch (message.type) {
      case 'ready':
      case 'reload':
        if (!this.controller.isBusy) await this.controller.refreshState();
        this.post({
          type: 'init',
          items: this.controller.getTranscript(),
          state: this.controller.getState(),
          activity: this.controller.getActivity(),
        });
        break;
      case 'submit':
        await this.controller.run(String(message.text ?? ''), Array.isArray(message.images) ? message.images : undefined);
        break;
      case 'cancel':
        this.controller.cancel();
        break;
      case 'reset':
        await this.controller.reset();
        break;
      case 'import-chat':
        await this.controller.importChat();
        break;
      case 'export-chat':
        await this.controller.exportChat();
        break;
      case 'revert':
        await this.controller.revertLastTask();
        break;
      case 'compact':
        await this.controller.compactHistory();
        break;
      case 'mcp-reload':
        await this.controller.reloadMcpServers();
        break;
      case 'get-mcp-settings':
        this.post({ type: 'mcp-settings', ...(await this.controller.getMcpSettings()) });
        break;
      case 'open-agents':
        await this.controller.openAgentInstructions();
        break;
      case 'get-agent-settings':
        this.post({ type: 'agent-settings', ...(await this.controller.getAgentSettings()) });
        break;
      case 'save-agent-selection':
        // `null` means "every discovered file"; the controller validates names.
        await this.controller.saveAgentSelection(message.selection ?? null);
        break;
      case 'create-agent-file':
        await this.controller.createAgentFile();
        await this.postAgentSettings();
        break;
      case 'preview-context':
        await this.controller.previewContext();
        break;
      case 'save-mcp-settings':
        await this.controller.saveMcpSettings({
          enabled: message.enabled,
          timeoutMs: message.timeoutMs,
          servers: message.servers,
          target: message.target,
        });
        break;
      case 'approval-response': {
        const decision: ApprovalDecision = message.decision === 'apply' ? 'apply' : 'reject';
        const remember = message.remember === 'kind' || message.remember === 'all' ? message.remember : undefined;
        this.controller.respondToApproval(String(message.id ?? ''), decision, remember);
        break;
      }
      case 'open-diff':
        await this.controller.openApprovalDiff(String(message.id ?? ''));
        break;
      case 'open-file':
        await this.controller.openFile(String(message.path ?? ''));
        break;
      case 'open-settings':
        await vscode.commands.executeCommand('workbench.action.openSettings', 'codingHarness');
        break;
      case 'copy':
        try {
          await vscode.env.clipboard.writeText(String(message.text ?? ''));
          this.post({ type: 'copy-result', id: message.id, ok: true });
        } catch (error) {
          this.log.warn(`clipboard write failed: ${String(error)}`);
          this.post({ type: 'copy-result', id: message.id, ok: false });
          void vscode.window.showErrorMessage('Coding Harness could not copy to the clipboard.');
        }
        break;
      case 'insert-code': {
        // Explicit user action: put a rendered code block at the cursor.
        const editor = vscode.window.activeTextEditor;
        if (!editor) break;
        const text = String(message.text ?? '');
        await editor.edit((builder) => builder.insert(editor.selection.active, text));
        break;
      }
      case 'open-external': {
        const url = String(message.url ?? '');
        // Only ever hand http(s) URLs to the browser; the panel is rendering
        // model output, so file: and command: links must not get through.
        if (/^https?:\/\//i.test(url)) await vscode.env.openExternal(vscode.Uri.parse(url));
        break;
      }
      case 'insert-selection': {
        const editor = vscode.window.activeTextEditor;
        if (!editor) break;
        const selection = editor.document.getText(editor.selection);
        const rel = vscode.workspace.asRelativePath(editor.document.uri, false);
        this.post({
          type: 'prefill',
          text: selection
            ? `In ${rel} (around line ${editor.selection.start.line + 1}):\n\n\`\`\`${editor.document.languageId}\n${selection}\n\`\`\`\n\n`
            : `In ${rel}: `,
        });
        break;
      }
      default:
        this.log.debug(`unhandled webview message: ${message.type}`);
    }
  }

  private render(webview: vscode.Webview): string {
    const nonce = makeNonce();
    const asset = (name: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', name)).toString();
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} data:`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    // The panel markup lives in media/panel.html so it can be edited as HTML
    // rather than as a template literal full of escaped quotes. Only these four
    // tokens are substituted; the file itself has no access to extension state.
    return this.template()
      .split('{{CSP}}').join(csp)
      .split('{{CSS}}').join(asset('chat.css'))
      .split('{{JS}}').join(asset('chat.js'))
      .split('{{NONCE}}').join(nonce);
  }

  /** Read media/panel.html once per session; the markup does not change at runtime. */
  private template(): string {
    if (this.templateHtml !== undefined) return this.templateHtml;
    const file = vscode.Uri.joinPath(this.extensionUri, 'media', 'panel.html').fsPath;
    try {
      this.templateHtml = readFileSync(file, 'utf8');
    } catch (error) {
      this.log.error(`could not read ${file}: ${String(error)}`);
      // A blank panel would look like a crash; say what happened instead.
      this.templateHtml = [
        '<!DOCTYPE html>',
        '<html lang="en"><head><meta charset="UTF-8" /><title>Coding Harness</title></head><body>',
        '<h2>Coding Harness could not load its panel</h2>',
        '<p>The file <code>media/panel.html</code> is missing from the extension folder.</p>',
        '<p>Reinstall the extension, or rebuild it with <code>npm run package</code>.</p>',
        '</body></html>',
      ].join('\n');
    }
    return this.templateHtml;
  }
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
