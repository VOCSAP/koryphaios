// The session row's hover buttons live in ONE overlay container so they take no
// width from the name, and the context ring names the model so the row can hide
// its model badge when narrow without losing the information. Layout itself is
// measured in Chromium (happy-dom has none); this file pins the structure that
// layout depends on.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { Root } from "../desktop/tests-support/react-test-harness"; // type-only: erased before bun resolves it
import { mockStore, storeMockStubs } from "./_store-mock";
import * as sharedReorder from "../desktop/src/shared/reorder.ts";
import * as sharedModels from "../desktop/src/shared/models.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const { act, React, createRoot, create } = await import("../desktop/tests-support/react-test-harness");

interface FakeDeckState {
  config: { autoResumeQuota: boolean };
  selectedId: string | null;
  maximizedId: string | null;
  dict: Record<string, string>;
  setSelected: (id: string) => void;
  setMaximized: (id: string | null) => void;
  removeSession: (id: string) => Promise<void>;
  renameSession: (id: string, name: string) => Promise<void>;
  setColor: (id: string, color: string) => Promise<void>;
  setAutoResume: (id: string, enabled: boolean) => Promise<void>;
  clearAttention: (id: string) => Promise<void>;
  showToast: (key: string) => void;
  openDiff: (id: string) => void;
}

function initialFakeState(): FakeDeckState {
  return {
    config: { autoResumeQuota: false },
    selectedId: null,
    maximizedId: null,
    dict: {},
    setSelected: () => {},
    setMaximized: () => {},
    removeSession: async () => {},
    renameSession: async () => {},
    setColor: async () => {},
    setAutoResume: async () => {},
    clearAttention: async () => {},
    showToast: () => {},
    openDiff: () => {}
  };
}

const fakeUseDeck = create<FakeDeckState>(() => initialFakeState());
mockStore({ useDeck: fakeUseDeck, ...storeMockStubs });
mock.module("@shared/reorder", () => sharedReorder);
mock.module("@shared/models", () => sharedModels);
mock.module("../desktop/src/renderer/src/components/CreateMenu.tsx", () => ({
  CreateMenu: () => {
    throw new Error("CreateMenu stub rendered -- this file only mounts SessionRow");
  }
}));

const { SessionRow } = await import("../desktop/src/renderer/src/components/Sidebar.tsx");

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

const LIVE = { model: "Haiku 4.5", modelId: "claude-haiku-4-5", contextPct: 27, contextWindow: 200000, at: 0 };

function session(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "tile-a",
    name: "worker",
    cwd: "/proj",
    command: "",
    args: "",
    sessionId: "sid-1",
    color: "#fff",
    createdAt: 0,
    status: "running",
    exitCode: null,
    pid: 1,
    peerId: "peer-a",
    expired: false,
    rateLimited: false,
    resumeAt: null,
    needsAttention: false,
    claudeLaunch: true,
    liveStatus: LIVE,
    ...overrides
  };
}

const dnd = {
  dragId: null,
  overId: null,
  onDragStart: () => {},
  onDragEnter: () => {},
  onDrop: () => {},
  onDragEnd: () => {}
};

function renderRow(s: Record<string, unknown>, collapsed = false): void {
  act(() => {
    root.render(
      React.createElement(SessionRow, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- fake fixture, real component
        session: s as any,
        dnd,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- fake fixture, real component
        roster: [s as any],
        collapsed
      })
    );
  });
}

function row(): HTMLElement {
  const el = container.querySelector("li");
  if (!el) throw new Error("SessionRow did not render its <li> row");
  return el as HTMLElement;
}

function directChildren(el: Element, cls: string): Element[] {
  return [...el.children].filter((c) => c.classList.contains(cls));
}

test("the three row buttons sit in one overlay container, a direct child of the row", () => {
  renderRow(session());
  const overlays = directChildren(row(), "row-actions");
  expect(overlays, "one .row-actions overlay per row, anchored on the row itself").toHaveLength(1);
  const inside = [...overlays[0]!.children];
  expect(inside.every((b) => b.tagName === "BUTTON" && b.classList.contains("row-btn"))).toBe(true);
  expect(inside, "rename, maximize and remove all ride the overlay").toHaveLength(3);
  expect(
    directChildren(row(), "row-btn"),
    "a row button left in the row's flow takes width from the session name again"
  ).toHaveLength(0);
});

test("the overlay's buttons stay keyboard-reachable", () => {
  renderRow(session());
  for (const b of row().querySelectorAll<HTMLButtonElement>(".row-actions .row-btn")) {
    expect(b.disabled).toBe(false);
    expect(b.tabIndex, `${b.title} must stay in the tab order to be revealed by :focus-within`).toBeGreaterThanOrEqual(0);
  }
});

test("the context ring names the model, so hiding the badge on a narrow row loses nothing", () => {
  renderRow(session());
  const ring = row().querySelector("svg.context-ring");
  expect(ring?.getAttribute("aria-label"), "the ring's label must carry the model name").toContain("Haiku 4.5");
  expect(ring?.querySelector("title")?.textContent).toContain("Haiku 4.5");
});

test("without a live status the overlay still carries the actions and no ring renders", () => {
  renderRow(session({ liveStatus: null }));
  expect(row().querySelector("svg.context-ring")).toBeNull();
  expect(row().querySelectorAll(".row-actions .row-btn")).toHaveLength(3);
});

test("while renaming, the overlay drops the rename button and keeps the other two", () => {
  renderRow(session());
  const rename = row().querySelector<HTMLButtonElement>('.row-actions .row-btn[title="sidebar.renameTitle"]');
  if (!rename) throw new Error("no rename button in the overlay");
  act(() => {
    rename.click();
  });
  expect(row().querySelector(".row-edit")).not.toBeNull();
  expect(row().querySelectorAll(".row-actions .row-btn")).toHaveLength(2);
});

// happy-dom applies no stylesheet, so the three rules the layout depends on are
// pinned on the text of styles.css, whitespace-normalized.
const CSS = readFileSync(
  join(import.meta.dir, "../desktop/src/renderer/src/styles.css"),
  "utf-8"
).replace(/\s+/g, " ");

function ruleBody(selectorList: string): string | null {
  const start = CSS.indexOf(`${selectorList} {`);
  if (start < 0) return null;
  const open = start + selectorList.length + 2;
  return CSS.slice(open, CSS.indexOf("}", open));
}

test("the overlay is revealed by hover AND keyboard focus, and only then catches clicks", () => {
  const body = ruleBody(".row:hover .row-actions, .row:focus-within .row-actions");
  expect(body, "the reveal rule must cover :hover and :focus-within together").not.toBeNull();
  expect(body!, "revealed, the overlay must be visible").toMatch(/opacity: 1;/);
  expect(body!, "revealed, the overlay must take clicks again").toMatch(/pointer-events: auto;/);
});

test("a narrow row drops the model badge before the name gives up its floor", () => {
  expect(
    CSS,
    "the container query hiding .row-model is what keeps the name readable on a narrow sidebar"
  ).toMatch(/@container session-row \(max-width: \d+px\) \{ \.row-model \{ display: none; \} \}/);
});

test("renaming hides the overlay, which would otherwise cover the caret through :focus-within", () => {
  const body = ruleBody(".row:has(.row-edit) .row-actions");
  expect(body, "the edit field must never sit under the opaque overlay").not.toBeNull();
  expect(body!).toMatch(/display: none;/);
});

test("a folded row renders no overlay at all", () => {
  renderRow(session(), true);
  expect(row().querySelector(".row-actions")).toBeNull();
});
