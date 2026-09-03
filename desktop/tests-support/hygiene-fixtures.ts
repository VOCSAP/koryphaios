// Fixture data lives here, physically outside the directory the hygiene walk
// scans, because every fixture below deliberately contains a real, quoted
// react/react-dom/zustand specifier as code -- exactly the shape the discipline
// test exists to catch.
// Keeping that data inside the scanned directory would force the discipline
// test to exempt itself from its own check just to pass its own unit tests.
// This module holds data only, no test() calls, and is not itself collected by
// any test glob.

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
