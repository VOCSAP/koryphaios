// PLAN C15: queue → team-lead dispatch helpers (desktop/src/main/dispatch).

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  atomicOperationId,
  autoDispatchHold,
  canAutoDispatchNext,
  composeAssignText,
  composeDispatchOutcome,
  composeDispatchText,
  composeMultiDispatchText,
  composeStopText,
  createAssigner,
  createDispatcher,
  createDispatchRequestPoller,
  createFailureReporter,
  createUnconfirmedGate,
  dependencyHoldReason,
  dispatchNormalWave,
  dispatchTracked,
  dispatchWave,
  firstQueued,
  nextBarrierPending,
  nextDispatchedState,
  nextQueuePosition,
  NO_TARGET_REQUESTED_NOTE,
  queuedItems,
  resolveDependency,
  runAssign,
  runDirectiveWave,
  runDispatchRequestPoll,
  runStop,
  settleUnconfirmed,
  splitWave,
  UNRESOLVED_TARGET_NOTE,
  unresolvedDirectiveNote,
  type AssignDeps,
  type AtomicPort,
  type AtomicWaveDeps,
  type DispatcherDeps,
  type StopDeps
} from "../desktop/src/main/dispatch.ts";
import { fetchAtomicDispatchCapability } from "../desktop/src/main/broker-client.ts";
import { findMatchingClose } from "./_braced-body.ts";
import {
  assignInProgress,
  markDirectiveDone,
  requestOperatorStop,
  unqueueDispatched,
  type GuardedWriteIo
} from "../desktop/src/main/roadmap-guarded-write.ts";
import { RoadmapRequestError } from "../desktop/src/main/roadmap-service.ts";
import { formatRoadmapStaleSaveError } from "../shared/roadmap-append.ts";
import type {
  DirectiveDispatch,
  DispatchResult,
  RoadmapItem,
  RoadmapUpsertFields
} from "../desktop/src/shared/types";
// The dispatch-request shapes are the BROKER's, declared once at the repo root
// and imported by the three main-process consumers -- not mirrored Deck-side.
// This test must read them from the same place they do, or it would pin a copy
// nobody uses.
import type {
  AtomicDispatchDelivery,
  AtomicDispatchIntent,
  AtomicDispatchRefusal,
  DispatchRequest,
  DispatchRequestOutcome
} from "../shared/types";

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
  expect(composeStopText(it, true)).toContain("(notify_operator)");
  expect(composeStopText(it, true)).not.toContain('send_message to "operator"');
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

test("canAutoDispatchNext: a dependency missing from the roadmap holds the queue", () => {
  const items = [item({ id: "a", queue: 1, depends_on: ["3f9a1c2e"] })];
  expect(canAutoDispatchNext(items, new Set())).toBe(false);
  expect(autoDispatchHold(items, new Set())).toEqual({ kind: "dependency", head: items[0]!, unknown: ["3f9a1c2e"], pending: [] });
});

const DEP_ID = "3f9a1c2e-1111-4000-8000-000000000001";

test("canAutoDispatchNext: an id8 dependency resolves to the card it prefixes", () => {
  const head = item({ id: "a", queue: 1, depends_on: ["3f9a1c2e"] });
  expect(canAutoDispatchNext([item({ id: DEP_ID, status: "done" }), head], new Set())).toBe(true);
  expect(canAutoDispatchNext([item({ id: DEP_ID, status: "archived" }), head], new Set())).toBe(true);
  const unfinished = item({ id: DEP_ID, status: "in_progress" });
  expect(autoDispatchHold([unfinished, head], new Set())).toEqual({ kind: "dependency", head, unknown: [], pending: [unfinished] });
});

test("canAutoDispatchNext: an ambiguous, short or non-hex prefix holds the queue", () => {
  const twins = [
    item({ id: "3f9a1c2e-1111-4000-8000-000000000001", status: "done" }),
    item({ id: "3f9a1c2e-2222-4000-8000-000000000002", status: "done" })
  ];
  for (const dep of ["3f9a1c2e", "3f9a1c2", "3f9a1c2g", "-3f9a1c2e"]) {
    const head = item({ id: "a", queue: 1, depends_on: [dep] });
    const items = dep === "3f9a1c2e" ? [...twins, head] : [twins[0]!, head];
    expect(autoDispatchHold(items, new Set()), dep).toEqual({ kind: "dependency", head, unknown: [dep], pending: [] });
  }
});

test("resolveDependency: an upper-case id8, an upper-case full id and a dashed prefix resolve", () => {
  const dep = item({ id: DEP_ID, status: "done" });
  for (const entry of ["3F9A1C2E", DEP_ID.toUpperCase(), "3f9a1c2e-1111"]) {
    expect(resolveDependency([dep], entry), entry).toBe(dep);
  }
});

/**
 * matchDependency cut verbatim out of broker.ts (which starts its server at
 * module load, so it cannot be imported) together with the prefix constant it
 * reads, then evaluated alone.
 */
function brokerMatchDependency(): (entry: string, ids: readonly string[]) => { id: string } | { unknown: true } | { ambiguous: number } {
  const src = readFileSync(join(import.meta.dir, "..", "broker.ts"), "utf-8").replace(/\r\n/g, "\n");
  const start = src.indexOf("const DEPENDS_ON_PREFIX = ");
  const fnStart = src.indexOf("function matchDependency(", start);
  const end = src.indexOf("\n}\n", fnStart);
  if (start < 0 || fnStart < 0 || end < 0) throw new Error("matchDependency not found in broker.ts");
  const js = new Bun.Transpiler({ loader: "ts" }).transformSync(`${src.slice(start, end + 2)}\nexport { matchDependency }`);
  return new Function(`${js.replace(/export\s*\{[^}]*\};?/, "")}\nreturn matchDependency`)();
}

test("resolveDependency and the broker's matchDependency give the same verdict on every entry shape", () => {
  const matchDependency = brokerMatchDependency();
  const ids = [
    "3f9a1c2e-1111-4000-8000-000000000001",
    "7b2c0d4e-1111-4000-8000-000000000001",
    "7b2c0d4e-2222-4000-8000-000000000002",
    "imported-card-alpha"
  ];
  const items = ids.map((id) => item({ id }));
  const table = [
    "3f9a1c2e",
    "3F9A1C2E",
    "3F9A1C2E-1111-4000-8000-000000000001",
    "3f9a1c2e-1111",
    "3f9a1c2",
    "7b2c0d4e",
    "IMPORTED-CARD-ALPHA",
    "deadbeef",
    "not-a-card"
  ];
  for (const entry of table) {
    const broker = matchDependency(entry, ids);
    const deck = resolveDependency(items, entry);
    expect(deck?.id ?? null, entry).toBe("id" in broker ? broker.id : null);
  }
  // The table must exercise both verdicts, or the loop proves nothing.
  expect(table.filter((e) => "id" in matchDependency(e, ids)).length).toBe(5);
});

test("resolveDependency: an exact id wins over a longer id it prefixes", () => {
  const exact = item({ id: "3f9a1c2e", status: "done" });
  const longer = item({ id: DEP_ID, status: "planned" });
  expect(resolveDependency([longer, exact], "3f9a1c2e")).toBe(exact);
});

test("canAutoDispatchNext: one done and one unknown dependency still hold the queue", () => {
  const head = item({ id: "a", queue: 1, depends_on: [DEP_ID, "deadbeef"] });
  const hold = autoDispatchHold([item({ id: DEP_ID, status: "done" }), head], new Set());
  expect(hold).toEqual({ kind: "dependency", head, unknown: ["deadbeef"], pending: [] });
});

test("dependencyHoldReason: names the head, every unknown id and every pending dependency by title", () => {
  const head = item({ id: "a", title: "Head card", queue: 1 });
  const pendingA = item({ id: "p1", title: "First prerequisite" });
  const pendingB = item({ id: "p2", title: "Second prerequisite" });

  const unknownOnly = dependencyHoldReason({ kind: "dependency", head, unknown: ["deadbeef", "3f9a1c2"], pending: [] });
  expect(unknownOnly).toContain('"Head card"');
  expect(unknownOnly).toContain("depends on an id that matches no card: deadbeef, 3f9a1c2");
  expect(unknownOnly).toContain("fix the card's depends_on");
  expect(unknownOnly).not.toContain("prerequisite");

  const pendingOnly = dependencyHoldReason({ kind: "dependency", head, unknown: [], pending: [pendingA, pendingB] });
  expect(pendingOnly).toContain('"Head card"');
  expect(pendingOnly).toContain('"First prerequisite", "Second prerequisite"');
  expect(pendingOnly).not.toContain("matches no card");

  const both = dependencyHoldReason({ kind: "dependency", head, unknown: ["deadbeef"], pending: [pendingA] });
  expect(both).toContain("matches no card: deadbeef");
  expect(both).toContain('"First prerequisite"');
  expect(both).toContain('"send first to team-lead"');
});

test("autoDispatchHold: names an in-flight wave and an empty queue", () => {
  expect(autoDispatchHold([item({ id: "a", queue: 1 })], new Set(["x"]))).toEqual({ kind: "in-flight" });
  expect(autoDispatchHold([item({ id: "a" })], new Set())).toEqual({ kind: "empty" });
});

// watchDispatched's removal paths cover done, archived and absent states;
// without a path for a claimed item reverting to planned (an operator stop, or
// an idle-lock release), dispatchedIds would never clear and the wave barrier
// would stay permanently closed.
// Sense A guards against the naive fix of deleting on planned+unlocked: a
// freshly dispatched item is planned and unlocked too, before it is ever
// claimed.

test("nextDispatchedState: sense A -- a freshly dispatched item (never claimed) stays tracked", () => {
  const it = item({ status: "planned", locked: false });
  expect(nextDispatchedState({ claimed: false }, it)).toEqual({ kind: "keep" });
});

test("nextDispatchedState: claims when the lead locks it in_progress", () => {
  const it = item({ status: "in_progress", locked: true });
  expect(nextDispatchedState({ claimed: false }, it)).toEqual({ kind: "claim" });
});

// Claim must not require `locked`: broker.ts only grants the work-lock to a
// non-'deck' author, so a Deck-authored in_progress write (author='deck')
// leaves locked=false and would otherwise never claim, reproducing the
// barrier-stuck-forever bug.
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

