// Enforces TESTING.md's rule that files under tests/ needing
// react/react-dom/zustand go through the desktop bridge, never a bare import:
// root and desktop/ are separate npm trees, so a bare import resolves against
// whichever copy is nearest and mixing the two throws an 'Invalid hook call'.
// CI has no desktop/node_modules at the point this suite runs, so the bug only
// shows up locally -- a comment alone would not catch it, so this is a gate.
// Walks the tests/ directory recursively via readdirSync rather than a fixed
// file list, so coverage does not silently shrink.
// mechanism). A bare `import 'react'` (or react-dom / zustand) from a file -- scanfile-swallow-ok: prose example, not a real import

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  SCAN_FIXTURES,
  SPECIFIER_MATCH_FIXTURES,
  SWALLOW_FIXTURES,
  UNTERMINATED_FIXTURES,
  ZUSTAND_QUOTED_SUBSTRING
} from "../desktop/tests-support/hygiene-fixtures";

const TESTS_DIR = join(import.meta.dir);

// Matches the quoted specifier text itself, not an import syntax shape: a
// syntax-anchored version measurably missed dynamic import(), subpath imports,
// and re-exports.
// Comments are stripped from content before this pattern runs, so this file's
// own explanatory prose never needs to dodge its own regex.
// `await import("zustand")` and `zustand/middleware`-style subpaths -- // scanfile-swallow-ok: prose example
// `await import("zustand")` and walk straight through a syntax-shaped // scanfile-swallow-ok: prose example
// gate. A side-effect `import "react"` and a re-export `export { x } from // scanfile-swallow-ok: prose example
// "react"` are two more shapes that pattern would have missed, undiscovered // scanfile-swallow-ok: prose example
// (`` await import(`zustand`) ``, real JS, not hypothetical: this repo's own // scanfile-swallow-ok: prose example
const REACT_SPECIFIER_PATTERN = /["'](react|react-dom|zustand)(\/[^"']*)?["']/g;

// Measured, not assumed, before choosing this shape: adding backtick to
// REACT_SPECIFIER_PATTERN's delimiter class directly (the first attempt)
// closed the template-specifier gap but cost far more than it fixed -- this
// codebase's own comment style uses backtick-wrapped inline code
// (`` `react` ``, `` `zustand/middleware` ``) constantly to reference these
// exact words in prose, and every one of those, correctly stripped as a real
// comment, now reads as a "swallowed specifier" to the diff below. 10+ false
// positives in this file's own header alone. A real dynamic import with a
// template-literal specifier has a much narrower, checkable shape --
// `import(...)`/`require(...)` call syntax around the backtick literal, not
// a bare backtick-quoted word anywhere in the text -- so that shape is
// matched separately instead of widening the general delimiter class.
const REACT_TEMPLATE_SPECIFIER_PATTERN =
  /\b(?:import|require)\s*\(\s*`(react|react-dom|zustand)(\/[^`]*)?`\s*\)/g;

// Known, documented gaps in this call-syntax-anchored pattern: variable
// indirection (const p = `zustand`; import(p)), a second call argument like an
// import-assertion object, and mock.module(`react`, ...) written with backticks
// instead of quotes.

function findAllSpecifierMatches(text: string): { text: string; index: number }[] {
  const quoted = [...text.matchAll(REACT_SPECIFIER_PATTERN)].map((m) => ({ text: m[0], index: m.index! }));
  const templated = [...text.matchAll(REACT_TEMPLATE_SPECIFIER_PATTERN)].map((m) => {
    // Report just the backtick literal (group 1 starts right after the
    // `(` + optional whitespace + backtick prefix), not the whole call
    // expression, so violation/warning messages stay consistent in shape
    // with the quote-delimited matches above.
    const literalStart = m.index! + m[0].indexOf("`");
    const literalEnd = m[0].lastIndexOf("`") + 1;
    return { text: m[0].slice(m[0].indexOf("`"), literalEnd), index: literalStart };
  });
  return [...quoted, ...templated];
}

