/**
 * Line-ending helpers shared by the file tools and the approval diff.
 *
 * Model output normally uses LF regardless of the host platform.  We keep that
 * representation for matching and display, then convert it back to the file's
 * existing style (or the OS default for new files) immediately before writing.
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
