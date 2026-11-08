import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../shared/logger.ts";
import { controlRequest, type ControlOutcome, type ControlRequestOptions } from "../shared/mcp-daemon-control.ts";
import { candidatePorts, codeFingerprint, daemonCodeRoot, stateFilePath } from "../shared/mcp-daemon-lifecycle.ts";
import { startDaemon } from "../shared/mcp-daemon-server.ts";
import { runMcpDaemonCommand, type McpDaemonDeps } from "../shared/mcp-daemon-status.ts";

const KEY_HEX = "ab".repeat(32);
const bases: string[] = [];

afterAll(() => {
  for (const base of bases) rmSync(base, { recursive: true, force: true });
});

interface Calls {
  control: ControlRequestOptions[];
  kills: Array<{ pid: number; at: number }>;
  alive: number[];
}

interface Fixture {
  deps: McpDaemonDeps;
  base: string;
  ports: number[];
  ourRoot: string;
  printed: string[];
  calls: Calls;
  clock: { now: number };
  writeKey(text?: string): void;
  writeState(port: number, patch?: Record<string, unknown>): void;
  disk: string;
}

/** A clone with a code directory, a peers directory, scripted control replies and a virtual clock. */
function fixture(overrides: Partial<McpDaemonDeps> = {}): Fixture {
  const base = mkdtempSync(join(tmpdir(), "mcp-daemon-status-"));
  bases.push(base);
  const codeDir = join(base, "clone");
  mkdirSync(join(codeDir, "shared"), { recursive: true });
  writeFileSync(join(codeDir, "mcp-daemon.ts"), "entry");
  writeFileSync(join(codeDir, "shared", "a.ts"), "module");
  const peersDir = join(base, "home", ".claude", "peers");
  const log = createLogger({ dir: join(base, "logs"), name: "server", mirrorToConsole: false }).child("test");
  const printed: string[] = [];
  const calls: Calls = { control: [], kills: [], alive: [] };
  const clock = { now: 0 };
  const ports = candidatePorts("tester", {}, log);
  const ourRoot = daemonCodeRoot(codeDir);
  const deps: McpDaemonDeps = {
    peersDir,
    username: "tester",
    env: {},
    codeDir,
    log,
    control: async (opts) => {
      calls.control.push(opts);
      return { kind: "free" };
    },
    pidStartOf: async () => null,
    imageOf: async () => null,
    isAlive: (pid) => {
      calls.alive.push(pid);
      return false;
    },
    kill: (pid) => void calls.kills.push({ pid, at: clock.now }),
    sleep: async (ms) => void (clock.now += ms),
    now: () => clock.now,
    print: (line) => void printed.push(line),
    ...overrides,
  };
  return {
    deps,
    base,
    ports,
    ourRoot,
    printed,
    calls,
    clock,
    disk: codeFingerprint(codeDir),
    writeKey: (text = KEY_HEX) => {
      mkdirSync(peersDir, { recursive: true });
      writeFileSync(join(peersDir, "mcp-daemon.key"), text, { mode: 0o600 });
    },
    writeState: (port, patch = {}) => {
      mkdirSync(peersDir, { recursive: true });
      const state = { pid: 4242, pid_start: "100", port, code_root: ourRoot, code_fingerprint: "f", version: "1", instance: "i", started_at: "t", ...patch };
      writeFileSync(stateFilePath(peersDir, port), JSON.stringify(state));
    },
  };
}

function reply(body: Record<string, unknown>): ControlOutcome {
  return { kind: "reply", body };
}

function daemonBody(root: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { pid: 4242, pid_start: "100", code_root: root, code_fingerprint: "f", version: "1", sessions: 1, ...over };
}

const output = (f: Fixture): string => f.printed.join("\n");

