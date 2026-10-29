import { createHash } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { canonicalConfigPath } from "./canonical-config-path.ts";

// Atomic cache write (M-LOG-1 / N-MNT-5): write to a per-process temp file then
// rename, so a torn write or two sessions racing on the shared per-cwd legacy
// file can never leave a partial id for a reader to pick up. The temp name is
// pid-scoped so concurrent writers do not clobber each other's temp.
async function writeCacheAtomic(target: string, data: string): Promise<void> {
  const tmp = `${target}.${process.pid}.tmp`;
  // 0o600: computeGroupId (shared/config.ts) is sha256(secret).slice(0,32),
  // the first half of group_secret_hash -- a world-readable identity file
  // would hand any other local user an offline verification oracle on the
  // group secret. POSIX-only: NTFS has no permission bits, so on Windows
  // this mode is a no-op and the file's real protection is the user profile's
  // own ACLs (measured -- st.mode reads 0o666 regardless of what is asked for).
  await writeFile(tmp, data, { encoding: "utf-8", mode: 0o600 });
  try {
    await rename(tmp, target);
  } catch (e) {
    try {
      await unlink(tmp);
    } catch (cleanupError) {
      throw new AggregateError([e, cleanupError], "Could not replace the identity cache or remove its temporary file");
    }
    throw e;
  }
}

/**
 * Must exactly replicate the equivalent bash logic in the status-line script:
 * replace every non-[A-Za-z0-9-] character with "_", then keep the last 40
 * characters (or the whole string if shorter).
 * The explicit offset avoids an MSYS2 bash 5.2 quirk where ${str: -40} returns
 * empty when the string is shorter than 40 chars.
 */
export function computeCwdKey(cwd: string): string {
  const sanitized = cwd.replace(/[^a-zA-Z0-9-]/g, "_");
  return sanitized.length > 40 ? sanitized.slice(sanitized.length - 40) : sanitized;
}

/**
 * Returns true when the env var CLAUDE_PEERS_STATUS_LINE_CACHE is set to a
 * truthy value ("1", "true", "yes", "on" -- case-insensitive). Off by default
 * because the cache file is only useful for users who wire a status-line script
 * (e.g. vocsap/claude-config status-line.sh) and most users will not want
 * server.ts to litter $HOME.
 */
export function isPeerIdCacheEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.CLAUDE_PEERS_STATUS_LINE_CACHE;
  if (!raw) return false;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

/**
 * Sanitize a Claude Code session id (typically a UUID v4) so it can be used as
 * a filename suffix. Defensive: keeps [A-Za-z0-9-], replaces anything else
 * with "_", caps length to 64 to avoid pathological inputs. Returns "" for
 * empty/undefined input.
 */
export function sanitizeSessionId(sessionId: string | undefined | null): string {
  if (!sessionId) return "";
  const clean = sessionId.replace(/[^A-Za-z0-9-]/g, "_");
  return clean.length > 64 ? clean.slice(0, 64) : clean;
}

/**
 * Filename of the Deck back-channel file for a per-tile token. The Deck injects
 * a unique CLAUDE_PEERS_DESK_SESSION token per terminal tile; server.ts writes
 * the REAL minted CLAUDE_CODE_SESSION_ID here at /register so the Deck can map a
 * tile to its exact session id deterministically (no transcript-diff guessing).
 * Lives in the same ~/.claude/peers dir as the peer-id cache.
 */
export function deskSessionFileName(token: string): string {
  return `desk-session-${sanitizeSessionId(token)}.txt`;
}

/**
 * Which writer produced a back-channel value: `register` for server.ts, the
 * SessionStart payload's own source for the hook. A claude child launched
 * from a tile inherits the tile's token, so the Deck needs the writer to tell
 * the tile's /clear or compaction from a child's /register.
 */
export type DeskSessionSource = "register" | "startup" | "resume" | "clear" | "compact";

export interface DeskSessionRecord {
  sid: string;
  source: DeskSessionSource;
}

/**
 * Write the Deck back-channel file, as JSON {sid, source}, for an
 * already-resolved token. No-op when the token or the sid is empty.
 * Best-effort: failures are silent so callers never break their own flow.
 * Shared by writeDeskSessionId (env-driven, from server.ts at /register) and
 * the SessionStart hook (payload-driven, which also fires on /clear and
 * compaction -- the rotations server.ts cannot observe).
 */
export async function writeDeskSessionFile(
  token: string,
  record: DeskSessionRecord,
  home: string = homedir(),
): Promise<void> {
  const safeToken = sanitizeSessionId(token);
  const id = (record.sid ?? "").trim();
  if (!safeToken || !id) return;
  try {
    const cacheDir = join(home, ".claude", "peers");
    await mkdir(cacheDir, { recursive: true });
    await writeCacheAtomic(
      join(cacheDir, deskSessionFileName(safeToken)),
      JSON.stringify({ sid: id, source: record.source }),
    );
  } catch {
    // best-effort: the Deck falls back to transcript discovery if absent
  }
}

