/**
 * Centralized configuration loader.
 *
 * Resolution order: env var > settings file > default.
 *
 * Settings file location:
 *   - Linux/macOS: $XDG_CONFIG_HOME/claude-peers/config.json
 *                  (default: ~/.config/claude-peers/config.json)
 *   - Windows:     %APPDATA%\claude-peers\config.json
 *
 * Settings file is JSON, all keys optional. See README for full schema.
 */

import { join, dirname, sep } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import type { GroupId } from "./types.ts";
import { createLogger, coreLogDir } from "./logger.ts";

export type SummaryProvider = "auto" | "anthropic" | "openai-compat" | "none";

export interface Config {
  /** Broker HTTP port. */
  port: number;
  /** SQLite DB path (broker side). */
  db: string;
  /** Auto-summary provider selection. "auto" resolves at call time. */
  summary_provider: SummaryProvider;
  /** Override base URL for openai-compat (e.g. LiteLLM/Ollama proxy). */
  summary_base_url: string | null;
  /** Override API key for the summary provider. */
  summary_api_key: string | null;
  /** Model name passed to the summary provider. */
  summary_model: string;
  /** v0.3 -- map of logical group name -> group secret. Empty means no groups configured. */
  groups: Record<string, string>;
  /** v0.3 -- default group name to use when no project file overrides. null means fall through to env then 'default' sentinel. */
  default_group: string | null;
  /** HTTP mode: direct broker URL (e.g. "http://my-server:7899"). Overrides loopback. */
  broker_url: string | null;
  /** HTTP mode: Bearer token required by the broker. Sent on all HTTP and WS-upgrade requests. */
  broker_token: string | null;
  /** Broker bind host. null = "127.0.0.1" (loopback only). Set "0.0.0.0" for public access. */
  bind_host: string | null;
}

interface FileConfig {
  port?: number;
  db?: string;
  summary_provider?: SummaryProvider;
  summary_base_url?: string;
  summary_api_key?: string;
  summary_model?: string;
  // Backward-compat alias for summary_model when provider is anthropic.
  anthropic_model?: string;
  groups?: Record<string, string>;
  default_group?: string;
  broker_url?: string;
  broker_token?: string;
  bind_host?: string;
}

const DEFAULT_ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";

function settingsFilePath(): string {
  if (process.platform === "win32") {
    const appdata = process.env.APPDATA;
    if (appdata) {
      return join(appdata, "claude-peers", "config.json");
    }
    return join(homedir(), "AppData", "Roaming", "claude-peers", "config.json");
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) {
    return join(xdg, "claude-peers", "config.json");
  }
  return join(homedir(), ".config", "claude-peers", "config.json");
}

