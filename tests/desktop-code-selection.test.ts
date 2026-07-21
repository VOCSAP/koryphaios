// PLAN GX7: the pure line-range math behind the Files-view code selection.

import { test, expect } from "bun:test";
import { selectionLineRange } from "../desktop/src/shared/code-selection.ts";

// File body used for the mental model: "alpha\nbeta\ngamma\ndelta\n"
// (line 1 = alpha, line 2 = beta, ...).

test("single line selected mid-file", () => {
  // before = "alpha\n" (1 newline → start line 2), selection "beta".
  expect(selectionLineRange("alpha\n", "beta")).toEqual({ startLine: 2, endLine: 2 });
});

test("selection ending at the next line boundary does NOT over-count", () => {
  // Dragging past line 2 to the start of line 3 yields "beta\n".
  expect(selectionLineRange("alpha\n", "beta\n")).toEqual({ startLine: 2, endLine: 2 });
});

test("multi-line selection", () => {
  expect(selectionLineRange("alpha\n", "beta\ngamma")).toEqual({ startLine: 2, endLine: 3 });
  // ...with the trailing boundary newline: still 2–3, not 2–4.
  expect(selectionLineRange("alpha\n", "beta\ngamma\n")).toEqual({ startLine: 2, endLine: 3 });
});

test("selection starting at the very top of the file", () => {
  expect(selectionLineRange("", "alpha")).toEqual({ startLine: 1, endLine: 1 });
});

test("selection starting mid-line keeps the start line", () => {
  // before ends mid-line 2 ("alpha\nbe"), selection "ta\ngamma".
  expect(selectionLineRange("alpha\nbe", "ta\ngamma")).toEqual({ startLine: 2, endLine: 3 });
});
