// TemplatesDialog renders TemplateComposer with no key; a second "New
// template..." while it's already open on a blank draft is a transition between
// two structurally identical {path:null} objects, so React reuses the existing
// instance instead of remounting it.
// TemplateComposer seeds its fields via useState, which only runs at mount, so
// the previous draft stays on screen instead of resetting.
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
  // Card 0b9e0b07 lot B: TemplateComposer now reads config.roleChoices to
  // populate its per-card Role select (useDeck((s) => s.config!)).
  config: { roleChoices: string[] };
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
    config: { roleChoices: [] },
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

// @shared/template's TEMPLATE_TYPE/TEMPLATE_VERSION are aliased only in
// desktop's own tsconfig, unresolved when bun test runs from the repo root.
// Placeholder values are fine here since this file never calls save(), the only
// place they're read.
mock.module("@shared/template", () => ({
  TEMPLATE_TYPE: "koryphaios.template",
  TEMPLATE_VERSION: 1
}));

// Card 0b9e0b07 lot B: TemplateComposer now also imports mergeRoleChoices
// from '@shared/role' (same alias-resolution gap as above). Full, faithful
// reimplementation of the real (tiny, dependency-free) module -- not a bare
// stub -- so this mock's export surface matches shared/role.ts exactly and
// its behavior is trustworthy wherever a future test exercises it.
mock.module("@shared/role", () => {
  const TEAM_LEAD_ROLE = "team-lead";
  const BUILTIN_ROLES = [
    TEAM_LEAD_ROLE,
    "developer",
    "reviewer",
    "explorer",
    "architect",
    "test-engineer",
    "doc-writer",
    "security-auditor",
    "debugger",
    "release-engineer",
    "web-designer"
  ];
  const ROLE_MAX = 32;
  const sanitizeRole = (value: string): string => {
    const kebab = value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, ROLE_MAX);
    return kebab.replace(/-+$/, "");
  };
  const mergeRoleChoices = (custom: readonly string[]): string[] => {
    const out: string[] = [...BUILTIN_ROLES];
    for (const raw of custom) {
      const role = sanitizeRole(raw);
      if (role && !out.includes(role)) out.push(role);
    }
    return out;
  };
  return { TEAM_LEAD_ROLE, BUILTIN_ROLES, ROLE_MAX, sanitizeRole, mergeRoleChoices };
});

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
  // TemplateComposer's mount effect fires listAgents()/getLaunchConfig()
  // unconditionally, both resolving as an already-queued microtask; await
  // Promise.resolve() here drains both before act() resolves.
  // Without it, their setState calls land after unmount/teardown and crash with
  // "window is not defined" in a later scheduler tick.
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
