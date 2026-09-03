// mobileApprovals gates only the Telegram/Discord/ntfy relay, never whether the
// blocking ask_operator channel exists.
// This is a text scan: it only catches a reintroduced literal condition on the
// call site, not a behavioral change inside the armed function.
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const indexTs = readFileSync(
  join(import.meta.dir, "..", "desktop", "src", "main", "index.ts"),
  "utf8"
);

test("the startup arm() call site is unconditional, not gated by config.mobileApprovals", () => {
  // `approvals.arm()` / `armApprovalsAtStartup()` have other call sites
  // (on-demand: connecting a channel, adopting an enrolment payload) that are
  // legitimately opt-in triggers, not the startup gate this card fixes. The
  // startup call site is the only one that assigns its result to `armed` for
  // the journal line right after.
  const marker = "const armed = await armApprovalsAtStartup(approvals)";
  const callIdx = indexTs.indexOf(marker);
  expect(callIdx).toBeGreaterThan(-1);
  expect(indexTs.indexOf(marker, callIdx + 1)).toBe(-1); // exactly one startup call site

  // Look at the 200 characters immediately BEFORE the call for a guard that
  // would skip it. Scoped narrowly (not "anywhere in the file") so a
  // legitimate, unrelated `config.mobileApprovals` check elsewhere (e.g. the
  // phone-relay-specific approvalsEnabled()) does not false-positive this.
  const before = indexTs.slice(Math.max(0, callIdx - 200), callIdx);
  expect(before).not.toMatch(/mobileApprovals/);
});
