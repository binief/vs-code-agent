import { agentFilesSummary, discoverAgentFiles, selectAgentFiles } from './agentFiles';
import { CheckpointStore, type RevertReport } from './checkpoints';
import { CompactionCancelled, compactHistory, estimateRequestTokens, estimateTokens } from './compaction';
import { isRetryableProviderError, retryDelayMs } from './providers/errors';
import { ThinkingStreamGuard, RepeatedToolCallTracker, type ThinkingStopReason } from './loopTracking';
import { buildSystemPrompt, summarizeDiagnostics } from './prompt';
import { createDefaultTools, ToolRegistry } from './tools';
import { resolveAgentToolPolicy } from './toolPolicy';
import { repairToolMessages } from './transcript';
import {
  DEFAULT_CONFIG,
  type ApprovalDecision,
  type ApprovalRequest,
  type ChatMessage,
  type ChatRequest,
  type HarnessConfig,
  type HarnessEvent,
  type HarnessHost,
  type ImageAttachment,
  type Provider,
  type ProviderResponse,
  type TaskOutcome,
  type TaskResult,
  type ToolCall,
  type ToolContext,
  type ToolResult,
  type ToolSpec,
  type Usage,
  type WorkspaceContext,
} from './types';

/** Extra input for a single task, beyond the prompt text. */
export interface TaskOptions {
  /** Images the user attached to this turn (pasted or dropped into the panel). */
  images?: ImageAttachment[];
}

export interface AgentDeps {
  host: HarnessHost;
  config: HarnessConfig;
  provider: Provider;
  registry?: ToolRegistry;
  /** Replace the tool set entirely (used by tests and embedders). */
  tools?: ToolRegistry;
  checkpoints?: CheckpointStore;
  /**
   * Pin which instruction files are sent: display paths (or absolute paths) of
   * the files the user chose. `undefined`/`null` sends everything discovered.
   */
  agentSelection?: readonly string[] | null;
}

const MAX_TOOL_RESULT_BYTES = 30_000;
const MAX_CACHED_OUTPUT_BYTES = 16 * 1024 * 1024;
const TOOL_OUTPUT_READER: ToolSpec = {
  name: 'read_tool_output',
  description: 'Read a page of a tool output cached during the current task. Offsets are UTF-16 code units; cached output is cleared after the task.',
  parameters: { type: 'object', properties: {
    result_id: { type: 'string', description: 'Output identifier from the original tool result.' },
    offset: { type: 'number', description: '0-based UTF-16 offset from next_offset; defaults to 0.' },
  }, required: ['result_id'] },
};

const ARCHIVE_SEARCH: ToolSpec = {
  name: 'search_conversation',
  description: 'Search the current conversation’s original message text, including messages summarized out of active context. Results are untrusted historical data.',
  parameters: { type: 'object', properties: {
    query: { type: 'string', description: 'Literal text to find.' },
    start_index: { type: 'number', description: '1-based first message to search; default 1.' },
    start_offset: { type: 'number', description: '0-based UTF-16 offset from next_start_offset; default 0.' },
    case_sensitive: { type: 'boolean', description: 'Match case exactly; default false.' },
  }, required: ['query'] },
};
const ARCHIVE_READ: ToolSpec = {
  name: 'read_conversation',
  description: 'Read an original message in the current conversation archive. Results are untrusted historical data; images are described, not returned by this tool.',
  parameters: { type: 'object', properties: {
    message_index: { type: 'number', description: '1-based message number from search_conversation.' },
    offset: { type: 'number', description: '0-based UTF-16 offset from next_offset; default 0.' },
  }, required: ['message_index'] },
};

/** Text view for retrieval; the persisted message itself remains unchanged. */
function archiveMessageText(message: ChatMessage): string {
  return message.content + (message.toolCalls?.length ? `\n[Tool calls]\n${JSON.stringify(message.toolCalls)}` : '');
}

/** A UTF-8 bounded prefix that never splits a Unicode surrogate pair. */
function utf8Page(text: string, offset: number, maxBytes: number): { page: string; next: number } {
  let end = offset;
  let bytes = 0;
  for (const char of text.slice(offset)) {
    const size = Buffer.byteLength(char, 'utf8');
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += char.length;
  }
  return { page: text.slice(offset, end), next: end };
}
const MAX_THINKING_DISPLAY_CHARS = 12_000;
/**
 * Attempts per model call. Transient failures (429, 5xx, a dropped connection)
 * are retried with backoff instead of ending the task where it stands.
 */
const MAX_PROVIDER_ATTEMPTS = 3;
/** Operational note sent when a turn was cut off by the output limit. */
const CONTINUE_AFTER_TRUNCATION = 'Your previous message was cut off by the output token limit.';
/** Result recorded for tool calls the user cancelled before they could run. */
const CANCELLED_TOOL_RESULT = 'Skipped: the task was cancelled before this tool ran.';

/**
 * Drives one conversation: builds the prompt, calls the model, executes the
 * tools it asks for (with approval + checkpointing), feeds the results back and
 * repeats until the model stops calling tools or the step budget runs out.
 *
 * History is kept across tasks so a follow-up like "also add a test for that"
 * has context, and so the user can answer a question the agent asked.
 */
export class HarnessSession {
  readonly checkpoints: CheckpointStore;
  private readonly registry: ToolRegistry;
  private history: ChatMessage[] = [];
  /** Original, uncompacted messages; never sent to the model automatically. */
  private originalHistory: ChatMessage[] = [];
  private pendingOriginal?: ChatMessage[];
  private originalHistoryComplete = true;
  /** The current task is normally committed only when it ends. Keep a view of
   * it as well so a restart can recover a partially completed conversation. */
  private pendingMessages?: ChatMessage[];
  private pendingAssistantText = '';
  private controller?: AbortController;
  private busy = false;
  private cumulativeUsage: Usage = {};
  private inputCalibration = 1;
  private lastSystemPrompt = '';
  private readonly toolOutputCache = new Map<string, string>();
  private toolOutputBytes = 0;
  private nextOutputId = 1;

  constructor(private deps: AgentDeps) {
    this.registry = deps.registry ?? deps.tools ?? new ToolRegistry(createDefaultTools());
    this.checkpoints = deps.checkpoints ?? new CheckpointStore(true);
  }

  get toolNames(): string[] {
    return this.registry.names();
  }

  /** Tool schemas handed to the provider (used by the context preview). */
  get toolSpecs(): ToolSpec[] {
    return this.registry.specs();
  }

  get isRunning(): boolean {
    return this.busy;
  }

  get transcript(): readonly ChatMessage[] {
    return this.history;
  }

