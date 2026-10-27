// Peer federation end to end: one upstream U, two replicas R1 and R2 each
// behind a proxy this file controls, a native peer C on U, A on R1 and B on
// R2. Directory, messaging in every direction, what stays local, the two
// outage shapes (back before the grace, back after it), the queue guard
// against the local mechanic A, the name collision, and an upstream of an
// older version that does not federate.

import { test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  startBroker,
  stopBroker,
  livePid,
  sha256Hex,
  groupId,
  mintRunCredential,
  operatorInboxProof,
  registerAttestedInstance,
  runInboxProof,
  type RunCredential,
  type TestBroker,
  openBrokerDb,
} from "./_helper.ts";
import { deriveInstanceRef, INBOX_GATES } from "../shared/approval.ts";
import { startUpstreamProxy, type UpstreamProxy } from "./_upstream-proxy.ts";
import type {
  DeliveredMessage,
  PublicPeer,
  RegisterResponse,
  RoadmapItem,
  RoadmapSyncStatus,
  SendMessageResponse,
} from "../shared/types.ts";

const TOKEN = "peer-federation-token";
const SECRET = "peer-federation-secret";
const PK = "github.com/vocsap/federation-repo";
/**
 * A failed pass only checks the grace, and an offline replica's passes back off
 * to 0.8 s then 2.4 s after the transition: a 2 s grace expires on the second
 * of them, and the short outage reconnects well before it.
 */
const GRACE_SEC = 2;

let G: string;
let H: string;
let U: TestBroker;
let R1: TestBroker;
let R2: TestBroker;
let P1: UpstreamProxy;
let P2: UpstreamProxy;
let r1Label: string;
let r2Label: string;
let A: RegisterResponse;
let B: RegisterResponse;
let C: RegisterResponse;
let heartbeat: ReturnType<typeof setInterval>;

async function post<T = unknown>(url: string, body: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T };
}

async function getAuth<T = unknown>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { authorization: `Bearer ${TOKEN}` } });
  return (await res.json()) as T;
}

