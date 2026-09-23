import * as path from 'path';
import type { ChatMessage, ChatRequest, Provider, ProviderResponse, ToolCall } from '../types';

/**
 * A deterministic, offline "planner" that speaks the same tool-calling protocol
 * as the real providers.
 *
 * It is not an LLM: it pattern-matches the prompt, explores the workspace,
 * writes a sensible file for common asks (script/README/config/HTML), runs a
 * syntax check as verification, and then summarises. That makes the whole
 * harness \u2014 tools, approvals, checkpoints, UI \u2014 usable and testable with no
 * API key and no network, and it is the provider the unit tests drive.
 */
export class MockPlannerProvider implements Provider {
  readonly id = 'mock';
  readonly label = 'Offline planner (no API key)';

  private taskKey = '';
  private step = 0;
  private actions: { tool: string; ok: boolean; summary: string; content: string }[] = [];

  async chat(req: ChatRequest): Promise<ProviderResponse> {
    const prompting = req.tools.length > 0;

    // The agent passes an empty tool list on its final turn: answer in prose.
    if (!prompting) {
      const answer = this.finalAnswer();
      await streamWords(answer, req);
      return { text: answer, toolCalls: [] };
    }

    const lastUserIndex = findLastIndex(req.messages, (m) => m.role === 'user');
    const prompt = req.messages[lastUserIndex]?.content ?? '';
    const taskMessages = req.messages.slice(lastUserIndex + 1);

    const actions = collectActions(req.messages, taskMessages);
    const key = `${lastUserIndex}:${prompt.slice(0, 160)}`;
    if (key !== this.taskKey) {
      this.taskKey = key;
      this.step = 0;
    } else {
      this.step = actions.length;
    }
    this.actions = actions.map((a) => ({ tool: a.name, ok: a.ok, summary: a.summary, content: a.content }));

    const intent = parseIntent(prompt);
    const call = async (name: string, args: Record<string, unknown>): Promise<ProviderResponse> => {
      const text = intentSentence(name, args);
      await streamWords(text, req);
      return {
        text,
        toolCalls: [{ id: `mock_${this.step}_${name}`, name, arguments: JSON.stringify(args) }],
        finishReason: 'tool_calls',
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      };
    };
    const done = async (): Promise<ProviderResponse> => {
      const text = this.finalAnswer();
      await streamWords(text, req);
      return { text, toolCalls: [] };
    };

    // Turn 0: always look at the layout first.
    if (this.step === 0) {
      return call('list_files', { path: '.', max_depth: 3, max_entries: 200 });
    }

    const listing = actions.find((a) => a.name === 'list_files')?.content ?? '';
    const rootFiles = extractListedFiles(listing);
    const last = actions[actions.length - 1];

    if (last && last.name === 'write_file') {
      const target = fileArg(last.args) ?? intent.filePath;
      const check = syntaxCheckFor(target ?? '');
      if (check && target) return call('run_command', { command: check.command, purpose: `verify ${target}` });
      return done();
    }

    if (last && (last.name === 'run_command' || last.name === 'read_file' || last.name === 'search_text')) {
      return done();
    }

    if (last && (last.name === 'replace_in_file' || last.name === 'delete_file')) {
      return done();
    }

    // Turn 1+: act on the intent.
    if (intent.kind === 'create' && intent.filePath) {
      const exists = rootFiles.some((f) => f.endsWith(intent.filePath!) || f === intent.filePath);
      if (exists) return call('read_file', { path: intent.filePath });
      return call('write_file', {
        path: intent.filePath,
        mode: 'create',
        content: scaffold(intent),
      });
    }

    if ((intent.kind === 'read' || intent.kind === 'edit') && intent.filePath) {
      return call('read_file', { path: intent.filePath });
    }

    if (intent.kind === 'search' && intent.query) {
      return call('search_text', { query: intent.query, max_results: 40 });
    }

    if (intent.kind === 'test') {
      const hasPackageJson = rootFiles.includes('package.json');
      const hasPython = rootFiles.some((f) => f.endsWith('.py'));
      if (hasPackageJson) return call('run_command', { command: 'npm test', purpose: 'run the project test script' });
      if (hasPython) return call('run_command', { command: 'python3 -m pytest -q', purpose: 'run the python test suite' });
      return done();
    }

    return done();
  }

