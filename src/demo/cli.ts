/**
 * Headless driver for the harness \u2014 the same core the VS Code extension uses.
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
  console.log(`Coding Harness \u2014 headless driver

Usage: node out/demo/cli.js "<prompt>" [options]

Options:
  --dir <path>          Workspace root (default: cwd)
  --provider <id>       openai | anthropic | mock   (default: mock)
  --model <id>          Model id, e.g. gpt-4o-mini, claude-sonnet-4-5
  --base-url <url>      OpenAI-compatible base URL (Ollama, OpenRouter, \u2026)
  --max-steps <n>       Step budget (default: 12)
  --auto                Approve every edit/command without asking
  --no-stream           Wait for each model turn instead of streaming it
  --verbose             Print full tool output
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
      req.kind === 'command' ? c.yellow(`\n\u26a0  Approve command?`) : c.yellow(`\n\u26a0  Approve ${req.kind}: ${req.title}`);
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
  return text.length <= max ? text : `${text.slice(0, max)}\n\u2026 (${text.length - max} more chars)`;
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
  };

  const apiKey = apiKeyFromEnv(config.provider);
  const provider = createProvider({ config, apiKey });
  const host = new CliHost(root, args.auto, args.verbose);

  console.log(c.bold(`\nCoding Harness \u2014 ${provider.label} (${config.model})`));
  console.log(c.dim(`workspace: ${root}\nprompt:    ${args.prompt}\n`));

  const session = new HarnessSession({ host, config, provider });
  let streaming = false;
  const render = (event: HarnessEvent): void => {
    switch (event.type) {
      case 'step':
        if (streaming) {
          process.stdout.write('\n');
          streaming = false;
        }
        console.log(c.dim(`\u2500\u2500 step ${event.index}/${event.maxSteps}`));
        break;
      case 'assistant-delta':
        // Live token stream: no newline until the turn ends.
        if (!streaming) {
          process.stdout.write(c.cyan('\u25b8 '));
          streaming = true;
        }
        process.stdout.write(c.cyan(event.text));
        break;
      case 'assistant':
        if (streaming) {
          process.stdout.write('\n');
          streaming = false;
        } else if (event.text) {
          console.log(c.cyan(`\u25b8 ${truncate(event.text, 1200)}`));
        }
        break;
      case 'tool-start':
        console.log(`  \u2699  ${c.bold(event.name)} ${c.dim(truncate(event.args, 200))}`);
        break;
      case 'tool-end':
        console.log(
          `  ${event.ok ? c.green('\u2713') : c.red('\u2717')} ${event.name} \u2014 ${event.summary} ${c.dim(`${event.durationMs}ms`)}`,
        );
        if (args.verbose) console.log(c.dim(indent(truncate(event.detail, 2000), '     ')));
        break;
      case 'notice':
        console.log(c.yellow(`  ! ${event.message}`));
        break;
      case 'usage':
        if (args.verbose && event.usage.totalTokens) console.log(c.dim(`  tokens: ${event.usage.totalTokens}`));
        break;
      case 'done':
        console.log(
          `\n${event.reason === 'complete' ? c.green('\u2714 complete') : c.yellow(`\u25a0 ${event.reason}`)}: ${event.summary}`,
        );
        if (event.filesChanged.length) {
          console.log(c.dim(`files changed: ${event.filesChanged.join(', ')}`));
        }
        break;
      default:
        break;
    }
  };

  const result = await session.runTask(args.prompt, render);
  process.exitCode = result.outcome === 'complete' ? 0 : 1;
}

void os;
main().catch((err) => {
  console.error(c.red(`fatal: ${(err as Error).message}`));
  process.exit(1);
});
