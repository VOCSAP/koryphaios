// Chantier OD2 (DESIGN-ORCA-DOOP-ADOPTION.md §3.4): pure unit coverage for
// shared/pick-security.ts -- the redaction and URL-sanitization primitives
// shared by element-pick.ts (guest) and design-endpoint.ts (main). No DOM
// needed: this module is import-free besides its own constants.

import { expect, test } from "bun:test";
import {
  containsSecret,
  PICK_ATTRIBUTE_ALLOWLIST,
  PICK_BUDGET,
  PICK_SECRET_PATTERNS,
  sanitizePickUrl,
} from "../desktop/src/shared/pick-security.ts";

test("containsSecret hits: known secret substrings, case-insensitive", () => {
  expect(containsSecret("access_token=abc123")).toBe(true);
  expect(containsSecret("X-Amz-Signature")).toBe(true);
  expect(containsSecret("my-api-key-value")).toBe(false); // "api-key" has a hyphen, pattern is "api_key"
  expect(containsSecret("apikey=xyz")).toBe(true);
  expect(containsSecret("CSRF_TOKEN")).toBe(true);
  expect(containsSecret("user_password")).toBe(true);
  expect(containsSecret("OAuth_State=1")).toBe(true);
  expect(containsSecret("SESSIONID")).toBe(true);
});

test("containsSecret misses: ordinary strings and near-miss substrings", () => {
  expect(containsSecret("add-to-cart")).toBe(false);
  expect(containsSecret("checkout-form")).toBe(false);
  expect(containsSecret("stateful-widget")).toBe(false);
  expect(containsSecret("")).toBe(false);
  expect(containsSecret("Product Name")).toBe(false);
});

// One table drives every check: each row is asserted against containsSecret and
// against which pattern actually matches it, plus a set-equality check against
// PICK_SECRET_PATTERNS so the table can neither omit a live pattern nor keep a
// dead one.
const SECRET_EXAMPLES: [pattern: string, example: string][] = [
  ["access_token", "access_token=abc123"],
  ["auth_token", "x-auth_token-y"],
  ["api_key", "api_key=xyz"],
  ["apikey", "apikey=xyz"],
  ["client_secret", "client_secret=xyz"],
  ["oauth_state", "oauth_state=1"],
  ["x-amz-", "X-Amz-Signature"],
  ["session_id", "session_id=abc"],
  ["sessionid", "sessionid=abc"],
  ["csrf", "CSRF_TOKEN"],
  ["secret", "top-secret-value"],
  ["password", "user_password"],
  ["passwd", "old-passwd-field"],
];

// "client_secret" is the one pattern whose own example also matches another
// pattern ("client_secret=xyz" contains the substring "secret") -- a
// documented, intentional overlap (client_secret is subsumed by the generic
// "secret" pattern), not a leak in this table. Every other example must
// match ONLY its own pattern, verified explicitly below rather than by
// comment alone.
const KNOWN_PATTERN_OVERLAPS: Record<string, string[]> = { client_secret: ["secret"] };

test("containsSecret detects a concrete, uniquely-matching example of every PICK_SECRET_PATTERNS entry", () => {
  for (const [pattern, example] of SECRET_EXAMPLES) {
    expect(containsSecret(example)).toBe(true);
    const lower = example.toLowerCase();
    const matchedPatterns = PICK_SECRET_PATTERNS.filter((p) => lower.includes(p)).sort();
    const expectedMatches = [pattern, ...(KNOWN_PATTERN_OVERLAPS[pattern] ?? [])].sort();
    expect(matchedPatterns).toEqual(expectedMatches);
  }
  // Two-way: every pattern currently in PICK_SECRET_PATTERNS has exactly one
  // row above, and the table names nothing that isn't currently a pattern.
  expect(SECRET_EXAMPLES.map(([pattern]) => pattern).sort()).toEqual(
    [...PICK_SECRET_PATTERNS].sort()
  );
});

test("sanitizePickUrl: strips query and hash from an allowed protocol", () => {
  expect(sanitizePickUrl("https://example.com/path?token=abc#frag")).toBe("https://example.com/path");
  expect(sanitizePickUrl("http://localhost:3000/app?x=1")).toBe("http://localhost:3000/app");
  expect(sanitizePickUrl("file:///Users/me/index.html?x=1#y")).toBe("file:///Users/me/index.html");
});

test("sanitizePickUrl: disallowed protocols become ''", () => {
  expect(sanitizePickUrl("javascript:alert(1)")).toBe("");
  expect(sanitizePickUrl("data:text/html,<script>alert(1)</script>")).toBe("");
  expect(sanitizePickUrl("chrome://settings")).toBe("");
  expect(sanitizePickUrl("ftp://example.com/file")).toBe("");
});

test("sanitizePickUrl: literal about:blank is kept as-is", () => {
  expect(sanitizePickUrl("about:blank")).toBe("about:blank");
});

test("sanitizePickUrl: parse failure returns ''", () => {
  expect(sanitizePickUrl("not a url at all")).toBe("");
  expect(sanitizePickUrl("")).toBe("");
  // Relative URLs have no base to resolve against -- new URL() throws, so
  // these also fall into the parse-failure branch (matches the reference
  // implementation this module adapts from).
  expect(sanitizePickUrl("/relative/path?x=1")).toBe("");
});

test("PICK_BUDGET carries the pre-existing caps (single source of truth)", () => {
  expect(PICK_BUDGET.textMaxLength).toBe(160);
  expect(PICK_BUDGET.selectorValueMaxLength).toBe(512);
  expect(PICK_BUDGET.classesMaxEntries).toBe(8);
  expect(PICK_BUDGET.selectorsMaxEntries).toBe(8);
});

test("PICK_ATTRIBUTE_ALLOWLIST is non-empty and does not include an arbitrary event-handler-like name", () => {
  expect(PICK_ATTRIBUTE_ALLOWLIST.length).toBeGreaterThan(0);
  expect(PICK_ATTRIBUTE_ALLOWLIST).not.toContain("onclick");
  expect(PICK_ATTRIBUTE_ALLOWLIST).toContain("href");
  expect(PICK_ATTRIBUTE_ALLOWLIST).toContain("role");
});
