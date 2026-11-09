import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  brokerAnswers,
  createBrokerEnsurer,
  daemonBrokerDeps,
  locateCodeRootBroker,
  spawnDetachedBroker,
  type BrokerEnsureRequest,
  type BrokerEnsurerDeps,
} from "../shared/broker-ensure.ts";
import { brokerStopMarkerPath, writeBrokerStopMarker } from "../shared/broker-stop-marker.ts";
import type { Logger } from "../shared/logger.ts";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function settingsPathInFreshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "broker-ensure-"));
  roots.push(dir);
  return join(dir, "config.json");
}

function request(over: Partial<BrokerEnsureRequest> = {}): BrokerEnsureRequest {
  return {
    url: "http://127.0.0.1:7899",
    settingsPath: "unused-settings.json",
    env: {},
    ...over,
  };
}

interface Rig {
  deps: BrokerEnsurerDeps;
  spawns: Array<{ command: string; args: string[]; env: Record<string, string> }>;
  health: { alive: boolean };
  sleeps: number[];
  checks: number;
  lines: string[];
}

/** A broker that answers /health once it was spawned, unless `neverAlive`. */
function rig(over: Partial<BrokerEnsurerDeps> & { neverAlive?: boolean } = {}): Rig {
  const { neverAlive, ...depsOver } = over;
  const { log, lines } = recordingLog();
  const state: Rig = {
    spawns: [],
    health: { alive: false },
    sleeps: [],
    checks: 0,
    lines,
    deps: {
      isAlive: async () => {
        state.checks++;
        return state.health.alive;
      },
      stopped: () => false,
      locate: () => ({ command: "/bin/bun", script: "/code/broker.ts" }),
      spawn: (command, args, env) => {
        state.spawns.push({ command, args, env });
        if (!neverAlive) state.health.alive = true;
      },
      sleep: async (ms) => void state.sleeps.push(ms),
      baseEnv: { BASE: "1" },
      home: "/home/u",
      log,
      platform: "linux",
      attempts: 3,
      pollMs: 10,
      ...depsOver,
    },
  };
  return state;
}

