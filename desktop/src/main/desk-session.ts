// Deck side of the deterministic session-id back-channel (debt D1/D2/D10).
//
// The Deck injects a unique per-tile token (CLAUDE_PEERS_DESK_SESSION=<def.id>)
// into each PTY. The claude-peers core server.ts, at /register, writes the REAL
// minted CLAUDE_CODE_SESSION_ID into ~/.claude/peers/desk-session-<token>.txt
// (see shared/peer-cache.ts:writeDeskSessionId). This module reads that file so
// the Deck learns the exact real id for THAT tile, with no transcript-diff
// guessing -- deterministic even when several tiles boot in the same cwd at once.
//
// Pure node builtins only (no electron / node-pty), peersDir injectable, so it
// is unit-testable under bun. The filename + token sanitization MUST match
// shared/peer-cache.ts (deskSessionFileName / sanitizeSessionId).

import { existsSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PEERS_DIR = join(homedir(), '.claude', 'peers')

/** Mirror of shared/peer-cache.ts:sanitizeSessionId -- non-[A-Za-z0-9-] to '_', cap 64. */
export function sanitizeToken(token: string | undefined | null): string {
  if (!token) return ''
  const clean = token.replace(/[^A-Za-z0-9-]/g, '_')
  return clean.length > 64 ? clean.slice(0, 64) : clean
}

/** Mirror of shared/peer-cache.ts:deskSessionFileName -- must stay in sync. */
export function deskSessionFileName(token: string): string {
  return `desk-session-${sanitizeToken(token)}.txt`
}

export function deskSessionPath(token: string, peersDir: string = PEERS_DIR): string {
  return join(peersDir, deskSessionFileName(token))
}

/**
 * The file this value is read from is mounted into sandbox containers, so its
 * content is attacker-controlled: the adopted id later reaches the host shell
 * as `--resume <id>`.
 * Anything not matching [A-Za-z0-9-]{1,64} is dropped, never
 * sanitized-and-used, since a mangled id would resume the wrong conversation.
 */
const SESSION_ID_RE = /^[A-Za-z0-9-]{1,64}$/

export function isPlausibleSessionId(value: string): boolean {
  return SESSION_ID_RE.test(value)
}

/**
 * Read the real session id the core wrote for `token`, or null when the file is
 * absent/empty/implausible (older core, session not registered yet, or a
 * tampered file). Best-effort.
 */
export function readDeskSessionId(token: string, peersDir: string = PEERS_DIR): string | null {
  if (!sanitizeToken(token)) return null
  try {
    const full = deskSessionPath(token, peersDir)
    if (!existsSync(full)) return null
    const value = readFileSync(full, 'utf8').trim()
    if (!value) return null
    return isPlausibleSessionId(value) ? value : null
  } catch {
    return null
  }
}

/**
 * Delete a token's back-channel file before a (re)spawn so the next read cannot
 * pick up a stale id from a previous run. Best-effort, silent on miss.
 */
export function clearDeskSessionId(token: string, peersDir: string = PEERS_DIR): void {
  if (!sanitizeToken(token)) return
  try {
    rmSync(deskSessionPath(token, peersDir), { force: true })
  } catch {
    // best-effort: a stale file just means discovery falls back to transcripts
  }
}
