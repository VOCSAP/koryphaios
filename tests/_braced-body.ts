// Card 9e450573 Lot A, dedup follow-up to card 18d7fda2. That card measured
// 21 near-identical brace/paren/bracket-counting extraction copies across
// tests/*.test.ts, every one missing a `depth !== 0` termination guard --
// fixed independently, per copy, there. This module is the single shared
// implementation the MECHANICALLY SUBSTITUTABLE copies now delegate to
// (Lot A's 10 files: 6 byte-identical, 2 quote/semicolon-style-only variants,
// and one site each inside the two "mixed" files desktop-session-role-env.test.ts
// and role-domain-sweep.test.ts -- their other, genuinely derived sites stay
// local, deferred to Lot B alongside the 3 quote-aware variants, the
// different-return-bounds desktop-activity.test.ts, the already-delegating
// desktop-session-broadcast.test.ts, and the inline roadmap-guard-hook.test.ts).
//
// NAMING: deliberately NOT *.test.ts (tests/_helper.ts, tests/_store-mock.ts
// precedent). scripts/pure-module-partition.ts's listTestFiles() and
// tests/desktop-ci-glob-coverage.test.ts's independent REAL_FILES both filter
// strictly on `f.endsWith(".test.ts")` -- a file whose name doesn't end in
// that suffix is invisible to BOTH enumerations symmetrically, never
// collected as a test entrypoint, only ever imported by relative path.
//
// quoteAware: card 18d7fda2 measured that a bare `{`/`(`/`[` INSIDE A STRING
// LITERAL desyncs a naive counter (it isn't tracking strings, so the literal
// character counts as a real bracket). Pass `quoteAware: true` for callers
// that need immunity to that trick -- Lot B's extractObjectBody /
// extractBalancedParen / extractInterface shape. Lot A's 10 sites were never
// quote-aware before migration and stay that way (quoteAware omitted,
// defaults to false): enabling it here is a Lot B decision to verify against
// real source, not assumed from this lot.

/**
 * Finds the index one past the character matching `openCh` at `openIdx`
 * (i.e. `s[openIdx]` must be `openCh`), balancing nested `openCh`/`closeCh`
 * pairs. Throws, naming the anchor via a lookback snippet, if the block
 * never closes (depth never returns to 0) -- never silently returns an
 * EOF-truncated index. `quoteAware` (default false) additionally tracks
 * single/double/backtick-quoted strings so an `openCh`/`closeCh` character
 * INSIDE a string literal does not desync the count; backslash-escapes
 * inside a tracked string are skipped as a pair so an escaped quote
 * character does not end the string early.
 */
export function findMatchingClose(
  s: string,
  openIdx: number,
  openCh: string,
  closeCh: string,
  quoteAware = false
): number {
  let depth = 1;
  let i = openIdx + 1;
  let inString: string | null = null;
  while (depth > 0 && i < s.length) {
    const c = s[i];
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
    if (c === openCh) depth++;
    else if (c === closeCh) depth--;
    i++;
  }
  if (depth !== 0) {
    throw new Error(
      `findMatchingClose: "${openCh}...${closeCh}" block starting at "${s.slice(Math.max(0, openIdx - 60), openIdx + 1)}" never closed -- source truncated, renamed, or reshaped?`
    );
  }
  return i;
}

/**
 * Convenience wrapper matching the exact contract of the 8 byte-identical
 * `extractBracedBody(src, openIdx)` copies this lot retires: `openIdx` must
 * point at the opening `{`, returns the slice strictly BETWEEN the matching
 * braces (excludes both). Same failure mode as `findMatchingClose` above --
 * throws rather than silently slicing to EOF.
 */
export function extractBracedBody(src: string, openIdx: number, quoteAware = false): string {
  return src.slice(openIdx + 1, findMatchingClose(src, openIdx, "{", "}", quoteAware) - 1);
}
