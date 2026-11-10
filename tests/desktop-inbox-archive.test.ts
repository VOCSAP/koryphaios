import { expect, test } from "bun:test";
import { createApprovalListsTick, createInboxArchive } from "../desktop/src/main/inbox-archive.ts";
import { inboxEntryKey, type Approval, type InboxArchiveSnapshot } from "../desktop/src/shared/types.ts";

let seq = 0;

const SCOPE_A = "0:group-a:run-1";
const SCOPE_B = "1:group-a:run-2";

function rig() {
  const broadcasts: InboxArchiveSnapshot[] = [];
  const reports: string[] = [];
  const archive = createInboxArchive({
    onChange: (snapshot) => broadcasts.push(snapshot),
    report: (message) => reports.push(message)
  });
  return { archive, broadcasts, reports };
}

const row = (id: number, over: Record<string, unknown> = {}) => ({
  message_id: id,
  sent_at: "2026-01-01T00:00:00.000Z",
  state: "open",
  settled_at: null,
  ...over
});

const keyOf = (id: number): string =>
  inboxEntryKey({ kind: "message", message: { id, from: "", text: "", sentAt: "2026-01-01T00:00:00.000Z" } });

const closedQuestion = (id: string): Approval => ({ id, status: "closed" }) as unknown as Approval;

test("each read replaces its half: a row absent from the next snapshot is gone, never merged", () => {
  const { archive } = rig();
  archive.applyMessageStates(SCOPE_A, [row(1), row(2)], ++seq);
  archive.applyMessageStates(SCOPE_A, [row(2, { state: "closed", settled_at: "2026-01-01T00:00:05Z" })], ++seq);
  // Mutant: the snapshots are merged, which would keep message 1.
  expect(Object.keys(archive.snapshot().messages)).toEqual([keyOf(2)]);
  expect(archive.snapshot().messages[keyOf(2)]?.state).toBe("closed");
  archive.applyClosedQuestions(SCOPE_A, [closedQuestion("q1"), closedQuestion("q2")], ++seq);
  archive.applyClosedQuestions(SCOPE_A, [closedQuestion("q2")], ++seq);
  expect(archive.snapshot().closedQuestions.map((a) => a.id)).toEqual(["q2"]);
  expect(Object.keys(archive.snapshot().messages), "the other half is untouched").toEqual([keyOf(2)]);
});

test("a read under another scope starts from an empty archive: nothing of the previous run or group survives", () => {
  const { archive } = rig();
  archive.applyMessageStates(SCOPE_A, [row(1)], ++seq);
  archive.applyClosedQuestions(SCOPE_A, [closedQuestion("q1")], ++seq);
  archive.applyMessageStates(SCOPE_B, [row(7)], ++seq);
  // Mutant: the scope key is not compared (the closed question of run 1 stays under run 2).
  expect(archive.snapshot().closedQuestions).toEqual([]);
  expect(Object.keys(archive.snapshot().messages)).toEqual([keyOf(7)]);
  archive.applyClosedQuestions(SCOPE_A, [closedQuestion("q9")], ++seq);
  expect(Object.keys(archive.snapshot().messages), "the archive is last-writer-wins across scopes; callers guard the scope").toEqual([]);
});

test("a broker without the field makes the archive unsupported and says so once across ticks", () => {
  const { archive, reports } = rig();
  expect(archive.snapshot().status).toBe("pending");
  archive.applyMessageStates(SCOPE_A, undefined, ++seq);
  archive.applyMessageStates(SCOPE_A, undefined, ++seq);
  // Mutant: the trace is emitted at every tick; or `unsupported` treated as an empty ready snapshot.
  expect(archive.snapshot().status).toBe("unsupported");
  expect(reports).toHaveLength(1);
  archive.applyMessageStates(SCOPE_A, [row(1)], ++seq);
  expect(archive.snapshot().status).toBe("ready");
  archive.applyMessageStates(SCOPE_A, undefined, ++seq);
  expect(reports, "a broker that regresses is traced again").toHaveLength(2);
});

test("entries that are not a list are traced and treated as unsupported", () => {
  const { archive, reports } = rig();
  archive.applyMessageStates(SCOPE_A, { not: "a list" }, ++seq);
  expect(archive.snapshot().status).toBe("unsupported");
  expect(reports).toHaveLength(1);
});

