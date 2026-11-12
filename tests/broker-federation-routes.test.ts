// The upstream half of peer federation, exercised against a single broker with
// raw POSTs playing the replica: the three role guards, the shape refusals,
// the relayed row as a native peer sees it (and what it must never carry), the
// name assignment and its stickiness, liveness, the ack contract, the
// mechanic-A exemption, the send relay, and the per-group TOFU.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import {
  startBroker as startPlainBroker,
  stopBroker,
  livePid,
  sha256Hex,
  groupId,
  type TestBroker,
  openBrokerDb,
  mintRunCredential,
  registerAttestedInstance,
  operatorInboxProof,
} from "./_helper.ts";
import { INBOX_GATES } from "../shared/approval.ts";
import type { PeerTelemetrySnapshot } from "../shared/peer-telemetry.ts";
import { startUpstreamProxy, type UpstreamProxy } from "./_upstream-proxy.ts";
import type {
  FederationRelayPeer,
  FederationSyncRequest,
  FederationSyncResponse,
  PublicPeer,
  RegisterResponse,
  SendMessageResponse,
} from "../shared/types.ts";

const TOKEN = "federation-routes-token";
/** Distinct first-8 prefixes: `via` is the first 8 chars of the replica_id. */
const REPLICA = "alpha-replica-01";
const OTHER_REPLICA = "bravo-replica-01";

function startUpstream(env: Record<string, string> = {}): Promise<TestBroker> {
  return startPlainBroker({
    CLAUDE_PEERS_BROKER_TOKEN: TOKEN,
    CLAUDE_PEERS_SERVE_REPLICAS: "1",
    ...env,
  });
}

async function postAuth<T = unknown>(
  url: string,
  body: unknown,
  token: string | null = TOKEN
): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as T };
}

async function getAuth<T = unknown>(url: string): Promise<{ status: number; body: T }> {
  const res = await fetch(url, { headers: { authorization: `Bearer ${TOKEN}` } });
  return { status: res.status, body: (await res.json()) as T };
}

/** What a replica presents for one of its peers: sha256 of its token, 32 hex chars. */
function ref(seed: string): string {
  return createHash("sha256").update(seed).digest("hex").slice(0, 32);
}

function relayPeer(overrides: Partial<FederationRelayPeer> & { relay_ref: string; peer_id: string }): FederationRelayPeer {
  return {
    group_id: "default",
    host: "far-laptop",
    cwd: "/work/far",
    git_root: null,
    project_key: null,
    summary: "",
    role: null,
    last_activity_at: null,
    ...overrides,
  };
}

function syncBody(overrides: Partial<FederationSyncRequest> = {}): FederationSyncRequest {
  return {
    replica_id: REPLICA,
    groups: [{ group_id: "default", group_secret_hash: null }],
    peers: [],
    ack: [],
    ...overrides,
  };
}

type SyncRes = FederationSyncResponse & { error?: string };
type SendRes = SendMessageResponse & { error?: string };

function sync(b: TestBroker, body: FederationSyncRequest) {
  return postAuth<SyncRes>(`${b.url}/federation/sync`, body);
}

async function register(
  b: TestBroker,
  host: string,
  cwd: string,
  group: { id: string; hash: string | null } = { id: "default", hash: null }
): Promise<RegisterResponse> {
  const res = await postAuth<RegisterResponse & { error?: string }>(`${b.url}/register`, {
    pid: livePid(),
    cwd,
    git_root: null,
    tty: null,
    summary: "",
    host,
    client_pid: livePid(),
    project_key: null,
    group_id: group.id,
    group_secret_hash: group.hash,
  });
  expect([`register ${host}`, res.status]).toEqual([`register ${host}`, 200]);
  return res.body;
}

async function listPeers(b: TestBroker, token: string): Promise<PublicPeer[]> {
  const res = await postAuth<PublicPeer[]>(`${b.url}/list-peers`, {
    instance_token: token,
    scope: "machine",
    cwd: "",
    git_root: null,
  });
  return res.body;
}

async function adminPeers(b: TestBroker): Promise<Record<string, unknown>[]> {
  return (await getAuth<Record<string, unknown>[]>(`${b.url}/admin/peers?include_dormant=1`)).body;
}

function messageRow(b: TestBroker, id: number): { delivered: number } | null {
  const db = openBrokerDb(b.dbPath, { readonly: true });
  try {
    return db.query("SELECT delivered FROM messages WHERE id = ?").get(id) as { delivered: number } | null;
  } finally {
    db.close();
  }
}

/** The id of the one undelivered message a native peer just sent (poll-free read). */
function lastMessageId(b: TestBroker): number {
  const db = openBrokerDb(b.dbPath, { readonly: true });
  try {
    return (db.query("SELECT MAX(id) AS id FROM messages").get() as { id: number }).id;
  } finally {
    db.close();
  }
}

let upstream: TestBroker;

beforeAll(async () => {
  upstream = await startUpstream();
});

afterAll(async () => {
  await stopBroker(upstream);
});

test("the two federation routes are refused by role, by credential, and on a replica -- in that order", async () => {
  const roleless = await startPlainBroker({ CLAUDE_PEERS_BROKER_TOKEN: TOKEN });
  const tokenless = await startPlainBroker({ CLAUDE_PEERS_SERVE_REPLICAS: "1" });
  const replica = await startPlainBroker({
    CLAUDE_PEERS_BROKER_URL: "http://127.0.0.1:9",
    CLAUDE_PEERS_BROKER_TOKEN: TOKEN,
    CLAUDE_PEERS_OFFLINE_REPLICA: "1",
    CLAUDE_PEERS_SERVE_REPLICAS: "1",
  });
  try {
    const bodies: [string, unknown][] = [
      ["/federation/sync", syncBody()],
      ["/federation/send", { replica_id: REPLICA, from_ref: ref("x"), to_peer_id: "someone", text: "hi" }],
    ];
    for (const [route, body] of bodies) {
      const noRole = await postAuth<{ error?: string }>(`${roleless.url}${route}`, body);
      expect([`${route} without serve_replicas is refused`, noRole.status]).toEqual([
        `${route} without serve_replicas is refused`,
        403,
      ]);
      expect([
        `${route}: the refusal names serve_replicas so the operator can act on it`,
        (noRole.body.error ?? "").includes("serve_replicas"),
      ]).toEqual([`${route}: the refusal names serve_replicas so the operator can act on it`, true]);

      const noToken = await postAuth<{ error?: string }>(`${tokenless.url}${route}`, body, null);
      expect([`${route} without a broker_token is refused`, noToken.status]).toEqual([
        `${route} without a broker_token is refused`,
        403,
      ]);
      expect([
        `${route}: the refusal names broker_token`,
        (noToken.body.error ?? "").includes("broker_token"),
      ]).toEqual([`${route}: the refusal names broker_token`, true]);

      const onReplica = await postAuth<{ error?: string }>(`${replica.url}${route}`, body);
      expect([`${route} on a replica is refused: no chaining`, onReplica.status]).toEqual([
        `${route} on a replica is refused: no chaining`,
        403,
      ]);
      expect([
        `${route}: the mode refusal comes first and names the replica, not the role`,
        (onReplica.body.error ?? "").includes("replica"),
        (onReplica.body.error ?? "").includes("serve_replicas"),
      ]).toEqual([`${route}: the mode refusal comes first and names the replica, not the role`, true, false]);
    }
  } finally {
    await stopBroker(roleless);
    await stopBroker(tokenless);
    await stopBroker(replica);
  }
}, 30_000);