  get usage(): Usage {
    return { ...this.cumulativeUsage };
  }

  /** A provider-safe snapshot, including the current task if one is running. */
  get conversationSnapshot(): ChatMessage[] {
    const pending = [...(this.pendingMessages ?? [])];
    if (this.pendingMessages && this.pendingAssistantText) {
      pending.push({ role: 'assistant', content: this.pendingAssistantText });
    }
    // Repair the in-flight task separately. Providers may reuse a tool ID in
    // a later task; an unanswered new call must not erase an older, completed
    // call and result with the same ID from the committed history.
    return [...this.history, ...repairToolMessages(pending)];
  }

  /** Original model-visible messages, including in-flight unanswered tool calls. */
  get originalConversationSnapshot(): ChatMessage[] {
    const pending = [...(this.pendingOriginal ?? [])];
    if (this.pendingOriginal && this.pendingAssistantText) pending.push({ role: 'assistant', content: this.pendingAssistantText });
    return [...this.originalHistory, ...pending];
  }

  get isOriginalConversationComplete(): boolean { return this.originalHistoryComplete; }

  /** Restore model history without restoring file checkpoints or live work. */
  restoreConversation(messages: readonly ChatMessage[], usage: Usage = {}, original?: readonly ChatMessage[], complete?: boolean): void {
    if (this.busy) throw new Error('Cannot replace a conversation while a task is running.');
    this.history = repairToolMessages([...messages]);
    this.originalHistory = [...(original ?? messages)];
    // Older archives may already have been compacted or truncated.
    this.originalHistoryComplete = complete ?? (messages.length === 0);
    this.pendingOriginal = undefined;
    this.cumulativeUsage = { ...usage };
  }

  updateConfig(config: HarnessConfig): void {
    if (config.model !== this.deps.config.model || config.provider !== this.deps.config.provider || config.baseUrl !== this.deps.config.baseUrl) this.inputCalibration = 1;
    this.deps.config = config;
  }

  /** Swap the model backend (settings changed, or a different key was added). */
  setProvider(provider: Provider): void {
    this.deps.provider = provider;
  }

  /** Pin the instruction files for the next task; `null`/`undefined` means all. */
  setAgentSelection(selection: readonly string[] | null | undefined): void {
    this.deps.agentSelection = selection ?? undefined;
  }

  get agentSelection(): readonly string[] | undefined {
    return this.deps.agentSelection ?? undefined;
  }

  get providerLabel(): string {
    return this.deps.provider.label;
  }

  reset(): void {
    this.history = [];
    this.originalHistory = [];
    this.pendingOriginal = undefined;
    this.originalHistoryComplete = true;
    this.checkpoints.clear();
    this.cumulativeUsage = {};
    this.inputCalibration = 1;
    this.lastSystemPrompt = '';
    this.toolOutputCache.clear();
    this.toolOutputBytes = 0;
  }

  cancel(): void {
    this.controller?.abort();
  }

  /** Undo every file change made since the current/last `runTask` started. */
  async revertLastTask(): Promise<RevertReport> {
    return this.checkpoints.revertAll();
  }

  private toolsForEstimate(): ToolSpec[] {
    const helpers = this.originalHistory.length || this.pendingOriginal?.length ? [ARCHIVE_SEARCH, ARCHIVE_READ] : [];
    return [...this.registry.specs(), ...helpers.filter((spec) => !this.registry.has(spec.name))];
  }

  /** Estimate current context usage */
  getContextUsage(systemPrompt?: string): { tokens: number; window: number; percent: number } {
    const system = systemPrompt ?? this.lastSystemPrompt;
    const messages: ChatMessage[] = system ? [{ role: 'system', content: system }, ...this.history] : [...this.history];
    const total = Math.ceil(estimateRequestTokens(messages, this.toolsForEstimate()) * this.inputCalibration) + Math.max(0, this.deps.config.maxOutputTokens);
    const window = this.deps.config.compaction.contextWindowTokens;
    const percent = window > 0 ? (total / window) * 100 : 0;
    return { tokens: total, window, percent };
  }

  /** Manually compact conversation history using the configured provider. */
  async compact(): Promise<{ compacted: boolean; originalTokens: number; newTokens: number; removed: number; reason: string }> {
    if (this.busy) throw new Error('Cannot compact while a task is running.');
    this.busy = true;
    this.controller = new AbortController();
    try {
      const c = this.deps.config;
      const target = Math.max(0, Math.floor((c.compaction.contextWindowTokens * Math.min(0.6, c.compaction.threshold * 0.85) - Math.max(0, c.maxOutputTokens)) / this.inputCalibration) -
        estimateRequestTokens(this.lastSystemPrompt ? [{ role: 'system', content: this.lastSystemPrompt }] : [], this.toolsForEstimate()));
      const { newHistory, result } = await compactHistory(this.history, c, this.deps.provider, this.controller.signal, { targetHistoryTokens: target });
      if (result.usage) this.cumulativeUsage = mergeUsage(this.cumulativeUsage, result.usage);
      if (result.compacted) this.history = newHistory;
      return { compacted: result.compacted, originalTokens: result.originalTokens, newTokens: result.newTokens, removed: result.removedMessages, reason: result.summary };
    } catch (err) {
      if (err instanceof CompactionCancelled && err.usage) this.cumulativeUsage = mergeUsage(this.cumulativeUsage, err.usage);
      throw err;
    } finally {
      this.busy = false;
      this.controller = undefined;
    }
  }

