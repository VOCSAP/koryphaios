import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  createClodexController,
  type ClodexControllerDeps,
  type ClodexControllerOptions
} from "../desktop/src/main/clodex-lifecycle-controller.ts";
import { createSqliteRecordStore, type SqliteConnection } from "../desktop/src/main/clodex-lifecycle-io.ts";

const CLODEX_HOME = "/clodex-home";
const RUNTIME_PATH = `${CLODEX_HOME}/server-runtime.json`;
const STORE_PATH = `${CLODEX_HOME}/koryphaios-clodex-lifecycle.db`;
const LOCK_KEY = "clodex-lifecycle.lock";
const OWNER_KEY = "clodex-lifecycle.owner";
const PROXY_STARTED_AT = "2026-09-16T07:14:50.227Z";

interface RuntimeEntry {
  pid: number;
  port: number;
  mode: string;
  startedAt: string;
}

/** The production driver is `node:sqlite`, whose `get` yields undefined where bun yields null. */
function connection(db: Database): SqliteConnection {
  return {
    exec: (sql: string) => db.exec(sql),
    prepare: (sql: string) => {
      const statement = db.prepare(sql);
      return {
        run: (...values: unknown[]) => statement.run(...(values as never[])),
        get: (...values: unknown[]) => statement.get(...(values as never[])) ?? undefined,
        all: (...values: unknown[]) => statement.all(...(values as never[]))
      };
    }
  };
}

/** `/proc/<pid>/stat`: state, ppid, pgrp, then sixteen fields before starttime. */
function procStat(pid: number, pgid: number, startToken: string): string {
  return `${pid} (node) S 1 ${pgid} ${"0 ".repeat(16)}${startToken}\n`;
}

function fixture(overrides: Partial<ClodexControllerDeps> = {}) {
  const db = connection(new Database(":memory:"));
  const alive = new Set<number>();
  const stats = new Map<number, string>();
  const opens: string[] = [];
  const probes: string[] = [];
  const connects: number[] = [];
  const sleeps: number[] = [];
  const traces: { scope: string; message: string; error?: unknown }[] = [];
  const spawns: { file: string; args: string[] }[] = [];
  let runtime: RuntimeEntry[] = [];
  let installed = true;
  let tcpReady = true;
  let openError: unknown = null;
  let spawnedRootPid = 9001;
  let onSpawn: (() => void) | null = null;

  const deps: ClodexControllerDeps = {
    platform: "linux",
    hostname: () => "host",
    env: { CLODEX_HOME, SHELL: "/bin/bash" },
    pid: 4242,
    startedAt: 500,
    runId: "run-a",
    now: () => 10_000,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    run: async () => {
      throw new Error("a linux measurement must not spawn a subprocess");
    },
    readFile: (path: string) => {
      if (path === RUNTIME_PATH) return JSON.stringify(runtime);
      const match = /^\/proc\/(\d+)\/stat$/.exec(path);
      if (match) return stats.get(Number(match[1])) ?? null;
      return null;
    },
    makeDir: () => {},
    kill: (pid: number) => {
      if (pid < 0) {
        for (const candidate of [...alive]) {
          if (stats.get(candidate)?.includes(` ${-pid} `)) alive.delete(candidate);
        }
        return;
      }
      if (!alive.has(pid)) {
        const error = new Error(`no such process ${pid}`) as NodeJS.ErrnoException;
        error.code = "ESRCH";
        throw error;
      }
    },
    spawn: (file: string, args: string[]) => {
      spawns.push({ file, args });
      const pid = spawnedRootPid;
      alive.add(pid);
      onSpawn?.();
      return { pid, exited: new Promise<void>(() => {}), unref: () => {} };
    },
    openLog: () => null,
    onError: (scope, message, error) => {
      traces.push({ scope, message, error });
    },
    connect: async (port: number) => {
      connects.push(port);
      return tcpReady;
    },
    probeBin: async (bin: string) => {
      probes.push(bin);
      return installed;
    },
    openDatabase: (path: string) => {
      opens.push(path);
      if (openError) {
        const error = openError;
        openError = null;
        throw error;
      }
      return db;
    },
    ...overrides
  };

  return {
    deps,
    db,
    alive,
    stats,
    opens,
    probes,
    connects,
    sleeps,
    traces,
    spawns,
    get runtime() {
      return runtime;
    },
    set runtime(value: RuntimeEntry[]) {
      runtime = value;
    },
    set installed(value: boolean) {
      installed = value;
    },
    set tcpReady(value: boolean) {
      tcpReady = value;
    },
    set openError(value: unknown) {
      openError = value;
    },
    set onSpawn(value: (() => void) | null) {
      onSpawn = value;
    },
    get spawnedRootPid() {
      return spawnedRootPid;
    },
    set spawnedRootPid(value: number) {
      spawnedRootPid = value;
    },
    controller(options: ClodexControllerOptions = {}) {
      return createClodexController(deps, options);
    }
  };
}

