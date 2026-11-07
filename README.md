# Coding Harness — tools for coding, in VS Code

Coding Harness is a **tool harness**, not a packaged assistant. It can give a model a workspace-scoped
set of coding tools — create, read, search and edit files, run shell commands, query the editor's
diagnostics and call MCP servers — plus a factual snapshot of the environment, the workspace and the
files you have open.

General agent instructions come from files in your workspace (or an optional user-level file) —
`AGENTS.md`, `agent.md`, or any Markdown file you put in `.agents/` (for example `code-review.md`,
`test.md`). The harness also sends tool schemas and operational messages for recovery
and LLM summarization; it is not literally free of all model-facing prompts. Edit your agent files
to define the task behavior.

It works with any OpenAI-compatible endpoint, Anthropic, or the offline planner, so you can use a
cloud API, a local model through Ollama/LM Studio, or no API key at all.

Model output **streams token by token** into the panel, and a live activity strip always shows the
current phase — thinking, which tool is running, what it is touching, and for how long. When the
backend exposes a reasoning stream it renders in its own **thinking lane** above each answer.

```
 ┌──────────────┐   prompt    ┌──────────────────────────────────────────────┐
 │  Agent panel │ ──────────► │  HarnessSession (core/agent.ts)              │
 │  (webview)   │ ◄────────── │   context + agent files → model → tools     │
 └──────┬───────┘   events    └───────────────┬──────────────────────────────┘
        │                                     │ ToolContext
        │ approval cards                      ▼
 ┌──────▼───────┐                    ┌─────────────────────────┐
 │ ApprovalSvc  │ ◄──── ctx.approval │ create / read / search  │
 │ (diff modal) │                    │ edit / delete / command │
 └──────────────┘                    │ diagnostics + MCP tools │
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

   Or press **F5** in this folder to launch an Extension Development Host (it opens
   `playground/`, a scratch project made for experimenting).

2. **Point it at a model** — run *Coding Harness: Set API Key* (the value goes to VS Code secret
   storage, never to `settings.json`), or edit settings:

   | Backend | `codingHarness.provider` | `codingHarness.baseUrl` | `codingHarness.model` |
   | --- | --- | --- | --- |
   | OpenAI / OpenRouter / Groq / vLLM | `openai` | `https://api.openai.com/v1`, `https://openrouter.ai/api/v1`, … | `gpt-4o-mini`, `qwen3-coder`, … |
   | Ollama (local) | `openai` | `http://localhost:11434/v1` | `qwen2.5-coder:14b` |
   | LM Studio / llama.cpp server | `openai` | `http://localhost:1234/v1` | your loaded model id |
   | Anthropic | `anthropic` | `https://api.anthropic.com` | `claude-sonnet-4-5` |
   | Offline demo, no key | `mock` | – | – |

   Environment fallbacks: `HARNESS_API_KEY`, then `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`.

3. **Write `agent.md`** (or `AGENTS.md`) in the workspace root. This is where the instructions live:

   ```markdown
   ---
   tools: [read, search, edit, execute]
   ---
   # Project instructions

   - Use TypeScript and the existing `pnpm` scripts.
   - Run `pnpm test -- <file>` after changing a source file.
   - Keep comments in the imperative mood; do not reformat unrelated code.
   - Never edit `generated/` by hand — run `pnpm generate` instead.
   ```

   Click **Agents** in the panel (or run *Coding Harness: Open Agent Instructions*) to open the
   files that are currently loaded; if none exist it offers to create one.

4. **Open the panel**: click the *Coding Harness* icon in the activity bar (or `Ctrl+Alt+K`, or
   *Coding Harness: Open Agent Panel*) and describe a task.

## Agent instruction files

Agent files define project-specific instructions and optional tool permissions. If none is found,
the panel shows an `agents: none` chip and the model receives context and operational
recovery messages, but no project-specific agent instructions or tools. Add YAML tool permissions
to a selected agent file to enable tools.

### Discovery rules

Every task re-reads the files, so edits take effect on the next prompt without a reload. **The name
is never fixed** — `code-review.md` and `test.md` are just as valid as `agent.md`, as long as the
file is found one of the ways below.

1. **A known name, anywhere we look** — `AGENTS.md`, `agent.md`, `agents.md` and
   `copilot-instructions.md` by default, matched case-insensitively (`Agents.MD` works). Configure
   with `codingHarness.agentFiles.names`.
2. **Any name, in an instruction folder** — every `.md` file inside `.agents/`, `.agent/`,
   `.github/instructions/` or `.vscode/instructions/` is loaded, recursively, whatever it is called:

   ```
   .agents/code-review.md
   .agents/test.md
   .agents/workflows/release.md
   .github/instructions/go-style.md
   ```

   This is the recommended way to use your own names: nothing to configure, and ordinary Markdown
   elsewhere in the repo (`README.md`, `.github/PULL_REQUEST_TEMPLATE.md`) is left alone.
3. **A glob pattern, anywhere** — `codingHarness.agentFiles.patterns` (default
   `["*.instructions.md"]`) matches workspace-relative paths. Add your own:

   ```jsonc
   "codingHarness.agentFiles.patterns": [
     "*.instructions.md",
     "docs/rules/*.md",        // one directory
     "**/code-review.md",      // any depth
     "*.md"                    // every Markdown file at the workspace root
   ]
   ```

4. **An explicit path** — anything listed in `codingHarness.agentFiles.extraPaths` is loaded as-is,
   even with a name no rule matches and even from outside the workspace.

Where files are looked for:

- **Root and config directories** — the workspace root, then `.github/`, `.vscode/`, `.agents/` and
  `.agent/`.
