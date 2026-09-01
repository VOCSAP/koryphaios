import { test, expect, afterEach } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveBrokerEndpoint,
  computeGroupSecretHash,
  buildAnnouncePayload,
  sendAnnounce,
  fetchOperatorInbox,
  purgeOperatorInbox,
  fetchDispatchRequests,
  resolveDispatchRequest
} from "../desktop/src/main/broker-client.ts";

const dirs: string[] = [];
function tmpConfig(content: object): string {
  const dir = mkdtempSync(join(tmpdir(), "cp-bc-"));
  dirs.push(dir);
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(content));
  return path;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("resolveBrokerEndpoint defaults to loopback on the configured port", () => {
  const cfg = tmpConfig({ port: 7912 });
  const ep = resolveBrokerEndpoint({} as NodeJS.ProcessEnv, cfg);
  expect(ep.url).toBe("http://127.0.0.1:7912");
  expect(ep.token).toBeNull();
});

test("resolveBrokerEndpoint reads broker_url + broker_token from the config file", () => {
  const cfg = tmpConfig({ broker_url: "http://broker.local:7899", broker_token: "sekret" });
  const ep = resolveBrokerEndpoint({} as NodeJS.ProcessEnv, cfg);
  expect(ep.url).toBe("http://broker.local:7899");
  expect(ep.token).toBe("sekret");
});

test("resolveBrokerEndpoint: env overrides the config file", () => {
  const cfg = tmpConfig({ broker_url: "http://file:1", broker_token: "file-token", port: 1 });
  const env = {
    CLAUDE_PEERS_BROKER_URL: "http://env:2",
    CLAUDE_PEERS_BROKER_TOKEN: "env-token"
  } as unknown as NodeJS.ProcessEnv;
  const ep = resolveBrokerEndpoint(env, cfg);
  expect(ep.url).toBe("http://env:2");
  expect(ep.token).toBe("env-token");
});

test("resolveBrokerEndpoint tolerates a missing config file", () => {
  const ep = resolveBrokerEndpoint({ CLAUDE_PEERS_PORT: "8000" } as unknown as NodeJS.ProcessEnv, "/no/such/config.json");
  expect(ep.url).toBe("http://127.0.0.1:8000");
});

test("computeGroupSecretHash is the full sha256 hex of the secret", () => {
  const expected = createHash("sha256").update("my-secret", "utf-8").digest("hex");
  expect(computeGroupSecretHash("my-secret")).toBe(expected);
});

test("buildAnnouncePayload hashes the secret and defaults exclude to null", () => {
  const p = buildAnnouncePayload({ groupId: "abc123", secret: "s3cret", text: "hi" });
  expect(p.group_id).toBe("abc123");
  expect(p.group_secret_hash).toBe(createHash("sha256").update("s3cret", "utf-8").digest("hex"));
  expect(p.text).toBe("hi");
  expect(p.exclude_peer_id).toBeNull();
});

test("buildAnnouncePayload passes exclude_peer_id through", () => {
  const p = buildAnnouncePayload({ groupId: "g", secret: "s", text: "t", excludePeerId: "joiner" });
  expect(p.exclude_peer_id).toBe("joiner");
});

test("sendAnnounce POSTs /announce with the payload + bearer token and returns sent", async () => {
  let captured: { url: string; init: RequestInit } | null = null;
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    captured = { url: String(url), init: init ?? {} };
    return new Response(JSON.stringify({ sent: 3 }), { status: 200 });
  }) as unknown as typeof fetch;

  const res = await sendAnnounce(
    { groupId: "g1", secret: "s1", text: "broadcast", excludePeerId: "x" },
    { endpoint: { url: "http://broker:7899", token: "tok" }, fetchFn }
  );
  expect(res.sent).toBe(3);
  expect(captured!.url).toBe("http://broker:7899/announce");
  const headers = captured!.init.headers as Record<string, string>;
  expect(headers["Authorization"]).toBe("Bearer tok");
  const body = JSON.parse(captured!.init.body as string);
  expect(body.group_id).toBe("g1");
  expect(body.text).toBe("broadcast");
  expect(body.exclude_peer_id).toBe("x");
  expect(body.group_secret_hash).toBe(createHash("sha256").update("s1", "utf-8").digest("hex"));
});

test("sendAnnounce omits the Authorization header when there is no token", async () => {
  let headers: Record<string, string> = {};
  const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
    headers = (init?.headers as Record<string, string>) ?? {};
    return new Response(JSON.stringify({ sent: 0 }), { status: 200 });
  }) as unknown as typeof fetch;
  await sendAnnounce(
    { groupId: "g", secret: "s", text: "t" },
    { endpoint: { url: "http://x", token: null }, fetchFn }
  );
  expect(headers["Authorization"]).toBeUndefined();
});

test("sendAnnounce throws on a non-2xx response", async () => {
  const fetchFn = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
  await expect(
    sendAnnounce({ groupId: "g", secret: "s", text: "t" }, { endpoint: { url: "http://x", token: null }, fetchFn })
  ).rejects.toThrow("announce failed: 401");
});

// --- Courrier lot 1B (card 54b1c71a): fetchOperatorInbox's session_id -------

test("fetchOperatorInbox includes session_id in the body when supplied", async () => {
  let body: Record<string, unknown> = {};
  const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
    body = JSON.parse(init!.body as string);
    return new Response(JSON.stringify({ messages: [] }), { status: 200 });
  }) as unknown as typeof fetch;

  await fetchOperatorInbox(
    { groupId: "g1", secret: "s1", sessionId: "sess-abc" },
    { endpoint: { url: "http://x", token: null }, fetchFn }
  );
  expect(body.session_id).toBe("sess-abc");
  expect(body.group_id).toBe("g1");
});

