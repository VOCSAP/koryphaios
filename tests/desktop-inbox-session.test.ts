import { test, expect, afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendInboxHistory, inboxHistoryFile, loadInboxHistory } from "../desktop/src/main/inbox-store.ts";
import { createSessionDirAccessor, sessionStateDir } from "../desktop/src/main/session-state.ts";
import {
  createInboxEffects,
  createInboxSessionTracker,
  purgeInboxSessionCore,
  deleteInboxEntriesCore,
  classifyInboxDeleteIds,
  readOperatorInboxBoth,
  createRunInboxSigner,
  createRunReadErrorSink,
  purgeInboxDomains,
  applyInboxEffectsForScope,
  pollInboxForCapturedScope,
} from "../desktop/src/main/inbox-session.ts";
import type { InboxEffectsScope } from "../desktop/src/main/inbox-session.ts";

test("a response from a previous group has no inbox effects", () => {
  const effects: string[] = [];
  const applied = applyInboxEffectsForScope(
    { groupId: "P", sessionId: "p", directory: "P-dir" },
    () => ({ groupId: "N", sessionId: "n", directory: "N-dir" }),
    (context) => effects.push(context.directory),
  );
  expect(applied).toBe(false);
  expect(effects).toEqual([]);
});

test("a response whose group alone changed, same epoch and session, has no inbox effects", () => {
  const effects: string[] = [];
  const applied = applyInboxEffectsForScope(
    { epoch: 1, groupId: "P", sessionId: "s", directory: "P-dir" },
    () => ({ epoch: 1, groupId: "N", sessionId: "s", directory: "N-dir" }),
    (context) => effects.push(context.directory),
  );
  expect(applied, "the groupId comparison is the only thing refusing this response").toBe(false);
  expect(effects).toEqual([]);
});

test("the run signer only covers the active group, and signs with the operator for the door asked", () => {
  const state = { run: { runRef: "run-1", groupId: "g-one" } as { runRef: string; groupId: string } | null, active: "g-one", operator: "op" as string | null };
  const signed: Array<[string, Record<string, unknown>, string]> = [];
  const signer = createRunInboxSigner({
    inboxRun: () => state.run,
    operator: () => state.operator,
    activeGroupId: () => state.active,
    sign: (identity, body, door) => {
      signed.push([identity, body, door]);
      return { door };
    },
  });

  const current = signer();
  expect(current?.runRef).toBe("run-1");
  expect(current?.sign({ a: 1 }, "purge")).toEqual({ door: "purge" });
  expect(signed).toEqual([["op", { a: 1 }, "purge"]]);

  state.active = "g-two";
  expect(signer(), "a credential minted for another group never signs this one").toBeUndefined();
  state.active = "g-one";
  state.operator = null;
  expect(signer()).toBeUndefined();
  state.operator = "op";
  state.run = null;
  expect(signer()).toBeUndefined();
});

test("both domains are purged, the deletions of both are counted, and each refusal is reported on its own", async () => {
  const run = { runRef: "run-1", sign: () => ({}) };
  const purged: Array<string> = [];
  const deleted = await purgeInboxDomains({
    purge: async (signer) => {
      purged.push(signer ? "run" : "legacy");
      return signer ? 3 : 2;
    },
    run,
    onRejection: () => {
      throw new Error("no refusal expected");
    },
  });
  expect({ deleted, purged }).toEqual({ deleted: 5, purged: ["legacy", "run"] });

  const rejections: Array<[string, string]> = [];
  const none = await purgeInboxDomains({
    purge: async (signer) => {
      throw new Error(signer ? "run refused" : "legacy refused");
    },
    run,
    onRejection: (domain, e) => rejections.push([domain, (e as Error).message]),
  });
  expect(none).toBe(0);
  expect(rejections).toEqual([
    ["legacy", "legacy refused"],
    ["run", "run refused"],
  ]);

  const legacyOnly: string[] = [];
  await purgeInboxDomains({ purge: async (s) => (legacyOnly.push(s ? "run" : "legacy"), 0), run: undefined, onRejection: () => {} });
  expect(legacyOnly).toEqual(["legacy"]);
});

