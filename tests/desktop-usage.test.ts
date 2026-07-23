// Usage-limit gauges (usage modal): pure parsers of the three provider
// payloads + the readUsage orchestration with injected probes/fetch/rpc.

import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  antigravityBucketMeta,
  parseAntigravityKeyring,
  parseAntigravityQuota,
  parseClaudeCredentials,
  parseClaudeUsage,
  parseCodexRateLimits,
  parseCodexSessionText,
  readUsage,
  resetUsageCaches
} from "../desktop/src/main/usage-service.ts";

beforeEach(() => resetUsageCaches());

// ---------------------------------------------------------------------------
// Claude parsers

test("parseClaudeUsage maps the oauth/usage blocks to gauges", () => {
  const { windows, credits } = parseClaudeUsage({
    five_hour: { utilization: 33, resets_at: "2026-04-11T07:00:00+00:00" },
    seven_day: { utilization: 13.4, resets_at: "2026-04-17T00:59:59+00:00" },
    seven_day_opus: null,
    seven_day_sonnet: { utilization: 1, resets_at: "2026-04-16T03:00:00+00:00" },
    extra_usage: { is_enabled: true, monthly_limit: 50, used_credits: 12.5, utilization: 25 }
  });
  expect(windows.map((w) => w.key)).toEqual(["session", "week", "week-model"]);
  expect(windows[0]?.usedPercent).toBe(33);
  expect(windows[0]?.resetsAt).toBe(Date.parse("2026-04-11T07:00:00+00:00"));
  expect(windows[2]?.label).toBe("Sonnet");
  expect(credits).toEqual({ enabled: true, used: 12.5, limit: 50, utilization: 25 });
});

test("parseClaudeUsage tolerates junk and missing blocks", () => {
  expect(parseClaudeUsage(null).windows).toEqual([]);
  expect(parseClaudeUsage({ five_hour: { utilization: "nope" } }).windows).toEqual([]);
  const over = parseClaudeUsage({ five_hour: { utilization: 140 } });
  expect(over.windows[0]?.usedPercent).toBe(100); // clamped
  expect(over.windows[0]?.resetsAt).toBeNull();
});

test("parseClaudeCredentials extracts the OAuth access token", () => {
  expect(parseClaudeCredentials({ claudeAiOauth: { accessToken: "sk-ant-oat01-x" } })).toBe(
    "sk-ant-oat01-x"
  );
  expect(parseClaudeCredentials({ claudeAiOauth: { accessToken: "" } })).toBeNull();
  expect(parseClaudeCredentials({})).toBeNull();
});

// ---------------------------------------------------------------------------
// Codex parsers

test("parseCodexRateLimits reads the app-server camelCase shape", () => {
  const { windows, plan } = parseCodexRateLimits({
    rateLimits: {
      planType: "plus",
      primary: { usedPercent: 42.5, windowDurationMins: 300, resetsAt: 1770000000 },
      secondary: { usedPercent: 88, windowDurationMins: 10080, resetsAt: 1770500000 }
    }
  });
  expect(windows).toHaveLength(2);
  expect(windows[0]).toMatchObject({ key: "session", usedPercent: 42.5 });
  expect(windows[0]?.resetsAt).toBe(1770000000 * 1000); // unix seconds → ms
  expect(windows[1]?.key).toBe("week");
  expect(plan).toBe("plus");
});

test("parseCodexSessionText finds the LAST rate_limits snapshot (snake_case)", () => {
  const line = (pct: number): string =>
    JSON.stringify({
      timestamp: "t",
      type: "event_msg",
      payload: {
        type: "token_count",
        rate_limits: {
          primary: { used_percent: pct, window_minutes: 300, resets_at: 1770000000 },
          secondary_window: { used_percent: 10, resets_at: 1770500000 }
        }
      }
    });
  const text = ["{}", line(10), "not json at all", line(77), ""].join("\n");
  const parsed = parseCodexSessionText(text);
  expect(parsed?.windows[0]).toMatchObject({ key: "session", usedPercent: 77 });
  expect(parsed?.windows[1]?.key).toBe("week");
  expect(parseCodexSessionText("nothing here")).toBeNull();
});

// ---------------------------------------------------------------------------
// Antigravity parsers

test("antigravityBucketMeta maps pool ids to window keys", () => {
  expect(antigravityBucketMeta("gemini-5h")).toEqual({ key: "session", label: "Gemini" });
  expect(antigravityBucketMeta("3p-weekly")).toEqual({ key: "week", label: "3p" });
  expect(antigravityBucketMeta("mystery-pool")).toBeNull();
});

