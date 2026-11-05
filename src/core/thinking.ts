/**
 * Thinking loop detection — track and prevent repetitive reasoning.
 *
 * The model's `thinking` / `reasoning_content` streams into a display-only lane
 * (`agent.ts` never sends it back as history). A repeating thinking block wastes
 * tokens, hides progress, and often precedes a tool-call loop. This module
 * gives the harness three things:
 *
 *  1. detection — sentence-level repetition + compression ratio + window repeats
 *  2. monitoring — incremental tracker used per agent step
 *  3. deduping — optional collapsed view for the lane so the UI doesn't spam
 */

export interface RepetitionResult {
  /** True when the thinking is considered repetitive / looped. */
  isRepeating: boolean;
  /** 0–1: fraction of sentences that are duplicates (0 = all unique). */
  repeatScore: number;
  /** Total sentences considered (length > threshold). */
  totalSentences: number;
  /** Distinct sentences. */
  uniqueSentences: number;
  /** Sentences that appear >= duplicateThreshold times. */
  repeatedSentences: string[];
  /** Raw duplicate sentence counts for diagnostics. */
  counts: Array<{ sentence: string; count: number }>;
  /** Human-readable reason, for logs/notices. */
  reason: string;
  /** True when text exceeds maxChars (separate from repetition). */
  isTooLong: boolean;
}

export interface ThinkingMonitorOptions {
  /** Hard cap for one thinking block (chars). Default 12000 (~3000 tokens). */
  maxChars?: number;
  /** How many sentences before we start checking. Default 6. */
  minSentences?: number;
  /** Minimum chars for a sentence to count (filters \"OK.\" etc). Default 15. */
  minSentenceLength?: number;
  /** Occurrences of the same normalised sentence to flag. Default 3. */
  duplicateThreshold?: number;
  /** RepeatScore above this flags repetition. Default 0.35. */
  repeatScoreThreshold?: number;
  /** Sliding window size for exact-loop detection. Default 3. */
  windowSize?: number;
}

const DEFAULTS: Required<ThinkingMonitorOptions> = {
  maxChars: 12_000,
  minSentences: 6,
  minSentenceLength: 15,
  duplicateThreshold: 3,
  repeatScoreThreshold: 0.35,
  windowSize: 3,
};

/* ---------------------------------------------------------------- sentence helpers */

function splitIntoSentences(text: string): string[] {
  // Keep paragraphs, bullets and code fences as separate chunks too.
  // Split on: sentence terminators + whitespace, newlines, list markers.
  const raw = text
    .replace(/\r\n/g, '\n')
    .replace(/```[\s\S]*?```/g, '\n') // strip code fences for repetition check
    .split(/(?<=[.!?])\s+|\n{1,3}|\s+[-*]\s+|\s+\d+[.)]\s+/g);
  return raw.map((s) => s.trim()).filter(Boolean);
}

