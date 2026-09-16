import { expect, test } from "bun:test";
import {
  createClodexLifecycle,
  type ClodexLifecycleDeps,
  type LeaseIdentity,
  type ProcessIdentity,
  type ServerIdentity
} from "../desktop/src/main/clodex-lifecycle.ts";
import type { OwnerRecord } from "../desktop/src/main/clodex-process-identity.ts";

type Store = Map<string, unknown>;

type Deferred = {
  promise: Promise<void>;
  resolve(): void;
};

const server = (pid = 700): ServerIdentity => ({ host: "host", pid, startedAt: 1_000, port: 4312 });
const lease = (runId: string, pid: number, startedAt = 100): LeaseIdentity => ({
  host: "host",
  pid,
  startedAt,
  runId
});

function processKey(identity: ProcessIdentity): string {
  return `${identity.host}:${identity.pid}:${identity.startedAt}`;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

function fixture() {
  let now = 10_000;
  let runtime: ServerIdentity | null = null;
  let installed = true;
  let tcpReady = true;
  let readServerError: unknown = null;
  let readError: unknown = null;
  let ownerReadError: unknown = null;
  let listError: unknown = null;
  let removeIfEqualsError: unknown = null;
  let beforeRemoveIfEquals: ((key: string, expected: unknown) => void) | null = null;
  let lockRemovalGate: Deferred | null = null;
  let lockRemovalEntered: Deferred | null = null;
  let lockRemovalCount = 0;
  let spawnError: unknown = null;
  let ownerWriteError: unknown = null;
  let stopError: unknown = null;
  let spawnCount = 0;
  let stopCount = 0;
  let readServerCount = 0;
  let measureCount = 0;
  let tcpAttempts = 0;
  let onTcpReady: (() => void) | null = null;
  let spawnGate: Deferred | null = null;
  let spawnEntered: Deferred | null = null;
  let sleepGate: Deferred | null = null;
  let sleepEntered: Deferred | null = null;
  const secondSpawn = deferred();
  const live = new Map<string, true>();
  const identities = new Map<number, ServerIdentity>();
  const files: Store = new Map();
  const events: string[] = [];
  const spawnArgs: string[][] = [];

  const deps: ClodexLifecycleDeps = {
    now: () => now,
    probeClodex: async () => installed,
    readServer: async () => {
      readServerCount++;
      if (readServerError) throw readServerError;
      return runtime;
    },
    isAlive: async (candidate) => live.has(processKey(candidate)),
    measureServer: async (pid) => {
      measureCount++;
      const measured = identities.get(pid) ?? null;
      return measured && live.has(processKey(measured)) ? measured : null;
    },
    tcpReady: async () => {
      tcpAttempts++;
      onTcpReady?.();
      return tcpReady;
    },
    spawn: async (command, args) => {
      spawnCount++;
      spawnArgs.push([command, ...args]);
      if (spawnCount === 2) secondSpawn.resolve();
      if (spawnError) throw spawnError;
      if (spawnEntered) spawnEntered.resolve();
      if (spawnGate) await spawnGate.promise;
      runtime = server(800 + spawnCount);
      live.set(processKey(runtime), true);
      identities.set(runtime.pid, runtime);
      return owner(runtime);
    },
    stopTree: async (candidate) => {
      stopCount++;
      if (stopError) throw stopError;
      live.delete(processKey(candidate.server));
    },
    read: async <T>(key: string) => {
      if (readError || (key === "clodex-lifecycle.owner" && ownerReadError)) throw readError ?? ownerReadError;
      return (files.get(key) as T | undefined) ?? null;
    },
    write: async (key, value) => {
      if (key === "clodex-lifecycle.owner" && ownerWriteError) throw ownerWriteError;
      files.set(key, value);
    },
    createExclusive: async (key, value) => {
      if (files.has(key)) return false;
      files.set(key, value);
      return true;
    },
    remove: async (key) => {
      if (key === "clodex-lifecycle.lock" && lockRemovalGate) {
        lockRemovalCount++;
        if (lockRemovalCount === 2) lockRemovalEntered?.resolve();
        await lockRemovalGate.promise;
      }
      files.delete(key);
    },
    removeIfEquals: async (key, expected) => {
      if (key === "clodex-lifecycle.lock" && lockRemovalGate) {
        lockRemovalCount++;
        if (lockRemovalCount === 2) lockRemovalEntered?.resolve();
        await lockRemovalGate.promise;
      }
      beforeRemoveIfEquals?.(key, expected);
      if (removeIfEqualsError) {
        const error = removeIfEqualsError;
        removeIfEqualsError = null;
        throw error;
      }
      // The SQLite store compares canonical JSON, so a structural copy still matches.
      if (!Bun.deepEquals(files.get(key), expected)) return false;
      files.delete(key);
      return true;
    },
    list: async <T>(prefix: string) => {
      if (listError) throw listError;
      return [...files.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([, value]) => value as T);
    },
    sleep: async () => {
      if (sleepEntered) sleepEntered.resolve();
      if (sleepGate) await sleepGate.promise;
      now++;
    },
    onEvent: (event) => {
      events.push(event.kind);
    }
  };

  return {
    deps,
    files,
    live,
    identities,
    get events() {
      return events;
    },
    get spawnCount() {
      return spawnCount;
    },
    get stopCount() {
      return stopCount;
    },
    get readServerCount() {
      return readServerCount;
    },
    get measureCount() {
      return measureCount;
    },
    get tcpAttempts() {
      return tcpAttempts;
    },
    get spawnArgs() {
      return spawnArgs;
    },
    get runtime() {
      return runtime;
    },
    set installed(value: boolean) {
      installed = value;
    },
    set runtime(value: ServerIdentity | null) {
      runtime = value;
      if (value) {
        live.set(processKey(value), true);
        identities.set(value.pid, value);
      }
    },
    set tcpReady(value: boolean) {
      tcpReady = value;
    },
    set onTcpReady(value: (() => void) | null) {
      onTcpReady = value;
    },
    set readServerError(value: unknown) {
      readServerError = value;
    },
    set readError(value: unknown) {
      readError = value;
    },
    set ownerReadError(value: unknown) {
      ownerReadError = value;
    },
    set listError(value: unknown) {
      listError = value;
    },
    set removeIfEqualsError(value: unknown) {
      removeIfEqualsError = value;
    },
    set beforeRemoveIfEquals(value: ((key: string, expected: unknown) => void) | null) {
      beforeRemoveIfEquals = value;
    },
    set spawnError(value: unknown) {
      spawnError = value;
    },
    set ownerWriteError(value: unknown) {
      ownerWriteError = value;
    },
    set stopError(value: unknown) {
      stopError = value;
    },
    set now(value: number) {
      now = value;
    },
    markAlive(identity: ProcessIdentity) {
      live.set(processKey(identity), true);
    },
    blockLockRemovals() {
      lockRemovalGate = deferred();
      lockRemovalEntered = deferred();
      lockRemovalCount = 0;
    },
    waitForLockRemovals() {
      if (!lockRemovalEntered) throw new Error("lock removal gate was not configured");
      return lockRemovalEntered.promise;
    },
    releaseLockRemovals() {
      lockRemovalGate?.resolve();
    },
    blockSpawn() {
      spawnGate = deferred();
      spawnEntered = deferred();
    },
    waitForSpawn() {
      if (!spawnEntered) throw new Error("spawn gate was not configured");
      return spawnEntered.promise;
    },
    releaseSpawn() {
      spawnGate?.resolve();
    },
    blockSleeps() {
      sleepGate = deferred();
      sleepEntered = deferred();
    },
    waitForSleep() {
      if (!sleepEntered) throw new Error("sleep gate was not configured");
      return sleepEntered.promise;
    },
    releaseSleeps() {
      sleepGate?.resolve();
    },
    waitForSecondSpawn() {
      return secondSpawn.promise;
    }
  };
}

test("disabled and absent Clodex leave no lease or event", async () => {
  const f = fixture();
  const lifecycle = createClodexLifecycle(f.deps, lease("a", 101));

  expect(await lifecycle.acquire(false)).toEqual({ action: "disabled" });
  f.installed = false;
  expect(await lifecycle.acquire(true)).toEqual({ action: "absent" });
  expect(f.files.size).toBe(0);
  expect(f.events).toEqual([]);
});

const owner = (identity = server()) => ({
  server: identity,
  tree: {
    platform: "win32" as const,
    root: { pid: 600, creationUtc: "2026-09-15T12:34:56.789Z" },
    runtime: { pid: identity.pid, creationUtc: "2026-09-15T12:34:57.789Z" }
  }
});

test("a spawned owner snapshot is persisted and passed intact to stopTree", async () => {
  const f = fixture();
  const spawned = owner(server(800));
  const stopped: OwnerRecord[] = [];
  const lifecycle = createClodexLifecycle(
    {
      ...f.deps,
      spawn: async () => {
        f.runtime = spawned.server;
        return spawned;
      },
      stopTree: async (candidate) => {
        stopped.push(candidate);
        f.live.delete(processKey(candidate.server));
      }
    } as ClodexLifecycleDeps,
    lease("a", 101)
  );

  expect(await lifecycle.acquire(true)).toEqual({ action: "acquired", server: spawned.server });
  expect(f.files.get("clodex-lifecycle.owner")).toEqual(spawned);
  expect(await lifecycle.release()).toEqual({ action: "stopped" });
  expect(stopped).toEqual([spawned]);
});

test("a legacy owner is visible, manual, and never grants kill authority", async () => {
  const f = fixture();
  f.runtime = server(701);
  f.files.set("clodex-lifecycle.owner", { server: f.runtime });
  const lifecycle = createClodexLifecycle(f.deps, lease("a", 101));

  expect(await lifecycle.acquire(true)).toEqual({ action: "adopted", server: server(701) });
  expect(await lifecycle.release()).toEqual({ action: "released" });
  expect(f.stopCount).toBe(0);
  expect(f.events).toContain("lifecycle-error");
});

test("a same-server owner with a different tree loses kill authority", async () => {
  const f = fixture();
  const lifecycle = createClodexLifecycle(f.deps, lease("a", 101));

  expect((await lifecycle.acquire(true)).action).toBe("acquired");
  const replacement: OwnerRecord = {
    ...owner(f.runtime!),
    tree: {
      ...owner(f.runtime!).tree,
      root: { pid: 601, creationUtc: "2026-09-15T12:34:58.789Z" }
    }
  };
  f.files.set("clodex-lifecycle.owner", replacement);

  expect(await lifecycle.release()).toEqual({ action: "retained", reason: "not-owner" });
  expect(f.stopCount).toBe(0);
  expect(f.files.get("clodex-lifecycle.owner")).toBe(replacement);
});

test("an owner naming another server leaves a running server manual", async () => {
  const f = fixture();
  f.runtime = server(701);
  const stale = owner(server(999));
  f.files.set("clodex-lifecycle.owner", stale);
  const lifecycle = createClodexLifecycle(f.deps, lease("a", 101));

  expect(await lifecycle.acquire(true)).toEqual({ action: "adopted", server: server(701) });
  expect(await lifecycle.release()).toEqual({ action: "released" });
  expect(f.stopCount).toBe(0);
  expect(f.files.get("clodex-lifecycle.owner")).toBe(stale);
  expect(f.live.has(processKey(server(701)))).toBe(true);
});

test("a spawn result without a tree fails before any ownership is persisted", async () => {
  const f = fixture();
  const lifecycle = createClodexLifecycle(
    {
      ...f.deps,
      spawn: async () => {
        const spawned = server(800);
        f.runtime = spawned;
        return { server: spawned } as unknown as OwnerRecord;
      }
    },
    lease("a", 101)
  );

  expect(await lifecycle.acquire(true)).toEqual({ action: "failed" });
  expect(f.events).toContain("spawn-error");
  expect(f.files.has("clodex-lifecycle.owner")).toBe(false);
  expect(f.stopCount).toBe(0);
  expect(f.live.has(processKey(server(800)))).toBe(true);
});

test("a live manual server is adopted and never stopped", async () => {
  const f = fixture();
  f.runtime = server(701);
  const lifecycle = createClodexLifecycle(f.deps, lease("a", 101));

  expect(await lifecycle.acquire(true)).toEqual({ action: "adopted", server: server(701) });
  expect(await lifecycle.release()).toEqual({ action: "released" });
  expect(f.spawnCount).toBe(0);
  expect(f.stopCount).toBe(0);
});

test("automatic acquisition uses the literal proxy command once across concurrent callers", async () => {
  const previous = process.env.CLODEX_BINARY;
  process.env.CLODEX_BINARY = "poisoned-clodex";
  try {
    const f = fixture();
    const first = createClodexLifecycle(f.deps, lease("a", 101));
    const second = createClodexLifecycle(f.deps, lease("b", 102));

    const [a, b] = await Promise.all([first.acquire(true), second.acquire(true)]);
    expect([a.action, b.action].sort()).toEqual(["acquired", "reused"]);
    expect(f.spawnArgs).toEqual([["clodex", "server", "--proxy"]]);
    expect(f.tcpAttempts).toBe(1);
    expect((await first.acquire(true)).action).toBe("reused");
    expect(f.spawnCount).toBe(1);
  } finally {
    if (previous === undefined) delete process.env.CLODEX_BINARY;
    else process.env.CLODEX_BINARY = previous;
  }
});

test("the lease lock covers the full spawn operation", async () => {
  const f = fixture();
  f.blockSpawn();
  const first = createClodexLifecycle(f.deps, lease("a", 101));
  const second = createClodexLifecycle(f.deps, lease("b", 102));
  const firstAcquire = first.acquire(true);
  await f.waitForSpawn();
  f.blockSleeps();
  const secondAcquire = second.acquire(true);

  let phase: "sleep" | "spawn";
  try {
    phase = await Promise.race([
      f.waitForSleep().then(() => "sleep" as const),
      f.waitForSecondSpawn().then(() => "spawn" as const)
    ]);
    expect(phase).toBe("sleep");
    expect(f.readServerCount).toBe(1);
    expect(f.spawnCount).toBe(1);
  } finally {
    f.releaseSpawn();
    f.releaseSleeps();
  }

  expect((await firstAcquire).action).toBe("acquired");
  expect((await secondAcquire).action).toBe("reused");
  expect(f.spawnCount).toBe(1);
});

test("only the final live lease stops a Kory-owned server in either release order", async () => {
  for (const releaseFirst of ["a", "b"] as const) {
    const f = fixture();
    const a = createClodexLifecycle(f.deps, lease("a", 101));
    const b = createClodexLifecycle(f.deps, lease("b", 102));
    await a.acquire(true);
    await b.acquire(true);
    f.markAlive(lease("a", 101));
    f.markAlive(lease("b", 102));

    const first = releaseFirst === "a" ? a : b;
    const last = releaseFirst === "a" ? b : a;
    expect(await first.release()).toEqual({ action: "released" });
    expect(f.stopCount).toBe(0);
    expect(await last.release()).toEqual({ action: "stopped" });
    expect(f.stopCount).toBe(1);
  }
});

test("fresh dead peers, then final live release purges both and stops once", async () => {
  const f = fixture();
  const aIdentity = lease("a", 101);
  const bIdentity = lease("b", 102);
  const cIdentity = lease("c", 103);
  const a = createClodexLifecycle(f.deps, aIdentity);
  const b = createClodexLifecycle(f.deps, bIdentity);
  const c = createClodexLifecycle(f.deps, cIdentity);

  await a.acquire(true);
  await b.acquire(true);
  await c.acquire(true);
  f.markAlive(aIdentity);
  f.markAlive(bIdentity);
  f.markAlive(cIdentity);
  f.live.delete(processKey(bIdentity));
  f.live.delete(processKey(cIdentity));

  expect(await a.release()).toEqual({ action: "stopped" });
  expect(f.stopCount).toBe(1);
  expect(f.files.has("clodex-lifecycle.leases/host-102-b")).toBe(false);
  expect(f.files.has("clodex-lifecycle.leases/host-103-c")).toBe(false);
  expect(f.files.has("clodex-lifecycle.owner")).toBe(false);
  expect(f.live.has(processKey(f.runtime!))).toBe(false);
});

test("a replaced dead peer lease fails safely", async () => {
  const f = fixture();
  const aIdentity = lease("a", 101);
  const bIdentity = lease("b", 102);
  const bKey = "clodex-lifecycle.leases/host-102-b";
  const replacement = { ...lease("replacement", 103), heartbeat: 10_000 };
  const a = createClodexLifecycle(f.deps, aIdentity);
  const b = createClodexLifecycle(f.deps, bIdentity);

  await a.acquire(true);
  await b.acquire(true);
  f.markAlive(aIdentity);
  f.markAlive(bIdentity);
  f.live.delete(processKey(bIdentity));
  f.beforeRemoveIfEquals = (key) => {
    if (key === bKey) f.files.set(key, replacement);
  };

  expect(await a.release()).toEqual({ action: "failed" });
  expect(f.stopCount).toBe(0);
  expect(f.files.get(bKey)).toBe(replacement);
  expect(f.files.has("clodex-lifecycle.owner")).toBe(true);
  expect(f.live.has(processKey(f.runtime!))).toBe(true);
});

test("an aged lock and lease with the exact live identity remain protected", async () => {
  const f = fixture();
  const active = { ...lease("active", 999), heartbeat: 0 };
  f.files.set("clodex-lifecycle.lock", active);
  f.files.set("clodex-lifecycle.leases/host-999-active", active);
  f.markAlive(active);
  f.now = 100_000;
  const lifecycle = createClodexLifecycle(f.deps, lease("a", 101), { staleMs: 1, lockAttempts: 1 });

  expect(await lifecycle.acquire(true)).toEqual({ action: "failed" });
  expect(f.events).toContain("lock-timeout");
  expect(f.files.has("clodex-lifecycle.lock")).toBe(true);
  expect(f.files.has("clodex-lifecycle.leases/host-999-active")).toBe(true);
  expect(f.spawnCount).toBe(0);
});

test("a reused pid with a different start time reclaims stale lock, lease, and owner records", async () => {
  const f = fixture();
  const stale = { ...lease("stale", 999, 1), heartbeat: 0 };
  f.files.set("clodex-lifecycle.lock", stale);
  f.files.set("clodex-lifecycle.leases/host-999-stale", stale);
  f.files.set("clodex-lifecycle.owner", owner({ ...server(999), startedAt: 1 }));
  f.markAlive({ host: "host", pid: 999, startedAt: 2 });
  f.now = 100_000;
  const lifecycle = createClodexLifecycle(f.deps, lease("a", 101), { staleMs: 1 });

  expect((await lifecycle.acquire(true)).action).toBe("acquired");
  expect(f.files.has("clodex-lifecycle.leases/host-999-stale")).toBe(false);
  expect(f.files.get("clodex-lifecycle.owner")).toEqual(owner(server(801)));
});

test("every server-identity mismatch prevents termination", async () => {
  const mismatches: Array<[string, (owned: ServerIdentity) => ServerIdentity]> = [
    ["host", (owned) => ({ ...owned, host: "other-host" })],
    ["pid", (owned) => ({ ...owned, pid: owned.pid + 1 })],
    ["startedAt", (owned) => ({ ...owned, startedAt: owned.startedAt + 1 })],
    ["port", (owned) => ({ ...owned, port: owned.port + 1 })]
  ];

  for (const [, mismatch] of mismatches) {
    const f = fixture();
    const lifecycle = createClodexLifecycle(f.deps, lease("a", 101));
    await lifecycle.acquire(true);
    const owned = f.runtime!;
    f.identities.set(owned.pid, mismatch(owned));

    expect(await lifecycle.release()).toEqual({ action: "retained", reason: "identity-mismatch" });
    expect(f.stopCount).toBe(0);
  }
});

test("a read-server failure removes the acquired lease and reports an event", async () => {
  const f = fixture();
  f.readServerError = new Error("runtime read denied");
  const lifecycle = createClodexLifecycle(f.deps, lease("a", 101));

  expect(await lifecycle.acquire(true)).toEqual({ action: "failed" });
  expect(f.files.has("clodex-lifecycle.leases/host-101-a")).toBe(false);
  expect(f.events).toEqual(["lifecycle-error"]);
});

test("release retries a lease removal that failed during cleanup without a held server", async () => {
  const f = fixture();
  f.readServerError = new Error("runtime read denied");
  let rejectLeaseRemoval = true;
  const lifecycle = createClodexLifecycle(
    {
      ...f.deps,
      remove: async (key) => {
        if (key === "clodex-lifecycle.leases/host-101-a" && rejectLeaseRemoval) {
          throw new Error("lease remove denied");
        }
        await f.deps.remove(key);
      }
    },
    lease("a", 101)
  );

  expect(await lifecycle.acquire(true)).toEqual({ action: "failed" });
  expect(f.files.has("clodex-lifecycle.leases/host-101-a")).toBe(true);

  rejectLeaseRemoval = false;
  expect(await lifecycle.release()).toEqual({ action: "released" });
  expect(f.files.has("clodex-lifecycle.leases/host-101-a")).toBe(false);
});

test("pending cleanup blocks acquisition instead of returning reused", async () => {
  const f = fixture();
  f.tcpReady = false;
  f.stopError = new Error("stop denied");
  const lifecycle = createClodexLifecycle(f.deps, lease("a", 101), { readinessAttempts: 1 });

  expect(await lifecycle.acquire(true)).toEqual({ action: "failed" });
  expect(await lifecycle.acquire(true)).toEqual({ action: "failed" });
  expect(f.spawnCount).toBe(1);
});

test("release retries owner removal without stopping an already stopped server", async () => {
  const f = fixture();
  let rejectOwnerRemoval = true;
  const lifecycle = createClodexLifecycle(
    {
      ...f.deps,
      removeIfEquals: async (key, expected) => {
        if (key === "clodex-lifecycle.owner" && rejectOwnerRemoval) {
          throw new Error("owner remove denied");
        }
        return f.deps.removeIfEquals(key, expected);
      }
    },
    lease("a", 101)
  );

  await lifecycle.acquire(true);
  expect(await lifecycle.release()).toEqual({ action: "failed" });
  expect(f.stopCount).toBe(1);
  expect(f.measureCount).toBe(1);
  expect(f.files.has("clodex-lifecycle.owner")).toBe(true);
  expect(f.files.has("clodex-lifecycle.leases/host-101-a")).toBe(true);
  expect(f.events).toContain("lifecycle-error");
  expect(f.events).not.toContain("lock-error");

  rejectOwnerRemoval = false;
  expect(await lifecycle.release()).toEqual({ action: "stopped" });
  expect(f.stopCount).toBe(1);
  expect(f.measureCount).toBe(1);
  expect(f.files.has("clodex-lifecycle.owner")).toBe(false);
});

test("a missing current owner prevents a pending cleanup retry from stopping", async () => {
  const f = fixture();
  f.tcpReady = false;
  f.stopError = new Error("stop denied");
  const lifecycle = createClodexLifecycle(f.deps, lease("a", 101), { readinessAttempts: 1 });

  expect(await lifecycle.acquire(true)).toEqual({ action: "failed" });
  expect(f.stopCount).toBe(1);
  f.files.delete("clodex-lifecycle.owner");
  f.stopError = null;

  expect(await lifecycle.release()).toEqual({ action: "retained", reason: "not-owner" });
  expect(f.stopCount).toBe(1);
  expect(f.files.has("clodex-lifecycle.leases/host-101-a")).toBe(false);
  expect(f.live.has(processKey(f.runtime!))).toBe(true);
});

test("a replaced current owner prevents a pending cleanup retry from stopping", async () => {
  const f = fixture();
  f.tcpReady = false;
  f.stopError = new Error("stop denied");
  const lifecycle = createClodexLifecycle(f.deps, lease("a", 101), { readinessAttempts: 1 });
  const replacement = owner(server(999));

  expect(await lifecycle.acquire(true)).toEqual({ action: "failed" });
  expect(f.stopCount).toBe(1);
  f.files.set("clodex-lifecycle.owner", replacement);
  f.stopError = null;

  expect(await lifecycle.release()).toEqual({ action: "retained", reason: "not-owner" });
  expect(f.stopCount).toBe(1);
  expect(f.files.has("clodex-lifecycle.leases/host-101-a")).toBe(false);
  expect(f.files.get("clodex-lifecycle.owner")).toBe(replacement);
  expect(f.live.has(processKey(f.runtime!))).toBe(true);
});

test("a same-server tree replacement prevents a pending cleanup retry from stopping", async () => {
  const f = fixture();
  f.tcpReady = false;
  f.stopError = new Error("stop denied");
  const lifecycle = createClodexLifecycle(f.deps, lease("a", 101), { readinessAttempts: 1 });

  expect(await lifecycle.acquire(true)).toEqual({ action: "failed" });
  expect(f.stopCount).toBe(1);
  const replacement: OwnerRecord = {
    ...owner(f.runtime!),
    tree: {
      ...owner(f.runtime!).tree,
      root: { pid: 601, creationUtc: "2026-09-15T12:34:58.789Z" }
    }
  };
  f.files.set("clodex-lifecycle.owner", replacement);
  f.stopError = null;

  expect(await lifecycle.release()).toEqual({ action: "retained", reason: "not-owner" });
  expect(f.stopCount).toBe(1);
  expect(f.files.get("clodex-lifecycle.owner")).toBe(replacement);
  expect(f.live.has(processKey(f.runtime!))).toBe(true);
});

test("a pending owner read error remains retryable without another stop", async () => {
  const f = fixture();
  f.tcpReady = false;
  f.stopError = new Error("stop denied");
  const lifecycle = createClodexLifecycle(f.deps, lease("a", 101), { readinessAttempts: 1 });

  expect(await lifecycle.acquire(true)).toEqual({ action: "failed" });
  expect(f.stopCount).toBe(1);
  f.ownerReadError = new Error("owner read denied");
  f.stopError = null;

  expect(await lifecycle.release()).toEqual({ action: "failed" });
  expect(f.stopCount).toBe(1);
  expect(f.files.has("clodex-lifecycle.leases/host-101-a")).toBe(true);
  expect(f.files.has("clodex-lifecycle.owner")).toBe(true);
  expect(f.events).toContain("lifecycle-error");
  expect(f.events).not.toContain("lock-error");

  f.ownerReadError = null;
  expect(await lifecycle.release()).toEqual({ action: "stopped" });
  expect(f.stopCount).toBe(2);
});

test("a held owner read error is traced as a lifecycle failure, not a lock failure", async () => {
  const f = fixture();
  const lifecycle = createClodexLifecycle(f.deps, lease("a", 101));

  expect((await lifecycle.acquire(true)).action).toBe("acquired");
  f.ownerReadError = new Error("owner read denied");

  expect(await lifecycle.release()).toEqual({ action: "failed" });
  expect(f.stopCount).toBe(0);
  expect(f.files.has("clodex-lifecycle.leases/host-101-a")).toBe(true);
  expect(f.files.has("clodex-lifecycle.owner")).toBe(true);
  expect(f.events).toContain("lifecycle-error");
  expect(f.events).not.toContain("lock-error");
});

test("each pending owner identity mismatch prevents a retry stop", async () => {
  const mismatches = [
    { host: "other-host" },
    { pid: 999 },
    { startedAt: 999 },
    { port: 999 }
  ];

  for (const mismatch of mismatches) {
    const f = fixture();
    f.tcpReady = false;
    f.stopError = new Error("stop denied");
    const lifecycle = createClodexLifecycle(f.deps, lease("a", 101), { readinessAttempts: 1 });

    expect(await lifecycle.acquire(true)).toEqual({ action: "failed" });
    expect(f.stopCount).toBe(1);
    f.files.set("clodex-lifecycle.owner", owner({ ...f.runtime!, ...mismatch }));
    f.stopError = null;

    expect(await lifecycle.release()).toEqual({ action: "retained", reason: "not-owner" });
    expect(f.stopCount).toBe(1);
    expect(f.files.has("clodex-lifecycle.leases/host-101-a")).toBe(false);
    expect(f.live.has(processKey(f.runtime!))).toBe(true);
  }
});

test("owner-write failure relinquishes an unpersisted server without stopping it", async () => {
  const f = fixture();
  f.ownerWriteError = new Error("owner write denied");
  const lifecycle = createClodexLifecycle(f.deps, lease("a", 101));

  expect(await lifecycle.acquire(true)).toEqual({ action: "failed" });
  expect(f.stopCount).toBe(0);
  expect(f.files.has("clodex-lifecycle.leases/host-101-a")).toBe(false);
  expect(f.files.has("clodex-lifecycle.owner")).toBe(false);
  expect(f.live.has(processKey(f.runtime!))).toBe(true);
  expect(f.events).toContain("lifecycle-error");
  expect(await lifecycle.release()).toEqual({ action: "retained", reason: "not-owner" });
});

test("an unpersisted ownership failure does not block later adoption", async () => {
  const f = fixture();
  f.ownerWriteError = new Error("owner write denied");
  const lifecycle = createClodexLifecycle(f.deps, lease("a", 101));

  expect(await lifecycle.acquire(true)).toEqual({ action: "failed" });
  f.ownerWriteError = null;

  expect((await lifecycle.acquire(true)).action).toBe("adopted");
  expect(f.stopCount).toBe(0);
  expect(f.files.has("clodex-lifecycle.leases/host-101-a")).toBe(true);
  expect(f.live.has(processKey(f.runtime!))).toBe(true);
});

test("readiness timeout retains its lease until persisted ownership is terminated", async () => {
  const f = fixture();
  f.tcpReady = false;
  f.stopError = new Error("stop denied");
  const lifecycle = createClodexLifecycle(f.deps, lease("a", 101), { readinessAttempts: 2 });

  expect(await lifecycle.acquire(true)).toEqual({ action: "failed" });
  expect(f.events).toContain("readiness-timeout");
  expect(f.events).toContain("kill-error");
  expect(f.files.has("clodex-lifecycle.leases/host-101-a")).toBe(true);
  expect(f.files.has("clodex-lifecycle.owner")).toBe(true);

  f.stopError = null;
  expect(await lifecycle.release()).toEqual({ action: "stopped" });
  expect(f.stopCount).toBe(2);
});

test("an exited active server is not reused and is reacquired", async () => {
  const f = fixture();
  const lifecycle = createClodexLifecycle(f.deps, lease("a", 101));

  expect((await lifecycle.acquire(true)).action).toBe("acquired");
  const exited = f.runtime!;
  f.live.clear();
  expect(await f.deps.measureServer(exited.pid)).toBeNull();

  expect((await lifecycle.acquire(true)).action).toBe("acquired");
  expect(f.spawnCount).toBe(2);
});

test("premature exit and spawn failure clean up their lease", async () => {
  const exited = fixture();
  exited.tcpReady = false;
  exited.onTcpReady = () => exited.live.clear();
  const exitLifecycle = createClodexLifecycle(exited.deps, lease("a", 101), { readinessAttempts: 2 });
  expect((await exitLifecycle.acquire(true)).action).toBe("failed");
  expect(exited.events).toContain("server-exited");
  expect(exited.files.has("clodex-lifecycle.leases/host-101-a")).toBe(false);

  const spawned = fixture();
  spawned.spawnError = new Error("spawn denied");
  const spawnLifecycle = createClodexLifecycle(spawned.deps, lease("a", 101));
  expect(await spawnLifecycle.acquire(true)).toEqual({ action: "failed" });
  expect(spawned.events).toContain("spawn-error");
  expect(spawned.files.has("clodex-lifecycle.leases/host-101-a")).toBe(false);
});

test("lock failures and kill failures are visible", async () => {
  const lock = fixture();
  const lockDeps: ClodexLifecycleDeps = {
    ...lock.deps,
    createExclusive: async () => {
      throw new Error("lock denied");
    }
  };
  expect((await createClodexLifecycle(lockDeps, lease("a", 101)).acquire(true)).action).toBe("failed");
  expect(lock.events).toContain("lock-error");

  const kill = fixture();
  const lifecycle = createClodexLifecycle(kill.deps, lease("a", 101));
  await lifecycle.acquire(true);
  kill.stopError = new Error("kill denied");
  expect((await lifecycle.release()).action).toBe("failed");
  expect(kill.events).toContain("kill-error");
  kill.stopError = null;
  expect(await lifecycle.release()).toEqual({ action: "stopped" });
});

test("a failed stop retains the lease before a reused acquisition", async () => {
  const f = fixture();
  const lifecycle = createClodexLifecycle(f.deps, lease("a", 101));

  await lifecycle.acquire(true);
  f.stopError = new Error("stop denied");
  expect(await lifecycle.release()).toEqual({ action: "failed" });
  expect(f.files.has("clodex-lifecycle.leases/host-101-a")).toBe(true);

  f.stopError = null;
  expect((await lifecycle.acquire(true)).action).toBe("reused");
  expect(f.files.has("clodex-lifecycle.leases/host-101-a")).toBe(true);
});

test("a release decision that abandons ownership removes its lease before later adoption", async () => {
  const f = fixture();
  const lifecycle = createClodexLifecycle(f.deps, lease("a", 101));

  await lifecycle.acquire(true);
  f.files.delete("clodex-lifecycle.owner");
  expect(await lifecycle.release()).toEqual({ action: "retained", reason: "not-owner" });
  expect(f.files.has("clodex-lifecycle.leases/host-101-a")).toBe(false);
  expect((await lifecycle.acquire(true)).action).toBe("adopted");
  expect(f.files.has("clodex-lifecycle.leases/host-101-a")).toBe(true);
});

test("a release list failure retains the lease before a reused acquisition", async () => {
  const f = fixture();
  const lifecycle = createClodexLifecycle(f.deps, lease("a", 101));

  await lifecycle.acquire(true);
  f.listError = new Error("lease list denied");
  expect(await lifecycle.release()).toEqual({ action: "failed" });
  expect(f.files.has("clodex-lifecycle.leases/host-101-a")).toBe(true);

  f.listError = null;
  expect((await lifecycle.acquire(true)).action).toBe("reused");
  expect(f.files.has("clodex-lifecycle.leases/host-101-a")).toBe(true);
});

test("a persisted pending cleanup does not stop a server while a peer holds a lease", async () => {
  const f = fixture();
  f.tcpReady = false;
  f.stopError = new Error("stop denied");
  const failedOwner = createClodexLifecycle(f.deps, lease("a", 101), { readinessAttempts: 1 });
  const peer = createClodexLifecycle(f.deps, lease("b", 102));

  expect(await failedOwner.acquire(true)).toEqual({ action: "failed" });
  expect(f.files.has("clodex-lifecycle.leases/host-101-a")).toBe(true);
  expect((await peer.acquire(true)).action).toBe("reused");
  f.markAlive(lease("b", 102));

  f.stopError = null;
  expect(await failedOwner.release()).toEqual({ action: "released" });
  expect(f.stopCount).toBe(1);
  expect(f.live.has(processKey(f.runtime!))).toBe(true);
});

test("a deferred release permits the same instance to reacquire while its peer lives", async () => {
  const f = fixture();
  f.tcpReady = false;
  f.stopError = new Error("stop denied");
  const lifecycle = createClodexLifecycle(f.deps, lease("a", 101), { readinessAttempts: 1 });
  const peer = createClodexLifecycle(f.deps, lease("b", 102));

  expect(await lifecycle.acquire(true)).toEqual({ action: "failed" });
  expect((await peer.acquire(true)).action).toBe("reused");
  f.markAlive(lease("b", 102));
  f.stopError = null;

  expect(await lifecycle.release()).toEqual({ action: "released" });
  expect(f.files.has("clodex-lifecycle.leases/host-101-a")).toBe(false);
  expect((await lifecycle.acquire(true)).action).toBe("reused");
  expect(f.files.has("clodex-lifecycle.leases/host-101-a")).toBe(true);
  expect(f.stopCount).toBe(1);
  expect(f.live.has(processKey(f.runtime!))).toBe(true);
});

test("a failed deferred lease removal retains cleanup for a later stop and acquire", async () => {
  const f = fixture();
  let rejectLeaseRemoval = true;
  const lifecycle = createClodexLifecycle(
    {
      ...f.deps,
      remove: async (key) => {
        if (key === "clodex-lifecycle.leases/host-101-a" && rejectLeaseRemoval) {
          rejectLeaseRemoval = false;
          throw new Error("lease remove denied");
        }
        await f.deps.remove(key);
      }
    },
    lease("a", 101),
    { readinessAttempts: 1 }
  );
  const peer = createClodexLifecycle(f.deps, lease("b", 102));
  f.tcpReady = false;
  f.stopError = new Error("stop denied");

  expect(await lifecycle.acquire(true)).toEqual({ action: "failed" });
  expect((await peer.acquire(true)).action).toBe("reused");
  f.markAlive(lease("b", 102));
  f.stopError = null;

  expect(await lifecycle.release()).toEqual({ action: "failed" });
  expect(f.files.has("clodex-lifecycle.leases/host-101-a")).toBe(true);
  f.live.delete(processKey(lease("b", 102)));

  expect(await lifecycle.release()).toEqual({ action: "stopped" });
  expect(f.files.has("clodex-lifecycle.leases/host-101-a")).toBe(false);
  f.tcpReady = true;
  expect((await lifecycle.acquire(true)).action).toBe("acquired");
  expect(f.spawnCount).toBe(2);
});

test("a dead owned server retries owner cleanup before releasing its lease", async () => {
  const f = fixture();
  let rejectOwnerRemoval = true;
  const lifecycle = createClodexLifecycle(
    {
      ...f.deps,
      removeIfEquals: async (key, expected) => {
        if (key === "clodex-lifecycle.owner" && rejectOwnerRemoval) {
          throw new Error("owner remove denied");
        }
        return f.deps.removeIfEquals(key, expected);
      }
    },
    lease("a", 101)
  );

  await lifecycle.acquire(true);
  f.live.clear();
  expect(await lifecycle.release()).toEqual({ action: "failed" });
  expect(f.files.has("clodex-lifecycle.leases/host-101-a")).toBe(true);
  expect(f.files.has("clodex-lifecycle.owner")).toBe(true);

  rejectOwnerRemoval = false;
  expect(await lifecycle.release()).toEqual({ action: "stopped" });
  expect(f.files.has("clodex-lifecycle.leases/host-101-a")).toBe(false);
  expect(f.files.has("clodex-lifecycle.owner")).toBe(false);
});

test("an unreadable lock record is a lock error rather than a timeout", async () => {
  const f = fixture();
  f.files.set("clodex-lifecycle.lock", { ...lease("other", 999), heartbeat: 10_000 });
  f.readError = new Error("lock record unreadable");

  expect(await createClodexLifecycle(f.deps, lease("a", 101), { lockAttempts: 1 }).acquire(true)).toEqual({
    action: "failed"
  });
  expect(f.events).toEqual(["lock-error"]);
});

test("a failed unlock is retried without deleting a live replacement lock", async () => {
  const f = fixture();
  const lifecycle = createClodexLifecycle(f.deps, lease("a", 101), { lockAttempts: 1, staleMs: 1 });
  f.removeIfEqualsError = new Error("unlock denied");

  expect((await lifecycle.acquire(true)).action).toBe("acquired");
  const failedUnlock = f.files.get("clodex-lifecycle.lock");
  expect(failedUnlock).not.toBeNull();
  expect(f.events).toEqual(["lock-error"]);

  const replacement = { ...lease("replacement", 998), heartbeat: 0 };
  f.now = 100_000;
  f.markAlive(replacement);
  f.beforeRemoveIfEquals = (key, expected) => {
    if (key === "clodex-lifecycle.lock" && expected === failedUnlock) f.files.set(key, replacement);
  };

  expect(await lifecycle.acquire(true)).toEqual({ action: "failed" });
  expect(f.files.get("clodex-lifecycle.lock")).toBe(replacement);
  expect(f.files.has("clodex-lifecycle.leases/host-101-a")).toBe(true);
  expect(f.events).toEqual(["lock-error", "lock-timeout"]);
});

test("a failed unlock is retried before reusing a held server", async () => {
  const f = fixture();
  const lifecycle = createClodexLifecycle(f.deps, lease("a", 101), { lockAttempts: 1 });
  f.removeIfEqualsError = new Error("unlock denied");

  expect((await lifecycle.acquire(true)).action).toBe("acquired");
  expect((await lifecycle.acquire(true)).action).toBe("reused");
  expect(f.files.has("clodex-lifecycle.lock")).toBe(false);
});

test("two concurrent stale-lock reclaimers produce a single server", async () => {
  const f = fixture();
  const stale = { ...lease("stale", 999), heartbeat: 0 };
  f.files.set("clodex-lifecycle.lock", stale);
  f.now = 100_000;
  f.blockLockRemovals();
  f.blockSpawn();
  const first = createClodexLifecycle(f.deps, lease("a", 101), { staleMs: 1, lockAttempts: 2 });
  const second = createClodexLifecycle(f.deps, lease("b", 102), { staleMs: 1, lockAttempts: 2 });
  const acquiring = [first.acquire(true), second.acquire(true)];

  await f.waitForLockRemovals();
  f.releaseLockRemovals();
  await f.waitForSpawn();
  f.releaseSpawn();

  expect((await Promise.all(acquiring)).map((outcome) => outcome.action).sort()).toEqual(["acquired", "failed"]);
  expect(f.spawnCount).toBe(1);
});

test("CAS stale reclaim does not remove a replacement lock", async () => {
  const f = fixture();
  const stale = { ...lease("stale", 999), heartbeat: 0 };
  const replacement = { ...lease("replacement", 998), heartbeat: 100_000 };
  f.now = 100_000;
  f.files.set("clodex-lifecycle.lock", stale);
  f.markAlive(replacement);
  f.beforeRemoveIfEquals = (key) => {
    if (key === "clodex-lifecycle.lock") f.files.set(key, replacement);
  };

  expect(await createClodexLifecycle(f.deps, lease("a", 101), { staleMs: 1, lockAttempts: 1 }).acquire(true)).toEqual({
    action: "failed"
  });
  expect(f.files.get("clodex-lifecycle.lock")).toBe(replacement);
  expect(f.spawnCount).toBe(0);
});

test("a post-stop same-server tree replacement survives owner cleanup", async () => {
  const f = fixture();
  let replacement: OwnerRecord | null = null;
  const lifecycle = createClodexLifecycle(
    {
      ...f.deps,
      stopTree: async (candidate) => {
        f.live.delete(processKey(candidate.server));
        replacement = {
          ...candidate,
          tree: {
            ...candidate.tree,
            root: { pid: 601, creationUtc: "2026-09-15T12:34:58.789Z" }
          }
        };
        f.files.set("clodex-lifecycle.owner", replacement);
      }
    },
    lease("a", 101)
  );

  expect((await lifecycle.acquire(true)).action).toBe("acquired");
  expect(await lifecycle.release()).toEqual({ action: "stopped" });
  expect(f.files.get("clodex-lifecycle.owner")).toBe(replacement);
  expect(f.files.has("clodex-lifecycle.leases/host-101-a")).toBe(false);
});

test("a concurrent owner replacement survives failed owner cleanup", async () => {
  const f = fixture();
  const lifecycle = createClodexLifecycle(f.deps, lease("a", 101));
  const replacement = owner(server(999));

  expect((await lifecycle.acquire(true)).action).toBe("acquired");
  f.beforeRemoveIfEquals = (key) => {
    if (key === "clodex-lifecycle.owner") f.files.set(key, replacement);
  };

  expect(await lifecycle.release()).toEqual({ action: "failed" });
  expect(f.files.get("clodex-lifecycle.owner")).toBe(replacement);
  expect(f.files.has("clodex-lifecycle.leases/host-101-a")).toBe(true);
  expect(f.stopCount).toBe(1);

  expect(await lifecycle.release()).toEqual({ action: "stopped" });
  expect(f.files.get("clodex-lifecycle.owner")).toBe(replacement);
  expect(f.files.has("clodex-lifecycle.leases/host-101-a")).toBe(false);
  expect(f.stopCount).toBe(1);
  expect(f.measureCount).toBe(1);
});

test("an instance serializes release behind an in-flight acquisition", async () => {
  const f = fixture();
  f.blockSpawn();
  const lifecycle = createClodexLifecycle(f.deps, lease("a", 101));
  const acquiring = lifecycle.acquire(true);
  await f.waitForSpawn();
  const releasing = lifecycle.release();
  f.releaseSpawn();

  expect((await acquiring).action).toBe("acquired");
  expect(await releasing).toEqual({ action: "stopped" });
});
