/**
 * Hard-coded prompts and operational messages used by the agent loop.
 *
 * Centralising these here makes them easier to tune, review, and override
 * without digging through `agent.ts`. All prompts are plain strings (no
 * template engine) and are interpolated at call sites.
 */

/** Sent when a model answer was cut off by the output token limit. */
export const CONTINUE_AFTER_TRUNCATION =
  'Your previous message was cut off by the output token limit.';

/** Recorded for tool calls the user cancelled before they could run. */
export const CANCELLED_TOOL_RESULT =
  'Skipped: the task was cancelled before this tool ran.';

/**
 * Prompt for the automatic read-only subagent that runs before the main
 * agent when `subagentsEnabled` is true. The `text` parameter is the user's
 * original request.
 */
export function subagentTaskPrompt(text: string): string {
  return `You are the delegated read-only subagent, not the main agent. Do not delegate further. Investigate the user's request using permitted read-only tools if relevant. Return concise findings, relevant paths and evidence; explicitly identify uncertainty or missing context. The parent will handle edits and commands.

User request:
${text}`;
}

/** Synthetic delegation call arguments for the automatic subagent. */
export const AUTOMATIC_SUBAGENT_TASK = 'Automatic read-only investigation of the current user request.';

/** Notice when the automatic subagent is skipped because policy disallows it. */
export const SUBAGENT_SKIPPED_NOTICE =
  'Automatic subagent skipped: selected agent files do not permit delegation. Continuing with the main agent. Allow subagent and read/search in every declaring agent file to enable it.';

/** Notice when the automatic subagent starts. */
export const SUBAGENT_STARTED_NOTICE =
  'Starting the automatic read-only subagent before the main agent.';

/** Failure message when the automatic subagent throws. */
export function subagentFailedMessage(err: Error): string {
  return `Automatic subagent failed: ${err.message}`;
}

/** Warning when the automatic subagent does not complete. */
export function subagentIncompleteMessage(summary: string): string {
  return `Automatic subagent did not complete (${summary}). Continuing with the main agent; its findings are unavailable or incomplete.`;
}

/** Subagent disabled error message. */
export const SUBAGENT_DISABLED = 'Subagents are disabled.';

/** No read-only tools available for subagent. */
export const SUBAGENT_NO_READ_TOOLS =
  'No read-only built-in tools are allowed for this subagent. Add read or search permissions in the selected agent files.';

/** Warning when compaction fails and the task continues uncompacted. */
export const COMPACTION_FAILED_NOTICE =
  'Context compaction failed — continuing with full history.';