- **Open editors** — any instruction file in the ancestor chain of an open editor is loaded, at any
  depth. Opening `packages/api/src/index.ts` pulls in `packages/api/agent.md`. This keeps unrelated
  subprojects out of the prompt.
- **Scan everything (optional)** — set `codingHarness.agentFiles.scanNested` to `true` to walk every
  subdirectory down to `codingHarness.agentFiles.maxDepth` (default `2`). Dependency and build
  directories (`node_modules`, `dist`, `.git`, `target`, `vendor`, …) are never scanned.
- **Outside the workspace** — `codingHarness.agentFiles.extraPaths` accepts absolute paths
  (`/srv/shared/agent.md`), `~/` paths and `../` paths relative to the workspace root. Those files
  come last in the prompt and are labelled "explicit file outside the workspace".
- **User-level file** — enable `codingHarness.agentFiles.includeUser` to load
  `~/.coding-harness/agent.md` (path configurable) into every workspace. It is rendered first.

How the files are used:

- **Order** — user-level file, then the workspace from the root outwards, then external files. More
  specific files come later, so a `src/` rule can refine a root rule.
- **Scope** — a file at the root, or in a top-level config/instruction folder, applies to the whole
  workspace; a file in an ordinary directory applies to that subtree. A package that keeps its own
  `.agents/` scopes those rules to the package (`packages/api/.agents/review.md` → `packages/api`).
  The prompt labels each file, e.g. `## .agents/code-review.md — applies to the whole workspace`.
