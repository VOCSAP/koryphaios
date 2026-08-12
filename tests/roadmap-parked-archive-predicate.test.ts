// Card aaf4537d: shared/roadmap-lock.ts's refusesParkedArchive (and its
// isParked() helper) are pure modules -- no broker, no server, no I/O -- so
// they are truth-tabled directly here, same precedent as
// tests/roadmap-lock.test.ts for resolveRoadmapLock and
// tests/roadmap-append.test.ts for shared/roadmap-append.ts.
//
// Named tests/roadmap-*.test.ts (not tests/broker-roadmap-*.test.ts)
// deliberately: the CI workflow (.github/workflows/desktop-build.yml) collects
// `tests/roadmap-*.test.ts` in its pure-modules step, and no file under that
// prefix spawns a broker (measured: `grep -l startBroker tests/roadmap-*.test.ts`
// returns nothing) -- this file keeps that discipline, no startBroker here.
// The production-wiring proof (does broker.ts's handleRoadmapArchive actually
// CALL this predicate) lives in tests/broker-roadmap-parked-archive.test.ts,
// which needs a live broker and is therefore local-only, same exclusion as
// tests/broker-roadmap-inactive.test.ts documents in its own header.
//
// Six enumerable lock states for a card reaching /roadmap/archive: free,
// held-by-caller, held-by-another-peer, parked, parked-and-immune (fresh),
// parked-and-expired. refusesParkedArchive only speaks to the parked family
// (the held/free split is a DIFFERENT guard, the locked_by check right above
// it in handleRoadmapArchive -- see broker.ts:2762, out of scope here and
// covered by tests/broker-roadmap-lock.test.ts's 409 lock-guard tests). Of
// the parked family this file exercises: parked+same-operator (allowed),
// parked+different-operator (refused), parked+unsigned write (refused,
// fail-closed), parked-but-expired+different-operator (allowed, isParked
// flips to false) -- four of the six overall states, the two park-relevant
// branches (fresh vs expired) each crossed with the three actor shapes that
// matter (same operator, different operator, no operator).
import { test, expect } from "bun:test";
import { isParked, refusesParkedArchive } from "../shared/roadmap-lock.ts";

const NOW = "2026-08-13T12:00:00.000Z";
const TTL_SEC = 86_400; // LOCK_PARK_TTL_SEC default, per broker.ts:174-176

// ---------------------------------------------------------------------------
// isParked: the building block refusesParkedArchive delegates to.
// ---------------------------------------------------------------------------

test("isParked: null parkedAt reads as unparked", () => {
  expect(isParked(null, NOW, TTL_SEC)).toBe(false);
});

test("isParked: parkedAt just inside the TTL window reads as parked", () => {
  const parkedAt = new Date(Date.parse(NOW) - (TTL_SEC - 1) * 1000).toISOString();
  expect(isParked(parkedAt, NOW, TTL_SEC)).toBe(true);
});

test("isParked: parkedAt just past the TTL window reads as unparked (expired)", () => {
  const parkedAt = new Date(Date.parse(NOW) - (TTL_SEC + 1) * 1000).toISOString();
  expect(isParked(parkedAt, NOW, TTL_SEC)).toBe(false);
});

// ---------------------------------------------------------------------------
// refusesParkedArchive truth table.
// ---------------------------------------------------------------------------

test.each([
  // [name, parkedBy, parkedAt, actorOperatorId, expectedRefusal]
  [
    "unparked card: archive never refused by this predicate, regardless of actor",
    null,
    null,
    "operator-a",
    false,
  ],
  [
    "parked, archived by the SAME operator who parked it: allowed (their own decision to reverse)",
    "operator-a",
    NOW,
    "operator-a",
    false,
  ],
  [
    "parked, archived by a DIFFERENT operator: refused",
    "operator-a",
    NOW,
    "operator-b",
    true,
  ],
  [
    "parked, archived by an ordinary agent write with no operator signature at all: refused, fail-closed",
    "operator-a",
    NOW,
    undefined,
    true,
  ],
  [
    "parked but past LOCK_PARK_TTL_SEC (expired 1s ago), archived by a different operator: allowed, park no longer live",
    "operator-a",
    new Date(Date.parse(NOW) - (TTL_SEC + 1) * 1000).toISOString(),
    "operator-b",
    false,
  ],
  [
    "parked but expired, archived by the ORIGINAL parking operator: allowed (both isParked=false and same-operator would allow it)",
    "operator-a",
    new Date(Date.parse(NOW) - (TTL_SEC + 1) * 1000).toISOString(),
    "operator-a",
    false,
  ],
] as const)("refusesParkedArchive: %s", (_name, parkedBy, parkedAt, actorOperatorId, expected) => {
  expect(refusesParkedArchive(parkedBy, parkedAt, NOW, TTL_SEC, actorOperatorId)).toBe(expected);
});

// ---------------------------------------------------------------------------
// Fail-open axis (roadmap-lock.ts:130-141): the predicate takes
// actorOperatorId, the cryptographically-resolved operator_id -- NEVER the
// free-text `by` field. Two DIFFERENT operators can each sign a write with
// by='deck'; if a future edit swapped the comparison to `by`, this specific
// case would silently flip from refused to allowed. The predicate itself
// only takes operator_id strings, so this test picks two operator_id values
// that are deliberately DIFFERENT while modeling what `by` would have been
// for both (a single shared string) -- proving the refusal survives on the
// operator_id axis even when the by-axis collapses to one value.
// ---------------------------------------------------------------------------

test("fail-open guard: two operators both writing as by='deck' are still distinguished by operator_id, not conflated", () => {
  const parkedByOperatorA = "operator-id-digest-A";
  const archivingActorOperatorB = "operator-id-digest-B";
  // Both would carry by === 'deck' in the real request body -- refusesParkedArchive
  // never sees `by` at all, only these two operator_id strings.
  expect(refusesParkedArchive(parkedByOperatorA, NOW, NOW, TTL_SEC, archivingActorOperatorB)).toBe(
    true
  );
});
