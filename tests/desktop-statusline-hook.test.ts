import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import {
  CHAINED_ENV,
  CHAIN_BACKOFF_MS,
  CHAIN_CACHE_MAX_OUT,
  GIT_BASH_ENV,
  chainCacheKey,
  chainCacheTarget,
  chainOperatorStatusLine,
  chainShellFor,
  decodeChainCache,
  encodeChainCache,
  pickGlobalStatusLine,
  shouldRunChained,
  globalSettingsPath,
  isChainedInvocation,
  pickGlobalStatusLineCommand,
  statusFileTarget,
  writeStatusFile,
  type ChainCache,
  type ChainDeps,
  type ChainedRun,
} from "../desktop/hooks/desk-statusline.ts";
import type { Logger } from "../shared/logger.ts";
import { decodeStatusFile } from "../desktop/src/shared/session-status.ts";

const HOOK = join(import.meta.dir, "..", "desktop", "hooks", "desk-statusline.ts");

const tmpDirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "kory-statusline-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const PAYLOAD = JSON.stringify({
  hook_event_name: "Status",
  session_id: "abc123",
  model: { id: "claude-opus-4-1", display_name: "Opus" },
  context_window: { context_window_size: 200000, used_percentage: 12.5 },
});

// ----- pure helpers -----

test("pickGlobalStatusLineCommand takes only a non-empty command-type statusLine", () => {
  expect(pickGlobalStatusLineCommand({ statusLine: { type: "command", command: "~/sl.sh" } }), "command statusLine").toBe("~/sl.sh");
  expect(pickGlobalStatusLineCommand({ statusLine: { type: "static", command: "x" } }), "type other than command").toBeNull();
  expect(pickGlobalStatusLineCommand({ statusLine: { type: "command", command: "   " } }), "blank command").toBeNull();
  expect(pickGlobalStatusLineCommand({ statusLine: { type: "command", command: 42 } }), "non-string command").toBeNull();
  expect(pickGlobalStatusLineCommand({ statusLine: { type: "command" } }), "missing command").toBeNull();
  expect(pickGlobalStatusLineCommand({ statusLine: "echo" }), "non-object statusLine").toBeNull();
  expect(pickGlobalStatusLineCommand({}), "no statusLine").toBeNull();
  expect(pickGlobalStatusLineCommand(null), "null settings").toBeNull();
  expect(pickGlobalStatusLineCommand("x"), "string settings").toBeNull();
});

test("recursion guard reads the chained marker", () => {
  expect(isChainedInvocation({ [CHAINED_ENV]: "1" }), "chained child is a no-op").toBe(true);
  expect(isChainedInvocation({}), "top-level run proceeds").toBe(false);
});

test("global settings path honors CLAUDE_CONFIG_DIR, else ~/.claude", () => {
  expect(globalSettingsPath({ CLAUDE_CONFIG_DIR: "/cfg" }, "/home/u"), "relocated config dir").toBe(join("/cfg", "settings.json"));
  expect(globalSettingsPath({}, "/home/u"), "default config dir").toBe(join("/home/u", ".claude", "settings.json"));
});

test("statusFileTarget sanitizes the token and refuses an empty one", () => {
  expect(statusFileTarget("a/../b", "/h"), "token cannot traverse").toBe(join("/h", ".claude", "peers", "desk-status-a____b.json"));
  expect(statusFileTarget("", "/h"), "no token, no file").toBeNull();
  expect(statusFileTarget(undefined, "/h"), "undefined token, no file").toBeNull();
});

// ----- end-to-end on the real script -----

interface Run {
  stdout: string;
  exitCode: number;
}

async function runHook(home: string, env: Record<string, string>, stdin: string): Promise<Run> {
  const proc = Bun.spawn(["bun", HOOK], {
    stdin: new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? "",
      SYSTEMROOT: process.env.SYSTEMROOT ?? "",
      HOME: home,
      USERPROFILE: home,
      CLAUDE_CONFIG_DIR: join(home, "cfg"),
      CLAUDE_PEERS_LOG_DIR: join(home, "logs"),
      ...env,
    },
  });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { stdout, exitCode };
}

