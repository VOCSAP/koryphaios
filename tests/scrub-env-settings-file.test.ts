import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scrubEnv } from "./_scrub-env.ts";
import { loadConfig } from "../shared/config.ts";

// Pins the difference scrubEnv exists for: a CLAUDE_PEERS_*-only filter
// leaves APPDATA/XDG_CONFIG_HOME untouched, so offline_replica still reaches
// loadConfig() from whatever settings file they resolve to.

const ENV_KEYS = ["XDG_CONFIG_HOME", "APPDATA", "CLAUDE_PEERS_OFFLINE_REPLICA"] as const;
let envSnapshot: Record<string, string | undefined> = {};
let ambientDir: string;
let scratchDir: string;

beforeEach(() => {
  envSnapshot = {};
  for (const k of ENV_KEYS) {
    envSnapshot[k] = process.env[k];
    delete process.env[k];
  }
  ambientDir = mkdtempSync(join(tmpdir(), "scrub-env-ambient-"));
  scratchDir = mkdtempSync(join(tmpdir(), "scrub-env-scratch-"));
  const cfgDir = join(ambientDir, "claude-peers");
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(join(cfgDir, "config.json"), JSON.stringify({ offline_replica: true }));
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (envSnapshot[k] === undefined) delete process.env[k];
    else process.env[k] = envSnapshot[k];
  }
  rmSync(ambientDir, { recursive: true, force: true });
  rmSync(scratchDir, { recursive: true, force: true });
});

test("a CLAUDE_PEERS_*-only filter leaks the ambient settings file's offline_replica", async () => {
  process.env.APPDATA = ambientDir;
  process.env.XDG_CONFIG_HOME = ambientDir;
  // Simulates the naive filter's own env record: it never touches these two
  // vars, so this IS what a spawned child would see under it.
  const cfg = await loadConfig();
  expect(cfg.offline_replica).toBe(true);
});

test("scrubEnv owns the settings-file half: the same ambient value never reaches loadConfig", async () => {
  process.env.APPDATA = ambientDir;
  process.env.XDG_CONFIG_HOME = ambientDir;
  const protectedEnv = scrubEnv(scratchDir);
  process.env.APPDATA = protectedEnv.APPDATA;
  process.env.XDG_CONFIG_HOME = protectedEnv.XDG_CONFIG_HOME;
  const cfg = await loadConfig();
  expect(cfg.offline_replica).toBe(false);
});

test("scrubEnv sets BOTH keys, regardless of which one this OS actually reads", () => {
  // settingsFilePath() reads exactly one of the two depending on platform;
  // pinning only the one this OS happens to read would leave the guard blind
  // on the other OS. Both must point at settingsDir unconditionally.
  const env = scrubEnv(scratchDir);
  expect(env.APPDATA).toBe(scratchDir);
  expect(env.XDG_CONFIG_HOME).toBe(scratchDir);
});

test("scrubEnv refuses an extra override that reinjects the real ambient value", () => {
  process.env.APPDATA = ambientDir;
  expect(() => scrubEnv(scratchDir, { APPDATA: ambientDir })).toThrow(/re-injects the real ambient APPDATA/);
});

test("an unset ambient var is never mistaken for reinjection just because extra omits it too", () => {
  delete process.env.APPDATA;
  expect(() => scrubEnv(scratchDir)).not.toThrow();
});

test("a legitimate override -- a DIFFERENT directory the caller owns -- still wins, unrefused", () => {
  process.env.APPDATA = ambientDir;
  const ownedDir = mkdtempSync(join(tmpdir(), "scrub-env-owned-"));
  try {
    const env = scrubEnv(scratchDir, { APPDATA: ownedDir });
    expect(env.APPDATA).toBe(ownedDir);
  } finally {
    rmSync(ownedDir, { recursive: true, force: true });
  }
});

test("an ambient Deck control URL, token or tool list never reaches a child, unless the caller sets it", () => {
  const keys = ["DECK_CONTROL_URL", "DECK_CONTROL_TOKEN", "DECK_CONTROL_TOOLS"] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    for (const k of keys) process.env[k] = `ambient-${k}`;
    const env = scrubEnv(scratchDir);
    for (const k of keys) expect(env[k], `${k} inherited from the tile running the tests`).toBeUndefined();
    expect(scrubEnv(scratchDir, { DECK_CONTROL_TOKEN: "set-by-caller" }).DECK_CONTROL_TOKEN).toBe("set-by-caller");
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});
