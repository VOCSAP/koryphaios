// The Deck writes ONE key of a file it does not own: the claude-peers core
// config, shared with server.ts, cli.ts and every non-Kory session on the
// machine. Two guarantees are what make that acceptable -- every other key
// survives the write, and a file this module could not parse is never
// overwritten (a broker_url and a bearer token nobody can read back would be
// destroyed by a "helpful" rewrite).

import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  LOCK_ATTEMPTS,
  LOCK_RETRY_MS,
  LOCK_STALE_MS,
  processIsAlive,
  readPeersConfigSummary,
  writeOfflineReplica,
  type ConfigLockDeps,
} from "../desktop/src/main/peers-config-store.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "cp-peersconf-"));
  dirs.push(d);
  return d;
}

/** A config file with `content` written verbatim (so malformed text is possible). */
function fileWith(content: string): string {
  const path = join(freshDir(), "config.json");
  writeFileSync(path, content, "utf-8");
  return path;
}

function jsonAt(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
}

const NO_ENV = {} as unknown as NodeJS.ProcessEnv;

// ---------------------------------------------------------------------------
// readPeersConfigSummary
// ---------------------------------------------------------------------------

test("summary of an absent file: local mode, no url, no token, opt-in off, serves nothing", () => {
  const summary = readPeersConfigSummary(join(freshDir(), "nothing-here.json"), NO_ENV);
  expect(summary).toEqual({
    mode: "local",
    brokerUrl: null,
    hasToken: false,
    offlineReplica: false,
    serveReplicas: false,
    forcedByEnv: { brokerUrl: false, offlineReplica: false },
  });
});

test("serveReplicas: the file decides, the environment overrides, an unknown word decides nothing", () => {
  // Same vocabulary as every other claude-peers flag -- reported here, not
  // re-derived, so the panel says what the broker will actually serve.
  const off = fileWith(JSON.stringify({ broker_url: "http://host:7899" }));
  expect(readPeersConfigSummary(off, NO_ENV).serveReplicas).toBe(false);
  const on = fileWith(JSON.stringify({ broker_url: "http://host:7899", serve_replicas: true }));
  expect(readPeersConfigSummary(on, NO_ENV).serveReplicas).toBe(true);

  const envOff = { CLAUDE_PEERS_SERVE_REPLICAS: "0" } as unknown as NodeJS.ProcessEnv;
  expect(readPeersConfigSummary(on, envOff).serveReplicas).toBe(false);
  const envOn = { CLAUDE_PEERS_SERVE_REPLICAS: "yes" } as unknown as NodeJS.ProcessEnv;
  expect(readPeersConfigSummary(off, envOn).serveReplicas).toBe(true);

  for (const raw of ["", "  ", "maybe", "2"]) {
    const env = { CLAUDE_PEERS_SERVE_REPLICAS: raw } as unknown as NodeJS.ProcessEnv;
    expect(
      readPeersConfigSummary(on, env).serveReplicas,
      "a word the flag parser does not recognize must leave the file in charge"
    ).toBe(true);
  }
});

test("serveReplicas is a truthiness-free read: only a real boolean true enables it", () => {
  // The file is hand-edited by operators and provisioning scripts; "true" and
  // 1 are the two shapes a JSON writer produces by accident, and neither may
  // be reported as an enabled broker capability.
  for (const hostile of ["true", 1, "yes", {}, [], null]) {
    const path = fileWith(JSON.stringify({ serve_replicas: hostile }));
    expect(readPeersConfigSummary(path, NO_ENV).serveReplicas).toBe(false);
  }
});

test("summary reports the mode the sessions will actually use, not a second reading", () => {
  const remote = fileWith(JSON.stringify({ broker_url: "http://host:7899" }));
  expect(readPeersConfigSummary(remote, NO_ENV).mode).toBe("remote");
  const replica = fileWith(
    JSON.stringify({ broker_url: "http://host:7899", offline_replica: true })
  );
  expect(readPeersConfigSummary(replica, NO_ENV).mode).toBe("replica");
});

test("the bearer token is reported as a yes/no marker and never as a value", () => {
  const path = fileWith(
    JSON.stringify({ broker_url: "http://host:7899", broker_token: "s3cr3t-token" })
  );
  const summary = readPeersConfigSummary(path, NO_ENV);
  expect(summary.hasToken).toBe(true);
  // The whole payload, serialized: the secret must appear nowhere in it.
  expect(JSON.stringify(summary)).not.toContain("s3cr3t-token");
});

