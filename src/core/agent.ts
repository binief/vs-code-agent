import { agentFilesSummary, discoverAgentFiles, selectAgentFiles } from './agentFiles';
import { CheckpointStore, type RevertReport } from './checkpoints';
import { CompactionCancelled, compactHistory, contextBreakdown, contextBreakdownTotal, estimateMessagesTokens, estimateRequestTokens, estimateTokens } from './compaction';
import { isRetryableProviderError, retryDelayMs } from './providers/errors';
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
 * repeats until the model finishes or the task is cancelled.
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
  /** Most recently resolved task policy; undefined means the estimate is provisional. */
  private lastAllowedTools?: ToolSpec[];

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
    this.lastSystemPrompt = '';
    this.lastAllowedTools = undefined;
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
    this.lastAllowedTools = undefined;
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
    this.lastAllowedTools = undefined;
  }

  cancel(): void {
    this.controller?.abort();
  }

  /** Undo every file change made since the current/last `runTask` started. */
  async revertLastTask(): Promise<RevertReport> {
    return this.checkpoints.revertAll();
  }

  private toolsForEstimate(): ToolSpec[] {
    return this.lastAllowedTools ?? [];
  }

  /** Estimate current context usage */
  getContextUsage(systemPrompt?: string): { tokens: number; window: number; percent: number; breakdown: import('./types').ContextBreakdown } {
    const system = systemPrompt ?? this.lastSystemPrompt;
    const messages: ChatMessage[] = system ? [{ role: 'system', content: system }, ...this.history] : [...this.history];
    const breakdown = contextBreakdown(messages, this.toolsForEstimate(), this.deps.config.maxOutputTokens, this.inputCalibration, undefined, this.lastAllowedTools !== undefined);
    const total = contextBreakdownTotal(breakdown);
    const window = this.deps.config.compaction.contextWindowTokens;
    const percent = window > 0 ? (total / window) * 100 : 0;
    return { tokens: total, window, percent, breakdown };
  }

  /** Manually compact conversation history using the configured provider. */
  async compact(): Promise<{ compacted: boolean; originalTokens: number; newTokens: number; removed: number; reason: string; strategy?: 'llm'; targetMet?: boolean }> {
    if (this.busy) throw new Error('Cannot compact while a task is running.');
    this.busy = true;
    this.controller = new AbortController();
    try {
      const c = this.deps.config;
      const target = Math.max(0, Math.floor((c.compaction.contextWindowTokens * Math.min(0.6, c.compaction.threshold * 0.85) - Math.max(0, c.maxOutputTokens)) / this.inputCalibration) -
        estimateRequestTokens(this.lastSystemPrompt ? [{ role: 'system', content: this.lastSystemPrompt }] : [], this.toolsForEstimate()));
      const latestUser = [...this.history].reverse().find((message) => message.role === 'user');
      const { newHistory, result } = await compactHistory(this.history, c, this.deps.provider, this.controller.signal, { targetHistoryTokens: target, preserveUserMessage: latestUser });
      if (result.usage) this.cumulativeUsage = mergeUsage(this.cumulativeUsage, result.usage);
      if (result.compacted) this.history = newHistory;
      return { compacted: result.compacted, originalTokens: result.originalTokens, newTokens: result.newTokens, removed: result.removedMessages, reason: result.summary, strategy: result.strategy, targetMet: result.targetMet };
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
    this.controller = new AbortController();
    const signal = this.controller.signal;
    this.lastSystemPrompt = '';
    this.lastAllowedTools = undefined;
    const host = this.deps.host;

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
      const toolPolicy = resolveAgentToolPolicy(selected, this.registry.specs());
      const allowedToolNames = new Set(toolPolicy.tools.map((tool) => tool.name));
      this.lastAllowedTools = toolPolicy.tools;
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
      const compactTask = async (tools: readonly ToolSpec[], providerOverflow = false): Promise<boolean> => {
        onEvent({ type: 'notice', message: 'Checking context for LLM compaction.', level: 'info' });
        let compacted: Awaited<ReturnType<typeof compactHistory>>;
        try {
          const active = [...this.history, ...taskMessages];
          // An endpoint rejection is evidence that our configured estimate is
          // too optimistic. Request a material reduction even for short chats.
          const target = providerOverflow ? Math.min(historyTarget(tools), Math.floor(estimateMessagesTokens(active) * 0.5)) : historyTarget(tools);
          compacted = await compactHistory(active, this.deps.config, this.deps.provider, signal, { targetHistoryTokens: target, preserveUserMessage: userMessage });
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
        const targetNote = result.targetMet === false ? ' The estimated target was not met; fixed context or images may still exceed the window.' : '';
        onEvent({ type: 'notice', message: `LLM compacted conversation: removed ${result.removedMessages} messages, saved approximately ${result.originalTokens - result.newTokens} tokens.${targetNote}`, level: result.targetMet === false ? 'warn' : 'info' });
        host.log('info', `LLM compaction: ${result.originalTokens} -> ${result.newTokens} estimated tokens`);
        return true;
      };

      for (let step = 1; ; step++) {
        if (signal.aborted) {
          outcome = 'cancelled';
          break;
        }
        steps = step;
        onEvent({ type: 'step', index: step, maxSteps: 0 });
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
          return repairToolMessages(list);
        };

        let messages = buildMessages();

        // Reserve room for output and account for the tool definitions actually sent.
        const toolsForStep = toolPolicy.tools;
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
          if (this.history.length === 0 && taskMessages.length === 1) {
            autoCompactRetryAt = 3;
            onEvent({ type: 'notice', level: 'warn', message: `Estimated context is already high before there is older history to compact. System context, tool schemas, images and the ${outputReserve}-token output reserve all count. Check Max Output Tokens and the configured model window.` });
          } else if (await compactTask(toolsForStep)) {
            messages = buildMessages();
            context = measureContext();
            if (contextWindow > 0 && context.tokens >= contextWindow * 0.9) {
              onEvent({ type: 'notice', level: 'warn', message: 'Estimated context is still near the limit after compaction. Instructions, tool schemas, images, or retained messages may exceed available space.' });
            }
          }
        }
        let contextTokens = context.tokens;
        let contextPercent = context.percent;
        onEvent({ type: 'context', contextTokens, contextWindow, contextPercent, breakdown: contextBreakdown(messages, toolsForStep, outputReserve, this.inputCalibration) });

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
                      if (signal.aborted) return;
                      streamed = true;
                      attemptText += delta;
                      this.pendingAssistantText = attemptText;
                      onEvent({ type: 'assistant-delta', id: streamId, text: delta });
                    }
                  : undefined,
                // A completed JSON response cannot be aborted retroactively.
                onThinking: this.deps.config.stream
                  ? (delta: string, completed?: boolean) => {
                      if (signal.aborted) return;
                      if (!thinkingStartedAt) thinkingStartedAt = Date.now();
                      if (completed) {
                        appendThinkingDisplay(delta);
                        completedThinkingDisplayed = true;
                        return;
                      }
                      receivedThinkingDelta = true;
                      appendThinkingDisplay(delta);
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
          callDurationMs = Date.now() - callStartedAt;
          text = response.text ?? '';
          calls = response.toolCalls ?? [];
          finishReason = response.finishReason;
          if (!receivedThinkingDelta && response.thinking) {
            // The provider returned a complete JSON response; do not discard its answer or tools.
            if (!completedThinkingDisplayed) appendThinkingDisplay(response.thinking);
          }
          if (response.usage) {
            const reportedInput = response.usage.inputTokens;
            if (typeof reportedInput === 'number' && reportedInput > 0 && context.input > 0) {
              this.inputCalibration = Math.max(this.inputCalibration, reportedInput / context.input);
              contextTokens = reportedInput + outputReserve;
              contextPercent = contextWindow > 0 ? (contextTokens / contextWindow) * 100 : 0;
              onEvent({ type: 'context', contextTokens, contextWindow, contextPercent, breakdown: contextBreakdown(messages, toolsForStep, outputReserve, this.inputCalibration, reportedInput) });
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
          const providerMessage = (err as Error).message;
          if (!contextOverflowRetried && !attemptText && this.deps.config.compaction.enabled &&
              /context.{0,30}(?:length|window|exceed|limit)|maximum.{0,30}(?:context|tokens)|too many tokens|token limit exceeded|(?:input|prompt).{0,30}too (?:long|large)/i.test(providerMessage)) {
            contextOverflowRetried = true;
            onEvent({ type: 'notice', message: 'Provider rejected the context as too large; attempting LLM compaction and one retry.', level: 'warn' });
            if (await compactTask(toolsForStep, true)) { step--; continue; }
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
          if (isTruncated(finishReason) && !signal.aborted) {
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
          outcome = 'complete';
          break;
        }
        if (trimmed || streamed) {
          onEvent({ type: 'assistant', id: streamId, text: trimmed, final: false, streamed });
        }

        onEvent({ type: 'status', status: 'executing' });
        for (const call of calls) {
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
          const result = await this.executeToolCall(call, onEvent, signal, allowedToolNames, 2048);
          toolCallsRun++;
          addMessage({ role: 'tool', toolCallId: call.id, name: call.name,
            content: result.content });
        }

        if (signal.aborted) {
          outcome = 'cancelled';
          break;
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
    }

    onEvent({ type: 'status', status: 'idle' });
    const filesChanged = this.checkpoints.relativePaths();
    const summary =
      outcome === 'error'
        ? `Failed: ${errorText}`
        : outcome === 'cancelled'
          ? 'Cancelled by the user.'
          : lastText || 'Done.';

    onEvent({
      type: 'done',
      reason: outcome,
      summary,
      filesChanged,
      usage: this.cumulativeUsage,
      tokensPerSecond: lastTokensPerSecond,
    });
    const contextUsage = this.getContextUsage();
    onEvent({ type: 'context', contextTokens: contextUsage.tokens, contextWindow: contextUsage.window, contextPercent: contextUsage.percent, breakdown: contextUsage.breakdown });
    return {
      outcome,
      summary,
      steps,
      toolCalls: toolCallsRun,
      filesChanged,
      usage: this.cumulativeUsage,
      tokensPerSecond: lastTokensPerSecond,
      contextTokens: contextUsage.tokens,
      contextBreakdown: contextUsage.breakdown,
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

    if (signal.aborted) return finish({ ok: false, content: CANCELLED_TOOL_RESULT, summary: 'cancelled' });
    if (!allowedTools.has(call.name)) {
      return finish({ ok: false, content: `Tool "${call.name}" is not allowed by the selected agent tool policy or is unavailable.`, summary: 'tool not allowed' });
    }
    const tool = this.registry.get(call.name);
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

    if (createDefaultTools().includes(tool)) {
      const issue = validateBuiltinArguments(tool.parameters, args);
      if (issue) return finish({ ok: false, content: `Invalid arguments for "${call.name}": ${issue} No tool was run.`, summary: 'bad arguments' });
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

/** Shallow, non-coercing checks for built-ins; custom and MCP schemas remain untouched. */
function validateBuiltinArguments(schema: import('./types').JsonSchema, args: Record<string, unknown>): string | undefined {
  for (const field of schema.required ?? []) {
    if (!Object.prototype.hasOwnProperty.call(args, field) || args[field] === undefined || args[field] === null) return `required field "${field}" is missing.`;
  }
  for (const [name, spec] of Object.entries(schema.properties ?? {})) {
    const value = args[name];
    if (value === undefined || value === null || !spec.type) continue;
    const valid = spec.type === 'array' ? Array.isArray(value) : spec.type === 'object' ? typeof value === 'object' && !Array.isArray(value) :
      spec.type === 'integer' ? typeof value === 'number' && Number.isInteger(value) : typeof value === spec.type;
    if (!valid) return `field "${name}" must be ${spec.type}.`;
    if (spec.enum && !spec.enum.includes(value)) return `field "${name}" must be one of ${spec.enum.map(String).join(', ')}.`;
  }
  return undefined;
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
