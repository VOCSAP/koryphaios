// Operator-inbox disk persistence (desktop/src/main/inbox-store). Covers
// load/append round-trip, dedupe by id, cap, corruption, and (Courrier lot
// 1D/1E, card 1e81ee7b) the two purge-side writers: clearInboxHistory (full
// truncate, session-scope purge) and deleteInboxHistoryEntries (by-id manual
// delete). This journal is the only durable copy across Deck restarts for a
// reason that has nothing to do with the broker drain being destructive
// anymore (it is not, since lot 1A) -- see inbox-store.ts's header comment:
// session_id is minted in-memory and never survives a restart either.

import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendInboxHistory,
  clearInboxHistory,
  deleteInboxHistoryEntries,
  inboxHistoryFile,
  loadInboxHistory,
} from "../desktop/src/main/inbox-store.ts";
import type { InboxMessage } from "../desktop/src/shared/types.ts";

function dir(): string {
  return mkdtempSync(join(tmpdir(), "cp-inbox-"));
}

function msg(id: number, text = `t${id}`): InboxMessage {
  return { id, from: "coder-1", text, sentAt: new Date(1700000000000 + id).toISOString() };
}

test("append + load round-trips across 'restarts' (fresh loads)", () => {
  const d = dir();
  appendInboxHistory(d, [msg(1), msg(2)]);
  appendInboxHistory(d, [msg(3)]);
  const loaded = loadInboxHistory(d);
  expect(loaded.map((m) => m.id)).toEqual([1, 2, 3]);
  expect(loaded[0]!.text).toBe("t1");
});

test("append dedupes by broker id (retry after a crash must not duplicate)", () => {
  const d = dir();
  appendInboxHistory(d, [msg(1), msg(2)]);
  const merged = appendInboxHistory(d, [msg(2), msg(3)]);
  expect(merged.map((m) => m.id)).toEqual([1, 2, 3]);
});

test("history is capped, oldest first out", () => {
  const d = dir();
  appendInboxHistory(d, [msg(1), msg(2), msg(3)], 2);
  expect(loadInboxHistory(d).map((m) => m.id)).toEqual([2, 3]);
});

test("missing or corrupt file loads as empty, then recovers on append", () => {
  const d = dir();
  expect(loadInboxHistory(d)).toEqual([]);
  writeFileSync(inboxHistoryFile(d), "{not json", "utf-8");
  expect(loadInboxHistory(d)).toEqual([]);
  appendInboxHistory(d, [msg(7)]);
  expect(loadInboxHistory(d).map((m) => m.id)).toEqual([7]);
});

test("malformed entries are filtered on load", () => {
  const d = dir();
  writeFileSync(
    inboxHistoryFile(d),
    JSON.stringify([msg(1), { id: "bad" }, null, { id: 2, from: "a", text: "b", sentAt: "c" }]),
    "utf-8"
  );
  expect(loadInboxHistory(d).map((m) => m.id)).toEqual([1, 2]);
});

test("a failed persist invokes onPersistError instead of swallowing (PLAN O6)", () => {
  const d = dir();
  // Block the state dir with a regular file so mkdir/write fails.
  const blocked = join(d, "not-a-dir");
  writeFileSync(blocked, "occupied");
  const errors: unknown[] = [];
  const merged = appendInboxHistory(join(blocked, "state"), [msg(1)], undefined, (e) =>
    errors.push(e)
  );
  // The in-memory merge still works; the failure is reported, not hidden.
  expect(merged.map((m) => m.id)).toEqual([1]);
  expect(errors.length).toBe(1);
});

// --- Courrier lot 1D: clearInboxHistory (session-scope purge) ---------------

test("clearInboxHistory truncates the whole journal to empty", () => {
  const d = dir();
  appendInboxHistory(d, [msg(1), msg(2), msg(3)]);
  clearInboxHistory(d);
  expect(loadInboxHistory(d)).toEqual([]);
});

test("clearInboxHistory on a never-written dir leaves it empty, not an error", () => {
  const d = dir();
  clearInboxHistory(d);
  expect(loadInboxHistory(d)).toEqual([]);
});

test("clearInboxHistory reports a failed persist via onPersistError, same contract as appendInboxHistory", () => {
  const d = dir();
  const blocked = join(d, "not-a-dir");
  writeFileSync(blocked, "occupied");
  const errors: unknown[] = [];
  clearInboxHistory(join(blocked, "state"), (e) => errors.push(e));
  expect(errors.length).toBe(1);
});

// --- Courrier lot 1E: deleteInboxHistoryEntries (manual delete) -------------

test("deleteInboxHistoryEntries removes only the named ids, oldest-first remainder", () => {
  const d = dir();
  appendInboxHistory(d, [msg(1), msg(2), msg(3)]);
  const remaining = deleteInboxHistoryEntries(d, [2]);
  expect(remaining.map((m) => m.id)).toEqual([1, 3]);
  expect(loadInboxHistory(d).map((m) => m.id)).toEqual([1, 3]);
});

test("deleteInboxHistoryEntries with an empty or unknown-id list is a 0-effect no-op", () => {
  const d = dir();
  appendInboxHistory(d, [msg(1), msg(2)]);
  expect(deleteInboxHistoryEntries(d, []).map((m) => m.id)).toEqual([1, 2]);
  expect(deleteInboxHistoryEntries(d, [999]).map((m) => m.id)).toEqual([1, 2]);
  expect(loadInboxHistory(d).map((m) => m.id)).toEqual([1, 2]);
});
