// The upstream half of the replication protocol, exercised against a single
// broker: paging and its cap, the four push outcomes, the lock relay (claim,
// re-assertion, contested annotation, release), the sweep exemption a relayed
// lock lives by, and the two projections that must never carry a credential
// across the boundary.

import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import {
  startBroker as startPlainBroker,
  stopBroker,
  livePid,
  deckAuthored,
  FIXTURE_OPERATOR_ID,
  type TestBroker,
} from "./_helper.ts";
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
/**
 * An upstream in this file is two opt-ins, not one: `serve_replicas` for the
 * ROLE and a broker_token to authenticate the replicas that take it up. Every
 * upstream here runs with both and every request carries the Bearer;
 * `startPlainBroker` is used raw only where the absence of one of the two IS
 * the subject.
 */
const TOKEN = "sync-routes-token";

function startBroker(env: Record<string, string> = {}): Promise<TestBroker> {
  return startPlainBroker({
    CLAUDE_PEERS_BROKER_TOKEN: TOKEN,
    CLAUDE_PEERS_SERVE_REPLICAS: "1",
    ...env,
  });
}

async function post<T = unknown>(url: string, body: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T };
}

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
    expect([
      "a stale base is a CONTENT divergence, and the body says so",
      stale.status,
      stale.body.error,
      stale.body.reason,
    ]).toEqual(["a stale base is a CONTENT divergence, and the body says so", 409, "conflict", "content"]);
    expect(stale.body.item?.description).toBe("second version");

    // A null base on an id the upstream already has is a divergence too.
    const collision = await post<RoadmapSyncPushConflict>(`${b.url}/roadmap/sync/push`, {
      replica_id: R1,
      item: pushItem({ id: "card-insert", description: "offline creation" }),
      expected_content_rev: null,
    });
    expect([collision.status, collision.body.item?.id, collision.body.reason]).toEqual([
      409,
      "card-insert",
      "content",
    ]);

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
      orphan.body.reason,
    ]).toEqual([
      "a base for a row the upstream lost is refused with an empty item",
      409,
      null,
      "missing",
    ]);
  } finally {
    await stopBroker(b);
  }
}, 20_000);

test("push is refused on a card the upstream work-locks for a holder this replica does not relay", async () => {
  const b = await startBroker();
  try {
    const reg = await post<RegisterResponse>(`${b.url}/register`, {
      pid: livePid(),
      cwd: "/work/sync-push-lock",
      git_root: null,
      tty: null,
      summary: "",
      host: "sync-host",
      client_pid: livePid(),
      project_key: PK,
      group_id: "default",
      group_secret_hash: null,
    });
    const held = await post<UpsertRes>(`${b.url}/roadmap/upsert`, {
      project_key: PK,
      by: reg.body.peer_id,
      instance_token: reg.body.instance_token,
      title: "held by a native peer",
      status: "in_progress",
    });
    const heldRow = (await pull(b, 0)).body.items.find((i) => i.id === held.body.item.id)!;

    // The base is exactly what the upstream holds, so the ONLY thing refusing
    // this push is the work-lock -- the same answer a direct upsert gets.
    const refused = await post<RoadmapSyncPushConflict>(`${b.url}/roadmap/sync/push`, {
      replica_id: R1,
      item: pushItem({ id: held.body.item.id, title: "edited on the replica" }),
      expected_content_rev: heldRow.content_rev,
    });
    expect([
      "a card locked upstream by someone else refuses a replicated write, naming why",
      refused.status,
      refused.body.error,
      refused.body.reason,
      refused.body.item?.title,
    ]).toEqual([
      "a card locked upstream by someone else refuses a replicated write, naming why",
      409,
      "conflict",
      "locked_upstream",
      "held by a native peer",
    ]);
    const afterRefusal = (await pull(b, 0)).body.items.find((i) => i.id === held.body.item.id)!;
    const db = new Database(b.dbPath);
    const heldToken = (
      db.query("SELECT locked_by_token FROM roadmap_items WHERE id = ?").get(held.body.item.id) as {
        locked_by_token: string | null;
      }
    ).locked_by_token;
    db.close();
    expect([
      "a refused push writes nothing at all, the holder's own credential included",
      afterRefusal.title,
      afterRefusal.content_rev,
      heldToken !== null,
    ]).toEqual([
      "a refused push writes nothing at all, the holder's own credential included",
      "held by a native peer",
      heldRow.content_rev,
      true,
    ]);

    // The lock THIS replica relays is not somebody else's: its own agent's
    // edits keep flowing while it holds the card.
    const relayed = await post<UpsertRes>(`${b.url}/roadmap/upsert`, {
      project_key: PK,
      by: "agent-seed",
      title: "relayed by this replica",
    });
    const claim = await post<RoadmapSyncLockClaimResponse>(`${b.url}/roadmap/sync/lock`, {
      replica_id: R1,
      id: relayed.body.item.id,
      action: "claim",
      owner: { peer_id: "agent-remote", group_id: "default" },
    });
    expect(claim.status).toBe(200);
    const relayedPush = await post<RoadmapSyncPushResponse>(`${b.url}/roadmap/sync/push`, {
      replica_id: R1,
      item: pushItem({ id: relayed.body.item.id, title: "edited behind our own lock" }),
      expected_content_rev: claim.body.item.content_rev,
    });
    expect([
      "the holder this replica relays is the replica itself: its push goes through",
      relayedPush.status,
      relayedPush.body.item?.title,
    ]).toEqual([
      "the holder this replica relays is the replica itself: its push goes through",
      200,
      "edited behind our own lock",
    ]);

    // ...and another replica's push on that same relayed lock is refused.
    const otherReplica = await post<RoadmapSyncPushConflict>(`${b.url}/roadmap/sync/push`, {
      replica_id: R2,
      item: pushItem({ id: relayed.body.item.id, title: "edited from elsewhere" }),
      expected_content_rev: relayedPush.body.content_rev,
    });
    expect([
      "a relay belongs to ONE replica: another one is refused like any third party",
      otherReplica.status,
      otherReplica.body.reason,
    ]).toEqual([
      "a relay belongs to ONE replica: another one is refused like any third party",
      409,
      "locked_upstream",
    ]);
  } finally {
    await stopBroker(b);
  }
}, 30_000);

