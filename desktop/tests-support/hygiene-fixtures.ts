// spec_fe032ba6, A2 fix (2026-08-03, team-lead review): these fixtures used
// to live inline inside tests/desktop-test-hygiene.test.ts's own scanFile
// unit tests. Every fixture below deliberately contains a real, quoted
// react/react-dom/zustand specifier as CODE (not a comment) -- that is
// exactly the shape the discipline test in tests/ exists to catch, which
// meant the discipline test had to exempt ITSELF (by basename) from its own
// `violations` check just to keep its own unit tests from tripping it. A
// basename-matched self-exemption is precisely the kind of gate that file's
// own header spends forty lines arguing against, and the reviewer proved it
// wasn't even fail-closed on the compensatory guard meant to bound it.
//
// Moving the literal fixture DATA out here -- physically inside
// desktop/tests-support/, which the hygiene walk does not recurse into (it
// only walks TESTS_DIR = import.meta.dir, i.e. tests/ itself) -- removes the
// exemption instead of tightening it: tests/desktop-test-hygiene.test.ts now
// runs `violations` over its own (fixture-free) source like every other file
// in tests/. The test() bodies themselves, and scanFile/the patterns they
// exercise, stay in tests/desktop-test-hygiene.test.ts so they remain part
// of the CI-collected glob (tests/desktop-*.test.ts, see TESTING.md
// "Cross-platform tests") -- only the literal specifier strings move.
//
// This module is data only (no test() calls) -- it is not itself collected
// by any test glob, and does not need to be: desktop/tests-support/ already
// exists as the one place root-level tests/ code sources
// react/react-dom/zustand-adjacent material from outside tests/'s own scan.

export interface ScanFixture {
  readonly input: string;
  readonly expectContains: readonly string[];
  readonly expectNotContains?: readonly string[];
}

export const SCAN_FIXTURES = {
  stringWithSlashSlashNotComment: {
    input: `const s = "http://x"; import a from "react";`,
    expectContains: [`import a from "react"`]
  },
  stringWithSlashStarNotComment: {
    input: `const s = "a /* b"; import a from "react";`,
    expectContains: [`import a from "react"`]
  },
  singleQuotedSpecifierSurvives: {
    input: `import x from 'react';`,
    expectContains: [`import x from 'react'`]
  },
  escapedQuoteInsideString: {
    input: `const msg = "can\\'t reach it"; import x from "react";`,
    expectContains: [`import x from "react"`]
  },
  regexBracketSlash: {
    input: `const re = /[/*]/; import x from "react";`,
    expectContains: [`import x from "react"`]
  },
  regexBracketSlashSlashSameLine: {
    input: `const re = /[//]/; import x from "react";`,
    expectContains: [`import x from "react"`]
  },
  regexBracketSlashFakeBlockComment: {
    input: `const re = /[a//*]/; import x from "react";`,
    expectContains: [`import x from "react"`]
  },
  apostrophesAcrossMultipleLineComments: {
    input: `// doesn't work\n// can't reach it\nimport x from "react";`,
    expectContains: [`import x from "react"`]
  },
  apostrophesInsideBlockComment: {
    input: `/* doesn't and can't, both fine */\nimport x from "react";`,
    expectContains: [`import x from "react"`]
  },
  lineCommentMentioningReactIsStripped: {
    input: `// see "react" docs\nimport x from "zustand";`,
    expectContains: [`import x from "zustand"`],
    expectNotContains: [`"react"`]
  },
  blockCommentMentioningReactDomIsStripped: {
    input: `/* uses "react-dom" internally */ import x from "zustand";`,
    expectContains: [`import x from "zustand"`],
    expectNotContains: [`"react-dom"`]
  },
  trailingCommentNamingSpecifierDoesNotLeak: {
    input: `import z from "zustand"; // not "react" this time\n`,
    expectContains: [`import z from "zustand"`],
    expectNotContains: [`"react" this time`]
  },
  arrayLiteralWrappingRegexCallPreservesImport: {
    input: `const parts = [x.match(/^\\s*(\\w+):/gm)]; import a from "react";`,
    expectContains: [`import a from "react"`]
  },
  multilineTemplateLiteralPreservedAcrossNewlines: {
    input: 'const t = `line one\nline two`; import a from "react";',
    expectContains: [`import a from "react"`]
  },
  divisionAfterIdentifierNotMisreadAsRegex: {
    input: `const ratio = a / b; import x from "react";`,
    expectContains: [`import x from "react"`]
  },
  divisionAfterCloseParenNotMisreadAsRegex: {
    input: `const ratio = (a + b) / c; import x from "react";`,
    expectContains: [`import x from "react"`]
  },
  divisionAfterCloseBracketNotMisreadAsRegex: {
    input: `const ratio = arr[0] / c; import x from "react";`,
    expectContains: [`import x from "react"`]
  }
} as const satisfies Record<string, ScanFixture>;

// Throw-on-unterminated cases: no expectContains/expectNotContains, just the
// raw source that must make scanFile throw rather than silently swallow to
// EOF.
export const UNTERMINATED_FIXTURES = {
  unterminatedBlockComment: `/* forgot to close\nimport x from "react";`,
  divisionImmediatelyFollowedByStarOpensRealComment: `const n = a[0]/*b/\nimport x from "react";`
} as const satisfies Record<string, string>;

// Swallow-check fixtures: raw source fed straight to scanFileDetailed /
// findSwallowedSpecifiers by the test, not through assertScan.
export const SWALLOW_FIXTURES = {
  jsxEmbeddedHttpOnSameLineAsImport: `const el = <p>see http://x</p>; import y from "zustand";\n`,
  jsxEmbeddedHttpWithInlineSwallowOkMarker:
    `const el = <p>see http://x</p>; import y from "zustand"; // scanfile-swallow-ok: JSX text, not a real comment\n`
} as const satisfies Record<string, string>;

// The quoted substring the first fixture's swallow warning must mention --
// kept as data here too, for the same reason as everything else in this
// module: it is a real, quoted "zustand" as CODE (the argument to a
// template-literal `toContain(...)` call), which the hygiene walk would
// otherwise flag.
export const ZUSTAND_QUOTED_SUBSTRING = `"zustand"`;

// findAllSpecifierMatches fixtures: exercise the two patterns directly.
export const SPECIFIER_MATCH_FIXTURES = {
  templateLiteralSpecifierInRealImportCall: "await import(`zustand`);",
  bareBacktickMentionInProseIsNotASpecifier: "// see `zustand/middleware` for the docs\nconst x = 1;"
} as const satisfies Record<string, string>;
