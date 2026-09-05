// Offline replica, Deck side. Two units, both reachable without electron:
//   * the response sanitizers of desktop/src/main/roadmap-service.ts, fed the
//     hostile shapes a broker (or anything answering on its port) can produce;
//   * desktop/src/shared/roadmap-sync.ts, the pure diff the resolution dialog
//     renders.
// A replica serves rows it received from a machine this Deck has no
// relationship with, so "the broker already sanitizes it" is not an argument
// here -- these guards are the last line before the operator arbitrates.
//
// NOT covered here, deliberately: the main-process poll's own change signature
// (`roadmapSyncSignature` in desktop/src/main/index.ts). index.ts imports
// electron at module scope, so bun cannot load it, and every sibling poll's
// signature (pollGraphDrafts, pollPendingApprovals) is inline and untested for
// the same reason -- this file does not pretend to close that hole.

import { test, expect } from "bun:test";
import {
  sanitizeSyncConflicts,
  sanitizeSyncStatus,
} from "../desktop/src/main/roadmap-service.ts";
import {
  ROADMAP_SYNC_RESOLUTIONS,
  ROADMAP_SYNC_TRANSITION_FIELDS,
  conflictFieldDiffs,
  formatSyncValue,
  sameSyncValue,
} from "../desktop/src/shared/roadmap-sync.ts";
import {
  ROADMAP_SYNC_CONTENT_FIELDS,
  type RoadmapItem,
  type RoadmapSyncConflict,
} from "../desktop/src/shared/types.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function wellFormedItem(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "11111111-2222-3333-4444-555555555555",
    project_key: "github.com/vocsap/x",
    kind: "feature",
    title: "t",
    description: "d",
    rationale: "r",
    context: "c",
    priority: "could",
    value: "medium",
    effort: "medium",
    status: "planned",
    tags: [],
    depends_on: [],
    created_by: "p",
    updated_by: "p",
    created_at: "2026-09-04T00:00:00.000Z",
    updated_at: "2026-09-04T00:00:00.000Z",
    deleted_at: null,
    queue: null,
    locked: false,
    locked_by: null,
    locked_at: null,
    locked_group: null,
    directive: null,
    target_peer_ids: [],
    inactive: false,
    sync_state: "clean",
    lock_scope: null,
    lock_contested_by: [],
    ...patch,
  };
}

// ---------------------------------------------------------------------------
// 1. /roadmap/sync/status
// ---------------------------------------------------------------------------

test("a well-formed replica status survives field for field", () => {
  const status = sanitizeSyncStatus({
    mode: "replica",
    upstream_url: "https://broker.example/",
    online: false,
    since: "2026-09-05T10:00:00.000Z",
    last_error: "fetch failed",
    last_sync_at: "2026-09-05T09:58:00.000Z",
    cursor: 42,
    conflicts: 3,
    pending_push: 7,
    locks: { local: 1, global: 2, contested: 0, remote: 4 },
  });
  expect(status).toEqual({
    mode: "replica",
    upstream_url: "https://broker.example/",
    online: false,
    since: "2026-09-05T10:00:00.000Z",
    last_error: "fetch failed",
    last_sync_at: "2026-09-05T09:58:00.000Z",
    cursor: 42,
    conflicts: 3,
    pending_push: 7,
    locks: { local: 1, global: 2, contested: 0, remote: 4 },
  });
});

test("a non-replica broker's bare { mode } answer stays bare", () => {
  const status = sanitizeSyncStatus({ mode: "upstream" });
  expect(status.mode).toBe("upstream");
  // Guarantee: an absent counter stays ABSENT, never becomes 0 -- the banner
  // and the badge must not display a count nobody reported.
  expect(status.conflicts).toBeUndefined();
  expect(status.pending_push).toBeUndefined();
  expect(status.online).toBeUndefined();
  expect(status.locks).toBeUndefined();
});

