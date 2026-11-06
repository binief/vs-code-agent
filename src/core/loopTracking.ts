import type { ToolCall, ToolResult } from './types';

/** Tracks exact consecutive sentence and multi-sentence cycles across arbitrary chunks. */
export class ConsecutiveSentenceTracker {
  private pending = '';
  private previous = '';
  private count = 0;
  private overflow = false;
  private recent: string[] = [];

  constructor(private readonly threshold = 3) {}

  reset(): void {
    this.pending = '';
    this.previous = '';
    this.count = 0;
    this.overflow = false;
    this.recent = [];
  }

  add(delta: string): { looping: boolean; count: number; reason?: string } {
    let reason: string | undefined;
    let detectedCount = 0;
    for (const char of delta) {
      if (!this.overflow) this.pending += char;
      if (this.pending.length > 4096) {
        this.pending = '';
        this.previous = '';
        this.count = 0;
        this.recent = [];
        this.overflow = true;
      }
      if (!/[.!?。！？\n]/u.test(char)) continue;
      if (this.overflow) {
        this.overflow = false;
        continue;
      }
      const sentence = this.pending.toLocaleLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim();
      this.pending = '';
      if (!sentence) continue;
      if (sentence.length < 8) {
        this.previous = '';
        this.count = 0;
        this.recent = [];
        continue;
      }
      this.count = sentence === this.previous ? this.count + 1 : 1;
      this.previous = sentence;
      this.recent.push(sentence);
      if (this.recent.length > 18) this.recent.shift();
      if (this.count >= this.threshold && !reason) {
        reason = 'same sentence repeated';
        detectedCount = this.count;
      }
      // Require three consecutive copies of a 2–6 sentence block.
      for (let size = 2; !reason && size <= 6 && this.recent.length >= size * 3; size++) {
        const n = this.recent.length;
        let matches = true;
        for (let i = 0; i < size * 2; i++) {
          if (this.recent[n - 1 - i] !== this.recent[n - 1 - i - size]) { matches = false; break; }
        }
        if (matches) { reason = `repeated ${size}-sentence block`; detectedCount = 3; }
      }
    }
    return { looping: Boolean(reason) || this.count >= this.threshold, count: reason ? detectedCount : this.count, reason };
  }
}

export type ThinkingStopReason = 'sentence' | 'block' | 'phrase' | 'budget';

/** Bounded streaming guard; independent of display state and provider chunk sizes. */
export class ThinkingStreamGuard {
  private readonly sentences = new ConsecutiveSentenceTracker();
  private recent = '';
  private length = 0;
  private nextPhraseCheck = 128;

  constructor(private readonly maxChars: number) {}

  add(delta: string): { accepted: string; reason?: ThinkingStopReason; chars: number } {
    let accepted = '';
    for (const char of delta) {
      accepted += char;
      this.length += char.length;
      const sentence = this.sentences.add(char);
      if (sentence.looping) {
        return { accepted, reason: sentence.reason?.includes('block') ? 'block' : 'sentence', chars: this.length };
      }
      this.recent += char.toLocaleLowerCase();
      if (this.recent.length > 2048) this.recent = this.recent.slice(-2048);
      if (this.length >= this.nextPhraseCheck) {
        this.nextPhraseCheck = this.length + 64;
        // A threefold exact, contiguous phrase cycle; compare only a bounded suffix.
        for (let size = 40; size <= Math.min(512, Math.floor(this.recent.length / 3)); size++) {
          const n = this.recent.length;
          // Most candidate periods fail at the last character. Check it before
          // allocating any substrings, especially for token-by-token streams.
          if (this.recent[n - 1] !== this.recent[n - size - 1] ||
              this.recent[n - 1] !== this.recent[n - size * 2 - 1]) continue;
          const a = this.recent.slice(n - size);
          if (a === this.recent.slice(n - size * 2, n - size) && a === this.recent.slice(n - size * 3, n - size * 2)) {
            return { accepted, reason: 'phrase', chars: this.length };
          }
        }
      }
      if (this.maxChars > 0 && this.length >= this.maxChars) {
        return { accepted, reason: 'budget', chars: this.length };
      }
    }
    return { accepted, chars: this.length };
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(value).sort()) result[key] = canonicalize((value as Record<string, unknown>)[key]);
    return result;
  }
  return value;
}

/** Tracks consecutive identical calls with identical visible results, not unobservable side effects. */
export class RepeatedToolCallTracker {
  private previous = '';
  private count = 0;

  reset(): void {
    this.previous = '';
    this.count = 0;
  }

  record(call: ToolCall, result: ToolResult): number {
    let args: unknown;
    try { args = canonicalize(JSON.parse(call.arguments || '{}')); }
    catch { args = call.arguments; }
    const signature = JSON.stringify([call.name, args, result.ok, result.content]);
    this.count = signature === this.previous ? this.count + 1 : 1;
    this.previous = signature;
    return this.count;
  }
}
