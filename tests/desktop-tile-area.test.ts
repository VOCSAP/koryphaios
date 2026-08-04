// spec_fe032ba6: regression harness for "maximizing a tile remounts every
// terminal and destroys all scrollback" (roadmap card 903ee271).
//
// TileArea.tsx (desktop/src/renderer/src/components/TileArea.tsx) has three
// JSX `return` branches that each render `sessions.map((s) => <TerminalTile
// key={s.id} .../>)` inline. The suspected bug: switching between branches
// (e.g. grid <-> maximized) unmounts and remounts every TerminalTile instead
// of reusing it, because the branches build the children differently rather
// than sharing one hoisted `children` value. A remount tears down the real
// xterm.js Terminal object living inside TerminalTile, which is where the
// operator's scrollback lives -- so a remount is data loss, not a cosmetic
// re-render.
//
// This test exercises the SINGLE exported TileArea component, unmodified,
// through both of its JSX branches. Splitting the branches into separate
// components to make them individually testable would defeat the point:
// React remounts on element TYPE change, so a synthetic split would report
// the bug as fixed while the production code (single component, single type)
// still has it. TerminalTile itself is mocked -- swapping out a *child*
// module is ordinary test isolation, not a rewrite of the component under
// test.
//
// DOM harness note -- CORRECTED 2026-08-03 (debugger-caught, was FALSE):
// this used to claim happy-dom was "self-contained... at the top of THIS
// file only". Measured false: `bun test` loads every matched file into ONE
// process before running any of them, so `GlobalRegistrator.register()`
// mutates `globalThis` for every file in the invocation, not this one.
// Measured (debugger, full before/after diff of `globalThis`, not a
// five-name guess): register() REPLACES 34 existing globals, ADDS ~484 (the
// DOM surface itself, wanted), removes none. Of the 34 replaced, happy-dom's
// `fetch` is built on `node:_http_client` and cannot parse a `Bun.serve`
// response ("Parse Error, HPE_UNEXPECTED_CONTENT_LENGTH") -- so any OTHER
// file in the same `bun test` run that joins a broker over real HTTP (e.g.
// tests/server-ask-operator.test.ts) hung to its own deadline the instant
// this file's `register()` ran. Fix below: snapshot `globalThis` before
// registering, restore every replaced name to its Bun-native value after,
// then re-apply happy-dom's own value ONLY for the 9 names this DOM harness
// (createElement/appendChild, addEventListener+dispatchEvent, a React
// `useEffect` mount) measurably needs -- see `RESTORE_HAPPY_DOM_FOR` below
// for the list and why each one is there. A hardcoded 3-or-9-name list
// applied as the RESTORE set would be silently incomplete the moment
// happy-dom's own replaced-globals surface grows; the snapshot diff cannot
// be, by construction. Restorable-without-effect-on-the-DOM (confirmed by
// exercising createElement/dispatchEvent/React mount with them restored):
// all of fetch/WebSocket/Response/Request/Headers/URL/Blob/File/FormData/
// AbortController/AbortSignal/DOMException/MessagePort/navigator/atob/btoa/
// postMessage/queueMicrotask/setTimeout/setInterval/clearTimeout/
// clearInterval and a few more -- every network and timer primitive on the
// broker suites' hot path.
//
// New ROOT devDependencies: @happy-dom/global-registrator, and also
// react / react-dom / zustand (mirrors desktop/'s own versions). Both are
// needed, for two DIFFERENT environments: this test itself imports react
// only through desktop/tests-support/react-test-harness.ts (a relative
// import, physically inside desktop/, so it resolves against whichever
// node_modules is nearest -- same as TileArea.tsx's own bare react import
// (`import ... from` a bare specifier), which this test does NOT and
// cannot modify). Locally that
// nearest node_modules is desktop/node_modules, so the root copies sit
// unused. In CI, `bun test tests/desktop-*...` runs at the repo root right
// after a root `bun install` but BEFORE desktop/'s own `npm install`, so
// desktop/node_modules does not exist yet on that runner -- resolution for
// BOTH the bridge and TileArea.tsx then walks up to the repo root instead,
// and needs a copy there or TileArea.tsx itself fails to resolve `react`
// before this test ever runs. See the bridge file's header for the full
// explanation; do not remove the root copies because they look unused
// locally.
//
// Ordering note: GlobalRegistrator.register() must run before ANY module
// that inspects `window`/`document` at import time (react-dom does). Static
// `import` declarations are all evaluated before a module's own top-level
// statements run, regardless of where they appear in the file -- writing
// `import 'react-dom/client'` anywhere in this file would load react-dom // scanfile-swallow-ok: prose example
// before `GlobalRegistrator.register()` executes. The harness bridge is
// therefore pulled in via a dynamic `await import()`, which (unlike a static
// import) genuinely defers evaluation to this point in the file.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// The 9 names happy-dom is allowed to keep replaced, and the single reason
// shared by all 9: happy-dom's own event dispatch is built on ITS
// EventTarget/Event classes -- `document.createElement(...).dispatchEvent`
// only fires listeners registered through happy-dom's own
// addEventListener, because happy-dom checks `instanceof` its own Event
// class internally. Restoring any one of these 9 to Bun's native breaks
// event delivery for every other happy-dom object (measured: with all 34
// restored, `createElement` and a React `useEffect` mount still worked,
// but `dispatchEvent` failed with "parameter 1 is not of type 'Event'" --
// a render-only smoke test would NOT have caught this). None of the 9 are
// on the broker suites' hot path (no other test file constructs or
// dispatches a DOM Event), so keeping them polyfilled here costs nothing
// outside this file.
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

