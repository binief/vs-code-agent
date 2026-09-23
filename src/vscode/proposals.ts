import * as path from 'path';
import * as vscode from 'vscode';
import type { ApprovalRequest } from '../core/types';

export const PROPOSAL_SCHEME = 'harness-proposal';

/**
 * Backs the read-only virtual documents used by the diff preview, so the user
 * can see exactly what the agent intends to write before approving it.
 */
export class ProposalStore implements vscode.TextDocumentContentProvider {
  private readonly contents = new Map<string, string>();
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? '';
  }

  add(label: string, content: string): vscode.Uri {
    const safe = label.replace(/[^\w.\-]+/g, '_').slice(0, 60);
    const uri = vscode.Uri.from({ scheme: PROPOSAL_SCHEME, path: `/${safe}`, query: String(Date.now()) });
    this.contents.set(uri.toString(), content);
    // Keep the store from growing without bound over a long session.
    if (this.contents.size > 200) {
      const oldest = this.contents.keys().next().value;
      if (oldest) this.contents.delete(oldest);
    }
    return uri;
  }

  dispose(): void {
    this.contents.clear();
    this.emitter.dispose();
  }
}

/** Open VS Code's native diff editor comparing the file with the proposal. */
export async function showProposalDiff(store: ProposalStore, req: ApprovalRequest): Promise<void> {
  if (req.kind !== 'write') return;
  const name = path.basename(req.relPath ?? req.absPath ?? 'file');

  const right = store.add(`${name}.proposed`, req.newContent ?? '');
  const left = req.oldContent === undefined
    ? store.add(`${name}.original`, '')
    : vscode.Uri.file(req.absPath ?? '');

  await vscode.commands.executeCommand(
    'vscode.diff',
    left,
    right,
    `${req.relPath ?? name} \u2194 proposed change`,
    { preview: true } as vscode.TextDocumentShowOptions,
  );
}