/**
 * No-op unless both CLAUDE_PEERS_DESK_SESSION and CLAUDE_CODE_SESSION_ID are
 * set; writes the real session id to
 * $HOME/.claude/peers/desk-session-<token>.txt, overwritten on every /register.
 * Best-effort: failures are silent so it never breaks /register.
 * Cannot observe an in-process session-id rotation (e.g. /clear) since
 * CLAUDE_CODE_SESSION_ID is frozen for the process lifetime; the SessionStart
 * hook covers those rotations instead.
 */
export async function writeDeskSessionId(
  home: string = homedir(),
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  await writeDeskSessionFile(
    env.CLAUDE_PEERS_DESK_SESSION ?? "",
    { sid: env.CLAUDE_CODE_SESSION_ID ?? "", source: "register" },
    home,
  );
}

export function sessionIdentityFileName(token: string): string {
  return `session-identity-${sanitizeSessionId(token)}.json`;
}

export function globalSessionIdentityFileName(messagingSocket: string): string {
  const hash = createHash("sha256").update(messagingSocket).digest("hex");
  return `global-session-identity-${hash}.json`;
}

export interface InboxBindingConfirmation {
  version: 1;
  runRef: string;
  groupId: string;
}

export interface WindowsWriterGeneration {
  platform: "win32";
  pid: number;
  creationUtc: string;
}

export interface LinuxWriterGeneration {
  platform: "linux";
  pid: number;
  startToken: string;
  bootId: string;
}

export type WriterGeneration = WindowsWriterGeneration | LinuxWriterGeneration;

export interface SessionIdentity {
  peerId: string;
  groupId: string;
  instanceToken: string;
  inboxBinding: InboxBindingConfirmation | null;
  operatorId: string | null;
  writerGeneration?: WriterGeneration;
  projectKey?: string;
  brokerUrl?: string;
}

export interface SessionIdentityReadOptions {
  measureWriterGeneration?: (pid: number) => Promise<WriterGeneration | null>;
  verifyWriterGeneration?: boolean;
  requireProjectKey?: boolean;
}

function sameWriterGeneration(expected: WriterGeneration, measured: WriterGeneration): boolean {
  if (expected.platform !== measured.platform || expected.pid !== measured.pid) return false;
  if (expected.platform === "win32" || measured.platform === "win32") {
    return expected.platform === "win32" && measured.platform === "win32" && expected.creationUtc === measured.creationUtc;
  }
  return expected.startToken === measured.startToken && expected.bootId === measured.bootId;
}

function parseWriterGeneration(value: unknown): WriterGeneration | null {
  if (!value || typeof value !== "object") return null;
  const generation = value as Record<string, unknown>;
  if (generation.platform === "win32") {
    if (
      typeof generation.pid !== "number" ||
      !Number.isSafeInteger(generation.pid) ||
      generation.pid <= 0 ||
      typeof generation.creation_utc !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{1,9}Z$/.test(generation.creation_utc)
    ) return null;
    return { platform: "win32", pid: generation.pid, creationUtc: generation.creation_utc };
  }
  if (generation.platform === "linux") {
    if (
      typeof generation.pid !== "number" ||
      !Number.isSafeInteger(generation.pid) ||
      generation.pid <= 0 ||
      typeof generation.start_token !== "string" ||
      !/^\d+$/.test(generation.start_token) ||
      typeof generation.boot_id !== "string" ||
      generation.boot_id.length === 0
    ) return null;
    return {
      platform: "linux",
      pid: generation.pid,
      startToken: generation.start_token,
      bootId: generation.boot_id,
    };
  }
  return null;
}

/**
 * Write the per-tile identity file for an already-resolved (peerId, groupId,
 * instanceToken) triple. No-op when the token or any of the three is empty
 * -- the reader rejects a partial identity too, so the writer must not
 * produce one. The identity snapshot is written atomically.
 */
