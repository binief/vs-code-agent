/** Small, repeatable coding benchmark for a loopback OpenAI-compatible server.
 * The model only receives file tools rooted in a fresh temporary fixture. No
 * shell, MCP, network, editor or arbitrary test execution is exposed to it. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { HarnessSession } from '../core/agent';
import { OpenAiCompatibleProvider } from '../core/providers/openai';
import { createDefaultTools, ToolRegistry } from '../core/tools';
import { DEFAULT_CONFIG, type HarnessEvent, type HarnessHost, type Provider } from '../core/types';

interface Case {
  name: string;
  prompt: string;
  files: Record<string, string>;
  check: (root: string, summary: string) => boolean;
}
const cases: Case[] = [
  { name: 'find-marker', prompt: 'Find the deployment marker in the workspace and report its exact value.',
    files: { 'notes/service.txt': 'Service: harbor\nDeployment marker: delta-473\nStatus: ready\n' },
    check: (_root, summary) => summary.includes('delta-473') },
  { name: 'targeted-edit', prompt: 'In settings.txt change color from blue to green. Preserve all other text.',
    files: { 'settings.txt': 'theme=light\ncolor=blue\nsize=medium\n' },
    check: (root) => fs.readFileSync(path.join(root, 'settings.txt'), 'utf8') === 'theme=light\ncolor=green\nsize=medium\n' },
  { name: 'ambiguous-edit', prompt: 'In settings.txt change the color in the production section from blue to green. Do not change staging or any other text.',
    files: { 'settings.txt': '[staging]\ncolor=blue\n[production]\ncolor=blue\n' },
    check: (root) => fs.readFileSync(path.join(root, 'settings.txt'), 'utf8') === '[staging]\ncolor=blue\n[production]\ncolor=green\n' },
];
export interface BenchmarkResult {
  name: string; iteration: number; passed: boolean; outcome: string; steps: number; toolCalls: number;
  durationMs: number; failedToolCalls: number; loopWarnings: number; timedOut: boolean;
}
class BenchmarkHost implements HarnessHost {
  constructor(readonly workspaceRoot: string) {}
  log(): void {}
  async requestApproval(): Promise<'reject'> { return 'reject'; }
}

/** The assertions are intentionally narrow; passing them is not a general quality guarantee. */
export async function runBenchmark(provider: Provider, model: string, runs = 1, timeoutMs = 180_000): Promise<BenchmarkResult[]> {
  if (!Number.isInteger(runs) || runs < 1 || runs > 10) throw new Error('runs must be between 1 and 10');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 1_800_000) throw new Error('timeout must be between 1000 and 1800000 milliseconds');
  const results: BenchmarkResult[] = [];
  for (let iteration = 1; iteration <= runs; iteration++) for (const task of cases) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-harness-benchmark-'));
    try {
      for (const [name, content] of Object.entries(task.files)) {
        const target = path.join(root, name);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
      }
      const allowed = new Set(['list_files', 'read_file', 'search_text', 'create_file', 'write_file', 'replace_in_file']);
      const registry = new ToolRegistry(createDefaultTools().filter((tool) => allowed.has(tool.name)));
      const config = { ...DEFAULT_CONFIG, model, stream: false, maxSteps: 12, maxOutputTokens: 2048,
        editPolicy: 'auto' as const, commandPolicy: 'ask' as const, allowOutsideWorkspace: false,
        agentFiles: { ...DEFAULT_CONFIG.agentFiles, enabled: false }, mcp: { ...DEFAULT_CONFIG.mcp, enabled: false },
        compaction: { ...DEFAULT_CONFIG.compaction, autoCompact: false } };
      const session = new HarnessSession({ host: new BenchmarkHost(root), provider, config, tools: registry });
      let failedToolCalls = 0, loopWarnings = 0, timedOut = false;
      const onEvent = (event: HarnessEvent): void => {
        if (event.type === 'tool-end' && !event.ok) failedToolCalls++;
        if (event.type === 'notice' && /loop detected/i.test(event.message)) loopWarnings++;
      };
      const started = Date.now();
      const timer = setTimeout(() => { timedOut = true; session.cancel(); }, timeoutMs);
      try {
        const result = await session.runTask(task.prompt, onEvent);
        let passed = false;
        try { passed = !timedOut && result.outcome === 'complete' && task.check(root, result.summary); } catch { /* missing or invalid output */ }
        results.push({ name: task.name, iteration, passed, outcome: result.outcome, steps: result.steps,
          toolCalls: result.toolCalls, durationMs: Date.now() - started, failedToolCalls, loopWarnings, timedOut });
      } finally { clearTimeout(timer); }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
  return results;
}

function parseArgs(args: string[]): { model: string; baseUrl: string; runs: number; timeoutMs: number } {
  let model = '', baseUrl = 'http://127.0.0.1:8080/v1', runs = 1, timeoutMs = 180_000;
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (name === '--help') {
      console.log('Usage: npm run benchmark:local -- --model MODEL [--base-url http://127.0.0.1:8080/v1] [--runs 1] [--timeout-ms 180000]');
      process.exit(0);
    }
    if (!['--model', '--base-url', '--runs', '--timeout-ms'].includes(name) || !args[i + 1]) throw new Error(`Invalid or missing argument: ${name}`);
    const value = args[++i];
    if (name === '--model') model = value;
    if (name === '--base-url') baseUrl = value;
    if (name === '--runs') runs = Number(value);
    if (name === '--timeout-ms') timeoutMs = Number(value);
  }
  if (!model.trim()) throw new Error('--model is required');
  const url = new URL(baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password) {
    throw new Error('The local benchmark only accepts a loopback HTTP(S) server URL without credentials.');
  }
  return { model, baseUrl, runs, timeoutMs };
}
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const results = await runBenchmark(new OpenAiCompatibleProvider({ baseUrl: args.baseUrl }), args.model, args.runs, args.timeoutMs);
  console.log(JSON.stringify({ model: args.model, passed: results.filter((result) => result.passed).length, total: results.length, results }, null, 2));
  if (results.some((result) => !result.passed)) process.exitCode = 1;
}
if (require.main === module) main().catch((error) => { console.error((error as Error).message); process.exitCode = 1; });
