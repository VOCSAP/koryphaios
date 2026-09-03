import { test, expect } from "bun:test";
// refusesUnattendedApproval is the decision index.ts's confirmSpawnShellFields
// and approveSpawn both call to decide whether to open a dialog (card
// ffafeea6) -- itself untestable directly under bun test since index.ts
// imports 'electron' and runs app.whenReady() at module scope, unlike this
// pure module (node builtins only).
import {
  refusesUnattendedApproval,
  type CallerAttendance,
} from "../desktop/src/main/workspace-service.ts";

// index.ts checks supervisorSpawnMode === 'hands-free' BEFORE ever calling
// refusesUnattendedApproval (both confirmSpawnShellFields and approveSpawn),
// so this predicate never sees 'hands-free' at all -- it is the SAME code
// path for 'team-review' and 'full-control', which is exactly why forcing
// attendance to 'unattended' here closes both modes' dialog at once rather
// than needing a per-mode fix.

test("unattended, no pre-approval: refuses -- the dialog-opening branch is never reached", () => {
  expect(refusesUnattendedApproval("unattended", false)).toBe(true);
});

test("unattended, already pre-approved: does not refuse -- a cache hit still proceeds silently", () => {
  expect(refusesUnattendedApproval("unattended", true)).toBe(false);
});

test("attended, no pre-approval: does not refuse -- an attended caller may still be asked", () => {
  expect(refusesUnattendedApproval("attended", false)).toBe(false);
});

test("attended, already pre-approved: does not refuse", () => {
  expect(refusesUnattendedApproval("attended", true)).toBe(false);
});

// approveSpawn has no pre-approval cache for a whole spawn plan (unlike
// confirmSpawnShellFields), so its own call site always passes
// alreadyApproved=false -- pinned here so a future edit to that call site
// cannot silently start threading a real cache value without this test's
// author noticing the assumption changed.
test("an unattended caller with no cache concept (approveSpawn's own call shape) always refuses", () => {
  const attendance: CallerAttendance = "unattended";
  expect(refusesUnattendedApproval(attendance, false)).toBe(true);
});
