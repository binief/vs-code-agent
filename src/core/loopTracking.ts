import type { ToolCall, ToolResult } from './types';

/** Tracks completed consecutive sentences, regardless of how streaming chunks split them. */
export class ConsecutiveSentenceTracker {
  private pending = '';
  private previous = '';
  private count = 0;
  private overflow = false;

  constructor(private readonly threshold = 3) {}

  reset(): void {
    this.pending = '';
    this.previous = '';
    this.count = 0;
    this.overflow = false;
  }

  add(delta: string): { looping: boolean; count: number } {
    for (const char of delta) {
      if (!this.overflow) this.pending += char;
      if (this.pending.length > 4096) {
        this.pending = '';
        this.previous = '';
        this.count = 0;
        this.overflow = true;
      }
      if (!/[.!?。！？\n]/u.test(char)) continue;
      if (this.overflow) {
        this.overflow = false;
        continue;
      }
      const sentence = this.pending.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
      this.pending = '';
      if (!sentence) continue;
      // Very short fragments reset the streak rather than being ignored.
      if (sentence.length < 8) {
        this.previous = '';
        this.count = 0;
        continue;
      }
      this.count = sentence === this.previous ? this.count + 1 : 1;
      this.previous = sentence;
    }
    return { looping: this.count >= this.threshold, count: this.count };
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
