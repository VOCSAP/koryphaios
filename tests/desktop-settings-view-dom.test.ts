import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Root } from "../desktop/tests-support/react-test-harness";
import { mockStore, storeMockStubs } from "./_store-mock";
import type { AppConfig, SessionSkillSettings } from "../desktop/src/shared/types.ts";
import { DEFAULT_CONFIG } from "../desktop/src/main/store-defaults.ts";

const { act, React, createRoot, create } = await import("../desktop/tests-support/react-test-harness");

for (const name of ["models", "palette", "spawn-cap-limits", "link-policy", "graph", "ttsr-types", "broker-panel"]) {
  const real = await import(`../desktop/src/shared/${name}.ts`);
  mock.module(`@shared/${name}`, () => real);
}

interface FakeDeckState {
  config: AppConfig;
  dict: Record<string, string>;
  availableLocales: string[];
  pickContextPrompt: boolean;
  updateConfig: (patch: Partial<AppConfig>) => Promise<void>;
  openSettings: () => void;
  setPickContextPrompt: (value: boolean) => void;
}

let updateConfigCalls: Array<Partial<AppConfig>> = [];
let reportedErrors: Array<[string, string]> = [];
type ModOffer = string | { name: string; globallyActive: boolean };

let listModsImpl: () => Promise<ModOffer[]> = () => Promise.resolve([]);
const KORY_STORAGE = { mode: "kory", instructions: "" } as const;
const NO_SKILLS: SessionSkillSettings = { version: 2, addendum: { start: "", end: "", stop: "" }, storage: KORY_STORAGE };
let getSkillsImpl: () => Promise<SessionSkillSettings> = () => Promise.resolve(NO_SKILLS);
let setSkillsImpl: (value: SessionSkillSettings) => Promise<SessionSkillSettings> = (value) => Promise.resolve(value);
let setSkillsCalls: SessionSkillSettings[] = [];

function deckState(enabledMods: unknown): FakeDeckState {
  return {
    config: { ...DEFAULT_CONFIG, enabledMods: enabledMods as AppConfig["enabledMods"] },
    dict: {},
    availableLocales: [],
    pickContextPrompt: true,
    updateConfig: (patch) => {
      updateConfigCalls.push(patch);
      return Promise.resolve();
    },
    openSettings: () => {},
    setPickContextPrompt: () => {},
  };
}

const fakeUseDeck = create<FakeDeckState>(() => deckState(DEFAULT_CONFIG.enabledMods));
mockStore({ useDeck: fakeUseDeck, ...storeMockStubs });

const rendererDep = join(resolve(import.meta.dir, ".."), "desktop", "node_modules", "qrcode-generator");
if (!existsSync(rendererDep)) throw new Error(`SettingsView imports NotificationChannels, which needs ${rendererDep}: run npm install in desktop/ first`);

const { SettingsView } = await import("../desktop/src/renderer/src/components/SettingsView.tsx");

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  updateConfigCalls = [];
  reportedErrors = [];
  listModsImpl = () => Promise.resolve([]);
  getSkillsImpl = () => Promise.resolve(NO_SKILLS);
  setSkillsImpl = (value) => Promise.resolve(value);
  setSkillsCalls = [];
  (globalThis as unknown as { window: { api: Record<string, unknown> } }).window.api = {
    listMods: () => listModsImpl(),
    getSessionSkills: () => getSkillsImpl(),
    setSessionSkills: (value: SessionSkillSettings) => {
      setSkillsCalls.push(value);
      return setSkillsImpl(value);
    },
    getLaunchConfig: () => Promise.resolve({ launchCommand: "", presets: [], models: [], worktreeInit: undefined }),
    modelCatalogs: () => Promise.resolve([]),
    onModelsChanged: () => () => {},
    approvalChannels: () => Promise.resolve([]),
    reportError: (scope: string, msg: string) => {
      reportedErrors.push([scope, msg]);
    },
  };
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

async function mount(enabledMods: unknown, offered: ModOffer[]): Promise<void> {
  fakeUseDeck.setState(deckState(enabledMods), true);
  listModsImpl = () => Promise.resolve(offered.map((mod) => typeof mod === "string" ? { name: mod, globallyActive: false } : mod));
  await act(async () => {
    root.render(React.createElement(SettingsView));
    await Promise.resolve();
    await Promise.resolve();
  });
}

function modCheckbox(name: string): HTMLInputElement | undefined {
  const label = [...container.querySelectorAll("label.field-check")].find((l) => l.textContent === name);
  return label?.querySelector("input[type=checkbox]") as HTMLInputElement | undefined;
}

