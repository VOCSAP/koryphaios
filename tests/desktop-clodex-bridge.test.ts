// clodex bridge probe (desktop/src/main/clodex-bridge) — model-list parsing
// against the --model allow-list, patch-freshness comparison, and the four
// probe steps with fully injected IO. No test here spawns a process; only the
// default deps' file read touches the disk.

import { test, expect } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  CLODEX_MODEL_ID_RE,
  MAX_CLODEX_MODELS,
  clodexHome,
  clodexManifestPath,
  defaultClodexDeps,
  parseClodexModels,
  patchStateFor,
  probeClodex,
  type ClodexDeps
} from "../desktop/src/main/clodex-bridge.ts";
import { sanitizeFlagValue } from "../desktop/src/main/session-command.ts";

const HOME = "/tmp/clodex-home";
const MANIFEST = join(HOME, "patch-state.json");

interface Recorder {
  runs: string[];
  errors: { scope: string; message: string }[];
}

interface DepsOpts {
  installed?: boolean;
  probeThrows?: boolean;
  /** Keyed by `${cmd} ${args.join(' ')}`; absent => exit 127, empty stdout. */
  results?: Record<string, { code: number; stdout: string }>;
  runThrows?: string[];
  manifest?: string | null;
  readThrows?: boolean;
}

function makeDeps(opts: DepsOpts): { deps: ClodexDeps; rec: Recorder } {
  const rec: Recorder = { runs: [], errors: [] };
  const deps: ClodexDeps = {
    probeBin: async () => {
      if (opts.probeThrows) throw new Error("shell exploded");
      return opts.installed ?? true;
    },
    run: async (cmd, args) => {
      const line = [cmd, ...args].join(" ");
      rec.runs.push(line);
      if (opts.runThrows?.includes(line)) throw new Error(`spawn failed: ${line}`);
      return opts.results?.[line] ?? { code: 127, stdout: "" };
    },
    readFile: () => {
      if (opts.readThrows) throw new Error("EACCES");
      return opts.manifest ?? null;
    },
    env: { CLODEX_HOME: HOME } as NodeJS.ProcessEnv,
    onError: (scope, message) => rec.errors.push({ scope, message })
  };
  return { deps, rec };
}

const MODELS_CMD = "clodex models --json";
const CHECK_CMD = "clodex-claude --check";
const VERSION_CMD = "claude --version";

const ONE_MODEL = JSON.stringify([
  { id: "clodex:openai-oauth:gpt-5.6-sol", alias: "sol", displayName: "GPT-5.6 Sol" }
]);

test("parseClodexModels: alias prefixes the label, displayName/modelId/id fall back in order", () => {
  const raw = JSON.stringify([
    { id: "clodex:openai-oauth:gpt-5.6-sol", alias: "sol", displayName: "GPT-5.6 Sol" },
    { id: "clodex:openai-oauth:gpt-5.1", displayName: "GPT-5.1" },
    { id: "clodex:openai-oauth:bare" },
    { id: "clodex:openai-oauth:aliased", alias: "mini", modelId: "gpt-5-mini" }
  ]);
  expect(parseClodexModels(raw)).toEqual([
    { id: "clodex:openai-oauth:gpt-5.6-sol", label: "sol · GPT-5.6 Sol" },
    { id: "clodex:openai-oauth:gpt-5.1", label: "GPT-5.1" },
    { id: "clodex:openai-oauth:bare", label: "clodex:openai-oauth:bare" },
    { id: "clodex:openai-oauth:aliased", label: "mini · gpt-5-mini" }
  ]);
});

test("parseClodexModels drops every id --model would reject, plus duplicates and non-objects", () => {
  const raw = JSON.stringify([
    { id: "clodex:ok:one" },
    { id: "clodex:ok:one", displayName: "duplicate" },
    { id: "has space" },
    { id: "quote\"break" },
    { id: "semi;rm -rf /" },
    { id: "$(whoami)" },
    { id: "" },
    { id: 42 },
    { alias: "no id at all" },
    { id: "x".repeat(129) },
    null,
    "junk"
  ]);
  expect(parseClodexModels(raw).map((m) => m.id)).toEqual(["clodex:ok:one"]);
});

test("parseClodexModels caps the section at MAX_CLODEX_MODELS entries", () => {
  const raw = JSON.stringify(
    Array.from({ length: MAX_CLODEX_MODELS + 12 }, (_, i) => ({ id: `clodex:p:m${i}` }))
  );
  const parsed = parseClodexModels(raw);
  expect(parsed.length).toBe(MAX_CLODEX_MODELS);
  expect(parsed[MAX_CLODEX_MODELS - 1].id).toBe(`clodex:p:m${MAX_CLODEX_MODELS - 1}`);
});

