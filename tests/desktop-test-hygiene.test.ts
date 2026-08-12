// spec_fe032ba6: discipline test enforcing the rule documented in
// TESTING.md ("0b. tests/ files that need react/react-dom/zustand: go
// through the desktop bridge, never a bare import").
//
// Root and desktop/ are two separate npm trees (see
// desktop/tests-support/react-test-harness.ts's header for the full
// mechanism). A bare `import 'react'` (or react-dom / zustand) from a file -- scanfile-swallow-ok: prose example, not a real import
// physically under tests/ resolves against the ROOT's copy; a
// desktop/src/renderer component resolves against desktop/node_modules's
// copy. Mixing the two throws "Invalid hook call... more than one copy of
// React" -- but only in LOCAL dev, where both copies happen to exist side
// by side and never meet until something under tests/ imports react
// directly. In CI, desktop/node_modules does not exist yet at the point
// this suite runs, so there is only ever one copy there -- CI stays green
// while local breaks. That is a fail-open-in-reverse: the signal shows up
// exactly where nobody is looking (a developer's machine) and disappears
// exactly where the decision to merge gets made (CI). A comment saying
// "don't do this" is not enough; this test makes it a gate.
//
// Coverage requirement (not a hardcoded file list): this test walks the
// FULL tests/ directory via readdirSync, not a fixed set of filenames.
// tests/ is flat today (no subdirectories) -- confirmed by this test's own
// assertion that every entry it sees is a file, not a directory, which
// fails loudly instead of silently under-covering if that ever changes.
//
// This file's own name matches the CI collection glob
// (tests/desktop-*.test.ts, see TESTING.md "Cross-platform tests") -- a
// discipline test that isn't collected by CI enforces nothing where it
// matters.

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

// The bridge file itself (desktop/tests-support/react-test-harness.ts) is
// physically outside tests/, so it is not scanned by this walk and needs
// no exemption. Nothing under tests/ is exempted -- including this file:
// its own scanFile unit tests need fixtures that deliberately contain a
// real, quoted react/react-dom/zustand specifier as CODE, which used to
// force a basename-matched self-exemption of THIS file from `violations`
// below. 2026-08-03 (team-lead review): that exemption wasn't fail-closed
// (a real bare import added here alongside the fixtures would have been
// silently exempted along with them, and the reviewer's compensatory guard
// for it was itself syntax-anchored -- see the deleted "self-exemption
// invariant" test this replaces). Fixed structurally, not by tightening the
// exemption: the fixtures moved to desktop/tests-support/hygiene-fixtures.ts,
// physically outside this walk, so this file's own raw source no longer
// contains a literal specifier and needs no exemption at all. The bridge
// exists precisely so nothing here ever needs a direct import of these
// packages either.
//
// Why this matches the SPECIFIER (the quoted string literal), not an
// import SYNTAX: the first version of this gate matched syntax shapes
// (`from "..."`, `require("...")`) and, measured by hand, missed dynamic
// `await import("zustand")` and `zustand/middleware`-style subpaths -- // scanfile-swallow-ok: prose example
// both real, not hypothetical: this repo's own bridge file exists BECAUSE
// dynamic import defers ES-module evaluation order, so the next person who
// hits that same ordering problem inside tests/ will reach for
// `await import("zustand")` and walk straight through a syntax-shaped // scanfile-swallow-ok: prose example
// gate. A side-effect `import "react"` and a re-export `export { x } from // scanfile-swallow-ok: prose example
// "react"` are two more shapes that pattern would have missed, undiscovered // scanfile-swallow-ok: prose example
// until someone happened to write one. Matching the specifier instead --
// any quoted string literal equal to `react`/`react-dom`/`zustand`, or
// starting with one of those followed by `/` -- makes the check indifferent
// to the syntax wrapped around it, so a fourth shape invented later still
// trips it. The optional `(\/[^"']*)?` group sits OUTSIDE the alternation,
// so it applies to whichever of the three packages matched (`react/jsx-runtime`,
// `react-dom/test-utils`, `zustand/middleware` all match), not just the one
// package that happened to need a subpath example when this was first
// written -- confirmed with a disposable probe file for each of the three,
// not assumed from reading the regex.
//
// This still false-positives on these three words appearing inside a
// fixture string or an error message; that is intentional -- a gate that
// fails loudly on a harmless string gets fixed the same day, a gate that
// lets a real import through fails silently until CI diverges from local.
// If a genuine false positive shows up in actual CODE, exempt that one line
// with a comment explaining why, not the pattern.
//
// Comments are the one case handled structurally instead of by exemption:
// this gate's own rationale (the paragraph above) and this test file's own
// history of explaining what NOT to do both cite these specifiers inside
// prose, in quotes, purely as examples -- and so does
// desktop-tile-area.test.ts's header, explaining the bridge-file mechanism.
// A gate that only survives by everyone rewording their comments to dodge
// its regex is a hardcoded exemption list wearing a disguise (the same
// failure mode CLAUDE.md calls out for allow-lists). Comments are stripped
// from `content` (see `scanFile` below) BEFORE this pattern runs, so
// prose never needs to avoid quoting these words.
//
// 2026-08-03 correction: the delimiter class was `["']` only -- quote-shaped,
// not fully specifier-shaped. A template-literal specifier
// (`` await import(`zustand`) ``, real JS, not hypothetical: this repo's own // scanfile-swallow-ok: prose example
// bridge exists BECAUSE dynamic import is a real idiom here) never matched,
// in either the raw or the scanFile-stripped text, so it was invisible both
// to this test and to the raw-vs-stripped swallow check below (0/0 delta,
// confirmed by probe -- that check only catches specifiers the STRIPPER ate,
// not specifiers this PATTERN was never shaped to see in the first place).
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

