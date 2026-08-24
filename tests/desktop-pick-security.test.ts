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

// Fixed example per pattern, NOT a loop over PICK_SECRET_PATTERNS itself:
// iterating the list under test means removing an entry removes its own
// check and the suite stays green (measured: dropping "auth_token" or
// the credential-field pattern from the array left the old version of this
// test 101/101 pass). Every entry needs its own hard assertion here so
// deleting any one of them (other than "client_secret", subsumed by the
// generic "secret" pattern -- an accepted equivalent mutant) turns exactly
// this test red.
test("containsSecret detects a concrete example of every PICK_SECRET_PATTERNS entry", () => {
  expect(containsSecret("access_token=abc123")).toBe(true);
  expect(containsSecret("x-auth_token-y")).toBe(true);
  expect(containsSecret("api_key=xyz")).toBe(true);
  expect(containsSecret("apikey=xyz")).toBe(true);
  expect(containsSecret("client_secret=xyz")).toBe(true); // subsumed by "secret", kept for documentation
  expect(containsSecret("oauth_state=1")).toBe(true);
  expect(containsSecret("X-Amz-Signature")).toBe(true);
  expect(containsSecret("session_id=abc")).toBe(true);
  expect(containsSecret("sessionid=abc")).toBe(true);
  expect(containsSecret("CSRF_TOKEN")).toBe(true);
  expect(containsSecret("top-secret-value")).toBe(true);
  expect(containsSecret("user_password")).toBe(true);
  expect(containsSecret("old-passwd-field")).toBe(true);
  // Coverage guard: this list must name every pattern currently in
  // PICK_SECRET_PATTERNS (minus the documented "client_secret" equivalent
  // mutant), so growing the array without growing this test fails loudly
  // instead of silently under-covering the next added pattern. Built as
  // tuples rather than an object literal keyed by pattern name so a
  // credential-shaped `password: "..."` property never appears verbatim.
  const coveredPatterns = [
    "access_token",
    "auth_token",
    "api_key",
    "apikey",
    "client_secret",
    "oauth_state",
    "x-amz-",
    "session_id",
    "sessionid",
    "csrf",
    "secret",
    "password",
    "passwd",
  ];
  for (const pattern of PICK_SECRET_PATTERNS) {
    expect(coveredPatterns).toContain(pattern);
  }
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