test("an env-set broker url is reported as forced, and is the url shown", () => {
  const path = fileWith(JSON.stringify({ broker_url: "http://from-file:7899" }));
  const env = { CLAUDE_PEERS_BROKER_URL: "http://from-env:7899" } as unknown as NodeJS.ProcessEnv;
  const summary = readPeersConfigSummary(path, env);
  expect(summary.brokerUrl).toBe("http://from-env:7899");
  expect(summary.forcedByEnv.brokerUrl).toBe(true);
  expect(summary.forcedByEnv.offlineReplica).toBe(false);
});

test("CLAUDE_PEERS_OFFLINE_REPLICA is reported as forced whichever way it points", () => {
  const path = fileWith(JSON.stringify({ broker_url: "http://host:7899" }));
  for (const [raw, mode] of [
    ["1", "replica"],
    ["false", "remote"],
  ] as const) {
    const env = { CLAUDE_PEERS_OFFLINE_REPLICA: raw } as unknown as NodeJS.ProcessEnv;
    const summary = readPeersConfigSummary(path, env);
    // Forced OFF is as much a force as forced on: the checkbox must be
    // disabled in both cases, otherwise it silently decides nothing.
    expect(summary.forcedByEnv.offlineReplica).toBe(true);
    expect(summary.mode).toBe(mode);
  }
});

test("an EMPTY broker-url variable still FORCES: it is read before the file, and blanks it", () => {
  // The resolver reads the variable whatever it holds (`??` only falls through
  // on undefined), so an empty one forces local mode. Reporting it as
  // not-forced would leave the operator staring at "Local" over a file that
  // clearly names a broker.
  const path = fileWith(JSON.stringify({ broker_url: "http://host:7899", offline_replica: true }));
  const env = { CLAUDE_PEERS_BROKER_URL: "" } as unknown as NodeJS.ProcessEnv;
  const summary = readPeersConfigSummary(path, env);
  expect(summary.mode).toBe("local");
  expect(summary.brokerUrl).toBeNull();
  expect(summary.forcedByEnv.brokerUrl).toBe(true);
});

test("an UNRECOGNIZED replica flag forces nothing: the file keeps deciding", () => {
  const path = fileWith(JSON.stringify({ broker_url: "http://host:7899", offline_replica: true }));
  for (const raw of ["", "  ", "maybe", "2"]) {
    const env = { CLAUDE_PEERS_OFFLINE_REPLICA: raw } as unknown as NodeJS.ProcessEnv;
    const summary = readPeersConfigSummary(path, env);
    expect(summary.forcedByEnv.offlineReplica).toBe(false);
    // Proof that the report matches the resolver: the file's opt-in still wins.
    expect(summary.mode).toBe("replica");
  }
});

test("offlineReplica reports the FILE, not the resolved mode", () => {
  const path = fileWith(JSON.stringify({ broker_url: "http://host:7899", offline_replica: true }));
  const env = { CLAUDE_PEERS_OFFLINE_REPLICA: "0" } as unknown as NodeJS.ProcessEnv;
  const summary = readPeersConfigSummary(path, env);
  expect(summary.mode).toBe("remote");
  expect(summary.offlineReplica).toBe(true);
});

// ---------------------------------------------------------------------------
// writeOfflineReplica: round-trip
// ---------------------------------------------------------------------------

test("round-trip: every other key of the file survives the write", () => {
  const path = fileWith(
    JSON.stringify({
      port: 7900,
      broker_url: "http://host:7899",
      broker_token: "keep-me",
      a_key_this_module_never_heard_of: { nested: [1, 2, 3] },
    })
  );
  writeOfflineReplica(path, true);
  expect(jsonAt(path)).toEqual({
    port: 7900,
    broker_url: "http://host:7899",
    broker_token: "keep-me",
    a_key_this_module_never_heard_of: { nested: [1, 2, 3] },
    offline_replica: true,
  });
  writeOfflineReplica(path, false);
  expect(jsonAt(path).offline_replica).toBe(false);
  expect(jsonAt(path).broker_token).toBe("keep-me");
});

