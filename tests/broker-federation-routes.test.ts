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
} from "./_helper.ts";
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
  const RETAINED = ["instance_token", "pid", "client_pid", "claude_cli_pid", "relay_id", "relay_ref", "relay_base"];
  const COMPUTED = ["activity_status", "link_down_since"];
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
