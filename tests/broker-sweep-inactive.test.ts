import { test, expect, beforeAll, afterAll } from "bun:test";
import { startBroker, stopBroker, post, livePid, type TestBroker } from "./_helper.ts";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Every row of a test is distinct (own host/cwd/token), so the sweep tests
// share one broker: stale after 3s, swept every second (both at or near the
// floor of 1). 3s leaves the heartbeat test a wide margin over its 200 ms
// cadence; it stays far below the 90s rows of the mirror test.
const ACTIVE_STALE_SEC = 3;
const BROKER_TOKEN = "t".repeat(40);
let shared: TestBroker;
let replica: TestBroker;

beforeAll(async () => {
  [shared, replica] = await Promise.all([
    startBroker({
      CLAUDE_PEERS_ACTIVE_STALE_SEC: String(ACTIVE_STALE_SEC),
      CLAUDE_PEERS_DORMANT_SWEEP_SEC: "1",
    }),
    startBroker({
      CLAUDE_PEERS_OFFLINE_REPLICA: "1",
      CLAUDE_PEERS_BROKER_URL: "http://127.0.0.1:59999",
      CLAUDE_PEERS_BROKER_TOKEN: BROKER_TOKEN,
      CLAUDE_PEERS_ACTIVE_STALE_SEC: "10",
    }),
  ]);
});
afterAll(async () => {
  await Promise.all([shared, replica].filter(Boolean).map((b) => stopBroker(b)));
});

