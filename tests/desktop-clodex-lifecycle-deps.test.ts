// Node adapters the Clodex controller runs on (desktop/src/main/clodex-lifecycle-deps):
// run identity, process start instant, record store opener, TCP readiness,
// child wrapper and the assembled dependency object. The subprocess tests run
// this runtime's own binary; nothing here spawns a proxy or opens a database.

import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { closeSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import {
  createClodexControllerDeps,
  mintRunId,
  openSqliteDatabase,
  probeTcp,
  processStartedAt,
  proxyLogPath,
  releaseBeforeQuit,
  RELEASE_DEADLINE_MS,
  runCommand,
  toClodexChild,
  type ErrorSink
} from "../desktop/src/main/clodex-lifecycle-deps.ts";
import type { ClodexController } from "../desktop/src/main/clodex-lifecycle-controller.ts";
import type { AcquireOutcome, ReleaseOutcome } from "../desktop/src/main/clodex-lifecycle.ts";
import { createClodexProcessIo } from "../desktop/src/main/clodex-process-io.ts";

type Trace = { scope: string; message: string; error?: unknown };

function sink(): { onError: ErrorSink; traces: Trace[] } {
  const traces: Trace[] = [];
  return { onError: (scope, message, error) => traces.push({ scope, message, error }), traces };
}

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "clodex-deps-"));
}

