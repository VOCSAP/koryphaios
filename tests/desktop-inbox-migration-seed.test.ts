// loadAckStateWithMigrationSeed runs once per Deck, on the very first read of
// ack state; a defect here silently erases whatever the operator had not yet
// processed, once, unreproducibly.
// existsSync is checked before any read, never inferred from a parse/read
// failure -- treating a corrupt file as absent would mass-ack real unacked
// state.

import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendInboxHistory, inboxAckFile, loadAckStateWithMigrationSeed } from "../desktop/src/main/inbox-store.ts";
import type { InboxMessage } from "../desktop/src/shared/types.ts";

function dir(): string {
  return mkdtempSync(join(tmpdir(), "cp-inbox-migration-"));
}

function msg(id: number, sentAt = `2020-01-01T00:00:00.${String(id).padStart(3, "0")}Z`): InboxMessage {
  return { id, from: "coder-1", text: `t${id}`, sentAt };
}

test("case 1: absent ack file + non-empty history -> every history entry seeded acked", () => {
  const d = dir();
  appendInboxHistory(d, [msg(1), msg(2)]);
  const state = loadAckStateWithMigrationSeed(d);
  expect(Object.values(state)).toEqual(["acked", "acked"]);
  expect(Object.keys(state)).toHaveLength(2);
});

test("case 2: absent ack file + EMPTY history -> file still written (existence-keyed idempotence)", () => {
  const d = dir();
  const state = loadAckStateWithMigrationSeed(d);
  expect(state).toEqual({});
  // The decisive assertion: the file must exist on disk after this call,
  // even though nothing was seeded into it -- otherwise idempotence is
  // keyed on CONTENT (non-empty seed) rather than on the call having
  // happened at all, and the seed will fire again indefinitely while the
  // inbox stays empty.
  expect(() => readFileSync(inboxAckFile(d), "utf-8")).not.toThrow();
});

test("case 3: corrupt ack file is PRESENT (not absent) -- no seed, degrades to empty, not mass-ack", () => {
  const d = dir();
  // Real history entries present: if corruption incorrectly triggered the
  // seed, this test would observe all-acked instead of empty -- the two
  // outcomes must be distinguishable, so the fixture needs real history.
  appendInboxHistory(d, [msg(1), msg(2), msg(3)]);
  writeFileSync(inboxAckFile(d), "{not valid json", "utf-8");
  const state = loadAckStateWithMigrationSeed(d);
  expect(state).toEqual({});
});

test("case 4: a repeated call after the file exists does not rewrite it and does not reseed", () => {
  const d = dir();
  appendInboxHistory(d, [msg(1)]);
  loadAckStateWithMigrationSeed(d);
  const before = readFileSync(inboxAckFile(d), "utf-8");
  const state2 = loadAckStateWithMigrationSeed(d);
  const after = readFileSync(inboxAckFile(d), "utf-8");
  expect(after).toBe(before);
  expect(Object.keys(state2)).toHaveLength(1);
});

test("case 5: a message added to history strictly AFTER the seed is absent from ack state on a later call", () => {
  const d = dir();
  appendInboxHistory(d, [msg(1)]);
  const first = loadAckStateWithMigrationSeed(d);
  expect(Object.keys(first)).toHaveLength(1);

  appendInboxHistory(d, [msg(2)]); // arrives after the seed already ran
  const second = loadAckStateWithMigrationSeed(d);
  expect(Object.keys(second)).toHaveLength(1); // msg(2) never gets seeded
});

test("decisive (case 2 corollary): a message added after an EMPTY-history seed is not swept up by a second call", () => {
  const d = dir();
  const first = loadAckStateWithMigrationSeed(d); // no history yet
  expect(first).toEqual({});

  appendInboxHistory(d, [msg(1)]); // added strictly after the (empty) seed
  const second = loadAckStateWithMigrationSeed(d);
  // If the empty-history call had skipped writing the ack file (mutation
  // B below), the file would still be absent here, and this second call
  // would incorrectly reseed msg(1) as acked -- exactly the "operator's
  // real inbox silently erased" failure this whole test exists to catch.
  expect(second).toEqual({});
});

test("onPersistError fires on a genuine write failure during the seed path (mirrors PLAN O6)", () => {
  const d = dir();
  const blocked = join(d, "not-a-dir");
  writeFileSync(blocked, "occupied");
  const errors: unknown[] = [];
  loadAckStateWithMigrationSeed(join(blocked, "state"), (e) => errors.push(e));
  expect(errors.length).toBe(1);
});
