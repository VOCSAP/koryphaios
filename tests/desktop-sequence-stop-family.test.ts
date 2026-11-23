import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { STOP_FAMILIES, stopFamily } from "../desktop/src/renderer/src/sequence-stop-family.ts";

const FAULTS = [
  "turn-error",
  "turn-refused",
  "compact-failed",
  "no-command-run",
  "injection-no-terminal",
  "injection-busy-timeout",
  "injection-refused-modal",
  "injection-screen-unavailable",
  "injection-needs-attention",
  "injection-rate-limited"
];

test("exactly the breakages are faults; a stop someone asked for never is", () => {
  const faults = Object.entries(STOP_FAMILIES)
    .filter(([, e]) => e.fault)
    .map(([r]) => r)
    .sort();
  expect(faults).toEqual([...FAULTS].sort());
  expect(stopFamily("operator-cancelled")).toEqual({ family: "cancelled", fault: false });
  expect(stopFamily("revoked")).toEqual({ family: "revoked", fault: false });
});

const TRACKING_LOST_REASONS = [
  "empty-plan",
  "bad-nonce",
  "step-too-long",
  "bad-args",
  "foreign-command",
  "foreign-turn",
  "unexpected-turn",
  "turn-overlap",
  "turn-mismatch",
  "seq-gap",
  "seq-regressed",
  "signal-refused",
  "step-mismatch",
  "quiescence-unknown"
];

test("each stop reason maps to its operator-facing family", () => {
  for (const r of TRACKING_LOST_REASONS) expect(stopFamily(r), r).toEqual({ family: "trackingLost", fault: false });
  const tableLost = Object.entries(STOP_FAMILIES)
    .filter(([, e]) => e.family === "trackingLost")
    .map(([r]) => r)
    .sort();
  expect(tableLost, "a reason entered or left the lost-tracking family").toEqual([...TRACKING_LOST_REASONS].sort());
  expect(stopFamily("turn-aborted").family).toBe("aborted");
  for (const r of ["turn-error", "turn-refused", "compact-failed"]) expect(stopFamily(r).family, r).toBe("turnFailed");
  for (const r of ["session-ended", "source-changed"]) expect(stopFamily(r).family, r).toBe("sessionEnded");
  for (const r of ["no-command-run", "no-turn-start", "unknown-command", "dialogue-command"])
    expect(stopFamily(r).family, r).toBe("notStarted");
  for (const r of FAULTS.filter((x) => x.startsWith("injection-"))) expect(stopFamily(r).family, r).toBe("injectionRefused");
});

test("an unknown, inherited or absent reason reads as lost tracking, not as a fault", () => {
  for (const r of ["a-reason-from-a-newer-main", "toString", "__proto__", null]) {
    expect(stopFamily(r), String(r)).toEqual({ family: "trackingLost", fault: false });
  }
});

test("every family has its label in en.json and fr.json", () => {
  const families = [...new Set(Object.values(STOP_FAMILIES).map((e) => e.family))];
  const root = join(import.meta.dir, "../desktop");
  const en = JSON.parse(readFileSync(join(root, "locales/en.json"), "utf-8"));
  const fr = JSON.parse(readFileSync(join(root, "locales/fr.json"), "utf-8"));
  for (const f of families) {
    expect(typeof en[`tile.seqFamily.${f}`], `en ${f}`).toBe("string");
    expect(typeof fr[`tile.seqFamily.${f}`], `fr ${f}`).toBe("string");
  }
});