test("rows with an invalid shape are dropped and traced once per tick, the valid ones kept", () => {
  const { archive, reports } = rig();
  const hostile = [
    row(1, { state: "deleted" }),
    row(2, { message_id: 2.5 }),
    row(3, { sent_at: "" }),
    row(4, { sent_at: "x".repeat(65) }),
    row(5, { closed_by_authority: "root" }),
    row(6, { close_reason: "r".repeat(501) }),
    row(7, { closed_by_peer_id: "p".repeat(65) }),
    row(8, { settled_at: 12 }),
    null,
    "text",
    row(9, { state: "closed", settled_at: "2026-01-01T00:00:05Z", close_reason: "done", closed_by_authority: "lead", closed_by_peer_id: null })
  ];
  archive.applyMessageStates(SCOPE_A, hostile, ++seq);
  // Mutant: the state enumeration is not validated (row 1 would be kept).
  expect(Object.keys(archive.snapshot().messages)).toEqual([keyOf(9)]);
  expect(archive.snapshot().messages[keyOf(9)]).toEqual({
    state: "closed",
    settledAt: "2026-01-01T00:00:05Z",
    closeReason: "done",
    closedByAuthority: "lead",
    closedByPeerId: null
  });
  expect(reports).toHaveLength(1);
  expect(reports[0]).toContain("10");
});

test("the reason bound counts code points, not UTF-16 units", () => {
  const { archive, reports } = rig();
  archive.applyMessageStates(SCOPE_A, [row(1, { state: "closed", close_reason: "\u{1F600}".repeat(500) })], ++seq);
  expect(Object.keys(archive.snapshot().messages), "500 code points are 1000 units and stay valid").toEqual([keyOf(1)]);
  expect(reports).toEqual([]);
});

test("nothing is broadcast, and the version does not move, when a read changes nothing", () => {
  const { archive, broadcasts } = rig();
  archive.applyMessageStates(SCOPE_A, [row(1)], ++seq);
  archive.applyClosedQuestions(SCOPE_A, [closedQuestion("q1")], ++seq);
  const version = archive.version();
  const sent = broadcasts.length;
  archive.applyMessageStates(SCOPE_A, [row(1)], ++seq);
  archive.applyClosedQuestions(SCOPE_A, [closedQuestion("q1")], ++seq);
  // Mutant: the signature compare removed.
  expect(broadcasts).toHaveLength(sent);
  expect(archive.version()).toBe(version);
  archive.applyMessageStates(SCOPE_A, [row(1, { state: "responded", settled_at: "2026-01-01T00:00:09Z" })], ++seq);
  expect(broadcasts).toHaveLength(sent + 1);
  expect(archive.version()).toBe(version + 1);
  expect(broadcasts.at(-1)).toEqual(archive.snapshot());
});

test("only closed questions with an id are kept, and the rest is traced", () => {
  const { archive, reports } = rig();
  archive.applyClosedQuestions(SCOPE_A, [
    closedQuestion("q1"),
    { id: "q2", status: "pending" } as unknown as Approval,
    { status: "closed" } as unknown as Approval
  ], ++seq);
  expect(archive.snapshot().closedQuestions.map((a) => a.id)).toEqual(["q1"]);
  expect(reports).toHaveLength(1);
});

test("a snapshot read before the last applied one of the same scope is ignored, for both halves", () => {
  const { archive } = rig();
  const early = ++seq;
  const late = ++seq;
  archive.applyMessageStates(SCOPE_A, [row(1, { state: "responded", settled_at: "2026-01-01T00:00:09Z" })], late);
  // Mutant: the sequence is not compared (the older read restores 'open').
  archive.applyMessageStates(SCOPE_A, [row(1)], early);
  expect(archive.snapshot().messages[keyOf(1)]?.state).toBe("responded");
  archive.applyClosedQuestions(SCOPE_A, [closedQuestion("q1")], late);
  archive.applyClosedQuestions(SCOPE_A, [], early);
  expect(archive.snapshot().closedQuestions.map((a) => a.id)).toEqual(["q1"]);
  archive.applyMessageStates(SCOPE_A, [row(1, { state: "closed", settled_at: "2026-01-01T00:00:10Z" })], late);
  expect(archive.snapshot().messages[keyOf(1)]?.state, "a read of the same sequence still applies").toBe("closed");
});

test("the sequence restarts with the scope: a new run's first read is not taken for a stale one", () => {
  const { archive } = rig();
  archive.applyMessageStates(SCOPE_A, [row(1)], 50);
  archive.applyMessageStates(SCOPE_B, [row(2)], 3);
  expect(Object.keys(archive.snapshot().messages)).toEqual([keyOf(2)]);
});

