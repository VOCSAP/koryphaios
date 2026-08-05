// PLAN C15: dispatch-queue position on roadmap items (queue INTEGER NULL).

import { test, expect, beforeAll, afterAll } from "bun:test";
import { startBroker, stopBroker, post, type TestBroker } from "./_helper.ts";
import type { RoadmapItem } from "../shared/types.ts";

let broker: TestBroker;
const KEY = "github.com/test/queue-repo";

beforeAll(async () => { broker = await startBroker(); });
afterAll(async () => { await stopBroker(broker); });

async function upsert(fields: Record<string, unknown>) {
  return post<{ item: RoadmapItem } | { error: string }>(`${broker.url}/roadmap/upsert`, {
    project_key: KEY,
    by: "deck",
    ...fields,
  });
}

test("items are created unqueued; queue can be set and cleared via upsert", async () => {
  const created = await upsert({ title: "queue me" });
  expect(created.status).toBe(200);
  const item = (created.body as { item: RoadmapItem }).item;
  expect(item.queue).toBeNull();

  const queued = await upsert({ id: item.id, queue: 1 });
  expect((queued.body as { item: RoadmapItem }).item.queue).toBe(1);

  // A patch that does not mention queue keeps it.
  const renamed = await upsert({ id: item.id, title: "still queued" });
  expect((renamed.body as { item: RoadmapItem }).item.queue).toBe(1);

  const unqueued = await upsert({ id: item.id, queue: null });
  expect((unqueued.body as { item: RoadmapItem }).item.queue).toBeNull();
});

test("queue must be a positive integer or null", async () => {
  const created = await upsert({ title: "bad queue target" });
  const id = (created.body as { item: RoadmapItem }).item.id;

  expect((await upsert({ id, queue: 0 })).status).toBe(400);
  expect((await upsert({ id, queue: -3 })).status).toBe(400);
  expect((await upsert({ id, queue: 1.5 })).status).toBe(400);
  expect((await upsert({ id, queue: "first" })).status).toBe(400);
  expect((await upsert({ id, queue: 2 })).status).toBe(200);
});

test("queue can be set at creation and survives export/import round-trip", async () => {
  const created = await upsert({ title: "born queued", queue: 7 });
  expect((created.body as { item: RoadmapItem }).item.queue).toBe(7);

  const exported = await fetch(
    `${broker.url}/roadmap/export?project_key=${encodeURIComponent(KEY)}`
  );
  const dump = (await exported.json()) as { items: RoadmapItem[] };
  const found = dump.items.find((i) => i.title === "born queued");
  expect(found?.queue).toBe(7);

  // Re-import into another project key: the position is preserved.
  const other = "github.com/test/queue-repo-2";
  const imported = await post<{ imported: number }>(`${broker.url}/roadmap/import`, {
    project_key: other,
    by: "test-peer",
    items: dump.items,
  });
  expect(imported.status).toBe(200);
  const listed = await post<{ items: RoadmapItem[] }>(`${broker.url}/roadmap/list`, {
    project_key: other,
  });
  expect(listed.body.items.find((i) => i.title === "born queued")?.queue).toBe(7);
});