async function waitFor<T>(read: () => T | Promise<T>, done: (value: T) => boolean, what: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await read();
  while (!done(last)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; last=${JSON.stringify(last)}`);
    await Bun.sleep(50);
    last = await read();
  }
  return last;
}

function statusOf(b: TestBroker, token: string): string {
  const db = new Database(b.dbPath, { readonly: true });
  try {
    return (db.query("SELECT status FROM peers WHERE instance_token = ?").get(token) as { status: string }).status;
  } finally {
    db.close();
  }
}

test("active peer with stale last_seen is swept to dormant", async () => {
  const r = await post<{ instance_token: string }>(`${shared.url}/register`, {
    pid: livePid(), cwd: "/tmp/sweep", git_root: null, tty: null,
    summary: "", host: "h-sweep", client_pid: livePid(), claude_cli_pid: 1,
    project_key: null, group_id: "default", group_secret_hash: null,
  });
  expect(r.status).toBe(200);

  // Manipulate last_seen to be 1 hour ago so the sweep catches it on next tick.
  const oldDb = new Database(shared.dbPath);
  oldDb.run(
    "UPDATE peers SET last_seen = ? WHERE instance_token = ?",
    [new Date(Date.now() - 3600_000).toISOString(), r.body.instance_token]
  );
  oldDb.close();

  const status = await waitFor(() => statusOf(shared, r.body.instance_token), (s) => s === "dormant", "the stale peer to be swept");
  expect(status).toBe("dormant");
}, 30_000);

test("active peer with recent heartbeat stays active", async () => {
  const register = (host: string, cliPid: number) =>
    post<{ instance_token: string }>(`${shared.url}/register`, {
      pid: livePid(), cwd: `/tmp/${host}`, git_root: null, tty: null,
      summary: "", host, client_pid: livePid(), claude_cli_pid: cliPid,
      project_key: null, group_id: "default", group_secret_hash: null,
    });
  // Registered BEFORE the control, so without its heartbeats its last_seen
  // is never newer than the control's: any sweep that dormants the control
  // would dormant it too, in the same UPDATE.
  const kept = await register("h-keep", 2);
  expect(kept.status).toBe(200);
  const control = await register("h-keep-control", 5);
  expect(control.status).toBe(200);

  // Heartbeat until a sweep has dormanted the silent control. A heartbeat
  // only refreshes last_seen and never revives a dormant row, so the read
  // that follows sees whatever that sweep decided for the kept peer.
  await waitFor(
    async () => {
      const s = statusOf(shared, control.body.instance_token);
      if (s !== "dormant") {
        await post(`${shared.url}/heartbeat`, { instance_token: kept.body.instance_token });
        await Bun.sleep(150);
      }
      return s;
    },
    (s) => s === "dormant",
    "a sweep to dormant the silent control peer"
  );
  expect(statusOf(shared, kept.body.instance_token), "the heartbeating peer survives the sweep that took the silent one").toBe("active");
}, 30_000);

test("mirror rows get a longer, backoff-derived floor than local/relayed rows", async () => {
  // ACTIVE_STALE_SEC=3 for local/relayed rows; SYNC_BACKOFF_MAX_MS defaults
  // to 60_000ms, so mirrorStaleSec(3, 60_000) floors mirror rows at 120s --
  // a 90s-old mirror must survive the sweep tick that dormants a 90s-old
  // local peer and a 90s-old relayed row.
  const r = await post<{ instance_token: string }>(`${shared.url}/register`, {
    pid: livePid(), cwd: "/tmp/sweep-local", git_root: null, tty: null,
    summary: "", host: "h-sweep-local", client_pid: livePid(), claude_cli_pid: 3,
    project_key: null, group_id: "default", group_secret_hash: null,
  });
  expect(r.status).toBe(200);

  const mirrorFresh = randomUUID();
  const mirrorStale = randomUUID();
  const relayed = randomUUID();
  const aliased = randomUUID();
  const ninetySecAgo = new Date(Date.now() - 90_000).toISOString();
  const oneHourAgo = new Date(Date.now() - 3600_000).toISOString();

  const setupDb = new Database(shared.dbPath);
  // One transaction: a sweep pass sees every row below or none of them.
  setupDb.transaction(() => {
    setupDb.run(
      "UPDATE peers SET last_seen = ? WHERE instance_token = ?",
      [ninetySecAgo, r.body.instance_token]
    );
    // A replica's mirror of an upstream peer: via and upstream_peer_id set,
    // relay_id NULL.
    const insertMirror = (token: string, peerId: string, lastSeen: string) =>
      setupDb.run(
        `INSERT INTO peers
           (instance_token, peer_id, group_id, pid, cwd, git_root, tty, summary, registered_at, last_seen,
            last_activity_at, host, client_pid, project_key, claude_cli_pid, role, status, via, upstream_peer_id)
         VALUES (?, ?, 'default', 0, '', NULL, NULL, '', ?, ?, NULL, '', 0, NULL, NULL, NULL, 'active', 'upstream', ?)`,
        [token, peerId, lastSeen, lastSeen, peerId]
      );
    insertMirror(mirrorFresh, "mirror-90s", ninetySecAgo);
    insertMirror(mirrorStale, "mirror-1h", oneHourAgo);
    // An upstream's relay of a replica's own peer: relay_id, relay_ref and
    // relay_base set, upstream_peer_id NULL.
    setupDb.run(
      `INSERT INTO peers
         (instance_token, peer_id, group_id, pid, cwd, git_root, tty, summary, registered_at, last_seen,
          last_activity_at, host, client_pid, project_key, claude_cli_pid, role, status, relay_id, relay_ref, relay_base, via)
       VALUES (?, 'relayed-peer', 'default', 0, '', NULL, NULL, '', ?, ?, NULL, '', 0, NULL, NULL, NULL, 'active', 'replica-1', 'ref-1', 'relayed-peer', 'upstream')`,
      [relayed, ninetySecAgo, ninetySecAgo]
    );
    // A LOCAL peer of a replica that the upstream aliased: upstream_peer_id set,
    // via and relay_id NULL. It beats its own heart, so it is not a mirror.
    setupDb.run(
      `INSERT INTO peers
         (instance_token, peer_id, group_id, pid, cwd, git_root, tty, summary, registered_at, last_seen,
          last_activity_at, host, client_pid, project_key, claude_cli_pid, role, status, upstream_peer_id)
       VALUES (?, 'aliased-local', 'default', 0, '', NULL, NULL, '', ?, ?, NULL, '', 0, NULL, NULL, NULL, 'active', 'aliased-local-2')`,
      [aliased, ninetySecAgo, ninetySecAgo]
    );
  })();
  setupDb.close();

  // The hour-old mirror falls in the sweep's second UPDATE, which runs after
  // the first in the same pass: once it is dormant, one full pass has judged
  // every row above.
  await waitFor(() => statusOf(shared, mirrorStale), (s) => s === "dormant", "a full sweep pass over the setup rows");

  const checkDb = new Database(shared.dbPath, { readonly: true });
  const statusIn = (token: string) =>
    (checkDb.query("SELECT status FROM peers WHERE instance_token = ?").get(token) as { status: string }).status;
  const localStatus = statusIn(r.body.instance_token);
  const mirrorFreshStatus = statusIn(mirrorFresh);
  const mirrorStaleStatus = statusIn(mirrorStale);
  const relayedStatus = statusIn(relayed);
  const aliasedStatus = statusIn(aliased);
  checkDb.close();

  expect(localStatus, "a local peer keeps the operator's cutoff: 90s old with a 3s cutoff is dormant").toBe("dormant");
  expect(relayedStatus, "a row an upstream relays for a replica keeps the operator's cutoff too").toBe("dormant");
  expect(mirrorFreshStatus, "a mirror has no heartbeat of its own: 90s without a pass is within the backoff-derived floor, it stays active").toBe("active");
  expect(mirrorStaleStatus, "the mirror floor is a floor, not immunity: an hour-old mirror is swept").toBe("dormant");
  expect(aliasedStatus, "a local peer the upstream aliased still beats its own heart and keeps the operator's cutoff").toBe("dormant");
}, 30_000);

/** Lines of the broker's own rolling log carrying the mirror-floor warning. */
function floorWarnings(b: TestBroker): string[] {
  return readFileSync(join(b.tmpDir, "logs", "broker.log"), "utf-8")
    .split("\n")
    .filter((l) => l.includes("are floored to"));
}

test("a replica started below the mirror floor is warned once, in its own log; a plain broker is not", async () => {
  // The replica's first sync pass runs right after boot and fails against the
  // dead upstream: once it has, startup and that pass are both in the log.
  await waitFor(
    async () => {
      const res = await fetch(`${replica.url}/roadmap/sync/status`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${BROKER_TOKEN}` },
        body: "{}",
      });
      return ((await res.json()) as { last_error: string | null }).last_error;
    },
    (lastError) => lastError !== null,
    "the replica's first sync pass"
  );
  const replicaLines = floorWarnings(replica);
  expect(replicaLines.length, "the operator is told once, and once only, that the value is raised for mirrors").toBe(1);
  expect(replicaLines[0], "the warning names the value, the floor and the reason").toMatch(/=10s.*floored to 120s/);
  expect(floorWarnings(shared).length, "a broker with no upstream has no mirrors and nothing to warn about").toBe(0);
}, 30_000);