async function click(box: HTMLInputElement): Promise<void> {
  await act(async () => {
    box.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
}

test("terminal copy normalization is enabled by default and can be disabled", async () => {
  await mount(DEFAULT_CONFIG.enabledMods, []);
  const checkbox = modCheckbox("settings.normalizeTerminalCopy");

  expect(checkbox, "the copy normalization switch must be visible").not.toBeUndefined();
  expect(checkbox!.checked).toBe(true);
  await click(checkbox!);
  expect(updateConfigCalls).toEqual([{ normalizeTerminalCopy: false }]);
});

test("with the default configuration every offered mod is shown unchecked", async () => {
  await mount(DEFAULT_CONFIG.enabledMods, ["alpha", "beta"]);
  expect(modCheckbox("alpha"), "alpha must be offered as a switch").not.toBeUndefined();
  expect(modCheckbox("alpha")!.checked, "no mod may read as enabled without an operator gesture").toBe(false);
  expect(modCheckbox("beta")!.checked, "no mod may read as enabled without an operator gesture").toBe(false);
});

test("a globally active mod disables only its activation switch", async () => {
  await mount({}, [
    { name: "prosopon", globallyActive: true },
    { name: "mitos", globallyActive: false }
  ]);

  const globallyActive = modCheckbox("prosopon");
  const deckManaged = modCheckbox("mitos");
  expect(globallyActive, "the globally active mod must remain identifiable in settings").not.toBeUndefined();
  expect(globallyActive!.disabled, "a global plugin must own its activation state").toBe(true);
  expect(globallyActive!.title).toBe("settings.enabledModGlobalHelp");
  expect(deckManaged!.disabled, "an inactive global plugin remains controlled by the Deck").toBe(false);
});

test("a mod stored as true reads as checked and its neighbour stays unchecked", async () => {
  await mount({ alpha: true }, ["alpha", "beta"]);
  expect(modCheckbox("alpha")!.checked, "the stored true of alpha must show as on").toBe(true);
  expect(modCheckbox("beta")!.checked, "beta has no stored value and must show as off").toBe(false);
});

test("truthy non-boolean values never read as checked", async () => {
  await mount({ alpha: "true", beta: 1, gamma: {}, delta: [true] }, ["alpha", "beta", "gamma", "delta"]);
  for (const name of ["alpha", "beta", "gamma", "delta"]) {
    expect(modCheckbox(name)!.checked, `${name} holds a truthy value that is not the boolean true`).toBe(false);
  }
});

test("a stored mod absent from the offered list is not rendered", async () => {
  await mount({ alpha: true, ghost: true }, ["alpha"]);
  expect(modCheckbox("ghost"), "a name outside the lock must not become a switch").toBeUndefined();
  expect(modCheckbox("alpha")!.checked).toBe(true);
});

test.each([
  ["null", null],
  ["undefined", undefined],
  ["a string", "alpha"],
  ["an array", [true]],
  ["a number", 7],
] as Array<[string, unknown]>)("enabledMods holding %s renders every offered mod unchecked", async (_label, hostile) => {
  await mount(hostile, ["alpha", "beta"]);
  expect(modCheckbox("alpha")?.checked, `enabledMods=${JSON.stringify(hostile)} must still render alpha as off`).toBe(false);
  expect(modCheckbox("beta")?.checked, `enabledMods=${JSON.stringify(hostile)} must still render beta as off`).toBe(false);
});

test.each([
  ["enabling alpha", "alpha", { alpha: false, beta: false, gamma: true, ghost: true }],
  ["disabling gamma", "gamma", { alpha: false, beta: true, gamma: true, ghost: true }],
] as Array<[string, string, Record<string, boolean>]>)(
  "%s writes enabledMods once and changes only that entry",
  async (_label, clicked, before) => {
    await mount(before, ["alpha", "beta", "gamma"]);
    await click(modCheckbox(clicked)!);
    expect(updateConfigCalls.length, "one click is one config write").toBe(1);
    expect(
      updateConfigCalls[0],
      `the write must keep every other entry and flip only ${clicked}`
    ).toEqual({ enabledMods: { ...before, [clicked]: !before[clicked] } });
  }
);

test.each([
  ["a string", "abc"],
  ["null", null],
  ["an array", [true, false]],
] as Array<[string, unknown]>)("a click over an enabledMods holding %s writes a record carrying only the clicked entry", async (_label, hostile) => {
  await mount(hostile, ["alpha"]);
  await click(modCheckbox("alpha")!);
  expect(updateConfigCalls, `the corrupt value ${JSON.stringify(hostile)} must not be spread into the written record`).toEqual([
    { enabledMods: { alpha: true } },
  ]);
});

interface DeferredWrite {
  patch: Partial<AppConfig>;
  apply: () => void;
  refuse: () => void;
}

async function deferConfigWrites(): Promise<DeferredWrite[]> {
  const writes: DeferredWrite[] = [];
  await act(async () => {
    fakeUseDeck.setState({
      updateConfig: (patch) =>
        new Promise<void>((resolve) => {
          writes.push({
            patch,
            apply: () => {
              fakeUseDeck.setState((state) => ({ config: { ...state.config, ...patch } }));
              resolve();
            },
            refuse: () => resolve(),
          });
        }),
    });
  });
  return writes;
}

async function settle(...actions: Array<() => void>): Promise<void> {
  await act(async () => {
    for (const action of actions) action();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function changeStoredMods(enabledMods: Record<string, boolean>): Promise<void> {
  await act(async () => {
    fakeUseDeck.setState((state) => ({ config: { ...state.config, enabledMods } }));
  });
}

test("two clicks made while the first config write is still unresolved both survive in the stored config", async () => {
  await mount({}, ["alpha", "beta"]);
  const writes = await deferConfigWrites();
  await click(modCheckbox("alpha")!);
  await click(modCheckbox("beta")!);
  expect(writes.length, "each click is one config write").toBe(2);
  await settle(...writes.map((write) => write.apply));
  expect(
    fakeUseDeck.getState().config.enabledMods,
    "the second write was computed from the config captured at render, so it overwrote the first choice"
  ).toEqual({ alpha: true, beta: true });
});

test("a click made after the first of two pending config writes settled still carries the second choice", async () => {
  await mount({}, ["alpha", "beta", "gamma"]);
  const writes = await deferConfigWrites();
  await click(modCheckbox("alpha")!);
  await click(modCheckbox("beta")!);
  await settle(writes[0]!.apply);
  await click(modCheckbox("gamma")!);
  await settle(...writes.slice(1).map((write) => write.apply));
  expect(
    fakeUseDeck.getState().config.enabledMods,
    "the config echo of the first write reset the requested choices, so the third write dropped the second"
  ).toEqual({ alpha: true, beta: true, gamma: true });
});

test("a config change made elsewhere after a settled write is carried by the next write", async () => {
  await mount({}, ["alpha", "beta", "gamma"]);
  const writes = await deferConfigWrites();
  await click(modCheckbox("alpha")!);
  await settle(writes[0]!.apply);
  await changeStoredMods({ alpha: true, beta: true });
  await click(modCheckbox("gamma")!);
  expect(
    writes[1]?.patch,
    "the requested choices must follow the stored config once no write is in flight, or a change made elsewhere is overwritten"
  ).toEqual({ enabledMods: { alpha: true, beta: true, gamma: true } });
});

test("a write that settles without changing the stored config leaves no hidden choice for the next click", async () => {
  await mount({}, ["alpha", "beta"]);
  const writes = await deferConfigWrites();
  await click(modCheckbox("alpha")!);
  await settle(writes[0]!.refuse);
  expect(modCheckbox("alpha")!.checked, "the refused choice is not shown as on").toBe(false);
  await click(modCheckbox("beta")!);
  expect(
    writes[1]?.patch,
    "the refused alpha is invisible on screen, so the next write must carry the visible state plus its own choice only"
  ).toEqual({ enabledMods: { beta: true } });
});

test("a write that settles after the stored config changed elsewhere resumes from the stored config", async () => {
  await mount({}, ["alpha", "beta"]);
  const writes = await deferConfigWrites();
  await click(modCheckbox("alpha")!);
  await changeStoredMods({ gamma: true });
  await settle(writes[0]!.refuse);
  await click(modCheckbox("beta")!);
  expect(
    writes[1]?.patch,
    "the choices to send must be re-read from the stored config at settlement, not from the render the click was made in"
  ).toEqual({ enabledMods: { gamma: true, beta: true } });
});

test("no mod section is rendered when the lock offers nothing", async () => {
  await mount({ alpha: true }, []);
  expect(container.textContent).not.toContain("settings.enabledMods");
  expect(modCheckbox("alpha")).toBeUndefined();
});

test("a failing mods:list leaves the page rendered with no mod switch and traces the failure", async () => {
  fakeUseDeck.setState(deckState({}), true);
  listModsImpl = () => Promise.reject(new Error("lock unreadable"));
  await act(async () => {
    root.render(React.createElement(SettingsView));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(container.textContent).not.toContain("settings.enabledMods");
  expect(container.querySelector("input[type=checkbox]"), "the rest of the General page must still render").not.toBeNull();
  expect(
    reportedErrors.filter(([scope, message]) => scope === "settings" && message.includes("lock unreadable")),
    "a rejected mods:list is a failure shown to nobody unless it is traced with its cause in the settings scope"
  ).toHaveLength(1);
  expect(reportedErrors, "no other call of the page may report an error on this mount").toHaveLength(1);
});

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
  });
}

async function openSkills(): Promise<HTMLElement> {
  await mount({}, []);
  const item = [...container.querySelectorAll(".settings-tree-item")].find((b) => b.textContent === "settings.catSkills");
  expect(item, "Settings must offer a Skills category").not.toBeUndefined();
  await act(async () => {
    (item as HTMLButtonElement).click();
  });
  await flush();
  return container.querySelector(".settings-panel") as HTMLElement;
}

function skillsRoot(panel: HTMLElement): HTMLElement {
  return panel.querySelector(".skills-settings") as HTMLElement;
}

function momentArea(panel: HTMLElement, command: string): HTMLTextAreaElement | undefined {
  const section = [...panel.querySelectorAll("section")].find(
    (s) => s.querySelector("code")?.textContent === command
  );
  return section?.querySelector("textarea") ?? undefined;
}

async function typeInto(area: HTMLTextAreaElement, text: string): Promise<void> {
  const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  if (!nativeSetter) throw new Error("textarea has no native value setter");
  await act(async () => {
    nativeSetter.call(area, text);
    area.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function clickSave(panel: HTMLElement): Promise<void> {
  const save = panel.querySelector(".skills-actions button") as HTMLButtonElement | null;
  expect(save, "the Skills page must offer a save button").not.toBeNull();
  await act(async () => {
    save!.click();
  });
  await flush();
}

const MOMENT_COMMANDS = ["/kory-session-start", "/kory-session-end", "/kory-session-stop"] as const;

test("a skills file that cannot be read stays an invalid state with no field to type into", async () => {
  getSkillsImpl = () => Promise.reject(new Error("session-skills.json: unexpected token at line 3"));
  const panel = await openSkills();

  expect(skillsRoot(panel).dataset.state, "an unreadable file must be shown as invalid, not as loading or empty").toBe("invalid");
  expect(panel.querySelectorAll("textarea"), "an unreadable file must not fall back to empty, editable fields").toHaveLength(0);
  expect(panel.querySelector(".skills-actions"), "no save may be offered over a file nobody could read").toBeNull();
  expect(panel.querySelector("[role=alert]")?.textContent, "the cause must be visible to the operator").toContain(
    "unexpected token at line 3"
  );
  expect(
    reportedErrors.filter(([scope, message]) => scope === "settings" && message.includes("unexpected token at line 3")),
    "the failed read must be traced with its cause"
  ).toHaveLength(1);

  getSkillsImpl = () => Promise.resolve({ version: 2, addendum: { start: "S", end: "", stop: "" }, storage: KORY_STORAGE });
  const retry = panel.querySelector(".skills-invalid button") as HTMLButtonElement;
  await act(async () => {
    retry.click();
  });
  await flush();
  expect(skillsRoot(panel).dataset.state, "a retry that reads the file must leave the invalid state").not.toBe("invalid");
  expect(momentArea(panel, "/kory-session-start")?.value).toBe("S");
});

test("a refused save keeps the typed text and shows the refusal as an error state", async () => {
  setSkillsImpl = () => Promise.reject(new Error("addendum.stop exceeds 16 KiB"));
  const panel = await openSkills();
  await typeInto(momentArea(panel, "/kory-session-stop")!, "hand the roster over");
  await clickSave(panel);

  expect(setSkillsCalls, "one click is one write").toHaveLength(1);
  expect(skillsRoot(panel).dataset.state, "a refused write must leave the page in its error state").toBe("error");
  expect(momentArea(panel, "/kory-session-stop")!.value, "the refused text must stay where the operator typed it").toBe(
    "hand the roster over"
  );
  expect(panel.querySelector("[role=alert]")?.textContent, "the refusal reason must be visible").toContain(
    "addendum.stop exceeds 16 KiB"
  );
  expect(panel.textContent, "a refused write must never read as saved").not.toContain("skills.saved");
  expect(
    (panel.querySelector(".skills-actions button") as HTMLButtonElement).disabled,
    "the operator must be able to retry the save"
  ).toBe(false);
  expect(
    reportedErrors.filter(([scope, message]) => scope === "settings" && message.includes("exceeds 16 KiB")),
    "the refused write must be traced with its cause"
  ).toHaveLength(1);
});

test("each moment shows its own stored text and saves into its own field", async () => {
  getSkillsImpl = () => Promise.resolve({ version: 2, addendum: { start: "S0", end: "E0", stop: "P0" }, storage: KORY_STORAGE });
  const panel = await openSkills();

  expect(MOMENT_COMMANDS.map((c) => momentArea(panel, c)?.value), "each field must be seeded from its own moment").toEqual([
    "S0",
    "E0",
    "P0",
  ]);
  expect(panel.querySelectorAll("textarea"), "one text area per moment, no command editor").toHaveLength(3);
  expect(
    panel.querySelectorAll("input:not([type=radio])"),
    "no command input, hidden or disabled, may be offered while no command is ever typed"
  ).toHaveLength(0);

  await typeInto(momentArea(panel, "/kory-session-start")!, "S1");
  await typeInto(momentArea(panel, "/kory-session-end")!, "E1");
  await typeInto(momentArea(panel, "/kory-session-stop")!, "P1");
  expect(skillsRoot(panel).dataset.state).toBe("dirty");
  await clickSave(panel);

  expect(setSkillsCalls, "each moment's text must land in its own field of the one document").toEqual([
    { version: 2, addendum: { start: "S1", end: "E1", stop: "P1" }, storage: KORY_STORAGE },
  ]);
  expect(skillsRoot(panel).dataset.state, "an accepted write must show the saved state").toBe("saved");
  expect(panel.querySelector("[role=status]")?.textContent).toContain("skills.saved");
});

test("the Skills page states its global scope, warns against secrets and marks an empty document", async () => {
  const panel = await openSkills();
  const text = panel.textContent ?? "";
  expect(text, "the scope must be stated as global to the Deck").toContain("skills.scope");
  expect(text, "the operator must be told the text enters the conversation").toContain("skills.secretTitle");
  expect(text, "an empty document must say the skills run their native protocol alone").toContain("skills.empty");
  expect(
    (panel.querySelector(".skills-actions button") as HTMLButtonElement).disabled,
    "nothing to save until the operator types"
  ).toBe(true);
  expect(storageRadio(panel, "kory").checked, "a document with Kory storage must show Kory chosen").toBe(true);
  expect(storageArea(panel), "Kory storage offers no instructions to type").toBeUndefined();
});

function storageRadio(panel: HTMLElement, mode: "kory" | "custom"): HTMLInputElement {
  const radio = panel.querySelector(`[role=radiogroup] input[type=radio][value=${mode}]`) as HTMLInputElement | null;
  expect(radio, `the handoff storage choice must offer ${mode}`).not.toBeNull();
  return radio!;
}

function storageArea(panel: HTMLElement): HTMLTextAreaElement | undefined {
  return panel.querySelector("[role=radiogroup]")?.closest("section")?.querySelector("textarea") ?? undefined;
}

async function choose(radio: HTMLInputElement): Promise<void> {
  await act(async () => {
    radio.click();
  });
}

test("custom handoff storage with blank instructions cannot be saved and says why", async () => {
  const panel = await openSkills();
  await choose(storageRadio(panel, "custom"));
  const save = panel.querySelector(".skills-actions button") as HTMLButtonElement;

  expect(storageArea(panel), "choosing custom storage must offer the instructions field").not.toBeUndefined();
  expect(save.disabled, "custom storage with no instructions must not be savable").toBe(true);
  expect(panel.querySelector(".skills-actions")?.textContent, "the refusal must say why").toContain("skills.storageEmpty");

  await typeInto(storageArea(panel)!, "   \n ");
  expect(save.disabled, "whitespace is not instructions").toBe(true);
  await clickSave(panel);
  expect(setSkillsCalls, "no write may leave for a custom storage nobody described").toHaveLength(0);

  await typeInto(storageArea(panel)!, "kleos-cli handoff dump --content <handoff>");
  expect(save.disabled, "described custom storage must become savable").toBe(false);
  await clickSave(panel);
  expect(setSkillsCalls.map((v) => v.storage)).toEqual([
    { mode: "custom", instructions: "kleos-cli handoff dump --content <handoff>" },
  ]);
});

// 5461 three-byte characters plus one ASCII byte: exactly 16384 UTF-8 bytes for 5462 characters.
const AT_LIMIT = "€".repeat(5461) + "a";
const OVER_LIMIT = AT_LIMIT + "é";

test("every skills text is accepted at exactly 16 KiB of UTF-8 and refused two bytes over, naming the field", async () => {
  expect(new TextEncoder().encode(AT_LIMIT).length).toBe(16384);
  expect(new TextEncoder().encode(OVER_LIMIT).length).toBe(16386);
  const panel = await openSkills();
  await act(async () => {
    fakeUseDeck.setState({ dict: { "skills.tooLarge": "TOO:{limit}:{fields}" } });
  });
  await choose(storageRadio(panel, "custom"));
  await typeInto(storageArea(panel)!, "kleos-cli handoff dump");
  const save = panel.querySelector(".skills-actions button") as HTMLButtonElement;
  const status = (): string => panel.querySelector(".skills-actions .skills-status")?.textContent ?? "";
  const fields: Array<[string, () => HTMLTextAreaElement, string]> = [
    ["skills.storageTitle", () => storageArea(panel)!, "kleos-cli handoff dump"],
    ...MOMENT_COMMANDS.map((c, i): [string, () => HTMLTextAreaElement, string] => [
      ["skills.startTitle", "skills.endTitle", "skills.stopTitle"][i]!,
      () => momentArea(panel, c)!,
      "",
    ]),
  ];

  for (const [title, area, rest] of fields) {
    await typeInto(area(), AT_LIMIT);
    expect(save.disabled, `${title}: exactly 16 KiB is within the limit main accepts`).toBe(false);
    expect(status(), `${title}: no size refusal at the limit`).not.toContain("TOO:");

    await typeInto(area(), OVER_LIMIT);
    expect(save.disabled, `${title}: two bytes over the limit main refuses must not be savable`).toBe(true);
    expect(status(), `${title}: the refusal must name the field and the limit`).toBe(`TOO:16:${title}`);
    expect(area().getAttribute("aria-invalid"), `${title}: the oversized field must be marked invalid`).toBe("true");
    await clickSave(panel);
    expect(setSkillsCalls, `${title}: no write may leave over the limit`).toHaveLength(0);
    await typeInto(area(), rest);
  }

  await typeInto(storageArea(panel)!, OVER_LIMIT);
  await typeInto(momentArea(panel, "/kory-session-end")!, OVER_LIMIT);
  expect(status(), "every oversized field must be named").toBe("TOO:16:skills.storageTitle, skills.endTitle");

  await typeInto(storageArea(panel)!, AT_LIMIT);
  await typeInto(momentArea(panel, "/kory-session-end")!, "");
  await clickSave(panel);
  expect(setSkillsCalls.map((v) => v.storage.instructions), "a text at the limit must leave as typed").toEqual([AT_LIMIT]);
});

test("switching the handoff storage back to Kory is a change the save keeps, with the typed text", async () => {
  const custom = { mode: "custom", instructions: "kleos-cli handoff latest" } as const;
  getSkillsImpl = () => Promise.resolve({ version: 2, addendum: { start: "S0", end: "", stop: "" }, storage: custom });
  const panel = await openSkills();

  expect(storageRadio(panel, "custom").checked, "the stored custom mode must be shown chosen").toBe(true);
  expect(storageArea(panel)?.value).toBe("kleos-cli handoff latest");

  await choose(storageRadio(panel, "kory"));
  expect(skillsRoot(panel).dataset.state, "a mode switch alone must count as a change").toBe("dirty");
  expect(storageArea(panel), "Kory storage hides the instructions field").toBeUndefined();
  await clickSave(panel);

  expect(setSkillsCalls, "the switch must reach the one document, the addendum untouched").toEqual([
    {
      version: 2,
      addendum: { start: "S0", end: "", stop: "" },
      storage: { mode: "kory", instructions: "kleos-cli handoff latest" },
    },
  ]);
  expect(skillsRoot(panel).dataset.state).toBe("saved");
  expect(storageRadio(panel, "kory").checked, "the saved mode must stay chosen after the write").toBe(true);

  await choose(storageRadio(panel, "custom"));
  expect(storageArea(panel)?.value, "the text typed for custom storage must survive a round trip through Kory").toBe(
    "kleos-cli handoff latest"
  );
});
