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
});

test("stripAnsi removes CSI sequences", () => {
  expect(stripAnsi("\x1b[1mbold\x1b[0m text")).toBe("bold text");
});

test("magicCompactPluginPresent finds a plugin dir under ~/.claude/plugins", () => {
  const home = tmpHome();
  expect(magicCompactPluginPresent(home)).toBe(false); // nothing installed
  mkdirSync(join(home, ".claude", "plugins", "marketplace", "claude-magic-compact"), {
    recursive: true
  });
  expect(magicCompactPluginPresent(home)).toBe(true);
});

test("magicCompactPluginPresent is false for an unrelated plugin", () => {
  const home = tmpHome();
  mkdirSync(join(home, ".claude", "plugins", "some-other-plugin"), { recursive: true });
  expect(magicCompactPluginPresent(home)).toBe(false);
});
