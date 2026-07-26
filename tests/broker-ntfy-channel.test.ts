// The ntfy enrolment route (PLAN N5), against a STUB ntfy on loopback.
//
// The other two channels can only be tested for their failure path offline
// (`getMe` never answers), which leaves the happy path uncovered. ntfy's
// protocol is small enough to stand up locally, so this suite exercises the
// real route end to end: mint topics, probe the server, seal the config, hand
// back the QR payload — without ever leaving 127.0.0.1.

import { afterAll, describe, expect, test } from "bun:test";
import { post, startBroker, stopBroker, type TestBroker } from "./_helper.ts";
import {
  buildAuthProof,
  deriveOperatorId,
  generateCredential,
  type ApprovalCredential,
} from "../shared/approval.ts";
import { decodePairingPayload, encodeAnswer, encodePair, parseClickUrl } from "../notify/ntfy-protocol.ts";
import type { Approval } from "../shared/types.ts";

const brokers: TestBroker[] = [];
const stubs: StubNtfy[] = [];
afterAll(async () => {
  for (const b of brokers) await stopBroker(b);
  for (const s of stubs) s.stop();
});

function newOperator(): { cred: ApprovalCredential; id: string } {
  const cred = generateCredential();
  return { cred, id: deriveOperatorId(cred.publicKey) };
}

async function signedPost<T>(
  b: TestBroker,
  path: string,
  payload: Record<string, unknown>,
  op: { cred: ApprovalCredential; id: string }
): Promise<{ status: number; body: T }> {
  const body = { ...payload, public_key: op.cred.publicKey };
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
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ id: "s0", event: "open" })}\n`));
            const set = subscribers.get(topic) ?? new Set();
            set.add(controller);
            subscribers.set(topic, set);
          },
          cancel(reason) {
            void reason;
            subscribers.delete(topic);
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
    const b = await startBroker();
    brokers.push(b);
    const ntfy = startStubNtfy();
    const op = newOperator();

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
    const b = await startBroker();
    brokers.push(b);
    const ntfy = startStubNtfy();
    const op = newOperator();

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
    const b = await startBroker();
    brokers.push(b);
    const ntfy = startStubNtfy();
    const op = newOperator();

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
    const b = await startBroker();
    brokers.push(b);
    const ntfy = startStubNtfy();
    const op = newOperator();

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
    await signedPost(b, "/approval/channel-connect", { kind: "ntfy", server: ntfy.url }, op);
    const list = await signedPost<{ channels: Array<Record<string, unknown>> }>(
      b,
      "/approval/channel-list",
      {},
      op
    );
    expect(list.body.channels.find((c) => c.kind === "ntfy")!.paired).toBe(0);

    // And nothing is published to the old topic any more: the lost phone is
    // subscribed to a name the broker no longer uses.
    const before = (ntfy.published.get(old.topic_notif) ?? []).length;
    await signedPost(
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
    await Bun.sleep(400);
    expect((ntfy.published.get(old.topic_notif) ?? []).length).toBe(before);
  }, 60_000);

  test("the access token is used and never comes back", async () => {
    const b = await startBroker();
    brokers.push(b);
    const ntfy = startStubNtfy({ requireToken: "tk_right" });
    const op = newOperator();

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
    const b = await startBroker();
    brokers.push(b);
    const ntfy = startStubNtfy({ requireToken: "tk_right" });
    const op = newOperator();

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

  test("a server that is not an ntfy is refused", async () => {
    const b = await startBroker();
    brokers.push(b);
    const ntfy = startStubNtfy({ unhealthy: true });
    const op = newOperator();
    const res = await signedPost<{ error: string }>(
      b,
      "/approval/channel-connect",
      { kind: "ntfy", server: ntfy.url },
      op
    );
    expect(res.status).toBe(400);
  }, 60_000);

  test("the server is validated before anything is sealed", async () => {
    const b = await startBroker();
    brokers.push(b);
    const op = newOperator();
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
    const b = await startBroker();
    brokers.push(b);
    const ntfy = startStubNtfy();
    const op = newOperator();

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
    const b = await startBroker();
    brokers.push(b);
    const ntfy = startStubNtfy();
    const op = newOperator();

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
      const list = await signedPost<{ approvals: Approval[] }>(b, "/approval/list", {}, op);
      const found = list.body.approvals.find((a) => a.id === approvalId);
      return found?.status === "answered";
    });
    expect(settled).toBe(true);

    const list = await signedPost<{ approvals: Approval[] }>(b, "/approval/list", {}, op);
    const found = list.body.approvals.find((a) => a.id === approvalId)!;
    expect(found.answered_via).toBe("ntfy");
    expect(found.answer_kind).toBe("allow");
  }, 60_000);

  test("answering twice is refused, and the phone is told so (C-1 arbitration)", async () => {
    const b = await startBroker();
    brokers.push(b);
    const ntfy = startStubNtfy();
    const op = newOperator();

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
    const list = await signedPost<{ approvals: Approval[] }>(b, "/approval/list", {}, op);
    const found = list.body.approvals.find((a) => a.id === id)!;
    expect(found.answered_via).toBe("deck");
    expect(found.answer_kind).toBe("deny");
  }, 60_000);

  test("an answer for ANOTHER operator's approval is refused (C-5)", async () => {
    const b = await startBroker();
    brokers.push(b);
    const ntfy = startStubNtfy();
    const mine = newOperator();
    const theirs = newOperator();

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
    await Bun.sleep(400);

    const list = await signedPost<{ approvals: Approval[] }>(b, "/approval/list", {}, theirs);
    expect(list.body.approvals.find((a) => a.id === foreignId)!.status).toBe("pending");

    // The fan-out is bounded by operator_id, so their question was never even
    // posted to my topic: no `approval://` request ever carried that id.
    const msgs = ntfy.published.get(payload.topic_notif) ?? [];
    expect(msgs.some((m) => parseClickUrl(String(m.click))?.view === "approval")).toBe(false);
    // My phone gets the same generic notice it would for an expired request —
    // never a hint that the id belongs to somebody else.
    expect(msgs.some((m) => String(m.message).includes("already handled"))).toBe(true);
  }, 60_000);

  test("ntfy needs no bot token: an anonymous server connects", async () => {
    const b = await startBroker();
    brokers.push(b);
    const ntfy = startStubNtfy();
    const op = newOperator();
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
