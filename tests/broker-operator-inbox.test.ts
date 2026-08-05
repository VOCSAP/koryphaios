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

async function register(host: string, cwd: string, group: { id: string; hash: string } | null = null) {
  return post<{ peer_id: string; instance_token: string }>(`${broker.url}/register`, {
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

async function sendToOperator(fromToken: string, text: string) {
  return post<{ ok: boolean; error?: string }>(`${broker.url}/send-message`, {
    from_token: fromToken,
    to_peer_id: "operator",
    text,
  });
}

async function drain(group: { id: string; hash: string | null }) {
  return post<{ messages: { id: number; from_peer_id: string; text: string; sent_at: string }[] } | { error: string }>(
    `${broker.url}/operator-inbox`,
    { group_id: group.id, group_secret_hash: group.hash }
  );
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