async function pollUntil<T>(
  label: string,
  check: () => Promise<{ done: boolean; value: T }>,
  budgetMs = 15_000
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

function replicaLabel(b: TestBroker): string {
  const db = openBrokerDb(b.dbPath, { readonly: true });
  try {
    const row = db.query("SELECT value FROM roadmap_sync_meta WHERE key = 'replica_id'").get() as { value: string };
    return row.value.slice(0, 8);
  } finally {
    db.close();
  }
}

function startReplica(proxy: UpstreamProxy): Promise<TestBroker> {
  return startBroker({
    CLAUDE_PEERS_BROKER_URL: proxy.url,
    CLAUDE_PEERS_BROKER_TOKEN: TOKEN,
    CLAUDE_PEERS_OFFLINE_REPLICA: "1",
    CLAUDE_PEERS_SYNC_TICK_MS: "200",
    CLAUDE_PEERS_FEDERATION_GRACE_SEC: String(GRACE_SEC),
  });
}

async function register(b: TestBroker, host: string, cwd: string): Promise<RegisterResponse> {
  const res = await post<RegisterResponse>(`${b.url}/register`, {
    pid: livePid(),
    cwd,
    git_root: null,
    tty: null,
    summary: `${host} summary`,
    host,
    client_pid: livePid(),
    project_key: null,
    group_id: G,
    group_secret_hash: H,
  });
  expect([`register ${host}`, res.status]).toEqual([`register ${host}`, 200]);
  return res.body;
}

async function setId(b: TestBroker, token: string, name: string): Promise<void> {
  const res = await post<{ peer_id?: string; error?: string }>(`${b.url}/set-id`, {
    instance_token: token,
    new_peer_id: name,
  });
  expect([`set_id ${name}`, res.status, res.body.error]).toEqual([`set_id ${name}`, 200, undefined]);
}

async function listPeers(b: TestBroker, token: string): Promise<PublicPeer[]> {
  return (await post<PublicPeer[]>(`${b.url}/list-peers`, {
    instance_token: token,
    scope: "machine",
    cwd: "",
    git_root: null,
  })).body;
}

function names(peers: PublicPeer[]): string[] {
  return peers.map((p) => p.peer_id).sort();
}

async function send(b: TestBroker, from: string, to: string, text: string): Promise<SendMessageResponse> {
  return (await post<SendMessageResponse>(`${b.url}/send-message`, { from_token: from, to_peer_id: to, text })).body;
}

async function poll(b: TestBroker, token: string): Promise<DeliveredMessage[]> {
  return (await post<{ messages: DeliveredMessage[] }>(`${b.url}/poll-messages`, { instance_token: token })).body.messages;
}

/** Polls until a message with this text is delivered to the peer; returns everything drained meanwhile. */
async function receive(label: string, b: TestBroker, token: string, text: string): Promise<DeliveredMessage> {
  const drained: DeliveredMessage[] = [];
  return pollUntil(label, async () => {
    drained.push(...(await poll(b, token)));
    const hit = drained.find((m) => m.text === text);
    return { done: hit !== undefined, value: hit ?? drained };
  }) as Promise<DeliveredMessage>;
}

async function syncStatus(b: TestBroker): Promise<RoadmapSyncStatus> {
  return (await post<RoadmapSyncStatus>(`${b.url}/roadmap/sync/status`, {})).body;
}

/** Waits until the replica has completed `n` more sync passes. */
async function waitPasses(b: TestBroker, n: number): Promise<void> {
  let seen = (await syncStatus(b)).last_sync_at;
  let count = 0;
  await pollUntil(`${n} sync passes`, async () => {
    const now = (await syncStatus(b)).last_sync_at;
    if (now !== seen) {
      seen = now;
      count += 1;
    }
    return { done: count >= n, value: count };
  });
}

/** Waits until a whole pass of each replica has run, R1's first, then R2's. */
async function settleBothReplicas(): Promise<void> {
  await waitPasses(R1, 2);
  await waitPasses(R2, 2);
}

async function goOffline(proxy: UpstreamProxy, replica: TestBroker): Promise<void> {
  proxy.blocked = true;
  await pollUntil("the replica notices the outage", async () => {
    const status = await syncStatus(replica);
    return { done: status.online === false, value: status.online };
  });
}

async function goOnline(proxy: UpstreamProxy, replica: TestBroker): Promise<void> {
  proxy.blocked = false;
  await pollUntil("the replica reconnects", async () => {
    const status = await syncStatus(replica);
    return { done: status.online === true, value: status.online };
  });
}

function openWs(b: TestBroker, token: string): Promise<{ ws: WebSocket; frames: Record<string, unknown>[] }> {
  return new Promise((resolve, reject) => {
    const frames: Record<string, unknown>[] = [];
    // Bun's WebSocket takes request headers; the brokers here are authenticated.
    const ws = new WebSocket(b.wsUrl, { headers: { authorization: `Bearer ${TOKEN}` } } as unknown as string[]);
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ type: "auth", instance_token: token }));
      setTimeout(() => resolve({ ws, frames }), 100);
    });
    ws.addEventListener("message", (e) => {
      frames.push(JSON.parse(String(e.data)) as Record<string, unknown>);
    });
    ws.addEventListener("error", () => reject(new Error("ws error")));
  });
}

function countMessages(b: TestBroker, where: string, ...params: (string | number)[]): number {
  const db = openBrokerDb(b.dbPath, { readonly: true });
  try {
    return (db.query(`SELECT COUNT(*) AS n FROM messages WHERE ${where}`).get(...params) as { n: number }).n;
  } finally {
    db.close();
  }
}

beforeAll(async () => {
  G = await groupId(SECRET);
  H = await sha256Hex(SECRET);
  // U sweeps fast so a replica that fell silent shows within seconds; the
  // native peer C is kept alive by a heartbeat the test drives itself.
  U = await startBroker({
    CLAUDE_PEERS_BROKER_TOKEN: TOKEN,
    CLAUDE_PEERS_SERVE_REPLICAS: "1",
    CLAUDE_PEERS_ACTIVE_STALE_SEC: "2",
    CLAUDE_PEERS_DORMANT_SWEEP_SEC: "1",
  });
  P1 = startUpstreamProxy(U.url);
  P2 = startUpstreamProxy(U.url);
  [R1, R2] = await Promise.all([startReplica(P1), startReplica(P2)]);
  r1Label = replicaLabel(R1);
  r2Label = replicaLabel(R2);
  C = await register(U, "host-c", "/work/c");
  heartbeat = setInterval(() => {
    void post(`${U.url}/heartbeat`, { instance_token: C.instance_token });
  }, 500);
  A = await register(R1, "host-a", "/work/a");
  B = await register(R2, "host-b", "/work/b");
  await setId(R1, A.instance_token, "alice");
  await setId(R2, B.instance_token, "bob");
  await setId(U, C.instance_token, "carol");
});

