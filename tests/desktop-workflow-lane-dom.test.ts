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

async function mountLane(
  items: RoadmapItem[],
  handlers: { onReorder?: (ids: string[], waves: string[][]) => void; onStack?: (...a: unknown[]) => void } = {},
): Promise<void> {
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
        ...handlers,
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

function nodeOf(id: string): HTMLElement {
  const title = [...container.querySelectorAll<HTMLElement>(".wf-node-title")].find(
    (el) => el.textContent === id,
  );
  return title!.closest<HTMLElement>(".wf-node")!;
}

function worldZoom(): number {
  const transform = container.querySelector<HTMLElement>(".wf-world")!.style.transform;
  return Number(/scale\(([\d.]+)\)/.exec(transform)![1]);
}

async function stackBelow(id: string, targetId: string): Promise<void> {
  const from = nodeOf(id);
  const to = nodeOf(targetId);
  const zoom = worldZoom();
  const dx = (parseFloat(to.style.left) - parseFloat(from.style.left)) * zoom;
  const dy = (parseFloat(to.style.top) + workflow.WF_NODE_H - parseFloat(from.style.top)) * zoom;
  const canvas = container.querySelector<HTMLElement>(".wf-canvas")!;
  const at = (type: string, x: number, y: number): MouseEvent =>
    new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y });
  await act(async () => {
    from.dispatchEvent(at("mousedown", 1000, 1000));
  });
  await act(async () => {
    canvas.dispatchEvent(at("mousemove", 1000 + dx, 1000 + dy));
  });
  await act(async () => {
    canvas.dispatchEvent(at("mouseup", 1000 + dx, 1000 + dy));
  });
}

function recorder(): {
  reorders: [string[], string[][]][];
  stacks: unknown[][];
  onReorder: (ids: string[], waves: string[][]) => void;
  onStack: (...a: unknown[]) => void;
} {
  const reorders: [string[], string[][]][] = [];
  const stacks: unknown[][] = [];
  return {
    reorders,
    stacks,
    onReorder: (ids, waves) => void reorders.push([ids, waves]),
    onStack: (...a) => void stacks.push(a),
  };
}

test("dropping a card below a dependency-free card commits the card into that wave", async () => {
  const rec = recorder();
  await mountLane(
    [card("a", { queue: 1 }), card("b", { queue: 2 }), card("c", { queue: 3 })],
    rec,
  );
  await stackBelow("c", "a");
  expect(rec.stacks).toEqual([]);
  expect(rec.reorders).toEqual([[["a", "c", "b"], [["a", "c"], ["b"]]]]);
});

test("dropping a card below a card of its own wave commits nothing", async () => {
  const rec = recorder();
  await mountLane([card("a", { queue: 1 }), card("c", { queue: 1 })], rec);
  await stackBelow("c", "a");
  expect(rec.reorders).toEqual([]);
  expect(rec.stacks).toEqual([]);
});

test("dropping the first card of a wave below a card of its own wave commits nothing", async () => {
  const rec = recorder();
  await mountLane([card("a", { queue: 1 }), card("c", { queue: 1 })], rec);
  await stackBelow("a", "c");
  expect(rec.reorders).toEqual([]);
  expect(rec.stacks).toEqual([]);
});

test("dropping a card below a card with dependencies hands them to onStack and commits no reorder itself", async () => {
  const rec = recorder();
  await mountLane(
    [
      card("p", { queue: 1 }),
      card("a", { queue: 2, depends_on: ["p"] }),
      card("c", { queue: 3 }),
    ],
    rec,
  );
  await stackBelow("c", "a");
  expect(rec.stacks).toEqual([["c", "a", ["p"]]]);
  expect(rec.reorders).toEqual([]);
});

test("dropping a queued card with the same dependencies below a card still reaches onStack", async () => {
  const rec = recorder();
  await mountLane(
    [
      card("p", { queue: 1 }),
      card("a", { queue: 2, depends_on: ["p"] }),
      card("c", { queue: 3, depends_on: ["p"] }),
    ],
    rec,
  );
  await stackBelow("c", "a");
  expect(rec.stacks).toEqual([["c", "a", ["p"]]]);
});

