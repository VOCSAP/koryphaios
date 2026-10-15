import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { deckAuthored, startBroker, stopBroker, type TestBroker } from "./_helper.ts";

type Reply<T> = { status: number; body: T };
type RoadmapItem = { id: string; title: string };

async function post<T>(url: string, token: string, body: unknown): Promise<Reply<T>> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as T };
}

async function waitForReplicaItem(replica: TestBroker, token: string, projectKey: string, id: string): Promise<RoadmapItem> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const listed = await post<{ items: RoadmapItem[] }>(`${replica.url}/roadmap/list`, token, { project_key: projectKey });
    const item = listed.body.items.find((candidate) => candidate.id === id);
    if (item) return item;
    await Bun.sleep(50);
  }
  throw new Error("upstream roadmap item did not reach the replica");
}

test("an unprovisioned replica refuses local operator work while its Bearer sync stays online", async () => {
  const token = randomUUID();
  const projectKey = "operator-trust-replica";
  const upstream = await startBroker({
    CLAUDE_PEERS_BROKER_TOKEN: token,
    CLAUDE_PEERS_SERVE_REPLICAS: "1",
  });
  let replica: TestBroker | null = null;
  try {
    replica = await startBroker(
      {
        CLAUDE_PEERS_BROKER_URL: upstream.url,
        CLAUDE_PEERS_BROKER_TOKEN: token,
        CLAUDE_PEERS_OFFLINE_REPLICA: "1",
        CLAUDE_PEERS_SYNC_TICK_MS: "100",
      },
      { trustedOperators: null }
    );

    const localRefusal = await post<{ error: string }>(`${replica.url}/operator/check`, token, deckAuthored({}));
    const created = await post<{ item: RoadmapItem }>(`${upstream.url}/roadmap/upsert`, token, {
      project_key: projectKey,
      by: "replica-policy-test",
      title: "upstream remains reachable",
    });

    expect([localRefusal.status, localRefusal.body.error]).toEqual([503, "operator-trust-unconfigured"]);
    expect(created.status).toBe(200);
    const replicated = await waitForReplicaItem(replica, token, projectKey, created.body.item.id);
    expect(replicated.title).toBe("upstream remains reachable");
  } finally {
    if (replica) await stopBroker(replica);
    await stopBroker(upstream);
  }
}, 30_000);
