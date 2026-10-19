import { test, expect, beforeAll, afterAll } from "bun:test";
import { startBroker, stopBroker, post, get, livePid, type TestBroker, openBrokerDb } from "./_helper.ts";

let broker: TestBroker;

beforeAll(async () => {
  // The TTL stays positive so no dormant row but a backdated one is eligible to the sweep.
  broker = await startBroker({ CLAUDE_PEERS_CLEAN_INTERVAL_SEC: "1" });
});
afterAll(async () => { await stopBroker(broker); });

async function register(host: string, cwd: string, pid: number) {
  return post<{ peer_id: string; instance_token: string }>(`${broker.url}/register`, {
    pid, cwd, git_root: null, tty: null, summary: "", host, client_pid: 1,
    project_key: null, group_id: "default", group_secret_hash: null,
  });
}

test("disconnect transitions a peer to 'dormant', and list_peers excludes it", async () => {
  const a = await register("hs1a", "/hs1a", livePid());
  const b = await register("hs1b", "/hs1b", livePid());
  await post(`${broker.url}/disconnect`, { instance_token: a.body.instance_token });

  const peers = await post<unknown[]>(`${broker.url}/list-peers`, {
    scope: "machine",
    instance_token: b.body.instance_token,
    cwd: "/x",
    git_root: null,
  });
  const tokens = peers.body.map((p: any) => p.instance_token);
  expect(tokens).not.toContain(a.body.instance_token);
});

test("admin/peers exposes dormant when ?include_dormant=1", async () => {
  const a = await register("hs2", "/hs2", livePid());
  await post(`${broker.url}/disconnect`, { instance_token: a.body.instance_token });

  const without = await get<any[]>(`${broker.url}/admin/peers`);
  expect(without.body.find((p) => p.peer_id === a.body.peer_id)).toBeUndefined();

  const withDormant = await get<any[]>(`${broker.url}/admin/peers?include_dormant=1`);
  const found = withDormant.body.find((p) => p.peer_id === a.body.peer_id);
  expect(found).toBeDefined();
  expect(found.status).toBe("dormant");
});

test("dormant peers past TTL are purged by cleanStalePeers", async () => {
  const a = await register("hs3", "/hs3", livePid());
  await post(`${broker.url}/disconnect`, { instance_token: a.body.instance_token });

  const db = openBrokerDb(broker.dbPath);
  db.run("UPDATE peers SET last_seen = ? WHERE instance_token = ?", [
    "2000-01-01T00:00:00Z",
    a.body.instance_token,
  ]);
  db.close();

  // The next cleanStalePeers tick purges it.
  const deadline = Date.now() + 10_000;
  let stillThere = true;
  while (stillThere && Date.now() < deadline) {
    const peers = await get<any[]>(`${broker.url}/admin/peers?include_dormant=1`);
    stillThere = !!peers.body.find((p) => p.peer_id === a.body.peer_id);
    if (stillThere) await Bun.sleep(50);
  }
  expect(stillThere).toBe(false);
}, 40_000);