- **Front matter (optional)** — a leading `---` block may carry `description` and `applyTo`. It is
  used as a label in the prompt and is *not* sent as instruction text, so a tool that reads those
  keys (like Copilot's `applyTo`) stays compatible:

  ```markdown
  ---
  description: Review checklist
  applyTo: "**/*.ts"
  ---
  Review every TypeScript change for error handling.
  ```

  A file with no recognised keys is sent verbatim — a Markdown horizontal rule is never stripped.
- **Budgets** — `maxBytes` (default 64 KB per file) truncates a large file; `maxTotalBytes`
  (default 128 KB) skips files that would not fit whole. Nothing is cut off mid-instruction.

Agent files are read as UTF-8 text and line endings are normalized for the prompt. A symlink inside
the workspace that resolves to a file outside it is refused (reported in the log), because otherwise
`agent.md` could silently pull in instructions from anywhere on disk; the refusal does not apply to
paths you added to `extraPaths` yourself.

### Naming examples

| You have | How it loads |
| --- | --- |
| `AGENTS.md`, `agent.md`, `agents.md` | default names, root or any scanned directory |
| `.agents/code-review.md` | instruction folder — any `.md`, no config |
| `.agents/test.md` | instruction folder — any `.md`, no config |
| `.github/instructions/go-style.md` | instruction folder — any `.md`, no config |
| `docs/rules/api.md` | set `agentFiles.patterns` to `docs/rules/*.md` |
| `code-review.instructions.md` (root) | default pattern `*.instructions.md` |
| `handbook.md` (root) | add `*.md` to `agentFiles.patterns`, or set it as `extraPaths` |
| `../shared/agent.md` | `agentFiles.extraPaths` |
| `~/team/agent.md` | `agentFiles.includeUser` + `userPath`, or `extraPaths` |

### Choosing which files are sent

Discovery decides what *could* be loaded; the `agents:` chip decides what actually goes into the next
prompt. By default every discovered file is merged, in root-to-leaf order, each under its own heading.

Click the chip to pin a subset — for example `agent.md` for general work, or `.agents/code-review.md`
when the task is a review, even though both live in the same repository. The chip then reads
`agents: 1/2` (active/discovered), and the system message states the pin explicitly:

```
2 file(s), 3.4 kB. … The user pinned this selection: 2 of 3 discovered file(s) are included;
the rest were deliberately left out.
```

- The pin is stored in `workspaceState`, so it survives a window reload but does not leak into other
  repositories the way a global setting would. "Use every discovered file" clears it.
- If a pinned file is missing or unreadable, the task stops instead of silently changing the
  selection and potentially broadening permissions. Restore the file or explicitly choose another selection.
- Discovery is unchanged, so nothing needs a fixed name and nothing outside the workspace is read
  unless it was opted in.
- *Preview System Context* shows exactly the pinned set, which is the quickest way to check what the
  model will actually be told.

### Tool permissions in agent files

An agent file can declare permitted tool groups in YAML front matter (block or inline lists):

```yaml
---
description: Read-only reviewer
tools:
  - read
  - search
---
Review the code and report findings without modifying files.
```

The list is enforced both when presenting tools to the model and when executing its calls. Available
groups are `read` (`list_files`, `read_file`, `get_diagnostics`, `open_file`), `search` (`list_files`,
`search_text`), `edit` (`create_file`, `write_file`, `replace_in_file`, `delete_file`), `execute`
(`run_command`), `mcp` (all registered `mcp_` tools), and `subagent` (`delegate_task`, when enabled). You may instead name exact registered tools.
`tools: []`, no selected files, or no selected file with a `tools` declaration permits no tools.
In the panel, choosing “Use every discovered file” selects all discovered files.

When several selected files declare `tools`, their permissions intersect, even when their instruction
scope is narrower: the policy applies to the whole task. A file without a declaration does not grant
or further restrict tools. Agent files are reloaded for each task. Unknown or malformed metadata,
truncated selected files, missing pins, and skipped files in default all-files mode stop the task rather
than silently grant access.

**Important:** This is a tool-name allowlist, not a sandbox. `execute` can run shell commands that
modify files, and MCP servers may have arbitrary side effects, even when `edit` is absent. Existing
command, edit and approval settings still apply to their respective built-in tools. Natural-language
instructions alone do not enforce read-only access. In particular, a list that includes `edit`,
`execute`, and `mcp` explicitly permits those capabilities; remove them for a read-only reviewer.

### Optional read-only subagents

Subagents are **off by default**. In the chat panel, click **Settings** (sliders icon), enable
**Read-only subagents**, and save. The same switch is available as `codingHarness.subagents.enabled`
in VS Code Settings. Also explicitly allow `subagent` (or `delegate_task`) alongside the read/search
tools in the selected agent file's YAML:

```yaml
---
tools: [read, search, edit, execute, subagent]
---
```

Every selected file that declares tools must permit delegation: their permissions still intersect.
The main agent decides whether to call `delegate_task`, supplying a focused task and any relevant
context. Each call runs a separate, sequential subagent conversation with the same model, workspace
and selected instruction snapshot. Parent chat history and images are not automatically included.
Only permitted built-in `list_files`, `read_file`, `search_text` and `get_diagnostics` are available
to the subagent. It cannot edit, run commands, use MCP, open files in the editor, or delegate again.
Its file access follows the existing workspace and outside-workspace settings. If no read-only tool is
permitted, delegation fails instead of guessing.

Only the child’s final findings and any warnings are sent back to the main conversation; the child’s
intermediate transcript is not saved in the chat. When the model actually delegates, the activity strip
shows **Subagent working**, and the `delegate_task` tool card and notices show its task and outcome.
Enabling the switch alone does not force delegation. Child model usage is included in the session total. Cancellation of the main task also cancels the
child, subject to the provider honoring cancellation. These findings are unverified and may omit or
misstate details; the main agent should inspect evidence when necessary. Additional model calls can
increase time and cost. The offline mock planner does not autonomously decide to delegate.

If saving these panel settings reports that a `codingHarness` setting is not registered, stop or finish
any running task and run **Developer: Reload Window**, then try again. VS Code may not yet have loaded
an updated extension's setting contributions. If reloading does not help, confirm the intended Coding
Harness version is installed and enabled in the active extension host (local or remote), reinstall it
if necessary, and reload. The panel checks both feature settings before writing; if a later write fails,
it reports whether some settings may already have changed.

### Commands

| Command | What it does |
| --- | --- |
| *Coding Harness: Open Agent Instructions* | Opens a loaded file (quick pick when several), or offers to create `agent.md` |
| *Coding Harness: Reload Agent Instructions* | Rediscovers the files and shows how many bytes were loaded |
| *Coding Harness: Preview System Context* | Opens the system message that will be sent with the next task (the tool catalogue follows the live session when one exists) |

The **Agents** header button opens a loaded file (the first command). The `agents:` chip opens the
picker described above. Click the `ctx` chip to preview the context.

## What the model receives

For each task the extension builds a system message with five factual sections, followed by the
instructions:

| Section | Contents | Setting |
| --- | --- | --- |
| `# Environment` | OS, release, architecture, shell, Node.js version, editor version, local time, git branch/HEAD and uncommitted changes, workspace trust, approval policies, line-ending policy and workspace confinement | `codingHarness.context.environment` |
| `# Workspace` | Top-level layout plus manifest facts: `package.json` name/package manager/scripts/dependencies, and the head of `pyproject.toml`, `Cargo.toml`, `go.mod`, `Makefile`, … | `codingHarness.context.workspace` |
| `# Files` | Active file (language, line count, unsaved state, selection line range), other open editors, current diagnostics, file-size limit | `codingHarness.context.files`, `codingHarness.context.diagnostics` |
| `# Tools` | Tool names and descriptions, edit/command policies | `codingHarness.context.tools` |
| `# Agent instructions` | The contents of every loaded agent file, labelled with path and scope | `codingHarness.agentFiles.enabled` |

Permitted tool JSON schemas are sent to the provider as the API's `tools` parameter; the `# Tools`
section is a readable catalogue on top of that. Turn individual context sections off when a model
does not need them — for example `context.workspace: false` for a tiny local model with a small
context window.

The system message does not add a general persona or response format; the harness can also send
operational recovery messages during a task and a dedicated summarization prompt
when compacting history.

## Tools the agent can use

| Tool | What it does | Approval |
| --- | --- | --- |
| `list_files` | List files/dirs, glob filters, skips `node_modules`, `dist`, `.git`, … | never |
| `read_file` | Line-numbered reads (slices, size/binary guards, directory listing); displays CRLF/CR files as LF | never |
| `search_text` | Text/JavaScript-regex search with `path:line:` results, optional multiline matching and skip/limit diagnostics | never |
| `create_file` | Create a new file; fails if the path already exists | per `editPolicy` |
| `write_file` | Overwrite or append a whole file; preserves existing line endings | per `editPolicy` |
| `replace_in_file` | Exact-snippet replacement with line-ending-aware matching; preserves the file style | per `editPolicy` |
| `delete_file` | Remove one file | always |
| `run_command` | Shell command in the workspace, with timeout and exit-code capture | per `commandPolicy` |
| `get_diagnostics` | Current errors/warnings from the editor's language servers | never |
| `open_file` | Reveal a file/line in the editor | never |

`read_file` returns budget-aware pages rather than silently clipping a long line. When a result says
`next_line` and `next_column`, call `read_file` again with those values as `start_line` and
`start_column` (columns count Unicode code points). The per-file `codingHarness.maxFileBytes` limit
still applies even to a slice. Files can change between page requests.

Tools may limit or paginate their own output. Large tool results count toward the model's context;
LLM compaction can summarize earlier complete tool groups without rerunning tools.

Every write shows a diff — inline in the chat card and, on request, in VS Code's native diff editor.

Tools from MCP servers join this set, prefixed `mcp_<server>_<tool>` (see
[MCP servers](#mcp-servers-model-context-protocol)).

### Cross-platform line endings

The file tools read UTF-8 from disk and use a canonical LF representation for matching and display.
With `codingHarness.lineEndings: auto`, `replace_in_file` matches regardless of LF, CRLF or CR and
preserves all text outside each replacement, including mixed line endings. Newlines inside replacement
text use the first existing line ending at or after the match (or the preceding one, or the native
style if the file has none). Append preserves existing mixed endings and uses the dominant style for
new text. A full `write_file` overwrite replaces the entire body and uses the dominant existing style;
new files use the host OS style. Explicit `lf`, `crlf`, `cr`, or `native` settings normalize the whole
written file intentionally.

`replace_in_file` still requires exact text (apart from line-ending normalization) and a unique match
by default; ambiguous snippets are rejected unless `count` explicitly specifies the first N or `-1`
for all. Text edits and appends reject invalid UTF-8 rather than silently corrupting bytes. Writes
are refused if the file changed while awaiting approval. The VS Code host also refuses to overwrite an
open document with unsaved changes. Save it before using these tools; reads and searches see disk, not
unsaved editor contents.

VS Code text edits and save-time formatters can alter line endings or other text. Replacements and
appends therefore write directly to disk. So do mixed/CR-only or BOM content, newly created files,
and writes where the editor's line ending or encoding differs from the requested UTF-8 content
(or its encoding cannot be determined). Such writes bypass the editor's text undo stack; the harness checkpoint/revert
still applies. Shell commands and MCP tools use their own file and line-ending behavior.

### Text search

`search_text` defaults to a line-by-line search. Set `is_regex: true` for JavaScript regular
expressions. Set `multiline: true` to search the entire LF-normalized file and allow matches across
lines; in this mode `^` and `$` match line boundaries, while `.` does not match newlines. For example,
`border-radius:\s+12px` searches whitespace within a line, and `first\s+second` with multiline enabled
can match across a line break. Regex patterns see LF rather than CRLF; use `\n` rather than `\r\n`
for a line break. `context_lines` includes surrounding lines. Default mode counts matching lines;
multiline mode counts matches.

Results report search mode, skipped entries by reason, unreadable/binary/non-UTF-8 files, directory
traversal limits, cancellation, and clipped output. Directory searches skip hidden and ignored paths
and apply the glob and file-size filters; direct file searches also enforce
`codingHarness.maxFileBytes`. Traversal is limited to 12 directory levels and 6000 entries, and output
is bounded. An empty result can therefore mean the relevant file was not scanned, not just that the
pattern was absent. Regexes run with JavaScript's engine, not ripgrep's; complex expressions can be
slow. Search and read tools do not inspect unsaved editor changes.

## MCP servers (Model Context Protocol)

MCP servers add tools to the same loop — local ones spawned as processes (**stdio**) and remote ones
reached over the network (**http** / **sse**). Their tools are prefixed `mcp_<server>_<tool>` so the
prompt and panel always show where a tool came from.

### Configure from workspace files

MCP servers are read from these files by default (set `codingHarness.mcp.configFiles` to change it):

- `.vscode/mcp.json` — the VS Code shape, `{ "servers": { … }, "inputs": [ … ] }`
- `.mcp.json` — the Claude/Cursor shape, `{ "mcpServers": { … } }`
- `mcp.json` — either shape

```jsonc
// .vscode/mcp.json
{
  "servers": {
    "filesystem": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "${workspaceFolder}"]
    },
    "remote-tools": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ${env:MCP_TOKEN}" }
    }
  }
}
```

Placeholders: `${workspaceFolder}`, `${workspaceFolderBasename}`, `${userHome}`, `${env:VAR}` and
`${input:id}`.

`${input:…}` values are collected from the file's `inputs` array and prompted in the editor. A value
entered once is reused for the session, so a token is never written to disk:

```jsonc
{
  "servers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "${input:github-token}" }
    }
  },
  "inputs": [{ "id": "github-token", "description": "GitHub token", "password": true }]
}
```

Later files override earlier ones, and `codingHarness.mcp.servers` overrides every file with the same
server id. That makes the shared project file the default and your user settings the local override.
The MCP dialog shows file-defined servers as read-only and lets you edit the settings ones.

### Configure via settings.json or the panel

```jsonc
"codingHarness.mcp.enabled": true,
"codingHarness.mcp.timeoutMs": 10000,
"codingHarness.mcp.servers": {
  "filesystem": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
  },
  "remote-tools": {
    "url": "https://mcp.example.com/mcp",
    "headers": { "Authorization": "Bearer <token>" }
  }
}
```

Click **MCP** in the panel header (or the `mcp:` chip) to open the dialog: enable MCP, add/edit/
disable/remove settings-based servers, pick **User** or **Workspace** settings, and watch each
server's live state. Saving reconnects immediately; **Reload** re-reads both settings and config
files and restarts every server.

### Transports

- **stdio** — the server is spawned as a child process and spoken to over stdin/stdout.
- **http** — *Streamable HTTP* (spec 2025-03-26): JSON-RPC POSTed to one endpoint; replies come back
  as JSON or an SSE stream, and session ids plus the negotiated protocol version are echoed on later
  requests. If the endpoint rejects POSTs with a 4xx, the client falls back to the legacy transport.
- **sse** — the legacy HTTP+SSE transport (spec 2024-11-05), forced with `"type": "sse"` or used on
  fallback.

Notes:

- stdio servers need a `command`; http/sse servers need an `http(s)://` `url`. An entry with neither
  fails with a clear error and never blocks the other servers.
- A server that fails to start never breaks the agent run: you get a panel notice, a `failed` badge
  in the dialog, and a log entry; the run continues with the tools that did load.
- Headers and env values live in plain files, so treat bearer tokens the way you would in any other
  project config (use `${input:…}` or `${env:…}` to keep them out of Git).
- The CLI reads the same config files; `--mcp '<json>'` merges an extra server map on top.

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
- **Secrets.** API keys live in VS Code's secret storage, not in workspace settings. MCP inputs are
  prompted and kept in memory.
- **No hidden network.** The only outbound calls are to the model endpoint and, when MCP is enabled,
  the MCP servers you configure; tools never reach the network except through `run_command`, where
  you can see and gate the exact command line.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `codingHarness.provider` | `openai` | `openai` \| `anthropic` \| `mock` |
| `codingHarness.baseUrl` | `https://api.openai.com/v1` | Endpoint for OpenAI-compatible APIs |
| `codingHarness.model` | `gpt-4o-mini` | Model id |
| `codingHarness.apiKey` | `""` | Prefer the Set API Key command; env vars also work |
| `codingHarness.temperature` / `maxOutputTokens` | `0.2` / `2048` | Sampling and response cap |
| `codingHarness.editPolicy` | `ask` | `ask` \| `auto` for file writes and deletes |
| `codingHarness.commandPolicy` | `auto-safe` | `auto-safe` \| `ask` \| `auto-all` \| `deny-all` |
| `codingHarness.allowDangerousCommands` | `false` | Turn the hard deny-list into "always ask" |
| `codingHarness.commandTimeoutMs` | `60000` | Shell timeout |
| `codingHarness.allowOutsideWorkspace` | `false` | Let the file tools leave the workspace |
| `codingHarness.maxFileBytes` | `262144` | Skip files larger than this |
| `codingHarness.lineEndings` | `auto` | Preserve existing style; `lf` \| `crlf` \| `cr` \| `native` override it |
| `codingHarness.stream` | `true` | Render output token by token; off = one response per turn |
| `codingHarness.showThinking` | `true` | Show the model's reasoning lane when the backend provides one |
| `codingHarness.chat.saveEnabled` | `true` | Automatically save and restore the current workspace chat |
| `codingHarness.chat.saveFolder` | `""` | Folder for automatic saves; empty uses VS Code workspace storage |
| `codingHarness.agentFiles.enabled` | `true` | Load agent instructions and tool permissions |
| `codingHarness.agentFiles.names` | `["AGENTS.md","agent.md","agents.md","copilot-instructions.md"]` | Exact names searched (case-insensitive) |
| `codingHarness.agentFiles.patterns` | `["*.instructions.md"]` | Workspace-relative globs, so files can have any name |
| `codingHarness.agentFiles.includeUser` | `false` | Load a user-level agent file in every workspace |
| `codingHarness.agentFiles.userPath` | `~/.coding-harness/agent.md` | Path of that file |
| `codingHarness.agentFiles.scanNested` | `false` | Walk every subdirectory, not just open-editor ancestors |
| `codingHarness.agentFiles.maxDepth` | `2` | Directory levels scanned below the root when `scanNested` is on, and how deep a pattern directory is walked |
| `codingHarness.agentFiles.maxBytes` | `65536` | Per-file cap |
| `codingHarness.agentFiles.maxTotalBytes` | `131072` | Total instruction budget per prompt |
| `codingHarness.agentFiles.extraPaths` | `[]` | Extra files or directories to load |
| `codingHarness.context.environment` | `true` | Include OS/shell/runtime/editor/git/policy facts |
| `codingHarness.context.workspace` | `true` | Include layout and manifest facts |
| `codingHarness.context.files` | `true` | Include open editors, active file and selection |
| `codingHarness.context.diagnostics` | `true` | Include current editor problems |
| `codingHarness.context.tools` | `true` | Include the tool catalogue |
| `codingHarness.mcp.enabled` | `true` | Load tools from MCP servers |
| `codingHarness.mcp.servers` | `{}` | Settings-based server map; see [MCP servers](#mcp-servers-model-context-protocol) |
| `codingHarness.mcp.timeoutMs` | `10000` | Default timeout for MCP tool calls |
| `codingHarness.mcp.loadFromFiles` | `true` | Read servers from workspace config files |
| `codingHarness.mcp.configFiles` | `[".vscode/mcp.json",".mcp.json","mcp.json"]` | Files scanned for servers |
| `codingHarness.subagents.enabled` | `false` | Enable explicitly permitted, read-only subagent delegation |
| `codingHarness.compaction.enabled` | `true` | Enable conversation compaction |
| `codingHarness.compaction.autoCompact` | `true` | Compact automatically near the context limit |
| `codingHarness.compaction.threshold` | `0.75` | Utilisation target; auto-compaction starts earlier to reserve tool-result headroom |
| `codingHarness.compaction.contextWindowTokens` | `128000` | Context window estimate for the meter |
| `codingHarness.compaction.keepLastMessages` | `10` | Preferred recent messages to keep; may be reduced under context pressure |
| `codingHarness.compaction.localFallback` | `false` | Allow lossy local excerpts when LLM compaction fails or when explicitly requested |
| `codingHarness.compaction.summaryModel` | `""` | Optional model on the current provider for LLM summaries; empty uses the active model |

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
| *Coding Harness: Open Agent Instructions* | Opens the loaded agent files or creates `agent.md` |
| *Coding Harness: Reload Agent Instructions* | Rediscovers instruction files now |
| *Coding Harness: Preview System Context* | Inspect the next system message (context + agent files) |
| *Coding Harness: Import Chat…* | Replace the current chat with an exported JSON chat |
| *Coding Harness: Export Chat…* | Save the current chat and its model context to JSON |
| *Coding Harness: Reload MCP Servers* | Re-reads config files + settings and reconnects |

## How a task runs

1. `HarnessController.run(prompt)` creates/reuses a `HarnessSession` (history persists across prompts).
2. `CheckpointStore.begin()` marks the start; every file written thereafter is captured first.
3. `buildSystemPrompt()` assembles the five context sections and appends the agent files. It
   contains no behavioural fallback.
4. The provider is called with the transcript + tool JSON schemas.
5. Text arrives through `onDelta` and is rendered as it is produced (repaints are throttled to about
   16/second); the activity strip switches to the running tool with a live elapsed timer.
6. Each requested tool call is parsed (tolerant JSON), executed with a `ToolContext`, and its result
   is appended to the transcript. Mutating tools call `ctx.approval()` first.
7. Repeat until the model finishes, the user cancels, or an unrecoverable error occurs. There is no fixed step limit.
8. Events stream to the panel; `done` reports the outcome and the files changed.

A run ends when the model finishes, the user cancels, or an unrecoverable error occurs. There is no
fixed step limit or automatic loop/thinking interruption; long runs can consume significant time and tokens.

- **Transient provider failures are retried.** A 429, 5xx or dropped connection backs off (honouring
  `Retry-After`) and tries again up to three times, with a notice in the panel; only definitive
  failures (401/403/404/400) end the run.
- **A reply cut off by `maxOutputTokens` is continued** instead of being reported as the final answer:
  the partial text stays on screen and the model is told the message was truncated.
- **The transcript is always valid.** Every requested tool call gets a result — including calls
  skipped because the task was cancelled — and `repairToolMessages()` drops any orphaned half before
  the list is sent. Providers reject a transcript with a dangling `tool_calls` entry, so one aborted
  turn used to make the *next* task fail with HTTP 400 before it could run a single tool.
- **Compaction uses bounded LLM summaries.** It summarizes complete tool-call groups, choosing how
  much history to compact against an estimated post-compaction budget rather than blindly keeping a
  fixed number of messages. Under pressure even the latest complete group can be summarized. The
  retained tail stays protocol-valid, the current request is retained verbatim, and original images
  remain attached. Large history is split
  into bounded requests and summaries may be summarized again. Image attachments may require separate
  vision requests. Summary calls cost time and tokens, may lose detail, and are capped at 64 requests
  per compaction. By default a failed or cancelled LLM summary leaves active history unchanged. With
  **Local fallback compaction** enabled in the panel Settings (or `codingHarness.compaction.localFallback`),
  a failed LLM summary instead attempts a bounded local extract of earlier messages. The extract is
  explicitly labelled incomplete and may omit important details; a warning identifies the fallback.
  It preserves the current request, retained recent messages, and image attachments, and is used only
  if the complete resulting context is smaller. Original messages remain in the session and saved
  chat when saving is enabled. Cancellation never triggers fallback. If the model
  produces a complete, smaller summary that exceeds the requested length even after a shorter retry,
  the best reducing summary may be used with a warning. The complete resulting history must still be
  smaller; if the estimated target is missed, a warning says so. The original messages remain in the saved chat as described under Saved chats. The offline mock cannot produce LLM summaries. A rejected summary input can be split further and retried. If a
  provider stops a summary at its output limit, the harness retries with progressively larger bounded
  output budgets (up to 8,192 tokens per request and at most three attempts); reasoning tokens may
  consume part of that budget. Retries can increase cost and still fail if the model cannot complete.
  During manual and automatic compaction, the activity strip shows the current request, attempt,
  elapsed time and whether it is waiting for the provider or receiving streamed output. When streaming
  is enabled, summaries use it for activity updates without displaying the summary or reasoning; a
  backend that buffers responses may still show only "waiting for provider". Open **LLM compaction
  details — request and response** below the activity strip to inspect each logical model request,
  streamed response, optional reasoning, finish reason and reported usage. This view may expose
  sensitive conversation text; the diagnostic trace is held in memory and is not saved or exported.
  A successful summary still becomes part of saved conversation history. Request headers and image
  contents are not shown. It keeps the last 10 requests and truncates long displays; use **Clear** to
  discard the view. Clearing during a request hides that request until the next one. When streaming is
  disabled or a backend buffers its response, the response appears only when the provider returns.
  Some providers omit token usage from streamed responses, so reported compaction usage may be incomplete. A long wait can be model
  loading, prompt processing, generation, a queued request, or a stalled backend; check the provider's
  logs. **Stop** cancels compaction and retains the original active history. No timeout is imposed on
  slow models. To bypass an LLM request that is still waiting, press **Stop**, then use **Settings →
  Compact locally now** after enabling local fallback; the lossy operation requires confirmation.
  Summary-model capacity is assumed to match `contextWindowTokens`; a smaller provider/model window,
  image overhead, output reservations, huge fixed instructions or inaccurate estimates can still
  prevent compaction.
- **Context usage is an estimate.** Click `ctx ~` to see approximate system, conversation, image,
  tool-schema, framing, calibration and reserved-output contributions, and to preview the system
  context. The post-task tool estimate uses the last resolved agent policy; before a policy is
  resolved, the estimate is marked provisional. Provider-reported input may adjust the component total.
  The `ctx ~` meter includes estimated tool schemas and reserved output tokens, and uses reported input usage when available. Tokenizers, images, provider accounting,
  and model context sizes vary: set `codingHarness.compaction.contextWindowTokens` to the actual limit
  of the model and endpoint. An inaccurate window setting can still lead to a context-limit error.

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

Answers are rendered as Markdown — headings, ordered/nested lists, tables, blockquotes, links, inline
formatting, and fenced code with per-block **insert** (at the cursor) and **copy** — rather than one
pre-wrapped paragraph. Model output is escaped before any tag is added, so a transcript can never inject
markup into the panel.

Tool calls collapse to a single row (icon, name, primary argument, duration, status colour) and expand
on click to show arguments and output; a failure stays open, a success folds away. Reasoning sits in
its own dashed lane that is expanded while it streams and folds to a one-line preview with its duration
once the answer lands; opening it yourself keeps it open. Select text and press `Ctrl`/`Cmd`+`C`, or
use the copy buttons on messages, code blocks and tool output. Message buttons copy the original
Markdown, including during streaming; they show **Copied** only after VS Code confirms the clipboard
write. The header includes import/export, compact, MCP, agents, revert, new-conversation and settings
actions; the meta row reports provider, policies, instruction files, token count and context use, and
a warning banner offers **Compact** past 75%.

The markup lives in `media/panel.html` (styles in `media/chat.css`, client logic in `media/chat.js`), and
`chatView.ts` only substitutes the CSP, two asset URIs and a nonce — so the UI can be edited as HTML
instead of escaped strings. `src/test/webview.test.ts` holds the layout contract: the transcript
scrolls, its children never shrink, every `getElementById` resolves to an element in the markup, tags
balance, and colours come from theme variables only.

### Saved chats, import and export

By default, the current conversation is saved automatically in VS Code's **workspace-specific
extension storage**, outside the project. Reopen the same folder or workspace after restarting VS Code
to see it again and send a follow-up. Both the visible transcript and the model's conversation history
are restored, including images and tool results; LLM compaction can still apply. Use **Coding Harness:
Show Chat Storage Location** in the Command Palette to see and copy the exact path on the extension host.
There is no separate backup file: original messages are in the `originalHistory` field of that JSON.
If it is absent, check that saving is enabled, the correct workspace is open, and no save warning was
reported; a remote workspace writes on the remote extension host.
If VS Code closes during a task, the latest saved progress is shown as interrupted. Tools and approval
requests are not restarted or applied automatically.

Use the panel's **Settings** button or VS Code Settings to change these user- or workspace-level
preferences:

- **`codingHarness.chat.saveEnabled`** (default `true`) controls automatic saving **and** restoring.
  Set it to `false` to keep the current session in memory only; it will not be restored after closing.
  Turning it off does **not** delete files saved earlier. Delete those files yourself if desired.
- **`codingHarness.chat.saveFolder`** (default `""`) chooses the folder for automatic saves. Leave it
  empty for VS Code's workspace-specific storage (`current-chat.json`). Use an absolute path, a path
  relative to the first workspace folder (for example `.harness/chats`), or `~` for the extension
  host's home directory. In a remote workspace, the path is on the remote host. The folder is created
  as needed, and files are named `coding-harness-chat-<workspace-id>.json` so workspaces using the
  same folder do not overwrite one another.

#### Original conversation and retrieval

The same JSON file contains both compacted active `history` and an `originalHistory` field (not a
separate backup file) of the recorded model-visible user, assistant and tool messages, tool-call
arguments, and attached images.
Compaction replaces only active history, so repeated compactions do not replace those original messages
with summaries. Original messages are kept in memory even with automatic saving disabled. Reopening,
importing, exporting and session recreation carry the original history as well as the active history.
A new conversation clears both from the live chat and, if automatic saving is enabled, overwrites the
current saved chat; exports and files in former save folders are not deleted.

The original archive is **not** automatically sent to the model and no archive-search tools are
provided. Export the chat to inspect its recorded original messages.

The archive preserves the messages the harness recorded, **not** unseen data: outputs clipped inside a
tool, unrequested pages, unsent reasoning or previously compacted-away messages
cannot be reconstructed. Display-only reasoning remains in the visible transcript (which is capped at
400 items), not in `originalHistory`. Existing old-format chats load normally, but their available
history may already be incomplete; the extension records that limitation and shows a warning. Older
extension versions may discard the new archive field when they save, so export a copy before downgrading.
An interrupted autosave may likewise contain only the progress saved before the interruption.

Changes take effect without restarting. Enabling saving or changing its folder saves the current chat
at the selected destination, replacing that workspace's existing file there. It does not load or
replace the live chat, and it leaves the previous destination's file in place. If the current chat
is still untouched and empty, the destination is left unchanged; its saved chat will be loaded on the
next restart. A reset made while saving is off is saved when it is turned back on. Export an existing
chat first if you need to keep it before replacing it.

Use the **Export chat** and **Import chat** buttons in the panel header, or the corresponding commands
in the Command Palette. Manual import and export work even when automatic saving is off. Export creates
a versioned JSON file; import validates the file and asks for confirmation before replacing an
existing chat. Finish or stop a running task before importing or exporting. Automatic saves and
imports/exports are limited to 512 MB. If an automatic snapshot exceeds the limit, saving warns and
leaves the previous file intact; start a new conversation to resume saving. An oversized chat also
cannot be exported through the extension, so copy any unsaved details before resetting.
**New conversation** clears the current saved chat when automatic saving is enabled, so export it first
if you want to keep it. File-change checkpoints are not included in exports or restored after a restart.
API credentials are stored separately in VS Code, not in chat archives; imported chats do not change
project files by themselves.

Chat storage and exports are not encrypted by this extension. They can contain prompts, responses,
reasoning, code, tool output and screenshots, including sensitive information entered or returned in
the conversation. A custom folder inside a repository may be committed or synced; exclude it if
necessary. Review an export before sharing it. API keys configured in Secret Storage or settings are
not intentionally added to the archive.

### Images

Paste a screenshot straight into the composer (`Ctrl`/`Cmd`+`V`), drop an image file onto the panel, or
use **attach image**. Thumbnails stage above the input box and can be removed before sending; an image
on its own is a valid prompt, so you can paste an error dialog and hit Run.

Attachments are inlined as base64 in the next user turn — `image_url` parts for OpenAI-compatible
endpoints, `image` blocks for Anthropic — so the model needs vision support (`gpt-4o`, `gpt-4.1`,
Claude 3+, Llava-class local models, …). PNG, JPEG, GIF and WebP are accepted, up to 5 MB and 8 images
per message; anything else is rejected in the panel with a reason. Each image is budgeted at roughly
800 tokens in the context meter, which keeps auto-compaction honest about what a screenshot costs.

## Headless use (no editor)

The whole agent lives in `src/core` with no `vscode` import, so you can drive it from a terminal:

```bash
npm run compile
node out/demo/cli.js "create a python script called fib.py that prints fibonacci" --provider mock --auto --dir ./playground
node out/demo/cli.js "fix the failing test" --provider openai --model gpt-4o-mini --dir .
node out/demo/cli.js "why does this screenshot look wrong?" --provider openai --model gpt-4o --image ./shot.png
```

The CLI reads `AGENTS.md`/`agent.md` from the target directory and MCP servers from the same config
files as the extension (`.vscode/mcp.json`, `.mcp.json`, `mcp.json`). `--mcp '<json>'` merges a server
map from the command line.

`--auto` approves everything (good for CI smoke tests), otherwise it prompts on stdin and prints the
diff before asking. Model text streams to the terminal as it arrives; `--no-stream` waits per turn.
`--image <path>` attaches a PNG/JPEG/GIF/WebP to the prompt (repeat it for several), using the same
validation as the panel.

## Development

```bash
npm install
npm run compile        # tsc → out/
npm test               # unit tests (paths, policy, tools, agent loop, providers,
                       # panel rendering, manifest)
npm run watch          # incremental compile while you hack
npm run package        # build a .vsix
```

Layout:

```
src/core/            no vscode imports — unit-testable, reusable
  agent.ts           the loop (HarnessSession), retries, context management
  prompt.ts          context-only system message (environment/workspace/files/tools)
  agentFiles.ts      agent.md discovery, scoping, budgets and rendering
  transcript.ts      tool-call/result pairing repair
  compaction.ts      context-window summaries that keep tool groups intact
  paths.ts           workspace confinement / globbing
  policy.ts          command classification (safe / ask / deny)
  checkpoints.ts     revert support + diff previews
  tools/             the 10 built-in tools plus the MCP client (mcp.ts)
                     and workspace MCP config loading (mcpConfig.ts)
  providers/         openai.ts, anthropic.ts, mock.ts, errors.ts (HTTP status
                     and which failures are worth retrying)
src/vscode/          the editor integration
  controller.ts      session + transcript items + settings/keys/agent files
  chatView.ts        webview view (HTML/CSP) and message handling
  host.ts            HarnessHost impl + approval service + workspace context
  proposals.ts       virtual documents for diff previews
media/               chat.css / chat.js (no bundler)
src/test/            node --test suites (paths, policy, tools, loop, SSE
                     streaming, panel messages via a stubbed vscode, webview
                     layout rules, and panel rendering in jsdom)
playground/          toy project for the F5 sandbox
```

### Automated VSIX builds and releases

Every push to `main` (including a merged pull request) runs the **Release VSIX** workflow. It checks
out that exact commit, installs dependencies, runs the full test suite, builds `coding-harness.vsix`,
and uploads it as a GitHub Actions artifact named with the version and commit SHA. A failed test or
build prevents the upload and release. The workflow can also be started manually; a manual run on a
non-`main` branch builds an artifact but does not publish a release.

For a commit on `main`, the workflow creates a GitHub release and attaches the VSIX if the package
version's `v<version>` tag does not already exist. It never overwrites an existing tag or release. If
the version was not incremented, the build is still available as an Actions artifact, but the existing
release remains unchanged. Increment `package.json` **and** `package-lock.json` (for example with
`npm version patch --no-git-tag-version`) before a merge that should publish a new release.

### Test runtime

The release workflow runs the suite on Node 20, the same major as the extension
host for VS Code 1.85, so keep test dependencies compatible with it: `jsdom` is
pinned to `^26` because 30+ requires Node 22.22. A dependency that is newer than
the runner does not fail the install — it fails when a test file tries to load,
which is why the pin matters.

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

Register it in `createDefaultTools()` (`src/core/tools/index.ts`) — the tool catalogue, the provider
schemas and the panel pick it up automatically. Call `await ctx.approval({...})` before any side
effect.

### Adding a provider

Implement `Provider` (`id`, `label`, `chat(req)`) and return `{ text, toolCalls, usage }`; add a case
in `createProvider()` (`src/core/providers/index.ts`). `mock.ts` is a compact reference.

## Limitations worth knowing

- **Agent files define general behavior.** An empty workspace with no `agent.md` gives the model
  tools, context and operational recovery messages, but no project-specific guidance. Write a short
  `agent.md` first; it is the highest-leverage file in the project.
- **Agent file size matters.** Instructions are sent on every turn. Keep them focused (a few KB is
  usually plenty); the budgets are there to protect the context window, but a 100 KB instruction file
  will crowd out code.
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
- **Images need a vision model.** Attachments are sent to the configured backend as-is; a text-only
  model (or the mock planner) will ignore them, and the panel warns when the mock is selected.

## License

MIT.