describe("the key is read, never created", () => {
  test("status and restart say the key is absent, exit 0 and create nothing", async () => {
    const f = fixture();
    expect(await runMcpDaemonCommand(["status"], f.deps)).toBe(0);
    expect(await runMcpDaemonCommand(["restart"], f.deps)).toBe(0);
    expect(output(f)).toContain("no key at");
    expect(existsSync(join(f.base, "home")), "a command that only reads must not create the peers directory or the key").toBe(false);
    expect(f.calls.control, "without a key there is nothing to authenticate with").toEqual([]);
  });

  test("a key that is not 64 hexadecimal characters is refused and said", async () => {
    const f = fixture();
    f.writeKey("zz");
    expect(await runMcpDaemonCommand(["status"], f.deps)).toBe(1);
    expect(output(f)).toContain("64 hexadecimal");
    expect(f.calls.control).toEqual([]);
  });

  test.skipIf(process.platform === "win32")("a key readable by group or others is refused (POSIX modes only)", async () => {
    const f = fixture();
    f.writeKey();
    chmodSync(join(f.deps.peersDir, "mcp-daemon.key"), 0o644);
    expect(await runMcpDaemonCommand(["status"], f.deps)).toBe(1);
    expect(output(f)).toContain("is refused");
    expect(f.calls.control).toEqual([]);
  });

  test("an unknown action prints the usage and exits 2", async () => {
    const f = fixture();
    expect(await runMcpDaemonCommand(["stop"], f.deps)).toBe(2);
    expect(output(f)).toContain("usage:");
  });
});

describe("status", () => {
  test("it prints one line per port and flags only a daemon whose fingerprint differs from the disk as stale", async () => {
    let byPort = new Map<number, ControlOutcome>();
    const f = fixture({ control: async (opts) => byPort.get(opts.port) ?? { kind: "free" } });
    f.writeKey();
    byPort = new Map<number, ControlOutcome>([
      [f.ports[1] as number, reply(daemonBody(f.ourRoot, { pid: 111, sessions: 2, code_fingerprint: f.disk }))],
      [f.ports[2] as number, reply(daemonBody(f.ourRoot, { pid: 222, code_fingerprint: "00".repeat(32) }))],
      [f.ports[3] as number, reply(daemonBody("e".repeat(64), { pid: 333 }))],
      [f.ports[4] as number, { kind: "foreign", cause: "no answer at stage challenge within 3000 ms" }],
      [f.ports[5] as number, reply({ nothing: true })],
    ]);

    const code = await runMcpDaemonCommand(["status"], f.deps);

    const lines = new Map<number, string>();
    for (const line of f.printed) {
      const m = /^port (\d+): /.exec(line);
      if (m) lines.set(Number(m[1]), line);
    }
    expect(code).toBe(0);
    expect(lines.size, "one line per candidate port").toBe(f.ports.length);
    expect(lines.get(f.ports[0] as number)).toBe(`port ${f.ports[0]}: free`);
    const current = lines.get(f.ports[1] as number) as string;
    expect(current).toContain("daemon pid 111");
    expect(current).toContain("2 session(s)");
    expect(current, "a daemon running the code on disk is not stale").not.toContain("stale");
    expect(lines.get(f.ports[2] as number), "a different fingerprint is a stale daemon").toContain("daemon code is stale");
    expect(lines.get(f.ports[3] as number)).toContain("another code root");
    expect(lines.get(f.ports[4] as number)).toContain("no answer");
    expect(lines.get(f.ports[5] as number)).toContain("unexpected body");
  });
});

