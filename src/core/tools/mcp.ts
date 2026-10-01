import * as cp from 'child_process';
import * as path from 'path';
import { fail, ok, type Tool, type ToolContext, type ToolResult } from '../types';
import type { McpServerConfig } from '../types';

/**
 * Minimal MCP (Model Context Protocol) client.
 *
 * Transports (JSON-RPC 2.0 either way):
 * - `stdio` — the server is spawned as a child process and spoken to over
 *   stdin/stdout, line-delimited (spec 2024-11-05).
 * - `http` — "Streamable HTTP" (spec 2025-03-26): every message is POSTed to a
 *   single endpoint; the answer comes back as `application/json` or as an SSE
 *   stream, and a `Mcp-Session-Id` returned at initialize is echoed on later
 *   requests. If the endpoint rejects POSTs with a 4xx the client falls back
 *   to the legacy transport automatically.
 * - `sse` — legacy HTTP+SSE (spec 2024-11-05): a GET opens a long-lived event
 *   stream that names a POST endpoint; responses arrive back on the stream.
 *
 * Supports: initialize handshake, tools/list, tools/call.
 */

/** Protocol version advertised during initialize. Servers respond with the
 * version they support; http transports echo it in MCP-Protocol-Version. */
const PROTOCOL_VERSION = '2025-03-26';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: any;
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (reason: any) => void;
  timer: NodeJS.Timeout;
}

interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: any;
}

/* --------------------------------------------------------------- transport */

interface McpTransport {
  /** Open the process/connection; must be ready for `request` afterwards. */
  start(): Promise<void>;
  request(method: string, params?: any, timeoutMs?: number): Promise<any>;
  notify(method: string, params?: any): void;
  /** Protocol version negotiated during initialize (http headers only). */
  setProtocolVersion?(version: string): void;
  stop(): Promise<void>;
}

function rpcError(serverId: string, error: { code: number; message: string }): Error {
  return new Error(`MCP ${serverId} error ${error.code}: ${error.message}`);
}

/** fetch failures arrive as `TypeError: fetch failed` with the real cause nested. */
function describeError(err: unknown): string {
  let message = err instanceof Error ? err.message : String(err);
  let cause = (err as { cause?: unknown })?.cause;
  while (cause instanceof Error && cause.message && cause.message !== message) {
    message += `: ${cause.message}`;
    cause = (cause as { cause?: unknown }).cause;
  }
  return message;
}

/** Incremental parser for text/event-stream payloads (`data:` lines per event). */
class SseParser {
  private buffer = '';
  private eventName = 'message';
  private dataLines: string[] = [];

  /** @param onEvent return true to stop pumping the stream early. */
  constructor(private readonly onEvent: (event: string, data: string) => boolean | void) {}

  feed(chunk: string): boolean {
    this.buffer += chunk;
    let idx: number;
    // Lines end with \n or \r\n; events are terminated by a blank line.
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      let line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (this.processLine(line)) return true;
    }
    return false;
  }

  flush(): boolean {
    // A server may omit the trailing blank line of the last event.
    if (this.buffer.trim()) {
      const line = this.buffer.replace(/\r$/, '');
      this.buffer = '';
      if (this.processLine(line)) return true;
    }
    return this.dispatch();
  }

  private processLine(line: string): boolean {
    if (line === '') return this.dispatch();
    if (line.startsWith(':')) return false; // comment / keepalive
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.eventName = value;
    else if (field === 'data') this.dataLines.push(value);
    return false;
  }

  private dispatch(): boolean {
    if (this.dataLines.length === 0) {
      this.eventName = 'message';
      return false;
    }
    const data = this.dataLines.join('\n');
    this.dataLines = [];
    const event = this.eventName;
    this.eventName = 'message';
    return this.onEvent(event, data) === true;
  }
}

/** Read a web stream through an SseParser until it ends or the parser asks to stop. */
async function pumpSseStream(body: unknown, parser: SseParser): Promise<void> {
  if (!body) return;
  const reader = (body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && parser.feed(decoder.decode(value, { stream: true }))) {
        try {
          await reader.cancel();
        } catch {
          /* stream already closing */
        }
        return;
      }
    }
    parser.feed(decoder.decode());
    parser.flush();
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
}

/* --------------------------------------------------------- stdio transport */

