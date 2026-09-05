// EXPLORATION-graph-chat C29: unified model catalog (desktop/src/shared/models)
// — favorite keys, catalog assembly (frontier gated on CLI detection, D11;
// bridge sections gated on their wrapper + proxy), target keys and target
// sanitization, favorites resolution in pin order.

import { test, expect } from "bun:test";
import {
  buildCatalogs,
  CLODEX_PROVIDER_ID,
  CLODEX_PROVIDER_NAME,
  favKey,
  FRONTIER_CATALOG,
  FRONTIER_IDS,
  parseFavKey,
  resolveFavorites,
  sanitizeTarget,
  sanitizeUtilityTarget,
  targetKey,
  targetLabel,
  toggleFavorite,
  type BridgeState,
  type LocalProviderConfig
} from "../desktop/src/shared/models.ts";

const NONE = { claude: false, codex: false, gemini: false, local: true };

const UP: BridgeState = { installed: true, serverUp: true, patch: "fresh" };
const IDLE: BridgeState = { installed: true, serverUp: false, patch: "stale" };
const ABSENT: BridgeState = { installed: false, serverUp: false, patch: "unknown" };

function bridge(state: BridgeState, models = [{ id: "clodex:p:m", label: "m" }]) {
  return [{ id: CLODEX_PROVIDER_ID, name: CLODEX_PROVIDER_NAME, state, models }];
}

test("favKey round-trips, first-colon split survives Ollama tags", () => {
  expect(parseFavKey(favKey("anthropic", "sonnet"))).toEqual({
    providerId: "anthropic",
    modelId: "sonnet"
  });
  expect(parseFavKey(favKey("oll1", "qwen3:32b"))).toEqual({
    providerId: "oll1",
    modelId: "qwen3:32b"
  });
  expect(parseFavKey("no-separator")).toBeNull();
  expect(parseFavKey(":model")).toBeNull();
});

test("toggleFavorite pins, unpins, preserves pin order", () => {
  let favs: string[] = [];
  favs = toggleFavorite(favs, "a:1");
  favs = toggleFavorite(favs, "b:2");
  expect(favs).toEqual(["a:1", "b:2"]);
  favs = toggleFavorite(favs, "a:1");
  expect(favs).toEqual(["b:2"]);
});

test("buildCatalogs: frontier availability follows CLI detection (D11)", () => {
  const catalogs = buildCatalogs({ ...NONE, claude: true, gemini: true }, []);
  const byId = new Map(catalogs.map((c) => [c.id, c]));
  expect(byId.get("anthropic")!.available).toBe(true);
  expect(byId.get("openai")!.available).toBe(false);
  expect(byId.get("gemini")!.available).toBe(true);
  expect(byId.get("anthropic")!.models).toEqual(FRONTIER_CATALOG.anthropic.models);
  expect(byId.get("anthropic")!.cli).toBe("claude");
});

test("buildCatalogs: local providers appended, unavailable when discovery empty", () => {
  const ollama: LocalProviderConfig = { id: "oll1", name: "Ollama", baseUrl: "http://x" };
  const dead: LocalProviderConfig = { id: "dead", name: "", baseUrl: "http://y" };
  const catalogs = buildCatalogs(NONE, [
    { provider: ollama, models: [{ id: "qwen3:32b" }] },
    { provider: dead, models: [] }
  ]);
  const oll = catalogs.find((c) => c.id === "oll1")!;
  expect(oll.kind).toBe("local");
  expect(oll.cli).toBe("local");
  expect(oll.available).toBe(true);
  expect(oll.models.map((m) => m.id)).toEqual(["qwen3:32b"]);
  const d = catalogs.find((c) => c.id === "dead")!;
  expect(d.available).toBe(false);
  expect(d.name).toBe("http://y"); // empty name falls back to the URL
});

