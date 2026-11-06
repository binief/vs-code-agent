/**
 * Line-ending helpers shared by the file tools and the approval diff.
 *
 * Model output normally uses LF regardless of the host platform.  We keep that
 * representation for matching and display while preserving original text
 * outside targeted replacements.
 */

import * as os from 'os';

export type LineEnding = '\n' | '\r\n' | '\r';
export type LineEndingPreference = 'auto' | 'lf' | 'crlf' | 'cr' | 'native';

/** Newline used by Node for newly-created text files on this host. */
export const NATIVE_EOL: LineEnding = os.EOL === '\r\n' ? '\r\n' : '\n';

const EOL_NAMES: Record<LineEnding, string> = {
  '\n': 'LF',
  '\r\n': 'CRLF',
  '\r': 'CR',
};

/**
 * Detect the dominant line ending in a string.
 *
 * A file can contain mixed endings.  In that case the dominant style is the
 * least surprising style to preserve; ties prefer CRLF, then CR, then LF.
 * Returns null for a single-line string with no newline.
 */
export function detectEol(text: string): LineEnding | null {
  const value = String(text ?? '');
  const crlf = (value.match(/\r\n/g) ?? []).length;
  const lf = (value.match(/(?<!\r)\n/g) ?? []).length;
  const cr = (value.match(/\r(?!\n)/g) ?? []).length;
  if (crlf + lf + cr === 0) return null;
  if (crlf >= lf && crlf >= cr) return '\r\n';
  if (cr >= lf) return '\r';
  return '\n';
}

/** Convert CRLF, CR and LF into the canonical LF representation. */
export function normalizeEol(text: string): string {
  return String(text ?? '').replace(/\r\n?/g, '\n');
}

/** Normalize first, then write every logical newline using `eol`. */
export function applyEol(text: string, eol: LineEnding): string {
  const normalized = normalizeEol(text);
  return eol === '\n' ? normalized : normalized.replace(/\n/g, eol);
}

export function eolName(eol: LineEnding | null | undefined): string {
  return EOL_NAMES[eol ?? NATIVE_EOL];
}

/**
 * Resolve the configured write style.
 *
 * `auto` preserves the existing file style and uses the host OS style for a
 * new file.  The aliases are accepted so settings copied from terminal tools
 * remain understandable (`unix`, `windows`, `win`, `mac`, and `os`).
 */
export function resolveEol(
  preference: LineEndingPreference | string | undefined,
  existingEol: LineEnding | null | undefined,
): LineEnding {
  const value = String(preference ?? 'auto').trim().toLowerCase();
  if (value === 'lf' || value === 'unix') return '\n';
  if (value === 'crlf' || value === 'windows' || value === 'win') return '\r\n';
  if (value === 'cr' || value === 'mac') return '\r';
  if (value === 'native' || value === 'os') return NATIVE_EOL;
  return existingEol ?? NATIVE_EOL;
}

/** Reject unpaired UTF-16 surrogates that UTF-8 encoding would silently replace. */
export function isWellFormedText(text: string): boolean {
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);
}

/** True when text contains more than one newline style. */
export function hasMixedEol(text: string): boolean {
  let seen: LineEnding | undefined;
  for (const match of text.matchAll(/\r\n|\r|\n/g)) {
    const eol = match[0] as LineEnding;
    if (seen && seen !== eol) return true;
    seen = eol;
  }
  return false;
}

/**
 * Replace non-overlapping LF-normalized matches in original text without
 * changing any characters outside the matched ranges. Inserted newlines use
 * the first newline at or after the match start, then the preceding one,
 * then the file's dominant (or native) style.
 */
export function replaceNormalizedPreservingEol(original: string, needle: string, replacement: string, count: number): string {
  const normalized = normalizeEol(original);
  // Only CRLF changes length during normalization. Its normalized offset lets
  // us map UTF-16 boundaries back to the original without a per-character map.
  const collapsed: number[] = [];
  for (let raw = 0, logical = 0; raw < original.length; raw++, logical++) {
    if (original[raw] === '\r' && original[raw + 1] === '\n') {
      collapsed.push(logical);
      raw++;
    }
  }
  const rawOffset = (offset: number): number => {
    let low = 0;
    let high = collapsed.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (collapsed[mid] < offset) low = mid + 1;
      else high = mid;
    }
    return offset + low;
  };
  const defaultEol = detectEol(original) ?? NATIVE_EOL;
  const newlines = [...original.matchAll(/\r\n|\r|\n/g)].map((match) => ({ index: match.index!, eol: match[0] as LineEnding }));
  const firstNewlineAtOrAfter = (offset: number): number => {
    let low = 0;
    let high = newlines.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (newlines[mid].index < offset) low = mid + 1;
      else high = mid;
    }
    return low;
  };
  const parts: string[] = [];
  let logicalCursor = 0;
  let rawCursor = 0;
  for (let replaced = 0; replaced < count; replaced++) {
    const index = normalized.indexOf(needle, logicalCursor);
    if (index < 0) break;
    const start = rawOffset(index);
    const end = rawOffset(index + needle.length);
    const near = firstNewlineAtOrAfter(start);
    const localEol = newlines[near]?.eol ?? newlines[near - 1]?.eol ?? defaultEol;
    parts.push(original.slice(rawCursor, start), applyEol(replacement, localEol));
    rawCursor = end;
    logicalCursor = index + needle.length;
  }
  parts.push(original.slice(rawCursor));
  return parts.join('');
}
