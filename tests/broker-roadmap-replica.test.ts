// The replication pass end to end: two real brokers, the second running in
// replica mode against the first. The replica reaches its upstream through a
// proxy this file controls, so "the network is down" is a deliberate state and
// not a race -- every divergence below is set up inside a blocked window and
// asserted after it reopens, with no fixed sleeps anywhere.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  startBroker,
  stopBroker,
  livePid,
  deckAuthored,
  scrubEnv,
  type TestBroker,
  openBrokerDb,
} from "./_helper.ts";
import { reachedWithin } from "./_bounded-await.ts";
import { ROADMAP_TITLE_MAX } from "../shared/roadmap-title.ts";
import type {
  RegisterResponse,
  RoadmapContextDocument,
  RoadmapContextDocumentDeportResponse,
  RoadmapContextDocumentGetResponse,
  RoadmapContextDocumentSyncPushResponse,
  RoadmapItem,
  RoadmapSyncConflictsResponse,
  RoadmapSyncPullResponse,
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
/**
 * Distinct from `upstreamBlocked`: the replica stays ONLINE (push, lock,
 * everything else still reaches the real upstream), only `/roadmap/sync/pull`
 * is answered here with an empty page at the caller's own cursor -- a "the
 * connection is fine, there is simply nothing new yet" upstream, not a
 * network cut.
 */
let pullSuppressed = false;
/** Mirrors `pullSuppressed` for the push route: a transport 503, retried later, never a refusal. */
let pushSuppressed = false;
let documentPullIncludesInvalid = false;
let documentPullImmutableConflict: { documentId: string; unit: RoadmapContextDocument["units"][number] } | null = null;
/** Documents the proxy prepends to every context-document pull page, as an older upstream could serve them. */
let documentPullExtra: unknown[] = [];
/** Rows the proxy prepends to every roadmap pull page, as a broken upstream could serve them. */
let roadmapPullExtra: unknown[] = [];
/** Runs once between the upstream accepting a push and the replica reading the answer. */
let duringNextPush: (() => Promise<void>) | null = null;
/** Answers every pull as an upstream that predates `queue_revs` would. */
let pullStripQueueRevs = false;
/**
 * Armed with a revision: the next pull that returns rows is padded to a full
 * page (the replica takes it for an intermediate one) carrying that revision
 * for the test project, then every later pull is refused until the count is
 * reset to null. The count is the refused pulls so far.
 */
let pullPadRev: number | null = null;
let pullBlockedCalls: number | null = null;
/**
 * Every pull page is padded to a full page with copies of the last row served,
 * so the replica never reaches a final page and stops at its page cap;
 * `fullPagesServed` counts them.
 */
let pullFullPages = false;
let fullPagesServed = 0;
let fullPageRow: unknown = null;
/** Answers /roadmap/sync/push with a 422: a refusal about the card, so the pass goes on (a 503 would abort it). */
let pushRefused = false;
/** Answers /roadmap/sync/queue-delta with this instead of asking the upstream. */
let queueDeltaOverride = null as { status: number; body: unknown } | null;
/** The next n queue-delta requests reach the upstream, which commits them; the replica gets a 503 instead of the answer. */
let queueDeltaLoseAnswers = 0;
/** 503 on /roadmap/sync/queue-delta without asking the upstream. */
let queueDeltaSuppressed = false;
/** Every queue-delta request the replica made, in order. */
type QueueDeltaSeen = { mutation_id: string; expected_queue_rev: number; ops: Array<{ op: string; ids?: string[] }> };
const queueDeltaSeen: QueueDeltaSeen[] = [];
/** Runs once, while the next queue-delta request is held by the proxy, before it reaches the upstream. */
let duringNextQueueDelta: (() => Promise<void>) | null = null;
/** The card of every /roadmap/sync/push the replica made, as the upstream received it. */
const pushSeen: Array<{ id: string; carriesQueue: boolean }> = [];
/** Answers every pull with the upstream's `queue_revs` but no rows and the cursor where it was. */
let pullDropRows = false;
/** Replaces `queue_revs` in every pull answer, as a broken upstream could; `servedOverrides` counts them. */
let pullQueueRevsOverride: unknown = undefined;
let servedOverrides = 0;
/** Serves every pulled card without `lot_id`, as an upstream that predates lots would. */
let pullStripLot = false;
let pullRewrite = null as ((page: RoadmapSyncPullResponse) => void) | null;
const rewrittenPullCursors: number[] = [];
function withoutLotProtocol(page: RoadmapSyncPullResponse): void {
  delete page.lot_protocol;
  delete page.lot_queue_revs;
  delete page.lots;
  for (const item of page.items) delete item.lot_rank;
}

/** Serves `revs` as the default lot's revisions, in both fields a lot-aware upstream announces them in. */
function serveQueueRevs(page: RoadmapSyncPullResponse, revs: unknown): void {
  page.queue_revs = revs as Record<string, number>;
  page.lot_queue_revs = (
    typeof revs === "object" && revs !== null && !Array.isArray(revs)
      ? Object.fromEntries(Object.entries(revs).map(([key, rev]) => [key, { default: rev }]))
      : revs
  ) as Record<string, Record<string, number>>;
}

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
      if (pullSuppressed && url.pathname === "/roadmap/sync/pull" && req.method === "POST") {
        const body = JSON.parse(await req.text()) as { since_rev?: number };
        // Still a lot-aware upstream: losing the capability would make the replica pull from the start.
        return new Response(JSON.stringify({ items: [], next_rev: body.since_rev ?? 0, lot_protocol: 2 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (pushSuppressed && url.pathname === "/roadmap/sync/push" && req.method === "POST") {
        return new Response("push suppressed for a test", { status: 503 });
      }
      if (pushRefused && url.pathname === "/roadmap/sync/push" && req.method === "POST") {
        return new Response(JSON.stringify({ error: "push refused for a test" }), {
          status: 422,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname === "/roadmap/sync/queue-delta" && req.method === "POST") {
        if (queueDeltaSuppressed) return new Response("queue-delta suppressed for a test", { status: 503 });
        const text = await req.text();
        queueDeltaSeen.push(JSON.parse(text) as QueueDeltaSeen);
        if (duringNextQueueDelta) {
          const hook = duringNextQueueDelta;
          duringNextQueueDelta = null;
          await hook();
        }
        if (queueDeltaOverride) {
          const answer = queueDeltaOverride.body;
          return new Response(JSON.stringify(typeof answer === "function" ? answer() : answer), {
            status: queueDeltaOverride.status,
            headers: { "content-type": "application/json" },
          });
        }
        const forwarded = await fetch(`${upstream.url}${url.pathname}`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: req.headers.get("authorization") ?? "" },
          body: text,
        });
        if (queueDeltaLoseAnswers > 0) {
          queueDeltaLoseAnswers -= 1;
          return new Response("answer lost for a test", { status: 503 });
        }
        return forwarded;
      }
      if (pullBlockedCalls !== null && url.pathname === "/roadmap/sync/pull" && req.method === "POST") {
        pullBlockedCalls += 1;
        return new Response("pull blocked for a test", { status: 503 });
      }
      if (pullFullPages && url.pathname === "/roadmap/sync/pull" && req.method === "POST") {
        const real = await fetch(`${upstream.url}${url.pathname}`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: req.headers.get("authorization") ?? "" },
          body: await req.text(),
        });
        const page = (await real.json()) as { items: unknown[] };
        fullPageRow = page.items.at(-1) ?? fullPageRow;
        if (fullPageRow !== null) {
          while (page.items.length < 500) page.items.push(fullPageRow);
          fullPagesServed += 1;
        }
        return new Response(JSON.stringify(page), { status: real.status, headers: { "content-type": "application/json" } });
      }
      const headers: Record<string, string> = { "content-type": "application/json" };
      const auth = req.headers.get("authorization");
      if (auth) headers.authorization = auth;
      const body = req.method === "POST" ? await req.text() : undefined;
      if (url.pathname === "/roadmap/sync/push" && body !== undefined) {
        const pushed = (JSON.parse(body) as { item: { id: string } & Record<string, unknown> }).item;
        pushSeen.push({ id: pushed.id, carriesQueue: "queue" in pushed });
      }
      const response = await fetch(`${upstream.url}${url.pathname}${url.search}`, {
        method: req.method,
        headers,
        body,
      });
      if (duringNextPush && url.pathname === "/roadmap/sync/push" && req.method === "POST") {
        const hook = duringNextPush;
        duringNextPush = null;
        await hook();
      }
      if (
        (pullStripQueueRevs || pullPadRev !== null || pullQueueRevsOverride !== undefined || pullDropRows) &&
        url.pathname === "/roadmap/sync/pull" &&
        req.method === "POST"
      ) {
        const payload = (await response.json()) as RoadmapSyncPullResponse;
        if (pullDropRows) {
          payload.items = [];
          payload.next_rev = (JSON.parse(body ?? "{}") as { since_rev?: number }).since_rev ?? 0;
          if (pullQueueRevsOverride !== undefined) {
            serveQueueRevs(payload, pullQueueRevsOverride);
            servedOverrides += 1;
          }
        } else if (pullStripQueueRevs) {
          delete payload.queue_revs;
          delete payload.lot_queue_revs;
        } else if (pullQueueRevsOverride !== undefined) {
          serveQueueRevs(payload, pullQueueRevsOverride);
          servedOverrides += 1;
        } else if (payload.items.length > 0) {
          while (payload.items.length < 500) payload.items.push(payload.items[payload.items.length - 1]!);
          serveQueueRevs(payload, { [PK]: pullPadRev! });
          pullPadRev = null;
          pullBlockedCalls = 0;
        }
        return new Response(JSON.stringify(payload), {
          status: response.status,
          headers: { "content-type": "application/json" },
        });
      }
      if (pullRewrite && url.pathname === "/roadmap/sync/pull" && req.method === "POST") {
        rewrittenPullCursors.push((JSON.parse(body ?? "{}") as { since_rev: number }).since_rev);
        const payload = (await response.json()) as RoadmapSyncPullResponse;
        pullRewrite?.(payload);
        return new Response(JSON.stringify(payload), {
          status: response.status,
          headers: { "content-type": "application/json" },
        });
      }
      if (pullStripLot && url.pathname === "/roadmap/sync/pull" && req.method === "POST") {
        const payload = (await response.json()) as { items: Record<string, unknown>[] };
        for (const item of payload.items) delete item.lot_id;
        return new Response(JSON.stringify(payload), {
          status: response.status,
          headers: { "content-type": "application/json" },
        });
      }
      if (roadmapPullExtra.length > 0 && url.pathname === "/roadmap/sync/pull" && req.method === "POST") {
        const payload = await response.json() as { items: unknown[]; next_rev: number };
        return new Response(JSON.stringify({ ...payload, items: [...roadmapPullExtra, ...payload.items] }), {
          status: response.status,
          headers: { "content-type": "application/json" },
        });
      }
      if (
        (documentPullIncludesInvalid || documentPullImmutableConflict || documentPullExtra.length > 0) &&
        url.pathname === "/roadmap/context-document/sync/pull" &&
        req.method === "POST"
      ) {
        const payload = await response.json() as { documents: RoadmapContextDocument[]; next_rev: number };
        const documents: unknown[] = payload.documents.map((document) => {
          if (!documentPullImmutableConflict || document.id !== documentPullImmutableConflict.documentId) return document;
          return { ...document, units: [...document.units, documentPullImmutableConflict.unit] };
        });
        if (documentPullIncludesInvalid) documents.unshift({ id: "broken-document", units: [] });
        documents.unshift(...documentPullExtra);
        return new Response(JSON.stringify({ ...payload, documents }), {
          status: response.status,
          headers: { "content-type": "application/json" },
        });
      }
      return response;
    },
  });
  replica = await startBroker({
    CLAUDE_PEERS_BROKER_URL: `http://127.0.0.1:${proxy.port}`,
    CLAUDE_PEERS_BROKER_TOKEN: TOKEN,
    CLAUDE_PEERS_OFFLINE_REPLICA: "1",
    CLAUDE_PEERS_SYNC_TICK_MS: "150",
  });
  const db = openBrokerDb(replica.dbPath);
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

function localDocumentCounts(broker: TestBroker, documentId: string): { documents: number; units: number } {
  const db = openBrokerDb(broker.dbPath);
  try {
    const documents = (
      db.query("SELECT COUNT(*) AS n FROM roadmap_context_documents WHERE id = ?").get(documentId) as { n: number }
    ).n;
    const units = (
      db.query("SELECT COUNT(*) AS n FROM roadmap_context_document_units WHERE document_id = ?").get(documentId) as { n: number }
    ).n;
    return { documents, units };
  } finally {
    db.close();
  }
}

function localDocumentState(broker: TestBroker, documentId: string): { createdBy: string; syncDirty: number } | undefined {
  const db = openBrokerDb(broker.dbPath);
  try {
    const row = db
      .query("SELECT created_by, sync_dirty FROM roadmap_context_documents WHERE id = ?")
      .get(documentId) as { created_by: string; sync_dirty: number } | null;
    return row ? { createdBy: row.created_by, syncDirty: row.sync_dirty } : undefined;
  } finally {
    db.close();
  }
}

function localContentRev(broker: TestBroker, id: string): number {
  const db = openBrokerDb(broker.dbPath);
  try {
    return (db.query("SELECT content_rev FROM roadmap_items WHERE id = ?").get(id) as { content_rev: number }).content_rev;
  } finally {
    db.close();
  }
}

function localSyncMeta(broker: TestBroker, key: string): number {
  const db = openBrokerDb(broker.dbPath);
  try {
    return Number((db.query("SELECT value FROM roadmap_sync_meta WHERE key = ?").get(key) as { value: string }).value);
  } finally {
    db.close();
  }
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

/** A rank no wave holds goes to the end of the queue, and the upstream numbers the waves itself. */
async function holdsLastRank(card: RoadmapItem): Promise<boolean> {
  const queued = (await post<ListRes>(`${upstream.url}/roadmap/list`, { project_key: PK })).body.items.filter(
    (i) => i.queue !== null
  );
  const own = queued.find((i) => i.id === card.id)?.queue ?? null;
  return own !== null && queued.every((i) => i.id === card.id || i.queue! < own);
}

/**
 * Teardown for a test whose cards the upstream keeps refusing: the counters it
 * leaves behind are broker-lifetime state that other tests assert exactly.
 * Removed locally, the cards stop being pending or claimed, and the next pass
 * drops them from both refusal counts.
 */
async function forgetRefusedCards(ids: string[]): Promise<void> {
  const db = openBrokerDb(replica.dbPath);
  try {
    db.run(`DELETE FROM roadmap_items WHERE id IN (${ids.map(() => "?").join(", ")})`, ids);
  } finally {
    db.close();
  }
  await pollUntil("the refusal counters return to zero", 15_000, async () => {
    const s = await syncStatus();
    return { done: (s.refused ?? 0) === 0 && (s.refused_locks ?? 0) === 0, value: s };
  });
}

test("a broker asked to replicate ITSELF refuses to start, loudly", async () => {
  // The one topology that cannot work: the upstream is this very process, so
  // the pass would pull back its own rows. Two brokers on one machine are NOT
  // this case (that is how this whole file runs), which is why the check is
  // "same address", not "loopback".
  const probe = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 404 }) });
  const port = probe.port;
  probe.stop(true);
  const proc = Bun.spawn(["bun", "broker.ts"], {
    env: scrubEnv(replica.tmpDir, {
      CLAUDE_PEERS_PORT: String(port),
      CLAUDE_PEERS_DB: `${replica.tmpDir}/self-replica.db`,
      CLAUDE_PEERS_LOG_DIR: `${replica.tmpDir}/self-replica-logs`,
      CLAUDE_PEERS_BROKER_URL: `http://127.0.0.1:${port}`,
      CLAUDE_PEERS_OFFLINE_REPLICA: "1",
    }),
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

/**
 * Boots a broker on 192.0.2.1 (RFC 5737), an address no interface owns: the
 * bind itself fails, so nothing ever listens on a LAN interface whatever the
 * guard decides.
 */
async function bootOnUnownedAddress(brokerToken: string | null): Promise<{ stderr: string; exitCode: number }> {
  const probe = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 404 }) });
  const port = probe.port;
  probe.stop(true);
  const proc = Bun.spawn(["bun", "broker.ts"], {
    env: scrubEnv(replica.tmpDir, {
      CLAUDE_PEERS_PORT: String(port),
      CLAUDE_PEERS_DB: `${replica.tmpDir}/open-bind.db`,
      CLAUDE_PEERS_LOG_DIR: `${replica.tmpDir}/open-bind-logs`,
      CLAUDE_PEERS_BIND_HOST: "192.0.2.1",
      ...(brokerToken === null ? {} : { CLAUDE_PEERS_BROKER_TOKEN: brokerToken }),
    }),
    stdio: ["ignore", "ignore", "pipe"],
  });
  try {
    const stderr = await reachedWithin(new Response(proc.stderr).text(), "the broker's stderr to close");
    const exitCode = await reachedWithin(proc.exited, "the broker to exit");
    return { stderr, exitCode };
  } finally {
    proc.kill();
  }
}

test("a broker bound beyond loopback without a broker token refuses to start, loudly", async () => {
  const { stderr, exitCode } = await bootOnUnownedAddress(null);
  expect(stderr).toContain("exposes the broker beyond loopback without a broker token");
  expect(exitCode).toBe(1);
}, 30_000);

