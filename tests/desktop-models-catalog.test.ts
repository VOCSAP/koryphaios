// EXPLORATION-graph-chat C29: unified model catalog (desktop/src/shared/models)
// — favorite keys, catalog assembly (frontier gated on CLI detection, D11),
// favorites resolution in pin order.

import { test, expect } from "bun:test";
import {
  buildCatalogs,
  favKey,
  FRONTIER_CATALOG,
  parseFavKey,
  resolveFavorites,
  toggleFavorite,
  type LocalProviderConfig
} from "../desktop/src/shared/models.ts";

const NONE = { claude: false, codex: false, gemini: false, local: true };

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
