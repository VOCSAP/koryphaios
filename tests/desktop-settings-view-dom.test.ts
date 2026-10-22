import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { Root } from "../desktop/tests-support/react-test-harness";
import { mockStore, storeMockStubs } from "./_store-mock";
import type { AppConfig } from "../desktop/src/shared/types.ts";
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
let listModsImpl: () => Promise<string[]> = () => Promise.resolve([]);

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

const { SettingsView } = await import("../desktop/src/renderer/src/components/SettingsView.tsx");

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  updateConfigCalls = [];
  reportedErrors = [];
  listModsImpl = () => Promise.resolve([]);
  (globalThis as unknown as { window: { api: Record<string, unknown> } }).window.api = {
    listMods: () => listModsImpl(),
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

async function mount(enabledMods: unknown, offered: string[]): Promise<void> {
  fakeUseDeck.setState(deckState(enabledMods), true);
  listModsImpl = () => Promise.resolve(offered);
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

test("with the default configuration every offered mod is shown unchecked", async () => {
  await mount(DEFAULT_CONFIG.enabledMods, ["alpha", "beta"]);
  expect(modCheckbox("alpha"), "alpha must be offered as a switch").not.toBeUndefined();
  expect(modCheckbox("alpha")!.checked, "no mod may read as enabled without an operator gesture").toBe(false);
  expect(modCheckbox("beta")!.checked, "no mod may read as enabled without an operator gesture").toBe(false);
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
