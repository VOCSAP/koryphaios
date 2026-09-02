// PLAN C15: queue → team-lead dispatch helpers (desktop/src/main/dispatch).

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  canAutoDispatchNext,
  composeAssignText,
  composeDispatchOutcome,
  composeDispatchText,
  composeMultiDispatchText,
  composeStopText,
  composeUnresolvedContext,
  dispatchNormalWave,
  firstQueued,
  nextBarrierPending,
  nextDispatchedState,
  nextQueuePosition,
  NO_TARGET_REQUESTED_NOTE,
  queuedItems,
  runDirectiveWave,
  runDispatchRequestPoll,
  splitWave,
  UNRESOLVED_TARGET_NOTE,
  unresolvedDirectiveNote
} from "../desktop/src/main/dispatch.ts";
import type {
  DirectiveDispatch,
  DispatchResult,
  RoadmapItem
} from "../desktop/src/shared/types";
// The dispatch-request shapes are the BROKER's, declared once at the repo root
// and imported by the three main-process consumers -- not mirrored Deck-side.
// This test must read them from the same place they do, or it would pin a copy
// nobody uses.
import type { DispatchRequest, DispatchRequestOutcome } from "../shared/types";

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
    // The four REQUIRED fields this factory used to leave to `...over` alone.
    // A Partial<RoadmapItem> widens each of them with `undefined`, which the
    // repo-root `tsc --noEmit` rejects with TS2322; desktop/'s own typecheck
    // never sees it, since this file is outside tsconfig.node/web. Listed
    // exhaustively against RoadmapItem rather than one at a time: tsc reports
    // only the FIRST incompatible property, so fixing them singly means one
    // full typecheck round-trip per field.
    locked_group: null,
    directive: null,
    target_peer_ids: [],
    inactive: false,
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

// Directive drain ordering (roadmap card b1932a6a): mark-then-execute, not
// execute-then-mark. See runDirectiveWave's doc comment in dispatch.ts.

/** A report shaped like executeDirective's, with nothing resolved by default. */
function report(over: Partial<DirectiveDispatch> = {}): DirectiveDispatch {
  return {
    id: over.id ?? "a",
    title: over.title ?? "t",
    directive: over.directive ?? "clear",
    injected: over.injected ?? [],
    unreached: over.unreached ?? []
  };
}

function mockDirectiveDeps(
  opts: {
    throwForIds?: Set<string>;
    reports?: Record<string, DirectiveDispatch>;
    noteThrowsForIds?: Set<string>;
  } = {}
) {
  const order: string[] = [];
  const journaled: string[] = [];
  const reported: { message: string; error: unknown }[] = [];
  const noted: string[] = [];
  return {
    order,
    journaled,
    reported,
    noted,
    deps: {
      markDone: async (it: RoadmapItem) => {
        order.push(`mark:${it.id}`);
      },
      execute: async (it: RoadmapItem): Promise<DirectiveDispatch> => {
        order.push(`execute:${it.id}`);
        if (opts.throwForIds?.has(it.id)) throw new Error(`inject failed for ${it.id}`);
        return opts.reports?.[it.id] ?? report({ id: it.id, title: it.title });
      },
      journal: (line: string) => journaled.push(line),
      reportError: (message: string, error: unknown) => reported.push({ message, error }),
      // Card 249ed831 (form b).
      noteUnresolved: async (it: RoadmapItem) => {
        order.push(`note:${it.id}`);
        if (opts.noteThrowsForIds?.has(it.id)) throw new Error(`note failed for ${it.id}`);
        noted.push(it.id);
      }
    }
  };
}

test("runDirectiveWave: marks done BEFORE executing (mark-then-execute, not the reverse)", async () => {
  const { order, deps } = mockDirectiveDeps();
  await runDirectiveWave([item({ id: "a", kind: "directive", directive: "clear" })], deps);
  // The default mock report (directive:'clear', injected:[]) is itself an
  // unresolved-target outcome (card 249ed831), so the note fires too -- see
  // the dedicated noteUnresolved tests below for its own ordering/predicate.
  expect(order).toEqual(["mark:a", "execute:a", "note:a"]);
});