test("a disabled setting opens no database and probes nothing", async () => {
  const f = fixture();

  expect(await f.controller().start(false, "")).toEqual({ action: "disabled" });
  expect(f.opens).toEqual([]);
  expect(f.probes).toEqual([]);
  expect(f.traces).toEqual([]);
});

test("an absent wrapper leaves no database behind", async () => {
  const f = fixture();
  f.installed = false;

  expect(await f.controller().start(true, "")).toEqual({ action: "absent" });
  expect(f.probes).toEqual(["clodex-claude"]);
  expect(f.opens).toEqual([]);
});

test("stopping before any start opens no database", async () => {
  const f = fixture();

  expect(await f.controller().stop()).toEqual({ action: "released" });
  expect(f.opens).toEqual([]);
});

test("the store is resolved under the clodex home, not under userData", async () => {
  const f = fixture();
  f.runtime = [{ pid: 9002, port: 17_000, mode: "proxy", startedAt: PROXY_STARTED_AT }];
  f.alive.add(9002);

  expect((await f.controller().start(true, "")).action).toBe("adopted");
  expect(f.opens).toEqual([STORE_PATH]);
});

test("an unusable lease identity refuses to start before touching anything", async () => {
  for (const broken of [{ pid: Number.NaN }, { startedAt: Number.NaN }, { runId: "" }, { hostname: () => "" }]) {
    const f = fixture(broken as Partial<ClodexControllerDeps>);

    expect(await f.controller().start(true, "")).toEqual({ action: "failed" });
    expect(f.opens).toEqual([]);
    expect(f.probes).toEqual([]);
    expect(f.traces.map((trace) => trace.scope)).toEqual(["clodex-lifecycle"]);
    expect(f.traces[0]!.error).toBeInstanceOf(TypeError);
  }
});

test("a database that cannot be opened fails the start and is retried by the next one", async () => {
  const f = fixture();
  f.runtime = [{ pid: 9002, port: 17_000, mode: "proxy", startedAt: PROXY_STARTED_AT }];
  f.alive.add(9002);
  f.openError = new Error("database is unavailable");
  const controller = f.controller();

  expect(await controller.start(true, "")).toEqual({ action: "failed" });
  expect(f.opens).toEqual([STORE_PATH]);
  expect(f.traces.map((trace) => trace.message)).toContain(
    "the clodex lifecycle lock could not be taken or released"
  );

  expect((await controller.start(true, "")).action).toBe("adopted");
  expect(f.opens).toEqual([STORE_PATH, STORE_PATH]);
});

test("a manually started proxy is adopted and never stopped", async () => {
  const f = fixture();
  f.runtime = [{ pid: 9002, port: 17_000, mode: "proxy", startedAt: PROXY_STARTED_AT }];
  f.alive.add(9002);
  const controller = f.controller();

  expect(await controller.start(true, "")).toEqual({
    action: "adopted",
    server: { host: "host", pid: 9002, startedAt: Date.parse(PROXY_STARTED_AT), port: 17_000 }
  });
  expect(await controller.stop()).toEqual({ action: "released" });
  expect(f.spawns).toEqual([]);
  expect(f.alive.has(9002)).toBe(true);
});

