// Card 8d74c669: applyPulledRow's stale-lock-sweep protection
// (isSweepOnlyStatusChange) only ran in the DIRTY branch, but a lock that
// replicated without a hitch is CLEAN (sync_dirty reset to 0 by a successful
// push) and took the plain overwrite branch instead -- so the upstream
// sweep's status=planned landed locally while `locked` stayed 1. The
// discriminant the bug turns on is exactly sync_dirty: two locks held by the
// same agent through the same outage, one edited and one merely held.

import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { startBroker, stopBroker, livePid, type TestBroker } from "./_helper.ts";
import type { RoadmapItem } from "../shared/types.ts";

const PK = "github.com/vocsap/lock-sweep-replicated-repo";
const AUTH = "lock-sweep-suite-marker";

type UpsertRes = { item: RoadmapItem };
type ListRes = { items: RoadmapItem[] };

async function post<T = unknown>(url: string, body: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${AUTH}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T };
}

async function pollUntil<T>(
  budgetMs: number,
  intervalMs: number,
  check: () => Promise<{ done: boolean; value: T }>
): Promise<T> {
  const deadline = Date.now() + budgetMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    const { done, value } = await check();
    last = value;
    if (done) return value;
    await Bun.sleep(intervalMs);
  }
  throw new Error(`timed out after ${budgetMs}ms; last observed ${JSON.stringify(last)}`);
}

function openBrokerDb(path: string): Database {
  const db = new Database(path);
  db.run("PRAGMA busy_timeout = 3000");
  return db;
}

async function itemOn(broker: TestBroker, id: string): Promise<RoadmapItem | undefined> {
  const res = await post<ListRes>(`${broker.url}/roadmap/list`, { project_key: PK });
  return res.body.items.find((i) => i.id === id);
}

