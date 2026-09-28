// The ids under "real statusLine ids" are the ones the Deck statusLine reports
// for live tiles; the short label is computed from the id, never the display name.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Root } from "../desktop/tests-support/react-test-harness"; // type-only: erased before bun resolves it
import { mockStore, storeMockStubs } from "./_store-mock";
import * as sharedReorder from "../desktop/src/shared/reorder.ts";
import * as sharedModels from "../desktop/src/shared/models.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const { MODEL_FAMILY_DEFAULTS, shortModelLabel } = sharedModels;

const { act, React, createRoot, create } = await import("../desktop/tests-support/react-test-harness");

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const claudeId = (family: string, version: string): string => `claude-${family}-${version.replace(/\./g, "-")}`;

describe("shortModelLabel", () => {
  test("every Claude family at its table default reads as the family alone", () => {
    for (const [family, version] of Object.entries(MODEL_FAMILY_DEFAULTS.claude)) {
      expect(shortModelLabel(claudeId(family, version), "display"), `${family} ${version} is the default`).toBe(cap(family));
      expect(shortModelLabel(`${claudeId(family, version)}[1m]`, "display"), "[1m] is not a version").toBe(cap(family));
    }
  });

  test("every clodex variant at its table default reads as the variant alone, provider dropped", () => {
    for (const [variant, version] of Object.entries(MODEL_FAMILY_DEFAULTS.clodex)) {
      expect(shortModelLabel(`clodex:openai-oauth:gpt-${version}-${variant}`, "display")).toBe(variant);
    }
  });

  test("real statusLine ids at the operator's defaults", () => {
    expect(shortModelLabel("claude-opus-5-5[1m]", "Opus 5.5 (1M context)")).toBe(cap("opus"));
    expect(shortModelLabel("claude-opus-5-5", "Opus 5.5"), "a 1M tile may report no [1m] at all").toBe(cap("opus"));
    expect(shortModelLabel("claude-sonnet-5[1m]", "Sonnet 5")).toBe(cap("sonnet"));
    expect(shortModelLabel("claude-haiku-4-5-20251001", "Haiku 4.5"), "a date suffix is not a version").toBe(cap("haiku"));
    expect(shortModelLabel("clodex:openai-oauth:gpt-5.6-sol", "clodex:openai-oauth:gpt-5.6-sol")).toBe("sol");
    expect(shortModelLabel("clodex:openai-oauth:gpt-5.6-terra", "clodex:openai-oauth:gpt-5.6-terra")).toBe("terra");
  });

  test("a version off the default keeps its number", () => {
    expect(shortModelLabel("claude-opus-4-8", "Opus 4.8")).toBe(`${cap("opus")} 4.8`);
    expect(shortModelLabel("clodex:openai-oauth:gpt-5.7-sol", "x")).toBe("sol 5.7");
  });

  test("an unknown clodex variant shows its model part, never the provider prefix", () => {
    const raw = "clodex:openai-oauth:gpt-6-astra";
    expect(shortModelLabel(raw, raw)).toBe("gpt-6-astra");
  });

  test("anything unrecognised falls back to the display name", () => {
    for (const id of [
      "",
      "claude-fable-5",
      "claude-opus",
      "clodex:openai-oauth:",
      "gemini-3-pro",
      "claude-opus-4-1@20250805x",
      "claude-opus-5-5[beta]"
    ]) {
      expect(shortModelLabel(id, "Shown As Is"), `id ${JSON.stringify(id)} must not invent a label`).toBe("Shown As Is");
    }
  });

  test("a Vertex @date suffix is not a version", () => {
    expect(shortModelLabel("claude-opus-4-1@20250805", "Claude Opus 4.1")).toBe(`${cap("opus")} 4.1`);
  });

  test("the clodex provider segment is dropped whatever the provider", () => {
    for (const [variant, version] of Object.entries(MODEL_FAMILY_DEFAULTS.clodex)) {
      expect(shortModelLabel(`clodex:synthetic-proxy:gpt-${version}-${variant}`, "display")).toBe(variant);
    }
  });
});

