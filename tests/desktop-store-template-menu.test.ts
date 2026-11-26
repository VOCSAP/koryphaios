// Loads the real store: the menu subscriptions live in its init(), so a fake
// store would prove nothing about which dialog each event opens.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import * as sharedTypes from "../desktop/src/shared/types.ts";
import type { SessionSequenceView } from "../desktop/src/shared/types.ts";
import * as sharedRoadmapSync from "../desktop/src/shared/roadmap-sync.ts";
import * as sharedInboxPending from "../desktop/src/shared/inbox-pending.ts";
import * as sharedQuotaNotice from "../desktop/src/shared/quota-notice.ts";
import * as sharedTemplateApply from "../desktop/src/shared/template-apply-outcome.ts";
import * as sharedWorkspaceRestore from "../desktop/src/shared/workspace-restore-outcome.ts";
import * as sharedCompanion from "../desktop/src/shared/companion.ts";
import { COMPANION_MANIFEST } from "../desktop/src/shared/companion.ts";
import { MENU_CHANNELS } from "../desktop/src/main/menu-template.ts";

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

mock.module("@shared/types", () => sharedTypes);
mock.module("@shared/companion", () => sharedCompanion);
mock.module("@shared/roadmap-sync", () => sharedRoadmapSync);
mock.module("@shared/inbox-pending", () => sharedInboxPending);
mock.module("@shared/quota-notice", () => sharedQuotaNotice);
mock.module("@shared/template-apply-outcome", () => sharedTemplateApply);
mock.module("@shared/workspace-restore-outcome", () => sharedWorkspaceRestore);

const listeners = new Map<string, () => void>();
let restoreOutcome: unknown = undefined;
const DEEP_LINKED = { id: "apr-deep", status: "pending" };
// The store state at the moment init() first set the inbox seed.
let atSeed: { open: boolean; pendingIds: string[] } | null = null;

// Every `on*` subscription is recorded by name and returns its unsubscribe; any
// other method resolves to an inert value, enough for init() to run to its end.
const api = new Proxy(
  {},
  {
    get(_t, name: string) {
      if (name.startsWith("on")) {
        return (cb: () => void) => {
          listeners.set(name, cb);
          return () => {};
        };
      }
      if (["listSessions", "listWorkspaces", "listTemplates", "inboxHistory"].includes(name)) {
        return () => Promise.resolve([]);
      }
      if (name === "restoreWorkspace") return () => Promise.resolve(restoreOutcome);
      if (name === "approvalPendingList") return () => Promise.resolve([DEEP_LINKED]);
      if (name === "getConfig") return () => Promise.resolve({});
      if (name === "getI18n") return () => Promise.resolve({ dict: {}, available: [] });
      return () => Promise.resolve(undefined);
    }
  }
);

let useDeck: typeof import("../desktop/src/renderer/src/store").useDeck;
let inboxAwaitsAction: typeof import("../desktop/src/renderer/src/store").inboxAwaitsAction;
let inboxBadgeCount: typeof import("../desktop/src/renderer/src/store").inboxBadgeCount;

beforeAll(async () => {
  (window as unknown as { api: unknown }).api = api;
  // The query gives a module record that the other files' mock.module of store.ts does not reach, and no teardown could undo.
  ({ useDeck, inboxAwaitsAction, inboxBadgeCount } = await import("../desktop/src/renderer/src/store.ts?real"));
  // The page was opened on #a=: the same module record store.ts reads it from.
  const { captureUrlFragment } = await import("../desktop/src/renderer/src/remote-api.ts");
  window.location.hash = "#a=apr-deep";
  captureUrlFragment();
  const stop = useDeck.subscribe((s) => {
    if (atSeed === null && s.inboxSeed === "apr-deep") {
      atSeed = { open: s.inboxOpen, pendingIds: s.pendingApprovals.map((a) => a.id) };
    }
  });
  await useDeck.getState().init();
  await new Promise((r) => setTimeout(r, 0));
  stop();
});

// Mutants: init() skips the pending-list read, or seeds before applying it.
test("a page opened on #a= reads the pending list at init, then opens the Courrier on that request", () => {
  expect(atSeed, "init() never seeded the deep-linked request").not.toBeNull();
  expect(atSeed).toEqual({ open: true, pendingIds: ["apr-deep"] });
});