// Every test starts from the directory the topology settles on, whatever ran
// before it: each agent under its own name, seeing exactly the two others.
beforeEach(async () => {
  for (const [label, b, token, expected] of [
    ["A sees bob and carol", () => R1, () => A, "bob,carol"],
    ["B sees alice and carol", () => R2, () => B, "alice,carol"],
    ["C sees alice and bob", () => U, () => C, "alice,bob"],
  ] as const) {
    await pollUntil(label, async () => {
      const peers = await listPeers(b(), token().instance_token);
      return { done: names(peers).join() === expected, value: names(peers) };
    });
  }
});

afterAll(async () => {
  clearInterval(heartbeat);
  P1.stop();
  P2.stop();
  await Promise.all([stopBroker(R1), stopBroker(R2)]);
  await stopBroker(U);
});

test("directory: every agent sees the two others with their origin, never itself nor its alias", async () => {
  const fromA = await pollUntil("A sees bob and carol", async () => {
    const peers = await listPeers(R1, A.instance_token);
    return { done: names(peers).join() === "bob,carol", value: names(peers) };
  }, 15_000);
  expect(fromA).toEqual(["bob", "carol"]);
  const aView = await listPeers(R1, A.instance_token);
  expect([
    "A sees B via R2's label and C via the upstream, with their real hosts",
    aView.find((p) => p.peer_id === "bob")?.via,
    aView.find((p) => p.peer_id === "bob")?.host,
    aView.find((p) => p.peer_id === "carol")?.via,
    aView.find((p) => p.peer_id === "carol")?.summary,
  ]).toEqual([
    "A sees B via R2's label and C via the upstream, with their real hosts",
    r2Label,
    "host-b",
    "upstream",
    "host-c summary",
  ]);

  const fromB = await pollUntil("B sees alice and carol", async () => {
    const peers = await listPeers(R2, B.instance_token);
    return { done: names(peers).join() === "alice,carol", value: names(peers) };
  });
  expect(fromB).toEqual(["alice", "carol"]);

  const fromC = await pollUntil("C sees alice and bob", async () => {
    const peers = await listPeers(U, C.instance_token);
    return { done: names(peers).join() === "alice,bob", value: names(peers) };
  });
  expect(fromC).toEqual(["alice", "bob"]);
  const cView = await listPeers(U, C.instance_token);
  expect([
    "C sees each relayed peer via its replica's label, with pid never on the wire",
    cView.find((p) => p.peer_id === "alice")?.via,
    cView.find((p) => p.peer_id === "bob")?.via,
    "pid" in (cView[0] as object),
  ]).toEqual(["C sees each relayed peer via its replica's label, with pid never on the wire", r1Label, r2Label, false]);
});