test("an absent file is created, with the opt-in as its only key", () => {
  const path = join(freshDir(), "sub", "dir", "config.json");
  expect(existsSync(path)).toBe(false);
  writeOfflineReplica(path, true);
  expect(jsonAt(path)).toEqual({ offline_replica: true });
});

test("the created file is 0600: it is the file that carries the bearer token", () => {
  if (process.platform === "win32") return; // POSIX mode bits only
  const path = join(freshDir(), "config.json");
  writeOfflineReplica(path, true);
  expect(statSync(path).mode & 0o777).toBe(0o600);
});

test("no .tmp and no .lock file is left behind by a successful write", () => {
  // A DIRECTORY scan, not `existsSync(path + ".tmp")`: the temp file carries
  // the pid and a random suffix, so the fixed-name check would pass without
  // ever looking at what the write really left there.
  const dir = freshDir();
  const path = join(dir, "config.json");
  writeOfflineReplica(path, true);
  expect(readdirSync(dir)).toEqual(["config.json"]);
});

test("the write is visible through the summary immediately after", () => {
  const path = fileWith(JSON.stringify({ broker_url: "http://host:7899" }));
  expect(readPeersConfigSummary(path, NO_ENV).mode).toBe("remote");
  writeOfflineReplica(path, true);
  const summary = readPeersConfigSummary(path, NO_ENV);
  expect(summary.offlineReplica).toBe(true);
  expect(summary.mode).toBe("replica");
});

// ---------------------------------------------------------------------------
// writeOfflineReplica: refusals
// ---------------------------------------------------------------------------

test("a non-boolean value is refused, and nothing is written", () => {
  const path = fileWith(JSON.stringify({ broker_url: "http://host:7899" }));
  for (const hostile of ["true", 1, null, undefined, {}, [], "yes"]) {
    expect(() => writeOfflineReplica(path, hostile)).toThrow(/must be a boolean/);
  }
  expect(jsonAt(path)).toEqual({ broker_url: "http://host:7899" });
});

test("a malformed existing file is PRESERVED byte for byte, and the write throws", () => {
  const raw = '{ "broker_url": "http://host:7899", "broker_token": "irreplaceable"';
  const path = fileWith(raw);
  expect(() => writeOfflineReplica(path, true)).toThrow(/not valid JSON/);
  expect(readFileSync(path, "utf-8")).toBe(raw);
  // A DIRECTORY scan, like the round-trip case: the temp file carries the pid
  // and a random suffix, so a fixed-name check would pass without ever looking
  // at what the refused write left behind (temp file, lock file, or both).
  expect(readdirSync(dirname(path))).toEqual(["config.json"]);
});

test("a file holding a JSON ARRAY or a scalar is preserved too, not spread into an object", () => {
  for (const raw of ["[1, 2, 3]", '"a string"', "42", "null"]) {
    const path = fileWith(raw);
    expect(() => writeOfflineReplica(path, true)).toThrow(/not a JSON object|not valid JSON/);
    expect(readFileSync(path, "utf-8")).toBe(raw);
  }
});

test("an unreadable file is not overwritten either", () => {
  if (process.platform === "win32" || process.getuid?.() === 0) return; // chmod is advisory there
  const path = fileWith(JSON.stringify({ broker_token: "keep-me" }));
  chmodSync(path, 0o000);
  try {
    expect(() => writeOfflineReplica(path, true)).toThrow(/could not be read/);
  } finally {
    chmodSync(path, 0o600);
  }
  expect(jsonAt(path)).toEqual({ broker_token: "keep-me" });
});

// ---------------------------------------------------------------------------
// writeOfflineReplica: the inter-process lock
//
// Two Kory windows (or a window and cli.ts) each read the file, each preserve
// "every other key" as of their OWN read, and the later write silently drops
// what the earlier one added. The lock is what makes the read-modify-write one
// critical section; every dependency of its timing is injected, so none of
// these tests races a real process or waits a real millisecond.
// ---------------------------------------------------------------------------

/** Test deps: a frozen clock, a scripted liveness answer, a counted sleep. */
function lockProbe(
  overrides: Partial<ConfigLockDeps> = {}
): ConfigLockDeps & { sleeps: number[] } {
  const sleeps: number[] = [];
  return {
    now: () => 1_000_000,
    isAlive: () => false,
    sleep: (ms: number) => {
      sleeps.push(ms);
    },
    pid: 4242,
    sleeps,
    ...overrides,
  };
}

