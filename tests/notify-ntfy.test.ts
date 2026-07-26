// The ntfy gateway (PLAN N5), driven by a fake `fetch`: no test reaches ntfy.
//
// Two things matter here and nowhere else in the notify layer:
//  - the SUBSCRIPTION is a streaming GET the adapter must parse line by line,
//    resume with `since`, and survive junk on;
//  - `settle` PUBLISHES a closing message instead of editing one, because ntfy
//    cannot rewrite a delivered message.

import { describe, expect, test } from "bun:test";
import { NtfyChannel, type NtfyConfig } from "../notify/ntfy.ts";
import { decodeInbound, encodeAnswer, encodePair, parseClickUrl } from "../notify/ntfy-protocol.ts";
import type { ChannelBinding, ChannelHost, InboundAnswer } from "../notify/types.ts";
import type { Approval } from "../shared/types.ts";

const CONFIG: NtfyConfig = {
  server: "https://ntfy.example",
  topic_notif: "n".repeat(48),
  topic_replies: "r".repeat(48),
  token: "tk_secret",
};

function approval(patch: Partial<Approval> = {}): Approval {
  return {
    id: "appr-1",
    operator_id: "op-a",
    origin: {
      host: "bureau",
      os_user_hash: "h",
      project_key: "/home/o/koryphaios",
      group_id: "g",
      from_peer: "",
      session_ref: "s",
      tile_ref: "t",
    },
    kind: "permission",
    title: "Bash",
    question: "Allow?",
    options: [],
    status: "pending",
    reply_route: "pty",
    answered_via: null,
    answer_kind: null,
    answer_text: null,
    created_at: "",
    notif_expires_at: "",
    answered_at: null,
    delivered_at: null,
    ...patch,
  } as Approval;
}

const BINDING: ChannelBinding = {
  id: "b1",
  operator_id: "op-a",
  kind: "ntfy",
  address: CONFIG.topic_notif,
  label: "Pixel 8",
  enabled: true,
};

interface Recorder {
  calls: Array<{ url: string; init: RequestInit }>;
  published: Array<Record<string, unknown>>;
  answers: InboundAnswer[];
  pairs: Array<{ code: string; address: string; label: string }>;
  errors: string[];
}

function makeHost(rec: Recorder, opts: { settle?: boolean; pair?: boolean } = {}): ChannelHost {
  return {
    async onAnswer(_kind, answer) {
      rec.answers.push(answer);
      return opts.settle === false ? null : approval({ status: "answered", answered_via: "ntfy" });
    },
    async onPair(_kind, code, address, label) {
      rec.pairs.push({ code, address, label });
      return opts.pair === false ? null : BINDING;
    },
    log: {
      info: () => undefined,
      error: (m) => {
        rec.errors.push(m);
      },
    },
  };
}

function newRecorder(): Recorder {
  return { calls: [], published: [], answers: [], pairs: [], errors: [] };
}

/** A fetch whose subscription leg streams the lines we push into it. */
function makeFetch(
  rec: Recorder,
  opts: {
    lines?: string[];
    /** Close the stream after the lines instead of holding it open. */
    endStream?: boolean;
    health?: number;
    probe?: number;
    publishStatus?: number;
    subscribeStatus?: number;
  } = {}
): typeof fetch {
  let leg = 0;
  return (async (input: string, init: RequestInit = {}) => {
    const url = String(input);
    rec.calls.push({ url, init });

    if (url.includes("/v1/health")) {
      return new Response(JSON.stringify({ healthy: true }), { status: opts.health ?? 200 });
    }
    if (url.includes("poll=1")) {
      return new Response("", { status: opts.probe ?? 200 });
    }
    if ((init.method ?? "GET") === "POST") {
      rec.published.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ id: "srv-msg-1" }), { status: opts.publishStatus ?? 200 });
    }
    // The subscription leg.
    if (opts.subscribeStatus && opts.subscribeStatus !== 200) {
      return new Response("", { status: opts.subscribeStatus });
    }
    // Only the FIRST leg replays the scripted lines: ntfy honours `since`, so
    // a reconnect must not hand the same messages back a second time.
    const lines = leg++ === 0 ? (opts.lines ?? []) : [];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const l of lines) controller.enqueue(new TextEncoder().encode(`${l}\n`));
        if (opts.endStream !== false) controller.close();
        // A real fetch errors the body when the request is aborted; the fake
        // has to do it by hand or stop() would park forever on read().
        else init.signal?.addEventListener("abort", () => controller.close());
      },
    });
    return new Response(stream, { status: 200 });
  }) as unknown as typeof fetch;
}

/** Let the adapter's async subscription loop run a few turns. */
async function settleLoop(): Promise<void> {
  for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 1));
}