test("sync refuses a malformed replica_id, a malformed relay_ref and more than 200 peers", async () => {
  const badId = await sync(upstream, syncBody({ replica_id: "x" }));
  expect(["replica_id shape is validated", badId.status]).toEqual(["replica_id shape is validated", 400]);

  const badRef = await sync(upstream, syncBody({ peers: [relayPeer({ relay_ref: "not-hex", peer_id: "fine" })] }));
  expect(["relay_ref must be 32 hex chars", badRef.status]).toEqual(["relay_ref must be 32 hex chars", 400]);

  const tooMany = await sync(
    upstream,
    syncBody({
      peers: Array.from({ length: 201 }, (_, i) => relayPeer({ relay_ref: ref(`many-${i}`), peer_id: `many-${i}` })),
    })
  );
  expect(["a pass carries at most 200 peers", tooMany.status]).toEqual(["a pass carries at most 200 peers", 400]);
});

test("a relayed row is listed by a native peer with its via label and none of the retained columns", async () => {
  const native = await register(upstream, "native-host", "/native/list");
  const res = await sync(upstream, syncBody({ peers: [relayPeer({ relay_ref: ref("listed"), peer_id: "listed-peer" })] }));
  expect(["sync is served", res.status]).toEqual(["sync is served", 200]);
  expect(["the replica learns the name its peer carries here", res.body.assigned]).toEqual([
    "the replica learns the name its peer carries here",
    [{ relay_ref: ref("listed"), peer_id: "listed-peer" }],
  ]);

  const raw = (await postAuth<Record<string, unknown>[]>(`${upstream.url}/list-peers`, {
    instance_token: native.instance_token,
    scope: "machine",
    cwd: "",
    git_root: null,
  })).body;
  const relayed = raw.find((p) => p.peer_id === "listed-peer");
  expect(["a native peer sees the relayed row", relayed?.host, relayed?.via]).toEqual([
    "a native peer sees the relayed row",
    "far-laptop",
    REPLICA.slice(0, 8),
  ]);
  for (const retained of ["instance_token", "pid", "client_pid", "claude_cli_pid", "relay_id", "relay_ref"]) {
    expect([`${retained} never crosses the HTTP boundary`, retained in relayed!]).toEqual([
      `${retained} never crosses the HTTP boundary`,
      false,
    ]);
  }

  // The relayed row is not a client of this broker: nobody may act as it.
  const asRelayed = await postAuth<PublicPeer[]>(`${upstream.url}/list-peers`, {
    instance_token: ref("listed"),
    scope: "machine",
    cwd: "",
    git_root: null,
  });
  expect(["a relay_ref is not an instance_token", asRelayed.body]).toEqual(["a relay_ref is not an instance_token", []]);
});

test("toPublicPeer is a pick-list: every live column of peers is either published or explicitly retained", async () => {
  // The projection is read off the wire, the schema off the file: a column
  // added to peers that is in neither list below fails here, and a retained
  // column that shows up on the wire fails here too.
  const RETAINED = ["instance_token", "pid", "pid_generation", "client_pid", "claude_cli_pid", "relay_id", "relay_ref", "relay_base"];
  const COMPUTED = ["activity_status", "link_down_since", "telemetry"];
  const rows = await adminPeers(upstream);
  expect(["the admin dump has at least one row to read the projection from", rows.length > 0]).toEqual([
    "the admin dump has at least one row to read the projection from",
    true,
  ]);
  const published = new Set(rows.flatMap((r) => Object.keys(r)));
  const db = openBrokerDb(upstream.dbPath, { readonly: true });
  const columns = (db.query("PRAGMA table_info(peers)").all() as { name: string }[]).map((c) => c.name);
  db.close();
  for (const column of columns) {
    expect([
      `peers.${column} is decided: published by toPublicPeer or listed as retained`,
      published.has(column) || RETAINED.includes(column),
    ]).toEqual([`peers.${column} is decided: published by toPublicPeer or listed as retained`, true]);
  }
  for (const retained of RETAINED) {
    expect([`${retained} is retained, never published`, published.has(retained)]).toEqual([
      `${retained} is retained, never published`,
      false,
    ]);
  }
  for (const key of published) {
    expect([`published key ${key} is a peers column or a computed field`, columns.includes(key) || COMPUTED.includes(key)]).toEqual([
      `published key ${key} is a peers column or a computed field`,
      true,
    ]);
  }
});