// Mutant: inboxAwaitsAction counting every pending approval again.
test("an information is counted by the Courrier badge but never lights the attention glow", () => {
  const pending = (informational: boolean) => ({ informational }) as never;
  useDeck.setState({
    pendingApprovals: [pending(true)],
    graphDrafts: [],
    inboxMessages: [],
    inboxAckState: {},
    inboxArchive: { status: "unsupported", messages: {}, closedQuestions: [] } as never
  });
  const onlyInformation = [inboxAwaitsAction(useDeck.getState()), inboxBadgeCount(useDeck.getState())];
  useDeck.setState({ pendingApprovals: [pending(true), pending(false)] });
  const withQuestion = [inboxAwaitsAction(useDeck.getState()), inboxBadgeCount(useDeck.getState())];
  useDeck.setState({ pendingApprovals: [] });

  expect(onlyInformation).toEqual([false, 1]);
  expect(withQuestion).toEqual([true, 2]);
});

// Mutants: the sessions subscription removed; the badge term removed; the acknowledged key ignored; the attention glow counting the notice.
test("tiles in a quota episode open one episode, and the Courrier badge counts the notice only while it is listed", () => {
  const tile = (id: string) => ({ id, rateLimited: true, status: "running" }) as never;
  useDeck.setState({
    pendingApprovals: [],
    graphDrafts: [],
    inboxMessages: [],
    inboxAckState: {},
    inboxArchive: { status: "unsupported", messages: {}, closedQuestions: [] } as never
  });

  useDeck.setState({ sessions: [tile("a"), tile("b")] });
  const opened = useDeck.getState().quotaEpisode;
  expect(opened?.id).toMatch(/^quota:\d+$/);
  expect(useDeck.getState().quotaNoticeShown, "not listed before the delay").toBe(false);
  expect(inboxBadgeCount(useDeck.getState())).toBe(0);

  useDeck.setState({ quotaNoticeShown: true });
  expect(inboxBadgeCount(useDeck.getState())).toBe(1);
  expect(inboxAwaitsAction(useDeck.getState()), "an information awaits nothing").toBe(false);
  useDeck.setState({ sessions: [tile("a")] });
  expect(useDeck.getState().quotaEpisode, "X moving inside the episode keeps it").toBe(opened);

  const key = sharedTypes.inboxEntryKey(sharedQuotaNotice.quotaNoticeEntry(opened!, ""));
  useDeck.setState({ inboxAckState: { [key]: "acked" } });
  expect(inboxBadgeCount(useDeck.getState())).toBe(0);

  useDeck.setState({ sessions: [] });
  expect(useDeck.getState().quotaEpisode).toBeNull();
  expect(useDeck.getState().quotaNoticeShown).toBe(false);
});

test("every menu channel has a store subscription named after it", () => {
  const menuEvents = Object.entries(COMPANION_MANIFEST)
    .filter(([, spec]) => spec.kind === "event" && (Object.values(MENU_CHANNELS) as string[]).includes(spec.channel))
    .map(([name]) => name);
  expect(menuEvents).toHaveLength(Object.keys(MENU_CHANNELS).length);
  for (const name of menuEvents) expect(listeners.has(name), `${name} is never subscribed`).toBe(true);
});

test("Use Template opens the plain picker: not manage, not edit", () => {
  useDeck.getState().openTemplates(false);
  listeners.get("onMenuUseTemplate")!();
  const s = useDeck.getState();
  expect([s.templatesOpen, s.templatesManage, s.templatesEdit]).toEqual([true, false, false]);
});

test("Edit Template opens the picker in edit intent, without the manage mode step", () => {
  useDeck.getState().openTemplates(false);
  listeners.get("onMenuEditTemplate")!();
  const s = useDeck.getState();
  expect([s.templatesOpen, s.templatesManage, s.templatesEdit]).toEqual([true, false, true]);
});

test("Save Template opens the save dialog and never the picker", () => {
  useDeck.getState().openTemplates(false);
  useDeck.getState().openExportTemplate(false);
  listeners.get("onMenuSaveTemplate")!();
  const s = useDeck.getState();
  expect([s.exportTemplateOpen, s.templatesOpen]).toEqual([true, false]);
});

test("closing the picker resets the edit intent so the next plain open is not an edit", () => {
  listeners.get("onMenuEditTemplate")!();
  useDeck.getState().openTemplates(false);
  expect(useDeck.getState().templatesEdit).toBe(false);
});

const shownToast = () => {
  const { toast, toastVariant, toastParams } = useDeck.getState();
  return { toast, toastVariant, toastParams };
};