describe("describe()", () => {
  test("accepts a healthy server and labels it by host", async () => {
    const rec = newRecorder();
    const ch = new NtfyChannel({
      config: CONFIG,
      host: makeHost(rec),
      bindingFor: () => BINDING,
      fetchImpl: makeFetch(rec),
    });
    expect(await ch.describe()).toEqual({ label: "ntfy.example" });
  });

  test("refuses a token the server rejects, so a bad enrolment is not kept", async () => {
    const rec = newRecorder();
    const ch = new NtfyChannel({
      config: CONFIG,
      host: makeHost(rec),
      bindingFor: () => BINDING,
      fetchImpl: makeFetch(rec, { probe: 401 }),
    });
    expect(await ch.describe()).toBeNull();
    expect(rec.errors.join(" ")).toContain("refused these credentials");
  });

  test("refuses a host that is not an ntfy server", async () => {
    const rec = newRecorder();
    const ch = new NtfyChannel({
      config: CONFIG,
      host: makeHost(rec),
      bindingFor: () => BINDING,
      fetchImpl: makeFetch(rec, { health: 404 }),
    });
    expect(await ch.describe()).toBeNull();
  });

  test("sends the bearer token on the probe", async () => {
    const rec = newRecorder();
    const ch = new NtfyChannel({
      config: CONFIG,
      host: makeHost(rec),
      bindingFor: () => BINDING,
      fetchImpl: makeFetch(rec),
    });
    await ch.describe();
    const probe = rec.calls.find((c) => c.url.includes("poll=1"));
    expect((probe?.init.headers as Record<string, string>).authorization).toBe("Bearer tk_secret");
  });
});