// Known coverage gaps, not fixed here (2026-08-03, reviewer-measured): this
// pattern is anchored on CALL SYNTAX; REACT_SPECIFIER_PATTERN above, its
// quote-delimited sibling, has no such anchor. Both miss real, live code
// shapes -- documented, not silently absent, per this file's own bar (a
// written, known gap beats an unknown one): (1) variable indirection, e.g.
// `const p = \`zustand\`; await import(p);` -- the backtick literal isn't
// itself wrapped in the call, and the variable reference at the call site
// carries no specifier text at all; same gap for `require(p)`. (2) a second
// argument inside the call, e.g. the import-assertion form
// `import(\`zustand\`, { assert: {...} })` -- the anchor requires `` ` ``
// immediately followed by `\s*)`, which a trailing argument breaks. (3)
// `mock.module(\`react\`, factory)` -- real code in this repo today (see
// tests/desktop-tile-area.test.ts) uses double-quoted specifiers, which
// REACT_SPECIFIER_PATTERN already catches regardless of surrounding call
// syntax; the same call written with backticks would not be, since
// `mock.module(` is neither `import(` nor `require(`.

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

// 2026-08-03 correction (self-caught, same rule this file's header cites
// against CLAUDE.md's gating-coverage bar): the first version of this
// function diffed by TEXT VALUE (a multiset -- consume one occurrence of
// each raw match's exact string from a pool built from the stripped side).
// That's wrong whenever the same specifier text appears MORE THAN ONCE in a
// file, in a mix of legitimately-stripped-away comment mentions and
// legitimately-preserved code (this file's own unit tests below are exactly
// that mix -- `'react'` appears both inside real comments elsewhere in this // scanfile-swallow-ok: prose example
// file, correctly stripped, AND inside `assertScan(...)` string arguments,
// correctly preserved). Once the stripped-side pool ran short by the count
// of real comment mentions, `Array.prototype.indexOf` blamed whichever RAW
// occurrences happened to be visited LAST in iteration order -- not
// necessarily the ones actually lost -- misflagging several of this file's
// own legitimate test fixtures as "swallowed". Fixed by checking POSITION,
// not text: `scanFileDetailed` now also returns `kept`, a boolean parallel
// to `raw` recording per-character-index whether that exact character
// survived into `out`. A raw match is only a genuine swallow if at least one
// character in its exact span was dropped; duplicate text elsewhere in the
// file can no longer affect that verdict either way.
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