test("messaging: replica to replica, replica to upstream and back, delivered once, under upstream names", async () => {
  const { ws: wsB, frames: framesB } = await openWs(R2, B.instance_token);
  const { ws: wsC, frames: framesC } = await openWs(U, C.instance_token);
  try {
    const aToB = await send(R1, A.instance_token, "bob", "hello bob from alice");
    expect(["A -> B is relayed synchronously", aToB]).toEqual(["A -> B is relayed synchronously", { ok: true }]);
    const frame = await pollUntil("B receives A's message over its WebSocket on R2", async () => {
      const hit = framesB.find((f) => f.text === "hello bob from alice");
      return { done: hit !== undefined, value: hit ?? framesB };
    });
    expect(["the WS frame names the sender by its upstream name", frame.from_peer_id, frame.from_host]).toEqual([
      "the WS frame names the sender by its upstream name",
      "alice",
      "host-a",
    ]);
    const polled = await receive("B drains A's message", R2, B.instance_token, "hello bob from alice");
    expect(["the polled copy carries the same sender", polled.from_peer_id]).toEqual([
      "the polled copy carries the same sender",
      "alice",
    ]);
    await waitPasses(R2, 2);
    expect([
      "a message pulled twice is inserted once (federation_id is unique)",
      (await poll(R2, B.instance_token)).filter((m) => m.text === "hello bob from alice"),
      countMessages(R2, "text = ?", "hello bob from alice"),
    ]).toEqual(["a message pulled twice is inserted once (federation_id is unique)", [], 1]);

    const bToA = await send(R2, B.instance_token, "alice", "hello alice from bob");
    expect(bToA).toEqual({ ok: true });
    const atA = await receive("A receives B's message", R1, A.instance_token, "hello alice from bob");
    expect(atA.from_peer_id).toBe("bob");

    const aToC = await send(R1, A.instance_token, "carol", "hello carol from alice");
    expect(aToC).toEqual({ ok: true });
    const atC = await pollUntil("C receives A's message over its WebSocket on U", async () => {
      const hit = framesC.find((f) => f.text === "hello carol from alice");
      return { done: hit !== undefined, value: hit ?? framesC };
    });
    expect(["C sees the relayed sender by its upstream name", atC.from_peer_id]).toEqual([
      "C sees the relayed sender by its upstream name",
      "alice",
    ]);
    await receive("C drains A's message", U, C.instance_token, "hello carol from alice");

    const cToA = await send(U, C.instance_token, "alice", "hello alice from carol");
    expect(cToA).toEqual({ ok: true, message_id: expect.any(Number) });
    const fromC = await receive("A receives C's message", R1, A.instance_token, "hello alice from carol");
    expect(fromC.from_peer_id).toBe("carol");
  } finally {
    wsB.close();
    wsC.close();
  }
}, 30_000);

test("the operator inbox and the Deck's announcements never leave their broker", async () => {
  const run = await mintRunCredential(R1, { id: G, hash: H }, undefined, post);
  const depositor = await registerAttestedInstance(R1, run, "host-depositor", "/work/depositor", {}, post);
  try {
    const question = "a question for my operator";
    const deposit = { from_token: depositor.body.instance_token, to_peer_id: "operator", text: question };
    const toOperator = await post<SendMessageResponse>(`${R1.url}/send-message`, {
      ...deposit,
      auth: runInboxProof(run, deposit, INBOX_GATES.deposit),
    });
    await settleBothReplicas();
    const stored = [R1, U, R2].map((b) => countMessages(b, "text = ?", question));
    const drainBody = { group_id: G, group_secret_hash: H, run_ref: run.run, session_id: "federation-drain" };
    const drained = await post<{ messages?: { text: string }[] }>(`${R1.url}/operator-inbox`, {
      ...drainBody,
      auth: operatorInboxProof(drainBody, INBOX_GATES.drain),
    });
    expect(["operator is a local deposit", toOperator.body]).toEqual(["operator is a local deposit", { ok: true, message_id: expect.any(Number) }]);
    expect([
      "the deposit is in R1's inbox and in no other",
      drained.status,
      drained.body.messages?.map((m) => m.text),
      stored,
    ]).toEqual(["the deposit is in R1's inbox and in no other", 200, [question], [1, 0, 0]]);
  } finally {
    await post(`${R1.url}/unregister`, { instance_token: depositor.body.instance_token });
  }

  const broadcast = await post<{ sent: number }>(`${R1.url}/announce`, {
    group_id: G,
    group_secret_hash: H,
    text: "deck says hello on R1",
  });
  expect(["a broadcast counts local peers only", broadcast.body.sent]).toEqual(["a broadcast counts local peers only", 1]);
  const targeted = await post<{ error?: string }>(`${R1.url}/announce`, {
    group_id: G,
    group_secret_hash: H,
    text: "deck targets bob",
    to_peer_id: "bob",
  });
  expect(["a targeted announce to a mirror is a missing peer", targeted.status]).toEqual([
    "a targeted announce to a mirror is a missing peer",
    404,
  ]);
  await settleBothReplicas();
  expect([
    "no announcement reaches the upstream or B",
    countMessages(U, "text LIKE 'deck %'"),
    (await poll(R2, B.instance_token)).filter((m) => m.text.startsWith("deck ")),
  ]).toEqual(["no announcement reaches the upstream or B", 0, []]);
  await receive("A receives the local broadcast", R1, A.instance_token, "deck says hello on R1");
});

