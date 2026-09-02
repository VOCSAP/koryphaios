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

// refusesParkedArchive takes the cryptographically-resolved operator_id, never
// the free-text `by` field, so two operators both writing as by='deck' stay
// distinguished rather than conflated.

test("fail-open guard: two operators both writing as by='deck' are still distinguished by operator_id, not conflated", () => {
  const parkedByOperatorA = "operator-id-digest-A";
  const archivingActorOperatorB = "operator-id-digest-B";
  // Both would carry by === 'deck' in the real request body -- refusesParkedArchive
  // never sees `by` at all, only these two operator_id strings.
  expect(refusesParkedArchive(parkedByOperatorA, NOW, NOW, TTL_SEC, archivingActorOperatorB)).toBe(
    true
  );
});
