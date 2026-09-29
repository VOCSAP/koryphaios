// Inter-process exclusion around a synchronous read-modify-write of a settings
// file. The lock is SQLite's own write lock on a sibling database, held by
// BEGIN IMMEDIATE: the OS drops it when its holder dies, so there is no stale
// lock to take over and nothing ever deletes another writer's lock.
//
// Node builtins plus this layer's log sink, so it stays unit-testable under bun.

import { realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { reportError } from './log'

export interface LockConnection {
  exec(sql: string): void
  close(): void
}

export type LockOpener = (path: string) => LockConnection

export const FILE_LOCK_BUSY_MS = 1_000

const SQLITE_BUSY = 5
const SQLITE_NOTADB = 26

export class FileLockError extends Error {}

const heldByThisProcess = new Set<string>()

type SqliteBuiltin = { DatabaseSync?: new (path: string) => LockConnection; Database?: new (path: string) => LockConnection }

function builtin(id: string): SqliteBuiltin | undefined {
  const lookup = (process as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule
  return typeof lookup === 'function' ? (lookup.call(process, id) as SqliteBuiltin | undefined) : undefined
}

/** A lock taken on the returned connection lives only as long as that object: once it is garbage-collected, the lock is gone. */
export function openLockDatabase(path: string): LockConnection {
  const node = builtin('node:sqlite')
  if (node?.DatabaseSync) return new node.DatabaseSync(path)
  // The bun test runner has no node:sqlite; bun:sqlite takes the same OS lock.
  const bun = builtin('bun:sqlite')
  if (bun?.Database) return new bun.Database(path)
  throw new Error('this runtime has no SQLite to lock a settings file with')
}

/** node:sqlite reports the SQLite result code as `errcode`, bun:sqlite as `errno`. */
function sqliteCode(error: unknown): number | undefined {
  const e = error as { errcode?: unknown; errno?: unknown }
  const code = e?.errcode ?? e?.errno
  return typeof code === 'number' ? code : undefined
}

/** One key per file however it is spelled: case, 8.3 name, symlink or junction in the directory part. */
function heldKey(lockPath: string, scope: string): string {
  try {
    return join(realpathSync.native(dirname(lockPath)), basename(lockPath))
  } catch (e) {
    reportError(scope, `cannot canonicalize the directory of ${lockPath}`, e)
    return resolve(lockPath)
  }
}

/**
 * Run `fn` while holding the exclusive write lock of `${file}.lock.sqlite`.
 *
 * Throws FileLockError when another process still holds the lock after
 * `busyMs`, when the lock file is not a SQLite database (it is never deleted
 * automatically: the message names it for the operator), and when this process
 * already holds the lock of the same file (SQLite would otherwise make the
 * nested call wait out its own holder).
 */
export function withFileLock<T>(
  file: string,
  scope: string,
  fn: () => T,
  opts: { busyMs?: number; open?: LockOpener } = {}
): T {
  const lockPath = `${file}.lock.sqlite`
  const key = heldKey(lockPath, scope)
  if (heldByThisProcess.has(key)) {
    reportError(scope, `${lockPath} is already held by this process`)
    throw new FileLockError(`${file} is already being written by this process`)
  }
  let db: LockConnection
  try {
    db = (opts.open ?? openLockDatabase)(lockPath)
  } catch (e) {
    reportError(scope, `cannot open the lock database ${lockPath}`, e)
    throw new FileLockError(`${file} could not be locked`)
  }
  heldByThisProcess.add(key)
  try {
    try {
      db.exec(`PRAGMA busy_timeout = ${opts.busyMs ?? FILE_LOCK_BUSY_MS}`)
      db.exec('BEGIN IMMEDIATE')
    } catch (e) {
      reportError(scope, `cannot take the lock ${lockPath}`, e)
      const code = sqliteCode(e)
      if (code === SQLITE_BUSY) {
        throw new FileLockError(`another process is writing ${file}; retry in a few seconds`)
      }
      if (code === SQLITE_NOTADB) {
        throw new FileLockError(`${lockPath} is not a lock database; delete that file by hand, then retry`)
      }
      throw new FileLockError(`${file} could not be locked`)
    }
    try {
      return fn()
    } finally {
      try {
        db.exec('ROLLBACK')
      } catch (e) {
        reportError(scope, `cannot release the lock ${lockPath}`, e)
      }
    }
  } finally {
    heldByThisProcess.delete(key)
    try {
      db.close()
    } catch (e) {
      reportError(scope, `cannot close the lock database ${lockPath}`, e)
    }
  }
}
