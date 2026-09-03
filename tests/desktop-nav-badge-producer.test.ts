// Guards store.ts's single-producer rule for the Courrier attention badge: both
// nav bars must call inboxBadgeCount rather than re-summing its terms
// themselves.
// Scans source text rather than importing store.ts, which pulls in
// @shared/types, unresolvable outside desktop's own toolchain.
// Does not verify inboxBadgeCount's own arithmetic, only that both bars call
// it; the banned-term list is hand-picked from today's internal terms and goes
// stale silently if the function is rewritten.

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const NAV_RAIL = join(REPO_ROOT, "desktop", "src", "renderer", "src", "components", "NavRail.tsx");
const MOBILE_NAV = join(REPO_ROOT, "desktop", "src", "renderer", "src", "components", "MobileNav.tsx");

function stripComments(src: string): string {
  let out = "";
  let i = 0;
  let inString: string | null = null;
  while (i < src.length) {
    const c = src[i]!;
    if (inString) {
      out += c;
      if (c === "\\" && i + 1 < src.length) {
        out += src[i + 1];
        i += 2;
        continue;
      }
      if (c === inString) inString = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inString = c;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const REQUIRED_CALL_RE = /\buseDeck\(\s*inboxBadgeCount\s*\)/;
const REQUIRED_IMPORT_RE = /import\s*\{[^}]*\binboxBadgeCount\b[^}]*\}\s*from\s*['"]\.\.\/store['"]/;
const BANNED_TERMS = ["pendingApprovals.length", "graphDrafts.length", "inboxUnread", "inboxPendingCount("];

/** Pure audit: given file sources (name -> content), returns one violation string per problem found. */
function auditBadgeProducer(filesByName: Record<string, string>): string[] {
  const violations: string[] = [];
  for (const [name, rawSrc] of Object.entries(filesByName)) {
    const src = stripComments(rawSrc);
    if (!REQUIRED_IMPORT_RE.test(src)) {
      violations.push(`${name}: does not import inboxBadgeCount from '../store'`);
    }
    if (!REQUIRED_CALL_RE.test(src)) {
      violations.push(`${name}: does not call useDeck(inboxBadgeCount) -- badge may be locally re-summed`);
    }
    for (const term of BANNED_TERMS) {
      if (src.includes(term)) {
        violations.push(`${name}: contains banned re-summation term "${term}" -- badge terms belong only in store.ts's inboxBadgeCount`);
      }
    }
  }
  return violations;
}

// ----- real-repo check -----------------------------------------------------

test("NavRail and MobileNav both call the single badge producer, with no local re-summation", () => {
  const files = {
    "NavRail.tsx": readFileSync(NAV_RAIL, "utf-8"),
    "MobileNav.tsx": readFileSync(MOBILE_NAV, "utf-8"),
  };
  expect(auditBadgeProducer(files)).toEqual([]);
});

// ----- fixture-backed positive/negative controls ----------------------------

function fixtureBar(badgeLine: string, importLine = "import { inboxBadgeCount, useDeck } from '../store'"): string {
  return `${importLine}\nexport function Bar() {\n  ${badgeLine}\n  return null\n}\n`;
}

test("fixture positive control: a bar that imports and calls the producer, no banned terms, is clean", () => {
  const files = { "Bar.tsx": fixtureBar("const badge = useDeck(inboxBadgeCount)") };
  expect(auditBadgeProducer(files)).toEqual([]);
});

test("fixture: ONE bar regressing to a local re-summed selector is caught, naming that bar specifically (asymmetric, the real bug shape)", () => {
  const files = {
    "NavRail.tsx": fixtureBar("const badge = useDeck(inboxBadgeCount)"),
    "MobileNav.tsx": fixtureBar(
      "const badge = useDeck((s) => s.pendingApprovals.length + s.graphDrafts.length)",
      "import { useDeck } from '../store'"
    ),
  };
  const violations = auditBadgeProducer(files);
  expect(violations.some((v) => v.startsWith("MobileNav.tsx:"))).toBe(true);
  expect(violations.some((v) => v.startsWith("NavRail.tsx:"))).toBe(false);
});

test("fixture: the call removed but the import left behind is still caught (a partial regression)", () => {
  const files = {
    "Bar.tsx": fixtureBar("const badge = useDeck((s) => s.inboxMessages.length)"),
  };
  const violations = auditBadgeProducer(files);
  expect(violations).toContain("Bar.tsx: does not call useDeck(inboxBadgeCount) -- badge may be locally re-summed");
});

test("fixture: the import removed but a stray call left behind is still caught", () => {
  const files = {
    "Bar.tsx": fixtureBar("const badge = useDeck(inboxBadgeCount)", "import { useDeck } from '../store'"),
  };
  const violations = auditBadgeProducer(files);
  expect(violations).toContain("Bar.tsx: does not import inboxBadgeCount from '../store'");
});

test("fixture: a banned re-summation term present ANYWHERE in the file is caught, even alongside a correct call", () => {
  const files = {
    "Bar.tsx": fixtureBar(
      "const badge = useDeck(inboxBadgeCount)\n  const debug = pendingApprovals.length"
    ),
  };
  const violations = auditBadgeProducer(files);
  expect(violations.some((v) => v.includes('banned re-summation term "pendingApprovals.length"'))).toBe(true);
});

test("fixture: a banned term mentioned only in a comment is NOT flagged", () => {
  const files = {
    "Bar.tsx": fixtureBar("const badge = useDeck(inboxBadgeCount) // do not use pendingApprovals.length here"),
  };
  expect(auditBadgeProducer(files)).toEqual([]);
});