test("a directive card dropped below a card keeps a wave of its own", async () => {
  const rec = recorder();
  await mountLane(
    [card("a", { queue: 1 }), card("b", { queue: 2 }), card("d", { queue: 3, kind: "directive", target_peer_ids: [] })],
    rec,
  );
  await stackBelow("d", "a");
  expect(rec.reorders).toEqual([[["a", "d", "b"], [["a"], ["d"], ["b"]]]]);
});

test("a card with an unqueued dependency pulls it in before the target wave and joins that wave", async () => {
  const rec = recorder();
  await mountLane(
    [
      card("a", { queue: 1 }),
      card("b", { queue: 2 }),
      card("c", { queue: 3, depends_on: ["q"] }),
      card("q"),
    ],
    rec,
  );
  await stackBelow("c", "a");
  expect(rec.stacks).toEqual([]);
  expect(rec.reorders).toEqual([[["q", "a", "c", "b"], [["q"], ["a", "c"], ["b"]]]]);
});

test("a card with a two-level unqueued closure pulls it in dependency-first before the target wave", async () => {
  const rec = recorder();
  await mountLane(
    [
      card("a", { queue: 1 }),
      card("b", { queue: 2 }),
      card("c", { queue: 3, depends_on: ["q"] }),
      card("q", { depends_on: ["r"] }),
      card("r"),
    ],
    rec,
  );
  await stackBelow("c", "a");
  expect(rec.reorders).toEqual([[["r", "q", "a", "c", "b"], [["r"], ["q"], ["a", "c"], ["b"]]]]);
});

async function dragSideways(id: string, dxWorld: number): Promise<void> {
  const from = nodeOf(id);
  const dx = dxWorld * worldZoom();
  const canvas = container.querySelector<HTMLElement>(".wf-canvas")!;
  const at = (type: string, x: number): MouseEvent =>
    new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: 1000 });
  await act(async () => {
    from.dispatchEvent(at("mousedown", 1000));
  });
  await act(async () => {
    canvas.dispatchEvent(at("mousemove", 1000 + dx));
  });
  await act(async () => {
    canvas.dispatchEvent(at("mouseup", 1000 + dx));
  });
}

test("a stacked card dragged sideways into the gap after its column leaves the wave although the flat order is unchanged", async () => {
  const rec = recorder();
  await mountLane([card("a", { queue: 1 }), card("c", { queue: 1 }), card("b", { queue: 2 })], rec);
  // Card centre starts at WF_NODE_W / 2; the gap between column 0 and 1 spans WF_NODE_W..WF_PITCH_X.
  await dragSideways("c", (workflow.WF_NODE_W + workflow.WF_PITCH_X) / 2 - workflow.WF_NODE_W / 2);
  expect(rec.stacks).toEqual([]);
  expect(rec.reorders).toEqual([[["a", "c", "b"], [["a"], ["c"], ["b"]]]]);
});

const columnCentre = (col: number): number => col * workflow.WF_PITCH_X + workflow.WF_NODE_W / 2;
const gapAfter = (col: number): number => col * workflow.WF_PITCH_X + (workflow.WF_NODE_W + workflow.WF_PITCH_X) / 2;

test("a singleton card dropped back into its own gap commits nothing", async () => {
  const rec = recorder();
  await mountLane([card("a", { queue: 1 }), card("b", { queue: 2 }), card("c", { queue: 3 })], rec);
  await dragSideways("b", gapAfter(0) - columnCentre(1));
  expect(rec.stacks).toEqual([]);
  expect(rec.reorders).toEqual([]);
});

test("a singleton card dragged into another gap commits its new order as solo waves", async () => {
  const rec = recorder();
  await mountLane([card("a", { queue: 1 }), card("b", { queue: 2 }), card("c", { queue: 3 })], rec);
  await dragSideways("a", gapAfter(1) - columnCentre(0));
  expect(rec.reorders).toEqual([[["b", "a", "c"], [["b"], ["a"], ["c"]]]]);
});
