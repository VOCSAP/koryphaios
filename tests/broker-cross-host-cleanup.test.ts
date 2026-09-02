import { test, expect, beforeAll, afterAll } from "bun:test";
import { hostname } from "node:os";
import { startBroker, stopBroker, post, get, type TestBroker } from "./_helper.ts";

let broker: TestBroker;

beforeAll(async () => {
  // Tight clean interval so cleanStalePeers fires within the test window.
  broker = await startBroker({
    CLAUDE_PEERS_CLEAN_INTERVAL_SEC: "1",
    CLAUDE_PEERS_ACTIVE_STALE_SEC: "3600", // avoid sweepInactivePeers interference
  });
});
afterAll(async () => { await stopBroker(broker); });

async function register(host: string, cwd: string, pid: number) {
  return post<{ peer_id: string; instance_token: string }>(`${broker.url}/register`, {
    pid, cwd, git_root: null, tty: null, summary: "", host, client_pid: pid,
    project_key: null, group_id: "default", group_secret_hash: null,
  });
}

const DEAD_PID = 99_999_999;

test("cleanStalePeers skips PID liveness check for cross-host peers", async () => {
  const myHost = hostname();
  const otherHost = `ghost-${Date.now().toString(36)}`;

  // Same-host peer with a guaranteed-dead PID: should be flipped to dormant.
  const same = await register(myHost, "/cross-host-same", DEAD_PID);
  // Cross-host peer with the same dead PID: must remain active (the broker
  // cannot reason about a foreign machine's process table).
  const other = await register(otherHost, "/cross-host-other", DEAD_PID);

  // Poll up to 5s for cleanStalePeers (1s interval) to tick at least once.
  let sameStatus = "active";
  let otherStatus = "active";
  for (let i = 0; i < 20; i++) {
    await Bun.sleep(250);
    const all = await get<any[]>(`${broker.url}/admin/peers?include_dormant=1`);
    // admin/peers does not expose instance_token; match rows by peer_id
    // instead.
    const s = all.body.find((p) => p.peer_id === same.body.peer_id);
    const o = all.body.find((p) => p.peer_id === other.body.peer_id);
    sameStatus = s?.status ?? "missing";
    otherStatus = o?.status ?? "missing";
    if (sameStatus === "dormant") break;
  }

  expect(sameStatus).toBe("dormant");
  expect(otherStatus).toBe("active");
}, 10_000);
