// Card 249ed831 (form b), reviewer round 2 point 2 (extended round 3 point
// 2): the `noteUnresolved` dep wired into runDirectiveWave's call inside
// index.ts's dispatchNextInner is completely untested from
// tests/desktop-dispatch.test.ts's own suite -- the mocked `noteUnresolved`
// there proves the PREDICATE that decides WHEN runDirectiveWave calls it,
// never what the REAL index.ts wiring does when it fires. Measured by the
// reviewer: `grep -rl "noteUnresolved" --include=*.ts .` returns exactly 3
// files (dispatch.ts, index.ts, tests/desktop-dispatch.test.ts), and none of
// them proves the composed body of the real call. Five mutations stay green
// on the WHOLE suite without this file:
//   (i)   a no-op stub (`noteUnresolved: async () => {}`)
//   (ii)  the upsert sent raw `item.context`, never composed
//   (iii) `composeUnresolvedContext` fed from something other than
//         `item.context` (a stale variable, a hardcoded string), so the
//         strip-then-append idempotence silently stops applying
//   (iv)  the note is HARDCODED (e.g. always `UNRESOLVED_TARGET_NOTE`)
//         instead of read from `unresolvedDirectiveNote(item)` -- the round-2
//         point-5 fix (two distinct, mutually exclusive recommendations)
//         silently regresses to one wrong recommendation half the time
//   (v)   the selector is REIMPLEMENTED inline instead of calling
//         `unresolvedDirectiveNote(item)` (e.g. a locally re-typed, possibly
//         INVERTED ternary on `target_peer_ids.length`) -- same regression
//         as (iv), reached without ever naming the shared helper
//
// index.ts imports electron and cannot be `import()`-ed under `bun test`
// (measured precedent: tests/desktop-idle-lock-wiring-sweep.test.ts's own
// header). This file reads it as TEXT instead and proves PRESENCE by
// brace-body extraction on the `noteUnresolved:` object-property arrow --
// same technique as that file's `extractBracedBody`, bounded strictly to
// this ONE block, never a slice running to end-of-file.
//
// HONEST SCOPE: this is a textual PRESENCE check, the weakest guard in the
// catalogue (same admission as tests/desktop-idle-lock-wiring-sweep.test.ts's
// own header) -- it does not execute the block, so a body that contains both
// required substrings in a NON-functional arrangement (e.g. inside a
// comment, or inside a branch that never runs) would still pass. It still
// kills all three mutations above, which is what it is for.

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const INDEX_PATH = join(import.meta.dir, "..", "desktop", "src", "main", "index.ts");
const SRC = readFileSync(INDEX_PATH, "utf-8");

const ANCHOR = "noteUnresolved: async (item) => {";

/**
 * Brace-balance body extractor (same convention as
 * tests/desktop-idle-lock-wiring-sweep.test.ts). Fails CLOSED: an anchor that
 * no longer matches (rename/reshape) throws rather than returning an empty,
 * vacuously-passing body.
 */
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

export function findNoteUnresolvedBody(src: string): string {
  const start = src.indexOf(ANCHOR);
  if (start < 0) {
    throw new Error(`"${ANCHOR}" not found -- has index.ts's noteUnresolved dep been renamed or reshaped?`);
  }
  const openIdx = start + ANCHOR.length - 1;
  return extractBracedBody(src, openIdx);
}

test("anti-vacuity: the noteUnresolved anchor appears exactly once in index.ts", () => {
  expect(SRC.split(ANCHOR)).toHaveLength(2);
});

test("PRESENCE: noteUnresolved composes item.context AND the real unresolvedDirectiveNote(item) selector through composeUnresolvedContext before upserting", () => {
  const body = findNoteUnresolvedBody(SRC);
  expect(body).toContain("composeUnresolvedContext(item.context");
  expect(body).toContain("upsertRoadmap(");
  // Round 3 point 2: without this, a hardcoded note or a reimplemented
  // (possibly inverted) selector both pass the two checks above unchanged.
  expect(body).toContain("unresolvedDirectiveNote(item)");
});

test("detector self-check: findNoteUnresolvedBody's PRESENCE check catches a no-op stub, a raw passthrough, a wrong-source compose call, a hardcoded note, and a reimplemented selector -- and passes the real shape", () => {
  const noop = `${ANCHOR}\n}`;
  expect(findNoteUnresolvedBody(noop)).not.toContain("composeUnresolvedContext(item.context");

  const passthrough = `${ANCHOR}\n  await upsertRoadmap(endpoint, key, { id: item.id, context: item.context })\n}`;
  expect(findNoteUnresolvedBody(passthrough)).not.toContain("composeUnresolvedContext(item.context");

  const wrongSource = `${ANCHOR}\n  const c = composeUnresolvedContext(someOtherVar, note)\n  await upsertRoadmap(endpoint, key, { id: item.id, context: c })\n}`;
  expect(findNoteUnresolvedBody(wrongSource)).not.toContain("composeUnresolvedContext(item.context");

  // (iv) hardcoded note: passes the first two checks, fails the third.
  const hardcoded = `${ANCHOR}\n  await upsertRoadmap(endpoint, key, { id: item.id, context: composeUnresolvedContext(item.context, UNRESOLVED_TARGET_NOTE) })\n}`;
  const hardcodedBody = findNoteUnresolvedBody(hardcoded);
  expect(hardcodedBody).toContain("composeUnresolvedContext(item.context");
  expect(hardcodedBody).not.toContain("unresolvedDirectiveNote(item)");

  // (v) selector reimplemented inline (here inverted, but any reimplementation
  // is caught the same way -- it never names the shared helper).
  const reimplemented = `${ANCHOR}\n  const note = item.target_peer_ids.length === 0 ? UNRESOLVED_TARGET_NOTE : NO_TARGET_REQUESTED_NOTE\n  await upsertRoadmap(endpoint, key, { id: item.id, context: composeUnresolvedContext(item.context, note) })\n}`;
  const reimplementedBody = findNoteUnresolvedBody(reimplemented);
  expect(reimplementedBody).toContain("composeUnresolvedContext(item.context");
  expect(reimplementedBody).not.toContain("unresolvedDirectiveNote(item)");

  // Negative control: the real, correct shape must not trip any of the above.
  const correct = `${ANCHOR}\n  await upsertRoadmap(endpoint, key, {\n    id: item.id,\n    context: composeUnresolvedContext(item.context, unresolvedDirectiveNote(item))\n  })\n}`;
  const correctBody = findNoteUnresolvedBody(correct);
  expect(correctBody).toContain("composeUnresolvedContext(item.context");
  expect(correctBody).toContain("upsertRoadmap(");
  expect(correctBody).toContain("unresolvedDirectiveNote(item)");
});
