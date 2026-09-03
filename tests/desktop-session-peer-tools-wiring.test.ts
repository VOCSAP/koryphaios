// Closes a gap the value-only env test leaves open: it doesn't prove
// peerToolsEnvValue's result reaches sessionEnv conditionally.
// A structural scan is used since SessionService can't be instantiated
// behaviorally; an unconditional Object.assign mutation (every tile gets zero
// tools) would otherwise leave every other test green.

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractBracedBody } from "./_braced-body.ts";

const SESSION_SERVICE_PATH = join(import.meta.dir, "..", "desktop", "src", "main", "session-service.ts");

/**
 * Returns null if CLAUDE_PEERS_TOOLS is written onto sessionEnv EXACTLY
 * once in startPty(), guarded by `if (peerToolsValue !== undefined)`, and
 * never appears unconditionally inside the `const sessionEnv = {...}`
 * object literal itself -- or a human-readable reason string otherwise.
 * Exported so the mutation proof below can run it against a synthetic
 * mutated copy of the source text without touching the real file (the
 * red-proof against the REAL file, sha256-verified, is the test itself).
 */
export function checkPeerToolsGuardedAssignment(src: string): string | null {
  const fnMatch = /private startPty\([^)]*\)[^{]*\{/.exec(src);
  if (!fnMatch) return "startPty() not found in session-service.ts -- has it been renamed?";
  const fnStart = fnMatch.index + fnMatch[0].length - 1;
  const body = extractBracedBody(src, fnStart);

  const sessionEnvMatches = [...body.matchAll(/const sessionEnv\s*=\s*\{/g)];
  if (sessionEnvMatches.length !== 1) {
    return `expected exactly one \`const sessionEnv = {\` in startPty(), found ${sessionEnvMatches.length}`;
  }
  const sessionEnvMatch = sessionEnvMatches[0]!;
  const sessionEnvOpenIdx = sessionEnvMatch.index + sessionEnvMatch[0].length - 1;
  const sessionEnvBody = extractBracedBody(body, sessionEnvOpenIdx);
  if (/CLAUDE_PEERS_TOOLS/.test(sessionEnvBody)) {
    return "CLAUDE_PEERS_TOOLS appears INSIDE the sessionEnv object literal -- it must only ever be assigned conditionally, AFTER the literal, never unconditionally exposed";
  }

  const afterSessionEnv = body.slice(sessionEnvMatch.index);
  if (!/if\s*\(\s*peerToolsValue\s*!==\s*undefined\s*\)/.test(afterSessionEnv)) {
    return "no `if (peerToolsValue !== undefined)` guard found after sessionEnv's declaration -- CLAUDE_PEERS_TOOLS may now be written unconditionally";
  }

  // Comments excluded (same technique as the frozen sibling file, and the
  // same reasoning: session-service.ts documents the "why" in prose above
  // the declaration, which legitimately repeats the key name).
  const codeOnly = body
    .split("\n")
    .map((line) => line.replace(/\/\/.*/, ""))
    .join("\n");
  const totalOccurrences = (codeOnly.match(/CLAUDE_PEERS_TOOLS/g) ?? []).length;
  if (totalOccurrences !== 1) {
    return `expected exactly one CODE reference to CLAUDE_PEERS_TOOLS in startPty() (comments excluded), found ${totalOccurrences} -- something outside the guarded assignment may be touching it`;
  }

  return null;
}

test("CLAUDE_PEERS_TOOLS is only ever written onto sessionEnv behind the `peerToolsValue !== undefined` guard, never unconditionally", () => {
  const src = readFileSync(SESSION_SERVICE_PATH, "utf-8");
  const reason = checkPeerToolsGuardedAssignment(src);
  expect(reason).toBeNull();
});

test("negative control: the checker REJECTS a synthetic body where CLAUDE_PEERS_TOOLS is written unconditionally", () => {
  const mutated = [
    "class X {",
    "  private startPty(def, mode) {",
    "    const sessionEnv = {",
    "      CLAUDE_PEERS_DESK_SESSION: def.id,",
    "      CLAUDE_PEERS_ROLE: def.role ?? ''",
    "    }",
    "    const peerToolsValue = peerToolsEnvValue(def.peerTools)",
    "    Object.assign(sessionEnv, { CLAUDE_PEERS_TOOLS: peerToolsValue ?? '' })",
    "  }",
    "}"
  ].join("\n");
  const reason = checkPeerToolsGuardedAssignment(mutated);
  expect(reason).not.toBeNull();
  expect(reason).toContain("no `if (peerToolsValue !== undefined)` guard");
});