/** Write a lock file as another process would have left it. */
function holdLock(path: string, holder: unknown): string {
  const lockPath = `${path}.lock`;
  writeFileSync(lockPath, typeof holder === "string" ? holder : JSON.stringify(holder), "utf-8");
  return lockPath;
}

test("a lock held by a LIVE process: the write waits its bounded turn, then refuses explicitly", () => {
  const path = fileWith(JSON.stringify({ broker_url: "http://host:7899", broker_token: "keep-me" }));
  // Old enough to be a takeover candidate on age alone -- only the liveness
  // check is holding it, which is the half being proven here.
  const lockPath = holdLock(path, { pid: 999, at: 0 });
  const deps = lockProbe({ isAlive: () => true });
  expect(() => writeOfflineReplica(path, true, deps)).toThrow(
    /another process is writing the claude-peers config/
  );
  // Waited, and waited a BOUNDED number of times: an unbounded loop here would
  // freeze the Electron main process (the sleep is synchronous on purpose).
  expect(deps.sleeps).toEqual(new Array(LOCK_ATTEMPTS).fill(LOCK_RETRY_MS));
  // The file the other process is writing was not touched, and its lock stands.
  expect(jsonAt(path)).toEqual({ broker_url: "http://host:7899", broker_token: "keep-me" });
  expect(existsSync(lockPath)).toBe(true);
});

test("a STALE lock (dead pid, older than the TTL) is taken over and the write succeeds", () => {
  const path = fileWith(JSON.stringify({ broker_url: "http://host:7899" }));
  const lockPath = holdLock(path, { pid: 999, at: 1_000_000 - LOCK_STALE_MS - 1 });
  const deps = lockProbe({ isAlive: () => false });
  writeOfflineReplica(path, true, deps);
  expect(jsonAt(path)).toEqual({ broker_url: "http://host:7899", offline_replica: true });
  // Taken over on the FIRST retry, without sleeping: an abandoned lock must
  // not cost the operator a second of frozen UI.
  expect(deps.sleeps).toEqual([]);
  expect(existsSync(lockPath)).toBe(false);
});

test("a RECENT lock by a dead pid is NOT taken over: the TTL is load-bearing on its own", () => {
  // The window this closes: a process that has just created its lock and has
  // not yet been observed as alive (a spawn in flight, a pid table lagging).
  const path = fileWith(JSON.stringify({ broker_url: "http://host:7899" }));
  holdLock(path, { pid: 999, at: 1_000_000 - LOCK_STALE_MS + 1 });
  const deps = lockProbe({ isAlive: () => false });
  expect(() => writeOfflineReplica(path, true, deps)).toThrow(
    /another process is writing the claude-peers config/
  );
  expect(deps.sleeps.length).toBe(LOCK_ATTEMPTS);
});

test("a lock whose content cannot be attributed still EXPIRES, on the file's mtime", () => {
  // A process killed between creating the lock and writing its body would
  // otherwise wedge every window on the machine forever -- no pid to probe,
  // no timestamp to age.
  const path = fileWith(JSON.stringify({ broker_url: "http://host:7899" }));
  const lockPath = holdLock(path, "{ truncated");
  const old = (1_000_000 - LOCK_STALE_MS - 1_000) / 1000;
  utimesSync(lockPath, old, old);
  const deps = lockProbe({ isAlive: () => true });
  writeOfflineReplica(path, true, deps);
  expect(jsonAt(path).offline_replica).toBe(true);
  expect(existsSync(lockPath)).toBe(false);
});

test("the give-up message names the recovery: the operator reads it verbatim in a toast", () => {
  // The thrown text IS the toast (guarded() surfaces the IPC error raw), so a
  // message that only says "another process is writing" reads as a permanent
  // state instead of something a second click resolves.
  const path = fileWith(JSON.stringify({ broker_url: "http://host:7899" }));
  holdLock(path, { pid: 999, at: 1_000_000 });
  let message = "";
  try {
    writeOfflineReplica(path, true, lockProbe({ isAlive: () => true }));
  } catch (e) {
    message = e instanceof Error ? e.message : String(e);
  }
  expect(message).toMatch(/another process is writing the claude-peers config/);
  expect(
    message.includes(`${LOCK_STALE_MS / 1000} s`) && /retry/i.test(message),
    "the give-up message must name the takeover delay and tell the operator to retry"
  ).toBe(true);
});

