---
description: Tool instructions for the Coding Harness agent
tools: [read, search, edit, execute, task_list]
---

# Agent instructions — available tools

Copy this file into your workspace as `agent.md` (or place it under `.agents/`) to tell the Coding Harness agent which tools it may use and how to use them.

The `tools:` front-matter above is an **opt-in allowlist**. Only tools named here — directly or via a group — are presented to the model and allowed to run. `tools: []`, no selected files, or no selected file declaring tools permits no tools.

## Available tools

| Tool | What it does | Approval |
| --- | --- | --- |
| `list_files` | List files/dirs, glob filters, skips `node_modules`, `dist`, `.git`, … | never |
| `read_file` | Line-numbered reads (slices, size/binary guards, directory listing) | never |
| `search_text` | Text/JavaScript-regex search with `path:line:` results | never |
| `create_file` | Create a new file; fails if the path already exists | per `editPolicy` |
| `write_file` | Overwrite or append a whole file; preserves line endings | per `editPolicy` |
| `replace_in_file` | Exact-snippet replacement; preserves file style | per `editPolicy` |
| `delete_file` | Remove one file | always |
| `run_command` | Shell command in the workspace, with timeout and exit-code capture | per `commandPolicy` |
| `get_diagnostics` | Current errors/warnings from language servers | never |
| `open_file` | Reveal a file/line in the editor | never |
| `task_list` | Add/update/list/remove items in a per-task task list (shown in the panel strip, saved in the chat JSON) | never |

## Tool groups

Use a group in `tools:` instead of naming tools one-by-one:
- `read` — `list_files`, `read_file`, `get_diagnostics`, `open_file`
- `search` — `list_files`, `search_text`
- `edit` — `create_file`, `write_file`, `replace_in_file`, `delete_file`
- `execute` — `run_command`
- `mcp` — all registered `mcp_<server>_<tool>` tools
- `subagent` — `delegate_task` (read-only subagent, when enabled)

Mix groups and exact names as needed, e.g. `tools: [read, search, task_list]`.

## Grounding rules

- **Never invent facts you can verify with a tool.** Call `list_files`/`read_file`/`search_text` before referencing files, paths, or symbols.
- **Read before you write.** Always `read_file` an existing file before editing; copy `old_text` verbatim from the tool output.
- **List before you create.** Confirm a file does not exist before `create_file`.
- **Verify after edits.** Run `get_diagnostics` or `run_command` (`npm test`, `tsc`, …) before claiming success; report actual output.
- **`task_list` for long-running work.** Use `add`/`update`/`remove`/`list` to track what's done, in-progress, or pending. The list is per-task, shown in the panel strip, and saved in the chat JSON.

## Policies

- `create_file`/`write_file`/`replace_in_file`/`delete_file` are governed by `codingHarness.editPolicy`.
- `run_command` is governed by `codingHarness.commandPolicy`.
- `delete_file` always requires approval.
- `tools: []` or a malformed policy fails closed (no tools).
