import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { Root } from "../desktop/tests-support/react-test-harness"; // type-only: erased, no runtime resolution
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
import type { RoadmapItem, RoadmapUpsertFields } from "../desktop/src/shared/types.ts";

const { act, React, createRoot, create } = await import("../desktop/tests-support/react-test-harness");

// '@shared/*' is a tsconfig-only alias that bun does not resolve from the repo
// root; the real modules are re-exported rather than stubbed.
mock.module("@shared/workflow", () => sharedWorkflow);
mock.module("@shared/types", () => sharedTypes);
mock.module("@shared/models", () => sharedModels);
mock.module("@shared/graph", () => sharedGraph);
mock.module("@shared/announce", () => sharedAnnounce);
mock.module("@shared/roadmap-sync", () => sharedRoadmapSync);
mock.module("@shared/role", () => sharedRole);
mock.module("@shared/template-apply-outcome", () => sharedTemplateApply);
mock.module("@shared/workspace-restore-outcome", () => sharedWorkspaceRestore);

interface FakeState {
  dict: Record<string, string>;
  sessions: unknown[];
  showToast: (key: string) => void;
  setView: (v: string) => void;
  roadmapFiltersCollapsed: boolean;
  setRoadmapFiltersCollapsed: (v: boolean) => void;
  roadmapSeed: null;
  clearRoadmapSeed: () => void;
  openRoadmapConflict: (id: string) => void;
}

const fakeUseDeck = create<FakeState>(() => ({
  dict: {},
  sessions: [],
  showToast: () => {},
  setView: () => {},
  roadmapFiltersCollapsed: false,
  setRoadmapFiltersCollapsed: () => {},
  roadmapSeed: null,
  clearRoadmapSeed: () => {},
  openRoadmapConflict: () => {}
}));
mockStore({ useDeck: fakeUseDeck, ...storeMockStubs });

const { RoadmapView } = await import("../desktop/src/renderer/src/components/RoadmapView");

function item(patch: Partial<RoadmapItem>): RoadmapItem {
  return {
    id: "card-under-edit",
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

let upserts: RoadmapUpsertFields[] = [];
let board: RoadmapItem[] = [];

function installApi(): void {
  (globalThis as unknown as { window: { api: Record<string, unknown> } }).window.api = {
    roadmapSearch: () => Promise.resolve({ items: board, facets: null }),
    roadmapUpsert: (fields: RoadmapUpsertFields) => {
      upserts.push(fields);
      return Promise.resolve(item({ ...board[0], ...fields } as Partial<RoadmapItem>));
    },
    roadmapReorder: () => Promise.resolve([]),
    roadmapArchive: () => Promise.resolve(item({})),
    reportError: () => Promise.resolve()
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  upserts = [];
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

async function mountWith(card: RoadmapItem): Promise<void> {
  board = [card];
  await act(async () => {
    root.render(React.createElement(RoadmapView));
  });
  await act(async () => {
    await Promise.resolve();
  });
}

/** Card -> detail -> edit form, the only route an operator has to the select.
 *  The buttons of the detail head hold a glyph and no text, so they are
 *  addressed by their title rather than by their order. */
async function openEditForm(): Promise<void> {
  await act(async () => {
    (container.querySelector(".rm-card") as HTMLElement).click();
  });
  const edit = container.querySelector(
    '.rm-detail-head .icon-btn[title="common.edit"]'
  ) as HTMLButtonElement | null;
  if (!edit) throw new Error("the card detail offered no edit control");
  await act(async () => {
    edit.click();
  });
}

function triageSelect(): HTMLSelectElement {
  const field = [...container.querySelectorAll(".rm-modal-form .field")].find(
    (el) => (el.querySelector("span")?.textContent ?? "").trim() === "roadmap.fieldTriage"
  );
  if (!field) throw new Error("the edit form rendered no Triage field");
  return field.querySelector("select") as HTMLSelectElement;
}

async function pick(value: string): Promise<void> {
  const select = triageSelect();
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function save(): Promise<void> {
  const button = container.querySelector(
    ".rm-modal-form .modal-actions button.primary"
  ) as HTMLButtonElement;
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
}

test("the form offers the five roles plus an explicit untriaged option", async () => {
  await mountWith(item({ triage: null }));
  await openEditForm();
  const options = [...triageSelect().options].map((o) => o.value);
  expect(
    options,
    "the empty value is how an operator takes a role back off a card"
  ).toEqual(["", ...sharedTypes.ROADMAP_TRIAGE_ROLES]);
});

test("an untriaged card opens on the untriaged option, not on a role it does not carry", async () => {
  await mountWith(item({ triage: null }));
  await openEditForm();
  expect(
    triageSelect().value,
    "a select defaulting to the first role would silently retriage every card it edits"
  ).toBe("");
});

test("picking a role sends it on the upsert", async () => {
  await mountWith(item({ triage: null }));
  await openEditForm();
  await pick("ready-for-agent");
  await save();
  expect(upserts, "saving the form must write exactly once").toHaveLength(1);
  expect(
    upserts[0]!.triage,
    "the role chosen in the form is what the broker must receive"
  ).toBe("ready-for-agent");
});

test("a triaged card opens on its own role and can be cleared back to untriaged", async () => {
  await mountWith(item({ triage: "needs-info" }));
  await openEditForm();
  expect(triageSelect().value, "the form must show the role the card carries").toBe("needs-info");
  await pick("");
  await save();
  expect(
    upserts[0]!.triage,
    "clearing must travel as an explicit null; an omitted key would leave the old role standing"
  ).toBeNull();
});
