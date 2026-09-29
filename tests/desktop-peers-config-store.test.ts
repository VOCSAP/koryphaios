// The Deck writes ONE key of a file it does not own: the claude-peers core
// config, shared with server.ts, cli.ts and every non-Kory session on the
// machine. Two guarantees are what make that acceptable -- every other key
// survives the write, and a file this module could not parse is never
// overwritten (a broker_url and a bearer token nobody can read back would be
// destroyed by a "helpful" rewrite).

import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readPeersConfigSummary, writeOfflineReplica } from "../desktop/src/main/peers-config-store.ts";

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

test("no .tmp file is left behind by a successful write, only the lock database", () => {
  // A DIRECTORY scan, not `existsSync(path + ".tmp")`: the temp file carries
  // the pid and a random suffix, so the fixed-name check would pass without
  // ever looking at what the write really left there.
  const dir = freshDir();
  const path = join(dir, "config.json");
  writeOfflineReplica(path, true);
  expect(readdirSync(dir).sort()).toEqual(["config.json", "config.json.lock.sqlite"]);
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
  // at what the refused write left behind.
  expect(readdirSync(dirname(path)).sort()).toEqual(["config.json", "config.json.lock.sqlite"]);
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
// ---------------------------------------------------------------------------

/** Hold the config's lock the way another writer process would. */
function holdLock(path: string): () => void {
  const holder = new Database(`${path}.lock.sqlite`);
  holder.run("BEGIN IMMEDIATE");
  return () => {
    holder.run("ROLLBACK");
    holder.close();
  };
}

test("a lock held by another writer: the write waits its bounded turn, then refuses with a retry message", () => {
  const path = fileWith(JSON.stringify({ broker_url: "http://host:7899", broker_token: "keep-me" }));
  const release = holdLock(path);
  let message = "";
  const startedAt = Date.now();
  try {
    writeOfflineReplica(path, true);
  } catch (e) {
    message = e instanceof Error ? e.message : String(e);
  } finally {
    release();
  }
  const elapsed = Date.now() - startedAt;
  expect(message, "the thrown text is the operator's toast: it must say who holds the file and to retry").toMatch(
    /another process is writing .*config\.json; retry/
  );
  expect(elapsed, "the synchronous wait freezes the Electron main process, so it must stay bounded").toBeLessThan(3_000);
  expect(jsonAt(path)).toEqual({ broker_url: "http://host:7899", broker_token: "keep-me" });
  writeOfflineReplica(path, true);
  expect(jsonAt(path).offline_replica).toBe(true);
});

test("the lock is released even when the write REFUSES: a malformed file is not left locked", () => {
  const path = fileWith('{ "broker_url": "http://host:7899"');
  expect(() => writeOfflineReplica(path, true)).toThrow(/not valid JSON/);
  expect(() => writeOfflineReplica(path, true)).toThrow(/not valid JSON/);
});

test("a lock file left by the previous lock protocol neither blocks the write nor is deleted", () => {
  const path = fileWith(JSON.stringify({ broker_url: "http://host:7899" }));
  const legacyLock = `${path}.lock`;
  writeFileSync(legacyLock, JSON.stringify({ pid: process.pid, at: Date.now() }));
  writeOfflineReplica(path, true);
  expect(jsonAt(path).offline_replica).toBe(true);
  expect(existsSync(legacyLock)).toBe(true);
});

test("a non-boolean value is refused BEFORE any lock file is created", () => {
  const path = fileWith(JSON.stringify({ broker_url: "http://host:7899" }));
  expect(() => writeOfflineReplica(path, "true")).toThrow(/must be a boolean/);
  expect(readdirSync(dirname(path))).toEqual(["config.json"]);
});

