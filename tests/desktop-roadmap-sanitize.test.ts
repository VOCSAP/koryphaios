// Uses a stub server, not the real broker: the broker already sanitizes
// outgoing roadmap responses, so a conforming broker cannot produce the hostile
// payloads under test -- the Deck must not depend on that goodwill.
// The first block records baseline JavaScript/directive.ts behavior as a
// negative control, so the suite can tell "the validation bites" from
// "everything throws anyway".

import { test, expect, beforeAll, afterAll } from "bun:test";
import { resolveDirectiveTargets } from "../desktop/src/main/directive.ts";
import {
  listRoadmap,
  upsertRoadmap,
  archiveRoadmap,
  reorderRoadmap,
  sanitizeRoadmapItem,
  sanitizeFacets
} from "../desktop/src/main/roadmap-service.ts";
import type { RoadmapItem } from "../desktop/src/shared/types.ts";

// ---------------------------------------------------------------------------
// 1. The hazard, measured. Green before AND after the fix.
// ---------------------------------------------------------------------------

test("a STRING target_peer_ids does not throw in resolveDirectiveTargets: it iterates characters", () => {
  const hostile = "abc" as unknown as string[];
  const r = resolveDirectiveTargets(hostile, []);
  expect(r.matched).toEqual([]);
  // Asserts the individual characters, not an error: that's what lets execution
  // reach the matched.length === 0 branch.
  expect(r.missing).toEqual(["a", "b", "c"]);
});

test("NEGATIVE CONTROL: a null target_peer_ids DOES throw inside resolveDirectiveTargets", () => {
  // Without this case the suite could not distinguish the two classes of
  // malformation, and the old CONTRACT note's claim would look simply wrong
  // rather than incomplete.
  expect(() => resolveDirectiveTargets(null as unknown as string[], [])).toThrow();
});

test("reaching the journal line with a string is what rejects: a string has no .join", () => {
  const hostile = "abc" as unknown as string[];
  expect(() => hostile.join(", ")).toThrow();
});

test("the SILENT variant: a string depends_on answers substring matches through .includes", () => {
  // A string has .includes, so a hostile string depends_on never throws -- it
  // silently answers substring matches instead, which is why the fix can't stop
  // at target_peer_ids.
  const hostile = "abcdef" as unknown as string[];
  expect(hostile.includes("cde")).toBe(true); // a dependency that does not exist
  expect(hostile.includes("xyz")).toBe(false);
});

// ---------------------------------------------------------------------------
// 2. The sanitizer. RED until sanitizeRoadmapItem exists.
// ---------------------------------------------------------------------------

/** A well-formed item, as the broker would really send it. */
function wellFormed(): Record<string, unknown> {
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
    status: "idea",
    tags: ["a"],
    depends_on: [],
    created_by: "p",
    updated_by: "p",
    created_at: "2026-08-04T00:00:00.000Z",
    updated_at: "2026-08-04T00:00:00.000Z",
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
    lock_contested_by: []
  };
}

function sanitized(patch: Record<string, unknown>): RoadmapItem {
  const out = sanitizeRoadmapItem({ ...wellFormed(), ...patch });
  expect(out).not.toBeNull();
  return out as RoadmapItem;
}

test("a well-formed item survives unchanged", () => {
  const item = sanitized({});
  expect(item.id).toBe("11111111-2222-3333-4444-555555555555");
  expect(item.tags).toEqual(["a"]);
  expect(item.queue).toBeNull();
  expect(item.locked).toBe(false);
});

test("the three array fields coerce to [] when they are not arrays of strings", () => {
  expect(sanitized({ target_peer_ids: "abc" }).target_peer_ids).toEqual([]);
  expect(sanitized({ depends_on: "abcdef" }).depends_on).toEqual([]);
  expect(sanitized({ tags: "x,y" }).tags).toEqual([]);
  expect(sanitized({ target_peer_ids: null }).target_peer_ids).toEqual([]);
  expect(sanitized({ depends_on: { 0: "a" } }).depends_on).toEqual([]);
  // Arrays whose ELEMENTS are wrong are just as dangerous as a non-array:
  // resolveDirectiveTargets would call .trim() on them.
  expect(sanitized({ target_peer_ids: [1, 2] }).target_peer_ids).toEqual([]);
  expect(sanitized({ tags: ["ok", null] }).tags).toEqual([]);
});

