// Orchestrates workspace persistence/restore on top of the pure store + lock
// modules and the SessionService. Its own runtime imports (node:os + the pure
// modules below) carry no electron/node-pty -- SessionService/Scope are
// `import type` only, erased at build time -- so WorkspaceService itself is
// bun-testable directly with a stubbed `deps` object (tests/desktop-
// workspace.test.ts), not just its pure pieces (store, lock, session-map)
// in isolation. Owns: the current workspace, its lock + heartbeat, auto-save,
// and scope adoption on restore.

import { hostname, uptime as osUptime } from 'node:os'
import type { AppConfig, DisplayMode, WorkspaceSummary } from '@shared/types'
import type { Scope } from './scope'
import type { SessionService } from './session-service'
import {
  type Workspace,
  type WorkspaceDisplayMode,
  autoName,
  deleteWorkspace,
  ensureWorkspacesDir,
  listWorkspaces,
  loadWorkspace,
  newWorkspaceId,
  saveWorkspace,
  selectPrunableWorkspaces
} from './workspace-store'
import {
  acquireLock,
  isLockLive,
  ownsLock,
  readLock,
  refreshLock,
  releaseLock
} from './workspace-lock'
import { fromWorkspaceSessions, toWorkspaceSessions } from './workspace-session-map'
import { logWarn, reportError } from './log'

const HEARTBEAT_MS = 30_000
/** Cross-host lock is stale after this without a heartbeat (best-effort, DESIGN 15). */
const LOCK_STALE_MS = 120_000
/** D6: unpinned auto-saves older than this are pruned, aligned with Claude's ~30-day session retention (DESIGN 6.7). */
const PRUNE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
/** How often to re-run the prune for long-lived app sessions. */
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000

/** True if `pid` is a live process on this machine (EPERM still means alive). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * THIS process's own actual start time (epoch ms, rounded to the nearest
 * second to absorb clock-read drift between two calls). Computed once at
 * construction and stamped into every lock this instance writes, so a LATER
 * liveness check can rule a lock provably dead across a reboot regardless of
 * pid recycling (card 438c15e3, review round 3) -- see `initialBootInstant`
 * for the other half of that comparison.
 */
function ownProcessStartedAt(): number {
  return Math.round((Date.now() - process.uptime() * 1000) / 1000) * 1000
}

/**
 * THIS machine's boot instant (epoch ms, rounded to the nearest second).
 * `os.uptime()` is monotonic seconds since boot, independent of wall-clock
 * adjustments, so this is free (no subprocess, works in a minimal container)
 * and available on every platform -- unlike querying a DIFFERENT pid's start
 * time (review round 4: that approach was dropped, see `isLockLive`'s
 * same-host boot check in workspace-lock.ts for how this value is used as a
 * one-way "no process survives a reboot" reclaim signal, combined with
 * heartbeat freshness, falling back to a bare pid-alive check when
 * inconclusive). Sampled ONCE (`WorkspaceService.bootAnchorInstant`) and
 * advanced afterward via monotonic process uptime deltas rather than
 * re-reading `Date.now()` on every call -- see
 * `WorkspaceService.currentBootInstant` (review round 5: a long-lived
 * process re-deriving this from `Date.now()` on every check straddles any
 * NTP correction that occurs during its lifetime).
 */
function initialBootInstant(): number {
  return Math.round((Date.now() - osUptime() * 1000) / 1000) * 1000
}

function toDisplayMode(cfg: AppConfig): WorkspaceDisplayMode {
  switch (cfg.displayMode) {
    case '1x1':
      return { kind: 'carousel', x: 1, y: 1 }
    case '1x2':
      return { kind: 'grid', x: 2, y: 1 }
    case '2x2':
      return { kind: 'grid', x: 2, y: 2 }
    default:
      return { kind: 'grid', x: cfg.gridCols, y: cfg.gridRows }
  }
}

/** Map a persisted display mode back onto AppConfig fields. */
function fromDisplayMode(dm: WorkspaceDisplayMode): Partial<AppConfig> {
  if (dm.kind === 'carousel') return { displayMode: '1x1' }
  if (dm.x === 2 && dm.y === 1) return { displayMode: '1x2' as DisplayMode }
  if (dm.x === 2 && dm.y === 2) return { displayMode: '2x2' as DisplayMode }
  return { displayMode: 'custom' as DisplayMode, gridCols: dm.x, gridRows: dm.y }
}

