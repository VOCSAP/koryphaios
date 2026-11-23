import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { brokerStopDialogOptions, confirmedStop } from "../desktop/src/main/avatar-broker-wiring.ts";
import { AVATAR_TRAY_COPY } from "../desktop/src/main/avatar-tray-copy.ts";
import { avatarBubblePlacement } from "../desktop/src/main/avatar-bubble-window.ts";
import { extractBracedBody, extractParenBody } from "./_braced-body.ts";

const ENTRY = resolve(import.meta.dir, "../desktop/src/main/avatar-entry.ts");
const source = (): string => readFileSync(ENTRY, "utf8").replace(/\r\n/g, "\n");
const code = (): string => new Bun.Transpiler({ loader: "ts" }).transformSync(source());

function braced(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    if (text[i] === "}" && --depth === 0) return text.slice(open, i + 1);
  }
  throw new Error("unterminated");
}

function entryConfirm(dialog: unknown): (details: unknown) => Promise<boolean> {
  const text = source();
  const anchor = text.indexOf("const brokerControl = createAvatarBrokerControl({");
  const marker = "    confirm: async (details) => ";
  const start = anchor < 0 ? -1 : text.indexOf(marker, anchor);
  if (start < 0) throw new Error("avatar-entry.ts: the broker control confirm callback is unavailable");
  const body = braced(text, start + marker.length);
  const js = new Bun.Transpiler({ loader: "ts" }).transformSync(`export const f = async (details: any) => ${body}`).replace("export const f = ", "return ");
  return new Function("dialog", "brokerStopDialogOptions", "confirmedStop", "AVATAR_TRAY_COPY", "locale", js)(
    dialog, brokerStopDialogOptions, confirmedStop, AVATAR_TRAY_COPY, "en"
  ) as (details: unknown) => Promise<boolean>;
}

test("the Avatar's stop confirmation shows the Cancel-first dialog and stops only on the explicit Stop", async () => {
  const shown: Array<Record<string, unknown>> = [];
  let response = 1;
  const confirm = entryConfirm({ showMessageBox: async (options: Record<string, unknown>) => { shown.push(options); return { response }; } });
  const details = { url: "http://127.0.0.1:7899", pid: 42, decks: 1 };
  expect(await confirm(details)).toBe(false);
  response = 0;
  expect(await confirm(details)).toBe(true);
  expect(shown[0]).toMatchObject({ defaultId: 1, cancelId: 1, noLink: true });
});

