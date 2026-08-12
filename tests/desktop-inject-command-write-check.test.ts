import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Card aaf4537d lot 3, correction (a): injectCommand (session-service.ts)
// used to discard pty.write()'s own boolean return for the command and '\r'
// writes and return 'written' unconditionally. pty.write's doc comment says
// exactly what that return means: "Returns false when no live PTY carries
// this id (write silently dropped)" (pty-manager.ts) -- a real failure
// signal that was computed and thrown away. The isAlive() check just above
// those two writes only proves the pty was alive AT THAT INSTANT, not
// during the writes themselves -- a pty that dies in between still reports
// 'written'. This is a source-scan (like desktop-session-broadcast.test.ts):
// SessionService isn't bun-test-importable (PtyManager -> node-pty, plus
// unresolved @shared/* aliases outside desktop's own tsconfig), so the guard
// reads the real file text instead of instantiating the class.

const SESSION_SERVICE_PATH = join(import.meta.dir, "..", "desktop", "src", "main", "session-service.ts");

function extractBracedBody(src: string, openIdx: number): string {
  let depth = 1;
  let i = openIdx + 1;
  while (depth > 0 && i < src.length) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") depth--;
    i++;
  }
  return src.slice(openIdx + 1, i - 1);
}

function extractInjectCommandBody(src: string): string {
  const fnMatch = /async injectCommand\([^)]*\)[^{]*\{/.exec(src);
  if (!fnMatch) throw new Error("injectCommand() not found in session-service.ts -- has it been renamed?");
  return extractBracedBody(src, fnMatch.index + fnMatch[0].length - 1);
}

// Both writes must be individually gated: `if (!this.pty.write(...)) return`.
// A bare `this.pty.write(id, command)` with no gating `if (!...)` immediately
// before it is exactly the pre-fix shape (return value computed and discarded).
function writeIsGated(body: string, writeCallRegex: RegExp): boolean {
  const gated = new RegExp(`if\\s*\\(\\s*!${writeCallRegex.source}\\s*\\)\\s*return`);
  return gated.test(body);
}

test("injectCommand consults pty.write()'s own return value for both the command and the \\r write, not just the isAlive pre-check", () => {
  const body = extractInjectCommandBody(readFileSync(SESSION_SERVICE_PATH, "utf-8"));
  const commandWriteGated = writeIsGated(body, /this\.pty\.write\(id,\s*command\)/);
  const crWriteGated = writeIsGated(body, /this\.pty\.write\(id,\s*'\\r'\)/);
  expect({ commandWriteGated, crWriteGated }).toEqual({ commandWriteGated: true, crWriteGated: true });
});

// ----- proof the guard is load-bearing, via synthetic fixtures (not the real
// file -- mutating session-service.ts itself in a test is fragile) -----

test("the guard flags the pre-fix shape: write()'s return discarded, 'written' returned unconditionally", () => {
  const body = `
    if (!this.pty.isAlive(id)) return 'no-terminal'
    this.pty.write(id, command)
    this.pty.write(id, '\\r')
    return 'written'
  `;
  expect(writeIsGated(body, /this\.pty\.write\(id,\s*command\)/)).toBe(false);
  expect(writeIsGated(body, /this\.pty\.write\(id,\s*'\\r'\)/)).toBe(false);
});

test("the guard does not flag the fixed shape: both writes gated by their own return value", () => {
  const body = `
    if (!this.pty.isAlive(id)) return 'no-terminal'
    if (!this.pty.write(id, command)) return 'no-terminal'
    if (!this.pty.write(id, '\\r')) return 'no-terminal'
    return 'written'
  `;
  expect(writeIsGated(body, /this\.pty\.write\(id,\s*command\)/)).toBe(true);
  expect(writeIsGated(body, /this\.pty\.write\(id,\s*'\\r'\)/)).toBe(true);
});

// ----- the case the team-lead named explicitly: isAlive-before is not a
// substitute for the write's own return, because the pty can die BETWEEN
// the pre-check and the write. A guard that only re-checks isAlive again
// (instead of write()'s return) would pass this fixture wrongly. -----

test("a variant that re-checks isAlive() again instead of write()'s return is NOT accepted as gated", () => {
  const body = `
    if (!this.pty.isAlive(id)) return 'no-terminal'
    this.pty.write(id, command)
    if (!this.pty.isAlive(id)) return 'no-terminal'
    this.pty.write(id, '\\r')
    return 'written'
  `;
  // Neither write call is followed by a check of ITS OWN return -- both
  // guards below re-test isAlive(), which cannot observe a write that was
  // itself silently dropped on an otherwise-still-alive pty.
  expect(writeIsGated(body, /this\.pty\.write\(id,\s*command\)/)).toBe(false);
  expect(writeIsGated(body, /this\.pty\.write\(id,\s*'\\r'\)/)).toBe(false);
});
