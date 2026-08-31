// Card e7b364dc, Part B: shared/roadmap-lock.ts is a pure module (no broker,
// no server, no I/O) so resolveRoadmapLock is truth-tabled directly here,
// no HTTP harness needed -- same precedent as tests/roadmap-append.test.ts
// for shared/roadmap-append.ts.
//
// Named tests/roadmap-*.test.ts (not tests/broker-roadmap-*.test.ts)
// deliberately: the CI workflow (.github/workflows/desktop-build.yml)
// collects `tests/roadmap-*.test.ts` but the whole `broker-*` family is
// excluded from its glob (measured by reading the `bun test` line in that
// workflow) -- a test living only in tests/broker-roadmap-lock.test.ts would
// be green locally and never run in CI. The 409-guard HTTP tests stay in
// tests/broker-roadmap-lock.test.ts (they need a live broker); this file
// covers the pure resolution function that guard now depends on.

import { test, expect } from "bun:test";
import {
  resolveRoadmapLock,
  matchesLockOwner,
  resolveLockedGroup,
  resolveLockedByToken,
  resolveKeptLockedAt,
} from "../shared/roadmap-lock.ts";

type Existing = { locked: boolean; locked_by: string | null };

const UNLOCKED: Existing = { locked: false, locked_by: null };
const LOCKED_BY_OWNER: Existing = { locked: true, locked_by: "owner-peer" };

test.each([
  // [name, existing, nextStatus, body, by, expected]
  [
    "leaving in_progress always releases, regardless of who writes it",
    LOCKED_BY_OWNER,
    "planned",
    {},
    "intruder",
    { locked: false, lockedBy: null, claimed: false },
  ],
  [
    "explicit locked:true claims for the caller while in_progress",
    UNLOCKED,
    "in_progress",
    { locked: true },
    "claimant",
    { locked: true, lockedBy: "claimant", claimed: true },
  ],
  [
    "explicit locked:false releases while in_progress, even from a non-owner",
    LOCKED_BY_OWNER,
    "in_progress",
    { locked: false },
    "intruder",
    { locked: false, lockedBy: null, claimed: false },
  ],
  [
    "implicit claim: non-deck author writing status=in_progress on an unlocked item claims it",
    UNLOCKED,
    "in_progress",
    { status: "in_progress" },
    "claimant",
    { locked: true, lockedBy: "claimant", claimed: true },
  ],
  [
    "no implicit claim for 'deck': the item stays unlocked (submitted, not started)",
    UNLOCKED,
    "in_progress",
    { status: "in_progress" },
    "deck",
    { locked: false, lockedBy: null, claimed: false },
  ],
  [
    "already locked, same-status write with no explicit locked field: no-op, resolves to the existing state (zero delta) -- NOT a claim, card e344fa79 review round 2",
    LOCKED_BY_OWNER,
    "in_progress",
    { status: "in_progress" },
    "intruder",
    { locked: true, lockedBy: "owner-peer", claimed: false },
  ],
  [
    "already locked, unrelated field only (no status, no locked): no-op, resolves to the existing state -- NOT a claim",
    LOCKED_BY_OWNER,
    "in_progress",
    {},
    "owner-peer",
    { locked: true, lockedBy: "owner-peer", claimed: false },
  ],
  [
    "leaving in_progress takes precedence over an explicit locked:true claim in the same body",
    UNLOCKED,
    "done",
    { locked: true },
    "claimant",
    { locked: false, lockedBy: null, claimed: false },
  ],
  [
    "'deck' can still explicitly claim the lock via locked:true (only the IMPLICIT claim on a bare status write skips deck)",
    UNLOCKED,
    "in_progress",
    { locked: true },
    "deck",
    { locked: true, lockedBy: "deck", claimed: true },
  ],
  [
    "an explicit locked:true from an intruder overwrites the existing owner -- the delta clause bites on the claim side too, not just release",
    LOCKED_BY_OWNER,
    "in_progress",
    { locked: true },
    "intruder",
    { locked: true, lockedBy: "intruder", claimed: true },
  ],
] as const)("resolveRoadmapLock: %s", (_name, existing, nextStatus, body, by, expected) => {
  const result = resolveRoadmapLock(existing, nextStatus, body, by);
  expect(result).toEqual(expected);
});

// Card e344fa79: peers.peer_id is unique only PER GROUP (schema declares
// UNIQUE(peer_id, group_id)), but the roadmap is shared across groups on the
// same broker -- a bare `existing.locked_by === by` comparison (the shape
// every guard used before this card) reads a legitimately-registered
// homonym peer in a DIFFERENT group as the SAME owner. matchesLockOwner
// completes that comparison into the composite key the schema already
// declares. `locked_group` stores the group_id RAW (team-lead arbitration,
// reversing an initial digest-based design once bun:sqlite was measured to
// have no SQL scalar-function registration -- see shared/roadmap-lock.ts's
// header comment on this function), so these fixtures use plain group_id
// strings, not a hash of them.

