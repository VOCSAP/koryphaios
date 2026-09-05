// The banner strip is a single fixed bar over four overlapping states, so the
// PRIORITY between them is the whole behaviour: the moment a replica's upstream
// comes back, the offline state clears and the conflicts it produced appear, in
// the same broadcast. Before this, the only banner was the offline one, so the
// reconnection read as "everything is fine" exactly when arbitration was due.

import { expect, test } from "bun:test";
import { bannerKind } from "../desktop/src/shared/status-banner.ts";
import type { RoadmapSyncStatus } from "../desktop/src/shared/types.ts";

const LOCAL: RoadmapSyncStatus = { mode: "local" };

function input(over: Partial<Parameters<typeof bannerKind>[0]> = {}) {
  return { brokerUp: true, brokerDismissed: false, conflicts: 0, status: LOCAL, ...over };
}

// ----- nothing to say -----

test("a healthy local Deck raises no banner at all", () => {
  expect(bannerKind(input())).toBeNull();
});

test("a broker whose state is still unknown raises no banner", () => {
  expect(bannerKind(input({ brokerUp: null }))).toBeNull();
});

test("a replica whose upstream is online and clean raises no banner", () => {
  expect(
    bannerKind(input({ status: { mode: "replica", online: true, pending_push: 4 } }))
  ).toBeNull();
});

// ----- each state alone -----

test("the local broker being down raises the outage banner", () => {
  expect(bannerKind(input({ brokerUp: false }))).toBe("broker-down");
});

test("conflicts of this project raise the arbitration banner", () => {
  expect(bannerKind(input({ conflicts: 2 }))).toBe("conflicts");
});

test("refusals on a live link raise the refused banner", () => {
  expect(
    bannerKind(input({ status: { mode: "replica", online: true, refused: 3 } }))
  ).toBe("refused");
});

test("an unreachable upstream raises the offline banner", () => {
  expect(
    bannerKind(input({ status: { mode: "replica", online: false, pending_push: 7 } }))
  ).toBe("replica-offline");
});

// ----- the ladder -----

test("the outage outranks conflicts, refusals and the offline state at once", () => {
  expect(
    bannerKind(
      input({
        brokerUp: false,
        conflicts: 5,
        status: { mode: "replica", online: false, refused: 2 },
      })
    )
  ).toBe("broker-down");
});

test("conflicts outrank refusals and the offline state", () => {
  expect(
    bannerKind(input({ conflicts: 1, status: { mode: "replica", online: false, refused: 9 } }))
  ).toBe("conflicts");
});

test("refusals outrank the offline state only while the link is up", () => {
  // online:false + refused:>0 is the state of a replica that went offline
  // holding refusals: the outage is what the operator has to know first.
  expect(
    bannerKind(input({ status: { mode: "replica", online: false, refused: 4 } }))
  ).toBe("replica-offline");
});

test("the reconnection swaps the offline banner for the conflicts one", () => {
  const offline = input({ status: { mode: "replica", online: false, pending_push: 3 } });
  expect(bannerKind(offline)).toBe("replica-offline");
  // Same tick as the link returning: conflicts land, `online` flips.
  expect(
    bannerKind({ ...offline, conflicts: 2, status: { mode: "replica", online: true } })
  ).toBe("conflicts");
});

// ----- dismissal -----

test("dismissing the outage silences the whole strip, not just the red bar", () => {
  // A conflict cannot be arbitrated through a broker that does not answer, so
  // promoting the arbitration banner here would offer a guaranteed failure.
  expect(bannerKind(input({ brokerUp: false, brokerDismissed: true, conflicts: 3 }))).toBeNull();
});

test("a dismissal does not silence anything once the broker is back", () => {
  expect(bannerKind(input({ brokerDismissed: true, conflicts: 3 }))).toBe("conflicts");
});

// ----- the inert defaults of an unreadable status -----

test("an unreadable status (the sanitizer's { mode: 'local' } fallback) raises nothing", () => {
  // sanitizeSyncStatus answers exactly this on a broker whose reply could not
  // be read: no mode, no online, no counters -> no banner invented.
  expect(bannerKind(input({ status: { mode: "local" } }))).toBeNull();
});

test("a refusal counter with no link state is not read as a healthy link", () => {
  expect(bannerKind(input({ status: { mode: "replica", refused: 5 } }))).toBeNull();
});

test("a replica reporting zero refusals while online raises nothing", () => {
  expect(
    bannerKind(input({ status: { mode: "replica", online: true, refused: 0 } }))
  ).toBeNull();
});

test("an offline non-replica broker cannot raise the replica banner", () => {
  // `online` is a replica-only field: a local broker reporting it must not
  // make the Deck claim an upstream it has none of.
  expect(bannerKind(input({ status: { mode: "local", online: false } }))).toBeNull();
});
