// A card whose depends_on matches no single item is held back by the
// dispatcher; the lane must say so on the card itself.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { Root } from "../desktop/tests-support/react-test-harness"; // type-only: erased, no runtime resolution
import type { RoadmapItem } from "../desktop/src/shared/types";
import { mockStore, storeMockStubs } from "./_store-mock";
import * as workflow from "../desktop/src/shared/workflow.ts";

// bun does not resolve the tsconfig-only `@shared/*` alias from the repo root.
mock.module("@shared/workflow", () => ({ ...workflow }));
const { queueSourceOf } = workflow;

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const { act, React, createRoot, create } = await import(
  "../desktop/tests-support/react-test-harness"
);

interface FakeDeckState {
  dict: Record<string, string>;
  config: null;
  showToast(): void;
  updateConfig(): void;
}

function initialFakeState(): FakeDeckState {
  return {
    dict: { "roadmap.wf.unknownDep": "unknown dependency {id}" },
    config: null,
    showToast: () => {},
    updateConfig: () => {},
  };
}

const fakeUseDeck = create<FakeDeckState>(() => initialFakeState());

mockStore({ useDeck: fakeUseDeck, ...storeMockStubs });

const { WorkflowLane } = await import(
  "../desktop/src/renderer/src/components/WorkflowLane"
);

function card(id: string, over: Partial<RoadmapItem> = {}): RoadmapItem {
  return {
    id,
    project_key: "k",
    kind: "feature",
    title: id,
    description: "",
    rationale: "",
    context: "",
    priority: "could",
    value: "medium",
    effort: "medium",
    status: "planned",
    tags: [],
    depends_on: [],
    created_by: "deck",
    updated_by: "deck",
    created_at: "2026-01-01",
    updated_at: "2026-01-01",
    deleted_at: null,
    queue: null,
    locked: false,
    locked_by: null,
    locked_at: null,
    ...over,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  fakeUseDeck.setState(initialFakeState(), true);
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

async function mountLane(items: RoadmapItem[]): Promise<void> {
  const noop = (): void => {};
  await act(async () => {
    root.render(
      React.createElement(WorkflowLane, {
        source: queueSourceOf(items),
        hasLead: false,
        onToggleFull: noop,
        onDispatch: noop,
        onOpen: noop,
        onMenu: noop,
        onReorder: noop,
        onCreateAt: noop,
        onAddDep: noop,
        onRemoveDep: noop,
        onStack: noop,
      }),
    );
  });
}

function unknownBadges(): string[] {
  return [...container.querySelectorAll<HTMLElement>(".wf-badge-unknown")].map(
    (b) => b.textContent ?? "",
  );
}

const DONE_ID = "dddddddd-1111-4000-8000-000000000001";

test("a card depending on an unknown id shows the badge with the id8", async () => {
  await mountLane([
    card("head", { queue: 1, depends_on: ["0123456789abcdef"] }),
  ]);
  expect(unknownBadges()).toEqual(["unknown dependency 01234567"]);
});

test("a card whose dependencies all resolve shows no unknown-dependency badge", async () => {
  await mountLane([
    card("head", { queue: 1, depends_on: [DONE_ID.slice(0, 8)] }),
    card(DONE_ID, { status: "done" }),
  ]);
  expect(unknownBadges()).toEqual([]);
});
