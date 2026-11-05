---
description: Anti-hallucination grounding rules — drop this file into any workspace to reduce invented facts
applyTo: "**/*"
---

# Grounding — verify, don't invent

You have tools for every fact you need. Hallucinations happen when you answer from training data instead of calling them.

## Rules

1. **File names and project layout — list, don't guess.**
   - Before referencing a file, run `list_files` (with a `glob` if needed).
   - The only layout you may trust is what `list_files` returned this task. Never invent `src/foo.ts` because "most projects have it".

2. **File contents — read, then act.**
   - Never quote, summarize, or edit a file you have not just read with `read_file`.
   - For `replace_in_file`, `old_text` must be copied character-for-character from the last `read_file` output. If the tool says "snippet not found", you hallucinated it — read again.

3. **Symbol/search results — search, don't assume.**
   - Use `search_text` to locate a symbol, config key, or string. Do not claim "defined in X" without a match.
   - Quote matches as `path:line: text` exactly as returned.

4. **Diagnostics/build/tests — run, then report.**
   - After any edit, call `get_diagnostics` or `run_command` (`npm test`, `tsc`, etc.) before claiming success.
   - Report the exit code and output verbatim. "Tests pass" without a `run_command` is a hallucination.

5. **Thinking vs. answer.**
   - Your thinking/reasoning is a private draft. It is **not** sent back to you next turn — only assistant messages + tool results are. If you invent a file name or API in thinking, it will not be corrected unless you verify with a tool before acting.
   - Never copy an unverified claim from thinking into a tool argument or final answer without a tool call in between.

6. **When you don't have a tool result, say so.**
   - Use language like "I haven't verified this in the workspace yet" or "from general knowledge (unverified)".
   - Offer to verify: "I can run `search_text` for `X` / `read_file Y` to confirm — shall I?"

## Example flow (grounded)

```
User: "fix the cart total bug"
→ list_files (glob: "**/*.js")          # verify which cart file exists
→ read_file src/cart.js                 # get current code
→ search_text query="total" glob="*.js" # find related logic
→ thinking: hypothesize fix (still unverified)
→ replace_in_file (old_text copied from read)
→ run_command "npm test"                # verify
→ report: "Tests pass (exit 0)" + actual output
```

## Config tips for humans

- Keep `codingHarness.temperature` low (0.2 default) — higher values increase creative hallucinations.
- Keep `codingHarness.maxOutputTokens` high enough (2048+) so answers aren't truncated mid-verification.
- Keep agent instructions short (few KB). A 100KB AGENTS.md crowds out the tool results the model needs to stay grounded.
- If "thinking keeps hallucinating", that's normal for the lane (it's a draft). Judge the agent by its tool calls + final answer, not the thinking stream. Turn off `codingHarness.showThinking` if the draft is distracting.
