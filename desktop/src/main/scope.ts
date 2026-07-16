// Scope = the isolated claude-peers group every session spawned by this Deck
// window shares. The Deck forces its sessions into this group via the
// top-precedence forced-group path in the claude-peers core (shared/config.ts),
// fed per child process through node-pty's `env` option -- never the user's
// shell, global env, or any project file.
//
// Isolation rests on the *secret*, not the display name (DESIGN §4): a readable,
// possibly-colliding name is fine. The secret is either a user-supplied scope id
// ("custom") or a fresh random uuid ("ephemeral"). Only the derived groupId is
// ever persisted; the secret stays in memory and in a chmod-600 temp file.

import { createHash, randomUUID } from 'node:crypto'
import { closeSync, mkdtempSync, openSync, rmSync, writeSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { basename, join } from 'node:path'

export type ScopeKind = 'custom' | 'ephemeral'

export interface Scope {
  /** The forced-group secret. Never persisted. */
  secret: string
  scopeKind: ScopeKind
  /** sha256(secret) truncated to 32 hex chars (== shared/config.ts computeGroupId). */
  groupId: string
  /** Forced-group display name passed via CLAUDE_PEERS_FORCE_GROUP_NAME. */
  name: string
  /** Peer display root (host + basename(projectDir)), mirrors deriveDefaultId's base. */
  root: string
}

export interface ScopeEnv {
  /** Child env to merge over process.env when spawning a session PTY. */
  env: Record<string, string>
  /** Remove the secret file written by the file transport (no-op on env fallback). */
  cleanup(): void
}

const FORCE_GROUP_ENV = 'CLAUDE_PEERS_FORCE_GROUP'
const FORCE_GROUP_FILE_ENV = 'CLAUDE_PEERS_FORCE_GROUP_FILE'
const FORCE_GROUP_NAME_ENV = 'CLAUDE_PEERS_FORCE_GROUP_NAME'
const STATUS_LINE_CACHE_ENV = 'CLAUDE_PEERS_STATUS_LINE_CACHE'

/** sha256(secret) truncated to 32 hex chars. Mirrors shared/config.ts computeGroupId. */
function computeGroupId(secret: string): string {
  return createHash('sha256').update(secret, 'utf-8').digest('hex').slice(0, 32)
}

/**
 * Mirror the broker's deriveDefaultId base (broker.ts), minus the incremental
 * collision suffix. e.g. host="Dev-PC", projectDir=".../claude-peers-mcp"
 * -> "dev-pc-claude-peers".
 */
function deriveRoot(host: string, projectDir: string): string {
  const sanitize = (s: string): string =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
  const hostPart = sanitize(host).slice(0, 20) || 'peer'
  // Split on both separators so the basename is correct regardless of the host
  // platform's path style (matches broker.ts: cwd.split(/[/\\]/).pop()).
  const cwdPart = sanitize(projectDir.split(/[/\\]/).pop() ?? '').slice(0, 12)
  return cwdPart ? `${hostPart}-${cwdPart}` : hostPart
}

/**
 * Compute the scope for a Deck window. A trimmed, non-empty `scopeId` yields a
 * "custom" scope (reproducible on restore); otherwise a fresh "ephemeral" uuid.
 */
export function computeScope(projectDir: string, scopeId?: string): Scope {
  const trimmed = scopeId?.trim()
  const custom = !!trimmed && trimmed.length > 0
  const secret = custom ? (trimmed as string) : randomUUID()
  const groupId = computeGroupId(secret)
  const root = deriveRoot(hostname(), projectDir)
  return {
    secret,
    scopeKind: custom ? 'custom' : 'ephemeral',
    groupId,
    name: root,
    root
  }
}

/**
 * Resolve the scope to use when restoring a workspace (DESIGN 6.8). The workspace
 * persists only a `groupId` + `scopeKind`, never the secret:
 * - custom + groupId matches the currently-launched scope -> reuse it (the user
 *   re-supplied the same launch arg, so we can rejoin the same shared group).
 * - otherwise (ephemeral, or a custom whose secret we no longer have) -> mint a
 *   FRESH ephemeral scope. The restored sessions get new forked ids and
 *   rediscover each other in the new group; there were no external members of an
 *   ephemeral group, so nothing is lost, and we never join a wrong group.
 */
export function resolveAdoptedScope(
  ws: { groupId: string; scopeKind: ScopeKind },
  currentScope: Scope,
  projectDir: string
): Scope {
  if (ws.scopeKind === 'custom' && currentScope.groupId === ws.groupId) {
    return currentScope
  }
  return computeScope(projectDir)
}

/**
 * Build the child env that pins a spawned session to this scope's forced group.
 *
 * Prefers the chmod-600 *file* transport (CLAUDE_PEERS_FORCE_GROUP_FILE) so the
 * secret never lands in /proc/<pid>/environ (DESIGN §15). If writing the file
 * fails (read-only FS, perms), it falls back to the *env* transport
 * (CLAUDE_PEERS_FORCE_GROUP). Whichever transport is unused is emitted as an
 * empty string to neutralize any value inherited from the parent process --
 * the core treats empty as unset, and env wins over file when both are set.
 */
export function buildScopeEnv(scope: Scope, opts?: { dir?: string }): ScopeEnv {
  const base: Record<string, string> = {
    [FORCE_GROUP_NAME_ENV]: scope.name,
    [STATUS_LINE_CACHE_ENV]: '1'
  }

  try {
    const dir = opts?.dir ?? mkdtempSync(join(tmpdir(), 'koryphaios-'))
    const filePath = join(dir, 'group-secret')
    const fd = openSync(filePath, 'w', 0o600)
    try {
      writeSync(fd, scope.secret)
    } finally {
      closeSync(fd)
    }
    return {
      env: { ...base, [FORCE_GROUP_FILE_ENV]: filePath, [FORCE_GROUP_ENV]: '' },
      cleanup: () => {
        try {
          rmSync(filePath, { force: true })
        } catch {
          // best-effort; the OS reaps the temp dir eventually
        }
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error(`[koryphaios] secret-file transport failed, using env transport: ${msg}`)
    return {
      env: { ...base, [FORCE_GROUP_ENV]: scope.secret, [FORCE_GROUP_FILE_ENV]: '' },
      cleanup: () => {
        // no file written
      }
    }
  }
}