test("a lock that replicated cleanly survives the upstream stale-lock sweep, exactly like one with a pending local edit", async () => {
  const upstream = await startBroker({
    CLAUDE_PEERS_BROKER_TOKEN: AUTH,
    CLAUDE_PEERS_SERVE_REPLICAS: "1",
    // TTL kept at production scale so it is never the clause that mords here
    // (card 8d74c669's own measurement: the real trigger is grace/active-stale,
    // not TTL); grace/active-stale/sweep driven down for a fast test.
    CLAUDE_PEERS_LOCK_TTL_SEC: "3600",
    CLAUDE_PEERS_LOCK_GRACE_SEC: "2",
    CLAUDE_PEERS_ACTIVE_STALE_SEC: "1",
    CLAUDE_PEERS_LOCK_SWEEP_SEC: "1",
  });
  let proxy: ReturnType<typeof Bun.serve> | null = null;
  let replica: TestBroker | null = null;
  try {
    let blocked = false;
    proxy = Bun.serve({
      port: 0,
      async fetch(req) {
        if (blocked) return new Response("upstream unreachable", { status: 503 });
        const url = new URL(req.url);
        const headers: Record<string, string> = { "content-type": "application/json" };
        const auth = req.headers.get("authorization");
        if (auth) headers.authorization = auth;
        return fetch(`${upstream.url}${url.pathname}${url.search}`, {
          method: req.method,
          headers,
          body: req.method === "POST" ? await req.text() : undefined,
        });
      },
    });
    replica = await startBroker({
      CLAUDE_PEERS_BROKER_URL: `http://127.0.0.1:${proxy.port}`,
      CLAUDE_PEERS_BROKER_TOKEN: AUTH,
      CLAUDE_PEERS_OFFLINE_REPLICA: "1",
      CLAUDE_PEERS_SYNC_TICK_MS: "120",
    });

    const reg = await post<{ instance_token: string; peer_id: string }>(`${replica.url}/register`, {
      pid: livePid(), cwd: "/tmp/lock-sweep-replicated", git_root: null, tty: null,
      summary: "", host: "h-lock-sweep-replicated", client_pid: livePid(), claude_cli_pid: 1,
      project_key: PK, group_id: "default", group_secret_hash: null,
    });
    expect(reg.status).toBe(200);

    // HELD: claimed, never touched again -- replicates and goes clean.
    const held = await post<UpsertRes>(`${replica.url}/roadmap/upsert`, {
      project_key: PK, by: reg.body.peer_id, instance_token: reg.body.instance_token,
      title: "held, never edited again", status: "in_progress",
    });
    expect(held.body.item.locked).toBe(true);

    // EDITED: claimed too, then written again below -- stays dirty, the
    // discriminant the card names between the protected and the lost card.
    const edited = await post<UpsertRes>(`${replica.url}/roadmap/upsert`, {
      project_key: PK, by: reg.body.peer_id, instance_token: reg.body.instance_token,
      title: "held, then edited before the outage", status: "in_progress",
    });
    expect(edited.body.item.locked).toBe(true);

    // Both claims must reach the upstream AND come back clean locally --
    // the exact precondition the bug (and the fix) depend on -- before
    // either is touched again.
    await pollUntil(15_000, 150, async () => {
      const h = await itemOn(upstream, held.body.item.id);
      const e = await itemOn(upstream, edited.body.item.id);
      return { done: h?.locked === true && e?.locked === true, value: [h, e] };
    });
    const db = openBrokerDb(replica.dbPath);
    await pollUntil(15_000, 150, async () => {
      const rows = db
        .query("SELECT sync_dirty FROM roadmap_items WHERE id IN (?, ?)")
        .all(held.body.item.id, edited.body.item.id) as { sync_dirty: number }[];
      return { done: rows.length === 2 && rows.every((r) => r.sync_dirty === 0), value: rows };
    });
    // Captured now, while clean is confirmed: the direct witness below needs
    // a value from BEFORE the sweep round-trip to prove it advanced, not
    // just that the final row happens to look untouched.
    const heldBaseRevBefore = (
      db.query("SELECT sync_base_rev FROM roadmap_items WHERE id = ?").get(held.body.item.id) as {
        sync_base_rev: number;
      }
    ).sync_base_rev;

    const editedAgain = await post<UpsertRes>(`${replica.url}/roadmap/upsert`, {
      project_key: PK, id: edited.body.item.id, by: reg.body.peer_id,
      instance_token: reg.body.instance_token,
      context: "a note written just before the network drops",
    });
    expect(editedAgain.status).toBe(200);
    const editedDirty = db
      .query("SELECT sync_dirty FROM roadmap_items WHERE id = ?")
      .get(edited.body.item.id) as { sync_dirty: number };
    expect(editedDirty.sync_dirty).toBe(1);
    db.close();

    // Cut the link and let the upstream's OWN owner-liveness clauses expire
    // for this replica's relayed peer row -- production's real mechanism,
    // not a synthetic column edit.
    blocked = true;
    await pollUntil(15_000, 150, async () => {
      const status = (await post<{ online: boolean }>(`${replica!.url}/roadmap/sync/status`, {})).body;
      return { done: status.online === false, value: status.online };
    });

    // Wait for the sweep's own signature upstream -- a positive witness that
    // the sweep actually fired, not just an absence of one particular value.
    const sweptUpstream = await pollUntil(20_000, 200, async () => {
      const item = await itemOn(upstream, held.body.item.id);
      return { done: item?.updated_by === "lock-sweep", value: item };
    });
    // The sweep's own direct effect upstream: it releases the lock itself.
    // What the fix is about is what the REPLICA does with this pulled
    // content, asserted below once the link reopens.
    expect(sweptUpstream!.status).toBe("planned");
    expect(sweptUpstream!.locked).toBe(false);

    blocked = false;
    await pollUntil(15_000, 150, async () => {
      const status = (await post<{ online: boolean }>(`${replica!.url}/roadmap/sync/status`, {})).body;
      return { done: status.online === true, value: status.online };
    });

    // POSITIVE half of the acceptance criterion: the held-only card is now
    // protected exactly like the edited one already was. Gated on
    // sync_base_rev having ADVANCED past heldBaseRevBefore, not just on the
    // final fields matching their starting values: a branch that fired but
    // did nothing to the row would satisfy the field check by pure inertia.
    const dbAfter = openBrokerDb(replica.dbPath);
    const heldAfter = await pollUntil(15_000, 200, async () => {
      const item = await itemOn(replica!, held.body.item.id);
      const row = dbAfter
        .query("SELECT sync_base_rev FROM roadmap_items WHERE id = ?")
        .get(held.body.item.id) as { sync_base_rev: number };
      return {
        done:
          item !== undefined &&
          item.sync_state !== "conflict" &&
          row.sync_base_rev > heldBaseRevBefore,
        value: item,
      };
    });
    dbAfter.close();
    expect([
      "the held-only card keeps its status and its lock after the sweep round-trips",
      heldAfter!.status,
      heldAfter!.locked,
    ]).toEqual([
      "the held-only card keeps its status and its lock after the sweep round-trips",
      "in_progress",
      true,
    ]);

    const editedAfter = await itemOn(replica!, edited.body.item.id);
    expect([
      "the edited card was never at risk under the old code either: it stays in_progress too",
      editedAfter!.status,
    ]).toEqual([
      "the edited card was never at risk under the old code either: it stays in_progress too",
      "in_progress",
    ]);
  } finally {
    if (replica) await stopBroker(replica);
    if (proxy) proxy.stop(true);
    await stopBroker(upstream);
  }
}, 60_000);