test("real script: writes the status file for a Deck tile and prints nothing without an operator statusLine", async () => {
  const home = tmpDir();
  const res = await runHook(home, { CLAUDE_PEERS_DESK_SESSION: "tile-1" }, PAYLOAD);
  expect(res.exitCode, "exits 0").toBe(0);
  expect(res.stdout, "empty status line when the operator has none").toBe("");
  const written = join(home, ".claude", "peers", "desk-status-tile-1.json");
  expect(existsSync(written), "status file written under ~/.claude/peers").toBe(true);
  expect(decodeStatusFile(readFileSync(written, "utf-8")), "written file decodes main-side").toMatchObject({
    model: "Opus",
    modelId: "claude-opus-4-1",
    contextPct: 12.5,
    contextWindow: 200000,
  });
}, 20000);

test("real script: a UTF-8 BOM in the operator's settings.json does not stop the chaining", async () => {
  const home = tmpDir();
  mkdirSync(join(home, "cfg"), { recursive: true });
  writeFileSync(join(home, "cfg", "settings.json"), "\uFEFF" + JSON.stringify({ statusLine: { type: "command", command: "echo bom-line" } }));
  const res = await runHook(home, {}, PAYLOAD);
  expect(res.stdout.trim(), "a BOM-prefixed global settings.json is still read").toBe("bom-line");
}, 20000);

test("real script: no token, no file; still chains the operator statusLine", async () => {
  const home = tmpDir();
  mkdirSync(join(home, "cfg"), { recursive: true });
  writeFileSync(join(home, "cfg", "settings.json"), JSON.stringify({ statusLine: { type: "command", command: "echo operator-line" } }));
  const res = await runHook(home, {}, PAYLOAD);
  expect(res.stdout.trim(), "operator's stdout is printed").toBe("operator-line");
  expect(existsSync(join(home, ".claude", "peers")), "no Deck token: nothing written").toBe(false);
}, 20000);

test.skipIf(process.platform === "win32")("real script: the chained command receives the same stdin and the chained marker", async () => {
  const home = tmpDir();
  mkdirSync(join(home, "cfg"), { recursive: true });
  writeFileSync(
    join(home, "cfg", "settings.json"),
    JSON.stringify({ statusLine: { type: "command", command: `cat; printf "|%s" "$${CHAINED_ENV}"` } }),
  );
  const res = await runHook(home, { CLAUDE_PEERS_DESK_SESSION: "tile-2" }, PAYLOAD);
  expect(res.stdout, "stdin forwarded unchanged, marker set for the child").toBe(`${PAYLOAD}|1`);
}, 20000);

test("real script: a chained invocation does nothing (recursion guard)", async () => {
  const home = tmpDir();
  mkdirSync(join(home, "cfg"), { recursive: true });
  writeFileSync(join(home, "cfg", "settings.json"), JSON.stringify({ statusLine: { type: "command", command: "echo loop" } }));
  const res = await runHook(home, { CLAUDE_PEERS_DESK_SESSION: "tile-3", [CHAINED_ENV]: "1" }, PAYLOAD);
  expect(res.exitCode, "exits 0").toBe(0);
  expect(res.stdout, "chained run prints nothing").toBe("");
  expect(existsSync(join(home, ".claude", "peers")), "chained run writes nothing").toBe(false);
}, 20000);

test("real script: malformed payload writes nothing and does not fail", async () => {
  const home = tmpDir();
  const res = await runHook(home, { CLAUDE_PEERS_DESK_SESSION: "tile-4" }, "{not json");
  expect(res.exitCode, "exits 0").toBe(0);
  expect(res.stdout, "nothing printed").toBe("");
  expect(existsSync(join(home, ".claude", "peers", "desk-status-tile-4.json")), "no file for a bad payload").toBe(false);
}, 20000);