describe("sessions in bun fallback", () => {
  function fallbackFixture() {
    const alive = new Set([4001, 4003, 4004]);
    const starts = new Map<number, string>([
      [4001, "100"],
      [4003, "999"],
    ]);
    const f = fixture({ isAlive: (pid) => alive.has(pid), pidStartOf: async (pid) => starts.get(pid) ?? null });
    f.writeKey();
    const write = (name: string, body: unknown) => writeFileSync(join(f.deps.peersDir, name), typeof body === "string" ? body : JSON.stringify(body));
    const record = (pid: number, pidStart: string) => ({ pid, pid_start: pidStart, family: "peers", cause: `cause ${pid}`, fallback: "server.ts", started_at: 1_700_000_000 });
    write("mcp-fallback-4001.json", record(4001, "100"));
    write("mcp-fallback-4002.json", record(4002, "100"));
    write("mcp-fallback-4003.json", record(4003, "100"));
    write("mcp-fallback-4004.json", record(4004, ""));
    write("mcp-fallback-4005.json", "{ not json");
    return f;
  }

  test("a live session whose start time matches is listed, one with an empty recorded start is kept", async () => {
    const f = fallbackFixture();
    await runMcpDaemonCommand(["status"], f.deps);
    expect(output(f)).toContain("fallback: pid 4001, family peers");
    expect(output(f)).toContain("cause 4001");
    expect(output(f)).toContain("fallback: pid 4004");
  });

  test("a file whose pid is dead is ignored", async () => {
    const f = fallbackFixture();
    await runMcpDaemonCommand(["status"], f.deps);
    expect(output(f)).not.toContain("pid 4002");
  });

  test("a file whose recorded start time no longer matches the process is ignored as a reused pid", async () => {
    const f = fallbackFixture();
    await runMcpDaemonCommand(["status"], f.deps);
    expect(output(f)).not.toContain("pid 4003");
    expect(output(f)).toContain("2 fallback file(s) ignored");
  });

  test("a file that is not JSON is reported, not fatal", async () => {
    const f = fallbackFixture();
    expect(await runMcpDaemonCommand(["status"], f.deps)).toBe(0);
    expect(output(f)).toContain("ignored mcp-fallback-4005.json: unreadable");
  });

  test("a file holding null, an array or a number is reported, not fatal", async () => {
    const f = fixture({ isAlive: () => true });
    f.writeKey();
    for (const [pid, text] of [[5001, "null"], [5002, "[]"], [5003, "123"]] as const) {
      writeFileSync(join(f.deps.peersDir, `mcp-fallback-${pid}.json`), text);
    }
    expect(await runMcpDaemonCommand(["status"], f.deps)).toBe(0);
    for (const pid of [5001, 5002, 5003]) {
      expect(output(f)).toContain(`ignored mcp-fallback-${pid}.json: unreadable (not a JSON object)`);
    }
  });

  test("a started_at that is not a plausible date is shown as an unknown time", async () => {
    const f = fixture({ isAlive: () => true });
    f.writeKey();
    const body = (pid: number, startedAt: string) =>
      `{"pid":${pid},"pid_start":"","family":"peers","cause":"c${pid}","started_at":${startedAt}}`;
    writeFileSync(join(f.deps.peersDir, "mcp-fallback-6001.json"), body(6001, "1e999"));
    writeFileSync(join(f.deps.peersDir, "mcp-fallback-6002.json"), body(6002, "9e15"));
    writeFileSync(join(f.deps.peersDir, "mcp-fallback-6003.json"), body(6003, "-5"));
    writeFileSync(join(f.deps.peersDir, "mcp-fallback-6004.json"), body(6004, '"1700000000"'));
    writeFileSync(join(f.deps.peersDir, "mcp-fallback-6005.json"), body(6005, "null"));

    expect(await runMcpDaemonCommand(["status"], f.deps)).toBe(0);

    for (const pid of [6001, 6002, 6003, 6004, 6005]) {
      expect(output(f)).toContain(`fallback: pid ${pid}, family peers, since an unknown time: c${pid}`);
    }
  });

  test("control characters of a fallback file or of a reply never reach the output", async () => {
    const f = fixture({
      isAlive: () => true,
      control: async (opts) => (opts.port === f.ports[1] ? { kind: "foreign", cause: "bad\u001b[31m" } : { kind: "free" }),
    });
    f.writeKey();
    writeFileSync(
      join(f.deps.peersDir, "mcp-fallback-7001.json"),
      JSON.stringify({ pid: 7001, pid_start: "", family: "peers\u001b[2J\u009b1;1H\u007f", cause: "first\nfake line: pid 9999", started_at: 1_700_000_000 }),
    );

    expect(await runMcpDaemonCommand(["status"], f.deps)).toBe(0);

    for (const line of f.printed) expect(line, `a control character reached the output: ${JSON.stringify(line)}`).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(output(f), "ESC, a C1 control and DEL are all replaced").toContain("peers?[2J?1;1H?");
    expect(output(f), "a newline in a cause must not start a second line").toContain("first?fake line: pid 9999");
    expect(output(f)).toContain("bad?[31m");
  });
});