test("an ordinary upstream author's status change is adopted, never mistaken for the sweep, on a locally-held clean card", async () => {
  const upstream = await startBroker({
    CLAUDE_PEERS_BROKER_TOKEN: AUTH,
    CLAUDE_PEERS_SERVE_REPLICAS: "1",
  });
  let replica: TestBroker | null = null;
  try {
    replica = await startBroker({
      CLAUDE_PEERS_BROKER_URL: upstream.url,
      CLAUDE_PEERS_BROKER_TOKEN: AUTH,
      CLAUDE_PEERS_OFFLINE_REPLICA: "1",
      CLAUDE_PEERS_SYNC_TICK_MS: "120",
    });

    const reg = await post<{ instance_token: string; peer_id: string }>(`${replica.url}/register`, {
      pid: livePid(), cwd: "/tmp/lock-sweep-ordinary-author", git_root: null, tty: null,
      summary: "", host: "h-lock-sweep-ordinary-author", client_pid: livePid(), claude_cli_pid: 1,
      project_key: PK, group_id: "default", group_secret_hash: null,
    });
    expect(reg.status).toBe(200);

    const held = await post<UpsertRes>(`${replica.url}/roadmap/upsert`, {
      project_key: PK, by: reg.body.peer_id, instance_token: reg.body.instance_token,
      title: "held, then an ordinary upstream write reopens it", status: "in_progress",
    });
    expect(held.body.item.locked).toBe(true);

    await pollUntil(15_000, 150, async () => {
      const item = await itemOn(upstream, held.body.item.id);
      return { done: item?.locked === true, value: item };
    });
    const db = openBrokerDb(replica.dbPath);
    await pollUntil(15_000, 150, async () => {
      const row = db
        .query("SELECT sync_dirty FROM roadmap_items WHERE id = ?")
        .get(held.body.item.id) as { sync_dirty: number };
      return { done: row.sync_dirty === 0, value: row };
    });
    db.close();

    // An ordinary author, not the sweep, reverts status upstream -- the
    // exact content shape isSweepOnlyStatusChange is built to accept, but
    // written by someone else entirely.
    const upstreamDb = openBrokerDb(upstream.dbPath);
    upstreamDb.run(
      "UPDATE roadmap_items SET status = 'planned', updated_by = 'an-ordinary-author' WHERE id = ?",
      [held.body.item.id]
    );
    upstreamDb.close();

    const after = await pollUntil(15_000, 200, async () => {
      const item = await itemOn(replica!, held.body.item.id);
      return { done: item?.updated_by === "an-ordinary-author", value: item };
    });
    expect([
      "an ordinary author's change is adopted, not mistaken for the sweep",
      after!.status,
    ]).toEqual(["an ordinary author's change is adopted, not mistaken for the sweep", "planned"]);
  } finally {
    if (replica) await stopBroker(replica);
    await stopBroker(upstream);
  }
}, 30_000);