describe("post / settle / rejectLate", () => {
  test("post publishes to the notification topic with both buttons", async () => {
    const rec = newRecorder();
    const ch = new NtfyChannel({
      config: CONFIG,
      host: makeHost(rec),
      bindingFor: () => BINDING,
      fetchImpl: makeFetch(rec),
    });
    const posted = await ch.post(BINDING, approval());
    expect(posted?.external_ref).toBe("srv-msg-1");
    const body = rec.published[0]!;
    expect(body.topic).toBe(CONFIG.topic_notif);
    expect((body.actions as unknown[]).length).toBe(2);
    expect(parseClickUrl(String(body.click))).toEqual({ view: "approval", approvalId: "appr-1" });
  });

  test("post falls back to the approval id when the server returns none", async () => {
    const rec = newRecorder();
    const ch = new NtfyChannel({
      config: CONFIG,
      host: makeHost(rec),
      bindingFor: () => BINDING,
      // 200 with no id in the body.
      fetchImpl: (async (input: string, init: RequestInit = {}) => {
        rec.calls.push({ url: String(input), init });
        rec.published.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect((await ch.post(BINDING, approval()))?.external_ref).toBe("appr-1");
  });

  test("settle publishes a CLOSING message — ntfy cannot edit", async () => {
    const rec = newRecorder();
    const ch = new NtfyChannel({
      config: CONFIG,
      host: makeHost(rec),
      bindingFor: () => BINDING,
      fetchImpl: makeFetch(rec),
    });
    await ch.settle(
      BINDING,
      { external_ref: "srv-msg-1" },
      approval({ status: "answered", answer_kind: "allow" }),
      "deck"
    );
    const body = rec.published[0]!;
    expect(body.priority).toBe(1);
    expect(body.actions).toBeUndefined();
    expect(String(body.message)).toContain("handled via deck");
    expect(parseClickUrl(String(body.click))).toEqual({ view: "settled", approvalId: "appr-1" });
  });

  test("rejectLate tells the phone the request is already handled", async () => {
    const rec = newRecorder();
    const ch = new NtfyChannel({
      config: CONFIG,
      host: makeHost(rec),
      bindingFor: () => BINDING,
      fetchImpl: makeFetch(rec),
    });
    await ch.rejectLate(BINDING, {
      approvalId: "appr-9",
      answerKind: "allow",
      fromAddress: CONFIG.topic_notif,
    });
    expect(String(rec.published[0]!.message)).toContain("already handled");
    expect(parseClickUrl(String(rec.published[0]!.click))?.approvalId).toBe("appr-9");
  });

  test("a failed publish is NOT reported as a post", async () => {
    const rec = newRecorder();
    const ch = new NtfyChannel({
      config: CONFIG,
      host: makeHost(rec),
      bindingFor: () => BINDING,
      fetchImpl: makeFetch(rec, { publishStatus: 502 }),
    });
    // Returning a handle here would make the registry record a copy that does
    // not exist, and later publish a closing message for a question the phone
    // never received. Logged, never thrown: the registry is best-effort.
    expect(await ch.post(BINDING, approval())).toBeNull();
    expect(rec.errors.join(" ")).toContain("publish answered 502");
  });
});

describe("subscription (the inbound leg)", () => {
  async function run(
    lines: string[],
    opts: { settle?: boolean; pair?: boolean; bind?: boolean } = {}
  ): Promise<Recorder> {
    const rec = newRecorder();
    const ch = new NtfyChannel({
      config: CONFIG,
      host: makeHost(rec, opts),
      bindingFor: () => (opts.bind === false ? null : BINDING),
      fetchImpl: makeFetch(rec, { lines }),
      reconnectMs: 5,
    });
    ch.start();
    await settleLoop();
    await ch.stop();
    return rec;
  }

  test("an answer published on the replies topic reaches onAnswer", async () => {
    const rec = await run([
      JSON.stringify({ id: "m1", event: "open", topic: CONFIG.topic_replies }),
      JSON.stringify({ id: "m2", event: "message", message: encodeAnswer("appr-1", "allow") }),
    ]);
    expect(rec.answers).toHaveLength(1);
    expect(rec.answers[0]).toMatchObject({
      approvalId: "appr-1",
      answerKind: "allow",
      fromAddress: CONFIG.topic_notif,
    });
  });

  test("a free-text answer carries its text through", async () => {
    const rec = await run([
      JSON.stringify({ id: "m1", message: encodeAnswer("appr-1", "text", "use staging", "Pixel 8") }),
    ]);
    expect(rec.answers[0]?.answerText).toBe("use staging");
  });

  test("an unknown topic binding writes nothing", async () => {
    const rec = await run([JSON.stringify({ id: "m1", message: encodeAnswer("appr-1", "allow") })], {
      bind: false,
    });
    expect(rec.answers).toHaveLength(0);
  });

  test("junk, keepalives and foreign payloads are ignored in silence", async () => {
    const rec = await run([
      "not json",
      JSON.stringify({ id: "m1", event: "keepalive" }),
      JSON.stringify({ id: "m2", event: "message", message: "hello from a stranger" }),
      JSON.stringify({ id: "m3", event: "message", message: JSON.stringify({ v: 9, t: "answer" }) }),
    ]);
    expect(rec.answers).toHaveLength(0);
    expect(rec.pairs).toHaveLength(0);
  });

  test("a losing answer gets a closing message instead of silence", async () => {
    const rec = await run([JSON.stringify({ id: "m1", message: encodeAnswer("appr-1", "allow") })], {
      settle: false,
    });
    expect(rec.answers).toHaveLength(1);
    expect(String(rec.published.at(-1)!.message)).toContain("already handled");
  });

  test("a pairing message pairs the notification topic and confirms on it", async () => {
    const rec = await run([JSON.stringify({ id: "m1", message: encodePair("code-1", "Pixel 8") })]);
    expect(rec.pairs[0]).toEqual({ code: "code-1", address: CONFIG.topic_notif, label: "Pixel 8" });
    expect(String(rec.published[0]!.message)).toContain("Paired.");
  });

  test("an unknown pairing code is answered without creating a binding", async () => {
    const rec = await run([JSON.stringify({ id: "m1", message: encodePair("nope") })], { pair: false });
    expect(String(rec.published[0]!.message)).toContain("unknown or expired");
  });

  test("the first leg carries no `since`, the reconnect resumes from the last id", async () => {
    const rec = await run([
      JSON.stringify({ id: "m1", message: encodeAnswer("appr-1", "allow") }),
      JSON.stringify({ id: "m2", event: "keepalive" }),
    ]);
    const subs = rec.calls.filter((c) => c.url.includes("/json?") && !c.url.includes("poll=1"));
    expect(subs.length).toBeGreaterThanOrEqual(2);
    expect(subs[0]!.url).not.toContain("since=");
    expect(subs[1]!.url).toContain("since=m2");
  });

  test("a refused subscription is logged and retried, not fatal", async () => {
    const rec = newRecorder();
    const ch = new NtfyChannel({
      config: CONFIG,
      host: makeHost(rec),
      bindingFor: () => BINDING,
      fetchImpl: makeFetch(rec, { subscribeStatus: 403 }),
      reconnectMs: 5,
    });
    ch.start();
    await settleLoop();
    expect(ch.isReady()).toBe(false);
    await ch.stop();
    expect(rec.errors.join(" ")).toContain("subscription answered 403");
  });

  test("stop() ends the loop and the channel stops reporting ready", async () => {
    const rec = newRecorder();
    const ch = new NtfyChannel({
      config: CONFIG,
      host: makeHost(rec),
      bindingFor: () => BINDING,
      fetchImpl: makeFetch(rec, { lines: [], endStream: false }),
      reconnectMs: 5,
    });
    ch.start();
    await settleLoop();
    expect(ch.isReady()).toBe(true);
    await ch.stop();
    expect(ch.isReady()).toBe(false);
    const before = rec.calls.length;
    await settleLoop();
    expect(rec.calls.length).toBe(before);
  });
});

describe("C-1: the adapter never decides a verdict", () => {
  test("it forwards to onAnswer and renders whatever comes back", async () => {
    const rec = newRecorder();
    const ch = new NtfyChannel({
      config: CONFIG,
      host: makeHost(rec, { settle: false }),
      bindingFor: () => BINDING,
      fetchImpl: makeFetch(rec, {
        lines: [JSON.stringify({ id: "m1", message: encodeAnswer("appr-1", "deny") })],
      }),
      reconnectMs: 5,
    });
    ch.start();
    await settleLoop();
    await ch.stop();
    // The only decision the adapter made was to relay it.
    expect(rec.answers[0]!.answerKind).toBe("deny");
    expect(decodeInbound(encodeAnswer("appr-1", "deny"))).toMatchObject({ kind: "deny" });
  });
});