// A specifier present in the RAW source but missing from `scanFile`'s output
// was eaten by the stripper, not legitimately absent -- silent and dangerous
// in exactly the direction CLAUDE.md's gating-coverage rule warns about
// (fewer matches, no error, nobody notices). Confirmed real via probe:
// an unterminated `/* ...` (or one masquerading as unterminated -- a division
// `a[0]/` immediately followed by `*` is unconditionally a real block-comment
// open in JS, the heuristic doesn't get a vote once `/*` appears) swallows to
// EOF; JSX text containing `http://` or a stray `/*` has no comment semantics
// in real JS/TSX, but scanFile has no JSX model and reads it as a comment
// anyway. This check doesn't need to know WHY a specifier went missing, only
// that it did -- it diffs raw-vs-stripped specifier occurrences directly.
const SWALLOW_OK_MARKER = "scanfile-swallow-ok";

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text[i] === "\n") line++;
  return line;
}

// Diffs by character position (kept[i] per source index), not by text value:
// the same specifier text can appear more than once in a file, mixing a
// legitimately-stripped comment mention with legitimately-preserved code, and a
// value-based diff misattributes which occurrence was actually swallowed.
// that mix -- `'react'` appears both inside real comments elsewhere in this // scanfile-swallow-ok: prose example
function findSwallowedSpecifiers(file: string, raw: string, kept: boolean[]): string[] {
  const rawMatches = findAllSpecifierMatches(raw);
  const problems: string[] = [];
  for (const rm of rawMatches) {
    const span = kept.slice(rm.index, rm.index + rm.text.length);
    if (span.length > 0 && span.every(Boolean)) continue; // every char of THIS occurrence survived -- not a swallow
    const line = lineOf(raw, rm.index);
    const rawLine = raw.split("\n")[line - 1] ?? "";
    // Inline escape hatch on the RAW line the swallowed specifier lived on --
    // a conscious per-occurrence acknowledgment, never a file-level exemption
    // list (the same reasoning as "exempt one line, not the pattern" above).
    if (rawLine.includes(SWALLOW_OK_MARKER)) continue;
    problems.push(
      `${file}:${line}: scanFile's comment-strip removed specifier ${rm.text} present in the raw source ` +
        `(a nearby comment-open sequence likely misfired and ate it) -- if intentional/harmless, add ` +
        `"${SWALLOW_OK_MARKER}" on this line; do not exempt the file`
    );
  }
  return problems;
}