test("a swept card this replica does not hold adopts the released state plainly, no protection applies", async () => {
  const upstream = await startBroker({
    CLAUDE_PEERS_BROKER_TOKEN: AUTH,
    CLAUDE_PEERS_SERVE_REPLICAS: "1",
    CLAUDE_PEERS_LOCK_TTL_SEC: "3600",
    CLAUDE_PEERS_LOCK_GRACE_SEC: "2",
    CLAUDE_PEERS_ACTIVE_STALE_SEC: "1",
    CLAUDE_PEERS_LOCK_SWEEP_SEC: "1",
  });
  let replica: TestBroker | null = null;
  try {
    // Claimed NATIVELY upstream by a peer this replica never registers --
    // the replica only ever mirrors this card, lock_scope 'remote'.
    const nativeReg = await post<{ instance_token: string; peer_id: string }>(`${upstream.url}/register`, {
      pid: livePid(), cwd: "/tmp/lock-sweep-not-held-native", git_root: null, tty: null,
      summary: "", host: "h-lock-sweep-not-held-native", client_pid: livePid(), claude_cli_pid: 1,
      project_key: PK, group_id: "default", group_secret_hash: null,
    });
    expect(nativeReg.status).toBe(200);
    const held = await post<UpsertRes>(`${upstream.url}/roadmap/upsert`, {
      project_key: PK, by: nativeReg.body.peer_id, instance_token: nativeReg.body.instance_token,
      title: "held elsewhere, this replica only mirrors it", status: "in_progress",
    });
    expect(held.body.item.locked).toBe(true);

    replica = await startBroker({
      CLAUDE_PEERS_BROKER_URL: upstream.url,
      CLAUDE_PEERS_BROKER_TOKEN: AUTH,
      CLAUDE_PEERS_OFFLINE_REPLICA: "1",
      CLAUDE_PEERS_SYNC_TICK_MS: "120",
    });

    const mirrored = await pollUntil(15_000, 150, async () => {
      const item = await itemOn(replica!, held.body.item.id);
      return { done: item?.lock_scope === "remote", value: item };
    });
    expect([
      "mirrored as remote, never as a local hold",
      mirrored!.locked,
      mirrored!.status,
    ]).toEqual(["mirrored as remote, never as a local hold", true, "in_progress"]);

    // Kill the native holder for real -- upstream's own sweep releases it,
    // production's mechanism, not a synthetic column edit.
    const upstreamDb = openBrokerDb(upstream.dbPath);
    upstreamDb.run(
      "UPDATE peers SET status = 'dormant', last_seen = datetime('now', '-1 hour') WHERE instance_token = ?",
      [nativeReg.body.instance_token]
    );
    upstreamDb.close();

    await pollUntil(20_000, 200, async () => {
      const item = await itemOn(upstream, held.body.item.id);
      return { done: item?.updated_by === "lock-sweep" && item.locked === false, value: item };
    });

    const after = await pollUntil(15_000, 200, async () => {
      const item = await itemOn(replica!, held.body.item.id);
      return { done: item !== undefined && item.status === "planned", value: item };
    });
    expect([
      "not held here: the sweep's release is adopted plainly, no protection applies",
      after!.status,
      after!.locked,
    ]).toEqual([
      "not held here: the sweep's release is adopted plainly, no protection applies",
      "planned",
      false,
    ]);
    const replicaDb = openBrokerDb(replica.dbPath);
    const mirrorColumns = replicaDb
      .query("SELECT locked, locked_by, locked_group, locked_by_token, locked_at FROM roadmap_items WHERE id = ?")
      .get(held.body.item.id);
    replicaDb.close();
    expect(["the mirrored release clears every lock column", mirrorColumns]).toEqual([
      "the mirrored release clears every lock column",
      { locked: 0, locked_by: null, locked_group: null, locked_by_token: null, locked_at: null },
    ]);
  } finally {
    if (replica) await stopBroker(replica);
    await stopBroker(upstream);
  }
}, 40_000);

test("a lock whose owner is genuinely gone is still released by the sweep -- the fix never touches this path", async () => {
  // Single broker, no replication at all: applyPulledRow (what the fix
  // touches) never runs here. This is the mechanism the acceptance
  // criterion's second half actually depends on staying intact.
  const b = await startBroker({
    CLAUDE_PEERS_LOCK_TTL_SEC: "3600",
    CLAUDE_PEERS_LOCK_GRACE_SEC: "1",
    CLAUDE_PEERS_ACTIVE_STALE_SEC: "1",
    CLAUDE_PEERS_LOCK_SWEEP_SEC: "1",
  });
  try {
    const ghost = await post<UpsertRes>(`${b.url}/roadmap/upsert`, {
      project_key: PK, by: "ghost-peer", title: "abandoned, no live registration at all",
      status: "in_progress",
    });
    expect(ghost.body.item.locked).toBe(true);

    const after = await pollUntil(15_000, 200, async () => {
      const item = await itemOn(b, ghost.body.item.id);
      return { done: item?.locked === false, value: item };
    });
    expect([
      "a genuinely abandoned lock still releases",
      after!.status,
      after!.locked,
    ]).toEqual(["a genuinely abandoned lock still releases", "planned", false]);
  } finally {
    await stopBroker(b);
  }
}, 20_000);

