import { test, expect, beforeAll, afterAll } from "bun:test";
import { startBroker, stopBroker, post, get, livePid, type TestBroker, openBrokerDb } from "./_helper.ts";

// Regression for v0.3.2 crash-loop on LXC 123: cleanStalePeers tried to DELETE
// a dormant peer that still had rows in `messages.from_token`, which violates
// the FK and throws SQLiteError errno 787. Both DELETE-peer paths must clear
// from_token and to_token first.

let broker: TestBroker;

beforeAll(async () => {
  broker = await startBroker({
    CLAUDE_PEERS_DORMANT_TTL_HOURS: "0",
    CLAUDE_PEERS_CLEAN_INTERVAL_SEC: "1",
  });
});
afterAll(async () => { await stopBroker(broker); });

async function register(host: string, cwd: string, pid: number) {
  return post<{ peer_id: string; instance_token: string }>(`${broker.url}/register`, {
    pid, cwd, git_root: null, tty: null, summary: "", host, client_pid: 1,
    project_key: null, group_id: "default", group_secret_hash: null,
  });
}

test("cleanStalePeers purges a dormant peer that has messages.from_token rows (FK cascade)", async () => {
  const a = await register("hsfk-a", "/hsfk-a", livePid());
  const b = await register("hsfk-b", "/hsfk-b", livePid());

  // Populate messages.from_token = A while both peers are active.
  const send = await post<{ ok: boolean; error?: string }>(`${broker.url}/send-message`, {
    from_token: a.body.instance_token,
    to_peer_id: b.body.peer_id,
    text: "regression payload",
  });
  expect(send.body.ok).toBe(true);

  // Flip A to dormant and backdate last_seen past the TTL=0 cutoff.
  await post(`${broker.url}/disconnect`, { instance_token: a.body.instance_token });
  const db = openBrokerDb(broker.dbPath);
  db.run("UPDATE peers SET last_seen = ? WHERE instance_token = ?", [
    "2000-01-01T00:00:00Z",
    a.body.instance_token,
  ]);
  db.close();

  // Wait for cleanStalePeers (1s interval) to purge A. Before the fix, the
  // broker would crash here with FOREIGN KEY constraint failed.
  let stillThere = true;
  for (let i = 0; i < 30 && stillThere; i++) {
    await Bun.sleep(500);
    const peers = await get<{ instance_token: string }[]>(
      `${broker.url}/admin/peers?include_dormant=1`
    );
    stillThere = !!peers.body.find((p) => p.instance_token === a.body.instance_token);
  }
  expect(stillThere).toBe(false);

  // Broker must still be serving after the purge (no crash-loop).
  const health = await fetch(`${broker.url}/health`);
  expect(health.ok).toBe(true);
}, 20_000);

test("handleUnregister deletes a peer that has messages.from_token rows (FK cascade)", async () => {
  const a = await register("hsfk-u-a", "/hsfk-u-a", livePid());
  const b = await register("hsfk-u-b", "/hsfk-u-b", livePid());

  const send = await post<{ ok: boolean; error?: string }>(`${broker.url}/send-message`, {
    from_token: a.body.instance_token,
    to_peer_id: b.body.peer_id,
    text: "unregister payload",
  });
  expect(send.body.ok).toBe(true);

  // Direct unregister path (no TTL wait). Pre-fix this would throw the same FK
  // error inside the request handler.
  const unreg = await post(`${broker.url}/unregister`, {
    instance_token: a.body.instance_token,
  });
  expect(unreg.status).toBe(200);

  const peers = await get<{ instance_token: string }[]>(
    `${broker.url}/admin/peers?include_dormant=1`
  );
  expect(peers.body.find((p) => p.instance_token === a.body.instance_token)).toBeUndefined();
});
