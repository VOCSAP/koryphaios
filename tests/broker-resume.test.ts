import { test, expect, beforeAll, afterAll } from "bun:test";
import { hostname } from "node:os";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { startBroker, stopBroker, post, livePid, type TestBroker } from "./_helper.ts";

let broker: TestBroker;
const brokers: TestBroker[] = [];

beforeAll(async () => { broker = await startBroker(); });
afterAll(async () => {
  await stopBroker(broker);
  for (const b of brokers) { await stopBroker(b); }
});

/** Card 3d121a74 lot L3-a: the two new OPTIONAL identity fields. */
interface RegisterExtras {
  desk_session?: string;
  cc_session_id?: string;
}

async function register(
  host: string,
  cwd: string,
  pid: number = livePid(),
  extras: RegisterExtras = {}
) {
  return post<{ peer_id: string; instance_token: string }>(`${broker.url}/register`, {
    pid, cwd, git_root: null, tty: null, summary: "", host, client_pid: 1,
    project_key: null, group_id: "default", group_secret_hash: null,
    ...extras,
  });
}

async function disconnect(token: string): Promise<void> {
  await post(`${broker.url}/disconnect`, { instance_token: token });
}

function sessionRows(host: string, cwd: string): { session_key: string; instance_token: string; cc_session_id: string }[] {
  const db = new Database(broker.dbPath, { readonly: true });
  const rows = db.query(
    "SELECT session_key, instance_token, cc_session_id FROM peer_sessions WHERE host = ? AND cwd = ? ORDER BY session_key"
  ).all(host, cwd) as { session_key: string; instance_token: string; cc_session_id: string }[];
  db.close();
  return rows;
}

test("re-register after /disconnect resurrects the same instance_token and peer_id", async () => {
  const a = await register("hostR", "/p1");
  const tok1 = a.body.instance_token;
  const id1 = a.body.peer_id;

  await post(`${broker.url}/disconnect`, { instance_token: tok1 });

  const a2 = await register("hostR", "/p1");
  expect(a2.body.instance_token).toBe(tok1);
  expect(a2.body.peer_id).toBe(id1);
});

test("dead-pid registration on the same (host, cwd) is treated as resurrect", async () => {
  // The post-crash dead-pid optimization is scoped to same-host peers (the
  // broker can only probe its own machine's process table). The same-host
  // scenario uses hostname() of the test runner, which equals BROKER_HOST.
  const myHost = hostname();
  const deadPid = 999_999_999;
  const a = await register(myHost, "/dp", deadPid);
  const tok1 = a.body.instance_token;
  const id1 = a.body.peer_id;

  // Re-register with a live pid; broker should detect dead pid -> resurrect.
  const a2 = await register(myHost, "/dp", livePid());
  expect(a2.body.instance_token).toBe(tok1);
  expect(a2.body.peer_id).toBe(id1);
});

test("different (host, cwd, group) yields distinct peers", async () => {
  const a = await register("h1", "/c1");
  const b = await register("h2", "/c1"); // different host
  const c = await register("h1", "/c2"); // different cwd
  expect(a.body.instance_token).not.toBe(b.body.instance_token);
  expect(a.body.instance_token).not.toBe(c.body.instance_token);
});