test("a reserved or taken name is suffixed, the assignment is sticky, and a new free name is followed", async () => {
  const native = await register(upstream, "namer-host", "/namer");
  const renamed = await postAuth<{ peer_id: string }>(`${upstream.url}/set-id`, {
    instance_token: native.instance_token,
    new_peer_id: "wanted-name",
  });
  expect(renamed.status).toBe(200);

  const first = await sync(
    upstream,
    syncBody({
      peers: [
        relayPeer({ relay_ref: ref("wants-deck"), peer_id: "deck" }),
        relayPeer({ relay_ref: ref("wants-taken"), peer_id: "wanted-name" }),
      ],
    })
  );
  const assigned = (res: SyncRes, r: string) => res.assigned.find((a) => a.relay_ref === r)?.peer_id;
  expect(["a reserved name is suffixed, never granted", assigned(first.body, ref("wants-deck"))]).toEqual([
    "a reserved name is suffixed, never granted",
    "deck-2",
  ]);
  expect(["a name held by a native peer is suffixed", assigned(first.body, ref("wants-taken"))]).toEqual([
    "a name held by a native peer is suffixed",
    "wanted-name-2",
  ]);

  // The native peer lets the name go; the relayed row keeps the one it was
  // given as long as the replica proposes the same base.
  await postAuth(`${upstream.url}/set-id`, { instance_token: native.instance_token, new_peer_id: "moved-on" });
  const second = await sync(
    upstream,
    syncBody({ peers: [relayPeer({ relay_ref: ref("wants-taken"), peer_id: "wanted-name" })] })
  );
  expect(["the assignment is sticky while the same base is proposed", assigned(second.body, ref("wants-taken"))]).toEqual([
    "the assignment is sticky while the same base is proposed",
    "wanted-name-2",
  ]);

  // A local set_id proposes a NEW base: followed when free.
  const third = await sync(
    upstream,
    syncBody({ peers: [relayPeer({ relay_ref: ref("wants-taken"), peer_id: "fresh-name" })] })
  );
  expect(["a new free name renames the relayed row", assigned(third.body, ref("wants-taken"))]).toEqual([
    "a new free name renames the relayed row",
    "fresh-name",
  ]);
  const rows = await adminPeers(upstream);
  expect([
    "the row was renamed, not duplicated",
    rows.filter((r) => r.peer_id === "fresh-name").length,
    rows.some((r) => r.peer_id === "wanted-name-2"),
  ]).toEqual(["the row was renamed, not duplicated", 1, false]);
});

test("a relayed row absent from a pass goes dormant at once; one present has its last_seen refreshed", async () => {
  const both = await sync(
    upstream,
    syncBody({
      peers: [
        relayPeer({ relay_ref: ref("stays"), peer_id: "stays" }),
        relayPeer({ relay_ref: ref("leaves"), peer_id: "leaves" }),
      ],
    })
  );
  expect(both.status).toBe(200);
  const before = (await adminPeers(upstream)).find((r) => r.peer_id === "stays")!.last_seen as string;
  await Bun.sleep(20);
  const one = await sync(upstream, syncBody({ peers: [relayPeer({ relay_ref: ref("stays"), peer_id: "stays" })] }));
  expect(one.status).toBe(200);
  const rows = await adminPeers(upstream);
  expect([
    "absent from the body means dormant immediately",
    rows.find((r) => r.peer_id === "leaves")?.status,
    rows.find((r) => r.peer_id === "stays")?.status,
  ]).toEqual(["absent from the body means dormant immediately", "dormant", "active"]);
  expect([
    "each pass a row appears in refreshes its last_seen",
    (rows.find((r) => r.peer_id === "stays")!.last_seen as string) > before,
  ]).toEqual(["each pass a row appears in refreshes its last_seen", true]);

  // Another replica cannot make this replica's rows dormant.
  const other = await sync(upstream, syncBody({ replica_id: OTHER_REPLICA, peers: [] }));
  expect(other.status).toBe(200);
  expect([
    "a pass by another replica leaves this replica's rows alone",
    (await adminPeers(upstream)).find((r) => r.peer_id === "stays")?.status,
  ]).toEqual(["a pass by another replica leaves this replica's rows alone", "active"]);
});

test("cleanStalePeers never PID-probes a relayed row, even one carrying the broker's own hostname", async () => {
  const b = await startUpstream({ CLAUDE_PEERS_CLEAN_INTERVAL_SEC: "1" });
  try {
    const res = await sync(
      b,
      syncBody({ peers: [relayPeer({ relay_ref: ref("homonym"), peer_id: "homonym", host: hostname() })] })
    );
    expect(res.status).toBe(200);
    await Bun.sleep(2_500);
    const row = (await adminPeers(b)).find((r) => r.peer_id === "homonym");
    expect(["a relayed row with pid 0 and the broker's hostname survives the clean tick", row?.status]).toEqual([
      "a relayed row with pid 0 and the broker's hostname survives the clean tick",
      "active",
    ]);
  } finally {
    await stopBroker(b);
  }
}, 15_000);

test("a message to a relayed peer waits for its ack: not marked by a sync without it, nor by another peer's id", async () => {
  const native = await register(upstream, "acker-host", "/acker");
  const bystander = await register(upstream, "bystander-host", "/bystander");
  const relayed = relayPeer({ relay_ref: ref("acked"), peer_id: "acked-peer" });
  expect((await sync(upstream, syncBody({ peers: [relayed] }))).status).toBe(200);

  const sent = await postAuth<SendMessageResponse>(`${upstream.url}/send-message`, {
    from_token: native.instance_token,
    to_peer_id: "acked-peer",
    text: "for the far side",
  });
  expect(["a native peer messages a relayed row like any other", sent.body.ok]).toEqual([
    "a native peer messages a relayed row like any other",
    true,
  ]);
  const toRelayed = lastMessageId(upstream);
  const toBystander = await postAuth<SendMessageResponse>(`${upstream.url}/send-message`, {
    from_token: native.instance_token,
    to_peer_id: bystander.peer_id,
    text: "for the neighbour",
  });
  expect(toBystander.body.ok).toBe(true);
  const bystanderId = lastMessageId(upstream);

  const pulled = await sync(upstream, syncBody({ peers: [relayed] }));
  const carried = pulled.body.messages.find((m) => m.id === toRelayed);
  expect([
    "the undelivered message rides the sync response, addressed by relay_ref",
    carried?.to_ref,
    carried?.from_peer_id,
    carried?.text,
  ]).toEqual([
    "the undelivered message rides the sync response, addressed by relay_ref",
    ref("acked"),
    native.peer_id,
    "for the far side",
  ]);
  expect([
    "a message to a native peer never rides a replica's sync",
    pulled.body.messages.some((m) => m.id === bystanderId),
  ]).toEqual(["a message to a native peer never rides a replica's sync", false]);
  const wire = JSON.stringify(pulled.body);
  for (const secret of ["instance_token", "from_token", "to_token", "\"pid\"", "client_pid", "relay_ref\":\"" + native.instance_token]) {
    expect([`the sync response never carries ${secret}`, wire.includes(secret)]).toEqual([
      `the sync response never carries ${secret}`,
      false,
    ]);
  }
  expect(["a sync without ack leaves the message undelivered", messageRow(upstream, toRelayed)?.delivered]).toEqual([
    "a sync without ack leaves the message undelivered",
    0,
  ]);

  const wrongAck = await sync(upstream, syncBody({ peers: [relayed], ack: [bystanderId] }));
  expect(wrongAck.status).toBe(200);
  expect([
    "an ack naming a message addressed to another peer marks nothing",
    messageRow(upstream, bystanderId)?.delivered,
    messageRow(upstream, toRelayed)?.delivered,
  ]).toEqual(["an ack naming a message addressed to another peer marks nothing", 0, 0]);

  const otherAck = await sync(upstream, syncBody({ replica_id: OTHER_REPLICA, ack: [toRelayed] }));
  expect(otherAck.status).toBe(200);
  expect(["an ack from another replica marks nothing", messageRow(upstream, toRelayed)?.delivered]).toEqual([
    "an ack from another replica marks nothing",
    0,
  ]);

  const rightAck = await sync(upstream, syncBody({ peers: [relayed], ack: [toRelayed] }));
  expect(["the ack marks the message delivered", messageRow(upstream, toRelayed)?.delivered]).toEqual([
    "the ack marks the message delivered",
    1,
  ]);
  expect([
    "an acked message no longer rides the response",
    rightAck.body.messages.some((m) => m.id === toRelayed),
  ]).toEqual(["an acked message no longer rides the response", false]);
});

