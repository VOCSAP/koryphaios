import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import type { Root } from "../desktop/tests-support/react-test-harness";
import { mockStore, storeMockStubs } from "./_store-mock";

const { act, React, createRoot, create } = await import("../desktop/tests-support/react-test-harness");

interface FakeDeckState {
  sessions: Array<{ id: string; supervisor?: boolean }>;
  dict: Record<string, string>;
}

const fakeUseDeck = create<FakeDeckState>(() => ({ sessions: [], dict: {} }));
mockStore({ useDeck: fakeUseDeck, ...storeMockStubs });

const { HomeView } = await import("../desktop/src/renderer/src/components/HomeView.tsx");

let container: HTMLDivElement;
let root: Root;
let triggers: unknown[] = [];

beforeEach(() => {
  triggers = [];
  fakeUseDeck.setState({ sessions: [], dict: {} }, true);
  (globalThis as unknown as { window: { api: Record<string, unknown> } }).window.api = {
    // Resolving null is what main answers when startSupervisorOnLaunch is off.
    ensureSupervisor: (trigger: unknown) => {
      triggers.push(trigger);
      return Promise.resolve(null);
    },
  };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

test("the Home view's first visit asks for an automatic start, its button for a manual one", async () => {
  await act(async () => {
    root.render(React.createElement(HomeView, { active: true }));
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(triggers, "the mount effect must request an 'auto' start, the only one the setting may skip").toEqual(["auto"]);

  const button = [...container.querySelectorAll("button")].find((b) => b.textContent === "home.start");
  expect(button, "a skipped automatic start must leave the manual start button").not.toBeUndefined();
  await act(async () => {
    button!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
  expect(triggers, "the start button must request a 'manual' start, which the setting never skips").toEqual(["auto", "manual"]);
});