// Mutants: the showToast call removed from restoreWorkspace; showToast's repeat branch leaving the first toast's params on screen.
test("a restore that demoted sessions toasts their names, and a second one inside the throttle shows its own", async () => {
  useDeck.setState({ toast: null, toastParams: null });
  restoreOutcome = { applied: true, demotedTeamLeads: ["deputy"] };
  await useDeck.getState().restoreWorkspace("wsp-1");
  expect(shownToast()).toEqual({
    toast: "toast.workspaceRestoreDemotedTeamLeads",
    toastVariant: "info",
    toastParams: { names: "deputy" }
  });

  restoreOutcome = { applied: true, demotedTeamLeads: ["second", "third"] };
  await useDeck.getState().restoreWorkspace("wsp-2");
  expect(shownToast()).toEqual({
    toast: "toast.workspaceRestoreDemotedTeamLeads",
    toastVariant: "info",
    toastParams: { names: "second, third" }
  });
});

test("a restore that demoted nobody leaves the toast alone", async () => {
  useDeck.setState({ toast: null, toastParams: null });
  restoreOutcome = { applied: true };
  await useDeck.getState().restoreWorkspace("wsp-3");
  expect(useDeck.getState().toast).toBeNull();
});

// Mutants: the repeat branch always false (a caller carrying a count loses its number), or always true (it counts it twice).
test("showToast returns false for an identical repeat and true when the repeat replaces what is on screen", () => {
  const { showToast } = useDeck.getState();
  useDeck.setState({ toast: null, toastParams: null });
  expect(showToast("toast.queueReplaced", "info", { params: { n: 2 } })).toBe(true);
  expect(showToast("toast.queueReplaced", "info", { params: { n: 2 } })).toBe(false);
  expect(showToast("toast.queueReplaced", "info", { params: { n: 5 } })).toBe(true);
  expect(useDeck.getState().toastParams).toEqual({ n: 5 });

  expect(showToast("toast.queueReplaced", "error", { raw: true })).toBe(true);
  expect(shownToast()).toEqual({ toast: "toast.queueReplaced", toastVariant: "error", toastParams: null });
  expect(useDeck.getState().toastRaw).toBe(true);
});

const sequenceView = (tileId: string, spawnGeneration = 1) =>
  ({
    tileId,
    moment: "start",
    spawnGeneration,
    step: 1,
    total: 2,
    phase: "waiting-background",
    background: 2,
    reason: null,
    run: 1,
    waitingDirectives: []
  }) satisfies SessionSequenceView;
const pushSequence = (view: unknown) => (listeners.get("onSessionSequence") as unknown as (v: unknown) => void)(view);
const changeSessions = (ids: string[], spawnGeneration = 1) =>
  (listeners.get("onSessionsChanged") as unknown as (sessions: unknown[]) => void)(
    ids.map((id) => ({ id, rateLimited: false, status: "running", spawnGeneration }))
  );

// Mutant: the onSessionSequence subscription removed.
test("a sequence view pushed by main lands in the store under its tile", () => {
  changeSessions(["a"]);
  pushSequence(sequenceView("a"));
  expect(useDeck.getState().sessionSequences["a"]).toEqual(sequenceView("a"));
  changeSessions([]);
});

// Mutant: sessionSequences left alone when the session list changes.
test("a tile that disappears takes its sequence state with it, and a restored tile of the same id starts clean", () => {
  changeSessions(["a", "b"]);
  pushSequence(sequenceView("a"));
  pushSequence(sequenceView("b"));
  changeSessions(["a"]);
  expect(Object.keys(useDeck.getState().sessionSequences)).toEqual(["a"]);
  changeSessions([]);
  expect(useDeck.getState().sessionSequences).toEqual({});
  pushSequence({ ...sequenceView("a"), phase: "stopped", background: null, reason: "revoked" });
  expect(useDeck.getState().sessionSequences["a"], "a late view of a tile that is gone").toBeUndefined();
  changeSessions(["a"]);
  expect(useDeck.getState().sessionSequences["a"]).toBeUndefined();
  changeSessions([]);
});

test("a restore that keeps the tile id drops the old sequence view and refuses its late stopped view", () => {
  changeSessions(["a"], 1);
  pushSequence(sequenceView("a", 1));
  changeSessions(["a"], 2);
  expect(useDeck.getState().sessionSequences["a"], "the view of the replaced tile").toBeUndefined();

  pushSequence({ ...sequenceView("a", 1), phase: "stopped", background: null, reason: "revoked" });
  expect(useDeck.getState().sessionSequences["a"], "the late stopped view of the old spawn").toBeUndefined();

  pushSequence(sequenceView("a", 2));
  expect(useDeck.getState().sessionSequences["a"]).toEqual(sequenceView("a", 2));
  changeSessions([]);
});

async function withApi(over: Record<string, (...args: unknown[]) => unknown>, run: () => Promise<void>): Promise<void> {
  const holder = window as unknown as { api: object };
  const real = holder.api;
  holder.api = new Proxy(real, { get: (target, name: string) => over[name] ?? Reflect.get(target, name) });
  try {
    await run();
  } finally {
    holder.api = real;
  }
}

