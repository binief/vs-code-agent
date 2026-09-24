/**
 * Error plumbing shared by the HTTP providers.
 *
 * The agent has to tell "the API refused this request" from "the call failed
 * and could succeed in a moment" — a single 429 or dropped connection used to
 * end a task that had barely started. `httpError` tags failures with their
 * status (and the server's own `Retry-After`), and
 * {@link isRetryableProviderError} decides whether another attempt is worth it.
 */

export interface ProviderError extends Error {
  /** HTTP status code, when the failure came back as a response. */
  status?: number;
  /** Milliseconds to wait before retrying, taken from `Retry-After`. */
  retryAfterMs?: number;
}

/** Longest we will ever wait between attempts. */
export const MAX_RETRY_DELAY_MS = 15_000;

/** Build an error that carries the HTTP status (and Retry-After, if any). */
export function httpError(status: number, message: string, retryAfterMs?: number): ProviderError {
  const err = new Error(message) as ProviderError;
  err.name = 'ProviderHttpError';
  err.status = status;
  if (retryAfterMs !== undefined) err.retryAfterMs = retryAfterMs;
  return err;
}

/** Parse a `Retry-After` header (delta-seconds or an HTTP date) to milliseconds. */
export function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const text = value.trim();
  const seconds = Number(text);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS);
  const date = Date.parse(text);
  if (!Number.isNaN(date)) return Math.max(0, Math.min(date - Date.now(), MAX_RETRY_DELAY_MS));
  return undefined;
}

/** Statuses that mean "try again shortly" rather than "your request is wrong". */
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 529]);

/** True when re-issuing the same request could plausibly succeed. */
export function isRetryableProviderError(err: unknown): boolean {
  const status = (err as ProviderError | undefined)?.status;
  if (typeof status === 'number') {
    if (status >= 500) return true;
    return RETRYABLE_STATUS.has(status);
  }
  // Network-level failures arrive as bare Errors/TypeErrors from fetch.
  const message = (err as Error | undefined)?.message ?? '';
  return /fetch failed|network|socket hang up|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|timed? ?out|temporarily unavailable|overloaded|rate limit|too many requests/i.test(
    message,
  );
}

/** Exponential backoff, honouring the server's own Retry-After when it sent one. */
export function retryDelayMs(err: unknown, attempt: number): number {
  const hinted = (err as ProviderError | undefined)?.retryAfterMs;
  if (typeof hinted === 'number') return hinted;
  return Math.min(500 * 2 ** Math.max(0, attempt - 1), 5_000);
}
