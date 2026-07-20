import { test, expect, beforeAll, afterAll } from "bun:test";
import { startBroker, stopBroker, post, livePid, type TestBroker } from "./_helper.ts";

let broker: TestBroker;

beforeAll(async () => { broker = await startBroker(); });
afterAll(async () => { await stopBroker(broker); });

interface RegisterBody { peer_id: string; instance_token: string }

async function register(host: string, cwd: string) {
  return post<RegisterBody>(`${broker.url}/register`, {
    pid: livePid(), cwd, git_root: null, tty: null, summary: "", host, client_pid: 1,
    project_key: null, group_id: "default", group_secret_hash: null,
  });
}

interface PeerRow { instance_token: string; activity_status: string }

async function listPeers(token: string, cwd: string): Promise<PeerRow[]> {
  const res = await post<PeerRow[]>(`${broker.url}/list-peers`, {
    scope: "machine", instance_token: token, cwd, git_root: null,
  });
  return res.body;
}

// Bug A: regression -- previously a peer right after /register had
// last_activity_at = NULL, so list_peers reported activity_status='sleep'
// (yellow icon) before it had ever sent a message. The fix initializes
// last_activity_at on INSERT and on dormant resurrect.

test("fresh peer reports activity_status 'active' immediately after register", async () => {
  const a = await register("activity-a", "/act-a");
  const b = await register("activity-b", "/act-b");
  const peers = await listPeers(b.body.instance_token, "/act-b");
  const aRow = peers.find((p) => p.peer_id === a.body.peer_id);
  expect(aRow).toBeDefined();
  expect(aRow!.activity_status).toBe("active");
});

test("resurrected dormant peer reports activity_status 'active' immediately", async () => {
  const a = await register("activity-r-a", "/act-r-a");
  const b = await register("activity-r-b", "/act-r-b");
  await post(`${broker.url}/disconnect`, { instance_token: a.body.instance_token });
  // Same (host, cwd, group_id) triple resurrects the dormant peer with the same token.
  const a2 = await register("activity-r-a", "/act-r-a");
  expect(a2.body.instance_token).toBe(a.body.instance_token);
  const peers = await listPeers(b.body.instance_token, "/act-r-b");
  const aRow = peers.find((p) => p.peer_id === a.body.peer_id);
  expect(aRow).toBeDefined();
  expect(aRow!.activity_status).toBe("active");
});