test("an EMPTY lock file is the ordinary wx race, not a fault: no trace, still respected", () => {
  // `wx` publishes the lock the instant it is created; a reader arriving
  // between the create and the body write legitimately sees zero bytes. A
  // reportError here would write a journal line on every contended save.
  const path = fileWith(JSON.stringify({ broker_url: "http://host:7899" }));
  const lockPath = holdLock(path, "");
  const traces: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    traces.push(args.map(String).join(" "));
  };
  try {
    // Recent + unattributed: respected, exactly like a malformed recent lock.
    expect(() => writeOfflineReplica(path, true, lockProbe({ now: () => Date.now() }))).toThrow(
      /another process is writing/
    );
  } finally {
    console.error = original;
  }
  expect(
    traces.filter((t) => t.includes("not valid JSON")),
    "an empty lock file is a race, not malformed content: it must leave no trace"
  ).toEqual([]);
  expect(existsSync(lockPath)).toBe(true);
});

test("an EMPTY lock file older than the TTL is taken over, like any unattributed one", () => {
  const path = fileWith(JSON.stringify({ broker_url: "http://host:7899" }));
  const lockPath = holdLock(path, "");
  const old = (1_000_000 - LOCK_STALE_MS - 1_000) / 1000;
  utimesSync(lockPath, old, old);
  writeOfflineReplica(path, true, lockProbe({ isAlive: () => true }));
  expect(jsonAt(path).offline_replica).toBe(true);
  expect(existsSync(lockPath)).toBe(false);
});

test("an unattributable lock that is RECENT is still respected", () => {
  const path = fileWith(JSON.stringify({ broker_url: "http://host:7899" }));
  const lockPath = holdLock(path, "{ truncated");
  const deps = lockProbe({ now: () => Date.now() });
  expect(() => writeOfflineReplica(path, true, deps)).toThrow(
    /another process is writing the claude-peers config/
  );
  expect(existsSync(lockPath)).toBe(true);
});

test("an old lock carrying OUR OWN pid is taken over: a recycled pid cannot wedge the file", () => {
  // The critical section is synchronous and always released in a finally, so
  // no caller in THIS process can be holding the lock while we ask for it.
  // isAlive answers true here (our own pid is alive), which is exactly the
  // answer that would deadlock without this rule.
  const path = fileWith(JSON.stringify({ broker_url: "http://host:7899" }));
  const deps = lockProbe({ isAlive: () => true });
  const lockPath = holdLock(path, { pid: deps.pid, at: 1_000_000 - LOCK_STALE_MS - 1 });
  writeOfflineReplica(path, true, deps);
  expect(jsonAt(path).offline_replica).toBe(true);
  expect(existsSync(lockPath)).toBe(false);
});

test("the lock is released even when the write REFUSES: a malformed file is not left locked", () => {
  const path = fileWith('{ "broker_url": "http://host:7899"');
  expect(() => writeOfflineReplica(path, true, lockProbe())).toThrow(/not valid JSON/);
  expect(existsSync(`${path}.lock`)).toBe(false);
  // And the next attempt is not blocked by the previous refusal.
  expect(() => writeOfflineReplica(path, true, lockProbe())).toThrow(/not valid JSON/);
});

test("a non-boolean value is refused BEFORE any lock file is created", () => {
  const path = fileWith(JSON.stringify({ broker_url: "http://host:7899" }));
  expect(() => writeOfflineReplica(path, "true", lockProbe())).toThrow(/must be a boolean/);
  expect(readdirSync(dirname(path))).toEqual(["config.json"]);
});

test("processIsAlive: this process is alive, an unassigned pid is not", () => {
  expect(processIsAlive(process.pid)).toBe(true);
  // A pid the OS will never assign: kill(2) answers ESRCH, the only code that
  // means "gone". EPERM ("exists, not yours to signal") is deliberately read
  // as ALIVE -- another user's broker holding the lock must not be evicted.
  expect(processIsAlive(0x7fffffff)).toBe(false);
});
