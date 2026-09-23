import { CheckpointStore, type RevertReport } from './checkpoints';
import { compactHistory, estimateMessagesTokens, estimateTokens, shouldCompact } from './compaction';
import { buildSystemPrompt, summarizeDiagnostics } from './prompt';
import { createDefaultTools, ToolRegistry } from './tools';
import {
  DEFAULT_CONFIG,
  type ApprovalDecision,
  type ApprovalRequest,
  type ChatMessage,
  type HarnessConfig,
  type HarnessEvent,
  type HarnessHost,
  type Provider,
  type TaskOutcome,
  type TaskResult,
  type ToolCall,
  type ToolContext,
  type ToolResult,
  type Usage,
} from './types';

export interface AgentDeps {
  host: HarnessHost;
  config: HarnessConfig;
  provider: Provider;
  registry?: ToolRegistry;
  /** Replace the tool set entirely (used by tests and embedders). */
  tools?: ToolRegistry;
  checkpoints?: CheckpointStore;
}

const MAX_TOOL_RESULT_CHARS = 30_000;
const MAX_HISTORY_MESSAGES = 48;
const MAX_HISTORY_CHARS = 140_000;

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
  private controller?: AbortController;
  private busy = false;
  private cumulativeUsage: Usage = {};

  constructor(private deps: AgentDeps) {
    this.registry = deps.registry ?? deps.tools ?? new ToolRegistry(createDefaultTools());
    this.checkpoints = deps.checkpoints ?? new CheckpointStore(true);
  }

  get toolNames(): string[] {
    return this.registry.names();
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

  updateConfig(config: HarnessConfig): void {
    this.deps.config = config;
  }

  /** Swap the model backend (settings changed, or a different key was added). */
  setProvider(provider: Provider): void {
    this.deps.provider = provider;
  }

  get providerLabel(): string {
    return this.deps.provider.label;
  }

  reset(): void {
    this.history = [];
    this.checkpoints.clear();
    this.cumulativeUsage = {};
  }

  cancel(): void {
    this.controller?.abort();
  }

  /** Undo every file change made since the current/last `runTask` started. */
  async revertLastTask(): Promise<RevertReport> {
    return this.checkpoints.revertAll();
  }

  /** Estimate current context usage */
  getContextUsage(systemPrompt?: string): { tokens: number; window: number; percent: number } {
    const sysTokens = systemPrompt ? estimateTokens(systemPrompt) : 0;
    const histTokens = estimateMessagesTokens(this.history);
    const total = sysTokens + histTokens;
    const window = this.deps.config.compaction.contextWindowTokens;
    const percent = window > 0 ? (total / window) * 100 : 0;
    return { tokens: total, window, percent };
  }

  /** Manually compact the conversation history */
  compact(): { compacted: boolean; originalTokens: number; newTokens: number; removed: number } {
    const { newHistory, result } = compactHistory(this.history, this.deps.config);
    if (result.compacted) {
      this.history = newHistory;
    }
    return {
      compacted: result.compacted,
      originalTokens: result.originalTokens,
      newTokens: result.newTokens,
      removed: result.removedMessages,
    };
  }

  async runTask(prompt: string, onEvent: (event: HarnessEvent) => void): Promise<TaskResult> {
    if (this.busy) throw new Error('A task is already running.');
    this.busy = true;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    const host = this.deps.host;
    const maxSteps = Math.max(1, this.deps.config.maxSteps);

    const userMessage: ChatMessage = { role: 'user', content: prompt.trim() };
    /** Everything produced during this task, appended to history when it ends. */
    const taskMessages: ChatMessage[] = [userMessage];
    this.checkpoints.begin(userMessage.content.slice(0, 80));
    onEvent({ type: 'status', status: 'thinking' });

    let steps = 0;
    let toolCallsRun = 0;
    let usage: Usage = { ...this.cumulativeUsage };
    let outcome: TaskOutcome = 'complete';
    let lastText = '';
    let errorText = '';
    let lastTokensPerSecond = 0;

    try {
      const diagnostics = this.deps.config.includeDiagnosticsInPrompt ? await this.collectDiagnostics() : undefined;
      const system = buildSystemPrompt({
        root: host.workspaceRoot,
        config: this.deps.config,
        tools: this.registry.specs(),
        diagnostics,
      });

      // Check if we should compact before starting
      if (this.deps.config.compaction.enabled && this.deps.config.compaction.autoCompact) {
        const check = shouldCompact([...this.history, ...taskMessages], system, this.deps.config);
        onEvent({
          type: 'context',
          contextTokens: check.tokens,
          contextWindow: this.deps.config.compaction.contextWindowTokens,
          contextPercent: check.percent,
        });
        if (check.should) {
          const { newHistory, result } = compactHistory(this.history, this.deps.config);
          if (result.compacted) {
            this.history = newHistory;
            onEvent({
              type: 'notice',
              message: `Compacted conversation: removed ${result.removedMessages} old messages, freed ${result.originalTokens - result.newTokens} tokens (${Math.round((result.newTokens / this.deps.config.compaction.contextWindowTokens) * 100)}% context now).`,
              level: 'info',
            });
            host.log('info', `auto-compacted: ${result.originalTokens} -> ${result.newTokens} tokens`);
          }
        }
      }

      for (let step = 1; step <= maxSteps; step++) {
        if (signal.aborted) {
          outcome = 'cancelled';
          break;
        }
        steps = step;
        const isFinalStep = step === maxSteps;
        onEvent({ type: 'step', index: step, maxSteps });
        onEvent({ type: 'status', status: 'thinking' });

        const messages: ChatMessage[] = [
          { role: 'system', content: system },
          ...this.history,
          ...taskMessages,
        ];

        // Estimate context usage for this step
        const contextTokens = estimateMessagesTokens(messages) + estimateTokens(system);
        const contextWindow = this.deps.config.compaction.contextWindowTokens;
        const contextPercent = contextWindow > 0 ? (contextTokens / contextWindow) * 100 : 0;
        onEvent({
          type: 'context',
          contextTokens,
          contextWindow,
          contextPercent,
        });

        // Auto-compact if we're approaching limit mid-task
        if (
          this.deps.config.compaction.enabled &&
          this.deps.config.compaction.autoCompact &&
          contextPercent >= this.deps.config.compaction.threshold * 100 &&
          this.history.length > this.deps.config.compaction.keepLastMessages
        ) {
          const { newHistory, result } = compactHistory(this.history, this.deps.config);
          if (result.compacted) {
            this.history = newHistory;
            onEvent({
              type: 'notice',
              message: `Auto-compacted during task: freed ${result.originalTokens - result.newTokens} tokens. Context now ${Math.round((estimateMessagesTokens([...this.history, ...taskMessages]) / contextWindow) * 100)}%.`,
              level: 'warn',
            });
            // Rebuild messages with compacted history
            messages.splice(1, this.history.length, ...this.history);
          }
        }

        if (isFinalStep) {
          messages.push({
            role: 'user',
            content:
              'Step budget reached: reply now WITHOUT calling any tools. Summarise what you changed, how it was verified, and what is still left to do.',
          });
        }

        let text = '';
        let calls: ToolCall[] = [];
        let streamed = false;
        let thinking = '';
        let thinkingStartedAt = 0;
        const streamId = `assistant-${step}`;
        const thinkingId = `thinking-${step}`;
        const showThinking = this.deps.config.showThinking;
        let callStartedAt = 0;
        let callDurationMs = 0;
        try {
          callStartedAt = Date.now();
          const response = await this.deps.provider.chat({
            model: this.deps.config.model,
            messages,
            tools: isFinalStep ? [] : this.registry.specs(),
            signal,
            temperature: this.deps.config.temperature,
            maxTokens: this.deps.config.maxOutputTokens,
            // Streaming keeps the panel alive while the model is still writing.
            onDelta: this.deps.config.stream
              ? (delta: string) => {
                  streamed = true;
                  onEvent({ type: 'assistant-delta', id: streamId, text: delta });
                }
              : undefined,
            // The reasoning lane: shown, never echoed back to the model.
            onThinking:
              this.deps.config.stream && showThinking
                ? (delta: string) => {
                    if (!thinkingStartedAt) thinkingStartedAt = Date.now();
                    thinking += delta;
                    onEvent({ type: 'thinking-delta', id: thinkingId, text: delta });
                  }
                : undefined,
          });
          callDurationMs = Date.now() - callStartedAt;
          text = response.text ?? '';
          calls = isFinalStep ? [] : response.toolCalls ?? [];
          if (!thinking && response.thinking) thinking = response.thinking;
          if (response.usage) {
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
          errorText = (err as Error).message;
          host.log('error', `provider error: ${errorText}`);
          onEvent({ type: 'notice', message: `Model call failed: ${errorText}`, level: 'error' });
          outcome = 'error';
          break;
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

        taskMessages.push({
          role: 'assistant',
          content: text,
          toolCalls: calls.length ? calls : undefined,
        });

        if (calls.length === 0) {
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
        for (const call of calls) {
          if (signal.aborted) break;
          const result = await this.executeToolCall(call, onEvent, signal);
          toolCallsRun++;
          taskMessages.push({
            role: 'tool',
            toolCallId: call.id,
            name: call.name,
            content: truncate(result.content, MAX_TOOL_RESULT_CHARS),
          });
        }

        if (signal.aborted) {
          outcome = 'cancelled';
          break;
        }
      }
    } catch (err) {
      errorText = (err as Error).message;
      host.log('error', `task failed: ${errorText}`);
      onEvent({ type: 'notice', message: `Task failed: ${errorText}`, level: 'error' });
      outcome = 'error';
    } finally {
      this.busy = false;
      this.controller = undefined;
      this.history = trimHistory([...this.history, ...taskMessages]);
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
      contextTokens: estimateMessagesTokens(this.history),
    };
  }

  /* ------------------------------------------------------------- internals */

  private async collectDiagnostics(): Promise<string[] | undefined> {
    try {
      const diags = await this.deps.host.getDiagnostics?.();
      if (!diags?.length) return undefined;
      return summarizeDiagnostics(diags);
    } catch {
      return undefined;
    }
  }

  private async executeToolCall(
    call: ToolCall,
    onEvent: (event: HarnessEvent) => void,
    signal: AbortSignal,
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

    const context: ToolContext = {
      root: host.workspaceRoot,
      host,
      config: this.deps.config,
      checkpoints: this.checkpoints,
      signal,
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
  const totalTokens = (a.totalTokens ?? 0) + (b.totalTokens ?? 0) || inputTokens + outputTokens;
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

/** Keep the tail of the conversation, never starting on an orphaned tool result. */
function trimHistory(history: ChatMessage[]): ChatMessage[] {
  let out = history;
  if (out.length > MAX_HISTORY_MESSAGES) {
    let drop = out.length - MAX_HISTORY_MESSAGES;
    while (drop < out.length && out[drop].role === 'tool') drop++;
    out = out.slice(drop);
  }
  let chars = out.reduce((sum, m) => sum + m.content.length + 64, 0);
  while (out.length > 2 && chars > MAX_HISTORY_CHARS) {
    const removed = out.shift()!;
    chars -= removed.content.length + 64;
    while (out.length > 0 && out[0].role === 'tool') {
      const extra = out.shift()!;
      chars -= extra.content.length + 64;
    }
  }
  return out;
}

export function defaultHarnessConfig(): HarnessConfig {
  return DEFAULT_CONFIG;
}
