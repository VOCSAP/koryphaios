import { describe, expect, test } from "bun:test";
import {
  pendingQuestionTarget,
  type PendingQuestionRow,
  type PendingQuestionSession,
} from "../desktop/src/main/pending-question-target";

function row(overrides: Partial<PendingQuestionRow> & { id: string; created_at: string }): PendingQuestionRow {
  return { reply_route: "channel", status: "pending", origin: { tile_ref: "" }, ...overrides };
}

function session(id: string, needsAttention = false): PendingQuestionSession {
  return { id, needsAttention };
}

describe("pendingQuestionTarget", () => {
  test("opens the Courrier on the OLDEST open row, whatever the list order", () => {
    const rows = [
      row({ id: "newer", created_at: "2026-10-16T10:00:02.000Z" }),
      row({ id: "oldest", created_at: "2026-10-16T10:00:00.000Z" }),
      row({ id: "middle", created_at: "2026-10-16T10:00:01.000Z" }),
    ];
    expect(pendingQuestionTarget(rows, [])).toEqual({ kind: "inbox", approvalId: "oldest" });
  });

  test("a settled row is not a pending question, even when it is the oldest", () => {
    const rows = [
      row({ id: "answered", created_at: "2026-10-16T09:00:00.000Z", status: "answered" }),
      row({ id: "expired", created_at: "2026-10-16T09:30:00.000Z", status: "expired_notif" }),
    ];
    expect(pendingQuestionTarget(rows, [])).toEqual({ kind: "inbox", approvalId: "expired" });
  });

  test("the oldest row awaited by a live tile's module focuses that tile", () => {
    const rows = [
      row({ id: "hook", created_at: "2026-10-16T10:00:00.000Z", reply_route: "hook", origin: { tile_ref: "t2" } }),
      row({ id: "mail", created_at: "2026-10-16T10:00:05.000Z" }),
    ];
    expect(pendingQuestionTarget(rows, [session("t1", true), session("t2", true)])).toEqual({ kind: "tile", id: "t2" });
  });

  test("a hook row whose tile is gone has no answer panel: the Courrier opens on it", () => {
    const rows = [
      row({ id: "orphan", created_at: "2026-10-16T10:00:00.000Z", reply_route: "hook", origin: { tile_ref: "gone" } }),
    ];
    expect(pendingQuestionTarget(rows, [session("t1", true)])).toEqual({ kind: "inbox", approvalId: "orphan" });
  });

  test("a non-hook row carrying a tile_ref still opens the Courrier", () => {
    const rows = [row({ id: "pty", created_at: "2026-10-16T10:00:00.000Z", reply_route: "pty", origin: { tile_ref: "t1" } })];
    expect(pendingQuestionTarget(rows, [session("t1", true)])).toEqual({ kind: "inbox", approvalId: "pty" });
  });

  test("no open row: the first waiting tile in the service's order", () => {
    const sessions = [session("t1"), session("t2", true), session("t3", true)];
    expect(pendingQuestionTarget([], sessions)).toEqual({ kind: "tile", id: "t2" });
  });

  test("nothing waits: none, which the caller treats as a plain focus", () => {
    expect(pendingQuestionTarget([], [session("t1")])).toEqual({ kind: "none" });
    expect(
      pendingQuestionTarget([row({ id: "done", created_at: "2026-10-16T10:00:00.000Z", status: "declined" })], [])
    ).toEqual({ kind: "none" });
  });
});