async function readFileConfig(): Promise<FileConfig> {
  const path = settingsFilePath();
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) {
      return {};
    }
    const data = (await file.json()) as FileConfig;
    return data ?? {};
  } catch (e) {
    // Still boot on defaults (tolerant loader), but never silently: a malformed
    // config.json would otherwise mis-target the whole deployment (port,
    // broker_url, token) with no trace.
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[claude-peers] ignoring malformed config ${path}: ${msg} (using defaults)`);
    return {};
  }
}

function defaultDbPath(): string {
  if (process.platform === "linux" || process.platform === "darwin") {
    return process.env.CLAUDE_PEERS_DB ?? "/var/lib/claude-peers/peers.db";
  }
  return join(homedir(), ".claude-peers.db");
}

function parseProvider(value: string | undefined): SummaryProvider | null {
  if (!value) return null;
  const v = value.toLowerCase();
  if (v === "auto" || v === "anthropic" || v === "openai-compat" || v === "none") {
    return v;
  }
  return null;
}

/**
 * Load configuration. Tolerant of missing file. Always returns a complete Config.
 */
export async function loadConfig(): Promise<Config> {
  const fileCfg = await readFileConfig();

  const port = parseInt(
    process.env.CLAUDE_PEERS_PORT ?? String(fileCfg.port ?? 7899),
    10
  );

  const db = process.env.CLAUDE_PEERS_DB ?? fileCfg.db ?? defaultDbPath();

  const summary_provider: SummaryProvider =
    parseProvider(process.env.CLAUDE_PEERS_SUMMARY_PROVIDER) ??
    fileCfg.summary_provider ??
    "auto";

  const summary_base_url =
    process.env.CLAUDE_PEERS_SUMMARY_BASE_URL ??
    fileCfg.summary_base_url ??
    null;

  const summary_api_key =
    process.env.CLAUDE_PEERS_SUMMARY_API_KEY ??
    fileCfg.summary_api_key ??
    null;

  // Backward-compat: CLAUDE_PEERS_ANTHROPIC_MODEL and `anthropic_model` key.
  const summary_model =
    process.env.CLAUDE_PEERS_SUMMARY_MODEL ??
    process.env.CLAUDE_PEERS_ANTHROPIC_MODEL ??
    fileCfg.summary_model ??
    fileCfg.anthropic_model ??
    DEFAULT_ANTHROPIC_MODEL;

  const groups: Record<string, string> = fileCfg.groups ?? {};
  const default_group = fileCfg.default_group ?? null;
  const broker_url = process.env.CLAUDE_PEERS_BROKER_URL ?? fileCfg.broker_url ?? null;
  const broker_token = process.env.CLAUDE_PEERS_BROKER_TOKEN ?? fileCfg.broker_token ?? null;
  const bind_host = process.env.CLAUDE_PEERS_BIND_HOST ?? fileCfg.bind_host ?? null;

  return {
    port,
    db,
    summary_provider,
    summary_base_url,
    summary_api_key,
    summary_model,
    groups,
    default_group,
    broker_url,
    broker_token,
    bind_host,
  };
}

/**
 * Resolve the effective provider, taking "auto" into account.
 *
 * Auto-detection priority:
 *   1. summary_base_url defined  -> openai-compat
 *   2. summary_api_key OR ANTHROPIC_API_KEY defined -> anthropic
 *   3. otherwise -> none (heuristic only)
 */
export function resolveProvider(config: Config): Exclude<SummaryProvider, "auto"> {
  if (config.summary_provider !== "auto") return config.summary_provider;
  if (config.summary_base_url) return "openai-compat";
  if (config.summary_api_key || process.env.ANTHROPIC_API_KEY) return "anthropic";
  return "none";
}

/**
 * Build the broker URL from the resolved config.
 * If broker_url is set, use it directly (HTTP mode). Otherwise, loopback.
 */
export function brokerUrl(config: Config): string {
  if (config.broker_url) return config.broker_url;
  return `http://127.0.0.1:${config.port}`;
}

/**
 * Whether a broker URL points to the local loopback interface. Used to gate
 * the auto-spawn fallback in server.ts: only the local-only deployment may
 * legitimately spawn a broker daemon side by side with server.ts. In HTTP
 * mode the broker lives elsewhere, so a local spawn would just leak a zombie
 * process that does not serve the configured URL.
 */
export function isLoopbackBrokerUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
  } catch {
    return false;
  }
}

// --- v0.3: group resolution ---

const PROJECT_FILE = ".claude-peers.json";
const PROJECT_LOCAL_FILE = ".claude-peers.local.json";

// --- Forced group (Claude Peers Desk app, M1) ---
// The desktop app launches child Claude Code sessions pinned to an isolated
// group without writing a project file. The forced secret is transported via an
// env var or a chmod-600 file (env wins). When present it takes precedence over
// every other group source: project files, default_group, CLAUDE_PEERS_GROUP.

const FORCE_GROUP_ENV = "CLAUDE_PEERS_FORCE_GROUP";
const FORCE_GROUP_FILE_ENV = "CLAUDE_PEERS_FORCE_GROUP_FILE";
const FORCE_GROUP_NAME_ENV = "CLAUDE_PEERS_FORCE_GROUP_NAME";

