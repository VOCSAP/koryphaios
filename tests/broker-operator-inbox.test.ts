// PLAN C12: operator inbox. Agents send_message to the reserved 'operator'
// peer; the Deck drains POST /operator-inbox per group (TOFU-authenticated,
// marks delivered). The sentinel row must never surface as a normal peer.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { startBroker, stopBroker, post, get, livePid, groupId, sha256Hex, type TestBroker } from "./_helper.ts";
import {
  buildAuthProof,
  deriveOperatorId,
  generateCredential,
  type ApprovalCredential,
} from "../shared/approval.ts";
// Review MINOR-1: the sentinel token is IMPORTED, never re-typed. A hand-typed
// '__operator__' on both sides of a probe keeps seed and assertion agreeing with
// each other while testing a row that is no longer the operator inbox -- green
// for a reason foreign to what the probe claims to test.
import { OPERATOR_INSTANCE_TOKEN, SENTINEL_DEFINITIONS, type Approval } from "../shared/types.ts";

let broker: TestBroker;

beforeAll(async () => { broker = await startBroker(); });
afterAll(async () => { await stopBroker(broker); });

// Every helper below takes an OPTIONAL trailing `b: TestBroker = broker`
// (card 1e81ee7b Cell 2): defaults to the shared file-level broker, so every
// existing call site is unchanged, but a single test that needs to own an
// explicit TTL premise can spin up (and stop) its own dedicated instance
// instead of asserting against the shared broker's default configuration.

async function register(
  host: string,
  cwd: string,
  group: { id: string; hash: string } | null = null,
  b: TestBroker = broker
) {
  return post<{ peer_id: string; instance_token: string }>(`${b.url}/register`, {
    pid: livePid(),
    cwd,
    git_root: null,
    tty: null,
    summary: "",
    host,
    client_pid: 1,
    project_key: null,
    group_id: group?.id ?? "default",
    group_secret_hash: group?.hash ?? null,
  });
}

async function sendToOperator(fromToken: string, text: string, b: TestBroker = broker) {
  return post<{ ok: boolean; error?: string }>(`${b.url}/send-message`, {
    from_token: fromToken,
    to_peer_id: "operator",
    text,
  });
}

async function drain(group: { id: string; hash: string | null }, b: TestBroker = broker) {
  return post<{ messages: { id: number; from_peer_id: string; text: string; sent_at: string }[] } | { error: string }>(
    `${b.url}/operator-inbox`,
    { group_id: group.id, group_secret_hash: group.hash }
  );
}

// Courrier lot 1A/1C (design doc desktop/docs/design-courrier-lot1.md section
// 6.1, cards 54b1c71a and 1e81ee7b broker half).

async function drainAs(group: { id: string; hash: string | null }, sessionId: string, b: TestBroker = broker) {
  return post<{ messages: { id: number; from_peer_id: string; text: string; sent_at: string }[] } | { error: string }>(
    `${b.url}/operator-inbox`,
    { group_id: group.id, group_secret_hash: group.hash, session_id: sessionId }
  );
}

async function purge(
  group: { id: string; hash: string | null },
  sessionId: string,
  scope: "session" | "ids",
  ids?: number[],
  b: TestBroker = broker
) {
  return post<{ deleted: number } | { error: string }>(`${b.url}/operator-inbox/purge`, {
    group_id: group.id,
    group_secret_hash: group.hash,
    session_id: sessionId,
    scope,
    ids,
  });
}

test("send_message to 'operator' lands in the group inbox; drain marks delivered", async () => {
  const g = { id: await groupId("op-A"), hash: await sha256Hex("op-A") };
  const a = await register("hOp1", "/opA1", g);

  const sent = await sendToOperator(a.body.instance_token, "review is done, merge?");
  expect(sent.status).toBe(200);
  expect((sent.body as { ok: boolean }).ok).toBe(true);

  const first = await drain(g);
  expect(first.status).toBe(200);
  const messages = (first.body as { messages: { from_peer_id: string; text: string }[] }).messages;
  expect(messages.length).toBe(1);
  expect(messages[0]!.from_peer_id).toBe(a.body.peer_id);
  expect(messages[0]!.text).toBe("review is done, merge?");

  // Drained once -> delivered; a second drain is empty.
  const second = await drain(g);
  expect((second.body as { messages: unknown[] }).messages.length).toBe(0);

  const db = new Database(broker.dbPath, { readonly: true });
  try {
    const rows = db.query(
      "SELECT delivered FROM messages WHERE to_token = ? AND group_id = ?"
    ).all(OPERATOR_INSTANCE_TOKEN, g.id) as { delivered: number }[];
    expect(rows.length).toBe(1);
    expect(rows[0]!.delivered).toBe(1);
  } finally {
    db.close();
  }
});

test("the inbox is group-isolated and rejects a wrong secret with 401", async () => {
  const gA = { id: await groupId("op-isoA"), hash: await sha256Hex("op-isoA") };
  const gB = { id: await groupId("op-isoB"), hash: await sha256Hex("op-isoB") };
  const a = await register("hOpI1", "/opI1", gA);
  await register("hOpI2", "/opI2", gB);

  await sendToOperator(a.body.instance_token, "only group A sees this");

  const drainB = await drain(gB);
  expect((drainB.body as { messages: unknown[] }).messages.length).toBe(0);

  const spoofed = await drain({ id: gA.id, hash: await sha256Hex("WRONG") });
  expect(spoofed.status).toBe(401);

  // The real drain still returns it (the spoofed one must not have consumed it).
  const drainA = await drain(gA);
  expect((drainA.body as { messages: { text: string }[] }).messages.length).toBe(1);
});

