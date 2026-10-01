import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Root } from "../desktop/tests-support/react-test-harness";
import { AvatarState, type AvatarFace } from "../desktop/src/shared/avatar-state.ts";
import * as geometry from "../desktop/src/shared/avatar-mask-geometry.ts";
import type { AvatarViewApi, AvatarViewPresentation, AvatarViewState } from "../desktop/src/shared/avatar-view.ts";

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const { act, React, createRoot } = await import("../desktop/tests-support/react-test-harness");

// bun does not resolve the tsconfig-only `@shared/*` alias from the repo root.
mock.module("@shared/avatar-mask-geometry", () => ({ ...geometry }));

const { AvatarApp } = await import("../desktop/src/renderer/src/avatar/AvatarApp");

const STYLES = join(import.meta.dir, "..", "desktop", "src", "renderer", "src", "styles.css");

const PRESENTATION: AvatarViewPresentation = {
  position: null,
  theme: "dark",
  motion: "none",
  dndActive: false,
  visible: true,
  alwaysOnTop: true,
  positionLocked: false,
  size: "m",
  idleOpacity: 1
};

function view(revision: number, presentation: Partial<AvatarViewPresentation> = {}, face?: AvatarFace): AvatarViewState {
  const base = new AvatarState({ now: () => 1_000_000 }).summary();
  const summary = { ...base, face: face ?? base.face, faceCopy: { title: "t", ariaLabel: "a" } };
  return { generation: 1, revision, summary, presentation: { ...PRESENTATION, ...presentation } };
}

interface Spy {
  api: AvatarViewApi;
  calls: string[];
  errors: string[];
  rejectPosition: boolean;
  rejectPointer: boolean;
  push(state: AvatarViewState): void;
}

function spy(): Spy {
  let listener: ((state: AvatarViewState) => void) | null = null;
  const fake: Spy = {
    calls: [],
    errors: [],
    rejectPosition: false,
    rejectPointer: false,
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
        if (fake.rejectPosition) throw new Error("Avatar position is locked");
      },
      setPointerInside: async (inside) => {
        fake.calls.push(`inside:${inside}`);
        if (fake.rejectPointer) throw new Error("Avatar window is unavailable");
      },
      reportError: (message) => {
        fake.errors.push(message);
      }
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

function mount(state: AvatarViewState): Spy {
  const fake = spy();
  act(() => root.render(React.createElement(AvatarApp, { api: fake.api, reducedMotion: null })));
  fake.push(state);
  return fake;
}

function face(): Element {
  const el = container.querySelector(".avatar-face");
  if (!el) throw new Error("the skin rendered no .avatar-face hit region");
  return el;
}

function avatarRoot(): HTMLElement {
  const el = container.querySelector<HTMLElement>(".avatar-root");
  if (!el) throw new Error("the container rendered no .avatar-root");
  return el;
}

const hoverFace = (): void => act(() => void face().dispatchEvent(new MouseEvent("mousemove", { bubbles: true })));
const hoverOff = (): void => act(() => void avatarRoot().dispatchEvent(new MouseEvent("mousemove", { bubbles: true })));

function pointer(target: Element | Document, type: string, init: PointerEventInit = {}): PointerEvent {
  const event = new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, button: 0, ...init });
  act(() => void target.dispatchEvent(event));
  return event;
}

const positions = (fake: Spy): string[] => fake.calls.filter((c) => c.startsWith("position:"));

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

describe("hover", () => {
  test("arms the hit-test once over the face and disarms it off the face", async () => {
    const fake = mount(view(1));
    hoverFace();
    hoverFace();
    hoverFace();
    expect(fake.calls).toEqual(["inside:true"]);
    hoverOff();
    hoverOff();
    expect(fake.calls).toEqual(["inside:true", "inside:false"]);
  });

  test("a newer view forgets the sent value, because main resets its pointer state without telling the renderer", () => {
    const fake = mount(view(1));
    hoverFace();
    fake.push(view(2));
    hoverFace();
    expect(fake.calls, "after a newer view the face must be re-armed, or the window stays click-through").toEqual(["inside:true", "inside:true"]);
  });

  test("an older view arriving late does not reset anything", () => {
    const fake = mount(view(3));
    hoverFace();
    fake.push(view(2));
    hoverFace();
    expect(fake.calls).toEqual(["inside:true"]);
  });

  test("a hidden character sends no hover", () => {
    const fake = mount(view(1, { visible: false }));
    hoverFace();
    hoverOff();
    expect(fake.calls).toEqual([]);
  });

  test("a rejected hover is reported once and not resent until a newer view", async () => {
    const fake = mount(view(1));
    fake.rejectPointer = true;
    hoverFace();
    await settle();
    hoverFace();
    hoverOff();
    hoverFace();
    await settle();
    expect(fake.calls).toEqual(["inside:true"]);
    expect(fake.errors.length).toBe(1);
    fake.rejectPointer = false;
    fake.push(view(2));
    hoverFace();
    expect(fake.calls).toEqual(["inside:true", "inside:true"]);
  });
});