test("real script: project-level statusLine in the cwd is never executed", async () => {
  const home = tmpDir();
  const repo = tmpDir();
  mkdirSync(join(repo, ".claude"), { recursive: true });
  writeFileSync(join(repo, ".claude", "settings.json"), JSON.stringify({ statusLine: { type: "command", command: "echo pwned" } }));
  writeFileSync(join(repo, ".claude", "settings.local.json"), JSON.stringify({ statusLine: { type: "command", command: "echo pwned" } }));
  const proc = Bun.spawn(["bun", HOOK], {
    cwd: repo,
    stdin: new Blob([PAYLOAD]),
    stdout: "pipe",
    env: { PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, "cfg"), CLAUDE_PEERS_LOG_DIR: join(home, "logs") },
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  expect(stdout.includes("pwned"), "cloned-repo statusLine not chained").toBe(false);
}, 20000);

test("writeStatusFile removes its temp file when the rename fails", () => {
  const dir = tmpDir();
  const target = join(dir, "desk-status-t.json");
  // A non-empty directory at the target makes the rename fail on every platform.
  mkdirSync(join(target, "occupied"), { recursive: true });
  expect(() => writeStatusFile(target, "{}"), "the rename failure reaches the caller's log").toThrow();
  expect(readdirSync(dir).filter((f) => f.endsWith(".tmp")), "no temp file left behind").toEqual([]);
});

function operatorSettings(home: string, command: string): void {
  mkdirSync(join(home, "cfg"), { recursive: true });
  writeFileSync(join(home, "cfg", "settings.json"), JSON.stringify({ statusLine: { type: "command", command } }));
}

test("real script: a multibyte payload split across stdin chunks is decoded intact", async () => {
  const home = tmpDir();
  const big = JSON.stringify({
    model: { id: "claude-opus-4-1", display_name: "Opus" },
    cwd: "é€😀".repeat(40000),
    context_window: { used_percentage: 3, context_window_size: 200000 },
  });
  operatorSettings(home, process.platform === "win32" ? "more" : "cat");
  const res = await runHook(home, { CLAUDE_PEERS_DESK_SESSION: "tile-mb" }, big);
  expect(existsSync(join(home, ".claude", "peers", "desk-status-tile-mb.json")), "large multibyte payload still parsed").toBe(true);
  if (process.platform !== "win32") expect(res.stdout, "payload forwarded byte-exact to the operator command").toBe(big);
}, 20000);

test.skipIf(process.platform === "win32")("real script: large operator output is not truncated at exit", async () => {
  const home = tmpDir();
  operatorSettings(home, "head -c 300000 /dev/zero | tr '\\0' x");
  const res = await runHook(home, {}, PAYLOAD);
  expect(res.stdout.length, "every byte of the operator's stdout reaches the status bar").toBe(300000);
}, 20000);

test.skipIf(process.platform === "win32")("real script: a timed-out operator command is killed with its whole process group", async () => {
  const home = tmpDir();
  const pidFile = join(home, "sleep.pid");
  operatorSettings(home, `sleep 30 & echo $! > "${pidFile}"; wait`);
  const started = Date.now();
  const res = await runHook(home, {}, PAYLOAD);
  expect(res.exitCode, "exits 0 after the timeout").toBe(0);
  expect(Date.now() - started, "returns shortly after the chain timeout").toBeLessThan(10000);
  const pid = Number(readFileSync(pidFile, "utf-8").trim());
  // A killed orphan may linger as a zombie where PID 1 does not reap (containers): that counts as dead.
  const state = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf-8" }).stdout.trim();
  const alive = state !== "" && !state.startsWith("Z");
  if (alive) process.kill(pid, "SIGKILL");
  expect(alive, "the grandchild sleep is not left orphaned").toBe(false);
}, 20000);

// ----- which shell runs the operator's command -----

function existsIn(...paths: string[]): (p: string) => boolean {
  const set = new Set(paths.map((p) => p.toLowerCase()));
  return (p) => set.has(p.toLowerCase());
}

test("chainShellFor: POSIX runs the command through sh -c", () => {
  for (const plat of ["linux", "darwin"] as const) {
    expect(chainShellFor(plat, { [GIT_BASH_ENV]: "C:\\Git\\bin\\bash.exe" }, () => true, "echo hi"), `${plat} ignores Git Bash`).toEqual({
      file: "/bin/sh",
      args: ["-c", "echo hi"],
    });
  }
});

test("chainShellFor: win32 honours CLAUDE_CODE_GIT_BASH_PATH when the file exists", () => {
  const bash = "D:\\Tools\\Git\\bin\\bash.exe";
  expect(chainShellFor("win32", { [GIT_BASH_ENV]: bash }, existsIn(bash), "echo hi"), "configured Git Bash").toEqual({
    file: bash,
    args: ["-c", "echo hi"],
  });
  expect(
    chainShellFor("win32", { [GIT_BASH_ENV]: bash }, existsIn(), "echo hi").file,
    "a configured path that does not exist is not used",
  ).toBe("powershell.exe");
});

test("chainShellFor: win32 derives Git Bash from git.exe on PATH (cmd\\ and bin\\ layouts)", () => {
  const viaCmd = chainShellFor(
    "win32",
    { Path: "C:\\Windows\\System32;C:\\Program Files\\Git\\cmd" },
    existsIn("C:\\Program Files\\Git\\cmd\\git.exe", "C:\\Program Files\\Git\\bin\\bash.exe"),
    "echo hi",
  );
  expect(viaCmd, "<Git>\\cmd\\git.exe => <Git>\\bin\\bash.exe, PATH read case-insensitively").toEqual({
    file: "C:\\Program Files\\Git\\bin\\bash.exe",
    args: ["-c", "echo hi"],
  });
  const viaBin = chainShellFor(
    "win32",
    { PATH: '"E:\\Git\\bin"' },
    existsIn("E:\\Git\\bin\\git.exe", "E:\\Git\\bin\\bash.exe"),
    "x",
  );
  expect(viaBin.file, "<Git>\\bin\\git.exe, quoted PATH entry").toBe("E:\\Git\\bin\\bash.exe");
});

test("chainShellFor: win32 never picks the WSL bash.exe", () => {
  const wsl = "C:\\Windows\\System32\\bash.exe";
  const apps = "C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe";
  expect(chainShellFor("win32", { [GIT_BASH_ENV]: wsl }, existsIn(wsl), "x").file, "System32 bash via env is WSL").toBe(
    "powershell.exe",
  );
  expect(chainShellFor("win32", { [GIT_BASH_ENV]: apps }, existsIn(apps), "x").file, "WindowsApps bash is WSL").toBe(
    "powershell.exe",
  );
  // git.exe found in a System32-like dir must not derive the WSL launcher either.
  expect(
    chainShellFor("win32", { PATH: "C:\\Windows\\System32\\bin" }, existsIn("C:\\Windows\\System32\\bin\\git.exe", wsl), "x").file,
    "derived path under System32 refused",
  ).toBe("powershell.exe");
});

test("chainShellFor: win32 without Git Bash falls back to PowerShell", () => {
  expect(chainShellFor("win32", { PATH: "C:\\Windows\\System32" }, existsIn(), "echo hi"), "PowerShell fallback").toEqual({
    file: "powershell.exe",
    args: ["-NoProfile", "-NonInteractive", "-Command", "echo hi"],
  });
});

test.skipIf(process.platform === "win32")("real script: cancelling the hook (SIGTERM) kills the chained command's group", async () => {
  const home = tmpDir();
  const pidFile = join(home, "sleep.pid");
  operatorSettings(home, `echo $$ > "${pidFile}.tmp"; mv "${pidFile}.tmp" "${pidFile}"; exec sleep 30`);
  const proc = Bun.spawn(["bun", HOOK], {
    stdin: new Blob([PAYLOAD]),
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      CLAUDE_CONFIG_DIR: join(home, "cfg"),
      CLAUDE_PEERS_LOG_DIR: join(home, "logs"),
    },
  });
  const deadline = Date.now() + 3000;
  while (!existsSync(pidFile) && Date.now() < deadline) await Bun.sleep(20);
  expect(existsSync(pidFile), "the chained command started").toBe(true);
  const pid = Number(readFileSync(pidFile, "utf-8").trim());
  const killedAt = Date.now();
  proc.kill("SIGTERM");
  const code = await proc.exited;
  expect(Date.now() - killedAt, "the hook exits on the cancel, not at the chain timeout").toBeLessThan(2000);
  expect(code, "exit status reports the signal").toBe(143);
  await Bun.sleep(100);
  // A killed orphan may linger as a zombie where PID 1 does not reap (containers): that counts as dead.
  const state = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf-8" }).stdout.trim();
  const alive = state !== "" && !state.startsWith("Z");
  if (alive) process.kill(pid, "SIGKILL");
  expect(alive, "the chained sleep does not outlive the cancelled hook").toBe(false);
}, 20000);

