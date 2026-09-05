import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { brokerMode, brokerUrl, type BrokerMode } from "../shared/config.ts";
import { deckBrokerMode, resolveBrokerEndpoint } from "../desktop/src/main/broker-client.ts";

// Guarantee: core (shared/config.ts) and the Deck (desktop/src/main/broker-client.ts)
// must NEVER disagree on the broker endpoint for a given config -- three
// clients (server.ts, cli.ts, the Deck) derive their endpoint independently,
// and a divergence here would mean the Deck talks to a different broker than
// the agent sessions on the same machine (docs/DESIGN-OFFLINE-REPLICA.md, 2.1).

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmpConfigFile(content: object): string {
  const dir = mkdtempSync(join(tmpdir(), "cp-parity-"));
  dirs.push(dir);
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(content), "utf-8");
  return path;
}

interface Scenario {
  label: string;
  fileConfig: { broker_url?: string; offline_replica?: boolean; port?: number };
  env: NodeJS.ProcessEnv;
  expectedMode: BrokerMode;
}

const PORT = 7899;

const SCENARIOS: Scenario[] = [
  {
    label: "local: no broker_url",
    fileConfig: {},
    env: {},
    expectedMode: "local",
  },
  {
    label: "remote: broker_url set, no opt-in",
    fileConfig: { broker_url: "http://broker-host:7899" },
    env: {},
    expectedMode: "remote",
  },
  {
    label: "replica: broker_url + offline_replica (file)",
    fileConfig: { broker_url: "http://broker-host:7899", offline_replica: true },
    env: {},
    expectedMode: "replica",
  },
  {
    label: "replica: broker_url (file) + CLAUDE_PEERS_OFFLINE_REPLICA=1 (env)",
    fileConfig: { broker_url: "http://broker-host:7899" },
    env: { CLAUDE_PEERS_OFFLINE_REPLICA: "1" },
    expectedMode: "replica",
  },
  {
    label: "remote: broker_url + offline_replica=true (file), overridden off by env",
    fileConfig: { broker_url: "http://broker-host:7899", offline_replica: true },
    env: { CLAUDE_PEERS_OFFLINE_REPLICA: "false" },
    expectedMode: "remote",
  },
  {
    label: "remote: env overrides broker_url too, still no opt-in",
    fileConfig: { broker_url: "http://file-host:7899" },
    env: { CLAUDE_PEERS_BROKER_URL: "http://env-host:7899" },
    expectedMode: "remote",
  },
];

for (const scenario of SCENARIOS) {
  test(`Deck and core agree on the broker endpoint for mode ${scenario.expectedMode} (${scenario.label})`, () => {
    const configPath = tmpConfigFile({ port: PORT, ...scenario.fileConfig });
    const env = { CLAUDE_PEERS_PORT: String(PORT), ...scenario.env } as unknown as NodeJS.ProcessEnv;

    const coreConfig = {
      broker_url: env.CLAUDE_PEERS_BROKER_URL ?? scenario.fileConfig.broker_url ?? null,
      offline_replica:
        env.CLAUDE_PEERS_OFFLINE_REPLICA !== undefined
          ? ["1", "true", "yes", "on"].includes(String(env.CLAUDE_PEERS_OFFLINE_REPLICA).toLowerCase())
          : scenario.fileConfig.offline_replica === true,
      port: PORT,
    };

    const coreMode = brokerMode(coreConfig);
    const coreUrl = brokerUrl(coreConfig);
    const deckMode = deckBrokerMode(env, configPath);
    const deckEndpoint = resolveBrokerEndpoint(env, configPath);

    expect(coreMode).toBe(scenario.expectedMode);
    expect(deckMode, `Deck and core disagree on the broker mode for mode ${scenario.expectedMode}`).toBe(coreMode);
    expect(deckEndpoint.url, `Deck and core disagree on the broker endpoint for mode ${scenario.expectedMode}`).toBe(
      coreUrl
    );
  });
}

test("directory with no config file at all: both sides agree on local/loopback", () => {
  const dir = mkdtempSync(join(tmpdir(), "cp-parity-missing-"));
  dirs.push(dir);
  const configPath = join(dir, "does-not-exist.json");
  const env = { CLAUDE_PEERS_PORT: "7899" } as unknown as NodeJS.ProcessEnv;

  const coreConfig = { broker_url: null, offline_replica: false, port: 7899 };
  const coreMode = brokerMode(coreConfig);
  const coreUrl = brokerUrl(coreConfig);

  expect(deckBrokerMode(env, configPath), "Deck and core disagree on the broker mode for mode local").toBe(coreMode);
  expect(
    resolveBrokerEndpoint(env, configPath).url,
    "Deck and core disagree on the broker endpoint for mode local"
  ).toBe(coreUrl);
});
