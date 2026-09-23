import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { Root } from "../desktop/tests-support/react-test-harness";
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
import * as roadmapAppend from "../shared/roadmap-append.ts";
import type { RoadmapItem, RoadmapUpsertFields, RoadmapWandDraft } from "../desktop/src/shared/types.ts";

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
mock.module("@roadmap-append", () => roadmapAppend);

interface FakeState {
  dict: Record<string, string>;
  sessions: unknown[];
  showToast: (key: string, variant?: "success" | "info" | "error") => boolean;
  setView: (v: string) => void;
  roadmapFiltersCollapsed: boolean;
  setRoadmapFiltersCollapsed: (v: boolean) => void;
  roadmapSeed: null;
  clearRoadmapSeed: () => void;
  openRoadmapConflict: (id: string) => void;
}

const toasts: Array<{ key: string; variant: "success" | "info" | "error" | undefined }> = [];
const fakeUseDeck = create<FakeState>(() => ({
  dict: {},
  sessions: [],
  showToast: (key, variant) => {
    toasts.push({ key, variant });
    return true;
  },
  setView: () => {},
  roadmapFiltersCollapsed: false,
  setRoadmapFiltersCollapsed: () => {},
  roadmapSeed: null,
  clearRoadmapSeed: () => {},
  openRoadmapConflict: () => {}
}));
mockStore({ useDeck: fakeUseDeck, ...storeMockStubs });

const { RoadmapView } = await import("../desktop/src/renderer/src/components/RoadmapView");

const APPEND_A = "2026-09-22T12:00:00.000Z";
const APPEND_B = "2026-09-22T12:01:00.000Z";

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

let board: RoadmapItem[] = [];
let upserts: RoadmapUpsertFields[] = [];
let wandDrafts: RoadmapWandDraft[] = [];

