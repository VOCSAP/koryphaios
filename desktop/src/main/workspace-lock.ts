// On one host a workspace is owned through an OS lock, a SQLite write lock on <id>.lock.sqlite that the OS drops when
// the owner dies; the JSON lock <id>.lock and its heartbeat are the only cross-host signal, best-effort across two clocks.

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openLockDatabase, type LockConnection, type LockOpener } from './file-lock'
import { reportError } from './log'
import { projectRootPath, type WorkspaceRef } from './project-files'

export interface Lock {
  pid: number
  host: string
  /**
   * startedAt is the owning process's own start time, not when this lock file
   * was written, rounded to the nearest second.
   * Combined with heartbeat freshness to detect a same-host owner that died
   * across a reboot: neither signal alone is reliable (a wall-clock correction
   * can skew startedAt), so both must fail before falling back to a pid-alive
   * check.
   * Locks written before this field existed still parse as an acquisition
   * timestamp, which is safe for the one-way comparison.
   */
  startedAt: number
  heartbeat: number
}

/**
 * Worst-case rounding error on the boot-instant comparison: both
 * `Lock.startedAt` and the caller's `bootInstant` are independently rounded
 * to the nearest second (~1s each), so a margin smaller than this risks a
 * false reclaim from rounding alone, not a real reboot. The comparison
 * SUBTRACTS this tolerance from `bootInstant` (never adds it to
 * `startedAt`), so the only effect of the margin is to make the rule harder
 * to satisfy -- on ambiguity it fails toward "cannot conclude" (fall back to
 * `isPidAlive`), never toward "provably dead" (review round 4: a wall-clock
 * NTP correction that shifts `bootInstant` must never be able to make this
 * rule declare a live owner dead).
 */
export const BOOT_RECLAIM_TOLERANCE_MS = 2_000

export interface LivenessOpts {
  /** Hostname of THIS machine (to tell same-host from cross-host). */
  host: string
  /** Current epoch ms. */
  now: number
  /**
   * This machine's boot instant (epoch ms, rounded to the nearest second --
   * see `BOOT_RECLAIM_TOLERANCE_MS`). Used only for the one-way reclaim
   * check on `Lock.startedAt` (same-host path of `isLockLive`); cheap and
   * dependency-free (`Date.now() - os.uptime()*1000`), never a subprocess.
   */
  bootInstant: number
  /**
   * Same-host liveness: is `pid` a live process on this machine? Plain
   * pid-alive check (`process.kill(pid, 0)`), the pre-card guarantee --
   * `isLockLive` only calls this once the boot-instant check above is
   * inconclusive.
   */
  isPidAlive: (pid: number) => boolean
  /**
   * A heartbeat older-or-equal to `now - staleMs` is considered stale.
   * Cross-host: the sole liveness signal. Same-host: the SECOND half of the
   * boot-instant reclaim check (review round 6) -- both must hold for a
   * same-host lock to be declared dead without consulting `isPidAlive`.
   */
  staleMs: number
}

export function lockPath(ref: WorkspaceRef): string {
  return join(projectRootPath(ref.projectDir, ref.source), 'workspaces', `${ref.id}.lock`)
}

export type LockRead = { kind: 'absent' } | { kind: 'lock'; lock: Lock } | { kind: 'unreadable' }

export function inspectLock(ref: WorkspaceRef): LockRead {
  const file = lockPath(ref)
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' }
    reportError('workspace', `cannot read the workspace lock ${file}`, e)
    return { kind: 'unreadable' }
  }
  let parsed: Partial<Lock> | null
  try {
    parsed = JSON.parse(raw) as Partial<Lock> | null
  } catch (e) {
    reportError('workspace', `${file} is not valid JSON`, e)
    return { kind: 'unreadable' }
  }
  if (typeof parsed?.pid === 'number' && typeof parsed.host === 'string') {
    return {
      kind: 'lock',
      lock: {
        pid: parsed.pid,
        host: parsed.host,
        startedAt: parsed.startedAt ?? 0,
        heartbeat: parsed.heartbeat ?? 0
      }
    }
  }
  reportError('workspace', `${file} does not name an owner`)
  return { kind: 'unreadable' }
}