// The failure-path assertion the card's briefing calls out explicitly: a
// throwing execute must surface as a JOURNAL LINE, not merely as "markDone
// was called" or "the card is done" -- a status-only assertion would pass
// even if the journal call were deleted entirely.
test("runDirectiveWave: execute throwing after the mark is journaled, not swallowed", async () => {
  const { order, journaled, reported, deps } = mockDirectiveDeps({ throwForIds: new Set(["a"]) });
  await runDirectiveWave([item({ id: "a", kind: "directive", directive: "clear", title: "Clear all" })], deps);
  expect(order).toEqual(["mark:a", "execute:a"]);
  expect(journaled).toHaveLength(1);
  expect(journaled[0]).toContain("Clear all");
  expect(journaled[0]).toContain("marked done but execution threw");
  expect(journaled[0]).toContain("inject failed for a");
  expect(reported).toHaveLength(1);
  expect(reported[0]!.message).toContain("Clear all");
});

test("runDirectiveWave: one item throwing does not stop siblings in the same wave", async () => {
  const { order, journaled, deps } = mockDirectiveDeps({ throwForIds: new Set(["a"]) });
  await runDirectiveWave(
    [
      item({ id: "a", kind: "directive", directive: "clear" }),
      item({ id: "b", kind: "directive", directive: "compact" })
    ],
    deps
  );
  // b's default mock report is itself unresolved (injected:[]), so its note
  // fires too -- see the dedicated noteUnresolved tests below.
  expect(order).toEqual(["mark:a", "execute:a", "mark:b", "execute:b", "note:b"]);
  expect(journaled).toHaveLength(2);
  expect(journaled[0]).toContain("marked done but execution threw");
  expect(journaled[1]).toContain("directive card dispatched");
});

test("runDirectiveWave: markDone throwing is not caught -- it propagates and execute never runs", async () => {
  const { order, deps } = mockDirectiveDeps();
  deps.markDone = async () => {
    throw new Error("upsert failed");
  };
  await expect(
    runDirectiveWave([item({ id: "a", kind: "directive", directive: "clear" })], deps)
  ).rejects.toThrow("upsert failed");
  expect(order).toEqual([]);
});

test("runDirectiveWave: an invalid/null directive falls back to the '?' label", async () => {
  const { journaled, deps } = mockDirectiveDeps();
  await runDirectiveWave([item({ id: "a", kind: "directive", directive: null, title: "Broken card" })], deps);
  expect(journaled).toEqual(['directive card dispatched: "Broken card" (?) -> no target reached']);
});

// Card bf76d37f: the resolver's buckets stop being journaled-then-discarded.
// These probes are BEHAVIOURAL -- they drive the real runDirectiveWave and
// read its real return value; only the executor's own wiring (index.ts, not
// importable under bun) is left to a source scan, in
// tests/desktop-directive-journal.test.ts.

test("runDirectiveWave: returns one report per card, carrying resolved AND unresolved targets distinctly", async () => {
  const resolved = report({
    id: "a",
    title: "Clear one",
    directive: "clear",
    injected: [{ tileId: "tile-1", peerId: "peer-a" }]
  });
  const ambiguousOnly = report({
    id: "b",
    title: "Compact the twin",
    directive: "compact",
    unreached: [{ peerId: "dup-peer", reason: "ambiguous" }]
  });
  const { deps } = mockDirectiveDeps({ reports: { a: resolved, b: ambiguousOnly } });
  const out = await runDirectiveWave(
    [
      item({ id: "a", kind: "directive", directive: "clear", title: "Clear one" }),
      item({ id: "b", kind: "directive", directive: "compact", title: "Compact the twin" })
    ],
    deps
  );
  expect(out).toHaveLength(2);
  // The wave carries BOTH outcomes, and they are not conflated: one names the
  // tile it actually hit, the other names the id it refused and WHY.
  expect(out[0]!.injected).toEqual([{ tileId: "tile-1", peerId: "peer-a" }]);
  expect(out[0]!.unreached).toEqual([]);
  expect(out[1]!.injected).toEqual([]);
  expect(out[1]!.unreached).toEqual([{ peerId: "dup-peer", reason: "ambiguous" }]);
  // Per-card identity, so a caller can tell which card produced which outcome.
  expect(out.map((r) => r.id)).toEqual(["a", "b"]);
});