test("chainShellFor: a git.exe outside cmd\\, bin\\ or a Scoop shims\\ dir derives nothing", () => {
  // C:\tools\git.exe would derive C:\bin\bash.exe without the leaf check.
  const shell = chainShellFor(
    "win32",
    { PATH: "C:\\tools" },
    existsIn("C:\\tools\\git.exe", "C:\\bin\\bash.exe"),
    "x",
  );
  expect(shell.file, "an arbitrary dir's parent is not taken for a Git install").toBe("powershell.exe");
});

test("chainShellFor: a Scoop shim git.exe resolves to Scoop's Git Bash", () => {
  const scoopBash = "C:\\Users\\u\\scoop\\apps\\git\\current\\bin\\bash.exe";
  const shell = chainShellFor(
    "win32",
    { PATH: "C:\\Users\\u\\scoop\\shims" },
    existsIn("C:\\Users\\u\\scoop\\shims\\git.exe", scoopBash),
    "x",
  );
  expect(shell, "<scoop>\\shims\\git.exe => <scoop>\\apps\\git\\current\\bin\\bash.exe").toEqual({ file: scoopBash, args: ["-c", "x"] });
  expect(
    chainShellFor("win32", { PATH: "C:\\Users\\u\\scoop\\shims" }, existsIn("C:\\Users\\u\\scoop\\shims\\git.exe"), "x").file,
    "Scoop shim without the git app installed: PowerShell",
  ).toBe("powershell.exe");
});

