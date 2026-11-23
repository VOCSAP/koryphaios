import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import type { Root } from "../desktop/tests-support/react-test-harness";
import { mockStore, storeMockStubs } from "./_store-mock";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const { act, React, createRoot, create } = await import("../desktop/tests-support/react-test-harness");

interface View {
  tileId: string;
  moment: "start" | "end" | "stop";
  mode?: "soft" | "hard";
  step: number;
  total: number;
  phase: "running" | "waiting-background" | "done" | "stopped";
  background: number | null;
  reason: string | null;
  spawnGeneration: number;
}

interface FakeState {
  sessionSequences: Record<string, View>;
  sequenceActionsInFlight: Record<string, boolean>;
  remote: boolean;
  dict: Record<string, string>;
  cancelSequence: (id: string) => Promise<void>;
  overrideSequence: (id: string) => Promise<void>;
  dismissSequence: (id: string) => void;
}

let calls: string[];

const DICT = {
  "tile.seqMoment.start": "START",
  "tile.seqMoment.end": "END",
  "tile.seqMoment.stopSoft": "STOP-SOFT",
  "tile.seqMoment.stopHard": "STOP-HARD",
  "tile.seqDoneOne": "done one",
  "tile.seqRunning": "{moment} {step}/{total}",
  "tile.seqWaiting": "waits ({count})",
  "tile.seqWaitingNoCount": "waits",
  "tile.seqDone": "done {total}",
  "tile.seqStopped": "stopped {step}/{total}: {family}"
};

function initial(): FakeState {
  return {
    sessionSequences: {},
    sequenceActionsInFlight: {},
    remote: false,
    dict: DICT,
    cancelSequence: async (id) => void calls.push(`cancel:${id}`),
    overrideSequence: async (id) => void calls.push(`override:${id}`),
    dismissSequence: (id) => void calls.push(`dismiss:${id}`)
  };
}

const fakeUseDeck = create<FakeState>(() => initial());
mockStore({ useDeck: fakeUseDeck, ...storeMockStubs });

const { TileSequenceBanner } = await import("../desktop/src/renderer/src/components/TileSequenceBanner.tsx");

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  calls = [];
  fakeUseDeck.setState(initial(), true);
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

function view(over: Partial<View>): View {
  return { tileId: "tile-a", spawnGeneration: 1, moment: "start", step: 0, total: 4, phase: "running", background: null, reason: null, ...over };
}

async function mount(v: View | null, state: Partial<FakeState> = {}): Promise<void> {
  await act(async () => {
    fakeUseDeck.setState({ sessionSequences: v ? { [v.tileId]: v } : {}, ...state });
    root.render(React.createElement(TileSequenceBanner, { tileId: "tile-a" }));
  });
}

function banner(): HTMLElement {
  const el = container.querySelector<HTMLElement>(".tile-seq");
  if (!el) throw new Error("no banner rendered");
  return el;
}

function text(): string {
  return banner().querySelector(".tile-seq-text")?.textContent ?? "";
}

function buttons(): string[] {
  return [...banner().querySelectorAll("button")].map((b) => b.textContent ?? "");
}

async function click(label: string): Promise<void> {
  const b = [...banner().querySelectorAll("button")].find((x) => x.textContent === label);
  if (!b) throw new Error(`no "${label}" button`);
  await act(async () => {
    b.click();
  });
}

test("no view of this tile renders nothing, even when a neighbour runs one", async () => {
  await mount(view({ tileId: "tile-b" }));
  expect(container.innerHTML).toBe("");
});

test("running names the moment and the step one-based, and offers only Cancel", async () => {
  await mount(view({ step: 1, total: 4 }));
  expect(text()).toBe("START 2/4");
  expect(buttons()).toEqual(["common.cancel"]);
  await click("common.cancel");
  expect(calls).toEqual(["cancel:tile-a"]);
});