test("a closed question's agent-supplied closure fields are bounded like a message's, the rest of the row kept", () => {
  const { archive, reports } = rig();
  const hostile = {
    id: "q1",
    status: "closed",
    close_reason: "r".repeat(501),
    closed_by_authority: "root",
    closed_by_peer_id: "p".repeat(65)
  } as unknown as Approval;
  const fine = { id: "q2", status: "closed", close_reason: "ok", closed_by_authority: "lead", closed_by_peer_id: null } as unknown as Approval;
  archive.applyClosedQuestions(SCOPE_A, [hostile, fine], ++seq);
  const [first, second] = archive.snapshot().closedQuestions;
  // Mutant: the closure fields are passed through unbounded.
  expect(first).toEqual({ id: "q1", status: "closed" });
  expect(second).toEqual(fine);
  expect(reports).toHaveLength(1);
});

test("dropped rows are traced when their count changes, not on every tick", () => {
  const { archive, reports } = rig();
  const bad = row(1, { state: "deleted" });
  for (let i = 0; i < 3; i++) archive.applyMessageStates(SCOPE_A, [bad], ++seq);
  // Mutant: the last count is not kept (one trace per tick).
  expect(reports).toHaveLength(1);
  archive.applyMessageStates(SCOPE_A, [bad, row(2, { state: "deleted" })], ++seq);
  expect(reports, "a different count is traced").toHaveLength(2);
  archive.applyMessageStates(SCOPE_A, [], ++seq);
  archive.applyMessageStates(SCOPE_A, [bad], ++seq);
  expect(reports, "a clean tick re-arms the trace").toHaveLength(3);
  const closed = { id: "q1", status: "pending" } as unknown as Approval;
  for (let i = 0; i < 3; i++) archive.applyClosedQuestions(SCOPE_A, [closed], ++seq);
  expect(reports).toHaveLength(4);
});

function tickRig(over: { scope?: () => string | null; fetch?: () => Promise<Approval[]>; deps?: () => object | null } = {}) {
  const events: string[] = [];
  let next = 100;
  const reports: string[] = [];
  const applied: Array<{ scope: string; ids: string[]; seq: number }> = [];
  const tick = createApprovalListsTick({
    deps: over.deps ?? (() => ({})),
    scopeKey: over.scope ?? (() => SCOPE_A),
    fetchClosed:
      over.fetch ??
      (async () => {
        events.push("closed:start");
        await Promise.resolve();
        events.push("closed:end");
        return [closedQuestion("q1")];
      }),
    applyClosed: (scope, list, s) => {
      events.push("closed:apply");
      applied.push({ scope, ids: list.map((a) => a.id), seq: s });
    },
    nextSeq: () => ++next,
    pending: async () => {
      events.push("pending");
    },
    report: (message) => reports.push(message)
  });
  return { tick, events, reports, applied };
}

test("a tick applies the closed list before the pending list starts", async () => {
  const { tick, events, applied } = tickRig();
  await tick();
  // Mutant: pending first, or both lists started together.
  expect(events).toEqual(["closed:start", "closed:end", "closed:apply", "pending"]);
  expect(applied).toEqual([{ scope: SCOPE_A, ids: ["q1"], seq: 101 }]);
});

test("a closed list read for a scope that changed meanwhile is not applied, the pending list still runs", async () => {
  let scope = SCOPE_A;
  const { tick, events, applied } = tickRig({
    scope: () => scope,
    fetch: async () => {
      scope = SCOPE_B;
      return [closedQuestion("q1")];
    }
  });
  await tick();
  // Mutant: the scope re-check after the read is skipped.
  expect(applied).toEqual([]);
  expect(events).toEqual(["pending"]);
});

test("without credentials or a run the closed list is not read, the pending list still runs", async () => {
  let fetched = 0;
  const countFetch = async () => {
    fetched++;
    return [];
  };
  const noDeps = tickRig({ deps: () => null, fetch: countFetch });
  await noDeps.tick();
  const noRun = tickRig({ scope: () => null, fetch: countFetch });
  await noRun.tick();
  expect(fetched).toBe(0);
  expect(noDeps.events).toEqual(["pending"]);
  expect(noRun.events).toEqual(["pending"]);
});

test("a failing closed read is traced once until a tick succeeds, and never stops the pending list", async () => {
  let fail = true;
  const { tick, events, reports } = tickRig({
    fetch: async () => {
      if (fail) throw new Error("ECONNREFUSED");
      return [];
    }
  });
  await tick();
  await tick();
  expect(reports).toHaveLength(1);
  expect(events.filter((e) => e === "pending")).toHaveLength(2);
  fail = false;
  await tick();
  fail = true;
  await tick();
  expect(reports).toHaveLength(2);
});
