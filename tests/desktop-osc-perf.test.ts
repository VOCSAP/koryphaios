// Card 1aa69066 (H2) review, blocker F1 (reviewer measurement, 2026-08-26).
//
// The first shipped ANSI_RE combined-regex fix
// (/\x1b(?:\[CSI...|\][^\x07]*?(?:\x07|\x1b\\))/g) had an UNBOUNDED lazy
// class on its OSC branch: on a MAX_BUF-sized (4096) buffer full of
// unterminated "ESC ]" heads, each head restarts a full lazy backtracking
// scan, making the strip quadratic in the buffer length -- measured
// 0.0392ms/call at n=512 growing to 2.3410ms/call at n=4096 (~x60 for a x8
// input growth, the O(n^2) signature). This runs on the Electron MAIN
// PROCESS's hot PTY-data path, on the ACCUMULATED buffer, for THREE
// detectors, for EVERY session, on EVERY chunk -- a `cat` of a binary file
// into a tile is the adversarial input, not a theoretical one (CLAUDE.md's
// five-hostile-inputs table).
//
// ONE guard: STRUCTURAL, zero-flake. The OSC branch's class must exclude
// the ESC byte (never just be "bounded") -- a regex source-text check, not
// a timing measurement.
//
// Card 1aa69066 review round 3, blocker T5 (false pointer, corrected):
// what actually prevents the blowup is NOT the `{0,4096}` bound, it is
// EXCLUDING ESC FROM THE CLASS. MEASURED, four variants on the same
// adversarial ESC-] flood at n=4096: `[^\x07\x1b\n]{0,4096}` (shipped)
// 0.0216ms; the SAME class made UNBOUNDED, `[^\x07\x1b\n]*?`, 0.0035ms --
// FASTER, not slower; `[^\x07]{0,4096}` (bounded, but ESC NOT excluded)
// 3.5507ms -- WORSE than the ORIGINAL, unfixed regex (2.6813ms). A bound
// with the wrong exclusion set is not just insufficient, it can be actively
// worse than no bound at all. The mechanism: once ESC is excluded from the
// class, encountering the NEXT `ESC ]` head immediately halts that match
// attempt (backtracking has nowhere to grow) -- the class becomes
// self-limiting on THIS adversarial shape regardless of an explicit length
// cap. A cap still matters for MEMORY on a pathological run that contains
// neither ESC nor the terminator (a giant plain-text OSC body) -- but it is
// not what closes the quadratic-time hole, and claiming otherwise is a
// pointer that names the wrong protection: the next person who widens
// `{0,4096}` to `{0,65536}` while keeping the ESC exclusion stays safe; the
// next person who "simplifies" the class back to `[^\x07]` while keeping
// the bound does NOT, and a comment crediting the bound would not have
// warned them.
//
// A BEHAVIOURAL (timing) test of this property was tried and REMOVED
// (review round 3, blocker T4): measured 1 failure in 30 runs on an IDLE
// dev machine, worst ratio 23.22 against a threshold of 10 -- all the
// variance sat in the NUMERATOR (n=4096 cost), meaning GC/scheduler
// jitter, not "machine is generally slow" (which would move both n=1024
// and n=4096 together and leave the ratio stable). A shared CI runner is a
// WORSE environment for exactly this kind of jitter, not a better one. An
// unstable guard gets disabled, which is worse than no guard: this file's
// own EARLIER header claimed "ordinary CI noise cannot flip it" -- that
// claim was never measured against real jitter and was wrong. The
// structural check below is the guard; it is zero-flake by construction
// (it reads source text, it does not run a clock).

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
