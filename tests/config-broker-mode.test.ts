import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { brokerMode, brokerUrl, upstreamUrl, parseBooleanFlag, loadConfig } from "../shared/config.ts";

// Lot B: brokerMode is the single decision of which of the three deployment
// shapes (local / remote / replica) a config describes -- brokerUrl,
// upstreamUrl, server.ts's ensureBroker and the Deck's resolveBrokerEndpoint
// all derive from it, so these pin the decision table directly against
// docs/DESIGN-OFFLINE-REPLICA.md section 2.1.

test("brokerMode: no broker_url -> local", () => {
  expect(brokerMode({ broker_url: null, offline_replica: false })).toBe("local");
  // offline_replica alone, without a broker_url, never implies replication
  // (DESIGN-OFFLINE-REPLICA.md 2.1: the remote URL is a NECESSARY condition).
  expect(brokerMode({ broker_url: null, offline_replica: true })).toBe("local");
});

test("brokerMode: broker_url without the opt-in -> remote", () => {
  expect(brokerMode({ broker_url: "http://broker-host:7899", offline_replica: false })).toBe("remote");
});

test("brokerMode: broker_url WITH the opt-in -> replica", () => {
  expect(brokerMode({ broker_url: "http://broker-host:7899", offline_replica: true })).toBe("replica");
});

test("brokerUrl: local mode is loopback on the configured port", () => {
  const url = brokerUrl({ broker_url: null, offline_replica: false, port: 7912 });
  expect(url).toBe("http://127.0.0.1:7912");
});

test("brokerUrl: remote mode points clients at broker_url directly", () => {
  const url = brokerUrl({ broker_url: "http://broker-host:7899", offline_replica: false, port: 7899 });
  expect(url).toBe("http://broker-host:7899");
});

test("brokerUrl: replica mode keeps clients on loopback, NOT broker_url", () => {
  const url = brokerUrl({ broker_url: "http://broker-host:7899", offline_replica: true, port: 7899 });
  expect(url).toBe("http://127.0.0.1:7899");
});

test("upstreamUrl: null in local and remote mode", () => {
  expect(upstreamUrl({ broker_url: null, offline_replica: false })).toBeNull();
  expect(upstreamUrl({ broker_url: "http://broker-host:7899", offline_replica: false })).toBeNull();
});

test("upstreamUrl: broker_url in replica mode (the local broker's upstream)", () => {
  expect(upstreamUrl({ broker_url: "http://broker-host:7899", offline_replica: true })).toBe(
    "http://broker-host:7899"
  );
});

// --- parseBooleanFlag: the env parsing every offline_replica read goes through ---

test("parseBooleanFlag: unset env falls back to the file value", () => {
  expect(parseBooleanFlag(undefined, true)).toBe(true);
  expect(parseBooleanFlag(undefined, false)).toBe(false);
});

test("parseBooleanFlag: accepted truthy spellings, case-insensitive, trimmed", () => {
  for (const v of ["1", "true", "TRUE", " yes ", "On"]) {
    expect(parseBooleanFlag(v, false)).toBe(true);
  }
});

test("parseBooleanFlag: accepted falsy spellings", () => {
  for (const v of ["0", "false", "FALSE", " no ", "Off"]) {
    expect(parseBooleanFlag(v, true)).toBe(false);
  }
});

test("parseBooleanFlag: garbage/typo falls back to the file value rather than defaulting true or false", () => {
  expect(parseBooleanFlag("maybe", true)).toBe(true);
  expect(parseBooleanFlag("maybe", false)).toBe(false);
  expect(parseBooleanFlag("", true)).toBe(true);
  expect(parseBooleanFlag("", false)).toBe(false);
});

// --- loadConfig() end-to-end: env > file > default, via XDG_CONFIG_HOME ---

const ENV_KEYS = [
  "XDG_CONFIG_HOME",
  "APPDATA",
  "CLAUDE_PEERS_OFFLINE_REPLICA",
  "CLAUDE_PEERS_SERVE_REPLICAS",
  "CLAUDE_PEERS_BROKER_URL",
  "CLAUDE_PEERS_PORT",
] as const;

let envSnapshot: Record<string, string | undefined> = {};
let tmpDir: string;

beforeEach(() => {
  envSnapshot = {};
  for (const k of ENV_KEYS) {
    envSnapshot[k] = process.env[k];
    delete process.env[k];
  }
  tmpDir = mkdtempSync(join(tmpdir(), "cp-broker-mode-"));
  process.env.XDG_CONFIG_HOME = tmpDir;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (envSnapshot[k] === undefined) delete process.env[k];
    else process.env[k] = envSnapshot[k];
  }
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

function writeConfigFile(content: object): void {
  const dir = join(tmpDir, "claude-peers");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify(content), "utf-8");
}

