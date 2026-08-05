// PLAN C20: roadmap_items.context (agent briefing) — create default, create
// with value, partial-patch semantics (omitted keeps, set replaces/clears),
// and preservation through archive and the export/import round-trip.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { startBroker, stopBroker, post, get, type TestBroker } from "./_helper.ts";
import type { RoadmapItem } from "../shared/types.ts";

let broker: TestBroker;

beforeAll(async () => {
  broker = await startBroker();
});

afterAll(async () => {
  await stopBroker(broker);
});

const PK = "github.com/vocsap/context-test";

type UpsertRes = { item: RoadmapItem };
type ListRes = { items: RoadmapItem[] };

async function add(fields: Record<string, unknown>): Promise<RoadmapItem> {
  const res = await post<UpsertRes>(`${broker.url}/roadmap/upsert`, {
    project_key: PK,
    by: "test-peer",
    ...fields,
  });
  expect(res.status).toBe(200);
  return res.body.item;
}

test("create defaults context to '' and accepts an explicit value", async () => {
  const bare = await add({ title: "No briefing yet" });
  expect(bare.context).toBe("");

  const briefed = await add({
    title: "With briefing",
    context: "**Objective**\nFix the flush cap.\n**Pointers**\nbroker.ts flushPendingForToken",
  });
  expect(briefed.context).toContain("flushPendingForToken");
});

test("patch: omitted context keeps, set replaces, empty string clears", async () => {
  const item = await add({ title: "Patch me", context: "initial briefing" });

  const untouched = await add({ id: item.id, title: "Patch me (renamed)" });
  expect(untouched.context).toBe("initial briefing");

  const replaced = await add({ id: item.id, context: "richer briefing" });
  expect(replaced.context).toBe("richer briefing");

  const cleared = await add({ id: item.id, context: "" });
  expect(cleared.context).toBe("");
});

test("archive keeps the context", async () => {
  const item = await add({ title: "Archive me", context: "survives the archive" });
  const arch = await post<UpsertRes>(`${broker.url}/roadmap/archive`, {
    id: item.id,
    by: "test-peer",
  });
  expect(arch.status).toBe(200);
  expect(arch.body.item.context).toBe("survives the archive");
});

test("export/import round-trip preserves context", async () => {
  await add({ title: "Round trip", context: "briefing that must travel" });
  const exported = await get<{ items: RoadmapItem[] }>(
    `${broker.url}/roadmap/export?project_key=${encodeURIComponent(PK)}`
  );
  expect(exported.status).toBe(200);
  const src = exported.body.items.find((i) => i.title === "Round trip")!;
  expect(src.context).toBe("briefing that must travel");

  const OTHER = "github.com/vocsap/context-import-target";
  const imp = await post<{ imported: number }>(`${broker.url}/roadmap/import`, {
    project_key: OTHER,
    by: "test-peer",
    items: exported.body.items,
  });
  expect(imp.status).toBe(200);

  const listed = await post<ListRes>(`${broker.url}/roadmap/list`, {
    project_key: OTHER,
    include_archived: true,
  });
  const back = listed.body.items.find((i) => i.title === "Round trip")!;
  expect(back.context).toBe("briefing that must travel");
});
