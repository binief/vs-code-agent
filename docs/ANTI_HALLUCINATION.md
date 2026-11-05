# Preventing hallucinations in Coding Harness

> "The thinking keeps hallucinating" — this is expected if you judge the draft lane, not the verified answer. This doc explains why hallucinations happen in a tool harness and the three layers of defense this repo implements.

## 1. Why it happens

Coding Harness intentionally ships **no built-in prompt**. The system message (`src/core/prompt.ts`) is *context only*: workspace root, top-level listing, `package.json` scripts, open editors, diagnostics, tool schemas. Every behavioural instruction comes from `agent.md` / `.agents/*.md` files you write.

That means:

- **No grounding rule by default.** With an empty `agent.md`, the model gets tools but no instruction like "read before you write" — so it may answer from parametric memory instead of calling `read_file`.
- **Thinking is a draft, not a commitment.** Anthropic `thinking` blocks and OpenAI `reasoning_content` stream into a *display-only* lane (`src/core/agent.ts` never appends `thinking` to the transcript). The model can hallucinate wildly in thinking and still act correctly — but if you copy thinking into the answer/tool args without a tool call, the hallucination becomes real.
- **Context can go stale or be compacted.** `workspaceSnapshot()` is taken once at task start. After you `write_file`, that snapshot is outdated. `compaction.ts` replaces old turns with a heuristic summary (not an LLM summary) — details outside the last ~10 messages are lost. A model that relies on the compaction summary instead of re-reading will invent details.
- **Temperature + truncation.** `temperature: 0.2` (default) is deliberately low. Raising it or setting `maxOutputTokens` too low (so the answer is cut with `finish_reason: length`) both increase hallucinations — the continuation lacks the tool result that would have grounded it.
- **Tool descriptions pre-revamp were permissive.** The old descriptions said "Always read before editing" but did not say "never invent file names/content".

## 2. What this repo now does (code changes you can inspect)

### A. Tool descriptions are explicit anti-hallucination prompts

Each tool in `src/core/tools/*` now contains a grounding clause in its `description` (the text sent to the model on every turn):

- `list_files`: **"Never invent file names — always list first to verify what exists."**
- `read_file`: **"never quote or summarize file contents you have not just read via this tool."**
- `write_file` / `create_file` / `replace_in_file`: **"read_file first and base edits on the returned text" / "copy old_text verbatim, never invent it"**
- `search_text`: **"Prefer this over guessing file locations."**
- `run_command`: **"Never invent command output — only report what this tool returned."**
- `get_diagnostics`: **"never invent diagnostics."**

These live in `src/core/tools/*.ts` and are part of the `# Tools` section of the system message. They are factual tool contracts, not a hidden personality, so they comply with `agent.md`'s rule "The system message must contain context only" (tool contracts are context about what the tool does).

### B. Repo's own `agent.md` now models a grounded workflow

`agent.md` at the repo root now has a `## Grounding — prevent hallucinations` section that is sent to the model on every task in this repo. It spells out:

- read-before-write,
- list-before-create,
- quote-tool-output-dont-invent,
- thinking is display-only,
- verify-after-edit via `get_diagnostics`/`run_command`,
- re-read after compaction.

Use it as a template for your own projects.

### C. Reusable drop-in instruction file

`.agents/grounding.md` is a scoped, `applyTo: "**/*"` file you can copy into any workspace (it is discovered automatically from `.agents/`). It repeats the same rules with examples and config tips. Pin it in the panel's Agents picker or leave it auto-discovered.

No changes were made to `src/core/prompt.ts` — the system message stays context-only per the repo convention. All behavioural rules live where they should: in agent instruction files.

## 3. How to use it in your own workspace

Pick the level that fits your risk tolerance:

### Quick start (30 seconds)

Copy `.agents/grounding.md` from this repo into your project's `.agents/grounding.md`. Done — next task includes it automatically.

Or paste the "Grounding — verify, don't invent" block into your `AGENTS.md` / `agent.md`.

### Stronger (recommended for production repos)

In `agent.md`:

```markdown
## Verification protocol (mandatory)

1. Exploration: `list_files` + `search_text` before any `read_file`.
2. Mutation: `read_file` -> `replace_in_file`/`write_file`. No read -> no write.
3. Verification: `get_diagnostics` + `run_command "npm test"` after every mutation. Report exit codes verbatim; never claim "tests pass" without them.
4. If a tool says "not found" / "snippet not found", you hallucinated the path/snippet. Re-list/re-read, do not invent a workaround.
```

Set in VS Code settings:

- `codingHarness.temperature`: `0.1–0.2`
- `codingHarness.maxOutputTokens`: `2048`+ (avoid truncation mid-verification)
- `codingHarness.compaction.keepLastMessages`: `10`–`15` (higher retains more grounding)
- `codingHarness.showThinking`: `false` if the draft lane is distracting — it is not used by the model.

### Strict (for evals / high-stakes)

- Enable `codingHarness.editPolicy: "ask"` and `commandPolicy: "auto-safe"` (defaults) so writes/commands require approval — the human eye catches hallucinations the model missed.
- Add a CI check: `npm test` must pass after the agent finishes; treat "Done" without a `run_command` exit-0 as failure.

## 4. How to tell if it worked

In the panel, a grounded run looks like:

```
thinking: "I should look at the layout first..."   # draft, ignored
-> list_files glob="**/*.ts"                        # verified
-> read_file src/core/agent.ts                      # verified
-> search_text query="hallucinat"                   # verified
-> replace_in_file (old_text from previous read)    # grounded
-> get_diagnostics                                  # verified
-> "Diagnostics: 0 errors, 1 warning ..."           # quoted
```

A hallucinated run looks like:

```
assistant: "The file src/does/not/exist.ts contains ..."
# with no list_files/read_file before it -> ask for verification
```

If you see the second pattern, hit **Compact** / start a **New Task** with "please re-verify by reading the files first" — compaction or a follow-up with explicit grounding usually fixes it without changing model.

## 5. Further reading

- `src/core/prompt.ts` — what context the model actually sees (and why no hidden prompt exists)
- `src/core/agent.ts` — why `thinking` is never appended to history (`onThinking` callback only)
- `src/core/compaction.ts` — why re-reading matters after compaction
- `.agents/grounding.md` — the drop-in rule file