/** The parsed lock, or null when it is absent OR unreadable: `inspectLock` tells the two apart. */
export function readLock(ref: WorkspaceRef): Lock | null {
  const read = inspectLock(ref)
  return read.kind === 'lock' ? read.lock : null
}

const SQLITE_BUSY = 5
const ACQUIRE_BUSY_MS = 250

function sqliteBusy(error: unknown): boolean {
  const e = error as { errcode?: unknown; errno?: unknown }
  return (e?.errcode ?? e?.errno) === SQLITE_BUSY
}

function heldLockPath(ref: WorkspaceRef): string {
  return `${lockPath(ref)}.sqlite`
}

/**
 * Give up a same-host lock taken by `acquireLock`. The caller must keep the
 * connection referenced until then: a collected connection drops its lock.
 */
export function releaseHeldLock(held: LockConnection): void {
  try {
    held.exec('ROLLBACK')
  } catch (e) {
    reportError('workspace', 'cannot roll back a held workspace lock', e)
  }
  try {
    held.close()
  } catch (e) {
    reportError('workspace', 'cannot close a held workspace lock', e)
  }
}

/** The same-host lock of the workspace, or null when another connection holds it. Throws, untraced, when it cannot be taken at all. */
function holdSameHostLock(ref: WorkspaceRef, open: LockOpener, busyMs: number): LockConnection | null {
  const path = heldLockPath(ref)
  const db = open(path)
  try {
    db.exec(`PRAGMA busy_timeout = ${busyMs}`)
    db.exec('BEGIN IMMEDIATE')
    return db
  } catch (e) {
    try {
      db.close()
    } catch (closeError) {
      reportError('workspace', `cannot close the refused workspace lock ${path}`, closeError)
    }
    if (sqliteBusy(e)) return null
    throw e
  }
}

function unusableLockMessage(ref: WorkspaceRef): string {
  return `${heldLockPath(ref)} cannot be used as a lock; delete that file by hand`
}

export type SameHostLockState = 'free' | 'held' | 'unprobeable'

const reportedUnprobeable = new Set<string>()

/**
 * Is the workspace held by ANOTHER connection on this host? Answers 'held' for this process's own held lock too, so a
 * caller must exclude what it owns first. 'unprobeable' proves nothing free; it is traced once per lock file.
 */
export function probeSameHostLock(ref: WorkspaceRef, open: LockOpener = openLockDatabase): SameHostLockState {
  const path = heldLockPath(ref)
  if (!existsSync(path)) return 'free'
  let probe: LockConnection | null
  try {
    probe = holdSameHostLock(ref, open, 0)
  } catch (e) {
    if (!reportedUnprobeable.has(path)) {
      reportedUnprobeable.add(path)
      reportError('workspace', unusableLockMessage(ref), e)
    }
    return 'unprobeable'
  }
  reportedUnprobeable.delete(path)
  if (!probe) return 'held'
  releaseHeldLock(probe)
  return 'free'
}

/**
 * Same host: dead only when both startedAt provably predates this machine's
 * last boot and the heartbeat is stale; either alone can misfire around an NTP
 * correction. Inconclusive falls back to isPidAlive.
 * Cross host: trusts heartbeat freshness only (best-effort); a heartbeat
 * exactly staleMs old counts as stale.
 */
export function isLockLive(lock: Lock, opts: LivenessOpts): boolean {
  if (lock.host === opts.host) {
    const precedesBoot = lock.startedAt < opts.bootInstant - BOOT_RECLAIM_TOLERANCE_MS
    const heartbeatStale = lock.heartbeat <= opts.now - opts.staleMs
    if (precedesBoot && heartbeatStale) return false
    return opts.isPidAlive(lock.pid)
  }
  return lock.heartbeat > opts.now - opts.staleMs
}

