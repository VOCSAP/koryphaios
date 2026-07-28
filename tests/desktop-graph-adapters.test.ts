// EXPLORATION-graph-chat C24: headless CLI adapters
// (desktop/src/main/model-adapters). Context by FILE (D5), read-only
// harness per CLI (D6), command-line model sanitized.

import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildAdapterCommand,
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

test("stdinFromFile: POSIX redirection vs PowerShell pipe, UTF-8 forced on both win32 stages", () => {
  expect(stdinFromFile("codex exec -", "/tmp/f.md", "linux")).toBe('codex exec - < "/tmp/f.md"');
  // win32: WinPS 5.1's Get-Content defaults to the ANSI codepage on a BOM-less
  // file, and $OutputEncoding defaults to ASCII when piping to a native
  // child — both silently mangle non-ASCII operator text unless forced.
  expect(stdinFromFile("gemini", "C:\\f.md", "win32")).toBe(
    '$OutputEncoding = [System.Text.UTF8Encoding]::new($false); ' +
      'Get-Content -Raw -Encoding UTF8 "C:\\f.md" | gemini'
  );
});

test("claude adapter: C9 read-only harness, context via --append-system-prompt-file, question via stdinFromFile", () => {
  const cmd = buildAdapterCommand({
    promptFile: "/state/q.md",
    contextFile: "/state/ctx.md",
    target: { cli: "claude", model: "opus" },
    platform: "linux"
  });
  expect(cmd).toBe(
    `claude -p --append-system-prompt-file "/state/ctx.md" --model opus` +
      ` --strict-mcp-config --disallowedTools "${HELP_DISALLOWED_TOOLS}"` +
      ` < "/state/q.md"`
  );
});

test("claude adapter never puts operator text on argv (07dc42c0): embedded quotes, newlines and non-ASCII stay in the piped file", () => {
  // The exact reported field failure: an unbalanced double quote before a
  // space used to truncate the win32 argv-passed prompt mid-sentence. The
  // fixed command must carry NONE of the operator text — only the promptFile
  // path, read via stdinFromFile. Accented (é à ç) and non-Latin-1 (œ, φ)
  // characters are included per the hardened acceptance criteria: an
  // ASCII-only prompt would stay green even with the WinPS 5.1 encoding traps
  // wide open (ANSI-codepage Get-Content, ASCII $OutputEncoding).
  const hostile =
    'Voici le sujet à étudier : "Explique moi en 50 mots ce qu\'est Docker"\nligne deux \'x\' — φ œuvre';
  const linux = buildAdapterCommand({
    promptFile: "/state/graphs/graph-context-n1-prompt-claude.md",
    contextFile: "/state/graphs/graph-context-n1-claude.md",
    target: { cli: "claude", model: "" },
    platform: "linux"
  });
  expect(linux).not.toContain(hostile);
  expect(linux).not.toContain("Explique");
  expect(linux).not.toContain("--model"); // '' = CLI default
  expect(linux).toBe(
    `claude -p --append-system-prompt-file "/state/graphs/graph-context-n1-claude.md"` +
      ` --strict-mcp-config --disallowedTools "${HELP_DISALLOWED_TOOLS}"` +
      ` < "/state/graphs/graph-context-n1-prompt-claude.md"`
  );
  const win = buildAdapterCommand({
    promptFile: "C:\\q.md",
    contextFile: "C:\\ctx.md",
    target: { cli: "claude", model: "" },
    platform: "win32"
  });
  expect(win).toContain('$OutputEncoding = [System.Text.UTF8Encoding]::new($false); ');
  expect(win).toContain('Get-Content -Raw -Encoding UTF8 "C:\\q.md" |');
  expect(win).not.toContain(hostile);
});

test("claude adapter throws when promptFile is missing (D5 contract defended)", () => {
  expect(() =>
    buildAdapterCommand({
      contextFile: "/f",
      target: { cli: "claude", model: "" },
      platform: "linux"
    })
  ).toThrow(/promptFile/);
});

test("codex adapter: read-only sandbox, composed prompt fed from the context file via stdin", () => {
  const cmd = buildAdapterCommand({
    contextFile: "/state/ctx.md",
    target: { cli: "codex", model: "gpt-5" },
    platform: "linux"
  });
  expect(cmd).toBe('codex exec --sandbox read-only -m gpt-5 - < "/state/ctx.md"');
});

test("gemini adapter: stdin file, optional model, read-only plan mode", () => {
  const linux = buildAdapterCommand({
    contextFile: "/f.md",
    target: { cli: "gemini", model: "" },
    platform: "linux"
  });
  expect(linux).toBe('gemini --approval-mode plan < "/f.md"');
  const win = buildAdapterCommand({
    contextFile: "C:\\f.md",
    target: { cli: "gemini", model: "gemini-3-pro" },
    platform: "win32"
  });
  expect(win).toBe(
    '$OutputEncoding = [System.Text.UTF8Encoding]::new($false); ' +
      'Get-Content -Raw -Encoding UTF8 "C:\\f.md" | gemini -m gemini-3-pro --approval-mode plan'
  );
});

test("a hostile model string is dropped, never spliced into the command", () => {
  const cmd = buildAdapterCommand({
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

test("antigravity model sanitizer allows display names, rejects injection", async () => {
  const { sanitizeAntigravityModel } = await import("../desktop/src/main/model-adapters.ts");
  expect(sanitizeAntigravityModel("Gemini 3 Pro (High)")).toBe("Gemini 3 Pro (High)");
  expect(sanitizeAntigravityModel("")).toBe("");
  expect(sanitizeAntigravityModel('x" ; rm -rf /')).toBe("");
  expect(sanitizeAntigravityModel("a$(whoami)")).toBe("");
});

test("antigravity adapter: file instruction, add-dir, quoted model, print-timeout", () => {
  const cmd = buildAdapterCommand({
    contextFile: "/state/graphs/graph-context-n1-antigravity.md",
    target: { cli: "antigravity", model: "Gemini 3 Pro (High)" },
    platform: "linux"
  });
  expect(cmd.startsWith("agy -p ")).toBe(true);
  expect(cmd).toContain('/state/graphs/graph-context-n1-antigravity.md');
  expect(cmd).toContain('--add-dir "/state/graphs"');
  expect(cmd).toContain('--model "Gemini 3 Pro (High)"');
  expect(cmd).toContain("--print-timeout 4m");
  // No model flag when empty (CLI default applies).
  const noModel = buildAdapterCommand({
    contextFile: "/state/graphs/f.md",
    target: { cli: "antigravity", model: "" },
    platform: "linux"
  });
  expect(noModel).not.toContain("--model");
});
