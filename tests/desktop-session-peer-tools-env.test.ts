// SessionService can't be instantiated behaviorally (hardcoded PtyManager, not
// injected), so peerToolsEnvValue lives in a dependency-free module importable
// without pulling in session-service.ts's own heavy import graph.
// This file calls the real function with real inputs and asserts the real
// output, rather than grepping source for the env var name.

import { test, expect } from "bun:test";
import { peerToolsEnvValue } from "../desktop/src/main/session-env.ts";

test("peerToolsEnvValue: a profile carrying a list produces EXACTLY that list, comma-joined", () => {
  expect(peerToolsEnvValue(["list_peers", "send_message"])).toBe("list_peers,send_message");
  expect(peerToolsEnvValue(["whoami"])).toBe("whoami");
});

test("peerToolsEnvValue: undefined (no profile / a profile with no list) returns undefined -- the caller must then OMIT the key, never set it to ''", () => {
  expect(peerToolsEnvValue(undefined)).toBeUndefined();
});

test("peerToolsEnvValue: an explicitly empty list is DISTINCT from undefined -- '' (zero tools), not omitted", () => {
  // Server-side three-state contract (server.ts TOOLS_ENV_VAR): absent =
  // full surface, defined = this subset, defined-and-empty = zero tools.
  // A defined-but-empty peerTools array must therefore still produce a
  // (falsy but DEFINED) string, never collapse back to undefined.
  const value = peerToolsEnvValue([]);
  expect(value).toBe("");
  expect(value).not.toBeUndefined();
});