test("a run read failure is reported once per distinct cause, and again after a success", () => {
  const reports: string[] = [];
  const sink = createRunReadErrorSink((_message, e) => reports.push((e as Error).message));
  sink.onRunError(new Error("403 no live credential"));
  sink.onRunError(new Error("403 no live credential"));
  sink.onRunError(new Error("ECONNRESET"));
  sink.onRunSuccess();
  sink.onRunError(new Error("ECONNRESET"));
  expect(reports).toEqual(["403 no live credential", "ECONNRESET", "ECONNRESET"]);
});

test("the legacy and run reads merge by id: a notification returned by both is shown once, in id order", async () => {
  const merged = await readOperatorInboxBoth({
    readLegacy: async () => [{ id: 3, text: "system" }, { id: 1, text: "legacy" }],
    readRun: async () => [{ id: 2, text: "attested" }, { id: 3, text: "system" }],
    onRunError: () => {
      throw new Error("no run error expected");
    },
  });
  expect(merged.map((m) => m.id)).toEqual([1, 2, 3]);
});

test("a failed run read is reported and never hides the legacy read; a failed legacy read rejects", async () => {
  const errors: unknown[] = [];
  const merged = await readOperatorInboxBoth({
    readLegacy: async () => [{ id: 1 }],
    readRun: async () => {
      throw new Error("no live credential for this run");
    },
    onRunError: (e) => errors.push(e),
  });
  expect(merged.map((m) => m.id)).toEqual([1]);
  expect(errors).toHaveLength(1);
  let runReads = 0;
  await expect(
    readOperatorInboxBoth({
      readLegacy: async () => {
        throw new Error("ECONNREFUSED");
      },
      readRun: async () => {
        runReads++;
        return [{ id: 2 }];
      },
      onRunError: () => {},
    }),
  ).rejects.toThrow("ECONNREFUSED");
  expect(runReads, "a failed legacy read never advances the run cursor").toBe(0);
});

test("without a run read only the legacy entries come back", async () => {
  const merged = await readOperatorInboxBoth({ readLegacy: async () => [{ id: 5 }], onRunError: () => {} });
  expect(merged.map((m) => m.id)).toEqual([5]);
});

function pollRig(initial: InboxEffectsScope, whileReading: (state: InboxEffectsScope) => void) {
  const state: InboxEffectsScope = { ...initial };
  const applied: Array<{ messages: string[]; directory: string }> = [];
  const discarded: Array<{ captured: InboxEffectsScope; current: InboxEffectsScope }> = [];
  const reads: InboxEffectsScope[] = [];
  const run = () =>
    pollInboxForCapturedScope({
      context: () => ({ ...state }),
      read: async (captured) => {
        reads.push(captured);
        whileReading(state);
        return ["m1"];
      },
      apply: (messages, captured) => applied.push({ messages, directory: captured.directory }),
      onDiscard: (captured, current) => discarded.push({ captured, current }),
    });
  return { run, applied, discarded, reads };
}

const P_SCOPE: InboxEffectsScope = { epoch: 1, groupId: "g-P", sessionId: "s-P", directory: "dir-P" };

test("a poll whose context is unchanged after the read applies its result in the captured directory", async () => {
  const rig = pollRig(P_SCOPE, () => {});
  await rig.run();
  expect(rig.reads).toEqual([P_SCOPE]);
  expect(rig.applied).toEqual([{ messages: ["m1"], directory: "dir-P" }]);
  expect(rig.discarded).toEqual([]);
});

test("a scope epoch change alone, with the same group and session, drops the poll result and traces the drop", async () => {
  const rig = pollRig(P_SCOPE, (state) => {
    state.epoch = 2;
  });
  await rig.run();
  expect(rig.applied, "no history write, truncation, broadcast or notification may follow").toEqual([]);
  expect(rig.discarded).toEqual([{ captured: P_SCOPE, current: { ...P_SCOPE, epoch: 2 } }]);
});

