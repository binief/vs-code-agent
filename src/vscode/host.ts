import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { isInside } from '../core/paths';
import type {
  ApprovalDecision,
  ApprovalRequest,
  Diagnostic,
  HarnessHost,
} from '../core/types';
import type { Logger } from './log';

export const APPROVAL_KINDS = ['write', 'delete', 'command'] as const;

type PendingResolver = (decision: ApprovalDecision) => void;

/**
 * Single place where the agent's approval requests are turned into UI.
 *
 * Prefers the chat webview (rich, inline diff). If the panel is not visible it
 * falls back to a modal dialog so a background task can never hang silently.
 */
export class ApprovalService {
  private readonly pending = new Map<string, PendingResolver>();
  private counter = 0;
  /** Returns true when the request was actually shown in the webview. */
  private bridge?: (id: string, req: ApprovalRequest) => boolean;
  /** Session-only "always allow" switches, driven by the webview buttons. */
  private readonly autoApprove = new Set<string>();

  constructor(private readonly log: Logger) {}

  setBridge(bridge: ((id: string, req: ApprovalRequest) => boolean) | undefined): void {
    this.bridge = bridge;
  }

  /** True when the user said "don't ask again" for this kind (or all kinds). */
  isAutoApproved(kind: ApprovalRequest['kind']): boolean {
    return this.autoApprove.has(kind) || this.autoApprove.has('all');
  }

  rememberAlways(kind: ApprovalRequest['kind'] | 'all'): void {
    this.autoApprove.add(kind);
  }

  forgetAll(): void {
    this.autoApprove.clear();
  }

  async request(req: ApprovalRequest): Promise<ApprovalDecision> {
    if (this.isAutoApproved(req.kind)) {
      this.log.debug(`auto-approved (session): ${req.title}`);
      return 'apply';
    }

    const id = `approval-${++this.counter}`;
    if (this.bridge?.(id, req)) {
      return new Promise<ApprovalDecision>((resolve) => {
        this.pending.set(id, resolve);
      });
    }
    return this.askModally(req);
  }

  /** Called by the webview when the user clicks Apply / Reject. */
  resolve(id: string, decision: ApprovalDecision): void {
    const resolver = this.pending.get(id);
    if (!resolver) return;
    this.pending.delete(id);
    resolver(decision);
  }

  /** Reject everything still waiting (used on deactivate / cancel). */
  cancelAll(): void {
    for (const [, resolve] of this.pending) resolve('reject');
    this.pending.clear();
  }

  private async askModally(req: ApprovalRequest): Promise<ApprovalDecision> {
    const detail = req.detail.length > 1200 ? `${req.detail.slice(0, 1200)}\n\u2026 (truncated)` : req.detail;
    const yes = 'Apply';
    const no = 'Reject';
    const answer = await vscode.window.showWarningMessage(
      `${req.title}\n(The agent panel is hidden, so approvals use this dialog.)`,
      { modal: true, detail },
      yes,
      no,
    );
    return answer === yes ? 'apply' : 'reject';
  }
}

export interface VsCodeHostOptions {
  root: string;
  log: Logger;
  approvals: ApprovalService;
}

/**
 * VS Code implementation of the core {@link HarnessHost}.
 *
 * File writes go through a WorkspaceEdit so the editor's undo stack and the
 * file watchers stay consistent instead of the file changing behind VS Code's
 * back; diagnostics and file opening come from the language services.
 */
export class VsCodeHost implements HarnessHost {
  readonly workspaceRoot: string;

  constructor(private readonly opts: VsCodeHostOptions) {
    this.workspaceRoot = opts.root;
  }

  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
    this.opts.log[level](message);
  }

  requestApproval(req: ApprovalRequest): Promise<ApprovalDecision> {
    return this.opts.approvals.request(req);
  }

  async notify(message: string, kind: 'info' | 'warn' | 'error' = 'info'): Promise<void> {
    if (kind === 'error') void vscode.window.showErrorMessage(message);
    else if (kind === 'warn') void vscode.window.showWarningMessage(message);
    else void vscode.window.showInformationMessage(message);
  }

  /** Write through a WorkspaceEdit when the document is open in the editor. */
  async applyFileWrite(absPath: string, content: string): Promise<void> {
    const uri = vscode.Uri.file(absPath);
    try {
      const edit = new vscode.WorkspaceEdit();
      if (fs.existsSync(absPath)) {
        const doc = await vscode.workspace.openTextDocument(uri);
        const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
        edit.replace(uri, fullRange, content);
        const applied = await vscode.workspace.applyEdit(edit);
        if (!applied) throw new Error('applyEdit returned false');
        const updated = await vscode.workspace.openTextDocument(uri);
        await updated.save();
        return;
      }

      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      edit.createFile(uri, { ignoreIfExists: true });
      edit.insert(uri, new vscode.Position(0, 0), content);
      const applied = await vscode.workspace.applyEdit(edit);
      if (!applied) throw new Error('applyEdit returned false');
      const created = await vscode.workspace.openTextDocument(uri);
      await created.save();
    } catch (err) {
      this.log('warn', `WorkspaceEdit failed for ${absPath} (${(err as Error).message}); falling back to the filesystem`);
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, content, 'utf8');
    }
  }

  async getDiagnostics(relPath?: string): Promise<Diagnostic[]> {
    const root = this.workspaceRoot;
    const wanted = relPath ? path.resolve(root, relPath) : undefined;
    const out: Diagnostic[] = [];
    for (const [uri, diags] of vscode.languages.getDiagnostics()) {
      if (uri.scheme !== 'file') continue;
      if (!isInside(root, uri.fsPath)) continue;
      if (wanted && path.resolve(uri.fsPath) !== wanted) continue;
      const rel = path.relative(root, uri.fsPath).split(path.sep).join('/');
      for (const d of diags) {
        out.push({
          file: rel,
          line: d.range.start.line + 1,
          severity: severityName(d.severity),
          message: d.message,
          source: d.source,
        });
      }
    }
    out.sort((a, b) => (a.severity === b.severity ? a.file.localeCompare(b.file) : a.severity === 'error' ? -1 : 1));
    return out.slice(0, 500);
  }

  async openFile(absPath: string, line?: number): Promise<void> {
    const uri = vscode.Uri.file(absPath);
    const doc = await vscode.workspace.openTextDocument(uri);
    const options: vscode.TextDocumentShowOptions = { preview: false, preserveFocus: true };
    const doc2 = doc;
    const target = Math.max(0, (line ?? 1) - 1);
    const clamped = Math.min(target, Math.max(0, doc2.lineCount - 1));
    options.selection = new vscode.Range(clamped, 0, clamped, 0);
    await vscode.window.showTextDocument(doc, options);
  }
}

function severityName(severity: vscode.DiagnosticSeverity): Diagnostic['severity'] {
  switch (severity) {
    case vscode.DiagnosticSeverity.Error:
      return 'error';
    case vscode.DiagnosticSeverity.Warning:
      return 'warning';
    case vscode.DiagnosticSeverity.Information:
      return 'info';
    default:
      return 'hint';
  }
}