interface FakeDeckState {
  config: { autoResumeQuota: boolean };
  selectedId: string | null;
  maximizedId: string | null;
  dict: Record<string, string>;
  setSelected: (id: string) => void;
  setMaximized: (id: string | null) => void;
  removeSession: (id: string) => Promise<void>;
  renameSession: (id: string, name: string) => Promise<void>;
  setColor: (id: string, color: string) => Promise<void>;
  setAutoResume: (id: string, enabled: boolean) => Promise<void>;
  clearAttention: (id: string) => Promise<void>;
  showToast: (key: string) => void;
  openDiff: (id: string) => void;
}

const EN_DICT = JSON.parse(
  readFileSync(join(import.meta.dir, "../desktop/locales/en.json"), "utf8")
) as Record<string, string>;

function initialFakeState(): FakeDeckState {
  return {
    config: { autoResumeQuota: false },
    selectedId: null,
    maximizedId: null,
    dict: EN_DICT,
    setSelected: () => {},
    setMaximized: () => {},
    removeSession: async () => {},
    renameSession: async () => {},
    setColor: async () => {},
    setAutoResume: async () => {},
    clearAttention: async () => {},
    showToast: () => {},
    openDiff: () => {}
  };
}

const fakeUseDeck = create<FakeDeckState>(() => initialFakeState());
mockStore({ useDeck: fakeUseDeck, ...storeMockStubs });
mock.module("@shared/reorder", () => sharedReorder);
mock.module("@shared/models", () => sharedModels);
mock.module("../desktop/src/renderer/src/components/CreateMenu.tsx", () => ({
  CreateMenu: () => {
    throw new Error("CreateMenu stub rendered -- this file only mounts SessionRow");
  }
}));

const { SessionRow } = await import("../desktop/src/renderer/src/components/Sidebar.tsx");

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  fakeUseDeck.setState(initialFakeState(), true);
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

function renderRow(modelId: string, model: string): HTMLElement {
  const s = {
    id: "tile-a",
    name: "worker",
    cwd: "/proj",
    command: "",
    args: "",
    sessionId: "sid-1",
    color: "#fff",
    createdAt: 0,
    status: "running",
    exitCode: null,
    pid: 1,
    peerId: "peer-a",
    expired: false,
    rateLimited: false,
    resumeAt: null,
    needsAttention: false,
    claudeLaunch: true,
    liveStatus: { model, modelId, contextPct: 12, contextWindow: 1000000, at: 0 }
  };
  const dnd = { dragId: null, overId: null, onDragStart: () => {}, onDragEnter: () => {}, onDrop: () => {}, onDragEnd: () => {} };
  act(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- fake fixture, real component
    root.render(React.createElement(SessionRow, { session: s as any, dnd, roster: [s as any], collapsed: false }));
  });
  const li = container.querySelector("li");
  if (!li) throw new Error("SessionRow did not render its <li> row");
  return li as HTMLElement;
}

test("the row badge shows the short label while its tooltip and the ring keep the full name", () => {
  const [family, version] = Object.entries(MODEL_FAMILY_DEFAULTS.claude)[0]!;
  const modelId = `${claudeId(family, version)}[1m]`;
  const full = `${cap(family)} ${version} (1M context)`;
  const li = renderRow(modelId, full);
  const badge = li.querySelector(".row-model");
  expect(badge?.textContent, "the badge carries the family alone at its default").toBe(shortModelLabel(modelId, full));
  expect(badge?.textContent).not.toBe(full);
  expect(badge?.getAttribute("title"), "the tooltip keeps the full display name").toContain(full);
  expect(badge?.getAttribute("title"), "the tooltip keeps the model id").toContain(modelId);
  expect(li.querySelector("svg.context-ring")?.getAttribute("aria-label"), "the ring names the full model").toContain(full);
});

test("a clodex row never shows the provider prefix in its badge", () => {
  const [variant, version] = Object.entries(MODEL_FAMILY_DEFAULTS.clodex)[0]!;
  const raw = `clodex:openai-oauth:gpt-${version}-${variant}`;
  const li = renderRow(raw, raw);
  expect(li.querySelector(".row-model")?.textContent).toBe(variant);
  expect(li.querySelector(".row-model")?.getAttribute("title")).toContain(raw);
});
