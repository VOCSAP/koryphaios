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

/**
 * Card c33a5968, DELTA form (team-lead review, 2026-08-12): an inactive card
 * must not be moved toward in_progress/locked while it stays inactive -- but
 * only a write that INCREASES the claim relative to the STORED row may be
 * refused. An absolute check on `nextStatus`/`nextLocked` alone (the
 * original shape) punishes a write that claims NOTHING: once a row is
 * already stored as in_progress, every subsequent write -- including one
 * that only clears `inactive`, or an unrelated field edit -- resolves
 * `nextStatus === "in_progress"` to true again and gets refused forever,
 * which locks the operator out of clearing `inactive` on a card they just
 * made inactive. The caller must resolve `storedInactive` from the row's
 * PRE-write value (never a value the same request might simultaneously be
 * setting), so a single
 * call cannot both clear `inactive` and claim the card in one step -- the
 * delta form still catches that, since `existingStatus`/`existingLocked` are
 * ALSO the pre-write values: a same-request bypass moves both `nextStatus`
 * to in_progress and `storedInactive` to false in one call, but the refusal
 * reads `storedInactive` (true, pre-write) against the delta on status/lock
 * (also true, since existingStatus was never in_progress), so it still 403s.
 */
export function refusesInactiveClaim(
  storedInactive: boolean,
  existingStatus: RoadmapStatus,
  existingLocked: boolean,
  nextStatus: RoadmapStatus,
  nextLocked: boolean
): boolean {
  return (
    storedInactive &&
    ((nextStatus === "in_progress" && existingStatus !== "in_progress") ||
      (nextLocked && !existingLocked))
  );
}

/**
 * Card c33a5968: toggling `inactive` itself (set OR clear) is an operator
 * gesture, never an ordinary agent write -- `hasOperatorProof` must come from
 * `resolveRoadmapAuthor`'s cryptographically-resolved `operator_id`, never a
 * client-declared field.
 */
export function refusesInactiveToggle(
  storedInactive: boolean,
  nextInactive: boolean,
  hasOperatorProof: boolean
): boolean {
  return storedInactive !== nextInactive && !hasOperatorProof;
}

/**
 * Card aaf4537d (lots 1+2): a PARKED card (Pause stop) is immune to
 * releaseStaleLocks's ordinary TTL/owner-gone sweep -- but only for
 * `ttlSec` (LOCK_PARK_TTL_SEC), never forever. `parkedAt === null` means
 * unparked (false). A parked-but-EXPIRED row also reads as unparked here,
 * deliberately: the team-lead's arbitration for this card is that the park
 * itself must carry an expiration inside the shared prefix, or an operator's
 * 24h decision exists nowhere and the park becomes eternal. broker.ts's
 * releaseStaleLocks clause 3 is what actually SWEEPS an expired park (clears
 * the lock and both park columns); this predicate is what every OTHER guard
 * (refusesParkedArchive below, any future TS-side "is this card parked"
 * check) must agree with on the exact same threshold, so the SQL sweep and
 * the TS guards cannot silently drift onto different cutoffs.
 */
// Round-3 mutation review (card aaf4537d): a bare SQLite `datetime('now')`
// string ("YYYY-MM-DD HH:MM:SS") carries no timezone marker at all, and
// `Date.parse()` reads a marker-less string as LOCAL time (V8 behaviour) --
// on a non-UTC host that silently shifts the instant by the host's UTC
// offset, expiring a fresh park immediately under a short TTL and shrinking
// every park by up to ~14h at the default TTL. `bun test` forces TZ=UTC, so
// a suite that never sets TZ explicitly is structurally blind to this.
// broker.ts's lock-park route now writes an ISO string (with 'Z'), but this
// is a pure module with more than one producer over time (a restored/
// imported row, a future write path) -- normalize here rather than trust
// the producer: a string with no 'Z' and no `+HH:MM`/`-HH:MM` offset is
// treated as UTC, by swapping SQLite's space separator for 'T' (which
// `Date.parse` requires) and appending 'Z'.
function parseAsUtcMs(value: string): number {
  const hasTimezone = /Z$|[+-]\d{2}:\d{2}$/.test(value);
  if (hasTimezone) return Date.parse(value);
  return Date.parse(`${value.replace(" ", "T")}Z`);
}

export function isParked(parkedAt: string | null, nowIso: string, ttlSec: number): boolean {
  if (parkedAt === null) return false;
  const parkedMs = parseAsUtcMs(parkedAt);
  const nowMs = parseAsUtcMs(nowIso);
  if (Number.isNaN(parkedMs) || Number.isNaN(nowMs)) return false;
  return nowMs - parkedMs < ttlSec * 1000;
}

/**
 * Card aaf4537d, DELTA form (team-lead correction, 2026-08-12): a card
 * parked by one operator must not be archived out from under them by a
 * different write -- but the SAME operator who parked it may still archive
 * it (the park is their own decision to reverse, not a lock on themselves).
 * Keyed on `actorOperatorId` (resolveRoadmapAuthor's cryptographically-
 * resolved `operator_id`), NEVER on the free-text `by` field: on a shared
 * broker two different operators can each sign a write with `by='deck'`,
 * so comparing `by` would let operator B silently archive a card operator A
 * just parked. `actorOperatorId === undefined` (an ordinary agent write, no
 * operator signature at all) always refuses while the card is parked --
 * `undefined !== parkedBy` holds for every real `parkedBy` string, so this
 * is fail-closed by construction, not by an extra null check.
 */
export function refusesParkedArchive(
  parkedBy: string | null,
  parkedAt: string | null,
  nowIso: string,
  ttlSec: number,
  actorOperatorId: string | undefined
): boolean {
  return isParked(parkedAt, nowIso, ttlSec) && actorOperatorId !== parkedBy;
}