test("a group and session change during the read drops the result of the previous context", async () => {
  const rig = pollRig(P_SCOPE, (state) => {
    state.epoch = 2;
    state.groupId = "g-N";
    state.sessionId = "s-N";
    state.directory = "dir-N";
  });
  await rig.run();
  expect(rig.applied).toEqual([]);
  expect(rig.discarded).toHaveLength(1);
});

test("a session change alone drops the poll result", async () => {
  const rig = pollRig(P_SCOPE, (state) => {
    state.sessionId = "s-other";
  });
  await rig.run();
  expect(rig.applied).toEqual([]);
  expect(rig.discarded).toHaveLength(1);
});

test("the result is written into the directory captured before the read, never the one resolved after it", async () => {
  const rig = pollRig(P_SCOPE, (state) => {
    state.directory = "dir-resolved-after-the-await";
  });
  await rig.run();
  expect(rig.applied).toEqual([{ messages: ["m1"], directory: "dir-P" }]);
  expect(rig.discarded).toEqual([]);
});

test("a failed read leaves no drop trace and rejects to the caller", async () => {
  const discarded: unknown[] = [];
  await expect(
    pollInboxForCapturedScope({
      context: () => P_SCOPE,
      read: async () => {
        throw new Error("ECONNREFUSED");
      },
      apply: () => {
        throw new Error("no apply expected");
      },
      onDiscard: (captured) => discarded.push(captured),
    }),
  ).rejects.toThrow("ECONNREFUSED");
  expect(discarded).toEqual([]);
});

// --- createInboxSessionTracker -----------------------------------------

test("currentInboxSessionId returns the SAME id across calls when the group does not change", () => {
  const current = createInboxSessionTracker(() => "group-A");
  const first = current();
  const second = current();
  const third = current();
  expect(second).toBe(first);
  expect(third).toBe(first);
});

test("currentInboxSessionId re-mints a DIFFERENT id when the group changes", () => {
  let groupId = "group-A";
  const current = createInboxSessionTracker(() => groupId);
  const beforeSwitch = current();

  groupId = "group-B";
  const afterSwitch = current();
  expect(afterSwitch).not.toBe(beforeSwitch);

  // Switching back is itself a switch -- a THIRD distinct id, not a return to
  // the first (nothing here should special-case "seen this group before").
  groupId = "group-A";
  const afterSwitchBack = current();
  expect(afterSwitchBack).not.toBe(beforeSwitch);
  expect(afterSwitchBack).not.toBe(afterSwitch);

  // And it stabilizes again once the group stops changing.
  expect(current()).toBe(afterSwitchBack);
});

test("two independently created trackers never share state", () => {
  const trackerA = createInboxSessionTracker(() => "group-A");
  const trackerB = createInboxSessionTracker(() => "group-A");
  // Vanishingly unlikely to collide by chance (randomUUID); this asserts
  // independence of the closures, not merely "different by construction".
  expect(trackerA()).not.toBe(trackerB());
});

// --- purgeInboxSessionCore -----------------------------------------------

test("purgeInboxSessionCore calls clearLocal exactly once when purgeBroker succeeds, and never calls onPurgeError", async () => {
  let clearLocalCalls = 0;
  let onPurgeErrorCalls = 0;
  await purgeInboxSessionCore({
    context: () => ({ epoch: 0, groupId: "g", sessionId: "s", directory: "d" }),
    purgeBroker: async () => {},
    clearLocal: () => {
      clearLocalCalls++;
    },
    onPurgeError: () => {
      onPurgeErrorCalls++;
    },
  });
  expect(clearLocalCalls).toBe(1);
  expect(onPurgeErrorCalls).toBe(0);
});

test("purgeInboxSessionCore still calls clearLocal exactly once when purgeBroker REJECTS, and reports via onPurgeError", async () => {
  let clearLocalCalls = 0;
  let reportedError: unknown = null;
  const boom = new Error("broker unreachable");
  await purgeInboxSessionCore({
    context: () => ({ epoch: 0, groupId: "g", sessionId: "s", directory: "d" }),
    purgeBroker: async () => {
      throw boom;
    },
    clearLocal: () => {
      clearLocalCalls++;
    },
    onPurgeError: (e) => {
      reportedError = e;
    },
  });
  expect(clearLocalCalls).toBe(1);
  expect(reportedError).toBe(boom);
});

