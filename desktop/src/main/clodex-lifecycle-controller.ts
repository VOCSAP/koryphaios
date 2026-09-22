// Assembles the three pure Clodex modules into the object the main process
// drives: the decision engine (clodex-lifecycle), the record store
// (clodex-lifecycle-io) and the identity producers (clodex-process-io). It
// supplies the two producers none of them owns, a readiness probe and an
// install probe, and it decides the waiting budget.
//
// Everything stays injected, so the assembly is exercised under `bun test`
// without electron, without a database and without a socket. The store is
// opened on first record access only: a disabled setting or an absent wrapper
// must not leave a database behind for a feature that never ran.

import { clodexHome } from "./clodex-bridge";
import {
  createClodexLifecycle,
  type AcquireOutcome,
  type ClodexLifecycleDeps,
  type ClodexLifecycleEvent,
  type LeaseIdentity,
  type ReleaseOutcome
} from "./clodex-lifecycle";
import {
  createSqliteRecordStore,
  type ClodexLifecycleRecords,
  type SqliteConnection
} from "./clodex-lifecycle-io";
import { createClodexProcessIo, type ClodexProcessDeps, type ClodexProcessOptions } from "./clodex-process-io";
import { CLODEX_WRAPPER_BIN } from "./session-kind";

/** Error scope of every trace emitted by this module. */
const SCOPE = "clodex-lifecycle";

/** Kory's lease store, beside the clodex manifest whose access it coordinates. */
const STORE_FILE = "koryphaios-clodex-lifecycle.db";

/** One value serves both lifecycle loops: the lock retry and the readiness poll. */
const DEFAULT_SLEEP_MS = 250;

/**
 * A waiting Deck must outlast the worst hold of a live holder (proxy
 * registration and readiness on acquire, measured at 15 s; tree-stop
 * confirmation on release, up to 5 s) and the 30 s stale window before a dead
 * holder's lock is reclaimed. The guarantee is this duration, never a number of
 * turns: the count is derived from the sleep actually used, so shortening the
 * sleep buys attempts instead of shortening the wait. Known limit: a caller
 * raising `staleMs` above this budget would void the second half of it.
 */
const DEFAULT_LOCK_BUDGET_MS = 45_000;

const MAX_RUN_ID_LENGTH = 128;
const MAX_HOST_LENGTH = 255;

const EVENT_MESSAGES: Record<ClodexLifecycleEvent["kind"], string> = {
  "lock-error": "the clodex lifecycle lock could not be taken or released",
  "lock-timeout": "the clodex lifecycle lock stayed held by another window",
  "spawn-error": "the clodex proxy could not be started",
  "server-exited": "the clodex proxy exited before it became reachable",
  "readiness-timeout": "the clodex proxy did not accept a connection in time",
  "kill-error": "the clodex proxy could not be stopped",
  "lifecycle-error": "the clodex lifecycle failed"
};

/** Injected IO: the producers clodex-process-io needs, plus what the assembly adds. */
export interface ClodexControllerDeps extends ClodexProcessDeps {
  now(): number;
  /** This Kory process, as the lease identity other windows compare against. */
  pid: number;
  startedAt: number;
  runId: string;
  /** True when the port accepts a TCP connection; resolves false rather than throwing. */
  connect(port: number): Promise<boolean>;
  /** Is `bin` on the operator's PATH? */
  probeBin(bin: string): Promise<boolean>;
  /** Opens the record database, creating the file and its parent directory. */
  openDatabase(path: string): SqliteConnection;
}

export interface ClodexControllerOptions extends ClodexProcessOptions {
  lockAttempts?: number;
  readinessAttempts?: number;
  staleMs?: number;
  sleepMs?: number;
}

export interface ClodexController {
  start(enabled: boolean, proxyArgs: string): Promise<AcquireOutcome>;
  stop(): Promise<ReleaseOutcome>;
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`Clodex lease ${field} must be a positive integer, got ${String(value)}`);
  }
  return value;
}

function requireBoundedString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new TypeError(`Clodex lease ${field} must be a non-empty string of at most ${max} characters`);
  }
  return value;
}

/**
 * A lease is keyed by host, pid and runId and compared by startedAt: a field
 * that is NaN or empty produces a key no liveness check can ever resolve, so
 * the lease would be immortal and its owner unreachable.
 */
