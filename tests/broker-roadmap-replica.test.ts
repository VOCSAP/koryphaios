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
  post,
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

type UpsertRes = { item: RoadmapItem };
type ListRes = { items: RoadmapItem[] };

let upstream: TestBroker;
let replica: TestBroker;
let proxy: ReturnType<typeof Bun.serve>;
let replicaId: string;
/** Flipped by the tests: the replica's only route to its upstream goes through here. */
let upstreamBlocked = false;

beforeAll(async () => {
  upstream = await startBroker();
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