test("an unreadable mode falls back to 'local', the INERT value", () => {
  // Guarantee: only a broker that positively says 'replica' turns on the
  // conflicts poll and can raise the offline banner. Every other answer --
  // wrong case, unknown word, wrong type, missing key -- must read as a plain
  // non-replica broker.
  expect(sanitizeSyncStatus({ mode: "REPLICA" }).mode).toBe("local");
  expect(sanitizeSyncStatus({ mode: "mirror" }).mode).toBe("local");
  expect(sanitizeSyncStatus({ mode: 1 }).mode).toBe("local");
  expect(sanitizeSyncStatus({}).mode).toBe("local");
  expect(sanitizeSyncStatus(null).mode).toBe("local");
  expect(sanitizeSyncStatus("replica").mode).toBe("local");
  expect(sanitizeSyncStatus(["replica"]).mode).toBe("local");
});

test("counters take only finite integers; every other JSON shape drops the field", () => {
  // Measured: JSON.parse('{"conflicts":NaN}') throws, so over the wire the
  // reachable shapes are a string, a float and null. The NaN case guards the
  // direct-call path only.
  expect(sanitizeSyncStatus({ mode: "replica", conflicts: "3" }).conflicts).toBeUndefined();
  expect(sanitizeSyncStatus({ mode: "replica", conflicts: 1.5 }).conflicts).toBeUndefined();
  expect(sanitizeSyncStatus({ mode: "replica", conflicts: null }).conflicts).toBeUndefined();
  expect(sanitizeSyncStatus({ mode: "replica", conflicts: NaN }).conflicts).toBeUndefined();
  expect(sanitizeSyncStatus({ mode: "replica", pending_push: 0 }).pending_push).toBe(0);
  // Number("") is 0, so a sanitizer coercing through Number() would turn an
  // empty string into "nothing pending" instead of "nobody said".
  expect(Number("")).toBe(0);
});

test("online is a boolean or absent: a truthy string must not read as online", () => {
  expect(sanitizeSyncStatus({ mode: "replica", online: true }).online).toBe(true);
  expect(sanitizeSyncStatus({ mode: "replica", online: false }).online).toBe(false);
  // Guarantee: `online === false` is what raises the offline banner, so
  // "false" (the string) must not be silently coerced either way.
  expect(sanitizeSyncStatus({ mode: "replica", online: "false" }).online).toBeUndefined();
  expect(sanitizeSyncStatus({ mode: "replica", online: 0 }).online).toBeUndefined();
});

test("ONE unreadable lock counter drops the WHOLE lock set, not just that counter", () => {
  // Guarantee: a partially-readable set would report "0 contested locks" on a
  // broker that simply speaks another shape -- a confident zero over something
  // nobody counted, the exact failure sanitizeFacets already refuses.
  const partial = sanitizeSyncStatus({
    mode: "replica",
    locks: { local: 1, global: 2, contested: "many", remote: 4 },
  });
  expect(partial.locks).toBeUndefined();
  expect(sanitizeSyncStatus({ mode: "replica", locks: [] }).locks).toBeUndefined();
  expect(sanitizeSyncStatus({ mode: "replica", locks: { local: 1 } }).locks).toBeUndefined();
});

test("extra broker fields never travel through the status pick-list", () => {
  const status = sanitizeSyncStatus({ mode: "replica", broker_token: "s3cret", replica_id: "r1" });
  expect(Object.keys(status)).not.toContain("broker_token");
  expect(Object.keys(status)).not.toContain("replica_id");
});

// ---------------------------------------------------------------------------
// 2. /roadmap/sync/conflicts
// ---------------------------------------------------------------------------

function wellFormedConflict(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    local: wellFormedItem({ title: "local title", sync_state: "conflict" }),
    remote: wellFormedItem({ title: "remote title", rev: 12, content_rev: 9 }),
    base: { title: "base title" },
    ...patch,
  };
}

test("a well-formed conflict keeps both sides and the upstream revisions", () => {
  const [conflict] = sanitizeSyncConflicts([wellFormedConflict()]);
  expect(conflict).toBeDefined();
  expect(conflict!.local.title).toBe("local title");
  expect(conflict!.remote.title).toBe("remote title");
  expect(conflict!.remote.rev).toBe(12);
  expect(conflict!.remote.content_rev).toBe(9);
  expect(conflict!.base?.title).toBe("base title");
});

