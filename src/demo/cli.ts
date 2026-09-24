/**
 * Headless driver for the harness — the same core the VS Code extension uses.
 *
 *   node out/demo/cli.js "create a python script called fib.py that prints fibonacci" --provider mock --dir ./playground
 *   node out/demo/cli.js "add a test for the parser" --provider openai --model gpt-4o-mini --dir .
 *
 * Useful for smoke-testing the agent loop, the tool layer and the safety
 * policies without launching the editor.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline/promises';
import { HarnessSession } from '../core/agent';
import { apiKeyFromEnv, createProvider } from '../core/providers';
import { createDefaultTools, ToolRegistry } from '../core/tools';
import { McpManager } from '../core/tools/mcp';
import { DEFAULT_CONFIG, type ApprovalRequest, type HarnessConfig, type HarnessEvent, type HarnessHost, type ProviderId } from '../core/types';

const COLOR = !process.env.NO_COLOR;
const c = {
  dim: (s: string) => (COLOR ? `\u001b[2m${s}\u001b[0m` : s),
  bold: (s: string) => (COLOR ? `\u001b[1m${s}\u001b[0m` : s),
  green: (s: string) => (COLOR ? `\u001b[32m${s}\u001b[0m` : s),
  red: (s: string) => (COLOR ? `\u001b[31m${s}\u001b[0m` : s),
  yellow: (s: string) => (COLOR ? `\u001b[33m${s}\u001b[0m` : s),
  cyan: (s: string) => (COLOR ? `\u001b[36m${s}\u001b[0m` : s),
};

interface Args {
  prompt: string;
  dir: string;
  provider?: ProviderId;
  model?: string;
  baseUrl?: string;
  auto: boolean;
  maxSteps?: number;
  verbose: boolean;
  noStream: boolean;
  mcp?: string;
  compactThreshold?: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { prompt: '', dir: process.cwd(), auto: false, verbose: false, noStream: false };
  const words: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => argv[++i];
    switch (a) {
      case '--dir': args.dir = value(); break;
      case '--provider': args.provider = value() as ProviderId; break;
      case '--model': args.model = value(); break;
      case '--base-url': args.baseUrl = value(); break;
      case '--max-steps': args.maxSteps = Number(value()); break;
      case '--auto': args.auto = true; break;
      case '--no-stream': args.noStream = true; break;
      case '--verbose': args.verbose = true; break;
      case '--mcp': args.mcp = value(); break;
      case '--compact-threshold': args.compactThreshold = Number(value()); break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
      default:
        words.push(a);
    }
  }
  args.prompt = words.join(' ').trim();
  return args;
}

function printHelp(): void {
  console.log(`Coding Harness — headless driver

Usage: node out/demo/cli.js "<prompt>" [options]

Options:
  --dir <path>          Workspace root (default: cwd)
  --provider <id>       openai | anthropic | mock   (default: mock)
  --model <id>          Model id, e.g. gpt-4o-mini, claude-sonnet-4-5
  --base-url <url>      OpenAI-compatible base URL (Ollama, OpenRouter, …)
  --max-steps <n>       Step budget (default: 40)
  --auto                Approve every edit/command without asking
  --no-stream           Wait for each model turn instead of streaming it
  --verbose             Print full tool output
  --mcp <json>          MCP servers JSON, e.g. '{"my-server":{"command":"node","args":["./mcp.js"]}}'
  --compact-threshold <n> Context threshold 0-1 for auto-compaction (default 0.75)
`);
}

class CliHost implements HarnessHost {
  constructor(
    readonly workspaceRoot: string,
    private readonly auto: boolean,
    private readonly verbose: boolean,
  ) {}

  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
    if (level === 'debug' && !this.verbose) return;
    if (level === 'info') return; // tool events already show this
    console.error(c.dim(`[${level}] ${message}`));
  }

  async requestApproval(req: ApprovalRequest): Promise<'apply' | 'reject'> {
    const header =
      req.kind === 'command' ? c.yellow(`\n⚠  Approve command?`) : c.yellow(`\n⚠  Approve ${req.kind}: ${req.title}`);
    console.log(header);
    const body = req.kind === 'write' ? req.detail.split('\n').slice(0, 60).join('\n') : req.detail;
    console.log(c.dim(indent(body, '   ')));

    if (this.auto) {
      console.log(c.dim('   (--auto: approved)'));
      return 'apply';
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question('   apply? [y/N] ')).trim().toLowerCase();
    rl.close();
    return answer === 'y' || answer === 'yes' ? 'apply' : 'reject';
  }
}

function indent(text: string, pad: string): string {
  return text
    .split('\n')
    .map((l) => pad + l)
    .join('\n');
}

function truncate(text: string, max = 600): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… (${text.length - max} more chars)`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.prompt) {
    printHelp();
    process.exit(args.prompt === '' ? 1 : 0);
  }

  const root = path.resolve(args.dir);
  if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });

  const config: HarnessConfig = {
    ...DEFAULT_CONFIG,
    provider: args.provider ?? 'mock',
    model: args.model ?? (args.provider === 'anthropic' ? 'claude-sonnet-4-5' : DEFAULT_CONFIG.model),
    baseUrl: args.baseUrl ?? DEFAULT_CONFIG.baseUrl,
    maxSteps: args.maxSteps ?? DEFAULT_CONFIG.maxSteps,
    editPolicy: 'ask',
    commandPolicy: 'ask',
    stream: !args.noStream,
    compaction: {
      ...DEFAULT_CONFIG.compaction,
      threshold: args.compactThreshold ?? DEFAULT_CONFIG.compaction.threshold,
    },
  };

  if (args.mcp) {
    try {
      const servers = JSON.parse(args.mcp);
      config.mcp = {
        enabled: true,
        servers,
        timeoutMs: 10000,
      };
    } catch (e) {
      console.error(c.red(`Failed to parse --mcp JSON: ${(e as Error).message}`));
      process.exit(1);
    }
  }

  const apiKey = apiKeyFromEnv(config.provider);
  const provider = createProvider({ config, apiKey });
  const host = new CliHost(root, args.auto, args.verbose);

  console.log(c.bold(`\nCoding Harness — ${provider.label} (${config.model})`));
  console.log(c.dim(`workspace: ${root}\nprompt:    ${args.prompt}\n`));
  if (config.mcp.enabled) {
    console.log(c.dim(`MCP: enabled with ${Object.keys(config.mcp.servers).length} server(s)\n`));
  }

  let mcpManager: McpManager | undefined;
  let registry: ToolRegistry;
  if (config.mcp.enabled && Object.keys(config.mcp.servers).length > 0) {
    mcpManager = new McpManager(root, config.mcp.timeoutMs);
    const { started, failed } = await mcpManager.startServers(config.mcp.servers);
    console.log(c.dim(`MCP: started ${started.length} server(s), ${mcpManager.toolCount} tools`));
    if (failed.length) {
      for (const f of failed) console.error(c.red(`MCP ${f.id} failed: ${f.error}`));
    }
    registry = new ToolRegistry([...createDefaultTools(), ...mcpManager.getTools()]);
  } else {
    registry = new ToolRegistry(createDefaultTools());
  }

  const session = new HarnessSession({ host, config, provider, registry });
  let streaming = false;
  let totalTokens = 0;
  const render = (event: HarnessEvent): void => {
    switch (event.type) {
      case 'step':
        if (streaming) {
          process.stdout.write('\n');
          streaming = false;
        }
        console.log(c.dim(`── step ${event.index}/${event.maxSteps}`));
        break;
      case 'assistant-delta':
        // Live token stream: no newline until the turn ends.
        if (!streaming) {
          process.stdout.write(c.cyan('▸ '));
          streaming = true;
        }
        process.stdout.write(c.cyan(event.text));
        break;
      case 'thinking-delta':
        if (!streaming) {
          process.stdout.write(c.dim('💭 '));
          streaming = true;
        }
        process.stdout.write(c.dim(event.text));
        break;
      case 'thinking':
        if (streaming) {
          process.stdout.write('\n');
          streaming = false;
        }
        console.log(c.dim(`💭 thought ${event.durationMs}ms: ${truncate(event.text, 200)}`));
        break;
      case 'assistant':
        if (streaming) {
          process.stdout.write('\n');
          streaming = false;
        } else if (event.text) {
          console.log(c.cyan(`▸ ${truncate(event.text, 1200)}`));
        }
        break;
      case 'tool-start':
        console.log(`  ⚙  ${c.bold(event.name)} ${c.dim(truncate(event.args, 200))}`);
        break;
      case 'tool-end':
        console.log(
          `  ${event.ok ? c.green('✓') : c.red('✗')} ${event.name} — ${event.summary} ${c.dim(`${event.durationMs}ms`)}`,
        );
        if (args.verbose) console.log(c.dim(indent(truncate(event.detail, 2000), '     ')));
        break;
      case 'notice':
        console.log(c.yellow(`  ! ${event.message}`));
        break;
      case 'usage':
        totalTokens = event.cumulative?.totalTokens ?? event.usage.totalTokens ?? totalTokens;
        const speed = event.tokensPerSecond ? ` ${event.tokensPerSecond.toFixed(1)} tok/s` : '';
        const ctx = event.contextPercent ? ` ctx ${Math.round(event.contextPercent)}%` : '';
        console.log(c.dim(`  tokens: ${event.usage.totalTokens || 0} (in ${event.usage.inputTokens || 0} out ${event.usage.outputTokens || 0})${speed}${ctx} | total ${totalTokens}`));
        break;
      case 'context':
        console.log(c.dim(`  context: ${event.contextTokens}/${event.contextWindow} (${Math.round(event.contextPercent)}%)`));
        break;
      case 'mcp-status':
        console.log(c.dim(`  MCP: ${event.servers} server(s), ${event.tools} tool(s)`));
        break;
      case 'done':
        console.log(
          `\n${event.reason === 'complete' ? c.green('✔ complete') : c.yellow(`■ ${event.reason}`)}: ${event.summary}`,
        );
        if (event.filesChanged.length) {
          console.log(c.dim(`files changed: ${event.filesChanged.join(', ')}`));
        }
        if (event.usage) {
          console.log(c.dim(`total tokens: ${event.usage.totalTokens || 0} (in ${event.usage.inputTokens || 0} out ${event.usage.outputTokens || 0})`));
        }
        if (event.tokensPerSecond) {
          console.log(c.dim(`speed: ${event.tokensPerSecond.toFixed(1)} tok/s`));
        }
        break;
      default:
        break;
    }
  };

  const result = await session.runTask(args.prompt, render);
  if (mcpManager) await mcpManager.stopAll();
  process.exitCode = result.outcome === 'complete' ? 0 : 1;
}

void os;
main().catch((err) => {
  console.error(c.red(`fatal: ${(err as Error).message}`));
  process.exit(1);
});
