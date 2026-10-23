/**
 * MCP server definitions loaded from workspace config files.
 *
 * Both common shapes are accepted:
 *   - VS Code `.vscode/mcp.json`: `{ "servers": { … }, "inputs": [ … ] }`
 *   - Claude/Cursor `.mcp.json`:  `{ "mcpServers": { … } }`
 *   - a plain `{ "servers": { … } }` / `{ "mcp": { "servers": { … } } }` file
 *
 * Values may use `${workspaceFolder}`, `${workspaceFolderBasename}`,
 * `${userHome}`, `${env:VAR}` and `${input:id}` placeholders. Inputs are
 * resolved through a callback (the editor prompts the user) and cached, so a
 * token is asked for once even when several files reference it.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isInside, toPosix } from '../paths';
import { sanitizeMcpServers } from './mcp';
import type { McpServerConfig } from '../types';

export interface McpInputSpec {
  id: string;
  description?: string;
  password?: boolean;
  type?: string;
}

export interface McpConfigSource {
  /** Path as shown to the user. */
  path: string;
  serverIds: string[];
}

export interface McpConfigError {
  path: string;
  message: string;
}

export interface McpFileConfig {
  servers: Record<string, McpServerConfig>;
  /** Server id -> where it was defined (`settings` or a config file path). */
  origins: Record<string, string>;
  sources: McpConfigSource[];
  errors: McpConfigError[];
  inputs: McpInputSpec[];
}