export interface WorkspaceDeps {
  projectDir: string
  service: SessionService
  getConfig: () => AppConfig
  setConfig: (patch: Partial<AppConfig>) => void
  getScope: () => Scope
  /** Adopt a workspace's scope (no-op if a session is already running). */
  adoptScope: (ws: { groupId: string; scopeKind: 'ephemeral' | 'custom' }) => void
  pid?: number
  host?: string
  /** THIS process's own actual start time (epoch ms). Test-injectable like
   *  `pid`/`host`; production default is `ownProcessStartedAt()`. */
  startedAt?: number
}

export class WorkspaceService {
  private readonly host: string
  private readonly pid: number
  private readonly startedAt: number
  /** `initialBootInstant()` sampled ONCE at construction -- see `currentBootInstant`. */
  private readonly bootAnchorInstant: number
  /** `process.uptime()` at the SAME instant as `bootAnchorInstant`, the monotonic
   *  reference `currentBootInstant` advances from afterward. */
  private readonly bootAnchorProcessUptime: number
  private currentId: string | null = null
  private heartbeatTimer: NodeJS.Timeout | null = null
  private pruneTimer: NodeJS.Timeout | null = null

  constructor(private deps: WorkspaceDeps) {
    this.host = deps.host ?? hostname()
    this.pid = deps.pid ?? process.pid
    this.startedAt = deps.startedAt ?? ownProcessStartedAt()
    this.bootAnchorInstant = initialBootInstant()
    this.bootAnchorProcessUptime = process.uptime()
  }

  /**
   * This machine's boot instant, advanced from the one-time construction
   * sample via a monotonic PROCESS uptime delta rather than by re-reading
   * `Date.now()` -- immune to any wall-clock (NTP) correction that occurs
   * during this long-running instance's own lifetime (review round 5).
   * Residual, deliberately not addressed: if the wall clock was ALREADY
   * wrong at construction (before this instance's own first sample), the
   * anchor stays off for its whole lifetime; `isLockLive`'s heartbeat
   * condition is what bounds the damage in that case, not this method.
   */
  private currentBootInstant(): number {
    return this.bootAnchorInstant + Math.round((process.uptime() - this.bootAnchorProcessUptime) * 1000)
  }

  get currentWorkspaceId(): string | null {
    return this.currentId
  }

  /**
   * Lazy by design: launching empty must NOT create or clobber a workspace
   * (operator request). A workspace is only minted/locked once sessions exist
   * (created or restored) via `ensureCurrent`. The previous run's workspace stays
   * the newest restorable until the user acts.
   */
  start(): void {
    // No workspace is minted here (see ensureCurrent). Pruning only deletes
    // stale OTHER workspaces, so it is safe at startup and on a periodic timer.
    this.pruneStale()
    if (!this.pruneTimer) {
      this.pruneTimer = setInterval(() => this.pruneStale(), PRUNE_INTERVAL_MS)
    }
  }

  /**
   * D6: delete unpinned auto-saves older than PRUNE_MAX_AGE_MS, never touching a
   * pinned, current, or live-locked-by-another-instance workspace. Returns the
   * pruned ids. Best-effort: a delete failure is swallowed by deleteWorkspace.
   */
  pruneStale(): string[] {
    const now = Date.now()
    const keepIds = this.currentId ? [this.currentId] : []
    const candidates = selectPrunableWorkspaces(listWorkspaces(this.deps.projectDir), {
      now,
      maxAgeMs: PRUNE_MAX_AGE_MS,
      keepIds
    })
    const pruned: string[] = []
    for (const id of candidates) {
      const lock = readLock(this.deps.projectDir, id)
      const liveElsewhere =
        !!lock &&
        isLockLive(lock, {
          host: this.host,
          now,
          bootInstant: this.currentBootInstant(),
          isPidAlive: pidAlive,
          staleMs: LOCK_STALE_MS
        })
      if (liveElsewhere) continue
      deleteWorkspace(this.deps.projectDir, id)
      pruned.push(id)
    }
    return pruned
  }