describe("drag", () => {
  test("moves the window by the screen delta from the grab point, keeps it interactive off the face, and stops on pointerup", async () => {
    const fake = mount(view(1));
    hoverFace();
    pointer(face(), "pointerdown", { clientX: 10, clientY: 20, screenX: 510, screenY: 320 });
    expect(avatarRoot().getAttribute("data-move")).toBe("dragging");
    pointer(document.body, "pointermove", { screenX: 610, screenY: 420 });
    pointer(document.body, "pointermove", { screenX: 610.4, screenY: 420 });
    hoverOff();
    pointer(document.body, "pointermove", { screenX: 640, screenY: 400 });
    expect(fake.calls, "a drag that leaves the face must not turn click-through back on").toEqual(["inside:true", "position:600,400", "position:630,380"]);
    const original = document.elementFromPoint;
    document.elementFromPoint = () => avatarRoot();
    try {
      pointer(document.body, "pointerup", { clientX: 300, clientY: 300 });
    } finally {
      document.elementFromPoint = original;
    }
    expect(avatarRoot().getAttribute("data-move")).toBe("free");
    expect(fake.calls.at(-1), "the hit-test is re-evaluated where the pointer was released").toBe("inside:false");
    pointer(document.body, "pointermove", { screenX: 700, screenY: 500 });
    expect(fake.calls.filter((c) => c.startsWith("position:")).length).toBe(2);
    await settle();
    expect(fake.errors).toEqual([]);
  });

  test("an accepted press is default-prevented, a refused one is not", () => {
    const fake = mount(view(1));
    expect(pointer(face(), "pointerdown", { clientX: 0, clientY: 0, screenX: 0, screenY: 0 }).defaultPrevented).toBe(true);
    pointer(document.body, "pointerup");
    expect(pointer(face(), "pointerdown", { button: 2 }).defaultPrevented).toBe(false);
    expect(fake.errors).toEqual([]);
  });

  test("a face change mid-drag keeps the gesture: the capture sits on the stable root, not on the remounted face", () => {
    const fake = mount(view(1, {}, "seul"));
    const before = face();
    pointer(before, "pointerdown", { clientX: 10, clientY: 10, screenX: 10, screenY: 10 });
    expect(avatarRoot().hasPointerCapture(1), "a capture held by the face node is dropped when the skin remounts").toBe(true);
    fake.push(view(2, {}, "travaille"));
    expect(face(), "the face did not remount, so this test proves nothing").not.toBe(before);
    expect(avatarRoot().hasPointerCapture(1)).toBe(true);
    expect(avatarRoot().getAttribute("data-move")).toBe("dragging");
    pointer(document.body, "pointermove", { screenX: 60, screenY: 70 });
    expect(positions(fake)).toEqual(["position:50,60"]);
  });

  test("lostpointercapture ends the gesture", () => {
    const fake = mount(view(1));
    pointer(face(), "pointerdown", { clientX: 0, clientY: 0, screenX: 0, screenY: 0 });
    pointer(document, "lostpointercapture");
    expect(avatarRoot().getAttribute("data-move")).toBe("free");
    pointer(document.body, "pointermove", { screenX: 50, screenY: 50 });
    expect(positions(fake)).toEqual([]);
  });

  test("another pointer neither moves nor ends the open gesture", () => {
    const fake = mount(view(1));
    pointer(face(), "pointerdown", { clientX: 0, clientY: 0, screenX: 0, screenY: 0 });
    pointer(document.body, "pointermove", { pointerId: 2, screenX: 50, screenY: 50 });
    pointer(document.body, "pointerup", { pointerId: 2 });
    pointer(document.body, "pointercancel", { pointerId: 2 });
    pointer(document, "lostpointercapture", { pointerId: 2 });
    expect(positions(fake)).toEqual([]);
    expect(avatarRoot().getAttribute("data-move")).toBe("dragging");
    pointer(document.body, "pointermove", { screenX: 20, screenY: 30 });
    expect(positions(fake)).toEqual(["position:20,30"]);
  });

  test("unmounting mid-drag leaves no listener behind", () => {
    const fake = mount(view(1));
    hoverFace();
    pointer(face(), "pointerdown", { clientX: 0, clientY: 0, screenX: 0, screenY: 0 });
    act(() => root.unmount());
    root = createRoot(container);
    const calls = fake.calls.length;
    pointer(document.body, "pointermove", { screenX: 50, screenY: 50 });
    pointer(document.body, "pointerup");
    act(() => void document.body.dispatchEvent(new MouseEvent("mousemove", { bubbles: true })));
    expect(fake.calls.slice(calls)).toEqual([]);
    expect(fake.errors).toEqual([]);
  });

  test("pointercancel ends the gesture", () => {
    const fake = mount(view(1));
    pointer(face(), "pointerdown", { clientX: 0, clientY: 0, screenX: 0, screenY: 0 });
    pointer(document.body, "pointercancel");
    pointer(document.body, "pointermove", { screenX: 50, screenY: 50 });
    expect(fake.calls.filter((c) => c.startsWith("position:"))).toEqual([]);
    expect(avatarRoot().getAttribute("data-move")).toBe("free");
  });

  test("a locked or hidden character never moves", () => {
    for (const presentation of [{ positionLocked: true }, { visible: false }]) {
      const fake = mount(view(1, presentation));
      pointer(face(), "pointerdown", { clientX: 0, clientY: 0, screenX: 0, screenY: 0 });
      pointer(document.body, "pointermove", { screenX: 80, screenY: 80 });
      expect(fake.calls.filter((c) => c.startsWith("position:")), JSON.stringify(presentation)).toEqual([]);
      expect(avatarRoot().getAttribute("data-move")).toBe("locked");
    }
  });

  test("a secondary button or a press off the face starts nothing", () => {
    const fake = mount(view(1));
    pointer(face(), "pointerdown", { button: 2, clientX: 0, clientY: 0, screenX: 0, screenY: 0 });
    pointer(avatarRoot(), "pointerdown", { pointerId: 2, clientX: 0, clientY: 0, screenX: 0, screenY: 0 });
    pointer(document.body, "pointermove", { screenX: 80, screenY: 80 });
    pointer(document.body, "pointermove", { pointerId: 2, screenX: 80, screenY: 80 });
    expect(fake.calls).toEqual([]);
  });

  test("a rejected move ends the gesture with a single report, however many moves were in flight", async () => {
    const fake = mount(view(1));
    fake.rejectPosition = true;
    pointer(face(), "pointerdown", { clientX: 0, clientY: 0, screenX: 0, screenY: 0 });
    pointer(document.body, "pointermove", { screenX: 10, screenY: 10 });
    pointer(document.body, "pointermove", { screenX: 20, screenY: 20 });
    await settle();
    pointer(document.body, "pointermove", { screenX: 30, screenY: 30 });
    expect(fake.calls).toEqual(["position:10,10", "position:20,20"]);
    expect(fake.errors.length).toBe(1);
    expect(avatarRoot().getAttribute("data-move")).toBe("free");
  });

  test("hiding or locking during a drag ends it without a report", async () => {
    for (const presentation of [{ positionLocked: true }, { visible: false }]) {
      const fake = mount(view(1));
      pointer(face(), "pointerdown", { clientX: 0, clientY: 0, screenX: 0, screenY: 0 });
      fake.push(view(2, presentation));
      pointer(document.body, "pointermove", { screenX: 40, screenY: 40 });
      await settle();
      expect(fake.calls.filter((c) => c.startsWith("position:")), JSON.stringify(presentation)).toEqual([]);
      expect(fake.errors).toEqual([]);
      expect(avatarRoot().getAttribute("data-move")).toBe("locked");
    }
  });
});