function mutableContext() {
  const state: InboxEffectsScope = { epoch: 0, groupId: "A", sessionId: "a", directory: "A-dir" };
  const switchToB = () => Object.assign(state, { epoch: 1, groupId: "B", sessionId: "b", directory: "B-dir" });
  return { context: () => ({ ...state }), switchToB };
}

test("purgeInboxSessionCore truncates the directory read before the broker await, not the one live after it", async () => {
  const live = mutableContext();
  const cleared: string[] = [];
  await purgeInboxSessionCore({
    context: live.context,
    purgeBroker: async () => {
      live.switchToB();
    },
    clearLocal: (captured) => cleared.push(captured.directory),
    onPurgeError: () => {},
  });
  expect(cleared, "the scope switched during the await; the old journal is the one purged broker-side").toEqual(["A-dir"]);
});

test("deleteInboxEntriesCore removes from the directory read before the await and returns the broker count", async () => {
  const live = mutableContext();
  const removed: string[] = [];
  const deleted = await deleteInboxEntriesCore({
    context: live.context,
    deleteBroker: async () => {
      live.switchToB();
      return 3;
    },
    deleteLocal: (captured) => removed.push(captured.directory),
    onDeleteError: () => {},
  });
  expect(deleted).toBe(3);
  expect(removed).toEqual(["A-dir"]);
});

test("deleteInboxEntriesCore still removes locally when the broker delete rejects, reports it, and returns 0", async () => {
  const live = mutableContext();
  const removed: string[] = [];
  let reported: unknown = null;
  const boom = new Error("broker unreachable");
  const deleted = await deleteInboxEntriesCore({
    context: live.context,
    deleteBroker: async () => {
      live.switchToB();
      throw boom;
    },
    deleteLocal: (captured) => removed.push(captured.directory),
    onDeleteError: (e) => {
      reported = e;
    },
  });
  expect(deleted).toBe(0);
  expect(reported).toBe(boom);
  expect(removed).toEqual(["A-dir"]);
});

const effectsRoots: string[] = [];
afterAll(() => {
  for (const root of effectsRoots) rmSync(root, { recursive: true, force: true });
});

const GROUP_P = "a".repeat(32);
const GROUP_N = "b".repeat(32);

function effectsRig() {
  const stateDir = mkdtempSync(join(tmpdir(), "inbox-effects-"));
  effectsRoots.push(stateDir);
  const live = { epoch: 0, groupId: GROUP_P, sessionId: "p" };
  const sessionDir = createSessionDirAccessor({ stateDir: () => stateDir, groupId: () => live.groupId });
  const dirP = sessionStateDir(stateDir, GROUP_P);
  const dirN = sessionStateDir(stateDir, GROUP_N);
  mkdirSync(dirP, { recursive: true });
  mkdirSync(dirN, { recursive: true });
  const rig = {
    dirP,
    dirN,
    live,
    during: async () => {},
    info: [] as string[],
    errors: [] as string[],
    broadcasts: [] as string[],
    notified: [] as number[][],
    switchToN: () => Object.assign(live, { epoch: 1, groupId: GROUP_N, sessionId: "n" }),
    switchToP: () => Object.assign(live, { epoch: 0, groupId: GROUP_P, sessionId: "p" }),
    close: () => {
      sessionDir.close();
      rmSync(dirP, { recursive: true });
      rmSync(dirN, { recursive: true });
    },
    breakJournal: (dir: string) => mkdirSync(inboxHistoryFile(dir)),
    repairJournal: (dir: string) => rmSync(inboxHistoryFile(dir), { recursive: true }),
    effects: undefined as unknown as ReturnType<typeof createInboxEffects>,
  };
  rig.effects = createInboxEffects({
    sessionDir,
    epoch: () => live.epoch,
    groupId: () => live.groupId,
    sessionId: () => live.sessionId,
    purgeBroker: () => rig.during(),
    deleteBroker: async () => {
      await rig.during();
      return 1;
    },
    broadcast: (channel) => rig.broadcasts.push(channel),
    notify: (batch) => rig.notified.push(batch.map((m) => m.id)),
    info: (message) => rig.info.push(message),
    error: (message) => rig.errors.push(message),
  });
  return rig;
}

