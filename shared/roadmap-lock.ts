// Pure module, no I/O -- broker.ts exports nothing and runs Bun.serve
// unconditionally at module scope, so it cannot be imported directly for a unit
// test.

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
  /**
   * True exactly when this call is what set lockedBy to by -- an explicit
   * locked:true, or the implicit claim on a fresh (!existing.locked)
   * status=in_progress write. False for a release, a same-owner resend on an
   * already-locked row, or a third-party write touching no lock field.
   * lockedBy === existing.locked_by is not equivalent: it can be true because
   * nothing changed, not only on a genuine reclaim -- claimed distinguishes the
   * two for callers that stamp the current writer's own identity.
   */
  claimed: boolean;
}

/**
 * Work-lock resolution (PLAN K2). Leaving in_progress always releases the
 * lock. While in_progress: an explicit `locked` wins; otherwise a non-'deck'
 * author WRITING status=in_progress claims the lock (the Deck's own
 * in_progress writes never lock -- the item is "submitted", the lock arrives
 * when the agent actually starts). Returns `{locked, lockedBy, claimed}` --
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
  let claimed = false;
  if (nextStatus !== "in_progress") {
    locked = false;
  } else if (body.locked !== undefined) {
    locked = body.locked;
    if (body.locked) {
      lockedBy = by;
      claimed = true;
    }
  } else if (body.status === "in_progress" && by !== "deck" && !existing.locked) {
    locked = true;
    lockedBy = by;
    claimed = true;
  }
  if (!locked) lockedBy = null;
  return { locked, lockedBy, claimed };
}

/**
 * authorLockedGroup is only ever consulted when claimed is true -- a
 * non-claiming write has no standing to stamp its own group onto a lock it did
 * not touch.
 */
export function resolveLockedGroup(
  resolvedLock: Pick<RoadmapLockResolution, "locked" | "claimed">,
  existingLockedGroup: string | null,
  authorLockedGroup: string | null
): string | null {
  if (!resolvedLock.locked) return null;
  return resolvedLock.claimed ? authorLockedGroup : existingLockedGroup;
}

/**
 * Same claimed-only discipline as resolveLockedGroup: a non-claiming write
 * preserves the real owner's proven token rather than overwriting it with the
 * current writer's own, or null.
 * authorInstanceToken is normalized to null when resolveRoadmapAuthor could not
 * prove the claim via a real token.
 */
export function resolveLockedByToken(
  resolvedLock: Pick<RoadmapLockResolution, "locked" | "claimed">,
  existingLockedByToken: string | null,
  authorInstanceToken: string | undefined
): string | null {
  if (!resolvedLock.locked) return null;
  return resolvedLock.claimed ? (authorInstanceToken ?? null) : existingLockedByToken;
}

/**
 * Same claimed-only discipline: locked_at is refreshed to now only on an actual
 * (re-)claim, never on an ordinary third-party write to an already-locked card.
 */
export function resolveKeptLockedAt(
  resolvedLock: Pick<RoadmapLockResolution, "locked" | "claimed">,
  existingLockedAt: string | null
): string | null {
  return resolvedLock.locked && !resolvedLock.claimed ? existingLockedAt : null;
}

/**
 * Refuses only a write that increases the claim relative to the stored row --
 * an absolute check on nextStatus/nextLocked alone would refuse every
 * subsequent write once a card is already in_progress, permanently blocking
 * clearing inactive.
 * storedInactive and existingStatus/existingLocked must be the row's pre-write
 * values, never a value the same request is simultaneously setting, so one call
 * cannot clear inactive and claim the card in the same step.
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
 * A parked-but-expired row reads as unparked here: the park itself carries an
 * expiration, or an operator's decision exists nowhere and the park becomes
 * eternal. Every other 'is this card parked' check must agree on the same
 * threshold, or the SQL sweep and TS guards can silently drift.
 * parseAsUtcMs treats a timestamp with no 'Z' or UTC offset as UTC: a bare
 * SQLite datetime('now') string carries no timezone marker, and Date.parse
 * reads it as local time, shifting the instant by the host's UTC offset on a
 * non-UTC host.
 */
// `Date.parse()` reads a marker-less string as LOCAL time (V8 behaviour) --
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
 * The same operator who parked a card may still archive it -- the park is their
 * own decision to reverse, not a lock on themselves.
 * Keyed on actorOperatorId (the cryptographically-resolved operator id), never
 * the free-text by field, since two different operators could each sign a write
 * with by='deck'.
 * actorOperatorId undefined (an ordinary agent write) always refuses while
 * parked -- fail-closed by construction, not an extra null check.
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

// locked_by alone is insufficient: peer_id is unique only per group
// (UNIQUE(peer_id, group_id)), so a homonym peer in a different group could
// satisfy the guard meant for the real owner -- locked_group completes that
// composite key.
// Stored raw, not as a digest: bun:sqlite has no SQL scalar-function
// registration, and the owner-gone sweep's correlated peers join needs a plain
// SQL comparison across rows.
// locked_group is computeGroupId(secret), half of the group's auth secret hash
// -- it is exposed to every group listing the roadmap, not merely public by
// accident, except the 'default' group whose secret_hash is null.

/**
 * existingLockedGroup === null is a migration state (a row predating this
 * column) and fails open, degrading to a peer_id-only comparison rather than
 * refusing the true owner their own card.
 * Self-heals only on an actual claim (resolveRoadmapLock's claimed: true),
 * never on an ordinary write to an already-locked row from anyone, including
 * its own owner.
 * byLockedGroup === null (an unresolved claim, no instance_token) is not given
 * the same benefit once existingLockedGroup is known -- a resolved real owner
 * never loses to an unresolved claim of the same peer_id string.
 */
export function matchesLockOwner(
  existingLockedBy: string | null,
  existingLockedGroup: string | null,
  by: string,
  byLockedGroup: string | null
): boolean {
  if (existingLockedBy === null || existingLockedBy !== by) return false;
  if (existingLockedGroup === null) return true;
  return existingLockedGroup === byLockedGroup;
}
