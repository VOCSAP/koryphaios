// PLAN-observabilite-erreurs O5: broker reachability tracker feeding the
// Deck's red banner (desktop/src/main/broker-client.ts).

import { test, expect } from "bun:test";
import { BrokerHealthTracker } from "../desktop/src/main/broker-client";
import type { BrokerStatusEvent } from "../desktop/src/main/broker-client";

function make(threshold = 2): {
  tracker: BrokerHealthTracker;
  events: BrokerStatusEvent[];
  tick: () => void;
} {
  const events: BrokerStatusEvent[] = [];
  let clock = 1000;
  const tracker = new BrokerHealthTracker((s) => events.push(s), threshold, () => (clock += 1));
  return { tracker, events, tick: () => clock++ };
}

test("starts up; a single failure does not flip (hysteresis)", () => {
  const { tracker, events } = make();
  expect(tracker.status.up).toBe(true);
  tracker.recordFailure(new Error("ECONNREFUSED"));
  expect(tracker.status.up).toBe(true);
  expect(events).toEqual([]);
});

test("threshold consecutive failures flip down once, with the opening error", () => {
  const { tracker, events } = make();
  tracker.recordFailure(new Error("boom-1"));
  tracker.recordFailure(new Error("boom-2"));
  tracker.recordFailure(new Error("boom-3"));

  expect(tracker.status.up).toBe(false);
  expect(tracker.status.lastError).toBe("boom-2");
  // Only ONE transition event despite three failures.
  expect(events.length).toBe(1);
  expect(events[0]!.up).toBe(false);
});

test("a success in between resets the failure streak", () => {
  const { tracker, events } = make();
  tracker.recordFailure(new Error("blip"));
  tracker.recordSuccess();
  tracker.recordFailure(new Error("blip"));
  expect(tracker.status.up).toBe(true);
  expect(events).toEqual([]);
});

test("one success flips back up and clears lastError", () => {
  const { tracker, events } = make();
  tracker.recordFailure(new Error("down"));
  tracker.recordFailure(new Error("down"));
  tracker.recordSuccess();

  expect(tracker.status.up).toBe(true);
  expect(tracker.status.lastError).toBeNull();
  expect(events.length).toBe(2);
  expect(events.map((e) => e.up)).toEqual([false, true]);
  // The transition timestamps move forward.
  expect(events[1]!.since).toBeGreaterThan(events[0]!.since);
});

test("non-Error failures are stringified", () => {
  const { tracker } = make();
  tracker.recordFailure("http 500");
  tracker.recordFailure("http 500");
  expect(tracker.status.lastError).toBe("http 500");
});