test("push never writes the queue, the lock columns or operator_id", async () => {
  const b = await startBroker();
  try {
    // Signed by the operator so the row carries an operator_id, and queued so
    // the row carries a position: the two columns a push must leave alone.
    // Its lock is the one this replica relays, the only kind a push may land
    // behind at all.
    const signed = await post<UpsertRes>(
      `${b.url}/roadmap/upsert`,
      deckAuthored({ project_key: PK, title: "queued and signed upstream", queue: 3 })
    );
    expect(signed.status).toBe(200);
    const id = signed.body.item.id;
    const claim = await post<RoadmapSyncLockClaimResponse>(`${b.url}/roadmap/sync/lock`, {
      replica_id: R1,
      id,
      action: "claim",
      owner: { peer_id: "agent-remote", group_id: "default" },
    });
    expect(claim.status).toBe(200);

    const pushed = await post<RoadmapSyncPushResponse>(`${b.url}/roadmap/sync/push`, {
      replica_id: R1,
      item: pushItem({ id, title: "edited on the replica", queue: 99 } as Partial<RoadmapSyncPushItem> & { id: string }),
      expected_content_rev: claim.body.item.content_rev,
    });
    expect(pushed.status).toBe(200);
    expect(pushed.body.item.title).toBe("edited on the replica");

    const db = new Database(b.dbPath);
    const stored = db
      .query(
        "SELECT queue, locked, locked_by, locked_by_token, lock_relay, operator_id FROM roadmap_items WHERE id = ?"
      )
      .get(id) as {
      queue: number | null;
      locked: number;
      locked_by: string | null;
      locked_by_token: string | null;
      lock_relay: string | null;
      operator_id: string | null;
    };
    db.close();
    expect([
      "a push carries content only: the queue, the lock and the operator proof stay as the upstream had them",
      stored.queue,
      stored.locked,
      stored.locked_by,
      stored.lock_relay,
      stored.locked_by_token,
      stored.operator_id,
    ]).toEqual([
      "a push carries content only: the queue, the lock and the operator proof stay as the upstream had them",
      3,
      1,
      "agent-remote",
      R1,
      null,
      FIXTURE_OPERATOR_ID,
    ]);
  } finally {
    await stopBroker(b);
  }
}, 20_000);