test("the reserved operator row never surfaces in list_peers or group-stats", async () => {
  const g = { id: await groupId("op-hidden"), hash: await sha256Hex("op-hidden") };
  const a = await register("hOpH1", "/opH1", g);

  const peers = await post<{ peer_id: string }[]>(`${broker.url}/list-peers`, {
    scope: "machine",
    instance_token: a.body.instance_token,
    cwd: "/opH1",
    git_root: null,
  });
  expect(peers.body.some((p) => p.peer_id === "operator")).toBe(false);

  const stats = await get<{ groups: { group_id: string }[] }>(`${broker.url}/group-stats`);
  // The sentinel sits dormant in 'default'; no test here registered a default
  // peer, so 'default' must be absent from the active stats.
  expect(stats.body.groups.find((row) => row.group_id === "default")).toBeUndefined();
});

// --- Card 37a2b8c7 volet 1: the operator inbox never lives in a secret-less group ---
//
// 'default' pins no secret by design (the zero-config rendezvous), so its
// secret check is exempt and ANY holder of the shared BROKER_TOKEN can name it.
// Rather than authenticate it (impossible without pinning a secret, which would
// destroy the rendezvous), BOTH ends are refused: the drain AND the deposit.
// These two tests must stay together -- refusing only the drain would keep
// accepting a write nobody can ever read.
//
// Ordering note: these register peers in 'default', which the group-stats test
// above asserts is absent from the active stats. Keep them AFTER it.

test("volet 1 deposit: send_message to 'operator' is refused from the 'default' group", async () => {
  const a = await register("hOpD1", "/opD1"); // no group -> 'default'

  const sent = await sendToOperator(a.body.instance_token, "nobody will ever drain this");
  expect(sent.status).toBe(200);
  const body = sent.body as { ok: boolean; error?: string };
  expect(body.ok).toBe(false);
  expect(body.error ?? "").toContain("default");

  // The refusal must be a refusal to STORE, not a silent accept: nothing landed.
  const db = new Database(broker.dbPath, { readonly: true });
  try {
    const rows = db.query(
      "SELECT id FROM messages WHERE to_token = ? AND group_id = 'default'"
    ).all(OPERATOR_INSTANCE_TOKEN) as { id: number }[];
    expect(rows.length).toBe(0);
  } finally {
    db.close();
  }

  // Negative control on the probe itself: the same call in a secret-pinned
  // group still succeeds, so `ok:false` above comes from the group, not from a
  // send path broken for everyone.
  const g = { id: await groupId("op-dep-ok"), hash: await sha256Hex("op-dep-ok") };
  const b = await register("hOpD2", "/opD2", g);
  const okSend = await sendToOperator(b.body.instance_token, "this one is drainable");
  expect((okSend.body as { ok: boolean }).ok).toBe(true);
});

test("volet 1 drain: /operator-inbox on 'default' is refused with 403 and consumes nothing", async () => {
  // The deposit guard makes the inbox of 'default' unreachable through the API,
  // so seed it directly: without a pending row this probe would pass GREEN even
  // with the guard removed (an empty drain returns 200 + zero messages, and the
  // assertion on 403 would be the only thing failing -- but the "consumes
  // nothing" half would be vacuous). The seed is what makes the drain have
  // something to steal.
  const a = await register("hOpX1", "/opX1"); // 'default'
  const seed = new Database(broker.dbPath);
  try {
    seed.query(
      `INSERT INTO messages (from_token, to_token, group_id, text, sent_at, delivered)
       VALUES (?, ?, 'default', ?, ?, 0)`
    ).run(
      a.body.instance_token,
      OPERATOR_INSTANCE_TOKEN,
      "secret operator payload",
      new Date().toISOString()
    );
  } finally {
    seed.close();
  }

  const refused = await drain({ id: "default", hash: null });
  expect(refused.status).toBe(403);
  expect((refused.body as { error: string }).error).toContain("default");

  // Disclosure AND suppression are both closed: the row is still there, and
  // still undelivered (a successful drain marks delivered, hiding it from the
  // real Deck).
  const db = new Database(broker.dbPath, { readonly: true });
  try {
    const rows = db.query(
      "SELECT delivered, text FROM messages WHERE to_token = ? AND group_id = 'default'"
    ).all(OPERATOR_INSTANCE_TOKEN) as { delivered: number; text: string }[];
    expect(rows.length).toBe(1);
    expect(rows[0]!.delivered).toBe(0);
    expect(rows[0]!.text).toBe("secret operator payload");
  } finally {
    db.close();
  }

  // Supplying a secret hash does not buy the drain either: the group is refused
  // by identity, not by a failed comparison.
  const withHash = await drain({ id: "default", hash: await sha256Hex("anything") });
  expect(withHash.status).toBe(403);
});

test("set_id refuses the reserved name 'operator'", async () => {
  const g = { id: await groupId("op-rename"), hash: await sha256Hex("op-rename") };
  const a = await register("hOpR1", "/opR1", g);
  const res = await post<{ error?: string }>(`${broker.url}/set-id`, {
    instance_token: a.body.instance_token,
    new_peer_id: "operator",
  });
  expect(res.status).toBe(400);
});

// --- Card 37a2b8c7 volet 1, COVERAGE half -------------------------------------
//
// The two guards above close the two routes that reach the operator inbox
// TODAY. The half no guard covers is DOMAIN GROWTH: a route added tomorrow that
// accepts a client-supplied recipient and resolves it to the sentinel would
// re-open the inbox with nothing failing.
//
// So the domain is DISCOVERED from the request interfaces (the method that
// found NINE routes trusting a client instance_token where a read-by-handlers
// found eight: a handler is forgotten, a field in a data contract is not), and
// every interface carrying a recipient field must be classified here -- guarded,
// or exempt WITH ITS REASON. An unclassified one fails.
//
// Pinning a COUNT was considered and rejected: it goes red on a rename or an
// added import, and a test that reddens for nothing gets deleted.

interface RecipientClassification {
  /** The recipient field the scanner found. */
  field: string;
  /** The route that parses this interface, or why it parses none. */
  route: string;
  verdict: "guarded" | "exempt";
  reason: string;
}