  /** Human-readable summary of what the mock planner actually did. */
  private finalAnswer(): string {
    if (this.actions.length === 0) {
      return (
        'Offline planner: nothing actionable in that prompt. I can create a file (name it, e.g. "create util.py"), ' +
        'read/explain a file, search the workspace, or run the test suite. Configure a real model in ' +
        'Coding Harness settings for open-ended requests.'
      );
    }

    const lines: string[] = ['Offline planner summary (no model configured \u2014 this is the built-in rule-based demo):'];
    for (const a of this.actions) {
      const first = a.content.split('\n').find((l) => l.trim().length > 0) ?? '';
      lines.push(`- ${a.tool}: ${a.ok ? '' : 'FAILED \u2014 '}${(a.summary || first).slice(0, 200)}`);
    }
    const rejected = this.actions.some((a) => /rejected/i.test(a.summary) || /rejected/i.test(a.content));
    if (rejected) {
      lines.push('', 'A step was rejected by the user, so I stopped there.');
    }
    lines.push(
      '',
      'Set `codingHarness.provider` to `openai` or `anthropic` (plus an API key) to get a real coding agent; ' +
        'the tools, approval flow and checkpoints you just saw are the same ones it will use.',
    );
    return lines.join('\n');
  }
}

/* ------------------------------------------------------------- helpers */

/**
 * Feeds a sentence to the UI word by word so the offline planner behaves like a
 * streaming model. Awaiting real delays keeps the panel's live view honest
 * (text appears progressively instead of jumping in fully formed).
 */