test("resume preserves claude_cli_pid through dormant cycle", async () => {
  const b = await startBroker();
  brokers.push(b);

  const first = await post<{ instance_token: string; peer_id: string }>(
    `${b.url}/register`,
    {
      pid: livePid(), cwd: "/tmp/resume-pid", git_root: null, tty: null,
      summary: "", host: "host-resume", client_pid: livePid(),
      claude_cli_pid: 91234, project_key: null,
      group_id: "default", group_secret_hash: null,
    }
  );
  expect(first.status).toBe(200);

  // Move to dormant.
  await post(`${b.url}/disconnect`, { instance_token: first.body.instance_token });

  // Re-register with the same (host, cwd, group_id) -> resume the dormant peer with a new claude_cli_pid.
  const second = await post<{ instance_token: string; peer_id: string }>(
    `${b.url}/register`,
    {
      pid: livePid(), cwd: "/tmp/resume-pid", git_root: null, tty: null,
      summary: "", host: "host-resume", client_pid: livePid(),
      claude_cli_pid: 99999, project_key: null,
      group_id: "default", group_secret_hash: null,
    }
  );
  expect(second.status).toBe(200);
  expect(second.body.instance_token).toBe(first.body.instance_token);

  const db = new Database(b.dbPath, { readonly: true });
  const row = db.query(
    "SELECT claude_cli_pid FROM peers WHERE instance_token = ?"
  ).get(first.body.instance_token) as { claude_cli_pid: number };
  db.close();
  expect(row.claude_cli_pid).toBe(99999);
});

// ----- Card 3d121a74 lot L3-a: per-tile identity key -----
//
// The measured defect these close: one peer_sessions row per DIRECTORY while a
// team puts N agents in one, so in the dormant window a DIFFERENT CC session
// opened there inherited the previous occupant's instance_token -- hence its
// undelivered mail, `messages` being keyed by to_token.

test("a peer_sessions row written under the LEGACY key is still resurrected by a register with NO discriminant", async () => {
  // Proves at database level that a peer_sessions row written under the
  // pre-widening hash algorithm is still found by a register call carrying no
  // discriminant -- the property that matters for every non-Deck CLI caller,
  // since they never send one.
  // The hash is recomputed here from its documented definition, independently
  // of sessionKey's current implementation, since no test run can otherwise
  // produce a value written by a binary that predates the widening: every fresh
  // run shares whatever algorithm is current.
  // Do not delete this as redundant with the resume tests nearby -- the failure
  // mode it simulates only exists across a binary boundary, and this is one of
  // only two ways a test can cross that boundary; the other downgrades a real
  // database instead.
  const host = "hostLegacy";
  const cwd = "/legacy-key";
  const a = await register(host, cwd);

  const legacy = createHash("sha256")
    .update(host).update("\0")
    .update(cwd).update("\0")
    .update("default")
    .digest("hex");

  const rows = sessionRows(host, cwd);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.session_key).toBe(legacy);

  // ... and it still resurrects through a dormant cycle.
  await disconnect(a.body.instance_token);
  const a2 = await register(host, cwd);
  expect(a2.body.instance_token).toBe(a.body.instance_token);
  expect(a2.body.peer_id).toBe(a.body.peer_id);
});

test("two tiles sharing one directory own DISTINCT rows and never share an instance_token", async () => {
  const host = "hostTiles";
  const cwd = "/shared-dir";
  const t1 = await register(host, cwd, livePid(), { desk_session: "tile-token-1" });
  const t2 = await register(host, cwd, livePid(), { desk_session: "tile-token-2" });

  expect(t2.body.instance_token).not.toBe(t1.body.instance_token);
  // Two ROWS, not one row fought over: this is the whole point of the lot.
  const rows = sessionRows(host, cwd);
  expect(rows).toHaveLength(2);
  expect(new Set(rows.map((r) => r.instance_token)).size).toBe(2);
});

test("the same tile token resurrects its OWN row through a dormant cycle", async () => {
  const host = "hostTileResume";
  const cwd = "/tile-resume";
  const t1 = await register(host, cwd, livePid(), { desk_session: "stable-tile" });
  await disconnect(t1.body.instance_token);
  const again = await register(host, cwd, livePid(), { desk_session: "stable-tile" });
  expect(again.body.instance_token).toBe(t1.body.instance_token);
});

