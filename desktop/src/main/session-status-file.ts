// Deck side of the per-tile statusLine report (model + context fill). The
// statusLine script writes <peersDir>/desk-status-<token>.json; this module
// reads and strictly decodes it, and clears it before a respawn.
// Pure node builtins (no electron / node-pty), peersDir injectable, so it is
// unit-testable under bun like desk-session.ts.

import { closeSync, constants, fstatSync, openSync, readSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionLiveStatus } from '../shared/types'
import { STATUS_FILE_MAX_BYTES, decodeStatusFile, statusFileName } from '../shared/session-status'

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