test("queue takes only a finite integer; every reachable JSON shape falls back to null", () => {
  // Measured: a JSON body cannot carry a bare NaN -- JSON.parse('{"queue":NaN}')
  // throws -- so these strings are the shapes that actually arrive.
  expect(sanitized({ queue: "3" }).queue).toBeNull();
  expect(sanitized({ queue: "NaN" }).queue).toBeNull();
  expect(sanitized({ queue: 1.5 }).queue).toBeNull();
  expect(sanitized({ queue: 2 }).queue).toBe(2);
  expect(sanitized({ queue: null }).queue).toBeNull();
  // Number(null) is 0, NOT NaN: a sanitizer coercing through Number() would
  // silently turn "not queued" into queue position 0.
  expect(Number(null)).toBe(0);
});

test("NaN is rejected on the DIRECT-call path, which JSON can never reach", () => {
  // This guard exists for a caller constructing the object in code, not for a
  // response body. Comparison-based clamps cannot do it: every comparison
  // against NaN is false, so a range check passes it through.
  expect(NaN > 0).toBe(false);
  expect(NaN < 1).toBe(false);
  expect(sanitized({ queue: NaN }).queue).toBeNull();
});

test("inactive survives true and coerces non-boolean to false (card c33a5968)", () => {
  expect(sanitized({ inactive: true }).inactive).toBe(true);
  expect(sanitized({ inactive: "yes" }).inactive).toBe(false);
  expect(sanitized({ inactive: 1 }).inactive).toBe(false);
  expect(sanitized({}).inactive).toBe(false);
});

test("locked, the enums and the nullable strings fall back to their declared default", () => {
  expect(sanitized({ locked: "yes" }).locked).toBe(false);
  expect(sanitized({ locked: 1 }).locked).toBe(false);
  expect(sanitized({ kind: "wat" }).kind).toBe("feature");
  expect(sanitized({ priority: "urgent" }).priority).toBe("could");
  expect(sanitized({ status: "flying" }).status).toBe("idea");
  expect(sanitized({ value: 3 }).value).toBe("medium");
  expect(sanitized({ directive: "rm -rf" }).directive).toBeNull();
  expect(sanitized({ locked_by: 42 }).locked_by).toBeNull();
  expect(sanitized({ title: 42 }).title).toBe("");
});

test("a missing field is treated exactly like a malformed one", () => {
  const partial = wellFormed();
  delete partial.tags;
  delete partial.queue;
  delete partial.title;
  const item = sanitizeRoadmapItem(partial) as RoadmapItem;
  expect(item).not.toBeNull();
  expect(item.tags).toEqual([]);
  expect(item.queue).toBeNull();
  expect(item.title).toBe("");
});

test("id and project_key are STRUCTURAL: the item is dropped, not coerced", () => {
  expect(sanitizeRoadmapItem({ ...wellFormed(), id: 42 })).toBeNull();
  expect(sanitizeRoadmapItem({ ...wellFormed(), id: "" })).toBeNull();
  expect(sanitizeRoadmapItem({ ...wellFormed(), project_key: null })).toBeNull();
  expect(sanitizeRoadmapItem(null)).toBeNull();
  expect(sanitizeRoadmapItem("nope")).toBeNull();
  expect(sanitizeRoadmapItem([])).toBeNull();
});

test("PICK-LIST, not spread: an unknown broker field does not travel through", () => {
  // RoadmapItem has 30 fields: the 27 of the e344fa79/c33a5968/edefff05
  // lineage plus the offline-replica trio (sync_state, lock_scope,
  // lock_contested_by). The pick-list covers all 30 (measured), so the next
  // one broker-side is the 31st.
  const item = sanitizeRoadmapItem({ ...wellFormed(), surprise_31st_field: "x" }) as RoadmapItem;
  expect(item).not.toBeNull();
  expect(Object.keys(item)).not.toContain("surprise_31st_field");
  expect(Object.keys(item)).toHaveLength(30);
});

test("locked_group survives when the broker sends it, and coerces non-string to null", () => {
  expect(sanitized({ locked_group: "a1b2c3" }).locked_group).toBe("a1b2c3");
  expect(sanitized({ locked_group: 42 }).locked_group).toBeNull();
  expect(sanitized({}).locked_group).toBeNull();
});

// Card edefff05: the existing pick-list coverage above proves REJECTION of an
// extra field, not RETENTION of an expected one -- a validator can pass that
// test while still dropping a legitimate field on the floor (the coverage
// convention's "growth of domain" half). This proves operator_id specifically
// survives when the broker sends it.
test("operator_id survives sanitizeRoadmapItem when the broker sends it", () => {
  const item = sanitizeRoadmapItem({
    ...wellFormed(),
    operator_id: "abc123def456"
  }) as RoadmapItem;
  expect(item.operator_id).toBe("abc123def456");
});