test("a relay that fails while the link is up is queued, and leaves with the next pass", async () => {
  // The first relay attempt alone is answered 5xx: the agent's send is
  // accepted into the queue instead of refused, and the pass that follows
  // (whose sync still succeeds) carries the row out.
  let failed = false;
  P1.intercept = (path) => {
    if (path !== "/federation/send" || failed) return null;
    failed = true;
    return Response.json({ error: "boom" }, { status: 503 });
  };
  try {
    const queued = await send(R1, A.instance_token, "bob", "queued behind a failing relay");
    expect(["a 5xx on the relay queues the message", queued.ok, queued.queued, typeof queued.grace_left_sec]).toEqual([
      "a 5xx on the relay queues the message",
      true,
      true,
      "number",
    ]);
    expect(["the queued row waits on R1, addressed to the mirror", countMessages(R1, "text = ?", "queued behind a failing relay")]).toEqual([
      "the queued row waits on R1, addressed to the mirror",
      1,
    ]);
    await receive("the queue drains at the next pass", R2, B.instance_token, "queued behind a failing relay");
    expect([
      "the drained row is marked delivered on R1 and the link never read as down",
      countMessages(R1, "text = ? AND delivered = 0", "queued behind a failing relay"),
      (await syncStatus(R1)).online,
    ]).toEqual(["the drained row is marked delivered on R1 and the link never read as down", 0, true]);
  } finally {
    P1.intercept = null;
  }
}, 30_000);

test("an outage shorter than the grace: mirrors stay listed as link-down, the queue drains on return", async () => {
  await goOffline(P1, R1);
  const offlineView = await listPeers(R1, A.instance_token);
  const bob = offlineView.find((p) => p.peer_id === "bob");
  expect([
    "within the grace B is still listed, marked with the moment the link fell",
    bob !== undefined,
    typeof bob?.link_down_since,
  ]).toEqual(["within the grace B is still listed, marked with the moment the link fell", true, "string"]);
  const queued = await send(R1, A.instance_token, "bob", "sent during a short outage");
  expect(["A -> B is queued with the time left", queued.ok, queued.queued, (queued.grace_left_sec ?? 0) > 0]).toEqual([
    "A -> B is queued with the time left",
    true,
    true,
    true,
  ]);
  expect(["C -> A is accepted upstream and waits", await send(U, C.instance_token, "alice", "sent while R1 was away")]).toEqual([
    "C -> A is accepted upstream and waits",
    { ok: true, message_id: expect.any(Number) },
  ]);
  await goOnline(P1, R1);
  await receive("B receives the queued message", R2, B.instance_token, "sent during a short outage");
  await receive("A receives what C sent during the outage", R1, A.instance_token, "sent while R1 was away");
  await pollUntil("A is active again for C", async () => {
    const peers = await listPeers(U, C.instance_token);
    return { done: names(peers).includes("alice"), value: names(peers) };
  });
}, 40_000);

test("an outage longer than the grace: mirrors go dormant, the queue is dropped and the sender told", async () => {
  await goOffline(P1, R1);
  const queued = await send(R1, A.instance_token, "bob", "sent during a long outage");
  expect(queued.queued).toBe(true);
  const cView = await pollUntil("C sees A dormant after the stale sweep", async () => {
    const peers = await listPeers(U, C.instance_token);
    return { done: !names(peers).includes("alice"), value: names(peers) };
  });
  expect(cView).not.toContain("alice");
  const aView = await pollUntil("beyond the grace B and C vanish from A's list", async () => {
    const peers = await listPeers(R1, A.instance_token);
    return { done: peers.length === 0, value: names(peers) };
  });
  expect(aView).toEqual([]);
  const notice = await receive("A is told its message was dropped", R1, A.instance_token, await pollUntil("the deck notice lands", async () => {
    const db = openBrokerDb(R1.dbPath, { readonly: true });
    try {
      const row = db.query("SELECT text FROM messages WHERE text LIKE 'Your message to %dropped%' ORDER BY id DESC LIMIT 1").get() as { text: string } | null;
      return { done: row !== null, value: row?.text ?? "" };
    } finally {
      db.close();
    }
  }));
  expect([
    "the notice comes from the deck sentinel, names the recipient and the outage length",
    notice.from_peer_id,
    notice.text.includes("'bob'"),
    /unreachable for \d+ min/.test(notice.text),
  ]).toEqual(["the notice comes from the deck sentinel, names the recipient and the outage length", "deck", true, true]);
  expect(["the queued row is gone", countMessages(R1, "text = ?", "sent during a long outage")]).toEqual([
    "the queued row is gone",
    0,
  ]);
  const refused = await send(R1, A.instance_token, "bob", "after the grace");
  expect(["beyond the grace a remote peer is simply not there", refused.ok, refused.error]).toEqual([
    "beyond the grace a remote peer is simply not there",
    false,
    "Peer 'bob' not found in your group",
  ]);

  await goOnline(P1, R1);
  const back = await pollUntil("B and C are listed again", async () => {
    const peers = await listPeers(R1, A.instance_token);
    return { done: names(peers).join() === "bob,carol", value: names(peers) };
  });
  expect(back).toEqual(["bob", "carol"]);
  await pollUntil("A is active again for C", async () => {
    const peers = await listPeers(U, C.instance_token);
    return { done: names(peers).includes("alice"), value: names(peers) };
  });
  await settleBothReplicas();
  expect([
    "nothing dropped is ever delivered",
    (await poll(R2, B.instance_token)).map((m) => m.text),
    countMessages(U, "text = ?", "sent during a long outage"),
  ]).toEqual(["nothing dropped is ever delivered", [], 0]);
}, 40_000);

