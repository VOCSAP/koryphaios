// Peer federation end to end: one upstream U, two replicas R1 and R2 each
// behind a proxy this file controls, a native peer C on U, A on R1 and B on
// R2. Directory, messaging in every direction, what stays local, the two
// outage shapes (back before the grace, back after it), the queue guard
// against the local mechanic A, the name collision, and an upstream of an
// older version that does not federate.

import { test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  FIXTURE_OPERATOR_ID,
  startBroker,
  stopBroker,
  livePid,
  sha256Hex,
  groupId,
  mintRunCredential,
  mintMandate,
  closeInbox,
  operatorInboxProof,
  registerAttestedInstance,
  runInboxProof,
  type RunCredential,
  type TestBroker,
  openBrokerDb,
} from "./_helper.ts";
import { deriveInstanceRef, INBOX_GATES } from "../shared/approval.ts";
import type { PeerTelemetrySnapshot } from "../shared/peer-telemetry.ts";
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

function startReplica(proxy: UpstreamProxy, extraEnv: Record<string, string> = {}): Promise<TestBroker> {
  return startBroker({
    CLAUDE_PEERS_BROKER_URL: proxy.url,
    CLAUDE_PEERS_BROKER_TOKEN: TOKEN,
    CLAUDE_PEERS_OFFLINE_REPLICA: "1",
    CLAUDE_PEERS_SYNC_TICK_MS: "200",
    CLAUDE_PEERS_FEDERATION_GRACE_SEC: String(GRACE_SEC),
    ...extraEnv,
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

interface TelemetryTile {
  b: TestBroker;
  host: string;
  cwd: string;
  run: RunCredential;
  desk: string;
  launchHash: string;
  token: string;
  beat: ReturnType<typeof setInterval> | null;
}

let tileSeq = 0;

async function launchTile(b: TestBroker, label: string): Promise<TelemetryTile> {
  const n = ++tileSeq;
  const run = await mintRunCredential(b, { id: G, hash: H }, undefined, post);
  const launchHash = await sha256Hex(`${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", ""));
  const host = `h${n}-${label}`;
  const cwd = `/work/${label}`;
  const desk = `desk-${label}-${crypto.randomUUID()}`;
  const reg = await registerAttestedInstance(
    b,
    run,
    host,
    cwd,
    { desk_session: desk, telemetry_capability_hash: launchHash },
    post
  );
  expect([`register tile ${label}`, reg.status]).toEqual([`register tile ${label}`, 200]);
  // Only the upstream sweeps a foreign-host peer without a heartbeat.
  const beat =
    b === U
      ? setInterval(() => {
          void post(`${U.url}/heartbeat`, { instance_token: reg.body.instance_token });
        }, 500)
      : null;
  return { b, host, cwd, run, desk, launchHash, token: reg.body.instance_token, beat };
}

async function dropTile(t: TelemetryTile): Promise<void> {
  if (t.beat) clearInterval(t.beat);
  await post(`${t.b.url}/unregister`, { instance_token: t.token });
}

async function withTiles(
  body: (launch: (b: TestBroker, label: string) => Promise<TelemetryTile>) => Promise<void>
): Promise<void> {
  const launched: TelemetryTile[] = [];
  try {
    await body(async (b, label) => {
      const tile = await launchTile(b, label);
      launched.push(tile);
      return tile;
    });
  } finally {
    for (const tile of launched) await dropTile(tile);
  }
}

function tileTelemetry(t: TelemetryTile, action: "publish" | "stop", snapshot?: PeerTelemetrySnapshot) {
  const payload = {
    run_ref: t.run.run,
    group_id: t.run.group,
    desk_session: t.desk,
    launch_hash: t.launchHash,
    action,
    ...(snapshot ? { snapshot } : {}),
  };
  return post<{ outcome?: string; ok?: boolean }>(`${t.b.url}/tile-telemetry`, {
    ...payload,
    auth: operatorInboxProof(payload, INBOX_GATES.tileTelemetry),
  });
}

async function publishTelemetry(t: TelemetryTile, snapshot: PeerTelemetrySnapshot, label: string): Promise<void> {
  const res = await tileTelemetry(t, "publish", snapshot);
  expect([`${label}: publish`, res.status, res.body]).toEqual([`${label}: publish`, 200, { outcome: "updated" }]);
}

async function resumeTile(t: TelemetryTile): Promise<void> {
  const res = await registerAttestedInstance(
    t.b,
    t.run,
    t.host,
    t.cwd,
    { desk_session: t.desk, telemetry_capability_hash: t.launchHash, resume_instance_token: t.token },
    post
  );
  expect(["a resume gives the same identity back", res.status, res.body.instance_token]).toEqual([
    "a resume gives the same identity back",
    200,
    t.token,
  ]);
}

function viewerToken(viewer: TestBroker): string {
  return viewer === R1 ? A.instance_token : viewer === R2 ? B.instance_token : C.instance_token;
}

async function seenFrom(viewer: TestBroker, tile: TelemetryTile): Promise<PublicPeer | undefined> {
  return (await listPeers(viewer, viewerToken(viewer))).find((p) => p.host === tile.host);
}

async function listedHosts(viewer: TestBroker): Promise<string[]> {
  return (await listPeers(viewer, viewerToken(viewer))).map((p) => p.host);
}

function waitTelemetry(
  viewer: TestBroker,
  tile: TelemetryTile,
  expected: PeerTelemetrySnapshot | undefined,
  what: string
): Promise<PublicPeer> {
  return pollUntil(what, async () => {
    const p = await seenFrom(viewer, tile);
    const done =
      p !== undefined && (expected === undefined ? p.telemetry === undefined : isDeepStrictEqual(p.telemetry, expected));
    return {
      done,
      value: p === undefined ? { listed: false, hosts: await listedHosts(viewer) } : { listed: true, telemetry: p.telemetry },
    };
  }) as Promise<PublicPeer>;
}

async function adminRow(b: TestBroker, tile: TelemetryTile): Promise<PublicPeer | undefined> {
  const rows = await getAuth<PublicPeer[]>(`${b.url}/admin/peers?include_dormant=1`);
  return rows.find((p) => p.host === tile.host);
}

function waitDormantWithoutTelemetry(b: TestBroker, tile: TelemetryTile, what: string): Promise<unknown> {
  return pollUntil(what, async () => {
    const row = await adminRow(b, tile);
    return {
      done: row !== undefined && row.status === "dormant" && row.telemetry === undefined,
      value: row === undefined ? null : { status: row.status, telemetry: row.telemetry },
    };
  });
}

const OBSERVED_FROM = Date.now();

function observation(model: string, over: Partial<PeerTelemetrySnapshot> = {}): PeerTelemetrySnapshot {
  return {
    model,
    modelId: model.toLowerCase().replaceAll(" ", "-"),
    contextPct: 37.5,
    contextWindow: 1_000_000,
    observedAt: OBSERVED_FROM - 600_000,
    ...over,
  };
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
  const depositor = await registerAttestedInstance(R1, run, "host-depositor", "/work/depositor", { desk_session: "tile-depositor" }, post);
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

    const registryRows = (b: TestBroker): Array<{ entry_id: string }> => {
      const db = openBrokerDb(b.dbPath, { readonly: true });
      try {
        return db.query("SELECT entry_id FROM inbox_message_entries WHERE run_ref = ?").all(run.run) as Array<{ entry_id: string }>;
      } finally {
        db.close();
      }
    };
    const entryId = registryRows(R1)[0]!.entry_id;
    const lead = await mintMandate(R1, run, "lead", "lead-federation", { send: post, tile: "tile-depositor" });
    const closeReason = "federation canary reason";
    const closed = await closeInbox(
      R1,
      run,
      lead,
      { entryId, reason: closeReason, instanceToken: depositor.body.instance_token },
      undefined,
      post
    );
    await settleBothReplicas();
    expect(["the close landed", closed.status]).toEqual(["the close landed", 200]);
    // Mutant: the registry or its handles ride a federation body.
    expect([
      "the registry row exists on R1 only",
      [R1, U, R2].map((b) => registryRows(b).length),
    ]).toEqual(["the registry row exists on R1 only", [1, 0, 0]]);
    const wire = [...P1.exchanges, ...P2.exchanges].map((x) => `${x.request}\n${x.response}`).join("\n");
    for (const [what, secret] of [
      ["entry_id", entryId],
      ["reply_token", depositor.body.instance_token],
      ["close_reason", closeReason],
    ] as const) {
      expect([`no federation body carries the ${what}`, wire.includes(secret)]).toEqual([`no federation body carries the ${what}`, false]);
    }
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

test("a tile's telemetry reaches every other broker exact, on one hop and across the upstream, with nulls kept and its age never renewed", async () => {
  await withTiles(async (launch) => {
    const r1 = await launch(R1, "hops-r1");
    const u = await launch(U, "hops-u");
    const r2 = await launch(R2, "hops-r2");
    const seen = {
      r1: observation("Claude Opus 4.6"),
      u: observation("Claude Haiku 4.5", { contextPct: null, contextWindow: null, observedAt: OBSERVED_FROM - 120_000 }),
      r2: observation("Claude Sonnet 4.5", { contextPct: 0, contextWindow: 200_000, observedAt: OBSERVED_FROM - 900_000 }),
    };
    await publishTelemetry(r1, seen.r1, "R1 tile");
    await publishTelemetry(u, seen.u, "U tile");
    await publishTelemetry(r2, seen.r2, "R2 tile");

    const views: Array<[string, TestBroker, TelemetryTile, PeerTelemetrySnapshot]> = [
      ["R1 tile seen on its own broker", R1, r1, seen.r1],
      ["U tile seen on its own broker", U, u, seen.u],
      ["R2 tile seen on its own broker", R2, r2, seen.r2],
      ["R1 -> U", U, r1, seen.r1],
      ["R2 -> U", U, r2, seen.r2],
      ["U -> R1", R1, u, seen.u],
      ["U -> R2", R2, u, seen.u],
      ["R2 -> U -> R1", R1, r2, seen.r2],
      ["R1 -> U -> R2", R2, r1, seen.r1],
    ];
    for (const [hop, viewer, tile, expected] of views) {
      await waitTelemetry(viewer, tile, expected, `${hop}: the observation arrives`);
    }

    await settleBothReplicas();
    for (const [hop, viewer, tile, expected] of views) {
      const p = await seenFrom(viewer, tile);
      expect(p?.telemetry, `${hop}: five fields exact, observedAt as the source observed it, after several passes`).toStrictEqual(expected);
    }

    const newer = { ...seen.r1, contextPct: 61.25, observedAt: seen.r1.observedAt + 30_000 };
    await publishTelemetry(r1, newer, "R1 tile, newer");
    await waitTelemetry(U, r1, newer, "R1 -> U: a newer observation replaces the older");
    await waitTelemetry(R2, r1, newer, "R1 -> U -> R2: a newer observation replaces the older");
  });
}, 60_000);

test("a stop retracts a tile's telemetry on every broker that imported it, a disconnect does too, and the same observation is shown again after a resume", async () => {
  await withTiles(async (launch) => {
    const r1Stopped = await launch(R1, "retract-r1");
    const uStopped = await launch(U, "retract-u");
    const r1Cycled = await launch(R1, "cycle");
    const seen = {
      r1Stopped: observation("Claude Opus 4.6"),
      uStopped: observation("Claude Haiku 4.5", { observedAt: OBSERVED_FROM - 200_000 }),
      r1Cycled: observation("Claude Sonnet 4.5", { contextPct: 12, observedAt: OBSERVED_FROM - 400_000 }),
    };
    await publishTelemetry(r1Stopped, seen.r1Stopped, "R1 tile to stop");
    await publishTelemetry(uStopped, seen.uStopped, "U tile to stop");
    await publishTelemetry(r1Cycled, seen.r1Cycled, "R1 tile to cycle");
    await waitTelemetry(U, r1Stopped, seen.r1Stopped, "R1 -> U before the stop");
    await waitTelemetry(R2, r1Stopped, seen.r1Stopped, "R1 -> U -> R2 before the stop");
    await waitTelemetry(R1, uStopped, seen.uStopped, "U -> R1 before the stop");
    await waitTelemetry(R2, uStopped, seen.uStopped, "U -> R2 before the stop");
    await waitTelemetry(U, r1Cycled, seen.r1Cycled, "R1 -> U before the disconnect");
    await waitTelemetry(R2, r1Cycled, seen.r1Cycled, "R1 -> U -> R2 before the disconnect");

    expect(["a stop is accepted on R1", (await tileTelemetry(r1Stopped, "stop")).body]).toEqual(["a stop is accepted on R1", { ok: true }]);
    expect(["a stop is accepted on U", (await tileTelemetry(uStopped, "stop")).body]).toEqual(["a stop is accepted on U", { ok: true }]);
    await waitTelemetry(U, r1Stopped, undefined, "R1 stop retracted on U, the peer still listed");
    await waitTelemetry(R2, r1Stopped, undefined, "R1 stop retracted on R2, the peer still listed");
    await waitTelemetry(R1, uStopped, undefined, "U stop retracted on R1, the peer still listed");
    await waitTelemetry(R2, uStopped, undefined, "U stop retracted on R2, the peer still listed");
    await settleBothReplicas();
    for (const [where, viewer, tile] of [
      ["U", U, r1Stopped],
      ["R2", R2, r1Stopped],
      ["R1", R1, uStopped],
      ["R2", R2, uStopped],
    ] as const) {
      const p = await seenFrom(viewer, tile);
      expect([`a retracted observation does not come back on ${where}`, p !== undefined, p?.telemetry]).toEqual([
        `a retracted observation does not come back on ${where}`,
        true,
        undefined,
      ]);
    }
    expect(
      (await seenFrom(R2, r1Cycled))?.telemetry,
      "the stop of one tile leaves the observation of its sibling in place"
    ).toStrictEqual(seen.r1Cycled);

    await post(`${R1.url}/disconnect`, { instance_token: r1Cycled.token });
    await waitDormantWithoutTelemetry(U, r1Cycled, "U holds the disconnected tile dormant, without its observation");
    await waitDormantWithoutTelemetry(R2, r1Cycled, "R2 holds the disconnected tile dormant, without its observation");

    await resumeTile(r1Cycled);
    for (const viewer of [U, R2]) {
      const back = await pollUntil("the resumed tile is listed again", async () => {
        const p = await seenFrom(viewer, r1Cycled);
        return { done: p !== undefined, value: p?.telemetry };
      });
      expect(back, "a resumed tile starts without the observation it had before the disconnect").toBeUndefined();
    }
    await publishTelemetry(r1Cycled, seen.r1Cycled, "R1 tile after its resume, same observation");
    await waitTelemetry(U, r1Cycled, seen.r1Cycled, "R1 -> U: the same observation is shown again");
    await waitTelemetry(R2, r1Cycled, seen.r1Cycled, "R1 -> U -> R2: the same observation is shown again");
  });
}, 90_000);

test("an outage keeps the last observation with its real age through the grace, drops it after, and the return shows the live source", async () => {
  try {
    await outageWithTiles();
  } finally {
    P1.blocked = false;
  }
}, 90_000);

async function outageWithTiles(): Promise<void> {
  await withTiles(async (launch) => {
    const upstreamTile = await launch(U, "outage-u");
    const retractedTile = await launch(U, "gone");
    const replicaTile = await launch(R1, "outage-r1");
    const seen = {
      upstreamTile: observation("Claude Opus 4.6", { observedAt: OBSERVED_FROM - 300_000 }),
      retractedTile: observation("Claude Haiku 4.5", { observedAt: OBSERVED_FROM - 310_000 }),
      replicaTile: observation("Claude Sonnet 4.5", { observedAt: OBSERVED_FROM - 320_000 }),
    };
    await publishTelemetry(upstreamTile, seen.upstreamTile, "U tile");
    await publishTelemetry(retractedTile, seen.retractedTile, "U tile to retract");
    await publishTelemetry(replicaTile, seen.replicaTile, "R1 tile");
    await waitTelemetry(R1, upstreamTile, seen.upstreamTile, "U -> R1 before the outage");
    await waitTelemetry(R1, retractedTile, seen.retractedTile, "U -> R1 before the outage, tile to retract");
    await waitTelemetry(U, replicaTile, seen.replicaTile, "R1 -> U before the outage");

    await goOffline(P1, R1);
    const inGrace = await seenFrom(R1, upstreamTile);
    expect([
      "within the grace the mirror keeps the last observation with the age its source gave it",
      typeof inGrace?.link_down_since,
      inGrace?.telemetry,
    ]).toStrictEqual(["within the grace the mirror keeps the last observation with the age its source gave it", "string", seen.upstreamTile]);

    await waitDormantWithoutTelemetry(U, replicaTile, "U keeps no observation for a replica tile that went silent");
    await pollUntil("beyond the grace the mirrors vanish from A's list", async () => {
      const peers = (await listPeers(R1, A.instance_token)).filter((p) => p.via !== null);
      return { done: peers.length === 0, value: names(peers) };
    });
    for (const tile of [upstreamTile, retractedTile]) {
      const row = await adminRow(R1, tile);
      expect([
        "beyond the grace the replica keeps no observation of a mirror",
        row?.status,
        row?.telemetry,
      ]).toEqual(["beyond the grace the replica keeps no observation of a mirror", "dormant", undefined]);
    }

    await post(`${U.url}/disconnect`, { instance_token: upstreamTile.token });
    await resumeTile(upstreamTile);
    const older = { ...seen.upstreamTile, model: "Claude Opus 4.1", modelId: "claude-opus-4.1", observedAt: OBSERVED_FROM - 900_000 };
    await publishTelemetry(upstreamTile, older, "U tile, an older observation after its resume");
    expect(["U retracts a tile during the outage", (await tileTelemetry(retractedTile, "stop")).body]).toEqual([
      "U retracts a tile during the outage",
      { ok: true },
    ]);

    await goOnline(P1, R1);
    await waitTelemetry(R1, upstreamTile, older, "the return shows what the live source now holds, not what the replica remembered");
    await waitTelemetry(R1, retractedTile, undefined, "the return shows no observation for a tile the source retracted");
    await waitTelemetry(U, replicaTile, seen.replicaTile, "the replica tile is back on U with the age it was observed at");
    await settleBothReplicas();
    expect(
      (await seenFrom(R1, upstreamTile))?.telemetry,
      "the live observation holds after several passes"
    ).toStrictEqual(older);
  });
}

test("an upstream answering under another identity drops what the replica imported, and the return rehydrates from the live source", async () => {
  await withTiles(async (launch) => {
    const tile = await launch(U, "reset-u");
    const before = observation("Claude Opus 4.6", { observedAt: OBSERVED_FROM - 300_000 });
    await publishTelemetry(tile, before, "U tile");
    await waitTelemetry(R1, tile, before, "U -> R1 before the reset");

    P1.intercept = (path) =>
      path === "/federation/sync"
        ? Response.json({
            upstream_id: "dddddddd-4444-4444-8444-444444444444",
            assigned: [],
            refused_groups: [],
            peers: [],
            messages: [],
          })
        : null;
    const older = observation("Claude Opus 4.1", { observedAt: OBSERVED_FROM - 900_000 });
    try {
      await waitDormantWithoutTelemetry(R1, tile, "R1 shows no observation of a mirror under a new upstream identity");
      await post(`${U.url}/disconnect`, { instance_token: tile.token });
      await resumeTile(tile);
      await publishTelemetry(tile, older, "U tile, an older observation after its resume");
    } finally {
      P1.intercept = null;
    }
    await pollUntil("the real upstream is back", async () => {
      const s = await syncStatus(R1);
      return { done: s.federation?.active === true, value: s.federation };
    });
    await waitTelemetry(R1, tile, older, "the return shows what the live source now holds, not what the replica remembered");
  });
}, 60_000);

function rowTokens(b: TestBroker, host: string): string[] {
  const db = openBrokerDb(b.dbPath, { readonly: true });
  try {
    return (db.query("SELECT instance_token FROM peers WHERE host = ?").all(host) as { instance_token: string }[]).map(
      (r) => r.instance_token
    );
  } finally {
    db.close();
  }
}

test("the run scope, digest, token and launch identity of a bound instance never travel in a federation exchange, telemetry included", async () => {
  const group = { id: G, hash: H };
  const onUpstream = await mintRunCredential(U, group, undefined, post);
  const onReplica = await mintRunCredential(R1, group, undefined, post);
  const from = [P1.exchanges.length, P2.exchanges.length] as const;
  const boundOnUpstream = await registerAttestedInstance(U, onUpstream, "host-bound-u", "/work/bound-u", {}, post);
  const boundOnReplica = await registerAttestedInstance(R1, onReplica, "host-bound-r", "/work/bound-r", {}, post);
  try {
    await withTiles(async (launch) => {
      const tiles = {
        r1: await launch(R1, "wire-r1"),
        u: await launch(U, "wire-u"),
        r2: await launch(R2, "wire-r2"),
      };
      const marked = (key: keyof typeof tiles) => observation(`Wire Probe ${key}`, { observedAt: OBSERVED_FROM - 60_000 });
      for (const key of ["r1", "u", "r2"] as const) await publishTelemetry(tiles[key], marked(key), `${key} tile`);
      await waitTelemetry(R2, tiles.r1, marked("r1"), "R1 -> U -> R2");
      await waitTelemetry(R1, tiles.r2, marked("r2"), "R2 -> U -> R1");
      await waitTelemetry(R1, tiles.u, marked("u"), "U -> R1");
      await waitTelemetry(R2, tiles.u, marked("u"), "U -> R2");
      await settleBothReplicas();
      await settleBothReplicas();

      const slice = (proxy: UpstreamProxy, start: number) => proxy.exchanges.slice(start);
      const requests = (xs: UpstreamProxy["exchanges"]) => xs.map((e) => e.request).join("\n");
      const responses = (xs: UpstreamProxy["exchanges"]) => xs.map((e) => e.response).join("\n");
      const p1 = slice(P1, from[0]);
      const p2 = slice(P2, from[1]);
      const wire = [...p1, ...p2].map((e) => `${e.request}\n${e.response}`).join("\n");
      for (const peer of [boundOnUpstream, boundOnReplica]) {
        expect(wire, "the exchange is not empty: the bound peer travels by name").toContain(peer.body.peer_id);
      }
      for (const [what, body, key] of [
        ["R1 exports its tile's telemetry to U", requests(p1), "r1"],
        ["U hands R1's tile to R2: the second hop of the chain", responses(p2), "r1"],
        ["R2 exports its tile's telemetry to U", requests(p2), "r2"],
        ["U hands R2's tile to R1: the second hop of the chain", responses(p1), "r2"],
        ["U hands its own tile to R1", responses(p1), "u"],
        ["U hands its own tile to R2", responses(p2), "u"],
      ] as const) {
        expect(body, `${what}: telemetry rides this body, so the confidentiality scan below reads it`).toContain(
          marked(key).modelId
        );
      }

      const secrets: Array<[string, string]> = [
        ...[boundOnUpstream, boundOnReplica].flatMap((p): Array<[string, string]> => {
          const ref = deriveInstanceRef(p.body.instance_token);
          return [
            ["bound instance token", p.body.instance_token],
            ["bound instance ref", ref],
            ["bound instance ref tail", ref.slice(-12)],
          ];
        }),
        ...[onUpstream, onReplica].flatMap((r): Array<[string, string]> => [
          ["bound run_ref", r.run],
          ["bound run token id", r.tokenId],
          ["bound run public key", r.cred.publicKey],
        ]),
        ["operator id", FIXTURE_OPERATOR_ID],
      ];
      for (const [key, tile] of Object.entries(tiles)) {
        for (const b of [U, R1, R2]) {
          for (const token of rowTokens(b, tile.host)) {
            secrets.push([`${key} tile row token held by ${b === U ? "U" : b === R1 ? "R1" : "R2"}`, token]);
            const ref = deriveInstanceRef(token);
            secrets.push([`${key} tile instance ref`, ref], [`${key} tile instance ref tail`, ref.slice(-12)]);
          }
        }
        secrets.push(
          [`${key} tile run_ref`, tile.run.run],
          [`${key} tile run token id`, tile.run.tokenId],
          [`${key} tile run public key`, tile.run.cred.publicKey],
          [`${key} tile launch hash`, tile.launchHash],
          [`${key} tile desk session`, tile.desk],
          [`${key} tile desk session hash`, createHash("sha256").update(tile.desk).digest("hex")]
        );
      }
      for (const [what, secret] of secrets) {
        expect(wire.includes(secret), `a private value travelled in a federation request or response: ${what}`).toBe(false);
      }
    });
  } finally {
    await post(`${U.url}/unregister`, { instance_token: boundOnUpstream.body.instance_token });
    await post(`${R1.url}/unregister`, { instance_token: boundOnReplica.body.instance_token });
  }
}, 60_000);

function backdateMirror(b: TestBroker, host: string): number {
  const db = openBrokerDb(b.dbPath);
  try {
    return db.run("UPDATE peers SET last_seen = ? WHERE host = ? AND via IS NOT NULL AND relay_id IS NULL", [
      new Date(Date.now() - 3_600_000).toISOString(),
      host,
    ]).changes;
  } finally {
    db.close();
  }
}

function mirrorLastSeen(b: TestBroker, host: string): string | undefined {
  const db = openBrokerDb(b.dbPath, { readonly: true });
  try {
    const row = db.query("SELECT last_seen FROM peers WHERE host = ? AND via IS NOT NULL AND relay_id IS NULL").get(host) as
      | { last_seen: string }
      | null;
    return row?.last_seen;
  } finally {
    db.close();
  }
}

async function waitMirrorRestamps(b: TestBroker, host: string, n: number): Promise<void> {
  let last = mirrorLastSeen(b, host);
  let changes = 0;
  await pollUntil(`${n} failed passes restamp the mirror`, async () => {
    const now = mirrorLastSeen(b, host);
    if (now !== last) {
      last = now;
      changes += 1;
    }
    return { done: changes >= n, value: changes };
  });
}

test("a mirror the link stopped refreshing goes dormant on the replica and stops showing its observation", async () => {
  // The mirror cutoff cannot go under 120 s by env, so the row is aged by hand
  // and the 1 s sweep does the rest. Every pass, failed ones inside the grace
  // included, restamps last_seen: the link is cut with a long grace, and the
  // row is aged right after a restamp, when the next failed pass (backoff
  // doubling from 0.8 s) is farther than one sweep tick.
  const P3 = startUpstreamProxy(U.url);
  let R3: TestBroker | null = null;
  let r3Token: string | null = null;
  try {
    R3 = await startReplica(P3, {
      CLAUDE_PEERS_DORMANT_SWEEP_SEC: "1",
      CLAUDE_PEERS_FEDERATION_GRACE_SEC: "600",
    });
    r3Token = (await register(R3, "host-r3", "/work/r3")).instance_token;
    const replica = R3;
    await withTiles(async (launch) => {
      const tile = await launch(R2, "stale-mirror");
      const seen = observation("Claude Opus 4.6", { observedAt: OBSERVED_FROM - 300_000 });
      await publishTelemetry(tile, seen, "R2 tile");
      const before = await pollUntil("R2 -> U -> R3 before the link is cut", async () => {
        const row = await adminRow(replica, tile);
        return {
          done: row?.status === "active" && isDeepStrictEqual(row.telemetry, seen),
          value: row === undefined ? null : { status: row.status, telemetry: row.telemetry },
        };
      });
      expect(["the mirror is active and shows its observation before it ages", before]).toEqual([
        "the mirror is active and shows its observation before it ages",
        { status: "active", telemetry: seen },
      ]);

      await goOffline(P3, replica);
      await waitMirrorRestamps(replica, tile.host, 3);
      expect(["one mirror row is aged", backdateMirror(replica, tile.host)]).toEqual(["one mirror row is aged", 1]);
      await waitDormantWithoutTelemetry(replica, tile, "R3 sweeps the aged mirror: dormant, no observation");
    });
  } finally {
    try {
      if (R3 !== null && r3Token !== null) {
        await goOnline(P3, R3);
        await post(`${R3.url}/unregister`, { instance_token: r3Token });
        await pollUntil("U drops the host-r3 peer R3 relayed", async () => {
          const rows = (await getAuth<PublicPeer[]>(`${U.url}/admin/peers?include_dormant=1`)).filter(
            (p) => p.host === "host-r3" && p.status === "active"
          );
          return { done: rows.length === 0, value: rows.map((p) => p.peer_id) };
        });
      }
    } finally {
      if (R3 !== null) await stopBroker(R3);
      P3.stop();
    }
  }
}, 60_000);
