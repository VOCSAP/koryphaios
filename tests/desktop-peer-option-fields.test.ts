// The option controls a peer is described by, mounted on BOTH surfaces that
// share them: the template card and the create popover. A choice made on one
// must yield the fields the other would, and an invalid Context Size must stop
// the surface that would persist or spawn it.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { Root } from "../desktop/tests-support/react-test-harness"; // type-only: erased, no runtime resolution
import { mockStore, storeMockStubs } from "./_store-mock";
import * as realSharedTemplate from "../desktop/src/shared/template.ts";
import * as realSharedModels from "../desktop/src/shared/models.ts";
import * as realSharedRole from "../desktop/src/shared/role.ts";
import * as realSharedAnnounce from "../desktop/src/shared/announce.ts";
import type { ProviderCatalog } from "../desktop/src/shared/models.ts";
import type { TemplateSession } from "../desktop/src/shared/template.ts";

const { act, React, createRoot, create } = await import("../desktop/tests-support/react-test-harness");

interface FakeDeckState {
  config: { roleChoices: string[]; modelFavorites: string[]; leadPattern: string };
  dict: Record<string, string>;
  sessions: unknown[];
  sandboxStatus: { enabled: boolean } | null;
  templates: Array<{ path: string; name: string; source: "global" | "local"; sessionCount: number }>;
  templatesManage: boolean;
  templatesEdit: boolean;
  templatesComposerSeed: number;
  showToast: () => void;
  updateConfig: () => Promise<void>;
  createSession: (input: Record<string, unknown>) => Promise<void>;
  applyTemplate: (path: string, mode: string) => Promise<void>;
  removeTemplate: () => Promise<void>;
  openTemplates: (open: boolean) => void;
  refreshTemplates: () => Promise<void>;
  clearTemplatesComposerSeed: () => void;
}

let created: Array<Record<string, unknown>> = [];
let applied: string[] = [];

function initialFakeState(): FakeDeckState {
  return {
    config: { roleChoices: [], modelFavorites: [], leadPattern: "" },
    dict: {},
    sessions: [],
    sandboxStatus: null,
    templates: [],
    templatesManage: false,
    templatesEdit: false,
    templatesComposerSeed: 0,
    showToast: () => {},
    updateConfig: async () => {},
    createSession: async (input) => {
      created.push(input);
    },
    applyTemplate: async (path) => {
      applied.push(path);
    },
    removeTemplate: async () => {},
    openTemplates: () => {},
    refreshTemplates: async () => {},
    clearTemplatesComposerSeed: () => {}
  };
}

const fakeUseDeck = create<FakeDeckState>(() => initialFakeState());
mockStore({ useDeck: fakeUseDeck, ...storeMockStubs });

mock.module("@shared/template", () => realSharedTemplate);
mock.module("@shared/models", () => realSharedModels);
mock.module("@shared/role", () => realSharedRole);
mock.module("@shared/announce", () => realSharedAnnounce);

const CATALOGS: ProviderCatalog[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    kind: "frontier",
    cli: "claude",
    available: true,
    models: [
      { id: "opus", label: "Opus" },
      { id: "haiku", label: "Haiku" }
    ]
  },
  {
    id: "clodex",
    name: "OpenAI · clodex",
    kind: "bridge",
    cli: "claude",
    available: true,
    models: [{ id: "gpt-5", label: "GPT-5" }],
    bridge: { installed: true, serverUp: true, patch: "fresh" }
  }
];

let providerCatalogs: ProviderCatalog[] = CATALOGS;
let modelsChanged: (() => void) | null = null;
let catalogFetches = 0;
let readCalls: string[] = [];
let writeCalls: Array<{ name: string; local: boolean; tpl: { sessions: TemplateSession[] } }> = [];
const DEFAULT_ON_DISK = { type: "claude-peers-template", version: 1, name: "team", sessions: [{ name: "a" } as TemplateSession] };
let templateOnDisk: { type: string; version: number; name: string; sessions: TemplateSession[] } = DEFAULT_ON_DISK;

