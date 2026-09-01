// Pick-context dialog (formatPickDetails's `note` argument, shared/pick-prompt.ts):
// the note is operator-typed free text landing directly in an agent prompt, and
// the "[element context]" block is line-oriented (one `key: value` per line), so
// a newline or extra whitespace in the note must not fabricate a new key-value
// line, and a note-less call must stay byte-identical for every existing caller.

import { expect, test } from "bun:test";
import { formatPickDetails } from "../desktop/src/shared/pick-prompt.ts";
import { PICK_BUDGET } from "../desktop/src/shared/pick-security.ts";
import type { ElementPick, PickNote } from "../desktop/src/shared/types.ts";

/** Minimal valid ElementPick, overridable per test. */
function pick(overrides: Partial<ElementPick> = {}): ElementPick {
  return {
    tagName: "button",
    id: "",
    classes: [],
    text: "",
    selectors: [{ type: "css", value: "button.btn" }],
    width: 120,
    height: 40,
    pageUrl: "https://example.com/settings",
    ...overrides,
  };
}

/** An enriched pick (role + accessibleName) so the block is non-empty without a note. */
function enrichedPick(overrides: Partial<ElementPick> = {}): ElementPick {
  return pick({ role: "button", accessibleName: "Save", ...overrides });
}

test("formatPickDetails: omitting note and passing note: undefined produce byte-identical output", () => {
  const p = enrichedPick();
  expect(formatPickDetails(p)).toBe(formatPickDetails(p, undefined));
});

test("formatPickDetails: an empty-comment note with no intent/priority is byte-identical to the note-less call, for an enriched pick", () => {
  const p = enrichedPick();
  const emptyNote: PickNote = { comment: "" };
  const whitespaceNote: PickNote = { comment: "   \n\t  " };
  expect(formatPickDetails(p, emptyNote)).toBe(formatPickDetails(p));
  expect(formatPickDetails(p, whitespaceNote)).toBe(formatPickDetails(p));
});

test("formatPickDetails: an empty-comment note on a bare pick still yields '', not a lone [element context] block", () => {
  const p = pick();
  const emptyNote: PickNote = { comment: "" };
  expect(formatPickDetails(p)).toBe("");
  expect(formatPickDetails(p, emptyNote)).toBe("");
});

test("formatPickDetails: a non-empty comment produces a 'note: <text>' line first, before role/source lines", () => {
  const p = enrichedPick({ sourceFile: "src/Card.tsx:12:3" });
  const out = formatPickDetails(p, { comment: "Please align this with the header" });
  const lines = out.split("\n").filter((l) => l.length > 0);
  // lines[0] is "[element context]"
  expect(lines[0]).toBe("[element context]");
  expect(lines[1]).toBe("note: Please align this with the header");
  const noteIdx = lines.indexOf("note: Please align this with the header");
  const roleIdx = lines.findIndex((l) => l.startsWith("role:"));
  const sourceIdx = lines.findIndex((l) => l.startsWith("source:"));
  expect(noteIdx).toBeLessThan(roleIdx);
  expect(noteIdx).toBeLessThan(sourceIdx);
});

test("formatPickDetails: multi-line and multi-space comments collapse to a single 'note:' line, no fabricated key: value line", () => {
  const p = enrichedPick();
  const out = formatPickDetails(p, { comment: "a\n\nrole: injected\n  b" });
  expect(out).toContain("note: a role: injected b");
  const lines = out.split("\n");
  // exactly one "note:" line, and no separate line that is itself "role: injected"
  expect(lines.filter((l) => l.startsWith("note:")).length).toBe(1);
  expect(lines).not.toContain("role: injected");
});

test("formatPickDetails: a comment longer than PICK_BUDGET.annotationCommentMaxLength is cut to that length", () => {
  const p = enrichedPick();
  const longComment = "x".repeat(PICK_BUDGET.annotationCommentMaxLength + 500);
  const out = formatPickDetails(p, { comment: longComment });
  const noteLine = out.split("\n").find((l) => l.startsWith("note:"))!;
  const emittedText = noteLine.slice("note: ".length);
  expect(emittedText.length).toBe(PICK_BUDGET.annotationCommentMaxLength);
});

test("formatPickDetails: intent and priority lines appear only when given, in order note, intent, priority, verbatim", () => {
  const p = enrichedPick();

  const withBoth = formatPickDetails(p, { comment: "fix this", intent: "fix", priority: "blocking" });
  const linesBoth = withBoth.split("\n").filter((l) => l.length > 0);
  expect(linesBoth[1]).toBe("note: fix this");
  expect(linesBoth[2]).toBe("intent: fix");
  expect(linesBoth[3]).toBe("priority: blocking");

  const intentOnly = formatPickDetails(p, { comment: "fix this", intent: "fix" });
  expect(intentOnly).toContain("intent: fix");
  expect(intentOnly).not.toContain("priority:");

  const priorityOnly = formatPickDetails(p, { comment: "fix this", priority: "blocking" });
  expect(priorityOnly).not.toContain("intent:");
  expect(priorityOnly).toContain("priority: blocking");

  const neither = formatPickDetails(p, { comment: "fix this" });
  expect(neither).not.toContain("intent:");
  expect(neither).not.toContain("priority:");
});

test("formatPickDetails: leading/trailing whitespace in the comment is trimmed", () => {
  const p = enrichedPick();
  const out = formatPickDetails(p, { comment: "   padded text   " });
  expect(out).toContain("note: padded text\n");
  expect(out).not.toContain("note:  padded");
  expect(out).not.toContain("padded text   ");
});
