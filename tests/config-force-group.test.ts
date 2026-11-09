import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  resolveGroup,
  resolveGroupName,
  computeGroupId,
  computeGroupSecretHash,
} from "../shared/config.ts";

// M1: the Claude Peers Desk app forces its child sessions into an isolated group
// via CLAUDE_PEERS_FORCE_GROUP (env) or CLAUDE_PEERS_FORCE_GROUP_FILE (file, env
// wins). This branch is top-precedence in resolveGroup / resolveGroupName,
// bypassing project files, default_group and CLAUDE_PEERS_GROUP. These are unit
// tests on the resolver functions directly (no broker).
//
// Fixture group passphrases below are throwaway test strings, not real
// credentials.

const ENV_KEYS = [
  "CLAUDE_PEERS_FORCE_GROUP",
  "CLAUDE_PEERS_FORCE_GROUP_FILE",
  "CLAUDE_PEERS_FORCE_GROUP_NAME",
  "CLAUDE_PEERS_GROUP",
  "CLAUDE_PEERS_LOG_DIR",
] as const;

let envSnapshot: Record<string, string | undefined> = {};
let tmpDir: string;
// Fresh per-test log dir so the trace tests below never see a line left by
// a previous test (shared/logger.ts appends, it never truncates).
let logDir: string;