test("a send by a relayed peer does not mark delivered the messages still waiting for it (mechanic A exemption)", async () => {
  const native = await register(upstream, "mech-host", "/mech");
  const relayed = relayPeer({ relay_ref: ref("mech"), peer_id: "mech-peer" });
  expect((await sync(upstream, syncBody({ peers: [relayed] }))).status).toBe(200);
  const sent = await postAuth<SendMessageResponse>(`${upstream.url}/send-message`, {
    from_token: native.instance_token,
    to_peer_id: "mech-peer",
    text: "still waiting to be pulled",
  });
  expect(sent.body.ok).toBe(true);
  const waiting = lastMessageId(upstream);

  const reply = await postAuth<SendRes>(`${upstream.url}/federation/send`, {
    replica_id: REPLICA,
    from_ref: ref("mech"),
    to_peer_id: native.peer_id,
    text: "a reply from the far side",
  });
  expect(["the relayed peer's send is accepted", reply.status, reply.body.ok]).toEqual([
    "the relayed peer's send is accepted",
    200,
    true,
  ]);
  expect([
    "a relayed peer's send never marks delivered what still awaits its replica's pull",
    messageRow(upstream, waiting)?.delivered,
  ]).toEqual(["a relayed peer's send never marks delivered what still awaits its replica's pull", 0]);

  const inbox = await postAuth<{ messages: { text: string; from_peer_id: string }[] }>(`${upstream.url}/poll-messages`, {
    instance_token: native.instance_token,
  });
  expect([
    "the native peer receives the reply under the relayed row's name",
    inbox.body.messages.filter((m) => m.text === "a reply from the far side").map((m) => m.from_peer_id),
  ]).toEqual(["the native peer receives the reply under the relayed row's name", ["mech-peer"]]);
});

test("send resolves the sender under the caller's relay only, and never writes the operator inbox", async () => {
  const secret = "routes-secret";
  const group = { id: await groupId(secret), hash: await sha256Hex(secret) };
  const native = await register(upstream, "op-host", "/op", group);
  const relayed = relayPeer({ relay_ref: ref("op-sender"), peer_id: "op-sender", group_id: group.id });
  const synced = await sync(
    upstream,
    syncBody({ groups: [{ group_id: group.id, group_secret_hash: group.hash }], peers: [relayed] })
  );
  expect(synced.status).toBe(200);

  const unknown = await postAuth<SendRes>(`${upstream.url}/federation/send`, {
    replica_id: REPLICA,
    from_ref: ref("nobody"),
    to_peer_id: native.peer_id,
    text: "hi",
  });
  expect(["an unknown from_ref is a 404", unknown.status]).toEqual(["an unknown from_ref is a 404", 404]);

  const impersonation = await postAuth<SendRes>(`${upstream.url}/federation/send`, {
    replica_id: OTHER_REPLICA,
    from_ref: ref("op-sender"),
    to_peer_id: native.peer_id,
    text: "hi",
  });
  expect(["a from_ref relayed by another replica is a 404 for this caller", impersonation.status]).toEqual([
    "a from_ref relayed by another replica is a 404 for this caller",
    404,
  ]);

  const toOperator = await postAuth<SendRes>(`${upstream.url}/federation/send`, {
    replica_id: REPLICA,
    from_ref: ref("op-sender"),
    to_peer_id: "operator",
    text: "should never land",
  });
  expect(["the operator inbox never crosses the boundary", toOperator.status]).toEqual([
    "the operator inbox never crosses the boundary",
    400,
  ]);
  const inbox = await postAuth<{ messages: { text: string }[] }>(`${upstream.url}/operator-inbox`, {
    group_id: group.id,
    group_secret_hash: group.hash,
  });
  expect(["the upstream inbox of the group stays empty", inbox.body.messages]).toEqual([
    "the upstream inbox of the group stays empty",
    [],
  ]);

  const notFound = await postAuth<SendRes>(`${upstream.url}/federation/send`, {
    replica_id: REPLICA,
    from_ref: ref("op-sender"),
    to_peer_id: "no-such-peer",
    text: "hi",
  });
  expect(["an unknown target is the ordinary send refusal", notFound.status, notFound.body.ok]).toEqual([
    "an unknown target is the ordinary send refusal",
    200,
    false,
  ]);
  expect(notFound.body.error).toContain("not found in your group");
});

