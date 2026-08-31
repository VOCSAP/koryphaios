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
  /**
   * Card e344fa79, review round 2: true exactly when THIS call is what set
   * `lockedBy` to `by` below -- an explicit `locked:true`, or the implicit
   * claim on a fresh (`!existing.locked`) status=in_progress write. False on
   * every other outcome, including: a release; the SAME owner re-sending
   * status=in_progress while ALREADY locked (the branch below requires
   * `!existing.locked`, so it does not re-fire and `lockedBy` merely reads
   * back unchanged); and any write from a third party that the lock guard
   * let through because it touches no lock-relevant field at all.
   *
   * This exists because `lockedBy === existing.locked_by` is NOT the same
   * question as "did this write claim the lock" -- it can be true for
   * exactly the wrong reason (nothing changed) as well as the right one
   * (a genuine reclaim). A caller that used the bare equality to decide
   * whether to refresh a value naming the CURRENT WRITER (locked_at,
   * locked_group) got it backwards: an ordinary third-party write on an
   * already-locked row leaves `lockedBy` reading the SAME name it already
   * held (nobody claimed anything), which is indistinguishable from a real
   * reclaim under bare equality, but the two must be treated oppositely by
   * anything that stamps the CURRENT AUTHOR's own identity. `claimed` names
   * the actual event a caller needs: did resolveRoadmapLock's OWN claim
   * branch execute this time.
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
 * Card e344fa79, review round 2: what `handleRoadmapUpsert` stores into
 * `locked_group` for THIS write, extracted into its own pure function (same
 * reason `resolveRoadmapLock` itself was extracted -- broker.ts exports
 * nothing and cannot be unit-tested directly) after review found the first
 * inline version keyed on the wrong signal (`existing.locked_by ===
 * resolvedLock.lockedBy`, a same-NAME check that reads "same owner" on an
 * ORDINARY write from anyone, since `resolvedLock.lockedBy` merely reads
 * back unchanged when nothing was claimed -- see
 * RoadmapLockResolution.claimed's doc comment for the full shape of that
 * bug). `authorLockedGroup` is only ever consulted when `claimed` is true:
 * a non-claiming write never has standing to stamp the CURRENT caller's own
 * group onto a lock it did not touch.
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
 * Card 4441e883, mecanisme B: `locked_by_token`'s own resolver -- same
 * claimed-only discipline as `resolveLockedGroup` right above (a non-
 * claiming write to an already-locked row must preserve the real owner's
 * proven token, never overwrite it with the current writer's own, or with
 * null if the current writer has none). `authorInstanceToken` is
 * `RoadmapAuthor.instance_token` (broker.ts), `undefined` for any author
 * resolveRoadmapAuthor could not prove via a real token -- normalized to
 * `null` here, same as `resolveLockedGroup` normalizes a missing
 * `author.group_id`. NEVER derived from `by` or from `authorLockedGroup`:
 * see `RoadmapItem.locked_by_token`'s doc comment for why this column must
 * stay NULL rather than guess.
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
 * Card e344fa79, review round 2: `locked_at`'s sibling to
 * `resolveLockedGroup` above -- same bug, one column over (team-lead review:
 * "la meme faute une colonne plus loin"). Keying `keptLockedAt` on the same
 * bare peer_id-name comparison would refresh `locked_at` to "now" on every
 * ORDINARY third-party write to an already-locked card, not only on an
 * actual (re-)claim.
 */
export function resolveKeptLockedAt(
  resolvedLock: Pick<RoadmapLockResolution, "locked" | "claimed">,
  existingLockedAt: string | null
): string | null {
  return resolvedLock.locked && !resolvedLock.claimed ? existingLockedAt : null;
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

// Card e344fa79: peers.peer_id is unique only PER GROUP (schema declares
// UNIQUE(peer_id, group_id)), but the roadmap is shared ACROSS groups on the
// same broker -- comparing a bare `locked_by` peer_id against `by` lets a
// legitimately-registered homonym peer in a DIFFERENT group satisfy the
// work-lock guard meant for the real owner. `locked_group` completes the
// composite key the schema already declares.
//
// Stored RAW, not as a digest (team-lead arbitration, reversing an initial
// digest-based design once bun:sqlite was measured to have no SQL scalar-
// function registration -- a digest is not computable inline by the owner-
// gone sweep's correlated `peers` join, which needs a plain SQL comparison
// across many rows, not a value already resolved in JS for one). The leak
// this once guarded against (a raw group_id reaching every group that lists
// the roadmap, via broker.ts's rowToRoadmapItem) is not CLOSED by the
// pick-list -- it is AUTHORIZED by it: the pick-list explicitly NAMES
// `locked_group`, and `/roadmap/list` requires only `project_key`, no group
// membership or instance_token. What the pick-list closes is the accidental
// half (a value public only because nothing yet stopped a `...row` spread
// from carrying it) -- it does not make this field non-public. Measured
// (shared/config.ts): `locked_group` IS `computeGroupId(secret)`, the first
// 32 hex chars (128 bits) of the same sha256 digest `computeGroupSecretHash`
// returns in full (64 hex chars) for the broker's own TOFU validation --
// half of a group's auth secret hash, not an opaque id, EXCEPT for the
// 'default' group, whose id is the literal string "default" and whose
// secret_hash is NULL (both functions special-case a null secret), so there
// is no hash for this to be half of in that one case. Reviewed and accepted
// as pre-existing (shipped in 09bccfd): a truncated 128-bit residual is not
// exploitable. Deck-side, the only two current consumers of this field are
// `sanitizeRoadmapItem` (desktop/src/main/roadmap-service.ts) and
// `ownsIdleLock` (desktop/src/main/idle-lock.ts) -- re-measure this list
// rather than trusting it, since a future consumer widening the field's
// exposure would not fail anything here.

/**
 * True when `by` (the claimed author of THIS write) is the same peer that
 * holds the recorded lock, resolving the OBJECT's owner first (CLAUDE.md:
 * "resolve the object first, then ask whether this caller may act on it").
 *
 * `existingLockedGroup === null` is a MIGRATION state (a row locked before
 * this column existed, or a legacy call site that never populated it), and
 * fails OPEN -- it degrades to the old peer_id-only comparison rather than
 * refusing the true owner their own card, because a NULL here by
 * construction PRE-DATES any accident this guard exists to close, and a
 * fail-closed reading would make an old lock unreleasable by its own holder.
 *
 * SELF-HEALS ONLY ON AN ACTUAL CLAIM, NOT ON EVERY WRITE FROM THE REAL OWNER
 * (card e344fa79, review round 2 -- an earlier version of this comment
 * overclaimed "self-heals the moment the real owner writes again", which was
 * FALSE: a NULL `locked_group` is not touched by an ORDINARY write on an
 * already-locked row, from anyone, including its own owner -- see
 * `RoadmapLockResolution.claimed`'s doc comment). The healing write is
 * specifically one where `resolveRoadmapLock` resolves `claimed: true` --
 * an explicit `locked:true`, or the implicit claim on a fresh
 * (`!existing.locked`) status=in_progress write -- because `handleRoadmapUpsert`
 * stamps `locked_group` from the CURRENT author's own resolved group
 * exactly on that event, never on an unrelated or re-sent write that leaves
 * `lockedBy` merely reading back unchanged.
 *
 * `byLockedGroup === null` (the caller's own group could not be resolved --
 * an unproven claim with no instance_token, or an operator/deck-signed write,
 * which has no peer row at all) is NOT given the same benefit once
 * `existingLockedGroup` is known: a real, group-resolved owner must not lose
 * to an unresolved claim of the same peer_id string.
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
