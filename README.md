# Coding Harness — a coding agent for VS Code

A self-contained coding-agent extension. You give it a prompt; it plans, inspects your workspace,
edits files and runs commands through a small, sandboxed tool set — asking for approval on anything
that changes state.

It ships with three interchangeable model backends (any OpenAI-compatible endpoint, Anthropic, and an
offline rule-based planner) so it works with a cloud API, a local model through Ollama/LM Studio, or
with no API key at all.

Model output **streams token by token** into the panel, and a live activity strip always shows the
current phase - thinking, which tool is running, what it is touching, and for how long. When the
backend exposes a reasoning stream it renders in its own **thinking lane** above each answer: expanded
and following along while it is written, then collapsed to a one-line summary once the answer lands.

```
 ┌──────────────┐   prompt    ┌──────────────────────────────────────────────┐
 │  Agent panel │ ──────────► │  HarnessSession (core/agent.ts)              │
 │  (webview)   │ ◄────────── │   build prompt → model → tool calls → repeat │
 └──────┬───────┘   events    └───────────────┬──────────────────────────────┘
        │                                     │ ToolContext
        │ approval cards                      ▼
 ┌──────▼───────┐                    ┌─────────────────────────┐
 │ ApprovalSvc  │ ◄──── ctx.approval │ tools: list/read/search │
 │ (diff modal) │                    │ write/replace/delete    │
 └──────────────┘                    │ run_command/diagnostics │
                                     └─────────────────────────┘
```

## Quick start

