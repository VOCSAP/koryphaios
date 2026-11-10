import { describe, expect, test } from "bun:test";
import { createInboxActions, parseInboxRequest, type InboxActionOutcome, type InboxActionRequest, type LocalCourrier } from "../desktop/src/main/inbox-actions.ts";
import type { ReadyMandate } from "../desktop/src/main/approval-runtime.ts";
import { onDeckError } from "../desktop/src/main/log.ts";
import { generateCredential, INBOX_GATES, verifyInboxProof } from "../shared/approval.ts";

const ENTRY = "m_" + "0123abcd-0123-4123-8123-0123456789ab";
const QUESTION = "0123abcd-0123-4123-8123-0123456789ab";
const TILE_INSTANCE = ["tile", "instance", "marker"].join("-");
const OPERATOR = "operator-of-the-run";

const closeBody = (payloadOver: Record<string, unknown> = {}, over: Record<string, unknown> = {}) => ({
  op: "close",
  author: { payload: { inbox_operation: "close", entry_id: ENTRY, reason: "stale", instance_token: TILE_INSTANCE, ...payloadOver }, auth: { sig: "s" } },
  ...over,
});
const listBody = (over: Record<string, unknown> = {}) => ({
  op: "list",
  author: { payload: { inbox_operation: "list", instance_token: TILE_INSTANCE }, auth: { sig: "s" } },
  ...over,
});

function parsed(body: unknown): InboxActionRequest {
  const r = parseInboxRequest(body);
  if ("invalid" in r) throw new Error(`refused: ${r.invalid}`);
  return r;
}

describe("parseInboxRequest", () => {
  // Mutant: the payload keys checked as a subset instead of exactly.
  test("an author payload carrying any key beyond its operation's is invalid", () => {
    for (const extra of [{ authority: "supervisor" }, { role: "lead" }, { run_ref: "x" }, { cursor: "c" }]) {
      expect({ extra, got: parseInboxRequest(closeBody(extra)) }).toEqual({ extra, got: { invalid: "author payload carries unexpected fields" } });
    }
    expect(parseInboxRequest(listBody({ author: { payload: { inbox_operation: "list", instance_token: TILE_INSTANCE, entry_id: ENTRY }, auth: {} } }))).toEqual({
      invalid: "author payload carries unexpected fields",
    });
  });

  // Mutant: top-level members spread into the parsed request.
  test("top-level members other than op, cursor and author are dropped", () => {
    expect(parsed(closeBody({}, { authority: "supervisor", tile: "t", canary: 1 }))).toEqual({
      op: "close",
      entryId: ENTRY,
      author: { payload: { inbox_operation: "close", entry_id: ENTRY, reason: "stale", instance_token: TILE_INSTANCE }, auth: { sig: "s" } },
    });
    expect(parsed(listBody({ cursor: "abc", canary: 1 }))).toEqual({
      op: "list",
      cursor: "abc",
      author: { payload: { inbox_operation: "list", instance_token: TILE_INSTANCE }, auth: { sig: "s" } },
    });
  });

  // Mutants: the reason accepted raw; a length boundary dropped; the id or instance unchecked.
  test("the reason must already be the cleaned value, within 1..500, and id, instance, op and cursor are bounded", () => {
    const refusals = [
      closeBody({ reason: "line one\nline two" }),
      closeBody({ reason: "" }),
      closeBody({ reason: "x".repeat(501) }),
      closeBody({ reason: 7 }),
      closeBody({ entry_id: "42" }),
      closeBody({ entry_id: "m_short" }),
      closeBody({ instance_token: "" }),
      closeBody({ instance_token: "i".repeat(129) }),
      closeBody({ inbox_operation: "list" }),
      closeBody({}, { op: "delete" }),
      listBody({ cursor: "" }),
      listBody({ cursor: "c".repeat(257) }),
      listBody({ cursor: 3 }),
      { op: "close" },
      null,
    ].map((b) => "invalid" in parseInboxRequest(b));
    expect(refusals.every(Boolean), JSON.stringify(refusals)).toBe(true);
    expect(parsed(closeBody({ entry_id: QUESTION, reason: "x".repeat(500) })).op).toBe("close");
  });
});