test("a group presented with a divergent secret is refused and its peers ignored; the others are served", async () => {
  const pinned = { id: await groupId("pinned-secret"), hash: await sha256Hex("pinned-secret") };
  const fresh = { id: await groupId("fresh-secret"), hash: await sha256Hex("fresh-secret") };
  const nativePinned = await register(upstream, "pinned-host", "/pinned", pinned);
  const nativeDefault = await register(upstream, "default-host", "/default");

  const res = await sync(
    upstream,
    syncBody({
      groups: [
        { group_id: pinned.id, group_secret_hash: await sha256Hex("wrong-secret") },
        { group_id: fresh.id, group_secret_hash: fresh.hash },
        { group_id: "default", group_secret_hash: null },
      ],
      peers: [
        relayPeer({ relay_ref: ref("in-pinned"), peer_id: "in-pinned", group_id: pinned.id }),
        relayPeer({ relay_ref: ref("in-fresh"), peer_id: "in-fresh", group_id: fresh.id }),
        relayPeer({ relay_ref: ref("in-default"), peer_id: "in-default" }),
      ],
    })
  );
  expect(["the pass is served for the other groups", res.status]).toEqual(["the pass is served for the other groups", 200]);
  expect(["the divergent group is named in refused_groups", res.body.refused_groups.map((g) => g.group_id)]).toEqual([
    "the divergent group is named in refused_groups",
    [pinned.id],
  ]);
  const rows = await adminPeers(upstream);
  expect([
    "the refused group's peer is ignored, the others are relayed",
    rows.some((r) => r.peer_id === "in-pinned"),
    rows.find((r) => r.peer_id === "in-fresh")?.status,
    rows.find((r) => r.peer_id === "in-default")?.status,
  ]).toEqual(["the refused group's peer is ignored, the others are relayed", false, "active", "active"]);
  const seen = res.body.peers.map((p) => p.peer_id);
  expect([
    "the response carries the peers of the served groups only",
    seen.includes(nativeDefault.peer_id),
    seen.includes(nativePinned.peer_id),
  ]).toEqual(["the response carries the peers of the served groups only", true, false]);
  expect([
    "a native upstream peer is labelled via 'upstream'",
    res.body.peers.find((p) => p.peer_id === nativeDefault.peer_id)?.via,
  ]).toEqual(["a native upstream peer is labelled via 'upstream'", "upstream"]);
  expect([
    "the caller's own relayed rows never come back to it",
    seen.includes("in-default"),
    seen.includes("in-fresh"),
  ]).toEqual(["the caller's own relayed rows never come back to it", false, false]);

  // The fresh group was pinned by the sync: a later divergent secret is refused.
  const divergent = await sync(
    upstream,
    syncBody({ groups: [{ group_id: fresh.id, group_secret_hash: await sha256Hex("another") }], peers: [] })
  );
  expect(["a group pinned by a sync is TOFU-protected like one pinned by /register", divergent.body.refused_groups.map((g) => g.group_id)]).toEqual([
    "a group pinned by a sync is TOFU-protected like one pinned by /register",
    [fresh.id],
  ]);
});

test("a genuine rename to a free base is followed even when the old name looked like a suffix", async () => {
  // A peer whose base really is `x-2` renames to `x`: stickiness rests on the
  // proposal the replica made last time, not on the shape of the assigned name.
  const first = await sync(upstream, syncBody({ peers: [relayPeer({ relay_ref: ref("rename"), peer_id: "x-2" })] }));
  expect(["the row is relayed under its own base", first.body.assigned]).toEqual([
    "the row is relayed under its own base",
    [{ relay_ref: ref("rename"), peer_id: "x-2" }],
  ]);
  const second = await sync(upstream, syncBody({ peers: [relayPeer({ relay_ref: ref("rename"), peer_id: "x" })] }));
  expect(["a set_id to a free base is followed, not read as a suffix", second.body.assigned[0]?.peer_id]).toEqual([
    "a set_id to a free base is followed, not read as a suffix",
    "x",
  ]);
});

test("a relayed row re-presented under another group is ignored with a 200, never moved into a UNIQUE clash", async () => {
  const secret = "moved-secret";
  const g2 = { id: await groupId(secret), hash: await sha256Hex(secret) };
  const native = await register(upstream, "nat-host", "/nat", g2);
  await postAuth(`${upstream.url}/set-id`, { instance_token: native.instance_token, new_peer_id: "movable" });
  const first = await sync(upstream, syncBody({ peers: [relayPeer({ relay_ref: ref("mover"), peer_id: "movable" })] }));
  expect(["the row is relayed in default", first.status]).toEqual(["the row is relayed in default", 200]);
  const moved = await sync(
    upstream,
    syncBody({
      groups: [
        { group_id: "default", group_secret_hash: null },
        { group_id: g2.id, group_secret_hash: g2.hash },
      ],
      peers: [relayPeer({ relay_ref: ref("mover"), peer_id: "movable", group_id: g2.id })],
    })
  );
  expect(["a group move is not a 5xx that would flip the caller offline", moved.status]).toEqual([
    "a group move is not a 5xx that would flip the caller offline",
    200,
  ]);
  const rows = await adminPeers(upstream);
  const relayed = rows.filter((r) => r.peer_id === "movable");
  expect([
    "the relayed row stays in its first group; the native homonym is untouched",
    relayed.map((r) => [r.group_id, r.via]).sort(),
  ]).toEqual([
    "the relayed row stays in its first group; the native homonym is untouched",
    [
      ["default", REPLICA.slice(0, 8)],
      [g2.id, null],
    ].sort(),
  ]);
});

test("groups are capped and validated by shape, and a group with no presented peer is never pinned", async () => {
  const many = Array.from({ length: 51 }, (_, i) => ({
    group_id: i.toString(16).padStart(32, "0"),
    group_secret_hash: null,
  }));
  const capped = await sync(upstream, syncBody({ groups: many }));
  expect(["more than 50 groups is refused", capped.status]).toEqual(["more than 50 groups is refused", 400]);
  const shaped = await sync(
    upstream,
    syncBody({ groups: [{ group_id: `invented-${"z".repeat(200)}`, group_secret_hash: null }] })
  );
  expect(["a group id of the wrong shape is refused", shaped.status]).toEqual([
    "a group id of the wrong shape is refused",
    400,
  ]);
  const ghost = "f".repeat(32);
  const empty = await sync(upstream, syncBody({ groups: [{ group_id: ghost, group_secret_hash: "abc" }] }));
  expect(["a well-formed group without peers is accepted", empty.status]).toEqual([
    "a well-formed group without peers is accepted",
    200,
  ]);
  const db = openBrokerDb(upstream.dbPath, { readonly: true });
  try {
    expect([
      "a group nobody presents a peer for is never pinned",
      db.query("SELECT 1 FROM groups WHERE group_id = ?").get(ghost),
    ]).toEqual(["a group nobody presents a peer for is never pinned", null]);
  } finally {
    db.close();
  }
});

test("send refuses a text beyond the shared cap, on the federation route as on /send-message", async () => {
  const native = await register(upstream, "big-host", "/big");
  await sync(upstream, syncBody({ peers: [relayPeer({ relay_ref: ref("big"), peer_id: "bigsender" })] }));
  const text = "a".repeat(64 * 1024 + 1);
  const relayed = await postAuth<SendRes>(`${upstream.url}/federation/send`, {
    replica_id: REPLICA,
    from_ref: ref("big"),
    to_peer_id: native.peer_id,
    text,
  });
  expect(["an oversized relayed text is refused, not stored", relayed.status, relayed.body.ok]).toEqual([
    "an oversized relayed text is refused, not stored",
    400,
    undefined,
  ]);
  const local = await postAuth<SendRes>(`${upstream.url}/send-message`, {
    from_token: native.instance_token,
    to_peer_id: "bigsender",
    text,
  });
  expect(["the same cap holds on /send-message", local.body.ok]).toEqual(["the same cap holds on /send-message", false]);
});
// --- Peer telemetry across federation: carried as the producer observed it ---