test("operator_id is undefined (not null, not dropped) when the broker omits it", () => {
  const item = sanitizeRoadmapItem(wellFormed()) as RoadmapItem;
  expect(item.operator_id).toBeUndefined();
  expect("operator_id" in item).toBe(true);
});

test("a non-string operator_id falls back to undefined", () => {
  const withNumber = sanitizeRoadmapItem({ ...wellFormed(), operator_id: 42 }) as RoadmapItem;
  expect(withNumber.operator_id).toBeUndefined();
  const withNull = sanitizeRoadmapItem({ ...wellFormed(), operator_id: null }) as RoadmapItem;
  expect(withNull.operator_id).toBeUndefined();
});

// ---------------------------------------------------------------------------
// 3. Wiring: the sanitizer sits at the CHOKE POINT, so all FOUR callers get it.
//    Validating only listRoadmap would be a validator wired to one of its call
//    paths -- the defect the convention names.
// ---------------------------------------------------------------------------

let stub: ReturnType<typeof Bun.serve> | null = null;
let stubUrl = "";

/**
 * What the stub serves. 'coercible' is an item whose FIELDS are malformed but
 * which stays identifiable; 'unusable' has no valid id, so it cannot be
 * repaired -- that is the input the two policies answer differently.
 */
let stubMode: "coercible" | "unusable" = "coercible";

beforeAll(() => {
  const coercible = { ...wellFormed(), target_peer_ids: "abc", depends_on: "xy", tags: "t" };
  const unusable = { id: 42 };
  stub = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      const item = stubMode === "coercible" ? coercible : unusable;
      const body =
        path === "/roadmap/list" || path === "/roadmap/reorder" ? { items: [item] } : { item };
      return new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" }
      });
    }
  });
  stubUrl = `http://127.0.0.1:${stub.port}`;
});

afterAll(() => {
  stub?.stop(true);
});

test("all four roadmap responses are sanitized, not just the list", async () => {
  stubMode = "coercible";
  const endpoint = { url: stubUrl, token: null } as { url: string; token: string | null };

  const listed = await listRoadmap(endpoint, "k", {});
  const upserted = await upsertRoadmap(endpoint, "k", {});
  const reordered = await reorderRoadmap(endpoint, "k", []);
  const archived = await archiveRoadmap(endpoint, "id");

  for (const [label, item] of [
    ["list", listed[0]],
    ["upsert", upserted],
    ["reorder", reordered[0]],
    ["archive", archived]
  ] as Array<[string, RoadmapItem]>) {
    expect([label, item.target_peer_ids]).toEqual([label, []]);
    expect([label, item.depends_on]).toEqual([label, []]);
    expect([label, item.tags]).toEqual([label, []]);
  }
});

// ---------------------------------------------------------------------------
// 4. The ASYMMETRY between the two policies, which was a design decision living
//    only in a comment until the reviewer mutated sanitizeOne to stop throwing
//    and the suite still passed 13/13.
//
//    Both halves are asserted on the SAME input on purpose: one alone proves
//    half of it. "A single response throws" says nothing about why a list does
//    not, and "a list drops" says nothing about why a single response may not
//    fabricate a card in its place.
// ---------------------------------------------------------------------------

test("an UNUSABLE item makes a single-item response THROW but only shrinks a list", async () => {
  stubMode = "unusable";
  const endpoint = { url: stubUrl, token: null } as { url: string; token: string | null };
  try {
    // Single item: the caller asked about ONE card and would otherwise receive a
    // fabricated one, so there is no sensible degraded result. It must reject.
    await expect(upsertRoadmap(endpoint, "k", {})).rejects.toThrow();
    await expect(archiveRoadmap(endpoint, "id")).rejects.toThrow();

    // Same payload through a list: one bad row must not take the whole board
    // down, so it is dropped (and counted in the trace) and the rest survives.
    expect(await listRoadmap(endpoint, "k", {})).toEqual([]);
    expect(await reorderRoadmap(endpoint, "k", [])).toEqual([]);
  } finally {
    stubMode = "coercible";
  }
});

// ---------------------------------------------------------------------------
// 5. sanitizeFacets (review round 2, point 2): a malformed dimension must
//    reject the WHOLE payload, never degrade one dimension to `[]` while
//    the other five look fine -- that silent partial object is
//    indistinguishable from "this project has zero of every kind", the
//    exact false-empty the filter panel cannot recover from on its own.
// ---------------------------------------------------------------------------

function wellFormedFacets(): Record<string, unknown> {
  return {
    kind: [{ value: "feature", count: 3 }],
    priority: [{ value: "must", count: 1 }],
    effort: [{ value: "low", count: 2 }],
    value: [{ value: "high", count: 1 }],
    status: [{ value: "planned", count: 4 }],
    tags: [{ value: "urgent", count: 1 }],
    reference_total: 12
  };
}

