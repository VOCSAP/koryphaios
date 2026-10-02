import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Root } from "../desktop/tests-support/react-test-harness";
import { AvatarState } from "../desktop/src/shared/avatar-state.ts";
import * as geometry from "../desktop/src/shared/avatar-mask-geometry.ts";
import type { AvatarViewApi, AvatarViewPresentation, AvatarViewState } from "../desktop/src/shared/avatar-view.ts";
import { avatarCssBlock, cssRules, declarationValues } from "./_avatar-css";

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const { act, React, createRoot } = await import("../desktop/tests-support/react-test-harness");

// bun does not resolve the tsconfig-only `@shared/*` alias from the repo root.
mock.module("@shared/avatar-mask-geometry", () => ({ ...geometry }));

const { AvatarApp } = await import("../desktop/src/renderer/src/avatar/AvatarApp");
const { avatarThemeVars } = await import("../desktop/src/renderer/src/avatar/skins");

const PRESENTATION: AvatarViewPresentation = {
  position: null,
  theme: "dark",
  motion: "none",
  dndActive: false,
  visible: true,
  alwaysOnTop: true,
  positionLocked: false,
  size: "m",
  frame: "normal",
  idleOpacity: 1
};

function view(revision: number, presentation: Partial<AvatarViewPresentation> = {}): AvatarViewState {
  const base = new AvatarState({ now: () => 1_000_000 }).summary();
  const summary = { ...base, faceCopy: { title: "t", ariaLabel: "a" } };
  return { generation: 1, revision, summary, presentation: { ...PRESENTATION, ...presentation } };
}

interface Fake {
  api: AvatarViewApi;
  calls: string[];
  push(state: AvatarViewState): void;
}

function fakeApi(): Fake {
  let listener: ((state: AvatarViewState) => void) | null = null;
  const fake: Fake = {
    calls: [],
    api: {
      getState: () => new Promise(() => {}),
      onState: (callback) => {
        listener = callback;
        return () => {
          listener = null;
        };
      },
      setPosition: async (x, y) => {
        fake.calls.push(`position:${x},${y}`);
      },
      setPointerInside: async (inside) => {
        fake.calls.push(`inside:${inside}`);
      },
      reportError: () => {}
    },
    push(state) {
      if (!listener) throw new Error("the container is not subscribed to onState");
      const deliver = listener;
      act(() => deliver(state));
    }
  };
  return fake;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function mount(state: AvatarViewState): Fake {
  const fake = fakeApi();
  act(() => root.render(React.createElement(AvatarApp, { api: fake.api, reducedMotion: null })));
  fake.push(state);
  return fake;
}

function one<T extends Element>(selector: string): T {
  const el = container.querySelector<T>(selector);
  if (!el) throw new Error(`the avatar rendered no ${selector}`);
  return el;
}

const move = (target: Element): void => act(() => void target.dispatchEvent(new MouseEvent("mousemove", { bubbles: true })));

function pointer(target: Element | Document, type: string, init: PointerEventInit = {}): void {
  act(() => void target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, button: 0, ...init })));
}

describe("frame variant", () => {
  test("the root carries presentation.frame and the skin sits inside the frame", () => {
    const fake = mount(view(1, { frame: "normal" }));
    expect(one(".avatar-root").getAttribute("data-frame")).toBe("normal");
    expect(one(".avatar-frame").querySelector("svg.avatar-skin"), "the skin is not drawn inside the frame").not.toBeNull();
    fake.push(view(2, { frame: "full" }));
    expect(one(".avatar-root").getAttribute("data-frame"), "a newer view did not switch the variant").toBe("full");
  });

  test("only the normal variant draws the title bar, and its prompt is the typographic U+276F", () => {
    const bars = cssRules(avatarCssBlock()).filter((rule) => rule.selectors.some((s) => s.includes("::before") && s.includes(".avatar-frame")));
    expect(bars.flatMap((rule) => rule.selectors), "the title bar must be keyed on the normal variant alone").toEqual([
      ".avatar-root[data-frame='normal'] .avatar-frame::before"
    ]);
    expect(bars[0]!.body, "the prompt is not the U+276F escape").toContain("content: '\\276F");
    expect(bars[0]!.body, "the prompt may fall back to an emoji presentation").toContain("font-variant-emoji: text");
  });
});

describe("frame palette", () => {
  test("the frame rule re-declares every palette variable, so a light system theme never reaches the face", () => {
    const rules = cssRules(avatarCssBlock());
    const missing = Object.keys(avatarThemeVars("light")).filter(
      (name) => declarationValues(rules, ".avatar-root .avatar-frame", name).length === 0
    );
    expect(missing, "these palette variables fall through to the root's inline theme value inside the frame").toEqual([]);
  });
});

describe("grab target", () => {
  test("hovering the frame outside the face arms the hit-test, the root outside the frame disarms it", () => {
    const fake = mount(view(1, { frame: "full" }));
    move(one(".avatar-frame"));
    expect(fake.calls, "the drawn frame stays click-through").toEqual(["inside:true"]);
    move(one(".avatar-root"));
    expect(fake.calls, "the area outside the frame (its rounded corners) must stay click-through").toEqual(["inside:true", "inside:false"]);
  });

  test("a drag can start on the frame itself, not only on the face", () => {
    const fake = mount(view(1, { frame: "normal" }));
    move(one(".avatar-frame"));
    pointer(one(".avatar-frame"), "pointerdown", { clientX: 10, clientY: 5, screenX: 510, screenY: 305 });
    expect(one(".avatar-root").getAttribute("data-move"), "a press on the frame did not start a drag").toBe("dragging");
    pointer(document.body, "pointermove", { screenX: 610, screenY: 405 });
    expect(fake.calls).toEqual(["inside:true", "position:600,400"]);
    pointer(document.body, "pointerup", { clientX: 10, clientY: 5 });
  });

  test("a hidden character sends no hover over the frame", () => {
    const fake = mount(view(1, { visible: false }));
    move(one(".avatar-frame"));
    expect(fake.calls).toEqual([]);
  });
});
