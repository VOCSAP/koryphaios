// PLAN C15: queue → team-lead dispatch helpers (desktop/src/main/dispatch).

import { test, expect } from "bun:test";
import {
  composeDispatchText,
  firstQueued,
  nextQueuePosition,
  queuedItems
} from "../desktop/src/main/dispatch.ts";
import type { RoadmapItem } from "../desktop/src/shared/types";

function item(over: Partial<RoadmapItem>): RoadmapItem {
  return {
    id: over.id ?? "aaaaaaaa-0000-0000-0000-000000000000",
    project_key: "k",
    kind: "feature",
    title: "t",
    description: "",
    rationale: "",
    priority: "could",
    value: "medium",
    effort: "medium",
    status: "planned",
    tags: [],
    depends_on: [],
    created_by: "x",
    updated_by: "x",
    created_at: "2026-01-01",
    updated_at: "2026-01-01",
    deleted_at: null,
    queue: null,
    ...over
  };
}

test("queuedItems orders by position and skips done/archived/unqueued", () => {
  const items = [
    item({ id: "b", queue: 2 }),
    item({ id: "a", queue: 1 }),
    item({ id: "c", queue: null }),
    item({ id: "d", queue: 3, status: "done" }),
    item({ id: "e", queue: 4, status: "archived" })
  ];
  expect(queuedItems(items).map((i) => i.id)).toEqual(["a", "b"]);
  expect(firstQueued(items)?.id).toBe("a");
  expect(firstQueued([item({ queue: null })])).toBeNull();
});

test("nextQueuePosition is max + 1 (1 on an empty queue)", () => {
  expect(nextQueuePosition([])).toBe(1);
  expect(nextQueuePosition([item({ queue: null })])).toBe(1);
  expect(nextQueuePosition([item({ queue: 4 }), item({ queue: 2 })])).toBe(5);
});

test("composeDispatchText carries the full item and the status contract", () => {
  const text = composeDispatchText(
    item({
      id: "12345678-1111-2222-3333-444444444444",
      title: "Fix login",
      description: "Login breaks on Safari",
      rationale: "Blocks EU users",
      tags: ["auth", "p1"],
      depends_on: ["87654321-0000-0000-0000-000000000000"],
      queue: 1
    })
  );
  expect(text).toContain("id 12345678");
  expect(text).toContain("Title: Fix login");
  expect(text).toContain("Description: Login breaks on Safari");
  expect(text).toContain("Rationale: Blocks EU users");
  expect(text).toContain("Tags: auth, p1");
  expect(text).toContain("Depends on: 87654321");
  expect(text).toContain("roadmap_update");
  expect(text).toContain("auto-dispatches the next queued item");
});
