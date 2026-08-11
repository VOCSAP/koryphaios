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
import { resolveRoadmapLock } from "../shared/roadmap-lock.ts";

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
    { locked: false, lockedBy: null },
  ],
  [
    "explicit locked:true claims for the caller while in_progress",
    UNLOCKED,
    "in_progress",
    { locked: true },
    "claimant",
    { locked: true, lockedBy: "claimant" },
  ],
  [
    "explicit locked:false releases while in_progress, even from a non-owner",
    LOCKED_BY_OWNER,
    "in_progress",
    { locked: false },
    "intruder",
    { locked: false, lockedBy: null },
  ],
  [
    "implicit claim: non-deck author writing status=in_progress on an unlocked item claims it",
    UNLOCKED,
    "in_progress",
    { status: "in_progress" },
    "claimant",
    { locked: true, lockedBy: "claimant" },
  ],
  [
    "no implicit claim for 'deck': the item stays unlocked (submitted, not started)",
    UNLOCKED,
    "in_progress",
    { status: "in_progress" },
    "deck",
    { locked: false, lockedBy: null },
  ],
  [
    "already locked, same-status write with no explicit locked field: no-op, resolves to the existing state (zero delta)",
    LOCKED_BY_OWNER,
    "in_progress",
    { status: "in_progress" },
    "intruder",
    { locked: true, lockedBy: "owner-peer" },
  ],
  [
    "already locked, unrelated field only (no status, no locked): no-op, resolves to the existing state",
    LOCKED_BY_OWNER,
    "in_progress",
    {},
    "owner-peer",
    { locked: true, lockedBy: "owner-peer" },
  ],
  [
    "leaving in_progress takes precedence over an explicit locked:true claim in the same body",
    UNLOCKED,
    "done",
    { locked: true },
    "claimant",
    { locked: false, lockedBy: null },
  ],
  [
    "'deck' can still explicitly claim the lock via locked:true (only the IMPLICIT claim on a bare status write skips deck)",
    UNLOCKED,
    "in_progress",
    { locked: true },
    "deck",
    { locked: true, lockedBy: "deck" },
  ],
  [
    "an explicit locked:true from an intruder overwrites the existing owner -- the delta clause bites on the claim side too, not just release",
    LOCKED_BY_OWNER,
    "in_progress",
    { locked: true },
    "intruder",
    { locked: true, lockedBy: "intruder" },
  ],
] as const)("resolveRoadmapLock: %s", (_name, existing, nextStatus, body, by, expected) => {
  const result = resolveRoadmapLock(existing, nextStatus, body, by);
  expect(result).toEqual(expected);
});