// Mutants: the store keeps only the id and the moment; the reply of main dropped.
test("runSkill hands main the tile, the moment and the stop mode, and returns the reply", async () => {
  const calls: unknown[][] = [];
  const reply = { status: "refused", reason: "bad-request" };
  await withApi({ runSessionSkill: (...args) => (calls.push(args), Promise.resolve(reply)) }, async () => {
    expect(await useDeck.getState().runSkill("t", "stop", "hard")).toEqual(reply);
    await useDeck.getState().runSkill("t", "start");
  });
  expect(calls).toEqual([
    ["t", "stop", "hard"],
    ["t", "start", undefined],
  ]);
});

test("a run that main rejects resolves null instead of throwing", async () => {
  await withApi({ runSessionSkill: () => Promise.reject(new Error("main refused")) }, async () => {
    expect(await useDeck.getState().runSkill("t", "start")).toBeNull();
  });
});

test("cancelSequence and overrideSequence call their own main method with the tile", async () => {
  const cancelled: unknown[][] = [];
  const overridden: unknown[][] = [];
  await withApi(
    {
      cancelSessionSequence: (...args) => (cancelled.push(args), Promise.resolve(true)),
      overrideSessionQuiescence: (...args) => (overridden.push(args), Promise.resolve(true)),
    },
    async () => {
      await useDeck.getState().cancelSequence("t");
      expect([cancelled, overridden]).toEqual([[["t"]], []]);
      await useDeck.getState().overrideSequence("u");
      expect([cancelled, overridden]).toEqual([[["t"]], [["u"]]]);
    }
  );
});

test("a run main refuses is toasted as an error with its detail, and a started run is not", async () => {
  useDeck.setState({ toast: null, toastParams: null });
  const refusal = { status: "refused", reason: "command-refused", detail: "stop line 2: dialogue-command" };
  await withApi({ runSessionSkill: () => Promise.resolve(refusal) }, async () => {
    await useDeck.getState().runSkill("t", "stop", "soft");
  });
  expect(shownToast()).toEqual({
    toast: "toast.skillRefused.commandRefused",
    toastVariant: "error",
    toastParams: { detail: "stop line 2: dialogue-command" }
  });

  useDeck.setState({ toast: null, toastParams: null });
  await withApi({ runSessionSkill: () => Promise.resolve({ status: "started" }) }, async () => {
    await useDeck.getState().runSkill("t", "start");
  });
  expect(useDeck.getState().toast).toBeNull();
});

test("dismissSequence drops the view of that tile only", () => {
  changeSessions(["a", "b"]);
  pushSequence(sequenceView("a"));
  pushSequence(sequenceView("b"));
  useDeck.getState().dismissSequence("a");
  expect(Object.keys(useDeck.getState().sessionSequences)).toEqual(["b"]);
  changeSessions([]);
});

test("a dismissed sequence view never comes back from a later emission of the same run, and the next run shows again", () => {
  changeSessions(["a"]);
  const stopped = { ...sequenceView("a"), run: 7, phase: "stopped", background: null, reason: "operator-cancelled", waitingDirectives: ["compact"] };
  pushSequence(stopped);
  useDeck.getState().dismissSequence("a");
  pushSequence({ ...stopped, waitingDirectives: [] });
  expect(useDeck.getState().sessionSequences["a"], "the queued directive starting re-emits the dismissed run").toBeUndefined();

  const next = { ...sequenceView("a"), run: 8, phase: "stopped", background: null, reason: "revoked", waitingDirectives: [] };
  pushSequence(next);
  expect(useDeck.getState().sessionSequences["a"], "a run that stops without ever running is still shown").toEqual(next);
  changeSessions([]);
});

test("a second cancel while the first awaits main is dropped, and the tile is released after", async () => {
  const calls: unknown[][] = [];
  let answer: (v: boolean) => void = () => {};
  await withApi(
    {
      cancelSessionSequence: (...args) => {
        calls.push(args);
        return new Promise<boolean>((r) => (answer = r));
      },
      overrideSessionQuiescence: (...args) => (calls.push(["override", ...args]), Promise.resolve(true))
    },
    async () => {
      const first = useDeck.getState().cancelSequence("t");
      expect(useDeck.getState().sequenceActionsInFlight).toEqual({ t: true });
      await useDeck.getState().cancelSequence("t");
      await useDeck.getState().overrideSequence("t");
      await useDeck.getState().overrideSequence("other");
      answer(true);
      await first;
      expect(calls).toEqual([["t"], ["override", "other"]]);
      expect(useDeck.getState().sequenceActionsInFlight).toEqual({});
    }
  );
});