  /**
   * Own a workspace id: acquire its lock + (re)start the heartbeat. Returns
   * whether the lock was actually acquired -- `this.currentId` and the
   * heartbeat are only committed on success, never on the strength of the
   * caller's intent alone (card 438c15e3: the previous ordering stamped
   * `this.currentId = id` BEFORE knowing acquireLock()'s result, so a lost
   * race was invisible).
   */
  private own(id: string): boolean {
    // Already own this id -- do NOT call acquireLock() again: it refuses
    // whenever the existing lock is live (isLockLive checks pid-alive, not
    // identity), so re-acquiring our own live lock would spuriously fail,
    // turning a self-restore (restore() called on the already-current
    // workspace) into a reported error over nothing (flagged before landing
    // any code: card 438c15e3, "own(x) when currentId already x"). Nothing
    // to acquire or release: the on-disk lock already reflects this
    // instance, untouched either way. `this.currentId` alone is an
    // IN-MEMORY belief, not proof (review round 7): re-read the on-disk
    // lock and confirm it is still stamped with THIS identity via ownsLock
    // before taking the shortcut -- if a third party has since reclaimed
    // the file, fall through to the normal acquire path instead of writing
    // under a lock we no longer hold.
    if (this.currentId === id) {
      const lock = readLock(this.deps.projectDir, id)
      if (lock && ownsLock(lock, { pid: this.pid, host: this.host })) {
        if (!this.heartbeatTimer) {
          this.heartbeatTimer = setInterval(() => this.heartbeatTick(), HEARTBEAT_MS)
        }
        return true
      }
      // Lock is gone or now foreign -- our own heartbeat should already have
      // self-ejected (heartbeatTick, above) and cleared the timer on the
      // same discovery; do NOT restart it here, or a self-eject would be
      // undone by the very shortcut it was meant to guard.
    }
    // The lock is written before saveWorkspace would create the tree, so a
    // fresh project dir (no .claude/claude-peers/workspaces yet) would ENOENT.
    // Create it up front -- own() is the first writer of any workspace file.
    ensureWorkspacesDir(this.deps.projectDir)
    const acquired = acquireLock(this.deps.projectDir, id, {
      pid: this.pid,
      host: this.host,
      startedAt: this.startedAt,
      now: Date.now(),
      bootInstant: this.currentBootInstant(),
      isPidAlive: pidAlive,
      staleMs: LOCK_STALE_MS
    })
    if (!acquired) return false
    // Only release the PREVIOUS workspace's lock once the new one is
    // actually ours -- releasing it first (the old ordering) would strand
    // this instance owning neither workspace if the new acquire then failed.
    if (this.currentId && this.currentId !== id) {
      releaseLock(this.deps.projectDir, this.currentId, { pid: this.pid, host: this.host })
    }
    this.currentId = id
    if (!this.heartbeatTimer) {
      this.heartbeatTimer = setInterval(() => this.heartbeatTick(), HEARTBEAT_MS)
    }
    return true
  }

