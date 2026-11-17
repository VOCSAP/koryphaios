import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Root } from "../desktop/tests-support/react-test-harness";
import type {
  AssignResult,
  DispatchResult,
  RoadmapItem,
  RoadmapSyncStatus,
  StopResult,
} from "../desktop/src/shared/types.ts";
import { assignFeedback, dispatchFeedback, stopFeedback } from "../desktop/src/renderer/src/dispatch-feedback.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EN_DEFAULTS } from "../desktop/src/main/i18n.ts";
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
import * as sharedHoldGesture from "../desktop/src/shared/hold-gesture.ts";
import * as roadmapAppend from "../shared/roadmap-append.ts";

const LOCALES = join(import.meta.dir, "..", "desktop", "locales");
const member = (id: string) => ({ id, title: id, kind: "feature" });

describe("selection", () => {
  const dispatchCases: Array<[string, DispatchResult, string, string, Record<string, number>?]> = [
    ["whole wave sent", { sent: true, delivery: "sent", dispatched: [member("a"), member("b")] }, "toast.dispatched", "success"],
    [
      "sent with cards left out",
      { sent: true, delivery: "sent", dispatched: [member("a"), member("b")], notSent: [member("c")] },
      "toast.dispatchPartial",
      "info",
      { sent: 2, n: 1 },
    ],
    ["pre-atomic single send", { sent: true, title: "a" }, "toast.dispatched", "success"],
    [
      "pre-atomic partial falls back on count",
      { sent: true, count: 3, notSent: [member("d")] },
      "toast.dispatchPartial",
      "info",
      { sent: 3, n: 1 },
    ],
    ["unknown", { sent: false, delivery: "unknown", reason: "unconfirmed", unconfirmed: [member("a")] }, "toast.orderUnconfirmed", "info"],
    [
      "unknown with cards left out",
      { sent: false, delivery: "unknown", reason: "unconfirmed", notSent: [member("c")] },
      "toast.orderUnconfirmed",
      "info",
    ],
    ["card-changed", { sent: false, delivery: "not-sent", reason: "card-changed", notSent: [member("a")] }, "toast.orderCardChanged", "info"],
    ["queue-changed", { sent: false, delivery: "not-sent", reason: "queue-changed" }, "toast.orderCardChanged", "info"],
    ["ineligible", { sent: false, delivery: "not-sent", reason: "ineligible" }, "toast.orderCardChanged", "info"],
    [
      "pre-atomic wave with cards announced then closed",
      { sent: true, count: 2, titles: ["a", "b"], dispatched: [member("a"), member("b")], skipped: [member("c")] },
      "toast.dispatchSkipped",
      "info",
      { sent: 2, n: 1 },
    ],
    [
      "pre-atomic wave whose every announced card closed",
      { sent: true, skipped: [member("a"), member("b")] },
      "toast.dispatchSkipped",
      "info",
      { sent: 0, n: 2 },
    ],
    ["write-failed", { sent: false, delivery: "not-sent", reason: "write-failed" }, "toast.orderNotSent", "info"],
    ["cancelled-before-execution", { sent: false, delivery: "not-sent", reason: "cancelled-before-execution" }, "toast.orderNotSent", "info"],
    ["error", { sent: false, reason: "error" }, "toast.dispatchFailed", "info"],
    ["empty-queue", { sent: false, reason: "empty-queue" }, "toast.dispatchFailed", "info"],
    ["no-lead", { sent: false, reason: "no-lead" }, "toast.dispatchNoLead", "info"],
  ];
  for (const [name, result, key, level, params] of dispatchCases) {
    test(`dispatch, ${name} -> ${key} (${level})`, () => {
      expect(dispatchFeedback(result)).toEqual({ key, level, ...(params ? { params } : {}) } as never);
    });
  }

  const assignCases: Array<[string, AssignResult, string, string]> = [
    ["sent", { sent: true, delivery: "sent" }, "toast.assignSent", "success"],
    ["unknown", { sent: false, delivery: "unknown", reason: "unconfirmed" }, "toast.orderUnconfirmed", "info"],
    ["card-changed", { sent: false, delivery: "not-sent", reason: "card-changed" }, "toast.orderCardChanged", "info"],
    ["ineligible", { sent: false, delivery: "not-sent", reason: "ineligible" }, "toast.orderCardChanged", "info"],
    ["pre-atomic, card closed after the announce", { sent: true, writeSkipped: true }, "toast.assignSkipped", "info"],
    ["write-failed", { sent: false, delivery: "not-sent", reason: "write-failed" }, "toast.orderNotSent", "info"],
    ["cancelled-before-execution", { sent: false, delivery: "not-sent", reason: "cancelled-before-execution" }, "toast.orderNotSent", "info"],
    ["error", { sent: false, reason: "error" }, "toast.assignFailed", "info"],
  ];
  for (const [name, result, key, level] of assignCases) {
    test(`assign, ${name} -> ${key} (${level})`, () => {
      expect(assignFeedback(result)).toEqual({ key, level } as never);
    });
  }

  const stopCases: Array<[string, StopResult, string, string]> = [
    ["card-changed", { stopped: false, via: "none", reason: "card-changed" }, "toast.stopCardChanged", "info"],
    ["not-found", { stopped: false, via: "none", reason: "not-found" }, "toast.stopNotFound", "info"],
    ["no reason", { stopped: false, via: "none" }, "toast.stopFailed", "info"],
    ["supervisor", { stopped: true, via: "supervisor" }, "toast.stopSupervisor", "success"],
    ["broadcast", { stopped: true, via: "broadcast" }, "toast.stopBroadcast", "success"],
    ["no peer", { stopped: true, via: "none" }, "toast.stopNoPeers", "info"],
  ];
  for (const [name, result, key, level] of stopCases) {
    test(`stop, ${name} -> ${key} (${level})`, () => {
      expect(stopFeedback(result)).toEqual({ key, level } as never);
    });
  }

  test("every selected key exists in the main-process fallback dictionary", () => {
    const keys = new Set(
      [
        ...dispatchCases.map((c) => c[2]),
        ...assignCases.map((c) => c[2]),
        ...stopCases.map((c) => c[2]),
      ]
    );
    expect([...keys].filter((k) => EN_DEFAULTS[k] === undefined)).toEqual([]);
  });

  test("each locale carries exactly the placeholders the selection fills, for every selected key", () => {
    const placeholders = (s: string | undefined): string[] => [...(s ?? "").matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();
    const en = JSON.parse(readFileSync(join(LOCALES, "en.json"), "utf8")) as Record<string, string>;
    const fr = JSON.parse(readFileSync(join(LOCALES, "fr.json"), "utf8")) as Record<string, string>;
    const selected = [
      ...dispatchCases.map((c) => [c[2], c[4]] as const),
      ...assignCases.map((c) => [c[2], undefined] as const),
      ...stopCases.map((c) => [c[2], undefined] as const),
    ];
    const dicts: Array<[string, Record<string, string>]> = [["en.json", en], ["fr.json", fr], ["EN_DEFAULTS", EN_DEFAULTS]];
    const mismatches = selected.flatMap(([key, params]) => {
      const filled = Object.keys(params ?? {}).sort().join(",");
      return dicts
        .filter(([, dict]) => placeholders(dict[key]).join(",") !== filled)
        .map(([name, dict]) => `${name} ${key}: has {${placeholders(dict[key]).join(",")}}, selection fills {${filled}}`);
    });
    expect(mismatches).toEqual([]);
  });
});

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
mock.module("@shared/hold-gesture", () => sharedHoldGesture);
mock.module("@roadmap-append", () => roadmapAppend);

type ToastCall = { key: string; level: string | undefined; params: unknown };

interface FakeState {
  dict: Record<string, string>;
  view: string;
  mobile: boolean;
  sessions: unknown[];
  brokerStatus: { up: boolean; since: number; lastError: string | null };
  roadmapSync: { status: RoadmapSyncStatus; conflicts: Array<{ local: { id: string } }> };
  showToast: (key: string, level?: string, opts?: { params?: unknown }) => boolean;
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

let toasts: ToastCall[] = [];

const AGENT = { id: "tile-1", name: "Worker", peerId: "peer-worker", status: "running", supervisor: false, lead: true, color: "#888" };

function initialFakeState(): FakeState {
  return {
    dict: {},
    view: "roadmap",
    mobile: false,
    sessions: [AGENT],
    brokerStatus: { up: true, since: 0, lastError: null },
    roadmapSync: { status: { mode: "local" }, conflicts: [] },
    showToast: (key, level, opts) => {
      toasts.push({ key, level, params: opts?.params });
      return true;
    },
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
const { RoadmapList } = await import("../desktop/src/renderer/src/components/RoadmapList");

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

const QUEUED = card("queued-card", { queue: 1 });
const FREE = card("free-card", {});
const LOCKED = card("locked-card", {
  status: "planned",
  locked: true,
  locked_by: "peer-worker",
  locked_at: "2026-09-01T00:00:00.000Z",
});

let container: HTMLDivElement;
let root: Root;
let cards: RoadmapItem[];
let dispatchResult: DispatchResult;
let assignResult: AssignResult;
let stopResult: StopResult;

beforeEach(() => {
  cards = [QUEUED, FREE, LOCKED];
  toasts = [];
  fakeUseDeck.setState(initialFakeState(), true);
  (window as unknown as { api: object }).api = {
    roadmapSearch: () => Promise.resolve({ items: cards, facets: null }),
    roadmapList: () => Promise.resolve(cards),
    roadmapDispatch: () => Promise.resolve(dispatchResult),
    roadmapAssign: () => Promise.resolve(assignResult),
    roadmapStop: () => Promise.resolve(stopResult),
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

async function mount(view: unknown): Promise<void> {
  await act(async () => {
    root.render(React.createElement(view as never));
  });
  await settle();
}

function buttonByText(scope: ParentNode, text: string, selector = "button"): HTMLElement {
  const all = [...scope.querySelectorAll<HTMLElement>(selector)].filter((b) => b.textContent?.includes(text));
  const last = all[all.length - 1];
  if (!last) throw new Error(`no ${selector} with "${text}"`);
  return last;
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click();
  });
  await settle();
}

async function openCard(cardSelector: string, id: string): Promise<void> {
  const el = [...container.querySelectorAll<HTMLElement>(cardSelector)].find((c) => c.textContent?.includes(id));
  if (!el) throw new Error(`card ${id} is not rendered`);
  await click(el);
}

describe("RoadmapView", () => {
  test("a partial dispatch reads as partial, with its counts, never as the success toast", async () => {
    dispatchResult = { sent: true, delivery: "sent", dispatched: [member("queued-card")], notSent: [member("gone")] };
    await mount(RoadmapView);
    await click(buttonByText(container, "roadmap.dispatchFirst"));
    expect(toasts).toEqual([{ key: "toast.dispatchPartial", level: "info", params: { sent: 1, n: 1 } }]);
  });

  test("a stop refused because the card changed names that reason", async () => {
    stopResult = { stopped: false, via: "none", reason: "card-changed" };
    await mount(RoadmapView);
    await openCard(".rm-card", "locked-card");
    await click(buttonByText(document, "roadmap.stop", ".rm-detail-actions button"));
    await click(buttonByText(document, "roadmap.stop"));
    expect(toasts).toEqual([{ key: "toast.stopCardChanged", level: "info", params: undefined }]);
  });

  test("an unconfirmed assignment is never shown as nothing sent", async () => {
    assignResult = { sent: false, delivery: "unknown", reason: "unconfirmed" };
    await mount(RoadmapView);
    const target = [...container.querySelectorAll<HTMLElement>(".rm-card")].find((c) => c.textContent?.includes("free-card"));
    await act(async () => {
      target!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    });
    await click(buttonByText(document, "roadmap.menuAssign", '.context-menu [role="menuitem"]'));
    await click(buttonByText(document, "peer-worker", ".rm-assign-row"));
    expect(toasts).toEqual([{ key: "toast.orderUnconfirmed", level: "info", params: undefined }]);
  });
});

describe("RoadmapList", () => {
  test("a stop refused because the card is gone names that reason", async () => {
    stopResult = { stopped: false, via: "none", reason: "not-found" };
    await mount(RoadmapList);
    await openCard(".mrm-card", "locked-card");
    await click(buttonByText(document, "roadmap.stop", ".rm-detail-actions button"));
    expect(toasts).toEqual([{ key: "toast.stopNotFound", level: "info", params: undefined }]);
  });

  test("a stop that reached no peer says nobody was notified, not that it was broadcast", async () => {
    stopResult = { stopped: true, via: "none" };
    await mount(RoadmapList);
    await openCard(".mrm-card", "locked-card");
    await click(buttonByText(document, "roadmap.stop", ".rm-detail-actions button"));
    expect(toasts).toEqual([{ key: "toast.stopNoPeers", level: "info", params: undefined }]);
  });

  test("an assignment refused because the card changed says no order was sent", async () => {
    assignResult = { sent: false, delivery: "not-sent", reason: "card-changed" };
    await mount(RoadmapList);
    await openCard(".mrm-card", "free-card");
    await click(buttonByText(document, "roadmap.launchAgent", ".rm-detail-actions button"));
    await click(buttonByText(document, "peer-worker", ".msheet-item"));
    expect(toasts).toEqual([{ key: "toast.orderCardChanged", level: "info", params: undefined }]);
  });
});
