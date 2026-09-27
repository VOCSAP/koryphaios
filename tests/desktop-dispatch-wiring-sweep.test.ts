// index.ts imports electron and cannot be import()-ed under bun test, so this
// reads it as text and proves presence by brace-body extraction on the
// `noteUnresolved:` object-property arrow, bounded strictly to that one block.
// Textual presence is the weakest guard in the catalogue: it does not execute
// the block, so the required call appearing in a non-functional arrangement (a
// comment, a dead branch) would still pass. It still kills the mutations it
// targets: a no-op stub, a whole-context upsert that overwrites a concurrent
// append, a note appended to the wrong card, a hardcoded note, and a
// reimplemented (possibly inverted) selector.

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractBracedBody } from "./_braced-body";

const INDEX_PATH = join(import.meta.dir, "..", "desktop", "src", "main", "index.ts");
const SRC = readFileSync(INDEX_PATH, "utf-8");

const ANCHOR = "noteUnresolved: async (item) => {";
const REQUIRED_CALL = "appendRoadmapContext(endpoint, item.id, unresolvedDirectiveNote(item))";

export function findNoteUnresolvedBody(src: string): string {
  const start = src.indexOf(ANCHOR);
  if (start < 0) {
    throw new Error(`"${ANCHOR}" not found -- has index.ts's noteUnresolved dep been renamed or reshaped?`);
  }
  const openIdx = start + ANCHOR.length - 1;
  return extractBracedBody(src, openIdx);
}

function appendsTheSelectedNote(body: string): boolean {
  return body.includes(REQUIRED_CALL) && !body.includes("upsertRoadmap(");
}

test("anti-vacuity: the noteUnresolved anchor appears exactly once in index.ts", () => {
  expect(SRC.split(ANCHOR)).toHaveLength(2);
});

test("PRESENCE: noteUnresolved appends the real unresolvedDirectiveNote(item) through the append route, never a whole-context upsert", () => {
  expect(appendsTheSelectedNote(findNoteUnresolvedBody(SRC))).toBe(true);
});

test("detector self-check: the PRESENCE predicate rejects a no-op stub, a whole-context upsert, a wrong card id, a hardcoded note and a reimplemented selector -- and accepts the real shape", () => {
  const mutants: Record<string, string> = {
    noop: `${ANCHOR}\n}`,
    upsertOverwrite: `${ANCHOR}\n  await upsertRoadmap(endpoint, key, { id: item.id, context: item.context + unresolvedDirectiveNote(item) })\n}`,
    upsertAlongside: `${ANCHOR}\n  await ${REQUIRED_CALL}\n  await upsertRoadmap(endpoint, key, { id: item.id, context: item.context })\n}`,
    wrongCard: `${ANCHOR}\n  await appendRoadmapContext(endpoint, otherId, unresolvedDirectiveNote(item))\n}`,
    hardcoded: `${ANCHOR}\n  await appendRoadmapContext(endpoint, item.id, UNRESOLVED_TARGET_NOTE)\n}`,
    reimplemented: `${ANCHOR}\n  const note = item.target_peer_ids.length === 0 ? UNRESOLVED_TARGET_NOTE : NO_TARGET_REQUESTED_NOTE\n  await appendRoadmapContext(endpoint, item.id, note)\n}`,
  };
  for (const [name, src] of Object.entries(mutants)) {
    expect({ name, accepted: appendsTheSelectedNote(findNoteUnresolvedBody(src)) }).toEqual({ name, accepted: false });
  }

  const correct = `${ANCHOR}\n  await ${REQUIRED_CALL}\n}`;
  expect(appendsTheSelectedNote(findNoteUnresolvedBody(correct))).toBe(true);
});