test("a broker bound beyond loopback WITH a broker token gets past the bind guard", async () => {
  const { stderr, exitCode } = await bootOnUnownedAddress("open-bind-token");
  expect(stderr).not.toContain("exposes the broker beyond loopback");
  // Bun words the bind failure per platform: "Failed to start server" on Windows and macOS, EADDRNOTAVAIL on Linux.
  expect(stderr, "the broker must reach Bun.serve and fail to bind there").toMatch(/Failed to start server|EADDRNOTAVAIL/);
  expect(exitCode).not.toBe(0);
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

test("a card written on the replica reaches the upstream with its place in the queue and its attribution kept", async () => {
  const card = await createOn(replica, {
    by: "agent-local",
    title: "written on the replica",
    description: "offline work",
    queue: 1000,
  });
  expect(card.queue).toBe(1000);
  const upstreamCard = await waitForItem(
    "replica card reaches the upstream with its place",
    upstream,
    card.id,
    (i) => i.title === "written on the replica" && i.queue !== null
  );
  expect([
    "the place is delivered by the queue mutation, the author already was",
    await holdsLastRank(card),
    upstreamCard.created_by,
    upstreamCard.description,
  ]).toEqual([
    "the place is delivered by the queue mutation, the author already was",
    true,
    "agent-local",
    "offline work",
  ]);
  // The mutation names no author per card: the rank is attributed to the replica's relay.
  expect(upstreamCard.updated_by).toMatch(/^via:[a-z0-9]+:deck$/);
});

test("a context document deported on the replica reaches the upstream through document push", async () => {
  const card = await createOn(replica, {
    by: "agent-document-local",
    title: "document born on replica",
    context: "replica document source",
  });
  const deported = await post<RoadmapContextDocumentDeportResponse>(
    `${replica.url}/roadmap/context-document/deport`,
    { id: card.id, project_key: PK, by: "agent-document-local", targets: ["body"] },
  );
  expect(["the local deport succeeds", deported.status]).toEqual(["the local deport succeeds", 200]);

  await waitForItem(
    "the linked card reaches the upstream",
    upstream,
    card.id,
    (item) => item.context.includes(deported.body.document.id),
  );
  const document = await pollUntil("the document push reaches the upstream", 15_000, async () => {
    const res = await post<RoadmapContextDocumentGetResponse>(
      `${upstream.url}/roadmap/context-document/get`,
      { id: card.id, project_key: PK, document_id: deported.body.document.id },
    );
    return { done: res.status === 200, value: res };
  });
  expect([
    "the pushed document carries its immutable source unit",
    document.body.document.units.map((unit) => unit.raw),
  ]).toEqual(["the pushed document carries its immutable source unit", ["replica document source"]]);
});

test("a pulled document is clean and restores this replica's relayed author", async () => {
  const documentId = "document-replica-relayed-author";
  const pushed = await post<RoadmapContextDocumentSyncPushResponse>(
    `${upstream.url}/roadmap/context-document/sync/push`,
    {
      replica_id: replicaId,
      document: {
        id: documentId,
        roadmap_item_id: "card-replica-relayed-author",
        project_key: PK,
        created_by: `via:${replicaId.slice(0, 8)}:agent-relayed`,
        created_at: "2026-09-24T01:00:00.000Z",
        units: [{
          id: "unit-replica-relayed-author",
          source_target: "body",
          raw: "restored provenance",
          deported_at: "2026-09-24T01:00:00.000Z",
          position: 0,
        }],
      },
    },
  );
  expect(pushed.status).toBe(200);
  const state = await pollUntil("the replica stores a clean document under its local author", 15_000, async () => {
    const current = localDocumentState(replica, documentId);
    return { done: current?.createdBy === "agent-relayed" && current.syncDirty === 0, value: current };
  });
  expect(state).toEqual({ createdBy: "agent-relayed", syncDirty: 0 });
});

test("an invalid pulled document does not block later documents in the same sync pass", async () => {
  const documentId = "document-replica-invalid-neighbor";
  documentPullIncludesInvalid = true;
  try {
    const pushed = await post<RoadmapContextDocumentSyncPushResponse>(
      `${upstream.url}/roadmap/context-document/sync/push`,
      {
        replica_id: replicaId,
        document: {
          id: documentId,
          roadmap_item_id: "card-replica-invalid-neighbor",
          project_key: PK,
          created_by: "agent-upstream",
          created_at: "2026-09-24T01:01:00.000Z",
          units: [{
            id: "unit-replica-invalid-neighbor",
            source_target: "body",
            raw: "valid document after an invalid neighbor",
            deported_at: "2026-09-24T01:01:00.000Z",
            position: 0,
          }],
        },
      },
    );
    expect(pushed.status).toBe(200);
    const state = await pollUntil("the valid document survives an invalid neighbor", 3_000, async () => {
      const current = localDocumentState(replica, documentId);
      return { done: current?.syncDirty === 0, value: current };
    });
    expect(state?.createdBy).toBe("agent-upstream");
  } finally {
    documentPullIncludesInvalid = false;
  }
});

test("a pulled context document with a miscased project_key is skipped and logged, its neighbours still land", async () => {
  const skippedId = "document-replica-miscased-key";
  const neighbourId = "document-replica-miscased-neighbour";
  const unit = (id: string) => ({
    id,
    source_target: "body",
    raw: "case guard on the document pull",
    deported_at: "2026-09-24T02:02:00.000Z",
    position: 0,
  });
  const logPath = join(replica.tmpDir, "logs", "broker.log");
  const logStart = readFileSync(logPath, "utf-8").length;
  documentPullExtra = [{
    id: skippedId,
    roadmap_item_id: "card-replica-miscased-document",
    project_key: "github.com/VOCSAP/replica-repo",
    created_by: "agent-upstream",
    created_at: "2026-09-24T02:02:00.000Z",
    units: [unit("unit-replica-miscased-key")],
  }];
  try {
    const pushed = await post<RoadmapContextDocumentSyncPushResponse>(`${upstream.url}/roadmap/context-document/sync/push`, {
      replica_id: replicaId,
      document: {
        id: neighbourId,
        roadmap_item_id: "card-replica-miscased-neighbour",
        project_key: PK,
        created_by: "agent-upstream",
        created_at: "2026-09-24T02:02:00.000Z",
        units: [unit("unit-replica-miscased-neighbour")],
      },
    });
    expect(pushed.status).toBe(200);
    await pollUntil("the canonical neighbour lands on the replica", 5_000, async () => {
      const current = localDocumentState(replica, neighbourId);
      return { done: current?.syncDirty === 0, value: current };
    });
  } finally {
    documentPullExtra = [];
  }
  expect(["the miscased document never lands", localDocumentCounts(replica, skippedId)]).toEqual([
    "the miscased document never lands",
    { documents: 0, units: 0 },
  ]);
  expect(readFileSync(logPath, "utf-8").slice(logStart)).toContain("project_key must be lowercase");
});

test("a pulled document with the same id and an extra unit is logged and never extends the local document", async () => {
  await goOffline();
  try {
    const card = await createOn(replica, {
      by: "agent-immutable-pull",
      title: "immutable pull conflict",
      context: "local immutable document",
    });
    const local = await post<RoadmapContextDocumentDeportResponse>(
      `${replica.url}/roadmap/context-document/deport`,
      { id: card.id, project_key: PK, by: "agent-immutable-pull", targets: ["body"] },
    );
    expect(local.status).toBe(200);
    const document = local.body.document;
    const upstreamInsert = await post<RoadmapContextDocumentSyncPushResponse>(
      `${upstream.url}/roadmap/context-document/sync/push`,
      { replica_id: replicaId, document },
    );
    expect(upstreamInsert.status).toBe(200);

    const logPath = join(replica.tmpDir, "logs", "broker.log");
    const logStart = readFileSync(logPath, "utf-8").length;
    documentPullImmutableConflict = {
      documentId: document.id,
      unit: {
        id: "forged-pulled-unit",
        source_target: "2026-09-24T01:02:00.000Z",
        raw: "forged immutable extension",
        deported_at: document.created_at,
        position: 1,
      },
    };
    await goOnline();

    const settled = await pollUntil("the forged immutable pull is logged without extending the local document", 15_000, async () => {
      const logged = readFileSync(logPath, "utf-8").slice(logStart).includes("different immutable unit set");
      const counts = localDocumentCounts(replica, document.id);
      return { done: logged && counts.units === 1, value: { logged, counts } };
    });
    expect(settled).toEqual({ logged: true, counts: { documents: 1, units: 1 } });
  } finally {
    documentPullImmutableConflict = null;
    if (upstreamBlocked) await goOnline();
  }
});

test("a pulled document survives before its card and its repeated units remain a set", async () => {
  pullSuppressed = true;
  const cardCursorBeforeDocumentPull = localSyncMeta(replica, "upstream_cursor");
  const documentCursorBeforeDocumentPull = localSyncMeta(replica, "upstream_context_document_cursor");
  try {
    const card = await createOn(upstream, {
      by: "agent-document-upstream",
      title: "card arrives after document",
      context: "upstream document source",
    });
    const deported = await post<RoadmapContextDocumentDeportResponse>(
      `${upstream.url}/roadmap/context-document/deport`,
      { id: card.id, project_key: PK, by: "agent-document-upstream", targets: ["body"] },
    );
    expect(["the upstream deport succeeds", deported.status]).toEqual(["the upstream deport succeeds", 200]);

    await pollUntil("the orphan document reaches the replica", 15_000, async () => {
      const counts = localDocumentCounts(replica, deported.body.document.id);
      return { done: counts.documents === 1 && counts.units === 1, value: counts };
    });
    expect([
      "the document cursor advances independently while card pull is suppressed",
      localSyncMeta(replica, "upstream_cursor"),
      localSyncMeta(replica, "upstream_context_document_cursor") > documentCursorBeforeDocumentPull,
    ]).toEqual([
      "the document cursor advances independently while card pull is suppressed",
      cardCursorBeforeDocumentPull,
      true,
    ]);
    expect(await itemOn(replica, card.id)).toBeUndefined();

    pullSuppressed = false;
    await waitForItem(
      "the parent card reaches the replica after the document",
      replica,
      card.id,
      (item) => item.context.includes(deported.body.document.id),
    );
    const linked = await post<RoadmapContextDocumentGetResponse>(
      `${replica.url}/roadmap/context-document/get`,
      { id: card.id, project_key: PK, document_id: deported.body.document.id },
    );
    expect([
      "the ordinary document route resolves the link after its parent arrives",
      linked.status,
      linked.body.document.units.map((unit) => unit.raw),
    ]).toEqual([
      "the ordinary document route resolves the link after its parent arrives",
      200,
      ["upstream document source"],
    ]);

    const contentRevBeforeDuplicatePull = localContentRev(replica, card.id);
    const db = openBrokerDb(replica.dbPath);
    db.run("UPDATE roadmap_sync_meta SET value = '0' WHERE key = 'upstream_context_document_cursor'");
    db.close();
    const repeated = await pollUntil("the replica re-pulls the document without duplication", 15_000, async () => {
      const connection = openBrokerDb(replica.dbPath);
      try {
        const cursor = (
          connection.query("SELECT value FROM roadmap_sync_meta WHERE key = 'upstream_context_document_cursor'").get() as {
            value: string;
          }
        ).value;
        const counts = localDocumentCounts(replica, deported.body.document.id);
        return { done: Number(cursor) > 0 && counts.units === 1, value: { cursor, ...counts } };
      } finally {
        connection.close();
      }
    });
    expect([
      "a document delivered twice still has one immutable unit and leaves its card revision unchanged",
      repeated.units,
      localContentRev(replica, card.id),
    ]).toEqual([
      "a document delivered twice still has one immutable unit and leaves its card revision unchanged",
      1,
      contentRevBeforeDuplicatePull,
    ]);
  } finally {
    pullSuppressed = false;
  }
});

// The four SQL statements that actually carry a content column across this
// boundary are strings: the push UPDATE, the push INSERT, the pull's content
// write and the pull's INSERT. Nothing type-checks them, and a column dropped
// from one of them leaves the sending side perfectly healthy -- versioned,
// marked dirty, every unit guard green -- while the value dies in transit.
test("a context with supersedes, and the triage it was created with, travel from a replica-born card through the push INSERT", async () => {
  const supersededAt = "2026-09-23T12:10:00.000Z";
  const context =
    "replica insert body" +
    `\n<<< append ${supersededAt} by peer-a >>>\n` +
    "obsolete replica insert evidence" +
    `\n<<< append 2026-09-23T12:10:01.000Z by peer-b supersedes ${supersededAt} >>>\n` +
    "current replica insert evidence";
  const card = await createOn(replica, {
    by: "agent-local",
    title: "context born on the replica",
    context,
    triage: "ready-for-agent",
  });
  const upstreamCard = await waitForItem(
    "the extended context reaches the upstream",
    upstream,
    card.id,
    (i) => i.context === context && i.triage === "ready-for-agent"
  );
  expect([upstreamCard.context, upstreamCard.triage]).toEqual([context, "ready-for-agent"]);
});

test("a context with supersedes and its triage, written upstream, reach the replica through pull INSERT and content UPDATE", async () => {
  const firstSupersededAt = "2026-09-23T12:11:00.000Z";
  const initialContext =
    "upstream insert body" +
    `\n<<< append ${firstSupersededAt} by peer-a >>>\n` +
    "obsolete upstream insert evidence" +
    `\n<<< append 2026-09-23T12:11:01.000Z by peer-b supersedes ${firstSupersededAt} >>>\n` +
    "current upstream insert evidence";
  const card = await createOn(upstream, {
    by: "agent-upstream",
    title: "context written upstream",
    context: initialContext,
    triage: "needs-info",
  });
  const arrived = await waitForItem(
    "the extended context reaches the replica",
    replica,
    card.id,
    (i) => i.context === initialContext && i.triage === "needs-info"
  );
  expect([arrived.context, arrived.triage]).toEqual([initialContext, "needs-info"]);

  const updatedSupersededAt = "2026-09-23T12:11:02.000Z";
  const updatedContext =
    "upstream update body" +
    `\n<<< append ${updatedSupersededAt} by peer-c >>>\n` +
    "obsolete upstream update evidence" +
    `\n<<< append 2026-09-23T12:11:03.000Z by peer-d supersedes ${updatedSupersededAt} >>>\n` +
    "current upstream update evidence";
  await post<UpsertRes>(`${upstream.url}/roadmap/upsert`, {
    id: card.id,
    by: "agent-upstream",
    context: updatedContext,
    triage: "ready-for-human",
  });
  const updated = await waitForItem(
    "an updated extended context reaches the replica",
    replica,
    card.id,
    (i) => i.context === updatedContext && i.triage === "ready-for-human"
  );
  expect([updated.context, updated.triage]).toEqual([updatedContext, "ready-for-human"]);
});

test("a context with supersedes and a triage change, made on the replica, travel through the push UPDATE", async () => {
  const initialSupersededAt = "2026-09-23T12:12:00.000Z";
  const initialContext =
    "push update body" +
    `\n<<< append ${initialSupersededAt} by peer-a >>>\n` +
    "obsolete push update evidence" +
    `\n<<< append 2026-09-23T12:12:01.000Z by peer-b supersedes ${initialSupersededAt} >>>\n` +
    "current push update evidence";
  const card = await createOn(upstream, {
    by: "agent-upstream",
    title: "context changed on the replica",
    context: initialContext,
  });
  await waitForItem("the card reaches the replica first", replica, card.id, (i) => i.context === initialContext);

  const updatedSupersededAt = "2026-09-23T12:12:02.000Z";
  const updatedContext =
    "replica push update body" +
    `\n<<< append ${updatedSupersededAt} by peer-c >>>\n` +
    "obsolete replica push update evidence" +
    `\n<<< append 2026-09-23T12:12:03.000Z by peer-d supersedes ${updatedSupersededAt} >>>\n` +
    "current replica push update evidence";
  await post<UpsertRes>(`${replica.url}/roadmap/upsert`, {
    id: card.id,
    by: "agent-local",
    context: updatedContext,
    triage: "needs-info",
  });
  const pushed = await waitForItem(
    "the updated extended context reaches the upstream",
    upstream,
    card.id,
    (i) => i.context === updatedContext && i.triage === "needs-info"
  );
  expect([pushed.context, pushed.triage]).toEqual([updatedContext, "needs-info"]);
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
  const resolvedDb = openBrokerDb(replica.dbPath, { readonly: true });
  const resolvedBase = resolvedDb
    .query("SELECT sync_base, sync_base_rev FROM roadmap_items WHERE id = ?")
    .get(cards[0]!.id) as { sync_base: string | null; sync_base_rev: number | null };
  resolvedDb.close();
  expect(
    [
      resolvedBase.sync_base_rev,
      resolvedBase.sync_base === null ? null : (JSON.parse(resolvedBase.sync_base) as RoadmapItem).description,
    ],
    "a resolution makes the upstream row the base, or the next pull diverges again"
  ).toEqual([localContentRev(upstream, cards[0]!.id), "the upstream's version"]);
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
  const db = openBrokerDb(upstream.dbPath);
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
  const db = openBrokerDb(upstream.dbPath);
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
  const db = openBrokerDb(upstream.dbPath);
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

test("the dispatch queue is GLOBAL: an upstream order arrives, and a live local reorder leaves too", async () => {
  // D2 (card f12e34f1 lot 1) exempts an empty `ids`: start from a clean slate
  // rather than composing with whatever earlier tests in this file left
  // queued, so the ranks asserted below are exact, not relative.
  const clear = await post<{ ids: string[] }>(`${upstream.url}/roadmap/reorder`, {
    project_key: PK,
    by: "agent-upstream",
    ids: [],
    waves: [],
  });
  expect(clear.status).toBe(200);
  const wasQueued = (await post<ListRes>(`${replica.url}/roadmap/list`, { project_key: PK })).body.items.filter(
    (i) => i.queue !== null
  );
  for (const item of wasQueued) {
    await waitForItem("the clear reaches the replica before the scenario starts", replica, item.id, (i) => i.queue === null);
  }

  const first = await createOn(upstream, { by: "agent-upstream", title: "queue head" });
  const second = await createOn(upstream, { by: "agent-upstream", title: "queue tail" });
  const ordered = await post<{ ids: string[] }>(`${upstream.url}/roadmap/reorder`, {
    project_key: PK,
    by: "agent-upstream",
    ids: [first.id, second.id],
    waves: [[first.id], [second.id]],
  });
  expect(ordered.status).toBe(200);

  await waitForItem("the upstream order reaches the replica", replica, first.id, (i) => i.queue === 1);
  await waitForItem("the upstream order reaches the replica", replica, second.id, (i) => i.queue === 2);

  const reordered = await post<{ ids: string[] }>(`${replica.url}/roadmap/reorder`, {
    project_key: PK,
    by: "agent-local",
    ids: [second.id, first.id],
    waves: [[second.id], [first.id]],
  });
  expect(reordered.status).toBe(200);

  const localOrder = await itemOn(replica, first.id);
  expect(localOrder!.queue).toBe(2);
  // A rank change is pushed (roadmap_queue_dirty_au), so the swap made on
  // the replica reaches the upstream on its own, live connection -- no
  // offline window, no pull required to carry it.
  await waitForItem(
    "the local swap is pushed upstream, unprompted by any further pull",
    upstream,
    first.id,
    (i) => i.queue === 2
  );
  await waitForItem("the swap moved both rows", upstream, second.id, (i) => i.queue === 1);
  const upstreamTail = await itemOn(upstream, second.id);
  expect(["the swap moved both rows", upstreamTail!.queue]).toEqual(["the swap moved both rows", 1]);
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

test("queue_replaced counts the local positions a refused queue mutation gave back, and only those", async () => {
  // D2 (card f12e34f1 lot 1): `ids` must cover the whole upstream queue, and
  // an earlier test in this file left its own cards queued there permanently
  // (first.id/second.id, restored to queue 1/2 at its end). Clear it first
  // (ids: [] is exempt from D2's coverage check) and wait for the clear to
  // reach the replica, so it cannot land mid-measurement below and skew the
  // delta this test asserts.
  const stale = (await post<ListRes>(`${upstream.url}/roadmap/list`, { project_key: PK })).body.items.filter(
    (i) => i.queue !== null
  );
  await post<{ items: RoadmapItem[] }>(`${upstream.url}/roadmap/reorder`, {
    project_key: PK,
    by: "agent-upstream",
    ids: [],
    waves: [],
  });
  for (const item of stale) {
    await waitForItem("stale queue positions clear before measuring", replica, item.id, (i) => i.queue === null);
  }

  // A rank change is pushed, but the pull still owns the last word: an
  // upstream write on the same card after the offline window carries
  // whatever rank the upstream has, and this counter tracks exactly the rows
  // where that differed locally. The log line says so once per page; it must
  // move by exactly the number of rows whose local position differed -- and
  // not move at all on a pass that changed nothing.
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
        waves: [[head.id], [tail.id]],
      })
    ).status
  ).toBe(200);
  const headQueue = (await waitForItem("the upstream order reaches the replica", replica, head.id, (i) => i.queue !== null)).queue!;
  await waitForItem("the upstream order reaches the replica", replica, tail.id, (i) => i.queue !== null);
  const settled = (await syncStatus()).queue_replaced;

  await goOffline();
  // Both rows get a LOCAL position that differs from the upstream one, and the
  // upstream then writes both cards so the reconnection pull carries them back.
  // The upstream refuses the mutation that carries the local order, so the
  // upstream order is what the replica ends with.
  queueDeltaOverride = { status: 409, body: { error: "conflict", reason: "queue_rev", queue_rev: 99 } };
  const localOrder = await post<{ ids: string[] }>(`${replica.url}/roadmap/reorder`, {
    project_key: PK,
    by: "agent-local",
    ids: [tail.id, head.id],
    waves: [[tail.id], [head.id]],
  });
  expect(localOrder.status).toBe(200);
  expect(
    (await itemOn(replica, head.id))!.queue,
    "the offline reorder really moved the head, otherwise the pull would replace nothing"
  ).not.toBe(headQueue);
  await createOn(upstream, { id: head.id, by: "agent-upstream", description: "touched while offline" });
  await createOn(upstream, { id: tail.id, by: "agent-upstream", description: "touched while offline" });
  await goOnline();

  try {
    await waitForItem(
      "the upstream order comes back with the head",
      replica,
      head.id,
      (i) => i.description === "touched while offline" && i.queue === headQueue
    );
  } finally {
    queueDeltaOverride = null;
  }
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
  const upstreamDb = openBrokerDb(upstream.dbPath);
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
    JSON.stringify(mirrored).includes(nativePeer.body.instance_token),
  ]).toEqual([
    "the mirrored lock shows the holder but carries no credential",
    true,
    nativePeer.body.peer_id,
    false,
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
  const db = openBrokerDb(replica.dbPath);
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
  const db = openBrokerDb(replica.dbPath);
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
  const db2 = openBrokerDb(replica.dbPath);
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

  const db = openBrokerDb(replica.dbPath);
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
  await forgetRefusedCards([first.id]);
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
  await forgetRefusedCards([card.id]);
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

  const db = openBrokerDb(replica.dbPath);
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
  const poisoned = openBrokerDb(replica.dbPath);
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
  const resolved = await post<{ item: RoadmapItem }>(
    `${replica.url}/roadmap/sync/resolve`,
    deckAuthored({ id: card.id, choice: "local" })
  );
  expect(resolved.status).toBe(200);
  expect(
    JSON.stringify([conflict, reread, resolved.body]),
    "no arbitration reply holds a token value, the stored one or the one planted in the remote blob"
  ).not.toMatch(new RegExp(`${stored.locked_by_token!}|a-token-that-must-not-travel`));
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
  const db = openBrokerDb(replica.dbPath);
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
  await forgetRefusedCards(poison);
}, 90_000);

test("CREATION: a card born on the replica with a rank is queued upstream once its first push has landed", async () => {
  // The first push carries the card without a rank; the mutation that names it
  // waits for that push, so a card never before seen upstream is not lost.
  const born = await createOn(replica, { by: "agent-local", title: "born with a rank", queue: 1000 });
  expect(born.queue, "the rank exists locally right after creation").toBe(1000);
  const onUpstream = await waitForItem(
    "the card reaches the upstream, queued",
    upstream,
    born.id,
    (i) => i.title === "born with a rank" && i.queue !== null
  );
  expect(["the mutation queues the card where its rank puts it", await holdsLastRank(onUpstream)]).toEqual([
    "the mutation queues the card where its rank puts it",
    true,
  ]);
});

test("reorder-only: a replica's content edit survives an upstream-only reorder of the same card", async () => {
  // A queue move must never bump content_rev, so it must never look like a
  // content edit to the push's own-base check. If it did, the upstream's
  // reorder below would move the card's content_rev out from under this
  // replica's stale base and turn a clean push into a false 'content'
  // conflict.
  const solo = await createOn(upstream, { by: "agent-upstream", title: "reorder-only probe" });
  await waitForItem("the probe card reaches the replica", replica, solo.id, (i) => i.title === solo.title);

  await goOffline();
  await createOn(replica, {
    id: solo.id,
    by: "agent-local",
    description: "edited offline, content only",
  });
  // D2 (card f12e34f1 lot 1): ids must cover the project's whole queued set,
  // so this reorder carries forward whatever earlier tests in this file left
  // queued, with the probe card appended.
  const alreadyQueued = (await post<ListRes>(`${upstream.url}/roadmap/list`, { project_key: PK })).body.items
    .filter((i) => i.queue !== null && i.id !== solo.id)
    .sort((x, y) => x.queue! - y.queue!)
    .map((i) => i.id);
  const reorderIds = [...alreadyQueued, solo.id];
  const reordered = await post<{ ids: string[] }>(`${upstream.url}/roadmap/reorder`, {
    project_key: PK,
    by: "agent-upstream",
    ids: reorderIds,
    waves: reorderIds.map((id) => [id]),
  });
  expect(reordered.status).toBe(200);
  await goOnline();

  const settled = await waitForItem(
    "the offline content edit reaches the upstream, unconflicted",
    upstream,
    solo.id,
    (i) => i.description === "edited offline, content only"
  );
  expect([
    "an upstream-only reorder during the outage never turned this into a conflict",
    settled.description,
  ]).toEqual(["an upstream-only reorder during the outage never turned this into a conflict", "edited offline, content only"]);
  const conflicts = await post<RoadmapSyncConflictsResponse>(`${replica.url}/roadmap/sync/conflicts`, {
    project_key: PK,
  });
  expect(
    conflicts.body.items.some((c) => c.local.id === solo.id),
    "the card never entered the operator's conflict list"
  ).toBe(false);
}, 30_000);

test("local-rank: a live local reorder is pushed and acknowledged, sync_dirty settles back to 0", async () => {
  const a = await createOn(replica, { by: "agent-local", title: "local-rank a" });
  const b = await createOn(replica, { by: "agent-local", title: "local-rank b" });
  // D2 (card f12e34f1 lot 1): ids must cover the replica's whole queued set,
  // which earlier tests in this file may have left non-empty.
  const alreadyQueued = (await post<ListRes>(`${replica.url}/roadmap/list`, { project_key: PK })).body.items
    .filter((i) => i.queue !== null && i.id !== a.id && i.id !== b.id)
    .sort((x, y) => x.queue! - y.queue!)
    .map((i) => i.id);
  const ids = [...alreadyQueued, a.id, b.id];
  const reordered = await post<{ ids: string[] }>(`${replica.url}/roadmap/reorder`, {
    project_key: PK,
    by: "agent-local",
    ids,
    waves: ids.map((id) => [id]),
  });
  expect(reordered.status).toBe(200);
  const expectedRank = alreadyQueued.length + 1;

  const onUpstream = await waitForItem(
    "the connection stays up throughout: the rank travels without an offline window",
    upstream,
    a.id,
    (i) => i.queue === expectedRank
  );
  expect([
    "the rank reached the upstream on its own, not by the pull's unconditional overwrite",
    onUpstream.queue,
  ]).toEqual(["the rank reached the upstream on its own, not by the pull's unconditional overwrite", expectedRank]);

  const db = openBrokerDb(replica.dbPath);
  await pollUntil("sync_dirty settles back to 0 once the push is acknowledged", 15_000, async () => {
    const row = db.query("SELECT sync_dirty FROM roadmap_items WHERE id = ?").get(a.id) as {
      sync_dirty: number;
    };
    return { done: row.sync_dirty === 0, value: row.sync_dirty };
  });
  db.close();
}, 30_000);

test("a rank-only move made against upstream content that moved reaches the upstream and survives the pull", async () => {
  // D2 (card f12e34f1 lot 1) exempts an empty `ids`: start from a clean slate.
  // Whatever this clears must reach the replica -- and be counted by
  // `queue_replaced` -- BEFORE this scenario's own `before` snapshot below, or
  // that unrelated reconciliation lands inside the delta this test measures.
  const stale = (await post<ListRes>(`${upstream.url}/roadmap/list`, { project_key: PK })).body.items.filter(
    (i) => i.queue !== null
  );
  await post<{ ids: string[] }>(`${upstream.url}/roadmap/reorder`, {
    project_key: PK,
    by: "agent-upstream",
    ids: [],
    waves: [],
  });
  for (const item of stale) {
    await waitForItem("stale queue positions clear before measuring", replica, item.id, (i) => i.queue === null);
  }
  const card = await createOn(upstream, { by: "agent-upstream", title: "stale pull probe", description: "v1" });
  await waitForItem("the probe syncs before the scenario starts", replica, card.id, (i) => i.description === "v1");

  // `queue_replaced` is a broker-lifetime total: a delta (after - before) is
  // what stays exact regardless of whatever unrelated total another test in
  // this file already accumulated -- now that the clear above has fully
  // settled first.
  const before = (await syncStatus()).queue_replaced;

  // The upstream's own connection stays up (push, lock, everything else keep
  // reaching the real upstream); only pull is answered with an empty page, so
  // this replica never learns about the content edit below until told to.
  pullDropRows = true;
  try {
    await createOn(upstream, { id: card.id, by: "agent-upstream", description: "v2 upstream only" });

    // Rank-only: the content is untouched locally, and the upstream content
    // moved. The rank travels by its own mutation, which depends on the queue
    // revision and not on the card's content.
    const reordered = await post<{ ids: string[] }>(`${replica.url}/roadmap/reorder`, {
      project_key: PK,
      by: "agent-local",
      ids: [card.id],
      waves: [[card.id]],
    });
    expect(reordered.status).toBe(200);

    await waitForItem("the rank reaches the upstream while the pull stays empty", upstream, card.id, (i) => i.queue === 1);
    const midState = (await itemOn(replica, card.id))!.sync_state;
    expect([
      "a rank-only move never becomes a conflict on its own",
      midState,
    ]).toEqual(["a rank-only move never becomes a conflict on its own", "clean"]);
  } finally {
    pullDropRows = false;
  }
  const settled = await waitForItem(
    "once the pull resumes, the upstream content is fast-forwarded and the local rank is kept",
    replica,
    card.id,
    (i) => i.description === "v2 upstream only" && i.sync_state === "clean" && i.queue === 1
  );
  expect([
    "the card is clean, not stuck in conflict, and keeps the rank the operator gave it",
    settled.sync_state,
    settled.description,
    settled.queue,
  ]).toEqual(["the card is clean, not stuck in conflict, and keeps the rank the operator gave it", "clean", "v2 upstream only", 1]);

  expect(
    ((await syncStatus()).queue_replaced ?? 0) - (before ?? 0),
    "no local rank was taken back, so nothing is counted"
  ).toBe(0);
}, 30_000);

test("an upstream reorder applied by the pull never re-triggers the queue-dirty trigger locally", async () => {
  const card = await createOn(upstream, { by: "agent-upstream", title: "pull-only rank probe" });
  await waitForItem("the probe syncs before the scenario starts", replica, card.id, (i) => i.title === card.title);

  const alreadyQueued = (await post<ListRes>(`${upstream.url}/roadmap/list`, { project_key: PK })).body.items
    .filter((i) => i.queue !== null && i.id !== card.id)
    .sort((x, y) => x.queue! - y.queue!)
    .map((i) => i.id);
  const ids = [...alreadyQueued, card.id];

  // Push stays blocked (a 503, retried later, never a refusal) through the
  // whole scenario: without it, a broken guard's echo push can complete and
  // be acknowledged inside the same sync tick that delivers the pull, well
  // before this test's own HTTP polling has a chance to observe `sync_dirty`
  // still at 1.
  pushSuppressed = true;
  let row: { sync_dirty: number };
  try {
    const reordered = await post<{ ids: string[] }>(`${upstream.url}/roadmap/reorder`, {
      project_key: PK,
      by: "agent-upstream",
      ids,
      waves: ids.map((id) => [id]),
    });
    expect(reordered.status).toBe(200);
    const expectedRank = alreadyQueued.length + 1;
    await waitForItem("the upstream rank reaches the replica", replica, card.id, (i) => i.queue === expectedRank);

    // The pull's own write of `queue` runs under `applying`, which is exactly
    // what the trigger's `NOT (applying)` guard exists to exempt: if it did
    // not, this row would be marked dirty by a change that came FROM the
    // upstream, not from a local agent -- and with push still blocked, nothing
    // can have cleared that flag behind this test's back.
    const replicaDb = openBrokerDb(replica.dbPath);
    row = replicaDb.query("SELECT sync_dirty FROM roadmap_items WHERE id = ?").get(card.id) as {
      sync_dirty: number;
    };
    replicaDb.close();
  } finally {
    pushSuppressed = false;
  }
  expect([
    "the pull's own write never marks the row dirty",
    row.sync_dirty,
  ]).toEqual(["the pull's own write never marks the row dirty", 0]);
}, 30_000);

test("a pulled card with a miscased project_key is skipped and logged, its page neighbours still apply and the cursor advances", async () => {
  const miscased = "github.com/VOCSAP/replica-repo";
  const logPath = join(replica.tmpDir, "logs", "broker.log");
  const logStart = readFileSync(logPath, "utf-8").length;
  pullSuppressed = true;
  let skipped: RoadmapItem;
  let neighbour: RoadmapItem;
  try {
    skipped = await createOn(upstream, { by: "agent-upstream", title: "miscased upstream key" });
    const upstreamDb = openBrokerDb(upstream.dbPath);
    upstreamDb.run("UPDATE roadmap_items SET project_key = ? WHERE id = ?", [miscased, skipped.id]);
    upstreamDb.close();
    neighbour = await createOn(upstream, { by: "agent-upstream", title: "canonical neighbour" });
  } finally {
    pullSuppressed = false;
  }

  await waitForItem("the canonical neighbour reaches the replica", replica, neighbour.id, (i) => i.title === "canonical neighbour");
  const upstreamDb = openBrokerDb(upstream.dbPath, { readonly: true });
  const upstreamMaxRev = (upstreamDb.query("SELECT MAX(rev) AS rev FROM roadmap_items").get() as { rev: number }).rev;
  upstreamDb.close();
  await pollUntil("the replica cursor passes the skipped card", 15_000, async () => {
    const cursor = localSyncMeta(replica, "upstream_cursor");
    return { done: cursor >= upstreamMaxRev, value: cursor };
  });

  const replicaDb = openBrokerDb(replica.dbPath, { readonly: true });
  const stored = replicaDb.query("SELECT COUNT(*) AS n FROM roadmap_items WHERE id = ?").get(skipped.id) as { n: number };
  replicaDb.close();
  expect(["the miscased card never lands on the replica", stored.n]).toEqual(["the miscased card never lands on the replica", 0]);
  expect(readFileSync(logPath, "utf-8").slice(logStart)).toContain(skipped.id);
}, 30_000);

test("a pulled card whose title exceeds the bound is skipped and logged, new or already local, and never parked for resolve", async () => {
  const overBound = "t".repeat(ROADMAP_TITLE_MAX + 1);
  const logPath = join(replica.tmpDir, "logs", "broker.log");
  const logStart = readFileSync(logPath, "utf-8").length;

  const existing = await createOn(upstream, { by: "agent-upstream", title: "title before the upstream grew it" });
  await waitForItem("the existing card reaches the replica", replica, existing.id, (i) => i.title === existing.title);

  pullSuppressed = true;
  let fresh: RoadmapItem;
  let neighbour: RoadmapItem;
  try {
    fresh = await createOn(upstream, { by: "agent-upstream", title: "placeholder" });
    const upstreamDb = openBrokerDb(upstream.dbPath);
    upstreamDb.run("UPDATE roadmap_items SET title = ? WHERE id IN (?, ?)", [overBound, fresh.id, existing.id]);
    upstreamDb.close();
    neighbour = await createOn(upstream, { by: "agent-upstream", title: "canonical neighbour of the long titles" });
  } finally {
    pullSuppressed = false;
  }

  await waitForItem("the neighbour reaches the replica", replica, neighbour.id, (i) => i.title === neighbour.title);
  const upstreamDb = openBrokerDb(upstream.dbPath, { readonly: true });
  const upstreamMaxRev = (upstreamDb.query("SELECT MAX(rev) AS rev FROM roadmap_items").get() as { rev: number }).rev;
  upstreamDb.close();
  await pollUntil("the replica cursor passes the long titles", 15_000, async () => {
    const cursor = localSyncMeta(replica, "upstream_cursor");
    return { done: cursor >= upstreamMaxRev, value: cursor };
  });

  const replicaDb = openBrokerDb(replica.dbPath, { readonly: true });
  const freshRows = (replicaDb.query("SELECT COUNT(*) AS n FROM roadmap_items WHERE id = ?").get(fresh.id) as { n: number }).n;
  const kept = replicaDb.query("SELECT title, sync_remote FROM roadmap_items WHERE id = ?").get(existing.id) as {
    title: string;
    sync_remote: string | null;
  };
  replicaDb.close();
  expect(["the new over-long card never lands", freshRows]).toEqual(["the new over-long card never lands", 0]);
  expect(["the local card keeps its title", kept.title]).toEqual(["the local card keeps its title", existing.title]);
  expect(["nothing parked for a resolve", kept.sync_remote]).toEqual(["nothing parked for a resolve", null]);
  const logged = readFileSync(logPath, "utf-8").slice(logStart);
  expect(logged).toContain(fresh.id);
  expect(logged).toContain(existing.id);
}, 30_000);

test("a pulled row whose title is not a string is skipped and logged without aborting its page", async () => {
  const logPath = join(replica.tmpDir, "logs", "broker.log");
  const logStart = readFileSync(logPath, "utf-8").length;
  const bogusId = "card-replica-non-string-title";
  roadmapPullExtra = [{ id: bogusId, project_key: PK, title: 42 }];
  let neighbour: RoadmapItem;
  try {
    neighbour = await createOn(upstream, { by: "agent-upstream", title: "neighbour of a non-string title" });
    await waitForItem("the neighbour lands despite the bogus row", replica, neighbour.id, (i) => i.title === neighbour.title);
  } finally {
    roadmapPullExtra = [];
  }
  const replicaDb = openBrokerDb(replica.dbPath, { readonly: true });
  const stored = (replicaDb.query("SELECT COUNT(*) AS n FROM roadmap_items WHERE id = ?").get(bogusId) as { n: number }).n;
  replicaDb.close();
  expect(["the bogus row never lands", stored]).toEqual(["the bogus row never lands", 0]);
  expect(readFileSync(logPath, "utf-8").slice(logStart)).toContain(bogusId);
}, 30_000);

test("a pulled row whose project_key is not a string is skipped and logged without aborting its page", async () => {
  const logPath = join(replica.tmpDir, "logs", "broker.log");
  const logStart = readFileSync(logPath, "utf-8").length;
  const bogusId = "card-replica-non-string-project-key";
  roadmapPullExtra = [{
    id: bogusId,
    project_key: 42,
    title: "a valid title on a bogus row",
    tags: [],
    depends_on: [],
    target_peer_ids: [],
    created_by: "agent-upstream",
    updated_by: "agent-upstream",
    locked: false,
    lock_contested_by: [],
  }];
  let neighbour: RoadmapItem;
  try {
    neighbour = await createOn(upstream, { by: "agent-upstream", title: "neighbour of a non-string project_key" });
    await waitForItem("the neighbour lands despite the bogus row", replica, neighbour.id, (i) => i.title === neighbour.title);
  } finally {
    roadmapPullExtra = [];
  }
  const replicaDb = openBrokerDb(replica.dbPath, { readonly: true });
  const stored = (replicaDb.query("SELECT COUNT(*) AS n FROM roadmap_items WHERE id = ?").get(bogusId) as { n: number }).n;
  replicaDb.close();
  expect(["the bogus row never lands", stored]).toEqual(["the bogus row never lands", 0]);
  expect(readFileSync(logPath, "utf-8").slice(logStart)).toContain(bogusId);
}, 30_000);

test("resolving 'remote' onto an upstream row parked by a refused push is refused when its title exceeds the bound", async () => {
  const overBound = "t".repeat(ROADMAP_TITLE_MAX + 1);
  const card = await createOn(upstream, { by: "agent-upstream", title: "title kept through a refused resolve" });
  await waitForItem("the card reaches the replica", replica, card.id, (i) => i.title === card.title);

  await goOffline();
  await createOn(replica, { id: card.id, by: "agent-local", description: "edited offline on the replica" });
  const upstreamDb = openBrokerDb(upstream.dbPath);
  upstreamDb.run("UPDATE roadmap_items SET title = ? WHERE id = ?", [overBound, card.id]);
  upstreamDb.close();
  pullSuppressed = true;
  try {
    await goOnline();
    await pollUntil("the refused push parks the upstream row", 15_000, async () => {
      const res = await post<RoadmapSyncConflictsResponse>(`${replica.url}/roadmap/sync/conflicts`, { project_key: PK });
      const parked = res.body.items.find((c) => c.local.id === card.id);
      return { done: parked !== undefined, value: parked?.remote.title.length };
    });

    const refused = await post<{ error?: string }>(
      `${replica.url}/roadmap/sync/resolve`,
      deckAuthored({ id: card.id, choice: "remote" })
    );
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain("title exceeds");
    expect((await itemOn(replica, card.id))?.title).toBe(card.title);

    const kept = await post<{ item: RoadmapItem }>(
      `${replica.url}/roadmap/sync/resolve`,
      deckAuthored({ id: card.id, choice: "local" })
    );
    expect(kept.status, "'local' still resolves: it writes nothing from the parked row").toBe(200);
  } finally {
    pullSuppressed = false;
  }
}, 45_000);

/**
 * Parks a card in conflict the way a refused push leaves it, against an
 * upstream row whose content is exactly the local base: a stale conflict the
 * pull will never touch again, since the upstream row does not move.
 */
function parkStaleConflict(id: string, remoteOver: Record<string, unknown> = {}): Record<string, unknown> {
  const db = openBrokerDb(replica.dbPath);
  try {
    const row = db
      .query("SELECT project_key, sync_base, sync_base_rev FROM roadmap_items WHERE id = ?")
      .get(id) as { project_key: string; sync_base: string; sync_base_rev: number };
    const remote = {
      ...(JSON.parse(row.sync_base) as Record<string, unknown>),
      id,
      project_key: row.project_key,
      rev: row.sync_base_rev + 40,
      content_rev: row.sync_base_rev,
      created_by: "agent-upstream",
      updated_by: "lock-sweep",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      queue: null,
      locked: false,
      locked_by: null,
      locked_at: null,
      locked_group: null,
      lock_contested_by: [],
      ...remoteOver,
    };
    db.run("UPDATE roadmap_items SET sync_state = 'conflict', sync_remote = ? WHERE id = ?", [
      JSON.stringify(remote),
      id,
    ]);
    return remote;
  } finally {
    db.close();
  }
}

async function conflictIds(): Promise<string[]> {
  const res = await post<RoadmapSyncConflictsResponse>(`${replica.url}/roadmap/sync/conflicts`, { project_key: PK });
  return res.body.items.map((c) => c.local.id);
}

/** Waits until the replica has completed `n` more sync passes. */
async function waitPasses(n: number): Promise<void> {
  let seen = (await syncStatus()).last_sync_at;
  let count = 0;
  await pollUntil(`${n} sync passes`, 20_000, async () => {
    const now = (await syncStatus()).last_sync_at;
    if (now !== seen) {
      seen = now;
      count += 1;
    }
    return { done: count >= n, value: count };
  });
}

for (const edit of [
  { label: "an edit", body: { description: "the replica's version" }, field: "description" as const },
  { label: "an archive", body: { status: "archived" }, field: "status" as const },
]) {
  test(`a stale conflict on ${edit.label} resolves 'local' on the next pass although the upstream row never moves again`, async () => {
    const card = await createOn(upstream, { by: "agent-upstream", title: `stale conflict on ${edit.label}`, description: "common base" });
    await waitForItem("the card reaches the replica", replica, card.id, (i) => i.description === "common base");

    await goOffline();
    await createOn(replica, { id: card.id, by: "agent-local", ...edit.body });
    const parked = parkStaleConflict(card.id);
    expect(await conflictIds()).toContain(card.id);

    // The push is held back so the base the resolution wrote is still there to read.
    pushSuppressed = true;
    let base: { sync_base: string | null; sync_base_rev: number | null };
    try {
      upstreamBlocked = false;
      base = await pollUntil("the stale conflict resolves", 15_000, async () => {
        const db = openBrokerDb(replica.dbPath, { readonly: true });
        try {
          const row = db
            .query("SELECT sync_state, sync_base, sync_base_rev FROM roadmap_items WHERE id = ?")
            .get(card.id) as { sync_state: string; sync_base: string | null; sync_base_rev: number | null };
          return { done: row.sync_state === "clean", value: row };
        } finally {
          db.close();
        }
      });
    } finally {
      pushSuppressed = false;
    }
    expect(base.sync_base_rev, "the base adopts the upstream revision the conflict was parked against").toBe(parked.content_rev as number);
    expect(
      base.sync_base === null ? null : (JSON.parse(base.sync_base) as Record<string, unknown>).description,
      "without the upstream content as base the next pull would re-diverge"
    ).toBe(parked.description);
    await goOnline();

    // Read from the upstream's own table: the list route hides an archived card.
    const expected = edit.body[edit.field as keyof typeof edit.body] as string;
    const pushed = await pollUntil("the local edit reaches the upstream once the stale conflict resolves", 15_000, async () => {
      const db = openBrokerDb(upstream.dbPath, { readonly: true });
      try {
        const row = db.query(`SELECT ${edit.field} AS v FROM roadmap_items WHERE id = ?`).get(card.id) as { v: string };
        return { done: row.v === expected, value: row.v };
      } finally {
        db.close();
      }
    });
    expect(pushed).toBe(expected);
    expect(
      await conflictIds(),
      "an upstream untouched since the base leaves nothing for the operator to arbitrate"
    ).not.toContain(card.id);
  }, 60_000);
}

test("a stale conflict stays parked while a third party holds the card upstream, and nothing is pushed", async () => {
  const card = await createOn(upstream, { by: "agent-upstream", title: "stale conflict under a foreign lock", description: "common base" });
  await waitForItem("the card reaches the replica", replica, card.id, (i) => i.description === "common base");

  await goOffline();
  await createOn(replica, { id: card.id, by: "agent-local", description: "the replica's version" });
  parkStaleConflict(card.id, { locked: true, locked_by: "upstream-holder", status: "in_progress" });
  await goOnline();
  await waitPasses(2);

  expect(
    await conflictIds(),
    "resolving under a foreign lock would be refused at push and flap back into conflict every pass"
  ).toContain(card.id);
  expect((await itemOn(upstream, card.id))!.description).toBe("common base");
}, 60_000);

test("a stale conflict under this replica's own relayed lock still resolves 'local'", async () => {
  const localPeer = await post<RegisterResponse>(`${replica.url}/register`, {
    pid: livePid(),
    cwd: "/work/replica-stale-owner",
    git_root: null,
    tty: null,
    summary: "",
    host: "replica-host",
    client_pid: livePid(),
    project_key: PK,
    group_id: "default",
    group_secret_hash: null,
  });
  const card = await createOn(replica, {
    by: localPeer.body.peer_id,
    instance_token: localPeer.body.instance_token,
    title: "stale conflict under our own lock",
    description: "common base",
    status: "in_progress",
  });
  await waitForItem("our lock is accepted upstream", replica, card.id, (i) => i.lock_scope === "global");
  await waitForItem("the card is clean upstream", upstream, card.id, (i) => i.locked && i.description === "common base");

  await goOffline();
  await createOn(replica, {
    id: card.id,
    by: localPeer.body.peer_id,
    instance_token: localPeer.body.instance_token,
    description: "the replica's version",
  });
  parkStaleConflict(card.id, { locked: true, locked_by: localPeer.body.peer_id });
  await goOnline();

  const pushed = await waitForItem(
    "our own relayed claim does not block the stale conflict",
    upstream,
    card.id,
    (i) => i.description === "the replica's version"
  );
  expect(pushed.description).toBe("the replica's version");
  expect(await conflictIds()).not.toContain(card.id);
}, 60_000);

function staleResolutionsLogged(id: string, logStart: number): number {
  const text = readFileSync(join(replica.tmpDir, "logs", "broker.log"), "utf-8").slice(logStart);
  return text.split(`stale conflict on card ${id} resolved`).length - 1;
}

test("a card mirrored as locked upstream by a third party keeps its conflict, whatever the local lock scope", async () => {
  const nativePeer = await post<RegisterResponse>(`${upstream.url}/register`, {
    pid: livePid(),
    cwd: "/work/upstream-stale-holder",
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
    title: "stale conflict mirrored as locked",
    description: "common base",
    status: "in_progress",
  });
  await waitForItem("the upstream lock is mirrored", replica, held.id, (i) => i.lock_scope === "remote");
  const logStart = readFileSync(join(replica.tmpDir, "logs", "broker.log"), "utf-8").length;

  await createOn(replica, { id: held.id, by: "agent-local", description: "the replica's version" });
  await pollUntil("the refused push parks the card", 20_000, async () => {
    const ids = await conflictIds();
    return { done: ids.includes(held.id), value: ids };
  });
  await waitPasses(2);

  expect(
    staleResolutionsLogged(held.id, logStart),
    "the same name under a scope that is not our accepted claim is the upstream holder's lock, not ours"
  ).toBe(0);
  expect(await conflictIds()).toContain(held.id);
}, 60_000);

test("a global local claim does not cover an upstream lock held under another name", async () => {
  const localPeer = await post<RegisterResponse>(`${replica.url}/register`, {
    pid: livePid(),
    cwd: "/work/replica-stale-mismatch",
    git_root: null,
    tty: null,
    summary: "",
    host: "replica-host",
    client_pid: livePid(),
    project_key: PK,
    group_id: "default",
    group_secret_hash: null,
  });
  const card = await createOn(replica, {
    by: localPeer.body.peer_id,
    instance_token: localPeer.body.instance_token,
    title: "stale conflict under a foreign holder name",
    description: "common base",
    status: "in_progress",
  });
  await waitForItem("our lock is accepted upstream", replica, card.id, (i) => i.lock_scope === "global");
  await waitForItem("the card is clean upstream", upstream, card.id, (i) => i.locked && i.description === "common base");

  await goOffline();
  await createOn(replica, {
    id: card.id,
    by: localPeer.body.peer_id,
    instance_token: localPeer.body.instance_token,
    description: "the replica's version",
  });
  parkStaleConflict(card.id, { locked: true, locked_by: "upstream-holder" });
  const logStart = readFileSync(join(replica.tmpDir, "logs", "broker.log"), "utf-8").length;
  // The pull is held back so the parked holder name is not overwritten by ours.
  pullSuppressed = true;
  try {
    await goOnline();
    await waitPasses(2);
    expect(
      staleResolutionsLogged(card.id, logStart),
      "a global scope proves our claim, not that the upstream lock carries our name"
    ).toBe(0);
    expect(await conflictIds()).toContain(card.id);
  } finally {
    pullSuppressed = false;
  }
}, 60_000);

test("an unreadable stored upstream row is reported once, not on every pass", async () => {
  const card = await createOn(upstream, { by: "agent-upstream", title: "stale conflict with a broken upstream row", description: "common base" });
  await waitForItem("the card reaches the replica", replica, card.id, (i) => i.description === "common base");
  await goOffline();
  await createOn(replica, { id: card.id, by: "agent-local", description: "the replica's version" });
  const db = openBrokerDb(replica.dbPath);
  try {
    const base = (db.query("SELECT sync_base_rev FROM roadmap_items WHERE id = ?").get(card.id) as { sync_base_rev: number })
      .sync_base_rev;
    db.run("UPDATE roadmap_items SET sync_state = 'conflict', sync_remote = ? WHERE id = ?", [
      JSON.stringify({ id: card.id, content_rev: base }),
      card.id,
    ]);
  } finally {
    db.close();
  }
  const logPath = join(replica.tmpDir, "logs", "broker.log");
  const logStart = readFileSync(logPath, "utf-8").length;
  await goOnline();
  await waitPasses(3);
  const traces = readFileSync(logPath, "utf-8").slice(logStart).split(`card ${card.id} has a stored upstream row missing content fields`).length - 1;
  expect(traces, "a pass every few seconds would repeat the same refusal thousands of times a day").toBe(1);
}, 60_000);

test("a conflict whose upstream content moved since the base stays parked across passes", async () => {
  const card = await createOn(upstream, { by: "agent-upstream", title: "real conflict stays", description: "common base" });
  await waitForItem("the card reaches the replica", replica, card.id, (i) => i.description === "common base");

  await goOffline();
  await createOn(replica, { id: card.id, by: "agent-local", description: "the replica's version" });
  await createOn(upstream, { id: card.id, by: "agent-upstream", description: "the upstream's version" });
  await goOnline();
  await pollUntil("the divergence is parked", 15_000, async () => {
    const ids = await conflictIds();
    return { done: ids.includes(card.id), value: ids };
  });
  await waitPasses(2);

  expect(await conflictIds(), "an upstream edit since the base is the operator's to arbitrate").toContain(card.id);
  expect((await itemOn(upstream, card.id))!.description).toBe("the upstream's version");
}, 60_000);

test("the content date a card was given where it was edited is the one the other broker holds", async () => {
  const born = await createOn(upstream, { by: "agent-upstream", title: "dated across the pair", description: "v1" });
  const pulled = await waitForItem("the card reaches the replica", replica, born.id, (i) => i.description === "v1");
  expect(pulled.content_updated_at, "pull INSERT carries the upstream's date, not the reception instant").toBe(
    born.content_updated_at
  );

  await Bun.sleep(20);
  const upstreamEdit = await createOn(upstream, { id: born.id, by: "agent-upstream", description: "v2" });
  expect(upstreamEdit.content_updated_at).not.toBe(born.content_updated_at);
  const repulled = await waitForItem("the edit reaches the replica", replica, born.id, (i) => i.description === "v2");
  expect(repulled.content_updated_at, "a clean pull adopts the date of the content it adopts").toBe(
    upstreamEdit.content_updated_at
  );

  await Bun.sleep(20);
  const replicaEdit = await createOn(replica, { id: born.id, by: "agent-local", description: "v3" });
  expect(replicaEdit.content_updated_at).not.toBe(upstreamEdit.content_updated_at);
  const pushed = await waitForItem("the replica edit reaches the upstream", upstream, born.id, (i) => i.description === "v3");
  expect(pushed.content_updated_at, "a push adopts the date of the content it carries").toBe(replicaEdit.content_updated_at);

  const reordered = await createOn(upstream, { id: born.id, by: "agent-upstream", queue: 9 });
  expect(reordered.content_updated_at, "a rank move is no content change").toBe(replicaEdit.content_updated_at);
  const replicaAfterRank = await waitForItem("the rank reaches the replica", replica, born.id, (i) => i.queue === 9);
  expect(replicaAfterRank.content_updated_at, "a rank-only pull dates nothing").toBe(replicaEdit.content_updated_at);
}, 40_000);

test("a conflict resolved remote, local or merged keeps the date of the side whose content stays", async () => {
  const cards: RoadmapItem[] = [];
  for (const choice of ["remote", "local", "merge_reopen"]) {
    cards.push(
      await createOn(upstream, { by: "agent-upstream", title: `dated conflict ${choice}`, description: "common base" })
    );
  }
  for (const card of cards) {
    await waitForItem("conflict fixture reaches the replica", replica, card.id, (i) => i.description === "common base");
  }

  await goOffline();
  const localSide: RoadmapItem[] = [];
  const remoteSide: RoadmapItem[] = [];
  for (const card of cards) {
    await Bun.sleep(5);
    localSide.push(
      await createOn(replica, { id: card.id, by: "agent-local", description: "the replica's version", rationale: "written offline" })
    );
    await Bun.sleep(5);
    remoteSide.push(await createOn(upstream, { id: card.id, by: "agent-upstream", description: "the upstream's version" }));
  }
  await goOnline();
  await pollUntil("the three cards are reported in conflict", 15_000, async () => {
    const ids = await conflictIds();
    return { done: cards.every((c) => ids.includes(c.id)), value: ids };
  });

  const resolve = (id: string, choice: string) =>
    post<{ item: RoadmapItem }>(`${replica.url}/roadmap/sync/resolve`, deckAuthored({ id, choice }));

  const remoteChoice = await resolve(cards[0]!.id, "remote");
  expect(remoteChoice.body.item.content_updated_at, "'remote' keeps the remote date").toBe(remoteSide[0]!.content_updated_at);

  const localChoice = await resolve(cards[1]!.id, "local");
  expect(localChoice.body.item.content_updated_at, "'local' keeps the local date").toBe(localSide[1]!.content_updated_at);
  const pushed = await waitForItem("the kept local version reaches the upstream", upstream, cards[1]!.id, (i) => i.description === "the replica's version");
  expect(pushed.content_updated_at).toBe(localSide[1]!.content_updated_at);

  const merged = await resolve(cards[2]!.id, "merge_reopen");
  const mergedDate = merged.body.item.content_updated_at!;
  expect(mergedDate, "a merge equal to neither side is new content").toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(mergedDate > localSide[2]!.content_updated_at!, "dated after the local side").toBe(true);
  expect(mergedDate > remoteSide[2]!.content_updated_at!, "dated after the remote side, never the max of the two sides' dates").toBe(true);

  await pollUntil("every conflict is cleared", 15_000, async () => {
    const ids = await conflictIds();
    return { done: cards.every((c) => !ids.includes(c.id)), value: ids };
  });
}, 60_000);

test("an edit landing on the replica while its push is in flight keeps its own date through the acknowledgement", async () => {
  const card = await createOn(replica, { by: "agent-local", title: "edited during its push", description: "sent version" });
  await waitForItem("the card reaches the upstream", upstream, card.id, (i) => i.title === "edited during its push");

  await Bun.sleep(20);
  const sentEdit = await createOn(replica, { id: card.id, by: "agent-local", description: "sent version two" });
  let inFlight: RoadmapItem | null = null;
  duringNextPush = async () => {
    await Bun.sleep(20);
    inFlight = await createOn(replica, { id: card.id, by: "agent-local", description: "edited while in flight" });
  };
  await waitForItem("the in-flight edit reaches the upstream", upstream, card.id, (i) => i.description === "edited while in flight");
  expect(inFlight, "the hook ran during a push").not.toBeNull();
  const edit = inFlight as unknown as RoadmapItem;
  expect(edit.content_updated_at).not.toBe(sentEdit.content_updated_at);
  expect((await itemOn(replica, card.id))!.content_updated_at, "the acknowledgement never re-dates the card").toBe(edit.content_updated_at);
  expect((await itemOn(upstream, card.id))!.content_updated_at).toBe(edit.content_updated_at);
}, 40_000);

async function replicaSettled(id: string): Promise<void> {
  await pollUntil("the replica holds nothing left to push", 15_000, async () => {
    const db = openBrokerDb(replica.dbPath);
    try {
      const row = db.query("SELECT sync_dirty FROM roadmap_items WHERE id = ?").get(id) as { sync_dirty: number };
      return { done: row.sync_dirty === 0, value: row.sync_dirty };
    } finally {
      db.close();
    }
  });
}

/** queue_replaced as published by a pass that STARTED after this call, so it covers everything applied so far. */
async function queueReplacedAfterNextPass(): Promise<number> {
  const first = (await syncStatus()).last_sync_at;
  await pollUntil("a first pass completes", 15_000, async () => {
    const status = await syncStatus();
    return { done: status.last_sync_at !== first, value: status.last_sync_at };
  });
  const second = (await syncStatus()).last_sync_at;
  const status = await pollUntil("a full pass completes", 15_000, async () => {
    const s = await syncStatus();
    return { done: s.last_sync_at !== second, value: s };
  });
  return status.queue_replaced;
}

test("a queue move landing on the replica while its push is in flight still reaches the upstream, and replaces nothing", async () => {
  const card = await createOn(replica, { by: "agent-local", title: "ranked during its push", description: "sent version" });
  await waitForItem("the card reaches the upstream", upstream, card.id, (i) => i.title === "ranked during its push");
  await replicaSettled(card.id);
  const replacedBefore = await queueReplacedAfterNextPass();

  let moved = false;
  duringNextPush = async () => {
    await createOn(replica, { id: card.id, by: "agent-local", queue: 1000 });
    moved = true;
  };
  const pushed = pushSeen.length;
  await createOn(replica, { id: card.id, by: "agent-local", description: "sent version two" });
  const ranked = await waitForItem("the queue move reaches the upstream", upstream, card.id, (i) => i.queue !== null);
  expect(moved, "the queue move ran while a push was in flight").toBe(true);
  expect([ranked.description, await holdsLastRank(ranked)]).toEqual(["sent version two", true]);
  await waitForItem("the replica keeps its rank", replica, card.id, (i) => i.queue === ranked.queue);
  await replicaSettled(card.id);
  await waitPasses(2);
  expect(
    pushSeen.slice(pushed).filter((p) => p.id === card.id),
    "the rank moved in flight leaves nothing to push again"
  ).toHaveLength(1);
  expect(await queueReplacedAfterNextPass(), "the echo of the replica's own push replaces no local rank").toBe(replacedBefore);
}, 60_000);

test("a content edit and a queue move landing together while a held card's push is in flight both reach the upstream", async () => {
  const card = await createOn(replica, {
    by: "agent-local",
    title: "held, edited and ranked during its push",
    description: "sent version",
    status: "in_progress",
  });
  expect(card.locked, "the card is held on the replica, so the pull takes its held-here branch").toBe(true);
  await waitForItem("the card reaches the upstream", upstream, card.id, (i) => i.title === "held, edited and ranked during its push");
  await replicaSettled(card.id);

  let moved = false;
  duringNextPush = async () => {
    await createOn(replica, { id: card.id, by: "agent-local", description: "edited in flight", queue: 1000 });
    moved = true;
  };
  await createOn(replica, { id: card.id, by: "agent-local", description: "sent version two" });
  const landed = await waitForItem(
    "the in-flight edit and rank reach the upstream",
    upstream,
    card.id,
    (i) => i.description === "edited in flight" && i.queue !== null
  );
  expect(moved, "the edit ran while a push was in flight").toBe(true);
  expect([landed.description, await holdsLastRank(landed)]).toEqual(["edited in flight", true]);
}, 60_000);

test("an upstream rank move crossing a local one in flight wins, is counted, and does not protect a later upstream move", async () => {
  const card = await createOn(replica, { by: "agent-local", title: "ranked on both sides", description: "sent version" });
  await waitForItem("the card reaches the upstream", upstream, card.id, (i) => i.title === "ranked on both sides");
  await replicaSettled(card.id);
  const replacedBefore = await queueReplacedAfterNextPass();

  let moved = false;
  duringNextPush = async () => {
    await createOn(replica, { id: card.id, by: "agent-local", queue: 5 });
    await createOn(upstream, { id: card.id, by: "agent-upstream", queue: 3 });
    moved = true;
  };
  await createOn(replica, { id: card.id, by: "agent-local", description: "sent version two" });
  await waitForItem("the upstream rank comes back to the replica", replica, card.id, (i) => i.queue === 3);
  expect(moved, "both rank moves ran while a push was in flight").toBe(true);
  await replicaSettled(card.id);
  expect((await itemOn(upstream, card.id))!.queue, "the upstream rank is never overwritten").toBe(3);
  expect(await queueReplacedAfterNextPass(), "the local rank the upstream took back is counted").toBe(replacedBefore + 1);

  // The rank this push sent was null: an upstream move back to null is not an echo.
  await createOn(upstream, { id: card.id, by: "agent-upstream", queue: null });
  await waitForItem("the later upstream rank reaches the replica", replica, card.id, (i) => i.queue === null);
  await replicaSettled(card.id);
  expect((await itemOn(upstream, card.id))!.queue, "the replica never pushes its old rank back").toBeNull();
  expect((await itemOn(replica, card.id))!.queue).toBeNull();
}, 60_000);

/** What tells an unacknowledged push (a conflict with the card's own content) from a lost pull: the replica's last error and the revisions of its row. */
async function replicaPushDiagnostics(id: string): Promise<string> {
  const db = openBrokerDb(replica.dbPath, { readonly: true });
  try {
    const row = db.query("SELECT sync_base_rev, content_rev, sync_dirty FROM roadmap_items WHERE id = ?").get(id);
    return `replica last_error=${JSON.stringify((await syncStatus()).last_error)} row=${JSON.stringify(row)}`;
  } finally {
    db.close();
  }
}

test("an upstream content edit crossing a local rank move in flight leaves the rank where the mutation put it", async () => {
  const card = await createOn(replica, { by: "agent-local", title: "edited upstream during its push", description: "sent version" });
  await waitForItem("the card reaches the upstream", upstream, card.id, (i) => i.title === "edited upstream during its push");
  await replicaSettled(card.id);
  const replacedBefore = await queueReplacedAfterNextPass();

  let moved = false;
  duringNextPush = async () => {
    await createOn(replica, { id: card.id, by: "agent-local", queue: 1000 });
    await createOn(upstream, { id: card.id, by: "agent-upstream", rationale: "written upstream meanwhile" });
    moved = true;
  };
  await createOn(replica, { id: card.id, by: "agent-local", description: "sent version two" });
  try {
    await waitForItem(
      "the upstream row comes back with the rank of the mutation",
      replica,
      card.id,
      (i) => i.rationale === "written upstream meanwhile" && i.queue !== null
    );
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}; ${await replicaPushDiagnostics(card.id)}`);
  }
  expect(moved, "both writes ran while a push was in flight").toBe(true);
  await replicaSettled(card.id);
  expect(
    ["a rank depends on the queue revision, never on the content of the card", await holdsLastRank(card)]
  ).toEqual(["a rank depends on the queue revision, never on the content of the card", true]);
  expect(await queueReplacedAfterNextPass(), "no local rank was taken back").toBe(replacedBefore);
}, 60_000);

test("a queue move landing while a push is in flight reaches the upstream even when no pull answers", async () => {
  const card = await createOn(replica, { by: "agent-local", title: "ranked while the pull is silent", description: "sent version" });
  await waitForItem("the card reaches the upstream", upstream, card.id, (i) => i.title === "ranked while the pull is silent");
  await replicaSettled(card.id);

  let moved = false;
  duringNextPush = async () => {
    pullSuppressed = true;
    await createOn(replica, { id: card.id, by: "agent-local", queue: 1000 });
    moved = true;
  };
  try {
    await createOn(replica, { id: card.id, by: "agent-local", description: "sent version two" });
    const ranked = await waitForItem("the queue move reaches the upstream without any pull", upstream, card.id, (i) => i.queue !== null);
    expect(moved, "the queue move ran while a push was in flight").toBe(true);
    expect(ranked.description).toBe("sent version two");
  } finally {
    pullSuppressed = false;
  }
}, 60_000);

test("a merge equal to one side keeps that side's date, whatever it is, including unknown", async () => {
  const names = ["equals the remote side", "equals the local side", "equals a remote side whose date is unknown"];
  const cards: RoadmapItem[] = [];
  for (const name of names) {
    cards.push(await createOn(upstream, { by: "agent-upstream", title: `merge ${name}`, status: "planned", description: "common base" }));
  }
  for (const card of cards) {
    await waitForItem("merge fixture reaches the replica", replica, card.id, (i) => i.description === "common base");
  }

  await goOffline();
  const localSide: RoadmapItem[] = [];
  const remoteSide: RoadmapItem[] = [];
  for (const [index, card] of cards.entries()) {
    await Bun.sleep(5);
    const localExtra = index === 1 ? { rationale: "local extra" } : {};
    const remoteExtra = index === 1 ? {} : { rationale: "upstream extra" };
    localSide.push(await createOn(replica, { id: card.id, by: "agent-local", description: "shared", ...localExtra }));
    await Bun.sleep(5);
    remoteSide.push(await createOn(upstream, { id: card.id, by: "agent-upstream", description: "shared", ...remoteExtra }));
  }
  await goOnline();
  await pollUntil("the three cards are reported in conflict", 15_000, async () => {
    const ids = await conflictIds();
    return { done: cards.every((c) => ids.includes(c.id)), value: ids };
  });

  const upstreamDb = openBrokerDb(upstream.dbPath);
  upstreamDb.run("UPDATE roadmap_items SET content_updated_at = NULL WHERE id = ?", [cards[2]!.id]);
  upstreamDb.close();
  await pollUntil("the parked remote row carries the unknown date", 15_000, async () => {
    const res = await post<RoadmapSyncConflictsResponse>(`${replica.url}/roadmap/sync/conflicts`, { project_key: PK });
    const remote = res.body.items.find((c) => c.local.id === cards[2]!.id)?.remote;
    return { done: remote !== undefined && remote.content_updated_at === null, value: remote?.content_updated_at };
  });

  const merge = (id: string) =>
    post<{ item: RoadmapItem }>(`${replica.url}/roadmap/sync/resolve`, deckAuthored({ id, choice: "merge_reopen" }));

  const equalRemote = (await merge(cards[0]!.id)).body.item;
  expect(equalRemote.rationale).toBe("upstream extra");
  expect(equalRemote.content_updated_at, "a merge equal to the remote side keeps its date").toBe(remoteSide[0]!.content_updated_at);

  const equalLocal = (await merge(cards[1]!.id)).body.item;
  expect(equalLocal.rationale).toBe("local extra");
  expect(equalLocal.content_updated_at, "a merge equal to the local side changes nothing").toBe(localSide[1]!.content_updated_at);

  const equalUnknown = (await merge(cards[2]!.id)).body.item;
  expect(equalUnknown.rationale).toBe("upstream extra");
  expect(equalUnknown.content_updated_at, "an unknown remote date stays unknown with its content").toBeNull();

  await pollUntil("every merge conflict is cleared", 15_000, async () => {
    const ids = await conflictIds();
    return { done: cards.every((c) => !ids.includes(c.id)), value: ids };
  });
}, 60_000);

function upstreamQueueRev(): number {
  const db = openBrokerDb(upstream.dbPath, { readonly: true });
  try {
    return (
      (db.query("SELECT rev FROM roadmap_queue_state WHERE project_key = ? AND lot_id = 'default'").get(PK) as { rev: number } | null)?.rev ?? 0
    );
  } finally {
    db.close();
  }
}

/** The revision this replica adopted for the test project, null when it holds none. */
function adoptedQueueRev(): number | null {
  const db = openBrokerDb(replica.dbPath, { readonly: true });
  try {
    return (
      (db.query("SELECT rev FROM roadmap_queue_upstream WHERE project_key = ? AND lot_id = 'default'").get(PK) as { rev: number } | null)
        ?.rev ?? null
    );
  } finally {
    db.close();
  }
}

/** Leaves `card` alone in the project's queue, or the queue empty; the reorder refuses a list that omits a queued card. */
async function moveUpstreamQueue(card: RoadmapItem, queued: boolean): Promise<void> {
  if (queued) {
    await post(`${upstream.url}/roadmap/reorder`, { project_key: PK, by: "agent-upstream", ids: [], waves: [] });
  }
  const res = await post(`${upstream.url}/roadmap/reorder`, {
    project_key: PK,
    by: "agent-upstream",
    ids: queued ? [card.id] : [],
    waves: queued ? [[card.id]] : [],
  });
  expect(res.status).toBe(200);
}

test("a replica adopts the upstream's queue revision from a final pull page", async () => {
  const card = await createOn(upstream, { by: "agent-upstream", title: "queue revision adoption probe" });
  await waitForItem("the probe syncs", replica, card.id, (i) => i.title === card.title);
  await moveUpstreamQueue(card, true);
  const expected = upstreamQueueRev();
  expect(expected, "the upstream counted the rank write").toBeGreaterThan(0);

  await pollUntil("the replica adopts the upstream revision", 15_000, async () => {
    const value = adoptedQueueRev();
    return { done: value === expected, value };
  });
  expect(localSyncMetaText(replica, "upstream_queue_revs_adopted")).toBe("1");
  await moveUpstreamQueue(card, false);
}, 30_000);

function localSyncMetaText(broker: TestBroker, key: string): string | null {
  const db = openBrokerDb(broker.dbPath, { readonly: true });
  try {
    return (db.query("SELECT value FROM roadmap_sync_meta WHERE key = ?").get(key) as { value: string } | null)?.value ?? null;
  } finally {
    db.close();
  }
}

test("an upstream whose pull carries no queue_revs leaves the adopted revisions as they were", async () => {
  const card = await createOn(upstream, { by: "agent-upstream", title: "queue revision absent probe" });
  await waitForItem("the probe syncs", replica, card.id, (i) => i.title === card.title);
  await moveUpstreamQueue(card, true);
  await pollUntil("the replica holds the current revision", 15_000, async () => {
    const value = adoptedQueueRev();
    return { done: value === upstreamQueueRev(), value };
  });
  const held = adoptedQueueRev();

  pullStripQueueRevs = true;
  try {
    await moveUpstreamQueue(card, false);
    await waitForItem("the rank clear reaches the replica through a pull without queue_revs", replica, card.id, (i) => i.queue === null);
    expect(upstreamQueueRev(), "the upstream revision moved").toBeGreaterThan(held!);
    expect(adoptedQueueRev(), "a pull without the field changes nothing").toBe(held);
  } finally {
    pullStripQueueRevs = false;
  }
  await pollUntil("the replica adopts the revision once the field is back", 15_000, async () => {
    const value = adoptedQueueRev();
    return { done: value === upstreamQueueRev(), value };
  });
}, 45_000);

test("a queue_revs object with a malformed entry is refused whole and leaves the adopted revisions as they were", async () => {
  const card = await createOn(upstream, { by: "agent-upstream", title: "queue revision malformed probe" });
  await waitForItem("the probe syncs", replica, card.id, (i) => i.title === card.title);
  await moveUpstreamQueue(card, true);
  await pollUntil("the replica holds the current revision", 15_000, async () => {
    const value = adoptedQueueRev();
    return { done: value === upstreamQueueRev(), value };
  });
  const held = adoptedQueueRev();
  const logPath = join(replica.tmpDir, "logs", "broker.log");
  const logStart = readFileSync(logPath, "utf-8").length;
  const refusalLines = () =>
    readFileSync(logPath, "utf-8").slice(logStart).split("\n").filter((l) => l.includes("pull queue_revs refused")).length;
  const answerWith = async (what: string, override: unknown): Promise<void> => {
    const served = servedOverrides;
    pullQueueRevsOverride = override;
    await pollUntil(`two pulls answered with ${what}`, 15_000, async () => ({
      done: servedOverrides >= served + 2,
      value: servedOverrides - served,
    }));
  };

  const malformed: Array<[string, unknown]> = [
    ["a mixed-case project key beside a valid entry", { [PK]: 424_242, "github.com/Mixed/Case": 1 }],
    ["a project key with a control character", { [PK]: 424_242, "github.com/a\nb": 1 }],
    ["a negative revision", { [PK]: -1 }],
    ["a fractional revision", { [PK]: 1.5 }],
    ["a revision past the safe integers", { [PK]: 2 ** 53 }],
    ["an array", [424_242]],
  ];
  try {
    for (const [what, override] of malformed) {
      await answerWith(what, override);
      expect([what, adoptedQueueRev()]).toEqual([what, held]);
    }
    expect(refusalLines(), "a run of refused pages is said once, not on every pass").toBe(1);

    pullQueueRevsOverride = undefined;
    await moveUpstreamQueue(card, false);
    await pollUntil("a valid page is adopted again", 15_000, async () => {
      const value = adoptedQueueRev();
      return { done: value === upstreamQueueRev(), value };
    });
    await answerWith("a negative revision after an adoption", { [PK]: -1 });
    expect(refusalLines(), "an adoption re-arms the warning").toBe(2);
  } finally {
    pullQueueRevsOverride = undefined;
  }
}, 60_000);

test("a revision carried by an intermediate pull page is not adopted", async () => {
  const card = await createOn(upstream, { by: "agent-upstream", title: "queue revision intermediate probe" });
  await waitForItem("the probe syncs", replica, card.id, (i) => i.title === card.title);
  const held = adoptedQueueRev();
  const unreachable = 987_654;

  pullPadRev = unreachable;
  try {
    await createOn(upstream, { id: card.id, by: "agent-upstream", description: "a row for the padded page" });
    await pollUntil("the replica asks for the page after the full one", 15_000, async () => {
      return { done: (pullBlockedCalls ?? 0) > 0, value: pullBlockedCalls };
    });
    expect(adoptedQueueRev(), "the full page's revision is not adopted").toBe(held);
  } finally {
    pullPadRev = null;
    pullBlockedCalls = null;
  }
  await pollUntil("the replica adopts the real revision from the final page", 20_000, async () => {
    const value = adoptedQueueRev();
    return { done: (value ?? 0) === upstreamQueueRev() && (await syncStatus()).online === true, value };
  });
}, 45_000);

function outboxCount(): number {
  const db = openBrokerDb(replica.dbPath, { readonly: true });
  try {
    return (db.query("SELECT COUNT(*) AS n FROM roadmap_queue_outbox").get() as { n: number }).n;
  } finally {
    db.close();
  }
}

const swapOnReplica = (a: RoadmapItem, b: RoadmapItem) =>
  post(`${replica.url}/roadmap/reorder`, { project_key: PK, by: "agent-local", ids: [b.id, a.id], waves: [[b.id], [a.id]] });
const restoreOnReplica = (a: RoadmapItem, b: RoadmapItem) =>
  post(`${replica.url}/roadmap/reorder`, { project_key: PK, by: "agent-local", ids: [a.id, b.id], waves: [[a.id], [b.id]] });

async function waitRanks(
  label: string,
  broker: TestBroker,
  a: RoadmapItem,
  b: RoadmapItem,
  qa: number,
  qb: number
): Promise<void> {
  await pollUntil(label, 20_000, async () => {
    const [ia, ib] = [await itemOn(broker, a.id), await itemOn(broker, b.id)];
    return { done: ia?.queue === qa && ib?.queue === qb, value: [ia?.queue, ib?.queue] };
  });
}

/** Cards queued 1, 2, ... on both brokers, with the replica's adopted revision equal to the upstream's. */
async function queueCards(tag: string, count: number): Promise<RoadmapItem[]> {
  await post(`${upstream.url}/roadmap/reorder`, { project_key: PK, by: "agent-upstream", ids: [], waves: [] });
  const cards: RoadmapItem[] = [];
  for (let i = 0; i < count; i++) {
    cards.push(await createOn(upstream, { by: "agent-upstream", title: `${tag} ${i}`, description: "v1" }));
  }
  const ordered = await post(`${upstream.url}/roadmap/reorder`, {
    project_key: PK,
    by: "agent-upstream",
    ids: cards.map((c) => c.id),
    waves: cards.map((c) => [c.id]),
  });
  expect(ordered.status).toBe(200);
  for (const [i, card] of cards.entries()) {
    await waitForItem("the cards are queued on the replica", replica, card.id, (item) => item.queue === i + 1);
  }
  await pollUntil("the replica adopted the current revision and holds nothing", 20_000, async () => {
    const value = adoptedQueueRev();
    return { done: value === upstreamQueueRev() && outboxCount() === 0, value };
  });
  // The published counters are those of the last finished pass: let the pass
  // that applied the pair finish, or a count measured next includes its clear.
  await waitPasses(2);
  return cards;
}

async function queuePair(tag: string): Promise<{ a: RoadmapItem; b: RoadmapItem }> {
  const [a, b] = await queueCards(tag, 2);
  return { a: a!, b: b! };
}

async function ranksOf(broker: TestBroker, cards: RoadmapItem[]): Promise<Array<number | null | undefined>> {
  const ranks: Array<number | null | undefined> = [];
  for (const card of cards) ranks.push((await itemOn(broker, card.id))?.queue);
  return ranks;
}

test("S1: a swap made while the upstream edits a card puts A behind B on both sides, beside the cards the other operator queued, the pull keeping the local ranks meanwhile", async () => {
  const { a, b } = await queuePair("S1");
  const replaced = (await syncStatus()).queue_replaced ?? 0;
  let head!: RoadmapItem;
  let tail!: RoadmapItem;

  queueDeltaSuppressed = true;
  try {
    expect((await swapOnReplica(a, b)).status).toBe(200);
    // Another operator queues a card ahead of the pair and one behind it, and
    // an upstream edit of B follows: none of it is for the replica to apply
    // before its own mutation is acknowledged.
    head = await createOn(upstream, { by: "agent-upstream", title: "S1 head" });
    tail = await createOn(upstream, { by: "agent-upstream", title: "S1 tail" });
    const upstreamOrder = [head, a, b, tail];
    expect(
      (
        await post(`${upstream.url}/roadmap/reorder`, {
          project_key: PK,
          by: "agent-upstream",
          ids: upstreamOrder.map((c) => c.id),
          waves: upstreamOrder.map((c) => [c.id]),
        })
      ).status
    ).toBe(200);
    await createOn(upstream, { id: b.id, by: "agent-upstream", description: "v2 upstream" });
    await waitForItem("the pull delivers the upstream edit of B", replica, b.id, (i) => i.description === "v2 upstream");
    await waitForItem("the pull delivers the cards queued upstream", replica, tail.id, (i) => i.title === "S1 tail");
    await waitForItem("the pull delivers the cards queued upstream", replica, head.id, (i) => i.title === "S1 head");
    expect(
      ["while the mutation is pending the pull keeps the local ranks", ...(await ranksOf(replica, [a, b, head, tail]))],
    ).toEqual(["while the mutation is pending the pull keeps the local ranks", 2, 1, null, null]);
    expect(outboxCount()).toBe(1);
    expect(["the upstream order is the other operator's", ...(await ranksOf(upstream, upstreamOrder))]).toEqual([
      "the upstream order is the other operator's",
      1,
      2,
      3,
      4,
    ]);
    // No pull may deliver the result: what the replica holds after the
    // acknowledgement is what the acknowledgement itself applied.
    pullSuppressed = true;
  } finally {
    queueDeltaSuppressed = false;
  }
  try {
    await waitRanks("the upstream applies the swap beside the cards it never named", upstream, a, b, 3, 2);
    await pollUntil("the journal is empty", 20_000, async () => ({ done: outboxCount() === 0, value: outboxCount() }));
    expect([
      "the acknowledgement gives every card its upstream rank",
      ...(await ranksOf(replica, [head, b, a, tail])),
    ]).toEqual(["the acknowledgement gives every card its upstream rank", 1, 2, 3, 4]);
  } finally {
    pullSuppressed = false;
  }
  await waitRanks("the replica holds the same order", replica, a, b, 3, 2);
  expect(["the upstream ranks of the cards the mutation did not name", ...(await ranksOf(upstream, [head, tail]))]).toEqual([
    "the upstream ranks of the cards the mutation did not name",
    1,
    4,
  ]);
  await pollUntil("the journal is empty", 20_000, async () => ({ done: outboxCount() === 0, value: outboxCount() }));
  expect(
    ((await syncStatus()).queue_replaced ?? 0) - replaced,
    "the upstream took no local rank back"
  ).toBe(0);
  expect((await itemOn(replica, b.id))?.sync_state).toBe("clean");
}, 90_000);

test("S2: a swap pushed before the pull that brings an upstream edit ends A=2 B=1 on both sides", async () => {
  const { a, b } = await queuePair("S2");
  const replaced = (await syncStatus()).queue_replaced ?? 0;

  pullDropRows = true;
  try {
    await createOn(upstream, { id: b.id, by: "agent-upstream", description: "v2 upstream" });
    expect((await swapOnReplica(a, b)).status).toBe(200);
    await waitRanks("the upstream applies the swap before any pull", upstream, a, b, 2, 1);
  } finally {
    pullDropRows = false;
  }
  await waitForItem("the pull delivers the upstream edit of B", replica, b.id, (i) => i.description === "v2 upstream");
  await waitRanks("the replica holds the same order", replica, a, b, 2, 1);
  expect(((await syncStatus()).queue_replaced ?? 0) - replaced).toBe(0);
  expect((await itemOn(replica, b.id))?.sync_state).toBe("clean");
}, 90_000);

test("a mutation answered after its commit is retried with the same id and applied once", async () => {
  const { a, b } = await queuePair("retry");
  const seen = queueDeltaSeen.length;

  queueDeltaLoseAnswers = 1;
  expect((await swapOnReplica(a, b)).status).toBe(200);
  await waitRanks("the upstream applies the swap", upstream, a, b, 2, 1);
  await pollUntil("the replica retried and holds the answer", 20_000, async () => ({
    done: outboxCount() === 0 && queueDeltaSeen.length >= seen + 2,
    value: [outboxCount(), queueDeltaSeen.length - seen],
  }));
  const sent = queueDeltaSeen.slice(seen);
  expect(sent.length, "one lost answer, one retry").toBe(2);
  expect(sent[1]!.mutation_id).toBe(sent[0]!.mutation_id);
  expect(sent[1]!.expected_queue_rev).toBe(sent[0]!.expected_queue_rev);
  const db = openBrokerDb(upstream.dbPath, { readonly: true });
  try {
    expect(
      (db.query("SELECT COUNT(*) AS n FROM roadmap_queue_receipts WHERE mutation_id = ?").get(sent[0]!.mutation_id) as { n: number }).n,
      "the upstream committed the mutation once"
    ).toBe(1);
  } finally {
    db.close();
  }
  await waitRanks("the replica holds the same order", replica, a, b, 2, 1);
}, 60_000);

test("no mutation leaves before a revision was adopted, and the gesture is kept until one is", async () => {
  const { a, b } = await queuePair("unadopted");
  const seen = queueDeltaSeen.length;

  pullSuppressed = true;
  try {
    const db = openBrokerDb(replica.dbPath);
    db.run("DELETE FROM roadmap_sync_meta WHERE key = 'upstream_queue_revs_adopted'");
    db.run("DELETE FROM roadmap_queue_upstream");
    db.close();
    expect((await swapOnReplica(a, b)).status).toBe(200);
    await waitPasses(3);
    expect(queueDeltaSeen.length - seen, "nothing was sent without a revision to quote").toBe(0);
    expect(outboxCount()).toBe(1);
    const [ua, ub] = [await itemOn(upstream, a.id), await itemOn(upstream, b.id)];
    expect(["the upstream did not move", ua?.queue, ub?.queue]).toEqual(["the upstream did not move", 1, 2]);
  } finally {
    pullSuppressed = false;
  }
  await waitRanks("the first adoption lets the mutation through", upstream, a, b, 2, 1);
  await pollUntil("the journal is empty", 20_000, async () => ({ done: outboxCount() === 0, value: outboxCount() }));
}, 60_000);

test("a card born on the replica is pushed before the mutation that names it is sent", async () => {
  await post(`${upstream.url}/roadmap/reorder`, { project_key: PK, by: "agent-upstream", ids: [], waves: [] });
  await pollUntil("the replica holds an empty queue", 20_000, async () => {
    const value = adoptedQueueRev();
    return { done: value === upstreamQueueRev() && outboxCount() === 0, value };
  });
  const seen = queueDeltaSeen.length;

  pushRefused = true;
  let born: RoadmapItem;
  try {
    born = await createOn(replica, { by: "agent-local", title: "born on the replica" });
    const queued = await post(`${replica.url}/roadmap/reorder`, {
      project_key: PK,
      by: "agent-local",
      ids: [born.id],
      waves: [[born.id]],
    });
    expect(queued.status).toBe(200);
    await waitPasses(3);
    expect(queueDeltaSeen.length - seen, "the card is not upstream yet, so nothing names it").toBe(0);
    expect(await itemOn(upstream, born.id)).toBeUndefined();
  } finally {
    pushRefused = false;
  }
  // An edit versions the content, which lifts the refusal and sends the card.
  await createOn(replica, { id: born.id, by: "agent-local", description: "now accepted" });
  await waitForItem("the card reaches the upstream with its rank", upstream, born.id, (i) => i.queue === 1);
  await pollUntil("the journal is empty", 20_000, async () => ({ done: outboxCount() === 0, value: outboxCount() }));
  const refusals = (await syncStatus()).queue_outbox?.refused ?? [];
  expect(
    refusals.filter((r) => r.mutation_id === queueDeltaSeen[seen]?.mutation_id),
    "the card's own push did not move the queue behind the mutation's back"
  ).toEqual([]);
  expect((await itemOn(replica, born.id))?.queue).toBe(1);
}, 60_000);

test("a rank-only move leaves the cards clean: the mutation carries the rank, the content push has nothing to say", async () => {
  const { a, b } = await queuePair("clean");
  // No revision is adopted, so the mutation stays; every content push is
  // refused, so a card left dirty by the move would stay dirty.
  pullSuppressed = true;
  pushRefused = true;
  try {
    const db = openBrokerDb(replica.dbPath);
    db.run("DELETE FROM roadmap_sync_meta WHERE key = 'upstream_queue_revs_adopted'");
    db.run("DELETE FROM roadmap_queue_upstream");
    db.close();
    expect((await swapOnReplica(a, b)).status).toBe(200);
    await waitPasses(2);
    const reading = openBrokerDb(replica.dbPath, { readonly: true });
    try {
      const dirty = reading
        .query("SELECT sync_dirty FROM roadmap_items WHERE id IN (?, ?)")
        .all(a.id, b.id) as { sync_dirty: number }[];
      expect(dirty.map((r) => r.sync_dirty)).toEqual([0, 0]);
    } finally {
      reading.close();
    }
  } finally {
    pushRefused = false;
    pullSuppressed = false;
  }
  await waitRanks("the upstream applies the swap", upstream, a, b, 2, 1);
}, 60_000);

test("two gestures made before the first send are one mutation that carries the last order", async () => {
  const [a, b, c] = (await queueCards("replace", 3)) as [RoadmapItem, RoadmapItem, RoadmapItem];
  const seen = queueDeltaSeen.length;

  pullSuppressed = true;
  try {
    const db = openBrokerDb(replica.dbPath);
    db.run("DELETE FROM roadmap_sync_meta WHERE key = 'upstream_queue_revs_adopted'");
    db.run("DELETE FROM roadmap_queue_upstream");
    db.close();
    const gesture = (ids: RoadmapItem[]) =>
      post(`${replica.url}/roadmap/reorder`, {
        project_key: PK,
        by: "agent-local",
        ids: ids.map((c) => c.id),
        waves: ids.map((c) => [c.id]),
      });
    expect((await gesture([b, a, c])).status).toBe(200);
    expect((await gesture([c, b, a])).status).toBe(200);
    expect(outboxCount(), "the second gesture was appended to the first, which was never sent").toBe(1);
  } finally {
    pullSuppressed = false;
  }
  await waitRanks("the last order reaches the upstream", upstream, c, b, 1, 2);
  expect(["the last order", ...(await ranksOf(upstream, [c, b, a]))]).toEqual(["the last order", 1, 2, 3]);
  await pollUntil("the journal is empty", 20_000, async () => ({ done: outboxCount() === 0, value: outboxCount() }));
  expect(queueDeltaSeen.length - seen, "one mutation for two gestures").toBe(1);
}, 60_000);

test("a refusal gives back the upstream order, not the order of an earlier gesture that was never sent", async () => {
  const [a, b, c] = (await queueCards("merge", 3)) as [RoadmapItem, RoadmapItem, RoadmapItem];

  pullSuppressed = true;
  queueDeltaOverride = { status: 409, body: { error: "conflict", reason: "queue_rev", queue_rev: 9 } };
  try {
    const db = openBrokerDb(replica.dbPath);
    db.run("DELETE FROM roadmap_sync_meta WHERE key = 'upstream_queue_revs_adopted'");
    db.run("DELETE FROM roadmap_queue_upstream");
    db.close();
    const gesture = (ids: RoadmapItem[]) =>
      post(`${replica.url}/roadmap/reorder`, {
        project_key: PK,
        by: "agent-local",
        ids: ids.map((card) => card.id),
        waves: ids.map((card) => [card.id]),
      });
    expect((await gesture([b, a, c])).status).toBe(200);
    expect((await gesture([c, b, a])).status).toBe(200);
  } finally {
    pullSuppressed = false;
  }
  try {
    await pollUntil("the mutation is refused and the journal empties", 20_000, async () => ({
      done: outboxCount() === 0,
      value: outboxCount(),
    }));
    expect(["the replica holds the upstream order again", ...(await ranksOf(replica, [a, b, c]))]).toEqual([
      "the replica holds the upstream order again",
      1,
      2,
      3,
    ]);
  } finally {
    queueDeltaOverride = null;
  }
}, 60_000);

test("a refused mutation gives the upstream ranks back, leaves the journal and is reported", async () => {
  const cases: Array<{
    reason: string;
    status: number;
    body: (cardId: string) => unknown;
    withItem: boolean;
  }> = [
    { reason: "queue_rev", status: 409, body: () => ({ error: "conflict", reason: "queue_rev", queue_rev: 9 }), withItem: false },
    {
      reason: "locked_upstream",
      status: 409,
      body: (id) => ({ error: "conflict", reason: "locked_upstream", queue_rev: 9, item_id: id }),
      withItem: true,
    },
    { reason: "not_found", status: 404, body: (id) => ({ error: "unknown roadmap item", item_id: id }), withItem: true },
    { reason: "forbidden", status: 403, body: (id) => ({ error: "inactive", item_id: id }), withItem: true },
    { reason: "invalid", status: 400, body: () => ({ error: "anchor is not queued", op_index: 1 }), withItem: false },
  ];
  for (const refused of cases) {
    const { a, b } = await queuePair(`refused-${refused.reason}`);
    const seen = queueDeltaSeen.length;
    const replaced = (await syncStatus()).queue_replaced ?? 0;
    queueDeltaOverride = { status: refused.status, body: refused.body(b.id) };
    try {
      expect((await swapOnReplica(a, b)).status).toBe(200);
      const report = await pollUntil(`${refused.reason} is reported`, 20_000, async () => {
        const id = queueDeltaSeen[seen]?.mutation_id;
        const found = id === undefined ? undefined : (await syncStatus()).queue_outbox?.refused.find((r) => r.mutation_id === id);
        return { done: found !== undefined, value: found };
      });
      expect([refused.reason, report!.reason, report!.status, report!.item_id]).toEqual([
        refused.reason,
        refused.reason,
        refused.status,
        refused.withItem ? b.id : undefined,
      ]);
      await waitRanks(`${refused.reason}: the replica gets the upstream ranks back`, replica, a, b, 1, 2);
      expect([refused.reason, outboxCount()]).toEqual([refused.reason, 0]);
      expect(
        [refused.reason, queueDeltaSeen.length - seen],
        "a refusal is final: the mutation is not sent again"
      ).toEqual([refused.reason, 1]);
      expect(((await syncStatus()).queue_replaced ?? 0) - replaced, `${refused.reason}: both local ranks were given back`).toBe(2);
    } finally {
      queueDeltaOverride = null;
    }
  }
}, 120_000);

test("a failure to deliver, or a refusal that concerns the route and not a card, keeps the mutation and the pass goes on", async () => {
  // The 503 body changes on every answer, as a gateway's request id would.
  let variation = 0;
  const failures: Array<[number, unknown]> = [
    [404, { error: "not found" }],
    [429, { error: "slow down" }],
    [503, () => ({ error: `unavailable, request ${++variation}` })],
  ];
  const logPath = join(replica.tmpDir, "logs", "broker.log");
  for (const [status, body] of failures) {
    const { a, b } = await queuePair(`route-${status}`);
    const seen = queueDeltaSeen.length;
    const refusedBefore = await refusedMutationIds();
    const logStart = readFileSync(logPath, "utf-8").length;

    queueDeltaOverride = { status, body };
    try {
      expect((await swapOnReplica(a, b)).status).toBe(200);
      await pollUntil(`${status} is named in last_failure`, 20_000, async () => {
        const state = await syncStatus();
        const value = state.queue_outbox?.last_failure ?? "";
        return { done: value.includes(`queue-delta refused (${status})`), value };
      });
      await waitPasses(3);
      const state = await syncStatus();
      expect([status, "the replica stays online", state.online]).toEqual([status, "the replica stays online", true]);
      expect([status, "last_error is not the delivery's", state.last_error ?? ""].join(" ")).not.toContain("queue-delta");
      expect([status, outboxCount(), "the mutation stays"]).toEqual([status, 1, "the mutation stays"]);
      expect([status, ...(await ranksOf(replica, [a, b]))]).toEqual([status, 2, 1]);
      expect(await newRefusals(refusedBefore), `${status} is not a refusal of the mutation`).toEqual([]);
      const sent = queueDeltaSeen.slice(seen);
      expect(sent.length).toBeGreaterThanOrEqual(2);
      expect(new Set(sent.map((s) => s.mutation_id)).size, "every retry carries the same mutation id").toBe(1);
      const said = readFileSync(logPath, "utf-8")
        .slice(logStart)
        .split("\n")
        .filter((l) => l.includes("not delivered, it stays in the journal")).length;
      expect([status, "said once per cause, not on every pass", said]).toEqual([status, "said once per cause, not on every pass", 1]);
    } finally {
      queueDeltaOverride = null;
    }
    await waitRanks(`${status}: the upstream applies the kept mutation`, upstream, a, b, 2, 1);
    await pollUntil("the journal is empty", 30_000, async () => ({ done: outboxCount() === 0, value: outboxCount() }));
    await pollUntil("last_failure is cleared by the send that went through", 20_000, async () => {
      const value = (await syncStatus()).queue_outbox?.last_failure ?? null;
      return { done: value === null, value };
    });
  }
}, 150_000);

test("two refusals in a row leave the replica on the upstream order, not on the order of the first gesture", async () => {
  const [a, b, c] = (await queueCards("twice", 3)) as [RoadmapItem, RoadmapItem, RoadmapItem];
  const seen = queueDeltaSeen.length;
  const gesture = (ids: RoadmapItem[]) =>
    post(`${replica.url}/roadmap/reorder`, {
      project_key: PK,
      by: "agent-local",
      ids: ids.map((card) => card.id),
      waves: ids.map((card) => [card.id]),
    });

  queueDeltaOverride = { status: 503, body: { error: "unavailable" } };
  try {
    expect((await gesture([b, a, c])).status).toBe(200);
    await pollUntil("the first mutation was sent", 20_000, async () => ({
      done: queueDeltaSeen.length > seen,
      value: queueDeltaSeen.length - seen,
    }));
    expect((await gesture([c, b, a])).status, "a gesture after the first send is a second entry").toBe(200);
    expect(outboxCount()).toBe(2);
    queueDeltaOverride = { status: 409, body: { error: "conflict", reason: "queue_rev", queue_rev: 9 } };
    await pollUntil("both mutations are refused", 30_000, async () => ({ done: outboxCount() === 0, value: outboxCount() }));
    await waitPasses(3);
    expect(
      new Set(queueDeltaSeen.slice(seen).map((s) => s.mutation_id)).size,
      "the second mutation is written on top of the first: it goes with it and is never sent"
    ).toBe(1);
    expect(["the replica holds the upstream order", ...(await ranksOf(replica, [a, b, c]))]).toEqual([
      "the replica holds the upstream order",
      1,
      2,
      3,
    ]);
    expect(["the upstream order is unchanged", ...(await ranksOf(upstream, [a, b, c]))]).toEqual([
      "the upstream order is unchanged",
      1,
      2,
      3,
    ]);
  } finally {
    queueDeltaOverride = null;
  }
}, 90_000);

test("a second mutation refused after the first was acknowledged gives back the order the first made", async () => {
  const [a, b, c] = (await queueCards("ack-then-refuse", 3)) as [RoadmapItem, RoadmapItem, RoadmapItem];
  const gesture = (ids: RoadmapItem[]) =>
    post(`${replica.url}/roadmap/reorder`, {
      project_key: PK,
      by: "agent-local",
      ids: ids.map((card) => card.id),
      waves: ids.map((card) => [card.id]),
    });

  // No row of the first mutation's result is ever pulled, and no revision of
  // its acknowledgement is adopted, so the second mutation waits behind it and
  // then meets the refusal knowing the upstream order only from the
  // acknowledgement.
  pullDropRows = true;
  duringNextQueueDelta = async () => {
    pullQueueRevsOverride = { [PK]: -1 };
  };
  queueDeltaLoseAnswers = 1;
  try {
    expect((await gesture([b, a, c])).status).toBe(200);
    await waitRanks("the first mutation commits upstream", upstream, a, b, 2, 1);
    expect((await gesture([c, b, a])).status).toBe(200);
    expect(outboxCount()).toBe(2);
    await pollUntil("the first mutation is acknowledged", 20_000, async () => ({
      done: outboxCount() === 1,
      value: outboxCount(),
    }));
    queueDeltaOverride = { status: 409, body: { error: "conflict", reason: "queue_rev", queue_rev: 9 } };
    pullQueueRevsOverride = undefined;
    await pollUntil("the second mutation is refused", 30_000, async () => ({ done: outboxCount() === 0, value: outboxCount() }));
    expect(["the replica holds what the first mutation made", ...(await ranksOf(replica, [a, b, c]))]).toEqual([
      "the replica holds what the first mutation made",
      2,
      1,
      3,
    ]);
    pullDropRows = false;
    await waitPasses(2);
    expect(await ranksOf(upstream, [a, b, c])).toEqual([2, 1, 3]);
  } finally {
    queueDeltaOverride = null;
    pullQueueRevsOverride = undefined;
    pullDropRows = false;
  }
}, 90_000);

test("a card the mutation covers that turns terminal before the tick does not make the mutation refused", async () => {
  const [a, b, c] = (await queueCards("covered-terminal", 3)) as [RoadmapItem, RoadmapItem, RoadmapItem];
  const refusedBefore = await refusedMutationIds();

  await goOffline();
  expect(
    (await post(`${replica.url}/roadmap/reorder`, {
      project_key: PK,
      by: "agent-local",
      ids: [b.id, a.id, c.id],
      waves: [[b.id], [a.id], [c.id]],
    })).status
  ).toBe(200);
  await createOn(replica, { id: c.id, by: "agent-local", status: "done" });
  await goOnline();

  await waitRanks("the swap reaches the upstream", upstream, a, b, 2, 1);
  await journalEmpties();
  expect(await newRefusals(refusedBefore), "the swap was not refused").toEqual([]);
  expect(["the swap and the cleared rank", ...(await ranksOf(upstream, [b, a, c]))]).toEqual([
    "the swap and the cleared rank",
    1,
    2,
    null,
  ]);
}, 90_000);

test("a covered card that turns terminal waits while the mutation that covers it is sent and unanswered", async () => {
  const [a, b, c] = (await queueCards("sent-terminal", 3)) as [RoadmapItem, RoadmapItem, RoadmapItem];
  const refusedBefore = await refusedMutationIds();
  const seen = queueDeltaSeen.length;
  const pushed = pushSeen.length;

  queueDeltaOverride = { status: 503, body: { error: "unavailable" } };
  try {
    expect(
      (await post(`${replica.url}/roadmap/reorder`, {
        project_key: PK,
        by: "agent-local",
        ids: [b.id, a.id, c.id],
        waves: [[b.id], [a.id], [c.id]],
      })).status
    ).toBe(200);
    await pollUntil("the mutation was sent", 20_000, async () => ({
      done: queueDeltaSeen.length > seen,
      value: queueDeltaSeen.length - seen,
    }));
    await createOn(replica, { id: c.id, by: "agent-local", status: "done" });
    await waitPasses(3);
    expect(
      pushSeen.slice(pushed).filter((p) => p.id === c.id),
      "the upstream would clear the rank and move the revision the retry quotes"
    ).toEqual([]);
  } finally {
    queueDeltaOverride = null;
  }
  await waitRanks("the kept mutation applies", upstream, a, b, 2, 1);
  await waitForItem("the card turns terminal upstream once the mutation settled", upstream, c.id, (i) => i.status === "done");
  await journalEmpties();
  expect(await newRefusals(refusedBefore), "no mutation was refused").toEqual([]);
  expect(await ranksOf(upstream, [b, a, c])).toEqual([1, 2, null]);
}, 90_000);

test("a mutation the upstream cannot settle names the terminal cards it holds back", async () => {
  const [a, b, c, d] = (await queueCards("held-terminal", 4)) as [RoadmapItem, RoadmapItem, RoadmapItem, RoadmapItem];
  const seen = queueDeltaSeen.length;
  queueDeltaOverride = { status: 404, body: { error: "route absent" } };
  try {
    expect(
      (await post(`${replica.url}/roadmap/reorder`, {
        project_key: PK,
        by: "agent-local",
        ids: [b.id, a.id, c.id, d.id],
        waves: [[b.id], [a.id], [c.id], [d.id]],
      })).status
    ).toBe(200);
    await pollUntil("the mutation was sent", 20_000, async () => ({
      done: queueDeltaSeen.length > seen,
      value: queueDeltaSeen.length - seen,
    }));
    await createOn(replica, { id: c.id, by: "agent-local", status: "done" });
    await createOn(replica, { id: d.id, by: "agent-local", status: "done" });
    await pollUntil("the status names both cards the push holds back", 20_000, async () => {
      const failure = (await syncStatus()).queue_outbox?.last_failure ?? "";
      return { done: failure.includes(c.id) && failure.includes(d.id), value: failure };
    });
    await waitPasses(2);
    const failure = (await syncStatus()).queue_outbox?.last_failure ?? "";
    expect(failure, "the failure keeps its own cause").toContain("route absent");
    expect(
      [c.id, d.id].map((id) => failure.split(id).length - 1),
      "each card is named once, however many passes held it back"
    ).toEqual([1, 1]);
  } finally {
    queueDeltaOverride = null;
  }
  await waitRanks("the kept mutation applies", upstream, a, b, 2, 1);
  await waitForItem("the card turns terminal upstream once the mutation settled", upstream, c.id, (i) => i.status === "done");
  await journalEmpties();
}, 90_000);

test("a gesture journaled while another project's mutation is in flight is sent with its entry", async () => {
  const other = "github.com/vocsap/replica-repo-two";
  const { a, b } = await queuePair("two-projects");
  const [x, y, z] = (await Promise.all(
    ["x", "y", "z"].map((tag) => createOn(upstream, { project_key: other, by: "agent-upstream", title: `two projects ${tag}` }))
  )) as [RoadmapItem, RoadmapItem, RoadmapItem];
  const rankIn = async (broker: TestBroker, card: RoadmapItem): Promise<number | null | undefined> =>
    (await post<ListRes>(`${broker.url}/roadmap/list`, { project_key: other })).body.items.find((i) => i.id === card.id)?.queue;
  const reorderOther = (cards: RoadmapItem[]) =>
    post(`${replica.url}/roadmap/reorder`, {
      project_key: other,
      by: "agent-local",
      ids: cards.map((c) => c.id),
      waves: cards.map((c) => [c.id]),
    });
  expect(
    (await post(`${upstream.url}/roadmap/reorder`, {
      project_key: other,
      by: "agent-upstream",
      ids: [x.id, y.id, z.id],
      waves: [[x.id], [y.id], [z.id]],
    })).status
  ).toBe(200);
  await pollUntil("the replica holds the other project's queue and its revision", 20_000, async () => {
    const reading = openBrokerDb(replica.dbPath, { readonly: true });
    const upstreamReading = openBrokerDb(upstream.dbPath, { readonly: true });
    try {
      const held = reading.query("SELECT rev FROM roadmap_queue_upstream WHERE project_key = ?").get(other) as { rev: number } | null;
      const real = upstreamReading.query("SELECT rev FROM roadmap_queue_state WHERE project_key = ?").get(other) as { rev: number } | null;
      const ranks = [await rankIn(replica, x), await rankIn(replica, y), await rankIn(replica, z)];
      return { done: held !== null && held.rev === real?.rev && ranks.join() === "1,2,3", value: [held, real, ranks] };
    } finally {
      reading.close();
      upstreamReading.close();
    }
  });

  holdQueueDelivery();
  try {
    expect((await swapOnReplica(a, b)).status).toBe(200);
    expect((await reorderOther([y, x, z])).status).toBe(200);
    duringNextQueueDelta = async () => {
      expect((await reorderOther([z, y, x])).status).toBe(200);
    };
  } finally {
    pullSuppressed = false;
  }
  await pollUntil("the other project's last gesture reaches the upstream", 30_000, async () => {
    const value = [await rankIn(upstream, z), await rankIn(upstream, y), await rankIn(upstream, x)];
    return { done: value.join() === "1,2,3", value };
  });
  await journalEmpties();
  duringNextQueueDelta = null;
  expect(["the first project's swap", ...(await ranksOf(upstream, [b, a]))]).toEqual(["the first project's swap", 1, 2]);
}, 90_000);

/** A gesture that names `b` is waiting; `b` turns terminal by `turnTerminal`, and the rest of the gesture must still reach the upstream. */
async function terminalCardLeavesTheEntry(tag: string, turnTerminal: (b: RoadmapItem) => Promise<void>): Promise<void> {
  const [a, b, c, d] = (await queueCards(tag, 4)) as [RoadmapItem, RoadmapItem, RoadmapItem, RoadmapItem];
  const refusedBefore = await refusedMutationIds();
  holdQueueDelivery();
  try {
    expect(
      (await post(`${replica.url}/roadmap/reorder`, {
        project_key: PK,
        by: "agent-local",
        ids: [b.id, a.id, d.id, c.id],
        waves: [[b.id], [a.id], [d.id], [c.id]],
      })).status
    ).toBe(200);
    expect(journaledOps().flatMap((op) => op.ids ?? []), "the gesture names b").toContain(b.id);
    await turnTerminal(b);
    const named = journaledOps().flatMap((op) => [...(op.ids ?? []), ...(op.anchor === undefined ? [] : [op.anchor])]);
    expect(named, "no operation names the terminal card").not.toContain(b.id);
  } finally {
    pullSuppressed = false;
  }
  await journalEmpties();
  expect(await newRefusals(refusedBefore), "no mutation was refused").toEqual([]);
  const order = await ranksOf(upstream, [a, d, c]);
  expect(["the rest of the gesture applied", order[0]! < order[1]!, order[1]! < order[2]!]).toEqual([
    "the rest of the gesture applied",
    true,
    true,
  ]);
}

test("an unsent entry that names a card that turns terminal by an update is rewritten without it, not refused whole", async () => {
  await terminalCardLeavesTheEntry("named-terminal", async (b) => {
    await createOn(replica, { id: b.id, by: "agent-local", status: "done" });
  });
}, 90_000);

test("an unsent entry that names a card that is archived is rewritten without it, not refused whole", async () => {
  await terminalCardLeavesTheEntry("named-archived", async (b) => {
    expect((await post(`${replica.url}/roadmap/archive`, { id: b.id, by: "agent-local" })).status).toBe(200);
  });
}, 90_000);

test("an unsent entry that names a card that an import marks done is rewritten without it, not refused whole", async () => {
  await terminalCardLeavesTheEntry("named-imported", async (b) => {
    const res = await post(`${replica.url}/roadmap/import`, {
      project_key: PK,
      by: "agent-local",
      items: [{ id: b.id, title: b.title, kind: "feature", status: "done" }],
    });
    expect(res.status).toBe(200);
  });
}, 90_000);

test("a rewritten entry leaves a card another operator queued meanwhile where it is", async () => {
  const [a, b, c] = (await queueCards("stranger", 3)) as [RoadmapItem, RoadmapItem, RoadmapItem];
  const stranger = await createOn(upstream, { by: "agent-upstream", title: "queued while the pull is frozen" });
  await waitForItem("the stranger reaches the replica", replica, stranger.id, (i) => i.title === stranger.title);
  holdQueueDelivery();
  try {
    const db = openBrokerDb(replica.dbPath);
    db.run("INSERT INTO roadmap_queue_outbox (project_key, mutation_id, ops, withheld) VALUES (?, ?, ?, ?)", [
      PK,
      "stranger-at-the-limit",
      JSON.stringify(Array.from({ length: 500 }, () => ({ op: "place", ids: [a.id], at: "end" }))),
      JSON.stringify({ [a.id]: 1, [b.id]: 2, [c.id]: 3 }),
    ]);
    db.close();
    pullSuppressed = false;
    pullQueueRevsOverride = { [PK]: -1 };
    const order = [a, b, c, stranger];
    expect(
      (await post(`${upstream.url}/roadmap/reorder`, {
        project_key: PK,
        by: "agent-upstream",
        ids: order.map((card) => card.id),
        waves: order.map((card) => [card.id]),
      })).status
    ).toBe(200);
    await pollUntil("the frozen pull set the stranger's rank aside", 20_000, async () => {
      const reading = openBrokerDb(replica.dbPath, { readonly: true });
      try {
        const row = reading.query("SELECT withheld FROM roadmap_queue_outbox WHERE mutation_id = ?").get("stranger-at-the-limit") as { withheld: string };
        const value = (JSON.parse(row.withheld) as Record<string, number | null>)[stranger.id];
        return { done: value === 4, value };
      } finally {
        reading.close();
      }
    });
    expect(
      (await post(`${replica.url}/roadmap/reorder`, {
        project_key: PK,
        by: "agent-local",
        ids: [b.id, a.id, c.id],
        waves: [[b.id], [a.id], [c.id]],
      })).status
    ).toBe(200);
    const ops = journaledOps();
    expect(ops.some((op) => op.op === "remove"), "the stranger is not asked to leave the queue").toBe(false);
    expect(ops.flatMap((op) => op.ids ?? [])).not.toContain(stranger.id);
  } finally {
    pullQueueRevsOverride = undefined;
  }
  await journalEmpties();
  expect(await ranksOf(upstream, [stranger])).toEqual([4]);
}, 90_000);

test("a rewritten entry starts from the queue the entries ahead of it leave", async () => {
  const [a, b, c] = (await queueCards("ahead", 3)) as [RoadmapItem, RoadmapItem, RoadmapItem];
  const seen = queueDeltaSeen.length;
  const gesture = (cards: RoadmapItem[]) =>
    post(`${replica.url}/roadmap/reorder`, {
      project_key: PK,
      by: "agent-local",
      ids: cards.map((card) => card.id),
      waves: cards.map((card) => [card.id]),
    });

  queueDeltaOverride = { status: 503, body: { error: "unavailable" } };
  try {
    expect((await gesture([b, a, c])).status).toBe(200);
    await pollUntil("the first mutation was sent", 20_000, async () => ({
      done: queueDeltaSeen.length > seen,
      value: queueDeltaSeen.length - seen,
    }));
    expect((await gesture([c, b, a])).status, "a second entry").toBe(200);
    expect(outboxCount()).toBe(2);
    const db = openBrokerDb(replica.dbPath);
    db.run("UPDATE roadmap_queue_outbox SET ops = ? WHERE seq = (SELECT MAX(seq) FROM roadmap_queue_outbox)", [
      JSON.stringify(Array.from({ length: 500 }, () => ({ op: "place", ids: [a.id], at: "end" }))),
    ]);
    db.close();
    expect((await gesture([c, a, b])).status, "past the limit, the second entry is rewritten").toBe(200);
  } finally {
    queueDeltaOverride = null;
  }
  await journalEmpties();
  expect(["the last gesture, after the first", ...(await ranksOf(upstream, [c, a, b]))]).toEqual([
    "the last gesture, after the first",
    1,
    2,
    3,
  ]);
}, 90_000);

test("a rank that would put a directive in a wave of several cards is refused here, not by the upstream", async () => {
  holdQueueDelivery();
  const directive =await createOn(replica, { by: "agent-local", title: "a directive in the queue", kind: "directive", directive: "clear", queue: 1000 });
  const plain = await createOn(replica, { by: "agent-local", title: "a card" });
  const into = await post<{ error: string }>(`${replica.url}/roadmap/upsert`, {
    project_key: PK,
    id: plain.id,
    by: "agent-local",
    queue: 1000,
  });
  expect([into.status, into.body.error]).toEqual([400, `directive item '${directive.id}' must be in a singleton wave`]);
  expect((await itemOn(replica, plain.id))?.queue, "the card was not written").toBeNull();

  const occupied = await createOn(replica, { by: "agent-local", title: "an occupied wave", queue: 1001 });
  const moved = await post<{ error: string }>(`${replica.url}/roadmap/upsert`, {
    project_key: PK,
    by: "agent-local",
    title: "a directive that joins it",
    kind: "directive",
    directive: "clear",
    queue: 1001,
  });
  expect([moved.status, moved.body.error]).toEqual([400, expect.stringContaining("must be in a singleton wave")]);
  expect((await itemOn(replica, occupied.id))?.queue).toBe(1001);
  pullSuppressed = false;
  await journalEmpties();
}, 60_000);

test("a card born with a rank whose first push the upstream refuses makes the stuck mutation visible", async () => {
  await post(`${upstream.url}/roadmap/reorder`, { project_key: PK, by: "agent-upstream", ids: [], waves: [] });
  await pollUntil("the replica holds an empty queue", 20_000, async () => {
    const value = adoptedQueueRev();
    return { done: (value ?? 0) === upstreamQueueRev() && outboxCount() === 0, value };
  });
  pushRefused = true;
  let born: RoadmapItem;
  try {
    born = await createOn(replica, { by: "agent-local", title: "refused at its first push", queue: 1000 });
    await pollUntil("the stuck mutation is reported", 20_000, async () => {
      const value = (await syncStatus()).queue_outbox?.last_failure ?? null;
      return { done: value !== null && value.includes(born.id), value };
    });
  } finally {
    pushRefused = false;
  }
  await createOn(replica, { id: born.id, by: "agent-local", description: "now accepted" });
  await waitForItem("the card reaches the upstream, queued", upstream, born.id, (i) => i.queue !== null);
  await journalEmpties();
}, 90_000);

test("a refusal gives back the ranks of every entry of the project, a card only a later one named included", async () => {
  const { a, b } = await queuePair("union");
  const fresh = await createOn(upstream, { by: "agent-upstream", title: "queued by the second entry" });
  await waitForItem("the card reaches the replica", replica, fresh.id, (i) => i.title === fresh.title);
  const seen = queueDeltaSeen.length;

  queueDeltaOverride = { status: 503, body: { error: "unavailable" } };
  try {
    expect((await swapOnReplica(a, b)).status).toBe(200);
    await pollUntil("the first mutation was sent", 20_000, async () => ({
      done: queueDeltaSeen.length > seen,
      value: queueDeltaSeen.length - seen,
    }));
    await createOn(replica, { id: fresh.id, by: "agent-local", queue: 1000 });
    expect(outboxCount(), "the second entry").toBe(2);
    queueDeltaOverride = { status: 409, body: { error: "conflict", reason: "queue_rev", queue_rev: 9 } };
    await journalEmpties();
    await waitPasses(2);
    expect(["the replica holds the upstream's ranks", ...(await ranksOf(replica, [a, b, fresh]))]).toEqual([
      "the replica holds the upstream's ranks",
      1,
      2,
      null,
    ]);
    expect(await ranksOf(upstream, [fresh])).toEqual([null]);
  } finally {
    queueDeltaOverride = null;
  }
}, 90_000);

test("a rank below the whole queue, after its head went done, puts the card first upstream", async () => {
  const [a, b, c] = (await queueCards("gap", 3)) as [RoadmapItem, RoadmapItem, RoadmapItem];
  const x = await createOn(upstream, { by: "agent-upstream", title: "gap newcomer" });
  await waitForItem("the newcomer reaches the replica", replica, x.id, (i) => i.title === x.title);
  await createOn(replica, { id: a.id, by: "agent-local", status: "done" });
  await waitForItem("the head turns done upstream", upstream, a.id, (i) => i.status === "done");
  await waitForItem("the replica keeps the gap at the head", replica, b.id, (i) => i.queue === 2);
  await journalEmpties();

  await createOn(replica, { id: x.id, by: "agent-local", queue: 1 });
  await waitForItem("the newcomer is queued upstream", upstream, x.id, (i) => i.queue !== null);
  await journalEmpties();
  const ranks = await ranksOf(upstream, [x, b, c]);
  expect(["the newcomer is first", ranks[0]! < ranks[1]!, ranks[1]! < ranks[2]!]).toEqual(["the newcomer is first", true, true]);
  expect(["the replica agrees", ...(await ranksOf(replica, [x, b, c]))]).toEqual(["the replica agrees", ...ranks]);
}, 90_000);

test("a card the upstream turns done while an unsent entry names it leaves the entry, which is not refused", async () => {
  const [a, b, c, d] = (await queueCards("pulled-terminal", 4)) as [RoadmapItem, RoadmapItem, RoadmapItem, RoadmapItem];
  const refusedBefore = await refusedMutationIds();
  holdQueueDelivery();
  try {
    expect(
      (await post(`${replica.url}/roadmap/reorder`, {
        project_key: PK,
        by: "agent-local",
        ids: [b.id, a.id, d.id, c.id],
        waves: [[b.id], [a.id], [d.id], [c.id]],
      })).status
    ).toBe(200);
    expect(journaledOps().flatMap((op) => op.ids ?? []), "the gesture names b").toContain(b.id);
    pullSuppressed = false;
    pullQueueRevsOverride = { [PK]: -1 };
    await createOn(upstream, { id: b.id, by: "agent-upstream", status: "done" });
    await waitForItem("the pull delivers the done status", replica, b.id, (i) => i.status === "done");
    const named = journaledOps().flatMap((op) => [...(op.ids ?? []), ...(op.anchor === undefined ? [] : [op.anchor])]);
    expect(named, "no operation names the card the upstream closed").not.toContain(b.id);
  } finally {
    pullQueueRevsOverride = undefined;
  }
  await journalEmpties();
  expect(await newRefusals(refusedBefore), "no mutation was refused").toEqual([]);
  const order = await ranksOf(upstream, [a, d, c]);
  expect(["the rest of the gesture applied", order[0]! < order[1]!, order[1]! < order[2]!]).toEqual([
    "the rest of the gesture applied",
    true,
    true,
  ]);
}, 90_000);

/** The status keeps the last 20 refusals only, so a count cannot tell a new one from a shifted one. */
async function refusedMutationIds(): Promise<string[]> {
  return ((await syncStatus()).queue_outbox?.refused ?? []).map((r) => r.mutation_id);
}

/** The refusals recorded since `before`, a reading of `refusedMutationIds`. */
async function newRefusals(before: string[]): Promise<string[]> {
  return (await refusedMutationIds()).filter((id) => !before.includes(id));
}

/**
 * A card of a queue of three that is edited here and closed upstream, so it
 * waits for the operator in conflict, and possibly an entry kept unsent: a
 * reorder made before or after the conflict, or one naming that card, written
 * straight to the journal. The pull goes on and refuses the revisions, which
 * keeps the entry here until the caller lifts the override.
 */
async function conflictedCardClosedUpstream(
  tag: string,
  gesture: "before" | "after" | "seeded entry" | "none",
  closed: "with the edit" | "once in conflict" = "with the edit",
  closedAs: "done" | "archived" = "done"
): Promise<{ a: RoadmapItem; b: RoadmapItem; c: RoadmapItem }> {
  const [a, b, c] = (await queueCards(tag, 3)) as [RoadmapItem, RoadmapItem, RoadmapItem];
  const reorder = () =>
    post(`${replica.url}/roadmap/reorder`, {
      project_key: PK,
      by: "agent-local",
      ids: [c.id, b.id, a.id],
      waves: [[c.id], [b.id], [a.id]],
    });
  holdQueueDelivery();
  if (gesture === "before") expect((await reorder()).status).toBe(200);
  if (gesture === "after") {
    // An entry already pending freezes the pull: the closed card keeps its local rank.
    expect(
      (await post(`${replica.url}/roadmap/reorder`, {
        project_key: PK,
        by: "agent-local",
        ids: [b.id, a.id, c.id],
        waves: [[b.id], [a.id], [c.id]],
      })).status
    ).toBe(200);
  }
  pushSuppressed = true;
  try {
    await createOn(replica, { id: c.id, by: "agent-local", description: "edited here" });
    pullSuppressed = false;
    pullQueueRevsOverride = { [PK]: -1 };
    await createOn(upstream, {
      id: c.id,
      by: "agent-upstream",
      description: "edited there",
      ...(closed === "with the edit" ? { status: closedAs } : {}),
    });
    await pollUntil("the card is in conflict", 20_000, async () => {
      const ids = await conflictIds();
      return { done: ids.includes(c.id), value: ids };
    });
    if (closed === "once in conflict") {
      await createOn(upstream, { id: c.id, by: "agent-upstream", status: closedAs });
      await pollUntil("the parked upstream row is the closed one", 20_000, async () => {
        const res = await post<RoadmapSyncConflictsResponse>(`${replica.url}/roadmap/sync/conflicts`, { project_key: PK });
        const status = res.body.items.find((item) => item.local.id === c.id)?.remote.status;
        return { done: status === closedAs, value: status };
      });
    }
  } catch (error) {
    pullQueueRevsOverride = undefined;
    throw error;
  } finally {
    pushSuppressed = false;
  }
  if (gesture === "seeded entry") {
    const db = openBrokerDb(replica.dbPath);
    db.run("INSERT INTO roadmap_queue_outbox (project_key, mutation_id, ops, withheld) VALUES (?, ?, ?, ?)", [
      PK,
      `seeded-${tag}`,
      JSON.stringify([{ op: "place", ids: [c.id], at: "end" }]),
      JSON.stringify({ [a.id]: 1, [b.id]: 2, [c.id]: 3 }),
    ]);
    db.close();
  }
  return { a, b, c };
}

for (const [closed, closedAs] of [
  ["with the edit", "done"],
  ["once in conflict", "done"],
  ["with the edit", "archived"],
] as const) {
  test(`a card in conflict that the upstream closes ${closed} as ${closedAs} leaves the unsent entry, which is not refused`, async () => {
    const { a, b, c } = await conflictedCardClosedUpstream("closed-in-conflict", "before", closed, closedAs);
    const refusedBefore = await refusedMutationIds();
    try {
      expect(JSON.stringify(journaledOps()), "no operation names the card the upstream closed").not.toContain(c.id);
    } finally {
      pullQueueRevsOverride = undefined;
    }
    await journalEmpties();
    expect((await refusedMutationIds()).filter((id) => !refusedBefore.includes(id)), "no mutation was refused").toEqual([]);
    const ranks = (await ranksOf(upstream, [a, b, c])).map((rank) => rank ?? null);
    expect(ranks, "the rest of the gesture applied; an archived card is not listed").toEqual([2, 1, null]);
    expect((await post(`${replica.url}/roadmap/sync/resolve`, deckAuthored({ id: c.id, choice: "remote" }))).status).toBe(200);
  }, 120_000);
}

test("a reorder made while a card is in conflict with a closed upstream row does not name that card", async () => {
  const { a, b, c } = await conflictedCardClosedUpstream("reorder-in-conflict", "after");
  const refusedBefore = await refusedMutationIds();
  try {
    expect((await post(`${replica.url}/roadmap/reorder`, {
      project_key: PK,
      by: "agent-local",
      ids: [c.id, b.id, a.id],
      waves: [[c.id], [b.id], [a.id]],
    })).status).toBe(200);
    expect(JSON.stringify(journaledOps()), "the reorder leaves the card out").not.toContain(c.id);
    await createOn(replica, { id: b.id, by: "agent-local", queue: 1 });
    expect(JSON.stringify(journaledOps()), "a rank written on another card does not anchor on it").not.toContain(c.id);
  } finally {
    pullQueueRevsOverride = undefined;
  }
  await journalEmpties();
  expect((await refusedMutationIds()).filter((id) => !refusedBefore.includes(id)), "no mutation was refused").toEqual([]);
  expect(await ranksOf(upstream, [a, b, c]), "the rest of the gesture applied").toEqual([2, 1, null]);
  expect((await post(`${replica.url}/roadmap/sync/resolve`, deckAuthored({ id: c.id, choice: "remote" }))).status).toBe(200);
}, 120_000);

test("resolving a conflict in favour of the upstream, which closed the card, takes it out of the unsent entry that names it", async () => {
  const { a, b, c } = await conflictedCardClosedUpstream("resolved-closed", "seeded entry");
  const refusedBefore = await refusedMutationIds();
  try {
    expect(JSON.stringify(journaledOps()), "the unsent entry names the card").toContain(c.id);
    expect((await post(`${replica.url}/roadmap/sync/resolve`, deckAuthored({ id: c.id, choice: "remote" }))).status).toBe(200);
    expect(JSON.stringify(journaledOps()), "no operation names the card the operator gave to the upstream").not.toContain(c.id);
  } finally {
    pullQueueRevsOverride = undefined;
  }
  await journalEmpties();
  expect((await refusedMutationIds()).filter((id) => !refusedBefore.includes(id)), "no mutation was refused").toEqual([]);
  expect(await ranksOf(upstream, [a, b, c]), "the queue the upstream held is untouched").toEqual([1, 2, null]);
}, 120_000);

test("a new rank on a card in conflict that the upstream closed is refused here, and a healthy move still goes through", async () => {
  // The entry pending before the conflict freezes the pull, so the closed card keeps its local rank, 3.
  const { a, b, c } = await conflictedCardClosedUpstream("rank-on-closed", "after");
  const refusedBefore = await refusedMutationIds();
  const pending = JSON.stringify(journaledOps());
  try {
    const ranked = await post<{ error: string }>(`${replica.url}/roadmap/upsert`, {
      project_key: PK,
      id: c.id,
      by: "agent-local",
      description: "not written",
      queue: 1000,
    });
    expect([ranked.status, ranked.body.error]).toEqual([
      409,
      `item '${c.id}' is in conflict and the upstream closed it -- resolve the conflict before queuing it`,
    ]);
    const kept = await itemOn(replica, c.id);
    expect(["nothing was written", kept?.queue, kept?.description]).toEqual(["nothing was written", 3, "edited here"]);
    expect(JSON.stringify(journaledOps()), "nothing was journaled").toBe(pending);

    await createOn(replica, { id: c.id, by: "agent-local", queue: 3 });
    await createOn(replica, { id: a.id, by: "agent-local", queue: 1 });
    expect((await createOn(replica, { id: c.id, by: "agent-local", queue: null })).queue).toBeNull();
    expect(JSON.stringify(journaledOps()), "no operation names the closed card").not.toContain(c.id);
  } finally {
    pullQueueRevsOverride = undefined;
  }
  await journalEmpties();
  expect((await refusedMutationIds()).filter((id) => !refusedBefore.includes(id)), "no mutation was refused").toEqual([]);
  expect(await ranksOf(upstream, [a, b, c]), "the healthy move applied").toEqual([1, 1, null]);
  expect((await post(`${replica.url}/roadmap/sync/resolve`, deckAuthored({ id: c.id, choice: "remote" }))).status).toBe(200);
}, 120_000);

test("a card done here and reopened with a rank is judged on its new status, and the rank is accepted", async () => {
  const card = await createOn(replica, { by: "agent-local", title: "reopened with a rank" });
  await createOn(replica, { id: card.id, by: "agent-local", status: "done" });
  const reopened = await post<{ item: RoadmapItem }>(`${replica.url}/roadmap/upsert`, {
    project_key: PK,
    id: card.id,
    by: "agent-local",
    status: "planned",
    queue: 1,
  });
  expect([reopened.status, reopened.body.item?.status, reopened.body.item?.queue]).toEqual([200, "planned", 1]);
  await createOn(replica, { id: card.id, by: "agent-local", queue: null });
  await journalEmpties();
}, 90_000);

test("an entry not sent yet that names a card closed upstream during a conflict leaves it out, behind a sent one", async () => {
  const [a, b, c] = (await queueCards("sent-then-unsent", 3)) as [RoadmapItem, RoadmapItem, RoadmapItem];
  const gesture = (ids: RoadmapItem[]) =>
    post(`${replica.url}/roadmap/reorder`, {
      project_key: PK,
      by: "agent-local",
      ids: ids.map((card) => card.id),
      waves: ids.map((card) => [card.id]),
    });
  const refusedBefore = await refusedMutationIds();
  queueDeltaLoseAnswers = 1_000;
  try {
    expect((await gesture([c, a, b])).status).toBe(200);
    await pollUntil("the first entry is sent and unanswered", 20_000, async () => {
      const value = sentEntryCount();
      return { done: value === 1, value };
    });
    await createOn(replica, { id: c.id, by: "agent-local", queue: 1000 });
    expect(sentEntryCount(), "the rank written on the card makes a second entry").toBe(1);
    expect(outboxCount(), "the second entry is not sent").toBe(2);
    pushSuppressed = true;
    try {
      await createOn(replica, { id: c.id, by: "agent-local", description: "edited here" });
      await createOn(upstream, { id: c.id, by: "agent-upstream", description: "closed there", status: "done" });
      await pollUntil("the card is in conflict", 20_000, async () => {
        const ids = await conflictIds();
        return { done: ids.includes(c.id), value: ids };
      });
    } finally {
      pushSuppressed = false;
    }
    expect(outboxCount(), "the second entry held nothing but the card, so it goes").toBe(1);
  } finally {
    queueDeltaLoseAnswers = 0;
  }
  await journalEmpties();
  expect((await refusedMutationIds()).filter((id) => !refusedBefore.includes(id)), "no mutation was refused").toEqual([]);
  const ranks = await ranksOf(upstream, [a, b, c]);
  expect(["the sent entry applied and the card left the queue", ranks[0]! < ranks[1]!, ranks[2]]).toEqual([
    "the sent entry applied and the card left the queue",
    true,
    null,
  ]);
  expect((await post(`${replica.url}/roadmap/sync/resolve`, deckAuthored({ id: c.id, choice: "remote" }))).status).toBe(200);
}, 120_000);

function sentEntryCount(): number {
  const db = openBrokerDb(replica.dbPath, { readonly: true });
  try {
    return (db.query("SELECT COUNT(*) AS n FROM roadmap_queue_outbox WHERE sent_at IS NOT NULL").get() as { n: number }).n;
  } finally {
    db.close();
  }
}

test("a reorder leaves a terminal card that still holds a rank out of its operations", async () => {
  const { a, b } = await queuePair("terminal-base");
  const stale = await createOn(replica, { by: "agent-local", title: "done with a leftover rank" });
  await createOn(replica, { id: stale.id, by: "agent-local", status: "done" });
  const db = openBrokerDb(replica.dbPath);
  db.run("UPDATE roadmap_items SET queue = 3, lot_id = 'default' WHERE id = ?", [stale.id]);
  db.close();
  holdQueueDelivery();
  try {
    expect((await swapOnReplica(a, b)).status).toBe(200);
    expect(journaledOps().flatMap((op) => op.ids ?? []), "the leftover rank is not asked of the upstream").not.toContain(stale.id);
  } finally {
    pullSuppressed = false;
  }
  await journalEmpties();
}, 90_000);

test("the next mutation of a project waits for an adopted revision after the previous one was acknowledged", async () => {
  const { a, b } = await queuePair("stale");
  const seen = queueDeltaSeen.length;

  try {
    queueDeltaLoseAnswers = 1;
    duringNextQueueDelta = async () => {
      pullQueueRevsOverride = { [PK]: -1 };
    };
    expect((await swapOnReplica(a, b)).status).toBe(200);
    await waitRanks("the first mutation commits upstream", upstream, a, b, 2, 1);
    const revAfterFirst = upstreamQueueRev();
    await pollUntil("the first mutation is acknowledged", 20_000, async () => ({
      done: outboxCount() === 0,
      value: outboxCount(),
    }));
    expect((await restoreOnReplica(a, b)).status).toBe(200);
    const served = servedOverrides;
    await pollUntil("several pulls were refused", 20_000, async () => ({
      done: servedOverrides >= served + 4,
      value: servedOverrides - served,
    }));
    const firstId = queueDeltaSeen[seen]!.mutation_id;
    expect(
      queueDeltaSeen.slice(seen).filter((s) => s.mutation_id !== firstId).length,
      "the second mutation waits: no revision of the first one was adopted yet"
    ).toBe(0);
    pullQueueRevsOverride = undefined;
    await waitRanks("the second mutation applies once a revision is adopted", upstream, a, b, 1, 2);
    const second = queueDeltaSeen.find((s, i) => i >= seen && s.mutation_id !== firstId)!;
    expect(second.expected_queue_rev).toBe(revAfterFirst);
  } finally {
    pullQueueRevsOverride = undefined;
  }
  await pollUntil("the journal is empty", 20_000, async () => ({ done: outboxCount() === 0, value: outboxCount() }));
}, 90_000);

test("an unsent mutation waits while the pull refuses the upstream revisions, and leaves on the one adopted afterwards", async () => {
  const { a, b } = await queuePair("refused-revs");
  const stranger = await createOn(upstream, { by: "agent-upstream", title: "queued while the revisions are refused", queue: 1000 });
  const refusedBefore = await refusedMutationIds();
  const seen = queueDeltaSeen.length;
  pullQueueRevsOverride = { [PK]: -1 };
  try {
    await waitForItem("the stranger reaches the replica", replica, stranger.id, (i) => i.queue !== null);
    expect(
      (await post(`${replica.url}/roadmap/reorder`, {
        project_key: PK,
        by: "agent-local",
        ids: [b.id, a.id, stranger.id],
        waves: [[b.id], [a.id], [stranger.id]],
      })).status
    ).toBe(200);
    await waitPasses(3);
    expect(queueDeltaSeen.length - seen, "nothing leaves on a revision the upstream moved past").toBe(0);
    expect((await syncStatus()).queue_outbox?.last_failure, "the operator is told why the entry is held").toContain(
      "held: upstream queue revisions not adopted this pass"
    );
  } finally {
    pullQueueRevsOverride = undefined;
  }
  await waitRanks("the upstream applies the swap once a revision is adopted", upstream, a, b, 2, 1);
  await journalEmpties();
  expect((await refusedMutationIds()).filter((id) => !refusedBefore.includes(id)), "no mutation was refused").toEqual([]);
}, 90_000);

test("an unsent mutation waits while the upstream sends no queue_revs on its final page, and says so", async () => {
  const { a, b } = await queuePair("absent-revs");
  const refusedBefore = await refusedMutationIds();
  const seen = queueDeltaSeen.length;
  pullStripQueueRevs = true;
  try {
    expect((await swapOnReplica(a, b)).status).toBe(200);
    await waitPasses(3);
    expect(queueDeltaSeen.length - seen, "nothing leaves on revisions that may be behind").toBe(0);
    expect((await syncStatus()).queue_outbox?.last_failure, "the operator is told why the entry is held").toContain(
      "the upstream predates queue-delta"
    );
  } finally {
    pullStripQueueRevs = false;
  }
  await waitRanks("the upstream applies the swap once its revisions are back", upstream, a, b, 2, 1);
  await journalEmpties();
  expect((await refusedMutationIds()).filter((id) => !refusedBefore.includes(id)), "no mutation was refused").toEqual([]);
}, 90_000);

test("a terminal push that marks the revision stale does not hide why the pull's revisions are not adopted", async () => {
  const [a, b, c] = (await queueCards("stale-and-doubt", 3)) as [RoadmapItem, RoadmapItem, RoadmapItem];
  const refusedBefore = await refusedMutationIds();
  const seen = queueDeltaSeen.length;
  pullStripQueueRevs = true;
  try {
    expect(
      (await post(`${replica.url}/roadmap/reorder`, {
        project_key: PK,
        by: "agent-local",
        ids: [b.id, a.id, c.id],
        waves: [[b.id], [a.id], [c.id]],
      })).status
    ).toBe(200);
    await createOn(replica, { id: c.id, by: "agent-local", status: "done" });
    await waitForItem("the terminal card is pushed", upstream, c.id, (i) => i.status === "done");
    await waitPasses(3);
    expect((await syncStatus()).queue_outbox?.last_failure, "the hold keeps its reason once the project is marked stale").toContain(
      "not adopted this pass"
    );
    expect(queueDeltaSeen.length - seen, "nothing leaves meanwhile").toBe(0);
  } finally {
    pullStripQueueRevs = false;
  }
  await waitRanks("the upstream applies the swap once its revisions are back", upstream, a, b, 2, 1);
  await journalEmpties();
  expect((await refusedMutationIds()).filter((id) => !refusedBefore.includes(id)), "no mutation was refused").toEqual([]);
}, 90_000);

test("a card born here whose first push is refused keeps its own diagnosis while the revisions are in doubt", async () => {
  await post(`${upstream.url}/roadmap/reorder`, { project_key: PK, by: "agent-upstream", ids: [], waves: [] });
  await pollUntil("the replica holds an empty queue", 20_000, async () => {
    const value = adoptedQueueRev();
    return { done: (value ?? 0) === upstreamQueueRev() && outboxCount() === 0, value };
  });
  pushRefused = true;
  pullStripQueueRevs = true;
  let born: RoadmapItem;
  try {
    born = await createOn(replica, { by: "agent-local", title: "refused at its first push, revisions in doubt", queue: 1000 });
    await pollUntil("the status names the card the upstream refuses", 20_000, async () => {
      const value = (await syncStatus()).queue_outbox?.last_failure ?? null;
      return { done: value !== null && value.includes(born.id) && value.includes("refuses to take"), value };
    });
  } finally {
    pushRefused = false;
    pullStripQueueRevs = false;
  }
  await createOn(replica, { id: born.id, by: "agent-local", description: "now accepted" });
  await waitForItem("the card reaches the upstream, queued", upstream, born.id, (i) => i.queue !== null);
  await journalEmpties();
}, 90_000);

test("an invalid revision of another project holds the unsent entries of every project, with the reason", async () => {
  const { a, b } = await queuePair("global-doubt");
  const other = "github.com/vocsap/doubt-repo";
  const refusedBefore = await refusedMutationIds();
  const seen = queueDeltaSeen.length;
  pullQueueRevsOverride = { [PK]: upstreamQueueRev(), [other]: -1 };
  try {
    expect((await swapOnReplica(a, b)).status).toBe(200);
    await waitPasses(3);
    expect(queueDeltaSeen.length - seen, "nothing leaves while the table is refused").toBe(0);
    const failure = (await syncStatus()).queue_outbox?.last_failure ?? "";
    expect(failure, "the hold names the project whose revision was refused").toContain(other);
    expect(failure).toContain("held: upstream queue revisions not adopted this pass");
  } finally {
    pullQueueRevsOverride = undefined;
  }
  await waitRanks("the upstream applies the swap once the table is valid", upstream, a, b, 2, 1);
  await journalEmpties();
  expect((await refusedMutationIds()).filter((id) => !refusedBefore.includes(id)), "no mutation was refused").toEqual([]);
}, 90_000);

test("an unsent mutation waits while the pull stops at its page cap, and leaves once a pass reaches a final page", async () => {
  const { a, b } = await queuePair("page-cap");
  const refusedBefore = await refusedMutationIds();
  const seen = queueDeltaSeen.length;
  pullFullPages = true;
  try {
    await createOn(upstream, { by: "agent-upstream", title: "row the full pages repeat" });
    await pollUntil("the pull serves full pages", 20_000, async () => ({ done: fullPagesServed > 0, value: fullPagesServed }));
    expect((await swapOnReplica(a, b)).status).toBe(200);
    const served = fullPagesServed;
    const logPath = join(replica.tmpDir, "logs", "broker.log");
    const logStart = readFileSync(logPath, "utf-8").length;
    await waitPasses(2);
    expect(
      readFileSync(logPath, "utf-8").slice(logStart),
      "pages this broker applied are not another broker's"
    ).not.toContain("another broker moved the pull cursor");
    expect(fullPagesServed - served, "a whole pass of full pages ran after the gesture").toBeGreaterThanOrEqual(100);
    expect(queueDeltaSeen.length - seen, "nothing leaves on revisions a capped pull did not refresh").toBe(0);
    expect((await syncStatus()).queue_outbox?.last_failure, "the operator is told why the entry is held").toContain("page cap");
  } finally {
    pullFullPages = false;
  }
  await waitRanks("the upstream applies the swap once a pass reaches a final page", upstream, a, b, 2, 1);
  await journalEmpties();
  expect((await refusedMutationIds()).filter((id) => !refusedBefore.includes(id)), "no mutation was refused").toEqual([]);
}, 120_000);

/** Nothing leaves for the upstream until the next pull adopts a revision again. */
function holdQueueDelivery(): void {
  pullSuppressed = true;
  const db = openBrokerDb(replica.dbPath);
  db.run("DELETE FROM roadmap_sync_meta WHERE key = 'upstream_queue_revs_adopted'");
  db.run("DELETE FROM roadmap_queue_upstream");
  db.close();
}

function journaledOps(): Array<{ op: string; ids?: string[]; anchor?: string; at?: string }> {
  const db = openBrokerDb(replica.dbPath, { readonly: true });
  try {
    return (db.query("SELECT ops FROM roadmap_queue_outbox ORDER BY seq").all() as { ops: string }[]).flatMap(
      (row) => JSON.parse(row.ops) as Array<{ op: string; ids?: string[]; anchor?: string; at?: string }>
    );
  } finally {
    db.close();
  }
}

async function journalEmpties(): Promise<void> {
  await pollUntil("the journal is empty", 30_000, async () => ({ done: outboxCount() === 0, value: outboxCount() }));
}

test("a swap in a queue of three is one mutation that names one card, and leaves the third where it was", async () => {
  const [a, b, c] = (await queueCards("minimal", 3)) as [RoadmapItem, RoadmapItem, RoadmapItem];
  const seen = queueDeltaSeen.length;

  expect(
    (await post(`${replica.url}/roadmap/reorder`, {
      project_key: PK,
      by: "agent-local",
      ids: [b.id, a.id, c.id],
      waves: [[b.id], [a.id], [c.id]],
    })).status
  ).toBe(200);
  await waitRanks("the upstream applies the swap", upstream, a, b, 2, 1);
  await journalEmpties();

  const sent = queueDeltaSeen.slice(seen);
  expect(sent, "one mutation").toHaveLength(1);
  expect(
    sent[0]!.ops.flatMap((op) => op.ids ?? []),
    "the mutation names one card, not the whole queue"
  ).toHaveLength(1);
  expect(await ranksOf(upstream, [b, a, c])).toEqual([1, 2, 3]);
}, 60_000);

test("a swap meets a card another operator queued meanwhile and leaves it where it is", async () => {
  const { a, b } = await queuePair("meanwhile");
  const stranger = await createOn(upstream, { by: "agent-upstream", title: "queued by another operator" });
  await waitForItem("the stranger reaches the replica", replica, stranger.id, (i) => i.title === stranger.title);
  holdQueueDelivery();
  try {
    expect((await swapOnReplica(a, b)).status).toBe(200);
    // The stranger queues itself AHEAD of the pair upstream, behind the replica's back.
    const order = [stranger, a, b];
    expect(
      (await post(`${upstream.url}/roadmap/reorder`, {
        project_key: PK,
        by: "agent-upstream",
        ids: order.map((c) => c.id),
        waves: order.map((c) => [c.id]),
      })).status
    ).toBe(200);
  } finally {
    pullSuppressed = false;
  }
  await journalEmpties();
  expect(["the swap keeps the stranger first", ...(await ranksOf(upstream, [stranger, b, a]))]).toEqual([
    "the swap keeps the stranger first",
    1,
    2,
    3,
  ]);
}, 60_000);

test("emptying the queue on the replica removes the cards it holds and never sends a clear", async () => {
  const cards = await queueCards("empty", 3);
  const seen = queueDeltaSeen.length;

  expect(
    (await post(`${replica.url}/roadmap/reorder`, { project_key: PK, by: "agent-local", ids: [], waves: [] })).status
  ).toBe(200);
  await pollUntil("the upstream empties the queue", 20_000, async () => {
    const value = await ranksOf(upstream, cards);
    return { done: value.every((rank) => rank === null), value };
  });
  await journalEmpties();
  const sent = queueDeltaSeen.slice(seen);
  expect(sent).toHaveLength(1);
  expect(sent[0]!.ops).toEqual([{ op: "remove", ids: cards.map((c) => c.id) }]);
}, 60_000);

test("a reorder that changes nothing leaves the journal empty", async () => {
  const { a, b } = await queuePair("noop");
  expect(
    (await post(`${replica.url}/roadmap/reorder`, {
      project_key: PK,
      by: "agent-local",
      ids: [a.id, b.id],
      waves: [[a.id], [b.id]],
    })).status
  ).toBe(200);
  expect(outboxCount()).toBe(0);
}, 60_000);

test("rank writes made before the first send are one mutation, and no content push carries a rank", async () => {
  await post(`${upstream.url}/roadmap/reorder`, { project_key: PK, by: "agent-upstream", ids: [], waves: [] });
  const [x, y, z] = await Promise.all(
    ["x", "y", "z"].map((tag) => createOn(upstream, { by: "agent-upstream", title: `rank write ${tag}`, description: "v1" }))
  ) as [RoadmapItem, RoadmapItem, RoadmapItem];
  for (const card of [x, y, z]) {
    await waitForItem("the card reaches the replica", replica, card.id, (i) => i.title === card.title);
  }
  await pollUntil("the replica adopted the current revision", 20_000, async () => {
    const value = adoptedQueueRev();
    return { done: (value ?? 0) === upstreamQueueRev() && outboxCount() === 0, value };
  });
  const seen = queueDeltaSeen.length;
  const pushed = pushSeen.length;

  holdQueueDelivery();
  try {
    await createOn(replica, { id: x.id, by: "agent-local", queue: 1, description: "edited with a rank" });
    await createOn(replica, { id: y.id, by: "agent-local", queue: 2 });
    await createOn(replica, { id: z.id, by: "agent-local", queue: 2 });
    expect(outboxCount(), "three gestures, one entry").toBe(1);
    expect(journaledOps()).toEqual([
      { op: "place", ids: [x.id], at: "end" },
      { op: "place", ids: [y.id], at: "end" },
      { op: "join", ids: [z.id], anchor: y.id },
    ]);
    await pollUntil("the content of x was pushed", 20_000, async () => {
      const value = pushSeen.slice(pushed).filter((p) => p.id === x.id);
      return { done: value.length > 0, value };
    });
  } finally {
    pullSuppressed = false;
  }
  await waitForItem("the upstream holds the first rank", upstream, x.id, (i) => i.queue === 1);
  await journalEmpties();
  expect(["the ranks as written", ...(await ranksOf(upstream, [x, y, z]))]).toEqual(["the ranks as written", 1, 2, 2]);
  expect(queueDeltaSeen.length - seen, "one mutation for three writes").toBe(1);
  expect(
    pushSeen.slice(pushed).filter((p) => p.carriesQueue),
    "a rank travels by the mutation, never by the content push"
  ).toEqual([]);
}, 90_000);

test("a card that leaves the queue by a terminal status is not asked of the upstream, which clears it itself", async () => {
  const { a, b } = await queuePair("terminal");
  holdQueueDelivery();
  try {
    await createOn(replica, { id: b.id, by: "agent-local", status: "done" });
    expect(outboxCount(), "a remove for a card the upstream clears would be refused").toBe(0);
  } finally {
    pullSuppressed = false;
  }
  await waitForItem("the upstream clears the rank with the status", upstream, b.id, (i) => i.status === "done" && i.queue === null);
  await waitPasses(2);
  expect(outboxCount()).toBe(0);
  expect((await itemOn(upstream, a.id))?.queue).toBe(1);
}, 60_000);

test("a content edit of a queued card does not carry its rank, and a rank written alone leaves the card clean", async () => {
  const { a, b } = await queuePair("carried");
  const pushed = pushSeen.length;
  await createOn(replica, { id: a.id, by: "agent-local", description: "edited, not moved" });
  await pollUntil("the edit reaches the upstream", 20_000, async () => {
    const value = (await itemOn(upstream, a.id))?.description;
    return { done: value === "edited, not moved", value };
  });
  expect(
    pushSeen.slice(pushed).filter((p) => p.id === a.id && p.carriesQueue),
    "a rank travels by a queue mutation, never by the content push"
  ).toEqual([]);

  holdQueueDelivery();
  pushRefused = true;
  try {
    await createOn(replica, { id: b.id, by: "agent-local", queue: 1 });
    await waitPasses(2);
    const reading = openBrokerDb(replica.dbPath, { readonly: true });
    try {
      const row = reading.query("SELECT sync_dirty FROM roadmap_items WHERE id = ?").get(b.id) as { sync_dirty: number };
      expect(row.sync_dirty, "the mutation carries the rank, the content push has nothing to say").toBe(0);
    } finally {
      reading.close();
    }
  } finally {
    pushRefused = false;
    pullSuppressed = false;
  }
  await journalEmpties();
}, 60_000);

test("a card taken out of the queue by a null rank is removed upstream", async () => {
  const { a, b } = await queuePair("dequeue");
  await createOn(replica, { id: a.id, by: "agent-local", queue: null });
  await pollUntil("the upstream dequeues the card", 20_000, async () => {
    const value = await ranksOf(upstream, [a, b]);
    return { done: value[0] === null && value[1] === 1, value };
  });
  await journalEmpties();
}, 60_000);

test("an unsent entry that would pass the operation limit is rewritten as the whole difference, never cut", async () => {
  const [a, b, c] = (await queueCards("compact", 3)) as [RoadmapItem, RoadmapItem, RoadmapItem];
  const seen = queueDeltaSeen.length;
  holdQueueDelivery();
  try {
    const db = openBrokerDb(replica.dbPath);
    db.run("INSERT INTO roadmap_queue_outbox (project_key, mutation_id, ops, withheld) VALUES (?, ?, ?, ?)", [
      PK,
      "at-the-operation-limit",
      JSON.stringify(Array.from({ length: 500 }, () => ({ op: "place", ids: [a.id], at: "end" }))),
      JSON.stringify({ [a.id]: 1, [b.id]: 2, [c.id]: 3 }),
    ]);
    db.close();
    expect(
      (await post(`${replica.url}/roadmap/reorder`, {
        project_key: PK,
        by: "agent-local",
        ids: [b.id, a.id, c.id],
        waves: [[b.id], [a.id], [c.id]],
      })).status
    ).toBe(200);
    expect(outboxCount()).toBe(1);
    expect(journaledOps(), "the whole difference from the upstream's ranks").toHaveLength(1);
  } finally {
    pullSuppressed = false;
  }
  await waitRanks("the upstream applies the swap", upstream, a, b, 2, 1);
  await journalEmpties();
  expect(queueDeltaSeen.slice(seen)).toHaveLength(1);
}, 60_000);

test("an entry of more than 500 operations is refused in the open and the upstream ranks come back", async () => {
  const [a, b, c] = (await queueCards("over-the-limit", 3)) as [RoadmapItem, RoadmapItem, RoadmapItem];
  holdQueueDelivery();
  try {
    const db = openBrokerDb(replica.dbPath);
    db.run("INSERT INTO roadmap_queue_outbox (project_key, mutation_id, ops, withheld) VALUES (?, ?, ?, ?)", [
      PK,
      "past-the-operation-limit",
      JSON.stringify(Array.from({ length: 501 }, () => ({ op: "place", ids: [a.id], at: "end" }))),
      JSON.stringify({ [a.id]: 1, [b.id]: 2, [c.id]: 3 }),
    ]);
    // Away from the withheld ranks, so that only the refusal path can bring those back.
    for (const [card, rank] of [[a, 3], [b, 1], [c, 2]] as const) {
      db.run("UPDATE roadmap_items SET queue = ? WHERE id = ?", [rank, card.id]);
    }
    db.close();
  } finally {
    pullSuppressed = false;
  }
  await journalEmpties();
  const refusal = await pollUntil("the refusal is in the status of a finished pass", 20_000, async () => {
    const found = ((await syncStatus()).queue_outbox?.refused ?? []).find((r) => r.mutation_id === "past-the-operation-limit");
    return { done: found !== undefined, value: found };
  });
  expect(refusal).toMatchObject({ status: 400 });
  expect(refusal?.message).toContain("500-operation limit");
  expect(await ranksOf(upstream, [a, b, c]), "the upstream order is untouched").toEqual([1, 2, 3]);
  expect(await ranksOf(replica, [a, b, c]), "the replica holds it again").toEqual([1, 2, 3]);
}, 60_000);

test("an import on a replica does not carry the rank of the file", async () => {
  const id = `imported-with-a-rank-${Date.now()}`;
  const res = await post(`${replica.url}/roadmap/import`, {
    project_key: PK,
    by: "agent-local",
    items: [{ id, title: "imported with a rank", kind: "feature", queue: 5 }],
  });
  expect(res.status).toBe(200);
  expect((await itemOn(replica, id))?.queue).toBeNull();
}, 30_000);

async function upstreamLot(): Promise<string> {
  const res = await post<{ lot: { id: string } }>(
    `${upstream.url}/roadmap/lot/create`,
    deckAuthored({ project_key: PK, name: "upstream lot" })
  );
  expect(res.status).toBe(200);
  return res.body.lot.id;
}

async function moveUpstream(ids: string[], to: string): Promise<void> {
  const res = await post(
    `${upstream.url}/roadmap/lot/move`,
    deckAuthored({ project_key: PK, ids, from: "default", to })
  );
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

function sqlOn(broker: TestBroker, statement: string, ...params: (string | number | null)[]): void {
  const db = openBrokerDb(broker.dbPath);
  try {
    db.run(statement, params);
  } finally {
    db.close();
  }
}

const placeOn = async (broker: TestBroker, id: string): Promise<[string | null | undefined, number | null | undefined]> => {
  const item = await itemOn(broker, id);
  return [item?.lot_id, item?.queue];
};

const waitLot = (id: string, lot: string, label = "the replica adopts the lot") =>
  waitForItem(label, replica, id, (item) => item.lot_id === lot);

test("a lot change made upstream reaches the replica whatever the lock state of its copy, and on a card it never held", async () => {
  const lot = await upstreamLot();
  const [free, heldUpstream, released, heldHere] = (await queueCards("lot-pull", 4)) as [
    RoadmapItem,
    RoadmapItem,
    RoadmapItem,
    RoadmapItem,
  ];
  for (const card of [heldUpstream, released]) {
    await createOn(upstream, { id: card.id, by: "agent-upstream", status: "in_progress", queue: card === released ? 3 : 2 });
    await waitForItem("the upstream lock is mirrored", replica, card.id, (item) => item.locked);
  }
  await createOn(replica, { id: heldHere.id, by: "agent-local", status: "in_progress" });
  await waitForItem("the replica's lock reaches the upstream", upstream, heldHere.id, (item) => item.locked);
  await waitPasses(2);

  await goOffline();
  await post(`${upstream.url}/roadmap/upsert`, deckAuthored({ id: released.id, status: "planned" }));
  await moveUpstream([free.id, heldUpstream.id, released.id, heldHere.id], lot);
  const unseen = await createOn(upstream, { by: "agent-upstream", title: "born in a lot while the replica is away", queue: 1 });
  await moveUpstream([unseen.id], lot);
  await goOnline();

  for (const card of [free, heldUpstream, released, heldHere, unseen]) {
    await waitLot(card.id, lot, `the replica adopts the lot of ${card.title}`);
  }

  const other = await upstreamLot();
  sqlOn(upstream, "UPDATE roadmap_items SET lot_id = ? WHERE id = ?", other, free.id);
  await waitLot(free.id, other, "a change of lot alone moves the pull cursor");
}, 90_000);

test("an upstream that predates lots leaves the replica's lots alone and its queued cards fall in the default lot", async () => {
  const card = await createOn(upstream, { by: "agent-upstream", title: "card of an older upstream" });
  await waitForItem("the card arrives", replica, card.id, () => true);
  const replacedBefore = (await syncStatus()).queue_replaced;
  const logPath = join(replica.tmpDir, "logs", "broker.log");
  const logStart = readFileSync(logPath, "utf-8").length;

  // Set before the local lot exists: the SQL dirties the card, and a lot-aware echo of its push would undo the lot.
  pullStripLot = true;
  try {
    sqlOn(replica, "UPDATE roadmap_items SET lot_id = 'lot-local', queue = 9 WHERE id = ?", card.id);
    await createOn(upstream, { id: card.id, by: "agent-upstream", title: "renamed by an older upstream", queue: 3 });
    const born = await createOn(upstream, { by: "agent-upstream", title: "queued by an older upstream", queue: 1 });
    await waitForItem("the rename arrives", replica, card.id, (item) => item.title === "renamed by an older upstream");
    await waitForItem("the queued card arrives", replica, born.id, (item) => item.queue === 1);
    expect([(await itemOn(replica, card.id))?.lot_id, (await itemOn(replica, born.id))?.lot_id]).toEqual([
      "lot-local",
      "default",
    ]);
    expect(storedPlaceOn(replica, card.id), "the older upstream's rank is not a rank of this lot").toEqual(["lot-local", 9]);
    expect(readFileSync(logPath, "utf-8").slice(logStart)).toContain(`ignored for card ${card.id}`);
    await waitPasses(2);
    expect((await syncStatus()).queue_replaced, "a kept rank was not replaced").toBe(replacedBefore);
  } finally {
    pullStripLot = false;
    sqlOn(replica, "DELETE FROM roadmap_items WHERE id = ?", card.id);
  }
}, 60_000);

async function localLotCard(tag: string): Promise<{ a: RoadmapItem; b: RoadmapItem; named: RoadmapItem; hold: () => void }> {
  const [a, b, named] = (await queueCards(tag, 3)) as [RoadmapItem, RoadmapItem, RoadmapItem];
  const hold = () => {
    pullStripLot = true;
    sqlOn(replica, "UPDATE roadmap_items SET lot_id = 'lot-local', queue = NULL WHERE id = ?", named.id);
  };
  return { a, b, named, hold };
}

const swapAheadOf = (a: RoadmapItem, b: RoadmapItem, last: RoadmapItem) =>
  post(`${replica.url}/roadmap/reorder`, {
    project_key: PK,
    by: "agent-local",
    ids: [b.id, a.id, last.id],
    waves: [[b.id], [a.id], [last.id]],
  });

function withheldRanksOf(id: string): unknown[] {
  const db = openBrokerDb(replica.dbPath, { readonly: true });
  try {
    return (db.query("SELECT withheld FROM roadmap_queue_outbox ORDER BY seq").all() as { withheld: string }[]).map(
      (row) => (JSON.parse(row.withheld) as Record<string, unknown>)[id]
    );
  } finally {
    db.close();
  }
}

test("a pending journal records no rank from a lot-less upstream for a locally named card", async () => {
  const { a, b, named, hold } = await localLotCard("lot-less-withheld");
  queueDeltaSuppressed = true;
  try {
    hold();
    expect((await swapOnReplica(a, b)).status).toBe(200);
    await createOn(upstream, { id: named.id, by: "agent-upstream", title: "ranked by a lot-less upstream" });
    await waitForItem("the upstream row arrives", replica, named.id, (item) => item.title === "ranked by a lot-less upstream");
    expect(withheldRanksOf(named.id)).toEqual([undefined]);
  } finally {
    queueDeltaSuppressed = false;
    await journalEmpties();
    pullStripLot = false;
    sqlOn(replica, "DELETE FROM roadmap_items WHERE id = ?", named.id);
  }
}, 90_000);

const refusal = () => ({ status: 409, body: { error: "conflict", reason: "queue_rev" } });
const lotLessReceipt = (id: string) => ({
  status: 200,
  body: () => ({ mutation_id: queueDeltaSeen.at(-1)!.mutation_id, items: [{ id, queue: 2 }] }),
});

/**
 * Settles a sent mutation on a card held in a lot here. The pull is held for the
 * settlement, so a trace of that window comes from the settlement alone.
 */
async function settleOnLocalLotCard(tag: string, answer: (id: string) => { status: number; body: unknown }, seed?: (id: string) => void) {
  const { a, b, named, hold } = await localLotCard(tag);
  const logPath = join(replica.tmpDir, "logs", "broker.log");
  queueDeltaSuppressed = true;
  try {
    expect((await swapAheadOf(a, b, named)).status).toBe(200);
    await pollUntil("the mutation is sent", 20_000, async () => {
      const db = openBrokerDb(replica.dbPath, { readonly: true });
      const row = db.query("SELECT COUNT(*) AS n FROM roadmap_queue_outbox WHERE sent_at IS NOT NULL").get() as { n: number };
      db.close();
      return { done: row.n === 1, value: row.n };
    });
    pullSuppressed = true;
    await waitPasses(2);
    const journaled = withheldRanksOf(named.id);
    hold();
    seed?.(named.id);
    const logStart = readFileSync(logPath, "utf-8").length;
    queueDeltaOverride = answer(named.id);
    queueDeltaSuppressed = false;
    await journalEmpties();
    return {
      id: named.id,
      journaled,
      place: storedPlaceOn(replica, named.id),
      others: [storedPlaceOn(replica, a.id)[1], storedPlaceOn(replica, b.id)[1]],
      traces: readFileSync(logPath, "utf-8").slice(logStart),
    };
  } finally {
    queueDeltaSuppressed = false;
    queueDeltaOverride = null;
    pullSuppressed = false;
    pullStripLot = false;
    sqlOn(replica, "DELETE FROM roadmap_items WHERE id = ?", named.id);
  }
}

test("a refused mutation gives no rank back to a card held in a lot here", async () => {
  const settled = await settleOnLocalLotCard("lot-less-restore", refusal);

  expect(settled.journaled, "non-vacuity: the journal holds a default rank of the card").toEqual([3]);
  expect(settled.place).toEqual(["lot-local", null]);
  expect(settled.others).toEqual([1, 2]);
  expect(settled.traces).toContain(`journaled rank 3 not restored on card ${settled.id}`);
}, 90_000);

test("an acknowledgement without lot_id writes no rank on a card held in a lot here", async () => {
  const settled = await settleOnLocalLotCard("lot-less-ack", lotLessReceipt);

  expect(settled.place).toEqual(["lot-local", null]);
  expect(settled.traces).toContain(`ignored for card ${settled.id}`);
}, 90_000);

function rankInLotJournaledNone(id: string): void {
  sqlOn(replica, "UPDATE roadmap_items SET queue = 9 WHERE id = ?", id);
  sqlOn(replica, "UPDATE roadmap_queue_outbox SET withheld = json_set(withheld, ?, json('null'))", `$."${id}"`);
}

for (const [outcome, answer] of [["refused", refusal], ["acknowledged", lotLessReceipt]] as const) {
  test(`a null journaled for a card held in a lot here leaves its rank when the mutation is ${outcome}`, async () => {
    let seeded: unknown[] = [];
    const settled = await settleOnLocalLotCard(`lot-less-null-${outcome}`, answer, (id) => {
      rankInLotJournaledNone(id);
      seeded = withheldRanksOf(id);
    });

    expect(seeded, "non-vacuity: the journal holds a null for the card").toEqual([null]);
    expect(settled.place).toEqual(["lot-local", 9]);
    expect(settled.traces).toContain(`journaled rank null not restored on card ${settled.id}`);
  }, 90_000);
}

test("while a mutation is pending, a card moved upstream to a named lot takes the upstream's place", async () => {
  const { a, b } = await queuePair("lot-frozen");
  const lot = await upstreamLot();
  queueDeltaSuppressed = true;
  try {
    expect((await swapOnReplica(a, b)).status).toBe(200);
    await moveUpstream([a.id], lot);
    await waitLot(a.id, lot);
    expect(await placeOn(replica, a.id)).toEqual([lot, null]);
  } finally {
    queueDeltaSuppressed = false;
  }
  await journalEmpties();
  expect(await placeOn(replica, a.id)).toEqual([lot, null]);
}, 90_000);

test("lot writes are refused on a replica", async () => {
  const card = await createOn(replica, { by: "agent-local", title: "stays out of a replica lot", queue: 1 });
  const created = await post<{ error: string }>(`${replica.url}/roadmap/lot/create`, {
    project_key: PK,
    by: "agent-local",
    name: "local only",
  });
  const moved = await post<{ error: string }>(`${replica.url}/roadmap/lot/move`, {
    project_key: PK,
    by: "agent-local",
    ids: [card.id],
    from: "default",
    to: null,
  });

  expect([created.status, moved.status]).toEqual([403, 403]);
  expect(created.body.error).toContain("replica");
  expect((await itemOn(replica, card.id))?.lot_id).toBe("default");
}, 30_000);

test("a named lot's ranks stay out of the replica's queue journal and of its directive check", async () => {
  const { a, b } = await queuePair("lot-journal");
  const directive = await createOn(replica, { by: "agent-local", title: "directive of a named lot", kind: "directive", directive: "clear" });
  sqlOn(replica, "UPDATE roadmap_items SET lot_id = 'lot-local', queue = 7 WHERE id = ?", directive.id);
  let plain: RoadmapItem | undefined;
  holdQueueDelivery();
  try {
    plain = await createOn(replica, { by: "agent-local", title: "same rank, other lot", queue: 7 });
    expect((await post(`${replica.url}/roadmap/reorder`, {
      project_key: PK,
      by: "agent-local",
      ids: [b.id, a.id, plain.id],
      waves: [[b.id], [a.id], [plain.id]],
    })).status).toBe(200);
    expect(journaledOps().flatMap((op) => op.ids ?? [])).not.toContain(directive.id);
  } finally {
    sqlOn(replica, "DELETE FROM roadmap_items WHERE id = ?", directive.id);
    pullSuppressed = false;
  }
  await journalEmpties();
}, 90_000);

function storedPlaceOn(broker: TestBroker, id: string): [string | null, number | null] {
  const db = openBrokerDb(broker.dbPath, { readonly: true });
  try {
    const row = db.query("SELECT lot_id, queue FROM roadmap_items WHERE id = ?").get(id) as {
      lot_id: string | null;
      queue: number | null;
    };
    return [row.lot_id, row.queue];
  } finally {
    db.close();
  }
}

test("a named lot's card reaches the replica with its lot and its lot rank, unranked in a v1 answer, and neither side has it rewritten", async () => {
  const [named, a, b] = (await queueCards("lot-masked", 3)) as [RoadmapItem, RoadmapItem, RoadmapItem];
  const lot = await upstreamLot();
  await moveUpstream([named.id], lot);
  sqlOn(upstream, "UPDATE roadmap_items SET queue = 1 WHERE id = ?", named.id);
  await waitLot(named.id, lot);
  await waitPasses(2);
  expect(storedPlaceOn(replica, named.id)).toEqual([lot, 1]);
  expect((await itemOn(replica, named.id))?.queue).toBeNull();
  const replaced = (await syncStatus()).queue_replaced;
  await createOn(upstream, { id: named.id, by: "agent-upstream", title: "renamed in its lot" });
  await waitForItem("the rename arrives", replica, named.id, (item) => item.title === "renamed in its lot");
  await waitPasses(2);
  expect((await syncStatus()).queue_replaced, "an unchanged lot rank was not replaced").toBe(replaced);

  expect((await swapOnReplica(a, b)).status).toBe(200);
  await journalEmpties();
  await createOn(replica, { id: named.id, by: "agent-local", description: "edited on the replica" });
  await waitForItem("the edit reaches the upstream", upstream, named.id, (item) => item.description === "edited on the replica");
  await waitPasses(2);

  expect(storedPlaceOn(replica, named.id)).toEqual([lot, 1]);
  expect(storedPlaceOn(upstream, named.id)).toEqual([lot, 1]);
}, 90_000);

const waitPlace = (id: string, lot: string, rank: number | null, label: string) =>
  pollUntil(label, 20_000, async () => {
    const value = storedPlaceOn(replica, id);
    return { done: value[0] === lot && value[1] === rank, value };
  });

const replicaLog = () => readFileSync(join(replica.tmpDir, "logs", "broker.log"), "utf-8");

test("while a default mutation is pending, a new card keeps its lot rank and a card back from a lot takes none", async () => {
  const [leaving, a, b] = (await queueCards("lot-frozen-rank", 3)) as [RoadmapItem, RoadmapItem, RoadmapItem];
  const lot = await upstreamLot();
  await moveUpstream([leaving.id], lot);
  sqlOn(upstream, "UPDATE roadmap_items SET queue = 1 WHERE id = ?", leaving.id);
  await waitPlace(leaving.id, lot, 1, "the replica adopts the lot rank");

  queueDeltaSuppressed = true;
  try {
    expect((await swapOnReplica(a, b)).status).toBe(200);
    pullSuppressed = true;
    const born = await createOn(upstream, { by: "agent-upstream", title: "born in a lot", queue: 9 });
    await moveUpstream([born.id], lot);
    sqlOn(upstream, "UPDATE roadmap_items SET queue = 4 WHERE id = ?", born.id);
    pullSuppressed = false;
    await waitForItem("the new card arrives", replica, born.id, () => true);
    await waitPlace(born.id, lot, 4, "a card inserted while frozen keeps its lot rank");

    const moved = await post(
      `${upstream.url}/roadmap/lot/move`,
      deckAuthored({ project_key: PK, ids: [leaving.id], from: lot, to: "default" })
    );
    expect(moved.status).toBe(200);
    await waitPlace(leaving.id, "default", null, "the rank of the lot it left does not enter the default queue");
    expect(outboxCount(), "non-vacuity: the default queue was frozen throughout").toBe(1);
  } finally {
    pullSuppressed = false;
    queueDeltaSuppressed = false;
  }
  await journalEmpties();
}, 90_000);

test("an acknowledgement naming a card now in a lot writes its lot and lot rank, and keeps no default rank of it", async () => {
  const [a, b, c] = (await queueCards("lot-ack", 3)) as [RoadmapItem, RoadmapItem, RoadmapItem];
  queueDeltaSuppressed = true;
  try {
    expect((await swapAheadOf(a, b, c)).status).toBe(200);
    await pollUntil("the first mutation is sent", 20_000, async () => ({
      done: sentEntryCount() === 1,
      value: sentEntryCount(),
    }));
    expect((await post(`${replica.url}/roadmap/reorder`, {
      project_key: PK,
      by: "agent-local",
      ids: [a.id, b.id, c.id],
      waves: [[a.id], [b.id], [c.id]],
    })).status).toBe(200);
    pullSuppressed = true;
    await waitPasses(2);
    expect(withheldRanksOf(c.id), "non-vacuity: both entries hold a default rank").toEqual([3, 3]);
    queueDeltaOverride = {
      status: 200,
      body: () => {
        queueDeltaSuppressed = true;
        return {
          mutation_id: queueDeltaSeen.at(-1)!.mutation_id,
          items: [
            { id: c.id, lot_id: "lot-ack", queue: null, lot_rank: 5 },
            { id: a.id, lot_id: "lot-ack", queue: null, lot_rank: 1 },
          ],
        };
      },
    };
    queueDeltaSuppressed = false;
    await pollUntil("the first mutation is settled", 20_000, async () => ({ done: outboxCount() === 1, value: outboxCount() }));

    expect(storedPlaceOn(replica, c.id)).toEqual(["lot-ack", 5]);
    expect(storedPlaceOn(replica, a.id), "a change of lot under an unchanged rank is written").toEqual(["lot-ack", 1]);
    expect(withheldRanksOf(c.id)).toEqual([null]);
  } finally {
    queueDeltaOverride = null;
    queueDeltaSuppressed = false;
    pullSuppressed = false;
    await journalEmpties();
    for (const card of [a, c]) sqlOn(replica, "DELETE FROM roadmap_items WHERE id = ?", card.id);
  }
}, 90_000);

test("a pull page with an unreadable lot or lot rank is refused whole: the card keeps both and the cursor stays", async () => {
  const card = await createOn(upstream, { by: "agent-upstream", title: "unreadable lot fields", queue: 1 });
  await waitForItem("the card arrives", replica, card.id, () => true);
  const lot = await upstreamLot();
  await moveUpstream([card.id], lot);
  sqlOn(upstream, "UPDATE roadmap_items SET queue = 7 WHERE id = ?", card.id);
  await waitPlace(card.id, lot, 7, "the replica holds the card in its lot at rank 7");

  const faulty: Array<[string, (item: object) => void]> = [
    ["unreadable lot_rank", (item) => Object.assign(item, { lot_rank: 0 })],
    ["unreadable lot_id", (item) => Object.assign(item, { lot_id: "not a lot id" })],
    ["unreadable lot_id", (item) => Object.assign(item, { lot_id: 42 })],
    ["missing lot_rank", (item) => delete (item as { lot_rank?: number | null }).lot_rank],
  ];
  for (const [index, [fault, spoil]] of faulty.entries()) {
    await waitPasses(2);
    const cursor = localSyncMeta(replica, "upstream_cursor");
    const logStart = replicaLog().length;
    const title = `edit served unreadable ${index}`;
    let served = 0;
    pullRewrite = (page) => {
      for (const item of page.items) {
        if (item.id !== card.id) continue;
        spoil(item);
        served += 1;
      }
    };
    try {
      await createOn(upstream, { id: card.id, by: "agent-upstream", title });
      await pollUntil("the refusal is the status of a failed pass", 20_000, async () => {
        const error = (await syncStatus()).last_error ?? "";
        return { done: served >= 2 && error.includes(`${fault} for card "${card.id}"`), value: { served, error } };
      });
      expect(storedPlaceOn(replica, card.id)).toEqual([lot, 7]);
      expect((await itemOn(replica, card.id))?.title).not.toBe(title);
      expect(localSyncMeta(replica, "upstream_cursor")).toBe(cursor);
      expect(replicaLog().slice(logStart).split("\n").filter((line) => line.includes("pull page refused"))).toHaveLength(1);
    } finally {
      pullRewrite = null;
    }
    await waitForItem("the readable page applies", replica, card.id, (item) => item.title === title);
    expect(storedPlaceOn(replica, card.id)).toEqual([lot, 7]);
  }
}, 120_000);

test("an acknowledgement with an unreadable lot is not applied and its entry stays in the journal", async () => {
  const [a, b, named] = (await queueCards("lot-ack-unreadable", 3)) as [RoadmapItem, RoadmapItem, RoadmapItem];
  const lot = await upstreamLot();
  await moveUpstream([named.id], lot);
  sqlOn(upstream, "UPDATE roadmap_items SET queue = 4 WHERE id = ?", named.id);
  await waitPlace(named.id, lot, 4, "the replica holds the card in its lot");
  await waitPasses(2);
  try {
    const faulty: Array<[string, Record<string, unknown>]> = [
      ["unreadable lot_id", { lot_id: 42, lot_rank: 5 }],
      ["unreadable lot_id", { lot_id: {}, lot_rank: 5 }],
      ["missing lot_rank", { lot_id: lot }],
    ];
    for (const [fault, fields] of faulty) {
      queueDeltaOverride = {
        status: 200,
        body: () => ({
          mutation_id: queueDeltaSeen.at(-1)!.mutation_id,
          items: [{ id: named.id, queue: null, ...fields }],
        }),
      };
      const sent = queueDeltaSeen.length;
      if (outboxCount() === 0) expect((await swapOnReplica(a, b)).status).toBe(200);
      await pollUntil("the answer is served again on a later pass", 20_000, async () => ({
        done: queueDeltaSeen.length >= sent + 2,
        value: queueDeltaSeen.length - sent,
      }));
      await waitPasses(1);
      expect([fields, storedPlaceOn(replica, named.id), outboxCount()]).toEqual([fields, [lot, 4], 1]);
      await pollUntil("the status names the fault of this answer", 20_000, async () => {
        const failure = (await syncStatus()).queue_outbox?.last_failure ?? "";
        return { done: failure.includes(`${fault} for card "${named.id}"`), value: failure };
      });
    }
  } finally {
    queueDeltaOverride = null;
  }
  await journalEmpties();
  await waitRanks("the kept entry reaches the upstream", upstream, a, b, 2, 1);
  expect(storedPlaceOn(replica, named.id)).toEqual([lot, 4]);
}, 120_000);

test("after another broker pulled on the same database, the replica pulls every card again and recovers lot ranks", async () => {
  const card = await createOn(upstream, { by: "agent-upstream", title: "rank dropped by an older broker", queue: 1 });
  await waitForItem("the card arrives", replica, card.id, () => true);
  const lot = await upstreamLot();
  await moveUpstream([card.id], lot);
  sqlOn(upstream, "UPDATE roadmap_items SET queue = 6 WHERE id = ?", card.id);
  await waitPlace(card.id, lot, 6, "the replica holds the lot rank");

  await goOffline();
  const logStart = replicaLog().length;
  const db = openBrokerDb(replica.dbPath);
  try {
    // What a broker blind to lot ranks leaves: no rank on the row, a cursor past it, the capability untouched.
    db.transaction(() => {
      db.run("UPDATE roadmap_sync_meta SET value = '1' WHERE key = 'applying'");
      db.run("UPDATE roadmap_items SET queue = NULL WHERE id = ?", [card.id]);
      db.run("UPDATE roadmap_sync_meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'upstream_cursor'");
      db.run("UPDATE roadmap_sync_meta SET value = '0' WHERE key = 'applying'");
    })();
  } finally {
    db.close();
  }
  expect(storedPlaceOn(replica, card.id), "non-vacuity: the rank is gone").toEqual([lot, null]);
  await goOnline();

  await waitPlace(card.id, lot, 6, "the unchanged card is served again with its lot rank");
  expect(replicaLog().slice(logStart)).toContain("another broker moved the pull cursor");
}, 120_000);

function adoptedLotRevs(broker: TestBroker, table: "roadmap_queue_upstream" | "roadmap_queue_state"): unknown[] {
  const db = openBrokerDb(broker.dbPath, { readonly: true });
  try {
    return db.query(`SELECT lot_id, rev FROM ${table} WHERE project_key = ? ORDER BY lot_id`).all(PK);
  } finally {
    db.close();
  }
}

const revsMatch = (label: string) =>
  pollUntil(label, 20_000, async () => {
    const [held, served] = [adoptedLotRevs(replica, "roadmap_queue_upstream"), adoptedLotRevs(upstream, "roadmap_queue_state")];
    return { done: JSON.stringify(held) === JSON.stringify(served), value: { held, served } };
  });

test("a replica adopts the revision of every lot, and refuses a malformed table by lot whole", async () => {
  const card = await createOn(upstream, { by: "agent-upstream", title: "revision by lot", queue: 1 });
  const lot = await upstreamLot();
  await moveUpstream([card.id], lot);
  await revsMatch("the replica holds the upstream revision of each lot");
  const held = adoptedLotRevs(replica, "roadmap_queue_upstream");
  expect(held, "non-vacuity: a named lot has a revision of its own").toContainEqual({ lot_id: lot, rev: expect.any(Number) });
  const logStart = replicaLog().length;
  try {
    for (const malformed of [{ default: 424_242, "not a lot id": 1 }, { default: -1 }, 424_242]) {
      let served = 0;
      pullRewrite = (page) => {
        served += 1;
        page.lot_queue_revs = { [PK]: malformed as Record<string, number> };
      };
      await pollUntil("two pulls carry the malformed table", 20_000, async () => ({ done: served >= 2, value: served }));
      expect([malformed, adoptedLotRevs(replica, "roadmap_queue_upstream")]).toEqual([malformed, held]);
    }
    expect(replicaLog().slice(logStart)).toContain("pull queue_revs refused");
  } finally {
    pullRewrite = null;
  }
  await revsMatch("a valid page is adopted again");
}, 90_000);

test("a replica mutation quotes the default lot's revision, whatever other lot is listed first", async () => {
  const { a, b } = await queuePair("lot-quoted-rev");
  sqlOn(upstream, "INSERT INTO roadmap_queue_state (project_key, lot_id, rev) VALUES (?, '0-listed-first', 999999)", PK);
  try {
    await revsMatch("the replica holds the other lot's revision");
    const quoted = upstreamQueueRev();
    expect((await swapOnReplica(a, b)).status).toBe(200);
    await journalEmpties();
    expect(queueDeltaSeen.at(-1)!.expected_queue_rev).toBe(quoted);
    await waitRanks("the upstream applies the swap", upstream, a, b, 2, 1);
  } finally {
    sqlOn(upstream, "DELETE FROM roadmap_queue_state WHERE lot_id = '0-listed-first'");
  }
}, 90_000);

async function lotsOn(broker: TestBroker): Promise<unknown[]> {
  const res = await post<{ lots: unknown[] }>(`${broker.url}/roadmap/lot/list`, { project_key: PK });
  expect(res.status).toBe(200);
  return res.body.lots;
}

test("a replica lists the upstream's lots, keeps them over a page without the list and refuses a malformed list whole", async () => {
  await upstreamLot();
  const served = await lotsOn(upstream);
  await pollUntil("the replica lists the upstream's lots", 20_000, async () => {
    const held = await lotsOn(replica);
    return { done: JSON.stringify(held) === JSON.stringify(served), value: held };
  });
  const logStart = replicaLog().length;
  const lotTraces = () => replicaLog().slice(logStart).split("\n").filter((line) => line.includes("pull lots refused"));
  type Lots = NonNullable<RoadmapSyncPullResponse["lots"]>;
  const serve = async (what: string, edit: (page: RoadmapSyncPullResponse) => void) => {
    let pages = 0;
    pullRewrite = (page) => {
      pages += 1;
      edit(page);
    };
    await pollUntil(`two pulls with ${what}`, 20_000, async () => ({ done: pages >= 2, value: pages }));
    expect([what, await lotsOn(replica)]).toEqual([what, served]);
  };
  try {
    await serve("no list", (page) => {
      delete page.lots;
    });
    expect(lotTraces(), "an absent list is no refusal").toEqual([]);
    await serve("a list that is no list", (page) => {
      page.lots = {} as Lots;
    });
    expect(lotTraces()).toHaveLength(1);
    expect(lotTraces()[0]).toContain("it is not an array");
    await serve("a valid list again", () => {});
    await serve("one lot listed twice", (page) => {
      page.lots = [...page.lots!, page.lots![0]!].map((lot) => ({ ...lot, name: "twice" }));
    });
    expect(lotTraces(), "an adopted list re-arms the trace").toHaveLength(2);
    expect(lotTraces()[1]).toContain("listed twice");
    const bad: Array<[string, Record<string, unknown>]> = [
      ["a mixed-case project key", { project_key: "github.com/Mixed/Case" }],
      ["an id that is no id", { id: "not a lot id" }],
      ["an empty name", { name: "" }],
      ["a name past the limit", { name: "n".repeat(121) }],
      ["a creator that is no text", { created_by: 3 }],
      ["a closing date that is no text", { closed_at: 3 }],
      ["a colour past the palette", { color: 8 }],
      ["a fractional colour", { color: 1.5 }],
    ];
    for (const [what, field] of bad) {
      await serve(what, (page) => {
        const renamed = page.lots!.map((lot) => ({ ...lot, name: "renamed beside a bad one" }));
        page.lots = [...renamed, { ...renamed[0]!, id: "one-more", ...field }] as Lots;
      });
    }
    expect(lotTraces(), "a run of refused lists is said once").toHaveLength(2);
  } finally {
    pullRewrite = null;
  }
}, 120_000);

test("a local database turned into a replica keeps its own lot, names it once, and takes the upstream's changes", async () => {
  const local = await startBroker();
  let switched: TestBroker | undefined;
  try {
    const own = await post<{ lot: { id: string } }>(`${local.url}/roadmap/lot/create`, {
      project_key: PK,
      by: "agent-local",
      name: "local only",
    });
    expect(own.status).toBe(200);
    // stopBroker would delete the database with its directory.
    local.proc.kill();
    await local.proc.exited;
    const shared = await upstreamLot();
    switched = await startBroker({
      CLAUDE_PEERS_DB: local.dbPath,
      CLAUDE_PEERS_BROKER_URL: `http://127.0.0.1:${proxy.port}`,
      CLAUDE_PEERS_BROKER_TOKEN: TOKEN,
      CLAUDE_PEERS_OFFLINE_REPLICA: "1",
      CLAUDE_PEERS_SYNC_TICK_MS: "200",
    });
    const replicaNow = switched;
    const listed = async () => (await lotsOn(replicaNow)) as { id: string; name: string }[];
    const waitName = (name: string) =>
      pollUntil(`the lot is listed as '${name}'`, 20_000, async () => {
        const value = (await listed()).find((lot) => lot.id === shared)?.name;
        return { done: value === name, value };
      });
    await waitName("upstream lot");
    sqlOn(upstream, "UPDATE roadmap_lots SET name = 'renamed upstream' WHERE id = ?", shared);
    await waitName("renamed upstream");

    expect((await listed()).map((lot) => lot.id)).toContain(own.body.lot.id);
    const log = readFileSync(join(replicaNow.tmpDir, "logs", "broker.log"), "utf-8");
    const naming = log.split("\n").filter((line) => line.includes(own.body.lot.id));
    expect(naming, "named once, not on every pass").toHaveLength(1);
    expect(naming[0]).toContain("not listed by the upstream");
    expect(log).not.toContain(`lot ${shared} of`);
  } finally {
    if (switched) await stopBroker(switched);
    await stopBroker(local);
  }
}, 90_000);

