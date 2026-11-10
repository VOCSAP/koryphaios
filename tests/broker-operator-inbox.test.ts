// PLAN C12: operator inbox. Agents send_message to the reserved 'operator'
// peer; the Deck drains POST /operator-inbox per group (TOFU-authenticated,
// marks delivered). The sentinel row must never surface as a normal peer.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import {
  FIXTURE_OPERATOR,
  FIXTURE_OPERATOR_ID,
  startBroker,
  stopBroker,
  post,
  get,
  livePid,
  groupId,
  sha256Hex,
  type TestBroker,
  openBrokerDb,
} from "./_helper.ts";
import { buildAuthProof, buildInboxProof, deriveInstanceRef, INBOX_GATES, type ApprovalCredential } from "../shared/approval.ts";
import {
  depositToOperator,
  mintRunCredential,
  operatorInboxProof,
  registerAttestedInstance,
  runInboxCall,
  runInboxProof,
  mintMandate,
  closeInbox,
  listInbox,
  replyInbox,
  INBOX_TEST_PROJECT,
  type RunCredential,
} from "./_helper.ts";
// The sentinel token is imported rather than re-typed, so seed and assertion
// cannot silently agree with each other while testing an unrelated row.
import { DECK_INSTANCE_TOKEN, OPERATOR_INSTANCE_TOKEN, SENTINEL_DEFINITIONS, type Approval } from "../shared/types.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDeckControl, type DeckControlDeps } from "../desktop/src/main/deck-control.ts";
import { createInboxActions } from "../desktop/src/main/inbox-actions.ts";
import { handleInboxClose, handleInboxList, type OperatorToolContext } from "../shared/peers-session.ts";
import type { CompanionIdentity } from "../shared/roadmap-dispatch.ts";
import { reachedWithin } from "./_bounded-await.ts";

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

async function insertLegacyOperatorMessage(fromToken: string, text: string, b: TestBroker = broker): Promise<void> {
  const db = openBrokerDb(b.dbPath);
  try {
    const peer = db.query("SELECT group_id FROM peers WHERE instance_token = ?").get(fromToken) as { group_id: string } | null;
    if (!peer) throw new Error("insertLegacyOperatorMessage: unknown sender");
    db.run(
      "INSERT INTO messages (from_token, to_token, group_id, text, sent_at, delivered) VALUES (?, ?, ?, ?, ?, 0)",
      [fromToken, OPERATOR_INSTANCE_TOKEN, peer.group_id, text, new Date().toISOString()]
    );
  } finally {
    db.close();
  }
}

