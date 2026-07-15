// PLAN-v0.4 C9: the floating help assistant (desktop/src/main/help-assistant).
// Pure builders + a real runHelp round-trip against a fake `claude` binary.

import { test, expect, afterAll } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildHelpSystemPrompt,
  buildHelpPrompt,
  buildHelpCommand,
  writeHelpSystemPrompt,
  runHelp,
  HELP_SYSTEM_PROMPT,
  HELP_DISALLOWED_TOOLS,
  DEFAULT_HELP_MODEL
} from "../desktop/src/main/help-assistant.ts";

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

test("an oversized snapshot is truncated, never unbounded", () => {
  const text = buildHelpSystemPrompt({ view: "agents", data: { blob: "x".repeat(200_000) } });
  expect(text.length).toBeLessThan(70_000);
  expect(text).toContain("[snapshot truncated]");
});

test("writeHelpSystemPrompt writes the composed prompt to the app-state dir", () => {
  const dir = tmp();
  const file = writeHelpSystemPrompt(dir, { view: "home", data: null });
  expect(file.endsWith("help-system-prompt.md")).toBe(true);
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

// ----- command composition (the technical read-only guarantees) -----

test("command carries -p, quoted prompt, model, strict-mcp-config and denied tools", () => {
  const cmd = buildHelpCommand({
    promptText: "what's next? l'item #12",
    systemPromptFile: "/state/help-system-prompt.md",
    model: "haiku",
    platform: "linux"
  });
  expect(cmd.startsWith("claude -p 'what'\\''s next? l'\\''item #12'")).toBe(true);
  expect(cmd).toContain('--append-system-prompt-file "/state/help-system-prompt.md"');
  expect(cmd).toContain("--model haiku");
  expect(cmd).toContain("--strict-mcp-config"); // no MCP: neither claude-peers nor deck-control
  expect(cmd).toContain(`--disallowedTools "${HELP_DISALLOWED_TOOLS}"`);
  for (const tool of ["Bash", "Edit", "Write", "Task"]) {
    expect(HELP_DISALLOWED_TOOLS).toContain(tool);
  }
});

test("an unknown model falls back to the default (haiku)", () => {
  const cmd = buildHelpCommand({
    promptText: "q",
    systemPromptFile: "/f",
    model: "gpt-9000",
    platform: "linux"
  });
  expect(cmd).toContain(`--model ${DEFAULT_HELP_MODEL}`);
});

// ----- runHelp against a fake claude binary -----

test("runHelp resolves the binary through the login shell and returns stdout", async () => {
  const dir = tmp();
  const fake = join(dir, "claude");
  writeFileSync(fake, '#!/bin/sh\necho "fake answer: $2"\n', "utf-8");
  chmodSync(fake, 0o755);

  const cmd = buildHelpCommand({
    promptText: "which item next?",
    systemPromptFile: join(dir, "sys.md"),
    model: "haiku",
    claudeBin: fake,
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
  const cmd = buildHelpCommand({
    promptText: "q",
    systemPromptFile: join(dir, "sys.md"),
    model: "haiku",
    claudeBin: fake,
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
