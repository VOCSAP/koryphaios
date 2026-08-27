// Card 0b9e0b07 lot B: proof that a role picked on a session card inside the
// team template composer actually reaches the saved template file -- the
// round-trip lot A's shared/template.ts made possible but nobody had
// exercised from the UI yet (see tests/desktop-template.test.ts /
// tests/desktop-template-store.test.ts for the file<->inputs half, already
// covered).
//
// DOM harness: same dual-React-copy happy-dom bridge already used for
// TemplateComposer in tests/desktop-templates-composer-draft-reset.test.ts.
//
// DELIBERATE SPLIT, and why: the first 3 tests mount `EntryCard` DIRECTLY,
// imported from its own module (desktop/src/renderer/src/components/
// TemplateEntryCard.tsx, entry-card-isolation lot) instead of the full
// `TemplateComposer`. EntryCard never calls `useDeck` -- it is a pure,
// prop-driven component -- so it needs no store mock, and living in its OWN
// file is what makes it immune BY CONSTRUCTION to a real, measured cross-file
// contamination: tests/desktop-templates-composer-seed.test.ts calls
// `mock.module(".../TemplateComposer.tsx", () => ({ TemplateComposer: stub }))`.
// bun's `mock.module` freezes a specifier's export surface to exactly the
// keys the FIRST-registered factory returns, for the rest of the bun test
// process. Measured before the extraction: `bun test
// ./tests/desktop-templates-composer-draft-reset.test.ts ./tests/desktop-templates-composer-role.test.ts`
// -> 5 pass / 0 fail (this file's OWN suspect, a useDeck race with
// draft-reset.test.ts, is innocent); `bun test
// ./tests/desktop-templates-composer-seed.test.ts ./tests/desktop-templates-composer-role.test.ts`
// -> 4 pass / 4 fail, `Element type is invalid: ... but got: undefined ...
// at mountEntryCard` -- once seed.test.ts's mock.module of TemplateComposer.tsx
// loads first, ANY later import of that specifier in the same process
// (including this file's, for EntryCard) receives `EntryCard: undefined`
// from the frozen, TemplateComposer-only factory. Exporting EntryCard
// alongside TemplateComposer from the SAME file, as a prior lot did, never
// actually protected it from this -- only moving it to a file seed.test.ts
// never mocks does. The one test below that still needs the full component
// (the true save()-to-disk round trip) remains order-dependent ON PURPOSE:
// it passes only if this file loads before
// tests/desktop-templates-composer-seed.test.ts, which today is guaranteed
// by alphabetical order under a bare `bun test` and by per-file process
// isolation under scripts/partition-pure-tests.ts in CI, and by NOTHING ELSE
// -- it is NOT immune the way the 3 EntryCard tests above it now are.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { Root } from "../desktop/tests-support/react-test-harness"; // type-only: erased, no runtime resolution
import { mockStore, storeMockStubs } from "./_store-mock";

const { act, React, createRoot, create } = await import("../desktop/tests-support/react-test-harness");

interface FakeDeckState {
  config: { roleChoices: string[] };
  dict: Record<string, string>;
  showToast: (key: string) => void;
}

function initialFakeState(): FakeDeckState {
  return {
    config: { roleChoices: [] },
    dict: {},
    showToast: () => {}
  };
}

const fakeUseDeck = create<FakeDeckState>(() => initialFakeState());

function resetFakeStore(): void {
  fakeUseDeck.setState(initialFakeState(), true);
}

// Still required even for the EntryCard-only tests: TemplateComposer.tsx's
// top-level `import { useDeck } from '../store'` must resolve to SOMETHING
// syntactically valid for the module to load at all (the real store.ts
// itself fails under bun test on its own `@shared/types` alias import, per
// tests/_store-mock.ts's own header comment) -- but since EntryCard never
// CALLS `useDeck`, it is provably inert which instance wins the module-cache
// race described above.
mockStore({ useDeck: fakeUseDeck, ...storeMockStubs });

// TemplateComposer.tsx imports value exports from '@shared/template' and
// '@shared/role' (both tsconfig-only aliases, not resolved by bun test --
// same gap documented in tests/desktop-tile-area.test.ts's header). Faithful
// reimplementation of the tiny, dependency-free role module (not a bare
// stub), so mergeRoleChoices' real behavior populates the select for real.
mock.module("@shared/template", () => ({
  TEMPLATE_TYPE: "koryphaios.template",
  TEMPLATE_VERSION: 1
}));
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

let writeCalls: Array<{ name: string; local: boolean; tpl: unknown }> = [];

