import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { HarnessSession } from '../core/agent';
import { agentFilesSummary, discoverAgentFiles, selectAgentFiles, type AgentFilesResult } from '../core/agentFiles';
import { buildSystemPrompt, summarizeDiagnostics } from '../core/prompt';
import { apiKeyFromEnv, createProvider } from '../core/providers';
import { createDefaultTools, ToolRegistry } from '../core/tools';
import { McpManager, sanitizeMcpServers } from '../core/tools/mcp';
import {
  loadMcpConfigFiles,
  mergeMcpServers,
  type McpConfigError,
  type McpConfigSource,
  type McpFileConfig,
  type McpInputSpec,
} from '../core/tools/mcpConfig';
import { normalizeImages, toDataUrl, type RawImageInput } from '../core/images';
import {
  DEFAULT_CONFIG,
  resolveConfig,
  type ApprovalRequest,
  type AgentInstructionFile,
  type ImageAttachment,
  type HarnessConfig,
  type McpServerConfig,
  type HarnessEvent,
  type TaskOutcome,
  type Usage,
  type WorkspaceContext,
} from '../core/types';
import type { ApprovalService } from './host';
import { VsCodeHost } from './host';
import type { Logger } from './log';
import type { ProposalStore } from './proposals';
import { showProposalDiff } from './proposals';

/** An attachment as the webview renders it: data URL plus a label. */
export interface TranscriptImage {
  name?: string;
  mediaType: string;
  dataUrl: string;
  bytes?: number;
}

export type TranscriptItem =
  | { id: string; kind: 'user'; text: string; images?: TranscriptImage[] }
  | { id: string; kind: 'assistant'; text: string; final: boolean; streaming?: boolean }
  | {
      id: string;
      kind: 'thinking';
      text: string;
      streaming: boolean;
      durationMs?: number;
      startedAt?: number;
    }
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
  | { id: string; kind: 'done'; reason: TaskOutcome; summary: string; filesChanged: string[]; usage?: Usage; tokensPerSecond?: number };

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
  /** Whether the model's reasoning stream is shown in its own lane. */
  showThinking: boolean;
  /** Token usage */
  usage?: Usage;
  cumulativeUsage?: Usage;
  tokensPerSecond?: number;
  contextTokens?: number;
  contextWindow?: number;
  contextPercent?: number;
  /** MCP */
  mcpEnabled?: boolean;
  mcpServers?: number;
  mcpToolCount?: number;
  mcpConfigured?: number;
  mcpSources?: McpConfigSource[];
  /** Agent instruction files active for the next task (after any pinned selection). */
  agentFiles?: AgentInstructionFile[];
  agentFilesEnabled?: boolean;
  /** Active file count (what the panel chip shows first). */
  agentFilesCount?: number;
  /** Files discovery found, before the pinned selection was applied. */
  agentFilesAvailable?: number;
  /** Pinned display paths, or absent when every discovered file is used. */
  agentSelection?: string[];
}

/** What the panel's agents dialog renders: every discovered file and the pin. */
export interface AgentSettingsSnapshot {
  enabled: boolean;
  /** Pinned display paths, or null when everything discovered is used. */
  selection: string[] | null;
  /** Discovered files, in prompt order. */
  files: Array<{
    displayPath: string;
    scope: string;
    origin: 'user' | 'workspace';
    bytes: number;
    truncated: boolean;
    /** True when this file is part of the current selection. */
    active: boolean;
  }>;
  /** Number of files discovered. */
  available: number;
  /** Set when nothing was found, so the dialog can offer to create a file. */
  root: string;
}

/** workspaceState key holding the pinned instruction files (per workspace). */
const AGENT_SELECTION_KEY = 'codingHarness.agentSelection';

/** Live status of one configured MCP server, shown in the settings dialog. */
export interface McpServerStatus {
  running: boolean;
  tools: number;
  error?: string;
}

