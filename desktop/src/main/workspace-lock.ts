// Sidecar lock for a workspace owned by a running Deck (DESIGN 6.5).
// File: <project>/.claude/claude-peers/workspaces/<id>.lock
//
// Same-host liveness uses an injected `isPidAlive` predicate (real impl:
// process.kill(pid, 0)) -- reliable, no clock dependency. Cross-host liveness
// can only rely on heartbeat freshness across two clocks -> best-effort
// (documented DESIGN 15). A robust cross-host lock would delegate to the broker
// (single clock) -- a Phase 2 enhancement.
//
// On the same host the authority is an OS lock: a SQLite write lock on
// <id>.lock.sqlite, held with BEGIN IMMEDIATE for the whole ownership and
// dropped by the OS when the owner dies. The JSON lock and its heartbeat stay
// the only cross-host signal.
//
// Node builtins plus this layer's log sink (the pid predicate, host and clock
// are injected), so it is unit-testable under bun.

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openLockDatabase, type LockConnection, type LockOpener } from './file-lock'
import { reportError } from './log'

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

export function lockPath(projectDir: string, id: string): string {
  return join(projectDir, '.claude', 'claude-peers', 'workspaces', `${id}.lock`)
}

export type LockRead = { kind: 'absent' } | { kind: 'lock'; lock: Lock } | { kind: 'unreadable' }

export function inspectLock(projectDir: string, id: string): LockRead {
  const file = lockPath(projectDir, id)
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
export function readLock(projectDir: string, id: string): Lock | null {
  const read = inspectLock(projectDir, id)
  return read.kind === 'lock' ? read.lock : null
}

const SQLITE_BUSY = 5
const ACQUIRE_BUSY_MS = 250

function sqliteBusy(error: unknown): boolean {
  const e = error as { errcode?: unknown; errno?: unknown }
  return (e?.errcode ?? e?.errno) === SQLITE_BUSY
}

function heldLockPath(projectDir: string, id: string): string {
  return `${lockPath(projectDir, id)}.sqlite`
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

/** The same-host lock of `id`, or null when another connection holds it. Throws, untraced, when it cannot be taken at all. */
function holdSameHostLock(projectDir: string, id: string, open: LockOpener, busyMs: number): LockConnection | null {
  const path = heldLockPath(projectDir, id)
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

function unusableLockMessage(projectDir: string, id: string): string {
  return `${heldLockPath(projectDir, id)} cannot be used as a lock; delete that file by hand`
}

export type SameHostLockState = 'free' | 'held' | 'unprobeable'

const reportedUnprobeable = new Set<string>()

/**
 * Is `id` held by ANOTHER connection on this host? Answers 'held' for this
 * process's own held lock too, so a caller must exclude what it owns first.
 * 'unprobeable' (not a database, no access) proves nothing free; it is traced
 * once per lock file, not on every probe.
 */
export function probeSameHostLock(projectDir: string, id: string, open: LockOpener = openLockDatabase): SameHostLockState {
  const path = heldLockPath(projectDir, id)
  if (!existsSync(path)) return 'free'
  let probe: LockConnection | null
  try {
    probe = holdSameHostLock(projectDir, id, open, 0)
  } catch (e) {
    if (!reportedUnprobeable.has(path)) {
      reportedUnprobeable.add(path)
      reportError('workspace', unusableLockMessage(projectDir, id), e)
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

function writeLock(projectDir: string, id: string, lock: Lock): void {
  writeFileSync(lockPath(projectDir, id), JSON.stringify(lock), 'utf8')
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

/** Write the JSON lock of `id` for its owner; only for a caller that holds the same-host OS lock. */
export function stampLock(
  projectDir: string,
  id: string,
  owner: { pid: number; host: string; startedAt: number; now: number }
): void {
  writeLock(projectDir, id, { pid: owner.pid, host: owner.host, startedAt: owner.startedAt, heartbeat: owner.now })
}

/**
 * Try to acquire the lock for `id`: first the same-host OS lock, then a JSON
 * lock that no OTHER live owner still holds (a cross-host owner, or a Deck
 * that predates the OS lock). Returns the held connection, which the caller keeps
 * referenced for the whole ownership and gives back through `releaseLock`, or
 * null when either lock is held. An unreadable JSON lock is rewritten once the
 * OS lock is won. `pid`/`host` describe THIS owner; `startedAt` is THIS
 * owner's OWN actual process start time (not the acquisition timestamp --
 * see `Lock.startedAt` and `isLockLive`, which need a real launch time to
 * compare against this machine's boot instant on the NEXT liveness check,
 * not merely "when this lock was last written").
 */
export function acquireLock(
  projectDir: string,
  id: string,
  opts: LivenessOpts & { pid: number; startedAt: number; open?: LockOpener }
): LockConnection | null {
  let held: LockConnection | null
  try {
    held = holdSameHostLock(projectDir, id, opts.open ?? openLockDatabase, ACQUIRE_BUSY_MS)
  } catch (e) {
    reportError('workspace', unusableLockMessage(projectDir, id), e)
    throw new Error(unusableLockMessage(projectDir, id))
  }
  if (!held) return null
  try {
    const existing = inspectLock(projectDir, id)
    if (existing.kind === 'lock' && isLockLive(existing.lock, opts) && !ownsLock(existing.lock, opts)) {
      releaseHeldLock(held)
      return null
    }
    if (existing.kind === 'unreadable') {
      reportError('workspace', `rewriting the unreadable lock of workspace ${id}`)
    }
    stampLock(projectDir, id, opts)
    return held
  } catch (e) {
    releaseHeldLock(held)
    throw e
  }
}

/**
 * Refresh the heartbeat of a lock OWNED BY `identity`. No-op (returns false)
 * if the file vanished, or if it now belongs to a different pid+host -- a
 * caller must never re-stamp an identity it does not hold, or it can keep
 * another instance's lock alive forever through its own heartbeat.
 */
export function refreshLock(
  projectDir: string,
  id: string,
  now: number,
  identity: LockIdentity
): boolean {
  const lock = readLock(projectDir, id)
  if (!lock || !ownsLock(lock, identity)) return false
  writeLock(projectDir, id, { ...lock, heartbeat: now })
  return true
}

/**
 * Release (delete) the lock file, but ONLY if it is currently owned by
 * `identity` (or already gone). Refuses to delete a lock stamped with a
 * different pid+host -- an instance that lost the acquire race must not be
 * able to destroy a live instance's lock on its own way out. Returns false
 * when a foreign lock blocked the release, true otherwise (deleted, or
 * nothing to delete). `held` is given back in every case, after the JSON
 * lock is gone, so no same-host contender can write it in between.
 */
export function releaseLock(
  projectDir: string,
  id: string,
  identity: LockIdentity,
  held: LockConnection | null
): boolean {
  try {
    const lock = readLock(projectDir, id)
    if (lock && !ownsLock(lock, identity)) return false
    try {
      rmSync(lockPath(projectDir, id), { force: true })
    } catch (e) {
      reportError('workspace', `cannot remove the lock of workspace ${id}`, e)
    }
    return true
  } finally {
    if (held) releaseHeldLock(held)
  }
}