export interface LoadMcpConfigOptions {
  /** Resolve an `${input:id}` placeholder (e.g. with a VS Code input box). */
  resolveInput?: (input: McpInputSpec) => Promise<string | undefined> | string | undefined;
  /** Environment used for `${env:VAR}`. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

interface ParsedFile {
  abs: string;
  displayPath: string;
  servers: Record<string, unknown>;
  inputs: McpInputSpec[];
}

function displayPath(root: string, abs: string): string {
  if (isInside(root, abs)) return toPosix(path.relative(path.resolve(root), path.resolve(abs)));
  const home = os.homedir();
  if (isInside(home, abs)) return `~/${toPosix(path.relative(home, abs))}`;
  return toPosix(abs);
}

function resolveConfigPath(root: string, input: string): string {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/') || input.startsWith('~\\')) return path.resolve(os.homedir(), input.slice(2));
  return path.isAbsolute(input) ? path.resolve(input) : path.resolve(root, input);
}

function asServerMap(json: unknown): Record<string, unknown> {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return {};
  const obj = json as Record<string, unknown>;
  const candidates = [obj.mcpServers, obj.servers, (obj.mcp as Record<string, unknown> | undefined)?.servers];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      return candidate as Record<string, unknown>;
    }
  }
  return {};
}

function asInputList(json: unknown): McpInputSpec[] {
  if (!json || typeof json !== 'object') return [];
  const list = (json as Record<string, unknown>).inputs;
  if (!Array.isArray(list)) return [];
  const out: McpInputSpec[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    if (typeof item.id !== 'string' || !item.id.trim()) continue;
    out.push({
      id: item.id.trim(),
      description: typeof item.description === 'string' ? item.description : undefined,
      password: item.password === true,
      type: typeof item.type === 'string' ? item.type : undefined,
    });
  }
  return out;
}

function parseFile(root: string, input: string, errors: McpConfigError[]): ParsedFile | undefined {
  const abs = resolveConfigPath(root, input);
  if (!fs.existsSync(abs)) return undefined;
  let text: string;
  try {
    text = fs.readFileSync(abs, 'utf8');
  } catch (err) {
    errors.push({ path: displayPath(root, abs), message: `cannot read file: ${(err as Error).message}` });
    return undefined;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    errors.push({ path: displayPath(root, abs), message: `invalid JSON: ${(err as Error).message}` });
    return undefined;
  }
  const servers = asServerMap(json);
  const obj = json as Record<string, unknown>;
  const recognised = Boolean(
    obj.servers || obj.mcpServers || (obj.mcp && typeof obj.mcp === 'object' && (obj.mcp as Record<string, unknown>).servers),
  );
  if (Object.keys(servers).length === 0) {
    // A file with an empty server map (or only `inputs`) is a valid template;
    // only an unrecognised shape is worth reporting.
    if (!recognised) {
      errors.push({ path: displayPath(root, abs), message: 'no "servers" or "mcpServers" object found' });
    }
    return undefined;
  }
  return { abs, displayPath: displayPath(root, abs), servers, inputs: asInputList(json) };
}

/** Load every existing config file under `root` and merge the server maps. */
export async function loadMcpConfigFiles(
  root: string,
  files: string[],
  options: LoadMcpConfigOptions = {},
): Promise<McpFileConfig> {
  const errors: McpConfigError[] = [];
  const parsed: ParsedFile[] = [];
  const seen = new Set<string>();
  for (const input of files ?? []) {
    if (!input || !input.trim()) continue;
    const abs = resolveConfigPath(root, input);
    const key = process.platform === 'win32' ? abs.toLowerCase() : abs;
    if (seen.has(key)) continue;
    seen.add(key);
    const file = parseFile(root, input, errors);
    if (file) parsed.push(file);
  }

  const inputs = new Map<string, McpInputSpec>();
  for (const file of parsed) {
    for (const spec of file.inputs) if (!inputs.has(spec.id)) inputs.set(spec.id, spec);
  }

  const env = options.env ?? process.env;
  const resolvedInputs = new Map<string, string | undefined>();
  const resolveInput = async (id: string): Promise<string | undefined> => {
    if (resolvedInputs.has(id)) return resolvedInputs.get(id);
    const spec = inputs.get(id) ?? { id };
    let value: string | undefined;
    try {
      value = await options.resolveInput?.(spec);
    } catch {
      value = undefined;
    }
    resolvedInputs.set(id, value);
    if (value === undefined) {
      const source = parsed.find((file) => file.inputs.some((spec) => spec.id === id))?.displayPath ?? '(config files)';
      errors.push({ path: source, message: `input "${id}" was not provided` });
    }
    return value;
  };

  const expand = async (value: unknown): Promise<unknown> => {
    if (typeof value === 'string') {
      let out = value;
      const pattern = /\$\{(env|input):([^}]+)\}|\$\{(workspaceFolder|workspaceFolderBasename|userHome)\}/g;
      const matches = [...value.matchAll(pattern)];
      for (const match of matches) {
        const kind = match[1] ?? match[3];
        const name = (match[2] ?? '').trim();
        let replacement = '';
        if (kind === 'env') replacement = env[name] ?? '';
        else if (kind === 'workspaceFolder') replacement = toPosix(root);
        else if (kind === 'workspaceFolderBasename') replacement = path.basename(root);
        else if (kind === 'userHome') replacement = toPosix(os.homedir());
        else replacement = (await resolveInput(name)) ?? '';
        out = out.split(match[0]).join(replacement);
      }
      return out;
    }
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      for (const item of value) out.push(await expand(item));
      return out;
    }
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = await expand(item);
      return out;
    }
    return value;
  };

  const result: McpFileConfig = { servers: {}, origins: {}, sources: [], errors, inputs: [...inputs.values()] };
  for (const file of parsed) {
    const serverIds: string[] = [];
    for (const [id, raw] of Object.entries(file.servers)) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const expanded = (await expand(raw)) as Record<string, unknown>;
      const sanitized = sanitizeMcpServers({ [id]: expanded });
      const cfg = sanitized[id];
      if (!cfg) continue;
      // Later files override earlier ones; the origin follows the winner.
      result.servers[id] = cfg;
      result.origins[id] = file.displayPath;
      serverIds.push(id);
    }
    result.sources.push({ path: file.displayPath, serverIds });
  }

  return result;
}

/**
 * Merge file definitions with settings. Settings win over every file, which is
 * what makes them the place to override a shared project config locally.
 */
export function mergeMcpServers(
  fileConfig: McpFileConfig | undefined,
  settingsServers: Record<string, McpServerConfig> | undefined,
): { servers: Record<string, McpServerConfig>; origins: Record<string, string> } {
  const servers: Record<string, McpServerConfig> = { ...(fileConfig?.servers ?? {}) };
  const origins: Record<string, string> = { ...(fileConfig?.origins ?? {}) };
  for (const [id, cfg] of Object.entries(sanitizeMcpServers(settingsServers))) {
    servers[id] = cfg;
    origins[id] = 'settings';
  }
  return { servers, origins };
}