const RECIPIENT_ROUTES: Record<string, RecipientClassification> = {
  Message: {
    field: "to_token",
    route: "(none)",
    verdict: "exempt",
    reason:
      "Broker-internal row shape (the messages table), never parsed from a request body: to_token is written by the broker after it resolved a peer_id itself.",
  },
  SendMessageRequest: {
    field: "to_peer_id",
    route: "/send-message",
    verdict: "guarded",
    reason:
      "The deposit half of volet 1: to_peer_id === 'operator' is refused when the sender's group is TOFU-exempt (groupMayCarryOperatorInbox). Proven by the 'volet 1 deposit' test above.",
  },
  AnnounceRequest: {
    field: "to_peer_id",
    route: "/announce",
    verdict: "exempt",
    reason:
      "The targeted-announce resolution filters status='active' and the sentinel rows are seeded permanently dormant, so 'operator' resolves to nothing and the route 404s before any insert. Contingent on BOTH properties -- probed live below, not merely asserted here.",
  },
  RoadmapItem: {
    field: "target_peer_ids",
    route: "/roadmap/import",
    verdict: "guarded",
    reason:
      "Directive targets are laundered through cleanPeerIds (broker.ts:1611-1622) on all three write paths (upsert :1833, create :1951, import :2313), and it drops any id present in RESERVED_PEER_IDS -- which derives from SENTINEL_DEFINITIONS, so 'operator' can never become a directive target.",
  },
  RoadmapUpsertRequest: {
    field: "target_peer_ids",
    route: "/roadmap/upsert",
    verdict: "guarded",
    reason:
      "Same cleanPeerIds laundering as RoadmapItem: the reserved ids are stripped before the row is written, so a directive can never be aimed at a sentinel.",
  },
  ApprovalAddRequest: {
    field: "reply_peer_id",
    route: "/approval/add",
    verdict: "exempt",
    reason:
      "resolveReplyRoute resolves reply_peer_id with the same status='active' filter and DOWNGRADES to the pty route when it finds nothing, so an answer can never be deposited into the inbox. Same contingent pair as /announce -- probed live below.",
  },
};

/**
 * Discover every exported interface carrying a client-supplied RECIPIENT field.
 *
 * Name-shaped rather than handler-shaped, and deliberately NOT limited to
 * interfaces whose name ends in "Request": a body type named something else
 * would silently leave the domain. Anything it finds must be classified above,
 * including internal row shapes -- an over-wide scanner costs one entry in the
 * table, an under-wide one costs the whole guarantee.
 *
 * Review MAJOR-1: the first draft required a SINGULAR suffix and therefore
 * matched no plural field, so it silently missed RoadmapItem.target_peer_ids
 * and RoadmapUpsertRequest.target_peer_ids -- a subset announcing itself as a
 * total, which is the exact shape this test exists to forbid. Hence
 * `peer_ids` in the alternation, and a PLURAL variant in the negative control
 * below: a fix that is only asserted is not proven.
 *
 * TWO LIMITS, both inherent to discovery by name, stated so a reader does not
 * mistake this for a total:
 *  1. It reads the data CONTRACT. A handler parsing a recipient straight out of
 *     an untyped body escapes it: handleChannelConnect, handleChannelDisconnect
 *     and handleChannelList take a `Record<string, unknown>` body
 *     (/approval/channel-connect|disconnect|list) and read a notification
 *     DESTINATION out of it. Named rather than counted on purpose: a count
 *     rots at the next edit and a reader who re-measures it stops trusting the
 *     whole paragraph, while three route names stay checkable.
 *  2. The domain is NOMINAL. A destination named `chat_id`, `address` or
 *     `deliver_to` -- a Telegram chat or a Discord guild is a recipient too --
 *     leaves the domain by its NAME alone.
 * Widening to untyped bodies is a separate unit, deliberately not done here.
 */
function findRecipientCarryingInterfaces(source: string): { iface: string; field: string }[] {
  const found: { iface: string; field: string }[] = [];
  let current: string | null = null;
  let depth = 0;
  for (const line of source.split(/\r?\n/)) {
    if (!current) {
      const opened = /^export\s+interface\s+(\w+)/.exec(line);
      if (!opened) continue;
      current = opened[1]!;
      depth = 0;
    }
    depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
    const field = /^\s*(to|reply|target|recipient|dest)_(peer_ids|peer_id|peer|token)\??\s*:/.exec(
      line
    );
    if (field) found.push({ iface: current, field: `${field[1]}_${field[2]}` });
    if (depth <= 0 && /\}/.test(line)) current = null;
  }
  return found;
}

test("coverage: every interface carrying a client-supplied recipient is classified", async () => {
  const source = await Bun.file(new URL("../shared/types.ts", import.meta.url)).text();
  const found = findRecipientCarryingInterfaces(source);

  // The scanner must SEE something before its silence can mean anything (a
  // volet 2 probe once passed green with its guard removed because an
  // unrelated early return made it blind).
  expect(found.length).toBeGreaterThan(0);
  expect(found.map((f) => f.iface)).toContain("SendMessageRequest");

  expect(found.filter((f) => !RECIPIENT_ROUTES[f.iface])).toEqual([]);

  // A classification must still describe the field actually found: renaming
  // to_peer_id into to_token without revisiting the verdict is red.
  for (const f of found) {
    expect(RECIPIENT_ROUTES[f.iface]!.field).toBe(f.field);
    expect(RECIPIENT_ROUTES[f.iface]!.reason.length).toBeGreaterThan(40);
  }

  // Negative control: the scanner must NAME a newly added interface, so an
  // implementation that always returns [] fails here instead of passing.
  // Both a SINGULAR and a PLURAL carrier: the plural half is what the first
  // draft of this scanner missed on the real source, so asserting the fix here
  // is what makes it proven rather than claimed.
  //
  // PROOF BURDEN, do not trim this block. The plural guarantee rests ENTIRELY
  // on it: measured, reverting the alternation to singular does NOT redden the
  // real-source half of this test -- the two plural carriers simply vanish from
  // `found`, so the unclassified filter stays empty and the consistency loop
  // still passes. Only the toEqual below falls. Lighten this synthetic control
  // and the singular regression becomes invisible again.
  const synthetic = [
    "export interface SupervisorDispatchRequest {",
    "  from_token: InstanceToken;",
    "  target_peer_id: PeerId;",
    "  text: string;",
    "}",
    "export interface SupervisorFanoutRequest {",
    "  to_peer_ids: PeerId[];",
    "  text: string;",
    "}",
  ].join("\n");
  expect(findRecipientCarryingInterfaces(synthetic)).toEqual([
    { iface: "SupervisorDispatchRequest", field: "target_peer_id" },
    { iface: "SupervisorFanoutRequest", field: "to_peer_ids" },
  ]);
  expect(RECIPIENT_ROUTES["SupervisorDispatchRequest"]).toBeUndefined();
  expect(RECIPIENT_ROUTES["SupervisorFanoutRequest"]).toBeUndefined();
});