function mandate(): { ready: ReadyMandate; publicKey: string } {
  const cred = generateCredential();
  return {
    publicKey: cred.publicKey,
    ready: {
      tokenId: "mandate-token-id",
      privateKey: cred.privateKey,
      expiresAt: "2099-01-01T00:00:00.000Z",
      deps: { endpoint: { url: "http://broker.test", token: null }, identity: { operatorId: OPERATOR }, projectKey: "p" } as never,
    },
  };
}

type Sent = { url: string; body: Record<string, unknown> };

function harness(answer: { status: number; body: unknown } | Error, local: LocalCourrier = { history: [], acks: {} }, ready: ReadyMandate | null = mandate().ready) {
  const sent: Sent[] = [];
  const asked: Array<[string, string]> = [];
  const actions = createInboxActions({
    mandate: async (callerId, tile) => {
      asked.push([callerId, tile]);
      return ready;
    },
    localCourrier: () => local,
    fetchFn: (async (url: string, init: RequestInit) => {
      sent.push({ url, body: JSON.parse(String(init.body)) });
      if (answer instanceof Error) throw answer;
      return new Response(JSON.stringify(answer.body), { status: answer.status });
    }) as never,
  });
  return { actions, sent, asked };
}

describe("createInboxActions", () => {
  // Mutants: the broker body spread from the request; entry_id or reason taken from anywhere but the signed payload; the envelope signed under the wrong gate.
  test("a close posts a pick-list envelope signed by the mandate, entry and reason copied from the author payload", async () => {
    const m = mandate();
    const h = harness({ status: 200, body: { entry: {} } }, undefined, m.ready);
    const request = parsed(closeBody());
    (request as unknown as Record<string, unknown>).canary = "CANARY";

    const outcome = await h.actions.run("team-lead-1", "tile-L", "lead", request);

    expect(outcome).toEqual({ outcome: "closed", id: ENTRY });
    expect(h.asked).toEqual([["team-lead-1", "tile-L"]]);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.url).toBe("http://broker.test/inbox/close");
    const { auth, ...body } = h.sent[0]!.body;
    expect(Object.keys(body).sort()).toEqual(["author", "entry_id", "inbox_operation", "reason"]);
    expect(body).toMatchObject({ inbox_operation: "close", entry_id: ENTRY, reason: "stale" });
    expect(JSON.stringify(h.sent[0]!.body)).not.toContain("CANARY");
    expect((auth as { token_id?: string }).token_id).toBe("mandate-token-id");
    expect(verifyInboxProof(m.publicKey, body, auth as never, INBOX_GATES.mandateClose).ok).toBe(true);
    expect(verifyInboxProof(m.publicKey, body, auth as never, INBOX_GATES.mandateList).ok).toBe(false);
  });

  // Mutant: the outcome read from the error text instead of the status.
  test("the outcome follows the HTTP status, never the text", async () => {
    const cases: Array<[number, unknown, InboxActionOutcome]> = [
      [400, { error: "reason must not be empty" }, { outcome: "invalid", message: "reason must not be empty" }],
      [403, { error: "entry-settled" }, { outcome: "forbidden" }],
      [404, { error: "already-settled" }, { outcome: "unknown" }],
      [409, { error: "unknown entry", state: "closed" }, { outcome: "settled", state: "closed" }],
      [422, { error: "not-closable" }, { outcome: "not-closable" }],
      [401, { error: "replayed-proof" }, { outcome: "unavailable", cause: "broker status 401" }],
      [503, {}, { outcome: "unavailable", cause: "broker status 503" }],
    ];
    for (const [status, body, expected] of cases) {
      const h = harness({ status, body });
      expect({ status, got: await h.actions.run("c", "t", "lead", parsed(closeBody())) }).toEqual({ status, got: expected });
    }
  });

  // Mutants: no mandate still calls the broker; a network failure thrown instead of answered.
  test("no ready mandate or an unreachable broker is unavailable, traced without the reason or the instance", async () => {
    const errors: string[] = [];
    onDeckError((_scope, text) => errors.push(text));
    try {
      const noMandate = harness({ status: 200, body: {} }, undefined, null);
      expect(await noMandate.actions.run("c", "t", "lead", parsed(closeBody({ reason: "SECRET-REASON" })))).toEqual({ outcome: "unavailable", cause: "mandate not ready" });
      expect(noMandate.sent).toEqual([]);

      const before = errors.length;
      const down = harness(new Error("connect ECONNREFUSED"));
      expect((await down.actions.run("c", "t", "lead", parsed(closeBody({ reason: "SECRET-REASON" })))).outcome).toBe("unavailable");
      expect(errors.length - before, "one trace for an unreachable broker").toBe(1);
      expect(errors.at(-1)).toContain("ECONNREFUSED");
      for (const line of errors) {
        expect(line).not.toContain("SECRET-REASON");
        expect(line).not.toContain(TILE_INSTANCE);
      }
    } finally {
      onDeckError(() => {});
    }
  });

  // Mutant: the broker Bearer dropped in remote mode.
  test("the broker call carries the endpoint's Bearer when the broker is remote, and none when it is local", async () => {
    const seen: Array<string | undefined> = [];
    const remoteBearer = ["remote", "broker", "bearer"].join("-");
    for (const bearer of [remoteBearer, null]) {
      const m = mandate();
      (m.ready.deps as { endpoint: { token: string | null } }).endpoint.token = bearer;
      const actions = createInboxActions({
        mandate: async () => m.ready,
        localCourrier: () => ({ history: [], acks: {} }),
        fetchFn: (async (_url: string, init: RequestInit) => {
          seen.push((init.headers as Record<string, string>).Authorization);
          return new Response(JSON.stringify({ entry: {} }), { status: 200 });
        }) as never,
      });
      await actions.run("c", "t", "lead", parsed(closeBody()));
    }
    expect(seen).toEqual([`Bearer ${remoteBearer}`, undefined]);
  });

  // Mutants: acked messages kept; messages absent from the local history kept; the key built on the id alone; message_id/sent_at left in the agent view.
  test("a list keeps only the messages this Deck holds unacked, keeps questions, and hides the Deck's local key", async () => {
    const item = (id: string, type: "message" | "question", extra: Record<string, unknown> = {}) => ({
      id, type, author: "peer-a", created_at: "2026-01-01T00:00:00.000Z", text: `text ${id}`, closable: true, ...extra,
    });
    const answer = {
      entries: [
        item("m_open", "message", { message_id: 1, sent_at: "2026-01-01T00:00:01.000Z" }),
        item("m_acked", "message", { message_id: 2, sent_at: "2026-01-01T00:00:02.000Z" }),
        item("m_absent", "message", { message_id: 3, sent_at: "2026-01-01T00:00:03.000Z" }),
        item("m_other_time", "message", { message_id: 4, sent_at: "2026-01-01T00:00:04.000Z" }),
        item(QUESTION, "question", { closable: false }),
      ],
      next_cursor: "next",
    };
    const local: LocalCourrier = {
      history: [
        { id: 1, from: "peer-a", text: "x", sentAt: "2026-01-01T00:00:01.000Z" },
        { id: 2, from: "peer-a", text: "x", sentAt: "2026-01-01T00:00:02.000Z" },
        { id: 4, from: "peer-a", text: "x", sentAt: "2025-12-31T00:00:00.000Z" },
      ],
      acks: { "msg:2026-01-01T00:00:02.000Z:2": "acked", "msg:2026-01-01T00:00:01.000Z:1": "seen" },
    };
    const h = harness({ status: 200, body: answer }, local);

    const got = await h.actions.run("c", "t", "supervisor", parsed(listBody({ cursor: "prev" })));

    expect(got).toEqual({
      outcome: "listed",
      entries: [
        { id: "m_open", type: "message", author: "peer-a", created_at: "2026-01-01T00:00:00.000Z", text: "text m_open", closable: true },
        { id: QUESTION, type: "question", author: "peer-a", created_at: "2026-01-01T00:00:00.000Z", text: `text ${QUESTION}`, closable: false },
      ],
      next_cursor: "next",
    });
    expect(h.sent[0]!.url).toBe("http://broker.test/inbox/list");
    expect(h.sent[0]!.body).toMatchObject({ inbox_operation: "list", cursor: "prev" });
  });
});
