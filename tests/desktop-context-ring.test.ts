import { test, expect } from "bun:test";

// PLAN live-status, Lot B -- pure geometry/severity for the sidebar's
// context-fill ring. No React/DOM import in the module under test, so it
// loads under bun test from the repo root exactly like peer-table.ts.
import {
  clampPct,
  formatTokens,
  ringDash,
  ringSeverity,
} from "../desktop/src/renderer/src/context-ring.ts";

// ----- ringSeverity: the 70/90 bands, exact boundary behaviour -----

test("ringSeverity: below 70 is normal, including just under the boundary", () => {
  expect(ringSeverity(0)).toBe("normal");
  expect(ringSeverity(69.9)).toBe("normal");
});

test("ringSeverity: 70 itself is already warn, not normal", () => {
  expect(ringSeverity(70)).toBe("warn");
});

test("ringSeverity: just under 90 is still warn, not critical", () => {
  expect(ringSeverity(89.9)).toBe("warn");
});

test("ringSeverity: 90 itself is already critical", () => {
  expect(ringSeverity(90)).toBe("critical");
  expect(ringSeverity(100)).toBe("critical");
});

test("ringSeverity: null reads as unknown, never guessed as normal", () => {
  expect(ringSeverity(null)).toBe("unknown");
});

test("ringSeverity: NaN reads as unknown, same as null -- never as 0% normal", () => {
  expect(ringSeverity(NaN)).toBe("unknown");
});

// ----- clampPct -----

test("clampPct: negative input clamps to 0, not left negative", () => {
  expect(clampPct(-10)).toBe(0);
});

test("clampPct: over-100 input clamps to 100, not left unbounded", () => {
  expect(clampPct(150)).toBe(100);
});

test("clampPct: NaN clamps to 0 rather than propagating", () => {
  expect(clampPct(NaN)).toBe(0);
});

test("clampPct: a value already inside [0, 100] passes through unchanged", () => {
  expect(clampPct(42)).toBe(42);
});

// ----- ringDash -----

const CIRC = 2 * Math.PI * 5;

test("ringDash: 0% fills nothing -- dashoffset equals the full circumference", () => {
  const { dashoffset } = ringDash(0, CIRC);
  expect(dashoffset).toBeCloseTo(CIRC, 5);
});

test("ringDash: 100% fills the whole ring -- dashoffset is 0", () => {
  const { dashoffset } = ringDash(100, CIRC);
  expect(dashoffset).toBeCloseTo(0, 5);
});

test("ringDash: 50% offsets by exactly half the circumference", () => {
  const { dashoffset } = ringDash(50, CIRC);
  expect(dashoffset).toBeCloseTo(CIRC / 2, 5);
});

test("ringDash: a negative pct clamps to 0% fill, same as an honest 0", () => {
  expect(ringDash(-20, CIRC).dashoffset).toBeCloseTo(ringDash(0, CIRC).dashoffset, 5);
});

test("ringDash: an over-100 pct clamps to a full ring, same as an honest 100", () => {
  expect(ringDash(140, CIRC).dashoffset).toBeCloseTo(ringDash(100, CIRC).dashoffset, 5);
});

test("ringDash: null draws a short evenly-spaced dash pattern, not a 0%-filled arc", () => {
  const nullDash = ringDash(null, CIRC);
  const zeroDash = ringDash(0, CIRC);
  // Both dashoffsets happen to read 0/CIRC-ish, but the dasharray itself must
  // differ -- a real 0% is a solid stroke of length 0 (dasharray = full,full),
  // while "unknown" is a repeating short dash covering the whole ring, which
  // is the actual guard: a null reading must never render identically to a
  // measured 0%.
  expect(nullDash.dasharray).not.toBe(zeroDash.dasharray);
});

test("ringDash: NaN takes the same unknown branch as null", () => {
  expect(ringDash(NaN, CIRC).dasharray).toBe(ringDash(null, CIRC).dasharray);
});

// ----- formatTokens -----

test("formatTokens: 200000 -> 200k", () => {
  expect(formatTokens(200000)).toBe("200k");
});

test("formatTokens: 1000000 -> 1M", () => {
  expect(formatTokens(1000000)).toBe("1M");
});

test("formatTokens: a fractional-million count keeps one decimal", () => {
  expect(formatTokens(1500000)).toBe("1.5M");
});

test("formatTokens: a fractional-thousand count keeps one decimal", () => {
  expect(formatTokens(4500)).toBe("4.5k");
});

test("formatTokens: sub-1000 counts print as a plain rounded integer", () => {
  expect(formatTokens(999)).toBe("999");
  expect(formatTokens(0.4)).toBe("0");
});

test("formatTokens: non-finite or non-positive input never throws or prints NaN/Infinity", () => {
  expect(formatTokens(NaN)).toBe("0");
  expect(formatTokens(-500)).toBe("0");
  expect(formatTokens(Infinity)).toBe("0");
});
