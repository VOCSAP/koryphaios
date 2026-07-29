// PLAN C15: queue → team-lead dispatch helpers (desktop/src/main/dispatch).

import { test, expect } from "bun:test";
import {
  composeAssignText,
  composeDispatchText,
  composeStopText,
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
    context: "",
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
    locked: false,
    locked_by: null,
    locked_at: null,
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

test("queuedItems delegates to shared/workflow: a queue tie is still broken by id", () => {
  // dispatch.ts used to own its own localeCompare tiebreak; it now
  // re-exports shared/workflow's queuedItems. Pin that the delegation kept
  // the byte-compare id tiebreak (roadmap card 42edc88b phase 0).
  const items = [item({ id: "z", queue: 1 }), item({ id: "a", queue: 1 })];
  expect(queuedItems(items).map((i) => i.id)).toEqual(["a", "z"]);
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
      context: "**Pointers**: auth/safari.ts — imitate the Chrome fallback",
      tags: ["auth", "p1"],
      depends_on: ["87654321-0000-0000-0000-000000000000"],
      queue: 1
    })
  );
  expect(text).toContain("id 12345678");
  expect(text).toContain("Title: Fix login");
  expect(text).toContain("Description: Login breaks on Safari");
  expect(text).toContain("Rationale: Blocks EU users");
  expect(text).toContain("Context (operator briefing): **Pointers**: auth/safari.ts");
  expect(text).toContain("Tags: auth, p1");
  expect(text).toContain("Depends on: 87654321");
  expect(text).toContain("roadmap_update");
  expect(text).toContain("auto-dispatches the next queued item");
});

// PLAN K3: operator stop notice (CODE CONSTANT, C8 rule).
test("composeStopText names the item and carries the unlock statement", () => {
  const it = item({ id: "12345678-1111-2222-3333-444444444444", title: "Fix login" });
  for (const via of [true, false]) {
    const text = composeStopText(it, via);
    expect(text).toContain('STOP all work on roadmap item "Fix login"');
    expect(text).toContain("id 12345678");
    expect(text).toContain("unlocked and moved back to planned");
  }
});

test("composeStopText targets the supervisor or the whole group", () => {
  const it = item({ title: "t" });
  expect(composeStopText(it, true)).toContain("As supervisor:");
  expect(composeStopText(it, true)).toContain('send_message to "operator"');
  expect(composeStopText(it, false)).toContain("If you are working on this item: stop now");
  expect(composeStopText(it, false)).not.toContain("As supervisor:");
});

// PLAN K6: direct "process now" assignment to one chosen peer (CODE CONSTANT).
test("composeAssignText carries the full item and the take-it-now contract", () => {
  const text = composeAssignText(
    item({
      id: "12345678-1111-2222-3333-444444444444",
      title: "Fix login",
      description: "Login breaks on Safari",
      context: "auth/safari.ts",
      tags: ["auth"]
    })
  );
  expect(text).toContain("assigned THIS roadmap item to you");
  expect(text).toContain("id 12345678");
  expect(text).toContain("Title: Fix login");
  expect(text).toContain("Description: Login breaks on Safari");
  expect(text).toContain("Context (operator briefing): auth/safari.ts");
  expect(text).toContain("Tags: auth");
  expect(text).toContain("locks it under your peer_id");
  // Targeted flow: no team-lead relaying step.
  expect(text).not.toContain("team-lead");
});
