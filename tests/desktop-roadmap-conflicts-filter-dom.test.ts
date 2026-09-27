// Card 143acd26: the conflict banner narrows the Roadmap view to the cards in
// replication conflict. A narrowed board with no sign of the narrowing lies
// (the empty-board precedent of card 442084b7), so the filter must render as a
// removable chip, and clear-all must take it too.

import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { Root } from "../desktop/tests-support/react-test-harness"; // type-only: erased, no runtime resolution
import type { RoadmapItem, RoadmapQuery, RoadmapSyncStatus } from "../desktop/src/shared/types.ts";
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

// One fake store serves the banner and the view together, so the banner's
// action and the view's consumption of it meet in the same state.
interface FakeState {
  dict: Record<string, string>;
  view: string;
  mobile: boolean;
  sessions: unknown[];
  brokerStatus: { up: boolean; since: number; lastError: string | null };
  offlineBannerDismissed: number | null;
  dismissOfflineBanner: () => void;
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
    view: "agents",
    mobile: false,
    sessions: [],
    brokerStatus: { up: true, since: 0, lastError: null },
    offlineBannerDismissed: null,
    dismissOfflineBanner: () => {},
    roadmapSync: { status: { mode: "local" }, conflicts: [] },
    showToast: () => true,
    setView: (v) => fakeUseDeck.setState({ view: v }),
    roadmapFiltersCollapsed: false,
    setRoadmapFiltersCollapsed: () => {},
    roadmapSeed: null,
    clearRoadmapSeed: () => {},
    openRoadmapConflict: () => {},
    roadmapConflictsSeed: false,
    openRoadmapConflictsFilter: () => fakeUseDeck.setState({ roadmapConflictsSeed: true, view: "roadmap" }),
    clearRoadmapConflictsSeed: () => fakeUseDeck.setState({ roadmapConflictsSeed: false })
  };
}

const fakeUseDeck = create<FakeState>(() => initialFakeState());
mockStore({
  useDeck: fakeUseDeck,
  ...storeMockStubs,
  roadmapConflictCount: (s: FakeState): number => s.roadmapSync.conflicts.length
});

const { RoadmapFilterChips } = await import(
  "../desktop/src/renderer/src/components/RoadmapFilterChips"
);
const { RoadmapBoard } = await import("../desktop/src/renderer/src/components/RoadmapBoard");
const { RoadmapView } = await import("../desktop/src/renderer/src/components/RoadmapView");
const { StatusBanner } = await import("../desktop/src/renderer/src/components/StatusBanner");

function t(key: string, params?: Record<string, string | number>): string {
  return params ? `${key}${JSON.stringify(params)}` : key;
}

let container: HTMLDivElement;
let root: Root;
let calls: string[];
let cards: RoadmapItem[];
let searches: Array<{ include_archived?: boolean }>;

// The board's stop controls probe window.api and fall back to "unavailable"
// when a channel is missing, so only the roadmap channels are provided.
function installApi(): void {
  (window as unknown as { api: object }).api = {
    roadmapSearch: (q: { include_archived?: boolean }) => {
      searches.push({ include_archived: q.include_archived });
      const items = cards.filter((c) => q.include_archived || c.status !== "archived");
      return Promise.resolve({ items, facets: null });
    },
    roadmapList: () => Promise.resolve(cards),
    reportError: () => undefined
  };
}

beforeEach(() => {
  calls = [];
  cards = [];
  searches = [];
  fakeUseDeck.setState(initialFakeState(), true);
  installApi();
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

function mount(conflictsOnly: boolean, conflictCount = 0): void {
  act(() => {
    root.render(
      React.createElement(RoadmapFilterChips, {
        criteria: {},
        setCriteria: (next: RoadmapQuery) => calls.push(`setCriteria:${JSON.stringify(next)}`),
        includeArchived: conflictsOnly,
        setIncludeArchived: (v: boolean) => calls.push(`setIncludeArchived:${v}`),
        hideInactive: false,
        setHideInactive: (v: boolean) => calls.push(`setHideInactive:${v}`),
        hiddenInactiveCount: 0,
        conflictsOnly,
        conflictCount,
        onClearConflicts: () => calls.push("onClearConflicts"),
        t
      })
    );
  });
}

function conflictChip(): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>(".rm-filter-chip")].find((el) =>
    (el.querySelector(".rm-filter-chip-label")?.textContent ?? "").startsWith(
      "roadmap.filter.conflictsOnly"
    )
  );
}

test("the conflict filter renders as a chip carrying its count, so a narrowed board says it is narrowed", () => {
  mount(true, 2);
  const chip = conflictChip();
  expect(chip, "an active conflict filter must be visible without opening the panel").toBeDefined();
  expect(chip!.querySelector(".rm-filter-chip-label")!.textContent).toBe(
    'roadmap.filter.conflictsOnly{"count":2}'
  );
  expect(chip!.querySelector("svg"), "the chip echoes the banner's scales glyph").not.toBeNull();
});

