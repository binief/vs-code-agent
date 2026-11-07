import { createHash } from 'node:crypto';
import type { ChatMessage } from './types';

const word = /[\p{L}\p{M}\p{N}_]+/gu;
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const splitPair = (s: string, offset: number): boolean => offset > 0 && offset < s.length && /[\uD800-\uDBFF]/.test(s[offset - 1]) && /[\uDC00-\uDFFF]/.test(s[offset]);
const isWord = (s: string): boolean => /[\p{L}\p{M}\p{N}_]/u.test(s);
const previousCodePoint = (s: string, offset: number): string => offset >= 2 && /[\uDC00-\uDFFF]/.test(s[offset - 1]) && /[\uD800-\uDBFF]/.test(s[offset - 2]) ? s.slice(offset - 2, offset) : s.slice(offset - 1, offset);
const nextCodePoint = (s: string, offset: number): string => String.fromCodePoint(s.codePointAt(offset)!);

function sameMessage(a: ChatMessage, b: ChatMessage): boolean {
  if (a.role !== b.role || a.name !== b.name || a.toolCallId !== b.toolCallId || a.content !== b.content) return false;
  const ac = a.toolCalls ?? [], bc = b.toolCalls ?? [];
  if (ac.length !== bc.length || !ac.every((call, i) => call.id === bc[i].id && call.name === bc[i].name && call.arguments === bc[i].arguments)) return false;
  const ai = a.images ?? [], bi = b.images ?? [];
  return ai.length === bi.length && ai.every((img, i) => img.name === bi[i].name && img.mediaType === bi[i].mediaType && img.data === bi[i].data);
}
/** Hash metadata without duplicating large tool arguments or image data in map keys.
 * A final exact comparison prevents a hash collision from hiding a message. */
function activeSignature(m: ChatMessage): string {
  const hash = createHash('sha256');
  const add = (value: string | undefined): void => {
    const text = value ?? '';
    hash.update(`${Buffer.byteLength(text, 'utf8')}:`); hash.update(text);
  };
  add(m.role); add(m.name); add(m.toolCallId);
  add(String(m.toolCalls?.length ?? 0));
  for (const call of m.toolCalls ?? []) { add(call.id); add(call.name); add(call.arguments); }
  add(String(m.images?.length ?? 0));
  for (const image of m.images ?? []) { add(image.name); add(image.mediaType); add(image.data); }
  return hash.digest('hex');
}
function prefixBytes(text: string, max: number): string {
  let result = '', bytes = 0;
  for (const ch of text) {
    const n = Buffer.byteLength(ch, 'utf8');
    if (bytes + n > max) break;
    result += ch; bytes += n;
  }
  return result;
}