const SNAP: PeerTelemetrySnapshot = {
  model: "Claude Opus 4.6",
  modelId: "claude-opus-4-6",
  contextPct: 42,
  contextWindow: 200_000,
  observedAt: 1_731_234_567_890,
};

function snap(over: Partial<PeerTelemetrySnapshot> = {}): PeerTelemetrySnapshot {
  return { ...SNAP, ...over };
}

async function listedTelemetry(b: TestBroker, observer: string, peerId: string): Promise<unknown> {
  return (await listPeers(b, observer)).find((p) => p.peer_id === peerId)?.telemetry;
}

async function adminTelemetry(b: TestBroker, peerId: string, group = "default"): Promise<unknown> {
  return (await adminPeers(b)).find((r) => r.peer_id === peerId && r.group_id === group)?.telemetry;
}

test("a relayed peer's telemetry is listed by a native peer and handed to another replica, observedAt untouched", async () => {
  const native = await register(upstream, "tel-host-1", "/tel/1");
  const own = await sync(upstream, syncBody({ peers: [relayPeer({ relay_ref: ref("tel-1"), peer_id: "tel-one", telemetry: snap() })] }));
  expect(["the pass carrying telemetry is served", own.status]).toEqual(["the pass carrying telemetry is served", 200]);
  expect([
    "the caller's own response never echoes its relayed row back",
    own.body.peers.some((p) => p.peer_id === "tel-one"),
  ]).toEqual(["the caller's own response never echoes its relayed row back", false]);

  expect(["a native peer reads the snapshot as the replica sent it", await listedTelemetry(upstream, native.instance_token, "tel-one")]).toEqual([
    "a native peer reads the snapshot as the replica sent it",
    SNAP,
  ]);

  const other = await sync(upstream, syncBody({ replica_id: OTHER_REPLICA, peers: [] }));
  expect([
    "another replica receives it through the directory, with the producer's observedAt",
    other.body.peers.find((p) => p.peer_id === "tel-one")?.telemetry,
  ]).toEqual(["another replica receives it through the directory, with the producer's observedAt", SNAP]);
});

test("a native peer's launch telemetry rides the directory handed to a replica", async () => {
  const phrase = "tel-local-phrase";
  const group = { id: await groupId(phrase), hash: await sha256Hex(phrase) };
  await register(upstream, "tel-seed-host", "/tel/seed", group);
  const run = await mintRunCredential(upstream, group, undefined, postAuth);
  const desk = "tel-local-desk";
  const launchHash = "a".repeat(64);
  const tile = await registerAttestedInstance(
    upstream,
    run,
    hostname(),
    "/tel/tile",
    { desk_session: desk, telemetry_capability_hash: launchHash },
    postAuth
  );
  expect(["the tile registers", tile.status]).toEqual(["the tile registers", 200]);
  const payload = { run_ref: run.run, group_id: run.group, desk_session: desk, launch_hash: launchHash, action: "publish", snapshot: SNAP };
  const published = await postAuth<{ outcome?: string }>(`${upstream.url}/tile-telemetry`, {
    ...payload,
    auth: operatorInboxProof(payload, INBOX_GATES.tileTelemetry),
  });
  expect(["the launch snapshot is accepted", published.body.outcome]).toEqual(["the launch snapshot is accepted", "updated"]);

  const res = await sync(
    upstream,
    syncBody({ groups: [{ group_id: group.id, group_secret_hash: group.hash }], peers: [] })
  );
  expect([
    "the replica receives the native tile's snapshot with the producer's observedAt",
    res.body.peers.find((p) => p.peer_id === tile.body.peer_id)?.telemetry,
  ]).toEqual(["the replica receives the native tile's snapshot with the producer's observedAt", SNAP]);
});

test("an import is replaced per directory: newer wins, older and conflicting are refused, absence retracts", async () => {
  const native = await register(upstream, "tel-host-2", "/tel/2");
  const present = (telemetry?: PeerTelemetrySnapshot) =>
    sync(upstream, syncBody({ peers: [relayPeer({ relay_ref: ref("tel-2"), peer_id: "tel-two", telemetry })] }));
  const shown = () => listedTelemetry(upstream, native.instance_token, "tel-two");

  await present(snap());
  expect(["first observation", await shown()]).toEqual(["first observation", SNAP]);
  await present(snap({ observedAt: SNAP.observedAt - 1, contextPct: 99 }));
  expect(["an older observation is refused", await shown()]).toEqual(["an older observation is refused", SNAP]);
  await present(snap({ contextPct: 99 }));
  expect(["the same date with other content is refused", await shown()]).toEqual([
    "the same date with other content is refused",
    SNAP,
  ]);
  const newer = snap({ observedAt: SNAP.observedAt + 10, contextPct: 55 });
  await present(newer);
  expect(["a newer observation replaces it", await shown()]).toEqual(["a newer observation replaces it", newer]);
  await present(undefined);
  expect(["a directory without the sub-object retracts it", await shown()]).toEqual([
    "a directory without the sub-object retracts it",
    undefined,
  ]);
  await present(newer);
  expect(["after a retraction the same observation is accepted again", await shown()]).toEqual([
    "after a retraction the same observation is accepted again",
    newer,
  ]);
});

test("a malformed sub-object is refused whole and leaves the visible observation in place", async () => {
  const native = await register(upstream, "tel-host-3", "/tel/3");
  const peer = (telemetry: unknown) =>
    sync(upstream, syncBody({ peers: [relayPeer({ relay_ref: ref("tel-3"), peer_id: "tel-three", telemetry: telemetry as PeerTelemetrySnapshot })] }));
  await peer(snap());
  const bad = await peer({ ...SNAP, contextPct: Number.NaN });
  expect(["the pass itself is served", bad.status]).toEqual(["the pass itself is served", 200]);
  expect(["the previous observation stays", await listedTelemetry(upstream, native.instance_token, "tel-three")]).toEqual([
    "the previous observation stays",
    SNAP,
  ]);
});