describe("single flight", () => {
  test("two simultaneous ensures on one URL spawn the broker once and share the outcome", async () => {
    const r = rig();
    const ensurer = createBrokerEnsurer(r.deps);
    const [a, b] = await Promise.all([ensurer.ensure(request()), ensurer.ensure(request())]);
    expect(r.spawns).toHaveLength(1);
    expect(a).toEqual({ action: "started", script: "/code/broker.ts" });
    expect(b).toEqual(a);
  });

  test("two brokers at different addresses do not wait for each other", async () => {
    const r = rig({ spawn: (command, args, env) => void r.spawns.push({ command, args, env }) });
    const ensurer = createBrokerEnsurer({ ...r.deps, isAlive: async () => r.spawns.length >= 2 });
    await Promise.all([
      ensurer.ensure(request({ url: "http://127.0.0.1:7899" })),
      ensurer.ensure(request({ url: "http://127.0.0.1:7898" })),
    ]);
    expect(r.spawns).toHaveLength(2);
  });

  test("the flight is keyed by the URL the loopback check ran on: spellings of one address share a launch", async () => {
    const r = rig();
    const ensurer = createBrokerEnsurer(r.deps);
    await Promise.all(
      ["http://127.0.0.1:7899", "http://127.0.0.1:7899/", "HTTP://127.0.0.1:7899/health", "http://127.0.0.1:7899/?x=1"].map((url) =>
        ensurer.ensure(request({ url })),
      ),
    );
    expect(r.spawns).toHaveLength(1);
  });

  test("a session that joins a launch with other broker settings is accepted and the differing names are logged, never the values", async () => {
    const r = rig();
    const ensurer = createBrokerEnsurer(r.deps);
    const same = { CLAUDE_PEERS_PORT: "7899", CLAUDE_PEERS_BROKER_TOKEN: "tok-AAA" };
    await Promise.all([
      ensurer.ensure(request({ env: same, settingsPath: "/a/config.json" })),
      ensurer.ensure(request({ env: same, settingsPath: "/a/config.json" })),
    ]);
    expect(r.lines).toEqual([]);

    const r2 = rig();
    const ensurer2 = createBrokerEnsurer(r2.deps);
    const [first, second] = await Promise.all([
      ensurer2.ensure(request({ env: same, settingsPath: "/a/config.json" })),
      ensurer2.ensure(request({ env: { CLAUDE_PEERS_PORT: "7899", CLAUDE_PEERS_BROKER_TOKEN: "tok-BBB", CLAUDE_PEERS_DB: "/x" }, settingsPath: "/b/config.json" })),
    ]);
    expect(second).toEqual(first);
    expect(r2.spawns).toHaveLength(1);
    expect(r2.lines).toHaveLength(1);
    expect(r2.lines[0]).toContain("CLAUDE_PEERS_BROKER_TOKEN, CLAUDE_PEERS_DB, settingsPath");
    expect(r2.lines[0]).not.toContain("CLAUDE_PEERS_PORT");
    for (const secret of ["tok-AAA", "tok-BBB", "/x", "/a/", "/b/"]) expect(r2.lines[0], secret).not.toContain(secret);
  });

  test("a finished flight is forgotten: the next ensure on the same URL starts again", async () => {
    const r = rig({ neverAlive: true });
    const ensurer = createBrokerEnsurer(r.deps);
    expect(await ensurer.ensure(request())).toMatchObject({ action: "failed" });
    expect(await ensurer.ensure(request())).toMatchObject({ action: "failed" });
    expect(r.spawns).toHaveLength(2);
  });

  test("a rejected health probe frees the flight so the next ensure can try again", async () => {
    let calls = 0;
    const r = rig({
      isAlive: async () => {
        if (++calls === 1) throw new Error("probe exploded");
        return true;
      },
    });
    const ensurer = createBrokerEnsurer(r.deps);
    await expect(ensurer.ensure(request())).rejects.toThrow("probe exploded");
    expect(await ensurer.ensure(request())).toEqual({ action: "already-running" });
  });
});

describe("what ensure refuses to spawn for", () => {
  test("a broker that already answers is left alone, and the stop marker is not read", async () => {
    let markerReads = 0;
    const r = rig({
      stopped: () => {
        markerReads++;
        return true;
      },
    });
    r.health.alive = true;
    expect(await createBrokerEnsurer(r.deps).ensure(request())).toEqual({ action: "already-running" });
    expect(r.spawns).toHaveLength(0);
    expect(markerReads).toBe(0);
  });

  test("a URL that is not loopback is never spawned for and never probed", async () => {
    const r = rig();
    const ensurer = createBrokerEnsurer(r.deps);
    expect(await ensurer.ensure(request({ url: "https://broker.example:7899" }))).toEqual({ action: "skipped", reason: "remote-mode" });
    expect(r.spawns).toHaveLength(0);
    expect(r.checks).toBe(0);
  });

  test("a URL that cannot be parsed is a failure with its reason and a log line, not a remote broker", async () => {
    const errors: string[] = [];
    const log: Logger = { info: () => {}, warn: () => {}, error: (m) => void errors.push(m), child: () => log, file: "" };
    const r = rig({ log });
    const outcome = await createBrokerEnsurer(r.deps).ensure(request({ url: "not a url" }));
    expect(outcome).toEqual({ action: "failed", script: "", reason: "invalid broker URL: not a url" });
    expect(errors).toEqual(["broker launch failed: invalid broker URL: not a url"]);
    expect(r.spawns).toHaveLength(0);
    expect(r.checks).toBe(0);
  });

  test("the operator's stop marker holds the broker down, read or not", async () => {
    const settingsPath = settingsPathInFreshDir();
    const r = rig({ stopped: undefined });
    const ensurer = createBrokerEnsurer(r.deps);

    writeBrokerStopMarker(brokerStopMarkerPath(settingsPath), { stopped_at: "t", by: "operator", killed_pid: null });
    expect(await ensurer.ensure(request({ settingsPath }))).toEqual({ action: "skipped", reason: "manual-stop" });

    writeFileSync(brokerStopMarkerPath(settingsPath), "{ not json");
    expect(await ensurer.ensure(request({ settingsPath }))).toEqual({ action: "skipped", reason: "manual-stop" });
    expect(r.spawns).toHaveLength(0);
  });

  test("without a marker the broker is spawned", async () => {
    const r = rig({ stopped: undefined });
    const outcome = await createBrokerEnsurer(r.deps).ensure(request({ settingsPath: settingsPathInFreshDir() }));
    expect(outcome).toMatchObject({ action: "started" });
  });

  test("no broker script to run is reported, not guessed", async () => {
    const r = rig({ locate: () => null });
    expect(await createBrokerEnsurer(r.deps).ensure(request())).toEqual({ action: "not-found" });
    expect(r.spawns).toHaveLength(0);
  });
});