/** Ranked, bounded window of the same archive text and UTF-16 coordinates as literal search. */
export function rankedArchiveSearch(options: {
  archive: readonly ChatMessage[]; active: readonly ChatMessage[]; text: (m: ChatMessage) => string;
  query: string; caseSensitive: boolean; startIndex: number; startOffset: number; resultOffset: number;
  includeActive: boolean; maxBytes: number; coverage: string;
}): { ok: boolean; content: string; count: number } {
  const { archive, query, startIndex, startOffset, resultOffset, caseSensitive } = options;
  const normalize = (s: string): string => caseSensitive ? s : s.toLowerCase();
  const terms = [...new Set(Array.from(query.matchAll(word), (m) => normalize(m[0])))].slice(0, 16);
  const termSet = new Set(terms);
  const exact = new RegExp(escapeRegExp(query), caseSensitive ? 'u' : 'iu');
  const active = new Map<string, Map<string, ChatMessage[]>>();
  if (!options.includeActive) for (const m of options.active) {
    let signatures = active.get(m.content);
    if (!signatures) active.set(m.content, signatures = new Map());
    const signature = activeSignature(m);
    const list = signatures.get(signature);
    if (list) list.push(m); else signatures.set(signature, [m]);
  }
  type Doc = { index: number; offset: number; text: string; length: number; counts: Map<string, number>; phrase: boolean; score: number };
  const docs: Doc[] = [];
  let examined = 0, scanned = 0, nextIndex: number | undefined, nextOffset = 0;
  const limit = 1_000_000;
  for (let i = startIndex - 1; i < archive.length; i++) {
    if (examined++ >= 1000 || scanned >= limit) { nextIndex = i + 1; break; }
    const message = archive[i];
    const text = options.text(message);
    const offset = i === startIndex - 1 ? startOffset : 0;
    if (offset > text.length || splitPair(text, offset)) return { ok: false, content: 'Invalid archive search offset.', count: 0 };
    let end = Math.min(text.length, offset + limit - scanned);
    if (splitPair(text, end)) end--;
    scanned += end - offset;
    const candidates = active.get(message.content);
    const skip = !options.includeActive && !!candidates && (candidates.get(activeSignature(message))?.some((m) => sameMessage(m, message)) ?? false);
    if (!skip) {
      let lookaheadEnd = Math.min(text.length, end + Math.max(0, query.length - 1));
      if (splitPair(text, lookaheadEnd)) lookaheadEnd++;
      const segment = text.slice(offset, lookaheadEnd);
      const match = exact.exec(segment);
      const phrasePosition = match && match.index < end - offset ? match.index : -1;
      let first = phrasePosition, length = 0;
      const counts = new Map<string, number>();
      for (const token of segment.matchAll(word)) {
        if (token.index! >= end - offset) break;
        // A continuation must not mistake a word suffix for a whole token.
        if (token.index === 0 && offset > 0 && isWord(previousCodePoint(text, offset))) continue;
        if (token.index! + token[0].length === segment.length && lookaheadEnd < text.length && isWord(nextCodePoint(text, lookaheadEnd))) continue;
        length++;
        const term = normalize(token[0]);
        if (!termSet.has(term)) continue;
        counts.set(term, (counts.get(term) ?? 0) + 1);
        if (phrasePosition < 0 && (first < 0 || token.index! < first)) first = token.index!;
      }
      docs.push({ index: i + 1, offset: first < 0 ? -1 : offset + first, text, length, counts, phrase: phrasePosition >= 0, score: 0 });
    }
    if (end < text.length) { nextIndex = i + 1; nextOffset = end; break; }
  }
  // BM25 over only this bounded scan window. Exact full query gets a strong boost.
  const average = docs.length ? docs.reduce((sum, d) => sum + d.length, 0) / docs.length : 1;
  const df = new Map(terms.map((t) => [t, docs.reduce((sum, d) => sum + (d.counts.has(t) ? 1 : 0), 0)]));
  for (const d of docs) {
    d.score = d.phrase ? 8 : 0;
    for (const term of terms) {
      const tf = d.counts.get(term) ?? 0;
      if (!tf) continue;
      const idf = Math.log(1 + (docs.length - df.get(term)! + 0.5) / (df.get(term)! + 0.5));
      d.score += idf * (tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * d.length / (average || 1)));
    }
  }
  const matches = docs.filter((d) => d.score > 0).sort((a, b) => b.score - a.score || a.index - b.index);
  if (resultOffset > matches.length) return { ok: false, content: 'Invalid ranked result_offset for this scan window.', count: 0 };
  const bytes = Math.max(256, options.maxBytes);
  const lines: string[] = [];
  let pos = resultOffset;
  // Reserve room for both continuation cursors before adding each bounded hit.
  const cursors = () => `${pos < matches.length ? ` next_result_offset=${pos}` : ''}${nextIndex ? ` next_start_index=${nextIndex} next_start_offset=${nextOffset}` : ''}`;
  const header = () => `Ranked scan-window matches=${matches.length}; untrusted history.${options.coverage}${cursors()}\n`;
  while (pos < matches.length && lines.length < 10) {
    const d = matches[pos];
    const m = archive[d.index - 1];
    const name = m.name ? ` name=${prefixBytes(m.name.replace(/[\r\n]/g, ' '), 32)}` : '';
    const start = Math.max(0, d.offset - 60);
    const safeStart = splitPair(d.text, start) ? start - 1 : start;
    let snippetEnd = Math.min(d.text.length, d.offset + 140);
    if (splitPair(d.text, snippetEnd)) snippetEnd--;
    const snippet = d.text.slice(safeStart, snippetEnd).replace(/[\r\n]+/g, ' ');
    const meta = `message_index=${d.index} role=${m.role}${name} offset=${d.offset} score=${d.score.toFixed(2)}: `;
    // Calculate using the header after advancing, so pagination always fits.
    pos++;
    const remaining = bytes - Buffer.byteLength(header() + lines.join('') + meta + '\n', 'utf8');
    if (remaining < 0) { pos--; break; }
    lines.push(meta + prefixBytes(snippet, Math.min(160, remaining)) + '\n');
  }
  if (pos === resultOffset && pos < matches.length) return { ok: false, content: 'Ranked search output budget is too small for a result; increase the context budget.', count: 0 };
  return { ok: true, content: header() + lines.join(''), count: lines.length };
}