test("a held lock is waited out for the full budget, sleeping the chosen interval", async () => {
  const f = fixture();
  const store = createSqliteRecordStore(f.db);
  await store.write(LOCK_KEY, { host: "host", pid: 777, startedAt: 400, runId: "other", heartbeat: 10_000 });
  f.alive.add(777);

  expect(await f.controller().start(true, "")).toEqual({ action: "failed" });
  expect(f.sleeps.length).toBe(180);
  expect(new Set(f.sleeps)).toEqual(new Set([250]));
  expect(f.traces.map((trace) => trace.message)).toContain(
    "the clodex lifecycle lock stayed held by another window"
  );
});

test("the lock budget is a duration, so a shorter sleep buys proportionally more attempts", async () => {
  const f = fixture();
  const store = createSqliteRecordStore(f.db);
  await store.write(LOCK_KEY, { host: "host", pid: 777, startedAt: 400, runId: "other", heartbeat: 10_000 });
  f.alive.add(777);

  expect(await f.controller({ sleepMs: 50 }).start(true, "")).toEqual({ action: "failed" });
  expect(f.sleeps.length).toBe(900);
  expect(new Set(f.sleeps)).toEqual(new Set([50]));
});

test("an unusable sleep interval is traced and falls back to the default one", async () => {
  const f = fixture();
  const store = createSqliteRecordStore(f.db);
  await store.write(LOCK_KEY, { host: "host", pid: 777, startedAt: 400, runId: "other", heartbeat: 10_000 });
  f.alive.add(777);

  expect(await f.controller({ sleepMs: 0 }).start(true, "")).toEqual({ action: "failed" });
  expect(f.sleeps.length).toBe(180);
  expect(new Set(f.sleeps)).toEqual(new Set([250]));
  expect(f.traces.map((trace) => trace.message)).toContain("ignoring an unusable clodex sleep interval: 0");
});

test("a spawned proxy is owned end to end and its readiness is a TCP connect on its own port", async () => {
  const f = fixture();
  f.stats.set(9001, procStat(9001, 9001, "111"));
  f.stats.set(9002, procStat(9002, 9001, "222"));
  f.onSpawn = () => {
    f.runtime = [{ pid: 9002, port: 17_000, mode: "proxy", startedAt: PROXY_STARTED_AT }];
    f.alive.add(9002);
  };
  const controller = f.controller();

  expect(await controller.start(true, "")).toEqual({
    action: "acquired",
    server: { host: "host", pid: 9002, startedAt: Date.parse(PROXY_STARTED_AT), port: 17_000 }
  });
  expect(f.spawns.length).toBe(1);
  expect(f.connects).toEqual([17_000]);
  const store = createSqliteRecordStore(f.db);
  expect(await store.read(OWNER_KEY)).not.toBeNull();

  expect(await controller.stop()).toEqual({ action: "stopped" });
  expect(f.alive.has(9002)).toBe(false);
  expect(f.alive.has(9001)).toBe(false);
  expect(await store.read(OWNER_KEY)).toBeNull();
});

test("a second window sharing the store reuses the proxy instead of spawning another", async () => {
  const f = fixture();
  f.stats.set(9001, procStat(9001, 9001, "111"));
  f.stats.set(9002, procStat(9002, 9001, "222"));
  f.onSpawn = () => {
    f.runtime = [{ pid: 9002, port: 17_000, mode: "proxy", startedAt: PROXY_STARTED_AT }];
    f.alive.add(9002);
  };
  const first = f.controller();
  expect((await first.start(true, "")).action).toBe("acquired");

  const second = createClodexController({ ...f.deps, pid: 4243, runId: "run-b" }, {});
  expect((await second.start(true, "")).action).toBe("reused");
  expect(f.spawns.length).toBe(1);
});

test("a proxy that never accepts a connection ends on the bounded attempt count", async () => {
  const f = fixture();
  f.tcpReady = false;
  f.stats.set(9001, procStat(9001, 9001, "111"));
  f.stats.set(9002, procStat(9002, 9001, "222"));
  f.onSpawn = () => {
    f.runtime = [{ pid: 9002, port: 17_000, mode: "proxy", startedAt: PROXY_STARTED_AT }];
    f.alive.add(9002);
  };

  expect(await f.controller({ readinessAttempts: 3 }).start(true, "")).toEqual({ action: "failed" });
  expect(f.connects).toEqual([17_000, 17_000, 17_000]);
  expect(f.traces.map((trace) => trace.message)).toContain(
    "the clodex proxy did not accept a connection in time"
  );
});
