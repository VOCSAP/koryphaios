import { test, expect } from "bun:test";
import { resolveSummaryApiKey, buildSummaryProviderConfig, type Config } from "../shared/config.ts";

// Card 630e3d16 (M-SEC-3): server.ts used to pass
// `config.summary_api_key ?? process.env.ANTHROPIC_API_KEY ?? null` into
// generateSummary regardless of which provider resolveProvider() picked. When
// the resolved provider is "openai-compat" (as soon as summary_base_url is
// set), that key is sent as a Bearer header to an arbitrary base_url --
// leaking an Anthropic key to a third-party endpoint with no compromise
// required. resolveSummaryApiKey is the allow-list gate: the env fallback
// fires ONLY for the "anthropic" provider, by naming the one permitted value,
// never by excluding "openai-compat" (a deny-list would fail open on any
// future provider value).

const FAKE_ENV_KEY = "test-only-placeholder-value-not-a-real-secret";
const EXPLICIT_KEY = "explicit-config-value";

const baseConfig: Config = {
  port: 7899,
  db: ":memory:",
  summary_provider: "auto",
  summary_base_url: null,
  summary_api_key: null,
  summary_model: "test-model",
  groups: {},
  default_group: null,
  broker_url: null,
  broker_token: null,
  bind_host: null,
};

function withFakeEnvKey(fn: () => void) {
  const prev = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = FAKE_ENV_KEY;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prev;
  }
}

test("resolveSummaryApiKey: openai-compat provider never receives the env fallback", () => {
  withFakeEnvKey(() => {
    expect(resolveSummaryApiKey("openai-compat", baseConfig)).toBeNull();
  });
});

test("resolveSummaryApiKey: anthropic provider still falls back to the env value", () => {
  withFakeEnvKey(() => {
    expect(resolveSummaryApiKey("anthropic", baseConfig)).toBe(FAKE_ENV_KEY);
  });
});

test("resolveSummaryApiKey: explicit summary_api_key wins regardless of provider", () => {
  withFakeEnvKey(() => {
    const cfg: Config = { ...baseConfig, summary_api_key: EXPLICIT_KEY };
    expect(resolveSummaryApiKey("openai-compat", cfg)).toBe(EXPLICIT_KEY);
    expect(resolveSummaryApiKey("anthropic", cfg)).toBe(EXPLICIT_KEY);
  });
});

test("resolveSummaryApiKey: none provider never receives the env fallback", () => {
  withFakeEnvKey(() => {
    expect(resolveSummaryApiKey("none", baseConfig)).toBeNull();
  });
});

// Audit round 2: these two tests exercise buildSummaryProviderConfig's FULL
// construction (resolveProvider + resolveSummaryApiKey together), the same
// shape the old bug had. This proves the DECISION (which provider, which
// key) is correct and covered here. It does NOT prove server.ts calls this
// function instead of reconstructing the object inline -- that residual gap
// is real (measured: rebuilding the same leaking expression by hand at the
// server.ts call site still passes every test in this file, 6 pass / 0
// fail). Closing it would take a wiring/behavioural probe on server.ts
// itself, not another test in this file.

test("buildSummaryProviderConfig: summary_base_url auto-resolves to openai-compat and never leaks the env key into it", () => {
  withFakeEnvKey(() => {
    const cfg: Config = { ...baseConfig, summary_base_url: "http://127.0.0.1:9/v1" };
    const result = buildSummaryProviderConfig(cfg);
    expect(result.provider).toBe("openai-compat");
    expect(result.api_key).toBeNull();
    expect(result.base_url).toBe("http://127.0.0.1:9/v1");
  });
});

test("buildSummaryProviderConfig: no base_url auto-resolves to anthropic and keeps the env fallback", () => {
  withFakeEnvKey(() => {
    const result = buildSummaryProviderConfig(baseConfig);
    expect(result.provider).toBe("anthropic");
    expect(result.api_key).toBe(FAKE_ENV_KEY);
  });
});
