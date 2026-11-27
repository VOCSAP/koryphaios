// The upstream half of the replication protocol, exercised against a single
// broker: paging and its cap, the four push outcomes, the lock relay (claim,
// re-assertion, contested annotation, release), the sweep exemption a relayed
// lock lives by, and the two projections that must never carry a credential
// across the boundary.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import {
  startBroker as startPlainBroker,
  stopBroker,
  livePid,
  deckAuthored,
  FIXTURE_OPERATOR_ID,
  type TestBroker,
  openBrokerDb,
  seedLotExecution,
} from "./_helper.ts";
import { buildRoadmapAppendHeader } from "../shared/roadmap-append.ts";
import { ROADMAP_TITLE_MAX } from "../shared/roadmap-title.ts";
import type {
  RegisterResponse,
  RoadmapContextDocument,
  RoadmapContextDocumentSyncPullResponse,
  RoadmapContextDocumentSyncPushResponse,
  RoadmapItem,
  RoadmapLotQueueDeltaConflict,
  RoadmapLotQueueDeltaResponse,
  RoadmapQueueDeltaConflict,
  RoadmapQueueDeltaResponse,
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
    triage: null,
    tags: [],
    depends_on: [],
    deleted_at: null,
    queue: null,
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

function syncDocument(id: string, units: RoadmapContextDocument["units"]): RoadmapContextDocument {
  return {
    id,
    roadmap_item_id: "card-document-sync",
    project_key: PK,
    created_by: "cli:document-host:document-user",
    created_at: "2026-09-23T14:00:00.000Z",
    units,
  };
}

function documentTimestamp(index: number): string {
  return new Date(Date.UTC(2026, 8, 23, 14, 0, index)).toISOString();
}

function documentUnits(prefix: string, count: number, raw: string): RoadmapContextDocument["units"] {
  return Array.from({ length: count }, (_, position) => ({
    id: `${prefix}-unit-${position}`,
    source_target: position === 0 ? "body" : documentTimestamp(position),
    raw,
    deported_at: "2026-09-23T14:00:00.000Z",
    position,
  }));
}

function documentableContext(count: number, text: string): { context: string; targets: string[] } {
  const targets = ["body"];
  let context = text;
  for (let index = 1; index < count; index += 1) {
    const target = documentTimestamp(index);
    targets.push(target);
    context += `${buildRoadmapAppendHeader(target, "agent-local")}${text}`;
  }
  return { context, targets };
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

// Started once for the file: a test isolates itself by its own ids, and starts its own broker only for a different env, an empty table or a sweep it waits for.
let shared: TestBroker;
let openUpstream: TestBroker;
let noRole: TestBroker;
let bare: TestBroker;
let deadReplica: TestBroker;

beforeAll(async () => {
  [shared, openUpstream, noRole, bare, deadReplica] = await Promise.all([
    startBroker(),
    startPlainBroker({ CLAUDE_PEERS_SERVE_REPLICAS: "1" }),
    startPlainBroker({ CLAUDE_PEERS_BROKER_TOKEN: TOKEN }),
    startPlainBroker(),
    startBroker({
      CLAUDE_PEERS_BROKER_URL: "http://127.0.0.1:9",
      CLAUDE_PEERS_OFFLINE_REPLICA: "1",
      CLAUDE_PEERS_SYNC_TICK_MS: "60000",
    }),
  ]);
}, 30_000);

afterAll(async () => {
  await Promise.all([shared, openUpstream, noRole, bare, deadReplica].map((b) => (b ? stopBroker(b) : undefined)));
});

test.concurrent("pull pages by rev, answers a cursor, and caps the page size at 500", async () => {
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
    const db = openBrokerDb(b.dbPath);
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

test.concurrent("a relayed lock survives the owner-gone sweep while its relay is fresh, and falls once it goes quiet", async () => {
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

    // A lock nobody relays and no peer owns falls on the first sweep after it
    // is taken, which is what proves a pass ran past the relayed one below.
    const ghost = await post<UpsertRes>(`${b.url}/roadmap/upsert`, {
      project_key: PK,
      by: "agent-ghost",
      title: "owner gone, nobody relays it",
      status: "in_progress",
    });
    expect(ghost.body.item.locked).toBe(true);
    await pollUntil(12_000, 100, async () => {
      const page = await pull(b, 0);
      return { done: !page.body.items.find((i) => i.id === ghost.body.item.id)!.locked, value: null };
    });

    // The pass that took the ghost left the relayed lock, whose heartbeat is fresh.
    const held = await pull(b, 0);
    expect([
      "a lock relayed by a live replica survives the owner-gone sweep",
      held.body.items.find((i) => i.id === id)!.locked,
    ]).toEqual(["a lock relayed by a live replica survives the owner-gone sweep", true]);

    // The replica goes quiet: the relay ages past the grace window exactly
    // like an owner's own silence would.
    const db = openBrokerDb(b.dbPath);
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

test.concurrent("a replica with serve_replicas set warns at startup and still refuses to serve the routes", async () => {
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

test.concurrent("a relayed lock survives the TTL clause too, while its relay keeps beating", async () => {
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

    const db = openBrokerDb(b.dbPath);
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
    const db2 = openBrokerDb(b.dbPath);
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

test.concurrent("a relay the sweep released leaves nothing behind, and cannot write behind the peer that took the card", async () => {
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
    const db = openBrokerDb(b.dbPath);
    db.run("UPDATE roadmap_items SET lock_relay_seen = datetime('now', '-120 seconds') WHERE id = ?", [id]);
    db.close();
    await pollUntil(12_000, 200, async () => {
      const page = await pull(b, 0);
      return { done: !page.body.items.find((i) => i.id === id)!.locked, value: null };
    });

    const swept = openBrokerDb(b.dbPath);
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

test.concurrent("a push behind a relay whose heartbeat has gone stale is refused, sweep or no sweep", async () => {
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

    const db = openBrokerDb(b.dbPath);
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

test("pull refuses a malformed cursor, page size or replica_id instead of clamping it", async () => {
  const b = shared;
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
}, 20_000);

test("a pulled row never carries locked_by_token or operator_id, which the stored row does carry", async () => {
  const b = shared;
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
  const db = openBrokerDb(b.dbPath);
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
  expect([
    "a replica never receives a dispatch state tag, local to the broker that computed it",
    "dispatch_state_tag" in row,
  ]).toEqual(["a replica never receives a dispatch state tag, local to the broker that computed it", false]);
  expect(JSON.stringify(page.body), "no field of the pulled page holds the stored token's value").not.toContain(stored.locked_by_token!);
  // The rest of the lock state does travel: the point is the credential, not the lock.
  expect(row.locked).toBe(true);
  expect(row.locked_by).toBe(reg.body.peer_id);
}, 20_000);

test("push: fast-forward accepted, stale base refused, unknown base refused, insert only with a null base", async () => {
  const b = shared;
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
}, 20_000);

test("push: the card date travels with adopted content, is never invented, and never moves on identical content", async () => {
  const b = shared;
  const D1 = "2026-03-01T00:00:00.000Z";
  const D2 = "2026-04-02T00:00:00.000Z";
  const D3 = "2026-05-03T00:00:00.000Z";
  const send = (item: RoadmapSyncPushItem, expected: number | null) =>
    post<RoadmapSyncPushResponse>(`${b.url}/roadmap/sync/push`, {
      replica_id: R1,
      item,
      expected_content_rev: expected,
    });

  const inserted = await send(pushItem({ id: "card-date-known", content_updated_at: D1 }), null);
  expect(inserted.status).toBe(200);
  expect(inserted.body.item.content_updated_at, "a new card carries the pushed date").toBe(D1);

  const withoutKey = await send(pushItem({ id: "card-date-absent" }), null);
  expect(withoutKey.body.item.content_updated_at, "an older replica sends no date: unknown, never now").toBeNull();
  const nullDate = await send(pushItem({ id: "card-date-null", content_updated_at: null }), null);
  expect(nullDate.body.item.content_updated_at).toBeNull();
  const garbage = await send(pushItem({ id: "card-date-garbage", content_updated_at: "yesterday" }), null);
  expect(garbage.status).toBe(200);
  expect(garbage.body.item.content_updated_at).toBeNull();

  const edited = await send(pushItem({ id: "card-date-known", description: "v2", content_updated_at: D2 }), inserted.body.content_rev);
  expect(edited.body.item.content_updated_at, "adopted content brings its own date").toBe(D2);

  const undated = await send(pushItem({ id: "card-date-known", description: "v3" }), edited.body.content_rev);
  expect(undated.body.item.content_updated_at, "adopted content without a date is unknown, not the previous date").toBeNull();

  const redated = await send(pushItem({ id: "card-date-known", description: "v4", content_updated_at: D2 }), undated.body.content_rev);
  expect(redated.body.item.content_updated_at).toBe(D2);

  const identical = await send(
    pushItem({ id: "card-date-known", description: "v4", content_updated_at: D3 }),
    redated.body.content_rev
  );
  expect(identical.status).toBe(200);
  expect(identical.body.item.content_updated_at, "identical content keeps the receiver's date whatever the wire says").toBe(D2);

  const queueOnly = await send(
    pushItem({ id: "card-date-known", description: "v4", queue: 4 }),
    identical.body.content_rev
  );
  expect(queueOnly.body.item.queue).toBe(4);
  expect(queueOnly.body.item.content_updated_at, "a queue-only push fabricates nothing").toBe(D2);
}, 20_000);

test("push is refused on a card the upstream work-locks for a holder this replica does not relay", async () => {
  const b = shared;
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
  const db = openBrokerDb(b.dbPath);
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
  expect(
    JSON.stringify([refused.body, afterRefusal]),
    "neither the refused push reply nor the pulled row holds the holder's token value"
  ).not.toContain(heldToken!);

  const contested = await post<RoadmapSyncLockClaimResponse>(`${b.url}/roadmap/sync/lock`, {
    replica_id: R1,
    id: held.body.item.id,
    action: "claim",
    owner: { peer_id: "agent-remote", group_id: "default" },
  });
  const foreignRelease = await post<RoadmapSyncLockReleaseResponse>(`${b.url}/roadmap/sync/lock`, {
    replica_id: R1,
    id: held.body.item.id,
    action: "release",
    owner: { peer_id: "agent-remote", group_id: "default" },
  });
  expect(heldToken, "the premise: the row holds a token to look for").toBeTruthy();
  expect([contested.status, contested.body.item.id, foreignRelease.body.item?.id], "both replies render the held card").toEqual([
    409,
    held.body.item.id,
    held.body.item.id,
  ]);
  expect(
    JSON.stringify([contested.body, foreignRelease.body]),
    "neither sync/lock reply holds the holder's token value"
  ).not.toContain(heldToken!);

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
}, 30_000);

test("push writes the queue but never the lock columns or operator_id", async () => {
  const b = shared;
  // Signed by the operator so the row carries an operator_id: a column a
  // push must leave alone. Its lock is the one this replica relays, the
  // only kind a push may land behind at all.
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

  const db = openBrokerDb(b.dbPath);
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
    "a push carries the rank it sent; the lock and the operator proof stay as the upstream had them",
    stored.queue,
    stored.locked,
    stored.locked_by,
    stored.lock_relay,
    stored.locked_by_token,
    stored.operator_id,
  ]).toEqual([
    "a push carries the rank it sent; the lock and the operator proof stay as the upstream had them",
    99,
    1,
    "agent-remote",
    R1,
    null,
    FIXTURE_OPERATOR_ID,
  ]);
}, 20_000);

test("a push omitting queue entirely leaves the upstream rank untouched", async () => {
  const b = shared;
  const signed = await post<UpsertRes>(
    `${b.url}/roadmap/upsert`,
    deckAuthored({ project_key: PK, title: "already ranked upstream", queue: 5 })
  );
  expect(signed.status).toBe(200);
  const id = signed.body.item.id;
  const preDb = openBrokerDb(b.dbPath);
  const contentRev = (
    preDb.query("SELECT content_rev FROM roadmap_items WHERE id = ?").get(id) as { content_rev: number }
  ).content_rev;
  preDb.close();

  // An older replica's push body simply never had this key: build one the
  // same way as every other test here, then drop it before sending.
  const item = pushItem({ id, title: "edited without touching the rank" } as Partial<RoadmapSyncPushItem> & {
    id: string;
  });
  delete item.queue;

  const pushed = await post<RoadmapSyncPushResponse>(`${b.url}/roadmap/sync/push`, {
    replica_id: R1,
    item,
    expected_content_rev: contentRev,
  });
  expect(pushed.status).toBe(200);

  const db = openBrokerDb(b.dbPath);
  const stored = db.query("SELECT queue FROM roadmap_items WHERE id = ?").get(id) as { queue: number | null };
  db.close();
  expect([
    "an omitted queue key never clears the upstream rank",
    stored.queue,
  ]).toEqual(["an omitted queue key never clears the upstream rank", 5]);
}, 20_000);

test("a push with queue: null explicitly clears the upstream rank", async () => {
  const b = shared;
  const signed = await post<UpsertRes>(
    `${b.url}/roadmap/upsert`,
    deckAuthored({ project_key: PK, title: "already ranked upstream", queue: 5 })
  );
  expect(signed.status).toBe(200);
  const id = signed.body.item.id;
  const preDb = openBrokerDb(b.dbPath);
  const contentRev = (
    preDb.query("SELECT content_rev FROM roadmap_items WHERE id = ?").get(id) as { content_rev: number }
  ).content_rev;
  preDb.close();

  const pushed = await post<RoadmapSyncPushResponse>(`${b.url}/roadmap/sync/push`, {
    replica_id: R1,
    item: pushItem({ id, title: "unranked on the replica", queue: null } as Partial<RoadmapSyncPushItem> & {
      id: string;
    }),
    expected_content_rev: contentRev,
  });
  expect(pushed.status).toBe(200);

  const db = openBrokerDb(b.dbPath);
  const stored = db.query("SELECT queue FROM roadmap_items WHERE id = ?").get(id) as { queue: number | null };
  db.close();
  expect([
    "an explicit null clears the upstream rank, unlike a merely absent key",
    stored.queue,
  ]).toEqual(["an explicit null clears the upstream rank, unlike a merely absent key", null]);
}, 20_000);

test.each([true, false])(
  "a push turning a ranked card done clears the upstream rank (queue key present: %p)",
  async (carriesKey) => {
    const b = shared;
    const signed = await post<UpsertRes>(
      `${b.url}/roadmap/upsert`,
      deckAuthored({ project_key: PK, title: "ranked, closed on the replica", queue: 5 })
    );
    expect(signed.status).toBe(200);
    const id = signed.body.item.id;
    expect(signed.body.item.queue, "non-vacuity: the upstream row starts ranked").toBe(5);
    const preDb = openBrokerDb(b.dbPath);
    const contentRev = (
      preDb.query("SELECT content_rev FROM roadmap_items WHERE id = ?").get(id) as { content_rev: number }
    ).content_rev;
    preDb.close();

    const item = pushItem({ id, title: "closed on the replica", status: "done", queue: 9 } as Partial<RoadmapSyncPushItem> & {
      id: string;
    });
    if (!carriesKey) delete item.queue;
    const pushed = await post<RoadmapSyncPushResponse>(`${b.url}/roadmap/sync/push`, {
      replica_id: R1,
      item,
      expected_content_rev: contentRev,
    });
    expect(pushed.status).toBe(200);

    const db = openBrokerDb(b.dbPath);
    const stored = db.query("SELECT status, queue FROM roadmap_items WHERE id = ?").get(id);
    db.close();
    expect(stored, "a done card holds no rank, whatever the push carried").toEqual({ status: "done", queue: null });
  },
  20_000
);

test("a push inserting a card already done with a rank stores it unranked", async () => {
  const b = shared;
  const id = crypto.randomUUID();
  const pushed = await post<RoadmapSyncPushResponse>(`${b.url}/roadmap/sync/push`, {
    replica_id: R1,
    item: pushItem({ id, title: "born done on the replica", status: "done", queue: 4 } as Partial<RoadmapSyncPushItem> & {
      id: string;
    }),
    expected_content_rev: null,
  });
  expect(pushed.status).toBe(200);

  const db = openBrokerDb(b.dbPath);
  const stored = db.query("SELECT status, queue FROM roadmap_items WHERE id = ?").get(id);
  db.close();
  expect(stored, "the INSERT drops the rank of a terminal card").toEqual({ status: "done", queue: null });
}, 20_000);

test.each([0, -1, 1.5, "3"])("push refuses an invalid queue rank: %p", async (badQueue) => {
  const b = shared;
  const item = {
    ...pushItem({ id: "11111111-1111-4111-8111-111111111111", title: "invalid rank probe" } as Partial<RoadmapSyncPushItem> & {
      id: string;
    }),
    queue: badQueue,
  } as unknown as RoadmapSyncPushItem;
  const pushed = await post<{ error: string }>(`${b.url}/roadmap/sync/push`, {
    replica_id: R1,
    item,
    expected_content_rev: null,
  });
  expect([badQueue, pushed.status]).toEqual([badQueue, 400]);
});

test("push never stores an author this upstream reads as one of its own: it stamps the relay instead", async () => {
  const b = shared;
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
}, 20_000);

test("push refuses an unchecked enum, an unparsable timestamp or an author outside the identity charset", async () => {
  const b = shared;
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
}, 20_000);

test("push refuses a miscased project_key with 400 naming the lowercase form, nothing stored", async () => {
  const b = shared;
  const res = await post<{ error?: string }>(`${b.url}/roadmap/sync/push`, {
    replica_id: R1,
    item: pushItem({ id: "card-miscased-key", project_key: "github.com/VOCSAP/sync-routes-repo" }),
    expected_content_rev: null,
  });
  expect(res.status).toBe(400);
  expect(res.body.error).toContain("github.com/vocsap/sync-routes-repo");

  const db = openBrokerDb(b.dbPath, { readonly: true });
  try {
    const row = db.query("SELECT COUNT(*) AS n FROM roadmap_items WHERE id = ?").get("card-miscased-key") as { n: number };
    expect(row.n).toBe(0);
  } finally {
    db.close();
  }

  const control = await post<RoadmapSyncPushResponse>(`${b.url}/roadmap/sync/push`, {
    replica_id: R1,
    item: pushItem({ id: "card-lowercase-key" }),
    expected_content_rev: null,
  });
  expect(control.status).toBe(200);
}, 20_000);

test("push refuses a title over the roadmap bound with 400, and stores one at the bound", async () => {
  const b = shared;
  const over = await post<{ error?: string }>(`${b.url}/roadmap/sync/push`, {
    replica_id: R1,
    item: pushItem({ id: "card-title-over", title: "t".repeat(ROADMAP_TITLE_MAX + 1) }),
    expected_content_rev: null,
  });
  expect(over.status).toBe(400);
  expect(over.body.error).toContain(String(ROADMAP_TITLE_MAX));

  const atBound = await post<RoadmapSyncPushResponse>(`${b.url}/roadmap/sync/push`, {
    replica_id: R1,
    item: pushItem({ id: "card-title-at-bound", title: "t".repeat(ROADMAP_TITLE_MAX) }),
    expected_content_rev: null,
  });
  expect(atBound.status).toBe(200);

  const db = openBrokerDb(b.dbPath, { readonly: true });
  try {
    const rows = db.query("SELECT id FROM roadmap_items WHERE id IN ('card-title-over', 'card-title-at-bound')").all() as { id: string }[];
    expect(rows.map((r) => r.id)).toEqual(["card-title-at-bound"]);
  } finally {
    db.close();
  }
}, 20_000);

test("a replicated write carries content and never locks; a relayed claim still obeys the inactive rule", async () => {
  const b = shared;
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
}, 20_000);

test("lock relay: claim, re-assert, contested annotation, and who may release", async () => {
  const b = shared;
  const created = await post<UpsertRes>(`${b.url}/roadmap/upsert`, {
    project_key: PK,
    by: "agent-seed",
    title: "relayed lock",
  });
  const id = created.body.item.id;
  const PINNED = "2020-01-01T00:00:00.000Z";
  const pinDb = openBrokerDb(b.dbPath);
  pinDb.run("UPDATE roadmap_items SET content_updated_at = ? WHERE id = ?", [PINNED, id]);
  const dateNow = () =>
    (pinDb.query("SELECT content_updated_at FROM roadmap_items WHERE id = ?").get(id) as { content_updated_at: string | null })
      .content_updated_at;

  const claim = await post<RoadmapSyncLockClaimResponse>(`${b.url}/roadmap/sync/lock`, {
    replica_id: R1,
    id,
    action: "claim",
    owner: { peer_id: "agent-a", group_id: "default" },
  });
  expect([claim.status, claim.body.scope]).toEqual([200, "global"]);
  expect(claim.body.item.locked).toBe(true);
  expect(claim.body.item.locked_by).toBe("agent-a");
  expect(dateNow(), "a relayed claim dates nothing").toBe(PINNED);

  const db = openBrokerDb(b.dbPath);
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
  expect(dateNow(), "a contest annotation dates nothing").toBe(PINNED);

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
  expect(dateNow(), "a lease heartbeat dates nothing").toBe(PINNED);

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
  expect(dateNow(), "a relayed release dates nothing").toBe(PINNED);
  db.close();
  pinDb.close();

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
}, 20_000);

test("the three replication routes are refused outright on a broker with no configured token", async () => {
  // Without a broker_token every route is unauthenticated, and /roadmap/sync/push
  // writes content on any card under any author while walking past the work-lock
  // guard. The routes exist only where a credential gates them.
  // serve_replicas ON and no token: the role is granted, so the refusal this
  // probe reads back is the CREDENTIAL one and not the role one that precedes it.
  const open = openUpstream;
  const closed = shared;
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
}, 30_000);

test("releasing a natively-held card drops the contest annotation, relayed or not", async () => {
  // Contestation is defined against a HOLDER: once the lock is gone the list has
  // nothing left to be about. The clear used to be conditional on the card
  // carrying a `lock_relay`, which a natively-held card never does -- so a
  // contest raised against a local agent's lock outlived the lock forever, and
  // every replica of this broker mirrored that stale entry on every pull.
  const b = shared;
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
  const db = openBrokerDb(b.dbPath);
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
}, 30_000);

test("the three replication routes are refused on a token-bearing broker that does not serve replicas", async () => {
  // A broker_token is what a broker gives its own agents and Decks; it is not a
  // declaration that this broker is somebody's upstream. Without serve_replicas
  // the three routes are refused even to a caller holding the right Bearer --
  // and the refusal NAMES the flag, so the operator does not go hunting for a
  // credential he already has.
  const upstream = shared;
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
}, 30_000);

test("with NEITHER the role nor a token, the role refusal is the one answered", async () => {
  // Both guards fire on this deployment, so only their ORDER decides what the
  // operator reads. It is pinned here rather than left to whichever guard the
  // handler happens to call first: taking the role first means the answer names
  // the decision to make (be an upstream at all) before the credential that
  // decision would need, and an operator told to configure a token for routes
  // he never meant to serve would be following the wrong instruction.
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
}, 30_000);

test("a replica cannot sign a write with another replica's provenance, nor with the sweep's", async () => {
  // The relay prefix is what a reader trusts to answer "whose operator wrote
  // this": a replica free to send `via:<someone else>:deck` writes as the
  // OTHER machine's operator, and the victim replica -- which strips its own
  // prefix on the way in -- displays it as its own operator's work. The sweep's
  // name is the same kind of claim: it is what unlocks the one auto-resolution
  // a replica performs without asking.
  const b = shared;
  const own = `via:${R1.slice(0, 8)}:`;
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
}, 30_000);

test("a replica broker refuses to serve the upstream sync routes, and answers status in every mode", async () => {
  const upstream = shared;
  const replica = deadReplica;
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
}, 30_000);

test("context document sync routes require the upstream serving role", async () => {
  const b = noRole;
  const document = syncDocument("document-sync-role", [{
    id: "unit-sync-role",
    source_target: "body",
    raw: "role guard",
    deported_at: "2026-09-23T14:00:00.000Z",
    position: 0,
  }]);
  const pullResponse = await post<{ error?: string }>(`${b.url}/roadmap/context-document/sync/pull`, {
    replica_id: R1,
    since_rev: 0,
  });
  const pushResponse = await post<{ error?: string }>(`${b.url}/roadmap/context-document/sync/push`, {
    replica_id: R1,
    document,
  });
  expect([pullResponse.status, pushResponse.status]).toEqual([403, 403]);
}, 30_000);

test("a replicated document arriving for a card does not date it", async () => {
  const b = shared;
  const dated = "2026-03-01T00:00:00.000Z";
  const pushed = await post<RoadmapSyncPushResponse>(`${b.url}/roadmap/sync/push`, {
    replica_id: R1,
    item: pushItem({ id: "card-document-undated", content_updated_at: dated }),
    expected_content_rev: null,
  });
  expect(pushed.status).toBe(200);
  const document = syncDocument("document-for-dated-card", documentUnits("dated-card", 1, "replicated unit"));
  const arrival = await post<RoadmapContextDocumentSyncPushResponse>(`${b.url}/roadmap/context-document/sync/push`, {
    replica_id: R1,
    document: { ...document, roadmap_item_id: "card-document-undated" },
  });
  expect(arrival.status).toBe(200);
  const list = await post<{ items: RoadmapItem[] }>(`${b.url}/roadmap/list`, { project_key: PK });
  expect(list.body.items.find((i) => i.id === "card-document-undated")!.content_updated_at).toBe(dated);
}, 20_000);

test("context document sync accepts only an exact immutable repeat", async () => {
  const b = shared;
  const firstUnit = {
    id: "unit-sync-first",
    source_target: "body",
    raw: "first immutable unit",
    deported_at: "2026-09-23T14:00:00.000Z",
    position: 0,
  };
  const document = syncDocument("document-sync-direct", [firstUnit]);
  const inserted = await post<RoadmapContextDocumentSyncPushResponse>(
    `${b.url}/roadmap/context-document/sync/push`,
    { replica_id: R1, document },
  );
  expect([
    "the document insert keeps an unknown CLI author unchanged",
    inserted.status,
    inserted.body.document.created_by,
    inserted.body.document.units.map((unit) => unit.id),
  ]).toEqual([
    "the document insert keeps an unknown CLI author unchanged",
    200,
    "cli:document-host:document-user",
    ["unit-sync-first"],
  ]);

  const secondUnit = {
    id: "unit-sync-second",
    source_target: "2026-09-23T14:00:01.000Z",
    raw: "second immutable unit",
    deported_at: "2026-09-23T14:00:00.000Z",
    position: 1,
  };
  const repeated = await post<RoadmapContextDocumentSyncPushResponse>(
    `${b.url}/roadmap/context-document/sync/push`,
    { replica_id: R1, document },
  );
  const expanded = { ...document, units: [firstUnit, secondUnit] };
  const updated = await post<{ error?: string }>(
    `${b.url}/roadmap/context-document/sync/push`,
    { replica_id: R1, document: expanded },
  );
  expect([
    "exact duplicate delivery succeeds but an existing document refuses a new unit",
    repeated.status,
    repeated.body.document.units.map((unit) => unit.id),
    updated.status,
  ]).toEqual([
    "exact duplicate delivery succeeds but an existing document refuses a new unit",
    200,
    ["unit-sync-first"],
    409,
  ]);

  const conflict = await post<{ error?: string }>(`${b.url}/roadmap/context-document/sync/push`, {
    replica_id: R1,
    document: { ...document, units: [{ ...firstUnit, raw: "forged replacement" }] },
  });
  expect([
    "an existing unit id with different immutable text is rejected",
    conflict.status,
    conflict.body.error?.includes("different immutable unit set"),
  ]).toEqual(["an existing unit id with different immutable text is rejected", 409, true]);

  const pulled = await post<RoadmapContextDocumentSyncPullResponse>(
    `${b.url}/roadmap/context-document/sync/pull`,
    { replica_id: R2, since_rev: 0 },
  );
  expect([
    "pull returns the original immutable unit set",
    pulled.status,
    pulled.body.documents.find((candidate) => candidate.id === document.id)?.units.map((unit) => unit.id),
  ]).toEqual([
    "pull returns the original immutable unit set",
    200,
    ["unit-sync-first"],
  ]);
}, 30_000);

test("context document sync relays a deck author and refuses a foreign relay", async () => {
  const b = shared;
  const document = syncDocument("document-sync-author", [{
    id: "unit-sync-author",
    source_target: "body",
    raw: "author provenance",
    deported_at: "2026-09-23T14:00:00.000Z",
    position: 0,
  }]);
  const deck = await post<RoadmapContextDocumentSyncPushResponse>(
    `${b.url}/roadmap/context-document/sync/push`,
    { replica_id: R1, document: { ...document, created_by: "deck" } },
  );
  const foreign = await post<{ error?: string }>(
    `${b.url}/roadmap/context-document/sync/push`,
    { replica_id: R1, document: { ...document, id: "document-sync-foreign", created_by: "via:otherrep:x" } },
  );
  expect([deck.status, deck.body.document.created_by, foreign.status]).toEqual([200, "via:replica-:deck", 400]);
}, 30_000);

test("context document sync push refuses a miscased project_key, ASCII or not, and stores the lowercase one", async () => {
  const b = shared;
  const unit = {
    id: "unit-sync-case",
    source_target: "body",
    raw: "case guard",
    deported_at: "2026-09-23T14:00:00.000Z",
    position: 0,
  };
  for (const [miscased, lower] of [
    ["github.com/VOCSAP/sync-routes-repo", "github.com/vocsap/sync-routes-repo"],
    ["github.com/acme/Élan", "github.com/acme/élan"],
  ]) {
    const refused = await post<{ error?: string }>(`${b.url}/roadmap/context-document/sync/push`, {
      replica_id: R1,
      document: { ...syncDocument(`document-case-${lower!.length}`, [unit]), project_key: miscased },
    });
    expect([miscased, refused.status]).toEqual([miscased, 400]);
    expect(refused.body.error).toContain(lower!);
  }
  const db = openBrokerDb(b.dbPath, { readonly: true });
  try {
    const row = db
      .query("SELECT COUNT(*) AS n FROM roadmap_context_documents WHERE id LIKE 'document-case-%'")
      .get() as { n: number };
    expect(row.n, "no document stored under a miscased key").toBe(0);
  } finally {
    db.close();
  }
  const stored = await post<RoadmapContextDocumentSyncPushResponse>(`${b.url}/roadmap/context-document/sync/push`, {
    replica_id: R1,
    document: syncDocument("document-case-lower", [unit]),
  });
  expect(stored.status).toBe(200);
}, 30_000);

test("context document sync rejects malformed immutable unit shape", async () => {
  const b = shared;
  const unit = {
    id: "unit-sync-shape",
    source_target: "body",
    raw: "valid",
    deported_at: "2026-09-23T14:00:00.000Z",
    position: 0,
  };
  const rawNul = await post<{ error?: string }>(
    `${b.url}/roadmap/context-document/sync/push`,
    { replica_id: R1, document: syncDocument("document-sync-nul", [{ ...unit, raw: `bad${String.fromCharCode(0)}text` }]) },
  );
  const sourceTarget = await post<{ error?: string }>(
    `${b.url}/roadmap/context-document/sync/push`,
    { replica_id: R1, document: syncDocument("document-sync-target", [{ ...unit, id: "unit-sync-target", source_target: "not-a-timestamp" }]) },
  );
  const positions = await post<{ error?: string }>(
    `${b.url}/roadmap/context-document/sync/push`,
    { replica_id: R1, document: syncDocument("document-sync-position", [{ ...unit, id: "unit-sync-position", position: 1 }]) },
  );
  expect([rawNul.status, sourceTarget.status, positions.status]).toEqual([400, 400, 400]);
}, 30_000);

test("context document sync rejects more than 64 immutable units", async () => {
  const b = shared;
  const response = await post<{ error?: string }>(
    `${b.url}/roadmap/context-document/sync/push`,
    {
      replica_id: R1,
      document: syncDocument("document-sync-unit-count", documentUnits("unit-count", 65, "x")),
    },
  );
  expect([response.status, response.body.error?.includes("64")]).toEqual([400, true]);
}, 30_000);

test("context document sync rejects immutable units whose total raw text exceeds 65536 characters", async () => {
  const b = shared;
  const response = await post<{ error?: string }>(
    `${b.url}/roadmap/context-document/sync/push`,
    {
      replica_id: R1,
      document: syncDocument("document-sync-total-size", documentUnits("total-size", 5, "x".repeat(15_000))),
    },
  );
  expect([response.status, response.body.error?.includes("65536")]).toEqual([400, true]);
}, 30_000);

test("local deportation refuses more than 64 selected units without changing the context", async () => {
  const b = shared;
  const source = documentableContext(65, "x");
  const created = await post<UpsertRes>(`${b.url}/roadmap/upsert`, {
    project_key: PK,
    by: "agent-local",
    title: "local unit count cap",
    context: source.context,
  });
  const refused = await post<{ error?: string }>(`${b.url}/roadmap/context-document/deport`, {
    id: created.body.item.id,
    project_key: PK,
    by: "agent-local",
    targets: source.targets,
  });
  const db = openBrokerDb(b.dbPath, { readonly: true });
  try {
    const stored = db.query("SELECT context FROM roadmap_items WHERE id = ?").get(created.body.item.id) as { context: string };
    const documents = db.query("SELECT COUNT(*) AS n FROM roadmap_context_documents WHERE roadmap_item_id = ?")
      .get(created.body.item.id) as { n: number };
    expect([refused.status, refused.body.error?.includes("64"), stored.context, documents.n]).toEqual([
      400,
      true,
      source.context,
      0,
    ]);
  } finally {
    db.close();
  }
}, 30_000);

test("local deportation refuses raw document text above 65536 characters without changing the context", async () => {
  const b = shared;
  const source = documentableContext(5, "x".repeat(15_000));
  const created = await post<UpsertRes>(`${b.url}/roadmap/upsert`, {
    project_key: PK,
    by: "agent-local",
    title: "local total size cap",
    context: source.context,
  });
  const refused = await post<{ error?: string }>(`${b.url}/roadmap/context-document/deport`, {
    id: created.body.item.id,
    project_key: PK,
    by: "agent-local",
    targets: source.targets,
  });
  const db = openBrokerDb(b.dbPath, { readonly: true });
  try {
    const stored = db.query("SELECT context FROM roadmap_items WHERE id = ?").get(created.body.item.id) as { context: string };
    const documents = db.query("SELECT COUNT(*) AS n FROM roadmap_context_documents WHERE roadmap_item_id = ?")
      .get(created.body.item.id) as { n: number };
    expect([refused.status, refused.body.error?.includes("65536"), stored.context, documents.n]).toEqual([
      400,
      true,
      source.context,
      0,
    ]);
  } finally {
    db.close();
  }
}, 30_000);

test("context document sync accepts a unit wider than the roadmap context cap and stores its text whole", async () => {
  const b = shared;
  const raw = "x".repeat(16_001);
  const response = await post<RoadmapContextDocumentSyncPushResponse>(
    `${b.url}/roadmap/context-document/sync/push`,
    {
      replica_id: R1,
      document: syncDocument("document-sync-cap", [{
        id: "unit-sync-cap",
        source_target: "body",
        raw,
        deported_at: "2026-09-23T14:00:00.000Z",
        position: 0,
      }]),
    },
  );
  expect([response.status, response.body.document.units.map((unit) => unit.raw === raw)]).toEqual([200, [true]]);
}, 30_000);

test("context document sync rejects every valid immutable-field divergence", async () => {
  const b = shared;
  const [bodyUnit, appendUnit] = documentUnits("immutable-field", 2, "original");
  const document = syncDocument("document-sync-immutable-fields", [bodyUnit!, appendUnit!]);
  const inserted = await post<RoadmapContextDocumentSyncPushResponse>(
    `${b.url}/roadmap/context-document/sync/push`,
    { replica_id: R1, document },
  );
  expect(inserted.status).toBe(200);

  const cases: readonly [string, RoadmapContextDocument][] = [
    ["roadmap_item_id", { ...document, roadmap_item_id: "card-document-sync-other" }],
    ["project_key", { ...document, project_key: "github.com/vocsap/other-sync-routes-repo" }],
    ["created_by", { ...document, created_by: "cli:other-host:other-user" }],
    ["created_at", { ...document, created_at: "2026-09-23T14:00:01.000Z" }],
    [
      "source_target",
      { ...document, units: [{ ...bodyUnit!, source_target: "2026-09-23T14:00:02.000Z" }, appendUnit!] },
    ],
    [
      "deported_at",
      { ...document, units: [{ ...bodyUnit!, deported_at: "2026-09-23T14:00:01.000Z" }, appendUnit!] },
    ],
    [
      "position",
      { ...document, units: [{ ...bodyUnit!, position: 1 }, { ...appendUnit!, position: 0 }] },
    ],
  ];
  for (const [field, divergent] of cases) {
    const refused = await post<{ error?: string }>(`${b.url}/roadmap/context-document/sync/push`, {
      replica_id: R1,
      document: divergent,
    });
    expect([field, refused.status]).toEqual([field, 409]);
  }
}, 30_000);

test("resolve requires the same author proof as any other Deck roadmap write", async () => {
  const replica = deadReplica;
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
}, 20_000);

// ----- /roadmap/sync/queue-delta -----

type DeltaBody = Partial<RoadmapQueueDeltaResponse> &
  Partial<RoadmapQueueDeltaConflict> & { error?: string; op_index?: number; item_id?: string };
type QueueRows = Array<[string, number]>;

/** One project per test: the queue revision is per project, so tests on the shared upstream never meet. */
function queueProject(name: string): string {
  return `${PK}-qd-${name}`;
}

async function seedQueue(b: TestBroker, project: string, cards: Array<[string, number | null]>): Promise<void> {
  for (const [id, queue] of cards) {
    const res = await post(`${b.url}/roadmap/sync/push`, {
      replica_id: R1,
      item: pushItem({ id, project_key: project, queue }),
      expected_content_rev: null,
    });
    expect([id, res.status]).toEqual([id, 200]);
  }
}

async function queueRevOf(b: TestBroker, project: string): Promise<number> {
  const page = await pull(b, 0, 1);
  return page.body.queue_revs?.[project] ?? 0;
}

function storedQueue(b: TestBroker, project: string): QueueRows {
  const db = openBrokerDb(b.dbPath, { readonly: true });
  try {
    return (
      db
        .query("SELECT id, queue FROM roadmap_items WHERE project_key = ? AND queue IS NOT NULL ORDER BY queue, id")
        .all(project) as { id: string; queue: number }[]
    ).map((row) => [row.id, row.queue]);
  } finally {
    db.close();
  }
}

function receiptCount(b: TestBroker, project: string): number {
  const db = openBrokerDb(b.dbPath, { readonly: true });
  try {
    return (
      db.query("SELECT COUNT(*) AS n FROM roadmap_queue_receipts WHERE project_key = ?").get(project) as { n: number }
    ).n;
  } finally {
    db.close();
  }
}

function sendDelta(
  b: TestBroker,
  project: string,
  expected: number,
  ops: unknown,
  over: { mutation_id?: string; replica_id?: string } = {}
) {
  return post<DeltaBody>(`${b.url}/roadmap/sync/queue-delta`, {
    replica_id: over.replica_id ?? R1,
    project_key: project,
    mutation_id: over.mutation_id ?? crypto.randomUUID(),
    expected_queue_rev: expected,
    ops,
  });
}

test("queue-delta: a rank move depends on the queue revision alone, not on the content revision of the cards it moves", async () => {
  const b = shared;
  const project = queueProject("content");
  const [a, c, d] = ["qd-content-a", "qd-content-c", "qd-content-d"];
  await seedQueue(b, project, [[a, 1], [c, 2], [d, 3]]);
  const edited = await post<UpsertRes>(
    `${b.url}/roadmap/upsert`,
    deckAuthored({ project_key: project, id: d, title: "edited upstream after the replica read it" })
  );
  expect(edited.status).toBe(200);
  const before = await queueRevOf(b, project);
  const queueBefore = storedQueue(b, project);
  expect(queueBefore.map(([id]) => id).sort()).toEqual([a, c, d]);

  const res = await sendDelta(b, project, before, [{ op: "place", ids: [d], at: "start" }]);

  expect(res.status).toBe(200);
  expect(res.body.replayed).toBe(false);
  expect(storedQueue(b, project)).toEqual([[d, 1], [a, 2], [c, 3]]);
  expect(res.body.queue_rev).toBeGreaterThan(before);
  expect(res.body.queue_rev).toBe(await queueRevOf(b, project));
  expect(res.body.items?.map((row) => [row.id, row.queue]).sort()).toEqual([[a, 2], [c, 3], [d, 1]]);
  expect(res.body.items?.map((row) => row.updated_by)).toEqual(Array(3).fill(`via:${R1.slice(0, 8)}:deck`));
}, 20_000);

test("queue-delta: a retry after a lost response returns the stored receipt and applies nothing twice", async () => {
  const b = shared;
  const project = queueProject("retry");
  const [a, c] = ["qd-retry-a", "qd-retry-c"];
  await seedQueue(b, project, [[a, 1], [c, 2]]);
  const base = await queueRevOf(b, project);
  const mutation_id = crypto.randomUUID();
  const ops = [{ op: "remove", ids: [a] }];

  const first = await sendDelta(b, project, base, ops, { mutation_id });
  expect(first.status).toBe(200);
  expect(first.body.replayed).toBe(false);
  const settled = await queueRevOf(b, project);
  expect(settled).toBe(first.body.queue_rev!);

  // The base this request names is stale now (its own commit moved it), and the
  // operation could not apply a second time: only the receipt can answer.
  const retry = await sendDelta(b, project, base, ops, { mutation_id });
  expect(retry.status).toBe(200);
  expect(retry.body.replayed).toBe(true);
  expect(retry.body.payload_hash).toBe(first.body.payload_hash);
  expect(retry.body.queue_rev).toBe(first.body.queue_rev);
  expect(retry.body.items?.map((row) => row.id)).toEqual(first.body.items?.map((row) => row.id));
  expect(await queueRevOf(b, project)).toBe(settled);
  expect(storedQueue(b, project)).toEqual([[c, 1]]);
  expect(receiptCount(b, project)).toBe(1);
}, 20_000);

test("queue-delta: a receipt belongs to its replica and project: the same mutation id elsewhere is a new mutation", async () => {
  const b = shared;
  const project = queueProject("scope");
  const [a, c] = ["qd-scope-a", "qd-scope-c"];
  await seedQueue(b, project, [[a, 1], [c, 2]]);
  const mutation_id = crypto.randomUUID();

  const first = await sendDelta(b, project, await queueRevOf(b, project), [{ op: "remove", ids: [a] }], { mutation_id });
  expect(first.status).toBe(200);
  const other = await sendDelta(b, project, await queueRevOf(b, project), [{ op: "remove", ids: [c] }], {
    mutation_id,
    replica_id: R2,
  });

  expect([other.status, other.body.replayed]).toEqual([200, false]);
  expect(storedQueue(b, project)).toEqual([]);
}, 20_000);

test("queue-delta: the same mutation id with another payload is refused and changes nothing", async () => {
  const b = shared;
  const project = queueProject("reuse");
  const [a, c] = ["qd-reuse-a", "qd-reuse-c"];
  await seedQueue(b, project, [[a, 1], [c, 2]]);
  const base = await queueRevOf(b, project);
  const mutation_id = crypto.randomUUID();
  const first = await sendDelta(b, project, base, [{ op: "place", ids: [a], at: "end" }], { mutation_id });
  expect(first.status).toBe(200);
  const queueAfterFirst = storedQueue(b, project);
  const revAfterFirst = await queueRevOf(b, project);

  const reused = await sendDelta(b, project, base, [{ op: "place", ids: [c], at: "end" }], { mutation_id });

  expect(reused.status).toBe(409);
  expect(reused.body.reason).toBe("mutation_reused");
  expect(storedQueue(b, project)).toEqual(queueAfterFirst);
  expect(await queueRevOf(b, project)).toBe(revAfterFirst);
  expect(receiptCount(b, project)).toBe(1);
}, 20_000);

test("queue-delta: a stale base is refused with the current revision, writes no receipt, and the mutation can be sent again on the new base", async () => {
  const b = shared;
  const project = queueProject("stale");
  const [a, c, d] = ["qd-stale-a", "qd-stale-c", "qd-stale-d"];
  await seedQueue(b, project, [[a, 1], [c, 2]]);
  const stale = await queueRevOf(b, project);
  const third = await post(`${b.url}/roadmap/sync/push`, {
    replica_id: R2,
    item: pushItem({ id: d, project_key: project, queue: 3 }),
    expected_content_rev: null,
  });
  expect(third.status).toBe(200);
  const current = await queueRevOf(b, project);
  expect(current).toBeGreaterThan(stale);
  const queueBefore = storedQueue(b, project);
  const mutation_id = crypto.randomUUID();

  const refused = await sendDelta(b, project, stale, [{ op: "place", ids: [a], at: "end" }], { mutation_id });

  expect(refused.status).toBe(409);
  expect(refused.body).toMatchObject({ error: "conflict", reason: "queue_rev", queue_rev: current });
  expect(storedQueue(b, project)).toEqual(queueBefore);
  expect(receiptCount(b, project)).toBe(0);
  const again = await sendDelta(b, project, current, [{ op: "place", ids: [a], at: "end" }], { mutation_id });
  expect([again.status, again.body.replayed]).toEqual([200, false]);
  expect(storedQueue(b, project)).toEqual([[c, 1], [d, 2], [a, 3]]);
}, 20_000);

test("queue-delta: a card the project does not have is a 404 naming it, and nothing is written or receipted", async () => {
  const b = shared;
  const project = queueProject("atomic");
  const [a, c, d] = ["qd-atomic-a", "qd-atomic-c", "qd-atomic-d"];
  await seedQueue(b, project, [[a, 1], [c, 2], [d, 3]]);
  const base = await queueRevOf(b, project);
  const queueBefore = storedQueue(b, project);

  const refused = await sendDelta(b, project, base, [
    { op: "place", ids: [a], at: "end" },
    { op: "join", ids: [c], anchor: "qd-atomic-not-a-card" },
  ]);
  const unknown = await sendDelta(b, project, base, [{ op: "remove", ids: [a, "qd-atomic-no-such-card"] }]);

  expect([refused.status, refused.body.item_id]).toEqual([404, "qd-atomic-not-a-card"]);
  expect([unknown.status, unknown.body.item_id]).toEqual([404, "qd-atomic-no-such-card"]);
  expect(storedQueue(b, project)).toEqual(queueBefore);
  expect(await queueRevOf(b, project)).toBe(base);
  expect(receiptCount(b, project)).toBe(0);
}, 20_000);

test("queue-delta: an anchor that exists but is not queued is refused with the operation index, whole delta unapplied", async () => {
  const b = shared;
  const project = queueProject("anchor");
  const [a, c, off] = ["qd-anchor-a", "qd-anchor-c", "qd-anchor-off"];
  await seedQueue(b, project, [[a, 1], [c, 2], [off, null]]);
  const base = await queueRevOf(b, project);
  const queueBefore = storedQueue(b, project);

  const refused = await sendDelta(b, project, base, [
    { op: "place", ids: [a], at: "end" },
    { op: "place", ids: [c], before: off },
  ]);

  expect(refused.status).toBe(400);
  expect([refused.body.op_index, refused.body.item_id]).toEqual([1, off]);
  expect(storedQueue(b, project)).toEqual(queueBefore);
  expect(await queueRevOf(b, project)).toBe(base);
}, 20_000);

test("queue-delta: a directive cannot share a wave, a done card cannot be queued, an inactive one is a 403", async () => {
  const b = shared;
  const project = queueProject("rules");
  const [a, dir, done, off] = ["qd-rules-a", "qd-rules-dir", "qd-rules-done", "qd-rules-off"];
  await seedQueue(b, project, [[a, 1]]);
  for (const extra of [
    pushItem({ id: dir, project_key: project, kind: "directive", directive: "clear", queue: 2 }),
    pushItem({ id: done, project_key: project, status: "done", queue: null }),
    pushItem({ id: off, project_key: project, inactive: true, queue: null }),
  ]) {
    const res = await post(`${b.url}/roadmap/sync/push`, { replica_id: R1, item: extra, expected_content_rev: null });
    expect([extra.id, res.status]).toEqual([extra.id, 200]);
  }
  const base = await queueRevOf(b, project);
  const queueBefore = storedQueue(b, project);

  const joined = await sendDelta(b, project, base, [{ op: "join", ids: [a], anchor: dir }]);
  const finished = await sendDelta(b, project, base, [{ op: "place", ids: [done], at: "end" }]);
  const inactive = await sendDelta(b, project, base, [{ op: "place", ids: [off], at: "end" }]);

  expect([joined.status, joined.body.item_id]).toEqual([400, dir]);
  expect([finished.status, finished.body.item_id]).toEqual([400, done]);
  expect([inactive.status, inactive.body.item_id]).toEqual([403, off]);
  expect(storedQueue(b, project)).toEqual(queueBefore);
}, 30_000);

test("queue-delta: a fault while the receipt is written rolls the whole mutation back, then the retry applies it", async () => {
  const b = shared;
  const project = queueProject("fault");
  const [a, c] = ["qd-fault-a", "qd-fault-c"];
  await seedQueue(b, project, [[a, 1], [c, 2]]);
  const base = await queueRevOf(b, project);
  const queueBefore = storedQueue(b, project);
  const mutation_id = crypto.randomUUID();
  const ops = [{ op: "place", ids: [c], at: "start" }];
  const trigger = `zz_fault_${project.replace(/[^a-z0-9]/g, "_")}`;
  const db = openBrokerDb(b.dbPath);
  db.run(
    `CREATE TRIGGER ${trigger} BEFORE INSERT ON roadmap_queue_receipts WHEN new.project_key = '${project}'
     BEGIN SELECT RAISE(ABORT, 'receipt fault'); END`
  );
  try {
    const failed = await sendDelta(b, project, base, ops, { mutation_id });

    expect(failed.status).toBe(500);
    expect(storedQueue(b, project)).toEqual(queueBefore);
    expect(await queueRevOf(b, project)).toBe(base);
  } finally {
    db.run(`DROP TRIGGER IF EXISTS ${trigger}`);
    db.close();
  }

  const retried = await sendDelta(b, project, base, ops, { mutation_id });
  expect([retried.status, retried.body.replayed]).toEqual([200, false]);
  expect(storedQueue(b, project)).toEqual([[c, 1], [a, 2]]);
}, 30_000);

test("queue-delta: a queue of 520 cards is rearranged in one transaction, with no cap on the queue", async () => {
  const b = shared;
  const project = queueProject("big");
  const ids = Array.from({ length: 520 }, (_, i) => `qd-big-${String(i).padStart(3, "0")}`);
  const db = openBrokerDb(b.dbPath);
  try {
    db.transaction(() => {
      ids.forEach((id, i) => {
        db.run(
          "INSERT INTO roadmap_items (id, project_key, kind, title, created_at, updated_at, queue, lot_id) VALUES (?, ?, 'feature', 'big', 'x', 'x', ?, 'default')",
          [id, project, i + 1]
        );
      });
    })();
  } finally {
    db.close();
  }
  const base = await queueRevOf(b, project);
  expect(base).toBeGreaterThanOrEqual(520);

  const res = await sendDelta(b, project, base, [{ op: "place", ids: [ids[519]!], at: "start" }]);

  expect(res.status).toBe(200);
  const queue = storedQueue(b, project);
  expect(queue).toHaveLength(520);
  expect(queue[0]).toEqual([ids[519]!, 1]);
  expect(queue[1]).toEqual([ids[0]!, 2]);
  expect(queue[519]).toEqual([ids[518]!, 520]);
  expect(res.body.items).toHaveLength(520);

  const cleared = await sendDelta(b, project, res.body.queue_rev!, [{ op: "clear" }]);
  expect(cleared.status).toBe(200);
  expect(storedQueue(b, project)).toEqual([]);
  expect(cleared.body.items).toHaveLength(520);
}, 60_000);

test("queue-delta: a card work-locked by another relay refuses the whole delta, a card that only takes a new number does not", async () => {
  const b = shared;
  const project = queueProject("lock");
  const [a, c, d] = ["qd-lock-a", "qd-lock-c", "qd-lock-d"];
  await seedQueue(b, project, [[a, 1], [c, 2], [d, 3]]);
  const claim = await post<RoadmapSyncLockClaimResponse>(`${b.url}/roadmap/sync/lock`, {
    replica_id: R2,
    id: c,
    action: "claim",
    owner: { peer_id: "agent-lock-owner", group_id: null },
  });
  expect(claim.status).toBe(200);
  const base = await queueRevOf(b, project);
  const queueBefore = storedQueue(b, project);

  const refused = await sendDelta(b, project, base, [
    { op: "place", ids: [d], at: "start" },
    { op: "remove", ids: [c] },
  ]);

  expect(refused.status).toBe(409);
  expect(refused.body).toMatchObject({ reason: "locked_upstream", item_id: c, queue_rev: base });
  expect(storedQueue(b, project)).toEqual(queueBefore);
  expect(receiptCount(b, project)).toBe(0);

  const renumbered = await sendDelta(b, project, base, [{ op: "place", ids: [d], at: "start" }]);
  expect(renumbered.status).toBe(200);
  expect(storedQueue(b, project)).toEqual([[d, 1], [a, 2], [c, 3]]);

  const holder = await sendDelta(b, project, renumbered.body.queue_rev!, [{ op: "remove", ids: [c] }], { replica_id: R2 });
  expect(holder.status).toBe(200);
  expect(storedQueue(b, project)).toEqual([[d, 1], [a, 2]]);

  const requeued = await sendDelta(b, project, holder.body.queue_rev!, [{ op: "place", ids: [c], at: "end" }]);
  expect([requeued.status, requeued.body.item_id]).toEqual([409, c]);
}, 30_000);

test("queue-delta: a clear that would unqueue a card locked by another relay is refused", async () => {
  const b = shared;
  const project = queueProject("lockclear");
  const [a, c] = ["qd-lockclear-a", "qd-lockclear-c"];
  await seedQueue(b, project, [[a, 1], [c, 2]]);
  const claim = await post(`${b.url}/roadmap/sync/lock`, {
    replica_id: R2,
    id: a,
    action: "claim",
    owner: { peer_id: "agent-lockclear-owner", group_id: null },
  });
  expect(claim.status).toBe(200);
  const base = await queueRevOf(b, project);

  const refused = await sendDelta(b, project, base, [{ op: "clear" }]);

  expect(refused.status).toBe(409);
  expect(refused.body).toMatchObject({ reason: "locked_upstream", item_id: a });
  expect(storedQueue(b, project)).toHaveLength(2);
}, 20_000);

test("queue-delta: a done card that kept a rank is outside the queue: never renumbered, rewritten, receipted or removable", async () => {
  const b = shared;
  const project = queueProject("done");
  const [a, dir, done] = ["qd-done-a", "qd-done-dir", "qd-done-x"];
  await seedQueue(b, project, [[a, 1]]);
  for (const item of [
    pushItem({ id: dir, project_key: project, kind: "directive", directive: "clear", queue: 2 }),
    pushItem({ id: done, project_key: project, queue: 2 }),
  ]) {
    const res = await post(`${b.url}/roadmap/sync/push`, { replica_id: R1, item, expected_content_rev: null });
    expect([item.id, res.status]).toEqual([item.id, 200]);
  }
  // A card finished through a direct write keeps its rank, sharing wave 2 with the directive.
  const direct = openBrokerDb(b.dbPath);
  try {
    direct.run("UPDATE roadmap_items SET status = 'done' WHERE id = ?", [done]);
  } finally {
    direct.close();
  }
  const doneRow = (): unknown => {
    const db = openBrokerDb(b.dbPath, { readonly: true });
    try {
      return db.query("SELECT queue, rev, updated_by, updated_at, status FROM roadmap_items WHERE id = ?").get(done);
    } finally {
      db.close();
    }
  };
  const untouched = doneRow();
  expect(untouched).toMatchObject({ queue: 2, status: "done" });
  const base = await queueRevOf(b, project);

  const moved = await sendDelta(b, project, base, [{ op: "place", ids: [dir], at: "start" }]);

  expect(moved.status).toBe(200);
  expect(moved.body.items?.map((row) => row.id).sort()).toEqual([a, dir]);
  expect(storedQueue(b, project)).toEqual([[dir, 1], [a, 2], [done, 2]]);
  expect(doneRow()).toEqual(untouched);

  const removal = await sendDelta(b, project, moved.body.queue_rev!, [{ op: "remove", ids: [done] }]);
  expect([removal.status, removal.body.item_id, removal.body.op_index]).toEqual([400, done, 0]);
  expect(doneRow()).toEqual(untouched);
}, 30_000);

test("queue-delta: a receipt keeps which cards moved, never their rows, and a replay answers with the current rows", async () => {
  const b = shared;
  const project = queueProject("receipt");
  const [a, c] = ["qd-receipt-a", "qd-receipt-c"];
  for (const [id, queue] of [[a, 1], [c, 2]] as const) {
    const res = await post(`${b.url}/roadmap/sync/push`, {
      replica_id: R1,
      item: pushItem({ id, project_key: project, queue, description: `RECEIPT-BODY-${"x".repeat(3000)}`, context: "y".repeat(3000) }),
      expected_content_rev: null,
    });
    expect([id, res.status]).toEqual([id, 200]);
  }
  const base = await queueRevOf(b, project);
  const mutation_id = crypto.randomUUID();
  const ops = [{ op: "place", ids: [c], at: "start" }];

  const first = await sendDelta(b, project, base, ops, { mutation_id });

  expect(first.status).toBe(200);
  expect(first.body.items?.map((row) => row.description.slice(0, 12))).toEqual(["RECEIPT-BODY", "RECEIPT-BODY"]);
  const db = openBrokerDb(b.dbPath, { readonly: true });
  let stored: string;
  try {
    stored = (
      db.query("SELECT response FROM roadmap_queue_receipts WHERE project_key = ?").get(project) as { response: string }
    ).response;
  } finally {
    db.close();
  }
  const receipt = JSON.parse(stored) as { changes: Record<string, unknown>[] };
  expect(Object.keys(receipt).sort()).toEqual(["changes", "mutation_id", "payload_hash", "queue_rev"]);
  expect(receipt.changes.map((change) => Object.keys(change).sort().join(","))).toEqual(["id,queue,rev", "id,queue,rev"]);
  expect(stored).not.toContain("RECEIPT-BODY");
  expect(stored.length).toBeLessThan(600);

  const edited = await post<UpsertRes>(
    `${b.url}/roadmap/upsert`,
    deckAuthored({ project_key: project, id: a, title: "edited after the receipt was written" })
  );
  expect(edited.status).toBe(200);
  const replay = await sendDelta(b, project, base, ops, { mutation_id });

  expect([replay.status, replay.body.replayed, replay.body.queue_rev]).toEqual([200, true, first.body.queue_rev]);
  expect(replay.body.items?.find((row) => row.id === a)?.title).toBe("edited after the receipt was written");
}, 30_000);

test("queue revision: every writer of the rank moves the project's revision and only the project's", async () => {
  const b = shared;
  const bystander = queueProject("bystander");
  await seedQueue(b, bystander, [["qd-bystander-a", 1]]);
  const bystanderRev = await queueRevOf(b, bystander);
  expect(bystanderRev).toBeGreaterThan(0);

  const sql = (run: (db: ReturnType<typeof openBrokerDb>) => void) => async () => {
    const db = openBrokerDb(b.dbPath);
    try {
      run(db);
    } finally {
      db.close();
    }
  };
  const writers: Array<[string, (project: string, id: string) => Promise<unknown>]> = [
    ["an upsert creating a queued card", (p) => post(`${b.url}/roadmap/upsert`, deckAuthored({ project_key: p, title: "queued", queue: 7 }))],
    ["an upsert changing the rank", (p, id) => post(`${b.url}/roadmap/upsert`, deckAuthored({ project_key: p, id, queue: 4 }))],
    ["an upsert to a terminal status", (p, id) => post(`${b.url}/roadmap/upsert`, deckAuthored({ project_key: p, id, status: "done" }))],
    ["an archive", (_p, id) => post(`${b.url}/roadmap/archive`, deckAuthored({ id }))],
    ["a reorder", (p, id) => post(`${b.url}/roadmap/reorder`, deckAuthored({ project_key: p, ids: [id], waves: [[id]] }))],
    ["a clearing reorder", (p) => post(`${b.url}/roadmap/reorder`, deckAuthored({ project_key: p, ids: [], waves: [] }))],
    [
      "a replica push carrying a rank",
      (p) =>
        post(`${b.url}/roadmap/sync/push`, {
          replica_id: R1,
          item: pushItem({ id: `qd-writers-pushed-${crypto.randomUUID().slice(0, 8)}`, project_key: p, queue: 9 }),
          expected_content_rev: null,
        }),
    ],
    ["a direct UPDATE of the column", (_p, id) => sql((db) => db.run("UPDATE roadmap_items SET queue = 5 WHERE id = ?", [id]))()],
    // The revision a pull serves is the default lot's: leaving it is a change of that queue.
    ["a direct move to another lot", (_p, id) => sql((db) => db.run("UPDATE roadmap_items SET lot_id = 'qd-other-lot' WHERE id = ?", [id]))()],
    ["a direct UPDATE to NULL", (_p, id) => sql((db) => db.run("UPDATE roadmap_items SET queue = NULL WHERE id = ?", [id]))()],
    [
      "an INSERT OR REPLACE dropping a queued card's rank",
      (p, id) =>
        sql((db) =>
          db.run("INSERT OR REPLACE INTO roadmap_items (id, project_key, kind, title, created_at, updated_at) VALUES (?, ?, 'feature', 'replaced', 'x', 'x')", [id, p])
        )(),
    ],
    ["a DELETE of a queued card", (_p, id) => sql((db) => db.run("DELETE FROM roadmap_items WHERE id = ?", [id]))()],
  ];
  for (const [name, write] of writers) {
    const project = queueProject(`writers-${name.replace(/[^a-z]+/g, "-").slice(0, 24)}`);
    const id = `qd-writers-${crypto.randomUUID().slice(0, 12)}`;
    await seedQueue(b, project, [[id, 1]]);
    const before = await queueRevOf(b, project);

    await write(project, id);

    expect([name, (await queueRevOf(b, project)) > before]).toEqual([name, true]);
    expect([name, await queueRevOf(b, bystander)]).toEqual([name, bystanderRev]);
  }
}, 60_000);

test("queue revision: a write that leaves the rank as it was moves nothing, and a refused insert leaves no trace", async () => {
  const b = shared;
  const project = queueProject("noop");
  const id = "qd-noop-a";
  await seedQueue(b, project, [[id, 1], ["qd-noop-b", null]]);
  const before = await queueRevOf(b, project);
  const db = openBrokerDb(b.dbPath);
  try {
    db.run("UPDATE roadmap_items SET queue = 1 WHERE id = ?", [id]);
    db.run("UPDATE roadmap_items SET title = 'renamed' WHERE id = ?", [id]);
    db.run("UPDATE roadmap_items SET queue = NULL WHERE id = 'qd-noop-b'");
    expect(() =>
      db.run("INSERT INTO roadmap_items (id, project_key, kind, title, created_at, updated_at) VALUES (?, ?, 'feature', 'dup', 'x', 'x')", [id, project])
    ).toThrow();
  } finally {
    db.close();
  }

  expect(await queueRevOf(b, project)).toBe(before);
}, 20_000);

test("queue revision: pull reports a revision for a project that has a queue and none for one that never had", async () => {
  const b = shared;
  const queued = queueProject("pulled");
  const never = queueProject("never");
  await seedQueue(b, queued, [["qd-pulled-a", 1]]);
  await seedQueue(b, never, [["qd-never-a", null]]);

  const page = await pull(b, 0, 1);

  expect(page.body.queue_revs?.[queued]).toBeGreaterThan(0);
  expect(Object.keys(page.body.queue_revs ?? {})).not.toContain(never);
}, 20_000);

test("queue-delta: the route is gated like the other replication routes, and malformed envelopes are refused before anything is read", async () => {
  const project = queueProject("gates");
  const body = {
    replica_id: R1,
    project_key: project,
    mutation_id: crypto.randomUUID(),
    expected_queue_rev: 0,
    ops: [{ op: "clear" }],
  };
  const probe = (b: TestBroker, withToken: boolean, payload: unknown) =>
    fetch(`${b.url}/roadmap/sync/queue-delta`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(withToken ? { authorization: `Bearer ${TOKEN}` } : {}) },
      body: JSON.stringify(payload),
    });

  const tokenless = await probe(openUpstream, false, body);
  expect([tokenless.status, ((await tokenless.json()) as { error: string }).error.includes("broker_token")]).toEqual([403, true]);
  const noRoleRes = await probe(noRole, true, body);
  expect([noRoleRes.status, ((await noRoleRes.json()) as { error: string }).error.includes("serve_replicas")]).toEqual([403, true]);
  expect((await probe(deadReplica, true, body)).status).toBe(403);
  expect((await probe(bare, true, body)).status).toBe(403);

  for (const [name, payload] of [
    ["a miscased project", { ...body, project_key: project.toUpperCase() }],
    ["a bad mutation id", { ...body, mutation_id: "short" }],
    ["a float revision", { ...body, expected_queue_rev: 1.5 }],
    ["a negative revision", { ...body, expected_queue_rev: -1 }],
    ["no operations", { ...body, ops: [] }],
    ["a malformed card id", { ...body, ops: [{ op: "remove", ids: ["bad id!"] }] }],
    ["a bad replica id", { ...body, replica_id: "X" }],
  ] as const) {
    const res = await probe(shared, true, payload);
    expect([name, res.status]).toEqual([name, 400]);
  }
  expect(receiptCount(shared, project)).toBe(0);
}, 30_000);

function lotSql(b: TestBroker, statement: string, ...params: (string | number | null)[]): void {
  const db = openBrokerDb(b.dbPath);
  try {
    db.run(statement, params);
  } finally {
    db.close();
  }
}

function placeIn(b: TestBroker, id: string) {
  const db = openBrokerDb(b.dbPath, { readonly: true });
  try {
    return db.query("SELECT title, lot_id, queue FROM roadmap_items WHERE id = ?").get(id);
  } finally {
    db.close();
  }
}

test("queue-delta and pull see the default lot alone: a named lot's card is refused, kept by a clear, and its revision is not served", async () => {
  const b = shared;
  const project = queueProject("named");
  const [plain, first, last, lotless] = ["qd-named-default", "qd-named-first", "qd-named-last", "qd-named-lotless"];
  await seedQueue(b, project, [[plain, 1], [first, null], [last, null], [lotless, null]]);
  // One lot id sorts before 'default' and one after, each at its own revision:
  // an unfiltered revision read picks one of them.
  lotSql(b, "UPDATE roadmap_items SET lot_id = 'aa-lot', queue = 1 WHERE id = ?", first);
  lotSql(b, "UPDATE roadmap_items SET lot_id = 'zz-lot', queue = 1 WHERE id = ?", last);
  for (const rank of [2, 3, 4]) {
    lotSql(b, "UPDATE roadmap_items SET queue = ? WHERE id = ?", rank, first);
    lotSql(b, "UPDATE roadmap_items SET queue = ? WHERE id = ?", rank, last);
  }
  lotSql(b, "UPDATE roadmap_items SET queue = 5 WHERE id = ?", last);
  const db = openBrokerDb(b.dbPath, { readonly: true });
  const defaultRev = (
    db.query("SELECT rev FROM roadmap_queue_state WHERE project_key = ? AND lot_id = 'default'").get(project) as {
      rev: number;
    }
  ).rev;
  db.close();
  expect(await queueRevOf(b, project)).toBe(defaultRev);

  const named = await sendDelta(b, project, defaultRev, [{ op: "place", ids: [first], at: "end" }]);
  expect([named.status, named.body.item_id]).toEqual([400, first]);
  const cleared = await sendDelta(b, project, defaultRev, [{ op: "clear" }]);

  expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
  expect([plain, first, last].map((id) => placeIn(b, id))).toMatchObject([
    { lot_id: "default", queue: null },
    { lot_id: "aa-lot", queue: 4 },
    { lot_id: "zz-lot", queue: 5 },
  ]);
  const placed = await sendDelta(b, project, await queueRevOf(b, project), [{ op: "place", ids: [lotless], at: "end" }]);
  expect(placed.status, JSON.stringify(placed.body)).toBe(200);
  expect(placeIn(b, lotless)).toMatchObject({ lot_id: "default", queue: 1 });
}, 30_000);

test("a push carrying a rank for a card of a named lot lands the content and not the rank", async () => {
  const b = shared;
  const project = queueProject("named-push");
  const id = "qd-named-push";
  await seedQueue(b, project, [[id, null]]);
  lotSql(b, "UPDATE roadmap_items SET lot_id = 'lot-p' WHERE id = ?", id);
  const db = openBrokerDb(b.dbPath, { readonly: true });
  const { content_rev } = db.query("SELECT content_rev FROM roadmap_items WHERE id = ?").get(id) as { content_rev: number };
  db.close();

  const pushed = await post(`${b.url}/roadmap/sync/push`, {
    replica_id: R1,
    item: pushItem({ id, project_key: project, title: "edited on the replica", queue: 3 }),
    expected_content_rev: content_rev,
  });

  expect(pushed.status, JSON.stringify(pushed.body)).toBe(200);
  expect(placeIn(b, id)).toEqual({ title: "edited on the replica", lot_id: "lot-p", queue: null });
}, 30_000);

test("a push with queue: null keeps a named lot card's stored rank and lands the content", async () => {
  const b = shared;
  const project = queueProject("named-push-null");
  const id = "qd-named-push-null";
  await seedQueue(b, project, [[id, null]]);
  lotSql(b, "UPDATE roadmap_items SET lot_id = 'lot-p', queue = 5 WHERE id = ?", id);
  const push = async (title: string, status: "planned" | "done") => {
    const db = openBrokerDb(b.dbPath, { readonly: true });
    const { content_rev } = db.query("SELECT content_rev FROM roadmap_items WHERE id = ?").get(id) as { content_rev: number };
    db.close();
    return post(`${b.url}/roadmap/sync/push`, {
      replica_id: R1,
      item: pushItem({ id, project_key: project, title, status, queue: null }),
      expected_content_rev: content_rev,
    });
  };

  const log = () => Bun.file(join(b.tmpDir, "logs", "broker.log")).text();
  const liveStart = (await log()).length;

  const live = await push("edited by an older replica", "planned");

  expect(live.status, JSON.stringify(live.body)).toBe(200);
  expect(placeIn(b, id)).toEqual({ title: "edited by an older replica", lot_id: "lot-p", queue: 5 });
  expect((await log()).slice(liveStart)).toContain(`'${id}' belongs to a named lot -- a rank cannot be written there, rank ignored`);
  const closingStart = (await log()).length;
  expect((await push("closed by an older replica", "done")).status).toBe(200);
  expect(placeIn(b, id)).toEqual({ title: "closed by an older replica", lot_id: "lot-p", queue: null });
  expect((await log()).slice(closingStart), "nothing was ignored").not.toContain("rank ignored");
}, 30_000);

test("pull, push replies and a replayed delta serve a named lot's card without its rank", async () => {
  const b = shared;
  const project = queueProject("masked");
  const [id, mate] = ["qd-masked-a", "qd-masked-b"];
  await seedQueue(b, project, [[id, 1], [mate, 2]]);
  const mutation = crypto.randomUUID();
  const expected = await queueRevOf(b, project);
  const ops = [{ op: "place", ids: [mate], before: id }];
  expect((await sendDelta(b, project, expected, ops, { mutation_id: mutation })).status).toBe(200);
  lotSql(b, "UPDATE roadmap_items SET lot_id = 'lot-m', queue = 7 WHERE id = ?", id);

  const pulled = (await pull(b, 0, 500)).body;
  let cursor = pulled.next_rev;
  let seen = pulled.items.find((item) => item.id === id);
  while (seen === undefined) {
    const page = (await pull(b, cursor, 500)).body;
    expect(page.items.length, "the card is on some page").toBeGreaterThan(0);
    cursor = page.next_rev;
    seen = page.items.find((item) => item.id === id);
  }
  expect([seen.lot_id, seen.queue, seen.lot_rank]).toEqual(["lot-m", null, 7]);

  const push = (expected_content_rev: number | null, title: string) =>
    post<{ item: { queue: number | null; lot_rank?: number | null } }>(`${b.url}/roadmap/sync/push`, {
      replica_id: R1,
      item: pushItem({ id, project_key: project, title, queue: undefined }),
      expected_content_rev,
    });
  const refused = await push(null, "stale base");
  const accepted = await push(seen.content_rev, "accepted");
  expect([refused.status, refused.body.item.queue, refused.body.item.lot_rank]).toEqual([409, null, 7]);
  expect([accepted.status, accepted.body.item.queue, accepted.body.item.lot_rank]).toEqual([200, null, 7]);

  const replayed = await sendDelta(b, project, expected, ops, { mutation_id: mutation });
  expect(replayed.body.replayed).toBe(true);
  const replayedCard = replayed.body.items?.find((item) => item.id === id);
  expect([replayedCard?.queue, replayedCard?.lot_rank]).toEqual([null, 7]);
  expect(placeIn(b, id)).toMatchObject({ lot_id: "lot-m", queue: 7 });
}, 30_000);

test("a pull announces every project's lots and lot revisions, and a rank travels beside a masked queue", async () => {
  const b = shared;
  const projects = { open: queueProject("announce-open"), closed: queueProject("announce-closed") };
  const createdAt = "2026-01-01T00:00:00.000Z";
  const lotRow = (project: string, name: string, closed_at: string | null, color: number | null) =>
    lotSql(
      b,
      "INSERT INTO roadmap_lots (project_key, id, name, created_by, created_at, closed_at, color) VALUES (?, 'announce-lot', ?, 'deck', ?, ?, ?)",
      project, name, createdAt, closed_at, color
    );
  lotRow(projects.open, "open one", null, 3);
  lotRow(projects.closed, "closed one", createdAt, null);
  const [ranked, queued, loose, unranked] = ["an-ranked", "an-default", "an-loose", "an-unranked"];
  await seedQueue(b, projects.open, [[queued, 1], [ranked, null], [loose, null]]);
  await seedQueue(b, projects.closed, [[unranked, null]]);
  // A different number of writes per queue, so that no two revisions can be mistaken for each other.
  for (const rank of [1, 2, 5, 4, 3]) lotSql(b, "UPDATE roadmap_items SET lot_id = 'announce-lot', queue = ? WHERE id = ?", rank, ranked);
  for (const rank of [2, 1]) lotSql(b, "UPDATE roadmap_items SET queue = ? WHERE id = ?", rank, queued);
  lotSql(b, "UPDATE roadmap_items SET lot_id = 'announce-lot' WHERE id = ?", unranked);

  const wanted = new Set([ranked, queued, loose, unranked]);
  const rows = new Map<string, RoadmapSyncRow>();
  let page = (await pull(b, 0, 500)).body;
  for (;;) {
    for (const item of page.items) if (wanted.has(item.id)) rows.set(item.id, item);
    if (rows.size === wanted.size) break;
    expect(page.items.length, "every seeded card is on some page").toBeGreaterThan(0);
    page = (await pull(b, page.next_rev, 500)).body;
  }

  expect(page.lot_protocol).toBe(2);
  const revs = [lotRev(b, projects.open, "announce-lot"), lotRev(b, projects.closed, "announce-lot"), lotRev(b, projects.open, "default")];
  expect(new Set(revs).size, "non-vacuity: the three revisions differ").toBe(3);
  expect(page.lot_queue_revs?.[projects.open]).toEqual({ "announce-lot": revs[0]!, default: revs[2]! });
  expect(page.lot_queue_revs?.[projects.closed]).toEqual({ "announce-lot": revs[1]! });
  expect([page.queue_revs?.[projects.open], page.queue_revs?.[projects.closed]]).toEqual([revs[2]!, undefined]);
  expect(Object.values(page.queue_revs ?? {}).every((rev) => typeof rev === "number")).toBe(true);
  expect(page.lots?.filter((lot) => lot.id === "announce-lot")).toEqual([
    { project_key: projects.closed, id: "announce-lot", name: "closed one", created_by: "deck", created_at: createdAt, closed_at: createdAt, color: null },
    { project_key: projects.open, id: "announce-lot", name: "open one", created_by: "deck", created_at: createdAt, closed_at: null, color: 3 },
  ]);
  const place = (id: string) => {
    const row = rows.get(id)!;
    return [row.queue, "lot_rank" in row ? row.lot_rank : "absent"];
  };
  expect([place(ranked), place(unranked), place(queued), place(loose)]).toEqual([
    [null, 3],
    [null, null],
    [1, "absent"],
    [null, "absent"],
  ]);
}, 30_000);

// ----- /roadmap/sync/queue-delta, version 2 -----

type LotDeltaBody = Partial<RoadmapLotQueueDeltaResponse> &
  Partial<RoadmapLotQueueDeltaConflict> & { error?: string; op_index?: number };
type Places = Array<[string, string | null, number | null]>;

async function lotProject(name: string, cards: Array<[string, "a" | "b" | "default" | null, number | null]>) {
  const b = shared;
  const project = queueProject(`v2-${name}`);
  const lot = { a: `${name}-lot-a`, b: `${name}-lot-b`, closed: `${name}-lot-closed` };
  const card = (n: string) => `qd2-${name}-${n}`;
  for (const [key, closedAt] of [["a", null], ["b", null], ["closed", "2026-01-01T00:00:00.000Z"]] as const) {
    lotSql(
      b,
      "INSERT INTO roadmap_lots (project_key, id, name, created_by, created_at, closed_at, color) VALUES (?, ?, 'lot', 'deck', '2026-01-01T00:00:00.000Z', ?, NULL)",
      project, lot[key], closedAt
    );
  }
  await seedQueue(b, project, cards.map(([n]) => [card(n), null] as [string, null]));
  for (const [n, where, rank] of cards) {
    const lotId = where === null || where === "default" ? where : lot[where];
    lotSql(b, "UPDATE roadmap_items SET lot_id = ?, queue = ? WHERE id = ?", lotId, rank, card(n));
  }
  return { b, project, lot, card };
}

function placesOf(b: TestBroker, project: string): Places {
  const db = openBrokerDb(b.dbPath, { readonly: true });
  try {
    return (
      db.query("SELECT id, lot_id, queue FROM roadmap_items WHERE project_key = ? ORDER BY id").all(project) as {
        id: string;
        lot_id: string | null;
        queue: number | null;
      }[]
    ).map((row) => [row.id, row.lot_id, row.queue]);
  } finally {
    db.close();
  }
}

function lotRev(b: TestBroker, project: string, lotId: string): number {
  const db = openBrokerDb(b.dbPath, { readonly: true });
  try {
    const row = db.query("SELECT rev FROM roadmap_queue_state WHERE project_key = ? AND lot_id = ?").get(project, lotId) as
      | { rev: number }
      | null;
    return row?.rev ?? 0;
  } finally {
    db.close();
  }
}

const currentLots = (b: TestBroker, project: string, ids: string[]) =>
  ids.map((lot_id) => ({ lot_id, expected_queue_rev: lotRev(b, project, lot_id) }));

function sendLotDelta(
  b: TestBroker,
  project: string,
  lots: unknown,
  ops: unknown,
  over: Record<string, unknown> = {}
) {
  return post<LotDeltaBody>(`${b.url}/roadmap/sync/queue-delta`, {
    replica_id: R1,
    project_key: project,
    mutation_id: crypto.randomUUID(),
    version: 2,
    lots,
    ops,
    ...over,
  });
}

test("queue-delta v2: each lot is judged on its own revision, and a stale one moves no other", async () => {
  const { b, project, lot, card } = await lotProject("two", [["a1", "a", 1], ["a2", "a", 2], ["b1", "b", 1], ["b2", "b", 2]]);
  const writtenAgainst = { a: currentLots(b, project, [lot.a]), b: currentLots(b, project, [lot.b]) };
  const defaultRev = lotRev(b, project, "default");

  const onA = await sendLotDelta(b, project, writtenAgainst.a, [{ op: "place", lot_id: lot.a, ids: [card("a2")], at: "start" }]);

  expect(onA.status, JSON.stringify(onA.body)).toBe(200);
  expect(onA.body.lot_revs).toEqual({ [lot.a]: lotRev(b, project, lot.a) });
  expect(lotRev(b, project, lot.b), "a write on one lot leaves the other's revision").toBe(writtenAgainst.b[0]!.expected_queue_rev);
  const stale = await sendLotDelta(b, project, writtenAgainst.a, [{ op: "remove", lot_id: lot.a, ids: [card("a1")] }]);
  expect([stale.status, stale.body.reason, stale.body.lot_id]).toEqual([409, "queue_rev", lot.a]);
  expect(stale.body.lot_revs).toEqual({ [lot.a]: lotRev(b, project, lot.a) });
  const onB = await sendLotDelta(b, project, writtenAgainst.b, [{ op: "join", lot_id: lot.b, ids: [card("b2")], anchor: card("b1") }]);

  expect(onB.status, JSON.stringify(onB.body)).toBe(200);
  expect(onB.body.items?.map((row) => [row.id, row.updated_by])).toEqual([[card("b2"), `via:${R1.slice(0, 8)}:deck`]]);
  expect(placesOf(b, project)).toEqual([
    [card("a1"), lot.a, 2],
    [card("a2"), lot.a, 1],
    [card("b1"), lot.b, 1],
    [card("b2"), lot.b, 1],
  ]);
  expect(lotRev(b, project, "default")).toBe(defaultRev);
}, 30_000);

test("queue-delta v2: a transfer writes lot and rank together, or neither", async () => {
  const { b, project, lot, card } = await lotProject("move", [["x", "a", 1], ["y", "a", 2], ["z", "b", 1]]);
  const before = placesOf(b, project);
  const transfer = [
    { op: "move_members", ids: [card("x")], from: lot.a, to: lot.b },
    { op: "place", lot_id: lot.b, ids: [card("x")], at: "end" },
  ];
  const both = [lot.a, lot.b];

  const stale = await sendLotDelta(b, project, [{ lot_id: lot.a, expected_queue_rev: lotRev(b, project, lot.a) }, { lot_id: lot.b, expected_queue_rev: 99 }], transfer);
  expect([stale.status, stale.body.lot_id]).toEqual([409, lot.b]);
  const trigger = "zz_fault_v2_receipt";
  lotSql(b, `CREATE TRIGGER ${trigger} BEFORE INSERT ON roadmap_queue_receipts WHEN new.project_key = '${project}' BEGIN SELECT RAISE(ABORT, 'receipt fault'); END`);
  try {
    expect((await sendLotDelta(b, project, currentLots(b, project, both), transfer)).status).toBe(500);
  } finally {
    lotSql(b, `DROP TRIGGER IF EXISTS ${trigger}`);
  }
  expect(placesOf(b, project), "a refused or failed transfer writes nothing").toEqual(before);
  expect(receiptCount(b, project)).toBe(0);

  const moved = await sendLotDelta(b, project, currentLots(b, project, both), transfer);

  expect(moved.status, JSON.stringify(moved.body)).toBe(200);
  expect(placesOf(b, project)).toEqual([
    [card("x"), lot.b, 2],
    [card("y"), lot.a, 1],
    [card("z"), lot.b, 1],
  ]);
  expect(moved.body.items?.map((row) => [row.id, row.lot_id, row.queue, row.lot_rank]).sort()).toEqual([
    [card("x"), lot.b, null, 2],
    [card("y"), lot.a, null, 1],
  ]);
}, 30_000);

test("queue-delta v2: a retry after a lost response answers the receipt, whose columns carry the default lot's revision", async () => {
  const { b, project, lot, card } = await lotProject("retry", [["d", "default", 1], ["x", "a", 1], ["y", "a", 2]]);
  const lots = currentLots(b, project, [lot.a]);
  const ops = [{ op: "remove", lot_id: lot.a, ids: [card("x")] }];
  const mutation_id = crypto.randomUUID();
  const defaultRev = lotRev(b, project, "default");
  expect(defaultRev, "non-vacuity: the default lot has a revision of its own").toBeGreaterThan(0);

  const first = await sendLotDelta(b, project, lots, ops, { mutation_id });
  const later = await sendLotDelta(b, project, currentLots(b, project, [lot.a]), [{ op: "remove", lot_id: lot.a, ids: [card("y")] }]);
  const settled = lotRev(b, project, lot.a);
  const retry = await sendLotDelta(b, project, lots, ops, { mutation_id });

  expect([first.status, first.body.replayed, later.status]).toEqual([200, false, 200]);
  expect([retry.status, retry.body.replayed]).toEqual([200, true]);
  // The receipt answers with the revisions of the first attempt, not the current ones.
  expect([retry.body.payload_hash, retry.body.lot_revs]).toEqual([first.body.payload_hash, first.body.lot_revs]);
  expect(retry.body.items?.map((row) => row.id)).toEqual(first.body.items?.map((row) => row.id));
  expect(lotRev(b, project, lot.a)).toBe(settled);
  const db = openBrokerDb(b.dbPath, { readonly: true });
  const receipt = db
    .query("SELECT queue_rev_before, queue_rev_after FROM roadmap_queue_receipts WHERE project_key = ? AND mutation_id = ?")
    .get(project, mutation_id);
  db.close();
  expect(receipt).toEqual({ queue_rev_before: defaultRev, queue_rev_after: defaultRev });
}, 30_000);

test("queue-delta v2: a mutation id receipted for another payload is refused, a v1 receipt included", async () => {
  const { b, project, lot, card } = await lotProject("reuse", [["d", "default", 1], ["e", "default", 2], ["x", "a", 1]]);
  const v1Id = crypto.randomUUID();
  const v2Id = crypto.randomUUID();
  const swap = [{ op: "place", ids: [card("e")], at: "start" }];
  expect((await sendDelta(b, project, await queueRevOf(b, project), swap, { mutation_id: v1Id })).status).toBe(200);
  const lots = currentLots(b, project, [lot.a]);
  expect((await sendLotDelta(b, project, lots, [{ op: "clear", lot_id: lot.a }], { mutation_id: v2Id })).status).toBe(200);
  const after = placesOf(b, project);

  const asV2 = await sendLotDelta(b, project, currentLots(b, project, ["default"]), [{ op: "clear", lot_id: "default" }], { mutation_id: v1Id });
  const otherPayload = await sendLotDelta(b, project, lots, [{ op: "remove", lot_id: lot.a, ids: [card("x")] }], { mutation_id: v2Id });
  const asV1 = await sendDelta(b, project, await queueRevOf(b, project), swap, { mutation_id: v2Id });

  expect([asV2, otherPayload, asV1].map((res) => [res.status, res.body.reason])).toEqual(Array(3).fill([409, "mutation_reused"]));
  expect(placesOf(b, project)).toEqual(after);
  expect(receiptCount(b, project)).toBe(2);
}, 30_000);

test("queue-delta v2: a receipt belongs to its replica and project: the same mutation id elsewhere is a new mutation", async () => {
  const here = await lotProject("scope", [["x", "a", 1], ["y", "a", 2]]);
  const there = await lotProject("scope-other", [["x", "a", 1]]);
  const mutation_id = crypto.randomUUID();
  const remove = (p: typeof here, n: string, replica_id: string) =>
    sendLotDelta(p.b, p.project, currentLots(p.b, p.project, [p.lot.a]), [{ op: "remove", lot_id: p.lot.a, ids: [p.card(n)] }], {
      mutation_id,
      replica_id,
    });

  const sent = [await remove(here, "x", R1), await remove(here, "y", R2), await remove(there, "x", R1)];

  expect(sent.map((res) => [res.status, res.body.replayed, res.body.reason])).toEqual(Array(3).fill([200, false, undefined]));
  expect([receiptCount(here.b, here.project), receiptCount(there.b, there.project)]).toEqual([2, 1]);
  expect([...placesOf(here.b, here.project), ...placesOf(there.b, there.project)].map((place) => place[2])).toEqual([null, null, null]);
}, 30_000);

test("queue-delta v2: one lot id in two projects is judged and written in the envelope's project alone", async () => {
  const b = shared;
  const states = ["open", "closed", "absent"] as const;
  const projects: Record<string, { project: string; cards: string[] }> = {};
  for (const state of states) {
    const project = queueProject(`v2-twin-${state}`);
    const cards = [`qd2-twin-${state}-1`, `qd2-twin-${state}-2`];
    if (state !== "absent") {
      lotSql(
        b,
        "INSERT INTO roadmap_lots (project_key, id, name, created_by, created_at, closed_at, color) VALUES (?, 'twin-lot', 'lot', 'deck', '2026-01-01T00:00:00.000Z', ?, NULL)",
        project, state === "closed" ? "2026-01-01T00:00:00.000Z" : null
      );
    }
    await seedQueue(b, project, cards.map((id) => [id, null] as [string, null]));
    cards.forEach((id, i) => lotSql(b, "UPDATE roadmap_items SET lot_id = 'twin-lot', queue = ? WHERE id = ?", i + 1, id));
    projects[state] = { project, cards };
  }
  const open = projects.open!;
  const untouched = () => [placesOf(b, projects.closed!.project), placesOf(b, projects.absent!.project)];
  const others = untouched();
  const swap = (state: string) => {
    const { project, cards } = projects[state]!;
    return sendLotDelta(b, project, currentLots(b, project, ["twin-lot"]), [
      { op: "place", lot_id: "twin-lot", ids: [cards[1]], at: "start" },
    ]);
  };

  const answers = [await swap("open"), await swap("closed"), await swap("absent")];

  expect(answers.map((res) => [res.status, res.body.reason])).toEqual([
    [200, undefined],
    [409, "lot_closed"],
    [404, undefined],
  ]);
  expect(answers[0]!.body.items?.map((row) => row.id).sort()).toEqual(open.cards);
  expect(placesOf(b, open.project)).toEqual([
    [open.cards[0]!, "twin-lot", 2],
    [open.cards[1]!, "twin-lot", 1],
  ]);
  expect(untouched()).toEqual(others);
}, 30_000);

test("queue-delta v2: a done or archived card changes lot and drops its rank", async () => {
  const { b, project, lot, card } = await lotProject("finished", [["done", "a", null], ["archived", "a", null]]);
  for (const status of ["done", "archived"]) {
    lotSql(b, "UPDATE roadmap_items SET status = ?, queue = 4 WHERE id = ?", status, card(status));
    const moved = await sendLotDelta(b, project, currentLots(b, project, [lot.a, lot.b]), [
      { op: "move_members", ids: [card(status)], from: lot.a, to: lot.b },
    ]);
    expect([status, moved.status]).toEqual([status, 200]);
  }
  expect(placesOf(b, project)).toEqual([
    [card("archived"), lot.b, null],
    [card("done"), lot.b, null],
  ]);
}, 30_000);

test("queue-delta v2: an unknown lot is a 404 and a closed one takes no card and no rank, though cards may leave it", async () => {
  const { b, project, lot, card } = await lotProject("closed", [["x", "a", 1], ["old", null, null]]);
  lotSql(b, "UPDATE roadmap_items SET lot_id = ? WHERE id = ?", lot.closed, card("old"));
  const before = placesOf(b, project);
  const send = (ids: string[], ops: unknown) => sendLotDelta(b, project, currentLots(b, project, ids), ops);

  const unknown = await send([lot.a, "no-such-lot"], [{ op: "move_members", ids: [card("x")], from: lot.a, to: "no-such-lot" }]);
  const unknownQueue = await send(["no-such-lot"], [{ op: "clear", lot_id: "no-such-lot" }]);
  const into = await send([lot.a, lot.closed], [{ op: "move_members", ids: [card("x")], from: lot.a, to: lot.closed }]);
  const ranked = await send([lot.closed], [{ op: "place", lot_id: lot.closed, ids: [card("old")], at: "end" }]);

  expect([unknown.status, unknown.body.lot_id, unknownQueue.status]).toEqual([404, "no-such-lot", 404]);
  expect([into, ranked].map((res) => [res.status, res.body.reason, res.body.lot_id])).toEqual(
    Array(2).fill([409, "lot_closed", lot.closed])
  );
  expect(placesOf(b, project)).toEqual(before);
  const out = await send([lot.closed], [{ op: "move_members", ids: [card("old")], from: lot.closed, to: null }]);
  expect(out.status, JSON.stringify(out.body)).toBe(200);
  expect(placesOf(b, project)).toContainEqual([card("old"), null, null]);
}, 30_000);

test("queue-delta v2: card rules hold inside a named lot, and a refusal writes and receipts nothing", async () => {
  const { b, project, lot, card } = await lotProject("rules", [
    ["x", "a", 1], ["dir", "a", 2], ["done", "a", null], ["off", "a", null], ["idle", "a", null], ["far", "b", 1],
  ]);
  lotSql(b, "UPDATE roadmap_items SET kind = 'directive', directive = 'clear' WHERE id = ?", card("dir"));
  lotSql(b, "UPDATE roadmap_items SET status = 'done' WHERE id = ?", card("done"));
  lotSql(b, "UPDATE roadmap_items SET inactive = 1 WHERE id = ?", card("off"));
  const before = placesOf(b, project);
  const send = (ops: unknown, ids = [lot.a]) => sendLotDelta(b, project, currentLots(b, project, ids), ops);
  const place = (n: string) => [{ op: "place", lot_id: lot.a, ids: [card(n)], at: "end" }];

  const joined = await send([{ op: "join", lot_id: lot.a, ids: [card("x")], anchor: card("dir") }]);
  const finished = await send(place("done"));
  const inactive = await send(place("off"));
  const stranger = await send(place("nobody"));
  const foreign = await send(place("far"));
  const wrongSource = await send([{ op: "move_members", ids: [card("far")], from: lot.a, to: null }]);
  const unqueued = await send([{ op: "place", lot_id: lot.a, ids: [card("x")], before: card("idle") }]);

  expect(
    [joined, finished, inactive, stranger, foreign, wrongSource, unqueued].map((res) => [res.status, res.body.item_id])
  ).toEqual([
    [400, card("dir")],
    [400, card("done")],
    [403, card("off")],
    [404, card("nobody")],
    [409, card("far")],
    [409, card("far")],
    [400, card("idle")],
  ]);
  expect([foreign.body.reason, unqueued.body.op_index]).toEqual(["lot_mismatch", 0]);
  expect(placesOf(b, project)).toEqual(before);
  expect(receiptCount(b, project)).toBe(0);

  // A wave already mixed stays editable elsewhere, and a done card's leftover rank is outside the queue.
  lotSql(b, "UPDATE roadmap_items SET kind = 'directive', directive = 'clear', lot_id = ?, queue = 1 WHERE id = ?", lot.b, card("idle"));
  lotSql(b, "UPDATE roadmap_items SET lot_id = ?, queue = 9 WHERE id = ?", lot.b, card("done"));
  lotSql(b, "UPDATE roadmap_items SET lot_id = ?, queue = 2 WHERE id = ?", lot.b, card("x"));
  const elsewhere = await send([{ op: "remove", lot_id: lot.b, ids: [card("x")] }], [lot.b]);
  expect(elsewhere.status, JSON.stringify(elsewhere.body)).toBe(200);
  expect(elsewhere.body.items?.map((row) => row.id)).toEqual([card("x")]);
  expect(placesOf(b, project)).toContainEqual([card("done"), lot.b, 9]);
}, 30_000);

test("queue-delta v2: a card another relay holds is neither moved nor unqueued, one that only takes a new number is", async () => {
  const { b, project, lot, card } = await lotProject("lock", [["x", "a", 1], ["held", null, null], ["idle", null, null]]);
  // A relay takes a card only outside a named lot; the card joins the lot with its lock.
  for (const [name, rank] of [["held", 2], ["idle", null]] as const) {
    const claim = await post(`${b.url}/roadmap/sync/lock`, {
      replica_id: R2,
      id: card(name),
      action: "claim",
      owner: { peer_id: `agent-v2-lock-${name}`, group_id: null },
    });
    expect(claim.status).toBe(200);
    lotSql(b, "UPDATE roadmap_items SET lot_id = ?, queue = ? WHERE id = ?", lot.a, rank, card(name));
  }
  const before = placesOf(b, project);
  const send = (ops: unknown, ids = [lot.a]) => sendLotDelta(b, project, currentLots(b, project, ids), ops);

  const unqueued = await send([{ op: "clear", lot_id: lot.a }]);
  const placed = await send([{ op: "place", lot_id: lot.a, ids: [card("held")], at: "start" }]);
  const transferred = await send([{ op: "move_members", ids: [card("idle")], from: lot.a, to: lot.b }], [lot.a, lot.b]);

  expect([unqueued, placed, transferred].map((res) => [res.status, res.body.reason, res.body.item_id])).toEqual([
    [409, "locked_upstream", card("held")],
    [409, "locked_upstream", card("held")],
    [409, "locked_upstream", card("idle")],
  ]);
  expect(placesOf(b, project)).toEqual(before);
  const renumbered = await send([{ op: "remove", lot_id: lot.a, ids: [card("x")] }]);
  expect(renumbered.status, JSON.stringify(renumbered.body)).toBe(200);
  expect(placesOf(b, project)).toContainEqual([card("held"), lot.a, 1]);
}, 30_000);

test("queue-delta v2: a malformed envelope is refused before anything is read", async () => {
  const { b, project, lot, card } = await lotProject("shape", [["x", "a", 1]]);
  const lots = currentLots(b, project, [lot.a]);
  const ops = [{ op: "remove", lot_id: lot.a, ids: [card("x")] }];
  const before = placesOf(b, project);

  const refused = [
    await sendLotDelta(b, project, lots, ops, { version: 3 }),
    await sendLotDelta(b, project, lots, ops, { expected_queue_rev: 0 }),
    await sendLotDelta(b, project, [], ops),
    await sendLotDelta(b, project, lots, [{ op: "remove", lot_id: lot.a, ids: ["bad id"] }]),
  ];

  expect(refused.map((res) => res.status)).toEqual([400, 400, 400, 400]);
  expect(refused[0]!.body.error).toContain("version");
  expect(refused[1]!.body.error).toContain("expected_queue_rev");
  expect(refused[3]!.body.item_id).toBe("bad id");
  expect(placesOf(b, project)).toEqual(before);
}, 30_000);

test("queue-delta v2: every refusal is logged with its status and reason", async () => {
  const { b, project, lot, card } = await lotProject("trace", [["x", "a", 1]]);
  const log = () => Bun.file(join(b.tmpDir, "logs", "broker.log")).text();
  const start = (await log()).length;
  const ops = [{ op: "remove", lot_id: lot.a, ids: [card("x")] }];
  const lots = currentLots(b, project, [lot.a]);

  await sendLotDelta(b, project, lots, ops, { version: 3 });
  await sendLotDelta(b, project, [{ lot_id: lot.a, expected_queue_rev: 99 }], ops);
  await sendLotDelta(b, project, currentLots(b, project, ["no-such-lot"]), [{ op: "clear", lot_id: "no-such-lot" }]);

  const traces = (await log()).slice(start).split("\n").filter((line) => line.includes("v2 queue delta refused"));
  expect(traces).toHaveLength(3);
  expect(traces[0]).toContain("version");
  expect(traces[1]).toContain("queue_rev");
  expect(traces[2]).toContain("no-such-lot");
}, 30_000);

test("queue-delta v2: a card with an open send keeps its lot, and still takes a new rank in it", async () => {
  const { b, project, lot, card } = await lotProject("sent", [["x", "a", 1], ["y", "a", 2], ["free", "default", 1]]);
  for (const [name, lotId] of [["x", lot.a], ["free", "default"]] as const) {
    lotSql(
      b,
      `INSERT INTO roadmap_lot_dispatched
         (project_key, lot_id, epoch, card_id, operator_id, operation_id, mode, target_peer_id, sent_at)
       VALUES (?, ?, 1, ?, 'operator', ?, 'wave', 'lead', '2026-01-01T00:00:00.000Z')`,
      project, lotId, card(name), `op-${name}`
    );
  }
  const before = placesOf(b, project);
  const send = (ids: string[], ops: unknown) => sendLotDelta(b, project, currentLots(b, project, ids), ops);

  const named = await send([lot.a, lot.b], [{ op: "move_members", ids: [card("x")], from: lot.a, to: lot.b }]);
  const plain = await send(["default", lot.b], [{ op: "move_members", ids: [card("free")], from: "default", to: lot.b }]);

  expect([named, plain].map((res) => [res.status, res.body.reason, res.body.item_id])).toEqual([
    [409, "locked_upstream", card("x")],
    [409, "locked_upstream", card("free")],
  ]);
  expect(placesOf(b, project)).toEqual(before);
  const reranked = await send([lot.a], [{ op: "place", lot_id: lot.a, ids: [card("y")], at: "start" }]);
  expect(reranked.status, JSON.stringify(reranked.body)).toBe(200);
  expect(placesOf(b, project)).toContainEqual([card("x"), lot.a, 2]);
}, 30_000);

// ----- a lot under execution on the upstream, where a replica proves no holder -----

function holdLot(b: TestBroker, project: string, lotId: string): void {
  seedLotExecution(b, { projectKey: project, lotId }, {
    run: { group: "upstream-holder-group", run: crypto.randomUUID() },
    controller: { instance_token: crypto.randomUUID(), peer_id: "upstream-holder" },
  });
}

test("queue-delta v2: a lot under execution takes no rank and neither gains nor loses a card", async () => {
  const { b, project, lot, card } = await lotProject("executed", [
    ["a1", "a", 1], ["a2", "a", 2], ["b1", "b", 1], ["b2", "b", 2],
  ]);
  const earlier = crypto.randomUUID();
  const reorder = [{ op: "place", lot_id: lot.a, ids: [card("a2")], at: "start" }];
  const writtenBefore = currentLots(b, project, [lot.a]);
  expect((await sendLotDelta(b, project, writtenBefore, reorder, { mutation_id: earlier })).status).toBe(200);
  holdLot(b, project, lot.a);
  const before = placesOf(b, project);
  const send = (ids: string[], ops: unknown) => sendLotDelta(b, project, currentLots(b, project, ids), ops);

  const ranked = await send([lot.a], [{ op: "place", lot_id: lot.a, ids: [card("a1")], at: "start" }]);
  const cleared = await send([lot.a], [{ op: "clear", lot_id: lot.a }]);
  const out = await send([lot.a, lot.b], [{ op: "move_members", ids: [card("a1")], from: lot.a, to: lot.b }]);
  const into = await send([lot.a, lot.b], [{ op: "move_members", ids: [card("b1")], from: lot.b, to: lot.a }]);

  expect([ranked, cleared, out, into].map((res) => [res.status, res.body.reason])).toEqual(
    Array(4).fill([409, "locked_upstream"])
  );
  expect([out.body.item_id, into.body.item_id]).toEqual([card("a1"), card("b1")]);
  expect(placesOf(b, project)).toEqual(before);
  const elsewhere = await send([lot.b], [{ op: "place", lot_id: lot.b, ids: [card("b2")], at: "start" }]);
  expect(elsewhere.status, JSON.stringify(elsewhere.body)).toBe(200);
  const replayed = await sendLotDelta(b, project, writtenBefore, reorder, { mutation_id: earlier });
  expect([replayed.status, replayed.body.replayed]).toEqual([200, true]);
}, 30_000);

test("push: a card of a lot under execution takes text from a replica, and no change of work", async () => {
  const b = shared;
  const project = queueProject("executed-push");
  const [held, prepared] = ["ex-push-held", "ex-push-prepared"];
  await seedQueue(b, project, [[held, null], [prepared, null]]);
  lotSql(b, "UPDATE roadmap_items SET lot_id = 'ex-held' WHERE id = ?", held);
  lotSql(b, "UPDATE roadmap_items SET lot_id = 'ex-prepared' WHERE id = ?", prepared);
  holdLot(b, project, "ex-held");
  const push = (id: string, fields: Partial<RoadmapSyncPushItem>) => {
    const db = openBrokerDb(b.dbPath, { readonly: true });
    const { content_rev } = db.query("SELECT content_rev FROM roadmap_items WHERE id = ?").get(id) as { content_rev: number };
    db.close();
    return post<Partial<RoadmapSyncPushConflict>>(`${b.url}/roadmap/sync/push`, {
      replica_id: R1,
      item: pushItem({ id, project_key: project, ...fields }),
      expected_content_rev: content_rev,
    });
  };

  for (const fields of [
    { status: "done" },
    { status: "in_progress" },
    { kind: "bug" },
    { inactive: true },
    { deleted_at: "2026-01-02T00:00:00.000Z" },
  ] as const) {
    const refused = await push(held, fields);
    expect([fields, refused.status, refused.body.reason]).toEqual([fields, 409, "locked_upstream"]);
  }
  expect((await push(held, { title: "edited while held" })).status).toBe(200);
  expect(placeIn(b, held)).toMatchObject({ title: "edited while held", lot_id: "ex-held" });

  const stored: Partial<RoadmapSyncPushItem> = { kind: "directive", directive: "clear", target_peer_ids: ["peer-a"] };
  lotSql(
    b,
    "UPDATE roadmap_items SET kind = 'directive', directive = 'clear', target_peer_ids = '[\"peer-a\"]' WHERE id = ?",
    held
  );
  const changes: Partial<RoadmapSyncPushItem>[] = [
    { directive: "compact" },
    { target_peer_ids: ["peer-b"] },
    { depends_on: [prepared] },
  ];
  for (const change of changes) {
    const refused = await push(held, { ...stored, title: "edited while held", ...change });
    expect([change, refused.status, refused.body.reason]).toEqual([change, 409, "locked_upstream"]);
  }
  expect((await push(held, { ...stored, title: "directive retitled" })).status).toBe(200);

  const taken = await push(prepared, { status: "in_progress" });
  expect([taken.status, taken.body.reason]).toEqual([409, "locked_upstream"]);
  expect((await push(prepared, { status: "done" })).status).toBe(200);
}, 30_000);

test("lock relay: no replica takes a card of a named lot or re-asserts on a held one, and still gives its lock back", async () => {
  const b = shared;
  const project = queueProject("executed-lock");
  const [relayed, free] = ["ex-lock-relayed", "ex-lock-free"];
  await seedQueue(b, project, [[relayed, null], [free, null]]);
  const relay = (id: string, action: "claim" | "release") =>
    post<{ scope?: string; released?: boolean }>(`${b.url}/roadmap/sync/lock`, {
      replica_id: R1,
      id,
      action,
      owner: { peer_id: "agent-executed", group_id: null },
    });
  expect((await relay(relayed, "claim")).status).toBe(200);
  for (const id of [relayed, free]) lotSql(b, "UPDATE roadmap_items SET lot_id = 'ex-lock' WHERE id = ?", id);
  const holder = () => {
    const db = openBrokerDb(b.dbPath, { readonly: true });
    try {
      return db.query("SELECT id, locked FROM roadmap_items WHERE project_key = ? ORDER BY id").all(project);
    } finally {
      db.close();
    }
  };

  const fresh = await relay(free, "claim");
  expect([fresh.status, fresh.body.scope]).toEqual([409, "contested"]);
  expect((await relay(relayed, "claim")).status, "a prepared lot keeps the relay it had").toBe(200);

  holdLot(b, project, "ex-lock");
  const reasserted = await relay(relayed, "claim");
  expect([reasserted.status, reasserted.body.scope]).toEqual([409, "contested"]);
  expect(holder()).toEqual([
    { id: free, locked: 0 },
    { id: relayed, locked: 1 },
  ]);
  const released = await relay(relayed, "release");
  expect([released.status, released.body.released]).toEqual([200, true]);
  expect(holder()).toEqual([
    { id: free, locked: 0 },
    { id: relayed, locked: 0 },
  ]);
  const retaken = await relay(relayed, "claim");
  expect([retaken.status, retaken.body.scope]).toEqual([409, "contested"]);
}, 30_000);
