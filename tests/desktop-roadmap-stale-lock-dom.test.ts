// A work-lock can outlive in_progress (an import writes `locked` as-is). Such a
// card must read as locked in the Deck: its context menu must not offer Edit,
// and its detail modal must offer Stop, the one gesture that releases it.

import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { Root } from "../desktop/tests-support/react-test-harness"; // type-only: erased, no runtime resolution
import type { RoadmapItem, RoadmapSyncStatus } from "../desktop/src/shared/types.ts";
import { mockStore, storeMockStubs } from "./_store-mock";
import * as sharedWorkflow from "../desktop/src/shared/workflow.ts";
import * as sharedTypes from "../desktop/src/shared/types.ts";
import * as sharedModels from "../desktop/src/shared/models.ts";
import * as sharedGraph from "../desktop/src/shared/graph.ts";
import * as sharedAnnounce from "../desktop/src/shared/announce.ts";
import * as sharedRoadmapSync from "../desktop/src/shared/roadmap-sync.ts";
import * as sharedRole from "../desktop/src/shared/role.ts";
import * as sharedTemplateApply from "../desktop/src/shared/template-apply-outcome.ts";
import * as sharedWorkspaceRestore from "../desktop/src/shared/workspace-restore-outcome.ts";
import * as sharedStatusBanner from "../desktop/src/shared/status-banner.ts";
import * as roadmapAppend from "../shared/roadmap-append.ts";

const { act, React, createRoot, create } = await import("../desktop/tests-support/react-test-harness");

mock.module("@shared/workflow", () => sharedWorkflow);
mock.module("@shared/types", () => sharedTypes);
mock.module("@shared/models", () => sharedModels);
mock.module("@shared/graph", () => sharedGraph);
mock.module("@shared/announce", () => sharedAnnounce);
mock.module("@shared/roadmap-sync", () => sharedRoadmapSync);
mock.module("@shared/role", () => sharedRole);
mock.module("@shared/template-apply-outcome", () => sharedTemplateApply);
mock.module("@shared/workspace-restore-outcome", () => sharedWorkspaceRestore);
mock.module("@shared/status-banner", () => sharedStatusBanner);
mock.module("@roadmap-append", () => roadmapAppend);

interface FakeState {
  dict: Record<string, string>;
  view: string;
  mobile: boolean;
  sessions: unknown[];
  brokerStatus: { up: boolean; since: number; lastError: string | null };
  roadmapSync: { status: RoadmapSyncStatus; conflicts: Array<{ local: { id: string } }> };
  showToast: () => boolean;
  setView: (v: string) => void;
  roadmapFiltersCollapsed: boolean;
  setRoadmapFiltersCollapsed: (v: boolean) => void;
  roadmapSeed: null;
  clearRoadmapSeed: () => void;
  openRoadmapConflict: (id: string) => void;
  roadmapConflictsSeed: boolean;
  openRoadmapConflictsFilter: () => void;
  clearRoadmapConflictsSeed: () => void;
}

function initialFakeState(): FakeState {
  return {
    dict: {},
    view: "roadmap",
    mobile: false,
    sessions: [],
    brokerStatus: { up: true, since: 0, lastError: null },
    roadmapSync: { status: { mode: "local" }, conflicts: [] },
    showToast: () => true,
    setView: () => {},
    roadmapFiltersCollapsed: false,
    setRoadmapFiltersCollapsed: () => {},
    roadmapSeed: null,
    clearRoadmapSeed: () => {},
    openRoadmapConflict: () => {},
    roadmapConflictsSeed: false,
    openRoadmapConflictsFilter: () => {},
    clearRoadmapConflictsSeed: () => {},
  };
}

const fakeUseDeck = create<FakeState>(() => initialFakeState());
mockStore({
  useDeck: fakeUseDeck,
  ...storeMockStubs,
  roadmapConflictCount: (s: FakeState): number => s.roadmapSync.conflicts.length,
});

const { RoadmapView } = await import("../desktop/src/renderer/src/components/RoadmapView");
const { RoadmapItemModal } = await import("../desktop/src/renderer/src/components/RoadmapItemModal");

function card(id: string, patch: Partial<RoadmapItem>): RoadmapItem {
  return {
    id,
    project_key: "github.com/vocsap/x",
    kind: "feature",
    title: id,
    description: "",
    rationale: "",
    context: "",
    priority: "should",
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
    ...patch,
  };
}

const STALE = card("stale-lock-card", { status: "planned", locked: true, locked_by: "agent-gone", locked_at: "2026-09-01T00:00:00.000Z" });
const FREE = card("free-card", { status: "planned" });

let container: HTMLDivElement;
let root: Root;
let cards: RoadmapItem[];

beforeEach(() => {
  cards = [];
  fakeUseDeck.setState(initialFakeState(), true);
  (window as unknown as { api: object }).api = {
    roadmapSearch: () => Promise.resolve({ items: cards, facets: null }),
    roadmapList: () => Promise.resolve(cards),
    reportError: () => undefined,
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

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function menuEditOf(id: string): Promise<HTMLButtonElement> {
  const target = [...container.querySelectorAll<HTMLElement>(".rm-card")].find((el) => el.textContent?.includes(id));
  if (!target) throw new Error(`card ${id} is not on the board`);
  await act(async () => {
    target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
  });
  const edit = [...document.querySelectorAll<HTMLButtonElement>('.context-menu [role="menuitem"]')].find((b) =>
    b.textContent?.includes("roadmap.menuEdit")
  );
  if (!edit) throw new Error(`the context menu of ${id} has no Edit entry`);
  return edit;
}

test("context menu: Edit is disabled on a card locked outside in_progress, enabled on a free one", async () => {
  cards = [STALE, FREE];
  await act(async () => {
    root.render(React.createElement(RoadmapView));
  });
  await settle();

  expect(["stale lock: Edit disabled", (await menuEditOf("stale-lock-card")).disabled]).toEqual([
    "stale lock: Edit disabled",
    true,
  ]);
  const backdrop = document.querySelector<HTMLElement>(".context-menu-backdrop");
  await act(async () => {
    backdrop?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  });
  expect(["free card: Edit enabled", (await menuEditOf("free-card")).disabled]).toEqual([
    "free card: Edit enabled",
    false,
  ]);
});

function mountModal(i: RoadmapItem): void {
  const noop = (): void => {};
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
        onRemoveDep: noop,
      })
    );
  });
}

function stopButton(): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>(".rm-detail-actions button")].find((b) =>
    b.textContent?.includes("roadmap.stop")
  );
}

test("detail modal: Stop is offered on a card locked outside in_progress, absent on a free one", () => {
  mountModal(STALE);
  expect(["stale lock: Stop offered", stopButton() !== undefined]).toEqual(["stale lock: Stop offered", true]);
  mountModal(FREE);
  expect(["free card: no Stop", stopButton() !== undefined]).toEqual(["free card: no Stop", false]);
});
