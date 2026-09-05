// Mounted directly, without App: the dialog reads its whole input from the
// store and is otherwise pure. What is proven here is the ONE promise the
// brief makes about it -- it shows the fields that differ and ONLY those --
// plus the three arbitration buttons routing the right channel value.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { Root } from "../desktop/tests-support/react-test-harness"; // type-only: erased, no runtime resolution
import { mockStore, storeMockStubs } from "./_store-mock";
import * as roadmapSync from "../desktop/src/shared/roadmap-sync.ts";
import type {
  RoadmapItem,
  RoadmapSyncConflict,
  RoadmapSyncResolution,
} from "../desktop/src/shared/types.ts";

const { act, React, createRoot, create } = await import("../desktop/tests-support/react-test-harness");

// The dialog's only VALUE import through the `@shared/*` tsconfig-only alias
// (not resolved by bun test from the repo root). Re-exporting the REAL module,
// already imported above by a relative path, rather than a hand-written stub:
// the diff logic under test must be the shipped one.
mock.module("@shared/roadmap-sync", () => roadmapSync);

interface FakeDeckState {
  dict: Record<string, string>;
  roadmapConflictId: string | null;
  roadmapSync: { status: { mode: string }; conflicts: RoadmapSyncConflict[] };
  openRoadmapConflict: (id: string | null) => void;
  resolveRoadmapConflict: (id: string, choice: RoadmapSyncResolution) => Promise<void>;
}

const resolveCalls: Array<{ id: string; choice: RoadmapSyncResolution }> = [];
const closeCalls: Array<string | null> = [];

function initialFakeState(): FakeDeckState {
  return {
    // Untranslated keys resolve to the key itself (i18n.ts's translate), so
    // the assertions below match on the literal key strings.
    dict: {},
    roadmapConflictId: null,
    roadmapSync: { status: { mode: "replica" }, conflicts: [] },
    openRoadmapConflict: (id) => {
      closeCalls.push(id);
      fakeUseDeck.setState({ roadmapConflictId: id });
    },
    resolveRoadmapConflict: async (id, choice) => {
      resolveCalls.push({ id, choice });
    },
  };
}

const fakeUseDeck = create<FakeDeckState>(() => initialFakeState());

function resetFakeStore(): void {
  resolveCalls.length = 0;
  closeCalls.length = 0;
  fakeUseDeck.setState(initialFakeState(), true);
}

mockStore({ useDeck: fakeUseDeck, ...storeMockStubs });

const { RoadmapConflictDialog } = await import(
  "../desktop/src/renderer/src/components/RoadmapConflictDialog"
);

function item(patch: Partial<RoadmapItem>): RoadmapItem {
  return {
    id: "card-1",
    project_key: "github.com/vocsap/x",
    kind: "feature",
    title: "Card one",
    description: "d",
    rationale: "r",
    context: "c",
    priority: "could",
    value: "medium",
    effort: "medium",
    status: "planned",
    tags: [],
    depends_on: [],
    created_by: "p",
    updated_by: "p",
    created_at: "2026-09-04T00:00:00.000Z",
    updated_at: "2026-09-04T00:00:00.000Z",
    deleted_at: null,
    queue: null,
    locked: false,
    locked_by: null,
    locked_at: null,
    locked_group: null,
    directive: null,
    target_peer_ids: [],
    inactive: false,
    sync_state: "conflict",
    lock_scope: null,
    lock_contested_by: [],
    ...patch,
  };
}

function conflict(
  local: Partial<RoadmapItem>,
  remote: Partial<RoadmapItem>,
): RoadmapSyncConflict {
  return { local: item(local), remote: { ...item(remote), rev: 3, content_rev: 2 }, base: null };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  resetFakeStore();
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

function mount(): void {
  act(() => {
    root.render(React.createElement(RoadmapConflictDialog));
  });
}

function fieldLabels(): string[] {
  return [...container.querySelectorAll(".rm-conflict-row:not(.rm-conflict-head) .rm-conflict-field")]
    .map((el) => (el.textContent ?? "").trim());
}

test("nothing is rendered while no conflict is open", () => {
  mount();
  expect(container.querySelector(".rm-conflict-modal")).toBeNull();
});

test("only the DIFFERING fields are listed, lifecycle first", () => {
  fakeUseDeck.setState({
    roadmapConflictId: "card-1",
    roadmapSync: {
      status: { mode: "replica" },
      conflicts: [
        conflict(
          { title: "kept title", description: "local text", status: "done" },
          { title: "kept title", description: "remote text", status: "planned" },
        ),
      ],
    },
  });
  mount();
  expect(container.querySelector(".rm-conflict-modal")).not.toBeNull();
  const labels = fieldLabels();
  // status differs and is a lifecycle field, so it leads; description differs
  // and follows; title is IDENTICAL on both sides and must not appear at all.
  expect(labels[0]).toContain("roadmap.sync.field.status");
  expect(labels.some((l) => l.includes("roadmap.sync.field.description"))).toBe(true);
  expect(labels.some((l) => l.includes("roadmap.sync.field.title"))).toBe(false);
  expect(labels).toHaveLength(2);
});

test("the base column is absent when the card was never synced", () => {
  fakeUseDeck.setState({
    roadmapConflictId: "card-1",
    roadmapSync: {
      status: { mode: "replica" },
      conflicts: [conflict({ title: "a" }, { title: "b" })],
    },
  });
  mount();
  expect(container.querySelector(".rm-conflict-nobase")).not.toBeNull();
  expect(container.querySelector(".rm-conflict-base")).toBeNull();
});

test("the three buttons send the three channel values, on the open card's id", async () => {
  fakeUseDeck.setState({
    roadmapConflictId: "card-1",
    roadmapSync: {
      status: { mode: "replica" },
      conflicts: [conflict({ title: "a" }, { title: "b" })],
    },
  });
  mount();
  const buttons = [...container.querySelectorAll(".rm-conflict-choice")] as HTMLButtonElement[];
  expect(buttons).toHaveLength(3);
  for (const button of buttons) {
    // One click at a time, each awaited: the choices are disabled while a
    // resolution is in flight, which is exactly the double-submit guard, so
    // firing all three synchronously would only record the first.
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }
  expect(resolveCalls).toEqual([
    { id: "card-1", choice: "remote" },
    { id: "card-1", choice: "local" },
    { id: "card-1", choice: "merge_reopen" },
  ]);
});

test("a conflict that disappears from the poll closes the dialog", () => {
  fakeUseDeck.setState({
    roadmapConflictId: "card-1",
    roadmapSync: {
      status: { mode: "replica" },
      conflicts: [conflict({ title: "a" }, { title: "b" })],
    },
  });
  mount();
  expect(container.querySelector(".rm-conflict-modal")).not.toBeNull();
  // Arbitrated from another Deck, or auto-resolved by the lock-sweep rule:
  // the dialog must not keep offering three buttons over a settled card.
  act(() => {
    fakeUseDeck.setState({
      roadmapSync: { status: { mode: "replica" }, conflicts: [] },
    });
  });
  expect(container.querySelector(".rm-conflict-modal")).toBeNull();
  expect(closeCalls).toContain(null);
});
