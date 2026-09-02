import { mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Atomic cache write (M-LOG-1 / N-MNT-5): write to a per-process temp file then
// rename, so a torn write or two sessions racing on the shared per-cwd legacy
// file can never leave a partial id for a reader to pick up. The temp name is
// pid-scoped so concurrent writers do not clobber each other's temp.
async function writeCacheAtomic(target: string, data: string): Promise<void> {
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, data, "utf-8");
  await rename(tmp, target);
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
 * Write the Deck back-channel file for an already-resolved (token, sessionId)
 * pair. No-op when either is empty. Best-effort: failures are silent so callers
 * never break their own flow. Shared by writeDeskSessionId (env-driven, from
 * server.ts at /register) and the SessionStart hook (payload-driven, which also
 * fires on /clear and compaction -- the rotations server.ts cannot observe).
 */
export async function writeDeskSessionFile(
  token: string,
  sessionId: string,
  home: string = homedir(),
): Promise<void> {
  const safeToken = sanitizeSessionId(token);
  const id = (sessionId ?? "").trim();
  if (!safeToken || !id) return;
  try {
    const cacheDir = join(home, ".claude", "peers");
    await mkdir(cacheDir, { recursive: true });
    await writeCacheAtomic(join(cacheDir, deskSessionFileName(safeToken)), id);
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
    env.CLAUDE_CODE_SESSION_ID ?? "",
    home,
  );
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
