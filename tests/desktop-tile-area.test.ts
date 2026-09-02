// Maximizing a tile must not remount every terminal: TileArea's three JSX
// return branches share one hoisted children value instead of building
// sessions.map(...) inline, otherwise switching branches tears down every
// real xterm.js instance and its scrollback. Exercises the single exported
// TileArea, unmodified, through both branches: split components would make
// React remount on element type change and mask the bug.
// GlobalRegistrator.register() mutates globalThis for the whole bun test
// process, and happy-dom's fetch cannot parse a Bun.serve response, so every
// replaced global is restored to its Bun-native value and happy-dom's own
// value re-applied only for the 9 names this harness needs.
// Root devDependencies on react/react-dom/zustand/@happy-dom exist because CI
// runs this suite before desktop/'s npm install, so resolution walks up here.

// `import 'react-dom/client'` anywhere in this file would load react-dom // scanfile-swallow-ok: prose example
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// All 9 restored-as-happy-dom names share one reason: happy-dom's own event
// dispatch checks instanceof its own Event/EventTarget classes internally, so
// restoring any one of them to Bun's native breaks dispatchEvent for every
// other happy-dom object even though creation and mounting still work.
const RESTORE_HAPPY_DOM_FOR = new Set([
  "Event",
  "EventTarget",
  "addEventListener",
  "removeEventListener",
  "dispatchEvent",
  "CustomEvent",
  "MessageEvent",
  "ErrorEvent",
  "CloseEvent"
]);

// Snapshot every own-property DESCRIPTOR (not just its value) on
// `globalThis` BEFORE registering, so the restore set below is computed
// from a real diff, not a maintained list -- see the DOM harness note
// above for why a hardcoded list is the wrong shape here. Descriptors, not
// values: happy-dom replaces some globals (e.g. `navigator`) with a
// getter-only accessor property, so a plain `globalThis[name] = value`
// restore throws ("Attempted to assign to readonly property") and would
// silently leave happy-dom's version in place if that throw were swallowed
// -- measured via a standalone probe before landing this fix. Restoring the
// full native descriptor via `Object.defineProperty` instead of a bare
// assignment survives that case.
const globalsBeforeRegister = new Map<string, PropertyDescriptor>();
for (const name of Object.getOwnPropertyNames(globalThis)) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  if (descriptor) globalsBeforeRegister.set(name, descriptor);
}

GlobalRegistrator.register();

// Restore every global happy-dom replaced back to its Bun-native
// descriptor, except the 9-name event-dispatch family above, which stays
// on happy-dom. `NaN` is deliberately excluded: it is an own property of
// `globalThis` whose value never compares equal to itself, so a `!==` diff
// would always flag it as "replaced" even though nothing touched it.
for (const [name, nativeDescriptor] of globalsBeforeRegister) {
  if (name === "NaN" || RESTORE_HAPPY_DOM_FOR.has(name)) continue;
  const currentDescriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  const unchanged =
    currentDescriptor !== undefined &&
    currentDescriptor.value === nativeDescriptor.value &&
    currentDescriptor.get === nativeDescriptor.get &&
    currentDescriptor.set === nativeDescriptor.set;
  if (unchanged) continue;
  try {
    Object.defineProperty(globalThis, name, nativeDescriptor);
  } catch {
    // Non-configurable own property: happy-dom couldn't have replaced this
    // one either (a non-configurable descriptor can't be redefined by
    // anyone, including happy-dom), so there's nothing to restore.
  }
}

// Restoring the globals above does not clear the registrator's internal
// 'already registered' flag, so a later file calling register() throws unless
// this file unregisters it here. Test file order is not guaranteed across bun
// versions, so this obligation falls on every file that registers, not just the
// one that happens to run first.
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { Root } from "../desktop/tests-support/react-test-harness"; // type-only: erased, no runtime resolution; sourced via the bridge, not a bare "react-dom/client" import -- the quoted mention here IS caught by the swallow check (scanfile-swallow-ok: prose example), confirming the gate actually looks, not merely asserting it doesn't need to
import { mockStore, storeMockStubs } from "./_store-mock";

const { act, React, createRoot, create } = await import("../desktop/tests-support/react-test-harness");

