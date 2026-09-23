import {
  DEFAULT_CONFIG,
  type ChatMessage,
  type ChatRequest,
  type Provider,
  type ProviderResponse,
  type ToolCall,
  type Usage,
} from '../types';

export interface OpenAiProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  /** Extra headers (e.g. OpenRouter's HTTP-Referer, or a gateway auth header). */
  headers?: Record<string, string>;
}

interface OpenAiToolCallPayload {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAiChoice {
  message?: {
    content?: OpenAiContent;
    tool_calls?: OpenAiToolCallPayload[];
    reasoning_content?: string | null;
    reasoning?: string | null;
  } | null;
  delta?: {
    content?: OpenAiContent;
    tool_calls?: OpenAiToolCallPayload[];
    /** DeepSeek-R1, vLLM and friends. */
    reasoning_content?: string | null;
    /** OpenRouter and some gateways. */
    reasoning?: string | null;
  } | null;
  finish_reason?: string | null;
}

type OpenAiContent = string | Array<{ type?: string; text?: string }> | null | undefined;

interface OpenAiResponse {
  choices?: OpenAiChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  error?: { message?: string; type?: string };
}

/** Models that reject `max_tokens` in favour of `max_completion_tokens`. */
const NEW_STYLE_TOKEN_LIMIT = /^(o[1-9]|gpt-5|gpt-4\.5)/i;

/**
 * Works with any OpenAI-compatible `/chat/completions` endpoint: OpenAI,
 * OpenRouter, Groq, Together, Fireworks, DeepSeek, xAI, vLLM, Ollama,
 * LM Studio, llama.cpp server, \u2026
 *
 * Streams via server-sent events whenever the caller passes `onDelta`. If the
 * endpoint answers with plain JSON anyway (some proxies ignore `stream`), the
 * response is parsed in one piece instead of failing.
 */
export class OpenAiCompatibleProvider implements Provider {
  readonly id = 'openai';
  readonly label = 'OpenAI-compatible';

  constructor(private readonly opts: OpenAiProviderOptions = {}) {}

  private endpoint(): string {
    const raw = (this.opts.baseUrl?.trim() || DEFAULT_CONFIG.baseUrl!).replace(/\/+$/, '');
    if (/\/chat\/completions$/.test(raw)) return raw;
    return `${raw}/chat/completions`;
  }

  private authHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(this.opts.headers ?? {}) };
    const key = this.opts.apiKey?.trim();
    if (key) headers.Authorization = `Bearer ${key}`;
    return headers;
  }

  async chat(req: ChatRequest): Promise<ProviderResponse> {
    const streaming = Boolean(req.onDelta);

    const body: Record<string, unknown> = {
      model: req.model,
      messages: toOpenAiMessages(req.messages),
      temperature: req.temperature,
      stream: streaming,
    };
    if (NEW_STYLE_TOKEN_LIMIT.test(req.model)) body.max_completion_tokens = req.maxTokens;
    else body.max_tokens = req.maxTokens;
    if (req.tools.length > 0) {
      body.tools = req.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      body.tool_choice = 'auto';
      body.parallel_tool_calls = true;
    }

    const res = await fetch(this.endpoint(), {
      method: 'POST',
      headers: this.authHeaders(),
      body: JSON.stringify(body),
      signal: req.signal,
    });

    if (!res.ok) {
      const raw = await res.text();
      throw new Error(describeHttpError(res.status, raw, this.endpoint()));
    }

    const contentType = res.headers.get('content-type') ?? '';
    if (streaming && res.body && /text\/event-stream/i.test(contentType)) {
      return readOpenAiStream(res.body, req.onDelta!, req.signal, req.onThinking);
    }

    // Non-streaming fallback (or an endpoint that ignored `stream: true`).
    const raw = await res.text();
    let json: OpenAiResponse;
    try {
      json = JSON.parse(raw) as OpenAiResponse;
    } catch {
      throw new Error(`Provider returned non-JSON response: ${raw.slice(0, 300)}`);
    }
    if (json.error?.message) throw new Error(`Provider error: ${json.error.message}`);

    const choice = json.choices?.[0];
    const message = choice?.message ?? {};
    const text = normalizeContent(message.content);
    const thinking = reasoningOf(message);

    // An endpoint that ignored `stream` still has to feed the UI something.
    if (thinking && req.onThinking) req.onThinking(thinking);
    if (text && req.onDelta) req.onDelta(text);

    return {
      text,
      toolCalls: collectToolCalls(message.tool_calls),
      finishReason: choice?.finish_reason ?? undefined,
      usage: normalizeUsage(json.usage),
      thinking: thinking || undefined,
    };
  }
}

/* --------------------------------------------------------------- streaming */

interface PartialToolCall {
  id: string;
  name: string;
  args: string;
}