const ROW_41 = { id: 41, from_peer_id: "agent-in-P", text: "hello", sent_at: "2026-01-01T00:00:00Z" };
const ROW_42 = { ...ROW_41, id: 42 };
const ENTRY_1 = { id: 1, from: "a", text: "t", sentAt: "s" };

test("a purge with no scope change truncates the journal of the live scope", async () => {
  const rig = effectsRig();
  appendInboxHistory(rig.dirP, [ENTRY_1]);
  await rig.effects.purge();
  expect(loadInboxHistory(rig.dirP)).toEqual([]);
  expect(rig.broadcasts).toEqual(["inbox:cleared"]);
});

test("a purge whose scope changed during the broker await truncates neither journal and leaves a trace", async () => {
  const rig = effectsRig();
  appendInboxHistory(rig.dirP, [ENTRY_1]);
  appendInboxHistory(rig.dirN, [ENTRY_1]);
  rig.during = async () => {
    rig.switchToN();
  };
  await rig.effects.purge();
  expect(loadInboxHistory(rig.dirP), "the old scope's directory is removed elsewhere; it is not written again").toEqual([ENTRY_1]);
  expect(loadInboxHistory(rig.dirN), "the new scope's journal is not the purged one").toEqual([ENTRY_1]);
  expect(rig.info.some((m) => m.includes("history truncate skipped") && m.includes("scope changed"))).toBe(true);
});

test("a manual delete with no scope change removes the entries from the journal of the live scope", async () => {
  const rig = effectsRig();
  appendInboxHistory(rig.dirP, [ENTRY_1, { ...ENTRY_1, id: 2 }]);
  expect(await rig.effects.delete([1])).toBe(1);
  expect(loadInboxHistory(rig.dirP).map((m) => m.id)).toEqual([2]);
});

test("a manual delete whose scope changed during the broker await removes from neither journal and leaves a trace", async () => {
  const rig = effectsRig();
  appendInboxHistory(rig.dirP, [ENTRY_1]);
  appendInboxHistory(rig.dirN, [ENTRY_1]);
  rig.during = async () => {
    rig.switchToN();
  };
  expect(await rig.effects.delete([1])).toBe(1);
  expect(loadInboxHistory(rig.dirP)).toEqual([ENTRY_1]);
  expect(loadInboxHistory(rig.dirN)).toEqual([ENTRY_1]);
  expect(rig.info.some((m) => m.includes("history entry removal skipped") && m.includes("scope changed"))).toBe(true);
});

test("a purge whose group alone changed during the broker await truncates neither journal", async () => {
  const rig = effectsRig();
  appendInboxHistory(rig.dirP, [ENTRY_1]);
  appendInboxHistory(rig.dirN, [ENTRY_1]);
  rig.during = async () => {
    rig.live.groupId = GROUP_N;
  };
  await rig.effects.purge();
  expect(loadInboxHistory(rig.dirP), "same epoch and session: only the groupId comparison protects this journal").toEqual([ENTRY_1]);
  expect(loadInboxHistory(rig.dirN)).toEqual([ENTRY_1]);
});

test("a manual delete whose group alone changed during the broker await removes from neither journal", async () => {
  const rig = effectsRig();
  appendInboxHistory(rig.dirP, [ENTRY_1]);
  appendInboxHistory(rig.dirN, [ENTRY_1]);
  rig.during = async () => {
    rig.live.groupId = GROUP_N;
  };
  expect(await rig.effects.delete([1])).toBe(1);
  expect(loadInboxHistory(rig.dirP), "same epoch and session: only the groupId comparison protects this journal").toEqual([ENTRY_1]);
  expect(loadInboxHistory(rig.dirN)).toEqual([ENTRY_1]);
});