describe("after the spawn", () => {
  test("a spawn that throws is a failure with the reason, and the next ensure retries", async () => {
    let first = true;
    const r = rig({
      spawn: (command, args, env) => {
        if (first) {
          first = false;
          throw new Error("ENOENT bun");
        }
        r.spawns.push({ command, args, env });
        r.health.alive = true;
      },
    });
    const ensurer = createBrokerEnsurer(r.deps);
    expect(await ensurer.ensure(request())).toEqual({ action: "failed", script: "/code/broker.ts", reason: "ENOENT bun" });
    expect(await ensurer.ensure(request())).toMatchObject({ action: "started" });
  });

  test("a broker that never answers is polled attempts times with the poll delay, then reported", async () => {
    const r = rig({ neverAlive: true, attempts: 4, pollMs: 250 });
    const outcome = await createBrokerEnsurer(r.deps).ensure(request());
    expect(r.sleeps).toEqual([250, 250, 250, 250]);
    expect(outcome).toEqual({ action: "failed", script: "/code/broker.ts", reason: "no /health answer after 4 attempts" });
    expect(r.lines.join("\n")).toContain("broker launch failed: no /health answer after 4 attempts");
  });

  test("a runtime that cannot be found is a failure with its reason and a log line, and nothing is spawned", async () => {
    const r = rig({
      locate: () => {
        throw new Error("bun was not found on the PATH of the daemon");
      },
    });
    const outcome = await createBrokerEnsurer(r.deps).ensure(request());
    expect(outcome).toEqual({ action: "failed", script: "", reason: "bun was not found on the PATH of the daemon" });
    expect(r.lines.join("\n")).toContain("broker launch failed: bun was not found on the PATH of the daemon");
    expect(r.spawns).toHaveLength(0);
  });

  test("the command spawned is the bun that was found, never the daemon's own executable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "broker-ensure-clone-"));
    roots.push(dir);
    writeFileSync(join(dir, "broker.ts"), "");
    const r = rig({ locate: () => locateCodeRootBroker(dir, () => "/usr/local/bin/bun") });
    await createBrokerEnsurer(r.deps).ensure(request());
    expect((r.spawns[0] as Rig["spawns"][number]).command).toBe("/usr/local/bin/bun");
    expect((r.spawns[0] as Rig["spawns"][number]).command).not.toBe(process.execPath);
  });
});