import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { Root } from "../desktop/tests-support/react-test-harness"; // type-only: erased, no runtime resolution; sourced via the bridge, not a bare "react-dom/client" import -- the quoted mention here IS caught by the swallow check (scanfile-swallow-ok: prose example), confirming the gate actually looks, not merely asserting it doesn't need to

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
  dict: Record<string, string>;
  createSession: () => Promise<void>;
  restoreWorkspace: () => Promise<void>;
  openWorkspaces: () => void;
  openTemplates: () => void;
}

function initialFakeState(): FakeDeckState {
  return {
    sessions: [],
    config: { displayMode: "2x2", gridCols: 2, gridRows: 2 },
    maximizedId: null,
    pendingSessions: 0,
    workspaces: [],
    templates: [],
    dict: {},
    createSession: async () => {},
    restoreWorkspace: async () => {},
    openWorkspaces: () => {},
    openTemplates: () => {}
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

mock.module("../desktop/src/renderer/src/store.ts", () => ({ useDeck: fakeUseDeck }));

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
const { TileArea } = await import("../desktop/src/renderer/src/components/TileArea");

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
  // The restore loop above deliberately leaves Event/EventTarget/
  // addEventListener/removeEventListener/dispatchEvent/CustomEvent/
  // MessageEvent/ErrorEvent/CloseEvent on happy-dom. Nothing else in this
  // file dispatches a DOM event -- the three regression tests below mount
  // components and push store state, never `.dispatchEvent(...)` -- so
  // without this test, restoring that exception list to Bun's natives by
  // mistake (e.g. someone "cleaning up" RESTORE_HAPPY_DOM_FOR because it
  // looks unused) would pass every other test in this file while breaking
  // event delivery for every happy-dom object (debugger-caught 2026-08-03:
  // restoring all 34 kept `createElement` and a full React mount working,
  // only `dispatchEvent` failed, with "parameter 1 is not of type
  // 'Event'"). This is the compensatory guard for that gap.
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

// ---------------------------------------------------------------------------
// NEGATIVE CONTROL (spec_b0cf2db9, team-lead ask 2026-08-04).
//
// Everything above asserts ZERO unmounts. Ten such assertions prove ten true
// statements and nothing more: a counter that has silently lost the ability to
// observe a remount passes them all. The red-first measurement that made them
// meaningful ("1 unmount before the fix, 0 after") was taken once, by hand,
// and lives in commit 1320be6's MESSAGE -- nothing in this tree replays it. So
// the day React stops deriving an implicit key path from a JSX subtree's
// structural position, the guard above becomes vacuous and stays green for the
// wrong reason, with nobody the wiser.
//
// The two tests below are that missing replay. They do not test TileArea: they
// test THE MECHANISM the guard depends on, on two miniature components that
// differ only in children shape. The pre-fix shape must remount, the shipped
// shape must not. If the pre-fix one ever passes WITHOUT unmounts, the
// mechanism is gone and every zero-unmount assertion above has become
// unfalsifiable -- that failure is the signal, not a nuisance to silence.
//
// TRAP, measured 2026-07-30, and the reason this must not be "simplified":
// each shape has to be ONE component with THREE returns, exactly like the real
// TileArea. Writing each branch as its own component makes React remount on
// the element TYPE change, which produces the expected unmount for a reason
// that has nothing to do with children shape. A control that passes for the
// wrong reason is worth less than no control at all.
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
