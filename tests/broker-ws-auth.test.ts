import { test, expect, beforeAll, afterAll } from "bun:test";
import { startBroker, stopBroker, livePid, type TestBroker } from "./_helper.ts";
import { randomBytes } from "node:crypto";

let broker: TestBroker;
// Test-only fixture, generated per run, never committed.
const TOKEN = randomBytes(16).toString("hex");

beforeAll(async () => { broker = await startBroker({ CLAUDE_PEERS_BROKER_TOKEN: TOKEN }); });
afterAll(async () => { await stopBroker(broker); });

async function registerWithToken(host: string, cwd: string): Promise<{ peer_id: string; instance_token: string }> {
  const res = await fetch(`${broker.url}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${TOKEN}` },
    body: JSON.stringify({
      pid: livePid(), cwd, git_root: null, tty: null, summary: "", host, client_pid: 1,
      project_key: null, group_id: "default", group_secret_hash: null,
    }),
  });
  if (!res.ok) throw new Error(`register failed: ${res.status}`);
  return res.json() as Promise<{ peer_id: string; instance_token: string }>;
}

function openWs(extraHeaders?: Record<string, string>): Promise<{ ws: WebSocket; opened: boolean; close: { code: number; reason: string } | null }> {
  return new Promise((resolve) => {
    const init = extraHeaders ? ({ headers: extraHeaders } as unknown as string[]) : undefined;
    const ws = new WebSocket(broker.wsUrl, init);
    let settled = false;
    let opened = false;
    let close: { code: number; reason: string } | null = null;
    ws.addEventListener("open", () => { opened = true; });
    ws.addEventListener("close", (e) => {
      close = { code: e.code, reason: e.reason };
      if (!settled) { settled = true; resolve({ ws, opened, close }); }
    });
    ws.addEventListener("error", () => {
      if (!settled) { settled = true; resolve({ ws, opened, close }); }
    });
    setTimeout(() => { if (!settled) { settled = true; resolve({ ws, opened, close }); } }, 500);
  });
}

// Bug B: in HTTP-remote mode with a Bearer-token broker, server.ts opened the
// WebSocket without an Authorization header. The /ws upgrade was rejected by
// unauthorizedIfToken() with 401 before any auth frame could be exchanged, so
// ws_connected stayed false forever. The fix is to pass the Bearer header on
// the WebSocket upgrade via Bun's headers option.

test("WS upgrade is rejected when broker requires a Bearer token and none is provided", async () => {
  const result = await openWs();
  expect(result.opened).toBe(false);
});

test("WS upgrade succeeds when the client passes a Bearer header", async () => {
  const r = await registerWithToken("auth-host-ok", "/auth-ok");
  const result = await openWs({ Authorization: `Bearer ${TOKEN}` });
  expect(result.opened).toBe(true);
  expect(result.ws.readyState).toBe(WebSocket.OPEN);
  result.ws.send(JSON.stringify({ type: "auth", instance_token: r.instance_token }));
  await Bun.sleep(80);
  expect(result.ws.readyState).toBe(WebSocket.OPEN);
  result.ws.close();
});

// ----- B2: Origin guard (CSRF / DNS-rebinding defense) -----

test("a cross-origin browser request is rejected with 403 (before auth)", async () => {
  const res = await fetch(`${broker.url}/group-stats`, {
    method: "GET",
    headers: { Origin: "http://evil.example.com", Authorization: `Bearer ${TOKEN}` },
  });
  expect(res.status).toBe(403);
});

test("a loopback Origin is allowed through the guard", async () => {
  const res = await fetch(`${broker.url}/group-stats`, {
    method: "GET",
    headers: { Origin: "http://127.0.0.1:9999", Authorization: `Bearer ${TOKEN}` },
  });
  expect(res.status).toBe(200);
});

test("a native client (no Origin header) is unaffected by the guard", async () => {
  // No Origin → passes the guard; the valid Bearer token is still required.
  const res = await fetch(`${broker.url}/group-stats`, {
    method: "GET",
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  expect(res.status).toBe(200);
});

test("a wrong Bearer token is still rejected (constant-time compare)", async () => {
  const res = await fetch(`${broker.url}/group-stats`, {
    method: "GET",
    headers: { Authorization: `Bearer ${TOKEN}xx` },
  });
  expect(res.status).toBe(401);
});
