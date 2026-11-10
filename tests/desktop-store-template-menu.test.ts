// Loads the real store: the menu subscriptions live in its init(), so a fake
// store would prove nothing about which dialog each event opens.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import * as sharedTypes from "../desktop/src/shared/types.ts";
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
  await useDeck.getState().init();
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
