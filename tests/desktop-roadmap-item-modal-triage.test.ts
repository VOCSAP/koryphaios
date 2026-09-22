import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { Root } from "../desktop/tests-support/react-test-harness"; // type-only: erased, no runtime resolution
import { mockStore, storeMockStubs } from "./_store-mock";
import * as sharedWorkflow from "../desktop/src/shared/workflow.ts";
import type { RoadmapItem } from "../desktop/src/shared/types.ts";

const { act, React, createRoot, create } = await import("../desktop/tests-support/react-test-harness");

// '@shared/*' is a tsconfig-only alias that bun does not resolve from the repo
// root; the real module is re-exported rather than stubbed.
mock.module("@shared/workflow", () => sharedWorkflow);

interface FakeState {
  dict: Record<string, string>;
  sessions: unknown[];
  openRoadmapConflict: (id: string) => void;
  showToast: (key: string) => void;
}

const fakeUseDeck = create<FakeState>(() => ({
  dict: {},
  sessions: [],
  openRoadmapConflict: () => {},
  showToast: () => {}
}));
mockStore({ useDeck: fakeUseDeck, ...storeMockStubs });

const { RoadmapItemModal } = await import(
  "../desktop/src/renderer/src/components/RoadmapItemModal"
);

function item(patch: Partial<RoadmapItem>): RoadmapItem {
  return {
    id: "11111111-2222-3333-4444-555555555555",
    project_key: "github.com/vocsap/x",
    kind: "feature",
    title: "a card",
    description: "",
    rationale: "",
    context: "",
    priority: "could",
    value: "medium",
    effort: "medium",
    status: "planned",
    triage: null,
    tags: [],
    depends_on: [],
    created_by: "agent-a",
    updated_by: "agent-a",
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
    deleted_at: null,
    queue: null,
    directive: null,
    target_peer_ids: [],
    locked: false,
    locked_by: null,
    locked_at: null,
    locked_group: null,
    inactive: false,
    sync_state: "clean",
    lock_scope: null,
    lock_contested_by: [],
    ...patch
  };
}

let container: HTMLDivElement;
let root: Root;
const noop = (): void => {};

beforeEach(() => {
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

function mount(i: RoadmapItem): void {
  act(() => {
    root.render(
      React.createElement(RoadmapItemModal, {
        item: i,
        items: [i],
        onClose: noop,
        onEdit: noop,
        onLaunch: noop,
        onStop: noop,
        onQueue: noop,
        onUnqueue: noop,
        onArchive: noop,
        onRestore: noop,
        onAddDep: noop,
        onRemoveDep: noop
      })
    );
  });
}

test("an untriaged card shows no triage badge at all", () => {
  mount(item({ triage: null }));
  expect(container.querySelector('[class*="rm-badge-triage-"]')).toBeNull();
  expect(container.textContent).not.toContain("roadmap.triage.");
});

test("ready-for-agent gets its own coloured badge class", () => {
  mount(item({ triage: "ready-for-agent" }));
  const badge = container.querySelector(".rm-badge-triage-ready-for-agent");
  expect(badge).not.toBeNull();
  expect(badge!.textContent).toBe("roadmap.triage.ready-for-agent");
});

test("the other four roles render, but never borrow the ready-for-agent class", () => {
  for (const role of ["needs-triage", "needs-info", "ready-for-human", "wontfix"] as const) {
    mount(item({ triage: role }));
    expect(container.querySelector(`.rm-badge-triage-${role}`)).not.toBeNull();
    expect(container.querySelector(".rm-badge-triage-ready-for-agent")).toBeNull();
  }
});
