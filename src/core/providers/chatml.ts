/**
 * ChatML text-based tool calling protocol for llama.cpp servers started
 * without `--jinja`. Those endpoints reject nonempty `tools` in the API
 * request, so tool definitions, assistant tool calls and tool results are
 * translated into an explicit model-readable text protocol.
 *
 * Protocol markers (never shown to the user as part of assistant output):
 *
 *   <|tool_call|>name|call_id|{"arg": "value"}<|/tool_call|>
 *   <|tool_result|>call_id|ok\n<result text>\n<|/tool_result|>
 *   <|tool_result|>call_id|error\n<error text>\n<|/tool_result|>
 *
 * The system prompt is augmented with the tool catalogue and a short
 * instruction on how to emit calls. The provider strips markers from
 * user-facing text and parses calls back into `ToolCall` objects so the
 * normal agent policy, execution and approval paths stay in control.
 *
 * Reliability is model-dependent: the model must learn to emit the markers
 * correctly, split streaming chunks can break markers, and malformed or
 * truncated calls are never executed. This mode adds prompt tokens for the
 * tool catalogue and protocol instructions.
 */

import type { ToolCall, ToolResult, ToolSpec } from '../types';

export const CHATML_TOOL_CALL_START = '<|tool_call|>';
export const CHATML_TOOL_CALL_END = '<|/tool_call|>';
export const CHATML_TOOL_RESULT_START = '<|tool_result|>';
export const CHATML_TOOL_RESULT_END = '<|/tool_result|>';

/** All markers that must be stripped from user-facing assistant text. */
const ALL_MARKERS = [
  CHATML_TOOL_CALL_START,
  CHATML_TOOL_CALL_END,
  CHATML_TOOL_RESULT_START,
  CHATML_TOOL_RESULT_END,
];

/** Build the system prompt for text mode: original system text plus a tool
 * catalogue and protocol instruction. Returns the augmented system prompt. */
export function buildChatmlSystemPrompt(system: string, tools: ToolSpec[]): string {
  const toolList = tools
    .map((t) => {
      const params = JSON.stringify(t.parameters);
      return `- ${t.name}: ${t.description}. Parameters: ${params}`;
    })
    .join('\n') || '(no tools available)';

  return [
    system,
    '',
    'You have access to the following tools. To call a tool, output exactly:',
    `${CHATML_TOOL_CALL_START}tool_name|call_id|{"arg": "value"}${CHATML_TOOL_CALL_END}`,
    '',
    'Available tools:',
    toolList,
    '',
    'When a tool returns results, incorporate them into your answer.',
    'Do not output protocol markers in your final answer to the user.',
    'Only call tools whose names appear in the list above.',
  ].join('\n');
}

/** Serialize a single `ToolCall` into the text protocol. */
export function serializeToolCall(call: ToolCall): string {
  const args = call.arguments ?? '{}';
  return `${CHATML_TOOL_CALL_START}${call.name}|${call.id}|${args}${CHATML_TOOL_CALL_END}`;
}

/** Serialize a tool result into the text protocol. `ok` selects the status word. */
export function serializeToolResult(callId: string, name: string, ok: boolean, content: string): string {
  const status = ok ? 'ok' : 'error';
  const safeContent = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return `${CHATML_TOOL_RESULT_START}${callId}|${status}\n${safeContent}\n${CHATML_TOOL_RESULT_END}`;
}

/** Parse one complete tool-call block's inner content into a `ToolCall`.
 * Format: `name|call_id|arguments_json`. Returns `null` when unparseable. */
export function parseToolCallBlock(content: string): ToolCall | null {
  const trimmed = content.trim();
  if (!trimmed) return null;

  const firstPipe = trimmed.indexOf('|');
  if (firstPipe === -1) return null;
  const secondPipe = trimmed.indexOf('|', firstPipe + 1);
  if (secondPipe === -1) return null;

  const name = trimmed.slice(0, firstPipe).trim();
  const id = trimmed.slice(firstPipe + 1, secondPipe).trim();
  const args = trimmed.slice(secondPipe + 1).trim();
  if (!name || !id) return null;
  return { id, name, arguments: args || '{}' };
}

/** Parse a full text string, extracting all complete tool-call blocks.
 * Returns the text with all protocol markers removed, plus the tool calls. */
export function parseChatmlText(text: string): { text: string; toolCalls: ToolCall[] } {
  const toolCalls: ToolCall[] = [];
  let clean = '';
  let remaining = text;

  for (;;) {
    const startIdx = remaining.indexOf(CHATML_TOOL_CALL_START);
    if (startIdx === -1) {
      clean += remaining;
      break;
    }
    clean += remaining.slice(0, startIdx);

    const afterStart = startIdx + CHATML_TOOL_CALL_START.length;
    const endIdx = remaining.indexOf(CHATML_TOOL_CALL_END, afterStart);
    if (endIdx === -1) {
      // Incomplete block: no closing marker yet. Keep the rest as-is so a
      // later chunk can complete it (streaming parser handles this instead).
      clean += remaining.slice(startIdx);
      break;
    }

    const block = remaining.slice(afterStart, endIdx);
    const call = parseToolCallBlock(block);
    if (call) toolCalls.push(call);

    remaining = remaining.slice(endIdx + CHATML_TOOL_CALL_END.length);
  }

  return { text: clean, toolCalls };
}

