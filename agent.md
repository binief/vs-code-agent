# Coding Harness — project instructions

Instructions for working on this repository. The extension is a tool harness only: it has no
built-in prompt, so this file is what tells the agent how to work here.

## Project

- TypeScript, compiled with `tsc` to `out/`. No bundler.
- `src/core` must stay free of `vscode` imports so the agent loop remains testable without the editor.
- `src/vscode` is the editor layer; `media/` holds the webview assets (plain JS/CSS).

## Commands

- `npm run compile` — type-check and emit `out/`.
- `npm test` — compile, then run every `out/test/*.test.js` suite with `node --test`.
- `npm run package` — build `coding-harness.vsix` with `vsce`.

Run `npm test` after changing core logic, tools, the prompt builder or the webview HTML.

## Conventions

- Match the surrounding code style (2-space indentation, single quotes, semicolons).
- Keep core modules dependency-free; do not add runtime dependencies without a strong reason.
- Update the relevant `src/test/*.test.ts` suite with behaviour changes, and keep `manifest.test.ts`
  passing: every contributed command/setting must exist in the manifest and be used by the extension.
- The system message must contain context only. Do not add behavioural instructions to
  `src/core/prompt.ts`; instructions belong in agent files.

## Grounding — prevent hallucinations

This is the single most important rule for this harness (and the reason “thinking” sometimes hallucinates):

- **Never invent facts you can verify with a tool.** If you need a file’s content, a directory listing, a symbol location, a diagnostic, or command output — call the tool and quote it. Do not guess file names, APIs, or line numbers from training data.
- **Read before you write.** Always `read_file` an existing file before `write_file`/`replace_in_file`. Copy `old_text` verbatim from the tool result — never invent it. If `replace_in_file` fails with “snippet not found”, re-read and copy again.
- **List before you create.** Run `list_files` (or `search_text`) to confirm a file does not exist before `create_file`. Do not hallucinate a project layout; the `Workspace` section of the system message is stale the moment you write.
- **Quote tool output, don’t paraphrase it into existence.** When you summarize, use numbers/paths that came from `list_files`/`search_text`/`read_file`/`run_command`/`get_diagnostics`. If you haven’t called a tool, say “I haven’t verified this yet” instead of stating it as fact.
- **Thinking is display-only.** The thinking lane streams a draft, not a verified plan. Treat anything in thinking as ungrounded until a tool confirms it. The panel never sends thinking back to the model — only `assistant` text + tool results go into history — so a hallucination in thinking only becomes dangerous if you copy it into the answer or a tool argument without verification.
- **After edits, verify.** Run `get_diagnostics` or `run_command` (tests/build) and report what they actually returned. Do not claim “tests pass” or “no errors” without calling them.
- **If context is truncated or compacted, re-read.** Compaction replaces old turns with a summary. Do not assume details from a compacted summary are current — re-list/re-read the files you need for the next step.

### When you must answer without tools (e.g. general knowledge)

- Say so explicitly (“from training data, not verified in this workspace”).
- Keep it short, and offer to verify with a tool (“want me to search/read X to confirm?”).
