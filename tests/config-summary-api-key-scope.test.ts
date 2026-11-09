import { test, expect } from "bun:test";
import { resolveProvider, resolveSummaryApiKey, buildSummaryProviderConfig, type Config } from "../shared/config.ts";

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
  offline_replica: false,
  serve_replicas: false,
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
    expect(resolveSummaryApiKey("openai-compat", baseConfig, process.env)).toBeNull();
  });
});

test("resolveSummaryApiKey: anthropic provider still falls back to the env value", () => {
  withFakeEnvKey(() => {
    expect(resolveSummaryApiKey("anthropic", baseConfig, process.env)).toBe(FAKE_ENV_KEY);
  });
});

test("resolveSummaryApiKey: explicit summary_api_key wins regardless of provider", () => {
  withFakeEnvKey(() => {
    const cfg: Config = { ...baseConfig, summary_api_key: EXPLICIT_KEY };
    expect(resolveSummaryApiKey("openai-compat", cfg, process.env)).toBe(EXPLICIT_KEY);
    expect(resolveSummaryApiKey("anthropic", cfg, process.env)).toBe(EXPLICIT_KEY);
  });
});

test("resolveSummaryApiKey: none provider never receives the env fallback", () => {
  withFakeEnvKey(() => {
    expect(resolveSummaryApiKey("none", baseConfig, process.env)).toBeNull();
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
    const result = buildSummaryProviderConfig(cfg, process.env);
    expect(result.provider).toBe("openai-compat");
    expect(result.api_key).toBeNull();
    expect(result.base_url).toBe("http://127.0.0.1:9/v1");
  });
});

test("buildSummaryProviderConfig: no base_url auto-resolves to anthropic and keeps the env fallback", () => {
  withFakeEnvKey(() => {
    const result = buildSummaryProviderConfig(baseConfig, process.env);
    expect(result.provider).toBe("anthropic");
    expect(result.api_key).toBe(FAKE_ENV_KEY);
  });
});

function withProcessKey(value: string | undefined, fn: () => void) {
  const prev = process.env.ANTHROPIC_API_KEY;
  if (value === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prev;
  }
}

test("resolveSummaryApiKey: anthropic fallback reads the passed env, not the process env", () => {
  withProcessKey(undefined, () => {
    expect(
      resolveSummaryApiKey("anthropic", baseConfig, { ANTHROPIC_API_KEY: "session-key" }),
      "key from the passed env while the process env has none"
    ).toBe("session-key");
  });
  withProcessKey(FAKE_ENV_KEY, () => {
    expect(
      resolveSummaryApiKey("anthropic", baseConfig, { ANTHROPIC_API_KEY: "session-key" }),
      "the passed env wins over a different process env key"
    ).toBe("session-key");
    expect(
      resolveSummaryApiKey("anthropic", baseConfig, {}),
      "an env without the key yields null even when the process env carries one"
    ).toBeNull();
  });
});

test("resolveProvider: auto detection reads the passed env, not the process env", () => {
  withProcessKey(undefined, () => {
    expect(
      resolveProvider(baseConfig, { ANTHROPIC_API_KEY: "session-key" }),
      "key in the passed env while the process env has none"
    ).toBe("anthropic");
  });
  withProcessKey(FAKE_ENV_KEY, () => {
    expect(
      resolveProvider(baseConfig, {}),
      "an env without the key resolves to none even when the process env carries one"
    ).toBe("none");
  });
});

test("buildSummaryProviderConfig: provider and key both follow the passed env", () => {
  withProcessKey(FAKE_ENV_KEY, () => {
    const result = buildSummaryProviderConfig(baseConfig, {});
    expect(result.provider).toBe("none");
    expect(result.api_key).toBeNull();
  });
  withProcessKey(undefined, () => {
    const result = buildSummaryProviderConfig(baseConfig, { ANTHROPIC_API_KEY: "session-key" });
    expect(result.provider).toBe("anthropic");
    expect(result.api_key).toBe("session-key");
  });
});
