import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Resolve the display `peer_id` a session is currently registered under, by
 * reading the claude-peers status-line cache files written by `server.ts`:
 *   $HOME/.claude/peers/peer-id-<cwdKey>[-<sessionId>].txt
 *
 * The Deck spawns peer terminals with CLAUDE_PEERS_STATUS_LINE_CACHE=1 so this
 * cache is populated even for users who never wired a status-line script. Since
 * M3 the Deck launches each session with a known `--session-id`, so we can read
 * the exact per-session file deterministically instead of guessing the newest.
 *
 * Best-effort: any failure resolves to null (the tile simply shows no peer_id).
 */

const PEERS_DIR = join(homedir(), '.claude', 'peers')

/** Mirror of shared/peer-cache.ts:computeCwdKey -- must stay in sync. */
export function computeCwdKey(cwd: string): string {
  const sanitized = cwd.replace(/[^a-zA-Z0-9-]/g, '_')
  return sanitized.length > 40 ? sanitized.slice(sanitized.length - 40) : sanitized
}

/** Mirror of shared/peer-cache.ts:sanitizeSessionId -- replace non-[A-Za-z0-9-] with '_', cap 64. */
export function sanitizeSessionId(sessionId: string | undefined | null): string {
  if (!sessionId) return ''
  const clean = sessionId.replace(/[^A-Za-z0-9-]/g, '_')
  return clean.length > 64 ? clean.slice(0, 64) : clean
}

function readPeerIdFile(full: string): string | null {
  try {
    const value = readFileSync(full, 'utf8').trim()
    return value || null
  } catch {
    return null
  }
}

export function resolvePeerId(
  cwd: string,
  sessionId?: string,
  peersDir: string = PEERS_DIR
): string | null {
  try {
    if (!existsSync(peersDir)) return null
    const key = computeCwdKey(cwd)

    // Deterministic: the exact file this session writes.
    const suffix = sanitizeSessionId(sessionId)
    if (suffix) {
      const exact = readPeerIdFile(join(peersDir, `peer-id-${key}-${suffix}.txt`))
      // A sessionId was given but its exact cache file is missing (e.g. a
      // /clear rotated CLAUDE_CODE_SESSION_ID in-process without
      // re-registering, card aa8d6b5f). Fail CLOSED: never borrow the newest
      // sibling file for this cwdKey, which may belong to a different tile.
      return exact
    }

    // Fallback: newest matching file. Legacy layout only (no sessionId known
    // at all) -- the mtime guess is never applied once a sessionId is given.
    const prefix = `peer-id-${key}`
    const matches = readdirSync(peersDir)
      .filter((f) => f.startsWith(prefix) && f.endsWith('.txt'))
      .map((f) => {
        const full = join(peersDir, f)
        return { full, mtime: statSync(full).mtimeMs }
      })
      .sort((a, b) => b.mtime - a.mtime)

    const newest = matches[0]
    return newest ? readPeerIdFile(newest.full) : null
  } catch {
    return null
  }
}

function peerIdCacheFileName(cwd: string, sessionId: string): string {
  return `peer-id-${computeCwdKey(cwd)}-${sessionId}.txt`
}

/**
 * Rejects only what a torn or truncated read can produce (whitespace, a
 * control character), not what the broker's own peer_id policy would --
 * this module does not own that policy and must not need to agree with it
 * to accept a value the broker legitimately minted.
 */
const PLAUSIBLE_CACHE_VALUE_RE = /^[\x21-\x7e]{1,64}$/

/**
 * Resolve the peer_id among every real session id one tile has itself
 * adopted (SessionDef.sessionIdHistory), taking whichever of THEIR cache
 * files was written most recently.
 * The mtime comparison, forbidden in resolvePeerId (card aa8d6b5f) between
 * different tiles' files, is safe here for the opposite reason: every id
 * compared is proven to belong to THIS one tile, so there is no sibling
 * left to borrow from. No known path ever rewrites a cache file under
 * anything but the earliest id a tile registered under, but even if one
 * did, the mtime comparison would already prefer it -- the design does not
 * depend on that premise holding.
 * A read value that fails the plausibility check is treated as absent, so a
 * torn or truncated-but-non-empty file is never surfaced as an identity.
 */
export function resolvePeerIdAmong(
  cwd: string,
  sessionIds: readonly string[],
  peersDir: string = PEERS_DIR
): string | null {
  try {
    if (!existsSync(peersDir)) return null
    let best: { value: string; mtime: number } | null = null
    for (const id of sessionIds) {
      const suffix = sanitizeSessionId(id)
      if (!suffix) continue
      const full = join(peersDir, peerIdCacheFileName(cwd, suffix))
      if (!existsSync(full)) continue
      const value = readFileSync(full, 'utf8').trim()
      if (!value || !PLAUSIBLE_CACHE_VALUE_RE.test(value)) continue
      const mtime = statSync(full).mtimeMs
      if (!best || mtime > best.mtime) best = { value, mtime }
    }
    return best ? best.value : null
  } catch {
    return null
  }
}

export const PEER_POLL_MS = 4000

export interface TilePeerBinding {
  peer_id: string
  status: 'active' | 'dormant'
}

export interface TilePeerPollDeps {
  /** Every tile the Deck holds, live or not; ids and desk_session tokens are the same value. */
  tileIds(): string[]
  isAlive(id: string): boolean
  /** undefined once the tile is gone. */
  currentPeer(id: string): string | null | undefined
  /** Index-aligned with `deskSessions`; rejects on any broker failure. */
  fetch(deskSessions: string[]): Promise<(TilePeerBinding | null)[]>
  setPeer(id: string, next: string | null, previous: string | null): void
  report(error: unknown): void
}

/** The broker, not the local cache files, owns a tile's peer_id: descendants of a tile can rewrite those files. */
export class TilePeerPoller {
  private inFlight = false
  private failing = false

  constructor(private readonly deps: TilePeerPollDeps) {}

  /** Resolves true when at least one tile's peer changed. */
  async tick(): Promise<boolean> {
    if (this.inFlight) return false
    const live = this.deps.tileIds().filter((id) => this.deps.isAlive(id))
    this.inFlight = true
    let resolved: (TilePeerBinding | null)[] | null = null
    try {
      resolved = live.length ? await this.deps.fetch(live) : []
      this.failing = false
    } catch (e) {
      if (!this.failing) this.deps.report(e)
      this.failing = true
    } finally {
      this.inFlight = false
    }
    const answered = new Map<string, string | null>()
    resolved?.forEach((binding, i) => {
      const id = live[i]
      if (id !== undefined) answered.set(id, binding?.peer_id ?? null)
    })
    let changed = false
    for (const id of this.deps.tileIds()) {
      const previous = this.deps.currentPeer(id)
      if (previous === undefined) continue
      let next: string | null
      if (!this.deps.isAlive(id)) next = null
      else if (answered.has(id)) next = answered.get(id) ?? null
      else continue
      if (next !== previous) {
        this.deps.setPeer(id, next, previous)
        changed = true
      }
    }
    return changed
  }
}
