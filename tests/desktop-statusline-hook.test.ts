import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import {
  CHAINED_ENV,
  GIT_BASH_ENV,
  chainShellFor,
  globalSettingsPath,
  isChainedInvocation,
  pickGlobalStatusLineCommand,
  statusFileTarget,
  writeStatusFile,
} from "../desktop/hooks/desk-statusline.ts";
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
