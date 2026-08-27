// Card 290a14e2 / spec_11049b90. Regression guard for the composer-seed
// self-clearing fix documented in TemplatesDialog.tsx: `templatesComposerSeed`
// is a one-shot counter, bumped by `openTemplates(open, { composer: true })`
// (File > New template...), consumed and cleared back to 0 the instant the
// dialog opens the blank composer. Self-clearing matters because a first cut
// compared the counter against a component-local `useRef` sentinel instead
// of clearing the STORE's own copy -- that broke exactly the case this file
// exercises: closing the whole dialog, then reopening it later via an
// UNRELATED path (e.g. the home "Use template" button, no `composer` opt),
// which remounts TemplatesDialog and re-initialises any component-local ref.
// A stale non-zero seed left over from an earlier "New template..." session
// then forced the composer back open every time. Caught live via a CDP
// screenshot on 2026-08-21, not by any type/unit test -- this file is that
// missing replay.
//
// CONSTRAINT (team-lead, shared checkout, three cards live under desktop/src/
// right now, two in review): this file must not touch ANY file under
// desktop/src/, not even temporarily to revert-and-restore the fix for a
// red-first measurement. So the red-first proof below does not revert the
// production file. Instead it reproduces the documented PRE-FIX anti-pattern
// (`BuggyComposerRepro` below) entirely inside this test file, from the
// description in TemplatesDialog.tsx's own comment, and drives it through the
// exact same three-step scenario used against the real component: bump the
// seed, unmount the whole dialog, remount fresh via an unrelated path (no
// seed bump). The repro is shown to reopen wrongly (RED); the real,
// unmodified TemplatesDialog is then shown to stay closed (GREEN) under the
// identical scenario and the identical store instance.
//
// DOM harness: same dual-React-copy jsdom/happy-dom bridge and mock.module
// pattern already used for the same component in tests/desktop-tile-area.test.ts
// (store.ts and TemplateComposer.tsx mocked the same way). See that file's
// header for the full happy-dom global-registrator rationale; this file keeps
// only the minimal register()/unregister() pairing required by
// tests/desktop-happy-dom-teardown.test.ts's repo-wide guard (same minimal
// shape as tests/desktop-sidebar-autoresume-dom.test.ts).
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { Root } from "../desktop/tests-support/react-test-harness"; // type-only: erased, no runtime resolution
import { mockStore, storeMockStubs } from "./_store-mock";

const { act, React, createRoot, create } = await import("../desktop/tests-support/react-test-harness");

// ---------------------------------------------------------------------------
// Fake store: covers exactly what TemplatesDialog reads/calls (mirrors the
// FakeDeckState already proven to work for this same component in
// tests/desktop-tile-area.test.ts).
interface FakeSession {
  id: string;
  supervisor?: boolean;
}
interface FakeTemplate {
  path: string;
  name: string;
  source: "global" | "local";
  sessionCount: number;
}
interface FakeDeckState {
  sessions: FakeSession[];
  templates: FakeTemplate[];
  templatesManage: boolean;
  templatesComposerSeed: number;
  dict: Record<string, string>;
  applyTemplate: (path: string, mode: "append" | "replace") => Promise<void>;
  removeTemplate: (path: string) => Promise<void>;
  openTemplates: (open: boolean, opts?: { manage?: boolean; composer?: boolean }) => void;
  refreshTemplates: () => Promise<void>;
  showToast: (key: string) => void;
  clearTemplatesComposerSeed: () => void;
}

function initialFakeState(): FakeDeckState {
  return {
    sessions: [],
    templates: [],
    templatesManage: false,
    templatesComposerSeed: 0,
    dict: {},
    applyTemplate: async () => {},
    removeTemplate: async () => {},
    openTemplates: () => {},
    refreshTemplates: async () => {},
    showToast: () => {},
    // Faithful to the real store contract (store.ts:257): clears the seed
    // back to 0 synchronously. A fake that no-ops here would let the real
    // component's assertion pass for the wrong reason (edge case from the
    // spec: "clearTemplatesComposerSeed never wired" must NOT silently pass).
    clearTemplatesComposerSeed: () => fakeUseDeck.setState({ templatesComposerSeed: 0 })
  };
}

const fakeUseDeck = create<FakeDeckState>(() => initialFakeState());

function resetFakeStore(): void {
  fakeUseDeck.setState(initialFakeState(), true);
}

mockStore({ useDeck: fakeUseDeck, ...storeMockStubs });

// Stub: renders one observable marker, data-testid="composer-stub", exactly
// while TemplatesDialog's local `composer` state is non-null. No internal
// React state is read anywhere in this file -- every assertion below reads
// this DOM marker, an external observable of "is the composer showing".
mock.module("../desktop/src/renderer/src/components/TemplateComposer.tsx", () => ({
  TemplateComposer: () => React.createElement("div", { "data-testid": "composer-stub" })
}));

