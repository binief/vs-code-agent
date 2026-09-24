import type { ChatMessage, HarnessConfig } from './types';

/**
 * Rough token estimation: ~4 chars per token for English text.
 * This is an approximation; actual token counts depend on tokenizer.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export function estimateMessagesTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const m of messages) {
    total += estimateTokens(m.content);
    if (m.toolCalls) {
      for (const tc of m.toolCalls) {
        total += estimateTokens(tc.name) + estimateTokens(tc.arguments);
      }
    }
  }
  return total;
}

export interface CompactionResult {
  compacted: boolean;
  originalTokens: number;
  newTokens: number;
  removedMessages: number;
  summary: string;
}

/**
 * Compact conversation history by summarizing older messages.
 * Keeps the most recent `keepLast` messages intact.
 * Older messages are replaced with a summary.
 *
 * The cut is moved back to the start of a tool-call group so the kept tail can
 * never begin with a tool result whose request was summarised away: OpenAI and
 * Anthropic both reject such a transcript outright, which would end the next
 * task with an HTTP 400 before the model ran a single tool.
 */
export function compactHistory(
  history: ChatMessage[],
  config: HarnessConfig,
): { newHistory: ChatMessage[]; result: CompactionResult } {
  const keepLast = Math.max(2, config.compaction.keepLastMessages);
  const contextWindow = config.compaction.contextWindowTokens;

  if (history.length <= keepLast) {
    return {
      newHistory: history,
      result: {
        compacted: false,
        originalTokens: estimateMessagesTokens(history),
        newTokens: estimateMessagesTokens(history),
        removedMessages: 0,
        summary: 'No compaction needed - history short',
      },
    };
  }

  const originalTokens = estimateMessagesTokens(history);

  let cut = history.length - keepLast;
  while (cut > 0 && history[cut].role === 'tool') cut--;

  // Walking back past every tool result would mean summarising nothing at all.
  if (cut <= 0) {
    return {
      newHistory: history,
      result: {
        compacted: false,
        originalTokens,
        newTokens: originalTokens,
        removedMessages: 0,
        summary: 'No compaction needed - history is one tool-call group',
      },
    };
  }

  const toCompact = history.slice(0, cut);
  const toKeep = history.slice(cut);

  // Build a heuristic summary of the compacted part
  const summaryParts: string[] = [];
  let userMessages = 0;
  let assistantMessages = 0;
  let toolCalls = 0;
  const filesTouched = new Set<string>();

  for (const msg of toCompact) {
    if (msg.role === 'user') userMessages++;
    if (msg.role === 'assistant') {
      assistantMessages++;
      if (msg.toolCalls) toolCalls += msg.toolCalls.length;
    }
    if (msg.role === 'tool' && msg.name) {
      // Try to extract file paths from tool results
      const match = msg.content.match(/["']?([^\s"']+\.[a-z]{1,5})["']?/i);
      if (match) filesTouched.add(match[1]);
    }
  }

  summaryParts.push(`Compacted ${toCompact.length} earlier messages:`);
  summaryParts.push(`- ${userMessages} user message(s), ${assistantMessages} assistant turn(s), ${toolCalls} tool call(s)`);
  if (filesTouched.size > 0) {
    summaryParts.push(`- Files touched: ${Array.from(filesTouched).slice(0, 10).join(', ')}${filesTouched.size > 10 ? '...' : ''}`);
  }

  // Include truncated content of older messages (first 200 chars each, up to 5 messages)
  const preview = toCompact
    .slice(0, 5)
    .map((m) => {
      const role = m.role;
      const snippet = m.content.slice(0, 200).replace(/\n/g, ' ');
      return `${role}: ${snippet}${m.content.length > 200 ? '...' : ''}`;
    })
    .join('\n');

  if (preview) {
    summaryParts.push(`- Preview:\n${preview}`);
  }

  const summaryText = summaryParts.join('\n');

  // The summary is the first message of the new history, so it has to be a
  // *user* turn: Anthropic rejects a conversation that starts with an assistant
  // message, and the model reads it as context it was handed either way.
  const summaryMessage: ChatMessage = {
    role: 'user',
    content: `[Conversation compacted: ${toCompact.length} older messages summarized to save context]\n${summaryText}`,
  };

  const newHistory = [summaryMessage, ...toKeep];
  const newTokens = estimateMessagesTokens(newHistory);

  return {
    newHistory,
    result: {
      compacted: true,
      originalTokens,
      newTokens,
      removedMessages: toCompact.length - 1, // -1 because we add summary
      summary: summaryText,
    },
  };
}

/**
 * Check if compaction should be triggered based on current context usage.
 */
export function shouldCompact(
  messages: ChatMessage[],
  systemPrompt: string,
  config: HarnessConfig,
): { should: boolean; tokens: number; percent: number } {
  const systemTokens = estimateTokens(systemPrompt);
  const historyTokens = estimateMessagesTokens(messages);
  const total = systemTokens + historyTokens;
  const window = config.compaction.contextWindowTokens;
  const percent = window > 0 ? (total / window) * 100 : 0;
  const threshold = config.compaction.threshold * 100;

  return {
    should: config.compaction.enabled && config.compaction.autoCompact && percent >= threshold,
    tokens: total,
    percent,
  };
}