test("matchesLockOwner: THE DEFECT THIS CARD CLOSES -- a same-peer_id homonym registered in a DIFFERENT group must NOT satisfy the lock, even though the OLD bare-peer_id comparison this replaces would have said it did", () => {
  const homonymPeerId = "desktop-7b2civn-koryphaios";
  const trueOwnerGroup = "1457f96c63fc";
  const homonymGroup = "default";

  // The old guard shape (`by !== existing.locked_by`) reduces to exactly this
  // comparison, and it says "same owner" -- this is the accident measured on
  // the roadmap card, reproduced here as the RED half of the proof.
  const oldBarePeerIdCheck = homonymPeerId === homonymPeerId;
  expect(oldBarePeerIdCheck).toBe(true);

  // The GREEN half: the group-aware comparison refuses it.
  expect(matchesLockOwner(homonymPeerId, trueOwnerGroup, homonymPeerId, homonymGroup)).toBe(false);
});

test.each([
  // [name, existingLockedBy, existingLockedGroup, by, byLockedGroup, expected]
  ["unlocked row (no owner) never matches", null, null, "peer-a", "g1", false],
  ["different peer_id never matches, group aside", "peer-a", "g1", "peer-b", "g1", false],
  [
    "legacy row (locked_group NULL, pre-migration) fails OPEN: peer_id alone matches",
    "peer-a",
    null,
    "peer-a",
    "g1",
    true,
  ],
  [
    "legacy row (locked_group NULL) still matches even when the caller's own group could not be resolved",
    "peer-a",
    null,
    "peer-a",
    null,
    true,
  ],
  [
    "same peer_id, same group: matches",
    "peer-a",
    "g1",
    "peer-a",
    "g1",
    true,
  ],
  [
    "same peer_id, different group (the accident): refused",
    "peer-a",
    "g1",
    "peer-a",
    "g2",
    false,
  ],
  [
    "same peer_id, known existing group, but the caller's own group could not be resolved (unproven claim / operator-signed write): refused, not given the benefit of the legacy fail-open",
    "peer-a",
    "g1",
    "peer-a",
    null,
    false,
  ],
  // Card 4441e883, Trou D (team-lead review): a `bun cli.ts` write stamps
  // `by` as `cli:<peer_id>` (cli.ts:348) -- an UNPROVEN author (no
  // instance_token), so on the TOKEN path (resolveLockedByToken) it is
  // already correctly NULL by construction (case 4/5 of that table above:
  // any claim by an author with no instance_token stamps null). This
  // comparator is the OTHER, unrelated half the card asks to be pinned: the
  // DISPLAY comparator (`locked_by`, a plain string column) must treat a
  // 'cli:'-prefixed peer_id as an ORDINARY opaque string, matching itself
  // and refusing a different string, exactly like any other peer_id -- no
  // special-casing of the prefix anywhere in matchesLockOwner. Motivation:
  // `bun cli.ts roadmap-export`'s own census (broker.ts:2517-2518) shows 8
  // peers appearing under BOTH the bare `x` and `cli:x` forms, so the two
  // must never be treated as the same identity by this comparator either.
  [
    "'cli:'-prefixed locked_by matches itself as an ordinary opaque string (same peer_id, same group)",
    "cli:desktop-7b2civn",
    "g1",
    "cli:desktop-7b2civn",
    "g1",
    true,
  ],
  [
    "the bare form and its 'cli:'-prefixed counterpart are NOT the same identity to this comparator -- no prefix-stripping, no special-casing",
    "cli:desktop-7b2civn",
    "g1",
    "desktop-7b2civn",
    "g1",
    false,
  ],
] as const)(
  "matchesLockOwner: %s",
  (_name, existingLockedBy, existingLockedGroup, by, byLockedGroup, expected) => {
    expect(matchesLockOwner(existingLockedBy, existingLockedGroup, by, byLockedGroup)).toBe(expected);
  }
);