test("coverage: the two exemptions hold live -- neither route reaches the inbox", async () => {
  const g = { id: await groupId("op-cov"), hash: await sha256Hex("op-cov") };
  await register("hOpC1", "/opC1", g);

  const inboxRows = (group: string): number => {
    const db = new Database(broker.dbPath, { readonly: true });
    try {
      return (
        db.query(
          "SELECT COUNT(*) AS n FROM messages WHERE to_token = ? AND group_id = ?"
        ).get(OPERATOR_INSTANCE_TOKEN, group) as { n: number }
      ).n;
    } finally {
      db.close();
    }
  };
  const before = inboxRows(g.id);

  // /announce: the targeted path resolves an ACTIVE peer and the sentinel is
  // dormant, so 'operator' is a 404 rather than a deposit.
  const announced = await post<{ error?: string }>(`${broker.url}/announce`, {
    group_id: g.id,
    group_secret_hash: g.hash,
    text: "routed through the announce path",
    to_peer_id: "operator",
  });
  expect(announced.status).toBe(404);

  // Positive control: the SAME call to a real active peer works, so the 404
  // above comes from the sentinel and not from a broken announce.
  const live = await post<{ sent: number }>(`${broker.url}/announce`, {
    group_id: g.id,
    group_secret_hash: g.hash,
    text: "this one lands",
    to_peer_id: (await register("hOpC2", "/opC2", g)).body.peer_id,
  });
  expect(live.status).toBe(200);
  expect(live.body.sent).toBe(1);

  // /approval/add: reply_peer_id='operator' downgrades to the pty route instead
  // of pinning the sentinel as the answer's destination.
  const cred: ApprovalCredential = generateCredential();
  const operatorId = deriveOperatorId(cred.publicKey);
  const addBody = {
    kind: "question",
    title: "coverage probe",
    question: "does reply_peer_id reach the sentinel?",
    origin: { host: "test-host", project_key: "p", group_id: g.id },
    // Card 1def56da: an OPERATOR credential declares its project TOP LEVEL.
    // `origin.project_key` above is now descriptive only, since the broker
    // stopped reading the dimension the caller is filtered on from a field the
    // caller supplies. In the object before buildAuthProof, or the proof and
    // the body disagree and the 200 asserted below becomes a 401.
    project_key: "p",
    reply_route: "channel",
    reply_peer_id: "operator",
    public_key: cred.publicKey,
  };
  const auth = buildAuthProof(cred.privateKey, addBody, { kind: "operator", operator_id: operatorId });
  const raised = await post<{ approval: Approval }>(`${broker.url}/approval/add`, { ...addBody, auth });
  expect(raised.status).toBe(200);
  expect(raised.body.approval.reply_route).toBe("pty");

  expect(inboxRows(g.id)).toBe(before);
});

test("coverage: both exemptions lean on dormant sentinel rows -- pinned here", async () => {
  // If a sentinel row ever became 'active', /announce and /approval/add would
  // resolve it and BOTH exemptions above would silently become wrong. Asserted
  // once here rather than restated inside each reason.
  //
  // Review MINOR-3: iterate SENTINEL_DEFINITIONS instead of naming the two
  // tokens and pinning `length === 2`. A third sentinel added to that array is
  // covered here automatically, which is the whole point of the array existing
  // (shared/types.ts) and the coverage question card 37a2b8c7 asks by name.
  const readStatus = (db: Database, token: string): { peer_id: string; status: string } | null =>
    db.query("SELECT peer_id, status FROM peers WHERE instance_token = ?").get(token) as
      | { peer_id: string; status: string }
      | null;

  const db = new Database(broker.dbPath, { readonly: true });
  try {
    expect(SENTINEL_DEFINITIONS.length).toBeGreaterThan(0);
    for (const sentinel of SENTINEL_DEFINITIONS) {
      const row = readStatus(db, sentinel.instanceToken);
      expect(row).not.toBeNull();
      expect(row!.peer_id).toBe(sentinel.peerId);
      expect(row!.status).toBe("dormant");
    }
  } finally {
    db.close();
  }

  // NEGATIVE CONTROL. Adding a third entry to SENTINEL_DEFINITIONS canNOT make
  // the loop above red -- measured: the broker's seed derives from that same
  // array, so a new entry arrives already seeded and dormant. The guarantee
  // holds by derivation on BOTH sides, which is why the falsification has to
  // attack the PROPERTY instead: flip one sentinel to 'active' and prove the
  // assertion observes it, rather than passing against a constant.
  const rw = new Database(broker.dbPath);
  const probe = SENTINEL_DEFINITIONS[0]!;
  try {
    rw.query("UPDATE peers SET status = 'active' WHERE instance_token = ?").run(probe.instanceToken);
    expect(readStatus(rw, probe.instanceToken)!.status).toBe("active");
  } finally {
    rw.query("UPDATE peers SET status = 'dormant' WHERE instance_token = ?").run(
      probe.instanceToken
    );
    expect(readStatus(rw, probe.instanceToken)!.status).toBe("dormant");
    rw.close();
  }
});

