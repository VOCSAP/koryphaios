import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import type { Root } from "../desktop/tests-support/react-test-harness";
import type { WorkspaceSummary } from "../desktop/src/shared/types";
import { mockStore, storeMockStubs } from "./_store-mock";

const { act, React, createRoot, create } = await import("../desktop/tests-support/react-test-harness");

interface FakeDeckState {
  workspaces: WorkspaceSummary[];
  workspacesLoadOnly: boolean;
  dict: Record<string, string>;
  openWorkspaces: (open: boolean) => void;
  requestRestore: (id: string) => void;
  removeWorkspace: (id: string) => Promise<void>;
}

const restored: string[] = [];
const fakeUseDeck = create<FakeDeckState>(() => ({
  workspaces: [],
  workspacesLoadOnly: false,
  dict: {},
  openWorkspaces: () => {},
  requestRestore: (id) => void restored.push(id),
  removeWorkspace: async () => {}
}));
mockStore({ useDeck: fakeUseDeck, ...storeMockStubs });

const { WorkspacesDialog } = await import("../desktop/src/renderer/src/components/WorkspacesDialog.tsx");

function summary(id: string, conflict: boolean): WorkspaceSummary {
  return { id, name: `name-${id}`, pinned: false, scopeName: "scope", sessionCount: 2, updatedAt: 0, locked: false, current: false, conflict };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  restored.length = 0;
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

async function mount(workspaces: WorkspaceSummary[]): Promise<void> {
  fakeUseDeck.setState({ workspaces, dict: { "workspaces.conflictHint": "paths of {id}" } });
  await act(async () => {
    root.render(React.createElement(WorkspacesDialog));
  });
}

function row(id: string): { badge: HTMLElement | null; restore: HTMLButtonElement; remove: HTMLButtonElement } {
  const li = [...container.querySelectorAll(".ws-row")].find((el) => el.textContent?.includes(`name-${id}`));
  if (!li) throw new Error(`no row for ${id}`);
  const buttons = [...li.querySelectorAll("button")] as HTMLButtonElement[];
  const byLabel = (label: string): HTMLButtonElement => {
    const b = buttons.find((el) => el.textContent === label);
    if (!b) throw new Error(`row ${id} has no ${label} button`);
    return b;
  };
  return { badge: li.querySelector(".ws-badge-conflict"), restore: byLabel("workspaces.restore"), remove: byLabel("workspaces.delete") };
}

test("a workspace held by both project folders shows the conflict badge naming its id, and offers neither restore nor delete", async () => {
  await mount([summary("wsp_both", true), summary("wsp_one", false)]);

  const both = row("wsp_both");
  expect(both.badge, "a conflicting id must carry the conflict badge").not.toBeNull();
  expect(both.badge!.getAttribute("title"), "the hover text must name the conflicting id so the two paths can be found").toBe("paths of wsp_both");
  expect(both.restore.disabled, "restore of a conflicting id is refused main-side, so the button must not offer it").toBe(true);
  expect(both.remove.disabled, "delete of a conflicting id is a silent no-op main-side, so the button must not offer it").toBe(true);

  const one = row("wsp_one");
  expect(one.badge, "an id stored once must not carry the conflict badge").toBeNull();
  expect(one.restore.disabled).toBe(false);
  expect(one.remove.disabled).toBe(false);

  await act(async () => {
    both.restore.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    one.restore.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  expect(restored, "only the unconflicted row reaches requestRestore").toEqual(["wsp_one"]);
});