test("waiting on background tasks shows the count, Skip overrides and Cancel cancels", async () => {
  await mount(view({ phase: "waiting-background", background: 3 }));
  expect(text()).toBe("waits (3)");
  expect(banner().classList.contains("tile-seq-waiting-background")).toBe(true);
  expect(buttons()).toEqual(["tile.seqOverride", "common.cancel"]);
  await click("tile.seqOverride");
  await click("common.cancel");
  expect(calls).toEqual(["override:tile-a", "cancel:tile-a"]);
});

test("a wait with no known count says so without a number", async () => {
  await mount(view({ phase: "waiting-background", background: null }));
  expect(text()).toBe("waits");
});

test("a paired phone may cancel the wait but never skip it", async () => {
  await mount(view({ phase: "waiting-background", background: 1 }), { remote: true });
  expect(buttons()).toEqual(["common.cancel"]);
});

test("while a cancel or override is in flight both buttons are disabled", async () => {
  await mount(view({ phase: "waiting-background", background: 1 }), { sequenceActionsInFlight: { "tile-a": true } });
  for (const b of banner().querySelectorAll("button")) expect(b.disabled, b.textContent ?? "").toBe(true);
});

test("done stays until Close, which only drops this tile's view", async () => {
  await mount(view({ phase: "done", step: 4, total: 4 }));
  expect(text()).toBe("done 4");
  expect(buttons()).toEqual(["common.close"]);
  expect(banner().querySelector(".tile-seq-code")).toBeNull();
  await click("common.close");
  expect(calls).toEqual(["dismiss:tile-a"]);
});

test("a fault stops amber with its family and its raw code", async () => {
  await mount(view({ phase: "stopped", step: 0, total: 2, reason: "injection-refused-modal" }));
  expect(text()).toBe("stopped 1/2: tile.seqFamily.injectionRefused");
  expect(banner().querySelector(".tile-seq-code")?.textContent).toBe("injection-refused-modal");
  expect(banner().classList.contains("is-fault")).toBe(true);
  expect(buttons()).toEqual(["common.close"]);
});

test("an operator cancel stops neutral", async () => {
  await mount(view({ phase: "stopped", step: 1, total: 2, reason: "operator-cancelled" }));
  expect(text()).toBe("stopped 2/2: tile.seqFamily.cancelled");
  expect(banner().classList.contains("is-fault")).toBe(false);
});

test("a stop with no reason falls back to lost tracking and shows no code", async () => {
  await mount(view({ phase: "stopped", step: 0, total: 2, reason: null }));
  expect(text()).toContain("tile.seqFamily.trackingLost");
  expect(banner().querySelector(".tile-seq-code")).toBeNull();
});

for (const [moment, mode, label] of [
  ["start", undefined, "START"],
  ["end", undefined, "END"],
  ["stop", "soft", "STOP-SOFT"],
  ["stop", "hard", "STOP-HARD"]
] as const) {
  test(`a running ${moment}${mode ? ` ${mode}` : ""} sequence is named ${label}`, async () => {
    await mount(view({ moment, mode }));
    expect(text()).toBe(`${label} 1/4`);
  });
}

test("a one-step sequence finishes in the singular", async () => {
  await mount(view({ phase: "done", step: 1, total: 1 }));
  expect(text()).toBe("done one");
});

for (const locale of ["en", "fr"]) {
  test(`in ${locale}, a finished sequence states its step count once, and one step differs from many`, async () => {
    const dict = JSON.parse(readFileSync(join(import.meta.dir, `../desktop/locales/${locale}.json`), "utf-8"));
    await mount(view({ phase: "done", step: 3, total: 3 }), { dict });
    const many = text();
    expect(many.split("3").length - 1, many).toBe(1);
    await mount(view({ phase: "done", step: 1, total: 1 }), { dict });
    const one = text();
    expect(one.split("1").length - 1, one).toBe(1);
    expect(one, "one step reads like many").not.toBe(many.replace("3", "1"));
  });
}
