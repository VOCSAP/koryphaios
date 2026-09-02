// Card 3c085f1a: CLAUDE_PEERS_TOOLS wiring, session-service.ts side.
//
// SessionService hardcodes its own `PtyManager` (not dependency-injected),
// so a genuinely behavioral test cannot instantiate the class and spawn a
// real session -- the same limit tests/desktop-session-role-env.test.ts
// documents for CLAUDE_PEERS_ROLE, which is why that file resorts to a
// structural source scan instead. peerToolsEnvValue lives in the new
// dependency-free desktop/src/main/session-env.ts (no electron/node-pty
// imports, same convention as session-command.ts/shell-command.ts/
// peer-state.ts) specifically so it CAN be imported directly here without
// pulling in session-service.ts's own heavy import graph (measured: a
// direct import of session-service.ts fails to even resolve under `bun
// test`, "Cannot find module '@shared/palette'") -- so THIS file calls the
// real function with real inputs and asserts the real output. A probe that
// only grepped the source for the string "CLAUDE_PEERS_TOOLS" would keep
// nothing: this one actually runs the code. session-service.ts's own
// wiring (that this value reaches the real sessionEnv object, present vs
// omitted) is proven by construction, not independently re-tested here --
// see that file's own `if (peerToolsValue !== undefined) Object.assign(...)`
// comment for why it could not be extracted alongside without breaking the
// sibling role-env test's structural scan.
//
// Lives in tests/ (not desktop/src/main/) so it can use bun:test directly --
// desktop/tsconfig.node.json's ambient types don't include bun-types (same
// reasoning as tests/desktop-session-role-env.test.ts). Named desktop-* so
// scripts/pure-module-partition.ts's deny-list runs it by default.

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