test("loadConfig: no offline_replica key in the file defaults to false (local/remote unaffected)", async () => {
  writeConfigFile({ broker_url: "http://broker-host:7899" });
  const cfg = await loadConfig();
  expect(cfg.offline_replica).toBe(false);
  expect(brokerMode(cfg)).toBe("remote");
});

test("loadConfig: offline_replica: true in the file is picked up and yields replica mode", async () => {
  writeConfigFile({ broker_url: "http://broker-host:7899", offline_replica: true });
  const cfg = await loadConfig();
  expect(cfg.offline_replica).toBe(true);
  expect(brokerMode(cfg)).toBe("replica");
  expect(brokerUrl(cfg)).toBe(`http://127.0.0.1:${cfg.port}`);
  expect(upstreamUrl(cfg)).toBe("http://broker-host:7899");
});

test("loadConfig: CLAUDE_PEERS_OFFLINE_REPLICA env overrides the file value in both directions", async () => {
  writeConfigFile({ broker_url: "http://broker-host:7899", offline_replica: true });
  process.env.CLAUDE_PEERS_OFFLINE_REPLICA = "0";
  let cfg = await loadConfig();
  expect(cfg.offline_replica).toBe(false);
  expect(brokerMode(cfg)).toBe("remote");

  writeConfigFile({ broker_url: "http://broker-host:7899" });
  process.env.CLAUDE_PEERS_OFFLINE_REPLICA = "yes";
  cfg = await loadConfig();
  expect(cfg.offline_replica).toBe(true);
  expect(brokerMode(cfg)).toBe("replica");
});

test("loadConfig: a garbage env value falls back to the file value, not to a hardcoded default", async () => {
  writeConfigFile({ broker_url: "http://broker-host:7899", offline_replica: true });
  process.env.CLAUDE_PEERS_OFFLINE_REPLICA = "banana";
  const cfg = await loadConfig();
  expect(cfg.offline_replica).toBe(true);
});

// --- serve_replicas: the upstream ROLE, decided apart from holding a token ---

test("loadConfig: no serve_replicas key defaults to false, even on a broker that has a token", async () => {
  writeConfigFile({ broker_token: "a-token" });
  const cfg = await loadConfig();
  expect(
    cfg.serve_replicas,
    "a configured broker_token must not by itself turn a broker into an upstream"
  ).toBe(false);
});

test("loadConfig: serve_replicas: true in the file is picked up", async () => {
  writeConfigFile({ broker_token: "a-token", serve_replicas: true });
  const cfg = await loadConfig();
  expect(cfg.serve_replicas).toBe(true);
});

test("loadConfig: CLAUDE_PEERS_SERVE_REPLICAS overrides the file value in both directions", async () => {
  writeConfigFile({ serve_replicas: true });
  process.env.CLAUDE_PEERS_SERVE_REPLICAS = "0";
  let cfg = await loadConfig();
  expect(cfg.serve_replicas).toBe(false);

  writeConfigFile({});
  process.env.CLAUDE_PEERS_SERVE_REPLICAS = "yes";
  cfg = await loadConfig();
  expect(cfg.serve_replicas).toBe(true);
});

test("loadConfig: a garbage CLAUDE_PEERS_SERVE_REPLICAS falls back to the file value, never to a hardcoded true", async () => {
  writeConfigFile({ serve_replicas: true });
  process.env.CLAUDE_PEERS_SERVE_REPLICAS = "banana";
  expect((await loadConfig()).serve_replicas).toBe(true);

  writeConfigFile({ serve_replicas: false });
  process.env.CLAUDE_PEERS_SERVE_REPLICAS = "banana";
  expect(
    (await loadConfig()).serve_replicas,
    "a mistyped env value must never grant the upstream role a config withholds"
  ).toBe(false);
});

test("serve_replicas is independent of the mode: replica and remote read it the same way", async () => {
  writeConfigFile({ broker_url: "http://broker-host:7899", offline_replica: true, serve_replicas: true });
  const cfg = await loadConfig();
  expect(brokerMode(cfg)).toBe("replica");
  // The loader records the operator's answer verbatim; refusing to ACT on it
  // is the broker's decision, asserted in tests/broker-roadmap-sync-routes.
  expect(cfg.serve_replicas).toBe(true);
});