test("chainShellFor: an unusable CLAUDE_CODE_GIT_BASH_PATH is flagged for the log, a usable one is not", () => {
  const missing = "D:\\Nope\\bash.exe";
  const derived = "C:\\Program Files\\Git\\bin\\bash.exe";
  const shell = chainShellFor(
    "win32",
    { [GIT_BASH_ENV]: missing, PATH: "C:\\Program Files\\Git\\cmd" },
    existsIn("C:\\Program Files\\Git\\cmd\\git.exe", derived),
    "x",
  );
  expect(shell.ignoredGitBash, "missing configured path reported").toBe(missing);
  expect(shell.file, "falls through to the PATH-derived Git Bash").toBe(derived);
  expect(chainShellFor("win32", { [GIT_BASH_ENV]: missing }, existsIn(), "x").ignoredGitBash, "also with the PowerShell fallback").toBe(missing);
  expect(chainShellFor("win32", { [GIT_BASH_ENV]: derived }, existsIn(derived), "x").ignoredGitBash, "usable path not flagged").toBeUndefined();
  expect(chainShellFor("win32", {}, existsIn(), "x").ignoredGitBash, "unset: nothing to flag").toBeUndefined();
});

// ----- chained-output cache -----

test("pickGlobalStatusLine reads the operator's refreshInterval (seconds >= 1), else events only", () => {
  const sl = (refreshInterval: unknown) => pickGlobalStatusLine({ statusLine: { type: "command", command: "x", refreshInterval } });
  expect(sl(10)?.refreshMs, "10 s").toBe(10000);
  expect(sl(1)?.refreshMs, "documented minimum").toBe(1000);
  for (const bad of [undefined, 0, 0.5, -3, "10", Number.NaN, Number.POSITIVE_INFINITY, null]) {
    expect(sl(bad)?.refreshMs, `refreshInterval ${String(bad)} => none`).toBeNull();
  }
});

test("chainCacheKey ignores only the wall-clock cost counters", () => {
  const base = JSON.parse(PAYLOAD);
  const with_ = (patch: Record<string, unknown>) => JSON.stringify({ ...base, ...patch });
  const k = chainCacheKey("cmd", with_({ cost: { total_cost_usd: 1, total_duration_ms: 1000, total_api_duration_ms: 50 } }));
  expect(chainCacheKey("cmd", with_({ cost: { total_cost_usd: 1, total_duration_ms: 99000, total_api_duration_ms: 70 } })), "volatile-only change").toBe(k);
  expect(chainCacheKey("cmd", with_({ cost: { total_cost_usd: 2, total_duration_ms: 1000, total_api_duration_ms: 50 } })), "cost change").not.toBe(k);
  expect(chainCacheKey("cmd", with_({ model: { id: "claude-sonnet-4-5", display_name: "Sonnet" }, cost: { total_cost_usd: 1, total_duration_ms: 1000, total_api_duration_ms: 50 } })), "model change").not.toBe(k);
  expect(chainCacheKey("other", with_({ cost: { total_cost_usd: 1, total_duration_ms: 1000, total_api_duration_ms: 50 } })), "command change").not.toBe(k);
  expect(chainCacheKey("cmd", "{not json"), "non-JSON payload keyed on raw text").not.toBe(chainCacheKey("cmd", "{not json!"));
});

