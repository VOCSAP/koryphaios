// PLAN-v0.4 C9: the floating help assistant (desktop/src/main/help-assistant).
// Pure builders + a real runHelp round-trip against a fake `claude` binary.
// Since lot A the command side lives in model-adapters (buildAdapterCommand);
// this suite keeps the prompts, the transcript replay and the executor.

import { test, expect, afterAll } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildHelpSystemPrompt,
  buildHelpPrompt,
  runHelp,
  HELP_SYSTEM_PROMPT
} from "../desktop/src/main/help-assistant.ts";
import { buildAdapterCommand } from "../desktop/src/main/model-adapters.ts";

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* */
    }
  }
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "cp-help-"));
  tmpDirs.push(d);
  return d;
}

// ----- system prompt -----

test("system prompt embeds the code constant, the view and the snapshot", () => {
  const text = buildHelpSystemPrompt({ view: "roadmap", data: [{ id: "a1", title: "Item X" }] });
  expect(text).toContain(HELP_SYSTEM_PROMPT);
  expect(text).toContain("Active view: roadmap");
  expect(text).toContain("Item X");
  expect(HELP_SYSTEM_PROMPT).toContain("read-only");
});

test("a docsDir adds the reference-documentation section; absent otherwise", () => {
  const withDocs = buildHelpSystemPrompt({
    view: "agents",
    data: null,
    docsDir: "/opt/app/resources/docs"
  });
  expect(withDocs).toContain("## Reference documentation");
  expect(withDocs).toContain("/opt/app/resources/docs");
  expect(withDocs).toContain("README.md");

  const without = buildHelpSystemPrompt({ view: "agents", data: null });
  expect(without).not.toContain("## Reference documentation");
  expect(buildHelpSystemPrompt({ view: "agents", data: null, docsDir: "" })).not.toContain(
    "## Reference documentation"
  );
});

test("the claude adapter grants the docs dir via --add-dir (quoted), others unchanged", () => {
  const cmd = buildAdapterCommand({
    promptText: "q",
    contextFile: "/tmp/sys.md",
    target: { cli: "claude", model: "haiku" },
    addDir: "/opt/app/resources/docs",
    platform: "linux"
  });
  expect(cmd).toContain('--add-dir "/opt/app/resources/docs"');
  const bare = buildAdapterCommand({
    promptText: "q",
    contextFile: "/tmp/sys.md",
    target: { cli: "claude", model: "haiku" },
    platform: "linux"
  });
  expect(bare).not.toContain("--add-dir");
});

test("an oversized snapshot is truncated, never unbounded", () => {
  const text = buildHelpSystemPrompt({ view: "agents", data: { blob: "x".repeat(200_000) } });
  expect(text.length).toBeLessThan(70_000);
  expect(text).toContain("[snapshot truncated]");
});

// ----- transcript replay -----

test("prompt replays only the last 4 completed exchanges", () => {
  const transcript = Array.from({ length: 6 }, (_, i) => ({
    question: `q${i}`,
    answer: `a${i}`
  }));
  const p = buildHelpPrompt("new question", transcript);
  expect(p).not.toContain("q0");
  expect(p).not.toContain("q1");
  expect(p).toContain("q2");
  expect(p).toContain("a5");
  expect(p).toContain("new question");
  expect(buildHelpPrompt("solo", [])).toBe("solo");
});

// ----- runHelp against a fake claude binary -----

test("runHelp resolves the binary through the login shell and returns stdout", async () => {
  const dir = tmp();
  const fake = join(dir, "claude");
  writeFileSync(fake, '#!/bin/sh\necho "fake answer: $2"\n', "utf-8");
  chmodSync(fake, 0o755);

  const cmd = buildAdapterCommand({
    promptText: "which item next?",
    contextFile: join(dir, "sys.md"),
    target: { cli: "claude", model: "haiku" },
    bin: fake,
    platform: "linux"
  });
  const out = await runHelp({ command: cmd, shell: "/bin/sh", cwd: dir });
  expect(out).toBe("fake answer: which item next?");
});

test("runHelp surfaces a failing invocation as a rejected promise", async () => {
  const dir = tmp();
  const fake = join(dir, "claude");
  writeFileSync(fake, '#!/bin/sh\necho "boom" >&2\nexit 1\n', "utf-8");
  chmodSync(fake, 0o755);
  const cmd = buildAdapterCommand({
    promptText: "q",
    contextFile: join(dir, "sys.md"),
    target: { cli: "claude", model: "haiku" },
    bin: fake,
    platform: "linux"
  });
  await expect(runHelp({ command: cmd, shell: "/bin/sh", cwd: dir })).rejects.toThrow(/boom/);
});

// ----- plan import prompt (PLAN C7, code constant like the help prompt) -----

import { composePlanImportPrompt } from "../desktop/src/main/import-plan.ts";

test("plan-import prompt embeds the file, the roadmap_add flow and the /exit", () => {
  const p = composePlanImportPrompt("/home/u/proj/PLAN-v0.4.md");
  expect(p).toContain("/home/u/proj/PLAN-v0.4.md");
  expect(p).toContain("roadmap_list");
  expect(p).toContain("roadmap_add");
  expect(p).toContain('"PLAN-v0.4.md"'); // tag = plan basename
  expect(p).toContain("/exit");
  expect(p).toContain("Do not modify any file");
});