// Card e344fa79, review round 2: resolveLockedGroup's own truth table.
// The FIRST fix at this call site (`existing.locked_by ===
// resolvedLock.lockedBy`, a same-NAME check) passed every test written for
// it at the time, including the force-steal case (case 4 below) -- and
// still shipped a NEW instance of this card's own defect on the ORDINARY
// write path (cases 2 and 3), because a name that reads back unchanged is
// not evidence that nothing needs restamping OR that the current writer
// has any claim on the card. `claimed` is the fix: only an ACTUAL claim
// event may stamp the CURRENT caller's own group; every other write
// preserves whatever the row already had, migration NULL included.
test.each([
  // [name, resolvedLock, existingLockedGroup, authorLockedGroup, expected]
  [
    "case 1 -- baseline: same owner (P1/G1), ORDINARY write (not a claim): preserves G1",
    { locked: true, claimed: false },
    "G1",
    "G1",
    "G1",
  ],
  [
    "case 2 -- THE BUG: third party (P2/G2) makes an ORDINARY write (no status/locked field) on a card locked by P1/G1 -- the guard already let this through (nothing lock-relevant moved), so it must NOT stamp the third party's own group over the true owner's",
    { locked: true, claimed: false },
    "G1",
    "G2",
    "G1",
  ],
  [
    "case 3 -- THE WORST BUG: the Deck's routine signed write (by:'deck', no peer row, authorLockedGroup null) on a card locked by P1/G1 -- must NOT null out locked_group on every ordinary save",
    { locked: true, claimed: false },
    "G1",
    null,
    "G1",
  ],
  [
    "case 4 -- force:true steal by a proven homonym (P1/G2), an ACTUAL claim: stamps the intruder's own group",
    { locked: true, claimed: true },
    "G1",
    "G2",
    "G2",
  ],
  [
    "case 5 -- legacy row (locked_group NULL, pre-migration), ORDINARY write: stays NULL, no accidental heal from a write that claimed nothing",
    { locked: true, claimed: false },
    null,
    "G1",
    null,
  ],
  [
    "case 6 -- legacy row (locked_group NULL), the TRUE owner's EXPLICIT reclaim (an ACTUAL claim): heals to the real group -- this is the only event the self-healing promise now covers",
    { locked: true, claimed: true },
    null,
    "G1",
    "G1",
  ],
  [
    "unlocked: always null, claimed or not",
    { locked: false, claimed: false },
    "G1",
    "G2",
    null,
  ],
] as const)(
  "resolveLockedGroup: %s",
  (_name, resolvedLock, existingLockedGroup, authorLockedGroup, expected) => {
    expect(resolveLockedGroup(resolvedLock, existingLockedGroup, authorLockedGroup)).toBe(expected);
  }
);

// resolveKeptLockedAt's sibling table (team-lead review: "la meme faute une
// colonne plus loin") -- same claimed/not-claimed axis, one column over.
test.each([
  ["locked, not claimed: preserves the existing timestamp", { locked: true, claimed: false }, "T0", "T0"],
  ["locked, claimed: stamps fresh (null -> broker.ts's SQL COALESCE(?, datetime('now')))", { locked: true, claimed: true }, "T0", null],
  ["unlocked: always null regardless of claimed", { locked: false, claimed: false }, "T0", null],
] as const)("resolveKeptLockedAt: %s", (_name, resolvedLock, existingLockedAt, expected) => {
  expect(resolveKeptLockedAt(resolvedLock, existingLockedAt)).toBe(expected);
});

// Card 4441e883, mecanisme B: resolveLockedByToken's own truth table --
// same claimed-only discipline as resolveLockedGroup above, one column
// over. The case this table exists to pin is the ONE it must NOT share
// with resolveLockedGroup: an ACTUAL claim from an author with NO proven
// instance_token (an unproven claim, or an operator/deck-signed write)
// must stamp NULL, never fall back to the row's own existing token and
// never guess one from `by` -- "LE BACKFILL NE DEVINE JAMAIS".
test.each([
  [
    "case 1 -- baseline: same proven owner, ORDINARY write (not a claim): preserves the existing token",
    { locked: true, claimed: false },
    "tok-A",
    "tok-A",
    "tok-A",
  ],
  [
    "case 2 -- third party makes an ORDINARY write on a card locked by tok-A -- must NOT stamp the third party's own token over the true owner's",
    { locked: true, claimed: false },
    "tok-A",
    "tok-B",
    "tok-A",
  ],
  [
    "case 3 -- an ACTUAL claim by a proven author: stamps the new owner's token",
    { locked: true, claimed: true },
    "tok-A",
    "tok-B",
    "tok-B",
  ],
  [
    "case 4 -- THE DEFECT THIS COLUMN EXISTS TO CLOSE: an ACTUAL claim by an UNPROVEN author (no instance_token) must stamp NULL, never the row's existing token and never a guess",
    { locked: true, claimed: true },
    "tok-A",
    undefined,
    null,
  ],
  [
    "case 5 -- an operator/deck-signed claim (no peer row, no instance_token): same NULL outcome as case 4",
    { locked: true, claimed: true },
    null,
    undefined,
    null,
  ],
  [
    "case 6 -- legacy row (locked_by_token NULL, pre-migration), ORDINARY write: stays NULL, no accidental heal from a write that claimed nothing",
    { locked: true, claimed: false },
    null,
    "tok-A",
    null,
  ],
  [
    "unlocked: always null, claimed or not",
    { locked: false, claimed: false },
    "tok-A",
    "tok-B",
    null,
  ],
] as const)(
  "resolveLockedByToken: %s",
  (_name, resolvedLock, existingLockedByToken, authorInstanceToken, expected) => {
    expect(resolveLockedByToken(resolvedLock, existingLockedByToken, authorInstanceToken)).toBe(expected);
  }
);