test("runDirectiveWave: a card whose execute throws is ABSENT from the reports, never an empty one", async () => {
  const { deps } = mockDirectiveDeps({ throwForIds: new Set(["a"]) });
  const out = await runDirectiveWave(
    [
      item({ id: "a", kind: "directive", directive: "clear" }),
      item({ id: "b", kind: "directive", directive: "compact" })
    ],
    deps
  );
  // An empty report for "a" would read as "nothing was unreached", which is a
  // claim nobody can make: the execution never returned.
  expect(out.map((r) => r.id)).toEqual(["b"]);
});

test("runDirectiveWave: the dispatched journal line carries the hit/miss counts (the report is READ)", async () => {
  const { journaled, deps } = mockDirectiveDeps({
    reports: {
      a: report({
        id: "a",
        title: "Clear both",
        injected: [
          { tileId: "t1", peerId: "peer-a" },
          { tileId: "t2", peerId: "peer-b" }
        ],
        unreached: [{ peerId: "gone", reason: "no-live-target" }]
      })
    }
  });
  await runDirectiveWave([item({ id: "a", kind: "directive", directive: "clear", title: "Clear both" })], deps);
  expect(journaled).toEqual(['directive card dispatched: "Clear both" (/clear) -> 2 targets, 1 unreached']);
  // Counts only: the ids belong to executeDirective's own unreached line, and
  // naming them here too would report the same miss twice.
  expect(journaled[0]).not.toContain("gone");
});

// Card 249ed831 (form b): a directive card marked done with zero targets
// resolved must post the operator-visible note, on the exact predicate
// `report.directive !== null && report.injected.length === 0` -- not a
// heuristic reconstructed from the item or from `unreached`.

test("runDirectiveWave: posts the unresolved note when zero targets are resolved (directive stays non-null)", async () => {
  const { noted, order, deps } = mockDirectiveDeps({
    reports: { a: report({ id: "a", directive: "clear", injected: [], unreached: [{ peerId: "gone", reason: "no-live-target" }] }) }
  });
  await runDirectiveWave([item({ id: "a", kind: "directive", directive: "clear" })], deps);
  expect(noted).toEqual(["a"]);
  // Runs AFTER the journal line, not interleaved before it.
  expect(order).toEqual(["mark:a", "execute:a", "note:a"]);
});

test("runDirectiveWave: does NOT post the note when the card resolved at least one target", async () => {
  const { noted, deps } = mockDirectiveDeps({
    reports: {
      a: report({ id: "a", directive: "clear", injected: [{ tileId: "t1", peerId: "peer-a" }] })
    }
  });
  await runDirectiveWave([item({ id: "a", kind: "directive", directive: "clear" })], deps);
  expect(noted).toEqual([]);
});

test("runDirectiveWave: does NOT post the note on the parse-refusal report (directive: null)", async () => {
  // Shape executeDirective actually returns when isDirectiveCommand(cmd) is
  // false (index.ts): directive:null, injected:[] -- injected is empty here
  // too, so `directive !== null` is the ONLY thing distinguishing this from
  // the branch that must fire. Built by hand, not via report(): that helper's
  // `over.directive ?? "clear"` default treats an explicit `null` as "not
  // provided" (nullish coalescing) and silently substitutes "clear".
  const { noted, deps } = mockDirectiveDeps({
    reports: { a: { id: "a", title: "t", directive: null, injected: [], unreached: [] } }
  });
  await runDirectiveWave([item({ id: "a", kind: "directive", directive: null })], deps);
  expect(noted).toEqual([]);
});

