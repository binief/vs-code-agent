# Tracking thinking and tool-call loops

Reasoning is model-generated, display-only text, not evidence or a tool result. Some models repeat themselves while streaming, or repeatedly ask for the same tool without making visible progress. The harness tracks both patterns during a task.

## Streaming thinking safeguards

`ThinkingStreamGuard` tracks deltas regardless of chunk size or whether `codingHarness.showThinking` is enabled. It detects three consecutive normalized sentences, three consecutive copies of a 2–6 sentence block, and three contiguous copies of an exact phrase of 40–512 characters. Sentence tracking is case-insensitive and normalizes punctuation and whitespace; phrase tracking is case-insensitive but otherwise exact. It uses bounded recent history and resets for each provider attempt. A changed pattern breaks its streak. These are heuristics: paraphrased loops can be missed, while intentionally repeated text can cause false positives.

When a loop is detected, the harness interrupts the **provider request**, warns, discards incomplete tool calls, and asks the model to change approach on the next step. The provider must honor its abort signal to stop generation promptly. User cancellation still cancels the task. A successful response resets the interruption counter; three consecutive interruptions or an interruption on the final step stop the task rather than retry indefinitely.

Separately, `codingHarness.thinkingMaxChars` sets a per-attempt streaming safety budget, default **12,000 UTF-16 characters**. Reaching it interrupts the request even if no loop was detected, so it can interrupt legitimate long reasoning. Set it higher when appropriate or to `0` to disable this budget; loop detection remains active. The UI has an independent 12,000-character display limit, marked as truncated, which does not stop generation. Output-token limits remain separate and are provider-dependent.

Detection requires reasoning text that the provider exposes. It cannot interrupt hidden reasoning or a completed non-streaming response. If an endpoint ignores streaming and returns a completed JSON response, the harness reports a detected loop but retains its answer and tool calls. Reasoning content is not logged by the detector.

## Repeated tool calls

`RepeatedToolCallTracker` compares each consecutive tool name, JSON arguments (with object keys canonicalized), success status and full result text. After three identical calls returning identical results, the harness logs and displays a warning and sends a factual notice to the model **after all tool results in the batch**, preserving the provider transcript. It warns again at six, nine, and so on if the streak continues. A different call, arguments, status or result resets the counter; each new task starts fresh.

Identical output is only a signal of possible lack of progress. It does **not** prove that the workspace or external systems did not change: commands and other tools can have side effects even if their output is identical. For that reason this detector does not suppress or replay tool calls and does not skip approvals. Similarly, changing output does not prove useful progress. Tool calls that alternate between different operations are not detected as a consecutive identical-call loop.

## Verification

Run `npm test`. `src/test/loopTracking.test.ts` exercises fragmented reasoning, reset behavior, interruption and recovery with the display on and off, the interruption limit, canonical tool arguments, and transcript-safe tool-loop notices. Loop thresholds are code defaults; `codingHarness.thinkingMaxChars` configures the separate safety budget. Existing task step and output-token limits remain separate safeguards.
