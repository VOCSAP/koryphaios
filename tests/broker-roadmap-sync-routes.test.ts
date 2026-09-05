// The upstream half of the replication protocol, exercised against a single
// broker: paging and its cap, the four push outcomes, the lock relay (claim,
// re-assertion, contested annotation, release), the sweep exemption a relayed
// lock lives by, and the two projections that must never carry a credential
// across the boundary.

import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { startBroker, stopBroker, post, livePid, deckAuthored, type TestBroker } from "./_helper.ts";
import type {
  RegisterResponse,
  RoadmapItem,
  RoadmapSyncLockClaimResponse,
  RoadmapSyncLockReleaseResponse,
  RoadmapSyncPullResponse,
  RoadmapSyncPushConflict,
  RoadmapSyncPushItem,
  RoadmapSyncPushResponse,
  RoadmapSyncRow,
  RoadmapSyncStatus,
} from "../shared/types.ts";

const PK = "github.com/vocsap/sync-routes-repo";
const R1 = "replica-one";
const R2 = "replica-two";

type UpsertRes = { item: RoadmapItem };

function pushItem(overrides: Partial<RoadmapSyncPushItem> & { id: string }): RoadmapSyncPushItem {
  return {
    project_key: PK,
    kind: "feature",
    title: "pushed card",
    description: "",
    rationale: "",
    context: "",
    priority: "could",
    value: "medium",
    effort: "medium",
    status: "planned",
    tags: [],
    depends_on: [],
    deleted_at: null,
    directive: null,
    target_peer_ids: [],
    inactive: false,
    created_by: "agent-replica",
    updated_by: "agent-replica",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function pull(b: TestBroker, since_rev: number, limit?: number) {
  return post<RoadmapSyncPullResponse & { error?: string }>(`${b.url}/roadmap/sync/pull`, {
    replica_id: R1,
    since_rev,
    ...(limit === undefined ? {} : { limit }),
  });
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
  throw new Error(`pollUntil timed out after ${budgetMs}ms; last observed: ${JSON.stringify(last)}`);
}

test("pull pages by rev, answers a cursor, and caps the page size at 500", async () => {
  const b = await startBroker();
  try {
    const ids: string[] = [];
    for (const title of ["first", "second", "third"]) {
      const created = await post<UpsertRes>(`${b.url}/roadmap/upsert`, {
        project_key: PK,
        by: "agent-pull",
        title,
      });
      ids.push(created.body.item.id);
    }

    const page = await pull(b, 0, 2);
    expect(page.status).toBe(200);
    expect(page.body.items.map((i) => i.id)).toEqual([ids[0]!, ids[1]!]);
    expect(page.body.next_rev).toBe(page.body.items[1]!.rev);

    const rest = await pull(b, page.body.next_rev);
    expect(rest.body.items.map((i) => i.id)).toEqual([ids[2]!]);

    const drained = await pull(b, rest.body.next_rev);
    expect([
      "an empty page leaves the cursor where it was",
      drained.body.items.length,
      drained.body.next_rev,
    ]).toEqual(["an empty page leaves the cursor where it was", 0, rest.body.next_rev]);

    // 520 rows written straight into the table so the cap is measured, not
    // assumed: the triggers stamp them exactly as a route write would.
    const db = new Database(b.dbPath);
    db.run("PRAGMA busy_timeout = 3000");
    const insert = db.prepare(
      "INSERT INTO roadmap_items (id, project_key, kind, title, created_at, updated_at) VALUES (?, ?, 'feature', ?, datetime('now'), datetime('now'))"
    );
    const bulk = db.transaction(() => {
      for (let i = 0; i < 520; i++) insert.run(`bulk-${i}`, PK, `bulk card ${i}`);
    });
    bulk();
    db.close();

    const capped = await pull(b, 0, 10_000);
    expect([
      "a caller asking for more than the cap gets one capped page, not the whole table",
      capped.body.items.length,
    ]).toEqual([
      "a caller asking for more than the cap gets one capped page, not the whole table",
      500,
    ]);
    const defaulted = await pull(b, 0);
    expect(defaulted.body.items.length).toBe(500);
  } finally {
    await stopBroker(b);
  }
}, 30_000);

test("pull refuses a malformed cursor, page size or replica_id instead of clamping it", async () => {
  const b = await startBroker();
  try {
    for (const body of [
      { replica_id: R1, since_rev: Number.NaN },
      { replica_id: R1, since_rev: 1.5 },
      { replica_id: R1, since_rev: -1 },
      { replica_id: R1, since_rev: "0" },
      { replica_id: R1, since_rev: 0, limit: Number.NaN },
      { replica_id: R1, since_rev: 0, limit: 0 },
      { replica_id: "no", since_rev: 0 },
      { replica_id: "has@sign-in-it", since_rev: 0 },
    ]) {
      const res = await post<{ error?: string }>(`${b.url}/roadmap/sync/pull`, body);
      expect([JSON.stringify(body), res.status]).toEqual([JSON.stringify(body), 400]);
    }
  } finally {
    await stopBroker(b);
  }
}, 20_000);

test("a pulled row never carries locked_by_token or operator_id, which the stored row does carry", async () => {
  const b = await startBroker();
  try {
    const reg = await post<RegisterResponse>(`${b.url}/register`, {
      pid: livePid(),
      cwd: "/work/sync-projection",
      git_root: null,
      tty: null,
      summary: "",
      host: "sync-host",
      client_pid: livePid(),
      project_key: PK,
      group_id: "default",
      group_secret_hash: null,
    });
    const created = await post<UpsertRes>(`${b.url}/roadmap/upsert`, {
      project_key: PK,
      by: reg.body.peer_id,
      instance_token: reg.body.instance_token,
      title: "locked and signed",
      status: "in_progress",
    });
    const id = created.body.item.id;
    const signed = await post<UpsertRes>(
      `${b.url}/roadmap/upsert`,
      deckAuthored({ project_key: PK, id, description: "operator signed this" })
    );
    expect(signed.status).toBe(200);

    // The guarantee is only worth asserting if the columns are actually
    // populated: read them back before checking they do not travel.
    const db = new Database(b.dbPath);
    const stored = db
      .query("SELECT locked_by_token, operator_id FROM roadmap_items WHERE id = ?")
      .get(id) as { locked_by_token: string | null; operator_id: string | null };
    db.close();
    expect(stored.locked_by_token).not.toBeNull();
    expect(stored.operator_id).not.toBeNull();

    const page = await pull(b, 0);
    const row = page.body.items.find((i) => i.id === id)! as RoadmapSyncRow & Record<string, unknown>;
    expect([
      "a replica never receives the lock owner's instance_token",
      "locked_by_token" in row,
    ]).toEqual(["a replica never receives the lock owner's instance_token", false]);
    expect([
      "a replica never receives the operator signature of an upstream write",
      "operator_id" in row,
    ]).toEqual(["a replica never receives the operator signature of an upstream write", false]);
    // The rest of the lock state does travel: the point is the credential, not the lock.
    expect(row.locked).toBe(true);
    expect(row.locked_by).toBe(reg.body.peer_id);
  } finally {
    await stopBroker(b);
  }
}, 20_000);

test("push: fast-forward accepted, stale base refused, unknown base refused, insert only with a null base", async () => {
  const b = await startBroker();
  try {
    // Insert: no base claimed, id unknown upstream.
    const inserted = await post<RoadmapSyncPushResponse>(`${b.url}/roadmap/sync/push`, {
      replica_id: R1,
      item: pushItem({ id: "card-insert", title: "born on the replica" }),
      expected_content_rev: null,
    });
    expect(inserted.status).toBe(200);
    expect(inserted.body.item.title).toBe("born on the replica");
    expect([
      "a pushed card keeps the replica's attribution and reaches the upstream unqueued",
      inserted.body.item.created_by,
      inserted.body.item.queue,
    ]).toEqual([
      "a pushed card keeps the replica's attribution and reaches the upstream unqueued",
      "agent-replica",
      null,
    ]);
    const baseRev = inserted.body.content_rev;

    // Fast-forward: the base matches what the upstream holds.
    const forwarded = await post<RoadmapSyncPushResponse>(`${b.url}/roadmap/sync/push`, {
      replica_id: R1,
      item: pushItem({ id: "card-insert", description: "second version" }),
      expected_content_rev: baseRev,
    });
    expect(forwarded.status).toBe(200);
    expect(forwarded.body.item.description).toBe("second version");
    expect(forwarded.body.content_rev).toBeGreaterThan(baseRev);

    // Stale base: the upstream moved since.
    const stale = await post<RoadmapSyncPushConflict>(`${b.url}/roadmap/sync/push`, {
      replica_id: R1,
      item: pushItem({ id: "card-insert", description: "third version" }),
      expected_content_rev: baseRev,
    });
    expect([stale.status, stale.body.error]).toEqual([409, "conflict"]);
    expect(stale.body.item?.description).toBe("second version");

    // A null base on an id the upstream already has is a divergence too.
    const collision = await post<RoadmapSyncPushConflict>(`${b.url}/roadmap/sync/push`, {
      replica_id: R1,
      item: pushItem({ id: "card-insert", description: "offline creation" }),
      expected_content_rev: null,
    });
    expect([collision.status, collision.body.item?.id]).toEqual([409, "card-insert"]);

    // A base claimed for a row the upstream does not have: nothing to
    // fast-forward from, and the empty item says so.
    const orphan = await post<RoadmapSyncPushConflict>(`${b.url}/roadmap/sync/push`, {
      replica_id: R1,
      item: pushItem({ id: "card-gone" }),
      expected_content_rev: 7,
    });
    expect([
      "a base for a row the upstream lost is refused with an empty item",
      orphan.status,
      orphan.body.item,
    ]).toEqual(["a base for a row the upstream lost is refused with an empty item", 409, null]);
  } finally {
    await stopBroker(b);
  }
}, 20_000);

test("push never writes the queue, the lock columns or operator_id", async () => {
  const b = await startBroker();
  try {
    const reg = await post<RegisterResponse>(`${b.url}/register`, {
      pid: livePid(),
      cwd: "/work/sync-push-guard",
      git_root: null,
      tty: null,
      summary: "",
      host: "sync-host",
      client_pid: livePid(),
      project_key: PK,
      group_id: "default",
      group_secret_hash: null,
    });
    const native = await post<UpsertRes>(`${b.url}/roadmap/upsert`, {
      project_key: PK,
      by: reg.body.peer_id,
      instance_token: reg.body.instance_token,
      title: "held upstream",
      status: "in_progress",
      queue: 3,
    });
    const id = native.body.item.id;
    const before = await pull(b, 0);
    const beforeRow = before.body.items.find((i) => i.id === id)!;

    const pushed = await post<RoadmapSyncPushResponse>(`${b.url}/roadmap/sync/push`, {
      replica_id: R1,
      item: pushItem({ id, title: "edited on the replica", queue: 99 } as Partial<RoadmapSyncPushItem> & { id: string }),
      expected_content_rev: beforeRow.content_rev,
    });
    expect(pushed.status).toBe(200);
    expect(pushed.body.item.title).toBe("edited on the replica");

    const db = new Database(b.dbPath);
    const stored = db
      .query("SELECT queue, locked, locked_by, locked_by_token, operator_id FROM roadmap_items WHERE id = ?")
      .get(id) as {
      queue: number | null;
      locked: number;
      locked_by: string | null;
      locked_by_token: string | null;
      operator_id: string | null;
    };
    db.close();
    expect([
      "a push carries content only: the queue and the lock stay as the upstream had them",
      stored.queue,
      stored.locked,
      stored.locked_by,
    ]).toEqual([
      "a push carries content only: the queue and the lock stay as the upstream had them",
      3,
      1,
      reg.body.peer_id,
    ]);
    expect(stored.locked_by_token).not.toBeNull();
  } finally {
    await stopBroker(b);
  }
}, 20_000);

test("push refuses an unchecked enum, an unparsable timestamp or an author outside the identity charset", async () => {
  const b = await startBroker();
  try {
    for (const item of [
      pushItem({ id: "card-bad-1", status: "wat" as never }),
      pushItem({ id: "card-bad-2", updated_at: "not a date" }),
      pushItem({ id: "card-bad-3", created_by: "Agent Smith" }),
      pushItem({ id: "card-bad-4", created_by: "" }),
      pushItem({ id: "card-bad-5", title: "   " }),
      pushItem({ id: "card-bad-6", project_key: "" }),
      pushItem({ id: "card-bad-7", kind: "directive" }),
    ]) {
      const res = await post<{ error?: string }>(`${b.url}/roadmap/sync/push`, {
        replica_id: R1,
        item,
        expected_content_rev: null,
      });
      expect([item.id, res.status]).toEqual([item.id, 400]);
    }
    // JSON has no NaN (it serializes to null, a legitimate "no base"), so the
    // wire-reachable malformed bases are the float and the string; the
    // integer check refuses NaN too, for any in-process caller.
    for (const expected_content_rev of [1.5, "3", -1]) {
      const badRev = await post<{ error?: string }>(`${b.url}/roadmap/sync/push`, {
        replica_id: R1,
        item: pushItem({ id: "card-bad-rev" }),
        expected_content_rev,
      });
      expect([String(expected_content_rev), badRev.status]).toEqual([
        String(expected_content_rev),
        400,
      ]);
    }
  } finally {
    await stopBroker(b);
  }
}, 20_000);

test("a replicated write carries content and never locks; a relayed claim still obeys the inactive rule", async () => {
  const b = await startBroker();
  try {
    const created = await post<UpsertRes>(`${b.url}/roadmap/upsert`, {
      project_key: PK,
      by: "agent-seed",
      title: "set aside by the operator",
    });
    const id = created.body.item.id;
    const setAside = await post<UpsertRes>(
      `${b.url}/roadmap/upsert`,
      deckAuthored({ project_key: PK, id, inactive: true })
    );
    expect(setAside.body.item.inactive).toBe(true);

    const before = await pull(b, 0);
    const row = before.body.items.find((i) => i.id === id)!;
    const pushed = await post<RoadmapSyncPushResponse>(`${b.url}/roadmap/sync/push`, {
      replica_id: R1,
      item: pushItem({ id, status: "in_progress", inactive: true, title: row.title }),
      expected_content_rev: row.content_rev,
    });
    // This is why the replication write handlers are exempt from the
    // inactive-claim guard: they cannot claim anything. The status travels,
    // the lock does not.
    expect([
      "a replicated content write never locks the card",
      pushed.status,
      pushed.body.item.status,
      pushed.body.item.locked,
    ]).toEqual(["a replicated content write never locks the card", 200, "in_progress", false]);

    const claim = await post<{ error?: string }>(`${b.url}/roadmap/sync/lock`, {
      replica_id: R1,
      id,
      action: "claim",
      owner: { peer_id: "agent-a", group_id: "default" },
    });
    expect([
      "a relayed claim on a card the operator set aside is refused like a local one",
      claim.status,
    ]).toEqual(["a relayed claim on a card the operator set aside is refused like a local one", 409]);
  } finally {
    await stopBroker(b);
  }
}, 20_000);

test("lock relay: claim, re-assert, contested annotation, and who may release", async () => {
  const b = await startBroker();
  try {
    const created = await post<UpsertRes>(`${b.url}/roadmap/upsert`, {
      project_key: PK,
      by: "agent-seed",
      title: "relayed lock",
    });
    const id = created.body.item.id;

    const claim = await post<RoadmapSyncLockClaimResponse>(`${b.url}/roadmap/sync/lock`, {
      replica_id: R1,
      id,
      action: "claim",
      owner: { peer_id: "agent-a", group_id: "default" },
    });
    expect([claim.status, claim.body.scope]).toEqual([200, "global"]);
    expect(claim.body.item.locked).toBe(true);
    expect(claim.body.item.locked_by).toBe("agent-a");

    const db = new Database(b.dbPath);
    const relayRow = db
      .query("SELECT lock_relay, lock_relay_seen, locked_by_token FROM roadmap_items WHERE id = ?")
      .get(id) as { lock_relay: string; lock_relay_seen: string; locked_by_token: string | null };
    expect([
      "the relaying replica is recorded and the agent's own token never is",
      relayRow.lock_relay,
      relayRow.locked_by_token,
    ]).toEqual(["the relaying replica is recorded and the agent's own token never is", R1, null]);

    // A second replica wanting the same card is refused and annotated.
    const contested = await post<RoadmapSyncLockClaimResponse>(`${b.url}/roadmap/sync/lock`, {
      replica_id: R2,
      id,
      action: "claim",
      owner: { peer_id: "agent-b", group_id: "default" },
    });
    expect([contested.status, contested.body.scope]).toEqual([409, "contested"]);
    expect(contested.body.item.lock_contested_by).toEqual([`agent-b@${R2}`]);
    expect(contested.body.item.locked_by).toBe("agent-a");

    // Re-asserting the same lock is a heartbeat: it stays global, drops no
    // annotation of anybody else, and does not re-publish the row.
    const beforeReassert = db.query("SELECT rev FROM roadmap_items WHERE id = ?").get(id) as {
      rev: number;
    };
    const reassert = await post<RoadmapSyncLockClaimResponse>(`${b.url}/roadmap/sync/lock`, {
      replica_id: R1,
      id,
      action: "claim",
      owner: { peer_id: "agent-a", group_id: "default" },
    });
    expect([reassert.status, reassert.body.scope]).toEqual([200, "global"]);
    const afterReassert = db.query("SELECT rev FROM roadmap_items WHERE id = ?").get(id) as {
      rev: number;
    };
    expect([
      "a heartbeat re-assertion does not bump the row's revision",
      afterReassert.rev,
    ]).toEqual(["a heartbeat re-assertion does not bump the row's revision", beforeReassert.rev]);

    // A release from anyone but the holder withdraws only its own annotation.
    const foreignRelease = await post<RoadmapSyncLockReleaseResponse>(`${b.url}/roadmap/sync/lock`, {
      replica_id: R2,
      id,
      action: "release",
      owner: { peer_id: "agent-b", group_id: "default" },
    });
    expect([
      "a non-holder releases nothing but its own contested claim",
      foreignRelease.status,
      foreignRelease.body.released,
      foreignRelease.body.item?.locked,
      foreignRelease.body.item?.lock_contested_by,
    ]).toEqual([
      "a non-holder releases nothing but its own contested claim",
      200,
      false,
      true,
      [],
    ]);

    const release = await post<RoadmapSyncLockReleaseResponse>(`${b.url}/roadmap/sync/lock`, {
      replica_id: R1,
      id,
      action: "release",
      owner: { peer_id: "agent-a", group_id: "default" },
    });
    expect([release.status, release.body.released]).toEqual([200, true]);
    expect(release.body.item?.locked).toBe(false);
    const cleared = db
      .query("SELECT lock_relay, lock_relay_seen FROM roadmap_items WHERE id = ?")
      .get(id) as { lock_relay: string | null; lock_relay_seen: string | null };
    expect([cleared.lock_relay, cleared.lock_relay_seen]).toEqual([null, null]);
    db.close();

    // The card must exist to be claimed; a release for a card the upstream
    // never had is a no-op the replica can retire.
    const unknownClaim = await post<{ error?: string }>(`${b.url}/roadmap/sync/lock`, {
      replica_id: R1,
      id: "no-such-card",
      action: "claim",
      owner: { peer_id: "agent-a", group_id: null },
    });
    expect(unknownClaim.status).toBe(404);
    const unknownRelease = await post<RoadmapSyncLockReleaseResponse>(`${b.url}/roadmap/sync/lock`, {
      replica_id: R1,
      id: "no-such-card",
      action: "release",
      owner: { peer_id: "agent-a", group_id: null },
    });
    expect([unknownRelease.status, unknownRelease.body.released, unknownRelease.body.item]).toEqual([
      200,
      false,
      null,
    ]);
  } finally {
    await stopBroker(b);
  }
}, 20_000);

test("a relayed lock survives the owner-gone sweep while its relay is fresh, and falls once it goes quiet", async () => {
  // No peers row upstream carries 'agent-remote' -- that is the whole point:
  // the agent is registered on the replica, so without the relay exemption
  // the owner-gone clause would release this lock on its first pass.
  const b = await startBroker({
    CLAUDE_PEERS_LOCK_TTL_SEC: "3600",
    CLAUDE_PEERS_LOCK_GRACE_SEC: "30",
    CLAUDE_PEERS_LOCK_SWEEP_SEC: "1",
  });
  try {
    const created = await post<UpsertRes>(`${b.url}/roadmap/upsert`, {
      project_key: PK,
      by: "agent-seed",
      title: "relayed through the sweep",
    });
    const id = created.body.item.id;
    const claim = await post<RoadmapSyncLockClaimResponse>(`${b.url}/roadmap/sync/lock`, {
      replica_id: R1,
      id,
      action: "claim",
      owner: { peer_id: "agent-remote", group_id: "default" },
    });
    expect(claim.status).toBe(200);

    // Several sweep passes with a fresh heartbeat: the lock must hold.
    await Bun.sleep(2_500);
    const held = await pull(b, 0);
    expect([
      "a lock relayed by a live replica survives the owner-gone sweep",
      held.body.items.find((i) => i.id === id)!.locked,
    ]).toEqual(["a lock relayed by a live replica survives the owner-gone sweep", true]);

    // The replica goes quiet: the relay ages past the grace window exactly
    // like an owner's own silence would.
    const db = new Database(b.dbPath);
    db.run("PRAGMA busy_timeout = 3000");
    db.run("UPDATE roadmap_items SET lock_relay_seen = datetime('now', '-120 seconds') WHERE id = ?", [id]);
    db.close();

    const swept = await pollUntil(12_000, 300, async () => {
      const page = await pull(b, 0);
      const row = page.body.items.find((i) => i.id === id)!;
      return { done: !row.locked, value: row };
    });
    expect(swept.updated_by).toBe("lock-sweep");
  } finally {
    await stopBroker(b);
  }
}, 30_000);

test("a replica broker refuses to serve the upstream sync routes, and answers status in every mode", async () => {
  const upstream = await startBroker();
  const replica = await startBroker({
    CLAUDE_PEERS_BROKER_URL: "http://127.0.0.1:9",
    CLAUDE_PEERS_OFFLINE_REPLICA: "1",
    CLAUDE_PEERS_SYNC_TICK_MS: "60000",
  });
  try {
    for (const [route, body] of [
      ["/roadmap/sync/pull", { replica_id: R1, since_rev: 0 }],
      ["/roadmap/sync/push", { replica_id: R1, item: pushItem({ id: "x" }), expected_content_rev: null }],
      [
        "/roadmap/sync/lock",
        { replica_id: R1, id: "x", action: "claim", owner: { peer_id: "agent-a", group_id: null } },
      ],
    ] as const) {
      const res = await post<{ error?: string }>(`${replica.url}${route}`, body);
      expect([route, res.status]).toEqual([route, 403]);
    }

    const local = await post<RoadmapSyncStatus>(`${upstream.url}/roadmap/sync/status`, {});
    expect(local.body.mode).toBe("local");
    const replicaStatus = await post<RoadmapSyncStatus>(`${replica.url}/roadmap/sync/status`, {});
    expect([
      "a replica reports its upstream, its cursor and its backlog",
      replicaStatus.body.mode,
      replicaStatus.body.upstream_url,
      replicaStatus.body.conflicts,
      replicaStatus.body.pending_push,
    ]).toEqual([
      "a replica reports its upstream, its cursor and its backlog",
      "replica",
      "http://127.0.0.1:9",
      0,
      0,
    ]);

    // The two replica-only routes refuse elsewhere, with the state-conflict
    // status that keeps them apart from the 403 above.
    const conflicts = await post<{ error?: string }>(`${upstream.url}/roadmap/sync/conflicts`, {
      project_key: PK,
    });
    expect(conflicts.status).toBe(409);
    const resolve = await post<{ error?: string }>(
      `${upstream.url}/roadmap/sync/resolve`,
      deckAuthored({ id: "x", choice: "local" })
    );
    expect(resolve.status).toBe(409);

    const health = await fetch(`${replica.url}/health`);
    const healthBody = (await health.json()) as { mode: string; upstream_online: boolean };
    expect([healthBody.mode, healthBody.upstream_online]).toEqual(["replica", false]);
    const upstreamHealth = (await (await fetch(`${upstream.url}/health`)).json()) as {
      mode: string;
      upstream_online?: boolean;
    };
    expect([upstreamHealth.mode, "upstream_online" in upstreamHealth]).toEqual(["local", false]);
  } finally {
    await stopBroker(replica);
    await stopBroker(upstream);
  }
}, 30_000);

test("resolve requires the same author proof as any other Deck roadmap write", async () => {
  const replica = await startBroker({
    CLAUDE_PEERS_BROKER_URL: "http://127.0.0.1:9",
    CLAUDE_PEERS_OFFLINE_REPLICA: "1",
    CLAUDE_PEERS_SYNC_TICK_MS: "60000",
  });
  try {
    const unsigned = await post<{ error?: string }>(`${replica.url}/roadmap/sync/resolve`, {
      id: "whatever",
      choice: "local",
      by: "deck",
    });
    expect([
      "an unsigned write claiming the operator identity is refused before anything else",
      unsigned.status,
    ]).toEqual(["an unsigned write claiming the operator identity is refused before anything else", 401]);

    const signedUnknown = await post<{ error?: string }>(
      `${replica.url}/roadmap/sync/resolve`,
      deckAuthored({ id: "whatever", choice: "local" })
    );
    expect(signedUnknown.status).toBe(404);

    const badChoice = await post<{ error?: string }>(
      `${replica.url}/roadmap/sync/resolve`,
      deckAuthored({ id: "whatever", choice: "take-mine" })
    );
    expect(badChoice.status).toBe(400);
  } finally {
    await stopBroker(replica);
  }
}, 20_000);