describe("cursor", () => {
  test("grab over a movable face, grabbing while dragging, and no grab at all when locked", () => {
    const style = document.createElement("style");
    style.textContent = readFileSync(STYLES, "utf-8");
    document.head.appendChild(style);
    try {
      // happy-dom keeps an element's computed style after an ANCESTOR attribute changes, so each state is read on a fresh mount.
      const remount = (state: AvatarViewState): void => {
        act(() => root.unmount());
        root = createRoot(container);
        mount(state);
      };
      mount(view(1));
      expect(avatarRoot().getAttribute("data-move")).toBe("free");
      expect(getComputedStyle(face()).cursor).toBe("grab");
      remount(view(1));
      pointer(face(), "pointerdown", { clientX: 0, clientY: 0, screenX: 0, screenY: 0 });
      expect(avatarRoot().getAttribute("data-move")).toBe("dragging");
      expect(getComputedStyle(avatarRoot()).cursor, "the captured drag can leave the face").toBe("grabbing");
      expect(getComputedStyle(face()).cursor).toBe("grabbing");
      pointer(document.body, "pointerup");
      remount(view(1, { positionLocked: true }));
      expect(avatarRoot().getAttribute("data-move")).toBe("locked");
      expect(getComputedStyle(face()).cursor).not.toMatch(/grab/);
      expect(getComputedStyle(avatarRoot()).cursor).not.toMatch(/grab/);
    } finally {
      style.remove();
    }
  });
});
