// index.ts imports electron and cannot be unit-tested directly; this suite
// covers the pure predicate (idle-lock.ts) it delegates to, and pins the
// computeGroupId duplicate between scope.ts and shared/config.ts that
// predicate's caller relies on.

import { test, expect } from "bun:test";
import { ownsIdleLock } from "../desktop/src/main/idle-lock.ts";
import { computeScope } from "../desktop/src/main/scope.ts";
import { computeGroupId } from "../shared/config.ts";

// ---------------------------------------------------------------------------
// 1. ownsIdleLock -- the predicate itself.
// ---------------------------------------------------------------------------

test("same peerId, same group: release is allowed", () => {
  expect(ownsIdleLock("peer-a", "group-1", "peer-a", "group-1")).toBe(true);
});

test("THE BUG THIS CLOSES: same peerId, DIFFERENT group -- release refused", () => {
  // Two groups on the same broker can legitimately register the same
  // peer_id (peers.UNIQUE is (peer_id, group_id), not peer_id alone). A
  // Deck in "group-1" must not treat a peer_id match in "group-2" as its own
  // idle tile's lock.
  expect(ownsIdleLock("peer-a", "group-2", "peer-a", "group-1")).toBe(false);
});

test("fail-closed: locked_group === null never auto-releases, regardless of peerId match", () => {
  // A pre-migration row (locked before this column existed) or an otherwise
  // unresolved owner group. This is the OPPOSITE of the broker's own
  // matchesLockOwner, which fails open on this same null -- deliberate
  // asymmetry: skipping this Deck's opportunistic sweep costs nothing (the
  // broker's TTL + owner-gone sweep still owns the row), releasing a lock
  // nobody could positively attribute to this group would be the expensive
  // silent mistake.
  expect(ownsIdleLock("peer-a", null, "peer-a", "group-1")).toBe(false);
  expect(ownsIdleLock("peer-a", null, "peer-a", "")).toBe(false);
});

test("different peerId: refused regardless of group", () => {
  expect(ownsIdleLock("peer-a", "group-1", "peer-b", "group-1")).toBe(false);
});

test("null locked_by: refused (nothing to match against)", () => {
  expect(ownsIdleLock(null, "group-1", "peer-a", "group-1")).toBe(false);
});

// ---------------------------------------------------------------------------
// 2. CALL-SITE mutation proof, since index.ts (the real caller) is not
//    bun-testable: replay the PRE-FIX predicate (bare peer_id comparison,
//    group-blind) against the same fixture the bug describes, and show it
//    would have wrongly allowed the release the fix now refuses. This is
//    the mutation asked for -- "remove the group check" -- expressed as a
//    standalone function so its red/green is visible without touching
//    index.ts (which cannot be executed under bun at all).
// ---------------------------------------------------------------------------

/** The exact pre-fix predicate: `s.peerId === item.locked_by`, group-blind. */
function preFixOwnsIdleLock(itemLockedBy: string | null, candidatePeerId: string): boolean {
  return itemLockedBy === candidatePeerId;
}

test("MUTATION PROOF: the pre-fix bare peerId comparison wrongly allows the cross-group release", () => {
  const itemLockedBy = "peer-a";
  const itemLockedGroup = "group-2"; // owned by a DIFFERENT group
  const candidatePeerId = "peer-a"; // this Deck's own idle tile, homonym peer_id
  const activeGroupId = "group-1"; // this Deck's own group

  // RED under the real fix:
  expect(ownsIdleLock(itemLockedBy, itemLockedGroup, candidatePeerId, activeGroupId)).toBe(false);
  // The bug: the OLD call site (bare peer_id compare) says yes on the exact
  // same fixture -- this is the line that used to sit in index.ts's
  // watchIdleLocks before this fix, replayed here because index.ts itself
  // cannot be executed under bun.
  expect(preFixOwnsIdleLock(itemLockedBy, candidatePeerId)).toBe(true);
});

// ---------------------------------------------------------------------------
// 3. computeGroupId equality pin (constraint 2 of the LOT D1 brief): scope.ts
//    keeps its OWN internal copy of computeGroupId ("mirrors shared/config.ts
//    computeGroupId" per its own doc comment) rather than importing the
//    shared one. computeScope's returned `groupId` is the only externally
//    observable output of that internal copy, so comparing it against the
//    real shared/config.ts computeGroupId on the same input is what pins the
//    two algorithms together -- a future divergence turns this red instead of
//    silently making ownsIdleLock's activeGroupId comparison a permanent,
//    unnoticed no-op (scope.ts's groupId would stop matching what a peer
//    actually registers with under the shared algorithm).
// ---------------------------------------------------------------------------

test("scope.ts's internal computeGroupId matches shared/config.ts's computeGroupId on the same input", () => {
  const scopeInput = "team-alpha";
  const scope = computeScope("/home/u/proj", scopeInput);
  expect(scope.groupId).toBe(computeGroupId(scopeInput));
});

test("the equality pin holds for a second, distinct input too (not a fluke of one value)", () => {
  const scopeInput = "another-distinct-fixture-value";
  const scope = computeScope("/home/u/proj", scopeInput);
  expect(scope.groupId).toBe(computeGroupId(scopeInput));
});