test("the Avatar re-reads the manual stop from both the broker probe and the Tray, and asks /health on the inspected port", () => {
  const js = code();
  expect(js).toMatch(/brokerUrls:\s*probeBrokerUrls\(refreshManualStop,/);
  expect(js).toMatch(/summary:\s*trayBrokerSummary\(refreshManualStop,/);
  expect(js).toMatch(/brokerHealth:\s*\(port\)\s*=>\s*fetchBrokerHealth\(port,/);
});

function callBody(js: string, call: string): string {
  const start = js.indexOf(call);
  expect(start, `avatar-entry.ts: ${call} anchor is unavailable`).toBeGreaterThanOrEqual(0);
  return extractParenBody(js, start + call.length - 1);
}

const REFRESH_ON_CHANGE = /onNotificationAvailabilityChanged:\s*\(\)\s*=>\s*server\?\.refreshNotificationStatus\(\)/;

test("a change of the mask, its renderer or the Do-not-disturb window refreshes the notification status at once", () => {
  expect(callBody(code(), "assembleAvatar("), "assembleAvatar carries the availability callback").toMatch(REFRESH_ON_CHANGE);
});

test("a bubble that fails or recovers refreshes the notification status at once", () => {
  expect(callBody(code(), "createAvatarBubbleWindow("), "createAvatarBubbleWindow carries the availability callback").toMatch(REFRESH_ON_CHANGE);
});

test("the Avatar server reads the bubble service and the mask presentation as its notification availability", () => {
  expect(callBody(code(), "startAvatarServer(")).toMatch(
    /notificationAvailability:\s*\(\)\s*=>\s*\(\{\s*serviceReady:\s*bubble\?\.notificationServiceReady\(\)\s*\?\?\s*false,\s*\.\.\.assembly\.notificationPresentation\(\)\s*\}\)/
  );
});

test("the bubble resolves its theme from the attached Decks, with Windows as the fallback", () => {
  expect(
    callBody(code(), "createAvatarBubbleWindow("),
    "createAvatarBubbleWindow carries the theme callback"
  ).toMatch(/theme:\s*\(\)\s*=>\s*resolveAvatarBubbleTheme\(server\?\.attachedDecks\(\)\s*\?\?\s*\[\],/);
});

test("a Deck theme change refreshes the open bubble", () => {
  expect(
    callBody(code(), "startAvatarServer("),
    "startAvatarServer carries deckThemeChanged"
  ).toMatch(/deckThemeChanged:\s*\(\)\s*=>\s*bubble\?\.changed\(\)/);
});

function entryBubbleStore(assembly: unknown): { expanded: () => boolean; persistExpanded: (value: boolean) => void } {
  const body = callBody(code(), "createAvatarBubbleWindow(");
  const read = /\n\s*expanded:\s*\(\)\s*=>\s*([^\n]*?),?\n/.exec(body);
  const write = /\n\s*persistExpanded:\s*\((\w+)\)\s*=>\s*\{/.exec(body);
  if (!read || !write) throw new Error("avatar-entry.ts: the bubble's expanded and persistExpanded callbacks are unavailable");
  const writeBody = braced(body, write.index + write[0].length - 1);
  return new Function("assembly", `return { expanded: () => ${read[1]}, persistExpanded: (${write[1]}) => ${writeBody} }`)(assembly) as {
    expanded: () => boolean;
    persistExpanded: (value: boolean) => void;
  };
}

function fakeAssembly(appearance: Record<string, unknown>) {
  const events: unknown[] = [];
  const state = { appearance };
  return { events, state, assembly: { controller: { snapshot: () => state, dispatch: (event: unknown) => events.push(event) } } };
}

test("the bubble opens at the size the Avatar appearance holds right now, read from bubbleExpanded and nothing else", () => {
  const fake = fakeAssembly({ visible: false, bubbleExpanded: true });
  const store = entryBubbleStore(fake.assembly);
  expect(store.expanded()).toBe(true);
  fake.state.appearance = { visible: true, bubbleExpanded: false };
  expect(store.expanded()).toBe(false);
});

test("the bubble hands each chosen size to the Avatar state as one AppearanceChanged patch", () => {
  const fake = fakeAssembly({ bubbleExpanded: false });
  const store = entryBubbleStore(fake.assembly);
  store.persistExpanded(true);
  store.persistExpanded(false);
  expect(fake.events).toEqual([
    { kind: "AppearanceChanged", patch: { bubbleExpanded: true } },
    { kind: "AppearanceChanged", patch: { bubbleExpanded: false } }
  ]);
});

type Rect = { x: number; y: number; width: number; height: number };

function entryPlacement(screen: unknown, mask: Rect | null): (expanded: boolean) => unknown {
  const body = callBody(code(), "createAvatarBubbleWindow(");
  const open = /\n\s*placement:\s*\((\w+)\)\s*=>\s*\{/.exec(body);
  if (!open) throw new Error("avatar-entry.ts: the bubble's placement callback is unavailable");
  const placementBody = extractBracedBody(body, open.index + open[0].length - 1, true);
  return new Function("avatarMaskBounds", "screen", "avatarBubblePlacement", `return (${open[1]}) => {${placementBody}}`)(
    () => mask, screen, avatarBubblePlacement
  ) as (expanded: boolean) => unknown;
}

const PRIMARY = { x: 0, y: 0, width: 1920, height: 1040 };
const SECONDARY = { x: 1920, y: 0, width: 1366, height: 728 };

test("the bubble is placed from the mask, the work area of the display the mask is on, and the size the bubble asks for", () => {
  const mask = { x: 2500, y: 300, width: 160, height: 160 };
  const asked: unknown[] = [];
  const screen = {
    getDisplayMatching: (rect: unknown) => { asked.push(rect); return { workArea: SECONDARY }; },
    getPrimaryDisplay: () => ({ workArea: PRIMARY })
  };
  const placement = entryPlacement(screen, mask);
  expect(placement(true)).toEqual(avatarBubblePlacement(mask, SECONDARY, true));
  expect(placement(false)).toEqual(avatarBubblePlacement(mask, SECONDARY, false));
  expect(placement(true), "expanded and normal sizes differ").not.toEqual(placement(false));
  expect(asked.length).toBeGreaterThan(0);
  expect(asked, "the display is looked up from the mask").toEqual(asked.map(() => mask));
});

test("the bubble placement the Avatar returns is the one computed, anchor included, when the bubble flips to the left of its mask", () => {
  const mask = { x: 500, y: 800, width: 160, height: 160 };
  const screen = { getDisplayMatching: () => ({ workArea: PRIMARY }), getPrimaryDisplay: () => ({ workArea: PRIMARY }) };
  const placed = entryPlacement(screen, mask)(true);
  expect(placed).toEqual(avatarBubblePlacement(mask, PRIMARY, true));
  expect(placed).toMatchObject({ anchor: "left" });
});

test("the Avatar server resolves its broker allow-list through the link policy", () => {
  const entry = code();
  const start = entry.indexOf("server = await startAvatarServer(");
  expect(start, "avatar-entry.ts: server startup anchor is unavailable").toBeGreaterThanOrEqual(0);
  const body = extractParenBody(entry, entry.indexOf("(", start));
  expect(body).toContain("allowedBrokerUrls: () => avatarAllowedBrokerUrls(resolveBrokerEndpoint().url)");
});
