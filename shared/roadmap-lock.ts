// Card e7b364dc, Part B: work-lock resolution for /roadmap/upsert, extracted
// out of broker.ts's handleRoadmapUpsert into a pure module so it is
// unit-testable by truth table instead of by one HTTP round-trip per cell
// (broker.ts has zero exported symbols and runs Bun.serve unconditionally at
// module scope, so importing it directly for a unit test would start a real
// server). Pure module -- no I/O, no `Date.now()`, nothing that makes two
// calls with the same arguments answer differently. Same precedent shape as
// shared/roadmap-append.ts.
//
// This is logic moved, not logic reinvented: the body of resolveRoadmapLock
// below is the same resolution broker.ts already had inline, unchanged in
// substance, just parameterized on `nextStatus` (computed once by the
// caller) instead of reading `next.status` off a locally-built object.

import type { RoadmapItem, RoadmapStatus, RoadmapUpsertRequest } from "./types.ts";

// Covers `locked` and `locked_by` only. `locked_at` is NOT resolved here --
// callers compute it separately (broker.ts's `keptLockedAt`, preserved only
// on a same-owner re-claim) because it needs `existing.locked_at`, out of
// this function's inputs. A future field that moves ONLY `locked_at` would
// not be caught by a guard built on this function's output -- this fail-
// closed property covers `locked`/`locked_by`, not the full lock triple.
export interface RoadmapLockResolution {
  locked: boolean;
  lockedBy: string | null;
}

/**
 * Work-lock resolution (PLAN K2). Leaving in_progress always releases the
 * lock. While in_progress: an explicit `locked` wins; otherwise a non-'deck'
 * author WRITING status=in_progress claims the lock (the Deck's own
 * in_progress writes never lock -- the item is "submitted", the lock arrives
 * when the agent actually starts). Returns only `{locked, lockedBy}` --
 * callers that need to know whether to preserve `locked_at` compare this
 * result against `existing` themselves (that comparison needs `existing`'s
 * own `locked_at`, out of scope for a pure lock/lockedBy resolver).
 */
export function resolveRoadmapLock(
  existing: Pick<RoadmapItem, "locked" | "locked_by">,
  nextStatus: RoadmapStatus,
  body: Pick<RoadmapUpsertRequest, "locked" | "status">,
  by: string
): RoadmapLockResolution {
  let locked = existing.locked;
  let lockedBy = existing.locked_by;
  if (nextStatus !== "in_progress") {
    locked = false;
  } else if (body.locked !== undefined) {
    locked = body.locked;
    if (body.locked) lockedBy = by;
  } else if (body.status === "in_progress" && by !== "deck" && !existing.locked) {
    locked = true;
    lockedBy = by;
  }
  if (!locked) lockedBy = null;
  return { locked, lockedBy };
}