async function writeIdentityFile(
  fileName: string,
  peerId: string,
  groupId: string,
  instanceToken: string,
  home: string,
  projectKey: string | null,
  inboxBinding: InboxBindingConfirmation | null,
  operatorId: string | null,
  writerGeneration: WriterGeneration | null,
  brokerUrl: string | null,
): Promise<void> {
  if (!peerId || !groupId || !instanceToken) return;
  if ((inboxBinding === null) !== (operatorId === null)) {
    throw new Error("Inbox binding confirmation and operator must be written together");
  }
  const cacheDir = join(home, ".claude", "peers");
  await mkdir(cacheDir, { recursive: true });
  await writeCacheAtomic(
    join(cacheDir, fileName),
    JSON.stringify({
      peer_id: peerId,
      group_id: groupId,
      instance_token: instanceToken,
      ...(projectKey ? { project_key: projectKey } : {}),
      ...(brokerUrl ? { broker_url: brokerUrl } : {}),
      ...(inboxBinding && operatorId
        ? {
            inbox_binding: {
              version: inboxBinding.version,
              run_ref: inboxBinding.runRef,
              group_id: inboxBinding.groupId,
            },
            operator_id: operatorId,
          }
        : {}),
      ...(writerGeneration
        ? {
            writer_generation: writerGeneration.platform === "win32"
              ? {
                  platform: "win32",
                  pid: writerGeneration.pid,
                  creation_utc: writerGeneration.creationUtc,
                }
              : {
                  platform: "linux",
                  pid: writerGeneration.pid,
                  start_token: writerGeneration.startToken,
                  boot_id: writerGeneration.bootId,
                },
          }
        : {}),
    }),
  );
}

export async function writeSessionIdentityFile(
  token: string,
  peerId: string,
  groupId: string,
  instanceToken: string,
  home: string = homedir(),
  inboxBinding: InboxBindingConfirmation | null = null,
  operatorId: string | null = null,
): Promise<void> {
  const safeToken = sanitizeSessionId(token);
  if (!safeToken) return;
  await writeIdentityFile(
    sessionIdentityFileName(safeToken),
    peerId,
    groupId,
    instanceToken,
    home,
    null,
    inboxBinding,
    operatorId,
    null,
    null,
  );
}

export async function writeGlobalSessionIdentityFile(
  messagingSocket: string,
  peerId: string,
  groupId: string,
  instanceToken: string,
  projectKey: string,
  home: string = homedir(),
  writerGeneration: WriterGeneration | null = null,
  brokerUrl: string = "",
): Promise<void> {
  if (!messagingSocket || !projectKey || !brokerUrl) return;
  await writeIdentityFile(
    globalSessionIdentityFileName(messagingSocket),
    peerId,
    groupId,
    instanceToken,
    home,
    projectKey,
    null,
    null,
    writerGeneration,
    brokerUrl,
  );
}

/**
 * Read the per-tile identity file written by writeSessionIdentityFile.
 * Returns null on any absence, parse failure or malformed shape -- the
 * caller's job is to fail closed on null, never to guess a partial identity.
 * Never log the return value:
 * instanceToken is a credential.
 */
async function readIdentityFile(
  fileName: string,
  home: string,
  options: SessionIdentityReadOptions,
): Promise<SessionIdentity | null> {
  try {
    const raw = await readFile(join(home, ".claude", "peers", fileName), "utf-8");
    const parsed = JSON.parse(raw) as {
      peer_id?: unknown;
      group_id?: unknown;
      instance_token?: unknown;
      project_key?: unknown;
      broker_url?: unknown;
      inbox_binding?: { version?: unknown; run_ref?: unknown; group_id?: unknown };
      operator_id?: unknown;
      writer_generation?: unknown;
    };
    if (typeof parsed.peer_id !== "string" || !parsed.peer_id) return null;
    if (typeof parsed.group_id !== "string" || !parsed.group_id) return null;
    if (typeof parsed.instance_token !== "string" || !parsed.instance_token) return null;
    const projectKey = typeof parsed.project_key === "string" && parsed.project_key ? parsed.project_key : undefined;
    const brokerUrl = typeof parsed.broker_url === "string" && parsed.broker_url ? parsed.broker_url : undefined;
    if (options.requireProjectKey && !projectKey) return null;
    const writerGeneration = parseWriterGeneration(parsed.writer_generation);
    if (parsed.writer_generation !== undefined && writerGeneration === null) return null;
    if (options.measureWriterGeneration || options.verifyWriterGeneration) {
      if (!writerGeneration || !options.measureWriterGeneration) return null;
      const measured = await options.measureWriterGeneration(writerGeneration.pid);
      if (!measured || !sameWriterGeneration(writerGeneration, measured)) return null;
    }
    const inbox = parsed.inbox_binding;
    if (
      inbox?.version === 1 &&
      typeof inbox.run_ref === "string" &&
      inbox.run_ref.length > 0 &&
      typeof inbox.group_id === "string" &&
      inbox.group_id.length > 0 &&
      typeof parsed.operator_id === "string" &&
      parsed.operator_id.length > 0
    ) {
      return {
        peerId: parsed.peer_id,
        groupId: parsed.group_id,
        instanceToken: parsed.instance_token,
        inboxBinding: { version: 1, runRef: inbox.run_ref, groupId: inbox.group_id },
        operatorId: parsed.operator_id,
        ...(projectKey ? { projectKey } : {}),
        ...(brokerUrl ? { brokerUrl } : {}),
        ...(writerGeneration ? { writerGeneration } : {}),
      };
    }
    return {
      peerId: parsed.peer_id,
      groupId: parsed.group_id,
      instanceToken: parsed.instance_token,
      inboxBinding: null,
      operatorId: null,
      ...(projectKey ? { projectKey } : {}),
      ...(brokerUrl ? { brokerUrl } : {}),
      ...(writerGeneration ? { writerGeneration } : {}),
    };
  } catch {
    return null;
  }
}

