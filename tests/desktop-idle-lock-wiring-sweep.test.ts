// PRESENCE: watchIdleLocks calls ownsIdleLock with the four group-aware
// arguments, in that order. ABSENCE: no bare peerId===locked_by comparison
// exists anywhere under desktop/src/main, swept file-by-file.
// Scoped to desktop/src/main only; renderer's locked_by readers are pure
// display and are out of scope.
// A textual sweep, not data-flow: aliasing either side into a local variable
// before the comparison escapes detection by design.
// Does not strip comments or strings before matching, so a comment quoting this
// exact pattern can false-positive -- accepted as fail-closed.

import { test, expect } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { extractBracedBody } from "./_braced-body";

const MAIN_DIR = join(import.meta.dir, "..", "desktop", "src", "main");
const INDEX_PATH = join(MAIN_DIR, "index.ts");

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...listTsFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

/**
 * PRESENCE: watchIdleLocks (an arrow function assigned to a const, not a
 * `function` declaration -- role-domain-sweep.test.ts's brace-finding trick
 * doesn't apply verbatim since there is no return-type union to dodge here,
 * just `=> {` on the same line) calls ownsIdleLock with the real, group-aware
 * arguments in order.
 */
export function findWatchIdleLocksWiringFailures(src: string): string[] {
  const declMatch = /const\s+watchIdleLocks\s*=\s*async\s*\([^)]*\)\s*:\s*Promise<void>\s*=>\s*\{/.exec(
    src
  );
  if (!declMatch) {
    return [
      "const watchIdleLocks = async (): Promise<void> => { ... } not found in index.ts -- has it been renamed or reshaped?"
    ];
  }
  const openIdx = declMatch.index + declMatch[0].length - 1;
  const body = extractBracedBody(src, openIdx);
  const callRe =
    /ownsIdleLock\(\s*item\.locked_by\s*,\s*item\.locked_group\s*,\s*[\w.]+\s*,\s*activeScope\.groupId\s*\)/;
  if (!callRe.test(body)) {
    return [
      "watchIdleLocks's body does not call ownsIdleLock(item.locked_by, item.locked_group, <candidate>, activeScope.groupId) in that argument order"
    ];
  }
  return [];
}

/**
 * ABSENCE: a TEXTUALLY ADJACENT bare equality between a member expression
 * ending in `.peerId` and one ending in `.locked_by` (either order,
 * `==`/`===`/`!=`/`!==`) -- the exact shape of the pre-fix defect. Matches
 * the WHOLE FILE's text, not a hand-picked function, so a bug reintroduced
 * anywhere in the file (not just back at the original line) is still
 * caught. Does NOT catch a form that aliases either side through a local
 * variable first, or any non-equality check -- see the file header's
 * "HONEST SCOPE LIMIT #2" for the measured list and why this stays a
 * textual sweep rather than growing into a data-flow one.
 */
export function findBarePeerIdLockedByComparisons(src: string): string[] {
  const re =
    /(?:\w+\.)?peerId\s*(===|==|!==|!=)\s*(?:\w+\.)?locked_by|(?:\w+\.)?locked_by\s*(===|==|!==|!=)\s*(?:\w+\.)?peerId/g;
  const failures: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    failures.push(`bare comparison "${m[0]}" at offset ${m.index}`);
  }
  return failures;
}

test("PRESENCE: watchIdleLocks wires ownsIdleLock with the group-aware arguments in order", () => {
  const src = readFileSync(INDEX_PATH, "utf-8");
  expect(findWatchIdleLocksWiringFailures(src)).toEqual([]);
});

test("ABSENCE: no TEXTUALLY ADJACENT bare peerId<->locked_by equality survives anywhere under desktop/src/main", () => {
  const files = listTsFiles(MAIN_DIR);
  // Anti-vacuity floor: 86 .ts files measured under desktop/src/main at the
  // time this was written (`find desktop/src/main -name '*.ts' | wc -l`).
  // Review round 2 (point 2): the original floor of 10 left 87% of the real
  // domain free to silently disappear (a bad glob, a moved directory) without
  // reddening. 60 leaves real headroom for the directory to keep growing
  // while still catching any large, silent loss of the domain.
  expect(files.length).toBeGreaterThan(60);

  const failures: string[] = [];
  for (const file of files) {
    const src = readFileSync(file, "utf-8");
    for (const f of findBarePeerIdLockedByComparisons(src)) {
      failures.push(`${file}: ${f}`);
    }
  }
  expect(failures).toEqual([]);
});

// ---------------------------------------------------------------------------
// Detector self-check (review round 2, point 1, BLOQUANT): the ABSENCE test
// above proves the guard holds on TODAY's source. It proves nothing about
// whether the detector itself is capable of catching a regression --
// measured by the reviewer: `findBarePeerIdLockedByComparisons` hollowed out
// to `return [];` still leaves the suite at 2 pass / 0 fail. CLAUDE.md's own
// question, applied to the detector rather than the code it guards: "is that
// probe in the diff?" A negative control (the real, correct call must NOT
// trip the detector) counts as much as the positives: a detector that always
// returns a non-empty array would pass the two positive assertions alone.
// ---------------------------------------------------------------------------

test("detector self-check: findBarePeerIdLockedByComparisons is sensitive to both orders and silent on the real call", () => {
  expect(findBarePeerIdLockedByComparisons("s.peerId === item.locked_by")).toHaveLength(1);
  expect(findBarePeerIdLockedByComparisons("item.locked_by === s.peerId")).toHaveLength(1);
  // Negative control: the actual, correct call site must not trip this.
  expect(
    findBarePeerIdLockedByComparisons(
      "ownsIdleLock(item.locked_by, item.locked_group, s.peerId, activeScope.groupId)"
    )
  ).toEqual([]);
});