// Strips // and /* */ comments while leaving string, template and regex
// literals untouched, via a single left-to-right state scanner (code /
// single-quote / double-quote / template / line comment / block comment / regex
// / regex character class) rather than one combined regex.
// A regex-alternation version corrupted an unpaired apostrophe inside comment
// prose into a runaway string match, and mis-scanned a raw '/' inside a regex
// character class as a comment delimiter; the character scanner resolves both
// by tracking exactly one state at a time.
// Template literals are the one span allowed to cross newlines and are treated
// as one opaque protected span including any interpolation; nested template
// interpolation containing another backtick is a known, unexercised gap.
// (`` await import(`zustand`) ``) survives scanFile's output untouched but // scanfile-swallow-ok: prose example
function scanFileDetailed(src: string): { out: string; kept: boolean[] } {
  type State = "code" | "sstring" | "dstring" | "template" | "lineComment" | "blockComment" | "regex" | "regexClass";
  let state: State = "code";
  let out = "";
  const kept: boolean[] = new Array(src.length).fill(false);
  let prevSignificant = ""; // last non-whitespace "code"-state char, for the regex-vs-division heuristic
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    const next = src[i + 1];
    switch (state) {
      case "code": {
        if (c === '"') {
          state = "dstring";
          out += c;
          kept[i] = true;
        } else if (c === "'") {
          state = "sstring";
          out += c;
          kept[i] = true;
        } else if (c === "`") {
          state = "template";
          out += c;
          kept[i] = true;
        } else if (c === "/" && next === "/") {
          state = "lineComment";
          i++; // both chars of "//" dropped -- kept[i] and kept[i+1] stay false
        } else if (c === "/" && next === "*") {
          state = "blockComment";
          i++; // both chars of "/*" dropped -- kept[i] and kept[i+1] stay false
        } else if (c === "/" && !/[\w$)\]]/.test(prevSignificant)) {
          // Not preceded by an identifier/`)`/`]` -- same heuristic real
          // engines use to tell a regex literal from a division operator.
          state = "regex";
          out += c;
          kept[i] = true;
        } else {
          out += c;
          kept[i] = true;
        }
        if (!/\s/.test(c)) prevSignificant = c;
        break;
      }
      case "sstring":
      case "dstring": {
        out += c;
        kept[i] = true;
        if (c === "\\" && next !== undefined) {
          out += next;
          kept[i + 1] = true;
          i++;
        } else if (c === "\n") {
          // Not valid JS/TS (unterminated string) -- bail defensively
          // rather than let the match run away across the rest of the file.
          state = "code";
          prevSignificant = c;
        } else if ((state === "sstring" && c === "'") || (state === "dstring" && c === '"')) {
          state = "code";
          prevSignificant = c;
        }
        break;
      }
      case "template": {
        out += c;
        kept[i] = true;
        if (c === "\\" && next !== undefined) {
          out += next;
          kept[i + 1] = true;
          i++;
        } else if (c === "`") {
          state = "code";
          prevSignificant = c;
        }
        break;
      }
      case "lineComment": {
        if (c === "\n") {
          state = "code";
          out += c; // keep the newline so line numbers in `out` stay aligned with `src`
          kept[i] = true;
          prevSignificant = "";
        }
        // else: drop the char entirely -- this is the "strip" in stripComments; kept[i] stays false
        break;
      }
      case "blockComment": {
        if (c === "\n") {
          out += c;
          kept[i] = true;
        } else if (c === "*" && next === "/") {
          state = "code";
          prevSignificant = "";
          i++; // both chars of the closing "*/" dropped -- kept[i] and kept[i+1] stay false
        }
        break;
      }
      case "regex": {
        out += c;
        kept[i] = true;
        if (c === "\\" && next !== undefined) {
          out += next;
          kept[i + 1] = true;
          i++;
        } else if (c === "[") {
          state = "regexClass";
        } else if (c === "/") {
          state = "code";
          prevSignificant = c;
        } else if (c === "\n") {
          // Not a valid regex literal (can't span a newline) -- this was
          // actually a division, not a regex; the heuristic guessed wrong,
          // but every character seen so far was appended to `out` verbatim
          // either way, so no content was lost by the misclassification.
          state = "code";
          prevSignificant = "";
        }
        break;
      }
      case "regexClass": {
        out += c;
        kept[i] = true;
        if (c === "\\" && next !== undefined) {
          out += next;
          kept[i + 1] = true;
          i++;
        } else if (c === "]") {
          state = "regex";
        } else if (c === "\n") {
          state = "code";
          prevSignificant = "";
        }
        // A raw "/" here is exactly the case (b) shape above -- legal
        // inside a character class, and correctly NOT treated as a
        // comment/regex delimiter because we're tracking this state.
        break;
      }
    }
  }
  // Catches ONLY the case where a swallow reaches EOF still inside a
  // non-"code" state (an unterminated string/template/comment/regex) --
  // reviewer-measured: of the five confirmed swallow shapes, this throw
  // fires on exactly one (an unclosed `/*` that never finds a `*/` before
  // EOF). The other four (division-misread-as-comment-open, JSX `http://`,
  // JSX stray `/*`, template-literal specifier invisible to the pattern) all
  // end the scan back in "code" state -- silent to this check, caught
  // instead by findSwallowedSpecifiers's raw-vs-kept diff above and the
  // separate template-specifier pattern above that. Kept for what it
  // actually is (a narrow, cheap, honest guard on one shape), not
  // represented as covering the rest.
  if (state !== "code") {
    throw new Error(
      `scanFile: reached end of file still inside state "${state}" -- an unterminated ` +
        `string/template/comment/regex literal swallowed everything after it. Fix the source, ` +
        `it is almost certainly a real syntax defect, not a scanner bug.`
    );
  }
  return { out, kept };
}

export function scanFile(src: string): string {
  return scanFileDetailed(src).out;
}

function listTestFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    const stat = statSync(full);
    // Recurses into subdirectories rather than skipping them, so a future file
    // nested under tests/ is not silently exempted by its path.
    if (stat.isDirectory()) {
      files.push(...listTestFiles(full));
    } else {
      files.push(full);
    }
  }
  return files;
}