// Strips `// line` and `/* block */` comments while leaving string, template
// and regex literals untouched, so a specifier that's actually inside a
// string (a real import, a mock.module call, a require) still gets seen by
// REACT_SPECIFIER_PATTERN, while the same word inside a comment doesn't.
//
// Implementation history / coverage audit (why this is a single-pass
// character scanner and not two independent regexes): a comment-stripper is
// a mechanism like any other and needs its COVERAGE checked, not just
// whether it fires on the obvious case -- false NEGATIVES here are silent
// (a real import gets eaten and never reported), unlike a false positive on
// a harmless comment, which is loud and gets fixed same day.
//
// The first version used ONE regex with strings/templates/comments as
// alternatives (`"..."|'...'|`...`|\/\*...\*\/|\/\/.*`), relying on
// leftmost-match-wins so an opening quote "claims" its content before an
// embedded `//`/`/*` inside it could be misread as a comment start. Measured
// safe for (1) a string containing "//" and (2) a string containing "/*".
// But it had two real, MEASURED bugs, not hypothetical ones:
//   a. Its single-quote alternative `'(?:[^'\\]|\\.)*'` has no concept of
//      "this is prose inside a comment, not code" -- an ordinary English
//      contraction in a comment ("doesn't", "can't") is an unpaired `'`, and
//      because `[^'\\]` also matches newlines, the regex engine happily
//      matched from that apostrophe all the way to the NEXT unrelated `'`
//      several lines (or a page) later, "blanking" a huge real span as if it
//      were one string literal. Caught via a debug script diffing expected
//      vs actual stripped output against this very file's own prose -- not
//      assumed, reproduced.
//   b. A regex literal containing a raw, unescaped "/" inside a `[...]`
//      character class (e.g. `/[/*]/`, legal JS, matches the char '/' or
//      '*') is NOT a comment, but the old stripComments had no
//      regex-literal-aware alternative and couldn't tell -- it swallowed
//      everything from that "/*" shape up to an unrelated LATER "*/",
//      silently deleting real code (imports included) in between. A
//      regex-literal-protecting alternative reusing the standard
//      "not-preceded-by-identifier/`)`/`]`" heuristic was tried and
//      rejected: it makes a plain single-line `/* comment */` with no other
//      "/" inside parse as a bogus "regex literal" instead, un-fixing the
//      original prose false positive.
//
// Fix: replace the two-regex approach with a single left-to-right character
// scanner that tracks ONE state at a time (code / single-quote string /
// double-quote string / template literal / line comment / block comment /
// regex literal / regex character class). This resolves both bugs
// structurally instead of patching around them:
//   - A plain `'...'` or `"..."` string literal cannot contain a literal,
//     unescaped newline in valid JS/TS (that's a syntax error outside a
//     template literal) -- so the scanner bails a string back to "code"
//     state the moment it hits `\n`. An unpaired apostrophe in a comment can
//     therefore only ever "leak" within the SAME line it's on, never across
//     real lines -- and in practice it never even gets the chance, because
//     comments are recognized and fully consumed as their own state before
//     any string-quoting rule inside them is considered.
//   - A regex literal's own `[...]` character class is tracked as its own
//     state, so a raw "/" inside it is correctly recognized as content, not
//     a comment or literal delimiter -- case (b) is handled by correctly
//     understanding the regex literal's true extent, not by refusing to
//     scan it.
// Template literals are the one span still allowed to cross newlines
// (correct: they can, legitimately, in real JS/TS) and are treated as one
// opaque protected span including any `${...}` interpolation.
//
// 2026-08-03 correction (reviewer-caught): this comment previously claimed
// an unpaired backtick had "the same swallows-too-much blast radius" as bugs
// (a)/(b) above. Measured, that claim was false: the `template` state does
// `out += c` on every character like every state except lineComment/
// blockComment -- it cannot lose content, unpaired backtick or not, by the
// same structural argument proven for `regex`/`regexClass` below. The real
// residual gap involving templates is different and was, at the time that
// claim was written, undocumented: a template-literal SPECIFIER
// (`` await import(`zustand`) ``) survives scanFile's output untouched but // scanfile-swallow-ok: prose example
// was invisible to REACT_SPECIFIER_PATTERN, which only matched `["']`
// delimiters -- fixed above by adding the separate, call-syntax-anchored
// REACT_TEMPLATE_SPECIFIER_PATTERN (a blanket widening of the quote pattern
// to include backtick was tried first and rejected: 10+ false positives
// against this file's own backtick-quoted prose), not by anything in this
// function. Nested template interpolation containing
// another backtick (`` `outer ${`inner`} end` ``) remains a real, undefeated
// gap in THIS function (the outer template would close early at the first
// inner backtick) -- zero occurrences in this codebase today (checked), not
// exercised by any current probe, called out honestly rather than assumed
// safe by extrapolation from the (disproven) claim this replaces.
// `kept[i]` records whether `src[i]` survived into `out` -- powers
// findSwallowedSpecifiers's per-OCCURRENCE (not per-text-value) diff below,
// so a specifier string that legitimately appears both inside a real,
// correctly-stripped comment and inside legitimately-preserved code
// elsewhere in the same file can't be misattributed either way (2026-08-03,
// self-caught: the previous text-value multiset diff did exactly that to
// several of this file's own unit-test fixtures). `scanFile` stays the
// public single-return-value entry point every other caller (and the two
// scratch probe files) already uses; `scanFileDetailed` is the one real
// implementation, not a fork of it.
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
    // Full-coverage guard, recursive: tests/ is no longer flat (e.g.
    // tests/pty-harness/). A subdirectory is walked, not skipped -- silently
    // ignoring it would be exactly the partial-coverage failure mode this
    // test exists to avoid. Downstream, only .ts/.tsx entries are scanned
    // (see the filter below), so a subdirectory of .cjs/.json fixtures adds
    // nothing to `violations` today; this recursion exists so a future .ts
    // file under any subdirectory is not silently exempted by its path.
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
    // No exemption, including for this file itself (2026-08-03, team-lead
    // review; see the header comment at the top of this file for why the
    // previous basename-matched exemption was removed rather than tightened).
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

