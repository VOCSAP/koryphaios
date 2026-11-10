import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createBrokerEnsurer, HEALTH_TIMEOUT_MS, spawnDetachedBroker } from "../shared/broker-ensure.ts";
import { brokerStopMarkerPath, writeBrokerStopMarker } from "../shared/broker-stop-marker.ts";
import { settingsFilePath } from "../shared/config.ts";
import type { Logger } from "../shared/logger.ts";
import { controlRequest } from "../shared/mcp-daemon-control.ts";
import {
  BROKER_FIRST_WAIT_MS,
  brokerBeforeListenRequest,
  candidatePorts,
  codeFingerprint,
  daemonCodeRoot,
  fingerprintFiles,
  fnv1a32,
  getUserNameW,
  idRealUserName,
  idleSeconds,
  installProcessHandlers,
  launchLockPath,
  osUsername,
  ownPidStart,
  runDaemon,
  scrubSessionEnv,
  stateFilePath,
  systemUsernameProbes,
  UsernameError,
  type DaemonRun,
  type RunDaemonOptions,
  type UsernameProbes,
} from "../shared/mcp-daemon-lifecycle.ts";
import { FRAME_TYPE, type Hello } from "../shared/mcp-daemon-protocol.ts";
import { startDaemon, type DaemonHandle, type FamilyContext } from "../shared/mcp-daemon-server.ts";
import {
  filetimeToCreationUtc,
  measureWriterGeneration,
  processImagePath,
  processStartFiletime,
} from "../shared/process-generation.ts";
import { runMcpDaemonCommand, type McpDaemonDeps } from "../shared/mcp-daemon-status.ts";
import { reachedWithin } from "./_bounded-await.ts";
import { CODE_ROOT, FakeClock, FakeRelay, harness, key, linkTestKey, settle, until, within } from "./_mcp-daemon-fake-relay.ts";

const fixture: any = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "relay", "protocol-fixtures", "frames.json"), "utf8"),
);

function recordingLog(): { log: Logger; lines: string[] } {
  const lines: string[] = [];
  const push = (m: string) => void lines.push(m);
  const log: Logger = { info: push, warn: push, error: push, child: () => log, file: "" };
  return { log, lines };
}

const ROOT_A = CODE_ROOT;
const ROOT_B = "b".repeat(64);
const PID_START = "133750000000000000";

let root: string;
let counter = 0;
let codeDir: string;
const runs: DaemonRun[] = [];
const handles: DaemonHandle[] = [];
const listeners: Array<{ stop(closeActive?: boolean): void }> = [];

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "mcp-daemon-lifecycle-"));
  codeDir = join(root, "code");
  mkdirSync(join(codeDir, "shared"), { recursive: true });
  writeFileSync(join(codeDir, "mcp-daemon.ts"), "export {};\n");
  writeFileSync(join(codeDir, "shared", "a.ts"), "export const a = 1;\n");
});

afterAll(async () => {
  for (const run of runs) if (run.port() !== undefined) await run.stop("test end").catch(() => undefined);
  for (const handle of handles) await handle.stop();
  for (const listener of listeners) listener.stop(true);
  rmSync(root, { recursive: true, force: true });
});

function newHome(): string {
  const home = join(root, `h${++counter}`);
  linkTestKey(root, join(home, ".claude", "peers", "mcp-daemon.key"));
  return home;
}

const peersOf = (home: string) => join(home, ".claude", "peers");

async function freePorts(count: number): Promise<number[]> {
  const probes = Array.from({ length: count }, () =>
    Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } }),
  );
  const ports = probes.map((p) => p.port).sort((a, b) => a - b);
  for (const probe of probes) probe.stop(true);
  return ports;
}

/** A listener that accepts a connection and closes it at once: a program that is not a daemon. */
function foreignListener(port: number): { stop(closeActive?: boolean): void } {
  const listener = Bun.listen({ hostname: "127.0.0.1", port, socket: { open: (socket) => void socket.end(), data() {} } });
  listeners.push(listener);
  return listener;
}

interface Started {
  run: DaemonRun;
  home: string;
  logDir: string;
  statePath: (port: number) => string;
}

function begin(over: Partial<RunDaemonOptions> & { home?: string }): Started {
  const home = over.home ?? newHome();
  const logDir = join(root, `logs${++counter}`);
  const run = runDaemon({
    home,
    username: "tester",
    env: {},
    codeRoot: ROOT_A,
    codeDir,
    logDir,
    families: { roadmap: harness().factory() },
    pidStart: PID_START,
    ...over,
  });
  runs.push(run);
  return { run, home, logDir, statePath: (port) => stateFilePath(peersOf(home), port) };
}

async function serving(started: Started, port: number): Promise<void> {
  await within(
    (async () => {
      while (!existsSync(started.statePath(port))) await new Promise((resolve) => setTimeout(resolve, 2));
    })(),
    `the daemon to serve on ${port}`,
  );
}

const logOf = (logDir: string) => readFileSync(join(logDir, "server.log"), "utf8");

describe("code root", () => {
  const cases: Array<{ path: string; sha256: string }> = fixture.code_root.cases;

  test("the fixture carries cases for a Windows path and a POSIX path", () => {
    expect(cases.length).toBeGreaterThanOrEqual(2);
    expect(cases.some((c) => c.path.includes("\\"))).toBe(true);
    expect(cases.some((c) => c.path.startsWith("/"))).toBe(true);
  });

  test.each(cases)("hashes the path $path to the fixture digest", ({ path, sha256 }) => {
    expect(daemonCodeRoot(path)).toBe(sha256);
  });
});

function accountNameFromTheSystem(): string {
  const command =
    process.platform === "win32" ? [join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "whoami.exe")] : ["id", "-un"];
  const out = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" });
  expect(out.exitCode).toBe(0);
  return out.stdout.toString().trim().split("\\").pop() as string;
}