describe("the environment of the spawned broker", () => {
  test("keeps the scrubbed base, adds only the broker variables of the session, and lets the session win", async () => {
    const r = rig({ baseEnv: { BASE: "1", CLAUDE_PEERS_PORT: "from-daemon", PATH: "/usr/bin" } });
    await createBrokerEnsurer(r.deps).ensure(
      request({
        env: {
          CLAUDE_PEERS_PORT: "7000",
          CLAUDE_PEERS_DB: "/db",
          CLAUDE_PEERS_BIND_HOST: "127.0.0.1",
          CLAUDE_PEERS_BROKER_TOKEN: "tok",
          CLAUDE_PEERS_OFFLINE_REPLICA: "1",
          CLAUDE_PEERS_SERVE_REPLICAS: "1",
          CLAUDE_PEERS_DELEGATION_MODE: "m",
          CLAUDE_PEERS_FORCE_GROUP: "elsewhere",
          CLAUDE_PEERS_DESK_SESSION: "tile",
          UNRELATED: "x",
        },
      }),
    );
    const env = (r.spawns[0] as Rig["spawns"][number]).env;
    expect(env).toMatchObject({
      BASE: "1",
      CLAUDE_PEERS_PORT: "7000",
      CLAUDE_PEERS_DB: "/db",
      CLAUDE_PEERS_BIND_HOST: "127.0.0.1",
      CLAUDE_PEERS_BROKER_TOKEN: "tok",
      CLAUDE_PEERS_OFFLINE_REPLICA: "1",
      CLAUDE_PEERS_SERVE_REPLICAS: "1",
      CLAUDE_PEERS_DELEGATION_MODE: "m",
    });
    expect(Object.keys(env)).not.toContain("CLAUDE_PEERS_FORCE_GROUP");
    expect(Object.keys(env)).not.toContain("CLAUDE_PEERS_DESK_SESSION");
    expect(Object.keys(env)).not.toContain("UNRELATED");
    expect(r.spawns[0]).toMatchObject({ command: "/bin/bun", args: ["/code/broker.ts"] });
  });

  test.each([
    ["linux", { PATH: "/usr/bin" }, { PATH: "/usr/bin:/home/u/.bun/bin" }],
    ["linux", {}, { PATH: "/home/u/.bun/bin" }],
    ["win32", { Path: "C:\\Windows" }, { Path: "C:\\Windows;\\home\\u\\.bun\\bin" }],
  ] as const)("on %s the bun directory is appended to the PATH key already there", async (platform, baseEnv, expected) => {
    const r = rig({ platform, baseEnv });
    await createBrokerEnsurer(r.deps).ensure(request());
    const env = (r.spawns[0] as Rig["spawns"][number]).env;
    expect(Object.fromEntries(Object.entries(env).filter(([name]) => name.toLowerCase() === "path"))).toEqual(expected);
  });
});

function recordingLog(): { log: Logger; lines: string[] } {
  const lines: string[] = [];
  const push = (m: string) => void lines.push(m);
  const log: Logger = { info: push, warn: push, error: push, child: () => log, file: "" };
  return { log, lines };
}

describe("brokerAnswers", () => {
  const answering = (status: number) => (async () => new Response("", { status })) as unknown as typeof fetch;

  test("true on a 2xx from <url>/health, nothing logged", async () => {
    const { log, lines } = recordingLog();
    let asked = "";
    const fetchImpl = (async (input: string | URL | Request) => {
      asked = String(input);
      return new Response("ok");
    }) as unknown as typeof fetch;
    expect(await brokerAnswers("http://127.0.0.1:7899", log, fetchImpl)).toBe(true);
    expect(asked).toBe("http://127.0.0.1:7899/health");
    expect(lines).toEqual([]);
  });

  test("false and a line with the status on a non 2xx", async () => {
    const { log, lines } = recordingLog();
    expect(await brokerAnswers("http://127.0.0.1:7899", log, answering(503))).toBe(false);
    expect(lines.join("\n")).toContain("answered /health with 503");
  });

  test("false and a line with the cause when the connection fails", async () => {
    const { log, lines } = recordingLog();
    const refused = (async () => {
      throw new Error("ConnectionRefused");
    }) as unknown as typeof fetch;
    expect(await brokerAnswers("http://127.0.0.1:7899", log, refused)).toBe(false);
    expect(lines.join("\n")).toContain("did not answer /health: ConnectionRefused");
  });

  test("the probe is bounded: the request carries an abort signal", async () => {
    let signal: AbortSignal | null | undefined;
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      signal = init?.signal;
      return new Response("ok");
    }) as unknown as typeof fetch;
    await brokerAnswers("http://127.0.0.1:7899", recordingLog().log, fetchImpl);
    expect(signal).toBeInstanceOf(AbortSignal);
  });
});