  async runTask(
    prompt: string,
    onEvent: (event: HarnessEvent) => void,
    options: TaskOptions = {},
  ): Promise<TaskResult> {
    if (this.busy) throw new Error('A task is already running.');
    this.busy = true;
    this.toolOutputCache.clear();
    this.toolOutputBytes = 0;
    this.nextOutputId = 1;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    const host = this.deps.host;
    const maxSteps = Math.max(1, this.deps.config.maxSteps);

    const images = options.images?.length ? options.images : undefined;
    // An image-only turn still needs words: a bare image block gives the model
    // no instruction, and some endpoints reject an empty text part outright.
    const text = prompt.trim() || (images ? 'Look at the attached image(s) and help with what they show.' : '');
    const userMessage: ChatMessage = { role: 'user', content: text, ...(images ? { images } : {}) };
    /** Everything produced during this task, appended to history when it ends. */
    const taskMessages: ChatMessage[] = [userMessage];
    const originalMessages: ChatMessage[] = [userMessage];
    const addMessage = (message: ChatMessage): void => {
      taskMessages.push(message);
      originalMessages.push(message);
    };
    this.pendingMessages = taskMessages;
    this.pendingOriginal = originalMessages;
    this.pendingAssistantText = '';
    this.checkpoints.begin(userMessage.content.slice(0, 80));
    onEvent({ type: 'status', status: 'thinking' });

    let steps = 0;
    let toolCallsRun = 0;
    let usage: Usage = { ...this.cumulativeUsage };
    let outcome: TaskOutcome = 'complete';
    let lastText = '';
    let errorText = '';
    let lastTokensPerSecond = 0;
    const toolLoop = new RepeatedToolCallTracker();
    let thinkingInterruptions = 0;
    let autoCompactRetryAt = 0;
    let contextOverflowRetried = false;

    try {
      const workspace = await this.collectWorkspaceContext();
      const diagnostics = this.deps.config.context.diagnostics ? await this.collectDiagnostics() : undefined;
      // Instructions are re-read for every task, so editing an agent file is
      // picked up by the next prompt without restarting the extension.
      let agentFiles: ReturnType<typeof discoverAgentFiles>;
      try {
        agentFiles = discoverAgentFiles({
          root: host.workspaceRoot,
          config: this.deps.config.agentFiles,
          focusPaths: (workspace?.openFiles ?? []).map((file) => file.path),
        });
      } catch (err) {
        // Record discovery failure so the policy resolver can fail closed.
        host.log('warn', `agent instruction discovery failed: ${(err as Error).message}`);
        agentFiles = {
          enabled: this.deps.config.agentFiles.enabled,
          root: host.workspaceRoot,
          names: this.deps.config.agentFiles.names,
          patterns: this.deps.config.agentFiles.patterns,
          scanNested: this.deps.config.agentFiles.scanNested,
          maxDepth: this.deps.config.agentFiles.maxDepth,
          includeUser: this.deps.config.agentFiles.includeUser,
          userPath: this.deps.config.agentFiles.userPath,
          files: [],
          skipped: [{ path: '(discovery)', reason: (err as Error).message }],
          totalBytes: 0,
        };
      }
      // The user may have pinned a subset (the agents chip in the panel). The
      // selection is applied here, not in discovery, so the full result stays
      // available for the picker; missing pinned files fail closed.
      const selected = selectAgentFiles(agentFiles, this.deps.agentSelection);
      if (selected.missing.length > 0) {
        host.log(
          'warn',
          `agent selection skipped ${selected.missing.length} missing file(s): ${selected.missing.join(', ')}`,
        );
      }
      onEvent({
        type: 'agent-files',
        enabled: selected.enabled,
        files: selected.files.map((file) => ({
          displayPath: file.displayPath,
          absolutePath: file.path,
          scope: file.scope,
          origin: file.origin,
          bytes: file.bytes,
          truncated: file.truncated,
        })),
        totalBytes: selected.totalBytes,
        skipped: selected.skipped.length,
        available: selected.available,
      });
      host.log(
        'info',
        `agent instructions: ${agentFilesSummary(selected)}` +
          (selected.selection ? ` (${selected.files.length} of ${selected.available} selected)` : '') +
          (selected.skipped.length ? ` (${selected.skipped.length} skipped)` : ''),
      );
      const archiveTools = [ARCHIVE_SEARCH, ARCHIVE_READ].filter((spec) => !this.registry.has(spec.name));
      const toolPolicy = resolveAgentToolPolicy(selected, [...this.registry.specs(), ...archiveTools], new Set(archiveTools.map((spec) => spec.name)));
      const allowedToolNames = new Set(toolPolicy.tools.map((tool) => tool.name));
      if (toolPolicy.restricted) {
        onEvent({ type: 'notice', level: 'info', message: `Selected agent tool policy: ${toolPolicy.tools.map((tool) => tool.name).join(', ') || 'no tools'}.` });
      }
      const system = buildSystemPrompt({
        root: host.workspaceRoot,
        config: this.deps.config,
        tools: toolPolicy.tools,
        diagnostics,
        workspace,
        agentFiles: selected,
      });

      this.lastSystemPrompt = system;

      // Compact both prior history and the current task. Keep the shared pending
      // array so autosave sees exactly the context that will be sent next.
      const historyTarget = (tools: readonly ToolSpec[]): number => {
        const c = this.deps.config;
        const target = c.compaction.contextWindowTokens * Math.min(0.6, c.compaction.threshold * 0.85);
        return Math.max(0, Math.floor((target - Math.max(0, c.maxOutputTokens)) / this.inputCalibration) -
          estimateRequestTokens([{ role: 'system', content: system }], tools));
      };
      const compactTask = async (tools: readonly ToolSpec[]): Promise<boolean> => {
        onEvent({ type: 'notice', message: 'Checking context for LLM compaction; summarization may require an additional provider request.', level: 'info' });
        let compacted: Awaited<ReturnType<typeof compactHistory>>;
        try {
          compacted = await compactHistory([...this.history, ...taskMessages], this.deps.config, this.deps.provider, signal, { targetHistoryTokens: historyTarget(tools) });
        } catch (err) {
          if (err instanceof CompactionCancelled && err.usage) {
            this.cumulativeUsage = mergeUsage(this.cumulativeUsage, err.usage);
            usage = mergeUsage(usage, err.usage);
            onEvent({ type: 'usage', step: steps, usage: err.usage, cumulative: { ...this.cumulativeUsage } });
          }
          throw err;
        }
        const { newHistory, result } = compacted;
        if (result.usage) {
          this.cumulativeUsage = mergeUsage(this.cumulativeUsage, result.usage);
          usage = mergeUsage(usage, result.usage);
          onEvent({ type: 'usage', step: steps, usage: result.usage, cumulative: { ...this.cumulativeUsage } });
        }
        if (!result.compacted) {
          // Retry only after the conversation has grown, not on every step.
          autoCompactRetryAt = this.history.length + taskMessages.length + 2;
          onEvent({ type: 'notice', message: `Could not compact conversation: ${result.summary} Original context was retained.`, level: 'warn' });
          return false;
        }
        this.history = [];
        taskMessages.splice(0, taskMessages.length, ...newHistory);
        const retained = newHistory.length - 1;
        const recentNote = retained < Math.max(2, this.deps.config.compaction.keepLastMessages)
          ? ' Some recent messages were summarized to meet the context budget.' : '';
        onEvent({ type: 'notice', message: `LLM compacted conversation: removed ${result.removedMessages} messages, saved approximately ${result.originalTokens - result.newTokens} tokens.${recentNote}`, level: 'info' });
        host.log('info', `LLM compaction: ${result.originalTokens} -> ${result.newTokens} estimated tokens`);
        return true;
      };

      for (let step = 1; step <= maxSteps; step++) {
        if (signal.aborted) {
          outcome = 'cancelled';
          break;
        }
        steps = step;
        const isFinalStep = step === maxSteps;
        onEvent({ type: 'step', index: step, maxSteps });
        onEvent({ type: 'status', status: 'thinking' });

        /**
         * The exact list handed to the provider for this step. Rebuilt after a
         * mid-task compaction, and repaired so a malformed turn can never make
         * the provider reject the whole request.
         */
        const buildMessages = (): ChatMessage[] => {
          const list: ChatMessage[] = [
            { role: 'system', content: system },
            ...this.history,
            ...taskMessages,
          ];
          if (isFinalStep) {
            list.push({
              role: 'user',
              content: `Step budget reached: ${maxSteps} step(s) used. No further tool calls are available in this task.`,
            });
          }
          return repairToolMessages(list);
        };

        let messages = buildMessages();

        // Reserve room for output and account for the tool definitions actually sent.
        const toolsForStep = isFinalStep ? [] : toolPolicy.tools.filter((spec) =>
          this.registry.has(spec.name) || this.originalConversationSnapshot.length > 0);
        if (!isFinalStep && this.toolOutputCache.size && toolPolicy.tools.length && !this.registry.has(TOOL_OUTPUT_READER.name)) {
          toolsForStep.push(TOOL_OUTPUT_READER);
          allowedToolNames.add(TOOL_OUTPUT_READER.name);
        }
        const contextWindow = this.deps.config.compaction.contextWindowTokens;
        const outputReserve = Math.max(0, this.deps.config.maxOutputTokens);
        const measureContext = () => {
          const input = estimateRequestTokens(messages, toolsForStep);
          const tokens = Math.ceil(input * this.inputCalibration) + outputReserve;
          return { input, tokens, percent: contextWindow > 0 ? (tokens / contextWindow) * 100 : 0 };
        };
        let context = measureContext();
        if (this.deps.config.compaction.enabled && this.deps.config.compaction.autoCompact &&
            this.history.length + taskMessages.length >= autoCompactRetryAt &&
            context.tokens + contextWindow * 0.1 >= contextWindow * this.deps.config.compaction.threshold) {
          if (await compactTask(toolsForStep)) {
            messages = buildMessages();
            context = measureContext();
            if (contextWindow > 0 && context.tokens >= contextWindow * 0.9) {
              onEvent({ type: 'notice', level: 'warn', message: 'Estimated context is still near the limit after compaction. Instructions, tool schemas, images, or retained messages may exceed available space.' });
            }
          }
        }
        let contextTokens = context.tokens;
        let contextPercent = context.percent;
        onEvent({ type: 'context', contextTokens, contextWindow, contextPercent });

        let text = '';
        let calls: ToolCall[] = [];
        let streamed = false;
        let attemptText = '';
        let thinking = '';
        let thinkingStartedAt = 0;
        const streamIdFor = (attempt: number) => (attempt === 1 ? `assistant-${step}` : `assistant-${step}-retry${attempt}`);
        const thinkingIdFor = (attempt: number) => (attempt === 1 ? `thinking-${step}` : `thinking-${step}-retry${attempt}`);
        let streamId = streamIdFor(1);
        let thinkingId = thinkingIdFor(1);
        const showThinking = this.deps.config.showThinking;
        const configuredThinkingLimit = this.deps.config.thinkingMaxChars;
        const thinkingLimit = Number.isFinite(configuredThinkingLimit) && configuredThinkingLimit >= 0
          ? Math.floor(configuredThinkingLimit) : DEFAULT_CONFIG.thinkingMaxChars;
        let thinkingGuard = new ThinkingStreamGuard(thinkingLimit);
        let receivedThinkingDelta = false;
        let completedThinkingDisplayed = false;
        let displayTruncated = false;
        const appendThinkingDisplay = (delta: string): void => {
          if (!showThinking || !this.deps.config.stream || !delta) return;
          const remaining = Math.max(0, MAX_THINKING_DISPLAY_CHARS - thinking.length);
          const displayed = delta.slice(0, remaining);
          if (displayed) {
            thinking += displayed;
            onEvent({ type: 'thinking-delta', id: thinkingId, text: displayed });
          }
          if (delta.length > remaining && !displayTruncated) {
            displayTruncated = true;
            const marker = '\n… [thinking display truncated]';
            thinking += marker;
            onEvent({ type: 'thinking-delta', id: thinkingId, text: marker });
          }
        };
        let callStartedAt = 0;
        let callDurationMs = 0;
        let finishReason: string | undefined;
        const attemptController = new AbortController();
        const abortAttempt = () => attemptController.abort();
        signal.addEventListener('abort', abortAttempt, { once: true });
        if (signal.aborted) abortAttempt();
        let thinkingInterrupted: ThinkingStopReason | undefined;
        try {
          callStartedAt = Date.now();
          const response = await this.callProvider(
            (attempt) => {
              // A retried turn is a fresh stream, so the panel never shows the
              // failed attempt's text twice inside one bubble.
              streamId = streamIdFor(attempt);
              thinkingId = thinkingIdFor(attempt);
              streamed = false;
              attemptText = '';
              this.pendingAssistantText = '';
              thinking = '';
              thinkingStartedAt = 0;
              thinkingGuard = new ThinkingStreamGuard(thinkingLimit);
              receivedThinkingDelta = false;
              completedThinkingDisplayed = false;
              displayTruncated = false;
              return {
                model: this.deps.config.model,
                messages,
                tools: toolsForStep,
                signal: attemptController.signal,
                temperature: this.deps.config.temperature,
                maxTokens: this.deps.config.maxOutputTokens,
                // Streaming keeps the panel alive while the model is still writing.
                onDelta: this.deps.config.stream
                  ? (delta: string) => {
                      if (thinkingInterrupted || signal.aborted) return;
                      streamed = true;
                      attemptText += delta;
                      this.pendingAssistantText = attemptText;
                      onEvent({ type: 'assistant-delta', id: streamId, text: delta });
                    }
                  : undefined,
                // A completed JSON response cannot be aborted retroactively.
                onThinking: this.deps.config.stream
                  ? (delta: string, completed?: boolean) => {
                      if (thinkingInterrupted || signal.aborted) return;
                      if (!thinkingStartedAt) thinkingStartedAt = Date.now();
                      if (completed) {
                        appendThinkingDisplay(delta);
                        completedThinkingDisplayed = true;
                        return;
                      }
                      receivedThinkingDelta = true;
                      const result = thinkingGuard.add(delta);
                      appendThinkingDisplay(result.accepted);
                      if (result.reason) {
                        thinkingInterrupted = result.reason;
                        abortAttempt();
                      }
                    }
                  : undefined,
              };
            },
            onEvent,
            () => {
              // The attempt is being abandoned and retried: close the bubbles it
              // half-rendered, or the panel keeps them marked as still streaming.
              if (thinking.trim() && this.deps.config.stream && showThinking) {
                onEvent({
                  type: 'thinking',
                  id: thinkingId,
                  text: thinking,
                  durationMs: thinkingStartedAt ? Date.now() - thinkingStartedAt : 0,
                });
              }
              if (attemptText || streamed) {
                onEvent({ type: 'assistant', id: streamId, text: attemptText.trim(), final: false, streamed: true });
              }
              this.pendingAssistantText = '';
            },
          );
          if (thinkingInterrupted) throw new Error('Thinking loop interrupted');
          thinkingInterruptions = 0;
          callDurationMs = Date.now() - callStartedAt;
          text = response.text ?? '';
          calls = isFinalStep ? [] : response.toolCalls ?? [];
          finishReason = response.finishReason;
          if (!receivedThinkingDelta && response.thinking) {
            // The provider returned a complete JSON response; do not discard its answer or tools.
            const completedGuard = new ThinkingStreamGuard(0);
            const result = completedGuard.add(response.thinking);
            if (result.reason) {
              const msg = `Possible thinking loop detected in a completed response (${result.reason}); the response was retained.`;
              host.log('warn', msg);
              onEvent({ type: 'notice', message: msg, level: 'warn' });
            }
            if (!completedThinkingDisplayed) appendThinkingDisplay(response.thinking);
          }
          if (response.usage) {
            const reportedInput = response.usage.inputTokens;
            if (typeof reportedInput === 'number' && reportedInput > 0 && context.input > 0) {
              this.inputCalibration = Math.max(this.inputCalibration, reportedInput / context.input);
              contextTokens = reportedInput + outputReserve;
              contextPercent = contextWindow > 0 ? (contextTokens / contextWindow) * 100 : 0;
              onEvent({ type: 'context', contextTokens, contextWindow, contextPercent });
            }
            // Compute tokens per second
            const outputTokens = response.usage.outputTokens ?? estimateTokens(text);
            const tokensPerSecond = callDurationMs > 0 ? (outputTokens / callDurationMs) * 1000 : 0;
            lastTokensPerSecond = tokensPerSecond;

            const usageWithSpeed: Usage = {
              ...response.usage,
              tokensPerSecond,
              durationMs: callDurationMs,
            };

            usage = mergeUsage(usage, response.usage);
            this.cumulativeUsage = mergeUsage(this.cumulativeUsage, response.usage);

            // Emit usage with speed and context
            onEvent({
              type: 'usage',
              step,
              usage: usageWithSpeed,
              durationMs: callDurationMs,
              tokensPerSecond,
              contextTokens,
              contextWindow,
              contextPercent,
              cumulative: { ...this.cumulativeUsage },
            });
          } else {
            // No usage from provider, estimate
            const estimatedOutput = estimateTokens(text);
            const tokensPerSecond = callDurationMs > 0 ? (estimatedOutput / callDurationMs) * 1000 : 0;
            lastTokensPerSecond = tokensPerSecond;
            const estimatedUsage: Usage = {
              outputTokens: estimatedOutput,
              totalTokens: estimatedOutput,
              tokensPerSecond,
              durationMs: callDurationMs,
            };
            usage = mergeUsage(usage, estimatedUsage);
            this.cumulativeUsage = mergeUsage(this.cumulativeUsage, estimatedUsage);
            onEvent({
              type: 'usage',
              step,
              usage: estimatedUsage,
              durationMs: callDurationMs,
              tokensPerSecond,
              contextTokens,
              contextWindow,
              contextPercent,
              cumulative: { ...this.cumulativeUsage },
            });
          }
        } catch (err) {
          if (signal.aborted) {
            outcome = 'cancelled';
            break;
          }
          if (thinkingInterrupted) {
            thinkingInterruptions++;
            if (showThinking && thinking.trim()) {
              onEvent({ type: 'thinking', id: thinkingId, text: thinking, durationMs: thinkingStartedAt ? Date.now() - thinkingStartedAt : 0 });
            }
            if (attemptText || streamed) {
              onEvent({ type: 'assistant', id: streamId, text: attemptText.trim(), final: false, streamed: true });
              if (attemptText.trim()) addMessage({ role: 'assistant', content: attemptText });
            }
            this.pendingAssistantText = '';
            const isBudget = thinkingInterrupted === 'budget';
            const detail = isBudget
              ? `Thinking reached the ${thinkingLimit}-character safety budget (codingHarness.thinkingMaxChars).`
              : `Thinking loop detected (${thinkingInterrupted} repetition).`;
            const message = `${detail} The model stream was interrupted.`;
            host.log('warn', message);
            onEvent({ type: 'notice', message, level: 'warn' });
            if (thinkingInterruptions >= 3 || isFinalStep) {
              errorText = 'Stopped after repeated thinking interruptions. Try a different model or adjust the thinking budget.';
              onEvent({ type: 'notice', message: errorText, level: 'error' });
              outcome = 'error';
              break;
            }
            const interruptionNotice = isBudget
              ? 'Your previous response was interrupted after reaching the thinking length budget.'
              : 'Your previous response was interrupted because your reasoning repeated.';
            addMessage({ role: 'user', content: interruptionNotice });
            continue;
          }
          const providerMessage = (err as Error).message;
          if (!contextOverflowRetried && !attemptText && this.deps.config.compaction.enabled &&
              /context.{0,30}(?:length|window|exceed|limit)|maximum.{0,30}(?:context|tokens)|too many tokens|token limit exceeded|(?:input|prompt).{0,30}too (?:long|large)/i.test(providerMessage)) {
            contextOverflowRetried = true;
            onEvent({ type: 'notice', message: 'Provider rejected the context as too large; attempting LLM compaction and one retry.', level: 'warn' });
            if (await compactTask(toolsForStep)) { step--; continue; }
          }
          errorText = providerMessage;
          host.log('error', `provider error: ${errorText}`);
          onEvent({ type: 'notice', message: `Model call failed: ${errorText}`, level: 'error' });
          outcome = 'error';
          break;
        } finally {
          signal.removeEventListener('abort', abortAttempt);
        }

        // Close the thinking lane for this turn before the answer is shown.
        if (thinking.trim() && this.deps.config.stream && showThinking) {
          onEvent({
            type: 'thinking',
            id: thinkingId,
            text: thinking,
            durationMs: thinkingStartedAt ? Date.now() - thinkingStartedAt : 0,
          });
        }

        const trimmed = text.trim();
        if (trimmed) lastText = trimmed;

        this.pendingAssistantText = '';
        addMessage({
          role: 'assistant',
          content: text,
          toolCalls: calls.length ? calls : undefined,
        });

        if (calls.length === 0) {
          // An answer that hit the output ceiling is not a finished answer:
          // ending the task there is exactly the "it stopped halfway through"
          // report. Keep the partial text and ask the model to carry on.
          if (isTruncated(finishReason) && !isFinalStep && !signal.aborted) {
            if (trimmed || streamed) {
              onEvent({ type: 'assistant', id: streamId, text: trimmed, final: false, streamed });
            }
            onEvent({
              type: 'notice',
              message: `Model output hit the ${this.deps.config.maxOutputTokens}-token limit mid-answer — asking it to continue. Raise codingHarness.maxOutputTokens for longer replies.`,
              level: 'warn',
            });
            addMessage({ role: 'user', content: CONTINUE_AFTER_TRUNCATION });
            continue;
          }

          if (trimmed || streamed) {
            onEvent({ type: 'assistant', id: streamId, text: trimmed, final: true, streamed });
          }
          // On the final step the model is forced to answer in prose, so a
          // prose answer there means the budget ran out rather than "done".
          outcome = isFinalStep ? 'max-steps' : 'complete';
          if (isFinalStep) {
            onEvent({
              type: 'notice',
              message: `Step budget (${maxSteps}) reached — the run ended with a summary. Raise codingHarness.maxSteps for longer tasks.`,
              level: 'warn',
            });
          }
          break;
        }
        if (trimmed || streamed) {
          onEvent({ type: 'assistant', id: streamId, text: trimmed, final: false, streamed });
        }

        onEvent({ type: 'status', status: 'executing' });
        let toolLoopNotice: string | undefined;
        for (const [callIndex, call] of calls.entries()) {
          if (signal.aborted) {
            // Still answer every requested call: a tool call with no result
            // makes the provider reject the *next* request, which would stop
            // the follow-up task before it could do anything.
            addMessage({
              role: 'tool',
              toolCallId: call.id,
              name: call.name,
              content: CANCELLED_TOOL_RESULT,
            });
            continue;
          }
          // Include every pending tool call even while the group is incomplete.
          const current = estimateRequestTokens([{ role: 'system', content: system }, ...this.history, ...taskMessages], toolsForStep) * this.inputCalibration;
          const safeInput = Math.max(0, contextWindow * 0.8 - outputReserve);
          const remaining = Math.max(0, safeInput - current);
          const budget = Math.max(256, Math.min(2048, Math.floor(remaining / this.inputCalibration / Math.max(1, calls.length - callIndex))));
          const result = await this.executeToolCall(call, onEvent, signal, allowedToolNames, budget);
          toolCallsRun++;
          const streak = toolLoop.record(call, result);
          if (streak === 1) toolLoopNotice = undefined;
          if (streak >= 3 && streak % 3 === 0) {
            toolLoopNotice = `Tool loop detected: ${call.name} was called ${streak} times consecutively with the same arguments and returned the same result. Identical output does not prove there were no side effects.`;
            host.log('warn', toolLoopNotice);
            onEvent({ type: 'notice', message: toolLoopNotice, level: 'warn' });
          }
          addMessage({ role: 'tool', toolCallId: call.id, name: call.name,
            content: this.pageToolResult(result.content, budget, onEvent) });
        }

        if (signal.aborted) {
          outcome = 'cancelled';
          break;
        }
        if (toolLoopNotice) {
          addMessage({ role: 'user', content: toolLoopNotice });
        }
      }
    } catch (err) {
      if (signal.aborted) {
        outcome = 'cancelled';
      } else {
        errorText = (err as Error).message;
        host.log('error', `task failed: ${errorText}`);
        onEvent({ type: 'notice', message: `Task failed: ${errorText}`, level: 'error' });
        outcome = 'error';
      }
    } finally {
      this.busy = false;
      this.controller = undefined;
      // If a stream was interrupted before the provider returned, preserve
      // the partial prose that the user already saw for the next follow-up.
      if (this.pendingAssistantText) {
        addMessage({ role: 'assistant', content: this.pendingAssistantText });
      }
      // A run that was cancelled or failed part-way can leave an unanswered
      // tool call behind; repairing here keeps the *next* task runnable
      // instead of shipping the provider a transcript it will refuse.
      this.history = repairToolMessages([...this.history, ...taskMessages]);
      this.originalHistory = [...this.originalHistory, ...originalMessages];
      this.pendingMessages = undefined;
      this.pendingOriginal = undefined;
      this.pendingAssistantText = '';
      this.toolOutputCache.clear();
      this.toolOutputBytes = 0;
    }

    onEvent({ type: 'status', status: 'idle' });
    const filesChanged = this.checkpoints.relativePaths();
    const summary =
      outcome === 'error'
        ? `Failed: ${errorText}`
        : outcome === 'cancelled'
          ? 'Cancelled by the user.'
          : lastText || (outcome === 'max-steps' ? 'Stopped at the step budget.' : 'Done.');

    onEvent({
      type: 'done',
      reason: outcome,
      summary,
      filesChanged,
      usage: this.cumulativeUsage,
      tokensPerSecond: lastTokensPerSecond,
    });
    return {
      outcome,
      summary,
      steps,
      toolCalls: toolCallsRun,
      filesChanged,
      usage: this.cumulativeUsage,
      tokensPerSecond: lastTokensPerSecond,
      contextTokens: this.getContextUsage().tokens,
    };
  }

