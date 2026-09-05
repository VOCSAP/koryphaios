// The replication pass end to end: two real brokers, the second running in
// replica mode against the first. The replica reaches its upstream through a
// proxy this file controls, so "the network is down" is a deliberate state and
// not a race -- every divergence below is set up inside a blocked window and
// asserted after it reopens, with no fixed sleeps anywhere.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import {
  startBroker,
  stopBroker,
  livePid,
  deckAuthored,
  type TestBroker,
} from "./_helper.ts";
import type {
  RegisterResponse,
  RoadmapItem,
  RoadmapSyncConflictsResponse,
  RoadmapSyncStatus,
} from "../shared/types.ts";

const PK = "github.com/vocsap/replica-repo";
/**
 * Both brokers of the pair run authenticated: the replication routes are served
 * only where a broker_token is configured, and the replica presents that same
 * token upstream. Every request this file makes therefore carries the Bearer,
 * through this wrapper rather than through a per-call header.
 */
const TOKEN = "replica-suite-token";

async function post<T = unknown>(url: string, body: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T };
}

type UpsertRes = { item: RoadmapItem };
type ListRes = { items: RoadmapItem[] };

let upstream: TestBroker;
let replica: TestBroker;
let proxy: ReturnType<typeof Bun.serve>;
let replicaId: string;
/** Flipped by the tests: the replica's only route to its upstream goes through here. */
let upstreamBlocked = false;

beforeAll(async () => {
  // The upstream takes the ROLE explicitly (serve_replicas) on top of the token:
  // a token alone authenticates callers, it does not make a broker an upstream.
  upstream = await startBroker({
    CLAUDE_PEERS_BROKER_TOKEN: TOKEN,
    CLAUDE_PEERS_SERVE_REPLICAS: "1",
  });
  proxy = Bun.serve({
    port: 0,
    async fetch(req) {
      if (upstreamBlocked) return new Response("upstream unreachable", { status: 503 });
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
    CLAUDE_PEERS_BROKER_TOKEN: TOKEN,
    CLAUDE_PEERS_OFFLINE_REPLICA: "1",
    CLAUDE_PEERS_SYNC_TICK_MS: "150",
  });
  const db = new Database(replica.dbPath);
  replicaId = (
    db.query("SELECT value FROM roadmap_sync_meta WHERE key = 'replica_id'").get() as {
      value: string;
    }
  ).value;
  db.close();
});

afterAll(async () => {
  proxy.stop(true);
  await stopBroker(replica);
  await stopBroker(upstream);
});

async function pollUntil<T>(
  label: string,
  budgetMs: number,
  check: () => Promise<{ done: boolean; value: T }>
): Promise<T> {
  const deadline = Date.now() + budgetMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    const { done, value } = await check();
    last = value;
    if (done) return value;
    await Bun.sleep(60);
  }
  throw new Error(`${label}: timed out after ${budgetMs}ms; last observed ${JSON.stringify(last)}`);
}

async function itemOn(broker: TestBroker, id: string): Promise<RoadmapItem | undefined> {
  const res = await post<ListRes>(`${broker.url}/roadmap/list`, { project_key: PK });
  return res.body.items.find((i) => i.id === id);
}

/** Waits for a card to satisfy a predicate on one of the two brokers. */
function waitForItem(
  label: string,
  broker: TestBroker,
  id: string,
  predicate: (item: RoadmapItem) => boolean,
  budgetMs = 15_000
): Promise<RoadmapItem> {
  return pollUntil(label, budgetMs, async () => {
    const item = await itemOn(broker, id);
    return { done: item !== undefined && predicate(item), value: item };
  }) as Promise<RoadmapItem>;
}

async function syncStatus(): Promise<RoadmapSyncStatus> {
  return (await post<RoadmapSyncStatus>(`${replica.url}/roadmap/sync/status`, {})).body;
}

/** Blocks the replica's route to its upstream and waits until it has noticed. */
async function goOffline(): Promise<void> {
  upstreamBlocked = true;
  await pollUntil("replica notices the outage", 15_000, async () => {
    const status = await syncStatus();
    return { done: status.online === false, value: status.online };
  });
}

async function goOnline(): Promise<void> {
  upstreamBlocked = false;
  await pollUntil("replica reconnects", 15_000, async () => {
    const status = await syncStatus();
    return { done: status.online === true, value: status.online };
  });
}

async function createOn(broker: TestBroker, body: Record<string, unknown>): Promise<RoadmapItem> {
  const res = await post<UpsertRes>(`${broker.url}/roadmap/upsert`, {
    project_key: PK,
    ...body,
  });
  expect([JSON.stringify(body), res.status]).toEqual([JSON.stringify(body), 200]);
  return res.body.item;
}