const { TemplatesDialog } = await import("../desktop/src/renderer/src/components/TemplatesDialog");

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

function hasComposerStub(): boolean {
  return container.querySelector('[data-testid="composer-stub"]') !== null;
}

// ---------------------------------------------------------------------------
// RED-FIRST PROOF (in-file only, desktop/src/ untouched -- see file header).
// Reproduces the documented pre-fix shape: a component-local `useRef`
// sentinel compared against the seed, which never clears the STORE's own
// copy. `seenSeedRef` is captured in the closure below so each fresh mount of
// this component gets its OWN fresh ref, exactly like a real remount would.
function BuggyComposerRepro(): React.JSX.Element {
  const composerSeed = fakeUseDeck((s) => s.templatesComposerSeed);
  const [composer, setComposer] = React.useState<{ path: string | null } | null>(null);
  const seenSeedRef = React.useRef(0);
  React.useEffect(() => {
    if (composerSeed > 0 && composerSeed !== seenSeedRef.current) {
      seenSeedRef.current = composerSeed;
      setComposer({ path: null });
      // BUG (intentional, documented pre-fix anti-pattern): the store's own
      // `templatesComposerSeed` is never cleared here, unlike the real
      // TemplatesDialog effect.
    }
  }, [composerSeed]);
  return composer
    ? React.createElement("div", { "data-testid": "composer-stub" })
    : React.createElement("div", { "data-testid": "no-composer" });
}

test("RED CONTROL: pre-fix useRef-sentinel repro wrongly reopens the composer after an unrelated remount", () => {
  // Step 1: seed bumped (File > New template...) -> composer opens.
  act(() => {
    fakeUseDeck.setState({ templatesComposerSeed: 1 });
    root.render(React.createElement(BuggyComposerRepro));
  });
  expect(hasComposerStub()).toBe(true);

  // Step 2: close the whole dialog (full unmount).
  act(() => {
    root.unmount();
  });
  // Faithful to the documented bug: the store's seed was never cleared.
  expect(fakeUseDeck.getState().templatesComposerSeed).toBe(1);

  // Step 3: reopen via an UNRELATED path (no seed bump) -- fresh root, fresh
  // instance, fresh useRef, exactly like a real remount of the component.
  root = createRoot(container);
  act(() => {
    root.render(React.createElement(BuggyComposerRepro));
  });

  // This is the bug: composer reopens even though nothing requested it this
  // time. If this assertion ever fails, the repro no longer reproduces the
  // documented anti-pattern and this red control is no longer meaningful.
  expect(hasComposerStub()).toBe(true);
});

// ---------------------------------------------------------------------------
// GREEN: the real, unmodified TemplatesDialog under the identical scenario.
test("TemplatesDialog: seed opens the composer and self-clears it", () => {
  act(() => {
    fakeUseDeck.setState({ templatesComposerSeed: 1 });
    root.render(React.createElement(TemplatesDialog));
  });

  expect(hasComposerStub()).toBe(true);
  expect(fakeUseDeck.getState().templatesComposerSeed).toBe(0);
});

test("TemplatesDialog: a fresh non-zero seed reopens the composer even while the dialog is already open", () => {
  act(() => {
    fakeUseDeck.setState({ templatesComposerSeed: 1 });
    root.render(React.createElement(TemplatesDialog));
  });
  expect(hasComposerStub()).toBe(true);

  // Second "New template..." while already open must still re-trigger --
  // a naive effect keyed on a plain boolean would no-op on a repeat request.
  act(() => {
    fakeUseDeck.setState({ templatesComposerSeed: 2 });
  });
  expect(hasComposerStub()).toBe(true);
  expect(fakeUseDeck.getState().templatesComposerSeed).toBe(0);
});

test("NEGATIVE CONTROL: closing the dialog entirely then reopening via an unrelated path does not reopen the composer", () => {
  // Step 1: seed bumped -> composer opens, store self-clears (already proven
  // above; re-verified inline here so this test stands on its own).
  act(() => {
    fakeUseDeck.setState({ templatesComposerSeed: 1 });
    root.render(React.createElement(TemplatesDialog));
  });
  expect(hasComposerStub()).toBe(true);
  expect(fakeUseDeck.getState().templatesComposerSeed).toBe(0);

  // Step 2: close the whole dialog (full unmount, e.g. Cancel or the
  // backdrop click -- either way TemplatesDialog itself unmounts).
  act(() => {
    root.unmount();
  });

  // Step 3: reopen via an UNRELATED path (e.g. the home "Use template"
  // button: `openTemplates(true)`, no `composer` option) -- fresh root,
  // fresh component instance, no seed bump. The store's seed is already 0
  // from step 1's self-clear.
  root = createRoot(container);
  act(() => {
    root.render(React.createElement(TemplatesDialog));
  });

  expect(hasComposerStub()).toBe(false);
});
