import type { ChatMessage, ChatRequest, Provider, ProviderResponse, ToolCall } from '../types';

export interface AnthropicProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
}

interface AnthropicBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

interface AnthropicResponse {
  content?: AnthropicBlock[];
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string };
}

/** Anthropic Messages API provider (Claude), with SSE streaming. */
export class AnthropicProvider implements Provider {
  readonly id = 'anthropic';
  readonly label = 'Anthropic';

  constructor(private readonly opts: AnthropicProviderOptions = {}) {}

  private endpoint(): string {
    const raw = (this.opts.baseUrl?.trim() || 'https://api.anthropic.com').replace(/\/+$/, '');
    if (/\/v1\/messages$/.test(raw)) return raw;
    if (/\/v1$/.test(raw)) return `${raw}/messages`;
    return `${raw}/v1/messages`;
  }

  async chat(req: ChatRequest): Promise<ProviderResponse> {
    const streaming = Boolean(req.onDelta);
    const { system, messages } = toAnthropicMessages(req.messages);

    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens ?? 2048,
      temperature: req.temperature,
      messages,
      stream: streaming,
    };
    if (system) body.system = system;
    if (req.tools.length > 0) {
      body.tools = req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }));
    }

    const res = await fetch(this.endpoint(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        ...(this.opts.apiKey ? { 'x-api-key': this.opts.apiKey } : {}),
        ...(this.opts.headers ?? {}),
      },
      body: JSON.stringify(body),
      signal: req.signal,
    });

    if (!res.ok) {
      const raw = await res.text();
      let detail = raw.slice(0, 500);
      try {
        const parsed = JSON.parse(raw) as AnthropicResponse;
        if (parsed.error?.message) detail = parsed.error.message;
      } catch {
        /* keep raw */
      }
      const hint =
        res.status === 401
          ? ' Check the API key (Coding Harness: Set API Key).'
          : res.status === 404
            ? ' Check codingHarness.model and codingHarness.baseUrl.'
            : '';
      throw new Error(`HTTP ${res.status} from ${this.endpoint()}: ${detail}${hint}`);
    }

    const contentType = res.headers.get('content-type') ?? '';
    if (streaming && res.body && /text\/event-stream/i.test(contentType)) {
      return readAnthropicStream(res.body, req.onDelta!, req.signal);
    }

    const raw = await res.text();
    let json: AnthropicResponse;
    try {
      json = JSON.parse(raw) as AnthropicResponse;
    } catch {
      throw new Error(`Anthropic returned non-JSON: ${raw.slice(0, 300)}`);
    }

    const textParts: string[] = [];
    const toolCalls: ToolCall[] = [];
    for (const block of json.content ?? []) {
      if (block.type === 'text' && block.text) textParts.push(block.text);
      if (block.type === 'tool_use' && block.name) {
        toolCalls.push({
          id: block.id ?? `toolu_${toolCalls.length}`,
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
        });
      }
    }
    const text = textParts.join('\n').trim();
    if (text && req.onDelta) req.onDelta(text);

    return {
      text,
      toolCalls,
      finishReason: json.stop_reason,
      usage: json.usage ? { inputTokens: json.usage.input_tokens, outputTokens: json.usage.output_tokens } : undefined,
    };
  }
}

/* --------------------------------------------------------------- streaming */

interface PartialBlock {
  id: string;
  name: string;
  json: string;
}

/**
 * Anthropic streams typed events: `content_block_delta` carries text fragments
 * or partial tool-use JSON, which we reassemble into the usual response shape.
 */
export async function readAnthropicStream(
  body: ReadableStream<Uint8Array>,
  onDelta: (text: string) => void,
  signal?: AbortSignal,
): Promise<ProviderResponse> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const blocks = new Map<number, PartialBlock>();
  let buffer = '';
  let text = '';
  let stopReason: string | undefined;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let errorMessage: string | undefined;

  const handleData = (payload: string): void => {
    const data = payload.trim();
    if (!data) return;
    let event: any;
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }

    switch (event.type) {
      case 'message_start':
        inputTokens = event.message?.usage?.input_tokens ?? inputTokens;
        break;
      case 'content_block_start': {
        const block = event.content_block ?? {};
        if (block.type === 'tool_use') {
          blocks.set(event.index ?? 0, { id: block.id ?? '', name: block.name ?? '', json: '' });
        }
        break;
      }
      case 'content_block_delta': {
        const delta = event.delta ?? {};
        if (delta.type === 'text_delta' && delta.text) {
          text += delta.text;
          onDelta(delta.text);
        } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          const index = event.index ?? 0;
          const entry = blocks.get(index) ?? { id: '', name: '', json: '' };
          entry.json += delta.partial_json;
          blocks.set(index, entry);
        }
        break;
      }
      case 'message_delta':
        stopReason = event.delta?.stop_reason ?? stopReason;
        outputTokens = event.usage?.output_tokens ?? outputTokens;
        break;
      case 'error':
        errorMessage = event.error?.message ?? 'stream error';
        break;
      default:
        break;
    }
  };

  try {
    for (;;) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        // `event:` lines carry the type; the JSON payload we need is on `data:`.
        if (line.startsWith('data:')) handleData(line.slice(5));
        newline = buffer.indexOf('\n');
      }
    }
    if (buffer.startsWith('data:')) handleData(buffer.slice(5));
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
  }

  if (errorMessage) throw new Error(`Anthropic stream error: ${errorMessage}`);

  const toolCalls: ToolCall[] = [...blocks.entries()]
    .sort((a, b) => a[0] - b[0])
    .filter(([, block]) => block.name)
    .map(([index, block]) => ({
      id: block.id || `toolu_${index}`,
      name: block.name,
      arguments: block.json.trim() || '{}',
    }));

  return {
    text,
    toolCalls,
    finishReason: stopReason,
    usage: inputTokens || outputTokens ? { inputTokens, outputTokens } : undefined,
  };
}

/**
 * Anthropic wants the system prompt lifted out of the message list, and every
 * tool result for one assistant turn batched into a single following user turn.
 */
export function toAnthropicMessages(messages: ChatMessage[]): { system: string; messages: unknown[] } {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');

  const out: Array<{ role: 'user' | 'assistant'; content: unknown }> = [];
  let pendingToolResults: Array<Record<string, unknown>> = [];

  const flushToolResults = () => {
    if (pendingToolResults.length === 0) return;
    out.push({ role: 'user', content: pendingToolResults });
    pendingToolResults = [];
  };

  for (const m of messages) {
    if (m.role === 'system') continue;

    if (m.role === 'tool') {
      pendingToolResults.push({
        type: 'tool_result',
        tool_use_id: m.toolCallId,
        content: m.content || '(no output)',
      });
      continue;
    }

    flushToolResults();

    if (m.role === 'assistant') {
      const content: Array<Record<string, unknown>> = [];
      if (m.content) content.push({ type: 'text', text: m.content });
      for (const c of m.toolCalls ?? []) {
        let input: unknown = {};
        try {
          input = JSON.parse(c.arguments || '{}');
        } catch {
          input = { raw: c.arguments };
        }
        content.push({ type: 'tool_use', id: c.id, name: c.name, input });
      }
      if (content.length === 0) continue;
      out.push({ role: 'assistant', content });
      continue;
    }

    out.push({ role: 'user', content: m.content });
  }

  flushToolResults();
  return { system, messages: out };
}