test("parseAntigravityQuota converts remainingFraction and sorts pools", () => {
  const { windows } = parseAntigravityQuota({
    response: {
      groups: [
        {
          buckets: [
            { bucketId: "3p-weekly", remainingFraction: 0.9, resetTime: "2026-07-26T09:00:00Z" },
            { bucketId: "gemini-5h", remainingFraction: 0.25, resetTime: "2026-07-22T15:30:00Z" },
            { bucketId: "gemini-weekly", remainingFraction: 0.5 },
            { bucketId: "unknown", remainingFraction: 0.1 }
          ]
        }
      ]
    }
  });
  expect(windows.map((w) => `${w.key}:${w.label}`)).toEqual([
    "session:Gemini",
    "week:Gemini",
    "week:3p"
  ]);
  expect(windows[0]?.usedPercent).toBe(75);
  expect(windows[0]?.resetsAt).toBe(Date.parse("2026-07-22T15:30:00Z"));
});

test("findGoogleClientSecret spots an installed-app secret in binary text", async () => {
  const { findGoogleClientSecret } = await import("../desktop/src/main/usage-service.ts");
  // Deliberately fake value (same shape as the real one, which must never be
  // committed — GitHub push protection blocks it).
  expect(findGoogleClientSecret("junk\x00GOCSPX-FakeFakeFakeFakeFake0123456\x00junk")).toBe(
    "GOCSPX-FakeFakeFakeFakeFake0123456"
  );
  expect(findGoogleClientSecret("GOCSPX-short")).toBeNull();
  expect(findGoogleClientSecret("nothing")).toBeNull();
});

test("parseAntigravityKeyring handles raw, base64 and go-keyring wrapped blobs", () => {
  const blob = JSON.stringify({
    token: { access_token: "at", refresh_token: "rt", expiry: "2026-07-22T12:00:00Z" }
  });
  const b64 = Buffer.from(blob, "utf8").toString("base64");
  for (const raw of [blob, b64, `go-keyring-base64:${b64}`]) {
    const tok = parseAntigravityKeyring(raw);
    expect(tok?.accessToken).toBe("at");
    expect(tok?.refreshToken).toBe("rt");
    expect(tok?.expiresAt).toBe(Date.parse("2026-07-22T12:00:00Z"));
  }
  expect(parseAntigravityKeyring("not-a-blob")).toBeNull();
});

// ---------------------------------------------------------------------------
// Orchestration (injected deps; no network, no real binaries)

function fakeFetch(handlers: Record<string, () => Response>): typeof fetch {
  return (async (url: RequestInfo | URL) => {
    const key = Object.keys(handlers).find((k) => String(url).includes(k));
    if (!key) throw new Error(`unexpected fetch ${String(url)}`);
    return handlers[key]!();
  }) as typeof fetch;
}

