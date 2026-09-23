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
        await this.controller.run(String(message.text ?? ''));
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
      <span class="chip" id="chip-workspace" title=""></span>
    </div>

    <div class="activity" id="activity" hidden>
      <span class="spinner" id="activity-spinner">\u25d0</span>
      <span class="activity-text" id="activity-text">Working\u2026</span>
      <span class="activity-detail" id="activity-detail"></span>
      <span class="activity-elapsed" id="activity-elapsed"></span>
    </div>

    <div class="stream-wrap">
      <button class="jump-latest" id="jump-latest" hidden>Jump to latest &#8595;</button>
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
      <div class="composer-row">
        <textarea id="input" rows="1" placeholder="Ask for a change, a fix, an explanation&#8230;" spellcheck="false"></textarea>
        <div class="composer-buttons">
          <button class="primary" id="btn-send" title="Run the task (Enter)">Run</button>
          <button class="danger" id="btn-stop" title="Stop the running task" hidden>Stop</button>
        </div>
      </div>
      <div class="composer-hint">
        <span id="hint-usage"></span>
        <button class="linklike" id="btn-selection" title="Insert the current editor selection">insert selection</button>
      </div>
    </footer>
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
