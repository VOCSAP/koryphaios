import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  approvalDialogBody,
  approvalWarnings,
  bunMissingNotice,
  describeRuleForApproval,
  displaySafe,
  TTSR_DIALOG_MAX_CHARS,
  ttsrApprovalSpec,
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

test("warnings are shown sanitized after the rules and count toward what fits", () => {
  const rules = [rule("r-one")];
  const body = approvalDialogBody(rules, false, ["first line\nforged line"]);
  expect(body.text).toContain("warning: first line / forged line");
  expect(body.text, "a warning cannot start a line of its own").not.toContain("\nforged line");
  const crowded = approvalDialogBody(rules, false, Array.from({ length: 80 }, (_, i) => `w${i}`));
  expect(crowded.fits, "warnings past the line limit must make the dialog unapprovable in place").toBe(false);
  expect(approvalDialogBody(rules, true, ["x"]).text).toContain("avertissement: x");
});

test("approvalWarnings: the bun notice appears if and only if the probe reported bun unavailable", () => {
  const rules = [rule("r-one")];
  for (const isFr of [false, true]) {
    expect(approvalWarnings(rules, isFr, undefined), "bun started: no notice").toEqual([]);
    expect(approvalWarnings(rules, isFr, "spawn bun ENOENT"), "bun did not start: the notice alone").toEqual([bunMissingNotice(isFr)]);
  }
  expect(bunMissingNotice(false)).toContain("bun could not start when these rules were timed");
  expect(bunMissingNotice(true)).toContain("bun n'a pas pu démarrer quand ces règles ont été chronométrées");
});

test("approvalWarnings: the ambiguity advisories follow the rules, before the bun notice", () => {
  const ambiguous = rule("amb", { pattern: "(?:ab|a)+" });
  expect(approvalWarnings([rule("r-one")], false, undefined), "unambiguous rules: no advisory").toEqual([]);
  const warned = approvalWarnings([rule("r-one"), ambiguous], false, undefined);
  expect(warned).toHaveLength(1);
  expect(warned[0]).toContain('rules[1] "amb": pattern: the alternatives "ab" and "a"');
  expect(approvalWarnings([ambiguous], false, "spawn bun ENOENT")).toEqual([
    expect.stringContaining('rules[0] "amb"'),
    bunMissingNotice(false),
  ]);
  const body = approvalDialogBody([ambiguous], false, approvalWarnings([ambiguous], false, "x"));
  expect(body.text).toContain(`warning: ${bunMissingNotice(false)}`);
});

test("the approval document carries every rule in full, its warnings and the bun notice, fitting or not", () => {
  const input = { rules: [rule("a"), rule("b")], projectDir: "C:/repo", rulesFile: ".claude/rules.json", bunUnavailable: "spawn failed" };
  const many = { ...input, rules: Array.from({ length: 40 }, (_, i) => rule(`r${i}`)) };
  for (const [name, value] of [["fits", input], ["too long", many]] as const) {
    const spec = ttsrApprovalSpec(value, false);
    const body = approvalDialogBody(value.rules, false, approvalWarnings(value.rules, false, value.bunUnavailable));
    expect(spec.document.detail, `${name}: the document shows the whole body`).toContain(body.text);
    expect(spec.document.detail, `${name}: the bun notice is shown`).toContain(bunMissingNotice(false));
    expect(spec.document.detail, `${name}: the file is named`).toContain(".claude/rules.json");
    expect([name, spec.document.refuse]).toEqual([name, "Not now"]);
  }
  expect(ttsrApprovalSpec(input, false).approveIndex, "a body that fits the fallback box can be approved there").toBe(0);
  expect(ttsrApprovalSpec(many, false).approveIndex, "the fallback box offers no Approve for a body it cannot show").toBeNull();
});

test("index.ts wiring: promptTtsrApproval shows the TTSR spec through the trust approval router", () => {
  const src = readFileSync(join(import.meta.dir, "..", "desktop", "src", "main", "index.ts"), "utf8");
  const anchor = src.indexOf("async function promptTtsrApproval(req: TtsrApprovalRequest): Promise<boolean>");
  expect(anchor, "promptTtsrApproval must exist in index.ts").toBeGreaterThan(-1);
  const fn = extractBracedBody(src, src.indexOf("{", anchor));
  expect(fn.replace(/\s+/g, " ")).toContain("return await showApprovalDialog( ttsrApprovalSpec(");
  expect(fn, "the probe's bun verdict reaches the document").toContain("bunUnavailable: req.bunUnavailable");
});
