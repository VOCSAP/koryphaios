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
  const marker = "const armed = await armApprovalsAtStartup(approvals)";
  const callIdx = indexTs.indexOf(marker);
  expect(callIdx).toBeGreaterThan(-1);
  expect(indexTs.indexOf(marker, callIdx + 1)).toBe(-1);

  const before = indexTs.slice(Math.max(0, callIdx - 200), callIdx);
  expect(before).not.toMatch(/mobileApprovals/);
});

function enrolmentApplyFailsWhenArmFails(source: string): boolean {
  const start = source.indexOf("regHandle('approvals:enrolment-apply'");
  const end = source.indexOf("\n  })", start);
  if (start === -1 || end === -1) return false;
  const body = source.slice(start, end);
  const failure = body.indexOf("if (!(await approvals.arm())) {");
  const report = body.indexOf("reportError('approvals', 'could not arm remote approvals after enrolment')");
  const success = body.indexOf("journal.add('session', 'this PC was linked to an existing operator identity')");
  return failure !== -1 && report > failure && success > report && body.slice(failure, success).includes("return false");
}

test("enrolment apply fails before reporting successful linking when approval arm fails", () => {
  expect(enrolmentApplyFailsWhenArmFails(indexTs)).toBe(true);
  expect(enrolmentApplyFailsWhenArmFails(indexTs.replace("if (!(await approvals.arm())) {", "if (false) {"))).toBe(false);
});