test("no conflict chip while the filter is off", () => {
  mount(false);
  expect(conflictChip()).toBeUndefined();
});

test("clicking the conflict chip lifts the filter through the view's own restore path", () => {
  mount(true, 1);
  act(() => {
    conflictChip()!.click();
  });
  expect(
    calls,
    "the chip must hand the removal to the view, which restores the archive toggle it forced"
  ).toEqual(["onClearConflicts"]);
});

test("clear-all takes the conflict filter with it", () => {
  mount(true, 1);
  const clear = container.querySelector<HTMLButtonElement>(".rm-filter-chip-clear");
  if (!clear) throw new Error("no clear-all chip rendered while the conflict filter was active");
  act(() => {
    clear.click();
  });
  expect(
    calls,
    "a clear-all that forgot the conflict filter would leave the board narrowed with no chip left to say so"
  ).toContain("onClearConflicts");
  expect(calls).toContain("setIncludeArchived:false");
});

function mountEmptyBoard(emptyFilteredText?: string): void {
  const noop = (): void => undefined;
  act(() => {
    root.render(
      React.createElement(RoadmapBoard, {
        items: [],
        showArchived: true,
        hasActiveFilters: true,
        onClearFilters: () => calls.push("onClearFilters"),
        emptyFilteredText,
        loaded: true,
        error: null,
        dragId: null,
        dropCol: null,
        onDragStartItem: noop,
        onDragEndItem: noop,
        onDragOverCol: noop,
        onDragLeaveCol: noop,
        onDropCol: noop,
        onOpen: noop,
        onMenu: noop,
        onPrio: noop,
        onArchiveAll: noop,
        archiveAllBusy: false,
        t
      })
    );
  });
}

test("a conflict filter that shows nothing says why in the board's ONE empty state, clear action kept", () => {
  mountEmptyBoard('roadmap.filter.conflictsNoneVisible{"count":1}');
  const empties = container.querySelectorAll(".roadmap-empty");
  expect(empties.length, "two stacked empty states is the defect this prop exists to prevent").toBe(1);
  expect(empties[0]!.textContent).toContain('roadmap.filter.conflictsNoneVisible{"count":1}');
  expect(empties[0]!.textContent).not.toContain("roadmap.emptyFiltered");
  const clear = empties[0]!.querySelector<HTMLButtonElement>(".rm-empty-clear-filters");
  if (!clear) throw new Error("the specific empty text must not drop the clear-filters action");
  act(() => {
    clear.click();
  });
  expect(calls).toEqual(["onClearFilters"]);
});

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
    ...patch
  };
}