test("readUsage only reports providers whose binary is detected", async () => {
  const home = mkdtempSync(join(tmpdir(), "usage-"));
  try {
    const snap = await readUsage(
      {
        shell: "/bin/bash",
        home,
        env: {},
        probe: async (bin) => bin === "codex",
        runCodexRpc: async () => ({
          rateLimits: { primary: { usedPercent: 5, resetsAt: 1770000000 } }
        }),
        fetchImpl: fakeFetch({}),
        report: () => {},
        now: () => 1_000_000
      },
      {}
    );
    // codex has no auth.json in the fake home → installed but signed out.
    expect(snap.providers.map((p) => p.provider)).toEqual(["codex"]);
    expect(snap.providers[0]?.status).toBe("not-connected");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("readUsage: codex app-server result, claude endpoint, snapshot cache", async () => {
  const home = mkdtempSync(join(tmpdir(), "usage-"));
  try {
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "auth.json"), "{}");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      join(home, ".claude", ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "tok" } })
    );
    let claudeCalls = 0;
    let clock = 1_000_000;
    const deps = {
      shell: "/bin/bash",
      home,
      env: {},
      probe: async (bin: string) => bin !== "agy",
      runCodexRpc: async () => ({
        rateLimits: { planType: "plus", primary: { usedPercent: 12, resetsAt: 1770000000 } }
      }),
      claudeUa: async () => "claude-code/0.0.0-test",
      fetchImpl: fakeFetch({
        "api.anthropic.com/api/oauth/usage": () => {
          claudeCalls++;
          return new Response(
            JSON.stringify({ five_hour: { utilization: 60, resets_at: "2026-07-22T15:00:00Z" } }),
            { status: 200 }
          );
        }
      }),
      report: () => {},
      now: () => clock
    };
    const snap = await readUsage(deps, {});
    expect(snap.providers.map((p) => p.provider).sort()).toEqual(["claude", "codex"]);
    const claude = snap.providers.find((p) => p.provider === "claude");
    expect(claude?.status).toBe("ok");
    expect(claude?.windows[0]?.usedPercent).toBe(60);
    const codex = snap.providers.find((p) => p.provider === "codex");
    expect(codex).toMatchObject({ status: "ok", plan: "plus", stale: false });

    // Second read inside the 3-min window: served from cache, no new fetch.
    clock += 60_000;
    await readUsage(deps, {});
    expect(claudeCalls).toBe(1);
    // refresh bypasses the cache.
    await readUsage(deps, { refresh: true });
    expect(claudeCalls).toBe(2);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("readUsage: codex falls back to the newest session snapshot (stale)", async () => {
  const home = mkdtempSync(join(tmpdir(), "usage-"));
  try {
    const day = join(home, ".codex", "sessions", "2026", "07", "22");
    mkdirSync(day, { recursive: true });
    writeFileSync(join(home, ".codex", "auth.json"), "{}");
    writeFileSync(
      join(day, "rollout-1.jsonl"),
      JSON.stringify({
        payload: { type: "token_count", rate_limits: { primary: { used_percent: 91 } } }
      }) + "\n"
    );
    const snap = await readUsage(
      {
        shell: "/bin/bash",
        home,
        env: {},
        probe: async (bin: string) => bin === "codex",
        runCodexRpc: async () => {
          throw new Error("app-server down");
        },
        fetchImpl: fakeFetch({}),
        report: () => {},
        now: () => 1_000_000
      },
      {}
    );
    expect(snap.providers[0]).toMatchObject({
      provider: "codex",
      status: "ok",
      stale: true
    });
    expect(snap.providers[0]?.windows[0]?.usedPercent).toBe(91);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Amphora gauge (shared/usage.ts) + used-provider tracking

test("sessionRemainingFraction averages the used providers' session windows", async () => {
  const { sessionRemainingFraction, usageTone } = await import("../desktop/src/shared/usage.ts");
  const report = (provider: string, pcts: number[], status = "ok"): unknown => ({
    provider,
    status,
    plan: null,
    windows: pcts.map((p) => ({ key: "session", label: null, usedPercent: p, resetsAt: null })),
    credits: null,
    stale: false,
    error: null
  });
  const snap = (providers: unknown[], used: string[]): never =>
    ({ fetchedAt: 0, providers, usedProviders: used }) as never;

  // Only claude used -> its remaining alone (100-40 = 60%).
  expect(sessionRemainingFraction(snap([report("claude", [40]), report("codex", [80])], ["claude"]))).toBe(0.6);
  // claude+codex -> mean of 60% and 20%.
  expect(
    sessionRemainingFraction(snap([report("claude", [40]), report("codex", [80])], ["claude", "codex"]))
  ).toBeCloseTo(0.4);
  // Nothing marked used -> fall back to every reporting provider.
  expect(sessionRemainingFraction(snap([report("claude", [50])], []))).toBe(0.5);
  // Antigravity's two session pools average within the provider first.
  expect(sessionRemainingFraction(snap([report("antigravity", [20, 60])], ["antigravity"]))).toBeCloseTo(0.6);
  // Errored providers never count.
  expect(sessionRemainingFraction(snap([report("claude", [40], "error")], ["claude"]))).toBeNull();
  expect(usageTone(0.5)).toBe("ok");
  expect(usageTone(0.2)).toBe("warn");
  expect(usageTone(0.05)).toBe("hot");
});

test("readUsage reports usedProviders (marked targets + live tiles)", async () => {
  const { markProviderUsed } = await import("../desktop/src/main/usage-service.ts");
  markProviderUsed("codex");
  markProviderUsed("local"); // ignored: no subscription meter
  const home = mkdtempSync(join(tmpdir(), "usage-"));
  try {
    const snap = await readUsage(
      {
        shell: "/bin/bash",
        home,
        env: {},
        probe: async () => false, // no CLI detected: providers list stays empty
        runCodexRpc: async () => ({}),
        fetchImpl: (async () => new Response("{}")) as typeof fetch,
        report: () => {},
        now: () => 1_000_000,
        liveClis: () => ["claude"]
      },
      {}
    );
    expect(snap.providers).toEqual([]);
    expect([...snap.usedProviders].sort()).toEqual(["claude", "codex"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
