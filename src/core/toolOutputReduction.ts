import { isTranscriptWellFormed } from './transcript';
import type { ChatMessage, ToolCall } from './types';

/** Reduce only old, exactly archived tool pages. The archived messages are never modified. */
export function reduceArchivedToolOutputs(
  history: ChatMessage[], archive: readonly ChatMessage[], keepLast: number, currentRequest?: ChatMessage,
): { history: ChatMessage[]; count: number } {
  if (!isTranscriptWellFormed(history)) return { history, count: 0 };
  let cutoff = Math.max(0, history.length - Math.max(2, keepLast));
  while (cutoff > 0 && history[cutoff]?.role === 'tool') cutoff--;
  let requestIndex = currentRequest ? history.indexOf(currentRequest) : -1;
  if (!currentRequest) for (let i = history.length - 1; i >= 0; i--) if (history[i].role === 'user') { requestIndex = i; break; }
  if (requestIndex >= 0) cutoff = Math.min(cutoff, requestIndex);
  // If a protected result belongs to an earlier call, protect the whole group.
  const pending = new Map<string, { index: number; call: ToolCall }>();
  const callsByResult = new Map<number, ToolCall>();
  const pairs: [number, number][] = [];
  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    if (m.role === 'assistant') for (const call of m.toolCalls ?? []) pending.set(call.id, { index: i, call });
    if (m.role === 'tool' && m.toolCallId && pending.has(m.toolCallId)) {
      const associated = pending.get(m.toolCallId)!;
      pairs.push([associated.index, i]);
      callsByResult.set(i, associated.call);
      pending.delete(m.toolCallId);
    }
  }
  for (let i = pairs.length - 1; i >= 0; i--) {
    const [start, end] = pairs[i];
    if (start < cutoff && end >= cutoff) cutoff = start;
  }
  if (!cutoff) return { history, count: 0 };

  // Match the complete associated call too: IDs may be reused and active and
  // original histories can be restored separately or be inconsistent.
  const originals = new Map<string, Map<string, number | null>>();
  const archivePending = new Map<string, ToolCall>();
  for (let i = 0; i < archive.length; i++) {
    const m = archive[i];
    if (m.role === 'assistant') for (const call of m.toolCalls ?? []) archivePending.set(call.id, call);
    if (m.role !== 'tool' || !m.toolCallId) continue;
    const call = archivePending.get(m.toolCallId);
    archivePending.delete(m.toolCallId);
    if (!call) continue;
    const key = JSON.stringify([m.toolCallId, m.name ?? null, call.name, call.arguments]);
    let byCall = originals.get(m.content);
    if (!byCall) originals.set(m.content, byCall = new Map());
    if (!byCall.has(key)) byCall.set(key, i + 1);
    else byCall.set(key, null); // Reused IDs with identical output have ambiguous provenance.
  }
  const shortened = history.slice();
  let count = 0;
  for (let i = 0; i < cutoff; i++) {
    const m = history[i];
    if (m.role !== 'tool' || !m.toolCallId || Buffer.byteLength(m.content, 'utf8') < 4096) continue;
    const call = callsByResult.get(i);
    if (!call) continue;
    const index = originals.get(m.content)?.get(JSON.stringify([m.toolCallId, m.name ?? null, call.name, call.arguments]));
    if (index == null) continue;
    // At most 2048 code units are needed to find a 512-byte excerpt.
    const start = Math.max(0, m.content.length - 2048);
    const tailStart = start > 0 && /[\uDC00-\uDFFF]/.test(m.content[start]) && /[\uD800-\uDBFF]/.test(m.content[start - 1]) ? start - 1 : start;
    const take = (fromEnd: boolean): string => {
      const chars = Array.from(fromEnd ? m.content.slice(tailStart) : m.content.slice(0, 2048));
      let bytes = 0;
      const out: string[] = [];
      for (let n = 0; n < chars.length; n++) {
        const ch = chars[fromEnd ? chars.length - 1 - n : n];
        const size = Buffer.byteLength(ch, 'utf8');
        if (bytes + size > 512) break;
        bytes += size;
        out.push(ch);
      }
      return fromEnd ? out.reverse().join('') : out.join('');
    };
    const content = `[Older tool result shortened; recorded message_index=${index} in the current conversation archive (read_conversation). The recorded result may itself be partial.]\n[Recorded beginning]\n${take(false)}\n[Middle omitted from active context]\n[Recorded end]\n${take(true)}`;
    if (Buffer.byteLength(content, 'utf8') >= Buffer.byteLength(m.content, 'utf8')) continue;
    shortened[i] = { ...m, content };
    count++;
  }
  return { history: count ? shortened : history, count };
}
