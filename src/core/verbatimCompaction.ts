import { estimateImageTokens } from './images';
import { isTranscriptWellFormed } from './transcript';
import type { ChatMessage, ImageAttachment } from './types';

/** UTF-8 byte-limited slices that do not split surrogate pairs. */
function prefix(text: string, limit: number): string {
  let end = 0, bytes = 0;
  for (const char of text) {
    const n = Buffer.byteLength(char, 'utf8');
    if (bytes + n > limit) break;
    bytes += n;
    end += char.length;
  }
  return text.slice(0, end);
}
function suffix(text: string, limit: number): string {
  let start = text.length, bytes = 0;
  while (start > 0) {
    let next = start - 1;
    const last = text.charCodeAt(next);
    if (last >= 0xdc00 && last <= 0xdfff && next > 0) {
      const previous = text.charCodeAt(next - 1);
      if (previous >= 0xd800 && previous <= 0xdbff) next--;
    }
    const n = Buffer.byteLength(text.slice(next, start), 'utf8');
    if (bytes + n > limit) break;
    bytes += n;
    start = next;
  }
  return text.slice(start);
}

/**
 * Local, extractive fallback. It never executes a tool or invents a summary.
 * All older images remain attached to active messages; text may be omitted.
 * The caller is responsible for retaining the original recorded conversation.
 */
export function verbatimCompaction(
  history: readonly ChatMessage[],
  initialCut: number,
  target: number | undefined,
  estimate: (messages: readonly ChatMessage[]) => number,
  preserveUser?: ChatMessage,
): { history: ChatMessage[]; removed: number; targetMet: boolean } | undefined {
  if (initialCut <= 0 || !isTranscriptWellFormed([...history]) || history.some((m) => m.role === 'system' || (m.role !== 'user' && m.images?.length))) return undefined;

  // Find boundaries only after all earlier tool calls have been answered.
  const boundaries: number[] = [];
  const pending = new Set<string>();
  for (let i = 0; i < history.length; i++) {
    const message = history[i];
    if (message.role === 'assistant') for (const call of message.toolCalls ?? []) pending.add(call.id);
    if (message.role === 'tool' && message.toolCallId) pending.delete(message.toolCallId);
    if (!pending.size && i + 1 >= initialCut) boundaries.push(i + 1);
  }
  if (!boundaries.length) return undefined;

  // Estimate each suffix once. The original tail stays byte-for-byte intact.
  const suffixTokens = new Array<number>(history.length + 1).fill(0);
  const imageTokens = new Array<number>(history.length + 1).fill(0);
  for (let i = history.length - 1; i >= 0; i--) suffixTokens[i] = suffixTokens[i + 1] + Math.max(0, estimate([history[i]]) - 3);
  for (let i = 0; i < history.length; i++) imageTokens[i + 1] = imageTokens[i] + estimateImageTokens(history[i]);
  const canPreserve = preserveUser?.role === 'user';
  const preservedIndex = canPreserve ? history.indexOf(preserveUser!) : -1;
  // If an earlier LLM compaction already removed the current request, restore
  // it from the caller's original task message rather than losing it again.
  const preserveMissing = canPreserve && preservedIndex < 0;
  let restoredUser = preserveUser;
  if (preserveMissing && preserveUser?.images?.length) {
    // An earlier model summary may already contain these same image objects.
    // Retain every existing image but do not attach the same object twice.
    const existing = new Set(history.flatMap((message) => message.images ?? []));
    const remaining = preserveUser.images.filter((image) => !existing.has(image));
    if (remaining.length !== preserveUser.images.length) {
      const { images: _images, ...message } = preserveUser;
      restoredUser = remaining.length ? { ...message, images: remaining } : message;
    }
  }
  const preservedExtra = canPreserve ? Math.max(0, estimate([restoredUser!]) - 3 - (preserveMissing ? 0 : estimateImageTokens(restoredUser!))) : 0;
  let cut = boundaries[0];
  if (target !== undefined) {
    for (const boundary of boundaries) {
      cut = boundary;
      // Reserve some space for labels and excerpts. Images must not be dropped.
      const preservedTokens = preserveMissing || (preservedIndex >= 0 && preservedIndex < cut) ? preservedExtra : 0;
      if (suffixTokens[cut] + imageTokens[cut] + preservedTokens + 150 <= target) break;
    }
  }
  const older = history.slice(0, cut);
  const tail = history.slice(cut);
  const preserveSeparately = preserveMissing || (preservedIndex >= 0 && preservedIndex < cut);
  const users = older.flatMap((message, index) => message !== (preserveSeparately ? preserveUser : undefined) && message.role === 'user' && message.content
    ? [{ index, text: message.content }] : []);
  const availableTokens = target === undefined ? 4000 : Math.max(0, target - suffixTokens[cut] - imageTokens[cut] - (preserveSeparately ? preservedExtra : 0) - 150);
  const excerptBudget = Math.max(128, Math.min(12000, Math.floor(availableTokens * 3)));
  const maxEntries = Math.max(1, Math.min(32, Math.floor(excerptBudget / 100)));
  const firstCount = maxEntries < 2 ? 0 : Math.min(users.length, Math.ceil(maxEntries / 3));
  const chosen = users.length <= maxEntries ? users : [...users.slice(0, firstCount), ...users.slice(users.length - (maxEntries - firstCount))];
  const perEntry = chosen.length ? Math.max(32, Math.min(2048, Math.floor(excerptBudget / chosen.length) - 75)) : 0;
  const lines = [
    '[Conversation compacted without an LLM. These are verbatim excerpts from earlier user-role messages, not a complete summary. Other older messages and omitted portions are outside active context. Original recorded messages may be available in the conversation archive.]',
    `[Earlier messages: ${older.length}; user-role messages with text: ${users.length}; excerpted: ${chosen.length}.]`,
  ];
  for (const entry of chosen) {
    const bytes = Buffer.byteLength(entry.text, 'utf8');
    if (bytes <= perEntry) {
      lines.push(`\n[Earlier user-role message ${entry.index + 1}, complete]\n${entry.text}`);
    } else {
      const head = prefix(entry.text, Math.floor(perEntry / 2));
      const end = suffix(entry.text, Math.floor(perEntry / 2));
      lines.push(`\n[Earlier user-role message ${entry.index + 1}, beginning]\n${head}\n[... middle omitted ...]\n${end}\n[End of excerpt]`);
    }
  }
  const excerpts: ChatMessage = { role: 'user', content: lines.join('\n') };
  const images: ChatMessage[] = [];
  for (const [index, message] of older.entries()) {
    if (preserveSeparately && message === preserveUser) continue;
    const attachments: ImageAttachment[] = message.images ?? [];
    for (let i = 0; i < attachments.length; i += 8) {
      images.push({ role: 'user', content: `[Image attachments from earlier user-role message ${index + 1}.]`, images: attachments.slice(i, i + 8) });
    }
  }
  // The current task request must never be shortened or silently dropped.
  const result = [excerpts, ...images, ...(preserveSeparately ? [restoredUser!] : []), ...tail];
  const originalTokens = estimate(history);
  const newTokens = estimate(result);
  if (!isTranscriptWellFormed(result) || newTokens >= originalTokens) return undefined;
  return { history: result, removed: Math.max(0, history.length - result.length), targetMet: target === undefined || newTokens <= target };
}
