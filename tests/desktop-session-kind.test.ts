// Card fd1914cc: isClaudeLaunch gates the Deck's own quota auto-resume off
// for Claude Code sessions (which own their resume since CC 2.1.235+).

import { test, expect } from "bun:test";

import { isClaudeLaunch } from "../desktop/src/main/session-kind.ts";

test("empty command => true (resolves to the CONFIGURED launch command, which starts with claude absent an override)", () => {
  expect(isClaudeLaunch("")).toBe(true);
  expect(isClaudeLaunch("   ")).toBe(true);
});

test("the real default launch command is detected", () => {
  expect(
    isClaudeLaunch("claude --dangerously-load-development-channels server:claude-peers")
  ).toBe(true);
});

test("bare 'claude' with args", () => {
  expect(isClaudeLaunch("claude --model opus")).toBe(true);
});

test("absolute path to the claude binary (unix)", () => {
  expect(isClaudeLaunch("/usr/local/bin/claude --model opus")).toBe(true);
});

test("absolute path with a .cmd wrapper (Windows)", () => {
  expect(
    isClaudeLaunch("C:\\Users\\op\\AppData\\Roaming\\npm\\claude.cmd --model opus")
  ).toBe(true);
});

test("quoted absolute path with spaces, .cmd wrapper", () => {
  expect(isClaudeLaunch('"C:\\Program Files\\claude.cmd" --model opus')).toBe(true);
});

test("case-insensitive basename match", () => {
  expect(isClaudeLaunch("Claude.EXE --model opus")).toBe(true);
});

// EXECUTABLE_EXTENSIONS lists four entries (.cmd, .exe, .bat, .ps1); the
// tests above only exercise .cmd and .exe. Same loop body handles all four,
// but a list where half the entries have no witness is exactly the kind of
// coverage that shrinks silently if the loop is ever refactored per-branch
// (koryphaios card fd1914cc audit).
test("absolute path with a .bat wrapper (Windows)", () => {
  expect(isClaudeLaunch("C:\\Users\\op\\AppData\\Roaming\\npm\\claude.bat --model opus")).toBe(
    true
  );
});

test("absolute path with a .ps1 wrapper (Windows)", () => {
  expect(isClaudeLaunch("C:\\Users\\op\\AppData\\Roaming\\npm\\claude.ps1 --model opus")).toBe(
    true
  );
});

test("an unrelated known CLI is not detected as claude", () => {
  expect(isClaudeLaunch("codex --flag")).toBe(false);
});

test("an unknown wrapper script is not detected as claude (documented gap, stays false)", () => {
  expect(isClaudeLaunch("./run-agent.sh --whatever")).toBe(false);
  expect(isClaudeLaunch("npx some-other-cli")).toBe(false);
});

// ----- Widening (team-lead review, card fd1914cc): the predicate matches
// ANY token, not only the first, so launches where the executable name
// is not the first token are still detected. Per the documented asymmetry,
// this is deliberately generous -- see the accepted-false-positive test
// right after.

test("claude launched indirectly: npx claude, cmd /c claude, wsl claude, docker exec ... claude", () => {
  expect(isClaudeLaunch("npx claude --model opus")).toBe(true);
  expect(isClaudeLaunch("cmd /c claude --model opus")).toBe(true);
  expect(isClaudeLaunch("wsl claude --model opus")).toBe(true);
  expect(isClaudeLaunch("docker exec -it kory-sbx claude --model opus")).toBe(true);
});

test("ACCEPTED false positive: a flag value that happens to literally read 'claude' matches -- the visible-degradation side of the asymmetry, not a bug", () => {
  expect(isClaudeLaunch("some-cli --agent claude")).toBe(true);
});

test("a renamed/aliased claude binary (no token spells 'claude') is still an open, documented gap", () => {
  expect(isClaudeLaunch("cc --model opus")).toBe(false);
});