test("when the upstream starts taking lots, the replica pulls every card again, once", async () => {
  const card = await createOn(upstream, { by: "agent-upstream", title: "ranked before the replica read lots", queue: 1 });
  await waitForItem("the card arrives", replica, card.id, () => true);
  const lot = await upstreamLot();
  pullRewrite = withoutLotProtocol;
  try {
    await moveUpstream([card.id], lot);
    sqlOn(upstream, "UPDATE roadmap_items SET queue = 1 WHERE id = ?", card.id);
    await waitPlace(card.id, lot, null, "an upstream without the protocol sends no lot rank");
    await createOn(upstream, { by: "agent-upstream", title: "moves the default revision", queue: 2 });
    await pollUntil("the revisions are the default lot's alone", 20_000, async () => {
      const held = adoptedLotRevs(replica, "roadmap_queue_upstream") as { lot_id: string }[];
      return { done: held.length === 1 && held[0]!.lot_id === "default" && adoptedQueueRev() === upstreamQueueRev(), value: held };
    });
    await waitPasses(2);
    expect(storedPlaceOn(replica, card.id)).toEqual([lot, null]);

    const before = rewrittenPullCursors.length;
    const logStart = replicaLog().length;
    pullRewrite = () => {};
    await waitPlace(card.id, lot, 1, "the unchanged card is served again with its lot rank");
    await waitPasses(3);
    expect(rewrittenPullCursors.slice(before).filter((cursor) => cursor === 0)).toHaveLength(1);
    expect(replicaLog().slice(logStart), "its own restart is not another broker's").not.toContain(
      "another broker moved the pull cursor"
    );
  } finally {
    pullRewrite = null;
  }
}, 90_000);