test("parseClodexModels throws on a non-JSON payload and on a JSON non-array", () => {
  expect(() => parseClodexModels("clodex: command not found")).toThrow();
  expect(() => parseClodexModels(JSON.stringify({ models: [] }))).toThrow(/array/);
});

test("CLODEX_MODEL_ID_RE accepts exactly the ids sanitizeFlagValue lets reach --model", () => {
  const samples = [
    "clodex:openai-oauth:gpt-5.6-sol",
    "sonnet[1m]",
    "gpt-5.1",
    "a@b/c",
    "has space",
    "quote\"break",
    "semi;rm -rf /",
    "$(whoami)",
    "",
    "x".repeat(128),
    "x".repeat(129)
  ];
  for (const s of samples) {
    expect(CLODEX_MODEL_ID_RE.test(s)).toBe(sanitizeFlagValue(s) !== "");
  }
});

test("patchStateFor: no manifest is 'none', matching versions 'fresh', differing 'stale'", () => {
  expect(patchStateFor(null, "2.0.14 (Claude Code)")).toBe("none");
  expect(patchStateFor(JSON.stringify({ claudeVersion: "2.0.14" }), "2.0.14 (Claude Code)")).toBe(
    "fresh"
  );
  expect(patchStateFor(JSON.stringify({ claudeVersion: "2.0.13" }), "2.0.14 (Claude Code)")).toBe(
    "stale"
  );
});

test("patchStateFor: anything unreadable on either side is 'unknown', never 'fresh'", () => {
  expect(patchStateFor("{ truncated", "2.0.14")).toBe("unknown");
  expect(patchStateFor(JSON.stringify({ other: 1 }), "2.0.14")).toBe("unknown");
  expect(patchStateFor(JSON.stringify({ claudeVersion: 214 }), "2.0.14")).toBe("unknown");
  expect(patchStateFor(JSON.stringify({ claudeVersion: "dev" }), "2.0.14")).toBe("unknown");
  expect(patchStateFor(JSON.stringify({ claudeVersion: "2.0.14" }), null)).toBe("unknown");
  expect(patchStateFor(JSON.stringify({ claudeVersion: "2.0.14" }), "unknown build")).toBe(
    "unknown"
  );
  expect(patchStateFor(JSON.stringify([1, 2]), "2.0.14")).toBe("unknown");
});

test("clodexHome: CLODEX_HOME wins when non-blank, else ~/.clodex", () => {
  expect(clodexHome({ CLODEX_HOME: "/opt/clodex" } as NodeJS.ProcessEnv)).toBe("/opt/clodex");
  expect(clodexHome({ CLODEX_HOME: "   " } as NodeJS.ProcessEnv)).toBe(join(homedir(), ".clodex"));
  expect(clodexHome({} as NodeJS.ProcessEnv)).toBe(join(homedir(), ".clodex"));
  expect(clodexManifestPath({ CLODEX_HOME: "/opt/clodex" } as NodeJS.ProcessEnv)).toBe(
    join("/opt/clodex", "patch-state.json")
  );
});

test("probeClodex: an absent wrapper short-circuits — nothing else is spawned", async () => {
  const { deps, rec } = makeDeps({ installed: false });
  const result = await probeClodex(deps);
  expect(result.state).toEqual({ installed: false, serverUp: false, patch: "unknown" });
  expect(result.models).toEqual([]);
  expect(rec.runs).toEqual([]);
  expect(rec.errors).toEqual([]);
});

test("probeClodex: a PATH probe that throws is traced and reported as not installed", async () => {
  const { deps, rec } = makeDeps({ probeThrows: true });
  const result = await probeClodex(deps);
  expect(result.state.installed).toBe(false);
  expect(rec.errors.map((e) => e.scope)).toEqual(["clodex"]);
  expect(rec.errors[0].message).toContain("clodex-claude");
});

test("probeClodex: proxy down still lists models and patch state, section merely unavailable", async () => {
  const { deps, rec } = makeDeps({
    results: {
      [CHECK_CMD]: { code: 1, stdout: "" },
      [MODELS_CMD]: { code: 0, stdout: ONE_MODEL },
      [VERSION_CMD]: { code: 0, stdout: "2.0.14 (Claude Code)" }
    },
    manifest: JSON.stringify({ claudeVersion: "2.0.14" })
  });
  const result = await probeClodex(deps);
  expect(result.state).toEqual({ installed: true, serverUp: false, patch: "fresh" });
  expect(result.models.map((m) => m.id)).toEqual(["clodex:openai-oauth:gpt-5.6-sol"]);
  expect(rec.errors).toEqual([]);
});