// --- Courrier lot 1A: non-destructive cursor read (card 54b1c71a) -----------

test("lot 1A: two sessions on the same group each see everything; neither consumes for the other", async () => {
  const g = { id: await groupId("op-lot1a-two"), hash: await sha256Hex("op-lot1a-two") };
  const a = await register("hLot1aP", "/lot1aP", g);

  // Both sessions register BEFORE any message is sent, so both seed their
  // cursor at last_id=0 (the box is empty at registration time) -- this is
  // what lets them later see the SAME two messages independently.
  const firstA = await drainAs(g, "sess-A");
  expect(firstA.status).toBe(200);
  expect((firstA.body as { messages: unknown[] }).messages.length).toBe(0);
  const firstB = await drainAs(g, "sess-B");
  expect((firstB.body as { messages: unknown[] }).messages.length).toBe(0);

  await sendToOperator(a.body.instance_token, "msg 1");
  await sendToOperator(a.body.instance_token, "msg 2");

  const readA = await drainAs(g, "sess-A");
  const messagesA = (readA.body as { messages: { text: string }[] }).messages;
  expect(messagesA.map((m) => m.text)).toEqual(["msg 1", "msg 2"]);

  const readB = await drainAs(g, "sess-B");
  const messagesB = (readB.body as { messages: { text: string }[] }).messages;
  expect(messagesB.map((m) => m.text)).toEqual(["msg 1", "msg 2"]);

  // A's drain did not consume for B's, and vice-versa: each session's own
  // cursor governs its own view. A second drain of EACH is empty, because it
  // has now seen everything ITSELF, not because the other session ate it.
  const secondA = await drainAs(g, "sess-A");
  expect((secondA.body as { messages: unknown[] }).messages.length).toBe(0);
  const secondB = await drainAs(g, "sess-B");
  expect((secondB.body as { messages: unknown[] }).messages.length).toBe(0);
});

test("lot 1A: session_id absent is byte-identical to legacy -- no operator_inbox_sessions row is written", async () => {
  const g = { id: await groupId("op-lot1a-legacy"), hash: await sha256Hex("op-lot1a-legacy") };
  const a = await register("hLot1aL", "/lot1aL", g);
  await sendToOperator(a.body.instance_token, "legacy path");

  const legacy = await drain(g); // no session_id in the body
  expect((legacy.body as { messages: { text: string }[] }).messages.map((m) => m.text)).toEqual([
    "legacy path",
  ]);

  const db = new Database(broker.dbPath, { readonly: true });
  try {
    const rows = db.query(
      "SELECT session_id FROM operator_inbox_sessions WHERE group_id = ?"
    ).all(g.id) as { session_id: string }[];
    expect(rows.length).toBe(0);
  } finally {
    db.close();
  }
});

test("lot 1A: a session_id reaped by the purge GC re-seeds as brand-new (no replay, no error)", async () => {
  const g = { id: await groupId("op-lot1a-reap"), hash: await sha256Hex("op-lot1a-reap") };
  const a = await register("hLot1aR", "/lot1aR", g);

  await drainAs(g, "sess-stale"); // registers, cursor = 0
  await sendToOperator(a.body.instance_token, "sent before the reap");
  const beforeReap = await drainAs(g, "sess-stale");
  expect((beforeReap.body as { messages: { text: string }[] }).messages.map((m) => m.text)).toEqual([
    "sent before the reap",
  ]);

  // Force sess-stale to look dead to the GC without waiting on the real TTL.
  // '-2 days' (not '-1 day'): the TTL default is now 24h (card 1e81ee7b TTL
  // arbitrage), so a '-1 day' offset landed within a second of the cutoff --
  // datetime()'s 1-second resolution then made this flaky against the very
  // TTL it exercises. Two days keeps a comfortable margin either side.
  const rw = new Database(broker.dbPath);
  try {
    rw.query(
      "UPDATE operator_inbox_sessions SET last_seen_at = datetime('now', '-2 days') WHERE session_id = ? AND group_id = ?"
    ).run("sess-stale", g.id);
  } finally {
    rw.close();
  }

  // Any 'session'-scope purge call runs the GC step first. Use a fresh
  // session_id ('sess-fresh') as the caller so sess-stale's reap is what this
  // test observes, not a self-purge side effect.
  await drainAs(g, "sess-fresh"); // must exist to be a valid purge caller
  await purge(g, "sess-fresh", "session");

  const afterReap = new Database(broker.dbPath, { readonly: true });
  try {
    // AND group_id = ?: the exact "SELECT keyed on too few" trap this
    // convention warns about, in the test meant to prove it (card 1e81ee7b).
    const row = afterReap.query(
      "SELECT session_id FROM operator_inbox_sessions WHERE session_id = ? AND group_id = ?"
    ).get("sess-stale", g.id);
    expect(row).toBeNull();
  } finally {
    afterReap.close();
  }

  // sess-stale re-registers as brand-new: its cursor re-seeds at the box's
  // CURRENT MAX(id) (which already includes "sent before the reap"), so this
  // first call back must NOT replay it -- proving no-replay, not merely
  // absence of an error.
  const rereg = await drainAs(g, "sess-stale");
  expect((rereg.body as { messages: unknown[] }).messages.length).toBe(0);

  // A message sent AFTER the re-registration is, however, seen normally --
  // the reap did not leave the session permanently blind.
  await sendToOperator(a.body.instance_token, "sent after the reap");
  const followUp = await drainAs(g, "sess-stale");
  expect((followUp.body as { messages: { text: string }[] }).messages.map((m) => m.text)).toEqual([
    "sent after the reap",
  ]);
});

