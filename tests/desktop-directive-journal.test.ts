// Card 6c380073, review round 2 point 3: the journal wording for a directive
// card's unreached targets (desktop/src/main/directive-journal.ts).
//
// WHY A PURE MODULE WITH ITS OWN PROBES, and not the source scan that covered
// the rest of this lot: the first version of this wording lived inline in
// index.ts's executeDirective and shipped a REGRESSION a scan could not see.
// A scan proves which SYMBOLS a call site reads -- `ambiguous` read rather
// than re-derived -- and it was green on the broken wording, because the
// defect was in the COMPOSITION: with nothing matched and at least one
// ambiguous id, the message listed only the ambiguous ones and SILENTLY
// DROPPED the plainly-absent ones. That is a real loss, not a cosmetic one:
// runDirectiveWave is mark-then-execute, so the card is already consumed and
// this line is the only report the operator ever gets.
//
// Three probes: absent only, ambiguous only, and BOTH TOGETHER -- the third
// is the case that was broken, and the only one that would have caught it.

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { unreachedTargetsText } from "../desktop/src/main/directive-journal.ts";

test("absent ids only: every requested id is named", () => {
  const text = unreachedTargetsText(["host-absent", "gone-peer"], []);
  expect(text).toBe("no live target: host-absent, gone-peer");
});

test("ambiguous ids only: named as ambiguous, never as absent", () => {
  const text = unreachedTargetsText(["dup-peer"], ["dup-peer"]);
  expect(text).toBe("refused: 1 ambiguous (matched more than one live tile): dup-peer");
  // The wording must not claim the target does not exist -- it exists twice.
  expect(text).not.toContain("no live target");
});

test("BOTH categories at once: neither is dropped (the regression this file exists for)", () => {
  // `ambiguous` is a SUBSET of `missing` (directive.ts's contract), so a
  // realistic input carries the ambiguous id in BOTH arrays.
  const text = unreachedTargetsText(["dup-peer", "host-absent"], ["dup-peer"]);
  expect(text).toContain("host-absent");
  expect(text).toContain("dup-peer");
  expect(text).toBe(
    "no live target: host-absent; refused: 1 ambiguous (matched more than one live tile): dup-peer"
  );
});

test("an ambiguous id is never counted twice (subset, not a competing bucket)", () => {
  const text = unreachedTargetsText(["dup-peer"], ["dup-peer"]);
  expect(text.match(/dup-peer/g)?.length).toBe(1);
});

test("nothing unreached yields an empty string, so the caller can skip journaling", () => {
  expect(unreachedTargetsText([], [])).toBe("");
});

// Presence scan: the pure function above proves the WORDING; this proves the
// real call site uses it rather than re-composing its own. Weak by nature
// (it cannot prove the arguments are the right ones), which is exactly why
// the probes above exist alongside it.
test("executeDirective journals through unreachedTargetsText at BOTH of its call sites (real file)", () => {
  const src = readFileSync(
    join(import.meta.dir, "..", "desktop", "src", "main", "index.ts"),
    "utf-8"
  );
  expect(src).toContain("import { unreachedTargetsText } from './directive-journal'");
  const calls = src.match(/unreachedTargetsText\(missing, ambiguous\)/g) ?? [];
  // One per branch: the no-match early return, and the partial-miss tail.
  expect(calls.length).toBe(2);
});
