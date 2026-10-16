// The banner strip renders one state, so its priority must preserve the operator's next action.

import { expect, test } from "bun:test";
import { bannerKind, replicaOfflineTextKey } from "../desktop/src/shared/status-banner.ts";
import type { RoadmapSyncStatus } from "../desktop/src/shared/types.ts";

const LOCAL: RoadmapSyncStatus = { mode: "local" };

function input(
  over: Partial<Parameters<typeof bannerKind>[0]> = {}
): Parameters<typeof bannerKind>[0] {
  return {
    brokerManualStop: false,
    brokerUp: true,
    brokerDismissed: false,
    operatorTrust: "compatible",
    conflicts: 0,
    status: LOCAL,
    ...over
  };
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

test("a manual stop outranks every other state, the outage it causes included", () => {
  expect(bannerKind(input({ brokerManualStop: true }))).toBe("broker-stopped");
  expect(
    bannerKind(
      input({
        brokerManualStop: true,
        brokerUp: false,
        conflicts: 3,
        operatorTrust: "not-trusted",
        status: { mode: "replica", online: false },
      })
    )
  ).toBe("broker-stopped");
});

test("a manual stop cannot be dismissed: the outage dismissal does not hide it", () => {
  expect(bannerKind(input({ brokerManualStop: true, brokerUp: false, brokerDismissed: true }))).toBe("broker-stopped");
});

test("an unconfigured broker raises the operator trust banner", () => {
  expect(bannerKind(input({ operatorTrust: "unconfigured" }))).toBe("operator-unconfigured");
});

test("an untrusted operator raises the operator trust banner", () => {
  expect(bannerKind(input({ operatorTrust: "not-trusted" }))).toBe("operator-not-trusted");
});

test("an incompatible broker raises the operator trust banner", () => {
  expect(bannerKind(input({ operatorTrust: "incompatible" }))).toBe("operator-incompatible");
});

test("an unreadable identity raises the operator trust banner", () => {
  expect(bannerKind(input({ operatorTrust: "identity-unreadable" }))).toBe("operator-identity-unreadable");
});

test("an invalid trust policy raises the operator trust banner", () => {
  expect(bannerKind(input({ operatorTrust: "invalid" }))).toBe("operator-invalid");
});

test("an unreachable trust broker raises the operator trust banner", () => {
  expect(bannerKind(input({ operatorTrust: "unreachable" }))).toBe("operator-unreachable");
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

test("conflicts outrank operator trust, refusals and the offline state", () => {
  expect(
    bannerKind(
      input({
        operatorTrust: "not-trusted",
        conflicts: 5,
        status: { mode: "replica", online: false, refused: 2 },
      })
    )
  ).toBe("conflicts");
});

test("refusals outrank operator trust while the link is up", () => {
  expect(
    bannerKind(
      input({
        operatorTrust: "not-trusted",
        status: { mode: "replica", online: true, refused: 2 },
      })
    )
  ).toBe("refused");
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

// ----- which sentence a replica-offline banner shows (card 7974fb83) -----

test("a transport failure keeps the original 'unreachable' wording", () => {
  expect(replicaOfflineTextKey("transport")).toBe("banner.replicaOffline");
});

test("a stale upstream (404, predates replication) gets its own wording", () => {
  expect(replicaOfflineTextKey("stale_upstream")).toBe("banner.replicaStale");
});

test("an upstream refusing to serve replicas (403) gets its own wording", () => {
  expect(replicaOfflineTextKey("refused")).toBe("banner.replicaRefused");
});

test("an absent or null reason (an older broker, or a status never yet published) falls back to 'unreachable'", () => {
  expect(replicaOfflineTextKey(null)).toBe("banner.replicaOffline");
  expect(replicaOfflineTextKey(undefined)).toBe("banner.replicaOffline");
});