test("runDirectiveWave: noteUnresolved throwing is reported, not fatal -- the wave's report still returns", async () => {
  const unresolvedReport = report({ id: "a", directive: "clear", injected: [] });
  const { noted, reported, deps } = mockDirectiveDeps({
    reports: { a: unresolvedReport },
    noteThrowsForIds: new Set(["a"])
  });
  const out = await runDirectiveWave([item({ id: "a", kind: "directive", directive: "clear" })], deps);
  expect(noted).toEqual([]); // threw before pushing
  expect(out).toEqual([unresolvedReport]); // execute's own result is unaffected
  expect(reported).toHaveLength(1);
  expect(reported[0]!.message).toContain("unresolved-target note");
  expect(reported[0]!.error).toBeInstanceOf(Error);
});

test("composeUnresolvedContext: appends the given note to existing context", () => {
  const out = composeUnresolvedContext("Some operator-written context.", UNRESOLVED_TARGET_NOTE);
  expect(out).toBe(`Some operator-written context.\n\n${UNRESOLVED_TARGET_NOTE}`);
});

test("composeUnresolvedContext: empty context gets the note ALONE, no leading blank separator", () => {
  const out = composeUnresolvedContext("", UNRESOLVED_TARGET_NOTE);
  expect(out).toBe(UNRESOLVED_TARGET_NOTE);
});

test("composeUnresolvedContext: a card re-queued and failed again the SAME way carries the note ONCE, not twice", () => {
  const once = composeUnresolvedContext("Context.", UNRESOLVED_TARGET_NOTE);
  const twice = composeUnresolvedContext(once, UNRESOLVED_TARGET_NOTE);
  expect(twice).toBe(`Context.\n\n${UNRESOLVED_TARGET_NOTE}`);
  expect(twice.split(UNRESOLVED_TARGET_NOTE)).toHaveLength(2); // one occurrence only
});

// Card 249ed831, reviewer round 2 point 5: two distinct causes, two distinct
// (and mutually exclusive) recommendations.

test("unresolvedDirectiveNote: empty target_peer_ids gets the 'set targets first' note, not the re-queue one", () => {
  expect(unresolvedDirectiveNote(item({ target_peer_ids: [] }))).toBe(NO_TARGET_REQUESTED_NOTE);
});

test("unresolvedDirectiveNote: a requested-but-unreachable target gets the re-queue note", () => {
  expect(unresolvedDirectiveNote(item({ target_peer_ids: ["peer-a"] }))).toBe(UNRESOLVED_TARGET_NOTE);
});

test("composeUnresolvedContext: a card whose failure reason CHANGED between attempts carries only the NEW note", () => {
  const firstFailure = composeUnresolvedContext("Context.", NO_TARGET_REQUESTED_NOTE);
  const secondFailure = composeUnresolvedContext(firstFailure, UNRESOLVED_TARGET_NOTE);
  expect(secondFailure).toBe(`Context.\n\n${UNRESOLVED_TARGET_NOTE}`);
  expect(secondFailure).not.toContain(NO_TARGET_REQUESTED_NOTE);
});

// Reviewer round 3: the strip must be SYMMETRIC with the append. The append
// is conditional (an empty existingContext gets the note with no leading
// separator), so a strip that only recognizes the PREFIXED form would never
// re-find a note stored on an originally-empty context -- the exact bug this
// pair of round-trips exists to catch, starting from `""` where the earlier
// "Context." round-trips above stay blind to it.

test("composeUnresolvedContext: empty-context round trip, SAME cause, carries the note ONCE, not twice", () => {
  const once = composeUnresolvedContext("", UNRESOLVED_TARGET_NOTE);
  const twice = composeUnresolvedContext(once, UNRESOLVED_TARGET_NOTE);
  expect(twice).toBe(UNRESOLVED_TARGET_NOTE);
  expect(twice.split(UNRESOLVED_TARGET_NOTE)).toHaveLength(2); // one occurrence only
});

