// templatesComposerSeed is a one-shot counter cleared by
// clearTemplatesComposerSeed the instant the composer opens; a stale non-zero
// value left over from an earlier session forces the composer open on an
// unrelated later path.
// This file must not touch any file under desktop/src/ (shared checkout
// constraint), so the red-first proof reproduces the pre-fix anti-pattern
// locally in BuggyComposerRepro rather than reverting the production file.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { Root } from "../desktop/tests-support/react-test-harness"; // type-only: erased, no runtime resolution
import { mockStore, storeMockStubs } from "./_store-mock";

const { act, React, createRoot, create } = await import("../desktop/tests-support/react-test-harness");

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
    // Clears the seed back to 0 synchronously, matching the real store
    // contract: a fake that no-ops here would let the real component's
    // assertion pass for the wrong reason.
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
