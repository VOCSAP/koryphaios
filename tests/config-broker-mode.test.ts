import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  "CLAUDE_PEERS_DELEGATION_MAX_REARMS",
  "CLAUDE_PEERS_DELEGATION_LEAD_SILENCE_SEC",
  "CLAUDE_PEERS_DELEGATION_MAX_DEADLINE_SEC",
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
  // Both vars point at the fixture dir: settingsFilePath() reads APPDATA on
  // win32 and XDG_CONFIG_HOME on every other platform, never both, so this
  // is the only way to keep the test off the operator's real config file
  // regardless of which OS runs it.
  process.env.XDG_CONFIG_HOME = tmpDir;
  process.env.APPDATA = tmpDir;
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

/** Built from bytes: a literal BOM in this source would make git treat the
 * file as binary. */
function writeConfigFileWithBom(content: object): void {
  const dir = join(tmpDir, "claude-peers");
  mkdirSync(dir, { recursive: true });
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  const json = Buffer.from(JSON.stringify(content), "utf-8");
  writeFileSync(join(dir, "config.json"), Buffer.concat([bom, json]));
}

/** PowerShell 5.1 `Out-File`/`>` write UTF-16LE with this BOM by default. */
function writeConfigFileUtf16LEBom(content: object): void {
  const dir = join(tmpDir, "claude-peers");
  mkdirSync(dir, { recursive: true });
  const bom = Buffer.from([0xff, 0xfe]);
  const json = Buffer.from(JSON.stringify(content), "utf16le");
  writeFileSync(join(dir, "config.json"), Buffer.concat([bom, json]));
}

function writeConfigFileUtf16BEBom(content: object): void {
  const dir = join(tmpDir, "claude-peers");
  mkdirSync(dir, { recursive: true });
  const le = Buffer.from(JSON.stringify(content), "utf16le");
  const be = Buffer.alloc(le.length);
  for (let i = 0; i + 1 < le.length; i += 2) {
    be[i] = le[i + 1];
    be[i + 1] = le[i];
  }
  const bom = Buffer.from([0xfe, 0xff]);
  writeFileSync(join(dir, "config.json"), Buffer.concat([bom, be]));
}

function writeConfigFileUtf16LENoBom(content: object): void {
  const dir = join(tmpDir, "claude-peers");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), Buffer.from(JSON.stringify(content), "utf16le"));
}

function writeConfigFileAsDirectory(): void {
  const dir = join(tmpDir, "claude-peers");
  mkdirSync(join(dir, "config.json"), { recursive: true });
}