test("two replicas naming their agent alike: one is suffixed upstream, both stay reachable by their upstream names", async () => {
  try {
    await setId(R1, A.instance_token, "same");
    await setId(R2, B.instance_token, "same");
    const seen = await pollUntil("C sees same and same-2", async () => {
      const peers = await listPeers(U, C.instance_token);
      return { done: names(peers).join() === "same,same-2", value: names(peers) };
    });
    expect(seen).toEqual(["same", "same-2"]);

    const aliasOf = async (b: TestBroker, token: string): Promise<string | null | undefined> => {
      const rows = await getAuth<PublicPeer[]>(`${b.url}/admin/peers`);
      return rows.find((p) => p.peer_id === "same" && p.via === null)?.upstream_peer_id;
    };
    const aliases = await pollUntil("each replica records the name its peer carries upstream", async () => {
      const value = [await aliasOf(R1, A.instance_token), await aliasOf(R2, B.instance_token)].sort();
      return { done: value.join() === "same,same-2", value };
    });
    expect(["exactly one of the two carries the suffixed alias", aliases]).toEqual([
      "exactly one of the two carries the suffixed alias",
      ["same", "same-2"],
    ]);

    expect(await send(U, C.instance_token, "same", "for the one called same")).toEqual({ ok: true, message_id: expect.any(Number) });
    expect(await send(U, C.instance_token, "same-2", "for the one called same-2")).toEqual({ ok: true, message_id: expect.any(Number) });
    const suffixedIsA = (await aliasOf(R1, A.instance_token)) === "same-2";
    const [forA, forB] = suffixedIsA
      ? ["for the one called same-2", "for the one called same"]
      : ["for the one called same", "for the one called same-2"];
    await receive("A gets the message addressed to its upstream name", R1, A.instance_token, forA);
    await receive("B gets the message addressed to its upstream name", R2, B.instance_token, forB);
  } finally {
    await setId(R1, A.instance_token, "alice");
    await setId(R2, B.instance_token, "bob");
  }
}, 30_000);