// --- Unit tests for scanFile itself -----------------------------------
//
// 2026-08-03, reviewer-caught gap: the integration test above walks real
// files and is green whether scanFile is correct OR over-strips -- it can't
// tell the difference between "no violations" and "a violation got eaten
// before it could be counted" without a real file that happens to trip the
// exact defect shape. The red-first probe matrix that actually proved this
// scanner's fixes (13 cases, plus the 5 the reviewer found afterward) was
// run from a disposable scratch file and thrown away -- so nothing replays
// it, and the day this scanner is next touched, whoever touches it has no
// safety net. Promoted here as permanent, targeted unit tests of scanFile in
// isolation, one per state-transition risk, not as decoration.
//
// Of scanFile's 8 states, exactly two can ever lose text: lineComment and
// blockComment (every other state does `out += c` unconditionally). Every
// case below is really asking one question: what makes the scanner enter
// one of those two states AT THE WRONG POSITION, or fail to leave one before
// it should.
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

// --- Reviewer-found gaps, 2026-08-03 -----------------------------------
// Confirmed real by direct reproduction before being written up. scanFile
// itself is NOT changed to "fix" these (that would require a real JSX/regex
// parser, disproportionate for a discipline-test gate) -- instead
// findSwallowedSpecifiers (raw-vs-stripped diff) and the widened
// REACT_SPECIFIER_PATTERN close them at the level that actually matters:
// nothing can go missing from the gate's OUTPUT silently, even though
// scanFile's internal model of comments stays approximate.

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