test("push never stores an author this upstream reads as one of its own: it stamps the relay instead", async () => {
  const b = await startBroker();
  try {
    const reg = await post<RegisterResponse>(`${b.url}/register`, {
      pid: livePid(),
      cwd: "/work/sync-author",
      git_root: null,
      tty: null,
      summary: "",
      host: "sync-host",
      client_pid: livePid(),
      project_key: PK,
      group_id: "default",
      group_secret_hash: null,
    });
    const relay = `via:${R1.slice(0, 8)}:`;

    // 'deck' names the OPERATOR of the broker reading it, and an upsert claiming
    // it must be signed. Relayed, it names the operator of the OTHER machine.
    const reserved = await post<RoadmapSyncPushResponse>(`${b.url}/roadmap/sync/push`, {
      replica_id: R1,
      item: pushItem({ id: "card-author-deck", created_by: "deck", updated_by: "deck" }),
      expected_content_rev: null,
    });
    expect([
      "a reserved identity crossing the boundary is prefixed with the replica that relayed it",
      reserved.status,
      reserved.body.item?.created_by,
      reserved.body.item?.updated_by,
    ]).toEqual([
      "a reserved identity crossing the boundary is prefixed with the replica that relayed it",
      200,
      `${relay}deck`,
      `${relay}deck`,
    ]);

    // A name that belongs to a peer registered HERE: kept as-is it would credit
    // this upstream's own agent for a write it never made.
    const homonym = await post<RoadmapSyncPushResponse>(`${b.url}/roadmap/sync/push`, {
      replica_id: R1,
      item: pushItem({
        id: "card-author-homonym",
        created_by: reg.body.peer_id,
        updated_by: reg.body.peer_id,
      }),
      expected_content_rev: null,
    });
    expect([
      "a name this upstream already knows as a peer is prefixed too",
      homonym.status,
      homonym.body.item?.updated_by,
    ]).toEqual([
      "a name this upstream already knows as a peer is prefixed too",
      200,
      `${relay}${reg.body.peer_id}`,
    ]);

    // A plain name nobody here answers to means exactly what it says.
    const plain = await post<RoadmapSyncPushResponse>(`${b.url}/roadmap/sync/push`, {
      replica_id: R1,
      item: pushItem({ id: "card-author-plain", created_by: "agent-elsewhere", updated_by: "agent-elsewhere" }),
      expected_content_rev: null,
    });
    expect([
      "an author unknown here is carried verbatim: the relay adds provenance, it does not rename",
      plain.status,
      plain.body.item?.created_by,
      plain.body.item?.updated_by,
    ]).toEqual([
      "an author unknown here is carried verbatim: the relay adds provenance, it does not rename",
      200,
      "agent-elsewhere",
      "agent-elsewhere",
    ]);
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

    const claim = await post<{ error?: string; scope?: string }>(`${b.url}/roadmap/sync/lock`, {
      replica_id: R1,
      id,
      action: "claim",
      owner: { peer_id: "agent-a", group_id: "default" },
    });
    // Same status as a contested claim, and a body that says which of the two
    // it is: 'contested' means another holder has the card and the replica must
    // say so on its own cards; 'inactive' means nobody holds it at all.
    expect([
      "a relayed claim on a card the operator set aside is refused, and names the reason",
      claim.status,
      claim.body.error,
      claim.body.scope,
    ]).toEqual([
      "a relayed claim on a card the operator set aside is refused, and names the reason",
      409,
      "inactive",
      undefined,
    ]);
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

test("the three replication routes are refused outright on a broker with no configured token", async () => {
  // Without a broker_token every route is unauthenticated, and /roadmap/sync/push
  // writes content on any card under any author while walking past the work-lock
  // guard. The routes exist only where a credential gates them.
  // serve_replicas ON and no token: the role is granted, so the refusal this
  // probe reads back is the CREDENTIAL one and not the role one that precedes it.
  const open = await startPlainBroker({ CLAUDE_PEERS_SERVE_REPLICAS: "1" });
  const closed = await startBroker();
  try {
    const seeded = await post<UpsertRes>(`${closed.url}/roadmap/upsert`, {
      project_key: PK,
      by: "agent-seed",
      title: "reachable with the bearer",
    });
    expect(seeded.status).toBe(200);

    for (const [route, body] of [
      ["/roadmap/sync/pull", { replica_id: R1, since_rev: 0 }],
      [
        "/roadmap/sync/push",
        { replica_id: R1, item: pushItem({ id: "card-tokenless" }), expected_content_rev: null },
      ],
      [
        "/roadmap/sync/lock",
        { replica_id: R1, id: seeded.body.item.id, action: "claim", owner: { peer_id: "agent-remote", group_id: null } },
      ],
    ] as const) {
      const res = await fetch(`${open.url}${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const parsed = (await res.json()) as { error?: string };
      expect([route, res.status]).toEqual([route, 403]);
      expect([route, (parsed.error ?? "").includes("broker_token")]).toEqual([route, true]);
    }

    // The same three calls, on a broker that HAS a token, with the Bearer.
    const pulled = await pull(closed, 0);
    expect(["pull answers a token-bearing replica", pulled.status]).toEqual([
      "pull answers a token-bearing replica",
      200,
    ]);
    const pushed = await post<RoadmapSyncPushResponse>(`${closed.url}/roadmap/sync/push`, {
      replica_id: R1,
      item: pushItem({ id: "card-with-token", title: "pushed with a bearer" }),
      expected_content_rev: null,
    });
    expect(["push answers a token-bearing replica", pushed.status]).toEqual([
      "push answers a token-bearing replica",
      200,
    ]);
    const claimed = await post<RoadmapSyncLockClaimResponse>(`${closed.url}/roadmap/sync/lock`, {
      replica_id: R1,
      id: seeded.body.item.id,
      action: "claim",
      owner: { peer_id: "agent-remote", group_id: null },
    });
    expect(["lock answers a token-bearing replica", claimed.status]).toEqual([
      "lock answers a token-bearing replica",
      200,
    ]);
  } finally {
    await stopBroker(closed);
    await stopBroker(open);
  }
}, 30_000);

test("releasing a natively-held card drops the contest annotation, relayed or not", async () => {
  // Contestation is defined against a HOLDER: once the lock is gone the list has
  // nothing left to be about. The clear used to be conditional on the card
  // carrying a `lock_relay`, which a natively-held card never does -- so a
  // contest raised against a local agent's lock outlived the lock forever, and
  // every replica of this broker mirrored that stale entry on every pull.
  const b = await startBroker();
  try {
    const native = await post<RegisterResponse>(`${b.url}/register`, {
      pid: livePid(),
      cwd: "/work/native-holder",
      git_root: null,
      tty: null,
      summary: "",
      host: "native-host",
      client_pid: livePid(),
      project_key: PK,
      group_id: "default",
      group_secret_hash: null,
    });
    const held = await post<UpsertRes>(`${b.url}/roadmap/upsert`, {
      project_key: PK,
      by: native.body.peer_id,
      instance_token: native.body.instance_token,
      title: "held by a local agent, wanted by a replica",
      status: "in_progress",
    });
    expect(held.status).toBe(200);
    expect(["the native peer really holds it", held.body.item.locked]).toEqual([
      "the native peer really holds it",
      true,
    ]);
    // No relay anywhere on this card: the holder is one of this broker's own
    // agents, which is exactly the shape the old condition skipped.
    const db = new Database(b.dbPath);
    const relayed = db
      .query("SELECT lock_relay FROM roadmap_items WHERE id = ?")
      .get(held.body.item.id) as { lock_relay: string | null };
    expect(["a natively-held card carries no relay", relayed.lock_relay]).toEqual([
      "a natively-held card carries no relay",
      null,
    ]);

    const contest = await post<{ item?: RoadmapSyncRow }>(`${b.url}/roadmap/sync/lock`, {
      replica_id: R2,
      id: held.body.item.id,
      action: "claim",
      owner: { peer_id: "agent-beta", group_id: null },
    });
    expect(["a replica's claim on a held card is contested", contest.status]).toEqual([
      "a replica's claim on a held card is contested",
      409,
    ]);
    expect([
      "the contest is recorded against the holder",
      contest.body.item?.lock_contested_by,
    ]).toEqual(["the contest is recorded against the holder", [`agent-beta@${R2}`]]);

    const released = await post<UpsertRes>(`${b.url}/roadmap/upsert`, {
      project_key: PK,
      id: held.body.item.id,
      by: native.body.peer_id,
      instance_token: native.body.instance_token,
      locked: false,
    });
    expect(["the holder releases its own lock", released.status, released.body.item.locked]).toEqual([
      "the holder releases its own lock",
      200,
      false,
    ]);
    const after = db
      .query("SELECT lock_contested_by, lock_relay FROM roadmap_items WHERE id = ?")
      .get(held.body.item.id) as { lock_contested_by: string; lock_relay: string | null };
    expect([
      "a released card keeps no contest for a holder that is gone",
      after.lock_contested_by,
      after.lock_relay,
    ]).toEqual(["a released card keeps no contest for a holder that is gone", "[]", null]);

    // The sibling native release paths clear the same set unconditionally in
    // their own single UPDATE (archive here; the operator lock-release and the
    // stale-lock sweep share that statement shape). Green before this change as
    // well as after: it is here so a future edit that makes one of them
    // conditional the way upsert's was is caught by a test rather than by a
    // replica mirroring a dead contest.
    const archived = await post<UpsertRes>(`${b.url}/roadmap/upsert`, {
      project_key: PK,
      by: native.body.peer_id,
      instance_token: native.body.instance_token,
      title: "contested, then archived",
      status: "in_progress",
    });
    const archivedContest = await post<{ item?: RoadmapSyncRow }>(`${b.url}/roadmap/sync/lock`, {
      replica_id: R2,
      id: archived.body.item.id,
      action: "claim",
      owner: { peer_id: "agent-beta", group_id: null },
    });
    expect(["the second card is contested too", archivedContest.status]).toEqual([
      "the second card is contested too",
      409,
    ]);
    const archiveRes = await post(`${b.url}/roadmap/archive`, {
      id: archived.body.item.id,
      by: native.body.peer_id,
      instance_token: native.body.instance_token,
    });
    expect(["the holder archives its own card", archiveRes.status]).toEqual([
      "the holder archives its own card",
      200,
    ]);
    const afterArchive = db
      .query("SELECT lock_contested_by FROM roadmap_items WHERE id = ?")
      .get(archived.body.item.id) as { lock_contested_by: string };
    expect([
      "archiving releases the lock and the contest with it",
      afterArchive.lock_contested_by,
    ]).toEqual(["archiving releases the lock and the contest with it", "[]"]);

    // The other half of the same decision: a card with nothing to clear must not
    // pay a second row version for the check. `rev` is the pull cursor, so an
    // extra bump per ordinary edit would republish every card to every replica.
    const plain = await post<UpsertRes>(`${b.url}/roadmap/upsert`, {
      project_key: PK,
      by: native.body.peer_id,
      instance_token: native.body.instance_token,
      title: "never locked, never contested",
    });
    const revOf = (id: string) =>
      (db.query("SELECT rev FROM roadmap_items WHERE id = ?").get(id) as { rev: number }).rev;
    const ordinaryEdit = {
      project_key: PK,
      id: plain.body.item.id,
      by: native.body.peer_id,
      instance_token: native.body.instance_token,
      description: "an ordinary edit",
    };
    // Sent twice, and MEASURED on the second: an edit that changes the content
    // versions the row through the content trigger as well, so only a repeat of
    // the same values isolates the one bump the main UPDATE owes. A guard that
    // fired here would add a second.
    await post<UpsertRes>(`${b.url}/roadmap/upsert`, ordinaryEdit);
    const before = revOf(plain.body.item.id);
    await post<UpsertRes>(`${b.url}/roadmap/upsert`, ordinaryEdit);
    expect([
      "an edit with no lock state to clear versions the row exactly once",
      revOf(plain.body.item.id) - before,
    ]).toEqual(["an edit with no lock state to clear versions the row exactly once", 1]);
    db.close();
  } finally {
    await stopBroker(b);
  }
}, 30_000);

test("the three replication routes are refused on a token-bearing broker that does not serve replicas", async () => {
  // A broker_token is what a broker gives its own agents and Decks; it is not a
  // declaration that this broker is somebody's upstream. Without serve_replicas
  // the three routes are refused even to a caller holding the right Bearer --
  // and the refusal NAMES the flag, so the operator does not go hunting for a
  // credential he already has.
  const noRole = await startPlainBroker({ CLAUDE_PEERS_BROKER_TOKEN: TOKEN });
  const upstream = await startBroker();
  try {
    const seeded = await post<UpsertRes>(`${noRole.url}/roadmap/upsert`, {
      project_key: PK,
      by: "agent-seed",
      title: "reachable, and not replicable",
    });
    expect(seeded.status).toBe(200);

    for (const [route, body] of [
      ["/roadmap/sync/pull", { replica_id: R1, since_rev: 0 }],
      [
        "/roadmap/sync/push",
        { replica_id: R1, item: pushItem({ id: "card-no-role" }), expected_content_rev: null },
      ],
      [
        "/roadmap/sync/lock",
        {
          replica_id: R1,
          id: seeded.body.item.id,
          action: "claim",
          owner: { peer_id: "agent-remote", group_id: null },
        },
      ],
    ] as const) {
      const res = await post<{ error?: string }>(`${noRole.url}${route}`, body);
      expect([`${route} is refused without serve_replicas`, res.status]).toEqual([
        `${route} is refused without serve_replicas`,
        403,
      ]);
      expect([
        `${route}: the refusal names serve_replicas so the operator can act on it`,
        (res.body.error ?? "").includes("serve_replicas"),
      ]).toEqual([
        `${route}: the refusal names serve_replicas so the operator can act on it`,
        true,
      ]);
      if (route === "/roadmap/sync/pull") {
        // Pinned verbatim once: this string is what an operator greps for and
        // what the replica half matches on to raise its own hint.
        expect(res.body.error).toBe(
          "/roadmap/sync/pull is not served here: replication routes require serve_replicas to be enabled on this broker"
        );
      }
      // Distinct from the credential refusal: a broker that HAS the token must
      // never be told to go configure one.
      expect([
        `${route}: the role refusal is not the broker_token refusal`,
        (res.body.error ?? "").includes("broker_token"),
      ]).toEqual([`${route}: the role refusal is not the broker_token refusal`, false]);
    }

    // Same three calls, same token, on a broker that DID take the role.
    const pulled = await pull(upstream, 0);
    expect(["pull answers once serve_replicas is on", pulled.status]).toEqual([
      "pull answers once serve_replicas is on",
      200,
    ]);
    const served = await post<UpsertRes>(`${upstream.url}/roadmap/upsert`, {
      project_key: PK,
      by: "agent-seed",
      title: "replicable",
    });
    const pushed = await post<RoadmapSyncPushResponse>(`${upstream.url}/roadmap/sync/push`, {
      replica_id: R1,
      item: pushItem({ id: "card-with-role", title: "pushed to a real upstream" }),
      expected_content_rev: null,
    });
    expect(["push answers once serve_replicas is on", pushed.status]).toEqual([
      "push answers once serve_replicas is on",
      200,
    ]);
    const claimed = await post<RoadmapSyncLockClaimResponse>(`${upstream.url}/roadmap/sync/lock`, {
      replica_id: R1,
      id: served.body.item.id,
      action: "claim",
      owner: { peer_id: "agent-remote", group_id: null },
    });
    expect(["lock answers once serve_replicas is on", claimed.status]).toEqual([
      "lock answers once serve_replicas is on",
      200,
    ]);
  } finally {
    await stopBroker(upstream);
    await stopBroker(noRole);
  }
}, 30_000);

test("with NEITHER the role nor a token, the role refusal is the one answered", async () => {
  // Both guards fire on this deployment, so only their ORDER decides what the
  // operator reads. It is pinned here rather than left to whichever guard the
  // handler happens to call first: taking the role first means the answer names
  // the decision to make (be an upstream at all) before the credential that
  // decision would need, and an operator told to configure a token for routes
  // he never meant to serve would be following the wrong instruction.
  const bare = await startPlainBroker();
  try {
    for (const [route, body] of [
      ["/roadmap/sync/pull", { replica_id: R1, since_rev: 0 }],
      [
        "/roadmap/sync/push",
        { replica_id: R1, item: pushItem({ id: "card-bare" }), expected_content_rev: null },
      ],
      [
        "/roadmap/sync/lock",
        { replica_id: R1, id: "card-bare", action: "claim", owner: { peer_id: "agent-x", group_id: null } },
      ],
    ] as const) {
      const res = await fetch(`${bare.url}${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const parsed = (await res.json()) as { error?: string };
      expect([`${route}: refused`, res.status]).toEqual([`${route}: refused`, 403]);
      expect([
        `${route}: the role refusal comes first, the credential one is not what is said`,
        (parsed.error ?? "").includes("serve_replicas"),
        (parsed.error ?? "").includes("broker_token"),
      ]).toEqual([
        `${route}: the role refusal comes first, the credential one is not what is said`,
        true,
        false,
      ]);
    }
  } finally {
    await stopBroker(bare);
  }
}, 30_000);

test("a replica with serve_replicas set warns at startup and still refuses to serve the routes", async () => {
  // The flag is dead config on a replica: chaining replicas is what the mode
  // refusal exists to prevent, and a role opt-in must never be able to undo it.
  // The warning is the other half -- an operator who set the flag must not read
  // his own replicas' 403s as a bug.
  const upstream = await startBroker();
  const replica = await startPlainBroker({
    CLAUDE_PEERS_BROKER_URL: upstream.url,
    CLAUDE_PEERS_BROKER_TOKEN: TOKEN,
    CLAUDE_PEERS_OFFLINE_REPLICA: "1",
    CLAUDE_PEERS_SERVE_REPLICAS: "1",
  });
  try {
    const health = (await (await fetch(`${replica.url}/health`)).json()) as {
      mode: string;
      serve_replicas: boolean;
    };
    expect(["the replica reports its mode", health.mode]).toEqual(["the replica reports its mode", "replica"]);
    expect([
      "/health reports the flag as configured, even where the broker will not act on it",
      health.serve_replicas,
    ]).toEqual([
      "/health reports the flag as configured, even where the broker will not act on it",
      true,
    ]);

    for (const [route, body] of [
      ["/roadmap/sync/pull", { replica_id: R1, since_rev: 0 }],
      [
        "/roadmap/sync/push",
        { replica_id: R1, item: pushItem({ id: "card-chained" }), expected_content_rev: null },
      ],
      [
        "/roadmap/sync/lock",
        { replica_id: R1, id: "card-chained", action: "claim", owner: { peer_id: "agent-x", group_id: null } },
      ],
    ] as const) {
      const res = await post<{ error?: string }>(`${replica.url}${route}`, body);
      expect([`${route}: a replica with the flag still refuses`, res.status]).toEqual([
        `${route}: a replica with the flag still refuses`,
        403,
      ]);
      expect([
        `${route}: the refusal is the replica-mode one, not the role one`,
        (res.body.error ?? "").includes("this broker is a replica"),
      ]).toEqual([`${route}: the refusal is the replica-mode one, not the role one`, true]);
      expect([
        `${route}: a replica never answers with the serve_replicas hint`,
        (res.body.error ?? "").includes("serve_replicas"),
      ]).toEqual([`${route}: a replica never answers with the serve_replicas hint`, false]);
    }

    // A pristine replica publishes the counter at zero rather than omitting it:
    // a poller that reads `undefined` on a fresh broker cannot tell "nothing
    // replaced yet" from "this broker does not report it".
    const status = await post<RoadmapSyncStatus>(`${replica.url}/roadmap/sync/status`, {});
    expect([
      "a fresh replica publishes queue_replaced at zero",
      status.body.mode,
      status.body.queue_replaced,
    ]).toEqual(["a fresh replica publishes queue_replaced at zero", "replica", 0]);

    const logged = await Bun.file(join(replica.tmpDir, "logs", "broker.log")).text();
    expect(
      logged.includes("serve_replicas is set on a broker running in replica mode"),
      "the operator who set a flag the broker will not obey is told so at startup"
    ).toBe(true);
  } finally {
    await stopBroker(replica);
    await stopBroker(upstream);
  }
}, 30_000);

test("a relayed lock survives the TTL clause too, while its relay keeps beating", async () => {
  // The TTL clause reads `updated_at`, which no lock claim refreshes: a replica
  // whose agent works for hours without writing the card has a live relay and a
  // stale row, and the sweep would take the lock away from an agent that is
  // demonstrably still there -- leaving the replica locked while the upstream
  // shows the card free.
  const b = await startBroker({
    CLAUDE_PEERS_LOCK_TTL_SEC: "5",
    CLAUDE_PEERS_LOCK_GRACE_SEC: "30",
    CLAUDE_PEERS_LOCK_SWEEP_SEC: "1",
  });
  try {
    const relayed = await post<UpsertRes>(`${b.url}/roadmap/upsert`, {
      project_key: PK,
      by: "agent-seed",
      title: "relayed through the TTL",
    });
    const claim = await post<RoadmapSyncLockClaimResponse>(`${b.url}/roadmap/sync/lock`, {
      replica_id: R1,
      id: relayed.body.item.id,
      action: "claim",
      owner: { peer_id: "agent-remote", group_id: "default" },
    });
    expect(claim.status).toBe(200);

    // A lock nobody relays, aged the same way: it must fall on the first sweep,
    // which is what proves the sweep ran at all during the window below.
    const ghost = await post<UpsertRes>(`${b.url}/roadmap/upsert`, {
      project_key: PK,
      by: "agent-ghost",
      title: "aged, nobody relays it",
      status: "in_progress",
    });
    expect(ghost.body.item.locked).toBe(true);

    const db = new Database(b.dbPath);
    db.run("PRAGMA busy_timeout = 3000");
    db.run(
      "UPDATE roadmap_items SET updated_at = datetime('now', '-600 seconds') WHERE id IN (?, ?)",
      [relayed.body.item.id, ghost.body.item.id]
    );
    db.close();

    const fallen = await pollUntil(12_000, 300, async () => {
      const page = await pull(b, 0);
      const held = page.body.items.find((i) => i.id === relayed.body.item.id)!;
      expect([
        "a lock whose relay is beating is not stale, however old the row is",
        held.locked,
      ]).toEqual(["a lock whose relay is beating is not stale, however old the row is", true]);
      const other = page.body.items.find((i) => i.id === ghost.body.item.id)!;
      return { done: !other.locked, value: other };
    });
    expect(fallen.updated_by).toBe("lock-sweep");

    // The relay goes quiet: the row is stale AND unrelayed, and falls.
    const db2 = new Database(b.dbPath);
    db2.run("PRAGMA busy_timeout = 3000");
    db2.run("UPDATE roadmap_items SET lock_relay_seen = datetime('now', '-120 seconds') WHERE id = ?", [
      relayed.body.item.id,
    ]);
    db2.close();
    const swept = await pollUntil(12_000, 300, async () => {
      const page = await pull(b, 0);
      const row = page.body.items.find((i) => i.id === relayed.body.item.id)!;
      return { done: !row.locked, value: row };
    });
    expect(swept.updated_by).toBe("lock-sweep");
  } finally {
    await stopBroker(b);
  }
}, 30_000);

test("a replica cannot sign a write with another replica's provenance, nor with the sweep's", async () => {
  // The relay prefix is what a reader trusts to answer "whose operator wrote
  // this": a replica free to send `via:<someone else>:deck` writes as the
  // OTHER machine's operator, and the victim replica -- which strips its own
  // prefix on the way in -- displays it as its own operator's work. The sweep's
  // name is the same kind of claim: it is what unlocks the one auto-resolution
  // a replica performs without asking.
  const b = await startBroker();
  const own = `via:${R1.slice(0, 8)}:`;
  try {
    for (const [field, value] of [
      ["updated_by", "via:aaaaaaaa:deck"],
      ["created_by", "via:aaaaaaaa:deck"],
    ] as const) {
      const forged = await post<{ error?: string }>(`${b.url}/roadmap/sync/push`, {
        replica_id: R1,
        item: pushItem({ id: `card-forged-${field}`, [field]: value }),
        expected_content_rev: null,
      });
      expect([
        `a ${field} claiming another replica's relay is refused, not stored`,
        forged.status,
      ]).toEqual([`a ${field} claiming another replica's relay is refused, not stored`, 400]);
    }

    // Its OWN prefix is not a claim about anyone else: a row it already relayed
    // is pushed back unchanged, and stays as it is.
    const mine = await post<RoadmapSyncPushResponse>(`${b.url}/roadmap/sync/push`, {
      replica_id: R1,
      item: pushItem({ id: "card-own-prefix", created_by: `${own}deck`, updated_by: `${own}deck` }),
      expected_content_rev: null,
    });
    expect([
      "a replica re-pushing its own relayed authorship is idempotent, never prefixed twice",
      mine.status,
      mine.body.item?.created_by,
      mine.body.item?.updated_by,
    ]).toEqual([
      "a replica re-pushing its own relayed authorship is idempotent, never prefixed twice",
      200,
      `${own}deck`,
      `${own}deck`,
    ]);

    // The sweep is this broker's own voice. A replica's local sweep is a real
    // event that has to travel, so it is relabelled rather than refused.
    const swept = await post<RoadmapSyncPushResponse>(`${b.url}/roadmap/sync/push`, {
      replica_id: R1,
      item: pushItem({ id: "card-swept-elsewhere", created_by: "agent-b", updated_by: "lock-sweep" }),
      expected_content_rev: null,
    });
    expect([
      "another broker's sweep is stamped as that broker's, so it unlocks nobody's auto-resolution here",
      swept.status,
      swept.body.item?.updated_by,
    ]).toEqual([
      "another broker's sweep is stamped as that broker's, so it unlocks nobody's auto-resolution here",
      200,
      `${own}lock-sweep`,
    ]);

    // A card this upstream already attributes to another replica's relay: the
    // field is immutable here and the push does not write it, so carrying it
    // back unchanged is not a claim and must not block the content.
    const foreign = await post<UpsertRes>(`${b.url}/roadmap/upsert`, {
      project_key: PK,
      by: "via:aaaaaaaa:deck",
      title: "created through another replica",
    });
    expect(foreign.body.item.created_by).toBe("via:aaaaaaaa:deck");
    const row = (await pull(b, 0)).body.items.find((i) => i.id === foreign.body.item.id)!;
    const carried = await post<RoadmapSyncPushResponse>(`${b.url}/roadmap/sync/push`, {
      replica_id: R1,
      item: pushItem({
        id: foreign.body.item.id,
        title: "edited on a second replica",
        created_by: "via:aaaaaaaa:deck",
        updated_by: "agent-b",
      }),
      expected_content_rev: row.content_rev,
    });
    expect([
      "an existing card's creator is not written by a push, so carrying it back is not a claim",
      carried.status,
      carried.body.item?.created_by,
      carried.body.item?.title,
    ]).toEqual([
      "an existing card's creator is not written by a push, so carrying it back is not a claim",
      200,
      "via:aaaaaaaa:deck",
      "edited on a second replica",
    ]);
  } finally {
    await stopBroker(b);
  }
}, 30_000);

test("a relay the sweep released leaves nothing behind, and cannot write behind the peer that took the card", async () => {
  // The sweep clears the lock but used to leave `lock_relay` pointing at the
  // replica that held it. A native peer then takes the card, and the push guard
  // -- which asks "is the holder MY relay?" -- reads that stale pointer and
  // lets the departed replica write straight through a lock it no longer has.
  const b = await startBroker({
    CLAUDE_PEERS_LOCK_TTL_SEC: "3600",
    CLAUDE_PEERS_LOCK_GRACE_SEC: "1",
    CLAUDE_PEERS_LOCK_SWEEP_SEC: "1",
  });
  try {
    const created = await post<UpsertRes>(`${b.url}/roadmap/upsert`, {
      project_key: PK,
      by: "agent-seed",
      title: "relayed, then swept, then taken",
    });
    const id = created.body.item.id;
    const claim = await post<RoadmapSyncLockClaimResponse>(`${b.url}/roadmap/sync/lock`, {
      replica_id: R1,
      id,
      action: "claim",
      owner: { peer_id: "agent-remote", group_id: "default" },
    });
    expect(claim.status).toBe(200);

    // The replica goes away for good: its heartbeat ages past the grace window
    // and the sweep reclaims the card.
    const db = new Database(b.dbPath);
    db.run("PRAGMA busy_timeout = 3000");
    db.run("UPDATE roadmap_items SET lock_relay_seen = datetime('now', '-120 seconds') WHERE id = ?", [id]);
    db.close();
    await pollUntil(12_000, 200, async () => {
      const page = await pull(b, 0);
      return { done: !page.body.items.find((i) => i.id === id)!.locked, value: null };
    });

    const swept = new Database(b.dbPath);
    const after = swept
      .query("SELECT lock_relay, lock_relay_seen, lock_contested_by FROM roadmap_items WHERE id = ?")
      .get(id) as { lock_relay: string | null; lock_relay_seen: string | null; lock_contested_by: string };
    swept.close();
    expect([
      "a released lock keeps no relay: the pointer that grants a replica its rights dies with it",
      after.lock_relay,
      after.lock_relay_seen,
      after.lock_contested_by,
    ]).toEqual([
      "a released lock keeps no relay: the pointer that grants a replica its rights dies with it",
      null,
      null,
      "[]",
    ]);

    // A native peer picks the card up.
    const reg = await post<RegisterResponse>(`${b.url}/register`, {
      pid: livePid(),
      cwd: "/work/sync-relay-taken",
      git_root: null,
      tty: null,
      summary: "",
      host: "sync-host",
      client_pid: livePid(),
      project_key: PK,
      group_id: "default",
      group_secret_hash: null,
    });
    const taken = await post<UpsertRes>(`${b.url}/roadmap/upsert`, {
      project_key: PK,
      id,
      by: reg.body.peer_id,
      instance_token: reg.body.instance_token,
      status: "in_progress",
    });
    expect([taken.body.item.locked, taken.body.item.locked_by]).toEqual([true, reg.body.peer_id]);

    const row = (await pull(b, 0)).body.items.find((i) => i.id === id)!;
    const pushed = await post<RoadmapSyncPushConflict>(`${b.url}/roadmap/sync/push`, {
      replica_id: R1,
      item: pushItem({ id, title: "written by a relay that no longer holds anything" }),
      expected_content_rev: row.content_rev,
    });
    expect([
      "the replica that used to relay this lock is a third party like any other",
      pushed.status,
      pushed.body.reason,
    ]).toEqual([
      "the replica that used to relay this lock is a third party like any other",
      409,
      "locked_upstream",
    ]);
    const stillTheirs = (await pull(b, 0)).body.items.find((i) => i.id === id)!;
    expect([
      "and it wrote nothing",
      stillTheirs.title,
      stillTheirs.locked_by,
    ]).toEqual(["and it wrote nothing", "relayed, then swept, then taken", reg.body.peer_id]);

    const release = await post<RoadmapSyncLockReleaseResponse>(`${b.url}/roadmap/sync/lock`, {
      replica_id: R1,
      id,
      action: "release",
      owner: { peer_id: "agent-remote", group_id: "default" },
    });
    expect([
      "nor can it release the lock it no longer relays",
      release.status,
      release.body.released,
      release.body.item?.locked,
    ]).toEqual(["nor can it release the lock it no longer relays", 200, false, true]);
  } finally {
    await stopBroker(b);
  }
}, 30_000);

test("a push behind a relay whose heartbeat has gone stale is refused, sweep or no sweep", async () => {
  // The relay pointer alone is not a right: it is worth exactly as much as the
  // heartbeat behind it, the same measure the sweep uses to decide the agent is
  // still there. Swept out of the way here (a 1 h sweep interval) so the check
  // is the push guard's own and not the sweep's.
  const b = await startBroker({
    CLAUDE_PEERS_LOCK_TTL_SEC: "3600",
    CLAUDE_PEERS_LOCK_GRACE_SEC: "30",
    CLAUDE_PEERS_LOCK_SWEEP_SEC: "3600",
  });
  try {
    const created = await post<UpsertRes>(`${b.url}/roadmap/upsert`, {
      project_key: PK,
      by: "agent-seed",
      title: "relayed by a replica gone quiet",
    });
    const id = created.body.item.id;
    const claim = await post<RoadmapSyncLockClaimResponse>(`${b.url}/roadmap/sync/lock`, {
      replica_id: R1,
      id,
      action: "claim",
      owner: { peer_id: "agent-remote", group_id: "default" },
    });
    expect(claim.status).toBe(200);
    const fresh = await post<RoadmapSyncPushResponse>(`${b.url}/roadmap/sync/push`, {
      replica_id: R1,
      item: pushItem({ id, title: "written while the relay beats" }),
      expected_content_rev: claim.body.item.content_rev,
    });
    expect(["a beating relay writes behind its own lock", fresh.status]).toEqual([
      "a beating relay writes behind its own lock",
      200,
    ]);

    const db = new Database(b.dbPath);
    db.run("PRAGMA busy_timeout = 3000");
    db.run("UPDATE roadmap_items SET lock_relay_seen = datetime('now', '-120 seconds') WHERE id = ?", [id]);
    db.close();
    const stale = await post<RoadmapSyncPushConflict>(`${b.url}/roadmap/sync/push`, {
      replica_id: R1,
      item: pushItem({ id, title: "written after it went quiet" }),
      expected_content_rev: fresh.body.content_rev,
    });
    expect([
      "a relay that stopped beating no longer speaks for the agent behind it",
      stale.status,
      stale.body.reason,
    ]).toEqual([
      "a relay that stopped beating no longer speaks for the agent behind it",
      409,
      "locked_upstream",
    ]);
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