test("an upstream without the federation routes: the roadmap still replicates, federation is off, said once", async () => {
  const P3 = startUpstreamProxy(U.url);
  P3.intercept = (path) =>
    path.startsWith("/federation/") ? Response.json({ error: "not found" }, { status: 404 }) : null;
  const R3 = await startReplica(P3);
  try {
    const card = await post<{ item: RoadmapItem }>(`${U.url}/roadmap/upsert`, {
      project_key: PK,
      by: "agent-upstream",
      title: "replicated despite no federation",
    });
    expect(card.status).toBe(200);
    await pollUntil("the card reaches the old-upstream replica", async () => {
      const res = await post<{ items: RoadmapItem[] }>(`${R3.url}/roadmap/list`, { project_key: PK });
      return { done: res.body.items.some((i) => i.id === card.body.item.id), value: res.body.items.length };
    });
    const status = await pollUntil("the status reports federation off", async () => {
      const s = await syncStatus(R3);
      return { done: s.online === true && s.federation?.active === false, value: s };
    });
    expect(["federation is off, replication is on", status.online, status.federation?.active]).toEqual([
      "federation is off, replication is on",
      true,
      false,
    ]);
    const health = await getAuth<{ federation?: string }>(`${R3.url}/health`);
    expect(["/health says the upstream does not federate", health.federation]).toEqual([
      "/health says the upstream does not federate",
      "unsupported",
    ]);
    await waitPasses(R3, 3);
    const lines = readFileSync(join(R3.tmpDir, "logs", "broker.log"), "utf8").split("\n");
    expect([
      "the absence of federation is logged once, then never again",
      lines.filter((l) => l.includes("does not federate")).length,
      lines.filter((l) => /federation/.test(l) && /\b(warn|error)\b/i.test(l)).length,
    ]).toEqual(["the absence of federation is logged once, then never again", 1, 1]);
    expect([
      "the sync route is asked again at every pass, so an upgraded upstream is picked up",
      P3.seen.filter((p) => p === "/federation/sync").length > 1,
    ]).toEqual(["the sync route is asked again at every pass, so an upgraded upstream is picked up", true]);
  } finally {
    P3.stop();
    await stopBroker(R3);
  }
}, 30_000);

test("a transient 404 on the sync route hides the mirrors, refuses new sends, and federation resumes when the route answers again", async () => {
  await pollUntil("alice sees carol through the real upstream", async () => {
    const peers = await listPeers(R1, A.instance_token);
    return { done: peers.some((p) => p.peer_id === "carol"), value: names(peers) };
  });
  let hits = 0;
  P1.intercept = (path) => (path === "/federation/sync" && hits++ < 3 ? Response.json({ error: "not found" }, { status: 404 }) : null);
  try {
    await pollUntil("the replica reports federation inactive", async () => {
      const s = await syncStatus(R1);
      return { done: s.federation?.active === false, value: s.federation };
    });
    const hidden = await listPeers(R1, A.instance_token);
    expect(["remote peers are hidden while the upstream does not federate", names(hidden).includes("carol")]).toEqual([
      "remote peers are hidden while the upstream does not federate",
      false,
    ]);
    const refused = await send(R1, A.instance_token, "carol", "into the void");
    expect([
      "a send to a remote name is refused rather than queued for nobody",
      refused.ok,
      refused.queued,
      /does not federate|not found/.test(refused.error ?? ""),
    ]).toEqual(["a send to a remote name is refused rather than queued for nobody", false, undefined, true]);
    expect(["nothing is left in the queue", countMessages(R1, "text = 'into the void'")]).toEqual([
      "nothing is left in the queue",
      0,
    ]);
  } finally {
    P1.intercept = null;
  }
  await pollUntil("federation resumes once the route answers again", async () => {
    const s = await syncStatus(R1);
    return { done: s.federation?.active === true, value: s.federation };
  });
  await pollUntil("carol is listed again", async () => {
    const peers = await listPeers(R1, A.instance_token);
    return { done: peers.some((p) => p.peer_id === "carol"), value: names(peers) };
  });
}, 30_000);

test("an inbound message reusing an old upstream id after an upstream reset is delivered, not dropped as a duplicate", async () => {
  const relayRef = (token: string) =>
    require("node:crypto").createHash("sha256").update(token).digest("hex").slice(0, 32);
  let upstreamId = "aaaaaaaa-1111-4111-8111-111111111111";
  let text = "first message under id 1";
  P1.intercept = (path) =>
    path !== "/federation/sync"
      ? null
      : Response.json({
          upstream_id: upstreamId,
          assigned: [],
          refused_groups: [],
          peers: [],
          messages: [
            {
              id: 1,
              to_ref: relayRef(A.instance_token),
              from_peer_id: "ghost",
              from_summary: "",
              from_host: "ghost-host",
              from_cwd: "/ghost",
              group_id: G,
              text,
              sent_at: new Date().toISOString(),
            },
          ],
        });
  try {
    await receive("alice receives the first message", R1, A.instance_token, text);
    upstreamId = "bbbbbbbb-2222-4222-8222-222222222222";
    text = "second message under id 1 from a rebuilt upstream";
    await receive("alice receives the second message despite the reused id", R1, A.instance_token, text);
    expect([
      "both messages are stored under distinct upstream-qualified ids",
      countMessages(
        R1,
        "federation_id IN (?, ?)",
        "aaaaaaaa-1111-4111-8111-111111111111:1",
        "bbbbbbbb-2222-4222-8222-222222222222:1"
      ),
    ]).toEqual(["both messages are stored under distinct upstream-qualified ids", 2]);
  } finally {
    P1.intercept = null;
  }
  await pollUntil("the real upstream is back", async () => {
    const s = await syncStatus(R1);
    return { done: s.federation?.active === true, value: s.federation };
  });
}, 30_000);