test("shouldRunChained: key change, operator refresh elapsed, clock moved back", () => {
  const cache: ChainCache = { key: "a".repeat(64), at: 10_000, state: "output", out: Buffer.from("x"), exitCode: 0, gitBashWarned: null };
  expect(shouldRunChained(null, cache.key, 10_000, null), "no cache").toBe(true);
  expect(shouldRunChained(cache, "b".repeat(64), 10_001, null), "key changed").toBe(true);
  expect(shouldRunChained(cache, cache.key, 10_000_000, null), "no operator refresh: served forever while the key holds").toBe(false);
  expect(shouldRunChained(cache, cache.key, 14_999, 5000), "refresh not yet elapsed").toBe(false);
  expect(shouldRunChained(cache, cache.key, 15_000, 5000), "refresh elapsed").toBe(true);
  expect(shouldRunChained(cache, cache.key, 9_999, null), "cache from the future").toBe(true);
  expect(shouldRunChained(cache, cache.key, Number.NaN, null), "NaN clock").toBe(true);
  expect(shouldRunChained({ ...cache, exitCode: 1 }, cache.key, 10_001, null), "non-zero exit served like any output").toBe(false);
});

test("shouldRunChained: a backoff entry holds any payload until it elapses; a marker entry always runs", () => {
  const backoff: ChainCache = { key: "a".repeat(64), at: 10_000, state: "backoff", out: Buffer.alloc(0), exitCode: null, gitBashWarned: null };
  expect(shouldRunChained(backoff, backoff.key, 10_000 + CHAIN_BACKOFF_MS - 1, null), "inside the backoff").toBe(false);
  expect(shouldRunChained(backoff, "b".repeat(64), 10_001, 1000), "inside the backoff, other payload and refresh elapsed").toBe(false);
  expect(shouldRunChained(backoff, backoff.key, 10_000 + CHAIN_BACKOFF_MS, null), "backoff elapsed").toBe(true);
  expect(shouldRunChained(backoff, backoff.key, 9_999, null), "backoff from the future").toBe(true);
  expect(shouldRunChained(backoff, backoff.key, Number.NaN, null), "NaN clock in backoff").toBe(true);
  expect(shouldRunChained({ ...backoff, state: "marker" }, backoff.key, 10_001, null), "marker only").toBe(true);
});

test("decodeChainCache: round-trip, and every off-shape file refused", () => {
  const good: ChainCache = { key: "c".repeat(64), at: 5, state: "output", out: Buffer.from("\u001b[31mline\u001b[0m"), exitCode: 1, gitBashWarned: null };
  expect(decodeChainCache(encodeChainCache(good)), "round-trip").toEqual(good);
  const backoff: ChainCache = { ...good, state: "backoff", out: Buffer.alloc(0), exitCode: null, gitBashWarned: "C:\\x\\bash.exe" };
  expect(decodeChainCache(encodeChainCache(backoff)), "backoff round-trip").toEqual(backoff);
  const env = JSON.parse(encodeChainCache(good));
  const bad: Record<string, unknown> = {
    "not JSON": "{",
    "array": "[]",
    "other version": JSON.stringify({ ...env, v: 2 }),
    "short key": JSON.stringify({ ...env, key: "c".repeat(63) }),
    "non-hex key": JSON.stringify({ ...env, key: "g".repeat(64) }),
    "NaN-ish at": JSON.stringify({ ...env, at: "5" }),
    "zero at": JSON.stringify({ ...env, at: 0 }),
    "non-base64 out": JSON.stringify({ ...env, out: "!!!!" }),
    "numeric out": JSON.stringify({ ...env, out: 3 }),
    "oversized out": JSON.stringify({ ...env, out: Buffer.alloc(CHAIN_CACHE_MAX_OUT + 1).toString("base64") }),
    "non-string warned": JSON.stringify({ ...env, gitBashWarned: 1 }),
    "unknown state": JSON.stringify({ ...env, state: "ok" }),
    "missing state": JSON.stringify({ ...env, state: undefined }),
    "backoff carrying output": JSON.stringify({ ...env, state: "backoff", exitCode: undefined }),
    "marker carrying an exit code": JSON.stringify({ ...env, state: "marker", out: "" }),
    "fractional exit code": JSON.stringify({ ...env, exitCode: 1.5 }),
    "string exit code": JSON.stringify({ ...env, exitCode: "1" }),
    "empty": "",
  };
  for (const [why, text] of Object.entries(bad)) {
    expect(decodeChainCache(text as string), `${why} refused`).toBeNull();
  }
});

test("chainCacheTarget sits next to the status file and needs a token", () => {
  expect(chainCacheTarget("a/b", "/h"), "sanitized token").toBe(join("/h", ".claude", "peers", "desk-statusline-cache-a_b.json"));
  expect(chainCacheTarget(undefined, "/h"), "no token, no cache").toBeNull();
});

