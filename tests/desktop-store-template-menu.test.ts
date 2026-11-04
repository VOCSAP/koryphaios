// Loads the real store: the menu subscriptions live in its init(), so a fake
// store would prove nothing about which dialog each event opens.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import * as sharedTypes from "../desktop/src/shared/types.ts";
import * as sharedRoadmapSync from "../desktop/src/shared/roadmap-sync.ts";
import * as sharedInboxPending from "../desktop/src/shared/inbox-pending.ts";
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

beforeAll(async () => {
  (window as unknown as { api: unknown }).api = api;
  // The query gives a module record that the other files' mock.module of store.ts does not reach, and no teardown could undo.
  ({ useDeck } = await import("../desktop/src/renderer/src/store.ts?real"));
  await useDeck.getState().init();
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
