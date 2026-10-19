// The ntfy enrolment route (PLAN N5), against a STUB ntfy on loopback.
//
// The other two channels can only be tested for their failure path offline
// (`getMe` never answers), which leaves the happy path uncovered. ntfy's
// protocol is small enough to stand up locally, so this suite exercises the
// real route end to end: mint topics, probe the server, seal the config, hand
// back the QR payload — without ever leaving 127.0.0.1.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  post,
  startBroker,
  stopBroker,
  approvalListBody,
  type TestBroker,
  openBrokerDb,
} from "./_helper.ts";
import {
  buildAuthProof,
  deriveOperatorId,
  generateCredential,
  type ApprovalCredential,
} from "../shared/approval.ts";
import { decodePairingPayload, encodeAnswer, encodePair, parseClickUrl } from "../notify/ntfy-protocol.ts";
import { OPERATOR_TRUST_VERSION } from "../shared/operator-trust.ts";
import type { Approval } from "../shared/types.ts";

type Operator = { cred: ApprovalCredential; id: string };

// Channels, bindings, pairing codes and approvals are all keyed by operator,
// so a test isolates itself on the shared broker by taking operators nobody
// else uses. The pool is trusted by that broker at boot.
const operatorPool: Operator[] = Array.from({ length: 40 }, () => {
  const cred = generateCredential();
  return { cred, id: deriveOperatorId(cred.publicKey) };
});

function freshOperator(): Operator {
  const op = operatorPool.pop();
  if (!op) throw new Error("operator pool exhausted: grow it");
  return op;
}

let shared: TestBroker;
const brokers: TestBroker[] = [];
const stubs: StubNtfy[] = [];
beforeAll(async () => {
  shared = await startBroker({}, { trustedOperators: operatorPool.map((o) => o.cred.publicKey) });
  brokers.push(shared);
});
afterAll(async () => {
  for (const b of brokers) await stopBroker(b);
  for (const s of stubs) s.stop();
});

async function signedPost<T>(
  b: TestBroker,
  path: string,
  payload: Record<string, unknown>,
  op: Operator
): Promise<{ status: number; body: T }> {
  // The default project_key mirrors the payload's own origin.project_key rather
  // than a fixed literal, since this file's approvals are filed under two
  // different project keys and a single hardcoded default would silently list
  // an empty set for the other.
  // Falls back to "p" because most approvals here use it and /approval/claim
  // carries no origin to mirror.
  const originKey = (payload.origin as { project_key?: string } | undefined)?.project_key;
  const body = {
    project_key: originKey ?? "p",
    ...payload,
    public_key: op.cred.publicKey,
  };
  const auth = buildAuthProof(op.cred.privateKey, body, { kind: "operator", operator_id: op.id });
  return post<T>(`${b.url}${path}`, { ...body, auth });
}

interface StubNtfy {
  url: string;
  stop: () => void;
  /** Bearer tokens the stub was handed, in order. */
  seen: string[];
  /** Everything published, per topic — what the broker sent to the phone. */
  published: Map<string, Array<Record<string, unknown>>>;
  /** Publish as the PHONE would: a raw body on `/{topic}`. */
  publishRaw: (topic: string, message: string) => Promise<void>;
}

/**
 * A minimal ntfy: health, a streaming subscribe, and a publish that fans out to
 * live subscribers. Enough to run the real two-topic loop on loopback.
 */
function startStubNtfy(opts: { requireToken?: string; unhealthy?: boolean } = {}): StubNtfy {
  const seen: string[] = [];
  const published = new Map<string, Array<Record<string, unknown>>>();
  const subscribers = new Map<string, Set<ReadableStreamDefaultController<Uint8Array>>>();
  let msgSeq = 0;

  const deliver = (topic: string, message: string): void => {
    const frame = `${JSON.stringify({ id: `m${++msgSeq}`, event: "message", topic, message })}\n`;
    for (const c of subscribers.get(topic) ?? []) {
      try {
        c.enqueue(new TextEncoder().encode(frame));
      } catch {
        /* subscriber went away */
      }
    }
  };

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
      if (bearer) seen.push(bearer);
      if (url.pathname === "/v1/health") {
        return Response.json({ healthy: !opts.unhealthy });
      }
      if (opts.requireToken && bearer !== opts.requireToken) {
        return new Response("unauthorized", { status: 401 });
      }

      if (req.method === "POST") {
        const raw = await req.text();
        const path = url.pathname.replace(/^\/+/, "");
        if (path) {
          // Phone-style publish: the topic is the path, the body is the message.
          deliver(path, raw);
        } else {
          // Broker-style publish: a JSON envelope naming its own topic.
          const body = JSON.parse(raw) as Record<string, unknown>;
          const topic = String(body.topic ?? "");
          published.set(topic, [...(published.get(topic) ?? []), body]);
          deliver(topic, String(body.message ?? ""));
        }
        return Response.json({ id: `stub-${++msgSeq}` });
      }

      if (url.searchParams.get("poll") === "1") return new Response("", { status: 200 });

      // The subscription: held open, so the adapter reports itself ready
      // instead of hot-looping through reconnects for the whole suite.
      const topic = url.pathname.replace(/^\/+/, "").replace(/\/json$/, "");
      let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            controller = c;
            c.enqueue(new TextEncoder().encode(`${JSON.stringify({ id: "s0", event: "open" })}\n`));
            const set = subscribers.get(topic) ?? new Set();
            set.add(c);
            subscribers.set(topic, set);
          },
          cancel(reason) {
            void reason;
            // Drop THIS controller, not every subscriber on the topic: the
            // blunt delete happens to work with one subscriber and would fail
            // silently the day a test used two.
            subscribers.get(topic)?.delete(controller);
          },
        }),
        { status: 200, headers: { "content-type": "application/x-ndjson" } }
      );
    },
  });

  const base = `http://127.0.0.1:${server.port}`;
  const stub: StubNtfy = {
    url: base,
    stop: () => server.stop(true),
    seen,
    published,
    publishRaw: async (topic, message) => {
      await fetch(`${base}/${topic}`, {
        method: "POST",
        body: message,
        ...(opts.requireToken ? { headers: { authorization: `Bearer ${opts.requireToken}` } } : {}),
      });
    },
  };
  stubs.push(stub);
  return stub;
}

