# Tracking thinking and tool-call loops

Reasoning is model-generated, display-only text, not evidence or a tool result. Some models repeat themselves while streaming, or repeatedly ask for the same tool without making visible progress. The harness tracks both patterns during a task.

## Consecutive thinking sentences

`ConsecutiveSentenceTracker` processes streaming fragments independently of chunk size, including one-character deltas. It compares completed consecutive sentences case-insensitively after normalizing punctuation and whitespace, including Unicode letters and digits. A different sentence resets the streak; fragments shorter than eight normalized characters also reset it. The tracker is reset on every provider attempt and task.

After three consecutive copies, the harness aborts that **provider request**, displays a warning, discards any incomplete tool calls, and asks the model to change approach on the next step. A successful response resets the consecutive-interruption counter. After three consecutive interrupted requests, or if the step budget is exhausted, the task stops with an error rather than restarting indefinitely. User cancellation still cancels the whole task. A provider must honor its abort signal for interruption to stop generation promptly.

Tracking also runs when `codingHarness.showThinking` is off, if the provider exposes reasoning deltas. It cannot detect hidden reasoning that the provider does not supply, sentences without supported boundaries, or reliably distinguish every abbreviation and decimal from a sentence boundary. For non-streaming responses, detection can report a loop after the response has completed, but it cannot interrupt generation retroactively. Completed responses and tool calls are retained. The existing `ThinkingMonitor` also collects display-oriented repetition and length statistics; collapsing text in the UI alone does not stop generation.

## Repeated tool calls

`RepeatedToolCallTracker` compares each consecutive tool name, JSON arguments (with object keys canonicalized), success status and full result text. After three identical calls returning identical results, the harness logs and displays a warning and sends a nudge to the model **after all tool results in the batch**, preserving the provider transcript. It warns again at six, nine, and so on if the streak continues. A different call, arguments, status or result resets the counter; each new task starts fresh.

Identical output is only a signal of possible lack of progress. It does **not** prove that the workspace or external systems did not change: commands and other tools can have side effects even if their output is identical. For that reason this detector does not suppress or replay tool calls and does not skip approvals. Similarly, changing output does not prove useful progress. Tool calls that alternate between different operations are not detected as a consecutive identical-call loop.

## Verification

Run `npm test`. `src/test/loopTracking.test.ts` exercises fragmented reasoning, reset behavior, interruption and recovery with the display on and off, the interruption limit, canonical tool arguments, and transcript-safe tool-loop nudges. Thresholds are currently code defaults (three repeated sentences or tool calls), not user-facing settings. Existing task step and output-token limits remain separate safeguards.
