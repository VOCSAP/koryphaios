// index.ts imports electron and cannot be import()-ed under bun test, so this
// reads it as text and proves presence by brace-body extraction on the
// `noteUnresolved:` object-property arrow, bounded strictly to that one block.
// Textual presence is the weakest guard in the catalogue: it does not execute
// the block, so both required substrings appearing in a non-functional
// arrangement (a comment, a dead branch) would still pass. It still kills the
// mutations it targets: a no-op stub, an uncomposed context, a context fed from
// the wrong source, a hardcoded note, and a reimplemented (possibly inverted)
// selector.

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractBracedBody } from "./_braced-body";

const INDEX_PATH = join(import.meta.dir, "..", "desktop", "src", "main", "index.ts");
const SRC = readFileSync(INDEX_PATH, "utf-8");

const ANCHOR = "noteUnresolved: async (item) => {";

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