// --- Courrier lot 1C: purge (card 1e81ee7b broker half) ---------------------

test("lot 1C purge scope=session: bounded by the slowest LIVE session, even when the caller has read everything", async () => {
  const g = { id: await groupId("op-lot1c-floor"), hash: await sha256Hex("op-lot1c-floor") };
  const a = await register("hLot1cF", "/lot1cF", g);

  // Both sessions register while the box is empty (cursor = 0 for both).
  await drainAs(g, "sess-fast");
  await drainAs(g, "sess-slow");

  await sendToOperator(a.body.instance_token, "m1");
  await sendToOperator(a.body.instance_token, "m2");
  await sendToOperator(a.body.instance_token, "m3");

  // sess-fast reads everything (cursor -> id of m3). sess-slow never drains
  // again, so it stays live (last_seen_at from its registration) but its
  // cursor stays at 0 -- the "second live session with a lower last_id"
  // the acceptance criterion names.
  const fastRead = await drainAs(g, "sess-fast");
  expect((fastRead.body as { messages: unknown[] }).messages.length).toBe(3);

  const countRows = (): number => {
    const db = new Database(broker.dbPath, { readonly: true });
    try {
      return (
        db.query(
          "SELECT COUNT(*) AS n FROM messages WHERE to_token = ? AND group_id = ?"
        ).get(OPERATOR_INSTANCE_TOKEN, g.id) as { n: number }
      ).n;
    } finally {
      db.close();
    }
  };
  expect(countRows()).toBe(3);

  // Purge as sess-fast: even though sess-fast has read all 3, sess-slow (still
  // live, cursor=0) caps the floor at 0 -- nothing may be deleted yet.
  const boundedPurge = await purge(g, "sess-fast", "session");
  expect(boundedPurge.status).toBe(200);
  expect((boundedPurge.body as { deleted: number }).deleted).toBe(0);
  expect(countRows()).toBe(3);

  // Once sess-slow also catches up, the floor advances and the purge deletes.
  const slowRead = await drainAs(g, "sess-slow");
  expect((slowRead.body as { messages: unknown[] }).messages.length).toBe(3);

  const realPurge = await purge(g, "sess-fast", "session");
  expect((realPurge.body as { deleted: number }).deleted).toBe(3);
  expect(countRows()).toBe(0);
});

test("lot 1C purge scope=ids: deletes only the named ids, and only within the caller's own group", async () => {
  const gA = { id: await groupId("op-lot1c-idsA"), hash: await sha256Hex("op-lot1c-idsA") };
  const gB = { id: await groupId("op-lot1c-idsB"), hash: await sha256Hex("op-lot1c-idsB") };
  const a = await register("hLot1cIA", "/lot1cIA", gA);
  const b = await register("hLot1cIB", "/lot1cIB", gB);

  await sendToOperator(a.body.instance_token, "group A message");
  await sendToOperator(b.body.instance_token, "group B message");

  const db = new Database(broker.dbPath, { readonly: true });
  let idA: number, idB: number;
  try {
    idA = (
      db.query("SELECT id FROM messages WHERE group_id = ?").get(gA.id) as { id: number }
    ).id;
    idB = (
      db.query("SELECT id FROM messages WHERE group_id = ?").get(gB.id) as { id: number }
    ).id;
  } finally {
    db.close();
  }

  // A session in group A must exist as a valid caller, but scope='ids' does
  // not use its cursor at all.
  await drainAs(gA, "sess-ids-A");

  // Naming group B's id while purging group A: must not cross the boundary.
  const crossGroup = await purge(gA, "sess-ids-A", "ids", [idB]);
  expect((crossGroup.body as { deleted: number }).deleted).toBe(0);

  const stillThere = new Database(broker.dbPath, { readonly: true });
  try {
    expect(
      (stillThere.query("SELECT COUNT(*) AS n FROM messages WHERE id = ?").get(idB) as { n: number }).n
    ).toBe(1);
  } finally {
    stillThere.close();
  }

  // The correctly-scoped id does get deleted.
  const inGroup = await purge(gA, "sess-ids-A", "ids", [idA]);
  expect((inGroup.body as { deleted: number }).deleted).toBe(1);

  const gone = new Database(broker.dbPath, { readonly: true });
  try {
    expect(
      (gone.query("SELECT COUNT(*) AS n FROM messages WHERE id = ?").get(idA) as { n: number }).n
    ).toBe(0);
  } finally {
    gone.close();
  }
});

test("lot 1C purge: same guard order as the drain -- 'default' refused 403, wrong secret refused 401", async () => {
  const defaultPurge = await purge({ id: "default", hash: null }, "any-session", "session");
  expect(defaultPurge.status).toBe(403);
  expect((defaultPurge.body as { error: string }).error).toContain("default");

  const g = { id: await groupId("op-lot1c-guard"), hash: await sha256Hex("op-lot1c-guard") };
  await register("hLot1cG", "/lot1cG", g);
  await drainAs(g, "sess-guard");

  const wrongSecret = await purge(
    { id: g.id, hash: await sha256Hex("wrong") },
    "sess-guard",
    "session"
  );
  expect(wrongSecret.status).toBe(401);
});

test("lot 1C purge: session_id is required (empty/absent -> 400, not a silent no-op)", async () => {
  const g = { id: await groupId("op-lot1c-noid"), hash: await sha256Hex("op-lot1c-noid") };
  await register("hLot1cN", "/lot1cN", g);

  const missing = await post<{ error?: string }>(`${broker.url}/operator-inbox/purge`, {
    group_id: g.id,
    group_secret_hash: g.hash,
    scope: "session",
  });
  expect(missing.status).toBe(400);

  const empty = await purge(g, "", "session");
  expect(empty.status).toBe(400);
});

// --- Card 1e81ee7b security review: BLOCKER 1/2, MAJOR 1-5, MINOR ----------

