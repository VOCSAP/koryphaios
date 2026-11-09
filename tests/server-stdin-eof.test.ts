import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBroker, stopBroker, scrubEnv, type TestBroker, openBrokerDb } from "./_helper.ts";
import { reachedWithin } from "./_bounded-await.ts";

const brokers: TestBroker[] = [];
afterAll(async () => { for (const b of brokers) await stopBroker(b); });

test("server.ts exits when stdin closes and marks peer dormant", async () => {
  const b = await startBroker();
  brokers.push(b);

  const proc = Bun.spawn(["bun", "server.ts"], {
    env: scrubEnv(b.tmpDir, {
      CLAUDE_PEERS_BROKER_URL: b.url,
      CLAUDE_PEERS_PORT: String(b.port),
    }),
    stdio: ["pipe", "pipe", "pipe"],
  });

  const init = JSON.stringify({
    jsonrpc: "2.0", id: 0, method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: { roots: {}, elicitation: {} },
      clientInfo: { name: "test-harness", version: "0.0.1" },
    },
  });
  // Bun.spawn stdio:"pipe" yields a FileSink (not a Web Streams WritableStream).
  // Use .write() / .end() directly -- no getWriter() needed.
  proc.stdin.write(init + "\n");

  let registered = false;
  for (let i = 0; i < 40; i++) {
    const db = openBrokerDb(b.dbPath, { readonly: true });
    const n = db.query("SELECT COUNT(*) AS n FROM peers WHERE status='active'").get() as { n: number };
    db.close();
    if (n.n > 0) { registered = true; break; }
    await Bun.sleep(100);
  }
  expect(registered).toBe(true);

  proc.stdin.end();

  const code = await proc.exited;
  expect(code).toBe(0);

  const db = openBrokerDb(b.dbPath, { readonly: true });
  const row = db.query(
    "SELECT status FROM peers WHERE status IN ('active','dormant') LIMIT 1"
  ).get() as { status: string };
  db.close();
  expect(row.status).toBe("dormant");
}, 30_000);

// Cost: one `bun server.ts` child and the time of its first requests, about a second.
test("server.ts whose stdin closes while its registration is pending exits 0", async () => {
  // Mutation: the stdin and signal handlers installed after `await session.ready`.
  const dir = mkdtempSync(join(tmpdir(), "cp-stdin-pending-"));
  let registerSeen = false;
  // Answers /health, then holds /register for ever: the session is still registering.
  const broker = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      if (new URL(req.url).pathname === "/health") return Response.json({ ok: true });
      registerSeen = true;
      return new Promise<Response>(() => {});
    },
  });
  const proc = Bun.spawn(["bun", "server.ts"], {
    env: scrubEnv(dir, {
      CLAUDE_PEERS_BROKER_URL: `http://127.0.0.1:${broker.port}`,
      CLAUDE_PEERS_PORT: String(broker.port),
      // A proxy in the environment would stand between the child and the fake broker.
      NO_PROXY: "127.0.0.1,localhost",
    }),
    stdio: ["pipe", "pipe", "pipe"],
  });
  try {
    await reachedWithin(
      (async () => {
        while (!registerSeen) await Bun.sleep(20);
      })(),
      "the /register of server.ts",
      15_000
    );

    proc.stdin.end();

    expect(await reachedWithin(proc.exited, "server.ts exit after stdin closed", 10_000)).toBe(0);
  } finally {
    proc.kill();
    broker.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}, 40_000);