function requireLeaseIdentity(deps: ClodexControllerDeps): LeaseIdentity {
  return {
    host: requireBoundedString(deps.hostname(), "host", MAX_HOST_LENGTH),
    pid: requirePositiveInteger(deps.pid, "pid"),
    startedAt: requirePositiveInteger(deps.startedAt, "startedAt"),
    runId: requireBoundedString(deps.runId, "runId", MAX_RUN_ID_LENGTH)
  };
}

/**
 * The interval divides the lock budget, so zero, a fraction or NaN would turn
 * the retry count into Infinity and spin the lock loop forever.
 */
function resolveSleepMs(deps: ClodexControllerDeps, value: number | undefined): number {
  if (value === undefined) return DEFAULT_SLEEP_MS;
  if (Number.isSafeInteger(value) && value > 0) return value;
  deps.onError(SCOPE, `ignoring an unusable clodex sleep interval: ${String(value)}`);
  return DEFAULT_SLEEP_MS;
}

/**
 * Defers `open` to the first record access, and retries it on the next one when
 * it throws, so an unavailable database is a failed start rather than a
 * controller that stays broken for the rest of the run.
 */
function lazyRecords(open: () => ClodexLifecycleRecords): ClodexLifecycleRecords {
  let store: ClodexLifecycleRecords | null = null;
  const resolve = (): ClodexLifecycleRecords => {
    if (!store) store = open();
    return store;
  };
  return {
    read: <T>(key: string) => resolve().read<T>(key),
    write: <T>(key: string, value: T) => resolve().write<T>(key, value),
    createExclusive: <T>(key: string, value: T) => resolve().createExclusive<T>(key, value),
    remove: (key: string) => resolve().remove(key),
    removeIfEquals: <T>(key: string, expected: T) => resolve().removeIfEquals<T>(key, expected),
    list: <T>(prefix: string) => resolve().list<T>(prefix)
  };
}

export function createClodexController(
  deps: ClodexControllerDeps,
  options: ClodexControllerOptions = {}
): ClodexController {
  const sleepMs = resolveSleepMs(deps, options.sleepMs);
  const processIo = createClodexProcessIo(deps, options);
  const storePath = (): string => `${clodexHome(deps.env)}/${STORE_FILE}`;
  const records = lazyRecords(() => createSqliteRecordStore(deps.openDatabase(storePath())));

  const lifecycleDeps: ClodexLifecycleDeps = {
    now: () => deps.now(),
    probeClodex: () => deps.probeBin(CLODEX_WRAPPER_BIN),
    readServer: processIo.readServer,
    isAlive: processIo.isAlive,
    measureServer: processIo.measureServer,
    tcpReady: (server) => deps.connect(server.port),
    spawn: processIo.spawn,
    stopTree: processIo.stopTree,
    read: records.read,
    write: records.write,
    createExclusive: records.createExclusive,
    remove: records.remove,
    removeIfEquals: records.removeIfEquals,
    list: records.list,
    sleep: () => deps.sleep(sleepMs),
    onEvent: (event) => deps.onError(SCOPE, EVENT_MESSAGES[event.kind], event.error)
  };

  type Lifecycle = ReturnType<typeof createClodexLifecycle>;
  let lifecycle: Lifecycle | null = null;

  const resolveLifecycle = (): Lifecycle | null => {
    if (lifecycle) return lifecycle;
    let identity: LeaseIdentity;
    try {
      identity = requireLeaseIdentity(deps);
    } catch (error) {
      deps.onError(SCOPE, "the clodex lease identity of this window is unusable", error);
      return null;
    }
    lifecycle = createClodexLifecycle(lifecycleDeps, identity, {
      lockAttempts: options.lockAttempts ?? Math.ceil(DEFAULT_LOCK_BUDGET_MS / sleepMs),
      readinessAttempts: options.readinessAttempts,
      staleMs: options.staleMs
    });
    return lifecycle;
  };

  return {
    async start(enabled: boolean, proxyArgs: string): Promise<AcquireOutcome> {
      const engine = resolveLifecycle();
      if (!engine) return { action: "failed" };
      return engine.acquire(enabled, proxyArgs);
    },
    async stop(): Promise<ReleaseOutcome> {
      if (!lifecycle) return { action: "released" };
      return lifecycle.release();
    }
  };
}
