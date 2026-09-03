import { test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { startBroker, stopBroker, type TestBroker } from "./_helper.ts";
import { SENTINEL_INSTANCE_TOKENS } from "../shared/types.ts";

let broker: TestBroker | undefined;

afterEach(async () => {
  if (broker) await stopBroker(broker);
  broker = undefined;
});

function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.onopen = () => resolve(ws);
    ws.onerror = (e) => reject(e);
  });
}

function waitClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.onclose = (e) => resolve({ code: e.code, reason: e.reason });
  });
}

const [firstSentinel] = SENTINEL_INSTANCE_TOKENS;
if (!firstSentinel) throw new Error("SENTINEL_INSTANCE_TOKENS is empty");

test("WS auth: a sentinel-shaped instance_token is refused with the SAME close code/reason as an unregistered one", async () => {
  broker = await startBroker();

  const sentinelWs = await connect(broker.wsUrl);
  sentinelWs.send(JSON.stringify({ type: "auth", instance_token: firstSentinel }));
  const sentinelClose = await waitClose(sentinelWs);

  const unregisteredWs = await connect(broker.wsUrl);
  const notRegistered = ["never", "registered", "in", "peers"].join("-");
  unregisteredWs.send(JSON.stringify({ type: "auth", instance_token: notRegistered }));
  const unregisteredClose = await waitClose(unregisteredWs);

  expect(sentinelClose).toEqual(unregisteredClose);
  expect(sentinelClose.code).toBe(1008);
});

test("WS auth: a sentinel-shaped instance_token never reaches wsPool (broker stays healthy right after refusing it)", async () => {
  broker = await startBroker();

  for (const sentinel of SENTINEL_INSTANCE_TOKENS) {
    const ws = await connect(broker.wsUrl);
    ws.send(JSON.stringify({ type: "auth", instance_token: sentinel }));
    await waitClose(ws);
  }

  // A crash or hang in the refusal path would show up here instead of a
  // clean close above -- this just confirms the broker process is still
  // alive and answering, i.e. the predicate call closed the socket rather
  // than throwing.
  const res = await fetch(`${broker.url}/health`);
  expect(res.status).toBe(200);
});

// This card's own measurement found that TODAY, the two tests above pass
// even without the fix: sentinel rows are seeded status='dormant' forever,
// so the pre-existing DB lookup (`status = 'active'`) already refuses a
// sentinel token with the SAME close code/reason, by accident. That
// coincidence is exactly the vulnerability this card describes -- so the
// only test that actually distinguishes red (pre-fix) from green (post-fix)
// has to break the precondition itself: mark a sentinel's peers row
// 'active' out-of-band (as some future bug elsewhere might) and show the
// shape-based refusal still holds where the DB-only check would not.
test("WS auth: refuses a sentinel-shaped instance_token even if its peers row is (abnormally) marked active", async () => {
  broker = await startBroker();
  const sentinel = firstSentinel;

  const db = new Database(broker.dbPath);
  try {
    const res = db.run("UPDATE peers SET status = 'active' WHERE instance_token = ?", [sentinel]);
    // Premise check: if this ever matches 0 rows (sentinel renamed, seed
    // changed, row not created yet), the test below would go vacuously green.
    // A premise that stops holding must fail loudly here, not pass silently.
    expect(res.changes).toBe(1);
  } finally {
    db.close();
  }

  const ws = await connect(broker.wsUrl);
  ws.send(JSON.stringify({ type: "auth", instance_token: sentinel }));
  const closed = await waitClose(ws);

  // Pre-fix, with the row forced 'active', the DB-only check would have
  // matched and the handshake would have SUCCEEDED (no close event, socket
  // left in wsPool). Post-fix, the shape guard fires before that lookup is
  // even reached, regardless of DB state.
  expect(closed.code).toBe(1008);
  expect(ws.readyState).toBe(WebSocket.CLOSED);
});
