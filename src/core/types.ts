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

/**
 * An image the user attached to a message (pasted or dropped into the panel).
 * Stored as base64 because that is what both the OpenAI and Anthropic wire
 * formats want, and what a webview can hand over without touching disk.
 */
export interface ImageAttachment {
  /** MIME type, e.g. `image/png`. */
  mediaType: string;
  /** Base64 payload, without the `data:` prefix. */
  data: string;
  /** Optional display name (file name, or "pasted image"). */
  name?: string;
  /** Decoded size in bytes, when known. */
  bytes?: number;
}

export interface ChatMessage {
  role: Role;
  content: string;
  /** user only: images attached to the message, for vision-capable models. */
  images?: ImageAttachment[];
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
 * A file that is open in the editor, as the core sees it through the host.
 * `path` is workspace-relative when the file lives inside the workspace.
 */
export interface OpenFileContext {
  path: string;
  languageId?: string;
  dirty?: boolean;
  lineCount?: number;
  /** 1-based inclusive range, present when the user has a selection. */
  selection?: { startLine: number; endLine: number };
  /** True for the editor the user is currently focused on. */
  active?: boolean;
}

/**
 * Environment/workspace facts the editor can see but a plain Node process
 * cannot. Everything here is rendered as context, never as instructions.
 */
export interface WorkspaceContext {
  /** e.g. `Visual Studio Code 1.95.2`. */
  editor?: { name: string; version: string };
  /** Every folder of the workspace (the first one is the sandbox root). */
  folders?: string[];
  activeFile?: OpenFileContext;
  openFiles?: OpenFileContext[];
  /** Extra factual notes supplied by the host, e.g. workspace trust state. */
  environment?: Record<string, string>;
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
  /** Editor/workspace facts used to build the context section of the prompt. */
  getWorkspaceContext?(): WorkspaceContext | Promise<WorkspaceContext>;
}

/* --------------------------------------------------------------- config */

export type ProviderId = 'openai' | 'anthropic' | 'mock';
export type EditPolicy = 'ask' | 'auto';
export type CommandPolicy = 'auto-safe' | 'ask' | 'auto-all' | 'deny-all';
export type LineEndingPreference = 'auto' | 'lf' | 'crlf' | 'cr' | 'native';

/** Transport used to reach an MCP server. Inferred from `url`/`command` when omitted. */
export type McpTransportType = 'stdio' | 'http' | 'sse';

export interface McpServerConfig {
  /**
   * Explicit transport override: `stdio` spawns `command`, `http` talks
   * Streamable HTTP to `url` (with automatic fallback to the legacy SSE
   * transport), `sse` forces the legacy HTTP+SSE transport. When omitted the
   * transport is inferred: a `url` means HTTP, a `command` means stdio.
   */
  type?: McpTransportType;
  /** stdio: executable to spawn as a child process. */
  command?: string;
  /** stdio: process arguments. */
  args?: string[];
  /** stdio: extra environment variables. */
  env?: Record<string, string>;
  /** stdio: working directory (resolved against the workspace root). */
  cwd?: string;
  /** http / sse: server endpoint URL (http:// or https://). */
  url?: string;
  /** http / sse: extra request headers, e.g. `{ Authorization: 'Bearer …' }`. */
  headers?: Record<string, string>;
  disabled?: boolean;
  /** Optional timeout override for this server */
  timeoutMs?: number;
}

export interface McpConfig {
  enabled: boolean;
  servers: Record<string, McpServerConfig>;
  timeoutMs: number;
  /** Also read server definitions from workspace config files (`.vscode/mcp.json`, `.mcp.json`, …). */
  loadFromFiles: boolean;
  /** Config files to read, relative to the workspace root or absolute. */
  configFiles: string[];
}

export interface AgentFilesConfig {
  /** Master switch for loading instructions. When off, the prompt contains context only. */
  enabled: boolean;
  /** Exact filenames searched in the workspace root and its subdirectories (case-insensitive). */
  names: string[];
  /** Glob patterns matched against the workspace-relative path, so `code-review.md`, `test.md`, … load too. */
  patterns: string[];
  /** Also read a user-level agent file that applies to every workspace. */
  includeUser: boolean;
  /** User-level agent file. `~` is expanded; a relative path is resolved against the home directory. */
  userPath: string;
  /** Scan every subdirectory up to `maxDepth`. When off, only the root, its config directories and the ancestors of open editors are loaded. */
  scanNested: boolean;
  /** How many directory levels below the workspace root are scanned when `scanNested` is on. */
  maxDepth: number;
  /** Per-file cap; larger files are truncated. */
  maxBytes: number;
  /** Total budget for all instructions in one prompt. Files that do not fit are skipped. */
  maxTotalBytes: number;
  /** Extra files to load (workspace-relative or absolute paths). */
  extraPaths: string[];
}

/** Which context sections are appended to the system message. */
export interface ContextConfig {
  /** OS, shell, runtime, editor version, time, git state. */
  environment: boolean;
  /** Workspace layout and manifest summaries. */
  workspace: boolean;
  /** Open editors, active file and selection. */
  files: boolean;
  /** Current language-server problems. */
  diagnostics: boolean;
  /** The catalogue of available tool names and descriptions. */
  tools: boolean;
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
  /**
   * Hard ceiling on model turns for one task. It is a safety net, not a
   * schedule: raise it for long multi-step work, because reaching it forces the
   * final turn to summarise and ends the run wherever the task got to.
   */
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
  /** Stream model output token by token into the panel. */
  stream: boolean;
  /** Show the model's reasoning stream, when the backend provides one. */
  showThinking: boolean;
  /** Instructions loaded from agent.md/AGENTS.md files. There is no built-in prompt. */
  agentFiles: AgentFilesConfig;
  /** Which factual context is included in the system message. */
  context: ContextConfig;
  /** MCP servers configuration (settings + workspace config files) */
  mcp: McpConfig;
  /** Conversation compaction configuration */
  compaction: CompactionConfig;
}

export const DEFAULT_CONFIG: HarnessConfig = {
  provider: 'openai',
  model: 'gpt-4o-mini',
  baseUrl: 'https://api.openai.com/v1',
  maxSteps: 40,
  temperature: 0.2,
  maxOutputTokens: 2048,
  editPolicy: 'ask',
  commandPolicy: 'auto-safe',
  allowDangerousCommands: false,
  commandTimeoutMs: 60_000,
  allowOutsideWorkspace: false,
  maxFileBytes: 256 * 1024,
  lineEndings: 'auto',
  stream: true,
  showThinking: true,
  agentFiles: {
    enabled: true,
    names: ['AGENTS.md', 'agent.md', 'agents.md', 'copilot-instructions.md'],
    patterns: ['*.instructions.md'],
    includeUser: false,
    userPath: '~/.coding-harness/agent.md',
    scanNested: false,
    maxDepth: 2,
    maxBytes: 64 * 1024,
    maxTotalBytes: 128 * 1024,
    extraPaths: [],
  },
  context: {
    environment: true,
    workspace: true,
    files: true,
    diagnostics: true,
    tools: true,
  },
  mcp: {
    enabled: true,
    servers: {},
    timeoutMs: 10_000,
    loadFromFiles: true,
    configFiles: ['.vscode/mcp.json', '.mcp.json', 'mcp.json'],
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
    agentFiles: { ...DEFAULT_CONFIG.agentFiles, ...(partial?.agentFiles ?? {}) },
    context: { ...DEFAULT_CONFIG.context, ...(partial?.context ?? {}) },
    mcp: { ...DEFAULT_CONFIG.mcp, ...(partial?.mcp ?? {}) },
    compaction: { ...DEFAULT_CONFIG.compaction, ...(partial?.compaction ?? {}) },
  };
  for (const [key, value] of Object.entries(partial ?? {})) {
    if (key === 'mcp' || key === 'compaction' || key === 'agentFiles' || key === 'context') continue;
    // Values explicitly set to undefined must not clobber a default: a settings
    // lookup that returns nothing would otherwise disable that feature.
    if (value !== undefined) (merged as unknown as Record<string, unknown>)[key] = value;
  }
  // Nested configs are resolved field by field so a partial object from the
  // host cannot silently drop a default.
  if (partial?.agentFiles) {
    merged.agentFiles = {
      enabled: partial.agentFiles.enabled ?? DEFAULT_CONFIG.agentFiles.enabled,
      names: partial.agentFiles.names ?? DEFAULT_CONFIG.agentFiles.names,
      patterns: partial.agentFiles.patterns ?? DEFAULT_CONFIG.agentFiles.patterns,
      includeUser: partial.agentFiles.includeUser ?? DEFAULT_CONFIG.agentFiles.includeUser,
      userPath: partial.agentFiles.userPath ?? DEFAULT_CONFIG.agentFiles.userPath,
      scanNested: partial.agentFiles.scanNested ?? DEFAULT_CONFIG.agentFiles.scanNested,
      maxDepth: partial.agentFiles.maxDepth ?? DEFAULT_CONFIG.agentFiles.maxDepth,
      maxBytes: partial.agentFiles.maxBytes ?? DEFAULT_CONFIG.agentFiles.maxBytes,
      maxTotalBytes: partial.agentFiles.maxTotalBytes ?? DEFAULT_CONFIG.agentFiles.maxTotalBytes,
      extraPaths: partial.agentFiles.extraPaths ?? DEFAULT_CONFIG.agentFiles.extraPaths,
    };
  }
  if (partial?.context) {
    merged.context = {
      environment: partial.context.environment ?? DEFAULT_CONFIG.context.environment,
      workspace: partial.context.workspace ?? DEFAULT_CONFIG.context.workspace,
      files: partial.context.files ?? DEFAULT_CONFIG.context.files,
      diagnostics: partial.context.diagnostics ?? DEFAULT_CONFIG.context.diagnostics,
      tools: partial.context.tools ?? DEFAULT_CONFIG.context.tools,
    };
  }
  if (partial?.mcp) {
    merged.mcp = {
      enabled: partial.mcp.enabled ?? DEFAULT_CONFIG.mcp.enabled,
      servers: partial.mcp.servers ?? DEFAULT_CONFIG.mcp.servers,
      timeoutMs: partial.mcp.timeoutMs ?? DEFAULT_CONFIG.mcp.timeoutMs,
      loadFromFiles: partial.mcp.loadFromFiles ?? DEFAULT_CONFIG.mcp.loadFromFiles,
      configFiles: partial.mcp.configFiles ?? DEFAULT_CONFIG.mcp.configFiles,
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

/** One instruction file that was loaded for a task, for display in the UI. */
export interface AgentInstructionFile {
  /** Path as shown to the user (workspace-relative, `~/…`, or absolute). */
  displayPath: string;
  absolutePath: string;
  /** Workspace-relative directory the file governs; empty for the root. */
  scope: string;
  origin: 'user' | 'workspace';
  bytes: number;
  truncated: boolean;
}

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
  | {
      type: 'agent-files';
      enabled: boolean;
      files: AgentInstructionFile[];
      totalBytes: number;
      skipped: number;
    }
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