  /* ------------------------------------------------------------- internals */

  /**
   * Call the model, retrying failures that are worth retrying.
   *
   * A single 429, 5xx or dropped connection used to end the task where it
   * stood, which is indistinguishable from "the agent gave up": the task was
   * left half-finished with nothing but an error in the panel. Transient
   * failures now back off and try again, and only a definitive refusal from the
   * API (bad request, auth, unsupported model) ends the run.
   */
  private async callProvider(
    buildRequest: (attempt: number) => ChatRequest,
    onEvent: (event: HarnessEvent) => void,
    /** Called when the current attempt is thrown away and another one starts. */
    onAttemptDiscarded?: () => void,
  ): Promise<ProviderResponse> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_PROVIDER_ATTEMPTS; attempt++) {
      const request = buildRequest(attempt);
      try {
        return await this.deps.provider.chat(request);
      } catch (err) {
        lastError = err;
        const aborted = request.signal?.aborted ?? false;
        if (aborted || attempt >= MAX_PROVIDER_ATTEMPTS || !isRetryableProviderError(err)) throw err;
        const delay = retryDelayMs(err, attempt);
        const detail = (err as Error).message;
        this.deps.host.log('warn', `provider call failed (attempt ${attempt}/${MAX_PROVIDER_ATTEMPTS}): ${detail}`);
        onEvent({
          type: 'notice',
          level: 'warn',
          message: `Model call failed (${detail}). Retrying in ${(delay / 1000).toFixed(1)}s (attempt ${attempt + 1}/${MAX_PROVIDER_ATTEMPTS})…`,
        });
        onAttemptDiscarded?.();
        await sleep(delay, request.signal);
        if (request.signal?.aborted) throw err;
      }
    }
    throw lastError;
  }

  private async collectDiagnostics(): Promise<string[] | undefined> {
    try {
      const diags = await this.deps.host.getDiagnostics?.();
      if (!diags?.length) return undefined;
      return summarizeDiagnostics(diags);
    } catch {
      return undefined;
    }
  }

  /** Editor facts (open files, version, trust) supplied by the host, if any. */
  private async collectWorkspaceContext(): Promise<WorkspaceContext | undefined> {
    try {
      return await this.deps.host.getWorkspaceContext?.();
    } catch (err) {
      this.deps.host.log('warn', `workspace context unavailable: ${(err as Error).message}`);
      return undefined;
    }
  }

  private pageToolResult(content: string, budget: number, onEvent: (event: HarnessEvent) => void): string {
    const maxBytes = Math.min(MAX_TOOL_RESULT_BYTES, Math.max(128, budget * 3 - 450));
    if (Buffer.byteLength(content, 'utf8') <= maxBytes) return content;
    const { page, next } = utf8Page(content, 0, maxBytes);
    const bytes = Buffer.byteLength(content, 'utf8');
    if (!this.registry.has(TOOL_OUTPUT_READER.name) && this.toolOutputBytes + bytes <= MAX_CACHED_OUTPUT_BYTES) {
      const id = `output-${this.nextOutputId++}`;
      this.toolOutputCache.set(id, content);
      this.toolOutputBytes += bytes;
      onEvent({ type: 'notice', level: 'info', message: `Large tool output paged; ${bytes} bytes cached until this task ends.` });
      return `${page}\n[Partial output; read_tool_output result_id=${id}, next_offset=${next}. Cache expires when this task ends.]`;
    }
    onEvent({ type: 'notice', level: 'warn', message: 'Large tool output exceeded the current budget and could not be cached; the remainder is unavailable.' });
    return `${page}\n[Output truncated; remaining content was not cached and is unavailable.]`;
  }

  private async executeToolCall(
    call: ToolCall,
    onEvent: (event: HarnessEvent) => void,
    signal: AbortSignal,
    allowedTools: ReadonlySet<string>,
    outputTokenBudget: number,
  ): Promise<ToolResult> {
    const started = Date.now();
    const host = this.deps.host;
    onEvent({ type: 'tool-start', id: call.id, name: call.name, args: call.arguments });

    const finish = (result: ToolResult): ToolResult => {
      onEvent({
        type: 'tool-end',
        id: call.id,
        name: call.name,
        ok: result.ok,
        summary: result.summary ?? (result.ok ? 'ok' : 'failed'),
        detail: truncate(result.content, 4000),
        durationMs: Date.now() - started,
        relPath: typeof result.meta?.relPath === 'string' ? (result.meta.relPath as string) : undefined,
      });
      return result;
    };

    if (!allowedTools.has(call.name)) {
      return finish({ ok: false, content: `Tool "${call.name}" is not allowed by the selected agent tool policy or is unavailable.`, summary: 'tool not allowed' });
    }
    const tool = this.registry.get(call.name);
    if (!tool && (call.name === ARCHIVE_SEARCH.name || call.name === ARCHIVE_READ.name)) {
      try {
        const args = parseToolArguments(call.arguments);
        const archive = this.originalConversationSnapshot;
        const coverage = this.originalHistoryComplete ? '' : ' [Earlier history may be incomplete.]';
        if (call.name === ARCHIVE_SEARCH.name) {
          if (typeof args.query !== 'string' || !args.query || args.query.length > 1000) return finish({ ok: false, content: 'query must be a non-empty string of at most 1000 characters.', summary: 'bad query' });
          if (args.case_sensitive !== undefined && typeof args.case_sensitive !== 'boolean') return finish({ ok: false, content: 'case_sensitive must be a boolean.', summary: 'bad arguments' });
          const from = args.start_index === undefined ? 1 : Number(args.start_index);
          const firstOffset = args.start_offset === undefined ? 0 : Number(args.start_offset);
          if (!Number.isInteger(from) || from < 1 || !Number.isInteger(firstOffset) || firstOffset < 0) return finish({ ok: false, content: 'start_index must be positive and start_offset must be non-negative integers.', summary: 'bad index' });
          const query = args.query as string;
          const expression = args.case_sensitive ? undefined : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu');
          const results: string[] = [];
          let nextIndex: number | undefined;
          let nextOffset = 0;
          let scanned = 0;
          let examined = 0;
          // Bound work as well as output. Overlap the boundary by the query
          // length so a literal spanning pages is not missed.
          const scanLimit = 1_000_000;
          for (let i = from - 1; i < archive.length; i++) {
            if (examined++ >= 1000 || scanned >= scanLimit) { nextIndex = i + 1; break; }
            const text = archiveMessageText(archive[i]);
            const offset = i === from - 1 ? firstOffset : 0;
            if (offset > text.length || (offset > 0 && offset < text.length && /[\uD800-\uDBFF]/.test(text[offset - 1]) && /[\uDC00-\uDFFF]/.test(text[offset]))) {
              return finish({ ok: false, content: 'Invalid archive search offset.', summary: 'bad offset' });
            }
            let end = Math.min(text.length, offset + scanLimit - scanned);
            if (end > offset && end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end--;
            const segment = text.slice(offset, Math.min(text.length, end + query.length - 1));
            const local = expression ? (expression.exec(segment)?.index ?? -1) : segment.indexOf(query);
            const position = local < 0 ? -1 : local + offset;
            scanned += end - offset;
            if (position >= offset && position < end) {
              const snippet = text.slice(Math.max(0, position - 60), position + query.length + 100).replace(/[\r\n]+/g, ' ');
              results.push(`message_index=${i + 1} role=${archive[i].role}${archive[i].name ? ` name=${archive[i].name}` : ''} offset=${position}: ${snippet}`);
              if (results.length === 10) { if (i + 1 < archive.length) nextIndex = i + 2; break; }
              // At most one match per message; continue with the next message.
            } else if (end < text.length) {
              nextIndex = i + 1;
              nextOffset = end;
              break;
            }
          }
          const content = `${results.length} matching message(s).${coverage}${nextIndex ? ` next_start_index=${nextIndex} next_start_offset=${nextOffset}` : ''}\n${results.join('\n')}`;
          return finish({ ok: true, content, summary: `${results.length} archived matches` });
        }
        const index = Number(args.message_index);
        if (!Number.isInteger(index) || index < 1 || index > archive.length) return finish({ ok: false, content: 'Invalid archived message_index.', summary: 'bad index' });
        const item = archive[index - 1];
        const text = archiveMessageText(item);
        const offset = args.offset === undefined ? 0 : Number(args.offset);
        if (!Number.isInteger(offset) || offset < 0 || offset > text.length ||
            (offset > 0 && offset < text.length && /[\uD800-\uDBFF]/.test(text[offset - 1]) && /[\uDC00-\uDFFF]/.test(text[offset]))) {
          return finish({ ok: false, content: 'Invalid archive offset.', summary: 'bad offset' });
        }
        const { page, next } = utf8Page(text, offset, Math.max(64, outputTokenBudget * 3 - 800));
        const header = `Archived message ${index} role=${item.role}${item.name ? ` name=${item.name}` : ''}${item.images?.length ? ` images=${item.images.length}` : ''}.${coverage}\n`;
        const suffix = next < text.length ? `\n[next_offset=${next}]` : '\n[End of archived message.]';
        return finish({ ok: true, content: header + page + suffix, summary: 'read archived message' });
      } catch (err) {
        return finish({ ok: false, content: `Invalid archive request: ${(err as Error).message}`, summary: 'bad arguments' });
      }
    }
    if (!tool && call.name === TOOL_OUTPUT_READER.name && this.toolOutputCache.size) {
      try {
        const args = parseToolArguments(call.arguments);
        const text = this.toolOutputCache.get(String(args.result_id ?? ''));
        if (text === undefined) return finish({ ok: false, content: 'Unknown or expired tool output identifier.', summary: 'output unavailable' });
        const offset = args.offset === undefined ? 0 : Number(args.offset);
        if (!Number.isInteger(offset) || offset < 0 || offset > text.length ||
            (offset > 0 && offset < text.length && /[\uD800-\uDBFF]/.test(text[offset - 1]) && /[\uDC00-\uDFFF]/.test(text[offset]))) {
          return finish({ ok: false, content: 'Invalid output offset.', summary: 'bad offset' });
        }
        const { page, next } = utf8Page(text, offset, Math.max(64, outputTokenBudget * 3 - 800));
        const suffix = next < text.length ? `\n[More output: result_id=${args.result_id}, next_offset=${next}; cache expires when this task ends.]` : '\n[End of cached output.]';
        return finish({ ok: true, content: page + suffix, summary: 'read cached tool output' });
      } catch (err) {
        return finish({ ok: false, content: `Invalid cached output request: ${(err as Error).message}`, summary: 'bad arguments' });
      }
    }
    if (!tool) {
      return finish({
        ok: false,
        content: `Unknown tool "${call.name}". Available tools: ${this.registry.names().join(', ')}.`,
        summary: 'unknown tool',
      });
    }

    let args: Record<string, unknown>;
    try {
      args = parseToolArguments(call.arguments);
    } catch (err) {
      return finish({
        ok: false,
        content: `Arguments for "${call.name}" were not valid JSON (${(err as Error).message}). Call it again with a single valid JSON object.`,
        summary: 'bad arguments',
      });
    }

    const context: ToolContext = {
      root: host.workspaceRoot,
      host,
      config: this.deps.config,
      checkpoints: this.checkpoints,
      signal,
      outputTokenBudget,
      approval: async (req: ApprovalRequest): Promise<ApprovalDecision> => {
        onEvent({ type: 'approval', id: call.id, phase: 'request', request: req });
        onEvent({ type: 'status', status: 'approval' });
        let decision: ApprovalDecision = 'reject';
        try {
          decision = await host.requestApproval(req);
        } catch (err) {
          host.log('warn', `approval request failed: ${(err as Error).message}`);
          decision = 'reject';
        }
        onEvent({ type: 'approval', id: call.id, phase: 'resolved', request: req, decision });
        onEvent({ type: 'status', status: 'executing' });
        return decision;
      },
    };

    try {
      return finish(await tool.run(args, context));
    } catch (err) {
      const message = (err as Error).message;
      host.log('error', `tool ${call.name} threw: ${message}`);
      return finish({
        ok: false,
        content: `Tool "${call.name}" failed: ${message}`,
        summary: `error: ${message.slice(0, 80)}`,
      });
    }
  }
}