test("resolveFavorites: pin order kept, unavailable/vanished skipped silently", () => {
  const catalogs = buildCatalogs({ ...NONE, claude: true }, [
    {
      provider: { id: "oll1", name: "Ollama", baseUrl: "http://x" },
      models: [{ id: "qwen3:32b" }]
    }
  ]);
  const favs = [
    "oll1:qwen3:32b", // local, available
    "anthropic:sonnet", // frontier, available
    "gemini:gemini-3-pro", // CLI not detected -> skipped
    "anthropic:no-such-model", // vanished model -> skipped
    "ghost:whatever", // vanished provider -> skipped
    "garbage" // malformed key -> skipped
  ];
  const resolved = resolveFavorites(catalogs, favs);
  expect(resolved.map((r) => r.key)).toEqual(["oll1:qwen3:32b", "anthropic:sonnet"]);
  expect(resolved[0].catalog.cli).toBe("local");
  expect(resolved[1].model.label).toContain("Sonnet");
});

test("buildCatalogs: the bridge section sits after the frontier ones and before the locals", () => {
  const catalogs = buildCatalogs(
    NONE,
    [{ provider: { id: "oll1", name: "Ollama", baseUrl: "http://x" }, models: [{ id: "q" }] }],
    bridge(UP)
  );
  const ids = catalogs.map((c) => c.id);
  expect(ids).toEqual([...FRONTIER_IDS, CLODEX_PROVIDER_ID, "oll1"]);
  const clodex = catalogs.find((c) => c.id === CLODEX_PROVIDER_ID)!;
  expect(clodex.kind).toBe("bridge");
  expect(clodex.cli).toBe("claude"); // a bridge is executed BY the claude CLI
  expect(clodex.name).toBe(CLODEX_PROVIDER_NAME);
  expect(clodex.bridge).toEqual(UP);
  expect(clodex.models).toEqual([{ id: "clodex:p:m", label: "m" }]);
});

test("buildCatalogs: a bridge is available only when installed AND its proxy answers", () => {
  const up = buildCatalogs(NONE, [], bridge(UP))[FRONTIER_IDS.length];
  const idle = buildCatalogs(NONE, [], bridge(IDLE))[FRONTIER_IDS.length];
  const absent = buildCatalogs(NONE, [], bridge(ABSENT))[FRONTIER_IDS.length];
  expect(up.available).toBe(true);
  expect(idle.available).toBe(false); // installed but idle: the picker greys it
  expect(absent.available).toBe(false);
  // The state travels with the section, so "idle" stays tellable from "absent".
  expect(idle.bridge!.installed).toBe(true);
  expect(absent.bridge!.installed).toBe(false);
});

test("buildCatalogs: omitting the bridge list leaves the frontier+local catalog untouched", () => {
  const withoutArg = buildCatalogs({ ...NONE, claude: true }, []);
  expect(withoutArg.some((c) => c.kind === "bridge")).toBe(false);
  expect(withoutArg.map((c) => c.id)).toEqual([...FRONTIER_IDS]);
});

test("targetKey: a provider id wins over the CLI table, so a bridge keys on its own section", () => {
  expect(targetKey({ cli: "claude", model: "sonnet" })).toBe("anthropic:sonnet");
  expect(targetKey({ cli: "codex", model: "gpt-5.1" })).toBe("openai:gpt-5.1");
  expect(targetKey({ cli: "local", model: "q" })).toBe(":q");
  expect(targetKey({ cli: "local", model: "q", providerId: "oll1" })).toBe("oll1:q");
  expect(
    targetKey({ cli: "claude", model: "clodex:openai-oauth:gpt-5.6-sol", providerId: "clodex" })
  ).toBe(favKey("clodex", "clodex:openai-oauth:gpt-5.6-sol"));
});

