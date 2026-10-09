// A toast sits bottom-center over a tall modal's footer (Save/Cancel) for its
// whole lifetime; a click on it must hand the footer back to the operator.
// happy-dom computes no layout, so "the button beneath is reachable again" is
// proven on screen; this file proves the component wires the click to the
// store's dismiss action and that the toast leaves the DOM.

import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import type { Root } from "../desktop/tests-support/react-test-harness"; // type-only: erased, no runtime resolution
import { mockStore, storeMockStubs } from "./_store-mock";

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const { act, React, createRoot, create } = await import("../desktop/tests-support/react-test-harness");

interface FakeDeckState {
  dict: Record<string, string>;
  toast: string | null;
  toastVariant: "success" | "info" | "error";
  toastRaw: boolean;
  toastParams: Record<string, string | number> | null;
  dismissToast(): void;
}

const fakeUseDeck = create<FakeDeckState>((set) => ({
  dict: {},
  toast: null,
  toastVariant: "error",
  toastRaw: false,
  toastParams: null,
  dismissToast: () => set({ toast: null }),
}));

mockStore({ useDeck: fakeUseDeck, ...storeMockStubs });

const { Toast } = await import("../desktop/src/renderer/src/components/Toast");

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  fakeUseDeck.setState({ toast: "roadmap.contextExpiredBodyPrefix", toastVariant: "error" });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(React.createElement(Toast));
  });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

test("a click on an error toast removes it before its timer runs out", () => {
  const toast = container.querySelector(".toast");
  expect(toast, "the error toast never rendered").not.toBeNull();
  act(() => {
    (toast as HTMLElement).click();
  });
  expect(container.querySelector(".toast"), "the toast stays over the modal footer after a click").toBeNull();
  expect(fakeUseDeck.getState().toast).toBeNull();
});

test("a dismissable toast keeps its alert role", () => {
  expect(container.querySelector(".toast")?.getAttribute("role")).toBe("alert");
});
