// EXPLORATION-graph-chat C29: model registry (desktop/src/main/model-registry)
// — CLI detection command building, local endpoint discovery (OpenAI-compatible
// /v1/models + Ollama /api/tags fallback), catalog assembly with injected IO.

import { test, expect, beforeEach } from "bun:test";
import {
  buildDetectCommand,
  detectClis,
  discoverLocalModels,
  getCatalogs,
  modelsUrlCandidates,
  parseOllamaTags,
  parseOpenAiModels,
  resetDetectCache
} from "../desktop/src/main/model-registry.ts";

beforeEach(() => resetDetectCache());

function fakeFetch(routes: Record<string, unknown>): typeof fetch {
  return (async (url: RequestInfo | URL) => {
    const key = String(url);
    if (key in routes) {
      return new Response(JSON.stringify(routes[key]), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

test("buildDetectCommand: POSIX command -v, PowerShell Get-Command, bin sanitized", () => {
  expect(buildDetectCommand("claude", "linux")).toBe("command -v claude");
  expect(buildDetectCommand("codex", "win32")).toBe(
    "Get-Command codex -ErrorAction Stop | Out-Null"
  );
  expect(buildDetectCommand("evil; rm -rf /", "linux")).toBe("command -v evilrm-rf");
});

test("modelsUrlCandidates handles bare hosts and .../v1 bases", () => {
  expect(modelsUrlCandidates("http://localhost:11434")).toEqual([
    "http://localhost:11434/v1/models",
    "http://localhost:11434/api/tags"
  ]);
  expect(modelsUrlCandidates("http://litellm:4000/v1/")).toEqual([
    "http://litellm:4000/v1/models",
    "http://litellm:4000/api/tags"
  ]);
});

test("payload parsers tolerate garbage", () => {
  expect(parseOpenAiModels({ data: [{ id: "m1" }, { id: "" }, "junk", { no: 1 }] })).toEqual([
    { id: "m1" }
  ]);
  expect(parseOpenAiModels("nope")).toEqual([]);
  expect(parseOllamaTags({ models: [{ name: "qwen3:32b" }, {}, null] })).toEqual([
    { id: "qwen3:32b" }
  ]);
  expect(parseOllamaTags(42)).toEqual([]);
});

test("discoverLocalModels: /v1/models first, /api/tags fallback, [] when dead", async () => {
  const p = { id: "x", name: "X", baseUrl: "http://h" };
  const viaV1 = await discoverLocalModels(
    p,
    fakeFetch({ "http://h/v1/models": { data: [{ id: "gpt-local" }] } })
  );
  expect(viaV1).toEqual([{ id: "gpt-local" }]);

  const viaTags = await discoverLocalModels(
    p,
    fakeFetch({ "http://h/api/tags": { models: [{ name: "llama4:8b" }] } })
  );
  expect(viaTags).toEqual([{ id: "llama4:8b" }]);

  const dead = await discoverLocalModels(p, fakeFetch({}));
  expect(dead).toEqual([]);
});

test("detectClis: injected probe, cached until refresh", async () => {
  let calls = 0;
  const probe = async (bin: string): Promise<boolean> => {
    calls++;
    return bin === "claude";
  };
  const first = await detectClis("", { probe });
  expect(first.claude).toBe(true);
  expect(first.codex).toBe(false);
  expect(first.gemini).toBe(false);
  expect(first.antigravity).toBe(false);
  expect(calls).toBe(4);
  await detectClis("", { probe });
  expect(calls).toBe(4); // cached
  await detectClis("", { probe, refresh: true });
  expect(calls).toBe(8);
});

test("getCatalogs assembles detection + discovery, skips half-configured locals", async () => {
  // Seed the detection cache with an injected probe so getCatalogs never
  // spawns real login shells in the test run.
  await detectClis("", { probe: async () => false });
  const catalogs = await getCatalogs(
    [
      { id: "oll", name: "Ollama", baseUrl: "http://h" },
      { id: "", name: "broken", baseUrl: "http://nope" } // no id -> skipped
    ],
    "",
    {
      fetchImpl: fakeFetch({ "http://h/v1/models": { data: [{ id: "m" }] } })
    }
  );
  const oll = catalogs.find((c) => c.id === "oll");
  expect(oll).toBeDefined();
  expect(oll!.models).toEqual([{ id: "m" }]);
  expect(catalogs.some((c) => c.id === "")).toBe(false);
});