test("each replica's imports are its own: another replica's pass leaves them, and a shared relay_ref is two rows", async () => {
  const native = await register(upstream, "tel-host-4", "/tel/4");
  const a = snap({ contextPct: 10 });
  const b = snap({ contextPct: 20, observedAt: SNAP.observedAt + 5 });
  await sync(upstream, syncBody({ peers: [relayPeer({ relay_ref: ref("tel-shared"), peer_id: "tel-ns-a", telemetry: a })] }));
  await sync(
    upstream,
    syncBody({ replica_id: OTHER_REPLICA, peers: [relayPeer({ relay_ref: ref("tel-shared"), peer_id: "tel-ns-b", telemetry: b })] })
  );
  expect([
    "the same relay_ref from two replicas keeps two snapshots",
    await listedTelemetry(upstream, native.instance_token, "tel-ns-a"),
    await listedTelemetry(upstream, native.instance_token, "tel-ns-b"),
  ]).toEqual(["the same relay_ref from two replicas keeps two snapshots", a, b]);

  await sync(upstream, syncBody({ peers: [] }));
  expect([
    "a pass of the first replica retracts its own and leaves the other's",
    await adminTelemetry(upstream, "tel-ns-a"),
    await adminTelemetry(upstream, "tel-ns-b"),
  ]).toEqual(["a pass of the first replica retracts its own and leaves the other's", undefined, b]);
});

test("the same peer_id in two groups of one replica keeps two snapshots", async () => {
  const x = { id: await groupId("tel-gx"), hash: await sha256Hex("tel-gx") };
  const y = { id: await groupId("tel-gy"), hash: await sha256Hex("tel-gy") };
  await register(upstream, "tel-gx-host", "/tel/gx", x);
  await register(upstream, "tel-gy-host", "/tel/gy", y);
  const tx = snap({ contextPct: 11 });
  const ty = snap({ contextPct: 22 });
  await sync(
    upstream,
    syncBody({
      groups: [
        { group_id: x.id, group_secret_hash: x.hash },
        { group_id: y.id, group_secret_hash: y.hash },
      ],
      peers: [
        relayPeer({ relay_ref: ref("tel-twin-x"), peer_id: "tel-twin", group_id: x.id, telemetry: tx }),
        relayPeer({ relay_ref: ref("tel-twin-y"), peer_id: "tel-twin", group_id: y.id, telemetry: ty }),
      ],
    })
  );
  expect([
    "each group's homonym carries its own snapshot",
    await adminTelemetry(upstream, "tel-twin", x.id),
    await adminTelemetry(upstream, "tel-twin", y.id),
  ]).toEqual(["each group's homonym carries its own snapshot", tx, ty]);
});

test("a group refused on a later pass imports nothing and retracts what the row showed", async () => {
  const g = { id: await groupId("tel-refused"), hash: await sha256Hex("tel-refused") };
  await register(upstream, "tel-refused-host", "/tel/refused", g);
  const pass = (hash: string, telemetry: PeerTelemetrySnapshot) =>
    sync(
      upstream,
      syncBody({
        groups: [{ group_id: g.id, group_secret_hash: hash }],
        peers: [relayPeer({ relay_ref: ref("tel-refused"), peer_id: "tel-refused-peer", group_id: g.id, telemetry })],
      })
    );
  await pass(g.hash, SNAP);
  expect(["accepted pass", await adminTelemetry(upstream, "tel-refused-peer", g.id)]).toEqual(["accepted pass", SNAP]);
  const refused = await pass(await sha256Hex("wrong"), snap({ observedAt: SNAP.observedAt + 99 }));
  expect(["the group is named refused", refused.body.refused_groups.map((r) => r.group_id)]).toEqual([
    "the group is named refused",
    [g.id],
  ]);
  expect(["nothing of the refused pass is shown", await adminTelemetry(upstream, "tel-refused-peer", g.id)]).toEqual([
    "nothing of the refused pass is shown",
    undefined,
  ]);
});

test("a peer that turns dormant shows no telemetry", async () => {
  await sync(upstream, syncBody({ peers: [relayPeer({ relay_ref: ref("tel-dormant"), peer_id: "tel-dormant", telemetry: snap() })] }));
  expect(["listed while present", await adminTelemetry(upstream, "tel-dormant")]).toEqual(["listed while present", SNAP]);
  await sync(upstream, syncBody({ peers: [] }));
  const row = (await adminPeers(upstream)).find((r) => r.peer_id === "tel-dormant");
  expect(["the row is dormant", row?.status]).toEqual(["the row is dormant", "dormant"]);
  expect(["and carries no snapshot", row?.telemetry]).toEqual(["and carries no snapshot", undefined]);
});

test("a pass whose transaction rolls back applies no telemetry", async () => {
  const native = await register(upstream, "tel-host-rb", "/tel/rb");
  await sync(
    upstream,
    syncBody({
      peers: [
        relayPeer({ relay_ref: ref("tel-rb-p"), peer_id: "tel-rb-p", telemetry: snap() }),
        relayPeer({ relay_ref: ref("tel-rb-q"), peer_id: "tel-rb-q" }),
      ],
    })
  );
  const db = openBrokerDb(upstream.dbPath);
  try {
    db.run(
      "CREATE TRIGGER tel_rollback BEFORE UPDATE ON peers WHEN OLD.status = 'active' AND NEW.status = 'dormant' BEGIN SELECT RAISE(ABORT, 'rollback probe'); END"
    );
    const newer = snap({ observedAt: SNAP.observedAt + 1_000, contextPct: 77 });
    const failed = await sync(
      upstream,
      syncBody({ peers: [relayPeer({ relay_ref: ref("tel-rb-p"), peer_id: "tel-rb-p", telemetry: newer })] })
    );
    expect(["the pass fails as a whole", failed.status >= 500]).toEqual(["the pass fails as a whole", true]);
    expect(["the rolled-back directory is not applied", await listedTelemetry(upstream, native.instance_token, "tel-rb-p")]).toEqual([
      "the rolled-back directory is not applied",
      SNAP,
    ]);
  } finally {
    db.run("DROP TRIGGER IF EXISTS tel_rollback");
    db.close();
  }
});

// --- The replica half: a real replica behind a proxy this file controls ---

const REPLICA_GRACE_SEC = 2;
let rigReplica: TestBroker | null = null;
let rigProxy: UpstreamProxy | null = null;

afterAll(async () => {
  rigProxy?.stop();
  if (rigReplica) await stopBroker(rigReplica);
});

async function replicaRig(): Promise<{ replica: TestBroker; proxy: UpstreamProxy }> {
  if (!rigReplica || !rigProxy) {
    rigProxy = startUpstreamProxy(upstream.url);
    rigReplica = await startPlainBroker({
      CLAUDE_PEERS_BROKER_URL: rigProxy.url,
      CLAUDE_PEERS_BROKER_TOKEN: TOKEN,
      CLAUDE_PEERS_OFFLINE_REPLICA: "1",
      CLAUDE_PEERS_SYNC_TICK_MS: "200",
      CLAUDE_PEERS_FEDERATION_GRACE_SEC: String(REPLICA_GRACE_SEC),
    });
  }
  return { replica: rigReplica, proxy: rigProxy };
}