/** Tolerant JSON parsing for model-produced tool arguments. */
export function parseToolArguments(raw: string): Record<string, unknown> {
  const text = (raw ?? '').trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    if (typeof parsed === 'string') return { value: parsed };
    throw new Error('expected a JSON object');
  } catch (err) {
    // Some models wrap the object in a markdown fence or add prose around it.
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]) as Record<string, unknown>;
      } catch {
        /* fall through */
      }
    }
    throw new Error((err as Error).message);
  }
}

function mergeUsage(a: Usage, b: Usage): Usage {
  const inputTokens = (a.inputTokens ?? 0) + (b.inputTokens ?? 0);
  const outputTokens = (a.outputTokens ?? 0) + (b.outputTokens ?? 0);
  const totalTokens = (a.totalTokens ?? ((a.inputTokens ?? 0) + (a.outputTokens ?? 0))) +
    (b.totalTokens ?? ((b.inputTokens ?? 0) + (b.outputTokens ?? 0)));
  const cachedTokens = (a.cachedTokens ?? 0) + (b.cachedTokens ?? 0);
  return {
    inputTokens: inputTokens || undefined,
    outputTokens: outputTokens || undefined,
    totalTokens: totalTokens || undefined,
    cachedTokens: cachedTokens || undefined,
  };
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [truncated: ${text.length - max} more characters]`;
}

/** True when the provider stopped because the reply ran out of output budget. */
function isTruncated(finishReason: string | undefined): boolean {
  return finishReason === 'length' || finishReason === 'max_tokens';
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}


export function defaultHarnessConfig(): HarnessConfig {
  return DEFAULT_CONFIG;
}
