import { test, expect } from "bun:test";
import { generateSummary, heuristicSummary, type SummaryContext } from "../shared/summarize.ts";

// Proves callAnthropic never falls back to process.env.ANTHROPIC_API_KEY on its
// own: with a fake env key present and cfg.api_key explicitly null, fetch must
// never be called at all.

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
