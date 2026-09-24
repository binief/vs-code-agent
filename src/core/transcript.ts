import type { ChatMessage } from './types';

/**
 * Transcript hygiene for tool-calling models.
 *
 * OpenAI and Anthropic both reject a conversation in which a turn asks for a
 * tool that is never answered, or in which a tool result has no request before
 * it (`messages with role 'tool' must be a response to a preceding message with
 * 'tool_calls'`). Because {@link HarnessSession} keeps its history across tasks,
 * one malformed turn — a cancelled tool batch, a compaction cut through a tool
 * group — used to poison every later model call: the task ended with an HTTP 400
 * before the agent could run a single tool.
 *
 * {@link repairToolMessages} makes such a list valid again instead of throwing
 * the conversation away: unanswered calls are dropped from their assistant turn
 * and orphaned results are dropped from the transcript.
 */

export interface TranscriptAudit {
  /** Tool results that no preceding assistant turn asked for. */
  orphanToolResults: string[];
  /** Tool calls that never got a result. */
  unansweredToolCalls: string[];
}

/** Report the pairing problems in a transcript, without changing it. */
export function auditToolMessages(messages: ChatMessage[]): TranscriptAudit {
  const pending = new Map<string, string>();
  const orphanToolResults: string[] = [];

  for (const message of messages) {
    if (message.role === 'assistant' && message.toolCalls?.length) {
      for (const call of message.toolCalls) pending.set(call.id, call.name);
    } else if (message.role === 'tool') {
      const id = message.toolCallId ?? '';
      if (!id || !pending.has(id)) {
        orphanToolResults.push(id || '(no id)');
      } else {
        pending.delete(id);
      }
    }
  }

  return { orphanToolResults, unansweredToolCalls: [...pending.keys()] };
}

/** True when a provider would accept the transcript as-is. */
export function isTranscriptWellFormed(messages: ChatMessage[]): boolean {
  const { orphanToolResults, unansweredToolCalls } = auditToolMessages(messages);
  return orphanToolResults.length === 0 && unansweredToolCalls.length === 0;
}

/**
 * Return a copy of the transcript in which every tool call has a result and
 * every tool result has a call. Message objects are reused unless they had to
 * change, so callers can still compare snapshots.
 */
export function repairToolMessages(messages: ChatMessage[]): ChatMessage[] {
  const { unansweredToolCalls, orphanToolResults } = auditToolMessages(messages);
  if (unansweredToolCalls.length === 0 && orphanToolResults.length === 0) return messages;

  const unanswered = new Set(unansweredToolCalls);
  const answered = new Set<string>();
  for (const message of messages) {
    if (message.role === 'assistant' && message.toolCalls) {
      for (const call of message.toolCalls) if (!unanswered.has(call.id)) answered.add(call.id);
    }
  }

  const repaired: ChatMessage[] = [];
  for (const message of messages) {
    if (message.role === 'tool') {
      const id = message.toolCallId ?? '';
      if (!id || !answered.has(id)) continue; // no request to answer: drop it
      repaired.push(message);
      continue;
    }

    if (message.role === 'assistant' && message.toolCalls?.length) {
      const kept = message.toolCalls.filter((call) => answered.has(call.id));
      if (kept.length === message.toolCalls.length) {
        repaired.push(message);
        continue;
      }
      // Keep the prose the turn produced; only the orphaned calls go away.
      if (!message.content && kept.length === 0) continue;
      repaired.push({ ...message, toolCalls: kept.length ? kept : undefined });
      continue;
    }

    repaired.push(message);
  }
  return repaired;
}