export async function readSessionIdentityFile(
  token: string,
  home: string = homedir(),
  options: SessionIdentityReadOptions = {},
): Promise<SessionIdentity | null> {
  const safeToken = sanitizeSessionId(token);
  if (!safeToken) return null;
  return readIdentityFile(sessionIdentityFileName(safeToken), home, options);
}

export async function readGlobalSessionIdentityFile(
  messagingSocket: string,
  home: string = homedir(),
  options: SessionIdentityReadOptions = {},
): Promise<SessionIdentity | null> {
  if (!messagingSocket) return null;
  return readIdentityFile(globalSessionIdentityFileName(messagingSocket), home, options);
}

export async function deleteGlobalSessionIdentityFile(
  messagingSocket: string,
  home: string = homedir(),
): Promise<void> {
  if (!messagingSocket) return;
  try {
    await unlink(join(home, ".claude", "peers", globalSessionIdentityFileName(messagingSocket)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return;
    throw error;
  }
}

/**
 * Delete the per-tile identity file: called both at the TOP of main()
 * (before /register, so a file surviving a PREVIOUS process's crash for the
 * same desk_session token can never be read as live) and from cleanup()
 * alongside the /disconnect POST -- the instance_token, unlike peer_id/
 * group_id, has no status filter downstream (findPeerByInstanceToken).
 * Silent ONLY on ENOENT; any other failure (EBUSY/EPERM, a held handle on
 * Windows) is a security-relevant deletion failure and is rethrown -- the
 * caller logs it, this module deliberately has no logger of its own.
 */
export async function deleteSessionIdentityFile(token: string, home: string = homedir()): Promise<void> {
  const safeToken = sanitizeSessionId(token);
  if (!safeToken) return;
  try {
    await unlink(join(home, ".claude", "peers", sessionIdentityFileName(safeToken)));
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return;
    throw e;
  }
}

export type TileIdentityVerdict = { allowed: true } | { allowed: false; reason: string };

/**
 * May this process write or delete its tile's session-identity file? A child
 * that inherited the tile's env (token included) from a different cwd must
 * not: its peer_id and instance_token would replace the tile's proven ones.
 * CLAUDE_PEERS_DESK_TILE_CWD is the tile's own cwd (the container cwd in a
 * sandbox), exported by the Deck. Absent means the Deck did not export it;
 * refusing there would leave every such tile with an unproven identity, so
 * the guard lets it through.
 */
export function tileIdentityGuard(
  env: Record<string, string | undefined> = process.env,
  cwd: string = process.cwd(),
): TileIdentityVerdict {
  if (!sanitizeSessionId(env.CLAUDE_PEERS_DESK_SESSION)) return { allowed: true };
  const tileCwd = env.CLAUDE_PEERS_DESK_TILE_CWD?.trim();
  if (!tileCwd) return { allowed: true };
  if (canonicalConfigPath(cwd) === canonicalConfigPath(tileCwd)) return { allowed: true };
  return { allowed: false, reason: `process cwd ${cwd} is not the tile cwd ${tileCwd}` };
}

/**
 * No-op unless CLAUDE_PEERS_STATUS_LINE_CACHE is set. When
 * CLAUDE_CODE_SESSION_ID is also set the cache file is suffixed with the
 * session id so multiple sessions sharing a cwd each keep their own peer_id;
 * otherwise it falls back to the legacy single-file layout.
 * Overwritten on every /register so a stale value is replaced as soon as the
 * session reconnects. Best-effort: failures are silent so a transient FS issue
 * never breaks /register.
 */
export async function writePeerIdCache(
  cwd: string,
  peerId: string,
  home: string = homedir(),
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  if (!isPeerIdCacheEnabled(env)) return;
  try {
    const cacheDir = join(home, ".claude", "peers");
    const key = computeCwdKey(cwd);
    const sessionId = sanitizeSessionId(env.CLAUDE_CODE_SESSION_ID);
    const filename = sessionId ? `peer-id-${key}-${sessionId}.txt` : `peer-id-${key}.txt`;
    await mkdir(cacheDir, { recursive: true });
    await writeCacheAtomic(join(cacheDir, filename), peerId);
  } catch {
    // best-effort: status-line cache is non-critical
  }
}