// ---------------------------------------------------------------------------
// Fake store: same external-store shape as the real zustand store (`create`
// from zustand, `useDeck(selector)` hook, `.setState`/`.getState`), scoped to
// exactly the DeckState slice TileArea.tsx and i18n.ts's `useT()` read. Both
// modules import from '../store' / './store' -- two different relative
// specifiers that resolve to the SAME file
// (desktop/src/renderer/src/store.ts), so one mock.module call (keyed by
// that resolved path) covers both call sites.
type FakeSession = { id: string; supervisor?: boolean };
type FakeConfig = { displayMode: string; gridCols: number; gridRows: number };
interface FakeDeckState {
  sessions: FakeSession[];
  config: FakeConfig;
  maximizedId: string | null;
  pendingSessions: number;
  workspaces: unknown[];
  templates: unknown[];
  templatesManage: boolean;
  // Without this field, composerSeed read undefined here, undefined > 0 is
  // false, and TemplatesDialog's seed effect (and clearTemplatesComposerSeed)
  // never ran in any test in this file.
  templatesComposerSeed: number;
  dict: Record<string, string>;
  createSession: () => Promise<void>;
  restoreWorkspace: () => Promise<void>;
  openWorkspaces: () => void;
  openTemplates: (manage?: boolean) => void;
  applyTemplate: (path: string, mode: "append" | "replace") => Promise<void>;
  removeTemplate: (path: string) => Promise<void>;
  refreshTemplates: () => Promise<void>;
  showToast: (key: string) => void;
  clearTemplatesComposerSeed: () => void;
}

function initialFakeState(): FakeDeckState {
  return {
    sessions: [],
    config: { displayMode: "2x2", gridCols: 2, gridRows: 2 },
    maximizedId: null,
    pendingSessions: 0,
    workspaces: [],
    templates: [],
    templatesManage: false,
    templatesComposerSeed: 0,
    dict: {},
    createSession: async () => {},
    restoreWorkspace: async () => {},
    openWorkspaces: () => {},
    openTemplates: () => {},
    applyTemplate: async () => {},
    removeTemplate: async () => {},
    refreshTemplates: async () => {},
    showToast: () => {},
    clearTemplatesComposerSeed: () => fakeUseDeck.setState({ templatesComposerSeed: 0 })
  };
}

// Created ONCE at module scope, not per-test: bun's mock.module factory runs
// once and its return value becomes the module's exports, so `useDeck` must
// be a stable function reference (a live binding via a getter is NOT
// preserved -- the object literal is captured as-is, so a getter reading a
// variable reassigned later in beforeEach would evaluate once, while it is
// still undefined, and every call site would keep that stale `undefined`).
// Tests get isolation by resetting this store's STATE in `beforeEach`
// instead of swapping the store instance.
const fakeUseDeck = create<FakeDeckState>(() => initialFakeState());

function resetFakeStore(): void {
  fakeUseDeck.setState(initialFakeState(), true);
}

mockStore({ useDeck: fakeUseDeck, ...storeMockStubs });

// ---------------------------------------------------------------------------
// Probe TerminalTile: records one mount-count bump and one unmount-count bump
// per session id, in module-level maps reset before each test. A React
// remount shows up as mounts going from 1 -> 2 (new instance) with a matching
// unmount 0 -> 1 in between; a reused instance leaves both counters frozen
// after the first render.
const mountCounts = new Map<string, number>();
const unmountCounts = new Map<string, number>();

function resetProbeCounters(): void {
  mountCounts.clear();
  unmountCounts.clear();
}

mock.module("../desktop/src/renderer/src/components/TerminalTile.tsx", () => {
  function TerminalTile({ session, hidden }: { session: FakeSession; hidden: boolean }) {
    React.useEffect(() => {
      mountCounts.set(session.id, (mountCounts.get(session.id) ?? 0) + 1);
      return () => {
        unmountCounts.set(session.id, (unmountCounts.get(session.id) ?? 0) + 1);
      };
    }, [session.id]);
    return React.createElement("div", { "data-testid": `probe-tile-${session.id}`, "data-hidden": hidden });
  }
  return { TerminalTile };
});

// Imported AFTER both mock.module calls above, so TileArea's module-level
// `import { TerminalTile } from './TerminalTile'` and `import { useDeck }
// from '../store'` (transitively, via its own `useT()` -> `../i18n` ->
// `./store` chain) bind to the mocks, never to the real heavy modules
// (xterm.js, window.api, the companion remote-api shim).
const { TileArea, pickRestorable } = await import("../desktop/src/renderer/src/components/TileArea");
// TemplatesDialog.tsx pulls in ConfirmDialog (no @shared import, resolves
// fine) and TemplateComposer (imports `@shared/template`, an alias mapped
// only in desktop/tsconfig.web.json -- which bun test, run from the repo
// root, never reads -- so its real module fails to resolve here the same
// way `@shared/companion` does for store.ts, per this file's header note).
// Neither dialog is ever rendered in the tests below (confirmReplace /
// composer state stay null), so a bare stub is enough to satisfy the import.
mock.module("../desktop/src/renderer/src/components/TemplateComposer.tsx", () => ({
  TemplateComposer: () => null
}));
const { TemplatesDialog } = await import("../desktop/src/renderer/src/components/TemplatesDialog");

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  resetProbeCounters();
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