test("fetchOperatorInbox omits session_id from the body when absent -- legacy shape preserved", async () => {
  let body: Record<string, unknown> = {};
  const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
    body = JSON.parse(init!.body as string);
    return new Response(JSON.stringify({ messages: [] }), { status: 200 });
  }) as unknown as typeof fetch;

  await fetchOperatorInbox(
    { groupId: "g1", secret: "s1" },
    { endpoint: { url: "http://x", token: null }, fetchFn }
  );
  expect("session_id" in body).toBe(false);
});

test("fetchOperatorInbox throws on a non-2xx response", async () => {
  const fetchFn = (async () => new Response("nope", { status: 403 })) as unknown as typeof fetch;
  await expect(
    fetchOperatorInbox(
      { groupId: "g", secret: "s" },
      { endpoint: { url: "http://x", token: null }, fetchFn }
    )
  ).rejects.toThrow("operator-inbox failed: 403");
});

// --- Courrier lot 1C/1D/1E (card 1e81ee7b): purgeOperatorInbox --------------

test("purgeOperatorInbox POSTs /operator-inbox/purge with scope='session' and no ids field", async () => {
  let url = "";
  let body: Record<string, unknown> = {};
  const fetchFn = (async (u: string | URL | Request, init?: RequestInit) => {
    url = String(u);
    body = JSON.parse(init!.body as string);
    return new Response(JSON.stringify({ deleted: 3 }), { status: 200 });
  }) as unknown as typeof fetch;

  const deleted = await purgeOperatorInbox(
    { groupId: "g1", secret: "s1", sessionId: "sess-abc", scope: "session" },
    { endpoint: { url: "http://broker:7899", token: null }, fetchFn }
  );
  expect(deleted).toBe(3);
  expect(url).toBe("http://broker:7899/operator-inbox/purge");
  expect(body.scope).toBe("session");
  expect(body.session_id).toBe("sess-abc");
  expect("ids" in body).toBe(false);
});

test("purgeOperatorInbox POSTs scope='ids' with the ids array included", async () => {
  let body: Record<string, unknown> = {};
  const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
    body = JSON.parse(init!.body as string);
    return new Response(JSON.stringify({ deleted: 2 }), { status: 200 });
  }) as unknown as typeof fetch;

  const deleted = await purgeOperatorInbox(
    { groupId: "g1", secret: "s1", sessionId: "sess-abc", scope: "ids", ids: [5, 7] },
    { endpoint: { url: "http://x", token: null }, fetchFn }
  );
  expect(deleted).toBe(2);
  expect(body.ids).toEqual([5, 7]);
});

test("purgeOperatorInbox throws on a non-2xx response", async () => {
  const fetchFn = (async () => new Response("nope", { status: 403 })) as unknown as typeof fetch;
  await expect(
    purgeOperatorInbox(
      { groupId: "g", secret: "s", sessionId: "x", scope: "session" },
      { endpoint: { url: "http://x", token: null }, fetchFn }
    )
  ).rejects.toThrow("operator-inbox/purge failed: 403");
});

// ----- Dispatch requests (card bf76d37f) -----

test("fetchDispatchRequests POSTs the project key to /dispatch-request/list and returns the requests", async () => {
  let url = "";
  let body: Record<string, unknown> = {};
  let headers: Record<string, string> = {};
  const fetchFn = (async (u: string | URL | Request, init?: RequestInit) => {
    url = String(u);
    body = JSON.parse(init!.body as string);
    headers = init!.headers as Record<string, string>;
    return new Response(
      JSON.stringify({ requests: [{ id: "r1", project_key: "k", from_peer: "agent-1" }] }),
      { status: 200 }
    );
  }) as unknown as typeof fetch;

  const requests = await fetchDispatchRequests("k", {
    endpoint: { url: "http://broker:7899", token: "sekret" },
    fetchFn
  });
  expect(url).toBe("http://broker:7899/dispatch-request/list");
  expect(body).toEqual({ project_key: "k" });
  expect(headers["Authorization"]).toBe("Bearer sekret");
  expect(requests.map((r) => r.id)).toEqual(["r1"]);
});

test("fetchDispatchRequests throws on a non-2xx response", async () => {
  const fetchFn = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
  await expect(
    fetchDispatchRequests("k", { endpoint: { url: "http://x", token: null }, fetchFn })
  ).rejects.toThrow("dispatch-request/list failed: 500");
});

test("resolveDispatchRequest POSTs the id and the WHOLE outcome to /dispatch-request/resolve", async () => {
  let url = "";
  let body: Record<string, unknown> = {};
  const fetchFn = (async (u: string | URL | Request, init?: RequestInit) => {
    url = String(u);
    body = JSON.parse(init!.body as string);
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;

  const outcome = {
    cards: [
      { id: "card-1", title: "t", kind: "directive", matched: ["p"], missing: ["q"], ambiguous: [] }
    ],
    note: "1 directive card executed by the Deck"
  };
  await resolveDispatchRequest("r1", outcome, {
    endpoint: { url: "http://broker:7899", token: null },
    fetchFn
  });
  expect(url).toBe("http://broker:7899/dispatch-request/resolve");
  expect(body.id).toBe("r1");
  // The outcome travels WHOLE: a client-side reshape here would silently drop
  // the buckets the requester is asking for.
  expect(body.outcome).toEqual(outcome);
});

test("resolveDispatchRequest throws on a non-2xx response, so the caller never believes it answered", async () => {
  const fetchFn = (async () => new Response("nope", { status: 409 })) as unknown as typeof fetch;
  await expect(
    resolveDispatchRequest(
      "r1",
      { cards: [], note: "x" },
      { endpoint: { url: "http://x", token: null }, fetchFn }
    )
  ).rejects.toThrow("dispatch-request/resolve failed: 409");
});