test("no file under tests/ references the react/react-dom/zustand specifier directly", () => {
  const files = listTestFiles(TESTS_DIR).filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"));

  // Sanity floor: fails if the walk itself is broken (e.g. wrong directory,
  // permissions issue silently returning an empty list) rather than
  // reporting a false "0 violations found" pass.
  expect(files.length).toBeGreaterThan(50);

  const violations: string[] = [];
  const swallowWarnings: string[] = [];
  for (const file of files) {
    const raw = readFileSync(file, "utf-8");
    const { out: content, kept } = scanFileDetailed(raw);
    const matches = findAllSpecifierMatches(content);
    for (const m of matches) {
      violations.push(`${file}: direct reference to specifier "${m.text}"`);
    }
    swallowWarnings.push(...findSwallowedSpecifiers(file, raw, kept));
  }

  // Checked first and separately: a swallowed specifier is a false NEGATIVE
  // on `violations` below (the whole reason this diff exists), so it must
  // fail loudly on its own rather than only show up as a suspiciously clean
  // `violations` pass.
  expect(swallowWarnings).toEqual([]);
  expect(violations).toEqual([]);
});

// Unit tests for scanFile in isolation: the integration test above walks real
// files and stays green whether scanFile is correct or over-strips, since it
// can't distinguish 'no violations' from 'a violation got eaten before it could
// be counted'.
// Of scanFile's 8 states, only lineComment and blockComment can ever lose text;
// each case below targets the scanner entering one of those two states at the
// wrong position, or failing to leave one when it should.
function assertScan(input: string, expectContains: string[], expectNotContains: string[] = []): void {
  const out = scanFile(input);
  for (const s of expectContains) {
    expect(out, `expected scanFile output to contain ${JSON.stringify(s)}; got ${JSON.stringify(out)}`).toContain(s);
  }
  for (const s of expectNotContains) {
    expect(
      out,
      `expected scanFile output to NOT contain ${JSON.stringify(s)}; got ${JSON.stringify(out)}`
    ).not.toContain(s);
  }
}

test("scanFile: string containing // is not misread as a comment", () => {
  const f = SCAN_FIXTURES.stringWithSlashSlashNotComment;
  assertScan(f.input, [...f.expectContains]);
});
test("scanFile: string containing /* is not misread as a comment", () => {
  const f = SCAN_FIXTURES.stringWithSlashStarNotComment;
  assertScan(f.input, [...f.expectContains]);
});
test("scanFile: real single-quoted specifier survives (code -> sstring -> code)", () => {
  const f = SCAN_FIXTURES.singleQuotedSpecifierSurvives;
  assertScan(f.input, [...f.expectContains]);
});
test("scanFile: escaped quote inside a double-quoted string doesn't break the scan", () => {
  const f = SCAN_FIXTURES.escapedQuoteInsideString;
  assertScan(f.input, [...f.expectContains]);
});
test("scanFile: regex bracket-slash does not swallow a following import", () => {
  const f = SCAN_FIXTURES.regexBracketSlash;
  assertScan(f.input, [...f.expectContains]);
});
test("scanFile: regex bracket-slash with // inside the class, same line", () => {
  const f = SCAN_FIXTURES.regexBracketSlashSlashSameLine;
  assertScan(f.input, [...f.expectContains]);
});
test("scanFile: regex bracket-slash content that could fake-open a block comment", () => {
  // The actual content-loss-proving shape: without regexClass tracking, the
  // internal "/" mis-closes the regex early, and the immediately following
  // "/" + "*" form a genuine (wrongly-entered) unterminated block-comment
  // open right before the import.
  const f = SCAN_FIXTURES.regexBracketSlashFakeBlockComment;
  assertScan(f.input, [...f.expectContains]);
});
test("scanFile: apostrophes across multiple line comments don't swallow later code", () => {
  const f = SCAN_FIXTURES.apostrophesAcrossMultipleLineComments;
  assertScan(f.input, [...f.expectContains]);
});
test("scanFile: apostrophes inside a block comment don't swallow later code", () => {
  const f = SCAN_FIXTURES.apostrophesInsideBlockComment;
  assertScan(f.input, [...f.expectContains]);
});
test("scanFile: // comment mentioning react is stripped", () => {
  const f = SCAN_FIXTURES.lineCommentMentioningReactIsStripped;
  assertScan(f.input, [...f.expectContains], [...(f.expectNotContains ?? [])]);
});
test("scanFile: block comment mentioning react-dom is stripped", () => {
  const f = SCAN_FIXTURES.blockCommentMentioningReactDomIsStripped;
  assertScan(f.input, [...f.expectContains], [...(f.expectNotContains ?? [])]);
});
test("scanFile: mixed line -- code then trailing comment naming a specifier doesn't leak", () => {
  const f = SCAN_FIXTURES.trailingCommentNamingSpecifierDoesNotLeak;
  assertScan(f.input, [...f.expectContains], [...(f.expectNotContains ?? [])]);
});
test("scanFile: array literal wrapping a regex call preserves a later import", () => {
  const f = SCAN_FIXTURES.arrayLiteralWrappingRegexCallPreservesImport;
  assertScan(f.input, [...f.expectContains]);
});
test("scanFile: multiline template literal preserved across newlines", () => {
  const f = SCAN_FIXTURES.multilineTemplateLiteralPreservedAcrossNewlines;
  assertScan(f.input, [...f.expectContains]);
});
test("scanFile: division after an identifier is not misread as a regex literal open", () => {
  const f = SCAN_FIXTURES.divisionAfterIdentifierNotMisreadAsRegex;
  assertScan(f.input, [...f.expectContains]);
});
test("scanFile: division after ) is not misread as a regex literal open", () => {
  const f = SCAN_FIXTURES.divisionAfterCloseParenNotMisreadAsRegex;
  assertScan(f.input, [...f.expectContains]);
});
test("scanFile: division after ] is not misread as a regex literal open", () => {
  const f = SCAN_FIXTURES.divisionAfterCloseBracketNotMisreadAsRegex;
  assertScan(f.input, [...f.expectContains]);
});

