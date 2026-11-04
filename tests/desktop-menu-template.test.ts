// The application menu is described by a pure module so its click -> renderer
// channel chain is executable here. The Electron host itself is out of reach.
import { expect, test } from "bun:test";
import type { MenuItemConstructorOptions } from "electron";
import {
  MENU_CHANNELS,
  SAVE_TEMPLATE_ITEM_ID,
  appMenuTemplate,
  rendererMenuActions
} from "../desktop/src/main/menu-template";
import { COMPANION_MANIFEST } from "../desktop/src/shared/companion";
import { EN_DEFAULTS } from "../desktop/src/main/i18n";

const label = (key: string): string => `«${key}»`;

function build(canSaveTemplate = true): { sent: string[]; menu: MenuItemConstructorOptions[] } {
  const sent: string[] = [];
  const menu = appMenuTemplate(rendererMenuActions((c) => sent.push(c)), {
    isMac: false,
    isDev: false,
    appName: "Kory",
    label,
    canSaveTemplate
  });
  return { sent, menu };
}

function submenu(item: MenuItemConstructorOptions | undefined): MenuItemConstructorOptions[] {
  return (item?.submenu ?? []) as MenuItemConstructorOptions[];
}

function fileMenu(menu: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return submenu(menu.find((m) => m.label === label("menu.file")));
}

function templateMenu(menu: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return submenu(fileMenu(menu).find((m) => m.label === label("menu.template")));
}

test("File > Template holds Use, Edit and Save in that order", () => {
  const { menu } = build();
  expect(templateMenu(menu).map((m) => m.label)).toEqual([
    label("menu.useTemplate"),
    label("menu.editTemplate"),
    label("menu.saveTemplate")
  ]);
});

test("each Template entry delivers its own distinct renderer channel when clicked", () => {
  const { menu, sent } = build();
  for (const item of templateMenu(menu)) (item.click as () => void)();
  expect(sent).toEqual([
    MENU_CHANNELS.useTemplate,
    MENU_CHANNELS.editTemplate,
    MENU_CHANNELS.saveTemplate
  ]);
  expect(new Set(sent).size).toBe(3);
});

test("no Import, Export or New template entry survives at the first level of File", () => {
  const { menu } = build();
  const top = fileMenu(menu).map((m) => String(m.label ?? ""));
  expect(top.some((l) => /import|export|new template|nouveau template/i.test(l))).toBe(false);
});

test("Save Template carries the id the main process toggles, and starts as asked", () => {
  const disabled = templateMenu(build(false).menu).find((m) => m.id === SAVE_TEMPLATE_ITEM_ID);
  expect(disabled?.enabled).toBe(false);
  const enabled = templateMenu(build(true).menu).find((m) => m.id === SAVE_TEMPLATE_ITEM_ID);
  expect(enabled?.enabled).toBe(true);
});

test("every channel the menu can emit is a window-only event of the companion manifest", () => {
  const events = new Set(
    Object.values(COMPANION_MANIFEST)
      .filter((spec) => spec.kind === "event")
      .map((spec) => spec.channel)
  );
  for (const channel of Object.values(MENU_CHANNELS)) expect(events.has(channel)).toBe(true);
});

test("every menu label key resolves to an English string", () => {
  const keys = new Set<string>();
  const probe = appMenuTemplate(rendererMenuActions(() => {}), {
    isMac: true,
    isDev: true,
    appName: "Kory",
    label: (k) => {
      keys.add(k);
      return k;
    },
    canSaveTemplate: true
  });
  expect(probe.length).toBeGreaterThan(0);
  expect(keys.size).toBeGreaterThan(0);
  for (const k of keys) expect(EN_DEFAULTS[k], `EN_DEFAULTS is missing ${k}`).toBeString();
});