/** Reads the trace `readFileConfig` writes on a load failure, "" if none. */
function readConfigLogContent(): string {
  try {
    return readFileSync(join(tmpDir, "claude-peers", "logs", "config.log"), "utf-8");
  } catch {
    return "";
  }
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

test("loadConfig: a config.json with a leading UTF-8 BOM still loads (F1), not a silent fallback to defaults", async () => {
  writeConfigFileWithBom({ port: 4321, groups: { alpha: "s3cr3t" } });
  const cfg = await loadConfig();
  expect(cfg.port).toBe(4321);
  expect(cfg.groups).toEqual({ alpha: "s3cr3t" });
});

test("loadConfig: a config.json written as UTF-16LE with BOM (PowerShell Out-File default) still loads its values", async () => {
  writeConfigFileUtf16LEBom({ port: 4321, groups: { alpha: "s3cr3t" } });
  const cfg = await loadConfig();
  expect(cfg.port).toBe(4321);
  expect(cfg.groups).toEqual({ alpha: "s3cr3t" });
});

test("loadConfig: a UTF-16BE config.json falls back to defaults and traces the failure, not a silent {}", async () => {
  writeConfigFileUtf16BEBom({ port: 4321 });
  const cfg = await loadConfig();
  expect(cfg.port).toBe(7899);
  expect(readConfigLogContent()).toContain("ignoring malformed config");
});

test("loadConfig: a UTF-16LE config.json without a BOM falls back to defaults and traces the failure, not a silent {}", async () => {
  writeConfigFileUtf16LENoBom({ port: 4321 });
  const cfg = await loadConfig();
  expect(cfg.port).toBe(7899);
  expect(readConfigLogContent()).toContain("ignoring malformed config");
});

test("loadConfig: a config.json path that is a directory falls back to defaults and names the real cause", async () => {
  writeConfigFileAsDirectory();
  const cfg = await loadConfig();
  expect(cfg.port).toBe(7899);
  expect(readConfigLogContent()).toContain("is a directory, not a file");
});

test("loadConfig: delegation policy defaults are available and identify their source", async () => {
  const cfg = await loadConfig();
  expect(cfg.delegation_policy).toMatchObject({
    available: true,
    values: { max_rearms: 3, lead_silence_sec: 300, max_deadline_sec: 14_400 },
    sources: { max_rearms: "default", lead_silence_sec: "default", max_deadline_sec: "default" },
    diagnostics: [],
  });
  expect(cfg.delegation_policy.config_path_fingerprint).toMatch(/^[0-9a-f]{64}$/);
});

test("loadConfig: delegation policy reads bounded file values", async () => {
  writeConfigFile({
    delegation_max_rearms: 4,
    delegation_lead_silence_sec: 600,
    delegation_max_deadline_sec: 1_200,
  });
  const cfg = await loadConfig();
  expect(cfg.delegation_policy).toMatchObject({
    available: true,
    values: { max_rearms: 4, lead_silence_sec: 600, max_deadline_sec: 1_200 },
    sources: { max_rearms: "file", lead_silence_sec: "file", max_deadline_sec: "file" },
  });
});

test("loadConfig: each strict delegation environment key overrides its file value", async () => {
  writeConfigFile({
    delegation_max_rearms: 4,
    delegation_lead_silence_sec: 600,
    delegation_max_deadline_sec: 1_200,
  });
  process.env.CLAUDE_PEERS_DELEGATION_MAX_REARMS = "5";
  process.env.CLAUDE_PEERS_DELEGATION_LEAD_SILENCE_SEC = "601";
  process.env.CLAUDE_PEERS_DELEGATION_MAX_DEADLINE_SEC = "1201";
  const cfg = await loadConfig();
  expect(cfg.delegation_policy).toMatchObject({
    available: true,
    values: { max_rearms: 5, lead_silence_sec: 601, max_deadline_sec: 1_201 },
    sources: { max_rearms: "env", lead_silence_sec: "env", max_deadline_sec: "env" },
  });
});

test("loadConfig: delegation policy accepts the documented bounds for every key", async () => {
  const cases = [
    { fileKey: "delegation_max_rearms", valueKey: "max_rearms", min: 0, max: 10 },
    { fileKey: "delegation_lead_silence_sec", valueKey: "lead_silence_sec", min: 15, max: 3_600 },
    { fileKey: "delegation_max_deadline_sec", valueKey: "max_deadline_sec", min: 1, max: 86_400 },
  ] as const;
  for (const entry of cases) {
    for (const value of [entry.min, entry.max]) {
      writeConfigFile({ [entry.fileKey]: value });
      const cfg = await loadConfig();
      expect(cfg.delegation_policy.available).toBeTrue();
      expect(cfg.delegation_policy.values[entry.valueKey]).toBe(value);
      expect(cfg.delegation_policy.sources[entry.valueKey]).toBe("file");
    }
  }
});

test("marks the delegation policy unavailable for every invalid file/environment key", async () => {
  const cases = [
    { fileKey: "delegation_max_rearms", envKey: "CLAUDE_PEERS_DELEGATION_MAX_REARMS", valueKey: "max_rearms", invalidFile: 11, validFile: 4, invalidEnv: "04" },
    { fileKey: "delegation_lead_silence_sec", envKey: "CLAUDE_PEERS_DELEGATION_LEAD_SILENCE_SEC", valueKey: "lead_silence_sec", invalidFile: 14, validFile: 600, invalidEnv: "0600" },
    { fileKey: "delegation_max_deadline_sec", envKey: "CLAUDE_PEERS_DELEGATION_MAX_DEADLINE_SEC", valueKey: "max_deadline_sec", invalidFile: 86_401, validFile: 1_200, invalidEnv: "01200" },
  ] as const;
  for (const entry of cases) {
    writeConfigFile({ [entry.fileKey]: entry.invalidFile });
    const fileCfg = await loadConfig();
    expect(fileCfg.port).toBe(7899);
    expect(fileCfg.delegation_policy.available).toBeFalse();
    expect(fileCfg.delegation_policy.diagnostics.join(" ")).toContain(entry.valueKey);

    writeConfigFile({ [entry.fileKey]: entry.validFile });
    process.env[entry.envKey] = entry.invalidEnv;
    const envCfg = await loadConfig();
    expect(envCfg.delegation_policy.available).toBeFalse();
    expect(envCfg.delegation_policy.diagnostics.join(" ")).toContain("environment");
    delete process.env[entry.envKey];
  }
});
