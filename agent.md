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
