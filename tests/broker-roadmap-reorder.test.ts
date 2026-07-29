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

// Waves (roadmap card 42edc88b phase 1): additive optional grouping of ids
// into queue-position ties.

test("waves that flatten to exactly ids stamp same-wave items with a tied queue", async () => {
  const a = await create("wf wave a");
  const b = await create("wf wave b");
  const c = await create("wf wave c");

  const res = await reorder({ ids: [a.id, b.id, c.id], waves: [[a.id], [b.id, c.id]] });
  expect(res.status).toBe(200);
  const items = (res.body as { items: RoadmapItem[] }).items;
  const byId = new Map(items.map((i) => [i.id, i]));
  expect(byId.get(a.id)?.queue).toBe(1);
  expect(byId.get(b.id)?.queue).toBe(2);
  expect(byId.get(c.id)?.queue).toBe(2);
});

test("waves omitted keeps the existing flat 1..N stamping", async () => {
  const a = await create("wf noWaves a");
  const b = await create("wf noWaves b");
  const res = await reorder({ ids: [a.id, b.id] });
  expect(res.status).toBe(200);
  const items = (res.body as { items: RoadmapItem[] }).items;
  expect(items.map((i) => i.queue)).toEqual([1, 2]);
});

test("waves rejected when they do not flatten to exactly ids (set mismatch, order mismatch, length mismatch)", async () => {
  const a = await create("wf mismatch a");
  const b = await create("wf mismatch b");

  // Order mismatch: same set, wrong order.
  expect((await reorder({ ids: [a.id, b.id], waves: [[b.id], [a.id]] })).status).toBe(400);
  // Set mismatch: an id in waves that is not in ids.
  expect((await reorder({ ids: [a.id], waves: [[a.id, b.id]] })).status).toBe(400);
  // Length mismatch: waves flattens to fewer ids than ids.
  expect((await reorder({ ids: [a.id, b.id], waves: [[a.id]] })).status).toBe(400);
});

test("waves rejects an empty wave", async () => {
  const a = await create("wf empty wave");
  expect((await reorder({ ids: [a.id], waves: [[], [a.id]] })).status).toBe(400);
});

test("a directive-kind item may not share a wave of size > 1, but a singleton wave is fine", async () => {
  const feature = await create("wf directive peer");
  const directive = await create("wf directive card", {
    kind: "directive",
    directive: "clear",
  });

  // Grouped with another item: rejected.
  const grouped = await reorder({
    ids: [feature.id, directive.id],
    waves: [[feature.id, directive.id]],
  });
  expect(grouped.status).toBe(400);

  // Alone in its own wave: accepted.
  const singleton = await reorder({
    ids: [feature.id, directive.id],
    waves: [[feature.id], [directive.id]],
  });
  expect(singleton.status).toBe(200);
});

test("an empty waves array alongside an empty ids array clears the queue", async () => {
  const a = await create("wf clear via waves", { queue: 1 });
  const res = await reorder({ ids: [], waves: [] });
  expect(res.status).toBe(200);
  expect((res.body as { items: RoadmapItem[] }).items).toEqual([]);
  const list = await post<{ items: RoadmapItem[] }>(`${broker.url}/roadmap/list`, {
    project_key: KEY,
  });
  expect(list.body.items.find((i) => i.id === a.id)?.queue).toBeNull();
});
