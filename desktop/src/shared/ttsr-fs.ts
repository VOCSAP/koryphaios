// Bounded reads of files another party can write (a repo rules file an agent
// edits, a hook log in a sandbox run dir, a Write target). The path is opened
// ONCE and every check runs on the descriptor: a check on the path followed
// by an open of the path lets the file be swapped in between for a symlink
// (read outside), a FIFO (open or read blocks forever) or /dev/zero (no end).
//
// Node builtins only: imported by Deck main and by the session hook.

import { closeSync, constants as fsConstants, fstatSync, openSync, readSync, type Stats } from 'node:fs'

/** O_NOFOLLOW and O_NONBLOCK are missing from fs.constants on Windows: the fstat checks still apply there. */
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0
const O_NONBLOCK = fsConstants.O_NONBLOCK ?? 0

export type BoundedReadResult =
  | { kind: 'absent' }
  /** Present but not read: `reason` says why (symlink, not a regular file, too large, replaced). */
  | { kind: 'refused'; reason: string }
  | { kind: 'ok'; bytes: Buffer; stat: Stats; truncated: boolean }

export interface BoundedReadOptions {
  /** Bytes read at most. */
  cap: number
  /** 'refuse' (default): a file larger than `cap` is refused; 'truncate': its first `cap` bytes are returned. */
  overflow?: 'refuse' | 'truncate'
  /** Follow a symlink leaf (the operator's own file); default false. */
  follow?: boolean
  /** Starting offset of the read (a log tail), or computed from the checked descriptor's stat; default 0. */
  offset?: number | ((stat: Stats) => number)
  /** Refuse unless the opened file is this inode (from an earlier lstat of the same path). */
  expect?: { dev: number; ino: number }
}

/**
 * Opens `path` once (O_RDONLY | O_NONBLOCK, O_NOFOLLOW unless `follow`),
 * checks the DESCRIPTOR is a regular file (and the expected inode), then
 * reads at most `cap` bytes from it (`cap + 1` to detect a file that grew).
 * ENOENT/ENOTDIR are 'absent', ELOOP (a symlink leaf) is 'refused'; any
 * other error is thrown for the caller's error sink. Always closes.
 */
export function readBounded(path: string, opts: BoundedReadOptions): BoundedReadResult {
  const flags = fsConstants.O_RDONLY | O_NONBLOCK | (opts.follow ? 0 : O_NOFOLLOW)
  let fd: number
  try {
    fd = openSync(path, flags)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'absent' }
    if (code === 'ELOOP' || code === 'EMLINK') return { kind: 'refused', reason: 'is a symlink' }
    throw e
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) return { kind: 'refused', reason: 'is not a regular file' }
    if (opts.expect && (stat.dev !== opts.expect.dev || stat.ino !== opts.expect.ino)) {
      return { kind: 'refused', reason: 'was replaced while being read' }
    }
    const offset = typeof opts.offset === 'function' ? opts.offset(stat) : (opts.offset ?? 0)
    const remaining = Math.max(0, stat.size - offset)
    const refuse = (opts.overflow ?? 'refuse') === 'refuse'
    if (refuse && remaining > opts.cap) return { kind: 'refused', reason: `${stat.size} bytes exceeds the ${opts.cap}-byte limit` }
    // Refusing: one byte past the cap tells a file that grew after the fstat
    // from one that fits. Truncating: never more than the cap.
    const buf = Buffer.alloc(refuse ? opts.cap + 1 : Math.min(remaining, opts.cap))
    let n = 0
    while (n < buf.length) {
      const got = readSync(fd, buf, n, buf.length - n, offset + n)
      if (got === 0) break
      n += got
    }
    if (refuse && n > opts.cap) return { kind: 'refused', reason: `grew past the ${opts.cap}-byte limit while being read` }
    return { kind: 'ok', bytes: buf.subarray(0, n), stat, truncated: remaining > n }
  } finally {
    closeSync(fd)
  }
}
