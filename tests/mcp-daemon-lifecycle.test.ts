import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Logger } from "../shared/logger.ts";
import { controlRequest } from "../shared/mcp-daemon-control.ts";
import {
  candidatePorts,
  codeFingerprint,
  daemonCodeRoot,
  filetimeFromCreationUtc,
  fingerprintFiles,
  fnv1a32,
  idleSeconds,
  installProcessHandlers,
  launchLockPath,
  ownPidStart,
  runDaemon,
  scrubSessionEnv,
  stateFilePath,
  type DaemonRun,
  type RunDaemonOptions,
} from "../shared/mcp-daemon-lifecycle.ts";
import { FRAME_TYPE } from "../shared/mcp-daemon-protocol.ts";
import { startDaemon, type DaemonHandle } from "../shared/mcp-daemon-server.ts";
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

function begin(over: Partial<RunDaemonOptions> & { ports: number[]; home?: string }): Started {
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
    expect(candidatePorts("OLIVIER", {}, log)).toEqual(candidatePorts("olivier", {}, log));
  });

  test("the environment variable replaces the list with that single port", () => {
    expect(candidatePorts("olivier", { CLAUDE_PEERS_MCP_DAEMON_PORT: "50123" }, log)).toEqual([50123]);
  });

  test.each(["abc", "0", "70000", "12.5", "-3"])("an invalid port override %p is logged and ignored", (value) => {
    const recorded = recordingLog();
    expect(candidatePorts("olivier", { CLAUDE_PEERS_MCP_DAEMON_PORT: value }, recorded.log)).toHaveLength(10);
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

  test("converts a PowerShell creation time to the FILETIME measured on this machine", () => {
    expect(filetimeFromCreationUtc("2026-11-08T17:22:36.7733341Z")).toBe("134386321567733341");
    expect(filetimeFromCreationUtc("2026-11-08T17:22:36.5Z")).toBe("134386321565000000");
    expect(filetimeFromCreationUtc("not a date")).toBeNull();
  });

  test.skipIf(process.platform !== "win32")("Windows only: the own start time is a FILETIME in the fixture's range", async () => {
    const value = await ownPidStart(recordingLog().log);
    expect(value).toMatch(/^\d{18}$/);
    expect(Number(value)).toBeGreaterThan(fixture.pid_start.windows.min);
    expect(Number(value)).toBeLessThan(fixture.pid_start.windows.max);
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
      },
    });
    const relay = await FakeRelay.open(p0 as number);
    await relay.welcome({ cwd: "/work/status" });
    const after = await controlRequest({ port: p0 as number, key, op: "status" });
    expect(after.kind === "reply" && after.body["sessions"]).toBe(1);
    relay.close();
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

describe("the entry point", () => {
  test("a real process serves, drops the session variables of its shell, answers a status and stops on request", async () => {
    const [port] = await freePorts(1);
    const home = join(root, `entry${++counter}`);
    const logDir = join(home, "logs");
    linkTestKey(root, join(home, ".claude", "peers", "mcp-daemon.key"));
    const repo = join(import.meta.dir, "..");
    const env: Record<string, string> = {
      PATH: process.env["PATH"] ?? "",
      SystemRoot: process.env["SystemRoot"] ?? "",
      TEMP: process.env["TEMP"] ?? tmpdir(),
      TMP: process.env["TMP"] ?? tmpdir(),
      HOME: home,
      USERPROFILE: home,
      APPDATA: join(home, "AppData"),
      CLAUDE_PEERS_LOG_DIR: logDir,
      CLAUDE_PEERS_MCP_DAEMON_PORT: String(port),
      CLAUDE_PEERS_MCP_DAEMON_IDLE_SEC: "0",
      CLAUDE_PEERS_FORCE_GROUP: "marker-of-the-group",
      CLAUDE_CODE_SESSION_ID: "marker-of-the-session",
    };
    const child = Bun.spawn([process.execPath, join(repo, "mcp-daemon.ts")], {
      cwd: home,
      env,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    });
    const statePath = stateFilePath(join(home, ".claude", "peers"), port as number);
    try {
      await reachedWithin(
        (async () => {
          while (!existsSync(statePath)) {
            if (child.exitCode !== null) {
              throw new Error(`the daemon exited with ${child.exitCode}: ${await new Response(child.stderr).text()}`);
            }
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
        })(),
        "the daemon process to serve",
        20_000,
      );
      const status = await controlRequest({ port: port as number, key, op: "status" });
      expect(status.kind).toBe("reply");
      const body = (status as { body: Record<string, unknown> }).body;
      expect(body["pid"]).toBe(child.pid);
      expect(body["code_root"]).toBe(daemonCodeRoot(realpathSync.native(repo)));
      const log = logOf(logDir);
      expect(log).toContain("removed 2 session variable(s)");
      expect(log).toContain("CLAUDE_PEERS_FORCE_GROUP");
      expect(log).not.toContain("marker-of-the-group");
      expect(log).not.toContain("marker-of-the-session");
      expect(await controlRequest({ port: port as number, key, op: "stop" })).toEqual({
        kind: "reply",
        body: { ok: true },
      });
      expect(await reachedWithin(child.exited, "the daemon process to exit", 10_000)).toBe(0);
      expect(existsSync(statePath)).toBe(false);
    } finally {
      if (child.exitCode === null) child.kill();
    }
  });
});