class StdioTransport implements McpTransport {
  private proc?: cp.ChildProcess;
  private requestId = 1;
  private pending = new Map<number, PendingRequest>();
  private buffer = '';

  constructor(
    private readonly id: string,
    private readonly config: McpServerConfig,
    private readonly root: string,
    private readonly timeoutMs: number,
  ) {}

  async start(): Promise<void> {
    if (this.proc) return;
    const command = this.config.command;
    if (!command) throw new Error(`MCP server ${this.id}: stdio transport needs a "command"`);

    const cwd = this.config.cwd ? path.resolve(this.root, this.config.cwd) : this.root;
    const env = { ...process.env, ...(this.config.env ?? {}) };

    this.proc = cp.spawn(command, this.config.args ?? [], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });

    if (!this.proc.stdout || !this.proc.stdin) {
      throw new Error(`MCP server ${this.id}: failed to create stdio pipes`);
    }

    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (data: string) => this.onData(data));

    this.proc.stderr?.on('data', () => {
      // Server chatter on stderr is legitimate (logging); it is not JSON-RPC.
    });

    this.proc.on('error', (err) => this.failAllPending(err));
    this.proc.on('exit', (code) => this.failAllPending(new Error(`MCP server ${this.id} exited with code ${code}`)));
  }

  private onData(data: string): void {
    this.buffer += data;
    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as { id?: number; result?: any; error?: { code: number; message: string }; method?: string };
        if (msg.id != null && this.pending.has(msg.id)) {
          const pending = this.pending.get(msg.id)!;
          clearTimeout(pending.timer);
          this.pending.delete(msg.id);
          if (msg.error) pending.reject(rpcError(this.id, msg.error));
          else pending.resolve(msg.result);
        }
        // Notifications (e.g. notifications/tools/list_changed) are ignored.
      } catch {
        // Not JSON, ignore
      }
    }
  }

  private failAllPending(err: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
      this.pending.delete(id);
    }
  }

  request(method: string, params?: any, timeoutMs?: number): Promise<any> {
    if (!this.proc || !this.proc.stdin) {
      return Promise.reject(new Error(`MCP server ${this.id} not running`));
    }

    const id = this.requestId++;
    const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${this.id} request ${method} timed out after ${timeoutMs ?? this.timeoutMs}ms`));
      }, timeoutMs ?? this.timeoutMs);

      this.pending.set(id, { resolve, reject, timer });

      try {
        this.proc!.stdin!.write(JSON.stringify(req) + '\n');
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  notify(method: string, params?: any): void {
    if (!this.proc || !this.proc.stdin) return;
    try {
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    } catch {
      // ignore
    }
  }

  async stop(): Promise<void> {
    if (!this.proc) return;
    try {
      this.notify('shutdown', {});
    } catch {
      /* ignore */
    }
    // Give it a moment
    await new Promise((r) => setTimeout(r, 200));
    try {
      this.proc.kill();
    } catch {
      /* ignore */
    }
    this.proc = undefined;
    this.pending.clear();
    this.buffer = '';
  }
}

/* ---------------------------------------------------------- http transport */

class HttpTransport implements McpTransport {
  private requestId = 1;
  private sessionId?: string;
  private protocolVersion?: string;
  /** 'streamable' = modern single-endpoint; 'sse' = legacy GET-stream + POST endpoint. */
  private mode: 'streamable' | 'sse';
  private sseAbort?: AbortController;
  private ssePostUrl?: string;
  private ssePending = new Map<number, PendingRequest>();
  private endpointReady?: { resolve: () => void; reject: (err: Error) => void };

  constructor(
    private readonly id: string,
    private readonly url: string,
    private readonly customHeaders: Record<string, string>,
    private readonly timeoutMs: number,
    preferSse: boolean,
  ) {
    this.mode = preferSse ? 'sse' : 'streamable';
  }

  async start(): Promise<void> {
    // Streamable HTTP connects lazily with the first request (initialize);
    // the legacy transport needs its stream open before anything can run.
    if (this.mode === 'sse') await this.connectLegacy();
  }

  setProtocolVersion(version: string): void {
    this.protocolVersion = version;
  }

  private baseHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      accept: 'application/json, text/event-stream',
      ...this.customHeaders,
    };
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
    if (this.protocolVersion) headers['mcp-protocol-version'] = this.protocolVersion;
    return headers;
  }

  /* -------- streamable HTTP -------- */

  async request(method: string, params?: any, timeoutMs?: number): Promise<any> {
    if (this.mode === 'sse') return this.legacyRequest(method, params, timeoutMs);
    try {
      return await this.streamableRequest(method, params, timeoutMs);
    } catch (err) {
      const status = (err as { httpStatus?: number })?.httpStatus;
      // Before a session exists a 4xx to a POST usually means a legacy
      // HTTP+SSE server that only accepts GET on this endpoint: switch once.
      if (!this.sessionId && status !== undefined && status >= 400 && status < 500) {
        try {
          await this.connectLegacy();
        } catch {
          throw err; // legacy didn't answer either — report the original failure
        }
        return this.legacyRequest(method, params, timeoutMs);
      }
      throw err;
    }
  }

  private async streamableRequest(method: string, params: any, timeoutMs?: number): Promise<any> {
    const id = this.requestId++;
    const controller = new AbortController();
    const timeout = timeoutMs ?? this.timeoutMs;
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.baseHeaders() },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params } satisfies JsonRpcRequest),
        signal: controller.signal,
      });
      this.captureSession(res.headers);
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        const err = new Error(`MCP ${this.id}: HTTP ${res.status}${detail ? ` — ${detail.slice(0, 300)}` : ''}`);
        (err as { httpStatus?: number }).httpStatus = res.status;
        throw err;
      }
      if (res.status === 202) return undefined; // accepted, no payload
      const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
      if (contentType.includes('application/json')) {
        const msg = (await res.json()) as { result?: any; error?: { code: number; message: string } };
        if (msg?.error) throw rpcError(this.id, msg.error);
        return msg?.result;
      }
      if (contentType.includes('text/event-stream')) return await this.readStreamableSse(res, id);
      throw new Error(`MCP ${this.id}: unexpected response content-type "${contentType || 'none'}"`);
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') {
        throw new Error(`MCP ${this.id} request ${method} timed out after ${timeout}ms`);
      }
      if (err instanceof TypeError) throw new Error(`MCP ${this.id}: ${describeError(err)}`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /** A streamable server may answer a request with an SSE stream of messages. */
  private readStreamableSse(res: Response, wantId: number): Promise<any> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const parser = new SseParser((_event, data) => {
        let msg: { id?: number; result?: any; error?: { code: number; message: string } };
        try {
          msg = JSON.parse(data);
        } catch {
          return false;
        }
        if (msg && msg.id === wantId) {
          settled = true;
          if (msg.error) reject(rpcError(this.id, msg.error));
          else resolve(msg.result);
          return true;
        }
        return false; // requests/notifications from the server are not handled
      });
      pumpSseStream(res.body, parser)
        .then(() => {
          if (!settled) reject(new Error(`MCP ${this.id}: response stream ended without a reply`));
        })
        .catch((err) => {
          if (!settled) reject(err);
        });
    });
  }

  /* -------- legacy HTTP + SSE -------- */

  private async connectLegacy(): Promise<void> {
    this.mode = 'sse';
    this.sseAbort = new AbortController();
    let res: Response;
    try {
      res = await fetch(this.url, {
        method: 'GET',
        headers: { accept: 'text/event-stream', ...this.customHeaders },
        signal: this.sseAbort.signal,
      });
    } catch (err) {
      throw new Error(`MCP ${this.id}: ${describeError(err)}`);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      const err = new Error(`MCP ${this.id}: HTTP ${res.status} opening SSE stream${detail ? ` — ${detail.slice(0, 300)}` : ''}`);
      (err as { httpStatus?: number }).httpStatus = res.status;
      throw err;
    }
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.endpointReady = undefined;
        reject(new Error(`MCP ${this.id}: timed out waiting for the SSE endpoint event (${this.timeoutMs}ms)`));
      }, this.timeoutMs);
      this.endpointReady = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (err: Error) => {
          clearTimeout(timer);
          reject(err);
        },
      };
    });
    const parser = new SseParser((event, data) => this.onLegacyMessage(event, data));
    void pumpSseStream(res.body, parser).then(
      () => this.legacyClosed(new Error(`MCP ${this.id}: SSE stream closed`)),
      (err) => this.legacyClosed(err instanceof Error ? err : new Error(String(err))),
    );
    await ready;
  }

  private onLegacyMessage(event: string, data: string): boolean {
    if (event === 'endpoint') {
      try {
        this.ssePostUrl = new URL(data.trim(), this.url).toString();
        this.endpointReady?.resolve();
      } catch (err) {
        this.endpointReady?.reject(err instanceof Error ? err : new Error(String(err)));
      }
      this.endpointReady = undefined;
      return false;
    }
    let msg: { id?: number; result?: any; error?: { code: number; message: string } };
    try {
      msg = JSON.parse(data);
    } catch {
      return false;
    }
    const pending = msg?.id != null ? this.ssePending.get(msg.id) : undefined;
    if (pending) {
      clearTimeout(pending.timer);
      this.ssePending.delete(msg.id!);
      if (msg.error) pending.reject(rpcError(this.id, msg.error));
      else pending.resolve(msg.result);
    }
    return false;
  }

  private legacyClosed(err: Error): void {
    this.endpointReady?.reject(err);
    this.endpointReady = undefined;
    for (const [id, pending] of this.ssePending) {
      clearTimeout(pending.timer);
      pending.reject(err);
      this.ssePending.delete(id);
    }
  }

  private legacyRequest(method: string, params?: any, timeoutMs?: number): Promise<any> {
    if (!this.ssePostUrl) return Promise.reject(new Error(`MCP ${this.id}: legacy SSE stream is not connected`));
    const id = this.requestId++;
    const timeout = timeoutMs ?? this.timeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.ssePending.delete(id);
        reject(new Error(`MCP ${this.id} request ${method} timed out after ${timeout}ms`));
      }, timeout);
      this.ssePending.set(id, { resolve, reject, timer });
      // The reply arrives over the open event stream; the POST itself is just delivery.
      fetch(this.ssePostUrl!, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.customHeaders },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params } satisfies JsonRpcRequest),
      })
        .then(async (res) => {
          if (!res.ok) {
            clearTimeout(timer);
            this.ssePending.delete(id);
            const detail = await res.text().catch(() => '');
            reject(new Error(`MCP ${this.id}: HTTP ${res.status}${detail ? ` — ${detail.slice(0, 300)}` : ''}`));
          }
        })
        .catch((err) => {
          clearTimeout(timer);
          this.ssePending.delete(id);
          reject(err instanceof TypeError ? new Error(`MCP ${this.id}: ${describeError(err)}`) : err);
        });
    });
  }

  /* -------- shared -------- */

  notify(method: string, params?: any): void {
    const body = JSON.stringify({ jsonrpc: '2.0', method, params });
    if (this.mode === 'sse') {
      if (!this.ssePostUrl) return;
      fetch(this.ssePostUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.customHeaders },
        body,
      })
        .then((res) => void res.arrayBuffer().catch(() => undefined))
        .catch(() => undefined);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.baseHeaders() },
      body,
      signal: controller.signal,
    })
      .then(async (res) => {
        this.captureSession(res.headers);
        await res.arrayBuffer().catch(() => undefined);
      })
      .catch(() => undefined)
      .finally(() => clearTimeout(timer));
  }

  private captureSession(headers: Headers): void {
    const session = headers.get('mcp-session-id');
    if (session) this.sessionId = session;
  }

  async stop(): Promise<void> {
    this.sseAbort?.abort();
    this.sseAbort = undefined;
    this.legacyClosed(new Error(`MCP ${this.id}: stopped`));
    // Streamable HTTP sessions end with an explicit DELETE when we hold an id.
    if (this.mode === 'streamable' && this.sessionId) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      try {
        await fetch(this.url, {
          method: 'DELETE',
          headers: { ...this.customHeaders, 'mcp-session-id': this.sessionId },
          signal: controller.signal,
        });
      } catch {
        /* best effort */
      } finally {
        clearTimeout(timer);
      }
    }
    this.sessionId = undefined;
    this.ssePostUrl = undefined;
  }
}

function createTransport(id: string, config: McpServerConfig, root: string, timeoutMs: number): McpTransport {
  const kind = config.type ?? (config.url ? 'http' : 'stdio');
  if (kind === 'stdio') return new StdioTransport(id, config, root, timeoutMs);
  if (!config.url) throw new Error(`MCP server ${id}: ${kind} transport needs a "url"`);
  let url: URL;
  try {
    url = new URL(config.url);
  } catch {
    throw new Error(`MCP server ${id}: invalid url "${config.url}"`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`MCP server ${id}: url must start with http:// or https://`);
  }
  return new HttpTransport(id, config.url, config.headers ?? {}, timeoutMs, kind === 'sse');
}