test("happy-dom event dispatch still works after the global restore above (guards the 9-name exception list)", () => {
  // Guards RESTORE_HAPPY_DOM_FOR: nothing else in this file dispatches a DOM
  // event, so restoring that exception list to Bun natives by mistake would
  // pass every other test here while silently breaking event delivery for every
  // happy-dom object.
  const el = document.createElement("button");
  let fired = 0;
  el.addEventListener("click", () => {
    fired++;
  });
  el.dispatchEvent(new Event("click"));
  el.dispatchEvent(new CustomEvent("click", { detail: 1 }));
  expect(fired).toBe(2);
});

test("maximizing a tile does not remount the other TerminalTile instances (grid -> maximized)", () => {
  const sessions: FakeSession[] = [
    { id: "s1", supervisor: false },
    { id: "s2", supervisor: false }
  ];

  act(() => {
    fakeUseDeck.setState({ sessions, maximizedId: null, config: { displayMode: "2x2", gridCols: 2, gridRows: 2 } });
    root.render(React.createElement(TileArea));
  });

  expect(mountCounts.get("s1")).toBe(1);
  expect(mountCounts.get("s2")).toBe(1);
  expect(unmountCounts.get("s1") ?? 0).toBe(0);
  expect(unmountCounts.get("s2") ?? 0).toBe(0);

  // Operator maximizes s1: TileArea now takes its "maximized" `return`
  // branch instead of its "grid" `return` branch. Both branches render the
  // same two TerminalTile elements (same type, same `key={s.id}`), so a
  // correct implementation reuses both instances -- the ONLY prop that
  // should change is `hidden` on s2.
  act(() => {
    fakeUseDeck.setState({ maximizedId: "s1" });
  });

  expect(unmountCounts.get("s1") ?? 0).toBe(0);
  expect(unmountCounts.get("s2") ?? 0).toBe(0);
  expect(mountCounts.get("s1")).toBe(1);
  expect(mountCounts.get("s2")).toBe(1);

  // Restoring (maximizedId back to null) must be equally instance-preserving
  // -- the operator expects scrollback to survive both directions of the
  // toggle, not just the way in.
  act(() => {
    fakeUseDeck.setState({ maximizedId: null });
  });

  expect(unmountCounts.get("s1") ?? 0).toBe(0);
  expect(unmountCounts.get("s2") ?? 0).toBe(0);
  expect(mountCounts.get("s1")).toBe(1);
  expect(mountCounts.get("s2")).toBe(1);
});

test("maximizing a tile does not remount the other TerminalTile instances (1x1 carousel -> maximized)", () => {
  const sessions: FakeSession[] = [
    { id: "s1", supervisor: false },
    { id: "s2", supervisor: false }
  ];

  act(() => {
    fakeUseDeck.setState({ sessions, maximizedId: null, config: { displayMode: "1x1", gridCols: 1, gridRows: 1 } });
    root.render(React.createElement(TileArea));
  });

  expect(mountCounts.get("s1")).toBe(1);
  expect(mountCounts.get("s2")).toBe(1);

  act(() => {
    fakeUseDeck.setState({ maximizedId: "s2" });
  });

  expect(unmountCounts.get("s1") ?? 0).toBe(0);
  expect(unmountCounts.get("s2") ?? 0).toBe(0);
});

test("toggling displayMode between grid and 1x1 carousel does not remount TerminalTile instances", () => {
  // Same instance-preservation contract as the maximize/restore tests above,
  // but exercised across TileArea's OTHER pair of JSX return branches (grid
  // vs carousel, both taken with maximizedId held at null throughout) --
  // team-lead's follow-up ask after the maximize/restore fix landed, to
  // confirm the same hoisted-`children` fix also covers this transition
  // rather than assuming it by analogy.
  const sessions: FakeSession[] = [
    { id: "s1", supervisor: false },
    { id: "s2", supervisor: false }
  ];

  act(() => {
    fakeUseDeck.setState({ sessions, maximizedId: null, config: { displayMode: "2x2", gridCols: 2, gridRows: 2 } });
    root.render(React.createElement(TileArea));
  });

  expect(mountCounts.get("s1")).toBe(1);
  expect(mountCounts.get("s2")).toBe(1);
  expect(unmountCounts.get("s1") ?? 0).toBe(0);
  expect(unmountCounts.get("s2") ?? 0).toBe(0);

  // Grid -> 1x1 carousel.
  act(() => {
    fakeUseDeck.setState({ config: { displayMode: "1x1", gridCols: 1, gridRows: 1 } });
  });

  expect(unmountCounts.get("s1") ?? 0).toBe(0);
  expect(unmountCounts.get("s2") ?? 0).toBe(0);
  expect(mountCounts.get("s1")).toBe(1);
  expect(mountCounts.get("s2")).toBe(1);

  // Carousel -> back to grid (2x2). Both directions must preserve scrollback,
  // not just the way in.
  act(() => {
    fakeUseDeck.setState({ config: { displayMode: "2x2", gridCols: 2, gridRows: 2 } });
  });

  expect(unmountCounts.get("s1") ?? 0).toBe(0);
  expect(unmountCounts.get("s2") ?? 0).toBe(0);
  expect(mountCounts.get("s1")).toBe(1);
  expect(mountCounts.get("s2")).toBe(1);
});