test("probeClodex: an unusable model payload is traced and yields [], not a silent empty list", async () => {
  const { deps, rec } = makeDeps({
    results: {
      [CHECK_CMD]: { code: 0, stdout: "" },
      [MODELS_CMD]: { code: 0, stdout: "not json at all" },
      [VERSION_CMD]: { code: 0, stdout: "2.0.14" }
    },
    manifest: JSON.stringify({ claudeVersion: "2.0.14" })
  });
  const result = await probeClodex(deps);
  expect(result.models).toEqual([]);
  expect(result.state).toEqual({ installed: true, serverUp: true, patch: "fresh" });
  expect(rec.errors.length).toBe(1);
  expect(rec.errors[0].scope).toBe("clodex");
  expect(rec.errors[0].message).toContain("models --json");
});

test("probeClodex: a non-zero `clodex models --json` exit is traced with its code", async () => {
  const { deps, rec } = makeDeps({
    results: {
      [CHECK_CMD]: { code: 0, stdout: "" },
      [MODELS_CMD]: { code: 3, stdout: "" }
    }
  });
  const result = await probeClodex(deps);
  expect(result.models).toEqual([]);
  expect(rec.errors.some((e) => e.message.includes("code 3"))).toBe(true);
});

test("probeClodex: a model listing that cannot be spawned is traced, other steps survive", async () => {
  const { deps, rec } = makeDeps({
    results: { [CHECK_CMD]: { code: 0, stdout: "" } },
    runThrows: [MODELS_CMD],
    manifest: null
  });
  const result = await probeClodex(deps);
  expect(result.state).toEqual({ installed: true, serverUp: true, patch: "none" });
  expect(result.models).toEqual([]);
  expect(rec.errors.length).toBe(1);
});

test("probeClodex: no manifest means patch 'none' without asking claude for its version", async () => {
  const { deps, rec } = makeDeps({
    results: {
      [CHECK_CMD]: { code: 0, stdout: "" },
      [MODELS_CMD]: { code: 0, stdout: ONE_MODEL }
    },
    manifest: null
  });
  const result = await probeClodex(deps);
  expect(result.state.patch).toBe("none");
  expect(rec.runs).toEqual([CHECK_CMD, MODELS_CMD]);
  expect(rec.errors).toEqual([]);
});

test("probeClodex: an unreadable manifest is traced and leaves the patch state 'unknown'", async () => {
  const { deps, rec } = makeDeps({
    results: {
      [CHECK_CMD]: { code: 0, stdout: "" },
      [MODELS_CMD]: { code: 0, stdout: ONE_MODEL }
    },
    readThrows: true
  });
  const result = await probeClodex(deps);
  expect(result.state.patch).toBe("unknown");
  expect(rec.errors.length).toBe(1);
  expect(rec.errors[0].message).toContain(MANIFEST);
});

test("probeClodex: a stale patch is traced nowhere but reported, an undecidable one is traced", async () => {
  const stale = makeDeps({
    results: {
      [CHECK_CMD]: { code: 0, stdout: "" },
      [MODELS_CMD]: { code: 0, stdout: ONE_MODEL },
      [VERSION_CMD]: { code: 0, stdout: "2.0.15 (Claude Code)" }
    },
    manifest: JSON.stringify({ claudeVersion: "2.0.14" })
  });
  expect((await probeClodex(stale.deps)).state.patch).toBe("stale");
  expect(stale.rec.errors).toEqual([]);

  const undecidable = makeDeps({
    results: {
      [CHECK_CMD]: { code: 0, stdout: "" },
      [MODELS_CMD]: { code: 0, stdout: ONE_MODEL },
      [VERSION_CMD]: { code: 1, stdout: "" }
    },
    manifest: JSON.stringify({ claudeVersion: "2.0.14" })
  });
  expect((await probeClodex(undecidable.deps)).state.patch).toBe("unknown");
  expect(undecidable.rec.errors.length).toBe(2); // non-zero exit + undecidable comparison
});

test("defaultClodexDeps: readFile returns content, and null ONLY for a missing file", () => {
  const deps = defaultClodexDeps("");
  const real = join(import.meta.dir, "..", "package.json");
  expect(deps.readFile(real)).toContain('"name"');
  expect(deps.readFile(join(import.meta.dir, "..", "no-such-manifest.json"))).toBeNull();
  // An always-null readFile would pin every patch state to 'none' silently.
  expect(patchStateFor(deps.readFile(real), "1.2.3")).toBe("unknown");
});
