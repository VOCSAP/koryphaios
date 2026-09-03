// Not named *.test.ts on purpose: the test-file enumerations here filter
// strictly on that suffix, so this module stays reachable only by relative
// import, never collected as a test entrypoint.

type CharSet = string | string[];

function toCharArray(cs: CharSet): string[] {
  return Array.isArray(cs) ? cs : [cs];
}

/**
 * Finds the index one past the character in openCh at openIdx, balancing nested
 * pairs.
 * openCh/closeCh accept a single character or an array sharing one depth
 * counter (needed when '(', '{', '[' must nest as one balanced unit).
 * Throws, naming the anchor, if depth never returns to 0 -- never returns an
 * EOF-truncated index.
 * quoteAware (default false) tracks quoted strings so a bracket character
 * inside a string literal does not desync the count; escaped quotes are skipped
 * as a pair.
 */
export function findMatchingClose(
  s: string,
  openIdx: number,
  openCh: CharSet,
  closeCh: CharSet,
  quoteAware = false
): number {
  const opens = toCharArray(openCh);
  const closes = toCharArray(closeCh);
  let depth = 1;
  let i = openIdx + 1;
  let inString: string | null = null;
  while (depth > 0 && i < s.length) {
    const c = s[i]!;
    if (quoteAware) {
      if (inString) {
        if (c === "\\") {
          i += 2;
          continue;
        }
        if (c === inString) inString = null;
        i++;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        inString = c;
        i++;
        continue;
      }
    }
    if (opens.includes(c)) depth++;
    else if (closes.includes(c)) depth--;
    i++;
  }
  if (depth !== 0) {
    throw new Error(
      `findMatchingClose: "${opens.join("/")}...${closes.join("/")}" block starting at "${s.slice(Math.max(0, openIdx - 60), openIdx + 1)}" never closed -- source truncated, renamed, or reshaped?`
    );
  }
  return i;
}

/**
 * Convenience wrapper matching the exact contract of the byte-identical
 * `extractBracedBody(src, openIdx)` copies Lot A retired: `openIdx` must
 * point at the opening `{`, returns the slice strictly BETWEEN the matching
 * braces (excludes both). Same failure mode as `findMatchingClose` above --
 * throws rather than silently slicing to EOF.
 */
export function extractBracedBody(src: string, openIdx: number, quoteAware = false): string {
  return src.slice(openIdx + 1, findMatchingClose(src, openIdx, "{", "}", quoteAware) - 1);
}

/** Same contract as extractBracedBody, for a `(` ... `)` call-argument list. `openIdx` must point at the opening `(`. */
export function extractParenBody(src: string, openIdx: number, quoteAware = false): string {
  return src.slice(openIdx + 1, findMatchingClose(src, openIdx, "(", ")", quoteAware) - 1);
}

/** Same contract as extractBracedBody, for a `[` ... `]` array literal. `openIdx` must point at the opening `[`. */
export function extractBracketedBody(src: string, openIdx: number, quoteAware = false): string {
  return src.slice(openIdx + 1, findMatchingClose(src, openIdx, "[", "]", quoteAware) - 1);
}