/**
 * Resolve the forced group secret, if any. Reads CLAUDE_PEERS_FORCE_GROUP (env)
 * first; if unset or empty, reads the trimmed content of the file pointed at by
 * CLAUDE_PEERS_FORCE_GROUP_FILE. Returns null when neither yields a non-empty
 * secret. The three cases that fall through silently -- missing file, empty
 * file, or a read exception (e.g. EPERM) -- are traced at warn/error level via
 * shared/logger.ts's coreLogDir()-rooted "config.log". (The case where
 * CLAUDE_PEERS_FORCE_GROUP_FILE itself is unset falls through to null with no
 * trace at all: there is no path to read, so nothing to report.) This logger
 * is created with mirrorToConsole: false and each traced branch pairs its
 * log.warn/log.error call with its own explicit console.error -- the same
 * split server.ts uses for its own fileLog -- because an untouched logger's
 * console mirror would also carry a future log.info onto stdout, which
 * carries the MCP stdio protocol for stdio-mode callers. A session landing in
 * the wrong group leaves a record instead of a silent fallback to normal
 * group resolution.
 */
function resolveForcedGroupSecret(): string | null {
  const envSecret = process.env[FORCE_GROUP_ENV];
  if (envSecret && envSecret.length > 0) return envSecret;

  const filePath = process.env[FORCE_GROUP_FILE_ENV];
  if (filePath && filePath.length > 0) {
    const log = createLogger({ dir: coreLogDir(), name: "config", mirrorToConsole: false }).child(
      "config"
    );
    try {
      if (!existsSync(filePath)) {
        const msg = `${FORCE_GROUP_FILE_ENV} points at a missing file, falling through to normal group resolution: ${filePath}`;
        console.error(`[claude-peers] ${msg}`);
        log.warn(msg);
        return null;
      }
      const content = readFileSync(filePath, "utf-8").trim();
      if (content.length === 0) {
        const msg = `${FORCE_GROUP_FILE_ENV} file is empty, falling through to normal group resolution: ${filePath}`;
        console.error(`[claude-peers] ${msg}`);
        log.warn(msg);
        return null;
      }
      return content;
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      const msg = `failed to read ${FORCE_GROUP_FILE_ENV} ${filePath}: ${errMsg}`;
      console.error(`[claude-peers] ${msg}`);
      log.error(msg);
      return null;
    }
  }
  return null;
}

/**
 * Derive the display name for a forced group. Uses CLAUDE_PEERS_FORCE_GROUP_NAME
 * when provided, otherwise a deterministic `forced-<group_id slice 0,8>`.
 */
function forcedGroupName(secret: string): string {
  const envName = process.env[FORCE_GROUP_NAME_ENV];
  if (envName && envName.length > 0) return envName;
  return `forced-${computeGroupId(secret).slice(0, 8)}`;
}

/**
 * Build the public name -> group_id map (no secrets) for server.ts inversion.
 * Always includes the 'default' sentinel plus every user-config group.
 */
function buildGroupsMap(groups: Record<string, string>): Record<string, GroupId> {
  const groups_map: Record<string, GroupId> = { default: "default" };
  for (const [n, s] of Object.entries(groups)) {
    groups_map[n] = computeGroupId(s);
  }
  return groups_map;
}

/**
 * Read a project file (.claude-peers.json or .local.json) and return the validated `group` field.
 * Returns null if the file doesn't exist, is malformed, or has no `group` field.
 * Logs a warning on stderr if the file contains unknown fields (rejects them but keeps `group`).
 */
