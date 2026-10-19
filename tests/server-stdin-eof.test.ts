import { test, expect, afterAll } from "bun:test";
import { startBroker, stopBroker, scrubEnv, type TestBroker, openBrokerDb } from "./_helper.ts";

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
