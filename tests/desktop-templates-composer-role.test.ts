// EntryCard is mounted directly from its own module rather than through the
// full TemplateComposer, since it calls no store hook and is otherwise immune,
// by construction, to a real cross-file contamination: a test-mocking utility
// used elsewhere in this family freezes a specifier's export surface to
// whatever the first-registered factory returns, for the rest of the process.
// Re-exporting EntryCard alongside TemplateComposer from the same module never
// actually protects it from that; only living in its own file does.
// The remaining save()-to-disk round trip still needs the full component and
// stays order-dependent on that file loading first.
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

// TemplateComposer.tsx's top-level import of useDeck must resolve to something
// syntactically valid for the module to load, but EntryCard never calls
// useDeck, so which mock instance wins the module-cache race described above is
// provably inert.
mockStore({ useDeck: fakeUseDeck, ...storeMockStubs });

// @shared/template and @shared/role are tsconfig-only aliases bun test does not
// resolve. The role module is faithfully reimplemented here (not stubbed) so
// mergeRoleChoices' real behavior populates the select.
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

// React patches an element's native value setter to detect external changes, so
// a bare el.value = x leaves onChange unfired. Bypasses via the native
// prototype setter instead, the same technique React Testing Library's
// fireEvent uses. A select fires on 'change', not 'input'.
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
