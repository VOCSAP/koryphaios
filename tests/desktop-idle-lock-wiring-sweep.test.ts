// Card e344fa79 lineage, LOT D1 follow-up (team-lead review round 2): a
// standalone unit test on ownsIdleLock (idle-lock.ts, see
// tests/desktop-idle-lock.test.ts) proves the PURE FUNCTION is correct in
// isolation, but proves nothing about the WIRING -- if watchIdleLocks
// (desktop/src/main/index.ts) called it with arguments in the wrong order,
// passed something other than activeScope.groupId, or dropped the call
// entirely and fell back to a bare peer_id comparison, every one of those
// unit tests stays green while the sweep becomes a silent no-op. Measured
// precedent for exactly this failure mode: card e344fa79's own review round
// 3 found a fix proven only at the pure-function level left the route-level
// wiring untested, 22 then 28 tests green over a real gap.
//
// index.ts imports electron and is not bun-testable (its own comment at the
// inbox-session.ts import site says so), so the WIRING itself cannot be
// exercised by calling it -- only by READING it, the same shape as
// tests/role-domain-sweep.test.ts (2026-08-24 precedent, read before writing
// this file). Two halves, because a guarantee about a DOMAIN (no dangerous
// comparison anywhere) fails OPEN if only checked at the one known site:
//
//   PRESENCE: watchIdleLocks's own function body contains a call to
//   ownsIdleLock with the four real, group-aware argument expressions
//   (item.locked_by, item.locked_group, <candidate peerId>,
//   activeScope.groupId) in that order.
//
//   ABSENCE (the half that matters more -- PRESENCE alone stays green even
//   if someone adds a SECOND, unguarded comparison next to the correct one):
//   no TEXTUALLY ADJACENT bare `peerId <-> locked_by` equality (a member
//   expression on each side, joined directly by an equality operator)
//   survives anywhere under desktop/src/main, swept file-by-file, not just
//   re-checked at the one line this lot touched.
//
// HONEST SCOPE LIMIT #1: this sweeps desktop/src/main only (where
// SessionRuntime and RoadmapItem are both in scope for a comparison like
// this to even compile) -- desktop/src/renderer's four locked_by READERS
// (RoadmapBoard.tsx, RoadmapItemModal.tsx x2, WorkflowLane.tsx) are pure
// display, already reviewed as out of scope for this lot, and none of them
// have a peerId of their own to compare against.
//
// HONEST SCOPE LIMIT #2 (review round 2, point 3): the ABSENCE promise is
// deliberately NARROW, not "no way to reintroduce this bug exists". This is
// a TEXTUAL sweep, not a data-flow analysis, and widening the regex to catch
// data-flow would make it one -- explicitly out of scope. Measured escapes
// (4, all via a local variable aliasing one or both sides before the
// comparison): `const pid = s.peerId; pid === item.locked_by`, the symmetric
// form aliasing `item.locked_by` instead, both sides aliased at once, and a
// closure-captured rename such as `sessions.find(x => x.peerId ===
// lockedBy)`. A check that isn't a direct equality at all (`.includes(...)`,
// a `byPeer.get(...)` lookup) is outside this pattern's shape by
// construction, not merely unswept. A narrow, true promise beats a wide,
// false one (CLAUDE.md: a stale-but-plausible comment is worse than an
// honestly scoped one, because the next reader who checks it once and finds
// it right stops re-verifying it).
//
// Also note: this sweep does NOT strip comments or string literals before
// matching -- a future `main`-side comment that happens to quote this exact
// anti-pattern (e.g. documenting it, the way THIS file's own header does)
// would redden the ABSENCE test. That is fail-CLOSED (a false positive, not
// a missed regression) so it is left as-is rather than adding a
// comment/string stripper -- but it is worth knowing before being surprised
// by it.

import { test, expect } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

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

function extractBracedBody(src: string, openIdx: number): string {
  let depth = 1;
  let i = openIdx + 1;
  while (depth > 0 && i < src.length) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") depth--;
    i++;
  }
  return src.slice(openIdx + 1, i - 1);
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
