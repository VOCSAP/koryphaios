// The OSC branch's character class must exclude ESC, not merely be bounded:
// excluding ESC is what halts a backtracking match attempt at the next OSC head
// and makes the class self-limiting; a bound without that exclusion measured
// slower than no bound at all.
// Checked structurally, via a regex source-text assertion, not by timing: a
// behavioural timing probe of this property was tried and removed for measured
// flakiness on an idle machine, and a shared CI runner is a worse environment
// for that jitter, not a better one.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";

const REPO_ROOT = join(import.meta.dir, "..");

// magic-compact.ts added (review round 3, blocker T5): it carries the SAME
// bounded-OSC-branch class (its own dedicated pass, see its own comment),
// and nothing pinned it before this.
const DETECTOR_FILES = [
  "desktop/src/main/attention.ts",
  "desktop/src/main/quota.ts",
  "desktop/src/main/startup-ack.ts",
  "desktop/src/main/magic-compact.ts"
];

// Split into TWO independent signatures, not one combined literal, so a
// failure names WHICH property broke (review T5's own point: the exclusion
// is the protection, the bound is not -- a single combined pin's failure
// message would not distinguish the two).
const OSC_BRANCH_ESC_EXCLUSION = "\\][^\\x07\\x1b\\n]"; // introducer + the class that excludes BEL, ESC and LF
const OSC_BRANCH_BOUND_AND_TERMINATOR = "{0,4096}(?:\\x07|\\x1b\\\\)"; // the length cap + terminator alternation

// The exact UNBOUNDED shape the review originally measured as quadratic --
// present here so this file states the mutation it must catch (fixture
// below), not just asserts the fixed shape. Kept for completeness even
// though T5 measured the BOUND is not actually the load-bearing half.
const UNBOUNDED_OSC_BRANCH_SIGNATURE = "\\][^\\x07]*?(?:\\x07|\\x1b\\\\)";

test("every OSC-stripping file's OSC branch EXCLUDES ESC from its class -- the actual protection against the quadratic blowup (review T5), not merely a length bound", () => {
  for (const path of DETECTOR_FILES) {
    const src = readFileSync(join(REPO_ROOT, path), "utf-8");
    expect(
      src.includes(OSC_BRANCH_ESC_EXCLUSION),
      `${path}: OSC branch's class does not exclude ESC -- MEASURED (review T5) to be what actually ` +
        `prevents the quadratic blowup on an adversarial ESC-] flood, a length bound alone is not enough ` +
        `and can even be WORSE than no bound (3.5507ms/call bounded-without-ESC-exclusion vs 2.6813ms/call ` +
        `for the original, unfixed, fully unbounded regex)`
    ).toBe(true);
  }
});

test("every OSC-stripping file's OSC branch is ALSO length-bounded (memory safety on a pathological run with neither ESC nor a terminator, not the perf fix itself)", () => {
  for (const path of DETECTOR_FILES) {
    const src = readFileSync(join(REPO_ROOT, path), "utf-8");
    expect(
      src.includes(OSC_BRANCH_ESC_EXCLUSION + OSC_BRANCH_BOUND_AND_TERMINATOR),
      `${path}: missing the bounded OSC-branch signature`
    ).toBe(true);
    expect(
      src.includes(UNBOUNDED_OSC_BRANCH_SIGNATURE),
      `${path}: still contains the fully UNBOUNDED OSC-branch signature measured quadratic in review`
    ).toBe(false);
  }
});