test("a registered peer that goes dark stays protected through a sweep round-trip, until its own replica's local sweep would catch it", async () => {
  const upstream = await startBroker({
    CLAUDE_PEERS_BROKER_TOKEN: AUTH,
    CLAUDE_PEERS_SERVE_REPLICAS: "1",
    CLAUDE_PEERS_LOCK_TTL_SEC: "3600",
    CLAUDE_PEERS_LOCK_GRACE_SEC: "2",
    CLAUDE_PEERS_ACTIVE_STALE_SEC: "1",
    CLAUDE_PEERS_LOCK_SWEEP_SEC: "1",
  });
  let proxy: ReturnType<typeof Bun.serve> | null = null;
  let replica: TestBroker | null = null;
  try {
    let blocked = false;
    proxy = Bun.serve({
      port: 0,
      async fetch(req) {
        if (blocked) return new Response("upstream unreachable", { status: 503 });
        const url = new URL(req.url);
        const headers: Record<string, string> = { "content-type": "application/json" };
        const auth = req.headers.get("authorization");
        if (auth) headers.authorization = auth;
        return fetch(`${upstream.url}${url.pathname}${url.search}`, {
          method: req.method,
          headers,
          body: req.method === "POST" ? await req.text() : undefined,
        });
      },
    });
    replica = await startBroker({
      CLAUDE_PEERS_BROKER_URL: `http://127.0.0.1:${proxy.port}`,
      CLAUDE_PEERS_BROKER_TOKEN: AUTH,
      CLAUDE_PEERS_OFFLINE_REPLICA: "1",
      CLAUDE_PEERS_SYNC_TICK_MS: "120",
      // Kept far outside this test's budget: only the upstream's sweep (tuned
      // fast above) may bite during it, never this replica's own.
      CLAUDE_PEERS_LOCK_GRACE_SEC: "3600",
      CLAUDE_PEERS_ACTIVE_STALE_SEC: "3600",
    });

    const reg = await post<{ instance_token: string; peer_id: string }>(`${replica.url}/register`, {
      pid: livePid(), cwd: "/tmp/lock-sweep-goes-dark", git_root: null, tty: null,
      summary: "", host: "h-lock-sweep-goes-dark", client_pid: livePid(), claude_cli_pid: 1,
      project_key: PK, group_id: "default", group_secret_hash: null,
    });
    expect(reg.status).toBe(200);

    const held = await post<UpsertRes>(`${replica.url}/roadmap/upsert`, {
      project_key: PK, by: reg.body.peer_id, instance_token: reg.body.instance_token,
      title: "claimed, then its holder goes dark", status: "in_progress",
    });
    expect(held.body.item.locked).toBe(true);

    await pollUntil(15_000, 150, async () => {
      const item = await itemOn(upstream, held.body.item.id);
      return { done: item?.locked === true, value: item };
    });

    // The holder goes dark on the REPLICA's own peers table -- a real death,
    // not just the network partition set up below.
    const db = openBrokerDb(replica.dbPath);
    // Captured now, for the same reason as the first test: the direct
    // witness below needs a BEFORE value to prove the row was actually
    // rewritten, not just left looking the same.
    const heldBaseRevBefore = (
      db.query("SELECT sync_base_rev FROM roadmap_items WHERE id = ?").get(held.body.item.id) as {
        sync_base_rev: number;
      }
    ).sync_base_rev;
    db.run("UPDATE peers SET status = 'dormant', last_seen = datetime('now', '-1 hour') WHERE instance_token = ?", [
      reg.body.instance_token,
    ]);
    db.close();

    blocked = true;
    await pollUntil(15_000, 150, async () => {
      const status = (await post<{ online: boolean }>(`${replica!.url}/roadmap/sync/status`, {})).body;
      return { done: status.online === false, value: status.online };
    });

    await pollUntil(20_000, 200, async () => {
      const item = await itemOn(upstream, held.body.item.id);
      return { done: item?.updated_by === "lock-sweep", value: item };
    });

    blocked = false;
    await pollUntil(15_000, 150, async () => {
      const status = (await post<{ online: boolean }>(`${replica!.url}/roadmap/sync/status`, {})).body;
      return { done: status.online === true, value: status.online };
    });

    // Accepted behaviour: the card stays coherent even though its holder is
    // actually gone. Releasing it faster than the replica's own local sweep
    // (kept out of reach above) is not this fix's job. Gated on
    // sync_base_rev having ADVANCED, same reason as the first test: the
    // field values alone cannot tell "protected" from "nothing happened".
    const dbAfter = openBrokerDb(replica.dbPath);
    const after = await pollUntil(15_000, 200, async () => {
      const item = await itemOn(replica!, held.body.item.id);
      const row = dbAfter
        .query("SELECT sync_base_rev FROM roadmap_items WHERE id = ?")
        .get(held.body.item.id) as { sync_base_rev: number };
      return {
        done:
          item !== undefined &&
          item.sync_state !== "conflict" &&
          row.sync_base_rev > heldBaseRevBefore,
        value: item,
      };
    });
    dbAfter.close();
    expect([
      "protected through the round-trip, pending the replica's own local sweep",
      after!.status,
      after!.locked,
    ]).toEqual([
      "protected through the round-trip, pending the replica's own local sweep",
      "in_progress",
      true,
    ]);
  } finally {
    if (replica) await stopBroker(replica);
    if (proxy) proxy.stop(true);
    await stopBroker(upstream);
  }
}, 60_000);
