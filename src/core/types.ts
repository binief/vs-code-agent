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
  /** Cached tokens when provider reports them (e.g. Anthropic) */
  cachedTokens?: number;
  /** Estimated tokens per second for this step */
  tokensPerSecond?: number;
  /** Duration of the model call in ms */
  durationMs?: number;
}

export interface ProviderResponse {
  text: string;
  toolCalls: ToolCall[];
  usage?: Usage;
  finishReason?: string;
  /** Reasoning/thinking text, when the backend returned any. */
  thinking?: string;
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
   * the UI can render output while it is still being produced.
   */
  onDelta?: (text: string) => void;
  /**
   * Called with each fragment of the model's *reasoning* stream, when the
   * backend exposes one: DeepSeek `reasoning_content`, OpenRouter `reasoning`,
   * OpenAI-compatible reasoning models, or Anthropic extended thinking.
   * Kept separate from `onDelta` because it is shown in its own lane and is
   * never fed back to the model as conversation content.
   */
  onThinking?: (text: string) => void;
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
export type LineEndingPreference = 'auto' | 'lf' | 'crlf' | 'cr' | 'native';

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  disabled?: boolean;
  /** Optional timeout override for this server */
  timeoutMs?: number;
}

export interface McpConfig {
  enabled: boolean;
  servers: Record<string, McpServerConfig>;
  timeoutMs: number;
}

export interface CompactionConfig {
  enabled: boolean;
  autoCompact: boolean;
  threshold: number; // 0-1, e.g. 0.75 means compact when 75% of context window used
  contextWindowTokens: number;
  keepLastMessages: number;
  summaryModel?: string; // optional model to use for summarization, defaults to main model
}

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
  /** Newline style for files written by the agent; auto preserves existing files. */
  lineEndings: LineEndingPreference;
  includeDiagnosticsInPrompt: boolean;
  systemPromptExtra?: string;
  /** Stream model output token by token into the panel. */
  stream: boolean;
  /** Show the model's reasoning stream, when the backend provides one. */
  showThinking: boolean;
  /** MCP servers configuration */
  mcp: McpConfig;
  /** Conversation compaction configuration */
  compaction: CompactionConfig;
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
  lineEndings: 'auto',
  includeDiagnosticsInPrompt: true,
  stream: true,
  showThinking: true,
  mcp: {
    enabled: false,
    servers: {},
    timeoutMs: 10_000,
  },
  compaction: {
    enabled: true,
    autoCompact: true,
    threshold: 0.75,
    contextWindowTokens: 128_000,
    keepLastMessages: 10,
  },
};

export function resolveConfig(partial: Partial<HarnessConfig> | undefined): HarnessConfig {
  const merged: HarnessConfig = {
    ...DEFAULT_CONFIG,
    mcp: { ...DEFAULT_CONFIG.mcp, ...(partial?.mcp ?? {}) },
    compaction: { ...DEFAULT_CONFIG.compaction, ...(partial?.compaction ?? {}) },
  };
  for (const [key, value] of Object.entries(partial ?? {})) {
    if (key === 'mcp' || key === 'compaction') continue;
    // Values explicitly set to undefined must not clobber a default: a settings
    // lookup that returns nothing would otherwise disable that feature.
    if (value !== undefined) (merged as unknown as Record<string, unknown>)[key] = value;
  }
  // Deep merge for nested configs that might be partial
  if (partial?.mcp) {
    merged.mcp = {
      enabled: partial.mcp.enabled ?? DEFAULT_CONFIG.mcp.enabled,
      servers: partial.mcp.servers ?? DEFAULT_CONFIG.mcp.servers,
      timeoutMs: partial.mcp.timeoutMs ?? DEFAULT_CONFIG.mcp.timeoutMs,
    };
  }
  if (partial?.compaction) {
    merged.compaction = {
      enabled: partial.compaction.enabled ?? DEFAULT_CONFIG.compaction.enabled,
      autoCompact: partial.compaction.autoCompact ?? DEFAULT_CONFIG.compaction.autoCompact,
      threshold: partial.compaction.threshold ?? DEFAULT_CONFIG.compaction.threshold,
      contextWindowTokens: partial.compaction.contextWindowTokens ?? DEFAULT_CONFIG.compaction.contextWindowTokens,
      keepLastMessages: partial.compaction.keepLastMessages ?? DEFAULT_CONFIG.compaction.keepLastMessages,
      summaryModel: partial.compaction.summaryModel ?? DEFAULT_CONFIG.compaction.summaryModel,
    };
  }
  return merged;
}

/* --------------------------------------------------------------- events */

export type HarnessEvent =
  | { type: 'status'; status: 'idle' | 'thinking' | 'executing' | 'approval' }
  | { type: 'step'; index: number; maxSteps: number }
  | { type: 'assistant-delta'; id: string; text: string }
  | { type: 'assistant'; id: string; text: string; final: boolean; streamed: boolean }
  | { type: 'thinking-delta'; id: string; text: string }
  | { type: 'thinking'; id: string; text: string; durationMs: number }
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
  | { type: 'usage'; step: number; usage: Usage; durationMs?: number; tokensPerSecond?: number; contextTokens?: number; contextWindow?: number; contextPercent?: number; cumulative?: Usage }
  | { type: 'context'; contextTokens: number; contextWindow: number; contextPercent: number }
  | { type: 'mcp-status'; enabled: boolean; servers: number; tools: number }
  | { type: 'notice'; message: string; level: 'info' | 'warn' | 'error' }
  | { type: 'done'; reason: TaskOutcome; summary: string; filesChanged: string[]; usage?: Usage; tokensPerSecond?: number };

export type TaskOutcome = 'complete' | 'max-steps' | 'cancelled' | 'error';

export interface TaskResult {
  outcome: TaskOutcome;
  summary: string;
  steps: number;
  toolCalls: number;
  filesChanged: string[];
  usage: Usage;
  tokensPerSecond?: number;
  contextTokens?: number;
}

/* ---------------------------------------------------------------- tools */

export interface ToolResult {
  ok: boolean;
  /** Text handed back to the model (and shown, collapsed, in the UI). */
  content: string;
  /** One-line summary for the UI. */
  summary?: string;
  /** Extra structured info (paths touched, exit codes, …). */
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
   * Calling it twice for one action would prompt twice — call it once, only
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
