import { test, expect } from "bun:test";
import { TOAST_MS } from "../desktop/src/renderer/src/toast-timing.ts";

test("an error toast stays on screen longer than 3 s", () => {
  // A blocked Save changes nothing on screen but this toast: at 3 s an operator
  // glancing away never learns why the Save did nothing.
  expect(TOAST_MS.error, "the error toast vanishes before a refusal can be read").toBeGreaterThan(3000);
});

test("an error toast outlasts every confirmation toast", () => {
  expect(TOAST_MS.error, "an error toast leaves no later than a success toast").toBeGreaterThan(TOAST_MS.success);
  expect(TOAST_MS.error, "an error toast leaves no later than an info toast").toBeGreaterThan(TOAST_MS.info);
});