/** What the panel's MCP dialog renders: settings as stored plus live status. */
export interface McpSettingsSnapshot {
  enabled: boolean;
  timeoutMs: number;
  /** Servers stored in `codingHarness.mcp.servers` (editable in the dialog). */
  servers: Record<string, McpServerConfig>;
  status: Record<string, McpServerStatus>;
  supportsWorkspace: boolean;
  /** Servers defined by config files; read-only in the dialog. */
  fileServers?: Record<string, McpServerConfig>;
  sources?: McpConfigSource[];
  errors?: McpConfigError[];
  loadFromFiles?: boolean;
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
  private mcpManager?: McpManager;
  /** Last loaded MCP config files (kept for the dialog and state). */
  private mcpFileConfig?: McpFileConfig;
  /** Signature of the servers the running manager was started with. */
  private mcpSignature?: string;
  private configuredMcpServers: Record<string, McpServerConfig> = {};
  /** Instruction files discovered for the most recent task/refresh. */
  private lastAgentFiles?: AgentFilesResult;
  /** Values already entered for `${input:…}` MCP placeholders (per session). */
  private readonly mcpInputCache = new Map<string, string>();
  private agentNoticeShown = false;
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
    maxSteps: DEFAULT_CONFIG.maxSteps,
    provider: 'openai',
    model: 'gpt-4o-mini',
    workspace: '',
    editPolicy: 'ask',
    commandPolicy: 'auto-safe',
    keyPresent: false,
    toolCount: 0,
    stream: true,
    showThinking: true,
    usage: { totalTokens: 0 },
    cumulativeUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    tokensPerSecond: 0,
    contextTokens: 0,
    contextWindow: 128000,
    contextPercent: 0,
    mcpEnabled: false,
    mcpServers: 0,
    mcpToolCount: 0,
    mcpConfigured: 0,
    mcpSources: [],
    agentFiles: [],
    agentFilesEnabled: true,
    agentFilesCount: 0,
    agentFilesAvailable: 0,
  };
  private cumulativeUsage: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  private lastTokensPerSecond = 0;
  /** Pinned instruction files; absent means "everything discovered". */
  private agentSelection?: string[];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: Logger,
    private readonly approvals: ApprovalService,
    private readonly proposals: ProposalStore,
  ) {
    // The pin is a workspace preference, so it survives a window reload but
    // does not leak into other repositories the way a global setting would.
    const stored = HarnessController.arrayOfStrings(this.context.workspaceState?.get(AGENT_SELECTION_KEY));
    if (stored && stored.length > 0) this.agentSelection = stored;
  }

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

  private static arrayOfStrings(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) return undefined;
    return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim());
  }

  readConfig(): HarnessConfig {
    const c = vscode.workspace.getConfiguration('codingHarness');
    const mcpConfig = c.get<Record<string, any>>('mcp.servers') ?? c.get('mcpServers') ?? {};
    const mcpEnabled = c.get<boolean>('mcp.enabled') ?? c.get('mcpEnabled') ?? DEFAULT_CONFIG.mcp.enabled;
    const mcpTimeout = c.get<number>('mcp.timeoutMs') ?? c.get('mcpTimeoutMs') ?? DEFAULT_CONFIG.mcp.timeoutMs;
    const mcpLoadFromFiles = c.get<boolean>('mcp.loadFromFiles') ?? DEFAULT_CONFIG.mcp.loadFromFiles;
    const mcpConfigFiles = HarnessController.arrayOfStrings(c.get('mcp.configFiles')) ?? DEFAULT_CONFIG.mcp.configFiles;

    // Agent instruction files: there is no built-in prompt, so this config is
    // the only source of behavioural instructions.
    const agentEnabled = c.get<boolean>('agentFiles.enabled') ?? DEFAULT_CONFIG.agentFiles.enabled;
    const agentNames = HarnessController.arrayOfStrings(c.get('agentFiles.names')) ?? DEFAULT_CONFIG.agentFiles.names;
    const agentPatterns = HarnessController.arrayOfStrings(c.get('agentFiles.patterns')) ?? DEFAULT_CONFIG.agentFiles.patterns;
    const agentIncludeUser = c.get<boolean>('agentFiles.includeUser') ?? DEFAULT_CONFIG.agentFiles.includeUser;
    const agentUserPath = c.get<string>('agentFiles.userPath') || DEFAULT_CONFIG.agentFiles.userPath;
    const agentScanNested = c.get<boolean>('agentFiles.scanNested') ?? DEFAULT_CONFIG.agentFiles.scanNested;
    const agentMaxDepth = c.get<number>('agentFiles.maxDepth') ?? DEFAULT_CONFIG.agentFiles.maxDepth;
    const agentMaxBytes = c.get<number>('agentFiles.maxBytes') ?? DEFAULT_CONFIG.agentFiles.maxBytes;
    const agentMaxTotal = c.get<number>('agentFiles.maxTotalBytes') ?? DEFAULT_CONFIG.agentFiles.maxTotalBytes;
    const agentExtraPaths = HarnessController.arrayOfStrings(c.get('agentFiles.extraPaths')) ?? DEFAULT_CONFIG.agentFiles.extraPaths;

    const contextEnvironment = c.get<boolean>('context.environment') ?? DEFAULT_CONFIG.context.environment;
    const contextWorkspace = c.get<boolean>('context.workspace') ?? DEFAULT_CONFIG.context.workspace;
    const contextFiles = c.get<boolean>('context.files') ?? DEFAULT_CONFIG.context.files;
    const contextDiagnostics = c.get<boolean>('context.diagnostics') ?? DEFAULT_CONFIG.context.diagnostics;
    const contextTools = c.get<boolean>('context.tools') ?? DEFAULT_CONFIG.context.tools;

    // Support both new and legacy compaction settings
    const compactionEnabled = c.get<boolean>('compaction.enabled') ?? c.get('autoCompact') ?? true;
    const autoCompact = c.get<boolean>('compaction.autoCompact') ?? c.get('autoCompact') ?? true;
    const threshold = c.get<number>('compaction.threshold') ?? c.get('compactThreshold') ?? 0.75;
    const contextWindow = c.get<number>('compaction.contextWindowTokens') ?? c.get('contextWindowTokens') ?? 128000;
    const keepLast = c.get<number>('compaction.keepLastMessages') ?? c.get('keepLastMessages') ?? 10;

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
      lineEndings: c.get('lineEndings'),
      stream: c.get('stream'),
      showThinking: c.get('showThinking'),
      agentFiles: {
        enabled: Boolean(agentEnabled),
        names: agentNames,
        patterns: agentPatterns,
        includeUser: Boolean(agentIncludeUser),
        userPath: agentUserPath,
        scanNested: Boolean(agentScanNested),
        maxDepth: typeof agentMaxDepth === 'number' ? agentMaxDepth : DEFAULT_CONFIG.agentFiles.maxDepth,
        maxBytes: typeof agentMaxBytes === 'number' ? agentMaxBytes : DEFAULT_CONFIG.agentFiles.maxBytes,
        maxTotalBytes: typeof agentMaxTotal === 'number' ? agentMaxTotal : DEFAULT_CONFIG.agentFiles.maxTotalBytes,
        extraPaths: agentExtraPaths,
      },
      context: {
        environment: Boolean(contextEnvironment),
        workspace: Boolean(contextWorkspace),
        files: Boolean(contextFiles),
        diagnostics: Boolean(contextDiagnostics),
        tools: Boolean(contextTools),
      },
      mcp: {
        enabled: Boolean(mcpEnabled),
        servers: (mcpConfig as Record<string, any>) || {},
        timeoutMs: typeof mcpTimeout === 'number' ? mcpTimeout : DEFAULT_CONFIG.mcp.timeoutMs,
        loadFromFiles: Boolean(mcpLoadFromFiles),
        configFiles: mcpConfigFiles,
      },
      compaction: {
        enabled: Boolean(compactionEnabled),
        autoCompact: Boolean(autoCompact),
        threshold: typeof threshold === 'number' ? threshold : 0.75,
        contextWindowTokens: typeof contextWindow === 'number' ? contextWindow : 128000,
        keepLastMessages: typeof keepLast === 'number' ? keepLast : 10,
      },
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

    // MCP servers come from workspace config files and settings; both are
    // re-read here so editing `.mcp.json` is picked up on the next task.
    const mcp = await this.resolveMcpServers(config, root);
    let toolRegistry: ToolRegistry;
    const signature = JSON.stringify({ servers: mcp.servers, timeout: config.mcp.timeoutMs });
    if (config.mcp.enabled && Object.keys(mcp.servers).length > 0) {
      try {
        if (this.mcpManager && this.mcpSignature === signature) {
          // Same servers as the running manager: keep its live connections.
          toolRegistry = new ToolRegistry([...createDefaultTools(), ...this.mcpManager.getTools()]);
        } else {
          if (this.mcpManager) {
            await this.mcpManager.stopAll();
          }
          this.mcpManager = new McpManager(root, config.mcp.timeoutMs);
          const { started, failed } = await this.mcpManager.startServers(mcp.servers);
          this.mcpSignature = signature;
          if (started.length > 0) {
            this.log.info(`MCP: started ${started.length} server(s): ${started.join(', ')}`);
            this.post({ type: 'mcp-status', enabled: true, servers: started.length, tools: this.mcpManager.toolCount });
          }
          if (failed.length > 0) {
            for (const f of failed) {
              this.log.warn(`MCP server ${f.id} failed: ${f.error}`);
              this.pushNotice('warn', `MCP server "${f.id}" failed to start: ${f.error}`);
            }
          }
          toolRegistry = new ToolRegistry([...createDefaultTools(), ...this.mcpManager.getTools()]);
          this.log.info(`MCP: loaded ${this.mcpManager.toolCount} tool(s) from ${started.length} server(s)`);
        }
      } catch (err) {
        this.log.warn(`MCP initialization failed: ${(err as Error).message}`);
        this.pushNotice('warn', `MCP initialization failed: ${(err as Error).message}`);
        toolRegistry = new ToolRegistry(createDefaultTools());
      }
    } else {
      if (this.mcpManager) {
        await this.mcpManager.stopAll();
        this.mcpManager = undefined;
      }
      this.mcpSignature = undefined;
      toolRegistry = new ToolRegistry(createDefaultTools());
    }

    if (!this.session || !this.host || this.host.workspaceRoot !== root) {
      this.host = new VsCodeHost({ root, log: this.log, approvals: this.approvals });
      this.session = new HarnessSession({
        host: this.host,
        config,
        provider,
        registry: toolRegistry,
        agentSelection: this.agentSelection,
      });
      this.log.info(`session created for ${root} using ${provider.label} with ${toolRegistry.size} tools`);
    } else {
      this.session.updateConfig(config);
      this.session.setProvider(provider);
      // If tools changed, we need to recreate session to pick up new registry
      // For simplicity, we recreate registry via a private field hack: create new session if tool count changed
      if (toolRegistry && toolRegistry.size !== this.session.toolNames.length) {
        this.host = new VsCodeHost({ root, log: this.log, approvals: this.approvals });
        const oldHistory = this.session.transcript;
        this.session = new HarnessSession({
          host: this.host,
          config,
          provider,
          registry: toolRegistry,
          agentSelection: this.agentSelection,
        });
        // Restore history and cumulative usage
        // @ts-ignore - accessing private for restoration
        (this.session as any).history = [...oldHistory];
        (this.session as any).cumulativeUsage = { ...this.cumulativeUsage };
        this.log.info(`session recreated with ${toolRegistry.size} tools (MCP updated)`);
      }
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
      showThinking: config.showThinking,
      contextWindow: config.compaction.contextWindowTokens,
      mcpEnabled: config.mcp.enabled,
      mcpServers: this.mcpManager?.serverCount ?? 0,
      mcpToolCount: this.mcpManager?.toolCount ?? 0,
      mcpConfigured: Object.keys(mcp.servers).length,
      mcpSources: mcp.sources,
      cumulativeUsage: this.cumulativeUsage,
      tokensPerSecond: this.lastTokensPerSecond,
    };
    return this.session;
  }

  /* -------------------------------------------------------- mcp config */

  /**
   * Merge MCP servers from workspace config files with the ones stored in
   * settings. Settings win. `${input:…}` placeholders are resolved through an
   * editor input box so `.vscode/mcp.json` can keep secrets out of the file.
   */
  private async resolveMcpServers(
    config: HarnessConfig,
    root: string,
  ): Promise<{ servers: Record<string, McpServerConfig>; sources: McpConfigSource[] }> {
    let fileConfig: McpFileConfig | undefined;
    if (config.mcp.enabled && config.mcp.loadFromFiles && config.mcp.configFiles.length > 0) {
      fileConfig = await loadMcpConfigFiles(root, config.mcp.configFiles, {
        resolveInput: (input) => this.promptForMcpInput(input),
      });
      this.mcpFileConfig = fileConfig;
      for (const error of fileConfig.errors) {
        this.log.warn(`MCP config ${error.path}: ${error.message}`);
        this.pushNotice('warn', `MCP config ${error.path}: ${error.message}`);
      }
      if (fileConfig.sources.length > 0) {
        this.log.info(
          `MCP config files: ${fileConfig.sources
            .map((source) => `${source.path} (${source.serverIds.length} server(s))`)
            .join(', ')}`,
        );
      }
    } else {
      this.mcpFileConfig = undefined;
    }
    const merged = mergeMcpServers(fileConfig, config.mcp.servers);
    this.configuredMcpServers = merged.servers;
    return { servers: merged.servers, sources: fileConfig?.sources ?? [] };
  }

  private async promptForMcpInput(input: McpInputSpec): Promise<string | undefined> {
    const cached = this.mcpInputCache.get(input.id);
    if (cached !== undefined) return cached;
    const value = await vscode.window.showInputBox({
      title: `MCP input: ${input.id}`,
      prompt: input.description ?? `Value for ${input.id}`,
      password: input.password === true,
      ignoreFocusOut: true,
    });
    if (value !== undefined) this.mcpInputCache.set(input.id, value);
    return value;
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
        showThinking: config.showThinking,
        contextWindow: config.compaction.contextWindowTokens,
        mcpEnabled: config.mcp.enabled,
        mcpServers: this.mcpManager?.serverCount ?? 0,
        mcpToolCount: this.mcpManager?.toolCount ?? 0,
        mcpConfigured: Object.keys(this.configuredMcpServers).length,
        mcpSources: this.mcpFileConfig?.sources ?? [],
        agentFilesEnabled: config.agentFiles.enabled,
        cumulativeUsage: this.cumulativeUsage,
        tokensPerSecond: this.lastTokensPerSecond,
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

  async run(prompt: string, rawImages?: readonly RawImageInput[]): Promise<void> {
    const text = prompt.trim();
    const { images, errors } = normalizeImages(rawImages);
    for (const error of errors) {
      this.pushNotice('warn', `Attachment skipped${error.name ? ` (${error.name})` : ''}: ${error.reason}`);
      this.log.warn(`image attachment rejected: ${error.reason}`);
    }
    // An image on its own is a valid request ("what is wrong here?"), so only
    // a turn with neither text nor images is ignored.
    if (!text && images.length === 0) return;
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

    if (images.length && this.state.provider === 'mock') {
      this.pushNotice('warn', 'The offline mock planner cannot see images — switch codingHarness.provider to a vision-capable model.');
    }

    const item = {
      id: this.id(),
      kind: 'user',
      text,
      ...(images.length ? { images: images.map(toTranscriptImage) } : {}),
    } as TranscriptItem;
    this.items.push(item);
    this.post({ type: 'item', item });
    const now = Date.now();
    this.activity = { ...this.activity, taskStartedAt: now, startedAt: now, step: 0, tool: null, detail: null };
    this.setStatus('thinking', true);
    this.log.info(`task: ${text.slice(0, 200)}${images.length ? ` [+${images.length} image(s)]` : ''}`);

    try {
      const result = await session.runTask(text, (event) => this.handleEvent(event), { images });
      this.cumulativeUsage = result.usage;
      this.lastTokensPerSecond = result.tokensPerSecond || 0;
      this.state = {
        ...this.state,
        cumulativeUsage: this.cumulativeUsage,
        tokensPerSecond: this.lastTokensPerSecond,
        contextTokens: result.contextTokens,
      };
      this.log.info(`task finished: ${result.outcome} in ${result.steps} step(s), ${result.toolCalls} tool call(s), ${result.usage.totalTokens || 0} tokens`);
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
    this.pushNotice('info', 'Cancelling the current task…');
  }

  reset(): void {
    if (this.session?.isRunning) this.session.cancel();
    this.session?.reset();
    this.cumulativeUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    this.lastTokensPerSecond = 0;
    this.items = [];
    this.post({ type: 'reset' });
    this.log.info('conversation reset');
  }

  async compactHistory(): Promise<void> {
    if (!this.session) {
      void vscode.window.showInformationMessage('No active session to compact.');
      return;
    }
    const result = this.session.compact();
    if (result.compacted) {
      this.pushNotice('info', `Compacted conversation: removed ${result.removed} old messages, freed ${result.originalTokens - result.newTokens} tokens (${result.newTokens} tokens now).`);
      this.log.info(`manual compaction: ${result.originalTokens} -> ${result.newTokens} tokens, removed ${result.removed}`);
      // Update context display
      const ctx = this.session.getContextUsage();
      this.state = {
        ...this.state,
        contextTokens: ctx.tokens,
        contextPercent: ctx.percent,
      };
      this.post({ type: 'state', state: this.state });
      this.post({ type: 'context', contextTokens: ctx.tokens, contextWindow: ctx.window, contextPercent: ctx.percent });
    } else {
      void vscode.window.showInformationMessage('Nothing to compact — conversation is already short.');
    }
  }

  async reloadMcpServers(): Promise<void> {
    const root = this.workspaceRoot();
    if (!root) {
      void vscode.window.showErrorMessage('Open a folder first.');
      void this.postMcpSettings();
      return;
    }
    const config = this.readConfig();
    if (!config.mcp.enabled) {
      void vscode.window.showInformationMessage('MCP is disabled. Enable codingHarness.mcp.enabled in settings.');
      void this.postMcpSettings();
      return;
    }
    try {
      const mcp = await this.resolveMcpServers(config, root);
      if (this.mcpManager) await this.mcpManager.stopAll();
      let started = 0;
      let failed: { id: string; error: string }[] = [];
      if (Object.keys(mcp.servers).length > 0) {
        this.mcpManager = new McpManager(root, config.mcp.timeoutMs);
        const result = await this.mcpManager.startServers(mcp.servers);
        started = result.started.length;
        failed = result.failed;
      } else {
        this.mcpManager = undefined;
      }
      this.mcpSignature = JSON.stringify({ servers: mcp.servers, timeout: config.mcp.timeoutMs });
      const toolCount = this.mcpManager?.toolCount ?? 0;
      this.state = {
        ...this.state,
        mcpServers: started,
        mcpToolCount: toolCount,
        mcpConfigured: Object.keys(mcp.servers).length,
        mcpSources: mcp.sources,
      };
      this.post({ type: 'state', state: this.state });
      this.post({ type: 'mcp-status', enabled: true, servers: started, tools: toolCount });

      if (started > 0) {
        void vscode.window.showInformationMessage(`MCP: started ${started} server(s) with ${toolCount} tool(s).`);
        this.log.info(`MCP reload: ${started} server(s), ${toolCount} tool(s)`);
      }
      if (failed.length > 0) {
        for (const failure of failed) {
          this.pushNotice('warn', `MCP server "${failure.id}" failed: ${failure.error}`);
        }
      }
      // Recreate the session so it picks up the new tool registry while
      // keeping the conversation intact.
      if (this.session && this.host) {
        const registry = new ToolRegistry([...createDefaultTools(), ...(this.mcpManager?.getTools() ?? [])]);
        const oldHistory = this.session.transcript;
        this.session = new HarnessSession({
          host: this.host,
          config,
          provider: createProvider({ config, apiKey: await this.resolveApiKey(config) }),
          registry,
          agentSelection: this.agentSelection,
        });
        (this.session as any).history = [...oldHistory];
        (this.session as any).cumulativeUsage = { ...this.cumulativeUsage };
        this.state = { ...this.state, toolCount: registry.size };
        this.post({ type: 'state', state: this.state });
      }
    } catch (err) {
      void vscode.window.showErrorMessage(`MCP reload failed: ${(err as Error).message}`);
      this.log.error(`MCP reload failed: ${(err as Error).message}`);
    }
    void this.postMcpSettings();
  }

  /* MCP settings dialog ---------------------------------------------------- */

  /** Editable MCP settings plus live per-server status, for the panel dialog. */
  async getMcpSettings(): Promise<McpSettingsSnapshot> {
    const config = this.readConfig();
    const root = this.workspaceRoot();
    const fileConfig = await this.ensureMcpFileConfig(config, root);
    const fileServers: Record<string, McpServerConfig> = { ...(fileConfig?.servers ?? {}) };
    // Servers also present in settings are edited there; the settings value wins.
    for (const id of Object.keys(config.mcp.servers)) delete fileServers[id];
    const status: Record<string, McpServerStatus> = {};
    const running = new Set(this.mcpManager?.serverIds ?? []);
    for (const id of new Set([...Object.keys(config.mcp.servers), ...Object.keys(fileServers)])) {
      status[id] = {
        running: running.has(id),
        tools: running.has(id) ? (this.mcpManager?.toolsOf(id) ?? 0) : 0,
        error: this.mcpManager?.failureOf(id),
      };
    }
    return {
      enabled: config.mcp.enabled,
      timeoutMs: config.mcp.timeoutMs,
      servers: config.mcp.servers,
      status,
      supportsWorkspace: Boolean(root),
      fileServers,
      sources: fileConfig?.sources ?? [],
      errors: fileConfig?.errors ?? [],
      loadFromFiles: config.mcp.loadFromFiles,
    };
  }

  /** Load the file-based server map once for the dialog without prompting twice. */
  private async ensureMcpFileConfig(config: HarnessConfig, root: string): Promise<McpFileConfig | undefined> {
    if (!root || !config.mcp.enabled || !config.mcp.loadFromFiles) return undefined;
    if (this.mcpFileConfig) return this.mcpFileConfig;
    this.mcpFileConfig = await loadMcpConfigFiles(root, config.mcp.configFiles, {
      resolveInput: (input) => this.promptForMcpInput(input),
    });
    return this.mcpFileConfig;
  }

  private async postMcpSettings(): Promise<void> {
    this.post({ type: 'mcp-settings', ...(await this.getMcpSettings()) });
  }

  /** Persist the dialog payload to settings, then (re)connect the servers. */
  async saveMcpSettings(input: { enabled?: unknown; timeoutMs?: unknown; servers?: unknown; target?: unknown }): Promise<void> {
    const servers = sanitizeMcpServers(input.servers);
    const enabled = Boolean(input.enabled);
    let timeoutMs =
      typeof input.timeoutMs === 'number' && Number.isFinite(input.timeoutMs) ? Math.floor(input.timeoutMs) : DEFAULT_CONFIG.mcp.timeoutMs;
    if (timeoutMs < 1000) timeoutMs = 1000;
    const toWorkspace = input.target === 'workspace';
    if (toWorkspace && !this.workspaceRoot()) {
      this.post({ type: 'mcp-settings-saved', ok: false, error: 'Saving workspace settings needs an open folder.' });
      return;
    }
    const target = toWorkspace ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    try {
      const c = vscode.workspace.getConfiguration('codingHarness');
      await c.update('mcp.enabled', enabled, target);
      await c.update('mcp.timeoutMs', timeoutMs, target);
      await c.update('mcp.servers', servers, target);
    } catch (err) {
      this.log.error(`MCP settings save failed: ${(err as Error).message}`);
      this.post({ type: 'mcp-settings-saved', ok: false, error: (err as Error).message });
      return;
    }
    this.log.info(
      `MCP settings saved to ${toWorkspace ? 'workspace' : 'user'} settings: ${Object.keys(servers).length} server(s), enabled=${enabled}`,
    );

    await this.refreshState();
    if (enabled) {
      await this.reloadMcpServers();
    } else {
      if (this.mcpManager) {
        await this.mcpManager.stopAll();
        this.mcpManager = undefined;
      }
      this.mcpFileConfig = undefined;
      this.mcpSignature = undefined;
      this.configuredMcpServers = {};
      this.state = { ...this.state, mcpEnabled: false, mcpServers: 0, mcpToolCount: 0, mcpConfigured: 0 };
      this.post({ type: 'state', state: this.state });
      this.post({ type: 'mcp-status', enabled: false, servers: 0, tools: 0 });
      // Swap a live session back to the built-in tools so disabled servers go quiet.
      if (this.session && this.host) {
        const config = this.readConfig();
        const registry = new ToolRegistry(createDefaultTools());
        const oldHistory = this.session.transcript;
        this.session = new HarnessSession({
          host: this.host,
          config,
          provider: createProvider({ config, apiKey: await this.resolveApiKey(config) }),
          registry,
          agentSelection: this.agentSelection,
        });
        (this.session as any).history = [...oldHistory];
        (this.session as any).cumulativeUsage = { ...this.cumulativeUsage };
        this.state = { ...this.state, toolCount: registry.size };
        this.post({ type: 'state', state: this.state });
      }
    }
    this.pushNotice('info', `MCP settings saved (${toWorkspace ? 'workspace' : 'user'}): ${Object.keys(servers).length} server(s) configured.`);
    this.post({ type: 'mcp-settings-saved', ok: true });
    await this.postMcpSettings();
  }

  /* ------------------------------------------------------ agent instructions */

  private async collectWorkspaceContext(): Promise<WorkspaceContext | undefined> {
    if (this.host) {
      try {
        return await this.host.getWorkspaceContext?.();
      } catch (err) {
        this.log.warn(`workspace context unavailable: ${(err as Error).message}`);
        return undefined;
      }
    }
    // Before the first task there is no host yet; the editor itself still
    // knows which files are open, and those decide which nested agent files
    // apply.
    try {
      const openFiles = (vscode.workspace.textDocuments ?? [])
        .filter((doc) => doc.uri.scheme === 'file')
        .map((doc) => ({ path: vscode.workspace.asRelativePath(doc.uri, false) }))
        .slice(0, 30);
      return { openFiles, folders: (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath) };
    } catch {
      return undefined;
    }
  }

  /** Re-read the agent files and publish the result to the panel. */
  async refreshAgentFiles(notify = false): Promise<AgentFilesResult | undefined> {
    const root = this.workspaceRoot();
    const config = this.readConfig();
    if (!root) {
      this.lastAgentFiles = undefined;
      this.state = {
        ...this.state,
        agentFiles: [],
        agentFilesCount: 0,
        agentFilesAvailable: 0,
        agentFilesEnabled: config.agentFiles.enabled,
      };
      this.post({ type: 'state', state: this.state });
      return undefined;
    }
    const workspace = await this.collectWorkspaceContext();
    const discovered = discoverAgentFiles({
      root,
      config: config.agentFiles,
      focusPaths: (workspace?.openFiles ?? []).map((file) => file.path),
    });
    // `lastAgentFiles` keeps the unfiltered result: the picker lists every
    // discovered file, including the ones currently pinned out.
    this.lastAgentFiles = discovered;
    this.pruneStaleAgentSelection(discovered);

    const active = selectAgentFiles(discovered, this.agentSelection);
    this.state = {
      ...this.state,
      agentFiles: active.files.map((file) => ({
        displayPath: file.displayPath,
        absolutePath: file.path,
        scope: file.scope,
        origin: file.origin,
        bytes: file.bytes,
        truncated: file.truncated,
      })),
      agentFilesCount: active.files.length,
      agentFilesAvailable: active.available,
      agentFilesEnabled: active.enabled,
      ...(this.agentSelection ? { agentSelection: [...this.agentSelection] } : { agentSelection: undefined }),
    };
    this.post({ type: 'state', state: this.state });
    this.log.info(
      `agent files: ${agentFilesSummary(active)}` +
        (active.selection ? ` (${active.files.length} of ${active.available} selected)` : '') +
        (discovered.skipped.length ? ` (${discovered.skipped.length} skipped)` : ''),
    );
    if (notify) {
      const skipped = discovered.skipped.length ? ` ${discovered.skipped.length} path(s) skipped.` : '';
      const selected = active.selection ? ` ${active.files.length} of ${active.available} selected.` : '';
      void vscode.window.showInformationMessage(
        `Coding Harness: ${agentFilesSummary(active)} (${active.totalBytes} bytes loaded).${selected}${skipped}`,
      );
    }
    return discovered;
  }

  /**
   * Drop pinned paths that no longer exist. A selection silently shrinking to
   * nothing would run the agent with no instructions at all, so an empty
   * remainder falls back to "every discovered file" and says so.
   */
  private pruneStaleAgentSelection(discovered: AgentFilesResult): void {
    if (!this.agentSelection) return;
    const known = new Set(discovered.files.map((file) => file.displayPath));
    const kept = this.agentSelection.filter((path) => known.has(path));
    if (kept.length === this.agentSelection.length) return;

    const dropped = this.agentSelection.filter((path) => !known.has(path));
    this.log.warn(`agent selection: dropping ${dropped.length} missing file(s): ${dropped.join(', ')}`);
    if (kept.length === 0) {
      this.agentSelection = undefined;
      void this.persistAgentSelection();
      this.pushNotice(
        'warn',
        `The pinned instruction file(s) were not found (${dropped.join(', ')}). Using every discovered file again.`,
      );
      return;
    }
    this.agentSelection = kept;
    void this.persistAgentSelection();
    this.pushNotice('info', `Instruction file(s) no longer found and removed from the selection: ${dropped.join(', ')}.`);
  }

  /** Everything the agents dialog needs: discovered files plus the current pin. */
  async getAgentSettings(): Promise<AgentSettingsSnapshot> {
    const root = this.workspaceRoot();
    const discovered = await this.refreshAgentFiles();
    const files = discovered?.files ?? [];
    const pinned = this.agentSelection ? new Set(this.agentSelection) : undefined;
    return {
      enabled: discovered?.enabled ?? this.readConfig().agentFiles.enabled,
      selection: this.agentSelection ? [...this.agentSelection] : null,
      files: files.map((file) => ({
        displayPath: file.displayPath,
        scope: file.scope,
        origin: file.origin,
        bytes: file.bytes,
        truncated: file.truncated,
        active: !pinned || pinned.has(file.displayPath),
      })),
      available: files.length,
      root,
    };
  }

  /**
   * Pin the instruction files sent with each task. `null` (or an empty list)
   * means "everything discovered"; anything else must name files that exist.
   */
  async saveAgentSelection(input: unknown): Promise<void> {
    const requested = HarnessController.arrayOfStrings(input);
    if (!requested || requested.length === 0) {
      this.agentSelection = undefined;
    } else {
      const discovered = await this.refreshAgentFiles();
      const known = new Set((discovered?.files ?? []).map((file) => file.displayPath));
      const kept = requested.filter((path) => known.has(path));
      const dropped = requested.filter((path) => !known.has(path));
      if (kept.length === 0) {
        this.post({
          type: 'agent-settings-saved',
          ok: false,
          error: known.size === 0 ? 'No instruction files were found in this workspace.' : 'None of the selected files exist any more.',
        });
        return;
      }
      this.agentSelection = kept;
      if (dropped.length > 0) {
        this.log.warn(`agent selection: ignored ${dropped.length} unknown path(s): ${dropped.join(', ')}`);
      }
    }

    await this.persistAgentSelection();
    this.session?.setAgentSelection(this.agentSelection);
    const discovered = await this.refreshAgentFiles();
    this.post({
      type: 'agent-settings-saved',
      ok: true,
      selection: this.agentSelection ? [...this.agentSelection] : null,
    });
    const available = discovered?.files.length ?? 0;
    const label = this.agentSelection
      ? `${this.agentSelection.length} of ${available} instruction file(s) active: ${this.agentSelection.join(', ')}`
      : `all ${available} discovered instruction file(s) active`;
    this.log.info(`agent selection saved: ${label}`);
    this.pushNotice('info', `Agent instructions — ${label}.`);
  }

  /** Write the pin to workspaceState so it survives a window reload. */
  private async persistAgentSelection(): Promise<void> {
    try {
      await this.context.workspaceState?.update(AGENT_SELECTION_KEY, this.agentSelection);
    } catch (err) {
      this.log.warn(`could not persist the agent selection: ${(err as Error).message}`);
    }
  }

  /** Open one of the loaded agent files, or offer to create one. */
  async openAgentInstructions(): Promise<void> {
    const result = await this.refreshAgentFiles();
    const root = this.workspaceRoot();
    if (!root) {
      void vscode.window.showErrorMessage('Open a folder first.');
      return;
    }
    if (!result || !result.enabled) {
      const enable = await vscode.window.showInformationMessage(
        'Agent instructions are disabled. Enable codingHarness.agentFiles.enabled to load agent.md files.',
        'Open Settings',
      );
      if (enable === 'Open Settings') {
        await vscode.commands.executeCommand('workbench.action.openSettings', 'codingHarness.agentFiles');
      }
      return;
    }
    if (result.files.length === 0) {
      const create = await vscode.window.showInformationMessage(
        'No instruction files were found. The extension has no built-in prompt — instructions come from these files (any .md file under .agents/ works).',
        'Create agent.md',
      );
      if (create === 'Create agent.md') await this.createAgentFile();
      return;
    }
    if (result.files.length === 1) {
      await this.openFile(result.files[0].path);
      return;
    }
    const picked = await vscode.window.showQuickPick(
      result.files.map((file) => ({
        label: file.displayPath,
        description: file.origin === 'user' ? 'user-level' : file.scope ? `applies to ${file.scope}/**` : 'workspace root',
        detail: `${file.bytes} bytes${file.truncated ? ' (truncated)' : ''}`,
        file,
      })),
      { title: 'Coding Harness — agent instruction files', placeHolder: 'Open an instruction file' },
    );
    if (picked) await this.openFile(picked.file.path);
  }

  /** Create a starter `agent.md` at the workspace root (user-initiated only). */
  async createAgentFile(): Promise<void> {
    const root = this.workspaceRoot();
    if (!root) {
      void vscode.window.showErrorMessage('Open a folder first.');
      return;
    }
    const abs = path.join(root, 'agent.md');
    if (fs.existsSync(abs)) {
      await this.openFile(abs);
      return;
    }
    const template = [
      '# Agent instructions',
      '',
      '<!-- Everything below is sent with every task; the extension has no built-in prompt. -->',
      '<!-- Add project conventions, commands to run, style rules and things to avoid. -->',
      '',
      '## Project',
      '',
      '## Commands',
      '',
      '## Conventions',
      '',
    ].join('\n');
    try {
      fs.writeFileSync(abs, template, 'utf8');
    } catch (err) {
      void vscode.window.showErrorMessage(`Could not create agent.md: ${(err as Error).message}`);
      return;
    }
    await this.openFile(abs);
    await this.refreshAgentFiles();
    // Any .md under .agents/ is loaded too, so code-review.md / test.md work
    // without touching settings; mention it where the user sees the template.
    this.pushNotice(
      'info',
      'Created agent.md. Any .md file under .agents/ is also loaded as instructions (code-review.md, test.md, …).',
    );
  }

  /**
   * Show the exact system context that would be sent with the next task:
   * environment, workspace, files, tool catalogue and the agent files.
   */
  async previewContext(): Promise<void> {
    const root = this.workspaceRoot();
    if (!root) {
      void vscode.window.showErrorMessage('Open a folder first.');
      return;
    }
    const config = this.readConfig();
    const workspace = await this.collectWorkspaceContext();
    const agentFiles = selectAgentFiles(
      discoverAgentFiles({
        root,
        config: config.agentFiles,
        focusPaths: (workspace?.openFiles ?? []).map((file) => file.path),
      }),
      this.agentSelection,
    );
    let diagnostics: string[] | undefined;
    if (config.context.diagnostics) {
      try {
        const host = this.host ?? new VsCodeHost({ root, log: this.log, approvals: this.approvals });
        const diags = await host.getDiagnostics();
        if (diags.length) diagnostics = summarizeDiagnostics(diags);
      } catch {
        /* no diagnostics available */
      }
    }
    const tools = this.session?.toolSpecs ?? new ToolRegistry(createDefaultTools()).specs();
    const prompt = buildSystemPrompt({ root, config, tools, diagnostics, workspace, agentFiles });
    const doc = await vscode.workspace.openTextDocument({ content: prompt, language: 'markdown' });
    await vscode.window.showTextDocument(doc, { preview: false });
    this.log.info(`context preview: ${prompt.length} chars, ${agentFiles.files.length} agent file(s)`);
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
    const abs = path.isAbsolute(relPath) ? relPath : path.join(root, relPath);
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
      case 'thinking-delta':
        this.appendThinkingDelta(event.id, event.text);
        break;
      case 'thinking':
        this.finishThinking(event.id, event.text, event.durationMs);
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
      case 'usage': {
        // Merge cumulative usage
        if (event.usage) {
          if (event.cumulative) {
            this.cumulativeUsage = event.cumulative;
          } else {
            this.cumulativeUsage = mergeUsage(this.cumulativeUsage, event.usage);
          }
          if (event.tokensPerSecond) this.lastTokensPerSecond = event.tokensPerSecond;
          else if (event.durationMs && event.usage.outputTokens) {
            const sec = event.durationMs / 1000;
            if (sec > 0) this.lastTokensPerSecond = event.usage.outputTokens / sec;
          }

          this.state = {
            ...this.state,
            usage: event.usage,
            cumulativeUsage: this.cumulativeUsage,
            tokensPerSecond: this.lastTokensPerSecond,
            contextTokens: event.contextTokens ?? this.state.contextTokens,
            contextWindow: event.contextWindow ?? this.state.contextWindow,
            contextPercent: event.contextPercent ?? this.state.contextPercent,
          };
          this.post({ type: 'state', state: this.state });
        }
        this.post({
          type: 'usage',
          usage: event.usage,
          step: event.step,
          durationMs: event.durationMs,
          tokensPerSecond: event.tokensPerSecond,
          contextTokens: event.contextTokens,
          contextWindow: event.contextWindow,
          contextPercent: event.contextPercent,
          cumulative: event.cumulative || this.cumulativeUsage,
        });
        break;
      }
      case 'context': {
        this.state = {
          ...this.state,
          contextTokens: event.contextTokens,
          contextWindow: event.contextWindow,
          contextPercent: event.contextPercent,
        };
        this.post({ type: 'state', state: this.state });
        this.post({ type: 'context', contextTokens: event.contextTokens, contextWindow: event.contextWindow, contextPercent: event.contextPercent });
        break;
      }
      case 'agent-files': {
        const available = event.available ?? event.files.length;
        this.state = {
          ...this.state,
          agentFiles: event.files,
          agentFilesCount: event.files.length,
          agentFilesAvailable: available,
          agentFilesEnabled: event.enabled,
          ...(this.agentSelection ? { agentSelection: [...this.agentSelection] } : { agentSelection: undefined }),
        };
        this.post({ type: 'state', state: this.state });
        if (event.enabled && available === 0 && !this.agentNoticeShown) {
          this.agentNoticeShown = true;
          this.pushNotice(
            'info',
            'No instruction files found. This extension has no built-in prompt — add AGENTS.md / agent.md, or any .md file under .agents/, to tell the agent how to work in this workspace.',
          );
        }
        // A pin that filtered everything out means the files it named are gone.
        // Drop it here as well, so the next task is not silently instruction-free.
        if (this.agentSelection && event.files.length === 0 && available > 0) {
          this.log.warn('agent selection matched no discovered file; falling back to every file');
          this.agentSelection = undefined;
          void this.persistAgentSelection();
          this.session?.setAgentSelection(undefined);
          void this.refreshAgentFiles();
        }
        if (event.files.length > 0) {
          this.log.info(
            `agent files: ${event.files.map((file) => file.displayPath).join(', ')} (${event.totalBytes} bytes)` +
              (this.agentSelection ? ` — ${event.files.length} of ${available} selected` : '') +
              (event.skipped ? `, ${event.skipped} skipped` : ''),
          );
        }
        break;
      }
      case 'mcp-status': {
        this.state = {
          ...this.state,
          mcpEnabled: event.enabled,
          mcpServers: event.servers,
          mcpToolCount: event.tools,
        };
        this.post({ type: 'state', state: this.state });
        this.post({ type: 'mcp-status', enabled: event.enabled, servers: event.servers, tools: event.tools });
        break;
      }
      case 'done':
        this.push({
          id: this.id(),
          kind: 'done',
          reason: event.reason,
          summary: event.summary,
          filesChanged: event.filesChanged,
          usage: event.usage || this.cumulativeUsage,
          tokensPerSecond: event.tokensPerSecond || this.lastTokensPerSecond,
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

  /** Append a reasoning fragment; creates the thinking lane on first text. */
  private appendThinkingDelta(id: string, text: string): void {
    let item = this.items.find(
      (i): i is Extract<TranscriptItem, { kind: 'thinking' }> => i.kind === 'thinking' && i.id === id,
    );
    if (!item) {
      item = { id, kind: 'thinking', text: '', streaming: true, startedAt: Date.now() };
      this.items.push(item);
      this.post({ type: 'item', item: { ...item } });
    }
    item.text += text;

    const entry = this.streams.get(id) ?? {};
    if (!entry.timer) {
      entry.timer = setTimeout(() => {
        entry.timer = undefined;
        this.post({ type: 'update', item: { ...item! } });
      }, 80);
      this.streams.set(id, entry);
    }
  }

  /** Close the thinking lane: keep the text, record how long it ran. */
  private finishThinking(id: string, text: string, durationMs: number): void {
    const entry = this.streams.get(id);
    if (entry?.timer) clearTimeout(entry.timer);
    this.streams.delete(id);

    const item = this.items.find(
      (i): i is Extract<TranscriptItem, { kind: 'thinking' }> => i.kind === 'thinking' && i.id === id,
    );
    if (!item) return;
    item.text = text || item.text;
    item.streaming = false;
    item.durationMs = durationMs || (item.startedAt ? Date.now() - item.startedAt : 0);
    this.post({ type: 'update', item: { ...item } });
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

function mergeUsage(a: Usage, b: Usage): Usage {
  const inputTokens = (a.inputTokens ?? 0) + (b.inputTokens ?? 0);
  const outputTokens = (a.outputTokens ?? 0) + (b.outputTokens ?? 0);
  const totalTokens = (a.totalTokens ?? 0) + (b.totalTokens ?? 0) || inputTokens + outputTokens;
  return {
    inputTokens: inputTokens || undefined,
    outputTokens: outputTokens || undefined,
    totalTokens: totalTokens || undefined,
  };
}

/** Short "what is it touching" hint for the activity strip. */
function describeToolCall(name: string, rawArgs: string): string | null {
  try {
    const args = JSON.parse(rawArgs || '{}') as Record<string, unknown>;
    const pick = args.path ?? args.command ?? args.query ?? args.file;
    if (typeof pick !== 'string' || !pick) return null;
    const oneLine = pick.replace(/\s+/g, ' ').trim();
    const value = oneLine.length > 70 ? `${oneLine.slice(0, 67)}…` : oneLine;
    return name === 'run_command' ? `$ ${value}` : value;
  } catch {
    return null;
  }
}

function toTranscriptImage(image: ImageAttachment): TranscriptImage {
  return {
    ...(image.name ? { name: image.name } : {}),
    mediaType: image.mediaType,
    dataUrl: toDataUrl(image),
    bytes: image.bytes,
  };
}
