export const CLODEX_SERVER_COMMAND = ["clodex", "server", "--proxy"] as const;

const LOCK_KEY = "clodex-lifecycle.lock";
const LEASE_PREFIX = "clodex-lifecycle.leases/";
const OWNER_KEY = "clodex-lifecycle.owner";

export interface ProcessIdentity {
  host: string;
  pid: number;
  startedAt: number;
}

export interface LeaseIdentity extends ProcessIdentity {
  runId: string;
}

export interface ServerIdentity extends ProcessIdentity {
  port: number;
}

interface LeaseRecord extends LeaseIdentity {
  heartbeat: number;
}

interface OwnerRecord {
  server: ServerIdentity;
}

export interface ClodexLifecycleEvent {
  kind:
    | "lock-error"
    | "lock-timeout"
    | "spawn-error"
    | "server-exited"
    | "readiness-timeout"
    | "kill-error"
    | "lifecycle-error";
  error?: unknown;
}

export interface ClodexLifecycleDeps {
  now(): number;
  probeClodex(): Promise<boolean>;
  readServer(): Promise<ServerIdentity | null>;
  isAlive(identity: ProcessIdentity): Promise<boolean>;
  measureServer(pid: number): Promise<ServerIdentity | null>;
  tcpReady(server: ServerIdentity): Promise<boolean>;
  spawn(command: string, args: string[]): Promise<ServerIdentity>;
  stopTree(server: ServerIdentity): Promise<void>;
  read<T>(key: string): Promise<T | null>;
  write<T>(key: string, value: T): Promise<void>;
  createExclusive<T>(key: string, value: T): Promise<boolean>;
  remove(key: string): Promise<void>;
  removeIfEquals<T>(key: string, expected: T): Promise<boolean>;
  list<T>(prefix: string): Promise<T[]>;
  sleep(): Promise<void>;
  onEvent(event: ClodexLifecycleEvent): void;
}

export interface ClodexLifecycleOptions {
  staleMs?: number;
  readinessAttempts?: number;
  lockAttempts?: number;
}

export type AcquireOutcome =
  | { action: "disabled" }
  | { action: "absent" }
  | { action: "adopted"; server: ServerIdentity }
  | { action: "acquired"; server: ServerIdentity }
  | { action: "reused"; server: ServerIdentity }
  | { action: "failed" };

export type ReleaseOutcome =
  | { action: "released" }
  | { action: "stopped" }
  | { action: "retained"; reason: "identity-mismatch" | "not-owner" }
  | { action: "failed" };

interface HeldServer {
  server: ServerIdentity;
  manual: boolean;
  ownerPersisted: boolean;
}

interface PendingCleanup {
  server: ServerIdentity;
  ownerPersisted: boolean;
  serverStopped: boolean;
  leasePresent: boolean;
}

type StopOutcome = "stopped" | "identity-mismatch" | "failed";
type CleanupOutcome = "clean" | "deferred" | "identity-mismatch" | "not-owner" | "failed";
type OtherLeaseOutcome = "none" | "live" | "failed";

function sameProcess(left: ProcessIdentity, right: ProcessIdentity): boolean {
  return left.host === right.host && left.pid === right.pid && left.startedAt === right.startedAt;
}

function sameLease(left: LeaseIdentity, right: LeaseIdentity): boolean {
  return sameProcess(left, right) && left.runId === right.runId;
}

function sameServer(left: ServerIdentity, right: ServerIdentity): boolean {
  return sameProcess(left, right) && left.port === right.port;
}

