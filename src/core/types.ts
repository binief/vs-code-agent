/**
 * Shared types for the harness core.
 *
 * Everything in `src/core` is plain Node.js: no `vscode` import anywhere, so the
 * whole agent loop can be unit-tested (and driven from a terminal) without the
 * editor. The VS Code layer supplies a {@link HarnessHost} implementation.
 */

export type JsonSchema = {
  type?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  default?: unknown;
  additionalProperties?: boolean | JsonSchema;
};

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  /** Provider-assigned id, echoed back with the tool result. */
  id: string;
  name: string;
  /** Raw JSON string, exactly as produced by the model. */
  arguments: string;
}

export interface ChatMessage {
  role: Role;
  content: string;
  /** assistant only */
  toolCalls?: ToolCall[];
  /** tool only */
  toolCallId?: string;
  name?: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface ProviderResponse {
  text: string;
  toolCalls: ToolCall[];
  usage?: Usage;
  finishReason?: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
  signal?: AbortSignal;
  temperature?: number;
  maxTokens?: number;
  /**
   * Called with each streamed text fragment as it arrives. Providers stream
   * when this is supplied (and fall back to a single response otherwise), so
   * the UI can render the model's reasoning while it is still being produced.
   */
  onDelta?: (text: string) => void;
}

/** A model backend: OpenAI-compatible, Anthropic, or the offline mock planner. */
export interface Provider {
  id: string;
  label: string;
  chat(req: ChatRequest): Promise<ProviderResponse>;
}

/* ------------------------------------------------------------------ host */

export type ApprovalDecision = 'apply' | 'reject';

export interface ApprovalRequest {
  kind: 'write' | 'delete' | 'command';
  /** Short headline, e.g. `Write src/app.py`. */
  title: string;
  /** Body text: unified-ish diff for writes, the raw command line for commands. */
  detail: string;
  /** Workspace-relative path, when the action touches a file. */
  relPath?: string;
  /** Absolute path, when the action touches a file. */
  absPath?: string;
  newContent?: string;
  oldContent?: string;
  command?: string;
}

export interface Diagnostic {
  file: string;
  severity: 'error' | 'warning' | 'info' | 'hint';
  line: number;
  message: string;
  source?: string;
}

/**
 * The editor surface the core needs. Only `workspaceRoot`, `log` and
 * `requestApproval` are required; the rest degrade gracefully.
 */
export interface HarnessHost {
  workspaceRoot: string;
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void;
  requestApproval(req: ApprovalRequest): Promise<ApprovalDecision>;
  /** Preferred file-writing path (e.g. a VS Code WorkspaceEdit so undo works). */
  applyFileWrite?(absPath: string, content: string): Promise<void>;
  getDiagnostics?(relPath?: string): Promise<Diagnostic[]>;
  openFile?(absPath: string, line?: number): Promise<void>;
  notify?(message: string, kind?: 'info' | 'warn' | 'error'): void;
}

/* --------------------------------------------------------------- config */

export type ProviderId = 'openai' | 'anthropic' | 'mock';
export type EditPolicy = 'ask' | 'auto';
export type CommandPolicy = 'auto-safe' | 'ask' | 'auto-all' | 'deny-all';

export interface HarnessConfig {
  provider: ProviderId;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  maxSteps: number;
  temperature: number;
  maxOutputTokens: number;
  editPolicy: EditPolicy;
  commandPolicy: CommandPolicy;
  allowDangerousCommands: boolean;
  commandTimeoutMs: number;
  allowOutsideWorkspace: boolean;
  maxFileBytes: number;
  includeDiagnosticsInPrompt: boolean;
  systemPromptExtra?: string;
  /** Stream model output token by token into the panel. */
  stream: boolean;
}

export const DEFAULT_CONFIG: HarnessConfig = {
  provider: 'openai',
  model: 'gpt-4o-mini',
  baseUrl: 'https://api.openai.com/v1',
  maxSteps: 12,
  temperature: 0.2,
  maxOutputTokens: 2048,
  editPolicy: 'ask',
  commandPolicy: 'auto-safe',
  allowDangerousCommands: false,
  commandTimeoutMs: 60_000,
  allowOutsideWorkspace: false,
  maxFileBytes: 256 * 1024,
  includeDiagnosticsInPrompt: true,
  stream: true,
};

export function resolveConfig(partial: Partial<HarnessConfig> | undefined): HarnessConfig {
  return { ...DEFAULT_CONFIG, ...(partial ?? {}) };
}

/* --------------------------------------------------------------- events */

export type HarnessEvent =
  | { type: 'status'; status: 'idle' | 'thinking' | 'executing' | 'approval' }
  | { type: 'step'; index: number; maxSteps: number }
  | { type: 'assistant-delta'; id: string; text: string }
  | { type: 'assistant'; id: string; text: string; final: boolean; streamed: boolean }
  | { type: 'tool-start'; id: string; name: string; args: string }
  | {
      type: 'tool-end';
      id: string;
      name: string;
      ok: boolean;
      summary: string;
      detail: string;
      durationMs: number;
      relPath?: string;
    }
  | { type: 'approval'; id: string; phase: 'request'; request: ApprovalRequest }
  | { type: 'approval'; id: string; phase: 'resolved'; request: ApprovalRequest; decision: ApprovalDecision }
  | { type: 'usage'; step: number; usage: Usage }
  | { type: 'notice'; message: string; level: 'info' | 'warn' | 'error' }
  | { type: 'done'; reason: TaskOutcome; summary: string; filesChanged: string[] };

export type TaskOutcome = 'complete' | 'max-steps' | 'cancelled' | 'error';

export interface TaskResult {
  outcome: TaskOutcome;
  summary: string;
  steps: number;
  toolCalls: number;
  filesChanged: string[];
  usage: Usage;
}

/* ---------------------------------------------------------------- tools */

export interface ToolResult {
  ok: boolean;
  /** Text handed back to the model (and shown, collapsed, in the UI). */
  content: string;
  /** One-line summary for the UI. */
  summary?: string;
  /** Extra structured info (paths touched, exit codes, \u2026). */
  meta?: Record<string, unknown>;
}

export interface ToolContext {
  root: string;
  host: HarnessHost;
  config: HarnessConfig;
  checkpoints: import('./checkpoints').CheckpointStore;
  signal?: AbortSignal;
  /**
   * Ask the user to authorise the action a tool is *about* to perform.
   * Supplied by the agent loop, which also emits the matching UI events.
   * Calling it twice for one action would prompt twice \u2014 call it once, only
   * when the configured policy actually requires confirmation.
   */
  approval(req: ApprovalRequest): Promise<ApprovalDecision>;
}

export interface Tool<A = any> {
  name: string;
  description: string;
  parameters: JsonSchema;
  run(args: A, ctx: ToolContext): Promise<ToolResult>;
}

/** Convenience helpers used by every tool implementation. */
export function ok(content: string, summary?: string, meta?: Record<string, unknown>): ToolResult {
  return { ok: true, content, summary, meta };
}

export function fail(content: string, summary?: string, meta?: Record<string, unknown>): ToolResult {
  return { ok: false, content, summary, meta };
}
