import * as cp from 'child_process';
import * as path from 'path';
import { fail, ok, type Tool, type ToolContext, type ToolResult } from '../types';
import type { McpServerConfig } from '../types';

/**
 * Minimal MCP (Model Context Protocol) client for stdio servers.
 * Implements JSON-RPC 2.0 over stdin/stdout, line-delimited.
 *
 * Supports:
 * - initialize handshake
 * - tools/list
 * - tools/call
 *
 * Each server is spawned as a child process.
 */

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: any;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: any;
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (reason: any) => void;
  timer: NodeJS.Timeout;
}

export class McpClient {
  private proc?: cp.ChildProcess;
  private requestId = 1;
  private pending = new Map<number, PendingRequest>();
  private buffer = '';
  private initialized = false;
  private tools: McpToolDef[] = [];

  constructor(
    private readonly id: string,
    private readonly config: McpServerConfig,
    private readonly root: string,
    private readonly timeoutMs: number,
  ) {}

  get serverId(): string {
    return this.id;
  }

  get toolDefs(): McpToolDef[] {
    return this.tools;
  }

  async start(): Promise<void> {
    if (this.proc) return;

    const cwd = this.config.cwd ? path.resolve(this.root, this.config.cwd) : this.root;
    const env = { ...process.env, ...(this.config.env ?? {}) };

    this.proc = cp.spawn(this.config.command, this.config.args ?? [], {
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

    this.proc.stderr?.on('data', (data: Buffer) => {
      // Log stderr but don't fail
      // console.debug(`[MCP ${this.id} stderr] ${data.toString()}`);
    });

    this.proc.on('error', (err) => {
      this.failAllPending(err);
    });

    this.proc.on('exit', (code) => {
      this.failAllPending(new Error(`MCP server ${this.id} exited with code ${code}`));
    });

    // Initialize handshake
    await this.initialize();
    await this.listTools();
  }

  private onData(data: string): void {
    this.buffer += data;
    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as JsonRpcResponse & { method?: string };
        if (msg.id != null && this.pending.has(msg.id)) {
          const pending = this.pending.get(msg.id)!;
          clearTimeout(pending.timer);
          this.pending.delete(msg.id);
          if (msg.error) {
            pending.reject(new Error(`MCP ${this.id} error ${msg.error.code}: ${msg.error.message}`));
          } else {
            pending.resolve(msg.result);
          }
        } else if (msg.method) {
          // Notification from server, ignore or handle
          // e.g., notifications/tools/list_changed
        }
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

  private sendRequest(method: string, params?: any, timeoutMs?: number): Promise<any> {
    if (!this.proc || !this.proc.stdin) {
      return Promise.reject(new Error(`MCP server ${this.id} not running`));
    }

    const id = this.requestId++;
    const req: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

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

  private sendNotification(method: string, params?: any): void {
    if (!this.proc || !this.proc.stdin) return;
    const notif = {
      jsonrpc: '2.0',
      method,
      params,
    };
    try {
      this.proc.stdin.write(JSON.stringify(notif) + '\n');
    } catch {
      // ignore
    }
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;

    const result = await this.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {
        tools: {},
      },
      clientInfo: {
        name: 'coding-harness',
        version: '0.1.1',
      },
    });

    // result contains server capabilities, we don't need to validate deeply
    this.initialized = true;

    // Send initialized notification
    this.sendNotification('notifications/initialized', {});
  }

  private async listTools(): Promise<void> {
    try {
      const result = await this.sendRequest('tools/list', {});
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
    const result = await this.sendRequest('tools/call', {
      name,
      arguments: args,
    });
    return result;
  }

  async stop(): Promise<void> {
    if (!this.proc) return;
    try {
      // Try graceful shutdown
      this.sendNotification('shutdown', {});
    } catch {}
    // Give it a moment
    await new Promise((r) => setTimeout(r, 200));
    try {
      this.proc.kill();
    } catch {}
    this.proc = undefined;
    this.pending.clear();
    this.buffer = '';
    this.initialized = false;
  }
}

export class McpManager {
  private clients = new Map<string, McpClient>();
  private toolMap = new Map<string, { clientId: string; toolName: string }>();

  constructor(
    private readonly root: string,
    private readonly timeoutMs: number,
  ) {}

  async startServers(servers: Record<string, McpServerConfig>): Promise<{ started: string[]; failed: { id: string; error: string }[] }> {
    const started: string[] = [];
    const failed: { id: string; error: string }[] = [];

    for (const [id, cfg] of Object.entries(servers)) {
      if (cfg.disabled) continue;
      if (!cfg.command) {
        failed.push({ id, error: 'Missing command' });
        continue;
      }
      const client = new McpClient(id, cfg, this.root, cfg.timeoutMs ?? this.timeoutMs);
      try {
        await client.start();
        this.clients.set(id, client);
        started.push(id);
        // Register tools
        for (const tool of client.toolDefs) {
          const prefixed = `mcp_${id}_${tool.name}`;
          this.toolMap.set(prefixed, { clientId: id, toolName: tool.name });
        }
      } catch (err) {
        failed.push({ id, error: (err as Error).message });
        try {
          await client.stop();
        } catch {}
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

  async stopAll(): Promise<void> {
    const stops = Array.from(this.clients.values()).map((c) => c.stop().catch(() => {}));
    await Promise.all(stops);
    this.clients.clear();
    this.toolMap.clear();
  }
}

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
