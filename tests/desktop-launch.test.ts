import { test, expect, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// All three modules are pure (no node-pty / electron), so they import under bun.
import {
  resolveLaunchConfig,
  DEFAULT_LAUNCH_COMMAND,
  DEFAULT_MODELS,
  localConfigPath
} from "../desktop/src/main/launch-config.ts";
import { buildSessionCommandLine, quotePromptArg } from "../desktop/src/main/session-command.ts";
import { buildShellInvocation } from "../desktop/src/main/shell-command.ts";

const tmpDirs: string[] = [];
function tmpProject(): string {
  const d = mkdtempSync(join(tmpdir(), "launch-test-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

function writeLocalConfig(projectDir: string, obj: unknown): void {
  const file = localConfigPath(projectDir);
  mkdirSync(join(projectDir, ".claude", "claude-peers"), { recursive: true });
  writeFileSync(file, typeof obj === "string" ? obj : JSON.stringify(obj), "utf-8");
}

// Point the global config at an (empty) temp dir so the developer's real global
// config can't leak into the assertions.
function emptyGlobalEnv(): NodeJS.ProcessEnv {
  const g = tmpProject();
  return { APPDATA: g, XDG_CONFIG_HOME: g } as NodeJS.ProcessEnv;
}

// ----- launch-config -----

test("defaults when no config files exist", () => {
  const cfg = resolveLaunchConfig(tmpProject(), emptyGlobalEnv());
  expect(cfg.launchCommand).toBe(DEFAULT_LAUNCH_COMMAND);
  expect(cfg.presets).toEqual([]);
});

test("project-local config overrides the default", () => {
  const proj = tmpProject();
  writeLocalConfig(proj, {
    launchCommand: "claude custom",
    presets: [{ label: "Reviewer", args: "--agent reviewer" }]
  });
  const cfg = resolveLaunchConfig(proj, emptyGlobalEnv());
  expect(cfg.launchCommand).toBe("claude custom");
  expect(cfg.presets).toHaveLength(1);
  expect(cfg.presets[0]).toEqual({ label: "Reviewer", args: "--agent reviewer" });
});

test("project-local wins over global", () => {
  const g = tmpProject();
  mkdirSync(join(g, "claude-peers-desk"), { recursive: true });
  writeFileSync(
    join(g, "claude-peers-desk", "config.json"),
    JSON.stringify({ launchCommand: "global-cmd" }),
    "utf-8"
  );
  const proj = tmpProject();
  writeLocalConfig(proj, { launchCommand: "local-cmd" });
  const env = { APPDATA: g, XDG_CONFIG_HOME: g } as NodeJS.ProcessEnv;
  expect(resolveLaunchConfig(proj, env).launchCommand).toBe("local-cmd");
});

test("malformed JSON is ignored (falls back to default)", () => {
  const proj = tmpProject();
  writeLocalConfig(proj, "{ this is not json ");
  expect(resolveLaunchConfig(proj, emptyGlobalEnv()).launchCommand).toBe(DEFAULT_LAUNCH_COMMAND);
});

test("models default to DEFAULT_MODELS, a local non-empty list overrides", () => {
  const proj = tmpProject();
  // No file -> built-in default model list.
  expect(resolveLaunchConfig(proj, emptyGlobalEnv()).models).toEqual(DEFAULT_MODELS);
  // A local list (with one malformed entry) overrides, keeping only valid models.
  writeLocalConfig(proj, {
    models: [{ id: "opus-x", label: "Opus X" }, { label: "no id" }, { id: "", label: "blank" }]
  });
  expect(resolveLaunchConfig(proj, emptyGlobalEnv()).models).toEqual([{ id: "opus-x", label: "Opus X" }]);
});

test("an empty local models list falls back to the default (not blank)", () => {
  const proj = tmpProject();
  writeLocalConfig(proj, { models: [] });
  expect(resolveLaunchConfig(proj, emptyGlobalEnv()).models).toEqual(DEFAULT_MODELS);
});

test("invalid presets are filtered out", () => {
  const proj = tmpProject();
  writeLocalConfig(proj, {
    presets: [{ label: "ok", args: "" }, { label: 42 }, { nope: true }]
  });
  const cfg = resolveLaunchConfig(proj, emptyGlobalEnv());
  expect(cfg.presets).toEqual([{ label: "ok", args: "" }]);
});

// ----- session-command -----

test("fresh launch appends --session-id then args", () => {
  const line = buildSessionCommandLine({
    baseCommand: "claude run",
    sessionId: "id-new",
    args: "--agent reviewer",
    mode: "fresh"
  });
  expect(line).toBe("claude run --session-id id-new --agent reviewer");
});

test("fresh launch without args", () => {
  const line = buildSessionCommandLine({ baseCommand: "claude run", sessionId: "id-1", mode: "fresh" });
  expect(line).toBe("claude run --session-id id-1");
});

test("resume forks prev into new id and never re-passes args/agent/model", () => {
  const line = buildSessionCommandLine({
    baseCommand: "claude run",
    sessionId: "id-new",
    prevSessionId: "id-old",
    args: "--agent reviewer --model opus",
    mode: "resume"
  });
  expect(line).toBe("claude run --resume id-old --fork-session --session-id id-new");
  expect(line).not.toContain("--agent");
  expect(line).not.toContain("--model");
});

test("resume without a prevSessionId degrades to a fresh launch", () => {
  const line = buildSessionCommandLine({ baseCommand: "claude run", sessionId: "id-1", mode: "resume" });
  expect(line).toBe("claude run --session-id id-1");
});

test("fresh launch appends --effort last when an effort level is set", () => {
  const line = buildSessionCommandLine({
    baseCommand: "claude run",
    sessionId: "id-1",
    args: "--agent reviewer",
    effort: "high",
    mode: "fresh"
  });
  expect(line).toBe("claude run --session-id id-1 --agent reviewer --effort high");
});

test("resume re-passes --effort (not auto-restored) after the fork", () => {
  const line = buildSessionCommandLine({
    baseCommand: "claude run",
    sessionId: "id-new",
    prevSessionId: "id-old",
    effort: "xhigh",
    mode: "resume"
  });
  expect(line).toBe("claude run --resume id-old --fork-session --session-id id-new --effort xhigh");
});

test("an empty/whitespace effort never emits the flag (Auto position)", () => {
  const fresh = buildSessionCommandLine({ baseCommand: "claude run", sessionId: "id-1", effort: "  ", mode: "fresh" });
  expect(fresh).toBe("claude run --session-id id-1");
  const resume = buildSessionCommandLine({
    baseCommand: "claude run",
    sessionId: "id-new",
    prevSessionId: "id-old",
    effort: "",
    mode: "resume"
  });
  expect(resume).toBe("claude run --resume id-old --fork-session --session-id id-new");
});

test("fresh launch inserts --plugin-dir right after the base command", () => {
  const line = buildSessionCommandLine({
    baseCommand: "claude run",
    sessionId: "id-1",
    args: "--agent reviewer",
    pluginDir: "C:/res/deck-plugin",
    effort: "high",
    mode: "fresh"
  });
  expect(line).toBe('claude run --plugin-dir "C:/res/deck-plugin" --session-id id-1 --agent reviewer --effort high');
});

test("resume inserts --plugin-dir before --resume", () => {
  const line = buildSessionCommandLine({
    baseCommand: "claude run",
    sessionId: "id-new",
    prevSessionId: "id-old",
    pluginDir: "/opt/deck-plugin",
    mode: "resume"
  });
  expect(line).toBe('claude run --plugin-dir "/opt/deck-plugin" --resume id-old --fork-session --session-id id-new');
});

test("an empty/whitespace pluginDir never emits the flag", () => {
  const fresh = buildSessionCommandLine({ baseCommand: "claude run", sessionId: "id-1", pluginDir: "  ", mode: "fresh" });
  expect(fresh).toBe("claude run --session-id id-1");
  const none = buildSessionCommandLine({ baseCommand: "claude run", sessionId: "id-1", mode: "fresh" });
  expect(none).toBe("claude run --session-id id-1");
});

// ----- initial prompt (PLAN C2) -----

test("fresh launch appends the quoted prompt last (after args and --effort)", () => {
  const line = buildSessionCommandLine({
    baseCommand: "claude run",
    sessionId: "id-1",
    args: "--agent dev",
    effort: "high",
    prompt: "Read PLAN-v0.4.md and start C2",
    platform: "linux",
    mode: "fresh"
  });
  expect(line).toBe(
    "claude run --session-id id-1 --agent dev --effort high 'Read PLAN-v0.4.md and start C2'"
  );
});

test("posix prompt quoting is inert: apostrophes, $, backticks, newlines", () => {
  expect(quotePromptArg("l'item #12: fix `foo` for $USER\nthen report", "linux")).toBe(
    "'l'\\''item #12: fix `foo` for $USER\nthen report'"
  );
});

test("win32 prompt quoting doubles embedded single quotes (PowerShell)", () => {
  expect(quotePromptArg("l'item '12'", "win32")).toBe("'l''item ''12'''");
});

test("resume never re-plays the prompt (--resume restores the conversation)", () => {
  const line = buildSessionCommandLine({
    baseCommand: "claude run",
    sessionId: "id-new",
    prevSessionId: "id-old",
    prompt: "should not appear",
    platform: "linux",
    mode: "resume"
  });
  expect(line).toBe("claude run --resume id-old --fork-session --session-id id-new");
});

test("an empty/whitespace prompt never emits a positional arg", () => {
  const line = buildSessionCommandLine({
    baseCommand: "claude run",
    sessionId: "id-1",
    prompt: "   ",
    platform: "linux",
    mode: "fresh"
  });
  expect(line).toBe("claude run --session-id id-1");
});

// ----- shell-command -----

test("non-interactive unix uses a login shell, no -i, no marker", () => {
  const inv = buildShellInvocation({ command: "claude x", shell: "/bin/bash", interactive: false }, "linux");
  expect(inv.file).toBe("/bin/bash");
  expect(inv.args).toEqual(["-l", "-c", "claude x"]);
  expect(inv.args).not.toContain("-i");
  expect(inv.marker).toBeNull();
});

test("interactive unix adds -i and prepends a start marker", () => {
  const inv = buildShellInvocation({ command: "claude x", shell: "/bin/zsh", interactive: true }, "linux");
  expect(inv.args.slice(0, 3)).toEqual(["-l", "-i", "-c"]);
  expect(inv.marker).toBeTruthy();
  expect(inv.args[3]).toContain(inv.marker as string);
  expect(inv.args[3]).toContain("claude x");
});

test("windows non-interactive uses -NoProfile, interactive loads the profile", () => {
  const off = buildShellInvocation({ command: "claude x", shell: "", interactive: false }, "win32");
  expect(off.file).toBe("powershell.exe");
  expect(off.args).toContain("-NoProfile");
  expect(off.marker).toBeNull();

  const on = buildShellInvocation({ command: "claude x", shell: "", interactive: true }, "win32");
  expect(on.args).not.toContain("-NoProfile");
  expect(on.marker).toBeTruthy();
  expect(on.args[on.args.length - 1]).toContain(on.marker as string);
});