test("purge BLOCKER 1: a group-A caller cannot hijack group-B's cursor by naming B's session_id", async () => {
  const gA = { id: await groupId("op-blocker1-A"), hash: await sha256Hex("op-blocker1-A") };
  const gB = { id: await groupId("op-blocker1-B"), hash: await sha256Hex("op-blocker1-B") };
  const a = await register("hB1A", "/b1A", gA);
  const b = await register("hB1B", "/b1B", gB);

  // B's Deck attaches FIRST (cursor = 0, box empty for B at that point).
  await drainAs(gB, "victim-sess");

  // B's own unread message, THEN group A's -- sent AFTER, so their ids land
  // ABOVE B's still-pending one. That ordering is the entire mechanism:
  // messages.id is a GLOBAL autoincrement, so bumping "victim-sess" to
  // group A's MAX(id) jumps past B's pending id too, even though the
  // attacker only ever proved knowledge of group A's own secret.
  await sendToOperator(b.body.instance_token, "B's actual unread mail");
  await sendToOperator(a.body.instance_token, "A message 1");
  await sendToOperator(a.body.instance_token, "A message 2");

  // Authenticated as group A throughout; "victim-sess" belongs to group B.
  await purge(gA, "victim-sess", "session");

  // Decisive: B's Deck must still see its own unread mail after the attack.
  const victimDrain = await drainAs(gB, "victim-sess");
  expect(
    (victimDrain.body as { messages: { text: string }[] }).messages.map((m) => m.text)
  ).toEqual(["B's actual unread mail"]);
});

test("purge BLOCKER 2: an unauthenticated caller on a never-registered group cannot GC another group's live session", async () => {
  // Cell 2 (card 1e81ee7b security review): a bare '-2 days' staleness
  // literal is a premise this test does not own -- measured, at a broker
  // configured with a 7-day TTL, that exact offset makes the row survive
  // VACUOUSLY (never even GC-eligible) even against a scratch copy with
  // BOTH the GC group_id filter and the groupExists gate this test exists
  // to prove removed. So this test mints its OWN short-TTL broker and ages
  // the victim well past THAT TTL (5x), regardless of whatever TTL the
  // shared file-level broker or any future production default happens to
  // run with.
  const shortTtlMin = "2";
  const cellBroker = await startBroker({
    CLAUDE_PEERS_OPERATOR_INBOX_SESSION_TTL_MIN: shortTtlMin,
  });
  try {
    const g = { id: await groupId("op-blocker2-victim"), hash: await sha256Hex("op-blocker2-victim") };
    await register("hB2V", "/b2V", g, cellBroker);
    await drainAs(g, "victim-sess", cellBroker);

    // 5x shortTtlMin: comfortably past the TTL this test itself configured.
    const rw = new Database(cellBroker.dbPath);
    try {
      rw.query(
        "UPDATE operator_inbox_sessions SET last_seen_at = datetime('now', '-10 minutes') WHERE session_id = ? AND group_id = ?"
      ).run("victim-sess", g.id);
    } finally {
      rw.close();
    }

    // A group NEVER put through /register: no secret pinned, no row in
    // `groups`. checkGroupSecret accepts it (TOFU accepts the unknown), so
    // this is reachable with only the shared BROKER_TOKEN and zero knowledge
    // of any real group's secret.
    const ghostGroupId = await groupId("op-blocker2-ghost-never-registered");
    const ghost = await purge({ id: ghostGroupId, hash: null }, "any-session", "session", undefined, cellBroker);
    expect(ghost.status).toBe(403);

    const row = new Database(cellBroker.dbPath, { readonly: true });
    try {
      const found = row.query(
        "SELECT session_id FROM operator_inbox_sessions WHERE session_id = ? AND group_id = ?"
      ).get("victim-sess", g.id);
      expect(found).not.toBeNull();
    } finally {
      row.close();
    }
  } finally {
    await stopBroker(cellBroker);
  }
  // 30_000, not the bun default of 5_000: this is the ONLY test in this file
  // that starts a broker inside its own body (every other one reuses the
  // beforeAll broker), so it pays a full spawn on top of its HTTP work. On the
  // windows-latest runner it timed out at 5_001 ms, and bun's reaction to a
  // timeout is to kill the dangling children -- "killed 2 dangling processes",
  // i.e. this cell broker AND the beforeAll broker -- so the six tests after it
  // died on ConnectionRefused against a dead shared port (measured 2026-08-28,
  // CI run 33170636054, windows job 98846649311). Budget taken from the slowest
  // broker-spawning test observed on that same runner, ntfy's "one operator
  // disconnecting does not cut the other" at 11_511 ms: ~2.6x margin, and
  // inside the 20_000..60_000 band the neighbouring broker-spawning files
  // already use (broker-register-role 20_000, broker-ntfy-channel 60_000).
}, 30_000);

test("cursor drain marks delivered too (MAJOR 2): the TTL sweep must not treat cursor-read mail as still pending", async () => {
  const g = { id: await groupId("op-major2"), hash: await sha256Hex("op-major2") };
  const a = await register("hMajor2", "/major2", g);

  await drainAs(g, "sess-m2");
  await sendToOperator(a.body.instance_token, "cursor-read message");
  const drained = await drainAs(g, "sess-m2");
  expect((drained.body as { messages: { text: string }[] }).messages.map((m) => m.text)).toEqual([
    "cursor-read message",
  ]);

  const db = new Database(broker.dbPath, { readonly: true });
  try {
    const row = db.query(
      "SELECT delivered FROM messages WHERE to_token = ? AND group_id = ?"
    ).get(OPERATOR_INSTANCE_TOKEN, g.id) as { delivered: number };
    expect(row.delivered).toBe(1);
  } finally {
    db.close();
  }
});