  /**
   * Body of the heartbeat timer, extracted to a named method so a test can
   * call it directly and prove the two things that matter -- it passes THIS
   * instance's own identity (pid+host) to refreshLock(), and it self-ejects
   * once on a mismatch rather than re-tracing every tick (card 438c15e3: a
   * bare `setInterval(() => {...})` closure is unreachable from a test, so
   * the wiring between the timer and `this.pid`/`this.host` would stay
   * unproven -- exactly the "correct consumer nothing calls, or calls with
   * the wrong argument" failure family). The remaining unproven surface is
   * the one-line `setInterval(() => this.heartbeatTick(), ...)` above, which
   * is greppable.
   */
  private heartbeatTick(): void {
    // heartbeatTimer null means either never started, or already stopped by
    // a prior mismatch (below). Guarding on it here -- not only on the
    // clearInterval call at the bottom -- is what makes "self-eject ONCE"
    // true for a caller that invokes heartbeatTick() directly (a test, or
    // any future non-timer caller), not merely for the real setInterval
    // (which by construction can't fire again once cleared): without this
    // guard, a second direct call after ejection would refreshLock() and
    // reportError() again, since clearing the timer does not, on its own,
    // stop the METHOD from running.
    if (!this.currentId || !this.heartbeatTimer) return
    const refreshed = refreshLock(this.deps.projectDir, this.currentId, Date.now(), {
      pid: this.pid,
      host: this.host
    })
    if (!refreshed) {
      // Another instance now holds this lock (or it vanished) -- keeping
      // this timer alive would just re-stamp a foreign identity every
      // tick. Log ONCE at the transition, then stop.
      reportError('workspace', `heartbeat lost ownership of workspace ${this.currentId}, stopping`)
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  /** Mint + own a fresh workspace if none is current yet, or reconfirm
   *  ownership of the current one. Returns whether a workspace is current
   *  AND still actually ours afterwards. `this.currentId` alone is an
   *  IN-MEMORY belief (review round 7): every persist() call (saveAuto,
   *  saveNamed) reaches this method, so an early `if (this.currentId) return
   *  true` here -- not just in own()'s own fast path -- is exactly the gap a
   *  third-party reclaim of the on-disk lock file would walk through
   *  unnoticed. Route through own(), which re-reads the lock and confirms
   *  identity via ownsLock before writing. */
  private ensureCurrent(): boolean {
    return this.own(this.currentId ?? newWorkspaceId())
  }

  /**
   * Persist the live state under the current workspace id (auto name kept).
   * Returns null and does NOTHING -- no mint, no overwrite -- when
   * captureSessions() is empty (e.g. the supervisor is the only session
   * alive): an empty snapshot is never a legitimate auto-save, and covering
   * this here (not at each call site) is what protects all three callers
   * (index.ts's debounced 'changed' handler, startNew, releaseOnQuit) with
   * one guard. saveNamed (explicit Save As) is NOT guarded: the operator
   * asking to save an empty workspace by name is a deliberate act.
   */
  saveAuto(): WorkspaceSummary | null {
    if (this.deps.service.captureSessions().length === 0) return null
    return this.persist(undefined, false)
  }

  /**
   * Persist under a user-chosen name and pin it (explicit Save As). Names are
   * unique per cwd: a name already used by ANOTHER workspace is rejected so the
   * list stays unambiguous.
   */
  saveNamed(name: string): WorkspaceSummary {
    const trimmed = name.trim()
    if (trimmed) {
      const norm = trimmed.toLowerCase()
      const clash = listWorkspaces(this.deps.projectDir).some(
        (w) => w.id !== this.currentId && w.name.trim().toLowerCase() === norm
      )
      if (clash) throw new Error('duplicate-workspace-name')
    }
    const result = this.persist(trimmed || undefined, true)
    // persist() only returns null when the workspace lock could not be
    // acquired (reportError() already traced it there) -- saveNamed's
    // contract is a non-null WorkspaceSummary or a thrown error, same shape
    // as the duplicate-name rejection above.
    if (!result) throw new Error('workspace-lock-unavailable')
    return result
  }

  /**
   * Distinct cwds the sessions of a saved workspace will respawn into. Used by
   * the sandbox to warm its container-side transcript cache BEFORE `restore`
   * spawns them (PLAN-SANDBOX M2): the spawn path is synchronous, so anything
   * it needs to know must already be cached. Empty when the workspace is gone.
   */
  sessionCwds(id: string): string[] {
    const ws = loadWorkspace(this.deps.projectDir, id)
    if (!ws) return []
    const cwds = fromWorkspaceSessions(ws.sessions)
      .map((d) => d.cwd?.trim())
      .filter((c): c is string => !!c)
    return [...new Set(cwds)]
  }

  /**
   * Restore a workspace: adopt its scope, swap the session set, set the layout.
   * Returns false (no-op) when the workspace is missing or already owned by
   * another live instance; true after a successful restore.
   */
  restore(id: string): boolean {
    const ws = loadWorkspace(this.deps.projectDir, id)
    if (!ws) return false
    // A workspace persisted with zero sessions (a legacy empty snapshot minted
    // before saveAuto()'s empty-capture guard existed, or any future writer
    // that bypasses it) must never reach restoreFrom: restoreFrom starts with
    // pty.killAll(), so "restoring nothing" would kill every live session for
    // no replacement (b8d65b24 follow-up, mutation-tested review). The picker
    // (WorkspacesDialog.tsx) also disables Restore on sessionCount === 0; this
    // is the service-side line of defense for every other caller.
    if (ws.sessions.length === 0) return false
    // Refuse to restore a workspace another live instance already owns -- two
    // windows must not drive the same Claude sessions (the UI also disables
    // it). Exemption is by LOCK IDENTITY (the pid+host actually stamped in the
    // lock file), not by comparing `id` to `this.currentId`: currentId is only
    // this instance's own belief about what it owns, and refreshLock()
    // re-stamps whatever identity the file already holds, so a second Deck
    // could keep alive a lock this instance no longer truly matches. Resolve
    // the object (the lock) first, then ask whether THIS caller (pid+host) is
    // the one holding it.
    const lock = readLock(this.deps.projectDir, id)
    if (
      lock &&
      isLockLive(lock, {
        host: this.host,
        now: Date.now(),
        bootInstant: this.currentBootInstant(),
        isPidAlive: pidAlive,
        staleMs: LOCK_STALE_MS
      }) &&
      !ownsLock(lock, { pid: this.pid, host: this.host })
    ) {
      return false
    }
    this.deps.adoptScope({ groupId: ws.groupId, scopeKind: ws.scopeKind })
    this.deps.setConfig(fromDisplayMode(ws.displayMode))
    this.deps.service.restoreFrom(fromWorkspaceSessions(ws.sessions))
    // Hand the lock from the old workspace to this one + (re)start the
    // heartbeat. The check above is not atomic with this call (TOCTOU): by
    // the time own() runs, another instance may have grabbed `id` first.
    // Sessions are already swapped at this point (restoreFrom above already
    // ran) -- this fix does not attempt to roll that back, it only makes the
    // lock-ownership OUTCOME honest instead of silently assumed.
    if (!this.own(id)) {
      reportError(
        'workspace',
        `restore(${id}) lost the lock race after swapping sessions -- ownership unresolved`
      )
      return false
    }
    // Recapture right after restoring a non-empty workspace (ws.sessions.length
    // > 0, guarded above) must not itself come back empty -- that would mean
    // restoreFrom silently produced nothing, exactly the defect this card
    // fixes elsewhere. saveAuto()'s own empty-guard would otherwise swallow it
    // without a trace.
    if (this.saveAuto() === null) {
      logWarn(
        'workspace',
        `restore(${id}) recaptured 0 sessions right after restoring ${ws.sessions.length}`
      )
    }
    return true
  }

  deleteWs(id: string): void {
    if (id === this.currentId) this.currentId = null
    deleteWorkspace(this.deps.projectDir, id)
  }

  /**
   * "New (clear)": detach from the current workspace so the next created session
   * mints a fresh one. Captures a final auto-save (while sessions still exist --
   * call this BEFORE SessionService.closeAll) and releases the lock; the prior
   * workspace is kept restorable, not deleted.
   */
  startNew(): void {
    if (!this.currentId) return
    this.saveAuto()
    if (!releaseLock(this.deps.projectDir, this.currentId, { pid: this.pid, host: this.host })) {
      reportError(
        'workspace',
        `startNew() skipped releaseLock for ${this.currentId}: on-disk lock owned by another identity`
      )
    }
    this.currentId = null
  }

  /** All workspaces for this project, with lock + current flags, newest first. */
  listForCwd(): WorkspaceSummary[] {
    const now = Date.now()
    return listWorkspaces(this.deps.projectDir).map((ws) => {
      const lock = readLock(this.deps.projectDir, ws.id)
      const lockedByOther =
        ws.id !== this.currentId &&
        !!lock &&
        isLockLive(lock, {
          host: this.host,
          now,
          bootInstant: this.currentBootInstant(),
          isPidAlive: pidAlive,
          staleMs: LOCK_STALE_MS
        })
      return {
        id: ws.id,
        name: ws.name,
        pinned: ws.pinned,
        scopeName: ws.scopeName,
        sessionCount: ws.sessions.length,
        updatedAt: ws.updatedAt,
        locked: lockedByOther,
        current: ws.id === this.currentId
      }
    })
  }

  /** Final auto-save + lock release on quit. */
  releaseOnQuit(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
    if (this.pruneTimer) clearInterval(this.pruneTimer)
    this.pruneTimer = null
    if (!this.currentId) return
    this.saveAuto()
    if (!releaseLock(this.deps.projectDir, this.currentId, { pid: this.pid, host: this.host })) {
      // Lost the acquire race earlier without this instance noticing (or a
      // second Deck reclaimed after this one went stale) -- deleting the
      // lock file here would tear down a LIVE instance's ownership. This is
      // the "destruction croisee" gap the card flags as the most severe of
      // the three: releaseLock() now refuses instead of rmSync'ing blindly.
      reportError(
        'workspace',
        `releaseOnQuit skipped releaseLock for ${this.currentId}: on-disk lock owned by another identity`
      )
    }
  }

  // ----- internals -----

  private persist(name: string | undefined, pin: boolean): WorkspaceSummary | null {
    if (!this.ensureCurrent()) {
      reportError('workspace', 'persist() skipped: could not acquire the workspace lock')
      return null
    }
    // Adopt any post-discovery session-id rotation (e.g. a /clear) before
    // snapshotting, so the saved workspace resumes the current transcript.
    this.deps.service.refreshLiveSessionIds()
    const id = this.currentId as string
    const scope = this.deps.getScope()
    const existing = loadWorkspace(this.deps.projectDir, id)
    const ws: Workspace = {
      id,
      name: name ?? existing?.name ?? autoName(scope.name, new Date()),
      pinned: pin || existing?.pinned || false,
      cwd: this.deps.projectDir,
      groupId: scope.groupId,
      scopeName: scope.name,
      scopeKind: scope.scopeKind,
      displayMode: toDisplayMode(this.deps.getConfig()),
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      sessions: toWorkspaceSessions(this.deps.service.captureSessions())
    }
    const saved = saveWorkspace(this.deps.projectDir, ws)
    return {
      id: saved.id,
      name: saved.name,
      pinned: saved.pinned,
      scopeName: saved.scopeName,
      sessionCount: saved.sessions.length,
      updatedAt: saved.updatedAt,
      locked: false,
      current: true
    }
  }
}
