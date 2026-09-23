import * as path from 'path';
import * as vscode from 'vscode';
import { HarnessSession } from '../core/agent';
import { apiKeyFromEnv, createProvider } from '../core/providers';
import { resolveConfig, type ApprovalRequest, type HarnessConfig, type HarnessEvent, type TaskOutcome } from '../core/types';
import type { ApprovalService } from './host';
import { VsCodeHost } from './host';
import type { Logger } from './log';
import type { ProposalStore } from './proposals';
import { showProposalDiff } from './proposals';

export type TranscriptItem =
  | { id: string; kind: 'user'; text: string }
  | { id: string; kind: 'assistant'; text: string; final: boolean; streaming?: boolean }
  | {
      id: string;
      kind: 'tool';
      toolCallId: string;
      name: string;
      args: string;
      status: 'running' | 'ok' | 'failed';
      startedAt?: number;
      summary?: string;
      detail?: string;
      durationMs?: number;
      relPath?: string;
    }
  | { id: string; kind: 'approval'; approvalId: string; request: ApprovalRequest; decision?: 'apply' | 'reject' }
  | { id: string; kind: 'notice'; level: 'info' | 'warn' | 'error'; message: string }
  | { id: string; kind: 'done'; reason: TaskOutcome; summary: string; filesChanged: string[] };

/** What the agent is doing right now, for the live activity strip. */
export interface Activity {
  status: 'idle' | 'thinking' | 'executing' | 'approval';
  step: number;
  maxSteps: number;
  /** Tool currently executing, if any. */
  tool: string | null;
  /** Human-readable detail, e.g. the command or file being worked on. */
  detail: string | null;
  /** Epoch ms when the current phase began (drives the elapsed timer). */
  startedAt: number;
  /** Epoch ms when the whole task began. */
  taskStartedAt: number;
}

export interface UiState {
  status: 'idle' | 'thinking' | 'executing' | 'approval' | 'running';
  busy: boolean;
  step: number;
  maxSteps: number;
  provider: string;
  model: string;
  workspace: string;
  editPolicy: string;
  commandPolicy: string;
  keyPresent: boolean;
  toolCount: number;
  /** Whether model output is streamed into the panel. */
  stream: boolean;
}

const MAX_ITEMS = 400;

/**
 * Owns the agent session and translates core events into renderable UI items.
 * The webview is a thin renderer; everything else lives here so the same
 * controller can drive the commands, the view and future UIs.
 */
