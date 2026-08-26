// CT4: Magic Compact output parsing + plugin detection
// (desktop/src/main/magic-compact). The re-entry banner is captured from
// terminal output, so parsing must survive ANSI styling and only accept a
// strict UUID; detection is a best-effort fs probe.

import { test, expect, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseMagicResume,
  isMagicShimFailure,
  stripAnsi,
  magicCompactPluginPresent
} from "../desktop/src/main/magic-compact.ts";

const tmpDirs: string[] = [];
function tmpHome(): string {
  const d = mkdtempSync(join(tmpdir(), "magic-home-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const UUID = "1234abcd-56ef-4789-8abc-1234567890ab";

test("parses the /resume id from the success banner", () => {
  const out = `Magic Compact success.\nTo enter the compacted session, run the following command:\n/resume ${UUID}\n`;
  expect(parseMagicResume(out)).toBe(UUID);
});

test("parses the banner even when wrapped in ANSI styling", () => {
  const out = `\x1b[32mTo enter the compacted session\x1b[0m, run:\n\x1b[1m/resume ${UUID}\x1b[0m`;
  expect(parseMagicResume(out)).toBe(UUID);
});

test("parses the banner when a reset sequence sits right before the id", () => {
  // ANSI reset between the space and the UUID must not defeat \s+<uuid>.
  const out = `To enter the compacted session, run:\n/resume \x1b[0m${UUID}`;
  expect(parseMagicResume(out)).toBe(UUID);
});

test("returns null when there is no banner", () => {
  expect(parseMagicResume("just some normal terminal output")).toBeNull();
  // a non-UUID after /resume must not match
  expect(parseMagicResume("To enter the compacted session run /resume not-a-uuid")).toBeNull();
});

test("detects the shim-failure message", () => {
  expect(isMagicShimFailure("the Magic Compact hook failed to intercept the command")).toBe(true);
  expect(
    isMagicShimFailure("verify the claude-magic-compact plugin is installed and enabled")
  ).toBe(true);
  expect(isMagicShimFailure("all good here")).toBe(false);
  // 'installed and enabled' with NO magic-compact context must NOT trip the shim.
  expect(isMagicShimFailure("the foobar plugin is installed and enabled")).toBe(false);
});

test("stripAnsi removes CSI sequences", () => {
  expect(stripAnsi("\x1b[1mbold\x1b[0m text")).toBe("bold text");
});

test("stripAnsi preserves bare brackets and parentheses (ESC-anchored)", () => {
  // No ESC -> nothing is stripped; legitimate text must survive intact.
  expect(stripAnsi("[link] (2 messages) [1m]")).toBe("[link] (2 messages) [1m]");
});

test("stripAnsi drops an orphan ESC from a partial sequence", () => {
  expect(stripAnsi("a\x1bb")).toBe("ab");
});

// Card 1aa69066 (H2) review, blocker F5: without a dedicated OSC pass, an
// OSC sequence's ESC byte fell through to the orphan-ESC catch-all (which
// strips only that ONE byte), leaving the payload text and its BEL
// terminator sitting in the output as ordinary visible text -- WORSE than
// no strip at all, since a downstream MAGIC_RESUME_RE/MAGIC_SHIM_RE match
// against that leaked text has nothing marking it as escape-sequence
// content anymore. MEASURED (reviewer): before this pass existed,
// `stripAnsi("A" + ESC + "]0;* Claude is working" + BEL + "B")` produced
// `"A]0;* Claude is workingB"`, not `"AB"`.
test("stripAnsi removes a complete OSC sequence (title/progress/notify), not just its leading ESC", () => {
  const withOsc = "A\x1b]0;* Claude is working\x07B";
  expect(stripAnsi(withOsc)).toBe("AB");
});

test("stripAnsi removes an OSC sequence terminated by ST (ESC \\\\), same as BEL", () => {
  const withOsc = "A\x1b]0;title\x1b\\B";
  expect(stripAnsi(withOsc)).toBe("AB");
});

test("an OSC-carried word does not survive to spuriously match the shim/resume patterns", () => {
  const out = "\x1b]777;notify;Claude Code;hook failed to intercept\x07just some normal terminal output";
  expect(isMagicShimFailure(out)).toBe(false);
});

test("magicCompactPluginPresent finds a plugin dir under <config>/plugins", () => {
  const cfg = join(tmpHome(), ".claude");
  expect(magicCompactPluginPresent(cfg)).toBe(false); // nothing installed
  mkdirSync(join(cfg, "plugins", "marketplace", "claude-magic-compact"), {
    recursive: true
  });
  expect(magicCompactPluginPresent(cfg)).toBe(true);
});

test("magicCompactPluginPresent is false for an unrelated plugin", () => {
  const cfg = join(tmpHome(), ".claude");
  mkdirSync(join(cfg, "plugins", "some-other-plugin"), { recursive: true });
  expect(magicCompactPluginPresent(cfg)).toBe(false);
});
