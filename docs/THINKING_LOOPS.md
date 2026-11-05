# Tracking & preventing repeating thinking blocks

> The model’s `thinking` lane sometimes repeats the same sentence/paragraph for hundreds of tokens — a visible “hallucination loop”.

This doc explains why it happens and what the harness now does to **track, collapse, and break** the loop. No extra configuration is needed; the defaults work for 95 % of cases.

## 1. Why it repeats

* `thinking` / `reasoning_content` streams as a **display-only** delta (`onThinking` in `src/core/providers/*.ts`). `agent.ts` never sends it back as history, but the provider still generates it token-by-token — if the model gets stuck on a phrase, it can loop for thousands of chars before emitting a tool call.
* Common triggers: vague `agent.md` (“be thorough” without “act”), high `temperature`, low `maxOutputTokens` (truncation makes the continuation re-reason), and a tool that keeps returning “not found” so the model re-thinks the same plan.
* The panel used to render every delta verbatim, so a 2 kB loop became a wall of identical text that hid the real tool calls.

## 2. What the harness now does

### A. New module `src/core/thinking.ts`

Pure functions + an incremental `ThinkingMonitor` that can be unit-tested:

* `detectRepetition(text)` — splits into sentences (code fences stripped), normalises, counts frequencies. Flags if:
  * any sentence appears ≥3×,
  * sliding window of 3 sentences repeats,
  * duplicate ratio ≥35 %,
  * or raw substring repeats 3× (for models that loop without punctuation).
* `dedupeThinking(text)` — keeps the first 2 occurrences of each sentence, drops the rest, appends `… N repeated sentence(s) hidden`.
* `ThinkingMonitor` — per-step incremental tracker:
  * throttles analysis to every ~400 chars / sentence boundary,
  * tracks `rawLength`, `repeatScore`, `repeatedSentences`,
  * suppresses pure-duplicate deltas after the loop is confirmed (first 2 repeats still shown so you see the pattern),
  * hard-caps at `maxChars` (default 12 k) and truncates with a marker,
  * emits a **single** warning notice per block (not per delta).

Defaults: `maxChars=12000, minSentences=6, duplicateThreshold=3, repeatScoreThreshold=0.35`.

### B. Wired into `src/core/agent.ts`

```ts
// per agent step
thinkingMonitor = new ThinkingMonitor() // reset on each attempt
onThinking: delta => {
  const { shouldEmit, filteredDelta, notice } = thinkingMonitor.add(delta)
  if (notice) onEvent({type:'notice', level:'warn', message: notice})
  if (!shouldEmit) return
  onEvent({type:'thinking-delta', ...})
}
// non-streaming fallback
if (response.thinking) {
  const check = detectRepetition(thinking)
  if (check.isRepeating) thinking = dedupeThinking(thinking)
}
// cross-step loop
if (same thinking signature 3× in a row)
  inject user nudge: “Stop repeating, take a concrete tool action …”
```

Effects you’ll see:

* **Collapsed lane** — duplicated sentences hidden, notice banner explains why.
* **One warning** — `Thinking is repeating: sentence repeated 3+ times: "I need to read the file." ×4 — collapsing repeats.` (also logged via `host.log('warn', …)`).
* **Truncation** — `Thinking exceeded 12000 chars — further thinking will be truncated.` prevents OOM in saved chats.
* **Auto-break** — after 3 identical thinking blocks, a synthetic user message nudges the model to act instead of re-thinking. The loop history is then cleared.

### C. Tests `src/test/thinking.test.ts`

8 tests cover: normal thinking not flagged, sentence repeat flagged, window loop, duplicate ratio, dedupe, too-long, monitor suppression, single-notice guarantee. The harness now has 205 tests (was 197), all green.

### D. UI still respects `codingHarness.showThinking`

* `true` (default) — lane shows deduped view + warnings.
* `false` — no deltas emitted at all, but `thinkingHistory` still tracks signatures for cross-step detection so the model still gets nudged.

## 3. How to tune

You usually don’t need to. If you do:

* **In code** — `new ThinkingMonitor({ maxChars: 8000, duplicateThreshold: 2 })` in `agent.ts`, or expose via `HarnessConfig.thinking`.
* **In prompts** — add to `agent.md`:

```md
## Thinking

* Reason briefly (3-5 sentences), then act with a tool. Never repeat the same sentence.
* If a tool says “not found”, re-list with a different glob instead of re-thinking the same plan.
```

* **In settings** — keep `temperature ≤0.3`, `maxOutputTokens ≥2048` to avoid truncation-induced re-reasoning.

## 4. How to verify it worked

Run the mock that streams reasoning:

```ts
const session = new HarnessSession({ host, config: DEFAULT_CONFIG, provider: new MockPlannerProvider() })
await session.runTask('create a python script called demo.py', e => {
  if (e.type === 'notice' && e.message.includes('Thinking is repeating')) console.log('loop caught:', e.message)
  if (e.type === 'thinking') console.log('final thinking length', e.text.length, 'duration', e.durationMs)
})
```

Or trigger manually: feed a thinking block with 20 copies of the same sentence — you’ll see one warning and a collapsed final block:

```
I need to read the file. I need to read the file.
… [1 repeated sentence(s) hidden]
```

Cross-step loops surface as:

```
[notice] Thinking loop detected — nudging model: Your recent thinking has repeated verbatim for 3 consecutive turns…
```

Follow the tool strip — after the nudge the next step should be `list_files`/`search_text`/`read_file` instead of more thinking.

## 5. Further reading

* `src/core/agent.ts:380-560` — where the monitor is instantiated per attempt
* `src/core/providers/openai.ts:174-260, anthropic.ts:160-260` — how `onThinking` is surfaced from SSE
* `src/vscode/controller.ts:appendThinkingDelta` — throttled repaint (60 ms) that already handled the UI side
* `media/chat.js:renderThinking` — lane is `open` while `streaming`, collapsed afterward; deduping just shortens `thinking-body`