export function createClodexLifecycle(
  deps: ClodexLifecycleDeps,
  identity: LeaseIdentity,
  options: ClodexLifecycleOptions = {}
): { acquire(enabled: boolean): Promise<AcquireOutcome>; release(): Promise<ReleaseOutcome> } {
  const staleMs = options.staleMs ?? 30_000;
  const readinessAttempts = options.readinessAttempts ?? 20;
  const lockAttempts = options.lockAttempts ?? 20;
  const leaseKey = `${LEASE_PREFIX}${identity.host}-${identity.pid}-${identity.runId}`;
  let activeHeld: HeldServer | null = null;
  let pendingCleanup: PendingCleanup | null = null;
  let pendingLeaseCleanup = false;
  let pendingUnlock: LeaseRecord | null = null;
  let serial = Promise.resolve();

  const emit = (kind: ClodexLifecycleEvent["kind"], error?: unknown) => {
    deps.onEvent({ kind, error });
  };

  const leaseRecord = (): LeaseRecord => ({ ...identity, heartbeat: deps.now() });

  const isStale = async (record: LeaseRecord): Promise<boolean> => {
    if (deps.now() - record.heartbeat <= staleMs) return false;
    return !(await deps.isAlive(record));
  };

  const clearStaleLeases = async () => {
    const leases = await deps.list<LeaseRecord>(LEASE_PREFIX);
    await Promise.all(
      leases.map(async (record) => {
        if (await isStale(record)) {
          await deps.removeIfEquals(`${LEASE_PREFIX}${record.host}-${record.pid}-${record.runId}`, record);
        }
      })
    );
  };

  const retryPendingUnlock = async () => {
    const unlock = pendingUnlock;
    if (!unlock) return;
    try {
      await deps.removeIfEquals(LOCK_KEY, unlock);
      pendingUnlock = null;
    } catch (error) {
      emit("lock-error", error);
    }
  };

  const withLock = async <T>(operation: () => Promise<T>): Promise<T | null> => {
    let lock: LeaseRecord | null = null;
    try {
      for (let attempt = 0; attempt < lockAttempts; attempt++) {
        const candidate = leaseRecord();
        if (await deps.createExclusive(LOCK_KEY, candidate)) {
          lock = candidate;
          return await operation();
        }
        const current = await deps.read<LeaseRecord>(LOCK_KEY);
        if (current && (await isStale(current))) {
          await deps.removeIfEquals(LOCK_KEY, current);
          continue;
        }
        await deps.sleep();
      }
      emit("lock-timeout");
      return null;
    } catch (error) {
      emit("lock-error", error);
      return null;
    } finally {
      if (lock) {
        try {
          await deps.removeIfEquals(LOCK_KEY, lock);
        } catch (error) {
          pendingUnlock = lock;
          emit("lock-error", error);
        }
      }
    }
  };

  const removeLease = async (): Promise<boolean> => {
    try {
      await deps.remove(leaseKey);
      return true;
    } catch (error) {
      emit("lifecycle-error", error);
      return false;
    }
  };

  const removeTrackedLease = async (pending?: PendingCleanup): Promise<boolean> => {
    if (!(await removeLease())) {
      pendingLeaseCleanup = true;
      return false;
    }
    pendingLeaseCleanup = false;
    if (pending) pending.leasePresent = false;
    return true;
  };

  const removeOwnedServer = async (server: ServerIdentity): Promise<boolean> => {
    try {
      const owner = await deps.read<OwnerRecord>(OWNER_KEY);
      if (owner && sameServer(owner.server, server)) {
        return await deps.removeIfEquals(OWNER_KEY, owner);
      }
      return true;
    } catch (error) {
      emit("lifecycle-error", error);
      return false;
    }
  };

  const stopOwnedServer = async (server: ServerIdentity): Promise<StopOutcome> => {
    let measured: ServerIdentity | null;
    try {
      measured = await deps.measureServer(server.pid);
    } catch (error) {
      emit("lifecycle-error", error);
      return "failed";
    }
    if (!measured || !sameServer(measured, server)) return "identity-mismatch";
    try {
      await deps.stopTree(server);
      return "stopped";
    } catch (error) {
      emit("kill-error", error);
      return "failed";
    }
  };

  const hasOtherLiveLeases = async (): Promise<OtherLeaseOutcome> => {
    try {
      await clearStaleLeases();
      const leases = await deps.list<LeaseRecord>(LEASE_PREFIX);
      for (const record of leases) {
        if (sameLease(record, identity)) continue;
        if (await deps.isAlive(record)) return "live";
        const key = `${LEASE_PREFIX}${record.host}-${record.pid}-${record.runId}`;
        if (await deps.removeIfEquals(key, record)) continue;
        const current = await deps.read<LeaseRecord>(key);
        if (!current || sameLease(current, identity)) continue;
        if (await deps.isAlive(current)) return "live";
        return "failed";
      }
      return "none";
    } catch (error) {
      emit("lifecycle-error", error);
      return "failed";
    }
  };

  const resolvePendingCleanup = async (): Promise<CleanupOutcome> => {
    const pending = pendingCleanup;
    if (!pending) return "clean";

    if (!pending.serverStopped) {
      if (!pending.ownerPersisted) {
        if (pending.leasePresent && !(await removeTrackedLease(pending))) return "failed";
        return "not-owner";
      }
      const otherLeases = await hasOtherLiveLeases();
      if (otherLeases === "failed") return "failed";
      if (otherLeases === "live") return "deferred";
      let owner: OwnerRecord | null;
      try {
        owner = await deps.read<OwnerRecord>(OWNER_KEY);
      } catch (error) {
        emit("lifecycle-error", error);
        return "failed";
      }
      if (!owner || !sameServer(owner.server, pending.server)) {
        if (pending.leasePresent && !(await removeTrackedLease(pending))) return "failed";
        return "not-owner";
      }
      const stopped = await stopOwnedServer(pending.server);
      if (stopped === "failed") return "failed";
      if (stopped === "identity-mismatch") {
        try {
          if (await deps.isAlive(pending.server)) return "identity-mismatch";
        } catch (error) {
          emit("lifecycle-error", error);
          return "failed";
        }
      }
      pending.serverStopped = true;
    }

    if (pending.ownerPersisted && !(await removeOwnedServer(pending.server))) return "failed";
    pending.ownerPersisted = false;
    return "clean";
  };

  const finishPendingCleanup = async (): Promise<boolean> => {
    const pending = pendingCleanup;
    if (!pending) return true;
    if (!pending.serverStopped || pending.ownerPersisted) return false;
    if (pending.leasePresent && !(await removeTrackedLease(pending))) return false;
    pendingCleanup = null;
    return true;
  };

  const resolvePendingLeaseCleanup = async (): Promise<boolean> => {
    if (!pendingLeaseCleanup) return true;
    return removeTrackedLease();
  };

  const cleanupFailedAcquire = async (leaseWritten: boolean, started: HeldServer | null) => {
    if (started) {
      const cleanup = await resolvePendingCleanup();
      if (cleanup === "clean") await finishPendingCleanup();
      return;
    }
    if (leaseWritten) await removeTrackedLease();
  };

  const waitForReady = async (server: ServerIdentity): Promise<"ready" | "exited" | "timeout"> => {
    for (let attempt = 0; attempt < readinessAttempts; attempt++) {
      if (!(await deps.isAlive(server))) return "exited";
      if (await deps.tcpReady(server)) return "ready";
      await deps.sleep();
    }
    return "timeout";
  };

  const releasePending = async (): Promise<ReleaseOutcome> => {
    const pending = pendingCleanup;
    if (!pending) {
      if (!(await resolvePendingLeaseCleanup())) return { action: "failed" };
      return { action: "released" };
    }

    const cleanup = await resolvePendingCleanup();
    if (cleanup === "failed") return { action: "failed" };
    if (cleanup === "identity-mismatch" || cleanup === "not-owner") {
      if (pending.leasePresent && !(await removeTrackedLease(pending))) return { action: "failed" };
      pendingCleanup = null;
      return { action: "retained", reason: cleanup };
    }
    if (cleanup === "deferred") {
      if (pending.leasePresent && !(await removeTrackedLease(pending))) return { action: "failed" };
      pendingCleanup = null;
      return { action: "released" };
    }
    if (!(await finishPendingCleanup())) return { action: "failed" };
    return { action: "stopped" };
  };

  const acquireImpl = async (enabled: boolean): Promise<AcquireOutcome> => {
    if (!enabled) return { action: "disabled" };

    try {
      if (!(await deps.probeClodex())) return { action: "absent" };
    } catch (error) {
      emit("lifecycle-error", error);
      return { action: "failed" };
    }

    const outcome = await withLock(async (): Promise<AcquireOutcome> => {
      let leaseWritten = false;
      let started: HeldServer | null = null;
      let stage: "setup" | "spawn" | "ownership" | "ready" = "setup";
      try {
        await clearStaleLeases();

        if (activeHeld) {
          if (await deps.isAlive(activeHeld.server)) {
            await deps.write(leaseKey, leaseRecord());
            return { action: "reused", server: activeHeld.server };
          }
          const expired = activeHeld;
          activeHeld = null;
          if (expired.manual) {
            if (!(await removeTrackedLease())) return { action: "failed" };
          } else {
            pendingCleanup = {
              server: expired.server,
              ownerPersisted: expired.ownerPersisted,
              serverStopped: true,
              leasePresent: true
            };
          }
        }

        if (pendingCleanup) {
          const cleanup = await resolvePendingCleanup();
          if (cleanup === "identity-mismatch" || cleanup === "not-owner") {
            pendingCleanup = null;
          } else if (cleanup !== "clean" || !(await finishPendingCleanup())) {
            return { action: "failed" };
          }
        }
        if (!(await resolvePendingLeaseCleanup())) return { action: "failed" };

        await deps.write(leaseKey, leaseRecord());
        leaseWritten = true;
        const running = await deps.readServer();
        if (running && (await deps.isAlive(running))) {
          const owner = await deps.read<OwnerRecord>(OWNER_KEY);
          activeHeld = {
            server: running,
            manual: !owner || !sameServer(owner.server, running),
            ownerPersisted: Boolean(owner && sameServer(owner.server, running))
          };
          return activeHeld.manual
            ? { action: "adopted", server: running }
            : { action: "reused", server: running };
        }

        stage = "spawn";
        const server = await deps.spawn(CLODEX_SERVER_COMMAND[0], [...CLODEX_SERVER_COMMAND.slice(1)]);
        started = { server, manual: false, ownerPersisted: false };
        pendingCleanup = { ...started, serverStopped: false, leasePresent: true };
        stage = "ownership";
        await deps.write<OwnerRecord>(OWNER_KEY, { server });
        started.ownerPersisted = true;
        pendingCleanup.ownerPersisted = true;

        stage = "ready";
        const readiness = await waitForReady(server);
        if (readiness === "ready") {
          activeHeld = started;
          pendingCleanup = null;
          return { action: "acquired", server };
        }
        emit(readiness === "exited" ? "server-exited" : "readiness-timeout");
        await cleanupFailedAcquire(leaseWritten, started);
        return { action: "failed" };
      } catch (error) {
        emit(stage === "spawn" ? "spawn-error" : "lifecycle-error", error);
        await cleanupFailedAcquire(leaseWritten, started);
        return { action: "failed" };
      }
    });

    return outcome ?? { action: "failed" };
  };

  const releaseImpl = async (): Promise<ReleaseOutcome> => {
    if (!activeHeld && !pendingCleanup && !pendingLeaseCleanup) return { action: "released" };

    const outcome = await withLock(async (): Promise<ReleaseOutcome> => {
      await clearStaleLeases();
      const releasing = activeHeld;
      if (!releasing) return releasePending();

      if (releasing.manual) {
        if (!(await removeTrackedLease())) return { action: "failed" };
        activeHeld = null;
        return { action: "released" };
      }

      const otherLeases = await hasOtherLiveLeases();
      if (otherLeases === "failed") return { action: "failed" };
      if (otherLeases === "live") {
        if (!(await removeTrackedLease())) return { action: "failed" };
        activeHeld = null;
        return { action: "released" };
      }

      if (releasing.ownerPersisted) {
        const owner = await deps.read<OwnerRecord>(OWNER_KEY);
        if (!owner || !sameServer(owner.server, releasing.server)) {
          if (!(await removeTrackedLease())) return { action: "failed" };
          activeHeld = null;
          return { action: "retained", reason: "not-owner" };
        }
      }

      const stopped = await stopOwnedServer(releasing.server);
      if (stopped === "failed") return { action: "failed" };
      if (stopped === "identity-mismatch") {
        try {
          if (await deps.isAlive(releasing.server)) {
            if (!(await removeTrackedLease())) return { action: "failed" };
            activeHeld = null;
            return { action: "retained", reason: "identity-mismatch" };
          }
        } catch (error) {
          emit("lifecycle-error", error);
          return { action: "failed" };
        }
      }

      activeHeld = null;
      pendingCleanup = {
        server: releasing.server,
        ownerPersisted: releasing.ownerPersisted,
        serverStopped: true,
        leasePresent: true
      };
      return releasePending();
    });

    return outcome ?? { action: "failed" };
  };

  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = serial.then(async () => {
      await retryPendingUnlock();
      return operation();
    });
    serial = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  };

  return {
    acquire(enabled: boolean): Promise<AcquireOutcome> {
      return serialize(() => acquireImpl(enabled));
    },
    release(): Promise<ReleaseOutcome> {
      return serialize(releaseImpl);
    }
  };
}