async function listeningPort(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer();
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
  return { port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test("a run identity is minted fresh at every launch and fits the lease key", () => {
  const first = mintRunId();
  const second = mintRunId();
  expect(first).not.toBe(second);
  expect(first.length).toBeGreaterThan(0);
  expect(first.length).toBeLessThanOrEqual(128);
});

test("the start instant is derived from the uptime and falls back to now when it is unusable", () => {
  expect(processStartedAt(10, 1_000_000)).toBe(990_000);
  expect(processStartedAt(Number.NaN, 1_000_000)).toBe(1_000_000);
  expect(processStartedAt(-1, 1_000_000)).toBe(1_000_000);
  expect(processStartedAt(Number.POSITIVE_INFINITY, 1_000_000)).toBe(1_000_000);
  // An uptime older than the epoch would date the run before any pid could exist.
  expect(processStartedAt(2_000, 1_000_000)).toBe(1_000_000);
});

test("the record store refuses to open when the runtime carries no node:sqlite", () => {
  expect(() => openSqliteDatabase(join(scratch(), "store.db"), () => undefined)).toThrow(/no node:sqlite/);
});

test("the record store opens through the builtin and creates the directory of the file", () => {
  const path = join(scratch(), "nested", "store.db");
  const opened: string[] = [];
  class FakeDatabase {
    constructor(p: string) {
      opened.push(p);
    }
    exec(): void {}
    prepare(): never {
      throw new Error("unused");
    }
  }
  const connection = openSqliteDatabase(path, () => ({ DatabaseSync: FakeDatabase }));
  expect(opened).toEqual([path]);
  expect(existsSync(join(path, ".."))).toBe(true);
  expect(typeof connection.exec).toBe("function");
});

test("the readiness probe answers false on an unusable port and names it", async () => {
  const { onError, traces } = sink();
  expect(await probeTcp(Number.NaN, onError)).toBe(false);
  expect(await probeTcp(0, onError)).toBe(false);
  expect(await probeTcp(70_000, onError)).toBe(false);
  expect(traces).toHaveLength(3);
  expect(traces[0]?.message).toContain("NaN");
});

test("the readiness probe answers true on a listening port and false once it is gone", async () => {
  const { onError, traces } = sink();
  const server = await listeningPort();
  expect(await probeTcp(server.port, onError)).toBe(true);
  await server.close();
  expect(await probeTcp(server.port, onError, 500)).toBe(false);
  expect(traces).toHaveLength(0);
});

test("a child that exits settles, and a child that never starts settles with a trace", async () => {
  const { onError, traces } = sink();
  const running = new EventEmitter() as unknown as ChildProcess;
  let unrefs = 0;
  (running as unknown as { pid: number; unref: () => void }).pid = 4242;
  (running as unknown as { unref: () => void }).unref = () => {
    unrefs++;
  };
  const child = toClodexChild(running, onError);
  expect(child.pid).toBe(4242);
  child.unref();
  expect(unrefs).toBe(1);
  (running as unknown as EventEmitter).emit("exit", 0, null);
  await child.exited;
  expect(traces).toHaveLength(0);

  const broken = new EventEmitter() as unknown as ChildProcess;
  (broken as unknown as { unref: () => void }).unref = () => {};
  const failed = toClodexChild(broken, onError);
  (broken as unknown as EventEmitter).emit("error", new Error("ENOENT"));
  await failed.exited;
  expect(traces.map((t) => t.message)).toEqual(["the clodex proxy process failed to start"]);
});

test("a command that cannot run resolves with its failure instead of rejecting", async () => {
  const missing = await runCommand(join(scratch(), "definitely-not-a-binary"), ["--version"], 5_000);
  expect(missing.code).not.toBe(0);
  expect(missing.stderr.length).toBeGreaterThan(0);
});

test("a command that runs resolves its output and a zero exit", async () => {
  const ran = await runCommand(process.execPath, ["--version"], 10_000);
  expect(ran.code).toBe(0);
  expect(ran.stdout.trim().length).toBeGreaterThan(0);
});

test("the assembled dependencies carry this process and the injected environment", () => {
  const deps = createClodexControllerDeps({
    shell: "",
    logsDir: scratch(),
    env: { CLODEX_HOME: "/fake-home" },
    plat: "linux",
    runId: "run-under-test"
  });
  expect(deps.platform).toBe("linux");
  expect(deps.env.CLODEX_HOME).toBe("/fake-home");
  expect(deps.runId).toBe("run-under-test");
  expect(deps.pid).toBe(process.pid);
  expect(Number.isSafeInteger(deps.startedAt) && deps.startedAt > 0).toBe(true);
  expect(deps.startedAt).toBeLessThanOrEqual(deps.now());
  expect(deps.hostname().length).toBeGreaterThan(0);
  // Identity, not shape: a store opener replaced by anything callable would
  // satisfy a typeof and open nothing.
  expect(deps.openDatabase).toBe(openSqliteDatabase);
  expect(typeof deps.probeBin).toBe("function");
});

test("the configured shell launches the proxy, not only the PATH probe", async () => {
  const launched: string[] = [];
  const deps = createClodexControllerDeps({
    shell: "/usr/bin/zsh",
    logsDir: scratch(),
    env: { CLODEX_HOME: "/fake-home" },
    plat: "linux"
  });
  expect(deps.env.CLODEX_HOME).toBe("/fake-home");
  const io = createClodexProcessIo(
    {
      ...deps,
      readFile: () => null,
      sleep: async () => {},
      spawn: (file) => {
        launched.push(file);
        return { pid: 4242, exited: new Promise<void>(() => {}), unref: () => {} };
      }
    },
    { registerAttempts: 1 }
  );
  await expect(io.spawn("clodex", ["server", "--proxy"])).rejects.toThrow(/did not register a proxy/);
  expect(launched).toEqual(["/usr/bin/zsh"]);
});

test("an empty shell setting leaves the inherited environment alone", () => {
  const deps = createClodexControllerDeps({
    shell: "",
    logsDir: scratch(),
    env: { CLODEX_HOME: "/fake-home", SHELL: "/bin/dash" }
  });
  expect(deps.env.SHELL).toBe("/bin/dash");
});

test("reading a file answers null when it is absent and rethrows anything else", () => {
  const dir = scratch();
  const deps = createClodexControllerDeps({ shell: "", logsDir: dir });
  const file = join(dir, "present.json");
  writeFileSync(file, "{}");
  expect(deps.readFile(file)).toBe("{}");
  expect(deps.readFile(join(dir, "absent.json"))).toBeNull();
  // A directory is readable as a path but not as a file: answering null would
  // report an unreadable store as an empty one.
  expect(() => deps.readFile(dir)).toThrow();
});

test("the proxy log is opened under the logs directory, and its absence is traced not thrown", () => {
  const dir = scratch();
  const { onError, traces } = sink();
  const deps = createClodexControllerDeps({ shell: "", logsDir: dir, onError });
  const fd = deps.openLog();
  expect(typeof fd).toBe("number");
  closeSync(fd as number);
  expect(existsSync(proxyLogPath(dir))).toBe(true);
  expect(readFileSync(proxyLogPath(dir), "utf-8")).toBe("");
  expect(traces).toHaveLength(0);

  const unwritable = createClodexControllerDeps({ shell: "", logsDir: join(dir, "no-such-dir"), onError });
  expect(unwritable.openLog()).toBeNull();
  expect(traces.map((t) => t.message)).toEqual(["cannot open the clodex proxy log; its output is discarded"]);
});

test("the liveness probe forwards the signal to the running process", () => {
  const deps = createClodexControllerDeps({ shell: "", logsDir: scratch() });
  expect(() => deps.kill(process.pid, 0)).not.toThrow();
});

/** A closing window with nothing left to do, a lease returned, one that hangs, one that throws. */
function stopper(stop: () => Promise<ReleaseOutcome>): ClodexController {
  return { start: async () => ({ action: "disabled" }) as AcquireOutcome, stop };
}

/** The runner cannot interrupt a promise that never settles, so the wait is bounded here. */
async function settledWithin<T>(work: Promise<T>, ms: number): Promise<T | "never-settled"> {
  return Promise.race([
    work,
    new Promise<"never-settled">((resolve) => setTimeout(() => resolve("never-settled"), ms))
  ]);
}

test("a closing window with no controller releases nothing and says so", async () => {
  const { onError, traces } = sink();
  expect(await releaseBeforeQuit(null, RELEASE_DEADLINE_MS, async () => {}, onError)).toBe("idle");
  expect(traces).toHaveLength(0);
});

test("a lease returned in time is not traced, and the cap is the one it was given", async () => {
  const { onError, traces } = sink();
  const waited: number[] = [];
  const outcome = await releaseBeforeQuit(
    stopper(async () => ({ action: "stopped" })),
    RELEASE_DEADLINE_MS,
    async (ms) => {
      waited.push(ms);
    },
    onError
  );
  expect(outcome).toBe("done");
  expect(waited).toEqual([RELEASE_DEADLINE_MS]);
  expect(traces).toHaveLength(0);
});

test("a release that outlasts the cap is traced and still lets the window go", async () => {
  const { onError, traces } = sink();
  const outcome = await settledWithin(
    releaseBeforeQuit(stopper(() => new Promise<ReleaseOutcome>(() => {})), 25, async () => {}, onError),
    500
  );
  expect(outcome).toBe("expired");
  expect(traces.map((t) => t.message)).toEqual([
    "the clodex lease was left in place: its release outlasted 25 ms"
  ]);
});

test("a release that throws is traced with its cause and still lets the window go", async () => {
  const { onError, traces } = sink();
  const boom = new Error("store unreachable");
  const outcome = await settledWithin(
    releaseBeforeQuit(
      stopper(() => Promise.reject(boom)),
      RELEASE_DEADLINE_MS,
      () => new Promise<void>(() => {}),
      onError
    ),
    500
  );
  expect(outcome).toBe("failed");
  expect(traces.map((t) => [t.message, t.error])).toEqual([
    ["the clodex lease could not be released", boom]
  ]);
});