/** A report shaped like executeDirective's, with nothing resolved by default. */
function report(over: Partial<DirectiveDispatch> = {}): DirectiveDispatch {
  return {
    id: over.id ?? "a",
    title: over.title ?? "t",
    directive: over.directive ?? "clear",
    injected: over.injected ?? [],
    unreached: over.unreached ?? [],
    refused: over.refused,
    pending: over.pending
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
  const notedReports: DirectiveDispatch[] = [];
  return {
    order,
    journaled,
    reported,
    noted,
    notedReports,
    deps: {
      markDone: async (it: RoadmapItem): Promise<void | "skipped"> => {
        order.push(`mark:${it.id}`);
      },
      execute: async (it: RoadmapItem): Promise<DirectiveDispatch> => {
        order.push(`execute:${it.id}`);
        if (opts.throwForIds?.has(it.id)) throw new Error(`inject failed for ${it.id}`);
        return opts.reports?.[it.id] ?? report({ id: it.id, title: it.title });
      },
      journal: (line: string) => journaled.push(line),
      reportError: (message: string, error: unknown) => reported.push({ message, error }),
      noteUnresolved: async (it: RoadmapItem, rep: DirectiveDispatch) => {
        order.push(`note:${it.id}`);
        if (opts.noteThrowsForIds?.has(it.id)) throw new Error(`note failed for ${it.id}`);
        noted.push(it.id);
        notedReports.push(rep);
      }
    }
  };
}

test("runDirectiveWave: marks done BEFORE executing (mark-then-execute, not the reverse)", async () => {
  const { order, deps } = mockDirectiveDeps();
  await runDirectiveWave([item({ id: "a", kind: "directive", directive: "clear" })], deps);
  expect(order).toEqual(["mark:a", "execute:a", "note:a"]);
});

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

// These probes are behavioral: they drive the real runDirectiveWave and read
// its actual return value, carrying both resolved and unresolved targets
// distinctly rather than journaling then discarding them.
// Only the executor's own wiring, in a module that imports electron and cannot
// run under bun test, is left to a source scan elsewhere.

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

test("runDirectiveWave: posts the unresolved note when zero targets are resolved (directive stays non-null)", async () => {
  const { noted, order, deps } = mockDirectiveDeps({
    reports: { a: report({ id: "a", directive: "clear", injected: [], unreached: [{ peerId: "gone", reason: "no-live-target" }] }) }
  });
  await runDirectiveWave([item({ id: "a", kind: "directive", directive: "clear" })], deps);
  expect(noted).toEqual(["a"]);
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

test("runDirectiveWave: does NOT post the note while an unwritten target is pending", async () => {
  const pendingReport = report({
    id: "a",
    directive: "clear",
    injected: [],
    pending: [{ tileId: "t1", peerId: "peer-a" }]
  });
  const { noted, order, deps } = mockDirectiveDeps({ reports: { a: pendingReport } });

  const out = await runDirectiveWave([item({ id: "a", kind: "directive", directive: "clear" })], deps);

  expect(noted).toEqual([]);
  expect(order).toEqual(["mark:a", "execute:a"]);
  expect(out).toEqual([pendingReport]);
});

test("runDirectiveWave: posts the unresolved note when every attempted target refuses", async () => {
  const { noted, deps } = mockDirectiveDeps({
    reports: {
      a: report({
        id: "a",
        directive: "clear",
        injected: [],
        refused: [{ tileId: "t1", peerId: "peer-a", reason: "refused-modal" }],
        pending: []
      })
    }
  });

  await runDirectiveWave([item({ id: "a", kind: "directive", directive: "clear" })], deps);

  expect(noted).toEqual(["a"]);
});

test("runDirectiveWave: does NOT post the note on the parse-refusal report (directive: null)", async () => {
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
  expect(noted).toEqual([]);
  expect(out).toEqual([unresolvedReport]);
  expect(reported).toHaveLength(1);
  expect(reported[0]!.message).toContain("unresolved-target note");
  expect(reported[0]!.error).toBeInstanceOf(Error);
});

test("runDirectiveWave: hands noteUnresolved the report that settled, so the note can name the refusals", async () => {
  const refused = [{ tileId: "t1", peerId: "peer-a", reason: "rate-limited" as const }];
  const refusedReport = report({ id: "a", directive: "clear", injected: [], refused });
  const { notedReports, deps } = mockDirectiveDeps({ reports: { a: refusedReport } });

  await runDirectiveWave([item({ id: "a", kind: "directive", directive: "clear" })], deps);

  expect(notedReports).toEqual([refusedReport]);
});

test("unresolvedDirectiveNote: empty target_peer_ids gets the 'set targets first' note, not the re-queue one", () => {
  expect(unresolvedDirectiveNote(item({ target_peer_ids: [] }), report({ id: "a", directive: "clear" }))).toBe(
    NO_TARGET_REQUESTED_NOTE
  );
});

test("unresolvedDirectiveNote: a requested-but-unreachable target gets the re-queue note", () => {
  expect(unresolvedDirectiveNote(item({ target_peer_ids: ["peer-a"] }), report({ id: "a", directive: "clear" }))).toBe(
    UNRESOLVED_TARGET_NOTE
  );
});

test("unresolvedDirectiveNote: targets that were live and refused get a note naming each peer and its reason, not 'no live target resolved'", () => {
  const note = unresolvedDirectiveNote(
    item({ target_peer_ids: ["peer-a", "peer-b"] }),
    report({
      id: "a",
      directive: "clear",
      refused: [
        { tileId: "t1", peerId: "peer-a", reason: "needs-attention" },
        { tileId: "t2", peerId: "peer-b", reason: "rate-limited" }
      ]
    })
  );
  expect(note).toContain("peer-a (needs-attention)");
  expect(note).toContain("peer-b (rate-limited)");
  expect(note).not.toContain("no live target resolved");
});

test("unresolvedDirectiveNote: an empty refused list is the unreachable case, not a refusal", () => {
  expect(
    unresolvedDirectiveNote(item({ target_peer_ids: ["peer-a"] }), report({ id: "a", directive: "clear", refused: [] }))
  ).toBe(UNRESOLVED_TARGET_NOTE);
});

function mockDeps(opts: { announceReturns?: number; failIds?: Set<string> } = {}) {
  const announced: string[] = [];
  const upserted: string[] = [];
  const warned: string[] = [];
  return {
    announced,
    upserted,
    warned,
    deps: {
      warn: (line: string) => warned.push(line),
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

test("composeDispatchOutcome: refused and pending targets are separate from matched", () => {
  const out = composeDispatchOutcome({
    sent: true,
    count: 1,
    titles: ["Clear the team"],
    directives: [
      {
        id: "d1",
        title: "Clear the team",
        directive: "clear",
        injected: [{ tileId: "t-written", peerId: "written" }],
        refused: [{ tileId: "t-refused", peerId: "refused", reason: "refused-modal" }],
        pending: [{ tileId: "t-pending", peerId: "pending" }],
        unreached: []
      }
    ]
  });

  expect(out.cards).toEqual([
    {
      id: "d1",
      title: "Clear the team",
      kind: "directive",
      matched: ["written"],
      missing: [],
      ambiguous: [],
      refused: [{ peerId: "refused", reason: "refused-modal" }],
      pending: ["pending"]
    }
  ]);
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

// Weak: proves the poll decision, not that it is ever called -- index.ts
// imports electron and cannot be imported under bun.
// A first version counted occurrences over the whole file and stayed green
// under four mutations: a wrong project key, a stubbed dispatch call, both call
// sites made dead code, and a discarded result. The refined scan closes those
// four but still cannot prove the values are right at runtime.

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
  // Bounded to the interval body specifically: wrapping both call sites in a
  // never-taken branch would not satisfy this check, and it pins the polling
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
  expect(src).toContain("inFlight: dispatcher.inFlight");
});

type RetryRun = { barrierPending: boolean; dispatched: number; lines: string[]; allLines: string[] };

/**
 * Executes the REAL body of watchDispatched (index.ts, not importable under
 * bun) from its roadmap fetch on, with the real dispatch.ts helpers, a
 * recording dispatchNext / journal, and a list that hides archived cards
 * unless asked for them, as the broker does. Only the names passed below are
 * in scope: a body that goes back to a helper not listed here throws a
 * ReferenceError instead of passing.
 * One tracked item finishing on this tick is what makes the barrier re-check
 * the head, so every run starts from that state.
 */
async function runWatchRetry(
  roadmap: RoadmapItem[],
  result: DispatchResult = { sent: true, title: "dispatched", dispatched: [{ id: "w", title: "dispatched", kind: "feature" }] }
): Promise<RetryRun> {
  const watch = sliceBetween(indexSource(), "const watchDispatched = async (): Promise<void> => {", "\n}");
  const start = watch.indexOf("const items = await listRoadmap(");
  const end = watch.lastIndexOf("} catch (e) {");
  if (start < 0 || end < start) throw new Error("watchDispatched body not found");
  const fn = `async function watchBody(endpoint, key, listRoadmap, dispatchedIds, barrierPending, nextDispatchedState, autoDispatchHold, dependencyHoldReason, nextBarrierPending, firstQueued, dispatchTracked, dispatchNext, journal, dispatchWatchFailures) {\n${watch.slice(start, end)}\nreturn barrierPending\n}`;
  const js = new Bun.Transpiler({ loader: "ts" }).transformSync(fn);
  const watchBody = new Function(`${js}\nreturn watchBody`)();
  const finished = item({ id: "finished-wave-member", status: "done" });
  const run: RetryRun = { barrierPending: false, dispatched: 0, lines: [], allLines: [] };
  const listRoadmap = async (_endpoint: string, _key: string, opts: { include_archived?: boolean }) =>
    [finished, ...roadmap].filter((i) => opts.include_archived || i.status !== "archived");
  const dispatchNext = async (): Promise<DispatchResult> => {
    run.dispatched++;
    return result;
  };
  const journal = { add: (_channel: string, line: string) => run.lines.push(line) };
  run.barrierPending = await watchBody(
    "endpoint", "key", listRoadmap, new Map([[finished.id, { claimed: true }]]), false,
    nextDispatchedState, autoDispatchHold, dependencyHoldReason, nextBarrierPending, firstQueued, dispatchTracked, dispatchNext, journal, createFailureReporter(() => undefined)
  );
  run.allLines = run.lines;
  run.lines = run.lines.filter((l) => l.startsWith("wave barrier"));
  return run;
}

test("watchDispatched: an unknown dependency holds the head and the journal names it", async () => {
  const head = item({ id: "a", title: "Blocked head", queue: 1, depends_on: ["deadbeef"] });
  const run = await runWatchRetry([head]);
  expect(run.dispatched).toBe(0);
  expect(run.barrierPending).toBe(true);
  expect(run.lines).toHaveLength(1);
  expect(run.lines[0]).toContain('"Blocked head"');
  expect(run.lines[0]).toContain("depends on an id that matches no card: deadbeef");
});

test("watchDispatched: an unfinished dependency holds the head and the journal names it by title", async () => {
  const dep = item({ id: DEP_ID, title: "Still running prerequisite", status: "in_progress" });
  const head = item({ id: "a", title: "Waiting head", queue: 1, depends_on: ["3f9a1c2e"] });
  const run = await runWatchRetry([dep, head]);
  expect(run.dispatched).toBe(0);
  expect(run.lines).toHaveLength(1);
  expect(run.lines[0]).toContain('"Still running prerequisite"');
  expect(run.lines[0]).not.toContain("matches no card");
});

test("watchDispatched: a dependency on an archived card lets the head dispatch", async () => {
  const dep = item({ id: DEP_ID, status: "archived" });
  const head = item({ id: "a", queue: 1, depends_on: [DEP_ID] });
  const run = await runWatchRetry([dep, head]);
  expect(run.dispatched).toBe(1);
  expect(run.barrierPending).toBe(false);
});

function wavePool(cards: RoadmapItem[]) {
  const live = new Map(cards.map((c) => [c.id, { ...c, content_rev: 1 }]));
  const writes: RoadmapUpsertFields[] = [];
  const io: GuardedWriteIo = {
    read: async (id) => live.get(id) ?? null,
    write: async (fields) => {
      writes.push(fields);
      const cur = live.get(fields.id!)!;
      if (fields.expected_content_rev !== undefined && fields.expected_content_rev !== cur.content_rev) {
        throw new RoadmapRequestError(formatRoadmapStaleSaveError("the card changed"), 409, "/roadmap/upsert");
      }
      const { id: _id, expected_content_rev: _token, ...rest } = fields;
      const next = { ...cur, ...(rest as Partial<RoadmapItem>), content_rev: cur.content_rev! + 1 };
      live.set(cur.id, next);
      return next;
    },
    trace: () => {}
  };
  const edit = (id: string, patch: Partial<RoadmapItem>) =>
    live.set(id, { ...live.get(id)!, ...patch, content_rev: live.get(id)!.content_rev! + 1 });
  const snapshot = (id: string): RoadmapItem => ({ ...live.get(id)! });
  return { live, writes, io, edit, snapshot };
}

test("dispatchNormalWave: a member closed during the announce keeps its state; the wave is still sent and names the skipped card", async () => {
  for (const closed of ["done", "archived"] as const) {
    const pool = wavePool([item({ id: "a", title: "A", status: "idea", queue: 1 })]);
    const snap = pool.snapshot("a");
    const warned: string[] = [];
    let announces = 0;
    const out = await dispatchNormalWave([snap], {
      announce: async () => {
        announces++;
        pool.edit("a", { status: closed });
        return 1;
      },
      upsert: async (it) => ((await unqueueDispatched(it, pool.io)).written ? undefined : "skipped"),
      warn: (line) => warned.push(line)
    });
    expect(announces).toBe(1);
    expect(pool.live.get("a")!.status).toBe(closed);
    expect(pool.writes).toHaveLength(1);
    expect(out.dispatched).toEqual([]);
    expect(out.failed).toEqual([]);
    expect(out.skipped.map((i) => i.id)).toEqual(["a"]);
    expect(out.result).toEqual({ sent: true, skipped: [{ id: "a", title: "A", kind: "feature" }] });
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('"A"');
  }
});

test("dispatchNormalWave: a member edited during the announce is still unqueued after the re-read, a closed sibling is skipped and warned", async () => {
  const pool = wavePool([
    item({ id: "a", title: "A", status: "idea", queue: 1 }),
    item({ id: "b", title: "B", status: "planned", queue: 1 }),
    item({ id: "c", title: "C", status: "planned", queue: 1 })
  ]);
  const wave = ["a", "b", "c"].map((id) => pool.snapshot(id));
  const warned: string[] = [];
  const out = await dispatchNormalWave(wave, {
    announce: async () => {
      pool.edit("a", { title: "A renamed" });
      pool.edit("b", { status: "done" });
      return 1;
    },
    upsert: async (it) => ((await unqueueDispatched(it, pool.io)).written ? undefined : "skipped"),
    warn: (line) => warned.push(line)
  });
  expect(out.dispatched.map((i) => i.id)).toEqual(["a", "c"]);
  expect(out.skipped.map((i) => i.id)).toEqual(["b"]);
  expect(out.result).toEqual({
    sent: true,
    count: 2,
    titles: ["A", "C"],
    skipped: [{ id: "b", title: "B", kind: "feature" }]
  });
  expect(warned).toHaveLength(1);
  expect(pool.live.get("a")).toMatchObject({ title: "A renamed", status: "planned", queue: null });
  expect(pool.live.get("b")!.status).toBe("done");
});

test("dispatchTracked: only a wave that left a tracked member counts as in flight", () => {
  const member = { id: "a", title: "A", kind: "feature" };
  expect(dispatchTracked({ sent: true, title: "A", dispatched: [member] })).toBe(true);
  expect(dispatchTracked({ sent: true, skipped: [member] })).toBe(false);
  expect(dispatchTracked({ sent: false, reason: "no-lead" })).toBe(false);
});

test("composeDispatchOutcome: a wave whose cards all closed is not reported as nothing eligible", () => {
  const outcome = composeDispatchOutcome({ sent: true, skipped: [{ id: "a", title: "A", kind: "feature" }] });
  expect(outcome.cards).toEqual([]);
  expect(outcome.note).toContain("closed before they were unqueued");
  expect(outcome.note).not.toContain("nothing eligible");
});

test("runDirectiveWave: a directive closed since it was read is not executed and not reported as an error", async () => {
  const pool = wavePool([item({ id: "d", kind: "directive", directive: "clear", status: "planned", queue: 1 })]);
  const snap = pool.snapshot("d");
  pool.edit("d", { status: "done" });
  const { order, reported, deps } = mockDirectiveDeps();
  deps.markDone = async (it: RoadmapItem) => ((await markDirectiveDone(it, pool.io)).written ? undefined : "skipped");
  const executed = await runDirectiveWave([snap], deps);
  expect(order).toEqual([]);
  expect(executed).toEqual([]);
  expect(reported).toEqual([]);
  expect(pool.live.get("d")).toMatchObject({ status: "done" });
  expect(pool.writes).toHaveLength(1);
});

test("runDirectiveWave: a directive edited since it was read is marked done with the fresh token, then executed", async () => {
  const pool = wavePool([item({ id: "d", kind: "directive", directive: "clear", status: "planned", queue: 1 })]);
  const snap = pool.snapshot("d");
  pool.edit("d", { title: "renamed" });
  const { order, deps } = mockDirectiveDeps();
  deps.markDone = async (it: RoadmapItem) => ((await markDirectiveDone(it, pool.io)).written ? undefined : "skipped");
  await runDirectiveWave([snap], deps);
  expect(order[0]).toBe("execute:d");
  expect(pool.writes.map((w) => w.expected_content_rev)).toEqual([1, 2]);
  expect(pool.live.get("d")).toMatchObject({ status: "done", queue: null });
});

test("runDirectiveWave: a skipped directive does not stop its siblings", async () => {
  const { order, deps } = mockDirectiveDeps();
  deps.markDone = async (it: RoadmapItem) => (it.id === "a" ? "skipped" : undefined);
  await runDirectiveWave(
    [item({ id: "a", kind: "directive", directive: "clear" }), item({ id: "b", kind: "directive", directive: "compact" })],
    deps
  );
  expect(order.filter((o) => o.startsWith("execute:"))).toEqual(["execute:b"]);
});

function assignHarness(pool: ReturnType<typeof wavePool>, over: Partial<AssignDeps> = {}) {
  const log = { announced: [] as string[], journaled: [] as string[], warned: [] as string[], errors: [] as unknown[] };
  const deps: AssignDeps = {
    read: async (id) => (pool.live.has(id) ? pool.snapshot(id) : null),
    announce: async (_item, target) => {
      log.announced.push(target);
      return 1;
    },
    write: (it) => assignInProgress(it, pool.io),
    journal: (line) => log.journaled.push(line),
    warn: (line) => log.warned.push(line),
    reportError: (_message, error) => log.errors.push(error),
    ...over
  };
  return { deps, log };
}

test("runAssign: a card closed after the read is announced, then reported sent with the write skipped and a warning", async () => {
  const pool = wavePool([item({ id: "a", title: "A", status: "planned", queue: 1 })]);
  const { deps, log } = assignHarness(pool, {
    announce: async () => {
      pool.edit("a", { status: "done" });
      return 1;
    }
  });
  const result = await runAssign("a", " peer-1 ", deps);
  expect(result).toEqual({ sent: true, writeSkipped: true });
  expect(log.warned).toHaveLength(1);
  expect(log.warned[0]).toContain('"A"');
  expect(log.journaled).toEqual([]);
  expect(pool.live.get("a")!.status).toBe("done");
});

test("runAssign: an announce that reaches no peer writes nothing and warns nothing", async () => {
  const pool = wavePool([item({ id: "a", status: "planned", queue: 1 })]);
  const { deps, log } = assignHarness(pool, { announce: async () => 0 });
  expect(await runAssign("a", "peer-1", deps)).toEqual({ sent: false });
  expect(pool.writes).toEqual([]);
  expect(log.warned).toEqual([]);
});

test("runAssign: a written assignment is journaled and carries no skip flag", async () => {
  const pool = wavePool([item({ id: "a", title: "A", status: "planned", queue: 1 })]);
  const { deps, log } = assignHarness(pool);
  expect(await runAssign("a", "peer-1", deps)).toEqual({ sent: true });
  expect(log.announced).toEqual(["peer-1"]);
  expect(log.journaled).toHaveLength(1);
  expect(pool.live.get("a")).toMatchObject({ status: "in_progress", queue: null });
});

test("runAssign: a blank peer or an unknown card announces nothing; a throwing write is reported and answers sent:false", async () => {
  const pool = wavePool([item({ id: "a", status: "planned", queue: 1 })]);
  const blank = assignHarness(pool);
  expect(await runAssign("a", "   ", blank.deps)).toEqual({ sent: false });
  expect(await runAssign("missing", "peer-1", blank.deps)).toEqual({ sent: false });
  expect(blank.log.announced).toEqual([]);

  const boom = new Error("write failed");
  const failing = assignHarness(pool, {
    write: async () => {
      throw boom;
    }
  });
  expect(await runAssign("a", "peer-1", failing.deps)).toEqual({ sent: false });
  expect(failing.log.errors).toEqual([boom]);
});

function stopHarness(pool: ReturnType<typeof wavePool>, over: Partial<StopDeps> = {}) {
  const log = { order: [] as string[], journaled: [] as string[], errors: [] as unknown[] };
  const deps: StopDeps = {
    read: async (id) => (pool.live.has(id) ? pool.snapshot(id) : null),
    write: async (it) => {
      log.order.push("write");
      return requestOperatorStop(it, pool.io);
    },
    notify: async () => {
      log.order.push("notify");
      return "supervisor";
    },
    journal: (line) => log.journaled.push(line),
    reportError: (_message, error) => log.errors.push(error),
    ...over
  };
  return { deps, log };
}

const runningCard = () => item({ id: "a", title: "A", status: "in_progress", locked: true, locked_by: "p1", queue: null });

test("runStop: the guarded write comes before the notice, and a written stop reports how the notice went out", async () => {
  const pool = wavePool([runningCard()]);
  const { deps, log } = stopHarness(pool);
  expect(await runStop("a", deps)).toEqual({ stopped: true, via: "supervisor" });
  expect(log.order).toEqual(["write", "notify"]);
  expect(pool.live.get("a")).toMatchObject({ status: "planned", locked: false });
  expect(log.journaled).toHaveLength(1);
});

test("runStop: a card that changed between the read and the write sends no notice", async () => {
  const pool = wavePool([runningCard()]);
  const { deps, log } = stopHarness(pool, {
    read: async (id) => {
      const seen = pool.snapshot(id);
      pool.edit(id, { status: "done" });
      return seen;
    }
  });
  expect(await runStop("a", deps)).toEqual({ stopped: false, via: "none", reason: "card-changed" });
  expect(log.order).toEqual(["write"]);
  expect(log.journaled).toEqual([]);
  expect(pool.live.get("a")!.status).toBe("done");
});

test("runStop: a notice that fails after the write still answers stopped:true via none and is reported", async () => {
  const pool = wavePool([runningCard()]);
  const down = new Error("broker unreachable");
  const { deps, log } = stopHarness(pool, {
    notify: async () => {
      throw down;
    }
  });
  expect(await runStop("a", deps)).toEqual({ stopped: true, via: "none" });
  expect(log.errors).toEqual([down]);
  expect(pool.live.get("a")!.status).toBe("planned");
});

test("runStop: a write that throws is reported once and rethrown unchanged, with no notice", async () => {
  const pool = wavePool([runningCard()]);
  const stale = new RoadmapRequestError(formatRoadmapStaleSaveError("the card changed"), 409, "/roadmap/upsert");
  const { deps, log } = stopHarness(pool, {
    write: async () => {
      throw stale;
    }
  });
  await expect(runStop("a", deps)).rejects.toBe(stale);
  expect(log.errors).toEqual([stale]);
  expect(log.order).toEqual([]);
});

test("runStop: an unknown card answers not-found without writing or notifying", async () => {
  const pool = wavePool([runningCard()]);
  const { deps, log } = stopHarness(pool);
  expect(await runStop("missing", deps)).toEqual({ stopped: false, via: "none", reason: "not-found" });
  expect(log.order).toEqual([]);
  expect(pool.writes).toEqual([]);
});

test("watchDispatched: a dispatched wave whose cards all closed is not tracked, so the barrier re-arms instead of stalling", async () => {
  const head = item({ id: "a", title: "Next head", queue: 1 });
  const run = await runWatchRetry([head], { sent: true, skipped: [{ id: "x", title: "X", kind: "feature" }] });
  expect(run.dispatched).toBe(1);
  expect(run.barrierPending).toBe(true);
  expect(run.allLines.some((l) => l.startsWith("auto-dispatched"))).toBe(false);
  expect(run.lines.join("\n")).toContain("every announced card closed meanwhile");
});

test("runStop: the notice and the journal carry the title of the card that was written, not the one first read", async () => {
  const pool = wavePool([runningCard()]);
  const notified: string[] = [];
  const { deps, log } = stopHarness(pool, {
    read: async (id) => {
      const seen = pool.snapshot(id);
      pool.edit(id, { title: "A renamed" });
      return seen;
    },
    notify: async (it) => {
      notified.push(it.title);
      return "broadcast";
    }
  });
  expect(await runStop("a", deps)).toEqual({ stopped: true, via: "broadcast" });
  expect(pool.writes.map((w) => w.expected_content_rev)).toEqual([1, 2]);
  expect(notified).toEqual(["A renamed"]);
  expect(log.journaled[0]).toContain("A renamed");
});

async function runWatchTicks(outcomes: (Error | null)[], dispatchFailure: Error | null = null): Promise<string[]> {
  const watch = sliceBetween(indexSource(), "const watchDispatched = async (): Promise<void> => {", "\n}");
  const start = watch.indexOf("const items = await listRoadmap(");
  if (start < 0) throw new Error("watchDispatched body not found");
  const fn = `async function tick(endpoint, key, listRoadmap, dispatchedIds, barrierPending, nextDispatchedState, autoDispatchHold, dependencyHoldReason, nextBarrierPending, firstQueued, dispatchTracked, dispatchNext, journal, dispatchWatchFailures) {\ntry {\n${watch.slice(start)}\n}`;
  const js = new Bun.Transpiler({ loader: "ts" }).transformSync(fn);
  const tick = new Function(`${js}\nreturn tick`)();
  const reports: string[] = [];
  const failures = createFailureReporter((error) => reports.push((error as Error).message));
  const pending = [...outcomes];
  const listRoadmap = async () => {
    const next = pending.shift();
    if (next) throw next;
    return dispatchFailure ? [item({ id: "h", queue: 1 })] : [];
  };
  for (let i = 0; i < outcomes.length; i++) {
    await tick(
      "endpoint", "key", listRoadmap, new Map(), dispatchFailure !== null,
      nextDispatchedState, autoDispatchHold, dependencyHoldReason, nextBarrierPending, firstQueued,
      dispatchTracked,
      async () => {
        if (dispatchFailure) throw dispatchFailure;
        return { sent: false };
      },
      { add: () => undefined }, failures
    );
  }
  return reports;
}

test("watchDispatched: the same failure on consecutive ticks is traced once", async () => {
  expect(await runWatchTicks([new Error("broker down"), new Error("broker down"), new Error("broker down")])).toEqual([
    "broker down"
  ]);
});

test("watchDispatched: a different failure, or the same one after a successful tick, is traced again", async () => {
  expect(await runWatchTicks([new Error("a"), new Error("b")])).toEqual(["a", "b"]);
  expect(await runWatchTicks([new Error("down"), null, new Error("down")])).toEqual(["down", "down"]);
});

test("watchDispatched: a tick that fails after the roadmap read does not reset the failure memory", async () => {
  expect(await runWatchTicks([null, null], new Error("dispatch exploded"))).toEqual(["dispatch exploded"]);
});

const BROKER_ID = "11111111-aaaa-bbbb-cccc-222222222222";
const CAPABILITY = { version: 1 as const, broker_id: BROKER_ID, max_operation_ms: 600_000, max_members: 50, registry_capacity: 2000 };
const TAG = "a".repeat(64);

function tokened(over: Partial<RoadmapItem>): RoadmapItem {
  return item({ content_rev: 3, dispatch_state_tag: TAG, queue: 1, ...over });
}

type Answer = (action: "execute" | "resolve", intent: AtomicDispatchIntent) => AtomicDispatchDelivery;

function sentOf(intent: AtomicDispatchIntent, ids?: string[]): AtomicDispatchDelivery {
  const members = intent.members.filter((m) => !ids || ids.includes(m.id));
  return {
    delivery: "sent",
    operation_id: intent.operation_id,
    message_id: 7,
    cards: members.map((m) => ({ id: m.id, title: `title ${m.id}`, kind: "feature" as const }))
  };
}
const notSentOf = (intent: AtomicDispatchIntent, reason: AtomicDispatchRefusal, ids: string[] = []): AtomicDispatchDelivery => ({
  delivery: "not-sent",
  operation_id: intent.operation_id,
  reason,
  card_ids: ids
});
const unknownOf = (intent: AtomicDispatchIntent, reason: "transport" | "expired" | "broker-mismatch" = "transport"): AtomicDispatchDelivery => ({
  delivery: "unknown",
  operation_id: intent.operation_id,
  reason
});

let operationSeq = 0;

function scriptedPort(answers: Answer[]): { port: AtomicPort; posted: { action: string; intent: AtomicDispatchIntent }[] } {
  const posted: { action: string; intent: AtomicDispatchIntent }[] = [];
  const port: AtomicPort = {
    capability: CAPABILITY,
    projectKey: "k",
    groupId: "group-1",
    newOperationId: () => `1000:op-${++operationSeq}`,
    post: async (action, intent) => {
      posted.push({ action, intent });
      const answer = answers[posted.length - 1];
      if (!answer) throw new Error(`unexpected post #${posted.length} (${action})`);
      return answer(action, intent);
    }
  };
  return { port, posted };
}

function waveDeps(port: AtomicPort, over: Partial<AtomicWaveDeps> = {}): AtomicWaveDeps & { lines: string[] } {
  const lines: string[] = [];
  return {
    port,
    target: () => ({ peerId: "lead-1", kind: "lead" }),
    reread: async () => [],
    journal: (l) => lines.push(`journal: ${l}`),
    warn: (l) => lines.push(`warn: ${l}`),
    ...over,
    lines
  };
}

const A = tokened({ id: "aaaaaaaa-0000-0000-0000-00000000000a", title: "Card A" });
const B = tokened({ id: "bbbbbbbb-0000-0000-0000-00000000000b", title: "Card B", content_rev: 5 });

const legacyMustNotRun = {
  announce: async (): Promise<number> => {
    throw new Error("legacy announce must not run on the atomic path");
  },
  upsert: async (): Promise<void> => {
    throw new Error("legacy upsert must not run on the atomic path");
  },
  warn: (): void => {
    throw new Error("legacy warn must not run on the atomic path");
  }
};

test("atomic wave: one execute carries every member's tokens and the lead, and only the sent members are tracked", async () => {
  const { port, posted } = scriptedPort([(_a, i) => sentOf(i)]);
  const out = await dispatchWave([A, B], { atomic: waveDeps(port), legacy: legacyMustNotRun, trace: () => {} });
  expect(posted.map((p) => p.action)).toEqual(["execute"]);
  expect(posted[0]!.intent).toMatchObject({
    broker_id: BROKER_ID,
    project_key: "k",
    group_id: "group-1",
    mode: "wave",
    target_kind: "lead",
    to_peer_id: "lead-1",
    members: [
      { id: A.id, expected_content_rev: 3, expected_dispatch_state_tag: TAG },
      { id: B.id, expected_content_rev: 5, expected_dispatch_state_tag: TAG }
    ]
  });
  expect(out.result).toMatchObject({ sent: true, delivery: "sent", count: 2, titles: ["Card A", "Card B"] });
  expect(out.dispatched.map((i) => i.id)).toEqual([A.id, B.id]);
  expect(out.pending).toBeNull();
});

const wrongCards: [string, (i: AtomicDispatchIntent) => AtomicDispatchDelivery][] = [
  ["a card missing", (i) => sentOf(i, [A.id])],
  [
    "a card too many",
    (i) => {
      const full = sentOf(i);
      return full.delivery === "sent" ? { ...full, cards: [...full.cards, { id: "eeeeeeee-0000-0000-0000-00000000000e", title: "Stranger", kind: "feature" as const }] } : full;
    }
  ],
  [
    "a card listed twice",
    (i) => {
      const full = sentOf(i);
      return full.delivery === "sent" ? { ...full, cards: [full.cards[0]!, full.cards[0]!] } : full;
    }
  ]
];

test.each(wrongCards)("atomic wave: a sent outcome with %s is unknown, settled by resolve and tracks nothing", async (_name, answer) => {
  const { port, posted } = scriptedPort([(_a, i) => answer(i), (_a, i) => answer(i)]);
  const out = await dispatchWave([A, B], { atomic: waveDeps(port), legacy: legacyMustNotRun, trace: () => {} });
  expect(posted.map((p) => p.action)).toEqual(["execute", "resolve"]);
  expect(posted[1]!.intent.operation_id).toBe(posted[0]!.intent.operation_id);
  expect(out.result).toMatchObject({ sent: false, delivery: "unknown", reason: "unconfirmed" });
  expect(out.dispatched).toEqual([]);
  expect(out.pending?.members.map((m) => m.id)).toEqual([A.id, B.id]);
});

test("atomic wave: a sent outcome naming exactly the members in another order is accepted", async () => {
  const { port } = scriptedPort([
    (_a, i) => {
      const full = sentOf(i);
      return full.delivery === "sent" ? { ...full, cards: [...full.cards].reverse() } : full;
    }
  ]);
  const out = await dispatchWave([A, B], { atomic: waveDeps(port), legacy: legacyMustNotRun, trace: () => {} });
  expect(out.result).toMatchObject({ sent: true, delivery: "sent" });
  expect(out.dispatched.map((i) => i.id)).toEqual([A.id, B.id]);
});

test("atomic wave: a first answer that is wrong and a resolve that is right settle as sent", async () => {
  const { port } = scriptedPort([(_a, i) => sentOf(i, [A.id]), (_a, i) => sentOf(i)]);
  const out = await dispatchWave([A, B], { atomic: waveDeps(port), legacy: legacyMustNotRun, trace: () => {} });
  expect(out.result).toMatchObject({ sent: true, delivery: "sent", count: 2 });
});

test("atomic wave: no lead and no sole session means no request and no card touched", async () => {
  const { port, posted } = scriptedPort([]);
  const out = await dispatchWave([A], { atomic: waveDeps(port, { target: () => null }), legacy: legacyMustNotRun, trace: () => {} });
  expect(posted).toHaveLength(0);
  expect(out.result).toEqual({ sent: false, reason: "no-lead" });
});

test("atomic wave: the sole active session is addressed with its own target kind", async () => {
  const { port, posted } = scriptedPort([(_a, i) => sentOf(i)]);
  await dispatchWave([A], { atomic: waveDeps(port, { target: () => ({ peerId: "solo-1", kind: "sole-active-fallback" }) }), legacy: legacyMustNotRun, trace: () => {} });
  expect(posted[0]!.intent).toMatchObject({ target_kind: "sole-active-fallback", to_peer_id: "solo-1" });
});

test("atomic wave: card-changed re-reads and retries ONCE under a new operation id with the fresh tokens", async () => {
  const fresh = tokened({ id: A.id, title: "Card A", content_rev: 9 });
  const { port, posted } = scriptedPort([(_a, i) => notSentOf(i, "card-changed", [A.id]), (_a, i) => sentOf(i)]);
  const deps = waveDeps(port, { reread: async () => [fresh] });
  const out = await dispatchWave([A, B], { atomic: deps, legacy: legacyMustNotRun, trace: () => {} });
  expect(posted.map((p) => p.action)).toEqual(["execute", "execute"]);
  expect(posted[1]!.intent.operation_id).not.toBe(posted[0]!.intent.operation_id);
  expect(posted[1]!.intent.members).toEqual([{ id: A.id, expected_content_rev: 9, expected_dispatch_state_tag: TAG }]);
  expect(out.dispatched.map((i) => i.id)).toEqual([A.id]);
  expect(out.result).toMatchObject({ sent: true, delivery: "sent", notSent: [{ id: B.id, title: "Card B" }] });
  expect(deps.lines.join("\n")).toContain('card "Card B" left the wave before the retry');
});

test("atomic wave: queue-changed is retried too, and a second refusal is final", async () => {
  const { port, posted } = scriptedPort([(_a, i) => notSentOf(i, "queue-changed", [A.id]), (_a, i) => notSentOf(i, "card-changed", [A.id])]);
  const out = await dispatchWave([A], { atomic: waveDeps(port, { reread: async () => [A] }), legacy: legacyMustNotRun, trace: () => {} });
  expect(posted).toHaveLength(2);
  expect(out.result).toMatchObject({ sent: false, delivery: "not-sent", reason: "card-changed", notSent: [{ id: A.id }] });
  expect(out.dispatched).toEqual([]);
});

test("atomic wave: a re-read that finds nothing left sends nothing and names every card", async () => {
  const { port, posted } = scriptedPort([(_a, i) => notSentOf(i, "queue-changed", [A.id, B.id])]);
  const out = await dispatchWave([A, B], { atomic: waveDeps(port), legacy: legacyMustNotRun, trace: () => {} });
  expect(posted).toHaveLength(1);
  expect(out.result).toMatchObject({ sent: false, delivery: "not-sent", reason: "queue-changed" });
  expect(out.result.notSent?.map((m) => m.id)).toEqual([A.id, B.id]);
});

test.each<AtomicDispatchRefusal>(["ineligible", "write-failed", "cancelled-before-execution"])(
  "atomic wave: %s is not retried and names the refusal",
  async (reason) => {
    const { port, posted } = scriptedPort([(_a, i) => notSentOf(i, reason, [B.id])]);
    const out = await dispatchWave([A, B], { atomic: waveDeps(port), legacy: legacyMustNotRun, trace: () => {} });
    expect(posted).toHaveLength(1);
    expect(out.result).toMatchObject({ sent: false, delivery: "not-sent", reason, notSent: [{ id: B.id }] });
    expect(out.dispatched).toEqual([]);
  }
);

test("atomic wave: no-target keeps the no-lead reason the barrier already words", async () => {
  const { port } = scriptedPort([(_a, i) => notSentOf(i, "no-target")]);
  const out = await dispatchWave([A, B], { atomic: waveDeps(port), legacy: legacyMustNotRun, trace: () => {} });
  expect(out.result).toMatchObject({ sent: false, delivery: "not-sent", reason: "no-lead" });
  expect(out.result.notSent?.map((m) => m.id)).toEqual([A.id, B.id]);
});

test("atomic wave: a lost answer is settled by resolve under the SAME operation id and tracked when it was sent", async () => {
  const { port, posted } = scriptedPort([(_a, i) => unknownOf(i), (_a, i) => sentOf(i)]);
  const out = await dispatchWave([A], { atomic: waveDeps(port), legacy: legacyMustNotRun, trace: () => {} });
  expect(posted.map((p) => p.action)).toEqual(["execute", "resolve"]);
  expect(posted[1]!.intent).toEqual(posted[0]!.intent);
  expect(out.result).toMatchObject({ sent: true, delivery: "sent" });
  expect(out.dispatched.map((i) => i.id)).toEqual([A.id]);
});

test("atomic wave: an answer still unknown after resolve is never resent, tracks nothing and keeps the operation to settle later", async () => {
  const { port, posted } = scriptedPort([(_a, i) => unknownOf(i), (_a, i) => unknownOf(i, "expired")]);
  const out = await dispatchWave([A, B], { atomic: waveDeps(port), legacy: legacyMustNotRun, trace: () => {} });
  expect(posted.map((p) => p.action)).toEqual(["execute", "resolve"]);
  expect(out.result).toMatchObject({ sent: false, delivery: "unknown", reason: "unconfirmed" });
  expect(out.result.unconfirmed?.map((m) => m.id)).toEqual([A.id, B.id]);
  expect(out.dispatched).toEqual([]);
  expect(out.pending?.intent.operation_id).toBe(posted[0]!.intent.operation_id);
  expect(out.pending?.members.map((m) => m.id)).toEqual([A.id, B.id]);
});

test("atomic wave: unknown that resolve turns into a refusal is not treated as sent and starts no new operation", async () => {
  const { port, posted } = scriptedPort([(_a, i) => unknownOf(i), (_a, i) => notSentOf(i, "cancelled-before-execution")]);
  const out = await dispatchWave([A], { atomic: waveDeps(port), legacy: legacyMustNotRun, trace: () => {} });
  expect(posted).toHaveLength(2);
  expect(out.result).toMatchObject({ sent: false, delivery: "not-sent", reason: "cancelled-before-execution" });
  expect(out.pending).toBeNull();
});

test("atomic wave: a member without a revision or a state tag fails loudly before any request", async () => {
  const { port, posted } = scriptedPort([]);
  const bare = item({ id: "cccccccc-0000-0000-0000-00000000000c", title: "Bare" });
  await expect(dispatchWave([bare], { atomic: waveDeps(port), legacy: legacyMustNotRun, trace: () => {} })).rejects.toThrow(
    "carries no revision or state tag"
  );
  expect(posted).toHaveLength(0);
});

test("atomic wave: more members than the broker accepts fails before any request", async () => {
  const { port, posted } = scriptedPort([]);
  const many = Array.from({ length: CAPABILITY.max_members + 1 }, (_, n) => tokened({ id: `dddddddd-0000-0000-0000-${String(n).padStart(12, "0")}` }));
  await expect(dispatchWave(many, { atomic: waveDeps(port), legacy: legacyMustNotRun, trace: () => {} })).rejects.toThrow("exceed the 50");
  expect(posted).toHaveLength(0);
});

test("a broker without the capability keeps the previous announce-then-write order and traces it", async () => {
  const order: string[] = [];
  const out = await dispatchWave([A, B], {
    atomic: null,
    legacy: {
      announce: async () => {
        order.push("announce");
        return 1;
      },
      upsert: async () => {
        order.push("upsert");
      },
      warn: () => {}
    },
    trace: (line) => order.push(`trace: ${line}`)
  });
  expect(order[0]).toContain("trace: broker serves no atomic dispatch");
  expect(order.slice(1)).toEqual(["announce", "upsert", "upsert"]);
  expect(out.result).toMatchObject({ sent: true, count: 2 });
  expect(out.result.delivery).toBeUndefined();
});

test("atomicOperationId puts the deadline inside the broker's maximum and keeps the uuid", () => {
  expect(atomicOperationId(1_000, "uuid-1", CAPABILITY)).toBe("301000:uuid-1");
  expect(atomicOperationId(1_000, "uuid-1", { ...CAPABILITY, max_operation_ms: 60_000 })).toBe("56000:uuid-1");
});

test("settleUnconfirmed: resolve answers decide, and only the operator gives up on an answer that cannot come back", async () => {
  const intent: AtomicDispatchIntent = {
    broker_id: BROKER_ID,
    operation_id: "1000:op-1",
    project_key: "k",
    group_id: "group-1",
    mode: "wave",
    target_kind: "lead",
    to_peer_id: "lead-1",
    members: [A, B].map((i) => ({ id: i.id, expected_content_rev: 3, expected_dispatch_state_tag: TAG }))
  };
  const pending = { intent, members: [{ id: A.id, title: "Card A", kind: "feature" }, { id: B.id, title: "Card B", kind: "feature" }] };
  const answer = (a: AtomicDispatchDelivery): AtomicPort => ({ ...scriptedPort([]).port, post: async () => a });
  const op = intent.operation_id;
  const sent: AtomicDispatchDelivery = {
    delivery: "sent",
    operation_id: op,
    message_id: 1,
    cards: pending.members.map((m) => ({ id: m.id, title: m.title, kind: "feature" as const }))
  };
  expect(await settleUnconfirmed(pending, answer(sent), false)).toEqual({ state: "sent", members: pending.members });
  const partial: AtomicDispatchDelivery = { ...sent, cards: sent.cards.slice(0, 1) };
  expect(await settleUnconfirmed(pending, answer(partial), false)).toEqual({ state: "unknown" });
  expect(await settleUnconfirmed(pending, answer({ delivery: "not-sent", operation_id: op, reason: "cancelled-before-execution", card_ids: [] }), false)).toEqual({ state: "not-sent", members: [] });
  const expired: AtomicDispatchDelivery = { delivery: "unknown", operation_id: op, reason: "expired" };
  expect(await settleUnconfirmed(pending, answer(expired), false)).toEqual({ state: "unknown" });
  expect(await settleUnconfirmed(pending, answer(expired), true)).toEqual({ state: "abandoned", members: [] });
  const mismatch: AtomicDispatchDelivery = { delivery: "unknown", operation_id: op, reason: "broker-mismatch" };
  expect(await settleUnconfirmed(pending, answer(mismatch), true)).toEqual({ state: "abandoned", members: [] });
  const lost: AtomicDispatchDelivery = { delivery: "unknown", operation_id: op, reason: "transport" };
  expect(await settleUnconfirmed(pending, answer(lost), true)).toEqual({ state: "unknown" });
  expect(await settleUnconfirmed(pending, null, false)).toEqual({ state: "unknown" });
  expect(await settleUnconfirmed(pending, null, true)).toEqual({ state: "abandoned", members: [] });
});

function assignDeps(port: AtomicPort | null, reads: (RoadmapItem | null)[]): AssignDeps & { calls: string[] } {
  const calls: string[] = [];
  let read = 0;
  return {
    atomic: port,
    read: async () => reads[Math.min(read++, reads.length - 1)] ?? null,
    announce: async () => {
      calls.push("announce");
      return 1;
    },
    write: async () => {
      calls.push("write");
      return { written: true, item: A };
    },
    journal: (l) => calls.push(`journal: ${l}`),
    warn: (l) => calls.push(`warn: ${l}`),
    reportError: (m) => calls.push(`error: ${m}`),
    calls
  };
}

test("atomic assign: one execute to the chosen peer, no announce and no separate write", async () => {
  const { port, posted } = scriptedPort([(_a, i) => sentOf(i)]);
  const deps = assignDeps(port, [A]);
  expect(await runAssign(A.id, " worker-9 ", deps)).toEqual({ sent: true, delivery: "sent" });
  expect(posted[0]!.intent).toMatchObject({ mode: "assign", target_kind: "assignee", to_peer_id: "worker-9", members: [{ id: A.id }] });
  expect(deps.calls).toEqual(['journal: item "Card A" assigned to "worker-9"']);
});

test("atomic assign: card-changed re-reads once and retries under a new operation id", async () => {
  const fresh = tokened({ id: A.id, title: "Card A", content_rev: 8 });
  const { port, posted } = scriptedPort([(_a, i) => notSentOf(i, "card-changed", [A.id]), (_a, i) => sentOf(i)]);
  expect(await runAssign(A.id, "worker-9", assignDeps(port, [A, fresh]))).toEqual({ sent: true, delivery: "sent" });
  expect(posted[1]!.intent.operation_id).not.toBe(posted[0]!.intent.operation_id);
  expect(posted[1]!.intent.members[0]!.expected_content_rev).toBe(8);
});

test("atomic assign: a card that vanished before the retry, a refusal and an unknown answer all report sent:false", async () => {
  const gone = scriptedPort([(_a, i) => notSentOf(i, "card-changed", [A.id])]);
  expect(await runAssign(A.id, "worker-9", assignDeps(gone.port, [A, null]))).toEqual({ sent: false, delivery: "not-sent", reason: "card-changed" });
  const refused = scriptedPort([(_a, i) => notSentOf(i, "no-target")]);
  expect(await runAssign(A.id, "ghost-1", assignDeps(refused.port, [A]))).toEqual({ sent: false, delivery: "not-sent", reason: "no-target" });
  const lost = scriptedPort([(_a, i) => unknownOf(i), (_a, i) => unknownOf(i)]);
  const deps = assignDeps(lost.port, [A]);
  expect(await runAssign(A.id, "worker-9", deps)).toEqual({ sent: false, delivery: "unknown", reason: "unconfirmed" });
  expect(lost.posted.map((p) => p.action)).toEqual(["execute", "resolve"]);
  expect(deps.calls.join("\n")).toContain("unconfirmed after resolve");
});

test("assign without the capability keeps the previous order", async () => {
  const deps = assignDeps(null, [A]);
  expect(await runAssign(A.id, "worker-9", deps)).toEqual({ sent: true });
  expect(deps.calls.slice(0, 2)).toEqual(["announce", "write"]);
});

test("a dispatch request outcome names a refusal and an unconfirmed delivery instead of 'nothing eligible'", () => {
  const notSent = composeDispatchOutcome({ sent: false, delivery: "not-sent", reason: "queue-changed", notSent: [{ id: A.id, title: "Card A", kind: "feature" }] });
  expect(notSent.cards).toEqual([]);
  expect(notSent.note).toContain("not sent (queue-changed)");
  expect(notSent.note).toContain('"Card A"');
  expect(notSent.note).not.toContain("nothing eligible");
  const unknown = composeDispatchOutcome({ sent: false, delivery: "unknown", reason: "unconfirmed", unconfirmed: [{ id: A.id, title: "Card A", kind: "feature" }] });
  expect(unknown.cards).toEqual([]);
  expect(unknown.note).toContain("NOT confirmed");
  expect(unknown.note).toContain('"Card A"');
  const subset = composeDispatchOutcome({
    sent: true,
    delivery: "sent",
    dispatched: [{ id: A.id, title: "Card A", kind: "feature" }],
    notSent: [{ id: B.id, title: "Card B", kind: "feature" }]
  });
  expect(subset.cards.map((c) => c.id)).toEqual([A.id]);
  expect(subset.note).toContain('"Card B" not sent');
});

async function unknownWave(): Promise<{ pending: NonNullable<Awaited<ReturnType<typeof dispatchWave>>["pending"]>; operationId: string }> {
  const first = scriptedPort([(_a, i) => unknownOf(i), (_a, i) => unknownOf(i)]);
  const out = await dispatchWave([A], { atomic: waveDeps(first.port), legacy: legacyMustNotRun, trace: () => {} });
  return { pending: out.pending!, operationId: first.posted[0]!.intent.operation_id };
}

test("while a delivery is unconfirmed the next dispatch only resolves it under the same operation id and never executes again", async () => {
  const { pending, operationId } = await unknownWave();
  const gate = createUnconfirmedGate(() => {});
  gate.remember(pending);
  const next = scriptedPort([(_a, i) => unknownOf(i)]);
  const early = await gate.beforeDispatch(next.port, false, () => {});
  expect(early).toMatchObject({ sent: false, delivery: "unknown", reason: "unconfirmed", unconfirmed: [{ id: A.id }] });
  expect(next.posted.map((p) => p.action)).toEqual(["resolve"]);
  expect(next.posted[0]!.intent.operation_id).toBe(operationId);
  const again = scriptedPort([(_a, i) => unknownOf(i)]);
  expect(await gate.beforeDispatch(again.port, false, () => {})).toMatchObject({ delivery: "unknown" });
});

test("an unconfirmed delivery that resolve says was sent is tracked once, reported as sent, and the gate opens", async () => {
  const { pending } = await unknownWave();
  const journal: string[] = [];
  const gate = createUnconfirmedGate((l) => journal.push(l));
  gate.remember(pending);
  const tracked: string[] = [];
  const next = scriptedPort([(_a, i) => sentOf(i)]);
  const early = await gate.beforeDispatch(next.port, false, (members) => tracked.push(...members.map((m) => m.id)));
  expect(early).toMatchObject({ sent: true, delivery: "sent", dispatched: [{ id: A.id }] });
  expect(tracked).toEqual([A.id]);
  expect(journal.join("\n")).toContain("1 item(s) were sent");
  const after = scriptedPort([]);
  expect(await gate.beforeDispatch(after.port, false, () => {})).toBeNull();
  expect(after.posted).toHaveLength(0);
});

test("an unconfirmed delivery that resolve says was not sent lets the dispatch go on and tracks nothing", async () => {
  const { pending } = await unknownWave();
  const gate = createUnconfirmedGate(() => {});
  gate.remember(pending);
  const tracked: string[] = [];
  const next = scriptedPort([(_a, i) => notSentOf(i, "cancelled-before-execution")]);
  expect(await gate.beforeDispatch(next.port, false, (m) => tracked.push(...m.map((x) => x.id)))).toBeNull();
  expect(tracked).toEqual([]);
});

test("only the operator's own dispatch gives up on an answer that can never come back", async () => {
  const { pending } = await unknownWave();
  const expired: Answer = (_a, i) => unknownOf(i, "expired");
  const auto = createUnconfirmedGate(() => {});
  auto.remember(pending);
  expect(await auto.beforeDispatch(scriptedPort([expired]).port, false, () => {})).toMatchObject({ delivery: "unknown" });
  const manual = createUnconfirmedGate(() => {});
  manual.remember(pending);
  expect(await manual.beforeDispatch(scriptedPort([expired]).port, true, () => {})).toBeNull();
});

test("remembering nothing keeps the unconfirmed delivery already held", async () => {
  const { pending } = await unknownWave();
  const gate = createUnconfirmedGate(() => {});
  gate.remember(pending);
  gate.remember(null);
  expect(await gate.beforeDispatch(scriptedPort([(_a, i) => unknownOf(i)]).port, false, () => {})).toMatchObject({ delivery: "unknown" });
});

function healthOf(body: unknown, status = 200): typeof fetch {
  return (async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status })) as unknown as typeof fetch;
}

const GOOD_CAPABILITY = { version: 1 as const, broker_id: BROKER_ID, max_operation_ms: 600_000, max_members: 50, registry_capacity: 2000 };
const EP = { url: "http://127.0.0.1:1", token: null };

test("the capability is absent only when /health says nothing about it", async () => {
  expect(await fetchAtomicDispatchCapability(EP, healthOf({ status: "ok" }))).toBeNull();
  expect(await fetchAtomicDispatchCapability(EP, healthOf({ status: "ok", atomic_dispatch: GOOD_CAPABILITY }))).toEqual(GOOD_CAPABILITY);
});

test.each<[string, unknown]>([
  ["null", { atomic_dispatch: null }],
  ["a bare version", { atomic_dispatch: { version: 1 } }],
  ["an unknown version", { atomic_dispatch: { ...GOOD_CAPABILITY, version: 2 } }],
  ["a lifetime no longer than the margin", { atomic_dispatch: { ...GOOD_CAPABILITY, max_operation_ms: 5_000 } }],
  ["a malformed broker id", { atomic_dispatch: { ...GOOD_CAPABILITY, broker_id: "x" } }],
  ["a non-positive limit", { atomic_dispatch: { ...GOOD_CAPABILITY, max_members: 0 } }],
  ["a string", { atomic_dispatch: "yes" }]
])("a present but unusable capability (%s) rejects instead of selecting the previous order", async (_name, health) => {
  await expect(fetchAtomicDispatchCapability(EP, healthOf(health))).rejects.toThrow("cannot use");
});

test("an unreadable or failing /health rejects too", async () => {
  await expect(fetchAtomicDispatchCapability(EP, healthOf("not json"))).rejects.toThrow();
  await expect(fetchAtomicDispatchCapability(EP, healthOf({}, 503))).rejects.toThrow("503");
  await expect(fetchAtomicDispatchCapability(EP, healthOf("null"))).rejects.toThrow("not an object");
});

type HarnessOver = Partial<Omit<DispatcherDeps, "openRun">> & {
  readPort?: () => Promise<AtomicPort | null>;
  openRun?: DispatcherDeps["openRun"];
};

function harness(over: HarnessOver = {}, queue: RoadmapItem[] = [A, B]) {
  const calls: string[] = [];
  const tracked: string[] = [];
  const errors: string[] = [];
  const journal: string[] = [];
  const { readPort, openRun, ...rest } = over;
  const deps: DispatcherDeps = {
    openRun:
      openRun ??
      (async () => {
        calls.push("readPort");
        const port = readPort ? await readPort() : null;
        return {
          port,
          list: async () => {
            calls.push("list");
            return queue;
          },
          directives: {
            markDone: async () => {
              calls.push("markDone");
              return undefined;
            },
            execute: async (d) => {
              calls.push("execute-directive");
              return { id: d.id, title: d.title, directive: "clear", injected: [], unreached: [] };
            },
            journal: () => {},
            reportError: () => {},
            noteUnresolved: async () => {}
          },
          legacy: {
            announce: async () => {
              calls.push("announce");
              return 1;
            },
            upsert: async () => {
              calls.push("upsert");
            },
            warn: () => {}
          }
        };
      }),
    target: () => ({ peerId: "lead-1", kind: "lead" }),
    track: (members) => tracked.push(...members.map((m) => m.id)),
    journal: (l) => journal.push(l),
    warn: () => {},
    trace: () => calls.push("trace"),
    reportError: (m) => errors.push(m),
    ...rest
  };
  return { dispatcher: createDispatcher(deps), calls, tracked, errors, journal };
}

const portQueue = (...ports: AtomicPort[]) => async (): Promise<AtomicPort | null> => ports.shift() ?? null;

test("dispatch: a capability that cannot be read sends nothing in either order and says so", async () => {
  const h = harness({
    readPort: async () => {
      throw new Error("health down");
    }
  });
  expect(await h.dispatcher.dispatch(true)).toEqual({ sent: false, reason: "error" });
  expect(h.calls).toEqual(["readPort"]);
  expect(h.errors).toEqual(["dispatch failed"]);
});

test("dispatch: no capability at all keeps the previous order, after a trace", async () => {
  const h = harness();
  const result = await h.dispatcher.dispatch(false);
  expect(h.calls).toEqual(["readPort", "list", "trace", "announce", "upsert", "upsert"]);
  expect(result).toMatchObject({ sent: true, count: 2 });
  expect(h.tracked).toEqual([A.id, B.id]);
});

test("dispatch: the capability is read before anything is listed or sent, and only confirmed members are tracked", async () => {
  const { port } = scriptedPort([(_a, i) => sentOf(i)]);
  const h = harness({ readPort: async () => port });
  const result = await h.dispatcher.dispatch(false);
  expect(h.calls).toEqual(["readPort", "list"]);
  expect(result).toMatchObject({ sent: true, delivery: "sent", dispatched: [{ id: A.id }, { id: B.id }] });
  expect(h.tracked).toEqual([A.id, B.id]);
});

test("dispatch: a refusal tracks nothing", async () => {
  const { port } = scriptedPort([(_a, i) => notSentOf(i, "ineligible", [A.id])]);
  const h = harness({ readPort: async () => port });
  const result = await h.dispatcher.dispatch(false);
  expect(result).toMatchObject({ sent: false, delivery: "not-sent", reason: "ineligible" });
  expect(result.dispatched).toBeUndefined();
  expect(h.tracked).toEqual([]);
});

test("dispatch: directive cards run before the wave and are reported with it", async () => {
  const directive = tokened({ id: "cccccccc-0000-0000-0000-00000000000c", title: "Dir", kind: "directive", directive: "clear" });
  const { port } = scriptedPort([(_a, i) => sentOf(i)]);
  const h = harness({ readPort: async () => port }, [A, directive]);
  const result = await h.dispatcher.dispatch(false);
  expect(h.calls).toEqual(["readPort", "list", "markDone", "execute-directive"]);
  expect(result.directives?.map((d) => d.id)).toEqual([directive.id]);
  expect(result.dispatched?.map((m) => m.id)).toEqual([A.id]);
});

test("dispatch: a delivery left unknown is remembered, and the next call only resolves it under the same operation id before any read", async () => {
  const first = scriptedPort([(_a, i) => unknownOf(i), (_a, i) => unknownOf(i)]);
  const second = scriptedPort([(_a, i) => unknownOf(i)]);
  const h = harness({ readPort: portQueue(first.port, second.port) });
  expect(await h.dispatcher.dispatch(false)).toMatchObject({ sent: false, delivery: "unknown", reason: "unconfirmed" });
  expect(h.calls.filter((c) => c === "list")).toHaveLength(1);
  expect(await h.dispatcher.dispatch(false)).toMatchObject({ sent: false, delivery: "unknown", unconfirmed: [{ id: A.id }, { id: B.id }] });
  expect(second.posted.map((p) => p.action)).toEqual(["resolve"]);
  expect(second.posted[0]!.intent.operation_id).toBe(first.posted[0]!.intent.operation_id);
  expect(h.calls.filter((c) => c === "list")).toHaveLength(1);
  expect(h.tracked).toEqual([]);
});

test("dispatch: a remembered delivery that resolve confirms is tracked, reported, and sends nothing new", async () => {
  const first = scriptedPort([(_a, i) => unknownOf(i), (_a, i) => unknownOf(i)]);
  const second = scriptedPort([(_a, i) => sentOf(i)]);
  const h = harness({ readPort: portQueue(first.port, second.port) });
  await h.dispatcher.dispatch(false);
  const result = await h.dispatcher.dispatch(false);
  expect(result).toMatchObject({ sent: true, delivery: "sent", dispatched: [{ id: A.id }, { id: B.id }] });
  expect(h.tracked).toEqual([A.id, B.id]);
  expect(second.posted.map((p) => p.action)).toEqual(["resolve"]);
  expect(h.calls.filter((c) => c === "list")).toHaveLength(1);
});

test("dispatch: only the operator's own dispatch gives up on a delivery whose answer cannot come back", async () => {
  const first = scriptedPort([(_a, i) => unknownOf(i), (_a, i) => unknownOf(i)]);
  const auto = scriptedPort([(_a, i) => unknownOf(i, "expired")]);
  const manual = scriptedPort([(_a, i) => unknownOf(i, "expired"), (_a, i) => sentOf(i)]);
  const h = harness({ readPort: portQueue(first.port, auto.port, manual.port) });
  await h.dispatcher.dispatch(false);
  expect(await h.dispatcher.dispatch(false)).toMatchObject({ delivery: "unknown" });
  expect(h.calls.filter((c) => c === "list")).toHaveLength(1);
  const result = await h.dispatcher.dispatch(true);
  expect(result).toMatchObject({ sent: true, delivery: "sent" });
  expect(manual.posted.map((p) => p.action)).toEqual(["resolve", "execute"]);
  expect(h.journal.join("\n")).toContain("given up by the operator");
});

test("dispatch: overlapping calls share one run", async () => {
  const { port, posted } = scriptedPort([(_a, i) => sentOf(i)]);
  const h = harness({ readPort: async () => port });
  const one = h.dispatcher.dispatch(false);
  const two = h.dispatcher.dispatch(true);
  expect(h.dispatcher.inFlight()).toBe(true);
  expect(await two).toBe(await one);
  expect(posted).toHaveLength(1);
  expect(h.dispatcher.inFlight()).toBe(false);
});

function assignerHarness(readPort: () => Promise<AtomicPort | null>) {
  const calls: string[] = [];
  const order: string[] = [];
  const journal: string[] = [];
  const errors: string[] = [];
  const assign = createAssigner({
    openRun: async () => ({
      port: await readPort(),
      read: async (id) => [A, B].find((i) => i.id === id) ?? null,
      announce: async () => {
        calls.push("announce");
        order.push("announce");
        return 1;
      },
      write: async () => {
        calls.push("write");
        order.push("write");
        return { written: true, item: A };
      }
    }),
    journal: (l) => {
      journal.push(l);
      order.push(`journal: ${l}`);
    },
    warn: () => {},
    reportError: (m) => errors.push(m),
    trace: () => calls.push("trace")
  });
  return { assign, calls, order, journal, errors };
}

test("assign: a capability that cannot be read sends nothing in either order", async () => {
  const h = assignerHarness(async () => {
    throw new Error("health down");
  });
  expect(await h.assign(A.id, "worker-9")).toEqual({ sent: false, reason: "error" });
  expect(h.calls).toEqual([]);
  expect(h.errors).toHaveLength(1);
});

test("assign: no capability keeps the previous order, after a trace", async () => {
  const h = assignerHarness(async () => null);
  expect(await h.assign(A.id, "worker-9")).toEqual({ sent: true });
  expect(h.calls).toEqual(["trace", "announce", "write"]);
});

test("assign: an assignment left unknown is resolved under the same operation id before any new one, and never re-executed", async () => {
  const first = scriptedPort([(_a, i) => unknownOf(i), (_a, i) => unknownOf(i)]);
  const again = scriptedPort([(_a, i) => unknownOf(i)]);
  const settled = scriptedPort([(_a, i) => sentOf(i)]);
  const fresh = scriptedPort([(_a, i) => sentOf(i)]);
  const h = assignerHarness(portQueue(first.port, again.port, settled.port, fresh.port));
  expect(await h.assign(A.id, "worker-9")).toEqual({ sent: false, delivery: "unknown", reason: "unconfirmed" });
  expect(await h.assign(A.id, "worker-9")).toEqual({ sent: false, delivery: "unknown", reason: "unconfirmed" });
  expect(again.posted.map((p) => p.action)).toEqual(["resolve"]);
  expect(again.posted[0]!.intent.operation_id).toBe(first.posted[0]!.intent.operation_id);
  expect(await h.assign(A.id, "worker-9")).toEqual({ sent: true, delivery: "sent" });
  expect(settled.posted.map((p) => p.action)).toEqual(["resolve"]);
  expect(await h.assign(A.id, "worker-9")).toEqual({ sent: true, delivery: "sent" });
  expect(fresh.posted.map((p) => p.action)).toEqual(["execute"]);
  expect(fresh.posted[0]!.intent.operation_id).not.toBe(first.posted[0]!.intent.operation_id);
});

test("assign: an unknown assignment of one card does not hold another card", async () => {
  const first = scriptedPort([(_a, i) => unknownOf(i), (_a, i) => unknownOf(i)]);
  const other = scriptedPort([(_a, i) => sentOf(i)]);
  const h = assignerHarness(portQueue(first.port, other.port));
  await h.assign(A.id, "worker-9");
  expect(await h.assign(B.id, "worker-9")).toEqual({ sent: true, delivery: "sent" });
  expect(other.posted.map((p) => p.action)).toEqual(["execute"]);
});

test("assign: the operator's next click gives up on an answer that cannot come back, and says so", async () => {
  const first = scriptedPort([(_a, i) => unknownOf(i), (_a, i) => unknownOf(i)]);
  const next = scriptedPort([(_a, i) => unknownOf(i, "expired"), (_a, i) => sentOf(i)]);
  const h = assignerHarness(portQueue(first.port, next.port));
  await h.assign(A.id, "worker-9");
  expect(await h.assign(A.id, "worker-9")).toEqual({ sent: true, delivery: "sent" });
  expect(next.posted.map((p) => p.action)).toEqual(["resolve", "execute"]);
  expect(h.journal.join("\n")).toContain('unconfirmed assignment of "Card A" given up by the operator');
});

test("the dispatch request poll reports a failure once, again only after a good tick, and never swallows it", async () => {
  const reported: string[] = [];
  const outcomes: (Error | null)[] = [new Error("broker down"), new Error("broker down"), null, new Error("broker down"), new Error("other")];
  const poll = createDispatchRequestPoller({
    run: async () => {
      const next = outcomes.shift();
      if (next) throw next;
    },
    reportFailure: (e) => reported.push((e as Error).message)
  });
  for (let n = 0; n < 5; n++) await poll();
  expect(reported).toEqual(["broker down", "broker down", "other"]);
});

test("assign: an assignment left unknown is given up in the journal, before any announce, when the capability is gone at the next click", async () => {
  const first = scriptedPort([(_a, i) => unknownOf(i), (_a, i) => unknownOf(i)]);
  const h = assignerHarness(portQueue(first.port));
  expect(await h.assign(A.id, "worker-9")).toEqual({ sent: false, delivery: "unknown", reason: "unconfirmed" });
  expect(await h.assign(A.id, "worker-9")).toEqual({ sent: true });
  const gaveUp = h.order.findIndex((l) => l.includes('unconfirmed assignment of "Card A" given up by the operator'));
  expect(gaveUp).toBeGreaterThanOrEqual(0);
  expect(gaveUp).toBeLessThan(h.order.indexOf("announce"));
});

test("assign: while an assignment is unconfirmed the card is not read again before it is settled", async () => {
  const ports = [scriptedPort([(_a, i) => unknownOf(i), (_a, i) => unknownOf(i)]).port, scriptedPort([(_a, i) => unknownOf(i)]).port];
  const reads: string[] = [];
  const assign = createAssigner({
    openRun: async () => ({
      port: ports.shift() ?? null,
      read: async (id) => {
        reads.push(id);
        return A;
      },
      announce: async () => 1,
      write: async () => ({ written: true, item: A })
    }),
    journal: () => {},
    warn: () => {},
    reportError: () => {},
    trace: () => {}
  });
  await assign(A.id, "worker-9");
  expect(reads).toEqual([A.id]);
  expect(await assign(A.id, "worker-9")).toMatchObject({ delivery: "unknown" });
  expect(reads).toEqual([A.id]);
});

test("dispatch: one run opens one context, and the first list, the reread and the directives all come from it", async () => {
  const used: string[] = [];
  let opens = 0;
  const { port } = scriptedPort([(_a, i) => notSentOf(i, "card-changed", [A.id]), (_a, i) => sentOf(i)]);
  const directive = tokened({ id: "cccccccc-0000-0000-0000-00000000000c", title: "Dir", kind: "directive", directive: "clear" });
  const h = harness({
    openRun: async () => {
      opens += 1;
      const run = `run-${opens}`;
      return {
        port,
        list: async () => {
          used.push(`${run}:list`);
          return [A, B, directive];
        },
        directives: {
          markDone: async () => {
            used.push(`${run}:markDone`);
            return undefined;
          },
          execute: async (d) => ({ id: d.id, title: d.title, directive: "clear", injected: [], unreached: [] }),
          journal: () => {},
          reportError: () => {},
          noteUnresolved: async () => {}
        },
        legacy: legacyMustNotRun
      };
    }
  });
  await h.dispatcher.dispatch(false);
  expect(opens).toBe(1);
  expect(used).toEqual(["run-1:list", "run-1:markDone", "run-1:list"]);
});

test("dispatch: the previous-order effects of a run come from the run that read the capability", async () => {
  const used: string[] = [];
  let opens = 0;
  const h = harness({
    openRun: async () => {
      opens += 1;
      const run = `run-${opens}`;
      return {
        port: null,
        list: async () => [A, B],
        directives: { markDone: async () => undefined, execute: async (d) => ({ id: d.id, title: d.title, directive: "clear", injected: [], unreached: [] }), journal: () => {}, reportError: () => {}, noteUnresolved: async () => {} },
        legacy: {
          announce: async () => {
            used.push(`${run}:announce`);
            return 1;
          },
          upsert: async () => {
            used.push(`${run}:upsert`);
          },
          warn: () => {}
        }
      };
    }
  });
  await h.dispatcher.dispatch(false);
  expect(opens).toBe(1);
  expect(used).toEqual(["run-1:announce", "run-1:upsert", "run-1:upsert"]);
});

test("assign: one assignment opens one context, and the read, the retry read, the announce and the write all come from it", async () => {
  const used: string[] = [];
  let opens = 0;
  const { port } = scriptedPort([(_a, i) => notSentOf(i, "card-changed", [A.id]), (_a, i) => sentOf(i)]);
  const assign = createAssigner({
    openRun: async () => {
      opens += 1;
      const run = `run-${opens}`;
      return {
        port,
        read: async (id) => {
          used.push(`${run}:read`);
          return [A, B].find((i) => i.id === id) ?? null;
        },
        announce: async () => {
          used.push(`${run}:announce`);
          return 1;
        },
        write: async () => {
          used.push(`${run}:write`);
          return { written: true, item: A };
        }
      };
    },
    journal: () => {},
    warn: () => {},
    reportError: () => {},
    trace: () => {}
  });
  expect(await assign(A.id, "worker-9")).toEqual({ sent: true, delivery: "sent" });
  expect(opens).toBe(1);
  expect(used).toEqual(["run-1:read", "run-1:read"]);
  const previous = createAssigner({
    openRun: async () => {
      opens += 1;
      const run = `run-${opens}`;
      return {
        port: null,
        read: async (id) => {
          used.push(`${run}:read`);
          return [A, B].find((i) => i.id === id) ?? null;
        },
        announce: async () => {
          used.push(`${run}:announce`);
          return 1;
        },
        write: async () => {
          used.push(`${run}:write`);
          return { written: true, item: A };
        }
      };
    },
    journal: () => {},
    warn: () => {},
    reportError: () => {},
    trace: () => {}
  });
  await previous(B.id, "worker-9");
  expect(used.slice(2)).toEqual(["run-2:read", "run-2:announce", "run-2:write"]);
});

test("SOURCE SCAN (weak): the dispatcher and the assigner resolve the broker endpoint once each, inside openRun", () => {
  const src = indexSource();
  for (const anchor of ["const dispatcher = createDispatcher({", "const assignRoadmapItem = createAssigner({"]) {
    const at = src.indexOf(anchor);
    if (at < 0) throw new Error(`anchor not found: ${anchor}`);
    const open = at + anchor.length - 1;
    const body = src.slice(open, findMatchingClose(src, open, "{", "}", true));
    expect([anchor, body.split("resolveBrokerEndpoint(").length - 1]).toEqual([anchor, 1]);
  }
});