function installApi(): void {
  (globalThis as unknown as { window: { api: Record<string, unknown> } }).window.api = {
    roadmapSearch: () => Promise.resolve({ items: board, facets: null }),
    roadmapUpsert: (fields: RoadmapUpsertFields) => {
      upserts.push(fields);
      return Promise.resolve(item({ ...board[0], ...fields } as Partial<RoadmapItem>));
    },
    roadmapReorder: () => Promise.resolve([]),
    roadmapArchive: () => Promise.resolve(item({})),
    roadmapWand: (draft: RoadmapWandDraft) => {
      wandDrafts.push(draft);
      return Promise.resolve("wand addendum");
    },
    reportError: () => Promise.resolve()
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  board = [];
  upserts = [];
  wandDrafts = [];
  toasts.length = 0;
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

async function openCreateForm(): Promise<void> {
  const add = container.querySelector(".roadmap-head button.primary") as HTMLButtonElement | null;
  if (!add) throw new Error("the roadmap header offered no create control");
  await act(async () => {
    add.click();
  });
}

function contextTextarea(): HTMLTextAreaElement {
  const textarea = container.querySelector(".rm-context-field textarea") as HTMLTextAreaElement | null;
  if (!textarea) throw new Error("the edit form rendered no context textarea");
  return textarea;
}

async function setContext(context: string): Promise<void> {
  const textarea = contextTextarea();
  const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  if (!nativeSetter) throw new Error("textarea has no native value setter");
  await act(async () => {
    nativeSetter.call(textarea, context);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function setTitle(title: string): Promise<void> {
  const input = container.querySelector(".rm-modal-form input") as HTMLInputElement | null;
  if (!input) throw new Error("the edit form rendered no title input");
  const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!nativeSetter) throw new Error("title input has no native value setter");
  await act(async () => {
    nativeSetter.call(input, title);
    input.dispatchEvent(new Event("input", { bubbles: true }));
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

async function useWand(): Promise<void> {
  const button = container.querySelector(".rm-wand-btn") as HTMLButtonElement;
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
}

function supersededAppendContext(): { original: string; living: string; expired: string; live: string } {
  const expired = roadmapAppend.buildRoadmapAppendHeader(APPEND_A, "a") + "obsolete";
  const plan = roadmapAppend.planRoadmapContextAppend({
    existingContext: "origin" + expired,
    nowIso: APPEND_B,
    author: "b",
    text: "current",
    supersedes: [APPEND_A]
  });
  if (!plan.ok) throw new Error(plan.message);
  const original = "origin" + expired + plan.appended;
  return { original, living: "origin" + plan.appended, expired, live: plan.appended };
}

test("Save projects expired units out of the textarea and preserves their structural slot", async () => {
  const { original, living, expired, live } = supersededAppendContext();
  const replacement = live.replace("current", "edited current");
  await mountWith(item({ context: original }));
  await openEditForm();

  expect(contextTextarea().value).toBe(living);
  await setContext("origin" + replacement);
  await save();

  expect(upserts).toHaveLength(1);
  expect(upserts[0]!.context).toBe("origin" + expired + replacement);
});

test("Save without an edit preserves a context containing expired units byte-for-byte", async () => {
  const { original } = supersededAppendContext();
  await mountWith(item({ context: original }));
  await openEditForm();
  await save();

  expect(upserts).toHaveLength(1);
  expect(upserts[0]!.context).toBe(original);
});

test("Save refuses text before a structurally expired body instead of losing it", async () => {
  const plan = roadmapAppend.planRoadmapContextAppend({
    existingContext: "origin",
    nowIso: APPEND_A,
    author: "a",
    text: "replacement",
    supersedes: [roadmapAppend.ROADMAP_APPEND_BODY_TARGET]
  });
  if (!plan.ok) throw new Error(plan.message);
  const live = plan.appended;
  const original = "origin" + live;
  await mountWith(item({ context: original }));
  await openEditForm();
  await setContext("operator note" + live);
  await save();

  expect(upserts).toEqual([]);
  expect(toasts).toContainEqual({ key: "roadmap.contextExpiredBodyPrefix", variant: "error" });
});

test("an ambiguous timestamp context stays raw so a Save cannot silently drop either unit", async () => {
  const first = roadmapAppend.buildRoadmapAppendHeader(APPEND_A, "a") + "first";
  const second = roadmapAppend.buildRoadmapAppendHeader(APPEND_A, "b") + "second";
  const original = "origin" + first + second;
  await mountWith(item({ context: original }));
  await openEditForm();

  expect(contextTextarea().value).toBe(original);
  await save();
  expect(upserts[0]!.context).toBe(original);
});

test("wand appends its proposal to marked living context without reviving expired units", async () => {
  const { original, living } = supersededAppendContext();
  await mountWith(item({ context: original }));
  await openEditForm();
  await useWand();

  expect(wandDrafts).toEqual([
    expect.objectContaining({ context: living, mode: "append" })
  ]);
  expect(contextTextarea().value).toBe(living + "\n\nwand addendum");
  await save();
  expect(upserts[0]!.context).toBe(original + "\n\nwand addendum");
  expect(roadmapAppend.getRoadmapContextLiveLength(upserts[0]!.context!)).toBe(
    roadmapAppend.getRoadmapContextLiveLength(original) + "\n\nwand addendum".length
  );
});

test("wand appends when an append header is pasted after opening an existing draft", async () => {
  const pasted = "operator context" + roadmapAppend.buildRoadmapAppendHeader(APPEND_A, "a") + "marked note";
  await mountWith(item({ context: "operator context" }));
  await openEditForm();
  await setContext(pasted);
  await useWand();

  expect(wandDrafts).toEqual([
    expect.objectContaining({ context: pasted, mode: "append" })
  ]);
  expect(contextTextarea().value).toBe(pasted + "\n\nwand addendum");
});

test("wand appends when a creation draft receives an append header", async () => {
  const marked = roadmapAppend.buildRoadmapAppendHeader(APPEND_A, "a") + "marked note";
  await mountWith(item({ context: "" }));
  await openCreateForm();
  await setTitle("created card");
  await setContext(marked);
  await useWand();

  expect(wandDrafts).toEqual([
    expect.objectContaining({ context: marked, mode: "append" })
  ]);
  expect(contextTextarea().value).toBe(marked + "\n\nwand addendum");
});
