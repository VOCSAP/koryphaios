// Atomic file write (M-LOG-1). A bare writeFileSync truncates the target before
// writing, so a crash / power-loss mid-write leaves a truncated file that the
// JSON readers then silently fall back on — wiping settings, encrypted provider
// keys, graph conversations or the operator inbox. Writing to a sibling temp
// file and renaming makes the replacement atomic on POSIX and Windows: a reader
// ever sees either the old complete file or the new complete one, never a torn
// one. Mirrors the pattern workspace-store.ts already uses.
//
// Node builtins plus this layer's log sink (log.ts is itself node-builtins-only,
// no electron), so it stays unit-testable under bun -- and a cleanup that fails
// still leaves a trace instead of silently replacing the caller's error.

import { randomBytes } from 'node:crypto'
import { renameSync, rmSync, writeFileSync } from 'node:fs'
import { reportError } from './log'

/**
 * The sibling this helper writes through: `<file>.<pid>.<random>.tmp`. Both
 * halves matter -- the pid keeps two processes apart, the random suffix keeps
 * two calls of the SAME process apart (an interrupted write whose temp file
 * survived must not be adopted as the next call's buffer).
 */
export function tempFileName(file: string): string {
  return `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
}

/**
 * Write `data` to `file` atomically (temp file + rename).
 *
 * The temp file is named per process AND per call (see `tempFileName`):
 * a shared `<file>.tmp` is a second window's write buffer, and two processes
 * renaming the same half-written sibling is exactly the torn file this helper
 * exists to prevent. A failed write takes its own temp file with it, so a
 * unique name cannot turn a transient error into an accumulating pile.
 *
 * `mode` is applied to the TEMP file, before the rename: applying it after
 * would leave a window during which a secret (an encrypted operator key, a
 * session credential) sits on disk with default permissions.
 */
export function writeFileAtomic(
  file: string,
  data: string | Uint8Array,
  opts: { mode?: number } = {}
): void {
  const tmp = tempFileName(file)
  try {
    writeFileSync(tmp, data, opts.mode === undefined ? undefined : { mode: opts.mode })
    renameSync(tmp, file)
  } catch (e) {
    // The write's own failure is what the caller must see, so a cleanup that
    // fails in turn is traced here instead of replacing it.
    try {
      rmSync(tmp, { force: true })
    } catch (cleanup) {
      reportError('atomic-write', `left the temp file ${tmp} behind`, cleanup)
    }
    throw e
  }
}
