// Deck side of the per-tile statusLine report (model + context fill). The
// statusLine script writes <peersDir>/desk-status-<token>.json; this module
// reads and strictly decodes it, and clears it before a respawn.
// Pure node builtins (no electron / node-pty), peersDir injectable, so it is
// unit-testable under bun like desk-session.ts.

import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionLiveStatus } from '../shared/types'
import {
  STATUS_FILE_MAX_BYTES,
  decodeStatusFile,
  sanitizeStatusToken,
  statusFileName,
  statusLineCacheFileName
} from '../shared/session-status'

export type StatusFileRead =
  | { kind: 'absent' }
  | { kind: 'ok'; status: SessionLiveStatus }
  /** Present but refused: never decoded as a report. */
  | { kind: 'invalid'; reason: StatusFileRejection }
  | { kind: 'error'; error: unknown }

/**
 * Why a present file was refused: not a regular file (directory, FIFO,
 * device), a symlink (POSIX), over the size cap, or content the decoder
 * rejected (tampered, other version).
 */
export type StatusFileRejection = 'not-file' | 'symlink' | 'oversized' | 'rejected'

export function statusFilePath(token: string, peersDir: string): string | null {
  const name = statusFileName(token)
  return name ? join(peersDir, name) : null
}

function isEnoent(e: unknown): boolean {
  return (e as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/**
 * Open flags for the read: the file is writable from inside a sandbox
 * container, so a planted symlink is refused (O_NOFOLLOW, POSIX only) and a
 * FIFO swapped in cannot block the main process (O_NONBLOCK). Both constants
 * are undefined on win32, where they fall back to 0.
 */
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)

/** Read and decode a tile's status file. Never throws. */
export function readStatusFile(token: string, peersDir: string): StatusFileRead {
  const full = statusFilePath(token, peersDir)
  if (!full) return { kind: 'absent' }
  let fd: number | null = null
  try {
    fd = openSync(full, READ_FLAGS)
    // Checked on the open descriptor, not the path, so the file cannot be
    // swapped between the check and the read; oversized content is never read.
    const st = fstatSync(fd)
    if (!st.isFile()) return { kind: 'invalid', reason: 'not-file' }
    if (st.size > STATUS_FILE_MAX_BYTES) return { kind: 'invalid', reason: 'oversized' }
    // Reads at most the fstat size: bytes appended after the check are ignored,
    // and a truncated document then fails decoding.
    const buf = Buffer.alloc(Math.min(st.size, STATUS_FILE_MAX_BYTES))
    const n = readSync(fd, buf, 0, buf.length, 0)
    const status = decodeStatusFile(buf.subarray(0, n).toString('utf8'))
    return status ? { kind: 'ok', status } : { kind: 'invalid', reason: 'rejected' }
  } catch (e) {
    if (isEnoent(e)) return { kind: 'absent' }
    // O_NOFOLLOW on a symlink fails with ELOOP: a planted link, not an I/O fault.
    if ((e as NodeJS.ErrnoException | null)?.code === 'ELOOP') return { kind: 'invalid', reason: 'symlink' }
    return { kind: 'error', error: e }
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

/**
 * Delete a tile's status file before a (re)spawn so the next read cannot show
 * the previous run's model. Returns the failure, if any, for the caller's
 * error sink; a missing file is not a failure.
 */
export function clearStatusFile(token: string, peersDir: string): unknown | null {
  const full = statusFilePath(token, peersDir)
  if (!full) return null
  try {
    rmSync(full, { force: true })
    return null
  } catch (e) {
    return e
  }
}

/**
 * Delete a tile's cached operator statusLine output (written by the hook next
 * to the status file). Same contract as clearStatusFile.
 */
export function clearStatusLineCache(token: string, peersDir: string): unknown | null {
  const name = statusLineCacheFileName(token)
  if (!name) return null
  try {
    rmSync(join(peersDir, name), { force: true })
    return null
  } catch (e) {
    return e
  }
}

/**
 * Age past which an unknown tile's status/cache file is swept. The peers dir
 * is shared by every Kory instance on the machine, and another live Deck's
 * tiles are unknown here: its files are rewritten on every statusLine run, so
 * only a file untouched this long is taken for a leftover. A fresh unknown
 * file is never deleted.
 */
export const STALE_STATUS_FILE_MS = 24 * 60 * 60 * 1000

/** Status file, cache file, or the hook's `<file>.<pid>.tmp` leftover of either; group 1 is the token. */
const SWEEPABLE_RE = /^desk-(?:status|statusline-cache)-([A-Za-z0-9_-]{1,64})\.json(?:\.\d+\.tmp)?$/

export interface StatusSweepResult {
  removed: string[]
  errors: Array<{ file: string; error: unknown }>
}

/**
 * Remove leftover status/cache files (a drop racing an in-flight hook write,
 * a crashed Deck) whose token matches none of `knownTokens` and whose mtime
 * is older than `maxAgeMs`. Directories are left alone; a symlink is judged
 * by its own mtime and only the link is removed. Never throws.
 */
export function sweepStaleStatusFiles(
  peersDir: string,
  knownTokens: Iterable<string>,
  now: number,
  maxAgeMs: number = STALE_STATUS_FILE_MS
): StatusSweepResult {
  const result: StatusSweepResult = { removed: [], errors: [] }
  if (!Number.isFinite(now) || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0) return result
  const known = new Set<string>()
  for (const t of knownTokens) {
    const safe = sanitizeStatusToken(t)
    if (safe) known.add(safe)
  }
  let names: string[]
  try {
    names = readdirSync(peersDir)
  } catch (e) {
    if (!isEnoent(e)) result.errors.push({ file: peersDir, error: e })
    return result
  }
  for (const name of names) {
    const m = SWEEPABLE_RE.exec(name)
    if (!m || !m[1] || known.has(m[1])) continue
    const full = join(peersDir, name)
    try {
      const st = lstatSync(full)
      if (!st.isFile() && !st.isSymbolicLink()) continue
      if (now - st.mtimeMs < maxAgeMs) continue
      rmSync(full, { force: true })
      result.removed.push(name)
    } catch (e) {
      if (!isEnoent(e)) result.errors.push({ file: full, error: e })
    }
  }
  return result
}

/** What the poll knows about a tile before touching its status file. */
export interface StatusPollGate {
  /** The tile's PTY is alive. */
  alive: boolean
  /**
   * This spawn was given the Deck's statusLine (`--settings`). A tile without
   * it (sandboxed, not Claude Code) never writes a genuine report, so anything
   * found under its token is not trusted.
   */
  enabled: boolean
  /** Epoch ms this spawn started; a report older than it is the previous process's. */
  spawnedAt: number
}

/**
 * Gate a status-file read for one poll tick. The file is not even read for a
 * dead or statusLine-less tile, and a report written before this spawn (a late
 * run of the previous process, after the pre-spawn clear) reads as absent.
 */
export function pollStatusFile(gate: StatusPollGate, read: () => StatusFileRead): StatusFileRead {
  if (!gate.alive || !gate.enabled) return { kind: 'absent' }
  const res = read()
  if (res.kind === 'ok' && res.status.at < gate.spawnedAt) return { kind: 'absent' }
  return res
}

/** How long a statusLine-enabled tile may stay without any report before it is flagged. */
export const STATUS_SILENCE_MS = 60_000

/** What the poll knows when deciding whether a tile's statusLine has gone silent. */
export interface StatusSilenceState {
  alive: boolean
  enabled: boolean
  spawnedAt: number
  now: number
  /** A status file (valid or not) was seen since this spawn. */
  reported: boolean
  /** The silence was already reported for this spawn. */
  warned: boolean
  /**
   * The tile waits on the operator (workspace-trust dialog, permission
   * prompt): Claude Code runs no statusLine before trust, so silence then is
   * expected.
   */
  needsAttention: boolean
  /** Epoch ms the tile was last seen waiting on the operator this spawn, 0 if never. */
  lastAttentionAt: number
}

/**
 * True once, per spawn, when a tile given the Deck's statusLine is still alive
 * STATUS_SILENCE_MS after its spawn, or after it last stopped waiting on the
 * operator, and has produced no status file at all: the hook is not running
 * (bun missing, hooks disabled by policy) and the badge would otherwise stay
 * off without a trace.
 */
export function statusSilenceOverdue(s: StatusSilenceState): boolean {
  if (!s.alive || !s.enabled || s.reported || s.warned || s.needsAttention) return false
  if (!Number.isFinite(s.spawnedAt) || s.spawnedAt <= 0 || !Number.isFinite(s.now)) return false
  const since = Number.isFinite(s.lastAttentionAt) ? Math.max(s.spawnedAt, s.lastAttentionAt) : s.spawnedAt
  return s.now - since >= STATUS_SILENCE_MS
}

/** The operator-facing explanation for a silent statusLine. */
export function statusSilenceMessage(name: string): string {
  return (
    `no statusLine report from "${name}" for ${STATUS_SILENCE_MS / 1000} s since spawn or its last wait on the operator, model/context badge off: ` +
    'bun not on the PATH Claude Code sees, disableAllHooks or allowManagedHooksOnly set, or the workspace not trusted yet'
  )
}