test("composeUnresolvedContext: empty-context round trip, cause CHANGED, carries only the NEW note -- never both", () => {
  const firstFailure = composeUnresolvedContext("", NO_TARGET_REQUESTED_NOTE);
  const secondFailure = composeUnresolvedContext(firstFailure, UNRESOLVED_TARGET_NOTE);
  expect(secondFailure).toBe(UNRESOLVED_TARGET_NOTE);
  expect(secondFailure).not.toContain(NO_TARGET_REQUESTED_NOTE);
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

// ---------------------------------------------------------------------------
// Dispatch requests (card bf76d37f): the Deck side of the agent's MCP tool.
// Behavioural throughout -- runDispatchRequestPoll is dependency-injected on
// purpose, so the park branch, the throwing dispatch and the throwing resolve
// are all real executions here, not source scans.
// ---------------------------------------------------------------------------

function request(id: string): DispatchRequest {
  return {
    id,
    project_key: "k",
    from_peer: "agent-1",
    status: "pending",
    created_at: "2026-01-01T00:00:00.000Z",
    resolved_at: null,
    outcome: null
  };
}

test("composeDispatchOutcome: the three buckets are PROJECTED, ambiguous stays a subset of missing", () => {
  const result: DispatchResult = {
    sent: false,
    reason: "empty-queue",
    directives: [
      {
        id: "card-1111",
        title: "Clear the twins",
        directive: "clear",
        injected: [{ tileId: "t1", peerId: "peer-a" }],
        unreached: [
          { peerId: "gone", reason: "no-live-target" },
          { peerId: "dup", reason: "ambiguous" }
        ]
      }
    ]
  };
  const out = composeDispatchOutcome(result);
  expect(out.cards).toHaveLength(1);
  const c = out.cards[0]!;
  expect(c.id).toBe("card-1111"); // COMPLETE id: the broker truncates, not us.
  expect(c.kind).toBe("directive");
  expect(c.matched).toEqual(["peer-a"]);
  // `ambiguous` must be contained in `missing`, exactly as the resolver
  // guarantees -- the subset relation has to survive the projection.
  expect(c.missing).toEqual(["gone", "dup"]);
  expect(c.ambiguous).toEqual(["dup"]);
  for (const a of c.ambiguous) expect(c.missing).toContain(a);
});

test("composeDispatchOutcome: a mixed wave reports both families, directives first, each with its kind", () => {
  const out = composeDispatchOutcome({
    sent: true,
    count: 1,
    titles: ["Ship the thing"],
    directives: [
      { id: "d1", title: "Compact", directive: "compact", injected: [], unreached: [] }
    ],
    dispatched: [{ id: "n1", title: "Ship the thing", kind: "feature" }]
  });
  expect(out.cards.map((c) => c.id)).toEqual(["d1", "n1"]);
  // A directive that reached nothing and a normal card BOTH carry three empty
  // buckets: `kind` is the only thing that tells them apart.
  expect(out.cards.map((c) => c.kind)).toEqual(["directive", "feature"]);
  expect(out.cards[0]!.missing).toEqual([]);
  expect(out.cards[1]!.missing).toEqual([]);
  expect(out.note).toContain("1 card announced");
  expect(out.note).toContain("1 directive card executed");
});

test("composeDispatchOutcome: nothing eligible is a SUCCESS with an empty cards list, not an error", () => {
  const out = composeDispatchOutcome({ sent: false, reason: "empty-queue" });
  expect(out.cards).toEqual([]);
  expect(out.note).toContain("nothing eligible");
  // The reason must survive: an empty queue and a missing lead are the same
  // "nothing happened" for very different operator actions.
  expect(out.note).toContain("empty-queue");
  expect(composeDispatchOutcome({ sent: false, reason: "no-lead" }).note).toContain("no-lead");
});

function pollDeps(
  opts: {
    requests?: DispatchRequest[];
    inFlight?: boolean;
    dispatch?: () => Promise<DispatchResult>;
    resolveThrows?: boolean;
  } = {}
) {
  const calls: string[] = [];
  const resolved: { id: string; outcome: DispatchRequestOutcome }[] = [];
  const reported: { message: string; error: unknown }[] = [];
  return {
    calls,
    resolved,
    reported,
    deps: {
      list: async () => {
        calls.push("list");
        return opts.requests ?? [];
      },
      inFlight: () => opts.inFlight ?? false,
      dispatch:
        opts.dispatch ??
        (async () => {
          calls.push("dispatch");
          return { sent: false, reason: "empty-queue" } as DispatchResult;
        }),
      resolve: async (id: string, outcome: DispatchRequestOutcome) => {
        calls.push(`resolve:${id}`);
        if (opts.resolveThrows) throw new Error("resolve exploded");
        resolved.push({ id, outcome });
      },
      reportError: (message: string, error: unknown) => reported.push({ message, error })
    }
  };
}

test("runDispatchRequestPoll: no pending request never triggers a dispatch nobody asked for", async () => {
  const { calls, deps } = pollDeps({ requests: [] });
  await runDispatchRequestPoll(deps);
  // The MECHANISM is the empty loop, not a length guard: an explicit
  // `requests.length === 0` early return was measured redundant (removing it
  // left this probe and every other one green), so it was deleted rather than
  // kept as a line nothing can falsify.
  expect(calls).toEqual(["list"]);
});

test("runDispatchRequestPoll: a dispatch already in flight PARKS the request -- nothing dispatched, nothing resolved", async () => {
  const { calls, resolved, deps } = pollDeps({ requests: [request("r1")], inFlight: true });
  await runDispatchRequestPoll(deps);
  // Not resolved is the whole point: the request survives to the next tick.
  // Resolving it here would consume it against a dispatch that never ran, and
  // queueing behind the in-flight run would answer about a dispatch this
  // requester did not cause (dispatchNext coalesces concurrent callers).
  expect(calls).toEqual(["list"]);
  expect(resolved).toEqual([]);
});

test("runDispatchRequestPoll: serves each pending request in order", async () => {
  const { calls, resolved, deps } = pollDeps({ requests: [request("r1"), request("r2")] });
  await runDispatchRequestPoll(deps);
  expect(calls).toEqual(["list", "dispatch", "resolve:r1", "dispatch", "resolve:r2"]);
  expect(resolved.map((r) => r.id)).toEqual(["r1", "r2"]);
});

test("runDispatchRequestPoll: a THROWING dispatch still answers, with a failure note", async () => {
  const { resolved, reported, deps } = pollDeps({
    requests: [request("r1")],
    dispatch: async () => {
      throw new Error("broker unreachable");
    }
  });
  await runDispatchRequestPoll(deps);
  // Silence is the one unacceptable outcome: the requester would time out at
  // 25 s and be told the request is still parked, which is a lie for an
  // exception the Deck swallowed.
  expect(resolved).toHaveLength(1);
  expect(resolved[0]!.outcome.cards).toEqual([]);
  expect(resolved[0]!.outcome.note).toContain("dispatch failed");
  expect(resolved[0]!.outcome.note).toContain("broker unreachable");
  expect(reported).toHaveLength(1);
  expect(reported[0]!.message).toContain("r1");
});

test("runDispatchRequestPoll: a throwing resolve is reported and does not silence the other requests", async () => {
  const { calls, reported, deps } = pollDeps({
    requests: [request("r1"), request("r2")],
    resolveThrows: true
  });
  await runDispatchRequestPoll(deps);
  expect(calls).toEqual(["list", "dispatch", "resolve:r1", "dispatch", "resolve:r2"]);
  expect(reported.map((r) => r.message)).toEqual([
    "dispatch request r1 could not be resolved",
    "dispatch request r2 could not be resolved"
  ]);
});

// SOURCE SCAN (weak, and labelled as such): the probes above prove the poll
// DECISION, nothing proves it is ever CALLED -- index.ts imports electron and
// cannot be imported under bun. A declared-but-unwired poller is the exact
// defect CLAUDE.md names.
//
// A FIRST version of this scan counted occurrences over the whole file and was
// measured fail-open FOUR ways by the reviewer, each mutation leaving it green:
// a wrong project key handed to fetchDispatchRequests (the poller would query
// another project), `dispatch: () => dispatchNext()` replaced by a stub (it
// would answer the agent without dispatching), BOTH call sites made dead code
// (`if (NEVER) void pollDispatchRequests()` -- the count stays 3, the substring
// stays present, the poller is never called again), and the result produced
// then discarded. What follows closes those four. It still cannot prove the
// values are right at runtime; the injected probes above are what does that.

/** index.ts with its comments removed -- see stripComments' own note. */
function indexSource(): string {
  return stripComments(
    readFileSync(join(import.meta.dir, "..", "desktop", "src", "main", "index.ts"), "utf-8")
  );
}

/**
 * Drops line and block comments so an anchor cannot be satisfied by a mention
 * in prose. Same hole as the i18n orphan guard: a scan that does not strip
 * comments accepts `// void pollDispatchRequests()` as wiring.
 *
 * Line comments are only stripped when the `//` is the first thing on the line
 * (after indentation), which leaves any `http://` or `://` inside a string
 * untouched -- a naive strip of every `//` would eat the middle of a URL and
 * silently change which slice the anchors below are matched against.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");
}

/** The body between two anchors, THROWING when either is missing. */
function sliceBetween(src: string, open: string, close: string): string {
  const after = src.split(open);
  // A missing anchor would otherwise yield undefined -> "" and every
  // `toContain` below would fail for the wrong reason, or worse, a `.length`
  // check would pass over an empty slice.
  if (after.length < 2) throw new Error(`anchor not found: ${open}`);
  const body = after[1]!.split(close);
  if (body.length < 2) throw new Error(`closing anchor not found: ${close}`);
  return body[0]!;
}

test("SOURCE SCAN (weak): the poller is called INSIDE the 10 s timer body, not merely mentioned", () => {
  const src = indexSource();
  // Bounded to the interval body: making both call sites dead code (wrapping
  // them in a never-taken branch) no longer satisfies this, and it covers the
  // cadence at the same time.
  const timerBody = sliceBetween(src, "inboxTimer = setInterval(", "}, INBOX_POLL_MS)");
  // A LINE-ONLY match, not a substring: `if (NEVER) void pollDispatchRequests()`
  // still CONTAINS the call while never running it, and that mutation was
  // measured green against a plain toContain. Requiring the call to be the
  // whole statement refuses it. This closes the measured instance, not the
  // class -- `void (cond && pollDispatchRequests())` would still pass, which is
  // the standing limit of any source scan.
  const callAlone = /^[ \t]*void pollDispatchRequests\(\)[ \t]*$/m;
  expect(timerBody).toMatch(callAlone);
  // Its four siblings share the tick: if the poller ever moves out of this
  // body, it must move somewhere as load-bearing.
  expect(timerBody).toContain("void pollOperatorInbox()");
  // The operator's manual retry path too, so a broker that came back up does
  // not wait a full tick. Same line-only discipline, same bounded slice.
  const retryBody = sliceBetween(src, "brokerRetry: () => {", "},");
  expect(retryBody).toMatch(callAlone);
});

test("SOURCE SCAN (weak): the poller's three deps are the REAL ones, not stubs", () => {
  const src = indexSource();
  // Each of these was a green mutation before: a wrong key queries another
  // project, a stubbed dispatch answers the agent without dispatching, a
  // stubbed resolve never answers at all.
  expect(src).toContain("list: () => fetchDispatchRequests(key, { endpoint })");
  expect(src).toContain("dispatch: () => dispatchNext()");
  expect(src).toContain("resolve: (id, outcome) => resolveDispatchRequest(id, outcome, { endpoint })");
  // The park branch reads the EXISTING guard rather than declaring a new one.
  expect(src).toContain("inFlight: () => dispatchInFlight !== null");
});

test("SOURCE SCAN (weak): DispatchResult.dispatched is produced AND reaches the result", () => {
  const src = indexSource();
  // Producer: fed from the same `dispatched` array that drives dispatchedIds,
  // so the outcome and the tracked set can never name different cards.
  expect(src).toContain(
    "announcedMembers.push(...dispatched.map((i) => ({ id: i.id, title: i.title, kind: i.kind })))"
  );
  // ...and CONSUMED: producing the array then dropping it on the floor was a
  // green mutation, because pinning the push alone says nothing about whether
  // its result ever reaches the returned DispatchResult.
  expect(src).toContain("dispatched: announcedMembers");
});