function writeLock(ref: WorkspaceRef, lock: Lock): void {
  writeFileSync(lockPath(ref), JSON.stringify(lock), 'utf8')
}

/** A caller's own identity, as stamped in a `Lock` (pid+host, never a
 *  caller-side memory field -- see the repo's "who is actually running
 *  this" convention). */
export interface LockIdentity {
  pid: number
  host: string
}

/**
 * Does `identity` (the pid+host of THIS caller) match the pid+host actually
 * stamped in `lock`? The single source of truth for "do I own this lock",
 * consumed by both `refreshLock` and `releaseLock` so the comparison is
 * written once (card 438c15e3 -- mirrors `resolveRoadmapLock` in
 * shared/roadmap-lock.ts: resolve the object, then ask if this caller owns
 * it, never trust a caller-side belief like `this.currentId`).
 */
export function ownsLock(lock: Lock, identity: LockIdentity): boolean {
  return lock.pid === identity.pid && lock.host === identity.host
}

/** Writes the JSON lock of the workspace for its owner; only for a caller that holds the same-host OS lock. */
export function stampLock(
  ref: WorkspaceRef,
  owner: { pid: number; host: string; startedAt: number; now: number }
): void {
  writeLock(ref, { pid: owner.pid, host: owner.host, startedAt: owner.startedAt, heartbeat: owner.now })
}

/**
 * Takes the same-host OS lock, then the JSON lock unless another live owner holds it. Returns the held connection,
 * which the caller keeps referenced until `releaseLock`, or null when either lock is held. `startedAt` is the owner's
 * own process start time, not the acquisition time: `isLockLive` compares it to the boot instant.
 */
export function acquireLock(
  ref: WorkspaceRef,
  opts: LivenessOpts & { pid: number; startedAt: number; open?: LockOpener }
): LockConnection | null {
  let held: LockConnection | null
  try {
    held = holdSameHostLock(ref, opts.open ?? openLockDatabase, ACQUIRE_BUSY_MS)
  } catch (e) {
    reportError('workspace', unusableLockMessage(ref), e)
    throw new Error(unusableLockMessage(ref))
  }
  if (!held) return null
  try {
    const existing = inspectLock(ref)
    if (existing.kind === 'lock' && isLockLive(existing.lock, opts) && !ownsLock(existing.lock, opts)) {
      releaseHeldLock(held)
      return null
    }
    if (existing.kind === 'unreadable') {
      reportError('workspace', `rewriting the unreadable lock of workspace ${ref.id}`)
    }
    stampLock(ref, opts)
    return held
  } catch (e) {
    releaseHeldLock(held)
    throw e
  }
}

/** Refreshes the heartbeat only of a lock owned by `identity`: re-stamping another identity would keep its lock alive forever. */
export function refreshLock(
  ref: WorkspaceRef,
  now: number,
  identity: LockIdentity
): boolean {
  const lock = readLock(ref)
  if (!lock || !ownsLock(lock, identity)) return false
  writeLock(ref, { ...lock, heartbeat: now })
  return true
}

/**
 * Deletes the JSON lock only if `identity` owns it or it is gone; false when a foreign lock blocked the release.
 * `held` is given back in every case, after the JSON lock is gone, so no same-host contender can write it in between.
 */
export function releaseLock(
  ref: WorkspaceRef,
  identity: LockIdentity,
  held: LockConnection | null
): boolean {
  try {
    const lock = readLock(ref)
    if (lock && !ownsLock(lock, identity)) return false
    try {
      rmSync(lockPath(ref), { force: true })
    } catch (e) {
      reportError('workspace', `cannot remove the lock of workspace ${ref.id}`, e)
    }
    return true
  } finally {
    if (held) releaseHeldLock(held)
  }
}