// Tests the mechanism the zero-unmount assertions above depend on (React's
// implicit key from JSX structural position), not TileArea itself: a counter
// that lost the ability to observe a remount would pass all of them silently.
// Each shape must be one component with three returns, exactly like TileArea:
// splitting branches into separate components makes React remount on element
// type change for a reason unrelated to children shape, which would pass for
// the wrong reason.
const ctlMounts = new Map<string, number>();
const ctlUnmounts = new Map<string, number>();

function ControlTile({ id }: { id: string }): React.JSX.Element {
  React.useEffect(() => {
    ctlMounts.set(id, (ctlMounts.get(id) ?? 0) + 1);
    return () => {
      ctlUnmounts.set(id, (ctlUnmounts.get(id) ?? 0) + 1);
    };
  }, [id]);
  return React.createElement("div", { "data-testid": `ctl-${id}` });
}

interface ShapeProps {
  ids: string[];
  pending: number;
  maximized: boolean;
  carousel: boolean;
}

/**
 * Pre-fix shape: every branch builds its own children, and the maximized one
 * omits the pending slot entirely -- so its children is a bare array while the
 * other two are [array, pendingArray]. Reproduced from TileArea.tsx as it
 * stood before 1320be6.
 */
function LegacyShape({ ids, pending, maximized, carousel }: ShapeProps): React.JSX.Element {
  const tiles = ids.map((id) => React.createElement(ControlTile, { key: id, id }));
  const pendingTiles = Array.from({ length: pending }, (_, i) =>
    React.createElement("span", { key: `pending-${i}` }),
  );
  if (maximized) return React.createElement("main", { className: "area-maximized" }, tiles);
  if (carousel) return React.createElement("main", { className: "area-carousel" }, tiles, pendingTiles);
  return React.createElement("main", { className: "area-grid" }, tiles, pendingTiles);
}

/**
 * Shipped shape: one `children` built once above the three returns, with the
 * pending slot NULLED rather than omitted when maximized so the second child
 * position stays occupied. Mirrors TileArea.tsx's current hoisted `children`,
 * and is what makes the "nulled, not omitted" review rule falsifiable here.
 */
function FixedShape({ ids, pending, maximized, carousel }: ShapeProps): React.JSX.Element {
  const tiles = ids.map((id) => React.createElement(ControlTile, { key: id, id }));
  const pendingTiles = Array.from({ length: pending }, (_, i) =>
    React.createElement("span", { key: `pending-${i}` }),
  );
  const children = React.createElement(React.Fragment, null, tiles, maximized ? null : pendingTiles);
  if (maximized) return React.createElement("main", { className: "area-maximized" }, children);
  if (carousel) return React.createElement("main", { className: "area-carousel" }, children);
  return React.createElement("main", { className: "area-grid" }, children);
}

function renderShape(Shape: (p: ShapeProps) => React.JSX.Element, props: ShapeProps): void {
  act(() => {
    root.render(React.createElement(Shape, props));
  });
}

test("negative control: the PRE-FIX children shape really does remount tiles on maximize", () => {
  ctlMounts.clear();
  ctlUnmounts.clear();
  const base: ShapeProps = { ids: ["s1", "s2"], pending: 1, maximized: false, carousel: false };

  renderShape(LegacyShape, base);
  expect(ctlMounts.get("s1")).toBe(1);
  expect(ctlMounts.get("s2")).toBe(1);
  expect(ctlUnmounts.get("s1") ?? 0).toBe(0);

  // Grid -> maximized on the SAME component type: the only thing that changes
  // is the children shape ([tiles, pending] -> tiles).
  renderShape(LegacyShape, { ...base, maximized: true });
  expect(ctlUnmounts.get("s1")).toBe(1);
  expect(ctlUnmounts.get("s2")).toBe(1);
  expect(ctlMounts.get("s1")).toBe(2);
  expect(ctlMounts.get("s2")).toBe(2);
});

