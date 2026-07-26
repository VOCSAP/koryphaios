// The phone's foreground transport (PLAN N5), driven by a fake `fetch`.
//
// Same two legs as the broker's, mirrored: a held-open GET for questions and a
// POST for answers. The property worth pinning is the `since` handling — a
// phone coming back from a tunnel must resume, not receive the whole retained
// backlog at once.

import { describe, expect, test } from "bun:test";
import { adoptPairing } from "../desktop/mobile-shell/src/approval-pairing.ts";
import { publish, subscribe } from "../desktop/mobile-shell/src/ntfy-client.ts";
import { MemoryStore } from "../desktop/mobile-shell/src/storage.ts";
import { approvalClickUrl, encodePairingPayload } from "../notify/ntfy-protocol.ts";
import type { NtfyMessage } from "../desktop/mobile-shell/src/approval-inbox.ts";

const PAYLOAD = encodePairingPayload({
  server: "https://ntfy.example",
  topic_notif: "n".repeat(48),
  topic_replies: "r".repeat(48),
  token: "tk_secret",
  code: "code-1",
});

function newPairing(token = "tk_secret"): ReturnType<typeof adoptPairing> {
  const store = new MemoryStore();
  const raw = token
    ? PAYLOAD
    : encodePairingPayload({
        server: "https://ntfy.example",
        topic_notif: "n".repeat(48),
        topic_replies: "r".repeat(48),
        token: "",
        code: "code-1",
      });
  return adoptPairing(store, raw, 1, "Pixel 8");
}

interface Call {
  url: string;
  init: RequestInit;
}

/** Streams the scripted lines on the FIRST leg only, like a `since`-honouring
 *  server; later legs stay open and silent. */
function makeFetch(
  calls: Call[],
  opts: { lines?: string[]; status?: number; publishStatus?: number; throwOnPublish?: boolean } = {}
): typeof fetch {
  let leg = 0;
  return (async (input: string, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    if ((init.method ?? "GET") === "POST") {
      if (opts.throwOnPublish) throw new Error("offline");
      return new Response("{}", { status: opts.publishStatus ?? 200 });
    }
    if (opts.status && opts.status !== 200) return new Response("", { status: opts.status });
    const lines = leg++ === 0 ? (opts.lines ?? []) : [];
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const l of lines) controller.enqueue(new TextEncoder().encode(`${l}\n`));
          controller.close();
        },
      }),
      { status: 200 }
    );
  }) as unknown as typeof fetch;
}

async function settleLoop(): Promise<void> {
  for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 1));
}

describe("publish", () => {
  test("posts to the replies topic with the bearer token", async () => {
    const calls: Call[] = [];
    const ok = await publish(newPairing()!, "body", { fetchImpl: makeFetch(calls) });
    expect(ok).toBe(true);
    expect(calls[0]!.url).toBe(`https://ntfy.example/${"r".repeat(48)}`);
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer tk_secret");
  });

  test("omits the header when the server is anonymous", async () => {
    const calls: Call[] = [];
    await publish(newPairing("")!, "body", { fetchImpl: makeFetch(calls) });
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  test("a refusal and an offline phone both report, never throw", async () => {
    const errors: string[] = [];
    const refused = await publish(newPairing()!, "b", {
      fetchImpl: makeFetch([], { publishStatus: 403 }),
      onError: (m) => errors.push(m),
    });
    expect(refused).toBe(false);
    const offline = await publish(newPairing()!, "b", {
      fetchImpl: makeFetch([], { throwOnPublish: true }),
      onError: (m) => errors.push(m),
    });
    expect(offline).toBe(false);
    expect(errors.join(" ")).toContain("403");
    expect(errors.join(" ")).toContain("not sent");
  });
});

describe("subscribe", () => {
  test("delivers the messages it reads off the stream", async () => {
    const calls: Call[] = [];
    const seen: NtfyMessage[] = [];
    const sub = subscribe(newPairing()!, (m) => seen.push(m), {
      fetchImpl: makeFetch(calls, {
        lines: [
          JSON.stringify({ id: "m1", event: "open" }),
          JSON.stringify({ id: "m2", event: "message", click: approvalClickUrl("appr-1") }),
        ],
      }),
      reconnectMs: 5,
    });
    await settleLoop();
    sub.stop();
    expect(seen).toHaveLength(2);
    expect(seen[1]!.click).toBe(approvalClickUrl("appr-1"));
  });

  test("the first leg has no `since`; the reconnect resumes from the last id", async () => {
    const calls: Call[] = [];
    const sub = subscribe(newPairing()!, () => undefined, {
      fetchImpl: makeFetch(calls, { lines: [JSON.stringify({ id: "m7", event: "message" })] }),
      reconnectMs: 5,
    });
    await settleLoop();
    sub.stop();
    expect(calls[0]!.url).not.toContain("since=");
    expect(calls[1]!.url).toContain("since=m7");
  });

  test("junk on the stream is skipped without killing the subscription", async () => {
    const seen: NtfyMessage[] = [];
    const sub = subscribe(newPairing()!, (m) => seen.push(m), {
      fetchImpl: makeFetch([], {
        lines: ["not json", "[1,2]", JSON.stringify({ id: "m1", event: "message" })],
      }),
      reconnectMs: 5,
    });
    await settleLoop();
    sub.stop();
    expect(seen).toHaveLength(1);
  });

  test("a refused subscription is reported and retried", async () => {
    const errors: string[] = [];
    const calls: Call[] = [];
    const sub = subscribe(newPairing()!, () => undefined, {
      fetchImpl: makeFetch(calls, { status: 401 }),
      reconnectMs: 5,
      onError: (m) => errors.push(m),
    });
    await settleLoop();
    sub.stop();
    expect(errors.join(" ")).toContain("401");
    expect(calls.length).toBeGreaterThan(1);
  });

  test("stop() ends the loop for good", async () => {
    const calls: Call[] = [];
    const sub = subscribe(newPairing()!, () => undefined, {
      fetchImpl: makeFetch(calls),
      reconnectMs: 5,
    });
    await settleLoop();
    sub.stop();
    const before = calls.length;
    await settleLoop();
    expect(calls.length).toBe(before);
  });
});