export class HarnessController {
  private session?: HarnessSession;
  private host?: VsCodeHost;
  private items: TranscriptItem[] = [];
  private readonly listeners = new Set<(message: unknown) => void>();
  private counter = 0;
  /** Throttled streaming buffers, keyed by assistant message id. */
  private readonly streams = new Map<string, { timer?: NodeJS.Timeout }>();
  private activity: Activity = {
    status: 'idle',
    step: 0,
    maxSteps: 0,
    tool: null,
    detail: null,
    startedAt: 0,
    taskStartedAt: 0,
  };
  private state: UiState = {
    status: 'idle',
    busy: false,
    step: 0,
    maxSteps: 12,
    provider: 'openai',
    model: 'gpt-4o-mini',
    workspace: '',
    editPolicy: 'ask',
    commandPolicy: 'auto-safe',
    keyPresent: false,
    toolCount: 0,
    stream: true,
  };

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: Logger,
    private readonly approvals: ApprovalService,
    private readonly proposals: ProposalStore,
  ) {}

  /* ------------------------------------------------------------- wiring */

  onUiMessage(listener: (message: unknown) => void): vscode.Disposable {
    this.listeners.add(listener);
    return new vscode.Disposable(() => this.listeners.delete(listener));
  }

  private post(message: unknown): void {
    for (const listener of this.listeners) {
      try {
        listener(message);
      } catch (err) {
        this.log.warn(`webview post failed: ${(err as Error).message}`);
      }
    }
  }

  getTranscript(): TranscriptItem[] {
    return this.items;
  }

  getState(): UiState {
    return { ...this.state };
  }

  getActivity(): Activity {
    return { ...this.activity };
  }

  get isBusy(): boolean {
    return this.state.busy;
  }

  /* --------------------------------------------------------- config/key */

  private workspaceRoot(): string {
    const folder = vscode.workspace.workspaceFolders?.[0];
    return folder ? folder.uri.fsPath : '';
  }

  readConfig(): HarnessConfig {
    const c = vscode.workspace.getConfiguration('codingHarness');
    return resolveConfig({
      provider: c.get('provider'),
      model: c.get('model'),
      baseUrl: c.get('baseUrl'),
      apiKey: c.get('apiKey'),
      maxSteps: c.get('maxSteps'),
      temperature: c.get('temperature'),
      maxOutputTokens: c.get('maxOutputTokens'),
      editPolicy: c.get('editPolicy'),
      commandPolicy: c.get('commandPolicy'),
      allowDangerousCommands: c.get('allowDangerousCommands'),
      commandTimeoutMs: c.get('commandTimeoutMs'),
      allowOutsideWorkspace: c.get('allowOutsideWorkspace'),
      maxFileBytes: c.get('maxFileBytes'),
      includeDiagnosticsInPrompt: c.get('includeDiagnosticsInPrompt'),
      systemPromptExtra: c.get('systemPromptExtra'),
      stream: c.get('stream'),
    });
  }

  private async secretKey(): Promise<string | undefined> {
    try {
      return await this.context.secrets.get('codingHarness.apiKey');
    } catch {
      return undefined;
    }
  }

  async storeApiKey(key: string): Promise<void> {
    await this.context.secrets.store('codingHarness.apiKey', key);
    this.log.info('API key stored in secret storage');
    await this.refreshState();
  }

  private async resolveApiKey(config: HarnessConfig): Promise<string | undefined> {
    if (config.apiKey?.trim()) return config.apiKey.trim();
    const stored = await this.secretKey();
    if (stored?.trim()) return stored.trim();
    return apiKeyFromEnv(config.provider);
  }

  /* ------------------------------------------------------------- session */

  private async ensureSession(): Promise<HarnessSession> {
    const root = this.workspaceRoot();
    if (!root) throw new Error('Open a folder or workspace before running the Coding Harness.');

    const config = this.readConfig();
    const apiKey = await this.resolveApiKey(config);
    const provider = createProvider({ config, apiKey });

    if (config.provider !== 'mock' && !apiKey) {
      this.post({
        type: 'notice',
        level: 'warn',
        message: `No API key configured for provider "${config.provider}". Run "Coding Harness: Set API Key", or switch codingHarness.provider to "mock" for the offline demo.`,
      });
    }

    if (!this.session || !this.host || this.host.workspaceRoot !== root) {
      this.host = new VsCodeHost({ root, log: this.log, approvals: this.approvals });
      this.session = new HarnessSession({ host: this.host, config, provider });
      this.log.info(`session created for ${root} using ${provider.label}`);
    } else {
      this.session.updateConfig(config);
      this.session.setProvider(provider);
    }

    this.state = {
      ...this.state,
      provider: config.provider,
      model: config.model,
      workspace: root,
      editPolicy: config.editPolicy,
      commandPolicy: config.commandPolicy,
      maxSteps: config.maxSteps,
      keyPresent: Boolean(apiKey),
      toolCount: this.session.toolNames.length,
      stream: config.stream,
    };
    return this.session;
  }

  /** Re-read settings (called on configuration change). */
  async refreshState(): Promise<void> {
    try {
      const config = this.readConfig();
      const apiKey = await this.resolveApiKey(config);
      this.state = {
        ...this.state,
        provider: config.provider,
        model: config.model,
        workspace: this.workspaceRoot(),
        editPolicy: config.editPolicy,
        commandPolicy: config.commandPolicy,
        maxSteps: config.maxSteps,
        keyPresent: Boolean(apiKey),
        stream: config.stream,
      };
      if (this.session) {
        this.session.updateConfig(config);
        this.session.setProvider(createProvider({ config, apiKey }));
      }
    } catch (err) {
      this.log.warn(`refreshState failed: ${(err as Error).message}`);
    }
    this.post({ type: 'state', state: this.state });
  }

  /* --------------------------------------------------------------- tasks */

  async run(prompt: string): Promise<void> {
    const text = prompt.trim();
    if (!text) return;
    if (this.state.busy) {
      void vscode.window.showWarningMessage('Coding Harness is already running a task. Stop it first.');
      return;
    }

    let session: HarnessSession;
    try {
      session = await this.ensureSession();
    } catch (err) {
      void vscode.window.showErrorMessage((err as Error).message);
      return;
    }

    const item = { id: this.id(), kind: 'user', text } as TranscriptItem;
    this.items.push(item);
    this.post({ type: 'item', item });
    const now = Date.now();
    this.activity = { ...this.activity, taskStartedAt: now, startedAt: now, step: 0, tool: null, detail: null };
    this.setStatus('thinking', true);
    this.log.info(`task: ${text.slice(0, 200)}`);

    try {
      const result = await session.runTask(text, (event) => this.handleEvent(event));
      this.log.info(`task finished: ${result.outcome} in ${result.steps} step(s), ${result.toolCalls} tool call(s)`);
    } catch (err) {
      const message = (err as Error).message;
      this.pushNotice('error', message);
      this.log.error(`task crashed: ${message}`);
    } finally {
      this.flushAllStreams();
      this.setStatus('idle', false);
      this.approvals.cancelAll();
      this.trimItems();
    }
  }

  cancel(): void {
    if (!this.session?.isRunning) return;
    this.session.cancel();
    this.pushNotice('info', 'Cancelling the current task\u2026');
  }

  reset(): void {
    if (this.session?.isRunning) this.session.cancel();
    this.session?.reset();
    this.items = [];
    this.post({ type: 'reset' });
    this.log.info('conversation reset');
  }

  /** Undo every file change made during the last task. */
  async revertLastTask(): Promise<void> {
    if (!this.session) {
      void vscode.window.showInformationMessage('Nothing to revert yet.');
      return;
    }
    const report = await this.session.revertLastTask();
    const parts: string[] = [];
    if (report.restored.length) parts.push(`restored ${report.restored.length} file(s)`);
    if (report.deleted.length) parts.push(`removed ${report.deleted.length} new file(s)`);
    if (report.failed.length) parts.push(`${report.failed.length} failed`);
    const summary = parts.length ? parts.join(', ') : 'no files had been changed';

    const detail = [...report.restored, ...report.deleted.map((p) => `${p} (deleted)`)]
      .slice(0, 20)
      .join('\n');
    this.log.info(`revert: ${summary}`);
    this.pushNotice(report.failed.length ? 'warn' : 'info', `Reverted the last task: ${summary}.\n${detail}`);

    if (report.failed.length) {
      void vscode.window.showErrorMessage(`Revert finished with errors: ${report.failed.map((f) => f.path).join(', ')}`);
    }
  }

  async openApprovalDiff(approvalId: string): Promise<void> {
    const item = this.items.find((i): i is Extract<TranscriptItem, { kind: 'approval' }> => i.kind === 'approval' && i.approvalId === approvalId);
    if (!item) return;
    if (item.request.kind !== 'write') {
      void vscode.window.showInformationMessage(item.request.detail, { modal: false });
      return;
    }
    try {
      await showProposalDiff(this.proposals, item.request);
    } catch (err) {
      this.log.warn(`diff preview failed: ${(err as Error).message}`);
    }
  }

  async openFile(relPath: string): Promise<void> {
    const root = this.workspaceRoot();
    if (!root) return;
    const abs = path.join(root, relPath);
    void vscode.window.showTextDocument(vscode.Uri.file(abs), { preview: false, preserveFocus: false });
  }

  /** Called by the webview when the user answers an approval card. */
  respondToApproval(id: string, decision: 'apply' | 'reject', remember?: 'kind' | 'all'): void {
    if (decision === 'apply' && remember) {
      const item = this.items.find(
        (i): i is Extract<TranscriptItem, { kind: 'approval' }> => i.kind === 'approval' && i.approvalId === id,
      );
      this.approvals.rememberAlways(remember === 'all' ? 'all' : (item?.request.kind ?? 'all'));
    }
    this.approvals.resolve(id, decision);
    this.patchApproval(id, decision);
  }

  /* -------------------------------------------------------------- events */

  private handleEvent(event: HarnessEvent): void {
    switch (event.type) {
      case 'status':
        this.setStatus(event.status, this.state.busy);
        break;
      case 'step':
        this.state = { ...this.state, step: event.index };
        this.activity = { ...this.activity, status: 'thinking', step: event.index, maxSteps: event.maxSteps, tool: null, detail: null, startedAt: Date.now() };
        this.post({ type: 'status', status: this.state.status, step: event.index, maxSteps: event.maxSteps });
        this.postActivity();
        break;
      case 'assistant-delta':
        this.appendDelta(event.id, event.text);
        break;
      case 'assistant':
        this.finishAssistant(event.id, event.text, event.final);
        break;
      case 'tool-start':
        this.activity = {
          ...this.activity,
          status: 'executing',
          tool: event.name,
          detail: describeToolCall(event.name, event.args),
          startedAt: Date.now(),
        };
        this.postActivity();
        this.push({
          id: this.id(),
          kind: 'tool',
          toolCallId: event.id,
          name: event.name,
          args: event.args,
          status: 'running',
          startedAt: Date.now(),
        });
        break;
      case 'tool-end': {
        this.activity = {
          ...this.activity,
          status: 'thinking',
          tool: null,
          detail: null,
          startedAt: Date.now(),
        };
        this.postActivity();
        const existing = this.items.find(
          (i): i is Extract<TranscriptItem, { kind: 'tool' }> => i.kind === 'tool' && i.toolCallId === event.id,
        );
        if (existing) {
          existing.status = event.ok ? 'ok' : 'failed';
          existing.summary = event.summary;
          existing.detail = event.detail;
          existing.durationMs = event.durationMs;
          existing.relPath = event.relPath;
          this.post({ type: 'update', item: existing });
        } else {
          this.push({
            id: this.id(),
            kind: 'tool',
            toolCallId: event.id,
            name: event.name,
            args: '',
            status: event.ok ? 'ok' : 'failed',
            startedAt: Date.now() - event.durationMs,
            summary: event.summary,
            detail: event.detail,
            durationMs: event.durationMs,
            relPath: event.relPath,
          });
        }
        break;
      }
      case 'approval': {
        if (event.phase === 'request') {
          this.push({
            id: this.id(),
            kind: 'approval',
            approvalId: event.id,
            request: event.request,
          });
        } else {
          this.patchApproval(event.id, event.decision);
        }
        break;
      }
      case 'notice':
        this.pushNotice(event.level, event.message);
        break;
      case 'usage':
        this.post({ type: 'usage', usage: event.usage, step: event.step });
        break;
      case 'done':
        this.push({
          id: this.id(),
          kind: 'done',
          reason: event.reason,
          summary: event.summary,
          filesChanged: event.filesChanged,
        });
        this.setStatus('idle', false);
        break;
      default:
        break;
    }
  }

  private patchApproval(approvalId: string, decision: 'apply' | 'reject'): void {
    const item = this.items.find(
      (i): i is Extract<TranscriptItem, { kind: 'approval' }> => i.kind === 'approval' && i.approvalId === approvalId,
    );
    if (!item || item.decision) return;
    item.decision = decision;
    this.post({ type: 'update', item });
  }

  /** Append a streamed fragment; creates the bubble on the first fragment. */
  private appendDelta(id: string, text: string): void {
    let item = this.items.find(
      (i): i is Extract<TranscriptItem, { kind: 'assistant' }> => i.kind === 'assistant' && i.id === id,
    );
    if (!item) {
      item = { id, kind: 'assistant', text: '', final: false, streaming: true };
      this.items.push(item);
      this.post({ type: 'item', item: { ...item } });
    }
    item.text += text;

    // Repaint at most ~16 times a second so the webview stays responsive.
    const entry = this.streams.get(id) ?? {};
    if (!entry.timer) {
      entry.timer = setTimeout(() => {
        entry.timer = undefined;
        this.post({ type: 'update', item: { ...item! } });
      }, 60);
      this.streams.set(id, entry);
    }
  }

  /** Finalise a model turn: reconcile with the authoritative full text. */
  private finishAssistant(id: string, text: string, final: boolean): void {
    const entry = this.streams.get(id);
    if (entry?.timer) clearTimeout(entry.timer);
    this.streams.delete(id);

    const item = this.items.find(
      (i): i is Extract<TranscriptItem, { kind: 'assistant' }> => i.kind === 'assistant' && i.id === id,
    );

    if (!item) {
      if (!text) return;
      this.push({ id: id || this.id(), kind: 'assistant', text, final });
      return;
    }
    item.text = text || item.text;
    item.final = final;
    item.streaming = false;
    this.post({ type: 'update', item: { ...item } });
  }

  private flushAllStreams(): void {
    for (const [id, entry] of this.streams) {
      if (entry.timer) clearTimeout(entry.timer);
      const item = this.items.find(
        (i): i is Extract<TranscriptItem, { kind: 'assistant' }> => i.kind === 'assistant' && i.id === id,
      );
      if (item) {
        item.streaming = false;
        this.post({ type: 'update', item: { ...item } });
      }
    }
    this.streams.clear();
  }

  private postActivity(): void {
    this.post({ type: 'activity', activity: this.activity });
  }

  private push(item: TranscriptItem): void {
    this.items.push(item);
    // Post a snapshot: tool/approval items are mutated in place later (running
    // -> ok, pending -> resolved) and the panel must be told about that with an
    // explicit `update` rather than by inspecting a mutated object.
    this.post({ type: 'item', item: { ...item } });
    this.trimItems();
  }

  private pushNotice(level: 'info' | 'warn' | 'error', message: string): void {
    this.push({ id: this.id(), kind: 'notice', level, message });
  }

  private setStatus(status: UiState['status'], busy: boolean): void {
    this.state = { ...this.state, status, busy };
    // Leaving the working state must also retire the live activity strip,
    // otherwise it sits there ticking after the task has finished.
    if (status === 'idle') {
      this.activity = { ...this.activity, status: 'idle', tool: null, detail: null, startedAt: 0 };
      this.postActivity();
    }
    this.post({ type: 'state', state: this.state });
  }

  private trimItems(): void {
    if (this.items.length <= MAX_ITEMS) return;
    this.items = this.items.slice(this.items.length - MAX_ITEMS);
  }

  private id(): string {
    return `item-${++this.counter}`;
  }
}

/** Short "what is it touching" hint for the activity strip. */
function describeToolCall(name: string, rawArgs: string): string | null {
  try {
    const args = JSON.parse(rawArgs || '{}') as Record<string, unknown>;
    const pick = args.path ?? args.command ?? args.query ?? args.file;
    if (typeof pick !== 'string' || !pick) return null;
    const oneLine = pick.replace(/\s+/g, ' ').trim();
    const value = oneLine.length > 70 ? `${oneLine.slice(0, 67)}\u2026` : oneLine;
    return name === 'run_command' ? `$ ${value}` : value;
  } catch {
    return null;
  }
}
