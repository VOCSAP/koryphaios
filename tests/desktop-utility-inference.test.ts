// Lot A (EXPLORATION-multi-llm): utility-inference routing — help assistant,
// resume digest and context wand generalized to any ModelTarget. Frontier
// CLIs get the C24 adapter commands (context by FILE), 'local' goes over
// HTTP; system prompts stay separated on claude, composed on stdin CLIs.

import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  composeStdinPrompt,
  runUtilityInference
} from "../desktop/src/main/utility-inference.ts";
import { HELP_DISALLOWED_TOOLS } from "../desktop/src/main/help-assistant.ts";
import {
  DEFAULT_HELP_TARGET,
  DEFAULT_WAND_TARGET,
  legacyHelpTarget,
  sanitizeTarget,
  targetKey,
  targetLabel
} from "../desktop/src/shared/models.ts";

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
  const d = mkdtempSync(join(tmpdir(), "cp-utility-"));
  tmpDirs.push(d);
  return d;
}

// ----- routing -----

test("claude target: system-only context file, C9 read-only command", async () => {
  const stateDir = tmp();
  const commands: string[] = [];
  const out = await runUtilityInference(
    { stateDir, shell: "", cwd: "/", run: async (cmd) => (commands.push(cmd), "an answer") },
    { target: { cli: "claude", model: "haiku" }, system: "SYS", prompt: "QUESTION", kind: "help" }
  );
  expect(out).toBe("an answer");
  expect(commands).toHaveLength(1);
  const cmd = commands[0]!;
  expect(cmd).toContain("claude -p");
  expect(cmd).toContain("--model haiku");
  expect(cmd).toContain("--strict-mcp-config");
  expect(cmd).toContain(`--disallowedTools "${HELP_DISALLOWED_TOOLS}"`);
  // The system side rides --append-system-prompt-file; the question rides a
  // second file, fed via stdin (D5 extended — 07dc42c0), never the command.
  const file = /--append-system-prompt-file "([^"]+)"/.exec(cmd)![1]!;
  expect(readFileSync(file, "utf-8")).toBe("SYS");
  expect(cmd).not.toContain("QUESTION");
  const m = /(?:< "([^"]+)"$|Get-Content -Raw -Encoding UTF8 "([^"]+)" \|)/.exec(cmd)!;
  const promptFile = (m[1] ?? m[2])!;
  expect(readFileSync(promptFile, "utf-8")).toBe("QUESTION");
});

test("codex/gemini targets: composed system+question document fed via stdin", async () => {
  const stateDir = tmp();
  const commands: string[] = [];
  await runUtilityInference(
    { stateDir, shell: "", cwd: "/", run: async (cmd) => (commands.push(cmd), "ok") },
    { target: { cli: "codex", model: "gpt-5.1" }, system: "SYS", prompt: "QUESTION", kind: "wand" }
  );
  const cmd = commands[0]!;
  expect(cmd).toContain("codex exec --sandbox read-only -m gpt-5.1 -");
  // The adapter emits the PLATFORM's stdin form (POSIX `< "file"`, PowerShell
  // `Get-Content -Raw -Encoding UTF8 "file" | …`, see stdinFromFile). Accept
  // either so this test asserts the document CONTRACT, not one OS's shell
  // syntax — the two shapes themselves are covered by the pure adapter tests.
  const m = /(?:< "([^"]+)"$|Get-Content -Raw -Encoding UTF8 "([^"]+)" \|)/.exec(cmd)!;
  const file = (m[1] ?? m[2])!;
  expect(readFileSync(file, "utf-8")).toBe(composeStdinPrompt("SYS", "QUESTION"));
});

test("distinct kinds write distinct context files (no clobbering)", async () => {
  const stateDir = tmp();
  const files: string[] = [];
  for (const kind of ["help", "digest"] as const) {
    await runUtilityInference(
      {
        stateDir,
        shell: "",
        cwd: "/",
        run: async (cmd) => (files.push(/--append-system-prompt-file "([^"]+)"/.exec(cmd)![1]!), "x")
      },
      { target: { cli: "claude", model: "" }, system: kind, prompt: "q", kind }
    );
  }
  expect(files[0]).not.toBe(files[1]);
});

test("local target: HTTP with the provider's endpoint and decrypted key", async () => {
  const calls: unknown[] = [];
  const out = await runUtilityInference(
    {
      stateDir: tmp(),
      shell: "",
      cwd: "/",
      localProviders: [{ id: "oll", name: "Ollama", baseUrl: "http://h", apiKey: "k" }],
      http: async (input) => (calls.push(input), "local answer")
    },
    {
      target: { cli: "local", model: "qwen3:32b", providerId: "oll" },
      system: "SYS",
      prompt: "QUESTION",
      kind: "help"
    }
  );
  expect(out).toBe("local answer");
  expect(calls[0]).toEqual({
    baseUrl: "http://h",
    apiKey: "k",
    model: "qwen3:32b",
    system: "SYS",
    prompt: "QUESTION"
  });
});

test("local target with an unknown provider rejects with a readable error", async () => {
  await expect(
    runUtilityInference(
      { stateDir: tmp(), shell: "", cwd: "/", localProviders: [] },
      { target: { cli: "local", model: "m", providerId: "ghost" }, system: "s", prompt: "p", kind: "help" }
    )
  ).rejects.toThrow("unknown local provider ghost");
});

// ----- target helpers (shared/models, lot A) -----

test("targetKey maps frontier CLIs to their provider ids, locals to their config id", () => {
  expect(targetKey({ cli: "claude", model: "haiku" })).toBe("anthropic:haiku");
  expect(targetKey({ cli: "codex", model: "gpt-5.1" })).toBe("openai:gpt-5.1");
  expect(targetKey({ cli: "gemini", model: "" })).toBe("gemini:");
  expect(targetKey({ cli: "local", model: "qwen3:32b", providerId: "oll" })).toBe("oll:qwen3:32b");
});

test("targetLabel is compact and marks the CLI-default model", () => {
  expect(targetLabel({ cli: "claude", model: "haiku" })).toBe("claude · haiku");
  expect(targetLabel({ cli: "codex", model: "" })).toBe("codex (default)");
  expect(targetLabel({ cli: "local", model: "m", providerId: "oll" })).toBe("oll · m");
});

test("sanitizeTarget: valid targets pass, malformed ones fall back", () => {
  expect(sanitizeTarget({ cli: "codex", model: "gpt-5.1" }, DEFAULT_HELP_TARGET)).toEqual({
    cli: "codex",
    model: "gpt-5.1"
  });
  expect(
    sanitizeTarget({ cli: "local", model: "m", providerId: "oll" }, DEFAULT_HELP_TARGET)
  ).toEqual({ cli: "local", model: "m", providerId: "oll" });
  for (const bad of [null, 42, "haiku", { cli: "gpt", model: "x" }, { cli: "claude" }, { cli: "local", model: "m" }]) {
    expect(sanitizeTarget(bad, DEFAULT_WAND_TARGET)).toEqual(DEFAULT_WAND_TARGET);
  }
  // The fallback is copied, never aliased (callers mutate config objects).
  expect(sanitizeTarget(null, DEFAULT_HELP_TARGET)).not.toBe(DEFAULT_HELP_TARGET);
});

test("legacyHelpTarget maps the pre-lot-A helpModel string, else null", () => {
  expect(legacyHelpTarget("sonnet")).toEqual({ cli: "claude", model: "sonnet" });
  expect(legacyHelpTarget("  ")).toBeNull();
  expect(legacyHelpTarget(undefined)).toBeNull();
});