function readProjectFile(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      console.error(`[claude-peers] ${path}: expected JSON object, ignoring`);
      return null;
    }
    const obj = parsed as Record<string, unknown>;
    const allowedKeys = new Set(["group"]);
    for (const key of Object.keys(obj)) {
      if (!allowedKeys.has(key)) {
        console.error(`[claude-peers] ${path}: unknown field '${key}' (only 'group' is allowed), ignoring`);
      }
    }
    const group = obj.group;
    if (typeof group !== "string" || group.length === 0) return null;
    return group;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[claude-peers] failed to read ${path}: ${msg}`);
    return null;
  }
}

/**
 * Walk upwards from `start` to find a file named `filename`, stopping at the boundary
 * (`gitRoot` parent if provided, otherwise filesystem root). Returns the path or null.
 */
function findUpwards(start: string, filename: string, gitRoot: string | null): string | null {
  let current = start;
  let prev: string | null = null;
  const stopAt = gitRoot ? dirname(gitRoot) : null;
  while (current !== prev) {
    const candidate = join(current, filename);
    if (existsSync(candidate)) return candidate;
    if (stopAt !== null && current === gitRoot) {
      // Walked up to git_root; check it then stop.
      return null;
    }
    prev = current;
    current = dirname(current);
    // dirname of root returns the same path, terminating the loop.
    if (stopAt !== null && current === stopAt) {
      // Don't walk above git_root's parent.
      return null;
    }
  }
  return null;
}

/**
 * Resolve the effective group name for a given cwd.
 * Order (first wins):
 *   0. forced group (CLAUDE_PEERS_FORCE_GROUP env or _FILE) -- app top-precedence
 *   1. .claude-peers.local.json (walking up to git_root)
 *   2. .claude-peers.json       (walking up to git_root)
 *   3. user config `default_group`
 *   4. env var CLAUDE_PEERS_GROUP
 *   5. sentinel 'default'
 */
export function resolveGroupName(
  cwd: string,
  gitRoot: string | null,
  userConfig: Pick<Config, "default_group">
): string {
  const forced = resolveForcedGroupSecret();
  if (forced !== null) return forcedGroupName(forced);

  const localFile = findUpwards(cwd, PROJECT_LOCAL_FILE, gitRoot);
  if (localFile) {
    const name = readProjectFile(localFile);
    if (name) return name;
  }
  const projectFile = findUpwards(cwd, PROJECT_FILE, gitRoot);
  if (projectFile) {
    const name = readProjectFile(projectFile);
    if (name) return name;
  }
  if (userConfig.default_group) return userConfig.default_group;
  const envGroup = process.env.CLAUDE_PEERS_GROUP;
  if (envGroup && envGroup.length > 0) return envGroup;
  return "default";
}

/**
 * Look up a group secret by name in the user config. Returns null if the name
 * is the literal sentinel 'default', or if the name is not defined in the dictionary.
 * Logs a warning on stderr in the latter case so the user understands the fallback.
 */
export function resolveGroupSecret(
  name: string,
  userConfig: Pick<Config, "groups">
): string | null {
  if (name === "default") return null;
  const secret = userConfig.groups[name];
  if (typeof secret === "string" && secret.length > 0) return secret;
  console.error(
    `[claude-peers] group '${name}' resolved but no secret defined in user config; falling back to 'default'`
  );
  return null;
}

/**
 * Compute the group_id from a secret. The 'default' sentinel returns 'default'.
 * Otherwise: sha256(secret) hex, truncated to 32 chars (matches the spec section 4.5).
 */
export function computeGroupId(secret: string | null): GroupId {
  if (secret === null) return "default";
  return createHash("sha256").update(secret, "utf-8").digest("hex").slice(0, 32);
}

/**
 * Compute the full sha256 hex of a secret, used by the broker for TOFU validation.
 * null secret -> null (the 'default' group has secret_hash NULL in SQL).
 */
export function computeGroupSecretHash(secret: string | null): string | null {
  if (secret === null) return null;
  return createHash("sha256").update(secret, "utf-8").digest("hex");
}

/**
 * One-shot helper: resolve the group from cwd/gitRoot and produce all artefacts
 * needed for the handshake.
 */
export function resolveGroup(
  cwd: string,
  gitRoot: string | null,
  userConfig: Pick<Config, "groups" | "default_group">
): { name: string; group_id: GroupId; group_secret_hash: string | null; groups_map: Record<string, GroupId> } {
  // Top precedence: the desktop app forces an isolated group via env/file. This
  // bypasses project files, default_group and CLAUDE_PEERS_GROUP entirely.
  const forced = resolveForcedGroupSecret();
  if (forced !== null) {
    const group_id = computeGroupId(forced);
    const group_secret_hash = computeGroupSecretHash(forced);
    const name = forcedGroupName(forced);
    const groups_map = buildGroupsMap(userConfig.groups);
    // Inject the forced name so server.ts groupNameForId reverse-lookup resolves
    // it instead of falling back to '<unknown>'. Forced wins on name collision.
    groups_map[name] = group_id;
    return { name, group_id, group_secret_hash, groups_map };
  }

  const name = resolveGroupName(cwd, gitRoot, userConfig);
  const secret = resolveGroupSecret(name, userConfig);
  const group_id = computeGroupId(secret);
  const group_secret_hash = computeGroupSecretHash(secret);
  const groups_map = buildGroupsMap(userConfig.groups);

  return { name, group_id, group_secret_hash, groups_map };
}