async function streamWords(text: string, req: ChatRequest, msPerChunk = 8): Promise<void> {
  const onDelta = req.onDelta;
  if (!onDelta || !text) return;
  const chunks = text.match(/\S+\s*/g) ?? [text];
  const budget = 400; // never stall a task for the sake of a typing animation
  const delay = Math.max(1, Math.min(msPerChunk, Math.floor(budget / Math.max(1, chunks.length))));
  for (const chunk of chunks) {
    if (req.signal?.aborted) return;
    onDelta(chunk);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

interface RecordedAction {
  name: string;
  ok: boolean;
  summary: string;
  content: string;
  args: Record<string, unknown>;
}

/** Pair assistant tool calls with the tool results that followed them. */
function collectActions(messages: ChatMessage[], scope: ChatMessage[]): RecordedAction[] {
  const out: RecordedAction[] = [];
  const byId = new Map<string, RecordedAction>();

  for (const m of messages) {
    if (m.role === 'assistant' && m.toolCalls) {
      for (const c of m.toolCalls) {
        const action: RecordedAction = { name: c.name, ok: true, summary: '', content: '', args: parseArgs(c.arguments) };
        byId.set(c.id, action);
        out.push(action);
      }
    }
  }
  for (const m of scope) {
    if (m.role !== 'tool' || !m.toolCallId) continue;
    const action = byId.get(m.toolCallId);
    if (!action) continue;
    action.content = m.content;
    // Tool results are written as prose by the tools; look for the failure
    // markers they emit rather than trying to parse a status field.
    action.ok = !/(user rejected|refused|not found|does not exist|timed out|tool \"[^"]+\" failed|failed to|^exit code [1-9]|^error)/im.test(
      m.content.slice(0, 400),
    );
    action.summary = firstLine(m.content);
  }
  return out;
}

function firstLine(text: string): string {
  return (text.split('\n').find((l) => l.trim()) ?? '').trim().slice(0, 200);
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function fileArg(args: Record<string, unknown>): string | undefined {
  const value = args.path ?? args.file;
  return typeof value === 'string' ? value : undefined;
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) if (predicate(items[i])) return i;
  return -1;
}

function extractListedFiles(listing: string): string[] {
  return listing
    .split('\n')
    .map((l) => l.trim().split(/\s+/)[0] ?? '')
    .filter((l) => l && !l.endsWith('/'))
    .map((l) => l.replace(/^.*\//, '') === l ? l : l);
}

const EXTENSIONS = 'py|js|mjs|cjs|ts|tsx|jsx|md|json|txt|sh|bash|zsh|c|h|cpp|hpp|java|go|rs|rb|php|html|css|scss|yml|yaml|toml|ini|cfg|sql|kt|swift';

export interface Intent {
  kind: 'create' | 'read' | 'edit' | 'search' | 'test' | 'explain';
  filePath?: string;
  query?: string;
  language?: string;
}

const LANGUAGE_BY_WORD: Record<string, { ext: string; file: string }> = {
  python: { ext: '.py', file: 'main.py' },
  javascript: { ext: '.js', file: 'index.js' },
  typescript: { ext: '.ts', file: 'index.ts' },
  node: { ext: '.js', file: 'index.js' },
  shell: { ext: '.sh', file: 'script.sh' },
  bash: { ext: '.sh', file: 'script.sh' },
  html: { ext: '.html', file: 'index.html' },
  markdown: { ext: '.md', file: 'NOTES.md' },
  go: { ext: '.go', file: 'main.go' },
  rust: { ext: '.rs', file: 'main.rs' },
  java: { ext: '.java', file: 'Main.java' },
};

export function parseIntent(prompt: string): Intent {
  const text = prompt.trim();
  const lower = text.toLowerCase();

  const fileMatch = text.match(new RegExp(`(?:^|[\\s"'\`(])([\\w./-]+\\.(?:${EXTENSIONS}))(?=$|[\\s"'\`),.:;?])`, 'i'));
  let filePath = fileMatch?.[1];

  if (!filePath) {
    // Document-shaped requests rarely name an extension.
    if (/\breadme\b/i.test(lower)) filePath = 'README.md';
    else if (/\b(notes|changelog)\b/i.test(lower)) filePath = /changelog/i.test(lower) ? 'CHANGELOG.md' : 'NOTES.md';
  }

  if (!filePath) {
    for (const [word, info] of Object.entries(LANGUAGE_BY_WORD)) {
      if (new RegExp(`\\b${word}\\b`).test(lower)) {
        if (word === 'markdown' || /readme|notes/.test(lower)) {
          filePath = /readme/.test(lower) ? 'README.md' : info.file;
        } else if (/readme/.test(lower)) {
          filePath = 'README.md';
        } else if (info.ext === '.py' || info.ext === '.js' || info.ext === '.ts' || info.ext === '.sh' || info.ext === '.html') {
          filePath = info.file;
        }
        if (filePath) break;
      }
    }
  }

  const queryMatch =
    text.match(/["'`]([^"'`]{2,60})["'`]/) ??
    text.match(/\b([a-zA-Z_][\w.]*\s*\()/) ??
    text.match(/\b(?:for|find|locate|where(?:'s| is)|call(?:ed)?|named)\s+([A-Za-z_][\w.$-]{1,60})/i);
  const query = queryMatch?.[1]?.replace(/\s*\($/, '').trim();

  if (/\b(create|write|add|make|generate|scaffold|new file|boilerplate)\b/.test(lower)) return { kind: 'create', filePath, query };
  if (/\b(test|tests|verify|build|lint|typecheck)\b/.test(lower)) return { kind: 'test', filePath, query };
  if (/\b(search|find|where is|locate|grep|which file)\b/.test(lower)) return { kind: 'search', filePath, query };
  if (/\b(fix|bug|update|change|refactor|edit|rename|modify)\b/.test(lower)) return { kind: 'edit', filePath, query };
  if (/\b(read|explain|describe|summar|list|overview|what does|how does)\b/.test(lower)) return { kind: 'read', filePath, query };
  return { kind: 'explain', filePath, query };
}

function intentSentence(name: string, args: Record<string, unknown>): string {
  const target = typeof args.path === 'string' ? args.path : typeof args.command === 'string' ? args.command : '';
  switch (name) {
    case 'list_files':
      return 'Looking at the workspace layout first.';
    case 'read_file':
      return `Reading ${target} to see what is already there.`;
    case 'write_file':
      return `Creating ${target}.`;
    case 'replace_in_file':
      return `Editing ${target}.`;
    case 'search_text':
      return `Searching for "${String(args.query ?? '')}".`;
    case 'run_command':
      return `Running a verification step: ${target}.`;
    default:
      return `Using ${name}.`;
  }
}

function syntaxCheckFor(filePath: string): { command: string } | undefined {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.py') return { command: `python3 -m py_compile ${shellQuote(filePath)}` };
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return { command: `node --check ${shellQuote(filePath)}` };
  if (ext === '.json') return { command: `python3 -m json.tool ${shellQuote(filePath)}` };
  return undefined;
}

function shellQuote(value: string): string {
  return /^[\w./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Deterministic starter content, keyed off the requested language and prompt. */
export function scaffold(intent: Intent): string {
  const file = intent.filePath ?? '';
  const ext = path.extname(file).toLowerCase();
  const what = intent.query ?? 'the requested behaviour';
  const stamp = 'Generated by the Coding Harness offline planner (mock provider) \u2014 replace with real logic.';

  if (ext === '.py') {
    if (/fib/.test(file + what)) {
      return `"""Fibonacci helper. ${stamp}"""\n\n\ndef fibonacci(n: int) -> list[int]:\n    """Return the first n Fibonacci numbers."""\n    if n <= 0:\n        return []\n    seq = [0]\n    while len(seq) < n:\n        seq.append(1 if len(seq) == 1 else seq[-1] + seq[-2])\n    return seq\n\n\ndef main() -> None:\n    print(fibonacci(10))\n\n\nif __name__ == "__main__":\n    main()\n`;
    }
    if (/factorial/.test(file + what)) {
      return `"""Factorial helper. ${stamp}"""\n\n\ndef factorial(n: int) -> int:\n    if n < 0:\n        raise ValueError("n must be non-negative")\n    result = 1\n    for i in range(2, n + 1):\n        result *= i\n    return result\n\n\nif __name__ == "__main__":\n    print(factorial(5))\n`;
    }
    if (/parse|json|csv/.test(file + what)) {
      return `"""Small parsing utility. ${stamp}"""\n\nimport json\nfrom pathlib import Path\n\n\ndef load_records(path: str | Path) -> list[dict]:\n    """Read a JSON file and return its list of records."""\n    data = json.loads(Path(path).read_text(encoding="utf-8"))\n    if not isinstance(data, list):\n        raise ValueError("expected a JSON array of records")\n    return data\n\n\nif __name__ == "__main__":\n    print(load_records("data.json"))\n`;
    }
    return `"""${what}. ${stamp}"""\n\n\ndef main() -> None:\n    print("${escapeForString(what)}")\n\n\nif __name__ == "__main__":\n    main()\n`;
  }

  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
    return `// ${what}\n// ${stamp}\n\n'use strict';\n\nfunction main() {\n  console.log('${escapeForString(what)}');\n}\n\nif (require.main === module) {\n  main();\n}\n\nmodule.exports = { main };\n`;
  }

  if (ext === '.ts' || ext === '.tsx') {
    return `// ${what}\n// ${stamp}\n\nexport function main(): void {\n  console.log('${escapeForString(what)}');\n}\n\nif (require.main === module) {\n  main();\n}\n`;
  }

  if (ext === '.sh' || ext === '.bash') {
    return `#!/usr/bin/env bash\n# ${what}\n# ${stamp}\nset -euo pipefail\n\nmain() {\n  echo "${escapeForString(what)}"\n}\n\nmain "$@"\n`;
  }

  if (ext === '.md') {
    return `# ${titleCase(what)}\n\n${stamp}\n\n## Overview\n\n${titleCase(what)}.\n\n## Usage\n\n1. Describe how to install the project.\n2. Describe how to run it.\n3. Describe how to run the tests.\n`;
  }

  if (ext === '.html') {
    return `<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="utf-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1" />\n    <title>${escapeForString(what)}</title>\n  </head>\n  <body>\n    <!-- ${stamp} -->\n    <h1>${escapeForString(what)}</h1>\n  </body>\n</html>\n`;
  }

  if (ext === '.json') {
    return `${JSON.stringify({ name: 'new-config', description: what, values: [] }, null, 2)}\n`;
  }

  if (ext === '.yml' || ext === '.yaml') {
    return `# ${what}\n# ${stamp}\nname: ${slugify(what)}\non: [push]\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n`;
  }

  return `# ${what}\n# ${stamp}\n`;
}

function escapeForString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/["']/g, "'").replace(/\n/g, ' ').slice(0, 120);
}

function titleCase(value: string): string {
  return value.replace(/\s+/g, ' ').trim().replace(/^./, (c) => c.toUpperCase());
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

export type { ToolCall };