test("a conflict missing EITHER side is dropped, never half-rendered", () => {
  // Guarantee: the dialog offers three irreversible-looking buttons over two
  // columns; one column made of defaults would be arbitration over fiction.
  expect(sanitizeSyncConflicts([wellFormedConflict({ local: null })])).toHaveLength(0);
  expect(sanitizeSyncConflicts([wellFormedConflict({ remote: undefined })])).toHaveLength(0);
  expect(sanitizeSyncConflicts([wellFormedConflict({ local: { id: "x" } })])).toHaveLength(0);
  expect(sanitizeSyncConflicts([wellFormedConflict({ remote: "nope" })])).toHaveLength(0);
  expect(sanitizeSyncConflicts(["nope", 42, null, []])).toHaveLength(0);
});

test("one broken conflict does not take the readable ones with it", () => {
  const items = sanitizeSyncConflicts([
    wellFormedConflict(),
    wellFormedConflict({ local: null }),
    wellFormedConflict(),
  ]);
  expect(items).toHaveLength(2);
});

test("a non-array conflicts payload reads as EMPTY, never throws", () => {
  expect(sanitizeSyncConflicts(undefined)).toEqual([]);
  expect(sanitizeSyncConflicts(null)).toEqual([]);
  expect(sanitizeSyncConflicts({ items: [] })).toEqual([]);
  expect(sanitizeSyncConflicts("[]")).toEqual([]);
});

test("missing revisions default to 0 rather than NaN or undefined", () => {
  const remote = wellFormedItem({ rev: "12", content_rev: null });
  const [conflict] = sanitizeSyncConflicts([wellFormedConflict({ remote })]);
  // Guarantee: the poll's change signature interpolates content_rev, and
  // `undefined`/NaN would make every tick look different from the last, so the
  // renderer would be re-pushed a state that never changed.
  expect(conflict!.remote.rev).toBe(0);
  expect(conflict!.remote.content_rev).toBe(0);
});

test("a base is sanitized to the CONTENT fields only -- no id, no lock, no operator", () => {
  const [conflict] = sanitizeSyncConflicts([
    wellFormedConflict({
      base: { title: "b", locked_by: "agent", operator_id: "op1", queue: 3, id: "other" },
    }),
  ]);
  const base = conflict!.base;
  expect(base).not.toBeNull();
  expect(Object.keys(base!).sort()).toEqual([...ROADMAP_SYNC_CONTENT_FIELDS].sort());
  expect(Object.keys(base!)).not.toContain("locked_by");
  expect(Object.keys(base!)).not.toContain("operator_id");
  expect(Object.keys(base!)).not.toContain("queue");
});

test("a null or unusable base stays null: 'never synced' is a state, not a failure", () => {
  expect(sanitizeSyncConflicts([wellFormedConflict({ base: null })])[0]!.base).toBeNull();
  expect(sanitizeSyncConflicts([wellFormedConflict({ base: "nope" })])[0]!.base).toBeNull();
  expect(sanitizeSyncConflicts([wellFormedConflict({ base: [] })])[0]!.base).toBeNull();
});

// ---------------------------------------------------------------------------
// 3. The diff the dialog renders (pure)
// ---------------------------------------------------------------------------

function item(patch: Partial<RoadmapItem>): RoadmapItem {
  return { ...(wellFormedItem() as unknown as RoadmapItem), ...patch };
}

function conflict(
  local: Partial<RoadmapItem>,
  remote: Partial<RoadmapItem>,
  base: RoadmapSyncConflict["base"] = null,
): RoadmapSyncConflict {
  return {
    local: item(local),
    remote: { ...item(remote), rev: 1, content_rev: 1 },
    base,
  };
}

test("only the fields that DIFFER are listed", () => {
  const diffs = conflictFieldDiffs(conflict({ title: "a" }, { title: "b" }));
  expect(diffs.map((d) => d.field)).toEqual(["title"]);
});