// scanFile itself is not changed to fix these reviewer-found gaps -- that would
// need a real JSX/regex parser -- instead findSwallowedSpecifiers and the
// widened specifier pattern close them at the output level, so nothing goes
// missing silently even though scanFile's internal comment model stays
// approximate.

test("scanFile itself: unterminated block comment swallows to EOF (throws, doesn't silently eat)", () => {
  expect(() => scanFile(UNTERMINATED_FIXTURES.unterminatedBlockComment)).toThrow();
});

test("scanFile itself: division immediately followed by * opens a real (unterminated) block comment", () => {
  // `a[0]/` is correctly read as division (heuristic rejects "/" after "]"),
  // but `/*` is UNCONDITIONALLY a block-comment open in real JS regardless
  // of what the "/" was -- and here it's never closed, so it throws too.
  expect(() =>
    scanFile(UNTERMINATED_FIXTURES.divisionImmediatelyFollowedByStarOpensRealComment)
  ).toThrow();
});

test("swallow check: JSX-embedded http:// on the same line as an import is caught, not silently lost", () => {
  // Trailing "\n" so the http:// line comment closes normally before EOF --
  // this test is about the mid-file swallow (still ends in "code" state),
  // not the EOF-unterminated case covered by the two tests above.
  const raw = SWALLOW_FIXTURES.jsxEmbeddedHttpOnSameLineAsImport;
  const { kept } = scanFileDetailed(raw);
  const warnings = findSwallowedSpecifiers("fixture.tsx", raw, kept);
  expect(warnings.length).toBe(1);
  expect(warnings[0]).toContain(ZUSTAND_QUOTED_SUBSTRING);
});

test("swallow check: an inline scanfile-swallow-ok marker silences one acknowledged occurrence", () => {
  const raw = SWALLOW_FIXTURES.jsxEmbeddedHttpWithInlineSwallowOkMarker;
  const { kept } = scanFileDetailed(raw);
  const warnings = findSwallowedSpecifiers("fixture.tsx", raw, kept);
  expect(warnings).toEqual([]);
});

test("pattern: a template-literal specifier in real import()/require() call syntax is detected directly", () => {
  const raw = SPECIFIER_MATCH_FIXTURES.templateLiteralSpecifierInRealImportCall;
  const matches = findAllSpecifierMatches(raw);
  expect(matches.length).toBe(1);
  expect(matches[0]!.text).toBe("`zustand`");
});

test("pattern: a bare backtick-quoted mention in prose is NOT treated as a specifier", () => {
  // The narrower call-shape pattern exists precisely so this doesn't fire --
  // confirmed regression guard for the false-positive blast radius measured
  // when backtick was first added to the general delimiter class directly
  // (10+ false "swallow" warnings from this file's own header alone). No
  // trailing quoted import in this fixture on purpose -- one snuck in here
  // originally and trivially satisfied the quote-delimited pattern on its
  // own, making this assertion pass for the wrong reason regardless of the
  // backtick logic under test.
  const raw = SPECIFIER_MATCH_FIXTURES.bareBacktickMentionInProseIsNotASpecifier;
  const matches = findAllSpecifierMatches(raw);
  expect(matches.length).toBe(0);
});
