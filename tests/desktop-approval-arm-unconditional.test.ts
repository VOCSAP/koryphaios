// Card 469f3176: mobileApprovals must be a pure TRANSPORT choice (whether to
// also relay a question to Telegram/Discord/ntfy), never a gate on whether
// the blocking ask_operator channel exists at all.
//
// SECOND RIDEAU, not the primary proof (team-lead ruling, 2026-08-13): a text
// scan only catches the LITERAL spelling of a reintroduced guard --
// `=== true`, a ternary, an inverted early-return all stay invisible to it
// while the bug is back. The PRIMARY, behavioral proof lives in
// tests/desktop-approval-runtime.test.ts, which calls
// armApprovalsAtStartup() directly: that function's signature takes no
// mobileApprovals-shaped argument at all, so nothing inside it can branch on
// one regardless of how a future edit spells the condition. What a text scan
// still catches, and what the extraction alone cannot: index.ts's call site
// itself being wrapped in a guard around the call, which is why this test is
// kept as a second check on that one line rather than deleted.
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