beforeEach(() => {
  envSnapshot = {};
  for (const k of ENV_KEYS) {
    envSnapshot[k] = process.env[k];
    delete process.env[k];
  }
  tmpDir = mkdtempSync(join(tmpdir(), "cp-force-"));
  logDir = join(tmpDir, "logs");
  process.env.CLAUDE_PEERS_LOG_DIR = logDir;
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

const FORCED = "forced-group-passphrase";

// A project dir holding a .claude-peers.json. Used to prove the forced branch
// overrides a competing project-file source.
function projectDirWithFile(group: string): string {
  const dir = mkdtempSync(join(tmpDir, "proj-"));
  writeFileSync(join(dir, ".claude-peers.json"), JSON.stringify({ group }), "utf-8");
  return dir;
}

test("forced env wins over project file, default_group and CLAUDE_PEERS_GROUP", () => {
  const dir = projectDirWithFile("from-project-file");
  process.env.CLAUDE_PEERS_GROUP = "from-env-group";
  process.env.CLAUDE_PEERS_FORCE_GROUP = FORCED;

  const userConfig = {
    groups: { "from-project-file": "pf-pass", team: "team-pass" },
    default_group: "team",
  };

  const name = resolveGroupName(dir, dir, userConfig, process.env);
  const resolved = resolveGroup(dir, dir, userConfig, process.env);

  expect(name).toBe(`forced-${computeGroupId(FORCED).slice(0, 8)}`);
  expect(resolved.name).toBe(name);
  expect(resolved.group_id).toBe(computeGroupId(FORCED));
});

test("forced file is used when only the file is set", () => {
  const passFile = join(tmpDir, "pass.txt");
  writeFileSync(passFile, FORCED, "utf-8");
  process.env.CLAUDE_PEERS_FORCE_GROUP_FILE = passFile;

  const resolved = resolveGroup(tmpDir, null, { groups: {}, default_group: null }, process.env);

  expect(resolved.group_id).toBe(computeGroupId(FORCED));
  expect(resolved.group_secret_hash).toBe(computeGroupSecretHash(FORCED));
});

test("env wins over file when both are set", () => {
  const passFile = join(tmpDir, "pass.txt");
  writeFileSync(passFile, "file-pass", "utf-8");
  process.env.CLAUDE_PEERS_FORCE_GROUP_FILE = passFile;
  process.env.CLAUDE_PEERS_FORCE_GROUP = "env-pass";

  const resolved = resolveGroup(tmpDir, null, { groups: {}, default_group: null }, process.env);

  expect(resolved.group_id).toBe(computeGroupId("env-pass"));
  expect(resolved.group_id).not.toBe(computeGroupId("file-pass"));
});

test("group_id and secret_hash match the compute helpers and are stable", () => {
  process.env.CLAUDE_PEERS_FORCE_GROUP = FORCED;
  const userConfig = { groups: {}, default_group: null };

  const a = resolveGroup(tmpDir, null, userConfig, process.env);
  const b = resolveGroup(tmpDir, null, userConfig, process.env);

  expect(a.group_id).toBe(computeGroupId(FORCED));
  expect(a.group_secret_hash).toBe(computeGroupSecretHash(FORCED));
  expect(a.group_id).toBe(b.group_id);
  expect(a.group_secret_hash).toBe(b.group_secret_hash);
});

test("groups_map injects the forced entry alongside default and user groups", () => {
  process.env.CLAUDE_PEERS_FORCE_GROUP = FORCED;

  const resolved = resolveGroup(tmpDir, null, {
    groups: { team: "team-pass" },
    default_group: null,
  }, process.env);

  // default + user group preserved
  expect(resolved.groups_map.default).toBe("default");
  expect(resolved.groups_map.team).toBe(computeGroupId("team-pass"));
  // forced entry present and consistent (the core acceptance criterion)
  expect(resolved.groups_map[resolved.name]).toBe(resolved.group_id);
});

test("CLAUDE_PEERS_FORCE_GROUP_NAME overrides the default forced name", () => {
  process.env.CLAUDE_PEERS_FORCE_GROUP = FORCED;
  process.env.CLAUDE_PEERS_FORCE_GROUP_NAME = "desk-scope-42";

  const resolved = resolveGroup(tmpDir, null, { groups: {}, default_group: null }, process.env);

  expect(resolved.name).toBe("desk-scope-42");
  expect(resolved.groups_map["desk-scope-42"]).toBe(resolved.group_id);
});

test("no forced env nor file: resolution is unchanged (backward-compat)", () => {
  const dir = projectDirWithFile("from-project-file");
  const userConfig = {
    groups: { "from-project-file": "pf-pass" },
    default_group: null,
  };

  const name = resolveGroupName(dir, dir, userConfig, process.env);
  const resolved = resolveGroup(dir, dir, userConfig, process.env);

  expect(name).toBe("from-project-file");
  expect(resolved.name).toBe("from-project-file");
  expect(resolved.group_id).toBe(computeGroupId("pf-pass"));
});

test("empty-string forced env is treated as unset", () => {
  process.env.CLAUDE_PEERS_FORCE_GROUP = "";
  const resolved = resolveGroup(tmpDir, null, { groups: {}, default_group: null }, process.env);

  // Falls through to the 'default' sentinel -- no forced group.
  expect(resolved.name).toBe("default");
  expect(resolved.group_id).toBe("default");
});

test("missing forced file falls through to normal resolution", () => {
  process.env.CLAUDE_PEERS_FORCE_GROUP_FILE = join(tmpDir, "does-not-exist.txt");
  const resolved = resolveGroup(tmpDir, null, { groups: {}, default_group: "team" }, process.env);

  // Default_group wins because the forced file is unreadable.
  expect(resolved.name).toBe("team");
});

// Card lot B: the missing-file and empty-file branches used to fall back to
// null in total silence (only the exception/EPERM branch logged). These three
// tests pin the trace shared/logger.ts now writes to <CLAUDE_PEERS_LOG_DIR>/config.log,
// including the negative control that the valid-file path stays silent.
function configLogPath(): string {
  return join(logDir, "config.log");
}

test("missing forced file leaves a warn trace in config.log", () => {
  const missing = join(tmpDir, "does-not-exist.txt");
  process.env.CLAUDE_PEERS_FORCE_GROUP_FILE = missing;

  const resolved = resolveGroup(tmpDir, null, { groups: {}, default_group: "team" }, process.env);

  expect(existsSync(configLogPath())).toBe(true);
  const content = readFileSync(configLogPath(), "utf-8");
  expect(content).toContain("WARN");
  expect(content).toContain("missing file");
  expect(content).toContain(missing);
  // Pin the return-value contract alongside the trace: default_group wins,
  // proving the missing-file branch actually returned null (not some truthy
  // placeholder) up through resolveForcedGroupSecret / resolveGroup.
  expect(resolved.name).toBe("team");
});

test("empty forced file leaves a warn trace in config.log", () => {
  const passFile = join(tmpDir, "empty.txt");
  writeFileSync(passFile, "   \n", "utf-8"); // trims to empty
  process.env.CLAUDE_PEERS_FORCE_GROUP_FILE = passFile;

  const resolved = resolveGroup(tmpDir, null, { groups: {}, default_group: "team" }, process.env);

  expect(existsSync(configLogPath())).toBe(true);
  const content = readFileSync(configLogPath(), "utf-8");
  expect(content).toContain("WARN");
  expect(content).toContain("is empty");
  expect(content).toContain(passFile);
  // Pin the return-value contract: default_group ("team") must win, which
  // only holds if the empty-file branch returned null rather than the
  // (empty-string, non-null) `content` it just computed. Returning `content`
  // there would make every empty-file session land in the same deterministic
  // forced group across machines, silently.
  expect(resolved.name).toBe("team");
});

test("unreadable forced file (directory) leaves an error trace in config.log", () => {
  const dirPath = join(tmpDir, "not-a-file");
  mkdirSync(dirPath);
  process.env.CLAUDE_PEERS_FORCE_GROUP_FILE = dirPath;

  const resolved = resolveGroup(tmpDir, null, { groups: {}, default_group: "team" }, process.env);

  expect(existsSync(configLogPath())).toBe(true);
  const content = readFileSync(configLogPath(), "utf-8");
  expect(content).toContain("ERROR");
  expect(content).toContain("failed to read");
  expect(content).toContain(dirPath);
  // Same return-value contract as the other two traced branches: the read
  // exception must fall through to null, not leak a truthy value.
  expect(resolved.name).toBe("team");
});

test("valid forced file produces no trace (negative control)", () => {
  const passFile = join(tmpDir, "pass.txt");
  writeFileSync(passFile, FORCED, "utf-8");
  process.env.CLAUDE_PEERS_FORCE_GROUP_FILE = passFile;

  const resolved = resolveGroup(tmpDir, null, { groups: {}, default_group: null }, process.env);

  expect(resolved.group_id).toBe(computeGroupId(FORCED));
  // No trace FILE created: the logger is lazy (ensureDir only runs on a
  // write), so the nominal path must not touch the filesystem. This only
  // asserts the file, not the containing log dir.
  expect(existsSync(configLogPath())).toBe(false);
});

test("file content is trimmed: trailing newline equals the bare env passphrase", () => {
  const passFile = join(tmpDir, "pass.txt");
  writeFileSync(passFile, `${FORCED}\n`, "utf-8");
  process.env.CLAUDE_PEERS_FORCE_GROUP_FILE = passFile;

  const fromFile = resolveGroup(tmpDir, null, { groups: {}, default_group: null }, process.env);
  expect(fromFile.group_id).toBe(computeGroupId(FORCED));
});

test("forced name colliding with a user group overwrites it with the forced id", () => {
  process.env.CLAUDE_PEERS_FORCE_GROUP = FORCED;
  const forcedName = `forced-${computeGroupId(FORCED).slice(0, 8)}`;

  const resolved = resolveGroup(tmpDir, null, {
    groups: { [forcedName]: "other-pass" },
    default_group: null,
  }, process.env);

  // Forced wins by design: the map entry is the forced group_id, not the
  // user-config group's id.
  expect(resolved.groups_map[forcedName]).toBe(resolved.group_id);
  expect(resolved.groups_map[forcedName]).not.toBe(computeGroupId("other-pass"));
});

const NO_USER_GROUPS = { groups: {}, default_group: null };

function poisonProcessEnv(): void {
  process.env.CLAUDE_PEERS_FORCE_GROUP = "daemon-secret";
  process.env.CLAUDE_PEERS_FORCE_GROUP_NAME = "daemon-name";
  process.env.CLAUDE_PEERS_GROUP = "daemon-group";
}

test("forced secret and derived name come from the passed env, not the process env", () => {
  poisonProcessEnv();

  const resolved = resolveGroup(tmpDir, null, NO_USER_GROUPS, { CLAUDE_PEERS_FORCE_GROUP: "session-secret" });

  expect(resolved.group_id, "group_id of the passed secret, not of the process env secret").toBe(
    computeGroupId("session-secret")
  );
  expect(resolved.group_secret_hash).toBe(computeGroupSecretHash("session-secret"));
  expect(resolved.name, "name derived from the passed secret, not the process env name").toBe(
    `forced-${computeGroupId("session-secret").slice(0, 8)}`
  );
  expect(resolveGroupName(tmpDir, null, NO_USER_GROUPS, { CLAUDE_PEERS_FORCE_GROUP: "session-secret" })).toBe(
    resolved.name
  );
});

test("forced group name comes from the passed env when both envs carry one", () => {
  poisonProcessEnv();
  const env = { CLAUDE_PEERS_FORCE_GROUP: "session-secret", CLAUDE_PEERS_FORCE_GROUP_NAME: "session-name" };

  expect(resolveGroup(tmpDir, null, NO_USER_GROUPS, env).name).toBe("session-name");
  expect(resolveGroupName(tmpDir, null, NO_USER_GROUPS, env)).toBe("session-name");
});

test("a passed env without a forced group is not forced by the process env", () => {
  poisonProcessEnv();

  const resolved = resolveGroup(tmpDir, null, NO_USER_GROUPS, {});

  expect(resolved.name).toBe("default");
  expect(resolved.group_id).toBe("default");
  expect(resolved.group_secret_hash).toBeNull();
  expect(resolveGroupName(tmpDir, null, NO_USER_GROUPS, {})).toBe("default");
});

test("forced secret file is the one named by the passed env, not the process env", () => {
  const sessionFile = join(tmpDir, "session-pass.txt");
  const daemonFile = join(tmpDir, "daemon-pass.txt");
  writeFileSync(sessionFile, "session-file-secret", "utf-8");
  writeFileSync(daemonFile, "daemon-file-secret", "utf-8");
  process.env.CLAUDE_PEERS_FORCE_GROUP_FILE = daemonFile;

  const fromSession = resolveGroup(tmpDir, null, NO_USER_GROUPS, { CLAUDE_PEERS_FORCE_GROUP_FILE: sessionFile });
  const withoutFile = resolveGroup(tmpDir, null, NO_USER_GROUPS, {});

  expect(fromSession.group_id).toBe(computeGroupId("session-file-secret"));
  expect(withoutFile.group_id, "a passed env without the file variable is not forced").toBe("default");
});

test("CLAUDE_PEERS_GROUP is read from the passed env, not the process env", () => {
  poisonProcessEnv();
  delete process.env.CLAUDE_PEERS_FORCE_GROUP;
  delete process.env.CLAUDE_PEERS_FORCE_GROUP_NAME;

  expect(resolveGroupName(tmpDir, null, NO_USER_GROUPS, { CLAUDE_PEERS_GROUP: "session-group" })).toBe(
    "session-group"
  );
  expect(
    resolveGroupName(tmpDir, null, NO_USER_GROUPS, {}),
    "a passed env without CLAUDE_PEERS_GROUP falls to the sentinel even when the process env sets one"
  ).toBe("default");
});
