import { test, expect } from "bun:test";
import { generateSummary, heuristicSummary, type SummaryContext } from "../shared/summarize.ts";

// Card 630e3d16 audit round 2: callAnthropic used to have its OWN
// `cfg.api_key ?? process.env.ANTHROPIC_API_KEY` fallback, one layer below
// shared/config.ts#buildSummaryProviderConfig's allow-list. It never leaked
// today (the fetch target is the hardcoded https://api.anthropic.com), but
// it made the allow-list's "closed by construction" comment false: the
// closure actually depended on generateSummary's dispatch, not on the
// resolver alone. Removed. This test proves it stays removed: with a fake
// env key present and cfg.api_key explicitly null, fetch must never be
// called at all.

const FAKE_ENV_KEY = "test-only-placeholder-value-not-a-real-secret";

const ctx: SummaryContext = {
  cwd: "/tmp/example",
  git_root: null,
};

test("generateSummary: anthropic provider with null api_key never calls fetch, even with the env var set", async () => {
  const prevFetch = globalThis.fetch;
  const prevEnv = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = FAKE_ENV_KEY;
  let fetchCalled = false;
  globalThis.fetch = (() => {
    fetchCalled = true;
    throw new Error("fetch must not be called when api_key is null");
  }) as unknown as typeof fetch;

  try {
    const result = await generateSummary(ctx, {
      provider: "anthropic",
      api_key: null,
      model: "test-model",
      base_url: null,
    });
    expect(fetchCalled).toBe(false);
    expect(result).toBe(heuristicSummary(ctx));
  } finally {
    globalThis.fetch = prevFetch;
    if (prevEnv === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevEnv;
  }
});