async function eventually<T>(what: string, read: () => Promise<T>, done: (value: T) => boolean, budgetMs = 15_000): Promise<T> {
  const deadline = Date.now() + budgetMs;
  let last = await read();
  while (!done(last)) {
    if (Date.now() > deadline) throw new Error(`${what}: timed out; last=${JSON.stringify(last)}`);
    await Bun.sleep(60);
    last = await read();
  }
  return last;
}

async function replicaPasses(replica: TestBroker, n: number): Promise<void> {
  const stamp = async () =>
    (await postAuth<{ last_sync_at: string | null }>(`${replica.url}/roadmap/sync/status`, {})).body.last_sync_at;
  let seen = await stamp();
  let count = 0;
  await eventually("replica passes", async () => {
    const now = await stamp();
    if (now !== seen) {
      seen = now;
      count += 1;
    }
    return count;
  }, (c) => c >= n);
}

test("a replica's local tile telemetry reaches the upstream's native peers as published", async () => {
  const { replica, proxy } = await replicaRig();
  const phrase = "tel-out-phrase";
  const group = { id: await groupId(phrase), hash: await sha256Hex(phrase) };
  const observer = await register(upstream, "tel-out-observer", "/tel/out/obs", group);
  await register(replica, "tel-out-seed", "/tel/out/seed", group);
  const run = await mintRunCredential(replica, group, undefined, postAuth);
  const desk = "tel-out-desk";
  const launchHash = "b".repeat(64);
  const tile = await registerAttestedInstance(
    replica,
    run,
    hostname(),
    "/tel/out/tile",
    { desk_session: desk, telemetry_capability_hash: launchHash },
    postAuth
  );
  expect(["the tile registers on the replica", tile.status]).toEqual(["the tile registers on the replica", 200]);
  const payload = { run_ref: run.run, group_id: run.group, desk_session: desk, launch_hash: launchHash, action: "publish", snapshot: SNAP };
  const published = await postAuth<{ outcome?: string }>(`${replica.url}/tile-telemetry`, {
    ...payload,
    auth: operatorInboxProof(payload, INBOX_GATES.tileTelemetry),
  });
  expect(["the replica accepts the launch snapshot", published.body.outcome]).toEqual(["the replica accepts the launch snapshot", "updated"]);

  const seen = await eventually(
    "the upstream lists the replica's tile with its snapshot",
    async () =>
      (await listPeers(upstream, observer.instance_token)).find(
        (p) => p.peer_id === tile.body.peer_id && p.telemetry !== undefined
      )?.telemetry,
    (t) => t !== undefined
  );
  expect(["the upstream shows the replica's snapshot with the producer's observedAt", seen]).toEqual([
    "the upstream shows the replica's snapshot with the producer's observedAt",
    SNAP,
  ]);
  const wire = proxy.exchanges
    .filter((e) => e.path === "/federation/sync")
    .map((e) => JSON.parse(e.request) as FederationSyncRequest)
    .flatMap((r) => r.peers)
    .find((p) => p.peer_id === tile.body.peer_id && p.telemetry !== undefined);
  expect(["the wire carries the five fields and nothing else", Object.keys(wire?.telemetry ?? {}).sort()]).toEqual([
    "the wire carries the five fields and nothing else",
    ["contextPct", "contextWindow", "model", "modelId", "observedAt"],
  ]);
}, 40_000);

test("a replica shows the telemetry of a mirrored peer as the upstream observed it, keeps it through the grace, drops it at its end", async () => {
  const { replica, proxy } = await replicaRig();
  const observer = await register(replica, "tel-in-observer", "/tel/in/obs");
  const upstreamId = (await sync(upstream, syncBody({ replica_id: "scripted-replica-01" }))).body.upstream_id;
  const mirror = (telemetry?: PeerTelemetrySnapshot): FederationSyncResponse => ({
    upstream_id: upstreamId,
    assigned: [],
    peers: [
      {
        peer_id: "tel-mirror",
        group_id: "default",
        host: "far-host",
        cwd: "/far",
        git_root: null,
        project_key: null,
        summary: "",
        role: null,
        status: "active",
        last_seen: new Date().toISOString(),
        last_activity_at: null,
        via: "upstream",
        ...(telemetry ? { telemetry } : {}),
      },
    ],
    messages: [],
    refused_groups: [],
  });
  let scripted: FederationSyncResponse | null = mirror(SNAP);
  proxy.intercept = (path) => (path === "/federation/sync" && scripted ? Response.json(scripted) : null);
  const shown = () => listedTelemetry(replica, observer.instance_token, "tel-mirror");
  try {
    await eventually("the mirror shows the snapshot", shown, (t) => t !== undefined);
    expect(["the replica shows the observation with the upstream's observedAt", await shown()]).toEqual([
      "the replica shows the observation with the upstream's observedAt",
      SNAP,
    ]);

    scripted = mirror(snap({ observedAt: SNAP.observedAt - 1, contextPct: 99 }));
    await replicaPasses(replica, 2);
    expect(["an older observation is refused", await shown()]).toEqual(["an older observation is refused", SNAP]);

    scripted = mirror();
    await eventually("a directory without the sub-object retracts it", shown, (t) => t === undefined);

    scripted = mirror(SNAP);
    await eventually("the same observation is accepted again after the retraction", shown, (t) => t !== undefined);

    proxy.blocked = true;
    await eventually(
      "the replica notices the outage",
      async () => (await postAuth<{ online: boolean }>(`${replica.url}/roadmap/sync/status`, {})).body.online,
      (online) => online === false
    );
    expect(["within the grace the last observation stays, with its real date", await shown()]).toEqual([
      "within the grace the last observation stays, with its real date",
      SNAP,
    ]);
    await eventually(
      "the end of the grace drops the namespace",
      () => adminTelemetry(replica, "tel-mirror"),
      (t) => t === undefined
    );
    const dormant = (await adminPeers(replica)).find((r) => r.peer_id === "tel-mirror");
    expect(["the mirror is dormant by then, so the empty answer is the drop and not a hidden row", dormant?.status]).toEqual([
      "the mirror is dormant by then, so the empty answer is the drop and not a hidden row",
      "dormant",
    ]);
  } finally {
    proxy.blocked = false;
    proxy.intercept = null;
  }
}, 40_000);