test("the hub arms no task, and attaches none, toward a peer a replica hosts", async () => {
  const created = await post<SendMessageResponse>(`${U.url}/send-message`, {
    from_token: C.instance_token,
    to_peer_id: "alice",
    text: "track this remote request",
    deadline_sec: 60,
    task_label: "Remote request",
  });
  expect(["a tracked task toward a replica peer is refused", created.body.ok, created.body.error]).toEqual([
    "a tracked task toward a replica peer is refused",
    false,
    "Tracked tasks require two distinct local peers",
  ]);

  const plain = await post<SendMessageResponse>(`${U.url}/send-message`, {
    from_token: C.instance_token,
    to_peer_id: "alice",
    text: "plain request to a replica peer",
    untracked_reply_policy: "warn",
    expects_reply: true,
  });
  expect(["the send is accepted and says tracking is unavailable", plain.body.ok, plain.body.tracking_unavailable]).toEqual([
    "the send is accepted and says tracking is unavailable",
    true,
    "remote_peer",
  ]);
  const attach = await post<{ error?: string }>(`${U.url}/delegations/attach`, {
    from_token: C.instance_token,
    message_id: plain.body.message_id,
    deadline_sec: 60,
  });
  expect(["an attachment toward a replica peer is refused", attach.status]).toEqual([
    "an attachment toward a replica peer is refused",
    400,
  ]);
}, 30_000);

test("a replica's relayed send says tracking is unavailable and offers no message id", async () => {
  const relayed = await post<SendMessageResponse>(`${R1.url}/send-message`, {
    from_token: A.instance_token,
    to_peer_id: "bob",
    text: "relayed request with a policy",
    untracked_reply_policy: "warn",
    expects_reply: true,
  });
  expect(["the relayed send carries the diagnostic and no local id", relayed.body]).toEqual([
    "the relayed send carries the diagnostic and no local id",
    { ok: true, tracking_unavailable: "remote_peer" },
  ]);
  await receive("B receives the relayed request", R2, B.instance_token, "relayed request with a policy");
}, 30_000);

test("the run scope, digest and token of a bound instance never travel in a federation exchange", async () => {
  const group = { id: G, hash: H };
  const onUpstream = await mintRunCredential(U, group, undefined, post);
  const onReplica = await mintRunCredential(R1, group, undefined, post);
  const from = [P1.exchanges.length, P2.exchanges.length] as const;
  const boundOnUpstream = await registerAttestedInstance(U, onUpstream, "host-bound-u", "/work/bound-u", {}, post);
  const boundOnReplica = await registerAttestedInstance(R1, onReplica, "host-bound-r", "/work/bound-r", {}, post);
  try {
    await settleBothReplicas();
    await settleBothReplicas();

    const wire = [...P1.exchanges.slice(from[0]), ...P2.exchanges.slice(from[1])]
      .map((e) => `${e.request}\n${e.response}`)
      .join("\n");
    for (const peer of [boundOnUpstream, boundOnReplica]) {
      expect(wire, "the exchange is not empty: the bound peer travels by name").toContain(peer.body.peer_id);
    }
    const secrets = [
      ...[boundOnUpstream, boundOnReplica].flatMap((p) => {
        const ref = deriveInstanceRef(p.body.instance_token);
        return [p.body.instance_token, ref, ref.slice(-12)];
      }),
      ...[onUpstream, onReplica].flatMap((r) => [r.run, r.tokenId, r.cred.publicKey]),
    ];
    for (const secret of secrets) {
      expect(wire.includes(secret), `a private Inbox value travelled: ${secret.slice(0, 12)}`).toBe(false);
    }
  } finally {
    await post(`${U.url}/unregister`, { instance_token: boundOnUpstream.body.instance_token });
    await post(`${R1.url}/unregister`, { instance_token: boundOnReplica.body.instance_token });
  }
}, 40_000);