test("Restore gesture: a NEW tile token with the SAME cc_session_id reclaims the row", async () => {
  // fromWorkspaceSessions mints a fresh tile id (randomUUID) while preserving
  // the CC session id, so the widened key legitimately misses on a session
  // that IS continuing. The secondary lookup is what keeps the operator's
  // rule 3 ("Restore gives back the old id") true.
  const host = "hostRestore";
  const cwd = "/restore-me";
  const before = await register(host, cwd, livePid(), {
    desk_session: "tile-before-restore",
    cc_session_id: "cc-session-kept",
  });
  await disconnect(before.body.instance_token);

  const after = await register(host, cwd, livePid(), {
    desk_session: "tile-AFTER-restore", // new tile, minted by the restore
    cc_session_id: "cc-session-kept",    // same CC session
  });
  expect(after.body.instance_token).toBe(before.body.instance_token);
  expect(after.body.peer_id).toBe(before.body.peer_id);
});

test("the secondary cc_session_id lookup is SCOPED -- a DORMANT row from another cwd is never reclaimed", async () => {
  // cc_session_id is DECLARED by the caller and never proven, so without the
  // (group_id, host, cwd) scoping anyone who knows a CC id reclaims the row of
  // a tile in ANOTHER directory -- its token and its mail. That is this
  // card's own defect, entered by the other door.
  const cc = "cc-scope-probe";
  const owner = await register("hostScope", "/scope-a", livePid(), {
    desk_session: "tile-scope-a",
    cc_session_id: cc
  });
  // The victim must be DORMANT: while it is active the collision branch mints
  // a fresh peer anyway and masks an unscoped lookup entirely.
  await disconnect(owner.body.instance_token);
  const stranger = await register("hostScope", "/scope-b", livePid(), {
    desk_session: "tile-scope-b",
    cc_session_id: cc
  });
  expect(stranger.body.instance_token).not.toBe(owner.body.instance_token);
  const rows = sessionRows("hostScope", "/scope-a");
  expect(rows).toHaveLength(1);
  expect(rows[0]?.instance_token).toBe(owner.body.instance_token);
});

test("an EMPTY cc_session_id never reclaims a legacy row (the empty string is not an identity)", async () => {
  // cc_session_id defaults to '' for every legacy row, so an unguarded
  // secondary lookup would match ALL of them and hand this caller someone
  // else's line -- token and undelivered mail included, which is exactly the
  // defect this lot closes. Remove the `&& ccSessionId` guard and this goes red.
  const host = "hostEmptyCc";
  const cwd = "/empty-cc";
  const legacyPeer = await register(host, cwd); // no discriminant, no cc -> cc_session_id ''
  await disconnect(legacyPeer.body.instance_token);

  const newTile = await register(host, cwd, livePid(), { desk_session: "some-other-tile" });
  expect(newTile.body.instance_token).not.toBe(legacyPeer.body.instance_token);
});

test("two rows sharing one cc_session_id FAIL CLOSED: a third tile gets a fresh identity, never one of the two", async () => {
  // This state is reached by restoring the same CC session twice: restore
  // resurrects the row under the new tile's key while the pre-restore row
  // survives, so both end up sharing one cc_session_id.
  // Two simultaneously live tiles do not reproduce this: the second register
  // hits the active-collision branch and mints a derived id instead.
  const host = "hostAmbiguous";
  const cwd = "/ambiguous-cc";
  const one = await register(host, cwd, livePid(), { desk_session: "tile-A", cc_session_id: "cc-dup" });
  await disconnect(one.body.instance_token);

  const restored = await register(host, cwd, livePid(), { desk_session: "tile-B", cc_session_id: "cc-dup" });
  expect(restored.body.instance_token).toBe(one.body.instance_token); // reclaimed, as designed
  await disconnect(restored.body.instance_token);

  // Premise asserted, not assumed: two rows now carry the same cc_session_id.
  const dupRows = sessionRows(host, cwd).filter((r) => r.cc_session_id === "cc-dup");
  expect(dupRows).toHaveLength(2);

  const third = await register(host, cwd, livePid(), { desk_session: "tile-C", cc_session_id: "cc-dup" });
  expect(third.body.instance_token).not.toBe(one.body.instance_token);
  expect(third.body.instance_token).not.toBe(restored.body.instance_token);
});