test("a well-formed facets payload survives unchanged", () => {
  const facets = sanitizeFacets(wellFormedFacets());
  expect(facets).toEqual({
    kind: [{ value: "feature", count: 3 }],
    priority: [{ value: "must", count: 1 }],
    effort: [{ value: "low", count: 2 }],
    value: [{ value: "high", count: 1 }],
    status: [{ value: "planned", count: 4 }],
    tags: [{ value: "urgent", count: 1 }],
    reference_total: 12
  });
});

test("ONE malformed dimension rejects the WHOLE facets payload, not just that dimension", () => {
  const broken = { ...wellFormedFacets(), kind: "not-an-array" };
  // Measured regression: before the fix this returned a valid-looking object
  // with `kind: []`, reading as "zero features" instead of "broker sent
  // garbage" -- both other dimensions being fine does not save it.
  expect(sanitizeFacets(broken)).toBeNull();
});

test("a malformed INDIVIDUAL bucket is dropped from its dimension, not the whole payload", () => {
  const partial = {
    ...wellFormedFacets(),
    kind: [{ value: "feature", count: 3 }, { value: 42, count: "nope" }, { count: 1 }]
  };
  const facets = sanitizeFacets(partial);
  expect(facets).not.toBeNull();
  // The two malformed buckets are dropped; the well-formed one and every
  // OTHER dimension survive -- this is the case that must NOT reject the
  // whole payload, distinguishing it from the test above.
  expect(facets!.kind).toEqual([{ value: "feature", count: 3 }]);
  expect(facets!.priority).toEqual([{ value: "must", count: 1 }]);
});

// ---------------------------------------------------------------------------
// 4. The offline-replica trio. Each guarantees a DEFAULT that is inert, so a
// broker that never heard of replication (or a hostile one) renders exactly
// like the board did before the feature existed.
// ---------------------------------------------------------------------------

test("sync_state defaults to 'clean': an unreadable value must never mark a card conflicted", () => {
  expect(sanitized({ sync_state: "conflict" }).sync_state).toBe("conflict");
  // Guarantee: only the two known states exist; anything else is 'clean', so
  // garbage can neither raise a red ring nor be counted by the rail badge.
  expect(sanitized({ sync_state: "CONFLICT" }).sync_state).toBe("clean");
  expect(sanitized({ sync_state: "dirty" }).sync_state).toBe("clean");
  expect(sanitized({ sync_state: 1 }).sync_state).toBe("clean");
  expect(sanitized({ sync_state: null }).sync_state).toBe("clean");
  // Absent entirely (a broker predating the feature): also 'clean'.
  const older = wellFormed();
  delete older.sync_state;
  expect((sanitizeRoadmapItem(older) as RoadmapItem).sync_state).toBe("clean");
});

test("lock_scope keeps only the five known scopes and is null otherwise", () => {
  for (const scope of ["local", "global", "contested", "remote", "release_pending"]) {
    expect(sanitized({ lock_scope: scope }).lock_scope).toBe(scope as never);
  }
  // Guarantee: an unrecognized scope reads as "no replica scope", never as
  // 'remote' -- 'remote' is what makes the Deck show a lock nobody local holds.
  expect(sanitized({ lock_scope: "REMOTE" }).lock_scope).toBeNull();
  expect(sanitized({ lock_scope: "upstream" }).lock_scope).toBeNull();
  expect(sanitized({ lock_scope: 0 }).lock_scope).toBeNull();
  expect(sanitized({ lock_scope: ["remote"] }).lock_scope).toBeNull();
  const older = wellFormed();
  delete older.lock_scope;
  expect((sanitizeRoadmapItem(older) as RoadmapItem).lock_scope).toBeNull();
});

test("lock_contested_by is a string array or [], elements included", () => {
  expect(sanitized({ lock_contested_by: ["p1@r1", "p2@r2"] }).lock_contested_by).toEqual([
    "p1@r1",
    "p2@r2",
  ]);
  // Guarantee: the field is rendered as a list of holders, so a string would
  // otherwise be iterated character by character exactly like target_peer_ids.
  expect(sanitized({ lock_contested_by: "p1@r1" }).lock_contested_by).toEqual([]);
  expect(sanitized({ lock_contested_by: [1, 2] }).lock_contested_by).toEqual([]);
  expect(sanitized({ lock_contested_by: null }).lock_contested_by).toEqual([]);
  const older = wellFormed();
  delete older.lock_contested_by;
  expect((sanitizeRoadmapItem(older) as RoadmapItem).lock_contested_by).toEqual([]);
});