test("two identical sides produce no line at all", () => {
  expect(conflictFieldDiffs(conflict({}, {}))).toEqual([]);
});

test("the lifecycle fields are listed FIRST and marked, whatever the column order", () => {
  const diffs = conflictFieldDiffs(
    conflict(
      { title: "a", status: "done", deleted_at: null },
      { title: "b", status: "planned", deleted_at: "2026-09-05T00:00:00.000Z" },
    ),
  );
  // Guarantee: a card closed on one side and enriched on the other is read
  // before the wording changes underneath it.
  expect(diffs.map((d) => d.field)).toEqual(["status", "deleted_at", "title"]);
  expect(diffs.filter((d) => d.transition).map((d) => d.field)).toEqual([
    ...ROADMAP_SYNC_TRANSITION_FIELDS,
  ]);
});

test("arrays are compared ELEMENT-WISE, not by reference", () => {
  // Guarantee: `===` on two arrays is always false, so a reference comparison
  // would report tags/depends_on/target_peer_ids as differing on EVERY card
  // and drown the two or three real divergences.
  expect(sameSyncValue(["a", "b"], ["a", "b"])).toBe(true);
  expect(sameSyncValue(["a", "b"], ["b", "a"])).toBe(false);
  expect(sameSyncValue(["a"], ["a", "b"])).toBe(false);
  expect(sameSyncValue([], null)).toBe(false);
  expect(conflictFieldDiffs(conflict({ tags: ["x"] }, { tags: ["x"] }))).toEqual([]);
  expect(
    conflictFieldDiffs(conflict({ tags: ["x"] }, { tags: ["y"] })).map((d) => d.field),
  ).toEqual(["tags"]);
});

test("with a base, each side is told whether IT is the one that changed", () => {
  const diffs = conflictFieldDiffs(
    conflict({ title: "local" }, { title: "base" }, {
      ...({} as RoadmapSyncConflict["base"]),
      kind: "feature",
      title: "base",
      description: "d",
      rationale: "r",
      context: "c",
      priority: "could",
      value: "medium",
      effort: "medium",
      status: "planned",
      tags: [],
      depends_on: [],
      deleted_at: null,
      directive: null,
      target_peer_ids: [],
      inactive: false,
    }),
  );
  expect(diffs).toHaveLength(1);
  expect(diffs[0]!.hasBase).toBe(true);
  expect(diffs[0]!.localChanged).toBe(true);
  expect(diffs[0]!.remoteChanged).toBe(false);
});

test("without a base NEITHER side is marked changed: nothing is known, not 'unchanged'", () => {
  const diffs = conflictFieldDiffs(conflict({ title: "a" }, { title: "b" }, null));
  expect(diffs[0]!.hasBase).toBe(false);
  expect(diffs[0]!.localChanged).toBe(false);
  expect(diffs[0]!.remoteChanged).toBe(false);
});

const LABELS = { empty: "(empty)", none: "(none)", yes: "yes", no: "no" };

test("formatSyncValue never returns a blank cell", () => {
  // Guarantee: a blank cell reads as "this side is missing", which is exactly
  // the distinction the operator is arbitrating -- empty is not absent.
  expect(formatSyncValue("", LABELS)).toBe("(empty)");
  expect(formatSyncValue([], LABELS)).toBe("(empty)");
  expect(formatSyncValue(null, LABELS)).toBe("(none)");
  expect(formatSyncValue(undefined, LABELS)).toBe("(none)");
  expect(formatSyncValue(false, LABELS)).toBe("no");
  expect(formatSyncValue(true, LABELS)).toBe("yes");
  expect(formatSyncValue(["a", "b"], LABELS)).toBe("a, b");
  expect(formatSyncValue("planned", LABELS)).toBe("planned");
});

test("the three resolutions are exactly the ones the broker accepts", () => {
  // The main-process IPC guard validates against this array and the dialog
  // renders one button per entry: a fourth button could not exist without a
  // fourth entry, which the broker would then have to accept.
  expect([...ROADMAP_SYNC_RESOLUTIONS]).toEqual(["remote", "local", "merge_reopen"]);
});
