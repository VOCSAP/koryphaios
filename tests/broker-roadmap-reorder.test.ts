// Workflow lane: atomic dispatch-queue rewrite via /roadmap/reorder.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { startBroker, stopBroker, post, type TestBroker } from "./_helper.ts";
import type { RoadmapItem } from "../shared/types.ts";

let broker: TestBroker;
const KEY = "github.com/test/reorder-repo";

beforeAll(async () => {
  broker = await startBroker();
});
afterAll(async () => {
  await stopBroker(broker);
});

async function upsert(fields: Record<string, unknown>) {
  return post<{ item: RoadmapItem } | { error: string }>(`${broker.url}/roadmap/upsert`, {
    project_key: KEY,
    by: "deck",
    ...fields,
  });
}

async function reorder(fields: Record<string, unknown>) {
  return post<{ items: RoadmapItem[] } | { error: string }>(`${broker.url}/roadmap/reorder`, {
    project_key: KEY,
    by: "deck",
    ...fields,
  });
}

async function create(title: string, extra: Record<string, unknown> = {}): Promise<RoadmapItem> {
  const res = await upsert({ title, status: "planned", ...extra });
  expect(res.status).toBe(200);
  return (res.body as { item: RoadmapItem }).item;
}

test("reorder rewrites the whole queue: listed ids get 1..N, others are unqueued", async () => {
  const a = await create("wf a", { queue: 1 });
  const b = await create("wf b", { queue: 2 });
  const c = await create("wf c"); // unqueued so far

  const res = await reorder({ ids: [c.id, a.id] });
  expect(res.status).toBe(200);
  const items = (res.body as { items: RoadmapItem[] }).items;
  expect(items.map((i) => i.id)).toEqual([c.id, a.id]);
  expect(items.map((i) => i.queue)).toEqual([1, 2]);

  // b was queued but omitted from the rewrite: it left the queue.
  const list = await post<{ items: RoadmapItem[] }>(`${broker.url}/roadmap/list`, {
    project_key: KEY,
  });
  const b2 = list.body.items.find((i) => i.id === b.id);
  expect(b2?.queue).toBeNull();
  expect(b2?.updated_by).toBe("deck");
});

test("an empty ids array clears the queue entirely", async () => {
  const a = await create("wf clear", { queue: 1 });
  const res = await reorder({ ids: [] });
  expect(res.status).toBe(200);
  expect((res.body as { items: RoadmapItem[] }).items).toEqual([]);
  const list = await post<{ items: RoadmapItem[] }>(`${broker.url}/roadmap/list`, {
    project_key: KEY,
  });
  expect(list.body.items.find((i) => i.id === a.id)?.queue).toBeNull();
});

test("reorder validates authorship, project scope, duplicates and closed items", async () => {
  const a = await create("wf valid");
  const done = await create("wf done");
  await upsert({ id: done.id, status: "done" });

  expect((await reorder({ ids: [a.id], by: "" })).status).toBe(400);
  expect((await reorder({ ids: "nope" })).status).toBe(400);
  expect((await reorder({ ids: [a.id, a.id] })).status).toBe(400);
  expect((await reorder({ ids: ["missing-id"] })).status).toBe(404);
  expect((await reorder({ ids: [done.id] })).status).toBe(400);

  // Foreign project: the same id under another key is unknown.
  const foreign = await reorder({ project_key: "github.com/test/other", ids: [a.id] });
  expect(foreign.status).toBe(404);

  // A failed rewrite must not have touched the queue (transaction).
  await reorder({ ids: [a.id] });
  const before = await post<{ items: RoadmapItem[] }>(`${broker.url}/roadmap/list`, {
    project_key: KEY,
  });
  expect(before.body.items.find((i) => i.id === a.id)?.queue).toBe(1)
  expect((await reorder({ ids: [a.id, "missing-id"] })).status).toBe(404);
  const after = await post<{ items: RoadmapItem[] }>(`${broker.url}/roadmap/list`, {
    project_key: KEY,
  });
  expect(after.body.items.find((i) => i.id === a.id)?.queue).toBe(1);
});

test("reorder caps the ids array", async () => {
  const ids = Array.from({ length: 501 }, (_, i) => `id-${i}`);
  expect((await reorder({ ids })).status).toBe(400);
});
