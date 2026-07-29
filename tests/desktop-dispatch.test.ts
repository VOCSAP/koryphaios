// PLAN C15: queue → team-lead dispatch helpers (desktop/src/main/dispatch).

import { test, expect } from "bun:test";
import {
  canAutoDispatchNext,
  composeAssignText,
  composeDispatchText,
  composeMultiDispatchText,
  composeStopText,
  dispatchNormalWave,
  firstQueued,
  nextBarrierPending,
  nextDispatchedState,
  nextQueuePosition,
  queuedItems,
  splitWave
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

// Roadmap card 5852c074: composeMultiDispatchText is the CODE CONSTANT sent
// to the team-lead for a whole head wave (C8 rule) -- pin its byte-identical
// N=1 delegation and lock the N>1 wording the card specifically revised
// (parallel framing, per-member numbering, supervisor-routed spawn).
test("composeMultiDispatchText: N=1 is byte-identical to composeDispatchText", () => {
  const solo = item({ id: "12345678-0000-0000-0000-000000000000", title: "Solo item" });
  expect(composeMultiDispatchText([solo])).toBe(composeDispatchText(solo));
});

test("composeMultiDispatchText: N>1 carries the parallel framing, per-member numbering, and supervisor spawn routing", () => {
  const a = item({ id: "aaaaaaaa-0000-0000-0000-000000000000", title: "First item" });
  const b = item({ id: "bbbbbbbb-0000-0000-0000-000000000000", title: "Second item" });
  const text = composeMultiDispatchText([a, b]);
  expect(text).toContain("2 roadmap items");
  expect(text).toContain("IN PARALLEL");
  expect(text).toContain("ids aaaaaaaa, bbbbbbbb");
  expect(text).toContain("[1/2] id aaaaaaaa");
  expect(text).toContain("Title: First item");
  expect(text).toContain("[2/2] id bbbbbbbb");
  expect(text).toContain("Title: Second item");
  expect(text).toContain("ask the SUPERVISOR (send_message) to spawn an additional agent");
  expect(text).toContain("you have no direct spawn capability");
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

// R5 wave barrier (card 42edc88b phase 3): watchDispatched's policy for
// whether an AUTOMATIC redispatch may fire. The manual "send first to
// team-lead" button calls dispatchNext() directly and is untested here on
// purpose -- it is intentionally unguarded (see canAutoDispatchNext's doc
// comment in dispatch.ts).

test("canAutoDispatchNext: false while a previous wave is still in flight", () => {
  const items = [item({ id: "a", queue: 1 })];
  const dispatchedIds = new Set(["some-in-flight-id"]);
  expect(canAutoDispatchNext(items, dispatchedIds)).toBe(false);
});

test("canAutoDispatchNext: false when the queue is empty (nothing to advance to)", () => {
  const items = [item({ id: "a", status: "done" })];
  expect(canAutoDispatchNext(items, new Set())).toBe(false);
});

test("canAutoDispatchNext: true when dispatchedIds is empty and the head has no dependency", () => {
  const items = [item({ id: "a", queue: 1 })];
  expect(canAutoDispatchNext(items, new Set())).toBe(true);
});

test("canAutoDispatchNext: false when the head's dependency is not done or archived", () => {
  const items = [
    item({ id: "dep", status: "in_progress" }),
    item({ id: "a", queue: 1, depends_on: ["dep"] })
  ];
  expect(canAutoDispatchNext(items, new Set())).toBe(false);
});

test("canAutoDispatchNext: true when the head's dependency is done or archived", () => {
  const doneItems = [
    item({ id: "dep", status: "done" }),
    item({ id: "a", queue: 1, depends_on: ["dep"] })
  ];
  expect(canAutoDispatchNext(doneItems, new Set())).toBe(true);

  const archivedItems = [
    item({ id: "dep", status: "archived" }),
    item({ id: "a", queue: 1, depends_on: ["dep"] })
  ];
  expect(canAutoDispatchNext(archivedItems, new Set())).toBe(true);
});

test("canAutoDispatchNext: a dependency missing from the roadmap counts as resolved", () => {
  const items = [item({ id: "a", queue: 1, depends_on: ["deleted-long-ago"] })];
  expect(canAutoDispatchNext(items, new Set())).toBe(true);
});

// dispatchedIds lifecycle (card 6f19206e): watchDispatched's only removal
// paths used to be done/archived/absent, so an operator stop or an
// idle-lock release reverting a CLAIMED item back to planned never left
// dispatchedIds, permanently closing the R5 wave barrier above. Sense A is
// the guard-rail against the naive/wrong fix (delete on planned+unlocked):
// a freshly dispatched item is planned+unlocked too, before it is claimed.

test("nextDispatchedState: sense A -- a freshly dispatched item (never claimed) stays tracked", () => {
  const it = item({ status: "planned", locked: false });
  expect(nextDispatchedState({ claimed: false }, it)).toEqual({ kind: "keep" });
});

test("nextDispatchedState: claims when the lead locks it in_progress", () => {
  const it = item({ status: "in_progress", locked: true });
  expect(nextDispatchedState({ claimed: false }, it)).toEqual({ kind: "claim" });
});

// Reviewer finding on commit 60213f0 (card 6f19206e review): claim must NOT
// require `locked`. broker.ts only grants the work-lock to a non-'deck'
// author writing status=in_progress -- the Deck's own in_progress writes
// (e.g. an operator kanban drag, author='deck') leave locked=false. Gating
// claim on `locked` stranded exactly that item: claimed never flips true,
// so a later revert to planned reads as never-claimed-kept instead of
// abandoned-removed, reproducing the barrier-stuck-forever bug this
// function exists to fix.
test("nextDispatchedState: claims on status alone -- a Deck-authored in_progress write (unlocked) still claims", () => {
  const it = item({ status: "in_progress", locked: false });
  expect(nextDispatchedState({ claimed: false }, it)).toEqual({ kind: "claim" });
});

test("nextDispatchedState: claim is idempotent -- already-claimed stays keep while still in_progress", () => {
  const it = item({ status: "in_progress", locked: true });
  expect(nextDispatchedState({ claimed: true }, it)).toEqual({ kind: "keep" });
  // A momentary lock hiccup (locked flips false) while status is STILL
  // in_progress must not be misread as an abandonment -- abandonment is
  // defined on (planned|idea)+unlocked, not merely "not currently locked".
  const flicker = item({ status: "in_progress", locked: false });
  expect(nextDispatchedState({ claimed: true }, flicker)).toEqual({ kind: "keep" });
});

test("nextDispatchedState: a claimed item reverted to planned+unlocked is removed as abandoned", () => {
  const it = item({ status: "planned", locked: false });
  expect(nextDispatchedState({ claimed: true }, it)).toEqual({ kind: "remove", reason: "abandoned" });
});

test("nextDispatchedState: same reverted-abandoned rule applies to idea", () => {
  const it = item({ status: "idea", locked: false });
  expect(nextDispatchedState({ claimed: true }, it)).toEqual({ kind: "remove", reason: "abandoned" });
});

test("nextDispatchedState: done and archived are removed regardless of claimed", () => {
  expect(nextDispatchedState({ claimed: false }, item({ status: "done" }))).toEqual({
    kind: "remove",
    reason: "done"
  });
  expect(nextDispatchedState({ claimed: true }, item({ status: "archived" }))).toEqual({
    kind: "remove",
    reason: "archived"
  });
});

test("nextDispatchedState: an item absent from the roadmap (deleted) is removed", () => {
  expect(nextDispatchedState({ claimed: true }, undefined)).toEqual({ kind: "remove", reason: "absent" });
});

test("nextDispatchedState: two sibling wave members diverge -- reverted one removed, untouched one kept", () => {
  const reverted = item({ id: "a", status: "planned", locked: false });
  const untouched = item({ id: "b", status: "planned", locked: false });
  expect(nextDispatchedState({ claimed: true }, reverted)).toEqual({ kind: "remove", reason: "abandoned" });
  expect(nextDispatchedState({ claimed: false }, untouched)).toEqual({ kind: "keep" });
});

// Multi-dispatch (roadmap card 5852c074): a whole head wave sent to the
// team-lead in one announce instead of one item at a time. splitWave and
// dispatchNormalWave hold the pure decision/orchestration so dispatchNextInner
// (index.ts, Electron-coupled) can stay a thin driver over them.

test("splitWave: partitions a wave into directives and normal items, preserving order", () => {
  const wave = [
    item({ id: "a", kind: "feature" }),
    item({ id: "b", kind: "directive" }),
    item({ id: "c", kind: "feature" }),
    item({ id: "d", kind: "directive" })
  ];
  const { directives, normal } = splitWave(wave);
  expect(directives.map((i) => i.id)).toEqual(["b", "d"]);
  expect(normal.map((i) => i.id)).toEqual(["a", "c"]);
});

test("splitWave: an all-normal or all-directive wave leaves the other bucket empty", () => {
  expect(splitWave([item({ id: "a" }), item({ id: "b" })]).directives).toEqual([]);
  expect(splitWave([item({ id: "a", kind: "directive" })]).normal).toEqual([]);
});

function mockDeps(opts: { announceReturns?: number; failIds?: Set<string> } = {}) {
  const announced: string[] = [];
  const upserted: string[] = [];
  return {
    announced,
    upserted,
    deps: {
      announce: async (text: string) => {
        announced.push(text);
        return opts.announceReturns ?? 1;
      },
      upsert: async (it: RoadmapItem) => {
        if (opts.failIds?.has(it.id)) throw new Error(`upsert failed for ${it.id}`);
        upserted.push(it.id);
      }
    }
  };
}

// Acceptance criterion 1: a wave of N>1 non-directive items produces exactly
// ONE announceToLead call and N upserts/tracked members.
test("dispatchNormalWave: N>1 members -- one announce, N upserts, count/titles result", async () => {
  const wave = [item({ id: "a", title: "A" }), item({ id: "b", title: "B" }), item({ id: "c", title: "C" })];
  const { announced, upserted, deps } = mockDeps();
  const { result, dispatched, failed } = await dispatchNormalWave(wave, deps);
  expect(announced.length).toBe(1);
  expect(upserted).toEqual(["a", "b", "c"]);
  expect(dispatched.map((i) => i.id)).toEqual(["a", "b", "c"]);
  expect(failed).toEqual([]);
  expect(result).toEqual({ sent: true, count: 3, titles: ["A", "B", "C"] });
});

// N=1 must stay byte-identical to the pre-5852c074 single-item shape (no
// count/titles), since index.ts's journal line and RoadmapView.tsx read
// r.title directly and never checked r.count.
test("dispatchNormalWave: a single member keeps the pre-wave {sent, title} shape", async () => {
  const { deps } = mockDeps();
  const { result } = await dispatchNormalWave([item({ id: "a", title: "Solo" })], deps);
  expect(result).toEqual({ sent: true, title: "Solo" });
});

test("dispatchNormalWave: no lead connected -- no upserts fire, reason no-lead", async () => {
  const { upserted, deps } = mockDeps({ announceReturns: 0 });
  const { result, dispatched } = await dispatchNormalWave([item({ id: "a" })], deps);
  expect(result).toEqual({ sent: false, reason: "no-lead" });
  expect(upserted).toEqual([]);
  expect(dispatched).toEqual([]);
});

test("dispatchNormalWave: an empty normal list is empty-queue without announcing", async () => {
  const { announced, deps } = mockDeps();
  const { result } = await dispatchNormalWave([], deps);
  expect(result).toEqual({ sent: false, reason: "empty-queue" });
  expect(announced).toEqual([]);
});

// Acceptance criterion 3: a throwing member's upsert must not orphan a
// dispatchedIds entry for THAT member, while siblings still succeed.
test("dispatchNormalWave: one member's upsert throws -- not dispatched/tracked, siblings still are", async () => {
  const wave = [item({ id: "a", title: "A" }), item({ id: "b", title: "B" }), item({ id: "c", title: "C" })];
  const { deps } = mockDeps({ failIds: new Set(["b"]) });
  const { result, dispatched, failed } = await dispatchNormalWave(wave, deps);
  expect(dispatched.map((i) => i.id)).toEqual(["a", "c"]);
  expect(failed.map((f) => f.item.id)).toEqual(["b"]);
  expect(result).toEqual({ sent: true, count: 2, titles: ["A", "C"] });
});

test("dispatchNormalWave: every member's upsert throws -- announced but nothing dispatched, reason error", async () => {
  const wave = [item({ id: "a" }), item({ id: "b" })];
  const { announced, deps } = mockDeps({ failIds: new Set(["a", "b"]) });
  const { result, dispatched } = await dispatchNormalWave(wave, deps);
  expect(announced.length).toBe(1);
  expect(dispatched).toEqual([]);
  expect(result).toEqual({ sent: false, reason: "error" });
});

// Acceptance criterion 4: barrierPending's three transitions (arm,
// clear-on-dispatch, clear-on-empty-queue), plus the "leave unchanged while a
// wave is still in flight" case that is neither of the three.

test("nextBarrierPending: arms when nothing just dispatched, dispatchedIds empty, and a head remains", () => {
  expect(nextBarrierPending(false, 0, false, true)).toBe(true);
});

test("nextBarrierPending: clears on a successful dispatch regardless of the resulting dispatchedIds size", () => {
  expect(nextBarrierPending(true, 3, true, true)).toBe(false);
});

test("nextBarrierPending: clears when the queue empties (no head left to block on)", () => {
  expect(nextBarrierPending(true, 0, false, false)).toBe(false);
});

test("nextBarrierPending: left unchanged while a previous wave is still in flight", () => {
  expect(nextBarrierPending(true, 2, false, true)).toBe(true);
  expect(nextBarrierPending(false, 2, false, true)).toBe(false);
});
