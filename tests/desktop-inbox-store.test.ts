// Operator-inbox disk persistence (desktop/src/main/inbox-store): the broker
// drain is destructive, so this journal is the only durable copy across Deck
// restarts. Covers load/append round-trip, dedupe by id, cap, corruption.

import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendInboxHistory,
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