(window as unknown as { api: unknown }).api = {
  listAgents: () => Promise.resolve(["developer", "reviewer"]),
  getLaunchConfig: () => Promise.resolve({ models: [], presets: [] }),
  modelCatalogs: () => {
    catalogFetches++;
    return Promise.resolve(providerCatalogs);
  },
  onModelsChanged: (cb: () => void) => {
    modelsChanged = cb;
    return () => {
      modelsChanged = null;
    };
  },
  peekNextColor: () => Promise.resolve("#4f86ff"),
  reportError: () => {},
  readTemplateFile: (path: string) => {
    readCalls.push(path);
    return Promise.resolve(templateOnDisk);
  },
  writeTemplateFile: (name: string, local: boolean, tpl: { sessions: TemplateSession[] }) => {
    writeCalls.push({ name, local, tpl });
    return Promise.resolve("/fake.json");
  }
};

const { EntryCard } = await import("../desktop/src/renderer/src/components/TemplateEntryCard");
const { TemplateComposer } = await import("../desktop/src/renderer/src/components/TemplateComposer");
const { TemplatesDialog } = await import("../desktop/src/renderer/src/components/TemplatesDialog");
// The query gives a module record that the other files' stub of CreateMenu.tsx does not reach, and no teardown could undo.
const { CreateMenu } = await import("../desktop/src/renderer/src/components/CreateMenu.tsx?real");
const { mergeCreateCatalogs } = await import("../desktop/src/renderer/src/peer-options");

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  fakeUseDeck.setState(initialFakeState(), true);
  created = [];
  applied = [];
  readCalls = [];
  writeCalls = [];
  templateOnDisk = DEFAULT_ON_DISK;
  catalogFetches = 0;
  modelsChanged = null;
  providerCatalogs = CATALOGS;
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

const noop = (): void => {};