test("a poll result is journaled in the live scope's directory and announced", async () => {
  const rig = effectsRig();
  await rig.effects.poll(async () => [ROW_41]);
  expect(loadInboxHistory(rig.dirP).map((m) => m.id)).toEqual([41]);
  expect(rig.broadcasts).toEqual(["inbox:new"]);
  expect(rig.notified).toEqual([[41]]);
});

test("a poll with nothing to write neither writes a batch nor announces an empty one", async () => {
  const rig = effectsRig();
  await rig.effects.poll(async () => []);
  expect(existsSync(inboxHistoryFile(rig.dirP))).toBe(false);
  expect(rig.broadcasts).toEqual([]);
  expect(rig.notified).toEqual([]);
});

test("a poll whose only queued entries belong to another scope writes nothing and announces nothing", async () => {
  const rig = effectsRig();
  rig.breakJournal(rig.dirP);
  await rig.effects.poll(async () => [ROW_41]);
  rig.repairJournal(rig.dirP);
  rig.switchToN();
  rig.broadcasts.length = 0;
  rig.notified.length = 0;
  await rig.effects.poll(async () => []);
  expect(existsSync(inboxHistoryFile(rig.dirN)), "no empty journal is written for the new scope").toBe(false);
  expect(rig.broadcasts).toEqual([]);
  expect(rig.notified).toEqual([]);
});

test("a replayed entry is journaled without being announced a second time", async () => {
  const rig = effectsRig();
  rig.breakJournal(rig.dirP);
  await rig.effects.poll(async () => [ROW_41]);
  rig.repairJournal(rig.dirP);
  rig.broadcasts.length = 0;
  rig.notified.length = 0;
  await rig.effects.poll(async () => []);
  expect(loadInboxHistory(rig.dirP).map((m) => m.id)).toEqual([41]);
  expect(rig.broadcasts).toEqual([]);
  expect(rig.notified).toEqual([]);
});

test("a poll whose scope changed during the read writes nothing and leaves a trace", async () => {
  const rig = effectsRig();
  await rig.effects.poll(async () => {
    rig.switchToN();
    return [ROW_41];
  });
  expect(loadInboxHistory(rig.dirP)).toEqual([]);
  expect(loadInboxHistory(rig.dirN)).toEqual([]);
  expect(rig.info.some((m) => m.includes("dropped"))).toBe(true);
});

test("a poll resuming after the session state closed does not recreate the removed directory", async () => {
  const rig = effectsRig();
  await rig.effects.poll(async () => {
    rig.close();
    return [ROW_41];
  });
  expect(existsSync(rig.dirP)).toBe(false);
  expect(rig.info.some((m) => m.includes("history append skipped"))).toBe(true);
});

test("a purge resuming after the session state closed does not recreate the removed directory", async () => {
  const rig = effectsRig();
  rig.during = async () => rig.close();
  await rig.effects.purge();
  expect(existsSync(rig.dirP)).toBe(false);
  expect(rig.info.some((m) => m.includes("history truncate skipped"))).toBe(true);
});

test("a manual delete resuming after the session state closed does not recreate the removed directory", async () => {
  const rig = effectsRig();
  rig.during = async () => rig.close();
  await rig.effects.delete([1]);
  expect(existsSync(rig.dirP)).toBe(false);
  expect(rig.info.some((m) => m.includes("history entry removal skipped"))).toBe(true);
});

test("a journal write that failed under one scope is never replayed after the scope changed", async () => {
  const rig = effectsRig();
  rig.breakJournal(rig.dirP);
  await rig.effects.poll(async () => [ROW_41]);
  expect(rig.effects.pendingMessages().map((m) => m.id), "the failed write is held for the scope that read it").toEqual([41]);
  rig.repairJournal(rig.dirP);
  rig.switchToN();
  expect(rig.effects.pendingMessages(), "the held entry is not counted under the new scope").toEqual([]);
  await rig.effects.poll(async () => []);
  expect(loadInboxHistory(rig.dirN), "the entry of the old scope is written nowhere").toEqual([]);
  expect(loadInboxHistory(rig.dirP)).toEqual([]);
  expect(rig.info.some((m) => m.includes("another scope dropped"))).toBe(true);
});

