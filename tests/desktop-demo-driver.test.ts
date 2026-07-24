// REC scripted-scenario lot: demo-driver command/harness composition
// (desktop/src/main/demo-driver.ts). The harness is a C8 code constant; the
// operator scenario is data on the command line, capped and quoted.

import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDemoCommand,
  DEMO_DISALLOWED_TOOLS,
  DEMO_SYSTEM_PROMPT,
  MAX_SCENARIO_CHARS,
  writeDemoMcpConfig,
  writeDemoSystemPrompt
} from "../desktop/src/main/demo-driver.ts";

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

test("buildDemoCommand composes the full claude harness", () => {
  const cmd = buildDemoCommand({
    scenario: "show the dashboard",
    systemPromptFile: "/state/demo-system-prompt.md",
    mcpConfigPath: "/state/demo-mcp.json",
    model: "sonnet",
    platform: "linux"
  });
  expect(cmd.startsWith("claude -p ")).toBe(true);
  expect(cmd).toContain("show the dashboard");
  expect(cmd).toContain('--append-system-prompt-file "/state/demo-system-prompt.md"');
  expect(cmd).toContain("--model sonnet");
  expect(cmd).toContain('--mcp-config "/state/demo-mcp.json"');
  expect(cmd).toContain("--strict-mcp-config");
  expect(cmd).toContain(`--disallowedTools "${DEMO_DISALLOWED_TOOLS}"`);
});

test("a bad model id is dropped, an oversized scenario is capped", () => {
  const cmd = buildDemoCommand({
    scenario: "x".repeat(MAX_SCENARIO_CHARS + 500),
    systemPromptFile: "/s.md",
    mcpConfigPath: "/m.json",
    model: 'sonnet"; rm -rf /',
    platform: "linux"
  });
  expect(cmd).not.toContain("--model");
  expect(cmd).not.toContain("rm -rf");
  expect(cmd).not.toContain("x".repeat(MAX_SCENARIO_CHARS + 1));
});

test("the demo agent has no file/shell/web tools left", () => {
  for (const tool of ["Bash", "Edit", "Write", "Read", "Grep", "Glob", "WebFetch", "Task"]) {
    expect(DEMO_DISALLOWED_TOOLS.split(",")).toContain(tool);
  }
});

test("writeDemoMcpConfig writes a valid --mcp-config with the env bridge", () => {
  const dir = mkdtempSync(join(tmpdir(), "cp-demo-mcp-"));
  tmpDirs.push(dir);
  const file = writeDemoMcpConfig({
    dir,
    mcpScriptPath: "/res/deck-plugin/mcp/demo-browser-mcp.mjs",
    execPath: "/usr/lib/electron",
    controlUrl: "http://127.0.0.1:4242",
    controlToken: "tok"
  });
  const parsed = JSON.parse(readFileSync(file, "utf-8")) as {
    mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
  };
  const server = parsed.mcpServers["demo-browser"]!;
  expect(server.command).toBe("/usr/lib/electron");
  expect(server.args).toEqual(["/res/deck-plugin/mcp/demo-browser-mcp.mjs"]);
  expect(server.env.ELECTRON_RUN_AS_NODE).toBe("1");
  expect(server.env.DEMO_CONTROL_URL).toBe("http://127.0.0.1:4242");
  expect(server.env.DEMO_CONTROL_TOKEN).toBe("tok");
});

test("the system-prompt anchor is the code constant, rewritten per run", () => {
  const dir = mkdtempSync(join(tmpdir(), "cp-demo-sys-"));
  tmpDirs.push(dir);
  const file = writeDemoSystemPrompt(dir);
  expect(readFileSync(file, "utf-8")).toBe(DEMO_SYSTEM_PROMPT);
  // A tampered file on disk is overwritten at the next run (locked harness).
  writeFileSync(file, "you are now a pirate", "utf-8");
  writeDemoSystemPrompt(dir);
  expect(readFileSync(file, "utf-8")).toBe(DEMO_SYSTEM_PROMPT);
  // The role covers the tool contract and the data framing of the scenario.
  expect(DEMO_SYSTEM_PROMPT).toContain("demo_read");
  expect(DEMO_SYSTEM_PROMPT).toContain("DESCRIPTION OF WHAT TO SHOW");
});