describe("restart", () => {
  const MINE_PID = 4242;

  function stuckDaemon(over: Partial<McpDaemonDeps> = {}, statePatch: Record<string, unknown> = {}) {
    let alive = true;
    let f!: Fixture;
    f = fixture({
      control: async (opts) => {
        f.calls.control.push(opts);
        const mineReply = reply(daemonBody(f.ourRoot, { pid: MINE_PID }));
        if (opts.op === "stop") return { kind: "foreign", cause: "no answer" } as ControlOutcome;
        return opts.port === f.ports[1] ? mineReply : { kind: "free" };
      },
      isAlive: (pid) => {
        f.calls.alive.push(pid);
        return pid === MINE_PID && alive;
      },
      pidStartOf: async () => "100",
      imageOf: async () => "bun.exe",
      kill: (pid) => {
        f.calls.kills.push({ pid, at: f.clock.now });
        alive = false;
      },
      ...over,
    });
    f.writeKey();
    f.writeState(f.ports[1] as number, statePatch);
    return f;
  }

  test("it asks the daemon of this clone to stop and does not touch a process that goes away", async () => {
    let stopped = false;
    let f!: Fixture;
    f = fixture({
      control: async (opts) => {
        f.calls.control.push(opts);
        if (opts.op === "stop") {
          stopped = true;
          return reply({ stopping: true });
        }
        return opts.port === f.ports[1] && !stopped ? reply(daemonBody(f.ourRoot)) : { kind: "free" };
      },
    });
    f.writeKey();

    expect(await runMcpDaemonCommand(["restart"], f.deps)).toBe(0);

    expect(f.calls.control.filter((c) => c.op === "stop").map((c) => c.port)).toEqual([f.ports[1] as number]);
    expect(f.calls.kills, "a daemon that stops on request is never killed").toEqual([]);
    expect(output(f)).toContain("asking the daemon (pid 4242) to stop");
    expect(output(f)).toContain("stopped");
  });

  test("a daemon that stays after the request for 5 s has its state-file pid stopped, not before", async () => {
    const f = stuckDaemon();
    expect(await runMcpDaemonCommand(["restart"], f.deps)).toBe(0);
    expect(f.calls.kills.map((k) => k.pid)).toEqual([MINE_PID]);
    expect(f.calls.kills[0]?.at, "the pid is stopped only once 5 s of virtual time have passed").toBeGreaterThanOrEqual(5000);
    expect(output(f)).toContain("stopped pid 4242");
  });

  test("a daemon of another code root is neither asked to stop nor killed", async () => {
    const f = fixture({
      control: async (opts) => {
        f.calls.control.push(opts);
        return opts.port === f.ports[1] ? reply(daemonBody("e".repeat(64))) : { kind: "free" };
      },
    });
    f.writeKey();
    f.writeState(f.ports[1] as number, { code_root: "e".repeat(64) });

    expect(await runMcpDaemonCommand(["restart"], f.deps)).toBe(0);

    expect(f.calls.control.filter((c) => c.op === "stop")).toEqual([]);
    expect(f.calls.kills).toEqual([]);
    expect(output(f)).toContain("no daemon of this clone is running");
  });

  test("a silent port whose state file names another code root is left alone", async () => {
    const f = fixture({
      control: async (opts) => (opts.port === f.ports[2] ? { kind: "foreign", cause: "no answer" } : { kind: "free" }),
      isAlive: () => true,
      pidStartOf: async () => "100",
      imageOf: async () => "bun",
    });
    f.writeKey();
    f.writeState(f.ports[2] as number, { code_root: "e".repeat(64) });

    expect(await runMcpDaemonCommand(["restart"], f.deps)).toBe(0);

    expect(f.calls.kills, "a stuck daemon of another root is never stopped from here").toEqual([]);
    expect(output(f)).toContain("another code root");
  });

  test("a silent port whose state file names this clone but whose pid is gone makes restart fail", async () => {
    const f = fixture({
      control: async (opts) => (opts.port === f.ports[2] ? { kind: "foreign", cause: "no answer" } : { kind: "free" }),
    });
    f.writeKey();
    f.writeState(f.ports[2] as number);

    expect(await runMcpDaemonCommand(["restart"], f.deps)).toBe(1);

    expect(output(f)).toContain("is not running");
    expect(f.calls.kills).toEqual([]);
  });

  test("with no daemon of this clone it says so and exits 0", async () => {
    const f = fixture();
    f.writeKey();
    expect(await runMcpDaemonCommand(["restart"], f.deps)).toBe(0);
    expect(output(f)).toContain("no daemon of this clone is running");
    expect(f.calls.kills).toEqual([]);
  });

  const refusals: Array<{ name: string; patch?: Record<string, unknown>; deps?: Partial<McpDaemonDeps>; says: string }> = [
    { name: "another code root in the state file", patch: { code_root: "e".repeat(64) }, says: "another code root" },
    { name: "a pid of 0", patch: { pid: 0 }, says: "not one this command may stop" },
    { name: "a pid above i32::MAX", patch: { pid: 2147483648 }, says: "not one this command may stop" },
    { name: "a negative pid", patch: { pid: -7 }, says: "not one this command may stop" },
    { name: "a fractional pid", patch: { pid: 1.5 }, says: "not one this command may stop" },
    { name: "a pid that is not running", deps: { isAlive: () => false }, says: "is not running" },
    { name: "a creation time that differs from pid_start", deps: { pidStartOf: async () => "101" }, says: "the pid was reused" },
    { name: "an empty pid_start", patch: { pid_start: "" }, says: "no creation time" },
    { name: "a creation time that cannot be measured", deps: { pidStartOf: async () => null }, says: "cannot be measured" },
    { name: "an image that is neither kory-mcp-daemon nor bun", deps: { imageOf: async () => "explorer.exe" }, says: "not kory-mcp-daemon or bun" },
    { name: "an image that cannot be read", deps: { imageOf: async () => null }, says: "image of pid 4242 cannot be read" },
  ];

  for (const row of refusals) {
    test(`it refuses to stop a pid with ${row.name}, says why, and exits 1`, async () => {
      const f = stuckDaemon(row.deps, row.patch);
      expect(await runMcpDaemonCommand(["restart"], f.deps)).toBe(1);
      expect(f.calls.kills, `the check for ${row.name} is missing`).toEqual([]);
      expect(output(f)).toContain(row.says);
    });
  }

  test("a pid outside 1..i32::MAX is rejected before any liveness probe", async () => {
    const f = stuckDaemon(undefined, { pid: 0 });
    await runMcpDaemonCommand(["restart"], f.deps);
    expect(f.calls.alive, "signalling pid 0 would reach a whole process group").not.toContain(0);
  });

  for (const text of ["{ not json", "null", "[]", "42"]) {
    test(`a state file holding ${text} is a refusal, not a crash`, async () => {
      const f = stuckDaemon();
      writeFileSync(stateFilePath(f.deps.peersDir, f.ports[1] as number), text);
      expect(await runMcpDaemonCommand(["restart"], f.deps)).toBe(1);
      expect(output(f)).toContain("cannot read");
      expect(f.calls.kills).toEqual([]);
    });
  }

  test("a pid whose creation time changes between the two measures is not stopped", async () => {
    let measures = 0;
    const f = stuckDaemon({ pidStartOf: async () => (++measures === 1 ? "100" : "101") });
    expect(await runMcpDaemonCommand(["restart"], f.deps)).toBe(1);
    expect(f.calls.kills, "the creation time must be measured again right before the kill").toEqual([]);
    expect(output(f)).toContain("changed creation time while it was being checked");
  });

  test("a failing kill and a process that survives it are both reported", async () => {
    const failing = stuckDaemon({
      kill: () => {
        throw new Error("access denied");
      },
    });
    expect(await runMcpDaemonCommand(["restart"], failing.deps)).toBe(1);
    expect(output(failing)).toContain("failed (access denied)");

    const survivor = stuckDaemon({ kill: () => undefined });
    expect(await runMcpDaemonCommand(["restart"], survivor.deps)).toBe(1);
    expect(output(survivor)).toContain("still running after being stopped");
  });

  test("a process that needs a moment to exit after the kill is still reported as stopped", async () => {
    let killedAt: number | undefined;
    const f = stuckDaemon({
      kill: (pid) => {
        f.calls.kills.push({ pid, at: f.clock.now });
        killedAt = f.clock.now;
      },
      isAlive: (pid) => pid === MINE_PID && (killedAt === undefined || f.clock.now < killedAt + 300),
    });
    expect(await runMcpDaemonCommand(["restart"], f.deps)).toBe(0);
    expect(output(f)).toContain("stopped pid 4242");
  });

  test("a daemon that stays after the request and has no state file leaves restart failing", async () => {
    const f = stuckDaemon();
    rmSync(stateFilePath(f.deps.peersDir, f.ports[1] as number));
    expect(await runMcpDaemonCommand(["restart"], f.deps)).toBe(1);
    expect(output(f)).toContain("there is no state file");
    expect(f.calls.kills).toEqual([]);
  });

  for (const image of ["BUN.EXE", "kory-mcp-daemon", "Kory-MCP-Daemon.exe"]) {
    test(`an image named ${image} is accepted`, async () => {
      const f = stuckDaemon({ imageOf: async () => image });
      expect(await runMcpDaemonCommand(["restart"], f.deps)).toBe(0);
      expect(f.calls.kills.map((k) => k.pid)).toEqual([MINE_PID]);
    });
  }
});

