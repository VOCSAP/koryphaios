// Team-lead review 2026-08-21 (spec_542dab47), CDP-frozen fix on
// TemplatesDialog.tsx / TemplateComposer.tsx: `{composer && <TemplateComposer
// path={composer.path} .../>}` has no `key`. The seed effect always calls
// `setComposer({ path: null })`. If the composer is ALREADY open on a blank
// draft, that is a transition from `{path:null}` to a NEW but structurally
// identical `{path:null}` object -- same element type, same JSX position, no
// key -- so React reuses the existing TemplateComposer instance rather than
// remounting it. TemplateComposer seeds its fields via `useState('')`, which
// only runs at mount, and its sole reload effect is `useEffect(..., [path])`
// with an early `if (!path) return` -- so a second "New template..." while
// the composer is open leaves whatever the operator already typed on screen.
// The card's acceptance criterion promises a blank composer on every
// trigger; this is currently false in that case.
//
// THIS IS A NATURAL RED: unlike tests/desktop-templates-composer-seed.test.ts
// (which had to reproduce a PAST, already-fixed anti-pattern locally to get a
// red control), the bug this file guards is present in the tree right now.
// No repro, no swap: this file is written once, run once to capture the
// failing output, then left exactly as-is for the fix author (a different
// agent, under an explicit freeze on this file pair) to turn green.
//
// Scope: unlike the composer-seed file, THIS bug lives inside
// TemplateComposer.tsx itself, so that component is mounted for REAL here,
// not stubbed -- the whole point is to observe its internal draft state
// surviving a reuse it shouldn't survive.
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
// Fake store: same FakeDeckState shape already proven for TemplatesDialog in
// tests/desktop-templates-composer-seed.test.ts.
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
    clearTemplatesComposerSeed: () => fakeUseDeck.setState({ templatesComposerSeed: 0 })
  };
}

const fakeUseDeck = create<FakeDeckState>(() => initialFakeState());

function resetFakeStore(): void {
  fakeUseDeck.setState(initialFakeState(), true);
}

mockStore({ useDeck: fakeUseDeck, ...storeMockStubs });

// TemplateComposer.tsx imports value exports TEMPLATE_TYPE/TEMPLATE_VERSION
// from '@shared/template' (a tsconfig-only alias not resolved when bun test
// runs from the repo root -- same gap documented in
// tests/desktop-tile-area.test.ts's header). Arbitrary placeholder values are
// fine: this file never calls save(), which is the only place they are read.
mock.module("@shared/template", () => ({
  TEMPLATE_TYPE: "koryphaios.template",
  TEMPLATE_VERSION: 1
}));

// TemplateComposer's mount effect calls window.api.listAgents() and
// window.api.getLaunchConfig() UNCONDITIONALLY (not gated on `path`), and
// window.api.readTemplateFile(path) only when `path` is non-null. This file
// never opens on an existing path, so only the first two need to resolve.
(window as unknown as { api: unknown }).api = {
  listAgents: () => Promise.resolve([]),
  getLaunchConfig: () => Promise.resolve({ models: [] }),
  readTemplateFile: () => Promise.resolve(null)
};

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

// React patches the DOM node's own `value` PROPERTY SETTER on controlled
// inputs to track "did this change externally". A bare `el.value = x`
// assignment goes through that same patched setter, which also updates
// React's internal tracker -- so the subsequent 'input' event finds "no
// change" and onChange never fires. That would make this test pass or fail
// for the WRONG reason (the DOM node's raw .value would still read back
// whatever we set by hand, independent of whether React's `name` state ever
// moved) regardless of the actual bug. Bypass via the native prototype
// setter, same technique React Testing Library's fireEvent.change uses.
function typeInto(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set;
  if (!setter) throw new Error("no native value setter found on input prototype");
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

test("BUG (spec_542dab47): a second seed while the composer is open on a draft leaves the previous draft on screen instead of a blank composer", async () => {
  // Step 1: File > New template... -> composer opens on a blank draft.
  // Async act(): TemplateComposer's mount effect fires window.api.listAgents()
  // and window.api.getLaunchConfig() UNCONDITIONALLY, both resolving as a
  // microtask (the fake window.api stub returns already-resolved promises).
  // `await Promise.resolve()` inside this act() callback yields once, which
  // drains both already-queued `.then(setAgents)`/`.then(setModels)`
  // microtasks (both chained synchronously in the same effect run, so both
  // are ahead of this continuation in the queue) BEFORE act() resolves --
  // measured necessary (hyp_ log-hypothesis before this fix): without it,
  // those two setState calls land after this test function returns
  // (root.unmount() in afterEach already ran, and once this is the only test
  // in the file, GlobalRegistrator.unregister() in afterAll already tore
  // down `window` too), which the React scheduler then dereferences in a
  // later callback tick ("ReferenceError: window is not defined" in
  // react-dom-client's performWorkOnRootViaSchedulerTask) -- exit code 1 on
  // an otherwise-passing test ("Unhandled error between tests"). Confirmed by
  // removing this flush and reproducing the exact reported crash, then
  // adding it back.
  await act(async () => {
    fakeUseDeck.setState({ templatesComposerSeed: 1 });
    root.render(React.createElement(TemplatesDialog));
    await Promise.resolve();
  });

  const nameInput = container.querySelector(".tc-meta-name input") as HTMLInputElement | null;
  expect(nameInput).not.toBeNull();
  expect(nameInput!.value).toBe("");

  // Step 2: the operator starts typing a template name.
  act(() => {
    typeInto(nameInput!, "draft-in-progress");
  });
  expect(nameInput!.value).toBe("draft-in-progress");

  // Step 3: File > New template... a SECOND time, while the composer is
  // still open on this in-progress draft. If the fix remounts TemplateComposer
  // (new instance, e.g. via a `key`), its mount effect fires AGAIN, so this
  // step needs the same async flush as step 1.
  await act(async () => {
    fakeUseDeck.setState({ templatesComposerSeed: 2 });
    await Promise.resolve();
  });

  // The card's promise: a fresh "New template..." always opens a BLANK
  // composer. Re-query the DOM (not the stale `nameInput` reference) so this
  // assertion reflects what the operator would actually see on screen,
  // whether TemplateComposer remounted (new node) or was reused (same node).
  const nameInputAfter = container.querySelector(".tc-meta-name input") as HTMLInputElement | null;
  expect(nameInputAfter).not.toBeNull();
  expect(nameInputAfter!.value).toBe("");
});