describe("account name", () => {
  const windows = (name: string | null, over: Partial<UsernameProbes> = {}): UsernameProbes => ({
    platform: "win32",
    windowsUserName: () => name,
    posixUserName: () => {
      throw new Error("the POSIX probe must not run on Windows");
    },
    ...over,
  });

  test("reads GetUserNameW on Windows and the POSIX probe elsewhere", () => {
    expect(osUsername(windows("Alice"))).toBe("Alice");
    expect(
      osUsername({ platform: "linux", posixUserName: () => "alice", windowsUserName: () => null }),
    ).toBe("alice");
  });

  test.each([[""], ["  "]])("refuses the name %j", (name) => {
    expect(() => osUsername(windows(name))).toThrow(UsernameError);
    expect(() => osUsername(windows(name))).toThrow("GetUserNameW");
  });

  test("accepts an account that is really named unknown", () => {
    expect(osUsername(windows("unknown"))).toBe("unknown");
    expect(osUsername({ platform: "darwin", posixUserName: () => "unknown", windowsUserName: () => null })).toBe("unknown");
  });

  test("names the failing call when GetUserNameW returns nothing or throws", () => {
    expect(() => osUsername(windows(null))).toThrow("GetUserNameW failed");
    expect(() =>
      osUsername(
        windows(null, {
          windowsUserName: () => {
            throw new Error("advapi32 is missing");
          },
        }),
      ),
    ).toThrow("advapi32 is missing");
    expect(() =>
      osUsername({
        platform: "linux",
        windowsUserName: () => null,
        posixUserName: () => {
          throw new Error("no passwd entry");
        },
      }),
    ).toThrow("id -run failed: no passwd entry");
  });

  test("id -run is asked for the real user name and a failure or an empty answer is refused", () => {
    const seen: Array<[string, string[]]> = [];
    const answer = (exitCode: number | null, stdout: string, stderr = "") => (command: string, args: string[]) => {
      seen.push([command, args]);
      return { exitCode, stdout, stderr };
    };
    expect(idRealUserName(answer(0, "alice\n"))).toBe("alice");
    expect(seen[0]?.[0]).toMatch(/(^|\/)id$/);
    expect(seen[0]?.[1]).toEqual(["-run"]);
    expect(() => idRealUserName(answer(1, "", "id: cannot find name for user ID 4242\n"))).toThrow(
      "id -run exited 1: id: cannot find name for user ID 4242",
    );
    expect(() => osUsername(systemUsernameProbes("linux", answer(0, "\n")))).toThrow("the user name from id -run is empty");
    expect(() => osUsername(systemUsernameProbes("darwin", answer(127, "", "not found")))).toThrow("id -run exited 127: not found");
    seen.length = 0;
    expect(osUsername(systemUsernameProbes("darwin", answer(0, "alice\n")))).toBe("alice");
    expect(seen.map(([, args]) => args)).toEqual([["-run"]]);
  });

  test("candidatePorts reads the name only when it derives the ports", () => {
    const { log } = recordingLog();
    const unreadable = () => {
      throw new UsernameError("id -run failed");
    };
    expect(() => candidatePorts("", {}, log)).toThrow(UsernameError);
    expect(() => candidatePorts(unreadable, {}, log)).toThrow("id -run failed");
    expect(candidatePorts(unreadable, { CLAUDE_PEERS_MCP_DAEMON_PORT: "47001" }, log)).toEqual([47001]);
    expect(candidatePorts("", { CLAUDE_PEERS_MCP_DAEMON_PORT: "47001" }, log)).toEqual([47001]);
  });

  test("the real call returns the account name whether or not USERNAME and USER are set", () => {
    const saved = { USERNAME: process.env["USERNAME"], USER: process.env["USER"] };
    try {
      delete process.env["USERNAME"];
      delete process.env["USER"];
      expect(osUsername().toLowerCase()).toBe(accountNameFromTheSystem().toLowerCase());
      process.env["USERNAME"] = "someone-else";
      process.env["USER"] = "someone-else";
      expect(osUsername().toLowerCase()).toBe(accountNameFromTheSystem().toLowerCase());
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  // A child process: changing USERNAME in this process does not change what os.userInfo reads here.
  test("the status command reads the account name the way the daemon does, whatever USERNAME and USER say", () => {
    const statusModule = join(import.meta.dir, "..", "shared", "mcp-daemon-status.ts").replaceAll("\\", "/");
    const script = `import { realDeps } from ${JSON.stringify(statusModule)};
const { username } = realDeps();
console.log(typeof username === "function" ? username() : username);`;
    const out = Bun.spawnSync([process.execPath, "-e", script], {
      env: {
        PATH: process.env["PATH"] ?? "",
        SystemRoot: process.env["SystemRoot"] ?? "",
        TEMP: process.env["TEMP"] ?? tmpdir(),
        TMP: process.env["TMP"] ?? tmpdir(),
        HOME: root,
        USERPROFILE: root,
        CLAUDE_PEERS_LOG_DIR: join(root, "status-logs"),
        USERNAME: "someone-else",
        USER: "someone-else",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(out.stderr.toString()).toBe("");
    expect(out.stdout.toString().trim().toLowerCase()).toBe(accountNameFromTheSystem().toLowerCase());
  });

  test.skipIf(process.platform !== "win32")("GetUserNameW with a buffer that is too small reports a failure instead of a name", () => {
    expect(getUserNameW(1)).toBeNull();
    expect((getUserNameW() as string).toLowerCase()).toBe(accountNameFromTheSystem().toLowerCase());
  });

  const statusDeps = (username: McpDaemonDeps["username"], env: Record<string, string> = {}): McpDaemonDeps => ({
    peersDir: peersOf(newHome()),
    username,
    env,
    codeDir,
    log: recordingLog().log,
    control: async () => ({ kind: "free" }),
    pidStartOf: async () => null,
    imageOf: async () => null,
    isAlive: () => false,
    kill() {},
    sleep: async () => {},
    now: () => 0,
    print() {},
  });

  const unreadable = () => {
    throw new UsernameError("id -run failed");
  };

  test.each([
    ["status", "", "the user name from the caller is empty"],
    ["restart", "", "the user name from the caller is empty"],
    ["status", unreadable, "id -run failed"],
    ["restart", unreadable, "id -run failed"],
  ] as const)("the %s command prints the cause and exits 1 when the name is unusable (%#)", async (action, username, cause) => {
    const errors: string[] = [];
    const spy = spyOn(console, "error").mockImplementation((message: unknown) => void errors.push(String(message)));
    try {
      expect(await runMcpDaemonCommand([action], statusDeps(username))).toBe(1);
    } finally {
      spy.mockRestore();
    }
    expect(errors.join("\n")).toContain(cause);
  });

  test("an invalid argument exits 2 before the account name is read", async () => {
    let read = 0;
    const deps = statusDeps(() => {
      read++;
      throw new UsernameError("id -run failed");
    });
    expect(await runMcpDaemonCommand(["bogus"], deps)).toBe(2);
    expect(await runMcpDaemonCommand(["status", "extra"], deps)).toBe(2);
    expect(read).toBe(0);
  });

  test("the status command does not read the name when the port is set", async () => {
    const deps = statusDeps(unreadable, { CLAUDE_PEERS_MCP_DAEMON_PORT: "47001" });
    expect(await runMcpDaemonCommand(["status"], deps)).toBe(0);
  });

  test.each([
    ["an empty name", () => ""],
    ["a function that throws", unreadable],
  ])("the daemon does not start with %s", async (_what, username) => {
    const started = begin({ username });
    expect(await within(started.run.done, "the daemon to refuse")).toBe(1);
    expect(started.run.port()).toBeUndefined();
    expect(logOf(started.logDir)).toMatch(/the daemon cannot run[\s\S]*(is empty|id -run failed)/);
  });

  test("the daemon does not read the name when the port is set", async () => {
    const [p0] = await freePorts(1);
    const started = begin({ username: unreadable, env: { CLAUDE_PEERS_MCP_DAEMON_PORT: String(p0) } });
    await serving(started, p0 as number);
    expect(started.run.port()).toBe(p0);
  });
});

describe("candidate ports", () => {
  const { log } = recordingLog();

  const cases: Array<{ username: string; fnv1a32: number; base_port: number }> = fixture.port.cases;

  test.each(cases)("derives the ten ports of the fixture user $username", ({ username, fnv1a32: hash, base_port }) => {
    expect(fnv1a32(username.toLowerCase())).toBe(hash);
    const ports = candidatePorts(username, {}, log);
    expect(ports).toHaveLength(10);
    expect(ports[0]).toBe(base_port);
    expect(ports[9]).toBe(base_port + 9);
  });

  test("the user name is lower-cased before hashing", () => {
    expect(candidatePorts("ALICE", {}, log)).toEqual(candidatePorts("alice", {}, log));
  });

  test("the environment variable replaces the list with that single port", () => {
    expect(candidatePorts("alice", { CLAUDE_PEERS_MCP_DAEMON_PORT: "50123" }, log)).toEqual([50123]);
  });

  test.each(["abc", "0", "70000", "12.5", "-3"])("an invalid port override %p is logged and ignored", (value) => {
    const recorded = recordingLog();
    expect(candidatePorts("alice", { CLAUDE_PEERS_MCP_DAEMON_PORT: value }, recorded.log)).toHaveLength(10);
    expect(recorded.lines.some((l) => l.includes("CLAUDE_PEERS_MCP_DAEMON_PORT"))).toBe(true);
  });

  test.each([
    [undefined, 600],
    ["", 600],
    ["0", 0],
    ["30", 30],
    ["-1", 600],
    ["abc", 600],
    ["1.5", 600],
  ])("the idle delay %p is %p seconds", (raw, seconds) => {
    expect(idleSeconds({ CLAUDE_PEERS_MCP_DAEMON_IDLE_SEC: raw }, log)).toBe(seconds);
  });

  test("an invalid idle delay leaves a log line", () => {
    const recorded = recordingLog();
    idleSeconds({ CLAUDE_PEERS_MCP_DAEMON_IDLE_SEC: "soon" }, recorded.log);
    expect(recorded.lines.some((l) => l.includes("CLAUDE_PEERS_MCP_DAEMON_IDLE_SEC"))).toBe(true);
  });
});

describe("session environment scrub", () => {
  const CANARY = "value-that-must-not-reach-the-log";
  const sessionVars = [
    "CLAUDE_PEERS_FORCE_GROUP",
    "CLAUDE_PEERS_FORCE_GROUP_ID",
    "CLAUDE_PEERS_GROUP",
    "CLAUDE_PEERS_DESK_TOKEN",
    "CLAUDE_PEERS_ROLE",
    "CLAUDE_PEERS_SUPERVISOR",
    "CLAUDE_PEERS_TOOLS",
    "CLAUDE_PEERS_APPROVAL_FILE",
    "CLAUDE_PEERS_DEPOSIT_CAPABILITY",
    "CLAUDE_PEERS_BROKER_URL",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_MESSAGING_SOCKET",
  ];
  const kept = {
    CLAUDE_PEERS_LOG_DIR: "/logs",
    CLAUDE_PEERS_MCP_DAEMON_PORT: "50123",
    CLAUDE_PEERS_MCP_DAEMON_IDLE_SEC: "60",
    CLAUDE_PEERS_POLL_FALLBACK_SEC: "5",
    PATH: "/bin",
  };

  test("removes every session variable and keeps the daemon's own settings", () => {
    const env: Record<string, string | undefined> = { ...kept };
    for (const name of sessionVars) env[name] = CANARY;
    const removed = scrubSessionEnv(env, recordingLog().log);
    expect(removed.sort()).toEqual([...sessionVars].sort());
    expect(env).toEqual(kept);
  });

  test("matches names without regard to case", () => {
    const env: Record<string, string | undefined> = { claude_code_session_id: CANARY, Claude_Peers_Group: CANARY, Path: "p" };
    expect(scrubSessionEnv(env, recordingLog().log).sort()).toEqual(["Claude_Peers_Group", "claude_code_session_id"]);
    expect(env).toEqual({ Path: "p" });
  });

  test("logs the names and never the values", () => {
    const env: Record<string, string | undefined> = { CLAUDE_PEERS_FORCE_GROUP: CANARY, CLAUDE_CODE_SESSION_ID: CANARY };
    const recorded = recordingLog();
    scrubSessionEnv(env, recorded.log);
    const text = recorded.lines.join("\n");
    expect(text).toContain("CLAUDE_PEERS_FORCE_GROUP");
    expect(text).toContain("CLAUDE_CODE_SESSION_ID");
    expect(text).not.toContain(CANARY);
  });

  test("an environment with no session variable leaves no log line", () => {
    const recorded = recordingLog();
    expect(scrubSessionEnv({ ...kept }, recorded.log)).toEqual([]);
    expect(recorded.lines).toEqual([]);
  });
});

describe("code fingerprint and start time", () => {
  const TREE: Record<string, string> = {
    "mcp-daemon.ts":
      'import type { T } from "./shared/type-only.ts";\nexport * from "./shared/reexported.ts";\nconst lazy = await import("./shared/a.ts");\n',
    "shared/a.ts": 'import { w } from "../desktop/src/shared/w.ts";\nimport "./a2.ts";\nimport "./gone.ts";\n',
    "shared/a2.ts": 'import "./a.ts";\n',
    "shared/reexported.ts": "export const r = 1;\n",
    "shared/type-only.ts": "export type T = 1;\n",
    "shared/unreachable.ts": "export const u = 1;\n",
    "desktop/src/shared/w.ts": 'import "./t.js";\n',
    "desktop/src/shared/t.ts": "export const t = 1;\n",
  };

  function makeDir(): string {
    const dir = join(root, `fp${++counter}`);
    for (const [file, text] of Object.entries(TREE)) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), text);
    }
    return dir;
  }

  test("is stable for the same sources", () => {
    const dir = makeDir();
    expect(codeFingerprint(dir)).toBe(codeFingerprint(dir));
    expect(codeFingerprint(dir)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("covers the entry point and what it reaches by relative imports, whatever their form, and nothing else", () => {
    expect(fingerprintFiles(makeDir())).toEqual([
      "desktop/src/shared/t.ts",
      "desktop/src/shared/w.ts",
      "mcp-daemon.ts",
      "shared/a.ts",
      "shared/a2.ts",
      "shared/reexported.ts",
      "unresolved:shared/gone.ts",
    ]);
  });

  test.each([
    ["the entry point", "mcp-daemon.ts"],
    ["a module imported dynamically", "shared/a.ts"],
    ["a module re-exported", "shared/reexported.ts"],
    ["a module two hops away in another directory", "desktop/src/shared/w.ts"],
    ["a module three hops away imported with a .js specifier", "desktop/src/shared/t.ts"],
  ])("changes when %s changes", (_label, file) => {
    const dir = makeDir();
    const before = codeFingerprint(dir);
    writeFileSync(join(dir, file), `${TREE[file]}// edited\n`);
    expect(codeFingerprint(dir)).not.toBe(before);
  });

  test.each([
    ["a module nothing imports", "shared/unreachable.ts"],
    ["a module only imported as a type", "shared/type-only.ts"],
    ["a file that is not a source", "shared/notes.md"],
  ])("does not change when %s changes", (_label, file) => {
    const dir = makeDir();
    const before = codeFingerprint(dir);
    writeFileSync(join(dir, file), "// edited\n");
    expect(codeFingerprint(dir)).toBe(before);
  });

  test("an import that resolves to no file is hashed by name, and creating the file changes the fingerprint", () => {
    const dir = makeDir();
    const before = codeFingerprint(dir);
    writeFileSync(join(dir, "shared", "gone.ts"), "export {};\n");
    expect(fingerprintFiles(dir)).toContain("shared/gone.ts");
    expect(codeFingerprint(dir)).not.toBe(before);
  });

  test("the files the bundler reaches from the real entry point are all hashed", async () => {
    const repo = join(import.meta.dir, "..");
    const result = await Bun.build({ entrypoints: [join(repo, "mcp-daemon.ts")], root: repo, target: "bun", metafile: true });
    expect(result.success, result.logs.map((entry) => entry.message).join("\n")).toBe(true);
    const reached = Object.keys(result.metafile!.inputs)
      .map((input) => relative(repo, isAbsolute(input) ? input : resolve(process.cwd(), input)).replaceAll("\\", "/"))
      .filter((input) => !input.startsWith("..") && !input.includes("node_modules"));
    expect(reached, "the build did not walk the daemon's own imports").toEqual(
      expect.arrayContaining(["mcp-daemon.ts", "shared/roadmap-server.ts", "shared/mcp-daemon-lifecycle.ts"]),
    );
    const hashed = new Set(fingerprintFiles(repo));
    expect(reached.filter((input) => !hashed.has(input)), "a file the daemon loads is not in its fingerprint").toEqual([]);
    expect(hashed.has("desktop/src/shared/workflow.ts")).toBe(true);
  });

  // Pairs produced by PowerShell ([DateTime].ToFileTimeUtc() and .ToString('o')); the 00:30Z and 01:30Z
  // pair is one local hour that Europe/Paris lives twice.
  test.each([
    ["134386321567733341", "2026-11-08T17:22:36.7733341Z"],
    ["134386321560000123", "2026-11-08T17:22:36.0000123Z"],
    ["134386321560000000", "2026-11-08T17:22:36.0000000Z"],
    ["134373618000000000", "2026-10-25T00:30:00.0000000Z"],
    ["134373654000000000", "2026-10-25T01:30:00.0000000Z"],
    ["116444736000000000", "1970-01-01T00:00:00.0000000Z"],
    ["157469183999999999", "2099-12-31T23:59:59.9999999Z"],
  ])("FILETIME %s is the PowerShell creation time %s", (filetime, iso) => {
    expect(filetimeToCreationUtc(filetime)).toBe(iso);
    expect(filetimeToCreationUtc(BigInt(filetime))).toBe(iso);
  });

  test("a FILETIME before the Unix epoch or not a number is refused, never converted to a wrong date", () => {
    expect(() => filetimeToCreationUtc("116444735999999999")).toThrow(RangeError);
    expect(() => filetimeToCreationUtc(0n)).toThrow(RangeError);
    expect(() => filetimeToCreationUtc("not a date")).toThrow();
  });

  test("a pid that no Windows process can have gives null", () => {
    for (const pid of [0, -1, 1.5, Number.NaN, 0x1_0000_0000]) {
      expect(processStartFiletime(pid), `pid ${pid}`).toBeNull();
      expect(processImagePath(pid), `pid ${pid}`).toBeNull();
    }
  });

  test.skipIf(process.platform !== "win32")("Windows only: the own start time is a FILETIME in the fixture's range", async () => {
    const value = await ownPidStart(recordingLog().log);
    expect(value).toMatch(/^\d{18}$/);
    expect(Number(value)).toBeGreaterThan(fixture.pid_start.windows.min);
    expect(Number(value)).toBeLessThan(fixture.pid_start.windows.max);
  });

  test.skipIf(process.platform !== "win32")("Windows only: the FFI creation time of this process and of a child equals PowerShell's", async () => {
    const child = Bun.spawn([process.execPath, "-e", "await new Promise(() => {})"], { stdio: ["ignore", "ignore", "ignore"] });
    try {
      const pids = [process.pid, child.pid];
      const powershell = join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const reference = Bun.spawnSync(
        [powershell, "-NoLogo", "-NoProfile", "-Command", `foreach ($id in ${pids.join(",")}) { (Get-Process -Id $id).StartTime.ToUniversalTime().ToString('o') }`],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(reference.exitCode, reference.stderr.toString()).toBe(0);
      const expected = reference.stdout.toString().trim().split(/\r?\n/);
      expect(expected).toHaveLength(2);
      for (const [index, pid] of pids.entries()) {
        const filetime = processStartFiletime(pid);
        expect(filetime, `pid ${pid}`).toMatch(/^\d{18}$/);
        expect(filetimeToCreationUtc(filetime as string), `pid ${pid}`).toBe(expected[index] as string);
        const generation = await measureWriterGeneration(pid);
        expect(generation, `pid ${pid}`).toEqual({ platform: "win32", pid, creationUtc: expected[index] as string });
      }
      expect(await ownPidStart(recordingLog().log)).toBe(processStartFiletime(process.pid) as string);
    } finally {
      child.kill();
      await child.exited;
    }
  });

  test.skipIf(process.platform !== "win32")("Windows only: a pid that has exited has no creation time and no image", async () => {
    // A process object lives while any handle to it is open, so the pid of a child this test spawned is still
    // readable after it exits; the grandchild's handle closes with its parent.
    const parent = Bun.spawn(
      [process.execPath, "-e", "const p = Bun.spawn([process.execPath, '-e', '0']); await p.exited; console.log(p.pid)"],
      { stdout: "pipe", stderr: "ignore" },
    );
    const gone = Number((await new Response(parent.stdout).text()).trim());
    await parent.exited;
    expect(Number.isInteger(gone) && gone > 0).toBe(true);
    await until(() => processStartFiletime(gone) === null, "the exited parent to release the handle it held on its child");
    const log = recordingLog();
    expect(processStartFiletime(gone)).toBeNull();
    expect(processImagePath(gone)).toBeNull();
    expect(await measureWriterGeneration(gone, log.log)).toBeNull();
    expect(log.lines).toEqual(["Windows process generation measurement failed"]);
  });

  test.skipIf(process.platform !== "win32")("Windows only: the image of this process is the file that runs it", () => {
    expect(basename(processImagePath(process.pid) as string).toLowerCase()).toBe(basename(process.execPath).toLowerCase());
  });

  test("a start time that cannot be measured is empty and logged, never a thrown error", async () => {
    const failed = recordingLog();
    expect(await ownPidStart(failed.log, { platform: "win32", windowsStart: () => null })).toBe("");
    expect(failed.lines.join("\n")).toContain("GetProcessTimes failed");
    const thrown = recordingLog();
    const broken = () => {
      throw new Error("kernel32.dll is missing");
    };
    expect(await ownPidStart(thrown.log, { platform: "win32", windowsStart: broken })).toBe("");
    expect(thrown.lines.join("\n")).toContain("kernel32.dll is missing");
    const noPs = recordingLog();
    const missing = () => {
      throw new Error("Executable not found in $PATH: ps");
    };
    expect(await ownPidStart(noPs.log, { platform: "darwin", run: missing })).toBe("");
    expect(noPs.lines.join("\n")).toContain("Executable not found in $PATH: ps");
    const badExit = recordingLog();
    expect(await ownPidStart(badExit.log, { platform: "darwin", run: () => ({ exitCode: 1, stdout: "", stderr: "" }) })).toBe("");
    expect(badExit.lines.join("\n")).toContain("ps exited 1");
  });

  test("outside Windows and Linux the start time is the lstart that ps prints", async () => {
    const seen: string[][] = [];
    const run = (command: string, args: string[]) => {
      seen.push([command, ...args]);
      return { exitCode: 0, stdout: "Sun Nov  8 18:22:36 2026\n", stderr: "" };
    };
    expect(await ownPidStart(recordingLog().log, { platform: "darwin", run })).toBe("Sun Nov  8 18:22:36 2026");
    expect(seen).toEqual([["ps", "-o", "lstart=", "-p", String(process.pid)]]);
  });

  test("a daemon whose start time cannot be measured still serves, with an empty pid_start", async () => {
    const [p0] = await freePorts(1);
    const started = begin({ ports: [p0 as number], pidStart: "" });
    await serving(started, p0 as number);
    const state = JSON.parse(readFileSync(started.statePath(p0 as number), "utf8")) as { pid_start: string };
    expect(state.pid_start).toBe("");
    expect(started.run.port()).toBe(p0);
  });

  test.skipIf(process.platform !== "linux")("Linux only: the own start time is field 22 of /proc/self/stat", async () => {
    const stat = readFileSync("/proc/self/stat", "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    expect(await ownPidStart(recordingLog().log)).toBe(fields[19] as string);
  });
});

describe("process error policy", () => {
  function emitter() {
    const handlers = new Map<string, (...args: unknown[]) => void>();
    return {
      on: (event: string, listener: (...args: unknown[]) => void) => void handlers.set(event, listener),
      emit: (event: string, ...args: unknown[]) => handlers.get(event)?.(...args),
      has: (event: string) => handlers.has(event),
    };
  }

  function install() {
    const proc = emitter();
    const recorded = recordingLog();
    const stops: string[] = [];
    let now = 1_000_000;
    installProcessHandlers(proc, { stop: (reason) => void stops.push(reason), log: recorded.log, now: () => now });
    return { proc, stops, lines: recorded.lines, advance: (ms: number) => void (now += ms) };
  }

  test("listens to the two error events and the two signals", () => {
    const { proc } = install();
    for (const event of ["unhandledRejection", "uncaughtException", "SIGINT", "SIGTERM"]) expect(proc.has(event)).toBe(true);
  });

  test("an unhandled rejection is logged and the daemon carries on", () => {
    const { proc, stops, lines } = install();
    for (let i = 0; i < 20; i++) proc.emit("unhandledRejection", new Error("rejected"));
    expect(stops).toEqual([]);
    expect(lines.filter((l) => l.includes("unhandled rejection"))).toHaveLength(20);
  });

  test("five uncaught exceptions in a minute are logged, the sixth stops the daemon", () => {
    const { proc, stops, lines } = install();
    for (let i = 0; i < 5; i++) proc.emit("uncaughtException", new Error("boom"));
    expect(stops).toEqual([]);
    proc.emit("uncaughtException", new Error("boom"));
    expect(stops).toHaveLength(1);
    expect(stops[0]).toContain("uncaught exceptions");
    expect(lines.filter((l) => l.includes("uncaught exception"))).toHaveLength(6);
  });

  test("exceptions older than a minute no longer count", () => {
    const { proc, stops, advance } = install();
    for (let i = 0; i < 5; i++) proc.emit("uncaughtException", new Error("boom"));
    advance(61_000);
    for (let i = 0; i < 5; i++) proc.emit("uncaughtException", new Error("boom"));
    expect(stops).toEqual([]);
  });

  test.each(["SIGINT", "SIGTERM"])("%s stops the daemon", (signal) => {
    const { proc, stops } = install();
    proc.emit(signal);
    expect(stops).toEqual([`signal ${signal}`]);
  });

  test("an unhandled rejection raised inside a session is logged by a real process that keeps serving", async () => {
    const home = newHome();
    const logDir = join(root, `logs${++counter}`);
    const stderrPath = join(root, `rejection-child-${++counter}.err`);
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, "_mcp-daemon-rejection-child.ts"), join(peersOf(home), "mcp-daemon.key"), logDir, ROOT_A],
      { stdout: "pipe", stderr: Bun.file(stderrPath) },
    );
    let out = "";
    void (async () => {
      for await (const chunk of child.stdout) out += new TextDecoder().decode(chunk);
    })();
    const outcome = (what: string, seen: () => boolean) =>
      reachedWithin(
        Promise.race([
          (async () => {
            while (!seen()) await new Promise((resolve) => setTimeout(resolve, 5));
          })(),
          child.exited.then((code) => {
            throw new Error(`the daemon process exited with ${code} before ${what}; stderr: ${readFileSync(stderrPath, "utf8")}`);
          }),
        ]),
        what,
        10_000,
      );
    try {
      await outcome("it listened", () => /LISTENING \d+/.test(out));
      const port = Number(/LISTENING (\d+)/.exec(out)?.[1]);
      const relay = await FakeRelay.open(port);
      await relay.welcome();
      expect((await relay.rpc(1, "tools/call", { name: "ping", arguments: {} })).result.content[0].text).toBe("ping");
      await relay.rpc(2, "tools/call", { name: "reject", arguments: {} });
      await outcome("the rejection was logged", () => out.includes("LOGGED unhandled rejection"));
      expect(child.exitCode, "the process that logged the rejection is still running").toBeNull();
      const after = await relay.rpc(3, "tools/call", { name: "ping", arguments: {} });
      expect(after.result.content[0].text, "the daemon still answers a session after the rejection").toBe("ping");
      relay.close();
    } finally {
      child.kill();
      await child.exited;
    }
  }, 30_000);
});

describe("one daemon per code root, lowest port first", () => {
  test("without a key a relay created, the daemon exits 1, says so, listens nowhere and creates nothing", async () => {
    const [p0] = await freePorts(1);
    const home = join(root, `nokey${++counter}`);
    mkdirSync(peersOf(home), { recursive: true });
    writeFileSync(launchLockPath(peersOf(home), ROOT_A), "1 2");
    const started = begin({ ports: [p0 as number], home });
    expect(await within(started.run.done, "the daemon to refuse to start")).toBe(1);
    const log = logOf(started.logDir);
    expect(log).toContain("no shared key at");
    expect(log).toContain("a relay creates it");
    expect(started.run.port()).toBeUndefined();
    expect(readdirSync(peersOf(home))).toEqual([]);
    expect(await controlRequest({ port: p0 as number, key, op: "status" })).toEqual({ kind: "free" });
  });

  test("serves on the first free port, writes the state file, removes the launch lock, then cleans up at stop", async () => {
    const [p0, p1] = await freePorts(2);
    const home = newHome();
    const lock = launchLockPath(peersOf(home), ROOT_A);
    writeFileSync(lock, "1 2");
    const started = begin({ ports: [p0 as number, p1 as number], home });
    await serving(started, p0 as number);
    expect(existsSync(lock)).toBe(false);
    const state = JSON.parse(readFileSync(started.statePath(p0 as number), "utf8"));
    expect(Object.keys(state).sort()).toEqual(
      ["code_fingerprint", "code_root", "instance", "pid", "pid_start", "port", "started_at", "version"],
    );
    expect(state).toMatchObject({
      pid: process.pid,
      pid_start: PID_START,
      port: p0,
      code_root: ROOT_A,
      code_fingerprint: codeFingerprint(codeDir),
      version: "1",
    });
    expect(new Date(state.started_at).toISOString()).toBe(state.started_at);
    expect(readdirSync(peersOf(home)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    await started.run.stop("test");
    expect(await within(started.run.done, "the daemon to finish")).toBe(0);
    expect(existsSync(started.statePath(p0 as number))).toBe(false);
  });

  test("the state file carries the start time this process measures for itself", async () => {
    const [p0] = await freePorts(1);
    const started = begin({ ports: [p0 as number], pidStart: undefined });
    await reachedWithin(
      (async () => {
        while (!existsSync(started.statePath(p0 as number))) await new Promise((resolve) => setTimeout(resolve, 5));
      })(),
      "the daemon to serve after measuring its start time",
      10_000,
    );
    const state = JSON.parse(readFileSync(started.statePath(p0 as number), "utf8"));
    expect(state.pid_start).toBe(await ownPidStart(recordingLog().log));
    expect(state.pid_start).not.toBe("");
  });

  test("a second daemon of the same code root on a higher port exits as a duplicate and removes the launch lock", async () => {
    const [p0, p1] = await freePorts(2);
    const home = newHome();
    const first = begin({ ports: [p0 as number, p1 as number], home });
    await serving(first, p0 as number);
    const lock = launchLockPath(peersOf(home), ROOT_A);
    writeFileSync(lock, "1 2");
    const second = begin({ ports: [p0 as number, p1 as number], home });
    expect(await within(second.run.done, "the duplicate to exit")).toBe(0);
    expect(second.run.port()).toBeUndefined();
    expect(existsSync(lock)).toBe(false);
    expect(existsSync(second.statePath(p1 as number))).toBe(false);
    expect(logOf(second.logDir)).toContain(`already listens on ${p0}`);
  });

  test("a daemon of another code root on the low port is skipped: the next port is taken", async () => {
    const [p0, p1] = await freePorts(2);
    const home = newHome();
    const other = begin({ ports: [p0 as number, p1 as number], home, codeRoot: ROOT_B });
    await serving(other, p0 as number);
    const mine = begin({ ports: [p0 as number, p1 as number], home });
    await serving(mine, p1 as number);
    expect(mine.run.port()).toBe(p1);
    expect(other.run.port()).toBe(p0);
    expect(logOf(mine.logDir)).toContain(`port ${p0} skipped: held by a daemon of code root ${ROOT_B.slice(0, 8)}`);
  });

  test("a daemon of the same code root on a HIGHER port than the first free one is not a duplicate", async () => {
    const [p0, p1] = await freePorts(2);
    const home = newHome();
    const high = begin({ ports: [p1 as number], home });
    await serving(high, p1 as number);
    const low = begin({ ports: [p0 as number, p1 as number], home });
    await serving(low, p0 as number);
    expect(low.run.port()).toBe(p0);
    expect(high.run.port()).toBe(p1);
  });

  test("a program that is not a daemon on the low port is skipped, and the log says why", async () => {
    const [p0, p1] = await freePorts(2);
    foreignListener(p0 as number);
    const started = begin({ ports: [p0 as number, p1 as number] });
    await serving(started, p1 as number);
    expect(started.run.port()).toBe(p1);
    expect(logOf(started.logDir)).toContain(`port ${p0} skipped: held by another program or another key: the connection closed before a reply`);
  });

  test("when every candidate is held by something else, the daemon says so, exits 1 and removes the launch lock", async () => {
    const [p0] = await freePorts(1);
    foreignListener(p0 as number);
    const home = newHome();
    const lock = launchLockPath(peersOf(home), ROOT_A);
    writeFileSync(lock, "1 2");
    const started = begin({ ports: [p0 as number], home });
    expect(await within(started.run.done, "the daemon to give up")).toBe(1);
    expect(logOf(started.logDir)).toContain("every candidate port is held");
    expect(existsSync(lock)).toBe(false);
  });

  test("a stop that lands during the post-listen scan leaves no state file and no launch lock", async () => {
    const [p0, p1] = await freePorts(2);
    foreignListener(p0 as number);
    const home = newHome();
    const lock = launchLockPath(peersOf(home), ROOT_A);
    writeFileSync(lock, "1 2");
    let run: DaemonRun | undefined;
    const started = begin({
      ports: [p0 as number, p1 as number],
      home,
      start: (opts) => {
        const handle = startDaemon(opts);
        handles.push(handle);
        queueMicrotask(() => void run?.stop("probe"));
        return handle;
      },
    });
    run = started.run;
    expect(await within(started.run.done, "the run to end")).toBe(0);
    await until(() => !existsSync(lock), "the launch lock to be removed");
    expect(existsSync(started.statePath(p1 as number))).toBe(false);
    expect(await controlRequest({ port: p1 as number, key, op: "status" })).toEqual({ kind: "free" });
  });

  test("a stop that lands while the ports are scanned again after a taken port removes the launch lock", async () => {
    const [p0] = await freePorts(1);
    const home = newHome();
    const lock = launchLockPath(peersOf(home), ROOT_A);
    writeFileSync(lock, "1 2");
    let run: DaemonRun | undefined;
    const started = begin({
      ports: [p0 as number],
      home,
      start: () => {
        void run?.stop("during the retry");
        throw Object.assign(new Error("taken"), { code: "EACCES" });
      },
    });
    run = started.run;
    expect(await within(started.run.done, "the run to end")).toBe(0);
    expect(existsSync(lock)).toBe(false);
  });

  test("a stop requested before the daemon exists stops it as soon as it does, without a state file", async () => {
    const [p0] = await freePorts(1);
    const home = newHome();
    const lock = launchLockPath(peersOf(home), ROOT_A);
    writeFileSync(lock, "1 2");
    const started = begin({ ports: [p0 as number], home });
    const stopped = started.run.stop("early");
    expect(await within(started.run.done, "the early stop to end the run")).toBe(0);
    await within(stopped, "the early stop to settle");
    expect(existsSync(started.statePath(p0 as number))).toBe(false);
    expect(existsSync(lock)).toBe(false);
    expect(await controlRequest({ port: p0 as number, key, op: "status" })).toEqual({ kind: "free" });
  });

  test("a stop that fails still ends the run and removes the state file", async () => {
    const [p0] = await freePorts(1);
    const started = begin({
      ports: [p0 as number],
      start: (opts) => {
        const handle = startDaemon(opts);
        handles.push(handle);
        return {
          ...handle,
          stop: async () => {
            await handle.stop();
            throw new Error("stop failed");
          },
        };
      },
    });
    await serving(started, p0 as number);
    await expect(started.run.stop("test")).rejects.toThrow("stop failed");
    expect(await within(started.run.done, "the run to end after a failed stop")).toBe(0);
    expect(existsSync(started.statePath(p0 as number))).toBe(false);
  });

  test.each(["EACCES", "EADDRINUSE"])("%s at listen means the port is taken: the ports are scanned again", async (code) => {
    const [p0, p1] = await freePorts(2);
    let calls = 0;
    const started = begin({
      ports: [p0 as number, p1 as number],
      start: (opts) => {
        if (calls++ === 0) throw Object.assign(new Error("listen failed"), { code });
        const handle = startDaemon(opts);
        handles.push(handle);
        return handle;
      },
    });
    await serving(started, p0 as number);
    expect(calls).toBe(2);
    expect(logOf(started.logDir)).toContain(`is taken (${code})`);
  });

  test("any other listen error ends the run with exit 1 and a log line", async () => {
    const [p0] = await freePorts(1);
    const home = newHome();
    const lock = launchLockPath(peersOf(home), ROOT_A);
    writeFileSync(lock, "1 2");
    const started = begin({
      ports: [p0 as number],
      home,
      start: () => {
        throw Object.assign(new Error("not allowed"), { code: "EPERM" });
      },
    });
    expect(await within(started.run.done, "the daemon to fail")).toBe(1);
    expect(logOf(started.logDir)).toContain("the daemon cannot run");
    expect(existsSync(lock)).toBe(false);
  });

  test("a same-root daemon that appears between the scan and the listen makes the new one exit", async () => {
    const [p0, p1] = await freePorts(2);
    const home = newHome();
    const blocker = foreignListener(p0 as number);
    const lock = launchLockPath(peersOf(home), ROOT_A);
    writeFileSync(lock, "1 2");
    const started = begin({
      ports: [p0 as number, p1 as number],
      home,
      start: (opts) => {
        if (opts.port === p1) {
          blocker.stop(true);
          handles.push(
            startDaemon({
              port: p0 as number,
              keyPath: opts.keyPath,
              key,
              logDir: opts.logDir,
              codeRoot: ROOT_A,
              families: {},
              control: { status: () => ({ code_root: ROOT_A }), stop() {} },
            }),
          );
        }
        const handle = startDaemon(opts);
        handles.push(handle);
        return handle;
      },
    });
    expect(await within(started.run.done, "the late duplicate to exit")).toBe(0);
    expect(await controlRequest({ port: p1 as number, key, op: "status" })).toEqual({ kind: "free" });
    expect(existsSync(started.statePath(p1 as number))).toBe(false);
    expect(existsSync(lock)).toBe(false);
    expect(logOf(started.logDir)).toContain("appeared on");
  });
});

describe("control requests to a running daemon", () => {
  test("status reports the process, the code and the session count", async () => {
    const [p0] = await freePorts(1);
    const started = begin({ ports: [p0 as number] });
    await serving(started, p0 as number);
    const before = await controlRequest({ port: p0 as number, key, op: "status" });
    expect(before).toEqual({
      kind: "reply",
      body: {
        pid: process.pid,
        pid_start: PID_START,
        port: p0,
        code_root: ROOT_A,
        code_fingerprint: codeFingerprint(codeDir),
        version: "1",
        sessions: 0,
        dropped_notifications: 0,
      },
    });
    const relay = await FakeRelay.open(p0 as number);
    await relay.welcome({ cwd: "/work/status" });
    const after = await controlRequest({ port: p0 as number, key, op: "status" });
    expect(after.kind === "reply" && after.body["sessions"]).toBe(1);
    relay.close();
  });

  test("the status reply carries the dropped notification count of the daemon", async () => {
    const [p0] = await freePorts(1);
    const started = begin({
      ports: [p0 as number],
      start: (opts) => {
        const handle = startDaemon(opts);
        handles.push(handle);
        return { ...handle, stats: () => ({ ...handle.stats(), droppedNotifications: 7 }) };
      },
    });
    await serving(started, p0 as number);
    const reply = await controlRequest({ port: p0 as number, key, op: "status" });
    expect(reply.kind === "reply" && reply.body["dropped_notifications"]).toBe(7);
  });

  test("the home, the broker ensurer and the settings of the run reach the family; without an ensurer the daemon keeps its own", async () => {
    const seen: FamilyContext[] = [];
    const families = {
      roadmap: (hello: Hello, ctx: FamilyContext) => {
        seen.push(ctx);
        return harness().factory()(hello, ctx);
      },
    };
    const brokers = { ensure: async () => ({ action: "already-running" as const }) };
    const settings = { contextResumeKeyTtlMs: 2000, pollFallbackIntervalMs: 3000, heartbeatIntervalMs: 4000 };
    const [p0, p1] = await freePorts(2);
    const home = newHome();
    const wired = begin({ ports: [p0 as number], home, families, brokers, settings });
    await serving(wired, p0 as number);
    await (await FakeRelay.open(p0 as number)).welcome({ cwd: "/work/wired" });
    const ctx = seen[0] as FamilyContext;
    expect(ctx.brokers).toBe(brokers);
    expect(ctx.settings).toEqual(settings);
    expect(ctx.home).toBe(home);

    const bare = begin({ ports: [p1 as number], families });
    await serving(bare, p1 as number);
    await (await FakeRelay.open(p1 as number)).welcome({ cwd: "/work/bare" });
    await expect(
      (seen[1] as FamilyContext).brokers.ensure({ url: "http://127.0.0.1:1", settingsPath: "s", env: {} }),
    ).rejects.toThrow("without a broker launcher");
  });

  test("stop closes the sessions, removes the state file and ends the run with exit 0", async () => {
    const [p0] = await freePorts(1);
    const started = begin({ ports: [p0 as number] });
    await serving(started, p0 as number);
    const relay = await FakeRelay.open(p0 as number);
    await relay.welcome({ cwd: "/work/stop" });
    expect(await controlRequest({ port: p0 as number, key, op: "stop" })).toEqual({ kind: "reply", body: { ok: true } });
    expect(await within(started.run.done, "the daemon to stop")).toBe(0);
    expect(existsSync(started.statePath(p0 as number))).toBe(false);
    await relay.expectClosed("the session to be closed by the stop");
  });
});

describe("idle shutdown", () => {
  const idle = { CLAUDE_PEERS_MCP_DAEMON_IDLE_SEC: "600" };

  test("a daemon with no session exits at the idle delay, not before", async () => {
    const [p0] = await freePorts(1);
    const clock = new FakeClock();
    const started = begin({ ports: [p0 as number], clock, env: idle });
    await serving(started, p0 as number);
    clock.advance(599_999);
    await settle();
    expect(started.run.stats()?.listening).toBe(true);
    clock.advance(1);
    expect(await within(started.run.done, "the idle daemon to exit")).toBe(0);
    expect(existsSync(started.statePath(p0 as number))).toBe(false);
    expect(logOf(started.logDir)).toContain("stopping: idle");
  });

  test("a handshake that never ends is waited for 9 s of the injected clock, then the idle daemon exits", async () => {
    const [p0] = await freePorts(1);
    const clock = new FakeClock();
    const started = begin({
      ports: [p0 as number],
      clock,
      env: idle,
      start: (opts) => {
        const handle = startDaemon(opts);
        handles.push(handle);
        return { ...handle, waitForHandshakes: () => new Promise<void>(() => undefined) };
      },
    });
    await serving(started, p0 as number);
    clock.advance(600_000);
    await until(() => started.run.stats()?.listening === false, "the listener to be closed");
    clock.advance(8999);
    await settle();
    expect(existsSync(started.statePath(p0 as number))).toBe(true);
    expect(started.run.stats()?.listening).toBe(false);
    clock.advance(1);
    expect(await within(started.run.done, "the daemon to exit after the 9 s wait")).toBe(0);
    expect(logOf(started.logDir)).toContain("stopping: idle");
  });

  test("an idle delay of 0 means never", async () => {
    const [p0] = await freePorts(1);
    const clock = new FakeClock();
    const started = begin({ ports: [p0 as number], clock, env: { CLAUDE_PEERS_MCP_DAEMON_IDLE_SEC: "0" } });
    await serving(started, p0 as number);
    clock.advance(100_000_000);
    await settle();
    expect(started.run.stats()?.listening).toBe(true);
  });

  test("a session keeps the daemon up, and the delay restarts when the last session closes", async () => {
    const [p0] = await freePorts(1);
    const clock = new FakeClock();
    const started = begin({ ports: [p0 as number], clock, env: idle });
    await serving(started, p0 as number);
    const relay = await FakeRelay.open(p0 as number);
    await relay.welcome({ cwd: "/work/keeps" });
    clock.advance(10_000_000);
    await settle();
    expect(started.run.stats()?.listening).toBe(true);
    expect(logOf(started.logDir)).not.toContain("idle: no session");
    relay.close();
    await until(() => started.run.stats()?.sessions === 0, "the session to close");
    clock.advance(599_999);
    await settle();
    expect(started.run.stats()?.listening).toBe(true);
    clock.advance(1);
    expect(await within(started.run.done, "the daemon to exit after the last session")).toBe(0);
  });

  async function relayInHandshake(clock: FakeClock, started: Started, port: number): Promise<FakeRelay> {
    clock.advance(599_000);
    const relay = await FakeRelay.open(port);
    relay.sendHello({ cwd: "/work/gated" });
    await until(() => started.run.stats()?.authenticated === 1, "the handshake to be in progress");
    await settle();
    clock.advance(1000);
    return relay;
  }

  function gatedHarness(): { h: ReturnType<typeof harness>; release: () => void } {
    const h = harness();
    let release!: () => void;
    h.gates.set("/work/gated", new Promise<void>((resolve) => (release = resolve)));
    return { h, release: () => release() };
  }

  test("a relay whose handshake is in progress when the delay expires is served and the daemon stays up", async () => {
    const [p0] = await freePorts(1);
    const clock = new FakeClock();
    const { h, release } = gatedHarness();
    const started = begin({ ports: [p0 as number], clock, env: idle, families: { roadmap: h.factory() } });
    await serving(started, p0 as number);
    const relay = await relayInHandshake(clock, started, p0 as number);
    await until(() => started.run.stats()?.listening === false, "the listener to be closed");
    release();
    await relay.expectFrame(FRAME_TYPE.WELCOME, "WELCOME");
    await until(() => started.run.stats()?.listening === true, "the listener to be reopened");
    expect(await relay.whoami(1)).toMatchObject({ cwd: "/work/gated" });
    expect(logOf(started.logDir)).not.toContain("stopping: idle");
  });

  test("when the port is lost meanwhile, the session is served without listening and the daemon exits at its end", async () => {
    const [p0] = await freePorts(1);
    const clock = new FakeClock();
    const { h, release } = gatedHarness();
    const started = begin({ ports: [p0 as number], clock, env: idle, families: { roadmap: h.factory() } });
    await serving(started, p0 as number);
    const relay = await relayInHandshake(clock, started, p0 as number);
    await until(() => started.run.stats()?.listening === false, "the listener to be closed");
    foreignListener(p0 as number);
    release();
    await relay.expectFrame(FRAME_TYPE.WELCOME, "WELCOME");
    await until(() => logOf(started.logDir).includes("serving it without listening"), "the lost port to be logged");
    expect(started.run.stats()?.listening).toBe(false);
    expect(await relay.whoami(1)).toMatchObject({ cwd: "/work/gated" });
    relay.close();
    expect(await within(started.run.done, "the daemon to exit after its last session")).toBe(0);
  });
});

const ENTRY_TEST_MS = 30_000;
const SERVE_WAIT_MS = 15_000;
const EXIT_WAIT_MS = 5_000;

/** Reads a child's stderr as it arrives: reading it only after the exit would hang while the child lives. */
function collectText(stream: ReadableStream<Uint8Array> | undefined): () => string {
  let text = "";
  if (stream !== undefined) {
    const decoder = new TextDecoder();
    void (async () => {
      for await (const chunk of stream) text += decoder.decode(chunk, { stream: true });
    })().catch((e: unknown) => void (text += `\n[stderr reader failed: ${String(e)}]`));
  }
  return () => text;
}

/** Runs `body`; a failure carries the exit state, the stderr and the end of server.log of the child, so a CI log says where it stopped. */
async function withChildReport<T>(
  child: { exitCode: number | null },
  logDir: string,
  stderr: () => string,
  body: () => Promise<T>,
): Promise<T> {
  try {
    return await body();
  } catch (e) {
    const logFile = join(logDir, "server.log");
    const tail = existsSync(logFile) ? readFileSync(logFile, "utf8").trimEnd().split("\n").slice(-40).join("\n") : "(no server.log was written)";
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(
      `${message}\n--- child exit code: ${child.exitCode} ---\n--- child stderr ---\n${stderr()}\n--- server.log, last lines ---\n${tail}`,
      { cause: e },
    );
  }
}

/** The stop marker keeps the daemon's pre-listen broker ensure from launching a real broker for the test. */
function entryEnv(home: string, extra: Record<string, string>): Record<string, string> {
  const env = {
    PATH: process.env["PATH"] ?? "",
    SystemRoot: process.env["SystemRoot"] ?? "",
    TEMP: process.env["TEMP"] ?? tmpdir(),
    TMP: process.env["TMP"] ?? tmpdir(),
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "AppData"),
    XDG_CONFIG_HOME: join(home, ".config"),
    CLAUDE_PEERS_LOG_DIR: join(home, "logs"),
    CLAUDE_PEERS_MCP_DAEMON_IDLE_SEC: "0",
    ...extra,
  };
  writeBrokerStopMarker(brokerStopMarkerPath(settingsFilePath(env)), {
    stopped_at: "2026-11-09T00:00:00.000Z",
    by: "test",
    killed_pid: null,
  });
  return env;
}

function waitForState(child: { exitCode: number | null }, found: () => boolean): Promise<void> {
  return reachedWithin(
    (async () => {
      while (!found()) {
        if (child.exitCode !== null) throw new Error(`the daemon exited with ${child.exitCode} before it served`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    })(),
    "the daemon process to serve",
    SERVE_WAIT_MS,
  );
}

describe("the broker before the first listen", () => {
  const request = { url: "http://127.0.0.1:1", settingsPath: "unused", env: {} };
  const ensured = { action: "already-running" } as const;

  test("the broker is ensured before the daemon listens", async () => {
    const [p0] = await freePorts(1);
    const events: string[] = [];
    const started = begin({
      ports: [p0 as number],
      brokerBeforeListen: request,
      brokers: {
        ensure: async (req) => {
          events.push(`ensure ${req.url}`);
          return ensured;
        },
      },
      start: (opts) => {
        events.push("listen");
        const handle = startDaemon(opts);
        handles.push(handle);
        return handle;
      },
    });
    await serving(started, p0 as number);
    expect(events, "the broker has to be ensured before the listening socket exists").toEqual([`ensure ${request.url}`, "listen"]);
  });

  test("a broker that never settles delays the listen by the wait of the injected clock, no more", async () => {
    expect(BROKER_FIRST_WAIT_MS, "the spawn follows a /health probe and has to fit inside the wait").toBeGreaterThan(HEALTH_TIMEOUT_MS);
    const [p0] = await freePorts(1);
    const clock = new FakeClock();
    const started = begin({
      ports: [p0 as number],
      clock,
      brokerBeforeListen: request,
      brokers: { ensure: () => new Promise(() => undefined) },
    });
    await settle();
    clock.advance(BROKER_FIRST_WAIT_MS - 1);
    await settle();
    expect(started.run.port()).toBeUndefined();
    clock.advance(1);
    await serving(started, p0 as number);
    expect(logOf(started.logDir)).toContain(`still starting after ${BROKER_FIRST_WAIT_MS} ms: listening anyway`);
  });

  test("a broker that cannot be ensured does not keep the daemon from listening", async () => {
    const [p0] = await freePorts(1);
    const started = begin({
      ports: [p0 as number],
      brokerBeforeListen: request,
      brokers: { ensure: () => Promise.reject(new Error("no bun")) },
    });
    await serving(started, p0 as number);
    expect(logOf(started.logDir)).toContain("could not be ensured before the listen");
  });

  function configuredEnv(config: Record<string, unknown> | null): Record<string, string> {
    const home = join(root, `cfg${++counter}`);
    const env = { APPDATA: join(home, "AppData"), XDG_CONFIG_HOME: join(home, ".config") };
    if (config !== null) {
      const file = settingsFilePath(env);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(config));
    }
    return env;
  }

  test("a local configuration gets a pre-listen request at the local broker URL", () => {
    const { log } = recordingLog();
    const env = { ...configuredEnv(null), CLAUDE_PEERS_PORT: "7123" };
    expect(brokerBeforeListenRequest(env, log)).toEqual({
      url: "http://127.0.0.1:7123",
      settingsPath: settingsFilePath(env),
      env,
    });
  });

  for (const [mode, config] of [
    ["replica", { broker_url: "http://192.0.2.1:7899", offline_replica: true }],
    ["remote", { broker_url: "http://192.0.2.1:7899" }],
  ] as const) {
    test(`a ${mode} configuration is not pre-ensured: no ensure before the listen, and the reason is logged`, async () => {
      const [p0] = await freePorts(1);
      const { log, lines } = recordingLog();
      const events: string[] = [];
      const started = begin({
        ports: [p0 as number],
        brokerBeforeListen: brokerBeforeListenRequest(configuredEnv(config), log),
        brokers: {
          ensure: async () => {
            events.push("ensure");
            return ensured;
          },
        },
        start: (opts) => {
          events.push("listen");
          const handle = startDaemon(opts);
          handles.push(handle);
          return handle;
        },
      });
      await serving(started, p0 as number);
      expect(events, `a ${mode} broker is not the daemon's to start`).toEqual(["listen"]);
      expect(lines).toContain(`broker not pre-ensured: ${mode}`);
    });
  }

  const connects = (port: number) =>
    Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {}, open() {}, close() {}, error() {} } }).then(
      (socket) => {
        socket.end();
        return true;
      },
      () => false,
    );

  test.skipIf(process.platform !== "win32")(
    "a process spawned after the listen keeps the daemon port bound, one spawned before does not (windows)",
    async () => {
      const sleeper = join(root, "sleeper.ts");
      writeFileSync(sleeper, 'import { writeFileSync } from "node:fs";\nwriteFileSync(process.argv[2], String(process.pid));\nsetTimeout(() => {}, 30000);\n');
      const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
      const { log } = recordingLog();
      const pids: number[] = [];
      const pidOf = async (file: string): Promise<number> => {
        await until(() => existsSync(file), "the spawned process to write its pid");
        const pid = Number(readFileSync(file, "utf8"));
        pids.push(pid);
        return pid;
      };
      try {
        const [after, before] = await freePorts(2);
        const lateFile = join(root, `late${++counter}.pid`);
        const late = begin({
          ports: [after as number],
          start: (opts) => {
            const handle = startDaemon(opts);
            handles.push(handle);
            spawnDetachedBroker(process.execPath, [sleeper, lateFile], env, log);
            return handle;
          },
        });
        await serving(late, after as number);
        await late.run.stop("test");
        await pidOf(lateFile);
        expect(await connects(after as number), "the inherited listening socket no longer keeps the port bound: this proof is vacuous").toBe(true);

        const earlyFile = join(root, `early${++counter}.pid`);
        const ensurer = createBrokerEnsurer({
          isAlive: async () => existsSync(earlyFile),
          locate: () => ({ command: process.execPath, script: sleeper }),
          spawn: (command, args, spawnEnv) => spawnDetachedBroker(command, [...args, earlyFile], spawnEnv, log),
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          baseEnv: env,
          home: root,
          log,
          pollMs: 20,
          stopped: () => null,
        });
        const early = begin({ ports: [before as number], brokers: ensurer, brokerBeforeListen: request });
        await serving(early, before as number);
        await early.run.stop("test");
        const pid = await pidOf(earlyFile);
        expect(() => process.kill(pid, 0), "the broker stand-in has to be alive when the port is probed").not.toThrow();
        expect(await connects(before as number), "the daemon port stayed bound after the daemon stopped").toBe(false);
      } finally {
        for (const pid of pids) {
          try {
            process.kill(pid);
          } catch {
            // The stand-in already exited by itself.
          }
        }
      }
    },
  );
});

describe("the entry point", () => {
  test(
    "a real process serves, drops the session variables of its shell, answers a status and stops on request",
    async () => {
      const [port] = await freePorts(1);
      const home = join(root, `entry${++counter}`);
      const logDir = join(home, "logs");
      linkTestKey(root, join(home, ".claude", "peers", "mcp-daemon.key"));
      const repo = join(import.meta.dir, "..");
      const child = Bun.spawn([process.execPath, join(repo, "mcp-daemon.ts")], {
        cwd: home,
        env: entryEnv(home, {
          CLAUDE_PEERS_MCP_DAEMON_PORT: String(port),
          CLAUDE_PEERS_FORCE_GROUP: "marker-of-the-group",
          CLAUDE_CODE_SESSION_ID: "marker-of-the-session",
        }),
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
      });
      const stderr = collectText(child.stderr as ReadableStream<Uint8Array>);
      const statePath = stateFilePath(join(home, ".claude", "peers"), port as number);
      try {
        await withChildReport(child, logDir, stderr, async () => {
          await waitForState(child, () => existsSync(statePath));
          const status = await controlRequest({ port: port as number, key, op: "status" });
          expect(status.kind).toBe("reply");
          const body = (status as { body: Record<string, unknown> }).body;
          expect(body["pid"]).toBe(child.pid);
          expect(body["code_root"]).toBe(daemonCodeRoot(realpathSync.native(repo)));
          expect(body["dropped_notifications"]).toBe(0);
          const log = logOf(logDir);
          expect(log).toContain("removed 2 session variable(s)");
          expect(log).toContain("CLAUDE_PEERS_FORCE_GROUP");
          expect(log).not.toContain("marker-of-the-group");
          expect(log).not.toContain("marker-of-the-session");
          expect(await controlRequest({ port: port as number, key, op: "stop" })).toEqual({
            kind: "reply",
            body: { ok: true },
          });
          expect(await reachedWithin(child.exited, "the daemon process to exit", EXIT_WAIT_MS)).toBe(0);
          expect(existsSync(statePath)).toBe(false);
        });
      } finally {
        if (child.exitCode === null) child.kill();
      }
    },
    ENTRY_TEST_MS,
  );

  test(
    "a real process serves the peers family and reaches its broker ensurer: a stopped local broker is refused by name",
    async () => {
      const [port, brokerPort] = await freePorts(2);
      const home = join(root, `entry${++counter}`);
      const logDir = join(home, "logs");
      linkTestKey(root, join(home, ".claude", "peers", "mcp-daemon.key"));
      const repo = join(import.meta.dir, "..");
      const child = Bun.spawn([process.execPath, join(repo, "mcp-daemon.ts")], {
        cwd: home,
        env: entryEnv(home, { CLAUDE_PEERS_MCP_DAEMON_PORT: String(port), CLAUDE_PEERS_PORT: String(brokerPort) }),
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
      });
      const stderr = collectText(child.stderr as ReadableStream<Uint8Array>);
      const statePath = stateFilePath(join(home, ".claude", "peers"), port as number);
      const sessionEnv = {
        APPDATA: join(home, "AppData"),
        XDG_CONFIG_HOME: join(home, ".config"),
        CLAUDE_PEERS_PORT: String(brokerPort),
      };
      writeBrokerStopMarker(brokerStopMarkerPath(settingsFilePath(sessionEnv)), {
        stopped_at: "2026-11-09T00:00:00.000Z",
        by: "test",
        killed_pid: null,
      });
      try {
        await withChildReport(child, logDir, stderr, async () => {
          await waitForState(child, () => existsSync(statePath));
          expect(logOf(logDir), "the entry point has to ensure the broker before it listens").toContain("broker before listen: skipped");
          const relay = await FakeRelay.open(port as number);
          const welcome = await relay.welcome({
            family: "peers",
            code_root: daemonCodeRoot(realpathSync.native(repo)),
            pid: process.pid,
            env: sessionEnv,
          });
          expect(welcome.family).toBe("peers");
          const reply = await relay.rpc(1, "tools/call", { name: "list_peers", arguments: { scope: "machine" } });
          expect(reply.result.isError).toBe(true);
          expect(reply.result.content[0].text).toContain("the local broker was stopped manually");
          expect(reply.result.content[0].text).toContain("(stopped at 2026-11-09T00:00:00.000Z)");
          expect(await controlRequest({ port: port as number, key, op: "stop" })).toEqual({ kind: "reply", body: { ok: true } });
          expect(await reachedWithin(child.exited, "the daemon process to exit", EXIT_WAIT_MS)).toBe(0);
        });
      } finally {
        if (child.exitCode === null) child.kill();
      }
    },
    ENTRY_TEST_MS,
  );

  test(
    "a real process started without USERNAME, as the relay starts it, listens on a port derived from the account name",
    async () => {
      const home = join(root, `entry${++counter}`);
      const peers = join(home, ".claude", "peers");
      const logDir = join(home, "logs");
      linkTestKey(root, join(peers, "mcp-daemon.key"));
      const oracle = accountNameFromTheSystem();
      // The child gets back the USERNAME of this process whatever env it is given, so this process drops it while the child starts.
      const savedUsername = process.env["USERNAME"];
      delete process.env["USERNAME"];
      let child: ReturnType<typeof Bun.spawn>;
      try {
        child = Bun.spawn([process.execPath, join(import.meta.dir, "..", "mcp-daemon.ts")], {
          cwd: home,
          env: entryEnv(home, {}),
          stdin: "ignore",
          stdout: "ignore",
          stderr: "pipe",
        });
      } finally {
        if (savedUsername !== undefined) process.env["USERNAME"] = savedUsername;
      }
      const stderr = collectText(child.stderr as ReadableStream<Uint8Array>);
      const stateFile = () => readdirSync(peers).find((f) => /^mcp-daemon-\d+\.json$/.test(f));
      let port = 0;
      try {
        await withChildReport(child, logDir, stderr, async () => {
          await waitForState(child, () => stateFile() !== undefined);
          port = Number((stateFile() as string).replace(/\D/g, ""));
          expect(candidatePorts(oracle, {}, recordingLog().log)).toContain(port);
        });
      } finally {
        if (port !== 0) await controlRequest({ port, key, op: "stop" });
        if (child.exitCode === null) await reachedWithin(child.exited, "the daemon process to exit", EXIT_WAIT_MS).catch(() => child.kill());
      }
    },
    ENTRY_TEST_MS,
  );
});