describe("against a real daemon on a loopback port", () => {
  test("status reads the live reply and restart stops it through CONTROL", async () => {
    const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
    const port = probe.port as number;
    await probe.stop(true);
    const f = fixture({ control: controlRequest, env: { CLAUDE_PEERS_MCP_DAEMON_PORT: String(port) } });
    f.writeKey();
    let live = true;
    const daemon = startDaemon({
      port,
      keyPath: join(f.deps.peersDir, "mcp-daemon.key"),
      key: Buffer.from(KEY_HEX, "hex"),
      logDir: join(f.base, "logs"),
      codeRoot: f.ourRoot,
      families: {},
      control: {
        status: () => ({ pid: process.pid, pid_start: "x", port, code_root: f.ourRoot, code_fingerprint: f.disk, version: "1", sessions: 0 }),
        stop: () => {
          live = false;
          void daemon.stop();
        },
      },
    });
    try {
      expect(await runMcpDaemonCommand(["status"], f.deps)).toBe(0);
      expect(output(f)).toContain(`port ${port}: daemon pid ${process.pid}`);
      expect(output(f)).not.toContain("stale");

      f.printed.length = 0;
      expect(await runMcpDaemonCommand(["restart"], { ...f.deps, sleep: (ms) => Bun.sleep(Math.min(ms, 20)), now: Date.now })).toBe(0);
      expect(live, "the daemon received CONTROL stop").toBe(false);
      expect(output(f)).toContain(`port ${port}: stopped`);
    } finally {
      await daemon.stop();
    }
  });
});
