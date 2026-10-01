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

  private async handle(message: any): Promise<void> {
    if (!message || typeof message.type !== 'string') return;
    switch (message.type) {
      case 'ready':
      case 'reload':
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
        this.controller.reset();
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
        this.post({ type: 'mcp-settings', ...this.controller.getMcpSettings() });
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
    const asset = (name: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', name));
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} data:`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="stylesheet" href="${asset('chat.css')}" />
<title>Coding Harness</title>
</head>
<body>
  <div class="app">
    <header class="head">
      <div class="headline">
        <span class="dot" id="status-dot" data-status="idle"></span>
        <span class="headline-text" id="status-text">Idle</span>
      </div>
      <div class="headline-actions">
        <button class="icon-btn" id="btn-compact" title="Compact conversation to free context">Compact</button>
        <button class="icon-btn" id="btn-mcp" title="MCP servers — configure and reload">MCP</button>
        <button class="icon-btn" id="btn-revert" title="Undo the file changes from the last task">Revert</button>
        <button class="icon-btn" id="btn-reset" title="Start a new conversation">New</button>
        <button class="icon-btn" id="btn-settings" title="Open Coding Harness settings">&#9881;</button>
      </div>
    </header>

    <div class="meta">
      <span class="chip" id="chip-provider">provider</span>
      <span class="chip" id="chip-policy">policy</span>
      <span class="chip" id="chip-stream" title="Token-by-token rendering of model output">stream</span>
      <span class="chip" id="chip-thinking" title="The model's reasoning stream, when the backend provides one">thinking</span>
      <span class="chip tokens" id="chip-tokens" title="Total tokens used (input + output)">0 tokens</span>
      <span class="chip speed" id="chip-speed" title="Current generation speed" hidden>0 tok/s</span>
      <span class="chip context" id="chip-context" title="Context window utilisation">ctx 0%</span>
      <span class="chip mcp" id="chip-mcp" title="MCP servers" hidden>mcp: off</span>
      <span class="chip" id="chip-workspace" title=""></span>
    </div>

    <div class="compact-banner" id="compact-banner" hidden>
      <span class="compact-text" id="compact-text">Context is getting full. Consider compacting.</span>
      <div class="compact-actions">
        <button class="primary" id="btn-compact-banner" title="Summarise older messages to free context">Compact</button>
        <button id="btn-compact-dismiss" title="Dismiss">✕</button>
      </div>
    </div>

    <div class="activity" id="activity" hidden>
      <span class="spinner" id="activity-spinner">◐</span>
      <span class="activity-text" id="activity-text">Working…</span>
      <span class="activity-detail" id="activity-detail"></span>
      <span class="activity-elapsed" id="activity-elapsed"></span>
    </div>

    <div class="stream-wrap">
      <button class="jump-latest" id="jump-latest" hidden>Jump to latest ↓</button>
      <main class="stream" id="stream">
      <div class="empty" id="empty">
        <h2>Coding Harness</h2>
        <p>Describe a coding task and the agent will explore the workspace, edit files and run commands through
        its sandboxed tool set. Every change is checkpointed and can be reverted.</p>
        <ul class="examples" id="examples">
          <li data-prompt="Explain the structure of this project and list the main entry points.">Explain this project</li>
          <li data-prompt="Find the function that handles configuration loading and summarise what it does.">Find a function</li>
          <li data-prompt="Run the test suite and fix the first failing test.">Run the tests and fix failures</li>
          <li data-prompt="Add a docstring to every public function in the main module.">Document the main module</li>
        </ul>
        </div>
      </main>
    </div>

    <footer class="composer">
      <div class="attachments" id="attachments" hidden></div>
      <div class="composer-row">
        <textarea id="input" rows="1" placeholder="Ask for a change, a fix, an explanation… (paste or drop an image)" spellcheck="false"></textarea>
        <div class="composer-buttons">
          <button class="primary" id="btn-send" title="Run the task (Enter)">Run</button>
          <button class="danger" id="btn-stop" title="Stop the running task" hidden>Stop</button>
        </div>
      </div>
      <div class="composer-hint">
        <span id="hint-usage"></span>
        <button class="linklike" id="btn-selection" title="Insert the current editor selection">insert selection</button>
        <button class="linklike" id="btn-attach" title="Attach an image (or paste one with Ctrl/Cmd+V)">attach image</button>
        <input type="file" id="file-input" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden />
      </div>
    </footer>

    <div class="modal-backdrop" id="mcp-modal" hidden>
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="mcp-modal-title">
        <div class="modal-head">
          <span class="modal-title" id="mcp-modal-title">MCP servers</span>
          <button class="icon-btn" id="mcp-modal-close" title="Close">✕</button>
        </div>
        <div class="modal-body">
          <label class="check-row">
            <input type="checkbox" id="mcp-enabled" />
            <span>Enable MCP servers</span>
          </label>
          <div class="form-row">
            <label for="mcp-timeout">Tool call timeout (ms)</label>
            <input type="number" id="mcp-timeout" min="1000" step="500" />
          </div>
          <div class="server-list" id="mcp-server-list"></div>
          <button class="linklike" id="mcp-add">+ Add server</button>
          <div class="mcp-help">
            <p>
              MCP (Model Context Protocol) servers add their tools to the agent, prefixed
              <code>mcp_&lt;server&gt;_&lt;tool&gt;</code>. A <strong>stdio</strong> server is a command the editor
              spawns and talks to over its stdin/stdout; <strong>http</strong> and <strong>sse</strong> servers are
              reached over the network at a <code>https://</code> endpoint — Streamable HTTP by default, with
              automatic fallback to the older SSE transport (or force one via the type selector).
            </p>
            <p>
              Stdio example: <code>npx -y @modelcontextprotocol/server-filesystem .</code><br />
              HTTP example: <code>url: https://mcp.example.com/mcp</code> with header
              <code>Authorization: Bearer …</code>
            </p>
            <p>
              Saved to <code>codingHarness.mcp.*</code>; servers (re)connect on save or via Reload.
            </p>
          </div>
        </div>
        <div class="modal-foot">
          <select id="mcp-target" title="Which settings file to write">
            <option value="user">User settings (all workspaces)</option>
            <option value="workspace">Workspace settings (.vscode/settings.json)</option>
          </select>
          <span class="modal-status" id="mcp-modal-status"></span>
          <button id="mcp-reload" title="Stop every server and connect again from the stored settings">Reload</button>
          <button class="primary" id="mcp-save" title="Write these settings and connect">Save</button>
        </div>
      </div>
    </div>
  </div>
  <script nonce="${nonce}" src="${asset('chat.js')}"></script>
</body>
</html>`;
  }
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
