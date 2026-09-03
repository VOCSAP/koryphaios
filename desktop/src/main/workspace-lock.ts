// Sidecar lock for a workspace owned by a running Deck (DESIGN 6.5).
// File: <project>/.claude/claude-peers/workspaces/<id>.lock
//
// Same-host liveness uses an injected `isPidAlive` predicate (real impl:
// process.kill(pid, 0)) -- reliable, no clock dependency. Cross-host liveness
// can only rely on heartbeat freshness across two clocks -> best-effort
// (documented DESIGN 15). A robust cross-host lock would delegate to the broker
// (single clock) -- a Phase 2 enhancement.
//
// Pure: node fs/path only (the pid predicate, host and clock are injected), so
// it is unit-testable under bun.

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

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

export function readLock(projectDir: string, id: string): Lock | null {
  const file = lockPath(projectDir, id)
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<Lock>
    if (typeof parsed.pid === 'number' && typeof parsed.host === 'string') {
      return {
        pid: parsed.pid,
        host: parsed.host,
        startedAt: parsed.startedAt ?? 0,
        heartbeat: parsed.heartbeat ?? 0
      }
    }
    return null
  } catch {
    return null
  }
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

/**
 * Try to acquire the lock for `id`. Refuses if an existing lock is held by a
 * live owner; otherwise writes a fresh lock (reclaiming a stale one) and
 * returns true. `pid`/`host` describe THIS owner; `startedAt` is THIS
 * owner's OWN actual process start time (not the acquisition timestamp --
 * see `Lock.startedAt` and `isLockLive`, which need a real launch time to
 * compare against this machine's boot instant on the NEXT liveness check,
 * not merely "when this lock was last written").
 */
export function acquireLock(
  projectDir: string,
  id: string,
  opts: LivenessOpts & { pid: number; startedAt: number }
): boolean {
  const existing = readLock(projectDir, id)
  if (existing && isLockLive(existing, opts)) return false
  writeLock(projectDir, id, {
    pid: opts.pid,
    host: opts.host,
    startedAt: opts.startedAt,
    heartbeat: opts.now
  })
  return true
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
 * nothing to delete).
 */
export function releaseLock(projectDir: string, id: string, identity: LockIdentity): boolean {
  const lock = readLock(projectDir, id)
  if (lock && !ownsLock(lock, identity)) return false
  try {
    rmSync(lockPath(projectDir, id), { force: true })
  } catch {
    // already gone -> nothing to do
  }
  return true
}