test("purge scope=session (MAJOR 3): the GC reap raises the floor within the SAME purge call", async () => {
  const g = { id: await groupId("op-major3"), hash: await sha256Hex("op-major3") };
  const a = await register("hMajor3", "/major3", g);

  // Dead session: registers (cursor = 0, box empty) and never drains again --
  // its last_id stays at 0 while a message is later sent and read by the
  // live session below.
  await drainAs(g, "sess-dead");

  // Live session: drains everything, so its last_id tracks MAX(id).
  await drainAs(g, "sess-live");
  await sendToOperator(a.body.instance_token, "m1");
  await drainAs(g, "sess-live");

  // Age sess-dead past the GC TTL.
  const rw = new Database(broker.dbPath);
  try {
    rw.query(
      "UPDATE operator_inbox_sessions SET last_seen_at = datetime('now', '-2 days') WHERE session_id = ? AND group_id = ?"
    ).run("sess-dead", g.id);
  } finally {
    rw.close();
  }

  // If the GC ran AFTER the floor was computed, sess-dead's last_id=0 would
  // still pin the floor at 0 and this purge would delete nothing, forever.
  const result = await purge(g, "sess-live", "session");
  expect((result.body as { deleted: number }).deleted).toBeGreaterThan(0);
});

test("drain MAJOR 4: a non-string session_id is refused, never silently falls back to the destructive legacy drain", async () => {
  const g = { id: await groupId("op-major4"), hash: await sha256Hex("op-major4") };
  await register("hMajor4", "/major4", g);

  const numeric = await post<{ error?: string }>(`${broker.url}/operator-inbox`, {
    group_id: g.id,
    group_secret_hash: g.hash,
    session_id: 42,
  });
  expect(numeric.status).toBe(400);

  // Absent stays legacy (retro-compat, unaffected by this fix).
  const legacy = await drain(g);
  expect(legacy.status).toBe(200);
});

test("drain MAJOR 5 / part 4: a never-registered group creates no operator_inbox_sessions row", async () => {
  const countSessions = (): number => {
    const db = new Database(broker.dbPath, { readonly: true });
    try {
      return (
        db.query("SELECT COUNT(*) AS n FROM operator_inbox_sessions").get() as { n: number }
      ).n;
    } finally {
      db.close();
    }
  };
  const before = countSessions();

  const ghostGroupId = await groupId("op-major5-ghost-never-registered");
  const result = await drainAs({ id: ghostGroupId, hash: null }, "ghost-sess");
  expect(result.status).toBe(403);

  // Decisive: row count unchanged, not just the HTTP status.
  expect(countSessions()).toBe(before);
});

test("purge MINOR: non-integer ids are refused rather than silently deleting nothing", async () => {
  const g = { id: await groupId("op-minor-ids"), hash: await sha256Hex("op-minor-ids") };
  await register("hMinorIds", "/minorIds", g);
  await drainAs(g, "sess-minor");

  const stringified = await purge(g, "sess-minor", "ids", ["1" as unknown as number]);
  expect(stringified.status).toBe(400);

  const float = await purge(g, "sess-minor", "ids", [1.5]);
  expect(float.status).toBe(400);

  // An explicitly empty list stays a legitimate no-op.
  const empty = await purge(g, "sess-minor", "ids", []);
  expect(empty.status).toBe(200);
  expect((empty.body as { deleted: number }).deleted).toBe(0);
});

test("cursor session_id is scoped per group (MAJOR 1, composite PK): the same session_id under two groups does not alias", async () => {
  // Card 1e81ee7b Cell 1: the composite PRIMARY KEY (session_id, group_id)
  // was previously only exercised by an ACCIDENTAL session_id collision
  // between two unrelated fixtures across two separate tests, in full-suite
  // order only -- a property named for something else entirely (purge
  // BLOCKER 2), invisible in isolation. This test pins it directly: ONE
  // session_id, TWO groups, in ONE test body.
  const gA = { id: await groupId("op-major1-A"), hash: await sha256Hex("op-major1-A") };
  const gB = { id: await groupId("op-major1-B"), hash: await sha256Hex("op-major1-B") };
  const a = await register("hMajor1A", "/major1A", gA);
  const b = await register("hMajor1B", "/major1B", gB);

  const SESSION = "shared-session-id";

  // Registration seeds a session's cursor at the box's CURRENT MAX(id) (see
  // "lot 1A" tests above): a message sent BEFORE a group's first drain is
  // invisible to it -- by design, a fresh session only watches forward.
  const premierA = await drainAs(gA, SESSION);
  await sendToOperator(a.body.instance_token, "A msg");
  await sendToOperator(b.body.instance_token, "B msg");
  // "B msg" already exists when B registers here, so B's cursor seeds past
  // it -- under the CORRECT composite-PK code this is a clean, unrelated
  // row; under a session_id-only PK, B's registration instead CONFLICTS
  // with A's existing row, and the ON CONFLICT clause updates last_seen_at
  // only, never group_id -- so the row stays permanently pinned to group A.
  const premierB = await drainAs(gB, SESSION);
  const secondA = await drainAs(gA, SESSION);
  // DECISIVE: under the mutation, B's own SELECT (scoped by group_id) never
  // finds the aliased row, so its cursor silently resets to 0 on every call
  // -- "B msg" would replay here, and on every subsequent poll, forever.
  const secondB = await drainAs(gB, SESSION);

  const textsOf = (r: { body: unknown }) =>
    (r.body as { messages: { text: string }[] }).messages.map((m) => m.text);

  expect(textsOf(premierA)).toEqual([]);
  expect(textsOf(premierB)).toEqual([]);
  expect(textsOf(secondA)).toEqual(["A msg"]);
  expect(textsOf(secondB)).toEqual([]);

  const db = new Database(broker.dbPath, { readonly: true });
  try {
    const rowCount = (
      db.query("SELECT COUNT(*) AS n FROM operator_inbox_sessions WHERE session_id = ?").get(SESSION) as {
        n: number;
      }
    ).n;
    // Two distinct rows, one per group -- not one row aliased between them.
    expect(rowCount).toBe(2);
  } finally {
    db.close();
  }
});