1. **Install it**

   Download `coding-harness.vsix` from the [Releases page](https://github.com/binief/vs-code-agent/releases/latest) and install it:

   ```bash
   code --install-extension coding-harness.vsix
   ```

   Or build it yourself from source:

   ```bash
   npm install
   npm run compile
   npm run package            # writes coding-harness.vsix
   code --install-extension coding-harness.vsix
   ```

   > The repository holds source only; the packaged extension is attached to each release by
   > `.github/workflows/release.yml` (push a `v*` tag, or run the workflow manually). Building it
   > yourself always works too — that is the same command the release workflow runs.

   Or press **F5** in this folder to launch an Extension Development Host (it opens
   `playground/`, a scratch project made for experimenting).

2. **Point it at a model** — run the command *Coding Harness: Set API Key* (value goes to VS Code
   secret storage, never to `settings.json`), or edit settings:

   | Backend | `codingHarness.provider` | `codingHarness.baseUrl` | `codingHarness.model` |
   | --- | --- | --- | --- |
   | OpenAI / OpenRouter / Groq / vLLM | `openai` | `https://api.openai.com/v1`, `https://openrouter.ai/api/v1`, … | `gpt-4o-mini`, `qwen3-coder`, … |
   | Ollama (local) | `openai` | `http://localhost:11434/v1` | `qwen2.5-coder:14b` |
   | LM Studio / llama.cpp server | `openai` | `http://localhost:1234/v1` | your loaded model id |
   | Anthropic | `anthropic` | `https://api.anthropic.com` | `claude-sonnet-4-5` |
   | Offline demo, no key | `mock` | – | – |

   Environment fallbacks: `HARNESS_API_KEY`, then `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`.

3. **Open the panel**: click the *Coding Harness* icon in the activity bar (or `Ctrl+Alt+K`, or
   *Coding Harness: Open Agent Panel*) and describe a task.

## Tools the agent can use

| Tool | What it does | Approval |
| --- | --- | --- |
| `list_files` | List files/dirs, glob filters, skips `node_modules`, `dist`, `.git`, … | never |
| `read_file` | Line-numbered reads (slices, size/binary guards, directory listing); displays CRLF/CR files as LF | never |
| `search_text` | Ripgrep-style content search with `path:line:` results | never |
| `write_file` | Create/overwrite/append a whole file; preserves existing line endings | per `editPolicy` |
| `replace_in_file` | Exact-snippet replacement with line-ending-aware matching; preserves the file style | per `editPolicy` |
| `delete_file` | Remove one file | always |
| `run_command` | Shell command in the workspace, with timeout and exit-code capture | per `commandPolicy` |
| `get_diagnostics` | Current errors/warnings from the editor's language servers | never |
| `open_file` | Reveal a file/line in the editor | never |

Every write shows a diff — inline in the chat card and, on request, in VS Code's native diff editor.

### Cross-platform line endings

The file tools use a canonical LF representation for model matching and display. A CRLF or CR file can
therefore be edited with the LF snippet returned by `read_file`; `replace_in_file` accepts either LF or
CRLF or CR in `old_text` and writes the replacement back using the file's dominant existing style. `write_file`
also preserves the existing style when overwriting or appending. New files use the host OS style by default.
Use `codingHarness.lineEndings` to force `lf`, `crlf`, `cr`, or `native` when a project requires a specific
format.

## Safety model

Being an agent that edits code and runs shell commands, the interesting part is what it *cannot* do:

- **Workspace confinement.** Every path is resolved against the workspace root; absolute paths,
  `../` escapes and symlink getaways are refused (see `src/core/paths.ts`). Opt out with
  `codingHarness.allowOutsideWorkspace`.
- **Approval gates.** Edits follow `editPolicy` (`ask` by default → diff + Apply/Reject), commands
  follow `commandPolicy` (`auto-safe` → read-only commands run silently, everything else asks).
  "Always for this session" remembers the choice per tool up to a window reload.
- **Hard deny-list.** `rm -rf /`, `mkfs`, `dd of=/dev/…`, `curl … | sh`, fork bombs, `git clean -fdx`
  and friends are refused outright even under `auto-all`.
- **Checkpoints.** The original content of every touched file is captured before the first write, so
  *Coding Harness: Revert Changes From Last Task* (or the **Revert** button) undoes a whole task,
  including deleting files it created.
- **Secrets.** API keys live in VS Code's secret storage, not in workspace settings.
- **No hidden network.** The only outbound calls are to the model endpoint you configure; tools never
  reach the network except through `run_command`, where you can see and gate the exact command line.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `codingHarness.provider` | `openai` | `openai` \| `anthropic` \| `mock` |
| `codingHarness.baseUrl` | `https://api.openai.com/v1` | Endpoint for OpenAI-compatible APIs |
| `codingHarness.model` | `gpt-4o-mini` | Model id |
| `codingHarness.apiKey` | `""` | Prefer the Set API Key command; env vars also work |
| `codingHarness.maxSteps` | `12` | Model turns per task (the last turn is forced to summarise) |
| `codingHarness.temperature` / `maxOutputTokens` | `0.2` / `2048` | Sampling and response cap |
| `codingHarness.editPolicy` | `ask` | `ask` \| `auto` for file writes and deletes |
| `codingHarness.commandPolicy` | `auto-safe` | `auto-safe` \| `ask` \| `auto-all` \| `deny-all` |
| `codingHarness.allowDangerousCommands` | `false` | Turn the hard deny-list into "always ask" |
| `codingHarness.commandTimeoutMs` | `60000` | Shell timeout |
| `codingHarness.allowOutsideWorkspace` | `false` | Let the file tools leave the workspace |
| `codingHarness.maxFileBytes` | `262144` | Skip files larger than this |
| `codingHarness.lineEndings` | `auto` | Preserve existing style; `lf` \| `crlf` \| `cr` \| `native` override it |
| `codingHarness.includeDiagnosticsInPrompt` | `true` | Send current errors with each task |
| `codingHarness.stream` | `true` | Render output token by token; off = one response per turn |
| `codingHarness.showThinking` | `true` | Show the model's reasoning lane when the backend provides one |
| `codingHarness.systemPromptExtra` | `""` | Project conventions appended to the system prompt |

## Commands

| Command | Notes |
| --- | --- |
| *Coding Harness: New Task…* | `Ctrl+Alt+K`; focuses the panel and asks for the prompt |
| *Coding Harness: Open Agent Panel* | Reveals the view |
| *Coding Harness: Run Task (quick input)* | Runs without stealing focus |
| *Coding Harness: Ask About Selection* | Editor context menu; wraps the selection in a prompt |
| *Coding Harness: Revert Changes From Last Task* | Restores files, deletes ones it created |
| *Coding Harness: Set API Key* | Secret storage; empty value clears it |
| *Coding Harness: Show Log* | Output channel with the full session log |

## How a task runs

1. `HarnessController.run(prompt)` creates/reuses a `HarnessSession` (history persists across prompts).
2. `CheckpointStore.begin()` marks the start; every file written thereafter is captured first.
3. `buildSystemPrompt()` assembles the rules, a project snapshot (manifests, scripts, deps, git
   branch), the tool catalogue and current diagnostics.
4. The provider is called with the transcript + tool JSON schemas.
5. Text arrives through `onDelta` and is rendered as it is produced (repaints are throttled to about
   16/second); the activity strip switches to the running tool with a live elapsed timer.
6. Each requested tool call is parsed (tolerant JSON), executed with a `ToolContext`, and its result
   is appended to the transcript. Mutating tools call `ctx.approval()` first.
7. Repeat until the model stops calling tools or `maxSteps` is hit — on the last turn tools are
   withheld so the model must summarise.
8. Events stream to the panel; `done` reports the outcome and the files changed.

Streaming is SSE parsing in both providers (`readOpenAiStream`, `readAnthropicStream`). Some gateways
ignore `stream: true` and answer with plain JSON; that is detected from the response Content-Type and
parsed in one piece, so nothing breaks. In the panel, streamed fragments accumulate into one bubble
whose text is finalised when the turn ends — no duplicated or half-rendered messages. Set
`codingHarness.stream` to `false` to skip streaming entirely. The offline planner types its text out
word by word, so the harness demonstrates the same progressive rendering without any model.

### Reasoning streams

`ChatRequest.onThinking` is a second, independent channel from `onDelta`, because reasoning is shown
differently and must never be treated as the answer:

- **OpenAI-compatible**: `reasoning_content` (DeepSeek, vLLM, Kimi) or `reasoning` (OpenRouter and
  some gateways), read from both streaming deltas and single responses.
- **Anthropic**: `thinking` content blocks and `thinking_delta` chunks. `signature_delta` chunks are
  skipped rather than displayed.
- **Offline planner**: narrates a rationale per step, so the lane can be exercised without a model.

Deliberately **display-only**: reasoning is never appended to the transcript sent back to the model, so
it cannot be mistaken for conversation history. Turn it off with `codingHarness.showThinking: false`.

### Panel behaviour

The message list is the only scroll container (`html`/`body` are `overflow: hidden`), and its children
are pinned with `flex: 0 0 auto`. Children of a column flex container shrink by default, which used to
compress every bubble as the transcript grew instead of scrolling. Auto-follow also yields: scroll up
to read earlier output and the view stays put, with a **Jump to latest** button to re-stick.

## Headless use (no editor)

The whole agent lives in `src/core` with no `vscode` import, so you can drive it from a terminal:

```bash
npm run compile
node out/demo/cli.js "create a python script called fib.py that prints fibonacci" --provider mock --auto --dir ./playground
node out/demo/cli.js "fix the failing test" --provider openai --model gpt-4o-mini --dir .
```

`--auto` approves everything (good for CI smoke tests), otherwise it prompts on stdin and prints the
diff before asking. Model text streams to the terminal as it arrives; `--no-stream` waits per turn.

## Development

```bash
npm install
npm run compile        # tsc → out/
npm test               # unit tests (paths, policy, line endings, tools, agent loop, providers, manifest)
npm run watch          # incremental compile while you hack
npm run package        # build a .vsix
```

Layout:

```
src/core/            no vscode imports — unit-testable, reusable
  agent.ts           the loop (HarnessSession)
  prompt.ts          system prompt + project snapshot
  paths.ts           workspace confinement / globbing
  policy.ts          command classification (safe / ask / deny)
  checkpoints.ts     revert support + diff previews
  tools/             the 9 tools, one file per group
  providers/         openai.ts, anthropic.ts, mock.ts
src/vscode/          the editor integration
  controller.ts      session + transcript items + settings/keys
  chatView.ts        webview view (HTML/CSP) and message handling
  host.ts            HarnessHost impl + approval service
  proposals.ts       virtual documents for diff previews
media/               chat.css / chat.js (no bundler)
src/test/            node --test suites (paths, policy, tools, loop, SSE
                     streaming, panel messages via a stubbed vscode, webview
                     layout/rendering rules and markup structure)
playground/          toy project for the F5 sandbox
```

### Adding a tool

```ts
export const wordCountTool: Tool<{ path: string }> = {
  name: 'word_count',
  description: 'Count words in a file. Use it when the user asks about file size in words.',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  async run(args, ctx) {
    const target = resolveWorkspacePath(ctx.root, args.path, { allowOutside: ctx.config.allowOutsideWorkspace });
    const words = fs.readFileSync(target.abs, 'utf8').split(/\s+/).filter(Boolean).length;
    return ok(`${words} words in ${target.rel}`, `${words} words`, { relPath: target.rel });
  },
};
```

Register it in `createDefaultTools()` (`src/core/tools/index.ts`) — the prompt, the provider schemas
and the panel pick it up automatically. Call `await ctx.approval({...})` before any side effect.

### Adding a provider

Implement `Provider` (`id`, `label`, `chat(req)`) and return `{ text, toolCalls, usage }`; add a case
in `createProvider()` (`src/core/providers/index.ts`). `mock.ts` is a compact reference.

## Limitations worth knowing

- **Single workspace folder.** The first folder of a multi-root workspace is the sandbox root.
- **The mock provider is not a model.** It pattern-matches the prompt, writes sensible starter files
  and narrates a canned rationale; it exists to demo and test the harness, not to write production
  code. Real reasoning needs a backend that emits one (DeepSeek-R1, o-series, Claude with extended
  thinking), enabled on the provider side.
- **Revert vs. your own edits.** Reverting restores the pre-task content of *touched* files. If you
  edited those files yourself after the agent did, your changes in them are replaced (checkpoints are
  per task, not per change).
- Writes go through a `WorkspaceEdit` so `Ctrl+Z` works. If a file is open with unsaved manual edits,
  an agent write will replace them — save first if that matters.
- Approval prompts appear in the panel when it is visible, otherwise as a modal dialog.

## License

MIT.