function countingOperator(home: string, extra: Record<string, unknown> = {}): string {
  const counter = join(home, "runs.log");
  mkdirSync(join(home, "cfg"), { recursive: true });
  writeFileSync(
    join(home, "cfg", "settings.json"),
    JSON.stringify({ statusLine: { type: "command", command: `echo run >> "${counter}"; echo operator-line`, ...extra } }),
  );
  return counter;
}

function runs(counter: string): number {
  return existsSync(counter) ? readFileSync(counter, "utf-8").split("\n").filter(Boolean).length : 0;
}

function payloadWith(patch: Record<string, unknown>): string {
  return JSON.stringify({ ...JSON.parse(PAYLOAD), ...patch });
}

test.skipIf(process.platform === "win32")("real script: the operator command runs once per payload, cached output is served", async () => {
  const home = tmpDir();
  const counter = countingOperator(home);
  const env = { CLAUDE_PEERS_DESK_SESSION: "tile-c1" };
  const tick = (ms: number) => payloadWith({ cost: { total_cost_usd: 0.5, total_duration_ms: ms, total_api_duration_ms: 20 } });

  const first = await runHook(home, env, tick(1000));
  const second = await runHook(home, env, tick(1000));
  expect(runs(counter), "same payload twice: one execution").toBe(1);
  expect(first.stdout.trim(), "first run prints the operator's line").toBe("operator-line");
  expect(second.stdout, "second run serves the cached output byte-exact").toBe(first.stdout);

  await runHook(home, env, tick(6000));
  expect(runs(counter), "volatile-only change (duration counters): no re-run").toBe(1);

  const other = await runHook(home, env, payloadWith({ model: { id: "claude-sonnet-4-5", display_name: "Sonnet" }, cost: { total_cost_usd: 0.5, total_duration_ms: 6000, total_api_duration_ms: 20 } }));
  expect(runs(counter), "model changed: re-run").toBe(2);
  expect(other.stdout.trim(), "fresh output printed").toBe("operator-line");
}, 30000);

test.skipIf(process.platform === "win32")("real script: the operator's refreshInterval re-runs the command once elapsed", async () => {
  const home = tmpDir();
  const counter = countingOperator(home, { refreshInterval: 1 });
  const env = { CLAUDE_PEERS_DESK_SESSION: "tile-c2" };
  await runHook(home, env, PAYLOAD);
  await runHook(home, env, PAYLOAD);
  expect(runs(counter), "inside the operator's interval: served from cache").toBe(1);
  await Bun.sleep(1100);
  await runHook(home, env, PAYLOAD);
  expect(runs(counter), "operator interval elapsed: re-run").toBe(2);
}, 30000);

test.skipIf(process.platform === "win32")("real script: a corrupt or planted cache file is refused and the command re-runs", async () => {
  const home = tmpDir();
  const counter = countingOperator(home);
  const env = { CLAUDE_PEERS_DESK_SESSION: "tile-c3" };
  await runHook(home, env, PAYLOAD);
  const cache = join(home, ".claude", "peers", "desk-statusline-cache-tile-c3.json");
  expect(existsSync(cache), "cache written after a clean run").toBe(true);

  writeFileSync(cache, "{corrupt");
  const res = await runHook(home, env, PAYLOAD);
  expect(runs(counter), "corrupt cache: re-run").toBe(2);
  expect(res.stdout.trim(), "fresh output, not the corrupt bytes").toBe("operator-line");

  const env0 = JSON.parse(readFileSync(cache, "utf-8"));
  writeFileSync(cache, JSON.stringify({ ...env0, out: Buffer.alloc(CHAIN_CACHE_MAX_OUT + 1, 0x78).toString("base64") }));
  await runHook(home, env, PAYLOAD);
  expect(runs(counter), "oversized cached output: re-run").toBe(3);
}, 30000);

test.skipIf(process.platform === "win32")("real script: a command that prints then exits non-zero is cached like any other", async () => {
  const home = tmpDir();
  const counter = join(home, "runs.log");
  operatorSettings(home, `echo run >> "${counter}"; echo x; false`);
  const env = { CLAUDE_PEERS_DESK_SESSION: "tile-c4" };
  const outs: string[] = [];
  for (let i = 0; i < 3; i++) outs.push((await runHook(home, env, PAYLOAD)).stdout);
  expect(runs(counter), "three identical payloads: one execution").toBe(1);
  expect(outs.map((o) => o.trim()), "its output is shown every time").toEqual(["x", "x", "x"]);
}, 30000);