/** Parses an OpenAI-style SSE stream into text deltas plus assembled tool calls. */
export async function readOpenAiStream(
  body: ReadableStream<Uint8Array>,
  onDelta: (text: string) => void,
  signal?: AbortSignal,
  onThinking?: (text: string) => void,
): Promise<ProviderResponse> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const partials = new Map<number, PartialToolCall>();
  let buffer = '';
  let text = '';
  let thinking = '';
  let finishReason: string | undefined;
  let usage: Usage | undefined;
  let errorMessage: string | undefined;

  const handleData = (payload: string): void => {
    const data = payload.trim();
    if (!data || data === '[DONE]') return;
    let json: OpenAiResponse & { error?: { message?: string } };
    try {
      json = JSON.parse(data) as OpenAiResponse;
    } catch {
      return; // keep-alive comment or partial line: ignore
    }
    if (json.error?.message) {
      errorMessage = json.error.message;
      return;
    }
    if (json.usage) usage = normalizeUsage(json.usage);

    const choice = json.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;

    const delta = choice.delta ?? choice.message ?? {};

    // Reasoning arrives on its own field stream, before the answer text.
    const reason = reasoningOf(delta);
    if (reason) {
      thinking += reason;
      onThinking?.(reason);
    }

    const piece = normalizeContent(delta.content);
    if (piece) {
      text += piece;
      onDelta(piece);
    }

    for (const part of delta.tool_calls ?? []) {
      if (!part) continue;
      const index = typeof part.index === 'number' ? part.index : 0;
      const entry = partials.get(index) ?? { id: '', name: '', args: '' };
      if (part.id) entry.id = part.id;
      // Name and arguments can both arrive split across chunks; append them.
      if (part.function?.name) entry.name += part.function.name;
      if (part.function?.arguments) entry.args += part.function.arguments;
      partials.set(index, entry);
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
        if (line.startsWith('data:')) handleData(line.slice(5));
        newline = buffer.indexOf('\n');
      }
    }
    // Flush a trailing chunk that arrived without a newline.
    if (buffer.startsWith('data:')) handleData(buffer.slice(5));
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* stream already closed */
    }
  }

  if (errorMessage) throw new Error(`Provider error: ${errorMessage}`);

  return {
    text,
    toolCalls: [...partials.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([index, part]) => ({
        id: part.id || `call_${index}_${Date.now().toString(36)}`,
        name: part.name,
        arguments: part.args || '{}',
      }))
      .filter((call) => Boolean(call.name)),
    finishReason,
    usage,
    thinking: thinking || undefined,
  };
}

/* ---------------------------------------------------------------- helpers */

/**
 * Reasoning text, whichever field the backend used. DeepSeek, vLLM and Kimi
 * use `reasoning_content`; OpenRouter and several gateways use `reasoning`.
 */
function reasoningOf(source: { reasoning_content?: string | null; reasoning?: string | null }): string {
  const value = source.reasoning_content ?? source.reasoning;
  return typeof value === 'string' ? value : '';
}

function collectToolCalls(payload: OpenAiToolCallPayload[] | undefined): ToolCall[] {
  return (payload ?? [])
    .filter((c) => c.function?.name)
    .map((c, i) => ({
      id: c.id ?? `call_${i}_${Math.random().toString(36).slice(2, 8)}`,
      name: c.function!.name!,
      arguments: c.function!.arguments ?? '{}',
    }));
}

function normalizeUsage(usage: OpenAiResponse['usage']): Usage | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
  };
}

export function toOpenAiMessages(messages: ChatMessage[]): unknown[] {
  const out: unknown[] = [];
  for (const m of messages) {
    if (m.role === 'assistant') {
      const entry: Record<string, unknown> = { role: 'assistant', content: m.content || null };
      if (m.toolCalls?.length) {
        entry.tool_calls = m.toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: c.arguments || '{}' },
        }));
      }
      out.push(entry);
      continue;
    }
    if (m.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: m.toolCallId, name: m.name, content: m.content || '(no output)' });
      continue;
    }
    out.push({ role: m.role, content: m.content });
  }
  return out;
}

function normalizeContent(content: OpenAiContent): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : (part?.text ?? '')))
      .join('')
      .trim();
  }
  return '';
}

export function describeHttpError(status: number, body: string, endpoint: string): string {
  let detail = body.slice(0, 500);
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string; message?: string };
    detail =
      (typeof parsed.error === 'object' ? parsed.error?.message : undefined) ??
      parsed.message ??
      (typeof parsed.error === 'string' ? parsed.error : detail);
  } catch {
    /* keep raw body */
  }
  const hint =
    status === 401 || status === 403
      ? ' Check the API key (Coding Harness: Set API Key).'
      : status === 404
        ? ' Check codingHarness.baseUrl and codingHarness.model.'
        : status === 429
          ? ' Rate limited or out of quota \u2014 retry shortly.'
          : '';
  return `HTTP ${status} from ${endpoint}: ${detail}${hint}`;
}