test("sanitizeTarget: a claude target keeps a non-empty provider id, drops anything else", () => {
  const fb = { cli: "claude" as const, model: "haiku" };
  expect(sanitizeTarget({ cli: "claude", model: "m", providerId: "clodex" }, fb)).toEqual({
    cli: "claude",
    model: "m",
    providerId: "clodex"
  });
  expect(sanitizeTarget({ cli: "claude", model: "m", providerId: "" }, fb)).toEqual({
    cli: "claude",
    model: "m"
  });
  expect(sanitizeTarget({ cli: "claude", model: "m", providerId: 7 }, fb)).toEqual({
    cli: "claude",
    model: "m"
  });
  // Other CLIs never carry a provider id, and 'local' still REQUIRES one.
  expect(sanitizeTarget({ cli: "codex", model: "m", providerId: "clodex" }, fb)).toEqual({
    cli: "codex",
    model: "m"
  });
  expect(sanitizeTarget({ cli: "local", model: "m" }, fb)).toEqual(fb);
  expect(sanitizeTarget({ cli: "local", model: "m", providerId: "oll1" }, fb)).toEqual({
    cli: "local",
    model: "m",
    providerId: "oll1"
  });
});

test("targetLabel: a provider id names the label whatever the CLI carries it", () => {
  expect(targetLabel({ cli: "claude", model: "sonnet" })).toBe("claude · sonnet");
  expect(targetLabel({ cli: "codex", model: "" })).toBe("codex (default)");
  expect(targetLabel({ cli: "local", model: "m", providerId: "oll1" })).toBe("oll1 · m");
  // Without this, a bridged model would read as a plain claude one.
  expect(
    targetLabel({ cli: "claude", model: "clodex:openai-oauth:gpt-5.6-sol", providerId: "clodex" })
  ).toBe("clodex · clodex:openai-oauth:gpt-5.6-sol");
  // A local target with no provider id still degrades to the generic word.
  expect(targetLabel({ cli: "local", model: "m" })).toBe("local · m");
});

test("sanitizeUtilityTarget: everything sanitizeTarget accepts, minus the bridges", () => {
  const fb = { cli: "claude" as const, model: "haiku" };
  // The one difference: a bridge provider is refused, the fallback is COPIED.
  const clamped = sanitizeUtilityTarget(
    { cli: "claude", model: "clodex:openai-oauth:gpt-5.6-sol", providerId: CLODEX_PROVIDER_ID },
    fb
  );
  expect(clamped).toEqual(fb);
  expect(clamped).not.toBe(fb);
  // Refused by SHAPE (a provider id on a CLI target), so a second bridge id
  // nobody listed here is refused too.
  expect(sanitizeUtilityTarget({ cli: "claude", model: "m", providerId: "other" }, fb)).toEqual(fb);
  // Every other shape behaves exactly as sanitizeTarget does.
  for (const raw of [
    { cli: "claude", model: "sonnet" },
    { cli: "codex", model: "gpt-5.1" },
    { cli: "local", model: "m", providerId: "oll1" },
    { cli: "local", model: "m" },
    { cli: "claude", model: "m", providerId: "" },
    null,
    42,
    "haiku"
  ]) {
    expect(sanitizeUtilityTarget(raw, fb)).toEqual(sanitizeTarget(raw, fb));
  }
});

test("resolveFavorites: a bridge favorite resolves like any other, and vanishes when idle", () => {
  const models = [{ id: "clodex:openai-oauth:gpt-5.6-sol", label: "sol · GPT-5.6 Sol" }];
  const favs = ["clodex:clodex:openai-oauth:gpt-5.6-sol", "anthropic:sonnet"];
  const live = resolveFavorites(
    buildCatalogs({ ...NONE, claude: true }, [], bridge(UP, models)),
    favs
  );
  expect(live.map((r) => r.key)).toEqual(favs);
  expect(live[0].catalog.kind).toBe("bridge");
  expect(live[0].model.label).toBe("sol · GPT-5.6 Sol");

  const idle = resolveFavorites(
    buildCatalogs({ ...NONE, claude: true }, [], bridge(IDLE, models)),
    favs
  );
  expect(idle.map((r) => r.key)).toEqual(["anthropic:sonnet"]);
});