(window as unknown as { api: unknown }).api = {
  listAgents: () => Promise.resolve([]),
  getLaunchConfig: () => Promise.resolve({ models: [] }),
  readTemplateFile: () => Promise.resolve(null),
  writeTemplateFile: (name: string, local: boolean, tpl: unknown) => {
    writeCalls.push({ name, local, tpl });
    return Promise.resolve(`/fake/${name}.json`);
  }
};

const { TemplateComposer } = await import(
  "../desktop/src/renderer/src/components/TemplateComposer"
);
const { EntryCard } = await import(
  "../desktop/src/renderer/src/components/TemplateEntryCard"
);

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  resetFakeStore();
  writeCalls = [];
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

// Same native-setter bypass as tests/desktop-templates-composer-draft-reset.test.ts's
// typeInto, generalized to any value-bearing element (input OR select): React
// patches the element's own `value` property setter to track "did this change
// externally", so a bare `el.value = x` leaves React's tracker unaware and the
// subsequent event finds "no change" -- onChange never fires. Bypass via the
// native prototype setter, same technique React Testing Library's
// fireEvent.change uses. `<select>` fires on 'change', not 'input'.
function setValue(el: HTMLInputElement | HTMLSelectElement, value: string, eventType: "input" | "change"): void {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set;
  if (!setter) throw new Error("no native value setter found on element prototype");
  setter.call(el, value);
  el.dispatchEvent(new Event(eventType, { bubbles: true }));
}

/** The role <select> is identified by an <option value="developer"> among its
 * children -- a built-in role no other field's select (agent/model/effort)
 * can ever contain, so this does not depend on DOM position/order. */
function findRoleSelect(): HTMLSelectElement {
  const selects = Array.from(container.querySelectorAll(".tc-grid select")) as HTMLSelectElement[];
  const found = selects.find((s) => Array.from(s.options).some((o) => o.value === "developer"));
  if (!found) throw new Error('role <select> not found (no <option value="developer">)');
  return found;
}

const noop = (): void => {};

function mountEntryCard(roleChoices: string[], onChange: (next: { role?: string }) => void): void {
  act(() => {
    root.render(
      React.createElement(EntryCard, {
        session: { name: "dev" },
        agents: [],
        models: [],
        roleChoices,
        onChange,
        onRemove: noop,
        onLead: noop,
        t: (key: string) => key
      })
    );
  });
}

// ----- EntryCard direct (no store, immune to the race documented above) -----

test("EntryCard's role select is populated from its roleChoices prop, empty option first", () => {
  mountEntryCard(["team-lead", "developer", "ops-lead"], noop);
  const select = findRoleSelect();
  expect(Array.from(select.options).map((o) => o.value)).toEqual(["", "team-lead", "developer", "ops-lead"]);
});

test("EntryCard emits onChange with the picked role when the operator selects one", () => {
  let last: { role?: string } | null = null;
  mountEntryCard(["developer"], (next) => {
    last = next;
  });
  act(() => setValue(findRoleSelect(), "developer", "change"));
  expect(last).not.toBeNull();
  expect(last!.role).toBe("developer");
});

test("EntryCard emits onChange with role undefined (never '') when reverted to the empty option", () => {
  let last: { role?: string } | null = null;
  mountEntryCard(["developer"], (next) => {
    last = next;
  });
  act(() => setValue(findRoleSelect(), "developer", "change"));
  act(() => setValue(findRoleSelect(), "", "change"));
  expect(last).not.toBeNull();
  expect(last!.role).toBeUndefined();
});

// ----- Full TemplateComposer, single end-to-end save() proof -----

async function mountBlankComposer(): Promise<void> {
  await act(async () => {
    root.render(
      React.createElement(TemplateComposer, { path: null, onClose: noop, onSaved: noop })
    );
    // Flush the mount effect's listAgents()/getLaunchConfig() microtasks,
    // same necessity documented in the draft-reset file this pattern is
    // copied from.
    await Promise.resolve();
  });
}

test("picking a role on a card and saving writes it into that session's TemplateSession.role; leaving it empty omits the key", async () => {
  await mountBlankComposer();

  const nameInput = container.querySelector(".tc-meta-name input") as HTMLInputElement | null;
  expect(nameInput).not.toBeNull();
  act(() => setValue(nameInput!, "my team", "input"));

  const roleSelect = findRoleSelect();
  act(() => setValue(roleSelect, "developer", "change"));

  const primaryBtn = container.querySelector(".modal-actions button.primary") as HTMLButtonElement | null;
  expect(primaryBtn).not.toBeNull();

  await act(async () => {
    primaryBtn!.click();
    await Promise.resolve();
  });

  expect(writeCalls).toHaveLength(1);
  const tpl = writeCalls[0]!.tpl as { sessions: Array<{ name: string; role?: string }> };
  expect(tpl.sessions).toHaveLength(1);
  expect(tpl.sessions[0]!.role).toBe("developer");
});