// ----- chained run policy, injected runner -----

function memLog(): Logger & { warns: string[] } {
  const warns: string[] = [];
  const log = {
    warns,
    info: () => {},
    warn: (m: string) => {
      warns.push(m);
    },
    error: (m: string) => {
      warns.push(m);
    },
    child: () => log,
    file: "",
  };
  return log;
}

function fakeDeps(home: string, results: ChainedRun[], extra: Partial<ChainDeps> = {}): ChainDeps & { calls: () => number; printed: string[] } {
  let calls = 0;
  const printed: string[] = [];
  return {
    platform: "linux",
    env: { CLAUDE_PEERS_DESK_SESSION: "tile-f" },
    home,
    now: () => 1_000_000,
    exists: () => false,
    run: async () => results[Math.min(calls++, results.length - 1)]!,
    write: (b) => {
      printed.push(b.toString("utf-8"));
    },
    ...extra,
    calls: () => calls,
    printed,
  };
}

const OP = { command: "op", refreshMs: null };

test("chainOperatorStatusLine: a timed-out command is not relaunched within the backoff, whatever the payload", async () => {
  const home = tmpDir();
  let t = 1_000_000;
  const deps = fakeDeps(home, [{ out: Buffer.from("partial"), exitCode: null }], { now: () => t });
  const log = memLog();
  await chainOperatorStatusLine(OP, PAYLOAD, log, deps);
  expect(deps.calls(), "first tick runs").toBe(1);
  expect(deps.printed, "partial output of the killed run still printed").toEqual(["partial"]);
  for (const dt of [5000, 10_000, CHAIN_BACKOFF_MS - 1]) {
    t = 1_000_000 + dt;
    await chainOperatorStatusLine(OP, payloadWith({ session_id: `s${dt}` }), log, deps);
  }
  expect(deps.calls(), "no relaunch inside the backoff, even for a new payload").toBe(1);
  expect(deps.printed, "nothing served from a backoff entry").toEqual(["partial"]);
  t = 1_000_000 + CHAIN_BACKOFF_MS;
  await chainOperatorStatusLine(OP, PAYLOAD, log, deps);
  expect(deps.calls(), "retried once the backoff elapsed").toBe(2);
});

test("chainOperatorStatusLine: a spawn failure backs off like a timeout", async () => {
  const home = tmpDir();
  const deps = fakeDeps(home, [], {
    run: async () => {
      throw new Error("spawn EACCES");
    },
  });
  await chainOperatorStatusLine(OP, PAYLOAD, memLog(), deps);
  const cache = decodeChainCache(readFileSync(join(home, ".claude", "peers", "desk-statusline-cache-tile-f.json"), "utf-8"));
  expect(cache?.state, "backoff entry written after a thrown spawn").toBe("backoff");
});

test("chainOperatorStatusLine: the bad Git Bash path is logged once across failing, timed-out and oversized runs", async () => {
  const home = tmpDir();
  const bad = "C:\\nowhere\\bash.exe";
  let t = 1_000_000;
  const results: ChainedRun[] = [
    { out: Buffer.from("x"), exitCode: 1 },
    { out: Buffer.alloc(0), exitCode: null },
    { out: Buffer.alloc(CHAIN_CACHE_MAX_OUT + 1, 0x78), exitCode: 0 },
    { out: Buffer.alloc(CHAIN_CACHE_MAX_OUT + 1, 0x78), exitCode: 0 },
  ];
  const deps = fakeDeps(home, results, { platform: "win32", env: { CLAUDE_PEERS_DESK_SESSION: "tile-f", [GIT_BASH_ENV]: bad }, now: () => t });
  const log = memLog();
  const warned = () => log.warns.filter((w) => w.includes(bad)).length;
  await chainOperatorStatusLine(OP, PAYLOAD, log, deps);
  t += 1000;
  await chainOperatorStatusLine(OP, payloadWith({ session_id: "other" }), log, deps);
  t += CHAIN_BACKOFF_MS;
  await chainOperatorStatusLine(OP, PAYLOAD, log, deps);
  t += 1000;
  await chainOperatorStatusLine(OP, PAYLOAD, log, deps);
  expect(deps.calls(), "exit 1, then a new payload, then after the backoff, then marker-only: four runs").toBe(4);
  expect(warned(), "the unusable path is logged once").toBe(1);
});