/* ------------------------------------------------------------------ client */

export class McpClient {
  private transport: McpTransport;
  private initialized = false;
  private tools: McpToolDef[] = [];

  constructor(
    private readonly id: string,
    config: McpServerConfig,
    root: string,
    timeoutMs: number,
  ) {
    this.transport = createTransport(id, config, root, config.timeoutMs ?? timeoutMs);
  }

  get serverId(): string {
    return this.id;
  }

  get toolDefs(): McpToolDef[] {
    return this.tools;
  }

  async start(): Promise<void> {
    await this.transport.start();
    await this.initialize();
    await this.listTools();
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;

    const result = await this.transport.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {
        tools: {},
      },
      clientInfo: {
        name: 'coding-harness',
        version: '0.1.1',
      },
    });

    this.initialized = true;
    const negotiated = typeof result?.protocolVersion === 'string' ? result.protocolVersion : PROTOCOL_VERSION;
    this.transport.setProtocolVersion?.(negotiated);

    // Send initialized notification
    this.transport.notify('notifications/initialized', {});
  }

  private async listTools(): Promise<void> {
    try {
      const result = await this.transport.request('tools/list', {});
      const tools = result?.tools ?? result ?? [];
      if (Array.isArray(tools)) {
        this.tools = tools.map((t: any) => ({
          name: t.name,
          description: t.description || '',
          inputSchema: t.inputSchema || { type: 'object', properties: {} },
        }));
      }
    } catch (err) {
      // If tools/list fails, keep empty list but don't crash
      this.tools = [];
      throw err;
    }
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<any> {
    return this.transport.request('tools/call', { name, arguments: args });
  }

  async stop(): Promise<void> {
    try {
      await this.transport.stop();
    } catch {
      /* best effort */
    }
    this.initialized = false;
  }
}