test("a broker asked to replicate ITSELF refuses to start, loudly", async () => {
  // The one topology that cannot work: the upstream is this very process, so
  // the pass would pull back its own rows. Two brokers on one machine are NOT
  // this case (that is how this whole file runs), which is why the check is
  // "same address", not "loopback".
  const probe = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 404 }) });
  const port = probe.port;
  probe.stop(true);
  const cleanEnv = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("CLAUDE_PEERS_"))
  ) as Record<string, string>;
  const proc = Bun.spawn(["bun", "broker.ts"], {
    env: {
      ...cleanEnv,
      CLAUDE_PEERS_PORT: String(port),
      CLAUDE_PEERS_DB: `${replica.tmpDir}/self-replica.db`,
      CLAUDE_PEERS_LOG_DIR: `${replica.tmpDir}/self-replica-logs`,
      CLAUDE_PEERS_BROKER_URL: `http://127.0.0.1:${port}`,
      CLAUDE_PEERS_OFFLINE_REPLICA: "1",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  expect([
    "a self-replicating configuration exits instead of running in a loop",
    exitCode,
  ]).toEqual(["a self-replicating configuration exits instead of running in a loop", 1]);
  expect(stderr).toContain("replica mode points at this very broker");
}, 30_000);

test("a card written upstream reaches the replica", async () => {
  const card = await createOn(upstream, {
    by: "agent-upstream",
    title: "written upstream",
    description: "from the central broker",
  });
  const replicated = await waitForItem("upstream card reaches the replica", replica, card.id, (i) => i.title === "written upstream");
  expect([
    "the replicated card keeps the upstream's attribution",
    replicated.description,
    replicated.created_by,
  ]).toEqual(["the replicated card keeps the upstream's attribution", "from the central broker", "agent-upstream"]);
});

test("a card written on the replica reaches the upstream unqueued, with its attribution kept", async () => {
  const card = await createOn(replica, {
    by: "agent-local",
    title: "written on the replica",
    description: "offline work",
    queue: 4,
  });
  expect(card.queue).toBe(4);
  const upstreamCard = await waitForItem("replica card reaches the upstream", upstream, card.id, (i) => i.title === "written on the replica");
  expect([
    "the queue is a per-broker order and never crosses; the author does",
    upstreamCard.queue,
    upstreamCard.created_by,
    upstreamCard.updated_by,
    upstreamCard.description,
  ]).toEqual([
    "the queue is a per-broker order and never crosses; the author does",
    null,
    "agent-local",
    "agent-local",
    "offline work",
  ]);
});

test("both sides editing one card yields a conflict the operator resolves three ways", async () => {
  const cards: RoadmapItem[] = [];
  for (const choice of ["remote", "local", "merge_reopen"]) {
    cards.push(
      await createOn(upstream, { by: "agent-upstream", title: `to be resolved ${choice}`, description: "common base" })
    );
  }
  for (const card of cards) {
    await waitForItem("conflict fixture reaches the replica", replica, card.id, (i) => i.description === "common base");
  }

  await goOffline();
  for (const card of cards) {
    await createOn(replica, { id: card.id, by: "agent-local", description: "the replica's version", rationale: "written offline" });
    await createOn(upstream, { id: card.id, by: "agent-upstream", description: "the upstream's version" });
  }
  await goOnline();

  const conflicts = await pollUntil("the three cards are reported in conflict", 15_000, async () => {
    const res = await post<RoadmapSyncConflictsResponse>(`${replica.url}/roadmap/sync/conflicts`, {
      project_key: PK,
    });
    const ids = res.body.items.map((c) => c.local.id);
    return { done: cards.every((c) => ids.includes(c.id)), value: ids };
  });
  expect(conflicts.length).toBeGreaterThanOrEqual(3);

  const status = await syncStatus();
  expect([
    "the badge count is the number of cards awaiting arbitration",
    (status.conflicts ?? 0) >= 3,
  ]).toEqual(["the badge count is the number of cards awaiting arbitration", true]);

  const detail = (
    await post<RoadmapSyncConflictsResponse>(`${replica.url}/roadmap/sync/conflicts`, { project_key: PK })
  ).body.items.find((c) => c.local.id === cards[0]!.id)!;
  expect([
    "a conflict carries both sides and the content they diverged from",
    detail.local.description,
    detail.remote.description,
    detail.base?.description,
  ]).toEqual([
    "a conflict carries both sides and the content they diverged from",
    "the replica's version",
    "the upstream's version",
    "common base",
  ]);

  // 'remote': the upstream content is adopted, locally and definitively.
  const remoteChoice = await post<{ item: RoadmapItem }>(
    `${replica.url}/roadmap/sync/resolve`,
    deckAuthored({ id: cards[0]!.id, choice: "remote" })
  );
  expect(remoteChoice.status).toBe(200);
  expect(remoteChoice.body.item.description).toBe("the upstream's version");
  const remoteUpstream = await itemOn(upstream, cards[0]!.id);
  expect(remoteUpstream!.description).toBe("the upstream's version");

  // 'local': the replica's content is kept and pushed on the next pass.
  const localChoice = await post<{ item: RoadmapItem }>(
    `${replica.url}/roadmap/sync/resolve`,
    deckAuthored({ id: cards[1]!.id, choice: "local" })
  );
  expect(localChoice.status).toBe(200);
  expect(localChoice.body.item.description).toBe("the replica's version");
  const localUpstream = await waitForItem(
    "the kept local version reaches the upstream",
    upstream,
    cards[1]!.id,
    (i) => i.description === "the replica's version"
  );
  expect(localUpstream.rationale).toBe("written offline");

  // 'merge_reopen': field by field, then the card comes back open.
  const merged = await post<{ item: RoadmapItem }>(
    `${replica.url}/roadmap/sync/resolve`,
    deckAuthored({ id: cards[2]!.id, choice: "merge_reopen" })
  );
  expect(merged.status).toBe(200);
  expect([
    "the merge keeps the locally-changed fields and reopens the card",
    merged.body.item.description,
    merged.body.item.rationale,
    merged.body.item.status,
    merged.body.item.deleted_at,
  ]).toEqual([
    "the merge keeps the locally-changed fields and reopens the card",
    "the replica's version",
    "written offline",
    "planned",
    null,
  ]);
  await waitForItem(
    "the merged card reaches the upstream",
    upstream,
    cards[2]!.id,
    (i) => i.description === "the replica's version" && i.rationale === "written offline"
  );

  const settled = await pollUntil("every conflict is cleared", 15_000, async () => {
    const res = await post<RoadmapSyncConflictsResponse>(`${replica.url}/roadmap/sync/conflicts`, {
      project_key: PK,
    });
    const ids = res.body.items.map((c) => c.local.id);
    return { done: cards.every((c) => !ids.includes(c.id)), value: ids };
  });
  expect(settled).not.toContain(cards[0]!.id);
}, 40_000);

test("an upstream change made by the lock sweep resolves itself in favour of the replica", async () => {
  const card = await createOn(upstream, {
    by: "agent-upstream",
    title: "swept upstream",
    description: "common base",
    status: "in_progress",
  });
  await waitForItem("sweep fixture reaches the replica", replica, card.id, (i) => i.description === "common base");

  await goOffline();
  await createOn(replica, { id: card.id, by: "agent-local", description: "still working on it" });
  // Exactly what releaseStaleLocks writes when it reclaims an abandoned card,
  // reproduced by hand because the replica's agents are invisible upstream.
  const db = new Database(upstream.dbPath);
  db.run("PRAGMA busy_timeout = 3000");
  db.run(
    "UPDATE roadmap_items SET status = 'planned', locked = 0, updated_by = 'lock-sweep', updated_at = datetime('now') WHERE id = ?",
    [card.id]
  );
  db.close();
  await goOnline();

  const converged = await waitForItem(
    "the local content wins over the sweep",
    upstream,
    card.id,
    (i) => i.description === "still working on it"
  );
  expect(converged.updated_by).toBe("agent-local");
  const conflicts = (
    await post<RoadmapSyncConflictsResponse>(`${replica.url}/roadmap/sync/conflicts`, { project_key: PK })
  ).body.items.map((c) => c.local.id);
  expect([
    "a sweep-only divergence never asks the operator anything",
    conflicts.includes(card.id),
  ]).toEqual(["a sweep-only divergence never asks the operator anything", false]);
}, 40_000);

test("a real upstream edit the sweep later stamped over is a conflict, never a silent local win", async () => {
  // The auto-resolution reads WHAT the upstream changed, not who wrote last:
  // `updated_by` names the last writer only, so a human edit followed by the
  // sweep looks exactly like a sweep-only divergence -- and used to lose the
  // human's work without ever asking the operator.
  const card = await createOn(upstream, {
    by: "agent-upstream",
    title: "edited then swept",
    description: "common base",
    status: "in_progress",
  });
  await waitForItem("sweep-after-edit fixture reaches the replica", replica, card.id, (i) => i.description === "common base");

  await goOffline();
  await createOn(replica, { id: card.id, by: "agent-local", description: "still working on it" });
  // A human enriches the card upstream...
  await createOn(upstream, {
    id: card.id,
    by: "agent-upstream",
    rationale: "why this card matters, written by a human",
  });
  // ...and only THEN does the sweep reclaim it, becoming the last writer.
  const db = new Database(upstream.dbPath);
  db.run("PRAGMA busy_timeout = 3000");
  db.run(
    "UPDATE roadmap_items SET status = 'planned', locked = 0, updated_by = 'lock-sweep', updated_at = datetime('now') WHERE id = ?",
    [card.id]
  );
  db.close();
  await goOnline();

  const conflict = await pollUntil("the card is reported in conflict", 15_000, async () => {
    const res = await post<RoadmapSyncConflictsResponse>(`${replica.url}/roadmap/sync/conflicts`, {
      project_key: PK,
    });
    const found = res.body.items.find((c) => c.local.id === card.id);
    return { done: found !== undefined, value: found };
  });
  expect([
    "the operator arbitrates, and the upstream's human edit is on the remote side",
    conflict!.remote.rationale,
    conflict!.local.description,
  ]).toEqual([
    "the operator arbitrates, and the upstream's human edit is on the remote side",
    "why this card matters, written by a human",
    "still working on it",
  ]);
  const upstreamCard = await itemOn(upstream, card.id);
  expect([
    "nothing was pushed over the human edit while the operator has not chosen",
    upstreamCard!.rationale,
    upstreamCard!.description,
  ]).toEqual([
    "nothing was pushed over the human edit while the operator has not chosen",
    "why this card matters, written by a human",
    "common base",
  ]);
}, 40_000);

test("a card work-locked upstream refuses the replica's push and lands in the operator's conflicts", async () => {
  // The upstream lock guard has no replica-side twin for a card taken AFTER the
  // replica already diverged: without the push refusal, an offline edit
  // overwrites the content the upstream's own agent is working on.
  const nativePeer = await post<RegisterResponse>(`${upstream.url}/register`, {
    pid: livePid(),
    cwd: "/work/upstream-holder",
    git_root: null,
    tty: null,
    summary: "",
    host: "upstream-host",
    client_pid: livePid(),
    project_key: PK,
    group_id: "default",
    group_secret_hash: null,
  });
  const held = await createOn(upstream, {
    by: nativePeer.body.peer_id,
    instance_token: nativePeer.body.instance_token,
    title: "worked on upstream",
    description: "the upstream agent's version",
    status: "in_progress",
  });
  await waitForItem(
    "the held card and its lock reach the replica",
    replica,
    held.id,
    (i) => i.lock_scope === "remote" && i.description === "the upstream agent's version"
  );

  // A content-only edit: the card keeps the status it has, so nothing but the
  // work-lock stands between this write and the upstream.
  await createOn(replica, {
    id: held.id,
    by: "agent-local",
    description: "the replica's version",
  });

  const conflicted = await pollUntil("the refused push becomes a conflict", 20_000, async () => {
    const res = await post<RoadmapSyncConflictsResponse>(`${replica.url}/roadmap/sync/conflicts`, {
      project_key: PK,
    });
    const found = res.body.items.find((c) => c.local.id === held.id);
    return { done: found !== undefined, value: res.body.items.map((c) => c.local.id) };
  });
  expect(conflicted).toContain(held.id);
  const upstreamHeld = await itemOn(upstream, held.id);
  expect([
    "the upstream agent's content is untouched while its lock holds",
    upstreamHeld!.description,
    upstreamHeld!.locked_by,
  ]).toEqual([
    "the upstream agent's content is untouched while its lock holds",
    "the upstream agent's version",
    nativePeer.body.peer_id,
  ]);

  // Choosing 'local' does not force the write through: the next push is refused
  // by the same lock, and the card comes back for arbitration. Resolution
  // happens at push time, not in the dialog.
  const resolved = await post<{ item: RoadmapItem }>(
    `${replica.url}/roadmap/sync/resolve`,
    deckAuthored({ id: held.id, choice: "local" })
  );
  expect(resolved.status).toBe(200);
  const again = await pollUntil("the lock still refuses the kept local version", 20_000, async () => {
    const res = await post<RoadmapSyncConflictsResponse>(`${replica.url}/roadmap/sync/conflicts`, {
      project_key: PK,
    });
    return {
      done: res.body.items.some((c) => c.local.id === held.id),
      value: res.body.items.map((c) => c.local.id),
    };
  });
  expect([
    "a lock held upstream keeps refusing until it is released, and says so every time",
    again.includes(held.id),
    (await itemOn(upstream, held.id))!.description,
  ]).toEqual([
    "a lock held upstream keeps refusing until it is released, and says so every time",
    true,
    "the upstream agent's version",
  ]);
}, 40_000);

test("a lock-sweep divergence under a lock held upstream is still reported, never retried in silence", async () => {
  // The one case where the two rules meet: the upstream row IS a sweep-only
  // divergence (so the pull resolves it 'local'), and the card is ALSO locked
  // upstream, so the push that follows is refused. Read on `updated_by` alone
  // the refusal looks resolvable, and the pass would re-send the same card
  // every tick without the operator ever being told.
  const card = await createOn(upstream, {
    by: "agent-upstream",
    title: "swept, then taken by another replica",
    description: "common base",
    status: "in_progress",
  });
  await waitForItem("fixture reaches the replica", replica, card.id, (i) => i.description === "common base");

  await goOffline();
  await createOn(replica, { id: card.id, by: "agent-local", description: "still working on it" });
  const db = new Database(upstream.dbPath);
  db.run("PRAGMA busy_timeout = 3000");
  db.run(
    "UPDATE roadmap_items SET status = 'planned', locked = 0, locked_by = NULL, updated_by = 'lock-sweep', updated_at = datetime('now') WHERE id = ?",
    [card.id]
  );
  db.close();
  // Another replica relays the lock for one of ITS agents: no content changes,
  // so the sweep stays the last content writer upstream.
  const otherClaim = await post<{ scope?: string }>(`${upstream.url}/roadmap/sync/lock`, {
    replica_id: "replica-elsewhere",
    id: card.id,
    action: "claim",
    owner: { peer_id: "agent-elsewhere", group_id: "default" },
  });
  expect(["another replica holds the card upstream", otherClaim.status]).toEqual([
    "another replica holds the card upstream",
    200,
  ]);
  await goOnline();

  const listed = await pollUntil("the refused card reaches the operator", 20_000, async () => {
    const res = await post<RoadmapSyncConflictsResponse>(`${replica.url}/roadmap/sync/conflicts`, {
      project_key: PK,
    });
    return {
      done: res.body.items.some((c) => c.local.id === card.id),
      value: res.body.items.map((c) => c.local.id),
    };
  });
  expect(listed).toContain(card.id);
  const status = await syncStatus();
  expect([
    "a refusal the protocol has an answer for is a conflict, not a validation refusal",
    status.online,
    status.refused ?? 0,
    (await itemOn(upstream, card.id))!.description,
  ]).toEqual([
    "a refusal the protocol has an answer for is a conflict, not a validation refusal",
    true,
    0,
    "common base",
  ]);
}, 40_000);

test("the dispatch queue is owned by the upstream: its order arrives, a local reorder never leaves", async () => {
  const first = await createOn(upstream, { by: "agent-upstream", title: "queue head" });
  const second = await createOn(upstream, { by: "agent-upstream", title: "queue tail" });
  const ordered = await post<{ ids: string[] }>(`${upstream.url}/roadmap/reorder`, {
    project_key: PK,
    by: "agent-upstream",
    ids: [first.id, second.id],
  });
  expect(ordered.status).toBe(200);

  await waitForItem("the upstream order reaches the replica", replica, first.id, (i) => i.queue === 1);
  await waitForItem("the upstream order reaches the replica", replica, second.id, (i) => i.queue === 2);

  const reordered = await post<{ ids: string[] }>(`${replica.url}/roadmap/reorder`, {
    project_key: PK,
    by: "agent-local",
    ids: [second.id, first.id],
  });
  expect(reordered.status).toBe(200);

  const localOrder = await itemOn(replica, first.id);
  expect(localOrder!.queue).toBe(2);
  const upstreamHead = await itemOn(upstream, first.id);
  expect([
    "a queue position never travels upstream",
    upstreamHead!.queue,
  ]).toEqual(["a queue position never travels upstream", 1]);

  // The local order survives only until the upstream sends that card again:
  // the pull carries the upstream position on every row it delivers, so the
  // next upstream write on this card takes the local order back. Reordering
  // offline is therefore lost, per card, as the card comes back -- the
  // assumed consequence of the upstream owning the queue.
  await createOn(upstream, { id: first.id, by: "agent-upstream", description: "touched upstream" });
  await waitForItem(
    "the upstream order comes back with the row",
    replica,
    first.id,
    (i) => i.description === "touched upstream" && i.queue === 1
  );
}, 40_000);

test("a contest raised on another replica reaches this one, and its own contest is not echoed back", async () => {
  // `lock_contested_by` is written upstream and travels in the pull row. Without
  // it landing on the local row an agent on a replica has no way to learn that
  // the card it is looking at is disputed on another machine -- the field would
  // read `[]` on every replica in the deployment.
  const nativePeer = await post<RegisterResponse>(`${upstream.url}/register`, {
    pid: livePid(),
    cwd: "/work/upstream-contested",
    git_root: null,
    tty: null,
    summary: "",
    host: "upstream-host",
    client_pid: livePid(),
    project_key: PK,
    group_id: "default",
    group_secret_hash: null,
  });
  const localPeer = await post<RegisterResponse>(`${replica.url}/register`, {
    pid: livePid(),
    cwd: "/work/replica-contested",
    git_root: null,
    tty: null,
    summary: "",
    host: "replica-host",
    client_pid: livePid(),
    project_key: PK,
    group_id: "default",
    group_secret_hash: null,
  });
  const held = await createOn(upstream, {
    by: nativePeer.body.peer_id,
    instance_token: nativePeer.body.instance_token,
    title: "disputed across three machines",
    status: "in_progress",
  });
  await waitForItem("the upstream lock is mirrored here", replica, held.id, (i) => i.lock_scope === "remote");

  // A THIRD broker -- another replica of the same upstream -- claims it and is
  // refused, exactly as this replica's pass would be.
  const beta = await post<{ item?: RoadmapItem }>(`${upstream.url}/roadmap/sync/lock`, {
    replica_id: "replica-beta",
    id: held.id,
    action: "claim",
    owner: { peer_id: "agent-beta", group_id: null },
  });
  expect(["a claim on a card locked upstream is contested", beta.status]).toEqual([
    "a claim on a card locked upstream is contested",
    409,
  ]);

  const seen = await waitForItem(
    "the other replica's contest reaches this one",
    replica,
    held.id,
    (i) => i.lock_contested_by.includes("agent-beta@replica-beta")
  );
  expect([
    "an agent on this replica reads who else holds the card, not an empty list",
    seen.lock_contested_by,
  ]).toEqual([
    "an agent on this replica reads who else holds the card, not an empty list",
    ["agent-beta@replica-beta"],
  ]);

  // This replica contests it too: the upstream now lists BOTH, and the entry
  // naming this very replica must not come back as somebody else's hold.
  const forced = await post<UpsertRes>(`${replica.url}/roadmap/upsert`, {
    project_key: PK,
    id: held.id,
    by: localPeer.body.peer_id,
    instance_token: localPeer.body.instance_token,
    status: "in_progress",
    locked: true,
    force: true,
  });
  expect(forced.status).toBe(200);
  const ownTag = `${localPeer.body.peer_id}@${replicaId}`;
  await pollUntil("the upstream lists both contesting holders", 15_000, async () => {
    const item = await itemOn(upstream, held.id);
    const list = item?.lock_contested_by ?? [];
    return { done: list.includes(ownTag) && list.includes("agent-beta@replica-beta"), value: list };
  });
  const bothUpstream = await itemOn(replica, held.id);
  expect([
    "this replica's own contest stays its lock_scope, never a foreign holder",
    bothUpstream!.lock_contested_by,
    bothUpstream!.lock_scope,
  ]).toEqual([
    "this replica's own contest stays its lock_scope, never a foreign holder",
    ["agent-beta@replica-beta"],
    "contested",
  ]);

  // The other replica withdraws: the upstream list empties, and so does this
  // one -- a mirrored annotation that only ever grew would strand a lock that
  // nobody disputes any more.
  const withdrawn = await post(`${upstream.url}/roadmap/sync/lock`, {
    replica_id: "replica-beta",
    id: held.id,
    action: "release",
    owner: { peer_id: "agent-beta", group_id: null },
  });
  expect(["the withdrawal is accepted", withdrawn.status]).toEqual(["the withdrawal is accepted", 200]);
  const emptied = await waitForItem(
    "the emptied upstream list empties this one",
    replica,
    held.id,
    (i) => i.lock_contested_by.length === 0
  );
  expect([
    "nothing is left behind once the other replica gave up",
    emptied.lock_contested_by,
  ]).toEqual(["nothing is left behind once the other replica gave up", []]);
}, 60_000);

test("queue_replaced counts the local positions the upstream order took back, and only those", async () => {
  // The queue is the one field a replica never pushes, so an offline reorder is
  // lost at reconnection. The log line says so once per page; this counter is
  // what lets a poller notice it after the fact, so it must move by exactly the
  // number of rows whose local position differed -- and not move at all on a
  // pass that changed nothing.
  const before = (await syncStatus()).queue_replaced;
  expect(
    typeof before,
    "queue_replaced is published in replica mode, as a number, before anything is replaced"
  ).toBe("number");

  const head = await createOn(upstream, { by: "agent-upstream", title: "counted head" });
  const tail = await createOn(upstream, { by: "agent-upstream", title: "counted tail" });
  expect(
    (
      await post<{ ids: string[] }>(`${upstream.url}/roadmap/reorder`, {
        project_key: PK,
        by: "agent-upstream",
        ids: [head.id, tail.id],
      })
    ).status
  ).toBe(200);
  const headQueue = (await waitForItem("the upstream order reaches the replica", replica, head.id, (i) => i.queue !== null)).queue!;
  await waitForItem("the upstream order reaches the replica", replica, tail.id, (i) => i.queue !== null);
  const settled = (await syncStatus()).queue_replaced;

  await goOffline();
  // Both rows get a LOCAL position that differs from the upstream one, and the
  // upstream then writes both cards so the reconnection pull carries them back.
  const localOrder = await post<{ ids: string[] }>(`${replica.url}/roadmap/reorder`, {
    project_key: PK,
    by: "agent-local",
    ids: [tail.id, head.id],
  });
  expect(localOrder.status).toBe(200);
  expect(
    (await itemOn(replica, head.id))!.queue,
    "the offline reorder really moved the head, otherwise the pull would replace nothing"
  ).not.toBe(headQueue);
  await createOn(upstream, { id: head.id, by: "agent-upstream", description: "touched while offline" });
  await createOn(upstream, { id: tail.id, by: "agent-upstream", description: "touched while offline" });
  await goOnline();

  await waitForItem(
    "the upstream order comes back with the head",
    replica,
    head.id,
    (i) => i.description === "touched while offline" && i.queue === headQueue
  );
  await waitForItem(
    "the upstream order comes back with the tail",
    replica,
    tail.id,
    (i) => i.description === "touched while offline"
  );

  const after = await pollUntil("the pass that applied the page publishes its snapshot", 15_000, async () => {
    const value = (await syncStatus()).queue_replaced ?? 0;
    return { done: value >= (settled ?? 0) + 2, value };
  });
  expect([
    "exactly the two rows whose local position differed are counted",
    after,
  ]).toEqual(["exactly the two rows whose local position differed are counted", (settled ?? 0) + 2]);

  // Several further passes, with nothing left to apply: the counter is a
  // broker-lifetime total, not a per-pass one, so an empty pull must neither
  // grow it nor reset it. `last_sync_at` changes once per completed pass, so
  // waiting for two distinct values waits for two real passes rather than a
  // fixed sleep.
  const seenPasses = new Set<string>();
  await pollUntil("two further passes complete with nothing to apply", 15_000, async () => {
    const status = await syncStatus();
    if (status.last_sync_at) seenPasses.add(status.last_sync_at);
    return { done: seenPasses.size >= 3, value: seenPasses.size };
  });
  expect([
    "a pull that replaces nothing leaves the counter where it was",
    (await syncStatus()).queue_replaced,
  ]).toEqual(["a pull that replaces nothing leaves the counter where it was", after]);
}, 60_000);

test("with its upstream unreachable the replica keeps serving, counts what is waiting, then drains it", async () => {
  await goOffline();
  const offlineCard = await createOn(replica, {
    by: "agent-local",
    title: "written during the outage",
    description: "queued for the reconnection",
  });
  const offline = await syncStatus();
  expect([
    "an unreachable upstream is a state the operator can read, not an error the agents see",
    offline.mode,
    offline.online,
    (offline.pending_push ?? 0) >= 1,
    typeof offline.last_error === "string",
  ]).toEqual([
    "an unreachable upstream is a state the operator can read, not an error the agents see",
    "replica",
    false,
    true,
    true,
  ]);
  expect(await itemOn(replica, offlineCard.id)).toBeDefined();

  await goOnline();
  await waitForItem("the backlog drains on reconnection", upstream, offlineCard.id, (i) => i.description === "queued for the reconnection");
  const drained = await pollUntil("nothing is left waiting", 15_000, async () => {
    const status = await syncStatus();
    return { done: (status.pending_push ?? 0) === 0, value: status.pending_push };
  });
  expect(drained).toBe(0);
}, 40_000);

test("a lock taken on the replica is relayed upstream, and one taken upstream blocks the replica's agents", async () => {
  const localPeer = await post<RegisterResponse>(`${replica.url}/register`, {
    pid: livePid(),
    cwd: "/work/replica-agent",
    git_root: null,
    tty: null,
    summary: "",
    host: "replica-host",
    client_pid: livePid(),
    project_key: PK,
    group_id: "default",
    group_secret_hash: null,
  });
  const relayed = await createOn(replica, {
    by: localPeer.body.peer_id,
    instance_token: localPeer.body.instance_token,
    title: "locked on the replica",
    status: "in_progress",
  });
  expect(relayed.locked).toBe(true);

  const upstreamView = await waitForItem(
    "the replica's lock is relayed upstream",
    upstream,
    relayed.id,
    (i) => i.locked
  );
  expect(upstreamView.locked_by).toBe(localPeer.body.peer_id);
  const upstreamDb = new Database(upstream.dbPath);
  const relayRow = upstreamDb
    .query("SELECT lock_relay, locked_by_token FROM roadmap_items WHERE id = ?")
    .get(relayed.id) as { lock_relay: string | null; locked_by_token: string | null };
  expect([
    "the upstream knows which replica carries the lock, and never the agent's token",
    relayRow.lock_relay,
    relayRow.locked_by_token,
  ]).toEqual([
    "the upstream knows which replica carries the lock, and never the agent's token",
    replicaId,
    null,
  ]);
  const scoped = await waitForItem(
    "the replica records the lock as global once the upstream accepted it",
    replica,
    relayed.id,
    (i) => i.lock_scope === "global"
  );
  expect(scoped.lock_scope).toBe("global");

  // A native upstream peer takes a different card: the replica mirrors the
  // lock and its own agents are refused by the ordinary work-lock guard.
  const nativePeer = await post<RegisterResponse>(`${upstream.url}/register`, {
    pid: livePid(),
    cwd: "/work/upstream-agent",
    git_root: null,
    tty: null,
    summary: "",
    host: "upstream-host",
    client_pid: livePid(),
    project_key: PK,
    group_id: "default",
    group_secret_hash: null,
  });
  const heldUpstream = await createOn(upstream, {
    by: nativePeer.body.peer_id,
    instance_token: nativePeer.body.instance_token,
    title: "locked upstream by a native peer",
    status: "in_progress",
  });
  const mirrored = await waitForItem(
    "an upstream lock is mirrored with a remote scope",
    replica,
    heldUpstream.id,
    (i) => i.lock_scope === "remote"
  );
  expect([
    "the mirrored lock shows the holder but carries no credential",
    mirrored.locked,
    mirrored.locked_by,
    mirrored.locked_by_token,
  ]).toEqual([
    "the mirrored lock shows the holder but carries no credential",
    true,
    nativePeer.body.peer_id,
    null,
  ]);
  const refused = await post<{ error?: string }>(`${replica.url}/roadmap/upsert`, {
    project_key: PK,
    id: heldUpstream.id,
    by: localPeer.body.peer_id,
    instance_token: localPeer.body.instance_token,
    status: "in_progress",
  });
  expect([
    "a lock held on another machine refuses a local agent exactly like a local one",
    refused.status,
  ]).toEqual(["a lock held on another machine refuses a local agent exactly like a local one", 409]);

  // Forced through anyway: the claim goes upstream, is refused there, and the
  // card is marked contested on both sides.
  const forced = await post<UpsertRes>(`${replica.url}/roadmap/upsert`, {
    project_key: PK,
    id: heldUpstream.id,
    by: localPeer.body.peer_id,
    instance_token: localPeer.body.instance_token,
    status: "in_progress",
    // An explicit claim, not just a status write: an in_progress write on an
    // already-locked card never takes the lock on its own.
    locked: true,
    force: true,
  });
  expect(forced.status).toBe(200);
  const contested = await waitForItem(
    "a lock refused upstream is contested, not granted",
    replica,
    heldUpstream.id,
    (i) => i.lock_scope === "contested"
  );
  expect(contested.lock_scope).toBe("contested");
  const contestedUpstream = await pollUntil("the upstream lists the contesting holder", 15_000, async () => {
    const item = await itemOn(upstream, heldUpstream.id);
    return {
      done: (item?.lock_contested_by ?? []).includes(`${localPeer.body.peer_id}@${replicaId}`),
      value: item?.lock_contested_by,
    };
  });
  expect(contestedUpstream).toEqual([`${localPeer.body.peer_id}@${replicaId}`]);
  expect((await itemOn(upstream, heldUpstream.id))!.locked_by).toBe(nativePeer.body.peer_id);
  upstreamDb.close();
}, 40_000);

test("an author relayed through the upstream comes back stripped of the relay this replica added", async () => {
  // The operator signs a card here; upstream it is stored as this replica's
  // relay of 'deck', so no upstream reader mistakes it for its OWN operator.
  // Coming back down, that prefix names US -- the operator must not discover
  // their own writes credited to a machine.
  const card = await createOn(
    replica,
    deckAuthored({ project_key: PK, title: "signed by the operator", description: "operator work" })
  );
  const relayed = await waitForItem(
    "the signed card reaches the upstream",
    upstream,
    card.id,
    (i) => i.description === "operator work"
  );
  const prefix = `via:${replicaId.slice(0, 8)}:`;
  expect([
    "upstream, the operator of another machine is named as that machine's relay",
    relayed.created_by,
    relayed.updated_by,
  ]).toEqual([
    "upstream, the operator of another machine is named as that machine's relay",
    `${prefix}deck`,
    `${prefix}deck`,
  ]);

  // Forget the card locally and rewind the cursor: the replica pulls it back as
  // a card it has never seen, which is exactly how a re-cloned replica meets its
  // own past writes.
  const db = new Database(replica.dbPath);
  db.run("PRAGMA busy_timeout = 3000");
  db.run("DELETE FROM roadmap_items WHERE id = ?", [card.id]);
  db.run("UPDATE roadmap_sync_meta SET value = '0' WHERE key = 'upstream_cursor'");
  db.close();

  const returned = await waitForItem(
    "the card comes back down",
    replica,
    card.id,
    (i) => i.description === "operator work"
  );
  expect([
    "on the machine that made them, the operator's writes read 'deck' again",
    returned.created_by,
    returned.updated_by,
  ]).toEqual([
    "on the machine that made them, the operator's writes read 'deck' again",
    "deck",
    "deck",
  ]);
}, 40_000);

test("an import on the replica is a local edit like any other: counted as pending, and pushed", async () => {
  // /roadmap/import writes with INSERT OR REPLACE, which fires the INSERT
  // trigger and never the UPDATE one -- the trigger that marks a card dirty.
  // Left to itself the import lands locally, is never pushed, and the next pull
  // silently overwrites it with the upstream content.
  const card = await createOn(upstream, {
    by: "agent-upstream",
    title: "imported over",
    description: "the upstream version",
  });
  await waitForItem("import fixture reaches the replica", replica, card.id, (i) => i.description === "the upstream version");

  await goOffline();
  const pendingBefore = (await syncStatus()).pending_push ?? 0;
  const imported = await post<{ imported: number; skipped: string[] }>(
    `${replica.url}/roadmap/import`,
    deckAuthored({
      project_key: PK,
      items: [
        {
          id: card.id,
          kind: card.kind,
          title: "imported over",
          description: "the imported version",
          priority: card.priority,
          value: card.value,
          effort: card.effort,
          status: card.status,
        },
      ],
    })
  );
  expect([imported.status, imported.body.imported]).toEqual([200, 1]);
  const afterImport = await syncStatus();
  expect([
    "an imported change is waiting to be pushed like any other local edit",
    (afterImport.pending_push ?? 0) - pendingBefore,
  ]).toEqual(["an imported change is waiting to be pushed like any other local edit", 1]);

  await goOnline();
  const upstreamCard = await waitForItem(
    "the imported change reaches the upstream",
    upstream,
    card.id,
    (i) => i.description === "the imported version"
  );
  expect(upstreamCard.description).toBe("the imported version");

  // The same file imported twice changes nothing, so it owes the upstream
  // nothing: the comparison is on the content, not on the fact of writing.
  const settled = await pollUntil("the backlog drains", 15_000, async () => {
    const status = await syncStatus();
    return { done: (status.pending_push ?? 0) === 0, value: status.pending_push };
  });
  expect(settled).toBe(0);
  const reimported = await post<{ imported: number }>(
    `${replica.url}/roadmap/import`,
    deckAuthored({
      project_key: PK,
      items: [
        {
          id: card.id,
          kind: card.kind,
          title: "imported over",
          description: "the imported version",
          priority: card.priority,
          value: card.value,
          effort: card.effort,
          status: card.status,
        },
      ],
    })
  );
  expect(reimported.status).toBe(200);
  expect([
    "re-importing identical content owes the upstream nothing",
    (await syncStatus()).pending_push ?? 0,
  ]).toEqual(["re-importing identical content owes the upstream nothing", 0]);
}, 60_000);

test("one row the upstream refuses does not stop the pass, and never reads as an outage", async () => {
  // A 4xx that is not a conflict is a validation refusal: the row cannot be
  // fixed by retrying, but the twenty behind it are fine. Aborting the pass on
  // it stopped replication for good and reported the upstream unreachable --
  // the operator sees an outage that does not exist while their work piles up.
  await goOffline();
  const poison = await createOn(replica, { by: "agent-local", title: "the upstream will refuse this" });
  const db = new Database(replica.dbPath);
  db.run("PRAGMA busy_timeout = 3000");
  // An author no upstream accepts: the identity charset refuses the empty
  // string, and every push of this card is answered 400 for as long as it says
  // so. Written straight to the column because no route would accept it.
  db.run("UPDATE roadmap_items SET created_by = '' WHERE id = ?", [poison.id]);
  db.close();
  const healthy = await createOn(replica, {
    by: "agent-local",
    title: "behind the refused one",
    description: "must still travel",
  });

  upstreamBlocked = false;
  await waitForItem(
    "the row behind the refused one still reaches the upstream",
    upstream,
    healthy.id,
    (i) => i.description === "must still travel"
  );
  // Waits for the SNAPSHOT, not for a count: the pass publishes its counts and
  // its verdict together, so `refused` and `online` are read from the same
  // pass or not at all.
  const status = await pollUntil("the refusal is counted", 15_000, async () => {
    const s = await syncStatus();
    return { done: s.online === true && (s.refused ?? 0) >= 1, value: s };
  });
  expect([
    "a refused row is reported as such, and the upstream is still online",
    status.online,
    status.refused,
    (status.last_error ?? "").includes(poison.id),
  ]).toEqual([
    "a refused row is reported as such, and the upstream is still online",
    true,
    1,
    true,
  ]);
  expect(await itemOn(upstream, poison.id)).toBeUndefined();

  // Fixing the card upstream-acceptable clears the refusal: the count is live
  // state, not a tally of everything that ever failed.
  const db2 = new Database(replica.dbPath);
  db2.run("PRAGMA busy_timeout = 3000");
  db2.run("UPDATE roadmap_items SET created_by = 'agent-local' WHERE id = ?", [poison.id]);
  db2.close();
  await waitForItem("the fixed row departs on its own", upstream, poison.id, (i) => i.title === "the upstream will refuse this");
  const cleared = await pollUntil("the refusal count clears", 15_000, async () => {
    const s = await syncStatus();
    return { done: (s.refused ?? 0) === 0, value: s.refused };
  });
  expect(["nothing is refused any more", cleared]).toEqual(["nothing is refused any more", 0]);
}, 60_000);

test("a lock claim the upstream refuses stops that claim only, not the pass", async () => {
  const peer = await post<RegisterResponse>(`${replica.url}/register`, {
    pid: livePid(),
    cwd: "/work/replica-lock-isolation",
    git_root: null,
    tty: null,
    summary: "",
    host: "replica-host",
    client_pid: livePid(),
    project_key: PK,
    group_id: "default",
    group_secret_hash: null,
  });
  const first = await createOn(replica, {
    by: peer.body.peer_id,
    instance_token: peer.body.instance_token,
    title: "claimed first, then poisoned",
    status: "in_progress",
  });
  await waitForItem("the first lock is asserted upstream", replica, first.id, (i) => i.lock_scope === "global");

  const db = new Database(replica.dbPath);
  db.run("PRAGMA busy_timeout = 3000");
  // An owner name outside the identity charset: every claim carrying it is
  // answered 400, and this card is claimed before the next one on every pass.
  db.run("UPDATE roadmap_items SET locked_by = 'agent@bad' WHERE id = ?", [first.id]);
  db.close();

  const second = await createOn(replica, {
    by: peer.body.peer_id,
    instance_token: peer.body.instance_token,
    title: "claimed behind the refused one",
    status: "in_progress",
  });
  const asserted = await waitForItem(
    "the claim behind the refused one still reaches the upstream",
    replica,
    second.id,
    (i) => i.lock_scope === "global"
  );
  expect(asserted.lock_scope).toBe("global");
  const status = await pollUntil("the refused claim is counted", 15_000, async () => {
    const s = await syncStatus();
    return { done: s.online === true && (s.refused_locks ?? 0) >= 1, value: s };
  });
  expect([
    "a refused claim is counted on its own, and is not an outage either",
    status.online,
    status.refused_locks,
  ]).toEqual(["a refused claim is counted on its own, and is not an outage either", true, 1]);
}, 60_000);

test("a claim the upstream refuses because the card is inactive is not read as contested", async () => {
  // 409 answers two different questions on this route. Read as one, a card the
  // operator merely set aside upstream shows up on the replica as "another
  // holder wants it", which is a lock conflict that does not exist.
  const peer = await post<RegisterResponse>(`${replica.url}/register`, {
    pid: livePid(),
    cwd: "/work/replica-inactive",
    git_root: null,
    tty: null,
    summary: "",
    host: "replica-host",
    client_pid: livePid(),
    project_key: PK,
    group_id: "default",
    group_secret_hash: null,
  });
  const card = await createOn(upstream, { by: "agent-upstream", title: "set aside upstream" });
  await waitForItem("the card reaches the replica", replica, card.id, (i) => i.title === "set aside upstream");

  await goOffline();
  const taken = await createOn(replica, {
    id: card.id,
    by: peer.body.peer_id,
    instance_token: peer.body.instance_token,
    status: "in_progress",
  });
  expect([taken.locked, taken.lock_scope]).toEqual([true, "local"]);
  const setAside = await post<UpsertRes>(
    `${upstream.url}/roadmap/upsert`,
    deckAuthored({ project_key: PK, id: card.id, inactive: true })
  );
  expect(setAside.body.item.inactive).toBe(true);

  upstreamBlocked = false;
  // A card locked here AFTER the refused one: its claim reaching the upstream
  // is the proof that the lock pass ran past the refusal.
  const behind = await createOn(replica, {
    by: peer.body.peer_id,
    instance_token: peer.body.instance_token,
    title: "claimed after the inactive one",
    status: "in_progress",
  });
  await waitForItem("the pass got past the refused claim", replica, behind.id, (i) => i.lock_scope === "global");

  const held = await itemOn(replica, card.id);
  expect([
    "a card nobody else holds is never shown as contested",
    held!.locked,
    held!.lock_scope,
  ]).toEqual(["a card nobody else holds is never shown as contested", true, "local"]);
}, 60_000);

test("an arbitration carries no credential and no operator proof, on either side", async () => {
  // The two fields that never cross the replication boundary do not cross the
  // OPERATOR boundary either: /roadmap/sync/conflicts is read by the Deck, and
  // the local side used to be projected straight from the stored row.
  const peer = await post<RegisterResponse>(`${replica.url}/register`, {
    pid: livePid(),
    cwd: "/work/replica-projection",
    git_root: null,
    tty: null,
    summary: "",
    host: "replica-host",
    client_pid: livePid(),
    project_key: PK,
    group_id: "default",
    group_secret_hash: null,
  });
  const card = await createOn(upstream, {
    by: "agent-upstream",
    title: "arbitrated card",
    description: "common base",
  });
  await waitForItem("projection fixture reaches the replica", replica, card.id, (i) => i.description === "common base");

  await goOffline();
  // A local lock (a credential lands in locked_by_token) and a signed write
  // (an operator_id lands beside it), then a divergent upstream edit.
  await createOn(replica, {
    id: card.id,
    by: peer.body.peer_id,
    instance_token: peer.body.instance_token,
    status: "in_progress",
  });
  await post<UpsertRes>(
    `${replica.url}/roadmap/upsert`,
    deckAuthored({ project_key: PK, id: card.id, description: "the replica's version" })
  );
  await createOn(upstream, { id: card.id, by: "agent-upstream", description: "the upstream's version" });
  await goOnline();

  const conflict = await pollUntil("the card is reported in conflict", 20_000, async () => {
    const res = await post<RoadmapSyncConflictsResponse>(`${replica.url}/roadmap/sync/conflicts`, {
      project_key: PK,
    });
    const found = res.body.items.find((c) => c.local.id === card.id);
    return { done: found !== undefined, value: found };
  });

  const db = new Database(replica.dbPath);
  const stored = db
    .query("SELECT locked_by_token, operator_id FROM roadmap_items WHERE id = ?")
    .get(card.id) as { locked_by_token: string | null; operator_id: string | null };
  db.close();
  expect([
    "the stored row DOES carry both, so their absence below is the projection at work",
    stored.locked_by_token !== null,
    stored.operator_id !== null,
  ]).toEqual([
    "the stored row DOES carry both, so their absence below is the projection at work",
    true,
    true,
  ]);

  const leaked = (side: unknown): string[] =>
    Object.keys(side as Record<string, unknown>).filter(
      (k) => k === "locked_by_token" || k === "operator_id"
    );
  expect([
    "neither the local nor the remote side of an arbitration carries a credential or an operator proof",
    leaked(conflict!.local),
    leaked(conflict!.remote),
  ]).toEqual([
    "neither the local nor the remote side of an arbitration carries a credential or an operator proof",
    [],
    [],
  ]);

  // The remote side is a blob read back from a column: give it the two fields
  // and the response must still not carry them. Without the pick-list this
  // stored object would be handed to the Deck as it stands.
  const poisoned = new Database(replica.dbPath);
  poisoned.run("PRAGMA busy_timeout = 3000");
  const rawRemote = JSON.parse(
    (
      poisoned.query("SELECT sync_remote FROM roadmap_items WHERE id = ?").get(card.id) as {
        sync_remote: string;
      }
    ).sync_remote
  ) as Record<string, unknown>;
  rawRemote.locked_by_token = "a-token-that-must-not-travel";
  rawRemote.operator_id = "an-operator-proof-that-must-not-travel";
  poisoned.run("UPDATE roadmap_items SET sync_remote = ? WHERE id = ?", [
    JSON.stringify(rawRemote),
    card.id,
  ]);
  poisoned.close();

  const reread = (
    await post<RoadmapSyncConflictsResponse>(`${replica.url}/roadmap/sync/conflicts`, {
      project_key: PK,
    })
  ).body.items.find((c) => c.local.id === card.id)!;
  expect([
    "the stored upstream row is rebuilt field by field, so what it gained never reaches the operator",
    leaked(reread.remote),
    reread.remote.description,
  ]).toEqual([
    "the stored upstream row is rebuilt field by field, so what it gained never reaches the operator",
    [],
    "the upstream's version",
  ]);
}, 60_000);

test("a batch full of rows the upstream refuses never starves the row behind them", async () => {
  // The push batch is ordered by content_rev and capped: rows the upstream
  // refuses keep their revision and their place at the head, so a batch's worth
  // of them is a wall the next card never gets past -- replication silently
  // stops for everything written afterwards.
  await goOffline();
  const poison: string[] = [];
  for (let i = 0; i < 51; i++) {
    const card = await createOn(replica, { by: "agent-local", title: `refused row ${i}` });
    poison.push(card.id);
  }
  const db = new Database(replica.dbPath);
  db.run("PRAGMA busy_timeout = 3000");
  db.run(
    `UPDATE roadmap_items SET created_by = '' WHERE id IN (${poison.map(() => "?").join(", ")})`,
    poison
  );
  db.close();
  const healthy = await createOn(replica, {
    by: "agent-local",
    title: "written behind the wall",
    description: "must still travel",
  });

  upstreamBlocked = false;
  await waitForItem(
    "the row behind a full batch of refusals still reaches the upstream",
    upstream,
    healthy.id,
    (i) => i.description === "must still travel",
    30_000
  );
  const status = await pollUntil("every refusal is accounted for", 20_000, async () => {
    const s = await syncStatus();
    return { done: (s.refused ?? 0) >= poison.length, value: s };
  });
  expect([
    "the wall is reported in full, and the upstream is not called unreachable for it",
    status.refused,
    status.online,
  ]).toEqual([
    "the wall is reported in full, and the upstream is not called unreachable for it",
    poison.length,
    true,
  ]);
}, 90_000);