test("negative control twin: the SHIPPED children shape survives the same transition", () => {
  ctlMounts.clear();
  ctlUnmounts.clear();
  const base: ShapeProps = { ids: ["s1", "s2"], pending: 1, maximized: false, carousel: false };

  renderShape(FixedShape, base);
  expect(ctlMounts.get("s1")).toBe(1);
  expect(ctlMounts.get("s2")).toBe(1);

  // Identical transitions, identical component type: the ONLY difference from
  // the test above is the children shape, which is what attributes the remount
  // to the shape and not to the branch switch itself.
  renderShape(FixedShape, { ...base, maximized: true });
  expect(ctlUnmounts.get("s1") ?? 0).toBe(0);
  expect(ctlUnmounts.get("s2") ?? 0).toBe(0);

  renderShape(FixedShape, { ...base, maximized: false, carousel: true });
  expect(ctlUnmounts.get("s1") ?? 0).toBe(0);
  expect(ctlUnmounts.get("s2") ?? 0).toBe(0);
  expect(ctlMounts.get("s1")).toBe(1);
  expect(ctlMounts.get("s2")).toBe(1);
});

// pickRestorable (b8d65b24 follow-up + operator arbitration): the "restore
// previous" tile must offer a workspace that is actually restorable (has
// sessions, not locked elsewhere), and `current` is only eligible once the
// deck has zero live agent sessions -- see the doc comment on the function
// itself for the full rationale. `liveAgentCount` is a plain parameter here,
// never a store read, so these cases need no store/DOM mocking at all.
let wsSeq = 0;
function ws(overrides: Partial<{
  id: string;
  name: string;
  pinned: boolean;
  scopeName: string;
  sessionCount: number;
  updatedAt: number;
  locked: boolean;
  current: boolean;
}>) {
  wsSeq += 1;
  return {
    id: `ws-${wsSeq}`,
    name: `workspace ${wsSeq}`,
    pinned: false,
    scopeName: "scope",
    sessionCount: 1,
    updatedAt: 1,
    locked: false,
    current: false,
    ...overrides
  };
}

test("pickRestorable: an empty list has nothing to offer", () => {
  expect(pickRestorable([], 0)).toBeUndefined();
});

test("pickRestorable: all entries are `current` with a live agent -- nothing restorable", () => {
  const list = [ws({ current: true, sessionCount: 2 }), ws({ current: true, sessionCount: 3 })];
  expect(pickRestorable(list, 1)).toBeUndefined();
});

test("pickRestorable: all entries locked by another instance -- nothing restorable", () => {
  const list = [ws({ locked: true }), ws({ locked: true })];
  expect(pickRestorable(list, 0)).toBeUndefined();
});

test("pickRestorable: a zero-session entry is skipped in favor of the next valid one", () => {
  const empty = ws({ sessionCount: 0 });
  const valid = ws({ sessionCount: 4 });
  expect(pickRestorable([empty, valid], 0)).toBe(valid);
});

test("pickRestorable: `current` with zero live agents and sessions IS chosen (empty-deck restore)", () => {
  const current = ws({ current: true, sessionCount: 2 });
  expect(pickRestorable([current], 0)).toBe(current);
});

test("pickRestorable: `current` with a live agent still running is EXCLUDED", () => {
  const current = ws({ current: true, sessionCount: 2 });
  expect(pickRestorable([current], 1)).toBeUndefined();
});

// TemplatesDialog gates .btn-apply on sessions filtered to exclude the
// supervisor tile; reading the raw sessions selector directly showed Apply for
// a deck with nothing open but the supervisor.
test("TemplatesDialog: supervisor-only deck (no agent sessions) shows no Apply button", () => {
  act(() => {
    fakeUseDeck.setState({
      sessions: [{ id: "sup", supervisor: true }],
      templates: []
    });
    root.render(React.createElement(TemplatesDialog));
  });

  expect(container.querySelector(".btn-apply")).toBeNull();
});

test("TemplatesDialog: at least one agent session shows the Apply button", () => {
  act(() => {
    fakeUseDeck.setState({
      sessions: [
        { id: "sup", supervisor: true },
        { id: "agent1", supervisor: false }
      ],
      templates: []
    });
    root.render(React.createElement(TemplatesDialog));
  });

  expect(container.querySelector(".btn-apply")).not.toBeNull();
});