/* ----------------------------------------------------------------- manager */

export class McpManager {
  private clients = new Map<string, McpClient>();
  private toolMap = new Map<string, { clientId: string; toolName: string }>();
  /** Why each server failed to start, keyed by server id (for the settings UI). */
  private failures = new Map<string, string>();

  constructor(
    private readonly root: string,
    private readonly timeoutMs: number,
  ) {}

  async startServers(servers: Record<string, McpServerConfig>): Promise<{ started: string[]; failed: { id: string; error: string }[] }> {
    const started: string[] = [];
    const failed: { id: string; error: string }[] = [];

    for (const [id, cfg] of Object.entries(servers)) {
      if (cfg.disabled) continue;
      if (!cfg.command && !cfg.url) {
        failed.push({ id, error: 'Missing "command" (stdio) or "url" (http/sse)' });
        continue;
      }
      let client: McpClient | undefined;
      try {
        // Construction may fail on an invalid config (bad URL, …): report it
        // per-server like a start failure instead of sinking the whole batch.
        client = new McpClient(id, cfg, this.root, this.timeoutMs);
        await client.start();
        this.clients.set(id, client);
        this.failures.delete(id);
        started.push(id);
        // Register tools
        for (const tool of client.toolDefs) {
          const prefixed = `mcp_${id}_${tool.name}`;
          this.toolMap.set(prefixed, { clientId: id, toolName: tool.name });
        }
      } catch (err) {
        failed.push({ id, error: (err as Error).message });
        this.failures.set(id, (err as Error).message);
        try {
          await client?.stop();
        } catch {
          /* ignore */
        }
      }
    }

    return { started, failed };
  }