function Shell(): React.JSX.Element {
  const view = fakeUseDeck((s) => s.view);
  return React.createElement(
    React.Fragment,
    null,
    React.createElement(StatusBanner),
    view === "roadmap" ? React.createElement(RoadmapView) : null
  );
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

function shownTitles(): string[] {
  return [...container.querySelectorAll(".rm-card")]
    .map((el) =>
      ["clean-card", "open-conflict", "archived-conflict", "archived-clean"].find((id) => el.textContent?.includes(id))
    )
    .filter((id): id is string => id !== undefined)
    .sort();
}

test("banner click opens the roadmap narrowed to the conflicted cards, the archived one included, and lifting the chip restores the board", async () => {
  cards = [
    card("clean-card", {}),
    card("open-conflict", { sync_state: "conflict" }),
    card("archived-conflict", { status: "archived", deleted_at: "2026-09-02T00:00:00.000Z", sync_state: "conflict" })
  ];
  fakeUseDeck.setState({
    dict: { "roadmap.filter.conflictsOnly": "conflicts ({count})" },
    roadmapSync: {
      status: { mode: "replica", online: true, pending_push: 0, last_error: null } as RoadmapSyncStatus,
      conflicts: [{ local: { id: "open-conflict" } }, { local: { id: "archived-conflict" } }]
    }
  });
  await act(async () => {
    root.render(React.createElement(Shell));
  });

  const open = [...container.querySelectorAll("button")].find((b) => b.textContent === "banner.openRoadmap");
  if (!open) throw new Error("the conflicts banner rendered no open-the-roadmap button");
  await act(async () => {
    open.click();
  });
  await settle();

  expect(fakeUseDeck.getState().roadmapConflictsSeed, "the view must consume the banner's one-shot request").toBe(false);
  expect(
    shownTitles(),
    "only the conflicted cards may show, the archived one included -- it is invisible on a default board"
  ).toEqual(["archived-conflict", "open-conflict"]);
  const chip = [...container.querySelectorAll(".rm-filter-chip-label")].find((el) =>
    (el.textContent ?? "").startsWith("conflicts (")
  );
  expect(chip?.textContent, "the narrowing must be visible as a chip carrying its count").toBe("conflicts (2)");

  await act(async () => {
    (chip!.closest("button") as HTMLButtonElement).click();
  });
  await settle();

  expect(
    shownTitles(),
    "lifting the chip must restore the archive toggle the operator had (off), not keep the forced one"
  ).toEqual(["clean-card", "open-conflict"]);
  expect(searches.at(-1)?.include_archived).toBe(false);
  expect(container.querySelector(".rm-col-head-archived")).toBeNull();
});

function replicaWithConflicts(ids: string[]): void {
  fakeUseDeck.setState({
    dict: {
      "roadmap.filter.conflictsOnly": "conflicts ({count})",
      "roadmap.filter.conflictsNoneVisible": "none visible ({count})"
    },
    roadmapSync: {
      status: { mode: "replica", online: true, pending_push: 0, last_error: null } as RoadmapSyncStatus,
      conflicts: ids.map((id) => ({ local: { id } }))
    }
  });
}

async function clickBanner(): Promise<void> {
  const open = [...container.querySelectorAll("button")].find((b) => b.textContent === "banner.openRoadmap");
  if (!open) throw new Error("the conflicts banner rendered no open-the-roadmap button");
  await act(async () => {
    open.click();
  });
  await settle();
}

function conflictChipLabel(): Element | undefined {
  return [...container.querySelectorAll(".rm-filter-chip-label")].find((el) =>
    (el.textContent ?? "").startsWith("conflicts (")
  );
}

test("conflicts counted by the banner but none on the board: the ONE empty state says so, and its clear action lifts the conflict filter", async () => {
  cards = [card("clean-card", {})];
  replicaWithConflicts(["gone-elsewhere"]);
  fakeUseDeck.setState({ view: "roadmap" });
  await act(async () => {
    root.render(React.createElement(Shell));
  });
  await settle();
  await clickBanner();

  expect(fakeUseDeck.getState().roadmapConflictsSeed).toBe(false);
  expect(shownTitles()).toEqual([]);
  const empties = container.querySelectorAll(".roadmap-empty");
  expect(empties.length, "a narrowed board showing nothing must never be silent, nor say twice").toBe(1);
  expect(
    empties[0]!.textContent,
    "the empty state must name the conflicts it cannot show, with the banner's count"
  ).toContain("none visible (1)");

  const clear = empties[0]!.querySelector<HTMLButtonElement>(".rm-empty-clear-filters");
  if (!clear) throw new Error("the conflict empty state lost its clear-filters action");
  await act(async () => {
    clear.click();
  });
  await settle();
  expect(conflictChipLabel(), "clearing from the empty state must lift the conflict filter too").toBeUndefined();
  expect(shownTitles()).toEqual(["clean-card"]);
});

test("the banner replaces the operator's search and keeps their archive toggle to restore it", async () => {
  cards = [
    card("clean-card", {}),
    card("open-conflict", { sync_state: "conflict" }),
    card("archived-clean", { status: "archived", deleted_at: "2026-09-02T00:00:00.000Z" })
  ];
  replicaWithConflicts(["open-conflict"]);
  fakeUseDeck.setState({ view: "roadmap" });
  await act(async () => {
    root.render(React.createElement(Shell));
  });
  await settle();

  await act(async () => {
    (container.querySelector(".rm-filter-archived-toggle") as HTMLButtonElement).click();
  });
  const search = container.querySelector(".rm-filter-search-input") as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!setter) throw new Error("input has no native value setter");
  await act(async () => {
    setter.call(search, "needle");
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
  expect(searches.at(-1)?.include_archived, "precondition: the operator had archives on").toBe(true);
  expect(search.value).toBe("needle");

  await clickBanner();
  expect(
    (container.querySelector(".rm-filter-search-input") as HTMLInputElement).value,
    "a leftover search would hide conflicted cards behind an unrelated criterion"
  ).toBe("");
  expect(shownTitles()).toEqual(["open-conflict"]);

  await act(async () => {
    (conflictChipLabel()!.closest("button") as HTMLButtonElement).click();
  });
  await settle();
  expect(
    shownTitles(),
    "lifting the chip must hand back the archive toggle the operator had (on)"
  ).toEqual(["archived-clean", "clean-card", "open-conflict"]);
  expect(searches.at(-1)?.include_archived).toBe(true);
});

test("without a specific text the filtered empty state keeps its generic line", () => {
  mountEmptyBoard();
  const empties = container.querySelectorAll(".roadmap-empty");
  expect(empties.length).toBe(1);
  expect(empties[0]!.textContent).toContain("roadmap.emptyFiltered");
});