/** Strip any stray protocol markers from text, for display safety. */
export function stripMarkers(text: string): string {
  let out = text;
  for (const marker of ALL_MARKERS) {
    out = out.split(marker).join('');
  }
  return out;
}

/** --------------------------------------------------------------- streaming */

/** Incremental parser for the ChatML tool-call text protocol over SSE deltas.
 *
 * Feeds text fragments as they arrive and returns any fully-formed text and
 * tool calls. Partial markers at the end of a fragment are retained in the
 * internal buffer so a split like `<|tool_c` + `all|>…` is reassembled. Text
 * outside complete tool-call blocks is returned as-is; markers themselves
 * are never emitted as text. Incomplete blocks (start marker seen, no end
 * marker yet) are buffered and not emitted until completed or flushed.
 */
export class ChatmlStreamParser {
  private buffer = '';
  private pendingText = '';
  private readonly toolCalls: ToolCall[] = [];

  /** Feed a fragment of model output. Returns text safe to display and any
   * newly completed tool calls. */
  feed(fragment: string): { text: string; toolCalls: ToolCall[] } {
    this.buffer += fragment;
    const emitted: ToolCall[] = [];
    let text = '';

    for (;;) {
      const startIdx = this.buffer.indexOf(CHATML_TOOL_CALL_START);
      if (startIdx === -1) {
        // No complete start marker. Find the longest suffix that is a prefix
        // of any protocol marker and keep it in the buffer. Emit everything
        // before it as safe plain text. But if the text we'd emit starts with
        // '<' and could itself be the beginning of a marker, keep it too — it
        // may be a partial marker from a previous feed that wasn't completed.
        let bestPartial = '';
        for (const marker of ALL_MARKERS) {
          const partial = longestPrefixSuffix(this.buffer, marker);
          if (partial.length > bestPartial.length) bestPartial = partial;
        }
        const emitLen = this.buffer.length - bestPartial.length;
        const emitText = this.buffer.slice(0, emitLen);
        if (emitText.startsWith('<') &&
            ALL_MARKERS.some((m) => m.startsWith(emitText))) {
          // Conservative: treat emitText as a potential partial marker and
          // keep it in the buffer; emit nothing this round.
          break;
        }
        text += emitText;
        this.buffer = bestPartial;
        break;
      }

      // Everything before the start marker is plain text, unless it looks
      // like a dead partial marker (e.g. a duplicated fragment that wasn't
      // completed). Discard such leading partial-marker text.
      let preText = this.buffer.slice(0, startIdx);
      if (preText.startsWith('<') &&
          ALL_MARKERS.some((m) => m.startsWith(preText))) {
        preText = '';
      }
      text += preText;

      const afterStart = startIdx + CHATML_TOOL_CALL_START.length;
      const rest = this.buffer.slice(afterStart);

      const endIdx = rest.indexOf(CHATML_TOOL_CALL_END);
      if (endIdx === -1) {
        // End marker not (yet) present. Do not parse an incomplete block as a
        // tool call — wait for more data. Retain a possible partial end
        // marker suffix; buffer everything from the start marker onwards.
        const partial = longestPrefixSuffix(rest, CHATML_TOOL_CALL_END);
        this.buffer = CHATML_TOOL_CALL_START + rest.slice(0, rest.length - partial.length) + partial;
        break;
      }

      // Complete block found.
      const block = rest.slice(0, endIdx);
      const call = parseToolCallBlock(block);
      if (call) {
        this.toolCalls.push(call);
        emitted.push(call);
      }

      this.buffer = this.buffer.slice(startIdx + CHATML_TOOL_CALL_START.length + block.length + CHATML_TOOL_CALL_END.length);
    }

    this.pendingText += text;
    return { text: this.flushPendingText(), toolCalls: emitted };
  }

  /** Flush any buffered plain text (incomplete tool-call blocks are retained).
   * Collected tool calls are preserved and remain available via `collected`. */
  flush(): { text: string } {
    const text = this.buffer;
    this.buffer = '';
    return { text: this.stripMarkers(text) };
  }

  /** All tool calls collected so far (complete blocks only). */
  get collected(): ToolCall[] {
    return [...this.toolCalls];
  }

  private flushPendingText(): string {
    const t = this.pendingText;
    this.pendingText = '';
    return t;
  }

  private stripMarkers(text: string): string {
    return stripMarkers(text);
  }
}

/** Longest suffix of `buffer` that is also a prefix of `marker`. */
function longestPrefixSuffix(buffer: string, marker: string): string {
  const max = Math.min(buffer.length, marker.length);
  for (let len = max; len >= 1; len--) {
    const suffix = buffer.slice(buffer.length - len);
    if (marker.startsWith(suffix)) return suffix;
  }
  return '';
}

/** Convert assistant messages with tool calls into plain text for text mode.
 * Tool calls are serialized as protocol blocks; plain text is preserved. */
export function assistantMessageToText(message: { content?: string | null; toolCalls?: ToolCall[] }): string {
  const parts: string[] = [];
  const content = message.content ?? '';
  if (content) parts.push(content);
  for (const call of message.toolCalls ?? []) {
    parts.push(serializeToolCall(call));
  }
  return parts.join('\n');
}

/** Convert a tool result message into plain text for text mode. */
export function toolResultToText(callId: string, name: string, content: string, ok: boolean): string {
  return serializeToolResult(callId, name, ok, content);
}
