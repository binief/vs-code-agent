# Harness playground

A tiny scratch project used to try the Coding Harness extension without touching
real code. Open this folder in the Extension Development Host and ask the agent
to explain, fix or extend `src/cart.js`.

`agent.md` in this folder is loaded automatically: it is the only source of
instructions for the agent. Edit it and the next task picks it up without
reloading the window. An `agent.md` under `src/` also loads while a file in
that folder is open (or enable `codingHarness.agentFiles.scanNested`).

The file name is not fixed. `.agents/code-review.md` is loaded because every
Markdown file inside `.agents/` is treated as instructions — try renaming it or
adding `.agents/test.md`. Elsewhere in the tree, use
`codingHarness.agentFiles.patterns` (globs such as `docs/rules/*.md`) or list
the file in `codingHarness.agentFiles.extraPaths`.
