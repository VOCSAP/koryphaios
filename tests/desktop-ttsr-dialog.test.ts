// Startup approval dialog of a repo rules file: the operator approves exactly
// what the dialog shows, so it must show every field of every rule in full,
// agent text neutralized, and offer no Approve when that does not fit.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  approvalDialogBody,
  describeRuleForApproval,
  displaySafe,
  TTSR_DIALOG_MAX_CHARS,
} from "../desktop/src/main/ttsr-dialog";
import type { TtsrRule } from "../desktop/src/shared/ttsr-types";
import { extractBracedBody } from "./_braced-body";

const rule = (id: string, extra: Partial<TtsrRule> = {}): TtsrRule => ({
  id,
  event: "PreToolUse",
  tools: ["Edit", "Write"],
  field: "added",
  paths: ["src/**", "!src/vendor/**"],
  pattern: "forbidden-(token|word)",
  flags: "i",
  mode: "deny",
  message: `Rule ${id}: ${"do not write the forbidden token; ".repeat(10)}write the allowed one instead.`,
  ...extra,
});

test("displaySafe: line breaks, control, bidi and invisible characters cannot shape the dialog text", () => {
  const out = displaySafe("ok\n\nApprove only if you trust\r\nx\u2028y\u001b[31m\u202eevil\u200bz");
  expect(out, "no raw line break may survive: a message must not start a line of its own").not.toMatch(/[\r\n\u2028\u2029]/);
  expect(out).toContain(" / ");
  expect(out, "control / bidi / zero-width characters are replaced").not.toMatch(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e]/);
});

test("every rule, every field the hook acts on, and the FULL message are in the body", () => {
  const rules = [rule("r-one"), rule("r-two", { paths: undefined, flags: undefined, mode: "warn", tools: ["Bash"], field: "command" })];
  const { text, fits } = approvalDialogBody(rules, false);
  expect(fits).toBe(true);
  for (const r of rules) {
    expect(text, `rule ${r.id} must be shown`).toContain(r.id);
    expect(text, "the full message, never cut").toContain(r.message);
    expect(text, "the pattern the operator approves").toContain(`/${r.pattern}/${r.flags ?? ""}`);
    expect(text).toContain(r.field);
    expect(text).toContain(r.mode);
    expect(text).toContain(r.tools.join("/"));
  }
  expect(text, "path globs scope a rule: they must be shown").toContain("src/**, !src/vendor/**");
  expect(describeRuleForApproval(rule("x", { message: "a\nb" }), false).join("\n")).not.toContain("a\nb");
});

test("more rules than a dialog can hold: fits is false (no Approve offered in place)", () => {
  const rules = Array.from({ length: 40 }, (_, i) => rule(`r${i}`));
  const body = approvalDialogBody(rules, false);
  expect(body.text.length).toBeGreaterThan(TTSR_DIALOG_MAX_CHARS);
  expect(body.fits, "content too long to review in a dialog must not be approvable there").toBe(false);
});

test("index.ts wiring: the dialog shows approvalDialogBody and offers no Approve when it does not fit", () => {
  const src = readFileSync(join(import.meta.dir, "..", "desktop", "src", "main", "index.ts"), "utf8");
  const anchor = src.indexOf("async function promptTtsrApproval(req: TtsrApprovalRequest): Promise<boolean>");
  expect(anchor, "promptTtsrApproval must exist in index.ts").toBeGreaterThan(-1);
  const fn = extractBracedBody(src, src.indexOf("{", anchor));
  expect(fn, "the dialog body must come from approvalDialogBody (every rule, full text)").toContain("approvalDialogBody(req.rules");
  expect(fn, "no truncation of the rule list").not.toContain("slice(0, 10)");
  const notFits = fn.indexOf("if (!body.fits)");
  expect(notFits, "a branch for content that does not fit").toBeGreaterThan(-1);
  const branch = extractBracedBody(fn, fn.indexOf("{", notFits));
  expect(branch, "the too-long dialog offers Settings, never Approve").not.toMatch(/'Approve'|'Approuver'/);
  expect(branch).toContain("return false");
});