/** Poll a condition instead of sleeping a fixed amount. */
async function until(check: () => Promise<boolean> | boolean, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await Bun.sleep(25);
  }
  return false;
}

describe("ntfy enrolment", () => {
  test("connect mints two topics and hands back a scannable payload", async () => {
    const b = shared;
    const ntfy = startStubNtfy();
    const op = freshOperator();

    const res = await signedPost<{
      kind: string;
      label: string;
      hint: string;
      pairing_code: string;
      mobile_payload: string;
    }>(b, "/approval/channel-connect", { kind: "ntfy", server: ntfy.url }, op);

    expect(res.status).toBe(200);
    expect(res.body.kind).toBe("ntfy");
    const payload = decodePairingPayload(res.body.mobile_payload);
    expect(payload).not.toBeNull();
    expect(payload!.server).toBe(ntfy.url);
    expect(payload!.code).toBe(res.body.pairing_code);
    // Two DISTINCT unguessable topics, one per direction.
    expect(payload!.topic_notif).toMatch(/^[0-9a-f]{48}$/);
    expect(payload!.topic_replies).toMatch(/^[0-9a-f]{48}$/);
    expect(payload!.topic_notif).not.toBe(payload!.topic_replies);
    // The hint identifies the server; it is not a fragment of a secret.
    expect(res.body.hint).toContain("127.0.0.1");
  }, 60_000);

  test("the row shows connected, and disconnect clears it", async () => {
    const b = shared;
    const ntfy = startStubNtfy();
    const op = freshOperator();

    await signedPost(b, "/approval/channel-connect", { kind: "ntfy", server: ntfy.url }, op);
    const list = await signedPost<{ channels: Array<Record<string, unknown>> }>(
      b,
      "/approval/channel-list",
      {},
      op
    );
    const row = list.body.channels.find((c) => c.kind === "ntfy")!;
    expect(row.configured).toBe(true);
    expect(row.connected).toBe(true);
    // Not yet scanned: pairing is what creates the binding.
    expect(row.paired).toBe(0);

    await signedPost(b, "/approval/channel-disconnect", { kind: "ntfy" }, op);
    const after = await signedPost<{ channels: Array<Record<string, unknown>> }>(
      b,
      "/approval/channel-list",
      {},
      op
    );
    expect(after.body.channels.find((c) => c.kind === "ntfy")!.configured).toBe(false);
  }, 60_000);

  test("reconnecting mints FRESH topics, so a revoked phone goes deaf", async () => {
    const b = shared;
    const ntfy = startStubNtfy();
    const op = freshOperator();

    const first = await signedPost<{ mobile_payload: string }>(
      b,
      "/approval/channel-connect",
      { kind: "ntfy", server: ntfy.url },
      op
    );
    const second = await signedPost<{ mobile_payload: string }>(
      b,
      "/approval/channel-connect",
      { kind: "ntfy", server: ntfy.url },
      op
    );
    const a = decodePairingPayload(first.body.mobile_payload)!;
    const c = decodePairingPayload(second.body.mobile_payload)!;
    expect(c.topic_notif).not.toBe(a.topic_notif);
    expect(c.topic_replies).not.toBe(a.topic_replies);
  }, 60_000);

  test("reconnecting drops the old binding — this IS the lost-phone kill switch", async () => {
    const b = shared;
    const ntfy = startStubNtfy();
    const op = freshOperator();

    const first = await signedPost<{ mobile_payload: string }>(
      b,
      "/approval/channel-connect",
      { kind: "ntfy", server: ntfy.url },
      op
    );
    const old = decodePairingPayload(first.body.mobile_payload)!;
    await ntfy.publishRaw(old.topic_replies, encodePair(old.code, "Lost phone"));
    const paired = await until(async () => {
      const list = await signedPost<{ channels: Array<Record<string, unknown>> }>(
        b,
        "/approval/channel-list",
        {},
        op
      );
      return list.body.channels.find((c) => c.kind === "ntfy")!.paired === 1;
    });
    expect(paired).toBe(true);

    // The operator reconnects after losing the phone.
    const reconnect = await signedPost<{ mobile_payload: string }>(
      b,
      "/approval/channel-connect",
      { kind: "ntfy", server: ntfy.url },
      op
    );
    const fresh = decodePairingPayload(reconnect.body.mobile_payload)!;
    const list = await signedPost<{ channels: Array<Record<string, unknown>> }>(
      b,
      "/approval/channel-list",
      {},
      op
    );
    expect(list.body.channels.find((c) => c.kind === "ntfy")!.paired).toBe(0);

    // A new phone pairs on the fresh topics: once the fan-out has reached it,
    // the same fan-out has had its chance to reach the old topic.
    await ntfy.publishRaw(fresh.topic_replies, encodePair(fresh.code, "New phone"));
    expect(
      await until(async () => {
        const rows = await signedPost<{ channels: Array<Record<string, unknown>> }>(
          b,
          "/approval/channel-list",
          {},
          op
        );
        return rows.body.channels.find((c) => c.kind === "ntfy")!.paired === 1;
      })
    ).toBe(true);

    const before = (ntfy.published.get(old.topic_notif) ?? []).length;
    const added = await signedPost<{ approval: Approval }>(
      b,
      "/approval/add",
      {
        kind: "permission",
        title: "Run tests",
        question: "Allow?",
        origin: { host: "bureau", project_key: "p" },
      },
      op
    );
    expect(
      await until(() =>
        (ntfy.published.get(fresh.topic_notif) ?? []).some((m) => String(m.click).includes(added.body.approval.id))
      )
    ).toBe(true);
    expect((ntfy.published.get(old.topic_notif) ?? []).length).toBe(before);
  }, 60_000);

  test("the access token is used and never comes back", async () => {
    const b = shared;
    const ntfy = startStubNtfy({ requireToken: "tk_right" });
    const op = freshOperator();

    const ok = await signedPost<{ mobile_payload: string; hint: string }>(
      b,
      "/approval/channel-connect",
      { kind: "ntfy", server: ntfy.url, token: "tk_right" },
      op
    );
    expect(ok.status).toBe(200);
    expect(ntfy.seen).toContain("tk_right");

    const list = await signedPost<{ channels: Array<Record<string, unknown>> }>(
      b,
      "/approval/channel-list",
      {},
      op
    );
    const row = list.body.channels.find((c) => c.kind === "ntfy")!;
    // channel-list is a public-facing projection: no token, sealed or not.
    expect(JSON.stringify(row)).not.toContain("tk_right");
  }, 60_000);

  test("a token the server rejects leaves nothing configured behind", async () => {
    const b = shared;
    const ntfy = startStubNtfy({ requireToken: "tk_right" });
    const op = freshOperator();

    const res = await signedPost<{ error: string }>(
      b,
      "/approval/channel-connect",
      { kind: "ntfy", server: ntfy.url, token: "tk_wrong" },
      op
    );
    expect(res.status).toBe(400);
    const list = await signedPost<{ channels: Array<Record<string, unknown>> }>(
      b,
      "/approval/channel-list",
      {},
      op
    );
    expect(list.body.channels.find((c) => c.kind === "ntfy")!.configured).toBe(false);
  }, 60_000);

  test("a failed reconnect PRESERVES the working configuration", async () => {
    // The destructive order was: overwrite the sealed config, stop the running
    // gateway, then delete the row on failure. One Connect click with the relay
    // briefly unreachable therefore destroyed a working, paired channel — and
    // left `configured: false, paired: 1`, an inconsistency needing a re-scan.
    const b = shared;
    const ntfy = startStubNtfy();
    const op = freshOperator();

    const first = await signedPost<{ mobile_payload: string }>(
      b,
      "/approval/channel-connect",
      { kind: "ntfy", server: ntfy.url },
      op
    );
    const good = decodePairingPayload(first.body.mobile_payload)!;
    await ntfy.publishRaw(good.topic_replies, encodePair(good.code, "Pixel 8"));
    await until(async () => {
      const list = await signedPost<{ channels: Array<Record<string, unknown>> }>(
        b,
        "/approval/channel-list",
        {},
        op
      );
      return list.body.channels.find((c) => c.kind === "ntfy")!.paired === 1;
    });

    // Now a Connect that cannot succeed: a private address nothing listens on.
    const failed = await signedPost<{ error: string }>(
      b,
      "/approval/channel-connect",
      { kind: "ntfy", server: "http://127.0.0.1:9" },
      op
    );
    expect(failed.status).toBe(400);

    // Everything the operator had is still there, and still consistent.
    const list = await signedPost<{ channels: Array<Record<string, unknown>> }>(
      b,
      "/approval/channel-list",
      {},
      op
    );
    const row = list.body.channels.find((c) => c.kind === "ntfy")!;
    expect(row.configured).toBe(true);
    expect(row.connected).toBe(true);
    expect(row.paired).toBe(1);

    // And the surviving gateway still delivers on the ORIGINAL topics.
    const added = await signedPost<{ approval: Approval }>(
      b,
      "/approval/add",
      {
        kind: "permission",
        title: "Still here",
        question: "Allow?",
        origin: { host: "bureau", project_key: "p" },
      },
      op
    );
    expect(
      await until(() =>
        (ntfy.published.get(good.topic_notif) ?? []).some((m) =>
          String(m.click).includes(added.body.approval.id)
        )
      )
    ).toBe(true);
  }, 90_000);

  test("a server that is not an ntfy is refused", async () => {
    const b = shared;
    const ntfy = startStubNtfy({ unhealthy: true });
    const op = freshOperator();
    const res = await signedPost<{ error: string }>(
      b,
      "/approval/channel-connect",
      { kind: "ntfy", server: ntfy.url },
      op
    );
    expect(res.status).toBe(400);
  }, 60_000);

  test("the server is validated before anything is sealed", async () => {
    const b = shared;
    const op = freshOperator();
    // Missing, malformed, and — the one that matters — plain http towards the
    // internet, which would put an agent's question on the wire in the clear.
    expect((await signedPost(b, "/approval/channel-connect", { kind: "ntfy" }, op)).status).toBe(400);
    expect(
      (await signedPost(b, "/approval/channel-connect", { kind: "ntfy", server: "not a url" }, op)).status
    ).toBe(400);
    const clear = await signedPost<{ error: string }>(
      b,
      "/approval/channel-connect",
      { kind: "ntfy", server: "http://ntfy.sh" },
      op
    );
    expect(clear.status).toBe(400);
    expect(clear.body.error).toContain("local network");
  }, 60_000);

  test("the pairing message from the phone binds the topic, and is confirmed", async () => {
    const b = shared;
    const ntfy = startStubNtfy();
    const op = freshOperator();

    const conn = await signedPost<{ mobile_payload: string }>(
      b,
      "/approval/channel-connect",
      { kind: "ntfy", server: ntfy.url },
      op
    );
    const payload = decodePairingPayload(conn.body.mobile_payload)!;

    // The phone scanned the QR and answers on the replies topic.
    await ntfy.publishRaw(payload.topic_replies, encodePair(payload.code, "Pixel 8"));

    const bound = await until(async () => {
      const list = await signedPost<{ channels: Array<Record<string, unknown>> }>(
        b,
        "/approval/channel-list",
        {},
        op
      );
      return list.body.channels.find((c) => c.kind === "ntfy")!.paired === 1;
    });
    expect(bound).toBe(true);

    const list = await signedPost<{ channels: Array<Record<string, unknown>> }>(
      b,
      "/approval/channel-list",
      {},
      op
    );
    expect(list.body.channels.find((c) => c.kind === "ntfy")!.paired_labels).toContain("Pixel 8");
    // And the broker acknowledged on the notification topic.
    const confirmations = ntfy.published.get(payload.topic_notif) ?? [];
    expect(confirmations.some((m) => String(m.message).includes("Paired."))).toBe(true);
  }, 60_000);

  test("a pending approval reaches the phone, and the phone's answer settles it", async () => {
    const b = shared;
    const ntfy = startStubNtfy();
    const op = freshOperator();

    const conn = await signedPost<{ mobile_payload: string }>(
      b,
      "/approval/channel-connect",
      { kind: "ntfy", server: ntfy.url },
      op
    );
    const payload = decodePairingPayload(conn.body.mobile_payload)!;
    await ntfy.publishRaw(payload.topic_replies, encodePair(payload.code, "Pixel 8"));
    await until(async () => {
      const list = await signedPost<{ channels: Array<Record<string, unknown>> }>(
        b,
        "/approval/channel-list",
        {},
        op
      );
      return list.body.channels.find((c) => c.kind === "ntfy")!.paired === 1;
    });

    const added = await signedPost<{ approval: Approval }>(
      b,
      "/approval/add",
      {
        kind: "permission",
        title: "Run tests",
        question: "Allow `npm test`?",
        options: ["Yes", "No"],
        origin: { host: "bureau", project_key: "github.com/vocsap/koryphaios" },
      },
      op
    );
    const approvalId = added.body.approval.id;

    // Fan-out reached the phone's topic, with its two action buttons.
    const delivered = await until(() => {
      const msgs = ntfy.published.get(payload.topic_notif) ?? [];
      return msgs.some((m) => String(m.click).includes(approvalId));
    });
    expect(delivered).toBe(true);
    const request = (ntfy.published.get(payload.topic_notif) ?? []).find((m) =>
      String(m.click).includes(approvalId)
    )!;
    expect((request.actions as unknown[]).length).toBe(2);

    // The operator taps "Approve": the button posts to the replies topic.
    await ntfy.publishRaw(payload.topic_replies, encodeAnswer(approvalId, "allow"));

    const settled = await until(async () => {
      const list = await signedPost<{ approvals: Approval[] }>(
        b,
        "/approval/list",
        approvalListBody("github.com/vocsap/koryphaios"),
        op
      );
      const found = list.body.approvals.find((a) => a.id === approvalId);
      return found?.status === "answered";
    });
    expect(settled).toBe(true);

    const list = await signedPost<{ approvals: Approval[] }>(
      b,
      "/approval/list",
      approvalListBody("github.com/vocsap/koryphaios"),
      op
    );
    const found = list.body.approvals.find((a) => a.id === approvalId)!;
    expect(found.answered_via).toBe("ntfy");
    expect(found.answer_kind).toBe("allow");

    // A late second tap is told "already handled"; an unknown pairing code
    // after it is answered on the same sequential stream, so once its reply is
    // published every earlier reply is too.
    await ntfy.publishRaw(payload.topic_replies, encodeAnswer(approvalId, "deny"));
    await ntfy.publishRaw(payload.topic_replies, encodePair("no-such-code", "Pixel 8"));
    const fenced = await until(() =>
      (ntfy.published.get(payload.topic_notif) ?? []).some((m) => String(m.message).includes("unknown or expired"))
    );
    expect(fenced).toBe(true);
    const handledNotices = (ntfy.published.get(payload.topic_notif) ?? []).filter(
      (m) => String(m.click).includes(approvalId) && String(m.message).includes("already handled")
    );
    expect(
      handledNotices,
      "the winning answer was told 'already handled': onAnswer returned null for a settled approval"
    ).toHaveLength(1);
  }, 60_000);

  test("a phone answer on a hook request whose session stopped waiting is refused, never recorded", async () => {
    const b = shared;
    const ntfy = startStubNtfy();
    const op = freshOperator();
    const project = "github.com/vocsap/koryphaios";

    const conn = await signedPost<{ mobile_payload: string }>(b, "/approval/channel-connect", { kind: "ntfy", server: ntfy.url }, op);
    const payload = decodePairingPayload(conn.body.mobile_payload)!;
    await ntfy.publishRaw(payload.topic_replies, encodePair(payload.code, "Pixel 8"));
    await until(async () => {
      const list = await signedPost<{ channels: Array<Record<string, unknown>> }>(b, "/approval/channel-list", {}, op);
      return list.body.channels.find((c) => c.kind === "ntfy")!.paired === 1;
    });

    const added = await signedPost<{ approval: Approval }>(
      b,
      "/approval/add",
      {
        kind: "permission",
        title: "Bash: rm build",
        question: "Allow?",
        options: ["Allow", "Deny"],
        reply_route: "hook",
        merge: "never",
        origin: { host: "bureau", project_key: project },
      },
      op
    );
    const approvalId = added.body.approval.id;
    expect(added.body.approval.reply_route).toBe("hook");
    // The Claude Code session that raised it is gone: no wait for 46 s.
    const db = openBrokerDb(b.dbPath);
    const past = new Date(Date.now() - 46_000).toISOString();
    db.run("UPDATE pending_approvals SET created_at = ?, last_wait_at = ? WHERE id = ?", [past, past, approvalId]);
    db.close();

    await ntfy.publishRaw(payload.topic_replies, encodeAnswer(approvalId, "allow"));
    const onPhone = () =>
      (ntfy.published.get(payload.topic_notif) ?? []).filter((m) => String(m.click).includes(approvalId)).map((m) => String(m.message));
    const told = await until(() => onPhone().some((m) => m.includes("closed, the session stopped waiting")));
    expect(told, "the phone must say why its Allow went nowhere").toBe(true);
    expect(onPhone().some((m) => m.includes("approved")), "an Allow nobody received must never read as approved").toBe(false);

    const list = await signedPost<{ approvals: Approval[] }>(b, "/approval/list", approvalListBody(project), op);
    const row = list.body.approvals.find((a) => a.id === approvalId)!;
    expect([row.status, row.answer_kind], "an allow nobody receives must not be recorded").toEqual(["abandoned", null]);
  }, 60_000);

  test("a tapped option settles a hook question as its answer; text and an out-of-range index settle nothing", async () => {
    const b = shared;
    const ntfy = startStubNtfy();
    const op = freshOperator();
    const project = "github.com/vocsap/koryphaios";

    const conn = await signedPost<{ mobile_payload: string }>(b, "/approval/channel-connect", { kind: "ntfy", server: ntfy.url }, op);
    const payload = decodePairingPayload(conn.body.mobile_payload)!;
    await ntfy.publishRaw(payload.topic_replies, encodePair(payload.code, "Pixel 8"));
    await until(async () => {
      const list = await signedPost<{ channels: Array<Record<string, unknown>> }>(b, "/approval/channel-list", {}, op);
      return list.body.channels.find((c) => c.kind === "ntfy")!.paired === 1;
    });

    const added = await signedPost<{ approval: Approval }>(
      b,
      "/approval/add",
      {
        kind: "question",
        title: "Colour",
        question: "Pick a colour",
        questions: [{ question: "Which colour?", options: [{ label: "Red" }, { label: "Green" }, { label: "Blue" }] }],
        reply_route: "hook",
        merge: "never",
        origin: { host: "bureau", project_key: project },
      },
      op
    );
    const approvalId = added.body.approval.id;
    const request = await until(() =>
      (ntfy.published.get(payload.topic_notif) ?? []).some((m) => String(m.click).includes(approvalId))
    );
    expect(request).toBe(true);
    const published = (ntfy.published.get(payload.topic_notif) ?? []).find((m) => String(m.click).includes(approvalId))!;
    expect((published.actions as Array<{ label: string }>).map((a) => a.label)).toEqual(["Red", "Green", "Blue"]);

    await ntfy.publishRaw(payload.topic_replies, encodeAnswer(approvalId, "text", "Green"));
    await ntfy.publishRaw(payload.topic_replies, encodeAnswer(approvalId, "allow"));
    const typed = await signedPost<{ approval: Approval }>(
      b,
      "/approval/add",
      { kind: "question", title: "Trust", question: "Do you trust this folder?", origin: { host: "bureau", project_key: project } },
      op
    );
    const typedId = typed.body.approval.id;
    expect(typed.body.approval.reply_route).toBe("pty");
    await ntfy.publishRaw(payload.topic_replies, encodeAnswer(typedId, "allow"));
    await ntfy.publishRaw(payload.topic_replies, encodeAnswer(approvalId, "option", "", "", 3));
    await ntfy.publishRaw(payload.topic_replies, encodePair("no-such-code", "Pixel 8"));
    const fenced = await until(() =>
      (ntfy.published.get(payload.topic_notif) ?? []).some((m) => String(m.message).includes("unknown or expired"))
    );
    expect(fenced).toBe(true);
    const pending = await signedPost<{ approvals: Approval[] }>(b, "/approval/list", approvalListBody(project), op);
    expect(pending.body.approvals.find((a) => a.id === approvalId)?.status, "text, allow and index 3 settle nothing").toBe(
      "pending"
    );
    expect(
      pending.body.approvals.find((a) => a.id === typedId)?.status,
      "a forged allow would be typed as Enter into the tile of a question"
    ).toBe("pending");

    await ntfy.publishRaw(payload.topic_replies, encodeAnswer(approvalId, "option", "", "", 1));
    const settled = await until(async () => {
      const list = await signedPost<{ approvals: Approval[] }>(b, "/approval/list", approvalListBody(project), op);
      return list.body.approvals.find((a) => a.id === approvalId)?.status === "answered";
    });
    expect(settled).toBe(true);
    const list = await signedPost<{ approvals: Approval[] }>(b, "/approval/list", approvalListBody(project), op);
    const row = list.body.approvals.find((a) => a.id === approvalId)!;
    expect([row.answered_via, row.answer_kind, row.answers]).toEqual(["ntfy", "answers", { "Which colour?": ["Green"] }]);
  }, 60_000);

  test("answering twice is refused, and the phone is told so (C-1 arbitration)", async () => {
    const b = shared;
    const ntfy = startStubNtfy();
    const op = freshOperator();

    const conn = await signedPost<{ mobile_payload: string }>(
      b,
      "/approval/channel-connect",
      { kind: "ntfy", server: ntfy.url },
      op
    );
    const payload = decodePairingPayload(conn.body.mobile_payload)!;
    await ntfy.publishRaw(payload.topic_replies, encodePair(payload.code, "Pixel 8"));
    await until(async () => {
      const list = await signedPost<{ channels: Array<Record<string, unknown>> }>(
        b,
        "/approval/channel-list",
        {},
        op
      );
      return list.body.channels.find((c) => c.kind === "ntfy")!.paired === 1;
    });

    const added = await signedPost<{ approval: Approval }>(
      b,
      "/approval/add",
      {
        kind: "permission",
        title: "Run tests",
        question: "Allow?",
        origin: { host: "bureau", project_key: "p" },
      },
      op
    );
    const id = added.body.approval.id;

    // The Deck wins the race first.
    const claimed = await signedPost<{ approval: Approval }>(
      b,
      "/approval/claim",
      { id, via: "deck", answer_kind: "deny" },
      op
    );
    expect(claimed.status).toBe(200);

    // The phone taps a button anyway.
    await ntfy.publishRaw(payload.topic_replies, encodeAnswer(id, "allow"));

    const told = await until(() => {
      const msgs = ntfy.published.get(payload.topic_notif) ?? [];
      return msgs.some((m) => String(m.message).includes("already handled"));
    });
    expect(told).toBe(true);

    // The verdict did NOT flip: arbitration stayed in the broker.
    const list = await signedPost<{ approvals: Approval[] }>(b, "/approval/list", approvalListBody("p"), op);
    const found = list.body.approvals.find((a) => a.id === id)!;
    expect(found.answered_via).toBe("deck");
    expect(found.answer_kind).toBe("deny");
  }, 60_000);

  test("an answer for ANOTHER operator's approval is refused (C-5)", async () => {
    const mine = freshOperator();
    const theirs = freshOperator();
    const b = shared;
    const ntfy = startStubNtfy();

    const conn = await signedPost<{ mobile_payload: string }>(
      b,
      "/approval/channel-connect",
      { kind: "ntfy", server: ntfy.url },
      mine
    );
    const payload = decodePairingPayload(conn.body.mobile_payload)!;
    await ntfy.publishRaw(payload.topic_replies, encodePair(payload.code, "Pixel 8"));
    await until(async () => {
      const list = await signedPost<{ channels: Array<Record<string, unknown>> }>(
        b,
        "/approval/channel-list",
        {},
        mine
      );
      return list.body.channels.find((c) => c.kind === "ntfy")!.paired === 1;
    });

    // An approval belonging to somebody else entirely.
    const added = await signedPost<{ approval: Approval }>(
      b,
      "/approval/add",
      {
        kind: "permission",
        title: "Their secret",
        question: "Allow?",
        origin: { host: "autre", project_key: "p" },
      },
      theirs
    );
    const foreignId = added.body.approval.id;

    // My phone tries to answer it.
    await ntfy.publishRaw(payload.topic_replies, encodeAnswer(foreignId, "allow"));
    expect(
      await until(() =>
        (ntfy.published.get(payload.topic_notif) ?? []).some((m) => String(m.message).includes("already handled"))
      ),
      "the refusal notice is the proof the answer was processed"
    ).toBe(true);

    const list = await signedPost<{ approvals: Approval[] }>(b, "/approval/list", approvalListBody("p"), theirs);
    expect(list.body.approvals.find((a) => a.id === foreignId)!.status).toBe("pending");

    // The fan-out is bounded by operator_id, so their question was never even
    // posted to my topic: no `approval://` request ever carried that id.
    const msgs = ntfy.published.get(payload.topic_notif) ?? [];
    expect(msgs.some((m) => parseClickUrl(String(m.click))?.view === "approval")).toBe(false);
    // My phone gets the same generic notice it would for an expired request —
    // never a hint that the id belongs to somebody else.
    expect(msgs.some((m) => String(m.message).includes("already handled"))).toBe(true);
  }, 60_000);

  test("two operators on ONE broker each keep their own channel", async () => {
    // The shared-broker case: two OS accounts, or a box on the network used by
    // a team. Before the registry was keyed per operator, the second enrolment
    // replaced (and stopped) the first: their questions arrived — the topic
    // came from the binding — but the reply address came from the OTHER
    // operator's gateway, so their answers vanished in silence.
    const alice = freshOperator();
    const bob = freshOperator();
    const b = shared;
    const ntfy = startStubNtfy();

    const aConn = await signedPost<{ mobile_payload: string }>(
      b,
      "/approval/channel-connect",
      { kind: "ntfy", server: ntfy.url },
      alice
    );
    const bConn = await signedPost<{ mobile_payload: string }>(
      b,
      "/approval/channel-connect",
      { kind: "ntfy", server: ntfy.url },
      bob
    );
    const a = decodePairingPayload(aConn.body.mobile_payload)!;
    const c = decodePairingPayload(bConn.body.mobile_payload)!;
    expect(a.topic_notif).not.toBe(c.topic_notif);

    for (const [op, payload] of [
      [alice, a],
      [bob, c],
    ] as const) {
      await ntfy.publishRaw(payload.topic_replies, encodePair(payload.code, "phone"));
      await until(async () => {
        const list = await signedPost<{ channels: Array<Record<string, unknown>> }>(
          b,
          "/approval/channel-list",
          {},
          op
        );
        return list.body.channels.find((x) => x.kind === "ntfy")!.paired === 1;
      });
    }

    // Alice's enrolment is still RUNNING after Bob's — it was not replaced.
    const aliceList = await signedPost<{ channels: Array<Record<string, unknown>> }>(
      b,
      "/approval/channel-list",
      {},
      alice
    );
    expect(aliceList.body.channels.find((x) => x.kind === "ntfy")!.connected).toBe(true);

    // Alice's question goes to Alice's topic, with ALICE's reply address.
    const added = await signedPost<{ approval: Approval }>(
      b,
      "/approval/add",
      {
        kind: "permission",
        title: "Alice's build",
        question: "Allow?",
        origin: { host: "bureau", project_key: "p" },
      },
      alice
    );
    const id = added.body.approval.id;

    expect(
      await until(() =>
        (ntfy.published.get(a.topic_notif) ?? []).some((m) => String(m.click).includes(id))
      )
    ).toBe(true);
    // Nothing of Alice's ever appeared on Bob's topic (C-5).
    expect(
      (ntfy.published.get(c.topic_notif) ?? []).some((m) => String(m.click).includes(id))
    ).toBe(false);

    const request = (ntfy.published.get(a.topic_notif) ?? []).find((m) =>
      String(m.click).includes(id)
    )!;
    const actions = request.actions as Array<{ url: string }>;
    expect(actions[0]!.url).toContain(a.topic_replies);
    expect(actions[0]!.url).not.toContain(c.topic_replies);

    // And Alice's answer, published on Alice's reply topic, actually lands.
    await ntfy.publishRaw(a.topic_replies, encodeAnswer(id, "allow"));
    expect(
      await until(async () => {
        const list = await signedPost<{ approvals: Approval[] }>(b, "/approval/list", approvalListBody("p"), alice);
        return list.body.approvals.find((x) => x.id === id)?.status === "answered";
      })
    ).toBe(true);
  }, 90_000);

  test("a pairing code presented on ANOTHER operator's topic is refused", async () => {
    // The topics are secrets the broker mints, so a code can only be redeemed
    // on the transport it was issued for. Otherwise redeeming Alice's code on
    // Bob's topic would bind Alice to it — and an answer published there would
    // then authorise against Alice's approvals.
    const alice = freshOperator();
    const bob = freshOperator();
    const b = shared;
    const ntfy = startStubNtfy();

    const aConn = await signedPost<{ pairing_code: string; mobile_payload: string }>(
      b,
      "/approval/channel-connect",
      { kind: "ntfy", server: ntfy.url },
      alice
    );
    const bConn = await signedPost<{ mobile_payload: string }>(
      b,
      "/approval/channel-connect",
      { kind: "ntfy", server: ntfy.url },
      bob
    );
    const bobTopics = decodePairingPayload(bConn.body.mobile_payload)!;

    // Alice's code, redeemed on Bob's replies topic.
    await ntfy.publishRaw(bobTopics.topic_replies, encodePair(aConn.body.pairing_code, "attacker"));
    // Replies on a topic are handled in order, each one answered on the
    // notification topic: two answers there mean the attacker's code was
    // handled.
    await ntfy.publishRaw(bobTopics.topic_replies, encodePair("no-such-code", "Pixel 8"));
    expect(
      await until(
        () =>
          (ntfy.published.get(bobTopics.topic_notif) ?? []).filter((m) =>
            /Paired\.|unknown or expired/.test(String(m.message))
          ).length >= 2
      )
    ).toBe(true);

    // Alice gained nothing, and Bob's own pairing is untouched.
    for (const op of [alice, bob]) {
      const list = await signedPost<{ channels: Array<Record<string, unknown>> }>(
        b,
        "/approval/channel-list",
        {},
        op
      );
      expect(list.body.channels.find((x) => x.kind === "ntfy")!.paired).toBe(0);
    }
  }, 90_000);

  test("one operator disconnecting does not cut the other", async () => {
    const alice = freshOperator();
    const bob = freshOperator();
    const b = shared;
    const ntfy = startStubNtfy();

    await signedPost(b, "/approval/channel-connect", { kind: "ntfy", server: ntfy.url }, alice);
    await signedPost(b, "/approval/channel-connect", { kind: "ntfy", server: ntfy.url }, bob);
    await signedPost(b, "/approval/channel-disconnect", { kind: "ntfy" }, bob);

    const aliceList = await signedPost<{ channels: Array<Record<string, unknown>> }>(
      b,
      "/approval/channel-list",
      {},
      alice
    );
    expect(aliceList.body.channels.find((x) => x.kind === "ntfy")!.connected).toBe(true);
    const bobList = await signedPost<{ channels: Array<Record<string, unknown>> }>(
      b,
      "/approval/channel-list",
      {},
      bob
    );
    expect(bobList.body.channels.find((x) => x.kind === "ntfy")!.configured).toBe(false);
  }, 90_000);

  test("does not restart or pair channels whose owner is no longer trusted", async () => {
    const alice = freshOperator();
    const bob = freshOperator();
    const source = await startBroker({}, { trustedOperators: [alice.cred.publicKey, bob.cred.publicKey] });
    brokers.push(source);
    const ntfy = startStubNtfy();
    let restarted: TestBroker | null = null;
    try {
      const aliceConnect = await signedPost<{ pairing_code: string; mobile_payload: string }>(
        source,
        "/approval/channel-connect",
        { kind: "ntfy", server: ntfy.url },
        alice
      );
      const bobConnect = await signedPost<{ pairing_code: string }>(
        source,
        "/approval/channel-connect",
        { kind: "ntfy", server: ntfy.url },
        bob
      );
      expect([aliceConnect.status, bobConnect.status]).toEqual([200, 200]);
      const aliceTopics = decodePairingPayload(aliceConnect.body.mobile_payload)!;

      source.proc.kill();
      await source.proc.exited;
      writeFileSync(
        join(source.tmpDir, "claude-peers", "operator-trust.json"),
        JSON.stringify({ version: OPERATOR_TRUST_VERSION, operators: [{ public_key: alice.cred.publicKey }] })
      );
      restarted = await startBroker(
        {
          CLAUDE_PEERS_DB: source.dbPath,
          APPDATA: source.tmpDir,
          XDG_CONFIG_HOME: source.tmpDir,
          HOME: source.tmpDir,
          USERPROFILE: source.tmpDir,
        },
        { trustedOperators: null }
      );
      brokers.push(restarted);
      expect(
        await until(async () => (await Bun.file(join(restarted!.tmpDir, "logs", "broker.log")).text()).includes("ntfy started"))
      ).toBe(true);
      const bootLog = await Bun.file(join(restarted.tmpDir, "logs", "broker.log")).text();
      expect(bootLog.match(/notify: ntfy started/g)).toHaveLength(1);

      const db = openBrokerDb(source.dbPath);
      try {
        const aliceSecret = db
          .query("SELECT secret_enc FROM approval_channel_secrets WHERE operator_id = ? AND kind = 'ntfy'")
          .get(alice.id) as { secret_enc: string };
        db.run(
          "UPDATE approval_channel_secrets SET secret_enc = ? WHERE operator_id = ? AND kind = 'ntfy'",
          [aliceSecret.secret_enc, bob.id]
        );
      } finally {
        db.close();
      }

      await ntfy.publishRaw(aliceTopics.topic_replies, encodePair(bobConnect.body.pairing_code, "untrusted-phone"));
      expect(
        await until(async () => {
          const db = openBrokerDb(source.dbPath, { readonly: true });
          try {
            const codeCount = (
              db.query("SELECT COUNT(*) AS count FROM approval_pairing_codes WHERE code = ?")
                .get(bobConnect.body.pairing_code) as { count: number }
            ).count;
            if (codeCount === 0) return true;
          } finally {
            db.close();
          }
          const log = await Bun.file(join(restarted!.tmpDir, "logs", "broker.log")).text();
          return log.includes("ignored pairing code for an untrusted operator owner");
        })
      ).toBe(true);
      await ntfy.publishRaw(aliceTopics.topic_replies, encodePair(aliceConnect.body.pairing_code, "trusted-phone"));
      expect(
        await until(() => {
          const db = openBrokerDb(source.dbPath, { readonly: true });
          try {
            return (
              db.query("SELECT COUNT(*) AS count FROM approval_channels WHERE operator_id = ? AND kind = 'ntfy'")
                .get(alice.id) as { count: number }
            ).count === 1;
          } finally {
            db.close();
          }
        })
      ).toBe(true);

      const dbAfter = openBrokerDb(source.dbPath, { readonly: true });
      try {
        const bobBindings = (
          dbAfter.query("SELECT COUNT(*) AS count FROM approval_channels WHERE operator_id = ? AND kind = 'ntfy'")
            .get(bob.id) as { count: number }
        ).count;
        const retainedCode = (
          dbAfter.query("SELECT COUNT(*) AS count FROM approval_pairing_codes WHERE code = ?")
            .get(bobConnect.body.pairing_code) as { count: number }
        ).count;
        expect([bobBindings, retainedCode]).toEqual([0, 1]);
      } finally {
        dbAfter.close();
      }
      const log = await Bun.file(join(restarted.tmpDir, "logs", "broker.log")).text();
      expect(log).toContain("ignored pairing code for an untrusted operator owner");
      expect(log).not.toContain(alice.id);
      expect(log).not.toContain(bob.id);
      expect(log).not.toContain(bob.cred.publicKey);
      expect(log).not.toContain(bobConnect.body.pairing_code);
    } finally {
      if (restarted) await stopBroker(restarted);
      await stopBroker(source);
    }
  }, 90_000);

  test("ntfy needs no bot token: an anonymous server connects", async () => {
    const b = shared;
    const ntfy = startStubNtfy();
    const op = freshOperator();
    const res = await signedPost<{ mobile_payload: string }>(
      b,
      "/approval/channel-connect",
      { kind: "ntfy", server: ntfy.url },
      op
    );
    expect(res.status).toBe(200);
    expect(decodePairingPayload(res.body.mobile_payload)!.token).toBe("");
  }, 60_000);
});
