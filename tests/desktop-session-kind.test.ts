// Card fd1914cc: isClaudeLaunch gates the Deck's own quota auto-resume off
// for Claude Code sessions (which own their resume since CC 2.1.235+).

import { test, expect } from "bun:test";

import {
  isClaudeLaunch,
  isClodexLaunch,
  withClodexWrapper
} from "../desktop/src/main/session-kind.ts";

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

// Deliberately matches any token, not only the first, so a launch where the
// executable name isn't first is still detected -- a documented, generous
// false-positive tradeoff.

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

// ----- clodex wrapper -----

test("the clodex wrapper is recognised as a claude launch (it execs the same binary)", () => {
  expect(isClaudeLaunch("clodex-claude --model opus")).toBe(true);
  expect(isClaudeLaunch("/usr/local/bin/clodex-claude --model opus")).toBe(true);
  expect(
    isClaudeLaunch("C:\\Users\\op\\AppData\\Roaming\\npm\\clodex-claude.cmd --model opus")
  ).toBe(true);
  expect(isClaudeLaunch("CLODEX-CLAUDE --model opus")).toBe(true);
});

test("isClodexLaunch is true only for the wrapper, never for plain claude", () => {
  expect(isClodexLaunch("clodex-claude --model opus")).toBe(true);
  expect(isClodexLaunch("npx clodex-claude")).toBe(true);
  expect(isClodexLaunch('"C:\\Program Files\\clodex-claude.cmd" --model opus')).toBe(true);
  expect(isClodexLaunch("claude --model opus")).toBe(false);
  expect(isClodexLaunch("")).toBe(false);
});

test("withClodexWrapper rewrites the default launch command, keeping every other token verbatim", () => {
  expect(
    withClodexWrapper("claude --dangerously-load-development-channels server:claude-peers")
  ).toBe("clodex-claude --dangerously-load-development-channels server:claude-peers");
});

test("withClodexWrapper drops the directory prefix: the wrapper resolves the real binary itself", () => {
  expect(withClodexWrapper("/usr/local/bin/claude --model opus")).toBe(
    "clodex-claude --model opus"
  );
});

test("withClodexWrapper drops a Windows executable extension too", () => {
  expect(
    withClodexWrapper("C:\\Users\\op\\AppData\\Roaming\\npm\\claude.cmd --model opus")
  ).toBe("clodex-claude --model opus");
});

test("withClodexWrapper replaces a QUOTED path (quotes included) and leaves the other tokens' quoting untouched", () => {
  expect(withClodexWrapper('"C:\\Program Files\\claude.cmd" --agent "my agent"')).toBe(
    'clodex-claude --agent "my agent"'
  );
});

test("withClodexWrapper rewrites the claude token of an indirect launch, not the launcher", () => {
  expect(withClodexWrapper("npx claude --model opus")).toBe("npx clodex-claude --model opus");
  expect(withClodexWrapper("cmd /c claude --model opus")).toBe(
    "cmd /c clodex-claude --model opus"
  );
});

test("withClodexWrapper rewrites the FIRST claude token only", () => {
  expect(withClodexWrapper("claude --agent claude")).toBe("clodex-claude --agent claude");
});

// Same accepted false positive as isClaudeLaunch's: a flag value spelling
// 'claude' is indistinguishable from a binary name at this layer, and the
// resulting tile fails visibly instead of silently running unbridged.
test("ACCEPTED false positive: a flag value that literally reads 'claude' is rewritten", () => {
  expect(withClodexWrapper("some-cli --agent claude")).toBe("some-cli --agent clodex-claude");
});

test("withClodexWrapper returns a command with no claude token unchanged", () => {
  expect(withClodexWrapper("codex --flag")).toBe("codex --flag");
  expect(withClodexWrapper("./run-agent.sh --whatever")).toBe("./run-agent.sh --whatever");
  expect(withClodexWrapper("cc --model opus")).toBe("cc --model opus");
});

test("withClodexWrapper is idempotent: an already-wrapped command is returned unchanged", () => {
  const wrapped = withClodexWrapper("claude --model opus");
  expect(withClodexWrapper(wrapped)).toBe(wrapped);
  expect(withClodexWrapper("/opt/bin/clodex-claude --model opus")).toBe(
    "/opt/bin/clodex-claude --model opus"
  );
});

test("withClodexWrapper THROWS on an empty command: empty means the CONFIGURED launch command, which only the caller can resolve", () => {
  expect(() => withClodexWrapper("")).toThrow(/withClodexWrapper guard/);
  expect(() => withClodexWrapper("   ")).toThrow(/withClodexWrapper guard/);
});
