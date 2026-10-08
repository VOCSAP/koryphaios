import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendAckedKey,
  appendInboxHistory,
  appendSeenKey,
  clearInboxHistory,
  countPendingInbox,
  deleteInboxHistoryEntries,
  inboxAckFile,
  INBOX_HISTORY_CAP,
  inboxHistoryFile,
  loadInboxHistory,
  pendingInboxCounter,
} from "../desktop/src/main/inbox-store.ts";
import { countPendingInboxMessages } from "../desktop/src/shared/inbox-pending.ts";
import { inboxEntryKey, type InboxMessage } from "../desktop/src/shared/types.ts";

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
  const traces: string[] = [];
  const sink = (message: string): void => void traces.push(message);
  expect(loadInboxHistory(d, sink)).toEqual([]);
  expect(traces, "an absent journal is a normal empty state").toEqual([]);
  writeFileSync(inboxHistoryFile(d), "{not json", "utf-8");
  expect(loadInboxHistory(d, sink)).toEqual([]);
  expect(traces).toHaveLength(1);
  expect(traces[0]).toContain("is not valid JSON");
  appendInboxHistory(d, [msg(7)]);
  expect(loadInboxHistory(d, sink).map((m) => m.id)).toEqual([7]);
  expect(traces).toHaveLength(1);
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

const key = (m: InboxMessage): string => inboxEntryKey({ kind: "message", message: m });

test("a message counts as pending until acked: unread and seen both count", () => {
  const messages = [msg(1), msg(2), msg(3)];
  const ack = { [key(msg(2))]: "seen" as const, [key(msg(3))]: "acked" as const };
  expect(countPendingInboxMessages(messages, ack)).toBe(2);
  expect(countPendingInbox(messages, [], ack)).toBe(2);
});

test("main counts the journal plus the unjournaled batches once each, capped like the renderer list", () => {
  expect(countPendingInbox([msg(1), msg(2)], [msg(2), msg(3)], {})).toBe(3);
  const many = Array.from({ length: INBOX_HISTORY_CAP + 10 }, (_, i) => msg(i + 1));
  const ackOldest = Object.fromEntries(many.slice(0, 10).map((m) => [key(m), "acked" as const]));
  expect(countPendingInbox(many, [], {}), "only the newest entries stay in the list").toBe(INBOX_HISTORY_CAP);
  expect(countPendingInbox(many, [], ackOldest), "acks on entries past the cap change nothing").toBe(INBOX_HISTORY_CAP);
});

test("the Avatar's counter follows the journal and the ack file on disk, and the unjournaled batches", () => {
  const d = dir();
  const unjournaled: InboxMessage[] = [];
  const count = pendingInboxCounter(() => d, () => unjournaled);
  expect(count()).toBe(0);
  appendInboxHistory(d, [msg(1), msg(2)]);
  expect(count()).toBe(2);
  appendSeenKey(d, key(msg(1)));
  expect(count(), "seen is still pending").toBe(2);
  appendAckedKey(d, key(msg(1)));
  expect(count()).toBe(1);
  unjournaled.push(msg(3));
  expect(count()).toBe(2);
});

test("the Avatar's counter traces a corrupt journal once per file change, not on every heartbeat", () => {
  const d = dir();
  const traces: string[] = [];
  const count = pendingInboxCounter(() => d, () => [], (message) => void traces.push(message));
  for (let i = 0; i < 3; i++) expect(count()).toBe(0);
  expect(traces, "absent files are a normal empty state").toEqual([]);

  writeFileSync(inboxHistoryFile(d), "{not json", "utf-8");
  writeFileSync(inboxAckFile(d), "[1]", "utf-8");
  for (let i = 0; i < 3; i++) expect(count()).toBe(0);
  expect(traces).toHaveLength(2);
  expect(traces.some((t) => t.includes("is not valid JSON"))).toBe(true);
  expect(traces.some((t) => t.includes("is not an object"))).toBe(true);

  writeFileSync(inboxHistoryFile(d), "{still not json}", "utf-8");
  count();
  expect(traces, "a new corrupt version is traced again").toHaveLength(4);
});

test("a journal that cannot be read for another reason than absence is traced", () => {
  const d = dir();
  mkdirSync(inboxHistoryFile(d));
  const traces: string[] = [];
  expect(loadInboxHistory(d, (message) => void traces.push(message))).toEqual([]);
  expect(traces).toHaveLength(1);
  expect(traces[0]).toContain("unreadable");
});

test("a journal holding valid JSON that is not a list is traced", () => {
  const d = dir();
  writeFileSync(inboxHistoryFile(d), JSON.stringify({ id: 1 }), "utf-8");
  const traces: string[] = [];
  expect(loadInboxHistory(d, (message) => void traces.push(message))).toEqual([]);
  expect(traces).toHaveLength(1);
  expect(traces[0]).toContain("is not a list");
});

test("the counter sees a seen -> acked move even when the ack file keeps its size and its mtime", () => {
  const d = dir();
  appendInboxHistory(d, [msg(1)]);
  appendSeenKey(d, key(msg(1)));
  const frozen = new Date(1_700_000_000_000);
  utimesSync(inboxAckFile(d), frozen, frozen);
  const count = pendingInboxCounter(() => d, () => []);
  expect(count()).toBe(1);
  const before = statSync(inboxAckFile(d), { bigint: true });
  appendAckedKey(d, key(msg(1)));
  utimesSync(inboxAckFile(d), frozen, frozen);
  const after = statSync(inboxAckFile(d), { bigint: true });
  expect([after.size, after.mtimeNs], "the move keeps the size and the mtime").toEqual([before.size, before.mtimeNs]);
  expect(count()).toBe(0);
});

test("the Courrier badge in the renderer counts with the same rule as main", () => {
  const store = readFileSync(join(import.meta.dir, "..", "desktop", "src", "renderer", "src", "store.ts"), "utf8");
  const start = store.indexOf("export function inboxPendingCount(");
  const body = store.slice(start, store.indexOf("\n}", start));
  expect(start, "inboxPendingCount still exists").toBeGreaterThan(-1);
  expect(body).toMatch(/return countPendingInboxMessages\(s\.inboxMessages, s\.inboxAckState\)/);
});
