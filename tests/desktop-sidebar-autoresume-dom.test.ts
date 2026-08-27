// Card fd1914cc, team-lead mutation review (MAJOR 3): Sidebar's context-menu
// "force quota auto-resume" item is the SOLE escape hatch by which an
// operator regains both detection and injection on a Claude Code session
// stuck on the (gated) default path. The reviewer's measured mutant --
// swapping the item's `setAutoResume(session.id, true)` for `..., false)` --
// left every prior test green (nothing in this repo mounted Sidebar's real
// DOM). Worse than a rendering bug: inverted, the item still visibly does
// something (autoResume stops being undefined, so quotaGateActive flips off
// and the detector re-arms -- the badge even comes back), so the operator
// sees a plausible "it worked" signal while autoResume() itself no-ops on
// `enabled === false`. The symptom lies in the direction that deceives.
//
// This file mounts the REAL, unmodified `SessionRow` (exported from
// Sidebar.tsx for exactly this reason) and drives a real DOM contextmenu +
// click, asserting the store call's SECOND ARGUMENT, not just that it fired.
//
// Scope note: mounts `SessionRow` directly, not the whole `Sidebar`, which
// would drag in createSession/reorderSessions/workspaces/sandbox/etc. for no
// added bite (tests/desktop-explorer-selection-dom.test.ts's established
// reasoning for mounting the narrower component under test).
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

// Paired unregister (tests/desktop-happy-dom-teardown.test.ts's repo-wide
// scan, and the real fetch/CORS blast-radius documented in
// tests/desktop-explorer-selection-dom.test.ts).
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { Root } from "../desktop/tests-support/react-test-harness"; // type-only: erased before bun resolves it
import { mockStore, storeMockStubs } from "./_store-mock";

// Dynamic import: must run AFTER GlobalRegistrator.register() above (react-dom
// inspects window/document at import time).
const { act, React, createRoot, create } = await import("../desktop/tests-support/react-test-harness");

// ---------------------------------------------------------------------------
// Fake store: covers exactly what SessionRow reads (session-service.ts
// SessionRow hooks: config, selectedId, maximizedId, setSelected,
// setMaximized, removeSession, renameSession, setColor, setAutoResume,
// clearAttention, showToast, openDiff) plus `dict` for useT().

interface FakeSession {
  id: string;
  name: string;
  cwd: string;
  command: string;
  args: string;
  sessionId: string;
  color: string;
  createdAt: number;
  status: string;
  exitCode: number | null;
  pid: number | null;
  peerId: string | null;
  thinking: boolean;
  expired: boolean;
  rateLimited: boolean;
  resumeAt: number | null;
  needsAttention: boolean;
  claudeLaunch: boolean;
  autoResume?: boolean;
}

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

let setAutoResumeCalls: Array<[string, boolean]> = [];

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
    setAutoResume: async (id: string, enabled: boolean) => {
      setAutoResumeCalls.push([id, enabled]);
    },
    clearAttention: async () => {},
    showToast: () => {},
    openDiff: () => {}
  };
}

const fakeUseDeck = create<FakeDeckState>(() => initialFakeState());

function resetFakeStore(): void {
  setAutoResumeCalls = [];
  fakeUseDeck.setState(initialFakeState(), true);
}

mockStore({ useDeck: fakeUseDeck, ...storeMockStubs });

// SessionRow's own imports resolve through this mock too (moveBeside is a
// real, pure helper -- only Sidebar()'s own onDrop calls it, not SessionRow).
mock.module("@shared/reorder", () => ({
  moveBeside: (ids: string[]) => ids
}));

// Sidebar.tsx module-level imports CreateMenu (used by Sidebar(), never by
// SessionRow), whose own import graph (ModelPicker.tsx -> '@shared/models',
// etc.) pulls in far more than this file needs to resolve. Stubbing the
// WHOLE component (never rendered by anything this file exercises) is
// cheaper and more robust than chasing every transitive '@shared/*' import
// CreateMenu happens to have today.
mock.module("../desktop/src/renderer/src/components/CreateMenu.tsx", () => ({
  CreateMenu: () => {
    throw new Error("CreateMenu stub rendered -- this file only mounts SessionRow");
  }
}));

const { SessionRow } = await import("../desktop/src/renderer/src/components/Sidebar.tsx");

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

function session(overrides: Partial<FakeSession> = {}): FakeSession {
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
    thinking: false,
    expired: false,
    rateLimited: false,
    resumeAt: null,
    needsAttention: false,
    claudeLaunch: true,
    autoResume: undefined,
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

function renderRow(s: FakeSession): void {
  act(() => {
    root.render(
      React.createElement(SessionRow, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- fake fixture, real component
        session: s as any,
        dnd,
        roster: [s],
        collapsed: false
      })
    );
  });
}

/** The row's <li> -- SessionRow renders exactly one top-level <li className="row..."> . */
function rowElement(): HTMLElement {
  const el = container.querySelector("li");
  if (!el) throw new Error("SessionRow did not render its <li> row");
  return el as HTMLElement;
}

function openContextMenu(): void {
  act(() => {
    rowElement().dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 })
    );
  });
}

/** Menu items render as <button role="menuitem">{label}</button> (ContextMenu.tsx). */
function menuItemByText(text: string): HTMLButtonElement {
  const items = [...container.querySelectorAll('button[role="menuitem"]')] as HTMLButtonElement[];
  const found = items.find((b) => b.textContent === text);
  if (!found) {
    throw new Error(
      `no menu item with text "${text}" -- found: ${items.map((b) => b.textContent).join(", ")}`
    );
  }
  return found;
}

function clickButton(btn: HTMLButtonElement): void {
  act(() => {
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

test("MAJOR (mutation review): the claude-session force-resume item calls setAutoResume(id, true)", () => {
  renderRow(session({ id: "tile-a", claudeLaunch: true, autoResume: undefined }));
  openContextMenu();

  // Missing key falls back to the literal key text (i18n.ts's translate()),
  // so this is the exact label rendered when no locale dict is loaded.
  const btn = menuItemByText("sidebar.autoResumeNative");
  clickButton(btn);

  expect(setAutoResumeCalls).toEqual([["tile-a", true]]);
});

test("a non-claude session (or an explicit override already set) still uses the plain toggle, not the force item", () => {
  renderRow(session({ id: "tile-b", claudeLaunch: false, autoResume: undefined }));
  openContextMenu();

  expect(() => menuItemByText("sidebar.autoResumeNative")).toThrow();
  // Falls back to the plain enable/disable toggle text instead.
  const btn = menuItemByText("sidebar.autoResumeOn");
  clickButton(btn);

  expect(setAutoResumeCalls).toEqual([["tile-b", true]]);
});

test("a claude session with an explicit override already set (autoResume=true) uses the plain toggle, not the force item", () => {
  renderRow(session({ id: "tile-c", claudeLaunch: true, autoResume: true }));
  openContextMenu();

  expect(() => menuItemByText("sidebar.autoResumeNative")).toThrow();
  const btn = menuItemByText("sidebar.autoResumeOff");
  clickButton(btn);

  expect(setAutoResumeCalls).toEqual([["tile-c", false]]);
});