test("a journal write that failed is replayed into the journal once it is writable again", async () => {
  const rig = effectsRig();
  rig.breakJournal(rig.dirP);
  await rig.effects.poll(async () => [ROW_41]);
  expect(rig.errors.some((m) => m.includes("history write failed"))).toBe(true);
  rig.repairJournal(rig.dirP);
  await rig.effects.poll(async () => []);
  expect(loadInboxHistory(rig.dirP).map((m) => m.id)).toEqual([41]);
  expect(rig.effects.pendingMessages()).toEqual([]);
});

test("a purge empties the retry queue: a poll after it replays nothing", async () => {
  const rig = effectsRig();
  rig.breakJournal(rig.dirP);
  await rig.effects.poll(async () => [ROW_41]);
  rig.repairJournal(rig.dirP);
  await rig.effects.purge();
  expect(rig.effects.pendingMessages()).toEqual([]);
  await rig.effects.poll(async () => []);
  expect(loadInboxHistory(rig.dirP), "the purged entry is not written back").toEqual([]);
});

test("a purge empties the retry queue of the captured scope even when the local truncation is skipped", async () => {
  const rig = effectsRig();
  rig.breakJournal(rig.dirP);
  await rig.effects.poll(async () => [ROW_41]);
  rig.repairJournal(rig.dirP);
  rig.during = async () => {
    rig.switchToN();
  };
  await rig.effects.purge();
  rig.switchToP();
  expect(rig.effects.pendingMessages()).toEqual([]);
});

test("a manual delete drops its ids from the retry queue and replays the others", async () => {
  const rig = effectsRig();
  rig.breakJournal(rig.dirP);
  await rig.effects.poll(async () => [ROW_41, ROW_42]);
  rig.repairJournal(rig.dirP);
  await rig.effects.delete([41]);
  expect(rig.effects.pendingMessages().map((m) => m.id)).toEqual([42]);
  await rig.effects.poll(async () => []);
  expect(loadInboxHistory(rig.dirP).map((m) => m.id), "the deleted id is not written back, the other one is").toEqual([42]);
});

test("a manual delete drops its ids from the retry queue of the captured scope even when the local removal is skipped", async () => {
  const rig = effectsRig();
  rig.breakJournal(rig.dirP);
  await rig.effects.poll(async () => [ROW_41, ROW_42]);
  rig.repairJournal(rig.dirP);
  rig.during = async () => {
    rig.switchToN();
  };
  await rig.effects.delete([41]);
  rig.switchToP();
  expect(rig.effects.pendingMessages().map((m) => m.id)).toEqual([42]);
});

// --- classifyInboxDeleteIds ------------------------------------------------

test("classifyInboxDeleteIds: a genuinely empty input is a 0-effect no-op, not rejected", () => {
  expect(classifyInboxDeleteIds([])).toEqual({ valid: [], rejected: false });
});

test("classifyInboxDeleteIds: a non-array payload behaves like empty input, not rejected", () => {
  expect(classifyInboxDeleteIds(null)).toEqual({ valid: [], rejected: false });
  expect(classifyInboxDeleteIds(undefined)).toEqual({ valid: [], rejected: false });
  expect(classifyInboxDeleteIds("5")).toEqual({ valid: [], rejected: false });
  expect(classifyInboxDeleteIds({ id: 5 })).toEqual({ valid: [], rejected: false });
});

test("classifyInboxDeleteIds: a MIXED array keeps the valid integers and drops the rest, not rejected", () => {
  expect(classifyInboxDeleteIds([5, "x", 7, 5.5, Infinity])).toEqual({
    valid: [5, 7],
    rejected: false,
  });
});

test("classifyInboxDeleteIds: an ALL-INVALID non-empty array is rejected, valid stays empty", () => {
  expect(classifyInboxDeleteIds(["a", "b"])).toEqual({ valid: [], rejected: true });
  expect(classifyInboxDeleteIds([NaN])).toEqual({ valid: [], rejected: true });
  expect(classifyInboxDeleteIds([5.5, Infinity, -Infinity])).toEqual({ valid: [], rejected: true });
});
