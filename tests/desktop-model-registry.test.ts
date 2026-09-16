// EXPLORATION-graph-chat C29: model registry (desktop/src/main/model-registry)
// — CLI detection command building, local endpoint discovery (OpenAI-compatible
// /v1/models + Ollama /api/tags fallback), bridge probing, catalog assembly
// with injected IO. Every probe here is injected: the suite must never spawn a
// login shell.

import { test, expect, beforeEach } from "bun:test";
import {
  announceModelsChanged,
  buildDetectCommand,
  detectClis,
  detectClodex,
  discoverLocalModels,
  FRONTIER_BINS,
  getCatalogs,
  modelsUrlCandidates,
  parseOllamaTags,
  parseOpenAiModels,
  resetDetectCache
} from "../desktop/src/main/model-registry.ts";
import { CLODEX_PROVIDER_ID } from "../desktop/src/shared/models.ts";
import type { ClodexProbeResult } from "../desktop/src/main/clodex-bridge.ts";

beforeEach(() => resetDetectCache());

const BRIDGE_OFF: ClodexProbeResult = {
  state: { installed: false, serverUp: false, patch: "unknown" },
  models: []
};

const BRIDGE_UP: ClodexProbeResult = {
  state: { installed: true, serverUp: true, patch: "fresh" },
  models: [{ id: "clodex:openai-oauth:gpt-5.6-sol", label: "sol" }]
};

function countingProbe(result: ClodexProbeResult): { probe: () => Promise<ClodexProbeResult>; calls: () => number } {
  let calls = 0;
  return {
    probe: async () => {
      calls++;
      return result;
    },
    calls: () => calls
  };
}

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
      fetchImpl: fakeFetch({ "http://h/v1/models": { data: [{ id: "m" }] } }),
      clodexProbe: async () => BRIDGE_OFF
    }
  );
  const oll = catalogs.find((c) => c.id === "oll");
  expect(oll).toBeDefined();
  expect(oll!.models).toEqual([{ id: "m" }]);
  expect(catalogs.some((c) => c.id === "")).toBe(false);
});

test("detectClodex: injected probe, cached until refresh, both caches reset together", async () => {
  const { probe, calls } = countingProbe(BRIDGE_UP);
  expect((await detectClodex("", { probe })).state.serverUp).toBe(true);
  expect(calls()).toBe(1);
  await detectClodex("", { probe });
  expect(calls()).toBe(1); // cached for the app run
  await detectClodex("", { probe, refresh: true });
  expect(calls()).toBe(2);
  resetDetectCache();
  await detectClodex("", { probe });
  expect(calls()).toBe(3); // resetDetectCache clears the bridge cache too
});

test("detectClodex: a probe that throws is absorbed into a not-installed state", async () => {
  const result = await detectClodex("", {
    probe: async () => {
      throw new Error("shell exploded");
    }
  });
  expect(result.state).toEqual({ installed: false, serverUp: false, patch: "unknown" });
  expect(result.models).toEqual([]);
});

test("getCatalogs: the bridge section is always emitted, carrying its probed state", async () => {
  await detectClis("", { probe: async () => false });
  const live = await getCatalogs([], "", { clodexProbe: async () => BRIDGE_UP });
  const clodex = live.find((c) => c.id === CLODEX_PROVIDER_ID)!;
  expect(clodex.kind).toBe("bridge");
  expect(clodex.available).toBe(true);
  expect(clodex.bridge).toEqual(BRIDGE_UP.state);
  expect(clodex.models.map((m) => m.id)).toEqual(["clodex:openai-oauth:gpt-5.6-sol"]);

  resetDetectCache();
  await detectClis("", { probe: async () => false });
  const off = await getCatalogs([], "", { clodexProbe: async () => BRIDGE_OFF });
  const absent = off.find((c) => c.id === CLODEX_PROVIDER_ID)!;
  expect(absent.available).toBe(false);
  expect(absent.bridge!.installed).toBe(false);
  expect(absent.models).toEqual([]);
});

test("getCatalogs: refresh re-probes the bridge, a plain call reuses the cache", async () => {
  await detectClis("", { probe: async () => false });
  const { probe, calls } = countingProbe(BRIDGE_UP);
  await getCatalogs([], "", { clodexProbe: probe });
  await getCatalogs([], "", { clodexProbe: probe });
  expect(calls()).toBe(1);
  await getCatalogs([], "", { clodexProbe: probe, refresh: true });
  expect(calls()).toBe(2);
});

/** Fills both caches, counting every CLI probe so a blunt reset is visible. */
async function warmCaches(
  clodexProbe: () => Promise<ClodexProbeResult>,
  onCliProbe: () => void
): Promise<void> {
  await Promise.all([
    detectClis("bash", {
      probe: async () => {
        onCliProbe();
        return true;
      }
    }),
    detectClodex("bash", { probe: clodexProbe })
  ]);
}

test("announceModelsChanged drops the bridge cache before announcing, and leaves the CLI cache alone", async () => {
  const clodex = countingProbe(BRIDGE_UP);
  let cliProbes = 0;
  await warmCaches(clodex.probe, () => cliProbes++);
  await warmCaches(clodex.probe, () => cliProbes++);
  expect(clodex.calls()).toBe(1);
  expect(cliProbes).toBe(FRONTIER_BINS.length);

  // Starting the refetch INSIDE the emit is what proves the order: detectClodex
  // reads the cache before its first await, so a re-probe there can only come
  // from an invalidation that already happened.
  const started: Promise<unknown>[] = [];
  announceModelsChanged(() => {
    started.push(detectClodex("bash", { probe: clodex.probe }));
  });
  await Promise.all(started);
  expect(clodex.calls()).toBe(2);

  // Asking again AFTER the announcement is what makes the CLI count mean
  // something: a blunt reset only shows up on the next detection, never on the
  // probes that ran before it.
  await warmCaches(clodex.probe, () => cliProbes++);
  expect(cliProbes).toBe(FRONTIER_BINS.length);
});

test("announceModelsChanged announces exactly once per call", () => {
  let announced = 0;
  announceModelsChanged(() => announced++);
  expect(announced).toBe(1);

  announceModelsChanged(() => announced++);
  expect(announced).toBe(2);
});