function setValue(el: HTMLInputElement | HTMLSelectElement, value: string, eventType: "input" | "change"): void {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set;
  if (!setter) throw new Error("no native value setter found on element prototype");
  setter.call(el, value);
  el.dispatchEvent(new Event(eventType, { bubbles: true }));
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function click(el: Element | null | undefined): Promise<void> {
  if (!el) throw new Error("nothing to click");
  await act(async () => {
    (el as HTMLElement).click();
    await Promise.resolve();
  });
}

function byText(selector: string, text: string): HTMLElement {
  const found = Array.from(container.querySelectorAll(selector)).find((e) => e.textContent?.includes(text));
  if (!found) throw new Error(`no ${selector} containing "${text}"`);
  return found as HTMLElement;
}

/** Choose a model by provider then label, through the real picker rows. */
async function chooseModel(provider: string, label: string): Promise<void> {
  if (container.querySelector(".mp-panel") === null && container.querySelector(".mp-current")) {
    await click(container.querySelector(".mp-current"));
  }
  const head = byText(".mp-provider-head", provider);
  if (!container.querySelector(".mp-models")) await click(head);
  else if (!Array.from(container.querySelectorAll(".mp-model-name")).some((n) => n.textContent === label)) {
    await click(head);
  }
  await click(byText(".mp-model", label));
}

let latest: TemplateSession;

function Harness({ initial }: { initial: TemplateSession }): React.JSX.Element {
  const [session, setSession] = React.useState(initial);
  latest = session;
  return React.createElement(EntryCard, {
    session,
    agents: [],
    catalogs: mergeCreateCatalogs([], CATALOGS),
    sandboxOn: false,
    onChange: setSession,
    onRemove: noop,
    onLead: noop,
    t: (key: string) => key
  });
}

async function mountCard(initial: TemplateSession): Promise<void> {
  await act(async () => {
    root.render(React.createElement(Harness, { key: JSON.stringify(initial), initial }));
    await Promise.resolve();
  });
}

function contextNumber(): HTMLInputElement | null {
  return container.querySelector(".ctx-number");
}

function extendedBox(): HTMLInputElement {
  return container.querySelector("label.field-check input[type=checkbox]") as HTMLInputElement;
}

// ----- template card -----

test("choosing a clodex model stores model and bridge, and reveals Context Size at its default", async () => {
  await mountCard({ name: "dev" });
  expect(contextNumber()).toBeNull();
  await chooseModel("OpenAI", "GPT-5");
  expect(latest.model).toBe("gpt-5");
  expect(latest.bridge).toBe("clodex");
  expect(contextNumber()?.value).toBe("200");
  expect(latest.clodexContextTokens).toBeUndefined();
});

test("leaving clodex for an Anthropic model drops bridge and the Context Size it carried", async () => {
  await mountCard({ name: "dev", model: "gpt-5", bridge: "clodex", clodexContextTokens: 300_000 });
  expect(contextNumber()?.value).toBe("300");
  await chooseModel("Anthropic", "Opus");
  expect(latest.model).toBe("opus");
  expect(latest.bridge).toBeUndefined();
  expect(latest.clodexContextTokens).toBeUndefined();
  expect(contextNumber()).toBeNull();
});

test("the slider and the number box edit one exact token count, in k", async () => {
  await mountCard({ name: "dev", model: "gpt-5", bridge: "clodex" });
  act(() => setValue(contextNumber()!, "250.5", "input"));
  expect(latest.clodexContextTokens).toBe(250_500);
  const slider = container.querySelector(".ctx-row input[type=range]") as HTMLInputElement;
  act(() => setValue(slider, "872", "input"));
  expect(latest.clodexContextTokens).toBe(872_000);
  expect(contextNumber()?.value).toBe("872");
});

test("a Context Size outside 200k to 872k is flagged on the card and not stored as a number", async () => {
  await mountCard({ name: "dev", model: "gpt-5", bridge: "clodex" });
  act(() => setValue(contextNumber()!, "873", "input"));
  expect(Number.isNaN(latest.clodexContextTokens)).toBe(true);
  expect(container.querySelector(".field-error")?.textContent).toBe("create.contextSizeInvalid");
  expect(contextNumber()?.getAttribute("aria-invalid")).toBe("true");
});

test("Extended context appends [1m] to an Opus model, is unavailable on Haiku and on clodex", async () => {
  await mountCard({ name: "dev", model: "opus" });
  await click(extendedBox());
  expect(latest.model).toBe("opus[1m]");
  await click(extendedBox());
  expect(latest.model).toBe("opus");
  await chooseModel("Anthropic", "Haiku");
  expect(extendedBox().disabled).toBe(true);
});

test("a legacy alias, an unlisted historical id and a [1m] id are shown as stored and left untouched", async () => {
  const cases: Array<[string, string]> = [
    ["sonnet", "sonnet"],
    ["claude-3-5-sonnet-20241022", "claude-3-5-sonnet-20241022"],
    ["opus[1m]", "Opus"]
  ];
  for (const [stored, shownAs] of cases) {
    await mountCard({ name: "dev", model: stored });
    expect(container.querySelector(".mp-current .mp-model-name")?.textContent, stored).toBe(shownAs);
    expect(latest.model).toBe(stored);
  }
});

test("a bare worktree branch, announce, args, prompt and effort survive a model change", async () => {
  const entry: TemplateSession = {
    name: "dev",
    args: "--add-dir ..",
    prompt: "go",
    announce: "hello",
    worktreeBranch: "agent/dev",
    effort: "high",
    color: "#112233"
  };
  await mountCard(entry);
  await chooseModel("OpenAI", "GPT-5");
  expect(latest).toMatchObject({ ...entry, model: "gpt-5", bridge: "clodex" });
});

test("the lead marker disables the role select, as the create popover does", async () => {
  await mountCard({ name: "dev", lead: true });
  const select = Array.from(container.querySelectorAll(".tc-grid select")).find((s) =>
    Array.from((s as HTMLSelectElement).options).some((o) => o.value === "developer")
  ) as HTMLSelectElement;
  expect(select.disabled).toBe(true);
});

test("a chosen colour can go back to auto without losing any other field", async () => {
  const entry: TemplateSession = {
    name: "dev",
    model: "gpt-5",
    bridge: "clodex",
    clodexContextTokens: 400_000,
    args: "--x",
    prompt: "go",
    announce: "hi",
    worktreeBranch: "b",
    effort: "high",
    role: "developer",
    agent: "reviewer",
    lead: true,
    color: "#112233"
  };
  await mountCard(entry);
  await click(container.querySelector(".tc-card-head .chip"));
  expect(latest).toEqual({ ...entry, color: undefined });
  expect(container.querySelector(".tc-card-head .chip") === null).toBe(true);
});

test("a card with no colour offers no auto button", async () => {
  await mountCard({ name: "dev" });
  expect(container.querySelector(".tc-card-head .chip") === null).toBe(true);
});

// ----- composer -----

test("the composer refuses to save while a clodex entry holds an invalid Context Size", async () => {
  await act(async () => {
    root.render(React.createElement(TemplateComposer, { path: null, onClose: noop, onSaved: noop }));
    await Promise.resolve();
  });
  await flush();
  act(() => setValue(container.querySelector(".tc-meta-name input") as HTMLInputElement, "team", "input"));
  const save = container.querySelector(".modal-actions button.primary") as HTMLButtonElement;
  expect(save.disabled).toBe(false);
  await chooseModel("OpenAI", "GPT-5");
  expect(save.disabled).toBe(false);
  act(() => setValue(contextNumber()!, "100", "input"));
  expect(save.disabled).toBe(true);
  act(() => setValue(contextNumber()!, "400", "input"));
  expect(save.disabled).toBe(false);
});

test("the composer picker follows the catalog when the main process announces a change", async () => {
  providerCatalogs = [CATALOGS[0]!];
  await act(async () => {
    root.render(React.createElement(TemplateComposer, { path: null, onClose: noop, onSaved: noop }));
    await Promise.resolve();
  });
  await flush();
  await click(container.querySelector(".mp-current"));
  expect(container.textContent).not.toContain("OpenAI");
  providerCatalogs = CATALOGS;
  await act(async () => {
    modelsChanged!();
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(container.textContent).toContain("OpenAI");
  expect(catalogFetches).toBeGreaterThanOrEqual(2);
});

// ----- launch flags captured inside args -----

async function openComposerOn(sessions: TemplateSession[]): Promise<void> {
  templateOnDisk = { ...DEFAULT_ON_DISK, sessions };
  await act(async () => {
    root.render(React.createElement(TemplateComposer, { path: "/t/team.json", onClose: noop, onSaved: noop }));
    await Promise.resolve();
  });
  await flush();
  await flush();
}

function argsInput(): HTMLInputElement {
  return byText("label.field", "create.extraArgs").querySelector("input") as HTMLInputElement;
}

function agentSelect(): HTMLSelectElement {
  return byText("label.field", "create.agent").querySelector("select") as HTMLSelectElement;
}

async function saveComposer(): Promise<TemplateSession> {
  await click(container.querySelector(".modal-actions button.primary"));
  expect(writeCalls).toHaveLength(1);
  return writeCalls[0]!.tpl.sessions[0]!;
}

test("a captured --agent/--model prefix opens as picker values, the rest of args stays, and default drops the old flag", async () => {
  await openComposerOn([
    {
      name: "a",
      role: "developer",
      color: "#112233",
      bridge: "clodex",
      clodexContextTokens: 300_000,
      args: '--agent "reviewer" --model "gpt-5" --add-dir "x"'
    }
  ]);
  expect(agentSelect().value).toBe("reviewer");
  expect(agentSelect().disabled).toBe(false);
  expect(argsInput().value).toBe('--add-dir "x"');
  expect(container.querySelector(".mp-current .mp-model-name")?.textContent).toBe("GPT-5");
  expect(container.querySelector(".mp-current")!.hasAttribute("disabled")).toBe(false);
  await click(container.querySelector(".mp-current"));
  await click(Array.from(container.querySelectorAll(".mp-panel .mp-model")).find((r) => r.textContent === "create.modelDefault"));
  const saved = await saveComposer();
  expect(saved).toMatchObject({
    name: "a",
    agent: "reviewer",
    role: "developer",
    color: "#112233",
    args: '--add-dir "x"'
  });
  expect(saved.model).toBeUndefined();
  expect(saved.bridge).toBeUndefined();
  expect(JSON.stringify(saved)).not.toContain("--model");
});

test("a captured [1m] model in args opens as the base model with extended context on", async () => {
  await openComposerOn([{ name: "a", args: '--model "opus[1m]" --add-dir "x"' }]);
  expect(container.querySelector(".mp-current .mp-model-name")?.textContent).toBe("Opus");
  expect(extendedBox().checked).toBe(true);
  expect(argsInput().value).toBe('--add-dir "x"');
  const saved = await saveComposer();
  expect(saved.model).toBe("opus[1m]");
});

test("an ambiguous flag stays in args, locks only the control it names, and unlocks once the operator removes it", async () => {
  await openComposerOn([{ name: "a", args: "--model=opus --add-dir x" }]);
  expect(argsInput().value).toBe("--model=opus --add-dir x");
  const modelButton = container.querySelector(".mp-current") as HTMLButtonElement;
  expect(modelButton.disabled).toBe(true);
  expect(modelButton.textContent).toBe("composer.definedInArgsShort");
  expect(agentSelect().disabled).toBe(false);
  expect(extendedBox().disabled).toBe(true);

  act(() => setValue(argsInput(), "--add-dir x", "input"));
  expect((container.querySelector(".mp-current") as HTMLButtonElement).disabled).toBe(false);
});

test("an agent flag in args locks the agent select and a later edit of args frees it", async () => {
  await openComposerOn([{ name: "a", args: "-p --agent reviewer" }]);
  expect(agentSelect().disabled).toBe(true);
  expect(argsInput().value).toBe("-p --agent reviewer");
  act(() => setValue(argsInput(), "-p", "input"));
  expect(agentSelect().disabled).toBe(false);
});

test("a --model typed into args after opening locks the picker at once, and removing it frees it again", async () => {
  await openComposerOn([{ name: "a", model: "opus", args: "--add-dir x" }]);
  const isLocked = (): boolean => (container.querySelector(".mp-current") as HTMLButtonElement).disabled;
  expect(isLocked()).toBe(false);

  act(() => setValue(argsInput(), '--model "haiku" --add-dir x', "input"));
  expect(isLocked()).toBe(true);
  expect(argsInput().value).toBe('--model "haiku" --add-dir x');

  act(() => setValue(argsInput(), "--add-dir x", "input"));
  expect(isLocked()).toBe(false);
  expect(container.querySelector(".mp-current .mp-model-name")?.textContent).toBe("Opus");
});

// ----- create popover -----

async function mountCreate(): Promise<void> {
  await act(async () => {
    root.render(React.createElement(CreateMenu, { onClose: noop }));
    await Promise.resolve();
  });
  await flush();
}

test("create popover and template card turn the same clodex choice into the same fields", async () => {
  await mountCreate();
  expect(contextNumber()).toBeNull();
  await chooseModel("OpenAI", "GPT-5");
  act(() => setValue(contextNumber()!, "350", "input"));
  await click(container.querySelector(".modal-actions .primary"));
  expect(created).toHaveLength(1);
  const fromCreate = created[0]!;

  act(() => root.unmount());
  root = createRoot(container);
  await mountCard({ name: "dev" });
  await chooseModel("OpenAI", "GPT-5");
  act(() => setValue(contextNumber()!, "350", "input"));
  expect({ model: latest.model, bridge: latest.bridge, clodexContextTokens: latest.clodexContextTokens }).toEqual({
    model: fromCreate.model as string,
    bridge: fromCreate.bridge as "clodex",
    clodexContextTokens: fromCreate.clodexContextTokens as number
  });
  expect(fromCreate.clodexContextTokens).toBe(350_000);
});

test("create popover sends the explicit 200000 default for a clodex pick left untouched, and nothing for others", async () => {
  await mountCreate();
  await chooseModel("OpenAI", "GPT-5");
  await click(container.querySelector(".modal-actions .primary"));
  expect(created[0]!.clodexContextTokens).toBe(200_000);

  created = [];
  act(() => root.unmount());
  root = createRoot(container);
  await mountCreate();
  await chooseModel("Anthropic", "Opus");
  await click(container.querySelector(".modal-actions .primary"));
  expect(created[0]!.model).toBe("opus");
  expect("clodexContextTokens" in created[0]! && created[0]!.clodexContextTokens !== undefined).toBe(false);
  expect(created[0]!.bridge).toBeUndefined();
});

test("create popover: picking a colour then auto sends no colour", async () => {
  await mountCreate();
  expect(container.querySelector(".create-name-row .chip") === null).toBe(true);
  act(() => setValue(container.querySelector("input[type=color]") as HTMLInputElement, "#aa0000", "input"));
  await click(container.querySelector(".create-name-row .chip"));
  expect(container.querySelector(".create-name-row .chip") === null, "auto button still shown").toBe(true);
  await click(container.querySelector(".modal-actions .primary"));
  expect(created[0]!.color).toBeUndefined();
});

test("create popover disables Create on an invalid Context Size and spawns nothing", async () => {
  await mountCreate();
  await chooseModel("OpenAI", "GPT-5");
  act(() => setValue(contextNumber()!, "199", "input"));
  const create = container.querySelector(".modal-actions .primary") as HTMLButtonElement;
  expect(create.disabled).toBe(true);
  await click(create);
  expect(created).toHaveLength(0);
});

// ----- templates dialog, edit intent -----

test("Edit intent: choosing a template opens its composer, applies nothing, and offers no Use or Apply", async () => {
  fakeUseDeck.setState({
    templatesEdit: true,
    templates: [{ path: "/t/team.json", name: "team", source: "global", sessionCount: 1 }],
    sessions: [{ id: "s1" }]
  });
  await act(async () => {
    root.render(React.createElement(TemplatesDialog));
    await Promise.resolve();
  });
  expect(container.querySelector(".btn-use")).toBeNull();
  expect(container.querySelector(".btn-apply")).toBeNull();
  await click(container.querySelector(".template-row"));
  await flush();
  expect(container.querySelector(".tc-modal")).not.toBeNull();
  expect(readCalls).toEqual(["/t/team.json"]);
  expect(applied).toEqual([]);
});

test("Edit intent with no template offers New template, which opens a blank composer, and no Manage button", async () => {
  fakeUseDeck.setState({ templatesEdit: true, templates: [] });
  await act(async () => {
    root.render(React.createElement(TemplatesDialog));
    await Promise.resolve();
  });
  expect(container.querySelector(".confirm-msg")?.textContent).toBe("template.editEmpty");
  const labels = Array.from(container.querySelectorAll(".template-actions button")).map((b) => b.textContent);
  expect(labels).toContain("composer.new");
  expect(labels).not.toContain("template.manage");
  expect(labels).not.toContain("template.use");
  await click(byText(".template-actions button", "composer.new"));
  await flush();
  expect(container.querySelector(".tc-modal")).not.toBeNull();
  expect(readCalls).toEqual([]);
});

test("Use intent: choosing a template only selects it, no composer opens", async () => {
  fakeUseDeck.setState({
    templates: [{ path: "/t/team.json", name: "team", source: "global", sessionCount: 1 }]
  });
  await act(async () => {
    root.render(React.createElement(TemplatesDialog));
    await Promise.resolve();
  });
  await click(container.querySelector(".template-row"));
  expect(container.querySelector(".tc-modal")).toBeNull();
  expect((container.querySelector(".btn-use") as HTMLButtonElement).disabled).toBe(false);
});

test("a template row answers the keyboard like a click", async () => {
  fakeUseDeck.setState({
    templatesEdit: true,
    templates: [{ path: "/t/team.json", name: "team", source: "global", sessionCount: 1 }]
  });
  await act(async () => {
    root.render(React.createElement(TemplatesDialog));
    await Promise.resolve();
  });
  const row = container.querySelector(".template-row") as HTMLElement;
  expect(row.tabIndex).toBe(0);
  await act(async () => {
    row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await Promise.resolve();
  });
  await flush();
  expect(container.querySelector(".tc-modal")).not.toBeNull();
});
