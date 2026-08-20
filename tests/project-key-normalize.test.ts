// Card 69e5a3e0: normalizeRemoteUrl used to lowercase the host but leave the
// owner/repo path in its original casing. GitHub (and most hosts) accept
// cloning a repo under several casings of its path, so two clones of the
// same logical repo computed two distinct project_key values with no error
// signal -- silently splitting a shared roadmap/graph/approval scope in two.
// This file pins the fix (whole key lowercased, host AND path) directly
// against this repo's real remote casing, so a regression that re-introduces
// a case-sensitive branch shows up here rather than only downstream.
//
// This repo's actual checkout remote is "VOCSAP" (capital), confirmed via
// `bun cli.ts status` against the shared broker (2026-08-20): the real
// project_key is "github.com/VOCSAP/koryphaios" pre-fix,
// "github.com/vocsap/koryphaios" post-fix. Any lowercase literal elsewhere
// in the test suite predating this card (e.g. tests/broker-approvals.test.ts's
// DEFAULT_PROJECT_KEY) is a synthetic fixture that was never derived from
// normalizeRemoteUrl and stays unaffected by this change either way.

import { test, expect } from "bun:test";
import { normalizeRemoteUrl } from "../shared/project-key.ts";

test("https URL: path casing is lowercased alongside the host", () => {
  expect(normalizeRemoteUrl("https://github.com/VOCSAP/koryphaios.git")).toBe(
    "github.com/vocsap/koryphaios"
  );
  expect(normalizeRemoteUrl("https://github.com/vocsap/koryphaios.git")).toBe(
    "github.com/vocsap/koryphaios"
  );
});

test("https URL: host casing is lowercased alongside the path", () => {
  expect(normalizeRemoteUrl("https://GitHub.com/VOCSAP/Koryphaios.git")).toBe(
    "github.com/vocsap/koryphaios"
  );
});

test("https URL without .git suffix normalizes identically to the .git form", () => {
  expect(normalizeRemoteUrl("https://github.com/VOCSAP/koryphaios")).toBe(
    normalizeRemoteUrl("https://github.com/VOCSAP/koryphaios.git")
  );
  expect(normalizeRemoteUrl("https://github.com/VOCSAP/koryphaios")).toBe(
    "github.com/vocsap/koryphaios"
  );
});

test("SCP-like SSH form (git@host:owner/repo) lowercases identically to the HTTPS form", () => {
  const scp = normalizeRemoteUrl("git@github.com:VOCSAP/koryphaios.git");
  const https = normalizeRemoteUrl("https://github.com/VOCSAP/koryphaios.git");
  expect(scp).toBe(https);
  expect(scp).toBe("github.com/vocsap/koryphaios");
});

test("ssh:// protocol form with explicit port lowercases the owner/repo path", () => {
  expect(normalizeRemoteUrl("ssh://git@gitlab.com:2222/GROUP/Proj.git")).toBe(
    "gitlab.com/group/proj"
  );
});

test("this repo's real checkout remote (mixed-case owner) matches the fixed derivation", () => {
  // Card 69e5a3e0's measured contradiction with the pre-fix behaviour: before
  // this card, this exact input derived to "github.com/VOCSAP/koryphaios"
  // (capital VOCSAP) -- a different, colliding key from the lowercase form.
  expect(normalizeRemoteUrl("https://github.com/VOCSAP/koryphaios.git")).toBe(
    "github.com/vocsap/koryphaios"
  );
  expect(normalizeRemoteUrl("https://github.com/VOCSAP/koryphaios.git")).not.toBe(
    "github.com/VOCSAP/koryphaios"
  );
});

test("bare host/path with no scheme and no scp-colon form lowercases via the fallback branch", () => {
  expect(normalizeRemoteUrl("GitHub.com/VOCSAP/Koryphaios")).toBe("github.com/vocsap/koryphaios");
});

test("host-only remote (no path segment) still lowercases", () => {
  expect(normalizeRemoteUrl("git://Host/Only")).toBe("host/only");
});

test("non-ASCII owner/repo path lowercases via Unicode-aware JS toLowerCase(), never SQLite's ASCII-only LOWER()", () => {
  // Mutation-review finding on scripts/migrate-project-key-case.ts
  // (2026-08-20): SQLite's LOWER() is ASCII-only and would leave accented
  // letters untouched ("ÉTÉ" -> "ÉtÉ"), producing a THIRD key this function
  // itself would never produce. normalizeRemoteUrl uses plain JS
  // .toLowerCase() throughout (shared/project-key.ts), which is
  // Unicode-aware -- pin that here so the two stay provably in agreement,
  // since the migration script's tests assert equality against THIS
  // function's output, not a re-derivation.
  expect(normalizeRemoteUrl("https://github.com/VOCSAP/ÉTÉ.git")).toBe("github.com/vocsap/été");
  expect(normalizeRemoteUrl("https://github.com/VOCSAP/ÉTÉ.git")).not.toBe("github.com/vocsap/ÉtÉ");
});

test("empty or whitespace-only input still returns null", () => {
  expect(normalizeRemoteUrl("")).toBeNull();
  expect(normalizeRemoteUrl("   ")).toBeNull();
});
