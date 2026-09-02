// normalizeRemoteUrl lowercases the whole key, host and path, since two casings
// of the same GitHub path would otherwise compute two distinct project_key
// values with no error signal, silently splitting a shared
// roadmap/graph/approval scope.

import { test, expect } from "bun:test";
import { normalizeRemoteUrl, validateProjectKey, resolveProjectKey } from "../shared/project-key.ts";

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
  // normalizeRemoteUrl uses JS's Unicode-aware toLowerCase() throughout, never
  // SQLite's ASCII-only LOWER(), which would leave accented letters untouched
  // and produce a third, mismatched key.
  expect(normalizeRemoteUrl("https://github.com/VOCSAP/ÉTÉ.git")).toBe("github.com/vocsap/été");
  expect(normalizeRemoteUrl("https://github.com/VOCSAP/ÉTÉ.git")).not.toBe("github.com/vocsap/ÉtÉ");
});

test("empty or whitespace-only input still returns null", () => {
  expect(normalizeRemoteUrl("")).toBeNull();
  expect(normalizeRemoteUrl("   ")).toBeNull();
});

// Card c92614ed lot L0: validateProjectKey is a DENY-LIST (control/framing
// characters and a length cap), never an ASCII allow-list -- the non-ASCII
// acceptance test right below pins that this file's own producer contract
// (normalizeRemoteUrl above) and the deny-list agree, so a future edit that
// turns this into an accidental allow-list turns THIS test red, not just a
// downstream one. Control characters are built via String.fromCharCode
// rather than typed as \u escapes: a raw NUL/DEL/C1 typed directly into a
// test file risks landing as a literal control BYTE instead of a source-level
// escape sequence, which git then classifies the whole file as binary (this
// repo's own convention: "No literal control bytes in a source file").

test("rejects each C0 control character (NUL, tab, CR, LF)", () => {
  for (const code of [0x00, 0x09, 0x0d, 0x0a]) {
    const bad = "github.com/vocsap/foo" + String.fromCharCode(code) + "bar";
    expect(validateProjectKey(bad)).toEqual({ ok: false, reason: "control_char" });
  }
});

test("rejects DEL (U+007F)", () => {
  const bad = "github.com/vocsap/foo" + String.fromCharCode(0x7f) + "bar";
  expect(validateProjectKey(bad)).toEqual({ ok: false, reason: "control_char" });
});

test("rejects a C1 control character (U+0080-U+009F range)", () => {
  const bad = "github.com/vocsap/foo" + String.fromCharCode(0x85) + "bar";
  expect(validateProjectKey(bad)).toEqual({ ok: false, reason: "control_char" });
});

test("rejects leading whitespace", () => {
  expect(validateProjectKey(" github.com/vocsap/foo")).toEqual({
    ok: false,
    reason: "surrounding_whitespace",
  });
});

test("rejects trailing whitespace", () => {
  expect(validateProjectKey("github.com/vocsap/foo ")).toEqual({
    ok: false,
    reason: "surrounding_whitespace",
  });
});

test("rejects the empty string", () => {
  expect(validateProjectKey("")).toEqual({ ok: false, reason: "empty" });
});

test("rejects a value over 256 chars, accepts exactly 256 (boundary)", () => {
  expect(validateProjectKey("x".repeat(257))).toEqual({ ok: false, reason: "too_long" });
  expect(validateProjectKey("x".repeat(256))).toEqual({ ok: true });
});

// Card c92614ed lot L0, MAJOR 1 review round 2: resolveProjectKey's own
// over-length guard had no test that ships -- the boundary values above were
// only checked via a throwaway script, which proves nothing to anyone who
// cannot re-run it. Pinned here, next to validateProjectKey's own boundary
// test, using the SAME 256/257 split.
test("resolveProjectKey falls back to local:<hash> when the remote-derived key exceeds the 256 cap", () => {
  expect(resolveProjectKey("x".repeat(256), "/repo", "/repo")).toBe("x".repeat(256));
  // The only assertion that matters: compared against the fallback call
  // itself, not a hand-derived hash, so this never rots if the local:
  // formula changes.
  expect(resolveProjectKey("x".repeat(257), "/repo", "/repo")).toBe(resolveProjectKey(null, "/repo", "/repo"));
  expect(resolveProjectKey("github.com/vocsap/koryphaios", "/repo", "/repo")).toBe(
    "github.com/vocsap/koryphaios"
  );
});

test("accepts a legitimate non-ASCII value -- deny-list, not an ASCII allow-list", () => {
  expect(validateProjectKey("github.com/vocsap/été")).toEqual({ ok: true });
});

test("accepts a value with a backslash (Windows local-path remote)", () => {
  expect(validateProjectKey("c:\\repos\\foo")).toEqual({ ok: true });
});

test("accepts a value with internal whitespace (local-path remote fallback branch)", () => {
  expect(validateProjectKey("/srv/git/my project.git")).toEqual({ ok: true });
});

test("accepts a value with a colon (the local: prefix depends on it)", () => {
  expect(validateProjectKey("local:6c4c222bfb64bc07")).toEqual({ ok: true });
});

test("a non-ASCII value with an embedded NUL is rejected for the control character, not silently accepted", () => {
  const bad = "github.com/vocsap/été" + String.fromCharCode(0) + "repo";
  expect(validateProjectKey(bad)).toEqual({ ok: false, reason: "control_char" });
});