  getTools(): Tool[] {
    const tools: Tool[] = [];
    for (const [clientId, client] of this.clients) {
      for (const def of client.toolDefs) {
        const prefixedName = `mcp_${clientId}_${def.name}`;
        const description = def.description
          ? `[MCP ${clientId}] ${def.description}`
          : `Tool ${def.name} from MCP server ${clientId}`;

        tools.push({
          name: prefixedName,
          description,
          parameters: def.inputSchema || { type: 'object', properties: {} },
          run: async (args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> => {
            try {
              const result = await client.callTool(def.name, args);
              // MCP result format: { content: [{ type: 'text', text: '...' }], isError?: boolean }
              if (result?.isError) {
                const text = extractMcpContent(result);
                return fail(text || `MCP tool ${def.name} returned error`, `mcp error: ${def.name}`);
              }
              const text = extractMcpContent(result);
              return ok(text || JSON.stringify(result), `mcp ${clientId}/${def.name}`, {
                relPath: undefined,
                mcpServer: clientId,
                mcpTool: def.name,
              });
            } catch (err) {
              return fail(`MCP tool ${def.name} failed: ${(err as Error).message}`, `mcp error`);
            }
          },
        });
      }
    }
    return tools;
  }

  get serverCount(): number {
    return this.clients.size;
  }

  get toolCount(): number {
    return this.toolMap.size;
  }

  get serverIds(): string[] {
    return Array.from(this.clients.keys());
  }

  /** Tool count for one connected server (0 when not running). */
  toolsOf(serverId: string): number {
    return this.clients.get(serverId)?.toolDefs.length ?? 0;
  }

  /** Last start error for a server, if any. */
  failureOf(serverId: string): string | undefined {
    return this.failures.get(serverId);
  }

  async stopAll(): Promise<void> {
    const stops = Array.from(this.clients.values()).map((c) => c.stop().catch(() => {}));
    await Promise.all(stops);
    this.clients.clear();
    this.toolMap.clear();
    this.failures.clear();
  }
}

/* -------------------------------------------------------------- sanitizing */

/**
 * Coerce an arbitrary payload (from the settings dialog, a JSON file, …) into
 * a clean `McpServerConfig` map: unknown keys are dropped, scalars are trimmed
 * and mistyped values are discarded rather than trusted.
 */
export function sanitizeMcpServers(input: unknown): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  for (const [rawId, rawValue] of Object.entries(input as Record<string, unknown>)) {
    const id = rawId.trim();
    if (!id || !rawValue || typeof rawValue !== 'object' || Array.isArray(rawValue)) continue;
    const raw = rawValue as Record<string, unknown>;
    const cfg: McpServerConfig = {};
    if (raw.type === 'stdio' || raw.type === 'http' || raw.type === 'sse') cfg.type = raw.type;
    if (typeof raw.command === 'string' && raw.command.trim()) cfg.command = raw.command.trim();
    if (Array.isArray(raw.args)) {
      const args = raw.args.filter((a): a is string => typeof a === 'string' && a.length > 0);
      if (args.length) cfg.args = args;
    }
    if (raw.env && typeof raw.env === 'object' && !Array.isArray(raw.env)) {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw.env)) if (typeof v === 'string') env[k] = v;
      if (Object.keys(env).length) cfg.env = env;
    }
    if (typeof raw.cwd === 'string' && raw.cwd.trim()) cfg.cwd = raw.cwd.trim();
    if (typeof raw.url === 'string' && raw.url.trim()) cfg.url = raw.url.trim();
    if (raw.headers && typeof raw.headers === 'object' && !Array.isArray(raw.headers)) {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw.headers)) if (typeof v === 'string' && k.trim()) headers[k.trim()] = v;
      if (Object.keys(headers).length) cfg.headers = headers;
    }
    if (typeof raw.disabled === 'boolean') cfg.disabled = raw.disabled;
    if (typeof raw.timeoutMs === 'number' && Number.isFinite(raw.timeoutMs) && raw.timeoutMs > 0) {
      cfg.timeoutMs = Math.floor(raw.timeoutMs);
    }
    out[id] = cfg;
  }
  return out;
}

/* ----------------------------------------------------------------- helpers */

function extractMcpContent(result: any): string {
  if (!result) return '';
  if (typeof result === 'string') return result;
  if (Array.isArray(result.content)) {
    return result.content
      .map((c: any) => {
        if (typeof c === 'string') return c;
        if (c.type === 'text' && typeof c.text === 'string') return c.text;
        if (c.type === 'text' && typeof c.content === 'string') return c.content;
        return JSON.stringify(c);
      })
      .join('\n');
  }
  if (typeof result.content === 'string') return result.content;
  if (result.text) return result.text;
  return JSON.stringify(result, null, 2);
}
