import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractBracedBody, extractParenBody, findMatchingClose } from "./_braced-body";

// Keys on the sessionEnv object being constructed exactly once, outside the
// resume branch, rather than enumerating spawn modes by name.
// A third spawn path (deck-control.ts's supervisor spawn) exists and bypasses
// session-service.ts's startPty entirely, so this guard does not reach it.

const SESSION_SERVICE_PATH = join(import.meta.dir, "..", "desktop", "src", "main", "session-service.ts");

/**
 * Structural check, independent of any hand-maintained mode list: reads the
 * REAL startPty() body and verifies CLAUDE_PEERS_ROLE reaches every path
 * through it by construction, not by enumeration. Returns null if the
 * invariant holds, or a human-readable reason string if it does not --
 * exported as a plain function (not inlined in the test) so the mutation
 * proof below can run it against a deliberately broken copy of the source
 * text without touching the real file.
 */
export function checkRoleReachesEverySpawnPath(src: string): string | null {
  const fnMatch = /private startPty\([^)]*\)[^{]*\{/.exec(src);
  if (!fnMatch) return "startPty() not found in session-service.ts -- has it been renamed?";
  const fnStart = fnMatch.index + fnMatch[0].length - 1;
  const body = extractBracedBody(src, fnStart);

  // Locate the mode-branch statement: `if (effective === 'resume') { ... }`
  // (an `else { ... }` normally follows, but its presence/absence does not
  // matter here -- what matters is where the branch statement itself ENDS).
  const ifMatch = /if\s*\(\s*effective\s*===\s*'resume'\s*\)\s*\{/.exec(body);
  if (!ifMatch) {
    return "startPty()'s `if (effective === 'resume')` branch not found -- has the mode-branch shape changed?";
  }
  const ifOpenIdx = ifMatch.index + ifMatch[0].length - 1;
  let branchEndIdx = findMatchingClose(body, ifOpenIdx, "{", "}");
  // Absorb a trailing `else { ... }` into the same "branch region" if present.
  const afterIf = body.slice(branchEndIdx);
  const elseMatch = /^\s*else\s*\{/.exec(afterIf);
  if (elseMatch) {
    const elseOpenIdx = branchEndIdx + elseMatch[0].length - 1;
    branchEndIdx = findMatchingClose(body, elseOpenIdx, "{", "}");
  }

  const sessionEnvMatches = [...body.matchAll(/const sessionEnv\s*=\s*\{/g)];
  if (sessionEnvMatches.length !== 1) {
    return `expected exactly one \`const sessionEnv = {\` in startPty(), found ${sessionEnvMatches.length}`;
  }
  const sessionEnvMatch = sessionEnvMatches[0]!;
  if (sessionEnvMatch.index < branchEndIdx) {
    return "sessionEnv is constructed INSIDE the fresh/resume branch, not after it -- CLAUDE_PEERS_ROLE (or any other key) could then silently differ per mode instead of being reached unconditionally";
  }

  const sessionEnvOpenIdx = sessionEnvMatch.index + sessionEnvMatch[0].length - 1;
  const sessionEnvBody = extractBracedBody(body, sessionEnvOpenIdx);
  if (!/CLAUDE_PEERS_ROLE\s*:/.test(sessionEnvBody)) {
    return "sessionEnv object literal no longer carries a CLAUDE_PEERS_ROLE key";
  }

  // Nobody re-touches CLAUDE_PEERS_ROLE anywhere else in startPty (e.g. a
  // conditional override or deletion added to one branch only). Line
  // comments are stripped first -- session-service.ts documents the "why"
  // above sessionEnv's declaration in prose that legitimately repeats the
  // key name; only CODE references are load-bearing here.
  // No `$` anchor: session-service.ts is CRLF on disk, so a per-line split
  // on "\n" leaves a trailing "\r" that a `$`-anchored regex (which only
  // matches at the true end of input, and `.` never matches the \r line
  // terminator) silently fails to match against, no-op'ing the strip.
  const codeOnly = body
    .split("\n")
    .map((line) => line.replace(/\/\/.*/, ""))
    .join("\n");
  const totalOccurrences = (codeOnly.match(/CLAUDE_PEERS_ROLE/g) ?? []).length;
  if (totalOccurrences !== 1) {
    return `expected exactly one CODE reference to CLAUDE_PEERS_ROLE in startPty() (comments excluded), found ${totalOccurrences} -- something outside sessionEnv's declaration may be touching it conditionally`;
  }

  // The identifier actually reaching this.pty.spawn(...) must be THIS
  // sessionEnv, not a re-derived stand-in built separately.
  const afterSessionEnv = body.slice(sessionEnvMatch.index);
  const spawnMatch = /this\.pty\.spawn\(/.exec(afterSessionEnv);
  if (!spawnMatch) {
    return "no this.pty.spawn(...) call found after sessionEnv's declaration";
  }
  const spawnOpenIdx = spawnMatch.index + spawnMatch[0].length - 1;
  const spawnArgs = extractParenBody(afterSessionEnv, spawnOpenIdx);
  if (!/\bsessionEnv\b/.test(spawnArgs)) {
    return "this.pty.spawn(...) does not pass the sessionEnv identifier -- something else may be constructed and sent instead";
  }

  return null;
}

test("CLAUDE_PEERS_ROLE reaches session-service.ts's ONE spawn point (startPty) regardless of fresh/resume mode", () => {
  const src = readFileSync(SESSION_SERVICE_PATH, "utf-8");
  const reason = checkRoleReachesEverySpawnPath(src);
  expect(reason).toBeNull();
});
