import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Two guards on SessionService.injectCommand (session-service.ts), from two
// different cards, on the same few lines of code:
//
//  (1) aaf4537d lot 3: injectCommand must consult pty.write()'s own boolean
//      return, not just the isAlive() pre-check. pty.write's doc says exactly
//      what that return means: "Returns false when no live PTY carries this id
//      (write silently dropped)" (pty-manager.ts) -- a real failure signal that
//      used to be computed and thrown away. isAlive() only proves the pty was
//      alive AT THAT INSTANT, not during the write itself.
//
//  (2) 6168b7f4: the text and its submit keystroke must go out in ONE write,
//      bracketed-paste encoded (encodeSubmittedKeystrokes), NOT as "write the
//      text, then write a bare '\r'". Measured 2026-08-13: ConPTY coalesces
//      two back-to-back writes into one read, and Claude Code's tokenizer only
//      promotes a control byte to its own token (hence to a `return` key) when
//      the whole read is under 64 characters -- so the old two-write shape
//      silently failed to SUBMIT anything past that size. A separate probe
//      (desktop-pty-coalescing.test.ts) measures the coalescing itself; this
//      file guards the shape of the code that depends on it.
//
// This is a source-scan (like desktop-session-broadcast.test.ts): SessionService
// isn't bun-test-importable (PtyManager -> node-pty, plus unresolved @shared/*
// aliases outside desktop's own tsconfig), so the guard reads the real file text
// instead of instantiating the class.

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

// A write must be individually gated: `if (!this.pty.write(...)) return`.
// A bare `this.pty.write(...)` with no gating `if (!...)` immediately before it
// is exactly the pre-fix shape (return value computed and discarded).
function writeIsGated(body: string, writeCallRegex: RegExp): boolean {
  const gated = new RegExp(`if\\s*\\(\\s*!${writeCallRegex.source}\\s*\\)\\s*return`);
  return gated.test(body);
}

/** The submitting write: one call, carrying the encoded command. */
const ENCODED_WRITE = /this\.pty\.write\(id,\s*encodeSubmittedKeystrokes\(command\)\)/;
/** The defective shape this card removed: a bare CR as its own write. */
const BARE_CR_WRITE = /this\.pty\.write\(\s*id\s*,\s*'\\r'\s*\)/;

test("injectCommand consults pty.write()'s own return value for the submitting write, not just the isAlive pre-check", () => {
  const body = extractInjectCommandBody(readFileSync(SESSION_SERVICE_PATH, "utf-8"));
  expect(writeIsGated(body, ENCODED_WRITE)).toBe(true);
});

test("injectCommand submits in ONE bracketed-paste write and never writes a bare '\\r' of its own (card 6168b7f4)", () => {
  const body = extractInjectCommandBody(readFileSync(SESSION_SERVICE_PATH, "utf-8"));
  const encodedWrites = body.match(new RegExp(ENCODED_WRITE.source, "g")) ?? [];
  expect({
    encodedWrites: encodedWrites.length,
    bareCrWrite: BARE_CR_WRITE.test(body),
  }).toEqual({ encodedWrites: 1, bareCrWrite: false });
});

// The Escape that dismisses an open menu is a DIFFERENT write and must stay:
// it is the one control byte injectCommand still sends on its own, and exactly
// one of it (a second Escape can quit the session in at least one UI state --
// "esc to close - esc again quits" is in the CLI binary).
test("injectCommand still sends exactly one bare Escape before the command", () => {
  const body = extractInjectCommandBody(readFileSync(SESSION_SERVICE_PATH, "utf-8"));
  const escWrites = body.match(/this\.pty\.write\(id,\s*'\\x1b'\)/g) ?? [];
  expect(escWrites.length).toBe(1);
});

// ----- proof the guards are load-bearing, via synthetic fixtures (not the real
// file -- mutating session-service.ts itself in a test is fragile) -----

test("the guard flags the ORIGINAL pre-fix shape: write()'s return discarded, 'written' returned unconditionally", () => {
  const body = `
    if (!this.pty.isAlive(id)) return 'no-terminal'
    this.pty.write(id, command)
    this.pty.write(id, '\\r')
    return 'written'
  `;
  expect(writeIsGated(body, ENCODED_WRITE)).toBe(false);
  expect(BARE_CR_WRITE.test(body)).toBe(true);
});

test("the guard flags the INTERMEDIATE shape: both writes gated, but still a separate bare '\\r' (the 6168b7f4 defect)", () => {
  const body = `
    if (!this.pty.isAlive(id)) return 'no-terminal'
    if (!this.pty.write(id, command)) return 'no-terminal'
    if (!this.pty.write(id, '\\r')) return 'no-terminal'
    return 'written'
  `;
  // gated (aaf4537d satisfied) yet still defective for 6168b7f4: the CR is a
  // write of its own, which ConPTY coalesces back into the text's read.
  expect(writeIsGated(body, /this\.pty\.write\(id,\s*command\)/)).toBe(true);
  expect(writeIsGated(body, ENCODED_WRITE)).toBe(false);
  expect(BARE_CR_WRITE.test(body)).toBe(true);
});

test("the guard flags a delay-based 'fix': the CR is still its own write, it is just later", () => {
  const body = `
    if (!this.pty.write(id, command)) return 'no-terminal'
    await new Promise((res) => setTimeout(res, 120))
    if (!this.pty.write(id, '\\r')) return 'no-terminal'
    return 'written'
  `;
  expect(BARE_CR_WRITE.test(body)).toBe(true);
});

test("the guard accepts the fixed shape: one gated, bracketed-paste-encoded write, no bare CR", () => {
  const body = `
    if (!this.pty.isAlive(id)) return 'no-terminal'
    this.pty.write(id, '\\x1b')
    if (!this.pty.write(id, encodeSubmittedKeystrokes(command))) return 'no-terminal'
    return 'written'
  `;
  expect(writeIsGated(body, ENCODED_WRITE)).toBe(true);
  expect(BARE_CR_WRITE.test(body)).toBe(false);
});

// ----- the case the team-lead named explicitly on aaf4537d: isAlive-before is
// not a substitute for the write's own return, because the pty can die BETWEEN
// the pre-check and the write. -----

test("a variant that re-checks isAlive() again instead of write()'s return is NOT accepted as gated", () => {
  const body = `
    if (!this.pty.isAlive(id)) return 'no-terminal'
    this.pty.write(id, encodeSubmittedKeystrokes(command))
    if (!this.pty.isAlive(id)) return 'no-terminal'
    return 'written'
  `;
  expect(writeIsGated(body, ENCODED_WRITE)).toBe(false);
});
