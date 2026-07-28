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
  sanitizeHelpSelection,
  HELP_SELECTION_TEXT_MAX,
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

// ----- code selection (PLAN GX7) -----

test("sanitizeHelpSelection validates, snake_cases and caps the payload", () => {
  const sel = sanitizeHelpSelection({
    file: "src/app.ts",
    startLine: 3,
    endLine: 7,
    text: "const x = 1"
  });
  expect(sel).toEqual({ file: "src/app.ts", start_line: 3, end_line: 7, text: "const x = 1" });

  const capped = sanitizeHelpSelection({
    file: "a.ts",
    startLine: 1,
    endLine: 2,
    text: "y".repeat(HELP_SELECTION_TEXT_MAX + 50)
  });
  expect(capped!.text.length).toBe(HELP_SELECTION_TEXT_MAX);

  // Malformed / hostile payloads degrade to null (question goes out bare).
  expect(sanitizeHelpSelection(undefined)).toBeNull();
  expect(sanitizeHelpSelection("nope")).toBeNull();
  expect(sanitizeHelpSelection({ file: "a", text: "   " })).toBeNull();
  expect(sanitizeHelpSelection({ file: 42, text: "x" })).toBeNull();
  // Non-numeric lines degrade to 1, they never break the call.
  expect(sanitizeHelpSelection({ file: "a", text: "x", startLine: "z" })!.start_line).toBe(1);
});

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
    promptFile: "/tmp/q.md",
    contextFile: "/tmp/sys.md",
    target: { cli: "claude", model: "haiku" },
    addDir: "/opt/app/resources/docs",
    platform: "linux"
  });
  expect(cmd).toContain('--add-dir "/opt/app/resources/docs"');
  const bare = buildAdapterCommand({
    promptFile: "/tmp/q.md",
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

// The two tests below pin `platform: "linux"` and drive a `#!/bin/sh` fixture
// through `shell: "/bin/sh"` — they exercise the POSIX branch BY CONSTRUCTION
// and there is no /bin/sh to run them against on a Windows runner. The Windows
// command SHAPE is covered by the pure adapter tests (which pass an explicit
// platform), and the OS-agnostic runHelp contract by the two tests after them.
const posixOnly = process.platform === "win32" ? test.skip : test;

posixOnly("runHelp resolves the binary through the login shell and returns stdout", async () => {
  const dir = tmp();
  const fake = join(dir, "claude");
  // The question now rides stdin (D5 extended — 07dc42c0), never a positional
  // arg: the fake binary reads it off its own stdin.
  writeFileSync(fake, '#!/bin/sh\nq="$(cat)"\necho "fake answer: $q"\n', "utf-8");
  chmodSync(fake, 0o755);
  const promptFile = join(dir, "prompt.md");
  writeFileSync(promptFile, "which item next?", "utf-8");

  const cmd = buildAdapterCommand({
    promptFile,
    contextFile: join(dir, "sys.md"),
    target: { cli: "claude", model: "haiku" },
    bin: fake,
    platform: "linux"
  });
  const out = await runHelp({ command: cmd, shell: "/bin/sh", cwd: dir });
  expect(out).toBe("fake answer: which item next?");
});

posixOnly("runHelp surfaces a failing invocation as a rejected promise", async () => {
  const dir = tmp();
  const fake = join(dir, "claude");
  writeFileSync(fake, '#!/bin/sh\ncat >/dev/null\necho "boom" >&2\nexit 1\n', "utf-8");
  chmodSync(fake, 0o755);
  const promptFile = join(dir, "prompt.md");
  writeFileSync(promptFile, "q", "utf-8");
  const cmd = buildAdapterCommand({
    promptFile,
    contextFile: join(dir, "sys.md"),
    target: { cli: "claude", model: "haiku" },
    bin: fake,
    platform: "linux"
  });
  await expect(runHelp({ command: cmd, shell: "/bin/sh", cwd: dir })).rejects.toThrow(/boom/);
});

// Same executor, no fixture and no shell override: `echo` and a missing binary
// behave the same in sh and in PowerShell, so these run on every OS and keep
// Windows covered for the marker-stripping / stdout / rejection contract.
test("runHelp strips its start marker and returns the command's stdout", async () => {
  const out = await runHelp({ command: "echo hello-from-help", shell: "", cwd: tmp() });
  expect(out).toBe("hello-from-help");
});

test("runHelp rejects when the command cannot run", async () => {
  await expect(
    runHelp({ command: "definitely-not-a-command-xyz", shell: "", cwd: tmp() })
  ).rejects.toThrow();
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