test("a replica that predates lots is never handed a named lot's rank", async () => {
  const [named, a] = (await queueCards("lot-old-replica", 2)) as [RoadmapItem, RoadmapItem];
  const lot = await upstreamLot();
  pullStripLot = true;
  try {
    await moveUpstream([named.id], lot);
    sqlOn(upstream, "UPDATE roadmap_items SET queue = 1 WHERE id = ?", named.id);
    // A later edit of the same card, so the page carrying the stored rank has been applied once it shows.
    await createOn(upstream, { id: named.id, by: "agent-upstream", title: "ranked in a lot upstream" });
    await waitForItem("the upstream row arrives", replica, named.id, (item) => item.title === "ranked in a lot upstream");
    expect([storedPlaceOn(replica, named.id)[1], storedPlaceOn(replica, a.id)[1]]).toEqual([null, 2]);
  } finally {
    pullStripLot = false;
  }
}, 60_000);

test("a replica serves a named lot's card without a rank, in a conflict too", async () => {
  const card = await createOn(upstream, { by: "agent-upstream", title: "ranked by a newer broker" });
  await waitForItem("the card arrives", replica, card.id, () => true);
  const db = openBrokerDb(replica.dbPath);
  const stored = db.query("SELECT * FROM roadmap_items WHERE id = ?").get(card.id) as Record<string, unknown>;
  const remote = {
    ...stored,
    tags: [],
    depends_on: [],
    target_peer_ids: [],
    lock_contested_by: [],
    inactive: false,
    locked: false,
    lot_id: "lot-newer",
    queue: 4,
    lot_rank: 4,
  };
  db.run("UPDATE roadmap_items SET lot_id = 'lot-newer', queue = 3, sync_state = 'conflict', sync_remote = ? WHERE id = ?", [
    JSON.stringify(remote),
    card.id,
  ]);
  db.close();
  try {
    const conflicts = await post<RoadmapSyncConflictsResponse>(`${replica.url}/roadmap/sync/conflicts`, { project_key: PK });
    const conflict = conflicts.body.items.find((item) => item.local.id === card.id);
    expect([conflict?.local.queue, conflict?.remote.queue]).toEqual([null, null]);
    expect([conflict!.local, conflict!.remote].map((side) => "lot_rank" in side)).toEqual([false, false]);
    expect((await itemOn(replica, card.id))?.queue).toBeNull();
  } finally {
    sqlOn(replica, "DELETE FROM roadmap_items WHERE id = ?", card.id);
  }
}, 60_000);
