// EXPLORATION-graph-chat C24: headless CLI adapters
// (desktop/src/main/model-adapters). Context by FILE (D5), read-only
// harness per CLI (D6), command-line model sanitized.

import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildAdapterCommand,
  MAX_PROMPT_ARG_CHARS,
  sanitizeModel,
  stdinFromFile,
  writeContextFile
} from "../desktop/src/main/model-adapters.ts";
import { HELP_DISALLOWED_TOOLS } from "../desktop/src/main/help-assistant.ts";

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
  const d = mkdtempSync(join(tmpdir(), "cp-graph-adapters-"));
  tmpDirs.push(d);
  return d;
}

test("sanitizeModel allows identifiers, rejects shell metacharacters", () => {
  expect(sanitizeModel("sonnet")).toBe("sonnet");
  expect(sanitizeModel("gpt-5.1:high")).toBe("gpt-5.1:high");
  expect(sanitizeModel("")).toBe("");
  expect(sanitizeModel("x; rm -rf /")).toBe("");
  expect(sanitizeModel("a".repeat(200))).toBe("");
});

test("stdinFromFile: POSIX redirection vs PowerShell pipe", () => {
  expect(stdinFromFile("codex exec -", "/tmp/f.md", "linux")).toBe('codex exec - < "/tmp/f.md"');
  expect(stdinFromFile("gemini", "C:\\f.md", "win32")).toBe('Get-Content -Raw "C:\\f.md" | gemini');
});

test("claude adapter: C9 read-only harness, context via --append-system-prompt-file", () => {
  const cmd = buildAdapterCommand({
    promptText: "why?",
    contextFile: "/state/ctx.md",
    target: { cli: "claude", model: "opus" },
    platform: "linux"
  });
  expect(cmd).toBe(
    `claude -p 'why?' --append-system-prompt-file "/state/ctx.md" --model opus` +
      ` --strict-mcp-config --disallowedTools "${HELP_DISALLOWED_TOOLS}"`
  );
});

test("claude adapter quotes the prompt per platform and caps its length", () => {
  const cmd = buildAdapterCommand({
    promptText: "it's " + "x".repeat(MAX_PROMPT_ARG_CHARS),
    contextFile: "/f",
    target: { cli: "claude", model: "" },
    platform: "linux"
  });
  expect(cmd).toContain("'it'\\''s ");
  expect(cmd.length).toBeLessThan(MAX_PROMPT_ARG_CHARS + 300);
  expect(cmd).not.toContain("--model"); // '' = CLI default
  const win = buildAdapterCommand({
    promptText: "it's",
    contextFile: "C:\\f",
    target: { cli: "claude", model: "" },
    platform: "win32"
  });
  expect(win).toContain("'it''s'");
});

test("codex adapter: read-only sandbox, prompt fed from the file via stdin", () => {
  const cmd = buildAdapterCommand({
    promptText: "ignored on the command line",
    contextFile: "/state/ctx.md",
    target: { cli: "codex", model: "gpt-5" },
    platform: "linux"
  });
  expect(cmd).toBe('codex exec --sandbox read-only -m gpt-5 - < "/state/ctx.md"');
  expect(cmd).not.toContain("ignored");
});

test("gemini adapter: stdin file, optional model, no write flags", () => {
  const linux = buildAdapterCommand({
    promptText: "q",
    contextFile: "/f.md",
    target: { cli: "gemini", model: "" },
    platform: "linux"
  });
  expect(linux).toBe('gemini < "/f.md"');
  const win = buildAdapterCommand({
    promptText: "q",
    contextFile: "C:\\f.md",
    target: { cli: "gemini", model: "gemini-3-pro" },
    platform: "win32"
  });
  expect(win).toBe('Get-Content -Raw "C:\\f.md" | gemini -m gemini-3-pro');
});

test("a hostile model string is dropped, never spliced into the command", () => {
  const cmd = buildAdapterCommand({
    promptText: "q",
    contextFile: "/f",
    target: { cli: "codex", model: "$(reboot)" },
    platform: "linux"
  });
  expect(cmd).not.toContain("reboot");
  expect(cmd).not.toContain("-m ");
});

test("writeContextFile: parallel targets get distinct files, id sanitized", () => {
  const dir = tmp();
  const f1 = writeContextFile(dir, { nodeId: "n1", cli: "claude" }, "content-A");
  const f2 = writeContextFile(dir, { nodeId: "n1", cli: "codex" }, "content-B");
  expect(f1).not.toBe(f2);
  expect(readFileSync(f1, "utf-8")).toBe("content-A");
  expect(readFileSync(f2, "utf-8")).toBe("content-B");
  const evil = writeContextFile(dir, { nodeId: "../../etc/passwd", cli: "gemini" }, "x");
  expect(evil.startsWith(dir)).toBe(true);
  expect(evil).not.toContain("..");
});

// ----- local HTTP adapter (C29) -----

import {
  buildChatCompletionRequest,
  chatCompletionsUrl,
  runHttpInference
} from "../desktop/src/main/model-adapters.ts";

test("chatCompletionsUrl respects an already-/v1 base", () => {
  expect(chatCompletionsUrl("http://localhost:11434")).toBe(
    "http://localhost:11434/v1/chat/completions"
  );
  expect(chatCompletionsUrl("http://litellm:4000/v1/")).toBe(
    "http://litellm:4000/v1/chat/completions"
  );
});

test("buildChatCompletionRequest: system+user messages, bearer only when keyed", () => {
  const { url, init } = buildChatCompletionRequest({
    baseUrl: "http://h",
    apiKey: "sk-x",
    model: "qwen3:32b",
    system: "SYS",
    prompt: "QUESTION"
  });
  expect(url).toBe("http://h/v1/chat/completions");
  expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-x");
  const body = JSON.parse(init.body as string);
  expect(body.model).toBe("qwen3:32b");
  expect(body.stream).toBe(false);
  expect(body.messages).toEqual([
    { role: "system", content: "SYS" },
    { role: "user", content: "QUESTION" }
  ]);
  const noKey = buildChatCompletionRequest({
    baseUrl: "http://h",
    model: "m",
    system: "s",
    prompt: "p"
  });
  expect((noKey.init.headers as Record<string, string>).Authorization).toBeUndefined();
});

test("runHttpInference: returns the completion, readable errors otherwise", async () => {
  const ok = (json: unknown): typeof fetch =>
    (async () => new Response(JSON.stringify(json), { status: 200 })) as typeof fetch;
  const input = { baseUrl: "http://h", model: "m", system: "s", prompt: "p" };
  await expect(
    runHttpInference(input, ok({ choices: [{ message: { content: "  an answer  " } }] }))
  ).resolves.toBe("an answer");
  await expect(runHttpInference(input, ok({ choices: [] }))).rejects.toThrow("empty completion");
  const http500 = (async () => new Response("boom", { status: 500 })) as typeof fetch;
  await expect(runHttpInference(input, http500)).rejects.toThrow("HTTP 500");
});
