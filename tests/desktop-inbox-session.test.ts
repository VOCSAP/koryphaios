// Pins two rules from desktop/src/main/index.ts, untestable directly since
// index.ts imports electron: session_id re-mints on group change, and the local
// journal truncate runs even when the broker purge throws.

import { test, expect } from "bun:test";
import {
  createInboxSessionTracker,
  purgeInboxSessionCore,
  classifyInboxDeleteIds,
} from "../desktop/src/main/inbox-session.ts";

// --- createInboxSessionTracker -----------------------------------------

test("currentInboxSessionId returns the SAME id across calls when the group does not change", () => {
  const current = createInboxSessionTracker(() => "group-A");
  const first = current();
  const second = current();
  const third = current();
  expect(second).toBe(first);
  expect(third).toBe(first);
});

test("currentInboxSessionId re-mints a DIFFERENT id when the group changes", () => {
  let groupId = "group-A";
  const current = createInboxSessionTracker(() => groupId);
  const beforeSwitch = current();

  groupId = "group-B";
  const afterSwitch = current();
  expect(afterSwitch).not.toBe(beforeSwitch);

  // Switching back is itself a switch -- a THIRD distinct id, not a return to
  // the first (nothing here should special-case "seen this group before").
  groupId = "group-A";
  const afterSwitchBack = current();
  expect(afterSwitchBack).not.toBe(beforeSwitch);
  expect(afterSwitchBack).not.toBe(afterSwitch);

  // And it stabilizes again once the group stops changing.
  expect(current()).toBe(afterSwitchBack);
});

test("two independently created trackers never share state", () => {
  const trackerA = createInboxSessionTracker(() => "group-A");
  const trackerB = createInboxSessionTracker(() => "group-A");
  // Vanishingly unlikely to collide by chance (randomUUID); this asserts
  // independence of the closures, not merely "different by construction".
  expect(trackerA()).not.toBe(trackerB());
});

// --- purgeInboxSessionCore -----------------------------------------------

test("purgeInboxSessionCore calls clearLocal exactly once when purgeBroker succeeds, and never calls onPurgeError", async () => {
  let clearLocalCalls = 0;
  let onPurgeErrorCalls = 0;
  await purgeInboxSessionCore({
    purgeBroker: async () => {},
    clearLocal: () => {
      clearLocalCalls++;
    },
    onPurgeError: () => {
      onPurgeErrorCalls++;
    },
  });
  expect(clearLocalCalls).toBe(1);
  expect(onPurgeErrorCalls).toBe(0);
});

test("purgeInboxSessionCore still calls clearLocal exactly once when purgeBroker REJECTS, and reports via onPurgeError", async () => {
  let clearLocalCalls = 0;
  let reportedError: unknown = null;
  const boom = new Error("broker unreachable");
  await purgeInboxSessionCore({
    purgeBroker: async () => {
      throw boom;
    },
    clearLocal: () => {
      clearLocalCalls++;
    },
    onPurgeError: (e) => {
      reportedError = e;
    },
  });
  expect(clearLocalCalls).toBe(1);
  expect(reportedError).toBe(boom);
});

// --- classifyInboxDeleteIds ------------------------------------------------

test("classifyInboxDeleteIds: a genuinely empty input is a 0-effect no-op, not rejected", () => {
  expect(classifyInboxDeleteIds([])).toEqual({ valid: [], rejected: false });
});

test("classifyInboxDeleteIds: a non-array payload behaves like empty input, not rejected", () => {
  expect(classifyInboxDeleteIds(null)).toEqual({ valid: [], rejected: false });
  expect(classifyInboxDeleteIds(undefined)).toEqual({ valid: [], rejected: false });
  expect(classifyInboxDeleteIds("5")).toEqual({ valid: [], rejected: false });
  expect(classifyInboxDeleteIds({ id: 5 })).toEqual({ valid: [], rejected: false });
});

test("classifyInboxDeleteIds: a MIXED array keeps the valid integers and drops the rest, not rejected", () => {
  expect(classifyInboxDeleteIds([5, "x", 7, 5.5, Infinity])).toEqual({
    valid: [5, 7],
    rejected: false,
  });
});

test("classifyInboxDeleteIds: an ALL-INVALID non-empty array is rejected, valid stays empty", () => {
  expect(classifyInboxDeleteIds(["a", "b"])).toEqual({ valid: [], rejected: true });
  expect(classifyInboxDeleteIds([NaN])).toEqual({ valid: [], rejected: true });
  expect(classifyInboxDeleteIds([5.5, Infinity, -Infinity])).toEqual({ valid: [], rejected: true });
});
