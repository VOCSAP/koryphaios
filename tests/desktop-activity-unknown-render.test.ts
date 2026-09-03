import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { Root } from "../desktop/tests-support/react-test-harness"; // type-only: erased before bun resolves it
import { mockStore, storeMockStubs } from "./_store-mock";

// Dynamic import: must run AFTER GlobalRegistrator.register() above (react-dom
// inspects window/document at import time).
const { act, React, createRoot, create } = await import("../desktop/tests-support/react-test-harness");

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
  activity: string;
  thinking: boolean;
  expired: boolean;
  rateLimited: boolean;
  resumeAt: number | null;
  needsAttention: boolean;
  claudeLaunch: boolean;
}

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
    activity: "idle",
    thinking: false,
    expired: false,
    rateLimited: false,
    resumeAt: null,
    needsAttention: false,
    claudeLaunch: true,
    ...overrides
  };
}

let container: HTMLDivElement;
let root: Root;

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

// ---------------------------------------------------------------------------
// Sidebar.tsx's SessionRow

// Single fake store shape, superset of what BOTH SessionRow (Sidebar.tsx)
// and TerminalTile.tsx read at mount: store.ts is one module, so mocking it
// twice with two different shapes would have the second mock silently win.
interface FakeDeckState {
  config: { autoResumeQuota: boolean; fontSize: number; theme: "dark" | "light" };
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
  restartSession: (id: string) => Promise<void>;
  openBrowser: (id: string) => void;
}

function initialFakeDeckState(): FakeDeckState {
  return {
    config: { autoResumeQuota: false, fontSize: 14, theme: "dark" },
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
    openDiff: () => {},
    restartSession: async () => {},
    openBrowser: () => {}
  };
}

const fakeDeck = create<FakeDeckState>(() => initialFakeDeckState());

// Bun's module registry is process-global: whichever test file mocks this
// specifier first freezes the surface for the rest of the `bun test` run, so
// mockStore derives the required key set from store.ts itself and throws here
// instead of failing in a later, unrelated file.
mockStore({ useDeck: fakeDeck, ...storeMockStubs });

mock.module("@shared/reorder", () => ({
  moveBeside: (ids: string[]) => ids
}));

// CreateMenu is never rendered by SessionRow; stubbing it avoids dragging in
// its whole '@shared/models' import graph.
mock.module("../desktop/src/renderer/src/components/CreateMenu.tsx", () => ({
  CreateMenu: () => {
    throw new Error("CreateMenu stub rendered -- this file only mounts SessionRow/TerminalTile");
  }
}));

const { SessionRow } = await import("../desktop/src/renderer/src/components/Sidebar.tsx");

const dnd = {
  dragId: null,
  overId: null,
  onDragStart: () => {},
  onDragEnter: () => {},
  onDrop: () => {},
  onDragEnd: () => {}
};

function renderSessionRow(s: FakeSession): void {
  fakeDeck.setState(initialFakeDeckState(), true);
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

function sidebarDot(): HTMLElement {
  const el = container.querySelector("li .dot");
  if (!el) throw new Error("SessionRow did not render its status dot");
  return el as HTMLElement;
}

test("SessionRow renders dot-unknown and the status.unknown tooltip for an 'unknown' activity session", () => {
  renderSessionRow(session({ activity: "unknown" }));
  const dot = sidebarDot();
  expect(dot.className).toContain("dot-unknown");
  expect(dot.getAttribute("title")).toBe("status.unknown");
});

test("SessionRow does NOT render dot-unknown for a normal ('idle') activity session", () => {
  renderSessionRow(session({ activity: "idle" }));
  const dot = sidebarDot();
  expect(dot.className).not.toContain("dot-unknown");
  expect(dot.getAttribute("title")).not.toBe("status.unknown");
});

// ---------------------------------------------------------------------------
// TerminalTile.tsx

// TerminalTile mounts a REAL xterm.js Terminal on mount and calls a handful
// of window.api methods synchronously (ptyResize via requestAnimationFrame,
// onPtyData/onPtyExit subscriptions). None of those are exercised by this
// file's assertions (which only read the status dot rendered synchronously
// on the FIRST pass, before any effect fires) -- no-op stubs are enough and
// keep this file from depending on a real PTY.
(globalThis as unknown as { window: { api: Record<string, (...args: unknown[]) => unknown> } }).window.api = {
  ptyResize: () => {},
  ptyInput: () => {},
  onPtyData: () => () => {},
  onPtyExit: () => () => {},
  listSnippets: async () => []
};

const { TerminalTile } = await import("../desktop/src/renderer/src/components/TerminalTile.tsx");

function renderTerminalTile(s: FakeSession): void {
  fakeDeck.setState(initialFakeDeckState(), true);
  act(() => {
    root.render(
      React.createElement(TerminalTile, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- fake fixture, real component
        session: s as any,
        hidden: false
      })
    );
  });
}

function tileDot(): HTMLElement {
  const el = container.querySelector(".dot");
  if (!el) throw new Error("TerminalTile did not render its status dot");
  return el as HTMLElement;
}

test("TerminalTile renders dot-unknown and the status.unknown tooltip for an 'unknown' activity session", () => {
  renderTerminalTile(session({ activity: "unknown" }));
  const dot = tileDot();
  expect(dot.className).toContain("dot-unknown");
  expect(dot.getAttribute("title")).toBe("status.unknown");
});

test("TerminalTile does NOT render dot-unknown for a normal ('idle') activity session", () => {
  renderTerminalTile(session({ activity: "idle" }));
  const dot = tileDot();
  expect(dot.className).not.toContain("dot-unknown");
  expect(dot.getAttribute("title")).not.toBe("status.unknown");
});