function normalizeSentence(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncateForDisplay(s: string, max = 120): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/* --------------------------------------------------------------- detection */

/**
 * Analyse a complete thinking string for repetition.
 * Pure function — safe to call on every delta without side effects.
 */
export function detectRepetition(
  thinking: string,
  opts: ThinkingMonitorOptions = {},
): RepetitionResult {
  const cfg = { ...DEFAULTS, ...opts };
  const isTooLong = thinking.length > cfg.maxChars;

  const sentencesRaw = splitIntoSentences(thinking);
  const normalized = sentencesRaw
    .map((s) => ({ raw: s, norm: normalizeSentence(s) }))
    .filter((s) => s.norm.length >= cfg.minSentenceLength);

  const totalSentences = normalized.length;
  if (totalSentences < cfg.minSentences && !isTooLong) {
    return {
      isRepeating: false,
      repeatScore: 0,
      totalSentences,
      uniqueSentences: new Set(normalized.map((s) => s.norm)).size,
      repeatedSentences: [],
      counts: [],
      reason: '',
      isTooLong,
    };
  }

  const freq = new Map<string, number>();
  const originalByNorm = new Map<string, string>();
  for (const { raw, norm } of normalized) {
    freq.set(norm, (freq.get(norm) ?? 0) + 1);
    if (!originalByNorm.has(norm)) originalByNorm.set(norm, truncateForDisplay(raw, 100));
  }

  const uniqueSentences = freq.size;
  const duplicateCount = totalSentences - uniqueSentences;
  const repeatScore = totalSentences > 0 ? duplicateCount / totalSentences : 0;

  const repeated: Array<{ norm: string; count: number }> = [];
  freq.forEach((count, norm) => {
    if (count >= cfg.duplicateThreshold) repeated.push({ norm, count });
  });

  // Sliding-window exact loop: last N sentences repeat an earlier N.
  let windowLoop = false;
  let windowReason = '';
  if (totalSentences >= cfg.windowSize * 2) {
    const norms = normalized.map((s) => s.norm);
    const lastWindow = norms.slice(-cfg.windowSize).join(' | ');
    for (let i = 0; i <= norms.length - cfg.windowSize * 2; i++) {
      const win = norms.slice(i, i + cfg.windowSize).join(' | ');
      if (win === lastWindow) {
        windowLoop = true;
        windowReason = `last ${cfg.windowSize} sentences repeat an earlier block`;
        break;
      }
    }
  }

  // Also check raw substring repetition for long thinking without sentence boundaries
  // (e.g. \"Let me think... Let me think...\" without periods)
  let substringLoop = false;
  if (!windowLoop && thinking.length > 800) {
    // Look for any 60-char phrase that occurs 3+ times
    const sampleSize = 60;
    for (let i = 0; i < thinking.length - sampleSize * 3; i += 40) {
      const phrase = thinking.slice(i, i + sampleSize).trim();
      if (phrase.length < sampleSize) continue;
      const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const matches = thinking.match(new RegExp(escaped.replace(/\s+/g, '\\s+'), 'g'));
      if (matches && matches.length >= 3) {
        substringLoop = true;
        break;
      }
    }
  }

  const isRepeating =
    repeated.length > 0 || repeatScore >= cfg.repeatScoreThreshold || windowLoop || substringLoop;

  let reason = '';
  if (repeated.length > 0) {
    const top = repeated
      .sort((a, b) => b.count - a.count)
      .slice(0, 3)
      .map((r) => `"${truncateForDisplay(originalByNorm.get(r.norm) ?? r.norm, 60)}" ×${r.count}`);
    reason = `sentence repeated ${cfg.duplicateThreshold}+ times: ${top.join(', ')}`;
  } else if (windowLoop) {
    reason = windowReason;
  } else if (substringLoop) {
    reason = 'same phrase repeats 3+ times';
  } else if (repeatScore >= cfg.repeatScoreThreshold) {
    reason = `high duplicate ratio ${(repeatScore * 100).toFixed(0)}% (${duplicateCount}/${totalSentences} dup)`;
  } else if (isTooLong) {
    reason = `exceeds ${cfg.maxChars} chars`;
  }

  return {
    isRepeating,
    repeatScore,
    totalSentences,
    uniqueSentences,
    repeatedSentences: repeated.map((r) => originalByNorm.get(r.norm) ?? r.norm),
    counts: Array.from(freq.entries())
      .filter(([, c]) => c >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([sentence, count]) => ({ sentence: truncateForDisplay(sentence, 80), count })),
    reason: reason || (isTooLong ? `exceeds ${cfg.maxChars} chars` : ''),
    isTooLong,
  };
}

/**
 * Build a deduped view of thinking: keep the first two occurrences of each
 * sentence, drop the rest. Used to collapse the lane without losing the start.
 */
export function dedupeThinking(thinking: string, opts: ThinkingMonitorOptions = {}): string {
  const cfg = { ...DEFAULTS, ...opts };
  const sentences = splitIntoSentences(thinking);
  if (sentences.length < cfg.minSentences) return thinking;

  const seen = new Map<string, number>();
  const out: string[] = [];
  let dropped = 0;

  for (const raw of sentences) {
    const norm = normalizeSentence(raw);
    if (norm.length < cfg.minSentenceLength) {
      out.push(raw);
      continue;
    }
    const count = (seen.get(norm) ?? 0) + 1;
    seen.set(norm, count);
    if (count <= 2) {
      out.push(raw);
    } else {
      dropped++;
    }
  }

  if (dropped === 0) return thinking;
  return `${out.join(' ')}\n\n[… ${dropped} repeated sentence(s) hidden — see raw thinking for full text]`;
}

/* --------------------------------------------------------------- monitor */

export interface ThinkingMonitorState extends RepetitionResult {
  rawLength: number;
  dedupedLength: number;
  suppressedDeltas: number;
  elapsedMs: number;
}

export class ThinkingMonitor {
  private raw = '';
  private dedupedCache = '';
  private suppressedDeltas = 0;
  private startedAt = 0;
  private warnedRepeating = false;
  private warnedTooLong = false;
  private lastResult: RepetitionResult;
  private readonly cfg: Required<ThinkingMonitorOptions>;

  constructor(opts: ThinkingMonitorOptions = {}) {
    this.cfg = { ...DEFAULTS, ...opts };
    this.lastResult = {
      isRepeating: false,
      repeatScore: 0,
      totalSentences: 0,
      uniqueSentences: 0,
      repeatedSentences: [],
      counts: [],
      reason: '',
      isTooLong: false,
    };
  }

  /** Start a new thinking block (call per agent step). */
  reset(): void {
    this.raw = '';
    this.dedupedCache = '';
    this.suppressedDeltas = 0;
    this.startedAt = Date.now();
    this.warnedRepeating = false;
    this.warnedTooLong = false;
    this.lastResult = {
      isRepeating: false,
      repeatScore: 0,
      totalSentences: 0,
      uniqueSentences: 0,
      repeatedSentences: [],
      counts: [],
      reason: '',
      isTooLong: false,
    };
  }

  /**
   * Feed a streaming delta. Returns whether to emit it and current state.
   *
   * Filtering is conservative: we still emit the first two repeats of a
   * sentence so the user sees the pattern, then suppress further dupes.
   */
  add(delta: string): {
    shouldEmit: boolean;
    filteredDelta: string | null;
    state: ThinkingMonitorState;
    notice?: string;
  } {
    if (!delta) {
      return { shouldEmit: false, filteredDelta: null, state: this.snapshot() };
    }
    if (!this.startedAt) this.startedAt = Date.now();

    const prevLength = this.raw.length;
    this.raw += delta;

    // Throttle analysis: every ~400 chars or on sentence boundary
    const shouldAnalyse =
      this.raw.length - prevLength >= 50 &&
      (this.raw.length >= 400 || /[.!?\n]\s*$/.test(delta) || this.raw.length % 400 < delta.length);

    if (shouldAnalyse) {
      this.lastResult = detectRepetition(this.raw, this.cfg);
      // Update deduped cache lazily
      if (this.lastResult.isRepeating || this.lastResult.repeatScore > 0.2) {
        this.dedupedCache = dedupeThinking(this.raw, this.cfg);
      }
    } else if (this.raw.length > this.cfg.maxChars && !this.lastResult.isTooLong) {
      this.lastResult = { ...this.lastResult, isTooLong: true, reason: `exceeds ${this.cfg.maxChars} chars` };
    }

    // Determine if this delta is a pure duplicate beyond allowance
    let shouldEmit = true;
    let filteredDelta: string | null = delta;
    if (this.lastResult.isRepeating) {
      // Check if this delta only extends a sentence already seen 2+ times
      const normDelta = normalizeSentence(delta);
      if (normDelta.length >= this.cfg.minSentenceLength) {
        const sentences = splitIntoSentences(this.raw)
          .map(normalizeSentence)
          .filter((s) => s.length >= this.cfg.minSentenceLength);
        const seen = new Map<string, number>();
        for (const s of sentences) seen.set(s, (seen.get(s) ?? 0) + 1);
        if ((seen.get(normDelta) ?? 0) > 2 && this.raw.length > 1500) {
          shouldEmit = false;
          filteredDelta = null;
          this.suppressedDeltas++;
        }
      }
    }

    let notice: string | undefined;
    if (this.lastResult.isRepeating && !this.warnedRepeating) {
      this.warnedRepeating = true;
      notice = `Thinking is repeating: ${this.lastResult.reason} — collapsing repeats. The thinking lane is display-only, but the repetition wastes tokens; next tool call will ground the agent.`;
    } else if (this.lastResult.isTooLong && !this.warnedTooLong) {
      this.warnedTooLong = true;
      notice = `Thinking exceeded ${this.cfg.maxChars} chars — further thinking will be truncated. Consider lowering reasoning effort or switching models.`;
    }

    // Hard cap: never let the buffer grow unbounded
    if (this.raw.length > this.cfg.maxChars * 1.5) {
      const extra = this.raw.length - this.cfg.maxChars;
      this.raw = this.raw.slice(0, this.cfg.maxChars) + ` … [truncated ${extra} chars]`;
      if (!this.warnedTooLong) {
        this.warnedTooLong = true;
        notice = notice ?? `Thinking exceeded ${this.cfg.maxChars} chars — truncated.`;
      }
    }

    return { shouldEmit, filteredDelta, state: this.snapshot(), notice };
  }

  /** Current raw thinking (for persistence). */
  getRaw(): string {
    return this.raw;
  }

  /** Deduped view suitable for the UI. */
  getDeduped(): string {
    if (this.dedupedCache) return this.dedupedCache;
    if (this.lastResult.isRepeating) return dedupeThinking(this.raw, this.cfg);
    return this.raw;
  }

  snapshot(): ThinkingMonitorState {
    return {
      ...this.lastResult,
      rawLength: this.raw.length,
      dedupedLength: this.dedupedCache.length || this.raw.length,
      suppressedDeltas: this.suppressedDeltas,
      elapsedMs: this.startedAt ? Date.now() - this.startedAt : 0,
    };
  }

  /** For tests: force analysis on current buffer. */
  analyse(): RepetitionResult {
    this.lastResult = detectRepetition(this.raw, this.cfg);
    return this.lastResult;
  }
}
