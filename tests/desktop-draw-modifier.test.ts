// Hold-to-draw modifier watcher (embedded browser rework). happy-dom,
// registered globally -- see tests/desktop-explorer-selection-dom.test.ts's
// header comment for the measured cross-file blast radius of a missing
// GlobalRegistrator.unregister() (CORS breakage in every later fetch-using
// suite within this single `bun test` process). Paired register/unregister
// below, same discipline as tests/desktop-element-pick.test.ts.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import {
  createDrawModifierWatcher,
  isDrawModifierKey,
} from "../desktop/src/shared/draw-modifier.ts";

// Every test dispatches directly at `window` (happy-dom's global) and cleans
// up its own watcher via the returned dispose(), so a forgotten listener
// cannot leak into a later test in this file.

function keydown(key: string, opts: Partial<KeyboardEventInit> = {}): void {
  window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...opts }));
}

function keyup(key: string): void {
  window.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true }));
}

function blur(): void {
  window.dispatchEvent(new Event("blur"));
}

let dispose: (() => void) | null = null;

beforeEach(() => {
  dispose = null;
});

afterEach(() => {
  dispose?.();
});

// ----- isDrawModifierKey -----

test("isDrawModifierKey: Meta on mac, Control on other platforms", () => {
  expect(isDrawModifierKey({ key: "Meta" }, "mac")).toBe(true);
  expect(isDrawModifierKey({ key: "Control" }, "mac")).toBe(false);
  expect(isDrawModifierKey({ key: "Control" }, "other")).toBe(true);
  expect(isDrawModifierKey({ key: "Meta" }, "other")).toBe(false);
  expect(isDrawModifierKey({ key: "Shift" }, "other")).toBe(false);
});

// ----- createDrawModifierWatcher: transitions only -----

test("createDrawModifierWatcher: keydown then keyup fires onChange exactly once per transition", () => {
  const events: boolean[] = [];
  dispose = createDrawModifierWatcher(window, "other", (held) => events.push(held));

  keydown("Control");
  expect(events).toEqual([true]);

  keyup("Control");
  expect(events).toEqual([true, false]);
});

test("createDrawModifierWatcher: a non-modifier key is ignored entirely", () => {
  const events: boolean[] = [];
  dispose = createDrawModifierWatcher(window, "other", (held) => events.push(held));

  keydown("a");
  keyup("a");
  expect(events).toEqual([]);
});

test("createDrawModifierWatcher: auto-repeat keydown does not re-fire onChange", () => {
  const events: boolean[] = [];
  dispose = createDrawModifierWatcher(window, "other", (held) => events.push(held));

  keydown("Control");
  keydown("Control", { repeat: true });
  keydown("Control", { repeat: true });
  expect(events).toEqual([true]); // one transition, repeats are silent

  keyup("Control");
  expect(events).toEqual([true, false]);
});

test("createDrawModifierWatcher: a redundant keyup while not held is a silent no-op", () => {
  const events: boolean[] = [];
  dispose = createDrawModifierWatcher(window, "other", (held) => events.push(held));

  keyup("Control"); // never went down
  expect(events).toEqual([]);
});

// ----- platform mapping -----

test("createDrawModifierWatcher: mac platform reacts to Meta, ignores Control", () => {
  const events: boolean[] = [];
  dispose = createDrawModifierWatcher(window, "mac", (held) => events.push(held));

  keydown("Control");
  expect(events).toEqual([]);

  keydown("Meta");
  expect(events).toEqual([true]);

  keyup("Meta");
  expect(events).toEqual([true, false]);
});

// ----- blur resets -----

test("createDrawModifierWatcher: blur forces held back to false while a key was down", () => {
  const events: boolean[] = [];
  dispose = createDrawModifierWatcher(window, "other", (held) => events.push(held));

  keydown("Control");
  expect(events).toEqual([true]);

  blur();
  expect(events).toEqual([true, false]);

  // The keyup that eventually arrives (focus back, key released) is now a
  // no-op transition -- state was already false.
  keyup("Control");
  expect(events).toEqual([true, false]);
});

test("createDrawModifierWatcher: blur while not held does not spuriously fire onChange", () => {
  const events: boolean[] = [];
  dispose = createDrawModifierWatcher(window, "other", (held) => events.push(held));

  blur();
  expect(events).toEqual([]);
});

// ----- dispose -----

test("createDrawModifierWatcher: dispose removes all listeners -- no further onChange calls", () => {
  const events: boolean[] = [];
  const stop = createDrawModifierWatcher(window, "other", (held) => events.push(held));
  dispose = null; // disposed explicitly below, nothing left for afterEach to do

  keydown("Control");
  expect(events).toEqual([true]);

  stop();

  keyup("Control");
  blur();
  keydown("Control");
  expect(events).toEqual([true]); // nothing after dispose
});