describe("locateCodeRootBroker", () => {
  test("the broker.ts of the code root, run by the bun that was found", () => {
    const dir = mkdtempSync(join(tmpdir(), "broker-ensure-clone-"));
    roots.push(dir);
    writeFileSync(join(dir, "broker.ts"), "");
    expect(locateCodeRootBroker(dir, () => "/bin/bun")).toEqual({ command: "/bin/bun", script: join(dir, "broker.ts") });
  });

  test("a clone without broker.ts has nothing to run, and bun is not even looked for", () => {
    const dir = mkdtempSync(join(tmpdir(), "broker-ensure-clone-"));
    roots.push(dir);
    let looked = 0;
    expect(locateCodeRootBroker(dir, () => (looked++, "/bin/bun"))).toBeNull();
    expect(looked).toBe(0);
  });

  test("a clone with broker.ts but no bun to run it is an error that says so", () => {
    const dir = mkdtempSync(join(tmpdir(), "broker-ensure-clone-"));
    roots.push(dir);
    writeFileSync(join(dir, "broker.ts"), "");
    expect(() => locateCodeRootBroker(dir, () => null)).toThrow("bun was not found on the PATH of the daemon");
  });
});

describe("daemonBrokerDeps", () => {
  function clone(): string {
    const dir = mkdtempSync(join(tmpdir(), "broker-ensure-clone-"));
    roots.push(dir);
    writeFileSync(join(dir, "broker.ts"), "");
    return dir;
  }

  test("bun is looked up on the PATH of the daemon followed by bun's default install directory, and the answer is the command", () => {
    const codeDir = clone();
    const searched: string[] = [];
    const deps = daemonBrokerDeps({
      env: { PATH: ["/usr/bin", "/opt/bin"].join(delimiter) },
      home: "/home/u",
      codeDir,
      log: recordingLog().log,
      which: (searchPath) => (searched.push(searchPath), "/found/bun"),
    });
    expect(deps.locate()).toEqual({ command: "/found/bun", script: join(codeDir, "broker.ts") });
    expect(searched).toEqual([["/usr/bin", "/opt/bin", join("/home/u", ".bun", "bin")].join(delimiter)]);
  });

  test("a daemon without a PATH still looks in bun's default install directory", () => {
    const searched: string[] = [];
    const deps = daemonBrokerDeps({
      env: {},
      home: "/home/u",
      codeDir: clone(),
      log: recordingLog().log,
      which: (searchPath) => (searched.push(searchPath), null),
    });
    expect(() => deps.locate()).toThrow("bun was not found on the PATH of the daemon");
    expect(searched).toEqual([join("/home/u", ".bun", "bin")]);
  });

  test("the broker is launched with the environment, the home and the log of the daemon, and the poll sleeps for real", async () => {
    const env = { A: "1" };
    const { log } = recordingLog();
    const deps = daemonBrokerDeps({ env, home: "/home/u", codeDir: clone(), log, which: () => null });
    expect(deps.baseEnv).toBe(env);
    expect(deps.home).toBe("/home/u");
    expect(deps.log).toBe(log);
    const before = performance.now();
    await deps.sleep(30);
    expect(performance.now() - before).toBeGreaterThanOrEqual(25);
  });
});

describe("spawnDetachedBroker", () => {
  test("starts the process detached, without a console window or inherited stdio, and lets go of it", () => {
    const calls: unknown[][] = [];
    let unrefs = 0;
    let onError: ((error: unknown) => void) | undefined;
    const { log, lines } = recordingLog();
    spawnDetachedBroker("/bin/bun", ["/code/broker.ts"], { A: "1" }, log, (command, args, options) => {
      calls.push([command, args, options]);
      return {
        on: (_event, listener) => void (onError = listener),
        unref: () => void unrefs++,
      };
    });
    expect(calls).toEqual([
      ["/bin/bun", ["/code/broker.ts"], { detached: true, windowsHide: true, stdio: "ignore", env: { A: "1" } }],
    ]);
    expect(unrefs).toBe(1);
    onError?.(new Error("spawn bun ENOENT"));
    expect(lines.join("\n")).toContain("local broker process failed to start (/bin/bun /code/broker.ts)");
  });
});