async function postToOperator(fromToken: string, text: string, b: TestBroker = broker) {
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

test("a legacy operator message lands in the group inbox; the legacy drain marks it delivered", async () => {
  const g = { id: await groupId("op-A"), hash: await sha256Hex("op-A") };
  const a = await register("hOp1", "/opA1", g);

  await insertLegacyOperatorMessage(a.body.instance_token, "review is done, merge?");

  const first = await drain(g);
  expect(first.status).toBe(200);
  const messages = (first.body as { messages: { from_peer_id: string; text: string }[] }).messages;
  expect(messages.length).toBe(1);
  expect(messages[0]!.from_peer_id).toBe(a.body.peer_id);
  expect(messages[0]!.text).toBe("review is done, merge?");

  // Drained once -> delivered; a second drain is empty.
  const second = await drain(g);
  expect((second.body as { messages: unknown[] }).messages.length).toBe(0);

  const db = openBrokerDb(broker.dbPath, { readonly: true });
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

  await insertLegacyOperatorMessage(a.body.instance_token, "only group A sees this");

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

  const sent = await postToOperator(a.body.instance_token, "nobody will ever drain this");
  expect(sent.status).toBe(200);
  const body = sent.body as { ok: boolean; error?: string };
  expect(body.ok).toBe(false);
  expect(body.error ?? "").toContain("default");

  // The refusal must be a refusal to STORE, not a silent accept: nothing landed.
  const db = openBrokerDb(broker.dbPath, { readonly: true });
  try {
    const rows = db.query(
      "SELECT id FROM messages WHERE to_token = ? AND group_id = 'default'"
    ).all(OPERATOR_INSTANCE_TOKEN) as { id: number }[];
    expect(rows.length).toBe(0);
  } finally {
    db.close();
  }

  // Negative control on the probe itself: an attested send in a secret-pinned
  // group still succeeds, so `ok:false` above comes from the group, not from a
  // send path broken for everyone.
  const { runs } = await newRuns("op-dep-ok");
  const b = await registerAttestedInstance(broker, runs[0]!, "hOpD2", "/opD2");
  const okSend = await depositToOperator(broker, b.body.instance_token, "this one is drainable", runs[0]!);
  expect(okSend.body.ok).toBe(true);
});

test("volet 1 drain: /operator-inbox on 'default' is refused with 403 and consumes nothing", async () => {
  // The deposit guard makes the inbox of 'default' unreachable through the API,
  // so seed it directly: without a pending row this probe would pass GREEN even
  // with the guard removed (an empty drain returns 200 + zero messages, and the
  // assertion on 403 would be the only thing failing -- but the "consumes
  // nothing" half would be vacuous). The seed is what makes the drain have
  // something to steal.
  const a = await register("hOpX1", "/opX1"); // 'default'
  const seed = openBrokerDb(broker.dbPath);
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
  const db = openBrokerDb(broker.dbPath, { readonly: true });
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

// The domain is discovered from the request interfaces rather than pinned as a
// handler list or a count, so a route added later that resolves a
// client-supplied recipient must be explicitly classified here or the scan
// fails.

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
  FederationSendRequest: {
    field: "to_peer_id",
    route: "/federation/send",
    verdict: "guarded",
    reason:
      "A replica relaying one of its peers: to_peer_id === 'operator' is refused 400 before any lookup (the operator inbox never crosses the federation boundary), and every other target then goes through handleSendMessage with the relayed row's internal token, so the /send-message guard above applies unchanged. Proven by the federation route tests.",
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
 * Discovers every exported interface with a client-supplied recipient field by
 * name, not by handler or an "...Request" suffix, so an oddly-named body type
 * cannot silently leave the domain.
 * Reads the data contract only: a handler parsing a recipient straight out of
 * an untyped Record body is invisible to it, and the domain is nominal -- a
 * destination field under an unrecognized name also escapes it.
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
    const db = openBrokerDb(broker.dbPath, { readonly: true });
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
  const cred: ApprovalCredential = FIXTURE_OPERATOR;
  const operatorId = FIXTURE_OPERATOR_ID;
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

  const db = openBrokerDb(broker.dbPath, { readonly: true });
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
  const rw = openBrokerDb(broker.dbPath);
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

  await insertLegacyOperatorMessage(a.body.instance_token, "msg 1");
  await insertLegacyOperatorMessage(a.body.instance_token, "msg 2");

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
  await insertLegacyOperatorMessage(a.body.instance_token, "legacy path");

  const legacy = await drain(g); // no session_id in the body
  expect((legacy.body as { messages: { text: string }[] }).messages.map((m) => m.text)).toEqual([
    "legacy path",
  ]);

  const db = openBrokerDb(broker.dbPath, { readonly: true });
  try {
    const rows = db.query(
      "SELECT session_id FROM operator_inbox_sessions WHERE group_id = ?"
    ).all(g.id) as { session_id: string }[];
    expect(rows.length).toBe(0);
  } finally {
    db.close();
  }
});

test("a legacy cursor older than its TTL, stored as an ISO timestamp, is collected and no longer holds the purge floor", async () => {
  const cellBroker = await startBroker({ CLAUDE_PEERS_OPERATOR_INBOX_SESSION_TTL_MIN: "2" });
  try {
    const g = { id: await groupId("op-legacy-cursor-gc"), hash: await sha256Hex("op-legacy-cursor-gc") };
    const a = await register("hLegacyCursorGc", "/legacycursorgc", g, cellBroker);
    await drainAs(g, "dead-cursor", cellBroker);
    await insertLegacyOperatorMessage(a.body.instance_token, "behind a dead cursor", cellBroker);

    const staleSeen = new Date(Date.now() - 5 * 60_000).toISOString();
    const db = openBrokerDb(cellBroker.dbPath);
    db.run(
      "UPDATE operator_inbox_sessions SET last_seen_at = ? WHERE session_id = ? AND group_id = ?",
      [staleSeen, "dead-cursor", g.id]
    );
    db.close();

    await drainAs(g, "live-cursor", cellBroker);
    expect(
      (await purge(g, "live-cursor", "session", undefined, cellBroker)).body,
      "the dead cursor at 0 no longer pins the floor"
    ).toEqual({ deleted: 1 });
    const check = openBrokerDb(cellBroker.dbPath, { readonly: true });
    try {
      expect(
        check
          .query("SELECT session_id FROM operator_inbox_sessions WHERE group_id = ? ORDER BY session_id")
          .all(g.id)
      ).toEqual([{ session_id: "live-cursor" }]);
    } finally {
      check.close();
    }
  } finally {
    await stopBroker(cellBroker);
  }
}, 30_000);

test("lot 1A: a session_id reaped by the purge GC re-seeds as brand-new (no replay, no error)", async () => {
  const g = { id: await groupId("op-lot1a-reap"), hash: await sha256Hex("op-lot1a-reap") };
  const a = await register("hLot1aR", "/lot1aR", g);

  await drainAs(g, "sess-stale"); // registers, cursor = 0
  await insertLegacyOperatorMessage(a.body.instance_token, "sent before the reap");
  const beforeReap = await drainAs(g, "sess-stale");
  expect((beforeReap.body as { messages: { text: string }[] }).messages.map((m) => m.text)).toEqual([
    "sent before the reap",
  ]);

  // Force sess-stale to look dead to the GC without waiting on the real TTL.
  // '-2 days' (not '-1 day'): the TTL default is now 24h (card 1e81ee7b TTL
  // arbitrage), so a '-1 day' offset landed within a second of the cutoff --
  // datetime()'s 1-second resolution then made this flaky against the very
  // TTL it exercises. Two days keeps a comfortable margin either side.
  const rw = openBrokerDb(broker.dbPath);
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

  const afterReap = openBrokerDb(broker.dbPath, { readonly: true });
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
  await insertLegacyOperatorMessage(a.body.instance_token, "sent after the reap");
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

  await insertLegacyOperatorMessage(a.body.instance_token, "m1");
  await insertLegacyOperatorMessage(a.body.instance_token, "m2");
  await insertLegacyOperatorMessage(a.body.instance_token, "m3");

  // sess-fast reads everything (cursor -> id of m3). sess-slow never drains
  // again, so it stays live (last_seen_at from its registration) but its
  // cursor stays at 0 -- the "second live session with a lower last_id"
  // the acceptance criterion names.
  const fastRead = await drainAs(g, "sess-fast");
  expect((fastRead.body as { messages: unknown[] }).messages.length).toBe(3);

  const countRows = (): number => {
    const db = openBrokerDb(broker.dbPath, { readonly: true });
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

  await insertLegacyOperatorMessage(a.body.instance_token, "group A message");
  await insertLegacyOperatorMessage(b.body.instance_token, "group B message");

  const db = openBrokerDb(broker.dbPath, { readonly: true });
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

  const stillThere = openBrokerDb(broker.dbPath, { readonly: true });
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

  const gone = openBrokerDb(broker.dbPath, { readonly: true });
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
  await insertLegacyOperatorMessage(b.body.instance_token, "B's actual unread mail");
  await insertLegacyOperatorMessage(a.body.instance_token, "A message 1");
  await insertLegacyOperatorMessage(a.body.instance_token, "A message 2");

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
    const rw = openBrokerDb(cellBroker.dbPath);
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

    const row = openBrokerDb(cellBroker.dbPath, { readonly: true });
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
  // 30_000, not the bun default of 5_000: this is the only test that spawns its
  // own broker instead of reusing the shared one, so it needs the extra time
  // for that spawn on top of its HTTP work.
}, 30_000);

test("cursor drain marks delivered too (MAJOR 2): the TTL sweep must not treat cursor-read mail as still pending", async () => {
  const g = { id: await groupId("op-major2"), hash: await sha256Hex("op-major2") };
  const a = await register("hMajor2", "/major2", g);

  await drainAs(g, "sess-m2");
  await insertLegacyOperatorMessage(a.body.instance_token, "cursor-read message");
  const drained = await drainAs(g, "sess-m2");
  expect((drained.body as { messages: { text: string }[] }).messages.map((m) => m.text)).toEqual([
    "cursor-read message",
  ]);

  const db = openBrokerDb(broker.dbPath, { readonly: true });
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
  await insertLegacyOperatorMessage(a.body.instance_token, "m1");
  await drainAs(g, "sess-live");

  // Age sess-dead past the GC TTL.
  const rw = openBrokerDb(broker.dbPath);
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
    const db = openBrokerDb(broker.dbPath, { readonly: true });
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
  const gA = { id: await groupId("op-major1-A"), hash: await sha256Hex("op-major1-A") };
  const gB = { id: await groupId("op-major1-B"), hash: await sha256Hex("op-major1-B") };
  const a = await register("hMajor1A", "/major1A", gA);
  const b = await register("hMajor1B", "/major1B", gB);

  const SESSION = "shared-session-id";

  // Registration seeds a session's cursor at the box's CURRENT MAX(id) (see
  // "lot 1A" tests above): a message sent BEFORE a group's first drain is
  // invisible to it -- by design, a fresh session only watches forward.
  const premierA = await drainAs(gA, SESSION);
  await insertLegacyOperatorMessage(a.body.instance_token, "A msg");
  await insertLegacyOperatorMessage(b.body.instance_token, "B msg");
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

  const db = openBrokerDb(broker.dbPath, { readonly: true });
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

type RunDrain = { messages: { id: number; from_peer_id: string; text: string; author_instance_hint?: string }[] } | { error: string };

async function newRuns(label: string, count = 1): Promise<{ g: { id: string; hash: string }; runs: RunCredential[] }> {
  const g = { id: await groupId(label), hash: await sha256Hex(label) };
  const runs: RunCredential[] = [];
  for (let i = 0; i < count; i++) runs.push(await mintRunCredential(broker, g));
  return { g, runs };
}

function operatorRows<T>(sql: string, ...params: (string | number)[]): T[] {
  const db = openBrokerDb(broker.dbPath, { readonly: true });
  try {
    return db.query(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

const rowsFor = (group: string): number =>
  operatorRows<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE to_token = ? AND group_id = ?", OPERATOR_INSTANCE_TOKEN, group)[0]!.n;

const drainRun = (run: RunCredential, session: string, over: Record<string, unknown> = {}) =>
  runInboxCall<RunDrain>(broker, "/operator-inbox", run, { session_id: session, ...over });

const purgeRun = (run: RunCredential, session: string, scope: "session" | "ids", ids?: number[]) =>
  runInboxCall<{ deleted: number } | { error: string }>(broker, "/operator-inbox/purge", run, { session_id: session, scope, ids });

const runTexts = (r: { body: unknown }): string[] => (r.body as { messages: { text: string }[] }).messages.map((m) => m.text);

function insertSystemNote(group: string, text: string): number {
  const db = openBrokerDb(broker.dbPath);
  try {
    return Number(
      db
        .run(
          `INSERT INTO messages (from_token, to_token, group_id, text, sent_at, delivered, source_kind, provenance_version)
           VALUES (?, ?, ?, ?, ?, 0, 'system', 1)`,
          [DECK_INSTANCE_TOKEN, OPERATOR_INSTANCE_TOKEN, group, text, new Date().toISOString()]
        )
        .lastInsertRowid
    );
  } finally {
    db.close();
  }
}

test("an attested deposit is stamped with the run scope, the instance digest and the peer snapshot", async () => {
  const { runs } = await newRuns("inb-stamp");
  const run = runs[0]!;
  const a = await registerAttestedInstance(broker, run, "hStamp", "/stamp");

  const sent = await depositToOperator(broker, a.body.instance_token, "signed note", run);

  expect(sent.body.ok).toBe(true);
  expect(
    operatorRows(
      `SELECT inbox_operator_id, inbox_run_ref, inbox_group_id, inbox_project_key, author_instance_ref,
              author_peer_id_snapshot, source_kind, provenance_version
         FROM messages WHERE to_token = ? AND group_id = ?`,
      OPERATOR_INSTANCE_TOKEN,
      run.group
    )
  ).toEqual([
    {
      inbox_operator_id: FIXTURE_OPERATOR_ID,
      inbox_run_ref: run.run,
      inbox_group_id: run.group,
      inbox_project_key: INBOX_TEST_PROJECT,
      author_instance_ref: deriveInstanceRef(a.body.instance_token),
      author_peer_id_snapshot: a.body.peer_id,
      source_kind: "agent",
      provenance_version: 1,
    },
  ]);
});

test("a bound instance cannot deposit without its proof: refused before any insertion, with the proof it lands", async () => {
  const { runs } = await newRuns("inb-m4");
  const run = runs[0]!;
  const a = await registerAttestedInstance(broker, run, "hM4", "/m4");

  const unsigned = await depositToOperator(broker, a.body.instance_token, "no proof");
  expect({ status: unsigned.status, ok: unsigned.body.ok, rows: rowsFor(run.group) }).toEqual({ status: 401, ok: false, rows: 0 });

  const signed = await depositToOperator(broker, a.body.instance_token, "with proof", run);
  expect({ ok: signed.body.ok, rows: rowsFor(run.group) }).toEqual({ ok: true, rows: 1 });
});

test("a run credential does not speak for an instance of another run, an unbound instance or another group", async () => {
  const { g, runs } = await newRuns("inb-cross", 2);
  const [runA, runB] = runs as [RunCredential, RunCredential];
  const a = await registerAttestedInstance(broker, runA, "hCrossA", "/crossA");
  const b = await registerAttestedInstance(broker, runB, "hCrossB", "/crossB");
  const legacy = await register("hCrossL", "/crossL", g);
  const other = await newRuns("inb-cross-other");

  const refusals = [
    await depositToOperator(broker, b.body.instance_token, "B speaks with A's credential", runA),
    await depositToOperator(broker, legacy.body.instance_token, "unbound with a run credential", runA),
    await depositToOperator(broker, a.body.instance_token, "A with a credential of another group", other.runs[0]!),
  ];

  expect(refusals.map((r) => [r.status, r.body.ok])).toEqual([[403, false], [403, false], [403, false]]);
  expect(rowsFor(g.id)).toBe(0);
  expect((await depositToOperator(broker, a.body.instance_token, "A with A", runA)).body.ok).toBe(true);
});

test("an unattested deposit is refused with the remedy and stores nothing, whatever its body claims", async () => {
  const { g, runs } = await newRuns("inb-legacy-deposit");
  const run = runs[0]!;
  const legacy = await register("hLegDep", "/legdep", g);

  const sent = await depositToOperator(broker, legacy.body.instance_token, "plain legacy note", undefined, {
    source_kind: "system",
    inbox_run_ref: run.run,
    author_instance_ref: "forged",
  });

  expect({ status: sent.status, ok: sent.body.ok }).toEqual({ status: 403, ok: false });
  expect(sent.body.error, "the agent is told how to reach the operator").toContain("restart this session from the Deck");
  expect(rowsFor(g.id), "a refused deposit leaves no row, system or legacy").toBe(0);
  expect(runTexts(await drain(g))).toEqual([]);
});

test("a historical unattested entry stays readable by the legacy reader only, never by a run", async () => {
  const { g, runs } = await newRuns("inb-legacy-history");
  const run = runs[0]!;
  const legacy = await register("hLegHist", "/leghist", g);
  await insertLegacyOperatorMessage(legacy.body.instance_token, "note from before the upgrade");

  expect(runTexts(await drainRun(run, "legacy-note")), "a run never reads an unattested entry").toEqual([]);
  expect(runTexts(await drain(g))).toEqual(["note from before the upgrade"]);
});

test("a run reads its own entries and the group's broker notifications, never another run's nor an unattested one", async () => {
  const { g, runs } = await newRuns("inb-isolation", 2);
  const [runA, runB] = runs as [RunCredential, RunCredential];
  const a = await registerAttestedInstance(broker, runA, "hIsoA", "/isoA");
  const b = await registerAttestedInstance(broker, runB, "hIsoB", "/isoB");
  const legacy = await register("hIsoL", "/isoL", g);
  await depositToOperator(broker, a.body.instance_token, "from A", runA);
  await depositToOperator(broker, b.body.instance_token, "from B", runB);
  await insertLegacyOperatorMessage(legacy.body.instance_token, "legacy note");
  insertSystemNote(g.id, "system note");

  await drainAs(g, "legacy-cursor");
  await depositToOperator(broker, a.body.instance_token, "late from A", runA);
  expect(runTexts(await drainAs(g, "legacy-cursor")), "a legacy cursor never reads an attested entry").toEqual([]);
  expect(runTexts(await drain(g))).toEqual(["legacy note", "system note"]);

  expect(runTexts(await drainRun(runA, "shared-session"))).toEqual(["from A", "system note", "late from A"]);
  expect(runTexts(await drainRun(runB, "shared-session"))).toEqual(["from B", "system note"]);
  expect(runTexts(await drainRun(runA, "shared-session"))).toEqual([]);
});

test("a run cursor starts at zero: an entry deposited before the first read is not lost, and each session reads it once", async () => {
  const { runs } = await newRuns("inb-cursor");
  const run = runs[0]!;
  const a = await registerAttestedInstance(broker, run, "hCur", "/cur");
  await depositToOperator(broker, a.body.instance_token, "early", run);

  expect(runTexts(await drainRun(run, "first"))).toEqual(["early"]);
  expect(runTexts(await drainRun(run, "first"))).toEqual([]);
  expect(runTexts(await drainRun(run, "second"))).toEqual(["early"]);
  await depositToOperator(broker, a.body.instance_token, "later", run);
  expect(runTexts(await drainRun(run, "first"))).toEqual(["later"]);
});

test("a legacy purge, by id or by session floor, never deletes an entry of a run but still deletes a notification", async () => {
  const { g, runs } = await newRuns("inb-purge-legacy");
  const run = runs[0]!;
  const a = await registerAttestedInstance(broker, run, "hPurL", "/purL");
  await depositToOperator(broker, a.body.instance_token, "agent entry", run);
  const agentId = operatorRows<{ id: number }>("SELECT id FROM messages WHERE to_token = ? AND group_id = ?", OPERATOR_INSTANCE_TOKEN, g.id)[0]!.id;
  insertSystemNote(g.id, "notification above the agent entry");
  const texts = (): string[] =>
    operatorRows<{ text: string }>("SELECT text FROM messages WHERE to_token = ? AND group_id = ? ORDER BY id", OPERATOR_INSTANCE_TOKEN, g.id).map((r) => r.text);

  expect((await purge(g, "legacy-s", "ids", [agentId])).body).toEqual({ deleted: 0 });
  await drainAs(g, "legacy-s");
  expect((await purge(g, "legacy-s", "session")).body, "the floor sits above the agent entry and still must not take it").toEqual({ deleted: 1 });
  expect(texts()).toEqual(["agent entry"]);
});

test("a run purge deletes only its own entries, by id and by session, and a notification only when named", async () => {
  const { g, runs } = await newRuns("inb-purge", 2);
  const [runA, runB] = runs as [RunCredential, RunCredential];
  const a = await registerAttestedInstance(broker, runA, "hPurA", "/purA");
  const b = await registerAttestedInstance(broker, runB, "hPurB", "/purB");
  await depositToOperator(broker, a.body.instance_token, "a1", runA);
  await depositToOperator(broker, a.body.instance_token, "a2", runA);
  await depositToOperator(broker, b.body.instance_token, "b1", runB);
  const systemId = insertSystemNote(g.id, "system note");
  const idOf = (text: string): number =>
    operatorRows<{ id: number }>("SELECT id FROM messages WHERE to_token = ? AND text = ?", OPERATOR_INSTANCE_TOKEN, text)[0]!.id;
  const texts = (): string[] =>
    operatorRows<{ text: string }>("SELECT text FROM messages WHERE to_token = ? AND group_id = ? ORDER BY id", OPERATOR_INSTANCE_TOKEN, g.id).map((r) => r.text);
  await drainRun(runA, "pA");
  await drainRun(runB, "pB");

  expect((await purgeRun(runA, "pA", "ids", [idOf("a1"), idOf("b1")])).body).toEqual({ deleted: 1 });
  expect(texts()).toEqual(["a2", "b1", "system note"]);

  expect((await purgeRun(runA, "pA", "session")).body).toEqual({ deleted: 1 });
  expect(texts()).toEqual(["b1", "system note"]);

  expect((await purgeRun(runB, "pB", "ids", [systemId])).body).toEqual({ deleted: 1 });
  expect(texts()).toEqual(["b1"]);
});

test("a run that reads first leaves the group's notification to the legacy reader", async () => {
  const { g, runs } = await newRuns("inb-run-first");
  const run = runs[0]!;
  const a = await registerAttestedInstance(broker, run, "hRunFirst", "/runfirst");
  await depositToOperator(broker, a.body.instance_token, "agent entry", run);
  insertSystemNote(g.id, "group notification");

  expect(runTexts(await drainRun(run, "first-reader"))).toEqual(["agent entry", "group notification"]);
  expect(runTexts(await drain(g)), "the notification is still undelivered for the legacy reader").toEqual(["group notification"]);
});

test("a run drain is one write: a failure after the read delivers nothing and leaves no cursor", async () => {
  const { runs } = await newRuns("inb-drain-atomic");
  const run = runs[0]!;
  const a = await registerAttestedInstance(broker, run, "hDrainTx", "/draintx");
  await depositToOperator(broker, a.body.instance_token, "kept for the next read", run);
  const db = openBrokerDb(broker.dbPath);
  db.run("CREATE TRIGGER zz_run_cursor_abort BEFORE UPDATE OF last_id ON operator_inbox_run_sessions BEGIN SELECT RAISE(ABORT, 'forced'); END");
  try {
    expect((await drainRun(run, "atomic-session")).status).toBe(500);
  } finally {
    db.run("DROP TRIGGER zz_run_cursor_abort");
    db.close();
  }
  expect(
    operatorRows<{ delivered: number }>("SELECT delivered FROM messages WHERE to_token = ? AND group_id = ?", OPERATOR_INSTANCE_TOKEN, run.group)
  ).toEqual([{ delivered: 0 }]);
  expect(operatorRows("SELECT 1 FROM operator_inbox_run_sessions WHERE run_ref = ?", run.run)).toEqual([]);
  expect(runTexts(await drainRun(run, "atomic-session"))).toEqual(["kept for the next read"]);
});

test("a run session purge is one write, and a session that never drained gets its cursor in it", async () => {
  const { runs } = await newRuns("inb-purge-atomic");
  const run = runs[0]!;
  const a = await registerAttestedInstance(broker, run, "hPurgeTx", "/purgetx");
  await depositToOperator(broker, a.body.instance_token, "survives the failed purge", run);
  const db = openBrokerDb(broker.dbPath);
  db.run(
    `CREATE TRIGGER zz_run_purge_abort BEFORE DELETE ON messages WHEN OLD.to_token = '${OPERATOR_INSTANCE_TOKEN}'
     BEGIN SELECT RAISE(ABORT, 'forced'); END`
  );
  try {
    expect((await purgeRun(run, "never-drained", "session")).status).toBe(500);
  } finally {
    db.run("DROP TRIGGER zz_run_purge_abort");
    db.close();
  }
  expect(operatorRows("SELECT 1 FROM operator_inbox_run_sessions WHERE run_ref = ?", run.run), "the failed purge left no cursor").toEqual([]);
  expect(rowsFor(run.group)).toBe(1);

  expect((await purgeRun(run, "never-drained", "session")).body).toEqual({ deleted: 1 });
  expect(
    operatorRows<{ session_id: string }>("SELECT session_id FROM operator_inbox_run_sessions WHERE run_ref = ?", run.run),
    "a session that never drained is created by the purge, not ignored"
  ).toEqual([{ session_id: "never-drained" }]);
});

test("a run cursor older than its TTL, stored as an ISO timestamp, is collected and no longer holds the purge floor", async () => {
  const { runs } = await newRuns("inb-cursor-gc");
  const run = runs[0]!;
  const a = await registerAttestedInstance(broker, run, "hCursorGc", "/cursorgc");
  await depositToOperator(broker, a.body.instance_token, "behind a dead cursor", run);
  const staleSeen = new Date(Date.now() - 25 * 3_600_000).toISOString();
  const db = openBrokerDb(broker.dbPath);
  db.run(
    `INSERT INTO operator_inbox_run_sessions (session_id, operator_id, run_ref, group_id, last_id, started_at, last_seen_at)
     VALUES ('dead-cursor', ?, ?, ?, 0, ?, ?)`,
    [FIXTURE_OPERATOR_ID, run.run, run.group, staleSeen, staleSeen]
  );
  db.close();

  expect((await purgeRun(run, "live-cursor", "session")).body, "the dead cursor at 0 no longer pins the floor").toEqual({ deleted: 1 });
  expect(
    operatorRows<{ session_id: string }>("SELECT session_id FROM operator_inbox_run_sessions WHERE run_ref = ? ORDER BY session_id", run.run)
  ).toEqual([{ session_id: "live-cursor" }]);
});

test("an expired run credential can neither drain nor purge", async () => {
  const { runs } = await newRuns("inb-expired");
  const run = runs[0]!;
  await registerAttestedInstance(broker, run, "hExpired", "/expired");
  expect((await drainRun(run, "exp-session")).status, "live credential: allowed").toBe(200);
  const db = openBrokerDb(broker.dbPath);
  db.run("UPDATE approval_session_tokens SET expires_at = ? WHERE token_id = ?", [new Date(Date.now() - 60_000).toISOString(), run.tokenId]);
  db.close();

  const drained = await drainRun(run, "exp-session");
  const purged = await purgeRun(run, "exp-session", "session");
  expect([drained.status, drained.body, purged.status, purged.body]).toEqual([
    403,
    { error: "no live credential for this run" },
    403,
    { error: "no live credential for this run" },
  ]);
});

test("a run-scoped read needs the operator key, a v1 proof for its own door and a live credential", async () => {
  const { runs } = await newRuns("inb-auth");
  const run = runs[0]!;
  // A registered instance makes the group exist, so only the credential check can refuse below.
  await registerAttestedInstance(broker, run, "hAuth", "/auth");
  const base = { group_id: run.group, group_secret_hash: run.secretHash, run_ref: run.run, session_id: "auth-session" };
  const noLiveCredential = { error: "no live credential for this run" };
  const cursorRows = (): number =>
    operatorRows<{ n: number }>("SELECT COUNT(*) AS n FROM operator_inbox_run_sessions WHERE run_ref = ?", run.run)[0]!.n;
  const call = (body: Record<string, unknown>, auth?: unknown) =>
    post<{ error?: string }>(`${broker.url}/operator-inbox`, auth === undefined ? body : { ...body, auth });

  const legacyProof = buildAuthProof(FIXTURE_OPERATOR.privateKey, base, { kind: "operator", operator_id: FIXTURE_OPERATOR_ID });
  expect((await call(base, legacyProof)).status).toBe(401);
  expect((await call(base, operatorInboxProof(base, INBOX_GATES.purge))).status).toBe(401);
  expect((await call(base, runInboxProof(run, base, INBOX_GATES.drain))).status, "a run credential is not the operator").toBe(403);
  const stranger = { ...base, run_ref: crypto.randomUUID() };
  const strangerRead = await call(stranger, operatorInboxProof(stranger, INBOX_GATES.drain));
  expect({ status: strangerRead.status, body: strangerRead.body }, "a run that never held a credential").toEqual({
    status: 403,
    body: noLiveCredential,
  });
  const { run_ref: _r, ...withoutRun } = base;
  expect((await call(withoutRun, operatorInboxProof(withoutRun, INBOX_GATES.drain))).status, "a proof without run_ref").toBe(400);
  expect((await call(base)).status, "run_ref without a proof").toBe(400);
  const { session_id: _s, ...withoutSession } = base;
  expect((await call(withoutSession, operatorInboxProof(withoutSession, INBOX_GATES.drain))).status).toBe(400);
  expect(cursorRows(), "a refused read never creates a cursor").toBe(0);
  expect((await call(base, operatorInboxProof(base, INBOX_GATES.drain))).status, "the same read with a live credential").toBe(200);

  const revoke = { session_ref: `window-${run.run}`, public_key: FIXTURE_OPERATOR.publicKey };
  await post(`${broker.url}/approval/token-revoke`, {
    ...revoke,
    auth: buildAuthProof(FIXTURE_OPERATOR.privateKey, revoke, { kind: "operator", operator_id: FIXTURE_OPERATOR_ID }),
  });
  const afterRevoke = await call(base, operatorInboxProof(base, INBOX_GATES.drain));
  expect({ status: afterRevoke.status, body: afterRevoke.body }, "a run without a live credential").toEqual({
    status: 403,
    body: noLiveCredential,
  });
});

test("the display hint tells two instances with the same snapshot apart and never exposes a digest or a token", async () => {
  const { runs } = await newRuns("inb-hint");
  const run = runs[0]!;
  const a = await registerAttestedInstance(broker, run, "hHintA", "/hintA");
  const b = await registerAttestedInstance(broker, run, "hHintB", "/hintB");
  const rename = (token: string, name: string) => post(`${broker.url}/set-id`, { instance_token: token, new_peer_id: name });
  await rename(a.body.instance_token, "alpha");
  await depositToOperator(broker, a.body.instance_token, "first alpha", run);
  await rename(a.body.instance_token, "beta");
  await rename(b.body.instance_token, "alpha");
  await depositToOperator(broker, b.body.instance_token, "second alpha", run);

  const read = await drainRun(run, "hint-session");
  const messages = (read.body as { messages: { from_peer_id: string; author_instance_hint?: string }[] }).messages;

  expect(messages.map((m) => m.from_peer_id), "the snapshot survives the rename").toEqual(["alpha", "alpha"]);
  expect(messages.map((m) => m.author_instance_hint)).toEqual([
    deriveInstanceRef(a.body.instance_token).slice(-12),
    deriveInstanceRef(b.body.instance_token).slice(-12),
  ]);
  const wire = JSON.stringify(read.body);
  for (const secret of [a, b].flatMap((p) => [p.body.instance_token, deriveInstanceRef(p.body.instance_token)])) {
    expect(wire).not.toContain(secret);
  }
});

// --- Durable registry, correlated reply and close of message entries ---

interface EntryRow {
  entry_id: string;
  operator_id: string;
  run_ref: string;
  group_id: string;
  project_key: string;
  message_id: number;
  sent_at: string;
  author_instance_ref: string;
  author_peer_id_snapshot: string;
  reply_token: string;
  excerpt: string;
  state: string;
  settled_at: string | null;
  responded_reply_id: string | null;
  responded_message_id: number | null;
  closed_by_authority: string | null;
  closed_by_instance_ref: string | null;
  closed_by_peer_id_snapshot: string | null;
  close_reason: string | null;
  created_at: string;
}

const entriesOf = (run: RunCredential): EntryRow[] =>
  operatorRows<EntryRow>("SELECT * FROM inbox_message_entries WHERE run_ref = ? ORDER BY message_id", run.run);

const deckMessagesTo = (token: string): string[] =>
  operatorRows<{ text: string }>(
    "SELECT text FROM messages WHERE from_token = ? AND to_token = ? ORDER BY id",
    DECK_INSTANCE_TOKEN,
    token
  ).map((r) => r.text);

/**
 * A run, a registered author instance and one deposit: everything a reply or a
 * close acts on. The author is registered from tile `tile`, so a mandate minted
 * for that tile may prove with the author's instance.
 */
async function depositedEntry(label: string, text = "please look at this") {
  const { g, runs } = await newRuns(label);
  const run = runs[0]!;
  const tile = `tile-${label}`;
  const author = await registerAttestedInstance(broker, run, `h-${label}`, `/${label}`, { desk_session: tile });
  await depositToOperator(broker, author.body.instance_token, text, run);
  const entry = entriesOf(run)[0]!;
  return { g, run, author, tile, token: author.body.instance_token, peerId: author.body.peer_id, entry };
}

const replyTo = (run: RunCredential, entry: EntryRow, replyId = crypto.randomUUID(), text = "go ahead", over: Record<string, unknown> = {}) =>
  replyInbox(broker, run, { message_id: entry.message_id, sent_at: entry.sent_at, reply_id: replyId, text, ...over });

// Mutant: the registry INSERT removed from recordMessage, or fed values from the request body.
test("an attested deposit creates exactly one open registry row, stamped from the credential and the message row", async () => {
  const { run, token, peerId, entry } = await depositedEntry("reg-stamp", "x".repeat(300));

  expect(entriesOf(run)).toHaveLength(1);
  const message = operatorRows<{ id: number; sent_at: string }>(
    "SELECT id, sent_at FROM messages WHERE to_token = ? AND group_id = ?",
    OPERATOR_INSTANCE_TOKEN,
    run.group
  )[0]!;
  expect(entry).toMatchObject({
    operator_id: FIXTURE_OPERATOR_ID,
    run_ref: run.run,
    group_id: run.group,
    project_key: INBOX_TEST_PROJECT,
    message_id: message.id,
    sent_at: message.sent_at,
    author_instance_ref: deriveInstanceRef(token),
    author_peer_id_snapshot: peerId,
    reply_token: token,
    state: "open",
    settled_at: null,
  });
  expect(entry.entry_id).toMatch(/^m_[0-9a-f-]{36}$/);
  expect(Array.from(entry.excerpt), "the excerpt is bounded in code points").toHaveLength(280);
  expect((await depositToOperator(broker, token, "a legacy-shaped claim", run, { inbox_run_ref: "forged", entry_id: "forged" })).body.ok).toBe(true);
  expect(entriesOf(run).map((e) => e.run_ref)).toEqual([run.run, run.run]);
});

// Mutant: the registry insert moved outside the message transaction.
test("a failing registry insert leaves no message either", async () => {
  const { runs } = await newRuns("reg-atomic");
  const run = runs[0]!;
  const a = await registerAttestedInstance(broker, run, "hAtomic", "/atomic");
  const db = openBrokerDb(broker.dbPath);
  try {
    db.run(
      `CREATE TRIGGER reg_atomic_abort BEFORE INSERT ON inbox_message_entries WHEN NEW.run_ref = '${run.run}'
       BEGIN SELECT RAISE(ABORT, 'registry refused'); END`
    );
    const refused = await depositToOperator(broker, a.body.instance_token, "must not land", run);
    expect(refused.body.ok).not.toBe(true);
    expect({ messages: rowsFor(run.group), entries: entriesOf(run).length }).toEqual({ messages: 0, entries: 0 });
  } finally {
    db.run("DROP TRIGGER IF EXISTS reg_atomic_abort");
    db.close();
  }
  expect((await depositToOperator(broker, a.body.instance_token, "lands now", run)).body.ok).toBe(true);
  expect(entriesOf(run)).toHaveLength(1);
});

// Mutants: a DELETE or cascade on the registry in handleUnregister, in the Courrier purge or in the TTL sweep.
test("the registry survives the author's unregister, a Courrier purge by id and by session, and the message TTL", async () => {
  const { g, run, token, entry } = await depositedEntry("reg-survive");
  await drainRun(run, "survive-session");
  await purgeRun(run, "survive-session", "ids", [entry.message_id]);
  await purgeRun(run, "survive-session", "session");
  await post(`${broker.url}/unregister`, { instance_token: token });
  const db = openBrokerDb(broker.dbPath);
  try {
    db.run("UPDATE messages SET sent_at = '2000-01-01T00:00:00.000Z' WHERE group_id = ?", [g.id]);
  } finally {
    db.close();
  }
  await get(`${broker.url}/admin/purge-messages`);

  expect(rowsFor(g.id), "the transport row is gone").toBe(0);
  expect(entriesOf(run).map((e) => [e.entry_id, e.state])).toEqual([[entry.entry_id, "open"]]);
});

// Mutant: the registry GC ignores the live run credential, or compares created_at as TEXT.
test("the sweep keeps an old entry whose run still holds a credential and drops one whose run does not", async () => {
  const live = await depositedEntry("reg-gc-live");
  const dead = await depositedEntry("reg-gc-dead");
  const revoke = { session_ref: `window-${dead.run.run}`, public_key: FIXTURE_OPERATOR.publicKey };
  await post(`${broker.url}/approval/token-revoke`, {
    ...revoke,
    auth: buildAuthProof(FIXTURE_OPERATOR.privateKey, revoke, { kind: "operator", operator_id: FIXTURE_OPERATOR_ID }),
  });
  const swept = await get<{ approval_cutoff_days: number }>(`${broker.url}/admin/purge-messages`);
  const aged = (minutes: number) => new Date(Date.now() - swept.body.approval_cutoff_days * 86_400_000 - minutes * 60_000).toISOString();
  const db = openBrokerDb(broker.dbPath);
  try {
    db.run("UPDATE inbox_message_entries SET created_at = ? WHERE run_ref IN (?, ?)", [aged(1), live.run.run, dead.run.run]);
  } finally {
    db.close();
  }
  await get(`${broker.url}/admin/purge-messages`);

  expect(entriesOf(live.run)).toHaveLength(1);
  expect(entriesOf(dead.run)).toHaveLength(0);
});

// Mutants: the settling UPDATE or the message insert dropped from the reply transaction.
test("a reply settles the entry and sends the author exactly one message from the deck", async () => {
  const { run, token, entry } = await depositedEntry("rep-happy");

  const sent = await replyTo(run, entry, crypto.randomUUID(), "go ahead");

  expect(sent.status).toBe(200);
  expect(sent.body.ok).toBe(true);
  expect(deckMessagesTo(token)).toEqual(["go ahead"]);
  expect(entriesOf(run)[0]).toMatchObject({ state: "responded", responded_message_id: sent.body.message_id });
  expect(entriesOf(run)[0]!.settled_at).not.toBeNull();
  // Mutant: the raw instance token kept in the registry after the reply.
  expect(entriesOf(run)[0]!.reply_token).toBe("");
});

test("the same reply id replays once without a second message, a different one is a conflict that names the state", async () => {
  const { run, token, entry } = await depositedEntry("rep-replay");
  const replyId = crypto.randomUUID();
  const first = await replyTo(run, entry, replyId, "first");

  const replay = await replyTo(run, entry, replyId, "first");
  const second = await replyTo(run, entry, crypto.randomUUID(), "second");

  expect({ status: replay.status, replayed: replay.body.replayed, id: replay.body.message_id }).toEqual({
    status: 200,
    replayed: true,
    id: first.body.message_id,
  });
  expect({ status: second.status, error: second.body.error, state: second.body.state }).toEqual({
    status: 409,
    error: "entry-settled",
    state: "responded",
  });
  expect(deckMessagesTo(token), "the author received one message, not three").toEqual(["first"]);
});

// Mutant: the entry keyed by message id alone.
test("the key is (message_id, sent_at) inside the run of the proof: another sent_at, another run's proof and an unknown id are all 404", async () => {
  const { runs } = await newRuns("rep-key", 2);
  const [runA, runB] = runs as [RunCredential, RunCredential];
  const a = await registerAttestedInstance(broker, runA, "hKeyA", "/keyA");
  await depositToOperator(broker, a.body.instance_token, "for A", runA);
  const entry = entriesOf(runA)[0]!;

  const wrongTime = await replyTo(runA, entry, undefined, "x", { sent_at: "2000-01-01T00:00:00.000Z" });
  const otherRun = await replyTo(runB, entry);
  const unknown = await replyTo(runA, entry, undefined, "x", { message_id: entry.message_id + 9999 });

  expect([wrongTime.status, otherRun.status, unknown.status]).toEqual([404, 404, 404]);
  expect(wrongTime.body.error).toBe("unknown entry");
  expect(deckMessagesTo(a.body.instance_token)).toEqual([]);
  expect(entriesOf(runA)[0]!.state).toBe("open");
});

// Mutants: reply mapped to the drain operation, a run or mandate proof accepted, a drain-gate proof accepted.
test("only the operator key opens the reply door, for its own gate", async () => {
  const { run, tile, entry } = await depositedEntry("rep-gate");
  const mandate = await mintMandate(broker, run, "lead", "lead-gate", { tile });
  const body = { group_id: run.group, group_secret_hash: run.secretHash, run_ref: run.run, message_id: entry.message_id, sent_at: entry.sent_at, reply_id: crypto.randomUUID(), text: "x" };
  const withAuth = (auth: unknown) => post<{ error?: string }>(`${broker.url}/operator-inbox/reply`, { ...body, auth });

  const refusals = [
    await withAuth(runInboxProof(run, body, INBOX_GATES.reply)),
    await withAuth(buildInboxProof(mandate.cred.privateKey, body, INBOX_GATES.reply, { kind: "session", operator_id: FIXTURE_OPERATOR_ID, token_id: mandate.tokenId })),
    await withAuth(operatorInboxProof(body, INBOX_GATES.drain)),
    await withAuth(buildAuthProof(FIXTURE_OPERATOR.privateKey, body, { kind: "operator", operator_id: FIXTURE_OPERATOR_ID })),
    await post<{ error?: string }>(`${broker.url}/operator-inbox/reply`, body),
  ];

  expect(refusals.map((r) => r.status)).toEqual([403, 403, 401, 401, 400]);
  expect(entriesOf(run)[0]!.state).toBe("open");
});

test("a reply is validated at the door: text, reply id, message id and sent_at", async () => {
  const { run, entry } = await depositedEntry("rep-valid");
  const statuses: number[] = [];
  for (const over of [
    { text: "" },
    { text: 7 },
    { reply_id: "not-a-uuid" },
    { message_id: 1.5 },
    { message_id: "1" },
    { sent_at: "" },
    { sent_at: "x".repeat(65) },
  ]) {
    statuses.push((await replyTo(run, entry, undefined, "ok", over)).status);
  }
  expect(statuses).toEqual([400, 400, 400, 400, 400, 400, 400]);
  expect(entriesOf(run)[0]!.state).toBe("open");
});

// Mutant: the reply target resolved by peer_id.
test("a peer_id taken over by another instance receives nothing: the reply is 410 and the entry stays open", async () => {
  const { run, author, token, peerId, entry } = await depositedEntry("rep-reuse");
  await post(`${broker.url}/unregister`, { instance_token: token });
  const heir = await registerAttestedInstance(broker, run, "hHeir", "/heir");
  await post(`${broker.url}/set-id`, { instance_token: heir.body.instance_token, new_peer_id: peerId });

  const gone = await replyTo(run, entry);

  expect({ status: gone.status, error: gone.body.error }).toEqual({ status: 410, error: "author-gone" });
  expect(deckMessagesTo(heir.body.instance_token)).toEqual([]);
  expect(entriesOf(run)[0]!.state).toBe("open");
  expect(author.body.peer_id).toBe(peerId);
});

// Mutant: the author token's binding is not compared with the entry's run.
test("an author whose token is still active but bound to another run is gone: 410, nothing sent", async () => {
  const { run, token, entry } = await depositedEntry("rep-rebound");
  const other = await mintRunCredential(broker, { id: run.group, hash: run.secretHash });
  const db = openBrokerDb(broker.dbPath);
  try {
    db.run("UPDATE inbox_instance_bindings SET run_ref = ? WHERE author_instance_ref = ?", [other.run, deriveInstanceRef(token)]);
  } finally {
    db.close();
  }

  const gone = await replyTo(run, entry);

  expect({ status: gone.status, error: gone.body.error }).toEqual({ status: 410, error: "author-gone" });
  expect(deckMessagesTo(token)).toEqual([]);
  expect(entriesOf(run)[0]!.state).toBe("open");
});

test("an author who renames itself still receives the reply", async () => {
  const { run, token, entry } = await depositedEntry("rep-rename");
  await post(`${broker.url}/set-id`, { instance_token: token, new_peer_id: "renamed-author" });

  expect((await replyTo(run, entry, undefined, "after the rename")).status).toBe(200);
  expect(deckMessagesTo(token)).toEqual(["after the rename"]);
});

// Mutants: the actor's authority read from the body, a missing author proof accepted, the object resolved outside the actor scope.
test("a message entry is closed by its author, its lead and its supervisor, never by another author or another run", async () => {
  const { runs } = await newRuns("cls-msg", 2);
  const [run, otherRun] = runs as [RunCredential, RunCredential];
  const a1 = await registerAttestedInstance(broker, run, "hCls1", "/cls1", { desk_session: "cls-tile-a1" });
  const a2 = await registerAttestedInstance(broker, run, "hCls2", "/cls2", { desk_session: "cls-tile-a2" });
  const leadTile = await registerAttestedInstance(broker, run, "hClsL", "/clsL", { desk_session: "cls-tile-lead" });
  const supTile = await registerAttestedInstance(broker, run, "hClsS", "/clsS", { desk_session: "cls-tile-sup" });
  const b = await registerAttestedInstance(broker, otherRun, "hClsB", "/clsB", { desk_session: "cls-tile-b" });
  for (const [t, r, label] of [[a1, run, "one"], [a1, run, "two"], [a1, run, "three"], [a1, run, "four"], [b, otherRun, "other"]] as const) {
    await depositToOperator(broker, t.body.instance_token, label, r);
  }
  const [e1, e2, e3, e4] = entriesOf(run) as [EntryRow, EntryRow, EntryRow, EntryRow];
  const authorOf = await mintMandate(broker, run, "author", "author-1", { tile: "cls-tile-a1" });
  const otherAuthor = await mintMandate(broker, run, "author", "author-2", { tile: "cls-tile-a2" });
  const lead = await mintMandate(broker, run, "lead", "lead-1", { tile: "cls-tile-lead" });
  const supervisor = await mintMandate(broker, run, "supervisor", "supervisor-1", { tile: "cls-tile-sup" });
  const leadOther = await mintMandate(broker, otherRun, "lead", "lead-other", { tile: "cls-tile-b" });
  const close = (r: RunCredential, m: typeof lead, e: EntryRow, instance: string | null, reason: unknown = "done") =>
    closeInbox(broker, r, m, { entryId: e.entry_id, reason, instanceToken: instance });

  const byAuthor = await close(run, authorOf, e1, a1.body.instance_token, "finished here");
  const byOtherAuthor = await close(run, otherAuthor, e2, a2.body.instance_token);
  const byLead = await close(run, lead, e2, leadTile.body.instance_token, "stale");
  const bySupervisor = await close(run, supervisor, e3, supTile.body.instance_token, "superseded");
  const crossRun = await close(otherRun, leadOther, e4, b.body.instance_token);
  const withoutProof = await close(run, lead, e4, null);

  expect(byAuthor.status).toBe(200);
  expect(byOtherAuthor.status, "another author of the same run").toBe(403);
  expect(byLead.status).toBe(200);
  expect(bySupervisor.status).toBe(200);
  expect(crossRun.status, "a lead of run B on an entry of run A, indistinguishable from an unknown id").toBe(404);
  expect(withoutProof.status, "the instance proof is mandatory for a lead too").toBe(400);
  const rows = Object.fromEntries(entriesOf(run).map((e) => [e.message_id, e]));
  expect(rows[e1.message_id]).toMatchObject({
    state: "closed",
    closed_by_authority: "author",
    closed_by_instance_ref: deriveInstanceRef(a1.body.instance_token),
    closed_by_peer_id_snapshot: a1.body.peer_id,
    close_reason: "finished here",
    reply_token: "",
  });
  expect(rows[e2.message_id]).toMatchObject({
    state: "closed",
    closed_by_authority: "lead",
    closed_by_peer_id_snapshot: leadTile.body.peer_id,
    close_reason: "stale",
  });
  expect(rows[e3.message_id]).toMatchObject({ state: "closed", closed_by_authority: "supervisor", closed_by_peer_id_snapshot: supTile.body.peer_id });
  expect(rows[e4.message_id]!.state).toBe("open");
  expect(entriesOf(otherRun)[0]!.state).toBe("open");
  expect(JSON.stringify(byAuthor.body)).not.toContain(a1.body.instance_token);
  expect(JSON.stringify(byAuthor.body)).not.toContain(deriveInstanceRef(a1.body.instance_token));
});

// Mutants: a boundary dropped, the reason truncated instead of refused, control bytes kept.
test("a close reason outside 1..500 code points is a 400 with no write, and control bytes are stripped before storage", async () => {
  const { run, tile, token, entry } = await depositedEntry("cls-reason");
  const lead = await mintMandate(broker, run, "lead", "lead-reason", { tile });
  const close = (reason: unknown) => closeInbox(broker, run, lead, { entryId: entry.entry_id, reason, instanceToken: token });

  const statuses = [await close(undefined), await close(""), await close("   "), await close(7), await close("x".repeat(501))].map((r) => r.status);
  expect(statuses).toEqual([400, 400, 400, 400, 400]);
  expect(entriesOf(run)[0]!.state).toBe("open");

  expect((await close(`line one\nline two${String.fromCharCode(7)}`)).status).toBe(200);
  expect(entriesOf(run)[0]!.close_reason).toBe("line one line two");
});

test("an entry id of an unknown form is a 400, an unknown one a 404, and neither writes", async () => {
  const { run, tile, token } = await depositedEntry("cls-form");
  const lead = await mintMandate(broker, run, "lead", "lead-form", { tile });
  const close = (entryId: unknown) => closeInbox(broker, run, lead, { entryId, reason: "x", instanceToken: token });

  expect([
    (await close("42")).status,
    (await close(undefined)).status,
    (await close("m_short")).status,
    (await close("m_" + "Z".repeat(36))).status,
    (await close("m_" + crypto.randomUUID())).status,
    (await close(crypto.randomUUID())).status,
  ]).toEqual([400, 400, 400, 400, 404, 404]);
});

// Mutants: UPDATE without state='open'; closed_by_* overwritten by a second close.
test("reply and close race to one winner in both orders, and the loser is told the winner's state", async () => {
  const first = await depositedEntry("race-a");
  const leadA = await mintMandate(broker, first.run, "lead", "lead-race-a", { tile: first.tile });
  const closed = await closeInbox(broker, first.run, leadA, { entryId: first.entry.entry_id, reason: "no longer needed", instanceToken: first.token });
  const lateReply = await replyTo(first.run, first.entry);
  const secondClose = await closeInbox(broker, first.run, leadA, { entryId: first.entry.entry_id, reason: "overwritten?", instanceToken: first.token });

  expect(closed.status).toBe(200);
  expect({ status: lateReply.status, state: lateReply.body.state }).toEqual({ status: 409, state: "closed" });
  expect({ status: secondClose.status, state: (secondClose.body as { state?: string }).state }).toEqual({ status: 409, state: "closed" });
  expect(deckMessagesTo(first.token), "no message went to a closed entry").toEqual([]);
  expect(entriesOf(first.run)[0]).toMatchObject({ state: "closed", close_reason: "no longer needed" });

  const second = await depositedEntry("race-b");
  const leadB = await mintMandate(broker, second.run, "lead", "lead-race-b", { tile: second.tile });
  expect((await replyTo(second.run, second.entry)).status).toBe(200);
  const lateClose = await closeInbox(broker, second.run, leadB, { entryId: second.entry.entry_id, reason: "too late", instanceToken: second.token });
  expect({ status: lateClose.status, state: (lateClose.body as { state?: string }).state }).toEqual({ status: 409, state: "responded" });
  expect(entriesOf(second.run)[0]).toMatchObject({ state: "responded", close_reason: null, closed_by_authority: null });
});

test("a concurrent reply and close leave exactly one winner and a consistent state", async () => {
  const w = await depositedEntry("race-par");
  const lead = await mintMandate(broker, w.run, "lead", "lead-race-par", { tile: w.tile });
  const [closed, replied] = await Promise.all([
    closeInbox(broker, w.run, lead, { entryId: w.entry.entry_id, reason: "parallel", instanceToken: w.token }),
    replyTo(w.run, w.entry),
  ]);

  expect([closed.status, replied.status].sort()).toEqual([200, 409]);
  const state = entriesOf(w.run)[0]!.state;
  expect(state).toBe(closed.status === 200 ? "closed" : "responded");
  expect(deckMessagesTo(w.token)).toHaveLength(state === "responded" ? 1 : 0);
});

// Mutant: a registry row created for a deposit made by a restarted Deck's new run, or a state reset to open.
test("a new run of the same group cannot reply to or close an entry of an earlier run", async () => {
  const w = await depositedEntry("run-restart");
  const next = await mintRunCredential(broker, w.g);
  const nextLead = await mintMandate(broker, next, "lead", "lead-next", { tile: "tile-next" });
  const nextInstance = await registerAttestedInstance(broker, next, "hNext", "/next", { desk_session: "tile-next" });

  const reply = await replyTo(next, w.entry);
  const close = await closeInbox(broker, next, nextLead, { entryId: w.entry.entry_id, reason: "x", instanceToken: nextInstance.body.instance_token });

  expect([reply.status, close.status]).toEqual([404, 404]);
  expect(entriesOf(w.run)[0]!.state).toBe("open");
});

// --- Mandate bound to its tile, and the run's open-entry list ---

type ListItem = { id: string; type: string; author: string | null; created_at: string; text: string; closable: boolean; message_id?: number; sent_at?: string };
type ListBody = { entries?: ListItem[]; next_cursor?: string | null; error?: string };
const setPeerStatus = (token: string, status: string): void => {
  const db = openBrokerDb(broker.dbPath);
  try {
    db.run("UPDATE peers SET status = ? WHERE instance_token = ?", [status, token]);
  } finally {
    db.close();
  }
};

// Mutants: instanceOnTile answering true; the tile check skipped for a list; the mandate pinned to the first instance that used it.
test("a lead mandate acts only through an instance of its own tile: another tile of the run is 403 for close and list, a restarted tile passes, an inactive one does not", async () => {
  const w = await depositedEntry("tile-bind");
  await depositToOperator(broker, w.token, "second", w.run);
  const [first, second] = entriesOf(w.run) as [EntryRow, EntryRow];
  const lead = await registerAttestedInstance(broker, w.run, "hTileL", "/tileL", { desk_session: "tile-bind-lead" });
  const mandate = await mintMandate(broker, w.run, "lead", "lead-tile-bind", { tile: "tile-bind-lead" });

  const foreignClose = await closeInbox(broker, w.run, mandate, { entryId: first.entry_id, reason: "x", instanceToken: w.token });
  const foreignList = await listInbox<ListBody>(broker, w.run, mandate, { instanceToken: w.token });
  expect([foreignClose.status, foreignList.status]).toEqual([403, 403]);
  expect(foreignClose.body.error).toBe("author instance is not the mandate's tile");
  expect(entriesOf(w.run).map((e) => e.state), "a refused close writes nothing").toEqual(["open", "open"]);

  expect((await listInbox<ListBody>(broker, w.run, mandate, { instanceToken: lead.body.instance_token })).status).toBe(200);
  const restarted = await registerAttestedInstance(broker, w.run, "hTileL", "/tileL-restarted", { desk_session: "tile-bind-lead" });
  expect(restarted.body.instance_token).not.toBe(lead.body.instance_token);
  const afterRestart = await closeInbox(broker, w.run, mandate, { entryId: first.entry_id, reason: "stale", instanceToken: restarted.body.instance_token });
  expect(afterRestart.status, "the same tile with a new instance keeps its mandate").toBe(200);
  expect(entriesOf(w.run)[0]).toMatchObject({ state: "closed", closed_by_authority: "lead", closed_by_peer_id_snapshot: restarted.body.peer_id });

  setPeerStatus(restarted.body.instance_token, "dormant");
  const inactive = await closeInbox(broker, w.run, mandate, { entryId: second.entry_id, reason: "x", instanceToken: restarted.body.instance_token });
  expect(inactive.status, "an instance of the tile that is no longer active").toBe(403);
  expect(entriesOf(w.run)[1]!.state).toBe("open");
});

// Mutant: the group clause of instanceOnTile dropped.
test("an instance of the mandate's tile whose session row is in another group is refused", async () => {
  const w = await depositedEntry("tile-group");
  const lead = await registerAttestedInstance(broker, w.run, "hGroupL", "/groupL", { desk_session: "tile-group-lead" });
  const mandate = await mintMandate(broker, w.run, "lead", "lead-tile-group", { tile: "tile-group-lead" });
  const db = openBrokerDb(broker.dbPath);
  try {
    db.run("UPDATE peer_sessions SET group_id = ? WHERE instance_token = ?", ["another-group", lead.body.instance_token]);
  } finally {
    db.close();
  }

  const close = await closeInbox(broker, w.run, mandate, { entryId: w.entry.entry_id, reason: "x", instanceToken: lead.body.instance_token });

  expect({ status: close.status, error: close.body.error }).toEqual({ status: 403, error: "author instance is not the mandate's tile" });
  expect(entriesOf(w.run)[0]!.state).toBe("open");
});

// Mutant: authority or tile derived from the displayed peer_id.
test("a peer that takes the lead's peer_id after a rename gets 403 under the lead's mandate", async () => {
  const w = await depositedEntry("tile-reuse");
  const lead = await registerAttestedInstance(broker, w.run, "hReuseL", "/reuseL", { desk_session: "tile-reuse-lead" });
  const mandate = await mintMandate(broker, w.run, "lead", "lead-reuse", { tile: "tile-reuse-lead" });
  const leadPeerId = lead.body.peer_id;
  await post(`${broker.url}/set-id`, { instance_token: lead.body.instance_token, new_peer_id: "lead-renamed" });
  const heir = await registerAttestedInstance(broker, w.run, "hReuseH", "/reuseH", { desk_session: "tile-reuse-heir" });
  await post(`${broker.url}/set-id`, { instance_token: heir.body.instance_token, new_peer_id: leadPeerId });

  const close = await closeInbox(broker, w.run, mandate, { entryId: w.entry.entry_id, reason: "x", instanceToken: heir.body.instance_token });

  expect(close.status).toBe(403);
  expect(entriesOf(w.run)[0]!.state).toBe("open");
});

// Mutant: the author proof checked against the envelope's run instead of the mandate's parent.
test("two Decks restoring the same workspace share a desk session id, and neither acts through the other's tile", async () => {
  const { runs } = await newRuns("tile-twin", 2);
  const [deckA, deckB] = runs as [RunCredential, RunCredential];
  const tileA = await registerAttestedInstance(broker, deckA, "hTwinA", "/twinA", { desk_session: "restored-tile" });
  const tileB = await registerAttestedInstance(broker, deckB, "hTwinB", "/twinB", { desk_session: "restored-tile" });
  await depositToOperator(broker, tileA.body.instance_token, "in deck A", deckA);
  const entry = entriesOf(deckA)[0]!;
  const mandateA = await mintMandate(broker, deckA, "lead", "lead-twin-a", { tile: "restored-tile" });

  const proofSignedByA = await closeInbox(broker, deckA, mandateA, { entryId: entry.entry_id, reason: "x", instanceToken: tileB.body.instance_token });
  const proofSignedByB = await closeInbox(broker, { cred: deckB.cred, tokenId: deckB.tokenId }, mandateA, { entryId: entry.entry_id, reason: "x", instanceToken: tileB.body.instance_token });

  expect([proofSignedByA.status, proofSignedByB.status]).toEqual([403, 403]);
  expect(entriesOf(deckA)[0]!.state).toBe("open");
});

// Mutants: state omitted from the list SELECT; next_cursor taken from the last row kept; the keyset not strict.
test("the list pages 20 open entries then the rest, oldest first, skips settled ones and stays exact across a close between pages", async () => {
  const { runs } = await newRuns("list-page", 2);
  const [run, otherRun] = runs as [RunCredential, RunCredential];
  const author = await registerAttestedInstance(broker, run, "hListA", "/listA", { desk_session: "list-tile-a" });
  const lead = await registerAttestedInstance(broker, run, "hListL", "/listL", { desk_session: "list-tile-lead" });
  const other = await registerAttestedInstance(broker, otherRun, "hListO", "/listO", { desk_session: "list-tile-o" });
  for (let i = 0; i < 27; i++) await depositToOperator(broker, author.body.instance_token, `note ${i}`, run);
  await depositToOperator(broker, other.body.instance_token, "other run", otherRun);
  const all = entriesOf(run);
  const mandate = await mintMandate(broker, run, "lead", "lead-list", { tile: "list-tile-lead" });
  const asLead = (cursor?: unknown) => listInbox<ListBody>(broker, run, mandate, { instanceToken: lead.body.instance_token, cursor });
  await replyTo(run, all[0]!);
  await closeInbox(broker, run, mandate, { entryId: all[1]!.entry_id, reason: "gone", instanceToken: lead.body.instance_token });

  const page1 = await asLead();
  expect(page1.status).toBe(200);
  expect(page1.body.entries).toHaveLength(20);
  expect(page1.body.next_cursor).toEqual(expect.any(String));
  const all2 = [...page1.body.entries!].find((e) => e.id === all[2]!.entry_id) ?? null;
  expect(all2).toEqual({
    id: all[2]!.entry_id,
    type: "message",
    author: author.body.peer_id,
    created_at: expect.any(String),
    text: "note 2",
    closable: true,
    message_id: all[2]!.message_id,
    sent_at: all[2]!.sent_at,
  });
  await closeInbox(broker, run, mandate, { entryId: page1.body.entries![5]!.id, reason: "between pages", instanceToken: lead.body.instance_token });
  const page2 = await asLead(page1.body.next_cursor);

  expect(page2.body.entries).toHaveLength(5);
  expect(page2.body.next_cursor).toBeNull();
  const seen = [...page1.body.entries!, ...page2.body.entries!].map((e) => e.id);
  const byInstantThenId = (rows: Array<{ id: string; at: number }>) =>
    [...rows].sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((r) => r.id);
  const open = all.slice(2).map((e) => ({ id: e.entry_id, at: Date.parse(e.created_at) }));
  expect(seen, "every open entry once, oldest first, none of another run").toEqual(byInstantThenId(open));
});

// Mutants: authorizeInboxEntry not applied to the list; next_cursor taken from the last row kept instead of the last row read.
test("an author lists only its own entries, and a page whose rows were all filtered out still hands a cursor", async () => {
  const { runs } = await newRuns("list-author", 1);
  const run = runs[0]!;
  const mine = await registerAttestedInstance(broker, run, "hMine", "/mine", { desk_session: "list-mine" });
  const theirs = await registerAttestedInstance(broker, run, "hTheirs", "/theirs", { desk_session: "list-theirs" });
  for (let i = 0; i < 21; i++) await depositToOperator(broker, theirs.body.instance_token, `theirs ${i}`, run);
  await depositToOperator(broker, mine.body.instance_token, "mine", run);
  const db = openBrokerDb(broker.dbPath);
  try {
    // Deposits a millisecond apart can tie; the author's entry must be the 22nd row.
    db.run("UPDATE inbox_message_entries SET created_at = ? WHERE author_instance_ref = ?", ["2099-01-01T00:00:00.000Z", deriveInstanceRef(mine.body.instance_token)]);
  } finally {
    db.close();
  }
  const mandate = await mintMandate(broker, run, "author", "author-list", { tile: "list-mine" });

  const page1 = await listInbox<ListBody>(broker, run, mandate, { instanceToken: mine.body.instance_token });
  const page2 = await listInbox<ListBody>(broker, run, mandate, { instanceToken: mine.body.instance_token, cursor: page1.body.next_cursor });

  expect(page1.body.entries).toEqual([]);
  expect(page1.body.next_cursor).toEqual(expect.any(String));
  expect(page2.body.entries!.map((e) => e.text)).toEqual(["mine"]);
  expect(page2.body.next_cursor).toBeNull();
});

// Mutant: the keyset compares created_at as TEXT; a malformed cursor read as no cursor.
test("the cursor orders on the instant, not on the text of the timestamp, and a malformed cursor is a 400", async () => {
  const w = await depositedEntry("list-instant");
  await depositToOperator(broker, w.token, "later", w.run);
  const [early, late] = entriesOf(w.run) as [EntryRow, EntryRow];
  const db = openBrokerDb(broker.dbPath);
  try {
    db.run("UPDATE inbox_message_entries SET created_at = ? WHERE entry_id = ?", ["2030-01-01T10:00:00.000+05:00", early.entry_id]);
    db.run("UPDATE inbox_message_entries SET created_at = ? WHERE entry_id = ?", ["2030-01-01T06:00:00.000Z", late.entry_id]);
  } finally {
    db.close();
  }
  const mandate = await mintMandate(broker, w.run, "lead", "lead-instant", { tile: w.tile });
  const cursor = Buffer.from(JSON.stringify({ t: "2030-01-01T10:00:00.000+05:00", id: early.entry_id })).toString("base64url");

  const afterEarly = await listInbox<ListBody>(broker, w.run, mandate, { instanceToken: w.token, cursor });
  expect(afterEarly.body.entries!.map((e) => e.id), "05:00Z sorts before 06:00Z").toEqual([late.entry_id]);

  const refused: number[] = [];
  for (const bad of ["", 7, "!!", Buffer.from("{}").toString("base64url"), Buffer.from(JSON.stringify({ t: "x", id: early.entry_id })).toString("base64url"), Buffer.from(JSON.stringify({ t: early.created_at, id: "42" })).toString("base64url"), "a".repeat(257)]) {
    refused.push((await listInbox<ListBody>(broker, w.run, mandate, { instanceToken: w.token, cursor: bad })).status);
  }
  expect(refused).toEqual([400, 400, 400, 400, 400, 400, 400]);
});

// Mutant: a row projected by spread instead of the pick-list.
test("a listed entry carries the pick-list only: no reply token, instance digest, tile or caller", async () => {
  const w = await depositedEntry("list-canary", "canary list body");
  const mandate = await mintMandate(broker, w.run, "lead", "lead-list-canary", { tile: w.tile });
  const db = openBrokerDb(broker.dbPath);
  try {
    db.run("ALTER TABLE inbox_message_entries ADD COLUMN list_canary TEXT");
    db.run("UPDATE inbox_message_entries SET list_canary = 'LIST-CANARY' WHERE run_ref = ?", [w.run.run]);
  } finally {
    db.close();
  }

  const read = await listInbox<ListBody>(broker, w.run, mandate, { instanceToken: w.token });
  const wire = JSON.stringify(read.body);
  expect(Object.keys(read.body.entries![0]!).sort()).toEqual(["author", "closable", "created_at", "id", "message_id", "sent_at", "text", "type"]);
  for (const secret of [w.entry.reply_token, w.token, deriveInstanceRef(w.token), "LIST-CANARY", "lead-list-canary"]) {
    expect(wire).not.toContain(secret);
  }
});

/**
 * The real tile tools, a real deck-control server and the main's inbox
 * actions in front of the shared broker, for a supervisor tile of `w`'s run.
 */
async function inboxToolChain(w: Awaited<ReturnType<typeof depositedEntry>>, label: string) {
  const tile = `${label}-sup-tile`;
  const supTile = await registerAttestedInstance(broker, w.run, `h-${label}-sup`, `/${label}-sup`, { desk_session: tile });
  const minted = await mintMandate(broker, w.run, "supervisor", `supervisor-${label}`, { tile });
  const ready = {
    tokenId: minted.tokenId,
    privateKey: minted.cred.privateKey,
    expiresAt: "2099-01-01T00:00:00.000Z",
    deps: { endpoint: { url: broker.url, token: null }, identity: { operatorId: FIXTURE_OPERATOR_ID }, projectKey: INBOX_TEST_PROJECT },
  } as never;
  const asked: string[] = [];
  const deps = {
    inboxMandates: { request: () => {}, release: () => {}, releaseTile: () => {} },
    listSessions: () => [{ id: tile, supervisor: true, status: "running" }],
    inbox: createInboxActions({
      mandate: async (callerId, forTile) => {
        asked.push(`${callerId}@${forTile}`);
        return ready;
      },
      localCourrier: () => ({ history: [{ id: w.entry.message_id, from: w.peerId, text: "x", sentAt: w.entry.sent_at }], acks: {} }),
    }),
  } as unknown as DeckControlDeps;
  const control = await startDeckControl(deps);
  const credDir = mkdtempSync(join(tmpdir(), "inbox-chain-"));
  const credFile = join(credDir, "run-cred.json");
  writeFileSync(credFile, JSON.stringify({
    brokerUrl: broker.url, operatorId: FIXTURE_OPERATOR_ID, tokenId: w.run.tokenId,
    privateKey: w.run.cred.privateKey, publicKey: w.run.cred.publicKey,
    inbox: { version: 1, run_ref: w.run.run, group_id: w.run.group },
  }));
  const ctx: OperatorToolContext = {
    broker: {} as never,
    env: { CLAUDE_PEERS_APPROVAL_FILE: credFile },
    role: null,
    cwd: "/",
    log: { log: () => {}, logError: () => {} },
    deck: { url: control.url, token: control.token },
  };
  const identity: CompanionIdentity = {
    host: `h-${label}-sup`, peerId: supTile.body.peer_id, groupId: w.run.group, instanceToken: supTile.body.instance_token,
    inboxBinding: { version: 1, runRef: w.run.run, groupId: w.run.group }, operatorId: FIXTURE_OPERATOR_ID, projectKey: "", fromPeer: supTile.body.peer_id,
  };
  return {
    supTile, tile, asked, ctx, identity,
    stop: () => {
      control.close();
      rmSync(credDir, { recursive: true, force: true });
    },
  };
}

// Mutant: any signature, gate or body field the tile, the Deck main and the broker disagree on.
test("end to end: the tile tools through deck-control and the main's mandate envelope list then close an entry at the broker", async () => {
  const w = await depositedEntry("chain-e2e");
  const chain = await inboxToolChain(w, "chain-e2e");
  try {
    const listed = await handleInboxList({}, chain.identity, chain.ctx);
    expect(JSON.parse(listed.content[0]!.text)).toEqual({
      entries: [{ id: w.entry.entry_id, type: "message", author: w.peerId, created_at: expect.any(String), text: w.entry.excerpt, closable: true }],
      next_cursor: null,
    });
    const closed = await handleInboxClose({ id: w.entry.entry_id, reason: "superseded by the plan" }, chain.identity, chain.ctx);
    const again = await handleInboxClose({ id: w.entry.entry_id, reason: "superseded by the plan" }, chain.identity, chain.ctx);

    expect(closed.content[0]!.text).toBe(`Closed ${w.entry.entry_id}.`);
    expect(again.content[0]!.text).toBe("Not closed: the item is already closed.");
    expect(entriesOf(w.run)[0]).toMatchObject({
      state: "closed",
      closed_by_authority: "supervisor",
      closed_by_peer_id_snapshot: chain.supTile.body.peer_id,
      close_reason: "superseded by the plan",
    });
    expect(chain.asked.every((a) => a === `supervisor@${chain.tile}`)).toBe(true);
  } finally {
    chain.stop();
  }
});

// Mutant: the tool chain reaching the broker without waking the author's parked wait.
test("end to end: inbox_close on an attested question wakes the author's parked wait with closed", async () => {
  const w = await depositedEntry("chain-question");
  const chain = await inboxToolChain(w, "chain-question");
  try {
    const askBody: Record<string, unknown> = {
      project_key: INBOX_TEST_PROJECT, kind: "question", merge: "never", title: "Which way?", question: "Left or right?",
      reply_route: "channel", origin: { host: "h-chain-question" }, instance_token: w.token, public_key: w.run.cred.publicKey,
    };
    const asked = await post<{ approval: Approval }>(`${broker.url}/approval/add`, { ...askBody, auth: runInboxProof(w.run, askBody, INBOX_GATES.channel) });
    expect(asked.status).toBe(200);
    const questionId = asked.body.approval.id;
    const waitBody = { project_key: INBOX_TEST_PROJECT, id: questionId, timeout_sec: 30, public_key: w.run.cred.publicKey };
    const waiting = post<{ approval?: Approval }>(`${broker.url}/approval/wait`, {
      ...waitBody,
      auth: buildAuthProof(w.run.cred.privateKey, waitBody, { kind: "session", operator_id: FIXTURE_OPERATOR_ID, token_id: w.run.tokenId }),
    });
    let settled = false;
    void waiting.then(() => {
      settled = true;
    });
    await get(`${broker.url}/health`);
    expect(settled, "the wait is parked, not answered, before the close").toBe(false);

    const closed = await handleInboxClose({ id: questionId, reason: "no longer needed" }, chain.identity, chain.ctx);
    const woken = await reachedWithin(waiting, "the parked wait after the tool's close");

    expect(closed.content[0]!.text).toBe(`Closed ${questionId}.`);
    expect(woken.body.approval).toMatchObject({ id: questionId, status: "closed", close_reason: "no longer needed", closed_by_authority: "supervisor" });
  } finally {
    chain.stop();
  }
});

// --- Run drain: state snapshot of the run's registry rows ---

interface EntryStateWire {
  message_id: number;
  sent_at: string;
  state: string;
  settled_at: string | null;
  close_reason?: string;
  closed_by_authority?: string;
  closed_by_peer_id?: string | null;
}
const entriesWire = (r: { body: unknown }): EntryStateWire[] => (r.body as { entries: EntryStateWire[] }).entries;

// Mutants: run_ref dropped from the snapshot WHERE; the snapshot read outside the drain transaction (it would miss the rows drained in the same call).
test("the run drain carries exactly the registry rows of its run, the ones of the messages it just drained included", async () => {
  const { runs } = await newRuns("snap-scope", 2);
  const [runA, runB] = runs as [RunCredential, RunCredential];
  const a = await registerAttestedInstance(broker, runA, "hSnapA", "/snapA");
  const b = await registerAttestedInstance(broker, runB, "hSnapB", "/snapB");
  await depositToOperator(broker, a.body.instance_token, "from A", runA);
  await depositToOperator(broker, b.body.instance_token, "from B", runB);
  const [rowA] = entriesOf(runA) as [EntryRow];
  const [rowB] = entriesOf(runB) as [EntryRow];

  const first = await drainRun(runA, "snap-session");
  expect(runTexts(first), "the message and its state arrive in the same call").toEqual(["from A"]);
  expect(entriesWire(first)).toEqual([{ message_id: rowA.message_id, sent_at: rowA.sent_at, state: "open", settled_at: null }]);

  const again = await drainRun(runA, "snap-session");
  expect(runTexts(again), "the cursor is spent").toEqual([]);
  expect(entriesWire(again).map((e) => e.message_id), "the snapshot is not a cursor").toEqual([rowA.message_id]);
  expect(entriesWire(await drainRun(runB, "snap-session")).map((e) => e.message_id)).toEqual([rowB.message_id]);
});

// Mutants: the legacy drain given entries; the snapshot ignoring a state change.
test("a closed and a responded entry show their state in the snapshot, and the legacy drain never carries entries", async () => {
  const w = await depositedEntry("snap-state");
  await depositToOperator(broker, w.token, "second", w.run);
  const [closing, replying] = entriesOf(w.run) as [EntryRow, EntryRow];
  const lead = await mintMandate(broker, w.run, "lead", "lead-snap", { tile: w.tile });
  await closeInbox(broker, w.run, lead, { entryId: closing.entry_id, reason: "no longer needed", instanceToken: w.token });
  await replyTo(w.run, replying);

  const byId = Object.fromEntries(entriesWire(await drainRun(w.run, "snap-state-session")).map((e) => [e.message_id, e]));
  expect(byId[closing.message_id]).toMatchObject({
    state: "closed",
    close_reason: "no longer needed",
    closed_by_authority: "lead",
    closed_by_peer_id: w.peerId,
  });
  expect(byId[replying.message_id]).toMatchObject({ state: "responded" });
  expect(byId[replying.message_id]).not.toHaveProperty("close_reason");

  expect(Object.keys((await drain(w.g)).body)).toEqual(["messages"]);
  expect(Object.keys((await drainAs(w.g, "snap-legacy")).body)).toEqual(["messages"]);
});

// Mutants: messageEntryView reused (leaks entry_id and excerpt); a spread of the row instead of the pick-list (leaks every column, a future one included).
test("the snapshot is a pick-list: no entry id, excerpt, token or instance ref, and an unknown registry column stays out", async () => {
  const w = await depositedEntry("snap-canary", "a recognisable excerpt body");
  const lead = await mintMandate(broker, w.run, "lead", "lead-canary", { tile: w.tile });
  await closeInbox(broker, w.run, lead, { entryId: w.entry.entry_id, reason: "canary", instanceToken: w.token });
  const db = openBrokerDb(broker.dbPath);
  try {
    db.run("ALTER TABLE inbox_message_entries ADD COLUMN snap_canary TEXT");
    db.run("UPDATE inbox_message_entries SET snap_canary = 'CANARY-VALUE' WHERE run_ref = ?", [w.run.run]);
  } finally {
    db.close();
  }

  const read = await drainRun(w.run, "snap-canary-session");
  const wire = JSON.stringify(entriesWire(read));
  expect(Object.keys(entriesWire(read)[0]!).sort()).toEqual([
    "close_reason",
    "closed_by_authority",
    "closed_by_peer_id",
    "message_id",
    "sent_at",
    "settled_at",
    "state",
  ]);
  for (const secret of [w.entry.entry_id, w.entry.excerpt, w.token, deriveInstanceRef(w.token), "CANARY-VALUE"]) {
    expect(wire).not.toContain(secret);
  }
});

// Mutants: LIMIT removed; ORDER BY ascending (the newest would fall out instead of the oldest).
test("the snapshot holds at most 500 rows, the newest messages first", async () => {
  const w = await depositedEntry("snap-cap");
  const db = openBrokerDb(broker.dbPath);
  try {
    for (let i = 0; i < 505; i++) {
      db.run(
        `INSERT INTO inbox_message_entries (entry_id, operator_id, run_ref, group_id, project_key, message_id, sent_at,
           author_instance_ref, author_peer_id_snapshot, reply_token, excerpt, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'ref', 'peer', '', '', ?)`,
        [`m_${crypto.randomUUID()}`, FIXTURE_OPERATOR_ID, w.run.run, w.run.group, INBOX_TEST_PROJECT, 900000 + i, "2026-01-01T00:00:00.000Z", new Date().toISOString()]
      );
    }
  } finally {
    db.close();
  }

  const ids = entriesWire(await drainRun(w.run, "snap-cap-session")).map((e) => e.message_id);
  expect(ids).toHaveLength(500);
  expect(ids[0]).toBe(900504);
  expect(ids, "ordered newest first").toEqual([...ids].sort((x, y) => y - x));
  expect(ids).not.toContain(w.entry.message_id);
});
